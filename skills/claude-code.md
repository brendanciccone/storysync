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

Before syncing components, extract design tokens from the project and create Figma variable collections. This ensures components can bind to variables instead of hardcoded values.

1. **Extract tokens** — run storysync to detect and extract tokens from the project:

```bash
npx storysync tokens --json --project .
```

This auto-detects the token source (a Tailwind config or Tailwind v4 `@theme` block, CSS custom properties, or theme files) and outputs structured JSON:

```json
{
  "source": "tailwind",
  "sourcePath": "tailwind.config.ts",
  "collections": [
    {
      "category": "colors",
      "tokens": [{ "name": "primary/500", "value": "oklch(62.3% 0.214 259.815)", "hex": "#2b7fff" }, ...]
    },
    {
      "category": "spacing",
      "tokens": [{ "name": "4", "value": "1rem", "px": 16 }, ...]
    }
  ],
  "summary": { "totalTokens": 42, "collections": 4 }
}
```

If the command returns no collections, skip to Components.

2. **Preview tokens** — optionally, run `npx storysync tokens --project .` (without `--json`) to show a human-readable preview, or `npx storysync tokens --project . --all` to show every token.

3. **Create Figma variable collections** — use the JSON output from step 1 to create Figma variables. Call `use_figma` with one collection at a time:

