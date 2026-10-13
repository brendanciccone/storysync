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
    - Proposed rule: a frame is FIXED on its main axis when any in-flow child
      grows, and a text is set to HEIGHT before FILL.
    - **Settled by the spike (item 11).** Figma collapses none of the three.
      A child filling or growing along a hugging column keeps its size, and
      the column hugs it with the rest (16 + 688 + 16 = 720). A child filling
      across a hugging column takes its widest sibling's width (120), or
      keeps its own alone. FILL on a hugging label turns it to HEIGHT, at the
      row's width in a fixed row and at its own in a hugging one. The mock
      does all three as Figma did. It still refuses what the spike didn't
      try: layoutGrow alone on a hugging text, or FILL on a text's height.
      The proposed rule stands, since in CSS a grower takes the room its
      parent leaves rather than growing the parent.
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
    - **Resolved by 095c5b0**, merged with tree/T-acceptance in ae31808:
      mutantCli takes the file to mutate, and the canonicalJson mutant
      rewrites `checksum.js`.
22. **The spike is bigger than section 14 says** ("one call of about 4k").
    `spikes/figma-probe.js` is about 15k characters:
    - It runs as two calls plus upload_assets; for the second call, its header
      names the one line to change.
    - It adds item 11 (sizing), a defaults check, and clone placement for a
      nested child and a variant.

    It ran live as written on 2026-10-08, in a scratch file, with the owner's
    go-ahead. Its raw results are `cli/__tests__/fixtures/figma-spike.json`:
    the probe call, the upload_assets POST response and the image call, each
    unchanged. The live image result also names the node that reused the
    hash (`reuseNodeId`), which the probe as committed doesn't return.

## What the mock takes from the spike

The mock first assumed the answers below. The spike measured each in Figma
(fixtures/figma-spike.json), and the mock now does what Figma did. A test in
`mock-figma.test.ts` replays the probe in the mock and holds every item to
the live result, the times aside.

- `clone()`: assumed to land on the current page. Figma puts a copy of a
  page's own node beside it, and a copy of anything nested, a variant
  included, on the page. The mock does both, so a template must put a copy
  where it belongs itself. The copy and its children keep their plugin data.
- New frames and components: assumed to have a white fill. Each has one fill;
  the probe counted it and didn't read its color, so the mock keeps white.
- `resize()` on a hugging text: assumed to switch it to NONE. It does (60 by
  20, NONE).
- AUTO line height: assumed 1.21em. Figma sets it to a whole pixel, 15 at
  12px and 17 at 14px, which the mock now does (1.21em, rounded).
- An imported SVG: assumed to be a frame of flattened shapes. It is a frame
  that clips, with a fill, whose `<rect>` comes in as a VECTOR and whose
  `<g>` comes in as a GROUP. The mock does all of these; a group's shapes
  keep the frame's coordinates, as Figma's do. Circles and ellipses the
  probe didn't import, and the mock still makes ELLIPSEs of them.
- A frame's own stroke, included in layout: assumed to inset its children by
  its full width when INSIDE, half when CENTER and none when OUTSIDE. Only
  INSIDE takes room: a 2px INSIDE stroke grew a hugging row from 44x20 to
  48x24 and moved its children by 2, and CENTER and OUTSIDE left both alone.
- SVG strokes: assumed to scale with the import's size (option
  `svgStrokeScales`). They do: lucide's 2 at 24 came in 1.33 wide at 16.
- A child filling across a hugging parent: assumed to stretch (option
  `fillAcrossHug`). It does, to the widest child that doesn't fill.
- A child filling or growing along a hugging parent, and FILL on a hugging
  label: refused by the mock (item 19). Now done as Figma did them.
- Also confirmed as the mock had them: a shadow's spread is kept on a frame,
  clipped or not; ENDING with maxLines is taken; per-side stroke weights read
  `mixed`; an ABSOLUTE child keeps its x and y; findAllWithCriteria finds by
  shared plugin data keys and by namespace alone; blend modes and dashes read
  back as set; upload_assets keeps the bytes and hashes them by SHA-1; a frame
  strokes INSIDE and a vector CENTER; a frame given a layoutMode hugs along it
  and is fixed across; and a new text is WIDTH_AND_HEIGHT.

