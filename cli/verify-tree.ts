// Scores a variant element by element: every node snap measured under the
// component's root, against the record the readback template read off the
// Figma layer built with its key (templates/readback.js).
//
// Before trees, verify compared one box per variant, so a Switch built as a
// pill with no thumb scored 100%: the pill was right. Here the thumb is a
// node of its own, and a Figma variant without it is missing one of two
// elements. Each node is scored on the properties its kind can show, and a
// node whose kind, characters, shapes, image or visibility are wrong scores
// nothing at all: a placeholder square where an icon was measured is not a
// slightly wrong icon.
//
// What it compares with comes only from snap's facts and the pure helpers in
// tree-types.ts, never from the build's plan (design D9): a translation
// mistake the build and verify shared would otherwise build wrong and still
// pass.

import { isFontKeyword, splitTopLevel } from "./snap-normalize.js";
import type { NormalizedStyles } from "./snap-normalize.js";
import { RECORD, flowOf, parentKey, rootWithStyles } from "./tree-types.js";
import type { Box, ComponentTree, Flow, Sides, TreeNode } from "./tree-types.js";
import { fnv1a32 } from "./checksum.js";

// --- Behavior the Figma spike settles ----------------------------------------

/**
 * What verify assumes about Figma until the spike (design section 14)
 * measures it live. Each is the design's expected answer; set one false to
 * switch to its fallback, which leaves the property it covers out of the
 * score and lists it under coverage instead.
 *
 * - `imageBytesKept` (item 10): an image upload_assets stored reads back
 *   byte for byte, so its content is the FNV-1a of the thumbnail snap wrote.
 *   Fallback: content is scored by an image being there at the thumbnail's
 *   pixel size.
 * - `shadowSpreadKept` (item 2): a shadow's spread reads back as built.
 *   Fallback: spread is left out of the comparison.
 * - `textTruncation` (item 3): Figma takes `textTruncation` and `maxLines`.
 *   Fallback: whether a text is cut off is left unscored.
 *
 * The rest of the spike's items are the build's (cli/figma-code.ts) or, for
 * how use_figma returns a value, the readback template's (RETURN_TEXT).
 */
export interface SpikeAssumptions {
  imageBytesKept: boolean;
  shadowSpreadKept: boolean;
  textTruncation: boolean;
}

export const SPIKE: SpikeAssumptions = { imageBytesKept: true, shadowSpreadKept: true, textTruncation: true };

// --- Tolerances (design section 10.5) ----------------------------------------

/** How far a node may sit from where snap measured it, directly or along its parent's flow. */
const POSITION_TOLERANCE_PX = 1;
/** An approximate node's geometry (`approx`): matched within this, else not scored. */
const APPROX_TOLERANCE_PX = 2;
/** Sizes, as 0.4.0 validated them live: max(1px, 3%). */
const MIN_SIZE_TOLERANCE_PX = 1;
const SIZE_TOLERANCE_RATIO = 0.03;
/**
 * A text's width when Figma sets it in another family than the browser drew
 * it in, a stand-in: system-ui drawn in Inter measured 4.2% wider. To be
 * tuned on the first live push (design risk R1).
 */
const STAND_IN_WIDTH_RATIO = 0.06;
/** A text's height at `line-height: normal`, which each font's metrics set. */
const NORMAL_LINE_HEIGHT = { min: 2, ratio: 0.12 } as const;
const OPACITY_TOLERANCE = 0.01;
const FONT_SIZE_TOLERANCE = 0.5;
const LETTER_SPACING_TOLERANCE = 0.1;
/** A vector shape's box: max(0.5px, 3% of the icon's box). */
const SHAPE_TOLERANCE = { min: 0.5, ratio: 0.03 } as const;
const GRADIENT_ANGLE_TOLERANCE_DEG = 1;
const GRADIENT_STOP_TOLERANCE = 0.01;
/** Float noise in sums of values rounded to 0.01. */
const EPSILON = 1e-6;

// --- Records -------------------------------------------------------------------

/** A record as the readback template returns it, by kind (tree-types RECORD). */
export type ReadRecord = unknown[];

/** The fields of a record by name, whatever its kind. */
interface Rec {
  k: string;
  kind: "F" | "T" | "V";
  box: Box;
  id: string | null;
  opacity: number;
  visible: number;
  raw: ReadRecord;
}

const F_FIELDS = { fills: 6, stroke: 7, radius: 8, effects: 9, opacity: 10, blend: 11, clip: 12, visible: 13, id: 14 } as const;
const T_FIELDS = {
  chars: 6, family: 7, weight: 8, italic: 9, size: 10, lineHeight: 11, letterSpacing: 12, color: 13, textCase: 14,
  decoration: 15, align: 16, truncation: 17, maxLines: 18, autoResize: 19, opacity: 20, visible: 21, id: 22,
} as const;
const V_FIELDS = { shapes: 6, opacity: 7, visible: 8, id: 9 } as const;

/**
 * Why a record can't be read, or null: one of another length than its kind
 * has, as a template cut down returns, or with a key or box that is not one.
 */
