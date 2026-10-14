// The harness verify v2's tests run on (design section 15, package C): a
// faithful build in test code that makes mock Figma layers from a fixture's
// facts, the real readback template run against them, and the readback
// assembled as `verify --plan` assembles it.
//
// The build here is not package B's. It is the simplest build that is
// right: every layer at its measured box, translated from the facts the way
// section 8.3 says, so a test that breaks one thing about it knows exactly
// what Figma holds. With `autoLayout`, flex containers whose children sit in
// one line are laid out by the mock's auto layout instead, so a wider
// stand-in font moves what follows it, as it would in Figma.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockFigma, loadTreeFixture, measureFromTrees, treeFixtureAsset, treeFixtureNames } from "./mock-figma.js";
import type { MockFigmaOptions, MockRun, TreeFixture } from "./mock-figma.js";
import { builtTurn, expandTree, parentKey, rootWithStyles, textHugs, transformedAround, treeDigest } from "../tree-types.js";
import type { Sides, TreeDelta, TreeNode } from "../tree-types.js";
import { applyDelta, splitTopLevel } from "../snap-normalize.js";
import { cssLinearGradient } from "../verify-tree.js";
import { componentKey } from "../storybook.js";
import { READ_LIMIT, addReadResult, readbackCall } from "../figma-results.js";
import type { ReadResult, ReadSlice } from "../figma-results.js";
import { READBACK_SCHEMA_VERSION } from "../verify.js";
import type { ReadbackFile } from "../verify.js";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const READBACK_TEMPLATE = readFileSync(`${ROOT}templates/readback.js`, "utf8");

/** The page the harness builds on. */
export const PAGE = "Components";

/** Every fixture's text, for a mock that measures text as the browser drew it. */
export function fixtureMeasure(): NonNullable<MockFigmaOptions["measure"]> {
  const trees = treeFixtureNames().flatMap((name) => {
    const fixture = loadTreeFixture(name);
    const c = fixture.components[0];
    return c.variants.filter((v) => v.status === "ok").map((v) => expandTree(c.tree, (v as { treeDelta?: TreeDelta }).treeDelta));
  });
  return measureFromTrees(trees);
}

export function newFigma(options: MockFigmaOptions = {}): MockFigma {
  return new MockFigma({ measure: fixtureMeasure(), ...options });
}

// --- CSS facts to Figma, as section 8.3 has it ------------------------------------

type Rgb = { r: number; g: number; b: number };
const rgb = (hex: string): Rgb => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });
const alpha = (hex: string) => (hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1);
const solid = (hex: string | null) => (hex
  ? { type: "SOLID", color: rgb(hex), opacity: alpha(hex) }
  // A transparent border is a stroke whose paint draws nothing, as 0.4.0 builds it.
  : { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0 });
const sides = <T>(v: Sides<T>): [T, T, T, T] => (Array.isArray(v) ? v : [v, v, v, v]) as [T, T, T, T];
const r2 = (n: number) => Math.round(n * 100) / 100;
const STYLES: Record<number, string> = { 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };
const BLEND: Record<string, string> = { darken: "DARKEN", multiply: "MULTIPLY", screen: "SCREEN", lighten: "LIGHTEN", overlay: "OVERLAY" };

/**
 * Figma's GRADIENT_LINEAR paint for a gradient as the readback encodes one,
 * `lin:<css angle>:<#hex@position,…>`, in a layer of `w` by `h`: the
 * gradient's line through the layer's center at the CSS angle, 0 up and 90
 * right, as long as CSS makes it, its stops' colors as written.
 */
export function linearGradientPaint(encoded: string, w: number, h: number): Record<string, unknown> {
  const [, deg, list] = encoded.split(":");
  const rad = (Number(deg) * Math.PI) / 180;
  const length = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  const [dx, dy] = [Math.sin(rad) * length, -Math.cos(rad) * length];
  const p0 = [(w / 2 - dx / 2) / w, (h / 2 - dy / 2) / h];
  const d = [dx / w, dy / h];
  const q = [-dy / w, dx / h];
  // Gradient space (u, v) to the layer is p0 + u d + (v - 0.5) q; Figma's transform is its inverse.
  const m = [[d[0], q[0], p0[0] - 0.5 * q[0]], [d[1], q[1], p0[1] - 0.5 * q[1]]];
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  const gradientTransform = [
    [m[1][1] / det, -m[0][1] / det, (m[0][1] * m[1][2] - m[1][1] * m[0][2]) / det],
    [-m[1][0] / det, m[0][0] / det, (m[1][0] * m[0][2] - m[0][0] * m[1][2]) / det],
  ];
  const gradientStops = list.split(",").map((stop) => {
    const [hex, at] = stop.split("@");
    return { position: Number(at), color: { ...rgb(hex), a: alpha(hex) } };
  });
  return { type: "GRADIENT_LINEAR", gradientTransform, gradientStops };
}

