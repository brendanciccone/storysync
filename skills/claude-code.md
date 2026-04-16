# storysync — Storybook to Figma

Read components from Storybook MCP and recreate them in Figma MCP as a visually accurate component library, with design token foundations.

## Requirements

- Storybook dev server running with `@storybook/addon-mcp` (Vite-based Storybook 9+, Node 24+)
- Storybook MCP: `claude mcp add --transport http storybook http://localhost:6006/mcp`
- Figma MCP: `claude plugin install figma@claude-plugins-official` (or `claude mcp add --transport http figma https://mcp.figma.com/mcp`)
- Figma Full seat (Dev seats are read-only)

## Phase 0: Foundations

Before syncing components, extract design tokens from the project and create Figma variable collections. This ensures components can bind to variables instead of hardcoded values.

0.1. **Detect token source** — look for `tailwind.config.ts` / `tailwind.config.js` in the project root, CSS files with `:root` custom properties in `src/`, or theme/token export files (`tokens.ts`, `theme.ts`). If none found, skip to Phase 1.

0.2. **Extract tokens** — read the source file and identify tokens by category:
   - **Tailwind config**: parse `theme.extend` for `colors` (flatten nested objects, e.g. `primary.500` → `primary/500`), `spacing`, `borderRadius`, `fontSize`, and `boxShadow`.
   - **CSS custom properties**: extract `--variable: value` from `:root` blocks. Categorize by prefix (`--color-*` → colors, `--spacing-*` → spacing, `--radius-*` → radius, `--font-*` → typography, `--shadow-*` → shadows). Resolve `var()` references.
   - **Theme files**: find exported objects (`export const colors = { ... }`), flatten nested structures into token paths.

0.3. **Create Figma variable collections** — call `use_figma` to create one variable collection per token category. Example:

```js
use_figma({
  code: `
    // Create Colors collection
    const colors = figma.variables.createVariableCollection('Colors');
    const mode = colors.modes[0];

    // Add variables
    const primary500 = figma.variables.createVariable('primary/500', colors, 'COLOR');
    primary500.setValueForMode(mode.modeId, figma.util.rgb('#3B82F6'));

    // ... repeat for each color token

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

0.4. **Verify** — confirm the variable collections were created with the expected count. If any are missing, retry.

## Phase 1: Component sync

1. Call `list-all-documentation({ withStoryIds: true })` on Storybook MCP to get component IDs and story IDs.
2. For each component, call `get-documentation({ id: "<component-id>" })`. The response has a TypeScript `Props` type and documentation describing the component's appearance and behavior.
3. Map each prop to determine variant structure:
   - `boolean` / `bool` -> Figma boolean variant
   - Union of string literals (`'sm' | 'md' | 'lg'`) -> Figma variant property with those values
   - Skip: free strings, numbers, callbacks (`=>`), ReactNode, children, className, style, ref, key, aria-*, data-*, on* handlers
4. Compute the Cartesian product of mapped props. Cap at 256 combinations.
5. Extract visual details from the documentation and story descriptions. Pay close attention to:
   - Colors (background, text, border) for each variant state
   - Typography (font size, weight) differences between variants
   - Spacing and padding differences between size variants
   - Border radius, borders, shadows
   - How boolean props change appearance (e.g. primary=true is filled/colored, primary=false is outlined/muted)
   - Default/resting states vs active/hover descriptions
6. Read the component's source file (`.tsx` / `.jsx`) to extract concrete styling values. Look for:
   - **Tailwind classes** — translate to Figma properties (e.g. `bg-blue-600` → fill `#2563EB`, `rounded-md` → 6px corner radius, `px-4` → 16px horizontal padding, `py-2` → 8px vertical padding, `text-sm` → 14px font size, `font-semibold` → 600 weight, `border` → 1px border, `shadow-sm` → drop shadow)
   - **CSS module imports** — follow the `.module.css` / `.module.scss` import, read that file, and extract the actual property values used for each class
   - **Styled-component definitions** — read the tagged-template CSS in `styled.div`, `styled(Base)`, etc. and pull out colors, spacing, typography, and borders
   - **Inline styles** — capture any `style={{ ... }}` objects with literal values
   - **Theme token references** — if the component uses tokens like `theme.colors.primary` or CSS custom properties (`var(--color-primary)`), trace them back to the theme definition file and resolve to concrete values
   Edge cases:
   - **Source file not found** — if the component source cannot be located or read, fall back to documentation values and note the result as inferred.
   - **Dynamic/conditional styling** — for simple ternaries and literal concatenations (e.g. `isPrimary ? 'bg-blue-600' : 'bg-gray-200'`), capture both concrete values and create variants for each. For runtime-computed expressions (template literals with variables, `clsx`/`cn` calls with non-literal keys), extract whatever literal fragments are present and flag the rest for manual review.
   - **Source vs. documentation conflicts** — prefer explicit literal values found in source code. If source and documentation both provide concrete but different values, use the source value and note the discrepancy in the summary.
   Use these extracted values as the source of truth for colors, spacing, typography, and borders when calling `use_figma` in the next step. Documentation values fill in gaps where source code lacks concrete values.