export function recordProblem(record: unknown, index: number): string | null {
  if (!Array.isArray(record)) return `tree[${index}] is not a record`;
  const kind = record[1] as unknown;
  if (kind !== "F" && kind !== "T" && kind !== "V") return `tree[${index}] has no kind F, T or V`;
  if (record.length !== RECORD[kind]) return `tree[${index}], ${kind === "F" ? "an" : "a"} ${kind} record of ${record.length} fields, not ${RECORD[kind]}`;
  if (typeof record[0] !== "string" || [2, 3, 4, 5].some((i) => typeof record[i] !== "number")) return `tree[${index}] has no key or box`;
  return null;
}

function parseRecord(raw: ReadRecord): Rec {
  const kind = raw[1] as Rec["kind"];
  const at = kind === "T" ? T_FIELDS : kind === "V" ? V_FIELDS : F_FIELDS;
  return {
    k: raw[0] as string, kind, raw,
    box: [raw[2], raw[3], raw[4], raw[5]] as Box,
    id: typeof raw[at.id] === "string" ? (raw[at.id] as string) : null,
    opacity: Number(raw[at.opacity]),
    visible: Number(raw[at.visible]),
  };
}

// --- Verdicts ------------------------------------------------------------------

export interface NodeDiff {
  property: string;
  measured: unknown;
  figma: unknown;
}

/**
 * A node that is not verified: `missing` from Figma, `drifted` on the
 * properties in `differences`, or `extra`, a layer keyed as a node snap no
 * longer measures. `gate` names the property that scored a drifted node 0:
 * its kind, characters, shapes, image content or visibility.
 */
export interface NodeVerdict {
  key: string;
  status: "drifted" | "missing" | "extra";
  gate?: string;
  differences: NodeDiff[];
  /** The Figma layer's id, where it has one. */
  figmaId?: string;
  /** Its score, 0-1: matched over compared properties, 0 when gated, missing or extra. */
  score: number;
}

/** A property verify can't score on a node, and why: listed under coverage, never in a denominator. */
export interface UnscorableProperty {
  key: string;
  property: string;
  reason: string;
}

/** One variant's elements, scored. */
export interface TreeScore {
  /** Snap's nodes, the root among them, and the keyed layers snap lacks. */
  measured: number;
  verified: number;
  drifted: number;
  missing: number;
  extra: number;
  /** Σ node scores; the variant's element fidelity is this over measured + extra. */
  score: number;
  matched: number;
  compared: number;
  /** Only the nodes that are not verified. */
  nodes: NodeVerdict[];
  unscorable: UnscorableProperty[];
}

export interface TreeInput {
  /** Snap's nodes for the variant: expandTree(tree, variant.treeDelta). */
  nodes: TreeNode[];
  /** The variant's root styles, which hold the root's paint (ROOT_FIELDS). */
  styles: NormalizedStyles;
  assets: ComponentTree["assets"];
  /** The variant's records, its parts' in order. */
  records: ReadRecord[];
  /** `--tolerance`: radius, stroke weight and shadow geometry. */
  tolerance: number;
  spike?: SpikeAssumptions;
}

// --- Expected values from facts -----------------------------------------------

const sides = <T>(value: Sides<T>): [T, T, T, T] => (Array.isArray(value) ? value : [value, value, value, value]) as [T, T, T, T];
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v ?? null);
const near = (a: unknown, b: unknown, tolerance: number) =>
  typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tolerance + EPSILON;
const sizeTolerance = (tolerance: number, a: number, b: number, ratio = SIZE_TOLERANCE_RATIO) =>
  Math.max(tolerance, MIN_SIZE_TOLERANCE_PX, ratio * Math.max(Math.abs(a), Math.abs(b)));

/** CSS blend modes by the Figma blend mode they draw as; the rest Figma has no mode for. */
const BLEND: Record<string, string> = {
  multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", darken: "DARKEN", lighten: "LIGHTEN",
  "color-dodge": "COLOR_DODGE", "color-burn": "COLOR_BURN", "hard-light": "HARD_LIGHT", "soft-light": "SOFT_LIGHT",
  difference: "DIFFERENCE", exclusion: "EXCLUSION", hue: "HUE", saturation: "SATURATION", color: "COLOR", luminosity: "LUMINOSITY",
};
/** What a layer with no blend mode of its own reads as: a frame passes through, a shape is normal. */
const NO_BLEND = new Set(["PASS_THROUGH", "NORMAL"]);
const TEXT_CASE: Record<string, string> = { uppercase: "UPPER", lowercase: "LOWER", capitalize: "TITLE" };
const DECORATION: Record<string, string> = { underline: "UNDERLINE", "line-through": "STRIKETHROUGH" };
const ALIGN: Record<string, string> = { center: "CENTER", right: "RIGHT", end: "RIGHT", justify: "JUSTIFIED" };
/** CSS border styles Figma's strokes draw: as a solid stroke, or a dash pattern. */
const STROKE_STYLES = new Set(["solid", "dashed", "dotted"]);

/** Characters as the readback template returns them: verbatim to 300, else a digest of them. */
export function readbackChars(chars: string): string {
  return chars.length > 300 ? `fnv:${fnv1a32(chars)}:${chars.length}:${chars.slice(0, 60)}` : chars;
}

/**
 * One linear-gradient layer as the readback encodes one, `lin:<css angle>:
 * <#hex@position,…>`, from the CSS snap recorded, in a box of `w` by `h`;
 * null where it isn't a plain linear gradient of hex stops.
 */
