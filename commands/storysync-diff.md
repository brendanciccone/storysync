---
description: Audit Figma file against code and report drift in either direction
argument-hint: [figma-file-key-or-url]
---

Compare the current Figma file against this codebase's design tokens and Storybook components, then report drift in either direction. Use the storysync skill at `.claude/skills/storysync.md` (Audit section).

**This is a read-only audit.** Do not call any Figma write tool — no `set_variable`, no `create_variable`, no `set_styles`, no `create_component`, no `set_node_properties`, no `replace_image`, no node mutation of any kind. If you find drift, report it. Do not fix it. The user will review the report and decide what to repair separately.

**Figma file key or URL:** $ARGUMENTS

If the user did not provide a value (or `$ARGUMENTS` is empty), ask for it. They can paste either a raw file key (e.g. `4dWAJJAwIisK5pmyOGDW7p`) or a full Figma URL (e.g. `https://www.figma.com/design/4dWAJJAwIisK5pmyOGDW7p/Untitled?node-id=0-1`); extract the key from the path between `/design/` (or `/file/`, `/board/`, `/proto/`, `/slides/`, `/make/`) and the next `/`.

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
