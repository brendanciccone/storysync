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

# Package A: where snap's capture departs from the spec

Package A builds the tree in `cli/snap-tree.ts`, `cli/snap-assets.ts`,
`cli/snap-browser.ts` and `cli/snap.ts`. Its notes are numbered A1 on, so they
don't collide with the other packages'. "Spec problem" marks a rule the spec
gets wrong, for the owner and for B and C.

## Arguments and plans (sections 5.1 to 5.3)

A1. **5.1 keeps r3/args's names**, as the owner decided:
   - `arg_rejected` stands in for `args_dropped`;
   - `rejectedArgs`, `appliedVia: "preview"` and `argsChecked` stand in for
     ArgReport and `via: "channel"`;
   - there is no `args_hidden`. A value an argTypes `if` hides is measured
     through the preview with the `if` lifted, and recorded as such.

   With `channelArgs: false`, a value the story refuses gives `arg_rejected`
   (`args_unsupported` for a value the URL can't carry), and the error names
   `--no-channel-args`.
A2. **5.2's options supplement can restart the plan.**
   - A new axis renames every combination, so the plan starts again and
     measures the base once more: one page load more than the spec says.
   - Everything measured under the old plan is dropped, a variant that failed
     before its args were read included. Kept, it had a combination without
     the new property.
   - Values the options add to a plan already at `--max-combinations` restart
     it too, with the wider plan's capped set. Appended, they were cut off with
     the tail and never measured.
   - `null` options are left out: Storybook lists null for cva unions.
A3. **5.3's first bullet and 5.5's root `truncate: true`** were already covered
   by r3/small: the behavior-only warning is keyed on the markup, and
   `text.layout.truncation` records truncation. No new field. In a tree snap,
   the behavior-only warning names a hover or focus state, or an animation, as
   what snap doesn't measure, not a child element.

## Capture (section 6)

A4. **6.1's climb** is recorded as `CaptureResult.climbedFrom` and a component
   warning, not as MeasurementNote kind "climbed", which would break verify.ts's
   caveat typing (C's file). It runs in tree mode only, so `--root-only` stays
   byte-identical to 0.4.0.
A5. **6.2's pruning, collapse and limits run in Node**, not in the page. The
   page drops only `display: none`, opacity 0 and NON_RENDERED tags, and stops
   reading at 4000 elements or 64 levels. A cut there gives
   `truncated.at = "<parent>/…"`.
A6. **Wrapper collapse** also needs opacity 1 and no blend mode, filter,
   backdrop filter, transform, clip path, isolation or hidden visibility, so a
   collapse never drops an effect. `abs` is set when the child or any wrapper
   is out of flow.
A7. **Spec problem: a collapsed child's `S`.** Section 6.2 takes the child's own
   S, and a wrapper's only when the child has none. But the outermost wrapper
   is the element its parent laid out; the child's grow or shrink worked inside
   it. A button's `shrink-0` under a wrapper's `flex-1` came out as
   `{shrink: 0}`, losing the grow. snap takes S from the outermost wrapper when
   there is one. `z` comes from the child when it is positioned or has a
   z-index, else from the outermost wrapper.
A8. **Spec problem: text leaves in flex and grid containers.** An element whose
   one text a flex or grid layout moves off the start (centered, at the end,
   spaced around) stays a frame with its layout and a `#text` line box. As a
   text leaf the element's size, the centering survived only in `ink`, and B
   would build it left-aligned. Stretched, at the start or on the baseline, it
   is still a text leaf. As T note 9 says, a clip that only cuts the text off
   with an ellipsis doesn't stop a collapse.
A9. **Not stored**, as T note 12 says, since the contract has no fields: the
   `data-variant`, `data-size`, `data-state` and `data-orientation` attributes,
   grid-row and grid-column, margins, and background-size, -position and
   -repeat. The background properties are read only to place a url() picture.
A10. **Class evidence.**
    - A token's variant prefixes are cut at the last `:` outside brackets, so
      `data-[state=checked]:bg-primary` counts, which 6.3's regex misses.
    - Unprefixed tokens come first, capped at 8, then sorted.
    - T and V nodes also get the text color class of the nearest element around
      them, a collapsed wrapper included, so `text-card-foreground` reaches the
      Card title, as B's binding example needs.
    - State-prefixed tokens (`hover:`, `data-[state=open]:`) and `text-*` sizes
      can appear, so B keeps filtering candidates by hex (8.9).
A11. **Spec problem: the line box of a wrapped run.** Section 6.4's
    `y = inkTop − (lh − inkH/n)/2` is wrong for n > 1. The union of a run's
    line rects is (n − 1)·lh plus one line's glyphs, so the formula put every
    wrapped run (lh − g)/2·(1 − 1/n) too low: 1.5px for four 20px lines, 5px for
    seven 28px lines. snap takes the glyph height g from the first line's rect,
    `y = inkTop − (lh − g)/2`. Single-line runs are unchanged.
A12. **`pre-line`** keeps its line breaks and collapses spaces. Only `pre`,
    `pre-wrap` and `break-spaces` keep text as written (6.4 says `pre*`).
A13. **Pseudo-elements.**
    - One with text and no paint is a T node; one with both is an F node with
      approx `pseudo-text`.
    - An absolute one's box adds its transform's translation. Section 6.9's
      "translate-only needs nothing" holds only for boxes from
      getBoundingClientRect, and a pseudo-element has none:
      `after:-translate-x-1/2` was stored 5px off.
    - A rotation or scale records `tf` and approx `transform`, as on an element.
A14. **approx values used:** `containing-block`, `pseudo-stand-in`,
    `pseudo-text`, `transform`, `svg:<tags>` (with `paint-server`, `clip-path`,
    `mask` and `filter` among the tags), `raster-unavailable`,
    `image-unavailable` and `background-image`.
A15. **SVG.**
    - `opacity`, `vector-effect` and effects never move to the root; they don't
      inherit.
    - A `<g>` is kept with its transform, opacity, clip path, mask or filter, and
      flattened when it has none. The page reads those four off each group,
      since its shapes' computed style can't show them.
    - Shapes carry `stroke-dasharray`, `stroke-dashoffset` and `vector-effect`
      when they aren't the default. `url()` paint is kept.
    - Only painted basic shapes outside definitions count toward `shapes`.
A16. **Spec problem: url() backgrounds.** Section 6.7 says anything that isn't
    a plain picture becomes a raster, but a raster of a box with children bakes
    them in. snap:
    - a box holding nothing else is an image when its background is one url()
      layer drawn once, or covering the box (Tailwind's `bg-cover` without
      `bg-no-repeat`), and a raster of the box otherwise;
    - a box with children stays a frame with approx `background-image`, its
      url() layers left out of `bgi`;
    - an explicit `background-size` draws the image at that size in
      `imageCrop`;
    - layers and urls are read with a quote-aware scan, so an inline SVG's
      `rgb(255,0,0)` doesn't split one.
A17. **Image crops and fallbacks.**
    - The crop key is the source rect `x,y,w,h`, as T's fixtures have it, plus
      `@<dst>` when letterboxed and `~<aspect>` for a fill stretched to another
      shape.
    - A raster's id hashes the screenshot with the key `raster:...`.
    - An image whose bytes can't be read, or whose reading throws, is a raster.
      A `data:` URL is percent-decoded as browsers do, so a lone `%` is itself.
    - A thumbnail that can't be drawn turns its nodes into F nodes with approx
      `image-unavailable` in every variant, and a warning says so.
A18. **Spec problem: image file names** (7.1 and T note 8). They are
    `assets/<sha12>-<crop4>-<fnv8>.<jpg|png>`, the last part the FNV of the
    thumbnail's own bytes. An id leaves out size, so one photo with one crop is
    one id in every component, but each component draws its thumbnail at its
    own largest box. Named by the id alone, Empty's 96px shadcn.png replaced
    the Avatar's 80px one, whose record then named bytes no longer on disk, and
    a `--merge` run could do the same. Consumers read `ImageAsset.file`, so T's
    fixtures' names still load.
A19. **Form controls.** A native `<select>` is a raster, as a native checkbox
    is. With `appearance: none` (shadcn's NativeSelect), its chosen option's
    label is a `#value` text. A restyled checkbox, radio, range, color or file
    input gets no `#value`: its value, `on`, is never drawn. Only text with a
    line on screen counts as drawing, so an `<option>` is never a node.
A20. **Spec problem: stacking contexts in paint order.** Section 6.9 leaves them
    out. An element that isn't positioned but has an opacity below 1, a
    transform, filter, backdrop filter, blend mode, clip path or
    `isolation: isolate`, and a flex or grid item with z-index 0, are ordered
    with the positioned elements of z-index auto or 0, as Chrome paints them.
    `will-change`, `contain` and masks aren't read.
A21. **Rotate or scale on an element:** the box is the element's offset size,
    centered where it drew.
A22. **Rounding:** root-relative boxes are rounded to 0.01 and then made
    parent-relative, so absoluteBoxes gives them back exactly.

## styles.json and the run (section 7)

A23. **7.2's `component.capture: "root"` is never written.** `--root-only`
    writes no tree fields at all (7.5), only each variant's `innerElements`. C
    should key the root-only caveat on the absence of `tree`.
A24. **`tree.truncated` is per component**, as the contract has it: the
    variant with the most nodes.
A25. **meta.json:** `platform` is `${process.platform}-${process.arch}`, and
    `browser` is `browser.version()`.
A26. **Tree capture is runSnap's default**, and `rootOnly` opts out, so the CLI
    snaps trees before D wires its flags.
A27. **`--stories` keys** are a component's ID, title or unique name. A name
    several components share is accepted only when the story ID picks one. An
    unknown key, or a story that isn't the component's, is refused before the
    browser starts.
A28. **Thumbnail encoding** is chosen in one place: `THUMBNAIL_ENCODING` and
    `THUMBNAIL_MAX_SIDE` in `snap-assets.ts` (JPEG at quality 0.85 where every
    pixel is opaque, PNG where any isn't, twice the box, at most 1024px). PNG
    throughout is `opaque: "image/png"`, should the spike argue for it.

## Package A's acceptance (section 15)

A29. **"Avatar: the root has clip" is wrong** (T note 10). The test asserts the
    opposite, and that the image clips itself.
A30. **No 36-row classifyArgs table test.** r3/args's findRejectedArgs and
    runSnap tests cover Badge ghost and link, and the default combination.
    Button link at each size is measured through the preview, not
    `args_hidden` (A1).
A31. **T's fixtures are not regenerated**: the Avatar photo isn't covered by the
    registry's license. A test builds each of T's ten stories from snap's own
    raw captures (`fixtures/raw`) and compares them. They match except for what
    the prototypes didn't capture: `cls`, `S.basis`, the Toggle icon's lucide
    `el`, and the Avatar image id, which needs the photo's bytes.
