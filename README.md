# storysync

Sync your design system from code to Figma — tokens, components, and variants — using Storybook MCP and Figma MCP.

## What it does

Reads design tokens from your codebase (Tailwind config, CSS custom properties, or theme files) and components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview), then creates Figma variable collections and component sets via [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/).

| Method | What it does |
|---|---|
| **Claude Code skill** | Claude extracts tokens, creates Figma variables, reads Storybook MCP, writes styled components |
| **Cursor rules** | Same as above, from Cursor |
| **CLI** | Preview token extraction and component mappings locally |
| **GitHub Action** | Detect token and component drift in CI on every push |

> **Why skill files?** Writing to Figma requires the `mcp:connect` OAuth scope, which Figma currently restricts to [supported MCP clients](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server) (Claude Code, Cursor, VS Code, Codex, Copilot, Augment, Warp, and others). Third-party apps cannot obtain this scope. The skill files run inside these clients, so auth is handled automatically. The CLI reads from your project and Storybook MCP (no auth restrictions) and previews what the mapping would produce.

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

### CLI

```bash
# Extract design tokens from your project
npx storysync tokens

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
    paths: ['src/components/**', 'stories/**', 'tailwind.config.*']

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: brendanciccone/storysync/action@main
```

## How it works

```
  Phase 0: Foundations               Phase 1: Components

  tailwind.config.ts                 Storybook MCP
  globals.css (:root)       storysync         storysync
  theme.ts                  token rules       mapping rules
         ↓                       ↓                  ↓
  extract colors,           Figma variable    boolean prop?    -> boolean variant
  spacing, typography,      collections       enum/union prop? -> variant property
  radius, shadows                             other props      -> skip
         ↓                       ↓                  ↓
  preview with CLI          create via        Cartesian product of mapped props
  (storysync tokens)        use_figma         (capped at 256 combinations)
                                  ↓                  ↓
                            components bind   create styled component sets
                            to variables      via use_figma
```

## Token extraction

storysync reads design tokens from your codebase and previews the Figma variable collections that the skill files will create. Supported sources (auto-detected):

| Source | What it reads |
|---|---|
| **Tailwind** | `tailwind.config.ts/js` — `theme.extend.colors`, `spacing`, `borderRadius`, `fontSize`, `boxShadow` |
| **CSS custom properties** | `:root { --color-*; --spacing-*; --radius-*; --font-*; --shadow-* }` in `.css` files |
| **Theme files** | `tokens.ts`, `theme.ts`, etc. — exported objects with `colors`, `spacing`, and similar keys |

Token categories: **colors**, **spacing**, **typography**, **radius**, **shadows**

## Component mapping rules

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

### `storysync tokens`

Extract design tokens from your project and preview what Figma variable collections would be created.

```
Options:
  --project <path>     Project root to scan (default: ".")
  --source <type>      Token source: tailwind, css, or theme (auto-detect if omitted)
  --json               Output JSON instead of formatted text
  --check              Compare against baseline and detect drift
  --baseline <path>    Path to token baseline JSON (default: .storysync/tokens-baseline.json)
  --strict             Exit with code 1 if no tokens found or drift detected
```

### `storysync map`

Map all components to Figma variant definitions.

```
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --components <names>   Comma-separated component names (default: all)
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any component fails or is capped
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

### Storybook (for component sync)

- **Storybook 9.x and 10.x** with a Vite-based framework (`@storybook/react-vite`, `@storybook/nextjs-vite`, or `@storybook/sveltekit`)
- **`@storybook/addon-mcp`** installed (provides MCP endpoint at `/mcp`)
- **Node.js 18+**
- Must be the **dev server** (`storybook dev`), not a static build

### Figma (for writing via Claude Code / Cursor)

- **Full seat** on a paid plan (required for write access; Dev seats are read-only)
- Auth is **OAuth 2.0**, handled automatically by supported MCP clients
- Write-to-canvas is **free during beta**, will become a paid usage-based feature
- **Rate limits**: Starter plans = 6 tool calls/month. Full seats on Professional+ = per-minute limits

### Token extraction (no extra requirements)

Token extraction reads local files only — no Storybook, no MCP connection, no auth needed. Works with `storysync tokens` as a standalone command.

No Anthropic API key needed. The mapping rules are deterministic, no LLM costs from storysync itself. Figma's `use_figma` tool is agent-driven on their side.

## License

MIT
