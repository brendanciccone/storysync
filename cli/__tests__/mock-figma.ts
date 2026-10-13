// A mock of Figma's Plugin API, for running plugin code the way use_figma
// runs it, against a simulated file that keeps what each call builds.
//
// figma-standin.ts serves just enough of a file for the CLI's own reads. The
// element tree needs more: the build template creates frames, text and
// vectors and converges them call after call, and verify scores what the
// readback template reads off them, so the geometry those reads see has to
// come from somewhere other than the code under test. This lays out auto
// layout, sizes text and imports SVGs itself, by Figma's documented rules,
// so a template that sets the wrong property builds the wrong box here too.
//
// The use_figma limits it enforces, as the tool does:
// - code of at most 50,000 characters, and a response of at most 20,000
//   bytes of JSON;
// - one page switch per call, through setCurrentPageAsync; the sync
//   `figma.currentPage = ...` throws, and each call starts on the first page
//   with only that page loaded, whose children are the only ones readable
//   until a page is loaded;
// - no createImage, createImageAsync, setPluginData, notify or
//   loadAllPagesAsync: images arrive only through `uploadAssets`, this
//   file's stand-in for the upload_assets tool;
// - fonts load per call, and a text property written in a font not loaded
//   throws, as Figma does (and, with `moveNeedsFonts`, so does moving a
//   node that holds such a text);
// - paints are validated as Figma validates them: a SOLID color is
//   `{ r, g, b }` in 0-1 with no `a`, a shadow needs `visible` and
//   `blendMode`, and the arrays a node hands out are frozen.
// A property a node type lacks (`children` on a TEXT node, `characters` on
// a frame) throws on read and write, and `"children" in node` is false.
//
// What it simplifies, each named where it lives: text widths come from a
// measure, by default figmaFonts, Figma's own fonts as wide as Figma sets
// them, or one the test gives (measureFromTrees learns them from snap's ink
// boxes, so a faithful build lands where the browser drew); wrapping is
// greedy by words. Text follows what the live text probe saw Figma do
// (2026-10-09, fixtures/figma-text-probe.json): any write of textAutoResize
// turns truncation off and clears maxLines, ENDING on a text that sizes
// itself limits it to one line, and a text's size comes out rounded up to a
// whole pixel. Where the design's Figma spike measured Figma live (2026-10-08,
// fixtures/figma-spike.json), the mock does what Figma did there: an
// imported SVG's strokes scale with it, its frame clips and has a fill, and a
// `<g>` comes in as a GROUP; clone() keeps plugin data and lands a copy of a
// page's own node beside it, and a copy of anything nested on the page;
// strokes included in layout take room only when INSIDE; a child filling or
// growing along a hugging frame keeps its size, and one filling across it
// takes the size the others give; FILL on a hugging label turns it to
// HEIGHT; AUTO line height comes out a whole pixel. The behaviors a build
// might meet otherwise (strokes that don't scale, plugin data clone() drops,
// re-encoded uploads, a refused spread, truncation or fill across a hug)
// stay options, defaulting to what the spike saw, so a test can still run a
// build's fallbacks. A test in mock-figma.test.ts replays the probe here and
// holds the result to the live one.
//
// What it refuses rather than guess, throwing a "mock-figma:" error from the
// layout, so the call that set it up fails as a build Figma would collapse
// should: a wrapping auto layout; a group in an auto layout's flow, or a
// turned layer there that fills, unless turned 180 degrees (a turned layer
// is laid out by its turned box, as the sixth and seventh probes saw,
// fixtures/figma-tsum-probe.json and figma-probe-7.json call 1); and FILL
// on a text node that sizes itself on that axis (WIDTH_AND_HEIGHT, or HEIGHT
// for its height) other than through layoutSizingHorizontal, which the spike
// saw switch it to HEIGHT; the figma-use skill documents Figma ignoring the
// rest. A layout the mock refuses stays refused, on every read, until a
// write fixes it.
//
// Also here, for the tree packages' tests: the T fixtures under
// fixtures/tree/, and helpers to load and expand them.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expandTree } from "../tree-types.js";
import type { Box, ComponentTree, NoClassPaint, TreeDelta, TreeNode } from "../tree-types.js";
import type { SnapComponent, SnapResult } from "../snap.js";

export const CODE_LIMIT = 50_000;
export const RESPONSE_LIMIT = 20_000;

// --- Options ----------------------------------------------------------------

/** A text node's font as the mock measures it: px size, and letter spacing in px. */
export interface MockFont {
  family: string;
  style: string;
  size: number;
  letterSpacing: number;
}

/**
 * How wide text is. `advance` is one line's width; `lines`, when it knows
 * better than greedy wrapping, how many lines the text takes wrapped at
 * `width`, else undefined. `words` says `advance` measures any string, its
 * words included, so wrapping goes by each word's own width rather than its
 * share of the line's.
 */
export interface TextMeasure {
  advance(chars: string, font: MockFont): number;
  lines?(chars: string, font: MockFont, width: number): number | undefined;
  words?: boolean;
}

export interface MockFigmaOptions {
  /** Families and their style names that loadFontAsync loads. Default FONTS. */
  fonts?: Record<string, readonly string[]>;
  /**
   * Text widths. Default figmaFonts(): Inter, Roboto Mono and Noto Serif as
   * Figma sets them, and estimateAdvance, which knows no real font, for any
   * other family. measureFromTrees gives the widths snap measured instead.
   */
  measure?: TextMeasure;
  /**
   * Whether clone() copies shared plugin data onto the copies. Default true,
   * as the spike saw (item 5: on the copy and its children); false runs a
   * build that must not rely on it.
   */
  clonePluginData?: boolean;
  /**
   * Whether an imported SVG's stroke widths scale with it from its viewBox to
   * its width and height, as the browser's do. Default true, as the spike saw
   * (item 1: lucide's 2 at 24 came in 1.33 wide at 16); with false they keep
   * their viewBox width.
   */
  svgStrokeScales?: boolean;
  /** The file's pages by name. Default one, "Page 1". */
  pages?: string[];
  /**
   * What Figma stores for uploaded bytes, if it re-encodes them. Default:
   * the bytes, as the spike saw (item 10: the same bytes, hashed by their
   * SHA-1).
   */
  reencodeImage?: (bytes: Uint8Array) => Uint8Array;
  /**
   * What a child that fills across its parent (FILL on the cross axis,
   * layoutAlign STRETCH) does when the parent hugs that axis. "stretch", the
   * default and what the spike saw (item 11): the parent hugs the children
   * that do not fill, and the filling ones take that size; one alone keeps
   * its own. "refuse": the layout throws, for a build that must not rely on
   * it.
   */
  fillAcrossHug?: "stretch" | "refuse";
  /**
   * For a build's fallbacks: "refuse" throws on a shadow with a spread on a
   * node that doesn't clip its content, and on textTruncation ENDING. The
   * default, "keep", is what the spike saw (items 2 and 3: spread kept on a
   * frame clipped or not, and ENDING with maxLines taken).
   */
  shadowSpread?: "keep" | "refuse";
  textTruncation?: "keep" | "refuse";
  /**
   * Whether appendChild and insertChild throw on a node holding a text whose
   * font this call hasn't loaded, as the figma-use skill documents Figma
   * doing for any operation on such a node. Default false, so code that
   * only moves frames needn't load fonts; true for a template that moves
   * layers it didn't make.
   */
  moveNeedsFonts?: boolean;
  /**
   * The most modes a variable collection can have, as a Figma plan limits
   * them: addMode past it throws. Default no limit.
   */
  maxModes?: number;
}

/**
 * The fonts a plugin context has, with Figma's own style names: Inter's
 * spaced, Roboto Mono's and Noto Serif's not; Roboto Mono stops at Bold. As
 * scripts/acceptance.mjs has them, so templates meet the same fonts.
 */
export const FONTS: Record<string, readonly string[]> = {
  Inter: ["Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"],
  "Roboto Mono": ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold"],
  "Noto Serif": ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"],
};

/** CSS weights by Figma style name, spaced or not, as the readback template maps them. */
const WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

export function weightOfStyle(style: string): number {
  return WEIGHTS[style.toLowerCase().replace(/[^a-z]/g, "").replace(/italic$/, "")] ?? 400;
}

/** A width for text no measure knows: 0.55em a character, plus letter spacing. Deterministic, and no font's. */
export function estimateAdvance(chars: string, font: MockFont): number {
  return chars.length * (font.size * 0.55 + font.letterSpacing);
}

/** The fonts storysync draws stand-ins in, as scripts/figma-font-metrics.mjs measured them: each character's advance and the kerning pairs of printable ASCII, in em. */
interface FontMetrics {
  chars: string;
  kerned: number[];
  lineHeight: Record<string, number>;
  fonts: Record<string, Record<string, { advance: number[]; kern?: Record<string, number> }>>;
}
let fontMetrics: FontMetrics | null = null;
const metrics = (): FontMetrics =>
  (fontMetrics ??= JSON.parse(readFileSync(fileURLToPath(new URL("../../../cli/__tests__/fixtures/figma-fonts.json", import.meta.url)), "utf8")) as FontMetrics);

/**
 * Text as wide as Figma sets it in Inter, Roboto Mono and Noto Serif, the
 * fonts it has and the stand-ins snap draws in (cli/fonts.ts): each
 * character's advance with the kerning between them, plus letter spacing,
 * from fixtures/figma-fonts.json, which Chrome measured in the faces snap
 * draws in. Those are rounded as Figma rounds them, so each string of the
 * fourth push's text probe comes out within 0.002px of the width Figma gave
 * it (fixtures/figma-text-probe-3.json), but in Noto Serif Bold, which
 * Figma has of another release. Another family is measured by `fallback`. Figma rounds a
 * hugging text's width up to a pixel (sizeText), and keeps a line whole only
 * in a box at least as wide as it (FITS).
 */
export function figmaFonts(fallback: TextMeasure = { advance: estimateAdvance }): TextMeasure {
  const table = metrics();
  const nearest = (keys: number[], weight: number) => keys.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
  return {
    words: true,
    advance(chars, font) {
      const family = table.fonts[font.family];
      if (!family) return fallback.advance(chars, font);
      const weight = weightOfStyle(font.style);
      const italic = /italic/i.test(font.style) && Object.keys(family).some((k) => k.endsWith("i")) ? "i" : "";
      const weights = Object.keys(family).filter((k) => k.endsWith("i") === Boolean(italic)).map((k) => parseInt(k, 10));
      const metrics = family[`${nearest(weights, weight)}${italic}`];
      const kern = family[`${nearest(table.kerned, weight)}${italic}`]?.kern ?? {};
      let em = 0;
      let prev = "";
      for (const ch of chars) {
        const at = table.chars.indexOf(ch);
        em += at >= 0 ? metrics.advance[at] : 0.55;
        em += kern[prev + ch] ?? 0;
        prev = ch;
      }
      return em * font.size + [...chars].length * font.letterSpacing;
    },
  };
}

const textKey = (chars: string, size: number, weight: number) => `${size}|${weight}|${chars}`;

/**
 * A measure that knows the text snap measured: each text node's ink width,
 * by its characters, size and weight, so a node built from those facts at
 * width factor 1 comes out as wide as the browser drew it. A run snap saw on
 * one line gives its advance; one it saw wrap gives its line count at the
 * width it wrapped in. Anything else falls back to `fallback`.
 */
export function measureFromTrees(trees: TreeNode[][], fallback: TextMeasure = { advance: estimateAdvance }): TextMeasure {
  const single = new Map<string, number>();
  const wrapped = new Map<string, { width: number; lines: number; ink: number }>();
  for (const node of trees.flat()) {
    if (!node.tx) continue;
    const key = textKey(node.tx.c, node.tx.sz, node.tx.wt);
    if (node.tx.n === 1) single.set(key, node.tx.ink[2]);
    else wrapped.set(key, { width: node.box[2], lines: node.tx.n, ink: node.tx.ink[2] });
  }
  const lookup = (chars: string, font: MockFont) => textKey(chars, font.size, weightOfStyle(font.style));
  return {
    advance(chars, font) {
      const key = lookup(chars, font);
      const known = single.get(key);
      if (known !== undefined) return known;
      // A run seen only wrapped: its widest line times its lines is an upper
      // bound on its advance, near enough to wrap it the same way again.
      const seen = wrapped.get(key);
      return seen ? seen.ink * seen.lines : fallback.advance(chars, font);
    },
    lines(chars, font, width) {
      const seen = wrapped.get(lookup(chars, font));
      if (seen && Math.abs(seen.width - width) <= 1) return seen.lines;
      return fallback.lines?.(chars, font, width);
    },
  };
}

// --- Values -----------------------------------------------------------------

type Rgb = { r: number; g: number; b: number };
type Rgba = Rgb & { a: number };
type Alias = { type: "VARIABLE_ALIAS"; id: string };
type Bound = { boundVariables?: Record<string, Alias> };

export type SolidPaint = { type: "SOLID"; color: Rgb; opacity: number; visible: boolean; blendMode: string } & Bound;
export type GradientPaint = {
  type: string; gradientTransform: number[][]; gradientStops: { position: number; color: Rgba }[];
  opacity: number; visible: boolean; blendMode: string;
};
export type ImagePaint = { type: "IMAGE"; imageHash: string | null; scaleMode: string; opacity: number; visible: boolean; blendMode: string };
export type Paint = SolidPaint | GradientPaint | ImagePaint;
export type Effect = {
  type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR";
  color?: Rgba; offset?: { x: number; y: number }; radius: number; spread?: number;
  visible: boolean; blendMode?: string; showShadowBehindNode?: boolean;
} & Bound;

const BLEND_MODES = [
  "PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE",
  "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
];

/** Throws as Figma's validation does, naming the setter. */
function invalid(prop: string, why: string): never {
  throw new Error(`in set_${prop}: ${why}`);
}

function oneOf<T extends string>(prop: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(prop, `Expected ${allowed.map((a) => `'${a}'`).join(" | ")}, received ${JSON.stringify(value)}`);
  }
  return value as T;
}

function finite(prop: string, value: unknown, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(prop, `Expected number, received ${JSON.stringify(value)}`);
  if (value < min || value > max) invalid(prop, `Property value out of range: ${value} (expected ${min} to ${max})`);
  return value;
}

/** An object with exactly the allowed keys, those `required` present. */
function shape(prop: string, value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(prop, `Expected object, received ${JSON.stringify(value)}`);
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !allowed.includes(k));
  if (extra.length) invalid(prop, `Unrecognized key(s) in object: ${extra.map((k) => `'${k}'`).join(", ")}`);
  for (const key of required) if (record[key] === undefined) invalid(prop, `Required value missing at ${key}`);
  return record;
}