export function cssLinearGradient(layer: string, w: number, h: number): string | null {
  const m = /^linear-gradient\((.*)\)$/i.exec(layer.trim());
  if (!m) return null;
  const args = splitTopLevel(m[1]).map((a) => a.trim());
  let angle = 180;
  const unit = /^(-?[\d.]+)(deg|grad|rad|turn)$/i.exec(args[0] ?? "");
  const corner = Math.atan2(h, w) * (180 / Math.PI);
  const to: Record<string, number> = {
    "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
    "to top right": corner, "to right top": corner, "to bottom right": 180 - corner, "to right bottom": 180 - corner,
    "to bottom left": 180 + corner, "to left bottom": 180 + corner, "to top left": 360 - corner, "to left top": 360 - corner,
  };
  if (unit) {
    const n = Number(unit[1]);
    angle = { deg: n, grad: n * 0.9, rad: (n * 180) / Math.PI, turn: n * 360 }[unit[2].toLowerCase() as "deg"];
    args.shift();
  } else if (to[(args[0] ?? "").toLowerCase().replace(/\s+/g, " ")] !== undefined) {
    angle = to[args.shift()!.toLowerCase().replace(/\s+/g, " ")];
  }
  const rad = (angle * Math.PI) / 180;
  const length = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  const stops: { color: string; at: number | null }[] = [];
  for (const arg of args) {
    const [color, ...positions] = splitTopLevel(arg, " ").map((p) => p.trim()).filter(Boolean);
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color ?? "")) return null;
    const at = (p: string) => {
      const v = /^(-?[\d.]+)(%|px)?$/.exec(p);
      if (!v) return NaN;
      return v[2] === "px" ? Number(v[1]) / (length || 1) : Number(v[1]) / 100;
    };
    const list = positions.length ? positions.map(at) : [null];
    if (list.some((p) => p !== null && !Number.isFinite(p))) return null;
    for (const p of list) stops.push({ color: color.toLowerCase(), at: p });
  }
  if (stops.length < 2) return null;
  // Positions left out spread evenly between the ones given, as CSS places them.
  if (stops[0].at === null) stops[0].at = 0;
  if (stops[stops.length - 1].at === null) stops[stops.length - 1].at = 1;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].at !== null) continue;
    let j = i;
    while (stops[j].at === null) j++;
    const from = stops[i - 1].at!;
    const step = (stops[j].at! - from) / (j - i + 1);
    for (let k = i; k < j; k++) stops[k].at = from + step * (k - i + 1);
  }
  const deg = ((Math.round(angle) % 360) + 360) % 360;
  return `lin:${deg}:${stops.map((s) => `${s.color}@${Math.round(s.at! * 100) / 100}`).join(",")}`;
}

/** A color that draws nothing: `#rrggbb00`. */
const CLEAR = /^#[0-9a-f]{6}00$/;

/**
 * Whether two `lin:` gradients match: the angle within a degree, and stop
 * for stop, the position within 0.01 and the color exact. A stop that
 * draws nothing matches one that draws nothing in its own color or a
 * neighbor's: the browser interpolates colors premultiplied by their
 * alpha, so a transparent stop's own color never shows, and Figma, which
 * interpolates them as they are, draws the same fade only from a
 * transparent stop in its neighbor's color (`transparent` is #00000000,
 * which in Figma fades to white through gray).
 */
export function sameGradient(want: string, got: string): boolean {
  const parse = (s: string) => {
    const [, angle, stops] = s.split(":");
    return { angle: Number(angle), stops: (stops ?? "").split(",").map((p) => p.split("@").map((v, i) => (i ? v : String(lower(v))))) };
  };
  const x = parse(want);
  const y = parse(got);
  const turn = Math.abs(x.angle - y.angle) % 360;
  const sameColor = (color: string, i: number) => {
    const other = y.stops[i][0];
    if (color === other) return true;
    if (!CLEAR.test(color) || !CLEAR.test(other)) return false;
    return [x.stops[i - 1], x.stops[i + 1]].some((s) => s !== undefined && s[0].slice(0, 7) === other.slice(0, 7));
  };
  return Math.min(turn, 360 - turn) <= GRADIENT_ANGLE_TOLERANCE_DEG
    && x.stops.length === y.stops.length
    && x.stops.every(([color, at], i) => sameColor(color, i) && near(Number(at), Number(y.stops[i][1]), GRADIENT_STOP_TOLERANCE));
}

/** One painted shape of an SVG as the browser paints it: colors as hex, alpha included; stroke width in px. */
export interface ShapePaint {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number | null;
}

const SVG_SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
/** Elements whose content is not painted where it stands. */
const SVG_UNPAINTED = new Set(["defs", "clippath", "mask", "symbol", "pattern", "lineargradient", "radialgradient", "marker", "title", "desc", "metadata"]);

/**
 * Each shape's paint in an SVG snap serialized (snap-assets), in document
 * order, which is the order Figma's importer makes its layers in: fill and
 * stroke inherited down the tree, SVG's defaults where none is given (fill
 * black, no stroke; a line has no area to fill), opacities as an alpha byte,
 * and the stroke width scaled from the viewBox to the drawn size. Null for
 * markup this can't read, a color that is not hex say, which then goes
 * unscored rather than guessed.
 */
