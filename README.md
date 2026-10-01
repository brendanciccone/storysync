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

and commit them. `<version>` is the storysync version that matches the ref you use the action at: the `version` in this repository's [`package.json`](package.json) at that ref. The action builds storysync from its ref, and a baseline written by another version can differ from what it maps. Plain `npx storysync` runs whatever npm has: 0.2.0 finds no components with addon-mcp 10.6, so its baseline is empty and never matches. The action's warnings and errors give these commands with the version filled in. Or skip npx and save the action's `json` and `tokens_json` outputs, which hold the JSON it compared. If you set `components` or `token_source`, pass the same to `map --components` and `tokens --source`. A project with no tokens can leave out the token baseline, and one that checks only components can set `token_baseline: ''` to leave tokens out. Without a baseline, drift is `new` and a warning says it isn't being checked; with `fail_on_drift` the job fails, and the error gives the command that writes the missing baseline. Once it works for you, pin `@main` to a commit SHA.

| Input | Default | |
|---|---|---|
| `working_directory` | `.` | The project to check, relative to the repository root. Dependencies are installed, Storybook is started and tokens are read there, and the baseline paths and the files the action writes are relative to it. |
| `install_command` | from `packageManager` or the lockfile | By default the install is chosen in the first directory with a lockfile, looking upward from `working_directory` to the repository root: the package manager its package.json's `packageManager` field names, or else the one the lockfile belongs to. Lockfiles from different package managers with no `packageManager` to choose between them are an error. The install is `pnpm install --frozen-lockfile`, `yarn install --immutable` (`--frozen-lockfile` for Yarn 1), `npm ci`, or `bun install --frozen-lockfile` (set up bun first). Set it to `true` to skip the install when an earlier step already did it. |
| `storybook_url` | `http://localhost:6006` | With the default, the action starts Storybook itself on port 6006 and stops it once components are mapped, so the action can run again in the same job. If something is already serving on 6006, it fails rather than map the wrong Storybook. Anything else is used as is, so start that Storybook in an earlier step. |
| `components` | all | Comma-separated component names or IDs to map. A name that matches no component fails the job, and the error lists the names there are. |
| `token_source` | `auto` | `tailwind`, `css`, `theme`, or `auto`. |
| `baseline` | `.storysync/baseline.json` | Component baseline, as `map --json` writes it. |
| `token_baseline` | `.storysync/tokens-baseline.json` | Token baseline, as `tokens --json` writes it. Set it to `''` to check components only: tokens aren't extracted, `token_drift` is `skipped`, and `fail_on_drift` doesn't fail on them. |
| `fail_on_drift` | `false` | Fail the job when components or tokens differ from their baseline, or when a baseline is missing, since then nothing was compared. A `token_drift` of `none` or `skipped` doesn't fail. |
| `create_issue` | `false` | Open or update an issue labelled `storysync-drift` when drift is found. Needs `issues: write`. Filed before `fail_on_drift` fails the job. |
| `node_version` | `22` | Node.js version to run on. |

Outputs: `drift` and `token_drift` are `true`, `false`, or `new` when there is no baseline. `token_drift` is `none` when there is neither a token baseline nor any tokens; with a baseline, tokens that have all gone are drift. It is `skipped` when `token_baseline` is `''`. `json` and `tokens_json` carry the `map --json` and `tokens --json` output; `tokens_json` is empty when tokens are skipped.

