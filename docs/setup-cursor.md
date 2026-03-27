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

Add to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "storybook": {
      "url": "http://localhost:6006/.mcp"
    }
  }
}
```

### Figma MCP

Add Figma MCP following the [Figma MCP documentation](https://figma.com/developers/mcp).

## Usage

Open the Cursor chat and say:

> Generate my Figma library from Storybook

Cursor will use the storysync rule to read your Storybook components and write them to Figma.
