// What `storysync figma code` assumes about Figma until the spike runs.
//
// The design's Figma spike (spikes/figma-probe.js, section 14) measures, in a
// live file, the behaviors below that no documentation settles. It has not
// run yet, so the build uses the design's fallback for each, and every
// constant or branch that depends on one is named here, with where it acts.
// When the spike's results land in cli/__tests__/fixtures/figma-spike.json,
// flip the constant here and rerun the tests: nothing else needs to change.
//
// The template branches that react to Figma at run time rather than to a
// constant are marked `SPIKE(n)` in templates/build.js, with n the spike
// item: they take whichever way Figma goes, so they need no switch. They are
// item 1's failed import (an empty keyed frame), item 2's refused spread
// (left out, and listed), item 3's refused truncation (a box of the measured
// size) and item 5's clone (keys copied whether or not clone() keeps them).
// Item 7, how use_figma shows a returned object, needs neither: the result
// parser (figma-code.ts, parseCallResult) reads an object, a JSON string and
// an MCP envelope alike. Item 10, whether uploaded image bytes stay byte for
// byte, decides only how verify scores image content (package C).
//
// runFigmaCode takes `spike` to override these for one run, so the tests
// build both ways against the mock, whose options give either answer.

export const SPIKE = {
  /**
   * Item 1. Whether an imported SVG's stroke widths scale with it when its
   * `width` and `height` differ from its viewBox, as the browser's do (lucide
   * Mail's 2 at 24 drawn as 1.33 at 16). False, the fallback and the default:
   * import at the viewBox's own size and `rescale()` to the measured box,
   * which scales strokes with it, so it is right whichever answer the spike
   * gives. True, once the spike shows strokes scale on import, imports each
   * icon at its measured size and saves the rescale. Acts in figma-map.ts
   * (vectorImport), which writes the markup to import and the factor the
   * template rescales by.
   */
  svgStrokesScale: false,

  /**
   * Item 11. Whether a frame can hug its children on an axis where one of
   * them fills (FILL across, layoutAlign STRETCH) while another does not. The
   * figma-use skill documents that a hugging parent collapses filling
   * children, so the fallback is false: a frame is FIXED on any axis a child
   * fills. True lets it hug the children that don't fill, as CSS shrink-wraps
   * a block around its widest child and stretches the rest, so a wider
   * stand-in label grows its parent. Acts in figma-layout.ts (planLayout).
   */
  fillAcrossHug: false,

  /**
   * Item 4. Whether Figma insets an ABSOLUTE child by its auto-layout
   * parent's strokes when they are included in layout. The fallback is false:
   * an absolute child's x and y are from the frame's own corner, as for any
   * frame, so a child at the border box's 13,13 under a 1px INSIDE border is
   * placed at 13,13. Acts in figma-code.ts (compileVariant).
   */
  absoluteInsetByStroke: false,

  /**
   * Item 4. Whether an OUTSIDE stroke takes space in its parent's auto
   * layout. The fallback is false: a frame whose stroke is built OUTSIDE (a
   * `bg-clip-padding` border) leaves `strokesIncludedInLayout` off, and its
   * parent's spacing is planned from the frames' own boxes, which leave that
   * stroke out. True plans it from the border boxes instead. Acts in
   * figma-code.ts (prepareVariant, layoutBox).
   */
  outsideStrokeTakesSpace: false,

  /**
   * Item 8. The most nodes one build call creates or restyles. 400 keeps a
   * call under about 60% of use_figma's time limit if the spike's 500 nodes
   * time as the prototypes did; the skill lowers it with --max-nodes after a
   * `Script exceeded time limit`.
   */
  maxNodes: 400,
} as const;

/** SPIKE's shape, its answers as booleans rather than the literals they are now, so a test can run either. */
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