[Aikido Safe Chain](https://github.com/AikidoSec/safe-chain#usage-in-cicd) set up in an earlier step doesn't check the action's installs. The action sets up Node and pnpm itself, and each setup puts its directory on `PATH` ahead of Safe Chain's shims, so the action's `npm ci`, `pnpm install` or `yarn install` runs the package manager directly, and so does its install of storysync's own dependencies. To have Safe Chain check your dependencies for malware, install them in your own steps the way its [GitHub Actions example](https://github.com/AikidoSec/safe-chain#github-actions-example) does: set up Node, at the version `node_version` names, and your package manager, then Safe Chain's CI setup, pinned to a release, then your install. Then set `install_command: 'true'`, so the action uses that install rather than running its own. Install before the action rather than after it: its Node and pnpm stay ahead of Safe Chain's shims for the rest of the job.

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

A command that can't reach Storybook, or `diff` Figma, exits 1, and so does one whose server takes the connection but doesn't answer within `--connect-timeout` milliseconds (default 60000). Under `--json` it says why on stdout, as `{"error": "Error: Failed to connect to Storybook MCP at <url>: ..."}`, so a script reading the output still gets JSON to parse.

### `storysync init`

Detect missing Storybook MCP setup and offer to fix it. Checks Storybook version (10.1+ required for component sync), whether `@storybook/addon-mcp` is installed, and whether it's registered in `addons` — then prompts before applying each fix to your `.storybook/main.ts`.

```text
Options:
  --project <path>     Project root path (default: ".")
```

The addon-mcp it installs matches the Storybook in `node_modules`, or before an install the lowest version `package.json` allows. addon-mcp now releases in lockstep with Storybook, and each release needs a Storybook at least as new as itself, so Storybook 10.6 and later get the addon-mcp of the same version. Earlier versions, and 10.6 prereleases older than addon-mcp's first lockstep release (10.6.0-alpha.4), get `^0.7.0`. An installed addon-mcp newer than Storybook, which an earlier `init` could install, doesn't load; `init` says so and offers the matching one. Declined, it is left as it is and `init` exits 1.

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

`--check` compares the current tokens against a committed baseline and lists what was added, removed or changed; `--strict` makes drift fail. The baseline is the `--json` output, taken with the same `--project` and `--source` as the check:

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

**Font substitution is detected.** The measured `fontFamily` is the family the code *asked for*, so a project naming a font it never loaded would otherwise measure — and score — as though that font were used while the browser rendered a fallback. snap probes whether the family actually applied and warns when it did not, naming it. Note that Figma needs the font available to its own editor too; storysync cannot install fonts into Figma, as the Plugin API has no such capability.

**Stories must pass args through.** snap sets variant values via Storybook's `?args=` URL. A story that hardcodes props, uses a custom `render` that ignores its args, or wraps the component in a decorator that drops them will render its default state for *every* variant. snap warns when all of a component's variants measure identically, which catches the common cases — but a story whose variants happen to differ only in unmeasured ways would not be flagged. Plain CSF3 args-driven stories are the reliable shape.

Values Storybook cannot carry in a URL are reported rather than measured. Its allowed character set is `[a-zA-Z0-9 _-]`, so an option like `Data Display` works while `Nav/Primary` is rejected — those variants are marked `args_unsupported` instead of silently recording the default render.

**Variant names ignore case and punctuation.** Each variant is named from its combination, lowercased with punctuation collapsed, and that name is the key joining a measurement to the Figma node built from it. Two declared values that differ only in those respects — `Small` and `small`, `x-large` and `x large` — would therefore produce one name for two variants. snap numbers the duplicate (`size-small--2`) so nothing is lost, and warns, because the numbered name is what reaches Figma and says nothing about which value it came from. Renaming the declared values is the real fix.

### `storysync verify`

Compare what was written to Figma against the styles `snap` measured, and report a fidelity score. The agent writes a component, reads the created nodes' real properties back in separate `use_figma` calls, a slice of the set at a time, into `.storysync/figma-readback.json`, and this scores the result.

```text
Options:
  --snap <path>          Snap output (default: ".storysync/snaps/styles.json")
  --readback <path>      Properties read back from Figma (default: ".storysync/figma-readback.json")
  --tolerance <px>       Allowed difference for lengths (default: 0.5)
  --max-age <duration>   Warn when the snap is older than this (default: "2h")
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any variant drifted, is missing from Figma, or reported
                         nothing comparable, or if the snap recorded a component failure
  --strict-age           Implies --strict, and also fails on a stale snap
  --strict-measured      Implies --strict, and also fails on anything not measured
```

The three strict flags cover different questions, and each is opt-in because each has a legitimate reason to be noisy:

| Flag | Fails on |
|---|---|
| `--strict` | Properties that disagree; variants Figma never received; variants Figma reported with nothing comparable (`unscored`); a run that compared nothing at all; and a component the snap failed to measure, or a snap with no components |
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

Reporting *nothing* is not a pass, though. A variant Figma reported without a single comparable property is `unscored` rather than verified, and fails `--strict`: otherwise the writer being graded would choose its own denominator and score a perfect nothing. Likewise a snap that recorded a component failure, or no components at all, fails `--strict` and is printed as `! snap recorded a failure`. A single variant snap could not measure is reported but not failed on its own — some are expected (`args_unsupported`), and those built from source are already caught by `--strict-measured`.

`color`, `fontSize`, `fontWeight` and `fontFamily` are compared with the styles snap measured on the element that owns the text, matching the Figma TEXT node the readback reads. Opacity uses a fixed 0.01 allowance rather than `--tolerance`, which is a pixel budget. A measured `null` gap and a reported gap of zero count as the same rendering.

**Staleness.** `snap` writes a `meta.json` beside `styles.json` recording when the measurement was taken and against which Storybook. It is deliberately a separate file: `styles.json` is meant to be committed and diffed, and an embedded timestamp would churn on every run and bury the changes that matter. `verify` uses it to notice it is scoring a measurement taken before the code changed — the one drift case nothing else catches, since every property matches and the score reads 100%.

`--strict-age` fails when the age cannot be established at all — a missing or malformed `meta.json`, or one dated in the future. That matters because `meta.json` is exactly the file a project is likely to gitignore, being the one that churns; treating an unknown age as a pass would make the check succeed unconditionally in the setup it exists to protect. Age is reported on every run, so an unchecked one never passes for a checked one.

### `storysync list`

List all components available in Storybook.

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

A component whose own properties come to more than 17,000 bytes, such as a thousand icons as the options of one variant property, can't come back in any call. It fails the read, naming the component and its page, as a page that can't be read does, and the run is reported as partial, with `"figmaReadFailed": true` under `--json`, which fails `--strict`. A name on more than one page, an archived copy, say, is compared from the first page it is on and reported as `ambiguous`, which fails `--strict` too.

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

The reverse-direction (Figma → code) features have known constraints that you should be aware of before relying on the diff output:

- **Figma MCP auth**: The CLI `diff` command needs an authenticated Figma MCP endpoint. Most Figma MCP setups require browser-based OAuth that only supported MCP clients can complete. Use the skill file's audit flow inside Claude Code / Cursor / Codex if the CLI returns `401`/`403`.
- **`use_figma` return contract**: The audit relies on `use_figma` surfacing the plugin code's return value as MCP tool output. This works when run from a supported MCP client; behavior from third-party CLIs is not guaranteed. If `use_figma` doesn't return values, the skill agent is instructed to look for read-only tools or fall back to a user-exported JSON snapshot.
- **Multi-mode variables**: By default, only the first mode of each Figma variable collection is read. Use `--mode <name>` on the CLI (or instruct the agent in chat) to read a specific mode like "Light" or "Dark".
- **Variable aliases**: Aliases are resolved up to 8 levels deep; cycles are detected. Aliases pointing at variables in remote/team libraries are not resolved.
- **Collection name mapping**: Figma collections are matched to code categories by lowercase name (`Colors` → `colors`, `Border Radius` → `radius`, etc.). Custom collection names like "Brand Primitives" won't auto-categorize and will appear as missing-from-code.
- **Component name matching**: Components are matched by lowercased name. PascalCase code components and Title Case Figma components match if their lowercased forms are equal, but slash-paths in Figma names (e.g. `Button/Primary`) won't match a flat code name (`ButtonPrimary`). Two code components sharing a name (e.g. `Forms/Button` and `Nav/Button`) can't both be paired with Figma's single `Button`; `diff` reports them as `ambiguous` and fails `--strict` rather than silently comparing one.
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
