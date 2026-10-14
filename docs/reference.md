# Storysync reference

The [README](https://github.com/brendanciccone/storysync/blob/main/README.md) covers the common path: installing Storysync, a first push, checking the result and finding drift. This page is the reference. Look things up as you need them.

## Contents

- [Commands](#commands): every command and its flags
- [How snap measures](#how-snap-measures)
- [How the build works](#how-the-build-works)
- [How verify scores](#how-verify-scores)
- [Tokens](#tokens): sources, values, dark mode and Tailwind
- [Props and variants](#props-and-variants)
- [GitHub Action](#github-action)
- [Troubleshooting](#troubleshooting)
- [Non-goals](#non-goals)

## Commands

The CLI handles setup (`init`, `setup`) and gives deterministic output you can check locally or in CI (`tokens`, `list`, `map`, `inspect`, `snap`, `figma`, `verify`, `diff`). It never calls Figma's tools itself: `figma tokens` writes the variable calls and `figma code` the component calls, and your AI client sends them. The one request it sends to Figma is `figma upload`'s, which posts image bytes to the upload URLs Figma's `upload_assets` gave your client.

**Connecting.** A command that can't reach Storybook (or Figma, for `diff`) exits 1. So does one whose server accepts the connection but doesn't answer within `--connect-timeout` (default 60000 ms). With `--json`, the error is printed as JSON, `{"error": "..."}`, so scripts can still parse it. When the server answers with an HTTP error, the message gives the status and what to do, such as running `storysync init` when Storybook has no `/mcp`.

**Request timeouts.** Once connected, each request has `--request-timeout` (default 300000 ms, five minutes). A large Storybook can take more than a minute to answer one, since it builds each component's docs when they're asked for. A component whose docs don't come back in time fails on its own, with an error that names the flag, and `--strict` catches it. A `--connect-timeout` longer than five minutes raises the request limit too.

**Progress.** `map`, `snap` and `diff` read components one at a time, which can take minutes for a large library. On a terminal they show which component they're on, on stderr, so `--json` output stays clean. Piped or in CI they print nothing extra, unless you set `STORYSYNC_PROGRESS=1`, which prints a line per component (and per snap variant) to stderr, so you can follow a background run from its stderr file. `STORYSYNC_PROGRESS=0` turns the terminal line off. A terminal that reports 0 columns is treated as 80 wide.

**Naming components.** `--components`, `--skip` and `inspect --component` take a component's name, its title as `list` prints it (`ui/base/Button`), the title's last segment as the sidebar shows it, or its Storybook ID. A name that matches nothing is an error.

**The docs cache.** `map`, `inspect`, `snap` and `diff` keep each component's docs in `.storysync/cache/docs` until Storybook's `index.json` or the component's manifest entry changes. `--no-cache` reads them again.

### `storysync init`

Checks your Storybook setup and offers to fix it: the Storybook version (10.1 or later is needed for components), whether `@storybook/addon-mcp` is installed, and whether it's registered in `.storybook/main.ts`. It asks before each change.

```text
Options:
  --project <path>     Project root path (default: ".")
```

It installs the addon-mcp that matches your Storybook: the same version for Storybook 10.6 and later, and `^0.7.0` before that. An installed addon-mcp newer than Storybook won't load, so `init` offers the matching one, and exits 1 if you decline. It uses the nearest package.json `packageManager` field or lockfile, looking up to the repo root. When both are in the same directory, `packageManager` wins. With neither, it uses npm.

If the install fails, `init` exits 1 and prints the command to run by hand. If the package manager isn't installed, it says so and why it chose it. It still offers to register the addon, since that doesn't depend on the install.

### `storysync setup`

Adds the skill, slash commands and MCP setup notes for your AI client.

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

`setup` doesn't overwrite files that exist. After upgrading Storysync, run it again with `--force` to update the skill and commands. `--force` replaces any local edits to those files.

### `storysync tokens`

Extracts design tokens and previews the Figma variable collections they'd create. See [Tokens](#tokens).

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

`--check` compares against a committed baseline and lists tokens that were added, removed or changed. Add `--strict` to fail on drift. Write the baseline with the same `--project` and `--source` you check with:

```bash
mkdir -p .storysync && npx storysync tokens --json > .storysync/tokens-baseline.json
```

A missing baseline is always an error, so a wrong `--baseline` path can't pass by comparing nothing. A file that isn't `tokens --json` output is an error too. `--check` compares `value`, and dark values against a baseline that has `modes`. `hex` and `px` aren't compared, so they cause no drift on their own. When drift appears, it ends with the command that writes a new baseline. With `--source`, the text output names the source it read.

### `storysync list`

Lists the components in Storybook, each by its title and ID. MDX docs pages, like an introduction, are left out here and in every other command. Entries whose stories name no component, like shadcn's `design/*` token pages, are listed as skipped, and left out of `map`, `snap` and `diff` unless `--components` names them.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --connect-timeout <ms> How long to wait to connect to Storybook MCP (default: 60000)
  --request-timeout <ms> How long each request may take once connected (default: 300000)
  --json                 Output JSON instead of formatted text
```

`--json` gives each component's `id`, `name`, `title`, `category` and `storyIds`, with `titleDerived: true` on a title rebuilt from its ID, and `docsOnly: true` on an entry with no component behind it.

### `storysync map`

Maps every component to Figma variant definitions, without rendering anything. Each one has its Storybook `id` and `title`. Titles come from Storybook's `index.json`. If Storysync can't read it within 5 seconds of the docs list answering, it rebuilds them from the IDs, which loses case and folders (`UI Base/Button` for `ui/base/Button`), and `list` says so.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --connect-timeout <ms> How long to wait to connect to Storybook MCP (default: 60000)
  --request-timeout <ms> How long each request may take once connected (default: 300000)
  --components <names>   Comma-separated component names, titles or IDs (default: all);
                         a name that matches nothing is an error
  --max-combinations <n> Most combinations to generate per component before capping (default: 256)
  --exclude-props <names>
                         Comma-separated prop names never to map as variant properties,
                         in any component
  --keep-props <names>   Comma-separated prop names never to leave out on their own
  --snap <dir>           Snap whose recorded argTypes and left-out props to use
                         (default: ".storysync/snaps"); --no-snap uses none
  --no-cache             Read every component's docs from Storybook, not the docs cache
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any component fails or is capped
```

Without a browser, `map` can't see the stories' argTypes, so it reads them, and the props snap left out, from the snap in `--snap`, and says when it can't. The push doesn't need `map`: snap's output carries the same variant properties. See [Props and variants](#props-and-variants).

### `storysync inspect`

Shows one component's props, how each maps to Figma, why a prop was skipped, and each variant property's default. A default the docs don't give is marked as assumed.

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --component <name>     Component name, title or ID to inspect (required);
                         a name that matches nothing, or several, is an error
  --connect-timeout <ms> How long to wait to connect to Storybook MCP (default: 60000)
  --request-timeout <ms> How long each request may take once connected (default: 300000)
  --exclude-props, --keep-props, --snap, --no-snap, --no-cache
                         As map takes them
```

### `storysync snap`

Renders each component variant in a headless browser and records its computed styles, and those of every element inside it that draws. See [How snap measures](#how-snap-measures).

```text
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --connect-timeout <ms> How long to wait to connect to Storybook MCP (default: 60000)
  --request-timeout <ms> How long each request may take once connected (default: 300000)
  --components <names>   Comma-separated component names, titles or IDs (default: all);
                         a name that matches nothing is an error
  --out <dir>            Output directory (default: ".storysync/snaps")
  --variants <mode>      representative (default) or all
  --max-combinations <n> With --variants all, most combinations per component before
                         capping (default: 256)
  --exclude-props <names>
                         Comma-separated prop names never to make variant properties,
                         in any component; the story's own args set them
  --keep-props <names>   Comma-separated prop names never to leave out on their own
  --no-cache             Read every component's docs from Storybook, not the docs cache
  --screenshots          Also save a PNG per variant (off by default)
  --timeout <ms>         Per-story timeout (default: 10000); a story that times out loading is tried
                         once more
  --selector <css>       Measure the element this matches instead of choosing one
  --merge                With --components, measure only those and merge them into the styles.json
                         in --out, keeping the rest, and refuse when there is none; --components
                         alone merges the same way where --out holds a snap
  --no-merge             With --components, write only the components it names to --out, dropping
                         the rest of the snap there
  --root-only            Measure each variant's outer element alone, without its element tree, as
                         0.3.0 did: for a push through the skill's root-only templates
  --no-channel-args      Don't set the values Storybook won't take from the story's URL through its
                         preview: leave those variants unmeasured, as arg_rejected (args_unsupported
                         for a value no URL can carry)
  --no-open-overlays     Measure an overlay's closed trigger as the story renders it, rather than
                         opening the overlay and measuring its content
  --stories <pairs>      Comma-separated component=storyId pairs, each component by its ID or title
                         and each story by its ID: the component's story, in place of the one snap
                         picks, which measures every variant no other story's own args are for, or
                         every variant where the story ends in ! (ui-base-toggle=ui-base-toggle--default!);
                         a pair for a component the run doesn't measure is checked and left out (also
                         given more than once)
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any variant or component could not be measured, none were,
                         a variant's args could not be checked, or a component was capped
  --strict-warnings      Implies --strict, and also fails on warnings
```

snap writes `<out>/styles.json` and `<out>/meta.json`. `--screenshots` also saves PNGs under `<out>/<component>/`. A variant slug too long for a file name gets a shortened, hashed screenshot name.

### `storysync figma`

Writes every `use_figma` call a push makes, as files your AI client sends to Figma unchanged. See [How the build works](#how-the-build-works).

```text
storysync figma code [options]
  --snap <path>          Snap output, with element trees (default: ".storysync/snaps/styles.json")
  --tokens <path>        `storysync tokens --json` output, for binding paints and radii to variables;
                         without it nothing is bound (default: ".storysync/tokens.json")
  --components <names>   Comma-separated component names, titles or IDs to build (default: every
                         component in the snap); a name that matches nothing is an error
  --skip <names>         Comma-separated component names, titles or IDs to leave out
  --out <dir>            Where plan.json, calls/ and results/ go; an earlier plan Figma answered a
                         read of moves to earlier/ there with its calls and results, and any other's
                         are removed (default: ".storysync/figma")
  --max-chars <n>        Most characters of code in one build call (default: 45000)
  --max-nodes <n>        Most layers one build call creates or restyles (default: 400)
  --read-limit <n>       Most characters a read call is predicted to return (default: 17000)
  --no-minify            Send the templates' readable sources instead of their minified build
  --json                 Output JSON instead of formatted text

storysync figma upload --plan <path> --seq <n> [--json]
storysync figma next --plan <path> --seq <n> [--json]
storysync figma tokens [--tokens <path>] [--plan <path>] [--alpha <name>]... [--out <dir>] [--remove <Collection/name>]... [--max-variables <n>] [--no-minify] [--json]
```

`figma tokens` defaults to `--tokens .storysync/tokens.json`, `--plan .storysync/figma/plan.json`, `--out .storysync/figma/tokens` and `--max-variables 40`.

`figma code` writes `<out>/plan.json` and the calls under `<out>/calls/`, in the order they're sent: a `variables` call that makes the alpha variables its translucent paints bind to, where they bind any; the builds, a page at a time, with several component sets in a call; an `images` call for each page that shows a picture; one `label` call; and the read calls. `plan.json` lists each call with its file, its description and the path its response is saved to under `<out>/results/`. Two runs on the same snap write the same bytes. It refuses a snap taken with `--root-only`.

An earlier plan in `<out>` that Figma answered a read call of, the last push's, is moved with its calls and results to `<out>/earlier/<digest>/`, and its path printed (`earlier` in `--json`): the snap keeps that push's components, so `verify --plan <out>/earlier/<digest>/plan.json` still scores it. Any other plan's calls and results are removed, so a response saved for one can't be read as the new plan's.

It prints each call, its warnings, the alpha variables its translucent paints bind to, which its first call makes (see [Variable binding](#variable-binding)), and the push's [estimate](https://github.com/brendanciccone/storysync/blob/main/README.md#what-a-push-costs):

```text
Estimate: 22 use_figma calls send 274,800 characters of code and read back about 180,000. Plan on about 510k-980k agent tokens for this push of 5 components, setup and verification included (the rule of thumb, 100k a component plus 100k a push, gives 600k).
```

`figma upload` posts the pictures a build call left for `upload_assets`. `figma next` writes the call that reads the rest of a read call that stopped short of `use_figma`'s response limit.

`figma tokens` writes a `use_figma` call per token collection (Colors, Spacing, Radius, Typography) under `<out>/calls/`, listed in `<out>/plan.json`. Each call finds its collection and variables by name, adds a Dark mode where the tokens have a dark theme, sets values and scopes, and writes only what differs, so pushing twice changes nothing. A response lists `stale` variables (in the collection but not in the tokens) and `conflicts`. None is removed unless `--remove` names it after you confirm. Shadows, colors it can't convert and em or % lengths are left out, and it prints why.

An alpha variable is a color token at an alpha, beside the token: `destructive 10%` holds `destructive`'s light color at 10% in Light and its dark color at 10% in Dark, with its scopes, and `destructive 10% dark 20%` its light color at 10% and its dark color at 20%. A plan's first call makes those its builds bind. `figma tokens` also makes those of the plan at `--plan`, an earlier push's, and those `--alpha` names, as a root-only push binds them by hand (`--alpha "destructive 30%"`, repeated for each). A response lists the alpha variables it keeps in `alpha`, and keeps every one of its tokens up to date with them. One whose token is gone is stale. Figma takes no period in a variable name, so an alpha of no whole percent has a comma: `ring 12,5%`. A per-mode variable holds one color in Light and another in Dark, for a paint whose `dark:` class names another color: `background dark input 30%` is `background` in Light and `input`'s dark color at 30% in Dark, `input 0% dark 30%` is clear in Light, and `slate-50 dark slate-900` holds two Tailwind palette colors, whose values `figma code` reads from the project's own Tailwind (`node_modules/tailwindcss`, its `theme.css` or `colors.js`) and writes into the call. The color Dark takes is written as a class names it, `foreground 60% dark muted-foreground` for `muted/foreground`, since Figma groups a variable at each `/` of its name; the token's own name keeps its slashes, which put the variable beside it. An alpha variable a plan made that no layer binds, as one made for a build that then failed, is removed with `--remove "Colors/destructive 90%"` once the user confirms it, and isn't made again.

### `storysync verify`

Scores what was written to Figma against what `snap` measured. During a push, the agent sends the read calls `figma code` wrote and saves each response, and `verify --plan` reads those responses, assembles them into `.storysync/figma-readback.json` for committing and CI, and compares that with the snap. See [How verify scores](#how-verify-scores). `verify --plan` scores only the components the plan built, so the components a snap keeps from other pushes aren't missing from Figma, and says the snap changed since the plan only where it measured one of those components again: the plan records a digest of each. The snap's age, which `--max-age` and `--strict-age` hold it to, is that of the oldest of those components too, not of the oldest component the snap keeps.

```text
Options:
  --snap <path>          Path to snap output; with --plan, the snap the plan was made from
                         (default: ".storysync/snaps/styles.json")
  --readback <path>      Path to the properties read back from Figma; with --plan, where to write the
                         readback assembled from its results (without this, figma-readback.json beside
                         the plan's directory) (default: ".storysync/figma-readback.json")
  --plan <path>          Read back from the responses a push saved for the calls in this plan.json
                         (storysync figma code): assemble them into --readback, then score it
  --tolerance <px>       Allowed difference for lengths, in pixels (default: "0.5")
  --max-age <duration>   Warn when the snap is older than this (e.g. 30m, 2h, 7d) (default: "2h")
  --skip <names>         Comma-separated component names, titles or IDs to leave out of the score,
                         such as ones not pushed; the output names them
  --roots-only           Score each variant by its outer element alone, as 0.3.0 did, for comparison
                         with an element-tree score
  --min-fidelity <pct>   Exit with code 1 when the score is below this percentage: element fidelity
                         where snap measured element trees, else the share of properties; a run that
                         scored nothing fails it too
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any variant or element drifted or is missing from Figma,
                         a keyed layer is in Figma that snap no longer measures, a variant reported
                         nothing comparable or was read back without its element tree, a readback
                         entry is not what Figma returned, is incomplete or was read before the snap,
                         a text's layout snap measured wasn't read back, a planned read call wasn't
                         read whole or was read before a build of its components was sent again, a
                         variant was built from an earlier measurement than a snap other than the
                         plan's, a layer a designer added is inside a variant, or the snap recorded a
                         component failure or lacks a component the readback has
  --allow-designer-layers
                         With --strict, pass the layers a designer added inside variants, which verify
                         still lists
  --strict-age           Implies --strict, and also fails when the snap is older than --max-age
  --strict-measured      Implies --strict, and also fails on anything not measured: variants inferred
                         from source or with no recorded provenance, placeholders for variants snap
                         couldn't measure, variants measured without snap checking Storybook gave them
                         their values, and variants in Figma that snap never measured or no read covered
```

`--strict-measured` is the one to use in CI. `--min-fidelity` fails a score below the percentage, with or without `--strict`; with `--json`, `minFidelity` gives the minimum and the score, both from 0 to 1, and whether it passed.

### `storysync diff`

Compares a Figma file against your code's tokens and, with `--storybook`, your Storybook components.

It needs a Figma MCP endpoint that works without browser sign-in, usually a local proxy from a supported MCP client. Figma's remote server, `https://mcp.figma.com/mcp`, needs OAuth, so against it `diff` fails with `401` or `403`. Use the skill's audit instead, which runs inside a client that's already signed in.

```text
Options:
  --figma <url>          Figma MCP server URL (required)
  --file-key <key>       Figma file key (required)
  --storybook <url>      Storybook URL (enables component diff)
  --connect-timeout <ms> How long to wait to connect to Figma MCP, and Storybook MCP
                         (default: 60000)
  --request-timeout <ms> How long each request to either may take once connected
                         (default: 300000)
  --project <path>       Project root to scan for tokens (default: ".")
  --source <type>        Token source: tailwind, css, or theme (auto-detect if omitted
                         or auto); any other value is an error
  --mode <name>          Figma variable mode to read, alone (default: every mode, the first
                         compared with the light theme and one named Dark with the dark theme)
  --components <names>   Comma-separated component names, titles or IDs to diff, with --storybook
                         (default: all); a name in neither Storybook nor Figma is an error
                         when both were read
  --exclude-props <names>
                         Comma-separated prop names to leave out of every component, besides
                         those the snap records the push left out
  --keep-props <names>   Comma-separated prop names never to leave out on their own
  --snap <dir>           Snap whose recorded argTypes and left-out props to use
                         (default: ".storysync/snaps"); --no-snap uses none
  --no-cache             Read every component's docs from Storybook, not the docs cache
  --json                 Output JSON instead of formatted text
  --strict               Exit with code 1 if any differences found or a Figma or Storybook read fails
```

```bash
# Diff tokens only
npx storysync diff --figma <endpoint> --file-key abc123

# Diff tokens and components
npx storysync diff --figma <endpoint> --file-key abc123 --storybook http://localhost:6006
```

**Tokens.** Figma collections map to categories by name (`Colors` to colors, `Border Radius` to radius). A collection's first mode is compared with the light theme, and a mode named Dark with the dark theme; `--mode <name>` reads one mode alone. Aliases are resolved up to 8 levels deep, with cycle detection. A color is compared by its `hex`, a length by its `px`, with `calc()` worked out, and numbers are rounded to thousandths on both sides.

**Components** are paired in this order:

1. **By the Storybook ID** the push stored on a set or component, wherever it was moved or however it was renamed. One whose ID code doesn't have is reported as `figma_only`.
2. **By name and page.** A set without an ID is matched by its lowercased name, the last segment of the component's Storybook title, so `Button/Primary` in Figma won't match `ButtonPrimary` in code. A name two components share, like `ui/base/Button` and `ui/radix/Button`, is matched by page, as the push lays it out. Of the copies left, extra sets are `figma_only` and extra components `code_only`. Copies left on both sides can't be told apart, so they're reported as `ambiguous` and fail `--strict`. A set an earlier push named by a component's `name`, such as `TooltipContent` for `ui/base/Tooltip`, still matches until a set of the new name exists, unless that name is another component's set name.
3. **Components outside any set** are read too, since the push makes a component with no variant properties a plain component. One with no stored ID is matched only on its component's category page, so an icon named `Calendar` isn't taken for a `Calendar` component.

More about `diff`:

- `--components` narrows both sides. Each selected component is paired as in a full run, and a set is reported only if it's paired with one or `--components` names it. A name only Figma has is reported as not in code. It needs `--storybook`.
- If Storybook can't be listed or a component can't be mapped, the run is reported as partial (`storybookReadFailed` or `mappingFailures` in `--json`) and fails `--strict`. A partial run never ends with "No differences found".
- `diff` reads every page of the Figma file, up to 17,000 bytes per call. Each call counts toward [Figma's MCP rate limits](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/), so a large file can hit them. A refused call makes the run partial (`figmaReadFailed`); run it again later. A component too big for one call fails the read and is named.
- A set Figma flags as errored, which throws `Component set has existing errors` when its properties are read, is reported as `errored` with its page and node id, and fails `--strict`. The rest of its page is still compared.
- `--json` gives each component entry's `id` and `page`, and each mapping failure's `id` and `title`.

## How snap measures

### What it measures

snap renders each variant and records the variant's outer element and every element inside it that draws: frames, text with the line boxes the browser drew, pseudo-elements that paint, SVG icons, pictures and the values of inputs.

- Each element gets a **key** from its place in the component, such as `card-header/card-title`, so `figma code` builds it as its own layer and `verify` scores it on its own.
- `styles.json` holds full styles for a base variant and, for each other variant, only what differs, an element a line. A change to one element is one changed line in a diff. It has no timestamp, so you can commit and diff it.
- Icons are kept as their SVG, and pictures as thumbnails under `<out>/assets/`, named by their content, which the push uploads to Figma.
- Trees make `styles.json` larger, by tens of kilobytes on a large library.

`--root-only` measures the outer element alone, as 0.3.0 did, and records each variant's `innerElements`, how many elements it left out. `figma code` refuses such a snap: the skill pushes it with its root-only templates. `--merge` refuses to mix a snap of trees with a root-only one.

### Which variants

`--variants representative`, the default, measures each value once against the other props' defaults, so a `3 × 2 × 2` button takes 5 renders instead of 12. A Figma component set needs every combination, so the push uses `--variants all`.

**Combination cap.** Above `--max-combinations` (default 256), snap measures a subset that covers every value, records a `cap`, warns, and fails `--strict`. If the limit is too low to cover every value, the warning names the ones left out. The skill has the agent stop and ask whether to build the subset, raise the limit, or narrow the variant props with `--exclude-props`.

### Which story

snap measures each component from one of its stories: its Default story, or else its first. A variant can need another. shadcn/ui Button's Icon story sets `size=icon` and puts an icon in the button in place of its label, which would otherwise spill out of the icon size's square.

So where a story's own args set some of a variant's values and give it something of its own to draw (other args, such as `children`, or its own `render` or decorators), snap measures those variants from that story: Button's `size=icon` from Icon, and `size=icon-sm` from Icon Small.

- A value that a story drawing nothing of its own also sets doesn't count. Icon also sets `variant=secondary`, as the Secondary story does, so it isn't the story for every secondary button.
- A story that only adds to another's args doesn't count either. shadcn/ui Toggle's WithText is its Outline story with a label added, so Outline is the story for `variant=outline`.
- Where several stories fit, the one that sets the most of the variant's values wins, then the plainest, the one that sets the least of its own, then the first.
- A story with a play function is never picked.
- Where no story sets a variant's values and the component's story draws it past its box, as Default's label does Button's `size=icon-xs` square, snap measures it from a story for another value of the same property, Icon for `size=icon`, if that draws it within its box, and records why as the variant's `refit`.

snap records each variant measured from another story as the variant's `storyId`, and says which in its output and beside `verify`'s score.

**Naming the story yourself.** `--stories ui-base-button=ui-base-button--with-icon` makes the story you name the component's story, by the component's ID or title. Every variant no other story fits is measured from it, and it's recorded as the component's `storyId`, while Button's icon sizes still come from its Icon stories. snap refuses a story that isn't the component's, or a name no component has, before measuring anything. A pair for a component the run doesn't measure is checked the same way and left out, so a push can pass the same pairs to every snap it takes.

To measure every variant from the story you name, with no story picked for any variant, end it with `!`: `--stories 'ui-base-toggle=ui-base-toggle--default!'`. snap then records `storyOnly: true` on the component. Use it when snap picks a story for some variants that you don't want them measured from.

**Content past its box.** snap warns when a variant's content draws past its own box, by how much, as a label too long for a button sized for an icon does, since Figma shows it spilling out. It names the values those variants share, such as `size=icon-xs`, and the story they were measured from, and says what would fix it: a story whose own args set those values and give them content that fits, `--stories` naming another story, or, for variants from a story snap picked, that story given content that fits, or `!`. What the component clips, what is positioned absolutely, transformed or hidden, shadows and focus rings don't count, and text counts as tall as its lines, not its font's full height.

### Which element

In each story, snap measures, in order:

1. The first element carrying the component's own `data-slot` (`switch` for `Switch`, `input-otp` for `InputOTP`), as shadcn/ui puts on every component's root.
2. Open overlay content in a portal, when the story's root shows nothing that draws, or only a closed trigger: an element with the role `dialog`, `alertdialog`, `tooltip` or `menu`, a `-content` slot, or what Radix's popper places.
3. The story's first element that draws, past wrappers that draw nothing and hold one element, and skipping `<noscript>`, `<style>` and `<script>`.

`--selector <css>` measures the element it matches instead. Each measured variant records the element as `element`, like `span[data-slot="switch"]`, and `portal: true` when it was measured in a portal outside the story's root.

snap warns when that element is likely not the component:

- **A layout wrapper:** an element holding several others and drawing nothing itself, such as a story's `<div className="flex gap-2"><Switch /><Label /></div>`. An element with a `role`, `dir`, `data-orientation`, `aria-label` or `aria-labelledby`, or a list, form, fieldset, nav or table, is taken for a component's root instead.
- **A closed trigger:** an overlay snap couldn't open, saying why.

An element placed against the browser window (`position: fixed`), or against the page (`position: absolute` with nothing positioned around it), is drawn where the window puts it, not where the component does: shadcn's Sidebar at `side="right"` draws at the window's right edge, far from its own root. An element in the component with a transform, a translate, a filter or containment holds such an element in place, and snap leaves it there. Otherwise snap measures it moved inside the root's box, as far as it takes, and lists it in the variant's `movedInside`. There is nothing in the story to fix, so this is not a warning.

### Overlays are measured open

When a story renders only an overlay's closed trigger, as a Dialog's, Popover's, Sheet's, DropdownMenu's, Select's, HoverCard's or Tooltip's Default story does, snap opens the overlay before it measures:

1. It sets the story's `open` arg, or `defaultOpen`, to true through Storybook's preview, where the component takes one.
2. Otherwise it clicks the trigger, hovers over it for a tooltip or hover card, focuses it, or right-clicks it for a context menu, trying the other ways if that opens nothing and waiting up to 3 seconds for each (less when `--timeout` is shorter). Later variants of the same story try only the way that opened an earlier one.
3. Unless hovering opened it, it moves the pointer off the page, so nothing in it is measured hovered. It waits for the overlay's animations to end and its boxes to stay put, measures its content, and closes it again.

Each such variant records how in `opened`, like `{"via": "click", "trigger": "button[data-slot=\"dialog-trigger\"]"}`, and snap's output says so on an `i` line. A select's field that opens nothing is measured as the field, which is the component while it is closed, and snap warns where other variants of it opened. A variant that sets `open` to false is measured closed. `--no-open-overlays` measures closed triggers as they render.

Where snap can't open an overlay, it warns that it measured the closed trigger and why. The push then asks whether to build the trigger, skip it, or stop so you can fix the story. A trigger built anyway says so on a `storysync:` line of its Figma description, and a skipped one is left out of the score with `verify --skip`.

### How variant values reach the story

snap sets variant values through Storybook's `?args=` URL. After each story renders, it reads the args Storybook gave it from the preview (`window.__STORYBOOK_PREVIEW__`, which Storybook has had since version 7). When a value is missing, snap sets it through the preview, as the Controls panel does, and measures what the component renders with it:

- **Characters a URL can't carry.** Storybook accepts only `[a-zA-Z0-9 _-]` in URL args, so a value like `Nav/Primary` is set through the preview without a warning. If the preview won't take it either, the variant is marked `args_unsupported` and not measured.
- **Values the story's argTypes reject.** Storybook drops a URL value that the argTypes `options` don't list, or that an argTypes `if` hides for that combination. shadcn/ui's Badge story lists four of its six variants, for example. The variant records the values as `rejectedArgs`, with `appliedVia: "preview"`, and snap warns with the story change that would let the URL take them.
- **Numbers.** Storybook's URL reads a value like `2` as a number, so when the options list it only as the string `"2"`, snap sets it through the preview without a warning, typed as the options list it.
- **A value the preview won't apply** marks the variant `arg_rejected`, not measured, so `--strict` fails and `verify` names it under the score.
- **When snap can't read the preview** for a variant, it can't tell whether the story took its values. It measures the variant, marks it `argsChecked: false` and warns. `--strict` fails on it, and `verify` fails it under `--strict-measured`.

`--no-channel-args` turns preview-setting off: such a variant is marked `arg_rejected` and not measured, and `meta.json` records `"channelArgs": false`.

snap warns when all of a component's variants measure the same, or all of one prop's values do. When every variant measures the same, it also compares the markup each one rendered. The same markup means the story likely drops its args. Markup that changed with them means the args reach the component and its props change only what snap doesn't measure, such as behavior. Either way snap leaves those props out (see [Props and variants](#props-and-variants)) unless `--keep-props` keeps them, and then warns.

**Variant names ignore case and punctuation**, so `Small` and `small` would get the same name. snap numbers the duplicate (`size-small--2`) and warns. Renaming the values is the real fix.

### What snap records

- **Colors** as sRGB hex (`#rrggbbaa` when translucent), whatever space Chromium reports them in (`oklch`, `oklab`, `lab`, `color()` and so on).
- **Gradients and background images** as `backgroundImage`, with colors as hex.
- **Background clip** as `backgroundClip` when it isn't `border-box`, such as `padding-box` for Tailwind's `bg-clip-padding`, which decides whether the fill shows under a transparent border.
- **Corner radii** as drawn, so `rounded-full` on a 32px-tall pill is 16, not `3.35544e+07px`. Percentages and `calc()` are resolved. Figma has no elliptical corners, so those keep the smaller radius.
- **Shadows** without the empty `0 0 #0000` layers Tailwind adds, so each recorded layer is a real Figma effect.
- **Text** with its `textTransform`, `letterSpacing`, and any opacity above it folded into its color. Where the browser wrapped the text or cut it off, `text.layout` records the width it was laid out in, the lines it drew, and whether it ends in an ellipsis.
- **Images** once loaded. snap waits up to 5 seconds for images still loading, such as an avatar's photo.
- **argTypes**: each story's argTypes as `argTypes`, with each arg's type, control, options, `if`, table marks and the story's own value, and the choices a story declares that Storybook's docs don't, such as Button's `disabled`, as `argsNotInDocs`, and the stories' own args as `storyArgs`. It records each prop it left out, and why, as `excludedProps`.

### Fonts

snap records the family the browser drew with. A named font that failed to load is recorded as asked, with `fontAvailable: false` and a warning. Another platform's font listed after a system keyword, like `SFMono-Regular`, gets no warning.

Figma names a family fontsource names `<Family> Variable` without the suffix, so the build sets `Geist Variable` in Figma's `Geist`, and `verify` takes the one for the other. Figma has no font for a CSS keyword like `system-ui`, or for a platform's own font like Menlo or Segoe UI. So it sets that text in a stand-in: Inter, Roboto Mono for a monospace font, or Noto Serif for a serif. Those fonts are a few percent wider than a Mac's, enough to wrap a label in Figma that fit in the browser. So snap draws such text in the font Figma will use, from font files that come with Storysync, before it measures it:

- Figma rounds each letter's width a little, so Storysync's copies of Inter, Roboto Mono and Noto Serif are rounded the same way. A label sets as wide in the browser as in Figma, to within a fraction of a pixel.
- Its Inter has Inter's arrows, check marks and other symbols, so "Next →" isn't measured in another font.
- Figma keeps a line whole only in a box at least as wide as the text, so snap rounds the width of anything that holds text up to the next hundredth of a pixel, never down.
- A system stack like Tailwind's `-apple-system, BlinkMacSystemFont, ...` is recorded as `Inter`, with the family the code asked for, `system-ui`, beside it, and snap says once a run which fonts it drew this way.

A font your project loads itself, such as Geist or Inter, is measured as it is. Figma needs that font installed to draw it. See [What Figma can't do](https://github.com/brendanciccone/storysync/blob/main/README.md#what-figma-cant-do).

**Take the snaps you compare on one platform.** Text is drawn a little wider or narrower from one operating system and browser build to the next, and the boxes after it move with it, so two machines' snaps of the same code can differ by fractions of a pixel. `meta.json` records the `platform` and `browser` a snap was taken with. Commit snaps taken in one place, such as CI.

### Running snap

**Measuring some components again.** `--components` replaces those components in the `styles.json` already in `--out` and keeps the rest, so a push of some components keeps the record of every component an earlier push measured, which `map`, `diff` and `verify --plan` read. A kept component Storybook no longer lists is dropped, since its code is gone: snap names it in its progress, and in `removedComponents` with `--json`. Where `--out` holds no snap it writes those alone, and `--no-merge` writes them alone over one. `--merge` does the same, but refuses where there is no snap to add to. A merge measures a component again from the story the snap measured it from, with its `!` where it had one, unless `--stories` names another. It refuses, before measuring anything, a snap it can't add to: one with no `meta.json`, or one taken by another Storysync version, with other `--variants`, `--exclude-props` or `--keep-props`, or from another Storybook. `meta.json` then records when each component was measured, in `componentsMeasuredAt`, and its `measuredAt` is the oldest of them, so `verify` judges the snap by its oldest part.

**Timeouts and failures.** Only a story that timed out while loading is tried again. A story that throws after it loads is reported as `render_error`. A story that never renders costs one `--timeout`, and the error says nothing that draws rendered under `#storybook-root` or `#root`. A screenshot waits no longer than `--timeout`, and with `--screenshots` an element with no width or height is measured without a screenshot.

**Stopping.** If snap stops before it finishes, it writes nothing: `styles.json`, `meta.json` and the screenshots stay as the last run left them, and it says so on stderr. It exits 130 after Ctrl-C, 143 after SIGTERM (a canceled job or a command timeout) and 129 after SIGHUP. If the browser crashes or is closed, snap launches it once more and measures the component it was on again. If it goes a second time, snap writes nothing and exits 1, with the reason as its error (`{"error": ...}` on stdout under `--json`).

**Strict modes.** `--strict` fails on anything that couldn't be measured, on a variant whose args snap couldn't check, on a capped component, and on a run that measured nothing. `--strict-warnings` also fails on warnings, such as a story that ignores its args, a closed trigger, a layout wrapper, or a prop whose values all measure the same. It's usually what you want in CI.

**Browser.** snap needs Node 20 or later (for Playwright) and a Chromium-based browser. It looks for `STORYSYNC_BROWSER_PATH` or `CHROME_PATH`, then Chrome, Edge, a Playwright download, and common system paths. If it finds none, the error lists what it tried and the command to install one:

```bash
npx playwright@<version> install chromium     # note: the full `playwright` package
```

Use the version the error prints. Other Playwright versions install a browser that Storysync's `playwright-core` can't launch.

## How the build works

`figma code` writes every `use_figma` call. No styling code is written by hand: each call is a template that ships with Storysync, minified, after a constant holding exactly the measurements that call needs.

### Pages and sets

- Each component's set goes on the page of its Storybook category, the whole of it (`ui/base`), or on a `Components` page for a component without one. A page is found ignoring case, spaces, `/`, `-` and `_`, so a page an earlier push named `UI Base` is still the page for `ui/base`.
- A set is named by the last segment of the component's title, or by its `name` when it has none, so `ui/base/Button` and `ui/radix/Button` stay two sets.
- A set an earlier push made is found by its name, or by the Storybook ID stored on it, and restyled in place. A new set goes below everything on its page.
- A component with no variant properties is one plain component, not a set.
- Each set is laid out as a grid in snap's order, the first property's values as rows, with each property's first value top left. Figma takes the default variant from there, so it's the component's own default.
- The `label` call writes a `storysync:` line on the description of a set measured from a closed trigger or a layout wrapper, keeping every other line, and removes Figma's default `Page 1` while it is empty.

### Layers

- Each element snap measured becomes a layer that carries its key. On the next push the layer is found by that key and restyled, so node ids, and the instances built on them, survive. A layer a designer added without a key is left alone.
- Frames get auto layout where a model of Figma's auto layout puts every child where the browser did, and the build checks it again in Figma. Elsewhere, such as a flex row that wraps, children are placed at their measured positions, and `figma code` says which frames.
- Text gets its family, weight, size, line height, letter spacing, case and color, and fits its box as the browser fitted it: on one line, wrapped at its width, or cut off with an ellipsis. A font Figma lacks is drawn in a stand-in at the measured weight, which the build's response names. Text the browser drew whole on one line stays on one line: where Figma sets it wider than snap measured it, as for a snap taken before snap drew stand-ins, the build gives it Figma's own width and lists it in the response's `fallbacks`.
- A transparent or translucent border is filled as the browser fills it: an `INSIDE` stroke the fill runs under, or, with `bg-clip-padding`, an `OUTSIDE` stroke the fill stops at.
- Where a component clips its background inside a fully transparent border, as shadcn/ui Button's `border-transparent bg-clip-padding` does, the frame is built at the border box with its corner radius bound to its token. The fill runs 1px under the clear stroke: `figma code` warns about it and `verify` lists it under coverage.
- A translucent, dashed or partly transparent border over a padding-box background is still built `OUTSIDE` at the padding box, at the inner radius. That radius is left unbound, with a warning.
- Icons are imported from their SVG at their measured size. An icon whose shapes were recolored or changed in Figma is imported again, under a new node id, since the build sets an icon's shapes only by importing them.
- A variant snap couldn't measure is built as a placeholder, a dashed frame labeled `Not measured: <status>`, never styled from the component's source, every variant of a component snap measured none of. `verify` lists each, with its status and error, and names each component with variants not measured.
- What Figma can't draw is left out and named in `figma code`'s warnings, never approximated silently, and `verify` lists it under coverage. What it draws another way is named as `built as`: borders with a different color on each side as one color, and scaling as the element's own box.
- A turn is built as the element's own box, unturned, in an auto layout's flow, which Figma lays out by its turned box, unless it is 180 degrees, or 90 on a square, where that box is its own. So is a turn of a layer with children, or inside a turned or scaled layer. Any other turn of a childless layer, such as a tooltip's arrow or a chevron turned 180, is built turned and scored.

### Variable binding

Colors and corner radii are bound to the variables `tokens` names. A measured value matches a token when it equals the token's `hex` for a color, or its `px` for a radius. A translucent color matches a token of its `#rrggbb` and binds to that token's alpha variable, as Tailwind's `border-destructive/30` is the `destructive` token at 30%, bound to `destructive 30%`. Where a `dark:` class paints the token at another alpha, as shadcn/ui's destructive button's `bg-destructive/10 dark:bg-destructive/20` does, it binds to one that holds each theme's, `destructive 10% dark 20%`. snap keeps a `dark:` class's opacity for this; a snap taken with an earlier version doesn't, and binds `destructive 10%`. Where the `dark:` class names another color, as shadcn/ui's outline button's `bg-background dark:bg-input/30` does, the paint binds to a per-mode variable of the two, `background dark input 30%`, so Dark shows the dark theme's color; a fill only the dark theme paints, an input's `dark:bg-input/30`, is built clear in Light and bound to `input 0% dark 30%`; and a pair of palette colors no token names, AspectRatio's `bg-slate-50 dark:bg-slate-900`, binds to `slate-50 dark slate-900`, its values from the project's Tailwind.

Several tokens often share a value: on shadcn/ui, `#171717` is five color tokens. Then the classes snap recorded on the element pick the one the source names: `bg-primary` binds the fill to `primary`, and `rounded-lg` the radius to `lg`. Where the classes name two, as an outline button's `border-border dark:border-input` does, the one the `dark:` class names binds: it has the light value too, and is the token the dark theme paints. A class that styles another box isn't the element's: shadcn/ui's alert title's `[&_a]:hover:text-foreground` colors its links, so the title binds to the `text-card-foreground` it inherits, and Avatar's `after:border-border` is its `::after` ring's, which binds to `border`. A `dark:` class with a state is the dark theme's paint only where its state applies, as Tailwind puts it after the plain `dark:` one. snap records which states apply, read from the page's own style sheets, which say what a variant means (shadcn/ui's `data-active` is `[data-state="active"]` too), so Tabs' active trigger, with `dark:data-active:text-foreground` over `dark:text-muted-foreground`, binds to `foreground`, and an inactive one to `foreground 60% dark muted-foreground`. Where snap can't tell whether a state applies, as for a class whose rule it can't read (another origin's style sheet, or nested CSS), it keeps the class as written, and the paint binds to its token.

Where no class names one, the project's base styles can, as `tokens` reads them into `defaults`: shadcn/ui's dialog title has no color class and inherits `body`'s `text-foreground` from `@layer base`, so it binds to `foreground`, and a card's border takes `* { @apply border-border }`, so it binds to `border`. `figma code` prints each such binding with its rule. A base style counts only where snap found no class sets the color at all: a palette or arbitrary color such as `text-neutral-950` names no variable, and keeps the value unbound. Where neither names one, the value is left unbound and `figma code` warns with the variables it matches. Values are matched by the tokens' values in the color scheme snap measured the component in, its `scheme` in styles.json: the light theme's, or, where the preview rendered dark, the dark theme's, so coder's dark `#ffffff` text binds to `content/primary`, whose dark value it is, never to `surface/primary`, whose light value it happens to be. `figma code` warns for each component measured dark, and the label call puts its set in each collection's Dark mode, unless a designer chose a mode for it, so the paints show as measured, and takes it back off that Dark mode once a push measures it light, unless a designer has changed the mode since; Light shows each token's light value. A translucent paint measured dark keeps its dark alpha in Light too, since snap keeps no light class's opacity.

Wherever a designer switches a frame, or a frame around it, to the Dark mode, Figma resolves each bound paint again to its variable's Dark value: its color, and its alpha as the paint's opacity, and a bound shadow's color and alpha alike. Bound to `destructive` at 10%, a `bg-destructive/10` fill turns opaque at the first switch to Dark and stays so back in Light. So a translucent paint binds to an alpha variable, which holds the alpha in both modes, and the plan's first call makes each one the plan binds. A build that finds none, as one sent before that call, binds the token at the paint's opacity, as earlier versions did, lists it in its `fallbacks` as `no alpha variable …`, and `verify --plan` prints each under the score and fails `--strict`. `verify --plan` also lists each alpha variable the plan's first call made only for components whose build calls saved no build result, as `unusedAlphas` in `--json`: no layer binds it, so send those builds again, or remove it with `figma tokens --remove` once the user confirms. A push sent again into a set a designer left in Dark binds every paint afresh, so it shows the Dark values a switch would, and builds the variants it adds inside the set.

A shadow's color binds only where a `ring-*` or `shadow-*` class names its token, as shadcn/ui's dialog's `ring-foreground/10` binds to `foreground 10%`. Tailwind's default shadow scale draws in a black no token was set from, so its shadows stay unbound.

A frame built at its padding box inside a translucent, dashed or partly transparent border is drawn at the inner radius, which no token holds, so that radius is left unbound and `figma code` says why.

### Pictures

`use_figma` can't create an image, so a build call lists the image layers it left empty in its response's `uploads`. The agent calls Figma's `upload_assets` for that many upload URLs, with those layers as targets, and saves its response as the call's `results/NN.upload.json`. `figma upload --plan .storysync/figma/plan.json --seq NN` then posts each thumbnail snap saved to its URL, with its own content type. That is the one request Storysync sends to Figma itself. The `images` call puts each picture on the other layers that show it, and a later push reuses a picture already in the file.

### Reads

A read call reads back every layer of the variants it covers. It carries only the page, which variants to read and a size limit, and finds each set by the Storybook ID stored on it. Each entry is sealed with a checksum computed in Figma. A read that would pass `use_figma`'s 20kb response limit stops and says where, in `more`. `figma next --plan ... --seq NN` writes the call that reads the rest (`NNb`, then `NNc`), and prints where to save its response.

### Sending calls safely

- Every call can be sent again, and changes only what differs.
- A build call that throws removes the variants it had added to that set, so none is left loose on the page.
- Each call carries a checksum of its data, `SUM`, and one of its template, `TSUM`, and checks both before it changes or reads anything. A call that reached Figma with a character changed, as one pasted by hand can, is refused with `This call differs from the file storysync figma code wrote`, or `figma tokens wrote` for a token call, or `figma next wrote` for a read's continuation, and changes nothing. Send the file again exactly as it is.
- `use_figma` takes at most 50,000 characters of code a call, so each build call stays under `--max-chars`.
- A call that runs too long fails with `Script exceeded time limit`. Run `figma code` again with `--max-nodes 200`.
- `upload_assets` gives at most 60 URLs a call, so a build call lists at most 60 uploads.

## How verify scores

### Element fidelity

With a snap of element trees, `verify` scores every element snap measured, by its key. Each element scores the share of its properties that Figma matches:

- **A frame:** its place and size, fills, strokes, corner radii, shadows, opacity, blend mode and clipping.
- **A text:** its characters, font, size, weight, line height, letter spacing, color, case, alignment, how it fits its box, and whether Figma cuts it short.
- **An icon:** its shapes and their colors.
- **An image:** its picture, compared byte for byte.

An element scores 0 when it is missing, of another kind (a frame where snap measured an icon), hidden, or has the wrong characters, shapes or picture. The headline is the elements' scores over their number. A layer for an element snap no longer measures counts as one more element, scoring 0. The share of properties is beside it, and in `--json` it stays in `fidelity`, with the element score in `elementFidelity`. Variants missing from Figma are reported separately.

### Tolerances

- A position passes within 1px of where snap measured it, or of where the elements before it put it, so a label a little wider in Figma's stand-in font doesn't move the score of everything after it.
- A container's size may differ by what its own children's sizes explain. A child deleted or hidden in Figma takes no room, and the layer after a hidden one is placed from the one before it, so a deleted or hidden layer is reported alone.
- Widths and heights allow 3% or 1px, whichever is larger, and a text's width 6% where Figma draws it in another font than snap measured it in. These allowances were set from the first live pushes, and may change.
- Colors are compared exactly, alpha included.

**Truncation.** A text that truncates is scored on what Figma cuts off, too. The read call measures a copy of each such text without its limit, and removes it, so a title Figma ends in an ellipsis where the browser drew it whole drifts, and so does one Figma shows whole where the browser cut it. A readback from before Storysync read this is scored on the truncation set alone.

### What it can't score

Under the score, `verify` lists as coverage what it couldn't score, never as a match: a font named by a CSS keyword such as `system-ui` where snap measured the platform's own font, and what `figma code` couldn't build. Where there is none, the line says `coverage 100.0%: every property was scored`.

**Designer layers.** A layer inside a variant that carries no key, one a designer added, isn't scored. `verify` lists it by name, type and node id, and it fails `--strict` unless you pass `--allow-designer-layers`.

**Leaving components out.** A component you chose not to push, such as a Dialog snap measured closed, is still in the snap, so `verify` would count each of its variants as missing from Figma. Pass it to `--skip` by name, title or ID. It's left out of the score, and of `--strict`, and the line under the score names it. A name that matches nothing is an error. A component in the readback that the snap doesn't have at all fails `--strict`: that's what a snap run again with `--components` and `--no-merge` leaves out.

### What the score can't show

Figma can match a measurement of the wrong element exactly. So under the score, `verify` lists what snap warned about each scored component:

- a closed trigger or what may be a layout wrapper;
- variants that all measured the same, saying whether their args reached the component, or values of a prop that did;
- a variant property whose default is assumed (a boolean isn't listed: one with no default is assumed `false`, as React treats a boolean left out);
- variants Storybook wouldn't render with their values (`arg_rejected`), built as placeholders and not scored, and variants measured without snap checking the story took their values (`argsChecked: false`), which only `--strict-measured` fails on;
- values snap set through Storybook's preview, a font the browser couldn't render, and any other warning, word for word, such as variants whose content draws past their box;
- which variants snap measured from a story other than the component's, or that it couldn't read the stories' args and so measured every variant from one story, and how it opened an overlay it measured open.

None of these fails `--strict`. With `--json`, each is in `caveats`, by its `kind`, the last two as `variant-stories` and `opened`.

```text
  ! The score compares Figma with what snap measured, and snap warned about that for these components:
      ui/base/Dialog: snap measured button[data-slot="dialog-trigger"], a closed trigger, so this scores the trigger, not what it opens; snap didn't open it: clicking it, hovering over it, focusing it and right-clicking it opened nothing within 3000ms each
      ui/base/Attachment: `state=done`, `state=uploading` and `state=processing` measured the same, so their variants in Figma look alike; if the code draws them differently, the story may not pass `state` through for them
```

### Readback checks

`verify` never contacts Figma, so before scoring it checks that the readback is what Figma returned:

- Each entry carries a checksum computed inside Figma over exactly what it returned, so an entry that was edited, made up, or copied from another variant fails.
- Each entry must have every field its readback template returns (`null` where Figma has nothing), so a cut-down readback can't score 100% on fewer properties. A root-only entry has 13, and three later fields, `textLayout`, `bound` and `unbound`, aren't required, so a readback from before them still verifies. An entry with some of them must have all three. Where snap recorded a `text.layout` and a root-only entry has no `textLayout`, `verify` says the text's fit wasn't compared, doesn't say Figma matches that component, and fails `--strict`.
- Each entry records when Figma read it, and one read before the snap is stale. Five minutes of clock difference is allowed.
- No two components can share a `nodeId`.
- A variant read in parts must have every part, in order, and its name in Figma must be the one snap gives it.

Entries that fail aren't scored and fail `--strict`. Without `--strict` the run still exits 0, so the score's own line says it left them out, and can't be read as a clean pass:

```text
Fidelity: 100.0% of verified entries (12/12 properties); 1 entry unverified, not scored
```

With `--plan`, a planned read call that wasn't read whole is named, and fails `--strict`: its response, or a continuation's, isn't saved or holds an error, or a continuation was saved before the call it continues was sent again. The variants it didn't read are counted as not read rather than missing from Figma, and left out of the score. So is a read call whose response was saved before a build call of its components was sent again: it read Figma before that build, so it fails `--strict` until it is sent again. A snap other than the one the plan was made from, taken again or passed as `--snap`, is named too, with what it reached: the components Figma says were built from an earlier measurement than it, which the plan's calls would build again, so `figma code` has to run again with it, and which fail `--strict`; or, where there are none, that every variant scored was built from what it measures, so the score stands.

The checksum isn't a signature. See [What Figma can't do](https://github.com/brendanciccone/storysync/blob/main/README.md#what-figma-cant-do).

### Staleness

`snap` writes a `meta.json` next to `styles.json` recording when and against which Storybook it measured. It's a separate file so `styles.json` stays stable to diff. `verify` uses it to catch a snap taken before the code changed, which would otherwise score 100%. `--strict-age` fails when `meta.json` is missing or invalid, since it's often gitignored. After `snap --merge`, each component's readback is checked against the time that component was measured.

### Root-only snaps and readbacks

A snap taken with `--root-only`, or by Storysync 0.3.0, is scored by each variant's outer element, and `verify` says under the score that only the outer element was compared, with how many inner elements weren't measured. `--roots-only` scores an element-tree snap that way too, for comparison. A tree snap scored against a readback of roots alone fails `--strict`: its elements were never read back.

Scores fall from root-only ones. Comparing each variant's outer element alone, a Switch built without its thumb, an Avatar without its picture, or a Card with its title at the wrong place scored 100%. Those numbers were overstated. The same pushes score what they hold now: half of the Switch's elements, a third of the Avatar's. A push from the element-tree calls that matches the code still scores 100%.

A root-only readback also names the variable each field is bound to, and the fields bound to none though a variable of their kind in the file has their value, which `verify` lists under the score without failing `--strict`.

## Tokens

### Sources

Storysync detects the token source automatically:

| Source | What it reads |
|---|---|
| **Tailwind** | `tailwind.config.ts`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts` (`theme.extend.colors`, `spacing`, `borderRadius`, `fontSize`, `boxShadow`, and a preset's in a relative file), or Tailwind v4 `@theme` blocks when there's no config |
| **CSS custom properties** | `:root { --color-*; --spacing-*; --radius-*; --font-*; --shadow-* }` in `.css` files, including a selector list such as `:root, .light { }`. A bare `--radius`, `--spacing` or `--shadow` is `DEFAULT`, but a radius `DEFAULT` another radius step repeats, as shadcn/ui's `--radius-lg: var(--radius)` does, is left out. |
| **Theme files** | `tokens.ts`, `theme.ts` and similar: exported objects with `colors`, `spacing` and so on |

Detection takes the first of these a project has:

1. a `tailwind.config.ts`, `.js`, `.mjs` or `.cjs`;
2. a stylesheet with a `:root { }` rule;
3. a Tailwind v4 `@theme` block;
4. a theme file;
5. a `tailwind.config.mts` or `.cts`, which a warning names when another source is read first;
6. last, a stylesheet whose variables are only in a selector list such as `:root, .light { }`.

The last two come last so a project keeps the source its baseline was written from. Pass `--source tailwind`, `css` or `theme` to choose one.

Categories are **colors**, **spacing**, **typography**, **radius** and **shadows**. Tokens are listed in the order their source declares them, and commented-out tokens are skipped. Stylesheets in `storybook-static`, `out`, `coverage`, `dist`, `build`, `.next` and `node_modules` are built or installed files, and aren't read.

### Values

**Colors** can be in any CSS form: hex, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`, or the bare HSL channels shadcn/ui uses (`240 5.9% 10%`). A custom property with one of these values counts as a color whatever its name. `tokens --json` keeps the value as written and adds its sRGB `hex`:

```json
{ "name": "brand", "value": "oklch(63.7% 0.237 25.331)", "hex": "#fb2c36" }
```

The push sets Figma variables from `hex`, since Figma's color helpers only accept a few formats, and `diff` compares in hex. Translucent colors get `#rrggbbaa`. A value Storysync can't convert, like `currentColor` or an unresolved `var()`, has no `hex`.

**Lengths** in radius, spacing and typography get `px`, with rem (16px) and `calc()` worked out. The push sets FLOAT variables from it, and `diff` compares in px:

```json
{ "name": "sm", "value": "calc(0.625rem - 4px)", "px": 6 }
```

A value in em or %, or with no unit, like a font weight, has no `px`. A value the browser would reject has none either. A value can keep a `var()` that does resolve, as in `calc(var(--radius) - 4px)`, and still gets its `hex` or `px`.

### Dark mode

Where the stylesheets set variables for a dark theme, in `.dark`, `[data-theme="dark"]`, `:root.dark` and the like, or a `:root` inside `@media (prefers-color-scheme: dark)`, each token is read again with them. A token whose value differs gets a `dark` value, and `modes` says which modes the tokens fill:

```json
{ "name": "background", "value": "oklch(1 0 0)", "hex": "#ffffff", "dark": { "value": "oklch(0.145 0 0)", "hex": "#0a0a0a" } }
```

The push makes them a Dark variable mode beside Light, and `diff` and the audit compare each mode. A dark theme's rules never override the light values: a `:root` inside `prefers-color-scheme: dark` gives `dark` values only.

### `var()` references

Many Tailwind configs, shadcn/ui's included, define colors as `hsl(var(--background))` and put the values in `globals.css` under `:root`. Storysync resolves these:

```ts
// tailwind.config.ts
colors: { background: "hsl(var(--background))" }
```

```css
/* globals.css */
:root { --background: 0 0% 100%; }
```

That resolves to `hsl(0 0% 100%)`. It also handles Tailwind's `<alpha-value>` placeholder (`hsl(var(--bg) / <alpha-value>)`), nested variable chains (`--brand: var(--blue-500)`), and fallback values, including ones with parentheses (`var(--missing, var(--border))`). In CSS mode, a color whose value holds a `var()`, like `hsl(var(--primary-h) 50% 50%)`, gets its `hex`.

A `var()` that doesn't resolve stays as written, with a warning starting `Unresolved:` that names the token and says why: the variable is set nowhere Storysync reads (next/font, say, sets a font's at runtime), or only in terms of itself, or in a loop. The skills leave those tokens out of the push.

**Which rules count as the default theme.** Variables are read from every rule whose selector list includes `:root`, such as `:root, .light { }`, inside `@layer base` or another wrapper too, with later declarations winning. A rule for another theme, such as `.dark`, `:root.dark`, `[data-theme="dark"]` or a rule nested in `:root` such as `&.dark { }`, gives `dark` values instead. `html:root { }` is read as `:root`, but an `html { }` rule isn't, since `:root` overrides it whatever their order. Nor is Tailwind v4's compiled theme, the `:root, :host { }` in `@layer theme` that its build output holds. A minified `.min.css` bundles other packages' styles, such as Bootstrap's, so in one a selector list is read only when it ends in `:root`.

### Tailwind configs

Storysync reads a Tailwind config as text and never runs it.

- A preset in a relative file, as in `presets: [require("./tailwind.preset.js")]` or an imported `brandPreset` from `"./theme/preset"`, or in an object the config file declares, is read the same way, one level deep. They merge as in Tailwind: a key set in `theme` itself replaces a preset's, one in `theme.extend` adds to it, and the config's own tokens win over a preset's of the same name, as a later preset's do over an earlier one's.
- A config that re-exports another relative file, or spreads one in at the top of the object it exports, as `{ ...require("./base"), content }` does, is read through it. A `theme` key after the spread replaces the spread's theme, as in JavaScript.
- Values in template literals are read as strings, so `` `calc(var(--radius) - 2px)` `` works like the quoted form. One that interpolates, like `` `${base}px` ``, is skipped with a warning starting `Skipped dynamic value:`, since its value is known only when the config runs.

What it can't read without running the config is named in a warning, and its tokens are missing from the output: a preset from a package, a preset built by a function call such as `preset()`, a config passed through a function such as `withMT({ ... })`, a re-export or top-level spread from a package, or anything spread in at the top of `theme` or `theme.extend`, such as `...buildTheme(tokens)`. A config with no theme Storysync reads says so too. If the tokens you need come from one of these, the CSS variables they point at may still be read with `--source css`.

### Tailwind v4 `@theme`

A CSS-first Tailwind v4 project declares its tokens in `@theme` blocks:

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

With no `tailwind.config`, Storysync reads `@theme` blocks (`@theme inline` included), unless the project also has a stylesheet with a `:root { }` rule, as shadcn/ui's v4 `globals.css` does. Then it reads `:root`, plus the `@theme` spacing, radius, shadow and typography variables built from a `:root` variable, such as shadcn/ui's `--radius-sm: calc(var(--radius) - 4px)`, resolved with `:root` winning as it does in the browser. For shadcn/ui v4 that is `radius/DEFAULT` plus `sm`, `md`, `lg` and `xl`, and any larger sizes your globals.css declares. `@theme` colors aren't read then, since `:root` holds what they point at, and a warning names the other `@theme` tokens it didn't read and why, suggesting `--source tailwind` for the ones that would resolve. A stylesheet whose variables are only in a selector list, such as `:root, .light { }`, doesn't make `:root` the source, so `@theme` is read.

| Namespace | Category | Token name |
|---|---|---|
| `--color-*` | colors | without the namespace: `--color-brand-500` → `brand/500` |
| `--spacing-*`, `--spacing` | spacing | `--spacing-18` → `18`; the bare `--spacing` base unit → `DEFAULT` |
| `--radius-*` | radius | `--radius-card` → `card` |
| `--shadow-*` | shadows | `--shadow-soft` → `soft` |
| `--text-*`, `--font-*`, `--font-weight-*`, `--leading-*`, `--tracking-*` | typography | with the namespace, since they share a category: `text/hero`, `font/display`, `font/weight/bold`, `leading/snug` |

Dashes in a name become `/`. A `var()` is resolved against the theme, the project's `:root`, and Tailwind's default theme when `tailwindcss` is installed, so `--color-primary: var(--color-blue-500)` gets blue-500's value. Tailwind's defaults are used only to resolve references. Later declarations win, and `initial` removes a variable (or a whole namespace, as in `--color-*: initial`). Modifiers like `--text-hero--line-height` and nested rules like `@keyframes` are skipped, and other namespaces (`--breakpoint-*`, `--animate-*` and so on) are listed as uncategorized. An `@theme` token whose `var()` doesn't resolve is left out, and an `Unresolved:` warning names it.

## Props and variants

| Storybook prop type | Figma output |
|---|---|
| `boolean` | Boolean variant property |
| `enum` / `union` of string literals (a `null` or `undefined` member is ignored) | Variant property with matching values |
| A prop whose story's argTypes give `options` | Variant property with those values |
| A prop neither the docs nor the argTypes list that the stories' own args set | Variant property with the values they give |
| `string` (free text) | Skipped |
| `number` (free value) | Skipped |
| `function` / `callback` | Skipped |
| `ReactNode` / `children` | Skipped |
| `ref` / `className` / `style` | Skipped |
| `as` / `asChild` / `render` (they change the element, not its look) | Skipped |
| `aria-*` / `data-*` attributes | Skipped |

**Where props come from.** Props come from the Props section of the component's Storybook docs, and from the story's `argTypes`, which snap reads in the browser and records in `styles.json`. A choice only the argTypes declare, like Button's `disabled` or Sheet's `side`, becomes a variant property too, its default the story's own arg. So does a prop neither lists that the stories' own args set, like coder's Button's `variant` and `size`, which come from cva's VariantProps: its values are those the stories give, a boolean or a short lowercase word each, never content such as a `title` or `placeholder`, and its default is the value the component's story gives it, else its argTypes' own. Where no story names the component's default, the value `default` stands for the prop left unset: the property records it as `unset`, and snap measures it by giving the story no value for it. snap records the stories' args as `storyArgs`. `map`, `inspect` and `diff` read the argTypes from that snap (`--snap <dir>`, or `--no-snap`), and say when they can't see them. A union in a markdown props table (`"a" \| "b"`) is read whole, and a type is split only at its top-level `|`, so a function type or a template literal type isn't taken for a union.

**Defaults.** A union prop's values start with its default, and a boolean is laid out with its default first, so Figma's default variant is the code's. Where the docs give no usable default, `map` assumes one: a value named `default` if there is one (cva's convention), else the first value, or `false` for a boolean. It marks the property `defaultAssumed: true`, and the skills name those properties in the push summary.

**Props that only change behavior are left out on their own.** Each is recorded in `styles.json` with why, so `map`, `diff` and the Action leave out the same:

- one every value of which snap measured the same, the outer element and every element inside it alike, such as cmdk's `loop` or input-otp's `textAlign`, even where the stories' own args set it both ways, as Accordion's stories set `multiple`. A value that draws something inside, as ToggleGroup's `disabled` dims its items, measured differently, so it is kept;
- one the argTypes mark with `control: false`, a hidden table row, or an event;
- an `open` that opens what a closed trigger hides, which snap then sets on every variant, so Drawer is measured open, and a boolean whose default renders nothing at all (`element_not_found`) and whose other value renders the component, as a ConfirmDialog whose docs default `open` to false while its story sets it true.

`--keep-props` keeps one, and `--exclude-props` leaves out others, on `map`, `inspect`, `snap` and `diff`, matched ignoring case. snap passes an excluded prop to no story, so each story's own args set it, and records the list as `excludeProps` in `styles.json`, which the audit reads. Pass the same list to every snap of a push: a run without it drops the record, and a `--merge` without it refuses to run.

**Docs-only pages are skipped.** MDX docs pages, and entries whose stories name no component, such as shadcn's `design/*` token pages, never become components.

## GitHub Action

The Action checks for token and component drift on every push:

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

### Create the baselines first

With Storybook running, in the project's directory:

```bash
mkdir -p .storysync
npx storysync@<version> map --storybook http://localhost:6006 --json > .storysync/baseline.json
npx storysync@<version> tokens --json > .storysync/tokens-baseline.json
```

Commit both files. Use the Storysync version the Action runs, which is the `version` in this repo's [`package.json`](https://github.com/brendanciccone/storysync/blob/main/package.json) at the ref you use. A baseline from a different version can differ from what the Action maps. The Action's warnings and errors print these commands with the version filled in. You can also save the Action's `json` and `tokens_json` outputs as your baselines.

- If you set `components`, `exclude_props` or `token_source`, pass the same values to `map --components`, `map --exclude-props` and `tokens --source`.
- A project with no tokens can skip the token baseline, or set `token_baseline: ''` to check components only.
- With no baseline, drift is `new` and the Action warns that nothing was checked. With `fail_on_drift`, the job fails and prints the command that writes it.
- A baseline that isn't `map --json` or `tokens --json` output always fails the job. That includes the `{"error": ...}` that `map --json` writes when Storybook isn't running.

### Inputs

| Input | Default | |
|---|---|---|
| `working_directory` | `.` | The project to check, relative to the repo root. The install, Storybook, tokens and baseline paths all use it. |
| `install_command` | detected | Chosen from the nearest lockfile at or above `working_directory`, or the `packageManager` field in its package.json: `pnpm install --frozen-lockfile`, `yarn install --immutable` (`--frozen-lockfile` on Yarn 1), `npm ci`, or `bun install --frozen-lockfile`. Lockfiles from two package managers, with no `packageManager` to pick one, are an error. Set it to `true` to skip the install. |
| `storybook_url` | `http://localhost:6006` | With the default, the Action starts Storybook on 6006 and stops it after mapping. It fails if something else is already on 6006. Any other URL is used as is, so start that Storybook in an earlier step. |
| `components` | all | Comma-separated component names, titles or IDs. A name that matches nothing fails the job. |
| `exclude_props` | none | Comma-separated props to leave out of every component, as `map --exclude-props`. |
| `request_timeout` | 5 minutes | How long mapping waits for each Storybook request, in ms, as `map --request-timeout`. Raise it for a slow Storybook. |
| `token_source` | `auto` | `tailwind`, `css`, `theme` or `auto`. |
| `snap_dir` | `.storysync/snaps` | The committed snap whose argTypes and left-out props `map` uses. Set it to `''` for none. |
| `baseline` | `.storysync/baseline.json` | Component baseline from `map --json`. |
| `token_baseline` | `.storysync/tokens-baseline.json` | Token baseline from `tokens --json`. Set it to `''` to skip tokens. |
| `fail_on_drift` | `false` | Fail the job on drift, or when a baseline is missing. |
| `create_issue` | `false` | Open or update a `storysync-drift` issue when drift is found, even if a later step fails, unless the job was canceled. Needs `issues: write`. |
| `node_version` | `22` | Node.js version. |

**Outputs:** `drift` and `token_drift` are `true`, `false` or `new` (no baseline). `token_drift` can also be `none` (no baseline and no tokens) or `skipped` (`token_baseline: ''`). `json` and `tokens_json` hold the `map --json` and `tokens --json` output the Action compared.

### How it compares

- Components are matched by their Storybook ID, so `Forms/Button` and `Nav/Button` are compared separately. A title counts as drift only if its letters and digits changed.
- A component whose prop and combination counts didn't change is reported with what did, such as `size`'s values reordered or its default changed.
- When token drift only adds tokens, the error and the drift report say a newer Storysync can read tokens an older one didn't, and print the command that writes a new baseline.
- Token warnings are logged on every run, one line each, and a drift report lists the first 20.

### Running it

- **bun:** on a runner without bun, the Action installs it with [`oven-sh/setup-bun`](https://github.com/oven-sh/setup-bun), at the version `packageManager` names, or the latest.
- **Time:** mapping reads each component's docs one at a time, which took about 5 seconds a component on one 134-component library, so allow for that in the job's `timeout-minutes`. The log shows a line per component as it goes.
- **Aikido Safe Chain:** the Action sets up its own Node and pnpm, which come before Safe Chain's shims on `PATH`, so Safe Chain doesn't check the Action's installs. To have it check your dependencies, install them in your own steps before the Action, following Safe Chain's [GitHub Actions example](https://github.com/AikidoSec/safe-chain#github-actions-example) with the Node version `node_version` names, and set `install_command: 'true'`.

## Troubleshooting

### Storybook

- **"Storybook has no MCP endpoint" (HTTP 404).** Run `npx storysync init`, then restart Storybook.
- **A request timed out.** A busy or shared Storybook is slow rather than down. Run the command again with `--request-timeout 900000`, or `--connect-timeout 180000` for connecting.
- **A long snap stopped part-way.** An agent's shell stops a command after a few minutes, and snap stopped part-way writes nothing. The skills run it in the background with `STORYSYNC_PROGRESS=1` and check its exit code.
- **Stories time out.** A busy Storybook times out stories that render. Measure those components again with `--components <IDs> --merge` and a longer `--timeout`, such as 30000.

### snap warnings

- **Every variant measured the same.** If they rendered the same markup, the story likely drops its args: see [Write stories that measure well](https://github.com/brendanciccone/storysync/blob/main/README.md#write-stories-that-measure-well). If the markup changed, the props change only behavior, and snap leaves them out.
- **A closed trigger or a layout wrapper.** Give the component an `open` or `defaultOpen` prop the story passes through, or a story that renders it open or on its own. Then measure it again with `--merge`.
- **Content past its box.** Use a story whose args give those variants content that fits, or name one with `--stories`.
- **A capped component.** Raise `--max-combinations`, or leave out props that don't change the look with `--exclude-props`.
- **A font didn't load.** snap measured the fallback the browser used. Fix the font, or install it in Figma.

### Figma

- **`This call differs from the file storysync figma code wrote`** (or `figma tokens wrote`, or `figma next wrote`). A character changed on the way. Nothing was changed: send the file again exactly as it is.
- **`Script exceeded time limit`.** Run `figma code` again with `--max-nodes 200`, and send the new plan from its first call.
- **`diff` returns 401 or 403.** Figma's remote MCP server needs OAuth. Use the skill's audit.
- **A score dropped after an upgrade.** Element trees score every element, not just the outer one. See [Root-only snaps and readbacks](#root-only-snaps-and-readbacks).

### Codex details

- If Storybook isn't running, `codex mcp add` prints "MCP server may or may not require login". You can ignore it. Storybook's server needs no login.
- You can install Figma's plugin instead of adding its server by hand: **Plugins** in the desktop app, or `/plugins` in the CLI.
- `codex mcp add` registers a server for every project. To keep Storybook to this one, put it in `.codex/config.toml` instead, which Codex reads once you trust the project:

  ```toml
  [mcp_servers.storybook]
  url = "http://localhost:6006/mcp"
  ```

- Codex's sandbox has network access off, so it asks to run `npx storysync` outside it, to reach Storybook, or Figma for `figma upload`. Approve it, or accept the rule Codex offers so it stops asking.
- Codex gives each MCP call `tool_timeout_sec` seconds (60 or 300 by default, depending on the version). The skill splits large Figma writes across calls, but if one still times out, raise the limit in the table `codex mcp add` wrote to `~/.codex/config.toml`:

  ```toml
  [mcp_servers.figma]
  url = "https://mcp.figma.com/mcp"
  tool_timeout_sec = 600
  ```

  Figma's plugin has no timeout setting, and a `[mcp_servers.figma]` table replaces the plugin's server. So with the plugin installed, run the `codex mcp add figma` command above and add the line to the table it writes.

### Baselines from an earlier version

A newer Storysync reads more than an older one, so a baseline the older one wrote shows drift once. Recreate it with the version you run. Expect it when:

- an earlier version read `storybook-static`, `out` or `coverage`, which now aren't read, so a token found only there is listed as removed;
- an earlier version didn't read presets, shadcn/ui's radius scale, or a bare `--radius`, `--spacing` or `--shadow`, which are listed as added;
- an earlier version read `.dark:root { }` or a `:root` inside `prefers-color-scheme: dark` as the default theme, or a `&.dark { }` nested in `:root` as part of it, so those tokens are listed as changed;
- an earlier version kept a template literal's backticks, so a backticked token is listed as changed, and one that interpolates as removed;
- a 0.3.0 component baseline listed values in declared order, where `map` now puts the default first. It has no IDs either, so the Action matches it by title, with a warning on every run, until you recreate it.

`tokens --check` compares dark values only against a baseline that has `modes`, so an older baseline still passes, with a note to recreate it.

## Non-goals

- **Figma to code.** Storysync never writes source. That's the direction where an LLM's mistakes are hardest to notice, and Figma's MCP already does it with `get_design_context`. `storysync diff` reports drift in that direction but doesn't apply it.
- **Pixel-perfect rendering.** `verify` compares numbers, each element's box, paint and text within its tolerances, not rendered pixels, and Figma draws text with its own metrics.
