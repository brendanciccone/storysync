// CSS facts to Figma properties, one node at a time (section 8.3, 8.6, 8.7).
//
// snap records what the browser drew; this decides how Figma draws the same:
// a border as a stroke, inside the frame or outside it, a shadow as an
// effect, a text's resizing from how its box relates to its glyphs. The
// result is a style: the plain values templates/build.js sets, so the
// template does no CSS. What Figma can't draw yet is left out and named, never
// approximated silently: per-side border colors, outlines, radial gradients,
// filters other than blur, blend modes Figma lacks, clip paths.
//
// Geometry lives here too: a Figma frame's box is its border box less any
// stroke built OUTSIDE it, and its children sit relative to that box.

import { alphaByte, alphaVariableName } from "./figma-bind.js";
import type { BindDecision, Binder, PaintRole, Scheme } from "./figma-bind.js";
import { SPIKE } from "./figma-spike.js";
import { figmaFamily, standInFor } from "./fonts.js";
import type { Spike } from "./figma-spike.js";
import { borderBuiltInside, borderPaintsNothing, builtTurn, insideStrokeDrawsBorder, textHugs, turnOf, unturnedBecause } from "./tree-types.js";
import type { Box, PlanAlpha, Sides, TreeNode, TurnContext } from "./tree-types.js";

/**
 * A paint as the template sets it: `#rrggbb` alone for an opaque, unbound
 * solid; else `[#rrggbb, opacity, variable?, token?]`; a linear gradient as
 * `{ g: gradientTransform's six numbers, s: [[position, #rrggbbaa], ...] }`.
 * A translucent paint of an opaque token binds to the token's alpha
 * variable, which carries the opacity (figma-bind.ts, alphaVariableName),
 * and names the token too: a file without that variable binds the token at
 * the paint's opacity, as before, which a mode switch resets to 1.
 */
export type FigmaPaint = string | [hex: string, opacity: number, variable?: string, token?: string] | { g: number[]; s: [number, string][] };

/** A stroke: weight, or one per side (top, right, bottom, left); its paint; a dash; `o: 1` when OUTSIDE. */
export interface FigmaStroke {
  w: number | [number, number, number, number];
  p: FigmaPaint;
  d?: [number, number];
  o?: 1;
}

/**
 * `[D|I, x, y, blur, spread, #rrggbb, alpha, variable?, token?]` for a
 * shadow, its color bound to the variable where one is named, and `token`
 * where that is the token's alpha variable, as a paint's; `[L|B, radius]`
 * for a blur.
 */
export type FigmaEffect = [string, number, number, number, number, string, number, string?, string?] | [string, number];

/** A text node's properties. */
export interface FigmaText {
  c: string;
  /** Family, weight, italic, as measured: loadFont picks a stand-in where Figma lacks them. */
  f: string;
  /** The stand-in loadFont tries where Figma lacks `f` (fonts.ts), when it isn't Inter, the template's last resort. */
  a?: string;
  /** Figma's name for `f`, where it differs, which loadFont tries first: `Geist` for fontsource's `Geist Variable` (fonts.ts figmaFamily). */
  g?: string;
  w: number;
  i?: 1;
  z: number;
  /** Line height in px, or 0 for AUTO (CSS `normal`). */
  l: number;
  s?: number;
  tc?: string;
  td?: string;
  ta?: string;
  /** textAutoResize: W for WIDTH_AND_HEIGHT, H for HEIGHT at the box's width. */
  ar: "W" | "H";
  /** maxLines, with textTruncation ENDING. */
  tr?: number;
  /**
   * The browser drew it whole on one line, in a box Figma sets at its width
   * (H): the build keeps it so where Figma's font sets it wider (textOf).
   */
  o?: 1;
  /**
   * Its lines' widest width and their count, for a text the browser broke
   * by `text-wrap: balance` or `pretty` (snap's `tw`), its lines narrower
   * than its box: the build breaks the lines there where Figma, filling
   * each line first, would break them elsewhere. Any other text wraps as
   * Figma fills it, and reflows when a designer resizes it.
   */
  b?: [number, number];
  /**
   * A form control's value: built at the box measured, its line at the
   * box's middle, as an input and a select draw it (C), or at its top, as a
   * textarea does (T), where a text that grows to its lines would shrink
   * the control around it.
   */
  v?: "C" | "T";
}

