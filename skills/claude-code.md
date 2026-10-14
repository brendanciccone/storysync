# storysync — Storybook to Figma

Read components from Storybook MCP and recreate them in Figma MCP as a visually accurate component library, with design token foundations.

## Requirements

- Storybook dev server running with `@storybook/addon-mcp` (Vite-based Storybook 10.1+, Node 18+; `snap` needs Node 20+)
- Storybook MCP: `claude mcp add --transport http storybook http://localhost:6006/mcp`
- Figma MCP: `claude plugin install figma@claude-plugins-official` (or `claude mcp add --transport http figma https://mcp.figma.com/mcp`)
- Figma Full seat (Dev seats are read-only)
- storysync 0.4.0 or later, run as `npx storysync` — 0.3.0 has no token `px`, component `id`, `--exclude-props` or `--merge`, and 0.2.0 and earlier have no `snap` or `verify`
- If storysync says Storybook has no MCP endpoint (`answered HTTP 404`, with ``Run `storysync init`, then restart Storybook``), ask the user to run `npx storysync init`, which asks before each change it makes, and then to restart Storybook. If its install fails, it prints the command to run by hand after `Run manually:`: pass that line on rather than retrying.
- The CLI's own `storysync diff` can't sign in to Figma, so against `https://mcp.figma.com/mcp` it fails with HTTP 401 by design. Audit with the Audit section below instead, through your client's `use_figma`, and don't retry it.

## Tokens

Before syncing components, extract design tokens from the project and create or update Figma variable collections. This ensures components can bind to variables instead of hardcoded values.

1. **Extract tokens.** Run storysync to detect and extract tokens from the project, saving them for step 3 and for the build:

```bash
mkdir -p .storysync && npx storysync tokens --json --project . > .storysync/tokens.json
```

Read the output from `.storysync/tokens.json`. It auto-detects the token source (a Tailwind config or Tailwind v4 `@theme` block, CSS custom properties, or theme files) and outputs structured JSON:

```json
{
  "source": "tailwind",
  "sourcePath": "tailwind.config.ts",
  "modes": ["Light", "Dark"],
  "collections": [
    {
      "category": "colors",
      "tokens": [
        { "name": "primary/500", "value": "oklch(62.3% 0.214 259.815)", "hex": "#2b7fff" },
        { "name": "background", "value": "oklch(1 0 0)", "hex": "#ffffff", "dark": { "value": "oklch(0.145 0 0)", "hex": "#0a0a0a" } },
        ...
      ]
    },
    {
      "category": "spacing",
      "tokens": [{ "name": "4", "value": "1rem", "px": 16 }, ...]
    }
  ],
  "defaults": [
    { "property": "color", "token": "foreground", "from": "app/globals.css, @layer base: body { @apply bg-background text-foreground }" }
  ],
  "summary": { "totalTokens": 42, "collections": 4 }
}
```

A token with a `dark` has a different value in the project's dark theme (`.dark`, `[data-theme="dark"]` or `prefers-color-scheme: dark`), with its own `hex` or `px`. `modes` is `["Light", "Dark"]` when any token has one, else `["Default"]`: the Figma modes step 3 makes. `defaults`, where there is one, names the color tokens the project's base styles give an element no class colors: the text color `body` hands down, and the border and outline colors a `*` rule sets, each with the rule. It makes no variable; `figma code` binds by it (Variable binding, below).

If a `warnings` entry says storysync can't read or find part of the Tailwind config, or doesn't follow it, such as a preset from a package, a config built by a function, or a file it names, or that it read no theme from the config, tell the user what it names: those tokens are missing from the output, so they won't reach Figma. If one says it read another source rather than a `tailwind.config.mts` or `.cts`, tell the user, who can pass `--source tailwind` to read the config. If the command returns no collections, skip to Components.

2. **Preview tokens** — optionally, run `npx storysync tokens --project .` (without `--json`) to show a human-readable preview, or `npx storysync tokens --project . --all` to show every token.

3. **Push the variables with the calls `figma tokens` writes.** Write no variable code yourself:

```bash
npx storysync figma tokens
```

   It reads `.storysync/tokens.json` and writes `.storysync/figma/tokens/plan.json` and a `use_figma` call per collection under `.storysync/figma/tokens/calls/`: one collection per category, `Colors`, `Spacing`, `Radius` and `Typography`. Send the calls in `seq` order as Components step 5 sends a plan's: `use_figma` with `code` the contents of its `file` (under `.storysync/figma/tokens/`), unchanged, `description` its `description`, the file key and `skillNames: "figma-use"`, and save the response unchanged to its `result` path before the next call. Never edit a call or a saved response. Every call can be sent again, and a push sent again changes nothing in Figma:

   - Each call finds its collection by name, where an earlier push made it, and creates it where none has the name. Where two collections have the name, as the skill's earlier template made on every push, the call throws before changing anything: ask the user which to keep and to delete the other in Figma, then send the call again.
   - A collection where any token has a `dark` has two modes, `Light` and `Dark`, and every variable in it a value in each: `Dark` from its `dark`, or, for a token with none, its light value again, as the browser keeps a variable the dark theme doesn't set. Any other collection has one mode, `Default`. A collection's lone mode is renamed to match, Figma's `Mode 1` included, and a `Dark` mode is added where the tokens have gained a dark theme. A `Dark` mode the tokens don't fill, a designer's own or one an earlier push added, keeps the values it has; only a variable the call makes takes its light value there. Of several modes, none is renamed.
   - Each variable is found by its name in the collection, and created where there is none. A call writes only a value or `scopes` that differ, so its response's `created`, `updated` and `unchanged` say what it changed, and `modes`, `renamedModes` and `addedModes` what it did to the modes.
   - A translucent color a push binds is bound to an **alpha variable**, made beside its color token: `destructive 10%` is `destructive` at 10%, its `Light` value the token's light color at that alpha, its `Dark` value its dark color at that alpha, with the token's `scopes`. Where the dark theme paints the token at another alpha, as shadcn/ui's destructive button's `bg-destructive/10 dark:bg-destructive/20` does, it holds each theme's, `destructive 10% dark 20%`. Figma resolves a paint bound to a variable again at every mode switch, on its frame or one around it, and gives it the variable's own alpha, as it does a bound shadow: bound to `destructive` at 10%, shadcn/ui's `bg-destructive/10` turns opaque when a designer switches a frame to `Dark`, and stays so back in `Light`; bound to `destructive 10%`, it keeps its 10% in both. An alpha of no whole percent has a tenth after a comma, `ring 12,5%`, since Figma takes no period in a name. The plan `figma code` writes makes those its builds bind in its first call (Components step 5), so nothing here waits for it. `figma tokens` makes those of the plan an earlier push left at `.storysync/figma/plan.json` too, and those `--alpha` names, as a root-only push binds them (Root-only snaps); each call lists those it keeps in `alpha`, and keeps every alpha variable of its tokens up to date with them, whatever a plan binds; one whose token is gone is stale, as below. A **per-mode variable** holds one color in `Light` and another in `Dark`, for a paint whose `dark:` class names another color: `background dark input 30%` is `background` in Light and `input`'s dark color at 30% in Dark, as shadcn/ui's outline button's `bg-background dark:bg-input/30` paints; `input 0% dark 30%` is clear in Light, for an input's `bg-transparent dark:bg-input/30`; `slate-50 dark slate-900` holds two Tailwind palette colors no token names, whose values the call carries in `ref`, read from the project's own Tailwind. The color Dark takes is written as a class names it, `foreground 60% dark muted-foreground` for `muted/foreground`, since Figma groups a variable at each `/`. A `dark:` class with a state, as Tabs' `dark:data-active:text-foreground`, is Dark's paint only where snap found its state applies, so the active trigger binds to `foreground`; where snap can't read the class's rule, the paint binds to its token. These are storysync's own too. One a plan made that no layer binds, as for a build that then failed (`verify` lists it, Components step 6), is removed with `--remove "Colors/destructive 90%"` only once the user confirms it, and isn't made again.
   - Each variable gets the type and `scopes` of its category, the property pickers it shows in (left unset they are `ALL_SCOPES`, and a radius shows in the opacity and stroke weight pickers), and a variable an earlier push left at `ALL_SCOPES` is set to them:

   | Tokens | Type | `scopes` |
   |---|---|---|
   | colors | `COLOR`, from `hex` | `ALL_FILLS`, `STROKE_COLOR`, `EFFECT_COLOR`: Tailwind paints any color as a background, text, border, ring or shadow, as shadcn/ui's tooltip is `bg-foreground text-background` |
   | radius | `FLOAT`, from `px` | `CORNER_RADIUS` |
   | spacing | `FLOAT`, from `px` | `GAP`, `WIDTH_HEIGHT` |
   | typography `text/*`, `font/size/*` or `fs/*`, and a Tailwind config's `fontSize` tokens, which have no namespace (`sm`, `base`) | `FLOAT`, from `px` | `FONT_SIZE` |
   | typography `font/weight/*` | `FLOAT`, the weight | `FONT_WEIGHT` |
   | typography `leading/*`, `line/height/*` or `lh/*` | `FLOAT`, from `px`, or a unitless line height as it is | `LINE_HEIGHT` |
   | typography `tracking/*` | `FLOAT`, from `px` | `LETTER_SPACING` |
   | typography, other `font/*` | `STRING`, the family Figma sets the stack's text in: `Geist` for `"Geist Variable", sans-serif`, `Inter` for `ui-sans-serif, system-ui, sans-serif` | `FONT_FAMILY` |

   `figma tokens` prints each token it has to leave out, with why: a shadow, which no Figma variable holds; a color storysync couldn't convert to sRGB, such as `currentColor`; a length with no fixed size in px, in em or % (as letter spacing often is), which depends on the element; and any token a `tokens` warning starting `Unresolved:` names, whose `var()` is set nowhere storysync reads (next/font, say, sets a font's at runtime). Name them all in the summary. The tokens a warning says were not read from `@theme`, shadcn/ui's `font/sans` and `font/mono` among them, are out of the output already: name them all the same. So are the tokens a warning starting `Skipped dynamic value:` names, a value the config only computes when it runs, such as a template literal that interpolates or a `theme()` call: name them too.

   If a call returns a `darkError`, the file's Figma plan allows the collection one mode: it holds the light theme alone, so tell the user, with the error, that the dark values weren't pushed, and that a plan with more modes, or a Dark mode added by hand, would take them.

   **Never remove a variable on your own.** The first call of each collection lists in `stale` the variables it holds that no token has, as `Collection/name`, such as the `Radius/DEFAULT` an earlier push made, which `tokens` has since dropped for repeating `lg`; and in `conflicts` each variable of a token's name that can't be its variable, with why: a variable of another type, which Figma can't change, or a second of the name. A call leaves every one of them as it is, and pushes no token in conflict (`skipped`). Ask the user once, listing them all, which to remove, and say that a layer bound to one keeps its value, detached. For those the user confirms, write the calls again with `--remove` for each, as the response lists it, then send the new calls from the first:

```bash
npx storysync figma tokens --remove Radius/DEFAULT
```

   They remove those alone, and only a stale variable or a conflicting one, never a token's own, then push each token as before, creating one whose conflicting variable they removed. For those the user keeps, say in the summary that they stay.

   A call that fails with `Script exceeded time limit` holds too many variables for one call: run `figma tokens` again with `--max-variables 20`, and send the new calls from the first. A large collection is split into calls of 40 variables by default, each alpha variable in the call of its token, the first listing what is stale. For `This call differs from the file storysync figma tokens wrote`, a character changed on the way and nothing was changed: send the file again exactly as it is.

4. **Verify.** Each response's `variables` is how many its collection holds after the call: its tokens, less those left out, its alpha variables, and any stale variable the user kept. Confirm each collection has them, with a `Dark` mode where its tokens have dark values or a `darkError` says why not. If a call failed, deal with its error and send it again.

## Components

1. **Count the components, and agree on what to push.** List them first. This reads only Storybook's list of components, so it takes seconds:

```bash
npx storysync list --storybook http://localhost:6006 --json
```

This outputs:

```json
{
  "components": [
    { "id": "forms-button", "name": "Button", "title": "Forms/Button", "category": "Forms", "storyIds": ["forms-button--default"] }
  ]
}
```

The `title` is the component's Storybook title, and `category` its place in Storybook's sidebar (the part of `Forms/Button` before the last `/`). Use them to organize the Figma file: see step 4 below. `id` is Storybook's ID for the component, which no other component shares, where a `name` can be: `--components` and `inspect` take a title or an ID as well as a name. An entry with `"docsOnly": true` has no component behind it: Storybook's index shows its stories name none, as shadcn's `design/*` token pages and form examples do. map, snap and diff skip it unless `--components` names it, and `list` without `--json` lists it as skipped: don't count it among the components to push unless the user asks for it.

   Step 3 reads each component's docs and renders every variant in a browser, which takes several seconds a component, and more on a busy Storybook: 134 components took about 17 minutes. **If there are more than about 20 components, stop and ask the user what to push before measuring anything:** all of them, some categories (name each with how many components it has), or some components. Pass what they choose to step 3 as `--components`, by ID. With 20 or fewer, push them all. When you ask, say that a push isn't lightweight: plan on roughly 100k agent tokens a component, plus about 100k a push for setup and verification, less for simple components and 2 to 3 times more for big variant grids, so about 1.1M for 10 components, 3.1M for 30 and 6.1M for 60, split across sessions. Step 5 gives an estimate for the push itself.

   If a command fails because Storybook didn't answer in time, a busy or shared Storybook is slow rather than down: run it again with the flag its error names raised, `--request-timeout 900000` for a request, which has five minutes by default, or `--connect-timeout 180000` for connecting.

2. **Inspect individual components** — for detailed prop-to-variant mapping of a specific component:

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

   `npx storysync map --storybook http://localhost:6006 --json` maps every component's variant properties without rendering anything. The push doesn't need it: snap's output carries the same `id`, `title`, `category` and `variantProperties`. Without a browser, map can't see the stories' argTypes, so it reads them, and the props snap left out, from `.storysync/snaps/styles.json` when there is one (`--snap <dir>` for another), and says when it can't. storysync keeps each component's docs in `.storysync/cache/docs`, so a command after the first doesn't read them again until Storybook's index or the component changes; `--no-cache` reads them anyway.

3. **REQUIRED — Measure the styling. Do not infer it.** Do not proceed to step 5 without a snap taken in this session: every Figma layer the push builds comes from it.

