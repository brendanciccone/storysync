// The element tree: what snap measures under a component's root, as facts,
// and the pure helpers every side of the pipeline reads them through.
//
// snap writes these types into styles.json, `figma code` builds Figma layers
// from them, and verify scores the readback against them. Each of those is a
// separate package, so this file is the one place the shapes and the
// arithmetic on them live: if the build and verify each expanded a delta, or
// placed a child in its parent's flow, their own way, a mistake both made the
// same way would build wrong and still score 100%. Neither reimplements what
// is here, and verify never reads the build's plan, only snap's facts and
// these helpers.
//
// Facts, not Figma decisions: a box is where the browser drew the element, a
// color what it painted. Whether a frame becomes auto layout, or a text node
// hugs, is decided from them by the build and checked from them by verify.

import { canonicalJson, fnv1a32 } from "./checksum.js";
import type { NormalizedStyles } from "./snap-normalize.js";

export const TREE_VERSION = 1;

/**
 * Where snap stops walking a variant's tree: emitted nodes (text runs and
 * pseudo-elements count, an SVG counts as one), depth below the root, and the
 * characters of SVG markup kept as a vector before it falls back to raster.
 */
export const TREE_LIMITS = { maxNodes: 400, maxDepth: 24, maxSvgChars: 20_000 } as const;

/** A border box relative to its parent's border box, in px rounded to 0.01. The root's is `[0, 0, w, h]`. */
export type Box = [x: number, y: number, w: number, h: number]; // parent-relative border box, 0.01px

/** Frame, text, vector (an inline SVG), image. */
export type Kind = "F" | "T" | "V" | "I";                        // frame, text, vector, image

/** One value for all four sides, or one per side in CSS order. */
export type Sides<T> = T | [top: T, right: T, bottom: T, left: T];

/** One box-shadow layer: offsets, blur and spread in px, its color as hex, and `1` last when inset. */
export type Shadow = [x: number, y: number, blur: number, spread: number, color: string | null, inset?: 1];

/**
 * How a frame lays out its children, recorded on frames that have any.
 * Values are the computed CSS, left out where they are CSS's default.
 */
export interface TreeLayout {               // frames with children
  d: string;                                // computed display
  dir?: "row" | "row-reverse" | "column" | "column-reverse";
  wrap?: 1;
  jc?: string;                              // justify-content, when not normal/flex-start
  ai?: string;                              // align-items, when not normal/stretch
  gap?: [row: number, column: number];
  pad?: [t: number, r: number, b: number, l: number];
  tracks?: [columns: number, rows: number]; // grid track counts
}

/** A node's own facts as a flex or grid item, or a positioned box with a z-index: only those that differ from CSS's default. */
export interface TreeSelf {                 // as a flex/grid item, only non-defaults
  grow?: number; shrink?: number; basis?: string; as?: string; order?: number; z?: number;
}

/**
 * A text node's facts. `c` is the characters as the DOM holds them, before
 * `tt` transforms them; `f` the family the browser drew with (`fk` when that
 * is a CSS keyword such as system-ui, which names no Figma font, `fa: 0` when
 * a declared font failed to load, `fs` the family the code asked for where
 * snap drew `f`, the stand-in Figma sets it in, in its place: fonts.ts);
 * `col` the text's own color, not folded
 * with any ancestor's opacity; `lh` the line height in px, or `normal`; `el`
 * an ellipsis on one line, `cl` a line clamp; `n` the lines it took; `ink`
 * the glyph box relative to the node's own box; `ph` a placeholder.
 */
export interface TextFacts {
  c: string; f: string; fk?: 1; fa?: 0; fs?: string;
  sz: number; wt: number; it?: 1; col: string | null;
  lh: number | "normal"; ls?: number;
  tt?: "uppercase" | "lowercase" | "capitalize"; td?: "underline" | "line-through";
  ta?: "center" | "right" | "justify" | "end"; ws?: "nowrap" | "pre" | "pre-wrap" | "pre-line";
  el?: 1; cl?: number; n: number; ink: Box; ph?: 1;
}

