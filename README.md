# storysync

The missing link between Storybook MCP and Figma MCP.

You have a React Storybook. You run one command. You get a Figma component library.

## What it does

Reads your components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview) and writes them to [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/) using deterministic mapping rules. Four ways to use it:

### Ways to use it

| Method | How it works | Status |
|---|---|---|
| **Claude Code skill** | Claude calls both MCPs directly | Works |
| **Cursor rules** | Cursor calls both MCPs directly | Works |
| **CLI** | `npx storysync generate --dry-run` | Read-only (dry-run, list, inspect) |
| **GitHub Action** | Runs on push/PR | Read-only (dry-run only) |

> **Why read-only for CLI/Action?** The Figma MCP remote server requires OAuth 2.0 with a browser-based consent flow. AI coding tools (Claude Code, Cursor) handle this automatically. The CLI and Action cannot open a browser for OAuth. Use `--dry-run` to preview mappings, then use Claude Code or Cursor to write to Figma.

## Quick start

### Claude Code (recommended)

1. Install `@storybook/addon-mcp` in your Storybook project (Vite-based Storybook 9+ only)
2. Start Storybook: `npm run storybook`
3. Connect Storybook MCP:
   ```bash
   claude mcp add --transport http storybook http://localhost:6006/mcp
   ```
4. Install the Figma plugin (includes MCP server + skills):
   ```bash
   claude plugin install figma@claude-plugins-official
   ```
5. Copy the storysync skill:
   ```bash
   mkdir -p .claude/skills
   cp skills/claude-code.md .claude/skills/storysync.md
   ```
6. Tell Claude: "Generate my Figma library from Storybook"

### Cursor

1. Install `@storybook/addon-mcp` in your Storybook project (Vite-based Storybook 9+ only)
2. Start Storybook: `npm run storybook`
3. Add Storybook MCP in Cursor settings (URL: `http://localhost:6006/mcp`)
4. Install the Figma plugin in Cursor chat: `/add-plugin figma`
5. Copy the storysync rule:
   ```bash
   mkdir -p .cursor/rules
   cp skills/cursor.mdc .cursor/rules/storysync.mdc
   ```
6. Tell Cursor: "Generate my Figma library from Storybook"

### CLI (dry-run / inspect)

```bash
# Preview what would be synced — no Figma connection needed
npx storysync generate --storybook http://localhost:6006 --dry-run

# List all components
npx storysync list --storybook http://localhost:6006

# Inspect a component's mapping
npx storysync inspect --storybook http://localhost:6006 --component Button
```

## How it works

```
Storybook MCP              storysync               Figma MCP
list-all-documentation     (mapping rules)         use_figma
get-documentation                                  (writes to canvas)

component: Button     →    boolean prop?        →  Figma boolean variant
props:                      → boolean variant
  variant: enum             enum prop?           →  Figma variant property
    [default, destructive]  → variant property       with matching values
  disabled: boolean         callback prop?
  size: enum                → skip (not visual)     Figma component set
    [sm, md, lg]                                     with all variant
                                                     combinations
```

## Mapping rules

Deterministic — storysync maps prop types to Figma variants without an LLM. (Note: Figma's `use_figma` tool itself is agent-driven on their side.)

| Storybook prop type | Figma output |
|---|---|
| `boolean` | Boolean variant property |
| `enum` / `union` of string literals | Variant property with matching values |
| `string` (free text) | Skipped |
| `number` (free value) | Skipped |
| `function` / `callback` | Skipped |
| `ReactNode` / `children` | Skipped |
| `ref` / `className` / `style` | Skipped |

Variant combinations are the Cartesian product of all mapped props, capped at 256.

## CLI commands

### `storysync generate`

Generate Figma component library from Storybook.

```
Options:
  --storybook <url>         URL of the running Storybook instance (required)
  --figma-file <key>        Figma file key (required unless --dry-run)
  --figma-token <token>     Figma access token (or set FIGMA_ACCESS_TOKEN)
  --page <name>             Figma page name (default: "storysync")
  --components <names>      Comma-separated component names to sync
  --dry-run                 Preview mapping without writing to Figma
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
  --component <name>     Component name or ID to inspect (required)
```

## Requirements

### Storybook

- **Storybook 9+** with a **Vite-based** framework (`@storybook/react-vite`, `@storybook/nextjs-vite`, or `@storybook/sveltekit`)
- **`@storybook/addon-mcp`** installed — provides MCP server at `/mcp` on the dev server
- **Node.js 24+** — required by `@storybook/addon-mcp`
- The MCP endpoint only works with the **dev server** (`storybook dev`), not static builds

### Figma

- **Full seat** on a paid plan — required for write access via `use_figma`. Dev seats are read-only.
- **Remote MCP server** at `https://mcp.figma.com/mcp` — auth is OAuth 2.0 (handled automatically by Claude Code, Cursor, and other supported MCP clients)
- The **desktop MCP server** (`http://127.0.0.1:3845/mcp`) does not expose `use_figma`
- **Rate limits**: Starter/View/Collab seats get 6 tool calls per month. Full seats on Professional+ plans have per-minute rate limits.
- Write-to-canvas is free during beta but will become a paid, usage-based feature

No Anthropic API key needed.

## License

MIT
