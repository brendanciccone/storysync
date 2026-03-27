# GitHub Action setup

## Prerequisites

1. A React Storybook in your repository with `@storybook/addon-mcp` installed
2. A Figma file where components will be written
3. A Figma access token (note: the official Figma MCP server uses OAuth — a personal access token may not be accepted)

## Configure secrets

Add these secrets to your repository (Settings > Secrets and variables > Actions):

- `FIGMA_FILE_KEY` — your Figma file key (from the URL: `figma.com/file/<KEY>/...`)
- `FIGMA_ACCESS_TOKEN` — your Figma access token

## Add the workflow

Create `.github/workflows/storysync.yml`:

```yaml
name: Sync Storybook to Figma
on:
  push:
    branches: [main]
    paths:
      - 'src/components/**'
      - 'stories/**'
      - '.storybook/**'

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: brendanciccone/storysync/action@main
        with:
          figma_file_key: ${{ secrets.FIGMA_FILE_KEY }}
          figma_token: ${{ secrets.FIGMA_ACCESS_TOKEN }}
```

The action handles Node.js setup, `npm ci`, starting the Storybook dev server, and installing Playwright automatically.

> **Important**: The `@storybook/addon-mcp` endpoint only works with the Storybook **dev server**, not static builds. The action starts `storybook dev` in the background automatically.

## Options

| Input | Required | Default | Description |
|---|---|---|---|
| `storybook_url` | No | `http://localhost:6006` | URL of the running Storybook |
| `figma_file_key` | Yes | — | Figma file key |
| `figma_token` | Yes | — | Figma access token |
| `page_name` | No | `storysync` | Figma page name |
| `components` | No | all | Comma-separated component names |
| `no_screenshots` | No | `false` | Skip screenshots |
| `viewport_width` | No | `800` | Screenshot width |
| `viewport_height` | No | `600` | Screenshot height |
| `node_version` | No | `24` | Node.js version |

## Triggering on PR

To run on pull requests instead of pushes:

```yaml
on:
  pull_request:
    paths:
      - 'src/components/**'
      - 'stories/**'
```

## Known limitations

- **Figma OAuth**: The official Figma MCP server uses OAuth 2.0, which is designed for interactive auth flows. A personal access token passed via `figma_token` may not be accepted. If you use a third-party Figma MCP server that accepts tokens, this will work.
- **Rate limits**: Figma MCP Starter plans are limited to 6 tool calls per month. Each component sync uses at least 1 call, plus 1 for page creation.