/**
 * One element, text run, pseudo-element, SVG or image that draws, or that
 * takes space in its parent's flow.
 *
 * - `k` is the node's key, a `/`-joined path of `data-slot`s (else tags) from
 *   the root, whose own key is `""`; `#text` for a run of text beside
 *   elements, `#value` for an input's value, `::before` and `::after`; a
 *   repeated segment among siblings is numbered `:2`, `:3`, in DOM order.
 * - `el` names the element for people reading a tree or a Figma layer list:
 *   its tag with its `data-slot` or `role` in a selector without quotes,
 *   `span[data-slot=switch-thumb]`; an SVG's lucide class where it has one,
 *   `svg.lucide-bell`; and `::before`, `::after`, `#text` or `#value` for
 *   what is not an element.
 * - Paint is what the browser computed, every color as lowercase hex through
 *   snap's normalizeColor: `bg` the background color, `bgi` the background
 *   image, `bgc` its clip when not border-box; `bd` the border, where a side
 *   that draws nothing has width 0 and the style and color of the first side
 *   that draws, so a border left off one side still reads as one color; `r`
 *   the radii as the browser drew them, oversized ones scaled down as CSS
 *   scales them; `sh` the visible shadow layers; `op` opacity; `bm` the blend
 *   mode; `clip` overflow that clips, on both axes or one; `fl` and `bf` the
 *   filter and backdrop filter; `ol` the outline; `vis: 0` visibility hidden;
 *   `cp` a clip-path.
 * - `abs` is set for absolute and fixed boxes, which are out of flow; `tf` for
 *   a transform other than a translation, whose box is then axis-aligned.
 * - `svg` and `img` are asset ids in the component's `tree.assets`; `shapes`
 *   each painted shape's box relative to the SVG's own box, in document
 *   order; `raster` a node snap could only capture as a screenshot.
 * - `cls` is the node's Tailwind-style class evidence for variable binding;
 *   `nocls` the paint properties no class sets, so the project's base styles
 *   do: `color` on a text or icon where no class on it or an element it
 *   inherits from sets one (utilitySetsColor), `border-color` on a node that
 *   draws a border no class of its colors; `approx` names why a node's
 *   geometry is approximate.
 *
 * A fact that is absent is CSS's default, and never written as `null`: a
 * delta's `null` means "removed" (TreeDelta).
 */
export interface TreeNode {
  k: string; t: Kind; el: string; box: Box;
  abs?: 1; tf?: string; L?: TreeLayout; S?: TreeSelf;
  bg?: string | null; bgi?: string; bgc?: "padding-box" | "content-box";
  bd?: { w: Sides<number>; s: Sides<string>; c: Sides<string | null> };
  r?: Sides<number>; sh?: Shadow[]; op?: number; bm?: string;
  clip?: 1 | "x" | "y"; fl?: string; bf?: string;
  ol?: [w: number, style: string, color: string | null, offset: number];
  vis?: 0; cp?: string;
  tx?: TextFacts;                // t === "T"
  svg?: string; shapes?: Box[];  // t === "V"
  img?: string;                  // t === "I"
  raster?: 1; cls?: string[]; nocls?: NoClassPaint[]; approx?: string;
}

/** A paint property `nocls` can say no class sets. */
export type NoClassPaint = "color" | "border-color";

/**
 * An image snap saved: `file` is relative to the directory holding
 * styles.json, as a variant's `screenshot` is, so `assets/<id>.jpg` there is
 * `.storysync/snaps/assets/<id>.jpg` from the project; `size` the thumbnail's
 * pixels, `natural` the source's, `fnv` fnv1a32Bytes of the thumbnail's
 * bytes, which is all verify needs to prove Figma holds it.
 */
export interface ImageAsset { file: string; mime: "image/jpeg" | "image/png"; size: [number, number]; natural: [number, number]; fnv: string; raster?: 1 }

/**
 * A component's tree: the base variant's nodes, and the assets every variant
 * shares. `base[0]` is the root, `""`, carrying only what the root's
 * NormalizedStyles lacks (ROOT_FIELDS): its paint stays in `base.styles`.
 */
export interface ComponentTree {
  version: 1;
  base: TreeNode[];                                          // base variant, preorder, siblings in paint order
  assets: { svg: Record<string, string>; img: Record<string, ImageAsset> };
  truncated?: { nodes: number; at: string };
}

/**
 * A variant's tree as a change to the base's: `keys` when its nodes or their
 * order differ, and in `set`, for each node that differs, the fields that
 * do, `null` for one it lacks, or the whole node for a key the base lacks.
 */
export interface TreeDelta {                                 // against ComponentTree.base
  keys?: string[];                                           // full preorder key list, only when structure or order differs
  set?: Record<string, Partial<TreeNode> | TreeNode>;        // changed fields (null removes one); full node for keys not in base
}

/**
 * Where one parent's in-flow children sit in its flow, in one world: snap's
 * boxes, or the boxes read back from Figma.
 *
 * verify scores a position as right when it is right directly, or right
 * relative to the flow (section 10.4 of the design): a label drawn wider in
 * Figma's stand-in font pushes its followers along, and each follower is
 * still in the right place relative to the one before it. So flowOf gives,
 * for each in-flow child, its offset from what places it, and verify compares
 * that offset between the two worlds, along snap's axis and in snap's flow
 * order in both (flowOf's `snap`): the gap after the previous sibling, or
 * from the content start, for content packed at the start; for centered
 * content, the first child's offset from where centering the children's
 * sizes and gaps puts it, then the gap after the previous sibling; the gap
 * before the next sibling, or to the content end, for content packed at the
 * end; the difference from where the free space would put it for `space-*`.
 * Across the flow, `cross` is the offset from the start, center or end its
 * alignment names.
 *
 * `axis` is null where the parent lays its children out in no single line, a
 * wrapping flex, a grid of several columns, inline content, a table cell,
 * children that overlap: there only the direct offsets apply, and `main` and
 * `cross` are empty. `content` is the parent's content box, less border and
 * padding, in its children's coordinates; `inflow` the keys of the children
 * in flow, in flow order.
 */
export interface Flow {
  axis: "x" | "y" | null;
  reverse: boolean;
  content: Box;
  inflow: string[];
  main: Record<string, number>;
  cross: Record<string, number>;
}

