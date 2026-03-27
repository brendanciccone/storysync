# storysync

The missing link between Storybook MCP and Figma MCP.

You have a React Storybook. You run one command. You get a Figma component library.

## What it does

Reads your components from [Storybook MCP](https://storybook.js.org/docs/sharing/mcp) and writes them to [Figma MCP](https://figma.com/developers/mcp). Deterministic mapping, no LLM. Four ways to use it:

- **Claude Code skill** — run it conversationally
- **Cursor rules file** — run it from Cursor
- **CLI** — run it as a command
- **GitHub Action** — run it automatically when components change

## Quick start

### CLI

```bash
npx storysync generate \
  --storybook http://localhost:6006 \
  --figma-file <file-key> \
  --figma-token <token>
```

### GitHub Action

```yaml
name: Sync Storybook to Figma
on:
  push:
    branches: [main]
    paths: ['src/components/**', 'stories/**']

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: storysync/action@v1
        with:
          storybook_url: http://localhost:6006
          figma_file_key: ${{ secrets.FIGMA_FILE_KEY }}
          figma_token: ${{ secrets.FIGMA_ACCESS_TOKEN }}
```

### Claude Code

Copy `skills/claude-code.md` to `.claude/skills/storysync.md` in your project. Connect both Storybook MCP and Figma MCP, then tell Claude: "Generate my Figma library from Storybook."

### Cursor

Copy `skills/cursor.mdc` to `.cursor/rules/storysync.mdc` in your project. Connect both MCPs and run the rule.

## How it works

```
Storybook MCP              storysync               Figma MCP
(reads your components)    (mapping rules)         (writes to canvas)

component: Button     →    boolean prop?        →  Figma boolean variant
props:                      → boolean variant
  variant: enum             enum prop?           →  Figma variant property
    [default, destructive]  → variant property       with matching values
  disabled: boolean         callback prop?
  size: enum                → skip (not visual)     Figma component with
    [sm, md, lg]            render each state?       all variants created
                            → screenshot            + reference images
                            → attach to component
```

## Mapping rules

Deterministic. No LLM.

| Storybook prop type | Figma output |
|---|---|
| `boolean` | Boolean variant property |
| `enum` / `union` | Variant property with matching values |
| `string` (free text) | Skipped |
| `number` (free value) | Skipped |
| `function` / `callback` | Skipped |
| `ReactNode` / `children` | Skipped |
| `ref` / `className` / `style` | Skipped |

## CLI commands

### `storysync generate`

Generate Figma component library from Storybook.

```
Options:
  --storybook <url>         URL of the running Storybook instance (required)
  --figma-file <key>        Figma file key (required)
  --figma-token <token>     Figma access token (or set FIGMA_ACCESS_TOKEN)
  --page <name>             Figma page name (default: "storysync")
  --no-screenshots          Skip capturing screenshots
  --components <names>      Comma-separated component names to sync
  --viewport-width <width>  Screenshot viewport width (default: 800)
  --viewport-height <height> Screenshot viewport height (default: 600)
```

### `storysync list`

List all components available in Storybook.

```
Options:
  --storybook <url>    URL of the running Storybook instance (required)
```

### `storysync inspect`

Inspect a component's props and show how they map to Figma.

```
Options:
  --storybook <url>      URL of the running Storybook instance (required)
  --component <name>     Component name to inspect (required)
```

## What you get in Figma

For each Storybook component:

- A Figma component set with variant properties matching your React props
- A reference screenshot of each variant state
- Organized into pages matching your Storybook hierarchy
- 1:1 structural match with your code

## Requirements

- React Storybook (local or deployed)
- Figma account + personal access token
- Node 18+
- For Claude Code/Cursor: respective setups with both MCPs connected
- For GitHub Action: Action in your workflow + secrets configured

No Anthropic API key needed. No LLM costs. Fully deterministic.

## License

MIT
