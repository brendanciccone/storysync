# Cursor setup

## Prerequisites

1. [Cursor](https://cursor.com) installed
2. A Storybook project with `@storybook/addon-mcp` (Vite-based Storybook 9+, Node 24+)
3. Figma Full seat on a paid plan (Dev seats are read-only)

## Step 1: Install the storysync rule

```bash
mkdir -p .cursor/rules
```

Copy from the repo:
```bash
cp skills/cursor.mdc .cursor/rules/storysync.mdc
```

Or download directly:
```bash
curl -o .cursor/rules/storysync.mdc https://raw.githubusercontent.com/brendanciccone/storysync/main/skills/cursor.mdc
```

## Step 2: Connect Storybook MCP

Install the addon in your Storybook project:
```bash
npm install @storybook/addon-mcp
```

Start Storybook (`npm run storybook`), then add the MCP server in Cursor settings (Settings > MCP):

```json
{
  "mcpServers": {
    "storybook": {
      "url": "http://localhost:6006/mcp"
    }
  }
}
```

## Step 3: Connect Figma MCP

The recommended way is the Figma plugin. In Cursor's agent chat, type:

```
/add-plugin figma
```

This installs the MCP server configuration and agent skills for Figma.

Or add the MCP server manually in Cursor settings:

```json
{
  "mcpServers": {
    "figma": {
      "url": "https://mcp.figma.com/mcp"
    }
  }
}
```

Cursor will prompt you to authenticate with Figma via OAuth when you first connect.

## Step 4: Use it

Open the Cursor chat and say:

> Generate my Figma library from Storybook

Cursor will use the storysync rule to read your Storybook components and write them to Figma.
