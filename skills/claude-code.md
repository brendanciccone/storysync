# storysync — Storybook to Figma

Read components from Storybook MCP and recreate them in Figma MCP as a visually accurate component library, with design token foundations.

## Requirements

- Storybook dev server running with `@storybook/addon-mcp` (Vite-based Storybook 10.1+, Node 18+)
- Storybook MCP: `claude mcp add --transport http storybook http://localhost:6006/mcp`
- Figma MCP: `claude plugin install figma@claude-plugins-official` (or `claude mcp add --transport http figma https://mcp.figma.com/mcp`)
- Figma Full seat (Dev seats are read-only)
- storysync installed: `npm install -g storysync` or `npx storysync`

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

The `category` field reflects the component's place in Storybook's sidebar (the part of `Forms/Button` before the last `/`). Use it to organize the Figma file — see "Organization" below.

2. **Inspect individual components** — for detailed prop-to-variant mapping of a specific component:

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

3. **REQUIRED — Measure the styling. Do not infer it.** Do not proceed to step 5 without concrete values. A `use_figma` call containing only variant names produces a useless component library.

```bash
npx storysync snap --storybook http://localhost:6006 --json
```

   This renders every variant in a real browser and reports what the browser actually computed, so the values are measured rather than guessed. Run it *now*, in this session — do not reuse a `styles.json` from an earlier run, which may describe code that has since changed.

   The output gives, per component, full styles for a base variant plus only the properties each other variant changes:

```json
{
  "components": [{
    "title": "Forms/Button",
    "base": {
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
      { "slug": "variant-danger--size-sm--disabled-false", "status": "ok",
        "delta": { "backgroundColor": "#dc2626" } }
    ]
  }]
}
```

   A variant's full styles are the base with its `delta` applied. Translate directly:

   | Measured | Figma |
   |---|---|
   | `backgroundColor` | fill (`null` means no fill, not black) |
   | `color` / `text.color` | text fill |
   | `padding` | auto-layout padding |
   | `gap.column` | `itemSpacing` |
   | `borderRadiusUniform`, else `borderRadius` | `cornerRadius`, else per-corner |
   | `borderUniform` | stroke weight + colour (`null` means no stroke) |
   | `boxShadow[]` | `DROP_SHADOW` effects |
   | `display: flex` + `flexDirection` | auto-layout direction |
   | `fontSize` / `fontWeight` / `fontFamily` | text style |
   | `boxSizing` | `strokeAlign`: `content-box` → `OUTSIDE`, `border-box` → `INSIDE` |

   Three mappings that are wrong by default and will not show up as drift unless you get them right:

   - **`strokeAlign` follows `boxSizing`.** Figma defaults strokes to `INSIDE`, which eats padding. A CSS border on a `content-box` element grows the box outward, so those need `strokeAlign = 'OUTSIDE'`. Only `border-box` elements match Figma's default.
   - **Lay the variants out.** A component set is a frame containing its variants, each needing its own x/y, and the frame must be grown to fit them. Created without positions they all land at `0,0`, stacked and clipped by a frame still sized for one. Position each variant (a simple grid or row with spacing) and size the set to contain them.
   - **Assert the layout before returning.** After positioning, check that no two variants' bounding boxes intersect and that the set's bounds contain every child. Geometry comparison catches variants clipped by an undersized frame, but two same-sized variants stacked inside an adequately sized one measure correctly and stay invisible — so the check has to happen here, at write time.
   - **`fontAvailable: false` means the measurement describes a substituted typeface.** `fontFamily` is the family the code *asked for*; if the browser could not load it, the geometry and text you measured are not the intended font's. Say so in the summary. If Figma also lacks the font, name it explicitly — "Figma has no *Inter*; install it or map it" — rather than letting it surface as unexplained text drift. storysync cannot install fonts into Figma; that is a manual step in the desktop app.

   **Variants where `status` is not `"ok"` were not measured.** Only for those, fall back to reading the component's source (`.tsx`/`.jsx`, CSS modules, styled-components, inline styles, `cva`/`clsx`/`cn` calls) and resolve any design tokens through `npx storysync tokens --json` or the project's own config — never from a memorised class-to-value table, which is wrong for any project with a custom palette.

   **Every fallback must be recorded, not just mentioned.** In step 6 you will write a `source` of `"measured"` or `"inferred"` for each variant. A run inspected later must be able to tell the difference without reading this conversation.

   **Checkpoint before step 5**: every variant has either measured styles or an explicit source-derived spec. If all of a component's variants measured identically, `snap` will have warned that the story is not passing its args through — say so in the summary rather than treating the values as real.
4. **Organize the Figma file by Storybook hierarchy.** Group all unique top-level categories from the `category` field of each component, then create one Figma page per top-level category (e.g. `Forms`, `Data Display`, `Navigation`). Components without a category go on a `Components` page. Place each component set on the page that matches its top-level category. This mirrors the Storybook sidebar so designers can find things where they expect them. If multiple components share the same leaf name (e.g. two `Button`s under different categories), the per-page organization keeps them distinct.

5. Write to Figma with `use_figma`. The instruction MUST embed the measured values from step 3 — every variant needs a concrete fill, text colour, padding, radius, border, font size, and shadow. A call that only references variant names is a bug; refuse it and re-read the snap output.

   **Update in place rather than duplicating.** Before creating a component set, look for one with the same name on the target page and update it if found. Running a push twice must not produce two `Button`s. The same applies to variable collections — reuse a collection of the same name instead of creating a second.

   **Return the node's real properties.** The plugin code must end by reading back what was actually created and returning it as JSON, so step 6 can score it. Read them off the created nodes rather than echoing the values you sent — echoing proves nothing.

