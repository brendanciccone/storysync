# storysync - Storybook to Figma

Read components from Storybook MCP and write them to Figma MCP as a component library.

## Requirements

- Storybook dev server running with `@storybook/addon-mcp` >= 0.5.0 (Vite-based Storybook 9+ or 10+, Node 24+)
- Storybook MCP: `claude mcp add --transport http storybook http://localhost:6006/mcp`
- Figma MCP: `claude plugin install figma@claude-plugins-official` (or `claude mcp add --transport http figma https://mcp.figma.com/mcp`)
- Figma Full seat (Dev seats are read-only outside drafts). Starter plans limited to 6 tool calls/month.

## Workflow

1. Call `list-all-documentation({ withStoryIds: true })` on Storybook MCP to get component IDs.
2. For each component, call `get-documentation({ id: "<component-id>" })`. The response has a TypeScript `Props` type in a code block.
3. Map each prop:
   - `boolean` / `bool` -> Figma boolean variant
   - Union of string literals (`'sm' | 'md' | 'lg'`) -> Figma variant property with those values
   - Everything else is skipped: free strings, numbers, callbacks (`=>`), ReactNode, children, className, style, ref, key, aria-*, data-*, on* handlers
4. Compute the Cartesian product of mapped props. Cap at 256 combinations.
5. Write to Figma with `use_figma`:

```
use_figma({
  instruction: "Create a component set in file <file-key> on page 'storysync':\n\nComponent: Button\n\nVariant properties:\n  - variant (VARIANT): [default, destructive] (default: default)\n  - disabled (BOOLEAN): [true, false] (default: false)\n\nCreate 4 variants. Name each: property1=value1, property2=value2",
  fileKey: "<file-key>",
  skillNames: "figma-use"
})
```

6. Summarize what was synced: component count, variant counts, any failures or caps.
