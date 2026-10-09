# Package T: where it departs from the element-tree spec

Section numbers refer to `design/ELEMENT-TREE-SPEC.md`. Packages A, B, C and D
build against what `cli/tree-types.ts` does, so each departure is listed here
rather than left for them to find.

## Contract (`cli/tree-types.ts`)

1. **Exports beyond section 7.1.**
   - `Flow`. Section 7.1 uses it but never defines it. T defines it as
     `{ axis, reverse, content, inflow, main, cross }`.
   - `FigmaPlan` and `PlanCall`, copied verbatim from section 8.1.
   - `ROOT_FIELDS` and `rootWithStyles(root, styles)`. flowOf needs the root's
     border, which lives in its styles, so one helper maps it for both B and C.
2. **flowOf takes a third argument, `snap?: Pick<Flow, "axis" | "inflow">`.**
   This is the Flow that snap's boxes gave for the same parent. C calls
   `flowOf(figmaParent, figmaKids, snapFlow)`, which uses snap's order and
   snap's axis in the Figma world:
   - A tree stores siblings in paint order, so a `relative` child (Attachment's
     media tile) comes after siblings it precedes in the flow.
   - Whether a block's children stack is read from the boxes. A Figma child
     that sits 3px into the one above must still be scored along y.

   Calls with two arguments are unaffected.
3. **flowOf follows section 10.4 and CSS on three points:**
   - Centered content is anchored by Σ sizes + CSS gaps, not by the span the
     children cover.
   - In a reversed flex, `start`, `end`, `left` and `right` keep their sides of
     the axis, assuming left-to-right text since snap records no direction.
     `flex-start` and `flex-end` reverse with the flow.
   - Flow along y applies only to block containers (`block`, `flow-root`,
     `list-item`, `inline-block`) and to grids with one column. `inline`
     content and table cells have no flow.
4. **ROOT_FIELDS is wider than section 7.2.** It adds `cp`, `svg`, `shapes`,
   `img`, `raster` and `approx`, because a root can be an `<svg>` (shadcn's
   Spinner) or an `<img>`. A root never collapses into a text leaf: a
   component's root is a frame in Figma, so its text is a `#text` child. A
   must not collapse the root.
5. **Nulls.**
   - A top-level null in a node means the field is absent. expandTree,
     diffTree and treeDigest all read it that way, so a base node written with
     `bg: null` still round-trips.
   - A delta's null removes a field. A null `set` entry is refused.
   - `TreeDelta.set` is typed `Partial<TreeNode>`, so most fields cannot be
     null in TypeScript. The type is kept verbatim. The fix would be
     `{ [K in keyof TreeNode]?: TreeNode[K] | null }`, with nulls banned in
     whole nodes.
6. **expandTree refuses more than section 7.1 lists:**
   - nodes that are not a preorder tree (the root `""` must come first, and
     every other node after its parent);
   - a `set` entry that is not an object;
   - a field named `__proto__`, `constructor` or `prototype`.
7. **treeDigest leaves the root's paint out**, because it lives in styles. To
   cover it, the build and verify both digest
   `[rootWithStyles(nodes[0], styles), ...nodes.slice(1)]`. Otherwise a re-snap
   that changes only the root's background raises no
   `built_from_other_measurement` caveat.
8. **ImageAsset.file is relative to the directory that holds styles.json**,
   like `screenshot`: `assets/<sha12>-<crop4>.jpg`.
   - The `img:` prefix is dropped from the file name, because Windows file
     names cannot contain a colon.
   - In the fixtures, the crop part is fnv1a32 of `"x,y,w,h"`. A defines the
     real one.

## Capture rules the fixtures follow (package A)

9. **Text-leaf collapse.** A clip that only cuts text off with an ellipsis
   (overflow not visible, `nowrap`, `text-overflow: ellipsis`) does not stop
   the collapse. Section 6.2 says "no clip". A's own acceptance (the
   Attachment title has `el: 1` and a box narrower than its ink) needs the
   collapse.
10. **Avatar's root does not clip.** A's acceptance item "the root has clip" is
    wrong. In all three prototype captures, the Base UI avatar root's overflow
    is visible, and the `img` clips itself at radius 16.
11. **Uniform sides collapse to one value.** InputOTP's first slot has
    `bd.w: 1`, not `[1, 1, 1, 1]`.