/**
 * The fields the root node `""` carries in `ComponentTree.base`: what
 * NormalizedStyles has no field for. Everything else about the root, its
 * paint, size and type, is the root's styles, as it was before trees, so it
 * is never stored twice.
 *
 * Section 7.2 of the design lists the first thirteen, with frame roots in
 * mind. The rest are there because a root can be an `<svg>` (shadcn's
 * Spinner) or an `<img>`, whose markup, shapes and image no style holds, and
 * can carry a clip-path or an approximation like any node. `nocls` goes
 * with `cls`: a root's border, in its styles, takes the base styles' color
 * where no class of its colors it. A root never collapses into a text leaf:
 * a component's root is a frame in Figma, so its text is a `#text` child,
 * and `tx` stays off this list.
 */
export const ROOT_FIELDS = [
  "k", "t", "el", "box", "L", "clip", "bm", "tf", "fl", "bf", "ol", "cls", "vis",
  "cp", "svg", "shapes", "img", "raster", "approx", "nocls",
] as const;

/**
 * Readback record lengths by Figma node kind (section 9.2 of the design);
 * an image is an F record. Template 3's T record ends with `cut`, whether
 * Figma's truncation hides some of the text; template 4's every record
 * with `turn`, the layer's turn, clockwise in degrees as CSS says it.
 */
export const RECORD = { F: 16, T: 25, V: 11 } as const;                        // readback arities (section 9.2)

/** The record lengths of each readback template by its `tpl`: an entry read with template 2 has no `cut`, one read with 3 no `turn`. */
export const RECORD_BY_TPL: Readonly<Record<number, { readonly F: number; readonly T: number; readonly V: number }>> = {
  2: { F: 15, T: 23, V: 10 },
  3: { F: 15, T: 24, V: 10 },
  4: RECORD,
};

// --- plan.json --------------------------------------------------------------

/**
 * What `storysync figma code` writes: every use_figma call to make, in
 * order, each a generated file the agent sends unchanged, with where to save
 * its response. `digest` is the FNV-1a of the styles.json bytes it was made
 * from, so a plan made from another snap is told apart.
 */
export interface FigmaPlan {
  version: 1; storysyncVersion: string;
  snap: { path: string; measuredAt: string; digest: string };  // digest: fnv over styles.json bytes
  calls: PlanCall[];
  /** Each value bound by the project's base styles, where no class names its token, with the rule (section 8.9). */
  bindings?: PlanBinding[];
}

/** A paint bound to `variable` by a base style's rule, `from`, as tokens' `defaults` gives it, in the layers `keys`. */
export interface PlanBinding {
  component: string;                         // componentKey
  property: string; value: string; variable: string; from: string;
  keys: string[];                            // node keys, sorted, "" the root
}

/** One planned call. Paths are relative to the plan's directory. */
export interface PlanCall {
  seq: number; kind: "build" | "images" | "label" | "read";
  page: string; components: string[];        // componentKey list
  file: string; result: string;              // relative to plan dir
  description: string; chars: number;
  nodes?: number;                            // build: nodes created or restyled at most
  slices?: [componentId: string, firstI: number, lastI: number][]; // read
  predicted?: number;                        // read: predicted response characters
}

// --- Class evidence -----------------------------------------------------------

/** `text-*` utilities that set no color of their own: a size, an alignment, a wrap or an overflow, or the inherited color. */
const TEXT_NOT_COLOR = /^(?:xs|sm|base|lg|\d?xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|current|inherit)$/;

/** A side or corner before the rest of `border-t-input` or `rounded-tl-lg`. */
export const SIDE = /^(?:[trblxyse]|tl|tr|br|bl|ss|se|es|ee)-/;

/** What follows `border-` (and any side) that is a width, a style or a table's, not a color. */
const BORDER_NOT_COLOR = /^(?:\d+|px|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing(?:-.+)?)$/;

