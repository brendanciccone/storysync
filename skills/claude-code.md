# storysync — Storybook to Figma

Read components from Storybook MCP and recreate them in Figma MCP as a visually accurate component library, with design token foundations.

## Requirements

- Storybook dev server running with `@storybook/addon-mcp` (Vite-based Storybook 10.1+, Node 18+; `snap` needs Node 20+)
- Storybook MCP: `claude mcp add --transport http storybook http://localhost:6006/mcp`
- Figma MCP: `claude plugin install figma@claude-plugins-official` (or `claude mcp add --transport http figma https://mcp.figma.com/mcp`)
- Figma Full seat (Dev seats are read-only)
- storysync 0.3.0 or later, run as `npx storysync` — 0.2.0 and earlier have no `snap` or `verify`

## Tokens

Before syncing components, extract design tokens from the project and create Figma variable collections. This ensures components can bind to variables instead of hardcoded values.

1. **Extract tokens** — run storysync to detect and extract tokens from the project:

```bash
npx storysync tokens --json --project .
```

This auto-detects the token source (Tailwind config, CSS custom properties, or theme files) and outputs structured JSON:

```json
{
  "source": "tailwind",
  "sourcePath": "tailwind.config.ts",
  "collections": [
    {
      "category": "colors",
      "tokens": [{ "name": "primary/500", "value": "#3B82F6" }, ...]
    },
    {
      "category": "spacing",
      "tokens": [{ "name": "4", "value": "1rem" }, ...]
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

    // Add variables
    const primary500 = figma.variables.createVariable('primary/500', colors, 'COLOR');
    primary500.setValueForMode(mode.modeId, figma.util.rgb('#3B82F6'));

    // ... repeat for each color token from the storysync output

    // Create Spacing collection
    const spacing = figma.variables.createVariableCollection('Spacing');
    const spMode = spacing.modes[0];
    const sp4 = figma.variables.createVariable('4', spacing, 'FLOAT');
    sp4.setValueForMode(spMode.modeId, 16); // 1rem = 16px

    // ... repeat for each spacing token
  `,
  description: "Create variable collections: Colors (N variables), Spacing (N variables), Radius (N variables), Typography (N variables), Shadows (N variables)",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

   Convert rem values to px (1rem = 16px) for Figma FLOAT variables. Use Figma `COLOR` type for colors and `FLOAT` type for spacing, radius, and font sizes.

   A `use_figma` call takes at most 50,000 characters of code, and one that runs too long fails with `Script exceeded time limit`; creating variables is slow. Split a large collection — a full colour palette runs to hundreds — across calls of a few dozen variables each, finding the collection the first call created rather than creating another.

4. **Verify** — confirm the variable collections were created with the expected count. If any are missing, retry.

## Components

1. **List and map components** — run storysync to read Storybook components and compute variant mappings:

```bash
npx storysync map --storybook http://localhost:6006 --json
```

This outputs:

```json
{
  "components": [
    {
      "name": "Button",
      "title": "Forms/Button",
      "category": "Forms",
      "variantProperties": [
        { "name": "variant", "type": "VARIANT", "values": ["default", "destructive", "outline"], "defaultValue": "default" },
        { "name": "size", "type": "VARIANT", "values": ["sm", "md", "lg"], "defaultValue": "md" },
        { "name": "disabled", "type": "BOOLEAN", "values": ["true", "false"], "defaultValue": "false" }
      ],
      "combinations": 18,
      "capped": false
    }
  ],
  "summary": { "total": 5, "mapped": 5, "failed": 0, "capped": 0, "totalCombinations": 42 }
}
```

The `category` field reflects the component's place in Storybook's sidebar (the part of `Forms/Button` before the last `/`). Use it to organize the Figma file — see step 4 below.

2. **Inspect individual components** — for detailed prop-to-variant mapping of a specific component:

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

3. **REQUIRED — Measure the styling. Do not infer it.** Do not proceed to step 5 without concrete values. A `use_figma` call containing only variant names produces a useless component library.

