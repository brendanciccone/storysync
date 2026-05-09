---
description: Sync Storybook components and design tokens from code to Figma
argument-hint: [figma-file-key-or-url]
---

Push design tokens and Storybook components from this codebase into Figma using the storysync skill at `.claude/skills/storysync.md`.

**Figma file key or URL:** $ARGUMENTS

If the user did not provide a value (or `$ARGUMENTS` is empty), ask for it. They can paste either a raw file key (e.g. `4dWAJJAwIisK5pmyOGDW7p`) or a full Figma URL (e.g. `https://www.figma.com/design/4dWAJJAwIisK5pmyOGDW7p/Untitled?node-id=0-1`); extract the key from the path between `/design/` (or `/file/`, `/board/`, `/proto/`, `/slides/`, `/make/`) and the next `/`.

Workflow:

1. Run `storysync tokens --json --project .` to extract design tokens from the project. If no tokens are found, skip token sync and continue with components.
2. For each token category, call `use_figma` to create or update a matching Figma variable collection. Convert rem values to px (1rem = 16px). Use `COLOR` for colors and `FLOAT` for numeric tokens.
3. Run `storysync map --storybook http://localhost:6006 --json` to get component variant mappings. If Storybook isn't running on port 6006, ask the user for the correct URL.
4. **REQUIRED — Get a deterministic styling spec for every component.** Run `storysync inspect <component> --json` for each one. It reads the component source (CVA, hand-rolled `cn()`/`clsx()` conditionals, or inline classNames) and emits a per-variant styling object covering: fill, text color, border + borderColor + borderStyle, borderRadius, padding, fontFamily, fontSize, fontWeight, fontStyle, lineHeight, letterSpacing, textAlign, textTransform, textDecoration, shadow, gap, layout, alignItems, justifyContent, opacity. Each value is paired with a `baseBindings` / `bindings[valueName]` map indicating which fields resolved through a project token. **Do not infer or guess any value.** If `inspect` lists an entry under `unresolved`, ask the user how to resolve it before proceeding — do not write a placeholder hex. If `inspect` is unavailable or fails, stop and report; do not fall back to reading the source manually.
5. Group components by their `category` field. Create one Figma page per top-level category (`Forms`, `Data Display`, etc.). Place each component set on the matching page.
6. Call `use_figma` per component. The instruction MUST embed the styling spec from step 4 verbatim — every variant value needs concrete fill, text color, padding, radius, border, font size, and shadow. **For every field that has a corresponding entry in `baseBindings` or `bindings[valueName]`, bind the Figma property to the named variable (`setBoundVariable` for the matching collection from step 2) instead of writing the literal value.** A field with no binding gets the literal. Skipping the bindings step is the most common cause of components rendering correctly in isolation but ignoring theme/dark-mode changes — do not skip. Before each `use_figma` call, list the variant → property → (binding | literal) chain inline so the user can audit it.
7. Verify each component looks correct; fix any styling issues with a follow-up `use_figma` call.
8. Summarize what was synced: token collections (count per category), components grouped by page, variant counts, any failures or caps.

Refer to `.claude/skills/storysync.md` for the full procedure including edge cases and visual accuracy guidelines.