/** A layer as the builder code makes it: Figma's values, decided here. */
export interface LayerSpec {
  k: string;
  kind: "F" | "T" | "V" | "I" | "ROOT";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fills?: unknown[];
  strokes?: unknown[];
  weights?: [number, number, number, number];
  align?: string;
  dash?: number[];
  radius?: [number, number, number, number];
  effects?: unknown[];
  opacity: number;
  blend?: string;
  clip?: boolean;
  visible: boolean;
  /** Figma's rotation, where the layer turns: x and y are then its turned top left corner. */
  rotation?: number;
  text?: Record<string, unknown>;
  svg?: { id: string; markup: string };
  img?: string;
  layout?: Record<string, unknown>;
  /** Out of its parent's flow, where the parent has auto layout. */
  absolute?: boolean;
  children: LayerSpec[];
}

/** The stroke outside a frame's box per side: all of it, where the background stops at the border. */
function outsideOf(n: TreeNode): [number, number, number, number] {
  return n.bd && (n.bgc === "padding-box" || n.bgc === "content-box") ? sides(n.bd.w) : [0, 0, 0, 0];
}

/**
 * The layers for a variant's nodes, its root first: each at its measured
 * box, as an absolutely placed layer, unless `autoLayout` lets a flex
 * container lay its children out.
 */
