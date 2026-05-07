# storysync

Sync your design system from code to Figma — and diff Figma back against code — using Storybook MCP and Figma MCP.

## What it does

Reads design tokens from your codebase (Tailwind config, CSS custom properties, or theme files) and components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview), then creates Figma variable collections and component sets via [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/).

| Method | What it does |
|---|---|
| **Claude Code skill** | Claude extracts tokens, creates Figma variables, reads Storybook MCP, writes styled components. Can also audit Figma against code. |
| **Cursor rules** | Same as above, from Cursor |
| **Codex** | Same as above, from Codex |
| **CLI** | Preview token extraction and component mappings locally, or diff Figma against code |
| **GitHub Action** | Detect token and component drift in CI on every push |

> **Why skill files?** Talking to Figma MCP requires the `mcp:connect` OAuth scope, which Figma currently restricts to [supported MCP clients](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server) (Claude Code, Cursor, VS Code, Codex, Copilot, Augment, Warp, and others). Third-party apps cannot obtain this scope. The skill files run inside these clients, so auth is handled automatically. The CLI's token extraction, component mapping, and `list`/`inspect` commands work anywhere because they only touch your project files and Storybook MCP. The `diff` command needs Figma MCP access — use it from inside a supported client (via its local MCP proxy), or rely on the skill file's audit flow instead.

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

To audit an existing Figma file against code: **"Check if my Figma file is in sync with code"**

### Cursor

```bash
# 1. Install the Storybook MCP addon in your project
npm install @storybook/addon-mcp

# 2. Add the storysync rule
mkdir -p .cursor/rules
curl -o .cursor/rules/storysync.mdc https://raw.githubusercontent.com/brendanciccone/storysync/main/skills/cursor.mdc
```

In Cursor settings, add Storybook MCP (`http://localhost:6006/mcp`). In chat, type `/add-plugin figma`. Then say: **"Generate my Figma library from Storybook"**

### Codex

```bash
# 1. Install the Storybook MCP addon in your project
npm install @storybook/addon-mcp

# 2. Add the storysync instructions
curl -o AGENTS.md https://raw.githubusercontent.com/brendanciccone/storysync/main/skills/codex.md
```

Add Storybook and Figma MCP servers to `.codex/config.toml`:

```toml
[mcp.storybook]
type = "http"
url = "http://localhost:6006/mcp"

[mcp.figma]
type = "http"
url = "https://mcp.figma.com/mcp"
```

Start Storybook and say: **"Generate my Figma library from Storybook"**

### CLI

```bash
# One-time setup: configure @storybook/addon-mcp + componentsManifest in your project
npx storysync init

# Extract design tokens from your project
npx storysync tokens

# See how all components map to Figma variants
npx storysync map --storybook http://localhost:6006

# List available components
npx storysync list --storybook http://localhost:6006

# Inspect one component's mapping in detail
npx storysync inspect --storybook http://localhost:6006 --component Button

# Diff Figma file against code tokens and components
npx storysync diff --figma https://mcp.figma.com/mcp --file-key <key> --storybook http://localhost:6006
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

```text
  Tokens                               Components

  tailwind.config.ts                   Storybook MCP
  globals.css (:root)       storysync           storysync
  theme.ts                  skill               skill
         ↓                       ↓                    ↓
  extract colors,           Figma variable      boolean prop?    -> boolean variant
  spacing, typography,      collections         enum/union prop? -> variant property
  radius, shadows                               other props      -> skip
         ↓                       ↓                    ↓
  preview with CLI          create via          Cartesian product of mapped props
  (storysync tokens)        use_figma           (capped at 256 combinations)
                                  ↓                    ↓
                            components bind     create styled component sets
                            to variables        via use_figma

  Audit

  Figma MCP                          Code / Storybook
  read variables via                 extract tokens from
  use_figma Plugin API               tailwind/css/theme
         ↓                                  ↓
  read component sets                map Storybook props
  and variant properties             to variant definitions
         ↓                                  ↓
         └──────── compare ────────────────┘
                      ↓
               drift report:
               + missing from Figma
               - missing from code
               ~ value mismatch