export function svgShapePaints(markup: string): ShapePaint[] | null {
  const tags = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
  type Paint = { fill?: string; stroke?: string; "stroke-width"?: string; "fill-opacity"?: string; "stroke-opacity"?: string; opacity: number; scaled: boolean };
  const stack: { tag: string; paint: Paint }[] = [];
  const out: ShapePaint[] = [];
  let scale = 1;
  let hidden = 0;
  let ok = true;
  const color = (value: string | undefined, alpha: number): string | null => {
    if (value === undefined || value === "none" || alpha <= 0) return null;
    if (!/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(value)) {
      ok = false;
      return null;
    }
    let hex = value.toLowerCase();
    if (hex.length === 4) hex = `#${[...hex.slice(1)].map((c) => c + c).join("")}`;
    const own = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
    const a = Math.round(own * alpha * 255 + 1e-4);
    return a === 0 ? null : hex.slice(0, 7) + (a < 255 ? a.toString(16).padStart(2, "0") : "");
  };
  for (const m of markup.matchAll(tags)) {
    const [, closing, rawTag, rawAttrs, selfClosing] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const open = stack.pop();
      if (open && SVG_UNPAINTED.has(open.tag)) hidden--;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3];
    const parent = stack.length ? stack[stack.length - 1].paint : { opacity: 1, scaled: true };
    const paint: Paint = { ...parent };
    for (const key of ["fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity"] as const) if (attrs[key] !== undefined) paint[key] = attrs[key];
    if (attrs.opacity !== undefined) paint.opacity = parent.opacity * Number(attrs.opacity);
    // A transform that scales leaves a stroke's drawn width to the matrix.
    if (attrs.transform && !/^\s*(translate\([^)]*\)\s*)*$/.test(attrs.transform)) paint.scaled = false;
    if (tag === "svg" && !stack.length) {
      const view = (attrs.viewbox ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
      const width = parseFloat(attrs.width ?? "") || view[2];
      const height = parseFloat(attrs.height ?? "") || view[3];
      if (view.length === 4 && view[2] > 0 && view[3] > 0 && width && height) scale = Math.min(width / view[2], height / view[3]);
    }
    if (SVG_UNPAINTED.has(tag)) hidden++;
    if (SVG_SHAPES.has(tag) && !hidden) {
      const strokeAlpha = paint.opacity * Number(paint["stroke-opacity"] ?? 1);
      const stroke = color(paint.stroke, strokeAlpha);
      out.push({
        fill: tag === "line" ? null : color(paint.fill ?? "#000000", paint.opacity * Number(paint["fill-opacity"] ?? 1)),
        stroke,
        strokeWidth: stroke && paint.scaled ? Math.round(parseFloat(paint["stroke-width"] ?? "1") * scale * 100) / 100 : null,
      });
    }
    if (!selfClosing) stack.push({ tag, paint });
    else if (SVG_UNPAINTED.has(tag)) hidden--;
  }
  return ok ? out : null;
}

// --- Scoring -------------------------------------------------------------------

/** The properties each kind is scored on, for a node missing from Figma (design section 10.2). */
function propertiesOf(n: TreeNode, root: boolean): string[] {
  const where = root ? ["w", "h"] : ["x", "y", "w", "h"];
  const shown = root ? [] : ["visible"];
  if (n.t === "T") {
    return [...where, "chars", "family", "weight", "italic", "size", "lineHeight", "letterSpacing", "color", "case", "decoration", "align", "truncation", "lines", "opacity", ...shown];
  }
  if (n.t === "V") return [...where, "shapes", "paint", "opacity", ...shown];
  if (n.t === "I") return [...where, "content", "radius", "clip", "opacity", ...shown];
  return [...where, "fills", "stroke", "radius", "effects", "opacity", "blend", "clip", ...shown];
}

/** Properties that make a node another node when they differ: it scores 0. */
const GATES = new Set(["kind", "chars", "shapes", "content", "visible"]);

/** How far two siblings' border boxes may run into each other and still keep apart. */
const OVERLAP_PX = 0.5;

/**
 * The first pair of siblings Figma's layer order paints the other way round
 * from snap's paint order and whose border boxes overlap, so the change
 * shows: [the one snap paints first, the one it paints after]. Null when
 * every pair whose order changed keeps apart, so both orders draw the same.
 *
 * `painted` is the siblings in snap's paint order, as a tree stores them,
 * with their boxes; `layers` their keys in Figma's layer order, bottom to
 * top. Figma's layer order is both what paints over what and an auto
 * layout's flow, so where a child paints out of its flow order, as
 * Attachment's `relative` media tile does, the build lays the children out
 * in flow order when nothing reordered overlaps (SPEC-NOTES 23 and C13).
 * This is that rule, the build's visibleReorder (cli/figma-layout.ts),
 * written again here rather than taken from the build (design D9).
 */
export function visibleReorder(painted: readonly Pick<TreeNode, "k" | "box">[], layers: readonly string[]): [string, string] | null {
  const at = new Map(layers.map((k, i) => [k, i]));
  const present = painted.filter((c) => at.has(c.k));
  const overlap = (a: Box, b: Box) => Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]) > OVERLAP_PX
    && Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > OVERLAP_PX;
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      if (at.get(present[i].k)! > at.get(present[j].k)! && overlap(present[i].box, present[j].box)) return [present[i].k, present[j].k];
    }
  }
  return null;
}

