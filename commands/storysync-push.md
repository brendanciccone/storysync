---
description: Sync Storybook components and design tokens from code to Figma
argument-hint: [figma-url]
---

Push design tokens and Storybook components from this codebase into Figma.

**Figma URL:** $ARGUMENTS

If $ARGUMENTS is empty, ask. Users typically paste a full Figma URL (`https://www.figma.com/design/<key>/...`); extract the file key from the path between `/design/` (or `/file/`, `/board/`, `/proto/`, `/slides/`, `/make/`) and the next `/`. A raw file key is also accepted as-is.

## The single non-negotiable rule

**`storysync map --inspect --json` is the only source of truth for component data.** Run it once, parse the JSON, and use it verbatim. Each component in the response includes `variantProperties` (the Figma variant matrix) and `styling` (`base`, `baseBindings`, `variants[]` with per-value styling and `bindings`). Do NOT read source files yourself. Do NOT derive Tailwind class meaning by inspection. Do NOT call `use_figma` to write a styled component without first checking `styling` for that component in the map output.

When `bindings.<field>` exists for a field, you MUST bind the Figma property to that variable using `setBoundVariable`. The literal value in the styling object is for your reference only — it tells you what the variable currently resolves to. Writing the literal hardcodes the component forever: it ignores theme switches, dark mode, and any future token edit. **If you create variable collections in Figma but don't bind any components to them, you produced dead variables plus hardcoded components — the worst of both worlds.** Either commit to bindings or skip the variable collection step entirely; they're a pair.

## Workflow

1. **Tokens.** Run `npx storysync tokens --json --project .`. If no tokens, skip step 2.

2. **Variable collections.** For each token category, call `use_figma` to create or update a matching Figma variable collection. Convert rem→px (1rem = 16px). Use `COLOR` for colors, `FLOAT` for numeric tokens. Remember the collection + variable names — you'll bind to them in step 4.

3. **Map + inspect (single call).** Run:

   ```bash
   npx storysync map --storybook http://localhost:6006 --inspect --json --project .
   ```

   If Storybook isn't running, ask the user for the correct URL or to start it. The output looks like:

   ```json
   {
     "components": [
       {
         "name": "Button",
         "title": "Forms/Button",
         "category": "Forms",
         "variantProperties": [{ "name": "variant", "type": "VARIANT", "values": ["primary", "ghost"], "defaultValue": "primary" }],
         "combinations": 2,
         "styling": {
           "base": { "borderRadius": "6px", "fontWeight": "500" },
           "baseBindings": {},
           "variants": [
             {
               "name": "variant",
               "defaultValue": "primary",
               "values": {
                 "primary": { "fill": "#2563eb", "text": "#ffffff" },
                 "ghost":   { "fill": "transparent", "text": "hsl(224 71% 4%)" }
               },
               "bindings": {
                 "primary": {},
                 "ghost":   { "text": { "token": "foreground", "collection": "colors" } }
               }
             }
           ],
           "unresolved": [],
           "warnings": []
         }
       }
     ]
   }
   ```

   If `styling.unresolved` is non-empty for a component, ask the user how to map each entry before writing that component. If `styling` is null (source file not found), ask the user for the path or skip that component.

4. **Organize + write each component.** Group components by `category`, create one Figma page per top-level category, place component sets on the matching page. Then for each component, call `use_figma` once. The Figma Plugin API code MUST:

   - Set every property on every variant value from `styling.variants[].values[name]`.
   - For each field where `styling.variants[].bindings[name].<field>` exists → call `setBoundVariable` referencing the variable created in step 2 (match by collection + token name). Do not also write the literal.
   - For each field with no binding → write the literal from `styling.variants[].values[name].<field>`.
   - Same rule for the base styling: `styling.baseBindings.<field>` → bind, otherwise write `styling.base.<field>` literal.

   Before each `use_figma` call, output a short markdown table with one row per (variant value × property) showing whether the value will be **bound** (and to what) or written as a **literal**. This audit row is mandatory; if you can't produce it, you don't have the data and should re-run step 3.

5. **Verify visually.** Eyeball each component; fix any issues with a follow-up `use_figma`.

6. **Self-audit before reporting complete.** Walk back through your transcript and confirm:
   - You ran `storysync map --inspect` exactly once and used its `styling` field for every component.
   - Every `bindings.<field>` entry from the map result resulted in a `setBoundVariable` call (not a literal write).
   - You did NOT create variable collections that no component binds to.
   - You did NOT read component source files yourself (only the map output is allowed).

   If any of those failed, redo the affected components before producing the summary. If you're about to write "variable binding skipped" or "wired bindings later", you violated the rule above — go back.

7. **Summary.** Token collections, components grouped by page/category, variant counts, **bindings count** (e.g. "47 of 52 fields bound to variables; 5 unbound because no matching token"), failures, caps.

Refer to `.claude/skills/storysync.md` for edge cases.