/** An arbitrary value that is a length, as `text-[14px]` or `border-[length:var(--w)]` are. */
const ARBITRARY_LENGTH = /^\[(?:(?:length|size|number|percentage):|(?:calc|clamp|min|max)\(|-?[\d.]+(?:px|r?em|%|v[whib]|d?v[wh]|ch|ex|pt|cm|mm|in)?\])/;

/**
 * The color property a utility in `cls` sets, its variant prefix and
 * opacity cut off, or null: a `text-*` the text `color`, unless it's a size,
 * an alignment, a wrap, or `current` or `inherit`; a `border-*` the
 * `border-color`, unless it's a side's width or a style; a `fill-*` or
 * `stroke-*` an icon's `fill` or `stroke`, unless `none` or a stroke's
 * width. A palette color (`text-neutral-950`) sets one though it names no
 * token, and so does an arbitrary one (`text-[#0a0a0a]`) that isn't a
 * length. A project's own font size (`text-body`) reads as a color here:
 * snap's page tells it apart (captureTreeInPage).
 */
export function utilitySetsColor(utility: string): NoClassPaint | "fill" | "stroke" | null {
  const m = /^(text|border|fill|stroke)-(.+)$/.exec(utility);
  if (!m) return null;
  const [, kind, value] = m;
  if (kind === "text") return (value.startsWith("[") ? ARBITRARY_LENGTH.test(value) : TEXT_NOT_COLOR.test(value)) ? null : "color";
  if (kind === "fill") return value === "none" ? null : "fill";
  if (kind === "stroke") return value === "none" || /^\d+(?:\.\d+)?$/.test(value) || (value.startsWith("[") && ARBITRARY_LENGTH.test(value)) ? null : "stroke";
  if (/^(?:[trblxyse]|tl|tr|br|bl|ss|se|es|ee)$/.test(value)) return null;
  const rest = value.replace(SIDE, "");
  return (rest.startsWith("[") ? ARBITRARY_LENGTH.test(rest) : BORDER_NOT_COLOR.test(rest)) ? null : "border-color";
}

// --- Helpers ----------------------------------------------------------------

/**
 * Rounded to 0.01. Through 1e-6 first, so float noise in a sum of rounded
 * facts (1.19 - 1 is 0.18999999999999995) can't tip a half-way value either
 * way; and never -0, which a deep comparison tells from 0.
 */
const round2 = (n: number): number => Math.round(Math.round(n * 1e8) / 1e6) / 100 || 0;

/** A copy through JSON, which is what a tree is: a field that is undefined drops out. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const has = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** A field's value, or undefined where it is absent or null: the two mean the same in a node. */
function field(node: object, key: string): unknown {
  const value = (node as Record<string, unknown>)[key];
  return value === null ? undefined : value;
}

/** The node itself, less any field that is null, which in a whole node means absent. */
function withoutNulls(node: TreeNode): TreeNode {
  const out = copy(node) as unknown as Record<string, unknown>;
  for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  return out as unknown as TreeNode;
}

function byKey(nodes: TreeNode[], what: string): Map<string, TreeNode> {
  const out = new Map<string, TreeNode>();
  for (const node of nodes) {
    if (out.has(node.k)) throw new Error(`${what} holds the key "${node.k}" twice`);
    out.set(node.k, node);
  }
  return out;
}

/**
 * A key's parent: `"card-header"` for `"card-header/card-title"`, `""`, the
 * root, for a top-level key, and null for the root itself. A `data-slot`
 * never holds `/` in a key (snap writes `∕` for one), so the last `/` is
 * always the parent's end.
 */
export function parentKey(k: string): string | null {
  if (k === "") return null;
  const at = k.lastIndexOf("/");
  return at < 0 ? "" : k.slice(0, at);
}

/**
 * Field names a delta may not set: assigning `__proto__` would change the
 * node's prototype rather than add a fact, giving it a field that reads as
 * set and that canonicalJson, and so treeDigest, never sees.
 */
const UNSAFE_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A variant's nodes: the base's, changed as its delta says, in the delta's
 * order when it gives one. Without a delta, the base variant's own.
 *
 * Throws on a delta that cannot describe a tree, rather than guessing: a key
 * listed twice, a key neither the base has nor the delta gives in full, a
 * change to a key the variant does not have, a change that is not an object
 * of fields, and nodes that are not a tree in preorder, the root `""` first
 * and every other node after its parent. Each of those is a broken
 * styles.json, and a tree expanded around one would be built and scored as
 * though snap had measured it.
 *
 * A field that is null in a base node is absent, as diffTree reads it, so
 * the round trip holds for a base written either way.
 */
export function expandTree(tree: ComponentTree, delta: TreeDelta | undefined): TreeNode[] {
  const base = byKey(tree.base, "the base tree");
  const keys = delta?.keys ?? tree.base.map((node) => node.k);
  const set = (delta?.set ?? {}) as Record<string, Record<string, unknown> | null>;
  const seen = new Set<string>();
  const nodes = keys.map((k) => {
    if (seen.has(k)) throw new Error(`the delta lists the key "${k}" twice`);
    seen.add(k);
    const from = base.get(k);
    const change = has(set, k) ? set[k] : undefined;
    if (change !== undefined && (change === null || typeof change !== "object" || Array.isArray(change))) {
      throw new Error(`the delta sets "${k}" to ${JSON.stringify(change)}, not a node or the fields that change`);
    }
    for (const name of Object.keys(change ?? {})) {
      if (UNSAFE_FIELDS.has(name)) throw new Error(`the delta sets a field named "${name}" on "${k}"`);
    }
    if (!from) {
      if (!change) throw new Error(`"${k}" is not in the base tree, and the delta does not give it in full`);
      if (change.k !== undefined && change.k !== k) throw new Error(`the delta gives "${k}" a node keyed "${String(change.k)}"`);
      const node = withoutNulls({ ...(change as unknown as TreeNode), k });
      for (const required of ["t", "el", "box"] as const) {
        if (node[required] === undefined) throw new Error(`the delta gives "${k}" in full but without "${required}"`);
      }
      return node;
    }
    const node = withoutNulls(from) as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(change ?? {})) {
      if (name === "k") {
        if (value !== k) throw new Error(`the delta changes the key of "${k}"`);
        continue;
      }
      if (value === null || value === undefined) delete node[name];
      else node[name] = copy(value);
    }
    return node as unknown as TreeNode;
  });
  for (const k of Object.keys(set)) {
    if (!seen.has(k)) throw new Error(`the delta changes "${k}", which the variant does not have`);
  }
  if (nodes[0]?.k !== "") {
    throw new Error(nodes.length ? `the variant's first node is "${nodes[0].k}", not the root ""` : "the variant has no nodes, not even the root");
  }
  const before = new Set<string>();
  for (const node of nodes) {
    const parent = parentKey(node.k);
    if (parent !== null && !before.has(parent)) {
      throw new Error(`"${node.k}" comes before its parent "${parent}", or the variant has no "${parent}"`);
    }
    before.add(node.k);
  }
  return nodes;
}