```js
use_figma({
  code: `
    // Component: Button (title: Forms/Button, category: Forms)
    //
    // Find or create the 'Forms' page; place the component set there.
    let page = figma.root.children.find(p => p.name === 'Forms');
    if (!page) {
      page = figma.createPage();
      page.name = 'Forms';
    }
    figma.currentPage = page;
    //
    // Variant properties (from storysync map output):
    //   - variant (VARIANT): [default, destructive, outline]
    //   - size (VARIANT): [sm, md, lg]
    //   - disabled (BOOLEAN): [true, false]
    //
    // Visual spec (from source code analysis):
    //   All variants: rounded corners (6px radius), horizontal auto-layout, centered text
    //   variant=default: background #1EA7FD, white text, no border
    //   variant=destructive: background #EF4444, white text
    //   variant=outline: transparent background, #333 text, 1px solid #ccc border
    //   size=sm: 12px font, 8px/4px padding
    //   size=md: 14px font, 16px/8px padding
    //   size=lg: 16px font, 24px/12px padding

    // ... Figma Plugin API code to create or update the component set

    // Read back what was actually created, keyed by the snap variant slug.
    const readback = {};
    for (const child of componentSet.children) {
      const fill = child.fills && child.fills[0];
      const stroke = child.strokes && child.strokes[0];
      const toHex = (c) => '#' + [c.r, c.g, c.b]
        .map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
      const text = child.findOne(n => n.type === 'TEXT');
      readback[slugFor(child)] = {
        source: 'measured',            // or 'inferred' — see below
        backgroundColor: fill && fill.type === 'SOLID' ? toHex(fill.color) : null,
        color: text && text.fills[0] ? toHex(text.fills[0].color) : null,
        borderRadiusUniform: typeof child.cornerRadius === 'number' ? child.cornerRadius : null,
        padding: { top: child.paddingTop, right: child.paddingRight,
                   bottom: child.paddingBottom, left: child.paddingLeft },
        borderUniform: stroke ? { width: child.strokeWeight, style: 'solid', color: toHex(stroke.color) } : null,
        fontSize: text ? text.fontSize : undefined,
        fontWeight: text ? text.fontName.style === 'Bold' ? 700 : 400 : undefined,
        gap: { row: child.itemSpacing, column: child.itemSpacing },
        opacity: child.opacity,
        // Render bounds, not node.width — that excludes an OUTSIDE stroke and
        // would under-report by the border width on every outlined variant.
        width: (child.absoluteRenderBounds || child).width,
        height: (child.absoluteRenderBounds || child).height,
      };
    }
    return JSON.stringify({ id: componentSet.id, name: componentSet.name, readback });
  `,
  description: "Create or update the Button component set on 'Forms' page, styled from measured values",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

6. **Score the result.** Merge each component's returned `readback` into `.storysync/figma-readback.json`, keyed by the component title and the snap variant slug:

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
          "backgroundColor": "#2563eb",
          "padding": { "top": 4, "right": 8, "bottom": 4, "left": 8 },
          "borderRadiusUniform": 3, "fontSize": 12
        }
      }
    }
  }
}
```

   **`source` is required on every variant** — `"measured"` when the values came from `snap`, `"inferred"` when you fell back to reading source in step 3. Omitting it is not neutral: `verify` reports it as `unrecorded` and `--strict-measured` fails on it, because a run that cannot distinguish measured from guessed is decorative.

   Then:

```bash
npx storysync verify --strict-age
```

   This reports a fidelity score — the share of properties Figma agrees with — plus anything that drifted, any variant Figma never received, the provenance breakdown, and the age of the measurement.

   Fix what it flags with a follow-up `use_figma` targeting the node by ID, then re-run `verify`. **Stop after two fix rounds** and report the residual score. `use_figma` calls are rate-limited and becoming a paid feature; an unbounded repair loop burns that budget for diminishing returns.

7. Summarize what was synced: token collections created, components grouped by page, variant counts, **the fidelity score**, how many variants were measured versus inferred, any components whose stories did not pass their args through, and any failures or caps.

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

If the `use_figma` tool doesn't return the plugin code's return value in a usable form, fall back to reading Figma state via any available `get-*` / `list-*` tools on the Figma MCP server (call `tools/list` first to see what's available), or ask the user to export Figma variables/components to JSON and diff against that.

1. **Read Figma variables** — call `use_figma` to enumerate all variable collections and their resolved values:

```js
use_figma({
  code: `
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const results = [];
    for (const coll of collections) {
      for (const varId of coll.variableIds) {
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
    }
    return JSON.stringify(results);
  `,
  description: "Read all variable collections and values from Figma file",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

2. **Read Figma components** — call `use_figma` to enumerate all component sets and their variant properties:

```js
use_figma({
  code: `
    const componentSets = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] });
    const results = [];
    for (const cs of componentSets) {
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
    return JSON.stringify(results);
  `,
  description: "Read all component sets and variant properties from Figma file",
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

6. **Compare components** — match by name (case-insensitive). For each component:
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
- Add text layers with a representative label, styled from the measured `text` values where present.