The options that give the other answers stay, defaulting to the spike's, so
the packages still test their fallbacks.

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
A2. **5.2's options supplement always restarts the plan.**
   - Any change the argTypes make to the variant properties starts the plan
     again: a new axis renames every combination, and a value added before
     the props are judged (A4) must be measured before they are. The argTypes
     are read with the first variant, so this measures that one again: one
     page load more than the spec says.
   - Everything measured under the old plan is dropped, a variant that failed
     before its args were read included. Kept, it had a combination without
     the new property.
   - The values the options add land in the plan's order, not after the
     planned ones; under `--variants all` the set keeps the plan's order.
   - `null` options are left out: Storybook lists null for cva unions.
   - Beyond 5.2, the argTypes also add props the docs don't list at all
     (`argsNotInDocs`, such as Button's `disabled`), their default the story's
     own arg, and leave out props they mark as behavior (`control: false`,
     `table.disable`, an events category or an action). All of it is
     `cli/props.ts`, which map, inspect and diff use too, reading the argTypes
     snap recorded; each argType now records `hidden`, `category`, `action`
     and the story's `initial` value.
A4. **Props that measure as behavior are left out (beyond 5.3).** 5.3 warns;
   snap now acts on the evidence (`detectBehaviorProps`), judged once the
   representative combinations are measured (under `--variants all`, they
   are measured first):
   - a prop every value of which measured the same, on variants whose args
     Storybook confirmed, is left out as `no-op`, with whether its markup
     changed;
   - where the defaults measured a closed trigger, a boolean one of whose
     values measured the content instead (Drawer's `open=true`) is pinned:
     every variant is measured with it, and it is left out as `opens`, with
     its value. Nothing else is judged on a closed trigger, since a prop
     that styles the content (Sheet's `side`) measures the same on it.
   Each is recorded in the component's `excludedProps`, with the user's
   `--exclude-props`; `--keep-props` keeps one. The 5.3 warnings still fire
   for props kept, or measured on a closed trigger.
A5. **Section 11: map, diff and the Action read styles.json, though not its
   styles.** Their variant properties come from the same source as snap's
   (A2), so they read each component's `argTypes` and `excludedProps` from
   the snap (`--snap`, `.storysync/snaps` by default; the Action's
   `snap_dir`), and say which components' argTypes they couldn't see. The
   Action compares variant properties as before, leaving `excludedProps` out
   of the comparison and naming a prop it left out in the report.
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
    throughout is `opaque: "image/png"`. The spike (item 10) uploaded a JPEG
    thumbnail and read the same 2,186 bytes back, so JPEG stays.

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

# Package B: where `storysync figma code` departs from the spec

Each item is also explained in a code comment where it acts, and in the
commit that made it.

## Layout (section 8.4)

23. **Layer order versus paint order: B takes item 20's first option.**
    Sections 6.9 and 8.4.6 send a frame whose paint order differs from its
    flow to NONE, but section 15 asks for Attachment with auto layout, and
    its `relative` media tile paints after the content it flows before.
    - Figma's layer order is both its paint order and its auto layout flow.
      Where the two differ, B lays the children out in flow order when no
      pair whose order changed overlaps, since the paint order then shows
      nowhere. Otherwise the frame goes NONE with a named reason.
    - The rule is one function, `visibleReorder(painted, layers)` in
      `cli/figma-layout.ts`, which planLayout uses. It compares border
      boxes, so a stroke built outside a frame counts as what it paints
      over, and siblings overlapping by 0.5px or less keep apart.
    - **C must score `order` with it.** Section 10.2's `order` compares the
      whole sequence, so every Attachment variant drifts on `order`. In
      `cli/verify-tree.ts`, the check becomes
      `check("order", visibleReorder(children, got) === null, want, got)`.
      With that one change, C's verify scores every fixture at 100% in the
      mock, Attachment included.
    - To take the spec as written instead, set `REORDER_NON_OVERLAPPING` to
      false in `cli/figma-layout.ts`. Only Attachment's root loses auto
      layout: 4 of 85 fixture frames, and 30 of 359 on A's live snap.
24. **A wrapping flex whose children fit on one line is laid out as one
    line.** This is item 20's other half. A wrap onto several lines is still
    NONE.
25. **Sizing departs from 8.4.7, as item 19 proposes.**
    - A frame is FIXED on the axis a child grows along. Across, it hugs the
      children that don't fill, and the ones that do stretch over them, as
      the spike saw Figma do (`SPIKE.fillAcrossHug`, now true). It is FIXED
      across only where every child fills, leaving nothing to hug.
    - A grower fills only where filling gives it its measured size.
    - A text fills only its width, across a column, and only when it is laid
      out at a fixed width (HEIGHT).
    - Vectors and images never fill.

## Calls and the plan (sections 8.1, 8.2)

26. **figma code removes only an earlier plan's files under `--out`.** 8.1
    says nothing about it. It removes `NN-<kind>-<page>.js` and `NNb…`
    continuations under `calls/`, and `NN.json`, `NNb.json` and
    `NN.upload.json` under `results/`, so a stale response can't be read as
    the new plan's. Every other file stays.
27. **A variant too big for one call is left out, not fatal.** Section 8
    doesn't say what happens when a variant alone needs more than
    use_figma's 50,000 characters. TREE_LIMITS allows 400 nodes a variant,
    and trees with lucide icons run about 300 characters a node. Such a
    variant is left out with a warning naming its size, and is not filled,
    labeled or read back, so verify reports it missing from Figma. Every
    other variant and component is planned.
28. **A build call's base is its part's first variant**, not the
    component's: a variant alone in a call carries only its own records.
29. **A new variant is a copy of the first only when they share at least
    half their keys.** Section 8.2.3 always clones. Sidebar's
    `collapsible="none"` variants share no key with the others, and copying
    them meant removing nearly every copied layer.
30. **Every call figma code writes is compiled before any is written.**
    `CALL_CONSTANTS` names what each kind of call writes before its
    template: DATA for build and label, PAGE for images, and PAGE, SLICES,
    LIMIT and TPL for reads, as section 9.1 has it. A template must not
    declare them. C's readback template now leaves TPL to the call and
    checks it.
31. **`nodes` and `--max-nodes` count records.** Each record is a layer the
    build sets 20 to 30 properties on. Figma also makes layers natively:
    a clone's copies, an icon import's shapes, and a changed icon imported
    again. On A's live snap that ran 1.5 to 2.2 layers a record.
    `cli/figma-spike.ts` says so beside `SPIKE.maxNodes`, so the spike's
    timing (item 8) can be compared with real calls. The spike made 400
    frames in 3.2 s and 100 labels in 1.4 s, about 4.6 s for 500 nodes of a
    few properties each, so 400 records stays the limit.
32. **A build call lists at most 60 uploads**, since upload_assets hands
    out at most 60 URLs.
33. **Read prediction is a calibrated heuristic**: 520 characters an entry
    plus per-record constants from section 9.2. With C's template it runs
    0.5 to 15% high, never low.
34. **plan.json's `snap.path` is relative to the plan's directory.**
35. **Extra optional parameters**, beyond the fixed signatures D stubs:
    `runFigmaCode` takes `templates` and `spike`, `runFigmaNext` takes
    `minify` and `templates`, and `runFigmaUpload` takes `fetch`.

## The build template (section 8.2)

36. **The result has more than 8.2 lists, and is kept under 20kb.**
    - `page`, the page it built on.
    - `fallbacks`: `[component, key, what, variants]`, once per component,
      key and kind of fallback, with the first 80 characters of Figma's
      message and the number of variants it happened in.
    - `unbound`: `[component, key, property, "name: why"]`, deduplicated,
      without a slug.
    - `omitted`: how many entries went. Before returning, `unbound`,
      `fallbacks` and each set's `absoluteContainers` are halved, longest
      first, until the response is under 16,000 characters, since
      use_figma refuses one over 20kb while the call's changes stand.
      `uploads` and the per-set counts are never cut.
37. **Fonts are loaded before anything moves.** The figma-use skill
    documents that moving a node holding a text in an unloaded font throws.
    The build loads every font in a variant before converging it (a
    designer's texts included), a new text's default font before it moves
    into place, and a variant's fonts before the set's layout moves it.
38. **An icon root.** A component whose root is an `<svg>` holds the
    icon's shapes itself, marked `vs`. A copied variant keeps them and the
    root's `svg`. A root that turns from a frame into an icon, or back,
    loses what it was. A root icon Figma won't import is marked `failed`
    and tried again.
39. **A placeholder's text is a keyed `#unmeasured` TEXT, colored
    `#737373`.** Section 8.10 gives neither. The readback reads it as any
    keyed layer, and the variant's `src` says it is a placeholder.
40. **Bindings (section 8.9).**
    - A `#text` or `#value` run binds with its own `cls`, which A writes
      from the ancestor it inherits its color from, and with its parent's
      only when it has none.
    - A vector's paints also accept `text-*` classes, since lucide draws in
      `currentColor`.
    - A radius is not bound when its border is built OUTSIDE, because the
      inner radius matches no token.
    - Candidates are the tokens' light `hex` and `px`, which snap measures;
      a token's `dark` value is never one. A variable with Light and Dark
      modes binds by name as one of one mode does (tokens 0.4.0, item #8).
    - tokens leaves out a radius `DEFAULT` that repeats another step in
      every mode (shadcn/ui's `--radius`, which `--radius-lg` is); the
      Binder, `--check`'s baseline and diff's Figma variables drop it the
      same way, so a tokens.json, baseline or Figma file from before
      still works. A class's `primary` names a config's `primary/DEFAULT`.
41. **Label call (section 8.11).** DATA is `{ pages, sets: [[id, line]] }`,
    because the template loads only those pages. It returns
    `{ kind, changed, missing, pageOne }` and switches page at most once,
    only to remove an empty Page 1. Its line reads "measured from its closed
    trigger, <element>, not the open <Name>", or the layout-wrapper wording.
42. **Refusals.** figma code refuses a root-only snap, pointing to
    `--root-only` and the skill's root-only templates, and a measured
    variant without a `treeDelta`. A component with no Storybook id (the
    0.3.0 example) gets its title as the storysync id on its set.

## Package T's mock (shared file, small hunks in their own commits)

43. Options `shadowSpread` and `textTruncation` (`"keep"`, the default, or
    `"refuse"`), for spike items 2 and 3.
44. Option `moveNeedsFonts` (default false): appendChild and insertChild
    throw on a node holding a text whose font the call hasn't loaded. B's
    tests turn it on.
45. A page has `remove()`. It refuses the only page and the call's current
    page, which is an assumption until someone checks Figma. Page ids no
    longer repeat after one goes.

## What the spike settled

Every spike-dependent constant is in `SPIKE` in `cli/figma-spike.ts`, with
what the spike saw and where it acts; runFigmaCode's `spike` still takes the
other answer, for the tests. The template's run-time fallbacks are marked
`SPIKE(n)` in `templates/build.js`, and stay as guards for what the spike
didn't try. `cli/__tests__/figma-spike.test.ts` checks each constant against
fixtures/figma-spike.json.

| Item | What the spike saw | What the build does now |
|---|---|---|
| 1, SVG stroke scaling | lucide's 2 at 24 came in 1.33 wide at 16, as Chrome draws it; `rescale(16/24)` of a 24 import gave the same | `svgStrokesScale: true`: each icon is imported at its measured size, no rescale. Markup sized otherwise is given that size |
| 1, the import's frame | it clips, and has a fill | the build clears the fill: an icon draws only its shapes, and the readback reads no fill off a vector |
| 1, `<g>` | imported as a GROUP | nothing to change: snap keeps a `<g>` only with a transform, opacity or effect, and the readback finds shapes inside groups |
| 2, shadow spread | 1, kept on a frame clipped or not | spread built as measured; the guard for a refusal stays, for kinds of node the spike didn't try |
| 3, textTruncation | ENDING with maxLines 1 kept a 94px label 94 by 20; `resize()` turns a hugging label to NONE | truncation built as measured, its guard kept; no label meant to hug is resized, which a test checks |
| 4, absolute children | an ABSOLUTE child stayed at 3,4 under an included INSIDE stroke | `absoluteInsetByStroke: false`, x and y from the frame's corner |
| 4, strokes in auto layout | only an INSIDE stroke took room; CENTER and OUTSIDE didn't | `outsideStrokeTakesSpace: false`; the build includes strokes only where it builds them INSIDE |
| 5, clone and plugin data | kept on the copy and its children; a copy of a variant or of anything nested lands on the page | the copy is moved into its set beside its original, and no longer has its keys copied onto it |
| 6, findAllWithCriteria | found nodes by a shared plugin data key, by any of several, and by namespace alone | the build and images calls find images by `img`, and the readback and label calls now find sets by `id` |
| 7, return shape | an object, written as JSON | the parser reads it, as it would a string or an envelope |
| 8, time | 400 frames 3.2 s, 100 labels 1.4 s | `maxNodes: 400` records (item 31) |
| 10, image bytes | the same bytes back, hashed by their SHA-1, the hash reusable on another node | the images call reuses hashes; verify proves content by bytes (C25) |
| 11, fill across a hugging parent | the parent hugs its widest other child (120) and the filling one stretches to it | `fillAcrossHug: true`: such a frame hugs. Card's notification text blocks do |

# Package C: where the readback and verify depart from the spec

Package C reads back (`templates/readback.js`), assembles the results
(`cli/figma-results.ts`) and scores them (`cli/verify.ts`,
`cli/verify-tree.ts`). Its notes are numbered C1 on, so they don't collide
with the other packages'. "Spec problem" marks a rule the spec gets wrong or
leaves open, for the owner and for B and D.

## The read call and the template (section 9.1)

C1. **The CLI writes all four header lines, TPL included, as 9.1 has them.**
   - The template declares none of PAGE, SLICES, LIMIT and TPL, and refuses
     a TPL other than 2.
   - `readbackHeader` writes them one a line, as B's `figma code` does, so
     `figma next` finds a call's LIMIT again by its line.
   - LIMIT defaults to 15,000 (`READ_LIMIT`): B packs reads to a predicted
     14,000 and adds its 1,000 margin.
C2. **LIMIT and the 19,000 guard count UTF-8 bytes**, where 9.1 says
   "encoded characters". use_figma's 20kb counts bytes, so labels outside
   ASCII could pass it under a character LIMIT. A UTF-16 unit outside ASCII
   counts as 3 bytes, an upper bound. With RETURN_TEXT, the size is the
   returned string's.
C3. **Spec problem: two variants of one index.** 9.1 refuses only a slug
   held twice, and that still throws. But a re-snap that drops a variant
   leaves its Figma variant in the set with its plugin data (B's `extra`),
   and its `i` is one B gives another variant.
   - The template reads both, in slug order within the index. A call that
     stops part way continues by a node count across that index's run.
   - verify lists the stale one in `unmeasuredInFigma`.
C4. **Spec problem: where `unbuilt`, `absent` and `total` go.** 9.1 returns
   them, and 9.4 says nothing about them.
   - figma-results keeps each set's `total` (the largest any call saw) and
     `unbuilt` (sorted) beside its variants in figma-readback.json. They are
     not sealed: they say what the set holds, not what a variant is.
   - verify lists, in `unreadInFigma`, the unbuilt variants by name and the
     count of slugged variants no read covered (`total - unbuilt - read`).
     Both count in `summary.unread`, and fail `--strict-measured`, as
     variants in Figma snap never measured do.
   - While a planned read has no result, nothing is counted as uncovered:
     `notRead` says so already.
   - `absent` is not carried. verify reports those variants as missing from
     Figma already.
C5. **Image paints carry their size**, `img:<fnv>:<scaleMode>:<w>x<h>`, with
   `?` for what can't be read, so the spike's fallback (an image there, at
   the thumbnail's size) can be scored. An image the sandbox can't find
   reads as unreadable, and the read goes on. The spike kept the bytes (item
   10), so content is scored by the FNV; the size stays in the record for a
   verify run with `imageBytesKept` off.
C6. **A gradient's transparent stops are kept** as `#rrggbb00`, as snap
   writes them. A paint whose own color draws nothing is still left out of
   `fills`. The RGB of an alpha-0 stop is compared too, since snap records it
   and B builds it.
C7. **Owner decision pending: no variable bindings, and no textLayout, in
   element-tree entries.**
   - r3/small's binding report reads `bound` and `unbound` from root-only
     entries. T's records have no field for bindings, and the template
     minifies to 7,865 of its 8,000 characters.
   - textLayout repeats what the T records hold.
   - So the binding report covers root-only entries alone, and verify says
     the element-tree readback reads no bindings yet. The options: root-level
     `bound`/`unbound` in a variant's first part, with a larger budget; or a
     small separate bindings read call that B plans.
C8. **The 0.4.0 root fields are in the browser's terms**, like the records:
   `borderRadiusUniform`, `width` and `height` include the stroke outside
   the box. 0.4.0's template read the raw cornerRadius, which for B's
   padding-box border (OUTSIDE, radius r - w) reads 1px short on every
   bg-clip-padding Button.
C9. **C's size test is a proxy, and B's budget test leaves readback out.**
   - C has no minifier. Its test holds the template, stripped of comments
     and indentation, to 11,800 characters: 11,681 now, which terser takes
     to 7,908 with B's options (7,865 before it found sets by their id key,
     item 6 of the spike).
   - B's `templates.test.ts` BUDGETS has no `readback` entry ("checked once
     it is"). On merge, add `readback: 8_000` there.

## Assembling the results (section 9.4)

C10. **loadPlanResults** takes an optional `{ out }`, and returns `problems`
   beside section 15's `{ readback, notRead, written }`: a call with no
   result, a result that holds no read, one component read from two sets,
   and an entry read twice (the first reading is kept). Continuations
   follow `NN.json`, `NNb.json`, `NNc.json` (`continuationResult`). The
   readback file stays version 1, and its entries carry `tpl`.

## Scoring (section 10)

C11. **Spec problem: the root's v1 properties (10.2).** With trees, the root
   is scored as an F node from its record: fills, stroke, radius, effects,
   opacity, blend, clip, order, and w and h under 10.4's container rule.
   - v1's padding and gap are how Figma lays children out. An element-tree
     build places children itself (D2), absolute with no padding or in auto
     layout with spacing that takes in their margins, and the children's
     places are scored instead.
   - v1's text fields are scored on the T nodes.
C12. **Spec problem: rows 2 and 5 of the back-compat matrix (10.7).** Scored
   by roots alone (a root-only snap, or `--roots-only`), an element-tree
   entry's padding and gap are left out, as in C11. Compared, a faithful
   build drifted on them: Attachment 80%, Button with icon 75%. 0.4.0's
   verify reading an element-tree readback also reports each `slug#n` part
   as `incomplete`, not only as a variant snap never measured.
C13. **`order` drifts only where it shows (10.2).** 10.2 compares the whole
   sequence. B lays children out in flow order where the reordered ones
   don't overlap (B's note 23), and verify scores `order` by the same rule:
   a pair of keyed siblings in the other order whose border boxes in snap
   overlap by more than 0.5px. C writes the rule again in verify-tree.ts
   (`visibleReorder`) rather than take B's (design D9), and a test holds it
   to the cases B's test holds the build's to.
C14. **The container allowance across the flow (10.4)** is the largest
   in-flow child's difference, as a hugging frame grows by its tallest
   child. 10.4 defines it along the flow only.
C15. **`children_not_read_back` is a verdict flag** (`childrenNotReadBack`,
   counted in `summary.elements.notReadBack`), not a ReadbackIssue. 10.1
   still scores the root, and an issue would leave it unscored. It fails
   `--strict` through `treeStrictFailures`.
C16. **What section 10 leaves open:**
   - effects are matched one for one, whatever their order;
   - `order` is compared only when 2 or more keyed children are in Figma;
   - `designerLayers` travel on a variant's first part only;
   - a tree delta that can't be expanded throws, as a broken styles.json.
C17. **A variant missing from Figma, with a tree,** counts every element as
   missing and every property of each as mismatched, in the property share
   too. A missing root-only variant still counts no properties, as in 0.4.0.
C18. **A variant read in parts with any part missing**, the first included,
   is `parts_missing`, with nothing in it scored. Each part's count, total
   and first node are checked against the records it holds.
C19. **`not_measured`** is the verdict for an element-tree placeholder. A
   root-only entry for a variant snap didn't measure stays in
   `unmeasuredInFigma`, as in 0.4.0.
C20. **Caveat names follow r3/args**, as the owner decided: there are no
   `args-hidden` or `args-dropped` caveats. `args-rejected` and
   `args-unchecked` cover those variants, and their placeholders are
   `not_measured`.
C21. **The headline (10.6)** reads `Fidelity: 99.3% of elements (287 of 289
   verified), …`. The percentage sums node scores, so the count beside it
   says what it counts rather than reading as the same ratio.
C22. **verify's options.** `VerifyOptions` carries `rootsOnly`, `notRead`,
   `spike` and `allowDesignerLayers`, which section 15's signature adds.
   `treeStrictFailures(result, { allowDesignerLayers })` is what `--strict`
   reads. `headlineFidelity` returns null when nothing was scored, which
   `--min-fidelity` must treat as a failure.

## Acceptance figures (section 15, package C)

C23. **Spec problem: "100% at width factor 1.045" for example-button.** It
   draws Inter in both worlds, so 10.5 gives its labels 3%, not 6%. At 1.045
   its 12 labels drift on their width and nothing else, and every other
   fixture still scores 100%.
C24. **Spec problem: Attachment vertical untruncated scores 22.2%, not
   20%,** on T's 8-node fixture: the root, and the title on x, y, w and
   truncation of its 18 properties, (1 + 14/18) / 8. The 20% came from a
   prototype with 9 nodes.

## The spike (section 14)

C25. **One place a side, each now what the spike saw.**
   - verify's assumptions are `SPIKE` in cli/verify-tree.ts, overridable per
     call through `VerifyOptions.spike`. The root-only boxShadow comparison
     reads the same. All three were the spec's expected answer, and the
     spike confirmed each:
     - `imageBytesKept: true` (item 10): the Avatar thumbnail came back as
       the same 2,186 bytes (FNV ef9497ae), its hash their SHA-1, reusable
       on another node. Image content is proven by bytes, not by the
       presence-and-size fallback.
     - `shadowSpreadKept: true` (item 2): a spread of 1 read back on a frame
       that clips and one that doesn't.
     - `textTruncation: true` (item 3): ENDING with maxLines 1 kept a 94px
       label 94 by 20.
   - The template's one switch, `RETURN_TEXT`, stays false (item 7):
     use_figma gave the returned object as JSON, and a JSON string inside it
     stayed a string.
   - The stand-in width tolerance (6%, 10.5): the spike's Inter Medium label
     came out 158 wide where Chrome drew it 154.8 in system-ui, 2.1% wider.
   - Still assumed, with no spike item: Figma's blur radius equals CSS
     blur().
   - ABSOLUTE children with per-side strokes are not a switch in C. The
     template reads where a child is, its x and y from the parent's frame
     plus the parent's stroke outside it, so how Figma places an absolute
     child changes what is read, not how it is read. The spike saw one stay
     where it was put, and per-side weights read back as set.
   - `cli/__tests__/figma-spike.test.ts` checks each against
     fixtures/figma-spike.json.

## Ownership (C and D)

C26. **D wires the flags**: `--plan` (loadPlanResults, then verify with
   `notRead`, printing its `problems`), `--roots-only`,
   `--allow-designer-layers` (until then, designer layers fail `--strict`)
   and `--min-fidelity` (headlineFidelity). C changed cli/index.ts only in
   small hunks: the new caveat and issue texts, the element report, and what
   `--strict` and `--strict-measured` fail on.

# Package D: where the CLI, the skills and the docs depart from the spec

Package D wires the commands and flags (`cli/index.ts`), rewrites the
skills, the push and diff commands and the README, and runs the push end
to end (`cli/__tests__/tree-e2e.test.ts`, `scripts/acceptance.mjs`). Its
notes are numbered D1 on. Everything ships in one 0.4.0 release, so the
spec's 0.4.1 items are in it too.

## Names and flags

D1. **The flags take what A and C merged, not section 5.1's names.**
   `--no-channel-args` sets `channelArgs: false`: a value the story's URL
   won't carry is `arg_rejected` (`args_unsupported` when no URL can carry
   it), as A1 has it. There is no `args_hidden` to flag; the skills name
   `arg_rejected`, `appliedVia: "preview"` and `argsChecked: false`.
D2. **`--stories` takes comma-separated pairs, or the flag more than once.**
   The CLI refuses what can't be a `component=storyId` pair, or a component
   named twice, before connecting. Which component a pair names, and
   whether the story is its own, runSnap checks (A27).
D3. **`verify --plan` writes the readback where `--readback` says, only when
   it is given.** Otherwise loadPlanResults' default, beside the plan's
   directory, which is `.storysync/figma-readback.json` for the default
   plan. So an audit's plan under `.storysync/audit/figma` writes
   `.storysync/audit/figma-readback.json` and leaves the push's alone.
D4. **`verify --plan` scores the snap the plan was made from** (its
   `snap.path`) unless `--snap` is given. A snap whose bytes no longer match
   the plan's digest is named, and in `--json` as `plan.snapChanged`, but
   not failed: its variants the calls never built fail as missing anyway.
D5. **Every problem loadPlanResults returns fails `--strict`**, not only a
   read with no result (C26): a component read from two sets, or an entry
   read twice, leaves the readback in doubt too. `--json` adds
   `plan: { path, readback, problems, snapChanged? }` to VerifyResult.
D6. **`--min-fidelity` fails with or without `--strict`**, takes `99` or
   `99%`, and fails a run headlineFidelity scores null (C22).
D7. **`figma code`'s defaults are read from where each lives**:
   `SPIKE.maxNodes`, `MAX_CALL_CHARS` and `DEFAULT_READ_LIMIT`, so a change
   after a live push is one edit. `--json` prints
   `{ planPath, calls, warnings }`; `figma next --json` prints `{ next }`,
   null when nothing is left; `figma upload --json` prints `{ uploaded }`.

## The skills (section 12)

D8. **The root-only section keeps 0.4.0's text and templates unchanged**,
   numbered as the steps they replace (3 to 7), because acceptance runs its
   build, readback and label templates as an agent would paste them. The
   Variable binding and Visual accuracy guidance for hand-written code moved
   into it; the main sections describe what `figma code` does instead.
D9. **`Script exceeded time limit`: send the new plan from its first
   call.** Section 12 says to re-send the failed call and those after it,
   but `figma code --max-nodes 200` renumbers the calls and clears the
   results. Builds already done change nothing the second time.
D10. **Section 5.5's Page 1 asks before removing.** r3/small's label
   template, and B's, remove `Page 1` while it is empty, untouched and not
   the only page, and report `pageOne`; the skills say so rather than ask.
D11. **`upload_assets` without `batchCommit`.** The tool commits each upload
   itself unless `batchCommit` is set, which would need a commit URL called
   once more; `figma upload` posts to each URL and calls nothing else.
D12. **The audit's element scoring (section 11) is an optional last step.**
   It snaps into `.storysync/audit`, runs `figma code` there and sends only
   the plan's read calls. Binding coverage per paint kind is left out: the
   element-tree readback reads no bindings (C7).
D13. **The grep test (section 15, D's acceptance) is a unit test** in
   `setup.test.ts`, beside the other checks of the skills' text, so
   `pnpm test` runs it. Besides `applyStyles`, `SPEC` and `BIND`, it
   refuses `setPaints`, `loadFont`, `VARIANTS`, `PROPERTIES`,
   `SLUG_BY_NAME` and `SOURCE_BY_SLUG` outside the root-only section, and
   requires each new command and no `use_figma` code in steps 5 to 7.
   setup.test.ts's checks of 0.4.0's templates now read the skills alone:
   the push command points to their root-only section.

## End to end

D14. **tree-e2e runs the compiled CLI**, as the agent does, with uploads
   posted to a stand-in server in the test, and holds every T fixture, and
   all nine in one push, to 100% of elements and exit 0 under `--strict`.
   A read continued through `figma next` is forced by lowering LIMIT in the
   call files, standing in for a prediction that ran low.
D15. **Acceptance pushes the example's tree snap into the unit tests' mock
   Figma**, loaded from `dist/cli/__tests__/mock-figma.js`, which
   `pnpm build` compiles beside the CLI; `--no-channel-args` and
   `--stories` are checked against the live Storybook.


## After review

D16. **A continuation read before what it continues is sent again**
   (sections 9.4 and 12 say nothing of a read call sent twice). A read call
   sent again after a change in Figma left the continuations saved the
   time before, and figma next and verify --plan took them as read. A
   continuation is always sent after what it continues, so one whose
   earliest entry `readAt` is before the latest of the results it
   continues is from an earlier reading: `figma next` writes it again with
   `again: true`, and loadPlanResults leaves it, and what it reads, out of
   the readback, as a problem, its call in `notRead`. The entries' `readAt`
   decide it, not file times, which a checkout resets.
D17. **Variants a planned read didn't read are `not_read`**, a verdict
   status section 10.6 lacks, beside `not_measured` and `parts_missing`:
   plan.json's slices of each call not read whole go to verify as
   `notReadSlices`, and a variant in one with no entry is neither missing
   from Figma nor scored (as an unverified entry is left out), counted in
   `summary.notRead` and said on the score's line. verify says a call
   "wasn't read whole" rather than "has no result saved", since a failed
   result or a continuation from before is that too.
D18. **`--stories` pairs are resolved against every component Storybook
   lists** (A's snap.ts, small hunks). One for a component a run doesn't
   measure, under `--components`, is checked and left out, so the push can
   pass its pairs to every snap, re-measures included, as the skill says;
   and under `--merge` a component keeps the story the snap measured it
   from where `--stories` names none. A name no component has, or a story
   not the component's, is still refused before anything is measured.
D19. **The audit snaps from the push's stories** (D12): `--stories` with
   each component's `storyId` from the push's styles.json, which the push's
   summary now names too.
D20. **The build imports an icon again when its shapes changed** (B's
   build.js). Section 12's repair, "resend that component's build calls
   once", assumes the build restores what it sets, and an icon's shapes it
   set only by importing them. Each icon, and a root icon, keeps `ink`,
   its shapes' paints and stroke weights as the build left them; one that
   no longer matches is imported again, under a new node id. An icon built
   before has none and is kept. The minified build is 15,694 characters.
D21. **A child missing or hidden in Figma costs itself alone** (C's
   verify-tree.ts, two hunks; section 10.4 extended). Figma's auto layout
   gives either no room, so a container may differ by such an in-flow
   child's whole size, and along a flex flow its gap, and Figma's flow
   anchors the next layer past a hidden one as past a missing one. Hidden
   counts only where snap measured the layer visible.
D22. **Section 17's "move card-title 6px right" can't be made inside auto
   layout**: x is ignored there, and made ABSOLUTE the title leaves the
   flow, so card-header shrinks and card-description moves up, which verify
   reports, as Figma has them; a record doesn't say a layer is ABSOLUTE.
   tree-e2e makes the other five edits and pins exactly those findings.
   Step 4's undo can't be Figma's Ctrl+Z in the mock: what can't be undone
   by hand (the deleted thumb, the recolor) is undone by sending the build
   calls again, and the readback then equals the baseline but for `readAt`,
   checksums and the node ids of the two rebuilt layers. The README's
   falsification test no longer suggests a move, and says why.
D23. **`meta.json` records `"channelArgs": false`** for a snap taken with
   `--no-channel-args` (A's snap.ts), absent otherwise: a condition of the
   measurement, as `variantSelection` is, and what lets a CLI test see the
   flag reach the run without a browser.
D24. **`verify --json` adds `minFidelity: { min, score, passed }`** with
   `--min-fidelity`, both from 0 to 1, so a CI can tell that failure from
   a `--strict` one.
D25. **`figma next` writes a continuation from the template its call was
   written with**: readable where the call holds the readable template,
   after `figma code --no-minify`.

# Text: Figma's font, one line, truncation that sticks (after the third live push)

The third live push (Figma file UPmguLPQ7w1ESdOZsq6vlw) built every
truncated label with truncation off, so Sidebar's menu labels wrapped
("Hom" over "e") and Attachment's titles took two or three lines: 170
elements drifted, all of them Sidebar's and Attachment's.

## The live text probe (2026-10-09)

Three use_figma calls in that file, on a page of their own, "storysync probe
2", which the first creates and marks and the others check: the calls are
`spikes/figma-text-probe-1.js`, `-2.js` and `-3.js`, sent as written, and
their responses `fixtures/figma-text-probe.json`, unchanged. A test in
`mock-figma.test.ts` runs the three calls in the mock and holds it to them.

T1. **Any write of textAutoResize turns truncation off and clears
    maxLines**, HEIGHT over HEIGHT included. resize() on a hugging text
    makes it NONE, which reads TRUNCATE with ENDING. So the build, which set
    truncation before resize() and textAutoResize, lost it every time; the
    spike set them the other way round, which is why item 3 held there. A
    write of fontName, characters, fontSize or lineHeight keeps it, and so
    do layoutSizingHorizontal FIXED, FILL and HUG (HUG makes the text
    WIDTH_AND_HEIGHT, ENDING kept), layoutGrow and layoutAlign STRETCH.
    layoutSizingVertical FIXED makes it TRUNCATE, maxLines reading null,
    and HUG gives it back as HEIGHT with its maxLines.
T2. **ENDING on a text that sizes itself, with no maxLines, sets maxLines
    to 1**; DISABLED clears it. A NONE text inside an auto layout reads no
    maxLines.
T3. **Figma's Inter is Inter 3.19** (axes slnt and wght). Chrome with
    @fontsource-variable/inter 5.0.18 sets each of the probe's 35 Inter
    strings exactly as wide as Figma did, rounded up to a pixel; with 5.3.0,
    Inter 4, 13 of 35. Roboto Mono and Noto Serif at 5.3.0 matched 2 of 2
    each. The spike's "158 against Chrome's 154.8" was Inter against the
    Mac's system-ui, 2.1% wider; short words run up to 10%. As wide to the
    pixel only: Figma rounds each advance to a 1024th of an em (S1).
T4. **Sizes round up to a pixel.** A hugging text is as wide as its advance
    rounded up ("Home" 39.04 came out 40), and a text that grows in height
    as tall as its lines rounded up (one line of 17.5 came out 18), except
    where ENDING cuts it at maxLines: exactly that many lines (17.5).
    AUTO line height is each font's ascent and descent to a whole pixel:
    Inter 1.21em, Roboto Mono 1.319 (18 at 14px), Noto Serif 1.362 (22 at
    16px).
T5. **Superseded by S1**, which found call 2 reading a text Figma had
    stopped wrapping. As first written: **Figma keeps a line whole a little narrower than its advance**: by
    0.13 to 1.22px for the probe's eight strings (call 2's thresholds), and
    always at Chrome's width, 0.004 under it, and rounded to 0.01. A word
    wider than its box breaks between characters.
T6. **Figma's plugin context lacks** Segoe UI, Helvetica, Helvetica Neue,
    Arial, Menlo, Monaco, Consolas, Courier New, SF Mono, SF Pro Text, Georgia,
    Times New Roman, Verdana, Tahoma and the other faces `PLATFORM_FACES`
    lists (call 3). It has SF Pro, Roboto, Ubuntu, Cantarell, Noto Sans,
    Arimo, Tinos and Cascadia Code. The skills' root-only section still says
    it has no SF Pro: D8 keeps that section as 0.4.0 wrote it.

## snap draws text in Figma's font (`cli/fonts.ts`)

T7. **One mapping for snap and the build.** `standInFor` is the template's
    old pair of patterns: Roboto Mono for a monospace family, Noto Serif for
    a serif, Inter for any other. The monospace pattern also takes Lucida
    Console, a face Figma lacks (T6) that names no `mono`. figma code passes the build each text's
    stand-in as `a` in its style, and the template no longer holds the
    patterns.
T8. **Which text.** A font stack text is drawn on, whose first family is a
    CSS keyword or alias (`system-ui`, `ui-sans-serif`, `-apple-system`,
    `monospace` and the rest) or a face in `PLATFORM_FACES`, gets the
    stand-in ahead of it, as `"storysync Inter", <stack>`, inline and
    important, on every element computed on it, so its ancestors' and
    children's inheritance holds: after the story settles and before
    anything is measured or chosen by its box. Text is drawn on a stack
    where an element's text node lays out on screen, a form control is on
    it, or a ::before or ::after has text of its own. html and body,
    which hold no text but carry Chrome's default Times, and Storybook's own
    UI, hidden while a story shows, don't count, so a story set in the
    project's own font is sent no stand-in at all. A stack that opens with
    any other family, a font the project loads such as Geist or the
    example's Inter, is left alone, and so is one whose own font failed to
    load (`fa: 0`, as before). An element's pseudo-element with a keyword
    stack of its own isn't changed.
T9. **The faces** come from the npm packages, every unicode-range subset of
    the weight axis, upright and, for Roboto Mono and Noto Serif, italic,
    added with the FontFace API under the family `storysync <stand-in>`, so
    a project's own Inter keeps its faces; Chrome slants Inter's upright for
    italic, as wide as Figma's Inter Italic. Only the stand-ins the page's
    text needs are sent to it: about 220 KB for Inter. snap then waits for
    those faces alone, at most the image wait (5 s, or `--timeout` if
    shorter): load() on every face the page declared fetched each one the
    project declares and nothing draws in, and one whose request hung would
    have held the capture. Sent for every stack in the page, html's Times
    included, and so loading all three stand-ins and the project's unused
    faces, it cost the example's 15 variants about 130 ms each.
T10. **What snap records.** The stand-in is what the browser drew, so a
    text's `f` is the Figma family, `Inter`, with `fs`, the family the code
    asked for as resolveFontFamily would have recorded it (`system-ui`, or
    `Menlo` for Tailwind's mono stack on a Mac), and no `fk`. Where the
    page couldn't probe a stack, its first family is read the same way:
    `Inter`, never snap's own `storysync Inter`, which no Figma font is
    named, with the family after it as `fs`. The root's and its text's
    `fontFamily` are `Inter` too, `fontAvailable` true. Each
    component's `fontStandIns` lists its `[asked, drawn]` pairs, and the
    run's `fontStandIns` all of them; `snap` prints one line a run saying
    what it drew in what, and `--json` carries the lists. `standIns: false`
    in captureStory's options measures as before, for a test.
T11. **verify scores the family of a stood-in text**, `Inter` against
    Figma's `Inter`, and its width within 3%, not the 6% a text Figma draws
    in another font than snap measured is allowed. A snap from before, with
    `system-ui` and `fk`, builds and verifies as it did.
T12. **Package size.** The fonts are runtime dependencies, pinned exactly:
    @fontsource-variable/inter 5.0.18 (0.9 MB installed),
    @fontsource-variable/roboto-mono 5.3.0 (0.35 MB) and
    @fontsource-variable/noto-serif 5.3.0 (4.6 MB), about 5.9 MB in all,
    against playwright-core's 13 MB; storysync's own tarball doesn't change.
    Each is under the SIL Open Font License, shipped in the package.
    renovate.json keeps Inter at 5.0.18, and `fonts.test.ts` fails when an
    installed version is not the one `fixtures/figma-fonts.json` was
    measured from.

## The build (`templates/build.js`)

T13. **Truncation is set last**: the size, then textAutoResize, then
    textTruncation and maxLines (T1). A build sent again resets and sets it
    again, which Figma keeps (the probe's `rerunSpike`).
T14. **A label the browser drew whole on one line stays so (`o`).**
    figma-map marks a one-line text set at its box's width (HEIGHT) whose
    glyphs fit inside its box. Once a variant is converged, `keepLines`
    takes each such text's line limit off and reads its height: one taller
    than a line and a half in Figma, its line height or, for AUTO, 1.27em
    (Figma's AUTO lines are 1.21em to 1.36em, whole lines rounded up to a
    pixel, T4), would wrap, or be cut short, at that width. Not the box
    measured: a row that stretches its items makes a label's box taller
    than its line, and a box can be 0 tall. Such a text is set to Figma's
    own width instead, WIDTH_AND_HEIGHT, and a truncated one then fixed at
    that width with its truncation set again, so it still truncates should
    it shrink; where checkLayout then builds its frame without auto layout,
    it keeps that width rather than the one measured. Each goes in
    `fallbacks` as `kept on one line: Figma sets it wider`. A
    text that fills its parent keeps FILL and its wrapping or truncation:
    one that truncates is named `cut short`, as verify can't see an
    ellipsis (T21), and one that wraps isn't, as verify scores its lines. A
    snap that drew stand-ins gives none: the widths match (T3, T5).
T15. **loadFont takes the text's style**, `f`, `w`, `i` and `a`, and one
    helper sets a text's size, autoResize and truncation in that order for
    style() and keepLines, to fit the template's budget: the minified build
    is 15,969 characters, of 16,000, and 16,824 of 17,000 with L1's grid.

## The mock (`cli/__tests__/mock-figma.ts`)

T16. **Text as Figma sets it.** The default measure is `figmaFonts()`:
    Inter, Roboto Mono and Noto Serif from `fixtures/figma-fonts.json`, each
    character's advance and each kerning pair among printable ASCII, in em,
    which `scripts/figma-font-metrics.mjs` measures in Chrome from the
    installed packages (`--check`, which acceptance runs, fails when they
    differ). It sets all 39 of the probe's strings as wide as Figma did.
    `measureFromTrees` still gives the widths snap measured, for a faithful
    build; `figmaFonts(fallback)` measures other families by `fallback`.
T17. **The uniform `textWidthFactor` (1.045) is gone.** The fixtures were
    measured in system-ui, so with figmaFonts the mock sets their text in
    Inter as Figma does, a few percent wider and by each word's own width,
    which is what wrapped the third push's labels. tree-e2e pushes every
    fixture this way, and holds each to 100%; one test there stays at the
    browser's widths, where a designer's changed text would stretch the line
    under it past its tolerance.
T18. **Text sizes, wrapping and truncation follow T1 to T5**, except the
    wrap threshold, which follows S4: a line wraps in a box any narrower
    than it. Lines break after
    a space or a hyphen, and a word wider than its box between characters.
T19. **The test harness's own build** (`tree-harness.ts`) set truncation
    first too, and lost it in the mock as soon as the mock did what Figma
    does.

## On the third push's data

T20. figma code on the third push's styles.json, Sidebar and Attachment,
    into the mock with Figma's fonts, read back and verified:
    - with 0.4.0's build: 508 of 678 elements verified, 170 drifted, the
      same 170 the live verify reported: every Sidebar label on two lines,
      and Attachment's titles on two lines in its default horizontal
      variants and its small vertical tiles, on three in its default
      vertical ones;
    - with this build: 678 of 678; every Sidebar label whole on one line, 40
      wide for "Home" where it was measured 38.25, each named `kept on one
      line`; every Attachment title on one line, ending in an ellipsis where
      the browser's did (the vertical tiles, 94, 98 and 102 wide), and in
      the five default horizontal variants, where the browser's didn't,
      since the title fills its row: named `cut short`;
    - a snap taken again with the stand-ins (Sidebar and Attachment, 48
      variants, live): 678 of 678, no fallbacks, every Sidebar label and
      every horizontal Attachment title whole on one line, and the vertical
      tiles' titles cut where the browser cut them.
T21. **What verify can't see**: Figma doesn't say whether a text is cut
    short, so an ellipsis Figma draws where the browser drew none scores
    as truncation that matches. The build names it (`cut short`), and a
    snap that draws stand-ins doesn't give one. (Since BV3, the readback
    measures it and verify scores it.)

# Layout after the third live push

The third live push (Figma file UPmguLPQ7w1ESdOZsq6vlw, agents/push3)
built real components, but laid icon buttons' labels over their
neighbors and built Sidebar's side=right variants off to the side. These
notes are numbered L1 on.

L1. **The set's grid spaces variants by where they draw** (section 8.2,
   step 5, says the 0.4.0 grid code is kept unchanged).
   - A variant's drawn bounds, measured in Figma: its box, each visible
     layer's box that no frame around it clips, and how far past its box
     each layer draws: its stroke's weight OUTSIDE, half of it CENTER
     (an imported vector's, spike #1), the widest side's; its drop
     shadows' radius, spread and both offsets; its layer blur's radius.
     Each is taken on every side and they add up, which is more than
     draws. A designer's layers count. An OUTSIDE stroke matters: a
     border kept outside the fill (`bgc`) is built as a frame the
     fill's size with the border as a stroke around it, so the frame's
     box alone misses the border.
   - A row's boxes share their top edge and a column's their left edge,
     as in 0.4.0's grid. A row is as tall as the most any of its
     variants draws above that edge plus the most below it, a column as
     wide as the most left of its edge plus the most right of it; rows
     and columns are GAP apart, the set's order and default-first rule
     kept. So the default variant is still the one top-left, where
     Figma takes the set's default from, however far another variant
     draws past its box. Each variant placed where its own drawn bounds
     start, as first written, put a default with a shadow below and
     right of its neighbors, and left push3's Toggle columns ragged.
   - Variants that fit no grid cell, in a row below, share a top edge
     the same way.
   - The template's checks (past the set, over another variant) read
     the drawn bounds, so a build whose variants overlap fails.
   - On push3's snap, base Button had 48 pairs of variants drawing over
     each other (at the icon sizes the label draws about 71px past each
     side of a 36px button, as the browser draws it) and radix Button
     6; now none, at width factor 1.045 too, and in Figma's own fonts
     (T17) once merged with the text fixes.
   - The minified build is 16,546 characters, 16,824 with T15's text
     helpers, so `templates.test.ts` allows the build 17,000 rather than
     16,000. figma code packs a
     call by its whole length, template included, so this only leaves a
     call a little less room for DATA.
L2. **The mock's groups have effects**, as Figma's GroupNode does
   (BlendMixin). The drawn bounds read them on an icon root's shapes;
   the mock threw.
L3. **An element placed against the window or page is measured inside
   its root's box** (section 6.9, positioning, extended).
   - Such an element is `fixed` with nothing in the tree to hold it, or
     `absolute` with nothing positioned or holding it around it in the
     tree, it or the outermost wrapper collapsed into it. Where it draws
     depends on the window, not the component: shadcn's Sidebar
     container, `fixed` at `right-0` for side=right, drew 1024px right
     of its own 256px root in snap's 1280px window.
   - What holds a fixed element, as an absolute one, in Chromium 154,
     each value tried on a static page: `transform`, `translate`,
     `rotate`, `scale`, `perspective`, `filter`, `backdrop-filter` and
     `offset-path` other than `none`; `will-change` naming any of them,
     `contain` or `transform-style`; `contain` with layout or paint
     (`layout`, `paint`, `content`, `strict`); `content-visibility`
     `auto` or `hidden`; `transform-style: preserve-3d`. Not
     `container-type`, size or style containment alone, `will-change:
     opacity`, `isolation`, `clip-path`, a mask, opacity or a blend
     mode. The tree's page reads the ones it didn't (they join
     TREE_PROPERTY_DEFAULTS); a capture without them reads them as
     their defaults, as before. Base UI's Slider thumb is at
     `translate: -50% -50%` and its input `fixed` at the thumb's corner,
     where Chrome draws it: read by transform alone, the input moved 5px
     and Slider gained a warning (fixtures/raw/slider.json).
   - Where such elements draw outside the root's box, snap moves them,
     together, as far as it takes and no further: what they cover then
     starts inside the box, or at its corner when larger. What is inside
     them keeps its place in them. The right sidebar now measures the
     same tree as the left one but for its border's side.
   - The variant records the key of each element moved that drew
     outside the box as `movedInside`, not one that only moved along
     with it. It was first a component warning, but there is nothing in
     the story to fix, and every stock shadcn Sidebar with side variants
     then failed `--strict-warnings`, which the README recommends for
     CI. No `approx` is set: the build puts the element where snap now
     records it, and verify scores it there as any other.
   - Not seen: what holds it on an ancestor outside the root.
L4. **Open overlay content in a portal is measured when the story's root
   shows nothing that draws, or only a closed trigger** (section 6.1;
   chooseMeasuredElement gains a step).
   - coder's ConfirmDialog and DeleteDialog render Radix's Dialog with
     `open: true` and no trigger, into the body, with no `data-slot`:
     every variant was element_not_found (10 of 10, against coder's
     Storybook with the base build). Now, with `--exclude-props
     open,isOpen`, all 8 measure as `div[role="dialog"]`. Without it,
     the variants with `open` or `isOpen` false render nothing and stay
     element_not_found, as they should.
   - `OVERLAY_SELECTOR` (`cli/snap-normalize.ts`) is what open overlay
     content is: role `dialog`, `alertdialog`, `tooltip` or `menu`, a
     `-content` slot, or Radix's popper wrapper's child. The outermost
     match outside the story's root is a candidate, first in document
     order: Radix's tooltip holds a hidden copy of its text as
     role=tooltip, inside the content.
   - The wait for a story ends on it too, so such a story no longer
     waits out `--timeout`.
   - Whether the root draws is read off the story's elements as
     chooseMeasuredElement already reads them, with `text`, whether an
     element holds text of its own, added. A StoryNode without `text`
     counts as drawing, so no older caller changes.
   - An element draws by a fill, picture, shadow or border, an outline
     with a width and a color, its own text, a ::before or ::after with
     any content but an empty string or with a box that paints (an icon
     font's glyph, a status dot), or by its tag: `svg`, `img`,
     `canvas`, `video`, a form field, `progress`, `meter`, `iframe`,
     `object` or `embed`. The page reads outlines (WRAPPER_PROPERTIES)
     and the pseudo-elements with content (`pseudos`) for this. Without
     them, a story root holding only a `<progress>`, an outlined box or
     an icon-font glyph read as drawing nothing, and an open overlay
     elsewhere on the page was measured instead (checked in Chromium on
     static pages).
   - The variant records `portal: true` beside `element`, for this and
     for content found by its slot or `aria-controls` as before.
     `matchedSelector` already said `portal ...`, but styles.json didn't
     keep it.
   - The shadcn registry has no story that renders a dialog, sheet or
     popover open: each opens in a play function. Their Default stories
     still measure the closed trigger, with the warning as before.

# After the third live push: verify's caveats and the request limit

Notes LC1 on, from the CLI fixes after the third live push (Figma file
UPmguLPQ7w1ESdOZsq6vlw).

LC1. **verify says every warning snap wrote about a scored component**
   (section 5.4 extended). The element-tree snap writes warnings verify
   had no caveat kind for, so that push's verify printed none of them and
   its `--json` had `caveats: []`, although snap warned that Attachment's
   and Sidebar's values measured alike and that Badge's and Button's were
   set through the preview. New kinds: `identical-values` (as `prop=value`),
   `no-op-properties` and `font-not-rendered` (first named `font-stand-in`,
   BV4), read from snap's own words
   (`parseSnapWarning` in snap.ts, tested against each function that writes
   them); `preview-set`, from the variants' `appliedVia` and the reasons a
   story change fixes, as snap's warning is; and `snap-warning`, any other
   warning, as written (`unsaidWarnings`), so none is dropped. A warning
   whose caveat the measurements don't bear out is said as written too.
   The shared-key warning is left to `snapIssues`. `snapWarnings` keeps its
   meaning, variants not measured. A 0.4.0 snap's warnings are all of kinds
   it had, so the push2 replay's JSON is unchanged. The caveats print
   right under the score's lines, before the element drift, which on that
   push filled 40 lines between them.
LC2. **Each MCP request has `--request-timeout`, five minutes by default**
   (no section; 0.4.0's `--connect-timeout` held connecting and every
   request alike, at 60 seconds). coder's Storybook, which Vite builds as
   each component's docs are asked for, took 30 to 70 seconds a docs
   request, so runs on it failed unless the user knew to raise the flag.
   `--connect-timeout` now holds connecting alone, and `list`, `map`,
   `inspect`, `snap` and `diff` take `--request-timeout`, named in the
   error when a request runs out (`requestTimeoutError`). Without it a
   request has five minutes, or `--connect-timeout`'s limit where that is
   longer (`requestLimit`), so a run that raised `--connect-timeout` for a
   slow Storybook, as the skills said to, keeps its limit. A
   `--connect-timeout` shorter than a slow request no longer fails it.
   Node's fetch has limits of its own, five minutes for an answer's
   headers and five between parts of its body, which held every request
   to five minutes whatever the flag said: a stand-in answering after
   310 seconds failed as "fetch failed" at 301 seconds, or, streaming as
   addon-mcp does, had its answer cut off and timed out at the flag's
   600. The MCP transports now fetch through a dispatcher of Node's own
   kind with those limits off (`untimedFetch`), and cli-connect's test
   shortens Node's limits to 400ms to hold that.

# Fix pass 5, snap side (after the fourth live push)

Notes S1 on. The fourth live push (Figma file nCldItWrdQWKueFNy5dPZM)
scored 100% with the layout right, but Figma cut Attachment's title
("sales-dashboard.p…") that Storybook showed whole, and Button's icon sizes
held a label spilling out of their square.

S1. **Figma rounds each advance and kerning value to a 1024th of an em**,
    as HarfBuzz does with the font scaled to 1024 units an em, a variable
    font's deltas rounded on their own: 1845 advances and 7632 kerning pairs
    of Inter at its nine weights come out so in the fourth push's text probe
    (`spikes/figma-width-probe-1.js` to `-4.js`, its responses
    `fixtures/figma-text-probe-3.json`, unchanged). Chrome sets the
    package's Inter unrounded, so "sales-dashboard.pdf" (Medium 14) was
    139.375 wide in Chrome and needs 139.39843 in Figma: snap measured the
    title's column 139.38 wide, and Figma cut it. On a fresh text Figma
    keeps a line whole only at its own width, 139.4 and not 139.39. The
    third push's call 2 resized one text again and again, which Figma stops
    wrapping (its textAutoResize ends NONE, `sameNode`), so its thresholds
    (T5) described that text.
S2. **The faces snap draws in carry Figma's widths** (`fonts/`, written by
    `scripts/figma-stand-ins.py` with fonttools and uharfbuzz from the same
    packages): Inter's Latin subset as nine static faces, one a weight,
    each instanced and rounded as Figma rounds it, and Roboto Mono's
    upright Latin and Latin Extended, every advance 1230 of 2048 units as
    Figma sets it (the package has 1229). Each is renamed, as the OFL asks
    of a modified font, and ships in the package's "files" with its license
    (`fonts/OFL-*.txt`) and `fonts/manifest.json`, their digests, which
    `fonts.test.ts` holds them to. Inter's other subsets stay variable from
    the package, under a family of their own, `storysync Inter scripts`,
    after the rounded one: Chrome picks one set of faces by weight and
    doesn't look past it for a glyph, so static Latin faces and variable
    others in one family set "a" in Times at some weights. Roboto Mono's
    italics (1202, already whole) and Noto Serif are as their packages ship
    them. resolveFontFamily and the tree reader skip the second family
    where they read the family asked for after the stand-in.
S3. **Proof.** `scripts/figma-font-metrics.mjs`, which acceptance runs
    with `--check`, sets each of the probe's strings in Chrome in the
    stand-in and prints how far each family is from Figma's widths: Inter's
    37 strings and Roboto Mono's 3 are within 0.00001px, the probe's own
    rounding, and it fails above 0.001px. Noto Serif is 0.21px narrower
    than Figma at Bold 20 ("Quietly Waving"), as its faces aren't rounded
    yet; its Regular strings are within 0.011px, and rounding Regular's
    advances to a 1024th gives Figma's widths exactly, so the same script
    can round it once it carries Noto Serif.
S4. **The mock follows the same data.** `fixtures/figma-fonts.json`,
    measured in Chrome from the faces snap draws in, sets every Inter and
    Roboto Mono string of the probe within 0.002px of Figma (its advances
    are kept to 0.00001em), and the mock keeps a line whole only in a box
    at least as wide (`FITS`, float noise), where it allowed 0.01px. The
    fourth push's first call, run in the mock, wraps the title at 139.375,
    139.38 and 139.39 and keeps it whole from 139.4, as Figma did. The mock
    rounds a size to 0.01 as it is set, so where it keeps a line whole can
    sit up to 0.007px from Figma's.
S5. **Each variant from the story that is for it** (`cli/snap-stories.ts`;
    section 6.1 measures every variant from one story). The fourth push
    measured Button from WithIcon (`--stories`), so each icon size held
    "Login with Email Button" spilling out of its 34px square. Once a
    story has loaded, snap reads each of the component's stories' own
    annotations from Storybook's preview (`loadCSFFileByStoryId`, Storybook
    7 on): its own args, not its component's, and whether it has a render,
    decorators or a play function of its own. A story is for the values its
    own args give the variant properties, less those a story that draws
    nothing of its own also gives them: Icon sets `variant=secondary` and
    `size=icon`, and Secondary sets `variant=secondary`, so Icon is for
    `size=icon`; WithIcon sets what Secondary does, so it is for nothing.
    Nor is a story for what another sets where it holds all of that
    story's own args and adds more (S8). A variant is measured from the
    story that draws something of its own (an arg that is no variant
    property and no function, or its own render or decorators) and that is
    for values the variant all has: the most of them, then the plainest
    (S8), then the first; never one with a play function. Every other variant comes from the
    component's story. On shadcn's Button that is each `size=icon`,
    `icon-sm` and `icon-lg` variant from Icon, Icon Small and Icon Large,
    and the rest from Default. The first variant measured is measured
    again where the stories, read after it loaded, give it another. A
    variant from another story records it as `storyId`; snap prints a line
    a component saying which, and verify a `variant-stories` caveat, said
    beside the score, not warned. A preview that can't give the
    annotations leaves every variant on the component's story, with a
    progress line.
S6. **`--stories` names the component's story** rather than every
    variant's: it measures each variant no other story is for, so a push
    that names WithIcon for Button still measures its icon sizes from the
    Icon stories. Its checks are as before (D's notes), and `--merge` still
    keeps the component's story of the snap it adds to.
S7. **Content past its box** (`contentOverflow`, `describeOverflow`). A
    variant whose content draws more than 1px past its root's box, which
    Figma shows spilling out, is warned of once a component: the variants,
    by the values they share where the others don't have them, how far and
    on which sides, the elements, the story they came from, and that a
    story whose own args set those values and give them content that fits
    would be picked, naming one that is for another value of the same
    property, or `--stories`. What draws counts (text across by its
    glyphs unless it cuts itself off and down by its lines (S10), vectors,
    images, frames with a fill or a border),
    not what the root or an element around it clips, nor anything
    positioned absolutely, transformed, hidden or fully transparent, or in
    such an element, nor shadows and outlines, which no box holds. verify
    says it as written, as a `snap-warning`.
S8. **The plainest story wins a tie** (review of S5). The first live
    snap after S5 measured shadcn/ui Toggle's `variant=outline` variants
    from WithText, whose own args are `{ ...Outline.args }` and whose
    render adds an "Italic" label, as both were for `variant=outline` and
    the tie went to the story that set more of its own: Figma got 78px
    outline toggles with a label beside 36px icon-only defaults, and no
    warning, as the label fit. A story that holds every one of another's
    own args, as recorded, and adds an arg, a render or decorators that one
    lacks is now for none of the values that one is for (`decorates`), and
    a tie goes to the story that sets the least of its own, then the
    first. Toggle's outline variants come from Outline.
S9. **A CSF2 story draws with a function of its own.** Storybook keeps a
    story that is a function (`Template.bind({})`) as its `userStoryFn`,
    which it renders in place of any `render`, and gives it no `render`
    of its own. storiesOwnInPage read only `render`, so such a story whose
    args named only variant properties counted as one that adds nothing,
    and took those values from the keys of the stories that do: a
    function story with `{ size: "icon" }` left Icon for nothing. It now
    counts as having a render.
S10. **Text draws down to its lines, not its content area.** A text's
    `ink` is the union of its client rects, the font's content area, 17px
    tall for 14px Inter, not the glyphs' own bounds. Measured by it, any
    `leading-none` text flush with its root reached 1.5px past it, so a
    stock shadcn/ui Label (root 14px, text box [0, -0.5, 127.23, 14], ink
    [0, -1.5, 127.23, 17]) was warned of, with advice it couldn't follow,
    and `--strict-warnings` failed. contentOverflow now takes a text's
    extent across from its ink and down from its own box, its lines, which
    the build sets it to.
S11. **`--stories` with `!` measures every variant from one story**
    (review of S6, S7). S6 left no way to undo a story snap picked for a
    variant: `--stories` sets only the component's story, so Toggle's
    outline variants stayed on WithText whatever it named, and the
    overflow warning's `--stories` advice couldn't help variants from a
    picked story. A story ending in `!` (`ui-base-toggle=ui-base-toggle--
    default!`) now measures every variant, snap reads no stories' args for
    it, and the component records `storyOnly: true`, which `--merge` keeps
    and an audit passes back as `!` (the skills' Audit step, the diff
    command). `--stories` without it still sets only the component's
    story, so an audit's pairs from styles.json reproduce the push's
    per-variant picks. describeOverflow now advises by where the variants
    came from: for the component's story, a story for their values (its
    example never one they came from) or `--stories`; for a story snap
    picked, that story given content that fits or `!`; for a component
    named with `!`, another story or dropping the `!`. The Cursor rule says
    all of this as the Claude Code and Codex skills do, and setup.test.ts
    holds all three to it.
S12. **A failed read of the stories' args is tried again, and recorded.**
    A read that failed, after a render error or a navigation, left the
    component on its story for every variant with only a progress line, so
    two runs could measure different content with nothing in styles.json
    to tell. Now a failed read is tried again with each later variant that
    loads, up to `READ_STORIES_TRIES` (3); one that succeeds after a
    variant was measured that a story is for starts the plan over, as new
    argTypes options do, so no variant keeps the wrong story's content.
    Where every try fails, the component records why as `storiesUnread`,
    which snap's output and verify's `variant-stories` caveat say.
S13. **A set's description says which variants a story of their own
    measured.** S5 said it in snap's output and verify only, so someone
    looking at a pushed set couldn't see that some variants came from
    another story. The label call's line for a set (`labelLine`) now adds
    describeVariantStories' line after any closed-trigger or wrapper note,
    joined by "; ", so plan.json's label call and the set's `storysync:`
    description line both carry it. The template is unchanged.
S14. **A box that holds text is rounded up to 0.01** (review of S2-S4).
    With the stand-ins as wide as Figma, snap still rounded every box to
    the nearest 0.01, so about half of all one-line labels got a box up to
    0.005px narrower than Figma's width for them, and Figma, which keeps a
    line whole only at its own width or wider, cut them short: push 4's
    cut title, for "financial-model.xlsx" (134.38068 in a 134.38 column)
    as for 1101 of 2304 synthetic file names. buildTree now rounds the
    width of a text's line box, and of every element or pseudo-element
    that holds text, up to 0.01 (float noise under a millionth of a pixel
    taken off first), and every other box as before. An ancestor's width
    is rounded up from its own raw width, so a filling text has at least
    its raw width inside it however its padding rounds. Package T's
    fixtures, rounded to the nearest, are up to 0.01 narrower and are
    compared allowing that. build-template.test.ts builds the Attachment
    with that title in the mock: whole, with no fallback, where to the
    nearest it was cut short.
S15. **Inter's stand-in carries its symbols** (review of S2). The
    package's Latin subset has no ←, → or ✓, so Chrome set them in a
    platform font, "Next →" 0.65px narrower than Figma at Medium 14, and
    the mock, at 1em, wider; 27 of the probe's advances were off. Each
    rounded Inter face is now made from Inter 3.019 whole, the
    Inter[slnt,wght].ttf Google Fonts shipped (the build the package
    subsets; `figma-stand-ins.py --inter`, its digest pinned), upright,
    subset to the package's Latin and every symbol Inter has from U+2000
    to U+2BFF (356: arrows, check marks, a Mac keyboard's keys, shapes),
    then rounded as before; about 42KB a weight, from 23KB. The manifest
    records each face's characters (`unicodeRange`), which fonts.ts uses
    in place of the package's Latin range. The whole font's kerning
    subtables come out rearranged once instanced (S16 says how values
    carry over). Regenerating also
    fixed a descent the committed faces had a unit off (-495 for -494 of
    2048), so Inter's AUTO line height is Figma's 1.21em, not 1.211.
    figma-font-metrics.mjs now proves each of the probe's 207 characters
    alone at every weight too: within 0.000005em. mock-figma.test.ts holds
    figma-fonts.json to the same.
S16. **Noto Serif's Latin faces are rounded too** (review of S3). They
    were left unrounded for want of fonttools, so "The quick brown fox"
    (Regular 16) was 158.432 in Chrome and the mock against 158.43749 in
    Figma, and a box snap measured could cut it. figma-stand-ins.py now
    writes Noto Serif's Latin faces, upright and italic, one a weight, as
    Inter's (about 17KB each, 306KB in all), with its OFL; its other
    subsets stay variable under `storysync Noto Serif scripts`, as Inter's
    do. Both Regular strings of the probe now come out within 0.00001px,
    and the metrics proof and the mock hold Noto Serif to the tolerance.
    Its one Bold string ("Quietly Waving", 20px) doesn't: 155.21484 against
    Figma's 155.05859, and no weight of Noto Serif 2.015 sets it as wide
    (the closest, 695, is 0.08px off), so Figma's Bold is another release.
    It is printed, not held (OTHER_RELEASE). Chrome sets it wider than
    Figma, so nothing is cut. A probe of Noto Serif's advances at each
    weight, as the fourth push's call 2 read Inter's, would let the script
    take its widths from Figma itself: planned, as it needs a live call.
    Each kerning value is now set in the variable font before it is
    instanced, its delta dropped, as the instancer rearranges Noto Serif's
    kerning subtables, so values no longer go by position.

# After the fourth live push: the build, the readback, verify and the CLI

The fourth live push (Figma file nCldItWrdQWKueFNy5dPZM, agents/push4)
verified 872 of 872 elements. Yet Figma cut short a title the browser
drew whole, and the agent's paste of one call differed from its file by a
character. These notes are numbered BV1 on.

BV1. **The build template's budget is 18,000 and the readback's 9,000**
   (section 8.2's 16,000, which L1 and T15 had taken to 17,000, and 9.1's
   8,000), to make room for the call checksum (BV2) and the readback's
   truncation check (BV3). `templates.test.ts` says why each is safe and
   holds them to it:
   - A build call is template, the guard of BV2 (about 700) and DATA,
     packed to 45,000, so a packed call keeps over 26,000 for DATA. Each of the fourth push's 100 variants, in a
     call of its own, took 1,364 characters beside the template at the
     median and 7,454 at most: the 1,000 costs a packed call less than
     one variant.
   - A variant alone may take use_figma's 50,000: over 31,000 of DATA,
     four times that push's largest.
   - A read call is its template and a short header, and what it returns
     is held by LIMIT, not by its code.
BV2. **Every call checks a checksum of its own data before it does
   anything** (no section; 8.1 and 9.1 list the constants a call writes).
   The agent sends a call by pasting the file, up to 45,000 characters,
   and push4's agent typed `1.790` for `1.79` in an icon's path in call
   02: numerically the same, but nothing would have noticed a change that
   wasn't.
   - figma code writes `const SUM = "<fnv1a32>";` after a call's
     constants (`callConstants` in `cli/checksum.ts`): FNV-1a over
     `JSON.stringify([...values])`, the values in the order the call
     declares them, DATA for a build or label call, PAGE for images, and
     PAGE, SLICES, LIMIT and TPL for a read, a continuation included.
   - The call computes the same from the values it was given, before its
     template runs, and throws `This call differs from the file storysync
     figma code wrote: its data fails its checksum, SUM. Nothing was
     changed. Send the file again, exactly as it is.` A build refuses
     before it creates its page, a read before it switches to one. JSON.stringify of values
     parsed from what JSON.stringify wrote is the same text, so an honest
     call always matches, and a character changed anywhere in its values,
     inside a string too, doesn't (a number written longer but equal, as
     `1.790` outside a string, is the same value, and passes).
   - The template has its own checksum, TSUM (`callCode` in
     `cli/checksum.ts`). It is 17,000 of a build call's 45,000, and a
     digit mistyped in keepLines' 1.27 or a tolerance changed every build
     without a word. figma code writes the template as the function
     `const T = async()=>{...};`, TSUM as FNV-1a over that text, and a
     guard after it that checks SUM, then TSUM, and returns `await T()`,
     refusing a changed template with `... its template fails its
     checksum, TSUM. ...`. The guard reads T back as `String(T)`: ES2019's
     Function.prototype.toString gives a function's exact source, as V8
     does. Whether Figma's plugin runtime does is not yet seen: it takes a
     live call, and this pass was offline. So the guard compares TSUM only
     where `String(P)` gives back exactly the text of P, an async arrow
     function with a line break in it (`TC`): a runtime that strips
     source, or code rewritten on its way, line ends included, skips the
     check rather than refusing every honest call. The build returns TC as
     `tc`, so the next live push's first build result settles it: `tc: 1`
     is the check running, `tc: 0` the evidence that Figma can't give the
     template back. Tested in the mock both ways, a runtime that strips
     source standing in by Function.prototype.toString.
   - SUM is checked before the template runs, so before the readback's
     TPL: a TPL changed on its way reads as a call to send again, not as
     `This is readback template 3, not 2`.
   - The guard itself, about 700 characters, isn't covered: a change there
     mostly fails to parse, or refuses every call. The templates no longer
     check SUM themselves; minified, they are ASCII only (terser
     `ascii_only`), the build's 16,834 characters and the readback's
     8,249. A template that declares a constant its call writes no longer
     fails to compile (T's scope shadows it), so `assertCompiles` compiles
     each template after its call's constants too, and refuses it as
     before.
   - Each constant is written in ASCII (`asciiJson`): every character
     past it as its `\u` escape, inside a string, where JSON and
     JavaScript read it alike. A no-break space an agent retyping the
     call turns into a space would fail SUM on every resend; written
     `\u00a0`, it can't be. SUM is over the values, so it doesn't change.
   - `CALL_CONSTANTS` ends each kind's list with `SUM`. Tests that need a
     call figma code doesn't write change a constant with `withConstant`
     (`figma-build-harness.ts`), which writes the SUM again.
BV3. **The readback says whether Figma cuts each text short, and verify
   scores it** (sections 9.2 and 10.2; T21). Push4 drew all 15 horizontal
   Attachment titles as "sales-dashboard.p…" where Storybook showed the
   name whole, and scored them 100%: truncation ENDING at one line, as
   measured.
   - Readback template 3 adds `cut` to the end of a T record, after its
     id, so `RECORD.T` is 24 (`RECORD_BY_TPL` keeps template 2's 23). For
     a text with ENDING, the template clones it, loads its font, sets the
     copy to HEIGHT with truncation off, and reads its height: taller than
     the text by half its font size, the copy holds lines the text cuts
     off, and `cut` is 1, else 0. The copy goes in a `finally`, so a read
     changes nothing it reads. A text without ENDING is 0 with no copy; a
     text of mixed fonts or sizes, or one whose font won't load, is null.
     Height, not width: it is Figma's own line breaking that decides, and
     T5's threshold for a line kept whole is in it.
   - verify's `truncation` passes only where the settings match as before
     and, where `cut` is 0 or 1, it equals the browser's: on one line with
     an ellipsis (`el`), the browser cut a text whose ink runs past its
     box by more than 0.5px; with a line clamp (`cl`), one that took more
     lines than the clamp (Chrome lays out the lines it hides: checked in
     Chromium 154). `cutInBrowser` in verify-tree.ts, written apart from
     the build's textWhole (D9). The difference reads `truncation measured
     {"maxLines":1,"cut":false}, Figma {"truncation":"ENDING",
     "maxLines":1,"cut":true}`. The property count doesn't change.
   - Template 2 entries, with 23-field T records, still verify, scored on
     the settings alone; a template 3 entry with 23 fields was read with
     the template cut down, and is incomplete. Where a text truncates and
     its entry has no `cut` (template 2) or a null one, `cut` is listed as
     unscorable, so the coverage line doesn't say every property was
     scored.
   - The fixtures were measured in system-ui, so in Figma's Inter the
     faithful harness now drifts 2 Attachment titles and 5 Sidebar labels
     on this, and tree-e2e, whose build widens what it can (T14), drifts
     exactly the texts its build responses name `cut short`: Attachment's
     2 horizontal titles. Those tests hold both counts.
BV4. **The caveat for a font the browser couldn't render is
   `font-not-rendered`**, first named `font-stand-in` (LC1). Since T10,
   `fontStandIns` names the stand-ins snap draws text in on purpose,
   Figma's fonts, which are no caveat at all, and the two read as one.
   Nothing persists a caveat to read back: verify draws it each run from
   the warning snap wrote in styles.json, whose words are unchanged, so a
   styles.json from before gives the new kind, and no old name is kept.
BV5. **verify prints its coverage line at 100% too** (section 10.6 shows
   it with something unscored): `coverage 100.0%: every property was
   scored`. The skill has the agent report coverage, and push4's verify
   printed none, with nothing unscored. It is left out only where nothing
   was compared at all.
BV6. **A clamped text shows at most its clamp's lines** (section 10.2's
   `lines`). `n` counts the lines Chrome lays out, the ones a clamp hides
   included (BV3), and Figma shows at most maxLines, so `lines` expects
   `min(n, cl)` for a clamped text: one both cut at two lines of five
   drifted `lines measured 5, Figma 2` though the two agree.
BV7. **An ellipsis is measured against the box it ends the text at**
   (BV3's `cutInBrowser`). snap gives a `#text` run in a frame the box of
   its glyphs, so its ink always spans its box, and an ellipsis on a run
   in a `truncate` element with padding, a background or centered content
   (which stays a frame) read as drawn whole: verify reported Figma's cut
   backwards, or missed it.
   - A `#text` run is measured against its parent's content box (the
     parent's box less `L.pad` and `bd.w`), where the parent lays it out
     in a block. In a flex or grid parent the run is an anonymous item
     that text-overflow doesn't reach: Chrome 155 clips it with no
     ellipsis (a padded `truncate` div drew one, its `display: flex` twin
     didn't, compared by screenshot against `text-overflow: clip`), so
     it is not cut, as Figma's clipping frame shows it.
   - An input's `#value` has the input's content box and snap caps its
     advance there, so a value whose ink fills its box ran past it.
   - A pseudo-element's text is measured as its box: its `cut` is listed
     as unscorable, and truncation is scored on the settings.
   - Planned: the build makes a cut `#text` run as wide as its glyphs, so
     Figma holds it whole and its frame clips it, with no ellipsis. verify
     now reports that as drift on truncation; building the run at its
     parent's content width needs snap to measure it there too, or every
     such run drifts on its width instead. A text element that is only
     its text and lays it out with `display: flex` (not centered, so snap
     keeps it a text) has no layout facts to tell, and still reads as cut.

# Overlays measured open (0.4.0, Tier 1 #3)

Notes O1 on. Section 2's non-goal ("Dialog and Tooltip remain closed
triggers with a label") and the "open portal capture" of section 20's
phase 3 are done: a story that renders only an overlay's closed trigger
has the overlay opened, and its content measured through the portal path
that stories rendering it open already took.

O1. **How snap opens one** (`snap-browser.ts` openOverlay). First the
    story's `open` arg, else `defaultOpen`, set to true through Storybook's
    preview (`updateStoryArgs` and a remount), where the story's argTypes
    or the component's documented props have it (`snap-args.ts` openArg);
    never one the variant sets itself. Then the trigger, as a user opens
    it (`snap-normalize.ts` openInteractions): right-clicked for a context
    menu's, hovered over for a tooltip's or hover card's (by slot, or
    Radix's `data-state` with no `aria-haspopup` or `aria-expanded`),
    clicked for anything else; then the other ways in turn. Each way waits
    OPEN_WAIT_MS (3000), or --timeout where that is shorter, for content
    in a portal, or inline where the open trigger's `aria-controls` names
    it, as Headless UI's menu renders its items beside its button; one
    that opens nothing is undone (the arg reset with
    `resetStoryArgs`, Escape, the mouse moved to -1,-1, focus dropped).
    The registry's shadcn overlays need no arg: none of their docs list
    `open`. vaul's Drawer does, and opens by it.
O2. **Settling.** Once open: fonts, images and stand-ins again (the
    content mounted after the story's own settle), then the content's
    animations that end (`getAnimations({ subtree: true })`, those with a
    finite end) and its boxes and its children's unchanged for 3 frames,
    within OPEN_SETTLE_MS (2000). snap's stylesheet already stops CSS
    animations and transitions, so Radix's Presence mounts at once; this
    waits out what scripts move, as a popper's placement.
O3. **Closed again** after it is measured, whatever came of it: the arg
    reset, or Escape, the mouse off the page and focus dropped, and up to
    CLOSE_WAIT_MS (1000) for the content to go. Each variant navigates
    afresh anyway; navigation carried no hover over in a probe.
O4. **A select's field is opened too**, and its listbox measured, as the
    plan lists Select among the overlays. A field that opens nothing
    (clicked only) is measured as the field, with no note, as before:
    closed, it is the component. `[role="listbox"]` joined
    OVERLAY_SELECTOR. A designer who wants the field instead has
    `--no-open-overlays`.
O5. **chooseMeasuredElement** (section 6.1, "unchanged") gains two
    things: an open trigger whose `aria-controls` names an element inline
    in the story measures it (`content`), one whose `aria-controls` names
    nothing (Radix's tooltip at `delayed-open`, a hover card) takes the
    overlay showing, and `data-state` ending `-open` counts as open; and a
    closed trigger or a closed select's field comes with `trigger`, the
    ways to open it. StoryNode reads each element's `id` for the first.
O6. **styles.json.** A variant snap opened records `opened`: `{ via:
    "click" | "hover" | "focus" | "contextmenu", trigger }`, or `{ via:
    "arg", arg: "open" | "defaultOpen", trigger }`, beside `portal: true`
    and the content's `element`. meta.json records `openOverlays: false`
    for a `--no-open-overlays` run. snap says each on an `i` line
    (`measured open: snap clicked ... to open it, and measured ...`), and
    verify as the `opened` caveat, said like `variant-stories`, never
    warned.
O7. **A trigger snap couldn't open** keeps today's warning and label
    (section 8.11), now with why, from every attempt in order
    (describeOpenFailure): `snap didn't open it (clicking it, hovering over
    it, focusing it and right-clicking it opened nothing within 3000ms
    each)`; `... opened it, but snap found nothing it opened to measure`;
    `... failed (<error>)`; or `it was run with
    --no-open-overlays`. The wait is fixed, not what --timeout left, so
    every variant the same way says the same. parseMeasurementWarning reads
    the reason back up to the sentence after it; verify's `closed-trigger`
    caveat carries it as `reason`, and the label line ends `, as snap
    didn't open it (<reason>)`, its double quotes dropped.
O8. **Spec problem: a text leaf taller than its lines** (section 6.2's
    collapse). The opened Dialog's Cancel is a `<button>` with no padding
    that the footer stretches to 36px; a button centers its label without
    flex (A8 covered flex and grid only), so as a text node 36 tall Figma
    set it 20 tall at the top, and the footer's padded Continue button,
    filling across a row that hugged the text, came out 20 tall too. An
    element whose box reaches more than 1px above or below its text's line
    box now stays a frame, its `#text` at its line box, as A8's do.
O9. **The `dialog` fixture** is the ui-base-dialog story as snap measured
    it live, opened by a click, written by snap's writer with only the
    `fixture` block added. tree-e2e pushes it through the mock Figma, and
    pushes a closed trigger's warning with its reason too.
O10. **Spec problem: an overlay's content is placed from outside it**
    (section 6.9). anchorToRoot moved an `absolute` element with nothing
    positioned around it in the tree inside the root, as the page placed
    it. An opened Tooltip's arrow is such an element: its containing
    block is Radix's popper wrapper (`fixed`, translated) or Base UI's
    positioner, around the measured content, so the arrow, drawn 5px
    below the 28px bubble, moved inside it and the pointer was lost. For
    content in a portal or an overlay snap opened, the page now reads
    the computed values of each element around the root up to `<body>`
    (RawTreeCapture's `around`), and what positions or holds fixed
    elements there places what it holds, as one inside the tree does:
    the arrow keeps where it drew, `abs: 1`, past the root's box. Any
    other root reads nothing around it, so a story's own wrappers still
    place nothing.
O11. **The pointer leaves what a click opened** before it is measured.
    Radix's and Base UI's item-aligned Select opens its listbox over the
    field, under the pointer the click left there: Chromium hovered and
    highlighted its first item, and Figma got `bg-accent` on "Apple", a
    state a designer draws as hover. Once a click, a right-click, focus or
    an arg has opened it, the mouse moves to -1,-1, and the content
    settles after; only content hovering opened keeps the pointer on its
    trigger. Content that closes as the pointer leaves opened only while
    hovered over: that way's note says `... opened it, but it closed again
    as the pointer left`, and the next way is tried.
O12. **A way that leaves the trigger open** with nothing snap measures
    (it found no content, or the content closed as the pointer left), and
    that Escape doesn't close, has the story mounted again through
    Storybook's preview (`forceRemount`, applyStoryArgsInPage's `remount`)
    before the next way, so each starts from the story as it rendered,
    and the trigger is measured closed. Before, the next ways ran on an
    open trigger and the capture measured it open, its closed-trigger
    note dropped. Where a remount doesn't close it either, snap tries no
    other way, measures what is there, and keeps the trigger's note as
    it was found, its reason ending `it stayed open, though snap mounted
    the story again` (or why it couldn't).
O13. **A field that opens nothing, where others opened.** O4 measures a
    select's field that clicking opens nothing as the field, with no
    note: closed, it is the component. In a set where other variants
    opened (a disabled variant beside enabled ones), the Figma set then
    mixed listboxes with closed fields, said only by the `i` line's "in
    1 of 2 variants". The capture now returns the field and why
    (`unopened`), and where any variant of the component opened, snap
    notes each such variant as a closed trigger with that reason: the
    warning, the label line and verify's caveat, as for any trigger it
    couldn't open. Where none opened, nothing changes.
O14. **What earlier variants found** (`OpenMemory`, one per component,
    by story). Every variant tried every way: a trigger nothing opens
    took about 12s a variant, and the live registry run took 10:40
    against 3:17, mostly Drawer's. Now the way that opened an earlier
    variant of the story is tried alone, as a variant it doesn't open
    is one its args hold closed (a disabled trigger), the note ending
    `; snap tried no other way, as clicking it opened an earlier
    variant`; and where no way opened an earlier variant, only the first
    way is tried again, its note that variant's where it again opened
    nothing, so the warning groups them. A variant that sets `open` to
    false holds a controlled overlay closed, and snap tries nothing:
    `the variant sets its open arg to false, which holds it closed`.
    `defaultOpen` set to false only starts it closed, and snap opens it
    as a user does. Area A leaves both out of the variant axes; until it
    lands, Drawer's `open` is one.
O15. **Spec problem: a `rotate` or `scale` of its own** (section 6.9's
    transforms). snap read a turn from `transform` alone. Tailwind 4 sets
    `rotate-45` as `rotate: 45deg`, which `transform` doesn't show, so
    the opened Tooltip's arrow, a 10px svg turned 45 degrees, was read as
    an unturned 14.14px square with nothing flagged, and its triangle
    stretched into it. A `rotate` or `scale` other than none, 0 or 1 now
    turns an element as a transform does: `tf` says it (`rotate: 45deg`,
    after any matrix), `approx: "transform"`, and its box is its own
    size centered where it drew (an `<svg>`'s CSS size, as it has no
    offsetWidth). A `translate` stays in its box.
O16. **The `tooltip` and `select` fixtures** are the ui-base-tooltip and
    ui-base-select stories as snap measured them live with O10, O11 and
    O15, opened by a hover and a click, written by snap's writer with
    only the `fixture` block added. Every fixture test takes them: the
    tooltip's arrow, placed by Base UI's positioner and turned 45
    degrees, builds as its own 10px box at 45.5,21, past the 28px
    bubble, its turn unscored (`transform`), as verify leaves it; none
    of the select's 14 items paints. Two fixture checks met what CSS
    does here: the build harness's shape check skips a vector snap
    measured only roughly (`approx`, or a raster), as verify's shape
    gate does, and the check that an in-flow node lies inside its
    parent skips a parent that clips, as the listbox scrolls its groups
    past its bottom and hangs its separators 4px past its sides.