```bash
mkdir -p .storysync
STORYSYNC_PROGRESS=1 npx storysync snap --storybook http://localhost:6006 --variants all --json > .storysync/snap-out.json 2> .storysync/snap-progress.log; echo "exit $?" >> .storysync/snap-progress.log
```

   Add `--components` with the IDs step 1 agreed on, unless the user chose every component. It replaces those components in `.storysync/snaps/styles.json` and keeps every other one an earlier push measured, so `map`, the audit and a later `verify --plan` of that push still have their record, dropping only one Storybook no longer lists, which it names. Where that snap was measured another way (another `--storybook`, `--variants`, `--exclude-props`, `--keep-props` or Storysync version), it refuses and says how: run it again with the same flags, or ask the user whether to drop the other components' record with `--no-merge`, which writes those components alone. This renders each variant in a real browser and reports what the browser actually computed, so the values are measured rather than guessed: the variant's outer element and every element inside it that draws, with its text, its icons' shapes and its pictures. This measures **every combination** of the component's variant props, and step 5 builds one Figma variant per snap variant, whatever its status: a Figma component set needs every combination to exist, or the variant picker has nothing to switch to. **If a component carries a `cap` field** (its combinations exceed the limit, 256 by default), snap measured only a subset and warned about it; the cap's `uncovered` list names any values that subset left out entirely. **Stop and ask the user before building that component.** Tell them its total and the limit, and offer: build the measured subset; measure it again with `--components <its ID> --merge --max-combinations <total>` to measure all of them (very large component sets get slow in Figma); or narrow which props are variants: re-run snap with `--exclude-props` naming the props that don't change how it looks, such as `modal` or `loop`, which leaves them out of every component. Do not offer to fill the unmeasured combinations in from source: they can be measured by raising the limit, and a value the tool can read must never be guessed. Do not choose for them. Run it *now*, in this session — do not reuse a `styles.json` from an earlier run, which may describe code that has since changed.

   snap measures each component from a story it picks, and a variant from another of its stories where that story's own args set the variant's values and give it something of its own to draw: shadcn/ui Button's icon sizes from its Icon stories, which put an icon in place of the label. Where the component's story draws a variant past its box and no story sets its values, as Button's `size=icon-xs`, snap measures it from a story for another value of the same property, Icon, if that draws it within its box, and records why as the variant's `refit`. It records such a variant's `storyId` and says which in its output. If the user wants a component measured from another of its stories, one that shows it with an icon, say, add `--stories <its ID>=<story ID>`, as in `--stories ui-base-button=ui-base-button--with-icon`, taking the story's ID from the component's `storyIds` in step 1's list; separate several pairs with commas. That story then measures every variant no other story fits, so Button's icon sizes still come from its Icon stories. To measure every variant from the story named, with no story picked for any, as when the user doesn't want some variants measured from the story snap picked for them, end it with `!`, in single quotes: `--stories 'ui-base-toggle=ui-base-toggle--default!'`. snap then records `storyOnly: true` on the component. snap refuses a story that isn't the component's, before measuring anything. When snap warns that variants draw past their box, a label spilling out of a button sized for an icon, say, tell the user which, and what the warning says would measure them with content that fits: a story whose args set those values, another story for the component with `--stories`, or, for variants from a story snap picked for them, that story given content that fits, or one story for every variant with `!`. Build them as measured unless they stop to change one.

   **Run it in the background, and check how it ended before building.** An agent's shell stops a command after a few minutes (Claude Code's Bash tool after 2 by default, and 10 at most), and snap stopped part-way writes nothing. So start the command above in the background (`run_in_background` in Claude Code, or wrapped in `( ... ) &` elsewhere), as any storysync command that may take more than a minute or two. `STORYSYNC_PROGRESS=1` makes it log a line per component and variant, such as `snap 12/134 UI Base/Command, variant 3/32`: check on it with `tail -n 1 .storysync/snap-progress.log` until the last line is its `exit` code. Claude Code also tells you when a background command ends, so there you can wait for that, then read the last line.

   - `exit 0`: it finished, and wrote `.storysync/snaps/styles.json` and `meta.json`.
   - `exit 1`: it failed, with the reason as `{"error": ...}` in `.storysync/snap-out.json`: Storybook unreachable or too slow (raise the flag its error names, as step 1 says), a `--components` name that matches nothing, a `--merge` it refused (below), or the browser closing twice. An option it can't take, such as a `--timeout` that isn't a number, is said in the progress log instead.
   - `exit 130`, `143` or `129`: it was stopped, by Ctrl-C, SIGTERM (a command timeout, say) or SIGHUP, and the log says so.

   After any exit but 0, the `styles.json` and `meta.json` in `.storysync/snaps` are an earlier run's: never build from them. Deal with what it said, and run it again in the background. After `exit 0`, check too that `meta.json` is this run's: its `measuredAt` is after you started it, or, after a `--merge` or a `--components` run that merged, which keep `measuredAt` at the oldest component's time on purpose, its `componentsMeasuredAt` time for each component you named is. Read what it recorded from `.storysync/snaps/styles.json` on disk, a component at a time (with `jq` or `node`, say): `snap-out.json` holds the same JSON on one line, which tools cut short. What snap says of the run, the `i`, `!` and `✗` lines a terminal shows, comes first in that JSON as `messages`, each with its `level` (`info`, `warning`, `error`, or `failed` for a variant it didn't measure), `component` and `text`: read them with `jq -r '.messages[] | "\(.level) \(.component // ""): \(.text)"' .storysync/snap-out.json`, and tell the user what its warnings and failures say.

   snap writes each component's styles as earlier versions did, full styles for a base variant and only what each other variant changes, and its **element tree**: `tree.base` lists every element of the base variant that draws, each keyed by its place in the component (`card-header/card-title`, `#text`), with its box, its styles and its text; each other variant's `treeDelta` says what differs from it; and `tree.assets` holds the component's icons as SVG and its pictures, whose thumbnails snap saves under `.storysync/snaps/assets/`. **You don't translate any of it into Figma yourself:** step 5's `figma code` writes every call from it, and step 6's `verify` scores what Figma holds element by element. What you read in the file is what needs you or the user: each component's `warnings`, `cap`, `argsNotInDocs` and `excludedProps`, and each variant's `status`, `appliedVia` and `argsChecked`, below.

   **Variants where `status` is not `"ok"` were not measured.** A `render_error` that is Storybook's own, which the story throws without snap too, such as an implicit action it calls while it renders, comes with a warning that says so and gives the story's fix (an explicit `fn()` spy from `storybook/test`): measuring again won't help, so name it in the summary with that fix. A `timeout` loading the story was already tried twice, the second time with three times `--timeout` to load, or `--timeout` once such a try in the component timed out too; a busy Storybook times out stories that render, so first measure those components again, in the background as above, adding `--components <their IDs> --merge` and a longer `--timeout`, such as 30000, to the same command. `--merge` measures only those and merges them into `.storysync/snaps/styles.json`, keeping every other component as it was measured, and gives `meta.json` each component's own time, in `componentsMeasuredAt`, with `measuredAt` the oldest of them, so `verify --strict-age` judges the snap by its oldest part; it refuses a snap it can't add to, such as one taken with another `--storybook`, `--variants` or `--exclude-props`. `--components` alone merges the same way where there is a snap to add to, and writes those components alone where there is none; never pass `--no-merge` to measure some again, which drops every other component's record. An `arg_rejected` variant is one the story wouldn't render with the value asked for, because its argTypes don't allow it, and that snap couldn't set through Storybook's preview either: snap's warning names the story change that lets it, such as adding the value to the arg's `options`. Name it in the summary with that change, and once the story allows it, measure those components again with `--components <their IDs> --merge`. What still fails, step 5 builds as a placeholder, a dashed frame labeled `Not measured: <status>`, which `verify` lists as not measured and never scores, and `--strict-measured` fails on. Never style one from the component's source: a variant styled from source would be scored against a measurement it doesn't have. Name each in the summary with the story change it needs.

   **Keep every snap of a push alike.** An audit must tell which props you left out with `--exclude-props`: pass the same list to every `snap` you run for this push, re-runs included, and name those props in the summary (step 7). snap records them as `excludeProps` in `styles.json`, where an audit reads them, and a run without the flag measures them again and drops that record (a `--merge`, or a `--components` run with a snap to add to, refuses to run without it). Pass the same `--keep-props` to each run too, which `--merge` checks as it does `--exclude-props`, and the same `--stories`: a run that measures some components again leaves out the pairs for the others, and `--merge` measures a component again from the story it was measured from, with its `!` where it had one, where `--stories` names none.

   **Checkpoint before step 5**: every variant was measured, or you know why it wasn't and the user will hear it in the summary. **snap leaves out props that don't change the look, and says so once per component** (`i <component>: left out ...`). Each is in the component's `excludedProps` with its `reason`: `no-op`, every value measured the same, the outer element and every element inside it alike, with `markup` `changed` where the markup changed with it, so the story passes it and it changes only behavior (input-otp's `textAlign`), or `same` where it changed nothing on the page, so it changes only behavior or the story doesn't pass it through (cmdk's `loop`, or Accordion's `multiple`, though its stories set it both ways); `no-control`, `hidden` or `event`, marks in the story's argTypes; or `opens`, a prop such as Drawer's `open` whose `value` opens what a closed trigger hides, which snap then gives every variant, so the set is the open content, or a boolean such as a ConfirmDialog's `open`, whose docs default it to false while its story sets it true, where the defaults rendered nothing at all and its `value` renders the component. map, inspect, diff and the drift Action leave the same props out, reading them from `styles.json`. Name them in the summary, saying for `same` that the story may not pass the prop through; if the user wants one as a variant property anyway, re-run snap with `--keep-props <name>`. If all of a component's variants measured identically, as they can for props `--keep-props` kept or ones measured on a closed trigger, `snap` says why it thinks so, by what each variant's markup did. Where they also `rendered the same markup`, nothing the args set reached the page: the story may not pass its args through. Still build what was measured, which is what the story actually renders, and say so in the summary; the fix belongs in the story. Where `their markup changed with the args`, the story passes them through, and the props the warning names change nothing snap measures, likely only behavior, as input-otp's `textAlign` and `pushPasswordManagerStrategy` do: never say the story drops its args. Ask the user, in the same message as any cap or trigger question below, whether to leave those props out, re-running snap with the warning's `--exclude-props` added to any this push already passes, or to build the identical variants as measured; name the props in the summary either way. Where the warning says both, the markup couldn't settle it: say both in the summary. In every case, do not substitute values from source: a variant styled from source would be scored against a measurement it does not match. The same goes for a warning that a prop's values all measured the same: build what was measured, and name it in the summary with the fix the warning gives. A warning that the story's URL wouldn't take some values, which snap then set through Storybook's preview, means those variants were measured as the component renders them (their `appliedVia` is `"preview"`, and one whose `status` isn't `"ok"` failed after that, like any other variant not measured): build them like the rest, and name the story change the warning gives in the summary. A variant snap marked `argsChecked: false` was measured, but snap couldn't read Storybook's preview to check that the story was given its values, so it may be the story's default under the variant's name: measure those components again with `--components <their IDs> --merge`, and if snap still can't check them, build what was measured, and name them in the summary. A component's `argsNotInDocs` lists choices its story's argTypes declare that Storybook's docs don't list among its props, such as a Sheet's `side` or a Button's `disabled`: snap makes them variant properties, their default the story's own arg, and measures them like the rest. Where neither the docs nor the argTypes list a prop the stories' own args set, as coder's Button's `variant` and `size`, which come from cva, snap makes it a variant property of the values those stories give, and records the stories' args as `storyArgs`, from which map, inspect and diff take it too. Its default is the value the component's story gives it, else its argTypes' own; where no story names the component's default, the value `default` stands for the prop left unset, which the property marks with `unset`, and snap measures it by giving the story no value for it.

   **An overlay is measured open.** Where a story renders only an overlay's closed trigger (a dialog, alert dialog, popover, sheet, menu, select, hover card or tooltip), snap opens it before it measures: through the story's `open` or `defaultOpen` arg where the component takes one, else by clicking the trigger, hovering over it, focusing it or right-clicking it, and measures what opened. Its output says so on an `i` line (`measured open: snap clicked button[data-slot="dialog-trigger"] to open it, and measured div[data-slot="dialog-content"]`), and each such variant records how in `opened`. That content is the component: build it like any other, and say in the summary how snap opened it. A select's or combobox's field, a popover's trigger included where the component is named for one or its content holds a combobox or listbox, is measured with what it opened, as one root that draws nothing around both, where they render, so the Figma component has the field too (its `element` names both: `button[role="combobox"] + div[role="listbox"]`). A toast's story with an empty toaster, as Sonner's, has its button clicked to raise a toast, which is measured (a toast the story draws itself is measured as it is); where none rises, snap measures the story as it renders, and the layout wrapper's warning says why. A select's field that opens nothing is measured as the field, which is the component while closed, and gets no warning, unless other variants of it opened: then snap warns it measured the closed trigger in those variants, as below, and why (a disabled variant, say). So does a variant that sets `open` to false, which holds the overlay closed.

   **snap measures the light color scheme**, the one tokens are matched by. Where Storybook renders a project's dark theme by default, as a theme decorator reading addon-themes' `theme` global may, snap sets the preview's globals in each story's URL so it renders light (`globals=theme:light`), records them as the component's `globals`, and says so once on an `i` line. It reads the scheme from a `dark` or `light` class or a `data-theme`-style attribute, and where the page marks none, from a theme global that names dark, such as addon-themes' default theme. Each component records the scheme it was measured in as `scheme`. A Storybook that renders only dark, or a story that sets its own dark theme, records `scheme: "dark"` with a warning that says why: tell the user its colors are the dark theme's, and that a global or theme decorator that renders it light, then a measure again with `--merge`, fixes that.

   **Stop and ask about every component snap measured as something else.** When snap warns that it measured a closed trigger, which it does only where it couldn't open the overlay and says why (`snap didn't open it (...)`), or a layout wrapper rather than the component, the Figma component would be that trigger or wrapper, and `verify` would score it as faithful. Before building any of them, ask the user once, listing each such component with the element snap measured, which they want:

   - **Build what was measured**, and say so: in the summary, and in Figma, on a line of each such set's description that starts `storysync:`, which step 5's label call sets.
   - **Skip them**, naming them in the summary as not pushed. They stay in `styles.json`, so give their IDs to step 5's `figma code` and step 6's `verify` as `--skip`, which leaves them out of the push and out of the score, and names them under it. Without it, `verify` lists each of their variants as missing from Figma, which is no reason to build them.
   - **Stop**, so they can fix what the warning names: give the component an `open` or `defaultOpen` prop the story passes through, which snap sets, or a story that renders it open or on its own. Then measure those again with `--components <their IDs> --merge`, as above.

   Ask it in the same message as any cap question, and do not choose for them. Never style such a component from source instead: it would be scored against a measurement it does not match.

4. **The Figma file is organized by Storybook hierarchy.** Step 5's calls make a Figma page per `category`, the whole of it (e.g. `Forms`, `Data Display`, `ui/base`), and put a component without a category on a `Components` page, which mirrors the Storybook sidebar so designers can find things where they expect them. Each component's set is named by the last segment of its `title`, the name Storybook's sidebar shows (`Button` for `Forms/Button`, and `Tooltip` for `ui/base/Tooltip` though its `name` is `TooltipContent`), or by its `name` when it has no title, so components that share a name stay apart: `ui/base/Button` and `ui/radix/Button` go to the pages `ui/base` and `ui/radix`. A category's page is found ignoring case, spaces, `/`, `-` and `_`, so a page an earlier push named `UI Base` is still the page for `ui/base`. A set is found on its page by its name, inside a section or frame a designer moved it into too, and where none has the name, by the Storybook `id` an earlier push stored on it, so a set a designer renamed is still updated in place, under its own name; one an earlier push named by a component's `name`, where that differs, is found the same way: name it in the summary. You make no page or set yourself.

5. **Build with the calls `figma code` writes, and write no styling code.** Every `use_figma` call of the push is a file `figma code` generates from the snap. You send each one unchanged and save Figma's response to it unchanged; storysync does the rest. Never write, edit, shorten or summarize a call's code, and never edit a saved response: a call changed on the way builds what snap didn't measure, and `verify` checks each response's checksum.

   First save the tokens, once Tokens step 3 has made their variables, so the build binds each fill, stroke, text color and corner radius to its variable (Variable binding, below):

```bash
npx storysync tokens --json --project . > .storysync/tokens.json
```

   Then write the calls, with `--components` and the IDs step 1 agreed on, unless the user chose every component, and `--skip` with any the user chose not to push in step 3:

```bash
npx storysync figma code --components <the agreed IDs>
```

   It reads `.storysync/snaps/styles.json` and `.storysync/tokens.json`, and writes `.storysync/figma/plan.json` and the calls under `.storysync/figma/calls/`, in this order: a `variables` call for each collection whose alpha variables the builds bind, where they bind any; the builds, a page at a time, several sets a call; an `images` call for each page that shows a picture; one `label` call; and the reads, a page at a time. It prints each call, each value the project's base styles bound, starting `=` (Variable binding, below), then its warnings. Note each warning for the summary:

   - `built as a "Not measured" placeholder`: variants snap couldn't measure (step 3), each built as a dashed frame labeled `Not measured: <status>`, all of a component's where snap measured none of it.
   - `left unbound: it matches …, and no class names one`: a value several variables share, left unbound rather than bound to a guess (Variable binding, below). It ends `its classes name two of them, …` instead where the element's classes name several of those variables, which tie, as an Alert title's `text-card-foreground`, inherited from its root, and its own `text-foreground`: name both in the summary. `radius … left unbound: its background stops inside its … border …`: a radius its token holds, built at the inner radius the padding box draws with, which no token holds, so the fill stops short of a translucent, dashed or partly transparent border as the browser's does. A border transparent on every side draws nothing, so its frame is built at the border box, its radius bound, and `background-clip padding-box inside a transparent border is built as a fill to the border box`: the fill runs under the clear stroke, the border's width past where the browser stops it, since Figma insets no fill.
   - `… is not built`: something Figma can't draw, such as a radial gradient or a backdrop filter. `… is built as …`: something Figma draws another way, such as per-side border colors as one color, a turn the build leaves out, as the element's own box unturned (a childless layer's turn out of the flow, or in it at 180 degrees or 90 on a square, is built turned), or a ring's spread on a frame something draws past, as the shadow without its spread: Figma draws a spread only on a frame that clips and has a fill, so the build clips a frame with a ring where nothing draws past it, and gives one without a fill a fill that draws nothing, which the readback leaves out. `verify` lists each under coverage, but for a spread built without, which it scores as drift on the frame's effects.
   - `… so it is built without auto layout`: a frame whose children Figma's auto layout can't place where the browser did, such as a wrap onto two lines, built with each child at its measured place.
   - `not built: its N nodes need N characters of code`: a variant too big for one call, which `verify` reports missing from Figma.
   - `holds one variant of N characters, over --max-chars` or `of N nodes, over --max-nodes`: a variant too big for the calls' usual size, in a call of its own, which is still within `use_figma`'s 50,000 characters. If it throws `Script exceeded time limit`, say so in the summary.
   - `no tokens at …`: the tokens weren't saved, so nothing would be bound: save them as above and run `figma code` again.
   - `snap measured it in the dark theme`: the preview rendered that component dark, so its paints bound by the tokens' dark values, and the label call puts its set in each collection's `Dark` mode, where they show as measured (Variable binding, below), and takes it back off once a push measures it light, unless a designer has changed the mode since. Say so in the summary, and that snapping it in the light theme binds it by light values.

   **The alpha variables come first.** Where `figma code` prints `Translucent paints bind to N alpha variables`, `alphas` in `--json` and the plan, the plan's first call, a `variables` call, makes them beside their tokens (Tokens step 3), each with the tokens it is made from, and changes nothing where an earlier push made them: send it as the plan's other calls, first. Its response's `alpha`, `created`, `updated` and `unchanged` say what it made: keep them for the summary. It lists nothing stale and removes nothing. A build sent before it binds the token at the paint's opacity, which Figma resets to 1 at a mode switch, and leaves a shadow unbound, each listed in its `fallbacks` as `no alpha variable destructive 10%: …`, which `verify` lists under the score: send the `variables` call, then that build call again.

   Running `figma code` again writes the plan anew, and removes the calls and results an earlier run left in `.storysync/figma`, except an earlier push's whose read calls Figma answered: it moves that plan to `.storysync/figma/earlier/<digest>/` and prints the path, and `verify --plan` with that path still scores the earlier push.

   **Show the estimate, and ask before sending anything.** `figma code` ends with an `Estimate:` line, `estimate` in `--json`: how many calls, the characters of code you'll send and read back, and the agent tokens to plan on for this push, setup and verification included, beside the rule of thumb (100k a component plus 100k a push). A push isn't lightweight: every call passes through your context. Before you send the first call, show the user that line, with the warnings above, and ask whether to go ahead. Send nothing until they say yes. If they'd rather spend less, offer to push fewer components now: run `figma code` again with a shorter `--components`, and push the rest in another session.

   **Send the calls in `seq` order.** Read `.storysync/figma/plan.json`. For each entry of its `calls`, in order, call `use_figma` with `code` the contents of the entry's `file` (under `.storysync/figma/`), exactly as they are, `description` the entry's `description`, your `fileKey`, and `skillNames: "figma-use"`. A file is at most 45,000 characters, or up to `use_figma`'s 50,000 for a call that holds one large variant, which `figma code` warns about, and its first line names its call. Then **save the response unchanged** to the entry's `result` path, under `.storysync/figma/` (`results/01.json`): the text `use_figma` returned, whole, as it came, before you send the next call. Don't reformat it, trim it or copy parts of it: `verify` reads the files itself.

   A build call restyles a set an earlier push built in place: it finds each variant by name and each layer by the key it stored on it, restyles what changed, adds what's missing and removes the layers snap no longer measures, so node ids, and the instances built on them, survive. An icon whose shapes were recolored or changed in Figma is imported again, as measured, under a new node id. Where an earlier storysync built the set root-only, the build replaces that push's label and icon layers, and counts them in its response's `migrated`. A layer a designer added inside a variant is left alone and counted in `designerLayers`. Each set is laid out as a grid in snap's order, the first property's values as rows, with a variant snap doesn't have in a row below the grid (`extra`), and the variant of each property's first value top left, where Figma takes its default from: the component's own default, unless a property is marked `defaultAssumed: true`, whose default Storybook's docs don't give, so its `defaultValue` is a guess: name those in the summary. A new set goes below everything on its page. A build's response gives, per set, `added`, `updated`, `migrated`, `designerLayers`, `extra`, `overlaps` and `absoluteContainers`, and for the call `fonts`, the stand-ins for fonts Figma lacks, `unbound` and `fallbacks`: keep them for the summary.

   **Pictures.** A build call whose response lists `uploads`, `[[nodeId, assetId], …]`, has left those layers empty for their pictures: `use_figma` can't create an image, and `upload_assets` is how one gets into Figma. Right after that call:

   1. Call `upload_assets` with your `fileKey`, `count` the number of uploads, `nodeIds` the uploads' node ids in the order listed, and `scaleMode: "FILL"`, leaving out `batchCommit`.
   2. Save its response unchanged beside the call's result, with `.upload.json` for `.json` (`results/03.upload.json` for call 3).
   3. Run `npx storysync figma upload --plan .storysync/figma/plan.json --seq 3`, with the call's `seq`. It posts each thumbnail snap saved to the URL `upload_assets` gave its layer, as its own type, and prints a line for each.

   Each URL takes one upload: if `figma upload` fails, call `upload_assets` again for new URLs, save that response over the last, and run it again. The plan's `images` call fills the other layers that show the same picture, and a later push reuses a picture already in the file rather than uploading it again. An `images` response that lists asset ids in `unfilled` found no uploaded picture for them: check that `figma upload` posted every upload of the build calls that listed them, run it again with new `upload_assets` URLs where it failed, then send the `images` call again.

   **Reads that continue.** A read call stops before its response nears `use_figma`'s 20kb and says in `more` where it stopped. After saving a read call's response, run `npx storysync figma next --plan .storysync/figma/plan.json --seq <its seq>`. It says there is nothing left to continue, or prints the file of a call that reads the rest, its description, and where to save its response (`results/07b.json`). Send that file the same way, save its response there, and run `figma next` again, until it says there is nothing left. Do the same after sending a read call again: the continuations saved after it the time before hold Figma as it was then, so `figma next` asks for each of them again, saying it `was read before the result it continues`; send it and save its response over the old one.

   **If a call throws**, Figma's error is its response, and a build call removes the variants it created for that set before it fails, so none is left loose on the page. Deal with what the error says, then send the same call again, saving its response over the error. Every call can be sent again: a build finds what it made before and changes only what differs.

   - `This call differs from the file storysync figma code wrote`, or `figma next wrote` for a read's continuation: the code that reached Figma isn't the file's exact contents. A character changed on the way, as one pasted by hand can: each call carries a checksum of its data, `SUM`, and one of its template, `TSUM`, and checks both before it changes or reads anything, so nothing was changed. Send the file again, its contents exactly as they are, and save the response over the error. Never edit the file, its `SUM` or its `TSUM` to make it pass: run the command that wrote it again if the file itself changed.
   - `Script exceeded time limit`: the call did more than Figma allows a call. Run `figma code` again with `--max-nodes 200`, which makes smaller calls, and send the new plan's calls from the first: those already done change nothing the second time.
   - `The page has COMPONENT_SET "…" (…), COMPONENT_SET "…" (…): ask the user which to update`: two sets of the component's name, or with its id, are on the page. Ask the user which is the component's, and in a call of its own, rename the other or clear its id (`node.setSharedPluginData('storysync', 'id', '')`).
   - `… it is another component: ask the user whether it is …`: a set of this name carries another component's id. If the user says it is this component's, clear its id in a call of its own; otherwise skip the component: run `figma code` again with it in `--skip`, and send the new plan.
   - `… this part builds a COMPONENT: ask the user whether to convert it or skip it`, or `… this part builds a COMPONENT_SET …`: a component with no variant properties is one plain component, not a set, and a push before 0.4.0 built one as a set of one variant named `''`, which Figma renames `=` and marks as broken; a plain component an earlier push built may since have gained variant properties. Ask the user whether to convert it or skip the component, and do neither on your own. To convert the old set, in a call of its own, put its one variant where the set is, in the set's parent, and give it the set's name, which keeps every instance of it linked (`const { parent, x, y, name } = set; parent.insertChild(parent.children.indexOf(set), variant); Object.assign(variant, { x, y, name })`), then remove the set if Figma left it behind (`if (!set.removed) set.remove()`); to convert a plain component, combine it into a set of its own where it is (`const { parent, x, y, name } = component; const set = figma.combineAsVariants([component], parent); Object.assign(set, { x, y, name })`), and name the variant from snap's default combination. Then send the call again.
   - `The set "…" has auto layout (…)`: auto layout would place the variants itself. Ask the user whether to turn it off (`componentSet.layoutMode = 'NONE'`, in a call of its own) and send the call again, or to skip the set, saying in the summary that it was not pushed. Do neither on your own.
   - `The set "…" has 2 variants named "…", not one`: an earlier push or a designer made the variant twice. Report it. Remove the stale copy only after checking which one is current, or after asking the user which to keep, then send the call again.
   - `Variants "…" and "…" overlap`, `… is not where the layout put it`, `… lies outside the set`, or `The set's layers are not in the order it was laid out in`: Figma didn't lay the set out as the build asked. Report it with the set's name; don't move variants by hand.
   - `Found 0 sets with storysync id …` from a read call, or `No page named "…"` or `No page "…"`: the set's build call didn't run, or failed: send it, then this call. The label call lists such sets in its response's `missing` instead. `Found 2 sets with storysync id …`: a copy of the set carries its id; ask the user which is the component's, and clear the other's id in a call of its own.
   - `Variants … and … of "…" carry the slug …: one was duplicated`: a designer duplicated a variant. Report it, and ask the user which to keep.

   A response's `overlaps` other than 0 means its set lies on other sets, as a push before 0.4.0 left every set at `0,0`. Ask the user whether to move it below the rest of its page, in a call of its own (`node.y = Math.max(...node.parent.children.filter((n) => n !== node).map((n) => n.y + n.height)) + 100; node.x = 0`), and say in the summary which sets overlap and whether they were moved; never move one on your own. The `label` call writes the line of each set's description that starts `storysync:`, for a component snap measured from a closed trigger or a layout wrapper, keeping every other line, and removes Figma's default page `Page 1` while it is empty and not the file's only page: its response's `pageOne` says which (`removed`, or why it was kept).

