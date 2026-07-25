// Pure normalization for `storysync snap`.
//
// Everything here is browser-free so it can be unit tested without launching
// Chromium: the browser hands back raw `getComputedStyle` strings, and this
// module turns them into the normalized shape the Figma writer consumes.

import { colorToHex } from "./diff.js";
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
  color: string | null;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
}

export interface NormalizedStyles {
  display: string;
  flexDirection: string | null;
  alignItems: string | null;
  justifyContent: string | null;
  gap: { row: number; column: number } | null;
  width: number;
  height: number;
  backgroundColor: string | null;
  color: string | null;
  border: { top: BorderSide | null; right: BorderSide | null; bottom: BorderSide | null; left: BorderSide | null } | null;
  /** Set when all four sides are identical — the common case for Figma strokes. */
  borderUniform: BorderSide | null;
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
}

/** The CSS longhands the browser side is asked to read. */
export const CAPTURED_PROPERTIES: readonly string[] = [
  "display", "flex-direction", "align-items", "justify-content",
  "row-gap", "column-gap",
  "background-color", "color", "opacity",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-right-radius", "border-bottom-left-radius",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  "box-shadow",
];

export const TEXT_PROPERTIES: readonly string[] = ["color", "font-family", "font-size", "font-weight"];

// --- Scalar helpers ---------------------------------------------------------

/** `"14px"` -> `14`. Returns null when the value isn't a length. */
export function pxToNumber(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^(-?[\d.]+)px$/);
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

function normalizeLetterSpacing(value: string | undefined): number {
  const raw = (value ?? "").trim();
  if (!raw || raw === "normal") return 0;
  return pxToNumber(raw) ?? 0;
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
    let color: string | null = null;
    const fnColor = rest.match(/(rgba?|hsla?)\s*\([^)]*\)/i);
    if (fnColor) {
      color = normalizeColor(fnColor[0]);
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
      }
    }

    const lengths = rest.trim().split(/\s+/).map((t) => pxToNumber(t)).filter((n): n is number => n != null);
    if (!lengths.length && color == null) continue;

    layers.push({
      offsetX: lengths[0] ?? 0,
      offsetY: lengths[1] ?? 0,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color,
      inset,
    });
  }
  return layers;
}

// --- normalizeStyles --------------------------------------------------------

export function normalizeStyles(
  raw: RawComputedStyles,
  box: { width: number; height: number },
  textRaw?: RawComputedStyles | null,
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

  const radius = {
    topLeft: pxOrZero(raw["border-top-left-radius"]),
    topRight: pxOrZero(raw["border-top-right-radius"]),
    bottomRight: pxOrZero(raw["border-bottom-right-radius"]),
    bottomLeft: pxOrZero(raw["border-bottom-left-radius"]),
  };
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

  return {
    display: (raw["display"] ?? "").trim(),
    flexDirection: isFlex ? (raw["flex-direction"] ?? null) : null,
    alignItems: isFlex ? (raw["align-items"] ?? null) : null,
    justifyContent: isFlex ? (raw["justify-content"] ?? null) : null,
    gap: rowGap != null || columnGap != null ? { row: rowGap ?? 0, column: columnGap ?? 0 } : null,
    width: round2(box.width),
    height: round2(box.height),
    backgroundColor: normalizeColor(raw["background-color"]),
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
    letterSpacing: normalizeLetterSpacing(raw["letter-spacing"]),
    boxShadow: parseBoxShadow(raw["box-shadow"]),
    opacity: Number.isFinite(opacity) ? round2(opacity) : 1,
    text: textRaw
      ? {
          color: normalizeColor(textRaw["color"]),
          fontFamily: firstFontFamily(textRaw["font-family"]),
          fontSize: pxOrZero(textRaw["font-size"]),
          fontWeight: normalizeFontWeight(textRaw["font-weight"]),
        }
      : null,
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

// --- Base + delta encoding --------------------------------------------------

/**
 * Per-variant differences against a base. Most variants differ in two or three
 * properties, so emitting only those keeps the payload small and makes the
 * meaningful change obvious to whoever writes the Figma component.
 */
export type StyleDelta = Partial<NormalizedStyles>;

const STYLE_KEYS = [
  "display", "flexDirection", "alignItems", "justifyContent", "gap",
  "width", "height", "backgroundColor", "color", "border", "borderUniform",
  "borderRadius", "borderRadiusUniform", "padding", "fontFamily", "fontSize",
  "fontWeight", "lineHeight", "letterSpacing", "boxShadow", "opacity", "text",
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
    if (!sameValue(base[key], variant[key])) delta[key] = variant[key];
  }
  return delta as StyleDelta;
}

export function applyDelta(base: NormalizedStyles, delta: StyleDelta): NormalizedStyles {
  return { ...base, ...delta };
}