```bash
npx storysync snap --storybook http://localhost:6006 --variants all --json
```

   This renders each variant in a real browser and reports what the browser actually computed, so the values are measured rather than guessed. This measures **every combination** of the component's variant props, so every Figma variant you build is measured rather than guessed. **Build one Figma variant per snap variant, whatever its status** — a Figma component set needs every combination to exist, or the variant picker has nothing to switch to. **If a component carries a `cap` field** (its combinations exceed the limit, 256 by default), snap measured only a subset and warned about it; the cap's `uncovered` list names any values that subset left out entirely. **Stop and ask the user before building that component.** Tell them its total and the limit, and offer: build the measured subset; re-run snap with `--max-combinations <total>` to measure all of them (very large component sets get slow in Figma); or narrow which props are variants. Do not offer to fill the unmeasured combinations in from source: they can be measured by raising the limit, and a value the tool can read must never be guessed. Do not choose for them. Run it *now*, in this session — do not reuse a `styles.json` from an earlier run, which may describe code that has since changed.

   The output gives, per component, full styles for a base variant plus only the properties each other variant changes:

```json
{
  "components": [{
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
   | `color` / `text.color` | text fill |
   | `padding` | auto-layout padding |
   | `gap.column` | `itemSpacing` |
   | `borderRadiusUniform`, else `borderRadius` | `cornerRadius`, else per-corner |
   | `borderUniform` | stroke weight + colour (`null` means no stroke; a `color` of `null` is a transparent border, a stroke with an invisible paint: see below) |
   | a colour written `#rrggbbaa` | a translucent colour: `#rrggbb` with the paint's `opacity` at `aa` / 255, so `#4b556322` is `#4b5563` at an opacity of 34 / 255, about 0.133; for a shadow, the effect colour's `a` |
   | `boxShadow[]` | `DROP_SHADOW` effects |
   | `display: flex` + `flexDirection` | auto-layout direction |
   | `fontSize` / `fontWeight` / `fontFamily` | text style |
   | `borderUniform` on a hugging frame | `strokeAlign = 'OUTSIDE'` (see below) |

   Five things that go wrong by default, in ways `verify` either will not catch or will not explain:

   - **Stroke alignment: `OUTSIDE` on a hugging frame.** snap's `width`/`height` are the element's outer size, border included, and the Figma frame's outer size, its own size plus the stroke outside it, must match them. On an element sized by its content — every inline or inline-flex component, and any auto-layout frame you let hug — a CSS border always adds to the outer size, whatever `boxSizing` says; `box-sizing` only changes how an *explicit* width or height is read. So a hugging frame needs `strokeAlign = 'OUTSIDE'`. Figma's default, `INSIDE`, eats into the padding and leaves the variant short by twice the border width. Use `INSIDE` only when you give the frame a fixed size, and then set that size to the measured `width`/`height`. **A transparent border still takes its space.** A `borderUniform` whose `color` is `null`, such as CSS `border: 1px solid transparent`, is in snap's `width`/`height` like any other, so give it a stroke of that weight, aligned the same way, with a paint that draws nothing (`{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0 }`), never no stroke: without one the variant is short by twice the border. Step 6 reads the size from the geometry, which counts a stroke whether its paint shows or not, and reads that stroke's colour back as `null`, as snap measured it. In the browser the background runs under a transparent border, where Figma's fill stops at the stroke, so that ring shows no fill; painting the stroke to fill it would be scored as a border colour the code does not have.
   - **Lay the variants out.** A component set is a frame containing its variants, each needing its own x/y, and the frame must be grown to fit them. Created without positions they all land at `0,0`, stacked and clipped by a frame still sized for one. Position each variant in a grid — one row per value of the first variant property, the remaining combinations across — with spacing, and size the set to contain them. With every combination built, a single row of dozens of variants is unreadable. **Order the grid by snap's `variantProperties`, never by the set's children**: their order is whatever an earlier push or a designer left, and a set laid out in it gets rows whose columns disagree. Take the properties, and each one's values, in the order snap records them, which is the order of the component's prop type as Storybook's docs list it (a story's `argTypes` options are not read), not default first; a `BOOLEAN`'s `false` comes before its `true`. Each column is then one combination of the other properties in every row, and the layers panel lists the variants in the same order. Figma makes the top-left variant the set's default variant, so that is the variant of each property's first declared value. Step 5's build template does all of this; give it the properties and leave its layout as it is.
   - **Assert the layout before returning.** After positioning, check that no two variants' bounding boxes intersect and that the set's bounds contain every child. Geometry comparison catches variants clipped by an undersized frame, but two same-sized variants stacked inside an adequately sized one measure correctly and stay invisible — so the check has to happen here, at write time.
   - **Figma's plugin context has only Google Fonts.** `listAvailableFontsAsync` returns Google families and nothing else — no Arial, no Helvetica, no Times. A designer sees those in the desktop app's picker because it reads their *local* system fonts, but the environment `use_figma` runs in does not have them. If the measured `fontFamily` is not a Google font, say so and name the substitute you used rather than letting Figma pick one silently: the substitution usually cascades, since e.g. Arimo (Figma's suggestion for Arial) has no SemiBold, so a 600 weight lands as 700 and drifts twice.
   - **`fontAvailable: false` means the measurement describes a substituted typeface.** `fontFamily` is the family the code *asked for*; if the browser could not load it, the geometry and text you measured are not the intended font's. Say so in the summary. If Figma also lacks the font, name it explicitly — "Figma has no *Inter*; install it or map it" — rather than letting it surface as unexplained text drift. storysync cannot install fonts into Figma; that is a manual step in the desktop app.

   **Variants where `status` is not `"ok"` were not measured.** Only for those, fall back to reading the component's source (`.tsx`/`.jsx`, CSS modules, styled-components, inline styles, `cva`/`clsx`/`cn` calls) and resolve any design tokens through `npx storysync tokens --json` or the project's own config — never from a memorised class-to-value table, which is wrong for any project with a custom palette.

   **Every fallback must be recorded, not just mentioned.** In step 6 you will write a `source` of `"measured"` or `"inferred"` for each variant. A run inspected later must be able to tell the difference without reading this conversation.

   **Checkpoint before step 5**: every variant has either measured styles or an explicit source-derived spec. If all of a component's variants measured identically, `snap` will have warned that the story is not passing its args through — still write the measured values and label them `measured` — they are what the story actually renders — and say so in the summary. Do not substitute values from source: the fix belongs in the story, and a variant styled from source would be scored against a measurement it does not match.
4. **Organize the Figma file by Storybook hierarchy.** Group all unique top-level categories from the `category` field of each component, then create one Figma page per top-level category (e.g. `Forms`, `Data Display`, `Navigation`). Components without a category go on a `Components` page. Place each component set on the page that matches its top-level category. This mirrors the Storybook sidebar so designers can find things where they expect them. If multiple components share the same leaf name (e.g. two `Button`s under different categories), the per-page organization keeps them distinct.

5. Write to Figma with `use_figma`. The instruction MUST embed the measured values from step 3 — every variant needs a concrete fill, text colour, padding, radius, border, font size, and shadow. A call that only references variant names is a bug; refuse it and re-read the snap output.

   **Update in place rather than duplicating.** Before creating a component set, look for one with the same name anywhere on the target page, inside a section or frame a designer moved it into too, and update it if found. Running a push twice must not produce two `Button`s. The same applies to variable collections — reuse a collection of the same name instead of creating a second.

   **Return the set's id.** End the plugin code by returning the component set's id — step 6 reads the variants back from it, and fixes target it. Leave the readback itself to step 6: `use_figma` returns at most 20kb per call, and a whole set's readback passes that at a few dozen variants.

   **Build a set in parts of at most 25 variants.** `use_figma` takes at most 50,000 characters of code per call, and a variant's measured values run to a few hundred characters, so a large set's code does not fit in one call; a call that runs too long also fails, with `Script exceeded time limit`. Write the values as a table, one entry per variant, and create the variants in a loop over it rather than writing out each one's code. Build a set of more than 25 variants across calls, in snap's variant order: the first finds the set by name anywhere on its page, or creates it, with the first 25; each later call finds it by id and does the same with the next 25; and every part lays out and checks the whole set as it then stands, so the last leaves it laid out in full. If a call fails with `Script exceeded time limit`, check what it left on the canvas before retrying, and build in smaller parts.

   **A part updates the variants it names and adds only the ones the set lacks.** On a set an earlier push built, or one a failed call left half done, each part finds each of its variants among the set's children by name, restyles it if it is there and creates it if it is not. It never creates a second variant of a name the set already has: it refuses, before changing anything, a part that names a variant twice, and a part whose set already holds two of a name it carries — with the error step 6's readback gives for that, and the same remedy. So a part can be retried, and a push repeated, without duplicating anything; and every part lays the whole set out again and checks it, so a part re-run on its own leaves the set laid out. A variant in Figma that snap no longer has — one for a value the code has since dropped — is named by no part, so the build leaves it alone, laid out in a row of its own below the others: step 6 finds it, and you report it. Delete it only if the user asks; a designer may have built on it.

   **Every part lays the whole set out in snap's order, and checks it.** Give each part the component's `variantProperties` from snap's output as `PROPERTIES`, copied as they are: the same table on every part, a few hundred characters even for 256 variants. Leave the template's layout as it is. It orders the set by `PROPERTIES`, never by the set's children, whose order is whatever an earlier push or a designer left:

   - Each property's values run in the order snap records them, which is the order of the component's prop type as Storybook's docs list it (a story's `argTypes` options are not read), not default first. A `BOOLEAN` property runs `false, true`, though snap lists its values `true, false`.
   - **Figma makes the top-left variant the set's default variant**, so the default is the variant of each property's first declared value, `false` for a `BOOLEAN`: `size=sm` even if the component defaults to `md`. When that differs from the component's defaults, snap's `defaultValue`s, say in the summary which variant Figma will treat as the default.
   - The first property's values are the rows, top to bottom; the combinations of the other properties, in their order with the last varying fastest, are the columns, left to right. With one property, each value is a row of one. Each variant's cell comes from its own name, so a combination the set lacks leaves a gap and the columns still line up, a row or column no variant fills at all is left out, and the work grows with the set's variants, not with every combination `PROPERTIES` allows. Each column is as wide as its widest variant and each row as tall as its tallest, 20 apart. The Button in step 3's snap output — `variant` primary, danger, outline; `size` sm, lg; `disabled` — is three rows, primary, danger and outline, of four columns: sm, sm disabled, lg, lg disabled.
   - A variant whose name is no combination of `PROPERTIES`, one snap does not have, goes in a row of its own below the others, in name order, and is counted in the `extra` the part returns; so does a second variant of a name. Of two variants of a name, the one whose node id sorts first as text stays in the grid, so every part keeps the same one there.
   - **It refuses a set with auto layout.** On a set whose `layoutMode` is not `'NONE'`, auto layout positions the variants itself: setting their x and y does nothing, and the layout's layer order would flow the last variant into the top-left, Figma's default. So the part throws `The set "…" has auto layout …` before changing anything. Ask the user whether to turn auto layout off on the set (`componentSet.layoutMode = 'NONE'`, in a call of its own) and re-run the part, or to leave its layout alone and skip the set, saying in the summary that it was not pushed. Do neither on your own.
   - Figma's layers panel shows a set's last child at the top, so the layout puts the variants last to first, moving only the ones out of place: the panel then reads top-down in the grid's order, row by row, with that extra row last.
   - It grows the set to fit, then checks that the layers are in that order, that every variant is where the layout put it, so a move Figma ignored fails, that no two variants' boxes intersect, and that the set contains every one, and throws if not. It returns counts, not names: the set's `rows`, `columns` and `extra`.

