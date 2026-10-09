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

## Package B: where `storysync figma code` departs from the spec

Each item is also explained in a code comment where it acts, and in the
commit that made it.

### Layout (section 8.4)

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

### Calls and the plan (sections 8.1, 8.2)

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

### The build template (section 8.2)

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

### Package T's mock (shared file, small hunks in their own commits)

43. Options `shadowSpread` and `textTruncation` (`"keep"`, the default, or
    `"refuse"`), for spike items 2 and 3.
44. Option `moveNeedsFonts` (default false): appendChild and insertChild
    throw on a node holding a text whose font the call hasn't loaded. B's
    tests turn it on.
45. A page has `remove()`. It refuses the only page and the call's current
    page, which is an assumption until someone checks Figma. Page ids no
    longer repeat after one goes.

### What waits on the spike

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