```js
use_figma({
  code: `
    // Create Colors collection
    const colors = figma.variables.createVariableCollection('Colors');
    const mode = colors.modes[0];

    // Add variables, each color from its token's hex
    const primary500 = figma.variables.createVariable('primary/500', colors, 'COLOR');
    primary500.setValueForMode(mode.modeId, figma.util.rgba('#2b7fff'));

    // ... repeat for each color token from the storysync output

    // Create Spacing collection
    const spacing = figma.variables.createVariableCollection('Spacing');
    const spMode = spacing.modes[0];
    const sp4 = figma.variables.createVariable('4', spacing, 'FLOAT');
    sp4.setValueForMode(spMode.modeId, 16); // its token's px

    // ... repeat for each spacing token
  `,
  description: "Create variable collections: Colors (N variables), Spacing (N variables), Radius (N variables), Typography (N variables), Shadows (N variables)",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

   Use Figma `COLOR` type for colors and `FLOAT` type for spacing, radius, and font sizes. A Tailwind v4 `@theme` names its typography tokens by namespace: `text/*` are font sizes, `font/weight/*` weights, `leading/*` line heights and `tracking/*` letter spacing, all `FLOAT`, and the other `font/*` are font families, `STRING`. Set each `FLOAT` variable from its token's `px`, not its `value`: `px` is the value in pixels with rem (16px) and `calc()` worked out, so `calc(0.625rem - 4px)` is 6, and `value` is as the source writes it. A weight or a unitless line height has no `px`, and its `value` is the number to set. Leave out, and say which, any other `FLOAT` token with no `px`, such as one in em or % (as letter spacing often is), which depends on the element. Leave out too, and say which, any token a `tokens` warning starting `Unresolved:` names: its `var()` is set nowhere storysync reads (next/font, say, sets a font's at runtime). The tokens such a warning says were not read from `@theme`, shadcn/ui's `font/sans` and `font/mono` among them, are out of the output already: name them all the same. A `value` can keep a `var()` that did resolve, as `calc(var(--radius) - 4px)` in `:root` does; set that token from its `px` or `hex` as usual. If no token in the output has a `px` at all, an older storysync ran: use a plain rem `value` times 16, or a px one as is, in place of `px`.

   Set each color from its token's `hex`, not its `value`: `figma.util.rgba(token.hex ?? token.value)`. `value` is the color as the source writes it, and `figma.util.rgb` and `rgba` take only hex, `rgb()`, `hsl()` and `lab()`, so a value in `oklch()`, `oklab()`, `lch()`, `hwb()` or `color()`, or bare HSL channels such as `0 0% 100%`, throws. `hex` is sRGB, `#rrggbbaa` when the color is translucent, which `rgba` keeps. A color token with no `hex` is one storysync couldn't convert, such as `currentColor` or an unresolved `var()`; if `rgba` throws on its `value` too, leave it out and say which.

   A `use_figma` call takes at most 50,000 characters of code, and one that runs too long fails with `Script exceeded time limit`; creating variables is slow. Split a large collection — a full color palette runs to hundreds — across calls of a few dozen variables each, finding the collection the first call created rather than creating another.

4. **Verify** — confirm the variable collections were created with the expected count, less the tokens you left out. If any are missing, retry.

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

The `title` is the component's Storybook title, and `category` its place in Storybook's sidebar (the part of `Forms/Button` before the last `/`). Use them to organize the Figma file — see step 4 below. `id` is Storybook's ID for the component, which no other component shares, where a `name` can be: `--components` and `inspect` take a title or an ID as well as a name.

   Step 3 reads each component's docs and renders every variant in a browser, which takes several seconds a component, and more on a busy Storybook: 134 components took about 17 minutes. **If there are more than about 20 components, stop and ask the user what to push before measuring anything:** all of them, some categories (name each with how many components it has), or some components. Pass what they choose to step 3 as `--components`, by ID. With 20 or fewer, push them all.

   If a command fails because Storybook didn't answer in time (an error naming `--connect-timeout`), a busy or shared Storybook is slow rather than down: run it again with `--connect-timeout 180000`.

2. **Inspect individual components** — for detailed prop-to-variant mapping of a specific component:

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

   `npx storysync map --storybook http://localhost:6006 --json` maps every component's variant properties without rendering anything. The push doesn't need it: snap's output carries the same `id`, `title`, `category` and `variantProperties`, and a map first would read every component's docs twice.

3. **REQUIRED — Measure the styling. Do not infer it.** Do not proceed to step 5 without concrete values. A `use_figma` call containing only variant names produces a useless component library.

```bash
mkdir -p .storysync
STORYSYNC_PROGRESS=1 npx storysync snap --storybook http://localhost:6006 --variants all --json > .storysync/snap-out.json 2> .storysync/snap-progress.log; echo "exit $?" >> .storysync/snap-progress.log
```

   Add `--components` with the IDs step 1 agreed on, unless the user chose every component. This renders each variant in a real browser and reports what the browser actually computed, so the values are measured rather than guessed. This measures **every combination** of the component's variant props, so every Figma variant you build is measured rather than guessed. **Build one Figma variant per snap variant, whatever its status** — a Figma component set needs every combination to exist, or the variant picker has nothing to switch to. **If a component carries a `cap` field** (its combinations exceed the limit, 256 by default), snap measured only a subset and warned about it; the cap's `uncovered` list names any values that subset left out entirely. **Stop and ask the user before building that component.** Tell them its total and the limit, and offer: build the measured subset; measure it again with `--components <its ID> --merge --max-combinations <total>` to measure all of them (very large component sets get slow in Figma); or narrow which props are variants: re-run snap with `--exclude-props` naming the props that don't change how it looks, such as `modal` or `loop`, which leaves them out of every component. Do not offer to fill the unmeasured combinations in from source: they can be measured by raising the limit, and a value the tool can read must never be guessed. Do not choose for them. Run it *now*, in this session — do not reuse a `styles.json` from an earlier run, which may describe code that has since changed.

   **Run it in the background, and check how it ended before building.** An agent's shell stops a command after a few minutes (Claude Code's Bash tool after 2 by default, and 10 at most), and snap stopped part-way writes nothing. So start the command above in the background (`run_in_background` in Claude Code, or wrapped in `( ... ) &` elsewhere), as any storysync command that may take more than a minute or two. `STORYSYNC_PROGRESS=1` makes it log a line per component and variant, such as `snap 12/134 UI Base/Command, variant 3/32`: check on it with `tail -n 1 .storysync/snap-progress.log` until the last line is its `exit` code. Claude Code also tells you when a background command ends, so there you can wait for that, then read the last line.

   - `exit 0`: it finished, and wrote `.storysync/snaps/styles.json` and `meta.json`.
   - `exit 1`: it failed, with the reason as `{"error": ...}` in `.storysync/snap-out.json`: Storybook unreachable or too slow (raise `--connect-timeout`, as step 1 says), a `--components` name that matches nothing, a `--merge` it refused (below), or the browser closing twice. An option it can't take, such as a `--timeout` that isn't a number, is said in the progress log instead.
   - `exit 130`, `143` or `129`: it was stopped, by Ctrl-C, SIGTERM (a command timeout, say) or SIGHUP, and the log says so.

   After any exit but 0, the `styles.json` and `meta.json` in `.storysync/snaps` are an earlier run's: never build from them. Deal with what it said, and run it again in the background. After `exit 0`, check too that `meta.json` is this run's: its `measuredAt` is after you started it, or, after a `--merge`, which keeps `measuredAt` at the oldest component's time on purpose, its `componentsMeasuredAt` time for each component you named is. Read the measurements from `.storysync/snaps/styles.json` on disk, a component at a time (with `jq` or `node`, say): `snap-out.json` holds the same JSON on one line, which tools cut short.

   The output gives, per component, full styles for a base variant plus only the properties each other variant changes:

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
   | `borderUniform` on a hugging frame | `strokeAlign = 'OUTSIDE'`, or `INSIDE` with `strokesIncludedInLayout = true` for a transparent or translucent border the fill runs under (see below) |
   | `width` or `height` of 0 | 0.01, the least Figma's `resize` takes: a closed collapsible's content renders nothing, and is built as next to nothing |

   Five things that go wrong by default, in ways `verify` either will not catch or will not explain:

   - **Stroke alignment: the stroke adds to the size.** snap's `width`/`height` are the element's outer size, border included, and the Figma frame's outer size, its own size plus the stroke outside it, must match them. On an element sized by its content — every inline or inline-flex component, and any auto-layout frame you let hug — a CSS border always adds to the outer size, whatever `boxSizing` says; `box-sizing` only changes how an *explicit* width or height is read. Figma's default, `INSIDE` on a hugging frame, eats into the padding instead and leaves the variant short by twice the border width. So build a border one of two ways on a hugging frame: `strokeAlign = 'OUTSIDE'`, or `INSIDE` with `strokesIncludedInLayout = true`, which adds the stroke to the frame's own size; and on a frame you give a fixed size, `INSIDE` at the measured `width`/`height`. **A transparent border still takes its space.** A `borderUniform` whose `color` is `null`, such as CSS `border: 1px solid transparent`, is in snap's `width`/`height` like any other, so give it a stroke of that weight, aligned the same way, with a paint that draws nothing (`{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0 }`), never no stroke: without one the variant is short by twice the border. Step 6 reads the size from the geometry, which counts a stroke whether its paint shows or not, and reads that stroke's color back as `null`, as snap measured it. **Where the fill stops is `backgroundClip`**, which picks between the two for a transparent or translucent border. The browser paints the background under such a border unless it is clipped to the padding box. With `backgroundClip: padding-box`, as shadcn/ui's Button has (`bg-clip-padding`), the fill stops at the border, as Figma's does at an `OUTSIDE` stroke, so build that border `OUTSIDE` (on a fixed-size frame, at the measured size less twice the border's weight). Without it, CSS's `border-box`, as on shadcn/ui's Badge, the fill runs under the border, as Figma's does under an `INSIDE` stroke, so build it `INSIDE`, with `strokesIncludedInLayout = true` on a hugging frame. Either way the size and the stroke's color read back as measured; never paint the stroke to look filled, which `verify` scores as a border color the code does not have.
   - **Lay the variants out.** A component set is a frame containing its variants, each needing its own x/y, and the frame must be grown to fit them. Created without positions they all land at `0,0`, stacked and clipped by a frame still sized for one. Position each variant in a grid — one row per value of the first variant property, the remaining combinations across — with spacing, and size the set to contain them. With every combination built, a single row of dozens of variants is unreadable. **Order the grid by snap's `variantProperties`, never by the set's children**: their order is whatever an earlier push or a designer left, and a set laid out in it gets rows whose columns disagree. Take the properties, and each one's values, in the order snap records them: a `VARIANT`'s default value first, then the rest in the order of the component's prop type as Storybook's docs list it (a story's `argTypes` options are not read); a `BOOLEAN`'s default comes first, `false` before `true` unless it defaults to `true`. Each column is then one combination of the other properties in every row, and the layers panel lists the variants in the same order. Figma makes the top-left variant the set's default variant, so that is the variant of each property's first value: the component's own default. Step 5's build template does all of this; give it the properties and leave its layout as it is.
   - **Assert the layout before returning.** After positioning, check that no two variants' bounding boxes intersect and that the set's bounds contain every child. Geometry comparison catches variants clipped by an undersized frame, but two same-sized variants stacked inside an adequately sized one measure correctly and stay invisible — so the check has to happen here, at write time.
   - **Figma's plugin context has only Google Fonts.** `listAvailableFontsAsync` returns Google families and nothing else — no Arial, no Helvetica, no SF Pro, no Segoe UI, no Menlo. A designer sees those in the desktop app's picker because it reads their *local* system fonts, but the environment `use_figma` runs in does not have them, and `figma.loadFontAsync` throws on one. So load every text layer's font with the build template's `loadFont(family, weight)`, which never fails the part over a font: it loads the measured family where Figma has it, and otherwise a stand-in at the measured weight, Roboto Mono for a monospace face (Menlo, Monaco, Consolas, `ui-monospace`, `monospace`), Noto Serif for a serif one (Georgia, `ui-serif`, `serif`) and Inter for any other. A weight the family lacks loads as the next one toward Regular, as Roboto Mono, which stops at Bold, sets 800 in Bold: that is a stand-in too, which `verify` scores as `fontWeight` drift. The part returns each stand-in it used in `fonts`, such as `{ "system-ui 600": "Inter Semi Bold", "Menlo 400": "Roboto Mono Regular" }`. Name every one in the summary. A CSS keyword, such as `system-ui`, `sans-serif` or `ui-sans-serif`, is the platform's own font, which no Figma font is named after (a system stack like Tailwind's default `-apple-system, BlinkMacSystemFont, ...` measures as `system-ui`), and `verify` does not score it, so its stand-in is not drift. A platform face such as Menlo or SF Pro is scored, so its stand-in shows as `fontFamily` drift no edit in Figma can fix: report it as the substitution it is; the real face is the user's to install or map in the desktop app.
   - **`fontAvailable: false` means the measurement describes a substituted typeface.** `fontFamily` is the family the browser drew with, except a named font it could not load that the stack lists before any system keyword (such as `-apple-system` or `ui-monospace`), which is recorded as the code *asked for* it, with `fontAvailable: false`: the geometry and text you measured are not the intended font's. Say so in the summary. If Figma also lacks the font, name it explicitly — "Figma has no *Inter*; install it or map it" — rather than letting it surface as unexplained text drift. storysync cannot install fonts into Figma; that is a manual step in the desktop app.

   **Variants where `status` is not `"ok"` were not measured.** A `timeout` loading the story was already tried twice; a busy Storybook times out stories that render, so first measure those components again, in the background as above, adding `--components <their IDs> --merge` and a longer `--timeout`, such as 30000, to the same command. `--merge` measures only those and merges them into `.storysync/snaps/styles.json`, keeping every other component as it was measured, and gives `meta.json` each component's own time, in `componentsMeasuredAt`, with `measuredAt` the oldest of them, so `verify --strict-age` judges the snap by its oldest part; it refuses a snap it can't add to, such as one taken with another `--storybook`, `--variants` or `--exclude-props`. Never re-measure some components with `--components` alone: that writes a `styles.json` of those alone, and step 6's `verify` would score only them. Only for what still fails, fall back to reading the component's source (`.tsx`/`.jsx`, CSS modules, styled-components, inline styles, `cva`/`clsx`/`cn` calls) and resolve any design tokens through `npx storysync tokens --json` or the project's own config — never from a memorized class-to-value table, which is wrong for any project with a custom palette.

   **Every fallback must be recorded, not just mentioned.** In step 6 you will write a `source` of `"measured"` or `"inferred"` for each variant. A run inspected later must be able to tell the difference without reading this conversation. So must an audit tell which props you left out with `--exclude-props`: pass the same list to every `snap` you run for this push, re-runs included, and name those props in the summary (step 7). snap records them as `excludeProps` in `styles.json`, where an audit reads them, and a run without the flag measures them again and drops that record (a `--merge` without it refuses to run).

   **Checkpoint before step 5**: every variant has either measured styles or an explicit source-derived spec. If all of a component's variants measured identically, `snap` says why it thinks so, by what each variant's markup did. Where they also `rendered the same markup`, nothing the args set reached the page: the story may not pass its args through. Still write the measured values and label them `measured`, which is what the story actually renders, and say so in the summary; the fix belongs in the story. Where `their markup changed with the args`, the story passes them through, and the props the warning names change nothing snap measures, likely only behavior, as input-otp's `textAlign` and `pushPasswordManagerStrategy` do: never say the story drops its args. Ask the user, in the same message as any cap or trigger question below, whether to leave those props out, re-running snap with the warning's `--exclude-props` added to any this push already passes, or to build the identical variants as measured; name the props in the summary either way. Where the warning says both, the markup couldn't settle it: say both in the summary. In every case, do not substitute values from source: a variant styled from source would be scored against a measurement it does not match. The same goes for a warning that a prop's values all measured the same: build what was measured, and name it in the summary with the fix the warning gives.

   **Stop and ask about every component snap measured as something else.** When snap warns that it measured a closed trigger (a dialog, popover, sheet, menu or tooltip whose content renders only while open) or a layout wrapper rather than the component, the Figma component would be that trigger or wrapper, and `verify` would score it as faithful. Before building any of them, ask the user once, listing each such component with the element snap measured, which they want:

   - **Build what was measured**, and say so: in the summary, and in Figma, on a line of each such set's description that starts `storysync:`, which the template below sets after the build.
   - **Skip them**, naming them in the summary as not pushed. They stay in `styles.json`, so give their IDs to step 6's `verify` as `--skip`, which leaves them out of the score and names them under it. Without it, `verify` lists each of their variants as missing from Figma, which is no reason to build them.
   - **Stop**, so they can give each a story that renders it open (with `defaultOpen`, say) or on its own, as the warning says. Then measure those again with `--components <their IDs> --merge`, as above.

   Ask it in the same message as any cap question, and do not choose for them. Never style such a component from source instead: it would be scored against a measurement it does not match.

   **Label the sets after the build, on every push.** Once step 5 has built them, make one `use_figma` call with the template below, giving it every set and plain component this push built, by the id step 5 returned: a note for each one built from a closed trigger or a layout wrapper, and `''` for every other. It replaces only the description's line that starts `storysync:`, keeping every other line, a designer's own included, and an empty note removes the line an earlier push left. So a set rebuilt once its story renders it open no longer says it was measured from its trigger. Figma returns a description HTML-escaped, `"` as `&quot;` and `&` as `&amp;`, so one written back as it was read gains another escape on every push (a live push left `button[data-slot=&quot;dialog-trigger&quot;]` on Dialog): the template reads it unescaped, edits a designer's formatted description through `descriptionMarkdown` so their formatting stays, and writes only a description it changed, so a second run changes nothing.

   The same call removes Figma's default page, `Page 1`, once the push has put every set on a page of its category, but only while it is as Figma made it: still named `Page 1`, empty, and not the file's only page. It returns `pageOne`: `removed`, `kept: it holds layers`, `kept: it is the only page`, `kept: Figma refused to remove it` with Figma's reason, or `none` where the file has no page of that name. Say in the summary which it was; a page a designer renamed or used is left alone.

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
    // another page remains. Switching to it loads it, so its layers count.
    let pageOne = 'none';
    const blank = figma.root.children.find((p) => p.name === 'Page 1');
    if (blank) {
      await figma.setCurrentPageAsync(blank);
      const other = figma.root.children.find((p) => p !== blank);
      pageOne = blank.children.length ? 'kept: it holds layers' : !other ? 'kept: it is the only page' : 'removed';
      if (pageOne === 'removed') {
        await figma.setCurrentPageAsync(other);
        try {
          blank.remove();
        } catch (e) {
          pageOne = 'kept: Figma refused to remove it (' + String((e && e.message) || e) + ')';
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

   **Set colors with `setPaints`, and fonts with `loadFont`.** Set every fill, stroke and effect with the template's `setPaints(node, 'fills' | 'strokes' | 'effects', items)`, never by assigning it: each item is a paint or effect in its measured color, with `variable` set to the color variable to bind, if any. Figma gives a paint assigned freshly bound to a variable an opacity of 1, so a translucent color bound that way loses its alpha (a live push read Attachment's error border, `#df22254d` bound to `destructive`, back as `#df2225`): `setPaints` puts each paint's opacity back once the binding is stored. An effect bound to a color variable takes that variable's alpha, so `setPaints` leaves a shadow unbound, in its measured color, where binding changed its alpha. Load every text layer's font with `loadFont(family, weight)`, as step 3 says, and before changing the text of a label an earlier push made, load the font it has (`figma.loadFontAsync(text.fontName)`), or make a new label where that font won't load. If `applyStyles` throws part way, the part removes the variants it created before it fails, so none is left loose on the page, and a retry makes them again.

   **Return the set's id.** End the plugin code by returning the component set's id — step 6 reads the variants back from it, and fixes target it. Leave the readback itself to step 6: `use_figma` returns at most 20kb per call, and a whole set's readback passes that at a few dozen variants.

   **Build a set in parts of at most 25 variants.** `use_figma` takes at most 50,000 characters of code per call, and a variant's measured values run to about a thousand characters, so a large set's code does not fit in one call; a call that runs too long also fails, with `Script exceeded time limit`. Write the values as a table, one entry per variant, leaving out `border` where `borderUniform` is set and `borderRadius` where `borderRadiusUniform` is, which only repeat them, and create the variants in a loop over it rather than writing out each one's code. Measure each part's code before sending it: if it passes 45,000 characters, build that set in parts of 15 instead, `PART = 15` on every part. Build a set of more than 25 variants across calls, in snap's variant order: the first finds the set by name anywhere on its page, or creates it, with the first 25; each later call finds it by id and does the same with the next 25; and every part lays out and checks the whole set as it then stands, so the last leaves it laid out in full. If a call fails with `Script exceeded time limit`, check what it left on the canvas before retrying, and build in smaller parts.

   **A part updates the variants it names and adds only the ones the set lacks.** On a set an earlier push built, or one a failed call left half done, each part finds each of its variants among the set's children by name, restyles it if it is there and creates it if it is not. It never creates a second variant of a name the set already has: it refuses, before changing anything, a part that names a variant twice, and a part whose set already holds two of a name it carries — with the error step 6's readback gives for that, and the same remedy. So a part can be retried, and a push repeated, without duplicating anything; and every part lays the whole set out again and checks it, so a part re-run on its own leaves the set laid out. A variant in Figma that snap no longer has — one for a value the code has since dropped — is named by no part, so the build leaves it alone, laid out in a row of its own below the others: step 6 finds it, and you report it. Delete it only if the user asks; a designer may have built on it.

   **Every part lays the whole set out in snap's order, and checks it.** Give each part the component's `variantProperties` from snap's output as `PROPERTIES`, copied as they are: the same table on every part, a few hundred characters even for 256 variants. Leave the template's layout as it is. It orders the set by `PROPERTIES`, never by the set's children, whose order is whatever an earlier push or a designer left:

   - Each property's values run in the order snap records them: a `VARIANT`'s default value first, then the rest in the order of the component's prop type as Storybook's docs list it (a story's `argTypes` options are not read). A `BOOLEAN` property runs its default first, `false, true`, or `true, false` when it defaults to `true`, whatever order snap lists its values in.
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
    // variable to bind, if any. Figma gives a paint freshly bound opacity 1
    // and an effect its variable's alpha: this puts the opacity back, and
    // leaves an effect unbound where its alpha changed.
    const setPaints = (node, key, list) => {
      const fx = key === 'effects';
      const raw = list.map(({ variable, ...p }) => (fx ? p : { opacity: 1, ...p }));
      node[key] = list.map((p, i) => (p.variable ? figma.variables[fx ? 'setBoundVariableForEffect' : 'setBoundVariableForPaint'](raw[i], 'color', p.variable) : raw[i]));
      node[key] = node[key].map((p, i) => (!fx ? { ...p, opacity: raw[i].opacity } : !p.color || Math.abs(p.color.a - raw[i].color.a) < 0.002 ? p : raw[i]));
    };
    // A text layer's font: the measured family, else Roboto Mono for a mono
    // one, Noto Serif for a serif, Inter for any other; at the measured weight,
    // else the next toward Regular, in either spelling. It never throws, and
    // FONTS, returned below, names each stand-in.
    const STYLES = ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black'];
    const FONTS = {}, fonts = {};
    const loadFont = (family, weight) => fonts[family + weight] = fonts[family + weight] || (async () => {
      const i = Math.min(8, Math.max(0, Math.round((weight || 400) / 100) - 1)), d = Math.sign(3 - i);
      const alt = /mono|menlo|monaco|consolas|courier/i.test(family) ? 'Roboto Mono' : /^(?!.*sans).*(serif|georgia|times)/i.test(family) ? 'Noto Serif' : 'Inter';
      for (const f of new Set([family, alt, 'Inter'])) {
        for (const j of new Set([i, i + d, i + 2 * d, 3].filter((j) => (j - 3) * d <= 0))) {
          for (const s of new Set([STYLES[j], STYLES[j].replace(' ', '')])) {
            try {
              await figma.loadFontAsync({ family: f, style: s });
              if (f !== family || j !== i) FONTS[family + ' ' + weight] = f + ' ' + s;
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
          "readAt": "2026-10-01T22:19:04.123Z",
          "checksum": "fnv1a:e14125de"
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
          "readAt": "2026-10-01T22:19:04.391Z",
          "checksum": "fnv1a:3d72d28a"
        }
      }
    }
  }
}
```

   **`source` is required on every variant**, and the template sets it from `SOURCE_BY_SLUG`: `"measured"` when the values came from `snap`, `"inferred"` when you fell back to reading source in step 3. Omitting it is not neutral: `verify` reports the entry as incomplete, since the template always returns it, and its provenance as `unrecorded`, and `--strict` and `--strict-measured` both fail on it, because a run that cannot distinguish measured from guessed is decorative. To correct one, correct the table and read the slice again: the checksum covers `source` too, so an entry whose `source` was changed in the file is an unverified readback.

   Then:

```bash
npx storysync verify --strict-age
```

   This reports a fidelity score — the share of properties Figma agrees with — plus anything that drifted, any variant Figma never received, the provenance breakdown, and the age of the measurement. Add `--skip` with the IDs of any component the user chose not to push (step 3), or that you skipped in step 5, for its set's auto layout or for a set or plain component of its name an earlier push left, as in `--skip ui-base-dialog,ui-base-sheet`: `verify` leaves them out of the score and names them under it, where otherwise it lists each of their variants as missing from Figma.

   Fix what it flags with a follow-up `use_figma` targeting the node by ID, then read the set back again and re-run `verify`. Four things it flags are not fixed by editing a node: an `unscored` variant means your readback returned nothing comparable for it — re-read that node; an entry whose checksum is missing or does not match, or whose component has the `nodeId` of another, is not what the readback returned — read that slice, or both components' sets, again and write their entries exactly as returned, each component under its own set's id, never editing the file to make it pass; an `incomplete` entry was read with the template cut down, and a `stale` one before the snap — read that slice again, now, with the template as it is; and `! snap recorded a failure` means the measurement itself is incomplete, not Figma: where it names a component's error, measure that component again (step 3, with `--merge`), and where it says components share a key, or that the snap recorded no components, do what snap warned and run the whole snap again. Nor, as a rule, is a `width` a pixel or two off on a variant that hugs its text, with nothing else on it drifting: Figma lays text out with its own metrics, about a pixel apart from the browser's (a chip labeled "Chip" in bold 11px Inter measured 38.59 wide in Chrome and 40 in Figma), and verify's allowance is narrowest on small labels. Report it as a font-rendering difference rather than fixing the text's width to squeeze it, which can clip the label, but only when the variant's stroke is `OUTSIDE`, `INSIDE` with `strokesIncludedInLayout`, or it has none, and the difference is not exactly twice the measured border's weight. Otherwise check its `strokeAlign` first: an `INSIDE` stroke on a hugging frame without `strokesIncludedInLayout` leaves the variant short by exactly twice the border, a `CENTER` one by the border, and a transparent border built with no stroke by twice the border too, and each is a build mistake to fix, not font rendering. Nor is a `borderUniform` whose measured `style` is `double`, `groove`, `ridge`, `inset` or `outset`: Figma's strokes have none of those, so report it rather than spend a fix round on it; nor a `fontFamily` the build parts' `fonts` name a stand-in for, which no edit in Figma can fix. **Stop after two fix rounds** and report the residual score. `use_figma` calls are rate-limited and becoming a paid feature; an unbounded repair loop burns that budget for diminishing returns.

7. Summarize what was synced: token collections created, and that they hold the light theme alone where a `tokens` warning starts `Only the light theme is read`, components grouped by page, whether the label call removed Figma's default page `Page 1` or why it kept it (its `pageOne`), variant counts, the components built as one plain component for having no variant properties, **the fidelity score**, worded as `verify` words it: where its line says `of verified entries`, how many entries it left unverified, which the score doesn't cover, how many variants were measured versus inferred, any components whose stories did not pass their args through, any props snap found reach a component but change nothing it measures, and what the user chose for them, each component snap measured as a closed trigger or a layout wrapper and what the user chose for it (step 3), what `verify` printed under the score about what snap measured, the values left unbound because several variables share them (Variable binding, below), every font stand-in the build parts returned in `fonts` (a CSS keyword such as `system-ui` set in Inter, a platform face such as Menlo in Roboto Mono), which variant Figma will treat as a set's default where that is not the component's default (step 5), any set skipped for its auto layout, any component skipped for a set or plain component of its name an earlier push left (step 5), any set or component a part returned `overlaps` for, and whether the user had it moved, any border built solid for a style Figma's strokes lack, any variant built 0.01 wide or high for a measured 0, the variants with a transparent border, and any failures or caps. For each variant with a transparent or translucent border, say how its fill meets that border, as the browser draws it: with `backgroundClip: padding-box` the fill stops at the border, and Figma's `OUTSIDE` stroke leaves the same unfilled ring; without it the fill runs under the border, built as an `INSIDE` stroke with `strokesIncludedInLayout`. A transparent border built any other way, such as an `OUTSIDE` stroke where the background is not clipped, shows an unfilled ring the browser fills: say so, and that a stroke tinted the background's color would hide it, which `verify` will then score as a border color the code does not have.

## Variable binding

When token variable collections exist, bind component properties to variables instead of hardcoding values:
- Fills → bind to the matching variable from the Colors collection (e.g. `primary/500`)
- Padding / spacing → bind to the Spacing collection
- Corner radius → bind to the Radius collection
- Font size → bind to the Typography collection
- Drop shadows → bind to the Shadows collection

A measured value matches a variable when it equals what the variable was set from: its token's `hex` for a color, its `px` for a length. A translucent color, `#rrggbbaa`, matches a variable of its `#rrggbb` too, as Tailwind's `border-destructive/30` is the `destructive` token at 30%. Several variables often share a value: on shadcn/ui, `#171717` is five color tokens, `primary` and `sidebar/primary` among them, and 10px is both the default radius and `lg`. Then bind the one the component's source names for that property. Read the classes the variant renders with (its `cva` variant, or its `className`) and take the token from the utility, named as `tokens` names it, with `/` for each `-`: `bg-primary` is `primary` for the fill, `text-primary-foreground` is `primary/foreground` for the text, `border-input` is `input` for the stroke, and `rounded-lg` is the radius `lg`. The source picks only among the variables of the measured value; the value is still snap's. A class with an opacity modifier, such as `bg-destructive/10` or `border-destructive/30`, names its variable at an opacity: snap measures it translucent, `#df22254d` say, which matches `destructive`'s `#df2225`, so bind it to `destructive` with the paint's opacity at its alpha, through the build template's `setPaints`, which keeps that opacity where assigning the bound paint would reset it to 1. A shadow's color has no opacity of its own, so `setPaints` binds it only to a variable of its alpha. If you can't read the source, or it names no variable of that value (an arbitrary value like `bg-[#171717]`, or a class set elsewhere), leave the value unbound and list it in the summary, with the variables it matches, rather than pick one. A project that uses Tailwind's default spacing, type or shadow scales has no tokens for them, so those values stay as measured.

This ensures that when tokens change in code and storysync runs again, updating the variables automatically updates all components.

## Audit

Compare the current Figma file against code to find drift in either direction. Use this when someone asks to "check if Figma is in sync", "audit the design system", or "diff Figma vs code".

If the `use_figma` tool doesn't return the plugin code's return value in a usable form, fall back to the read-only tools the Figma MCP server gives you, knowing what each covers: `get_metadata` outlines one node's layers (with no node, it lists the pages), and `get_variable_defs` returns only the variables and styles the selected node uses (on the remote server, the node a Figma link points at), so a variable no layer uses never appears. For a complete list, ask the user to export Figma's variables and components to JSON and diff against that.

`use_figma` takes at most 50,000 characters of code and returns at most 20kb per call. The code below is small, but a full palette or library passes 20kb on the way back, so both reads return a slice per call. Call each with `START = 0`, then again from the `next` it returns until `next` is `null`, and combine the slices. The variables read throws if a slice comes too close to 20kb; lower `BATCH` and read that slice again. The components read takes as many as fit under that limit in each call.

1. **Read Figma variables** — call `use_figma` to enumerate all variable collections and their resolved values. It reads each collection's first mode, and the first call returns every collection's `modes`, for step 7 to name the others as not compared:

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
      const mode = coll.modes[0];
      const raw = v.valuesByMode[mode.modeId];
      let value = '';
      if (v.resolvedType === 'COLOR' && raw && typeof raw === 'object' && 'r' in raw) {
        // #rrggbb, then the alpha as two more digits when it comes to less
        // than ff, as tokens writes a translucent color's hex.
        const channels = [raw.r, raw.g, raw.b].map(x => Math.round(x * 255));
        const a = Math.round((raw.a == null ? 1 : raw.a) * 255);
        if (a < 255) channels.push(a);
        value = '#' + channels.map(x => x.toString(16).padStart(2, '0')).join('');
      } else {
        value = String(raw);
      }
      results.push({ name: v.name, type: v.resolvedType, value, collection: coll.name });
    }
    const next = START + BATCH < all.length ? START + BATCH : null;
    // Each collection's modes, on the first slice: only the first is read
    // above, so the summary names the rest as not compared.
    const modes = START === 0 ? collections.map((coll) => ({ collection: coll.name, modes: coll.modes.map((m) => m.name) })) : undefined;
    const result = JSON.stringify({ total: all.length, next, modes, variables: results });
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

4. **Map code components** — run storysync to get the code-side component mappings:

```bash
npx storysync map --storybook http://localhost:6006 --json
```

   Pass the `--exclude-props` the push used, if any, or every prop it left out is reported missing from Figma. snap records them as `excludeProps` at the top of `.storysync/snaps/styles.json`, and the push's summary names them. If neither has them, as in a fresh clone, and props come back missing from Figma on components the push made (those with a `storybookId`), ask the user whether the push left those props out before you report them.

   If the user asked about some components only, first run `npx storysync list --storybook http://localhost:6006 --json`: it lists every component's `id`, `name`, `title` and `category` in one call, for step 6 to pair with. Then pass map, with `--components`, only the names in the scope that list has, by `id`, `title`, `name` or the last segment of `title`, ignoring case, rather than map every component, which can take many minutes. map refuses a name Storybook doesn't have, and a name only Figma has is for step 6. If list has none of them, skip map.

5. **Compare tokens** — match Figma variable collections to code token categories (Colors → colors, Spacing → spacing, etc.). For each token:
   - In code but not in Figma → **missing from Figma** (needs sync)
   - In Figma but not in code → **missing from code** (orphaned or manually added)
   - Both exist but values differ → **value mismatch** (show code value vs Figma value)
   - Normalize before comparing: compare a color by its token's `hex` and a spacing, radius or size token by its `px`, which has rem and `calc()` worked out, where the token has one; otherwise lowercase hex colors, convert rem→px (1rem=16px), and strip units for numeric comparison. A translucent color is `#rrggbbaa` on both sides, step 1's template writing Figma's alpha as tokens does, so compare all eight digits. Round numbers to thousandths on both sides, since Figma can return a float with a tail of binary noise.
   - Note what can't be compared, for step 7 to name: every mode of a Figma collection but its first, from the `modes` step 1 returns; the dark theme, which `tokens` doesn't read, where a `tokens` warning starts `Only the light theme is read`; the tokens a `tokens` warning says it didn't read (`Unresolved:`, `Not read from @theme`, `Uncategorized:`); and the categories `tokens` has no collection for in a project on Tailwind, whose components use Tailwind's default spacing, type or shadow scale, which `tokens` doesn't extract.

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
   - Beside the token counts, say what they cover and what they don't, from step 5's notes, so `39 matched` isn't read as every token in both themes: `39 matched (colors and radius, light mode only; not compared: the Dark mode of Colors and the code's .dark theme, font/sans and font/mono, which tokens couldn't resolve, and Tailwind's default spacing, type and shadow scales, which have no tokens)`.
   - Confirm "Figma and code are in sync." only if everything matches and no name is ambiguous or set errored; components outside any set not from the push don't count against it. An ambiguous name was compared on none of its copies, and an errored set on nothing, so either can hide drift: while any is, name them instead, and never say the two are in sync. Say with it what the audit compares: tokens, in the modes it noted, and each component's variant properties, not the styles the push's `verify` scores.

## Visual accuracy guidelines

- **Measured values from `snap` are ground truth.** They come from a real browser rendering the real component. Where they disagree with your reading of the source, the measurement is right — computed style accounts for the cascade, inherited values, and anything a class name does not reveal.
- **Never invent a value that could be measured.** Guessing that "a primary button is typically blue" produces a library that looks plausible and is wrong, which is worse than one that is visibly incomplete. If a variant could not be measured, derive it from source and record it as `inferred`.
- The goal is a Figma library a designer can use directly, not variant scaffolding.
- Prefer auto-layout so components resize properly. The measured `display`, `flexDirection`, `padding`, and `gap` map onto it directly.
- Add a text layer carrying the text the story actually renders — the story's args if they set the content, otherwise the component's default children (e.g. `children = "Button"`). Read it from source if you need to: the rule against reading source is about styles, not labels. Inline components are scored on width, so a different label reads as drift. Style it from the measured `text` values where present.
