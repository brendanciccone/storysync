# storysync

Deterministic mapping rules from Storybook components to Figma variants, delivered as skill files for Claude Code and Cursor, with a CLI for previewing and validating mappings.

## What it does

Reads your components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview), maps boolean and enum props to Figma variant properties, and tells [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/) to create the corresponding component sets.

| Method | What it does |
|---|---|
| **Claude Code skill** | Claude reads Storybook MCP, applies mapping rules, writes to Figma MCP |
| **Cursor rules** | Same as above, from Cursor |
| **CLI** | Preview mappings locally (`storysync map`, `list`, `inspect`) |
| **GitHub Action** | Validate mappings in CI on every push |

> **Why skill files?** Writing to Figma requires the `mcp:connect` OAuth scope, which Figma currently restricts to [supported MCP clients](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server) (Claude Code, Cursor, VS Code, Codex, Copilot, Augment, Warp, and others). Third-party apps cannot obtain this scope. The skill files run inside these clients, so auth is handled automatically. The CLI reads from Storybook MCP (no auth restrictions) and previews what the mapping would produce.

## Quick start

### Claude Code (recommended)

```bash
# 1. Install the Storybook MCP addon in your project
npm install @storybook/addon-mcp

# 2. Connect Storybook MCP to Claude Code
claude mcp add --transport http storybook http://localhost:6006/mcp

# 3. Install the Figma plugin (includes MCP server + agent skills)
claude plugin install figma@claude-plugins-official

# 4. Add the storysync skill
mkdir -p .claude/skills
curl -o .claude/skills/storysync.md https://raw.githubusercontent.com/brendanciccone/storysync/main/skills/claude-code.md
```

Start Storybook, open Claude Code, and say: **"Generate my Figma library from Storybook"**

### Cursor

```bash
# 1. Install the Storybook MCP addon in your project
npm install @storybook/addon-mcp

# 2. Add the storysync rule
mkdir -p .cursor/rules
curl -o .cursor/rules/storysync.mdc https://raw.githubusercontent.com/brendanciccone/storysync/main/skills/cursor.mdc
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
name: Validate storysync mappings
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
                          storysync
Storybook MCP             mapping rules             Figma MCP
─────────────             ─────────────             ─────────

list-all-documentation    boolean prop?          -> boolean variant
get-documentation         enum/union prop?       -> variant property
                          string/number/callback -> skip
     ↓                         ↓                         ↓
 reads props              Cartesian product        Claude Code or Cursor
 from TypeScript          of mapped props          calls use_figma to
 type definitions         (capped at 256)          create component sets
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

- **Storybook 9+ or 10+** with a Vite-based framework (`@storybook/react-vite`, `@storybook/nextjs-vite`, or `@storybook/sveltekit`)
- **`@storybook/addon-mcp`** installed (provides MCP endpoint at `/mcp`)
- **Node.js 24+**
- Must be the **dev server** (`storybook dev`), not a static build

### Figma (for writing via Claude Code / Cursor)

- **Full seat** on a paid plan (required for write access; Dev seats are read-only)
- Auth is **OAuth 2.0**, handled automatically by supported MCP clients
- Write-to-canvas is **free during beta**, will become a paid usage-based feature
- **Rate limits**: Starter plans = 6 tool calls/month. Full seats on Professional+ = per-minute limits

No Anthropic API key needed. The mapping rules are deterministic, no LLM costs from storysync itself. Figma's `use_figma` tool is agent-driven on their side.

## License

MIT