12. **Section 6.3 captures facts section 7.1 cannot store:**
    - `data-variant`, `data-size`, `data-state` and `data-orientation`;
    - grid-row and grid-column;
    - background-size, -position and -repeat;
    - margins.

    Either add fields with a T-reviewed patch, or drop them from section 6.3.

## Fixtures (`cli/__tests__/fixtures/tree/`)

The fixtures come from the shadcn registry (MIT) prototypes, converted with
`scratchpad/work/tree-T-tools/convert-fixtures.mjs`, which is not committed and
gives the same output on every run.

13. **What no fixture covers:**
    - `cls`: no prototype captured class names.
    - a structural delta (`keys`), truncated trees, raster nodes, pseudo
      stand-ins and inputs.

    B and C need synthetic cases for these.
14. **Icon names.** An icon's `el` carries its lucide class (`svg.lucide-mail`)
    when the proof prototype named the icon with the same shapes. Toggle's icon
    was never named, so its `el` is `svg`.
15. **The Avatar thumbnail is a generated stand-in.** The story's photo is a
    person's GitHub avatar, which the registry's license does not cover. Its
    id (the real source's sha256), natural size, crop and thumbnail size are
    real.
16. **example-button comes from a 0.3.0 snap.** Its label box is derived from
    the root's content box, not captured.
17. **button-icon is a subset of the story.** It keeps 4 of 6 variants and 3 of
    8 sizes, with every combination present. `link` at `xs` and at `sm` are
    `args_hidden`.
18. **Fixtures say `storysyncVersion: "0.4.0"`.** `treeVersion` marks the tree
    format.

## Spec problems for the owner and the other packages

19. **Section 8.4.7's sizing rule versus Figma (B).** The rule makes a frame
    HUG when Σ children equals its measured size, and makes a child FILL when
    it grows. The figma-use skill documents that Figma collapses a FILL child of
    a HUG parent, compresses a growing one, and ignores FILL on a
    WIDTH_AND_HEIGHT text. Sidebar's `sidebar-inner` (16 + 688 + 16) hits this.
    - The mock refuses all three with a `mock-figma:` error.
    - Proposed rule: a frame is FIXED on its main axis when any in-flow child
      grows, and a text is set to HEIGHT before FILL.
    - Filling across a hugging parent stretches in the mock by default. Pass
      `fillAcrossHug: "refuse"` until spike item 11 settles it.
20. **B's acceptance conflicts with section 8.4.** It expects 0 fallbacks for
    Attachment, horizontal and vertical. But the Attachment root has
    `flex-wrap: wrap` (`L.wrap: 1`), and its `relative` media tile paints after
    the content it precedes, and section 8.4 sends both cases to layoutMode
    NONE. B either treats a wrap that fits on one line as nowrap and takes order
    from the boxes, or the acceptance changes.
21. **The checksum move breaks `pnpm acceptance` (D).** Section 7.1 moves
    canonicalJson into `checksum.ts`, but one verify mutant in
    `scripts/acceptance.mjs` still rewrites `verify.js`. On tree/T,
    acceptance passes 80 of 81 checks, failing with "the mutation no longer
    matches verify".
    - Branch `tree/T-acceptance` holds the fix: one commit that lets mutantCli
      mutate `checksum.js`. With it, acceptance passes 81 of 81 against
      examples/storybook-vite.
    - The fix is in D's file, so it lands with T or with D0, before step 2's
      0.4.1 gate.
22. **The spike is bigger than section 14 says** ("one call of about 4k").
    `spikes/figma-probe.js` is about 15k characters:
    - It runs as two calls plus upload_assets; for the second call, its header
      names the one line to change.
    - It adds item 11 (sizing), a defaults check, and clone placement for a
      nested child and a variant.

## What the mock assumes until the spike runs

Each assumption below is an option or a spike item, and B and C rerun their
tests on the spike's answers:

- `clone()` lands on the current page, as the typings say.
- Frames and components start with a white fill.
- `resize()` on a hugging text switches it to NONE.
- AUTO line height is 1.21em.
- An imported SVG's `<g>` is flattened.
- A frame's own stroke insets its children only when `strokesIncludedInLayout`
  is set: by its full width when INSIDE, half when CENTER, none when OUTSIDE.
- SVG strokes scale with the import size (option `svgStrokeScales`).
- A child filling across a hugging parent stretches (option `fillAcrossHug`).