6. **Score what Figma holds.** Once every call is sent and every response saved:

```bash
npx storysync verify --plan .storysync/figma/plan.json --strict-age
```

   `verify` reads the responses saved for the read calls, assembles them into `.storysync/figma-readback.json`, which can be committed for CI, and scores Figma against snap element by element: each element's place and size, fills, strokes, radii, shadows, opacity and blend, a text's characters, font and fit, an icon's shapes and colors, and a picture's bytes. Never write `.storysync/figma-readback.json` or a saved response yourself. Add `--skip` with the IDs of any component the user chose not to push (step 3), or that you skipped in step 5, as in `--skip ui-base-dialog,ui-base-sheet`: `verify` leaves them out of the score and names them under it, where otherwise it lists each of their variants as missing from Figma.

   It starts with the score:

```text
Fidelity: 99.3% of elements (287 of 289 verified), 99.6% of properties (3,412/3,426)
  worst: ui/base/Attachment 96.7% of elements
  missing 1 · drifted 1 · extra 0 · designer layers 0 · not measured 14
  coverage 99.8%: not scored: per-side border colors on ui/base/InputOTP › input-otp-slot:6
  ~ ui/base/Switch size=sm › switch-thumb: fills measured #ffffff, Figma #f5f5f5 (node 14:9)
```

   **Element fidelity is the score**: each element scores the share of its properties Figma matches, and 0 when it is missing, of another kind (a frame where snap measured an icon), hidden, or has the wrong characters, shapes or picture. The share of properties is beside it. The lines under it name what differs, missing elements first, each by component, variant, key and Figma node id. The coverage line names what Figma can't represent, which is listed rather than scored, and at 100% says every property was scored.

   **Do not fix drift by hand, and send a build again only for drift a resend can change.** The build comes from the measurement, so a layer edited in Figma is one the next push undoes, and a build call sent again builds exactly what it built before. So drift the build made itself stays as it is: a `family` the build responses' `fonts` name a stand-in for, and the text widths, wraps and positions the stand-in moves; a text Figma sets a pixel or so wider than the browser, and what that moves; an icon's `shapes`, as Figma's SVG import draws them; a `truncation`, or a text the responses' `fallbacks` name; a border `style` Figma's strokes lack. Report that, by key and node id, as a font stand-in or a limit of the mapping, and send nothing for it: on coder, sending both builds and all six reads again for such drift cost about 120k characters and changed nothing. Send a component's build calls again (the calls in plan.json whose `components` include it), then its read calls, continuing them with `figma next` as before, and run `verify` again, only where something besides its build made Figma differ: its build response failed or came back cut short, a layer was edited in Figma since the build, or the build was sent from an earlier plan. **Stop after two rounds** and report the residual score. `use_figma` calls are rate-limited and becoming a paid feature; an unbounded repair loop burns that budget for diminishing returns.

   What else it can say, and what to do:

   - `planned read call N wasn't read whole`: the plan's lines below the score say why. `call N: no result saved at …`: send that read call, or the continuation `figma next` asks for, and save its response. `… holds no read result`: the call failed, and its response is the error; deal with it as step 5 says. `… was read before …, which it continues`: a read call was sent again without its continuations; run `figma next` for it, as above, and send what it asks for. Then run `verify` again. The variants the call didn't read are counted as `not read`, never as missing from Figma, and aren't scored, and the run fails `--strict` until they are read.
   - `so what it scores is Figma before …, not now`: a read call's response was saved before a build call of its components was sent again, so it read what that build replaced. Send that read call again, continuing it with `figma next` as before, save its response, and run `verify` again. Until then the run fails `--strict` and never says Figma matches.
   - A readback entry that `does not match its checksum`: a saved response was changed after Figma returned it. Send that read call again, save its response unchanged, and run `verify` again. Never edit a saved response to make it pass. An entry that `is incomplete`, `is stale`, read before the snap, or is a part that doesn't add up, is read again the same way, now.
   - An entry sealed under another name than the variant snap measured: a variant renamed in Figma. Report it.
   - `read back without its tree, so only its root was compared`: those entries were read with the root-only readback. Send this plan's read calls.
   - `a layer nothing keyed, "…" (TYPE, node …): a designer's, not scored`: a layer a designer added inside a variant, which the build leaves alone. It fails `--strict`. Ask the user whether it belongs there; if it does, run `verify` again with `--allow-designer-layers`, and name it in the summary either way.
   - A text that drifts on `truncation`, measured `"cut":false` and in Figma `"cut":true`: Figma cuts it short, ending it in an ellipsis, where the browser drew it whole, since its font sets the text wider than the box it fills, and the build named it `cut short`. Measured `"cut":true` and in Figma `"cut":false` is the reverse, a text Figma shows whole that the browser cut. Sending the build calls again changes neither: report each, by key and node id. A readback from before verify could see this has no `cut`, and is scored on the truncation set alone.
   - `but snap no longer measures it`: a layer an earlier push built for an element the code no longer renders. Sending the component's build call removes it.
   - `not measured …, so Figma holds a placeholder for it`: a variant snap couldn't measure (step 3), with why in parentheses, its status and error. Not scored, and `--strict-measured` fails on it. The line ends `snap's warning names the story change it needs` only where snap's warning names one (an `arg_rejected` variant's); otherwise the error is all snap knows. The `could not be measured` line under the score names each component with variants not measured, and how many.
   - `made this plan from it`: the snap isn't the one the plan was made from: a component the plan built was measured again after the plan was written, or the snap passed as `--snap` measured it otherwise. A later snap of other components alone doesn't count: `verify --plan` scores only the components the plan built, so the ones `styles.json` keeps from other pushes are neither changed nor missing from Figma. Where the line goes on that Figma says components were `built from an earlier measurement than this snap's`, run `figma code` again and send its calls; until then the run fails `--strict`. Where it says `so the score stands`, every variant scored was built from what the snap measures: send nothing.
   - What snap warned about the measurement, under the score (a closed trigger, variants or values that measured alike, values Storybook wouldn't take or took only through its preview, args snap couldn't check, a font the browser couldn't render, and any other warning, which it quotes as snap wrote it): report it, as step 3 says. With `--json`, these are its `caveats`.
   - `! snap recorded a failure`: the measurement itself is incomplete, not Figma. Where it names a component's error, measure that component again (step 3, with `--merge`); where it says components share a key, or that the snap recorded no components, do what snap warned and run the whole snap again.
   - `Bound without their alpha variable`: a build sent before the plan's `variables` call bound those translucent paints to their tokens at an opacity, which a mode switch turns opaque, and left those shadows unbound, by call and layer. No readback shows a binding, so the score can't, and the run fails `--strict`. Send the plan's first call, then those build calls and their read calls again, and run `verify` again.
   - `Alpha variables the plan made that no build with a result binds`: the plan's first call made each for components whose build calls saved no build result, as when a build failed, so no layer binds it. Send those build calls again; if the user doesn't want those components built, ask whether to remove each with `npx storysync figma tokens --remove "Colors/destructive 90%"` and send its calls (Tokens step 3). Note what they chose for the summary.
   - `Variables:` the element-tree readback doesn't read variable bindings yet, so a token detached in Figma at the same value can't be seen. Say so in the summary.

7. Summarize what was synced: token collections, with their modes and what Tokens step 3's calls created, updated and left unchanged, the alpha variables the plan's `variables` call made or found (`alpha`), and, where a collection holds the light theme alone though its tokens have `dark` values, why (Tokens step 3's `darkError`), the tokens left out, and the stale and conflicting variables with what the user chose for each (Tokens step 3), components grouped by page, whether the label call removed Figma's default page `Page 1` or why it kept it (its `pageOne`), variant counts, the components built as one plain component for having no variant properties, **the fidelity score, worded as `verify` words it: element fidelity, with the share of properties beside it**, and where its line says entries were `unverified, not scored`, how many entries it left unverified, which the score doesn't cover; the coverage `verify` gives, with what it couldn't score; the variants built as a `Not measured` placeholder, each with why, and the story change snap's warning names where it names one; any components whose stories did not pass their args through, any props snap found reach a component but change nothing it measures, and what the user chose for them, any variant snap marked `argsChecked: false`, each component's `argsNotInDocs` and `excludedProps`, each component measured from the story `--stories` named, with the story and its `!` where it had one, for an audit to measure from it too, the variants snap measured from a story of their own, as its output says, each overlay snap opened to measure and how, as its `measured open` line says, each component snap measured as a closed trigger or a layout wrapper, why snap didn't open it, and what the user chose for it (step 3), what `verify` printed under the score about what snap measured; the frames built without auto layout (`figma code`'s warnings and the build responses' `absoluteContainers`), the layers of an earlier root-only push the build replaced (`migrated`), and the designer layers `verify` listed, with what the user chose for them; the values left unbound because several variables share them, or because the build draws them at a value no token holds, from `figma code`'s warnings and the build responses' `unbound`; every font stand-in the build responses returned in `fonts` (a CSS keyword such as `system-ui` set in Inter, a platform face such as Menlo in Roboto Mono), which snap measured that text in too where its `fontStandIns` says so, and any `fallbacks` they list, where `kept on one line` or `cut short` means Figma sets a text wider than snap measured it, which a snap taken again measures in Figma's font, and `verify` scores a text cut short as drift on its truncation, and `no alpha variable …` means a translucent paint was built without its alpha variable, which a mode switch turns opaque (step 5); which variant Figma will treat as a set's default where that is not the component's default (step 5); any set skipped for its auto layout, any component skipped for a set or plain component of its name an earlier push left (step 5), any set or component a build returned `overlaps` for, and whether the user had it moved; any picture `figma upload` couldn't post, or an `images` response left `unfilled`; that `verify` can't yet see variable bindings in an element-tree readback; and any failures or caps.

## Variable binding

`figma code` binds each fill, stroke, text color, icon color and corner radius to a variable from `.storysync/tokens.json`, the `tokens --json` output Components step 5 saves, so that when tokens change in code and storysync runs again, updating the variables updates every component. A measured value matches a token when it equals the token's `hex` for a color, or its `px` for a radius. A translucent color, `#rrggbbaa`, matches a token of its `#rrggbb`, and binds to that token's alpha variable, as Tailwind's `border-destructive/30` is the `destructive` token at 30%, bound to `destructive 30%`, which the plan's first call makes (Tokens step 3). Where a `dark:` class paints the token at another alpha, shadcn/ui's destructive button's `bg-destructive/10 dark:bg-destructive/20`, it binds to one that holds each theme's, `destructive 10% dark 20%`: snap keeps a `dark:` class's opacity for it, and a snap from before this version, which cut it off, binds `destructive 10%`, at 10% in Dark too: snap again for it. Several tokens often share a value: on shadcn/ui, `#171717` is five color tokens, `primary` and `sidebar/primary` among them. Then the classes snap recorded on the element pick the one the source names: `bg-primary` binds the fill to `primary`, `text-card-foreground` the text to `card/foreground`, `border-input` the stroke to `input`, and `rounded-lg` the radius to `lg`. A token whose key is `DEFAULT` is named both ways, so coder's `border-border-default` names `border/DEFAULT` as `border-border` does, in any case. A class with a state, `disabled:text-content-disabled` or `data-[highlighted]:text-content-primary`, names the token for that state, which may be the one measured, and a text takes those of the element it inherits its color from too: coder's disabled Button label binds to `content/disabled`. Where the classes name two, as an outline button's `border-border dark:border-input` does, the one a `dark:` class names binds: it has the light value too, and is the token the dark theme paints, so its variable is right in both modes. Where no class names one, the project's base styles can, as `tokens` reads them into `defaults`: shadcn/ui's dialog title has no color class and inherits `body`'s `text-foreground` from `@layer base`, and a card's border takes `* { @apply border-border }`, so the title binds to `foreground` and the border to `border`, and `figma code` prints each such binding with the rule, starting `=`. Snap records the text color class a text inherits from the nearest element around it, past the component's root too, and the base style counts only where snap found that no class sets the color at all: a palette or arbitrary color (`text-neutral-950`, `text-[#0a0a0a]`) on the element, or on one it inherits from, names no variable, and keeps the value unbound. Where a style sheet or an inline style gives the color by a custom property, not a class, the properties behind it name the token as a class would: Sonner's toast is `background: var(--normal-bg)`, and shadcn/ui's Toaster sets `--normal-bg: var(--popover)` on it, so the toast binds to `popover` and its text to `popover/foreground`. Where none of these names one in a project with a dark theme, a value whose tokens all hold the same value in Dark too binds all the same, since any of them is right in both modes: coder's `#e4e4e7` border is `border/DEFAULT`, `input` and `surface/tertiary`, each `#27272a` in Dark, so it binds to the base style's, `border/DEFAULT`, or else to the first, and `figma code` prints it with the others starting `=`, naming them. Otherwise the value is left unbound, and `figma code` warns with the variables it matches: list them in the summary rather than bind one by hand. A `tokens.json` saved before `defaults` has none, and a snap from before this version doesn't say what no class colors: save the tokens, or snap, again for these. The build finds each variable by its name in the file, as Tokens step 3 created it from `tokens`, so a name Figma has none of, or two of, leaves the value unbound too, listed in the build response's `unbound`. Values are matched by the tokens' values in the color scheme snap measured the component in, its `scheme` in styles.json: the light theme's, or, where the preview rendered dark, the dark theme's, so a dark `#ffffff` text binds to the token whose dark value it is, never to one whose light value happens to be `#ffffff`. `figma code` warns for each component measured dark, and the label call puts its set in each collection's `Dark` mode, unless a designer chose a mode for it, so the paints show as measured, and `Light` shows each token's light value; a translucent paint measured dark keeps its dark alpha in Light too. Where a `dark:` class names another color than the light class, as shadcn/ui's outline button's `bg-background dark:bg-input/30` does, the paint binds to a per-mode variable of the two, `background dark input 30%` (Tokens step 3), so a frame switched to `Dark` shows the dark theme's color; a fill only the dark theme paints, an input's `dark:bg-input/30`, is built clear in Light and bound to `input 0% dark 30%`; and a pair of palette colors, AspectRatio's `bg-slate-50 dark:bg-slate-900`, binds to `slate-50 dark slate-900`. A class that styles another box is not the element's evidence: shadcn/ui's alert title's `[&_a]:hover:text-foreground` colors its links, so the title binds to the `text-card-foreground` it inherits; and a `::before` or `::after` takes its host's `before:` or `after:` classes, so Avatar's ring, `after:border-border`, binds to `border`. A blend mode isn't a variable in Figma, so Avatar's `dark:after:mix-blend-lighten` stays the light theme's. Wherever a designer switches a frame, or a frame around it, to the Dark mode, Figma resolves each bound paint again to its variable's `Dark` value, its color and its alpha as the paint's opacity, a bound shadow's color and alpha alike, and back in Light to `Light`'s: so a translucent paint binds to its alpha variable, which holds the alpha in both modes, never to its token at an opacity, which the first switch would make opaque for good. A push sent again into a set a designer left in Dark binds each paint afresh, so it shows `Dark`'s values there as a switch would, and the variants it adds are built in the set. A shadow's color binds only where a `ring-*` or `shadow-*` class names its token, never by its value alone, as shadcn/ui's dialog's `ring-foreground/10` binds its ring to `foreground 10%`: Tailwind's default shadow scale draws in a black no token was set from. A full radius (`rounded-full`) binds only to a token named `full`, never to the step of the scale that equals a circle's half, as `md` does on a 16px radio item, which a designer editing `md` would make square; a radius of half the box's shorter side binds by its value only where a class names its token. A project that uses Tailwind's default spacing, type or shadow scales has no tokens for them, so those values stay as measured.

## Root-only snaps (`--root-only`)

storysync 0.3.0 measured each variant's outer element alone, its fill, border, radius, padding, gap and one text style, and the agent built it from templates it filled in by hand. That path remains for a push the user asks to make that way: to restyle the sets a 0.3.0 push built without adding their inner layers, say, or to compare with 0.3.0's numbers. It compares only the outer element, so a set pushed this way can score 100% with its icon missing or its title in the wrong place, and `verify` says of each component that only its outer element was compared. Take the element-tree path above unless the user asks for this one. `figma code` refuses a snap taken this way, and points here.

For a root-only push, Components steps 1 and 2 are as above, step 3's snap adds `--root-only`, and steps 3 to 7 below take the place of the rest:

```bash
mkdir -p .storysync
STORYSYNC_PROGRESS=1 npx storysync snap --storybook http://localhost:6006 --variants all --root-only --json > .storysync/snap-out.json 2> .storysync/snap-progress.log; echo "exit $?" >> .storysync/snap-progress.log
```

Everything step 3 says above about running it, its exit codes, caps, statuses and warnings holds. A root-only snap holds no element trees, and `snap --merge` refuses to mix one with a snap of trees.

3. **Read the measurements**, from `.storysync/snaps/styles.json` on disk, a component at a time. Do not proceed to step 5 without concrete values: a `use_figma` call containing only variant names produces a useless component library. The output gives, per component, full styles for a base variant plus only the properties each other variant changes:

```json
{
  "components": [{
    "id": "forms-button",
    "title": "Forms/Button",
    "variantProperties": [
      { "name": "variant", "type": "VARIANT", "values": ["primary", "danger", "outline"], "defaultValue": "primary" },
      { "name": "size", "type": "VARIANT", "values": ["sm", "lg"], "defaultValue": "sm" },
      { "name": "disabled", "type": "BOOLEAN", "values": ["true", "false"], "defaultValue": "false" }
    ],
    "base": {
      "combination": { "variant": "primary", "size": "sm", "disabled": "false" },
      "slug": "variant-primary--size-sm--disabled-false",
      "styles": {
        "backgroundColor": "#2563eb", "color": "#ffffff",
        "padding": { "top": 4, "right": 8, "bottom": 4, "left": 8 },
        "borderRadiusUniform": 3, "fontSize": 12, "fontWeight": 600,
        "borderUniform": null, "boxShadow": [], "opacity": 1,
        "display": "inline-flex", "flexDirection": "row", "gap": { "row": 6, "column": 6 }
      }
    },
    "variants": [
      { "combination": { "variant": "danger", "size": "sm", "disabled": "false" },
        "slug": "variant-danger--size-sm--disabled-false", "status": "ok",
        "delta": { "backgroundColor": "#dc2626" } }
    ]
  }]
}
```

   A variant's full styles are the base with its `delta` applied. `variantProperties` lists the component's variant properties in order, each with its values and its default: step 5 lays the set out by it. Translate directly:

   | Measured | Figma |
   |---|---|
   | `backgroundColor` | fill (`null` means no fill, not black) |
   | `backgroundClip` | where that fill stops: absent, CSS's `border-box`, it runs under a transparent or translucent border, and `padding-box` stops it at the border (see below); build `content-box` as `padding-box` and name it in the summary. `text`, as Tailwind's `bg-clip-text` gradient labels have, paints the background through the text: give the text the fill (`backgroundImage` or `backgroundColor`), not the frame |
   | `color` / `text.color` | text fill |
   | `padding` | auto-layout padding |
   | `gap.column`, or `gap.row` when `flexDirection` is `column` or `column-reverse` | `itemSpacing`, the gap along the layout's direction (`verify` compares a flex element's gap on that axis alone) |
   | `borderRadiusUniform`, else `borderRadius` | `cornerRadius`, else per-corner |
   | `borderUniform` | stroke weight + color (`null` means no stroke; a `color` of `null` is a transparent border, a stroke with an invisible paint: see below), and its `style` as the stroke's `dashPattern`, for a width `w`: none for `solid`, `[3w, 3w]` for `dashed`, `[w, w]` for `dotted`. Figma's strokes have no `double`, `groove`, `ridge`, `inset` or `outset`: build those solid, and name them in the summary, since `verify` reports their style as drift no edit can fix |
   | a color written `#rrggbbaa` | a translucent color: `#rrggbb` with the paint's `opacity` at `aa` / 255, so `#4b556322` is `#4b5563` at an opacity of 34 / 255, about 0.133; for a shadow, the effect color's `a` |
   | `boxShadow[]` | one effect per layer: `INNER_SHADOW` where `inset` is true, a ring like `ring-inset` included, else `DROP_SHADOW`, with `offset` from `offsetX`/`offsetY`, `radius` from `blur`, and `spread` (`verify` does not read effects back, so it will not flag a shadow built wrong) |
   | `display: flex` + `flexDirection` | auto-layout direction |
   | `fontSize` / `fontWeight` / `fontFamily` | text style, its font loaded with the build template's `loadFont` (see below) |
   | `text.layout` | how the label fits its box. Absent, the browser drew it on one line at its own width: let the text hug it (`textAutoResize = 'WIDTH_AND_HEIGHT'`). Present, the browser fitted it to its box: give the text a fixed width of `layout.width` (`resize(layout.width, text.height)`, or `layoutSizingHorizontal = 'FIXED'` in auto layout) and `textAutoResize = 'HEIGHT'`, so it wraps where the browser did; with a `truncation`, also `textTruncation = 'ENDING'` and `maxLines = layout.lines`, so it ends in an ellipsis after as many lines. Figma has no flat cut, so build a `clip` the same way and name it in the summary. Step 6 reads it back, and `verify` scores a label that hugs where the browser cut it off as drift: a title that hugs runs past its card |
   | `borderUniform` on a hugging frame | `strokeAlign = 'OUTSIDE'`, or `INSIDE` with `strokesIncludedInLayout = true` for a transparent or translucent border the fill runs under (see below) |
   | `width` or `height` of 0 | 0.01, the least Figma's `resize` takes: a closed collapsible's content renders nothing, and is built as next to nothing |

   Five things that go wrong by default, in ways `verify` either will not catch or will not explain:

   - **Stroke alignment: the stroke adds to the size.** snap's `width`/`height` are the element's outer size, border included, and the Figma frame's outer size, its own size plus the stroke outside it, must match them. On an element sized by its content — every inline or inline-flex component, and any auto-layout frame you let hug — a CSS border always adds to the outer size, whatever `boxSizing` says; `box-sizing` only changes how an *explicit* width or height is read. Figma's default, `INSIDE` on a hugging frame, eats into the padding instead and leaves the variant short by twice the border width. So build a border one of two ways on a hugging frame: `strokeAlign = 'OUTSIDE'`, or `INSIDE` with `strokesIncludedInLayout = true`, which adds the stroke to the frame's own size; and on a frame you give a fixed size, `INSIDE` at the measured `width`/`height`. **A transparent border still takes its space.** A `borderUniform` whose `color` is `null`, such as CSS `border: 1px solid transparent`, is in snap's `width`/`height` like any other, so give it a stroke of that weight, aligned the same way, with a paint that draws nothing (`{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0 }`), never no stroke: without one the variant is short by twice the border. Step 6 reads the size from the geometry, which counts a stroke whether its paint shows or not, and reads that stroke's color back as `null`, as snap measured it. **Where the fill stops is `backgroundClip`**, which picks between the two for a transparent or translucent border. The browser paints the background under such a border unless it is clipped to the padding box. With `backgroundClip: padding-box`, as shadcn/ui's Button has (`bg-clip-padding`), the fill stops at the border, as Figma's does at an `OUTSIDE` stroke, so build a translucent, dashed or partly transparent border `OUTSIDE` (on a fixed-size frame, at the measured size less twice the border's weight). A border transparent on every side draws nothing, so build it `INSIDE`, as for an opaque one, with `strokesIncludedInLayout = true` on a hugging frame: the frame is the border box the class rounds, at the radius its token holds, and the fill runs under the clear stroke, the border's width past where the browser stops it, which Figma can't inset; name those variants in the summary. Without it, CSS's `border-box`, as on shadcn/ui's Badge, the fill runs under the border, as Figma's does under an `INSIDE` stroke, so build it `INSIDE`, with `strokesIncludedInLayout = true` on a hugging frame. Either way the size and the stroke's color read back as measured; never paint the stroke to look filled, which `verify` scores as a border color the code does not have.
   - **Lay the variants out.** A component set is a frame containing its variants, each needing its own x/y, and the frame must be grown to fit them. Created without positions they all land at `0,0`, stacked and clipped by a frame still sized for one. Position each variant in a grid — one row per value of the first variant property, the remaining combinations across — with spacing, and size the set to contain them. With every combination built, a single row of dozens of variants is unreadable. **Order the grid by snap's `variantProperties`, never by the set's children**: their order is whatever an earlier push or a designer left, and a set laid out in it gets rows whose columns disagree. Take the properties, and each one's values, in the order snap records them: a `VARIANT`'s default value first, then the rest in the order of the component's prop type as Storybook's docs list it, then any only the story's `argTypes` options list; a `BOOLEAN`'s default comes first, `false` before `true` unless it defaults to `true`. Each column is then one combination of the other properties in every row, and the layers panel lists the variants in the same order. Figma makes the top-left variant the set's default variant, so that is the variant of each property's first value: the component's own default. Step 5's build template does all of this; give it the properties and leave its layout as it is.
   - **Assert the layout before returning.** After positioning, check that no two variants' bounding boxes intersect and that the set's bounds contain every child. Geometry comparison catches variants clipped by an undersized frame, but two same-sized variants stacked inside an adequately sized one measure correctly and stay invisible — so the check has to happen here, at write time.
   - **Figma's plugin context has only Google Fonts.** `listAvailableFontsAsync` returns Google families and nothing else — no Arial, no Helvetica, no SF Pro, no Segoe UI, no Menlo. A designer sees those in the desktop app's picker because it reads their *local* system fonts, but the environment `use_figma` runs in does not have them, and `figma.loadFontAsync` throws on one. So load every text layer's font with the build template's `loadFont(family, weight)`, which never fails the part over a font: it loads the measured family where Figma has it, by Figma's name for it (`Geist` for fontsource's `Geist Variable`: Figma names no family `… Variable`), and otherwise a stand-in at the measured weight, Roboto Mono for a monospace face (Menlo, Monaco, Consolas, `ui-monospace`, `monospace`), Noto Serif for a serif one (Georgia, `ui-serif`, `serif`) and Inter for any other. A weight the family lacks loads as the next one toward Regular, as Roboto Mono, which stops at Bold, sets 800 in Bold: that is a stand-in too, which `verify` scores as `fontWeight` drift. The part returns each stand-in it used in `fonts`, such as `{ "system-ui 600": "Inter Semi Bold", "Menlo 400": "Roboto Mono Regular" }`. Name every one in the summary. A CSS keyword, such as `system-ui`, `sans-serif` or `ui-sans-serif`, is the platform's own font, which no Figma font is named after (a system stack like Tailwind's default `-apple-system, BlinkMacSystemFont, ...` measures as `system-ui`), and `verify` does not score it, so its stand-in is not drift. A platform face such as Menlo or SF Pro is scored, so its stand-in shows as `fontFamily` drift no edit in Figma can fix: report it as the substitution it is; the real face is the user's to install or map in the desktop app.
   - **`fontAvailable: false` means the measurement describes a substituted typeface.** `fontFamily` is the family the browser drew with, except a named font it could not load that the stack lists before any system keyword (such as `-apple-system` or `ui-monospace`), which is recorded as the code *asked for* it, with `fontAvailable: false`: the geometry and text you measured are not the intended font's. Say so in the summary. If Figma also lacks the font, name it explicitly — "Figma has no *Inter*; install it or map it" — rather than letting it surface as unexplained text drift. storysync cannot install fonts into Figma; that is a manual step in the desktop app.

   **What snap couldn't measure.** Measure it again first, as Components step 3 says. Only for what still fails, and only in this root-only push (a push through `figma code` builds it as a placeholder instead), fall back to reading the component's source (`.tsx`/`.jsx`, CSS modules, styled-components, inline styles, `cva`/`clsx`/`cn` calls) and resolve any design tokens through `npx storysync tokens --json` or the project's own config — never from a memorized class-to-value table, which is wrong for any project with a custom palette.

   **Every fallback must be recorded, not just mentioned.** In step 6 you will write a `source` of `"measured"` or `"inferred"` for each variant. A run inspected later must be able to tell the difference without reading this conversation.

   **Checkpoint before step 5**: every variant has either measured styles or an explicit source-derived spec, as Components step 3 says.

   **Label the sets after the build, on every push.** Once step 5 has built them, make one `use_figma` call with the template below, giving it every set and plain component this push built, by the id step 5 returned: a note for each one built from a closed trigger or a layout wrapper, and `''` for every other. It replaces only the description's line that starts `storysync:`, keeping every other line, a designer's own included, and an empty note removes the line an earlier push left. So a set rebuilt once its story renders it open no longer says it was measured from its trigger. Figma returns a description HTML-escaped, `"` as `&quot;` and `&` as `&amp;`, so one written back as it was read gains another escape on every push (a live push left `button[data-slot=&quot;dialog-trigger&quot;]` on Dialog): the template reads it unescaped, edits a designer's formatted description through `descriptionMarkdown` so their formatting stays, and writes only a description it changed, so a second run changes nothing.

   The same call removes Figma's default page, `Page 1`, once the push has put every set on a page of its category, but only while it is as Figma made it: still named `Page 1`, empty, and not the file's only page. It returns `pageOne`: `removed`, `kept: it holds layers`, `kept: it is the only page`, `kept: Figma refused to remove it` with Figma's reason, or `none` where the file has no page of that name. It loads the page to count its layers without switching to it, so the user stays on the page they are on, unless that is the `Page 1` it removes. Say in the summary which it was; a page a designer renamed or used is left alone.