/** Everything the template sets on one node besides its place and size. */
export interface FigmaStyle {
  n?: string;
  f?: FigmaPaint[];
  s?: FigmaStroke;
  r?: number | [number, number, number, number];
  /** The radius variable, bound to every corner. */
  rv?: string;
  e?: FigmaEffect[];
  o?: number;
  b?: string;
  c?: 1;
  v?: 0;
  t?: FigmaText;
  /** A vector: its asset id, its markup's index in the call's table, and the factor to rescale by after import. */
  id?: string;
  m?: number;
  rs?: number;
  /** A vector's paint colors that bind, `#rrggbb` to variable, and `#rrggbb@opacity` to the alpha variable a translucent one binds to. */
  vb?: Record<string, string>;
  /** An image's asset id. */
  im?: string;
  /** Auto layout: direction, padding, item spacing, alignments, strokes included, and whether it hugs [horizontally, vertically]. */
  L?: { m: "H" | "V"; p: [number, number, number, number]; g: number; pa: string; ca: string; i?: 1; h: [0 | 1, 0 | 1] };
  /** Sizing in its auto-layout parent, horizontal and vertical: X fixed, H hug, L fill. */
  z?: [string, string];
  /** ABSOLUTE in its auto-layout parent. */
  a?: 1;
  /** Figma's rotation, counterclockwise in degrees: the node's turn (tree-types builtTurn), the other way round. */
  rt?: number;
  /** What the build adds only so Figma draws a shadow's spread: `c` the clip, `f` a white fill multiplied (figma-code, spreadDrawn). */
  rc?: string;
}

/** Something a fact asked for that the build does not draw, by node key, and what it draws instead, if anything. */
export interface NotBuilt {
  key: string;
  what: string;
  as?: string;
}

/**
 * A value left unbound: a paint because several tokens have its value and
 * no class picks one, or `why` it couldn't bind where a token has it.
 */
export interface Unbound {
  key: string;
  property: string;
  value: string;
  candidates: string[];
  /** The candidates the element's classes name, where they name several, which tie. */
  named?: string[];
  why?: string;
}

/**
 * A paint bound by the project's base styles, not a class: the rule is why
 * (figma-bind.ts); or bound where nothing named one, as every token of its
 * value holds the same value in each mode: those are `alike`.
 */
export interface BoundByDefault {
  key: string;
  property: string;
  value: string;
  variable: string;
  from: string;
  alike?: string[];
}

/** A binding no class showed, as `byDefault` records it: by a base style's rule, or by tokens alike in every mode. */
function byDefault(key: string, property: string, value: string, decision: BindDecision): BoundByDefault | null {
  if (!decision.variable) return null;
  if (decision.alike) return { key, property, value, variable: decision.variable, from: "", alike: decision.alike };
  return decision.from ? { key, property, value, variable: decision.variable, from: decision.from } : null;
}

export interface MapContext {
  binder: Binder;
  notBuilt: NotBuilt[];
  unbound: Unbound[];
  /** The paints a base style bound, each with its rule. */
  byDefault?: BoundByDefault[];
  /** The alpha variables the paints bind, by name: what the plan's `variables` call makes. */
  alphas?: Map<string, PlanAlpha>;
  /** Whether the tree's `cls` keeps a `dark:` class's opacity (ComponentTree's `darkAlpha`), which then gives the dark theme's alpha. */
  darkAlpha?: boolean;
  /** The color scheme snap measured the component in (its `scheme`), whose token values its paints match; light when absent. */
  scheme?: Scheme;
  /** The component the paints are of, recorded on each alpha variable it binds. */
  component?: string;
  /**
   * The parent's classes, for the color of a `#text` or `#value` run that
   * carries none of its own. snap writes the `text-*` class a run inherits on
   * the run itself, from whichever ancestor set it, and none on a parent that
   * paints nothing; a run without any reads its parent's.
   */
  parentCls?: string[];
  /** The parent's element, which says how a `#value` sits in its control: `input…`, `select…` or `textarea…`. */
  parentEl?: string;
  /** The spike's answers; SPIKE's when absent. */
  spike?: Pick<Spike, "svgStrokesScale">;
  /** Where the node sits, which decides whether the build turns it (builtTurn); a childless node with nothing transformed around it when absent. */
  around?: TurnContext;
}

const round2 = (n: number): number => Math.round(Math.round(n * 1e8) / 1e6) / 100 || 0;

const sides = <T>(value: Sides<T>): [T, T, T, T] => (Array.isArray(value) ? value : [value, value, value, value]) as [T, T, T, T];

/** One value where all four are equal, else the four. */
const collapse = (values: [number, number, number, number]): number | [number, number, number, number] =>
  values.every((v) => v === values[0]) ? values[0] : values;