```js
use_figma({
  code: `
    // Component: Button (title: Forms/Button, category: Forms)
    const PAGE_NAME = 'Forms';
    const SET_NAME = 'Button';
    // null on the first part; the id the first part returned on every later one.
    const SET_ID = null;
    const PART = 25;
    //
    // Find or create the 'Forms' page; place the component set there.
    let page = figma.root.children.find(p => p.name === PAGE_NAME);
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
      { name: 'size', type: 'VARIANT', values: ['sm', 'md', 'lg'], defaultValue: 'md' },
      { name: 'disabled', type: 'BOOLEAN', values: ['true', 'false'], defaultValue: 'false' },
    ];
    //
    // Visual spec (from step 3's snap output — each variant's base styles with its delta applied):
    //   All variants: rounded corners (6px radius), horizontal auto-layout, centered text
    //   variant=default: background #1EA7FD, white text, no border
    //   variant=destructive: background #EF4444, white text
    //   variant=outline: transparent background, #333 text, 1px solid #ccc border
    //   size=sm: 12px font, 8px/4px padding
    //   size=md: 14px font, 16px/8px padding
    //   size=lg: 16px font, 24px/12px padding

    // This part's variants and their measured values: at most PART, since
    // use_figma takes at most 50,000 characters of code per call, in snap's
    // variant order. Name every variant from its snap combination: each key is
    // a variant property, BOOLEAN ones included, written key=value and joined
    // with ", " in the combination's key order. styles is the variant's full
    // measured styles, the base with its delta applied.
    const VARIANTS = [
      { name: 'variant=default, size=sm, disabled=false', styles: { backgroundColor: '#1ea7fd', color: '#ffffff', padding: { top: 4, right: 8, bottom: 4, left: 8 }, borderRadiusUniform: 6, fontSize: 12, fontWeight: 600 } },
      // ... one entry per variant in this part
    ];

    // Style one variant from its measured values: fill, text, padding, radius,
    // border, font and shadow, as step 3's table maps them. It runs on the
    // variants this part creates and on ones an earlier push made, so set
    // every property, not only those a new node lacks, and reuse the children
    // an earlier push made rather than adding another: the label is
    // variant.findOne((n) => n.type === 'TEXT'), created only if that is null.
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
    // The set: by id after the first part; on the first, the one an earlier
    // push left anywhere on this page, if there is one, at its top level or
    // in a section or frame a designer moved it into.
    let componentSet = null;
    if (SET_ID) {
      componentSet = await figma.getNodeByIdAsync(SET_ID);
      if (!componentSet || componentSet.type !== 'COMPONENT_SET') {
        throw new Error('No component set with id ' + SET_ID);
      }
    } else {
      const sets = page.findAllWithCriteria({ types: ['COMPONENT_SET'] }).filter((n) => n.name === SET_NAME);
      if (sets.length > 1) {
        throw new Error('The page has ' + sets.length + ' component sets named "' + SET_NAME + '" (' + sets.map((n) => n.id).join(', ') + '): ask the user which to update');
      }
      componentSet = sets[0] || null;
    }
    // Auto layout would place the variants itself: refuse it, changing nothing.
    if (componentSet && componentSet.layoutMode !== 'NONE') {
      throw new Error('The set "' + SET_NAME + '" has auto layout (' + componentSet.layoutMode + '), so x and y do nothing: ask the user whether to turn it off or skip the set');
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

    // Update the variants the set has; create only the ones it lacks.
    const created = [];
    for (const { name, styles } of VARIANTS) {
      let variant = existing.get(name);
      if (!variant) {
        variant = figma.createComponent();
        variant.name = name;
        created.push(variant);
      }
      await applyStyles(variant, styles);
    }
    if (!componentSet) {
      componentSet = figma.combineAsVariants(created, page);
      componentSet.name = SET_NAME;
    } else {
      for (const variant of created) componentSet.appendChild(variant);
    }

    // Lay the whole set out by PROPERTIES on every part, as described above,
    // never by child order: leave this as it is. Cells come from names, so the
    // work grows with the set, not with every combination PROPERTIES allows.
    const GAP = 20;
    const axes = PROPERTIES.map((p) => [p.name + '=', p.type === 'BOOLEAN' ? ['false', 'true'] : p.values]);
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

    // The set's id, for the next part and for step 6 to read the variants
    // back from. Not the readback itself: use_figma returns at most 20kb per
    // call. variants counts the whole set, added and updated this part; extra
    // counts the variants no combination names, in the row below the grid.
    return JSON.stringify({
      id: componentSet.id, name: componentSet.name, variants: kids.length,
      added: created.length, updated: names.length - created.length,
      rows: rows.length, columns: columns.length, extra: extra.length,
    });
  `,
  description: "Create or update variants 1-25 of the Button component set on 'Forms' page, styled from measured values",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

6. **Read the result back and score it.** Read each component set's variants back with `use_figma`, off the nodes themselves rather than from the values you sent — echoing proves nothing. `use_figma` takes at most 50,000 characters of code and returns at most 20kb per call: a set's readback passes 20kb at a few dozen variants, and the table of its names and slugs can pass 50,000 characters at under two hundred. So the template below reads a set a slice at a time, and each call names the variants it reads — at most `BATCH`, 20, in snap's variant order: the first 20, then the next 20, until you have read every variant snap measured. It reads exactly the variants you name, finding each by name, and throws if the set has no variant of a name you gave, or two. It also throws if a slice comes too close to 20kb. A call that throws returns nothing; below the template is what to do about each error. Each entry it returns carries `readAt`, the time Figma read it, and a `checksum` it computed in Figma over that entry, the set's id and the slug, so write the entries into the readback file exactly as returned: see below the templates.

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
      const slug = SLUG_BY_NAME[child.name];
      if (!slug) throw new Error('No snap slug recorded for Figma variant "' + child.name + '"');
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
    if (!componentSet || componentSet.type !== 'COMPONENT_SET') {
      throw new Error('No component set with id ' + SET_ID);
    }
    // Exactly the variants named above. One the set lacks, or holds twice,
    // fails here rather than leaving a gap or a guess in the readback.
    const children = names.map((name) => {
      const found = componentSet.children.filter((child) => child.name === name);
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
      // A paint's colour as snap writes one, since verify compares colours
      // as written: #rrggbb, then the alpha as two more hex digits, rounded
      // from alpha x 255, when they come to less than ff (a soft Chip's
      // background is #4b556322), and null when they come to 00, as snap
      // records a transparent border. Figma keeps a paint's alpha in its
      // opacity and an effect colour's in its a, so combine both; and a
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
      const text = child.findOne(n => n.type === 'TEXT');
      // A text node's fontSize is figma.mixed when its text mixes sizes, and
      // its fontName when it mixes fonts: those read as null, as they do
      // with no text child.
      const font = text && typeof text.fontName === 'object' ? text.fontName : null;
      // Figma names weights ("Semi Bold"), CSS numbers them (600). Mapping only
      // Bold would report every SemiBold/Medium/Light face as 400, and
      // fontWeight is compared exactly — so a correct push would drift on every
      // variant. Match on the normalised style name.
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
        // could not measure cannot be labelled measured by omission.
        source: SOURCE_BY_SLUG[slug] || 'inferred',
        backgroundColor: fill && fill.type === 'SOLID' ? hexOf(fill) : null,
        color: text && text.fills[0] ? hexOf(text.fills[0]) : null,
        borderRadiusUniform: typeof child.cornerRadius === 'number' ? child.cornerRadius : null,
        padding: { top: child.paddingTop, right: child.paddingRight,
                   bottom: child.paddingBottom, left: child.paddingLeft },
        // A stroke whose paint draws nothing is a transparent border: its
        // colour reads as null, and its weight still counts, as above.
        borderUniform: stroke ? { width: child.strokeWeight, style: 'solid', color: hexOf(stroke) } : null,
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
        // and null against a measured gap is drift.
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
    const total = componentSet.children.length;
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

   Write every slice's `readback` entries into `.storysync/figma-readback.json` exactly as the calls returned them, merging the slices: keyed by the component title and the snap variant slug, with the set's id, the `id` the calls returned, as `nodeId`, since each entry's checksum is sealed under it, so each component has the id of its own set. Copy each entry whole, its `readAt` and `checksum` included, with every value as it came back: numbers digit for digit (`0.4000000059604645`, not `0.4`), colours as written, a `null` as `null` (a variant with no text child, like the status dot below, returns `null` for the text's four fields, and one without auto layout for `gap`), and no field added that the entry lacks or dropped that it has. Never fill in or recompute a value, from snap, from what you sent in step 5 or from anywhere else, and never write an entry for a variant no call returned, nor one from an earlier run. If a response is too long to copy whole, read fewer variants per call, splitting the slice, rather than summarising it. The file's layout is yours, since indentation and key order do not change a checksum, but its values are not: `verify` recomputes each entry's checksum, and reports any entry whose checksum is missing or does not match, whose component has the `nodeId` of another, that lacks a field the template always returns, or whose `readAt` is before the snap, as an unverified readback, scores nothing in it, and fails `--strict`.

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

   This reports a fidelity score — the share of properties Figma agrees with — plus anything that drifted, any variant Figma never received, the provenance breakdown, and the age of the measurement.

   Fix what it flags with a follow-up `use_figma` targeting the node by ID, then read the set back again and re-run `verify`. Four things it flags are not fixed by editing a node: an `unscored` variant means your readback returned nothing comparable for it — re-read that node; an entry whose checksum is missing or does not match, or whose component has the `nodeId` of another, is not what the readback returned — read that slice, or both components' sets, again and write their entries exactly as returned, each component under its own set's id, never editing the file to make it pass; an `incomplete` entry was read with the template cut down, and a `stale` one before the snap — read that slice again, now, with the template as it is; and `! snap recorded a failure` means the measurement itself is incomplete, so re-run `snap` rather than changing Figma. Nor, as a rule, is a `width` a pixel or two off on a variant that hugs its text, with nothing else on it drifting: Figma lays text out with its own metrics, about a pixel apart from the browser's (a chip labelled "Chip" in bold 11px Inter measured 38.59 wide in Chrome and 40 in Figma), and verify's allowance is narrowest on small labels. Report it as a font-rendering difference rather than fixing the text's width to squeeze it, which can clip the label, but only when the variant's stroke is `OUTSIDE` or it has none, and the difference is not exactly twice the measured border's weight. Otherwise check its `strokeAlign` first: an `INSIDE` stroke on a hugging frame leaves the variant short by exactly twice the border, a `CENTER` one by the border, and a transparent border built with no stroke by twice the border too, and each is a build mistake to fix, not font rendering. **Stop after two fix rounds** and report the residual score. `use_figma` calls are rate-limited and becoming a paid feature; an unbounded repair loop burns that budget for diminishing returns.

7. Summarize what was synced: token collections created, components grouped by page, variant counts, **the fidelity score**, how many variants were measured versus inferred, any components whose stories did not pass their args through, which variant Figma will treat as a set's default where that is not the component's default (step 5), any set skipped for its auto layout, the variants with a transparent border, and any failures or caps. For each variant whose transparent border was built as an `OUTSIDE` stroke (a `CENTER` one leaves half the ring unfilled, an `INSIDE` one on a fixed-size frame none), say that Figma shows that transparent border as an unfilled ring: the browser draws the background under a transparent border, but Figma's fill stops where the `OUTSIDE` stroke begins, and that stroke's paint draws nothing. If the user would rather it look filled, they can choose a stroke tinted the background's colour instead, which `verify` will then score as a border colour the code does not have.

## Variable binding

When token variable collections exist, bind component properties to variables instead of hardcoding values:
- Fills → bind to the matching variable from the Colors collection (e.g. `primary/500`)
- Padding / spacing → bind to the Spacing collection
- Corner radius → bind to the Radius collection
- Font size → bind to the Typography collection
- Drop shadows → bind to the Shadows collection

This ensures that when tokens change in code and storysync runs again, updating the variables automatically updates all components.

## Audit

Compare the current Figma file against code to find drift in either direction. Use this when someone asks to "check if Figma is in sync", "audit the design system", or "diff Figma vs code".

If the `use_figma` tool doesn't return the plugin code's return value in a usable form, fall back to the read-only tools the Figma MCP server gives you, knowing what each covers: `get_metadata` outlines one node's layers (with no node, it lists the pages), and `get_variable_defs` returns only the variables and styles the selected node uses (on the remote server, the node a Figma link points at), so a variable no layer uses never appears. For a complete list, ask the user to export Figma's variables and components to JSON and diff against that.

`use_figma` takes at most 50,000 characters of code and returns at most 20kb per call. The code below is small, but a full palette or library passes 20kb on the way back, so both reads return a slice per call. Call each with `START = 0`, then again from the `next` it returns until `next` is `null`, and combine the slices. Each throws if a slice comes too close to 20kb; lower `BATCH` and read that slice again.

1. **Read Figma variables** — call `use_figma` to enumerate all variable collections and their resolved values:

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
        const r = Math.round(raw.r * 255);
        const g = Math.round(raw.g * 255);
        const b = Math.round(raw.b * 255);
        value = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      } else {
        value = String(raw);
      }
      results.push({ name: v.name, type: v.resolvedType, value, collection: coll.name });
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

2. **Read Figma components** — read the component sets and their variant properties a page at a time. `use_figma` loads pages as it switches to them, starting each call on the first, and does not support `figma.loadAllPagesAsync()`, so a search from `figma.root` sees only the pages already loaded and misses the sets on every other — and the push puts each category on its own page. List the pages with a call that returns `JSON.stringify(figma.root.children.map(p => ({ id: p.id, name: p.name })))`, then make the call below once per page, as separate calls issued together, each switching to its page once:

```js
use_figma({
  code: `
    const PAGE_ID = '0:1'; // one of the pages the first call listed
    const START = 0;
    const BATCH = 25;
    const page = await figma.getNodeByIdAsync(PAGE_ID);
    if (!page || page.type !== 'PAGE') {
      throw new Error('No page with id ' + PAGE_ID);
    }
    await figma.setCurrentPageAsync(page);
    const componentSets = page.findAllWithCriteria({ types: ['COMPONENT_SET'] });
    const results = [];
    for (const cs of componentSets.slice(START, START + BATCH)) {
      const defs = cs.componentPropertyDefinitions;
      const props = [];
      for (const [key, def] of Object.entries(defs)) {
        if (def.type === 'VARIANT') {
          props.push({ name: key, type: 'VARIANT', values: def.variantOptions || [] });
        } else if (def.type === 'BOOLEAN') {
          props.push({ name: key, type: 'BOOLEAN', values: ['true', 'false'] });
        }
      }
      results.push({ name: cs.name, variantProperties: props, variantCount: cs.children.length });
    }
    const next = START + BATCH < componentSets.length ? START + BATCH : null;
    const result = JSON.stringify({ page: page.name, total: componentSets.length, next, componentSets: results });
    // use_figma JSON-encodes what this returns: measure the encoded string.
    const size = JSON.stringify(result).length;
    if (size > 17000) {
      throw new Error('This slice is ' + size + ' characters encoded, too close to 20kb: lower BATCH and read it again');
    }
    return result;
  `,
  description: "Read the component sets and variant properties on one page of the Figma file",
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

5. **Compare tokens** — match Figma variable collections to code token categories (Colors → colors, Spacing → spacing, etc.). For each token:
   - In code but not in Figma → **missing from Figma** (needs sync)
   - In Figma but not in code → **missing from code** (orphaned or manually added)
   - Both exist but values differ → **value mismatch** (show code value vs Figma value)
   - Normalize before comparing: lowercase hex colors, convert rem→px (1rem=16px), strip units for numeric comparison.

6. **Compare components** — match by name (case-insensitive). If two code components share a name (e.g. `Forms/Button` and `Nav/Button`), or two Figma component sets do (on different pages: an archived copy, say, or each category's own `Button`), report the name as ambiguous, and only as ambiguous: compare none of its copies, and don't also count it as matched, mismatched or missing. For each component:
   - In code/Storybook but not in Figma → **code only** (not yet synced)
   - In Figma but not in code/Storybook → **Figma only** (orphaned or renamed)
   - Both exist → compare variant properties: missing props, extra props, missing/extra values per prop.

7. **Report** — present a structured drift report:
   - Group by category (tokens) or component name
   - Use clear labels: `+` missing from Figma, `-` missing from code, `~` value mismatch
   - End with a summary: N tokens matched, N mismatched, N missing. N components matched, N mismatched.
   - If everything matches, confirm "Figma and code are in sync."

## Visual accuracy guidelines

- **Measured values from `snap` are ground truth.** They come from a real browser rendering the real component. Where they disagree with your reading of the source, the measurement is right — computed style accounts for the cascade, inherited values, and anything a class name does not reveal.
- **Never invent a value that could be measured.** Guessing that "a primary button is typically blue" produces a library that looks plausible and is wrong, which is worse than one that is visibly incomplete. If a variant could not be measured, derive it from source and record it as `inferred`.
- The goal is a Figma library a designer can use directly, not variant scaffolding.
- Prefer auto-layout so components resize properly. The measured `display`, `flexDirection`, `padding`, and `gap` map onto it directly.
- Add a text layer carrying the text the story actually renders — the story's args if they set the content, otherwise the component's default children (e.g. `children = "Button"`). Read it from source if you need to: the rule against reading source is about styles, not labels. Inline components are scored on width, so a different label reads as drift. Style it from the measured `text` values where present.