```js
use_figma({
  code: `
    // Says on each set what snap measured, on the line of its description
    // that starts with MARK, and keeps every other line, a designer's own
    // included. An empty note removes the line an earlier push left.
    const MARK = 'storysync:';
    const NOTES = {
      '12:34': 'measured from its closed trigger, button[data-slot="dialog-trigger"], not the open dialog',
      '12:56': '',
      // ... one entry per set or plain component this push built, by the id step 5 returned
    };
    const NL = String.fromCharCode(10), BS = String.fromCharCode(92);
    // Figma returns a description HTML-escaped, " as &quot; and & as &amp;,
    // so one written back as read gains an escape on every push: read it
    // unescaped, once. A designer's formatted description is markdown in
    // descriptionMarkdown: edit that where there is one, so the formatting
    // stays, with the note's markdown characters escaped, and the plain
    // description otherwise. Write only a description this changes.
    const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
    const unescape = (s) => (s || '').replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, e) => ENTITY[e]);
    const SPECIAL = '*_[]<>' + String.fromCharCode(96) + BS;
    const markdown = (s) => [...s].map((c) => (SPECIAL.includes(c) ? BS + c : c)).join('');
    const changed = [];
    for (const [id, note] of Object.entries(NOTES)) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node || (node.type !== 'COMPONENT_SET' && node.type !== 'COMPONENT')) {
        throw new Error('No component set or component has the id ' + id);
      }
      const rich = Boolean(node.descriptionMarkdown);
      const key = rich ? 'descriptionMarkdown' : 'description';
      const before = unescape(node[key]);
      const lines = before ? before.split(NL).filter((line) => !line.startsWith(MARK)) : [];
      if (note) lines.push(MARK + ' ' + (rich ? markdown(note) : note));
      const after = lines.join(NL);
      if (after !== before) {
        node[key] = after;
        changed.push(id);
      }
    }
    // Figma's default page, left empty once every set is on its category's
    // page: removed only as Figma made it, named Page 1 and empty, while
    // another page remains. loadAsync loads it, so its layers count, without
    // switching to it: the user stays on their page, and is moved off Page 1
    // only to remove it, and back if Figma refuses.
    let pageOne = 'none';
    const blank = figma.root.children.find((p) => p.name === 'Page 1');
    if (blank) {
      await blank.loadAsync();
      const other = figma.root.children.find((p) => p !== blank);
      pageOne = blank.children.length ? 'kept: it holds layers' : !other ? 'kept: it is the only page' : 'removed';
      if (pageOne === 'removed') {
        const onIt = figma.currentPage.id === blank.id;
        if (onIt) await figma.setCurrentPageAsync(other);
        try {
          blank.remove();
        } catch (e) {
          pageOne = 'kept: Figma refused to remove it (' + String((e && e.message) || e) + ')';
          if (onIt) await figma.setCurrentPageAsync(blank);
        }
      }
    }
    return JSON.stringify({ changed, pageOne });
  `,
  description: "Label the sets measured from a closed trigger or a layout wrapper in their descriptions, and remove Figma's empty default page",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

4. **Organize the Figma file by Storybook hierarchy.** Create one Figma page per `category`, the whole of it (e.g. `Forms`, `Data Display`, `ui/base`). Components without a category go on a `Components` page. Place each component set on its category's page, named by the last segment of its `title`, the name Storybook's sidebar shows (`Button` for `Forms/Button`, and `Tooltip` for `ui/base/Tooltip` though its `name` is `TooltipContent`), or by its `name` when it has no title. This mirrors the Storybook sidebar so designers can find things where they expect them, and keeps apart components that share a name: `ui/base/Button` and `ui/radix/Button` go to the pages `ui/base` and `ui/radix`. Step 5's template finds a category's page ignoring case, spaces, `/`, `-` and `_`, so a page an earlier push named `UI Base` is still the page for `ui/base`. A set an earlier push named by a component's `name`, where that differs, is left as it is: name it in the summary.

5. Write to Figma with `use_figma`. The instruction MUST embed the measured values from step 3 — every variant needs a concrete fill, text color, padding, radius, border, font size, and shadow. A call that only references variant names is a bug; refuse it and re-read the snap output.

   **Update in place rather than duplicating.** Before creating a component set, look for one with the same name anywhere on the target page, inside a section or frame a designer moved it into too, and update it if found. Running a push twice must not produce two `Button`s. The same applies to variable collections — reuse a collection of the same name instead of creating a second.

   **A component with no variant properties is one plain component, not a set.** Its snap combination is empty, so its one variant is named `''`: give the part `PROPERTIES` of `[]` and that one variant, and the template builds a plain component, named and placed as the set would be, and restyles it in place on the next push. A push before 0.4.0 built one as a set of one variant named `''`, which Figma renames `=` and marks as broken (`Component set has existing errors`), so reading its properties throws. The template will not build beside one: it throws `The page has COMPONENT_SET "…" (…): this part builds a COMPONENT …` before changing anything, as it does `The page has COMPONENT "…" (…): this part builds a COMPONENT_SET …` for a plain component an earlier push built, which carries the component's id, whose code has since gained variant properties. A designer's own plain component of the name, with no id, is left alone. Ask the user whether to convert it or to skip the component, saying so in the summary; do neither on your own. To convert the old set, in a call of its own, put its one variant where the set is, in the set's parent, and give it the set's name, which keeps every instance of it linked (`const { parent, x, y, name } = set; parent.insertChild(parent.children.indexOf(set), variant); Object.assign(variant, { x, y, name })`), then remove the set if Figma left it behind (`if (!set.removed) set.remove()`); to convert a plain component, combine it into a set of its own where it is (`const { parent, x, y, name } = component; const set = figma.combineAsVariants([component], parent); Object.assign(set, { x, y, name })`), and name the variant from snap's default combination. Then re-run the part.

   **A new set or component goes below everything on its page**, 100 below the lowest thing there, at the page's left edge, rather than at `0,0` on top of another; one already on the page stays where it is, wherever a designer moved it. A push before 0.4.0 left every set at `0,0`, one on top of another, so each part returns `overlaps`, how many other sets and components its set lies on. Where that is not 0, ask the user whether to move it below the rest of its page, in a call of its own (`node.y = Math.max(...node.parent.children.filter((n) => n !== node).map((n) => n.y + n.height)) + 100; node.x = 0`), and say in the summary which sets overlap and whether they were moved; never move one on your own. **Each carries its Storybook `id` and `title`** as shared plugin data, `node.getSharedPluginData('storysync', 'id')` and `'title'`: give the part the component's `id` as `ID` and its `title` as `TITLE`, `null` where it has none. The first part finds an earlier set by its name, and where none has the name, by that id, so a set a designer renamed is still updated in place, while a copy of a set, which keeps its id, is not taken for it; and the audit can pair a set with its component by it. A set of its name that carries another component's id is refused, `… it is another component: ask the user whether it is …`: if the user says it is this component's, clear its id (`node.setSharedPluginData('storysync', 'id', '')`) in a call of its own and re-run the part; otherwise skip the component.

   **Set colors with `setPaints`, and fonts with `loadFont`.** Set every fill, stroke and effect with the template's `setPaints(node, 'fills' | 'strokes' | 'effects', items)`, never by assigning it: each item is a paint or effect in its measured color, with `variable` set to the color variable to bind, if any. Figma gives a paint freshly bound to a variable the variable's color and alpha, in the mode its node is in, and a shadow its variable's alpha: a live push read Attachment's error border, `#df22254d` bound to `destructive`, back as `#df2225` at opacity 1. So bind a translucent color to its alpha variable, `destructive 30%`, which holds its alpha in each mode (Variable binding for a root-only push), made before the first part with `npx storysync figma tokens --alpha "destructive 30%"`, an `--alpha` for each you bind, its calls sent as Tokens step 3 sends them. `setPaints` binds each paint afresh, so a set a designer left in Dark shows Dark's values, and puts back the opacity of one bound to a token rather than its alpha variable, which a mode switch then resets to 1; it leaves such a shadow unbound, in its measured color. Load every text layer's font with `loadFont(family, weight)`, as step 3 says, and before changing the text of a label an earlier push made, load the font it has (`figma.loadFontAsync(text.fontName)`), or make a new label where that font won't load. If `applyStyles` throws part way, the part removes the variants it created before it fails, so none is left loose on the page, and a retry makes them again.

   **Return the set's id.** End the plugin code by returning the component set's id — step 6 reads the variants back from it, and fixes target it. Leave the readback itself to step 6: `use_figma` returns at most 20kb per call, and a whole set's readback passes that at a few dozen variants.

   **Build a set in parts of at most 25 variants.** `use_figma` takes at most 50,000 characters of code per call, and a variant's measured values run to about a thousand characters, so a large set's code does not fit in one call; a call that runs too long also fails, with `Script exceeded time limit`. Write the values as a table, one entry per variant, leaving out `border` where `borderUniform` is set and `borderRadius` where `borderRadiusUniform` is, which only repeat them, and create the variants in a loop over it rather than writing out each one's code. Measure each part's code before sending it: if it passes 45,000 characters, build that set in parts of 15 instead, `PART = 15` on every part. Build a set of more than 25 variants across calls, in snap's variant order: the first finds the set by name anywhere on its page, or creates it, with the first 25; each later call finds it by id and does the same with the next 25; and every part lays out and checks the whole set as it then stands, so the last leaves it laid out in full. If a call fails with `Script exceeded time limit`, check what it left on the canvas before retrying, and build in smaller parts.

   **A part updates the variants it names and adds only the ones the set lacks.** On a set an earlier push built, or one a failed call left half done, each part finds each of its variants among the set's children by name, restyles it if it is there and creates it if it is not. It never creates a second variant of a name the set already has: it refuses, before changing anything, a part that names a variant twice, and a part whose set already holds two of a name it carries — with the error step 6's readback gives for that, and the same remedy. So a part can be retried, and a push repeated, without duplicating anything; and every part lays the whole set out again and checks it, so a part re-run on its own leaves the set laid out. A variant in Figma that snap no longer has — one for a value the code has since dropped — is named by no part, so the build leaves it alone, laid out in a row of its own below the others: step 6 finds it, and you report it. Delete it only if the user asks; a designer may have built on it.

   **Every part lays the whole set out in snap's order, and checks it.** Give each part the component's `variantProperties` from snap's output as `PROPERTIES`, copied as they are: the same table on every part, a few hundred characters even for 256 variants. Leave the template's layout as it is. It orders the set by `PROPERTIES`, never by the set's children, whose order is whatever an earlier push or a designer left:

   - Each property's values run in the order snap records them: a `VARIANT`'s default value first, then the rest in the order of the component's prop type as Storybook's docs list it, then any only the story's `argTypes` options list. A `BOOLEAN` property runs its default first, `false, true`, or `true, false` when it defaults to `true`, whatever order snap lists its values in.
   - **Figma makes the top-left variant the set's default variant**, so the default is the variant of each property's first value: the component's own default for a `VARIANT`, since snap records it first, and for a `BOOLEAN`, since the template lays its default out first: `open=true` where the component defaults to `open=true`. When that differs from the component's defaults, snap's `defaultValue`s, as where a snap from before 0.4.0 lists a `VARIANT`'s values as Storybook's docs do, say in the summary which variant Figma will treat as the default. A property marked `defaultAssumed: true` has no default in Storybook's docs, so its `defaultValue` is a guess: name those in the summary too.
   - The first property's values are the rows, top to bottom; the combinations of the other properties, in their order with the last varying fastest, are the columns, left to right. With one property, each value is a row of one. Each variant's cell comes from its own name, so a combination the set lacks leaves a gap and the columns still line up, a row or column no variant fills at all is left out, and the work grows with the set's variants, not with every combination `PROPERTIES` allows. Each column is as wide as its widest variant and each row as tall as its tallest, 20 apart, so a Drawer's 39 by 24 closed trigger and its 1280 by 197 open panel sit apart, and a variant built 0.01 high keeps a row of its own. The Button in step 3's snap output — `variant` primary, danger, outline; `size` sm, lg; `disabled` — is three rows, primary, danger and outline, of four columns: sm, sm disabled, lg, lg disabled.
   - A variant whose name is no combination of `PROPERTIES`, one snap does not have, goes in a row of its own below the others, in name order, and is counted in the `extra` the part returns; so does a second variant of a name. Of two variants of a name, the one whose node id sorts first as text stays in the grid, so every part keeps the same one there.
   - **It refuses a set with auto layout.** On a set whose `layoutMode` is not `'NONE'`, auto layout positions the variants itself: setting their x and y does nothing, and the layout's layer order would flow the last variant into the top-left, Figma's default. So the part throws `The set "…" has auto layout …` before changing anything. Ask the user whether to turn auto layout off on the set (`componentSet.layoutMode = 'NONE'`, in a call of its own) and re-run the part, or to leave its layout alone and skip the set, saying in the summary that it was not pushed. Do neither on your own.
   - Figma's layers panel shows a set's last child at the top, so the layout puts the variants last to first, moving only the ones out of place: the panel then reads top-down in the grid's order, row by row, with that extra row last.
   - It grows the set to fit, then checks that the layers are in that order, that every variant is where the layout put it, so a move Figma ignored fails, that no two variants' boxes intersect, and that the set contains every one, and throws if not. It returns counts, not names: the set's `rows`, `columns` and `extra`, `overlaps`, and `fonts`, the stand-ins `loadFont` used. A plain component returns 1 variant in 1 row and 1 column.