export function layersOf(nodes: TreeNode[], rootStyles: Parameters<typeof rootWithStyles>[1], assets: TreeFixture["components"][0]["tree"]["assets"], autoLayout = false): LayerSpec {
  const byKey = new Map<string, LayerSpec>();
  const factOf = new Map<string, TreeNode>();
  let root: LayerSpec | null = null;
  for (const [i, raw] of nodes.entries()) {
    const n = i === 0 ? rootWithStyles(raw, rootStyles) : raw;
    factOf.set(n.k, n);
    const parent = parentKey(n.k);
    const around = parent === null ? [0, 0, 0, 0] : outsideOf(factOf.get(parent)!);
    const own = n.t === "T" || n.t === "V" ? [0, 0, 0, 0] : outsideOf(n);
    const spec: LayerSpec = {
      k: n.k, kind: i === 0 ? "ROOT" : n.t, name: n.el,
      x: r2(n.box[0] - around[3] + own[3]), y: r2(n.box[1] - around[0] + own[0]),
      w: r2(n.box[2] - own[1] - own[3]), h: r2(n.box[3] - own[0] - own[2]),
      opacity: n.op ?? 1, visible: n.vis !== 0, children: [],
      ...(n.abs ? { absolute: true } : {}),
    };
    if (n.t === "T" && n.tx) {
      const tx = n.tx;
      const hugs = textHugs(n) && tx.n === 1 && !tx.el && !tx.cl;
      spec.text = {
        font: { family: tx.fk || !["Inter", "Roboto Mono", "Noto Serif"].includes(tx.f) ? "Inter" : tx.f, style: STYLES[tx.wt] ?? "Regular" },
        chars: tx.c, size: tx.sz,
        lineHeight: tx.lh === "normal" ? { unit: "AUTO" } : { unit: "PIXELS", value: tx.lh },
        letterSpacing: { unit: "PIXELS", value: tx.ls ?? 0 },
        textCase: ({ uppercase: "UPPER", lowercase: "LOWER", capitalize: "TITLE" } as Record<string, string>)[tx.tt ?? ""] ?? "ORIGINAL",
        decoration: ({ underline: "UNDERLINE", "line-through": "STRIKETHROUGH" } as Record<string, string>)[tx.td ?? ""] ?? "NONE",
        align: ({ center: "CENTER", right: "RIGHT", end: "RIGHT", justify: "JUSTIFIED" } as Record<string, string>)[tx.ta ?? ""] ?? "LEFT",
        autoResize: hugs ? "WIDTH_AND_HEIGHT" : "HEIGHT",
        maxLines: tx.el ? 1 : tx.cl ?? null,
        color: tx.col,
      };
    } else if (n.t === "V") {
      spec.svg = { id: n.svg!, markup: assets.svg[n.svg!] };
    } else {
      // The background color under the image layers, which CSS lists top first.
      const gradients = (n.bgi ? splitTopLevel(n.bgi).reverse() : [])
        .map((layer) => cssLinearGradient(layer, n.box[2], n.box[3]))
        .filter((g): g is string => g !== null)
        .map((g) => linearGradientPaint(g, spec.w, spec.h));
      spec.fills = n.t === "I" ? [] : [...(n.bg ? [solid(n.bg)] : []), ...gradients];
      if (n.t === "I") spec.img = n.img;
      const weights: [number, number, number, number] = n.bd ? sides(n.bd.w) : [0, 0, 0, 0];
      if (n.bd && weights.some((w) => w > 0)) {
        const colors = sides(n.bd.c);
        const style = sides(n.bd.s)[weights.findIndex((w) => w > 0)];
        const w0 = Math.max(...weights);
        spec.strokes = [solid(colors[weights.findIndex((w) => w > 0)])];
        spec.weights = weights;
        spec.align = own.some((o) => o > 0) ? "OUTSIDE" : "INSIDE";
        spec.dash = style === "dashed" ? [3 * w0, 3 * w0] : style === "dotted" ? [w0, w0] : [];
      } else {
        spec.strokes = [];
      }
      spec.radius = sides(n.r ?? 0).map((r, corner) => (r > 0 ? r2(Math.max(0, r - Math.max(own[corner], own[(corner + 3) % 4]))) : 0)) as [number, number, number, number];
      spec.effects = [
        ...(n.sh ?? []).map(([x, y, blur, spread, color, inset]) => ({
          type: inset ? "INNER_SHADOW" : "DROP_SHADOW", color: { ...rgb(color ?? "#000000"), a: color ? alpha(color) : 0 },
          offset: { x, y }, radius: blur, spread, visible: true, blendMode: "NORMAL",
        })),
        ...[["LAYER_BLUR", n.fl], ["BACKGROUND_BLUR", n.bf]].flatMap(([type, value]) => {
          const m = /^blur\(([\d.]+)px\)$/.exec(String(value ?? ""));
          return m ? [{ type, radius: Number(m[1]), visible: true }] : [];
        }),
      ];
      spec.blend = n.bm ? BLEND[n.bm] ?? "PASS_THROUGH" : "PASS_THROUGH";
      spec.clip = Boolean(n.clip);
      if (autoLayout) spec.layout = flexLayout(n, nodes, own);
    }
    // A turn the build makes (builtTurn), about the box's center, as CSS
    // turns it, where Figma turns about the top left corner.
    const turn = i === 0 ? null : builtTurn(n, {
      children: nodes.filter((c) => parentKey(c.k) === n.k).length,
      transformed: transformedAround(n.k, (k) => nodes.find((c) => c.k === k)),
    });
    if (turn) {
      const t = (-turn * Math.PI) / 180;
      const [cx, cy] = [spec.x + spec.w / 2, spec.y + spec.h / 2];
      Object.assign(spec, {
        rotation: -turn,
        x: r2(cx - (Math.cos(t) * spec.w) / 2 - (Math.sin(t) * spec.h) / 2),
        y: r2(cy + (Math.sin(t) * spec.w) / 2 - (Math.cos(t) * spec.h) / 2),
      });
    }
    byKey.set(n.k, spec);
    if (parent === null) root = spec;
    else byKey.get(parent)!.children.push(spec);
  }
  return root!;
}

/**
 * An auto layout for a flex container whose in-flow children sit in one
 * line with even gaps, packed at the start, center or end, as the mock lays
 * one out; undefined for anything else, which stays absolutely placed.
 */