/** `#rrggbb` and its alpha 0-1 from `#rrggbb` or `#rrggbbaa`. */
export function splitHex(hex: string): [string, number] {
  const value = hex.toLowerCase();
  const alpha = value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1;
  return [value.slice(0, 7), round3(alpha)];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * A solid paint for a measured color, bound where its value and classes
 * name one token, or where no class sets it (`nocls`) and the project's
 * base styles do.
 */
export function solidPaint(hex: string, role: PaintRole, cls: string[] | undefined, key: string, property: string, ctx: MapContext, nocls?: string[]): FigmaPaint {
  const [rgb, alpha] = splitHex(hex);
  const decision = ctx.binder.color(hex, role, cls, nocls, ctx.scheme);
  // A palette color no token is named for, which a `dark:` class pairs with
  // another: AspectRatio's `bg-slate-50 dark:bg-slate-900`.
  const light = !decision.variable && (ctx.scheme ?? "light") === "light" ? ctx.binder.lightPalette(rgb, role, cls) : undefined;
  const pair = light && perMode(light, alpha, ctx, role, cls);
  if (pair) return [rgb, alpha, pair];
  if (!decision.variable && decision.candidates.length > 1) {
    ctx.unbound.push({ key, property, value: hex.toLowerCase(), candidates: decision.candidates, ...(decision.named ? { named: decision.named } : {}) });
  }
  const found = byDefault(key, property, hex.toLowerCase(), decision);
  if (found) ctx.byDefault?.push(found);
  if (decision.variable) return [rgb, alpha, ...boundTo(decision.variable, alpha, ctx, role, cls)];
  return alpha === 1 ? rgb : [rgb, alpha];
}

/**
 * The fill of a node the light theme leaves clear and a `dark:` class
 * paints, an input's `bg-transparent dark:bg-input/30`: the dark color's
 * at 0 in Light, bound to the variable that holds it at the class's alpha
 * in Dark, `input 0% dark 30%`; null where no `dark:` class paints it.
 */
export function darkOnlyFill(node: TreeNode, ctx: MapContext): FigmaPaint | null {
  if ((ctx.scheme ?? "light") !== "light" || !ctx.darkAlpha) return null;
  const dark = ctx.binder.darkPaint("fill", node.cls);
  const hex = dark && (dark.hex ?? ctx.binder.hexOf(dark.name));
  if (!dark || !hex || alphaByte(dark.alpha * (hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1)) === 0) return null;
  const variable = alphaVariableName(dark.name, 0, dark.alpha);
  record(ctx, { variable, token: dark.name, alpha: 0, dark: round3(alphaByte(dark.alpha) / 255), ...(dark.hex ? { palette: { [dark.name]: dark.hex } } : {}) });
  return dark.hex ? [hex.slice(0, 7), 0, variable] : [hex.slice(0, 7), 0, variable, dark.name];
}

/** Records an alpha variable the plan binds, and the component binding it, for the plan's `variables` call to make. */
function record(ctx: MapContext, alpha: PlanAlpha): void {
  const had = ctx.alphas?.get(alpha.variable);
  const components = [...new Set([...(had?.components ?? []), ...(ctx.component ? [ctx.component] : [])])].sort();
  ctx.alphas?.set(alpha.variable, { ...(had ?? alpha), ...(components.length ? { components } : {}) });
}

/**
 * The per-mode variable of `light`, a token or palette color the light
 * class names, at `alpha`, where a `dark:` class paints another color:
 * `background dark input 30%`, `slate-50 dark slate-900`; undefined where
 * none does, or the snap cut its opacity off.
 */
function perMode(light: string, alpha: number, ctx: MapContext, role: PaintRole, cls: readonly string[] | undefined): string | undefined {
  if (!ctx.darkAlpha) return undefined;
  const dark = ctx.binder.darkPaint(role, cls);
  if (!dark || dark.name === light) return undefined;
  const variable = alphaVariableName(light, alpha, dark.alpha, dark.name);
  const lightHex = ctx.binder.hexOf(light);
  const palette: Record<string, string> = {};
  if (!ctx.binder.isToken(light) && lightHex) palette[light] = lightHex;
  if (dark.hex) palette[dark.name] = dark.hex;
  const at = (a: number) => round3(alphaByte(a) / 255);
  record(ctx, { variable, token: light, alpha: at(alpha), darkToken: dark.name, dark: at(dark.alpha), ...(Object.keys(palette).length ? { palette } : {}) });
  return variable;
}

/**
 * What a paint or shadow of `token`'s color at `alpha` binds to: the token,
 * where it is opaque and painted opaque in both themes, or is translucent
 * and holds that alpha itself; else its alpha variable, then the token,
 * recorded for the plan's `variables` call to make. A `dark:` class that
 * names the token at another alpha (`dark:bg-destructive/20` beside
 * `bg-destructive/10`) gives the variable that alpha in Dark, and one that
 * names another color (`bg-background dark:bg-input/30`) a per-mode
 * variable of the two. Measured dark, the paint is the dark theme's, at
 * its alpha in both modes: snap keeps no light class's opacity to say
 * Light's.
 */
function boundTo(token: string, alpha: number, ctx: MapContext, role: PaintRole, cls: readonly string[] | undefined): [string] | [string, string] {
  const scheme = ctx.scheme ?? "light";
  const paint = scheme === "light" && ctx.darkAlpha ? ctx.binder.darkPaint(role, cls) : undefined;
  if (paint && paint.name !== token) {
    const variable = perMode(token, alpha, ctx, role, cls);
    if (variable) return [variable, token];
  }
  const named = paint?.name === token ? paint.alpha : undefined;
  const dark = named === undefined || alphaByte(named) === alphaByte(alpha) ? undefined : named;
  if (!ctx.binder.opaque(token, scheme) || (alpha >= 1 && dark === undefined)) return [token];
  const variable = alphaVariableName(token, alpha, dark);
  const at = (a: number) => round3(alphaByte(a) / 255);
  record(ctx, { variable, token, alpha: at(alpha), ...(dark !== undefined ? { dark: at(dark) } : {}) });
  return [variable, token];
}

/** A paint that draws nothing: a transparent border still takes its space, so it is a stroke all the same. */
const CLEAR: FigmaPaint = ["#000000", 0];

// --- Gradients --------------------------------------------------------------

/** Degrees from a CSS angle, or null for something else. */
function angleOf(text: string): number | null {
  const m = /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "deg" ? n : m[2] === "turn" ? n * 360 : m[2] === "rad" ? (n * 180) / Math.PI : n * 0.9;
}

/**
 * A CSS `linear-gradient(...)` as a Figma GRADIENT_LINEAR paint on a w by h
 * box, or null when it isn't one this builds. Figma's transform maps the
 * node's 0-1 space to the gradient's, whose x runs along the gradient line,
 * which CSS draws through the center at the angle given, as long as the box's
 * extent along it.
 */
export function linearGradient(layer: string, w: number, h: number): FigmaPaint | null {
  const m = /^linear-gradient\((.*)\)$/i.exec(layer.trim());
  if (!m) return null;
  const parts = splitArgs(m[1]);
  let angle = 180;
  const first = parts[0]?.trim() ?? "";
  const to = /^to\s+(.+)$/i.exec(first);
  if (to) {
    const words = to[1].toLowerCase().split(/\s+/);
    const x = words.includes("left") ? -1 : words.includes("right") ? 1 : 0;
    const y = words.includes("top") ? -1 : words.includes("bottom") ? 1 : 0;
    if (x && y) {
      // Toward a corner: perpendicular to the diagonal through the other two.
      const a = (Math.atan2(h, w) * 180) / Math.PI;
      angle = y < 0 ? (x > 0 ? a : 360 - a) : x > 0 ? 180 - a : 180 + a;
    } else {
      angle = x > 0 ? 90 : x < 0 ? 270 : y < 0 ? 0 : 180;
    }
    parts.shift();
  } else if (angleOf(first) !== null) {
    angle = angleOf(first)!;
    parts.shift();
  }
  const rad = (angle * Math.PI) / 180;
  const [dx, dy] = [Math.sin(rad), -Math.cos(rad)];
  const length = Math.abs(w * dx) + Math.abs(h * dy) || 1;
  const stops: [number | null, string][] = [];
  for (const part of parts) {
    const s = /^(#[0-9a-f]{3,8})(?:\s+(-?[\d.]+)(%|px))?$/i.exec(part.trim());
    if (!s) return null;
    const at = s[2] === undefined ? null : s[3] === "%" ? Number(s[2]) / 100 : Number(s[2]) / length;
    stops.push([at, s[1].toLowerCase()]);
  }
  if (stops.length < 2) return null;
  // Stops without a position spread evenly between their neighbors, as CSS does.
  if (stops[0][0] === null) stops[0][0] = 0;
  if (stops[stops.length - 1][0] === null) stops[stops.length - 1][0] = 1;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i][0] !== null) {
      stops[i][0] = Math.max(stops[i][0]!, stops[i - 1][0]!);
      continue;
    }
    let j = i;
    while (stops[j][0] === null) j++;
    const from = stops[i - 1][0]!;
    for (let k = i; k < j; k++) stops[k][0] = from + ((stops[j][0]! - from) * (k - i + 1)) / (j - i + 1);
  }
  const start = [w / 2 - (dx * length) / 2, h / 2 - (dy * length) / 2];
  const g = [
    (w * dx) / length, (h * dy) / length, -(start[0] * dx + start[1] * dy) / length,
    (-w * dy) / length, (h * dx) / length, (start[0] * dy - start[1] * dx) / length + 0.5,
  ].map((n) => Math.round(n * 1e4) / 1e4 || 0);
  return { g, s: stops.map(([at, color]) => [round3(Math.min(1, Math.max(0, at!))), longHex(color)]) };
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` as `#rrggbbaa`. */
function longHex(hex: string): string {
  const d = hex.slice(1);
  const full = d.length <= 4 ? [...d].map((c) => c + c).join("") : d;
  return `#${full.length === 6 ? `${full}ff` : full}`;
}

