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

**You are a thin pipeline.** The CLI generates the exact Figma Plugin API code (variables, components, bindings, all of it). Your job is to pipe each generated script to `use_figma` verbatim. Do NOT read component source files. Do NOT write your own Figma Plugin code. Do NOT decide which variants to skip or which bindings to apply.

1. **Generate the plan.** Run:

```bash
npx storysync push <figma-url> --storybook http://localhost:6006 --project . --json
```

The output has a `scripts` array. Each script is a complete Figma Plugin API JavaScript snippet (variables, components, bindings) wired together. Variable bindings inside component scripts resolve at runtime, so script ordering matters but no IDs need to be threaded.

2. **Pipe each script to `use_figma`** in order:

```js
use_figma({ code: <script.code>, description: <script.label>, fileKey: <plan.fileKey>, skillNames: "figma-use" })
```

Do not modify the code. Do not skip a script. Do not reorder.

3. **Report** the plan's `failures` and `warnings` plus the count of scripts that ran successfully.

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
