# storysync

[![CI](https://github.com/brendanciccone/storysync/actions/workflows/ci.yml/badge.svg)](https://github.com/brendanciccone/storysync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/storysync)](https://www.npmjs.com/package/storysync)

Sync your design system from code to Figma — and diff Figma back against code — using Storybook MCP and Figma MCP.

## What it does

Reads design tokens from your codebase (Tailwind config, CSS custom properties, or theme files) and components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview), then creates Figma variable collections and component sets via [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/).

Component styling is **measured, not guessed**: `storysync snap` renders each variant in a headless browser and reads the computed styles, so the fills, spacing, radii, and type that land in Figma come from the real render rather than from an AI's reading of your source.

| Method | What it does |
|---|---|
| **Claude Code skill** | Runs `storysync tokens`, `map`, and `snap` to extract structured data and measured styles from your codebase, then writes Figma variables and styled components via `use_figma`. Can also audit Figma against code. |
| **Cursor rules** | Same as above, from Cursor |
| **Codex** | Same as above, from Codex |
| **CLI** | Extract tokens, map components, measure rendered styles, score a push, or diff Figma against code |
| **GitHub Action** | Detect token and component drift in CI on every push |

> **Why skill files?** Writing to Figma requires the `use_figma` tool, which only works through [supported MCP clients](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server) (Claude Code, Cursor, VS Code, Codex, Copilot, Augment, Warp, and others) that can complete Figma's OAuth flow. The skill files instruct these clients to run storysync CLI commands (`tokens --json`, `map --json`, `snap --json`) to get deterministic, measured data from your codebase, then use that data to create Figma variables and components via `use_figma`. This means storysync handles the extraction logic and the AI client handles the Figma writes — each doing what it's best at.

## Quick start

storysync ships three workflows: **push** (code → Figma), **verify** (score what landed against what rendered), and **diff** (audit drift in either direction). It is deliberately one-way: nothing writes code. See [Non-goals](#non-goals).

Install storysync once, then drop the right config into your project for the AI client you use:

```bash
npm install -g storysync                # or: pnpm add -g storysync

cd your-project
npx storysync init                      # set up @storybook/addon-mcp if needed
npx storysync setup --client claude     # or: --client cursor   --client codex
```

`setup` writes the skill file (and slash commands, for Claude) into the right place and prints the MCP setup commands you still need to run.

### Try it without a project of your own

[`examples/storybook-vite`](examples/storybook-vite) is a runnable Storybook you can point storysync at in two commands. It includes one component that measures cleanly and one whose story is broken on purpose, so you can see the warning fire rather than read about it.

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
| Score the last push | "Verify the Figma file against the measured styles" |

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
  shadows                   AI client reads JSON,        storysync snap --json
         ↓                  creates Figma variables            ↓
  preview with CLI          via use_figma           renders each variant in a
  (storysync tokens)              ↓                 browser, records computed
                            components bind to      styles — measured, not read
                            variables                          ↓
                                                     creates styled component
                                                     sets via use_figma
                                                               ↓
                                                     plugin returns real node
                                                     properties
                                                               ↓
                                                     storysync verify → fidelity %

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

### `storysync snap`

Measure what each component variant actually looks like, by rendering the story in a headless browser and reading `getComputedStyle`. This replaces guessing styles from source: the AI client translates measured values instead of interpreting Tailwind classes, `cva` calls, or theme indirection.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --components <names>   Comma-separated component names (default: all)
  --out <dir>            Output directory (default: ".storysync/snaps")
  --variants <mode>      representative (default) or all
  --screenshots          Also save a PNG per variant (off by default)
  --timeout <ms>         Per-story timeout (default: 10000)
  --selector <css>       Override the component root selector
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any variant could not be measured
  --strict-warnings      Implies --strict, and also fails on warnings
```

`--strict` fails on variants that could not be measured. Warnings are separate and opt-in via `--strict-warnings`, because a component whose variants legitimately render the same (aliased option values, for instance) would otherwise fail every build. In CI, `--strict-warnings` is usually what you want: it turns "this story silently ignores its args" into a build failure rather than a line of output nobody reads.

Writes `<out>/styles.json` containing, per component, full styles for a base variant plus only the properties each other variant changes. The file carries no timestamp, so repeat runs against unchanged code are byte-identical and it can be committed and diffed.

**Variant selection.** `representative` measures every declared value once against the other properties' defaults, so cost scales with the *sum* of variant values rather than their product — a `3 × 2 × 2` button is 5 renders instead of 12. That is enough to build a correct Figma component set, since variants compose. Use `--variants all` for the full product.

**Requires Node 20+**, because Playwright does. Every other storysync command still runs on Node 18 — Playwright is loaded only when `snap` runs, so nothing else is affected.

**Browser.** storysync depends on `playwright-core`, which downloads no browsers, so one is located at runtime: `STORYSYNC_BROWSER_PATH` or `CHROME_PATH`, then an installed Chrome, then Edge, then a Playwright-managed download, then common system paths. If none is found the error lists every attempt. To install one:

```bash
npx playwright@latest install chromium     # note: the full `playwright` package
```

**Font substitution is detected.** The measured `fontFamily` is the family the code *asked for*, so a project naming a font it never loaded would otherwise measure — and score — as though that font were used while the browser rendered a fallback. snap probes whether the family actually applied and warns when it did not, naming it. Note that Figma needs the font available to its own editor too; storysync cannot install fonts into Figma, as the Plugin API has no such capability.

**Stories must pass args through.** snap sets variant values via Storybook's `?args=` URL. A story that hardcodes props, uses a custom `render` that ignores its args, or wraps the component in a decorator that drops them will render its default state for *every* variant. snap warns when all of a component's variants measure identically, which catches the common cases — but a story whose variants happen to differ only in unmeasured ways would not be flagged. Plain CSF3 args-driven stories are the reliable shape.

Values Storybook cannot carry in a URL are reported rather than measured. Its allowed character set is `[a-zA-Z0-9 _-]`, so an option like `Data Display` works while `Nav/Primary` is rejected — those variants are marked `args_unsupported` instead of silently recording the default render.

### `storysync verify`

Compare what was written to Figma against the styles `snap` measured, and report a fidelity score. The agent writes a component, has the plugin read the created node's real properties back out to `.storysync/figma-readback.json`, and this scores the result.

```text
Options:
  --snap <path>          Snap output (default: ".storysync/snaps/styles.json")
  --readback <path>      Properties read back from Figma (default: ".storysync/figma-readback.json")
  --tolerance <px>       Allowed difference for lengths (default: 0.5)
  --max-age <duration>   Warn when the snap is older than this (default: "2h")
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any variant drifted or is missing from Figma
  --strict-age           Implies --strict, and also fails on a stale snap
  --strict-measured      Implies --strict, and also fails on anything not measured
```

The three strict flags cover different questions, and each is opt-in because each has a legitimate reason to be noisy:

| Flag | Fails on |
|---|---|
| `--strict` | Properties that disagree, and variants Figma never received |
| `--strict-age` | A snap older than `--max-age`, or one whose age can't be established |
| `--strict-measured` | Variants inferred from source, unrecorded, or present in Figma but never measured |

`--strict-measured` is the one that matters in CI: it turns "this component's styling was guessed" into a build failure rather than a line of output nobody reads.

```text
Fidelity: 95.0% (38/40 properties)
4 verified, 1 drifted, 0 missing from Figma, across 5 variants

  ~ Forms/Button variant-outline--size-sm--disabled-false
      backgroundColor: measured null, Figma "#ff00ff"
      borderRadiusUniform: measured 3, Figma 8
```

Comparison is numeric rather than visual: measured values diff deterministically and cost nothing, where comparing screenshots means paying a model to render a judgement that won't reproduce.

Only properties the readback actually reports are scored. Figma has no equivalent for `lineHeight: "normal"` or a measured width on an auto-layout frame, so counting those would manufacture drift. Variants Figma never received are reported separately rather than dragging the score down — a missing variant is a different problem from a wrong one.

**Staleness.** `snap` writes a `meta.json` beside `styles.json` recording when the measurement was taken and against which Storybook. It is deliberately a separate file: `styles.json` is meant to be committed and diffed, and an embedded timestamp would churn on every run and bury the changes that matter. `verify` uses it to notice it is scoring a measurement taken before the code changed — the one drift case nothing else catches, since every property matches and the score reads 100%.

`--strict-age` fails when the age cannot be established at all — a missing or malformed `meta.json`, or one dated in the future. That matters because `meta.json` is exactly the file a project is likely to gitignore, being the one that churns; treating an unknown age as a pass would make the check succeed unconditionally in the setup it exists to protect. Age is reported on every run, so an unchecked one never passes for a checked one.

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
- **Story args wiring**: `storysync snap` varies variants through Storybook's `?args=` URL, so a story that ignores its args measures its default state for every variant. snap warns when all of a component's variants measure identically. See [`storysync snap`](#storysync-snap).
- **Variant values must be URL-safe**: Storybook only accepts `[a-zA-Z0-9 _-]` in URL args, so an option value containing e.g. `/` cannot be measured and is reported as `args_unsupported`.
- **Props without declared options**: A prop typed as a bare `string` or `number` with no `options` in its argType becomes no Figma variant property, so it is not measured. Storybook's documentation response does not always surface argType options.

## What's measured vs. inferred

storysync deliberately splits deterministic extraction (the CLI) from Figma writes (the AI client). Where a value comes from matters, so:

| Step | How it's produced |
|---|---|
| Design tokens | **Measured** — parsed from your Tailwind config, CSS custom properties, or theme file |
| Component variant structure | **Measured** — derived from Storybook prop types and argType options |
| Component styling | **Measured** — `getComputedStyle` on the real render, via `storysync snap` |
| Drift reports | **Measured** — deterministic comparison, normalized on both sides |
| Figma writes | **Agent-driven** — the client writes Plugin API code; storysync never writes to Figma |
| Layout and composition | **Interpreted** — snap measures properties, not whether a label sits correctly inside its button |

## Non-goals

- **Figma → code.** storysync never writes source. That direction is where an LLM's mistakes are hardest to notice, and Figma's own MCP already attempts it via `get_design_context`. Drift in that direction is *reported* by `storysync diff`; it is not applied.
- **Installing fonts into Figma.** The Plugin API has no such capability. `snap` will tell you when a font is missing on either side; putting it there is manual.
- **Pixel-perfect layout reproduction.** `verify` scores properties — fills, spacing, radii, type, shadows. Whether a label sits correctly inside its button is interpreted, not measured.

## Requirements

### Storybook (for component sync)

- **Storybook 10.1+** with a Vite-based framework (`@storybook/react-vite`, `@storybook/nextjs-vite`, or `@storybook/sveltekit`). Storybook 9.x only supports token extraction — the docs tools that `list`/`map`/`inspect` depend on require Storybook 10's component manifests.
- **`@storybook/addon-mcp`** installed (provides MCP endpoint at `/mcp`)
- **Node.js 18+** — except `storysync snap`, which needs **Node 20+** because Playwright does. Playwright is loaded only when `snap` runs, so every other command works on Node 18.
- Must be the **dev server** (`storybook dev`), not a static build
- A Chromium-based browser, for `storysync snap` only — see [`storysync snap`](#storysync-snap)

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