/** Comma-separated arguments at the top level of a CSS function. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

// --- Strokes, radii, effects ------------------------------------------------

/** The widths of a stroke built OUTSIDE the frame, top, right, bottom, left: the frame is that much smaller than the border box. */
export function outsideInsets(node: TreeNode): [number, number, number, number] {
  if (!strokeIsOutside(node)) return [0, 0, 0, 0];
  return sides(node.bd!.w);
}

/**
 * Whether the border is built OUTSIDE: where the background stops at it
 * (`background-clip: padding-box`, as shadcn/ui's Button's `bg-clip-padding`),
 * so Figma's fill, which an INSIDE stroke would sit over, ends where the
 * browser's does, and a translucent or dashed border shows what is behind
 * it. Not where the border is built INSIDE at the border box all the same
 * (borderBuiltInside): no background, a solid opaque border that hides it,
 * or a border that paints nothing, so its radius is the browser's own and
 * binds.
 */
function strokeIsOutside(node: TreeNode): boolean {
  return Boolean(node.bd && node.bgc && sides(node.bd.w).some((w) => w > 0) && node.t === "F" && !borderBuiltInside(node));
}

/**
 * What about a border the background stops at shows what is behind the
 * element rather than the background, where it is built OUTSIDE: some side
 * transparent, translucent, or a style with gaps, as `dashed`.
 */
