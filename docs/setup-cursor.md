# Cursor setup

## Prerequisites

1. [Cursor](https://cursor.com) installed
2. Storybook MCP server connected in Cursor
3. Figma MCP server connected in Cursor

## Install the rules file

Copy the storysync rules file into your project:

```bash
mkdir -p .cursor/rules
cp node_modules/storysync/skills/cursor.mdc .cursor/rules/storysync.mdc
```

Or download it directly:

```bash
mkdir -p .cursor/rules
curl -o .cursor/rules/storysync.mdc https://raw.githubusercontent.com/brendanciccone/storysync/main/skills/cursor.mdc
```

## Connect the MCPs

### Storybook MCP

Install `@storybook/addon-mcp` in your project. Add to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "storybook": {
      "type": "http",
      "url": "http://localhost:6006/mcp"
    }
  }
}
```

### Figma MCP

Add the official Figma MCP remote server:

```json
{
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp"
    }
  }
}
```

See [Figma MCP documentation](https://developers.figma.com/docs/figma-mcp-server/) for auth setup.

## Usage

Open the Cursor chat and say:

> Generate my Figma library from Storybook

Cursor will use the storysync rule to read your Storybook components and write them to Figma.
