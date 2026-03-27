# Claude Code setup

## Prerequisites

1. [Claude Code](https://claude.ai/code) installed and configured
2. Storybook MCP server connected to your Claude Code session
3. Figma MCP server connected to your Claude Code session

## Install the skill

Copy the storysync skill file into your project:

```bash
mkdir -p .claude/skills
cp node_modules/storysync/skills/claude-code.md .claude/skills/storysync.md
```

Or download it directly:

```bash
mkdir -p .claude/skills
curl -o .claude/skills/storysync.md https://raw.githubusercontent.com/brendanciccone/storysync/main/skills/claude-code.md
```

## Connect the MCPs

Make sure both Storybook MCP and Figma MCP are configured in your Claude Code settings.

### Storybook MCP

Add to your Claude Code MCP configuration:

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

Start a Claude Code session and say:

> Generate my Figma library from Storybook

Claude will use the storysync skill to:
1. List all components from Storybook MCP
2. Read each component's props
3. Apply the deterministic mapping rules
4. Create corresponding Figma components via Figma MCP
5. Report the results

You can also be more specific:

> Sync just the Button and Input components to Figma
> Inspect the Card component's prop mapping before syncing