function seeThrough(node: TreeNode): string {
  const widths = sides(node.bd!.w);
  const colors = sides(node.bd!.c);
  const styles = sides(node.bd!.s);
  const drawn = [0, 1, 2, 3].filter((i) => widths[i] > 0);
  const alpha = (i: number) => (colors[i] === null ? 0 : splitHex(colors[i]!)[1]);
  if (drawn.some((i) => alpha(i) === 0)) return "partly transparent";
  if (drawn.some((i) => alpha(i) < 1)) return "translucent";
  return styles[drawn.find((i) => styles[i] !== "solid") ?? drawn[0]];
}

function strokeOf(node: TreeNode, ctx: MapContext): FigmaStroke | undefined {
  const bd = node.bd;
  if (!bd) return undefined;
  const widths = sides(bd.w);
  if (!widths.some((w) => w > 0)) return undefined;
  const styles = sides(bd.s);
  const colors = sides(bd.c);
  const drawn = [0, 1, 2, 3].filter((i) => widths[i] > 0);
  // One color for the stroke: the sides' own when they agree, else the one
  // most sides draw, and the rest named as not built (phase 2 draws sides).
  const counts = new Map<string, number>();
  for (const i of drawn) counts.set(String(colors[i]), (counts.get(String(colors[i])) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const color = ranked[0][0] === "null" ? null : ranked[0][0];
  if (ranked.length > 1) ctx.notBuilt.push({ key: node.k, what: `per-side border colors (${drawn.map((i) => colors[i] ?? "transparent").join(" ")})`, as: `one color, ${color ?? "transparent"}` });
  const style = styles[drawn[0]];
  if (!["solid", "dashed", "dotted"].includes(style)) ctx.notBuilt.push({ key: node.k, what: `border style ${style}`, as: "solid" });
  const w = collapse(widths);
  const stroke: FigmaStroke = { w, p: color ? solidPaint(color, "stroke", node.cls, node.k, "stroke", ctx, node.nocls) : CLEAR };
  const unit = Math.max(...drawn.map((i) => widths[i]));
  if (style === "dashed") stroke.d = [3 * unit, 3 * unit];
  if (style === "dotted") stroke.d = [unit, unit];
  if (strokeIsOutside(node)) stroke.o = 1;
  return stroke;
}

function radiusOf(node: TreeNode, ctx: MapContext): Pick<FigmaStyle, "r" | "rv"> {
  if (node.r === undefined) return { r: 0 };
  let corners = sides(node.r);
  const outside = strokeIsOutside(node);
  if (outside) {
    // The frame is the padding box, whose corners CSS draws with the inner
    // radius: the outer less the border on that corner's sides.
    const [t, r, b, l] = sides(node.bd!.w);
    const inner = [Math.max(t, l), Math.max(t, r), Math.max(b, r), Math.max(b, l)];
    corners = corners.map((c, i) => round2(Math.max(0, c - inner[i]))) as [number, number, number, number];
  }
  const out: Pick<FigmaStyle, "r" | "rv"> = { r: collapse(corners) };
  const value = sides(node.r)[0];
  if (sides(node.r).every((c) => c === value) && value > 0) {
    // A radius of half the shorter side draws a pill or a circle, whatever
    // its value: one CSS scaled down to it binds by no value (Binder.radius).
    const decision = ctx.binder.radius(value, node.cls, value * 2 >= Math.min(node.box[2], node.box[3]) - 0.01);
    if (outside) {
      // A token has the browser's radius, but the frame is drawn with the
      // inner one, which none has: said, rather than left without a word.
      if (decision.variable || decision.candidates.length) {
        ctx.unbound.push({
          key: node.k, property: "radius", value: String(value), candidates: decision.candidates,
          why: `its background stops inside its ${seeThrough(node)} border (background-clip ${node.bgc}), which shows what is behind the element there, so the frame is built as the padding box, at radius ${out.r}, which no token holds`,
        });
      }
    } else if (decision.variable) out.rv = decision.variable;
    else if (decision.candidates.length > 1) ctx.unbound.push({ key: node.k, property: "radius", value: String(value), candidates: decision.candidates, ...(decision.named ? { named: decision.named } : {}) });
  }
  return out;
}

const BLUR = /^blur\((-?[\d.]+)px\)$/;

/**
 * Shadows and blurs. A shadow's color binds where a `ring-*` or `shadow-*`
 * class names its token, as shadcn/ui's dialog's `ring-foreground/10`
 * names `foreground`, never by its value alone, since Tailwind's shadow
 * scale draws in a black no token was set from. A translucent one binds to
 * the token's alpha variable, `foreground 10%`, whose alpha Figma keeps at
 * a mode switch, where the token's own would make it opaque (probe 7c).
 */
function effectsOf(node: TreeNode, ctx: MapContext): FigmaEffect[] {
  const out: FigmaEffect[] = [];
  for (const [x, y, blur, spread, color, inset] of node.sh ?? []) {
    if (!color) continue;
    const [rgb, alpha] = splitHex(color);
    if (alpha === 0) continue;
    const effect: FigmaEffect = [inset ? "I" : "D", x, y, blur, spread, rgb, alpha];
    const decision = ctx.binder.color(color, "effect", node.cls, undefined, ctx.scheme);
    if (decision.variable) effect.push(...boundTo(decision.variable, alpha, ctx, "effect", node.cls));
    // Only classes naming two of them leave it ambiguous: a shadow no class
    // names, as Tailwind's black shadow scale, binds to none by design.
    else if (decision.ambiguous) ctx.unbound.push({ key: node.k, property: "effect", value: color.toLowerCase(), candidates: decision.candidates, ...(decision.named ? { named: decision.named } : {}) });
    out.push(effect);
  }
  for (const [fact, kind, name] of [[node.fl, "L", "filter"], [node.bf, "B", "backdrop-filter"]] as const) {
    if (!fact) continue;
    const m = BLUR.exec(fact.trim());
    if (m) out.push([kind, Number(m[1])]);
    else ctx.notBuilt.push({ key: node.k, what: `${name} ${fact}` });
  }
  return out;
}

/** CSS blend modes as Figma names them; the ones Figma lacks are left out. */
const BLENDS: Record<string, string> = {
  multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", darken: "DARKEN", lighten: "LIGHTEN",
  "color-dodge": "COLOR_DODGE", "color-burn": "COLOR_BURN", "hard-light": "HARD_LIGHT", "soft-light": "SOFT_LIGHT",
  difference: "DIFFERENCE", exclusion: "EXCLUSION", hue: "HUE", saturation: "SATURATION", color: "COLOR", luminosity: "LUMINOSITY",
};

// --- Text -------------------------------------------------------------------

const CASES: Record<string, string> = { uppercase: "UPPER", lowercase: "LOWER", capitalize: "TITLE" };
const DECORATIONS: Record<string, string> = { underline: "UNDERLINE", "line-through": "STRIKETHROUGH" };
const ALIGNS: Record<string, string> = { center: "CENTER", right: "RIGHT", end: "RIGHT", justify: "JUSTIFIED" };

/**
 * Whether a text node sizes itself to its characters (WIDTH_AND_HEIGHT):
 * when its box is its glyphs' own width (textHugs) on one line, and nothing
 * cuts it off. A wider stand-in font then makes it wider rather than
 * wrapping it. Anything else is laid out at the box's width (HEIGHT), as
 * the browser laid it out in its block.
 */
export function textSizesItself(node: TreeNode): boolean {
  const tx = node.tx!;
  return textHugs(node) && tx.n === 1 && !tx.el && !tx.cl;
}

/**
 * Whether the browser drew a text whole on one line: one line, its glyphs
 * inside its box, so nothing an ellipsis or a clip cut off.
 */
export function textWhole(node: TreeNode): boolean {
  const tx = node.tx!;
  return tx.n === 1 && tx.ink[0] >= -0.5 && tx.ink[0] + tx.ink[2] <= node.box[2] + 0.5;
}

function textOf(node: TreeNode, ctx: MapContext): FigmaText {
  const tx = node.tx!;
  const out: FigmaText = { c: tx.c, f: tx.f, w: tx.wt, z: tx.sz, l: tx.lh === "normal" ? 0 : tx.lh, ar: textSizesItself(node) ? "W" : "H" };
  // The stand-in for a family Figma lacks: what snap drew a keyword in, or,
  // for a snap that drew the keyword's own face, what Figma sets it in.
  const alt = standInFor(tx.fs ?? tx.f);
  if (alt !== "Inter" && alt !== tx.f) out.a = alt;
  const named = figmaFamily(tx.f);
  if (named !== tx.f) out.g = named;
  // A label Figma's font sets wider than the browser's would wrap in its
  // measured width, or show an ellipsis the browser didn't: the build checks
  // each such one once laid out (templates/build.js, keepLines).
  if (out.ar === "H" && textWhole(node)) out.o = 1;
  if (node.el === "#value") Object.assign(out, { ar: "H", v: ctx.parentEl?.startsWith("textarea") ? "T" : "C" });
  else if (tx.tw && tx.n > 1 && !tx.el && !tx.cl && tx.ink[2] < node.box[2] - 1) out.b = [round2(tx.ink[2]), tx.n];
  if (tx.it) out.i = 1;
  if (tx.ls) out.s = tx.ls;
  if (tx.tt) out.tc = CASES[tx.tt];
  if (tx.td) out.td = DECORATIONS[tx.td];
  if (tx.ta && ALIGNS[tx.ta]) out.ta = ALIGNS[tx.ta];
  if (tx.el) out.tr = 1;
  else if (tx.cl) out.tr = tx.cl;
  return out;
}

// --- Vectors ----------------------------------------------------------------

/** `markup` with its root's width and height set to these, written where it has none; unchanged where they are these already. */
function sizedSvg(markup: string, width: number, height: number): string {
  const set = (text: string, name: string, value: number) => {
    const attr = new RegExp(`^<svg([^>]*?)\\s${name}="[^"]*"`);
    return attr.test(text) ? text.replace(attr, `<svg$1 ${name}="${value}"`) : text.replace(/^<svg/, `<svg ${name}="${value}"`);
  };
  return set(set(markup, "height", height), "width", width);
}

/**
 * A vector's markup to import and the factor to rescale it by, as
 * SPIKE.svgStrokesScale says. Figma scales strokes with the import (spike
 * item 1), so the markup is imported at the node's measured size, which
 * snap writes on it, or which it is given when it lacks it. The fallback
 * imports at the viewBox's own size and rescales to the box.
 */
export function vectorImport(markup: string, box: Box, strokesScale: boolean = SPIKE.svgStrokesScale): { markup: string; rescale?: number } {
  if (strokesScale) return { markup: sizedSvg(markup, round2(box[2]), round2(box[3])) };
  const view = /viewBox="([^"]*)"/.exec(markup)?.[1].split(/[\s,]+/).map(Number);
  if (!view || view.length !== 4 || !(view[2] > 0) || !(view[3] > 0)) return { markup };
  const factor = Math.round((box[2] / view[2]) * 1e6) / 1e6;
  if (!(factor > 0) || factor === 1) return { markup };
  return { markup: sizedSvg(markup, view[2], view[3]), rescale: factor };
}

