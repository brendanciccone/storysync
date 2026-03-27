# storysync - Generate Figma library from Storybook

You are helping the user generate a Figma component library from their React Storybook using storysync.

## Prerequisites

The user must have:
1. A running Storybook dev server with `@storybook/addon-mcp` (Vite-based Storybook 9+, Node 24+)
2. Storybook MCP connected: `claude mcp add --transport http storybook http://localhost:6006/mcp`
3. Figma MCP connected: `claude plugin install figma@claude-plugins-official` (or `claude mcp add --transport http figma https://mcp.figma.com/mcp`)
4. A Figma file URL or file key where components will be written
5. Figma Full seat (Dev seats are read-only)

## How it works

storysync reads components from Storybook MCP and writes them to Figma MCP using deterministic mapping rules.

### Mapping rules

| Storybook prop type | Figma output |
|---|---|
| `boolean` | Boolean variant property |
| `enum` / `union` of literals | Variant property with matching values |
| `string` (free text) | Skipped (not a visual variant) |
| `number` (free value) | Skipped |
| `function` / `callback` | Skipped |
| `ReactNode` / `children` | Skipped |
| `ref` / `className` / `style` | Skipped |

## Steps

When the user asks to generate their Figma library from Storybook, follow these steps:

### 1. List components from Storybook MCP

Use the Storybook MCP `list-all-documentation` tool:

```
list-all-documentation({ withStoryIds: true })
```

This returns a markdown list like:
```
- **Button** (id: `button`) - A clickable button
  - Primary (id: `button--primary`)
  - Secondary (id: `button--secondary`)
```

Parse the response to get component IDs (the `id` value, NOT the display name).

### 2. For each component, get its documentation

Use `get-documentation` with the component **ID**:

```
get-documentation({ id: "button" })
```

Note: the parameter is `id`, not `name`. Use the ID exactly as returned by `list-all-documentation`.

The response includes a TypeScript Props type definition in a code block:
```typescript
export type Props = {
  variant?: "default" | "destructive" = "default";
  disabled?: boolean = false;
  size?: "sm" | "md" | "lg";
  onClick?: (event: MouseEvent) => void;
  children?: ReactNode;
}
```

### 3. Apply mapping rules

For each prop from the TypeScript definition:
- **Boolean props** (`boolean`, `bool`) → Figma boolean variant property
- **Enum/union of string literals** (`'sm' | 'md' | 'lg'`) → Figma variant property with those values
- **Skip everything else**: free-text strings, numbers, callbacks (`=>` in type), ReactNode, children, className, style, ref, key, aria-*, data-*, on* handlers

### 4. Generate variant combinations

Compute the Cartesian product of all mapped props. Cap at 256.
Example: `variant: [default, destructive]` x `disabled: [true, false]` = 4 combinations.

### 5. Write to Figma

Use the Figma MCP `use_figma` tool to create each component set. Include the Figma file URL or key:

```
use_figma({
  instruction: "Create a component set in file <file-key> on page 'storysync':\n\nComponent name: Button\n\nVariant properties:\n  - variant (VARIANT): [default, destructive] (default: default)\n  - disabled (BOOLEAN): [true, false] (default: false)\n\nCreate 4 variants for all combinations.\nEach variant named: property1=value1, property2=value2",
  fileKey: "<file-key>"
})
```

`use_figma` is Figma's general-purpose write tool. It executes Plugin API code to create real Figma objects (components, variants, variables, auto layout).

### 6. Report results

After processing all components, summarize:
- How many components were synced
- How many variant combinations were created for each
- Any components that were skipped or failed
- Whether any were capped at 256 combinations

## Example conversation

**User**: Generate my Figma library from Storybook

**Assistant**: I'll read your components from Storybook MCP and write them to Figma MCP.

First, let me list all available components...
[Uses Storybook MCP `list-all-documentation`]

Found 12 components. Let me process each one:

1. **Button** - 3 variant props (variant, size, disabled) -> 18 combinations
2. **Input** - 2 variant props (variant, disabled) -> 6 combinations
...

All 12 components synced to your Figma file on the "storysync" page.