/**
 * Scores one variant's nodes against its records (design sections 10.2-10.5).
 *
 * Positions follow the flow (10.4): a node passes an axis when it sits
 * within 1px of where snap measured it in its parent, or, in its parent's
 * flow, within 1px of where its predecessors in Figma put it. So a label
 * drawn wider in a stand-in font moves its followers without costing them,
 * and a node out of place costs itself alone. A container may differ in
 * size by what its in-flow children differ by, as a hugging frame does.
 */
export function scoreTree(input: TreeInput): TreeScore {
  const { nodes, styles, assets, tolerance } = input;
  const spike = input.spike ?? SPIKE;
  const root = rootWithStyles(nodes[0], styles);
  const snap = new Map<string, TreeNode>(nodes.map((n, i) => [n.k, i === 0 ? root : n]));
  const kids = new Map<string, TreeNode[]>();
  for (const n of nodes.slice(1)) {
    const p = parentKey(n.k)!;
    kids.set(p, [...(kids.get(p) ?? []), snap.get(n.k)!]);
  }

  // The first record of each key is the layer; a second of one key is a
  // layer duplicated in Figma, which keeps its plugin data: an extra.
  const records = new Map<string, Rec & { index: number }>();
  const extras: Rec[] = [];
  input.records.forEach((raw, index) => {
    const rec = parseRecord(raw);
    if (records.has(rec.k) || !snap.has(rec.k)) extras.push(rec);
    else records.set(rec.k, { ...rec, index });
  });

  // Each parent's flow in snap's world and in Figma's, from each world's
  // own boxes, Figma's along snap's axis and in snap's order (flowOf).
  const figmaNode = (n: TreeNode): TreeNode | null => {
    const rec = records.get(n.k);
    return rec ? { ...n, box: n.k === "" ? [0, 0, rec.box[2], rec.box[3]] : rec.box } : null;
  };
  const flows = new Map<string, { snap: Flow; figma: Flow | null }>();
  for (const [p, children] of kids) {
    const parent = snap.get(p)!;
    const snapFlow = flowOf(parent, children);
    const figmaParent = figmaNode(parent);
    const present = children.map(figmaNode).filter((c): c is TreeNode => c !== null);
    flows.set(p, { snap: snapFlow, figma: figmaParent ? flowOf(figmaParent, present, snapFlow) : null });
  }

  const out: TreeScore = { measured: nodes.length, verified: 0, drifted: 0, missing: 0, extra: 0, score: 0, matched: 0, compared: 0, nodes: [], unscorable: [] };

  for (const n of snap.values()) {
    const isRoot = n.k === "";
    const rec = records.get(n.k);
    if (!rec) {
      const properties = propertiesOf(n, isRoot);
      out.missing++;
      out.compared += properties.length;
      out.nodes.push({ key: n.k, status: "missing", differences: [], score: 0 });
      continue;
    }
    const diffs: NodeDiff[] = [];
    let matched = 0;
    let compared = 0;
    const check = (property: string, ok: boolean, measured: unknown, figma: unknown) => {
      compared++;
      if (ok) matched++;
      else diffs.push({ property, measured, figma });
    };
    const unscorable = (property: string, reason: string) => out.unscorable.push({ key: n.k, property, reason });
    const field = (name: string): unknown => {
      const at = rec.kind === "T" ? (T_FIELDS as Record<string, number>)[name] : rec.kind === "V" ? (V_FIELDS as Record<string, number>)[name] : (F_FIELDS as Record<string, number>)[name];
      return at === undefined ? undefined : rec.raw[at];
    };

    // Geometry, for every kind.
    const approx = n.approx !== undefined;
    const geometry = (property: string, ok: (slack: number) => boolean, measured: unknown, figma: unknown) => {
      if (ok(0)) return check(property, true, measured, figma);
      if (approx) {
        if (ok(APPROX_TOLERANCE_PX)) return check(property, true, measured, figma);
        return unscorable(property, `approximate geometry (${n.approx}) more than ${APPROX_TOLERANCE_PX}px off`);
      }
      check(property, false, measured, figma);
    };
    if (!isRoot) {
      for (const [axis, i] of [["x", 0], ["y", 1]] as const) {
        geometry(axis, (slack) => positionMatches(n, rec.box, axis, flows, slack), n.box[i], rec.box[i]);
      }
    }
    const family = rec.kind === "T" ? field("family") : null;
    for (const [axis, i] of [["w", 2], ["h", 3]] as const) {
      const allowance = contentAllowance(n, axis, kids, flows, records);
      const want = n.box[i];
      const got = rec.box[i];
      let limit: number;
      if (n.t === "T" && n.tx) {
        const standIn = axis === "w" && (n.tx.fk === 1 || (typeof family === "string" && family.toLowerCase() !== n.tx.f.toLowerCase()));
        limit = axis === "h" && n.tx.lh === "normal"
          ? Math.max(NORMAL_LINE_HEIGHT.min, NORMAL_LINE_HEIGHT.ratio * Math.max(want, got))
          : sizeTolerance(tolerance, want, got, standIn ? STAND_IN_WIDTH_RATIO : SIZE_TOLERANCE_RATIO);
      } else {
        limit = sizeTolerance(tolerance, want, got) + allowance;
      }
      geometry(axis, (slack) => Math.abs(want - got) <= limit + slack + EPSILON, want, got);
    }
    if (n.tf) unscorable("transform", `${n.tf} is built as its bounding box`);

    // Another kind of layer where snap measured this one is not this node.
    const kind = n.t === "I" ? "F" : n.t;
    if (rec.kind !== kind) {
      check("kind", false, n.t, rec.kind);
      // Its kind's own properties can't be compared on another kind's record.
      const own = propertiesOf(n, isRoot).filter((p) => !["x", "y", "w", "h"].includes(p));
      compared += own.length;
      out.drifted++;
      out.matched += matched;
      out.compared += compared;
      out.nodes.push({ key: n.k, status: "drifted", gate: "kind", differences: diffs, figmaId: rec.id ?? undefined, score: 0 });
      continue;
    }

    if (n.t === "T" && n.tx) scoreText(n, rec, field, check, unscorable, spike);
    else if (n.t === "V") scoreVector(n, field, assets, tolerance, check, unscorable);
    else if (n.t === "I") scoreImage(n, field, assets, tolerance, check, unscorable, spike);
    else scoreFrame(n, field, tolerance, check, unscorable, spike);

    check("opacity", near(n.op ?? 1, rec.opacity, OPACITY_TOLERANCE), n.op ?? 1, rec.opacity);
    if (!isRoot) check("visible", rec.visible === (n.vis === 0 ? 0 : 1), n.vis === 0 ? 0 : 1, rec.visible);
    if (n.ol) unscorable("outline", `outline ${n.ol[0]}px ${n.ol[1]} is not built in phase 1`);
    if (n.cp) unscorable("clip-path", `clip-path ${n.cp}`);

    // Paint order among its keyed children, where it has two or more: drift
    // where Figma paints one over another the other way round, not where
    // siblings that keep apart are in another order (visibleReorder).
    const children = (kids.get(n.k) ?? []).filter((c) => records.has(c.k));
    if (children.length >= 2) {
      const want = children.map((c) => c.k);
      const got = [...children].sort((a, b) => records.get(a.k)!.index - records.get(b.k)!.index).map((c) => c.k);
      check("order", visibleReorder(children, got) === null, want, got);
    }

    const gate = diffs.find((d) => GATES.has(d.property))?.property;
    const score = gate ? 0 : compared ? matched / compared : 1;
    out.matched += matched;
    out.compared += compared;
    out.score += score;
    if (diffs.length) {
      out.drifted++;
      out.nodes.push({ key: n.k, status: "drifted", ...(gate ? { gate } : {}), differences: diffs, figmaId: rec.id ?? undefined, score });
    } else {
      out.verified++;
    }
  }

  for (const rec of extras) {
    out.extra++;
    out.nodes.push({ key: rec.k, status: "extra", differences: [], figmaId: rec.id ?? undefined, score: 0 });
  }
  return out;
}

