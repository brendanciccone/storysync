# Storysync example: Vite + React + Storybook

A minimal project for trying Storysync end to end, and the fixture its behavior is verified against.

```bash
pnpm install
pnpm storybook          # http://localhost:6006, leave it running
```

Then, from this directory in a second terminal:

```bash
npx storysync snap --storybook http://localhost:6006 --screenshots
```

## What you should see

```text
✓ Forms/Button 5/5 variants measured
! Forms/Frozen: all 3 rendered variants measured identically and rendered the same
  markup. The story may not pass args through to the component ...
```

Both lines matter.

**Button** is a normal args-driven story. Five variants get measured rather than five guessed: `--variants representative` measures each declared value once against the others' defaults, so it renders 5 times instead of the full product of 12.

**Frozen is broken on purpose.** Its story uses a custom `render` that ignores incoming args, so every variant produces an identical render. This is the one failure mode measurement cannot catch on its own: the values look real, they just all describe the default state. `snap` notices every variant measured identically, and that their markup was the same too, so the args never reached the component, and says so. Delete the `render` line in `src/Frozen.stories.tsx` and the warning goes away.

## Checking the measurements are real

```bash
jq '.components[] | select(.name=="Button") | .base.styles
    | {backgroundColor, fontSize, padding, borderRadiusUniform}' \
  .storysync/snaps/styles.json
```

Those values should match `src/Button.tsx` exactly: `#2563eb`, `12`, `4/8`, `3`. That correspondence is the whole point: they came from a browser rendering the component, not from anything reading the source.

Two more properties worth a look:

- `"backgroundColor": null` on the outline variant. Transparent is recorded as *no fill*, not as black.
- `"fontAvailable": true`. The components use Inter, bundled from npm via `@fontsource/inter` and imported in `.storybook/preview.ts`: nothing is fetched at runtime.

  The font choice is load-bearing, because it has to satisfy two constraints at once. The browser must actually render it, or `snap` measures a fallback. And Figma's *plugin* context, where `use_figma` writes, must have it: that context exposes only Google Fonts, so system fonts like Arial or Helvetica that a designer sees in the desktop app's picker are unavailable to the agent doing the push. The push then sets the text in a stand-in at the measured weight, Inter, or Roboto Mono for a monospace face, and names it in its summary, and `verify` reports the family as drift. Bundling a Google font from npm is the one arrangement that satisfies both with no network.

  To see the substitution detector fire, point `fontFamily` at a font that is not installed and delete the `preview.ts` imports: `fontAvailable` flips to `false` with a warning naming the family. That matters because a named font that didn't load is recorded as the family the code *asked for*, not the fallback that rendered: without this check, a project would score full marks on a typeface the screenshots would show is different.

Run it twice and diff `styles.json`: byte-identical. The timestamp lives in `meta.json` beside it, so the measurements stay diffable in review.

That checks snap's half. The readback's half, that Figma's values were read off the nodes and saved as Figma returned them, is checked at the end of [Pushing to Figma](#pushing-to-figma).

## Pushing to Figma

Needs a Figma Full seat and an MCP client that can complete Figma's OAuth (Claude Code, Cursor, Codex, and others).

```bash
npx storysync setup --client claude
```

Then `/storysync-push <figma-file-key>`. The agent runs `snap`, which measures each variant's button or box and the label inside it, then `storysync figma code`, which writes the Figma calls, sends each one unchanged, saves each response, and scores what Figma holds:

```text
Fidelity: 100.0% of elements (30 of 30 verified), 100.0% of properties (390/390)
15 verified, 0 drifted, 0 missing from Figma, across 15 variants
```

That is all 12 Button combinations (3 variants × 2 sizes × 2 disabled states) and 3 Frozen ones, two elements each: the outer element and its label. Frozen's three are identical on purpose: its story ignores its args, and the summary should say so rather than restyle it from source.

Verify it yourself afterward, without re-pushing:

```bash
npx storysync verify --plan .storysync/figma/plan.json --strict-measured --strict-age
```

To prove the score is real, recolor one Button's label in Figma by hand, then have the agent **send the read calls again** (the `read` calls in `.storysync/figma/plan.json`, each response saved over the last) and run `verify --plan` again. It should report exactly that label, by its key `#text` and its Figma node id, as drifted on its color, and nothing else. 0.4.0's score, which compared each variant's outer element alone, missed changes like this one inside it. Re-running `verify` alone is not enough: it reads the responses saved on disk and never contacts Figma, so it will report 100% whatever you changed.

`verify` also checks that each saved response is what Figma returned. The read calls compute a checksum of each entry inside Figma, under the set's id and the variant's slug, with the time Figma read it, and `verify` recomputes it, so an entry edited after Figma returned it, or copied from another variant or component, is reported as an unverified readback, scores nothing, and fails `--strict`. To see it fire, change one color in a file under `.storysync/figma/results/` by hand and run `verify --plan` again: that variant, and only that one, is flagged. The two tests catch different things, so run both. The checksum shows a response is what the read call returned, unless it was sealed deliberately with Storysync's own template, which anyone can run over values they made up; the recolored label shows the read call read the nodes.

## Requirements

Node 20+ for `snap` (Playwright needs it; every other command works on Node 18), a Chromium-based browser, and Storybook 10.1+ with `@storybook/addon-mcp`.
