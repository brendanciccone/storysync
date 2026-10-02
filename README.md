<img src="assets/logo.png" alt="storysync logo" width="88" height="88">

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

`storysync setup --client cursor` writes the rule to `.cursor/rules/storysync.mdc`. Add Storybook MCP to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "storybook": { "url": "http://localhost:6006/mcp" }
  }
}
```

In Cursor's Agent chat, type `/add-plugin figma` and sign in to Figma when prompted. Then start Storybook and, in Agent chat, say:

- **"Push my Storybook to Figma (file key abc123)"** — code → Figma
- **"Diff Figma against code (file key abc123)"** — audit

Cursor's terminal sandbox blocks `localhost` by default, so the agent asks to run `storysync map`, `inspect` and `snap` outside it. Approve them: they have to reach Storybook.

### Codex

After `storysync setup --client codex`, which writes the skill to `.agents/skills/storysync/SKILL.md`, start Storybook, then:

```bash
codex mcp add storybook --url http://localhost:6006/mcp
codex mcp add figma --url https://mcp.figma.com/mcp      # signs you in to Figma
```

`codex mcp add` asks each server whether it needs a login. With Storybook not running it gets no answer and prints "MCP server may or may not require login"; Storybook's server needs none, so that line can be ignored.

Or install Figma's plugin instead of adding its server by hand: **Plugins** in the ChatGPT desktop app (the Codex app, in Figma's setup guide), `/plugins` in the CLI. `codex mcp add` registers servers for every project; to keep Storybook to this one, put it in `.codex/config.toml` instead, which Codex reads only once you trust the project:

```toml
[mcp_servers.storybook]
url = "http://localhost:6006/mcp"
```

Codex runs commands in a sandbox with network access off, and `map`, `inspect`, and `snap` need Storybook on `localhost` and a browser, so Codex asks to run `npx storysync` outside it. Approve it, or accept the rule Codex offers so it stops asking.

Codex stops waiting for an MCP tool call after `tool_timeout_sec` seconds (OpenAI's docs give the default as 60; Codex 0.141 and later wait 300). The skill splits large writes to Figma across calls, but if one still times out, raise the limit in the `[mcp_servers.figma]` table that `codex mcp add` wrote to `~/.codex/config.toml`:

```toml
[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
tool_timeout_sec = 600
```

Figma's plugin writes no such table, and Codex's settings for a plugin's MCP server cover switching it on and approving its tools, not the timeout. A `[mcp_servers.figma]` table takes the place of the plugin's own `figma` server, though, so with the plugin installed, run `codex mcp add figma --url https://mcp.figma.com/mcp` and add the line to the table it writes.

With Storybook running, say (or, in the CLI, type `$storysync` to name the skill):

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

The action installs your project's dependencies, starts Storybook on port 6006, extracts tokens, maps components, and compares both against baselines committed to the repo. Write the baselines before the first run: in the project's directory (`working_directory`), with Storybook running,

```bash
mkdir -p .storysync
npx storysync@<version> map --storybook http://localhost:6006 --json > .storysync/baseline.json
npx storysync@<version> tokens --json > .storysync/tokens-baseline.json
```

and commit them. `<version>` is the storysync version that matches the ref you use the action at: the `version` in this repository's [`package.json`](package.json) at that ref. The action builds storysync from its ref, and a baseline written by another version can differ from what it maps. Plain `npx storysync` runs whatever npm has: 0.2.0 finds no components with addon-mcp 10.6, so its baseline is empty and never matches. The action's warnings and errors give these commands with the version filled in. Or skip npx and save the action's `json` and `tokens_json` outputs, which hold the JSON it compared. If you set `components` or `token_source`, pass the same to `map --components` and `tokens --source`. A project with no tokens can leave out the token baseline, and one that checks only components can set `token_baseline: ''` to leave tokens out. Without a baseline, drift is `new` and a warning says it isn't being checked; with `fail_on_drift` the job fails, and the error gives the command that writes the missing baseline. A component baseline that isn't `map --json` output, or a token baseline that isn't `tokens --json` output, fails the job whatever `fail_on_drift` says, and the error gives the command that recreates it. That includes the `{"error": ...}` the command writes when it fails, as `map` does with Storybook not running: under `--json` the error goes to the file, not the terminal. Once it works for you, pin `@main` to a commit SHA.

| Input | Default | |
|---|---|---|
| `working_directory` | `.` | The project to check, relative to the repository root. Dependencies are installed, Storybook is started and tokens are read there, and the baseline paths and the files the action writes are relative to it. |
| `install_command` | from `packageManager` or the lockfile | By default the install is chosen in the first directory with a lockfile, looking upward from `working_directory` to the repository root: the package manager its package.json's `packageManager` field names, or else the one the lockfile belongs to. Lockfiles from different package managers with no `packageManager` to choose between them are an error. The install is `pnpm install --frozen-lockfile`, `yarn install --immutable` (`--frozen-lockfile` for Yarn 1), `npm ci`, or `bun install --frozen-lockfile` (set up bun first). Set it to `true` to skip the install when an earlier step already did it. |
| `storybook_url` | `http://localhost:6006` | With the default, the action starts Storybook itself on port 6006 and stops it once components are mapped, so the action can run again in the same job. If something is already serving on 6006, it fails rather than map the wrong Storybook. Anything else is used as is, so start that Storybook in an earlier step. |
| `components` | all | Comma-separated component names or IDs to map. A name that matches no component fails the job, and the error lists the names there are. |
| `token_source` | `auto` | `tailwind`, `css`, `theme`, or `auto`. |
| `baseline` | `.storysync/baseline.json` | Component baseline, as `map --json` writes it. Components are matched by their Storybook title, and the drift report names them by it, so two named Button, `Forms/Button` and `Nav/Button`, are each compared with their own baseline. |
| `token_baseline` | `.storysync/tokens-baseline.json` | Token baseline, as `tokens --json` writes it. A category's collections are compared as one, so a theme file's `fontSizes` and `fontWeights`, both typography, are both checked. Set it to `''` to check components only: tokens aren't extracted, `token_drift` is `skipped`, and `fail_on_drift` doesn't fail on them. |
| `fail_on_drift` | `false` | Fail the job when components or tokens differ from their baseline, or when a baseline is missing, since then nothing was compared. A `token_drift` of `none` or `skipped` doesn't fail. |
| `create_issue` | `false` | Open or update an issue labelled `storysync-drift` when drift is found. Needs `issues: write`. Filed before `fail_on_drift` fails the job. |
| `node_version` | `22` | Node.js version to run on. |

Outputs: `drift` and `token_drift` are `true`, `false`, or `new` when there is no baseline. `token_drift` is `none` when there is neither a token baseline nor any tokens; with a baseline, tokens that have all gone are drift. It is `skipped` when `token_baseline` is `''`. `json` and `tokens_json` carry the `map --json` and `tokens --json` output; `tokens_json` is empty when tokens are skipped.

[Aikido Safe Chain](https://github.com/AikidoSec/safe-chain#usage-in-cicd) set up in an earlier step doesn't check the action's installs. The action sets up Node and pnpm itself, and each setup puts its directory on `PATH` ahead of Safe Chain's shims, so the action's `npm ci`, `pnpm install` or `yarn install` runs the package manager directly, and so does its install of storysync's own dependencies. To have Safe Chain check your dependencies for malware, install them in your own steps the way its [GitHub Actions example](https://github.com/AikidoSec/safe-chain#github-actions-example) does: set up Node, at the version `node_version` names, and your package manager, then Safe Chain's CI setup, pinned to a release, then your install. Then set `install_command: 'true'`, so the action uses that install rather than running its own. Install before the action rather than after it: its Node and pnpm stay ahead of Safe Chain's shims for the rest of the job.

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
                            components bind to      styles — measured, not read
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

storysync reads design tokens from your codebase and previews the Figma variable collections that the skill files will create. Supported sources (auto-detected):

| Source | What it reads |
|---|---|
| **Tailwind** | `tailwind.config.ts/js` — `theme.extend.colors`, `spacing`, `borderRadius`, `fontSize`, `boxShadow`; or, with no config, Tailwind v4's `@theme { ... }` blocks in `.css` files (see below) |
| **CSS custom properties** | `:root { --color-*; --spacing-*; --radius-*; --font-*; --shadow-* }` in `.css` files |
| **Theme files** | `tokens.ts`, `theme.ts`, etc. — exported objects with `colors`, `spacing`, and similar keys |

Token categories: **colors**, **spacing**, **typography**, **radius**, **shadows**

Comments are skipped, so a commented-out key or custom property, such as an old value kept above the new one, is not a token.

Colour tokens are kept as written, in any CSS form: hex, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()` or `color()` in any of its spaces. A custom property whose name doesn't say it's a colour is still read as one when its value is in one of those functions, or is bare HSL channels as shadcn/ui's `:root` writes them, such as `240 5.9% 10%`, which are read as the `hsl()` they're written for. `diff` converts both sides to sRGB hex before comparing, so a `:root` token such as `--brand: oklch(63.7% 0.237 25.331)` matches a Figma variable of `#fb2c36`.

`tokens --json` gives each colour token that same sRGB hex as `hex`, next to its `value`: `{ "name": "brand", "value": "oklch(63.7% 0.237 25.331)", "hex": "#fb2c36" }`, `#rrggbbaa` when the colour is translucent. The push sets Figma's variables from `hex`, since `figma.util.rgb` and `rgba` take only hex, `rgb()`, `hsl()` and `lab()` and throw on the rest. A value storysync can't convert, such as `currentColor` or an unresolved `var()`, has no `hex`. `tokens --check` compares `value` alone, so a baseline written without `hex` still checks clean.

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

### Tailwind v4 `@theme`

A CSS-first Tailwind v4 project declares its tokens in `@theme` blocks rather than a config:

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

With no `tailwind.config`, a `.css` file with an `@theme` block (`@theme inline` and the like included) is the Tailwind source, detected ahead of `:root` custom properties: a v4 project's tokens are its theme. Variables are read by Tailwind's namespaces:

| Namespace | Category | Token name |
|---|---|---|
| `--color-*` | colors | without the namespace: `--color-brand-500` → `brand/500` |
| `--spacing-*`, `--spacing` | spacing | `--spacing-18` → `18`; the bare `--spacing` base unit → `DEFAULT` |
| `--radius-*` | radius | `--radius-card` → `card` |
| `--shadow-*` | shadows | `--shadow-soft` → `soft` |
| `--text-*`, `--font-*`, `--font-weight-*`, `--leading-*`, `--tracking-*` | typography | with the namespace, since they share a category: `text/hero`, `font/display`, `font/weight/bold`, `leading/snug` |

Dashes in a name become `/`, as for `:root` properties. A `var()` is resolved against the theme itself, the project's `:root` (shadcn/ui's v4 `@theme inline { --color-background: var(--background); }`) and, when `tailwindcss` is installed, Tailwind's default theme, so `--color-primary: var(--color-blue-500)` gives blue-500's value. The default theme only resolves references; like a Tailwind config's defaults, it isn't read as the project's tokens. Later declarations win, `initial` removes a variable (`--color-*: initial` a namespace), and modifiers such as `--text-hero--line-height` and rules nested in `@theme`, such as `@keyframes`, are skipped. Other namespaces (`--breakpoint-*`, `--animate-*`, `--text-shadow-*` and so on) are reported as uncategorized. `--source css` still reads only `:root`, which is what an earlier storysync read for a project with both, so a baseline written then needs `--source css`, or a new baseline.

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

A component's props are the ones in the Props section of its Storybook documentation. The same documentation lists the props of each of its `subcomponents`, and the source of any MDX page attached to it; neither becomes a variant property of the component.

## CLI reference

The CLI exists for two purposes: **setup** (the `init` and `setup` commands wire your project up for an AI client) and **preview / CI** (the `tokens`, `map`, `list`, `inspect`, and `diff` commands give you deterministic output you can inspect locally or run in GitHub Actions). Day-to-day Figma syncing happens through the AI client using the skill + slash commands above — the CLI does not write to Figma directly.

A command that can't reach Storybook, or `diff` Figma, exits 1, and so does one whose server takes the connection but doesn't answer within `--connect-timeout` milliseconds (default 60000). Under `--json` it says why on stdout, as `{"error": "Error: Failed to connect to Storybook MCP at <url>: ..."}`, so a script reading the output still gets JSON to parse.

### `storysync init`

Detect missing Storybook MCP setup and offer to fix it. Checks Storybook version (10.1+ required for component sync), whether `@storybook/addon-mcp` is installed, and whether it's registered in `addons` — then prompts before applying each fix to your `.storybook/main.ts`. An entry inside a comment doesn't count as registered, and the addon is added to the `addons` array that isn't commented out.

```text
Options:
  --project <path>     Project root path (default: ".")
```

The addon-mcp it installs matches the Storybook in `node_modules`, or before an install the lowest version `package.json` allows. addon-mcp now releases in lockstep with Storybook, and each release needs a Storybook at least as new as itself, so Storybook 10.6 and later get the addon-mcp of the same version. Earlier versions, and 10.6 prereleases older than addon-mcp's first lockstep release (10.6.0-alpha.4), get `^0.7.0`. An installed addon-mcp newer than Storybook, which an earlier `init` could install, doesn't load; `init` says so and offers the matching one. Declined, it is left as it is and `init` exits 1.

It installs with the package manager whose lockfile (pnpm, yarn, bun or npm) is nearest the project, looking upward as far as the repository root, so a package in a workspace uses the workspace's. With no lockfile, it uses npm. Run with `--project` from another directory, the commands it prints for you to run, such as the install you declined, start by changing into the project.

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
# writes .claude/skills/storysync/SKILL.md and .claude/commands/storysync-{push,diff}.md
npx storysync setup --client cursor
# writes .cursor/rules/storysync.mdc
npx storysync setup --client codex
# writes .agents/skills/storysync/SKILL.md
```

### `storysync tokens`

Extract design tokens from your project and preview what Figma variable collections would be created.

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

`--check` compares the current tokens against a committed baseline and lists what was added, removed or changed; `--strict` makes drift fail. Tokens are paired by category and name, as `diff` pairs them, so a category a theme file splits across exports, such as `fontSizes` and `fontWeights` in typography, is compared whole. The baseline is the `--json` output, taken with the same `--project` and `--source` as the check:

```bash
mkdir -p .storysync && npx storysync tokens --json > .storysync/tokens-baseline.json
```

A missing baseline is an error whatever the flags, and the message gives that command. Treated as a first run instead, a wrong `--baseline` path would pass every check, `--strict` included, having compared nothing. Under `--json` the extraction is still printed, with `"drift": "new"` and an `error`, so the output parses. Finding no tokens doesn't skip the check: the baseline is still read, so a mistyped `--project` fails on a missing baseline, or against an existing one reports every token in it as removed. A file that is not a baseline, such as a saved `--check --json`, fails with the command to recreate it.

`--source auto` detects the source, as leaving it out does, so the drift-check action's `token_source` can be passed on as it is. Any other unknown `--source` is an error, under `--json` as `{"error": ...}`, naming the sources there are, and `diff --source` is checked the same way. Falling back to detection instead, `--source scss` would read whatever the project had, a Tailwind config say, and pass.

### `storysync map`

Map all components to Figma variant definitions.

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

Measure what each component variant actually looks like, by rendering the story in a headless browser and reading `getComputedStyle`. This replaces guessing styles from source: the AI client translates measured values instead of interpreting Tailwind classes, `cva` calls, or theme indirection.

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

`--strict` fails on variants or components that could not be measured, on a component measured only in part because it was capped, and on a run that measured nothing at all — snap still writes `styles.json` and a fresh `meta.json` in that case, so an empty result must not read as a clean one. A `--components` name that matches nothing is an error whatever the flags, and writes nothing. Warnings are separate and opt-in via `--strict-warnings`, because a component whose variants legitimately render the same (aliased option values, for instance) would otherwise fail every build. In CI, `--strict-warnings` is usually what you want: it turns "this story silently ignores its args" into a build failure rather than a line of output nobody reads.

Writes `<out>/styles.json` containing, per component, full styles for a base variant plus only the properties each other variant changes. The file carries no timestamp, so repeat runs against unchanged code are byte-identical and it can be committed and diffed. With `--screenshots`, PNGs are written under `<out>/<component>/` and each variant's `screenshot` path is recorded relative to `styles.json`, so the file stays the same whichever directory or machine produced it.

**Variant selection.** `representative` measures every declared value once against the other properties' defaults, so cost scales with the *sum* of variant values rather than their product — a `3 × 2 × 2` button is 5 renders instead of 12. That is useful for a quick check, but it is not enough to build a Figma component set: a set needs every combination to exist, or the variant picker has nothing to switch to. So the push runs `--variants all`, which measures the full product and makes the default combination the base.

**The combination limit.** Combinations multiply — four props of four values is already 256 — and a Figma component set with thousands of variants is unusable. Above `--max-combinations` (default 256), snap measures a subset chosen to cover every value, records a `cap` on that component, warns, and fails `--strict`. A limit set lower than covering every value takes cannot cover them all, so the cap's `uncovered` list and the warning name any value left out rather than claiming coverage it does not have. It never drops combinations silently. The skill has the agent stop and ask how to proceed: build the covering subset, re-run with a higher `--max-combinations`, or narrow which props are variants.

**Requires Node 20+**, because Playwright does. Every other storysync command still runs on Node 18 — Playwright is loaded only when `snap` runs, so nothing else is affected.

**Browser.** storysync depends on `playwright-core`, which downloads no browsers, so one is located at runtime: `STORYSYNC_BROWSER_PATH` or `CHROME_PATH`, then an installed Chrome, then Edge, then a Playwright-managed download, then common system paths. If none is found the error lists every attempt. To install one:

```bash
npx playwright@latest install chromium     # note: the full `playwright` package
```

**Colours are recorded as sRGB hex.** Chromium reports a computed colour in the space it was written in: Tailwind v4's palette as `oklch(0.637 0.237 25.331)`, its opacity modifiers, which are a `color-mix()` in OKLab, as `oklab(0.637 0.214213 0.1014 / 0.5)`, and `lab()`, `lch()` and every `color()` space as themselves. snap converts each to `#rrggbb`, or `#rrggbbaa` when translucent, with CSS Color 4's conversions, so a fill, text colour, border or shadow in any of them reaches Figma and `verify` as the colour it is rather than as nothing drawn. A colour outside sRGB is clipped (see [Limitations](#limitations)).

**Gradients and background images are recorded.** A gradient fill has no `background-color`, so its `backgroundColor` is `null`, and one painted over a fill hides the colour that `backgroundColor` records. snap records the computed `background-image` as `backgroundImage`, its colours as hex, Tailwind v4's `bg-linear-to-r from-blue-600 to-violet-600` as `linear-gradient(to right, #155dfc 0%, #7f22fe 100%)`, and a `url()` as written; `null` means none. A Storybook wrapper with a background image is measured as the component rather than looked past.

**Corner radii are recorded as drawn.** Chromium reports a radius as computed, not as drawn: Tailwind v4's `rounded-full`, `calc(infinity * 1px)`, as `3.35544e+07px`, a percentage as written, and `calc(50% - 2px)` or `min(8px, 10%)` as themselves. snap resolves a percentage against the border box, horizontal radii against its width and vertical against its height, sizes a `calc()` or `min()` in the page, and then scales corners that together run longer than a side, all by one factor, as CSS does. So `rounded-full` on a 32px-tall pill is recorded as 16, and so is v3's `9999px`, rather than as a radius the browser never drew. Figma has no elliptical corner, so one whose two radii differ, `10px / 20px` or `50%` of a box that isn't square, keeps the smaller.

**Shadow layers that draw nothing are left out.** Tailwind fills every shadow and ring slot a class doesn't use with `0 0 #0000`, so `shadow-sm` computes to four empty layers before its two real ones. snap drops a layer that is fully transparent, or has no offset, blur or spread, so `boxShadow` lists only the layers that are drawn, each one a Figma effect.

**Font substitution is detected.** The measured `fontFamily` is the family the code *asked for*, so a project naming a font it never loaded would otherwise measure — and score — as though that font were used while the browser rendered a fallback. snap probes whether the family actually applied and warns when it did not, naming it. Note that Figma needs the font available to its own editor too; storysync cannot install fonts into Figma, as the Plugin API has no such capability.

**Stories must pass args through.** snap sets variant values via Storybook's `?args=` URL. A story that hardcodes props, uses a custom `render` that ignores its args, or wraps the component in a decorator that drops them will render its default state for *every* variant. snap warns when all of a component's variants measure identically, which catches the common cases — but a story whose variants happen to differ only in unmeasured ways would not be flagged. Plain CSF3 args-driven stories are the reliable shape.

Values Storybook cannot carry in a URL are reported rather than measured. Its allowed character set is `[a-zA-Z0-9 _-]`, so an option like `Data Display` works while `Nav/Primary` is rejected — those variants are marked `args_unsupported` instead of silently recording the default render.

**Variant names ignore case and punctuation.** Each variant is named from its combination, lowercased with punctuation collapsed, and that name is the key joining a measurement to the Figma node built from it. Two declared values that differ only in those respects — `Small` and `small`, `x-large` and `x large` — would therefore produce one name for two variants. snap numbers the duplicate (`size-small--2`) so nothing is lost, and warns, because the numbered name is what reaches Figma and says nothing about which value it came from. Renaming the declared values is the real fix.

### `storysync verify`

Compare what was written to Figma against the styles `snap` measured, and report a fidelity score. The agent writes a component, reads the created nodes' real properties back in separate `use_figma` calls, a slice of the set at a time, writes what they return into `.storysync/figma-readback.json`, each entry with the time Figma read it and the checksum the readback computed in Figma, and this scores the result.

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

The three strict flags cover different questions, and each is opt-in because each has a legitimate reason to be noisy:

| Flag | Fails on |
|---|---|
| `--strict` | Properties that disagree; variants Figma never received; variants Figma reported with nothing comparable (`unscored`); a readback entry whose checksum is missing or doesn't match, whose component has the `nodeId` of another, that lacks a field the readback always returns, or that was read before the snap (an unverified readback); a run that compared nothing at all; and a component the snap failed to measure, or a snap with no components |
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

Reporting *nothing* is not a pass, though, and nor is reporting less than the readback always does. A variant Figma reported without a single comparable property is not verified, and fails `--strict`: otherwise the writer being graded would choose its own denominator and score a perfect nothing. Such an entry lacks fields the readback template always returns, so it is reported as an incomplete readback (below); were it complete, it would be `unscored`. Likewise a snap that recorded a component failure, or no components at all, fails `--strict` and is printed as `! snap recorded a failure`. A single variant snap could not measure is reported but not failed on its own — some are expected (`args_unsupported`), and those built from source are already caught by `--strict-measured`.

**The readback has to be what Figma returned.** `verify` compares two local files and never contacts Figma, so it can only score what the readback file says. On one live push the agent wrote that file from snap's own values plus the sizes that came off the Figma nodes, rather than from what the readback calls returned, so every property but size was snap compared with snap, and the score proved nothing about colour, padding, type or radius. So the skill's readback template computes a checksum of each entry inside Figma, over exactly what the call returns, and `verify` recomputes it: 32-bit FNV-1a over the entry as JSON with every object's keys sorted, under the component set's id (the readback's `nodeId`) and the variant's slug, so an entry copied onto another variant fails too, and so does one copied onto the same slug in another component, where every component without variant props has the slug `default`. A component with no `nodeId` has none of its entries' checksums checked, and all of them fail. Nor may two components have the same `nodeId`: a whole component's entries copied onto another, `nodeId` and all, carry checksums that match under that id, but an honest readback reads each component from a set of its own, so every entry of both is reported as a duplicated `nodeId`, since which of them Figma returned can't be told. An entry whose checksum is missing or doesn't match was edited, composed from something else, or copied, after Figma returned it. `verify` reports it as an unverified readback, apart from drift, scores none of its properties either way, and fails `--strict`; it never prints the checksum the entry should have had. A missing checksum fails like a wrong one: verify and the readback are new in 0.3.0, so no released skill wrote a readback without them, and an optional checksum would be no check, since leaving it out is the easy way to compose a file by hand. The checksum ignores how the file is laid out (indentation, key order, `1e-7` or `0.0000001`), but not a value: rounding Figma's `0.4000000059604645` to `0.4`, changing a colour's case, or dropping a `null` all count as edits.

**And it has to be all of what the readback returns, from this run.** A template cut down to fewer fields still seals what it returns, and only the properties an entry reports are scored, so a readback cut down to `{ source, width, height }` would score 100% on every strict flag without comparing colour, padding, type or radius, and one cut down to leave out type and spacing would score without comparing those. So the skill's template returns every field it reads on every entry, `null` where Figma has nothing to report, and `verify` requires all thirteen, present even when `null`: `source`, `backgroundColor`, `color`, `borderRadiusUniform`, `padding`, `borderUniform`, `fontSize`, `fontWeight`, `fontFamily`, `gap`, `opacity`, `width` and `height`. An entry that lacks one is an incomplete readback. The text child's fields are `null` on a variant with no text child, and `fontSize`, `fontWeight` and `fontFamily` also where Figma reports them as mixed; `verify` scores a `null` text field as a match only where snap measured no text on the variant either, and as drift where it did. `gap` is `null` on a frame without auto layout, which matches a measured gap of `null` or zero and drifts from any other. The template also seals into each entry `readAt`, the time Figma read it, and an entry with none, or read before the snap's `measuredAt` in `meta.json`, is a stale readback, one reused from an earlier run. `use_figma` runs the template in Figma's environment, not on the machine that ran snap, so the two times come from different clocks, and an honest readback follows the snap by only the minute or two the build takes; `verify` lets `readAt` fall up to five minutes before `measuredAt`, so that a machine clock a few minutes fast doesn't fail an honest run. Without `meta.json`, only that each entry has a `readAt` is checked, and `--strict-age` fails on the unknown age. Both are unverified readbacks, reported, left unscored and failed like a checksum that doesn't match, and neither ever ends on "Figma matches".

`color`, `fontSize`, `fontWeight` and `fontFamily` are compared with the styles snap measured on the element that owns the text, matching the Figma TEXT node the readback reads. Colors are compared as snap writes them, ignoring case: `#rrggbb`, `#rrggbbaa` for a translucent one, and `null` for one that draws nothing, so the readback carries a Figma paint's opacity as the alpha byte. Opacity uses a fixed 0.01 allowance rather than `--tolerance`, which is a pixel budget. A measured `null` gap and a reported gap of zero, or a reported `null` one from a frame without auto layout, count as the same rendering; a reported `null` gap against a measured one is drift.

**Staleness.** `snap` writes a `meta.json` beside `styles.json` recording when the measurement was taken and against which Storybook. It is deliberately a separate file: `styles.json` is meant to be committed and diffed, and an embedded timestamp would churn on every run and bury the changes that matter. `verify` uses it to notice it is scoring a measurement taken before the code changed — the one drift case nothing else catches, since every property matches and the score reads 100%.

`--strict-age` fails when the age cannot be established at all — a missing or malformed `meta.json`, or one dated in the future. That matters because `meta.json` is exactly the file a project is likely to gitignore, being the one that churns; treating an unknown age as a pass would make the check succeed unconditionally in the setup it exists to protect. Age is reported on every run, so an unchecked one never passes for a checked one.

### `storysync list`

List all components available in Storybook.

Storybook's docs list also names MDX docs pages, such as an introduction or a usage guide. They have no stories to measure, so `list` and every command that reads components leave them out rather than reading them as components.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --connect-timeout <ms> How long to wait for Storybook MCP to answer (default: 60000)
```

### `storysync diff`

Compare a Figma file against code tokens and Storybook components. Reads from Figma via MCP, extracts tokens from local code, and optionally maps Storybook components — then reports what's different.

> Requires a Figma MCP endpoint reachable without browser-based OAuth (typically a local proxy from a supported MCP client). If the command hangs on auth or returns `401`/`403`, use the skill file's audit flow instead — it runs inside the client that already holds the OAuth session.

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

Example:

```bash
# Diff tokens only
npx storysync diff --figma https://mcp.figma.com/mcp --file-key abc123

# Diff tokens + components
npx storysync diff --figma https://mcp.figma.com/mcp --file-key abc123 --storybook http://localhost:6006
```

`--components` narrows both sides. Storybook components are selected as `snap` and `map` select them, and Figma's to the same names, so a component left out of the diff is not reported as missing from code. A name only Figma has is not a typo: it is reported as not in code, which fails `--strict`, since that is the answer to asking about it. When both sides were read, a name neither side has is an error whatever the flags. When Storybook can't be listed, no name can be told from a typo, so none is rejected: Figma is still narrowed to the names given, and the run is reported as partial, with `"storybookReadFailed": true` under `--json`, which fails `--strict`. `--components` without `--storybook` is an error too.

`diff` reads Figma with `use_figma`, within its limits. It returns at most 20kb per call, and it loads a file's pages only as a call switches to them, starting each call on the first, so a search of the whole file sees only the first page, while the push puts each category on a page of its own. So `diff` lists the pages, leaving out dividers, and in the same call reads the first page's component sets, and its components outside any set, since that page is already loaded. It reads each other page in calls of its own, each switching to that page once. Variables belong to the file, not a page, and are read in calls of their own. Every call returns as much as fits in 17,000 bytes of JSON and says where the next starts. A file whose pages and palette each fit in one response takes one call for the variables, one for the page list and the first page, and one for each other page, and each further 17,000 bytes takes one more.

Each of those calls counts toward the limits Figma's MCP server sets on a seat's tool calls, by the minute and by the day ([rate limits](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)). The calls run one after another, but that doesn't keep them under the per-minute limit: a file of many pages may reach it, and a large library uses more of the day's. A call the server refuses for the limit fails the read with a message saying the limit was hit, not as a page that can't be read, and the run is reported as partial, with `"figmaReadFailed": true` under `--json`. Run `diff` again later.

A component whose own properties come to more than 17,000 bytes, such as a thousand icons as the options of one variant property, can't come back in any call. It fails the read, naming the component and its page, as a page that can't be read does, and the run is reported as partial, with `"figmaReadFailed": true` under `--json`, which fails `--strict`. A name on more than one page, an archived copy, say, is reported as `ambiguous`, which fails `--strict` too. None of its copies is compared, so the name is counted once, as ambiguous, and not also as matched or missing.

### `storysync inspect`

Inspect one component's props and show how each maps to Figma.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --component <name>     Component name or ID to inspect (required);
                         a name that matches nothing is an error
  --connect-timeout <ms> How long to wait for Storybook MCP to answer (default: 60000)
```

## Limitations

Both directions have known constraints worth knowing before you rely on their output: the Figma → code diff and audit, and the code → Figma push, from what `snap` measures to what `verify` scores.

### Figma → code: `diff` and the audit

- **Figma MCP auth**: The CLI `diff` command needs an authenticated Figma MCP endpoint. Most Figma MCP setups require browser-based OAuth that only supported MCP clients can complete. Use the skill file's audit flow inside Claude Code / Cursor / Codex if the CLI returns `401`/`403`.
- **`use_figma` return contract**: The audit relies on `use_figma` surfacing the plugin code's return value as MCP tool output. This works when run from a supported MCP client; behavior from third-party CLIs is not guaranteed. If `use_figma` doesn't return values, the skill agent is instructed to look for read-only tools or fall back to a user-exported JSON snapshot.
- **Multi-mode variables**: By default, only the first mode of each Figma variable collection is read. Use `--mode <name>` on the CLI (or instruct the agent in chat) to read a specific mode like "Light" or "Dark".
- **Variable aliases**: Aliases are resolved up to 8 levels deep; cycles are detected. Aliases pointing at variables in remote/team libraries are not resolved.
- **Collection name mapping**: Figma collections are matched to code categories by lowercase name (`Colors` → `colors`, `Border Radius` → `radius`, etc.). Custom collection names like "Brand Primitives" won't auto-categorize and will appear as missing-from-code.
- **Component name matching**: Components are matched by lowercased name. PascalCase code components and Title Case Figma components match if their lowercased forms are equal, but slash-paths in Figma names (e.g. `Button/Primary`) won't match a flat code name (`ButtonPrimary`). Two code components sharing a name (e.g. `Forms/Button` and `Nav/Button`) can't both be paired with Figma's single `Button`; `diff` reports the name as `ambiguous` and fails `--strict` rather than silently comparing one. The same goes for a name repeated across Figma pages, such as an archived copy of `Button` or one pushed to two categories' pages. Either way, `diff` compares none of the copies, so the name is reported only as `ambiguous`, never also as matched or missing.
- **Colour tokens outside sRGB compare as their clipped hex**: `diff` converts a token's colour to sRGB hex, clipping one outside sRGB as `snap` does (see the next section), so `color(display-p3 1 0 0)` matches a Figma variable of `#ff0000`, as does any other colour that clips to it.
- **Tailwind CSS-var resolution**: When a Tailwind config references CSS variables (e.g. `hsl(var(--bg))`), only the `:root` block is read by default. Theme overrides like `.dark { ... }` are not currently followed; the `:root` (light) values are used, for the variables a push creates as well as for `diff`.

### Code → Figma: `snap`, the push and `verify`

- **Story args wiring**: `storysync snap` varies variants through Storybook's `?args=` URL, so a story that ignores its args measures its default state for every variant. snap warns when all of a component's variants measure identically. See [`storysync snap`](#storysync-snap).
- **Variant values must be URL-safe**: Storybook only accepts `[a-zA-Z0-9 _-]` in URL args, so an option value containing e.g. `/` cannot be measured and is reported as `args_unsupported`.
- **Props without declared options**: A prop typed as a bare `string` or `number` with no `options` in its argType becomes no Figma variant property, so it is not measured. Storybook's documentation response does not always surface argType options.
- **Figma sets text about a pixel apart from the browser**: Figma lays text out with its own metrics, so a frame that hugs its text can come out a pixel or two wider or narrower than the browser drew it. In one push, a chip labelled "Chip" in bold 11px Inter measured 38.59px wide in Chrome and 40px in Figma. `verify` allows 3% or 1px on width and height, whichever is larger, so a short label at a small size can still drift. The skill has the agent report that drift as a font-rendering difference rather than fix the text's width to squeeze it, which can clip the label, unless the variant has a stroke that isn't `OUTSIDE`, or the width is off by exactly twice its border: then the stroke was built wrong, and that's what gets fixed.
- **A transparent border shows as an unfilled ring in Figma**: The browser draws an element's background under a transparent border, but Figma's fill stops where an `OUTSIDE` stroke begins. The push keeps the border's space with a stroke that paints nothing, so the size matches and the ring around the fill stays empty. A stroke tinted the background's color looks closer, but `verify` scores it as a border color the code doesn't have; the push summary names those variants so you can choose.
- **`verify` trusts the readback**: it compares two local files and can't contact Figma, so it scores what the readback file says. The checksum on each entry, sealed under the set's id, the slug and the time Figma read it, catches a readback edited, composed from snap's values, or copied from another variant or component after Figma returned it, and `verify` also catches a whole component's entries copied onto another under its `nodeId`, and a readback cut down to fewer fields or read before the snap. But the checksum is not a signature: the code that computes it is in the skill, so an agent that runs it over values it made up, or over a `readAt` it made up, passes. And `readAt` tells a readback from before the snap, less the five minutes allowed for the two clocks, not one from before a later fix: a readback reused after a fix round, rather than read again, still passes. Nor does it catch a readback template that echoes the values it sent rather than reading them off the nodes, since the checksum covers whatever the template returns. The falsification test in [the example's README](examples/storybook-vite/README.md#pushing-to-figma) covers that: change a node in Figma by hand, read it back, and `verify` should report exactly that drift.
- **Colours outside sRGB are clipped**: Figma's fills are sRGB here, so snap converts every colour to sRGB hex, and one outside sRGB, a `color(display-p3 1 0 0)` red say, or one of Tailwind v4's more saturated shades like red-600, `oklch(57.7% 0.245 27.325)`, is clipped channel by channel to the nearest sRGB value: `#ff0000` and `#e7000b`. That is what Chromium paints on an sRGB canvas, but a wide-gamut screen shows the code's colour more saturated than Figma's, and CSS Color 4's own gamut mapping, which reduces chroma instead, would choose a slightly different hex.
- **Gradient and image fills aren't scored**: snap records them as `backgroundImage`, but `verify` compares only `backgroundColor`, and the readback reads only a solid fill, so a gradient built as a solid colour, or not built at all, isn't reported as drift.
- **CSS `outline` isn't measured**: snap reads borders and box shadows, not outlines, so a focus ring drawn with `outline` and `outline-offset`, on a selected variant say, never reaches Figma, and `verify` can't report it missing.

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
