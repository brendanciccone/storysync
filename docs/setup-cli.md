# CLI setup

## Install

```bash
npm install -g storysync
```

Or use directly with npx:

```bash
npx storysync generate --storybook http://localhost:6006 --figma-file <file-key>
```

## Prerequisites

1. **Running Storybook dev server** — `@storybook/addon-mcp` must be installed (the MCP endpoint at `/mcp` only works with the dev server, not static builds)
2. **Node.js 24+** — required by `@storybook/addon-mcp`
3. **Figma access token** — the official Figma MCP server uses OAuth 2.0. A personal access token (from https://www.figma.com/developers/api#access-tokens) may not be accepted by the official server
4. **Figma file key** — the key from your Figma file URL: `figma.com/file/<THIS-PART>/...`
5. **Playwright** (for screenshots) — install with `npx playwright install chromium`

## Usage

### Preview without Figma (dry run)

```bash
npx storysync generate --storybook http://localhost:6006 --dry-run
```

This shows what would be synced without connecting to Figma. No token needed.

### Set your Figma token

```bash
export FIGMA_ACCESS_TOKEN=your-token-here
```

Or pass it inline:

```bash
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --figma-token your-token
```

### Generate your Figma library

```bash
# Sync all components
npx storysync generate --storybook http://localhost:6006 --figma-file abc123

# Sync specific components only
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --components Button,Input,Card

# Skip screenshots (faster)
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --no-screenshots

# Custom page name
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --page "Design System"
```

### List available components

```bash
npx storysync list --storybook http://localhost:6006
```

### Inspect a component's mapping

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

This shows each prop and whether it maps to a Figma variant or gets skipped.

## Known limitations

- **Figma OAuth**: The official Figma MCP server at `https://mcp.figma.com/mcp` uses OAuth 2.0. The `--figma-token` flag passes a Bearer token, which may not be accepted. If you use a third-party Figma MCP server that accepts personal access tokens, it will work.
- **Storybook dev server required**: Static Storybook builds (`storybook build`) do not include the MCP endpoint. You must have a running dev server (`storybook dev`).
- **Rate limits**: Figma MCP Starter plans are limited to 6 tool calls per month.