/**
 * The delta that turns `base` into `variant`, such that
 * `expandTree({ base, ... }, diffTree(base, variant))` deep-equals `variant`.
 *
 * Changes are by whole field: a text node whose ink box moved carries its
 * whole `tx`, since a field is the unit that diffs readably and nests no
 * deeper. `keys` is written only when the variant's keys differ from the
 * base's, in membership or in order, so a variant that only restyles carries
 * `set` alone. A field that is null in `variant` is taken as absent, as it
 * is in a node (TreeNode); throws on a key either list holds twice.
 */
export function diffTree(base: TreeNode[], variant: TreeNode[]): TreeDelta {
  const from = byKey(base, "the base tree");
  byKey(variant, "the variant's tree");
  const delta: TreeDelta = {};
  const keys = variant.map((node) => node.k);
  if (keys.length !== base.length || keys.some((k, i) => base[i].k !== k)) delta.keys = keys;
  const set: Record<string, Partial<TreeNode> | TreeNode> = {};
  for (const node of variant) {
    const was = from.get(node.k);
    if (!was) {
      set[node.k] = withoutNulls(node);
      continue;
    }
    const change: Record<string, unknown> = {};
    for (const name of [...new Set([...Object.keys(was), ...Object.keys(node)])].sort()) {
      if (name === "k") continue;
      const before = field(was, name);
      const after = field(node, name);
      if (after === undefined) {
        if (before !== undefined) change[name] = null;
      } else if (before === undefined || canonicalJson(before) !== canonicalJson(after)) {
        change[name] = copy(after);
      }
    }
    if (Object.keys(change).length) set[node.k] = change as Partial<TreeNode>;
  }
  if (Object.keys(set).length) delta.set = set;
  return delta;
}

/**
 * Each node's box relative to the root's border box, by key: the parent's
 * position plus the node's own, down the tree. Nodes must come parents first,
 * as a tree's preorder does; a node whose parent is missing, or comes after
 * it, throws, since its position would mean nothing.
 */
export function absoluteBoxes(nodes: TreeNode[]): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const node of nodes) {
    if (out.has(node.k)) throw new Error(`the tree holds the key "${node.k}" twice`);
    const parent = parentKey(node.k);
    if (parent === null) {
      out.set(node.k, [...node.box]);
      continue;
    }
    const at = out.get(parent);
    if (!at) throw new Error(`"${node.k}" comes before its parent "${parent}", or the tree has no "${parent}"`);
    out.set(node.k, [round2(at[0] + node.box[0]), round2(at[1] + node.box[1]), node.box[2], node.box[3]]);
  }
  return out;
}

/**
 * A digest of a variant's facts, as 8 hex digits: fnv1a32 over the canonical
 * JSON of its nodes. The build stores it on each Figma variant it converges,
 * and verify compares it with the digest of the facts it scores against, so
 * a variant built from another measurement is told apart. Through JSON first,
 * so a field that is undefined counts as absent, as it would in a file, and
 * a top-level null too, as it does in a node.
 *
 * The root's paint is in its styles, not its node (ROOT_FIELDS), so the
 * build and verify digest a variant as
 * `treeDigest([rootWithStyles(nodes[0], styles), ...nodes.slice(1)])`: a
 * re-snap that changes only the root's background then changes the digest
 * too. Both must digest the same way, or every variant reads as built from
 * another measurement.
 */
export function treeDigest(nodes: TreeNode[]): string {
  return fnv1a32(canonicalJson(nodes.map(withoutNulls)));
}

/**
 * Whether a text node's box is its text's own width, near enough, rather
 * than a wider block it sits in: the box at most 6% and 1px wider than the
 * glyphs. Such a node is built to size itself to its characters, so a wider
 * stand-in font can never wrap it, and verify expects the same from the same
 * facts. False for a node with no text.
 */
export function textHugs(n: TreeNode): boolean {
  return Boolean(n.tx) && n.box[2] <= n.tx!.ink[2] * 1.06 + 1;
}

const sides = <T>(value: Sides<T>): [T, T, T, T] =>
  (Array.isArray(value) ? value : [value, value, value, value]) as [T, T, T, T];

/** A `#rrggbb[aa]` color's alpha byte, 255 where it has none. */
const alphaOf = (hex: string): number => (hex.length === 9 ? parseInt(hex.slice(7), 16) : 255);

