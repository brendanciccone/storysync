<img src="assets/logo.png" alt="Storysync logo" width="88" height="88">

# Storysync

[![CI](https://github.com/brendanciccone/storysync/actions/workflows/ci.yml/badge.svg)](https://github.com/brendanciccone/storysync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/storysync)](https://www.npmjs.com/package/storysync)

Sync your design system from code to Figma, and diff Figma back against code, using Storybook MCP and Figma MCP.

![Claude Code running /storysync-push and reporting 100% fidelity (174 of 174 properties), beside the pushed Button component set in Figma and the Button story in Storybook](assets/screenshot.webp)

## What it does

Storysync reads design tokens from your codebase (Tailwind config, CSS custom properties, or theme files) and components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview). Your AI client then uses [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/) to create matching Figma variables and component sets.

Component styling is **measured, not guessed**. `storysync snap` renders each variant in a headless browser and reads its computed styles, so the fills, spacing, radii, and type in Figma come from the real render, not from an AI reading your source. After a push, `storysync verify` scores what landed in Figma against those measurements.

| Method | What it does |
|---|---|
| **Claude Code skill** | Runs `storysync tokens`, `map`, and `snap` to extract structured data and measured styles from your codebase, then writes Figma variables and styled components via `use_figma`. Can also audit Figma against code. |
| **Cursor rules** | Same as above, from Cursor |
| **Codex** | Same as above, from Codex |
| **CLI** | Extract tokens, map components, measure rendered styles, score a push, or diff Figma against code |
| **GitHub Action** | Detect token and component drift in CI on every push |

> **Why skill files?** Writing to Figma needs Figma's `use_figma` tool, which only works inside [supported MCP clients](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server) such as Claude Code, Cursor, and Codex. So Storysync does the extracting and measuring with deterministic CLI commands, and the skill file tells your AI client how to turn that output into Figma variables and components.

## Quick start

Storysync has three workflows: **push** (code → Figma), **verify** (score what landed against what rendered), and **diff** (find drift in either direction). It never writes code. See [Non-goals](#non-goals).

```bash
npm install -g storysync                # or: pnpm add -g storysync

cd your-project
npx storysync init                      # set up @storybook/addon-mcp if needed
npx storysync setup --client claude     # or: --client cursor   --client codex
```

`setup` writes the skill file (plus slash commands for Claude Code) and prints the MCP setup commands you still need to run.

To try it without a project of your own, use [`examples/storybook-vite`](examples/storybook-vite). It's a small Storybook with one component that measures cleanly and one whose story is broken on purpose, so you can see the warning.

### Claude Code

```bash
claude mcp add --transport http storybook http://localhost:6006/mcp
claude plugin install figma@claude-plugins-official
```

Start Storybook, open Claude Code, and run:

- `/storysync-push <figma-file-key>` to push Storybook and tokens into Figma
- `/storysync-diff <figma-file-key>` to audit Figma against code

You can also just ask in plain English (see [What to say](#what-to-say)).

### Cursor

`storysync setup --client cursor` writes the rule to `.cursor/rules/storysync.mdc`. Add Storybook MCP to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "storybook": { "url": "http://localhost:6006/mcp" }
  }
}
```

In Cursor's Agent chat, type `/add-plugin figma` and sign in to Figma. Then start Storybook and ask the agent to push or diff.

Cursor's terminal sandbox blocks `localhost`, so the agent asks to run `storysync map`, `inspect`, and `snap` outside it. Approve them, since they need to reach Storybook.

### Codex

`storysync setup --client codex` writes the skill to `.agents/skills/storysync/SKILL.md`. Then add the MCP servers:

```bash
codex mcp add storybook --url http://localhost:6006/mcp
codex mcp add figma --url https://mcp.figma.com/mcp      # signs you in to Figma
```

With Storybook running, ask Codex to push or diff. In the CLI, you can type `$storysync` to name the skill.

A few Codex details:

- If Storybook isn't running, `codex mcp add` prints "MCP server may or may not require login". You can ignore it. Storybook's server needs no login.
- You can install Figma's plugin instead of adding its server by hand: **Plugins** in the desktop app, or `/plugins` in the CLI.
- `codex mcp add` registers a server for every project. To keep Storybook to this one, put it in `.codex/config.toml` instead, which Codex reads once you trust the project:

  ```toml
  [mcp_servers.storybook]
  url = "http://localhost:6006/mcp"
  ```

- Codex's sandbox has network access off, so it asks to run `npx storysync` outside it. Approve it, or accept the rule Codex offers so it stops asking.
- Codex gives each MCP call `tool_timeout_sec` seconds (60 or 300 by default, depending on the version). The skill splits large Figma writes across calls, but if one still times out, raise the limit in the table `codex mcp add` wrote to `~/.codex/config.toml`:

  ```toml
  [mcp_servers.figma]
  url = "https://mcp.figma.com/mcp"
  tool_timeout_sec = 600
  ```

  Figma's plugin has no timeout setting, and a `[mcp_servers.figma]` table replaces the plugin's server. So with the plugin installed, run the `codex mcp add figma` command above and add the line to the table it writes.

### What to say

These work in every client:

| Goal | Say |
|---|---|
| Code → Figma | "Push my Storybook to Figma (file key `<key>`)" |
| Audit drift | "Diff Figma against code (file key `<key>`)" or "Check if Figma is in sync" |
| Score the last push | "Verify the Figma file against the measured styles" |

## GitHub Action

The action checks for token and component drift on every push.

```yaml
name: Validate storysync mappings
on:
  push:
    paths: ['src/components/**', 'stories/**', 'tailwind.config.*']

jobs:
  validate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: brendanciccone/storysync/action@main
        with:
          fail_on_drift: true
```

It installs your dependencies, starts Storybook on port 6006, extracts tokens, maps components, and compares both against baselines committed to your repo. Once it works, pin `@main` to a commit SHA.

**Create the baselines first.** With Storybook running, in the project's directory:

```bash
mkdir -p .storysync
npx storysync@<version> map --storybook http://localhost:6006 --json > .storysync/baseline.json
npx storysync@<version> tokens --json > .storysync/tokens-baseline.json
```

Commit both files. Use the Storysync version the action runs, which is the `version` in this repo's [`package.json`](package.json) at the ref you use. A baseline from a different version can differ from what the action maps. The action's warnings and errors print these commands with the version filled in. You can also save the action's `json` and `tokens_json` outputs as your baselines.

- If you set `components` or `token_source`, pass the same values to `map --components` and `tokens --source`.
- A project with no tokens can skip the token baseline, or set `token_baseline: ''` to check components only.
- With no baseline, drift is `new` and the action warns that nothing was checked. With `fail_on_drift`, the job fails and prints the command that writes it.
- A baseline that isn't `map --json` or `tokens --json` output always fails the job. That includes the `{"error": ...}` that `map --json` writes when Storybook isn't running.

| Input | Default | |
|---|---|---|
| `working_directory` | `.` | The project to check, relative to the repo root. The install, Storybook, tokens, and baseline paths all use it. |
| `install_command` | detected | Chosen from the nearest lockfile at or above `working_directory`, or the `packageManager` field in its package.json: `pnpm install --frozen-lockfile`, `yarn install --immutable` (`--frozen-lockfile` on Yarn 1), `npm ci`, or `bun install --frozen-lockfile` (set up bun first). Lockfiles from two package managers, with no `packageManager` to pick one, are an error. Set it to `true` to skip the install. |
| `storybook_url` | `http://localhost:6006` | With the default, the action starts Storybook on 6006 and stops it after mapping. It fails if something else is already on 6006. Any other URL is used as is, so start that Storybook in an earlier step. |
| `components` | all | Comma-separated component names or IDs. A name that matches nothing fails the job. |
| `token_source` | `auto` | `tailwind`, `css`, `theme`, or `auto`. |
| `baseline` | `.storysync/baseline.json` | Component baseline from `map --json`. Components are matched by Storybook title, so `Forms/Button` and `Nav/Button` are compared separately. |
| `token_baseline` | `.storysync/tokens-baseline.json` | Token baseline from `tokens --json`. Set it to `''` to skip tokens. |
| `fail_on_drift` | `false` | Fail the job on drift, or when a baseline is missing. |
| `create_issue` | `false` | Open or update a `storysync-drift` issue when drift is found. Needs `issues: write`. |
| `node_version` | `22` | Node.js version. |

**Outputs:** `drift` and `token_drift` are `true`, `false`, or `new` (no baseline). `token_drift` can also be `none` (no baseline and no tokens) or `skipped` (`token_baseline: ''`). `json` and `tokens_json` hold the `map --json` and `tokens --json` output the action compared.

**Aikido Safe Chain:** the action sets up its own Node and pnpm, which come before Safe Chain's shims on `PATH`, so Safe Chain doesn't check the action's installs. To have it check your dependencies, install them in your own steps before the action, following Safe Chain's [GitHub Actions example](https://github.com/AikidoSec/safe-chain#github-actions-example) with the Node version `node_version` names, and set `install_command: 'true'`.

## How it works

```text
  Tokens                               Components

  tailwind.config.ts / @theme          Storybook MCP
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
                            components bind to      styles (measured, not read)
                            variables                          ↓
                                                     creates styled component
                                                     sets via use_figma
                                                               ↓
                                                     plugin returns real node
                                                     properties, checksummed
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

Storysync reads design tokens from your codebase and previews the Figma variable collections the skill will create. Sources are detected automatically:

| Source | What it reads |
|---|---|
| **Tailwind** | `tailwind.config.ts/js` (`theme.extend.colors`, `spacing`, `borderRadius`, `fontSize`, `boxShadow`), or Tailwind v4 `@theme` blocks when there's no config ([see below](#tailwind-v4-theme)) |
| **CSS custom properties** | `:root { --color-*; --spacing-*; --radius-*; --font-*; --shadow-* }` in `.css` files |
| **Theme files** | `tokens.ts`, `theme.ts`, and similar: exported objects with `colors`, `spacing`, and so on |

Token categories are **colors**, **spacing**, **typography**, **radius**, and **shadows**. Commented-out tokens are skipped.

**Colours** can be in any CSS form: hex, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`, or the bare HSL channels shadcn/ui uses (`240 5.9% 10%`). A custom property with one of these values counts as a colour whatever its name. `tokens --json` keeps the value as written and adds its sRGB `hex`:

```json
{ "name": "brand", "value": "oklch(63.7% 0.237 25.331)", "hex": "#fb2c36" }
```

The push sets Figma variables from `hex`, since Figma's colour helpers only accept a few formats, and `diff` compares in hex, so this token matches a Figma variable of `#fb2c36`. Translucent colours get `#rrggbbaa`. A value Storysync can't convert, like `currentColor` or an unresolved `var()`, has no `hex`. `tokens --check` compares only `value`, so baselines written before `hex` existed still pass.

### shadcn/ui and Tailwind configs that reference CSS variables

Many Tailwind configs, shadcn/ui's included, define colours as `hsl(var(--background))` and put the values in `globals.css` under `:root`. Storysync resolves these references:

```ts
// tailwind.config.ts
colors: { background: "hsl(var(--background))" }
```

```css
/* globals.css */
:root { --background: 0 0% 100%; }
```

That resolves to `hsl(0 0% 100%)`. It also handles:

- Tailwind's `<alpha-value>` placeholder (`hsl(var(--bg) / <alpha-value>)` → `hsl(0 0% 100%)`)
- Nested variable chains (`--brand: var(--blue-500)`)
- Fallback values (`var(--missing, 200 50% 50%)`)

A reference with no matching variable and no fallback is left as the raw `var(...)`, so you can see what didn't resolve.

### Tailwind v4 `@theme`

A CSS-first Tailwind v4 project declares its tokens in `@theme` blocks instead of a config:

```css
@import "tailwindcss";

@theme {
  --color-brand-500: oklch(62.3% 0.214 259.815);
  --spacing-18: 4.5rem;
  --radius-card: 0.75rem;
  --text-hero: 3.5rem;
  --font-display: "Satoshi", sans-serif;
}
```

With no `tailwind.config`, Storysync reads `@theme` blocks (`@theme inline` included), unless the project also has `:root` custom properties, as shadcn/ui's v4 `globals.css` does. Then it reads `:root`, as earlier versions did, so existing baselines don't change. Pass `--source tailwind` to read `@theme` instead.

| Namespace | Category | Token name |
|---|---|---|
| `--color-*` | colors | without the namespace: `--color-brand-500` → `brand/500` |
| `--spacing-*`, `--spacing` | spacing | `--spacing-18` → `18`; the bare `--spacing` base unit → `DEFAULT` |
| `--radius-*` | radius | `--radius-card` → `card` |
| `--shadow-*` | shadows | `--shadow-soft` → `soft` |
| `--text-*`, `--font-*`, `--font-weight-*`, `--leading-*`, `--tracking-*` | typography | with the namespace, since they share a category: `text/hero`, `font/display`, `font/weight/bold`, `leading/snug` |

Dashes in a name become `/`. A `var()` is resolved against the theme, the project's `:root`, and Tailwind's default theme when `tailwindcss` is installed, so `--color-primary: var(--color-blue-500)` gets blue-500's value. Tailwind's defaults are only used to resolve references; they aren't read as your tokens. Later declarations win, and `initial` removes a variable (or a whole namespace, as in `--color-*: initial`). Modifiers like `--text-hero--line-height` and nested rules like `@keyframes` are skipped, and other namespaces (`--breakpoint-*`, `--animate-*`, and so on) are listed as uncategorized.

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

Props come from the Props section of the component's Storybook docs. Subcomponents' props and attached MDX pages don't become variant properties.

## CLI reference

The CLI handles setup (`init`, `setup`) and gives deterministic output you can check locally or in CI (`tokens`, `map`, `snap`, `verify`, `list`, `inspect`, `diff`). It never writes to Figma itself. Your AI client does that, using the skill.

A command that can't reach Storybook (or Figma, for `diff`) exits 1. So does one whose server accepts the connection but doesn't answer within `--connect-timeout` (default 60000 ms). With `--json`, the error is printed as JSON, `{"error": "..."}`, so scripts can still parse it.

### `storysync init`

Checks your Storybook setup and offers to fix it: the Storybook version (10.1+ is needed for components), whether `@storybook/addon-mcp` is installed, and whether it's registered in `.storybook/main.ts`. It asks before each change.

```text
Options:
  --project <path>     Project root path (default: ".")
```

It installs the addon-mcp that matches your Storybook: the same version for Storybook 10.6 and later, and `^0.7.0` before that. An installed addon-mcp newer than Storybook won't load, so `init` offers the matching one, and exits 1 if you decline. It uses the package manager of the nearest lockfile, looking up to the repo root, or npm if there's none.

### `storysync setup`

Adds the Storysync skill, slash commands, and MCP setup notes to your project for the AI client you use.

```text
Options:
  --client <name>      AI client: claude, cursor, or codex (required)
  --project <path>     Project root path (default: ".")
  --force              Overwrite existing files
```

```bash
npx storysync setup --client claude
# writes .claude/skills/storysync/SKILL.md and .claude/commands/storysync-{push,diff}.md
npx storysync setup --client cursor
# writes .cursor/rules/storysync.mdc
npx storysync setup --client codex
# writes .agents/skills/storysync/SKILL.md
```

### `storysync tokens`

Extracts design tokens from your project and previews the Figma variable collections they'd create.

```text
Options:
  --project <path>     Project root to scan (default: ".")
  --source <type>      Token source: tailwind, css, or theme (auto-detect if omitted
                       or auto); any other value is an error
  --json               Output JSON instead of formatted text
  --all                Show all tokens instead of truncating
  --check              Compare against baseline and detect drift; a missing baseline is an error
  --baseline <path>    Path to token baseline JSON, as written by tokens --json
                       (default: .storysync/tokens-baseline.json)
  --strict             Exit with code 1 if no tokens found or drift detected
```

`--check` compares against a committed baseline and lists tokens that were added, removed, or changed. Add `--strict` to fail on drift. Write the baseline with the same `--project` and `--source` you check with:

```bash
mkdir -p .storysync && npx storysync tokens --json > .storysync/tokens-baseline.json
```

A missing baseline is always an error, so a wrong `--baseline` path can't pass by comparing nothing. A file that isn't `tokens --json` output is an error too.

### `storysync map`

Maps every component to Figma variant definitions.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --connect-timeout <ms> How long to wait for Storybook MCP to answer (default: 60000)
  --components <names>   Comma-separated component names or IDs (default: all);
                         a name that matches nothing is an error
  --max-combinations <n> Most combinations to generate per component before capping (default: 256)
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any component fails or is capped
```

### `storysync snap`

Renders each component variant in a headless browser and records its computed styles. The AI client then works from measured values instead of interpreting Tailwind classes, `cva` calls, or theme indirection.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --connect-timeout <ms> How long to wait for Storybook MCP to answer (default: 60000)
  --components <names>   Comma-separated component names or IDs (default: all);
                         a name that matches nothing is an error
  --out <dir>            Output directory (default: ".storysync/snaps")
  --variants <mode>      representative (default) or all
  --max-combinations <n> With --variants all, most combinations per component before
                         capping (default: 256)
  --screenshots          Also save a PNG per variant (off by default)
  --timeout <ms>         Per-story timeout (default: 10000)
  --selector <css>       Override the component root selector
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any variant or component could not be measured, none were,
                         or a component was capped
  --strict-warnings      Implies --strict, and also fails on warnings
```

snap writes `<out>/styles.json`, with full styles for a base variant plus only what each other variant changes. It has no timestamp, so you can commit and diff it. `--screenshots` also saves PNGs under `<out>/<component>/`.

**Strict modes.** `--strict` fails on anything that couldn't be measured, on a capped component, and on a run that measured nothing. `--strict-warnings` also fails on warnings, like a story that ignores its args, and is usually what you want in CI.

**Variants.** `representative` measures each value once against the other props' defaults, so a `3 × 2 × 2` button takes 5 renders instead of 12. That's fine for a quick check, but a Figma component set needs every combination, so the push uses `--variants all`.

**Combination cap.** Above `--max-combinations` (default 256), snap measures a subset that covers every value, records a `cap`, warns, and fails `--strict`. If the limit is too low to cover every value, the warning names the ones left out. The skill has the agent stop and ask whether to build the subset, raise the limit, or narrow the variant props.

**Browser.** snap needs Node 20+ (for Playwright) and a Chromium-based browser. It looks for `STORYSYNC_BROWSER_PATH` or `CHROME_PATH`, then Chrome, Edge, a Playwright download, and common system paths. If it finds none, the error lists what it tried and the command to install one:

```bash
npx playwright@<version> install chromium     # note: the full `playwright` package
```

Use the version the error prints. Other Playwright versions install a browser that Storysync's `playwright-core` can't launch.

**What snap records:**

- **Colours** as sRGB hex (`#rrggbbaa` when translucent), whatever space Chromium reports them in (`oklch`, `oklab`, `lab`, `color()`, and so on). Colours outside sRGB are clipped (see [Limitations](#limitations)).
- **Gradients and background images** as `backgroundImage`, with colours as hex.
- **Corner radii** as drawn, so `rounded-full` on a 32px-tall pill is 16, not `3.35544e+07px`. Percentages and `calc()` are resolved. Figma has no elliptical corners, so those keep the smaller radius.
- **Shadows** without the empty `0 0 #0000` layers Tailwind adds, so each recorded layer is a real Figma effect.
- **Text** from the element that holds it (often a `<span>` inside the root), including `textTransform`, `letterSpacing`, and any opacity above it folded into its colour.
- **Font substitution.** snap warns when the font your code asks for didn't load and the browser used a fallback. Figma also needs the font installed, which Storysync can't do for you.

**Stories must pass args through.** snap sets variant values through Storybook's `?args=` URL. A story that hardcodes props, uses a custom `render` that ignores its args, or has a decorator that drops them renders its default state for every variant. snap warns when all of a component's variants measure the same. Plain CSF3 args-driven stories are the reliable shape.

Storybook only accepts `[a-zA-Z0-9 _-]` in URL args, so a value like `Nav/Primary` can't be measured and is marked `args_unsupported`.

**Variant names ignore case and punctuation**, so `Small` and `small` would get the same name. snap numbers the duplicate (`size-small--2`) and warns. Renaming the values is the real fix.

### `storysync verify`

Scores what was written to Figma against what `snap` measured. During a push, the agent reads the created nodes back from Figma and saves them to `.storysync/figma-readback.json`, and `verify` compares that file with the snap.

```text
Options:
  --snap <path>          Snap output (default: ".storysync/snaps/styles.json")
  --readback <path>      Properties read back from Figma (default: ".storysync/figma-readback.json")
  --tolerance <px>       Allowed difference for lengths (default: 0.5)
  --max-age <duration>   Warn when the snap is older than this (default: "2h")
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any variant drifted, is missing from Figma, or reported
                         nothing comparable, if a readback entry is not what Figma returned, is
                         incomplete or was read before the snap, or if the snap recorded a
                         component failure
  --strict-age           Implies --strict, and also fails on a stale snap
  --strict-measured      Implies --strict, and also fails on anything not measured
```

| Flag | Fails on |
|---|---|
| `--strict` | Properties that disagree, variants missing from Figma or with nothing comparable, readback entries that fail their checks (below), and snap failures |
| `--strict-age` | A snap older than `--max-age`, or one whose age is unknown |
| `--strict-measured` | Variants that weren't measured, such as ones inferred from source. This is the one to use in CI. |

```text
Fidelity: 95.0% (38/40 properties)
4 verified, 1 drifted, 0 missing from Figma, across 5 variants

  ~ Forms/Button variant-outline--size-sm--disabled-false
      backgroundColor: measured null, Figma "#ff00ff"
      borderRadiusUniform: measured 3, Figma 8
```

The comparison is numeric, not visual, so it's deterministic and free. Only properties Figma can report are scored; Figma has nothing to compare `lineHeight: "normal"` to, for example. Variants missing from Figma are reported separately instead of lowering the score.

**Readback checks.** `verify` never contacts Figma, so before scoring it checks that the readback file is what Figma returned:

- Each entry carries a checksum computed inside Figma over exactly what it returned, so an entry that was edited, made up, or copied from another variant fails.
- Each entry must have all 13 fields the readback returns (`null` where Figma has nothing), so a cut-down readback can't score 100% on fewer properties.
- Each entry records when Figma read it, and one read before the snap is stale. Five minutes of clock difference is allowed.
- No two components can share a `nodeId`.

Entries that fail aren't scored and fail `--strict`. The checksum isn't a signature, though (see [Limitations](#limitations)).

**Comparison details.** Text colour, size, weight, and family are compared against the element that holds the text. Colours are compared as hex, ignoring case, and opacity allows 0.01. Gap is compared along the flex direction only. Borders are compared on width, colour, and style; Figma can't draw `double`, `groove`, `ridge`, `inset`, or `outset` borders, so the push builds them solid and they show as drift.

**Staleness.** `snap` writes a `meta.json` next to `styles.json` recording when and against which Storybook it measured. It's a separate file so `styles.json` stays stable to diff. `verify` uses it to catch a snap taken before the code changed, which would otherwise score 100%. `--strict-age` fails when `meta.json` is missing or invalid, since it's often gitignored.

### `storysync list`

Lists the components in Storybook. MDX docs pages, like an introduction, are left out here and in every other command that reads components.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --connect-timeout <ms> How long to wait for Storybook MCP to answer (default: 60000)
```

### `storysync diff`

Compares a Figma file against your code's tokens and, with `--storybook`, your Storybook components.

> Requires a Figma MCP endpoint that works without browser OAuth, usually a local proxy from a supported MCP client. If it hangs on auth or returns `401`/`403`, use the skill's audit flow instead, which runs inside a client that's already signed in.

```text
Options:
  --figma <url>          Figma MCP server URL (required)
  --file-key <key>       Figma file key (required)
  --storybook <url>      Storybook URL (enables component diff)
  --connect-timeout <ms> How long to wait for Figma MCP, and Storybook MCP, to answer
                         (default: 60000)
  --project <path>       Project root to scan for tokens (default: ".")
  --source <type>        Token source: tailwind, css, or theme (auto-detect if omitted
                         or auto); any other value is an error
  --mode <name>          Figma variable mode to read (default: each collection's first mode)
  --components <names>   Comma-separated component names or IDs to diff, with --storybook
                         (default: all); a name in neither Storybook nor Figma is an error
                         when both were read
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any differences found or a Figma or Storybook read fails
```

```bash
# Diff tokens only
npx storysync diff --figma https://mcp.figma.com/mcp --file-key abc123

# Diff tokens + components
npx storysync diff --figma https://mcp.figma.com/mcp --file-key abc123 --storybook http://localhost:6006
```

- `--components` narrows both sides. A name only Figma has is reported as not in code, and a name neither side has is an error. It needs `--storybook`.
- If Storybook can't be listed or a component can't be mapped, the run is reported as partial (`storybookReadFailed` or `mappingFailures` in `--json`) and fails `--strict`. A partial run never ends with "No differences found".
- `diff` reads every page of the Figma file, up to 17,000 bytes per call. Each call counts toward [Figma's MCP rate limits](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/), so a large file can hit them. A refused call makes the run partial (`figmaReadFailed`); run it again later.
- A component too big for one call, such as a thousand icons as the options of one property, fails the read and is named.
- A name on more than one Figma page, like an archived copy, is reported as `ambiguous` and fails `--strict`.

### `storysync inspect`

Shows one component's props and how each maps to Figma.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --component <name>     Component name or ID to inspect (required);
                         a name that matches nothing is an error
  --connect-timeout <ms> How long to wait for Storybook MCP to answer (default: 60000)
```

## Limitations

### Figma → code: `diff` and the audit

- **Figma MCP auth:** CLI `diff` needs an authenticated Figma MCP endpoint, which usually means OAuth in a supported client. If it returns `401`/`403`, use the skill's audit flow in Claude Code, Cursor, or Codex.
- **`use_figma` return values:** the audit needs `use_figma` to return the plugin code's result. That works in supported clients but isn't guaranteed elsewhere.
- **Variable modes:** only each collection's first mode is read. Use `--mode <name>`, or ask the agent, for another mode like "Dark".
- **Variable aliases:** resolved up to 8 levels deep, with cycle detection. Aliases to remote or team library variables aren't resolved.
- **Collection names:** collections map to categories by name (`Colors` → `colors`, `Border Radius` → `radius`). A custom name like "Brand Primitives" won't map and shows as missing from code.
- **Component names:** matched by lowercased name, so `Button/Primary` in Figma won't match `ButtonPrimary` in code. A name used twice on either side, such as `Forms/Button` and `Nav/Button`, is reported as `ambiguous` instead of being guessed.
- **Wide-gamut colour tokens** are compared as their clipped sRGB hex, so `color(display-p3 1 0 0)` matches `#ff0000`.
- **Dark mode:** only `:root` values are read. Overrides like `.dark { ... }` aren't followed, for the push or for `diff`.

### Code → Figma: `snap`, the push, and `verify`

- **Stories must use their args.** See [`storysync snap`](#storysync-snap).
- **Variant values must be URL-safe.** Values outside `[a-zA-Z0-9 _-]` are reported as `args_unsupported`.
- **Props need declared options.** A bare `string` or `number` prop with no `options` in its argType doesn't become a variant, and Storybook's docs don't always include argType options.
- **Text can be a pixel off.** Figma lays out text with its own metrics, so a frame that hugs its text can come out a pixel or two wider or narrower than in the browser. `verify` allows 3% or 1px, whichever is larger. The skill reports this as a font-rendering difference instead of forcing the width, unless a stroke was built wrong.
- **Transparent borders show as an empty ring.** Browsers paint the background under a transparent border, but Figma's fill stops where an `OUTSIDE` stroke begins. The push keeps the size right and names those variants in its summary.
- **Some properties aren't scored.** Shadows, gradients and image fills, text transform, and letter-spacing are recorded by snap but not compared by `verify`.
- **CSS `outline` isn't measured,** so a focus ring drawn with `outline` never reaches Figma.
- **Colours outside sRGB are clipped** channel by channel, as Chromium does on an sRGB screen, so Tailwind v4's `red-600` becomes `#e7000b`. A wide-gamut screen shows the code's colour more saturated than Figma's.
- **The readback checksum isn't a signature.** The code that computes it is in the skill, so an agent that runs it over made-up values would pass. It also won't catch a readback reused after a fix round, or a template that echoes what it sent instead of reading the nodes. The [falsification test](examples/storybook-vite/README.md#pushing-to-figma) covers that: change a node in Figma by hand, read it back, and `verify` should report exactly that change.

## What's measured vs. inferred

Storysync splits deterministic extraction (the CLI) from Figma writes (the AI client), so it's clear where each value comes from:

| Step | How it's produced |
|---|---|
| Design tokens | **Measured:** parsed from your Tailwind config, CSS custom properties, or theme file |
| Component variant structure | **Measured:** derived from Storybook prop types and argType options |
| Component styling | **Measured:** `getComputedStyle` on the real render, via `storysync snap` |
| Drift reports | **Measured:** deterministic comparison, normalized on both sides |
| Figma writes | **Agent-driven:** the client writes Plugin API code; Storysync never writes to Figma |
| Layout and composition | **Interpreted:** snap measures properties, not whether a label sits correctly inside its button |

## Non-goals

- **Figma → code.** Storysync never writes source. That's the direction where an LLM's mistakes are hardest to notice, and Figma's MCP already does it with `get_design_context`. `storysync diff` reports drift in that direction but doesn't apply it.
- **Installing fonts into Figma.** The Plugin API can't. `snap` tells you when a font is missing; adding it is up to you.
- **Pixel-perfect layout.** `verify` scores properties (fills, spacing, radii, borders, type, and size), not whether a label sits correctly inside its button.

## Requirements

### Storybook (for components)

- **Storybook 10.1+** with a Vite-based framework (`@storybook/react-vite`, `@storybook/nextjs-vite`, or `@storybook/sveltekit`). Storybook 9 supports token extraction only.
- **`@storybook/addon-mcp`**, which serves MCP at `/mcp`. `storysync init` sets it up.
- The **dev server** (`storybook dev`), not a static build.
- **Node.js 18+**, or 20+ for `snap`.
- A Chromium-based browser, for `snap` only.

### Figma (for writing)

- A **Full seat** on a paid plan. Dev seats are read-only.
- OAuth, which supported MCP clients handle for you.
- Writing to the canvas is free during Figma's beta and will become a paid, usage-based feature.
- Rate limits: Starter plans get 6 tool calls a month, and Full seats on Professional and up get per-minute limits.

### Tokens

Token extraction only reads local files, so it needs no Storybook, MCP connection, or auth.

Storysync needs no Anthropic API key and makes no LLM calls of its own.

## License

MIT
