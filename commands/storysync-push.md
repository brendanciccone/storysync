---
description: Sync Storybook components and design tokens from code to Figma
argument-hint: [figma-url]
---

Push design tokens and Storybook components from this codebase into Figma.

**Figma URL:** $ARGUMENTS

If $ARGUMENTS is empty, ask the user. They'll typically paste a full Figma URL; storysync extracts the file key automatically.

## What to do

You are a thin pipeline. Your job is to run one CLI command and pipe its output to `use_figma`. Do not improvise. Do not read source files. Do not write your own Figma Plugin API code. The CLI has already done all of that for you.

1. **If Storybook isn't running**, ask the user to start it (`pnpm storybook` / `npm run storybook`) and wait for `http://localhost:6006/index.json` to return 200.

2. **Generate the plan** in one call:

   ```bash
   npx storysync push <figma-url> --storybook http://localhost:6006 --project . --json
   ```

   The output is JSON of the form:

   ```json
   {
     "fileKey": "VdqfCRrFqCrB7ii0IRb6OU",
     "scripts": [
       { "label": "Create or update 39 variables across 2 collections", "code": "(async () => { ... })();" },
       { "label": "Create Badge (18 variants) on Catalyst", "code": "(async () => { ... })();" },
       { "label": "Create Button (46 variants) on Catalyst", "code": "(async () => { ... })();" }
     ],
     "warnings": [],
     "failures": []
   }
   ```

3. **For each script in `scripts` (in order)**, call `use_figma` with the script's `code` verbatim:

   ```js
   use_figma({
     code: <script.code>,
     description: <script.label>,
     fileKey: <plan.fileKey>,
     skillNames: "figma-use",
   })
   ```

   Do not modify the code. Do not skip any script. Do not reorder them. Each script is self-contained, idempotent, and resolves its own variable references at runtime — variables created by script 1 are looked up by name in script 2+, so the order matters but no ID-passing is needed.

4. **Report** the plan's `failures` and `warnings` to the user, plus a count of scripts run successfully. Done.

## What NOT to do

- ❌ Do NOT read component source files (`*.tsx`, `*.jsx`). The CLI already parsed them via `storysync inspect`.
- ❌ Do NOT write your own Figma Plugin API code. The CLI generated the exact code with bindings already wired.
- ❌ Do NOT call `storysync map` or `storysync inspect` separately — `storysync push` does both internally.
- ❌ Do NOT skip the binding step. Bindings are baked into the generated scripts; if you don't run them you don't get a working component library.
- ❌ Do NOT "decide" which variants matter. The CLI emits them all; if a component has too many variants the user will tell you to filter via `--components`.

If the agent in this session is tempted to "be helpful" by inferring source patterns or simplifying the output, suppress the impulse. The four prior versions of this workflow all failed because the agent overrode the CLI. This one works because the CLI does the work.