/**
 * Whether a border the background stops at (`bgc`, as shadcn/ui's Button's
 * `bg-clip-padding`) draws the same as a Figma INSIDE stroke over a fill
 * that runs under it: where there is no background to show under the
 * border, or every side the border draws is solid and opaque, so it hides
 * the background beneath it. Such a frame is built at its border box with
 * the stroke INSIDE and its corner radius the browser's own, which binds to
 * its radius token. Anywhere else, a transparent border over a background
 * first, the background stopping short of the border shows, and the frame
 * is its padding box with the stroke OUTSIDE (figma-map.ts), its radius the
 * inner one CSS draws the background with. verify takes either where this
 * holds, since both draw alike.
 */
export function insideStrokeDrawsBorder(n: TreeNode): boolean {
  if (!n.bgc || !n.bd) return false;
  if (!n.bgi && (!n.bg || alphaOf(n.bg) === 0)) return true;
  const widths = sides(n.bd.w);
  const colors = sides(n.bd.c);
  const styles = sides(n.bd.s);
  return [0, 1, 2, 3].every((i) => !(widths[i] > 0) || (styles[i] === "solid" && colors[i] !== null && alphaOf(colors[i]!) === 255));
}

/** Degrees in a CSS angle, or null for something else. */
function degrees(text: string): number | null {
  const m = /^(-?[\d.]+(?:e-?\d+)?)(deg|turn|rad|grad)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "deg" ? n : m[2] === "turn" ? n * 360 : m[2] === "rad" ? (n * 180) / Math.PI : n * 0.9;
}

/**
 * The clockwise turn, in degrees, a node's `tf` (snap's transform and its
 * own `rotate` and `scale`, section 6.9) gives it, where that is a turn in
 * the page's plane alone: `rotate: 45deg` (or about `z`), and a
 * `matrix(...)` of a rotation, its translation already in the box. Null
 * for anything that scales, skews or turns in 3D, or for no `tf`.
 */
export function turnOf(tf: string | undefined): number | null {
  if (!tf) return null;
  let turn = 0;
  for (const part of tf.split(/;\s*/)) {
    const rotate = /^rotate:\s*(?:z\s+|0\s+0\s+1\s+)?(\S+)$/.exec(part.trim());
    const matrix = /^matrix\(([^)]*)\)$/.exec(part.trim());
    if (rotate && degrees(rotate[1]) !== null) turn += degrees(rotate[1])!;
    else if (matrix) {
      const [a, b, c, d] = matrix[1].split(",").map((v) => Number(v.trim()));
      if (!(Math.abs(a - d) < 1e-4 && Math.abs(b + c) < 1e-4 && Math.abs(a * a + b * b - 1) < 1e-3)) return null;
      turn += (Math.atan2(b, a) * 180) / Math.PI;
    } else return null;
  }
  const out = Math.round((((turn % 360) + 540) % 360 - 180) * 100) / 100;
  return out === -180 ? 180 : out || 0;
}

/**
 * Where a node sits in its tree, which decides whether the build turns it
 * (builtTurn): how many children it has, and whether a node around it, its
 * parent or one of theirs, has a transform (`transformedAround`).
 */
export interface TurnContext {
  children: number;
  transformed: boolean;
}

/**
 * Whether a node around `k`, its parent or one of theirs, has a transform
 * (`tf`): snap measured `k` as the page box that transform drew it in, and
 * the build builds that node untransformed.
 */
export function transformedAround(k: string, get: (key: string) => TreeNode | undefined): boolean {
  for (let p = parentKey(k); p !== null; p = parentKey(p)) if (get(p)?.tf) return true;
  return false;
}

/**
 * Why the build leaves a node's turn in the plane (turnOf) out, or null
 * where it builds it: a transform around it, built untransformed, which
 * would leave the node at another net turn than the browser's; children,
 * measured turned as their page boxes; or a place in the flow where its
 * turned box isn't its own. Figma's auto layout places a turned layer by
 * its turned box, where CSS keeps the unturned one's place (the sixth
 * probe); turned 180 degrees, or 90 when square, the two are one, and
 * Figma lays it out as it would unturned (the seventh probe).
 */
export function unturnedBecause(n: TreeNode, at: TurnContext): string | null {
  if (at.transformed) return "a transform around it is built untransformed";
  if (at.children) return "its children are measured turned";
  const turn = Math.abs(turnOf(n.tf) ?? 0);
  if (!n.abs && turn !== 0 && turn !== 180 && !(turn === 90 && n.box[2] === n.box[3])) return "Figma's auto layout would place it by its turned box";
  return null;
}

/**
 * The turn the build gives a node in Figma, clockwise in degrees as CSS
 * says it, or null where it builds the node unturned at its own size: a
 * turn in the plane (turnOf) the build can make (unturnedBecause), of a
 * childless node with no transform around it, out of the flow, or in it
 * turned 180 degrees, or 90 when square. Figma turns
 * a layer about its top left corner, and the build places it so that it
 * turns about its center, as CSS's default origin does; snap's box is the
 * node's own size centered where it drew, so any origin comes out the
 * same. verify scores the turn of the nodes this turns, from the same
 * facts.
 */