function flexLayout(n: TreeNode, nodes: TreeNode[], own: number[]): Record<string, unknown> | undefined {
  const L = n.L;
  if (!L || !L.d.includes("flex") || L.wrap) return undefined;
  const kids = nodes.filter((c) => parentKey(c.k) === n.k);
  const flow = kids.filter((c) => !c.abs);
  if (!flow.length || flow.some((c) => c.vis === 0)) return undefined;
  const row = !(L.dir ?? "row").startsWith("column");
  if ((L.dir ?? "").endsWith("reverse")) return undefined;
  const [m, s, c, cs] = row ? [0, 2, 1, 3] : [1, 3, 0, 2];
  const border = n.bd ? sides(n.bd.w) : [0, 0, 0, 0];
  const pad = L.pad ?? [0, 0, 0, 0];
  const inset = border.map((b, i) => (own[i] > 0 ? 0 : b) + pad[i]);
  const start = row ? inset[3] : inset[0];
  const end = n.box[s] - (row ? inset[1] : inset[2]);
  const sorted = [...flow].sort((a, b) => a.box[m] - b.box[m]);
  if (sorted.map((k) => k.k).join() !== flow.map((k) => k.k).join()) return undefined;
  const gaps = sorted.slice(1).map((k, i) => k.box[m] - (sorted[i].box[m] + sorted[i].box[s]));
  if (gaps.some((g) => Math.abs(g - gaps[0]) > 0.5 || g < -0.5)) return undefined;
  const first = sorted[0].box[m] - start;
  const last = end - (sorted[sorted.length - 1].box[m] + sorted[sorted.length - 1].box[s]);
  const primary = Math.abs(first) <= 0.5 ? "MIN" : Math.abs(last) <= 0.5 ? "MAX" : Math.abs(first - last) <= 1 ? "CENTER" : null;
  if (!primary) return undefined;
  const crossStart = row ? inset[0] : inset[3];
  const crossRoom = n.box[cs] - crossStart - (row ? inset[2] : inset[1]);
  const where = (k: TreeNode) => {
    const at = k.box[c] - crossStart;
    if (Math.abs(at) <= 0.5) return "MIN";
    if (Math.abs(at + k.box[cs] - crossRoom) <= 0.5) return "MAX";
    if (Math.abs(at - (crossRoom - k.box[cs]) / 2) <= 0.5) return "CENTER";
    return null;
  };
  const counter = where(sorted[0]);
  if (!counter || sorted.some((k) => where(k) !== counter && Math.abs(k.box[cs] - crossRoom) > 0.5)) return undefined;
  // Hug where the children fill the frame, as section 8.4 sizes one.
  const used = sorted.reduce((t, k) => t + k.box[s], 0) + (gaps[0] ?? 0) * (sorted.length - 1);
  return {
    mode: row ? "HORIZONTAL" : "VERTICAL",
    pad, spacing: gaps[0] ?? 0, primary, counter,
    hugMain: Math.abs(used - (end - start)) <= 0.5 && !flow.some((k) => k.S?.grow),
    included: own.every((o) => o === 0) && border.some((b) => b > 0),
  };
}

/** Plugin code that makes one layer tree from a spec, keyed, and returns the root's id and its layers' ids by key. */
const BUILDER = `
const fonts = {};
const load = async (font) => { const key = font.family + '|' + font.style; if (!fonts[key]) { await figma.loadFontAsync(font); fonts[key] = 1; } };
const ids = {};
const uploads = [];
const make = async (s, parent) => {
  let n;
  if (s.kind === 'T') {
    n = figma.createText();
    await load(s.text.font);
    n.fontName = s.text.font;
    n.characters = s.text.chars;
    n.fontSize = s.text.size;
    n.lineHeight = s.text.lineHeight;
    n.letterSpacing = s.text.letterSpacing;
    n.textCase = s.text.textCase;
    n.textDecoration = s.text.decoration;
    n.textAlignHorizontal = s.text.align;
    n.fills = s.text.color ? [{ type: 'SOLID', color: hex(s.text.color), opacity: alpha(s.text.color) }] : [];
    // Truncation after textAutoResize, which turns it off (the live text probe).
    if (s.text.autoResize === 'WIDTH_AND_HEIGHT') n.textAutoResize = 'WIDTH_AND_HEIGHT';
    else { n.resize(s.w, s.h); n.textAutoResize = 'HEIGHT'; }
    if (s.text.maxLines) { n.textTruncation = 'ENDING'; n.maxLines = s.text.maxLines; }
  } else if (s.kind === 'V') {
    n = figma.createNodeFromSvg(s.svg.markup);
    n.setSharedPluginData('storysync', 'svg', s.svg.id);
  } else {
    n = s.kind === 'ROOT' ? figma.createComponent() : figma.createFrame();
    n.resize(Math.max(s.w, 0.01), Math.max(s.h, 0.01));
    n.fills = s.fills;
    n.strokes = s.strokes;
    if (s.weights) {
      if (s.weights.every((w) => w === s.weights[0])) n.strokeWeight = s.weights[0];
      else [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight] = s.weights;
      n.strokeAlign = s.align;
      n.dashPattern = s.dash;
    }
    if (s.radius.every((r) => r === s.radius[0])) n.cornerRadius = s.radius[0];
    else [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius] = s.radius;
    n.effects = s.effects;
    n.blendMode = s.blend;
    n.clipsContent = s.clip;
    if (s.img) { n.setSharedPluginData('storysync', 'img', s.img); uploads.push([n.id, s.img]); }
  }
  n.name = s.name;
  if (s.kind !== 'ROOT') {
    parent.appendChild(n);
    n.setSharedPluginData('storysync', 'k', s.k);
    ids[s.k] = n.id;
  }
  n.opacity = s.opacity;
  n.visible = s.visible;
  if (s.rotation) n.rotation = s.rotation;
  for (const c of s.children) await make(c, n);
  const L = s.layout;
  if (L) {
    n.layoutMode = L.mode;
    [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft] = L.pad;
    n.itemSpacing = L.spacing;
    n.primaryAxisAlignItems = L.primary;
    n.counterAxisAlignItems = L.counter;
    n.strokesIncludedInLayout = L.included;
    n.primaryAxisSizingMode = L.hugMain ? 'AUTO' : 'FIXED';
    n.counterAxisSizingMode = 'FIXED';
  }
  // In auto layout, only what is out of the flow keeps its own place.
  for (const c of s.children) {
    const kid = n.children.find((k) => k.getSharedPluginData('storysync', 'k') === c.k);
    if (L && c.absolute) kid.layoutPositioning = 'ABSOLUTE';
    if (!L || c.absolute) { kid.x = c.x; kid.y = c.y; }
  }
  return n;
};
const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const alpha = (h) => (h.length === 9 ? parseInt(h.slice(7, 9), 16) / 255 : 1);
`;

