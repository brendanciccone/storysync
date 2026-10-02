// Pure normalization for `storysync snap`.
//
// Everything here is browser-free so it can be unit tested without launching
// Chromium: the browser hands back raw `getComputedStyle` strings, and this
// module turns them into the normalized shape the Figma writer consumes.

import { colorToHex } from "./color.js";
import type { FigmaVariantProperty } from "./mapper.js";

// --- Shapes -----------------------------------------------------------------

/** Raw `getComputedStyle` values, keyed by CSS longhand property name. */
export type RawComputedStyles = Record<string, string>;

export interface BorderSide {
  width: number;
  style: string;
  color: string | null;
}

export interface BoxShadowLayer {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string | null;
  inset: boolean;
}

export interface TextStyles {
  /**
   * The text's colour as drawn: an `opacity` on the element holding the text,
   * or on one between it and the measured root, is folded into its alpha. The
   * root's own opacity is the frame's `opacity`, not part of this.
   */
  color: string | null;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /**
   * The computed `text-transform`, `uppercase`, `lowercase` or `capitalize`,
   * absent for `none`. A story's args hold the label as written, `Beta`,
   * while the browser draws, and measures the width of, `BETA`.
   *
   * This and letterSpacing are written only when the text has them, so a
   * styles.json from before they were measured, or from a component without
   * either, reads and diffs as it did.
   */
  textTransform?: string;
  /** In px, a percentage resolved against the text's own font size; absent for none. */
  letterSpacing?: number;
}

export interface NormalizedStyles {
  display: string;
  flexDirection: string | null;
  alignItems: string | null;
  justifyContent: string | null;
  gap: { row: number; column: number } | null;
  width: number;
  height: number;
  /** The layer under `backgroundImage`, when there is one: seen only where the image is transparent. */
  backgroundColor: string | null;
  /**
   * The computed `background-image`, its colours as hex: a gradient or image
   * painted over `backgroundColor`. A gradient button has a `backgroundColor`
   * of null and is still filled.
   *
   * Written only when there is one, so a styles.json from before it was
   * measured, or from components without one, reads and diffs as it did. A
   * variant whose base has one and it doesn't records null in its delta.
   */
  backgroundImage?: string | null;
  color: string | null;
  border: { top: BorderSide | null; right: BorderSide | null; bottom: BorderSide | null; left: BorderSide | null } | null;
  /** Set when all four sides are identical — the common case for Figma strokes. */
  borderUniform: BorderSide | null;
  /**
   * The radii the browser draws, in px: percentages resolved against the
   * border box, and corners too big for it scaled down as CSS scales them.
   */
  borderRadius: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  /** Set when all four corners are equal — maps to Figma `cornerRadius`. */
  borderRadiusUniform: number | null;
  padding: { top: number; right: number; bottom: number; left: number };
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number | "normal";
  letterSpacing: number;
  boxShadow: BoxShadowLayer[];
  opacity: number;
  text: TextStyles | null;
  /**
   * `content-box` or `border-box`. Decides whether a border sits outside the
   * declared size or inside it, which is what Figma's `strokeAlign` has to
   * mirror — the default `INSIDE` eats padding on a `content-box` element.
   */
  boxSizing: string;
  /**
   * Whether the browser could actually render `fontFamily`, or null when
   * undetermined.
   *
   * `fontFamily` is the *declared* first family, not the resolved one, so a
   * project naming a font it never loaded would otherwise measure and score as
   * though that font were used while rendering a fallback. Recording
   * availability keeps the substitution visible instead of silent.
   */
  fontAvailable: boolean | null;
}

/** The CSS longhands the browser side is asked to read. */
export const CAPTURED_PROPERTIES: readonly string[] = [
  "display", "flex-direction", "align-items", "justify-content",
  "row-gap", "column-gap",
  "background-color", "background-image", "color", "opacity",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-right-radius", "border-bottom-left-radius",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  "box-shadow", "box-sizing",
];

/**
 * Read off the element holding the text. snap-browser adds `opacity`: not the
 * holder's own, but the product of every opacity from it up to the measured
 * root, the root's excluded.
 */
export const TEXT_PROPERTIES: readonly string[] = [
  "color", "font-family", "font-size", "font-weight", "text-transform", "letter-spacing",
];

/** What snap-browser reads off a Storybook wrapper to decide whether to look past it. */
export const WRAPPER_PROPERTIES: readonly string[] = [
  "display", "background-color", "background-image", "box-shadow",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
];