export function builtTurn(n: TreeNode, at: TurnContext): number | null {
  const turn = turnOf(n.tf);
  return turn === null || unturnedBecause(n, at) !== null ? null : turn;
}

/** Cross-axis alignments that place an item at the end; anything else not centered places it at the start. */
const END = new Set(["end", "flex-end", "self-end", "right"]);

/**
 * Displays whose in-flow children stack down in block flow: the block
 * containers, `inline-block` among them, since what counts is how a box lays
 * out its children, not how it sits in its own parent. Not `inline`, whose
 * children share line boxes, nor a table cell, whose content is placed by its
 * vertical-align, which snap does not record.
 */
const BLOCK_FLOW = new Set(["block", "flow-root", "list-item", "inline-block"]);

/**
 * Where a flex container's justify-content packs its items, in terms of the
 * flow, whose start is the content end when the direction is reversed.
 * `flex-start` and `flex-end` follow the flow, so they reverse with it;
 * `start` and `end` are the axis's own ends, left and right in a row (left
 * to right text assumed, as snap records no direction) and top and bottom in
 * a column, which a reversed flow meets the other way round; `left` and
 * `right` are physical on a row and act as `start` on a column, as CSS
 * says. `normal`, `stretch` and anything unknown pack at the flow's start.
 */
function packing(justify: string, axis: "x" | "y", reverse: boolean): "start" | "end" | "center" | "space-between" | "space-around" | "space-evenly" {
  const value = justify.replace(/^(?:safe|unsafe)\s+/, "");
  const axisEnd = reverse ? "start" : "end";
  const axisStart = reverse ? "end" : "start";
  switch (value) {
    case "center":
    case "space-between":
    case "space-around":
    case "space-evenly":
      return value;
    case "flex-end":
      return "end";
    case "end":
      return axisEnd;
    case "start":
    case "left":
      return axisStart;
    case "right":
      return axis === "x" ? axisEnd : axisStart;
    default:
      return "start";
  }
}

/**
 * Where `parent` puts each of its in-flow `children` along and across its
 * flow, in the world their boxes come from (Flow). `parent` needs its `L`,
 * and its `bd` for the border, which for the root comes from its styles
 * (rootWithStyles). `children` are the parent's direct children; those with
 * `abs` are out of flow and left out. The main axis comes from `parent.L`:
 * a flex container's direction, unless it wraps; and y for a block container
 * (BLOCK_FLOW), or a grid of one column, whose in-flow children stack without
 * overlapping by more than 1px, which Chrome's rounding of half-leading can
 * account for. Anything else has no flow to anchor to.
 *
 * Pass `snap`, the Flow snap's boxes gave for the same parent, to score
 * another world's boxes against it. The flow's order is not the stored
 * order: a tree stores siblings in paint order, where a `relative` child
 * paints after the static ones beside it wherever it sits, so in the
 * browser's world the order is where the boxes sit along the main axis,
 * the order the flow placed them in. Another world must anchor each node to
 * the same predecessor, or a misplaced node would be compared with a
 * different neighbor in each, so it takes snap's `inflow` as its order. It
 * takes snap's `axis` too: whether a block's children stack is read from the
 * boxes, and a Figma world where one sits 3px into the one above must still
 * be scored along y, where that 3px shows, rather than with no flow at all.
 */