/**
 * Whether a node sits right on one axis (design section 10.4): within 1px
 * of its measured offset in its parent, or, for one in its parent's flow,
 * within 1px of where the flow puts it, along the flow from the sibling
 * before it in each world's own boxes, across it from the content's start,
 * center or end its alignment names.
 */
function positionMatches(n: TreeNode, figma: Box, axis: "x" | "y", flows: Map<string, { snap: Flow; figma: Flow | null }>, slack: number): boolean {
  const i = axis === "x" ? 0 : 1;
  const limit = POSITION_TOLERANCE_PX + slack + EPSILON;
  if (Math.abs(figma[i] - n.box[i]) <= limit) return true;
  const flow = flows.get(parentKey(n.k)!);
  if (!flow?.figma || !flow.snap.axis || n.abs) return false;
  const along = flow.snap.axis === axis;
  const want = (along ? flow.snap.main : flow.snap.cross)[n.k];
  const got = (along ? flow.figma.main : flow.figma.cross)[n.k];
  return want !== undefined && got !== undefined && Math.abs(want - got) <= limit;
}

/**
 * How much a container may differ in size on one axis beyond its own
 * tolerance: what its in-flow children differ by there, as Figma's hugging
 * frame grows with them. Along the flow, the sum of the children's
 * differences; across it, the largest. Each child's own difference is scored
 * on the child, so a label 5% wider in a stand-in font costs the label, if
 * anything, and not the button around it.
 */
function contentAllowance(n: TreeNode, axis: "w" | "h", kids: Map<string, TreeNode[]>, flows: Map<string, { snap: Flow; figma: Flow | null }>, records: Map<string, Rec>): number {
  const flow = flows.get(n.k)?.snap;
  if (!flow?.axis) return 0;
  const i = axis === "w" ? 2 : 3;
  const diffs = (kids.get(n.k) ?? [])
    .filter((c) => flow.inflow.includes(c.k) && records.has(c.k))
    .map((c) => records.get(c.k)!.box[i] - c.box[i]);
  if (!diffs.length) return 0;
  return (flow.axis === "x") === (axis === "w") ? Math.abs(diffs.reduce((a, b) => a + b, 0)) : Math.max(...diffs.map(Math.abs));
}

type Check = (property: string, ok: boolean, measured: unknown, figma: unknown) => void;
type Unscorable = (property: string, reason: string) => void;
type Field = (name: string) => unknown;