/** The id a set carries: the component's Storybook id, or for a snap from before ids were recorded, its key. */
export function storysyncId(component: TreeFixture["components"][0]): string {
  return component.id ?? componentKey(component);
}

export interface BuiltVariant {
  slug: string;
  name: string;
  /** The variant's COMPONENT. */
  id: string;
  /** Its keyed layers' ids. */
  layers: Record<string, string>;
}

export interface BuiltSet {
  /** The set's id, or the plain component's. */
  id: string;
  component: string;
  variants: BuiltVariant[];
}

export interface BuildOptions {
  autoLayout?: boolean;
  /** Placeholders for variants snap couldn't measure, as D18 builds them; on by default. */
  placeholders?: boolean;
}

async function run(figma: MockFigma, code: string): Promise<unknown> {
  const result: MockRun = await figma.run(code);
  if (!result.ok) throw new Error(`mock Figma call failed: ${result.text}`);
  return result.value;
}

/**
 * Builds a fixture's component faithfully on PAGE: one call per variant,
 * each a COMPONENT with its layers and the plugin data the element-tree
 * build writes, then one that combines them into a set, or keeps the one
 * as a plain component where it has no variant properties. Images are
 * uploaded as upload_assets would, from the fixture's asset files.
 */
export async function buildFixture(figma: MockFigma, fixture: TreeFixture, options: BuildOptions = {}): Promise<BuiltSet> {
  const component = fixture.components[0];
  const built: BuiltVariant[] = [];
  const base = component.base!;
  for (const [i, variant] of component.variants.entries()) {
    const name = Object.entries(variant.combination).map(([k, v]) => `${k}=${v}`).join(", ");
    let spec: LayerSpec;
    let digest = "";
    if (variant.status === "ok") {
      const nodes = expandTree(component.tree, (variant as { treeDelta?: TreeDelta }).treeDelta);
      const styles = applyDelta(base.styles, variant.delta ?? {});
      spec = layersOf(nodes, styles, component.tree.assets, options.autoLayout);
      digest = treeDigest([rootWithStyles(nodes[0], styles), ...nodes.slice(1)]);
    } else if (options.placeholders === false) {
      continue;
    } else {
      // D18's placeholder: the base's size, dashed, labeled, src unmeasured.
      spec = {
        k: "", kind: "ROOT", name, x: 0, y: 0, w: base.styles.width as number, h: base.styles.height as number,
        fills: [], strokes: [solid("#a1a1a1")], weights: [1, 1, 1, 1], align: "INSIDE", dash: [3, 3], radius: [0, 0, 0, 0],
        effects: [], opacity: 1, blend: "PASS_THROUGH", clip: false, visible: true, children: [],
      };
    }
    const data = { slug: variant.slug, i: String(i), src: variant.status === "ok" ? "measured" : "unmeasured", tpl: "2", ...(digest ? { d: digest } : {}) };
    const code = `${BUILDER}
      const page = figma.root.children.find((p) => p.name === ${JSON.stringify(PAGE)}) || (() => { const p = figma.createPage(); p.name = ${JSON.stringify(PAGE)}; return p; })();
      await figma.setCurrentPageAsync(page);
      const root = await make(${JSON.stringify(spec)}, page);
      root.name = ${JSON.stringify(name)};
      root.x = ${i * 600};
      for (const [k, v] of Object.entries(${JSON.stringify(data)})) root.setSharedPluginData('storysync', k, v);
      return { id: root.id, layers: ids, uploads };`;
    const out = await run(figma, code) as { id: string; layers: Record<string, string>; uploads: [string, string][] };
    for (const [nodeId, asset] of out.uploads) {
      figma.uploadAssets([nodeId], [treeFixtureAsset(component.tree.assets.img[asset].file)]);
    }
    built.push({ slug: variant.slug, name, id: out.id, layers: out.layers });
  }
  const plain = component.variantProperties.length === 0;
  const id = await run(figma, `
    const page = figma.root.children.find((p) => p.name === ${JSON.stringify(PAGE)});
    await figma.setCurrentPageAsync(page);
    const parts = await Promise.all(${JSON.stringify(built.map((b) => b.id))}.map((id) => figma.getNodeByIdAsync(id)));
    const owner = ${plain} ? parts[0] : figma.combineAsVariants(parts, page);
    if (!${plain}) owner.name = ${JSON.stringify(component.name)};
    owner.setSharedPluginData('storysync', 'id', ${JSON.stringify(storysyncId(component))});
    owner.setSharedPluginData('storysync', 'title', ${JSON.stringify(component.title ?? "")});
    return owner.id;`) as string;
  return { id, component: storysyncId(component), variants: built };
}

