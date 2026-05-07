# storysync — Storybook to Figma

Read components from Storybook MCP and recreate them in Figma MCP as a visually accurate component library, with design token foundations.

## Requirements

- Storybook dev server running with `@storybook/addon-mcp` (Vite-based Storybook 10.1+, Node 18+)
- Storybook MCP configured in `.codex/config.toml` (HTTP server at `http://localhost:6006/mcp`)
- Figma MCP configured in `.codex/config.toml` (HTTP server at `https://mcp.figma.com/mcp`)
- Figma Full seat (Dev seats are read-only)
- storysync installed: `npm install -g storysync` or `npx storysync`

## Tokens

Before syncing components, extract design tokens from the project and create Figma variable collections. This ensures components can bind to variables instead of hardcoded values.

1. **Extract tokens** — run storysync to detect and extract tokens from the project:

```bash
npx storysync tokens --json --project .
```

This auto-detects the token source (Tailwind config, CSS custom properties, or theme files) and outputs structured JSON with collections of tokens by category (colors, spacing, typography, radius, shadows). If it returns no collections, skip to Components.

2. **Preview tokens** — optionally, run `npx storysync tokens --project .` (without `--json`) for a human-readable preview.

3. **Create Figma variable collections** — use the JSON output to create Figma variables via `use_figma`, one collection at a time. Convert rem values to px (1rem = 16px) for Figma FLOAT variables. Use Figma `COLOR` type for colors and `FLOAT` type for spacing, radius, and font sizes.

4. **Verify** — confirm the variable collections were created with the expected count. If any are missing, retry.

## Components

1. **List and map components** — run storysync to read Storybook components and compute variant mappings:

```bash
npx storysync map --storybook http://localhost:6006 --json
```

This outputs structured JSON with each component's variant properties (name, type, values, default), combination count, and a `title`/`category` reflecting the component's place in Storybook's sidebar (e.g. `title: "Forms/Button"`, `category: "Forms"`). Use the category to organize the Figma file — see "Organization" below.

2. **Inspect individual components** — for detailed prop-to-variant mapping:

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

3. For each component, read the component's source file (`.tsx` / `.jsx`) to extract concrete styling values. Look for:
   - **Tailwind classes** — translate to Figma properties (e.g. `bg-blue-600` → fill `#2563EB`, `rounded-md` → 6px corner radius, `px-4` → 16px horizontal padding, `py-2` → 8px vertical padding, `text-sm` → 14px font size, `font-semibold` → 600 weight, `border` → 1px border, `shadow-sm` → drop shadow)
   - **CSS module imports** — follow the `.module.css` / `.module.scss` import, read that file, and extract the actual property values used for each class
   - **Styled-component definitions** — read the tagged-template CSS in `styled.div`, `styled(Base)`, etc. and pull out colors, spacing, typography, and borders
   - **Inline styles** — capture any `style={{ ... }}` objects with literal values
   - **Theme token references** — if the component uses tokens like `theme.colors.primary` or CSS custom properties (`var(--color-primary)`), trace them back to the theme definition file and resolve to concrete values
   Edge cases:
   - **Source file not found** — fall back to documentation values and note the result as inferred.
   - **Dynamic/conditional styling** — for simple ternaries (e.g. `isPrimary ? 'bg-blue-600' : 'bg-gray-200'`), capture both values as variants. For runtime-computed expressions, extract literal fragments and flag the rest for manual review.
   - **Source vs. documentation conflicts** — prefer explicit literal values from source. If both differ, use source and note the discrepancy in the summary.
   Use these extracted values as the source of truth for colors, spacing, typography, and borders when calling `use_figma` in the next step. Documentation values fill in gaps where source code lacks concrete values.
4. **Organize the Figma file by Storybook hierarchy.** Group all unique top-level categories from the `category` field, then create one Figma page per top-level category (e.g. `Forms`, `Data Display`, `Navigation`). Components without a category go on a `Components` page. Place each component set on the page matching its category. This mirrors the Storybook sidebar so designers find things where they expect them, and keeps duplicate leaf names (e.g. two `Button`s under different categories) distinct.

5. Write with `use_figma` — find or create the target page, then create the component set on it. Use the variant data from `storysync map` and the visual details from the source code. Include full visual styling in the instruction, not just variant structure: background colors, text colors, font sizes, padding, border radius, borders. Use `skillNames: "figma-use"`.
6. Verify each component visually after creation. Fix any styling issues with a follow-up `use_figma` call.
7. Summarize: token collections created, components synced grouped by page/category, variant counts, visual details applied, failures, caps.

## Variable binding

When token variable collections exist, bind component properties to variables instead of hardcoding values:
- Fills → bind to the matching variable from the Colors collection
- Padding / spacing → bind to the Spacing collection
- Corner radius → bind to the Radius collection
- Font size → bind to the Typography collection
- Drop shadows → bind to the Shadows collection

## Audit

Compare the current Figma file against code to find drift in either direction. Use this when asked to "check if Figma is in sync", "audit the design system", or "diff Figma vs code".

If `use_figma` doesn't return plugin return values, call `tools/list` on the Figma MCP first to find read-only tools, or ask the user to export Figma state to JSON.

1. **Read Figma variables** — call `use_figma` to enumerate all variable collections and their resolved values. Use `figma.variables.getLocalVariableCollectionsAsync()` and `figma.variables.getVariableByIdAsync()` to read each variable's name, resolved type, and value. Convert COLOR values to hex strings.

2. **Read Figma components** — call `use_figma` to enumerate component sets using `figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] })`. For each, read `componentPropertyDefinitions` to get variant properties and their options.

3. **Extract code tokens** — run storysync:

```bash
npx storysync tokens --json --project .
```

4. **Map code components** — run storysync:

```bash
npx storysync map --storybook http://localhost:6006 --json
```

5. **Compare tokens** — match Figma variable collections to code token categories (Colors → colors, Spacing → spacing, etc.). For each token:
   - In code but not in Figma → **missing from Figma** (needs sync)
   - In Figma but not in code → **missing from code** (orphaned or manually added)
   - Both exist but values differ → **value mismatch** (show both values)
   - Normalize before comparing: lowercase hex, convert rem→px, strip units for numerics.

6. **Compare components** — match by name (case-insensitive). For each:
   - In code/Storybook but not in Figma → **code only**
   - In Figma but not in code/Storybook → **Figma only**
   - Both exist → compare variant properties: missing props, extra props, missing/extra values.

7. **Report** — present a structured drift report grouped by category/component. Use `+` for missing from Figma, `-` for missing from code, `~` for value mismatch. End with a summary count.

## Visual accuracy guidelines

- Match the real component's appearance as closely as possible. The goal is a usable Figma library, not just variant scaffolding.
- Use documentation, prop types, defaults, and color/sizing info to inform visuals.
- When docs lack exact values, infer from context: "primary" = bold/colored, "destructive" = red, "small" = less padding/smaller font.
- Use auto-layout so components resize properly.
- Add text layers with representative labels inside components.