```

## Token extraction

storysync reads design tokens from your codebase and previews the Figma variable collections that the skill files will create. Supported sources (auto-detected):

| Source | What it reads |
|---|---|
| **Tailwind** | `tailwind.config.ts/js` — `theme.extend.colors`, `spacing`, `borderRadius`, `fontSize`, `boxShadow` |
| **CSS custom properties** | `:root { --color-*; --spacing-*; --radius-*; --font-*; --shadow-* }` in `.css` files |
| **Theme files** | `tokens.ts`, `theme.ts`, etc. — exported objects with `colors`, `spacing`, and similar keys |

Token categories: **colors**, **spacing**, **typography**, **radius**, **shadows**

### shadcn/ui and Tailwind configs that reference CSS variables

Many Tailwind configs (notably shadcn/ui templates) define colors as `hsl(var(--background))` and put the actual values in `globals.css` under `:root`. storysync detects this pattern and automatically resolves the references:

```ts
// tailwind.config.ts
colors: { background: "hsl(var(--background))" }
```

```css
/* globals.css */
:root { --background: 0 0% 100%; }
```

→ resolves to `hsl(0 0% 100%)`.

It also handles:
- Tailwind's `<alpha-value>` placeholder (`hsl(var(--bg) / <alpha-value>)` → `hsl(0 0% 100%)`)
- Nested CSS variable chains (`--brand: var(--blue-500)`)
- Fallback values (`var(--missing, 200 50% 50%)`)

If no matching CSS variable is found (and no fallback is provided), the raw `var(...)` reference is preserved so you can see what didn't resolve.

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

### `storysync init`

Detect missing Storybook MCP setup and offer to fix it. Checks Storybook version (10.1+ required for component sync), whether `@storybook/addon-mcp` is installed, and whether it's registered in `addons` — then prompts before applying each fix to your `.storybook/main.ts`.

```text
Options:
  --project <path>     Project root path (default: ".")
```

### `storysync tokens`

Extract design tokens from your project and preview what Figma variable collections would be created.

```text
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

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --components <names>   Comma-separated component names (default: all)
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any component fails or is capped
```

### `storysync list`

List all components available in Storybook.

```text
Options:
  --storybook <url>    URL of the running Storybook instance (required)
```

### `storysync diff`

Compare a Figma file against code tokens and Storybook components. Reads from Figma via MCP, extracts tokens from local code, and optionally maps Storybook components — then reports what's different.

> Requires a Figma MCP endpoint reachable without browser-based OAuth (typically a local proxy from a supported MCP client). If the command hangs on auth or returns `401`/`403`, use the skill file's audit flow instead — it runs inside the client that already holds the OAuth session.

```text
Options:
  --figma <url>          Figma MCP server URL (required)
  --file-key <key>       Figma file key (required)
  --storybook <url>      Storybook URL (enables component diff)
  --project <path>       Project root to scan for tokens (default: ".")
  --source <type>        Token source: tailwind, css, or theme (auto-detect if omitted)
  --mode <name>          Figma variable mode to read (default: each collection's first mode)
  --components <names>   Comma-separated component names to diff
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any differences found or Figma reads fail
```

Example:

```bash
# Diff tokens only
npx storysync diff --figma https://mcp.figma.com/mcp --file-key abc123

# Diff tokens + components
npx storysync diff --figma https://mcp.figma.com/mcp --file-key abc123 --storybook http://localhost:6006
```

### `storysync inspect`

Inspect one component's props and show how each maps to Figma.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --component <name>     Component name or ID to inspect (required)
```

## Limitations

The reverse-direction (Figma → code) features have known constraints that you should be aware of before relying on the diff output:

- **Figma MCP auth**: The CLI `diff` command needs an authenticated Figma MCP endpoint. Most Figma MCP setups require browser-based OAuth that only supported MCP clients can complete. Use the skill file's audit flow inside Claude Code / Cursor / Codex if the CLI returns `401`/`403`.
- **`use_figma` return contract**: The audit relies on `use_figma` surfacing the plugin code's return value as MCP tool output. This works when run from a supported MCP client; behavior from third-party CLIs is not guaranteed. If `use_figma` doesn't return values, the skill agent is instructed to look for read-only tools or fall back to a user-exported JSON snapshot.
- **Multi-mode variables**: By default, only the first mode of each Figma variable collection is read. Use `--mode <name>` on the CLI (or instruct the agent in chat) to read a specific mode like "Light" or "Dark".
- **Variable aliases**: Aliases are resolved up to 8 levels deep; cycles are detected. Aliases pointing at variables in remote/team libraries are not resolved.
- **Collection name mapping**: Figma collections are matched to code categories by lowercase name (`Colors` → `colors`, `Border Radius` → `radius`, etc.). Custom collection names like "Brand Primitives" won't auto-categorize and will appear as missing-from-code.
- **Component name matching**: Components are matched by lowercased name. PascalCase code components and Title Case Figma components match if their lowercased forms are equal, but slash-paths in Figma names (e.g. `Button/Primary`) won't match a flat code name (`ButtonPrimary`).
- **Tailwind CSS-var resolution**: When a Tailwind config references CSS variables (e.g. `hsl(var(--bg))`), only the `:root` block is read by default. Theme overrides like `.dark { ... }` are not currently followed; the `:root` (light) values are used.

## Requirements

### Storybook (for component sync)

- **Storybook 10.1+** with a Vite-based framework (`@storybook/react-vite`, `@storybook/nextjs-vite`, or `@storybook/sveltekit`). Storybook 9.x only supports token extraction — the docs tools that `list`/`map`/`inspect` depend on require Storybook 10's component manifests.
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