// --- Scalar helpers ---------------------------------------------------------

/**
 * `"14px"` -> `14`, and `"3.35544e+07px"`, the exponent form Chromium writes a
 * huge length in, to its number. Returns null when the value isn't a length.
 */
export function pxToNumber(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return round2(n);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pxOrZero(value: string | undefined): number {
  return pxToNumber(value) ?? 0;
}

/**
 * Normalizes a computed color to hex, collapsing fully transparent values to
 * null. `getComputedStyle` reports an absent background as `rgba(0, 0, 0, 0)`,
 * which is meaningfully "no fill" rather than "transparent black".
 *
 * Chromium reports a colour in the space it was written in, so Tailwind v4's
 * `oklch(...)` palette, its `oklab(... / 0.5)` opacity modifiers and every
 * `color(...)` space all come through here; colorToHex converts each to sRGB.
 * One it couldn't read would come back null, and null is "no fill": a red
 * button recorded as unfilled, which Figma would then be built to match.
 */
export function normalizeColor(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none" || trimmed === "transparent") return null;
  const hex = colorToHex(trimmed);
  if (!hex) return null;
  // #rrggbb00 — zero alpha.
  if (hex.length === 9 && hex.slice(7, 9) === "00") return null;
  return hex;
}

/**
 * Whether a colour has zero alpha. Read off the hex, since normalizeColor's
 * null can't tell a transparent colour from one it couldn't read.
 */
export function isFullyTransparent(value: string | undefined): boolean {
  const hex = colorToHex(value ?? "");
  return hex != null && hex.length === 9 && hex.endsWith("00");
}

/** First family in a font stack, with quotes stripped. */
export function firstFontFamily(value: string | undefined): string {
  if (!value) return "";
  const first = value.split(",")[0]?.trim() ?? "";
  return first.replace(/^['"]|['"]$/g, "");
}

function normalizeFontWeight(value: string | undefined): number {
  const raw = (value ?? "").trim();
  const named: Record<string, number> = { normal: 400, bold: 700, lighter: 300, bolder: 700 };
  if (named[raw] != null) return named[raw];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 400;
}

function normalizeLineHeight(value: string | undefined): number | "normal" {
  const raw = (value ?? "").trim();
  if (!raw || raw === "normal") return "normal";
  const px = pxToNumber(raw);
  if (px != null) return px;
  const n = Number(raw);
  return Number.isFinite(n) ? round2(n) : "normal";
}

/** Chromium keeps a percentage letter-spacing as written; it is a share of the font size. */
function normalizeLetterSpacing(value: string | undefined, fontSize: number): number {
  const raw = (value ?? "").trim();
  if (!raw || raw === "normal") return 0;
  const percent = raw.match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)%$/i);
  if (percent) {
    const n = (Number(percent[1]) / 100) * fontSize;
    return Number.isFinite(n) ? round2(n) : 0;
  }
  return pxToNumber(raw) ?? 0;
}

/**
 * A hex colour drawn at an opacity: its alpha multiplied by it, rounded as
 * formatHex rounds alpha, the byte dropped when opaque and the colour null,
 * no fill, when nothing is left.
 */
function withOpacity(hex: string | null, opacity: number): string | null {
  if (hex == null || !Number.isFinite(opacity) || opacity >= 1) return hex;
  const alpha = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255;
  const scaled = Math.round(alpha * Math.max(0, opacity));
  if (scaled === 0) return null;
  return scaled >= 255 ? hex.slice(0, 7) : `${hex.slice(0, 7)}${scaled.toString(16).padStart(2, "0")}`;
}

/** A colour function as Chromium serialises one, in any space. */
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\([^)]*\)/i;

/**
 * A computed `background-image`, or null for none, with each colour in its
 * gradients written as hex like every other colour snap records: Tailwind
 * v4's `bg-linear-to-r` computes to `linear-gradient(to right, oklch(...) 0%,
 * oklch(...) 100%)`, Chromium dropping its default `in oklab`. A `url()`
 * layer is kept as written.
 */
function normalizeBackgroundImage(value: string | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw || raw === "none") return null;
  const anyColor = new RegExp(COLOR_FUNCTION.source, "gi");
  return splitTopLevel(raw)
    .map((layer) => (/^url\(/i.test(layer) ? layer : layer.replace(anyColor, (c) => colorToHex(c) ?? c)))
    .join(", ");
}

// --- Border -----------------------------------------------------------------