function rgb(prop: string, value: unknown): Rgb {
  const c = shape(prop, value, ["r", "g", "b"], ["r", "g", "b"]);
  return { r: finite(prop, c.r, 0, 1), g: finite(prop, c.g, 0, 1), b: finite(prop, c.b, 0, 1) };
}

function rgba(prop: string, value: unknown): Rgba {
  const c = shape(prop, value, ["r", "g", "b", "a"], ["r", "g", "b", "a"]);
  return { r: finite(prop, c.r, 0, 1), g: finite(prop, c.g, 0, 1), b: finite(prop, c.b, 0, 1), a: finite(prop, c.a, 0, 1) };
}

function bound(prop: string, value: unknown): Record<string, Alias> | undefined {
  if (value === undefined) return undefined;
  const record = shape(prop, value, ["color"], []);
  return record.color ? { color: shape(prop, record.color, ["type", "id"], ["type", "id"]) as Alias } : undefined;
}

const PAINT_COMMON = ["type", "opacity", "visible", "blendMode", "boundVariables"];
const IMAGE_KEYS = ["imageHash", "scaleMode", "imageTransform", "scalingFactor", "rotation", "filters"];

function paint(prop: string, value: unknown): Paint {
  const p = shape(prop, value, [...PAINT_COMMON, "color", "gradientTransform", "gradientStops", ...IMAGE_KEYS], ["type"]);
  const common = {
    opacity: p.opacity === undefined ? 1 : finite(prop, p.opacity, 0, 1),
    visible: p.visible === undefined ? true : Boolean(p.visible),
    blendMode: p.blendMode === undefined ? "NORMAL" : oneOf(prop, p.blendMode, BLEND_MODES),
  };
  switch (p.type) {
    case "SOLID": {
      shape(prop, value, [...PAINT_COMMON, "color"], ["type", "color"]);
      const out: SolidPaint = { type: "SOLID", color: rgb(prop, p.color), ...common };
      const vars = bound(prop, p.boundVariables);
      if (vars) out.boundVariables = vars;
      return out;
    }
    case "GRADIENT_LINEAR": case "GRADIENT_RADIAL": case "GRADIENT_ANGULAR": case "GRADIENT_DIAMOND": {
      shape(prop, value, [...PAINT_COMMON, "gradientTransform", "gradientStops"], ["type", "gradientTransform", "gradientStops"]);
      const stops = p.gradientStops;
      if (!Array.isArray(stops)) invalid(prop, "Expected array at gradientStops");
      return {
        type: p.type, ...common,
        gradientTransform: (p.gradientTransform as number[][]).map((row) => row.map((n) => finite(prop, n))),
        gradientStops: stops.map((s) => {
          const stop = shape(prop, s, ["position", "color", "boundVariables"], ["position", "color"]);
          return { position: finite(prop, stop.position, 0, 1), color: rgba(prop, stop.color) };
        }),
      };
    }
    case "IMAGE":
      shape(prop, value, [...PAINT_COMMON, ...IMAGE_KEYS], ["type", "scaleMode"]);
      return {
        type: "IMAGE", ...common,
        imageHash: p.imageHash == null ? null : String(p.imageHash),
        scaleMode: oneOf(prop, p.scaleMode, ["FILL", "FIT", "CROP", "TILE"]),
      };
    default:
      return invalid(prop, `Invalid paint type ${JSON.stringify(p.type)}`);
  }
}

function effect(value: unknown): Effect {
  const keys = ["type", "color", "offset", "radius", "spread", "visible", "blendMode", "showShadowBehindNode", "boundVariables"];
  const e = shape("effects", value, keys, ["type", "radius", "visible"]);
  const type = oneOf("effects", e.type, ["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"] as const);
  const out: Effect = { type, radius: finite("effects", e.radius, 0), visible: Boolean(e.visible) };
  if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
    for (const key of ["color", "offset", "blendMode"]) if (e[key] === undefined) invalid("effects", `Required value missing at ${key}`);
    const offset = shape("effects", e.offset, ["x", "y"], ["x", "y"]);
    out.color = rgba("effects", e.color);
    out.offset = { x: finite("effects", offset.x), y: finite("effects", offset.y) };
    out.spread = e.spread === undefined ? 0 : finite("effects", e.spread);
    out.blendMode = oneOf("effects", e.blendMode, BLEND_MODES);
    if (type === "DROP_SHADOW") out.showShadowBehindNode = Boolean(e.showShadowBehindNode);
  }
  const vars = bound("effects", e.boundVariables);
  if (vars) out.boundVariables = vars;
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const frozenCopy = <T>(value: T): T => deepFreeze(structuredClone(value));

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or a few names, to 0-1 channels; null for none. */
export function parseHexColor(value: string | null | undefined, current = "#000000"): Rgba | null {
  const text = (value ?? "").trim().toLowerCase();
  if (!text || text === "none" || text === "transparent") return null;
  if (text === "currentcolor") return parseHexColor(current);
  const named: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000" };
  const hex = named[text] ?? text;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(hex);
  if (!m) throw new Error(`mock-figma: color ${JSON.stringify(value)} is not hex; snap writes every color as hex`);
  const digits = m[1].length <= 4 ? [...m[1]].map((d) => d + d).join("") : m[1];
  const byte = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) : 1 };
}

// --- SVG --------------------------------------------------------------------

/** One painted shape of an SVG, its box in the SVG's own px, after viewBox scaling. */
export interface SvgShape {
  tag: string;
  box: Box;
  fill: Rgba | null;
  stroke: Rgba | null;
  strokeWidth: number;
  cap: string;
  join: string;
  /** Its own opacity, and an `<svg>`'s around it; a `<g>`'s is its group's. */
  opacity: number;
  /** The `<g>`s it is in, outermost first, as indexes into ParsedSvg.groups. */
  groups: number[];
}

export interface ParsedSvg {
  width: number;
  height: number;
  /** viewBox units to px: the uniform scale and offsets of `xMidYMid meet`. */
  scale: number;
  shapes: SvgShape[];
  /** Each `<g>`, in document order, with its own opacity: Figma imports one as a GROUP. */
  groups: { opacity: number }[];
  /** Elements not drawn as shapes, which Figma's import may drop (defs, clipPath, mask, use, text). */
  dropped: string[];
}

type Matrix = [number, number, number, number, number, number]; // a b c d e f
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, [x, y]: [number, number]): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseTransform(text: string | undefined): Matrix {
  let out = IDENTITY;
  for (const [, fn, args] of (text ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const n = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let m: Matrix = IDENTITY;
    if (fn === "translate") m = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
    else if (fn === "scale") m = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    else if (fn === "matrix") m = n.slice(0, 6) as Matrix;
    else if (fn === "rotate") {
      const r = ((n[0] ?? 0) * Math.PI) / 180;
      const [cx, cy] = [n[1] ?? 0, n[2] ?? 0];
      m = multiply(multiply([1, 0, 0, 1, cx, cy], [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    }
    out = multiply(out, m);
  }
  return out;
}

/** The points that bound a path: each segment's ends and its extremes, and samples of any arc. */
function pathPoints(d: string): [number, number][] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const points: [number, number][] = [];
  let i = 0;
  let cmd = "";
  let [x, y] = [0, 0];
  let [sx, sy] = [0, 0];
  let [cx, cy] = [0, 0]; // last control point, for S and T
  let last = "";
  const num = () => Number(tokens[i++]);
  // An arc flag can run straight into the next number ("011 1"); take one digit.
  const flag = () => {
    const t = tokens[i];
    if (t.length > 1 && (t[0] === "0" || t[0] === "1")) {
      tokens[i] = t.slice(1);
      return Number(t[0]);
    }
    i++;
    return Number(t);
  };
  const cubic = (p0: number[], p1: number[], p2: number[], p3: number[]) => {
    for (let axis = 0; axis < 2; axis++) {
      const a = p3[axis] - 3 * p2[axis] + 3 * p1[axis] - p0[axis];
      const b = 2 * (p2[axis] - 2 * p1[axis] + p0[axis]);
      const c = p1[axis] - p0[axis];
      const roots = Math.abs(a) < 1e-12 ? (Math.abs(b) < 1e-12 ? [] : [-c / b])
        : (() => { const disc = b * b - 4 * a * c; return disc < 0 ? [] : [(-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a)]; })();
      for (const t of roots) {
        if (t <= 0 || t >= 1) continue;
        const u = 1 - t;
        points.push([0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]) as [number, number]);
      }
    }
  };
  const arc = (x1: number, y1: number, rxIn: number, ryIn: number, angle: number, large: number, sweep: number, x2: number, y2: number) => {
    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    if (!rx || !ry) return;
    const phi = (angle * Math.PI) / 180;
    const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy;
    const y1p = -sin * dx + cos * dy;
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
    const cxp = (coef * rx * y1p) / ry;
    const cyp = (-coef * ry * x1p) / rx;
    const ccx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const ccy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const at = (t: number): [number, number] => [
      ccx + rx * cos * Math.cos(t) - ry * sin * Math.sin(t),
      ccy + rx * sin * Math.cos(t) + ry * cos * Math.sin(t),
    ];
    // The ellipse's own extremes, where its tangent is horizontal or vertical,
    // wherever the arc passes them; and samples, for what rounding leaves.
    const extremes = [Math.atan2(-ry * sin, rx * cos), Math.atan2(ry * cos, rx * sin)];
    for (const base of extremes) {
      for (let k = -4; k <= 4; k++) {
        const t = base + (k * Math.PI);
        const into = dt >= 0 ? t > t1 && t < t1 + dt : t < t1 && t > t1 + dt;
        if (into) points.push(at(t));
      }
    }
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M":
        [x, y] = [ox + num(), oy + num()];
        [sx, sy] = [x, y];
        points.push([x, y]);
        cmd = rel ? "l" : "L"; // further pairs are lines
        break;
      case "L":
        [x, y] = [ox + num(), oy + num()];
        points.push([x, y]);
        break;
      case "H":
        x = ox + num();
        points.push([x, y]);
        break;
      case "V":
        y = oy + num();
        points.push([x, y]);
        break;
      case "C": {
        const p1 = [ox + num(), oy + num()];
        const p2 = [ox + num(), oy + num()];
        const p3 = [ox + num(), oy + num()];
        cubic([x, y], p1, p2, p3);
        [cx, cy] = p2;
        [x, y] = p3;
        points.push([x, y]);
        break;
      }
      case "S": {
        const p1 = /[CS]/i.test(last) ? [2 * x - cx, 2 * y - cy] : [x, y];
        const p2 = [ox + num(), oy + num()];
        const p3 = [ox + num(), oy + num()];
        cubic([x, y], p1, p2, p3);
        [cx, cy] = p2;
        [x, y] = p3;
        points.push([x, y]);
        break;
      }
      case "Q": case "T": {
        const p1 = cmd.toUpperCase() === "Q" ? [ox + num(), oy + num()] : /[QT]/i.test(last) ? [2 * x - cx, 2 * y - cy] : [x, y];
        const p2 = [ox + num(), oy + num()];
        // A quadratic is the cubic with these control points.
        cubic([x, y], [x + (2 / 3) * (p1[0] - x), y + (2 / 3) * (p1[1] - y)], [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])], p2);
        [cx, cy] = p1;
        [x, y] = p2;
        points.push([x, y]);
        break;
      }
      case "A": {
        const [rx, ry, angle] = [num(), num(), num()];
        const [large, sweep] = [flag(), flag()];
        const [nx, ny] = [ox + num(), oy + num()];
        arc(x, y, rx, ry, angle, large, sweep, nx, ny);
        [x, y] = [nx, ny];
        points.push([x, y]);
        break;
      }
      case "Z":
        [x, y] = [sx, sy];
        break;
      default:
        throw new Error(`mock-figma: path command ${cmd} in ${JSON.stringify(d)}`);
    }
    last = cmd;
  }
  return points;
}

const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

interface SvgElement { tag: string; attrs: Record<string, string>; children: SvgElement[] }

function parseXml(markup: string): SvgElement {
  const root: SvgElement = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const body = markup.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  for (const [, close, tag, rawAttrs, selfClose] of body.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g)) {
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, name, , dq, sq] of rawAttrs.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[name] = decode(dq ?? sq ?? "");
    const element: SvgElement = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(element);
    if (!selfClose) stack.push(element);
  }
  const svg = root.children.find((e) => e.tag === "svg");
  if (!svg) throw new Error("Failed to parse SVG: no <svg> element");
  return svg;
}

/** Rounded to 0.01 as tree-types rounds: through 1e-6 first, never -0. */
const r2 = (n: number) => Math.round(Math.round(n * 1e8) / 1e6) / 100 || 0;

/**
 * Parses SVG markup as Figma's importer reads it for the mock: each shape's
 * geometric box, as the browser's getBoundingClientRect measures a shape
 * (its geometry, not its stroke), and its resolved paint. Curves and arcs
 * are bounded exactly by their extremes, so a lucide icon's boxes match the
 * ones snap measures in Chrome.
 */
