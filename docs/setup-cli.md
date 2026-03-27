# CLI setup

## Install

```bash
npm install -g storysync
```

Or use directly with npx:

```bash
npx storysync generate --storybook http://localhost:6006 --figma-file <file-key>
```

## Prerequisites

1. **Running Storybook** — Start your Storybook locally or have a deployed URL
2. **Figma access token** — Generate one at https://www.figma.com/developers/api#access-tokens
3. **Figma file key** — The key from your Figma file URL: `figma.com/file/<THIS-PART>/...`

## Usage

### Set your Figma token

```bash
export FIGMA_ACCESS_TOKEN=your-token-here
```

Or pass it inline:

```bash
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --figma-token your-token
```

### Generate your Figma library

```bash
# Sync all components
npx storysync generate --storybook http://localhost:6006 --figma-file abc123

# Sync specific components only
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --components Button,Input,Card

# Skip screenshots (faster)
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --no-screenshots

# Custom page name
npx storysync generate --storybook http://localhost:6006 --figma-file abc123 --page "Design System"
```

### List available components

```bash
npx storysync list --storybook http://localhost:6006
```

### Inspect a component's mapping

```bash
npx storysync inspect --storybook http://localhost:6006 --component Button
```

This shows each prop and whether it maps to a Figma variant or gets skipped.
