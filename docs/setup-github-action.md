# GitHub Action setup

> **Important**: The official Figma MCP server requires OAuth 2.0 (browser-based). The GitHub Action can read from Storybook and run `--dry-run` to validate mappings in CI, but cannot write to Figma without a third-party MCP server that accepts token auth.

## Use case: Validate mappings in CI

The most reliable use of the action is `--dry-run` mode — it validates that your component props map correctly to Figma variants on every push, without needing Figma auth.

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

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - run: npm ci

      - name: Start Storybook dev server
        run: |
          npx storybook dev --port 6006 --ci &
          npx wait-on http://localhost:6006 --timeout 120000

      - name: Validate mappings
        run: npx storysync generate --storybook http://localhost:6006 --dry-run
```

## Use case: Full sync (requires third-party Figma MCP)

If you use a Figma MCP server that accepts token auth:

```yaml
name: Sync Storybook to Figma
on:
  push:
    branches: [main]
    paths: ['src/components/**', 'stories/**']

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

## Action inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `storybook_url` | No | `http://localhost:6006` | URL of the running Storybook |
| `figma_file_key` | Yes | — | Figma file key |
| `figma_token` | Yes | — | Figma access token |
| `page_name` | No | `storysync` | Figma page name |
| `components` | No | all | Comma-separated component names |
| `node_version` | No | `24` | Node.js version |