export function parseSvg(markup: string): ParsedSvg {
  const svg = parseXml(markup);
  const px = (v: string | undefined) => (v === undefined ? undefined : parseFloat(v));
  const view = (svg.attrs.viewBox ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
  const width = px(svg.attrs.width) ?? view[2] ?? 300;
  const height = px(svg.attrs.height) ?? view[3] ?? 150;
  const [vx, vy, vw, vh] = view.length === 4 ? view : [0, 0, width, height];
  // preserveAspectRatio's default, xMidYMid meet: one scale, centered.
  const scale = Math.min(width / vw, height / vh);
  const base: Matrix = [scale, 0, 0, scale, (width - vw * scale) / 2 - vx * scale, (height - vh * scale) / 2 - vy * scale];
  const shapes: SvgShape[] = [];
  const groups: ParsedSvg["groups"] = [];
  const dropped: string[] = [];
  type Paint = Record<string, string>;
  const PAINT = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-opacity", "stroke-opacity", "color"];
  const visit = (el: SvgElement, inherited: Paint, m: Matrix, opacity: number, chain: number[]) => {
    const style = Object.fromEntries((el.attrs.style ?? "").split(";").map((d) => d.split(":").map((s) => s.trim())).filter((d) => d.length === 2 && d[0]));
    const own = { ...inherited };
    for (const key of PAINT) {
      const value = style[key] ?? el.attrs[key];
      if (value !== undefined) own[key] = value;
    }
    const ownOpacity = el.attrs.opacity !== undefined ? Number(el.attrs.opacity) : 1;
    const alpha = opacity * ownOpacity;
    const at = multiply(m, parseTransform(el.attrs.transform));
    const n = (name: string) => Number(el.attrs[name] ?? 0);
    let local: [number, number][] | null = null;
    switch (el.tag) {
      case "svg":
        for (const child of el.children) visit(child, own, at, alpha, chain);
        return;
      case "g": {
        // A group of its own, as the spike saw Figma import one (item 1),
        // its transform applied to its shapes and its opacity kept on it.
        const group = groups.push({ opacity: ownOpacity }) - 1;
        for (const child of el.children) visit(child, own, at, opacity, [...chain, group]);
        return;
      }
      case "path": local = pathPoints(el.attrs.d ?? ""); break;
      case "circle": local = [[n("cx") - n("r"), n("cy") - n("r")], [n("cx") + n("r"), n("cy") + n("r")]]; break;
      case "ellipse": local = [[n("cx") - n("rx"), n("cy") - n("ry")], [n("cx") + n("rx"), n("cy") + n("ry")]]; break;
      case "rect": local = [[n("x"), n("y")], [n("x") + n("width"), n("y") + n("height")]]; break;
      case "line": local = [[n("x1"), n("y1")], [n("x2"), n("y2")]]; break;
      case "polyline": case "polygon": {
        const coords = (el.attrs.points ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
        local = [];
        for (let k = 0; k + 1 < coords.length; k += 2) local.push([coords[k], coords[k + 1]]);
        break;
      }
      case "title": case "desc": case "metadata":
        return;
      default:
        dropped.push(el.tag);
        return;
    }
    if (!local.length) return;
    const pts = local.map((p) => apply(at, p));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
    const color = own.color ?? "#000000";
    const withAlpha = (c: Rgba | null, extra: string | undefined) => (c ? { ...c, a: c.a * (extra === undefined ? 1 : Number(extra)) } : null);
    const scaleOf = Math.sqrt(Math.abs(at[0] * at[3] - at[1] * at[2]));
    shapes.push({
      tag: el.tag,
      box: [r2(x0), r2(y0), r2(Math.max(...xs) - x0), r2(Math.max(...ys) - y0)],
      // SVG fills every shape black unless told otherwise; a line has no area to fill.
      fill: el.tag === "line" ? null : withAlpha(parseHexColor(own.fill ?? "#000000", color), own["fill-opacity"]),
      stroke: withAlpha(parseHexColor(own.stroke ?? "none", color), own["stroke-opacity"]),
      strokeWidth: parseFloat(own["stroke-width"] ?? "1") * scaleOf,
      cap: own["stroke-linecap"] ?? "butt",
      join: own["stroke-linejoin"] ?? "miter",
      opacity: alpha,
      groups: chain,
    });
  };
  visit(svg, {}, base, 1, []);
  return { width, height, scale, shapes, groups, dropped };
}

/** Each painted shape's box relative to the SVG's own box, as snap records `shapes`. */
export function svgShapeBoxes(markup: string): Box[] {
  return parseSvg(markup).shapes.map((s) => s.box);
}

// --- Images -----------------------------------------------------------------

/** An image's pixel size from its PNG, JPEG or GIF header, or null. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      const length = view.getUint16(at + 2);
      // Start-of-frame markers, every kind but DHT, JPG and DAC.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

// --- Nodes ------------------------------------------------------------------

// A GROUP comes only from an imported SVG's <g>. As in Figma, it has no
// coordinates of its own: its children's x and y, and its own, are in the
// frame around it, and its box is what its children cover. It has no fills
// or strokes; it has effects, as Figma's groups do, which the build reads.
type Kind = "DOCUMENT" | "PAGE" | "FRAME" | "COMPONENT" | "COMPONENT_SET" | "GROUP" | "TEXT" | "VECTOR" | "ELLIPSE" | "RECTANGLE" | "LINE" | "POLYGON";

const CONTAINERS = new Set<Kind>(["DOCUMENT", "PAGE", "FRAME", "COMPONENT", "COMPONENT_SET", "GROUP"]);
const FRAMES = new Set<Kind>(["FRAME", "COMPONENT", "COMPONENT_SET"]);
const SCENE = new Set<Kind>(["FRAME", "COMPONENT", "COMPONENT_SET", "GROUP", "TEXT", "VECTOR", "ELLIPSE", "RECTANGLE", "LINE", "POLYGON"]);
const GEOMETRY = new Set<Kind>(["FRAME", "COMPONENT", "COMPONENT_SET", "TEXT", "VECTOR", "ELLIPSE", "RECTANGLE", "LINE", "POLYGON"]);
const CORNERS = new Set<Kind>(["FRAME", "COMPONENT", "COMPONENT_SET", "RECTANGLE", "VECTOR", "POLYGON"]);
const SIDED = new Set<Kind>(["FRAME", "COMPONENT", "COMPONENT_SET", "RECTANGLE"]);

export const MIXED: unique symbol = Symbol("figma.mixed");

/**
 * A local variable: `value` is its value in its collection's default mode,
 * the first, which a bound paint or field shows, as Figma shows a node in
 * no explicit mode; `modes` is its value in each mode by name, in order.
 */
interface Variable { id: string; name: string; resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN"; value: unknown; collection: string; modes: [string, unknown][]; scopes?: string[] }

/** The scopes Figma takes on a variable of each type; ALL_FILLS takes no other fill scope beside it. */
const VARIABLE_SCOPES: Record<Variable["resolvedType"], readonly string[]> = {
  COLOR: ["ALL_SCOPES", "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR", "EFFECT_COLOR"],
  FLOAT: ["ALL_SCOPES", "TEXT_CONTENT", "CORNER_RADIUS", "WIDTH_HEIGHT", "GAP", "OPACITY", "STROKE_FLOAT", "EFFECT_FLOAT", "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT", "FONT_VARIATIONS"],
  STRING: ["ALL_SCOPES", "TEXT_CONTENT", "FONT_FAMILY", "FONT_STYLE"],
  BOOLEAN: ["ALL_SCOPES"],
};

class Doc {
  next = 1;
  pages: Node[] = [];
  root: Node;
  byId = new Map<string, Node>();
  dirty = true;
  images = new Map<string, { bytes: Uint8Array; size: { width: number; height: number } | null }>();
  variables = new Map<string, Variable>();
  /** Each variable collection's modes, by name, in order: a mode's id is `1:` and its place. */
  collections = new Map<string, string[]>();
  /** Every change to a variable or a collection, in order, for a test to see that a call made none. */
  variableWrites: string[] = [];
  /** The next variable's id number: never one a removed variable had. */
  nextVariable = 1;
  call: Call | null = null;
  constructor(readonly options: Required<Omit<MockFigmaOptions, "pages" | "reencodeImage">> & Pick<MockFigmaOptions, "reencodeImage">, pages: string[]) {
    this.root = new Node(this, "DOCUMENT", "Document", "0:0");
    for (const name of pages) this.addPage(name);
  }

  private pageIds = 1;

  addPage(name: string): Node {
    const page = new Node(this, "PAGE", name, `0:${this.pageIds++}`);
    this.pages.push(page);
    page.parent = this.root;
    this.root.kids.push(page);
    return page;
  }

  id(): string {
    return `1:${this.next++}`;
  }

  /**
   * Lays out every page, when anything changed since the last time. A layout
   * the mock refuses throws, and leaves the document dirty, so every later
   * read throws the same until a write fixes it.
   */
  settle(): void {
    if (!this.dirty) return;
    // A fill or a wrap can change a size a parent hugs, so run to a fixed point.
    for (let pass = 0; pass < 4; pass++) {
      const before = this.signature();
      for (const page of this.pages) for (const node of page.kids) layoutTree(node);
      if (this.signature() === before) break;
    }
    this.dirty = false;
  }

  signature(): string {
    const parts: number[] = [];
    const walk = (n: Node) => {
      parts.push(n.x, n.y, n.w, n.h);
      n.kids.forEach(walk);
    };
    this.pages.forEach(walk);
    return parts.join(",");
  }
}

interface Call {
  switches: string[];
  loaded: Set<string>;
  fonts: Set<string>;
  current: Node;
  created: number;
  removed: number;
}

/** A node's internal state; scripts only ever hold its handle, a proxy that checks what its type has. */
class Node {
  handle: Record<string, unknown>;
  parent: Node | null = null;
  kids: Node[] = [];
  removed = false;
  data = new Map<string, string>();
  // Geometry, in the parent's coordinates; auto layout overwrites what it controls.
  x = 0;
  y = 0;
  w = 100;
  h = 100;
  visible = true;
  opacity = 1;
  blendMode: string;
  effects: Effect[] = [];
  fills: Paint[] = [];
  strokes: Paint[] = [];
  weights: [number, number, number, number] = [1, 1, 1, 1];
  strokeAlign: string;
  dashPattern: number[] = [];
  strokeCap = "NONE";
  strokeJoin = "MITER";
  radii: [number, number, number, number] = [0, 0, 0, 0];
  /** Figma's rotation: counterclockwise degrees about the top left corner, x and y. */
  rot = 0;
  clipsContent = true;
  layoutMode = "NONE";
  primarySizing = "AUTO";
  counterSizing = "FIXED";
  primaryAlign = "MIN";
  counterAlign = "MIN";
  pad: [number, number, number, number] = [0, 0, 0, 0]; // top right bottom left
  itemSpacing = 0;
  strokesIncluded = false;
  layoutPositioning = "AUTO";
  layoutAlign = "INHERIT";
  layoutGrow = 0;
  constraints = { horizontal: "MIN", vertical: "MIN" };
  boundVariables: Record<string, Alias> = {};
  description = "";
  // Text.
  characters = "";
  fontName = { family: "Inter", style: "Regular" };
  fontSize = 12;
  lineHeight: { unit: string; value?: number } = { unit: "AUTO" };
  letterSpacing = { unit: "PERCENT", value: 0 };
  textCase = "ORIGINAL";
  textDecoration = "NONE";
  textAlignHorizontal = "LEFT";
  textAlignVertical = "TOP";
  textAutoResize = "WIDTH_AND_HEIGHT";
  textTruncation = "DISABLED";
  maxLines: number | null = null;
  named = false;

  constructor(readonly doc: Doc, readonly type: Kind, public name: string, readonly id = doc.id()) {
    // Figma's defaults for a new node: a frame or component filled white, text
    // black, strokes inside a frame and centered on a shape. The spike's
    // `defaults` item reads them live.
    this.blendMode = FRAMES.has(type) || type === "GROUP" ? "PASS_THROUGH" : "NORMAL";
    this.strokeAlign = FRAMES.has(type) || type === "RECTANGLE" ? "INSIDE" : "CENTER";
    if (type === "FRAME" || type === "COMPONENT") this.fills = [solid({ r: 1, g: 1, b: 1 })];
    if (type === "TEXT") this.fills = [solid({ r: 0, g: 0, b: 0 })];
    doc.byId.set(this.id, this);
    this.handle = new Proxy(this as unknown as Record<string, unknown>, HANDLER) as Record<string, unknown>;
    HANDLES.set(this.handle, this);
  }

  get page(): Node | null {
    let n: Node | null = this;
    while (n && n.type !== "PAGE") n = n.parent;
    return n;
  }

  isAutoLayout(): boolean {
    return FRAMES.has(this.type) && this.layoutMode !== "NONE";
  }

  inFlow(): boolean {
    return Boolean(this.parent?.isAutoLayout()) && this.layoutPositioning !== "ABSOLUTE" && this.visible;
  }

  descendants(): Node[] {
    return this.kids.flatMap((k) => [k, ...k.descendants()]);
  }
}

/** A frame's children as its layout and constraints see them: a group's children in the group's place. */
const layered = (n: Node): Node[] => n.kids.flatMap((k) => (k.type === "GROUP" ? layered(k) : [k]));

/** The node whose coordinates `n`'s x and y are in: its parent, past any group. */
function containerOf(n: Node): Node | null {
  let at = n.parent;
  while (at && at.type === "GROUP") at = at.parent;
  return at;
}

/** Removes a group its last child left, as Figma does: a group never stands empty. */
function dropIfEmptyGroup(n: Node | null): void {
  if (!n || n.type !== "GROUP" || n.kids.length) return;
  const parent = n.parent;
  if (parent) parent.kids.splice(parent.kids.indexOf(n), 1);
  n.removed = true;
  n.parent = null;
  dropIfEmptyGroup(parent);
}

const solid = (color: Rgb, opacity = 1): SolidPaint => ({ type: "SOLID", color, opacity, visible: true, blendMode: "NORMAL" });

const HANDLES = new WeakMap<object, Node>();

function unwrap(value: unknown, what = "node"): Node {
  const node = value && typeof value === "object" ? HANDLES.get(value) : undefined;
  if (!node) throw new Error(`Expected a ${what}, received ${typeof value === "object" ? "an object that is not one" : JSON.stringify(value)}`);
  if (node.removed) throw new Error(`The node with id "${node.id}" does not exist`);
  return node;
}

// --- Text layout ------------------------------------------------------------

function fontOf(n: Node): MockFont {
  const ls = n.letterSpacing.unit === "PIXELS" ? n.letterSpacing.value : (n.letterSpacing.value / 100) * n.fontSize;
  return { family: n.fontName.family, style: n.fontName.style, size: n.fontSize, letterSpacing: ls };
}

function lineHeightOf(n: Node): number {
  if (n.lineHeight.unit === "PIXELS") return n.lineHeight.value ?? 0;
  if (n.lineHeight.unit === "PERCENT") return ((n.lineHeight.value ?? 0) / 100) * n.fontSize;
  // AUTO: the font's own, ascent and descent (figma-fonts.json; 1.21em, as
  // Inter's, for another family), to a whole pixel, as the spike's labels
  // came out (12px 15 tall, 14px 17) and the text probe's Roboto Mono (14px
  // 18) and Noto Serif (16px 22).
  return Math.round(n.fontSize * (metrics().lineHeight[n.fontName.family] ?? 1.21));
}

/**
 * Width of the widest explicit line, unwrapped. Measured by the characters as
 * written, before textCase: a width learned from snap is of the text as the
 * browser drew it, its case included.
 */
function textWidth(n: Node): number {
  const { measure } = n.doc.options;
  const font = fontOf(n);
  return Math.max(0, ...n.characters.split("\n").map((line) => measure.advance(line, font)));
}

/**
 * How much wider than its box a line can be and stay whole: float noise
 * only. On a fresh text Figma keeps "sales-dashboard.pdf" (Inter Medium 14,
 * 139.39843 wide) on one line at 139.4 and wraps it at 139.39 (the fourth
 * push's text probe, fixtures/figma-text-probe-3.json, `attachment`).
 */
const FITS = 1e-4;

/**
 * Lines the text takes wrapped at `width`, greedy by words, each breaking
 * after a space or a hyphen: each word as wide as the measure says where it
 * measures words, else its characters' share of the line's advance. A line
 * fits a width it is no wider than; a word wider than a line on its own is
 * broken between characters, as Figma broke "Home" into "Hom" and "e" in
 * the third live push.
 */
function textLines(n: Node, width: number): number {
  const { measure } = n.doc.options;
  const font = fontOf(n);
  let lines = 0;
  for (const line of n.characters.split("\n")) {
    const known = measure.lines?.(line, font, width);
    if (known !== undefined) {
      lines += known;
      continue;
    }
    const advance = measure.advance(line, font);
    if (advance <= width + FITS || !line.length) {
      lines += 1;
      continue;
    }
    const perChar = advance / line.length;
    const wide = (text: string) => (measure.words ? measure.advance(text, font) : text.length * perChar);
    let used = 0;
    let count = 1;
    for (const word of line.split(/(?<=[\s-])/)) {
      const fit = wide(word.trimEnd());
      if (used > 0 && used + fit > width + FITS) {
        count++;
        used = 0;
      }
      if (used === 0 && fit > width + FITS) {
        for (const ch of word) {
          const w = wide(ch);
          if (used > 0 && used + w > width + FITS && ch.trim()) {
            count++;
            used = 0;
          }
          used += w;
        }
        continue;
      }
      used += wide(word);
    }
    lines += count;
  }
  return Math.max(1, lines);
}

/** Up to a whole pixel, as Figma sizes a text to its content, past float noise. */
const ceilPx = (n: number) => Math.ceil(r2(n) - 1e-6);

/**
 * A text's size as Figma gives it, as the live text probe saw (2026-10-09):
 * a hugging text as wide as its widest line, up to a whole pixel (Inter
 * Regular 14 "Home", 39.04 wide, came out 40); a text that grows in height
 * as tall as its lines, up to a whole pixel (one line of 17.5 came out 18),
 * except where ENDING cuts it at maxLines, exactly that many lines (17.5).
 */
function sizeText(n: Node): void {
  const lh = lineHeightOf(n);
  const limit = n.textTruncation === "ENDING" && n.maxLines ? n.maxLines : Infinity;
  const tall = (lines: number) => (lines > limit ? r2(lh * limit) : ceilPx(lh * lines));
  if (n.textAutoResize === "WIDTH_AND_HEIGHT") {
    n.w = Math.max(ceilPx(textWidth(n)), 0.01);
    n.h = tall(n.characters.split("\n").length);
  } else if (n.textAutoResize === "HEIGHT") {
    n.h = tall(textLines(n, n.w));
  }
}

// --- Auto layout ------------------------------------------------------------

type Axis = "x" | "y";
const SIZE = { x: "w", y: "h" } as const;

/**
 * The inset of a frame's own stroke into its content, per side, when strokes
 * are included in layout: an INSIDE stroke's whole width, and nothing for a
 * CENTER or OUTSIDE one, as the spike saw (item 4: a 2px INSIDE stroke grew a
 * hugging row from 44x20 to 48x24 and moved its children by 2; CENTER and
 * OUTSIDE left both alone).
 */
function strokeInset(n: Node): [number, number, number, number] {
  if (!n.strokesIncluded || !n.strokes.length || n.strokeAlign !== "INSIDE") return [0, 0, 0, 0];
  return [...n.weights];
}

/** A layout the mock does not model: thrown, never laid out by a guess. */
function unmodeled(node: Node, what: string, why: string): never {
  throw new Error(`mock-figma: ${what} is not modeled ("${node.name}", ${node.id}); ${why}`);
}

/** Whether a text node sizes itself on `axis`, so that it ignores FILL there. */
function sizesItself(k: Node, axis: Axis): boolean {
  return k.type === "TEXT" && (k.textAutoResize === "WIDTH_AND_HEIGHT" || (axis === "y" && k.textAutoResize === "HEIGHT"));
}

/**
 * Lays out `node` and everything under it: text sizes itself, a group covers
 * its children, an auto-layout frame sizes the axes it hugs to its in-flow
 * children and then places them, filling those that fill. Figma's model, as
 * its documentation and the figma-use skill describe it and the spike saw
 * it (item 11): children in order, `itemSpacing` apart from the padding
 * (SPACE_BETWEEN spreads the free space instead), each aligned across by the
 * frame's counterAxisAlignItems unless it stretches; hidden and ABSOLUTE
 * children take no part, and keep their own x and y. Throws on a layout the
 * mock does not model (unmodeled).
 */
function layoutTree(node: Node): void {
  for (const kid of node.kids) layoutTree(kid);
  if (node.type === "TEXT") sizeText(node);
  if (node.type === "GROUP" && node.kids.length) {
    // In the frame's coordinates, as its children are.
    const [x0, y0] = [Math.min(...node.kids.map((k) => k.x)), Math.min(...node.kids.map((k) => k.y))];
    [node.x, node.y] = [r2(x0), r2(y0)];
    node.w = r2(Math.max(...node.kids.map((k) => k.x + k.w)) - x0);
    node.h = r2(Math.max(...node.kids.map((k) => k.y + k.h)) - y0);
  }
  if (!node.isAutoLayout()) return;
  const main: Axis = node.layoutMode === "HORIZONTAL" ? "x" : "y";
  const cross: Axis = main === "x" ? "y" : "x";
  const inset = strokeInset(node);
  const [pt, pr, pb, pl] = node.pad.map((p, i) => p + inset[i]);
  const lead = { x: pl, y: pt };
  const trail = { x: pr, y: pb };
  const flow = node.kids.filter((k) => k.inFlow());
  // A turned layer takes the room its turned box does, and is placed so
  // that box starts where its slot does (the sixth probe's call 1, c and
  // d; the seventh's, at 180 degrees and 90).
  const size = (k: Node, axis: Axis) => (k.rot ? turnedSpan(k)[SIZE[axis]] : k[SIZE[axis]]);
  const lag = (k: Node, axis: Axis) => (k.rot ? -turnedSpan(k)[axis] : 0);
  const set = (k: Node, axis: Axis, value: number) => {
    k[SIZE[axis]] = r2(Math.max(0.01, value));
    if (k.type === "TEXT" && axis === "x" && k.textAutoResize === "HEIGHT") sizeText(k);
  };
  const grows = (k: Node) => k.layoutGrow > 0;
  const stretches = (k: Node) => k.layoutAlign === "STRETCH";
  for (const k of flow) {
    if (k.type === "GROUP") unmodeled(k, "a group in an auto layout's flow", "nothing the templates build puts one there");
    if (k.rot && Math.abs(k.rot) !== 180 && (grows(k) || stretches(k))) {
      unmodeled(k, "FILL on a layer turned other than 180 degrees", "the seventh probe filled one turned 180, its turned box its own, and tried no other");
    }
    if (stretches(k) && node.counterSizing === "AUTO" && node.doc.options.fillAcrossHug === "refuse") {
      unmodeled(k, "FILL across a parent that hugs that axis", "this MockFigma was made with fillAcrossHug 'refuse', for a build that must not rely on it");
    }
    if ((grows(k) && sizesItself(k, main)) || (stretches(k) && sizesItself(k, cross))) {
      unmodeled(k, "FILL on a text node that sizes itself on that axis",
        "the spike saw layoutSizingHorizontal = 'FILL' turn a hugging text to HEIGHT, and tried nothing else; the figma-use skill documents Figma ignoring FILL on WIDTH_AND_HEIGHT text: set textAutoResize to HEIGHT (or NONE, for its height) first");
    }
  }
  // Hug first, from what doesn't fill: a stretching child takes the size the
  // others give (fillAcrossHug "stretch"), and a growing one keeps its own,
  // as the spike saw (sizing: fillAcross, fillAlong, growAlong). Each fills
  // only in a fixed frame.
  const spacing = node.primaryAlign === "SPACE_BETWEEN" ? 0 : node.itemSpacing;
  if (node.primarySizing === "AUTO") {
    const sum = flow.reduce((t, k) => t + size(k, main), 0) + spacing * Math.max(0, flow.length - 1);
    node[SIZE[main]] = r2(Math.max(0.01, lead[main] + sum + trail[main]));
  }
  if (node.counterSizing === "AUTO") {
    const basis = flow.filter((k) => !stretches(k));
    const most = (basis.length ? basis : flow).reduce((m, k) => Math.max(m, size(k, cross)), 0);
    node[SIZE[cross]] = r2(Math.max(0.01, lead[cross] + most + trail[cross]));
  }
  const room = size(node, main) - lead[main] - trail[main];
  const across = size(node, cross) - lead[cross] - trail[cross];
  const growing = node.primarySizing === "AUTO" ? [] : flow.filter(grows);
  if (growing.length) {
    const fixed = flow.filter((k) => !grows(k)).reduce((t, k) => t + size(k, main), 0) + spacing * (flow.length - 1);
    for (const k of growing) set(k, main, (room - fixed) / growing.length);
  }
  for (const k of flow) if (stretches(k)) set(k, cross, across);
  const total = flow.reduce((t, k) => t + size(k, main), 0);
  let at = lead[main];
  let gap = spacing;
  if (node.primaryAlign === "CENTER") at += (room - total - spacing * (flow.length - 1)) / 2;
  else if (node.primaryAlign === "MAX") at += room - total - spacing * (flow.length - 1);
  else if (node.primaryAlign === "SPACE_BETWEEN" && flow.length > 1) gap = (room - total) / (flow.length - 1);
  for (const k of flow) {
    k[main] = r2(at + lag(k, main));
    at += size(k, main) + gap;
    const free = across - size(k, cross);
    const align = stretches(k) ? "MIN" : node.counterAlign;
    k[cross] = r2(lead[cross] + (align === "CENTER" ? free / 2 : align === "MAX" ? free : 0) + lag(k, cross));
  }
}

/** Where a turned node's corners reach from its top left corner, least x and y, and the width and height they span. */
function turnedSpan(n: Node): { x: number; y: number; w: number; h: number } {
  const [[a, b], [c, d]] = turnMatrix(n.rot, 0, 0);
  const xs = [0, a * n.w, b * n.h, a * n.w + b * n.h];
  const ys = [0, c * n.w, d * n.h, c * n.w + d * n.h];
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// --- Handles: what scripts see ----------------------------------------------

type Prop = {
  types?: Set<Kind>;
  get?: (n: Node) => unknown;
  set?: (n: Node, value: unknown) => void;
  /** Reading it lays the document out first. */
  geometry?: boolean;
};
type Method = { types?: Set<Kind>; fn: (n: Node, ...args: unknown[]) => unknown };

function requireFont(n: Node, prop: string, font = n.fontName): void {
  const call = n.doc.call;
  if (call && !call.fonts.has(`${font.family}\u0000${font.style}`)) {
    throw new Error(`in set_${prop}: Cannot write to node with unloaded font "${font.family} ${font.style}". ` +
      `Please call figma.loadFontAsync({ family: "${font.family}", style: "${font.style}" }) and await the returned promise first.`);
  }
}

const textProp = (key: keyof Node, check: (value: unknown, n: Node) => unknown, after?: (n: Node) => void): Prop => ({
  types: new Set(["TEXT"]),
  get: (n) => frozenCopy(n[key]),
  set: (n, value) => {
    requireFont(n, key);
    (n as unknown as Record<string, unknown>)[key] = check(value, n);
    after?.(n);
    n.doc.dirty = true;
  },
});

const changed = (n: Node) => {
  n.doc.dirty = true;
};

/** Sets the node's sizing on one axis as layoutSizingHorizontal/Vertical does. */
function setSizing(n: Node, axis: Axis, value: unknown): void {
  const prop = axis === "x" ? "layoutSizingHorizontal" : "layoutSizingVertical";
  const mode = oneOf(prop, value, ["FIXED", "HUG", "FILL"] as const);
  const parent = n.parent;
  const parentMain: Axis | null = parent?.isAutoLayout() ? (parent.layoutMode === "HORIZONTAL" ? "x" : "y") : null;
  const ownMain: Axis | null = n.isAutoLayout() ? (n.layoutMode === "HORIZONTAL" ? "x" : "y") : null;
  if (mode === "FILL") {
    if (!parentMain) invalid(prop, "FILL can only be set on children of auto-layout frames");
    if (n.layoutPositioning === "ABSOLUTE") invalid(prop, "FILL cannot be set on absolute positioned auto-layout children");
    if (axis === parentMain) n.layoutGrow = 1;
    else n.layoutAlign = "STRETCH";
    if (n.type === "TEXT" && axis === "x" && n.textAutoResize === "WIDTH_AND_HEIGHT") {
      // A hugging label wraps at the width it fills from the width it had,
      // as the spike saw (sizing: textInFixedRow, textInHuggingRow).
      sizeText(n);
      n.textAutoResize = "HEIGHT";
    }
    // Filling replaces hugging on that axis.
    if (ownMain) {
      if (axis === ownMain) n.primarySizing = "FIXED";
      else n.counterSizing = "FIXED";
    }
  } else {
    if (parentMain) {
      if (axis === parentMain) n.layoutGrow = 0;
      else if (n.layoutAlign === "STRETCH") n.layoutAlign = "INHERIT";
    }
    if (mode === "HUG") {
      if (n.type === "TEXT") {
        if (!parentMain) invalid(prop, "HUG can only be set on auto-layout frames or text children of auto-layout frames");
        n.textAutoResize = axis === "x" ? "WIDTH_AND_HEIGHT" : n.textAutoResize === "NONE" ? "HEIGHT" : n.textAutoResize;
      } else if (ownMain) {
        if (axis === ownMain) n.primarySizing = "AUTO";
        else n.counterSizing = "AUTO";
      } else {
        invalid(prop, parentMain ? "HUG can only be set on auto-layout frames or text children of auto-layout frames"
          : "node must be an auto-layout frame or a child of an auto-layout frame");
      }
    } else if (n.type === "TEXT") {
      if (axis === "x" && n.textAutoResize === "WIDTH_AND_HEIGHT") n.textAutoResize = "HEIGHT";
      if (axis === "y") n.textAutoResize = "NONE";
    } else if (ownMain) {
      if (axis === ownMain) n.primarySizing = "FIXED";
      else n.counterSizing = "FIXED";
    }
  }
  changed(n);
}

function getSizing(n: Node, axis: Axis): string {
  const parent = n.parent;
  if (parent?.isAutoLayout() && n.layoutPositioning !== "ABSOLUTE") {
    const parentMain: Axis = parent.layoutMode === "HORIZONTAL" ? "x" : "y";
    if (axis === parentMain ? n.layoutGrow > 0 : n.layoutAlign === "STRETCH") return "FILL";
  }
  if (n.isAutoLayout()) {
    const ownMain: Axis = n.layoutMode === "HORIZONTAL" ? "x" : "y";
    return (axis === ownMain ? n.primarySizing : n.counterSizing) === "AUTO" ? "HUG" : "FIXED";
  }
  if (n.type === "TEXT") {
    if (n.textAutoResize === "WIDTH_AND_HEIGHT") return "HUG";
    if (axis === "y" && n.textAutoResize === "HEIGHT") return "HUG";
  }
  return "FIXED";
}

/** A resize: x and y kept, the axes it sets fixed, children moved by their constraints unless `plain`. */
function resizeNode(n: Node, w: unknown, h: unknown, plain: boolean): void {
  if (n.type === "GROUP") unmodeled(n, "resizing a group", "nothing the templates build resizes one");
  const width = finite("resize", w, 0.01);
  const height = finite("resize", h, n.type === "LINE" ? 0 : 0.01);
  // Constraints move children by the change in size, so it must be current.
  if (!plain && n.kids.length) n.doc.settle();
  const [dw, dh] = [width - n.w, height - n.h];
  const [sx, sy] = [width / n.w, height / n.h];
  if (!plain && !n.isAutoLayout()) {
    for (const kid of layered(n)) {
      const before = { x: kid.x, y: kid.y, w: kid.w, h: kid.h };
      const c = kid.constraints;
      let { x, y, w: kw, h: kh } = before;
      if (c.horizontal === "MAX") x += dw;
      else if (c.horizontal === "CENTER") x += dw / 2;
      else if (c.horizontal === "STRETCH") kw += dw;
      else if (c.horizontal === "SCALE") [x, kw] = [x * sx, kw * sx];
      if (c.vertical === "MAX") y += dh;
      else if (c.vertical === "CENTER") y += dh / 2;
      else if (c.vertical === "STRETCH") kh += dh;
      else if (c.vertical === "SCALE") [y, kh] = [y * sy, kh * sy];
      [kid.x, kid.y] = [r2(x), r2(y)];
      if (kw !== before.w || kh !== before.h) resizeNode(kid, Math.max(0.01, kw), Math.max(0.01, kh), false);
    }
  }
  [n.w, n.h] = [r2(width), r2(height)];
  if (n.isAutoLayout()) [n.primarySizing, n.counterSizing] = ["FIXED", "FIXED"];
  if (n.type === "TEXT" && n.textAutoResize === "WIDTH_AND_HEIGHT") n.textAutoResize = "NONE";
  if (n.parent?.isAutoLayout()) {
    // A child given a size no longer fills.
    n.layoutGrow = 0;
    if (n.layoutAlign === "STRETCH") n.layoutAlign = "INHERIT";
  }
  changed(n);
}

/** Rescales a node from its top-left corner, everything with a length scaled with it. */
function rescaleNode(n: Node, s: number, top = true): void {
  if (top && n.type === "GROUP") unmodeled(n, "rescaling a group", "nothing the templates build rescales one");
  n.doc.settle();
  if (!top) [n.x, n.y] = [r2(n.x * s), r2(n.y * s)];
  [n.w, n.h] = [r2(n.w * s), r2(n.h * s)];
  n.weights = n.weights.map((w) => w * s) as Node["weights"];
  n.radii = n.radii.map((r) => r * s) as Node["radii"];
  n.pad = n.pad.map((p) => p * s) as Node["pad"];
  n.itemSpacing *= s;
  n.effects = n.effects.map((e) => ({
    ...e, radius: e.radius * s,
    ...(e.offset ? { offset: { x: e.offset.x * s, y: e.offset.y * s } } : {}),
    ...(e.spread ? { spread: e.spread * s } : {}),
  }));
  if (n.type === "TEXT") {
    n.fontSize *= s;
    if (n.lineHeight.unit === "PIXELS") n.lineHeight = { unit: "PIXELS", value: (n.lineHeight.value ?? 0) * s };
    if (n.letterSpacing.unit === "PIXELS") n.letterSpacing = { unit: "PIXELS", value: n.letterSpacing.value * s };
  }
  for (const kid of n.kids) rescaleNode(kid, s, false);
  changed(n);
}

/** Figma's 2x3 transform for a turn of `deg`, counterclockwise, at x, y. */
function turnMatrix(deg: number, x: number, y: number): number[][] {
  const t = (deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  return [[cos, sin, x], [-sin || 0, cos, y]];
}

/**
 * A node's transform to its page, Figma's absoluteTransform: each frame's
 * own (relativeTransform) from the page down, so a frame's turn turns what
 * it holds. A group's children are in its frame's coordinates, as the
 * group itself is, so a group adds nothing.
 */
function absoluteMatrix(n: Node): number[][] {
  n.doc.settle();
  const chain: Node[] = [];
  for (let at: Node | null = n; at && at.type !== "PAGE" && at.type !== "DOCUMENT"; at = containerOf(at)) chain.unshift(at);
  let [a, b, x, c, d, y] = [1, 0, 0, 0, 1, 0];
  for (const at of chain) {
    const [[a2, b2, x2], [c2, d2, y2]] = turnMatrix(at.rot, at.x, at.y);
    [a, b, x, c, d, y] = [a * a2 + b * c2, a * b2 + b * d2, a * x2 + b * y2 + x, c * a2 + d * c2, c * b2 + d * d2, c * x2 + d * y2 + y];
  }
  return [[a, b, r2(x)], [c, d, r2(y)]];
}

/** The box a node's corners span on its page, Figma's absoluteBoundingBox. */
function absoluteBox(n: Node): { x: number; y: number; width: number; height: number } {
  const [[a, b, x], [c, d, y]] = absoluteMatrix(n);
  const xs = [0, a * n.w, b * n.h, a * n.w + b * n.h];
  const ys = [0, c * n.w, d * n.h, c * n.w + d * n.h];
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  return { x: x + x0, y: y + y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

function cloneNode(n: Node, parent: Node | null): Node {
  const copy = new Node(n.doc, n.type, n.name);
  const skip = new Set(["handle", "parent", "kids", "removed", "data", "doc", "type", "id", "name"]);
  for (const [key, value] of Object.entries(n)) {
    if (!skip.has(key)) (copy as unknown as Record<string, unknown>)[key] = structuredClone(value);
  }
  if (n.doc.options.clonePluginData) copy.data = new Map(n.data);
  if (n.doc.call) n.doc.call.created++;
  for (const kid of n.kids) {
    const k = cloneNode(kid, copy);
    copy.kids.push(k);
  }
  copy.parent = parent;
  return copy;
}

function attach(parent: Node, child: Node, index?: number): void {
  if (parent === child || child.descendants().includes(parent)) throw new Error("Cannot move a node into itself or one of its descendants");
  if (parent.type === "COMPONENT_SET" && child.type !== "COMPONENT") throw new Error(`A component set can only contain components, not a ${child.type}`);
  if (parent.type === "PAGE" && child.type === "PAGE") throw new Error("A page can't contain a page");
  const from = child.parent;
  if (from) from.kids.splice(from.kids.indexOf(child), 1);
  if (from !== parent) dropIfEmptyGroup(from);
  child.parent = parent;
  const at = index === undefined ? parent.kids.length : Math.max(0, Math.min(index, parent.kids.length));
  parent.kids.splice(at, 0, child);
  changed(parent);
}

function loadedChildren(n: Node): Node[] {
  const call = n.doc.call;
  if (n.type === "PAGE" && call && !call.loaded.has(n.id)) {
    throw new Error("Cannot access children on a page that has not been explicitly loaded. "
      + "Remember to call await page.loadAsync() or await figma.setCurrentPageAsync(page) first.");
  }
  return n.kids.filter((k) => !k.removed);
}

function searchable(n: Node): Node[] {
  if (n.type === "DOCUMENT") return n.doc.pages.filter((p) => n.doc.call?.loaded.has(p.id)).flatMap((p) => p.descendants());
  loadedChildren(n);
  return n.descendants();
}

function matches(n: Node, criteria: Record<string, unknown>): boolean {
  const types = criteria.types as string[] | undefined;
  if (types && !types.includes(n.type)) return false;
  if (criteria.pluginData) throw new Error("findAllWithCriteria: pluginData is not supported in use_figma; use sharedPluginData");
  const shared = criteria.sharedPluginData as { namespace: string; keys?: string[] } | undefined;
  if (shared) {
    const keys = [...n.data.keys()].filter((k) => k.startsWith(`${shared.namespace}\u0000`)).map((k) => k.slice(shared.namespace.length + 1));
    if (!keys.length) return false;
    if (shared.keys && shared.keys.length && !shared.keys.some((k) => keys.includes(k))) return false;
  }
  return true;
}

const handles = (nodes: Node[]) => nodes.map((n) => n.handle);

function paintsSetter(key: "fills" | "strokes") {
  return (n: Node, value: unknown) => {
    if (!Array.isArray(value)) invalid(key, `Expected array, received ${JSON.stringify(value)}`);
    const before = n[key];
    n[key] = value.map((p, i) => {
      const next = paint(key, p);
      const id = (next as SolidPaint).boundVariables?.color?.id;
      if (next.type !== "SOLID" || !id) return next;
      // Figma resolves a bound paint's color from its variable, and a paint
      // bound afresh takes the variable's alpha as its opacity, as a live
      // push found it set to 1; one bound as before keeps its opacity.
      const variable = n.doc.variables.get(id);
      if (!variable || variable.resolvedType !== "COLOR") invalid(key, `No COLOR variable with id ${id}`);
      const { r, g, b, a } = variable.value as Rgba;
      const was = (before[i] as SolidPaint | undefined)?.boundVariables?.color?.id;
      return { ...next, color: { r, g, b }, opacity: was === id ? next.opacity : a };
    });
    changed(n);
  };
}

const weightProp = (side: number): Prop => ({
  types: SIDED,
  get: (n) => n.weights[side],
  set: (n, v) => {
    n.weights[side] = finite("strokeWeight", v, 0);
    changed(n);
  },
});

const radiusProp = (corner: number): Prop => ({
  types: CORNERS,
  get: (n) => n.radii[corner],
  set: (n, v) => {
    n.radii[corner] = finite("cornerRadius", v, 0);
    changed(n);
  },
});

/** A property that takes one of `values`, kept in `key`; a change relays out. */
const enumProp = (types: Set<Kind>, prop: string, key: keyof Node, values: readonly string[]): Prop => ({
  types,
  get: (n) => n[key],
  set: (n, v) => {
    (n as unknown as Record<string, unknown>)[key] = oneOf(prop, v, values);
    changed(n);
  },
});

/** Moves a node on one axis; a group moves its children, whose coordinates are its frame's. */
function place(n: Node, axis: Axis, value: number): void {
  if (n.type === "GROUP") for (const k of layered(n)) k[axis] = r2(k[axis] + value - n[axis]);
  n[axis] = value;
}

const PROPS: Record<string, Prop> = {
  id: { get: (n) => n.id },
  type: { get: (n) => n.type },
  removed: { get: (n) => n.removed },
  parent: { get: (n) => n.parent?.handle ?? null },
  name: {
    get: (n) => n.name,
    set: (n, v) => {
      n.name = String(v);
      n.named = true;
    },
  },
  children: { types: CONTAINERS, get: (n) => Object.freeze(handles(loadedChildren(n))) },
  isPageDivider: { types: new Set(["PAGE"]), get: () => false },
  x: { types: SCENE, geometry: true, get: (n) => n.x, set: (n, v) => { if (!n.inFlow()) place(n, "x", finite("x", v)); changed(n); } },
  y: { types: SCENE, geometry: true, get: (n) => n.y, set: (n, v) => { if (!n.inFlow()) place(n, "y", finite("y", v)); changed(n); } },
  width: { types: SCENE, geometry: true, get: (n) => n.w },
  height: { types: SCENE, geometry: true, get: (n) => n.h },
  // A turn as the sixth probe saw Figma's (fixtures/figma-tsum-probe.json,
  // call 1): about the top left corner, which x and y keep, setting it or a
  // size; the transform's first two columns are cos, sin and -sin, cos of
  // the angle, counterclockwise. A frame's turn turns what it holds on the
  // page, as an imported icon's shapes in its turned frame.
  absoluteBoundingBox: { types: SCENE, geometry: true, get: (n) => absoluteBox(n) },
  absoluteTransform: { types: SCENE, geometry: true, get: (n) => absoluteMatrix(n) },
  relativeTransform: { types: SCENE, geometry: true, get: (n) => turnMatrix(n.rot, n.x, n.y) },
  rotation: {
    types: SCENE,
    get: (n) => n.rot,
    set: (n, v) => {
      // Figma keeps 180 and -180 as given (the seventh probe).
      const deg = finite("rotation", v);
      n.rot = Math.abs(deg) <= 180 ? deg || 0 : ((((deg + 180) % 360) + 360) % 360) - 180 || 0;
      changed(n);
    },
  },
  visible: { types: SCENE, get: (n) => n.visible, set: (n, v) => { n.visible = Boolean(v); changed(n); } },
  locked: { types: SCENE, get: () => false, set: () => undefined },
  opacity: { types: SCENE, get: (n) => n.opacity, set: (n, v) => { n.opacity = finite("opacity", v, 0, 1); } },
  blendMode: { types: SCENE, get: (n) => n.blendMode, set: (n, v) => { n.blendMode = oneOf("blendMode", v, BLEND_MODES); } },
  isMask: { types: SCENE, get: () => false },
  effects: {
    types: new Set<Kind>([...GEOMETRY, "GROUP"]),
    get: (n) => frozenCopy(n.effects),
    set: (n, v) => {
      if (!Array.isArray(v)) invalid("effects", "Expected array");
      const effects = v.map(effect);
      if (n.doc.options.shadowSpread === "refuse" && !(FRAMES.has(n.type) && n.clipsContent) && effects.some((e) => e.spread)) {
        invalid("effects", "spread is only supported on frames that clip their content (mock-figma shadowSpread 'refuse')");
      }
      n.effects = effects;
    },
  },
  fills: { types: GEOMETRY, get: (n) => frozenCopy(n.fills), set: paintsSetter("fills") },
  strokes: { types: GEOMETRY, get: (n) => frozenCopy(n.strokes), set: paintsSetter("strokes") },
  strokeWeight: {
    types: GEOMETRY,
    get: (n) => (n.weights.every((w) => w === n.weights[0]) ? n.weights[0] : MIXED),
    set: (n, v) => {
      const w = finite("strokeWeight", v, 0);
      n.weights = [w, w, w, w];
      changed(n);
    },
  },
  strokeTopWeight: weightProp(0),
  strokeRightWeight: weightProp(1),
  strokeBottomWeight: weightProp(2),
  strokeLeftWeight: weightProp(3),
  strokeAlign: { types: GEOMETRY, get: (n) => n.strokeAlign, set: (n, v) => { n.strokeAlign = oneOf("strokeAlign", v, ["INSIDE", "OUTSIDE", "CENTER"]); changed(n); } },
  dashPattern: {
    types: GEOMETRY,
    get: (n) => Object.freeze([...n.dashPattern]),
    set: (n, v) => {
      if (!Array.isArray(v)) invalid("dashPattern", "Expected array");
      n.dashPattern = v.map((d) => finite("dashPattern", d, 0));
    },
  },
  strokeCap: { types: GEOMETRY, get: (n) => n.strokeCap, set: (n, v) => { n.strokeCap = String(v); } },
  strokeJoin: { types: GEOMETRY, get: (n) => n.strokeJoin, set: (n, v) => { n.strokeJoin = String(v); } },
  cornerRadius: {
    types: CORNERS,
    get: (n) => (n.radii.every((r) => r === n.radii[0]) ? n.radii[0] : MIXED),
    set: (n, v) => {
      const r = finite("cornerRadius", v, 0);
      n.radii = [r, r, r, r];
    },
  },
  topLeftRadius: radiusProp(0),
  topRightRadius: radiusProp(1),
  bottomRightRadius: radiusProp(2),
  bottomLeftRadius: radiusProp(3),
  cornerSmoothing: { types: CORNERS, get: () => 0, set: () => undefined },
  clipsContent: { types: FRAMES, get: (n) => n.clipsContent, set: (n, v) => { n.clipsContent = Boolean(v); } },
  layoutMode: {
    types: FRAMES,
    get: (n) => n.layoutMode,
    set: (n, v) => {
      const mode = oneOf("layoutMode", v, ["NONE", "HORIZONTAL", "VERTICAL"]);
      n.layoutMode = mode;
      changed(n);
    },
  },
  layoutWrap: {
    types: FRAMES,
    get: () => "NO_WRAP",
    set: (_n, v) => {
      if (oneOf("layoutWrap", v, ["NO_WRAP", "WRAP"]) === "WRAP") throw new Error("mock-figma: layoutWrap WRAP is not modeled; the build lays a wrapping flex out absolute");
    },
  },
  primaryAxisSizingMode: enumProp(FRAMES, "primaryAxisSizingMode", "primarySizing", ["FIXED", "AUTO"]),
  counterAxisSizingMode: enumProp(FRAMES, "counterAxisSizingMode", "counterSizing", ["FIXED", "AUTO"]),
  primaryAxisAlignItems: enumProp(FRAMES, "primaryAxisAlignItems", "primaryAlign", ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]),
  counterAxisAlignItems: enumProp(FRAMES, "counterAxisAlignItems", "counterAlign", ["MIN", "MAX", "CENTER", "BASELINE"]),
  paddingTop: { types: FRAMES, get: (n) => n.pad[0], set: (n, v) => { n.pad[0] = finite("paddingTop", v, 0); changed(n); } },
  paddingRight: { types: FRAMES, get: (n) => n.pad[1], set: (n, v) => { n.pad[1] = finite("paddingRight", v, 0); changed(n); } },
  paddingBottom: { types: FRAMES, get: (n) => n.pad[2], set: (n, v) => { n.pad[2] = finite("paddingBottom", v, 0); changed(n); } },
  paddingLeft: { types: FRAMES, get: (n) => n.pad[3], set: (n, v) => { n.pad[3] = finite("paddingLeft", v, 0); changed(n); } },
  itemSpacing: { types: FRAMES, get: (n) => n.itemSpacing, set: (n, v) => { n.itemSpacing = finite("itemSpacing", v); changed(n); } },
  strokesIncludedInLayout: { types: FRAMES, get: (n) => n.strokesIncluded, set: (n, v) => { n.strokesIncluded = Boolean(v); changed(n); } },
  itemReverseZIndex: { types: FRAMES, get: () => false, set: () => undefined },
  layoutPositioning: enumProp(SCENE, "layoutPositioning", "layoutPositioning", ["AUTO", "ABSOLUTE"]),
  layoutAlign: enumProp(SCENE, "layoutAlign", "layoutAlign", ["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"]),
  layoutGrow: { types: SCENE, get: (n) => n.layoutGrow, set: (n, v) => { n.layoutGrow = finite("layoutGrow", v, 0, 1); changed(n); } },
  layoutSizingHorizontal: { types: SCENE, get: (n) => getSizing(n, "x"), set: (n, v) => setSizing(n, "x", v) },
  layoutSizingVertical: { types: SCENE, get: (n) => getSizing(n, "y"), set: (n, v) => setSizing(n, "y", v) },
  constraints: {
    types: SCENE,
    get: (n) => frozenCopy(n.constraints),
    set: (n, v) => {
      const c = shape("constraints", v, ["horizontal", "vertical"], ["horizontal", "vertical"]);
      const values = ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"];
      n.constraints = { horizontal: oneOf("constraints", c.horizontal, values), vertical: oneOf("constraints", c.vertical, values) };
    },
  },
  boundVariables: { types: SCENE, get: (n) => frozenCopy(n.boundVariables) },
  description: {
    types: new Set(["COMPONENT", "COMPONENT_SET"]),
    get: (n) => n.description,
    set: (n, v) => { n.description = String(v); },
  },
  componentPropertyDefinitions: {
    types: new Set(["COMPONENT", "COMPONENT_SET"]),
    get: (n) => {
      if (n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET") {
        throw new Error("in get_componentPropertyDefinitions: Can only get component property definitions of a component set or non-variant component");
      }
      if (n.type === "COMPONENT") return {};
      const defs: Record<string, { type: string; defaultValue: string; variantOptions: string[] }> = {};
      for (const kid of n.kids) {
        for (const pair of kid.name.split(",").map((s) => s.trim()).filter(Boolean)) {
          const [key, value] = pair.split("=").map((s) => s.trim());
          if (value === undefined) throw new Error("in get_componentPropertyDefinitions: Component set has existing errors");
          defs[key] ??= { type: "VARIANT", defaultValue: value, variantOptions: [] };
          if (!defs[key].variantOptions.includes(value)) defs[key].variantOptions.push(value);
        }
      }
      return defs;
    },
  },
  variantProperties: {
    types: new Set(["COMPONENT"]),
    get: (n) => (n.parent?.type === "COMPONENT_SET"
      ? Object.fromEntries(n.name.split(",").map((s) => s.split("=").map((t) => t.trim())))
      : null),
  },
  // Text.
  characters: textProp("characters", (v) => {
    if (typeof v !== "string") invalid("characters", `Expected string, received ${JSON.stringify(v)}`);
    return v;
  }, (n) => {
    if (!n.named) n.name = n.characters;
  }),
  fontName: {
    types: new Set(["TEXT"]),
    get: (n) => frozenCopy(n.fontName),
    set: (n, v) => {
      const f = shape("fontName", v, ["family", "style"], ["family", "style"]) as { family: string; style: string };
      requireFont(n, "fontName", f);
      n.fontName = { family: String(f.family), style: String(f.style) };
      changed(n);
    },
  },
  fontSize: textProp("fontSize", (v) => finite("fontSize", v, 1)),
  fontWeight: { types: new Set(["TEXT"]), get: (n) => weightOfStyle(n.fontName.style) },
  lineHeight: textProp("lineHeight", (v) => {
    const lh = shape("lineHeight", v, ["unit", "value"], ["unit"]);
    const unit = oneOf("lineHeight", lh.unit, ["PIXELS", "PERCENT", "AUTO"]);
    return unit === "AUTO" ? { unit } : { unit, value: finite("lineHeight", lh.value, 0) };
  }),
  letterSpacing: textProp("letterSpacing", (v) => {
    const ls = shape("letterSpacing", v, ["unit", "value"], ["unit", "value"]);
    return { unit: oneOf("letterSpacing", ls.unit, ["PIXELS", "PERCENT"]), value: finite("letterSpacing", ls.value) };
  }),
  textCase: textProp("textCase", (v) => oneOf("textCase", v, ["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"])),
  textDecoration: textProp("textDecoration", (v) => oneOf("textDecoration", v, ["NONE", "UNDERLINE", "STRIKETHROUGH"])),
  textAlignHorizontal: textProp("textAlignHorizontal", (v) => oneOf("textAlignHorizontal", v, ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"])),
  textAlignVertical: textProp("textAlignVertical", (v) => oneOf("textAlignVertical", v, ["TOP", "CENTER", "BOTTOM"])),
  // As the live text probe saw (2026-10-09): writing textAutoResize, even
  // the value it has, turns truncation off and clears maxLines, so a build
  // that sets truncation first loses it; a fixed-size text with ENDING reads
  // TRUNCATE, the deprecated name for the two.
  textAutoResize: {
    types: new Set(["TEXT"]),
    get: (n) => (n.textAutoResize === "NONE" && n.textTruncation === "ENDING" ? "TRUNCATE" : n.textAutoResize),
    set: (n, v) => {
      requireFont(n, "textAutoResize");
      const value = oneOf("textAutoResize", v, ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]);
      n.textAutoResize = value === "TRUNCATE" ? "NONE" : value;
      n.textTruncation = value === "TRUNCATE" ? "ENDING" : "DISABLED";
      n.maxLines = null;
      changed(n);
    },
  },
  // ENDING on a text that sizes itself, with no maxLines, limits it to one
  // line; DISABLED clears maxLines (the probe again).
  textTruncation: textProp("textTruncation", (v, n) => {
    const value = oneOf("textTruncation", v, ["DISABLED", "ENDING"]);
    if (value === "ENDING" && n.doc.options.textTruncation === "refuse") invalid("textTruncation", "not supported (mock-figma textTruncation 'refuse')");
    return value;
  }, (n) => {
    if (n.textTruncation === "DISABLED") n.maxLines = null;
    else if (n.maxLines === null && n.textAutoResize !== "NONE") n.maxLines = 1;
  }),
  // A fixed-size text in an auto layout reads no maxLines, and gets it back
  // when it sizes itself again (the probe: FIXED height, then HUG).
  maxLines: {
    types: new Set(["TEXT"]),
    get: (n) => (n.textAutoResize === "NONE" && n.parent?.isAutoLayout() ? null : n.maxLines),
    set: (n, v) => {
      requireFont(n, "maxLines");
      n.maxLines = v === null ? null : finite("maxLines", v, 1);
      changed(n);
    },
  },
  hasMissingFont: { types: new Set(["TEXT"]), get: () => false },
};

/** Throws, under moveNeedsFonts, when a node about to move holds a text whose font this call hasn't loaded. */
function requireFontsToMove(n: Node, method: string): void {
  if (!n.doc.options.moveNeedsFonts) return;
  for (const text of [n, ...n.descendants()].filter((d) => d.type === "TEXT")) requireFont(text, method);
}

const METHODS: Record<string, Method> = {
  remove: {
    types: new Set([...SCENE, "PAGE"]),
    fn: (n) => {
      if (n.type === "PAGE") {
        // As Figma: a document keeps a page, and the page a call is on stays.
        if (n.doc.pages.length === 1) throw new Error("in remove: Cannot remove the only page of a document");
        if (n.doc.call?.current === n) throw new Error("in remove: Cannot remove the current page");
        n.doc.pages.splice(n.doc.pages.indexOf(n), 1);
      }
      const parent = n.parent;
      if (parent) parent.kids.splice(parent.kids.indexOf(n), 1);
      changed(n);
      for (const gone of [n, ...n.descendants()]) {
        gone.removed = true;
        if (n.doc.call) n.doc.call.removed++;
      }
      n.parent = null;
      dropIfEmptyGroup(parent);
    },
  },
  getSharedPluginData: { fn: (n, ns, key) => n.data.get(`${ns}\u0000${key}`) ?? "" },
  getSharedPluginDataKeys: { fn: (n, ns) => [...n.data.keys()].filter((k) => k.startsWith(`${ns}\u0000`)).map((k) => k.slice(String(ns).length + 1)) },
  setSharedPluginData: {
    fn: (n, ns, key, value) => {
      if (typeof ns !== "string" || !/^[A-Za-z0-9_.-]{3,}$/.test(ns)) throw new Error("in setSharedPluginData: The namespace must be at least 3 alphanumeric characters");
      if (typeof key !== "string" || typeof value !== "string") throw new Error("in setSharedPluginData: key and value must be strings");
      if (value === "") n.data.delete(`${ns}\u0000${key}`);
      else n.data.set(`${ns}\u0000${key}`, value);
    },
  },
  getPluginData: { fn: () => { throw new Error("getPluginData is not supported in use_figma: use getSharedPluginData"); } },
  setPluginData: { fn: () => { throw new Error("setPluginData is not supported in use_figma: use setSharedPluginData"); } },
  appendChild: { types: CONTAINERS, fn: (n, child) => { requireFontsToMove(unwrap(child), "appendChild"); attach(n, unwrap(child)); } },
  insertChild: { types: CONTAINERS, fn: (n, index, child) => { requireFontsToMove(unwrap(child), "insertChild"); attach(n, unwrap(child), finite("insertChild", index, 0)); } },
  findAll: { types: CONTAINERS, fn: (n, test) => handles(searchable(n)).filter((h) => (test ? (test as (h: unknown) => boolean)(h) : true)) },
  findOne: { types: CONTAINERS, fn: (n, test) => handles(searchable(n)).find((h) => (test ? (test as (h: unknown) => boolean)(h) : true)) ?? null },
  findChildren: { types: CONTAINERS, fn: (n, test) => handles(loadedChildren(n)).filter((h) => (test ? (test as (h: unknown) => boolean)(h) : true)) },
  findChild: { types: CONTAINERS, fn: (n, test) => handles(loadedChildren(n)).find((h) => (test ? (test as (h: unknown) => boolean)(h) : true)) ?? null },
  findAllWithCriteria: { types: CONTAINERS, fn: (n, criteria) => handles(searchable(n).filter((k) => matches(k, (criteria ?? {}) as Record<string, unknown>))) },
  loadAsync: { types: new Set(["PAGE"]), fn: async (n) => { n.doc.call?.loaded.add(n.id); } },
  resize: { types: SCENE, fn: (n, w, h) => resizeNode(n, w, h, false) },
  resizeWithoutConstraints: { types: SCENE, fn: (n, w, h) => resizeNode(n, w, h, true) },
  rescale: { types: SCENE, fn: (n, s) => rescaleNode(n, finite("rescale", s, 0.01)) },
  clone: {
    types: SCENE,
    fn: (n) => {
      n.doc.settle();
      // Where the spike saw Figma put a copy (item 5): a node on a page gets
      // its copy beside it, just above; a node in anything else, a variant
      // in its set included, gets it on the current page, on top. So a
      // template puts a copy where it belongs itself.
      const copy = cloneNode(n, null);
      if (n.parent?.type === "PAGE") attach(n.parent, copy, n.parent.kids.indexOf(n) + 1);
      else attach(n.doc.call?.current ?? n.page ?? n.doc.pages[0], copy);
      return copy.handle;
    },
  },
  setBoundVariable: {
    types: SCENE,
    fn: (n, field, variable) => {
      const name = String(field);
      if (variable === null) {
        delete n.boundVariables[name];
        return;
      }
      const v = n.doc.variables.get(String((variable as { id?: string })?.id));
      if (!v) throw new Error(`in setBoundVariable: no variable ${JSON.stringify(variable)}`);
      if (v.resolvedType !== "FLOAT") throw new Error(`in setBoundVariable: ${name} takes a FLOAT variable, not ${v.resolvedType}`);
      const handle = n.handle as Record<string, unknown>;
      handle[name] = v.value;
      n.boundVariables[name] = { type: "VARIABLE_ALIAS", id: v.id };
    },
  },
  set: {
    types: SCENE,
    fn: (n, props) => {
      const record = { ...(props as Record<string, unknown>) };
      const handle = n.handle as Record<string, unknown>;
      if ("layoutMode" in record) handle.layoutMode = record.layoutMode;
      const { width, height } = record;
      for (const [key, value] of Object.entries(record)) {
        if (key !== "layoutMode" && key !== "width" && key !== "height") handle[key] = value;
      }
      if (width !== undefined || height !== undefined) resizeNode(n, width ?? n.w, height ?? n.h, false);
      return n.handle;
    },
  },
  getStyledTextSegments: {
    types: new Set(["TEXT"]),
    fn: (n) => [{ characters: n.characters, start: 0, end: n.characters.length, fontName: { ...n.fontName }, fontSize: n.fontSize }],
  },
  toString: { fn: (n: Node) => `[${n.type} ${n.id}]` },
};

const PASSIVE = new Set(["then", "toJSON", "constructor", "valueOf", "asymmetricMatch", "$$typeof", "nodeType", "inspect"]);

const HANDLER: ProxyHandler<Record<string, unknown>> = {
  get(target, prop) {
    const n = target as unknown as Node;
    if (typeof prop === "symbol" || PASSIVE.has(prop)) return undefined;
    const spec = PROPS[prop];
    const method = METHODS[prop];
    if (!spec && !method) return undefined;
    if (n.removed && prop !== "removed" && prop !== "id") throw new Error(`in get_${prop}: The node with id "${n.id}" does not exist`);
    const types = spec?.types ?? method?.types;
    if (types && !types.has(n.type)) throw new TypeError(`node.${prop}: no such property '${prop}' on ${n.type} node`);
    if (method) return (...args: unknown[]) => method.fn(n, ...args);
    if (spec.geometry) n.doc.settle();
    return spec.get!(n);
  },
  set(target, prop, value) {
    const n = target as unknown as Node;
    if (typeof prop === "symbol") return false;
    const spec = PROPS[prop];
    if (n.removed) throw new Error(`in set_${prop}: The node with id "${n.id}" does not exist`);
    if (!spec || (spec.types && !spec.types.has(n.type))) throw new TypeError(`node.${prop}: no such property '${prop}' on ${n.type} node`);
    if (!spec.set) throw new TypeError(`Cannot assign to read only property '${prop}' of node`);
    if (spec.geometry) n.doc.settle();
    spec.set(n, value);
    return true;
  },
  has(target, prop) {
    const n = target as unknown as Node;
    if (typeof prop === "symbol") return false;
    const types = PROPS[prop]?.types ?? METHODS[prop]?.types;
    return Boolean(PROPS[prop] || METHODS[prop]) && (!types || types.has(n.type));
  },
  ownKeys: () => [],
  getOwnPropertyDescriptor: () => undefined,
};

// --- The figma global -------------------------------------------------------

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function figmaGlobal(doc: Doc, call: Call): Record<string, unknown> {
  const create = (type: Kind, name: string) => {
    const node = new Node(doc, type, name);
    call.created++;
    attach(call.current, node);
    return node;
  };
  const variablesOf = (type?: string) => [...doc.variables.values()].filter((v) => !type || v.resolvedType === type);
  // A mode's id is `1:` and its place in its collection.
  const modeIndex = (collection: string, modeId: unknown, where: string) => {
    const i = doc.collections.get(collection)!.findIndex((_, at) => `1:${at}` === String(modeId));
    if (i < 0) throw new Error(`in ${where}: no mode ${JSON.stringify(modeId)} in collection ${collection}`);
    return i;
  };
  const variableHandle = (v: Variable) => ({
    id: v.id, name: v.name, resolvedType: v.resolvedType,
    get scopes() {
      return [...(v.scopes ?? ["ALL_SCOPES"])];
    },
    set scopes(value: unknown) {
      if (!Array.isArray(value)) throw new Error("in scopes: takes an array of scopes");
      for (const scope of value) {
        if (!VARIABLE_SCOPES[v.resolvedType].includes(String(scope))) throw new Error(`in scopes: ${String(scope)} is not a scope of a ${v.resolvedType} variable`);
      }
      if (value.includes("ALL_FILLS") && value.some((x) => /^(?:FRAME|SHAPE|TEXT)_FILL$/.test(String(x)))) throw new Error("in scopes: ALL_FILLS takes no other fill scope");
      v.scopes = value.map(String);
      doc.variableWrites.push(`scopes ${v.name}`);
    },
    variableCollectionId: `VariableCollectionId:${v.collection}`,
    valuesByMode: Object.fromEntries(v.modes.map(([, value], i) => [`1:${i}`, structuredClone(value)])),
    setValueForMode: (modeId: unknown, value: unknown) => {
      const i = modeIndex(v.collection, modeId, "setValueForMode");
      if (v.resolvedType === "COLOR" && !(value && typeof value === "object" && "r" in value)) throw new Error("in setValueForMode: a COLOR variable takes an RGB or RGBA value");
      if (v.resolvedType === "FLOAT" && typeof value !== "number") throw new Error("in setValueForMode: a FLOAT variable takes a number");
      const stored = v.resolvedType === "COLOR" ? { a: 1, ...(value as object) } : value;
      v.modes[i][1] = stored;
      if (i === 0) v.value = stored;
      doc.variableWrites.push(`value ${v.name} ${v.modes[i][0]}`);
    },
    // Figma detaches what is bound to it, keeping the value: nothing the mock binds is read after.
    remove: () => {
      if (!doc.variables.delete(v.id)) throw new Error("in remove: the variable was removed already");
      doc.variableWrites.push(`remove ${v.name}`);
    },
  });
  const collectionHandle = (name: string) => ({
    id: `VariableCollectionId:${name}`,
    name,
    get modes() {
      return doc.collections.get(name)!.map((mode, i) => ({ modeId: `1:${i}`, name: mode }));
    },
    defaultModeId: "1:0",
    get variableIds() {
      return variablesOf().filter((v) => v.collection === name).map((v) => v.id);
    },
    renameMode: (modeId: unknown, newName: unknown) => {
      const i = modeIndex(name, modeId, "renameMode");
      doc.variableWrites.push(`rename mode ${doc.collections.get(name)![i]} ${String(newName)}`);
      doc.collections.get(name)![i] = String(newName);
      for (const v of variablesOf()) if (v.collection === name) v.modes[i][0] = String(newName);
    },
    // A new mode takes each variable's default value, as Figma's does.
    addMode: (modeName: unknown) => {
      const modes = doc.collections.get(name)!;
      if (modes.length >= doc.options.maxModes) throw new Error(`in addMode: Limited to ${doc.options.maxModes} modes only`);
      modes.push(String(modeName));
      for (const v of variablesOf()) if (v.collection === name) v.modes.push([String(modeName), structuredClone(v.value)]);
      doc.variableWrites.push(`add mode ${String(modeName)}`);
      return `1:${modes.length - 1}`;
    },
  });
  const bindTo = (item: unknown, field: unknown, variable: unknown) => {
    const v = doc.variables.get(String((variable as { id?: string } | null)?.id));
    if (!v && variable !== null) throw new Error("in setBoundVariableForPaint: not a variable");
    const record = { ...(item as Record<string, unknown>) };
    const vars = { ...((record.boundVariables as Record<string, unknown>) ?? {}) };
    if (v) vars[String(field)] = { type: "VARIABLE_ALIAS", id: v.id };
    else delete vars[String(field)];
    record.boundVariables = vars;
    if (v && v.resolvedType === "COLOR") {
      const { r, g, b, a } = v.value as Rgba;
      record.color = "a" in ((item as { color?: object }).color ?? {}) ? { r, g, b, a } : { r, g, b };
    }
    return record;
  };
  const figma: Record<string, unknown> = {
    mixed: MIXED,
    root: doc.root.handle,
    get currentPage() {
      return call.current.handle;
    },
    set currentPage(_page: unknown) {
      throw new Error("Setting figma.currentPage is not supported");
    },
    setCurrentPageAsync: async (page: unknown) => {
      const node = unwrap(page, "page");
      if (node.type !== "PAGE") throw new Error("setCurrentPageAsync takes a page");
      call.switches.push(node.id);
      if (call.switches.length > 1) throw new Error(`switched page ${call.switches.length} times in one call; Figma's guidance is once`);
      call.loaded.add(node.id);
      call.current = node;
    },
    loadAllPagesAsync: async () => {
      throw new Error("figma.loadAllPagesAsync is not implemented");
    },
    notify: () => {
      throw new Error("not implemented");
    },
    getNodeById: () => {
      throw new Error("Cannot call with documentAccess: dynamic-page. Use figma.getNodeByIdAsync instead.");
    },
    getNodeByIdAsync: async (id: unknown) => {
      const node = doc.byId.get(String(id));
      return node && !node.removed ? node.handle : null;
    },
    createPage: () => {
      call.created++;
      return doc.addPage(`Page ${doc.pages.length + 1}`).handle;
    },
    createFrame: () => create("FRAME", "Frame").handle,
    createComponent: () => create("COMPONENT", "Component 1").handle,
    createText: () => create("TEXT", "").handle,
    createRectangle: () => create("RECTANGLE", "Rectangle").handle,
    createEllipse: () => create("ELLIPSE", "Ellipse").handle,
    createLine: () => {
      const line = create("LINE", "Line");
      line.h = 0;
      return line.handle;
    },
    createVector: () => create("VECTOR", "Vector").handle,
    createAutoLayout: (direction?: unknown, props?: unknown) => {
      const [dir, rest] = typeof direction === "string" ? [direction, props] : ["HORIZONTAL", direction];
      const frame = create("FRAME", "Frame");
      frame.fills = [];
      frame.layoutMode = oneOf("layoutMode", dir, ["HORIZONTAL", "VERTICAL"]);
      [frame.primarySizing, frame.counterSizing] = ["AUTO", "AUTO"];
      if (rest) (METHODS.set.fn)(frame, rest);
      return frame.handle;
    },
    createNodeFromSvg: (markup: unknown) => {
      const svg = parseSvg(String(markup));
      // As the spike saw the import (item 1): a frame that clips, with a
      // frame's fill, which the probe counted and didn't read, so it is a new
      // frame's white here; a `<rect>` as a VECTOR; a `<g>` as a GROUP.
      // Circles and ellipses it didn't import.
      const frame = create("FRAME", "svg");
      [frame.w, frame.h] = [svg.width, svg.height];
      const kinds: Record<string, Kind> = { circle: "ELLIPSE", ellipse: "ELLIPSE" };
      const groups: Node[] = [];
      const holder = (chain: number[]): Node => {
        let at = frame;
        for (const g of chain) {
          if (!groups[g]) {
            groups[g] = new Node(doc, "GROUP", "Group");
            call.created++;
            groups[g].opacity = svg.groups[g].opacity;
            attach(at, groups[g]);
          }
          at = groups[g];
        }
        return at;
      };
      for (const s of svg.shapes) {
        const node = new Node(doc, kinds[s.tag] ?? "VECTOR", "Vector");
        call.created++;
        [node.x, node.y, node.w, node.h] = [s.box[0], s.box[1], Math.max(s.box[2], 0.01), Math.max(s.box[3], 0.01)];
        node.fills = s.fill && s.fill.a > 0 ? [solid({ r: s.fill.r, g: s.fill.g, b: s.fill.b }, s.fill.a)] : [];
        node.strokes = s.stroke && s.stroke.a > 0 ? [solid({ r: s.stroke.r, g: s.stroke.g, b: s.stroke.b }, s.stroke.a)] : [];
        const weight = r2(doc.options.svgStrokeScales ? s.strokeWidth : s.strokeWidth / svg.scale);
        node.weights = [weight, weight, weight, weight];
        node.strokeAlign = "CENTER";
        node.strokeCap = s.cap.toUpperCase() === "BUTT" ? "NONE" : s.cap.toUpperCase();
        node.strokeJoin = s.join.toUpperCase();
        node.opacity = s.opacity;
        node.constraints = { horizontal: "SCALE", vertical: "SCALE" };
        attach(holder(s.groups), node);
      }
      return frame.handle;
    },
    combineAsVariants: (nodes: unknown, parent: unknown, index?: unknown) => {
      if (!Array.isArray(nodes) || !nodes.length) throw new Error("combineAsVariants takes one or more components");
      const components = nodes.map((h) => unwrap(h));
      if (components.some((c) => c.type !== "COMPONENT")) throw new Error("combineAsVariants takes components only");
      doc.settle();
      const set = new Node(doc, "COMPONENT_SET", "Component 1");
      call.created++;
      const x0 = Math.min(...components.map((c) => c.x));
      const y0 = Math.min(...components.map((c) => c.y));
      attach(unwrap(parent), set, index === undefined ? undefined : Number(index));
      [set.x, set.y] = [x0, y0];
      for (const c of components) {
        attach(set, c);
        [c.x, c.y] = [r2(c.x - x0), r2(c.y - y0)];
      }
      set.w = r2(Math.max(...components.map((c) => c.x + c.w)));
      set.h = r2(Math.max(...components.map((c) => c.y + c.h)));
      return set.handle;
    },
    loadFontAsync: async (font: unknown) => {
      const f = shape("loadFontAsync", font, ["family", "style"], ["family", "style"]) as { family: string; style: string };
      if (!doc.options.fonts[f.family]?.includes(f.style)) throw new Error(`The font "${f.family} ${f.style}" could not be loaded`);
      call.fonts.add(`${f.family}\u0000${f.style}`);
    },
    listAvailableFontsAsync: async () =>
      Object.entries(doc.options.fonts).flatMap(([family, styles]) => styles.map((style) => ({ fontName: { family, style } }))),
    getImageByHash: (hash: unknown) => {
      const image = doc.images.get(String(hash));
      if (!image) return null;
      return {
        hash: String(hash),
        getBytesAsync: async () => image.bytes.slice(),
        getSizeAsync: async () => {
          if (!image.size) throw new Error("Image size unknown");
          return { ...image.size };
        },
      };
    },
    createImage: () => {
      throw new Error("figma.createImage is not supported in use_figma: upload images with upload_assets");
    },
    createImageAsync: async () => {
      throw new Error("figma.createImageAsync is not supported in use_figma: upload images with upload_assets");
    },
    variables: {
      getLocalVariablesAsync: async (type?: unknown) => variablesOf(type as string | undefined).map(variableHandle),
      getLocalVariableCollectionsAsync: async () => [...doc.collections.keys()].map(collectionHandle),
      createVariableCollection: (name: unknown) => {
        const key = String(name);
        if (doc.collections.has(key)) throw new Error(`mock-figma: a second collection named ${key} is not modeled`);
        doc.collections.set(key, ["Mode 1"]);
        doc.variableWrites.push(`collection ${key}`);
        return collectionHandle(key);
      },
      // Takes the collection, or its id as an earlier API did.
      createVariable: (name: unknown, collection: unknown, type: unknown) => {
        const id = typeof collection === "string" ? collection : String((collection as { id?: unknown } | null)?.id);
        const key = id.replace(/^VariableCollectionId:/, "");
        if (!doc.collections.has(key)) throw new Error(`in createVariable: no collection ${id}`);
        const resolvedType = oneOf("createVariable", type, ["COLOR", "FLOAT", "STRING", "BOOLEAN"] as const);
        const blank = resolvedType === "COLOR" ? { r: 0, g: 0, b: 0, a: 1 } : resolvedType === "FLOAT" ? 0 : resolvedType === "STRING" ? "" : false;
        const v: Variable = { id: `VariableID:1:${doc.nextVariable++}`, name: String(name), resolvedType, value: blank, collection: key, modes: doc.collections.get(key)!.map((mode) => [mode, structuredClone(blank)]) };
        doc.variables.set(v.id, v);
        doc.variableWrites.push(`variable ${v.name}`);
        return variableHandle(v);
      },
      getVariableByIdAsync: async (id: unknown) => {
        const v = doc.variables.get(String(id));
        return v ? variableHandle(v) : null;
      },
      setBoundVariableForPaint: (p: unknown, field: unknown, variable: unknown) => bindTo(p, field, variable),
      setBoundVariableForEffect: (e: unknown, field: unknown, variable: unknown) => bindTo(e, field, variable),
    },
    util: {
      rgb: (hex: unknown) => {
        const c = parseHexColor(String(hex));
        return c ? { r: c.r, g: c.g, b: c.b } : null;
      },
      rgba: (hex: unknown) => parseHexColor(String(hex)),
    },
    viewport: { scrollAndZoomIntoView: () => undefined },
    showUI: () => undefined,
    closePlugin: () => undefined,
  };
  return figma;
}

// --- The mock ---------------------------------------------------------------

/** One use_figma call's outcome: what it returned, as the tool's text and parsed, or why it failed. */
export interface MockRun {
  ok: boolean;
  value?: unknown;
  /** The tool's text: the returned value as JSON, or the error. */
  text: string;
  bytes: number;
  error?: string;
  switches: string[];
  created: number;
  removed: number;
  ms: number;
}

/** A plain view of a node and its subtree, for tests to inspect and compare. */
export interface NodeView {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Figma's rotation, where it has one: counterclockwise degrees about x and y. */
  rotation?: number;
  data: Record<string, string>;
  children?: NodeView[];
}

export class MockFigma {
  private readonly doc: Doc;
  readonly runs: MockRun[] = [];

  constructor(options: MockFigmaOptions = {}) {
    this.doc = new Doc({
      fonts: options.fonts ?? FONTS,
      measure: options.measure ?? figmaFonts(),
      clonePluginData: options.clonePluginData ?? true,
      svgStrokeScales: options.svgStrokeScales ?? true,
      fillAcrossHug: options.fillAcrossHug ?? "stretch",
      shadowSpread: options.shadowSpread ?? "keep",
      textTruncation: options.textTruncation ?? "keep",
      moveNeedsFonts: options.moveNeedsFonts ?? false,
      maxModes: options.maxModes ?? Number.POSITIVE_INFINITY,
      reencodeImage: options.reencodeImage,
    }, options.pages ?? ["Page 1"]);
  }

  /**
   * Runs plugin code as one use_figma call: `figma` is the only global it
   * gets, as `new AsyncFunction("figma", code)`. Fails, as the tool does,
   * on code over 50,000 characters, a throw, a second page switch, or a
   * response over 20,000 bytes; what the code changed before failing stays
   * changed, as it does in Figma. The file is laid out before the call
   * returns, so a layout the mock refuses fails the call that set it up,
   * not a later one's read.
   */
  async run(code: string): Promise<MockRun> {
    const start = Date.now();
    const call: Call = { switches: [], loaded: new Set([this.doc.pages[0].id]), fonts: new Set(), current: this.doc.pages[0], created: 0, removed: 0 };
    const done = (run: Omit<MockRun, "switches" | "created" | "removed" | "ms">): MockRun => {
      const out = { ...run, switches: call.switches, created: call.created, removed: call.removed, ms: Date.now() - start };
      this.runs.push(out);
      return out;
    };
    if (code.length > CODE_LIMIT) return done({ ok: false, text: `code is ${code.length} characters, more than ${CODE_LIMIT}`, bytes: 0, error: "code_limit" });
    this.doc.call = call;
    let value: unknown;
    try {
      value = await new AsyncFunction("figma", code)(figmaGlobal(this.doc, call));
      this.doc.settle();
    } catch (err) {
      const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return done({ ok: false, text, bytes: Buffer.byteLength(text), error: text });
    } finally {
      this.doc.call = null;
    }
    const text = JSON.stringify(value) ?? "undefined";
    const bytes = Buffer.byteLength(text);
    if (bytes > RESPONSE_LIMIT) return done({ ok: false, text: `Response of ${bytes} bytes exceeds the 20kb limit`, bytes, error: "response_limit" });
    return done({ ok: true, value, text, bytes });
  }

  /** run(), answered as an MCP tool answers: the text, with `isError` when the call failed. */
  async useFigma(code: string): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
    const run = await this.run(code);
    return run.ok ? { content: [{ type: "text", text: run.text }] } : { content: [{ type: "text", text: run.text }], isError: true };
  }

  /**
   * Stands in for the upload_assets tool with its bytes posted: each node
   * gets an IMAGE fill, scaled by `scaleMode`, of the image with those
   * bytes, its hash their SHA-1 (as re-encoded, when the mock re-encodes).
   * Returns each node's hash.
   */
  uploadAssets(nodeIds: string[], files: Uint8Array[], scaleMode = "FILL"): { nodeId: string; imageHash: string }[] {
    if (nodeIds.length !== files.length) throw new Error(`uploadAssets: ${nodeIds.length} nodes, ${files.length} files`);
    return nodeIds.map((id, i) => {
      const node = this.doc.byId.get(id);
      if (!node || node.removed) throw new Error(`uploadAssets: no node ${id}`);
      const bytes = this.doc.options.reencodeImage ? this.doc.options.reencodeImage(files[i]) : files[i].slice();
      const imageHash = sha1(bytes);
      this.doc.images.set(imageHash, { bytes, size: imageSize(bytes) });
      node.fills = [{ type: "IMAGE", imageHash, scaleMode, opacity: 1, visible: true, blendMode: "NORMAL" }];
      return { nodeId: id, imageHash };
    });
  }

  /**
   * Adds a local variable: a COLOR's value as hex, a FLOAT's as a number,
   * in one mode, `Mode 1`, or in each of several by name, `{ Light: "#ffffff",
   * Dark: "#0a0a0a" }`, the first the collection's default. Every variable
   * of a collection takes the first one's modes.
   */
  addVariable(name: string, type: Variable["resolvedType"], value: string | number | boolean | Record<string, string | number | boolean>, collection = "Tokens"): { id: string } {
    const id = `VariableID:1:${this.doc.nextVariable++}`;
    const store = (v: string | number | boolean) => (type === "COLOR" ? parseHexColor(String(v)) : v);
    const modes: [string, unknown][] = typeof value === "object" ? Object.entries(value).map(([mode, v]) => [mode, store(v)]) : [["Mode 1", store(value)]];
    const others = this.doc.collections.get(collection);
    if (!modes.length || (others && others.join() !== modes.map(([mode]) => mode).join())) {
      throw new Error(`mock-figma: ${name} has modes ${modes.map(([mode]) => mode).join(", ") || "none"}, but ${collection}'s are ${others?.join(", ")}`);
    }
    if (!others) this.doc.collections.set(collection, modes.map(([mode]) => mode));
    this.doc.variables.set(id, { id, name, resolvedType: type, value: modes[0][1], collection, modes });
    return { id };
  }

  /** Every change the calls made to a variable or a collection so far, in order. */
  get variableWrites(): readonly string[] {
    return this.doc.variableWrites;
  }

  /**
   * Each collection, with its modes in order and its variables: each one's
   * type, scopes and value in each mode by name, a color as `#rrggbb`, or
   * `#rrggbbaa` when it isn't opaque.
   */
  collections(): { name: string; modes: string[]; variables: { name: string; type: string; scopes: string[]; values: Record<string, unknown> }[] }[] {
    const hex = (c: Rgba) => `#${[c.r, c.g, c.b, ...(c.a < 1 ? [c.a] : [])].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
    return [...this.doc.collections].map(([name, modes]) => ({
      name,
      modes: [...modes],
      variables: [...this.doc.variables.values()].filter((v) => v.collection === name).map((v) => ({
        name: v.name, type: v.resolvedType, scopes: [...(v.scopes ?? ["ALL_SCOPES"])],
        values: Object.fromEntries(v.modes.map(([mode, value]) => [mode, v.resolvedType === "COLOR" ? hex(value as Rgba) : value])),
      })),
    }));
  }

  /** Every page, as plain views. */
  pages(): NodeView[] {
    this.doc.settle();
    return this.doc.pages.map((p) => this.view(p));
  }

  /** A node by id as a plain view, wherever it is, or null. */
  node(id: string): NodeView | null {
    this.doc.settle();
    const node = this.doc.byId.get(id);
    return node && !node.removed ? this.view(node) : null;
  }

  /** Every live node of a type, as plain views. */
  nodes(type?: string): NodeView[] {
    this.doc.settle();
    return [...this.doc.byId.values()].filter((n) => !n.removed && n.type !== "DOCUMENT" && (!type || n.type === type) && n.page).map((n) => this.view(n));
  }

  /**
   * A node's live handle by id, outside any call, for a test to change the
   * file as a person would in Figma between calls (move a layer, recolor
   * it); fonts need not be loaded for it.
   */
  handle(id: string): Record<string, unknown> {
    const node = this.doc.byId.get(id);
    if (!node || node.removed) throw new Error(`no node ${id}`);
    return node.handle;
  }

  private view(n: Node): NodeView {
    const data: Record<string, string> = {};
    for (const [key, value] of n.data) data[key.replace("\u0000", ".")] = value;
    const out: NodeView = { id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.w, height: n.h, data };
    if (n.rot) out.rotation = n.rot;
    if (CONTAINERS.has(n.type)) out.children = n.kids.map((k) => this.view(k));
    return out;
  }
}

// --- Tree fixtures ----------------------------------------------------------

/** Where the T fixtures live, in the source tree (tests run from dist/). */
export const TREE_FIXTURES_DIR = fileURLToPath(new URL("../../../cli/__tests__/fixtures/tree/", import.meta.url));

/** A fixture: a styles.json holding one component with its tree, and where it came from. */
export type TreeFixture = SnapResult & {
  treeVersion: number;
  treeLimits: Record<string, number>;
  fixture: { name: string; sources: string[]; notes: string[] };
  components: (SnapComponent & { capture: "tree"; tree: ComponentTree })[];
};

/** The fixtures' names, from the files there. */
export function treeFixtureNames(): string[] {
  return readdirSync(TREE_FIXTURES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

export function loadTreeFixture(name: string): TreeFixture {
  return JSON.parse(readFileSync(`${TREE_FIXTURES_DIR}${name}.json`, "utf8")) as TreeFixture;
}

/**
 * A fixture with `nocls` set on the base nodes `keys` names, as snap now
 * records where no class colors them: the fixtures were snapped before it
 * did, and a tree without `nocls` takes no base style (figma-bind.ts).
 */
export function withNoClass(fixture: TreeFixture, keys: Record<string, NoClassPaint[]>): TreeFixture {
  const out = structuredClone(fixture);
  for (const component of out.components) {
    for (const node of component.tree.base) if (keys[node.k]) node.nocls = keys[node.k];
  }
  return out;
}

/** A fixture's asset file's bytes, by the path its ImageAsset gives, relative to the fixture. */
export function treeFixtureAsset(file: string): Uint8Array {
  return new Uint8Array(readFileSync(`${TREE_FIXTURES_DIR}${file}`));
}

/** Each measured variant of a fixture's component, by slug, with its expanded nodes. */
export function fixtureVariants(fixture: TreeFixture): { slug: string; name: string; nodes: TreeNode[] }[] {
  const component = fixture.components[0];
  return component.variants
    .filter((v) => v.status === "ok")
    .map((v) => ({
      slug: v.slug,
      name: Object.entries(v.combination).map(([k, value]) => `${k}=${value}`).join(", "),
      nodes: expandTree(component.tree, (v as { treeDelta?: TreeDelta }).treeDelta),
    }));
}
