#!/usr/bin/env bash
set -euo pipefail

echo "storysync — Syncing Storybook components to Figma"
echo ""

STORYBOOK_URL="${INPUT_STORYBOOK_URL:?Storybook URL is required}"
FIGMA_FILE_KEY="${INPUT_FIGMA_FILE_KEY:?Figma file key is required}"
FIGMA_TOKEN="${INPUT_FIGMA_TOKEN:?Figma access token is required}"
PAGE_NAME="${INPUT_PAGE_NAME:-storysync}"
COMPONENTS="${INPUT_COMPONENTS:-}"
NO_SCREENSHOTS="${INPUT_NO_SCREENSHOTS:-false}"
VIEWPORT_WIDTH="${INPUT_VIEWPORT_WIDTH:-800}"
VIEWPORT_HEIGHT="${INPUT_VIEWPORT_HEIGHT:-600}"

export FIGMA_ACCESS_TOKEN="$FIGMA_TOKEN"

ARGS="generate --storybook $STORYBOOK_URL --figma-file $FIGMA_FILE_KEY --page $PAGE_NAME"

if [ "$NO_SCREENSHOTS" = "true" ]; then
  ARGS="$ARGS --no-screenshots"
fi

if [ -n "$COMPONENTS" ]; then
  ARGS="$ARGS --components $COMPONENTS"
fi

ARGS="$ARGS --viewport-width $VIEWPORT_WIDTH --viewport-height $VIEWPORT_HEIGHT"

npx storysync $ARGS