/**
 * The colors in SVG markup, each `#rrggbb` with the opacities it is drawn at,
 * from its fill and stroke attributes: a shape's own `fill-opacity` or
 * `stroke-opacity`, else the root's, which serializeSvg hoists there when
 * every shape shares it, times any alpha of an `#rrggbbaa`, to 0.01 as the
 * markup writes them. A shape without a color of its own takes the root's.
 */
export function markupPaints(markup: string): Map<string, number[]> {
  const out = new Map<string, Set<number>>();
  const attrs = (text: string) => Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const tags = [...markup.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: attrs(m[2]) }));
  const root = tags[0]?.tag === "svg" ? tags[0].attrs : {};
  for (const { attrs: own } of tags) {
    for (const kind of ["fill", "stroke"]) {
      const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(own[kind] ?? (own === root ? "" : root[kind] ?? ""));
      if (!m) continue;
      const opacity = Number(own[`${kind}-opacity`] ?? root[`${kind}-opacity`] ?? 1) * (m[2] ? parseInt(m[2], 16) / 255 : 1);
      const hex = `#${m[1].toLowerCase()}`;
      out.set(hex, (out.get(hex) ?? new Set()).add(Number.isFinite(opacity) ? Math.round(opacity * 100) / 100 : 1));
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)).map(([hex, alphas]) => [hex, [...alphas].sort((a, b) => a - b)]));
}

