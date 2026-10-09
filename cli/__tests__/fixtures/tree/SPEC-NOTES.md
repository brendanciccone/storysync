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
    - A frame is FIXED on any axis a child fills, along it (a grower) or
      across it (a stretch), while `SPIKE.fillAcrossHug` is false.
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
    timing (item 8) can be compared with real calls.
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

## What waits on the spike

Every spike-dependent constant is in `SPIKE` in `cli/figma-spike.ts`, with
where it acts. The template's run-time fallbacks are marked `SPIKE(n)` in
`templates/build.js`.

| Item | Fallback used now | How to switch |
|---|---|---|
| 1, SVG stroke scaling | `svgStrokesScale: false`: import at the viewBox's size and rescale, right either way | true once import scales strokes |
| 2, shadow spread | try, and on refusal spread 0, listed | nothing to switch |
| 3, textTruncation | try, and on refusal a fixed text box of the measured size, listed | nothing to switch |
| 4, absolute children | `absoluteInsetByStroke: false`: x and y from the frame's corner | true if Figma insets by included strokes |
| 4, OUTSIDE strokes in auto layout | `outsideStrokeTakesSpace: false`: plan from frame boxes | true if they take space |
| 5, clone and plugin data | keys copied along a parallel walk, either way | nothing to switch |
| 7, return shape | an object; the parser reads an object, a JSON string or an envelope | nothing to switch |
| 8, time limit | `maxNodes: 400` records (item 31) | lower after the spike |
| 10, image bytes | the images call reuses hashes either way | C's scoring only |
| 11, fill across a hugging parent | `fillAcrossHug: false`: FIXED where a child fills | true if Figma hugs the other children |

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
   reads as unreadable, and the read goes on.
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
     and indentation, to 11,800 characters: 11,630 now, which terser takes
     to 7,865 with B's options.
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

C25. **One place a side.**
   - verify's assumptions are `SPIKE` in cli/verify-tree.ts
     (`imageBytesKept`, `shadowSpreadKept`, `textTruncation`), each the
     spec's expected answer, overridable per call through
     `VerifyOptions.spike`. The root-only boxShadow comparison reads the
     same.
   - The template's one switch is `RETURN_TEXT` (item 7).
   - Assumed with no spike item: Figma's blur radius equals CSS blur().
   - ABSOLUTE children with per-side strokes are not a switch in C. The
     template reads where a child is, its x and y from the parent's frame
     plus the parent's stroke outside it, so how Figma places an absolute
     child changes what is read, not how it is read.

## Ownership (C and D)

C26. **D wires the flags**: `--plan` (loadPlanResults, then verify with
   `notRead`, printing its `problems`), `--roots-only`,
   `--allow-designer-layers` (until then, designer layers fail `--strict`)
   and `--min-fidelity` (headlineFidelity). C changed cli/index.ts only in
   small hunks: the new caveat and issue texts, the element report, and what
   `--strict` and `--strict-measured` fail on.
