# CLI setup

## Install

```bash
npm install -g storysync
```

Or use directly with npx:

```bash
npx storysync --help
```

## Prerequisites

1. **Running Storybook dev server** — `@storybook/addon-mcp` must be installed (Vite-based Storybook 9+ only). The MCP endpoint at `/mcp` only works with the dev server, not static builds.
2. **Node.js 24+** — required by `@storybook/addon-mcp`

> **Note on Figma writes:** The CLI can read from Storybook MCP but cannot authenticate with the official Figma MCP server, which requires OAuth 2.0. Use `--dry-run` to preview mappings, then use Claude Code or Cursor to write to Figma.

## Usage

### Preview mappings (dry run)

```bash
npx storysync generate --storybook http://localhost:6006 --dry-run
```

Shows what would be synced — props, variant properties, combination counts — without connecting to Figma.

### List available components

```bash
npx storysync list --storybook http://localhost:6006
```

### Inspect a component's mapping

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

Shows each prop and whether it maps to a Figma variant or gets skipped.

### Generate (with Figma connection)

If you have a Figma MCP server that accepts token auth (e.g. a third-party server):

```bash
# Sync all components
npx storysync generate --storybook http://localhost:6006 --figma-file abc123

# Sync specific components only
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --components Button,Input,Card

# Custom page name
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --page "Design System"
```

Set your token via environment variable or flag:

```bash
export FIGMA_ACCESS_TOKEN=your-token-here
# or
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --figma-token your-token
```
