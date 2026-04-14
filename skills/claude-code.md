# storysync - Storybook to Figma

Read components from Storybook MCP and recreate them in Figma MCP as a visually accurate component library.

## Requirements

- Storybook dev server running with `@storybook/addon-mcp` (Vite-based Storybook 9+, Node 24+)
- Storybook MCP: `claude mcp add --transport http storybook http://localhost:6006/mcp`
- Figma MCP: `claude plugin install figma@claude-plugins-official` (or `claude mcp add --transport http figma https://mcp.figma.com/mcp`)
- Figma Full seat (Dev seats are read-only)

## Workflow

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
6. Write to Figma with `use_figma`. Include full visual styling in the instruction — not just variant names, but how each variant should actually look:

```
use_figma({
  instruction: "Create a component set in file <file-key> on page 'storysync':\n\nComponent: Button\n\nVariant properties:\n  - primary (BOOLEAN): [true, false] (default: true)\n  - size (VARIANT): [small, medium, large] (default: medium)\n\nVisual spec:\n  All variants: rounded corners (6px radius), horizontal auto-layout, centered text, font family Inter or system sans-serif.\n  primary=true: background #1EA7FD, white text, no border.\n  primary=false: transparent background, #333 text, 1px solid #ccc border.\n  size=small: 12px font, 8px horizontal / 4px vertical padding.\n  size=medium: 14px font, 16px horizontal / 8px vertical padding.\n  size=large: 16px font, 24px horizontal / 12px vertical padding.\n\nCreate 6 variants. Name each: primary=true, size=small (etc). Make each variant look visually distinct and match the spec above.",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

7. After creating each component, verify it looks correct. If something is off, call `use_figma` again to fix the styling.
8. Summarize what was synced: component count, variant counts, visual details applied, any failures or caps.

## Visual accuracy guidelines

- Always try to match the real component's appearance as closely as possible. The goal is a Figma library that a designer can immediately use, not just variant scaffolding.
- Use the story descriptions, prop types, default values, and any color/sizing information from the documentation to inform the visual output.
- When documentation lacks specific values (exact hex colors, pixel sizes), make reasonable inferences from the component's purpose and name. A "primary" button is typically bold/colored, a "destructive" variant is typically red, "small" is smaller padding and font, etc.
- Prefer auto-layout in Figma so components resize properly.
- Add text layers with the component name or a representative label (e.g. "Button" text inside a button component).