/**
 * Reads sets back with the real template, as the plan's read calls and
 * `storysync figma next` would: one call over the slices, then one per
 * `more`, until none is left. Returns each call's result.
 */
export async function readBack(figma: MockFigma, slices: ReadSlice[], { limit = READ_LIMIT, page = PAGE, template = READBACK_TEMPLATE } = {}): Promise<ReadResult[]> {
  const results: ReadResult[] = [];
  let left: ReadSlice[] | undefined = slices;
  while (left?.length) {
    const result = await run(figma, readbackCall(template, page, left, limit)) as ReadResult;
    results.push(result);
    // Continuations that don't move on would be sent for ever: fail instead.
    if (results.length > 200) throw new Error(`200 read calls and still more: ${JSON.stringify(result.more?.slices)}`);
    left = result.more?.slices;
  }
  return results;
}

/** The readback file `verify --plan` assembles from read results. */
export function assemble(results: ReadResult[]): ReadbackFile {
  const readback: ReadbackFile = { version: READBACK_SCHEMA_VERSION, components: {} };
  for (const result of results) {
    const problems = addReadResult(readback, result);
    if (problems.length) throw new Error(problems.join("\n"));
  }
  return readback;
}

/** A fixture, by name or as a test changed it, built faithfully and read back whole. */
export async function buildAndRead(name: string | TreeFixture, options: BuildOptions & { figma?: MockFigma; limit?: number } = {}): Promise<{ figma: MockFigma; fixture: TreeFixture; built: BuiltSet; readback: ReadbackFile; results: ReadResult[] }> {
  const figma = options.figma ?? newFigma();
  const fixture = typeof name === "string" ? loadTreeFixture(name) : name;
  const built = await buildFixture(figma, fixture, options);
  const results = await readBack(figma, [[built.component, 0, fixture.components[0].variants.length - 1, 0]], { limit: options.limit });
  return { figma, fixture, built, readback: assemble(results), results };
}

/** Reads a built set back again, after a test changed the file. */
export async function reread(figma: MockFigma, fixture: TreeFixture, built: BuiltSet, limit?: number): Promise<ReadbackFile> {
  return assemble(await readBack(figma, [[built.component, 0, fixture.components[0].variants.length - 1, 0]], { limit }));
}
