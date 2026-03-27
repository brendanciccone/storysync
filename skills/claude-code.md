# storysync — Generate Figma library from Storybook

You are helping the user generate a Figma component library from their React Storybook using storysync.

## Prerequisites

The user must have:
1. A running Storybook instance (local or deployed)
2. Storybook MCP connected to this session
3. Figma MCP connected to this session
4. A Figma file key where components will be written

## How it works

storysync reads components from Storybook MCP and writes them to Figma MCP using deterministic mapping rules — no LLM in the mapping path.

### Mapping rules

| Storybook prop type | Figma output |
|---|---|
| `boolean` | Boolean variant property |
| `enum` / `union` | Variant property with matching values |
| `string` (free text) | Skipped (not a visual variant) |
| `number` (free value) | Skipped |
| `function` / `callback` | Skipped |
| `ReactNode` / `children` | Skipped |
| `ref` / `className` / `style` | Skipped |

## Steps

When the user asks to generate their Figma library from Storybook, follow these steps:

### 1. Read components from Storybook MCP

Use the Storybook MCP `list_components` tool to get all available components:

```
list_components()
```

### 2. For each component, get its props

Use `get_component` to read each component's props and stories:

```
get_component({ name: "Button" })
```

### 3. Apply mapping rules

For each prop:
- **Boolean props** (`boolean`, `bool`) → Create a Figma boolean variant property
- **Enum/union props** → Create a Figma variant property with matching values
- **Skip**: `string`, `number`, `function`, callbacks (`onClick`, `onChange`, etc.), `ReactNode`, `children`, `className`, `style`, `ref`, `key`, `aria-*`, `data-*`

### 4. Generate variant combinations

Compute all combinations of the mapped variant properties. For example, a component with `variant: [default, destructive]` and `disabled: [true, false]` produces 4 combinations.

### 5. Create the Figma page

Use Figma MCP to create a page for the components:

```
create_page({ fileKey: "<file-key>", name: "storysync" })
```

### 6. Write each component to Figma

For each component, use Figma MCP to:

1. Create a component set with variant properties:
```
create_component_set({
  fileKey: "<file-key>",
  pageName: "storysync",
  name: "Button",
  variantProperties: [
    { name: "variant", type: "VARIANT", values: ["default", "destructive"] },
    { name: "disabled", type: "BOOLEAN", values: ["true", "false"] }
  ]
})
```

2. Create each variant:
```
create_variant({
  fileKey: "<file-key>",
  componentSetId: "<node-id>",
  name: "variant=default, disabled=false",
  properties: { variant: "default", disabled: "false" }
})
```

### 7. Report results

After processing all components, summarize:
- How many components were synced
- How many variant combinations were created for each
- Any components that were skipped or failed

## Example conversation

**User**: Generate my Figma library from Storybook

**Assistant**: I'll read your components from Storybook MCP and write them to Figma MCP.

First, let me list all available components...
[Uses Storybook MCP list_components]

Found 12 components. Let me process each one:

1. **Button** — 3 variant props (variant, size, disabled) → 18 combinations
2. **Input** — 2 variant props (variant, disabled) → 6 combinations
...

All 12 components synced to your Figma file on the "storysync" page.
