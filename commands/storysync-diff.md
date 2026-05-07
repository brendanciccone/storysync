---
description: Audit Figma file against code and report drift in either direction
argument-hint: [figma-file-key]
---

Compare the current Figma file against this codebase's design tokens and Storybook components, then report drift in either direction. Use the storysync skill at `.claude/skills/storysync.md` (Audit section).

**Figma file key:** $ARGUMENTS

If the user did not provide a file key (or `$ARGUMENTS` is empty), ask for it. The file key is the part of a Figma URL between `/design/` and the next `/`.

Workflow:

1. Read Figma variables — call `use_figma` to enumerate every variable collection and its resolved values (use `figma.variables.getLocalVariableCollectionsAsync()` and convert COLOR values to hex).
2. Read Figma components — call `use_figma` to enumerate every component set and its variant properties (use `figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] })` and read `componentPropertyDefinitions`).
3. Run `storysync tokens --json --project .` for code-side tokens.
4. Run `storysync map --storybook http://localhost:6006 --json` for code-side components.
5. Compare tokens by name within each category. Normalize before comparing: lowercase hex, convert rem→px, strip units. Match Figma collection names to code categories (Colors→colors, Border Radius→radius, etc.).
6. Compare components by name (case-insensitive). For each: missing props, extra props, missing/extra values per prop.
7. Report drift grouped by category/component:
   - `+` missing from Figma (in code, not in Figma)
   - `-` missing from code (in Figma, not in code)
   - `~` value mismatch (both exist, values differ)
8. End with a summary: N tokens matched / mismatched / missing. N components matched / mismatched. If everything matches, confirm "Figma and code are in sync."

Refer to `.claude/skills/storysync.md` Audit section for the full procedure and edge cases.
