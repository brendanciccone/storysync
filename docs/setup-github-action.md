# GitHub Action setup

The action validates that your Storybook components map correctly to Figma variants on every push. It reads from Storybook MCP and runs the mapping rules. It does not write to Figma.

## Basic setup

Create `.github/workflows/storysync.yml`:

```yaml
name: Validate Storybook → Figma mappings
on:
  push:
    branches: [main]
    paths:
      - 'src/components/**'
      - 'stories/**'
      - '.storybook/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: brendanciccone/storysync/action@main
```

The action handles Node.js setup, `npm ci`, starting the Storybook dev server, and running `storysync map`.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `storybook_url` | No | `http://localhost:6006` | URL of the Storybook dev server |
| `components` | No | all | Comma-separated component names to validate |
| `node_version` | No | `24` | Node.js version |

## Trigger on PR

```yaml
on:
  pull_request:
    paths:
      - 'src/components/**'
      - 'stories/**'
```

## What it checks

For each component, the action reads the TypeScript props from Storybook MCP and shows:
- Which props map to Figma boolean variants
- Which props map to Figma variant properties (enums)
- Which props are skipped (strings, numbers, callbacks, etc.)
- The total variant combination count (capped at 256)

If a component's props can't be parsed, the action reports the failure.