/** Returns null when the side draws nothing (zero width or `style: none`). */
export function parseBorderSide(
  width: string | undefined,
  style: string | undefined,
  color: string | undefined,
): BorderSide | null {
  const w = pxToNumber(width) ?? 0;
  const s = (style ?? "none").trim();
  if (w <= 0 || s === "none" || s === "hidden") return null;
  return { width: w, style: s, color: normalizeColor(color) };
}

function sameBorderSide(a: BorderSide | null, b: BorderSide | null): boolean {
  if (a == null || b == null) return a === b;
  return a.width === b.width && a.style === b.style && a.color === b.color;
}

// --- Border radius ----------------------------------------------------------

const RADIUS_LENGTH = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|%)$/i;

/**
 * One corner's computed radius as its horizontal and vertical radii, in px.
 *
 * Chromium keeps a percentage as written, the horizontal radius a share of
 * the border box's width and the vertical of its height, and writes an
 * elliptical corner as two values. A calc() or min() holding a percentage is
 * resolved to px on the browser side, since only layout can; one that
 * arrives unresolved reads as square.
 */
function cornerRadii(value: string | undefined, box: { width: number; height: number }): [number, number] {
  const parts = splitTopLevel((value ?? "").trim(), " ");
  const toPx = (token: string | undefined, basis: number): number => {
    const m = token?.match(RADIUS_LENGTH);
    if (!m) return 0;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, m[2] === "%" ? (n / 100) * basis : n);
  };
  return [toPx(parts[0], box.width), toPx(parts[1] ?? parts[0], box.height)];
}

/**
 * The corner radii the browser draws, as Figma can hold them.
 *
 * Radii that together run longer than a side are all scaled down by one
 * factor, as CSS does with overlapping curves: Tailwind v4's `rounded-full`
 * is `calc(infinity * 1px)`, which Chromium computes to `3.35544e+07px`, and
 * on a 32px-tall pill it draws 16. Recording the computed value instead would
 * give a Figma radius of 33 million, and v3's `9999px` one of 9999, neither
 * of which the browser drew. Figma has no elliptical corner, so one whose two
 * radii differ, `10px / 20px` or `50%` of a box that isn't square, keeps the
 * smaller.
 */
function resolveRadii(
  raw: RawComputedStyles,
  box: { width: number; height: number },
): NormalizedStyles["borderRadius"] {
  const [tl, tr, br, bl] = ["top-left", "top-right", "bottom-right", "bottom-left"]
    .map((corner) => cornerRadii(raw[`border-${corner}-radius`], box));
  const fits = (side: number, sum: number) => (sum > 0 ? side / sum : Infinity);
  const scale = Math.max(0, Math.min(
    1,
    fits(box.width, tl[0] + tr[0]), fits(box.width, bl[0] + br[0]),
    fits(box.height, tl[1] + bl[1]), fits(box.height, tr[1] + br[1]),
  ));
  const corner = ([h, v]: [number, number]) => round2(Math.min(h, v) * scale);
  return { topLeft: corner(tl), topRight: corner(tr), bottomRight: corner(br), bottomLeft: corner(bl) };
}

// --- Box shadow -------------------------------------------------------------

/**
 * Splits on top-level commas only, so the commas inside `rgba(...)` don't
 * fragment a layer.
 */