function scoreText(n: TreeNode, rec: Rec, field: Field, check: Check, unscorable: Unscorable, spike: SpikeAssumptions): void {
  const tx = n.tx!;
  const chars = readbackChars(tx.c);
  check("chars", field("chars") === chars, chars, field("chars"));
  if (tx.fk === 1 || isFontKeyword(tx.f)) unscorable("family", `${tx.f} is a CSS keyword, the platform's font, which no Figma font is named`);
  else check("family", lower(tx.f) === lower(field("family")), tx.f, field("family"));
  check("weight", field("weight") === tx.wt, tx.wt, field("weight"));
  check("italic", field("italic") === (tx.it ? 1 : 0), tx.it ? 1 : 0, field("italic"));
  check("size", near(field("size"), tx.sz, FONT_SIZE_TOLERANCE), tx.sz, field("size"));
  const lh = field("lineHeight");
  if (tx.lh === "normal") unscorable("lineHeight", "line-height: normal, which each font's metrics set");
  else check("lineHeight", near(lh, tx.lh, FONT_SIZE_TOLERANCE), tx.lh, lh);
  check("letterSpacing", near(field("letterSpacing"), tx.ls ?? 0, LETTER_SPACING_TOLERANCE), tx.ls ?? 0, field("letterSpacing"));
  check("color", lower(field("color")) === lower(tx.col), tx.col, field("color"));
  const textCase = TEXT_CASE[tx.tt ?? ""] ?? "ORIGINAL";
  check("case", field("textCase") === textCase, textCase, field("textCase"));
  const decoration = DECORATION[tx.td ?? ""] ?? "NONE";
  check("decoration", field("decoration") === decoration, decoration, field("decoration"));
  const align = ALIGN[tx.ta ?? ""] ?? "LEFT";
  check("align", field("align") === align, align, field("align"));
  // Cut off after as many lines as the browser cut it off after, or not cut off.
  const maxLines = tx.el ? 1 : tx.cl ?? null;
  const truncation = field("truncation");
  if (maxLines !== null && !spike.textTruncation) unscorable("truncation", "Figma's text truncation is unavailable (spike item 3)");
  else if (maxLines !== null) check("truncation", truncation === "ENDING" && field("maxLines") === maxLines, { maxLines }, { truncation, maxLines: field("maxLines") });
  else check("truncation", truncation !== "ENDING", { maxLines: null }, { truncation, maxLines: field("maxLines") });
  if (tx.lh === "normal" || typeof lh !== "number" || lh <= 0) unscorable("lines", "line-height: normal, so the lines a height holds are unknown");
  else check("lines", Math.round(rec.box[3] / lh) === tx.n, tx.n, Math.round(rec.box[3] / lh));
}

function scoreVector(n: TreeNode, field: Field, assets: ComponentTree["assets"], tolerance: number, check: Check, unscorable: Unscorable): void {
  const want = n.shapes ?? [];
  const got = (Array.isArray(field("shapes")) ? field("shapes") : []) as unknown[][];
  const markup = n.svg ? assets.svg[n.svg] : undefined;
  // Content createNodeFromSvg may drop: its shapes may not come out one for one.
  if (n.approx || n.raster) {
    unscorable("shapes", n.raster ? "a raster stands in for the vector" : `the SVG holds what Figma's importer may drop (${n.approx})`);
  } else {
    const limit = Math.max(SHAPE_TOLERANCE.min, SHAPE_TOLERANCE.ratio * Math.max(n.box[2], n.box[3]));
    const same = want.length === got.length && want.every((box, i) => box.every((v, j) => near(Number(got[i][j]), v, limit)));
    check("shapes", same, `${want.length} shapes`, same ? `${got.length} shapes` : got.map((s) => s.slice(0, 4)));
  }
  const paints = markup ? svgShapePaints(markup) : null;
  if (!paints || paints.length !== got.length) {
    if (!paints) unscorable("paint", markup ? "the SVG's paints can't be read" : `no markup for ${n.svg ?? "the vector"} in the snap`);
    else check("paint", false, `${paints.length} shapes`, `${got.length} shapes`);
    return;
  }
  const bad = paints.findIndex((p, i) => {
    const [, , , , fill, stroke, weight] = got[i];
    return lower(fill) !== p.fill || lower(stroke) !== p.stroke || (p.strokeWidth !== null && p.stroke !== null && !near(weight, p.strokeWidth, tolerance));
  });
  check("paint", bad < 0, bad < 0 ? null : paints[bad], bad < 0 ? null : got[bad].slice(4));
}

function scoreImage(n: TreeNode, field: Field, assets: ComponentTree["assets"], tolerance: number, check: Check, unscorable: Unscorable, spike: SpikeAssumptions): void {
  const asset = n.img ? assets.img[n.img] : undefined;
  const fills = (Array.isArray(field("fills")) ? field("fills") : []) as string[];
  const image = fills.find((f) => typeof f === "string" && f.startsWith("img:"));
  const [, bytes, scale, size] = (image ?? "").split(":");
  if (!asset) {
    unscorable("content", `no asset ${n.img ?? ""} in the snap`);
  } else if (!spike.imageBytesKept || n.raster || asset.raster) {
    // Presence at the thumbnail's size: bytes Figma stores differently can't be compared.
    unscorable("content bytes", n.raster || asset.raster ? "a raster's bytes" : "Figma re-encodes uploaded images (spike item 10)");
    const want = `${asset.size[0]}x${asset.size[1]}`;
    check("content", size === want, `an image of ${want}`, image ?? null);
  } else {
    const want = `img:${asset.fnv}:FILL`;
    check("content", `img:${bytes}:${scale}` === want, want, image ?? null);
  }
  scoreRadius(n, field, tolerance, check);
  check("clip", Boolean(field("clip")) === Boolean(n.clip), n.clip ? 1 : 0, field("clip"));
}

