# storysync example — Vite + React + Storybook

A minimal project for trying storysync end to end, and the fixture its behaviour is verified against.

```bash
pnpm install
pnpm storybook          # http://localhost:6006 — leave running
```

Then, from this directory in a second terminal:

```bash
npx storysync snap --storybook http://localhost:6006 --screenshots
```

## What you should see

```text
✓ Forms/Button 5/5 variants measured
! Forms/Frozen: all 3 rendered variants measured identically — the story may not
  pass args through to the component ...
```

Both lines matter.

**Button** is a normal args-driven story. Five variants get measured rather than five guessed — `--variants representative` measures each declared value once against the others' defaults, so it renders 5 times instead of the full product of 12.

**Frozen is broken on purpose.** Its story uses a custom `render` that ignores incoming args, so every variant produces an identical render. This is the one failure mode measurement cannot catch on its own: the values look real, they just all describe the default state. `snap` notices every variant measured identically and says so. Delete the `render` line in `src/Frozen.stories.tsx` and the warning goes away.

## Checking the measurements are real

```bash
jq '.components[] | select(.name=="Button") | .base.styles
    | {backgroundColor, fontSize, padding, borderRadiusUniform}' \
  .storysync/snaps/styles.json
```

Those values should match `src/Button.tsx` exactly — `#2563eb`, `12`, `4/8`, `3`. That correspondence is the whole point: they came from a browser rendering the component, not from anything reading the source.

Two more properties worth a look:

- `"backgroundColor": null` on the outline variant. Transparent is recorded as *no fill*, not as black.
- `"fontAvailable": true`. The components use Arial deliberately: it is present in browsers and in Figma without any webfont, so the example needs no network and the round-trip is genuinely one-to-one.

  Change it to a font that is not installed — `fontFamily: "Inter, sans-serif"` with nothing loading Inter — and it flips to `false` with a warning naming the family. That matters because `fontFamily` records the family the code *asked for*, not the one that rendered, so without this check a project would score full marks on a typeface the screenshots would show is different. To use a webfont for real, add `.storybook/preview-head.html` with a `<link>` to it; note that a blocking stylesheet the browser cannot reach will stall page load and time the variants out.

Run it twice and diff `styles.json`: byte-identical. The timestamp lives in `meta.json` beside it, so the measurements stay diffable in review.

## Pushing to Figma

Needs a Figma Full seat and an MCP client that can complete Figma's OAuth (Claude Code, Cursor, Codex, and others).

```bash
npx storysync setup --client claude
```

Then `/storysync-push <figma-file-key>`. The agent runs `snap`, writes the measured values into Figma, reads the created nodes' real properties back, and scores them:

```text
Fidelity: 100.0% (100/100 properties)
5 verified, 0 drifted, 0 missing from Figma, across 5 variants
```

Verify it yourself afterwards, without re-pushing:

```bash
npx storysync verify --strict-measured --strict-age
```

Nudge a corner radius in Figma and re-run — it should report exactly that property as drifted. If it still says 100%, the readback echoed the values it sent rather than reading them off the nodes, and the score means nothing.

## Requirements

Node 20+ for `snap` (Playwright needs it; every other command works on Node 18), a Chromium-based browser, and Storybook 10.1+ with `@storybook/addon-mcp`.
