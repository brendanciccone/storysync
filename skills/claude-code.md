# storysync — Generate Figma library from Storybook

You are helping the user generate a Figma component library from their React Storybook using storysync.

## Prerequisites

The user must have:
1. A running Storybook instance (local or deployed)
2. Storybook MCP connected (`@storybook/addon-mcp` — endpoint at `/mcp`)
3. Figma MCP connected (remote server at `https://mcp.figma.com/mcp`)
4. A Figma file where components will be written

## How it works

storysync reads components from Storybook MCP and writes them to Figma MCP using deterministic mapping rules — no LLM in the mapping path.

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

Use the Storybook MCP `list-all-documentation` tool with `withStoryIds: true`:

```
list-all-documentation({ withStoryIds: true })
```

This returns a markdown list of components with their IDs and story IDs. Parse the response to get component IDs (NOT display names — the ID is what you pass to `get-documentation`).

### 2. For each component, get its documentation

Use `get-documentation` with the component **ID** (from the list above):

```
get-documentation({ id: "button" })
```

Note: the parameter is `id`, not `name`. Use the ID exactly as returned by `list-all-documentation`.

The response includes a TypeScript Props type definition. Extract props from it:
- Boolean props → will become Figma boolean variants
- Enum/union props → will become Figma variant properties
- Skip: string, number, callbacks, ReactNode, className, style, ref, etc.

### 3. Apply mapping rules

For each prop from the documentation:
- **Boolean props** (`boolean`, `bool`) → Figma boolean variant property
- **Enum/union of string literals** (`'sm' | 'md' | 'lg'`) → Figma variant property with those values
- **Skip everything else** — free-text strings, numbers, callbacks, React internals

### 4. Generate variant combinations

Compute all combinations. Cap at 256 to avoid explosion.
Example: `variant: [default, destructive]` × `disabled: [true, false]` = 4 combinations.

### 5. Write to Figma

Use the Figma MCP `use_figma` tool to create each component:

```
use_figma({
  instruction: "Create a component set in file <file-key> on page 'storysync':\n\nComponent name: Button\n\nVariant properties:\n  - variant (VARIANT): [default, destructive] (default: default)\n  - disabled (BOOLEAN): [true, false] (default: false)\n\nCreate 4 variants for all combinations.",
  fileKey: "<file-key>"
})
```

The `use_figma` tool is a general-purpose write tool — describe what you want to create and it will do it.

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

1. **Button** — 3 variant props (variant, size, disabled) → 18 combinations
2. **Input** — 2 variant props (variant, disabled) → 6 combinations
...

All 12 components synced to your Figma file on the "storysync" page.
