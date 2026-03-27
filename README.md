# storysync

Map your React Storybook components to Figma variant definitions. Deterministic rules, no LLM.

## What it does

Reads components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview), maps boolean and enum props to Figma variant properties, and writes them to [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/) as component sets.

### How to use it

| Method | What it does |
|---|---|
| **Claude Code skill** | Claude reads Storybook + writes to Figma in one conversation |
| **Cursor rules** | Same as Claude Code, from Cursor |
| **CLI** | Preview mappings locally (`storysync map`, `list`, `inspect`) |
| **GitHub Action** | Validate mappings in CI on every push |

Writing to Figma requires the `mcp:connect` OAuth scope, which is only available to first-party MCP clients (Claude Code, Cursor, VS Code, Codex). The CLI and Action handle the read + map side. Claude Code or Cursor handle the write side.

## Quick start

### Claude Code (recommended)

```bash
# 1. Install Storybook MCP addon (Vite-based Storybook 9+, Node 24+)
npm install @storybook/addon-mcp

# 2. Connect Storybook MCP
claude mcp add --transport http storybook http://localhost:6006/mcp

# 3. Install Figma plugin (includes MCP server + agent skills)
claude plugin install figma@claude-plugins-official

# 4. Add the storysync skill
mkdir -p .claude/skills
cp skills/claude-code.md .claude/skills/storysync.md
```

Start Storybook, open Claude Code, and say: **"Generate my Figma library from Storybook"**

### Cursor

```bash
# 1. Install Storybook MCP addon
npm install @storybook/addon-mcp

# 2. Add the storysync rule
mkdir -p .cursor/rules
cp skills/cursor.mdc .cursor/rules/storysync.mdc
```

In Cursor settings, add Storybook MCP (`http://localhost:6006/mcp`). In chat, type `/add-plugin figma`. Then say: **"Generate my Figma library from Storybook"**

### CLI (preview mappings)

```bash
# See how all components map to Figma variants
npx storysync map --storybook http://localhost:6006

# List available components
npx storysync list --storybook http://localhost:6006

# Inspect one component's mapping in detail
npx storysync inspect --storybook http://localhost:6006 --component Button
```

### GitHub Action (validate in CI)

```yaml
name: Validate Storybook → Figma mappings
on:
  push:
    paths: ['src/components/**', 'stories/**']

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: brendanciccone/storysync/action@main
```

## How it works

```
Storybook MCP              storysync               Figma MCP
list-all-documentation     (mapping rules)         use_figma
get-documentation                                  (writes to canvas)

component: Button     →    boolean prop?        →  Figma boolean variant
props:                     enum prop?            →  Figma variant property
  variant: enum            callback prop?        →  skip
    [default, destructive]
  disabled: boolean        Cartesian product     →  Figma component set
  size: enum               of all mapped props      with all variants
    [sm, md, lg]           (capped at 256)
```

## Mapping rules

| Storybook prop type | Figma output |
|---|---|
| `boolean` | Boolean variant property |
| `enum` / `union` of string literals | Variant property with matching values |
| `string` (free text) | Skipped |
| `number` (free value) | Skipped |
| `function` / `callback` | Skipped |
| `ReactNode` / `children` | Skipped |
| `ref` / `className` / `style` | Skipped |

## CLI commands

### `storysync map`

Map all components to Figma variant definitions.

```
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --components <names>   Comma-separated component names (default: all)
```

### `storysync list`

List all components available in Storybook.

```
Options:
  --storybook <url>    URL of the running Storybook instance (required)
```

### `storysync inspect`

Inspect one component's props and show how each maps to Figma.

```
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --component <name>     Component name or ID to inspect (required)
```

## Requirements

### Storybook
- **Storybook 9+** with a Vite-based framework (`@storybook/react-vite`, `@storybook/nextjs-vite`, `@storybook/sveltekit`)
- **`@storybook/addon-mcp`** installed
- **Node.js 24+**
- Must be the **dev server** (`storybook dev`), not a static build

### Figma (for writing via Claude Code / Cursor)
- **Full seat** on a paid plan (Dev seats are read-only)
- Auth is **OAuth 2.0**, handled automatically by Claude Code, Cursor, and other supported MCP clients
- Write-to-canvas is free during beta, will become paid
- Rate limits: Starter/View/Collab = 6 calls/month. Full seats on Professional+ = per-minute limits

No Anthropic API key needed.

## License

MIT
