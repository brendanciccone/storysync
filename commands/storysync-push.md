---
description: Sync Storybook components and design tokens from code to Figma
argument-hint: [figma-url]
---

Push design tokens and Storybook components from this codebase into Figma.

**Figma URL:** $ARGUMENTS

If $ARGUMENTS is empty, ask. Users typically paste a full Figma URL (`https://www.figma.com/design/<key>/...`); extract the file key from the path between `/design/` (or `/file/`, `/board/`, `/proto/`, `/slides/`, `/make/`) and the next `/`. A raw file key is also accepted as-is.

## Two non-negotiable rules — read before doing anything

**Rule 1 — `inspect` is the only source of truth for component styling.** Before writing any styled component to Figma, you MUST call `npx storysync inspect <Component> --json` for that component. Do not read source files yourself. Do not derive Tailwind class meaning by inspection. Do not skip `inspect` because the source "looks simple". If you write a component to Figma without first running `inspect` for it, the run is invalid and must be redone.

**Rule 2 — bindings are not labels; they change behavior.** When `inspect` returns `baseBindings.<field>` or `bindings[value].<field>`, you MUST bind the Figma property to that variable using `setBoundVariable`. The literal value in the styling object is for your reference only — it tells you what the variable currently resolves to. Writing the literal directly hardcodes the component forever: it ignores theme switches, dark mode, and any future token edit. The single most common failure mode for this command is the agent writing literal hex/px and reporting the run as successful. Do not be that agent.

If you create variable collections in Figma but don't bind any components to them, you have produced the worst-of-both-worlds result: dead variables plus hardcoded components. Either commit to bindings, or skip the variable collection step entirely. They're a pair.

## Workflow

1. **Tokens.** Run `npx storysync tokens --json --project .`. If no tokens, skip to step 3.

2. **Variable collections.** For each token category, call `use_figma` to create or update a matching Figma variable collection. Convert rem→px (1rem = 16px). Use `COLOR` for colors, `FLOAT` for numeric tokens.

3. **Map.** Run `npx storysync map --storybook http://localhost:6006 --json`. If Storybook isn't running, ask the user for the correct URL or to start it.

4. **Inspect each component (required, see Rule 1).** For every component returned by `map`, run `npx storysync inspect <ComponentName> --json` and parse the result. The output covers: fill, text, border + borderColor + borderStyle, borderRadius, padding, fontFamily, fontSize, fontWeight, fontStyle, lineHeight, letterSpacing, textAlign, textTransform, textDecoration, shadow, gap, layout, alignItems, justifyContent, opacity — plus `baseBindings` and `bindings[valueName]`. If `unresolved` is non-empty, ask the user how to map each entry before proceeding — do not write a placeholder. If `inspect` errors, stop and report; do not switch to manual source reading.

5. **Organize.** Group components by their `category` field. Create one Figma page per top-level category. Place each component set on the matching page.

6. **Write each component (required, see Rule 2).** Call `use_figma` per component. For each field on each variant value:
   - If `bindings[value].<field>` exists → call `setBoundVariable` with the named variable from step 2. Do not also write the literal.
   - Otherwise → write the literal value from `values[value].<field>`.

   Before each `use_figma` call, output a table or list showing the variant → property → (binding `colors/foreground` | literal `#3b82f6`) chain so the user can audit which fields bound and which didn't.

7. **Verify.** Eyeball each component; fix any styling issues with a follow-up `use_figma`.

8. **Self-audit before reporting complete.** Walk back through your transcript and confirm:
   - Every component you wrote to Figma had a corresponding `storysync inspect` call earlier.
   - Every `bindings.<field>` entry from `inspect` resulted in a `setBoundVariable` call (not a literal write).
   - You did NOT create variable collections that no component binds to.

   If any of those failed, redo the affected components before producing the summary. If you reach the summary and have to write "variable binding skipped", you violated Rule 2 — go back.

9. **Summary.** Token collections, components grouped by page, variant counts, bindings count (e.g. "47 of 52 fields bound to variables; 5 unbound because no matching token"), failures, caps.

Refer to `.claude/skills/storysync.md` for edge cases.
