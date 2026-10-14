// What `storysync figma code` takes of Figma from the design's spike.
//
// The spike (cli/__tests__/fixtures/probes/figma-probe.js, section 14)
// measured, in a live file on 2026-10-08, the behaviors no documentation
// settles; its raw results are cli/__tests__/fixtures/figma-spike.json, and
// the mock Figma the tests run on answers its probe the same. Each constant
// the build depends on is here with what the spike saw and where it acts.
// Each keeps its other answer reachable, through runFigmaCode's `spike`, so
// the tests still build a fallback against a mock that gives the other
// answer.
//
// The template branches that react to Figma at run time rather than to a
// constant are marked `SPIKE(n)` in templates/build.js, with n the spike
// item. The spike saw Figma take the design's choice in each, so they are
// guards for what it didn't try: item 1's failed import (an empty keyed
// frame), item 2's refused spread (left out, and listed) and item 3's
// refused truncation (a box of the measured size). Item 5, clone(), needs
// no constant: the copy keeps its plugin data, but lands on the page when
// what it copies is nested, so the template re-parents every copy itself.
// Item 7: use_figma returns the template's object as JSON, which the result
// parser (figma-code.ts, parseCallResult) reads, as it would a string or an
// MCP envelope. Item 10: an upload's bytes come back byte for byte, and the
// images call reuses each hash; it decides only how verify scores image
// content (package C).

export const SPIKE = {
  /**
   * Item 1. Whether an imported SVG's stroke widths scale with it when its
   * `width` and `height` differ from its viewBox, as the browser's do. They
   * do: lucide Mail at 16 from a 24 viewBox came in with its 2px strokes
   * 1.33 wide, as Chrome draws them. So true imports each icon at its
   * measured size, and needs no rescale. False imports at the viewBox's own
   * size and `rescale()`s to the box, which the spike saw give the same
   * 1.33. Acts in figma-map.ts (vectorImport), which writes the markup to
   * import and any factor the template rescales by.
   */
  svgStrokesScale: true,

  /**
   * Item 11. Whether a frame can hug its children on an axis where one of
   * them fills (FILL across, layoutAlign STRETCH) while another does not.
   * It can: a hugging column took its widest child's 120, and the child set
   * to FILL beside it stretched to that. So true lets a frame hug the
   * children that don't fill, as CSS shrink-wraps a block around its widest
   * child and stretches the rest, and a wider stand-in label grows its
   * parent. False makes a frame FIXED on any axis a child fills. Along the
   * flow, a growing child keeps its own size in a hugging frame, so a frame
   * is FIXED on the axis a child grows along either way. Acts in
   * figma-layout.ts (planLayout).
   */
  fillAcrossHug: true,

  /**
   * Item 4. Whether Figma insets an ABSOLUTE child by its auto-layout
   * parent's strokes when they are included in layout. It doesn't: under a
   * 2px INSIDE stroke included in layout, an absolute child set to 3,4 stayed
   * at 3,4. So false: an absolute child's x and y are from the frame's own
   * corner, as for any frame, and a child at the border box's 13,13 under a
   * 1px INSIDE border is placed at 13,13. Acts in figma-code.ts
   * (compileVariant).
   */
  absoluteInsetByStroke: false,

  /**
   * Item 4. Whether an OUTSIDE stroke takes space in its parent's auto
   * layout. It doesn't: a child's 3px OUTSIDE stroke left its siblings where
   * they were, and the parent's own included stroke took room only when
   * INSIDE. So false: a frame whose stroke is built OUTSIDE (a
   * `bg-clip-padding` border) leaves `strokesIncludedInLayout` off, and its
   * parent's spacing is planned from the frames' own boxes, which leave that
   * stroke out. True plans it from the border boxes instead. Acts in
   * figma-code.ts (prepareVariant, layoutBox).
   */
  outsideStrokeTakesSpace: false,

  /**
   * Item 8. The most nodes one build call creates or restyles. The spike
   * made 400 frames in 3.2 s and 100 labels in 1.4 s, each with a few
   * properties and its plugin data, and laid them out in 6 ms: about 4.6 s
   * for 500 nodes, so 400 stays. The skill lowers it with --max-nodes after
   * a `Script exceeded time limit`.
   *
   * It counts records, each a layer the build sets 20 to 30 properties on,
   * where the spike's nodes got about 5. Figma also makes layers this doesn't
   * count, each in one call: a new variant cloned from the first copies its
   * layers, an icon's import makes its shapes, and an icon that changed is
   * removed and imported again. On package A's live shadcn snap, the mock
   * made 1.5 layers a record in a call of Sidebars and 2.2 in one of
   * Attachments, whose icons change with its state.
   */
  maxNodes: 400,
} as const;

/** SPIKE's shape, its answers as booleans rather than the literals they are, so a test can run either. */
export type Spike = { [K in keyof typeof SPIKE]: (typeof SPIKE)[K] extends boolean ? boolean : number };

/** The most characters of code one call carries: use_figma takes 50,000, and this leaves room for a description. */
export const MAX_CALL_CHARS = 45_000;

/** use_figma's own limits, which nothing may pass. */
export const USE_FIGMA_CODE_LIMIT = 50_000;

/**
 * upload_assets hands out at most 60 upload URLs per call, so a build call
 * lists at most this many uploads: one per image the call's page lacks.
 */
export const MAX_UPLOADS_PER_CALL = 60;