// --- The node ---------------------------------------------------------------

/**
 * The style of one node, from its facts: everything but its place, size,
 * auto layout and sizing, which come from the layout plan. `markup` is the
 * node's SVG markup when it is a vector.
 */
export function nodeStyle(node: TreeNode, ctx: MapContext, markup?: string): Omit<FigmaStyle, "L" | "z" | "a" | "m"> & { markup?: string } {
  const style: FigmaStyle & { markup?: string } = {};
  const kind = node.t;
  // A layer is named by its element; an icon by its class, `lucide-bell` (section 8.7).
  if (kind !== "T") style.n = kind === "V" ? node.el.replace(/^svg\./, "") : node.el;
  if (node.op !== undefined && node.op !== 1) style.o = node.op;
  if (node.vis === 0) style.v = 0;
  if (node.bm && node.bm !== "normal") {
    if (BLENDS[node.bm]) style.b = BLENDS[node.bm];
    else ctx.notBuilt.push({ key: node.k, what: `blend mode ${node.bm}` });
  }
  if (node.cp) ctx.notBuilt.push({ key: node.k, what: `clip-path ${node.cp}` });
  if (node.ol) ctx.notBuilt.push({ key: node.k, what: `outline ${node.ol[0]}px ${node.ol[1]} ${node.ol[2] ?? "transparent"}` });
  // A turn the build can make is built (builtTurn), as Figma's rotation,
  // the other way round; any other transform is named.
  const around = ctx.around ?? { children: 0, transformed: false };
  const turn = builtTurn(node, around);
  if (turn) style.rt = -turn;
  else if (node.tf && turn === null) {
    ctx.notBuilt.push({
      key: node.k, what: `transform ${node.tf}`,
      as: turnOf(node.tf) === null ? "the element's own box, untransformed" : `its own box, unturned, as ${unturnedBecause(node, around)}`,
    });
  }
  if (node.clip) {
    style.c = 1;
    if (node.clip !== 1) ctx.notBuilt.push({ key: node.k, what: `overflow clipped on ${node.clip} only`, as: "clipping both axes" });
  }
  const effects = effectsOf(node, ctx);
  if (effects.length) style.e = effects;

  if (kind === "T") {
    style.t = textOf(node, ctx);
    const color = node.tx!.col;
    const cls = node.el.startsWith("#") ? node.cls ?? ctx.parentCls : node.cls;
    style.f = color ? [solidPaint(color, "text", cls, node.k, "color", ctx, node.nocls)] : [];
    return style;
  }

  if (kind === "V") {
    if (markup === undefined) throw new Error(`"${node.k}" is a vector whose svg asset ${node.svg ?? "(none)"} is not in the tree's assets`);
    const imported = vectorImport(markup, node.box, (ctx.spike ?? SPIKE).svgStrokesScale);
    style.id = node.svg;
    style.markup = imported.markup;
    if (imported.rescale) style.rs = imported.rescale;
    const binds: Record<string, string> = {};
    for (const [hex, alphas] of markupPaints(markup)) {
      const decision = ctx.binder.color(hex, "vector", node.cls, node.nocls, ctx.scheme);
      const found = byDefault(node.k, "vector", hex, decision);
      if (found) ctx.byDefault?.push(found);
      if (decision.variable) {
        binds[hex] = decision.variable;
        // A translucent shape's paint binds to the alpha variable, by its
        // color and opacity as the import draws them, `#rrggbb@0.5`.
        for (const alpha of alphas) {
          const [variable, token] = boundTo(decision.variable, alpha, ctx, "vector", node.cls);
          if (token) binds[`${hex}@${alpha}`] = variable;
        }
      } else if (decision.candidates.length > 1) ctx.unbound.push({ key: node.k, property: "vector", value: hex, candidates: decision.candidates, ...(decision.named ? { named: decision.named } : {}) });
    }
    if (Object.keys(binds).length) style.vb = binds;
    return style;
  }

  // A frame, or an image's frame.
  const fills: FigmaPaint[] = [];
  if (kind === "I") {
    style.im = node.img;
  } else {
    if (node.bg) fills.push(solidPaint(node.bg, "fill", node.cls, node.k, "fill", ctx));
    else {
      const dark = darkOnlyFill(node, ctx);
      if (dark) fills.push(dark);
    }
    if (node.bgi) {
      // CSS lists the top layer first; Figma's fills run bottom to top.
      const layers = splitArgs(node.bgi).reverse();
      for (const layer of layers) {
        const [w, h] = figmaSize(node);
        const paint = linearGradient(layer, w, h);
        if (paint) fills.push(paint);
        else ctx.notBuilt.push({ key: node.k, what: `background ${layer.length > 60 ? `${layer.slice(0, 57)}...` : layer}` });
      }
    }
    if (node.bgc && fills.length && !insideStrokeDrawsBorder(node) && borderPaintsNothing(node)) {
      // A clear ring: the frame is the border box its class rounds, and the
      // fill runs under the ring, where the browser shows what is behind.
      ctx.notBuilt.push({ key: node.k, what: `background-clip ${node.bgc} inside a transparent border`, as: "a fill to the border box, under the border's clear stroke" });
    } else if (node.bgc === "content-box") ctx.notBuilt.push({ key: node.k, what: "background-clip content-box", as: "padding-box" });
    style.f = fills;
  }
  const stroke = strokeOf(node, ctx);
  if (stroke) style.s = stroke;
  Object.assign(style, radiusOf(node, ctx));
  return style;
}

/** A node's Figma frame size: its border box less any stroke built outside it. */
export function figmaSize(node: TreeNode): [number, number] {
  const [t, r, b, l] = outsideInsets(node);
  return [round2(Math.max(0.01, node.box[2] - l - r)), round2(Math.max(0.01, node.box[3] - t - b))];
}
