# storysync

Sync your design system from code to Figma — and diff Figma back against code — using Storybook MCP and Figma MCP.

## What it does

Reads design tokens from your codebase (Tailwind config, CSS custom properties, or theme files) and components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview), then creates Figma variable collections and component sets via [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/).

| Method | What it does |
|---|---|
| **Claude Code skill** | Runs `storysync tokens` and `storysync map` to extract structured data from your codebase, then writes Figma variables and styled components via `use_figma`. Can also audit Figma against code. |
| **Cursor rules** | Same as above, from Cursor |
| **Codex** | Same as above, from Codex |
| **CLI** | Extract tokens, map components, preview mappings locally, or diff Figma against code |
| **GitHub Action** | Detect token and component drift in CI on every push |

> **Why skill files?** Writing to Figma requires the `use_figma` tool, which only works through [supported MCP clients](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server) (Claude Code, Cursor, VS Code, Codex, Copilot, Augment, Warp, and others) that can complete Figma's OAuth flow. The skill files instruct these clients to run storysync CLI commands (`tokens --json`, `map --json`) to get deterministic, structured data from your codebase, then use that data to create Figma variables and components via `use_figma`. This means storysync handles the extraction logic and the AI client handles the Figma writes — each doing what it's best at.

## Quick start

storysync ships three workflows: **push** (code → Figma), **diff** (audit drift in either direction), and **pull** (Figma → code, _coming in v0.3_).

Install storysync once, then drop the right config into your project for the AI client you use:

```bash
npm install -g storysync                # or: pnpm add -g storysync

cd your-project
npx storysync init                      # set up @storybook/addon-mcp if needed
npx storysync setup --client claude     # or: --client cursor   --client codex
```

`setup` writes the skill file (and slash commands, for Claude) into the right place and prints the MCP setup commands you still need to run.

### Claude Code

After `storysync setup --client claude`:

```bash
claude mcp add --transport http storybook http://localhost:6006/mcp
claude plugin install figma@claude-plugins-official
```

Then start Storybook and open Claude Code. Two slash commands are now available:

- `/storysync-push <figma-file-key>` — sync Storybook + tokens into Figma
- `/storysync-diff <figma-file-key>` — audit Figma against code

Or just say it in plain English: **"Push my Storybook to Figma (file key abc123)"** / **"Diff Figma against code"**.

### Cursor

After `storysync setup --client cursor`:

In Cursor settings, add Storybook MCP (`http://localhost:6006/mcp`). In chat, type `/add-plugin figma`. Then say:

- **"Push my Storybook to Figma (file key abc123)"** — code → Figma
- **"Diff Figma against code (file key abc123)"** — audit

### Codex

After `storysync setup --client codex`:

Add Storybook and Figma MCP servers to `.codex/config.toml`:

```toml
[mcp.storybook]
type = "http"
url = "http://localhost:6006/mcp"

[mcp.figma]
type = "http"
url = "https://mcp.figma.com/mcp"
```

Start Storybook and say:

- **"Push my Storybook to Figma (file key abc123)"** — code → Figma
- **"Diff Figma against code (file key abc123)"** — audit

### Magic phrases (all clients)

| Goal | Say |
|---|---|
| Code → Figma | "Push my Storybook to Figma (file key `<key>`)" |
| Audit drift | "Diff Figma against code (file key `<key>`)" or "Check if Figma is in sync" |
| Figma → code | _Coming in v0.3_ |

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
  globals.css (:root)                        ↓
  theme.ts                   storysync tokens --json     storysync map --json
         ↓                          ↓                           ↓
  storysync extracts         Structured token JSON       Variant definitions JSON
  colors, spacing,           (deterministic output)      (props, combinations)
  typography, radius,              ↓                           ↓
  shadows                   AI client reads JSON,        AI client reads source
         ↓                  creates Figma variables      for visual styling
  preview with CLI          via use_figma                      ↓
  (storysync tokens)              ↓                      creates styled component
                            components bind to           sets via use_figma
                            variables

  Audit

  Figma MCP                          Code / Storybook
  read variables via                 storysync tokens --json
  use_figma Plugin API               storysync map --json
         ↓                                  ↓
  read component sets                deterministic extraction
  and variant properties             of tokens + components
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

## CLI reference

The CLI exists for two purposes: **setup** (the `init` and `setup` commands wire your project up for an AI client) and **preview / CI** (the `tokens`, `map`, `list`, `inspect`, and `diff` commands give you deterministic output you can inspect locally or run in GitHub Actions). Day-to-day Figma syncing happens through the AI client using the skill + slash commands above — the CLI does not write to Figma directly.

### `storysync init`

Detect missing Storybook MCP setup and offer to fix it. Checks Storybook version (10.1+ required for component sync), whether `@storybook/addon-mcp` is installed, and whether it's registered in `addons` — then prompts before applying each fix to your `.storybook/main.ts`.

```text
Options:
  --project <path>     Project root path (default: ".")
```

### `storysync setup`

Drop the storysync skill, slash commands, and MCP setup notes into your project for the AI client you use.

```text
Options:
  --client <name>      AI client: claude, cursor, or codex (required)
  --project <path>     Project root path (default: ".")
  --force              Overwrite existing files
```

Example:

```bash
npx storysync setup --client claude
# writes .claude/skills/storysync.md and .claude/commands/storysync-{push,diff}.md
```

### `storysync tokens`

Extract design tokens from your project and preview what Figma variable collections would be created.

```text
Options:
  --project <path>     Project root to scan (default: ".")
  --source <type>      Token source: tailwind, css, or theme (auto-detect if omitted)
  --json               Output JSON instead of formatted text
  --all                Show all tokens instead of truncating
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
