# GitHub Action setup

## Prerequisites

1. A React Storybook in your repository
2. A Figma file where components will be written
3. A Figma personal access token

## Configure secrets

Add these secrets to your repository (Settings → Secrets and variables → Actions):

- `FIGMA_FILE_KEY` — your Figma file key (from the URL: `figma.com/file/<KEY>/...`)
- `FIGMA_ACCESS_TOKEN` — your Figma personal access token

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

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Build Storybook
        run: npx storybook build --output-dir storybook-static

      - name: Serve Storybook
        run: npx http-server storybook-static -p 6006 &

      - name: Wait for Storybook
        run: npx wait-on http://localhost:6006

      - uses: storysync/action@v1
        with:
          storybook_url: http://localhost:6006
          figma_file_key: ${{ secrets.FIGMA_FILE_KEY }}
          figma_token: ${{ secrets.FIGMA_ACCESS_TOKEN }}
```

## Options

| Input | Required | Default | Description |
|---|---|---|---|
| `storybook_url` | Yes | — | URL of the running Storybook |
| `figma_file_key` | Yes | — | Figma file key |
| `figma_token` | Yes | — | Figma access token |
| `page_name` | No | `storysync` | Figma page name |
| `components` | No | all | Comma-separated component names |
| `no_screenshots` | No | `false` | Skip screenshots |
| `viewport_width` | No | `800` | Screenshot width |
| `viewport_height` | No | `600` | Screenshot height |
| `node_version` | No | `20` | Node.js version |

## Triggering on PR

To run on pull requests instead of pushes:

```yaml
on:
  pull_request:
    paths:
      - 'src/components/**'
      - 'stories/**'
```
