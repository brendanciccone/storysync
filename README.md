# storysync

The missing link between Storybook MCP and Figma MCP.

You have a React Storybook. You run one command. You get a Figma component library.

## What it does

Reads your components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview) and writes them to [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/). Deterministic mapping, no LLM.

### Ways to use it

| Method | How it works | Figma auth | Status |
|---|---|---|---|
| **Claude Code skill** | Conversational — Claude calls both MCPs | OAuth (handled by Claude) | Works |
| **Cursor rules** | Cursor calls both MCPs | OAuth (handled by Cursor) | Works |
| **CLI** | `npx storysync generate ...` | Requires MCP auth setup | Requires OAuth setup |
| **GitHub Action** | Runs on push/PR | Requires MCP auth setup | Requires OAuth setup |

> **Note on Figma auth**: The remote Figma MCP server (`https://mcp.figma.com/mcp`) uses OAuth 2.0. AI coding tools like Claude Code and Cursor handle OAuth automatically. The CLI and GitHub Action pass a personal access token, which may not be accepted by the official server. If you use a third-party Figma MCP server that accepts tokens, the CLI and Action will work.

## Quick start

### Claude Code (recommended)

1. Install `@storybook/addon-mcp` in your Storybook project
2. Copy `skills/claude-code.md` to `.claude/skills/storysync.md`
3. Connect Storybook MCP: `claude mcp add storybook --url http://localhost:6006/mcp`
4. Connect Figma MCP: `claude mcp add --transport http figma https://mcp.figma.com/mcp`
5. Tell Claude: "Generate my Figma library from Storybook"

### Cursor

1. Install `@storybook/addon-mcp` in your Storybook project
2. Copy `skills/cursor.mdc` to `.cursor/rules/storysync.mdc`
3. Connect both MCPs in Cursor settings
4. Run the rule

### CLI

```bash
# Preview what would be synced (no Figma connection needed)
npx storysync generate --storybook http://localhost:6006 --dry-run

# Sync to Figma (requires Figma MCP auth)
npx storysync generate \
  --storybook http://localhost:6006 \
  --figma-file <file-key> \
  --figma-token <token>
```

### GitHub Action

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

## How it works

```
Storybook MCP              storysync               Figma MCP
(reads your components)    (mapping rules)         (writes to canvas)

component: Button     →    boolean prop?        →  Figma boolean variant
props:                      → boolean variant
  variant: enum             enum prop?           →  Figma variant property
    [default, destructive]  → variant property       with matching values
  disabled: boolean         callback prop?
  size: enum                → skip (not visual)     Figma component set
    [sm, md, lg]                                     with all variants
```

## Mapping rules

Deterministic. No LLM.

| Storybook prop type | Figma output |
|---|---|
| `boolean` | Boolean variant property |
| `enum` / `union` of string literals | Variant property with matching values |
| `string` (free text) | Skipped |
| `number` (free value) | Skipped |
| `function` / `callback` | Skipped |
| `ReactNode` / `children` | Skipped |
| `ref` / `className` / `style` | Skipped |

Variant combinations are the Cartesian product of all mapped props, capped at 256.

## CLI commands

### `storysync generate`

Generate Figma component library from Storybook.

```
Options:
  --storybook <url>         URL of the running Storybook instance (required)
  --figma-file <key>        Figma file key (required unless --dry-run)
  --figma-token <token>     Figma access token (or set FIGMA_ACCESS_TOKEN)
  --page <name>             Figma page name (default: "storysync")
  --no-screenshots          Skip capturing screenshots
  --components <names>      Comma-separated component names to sync
  --viewport-width <width>  Screenshot viewport width (default: 800)
  --viewport-height <height> Screenshot viewport height (default: 600)
  --dry-run                 Preview mapping without writing to Figma
```

### `storysync list`

List all components available in Storybook.

```
Options:
  --storybook <url>    URL of the running Storybook instance (required)
```

### `storysync inspect`

Inspect a component's props and show how they map to Figma.

```
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --component <name>     Component name or ID to inspect (required)
```

## Requirements

- **Node.js 24+** — required by `@storybook/addon-mcp`
- **React Storybook** with `@storybook/addon-mcp` installed (provides MCP server at `/mcp`)
- **Figma account** with Dev or Full seat on a paid plan (for write access)
- **Playwright** for screenshots: `npx playwright install chromium`

### Figma MCP details

- Write operations use the **remote** Figma MCP server at `https://mcp.figma.com/mcp`
- The desktop Figma MCP server is **read-only** — it cannot create components
- Auth: **OAuth 2.0** (AI tools handle this; CLI/Action pass a token which may not work with the official server)
- **Rate limits**: Starter/View/Collab seats: **6 tool calls per month**. Dev/Full seats on Professional+ plans: per-minute rate limits
- Write-to-canvas is free during beta but will become a paid, usage-based feature

### Storybook MCP details

- Install: `npm install @storybook/addon-mcp`
- The addon runs an MCP server within the **dev server** at `/mcp` (static builds do not have MCP)
- Requires **Node.js 24+**
- Props are returned as TypeScript type definitions

No Anthropic API key needed. No LLM costs. Fully deterministic.

## License

MIT