```js
use_figma({
  code: `
    // Component: Button (title: Forms/Button, category: Forms)
    const PAGE_NAME = 'Forms';
    const SET_NAME = 'Button';
    // Its id and title from snap, kept on the set as shared plugin data.
    const ID = 'forms-button';
    const TITLE = 'Forms/Button';
    // null on the first part; the id the first part returned on every later one.
    const SET_ID = null;
    const PART = 25;

    // Find or create the 'Forms' page, ignoring case, ' ', '/', '-' and '_'.
    const pageKey = (name) => name.toLowerCase().replace(/[ /_-]+/g, '');
    let page = figma.root.children.find(p => pageKey(p.name) === pageKey(PAGE_NAME));
    if (!page) {
      page = figma.createPage();
      page.name = PAGE_NAME;
    }
    await figma.setCurrentPageAsync(page);

    // The component's variantProperties from step 3's snap output, copied as
    // they are and in their order: the same on every part. The layout below
    // orders the set by them.
    const PROPERTIES = [
      { name: 'variant', type: 'VARIANT', values: ['default', 'destructive', 'outline'], defaultValue: 'default' },
      { name: 'size', type: 'VARIANT', values: ['md', 'sm', 'lg'], defaultValue: 'md' },
      { name: 'disabled', type: 'BOOLEAN', values: ['true', 'false'], defaultValue: 'false' },
    ];

    // At most PART variants, in snap's variant order: use_figma takes at most
    // 50,000 characters of code. Name each from its snap combination, every
    // key, BOOLEANs too, as key=value joined with ", " in the combination's
    // order ('' with no properties); styles is its full measured styles, the
    // base with its delta applied, less border where borderUniform is set and
    // borderRadius where borderRadiusUniform is, which repeat them.
    const VARIANTS = [
      { name: 'variant=default, size=sm, disabled=false', styles: { backgroundColor: '#1ea7fd', color: '#ffffff', padding: { top: 4, right: 8, bottom: 4, left: 8 }, borderRadiusUniform: 6, fontSize: 12, fontWeight: 600 } },
      // ... one entry per variant in this part
    ];

    // Set fills, strokes and effects with this, never directly: each item is
    // a paint or effect in its measured color, with variable, the color
    // variable to bind, if any. Each is bound afresh, the old ones cleared
    // first, so it takes its variable's color and alpha in the mode its node
    // is in, as a mode switch would give it. A paint whose alpha its
    // variable's light value doesn't hold, a token rather than its alpha
    // variable (`destructive 10%`), has its opacity put back, which a mode
    // switch resets; such a shadow is left unbound, in its measured color.
    const lightAlpha = (v) => {
      const value = Object.values(v.valuesByMode || {})[0];
      return value && typeof value.r === 'number' ? (value.a === undefined ? 1 : value.a) : null;
    };
    const setPaints = (node, key, list) => {
      const fx = key === 'effects';
      const raw = list.map(({ variable, ...p }) => (fx ? p : { opacity: 1, ...p }));
      const loose = list.map((p, i) => Boolean(p.variable) && lightAlpha(p.variable) !== null && Math.abs(lightAlpha(p.variable) - (fx ? (raw[i].color || {}).a : raw[i].opacity)) >= 0.002);
      const bound = list.map((p, i) => (p.variable && !(fx && loose[i]) ? figma.variables[fx ? 'setBoundVariableForEffect' : 'setBoundVariableForPaint'](raw[i], 'color', p.variable) : raw[i]));
      if (bound.some((p) => p.boundVariables)) node[key] = [];
      node[key] = bound;
      if (!fx && loose.some(Boolean)) node[key] = node[key].map((p, i) => (loose[i] ? { ...p, opacity: raw[i].opacity } : p));
    };
    // A text layer's font: the measured family, by Figma's name for it first
    // (Geist for fontsource's Geist Variable), else Roboto Mono for a mono
    // one, Noto Serif for a serif, Inter for any other; at the measured weight,
    // else the next toward Regular, in either spelling. It never throws, and
    // FONTS, returned below, names each stand-in.
    const STYLES = ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black'];
    const FONTS = {}, fonts = {};
    const loadFont = (family, weight) => fonts[family + weight] = fonts[family + weight] || (async () => {
      const i = Math.min(8, Math.max(0, Math.round((weight || 400) / 100) - 1)), d = Math.sign(3 - i);
      const alt = /mono|menlo|monaco|consolas|courier/i.test(family) ? 'Roboto Mono' : /^(?!.*sans).*(serif|georgia|times)/i.test(family) ? 'Noto Serif' : 'Inter';
      const named = family.replace(/\s+variable$/i, '');
      for (const f of new Set([named, family, alt, 'Inter'])) {
        for (const j of new Set([i, i + d, i + 2 * d, 3].filter((j) => (j - 3) * d <= 0))) {
          for (const s of new Set([STYLES[j], STYLES[j].replace(' ', '')])) {
            try {
              await figma.loadFontAsync({ family: f, style: s });
              if ((f !== family && f !== named) || j !== i) FONTS[family + ' ' + weight] = f + ' ' + s;
              return { family: f, style: s };
            } catch (e) {}
          }
        }
      }
    })();

    // Style one variant from its measured values as step 3's table maps them,
    // with setPaints and loadFont. It restyles variants an earlier push made
    // too: set every property, and reuse the children it made, such as the
    // label, variant.findOne((n) => n.type === 'TEXT'), created only if null.
    const applyStyles = async (variant, styles) => {
      // ... Figma Plugin API code
    };

    const names = VARIANTS.map((v) => v.name);
    if (names.length === 0 || names.length > PART) {
      throw new Error('This part names ' + names.length + ' variants: name between 1 and PART (' + PART + ')');
    }
    if (new Set(names).size !== names.length) {
      throw new Error('This part names a variant twice: name each once');
    }
    // A component with no variant properties is one plain component, not a
    // set: Figma renames a set's one unnamed variant "=" and marks it broken.
    const want = PROPERTIES.length ? 'COMPONENT_SET' : 'COMPONENT';
    if (!PROPERTIES.length && names.join() !== '') {
      throw new Error('With no properties, name the one variant ""');
    }
    // The set: by id after the first part; on the first, by name anywhere on
    // the page, in a section or frame a designer moved it into too, else by
    // ID, so a renamed set is found and a copy of one is not. A plain
    // component without an ID, where a set is built, is a designer's own.
    const idOf = (n) => n.getSharedPluginData('storysync', 'id');
    let componentSet = null;
    if (SET_ID) {
      componentSet = await figma.getNodeByIdAsync(SET_ID);
      if (!componentSet || componentSet.type !== want) {
        throw new Error('No ' + want + ' with id ' + SET_ID + (componentSet ? ': it is a ' + componentSet.type : ''));
      }
    } else {
      const all = page.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
        .filter((n) => n.parent.type !== 'COMPONENT_SET' && (n.type === want || n.type === 'COMPONENT_SET' || idOf(n)));
      const named = all.filter((n) => n.name === SET_NAME);
      const sets = named.length ? named : all.filter((n) => ID && idOf(n) === ID);
      componentSet = sets[0] || null;
      const why = sets.length > 1 ? 'ask the user which to update'
        : componentSet && componentSet.type !== want ? 'this part builds a ' + want + ': ask the user whether to convert it or skip it'
        : componentSet && idOf(componentSet) && idOf(componentSet) !== ID ? 'it is another component: ask the user whether it is ' + ID : '';
      if (why) {
        throw new Error('The page has ' + sets.map((n) => n.type + ' "' + n.name + '" (' + n.id + ', id "' + idOf(n) + '")').join(', ') + ': ' + why);
      }
    }
    // Auto layout would place the variants itself: refuse it, changing nothing.
    if (componentSet && PROPERTIES.length && componentSet.layoutMode !== 'NONE') {
      throw new Error('The set "' + SET_NAME + '" has auto layout (' + componentSet.layoutMode + '), so x and y do nothing: ask the user whether to turn it off or skip the set');
    }
    // A new set or component goes 100 below everything on the page; each
    // keeps its ID and title for the audit to pair on.
    const fresh = !componentSet;
    const below = page.children.reduce((y, n) => Math.max(y, n.y + n.height + 100), 0);
    const keep = (node) => {
      node.setSharedPluginData('storysync', 'id', ID || '');
      node.setSharedPluginData('storysync', 'title', TITLE || '');
      if (fresh) Object.assign(node, { name: SET_NAME, x: 0, y: below });
    };
    // The sets and components it lies on, as pushes before 0.4.0 left them
    // at 0,0: counted, never moved.
    const overlaps = (node) => node.parent.children.filter((n) => n !== node && /^COMPONENT/.test(n.type)
      && n.x < node.x + node.width && node.x < n.x + n.width && n.y < node.y + node.height && node.y < n.y + n.height).length;
    if (!PROPERTIES.length) {
      const node = componentSet || figma.createComponent();
      try {
        await applyStyles(node, VARIANTS[0].styles);
      } catch (e) {
        if (fresh) node.remove();
        throw e;
      }
      keep(node);
      return JSON.stringify({ id: node.id, name: node.name, variants: 1, added: +fresh, updated: +!fresh, rows: 1, columns: 1, extra: 0, overlaps: overlaps(node), fonts: FONTS });
    }
    // Each named variant the set already has, found by name. Check them all
    // before changing anything: a part that fails here leaves the set as it was.
    const existing = new Map();
    for (const name of names) {
      const found = componentSet ? componentSet.children.filter((child) => child.name === name) : [];
      if (found.length > 1) {
        throw new Error('The set has ' + found.length + ' variants named "' + name + '", not one');
      }
      existing.set(name, found[0] || null);
    }

    // Update the variants the set has; create only the ones it lacks. One that
    // fails part way removes those it made, leaving none loose on the page.
    const created = [];
    try {
      for (const { name, styles } of VARIANTS) {
        let variant = existing.get(name);
        if (!variant) {
          variant = figma.createComponent();
          variant.name = name;
          created.push(variant);
        }
        await applyStyles(variant, styles);
      }
    } catch (e) {
      for (const variant of created) variant.remove();
      throw e;
    }
    if (!componentSet) {
      componentSet = figma.combineAsVariants(created, page);
    } else {
      for (const variant of created) componentSet.appendChild(variant);
    }
    keep(componentSet);

    // Lay the whole set out by PROPERTIES on every part, as described above,
    // never by child order: leave this as it is. Cells come from names, so the
    // work grows with the set, not with every combination PROPERTIES allows.
    const GAP = 20;
    const axes = PROPERTIES.map((p) => [p.name + '=', p.type !== 'BOOLEAN' ? p.values : p.defaultValue === 'true' ? ['true', 'false'] : ['false', 'true']]);
    const byId = (a, b) => (a.node.id > b.node.id) - (a.node.id < b.node.id);
    const byColumn = (a, b) => { for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
    const cells = [], extra = [];
    for (const node of componentSet.children) {
      const pairs = node.name.split(', ');
      const at = pairs.length === axes.length ? pairs.map((s, i) => (s.startsWith(axes[i][0]) ? axes[i][1].indexOf(s.slice(axes[i][0].length)) : -1)) : [-1];
      (at.includes(-1) ? extra : cells).push({ node, at, key: at.slice(1).join() });
    }
    cells.sort((a, b) => a.at[0] - b.at[0] || byColumn(a.at, b.at) || byId(a, b));
    const grid = [];
    for (const c of cells) {
      const last = grid[grid.length - 1];
      (last && last.at[0] === c.at[0] && last.key === c.key ? extra : grid).push(c);
    }
    extra.sort((a, b) => (a.node.name > b.node.name) - (a.node.name < b.node.name) || byId(a, b));
    const rows = [...new Set(grid.map((c) => c.at[0]))];
    const columns = [...new Map(grid.map((c) => [c.key, c.at])).values()].sort(byColumn).map((at) => at.slice(1).join());
    const rowOf = new Map(rows.map((r, i) => [r, i]));
    const columnOf = new Map(columns.map((key, i) => [key, i]));
    const widths = columns.map(() => 0);
    const heights = rows.map(() => 0);
    for (const c of grid) {
      c.row = rowOf.get(c.at[0]);
      c.column = columnOf.get(c.key);
      widths[c.column] = Math.max(widths[c.column], c.node.width);
      heights[c.row] = Math.max(heights[c.row], c.node.height);
    }
    const xs = [GAP], ys = [GAP];
    widths.forEach((w, i) => xs.push(xs[i] + w + GAP));
    heights.forEach((h, i) => ys.push(ys[i] + h + GAP));
    for (const c of grid) { c.x = xs[c.column]; c.y = ys[c.row]; }
    let across = GAP;
    let bottom = ys[rows.length];
    for (const c of extra) { c.x = across; c.y = bottom; across += c.node.width + GAP; }
    if (extra.length) bottom += Math.max(...extra.map((c) => c.node.height)) + GAP;
    const order = [...grid, ...extra];
    for (const c of order) { c.node.x = c.x; c.node.y = c.y; }
    componentSet.resizeWithoutConstraints(Math.max(xs[columns.length], across), bottom);
    // The layers panel shows the last child on top: order the children last
    // to first, moving only those out of place.
    const target = order.map((c) => c.node).reverse();
    const before = componentSet.children;
    let kept = 0;
    while (kept < before.length && before[kept].id === target[kept].id) kept++;
    for (const node of target.slice(kept)) componentSet.appendChild(node);

    // Check the layer order, that each variant is where it was put (a move
    // Figma ignored fails), that none overlap, and that the set holds them all.
    const kids = componentSet.children;
    if (kids.length !== order.length || kids.some((n, i) => n.id !== target[i].id)) {
      throw new Error("The set's layers are not in the order it was laid out in");
    }
    for (const c of order) {
      if (Math.abs(c.node.x - c.x) > 0.5 || Math.abs(c.node.y - c.y) > 0.5) {
        throw new Error('Variant "' + c.node.name + '" is not where the layout put it');
      }
    }
    const boxes = kids.map((n) => ({ name: n.name, x: n.x, y: n.y, r: n.x + n.width, b: n.y + n.height }));
    boxes.forEach((a, i) => {
      if (a.x < 0 || a.y < 0 || a.r > componentSet.width || a.b > componentSet.height) {
        throw new Error('Variant "' + a.name + '" lies outside the set');
      }
      for (const b of boxes.slice(i + 1)) {
        if (a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b) {
          throw new Error('Variants "' + a.name + '" and "' + b.name + '" overlap');
        }
      }
    });

    // Counts, not the readback, which can pass use_figma's 20kb: the set's id
    // for later parts and step 6, its variants, those added and updated this
    // part, the extra ones in the row below the grid, and loadFont's stand-ins.
    return JSON.stringify({
      id: componentSet.id, name: componentSet.name, variants: kids.length,
      added: created.length, updated: names.length - created.length,
      rows: rows.length, columns: columns.length, extra: extra.length, overlaps: overlaps(componentSet), fonts: FONTS,
    });
  `,
  description: "Create or update variants 1-25 of the Button component set on 'Forms' page, styled from measured values",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

6. **Read the result back and score it.** Read each component set's variants back with `use_figma`, off the nodes themselves rather than from the values you sent — echoing proves nothing. `use_figma` takes at most 50,000 characters of code and returns at most 20kb per call: a set's readback passes 20kb at a few dozen variants, and the table of its names and slugs can pass 50,000 characters at under two hundred. So the template below reads a set a slice at a time, and each call names the variants it reads — at most `BATCH`, 20, in snap's variant order: the first 20, then the next 20, until you have read every variant snap measured. It reads exactly the variants you name, finding each by name, and throws if the set has no variant of a name you gave, or two. It also throws if a slice comes too close to 20kb. A call that throws returns nothing; below the template is what to do about each error. Each entry it returns carries `readAt`, the time Figma read it, and a `checksum` it computed in Figma over that entry, the set's id and the slug, so write the entries into the readback file exactly as returned: see below the templates.

   A plain component, which step 5 builds for a component with no variant properties, reads the same way, in one call: give `SET_ID` its id and `SLUG_BY_NAME` its one variant, `''`, with the slug snap gives it, `default`. The template reads the component itself as that variant, and returns a `total` of 1.

   Each call returns `total`, the number of variants in the set. If the slices add up to fewer, the set holds variants snap never measured — one an earlier push built for a value the code has since dropped, say. `verify` cannot see those, so list the set's names as the second template below does, find them, and report them.

```js
use_figma({
  code: `
    // Reads one slice of a component set back off the nodes. use_figma takes
    // at most 50,000 characters of code and returns at most 20kb per call, so
    // each call names the variants it reads: at most BATCH, in snap's variant
    // order — the first BATCH, then the next, until every variant is read.
    const SET_ID = '12:34'; // the id step 5 returned
    const BATCH = 20;

    // The snap slug for each Figma variant this call reads, keyed by the name
    // step 5 gave it: this slice's variants only, not the whole set's.
    // Copy each slug from the snap output — never rebuild it from the name.
    // snap lowercases, collapses punctuation, and numbers collisions ("--2"),
    // none of which is recoverable from a Figma variant name; a rebuilt slug
    // that differs by one character makes the variant unscorable.
    const SLUG_BY_NAME = {
      'variant=default, size=sm, disabled=false': 'variant-default--size-sm--disabled-false',
      // ... one entry per variant in this slice
    };
    const slugFor = (child) => {
      const slug = SLUG_BY_NAME[nameOf(child)];
      if (!slug) throw new Error('No snap slug recorded for Figma variant "' + nameOf(child) + '"');
      return slug;
    };

    // Where each variant's values came from, from step 3's snap output:
    // 'measured' for variants whose status was "ok", 'inferred' for the rest.
    // Fill this in from the snap result — it is the one field verify cannot
    // check for you, and defaulting it to 'measured' is what makes a guessed
    // variant indistinguishable from a rendered one.
    const SOURCE_BY_SLUG = {
      'variant-default--size-sm--disabled-false': 'measured',
      // ... one entry per variant in this slice
    };

    // Each entry is returned with readAt, the time Figma read it, and a
    // checksum computed here, in Figma, over exactly what this call returns,
    // under the set's id and the slug. verify recomputes it and reports any
    // entry edited, composed from snap's values, or copied onto another
    // variant or component after this call returned it, and any read before
    // the snap, so write the entries into the readback file exactly as
    // returned. canon is JSON with every object's keys sorted; the checksum
    // is 32-bit FNV-1a over its char codes. Leave both as they are: verify
    // computes the same, character for character.
    const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
      : v !== null && typeof v === 'object'
        ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
        : JSON.stringify(v));
    const seal = (setId, slug, fields) => {
      // Through JSON first, as use_figma returns it: a field that is
      // undefined, or figma.mixed, drops out here as it does there.
      const entry = JSON.parse(JSON.stringify(Object.assign({}, fields, { readAt: new Date().toISOString() })));
      const text = canon({ [setId]: { [slug]: entry } });
      let hash = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
      entry.checksum = 'fnv1a:' + hash.toString(16).padStart(8, '0');
      return entry;
    };

    const names = Object.keys(SLUG_BY_NAME);
    if (names.length === 0 || names.length > BATCH) {
      throw new Error('This call names ' + names.length + ' variants: name between 1 and BATCH (' + BATCH + ')');
    }
    const componentSet = await figma.getNodeByIdAsync(SET_ID);
    if (!componentSet || (componentSet.type !== 'COMPONENT_SET' && componentSet.type !== 'COMPONENT')) {
      throw new Error('No component set with id ' + SET_ID);
    }
    // A plain component, as step 5 builds one with no variant properties, is
    // its own one variant, named '' (slug default): name it so above.
    const variants = componentSet.type === 'COMPONENT' ? [componentSet] : componentSet.children;
    const nameOf = (child) => (child === componentSet ? '' : child.name);
    // Exactly the variants named above. One the set lacks, or holds twice,
    // fails here rather than leaving a gap or a guess in the readback.
    const children = names.map((name) => {
      const found = variants.filter((child) => nameOf(child) === name);
      if (found.length !== 1) {
        throw new Error('The set has ' + found.length + ' variants named "' + name + '", not one');
      }
      return found[0];
    });

    // Variable bindings, which no value shows: a token detached in Figma
    // keeps its value. bound names the variable each field is bound to;
    // unbound lists the fields bound to none whose value a local variable
    // of the field's own kind has, in any of its modes, a color by its
    // #rrggbb, as a translucent one is bound at an opacity. Lengths of 0
    // are left out. A variable's kinds are the ones its scopes name, where
    // they name some; else a color variable's are the three colors, and a
    // number's the one its collection is named for, as Tokens step 3 names
    // them. So a padding of 8 is no detached radius, though shadcn/ui's
    // radius md is 8, and a number in a collection named for none of them
    // is never matched.
    const VARIABLES = await figma.variables.getLocalVariablesAsync();
    const COLLECTIONS = {};
    for (const c of await figma.variables.getLocalVariableCollectionsAsync()) COLLECTIONS[c.id] = c.name;
    const SCOPE_KINDS = {
      ALL_FILLS: ['fill', 'text'], FRAME_FILL: ['fill'], SHAPE_FILL: ['fill'], TEXT_FILL: ['text'],
      STROKE_COLOR: ['stroke'], CORNER_RADIUS: ['radius'], GAP: ['spacing'], FONT_SIZE: ['fontSize'],
    };
    const kindsOf = (v) => {
      if (Array.isArray(v.scopes) && !v.scopes.includes('ALL_SCOPES')) return v.scopes.flatMap((s) => SCOPE_KINDS[s] || []);
      if (v.resolvedType === 'COLOR') return ['fill', 'text', 'stroke'];
      const collection = COLLECTIONS[v.variableCollectionId] || '';
      if (/radi|rounded|corner/i.test(collection)) return ['radius'];
      if (/spac|gap/i.test(collection)) return ['spacing'];
      // A typography collection holds weights and line heights too.
      if (/typo|font|text/i.test(collection) && !/weight|leading|line.?height|tracking|letter/i.test(v.name)) return ['fontSize'];
      return [];
    };
    const hex6 = (c) => '#' + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
    const hasValue = (kind, value) => VARIABLES.some((v) => kindsOf(v).includes(kind) && Object.values(v.valuesByMode).some((x) => (typeof value === 'number'
      ? typeof x === 'number' && Math.abs(x - value) < 0.01 : x !== null && typeof x === 'object' && 'r' in x && hex6(x) === value)));
    const NAMES = {};
    const variableName = async (alias) => {
      const id = ((Array.isArray(alias) ? alias[0] : alias) || {}).id;
      if (id && !NAMES[id]) NAMES[id] = ((await figma.variables.getVariableByIdAsync(id)) || { name: id }).name;
      return id ? NAMES[id] : null;
    };
    const bindingsOf = async (child, fill, stroke, text) => {
      const own = child.boundVariables || {};
      const paint = (p) => (p && p.type === 'SOLID' && p.visible !== false && p.opacity !== 0 ? hex6(p.color) : null);
      const textFill = text && Array.isArray(text.fills) ? text.fills[0] : null;
      const auto = child.layoutMode && child.layoutMode !== 'NONE';
      // Each field, with its kind, its binding and the value it shows.
      const FIELDS = [
        ['backgroundColor', 'fill', fill && fill.boundVariables && fill.boundVariables.color, paint(fill)],
        ['color', 'text', textFill && textFill.boundVariables && textFill.boundVariables.color, paint(textFill)],
        ['borderColor', 'stroke', stroke && stroke.boundVariables && stroke.boundVariables.color, paint(stroke)],
        ['borderRadiusUniform', 'radius', own.topLeftRadius, typeof child.cornerRadius === 'number' ? child.cornerRadius : null],
        ['paddingTop', 'spacing', own.paddingTop, child.paddingTop],
        ['paddingRight', 'spacing', own.paddingRight, child.paddingRight],
        ['paddingBottom', 'spacing', own.paddingBottom, child.paddingBottom],
        ['paddingLeft', 'spacing', own.paddingLeft, child.paddingLeft],
        ['gap', 'spacing', own.itemSpacing, auto ? child.itemSpacing : null],
        ['fontSize', 'fontSize', text && text.boundVariables && text.boundVariables.fontSize, text && typeof text.fontSize === 'number' ? text.fontSize : null],
      ];
      const bound = {};
      const unbound = [];
      for (const [field, kind, alias, value] of FIELDS) {
        const name = alias ? await variableName(alias) : null;
        if (name) bound[field] = name;
        else if (value !== null && value !== undefined && value !== 0 && hasValue(kind, value)) unbound.push(field);
      }
      return { bound, unbound };
    };

    // Read back what is actually there, keyed by the snap variant slug.
    const readback = {};
    for (const child of children) {
      const fill = child.fills && child.fills[0];
      const stroke = child.strokes && child.strokes[0];
      // A paint's color as snap writes one, since verify compares colors
      // as written: #rrggbb, then the alpha as two more hex digits, rounded
      // from alpha x 255, when they come to less than ff (a soft Chip's
      // background is #4b556322), and null when they come to 00, as snap
      // records a transparent border. Figma keeps a paint's alpha in its
      // opacity and an effect color's in its a, so combine both; and a
      // paint hidden with the eye icon, visible: false, draws nothing at any
      // opacity, so it reads as null too.
      const byte = (n) => n.toString(16).padStart(2, '0');
      const hexOf = (paint) => {
        if (paint.visible === false) return null;
        const c = paint.color;
        // + 1e-4: Figma keeps opacity as a 32-bit float, so an opacity set as
        // 0.7 reads 0.69999… and would round to b2 where snap wrote b3.
        const alpha = Math.round((typeof c.a === 'number' ? c.a : 1)
          * (typeof paint.opacity === 'number' ? paint.opacity : 1) * 255 + 1e-4);
        if (alpha === 0) return null;
        return '#' + [c.r, c.g, c.b].map((x) => byte(Math.round(x * 255))).join('')
          + (alpha < 255 ? byte(alpha) : '');
      };
      // Size from the geometry, never absoluteRenderBounds. snap's width and
      // height are the browser's border box: a border takes its space there
      // even when transparent, and a box-shadow takes none. Render bounds
      // leave out a stroke that paints nothing and take in drop shadows, so
      // a faithful push would drift on both. So take the node's own width and
      // height and add the stroke that lies outside them, visible or not:
      // all of it OUTSIDE, half CENTER, none INSIDE. Only when the node has a
      // stroke, since one without still reports a strokeWeight; and each
      // side's weight first, since strokeWeight is mixed when they differ.
      const outside = stroke ? { OUTSIDE: 1, CENTER: 0.5 }[child.strokeAlign] || 0 : 0;
      const edge = (side) => {
        if (!outside) return 0;
        const own = child['stroke' + side + 'Weight'];
        return outside * (typeof own === 'number' ? own : child.strokeWeight);
      };
      // A border's style from its stroke's dash pattern, as step 3's table
      // builds one: none is solid, dashes no longer than the stroke is wide
      // are dotted, longer ones dashed.
      const dash = child.dashPattern && child.dashPattern.length ? child.dashPattern[0] : 0;
      const borderStyle = !dash ? 'solid'
        : dash > (typeof child.strokeWeight === 'number' ? child.strokeWeight : child.strokeTopWeight) ? 'dashed' : 'dotted';
      const text = child.findOne(n => n.type === 'TEXT');
      // A text node's fontSize is figma.mixed when its text mixes sizes, and
      // its fontName when it mixes fonts: those read as null, as they do
      // with no text child.
      const font = text && typeof text.fontName === 'object' ? text.fontName : null;
      // Figma names weights ("Semi Bold"), CSS numbers them (600). Mapping only
      // Bold would report every SemiBold/Medium/Light face as 400, and
      // fontWeight is compared exactly — so a correct push would drift on every
      // variant. Match on the normalized style name.
      const WEIGHTS = {
        thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400,
        normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600,
        bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
      };
      const weightOf = (style) => {
        const key = String(style || '').toLowerCase().replace(/[^a-z]/g, '').replace(/italic$/, '');
        return WEIGHTS[key] != null ? WEIGHTS[key] : 400;
      };
      const slug = slugFor(child);
      const bindings = await bindingsOf(child, fill, stroke, text);
      // Every field comes back on every variant, null where Figma has nothing
      // to report, never left out: verify reports an entry without one as
      // incomplete and scores none of it. Leave them all.
      readback[slug] = seal(componentSet.id, slug, {
        // Set from how THIS variant's values were obtained — do not leave the
        // passing value in place. 'measured' only if it came from step 3's snap
        // output; 'inferred' if you fell back to reading source. Declare
        // SOURCE_BY_SLUG above from that step's status, so a variant snap
        // could not measure cannot be labeled measured by omission.
        source: SOURCE_BY_SLUG[slug] || 'inferred',
        backgroundColor: fill && fill.type === 'SOLID' ? hexOf(fill) : null,
        color: text && text.fills[0] ? hexOf(text.fills[0]) : null,
        borderRadiusUniform: typeof child.cornerRadius === 'number' ? child.cornerRadius : null,
        padding: { top: child.paddingTop, right: child.paddingRight,
                   bottom: child.paddingBottom, left: child.paddingLeft },
        // A stroke whose paint draws nothing is a transparent border: its
        // color reads as null, and its weight still counts, as above.
        borderUniform: stroke ? { width: child.strokeWeight, style: borderStyle, color: hexOf(stroke) } : null,
        // null with no text child: verify accepts that only where snap measured
        // no text on the variant either.
        fontSize: text && typeof text.fontSize === 'number' ? text.fontSize : null,
        fontWeight: font ? weightOf(font.style) : null,
        // Report the family Figma actually used: the plugin context has only
        // Google Fonts, so a system font the code asks for gets substituted, and
        // without this line the substitution would never be scored.
        fontFamily: font ? font.family : null,
        // null without auto layout, where there is no gap. verify treats a
        // measured null gap and {0,0} as the same rendering, so this, or an
        // auto-layout frame with zero spacing, matches a block-level element,
        // and null against a measured gap is drift. itemSpacing is the gap
        // along the layout's direction, so verify compares a flex element's
        // measured gap on that axis alone.
        gap: child.layoutMode && child.layoutMode !== 'NONE'
          ? { row: child.itemSpacing, column: child.itemSpacing }
          : null,
        opacity: child.opacity,
        // The border box, from the geometry: see edge above.
        width: child.width + edge('Left') + edge('Right'),
        height: child.height + edge('Top') + edge('Bottom'),
        // How the text fits its box, compared where snap measured that the
        // browser wrapped it or cut it off: its width, and the line it ends
        // in an ellipsis after (0 for one cut off at its height), null where
        // it isn't cut off. null for a text that hugs its content, or none.
        textLayout: text && (text.textAutoResize !== 'WIDTH_AND_HEIGHT' || text.textTruncation === 'ENDING')
          ? { width: text.width, maxLines: text.textTruncation === 'ENDING' ? text.maxLines || 0 : null }
          : null,
        // Bindings, which verify names beside the score: see bindingsOf.
        bound: bindings.bound,
        unbound: bindings.unbound,
      });
    }
    // total counts every variant in the set, read or not: if the slices add up
    // to fewer, the set holds variants snap never measured.
    const total = variants.length;
    const result = JSON.stringify({ id: componentSet.id, name: componentSet.name, total, readback });
    // use_figma JSON-encodes what this returns, escaping every quote, so
    // measure the encoded string. Fail rather than return a slice the 20kb
    // limit would cut short.
    const size = JSON.stringify(result).length;
    if (size > 17000) {
      throw new Error('This slice is ' + size + ' characters encoded, too close to 20kb: split its names across two calls, and lower BATCH for the slices after them');
    }
    return result;
  `,
  description: "Read back variants 1-20 of the Button component set",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

   **If a readback call throws, it has returned nothing.** Deal with what it names, then make the call again:

   - `No component set with id …` — `SET_ID` is not the id step 5 returned, or the set has since been deleted. Re-run step 5's first part, which finds the set on its page by name, and read with the id it returns.
   - `This call names N variants …` — name between 1 and `BATCH`.
   - `No snap slug recorded …` — the table gives a variant no slug; copy it from the snap output.
   - `The set has 0 variants named …` — the build never made that variant: a part failed or was skipped. Add it to the set by id — re-run the build part that names it, which adds only the variants the set lacks and lays the whole set out again — then read that slice again.
   - `The set has 2 variants named …` — a part ran twice, in an earlier push or a retry that did not check what the set held, and made the variant twice; step 5 refuses every part that carries that name until one is gone. Report it. Remove the stale copy only after checking which one is current — `componentSet.children.filter((child) => child.name === name)` gives both, and you can read each by id and compare it with snap's values — or ask the user which to keep. If step 5 raised it, the refused part changed nothing, and the parts after it never ran: re-run that build part and every part after it, through the last part, then read the slices; if the readback raised it, read that slice again.
   - `This slice is N characters encoded …` — `BATCH` only caps how many names a call may carry, so lowering it does not shrink a call that already carries them. Split this call's names, and its two tables, across two calls, and lower `BATCH` so the slices after them are smaller too.

   **Find the variants snap does not have.** When the slices add up to fewer than `total`, or a build part returned an `extra` other than 0, list the set's variant names and compare them with snap's yourself: a name snap has no variant for is one it does not measure. Listing them all in one call can pass 20kb — 256 names of about 140 characters come to some 37,000 characters encoded — so the call below lists them a slice at a time: call it with `START = 0`, then again from the `next` it returns until `next` is `null`. A name listed twice is a variant made twice, as above. Report each variant snap does not have, by name, and delete one only if the user asks.

```js
use_figma({
  code: `
    // Lists one slice of a component set's variant names, to compare with
    // snap's. use_figma returns at most 20kb per call, which a whole set's
    // names can pass, so call this from START = 0, then from each next it
    // returns until next is null.
    const SET_ID = '12:34'; // the id step 5 returned
    const START = 0;
    const BATCH = 100;
    const componentSet = await figma.getNodeByIdAsync(SET_ID);
    if (!componentSet || componentSet.type !== 'COMPONENT_SET') {
      throw new Error('No component set with id ' + SET_ID);
    }
    const children = componentSet.children;
    const names = children.slice(START, START + BATCH).map((child) => child.name);
    const next = START + BATCH < children.length ? START + BATCH : null;
    const result = JSON.stringify({ total: children.length, next, names });
    // use_figma JSON-encodes what this returns: measure the encoded string.
    const size = JSON.stringify(result).length;
    if (size > 17000) {
      throw new Error('This slice is ' + size + ' characters encoded, too close to 20kb: lower BATCH and read it again');
    }
    return result;
  `,
  description: "List the variant names in the Button component set, a slice at a time",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

   Write every slice's `readback` entries into `.storysync/figma-readback.json` exactly as the calls returned them, merging the slices: keyed by the component's `title` (its `id` when it has none) and the snap variant slug, with the set's id, the `id` the calls returned, as `nodeId`, since each entry's checksum is sealed under it, so each component has the id of its own set. Copy each entry whole, its `readAt` and `checksum` included, with every value as it came back: numbers digit for digit (`0.4000000059604645`, not `0.4`), colors as written, a `null` as `null` (a variant with no text child, like the status dot below, returns `null` for the text's four fields, and one without auto layout for `gap`), and no field added that the entry lacks or dropped that it has. Never fill in or recompute a value, from snap, from what you sent in step 5 or from anywhere else, and never write an entry for a variant no call returned, nor one from an earlier run. If a response is too long to copy whole, read fewer variants per call, splitting the slice, rather than summarizing it. The file's layout is yours, since indentation and key order do not change a checksum, but its values are not: `verify` recomputes each entry's checksum, and reports any entry whose checksum is missing or does not match, whose component has the `nodeId` of another, that lacks a field the template always returns, or whose `readAt` is before the snap, as an unverified readback, scores nothing in it, and fails `--strict`.

```json
{
  "version": 1,
  "fileKey": "<file-key>",
  "components": {
    "Forms/Button": {
      "nodeId": "12:34",
      "variants": {
        "variant-primary--size-sm--disabled-false": {
          "source": "measured",
          "backgroundColor": "#2563eb", "color": "#ffffff", "borderRadiusUniform": 3,
          "padding": { "top": 4, "right": 8, "bottom": 4, "left": 8 },
          "borderUniform": null, "fontSize": 12, "fontWeight": 600, "fontFamily": "Inter",
          "gap": { "row": 6, "column": 6 }, "opacity": 1, "width": 64, "height": 24,
          "textLayout": null, "bound": { "backgroundColor": "primary/600", "color": "white" }, "unbound": [],
          "readAt": "2026-10-01T22:19:04.123Z",
          "checksum": "fnv1a:a61e11e7"
        }
      }
    },
    "Data/StatusDot": {
      "nodeId": "12:56",
      "variants": {
        "status-online": {
          "source": "measured",
          "backgroundColor": "#16a34a", "color": null, "borderRadiusUniform": 4,
          "padding": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
          "borderUniform": null, "fontSize": null, "fontWeight": null, "fontFamily": null,
          "gap": null, "opacity": 1, "width": 8, "height": 8,
          "textLayout": null, "bound": {}, "unbound": ["backgroundColor"],
          "readAt": "2026-10-01T22:19:04.391Z",
          "checksum": "fnv1a:5786a6b0"
        }
      }
    }
  }
}
```

   **`textLayout`, `bound` and `unbound` come back on every variant too.** `textLayout` is how Figma fits the text, compared where snap measured that the browser wrapped it or cut it off (step 3's table): a title the browser cut off at its card's width with an ellipsis, built as a text that hugs and runs past the card, drifts. `bound` names the variable each field is bound to, and `unbound` the fields bound to none though a variable of their kind in the file has their value, as the status dot's fill above is: a color variable for a color, and for a number the kind the variable's scopes name, or else its collection's (Tokens step 3), so a padding of 8 is not taken for a detached radius `md` of 8. `verify` doesn't score bindings, since the values are compared already, but names every field `unbound` lists beside the score: a token detached in Figma keeps its value, so no value shows it. Where the push left a value unbound on purpose, because several variables share it (Variable binding, below), the summary says so. A readback read before these three were added has none of them, and still scores, but `verify` says it can't see bindings, and where snap measured how the browser fitted a text, that it couldn't compare how Figma fits it, which fails `--strict`: read the set back with the template as it is now. An entry with one or two of the three, not all, was read with the template cut down, and is `incomplete`.

   **`source` is required on every variant**, and the template sets it from `SOURCE_BY_SLUG`: `"measured"` when the values came from `snap`, `"inferred"` when you fell back to reading source in step 3. Omitting it is not neutral: `verify` reports the entry as incomplete, since the template always returns it, and its provenance as `unrecorded`, and `--strict` and `--strict-measured` both fail on it, because a run that cannot distinguish measured from guessed is decorative. To correct one, correct the table and read the slice again: the checksum covers `source` too, so an entry whose `source` was changed in the file is an unverified readback.

   Then:

```bash
npx storysync verify --strict-age
```

   This reports a fidelity score — the share of properties Figma agrees with — plus anything that drifted, any variant Figma never received, the provenance breakdown, and the age of the measurement. Add `--skip` with the IDs of any component the user chose not to push (step 3), or that you skipped in step 5, for its set's auto layout or for a set or plain component of its name an earlier push left, as in `--skip ui-base-dialog,ui-base-sheet`: `verify` leaves them out of the score and names them under it, where otherwise it lists each of their variants as missing from Figma.

   Fix what it flags with a follow-up `use_figma` targeting the node by ID, then read the set back again and re-run `verify`. Four things it flags are not fixed by editing a node: an `unscored` variant means your readback returned nothing comparable for it — re-read that node; an entry whose checksum is missing or does not match, or whose component has the `nodeId` of another, is not what the readback returned — read that slice, or both components' sets, again and write their entries exactly as returned, each component under its own set's id, never editing the file to make it pass; an `incomplete` entry was read with the template cut down, and a `stale` one before the snap — read that slice again, now, with the template as it is; and `! snap recorded a failure` means the measurement itself is incomplete, not Figma: where it names a component's error, measure that component again (step 3, with `--merge`), and where it says components share a key, or that the snap recorded no components, do what snap warned and run the whole snap again. Nor, as a rule, is a `width` a pixel or two off on a variant that hugs its text, with nothing else on it drifting: Figma lays text out with its own metrics, about a pixel apart from the browser's (a chip labeled "Chip" in bold 11px Inter measured 38.59 wide in Chrome and 40 in Figma), and verify's allowance is narrowest on small labels. Report it as a font-rendering difference rather than fixing the text's width to squeeze it, which can clip the label, but only when the variant's stroke is `OUTSIDE`, `INSIDE` with `strokesIncludedInLayout`, or it has none, and the difference is not exactly twice the measured border's weight. Otherwise check its `strokeAlign` first: an `INSIDE` stroke on a hugging frame without `strokesIncludedInLayout` leaves the variant short by exactly twice the border, a `CENTER` one by the border, and a transparent border built with no stroke by twice the border too, and each is a build mistake to fix, not font rendering. Nor is a `borderUniform` whose measured `style` is `double`, `groove`, `ridge`, `inset` or `outset`: Figma's strokes have none of those, so report it rather than spend a fix round on it; nor a `fontFamily` the build parts' `fonts` name a stand-in for, which no edit in Figma can fix. **Stop after two fix rounds** and report the residual score. `use_figma` calls are rate-limited and becoming a paid feature; an unbounded repair loop burns that budget for diminishing returns.

7. Summarize what was synced: token collections, with their modes and what Tokens step 3's calls created, updated and left unchanged, the alpha variables they keep (`alpha`), and, where a collection holds the light theme alone though its tokens have `dark` values, why (Tokens step 3's `darkError`), the stale and conflicting variables with what the user chose for each, components grouped by page, whether the label call removed Figma's default page `Page 1` or why it kept it (its `pageOne`), variant counts, the components built as one plain component for having no variant properties, **the fidelity score**, worded as `verify` words it: where its line says `of verified entries`, how many entries it left unverified, which the score doesn't cover, how many variants were measured versus inferred, any components whose stories did not pass their args through, any props snap found reach a component but change nothing it measures, and what the user chose for them, any variant snap marked `argsChecked: false`, each component's `argsNotInDocs` and `excludedProps`, each component measured from the story `--stories` named, with the story and its `!` where it had one, for an audit to measure from it too, each overlay snap opened to measure and how, as its `measured open` line says, each component snap measured as a closed trigger or a layout wrapper, why snap didn't open it, and what the user chose for it (step 3), what `verify` printed under the score about what snap measured, the values left unbound because several variables share them (Variable binding, below), every font stand-in the build parts returned in `fonts` (a CSS keyword such as `system-ui` set in Inter, a platform face such as Menlo in Roboto Mono), which variant Figma will treat as a set's default where that is not the component's default (step 5), any set skipped for its auto layout, any component skipped for a set or plain component of its name an earlier push left (step 5), any set or component a part returned `overlaps` for, and whether the user had it moved, any border built solid for a style Figma's strokes lack, any label built ending in an ellipsis where the browser cut it off flat (`text.layout`'s `truncation` of `clip`), the fields `verify` names as bound to no variable though a variable has their value, with why each was left unbound, any variant built 0.01 wide or high for a measured 0, the variants with a transparent border, and any failures or caps. For each variant with a transparent or translucent border, say how its fill meets that border, as the browser draws it: with `backgroundClip: padding-box` the fill stops at the border, and Figma's `OUTSIDE` stroke leaves the same unfilled ring; without it the fill runs under the border, built as an `INSIDE` stroke with `strokesIncludedInLayout`. A transparent border built any other way, such as an `OUTSIDE` stroke where the background is not clipped, shows an unfilled ring the browser fills: say so, and that a stroke tinted the background's color would hide it, which `verify` will then score as a border color the code does not have.

### Variable binding for a root-only push

When token variable collections exist, bind component properties to variables instead of hardcoding values:
- Fills → bind to the matching variable from the Colors collection (e.g. `primary/500`)
- Padding / spacing → bind to the Spacing collection
- Corner radius → bind to the Radius collection
- Font size → bind to the Typography collection
- Drop shadows → bind to the Shadows collection

A measured value matches a variable when it equals what the variable was set from: its token's `hex` for a color, its `px` for a length, the light theme's that snap measures, never a `dark` one. A translucent color, `#rrggbbaa`, matches a variable of its `#rrggbb` too, as Tailwind's `border-destructive/30` is the `destructive` token at 30%. Several variables often share a value: on shadcn/ui, `#171717` is five color tokens, `primary` and `sidebar/primary` among them, and 10px is both the default radius and `lg`. Then bind the one the component's source names for that property. Read the classes the variant renders with (its `cva` variant, or its `className`) and take the token from the utility, named as `tokens` names it, with `/` for each `-`: `bg-primary` is `primary` for the fill, `text-primary-foreground` is `primary/foreground` for the text, `border-input` is `input` for the stroke, and `rounded-lg` is the radius `lg`. The source picks only among the variables of the measured value; the value is still snap's. A class with an opacity modifier, such as `bg-destructive/10` or `border-destructive/30`, names its variable at an opacity: snap measures it translucent, `#df22254d` say, which matches `destructive`'s `#df2225`, so bind it to `destructive 30%`, its alpha variable, which holds `destructive` at that alpha in each mode, and where a `dark:` class paints the token at another alpha, as shadcn/ui's destructive button's `bg-destructive/10 dark:bg-destructive/20` does, to one that holds each theme's, `destructive 10% dark 20%`. Before the first build part, make every alpha variable you bind with `npx storysync figma tokens --alpha "destructive 30%" --alpha "destructive 10% dark 20%"`, an `--alpha` for each, and send its calls as Tokens step 3 does. Bound to `destructive` at the paint's opacity instead, a translucent paint turns opaque at the first mode switch, and stays so. A shadow's color binds the same way, to a variable of its alpha, such as `foreground 10%`; `setPaints` leaves a translucent one bound to a token unbound. If you can't read the source, or it names no variable of that value (an arbitrary value like `bg-[#171717]`, or a class set elsewhere), leave the value unbound and list it in the summary, with the variables it matches, rather than pick one. A project that uses Tailwind's default spacing, type or shadow scales has no tokens for them, so those values stay as measured.

This ensures that when tokens change in code and storysync runs again, updating the variables automatically updates all components.

### Visual accuracy for a root-only push

- Prefer auto-layout so components resize properly. The measured `display`, `flexDirection`, `padding`, and `gap` map onto it directly.
- Add a text layer carrying the text the story actually renders — the story's args if they set the content, otherwise the component's default children (e.g. `children = "Button"`). Read it from source if you need to: the rule against reading source is about styles, not labels. Inline components are scored on width, so a different label reads as drift. Style it from the measured `text` values where present, and size it as `text.layout` says (step 3's table): a label snap gives no layout hugs its content, and one it gives a layout is fixed at that width, cut off or wrapped as the browser drew it, so a long title stays inside its frame.

## Audit

Compare the current Figma file against code to find drift in either direction. Use this when someone asks to "check if Figma is in sync", "audit the design system", or "diff Figma vs code".

If the `use_figma` tool doesn't return the plugin code's return value in a usable form, fall back to the read-only tools the Figma MCP server gives you, knowing what each covers: `get_metadata` outlines one node's layers (with no node, it lists the pages), and `get_variable_defs` returns only the variables and styles the selected node uses (on the remote server, the node a Figma link points at), so a variable no layer uses never appears. For a complete list, ask the user to export Figma's variables and components to JSON and diff against that.

`use_figma` takes at most 50,000 characters of code and returns at most 20kb per call. The code below is small, but a full palette or library passes 20kb on the way back, so both reads return a slice per call. Call each with `START = 0`, then again from the `next` it returns until `next` is `null`, and combine the slices. The variables read throws if a slice comes too close to 20kb; lower `BATCH` and read that slice again. The components read takes as many as fit under that limit in each call.

1. **Read Figma variables** — call `use_figma` to enumerate all variable collections and their resolved values. It reads each variable in its collection's first mode, as `value`, and, in a collection of several modes, in each, as `modes`, by mode name, for step 5 to compare the `Dark` one with the code's dark theme:

```js
use_figma({
  code: `
    const START = 0;
    const BATCH = 100;
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const all = collections.flatMap(coll => coll.variableIds.map(varId => ({ coll, varId })));
    const results = [];
    for (const { coll, varId } of all.slice(START, START + BATCH)) {
      const v = await figma.variables.getVariableByIdAsync(varId);
      if (!v) continue;
      const valueIn = (mode) => {
        const raw = v.valuesByMode[mode.modeId];
        if (v.resolvedType === 'COLOR' && raw && typeof raw === 'object' && 'r' in raw) {
          // #rrggbb, then the alpha as two more digits when it comes to less
          // than ff, as tokens writes a translucent color's hex.
          const channels = [raw.r, raw.g, raw.b].map(x => Math.round(x * 255));
          const a = Math.round((raw.a == null ? 1 : raw.a) * 255);
          if (a < 255) channels.push(a);
          return '#' + channels.map(x => x.toString(16).padStart(2, '0')).join('');
        }
        return String(raw);
      };
      const entry = { name: v.name, type: v.resolvedType, value: valueIn(coll.modes[0]), collection: coll.name };
      if (coll.modes.length > 1) entry.modes = Object.fromEntries(coll.modes.map((m) => [m.name, valueIn(m)]));
      results.push(entry);
    }
    const next = START + BATCH < all.length ? START + BATCH : null;
    const result = JSON.stringify({ total: all.length, next, variables: results });
    // use_figma JSON-encodes what this returns: measure the encoded string.
    const size = JSON.stringify(result).length;
    if (size > 17000) {
      throw new Error('This slice is ' + size + ' characters encoded, too close to 20kb: lower BATCH and read it again');
    }
    return result;
  `,
  description: "Read all variable collections and values from Figma file",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

2. **Read Figma components** — read the component sets and their variant properties, and the components outside any set, a page at a time. The push makes a component with no variant properties a plain component rather than a set, so those are components too. `use_figma` loads pages as it switches to them, starting each call on the first, and does not support `figma.loadAllPagesAsync()`, so a search from `figma.root` sees only the pages already loaded and misses the sets on every other — and the push puts each category on its own page. List the pages with a call that returns `JSON.stringify(figma.root.children.map(p => ({ id: p.id, name: p.name })))`, then make the call below once per page, as separate calls issued together, each switching to its page once. Each entry has the node's `nodeId`, its `type`, and the `storybookId` the push stored on it, or `null` where none did. Each call returns as many as fit under 20kb, so a page of a few hundred icons takes a few calls, not one per 25. Figma refuses to read the properties of a set it flags as errored, saying `Component set has existing errors`: that set comes back with that `error`, and the rest of its page is still read.

```js
use_figma({
  code: `
    const PAGE_ID = '0:1'; // one of the pages the first call listed
    const START = 0;
    const page = await figma.getNodeByIdAsync(PAGE_ID);
    if (!page || page.type !== 'PAGE') {
      throw new Error('No page with id ' + PAGE_ID);
    }
    await figma.setCurrentPageAsync(page);
    // The component sets, and the components outside any set, not a set's variants.
    const nodes = page.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
      .filter(n => n.type === 'COMPONENT_SET' || (n.parent && n.parent.type !== 'COMPONENT_SET'));
    function describe(node) {
      const entry = {
        name: node.name,
        type: node.type,
        nodeId: node.id,
        // The Storybook ID the push stored on it, or null where none did.
        storybookId: node.getSharedPluginData('storysync', 'id') || null,
        variantProperties: [],
        variantCount: node.type === 'COMPONENT_SET' ? node.children.length : 1,
      };
      if (node.type === 'COMPONENT_SET') {
        // Figma throws on a set it flags as errored: report it and read on.
        let defs = {};
        try {
          defs = node.componentPropertyDefinitions;
        } catch (e) {
          entry.error = String((e && e.message) || e);
        }
        for (const [key, def] of Object.entries(defs)) {
          if (def.type === 'VARIANT') {
            entry.variantProperties.push({ name: key, type: 'VARIANT', values: def.variantOptions || [] });
          } else if (def.type === 'BOOLEAN') {
            entry.variantProperties.push({ name: key, type: 'BOOLEAN', values: ['true', 'false'] });
          }
        }
      }
      return entry;
    }
    const slice = (components, next) => JSON.stringify({ page: page.name, total: nodes.length, next, components });
    // Take entries while the slice stays under 17000 characters as use_figma
    // JSON-encodes what this returns, short of its 20kb limit.
    const results = [];
    let end = START;
    while (end < nodes.length) {
      const entry = describe(nodes[end]);
      const next = end + 1 < nodes.length ? end + 1 : null;
      if (JSON.stringify(slice([...results, entry], next)).length > 17000) break;
      results.push(entry);
      end++;
    }
    if (end === START && START < nodes.length) {
      throw new Error('"' + nodes[START].name + '" alone comes to more than 17000 characters encoded, more than one call can return: report it as not read, and read on from START + 1');
    }
    return slice(results, end < nodes.length ? end : null);
  `,
  description: "Read the component sets, their variant properties and the components outside any set on one page of the Figma file",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

3. **Extract code tokens** — run storysync to get the code-side tokens:

```bash
npx storysync tokens --json --project .
```

   If its `warnings` say storysync can't read or find part of the Tailwind config, or doesn't follow it, or read no theme from it, code is missing the tokens that part declares. In step 5, report a Figma variable that code lacks as possibly coming from what the warning names, not as orphaned, and name the warning in the report.

4. **Map code components** — run storysync to get the code-side component mappings:

```bash
npx storysync map --storybook http://localhost:6006 --json
```

   map leaves out what the push left out, reading each component's `excludedProps` from `.storysync/snaps/styles.json`, which keeps the record of every component a push measured, and takes the props the stories' argTypes and args add from it too; pass `--snap <dir>` if the push's snap is elsewhere. Without that file, pass the `--exclude-props` the push used, if any, or every prop it left out is reported missing from Figma: snap records them as `excludeProps` at the top of `styles.json`, and the push's summary names them. If neither has them, as in a fresh clone, and props come back missing from Figma on components the push made (those with a `storybookId`), ask the user whether the push left those props out before you report them.

   If the user asked about some components only, first run `npx storysync list --storybook http://localhost:6006 --json`: it lists every component's `id`, `name`, `title` and `category` in one call, for step 6 to pair with. Then pass map, with `--components`, only the names in the scope that list has, by `id`, `title`, `name` or the last segment of `title`, ignoring case, rather than map every component, which can take many minutes. map refuses a name Storybook doesn't have, and a name only Figma has is for step 6. If list has none of them, skip map.

5. **Compare tokens** — match Figma variable collections to code token categories (Colors → colors, Spacing → spacing, etc.). For each token:
   - In code but not in Figma → **missing from Figma** (needs sync)
   - In Figma but not in code → **missing from code** (orphaned or manually added). storysync's own alpha and per-mode variables, a color token's name followed by a space and a percent or ` dark ` (`destructive 10%`, `destructive 10% dark 20%`, `background dark input 30%`, `input 0% dark 30%`), or two Tailwind palette colors (`slate-50 dark slate-900`), are not missing from code while each color in the name is a code token (the one after ` dark ` written as a class names it, `muted-foreground` for `muted/foreground`) or a palette color: leave them out of the report. One whose token is gone is missing from code.
   - Both exist but values differ → **value mismatch** (show code value vs Figma value)
   - Normalize before comparing: compare a color by its token's `hex` and a spacing, radius or size token by its `px`, which has rem and `calc()` worked out, where the token has one; otherwise lowercase hex colors, convert rem→px (1rem=16px), and strip units for numeric comparison. A translucent color is `#rrggbbaa` on both sides, step 1's template writing Figma's alpha as tokens does, so compare all eight digits. Round numbers to thousandths on both sides, since Figma can return a float with a tail of binary noise.
   - Compare each collection's first mode, the variable's `value`, with the token's light value. Where the `tokens` output's `modes` includes `Dark`, compare too each variable's mode named `Dark` (in its `modes`) with the token's `dark` `hex` or `px`, or its light ones where it has no `dark`, and report a difference there as a value mismatch in Dark. A token with a `dark` whose collection has no `Dark` mode is **missing from Figma** in Dark.
   - Note what can't be compared, for step 7 to name: every mode of a Figma collection but its first and the `Dark` one step 1's `modes` give, and the `Dark` one too where the `tokens` output's `modes` has no `Dark`; the tokens a `tokens` warning says it didn't read (`Unresolved:`, `Skipped dynamic value:`, `Not read from @theme`, `Uncategorized:`); and the categories `tokens` has no collection for in a project on Tailwind, whose components use Tailwind's default spacing, type or shadow scale, which `tokens` doesn't extract.

6. **Compare components** — pair each code component with a Figma component from step 2: a set, or a component outside any set, which is how the push builds a component with no variant properties.
   - **By ID first.** A Figma component whose `storybookId` is a code component's `id` is that component's, whatever its name or page, since a designer may have moved or renamed it. If two carry the ID, as a copy of a set does, tell them apart by page as below. One whose `storybookId` no code component has is Figma only, pushed from a component code no longer has under that ID (removed, or its story moved): never pair it with another component by name.
   - **Then by name**, for the code components no ID paired and the sets with no `storybookId`: pair each code component with a set of its set name, case-insensitively: the last segment of its `title`, or its `name` when it has no title, as Components step 4 names sets, or its `name` where no set has that and it is no other component's set name, as an earlier push named them. A name only one code component and one set have is a pair, whatever page the set is on. If two code components share a name (e.g. `Forms/Button` and `Nav/Button`), or two Figma component sets do (on different pages: an archived copy, say, or each category's own `Button`), counting those an ID paired, tell the rest apart by page, even when one is left on each side: Radix's `Button` is still one of two when Base UI's paired by ID, and a `Button` set left on another page may be a designer's own. A code component and a set of its name on its category's page (`Components` when it has none), each the only one of that name on that page on its side, are a pair, comparing page names ignoring case, spaces, `/`, `-` and `_`. Of the copies left, code components alone are code only, and sets alone Figma only. Copies left on both sides, even one of each, can't be told apart (a set on another page may be the component's, moved, or an archived copy beside a component not pushed yet): report the name as ambiguous, and only as ambiguous: compare none of the copies left, and don't also count them as matched, mismatched or missing. Name a component that shares its name by its `title`, and a set by its page and name.
   - **A component outside any set with no `storybookId`** may be a designer's own, such as an icon named `Calendar`. It pairs only with a code component the sets left code only, of its set name and on its category's page, each the only one there. It never makes a name ambiguous. One left unpaired is not one the push made, since the push stores a `storybookId` on each component it makes: don't list it as Figma only, but count it in the summary as not compared, unless the scope names it.
   - **A set with an `error`** is one Figma flags as errored, such as a set of one variant named `=`, which an earlier push made of a component with no variant properties. Pair it as any set, but report it as **errored in Figma (can't read its properties)**, by name, page and `nodeId`, and compare nothing in it. Don't delete it unless the user asks.
   - **When the audit is scoped**, pair as above with every component `list` gave, as components with no variant properties, so each Figma component pairs as it would in a whole audit. Compare and report only the components in scope, and a Figma component paired with none only if the scope names it, by name, page and name, or `storybookId`. A name in the scope that neither `list` nor Figma has is a typo: say so.

   For each component:
   - In code/Storybook but not in Figma → **code only** (not yet synced)
   - In Figma but not in code/Storybook → **Figma only** (orphaned or renamed)
   - Both exist → compare variant properties: missing props, extra props, missing/extra values per prop.

7. **Report** — present a structured drift report:
   - Group by category (tokens) or component name
   - Use clear labels: `+` missing from Figma, `-` missing from code, `~` value mismatch, `?` ambiguous, `!` errored in Figma
   - End with a summary: N tokens matched, N mismatched, N missing. N components matched, N mismatched, N code-only, N Figma-only, N ambiguous, N errored in Figma, and N components outside any set not from the push, not compared.
   - Beside the token counts, say what they cover and what they don't, from step 5's notes, so `39 matched` isn't read as every token in both themes: `39 matched (colors and radius, in Light and Dark; not compared: the High contrast mode of Colors, font/sans and font/mono, which tokens couldn't resolve, and Tailwind's default spacing, type and shadow scales, which have no tokens)`.
   - Confirm "Figma and code are in sync." only if everything matches and no name is ambiguous or set errored; components outside any set not from the push don't count against it. An ambiguous name was compared on none of its copies, and an errored set on nothing, so either can hide drift: while any is, name them instead, and never say the two are in sync. Say with it what the audit compares: tokens, in the modes it noted, and each component's variant properties, not the styles the push's `verify` scores.

8. **Score how the sets look, when the user asks.** Steps 1 to 7 compare token values and variant properties, not what a set looks like. To audit that too, score the sets as a push's `verify` does, reading Figma and changing nothing in it:

```bash
STORYSYNC_PROGRESS=1 npx storysync snap --storybook http://localhost:6006 --variants all --out .storysync/audit/snaps --json > .storysync/audit-snap-out.json 2> .storysync/audit-snap-progress.log; echo "exit $?" >> .storysync/audit-snap-progress.log
npx storysync figma code --snap .storysync/audit/snaps/styles.json --out .storysync/audit/figma
```

   Run the snap in the background, as Components step 3 does, with the components in scope as `--components`, the push's `--exclude-props` and `--keep-props`, and the push's `--stories`, as `--stories <id>=<storyId>` for each component in scope with the `storyId` the push's `.storysync/snaps/styles.json` records for it, ending it with `!` where the component records `storyOnly: true`, in single quotes, so each is measured from the story the push measured it from (scored from another story, its layers would read as drift that isn't there); where that file isn't there, as in a fresh clone, take them from the push's summary, or ask the user whether the push measured any component from another of its stories. Check that it ended `exit 0`. It writes under `.storysync/audit`, so the push's own snap and readback stay as they are. Then send **only the plan's `read` calls**, as Components step 5 sends calls, saving each response unchanged and continuing each with `npx storysync figma next --plan .storysync/audit/figma/plan.json --seq <its seq>`. Never send its `build`, `images` or `label` calls: they change the file. A read call that throws `Found 0 sets with storysync id …` names a set storysync never pushed, or one on another page: note it, run `figma code` again with that component in `--skip`, and send the read calls again. Then:

```bash
npx storysync verify --plan .storysync/audit/figma/plan.json
```

   It writes the readback to `.storysync/audit/figma-readback.json`. Add to the report, per component: its element fidelity and each difference, by key and node id; elements missing from Figma, and layers for elements snap no longer measures; designer layers; pictures not filled, which score as a wrong picture; the sets an earlier storysync pushed root-only, whose variants carry no element keys, so `verify` reports each variant missing and lists it as `not built by storysync`, which a push with Components step 5 deepens; the sets no read found; and that the element-tree readback doesn't read variable bindings yet, so it can't say how many paints are bound to a variable. Report what it finds; never fix it in the audit.

## Visual accuracy guidelines

- **Measured values from `snap` are ground truth.** They come from a real browser rendering the real component. Where they disagree with your reading of the source, the measurement is right — computed style accounts for the cascade, inherited values, and anything a class name does not reveal.
- **Never invent a value that could be measured.** Guessing that "a primary button is typically blue" produces a library that looks plausible and is wrong, which is worse than one that is visibly incomplete. In a push through `figma code`, a variant snap couldn't measure is built as a placeholder that says so, never styled from source. Only a root-only push, which the user asked for, falls back to the source for one, as its section says, and records it as `inferred`, which `verify --strict-measured` fails on.
- **The calls are the build.** Each layer `figma code` writes, its key, styles and place, comes from snap's measurement, and `verify` scores Figma against that measurement, not against the calls. A call or a layer changed by hand builds or keeps what nobody measured: send the calls as written, and report what they can't build.
- The goal is a Figma library a designer can use directly, not variant scaffolding. The build gives each frame auto layout where Figma's auto layout puts its children where the browser did, so the components resize as the code's do, and binds their colors and radii to the token variables.
