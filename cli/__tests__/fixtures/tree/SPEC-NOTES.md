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
