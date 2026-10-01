---
description: Audit Figma file against code and report drift in either direction
argument-hint: "[figma-file-key]"
---

Compare the current Figma file against this codebase's design tokens and Storybook components, then report drift in either direction. Use the storysync skill at `.claude/skills/storysync/SKILL.md` (Audit section).

**Figma file key:** $ARGUMENTS

If the user did not provide a file key (or `$ARGUMENTS` is empty), ask for it. The file key is the part of a Figma URL between `/design/` and the next `/`.

Workflow:

1. Read Figma variables — call `use_figma` to enumerate every variable collection and its resolved values (use `figma.variables.getLocalVariableCollectionsAsync()` and convert COLOR values to hex). `use_figma` returns at most 20kb per call, which a full palette passes, so read them a slice per call with the skill's template, from the `next` each call returns until it is `null`.
2. Read Figma components — call `use_figma` to enumerate every component set and its variant properties, a page at a time: `use_figma` loads pages as it switches to them and does not support `figma.loadAllPagesAsync()`, so a search from `figma.root` sees only the pages already loaded and misses the sets on the rest. List the pages (`figma.root.children`), then make one call per page that switches to it with `figma.setCurrentPageAsync`, uses `page.findAllWithCriteria({ types: ['COMPONENT_SET'] })` and reads `componentPropertyDefinitions`, a slice per call as in step 1.
3. Run `npx storysync tokens --json --project .` for code-side tokens.
4. Run `npx storysync map --storybook http://localhost:6006 --json` for code-side components.
5. Compare tokens by name within each category. Normalize before comparing: lowercase hex, convert rem→px, strip units. Match Figma collection names to code categories (Colors→colors, Border Radius→radius, etc.).
6. Compare components by name (case-insensitive). If two code components share a name, report them as ambiguous rather than comparing only one. For each: missing props, extra props, missing/extra values per prop.
7. Report drift grouped by category/component:
   - `+` missing from Figma (in code, not in Figma)
   - `-` missing from code (in Figma, not in code)
   - `~` value mismatch (both exist, values differ)
8. End with a summary: N tokens matched / mismatched / missing. N components matched / mismatched. If everything matches, confirm "Figma and code are in sync."

Refer to `.claude/skills/storysync/SKILL.md` Audit section for the full procedure and edge cases.
