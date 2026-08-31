---
description: Sync Storybook components and design tokens from code to Figma
argument-hint: "[figma-file-key]"
---

Push design tokens and Storybook components from this codebase into Figma using the storysync skill at `.claude/skills/storysync.md`.

**Figma file key:** $ARGUMENTS

If the user did not provide a file key (or `$ARGUMENTS` is empty), ask for it. The file key is the part of a Figma URL between `/design/` and the next `/`.

Workflow:

1. Run `storysync tokens --json --project .` to extract design tokens from the project. If no tokens are found, skip token sync and continue with components.
2. For each token category, call `use_figma` to create or update a matching Figma variable collection. Convert rem values to px (1rem = 16px). Use `COLOR` for colors and `FLOAT` for numeric tokens.
3. Run `storysync map --storybook http://localhost:6006 --json` to get component variant mappings. If Storybook isn't running on port 6006, ask the user for the correct URL.
4. **REQUIRED — Measure the styling, don't infer it.** Run `storysync snap --storybook http://localhost:6006 --json` now, in this session. It renders every variant in a real browser and reports the computed styles: fill, text colour, border, radius, padding, font, shadow, and auto-layout. Output is a base variant plus per-variant deltas; a variant's full styles are the base with its `delta` applied. Do not reuse an earlier `styles.json` — it may describe code that has since changed. Only for variants whose `status` is not `"ok"`, fall back to reading source, and resolve tokens via `storysync tokens --json` rather than a memorised class-to-value table.
5. Group components by their `category` field. Create one Figma page per top-level category (`Forms`, `Data Display`, etc.). Place each component set on the matching page.
6. Call `use_figma` per component, embedding the measured values from step 4. Update an existing component set of the same name rather than creating a duplicate. Bind fills/spacing/radius/typography/shadows to the variable collections from step 2 where possible. Set `strokeAlign` from the measured `boxSizing` (`content-box` → `OUTSIDE`, else `INSIDE`), give each variant an x/y and grow the set to fit them, then assert no two variants' bounding boxes intersect and the set contains them all (geometry comparison only catches variants clipped by an undersized frame, not same-sized ones stacked inside a big enough one), and end the plugin code by reading the created nodes' actual properties back and returning them as JSON — read them off the nodes, don't echo what you sent, and take width/height from `absoluteRenderBounds` so an OUTSIDE stroke is included.
7. Write those readbacks to `.storysync/figma-readback.json` keyed by component title and snap variant slug, each carrying `"source": "measured"` or `"inferred"`. Then run `storysync verify --strict-age`. Fix what it flags by node ID and re-run, stopping after two rounds.
8. Summarize what was synced: token collections (count per category), components grouped by page, variant counts, the fidelity score, measured versus inferred counts, any story that didn't pass its args through, any component where `fontAvailable` was `false` (the measurement describes a substituted typeface, and Figma will need that font installed — storysync cannot install it), and any failures or caps.

Refer to `.claude/skills/storysync.md` for the full procedure including edge cases and visual accuracy guidelines.
