# CLI setup

The CLI reads from Storybook MCP and shows how your components map to Figma variants. It does not write to Figma. Use Claude Code or Cursor for that.

## Install

```bash
npm install -g storysync
```

Or use directly with npx:

```bash
npx storysync --help
```

## Prerequisites

1. **Running Storybook dev server** with `@storybook/addon-mcp` installed
2. **Vite-based Storybook 9+** (`@storybook/react-vite`, `@storybook/nextjs-vite`, or `@storybook/sveltekit`)
3. **Node.js 24+**

## Commands

### Map all components

```bash
npx storysync map --storybook http://localhost:6006
```

Shows every component, which props map to Figma variants, and the total combination count.

### Map specific components

```bash
npx storysync map --storybook http://localhost:6006 --components Button,Input,Card
```

### List available components

```bash
npx storysync list --storybook http://localhost:6006
```

### Inspect one component

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

Shows each prop and whether it maps to a Figma boolean variant, variant property, or gets skipped.