7. Write to Figma with `use_figma`. Include full visual styling — not just variant names, but how each variant should actually look:

```js
use_figma({
  code: `
    // Create component set on 'storysync' page
    // Component: Button
    // Variant properties:
    //   - primary (BOOLEAN): [true, false] (default: true)
    //   - size (VARIANT): [small, medium, large] (default: medium)
    //
    // Visual spec:
    //   All variants: rounded corners (6px radius), horizontal auto-layout, centered text
    //   primary=true: background #1EA7FD, white text, no border
    //   primary=false: transparent background, #333 text, 1px solid #ccc border
    //   size=small: 12px font, 8px/4px padding
    //   size=medium: 14px font, 16px/8px padding
    //   size=large: 16px font, 24px/12px padding

    // ... Figma Plugin API code to create the component set
  `,
  description: "Create Button component set with 6 variants (primary x size), styled per visual spec",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

8. After creating each component, verify it looks correct. If something is off, call `use_figma` again to fix the styling.
9. Summarize what was synced: token collections created (if Phase 0 ran), component count, variant counts, visual details applied, any failures or caps.

## Variable binding

If variable collections were created in Phase 0, bind component properties to variables instead of hardcoding values:
- Fills → bind to the matching variable from the Colors collection (e.g. `primary/500`)
- Padding / spacing → bind to the Spacing collection
- Corner radius → bind to the Radius collection
- Font size → bind to the Typography collection
- Drop shadows → bind to the Shadows collection

This ensures that when tokens change in code and storysync runs again, updating the variables automatically updates all components.

## Phase 2: Audit (Figma vs Code)

Compare the current Figma file against code to find drift in either direction. Use this when someone asks to "check if Figma is in sync", "audit the design system", or "diff Figma vs code".

If the `use_figma` tool doesn't return the plugin code's return value in a usable form, fall back to reading Figma state via any available `get-*` / `list-*` tools on the Figma MCP server (call `tools/list` first to see what's available), or ask the user to export Figma variables/components to JSON and diff against that.

2.1. **Read Figma variables** — call `use_figma` to enumerate all variable collections and their resolved values:

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

2.2. **Read Figma components** — call `use_figma` to enumerate all component sets and their variant properties:

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

2.3. **Extract code tokens** — follow Phase 0 steps 0.1–0.2 to extract tokens from the project source.

2.4. **Map code components** — follow Phase 1 steps 1–4 to read Storybook props and compute variant mappings.

2.5. **Compare tokens** — match Figma variable collections to code token categories (Colors → colors, Spacing → spacing, etc.). For each token:
   - In code but not in Figma → **missing from Figma** (needs sync)
   - In Figma but not in code → **missing from code** (orphaned or manually added)
   - Both exist but values differ → **value mismatch** (show code value vs Figma value)
   - Normalize before comparing: lowercase hex colors, convert rem→px (1rem=16px), strip units for numeric comparison.

2.6. **Compare components** — match by name (case-insensitive). For each component:
   - In code/Storybook but not in Figma → **code only** (not yet synced)
   - In Figma but not in code/Storybook → **Figma only** (orphaned or renamed)
   - Both exist → compare variant properties: missing props, extra props, missing/extra values per prop.

2.7. **Report** — present a structured drift report:
   - Group by category (tokens) or component name
   - Use clear labels: `+` missing from Figma, `-` missing from code, `~` value mismatch
   - End with a summary: N tokens matched, N mismatched, N missing. N components matched, N mismatched.
   - If everything matches, confirm "Figma and code are in sync."

## Visual accuracy guidelines

- Always try to match the real component's appearance as closely as possible. The goal is a Figma library that a designer can immediately use, not just variant scaffolding.
- Use the story descriptions, prop types, default values, and any color/sizing information from the documentation to inform the visual output.
- When documentation lacks specific values (exact hex colors, pixel sizes), make reasonable inferences from the component's purpose and name. A "primary" button is typically bold/colored, a "destructive" variant is typically red, "small" is smaller padding and font, etc.
- Prefer auto-layout in Figma so components resize properly.
- Add text layers with the component name or a representative label (e.g. "Button" text inside a button component).