function scoreRadius(n: TreeNode, field: Field, tolerance: number, check: Check): void {
  const want = sides(n.r ?? 0);
  const raw = field("radius");
  const got = typeof raw === "number" || Array.isArray(raw) ? sides(raw as Sides<number>) : null;
  check("radius", got !== null && want.every((r, i) => near(Number(got[i]), r, tolerance)), n.r ?? 0, raw);
}

function scoreFrame(n: TreeNode, field: Field, tolerance: number, check: Check, unscorable: Unscorable, spike: SpikeAssumptions): void {
  // Fills: the background color under the image layers, which CSS lists top first.
  const want: string[] = [];
  if (n.bg) want.push(n.bg.toLowerCase());
  for (const layer of n.bgi ? splitTopLevel(n.bgi).reverse() : []) {
    const gradient = cssLinearGradient(layer, n.box[2], n.box[3]);
    if (gradient) want.push(gradient);
    else unscorable("fills", `background-image ${layer.trim().slice(0, 60)} is not built in phase 1`);
  }
  const fills = (Array.isArray(field("fills")) ? field("fills") : []) as string[];
  const sameFills = fills.length === want.length && want.every((w, i) => (w.startsWith("lin:") && typeof fills[i] === "string" && fills[i].startsWith("lin:")
    ? sameGradient(w, fills[i]) : w === lower(fills[i])));
  check("fills", sameFills, want, fills);

  scoreStroke(n, field, tolerance, check, unscorable);
  scoreRadius(n, field, tolerance, check);

  // Shadows and blurs, matched one for one whatever their order.
  const effects: unknown[][] = (n.sh ?? []).map(([x, y, blur, spread, color, inset]) => [inset ? "I" : "D", x, y, blur, spread, color]);
  for (const [name, value] of [["L", n.fl], ["B", n.bf]] as const) {
    if (!value) continue;
    const blur = /^blur\((-?[\d.]+)px\)$/.exec(value.trim());
    if (blur) effects.push([name, Number(blur[1])]);
    else unscorable(name === "L" ? "filter" : "backdrop-filter", `${value} is not built in phase 1`);
  }
  if (!spike.shadowSpreadKept && effects.some((e) => e[0] === "D" || e[0] === "I")) unscorable("effects spread", "Figma's shadow spread is unavailable (spike item 2)");
  const got = (Array.isArray(field("effects")) ? field("effects") : []) as unknown[][];
  const left = [...got];
  const sameEffect = (a: unknown[], b: unknown[]) => a[0] === b[0] && (a[0] === "D" || a[0] === "I"
    ? [1, 2, 3].every((i) => near(b[i], a[i], tolerance)) && (!spike.shadowSpreadKept || near(b[4], a[4], tolerance)) && lower(b[5]) === lower(a[5])
    : near(b[1], a[1], tolerance));
  const matchedEffects = effects.every((e) => {
    const at = left.findIndex((g) => Array.isArray(g) && sameEffect(e, g));
    if (at < 0) return false;
    left.splice(at, 1);
    return true;
  });
  check("effects", matchedEffects && left.length === 0, effects, got);

  const blend = field("blend");
  if (!n.bm || n.bm === "normal") check("blend", NO_BLEND.has(String(blend)), "NORMAL", blend);
  else if (BLEND[n.bm]) check("blend", blend === BLEND[n.bm], BLEND[n.bm], blend);
  else unscorable("blend", `mix-blend-mode ${n.bm}, which Figma has no blend mode for`);
  check("clip", Boolean(field("clip")) === Boolean(n.clip), n.clip ? 1 : 0, field("clip"));
}

function scoreStroke(n: TreeNode, field: Field, tolerance: number, check: Check, unscorable: Unscorable): void {
  const got = field("stroke") as [unknown, unknown, unknown, unknown] | null;
  const weights = n.bd ? sides(n.bd.w) : [0, 0, 0, 0];
  if (!n.bd || weights.every((w) => !w)) {
    check("stroke", got == null, null, got);
    return;
  }
  const drawn = [0, 1, 2, 3].filter((i) => weights[i] > 0);
  const colors = [...new Set(drawn.map((i) => lower(sides(n.bd!.c)[i])))];
  const style = String(sides(n.bd.s)[drawn[0]]);
  const align = n.bgc === "padding-box" || n.bgc === "content-box" ? "O" : "I";
  const want = [Array.isArray(n.bd.w) ? weights : weights[0], colors.length === 1 ? (colors[0] ? [colors[0]] : []) : colors, style, align];
  if (colors.length > 1) unscorable("stroke color", "per-side border colors, built as one in phase 1");
  if (!STROKE_STYLES.has(style)) unscorable("stroke style", `a ${style} border, which Figma's strokes don't draw`);
  if (!Array.isArray(got)) {
    check("stroke", false, want, got);
    return;
  }
  const gotWeights = sides((got[0] ?? 0) as Sides<number>);
  const paints = (Array.isArray(got[1]) ? got[1] : []).map(lower);
  const ok = weights.every((w, i) => near(Number(gotWeights[i]), w, tolerance))
    && (colors.length > 1 || paints.join() === (colors[0] ? [colors[0]] : []).join())
    && (!STROKE_STYLES.has(style) || got[2] === style)
    && got[3] === align;
  check("stroke", ok, want, got);
}
