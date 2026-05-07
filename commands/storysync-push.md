---
description: Sync Storybook components and design tokens from code to Figma
argument-hint: [figma-file-key]
---

Push design tokens and Storybook components from this codebase into Figma using the storysync skill at `.claude/skills/storysync.md`.

**Figma file key:** $ARGUMENTS

If the user did not provide a file key (or `$ARGUMENTS` is empty), ask for it. The file key is the part of a Figma URL between `/design/` and the next `/`.

Workflow:

1. Run `storysync tokens --json --project .` to extract design tokens from the project. If no tokens are found, skip token sync and continue with components.
2. For each token category, call `use_figma` to create or update a matching Figma variable collection. Convert rem values to px (1rem = 16px). Use `COLOR` for colors and `FLOAT` for numeric tokens.
3. Run `storysync map --storybook http://localhost:6006 --json` to get component variant mappings. If Storybook isn't running on port 6006, ask the user for the correct URL.
4. For each component, read the source file (`.tsx`/`.jsx`) to extract concrete styling values (Tailwind classes, CSS modules, styled-components, inline styles).
5. Group components by their `category` field. Create one Figma page per top-level category (`Forms`, `Data Display`, etc.). Place each component set on the matching page.
6. Call `use_figma` per component to create the styled component set with all variants. Bind fills/spacing/radius/typography/shadows to the variable collections from step 2 where possible.
7. Verify each component looks correct; fix any styling issues with a follow-up `use_figma` call.
8. Summarize what was synced: token collections (count per category), components grouped by page, variant counts, any failures or caps.

Refer to `.claude/skills/storysync.md` for the full procedure including edge cases and visual accuracy guidelines.