export function splitTopLevel(value: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Parses a computed `box-shadow`. Chromium normalizes to
 * `rgba(0, 0, 0, 0.1) 0px 1px 2px 0px` (color first, `inset` suffixed), but
 * authored order varies, so colors and lengths are collected positionally.
 *
 * A layer that draws nothing is left out: one fully transparent, or one with
 * no offset, blur or spread, inset or not, which sits exactly under the
 * element or exactly outside its padding box. Tailwind fills every shadow and
 * ring slot a class doesn't use with `0 0 #0000`, so `shadow-sm` computes to
 * four of those before its two real layers, and v3's `ring-1` to a white
 * ring-offset layer of zero size. Each would otherwise reach Figma as a
 * `DROP_SHADOW`.
 */
export function parseBoxShadow(value: string | undefined): BoxShadowLayer[] {
  const raw = (value ?? "").trim();
  if (!raw || raw === "none") return [];

  const layers: BoxShadowLayer[] = [];
  for (const part of splitTopLevel(raw)) {
    let rest = part;
    let inset = false;
    if (/(^|\s)inset(\s|$)/.test(rest)) {
      inset = true;
      rest = rest.replace(/(^|\s)inset(\s|$)/, " ");
    }

    // Pull the color out first — it's the only token that can contain spaces.
    // Chromium writes it in its authored space: oklch(), oklab(), color() too.
    let color: string | null = null;
    let transparent = false;
    const fnColor = rest.match(COLOR_FUNCTION);
    if (fnColor) {
      color = normalizeColor(fnColor[0]);
      transparent = isFullyTransparent(fnColor[0]);
      rest = rest.replace(fnColor[0], " ");
    } else {
      const hexOrName = rest.match(/(^|\s)(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)(\s|$)/);
      if (hexOrName) {
        const candidate = hexOrName[2];
        const asColor = normalizeColor(candidate);
        if (asColor) {
          color = asColor;
          rest = rest.replace(candidate, " ");
        }
        transparent = isFullyTransparent(candidate);
      }
    }

    const lengths = rest.trim().split(/\s+/).map((t) => pxToNumber(t)).filter((n): n is number => n != null);
    const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = lengths;
    if (transparent || (offsetX === 0 && offsetY === 0 && blur === 0 && spread === 0)) continue;

    layers.push({ offsetX, offsetY, blur, spread, color, inset });
  }
  return layers;
}

// --- Wrappers ---------------------------------------------------------------

/**
 * Whether a single-child element draws nothing of its own, so snap measures
 * its child instead: Storybook decorators commonly wrap a story in padding-
 * and background-free containers, and measuring one would describe the
 * wrapper, not the component.
 *
 * Its background is transparent by its colour's alpha, in whatever space
 * Chromium writes it: Tailwind v4's `bg-black/0` computes to
 * `oklab(0 0 0 / 0)`, not `rgba(0, 0, 0, 0)`. A colour that can't be read is
 * not taken for transparent, and nor is a background image, which is drawn
 * whatever the colour beneath it.
 */
export function isPassThroughWrapper(raw: RawComputedStyles): boolean {
  const display = (raw["display"] ?? "").trim();
  const zero = (property: string) => parseFloat(raw[property] ?? "") === 0;
  return (display === "block" || display === "contents") &&
    isFullyTransparent(raw["background-color"]) &&
    normalizeBackgroundImage(raw["background-image"]) == null &&
    parseBoxShadow(raw["box-shadow"]).length === 0 &&
    ["top", "right", "bottom", "left"].every((side) => zero(`border-${side}-width`) && zero(`padding-${side}`));
}

// --- normalizeStyles --------------------------------------------------------

export function normalizeStyles(
  raw: RawComputedStyles,
  box: { width: number; height: number },
  textRaw?: RawComputedStyles | null,
  fontAvailable: boolean | null = null,
): NormalizedStyles {
  const border = {
    top: parseBorderSide(raw["border-top-width"], raw["border-top-style"], raw["border-top-color"]),
    right: parseBorderSide(raw["border-right-width"], raw["border-right-style"], raw["border-right-color"]),
    bottom: parseBorderSide(raw["border-bottom-width"], raw["border-bottom-style"], raw["border-bottom-color"]),
    left: parseBorderSide(raw["border-left-width"], raw["border-left-style"], raw["border-left-color"]),
  };
  const anyBorder = border.top ?? border.right ?? border.bottom ?? border.left;
  const allSame =
    sameBorderSide(border.top, border.right) &&
    sameBorderSide(border.top, border.bottom) &&
    sameBorderSide(border.top, border.left);

  const radius = resolveRadii(raw, box);
  const radiusUniform =
    radius.topLeft === radius.topRight &&
    radius.topLeft === radius.bottomRight &&
    radius.topLeft === radius.bottomLeft
      ? radius.topLeft
      : null;

  const rowGap = pxToNumber(raw["row-gap"]);
  const columnGap = pxToNumber(raw["column-gap"]);
  const isFlex = (raw["display"] ?? "").includes("flex") || (raw["display"] ?? "").includes("grid");

  const opacity = Number(raw["opacity"]);
  const backgroundImage = normalizeBackgroundImage(raw["background-image"]);

  return {
    display: (raw["display"] ?? "").trim(),
    flexDirection: isFlex ? (raw["flex-direction"] ?? null) : null,
    alignItems: isFlex ? (raw["align-items"] ?? null) : null,
    justifyContent: isFlex ? (raw["justify-content"] ?? null) : null,
    gap: rowGap != null || columnGap != null ? { row: rowGap ?? 0, column: columnGap ?? 0 } : null,
    width: round2(box.width),
    height: round2(box.height),
    backgroundColor: normalizeColor(raw["background-color"]),
    ...(backgroundImage != null ? { backgroundImage } : {}),
    color: normalizeColor(raw["color"]),
    border: anyBorder ? border : null,
    borderUniform: anyBorder && allSame ? border.top : null,
    borderRadius: radius,
    borderRadiusUniform: radiusUniform,
    padding: {
      top: pxOrZero(raw["padding-top"]),
      right: pxOrZero(raw["padding-right"]),
      bottom: pxOrZero(raw["padding-bottom"]),
      left: pxOrZero(raw["padding-left"]),
    },
    fontFamily: firstFontFamily(raw["font-family"]),
    fontSize: pxOrZero(raw["font-size"]),
    fontWeight: normalizeFontWeight(raw["font-weight"]),
    lineHeight: normalizeLineHeight(raw["line-height"]),
    letterSpacing: normalizeLetterSpacing(raw["letter-spacing"], pxOrZero(raw["font-size"])),
    boxShadow: parseBoxShadow(raw["box-shadow"]),
    opacity: Number.isFinite(opacity) ? round2(opacity) : 1,
    boxSizing: (raw["box-sizing"] ?? "content-box").trim(),
    fontAvailable,
    text: textRaw ? normalizeText(textRaw) : null,
  };
}

function normalizeText(textRaw: RawComputedStyles): TextStyles {
  const textTransform = (textRaw["text-transform"] ?? "").trim() || "none";
  const letterSpacing = normalizeLetterSpacing(textRaw["letter-spacing"], pxOrZero(textRaw["font-size"]));
  return {
    color: withOpacity(normalizeColor(textRaw["color"]), Number(textRaw["opacity"] ?? 1)),
    fontFamily: firstFontFamily(textRaw["font-family"]),
    fontSize: pxOrZero(textRaw["font-size"]),
    fontWeight: normalizeFontWeight(textRaw["font-weight"]),
    ...(textTransform !== "none" ? { textTransform } : {}),
    ...(letterSpacing !== 0 ? { letterSpacing } : {}),
  };
}

// --- Storybook args encoding ------------------------------------------------

/**
 * Storybook's own allowed charset for URL arg keys and values, from its
 * router: `VALIDATION_REGEXP = /^[a-zA-Z0-9 _-]*$/`. Anything outside it is
 * dropped *silently*, and the story then renders with its default args — so a
 * value we can't encode must be reported rather than measured, or we'd record
 * the default render as though it were that variant.
 *
 * Verified empirically against Storybook 10.5: `Data Display` round-trips,
 * `Nav/Primary` is discarded.
 */
export const STORYBOOK_ARG_CHARSET = /^[a-zA-Z0-9 _-]*$/;

export function isEncodableArgValue(value: string): boolean {
  return STORYBOOK_ARG_CHARSET.test(value);
}

export interface EncodedArgs {
  /** The `args` query value, or null when nothing could be encoded. */
  param: string | null;
  /** `name=value` pairs Storybook would reject. */
  unsupported: string[];
}

/**
 * Builds the `args` query parameter for one variant combination.
 *
 * Booleans use Storybook's `!true` / `!false` literal form. The `!` is outside
 * the charset for *values*, but Storybook parses these markers before charset
 * validation, so they are emitted as-is.
 */
export function encodeStoryArgs(
  combo: Record<string, string>,
  props: readonly FigmaVariantProperty[],
): EncodedArgs {
  const byName = new Map(props.map((p) => [p.name, p]));
  const pairs: string[] = [];
  const unsupported: string[] = [];

  for (const [name, value] of Object.entries(combo)) {
    if (!isEncodableArgValue(name)) {
      unsupported.push(`${name}=${value}`);
      continue;
    }

    if (byName.get(name)?.type === "BOOLEAN") {
      pairs.push(`${name}:${value === "true" ? "!true" : "!false"}`);
      continue;
    }

    if (!isEncodableArgValue(value)) {
      unsupported.push(`${name}=${value}`);
      continue;
    }
    pairs.push(`${name}:${value}`);
  }

  return { param: pairs.length ? pairs.join(";") : null, unsupported };
}

/**
 * Builds a story iframe URL. The whole query is assembled with
 * `URLSearchParams`, which percent-encodes spaces as `+` — verified to
 * round-trip through Storybook's arg parser.
 */
export function buildStoryUrl(baseUrl: string, storyId: string, argsParam: string | null): string {
  const base = baseUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({ id: storyId, viewMode: "story" });
  if (argsParam) query.set("args", argsParam);
  return `${base}/iframe.html?${query.toString()}`;
}

// --- Naming -----------------------------------------------------------------

function slugSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Stable, filesystem-safe name for one variant combination. */
export function slugifyCombination(combo: Record<string, string>): string {
  const keys = Object.keys(combo);
  if (!keys.length) return "default";
  return keys.map((k) => `${slugSegment(k)}-${slugSegment(combo[k])}`).join("--");
}

export function componentSlug(name: string, title?: string): string {
  return slugSegment(title ? title.replace(/\//g, "-") : name) || "component";
}

/** One combination that had to be renamed because its slug was already taken. */
export interface SlugCollision {
  /** The name it shares with an earlier combination. */
  base: string;
  /** The distinct name it was recorded under instead. */
  slug: string;
  combination: Record<string, string>;
}

/**
 * Slugs for a list of combinations, guaranteed distinct.
 *
 * `slugifyCombination` lowercases and collapses punctuation, so two declared
 * values that Storybook treats as different — `Small` and `small`, `x-large`
 * and `x large` — reduce to the same slug. That slug is the key joining a
 * measurement to the Figma node built from it, and the screenshot filename, so
 * a duplicate is not cosmetic: `expandSnap` keys a Map by it and keeps
 * whichever variant came last, dropping the other from the score. Losing a
 * variant shrinks the denominator, so a collision makes fidelity read *higher*.
 *
 * Numbering follows combination order, which is itself deterministic, so the
 * assignment is stable across runs. Collisions come back separately rather than
 * being resolved quietly — a renumbered slug is the name that reaches Figma.
 */
export function assignVariantSlugs(
  combinations: Record<string, string>[],
): { slugs: string[]; collisions: SlugCollision[] } {
  const used = new Set<string>();
  const slugs: string[] = [];
  const collisions: SlugCollision[] = [];

  for (const combination of combinations) {
    const base = slugifyCombination(combination);
    let slug = base;
    // Keeps counting while the invented name is itself taken. Today
    // `slugifyCombination` cannot emit `<base>--<n>` — every pair it joins
    // contains a literal `-`, so a bare numeric trailing segment is
    // unreachable — but the loop costs nothing and makes distinctness hold
    // unconditionally rather than by way of that argument.
    for (let suffix = 2; used.has(slug); suffix++) slug = `${base}--${suffix}`;
    if (slug !== base) collisions.push({ base, slug, combination });
    used.add(slug);
    slugs.push(slug);
  }

  return { slugs, collisions };
}

// --- Base + delta encoding --------------------------------------------------

/**
 * Per-variant differences against a base. Most variants differ in two or three
 * properties, so emitting only those keeps the payload small and makes the
 * meaningful change obvious to whoever writes the Figma component.
 */
export type StyleDelta = Partial<NormalizedStyles>;

const STYLE_KEYS = [
  "display", "flexDirection", "alignItems", "justifyContent", "gap",
  "width", "height", "backgroundColor", "backgroundImage", "color", "border", "borderUniform",
  "borderRadius", "borderRadiusUniform", "padding", "fontFamily", "fontSize",
  "fontWeight", "lineHeight", "letterSpacing", "boxShadow", "opacity", "text",
  "boxSizing", "fontAvailable",
] as const satisfies readonly (keyof NormalizedStyles)[];

/**
 * Compile-time guard that STYLE_KEYS covers every field of NormalizedStyles.
 *
 * `satisfies` above only checks that each listed key is valid, not that none
 * are missing. A field added to NormalizedStyles but omitted here would be
 * silently excluded from every delta — variants differing only in that field
 * would look identical, which would both drop the property from the Figma
 * output and falsely trip the identical-variant warning. Adding a field
 * without listing it here fails the build, naming the missing key.
 */
type AssertNever<T extends never> = T;
type _AllStyleKeysCovered = AssertNever<Exclude<keyof NormalizedStyles, (typeof STYLE_KEYS)[number]>>;

/** Structural equality via canonical JSON — all values here are plain data. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function diffFromBase(base: NormalizedStyles, variant: NormalizedStyles): StyleDelta {
  const delta: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    // A field written only when present, such as backgroundImage, is null
    // here when the variant lacks it, or JSON would drop the change.
    if (!sameValue(base[key], variant[key])) delta[key] = variant[key] ?? null;
  }
  return delta as StyleDelta;
}

export function applyDelta(base: NormalizedStyles, delta: StyleDelta): NormalizedStyles {
  return { ...base, ...delta };
}