export function flowOf(parent: TreeNode, children: TreeNode[], snap?: Pick<Flow, "axis" | "inflow">): Flow {
  const L = parent.L;
  const [bt, br, bb, bl] = sides(parent.bd?.w ?? 0);
  const [pt, pr, pb, pl] = L?.pad ?? [0, 0, 0, 0];
  const content: Box = [
    round2(bl + pl), round2(bt + pt),
    round2(parent.box[2] - bl - pl - br - pr), round2(parent.box[3] - bt - pt - bb - pb),
  ];
  const display = L?.d ?? "";
  const flex = display.includes("flex");
  const grid = display.includes("grid");
  const dir = L?.dir ?? "row";
  const vertical = !flex || dir.startsWith("column");
  const backwards = flex && dir.endsWith("-reverse");
  let inflow = children.filter((child) => !child.abs);
  // Sorts are stable: ties keep the stored order.
  if (snap) {
    const at = new Map(snap.inflow.map((k, i) => [k, i]));
    inflow = [...inflow].sort((a, b) => (at.get(a.k) ?? Infinity) - (at.get(b.k) ?? Infinity));
  } else {
    const [m, size] = vertical ? [1, 3] : [0, 2];
    inflow = [...inflow].sort((a, b) => (backwards ? b.box[m] + b.box[size] - (a.box[m] + a.box[size]) : a.box[m] - b.box[m]));
  }
  const stacked = inflow.every((child, i) => i === 0 || child.box[1] >= inflow[i - 1].box[1] + inflow[i - 1].box[3] - 1);

  let axis: Flow["axis"] = null;
  if (flex) {
    if (!L?.wrap) axis = vertical ? "y" : "x";
  } else if (L && stacked && (BLOCK_FLOW.has(display) || (grid && (L.tracks?.[0] ?? 1) <= 1))) {
    axis = "y";
  }
  if (snap) axis = snap.axis;
  const reverse = axis !== null && backwards;
  const flow: Flow = { axis, reverse, content, inflow: inflow.map((child) => child.k), main: {}, cross: {} };
  if (!axis || inflow.length === 0) return flow;

  const [m, mSize, c, cSize] = axis === "x" ? [0, 2, 1, 3] : [1, 3, 0, 2];
  const start = content[m];
  const room = content[mSize];
  // Positions along the flow from its own start: from the content end, and
  // against the axis, when the direction is reversed.
  const pos = (child: TreeNode) => (reverse ? start + room - (child.box[m] + child.box[mSize]) : child.box[m] - start);
  const size = (child: TreeNode) => child.box[mSize];
  const n = inflow.length;
  const first = inflow[0];
  const last = inflow[n - 1];
  const afterPrevious = (i: number) => pos(inflow[i]) - (pos(inflow[i - 1]) + size(inflow[i - 1]));

  const pack = flex ? packing(L?.jc ?? "normal", axis, reverse) : "start";
  const gap = flex ? (L?.gap?.[axis === "x" ? 1 : 0] ?? 0) : 0;
  const sum = inflow.reduce((total, child) => total + size(child), 0);
  const free = room - sum - gap * (n - 1);
  const spread = (lead: number, between: number) => {
    let at = lead;
    inflow.forEach((child) => {
      flow.main[child.k] = round2(pos(child) - at);
      at += size(child) + gap + between;
    });
  };
  if (pack === "center" || ((pack === "space-around" || pack === "space-evenly") && free < 0)) {
    // From the sizes and gaps, as section 10.4 has it, not from where the
    // group's ends landed: a last child out of place then moves only its
    // own anchor, not the first child's too.
    flow.main[first.k] = round2(pos(first) - free / 2);
    for (let i = 1; i < n; i++) flow.main[inflow[i].k] = round2(afterPrevious(i));
  } else if (pack === "end") {
    flow.main[last.k] = round2(room - (pos(last) + size(last)));
    for (let i = 0; i < n - 1; i++) flow.main[inflow[i].k] = round2(afterPrevious(i + 1));
  } else if (pack === "space-between" && n > 1 && free >= 0) {
    spread(0, free / (n - 1));
  } else if (pack === "space-around") {
    spread(free / n / 2, free / n);
  } else if (pack === "space-evenly") {
    spread(free / (n + 1), free / (n + 1));
  } else {
    flow.main[first.k] = round2(pos(first));
    for (let i = 1; i < n; i++) flow.main[inflow[i].k] = round2(afterPrevious(i));
  }

  // Across the flow: a flex item by its align-self, else its parent's
  // align-items. A grid's column and a block's children are placed by
  // properties snap does not record (justify-items, margins), so at the start.
  const crossStart = content[c];
  const crossRoom = content[cSize];
  for (const child of inflow) {
    const own = child.box[c] - crossStart;
    const align = flex ? (child.S?.as && child.S.as !== "auto" ? child.S.as : (L?.ai ?? "normal")) : "normal";
    flow.cross[child.k] = round2(
      align === "center" ? own + child.box[cSize] / 2 - crossRoom / 2
        : END.has(align) ? crossRoom - (own + child.box[cSize])
          : own,
    );
  }
  return flow;
}

/**
 * The root node with its paint from the root's styles, where the tree keeps
 * it (ROOT_FIELDS): background, border, radius, shadow and opacity, in the
 * tree's own encoding. For what needs the root as a node with its paint,
 * as flowOf needs its border to find the content box. A copy; the tree's
 * root is left as it is.
 */
export function rootWithStyles(root: TreeNode, styles: NormalizedStyles): TreeNode {
  const node = copy(root);
  const one = <T>(values: T[]): Sides<T> =>
    values.every((v) => canonicalJson(v) === canonicalJson(values[0])) ? values[0] : (values as [T, T, T, T]);
  if (styles.backgroundColor) node.bg = styles.backgroundColor;
  if (styles.backgroundImage) node.bgi = styles.backgroundImage;
  if (styles.backgroundClip === "padding-box" || styles.backgroundClip === "content-box") node.bgc = styles.backgroundClip;
  const border = styles.border ? [styles.border.top, styles.border.right, styles.border.bottom, styles.border.left] : [];
  const drawn = border.find((side) => side != null);
  if (drawn) {
    node.bd = {
      w: one(border.map((side) => side?.width ?? 0)),
      s: one(border.map((side) => (side ?? drawn).style)),
      c: one(border.map((side) => (side ?? drawn).color)),
    };
  }
  const { topLeft, topRight, bottomRight, bottomLeft } = styles.borderRadius;
  if (topLeft || topRight || bottomRight || bottomLeft) node.r = one([topLeft, topRight, bottomRight, bottomLeft]);
  if (styles.boxShadow.length) {
    node.sh = styles.boxShadow.map((s): Shadow => {
      const { offsetX: x, offsetY: y, blur, spread, color } = s;
      return s.inset ? [x, y, blur, spread, color, 1] : [x, y, blur, spread, color];
    });
  }
  if (styles.opacity !== 1) node.op = styles.opacity;
  return node;
}
