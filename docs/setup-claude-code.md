# Claude Code setup

## Prerequisites

1. [Claude Code](https://claude.ai/code) installed
2. A Storybook project with `@storybook/addon-mcp` (Vite-based Storybook 9+, Node 24+)
3. Figma Full seat on a paid plan (Dev seats are read-only)

## Step 1: Install the storysync skill

```bash
mkdir -p .claude/skills
```

Copy from the repo:
```bash
cp skills/claude-code.md .claude/skills/storysync.md
```

Or download directly:
```bash
curl -o .claude/skills/storysync.md https://raw.githubusercontent.com/brendanciccone/storysync/main/skills/claude-code.md
```

## Step 2: Connect Storybook MCP

Install the addon in your Storybook project:
```bash
npm install @storybook/addon-mcp
```

Start Storybook (`npm run storybook`), then add the MCP server to Claude Code:
```bash
claude mcp add --transport http storybook http://localhost:6006/mcp
```

## Step 3: Connect Figma MCP

The recommended way is the Figma plugin, which includes the MCP server and agent skills:
```bash
claude plugin install figma@claude-plugins-official
```

Or add the MCP server manually:
```bash
claude mcp add --transport http figma https://mcp.figma.com/mcp
```

Either way, Claude Code will prompt you to authenticate with Figma via OAuth when you first use it.

> Tip: Add `--scope user` to make the MCP server available across all projects.

## Step 4: Use it

Start a Claude Code session and say:

> Generate my Figma library from Storybook

Claude will use the storysync skill to:
1. List all components from Storybook MCP (`list-all-documentation`)
2. Read each component's props (`get-documentation`)
3. Map boolean and enum props to Figma variant properties
4. Create component sets in Figma via `use_figma`
5. Report the results

You can also be more specific:

> Sync just the Button and Input components to Figma

> Inspect the Card component's prop mapping before syncing
