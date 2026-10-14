// Pure normalization for `storysync snap`.
//
// Everything here is browser-free so it can be unit tested without launching
// Chromium: the browser hands back raw `getComputedStyle` strings, and this
// module turns them into the normalized shape the Figma writer consumes.

import { colorToHex } from "./color.js";
import { isFontKeyword, isStandInFamily, standInDrawn } from "./fonts.js";

// Where they lived before the stand-ins needed them too.
export { isFontKeyword, isSystemFontAlias } from "./fonts.js";
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
   * The text's color as drawn: an `opacity` on the element holding the text,
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
  /**
   * How the browser fitted the text into its box, where it didn't sit on
   * one line at its own width: written only when it wrapped onto more
   * lines or was cut off, so a styles.json from before it was measured, and
   * every label on one line, reads and diffs as it did. A live push built
   * Attachment's vertical title, which `truncate` cuts off at the card's
   * width, as a text that hugged its 140px and ran 28px past a 120px card.
   */
  layout?: TextLayout;
}

/** See TextStyles.layout. */
export interface TextLayout {
  /** The width, in px, the text was laid out in: the content box of the block that holds it. */
  width: number;
  /** The lines it drew: 1 for a line cut off, and a line clamp's count for one it clamped. */
  lines: number;
  /**
   * How it was cut off, absent where it drew all of it: `ellipsis` for
   * `text-overflow: ellipsis`, as Tailwind's `truncate` sets, and for a line
   * clamp, as `line-clamp-2` sets; `clip` for text cut off flat at its box.
   */
  truncation?: "ellipsis" | "clip";
}

/**
 * What the page read of how the text fits its box, for normalizeStyles to
 * make a TextLayout of: the content width of the block that lays the text
 * out (the text's holder, or its nearest ancestor that isn't inline), the
 * lines the holder's own text runs over, whether that block's content runs
 * past it horizontally or vertically where its overflow hides it, its
 * `text-overflow`, and its line clamp, or null without one.
 */
export interface RawTextLayout {
  width: number;
  lines: number;
  overflowsX: boolean;
  overflowsY: boolean;
  textOverflow: string;
  lineClamp: number | null;
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
   * The computed `background-image`, its colors as hex: a gradient or image
   * painted over `backgroundColor`. A gradient button has a `backgroundColor`
   * of null and is still filled.
   *
   * Written only when there is one, so a styles.json from before it was
   * measured, or from components without one, reads and diffs as it did. A
   * variant whose base has one and it doesn't records null in its delta.
   */
  backgroundImage?: string | null;
  /**
   * The computed `background-clip` of the bottom background layer, which
   * clips `backgroundColor`: `padding-box` stops the fill at the border,
   * so a transparent or translucent border shows what is behind the element,
   * where `border-box`, CSS's initial value, paints the fill under it.
   *
   * Written only when it is not `border-box`, so a styles.json from before
   * it was measured, and every element that leaves it as it is, reads and
   * diffs as it did. A variant whose base has one and it doesn't records
   * null in its delta, which means `border-box`.
   */
  backgroundClip?: string | null;
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
  /**
   * The family the browser drew with, as resolveFontFamily picks it out of
   * the stack: the first that applied, past any other platform's alias for
   * its UI font. A named font that didn't load is kept, as what the code
   * asked for, with `fontAvailable` false. It can be a CSS keyword, such as
   * `system-ui` or `sans-serif`, which names no font Figma has.
   */
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
   * undetermined, or when `fontFamily` is a CSS keyword, which always
   * resolves to some face.
   *
   * A project naming a font it never loaded would otherwise measure and score
   * as though that font were used while rendering a fallback. Recording
   * availability keeps the substitution visible instead of silent.
   */
  fontAvailable: boolean | null;
}

/** The CSS longhands the browser side is asked to read. */
export const CAPTURED_PROPERTIES: readonly string[] = [
  "display", "flex-direction", "align-items", "justify-content",
  "row-gap", "column-gap",
  "background-color", "background-image", "background-clip", "color", "opacity",
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

/**
 * What snap-browser reads off a Storybook wrapper to decide whether to look
 * past it, and off the story's elements, and their ::before and ::after, to
 * decide whether anything in its root draws.
 */
export const WRAPPER_PROPERTIES: readonly string[] = [
  "display", "background-color", "background-image", "box-shadow",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "outline-style", "outline-width", "outline-color",
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
 * Chromium reports a color in the space it was written in, so Tailwind v4's
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
 * Whether a color has zero alpha. Read off the hex, since normalizeColor's
 * null can't tell a transparent color from one it couldn't read.
 */
export function isFullyTransparent(value: string | undefined): boolean {
  const hex = colorToHex(value ?? "");
  return hex != null && hex.length === 9 && hex.endsWith("00");
}

/** First family in a font stack, with quotes stripped. */
export function firstFontFamily(value: string | undefined): string {
  if (!value) return "";
  const first = (value.split(",")[0]?.trim() ?? "").replace(/^['"]|['"]$/g, "");
  // A stand-in snap drew (fonts.ts), by the name Figma has it under.
  return standInDrawn(first) ?? first;
}

// --- Fonts ------------------------------------------------------------------

/**
 * An element's computed font stack, with each family's quotes stripped, and
 * whether the browser drew with it, as snap-browser probed it in the page:
 * true when it applied, false when the browser passed over it, null when that
 * couldn't be told, as for a generic family, which always resolves to some face.
 */
export interface FontProbe {
  families: string[];
  applied: (boolean | null)[];
}

/**
 * The family snap records for an element, and whether the browser could
 * render it.
 *
 * `getComputedStyle` gives the stack as written, so its first family is what
 * the code asked for, not what was drawn. Tailwind v4's default stack opens
 * `-apple-system, BlinkMacSystemFont`, and Chrome implements neither name as
 * written: it skips the first and draws the second as `system-ui`. Recording
 * the first family put `-apple-system` on every component, with a warning
 * that it failed to load and a fontFamily drift no Figma font could clear.
 *
 * So aliases the browser passed over are skipped, and the first family it
 * drew with is recorded. A named font it passed over ahead of any alias or
 * keyword is kept, with `available: false`: it is what the code meant to
 * draw, and its absence is worth saying. Once the stack has named an alias
 * or keyword, it is a list of each platform's spelling of its own font, and
 * a named font missing there is one for another platform: Tailwind's mono
 * stack, `ui-monospace, SFMono-Regular, Menlo, ...`, draws Menlo in Chrome
 * on macOS, and SFMono-Regular, which Chrome there doesn't see, is not a font
 * the code failed to load. A keyword is available as null, since there is no
 * font to have been missing.
 *
 * Where snap drew the text in a stand-in (fonts.ts), the stand-in is what
 * was drawn, recorded by the name Figma has it under, and what the rest of
 * the stack would have drawn is `asked`.
 */
export function resolveFontFamily(probe: FontProbe): { family: string; available: boolean | null; asked?: string } {
  let platformList = false;
  for (const [index, family] of probe.families.entries()) {
    const applied = probe.applied[index] ?? null;
    // A stand-in snap put ahead of the stack (fonts.ts): the family Figma
    // sets the text in, drawn, and what the rest of the stack drew, asked.
    const drawn = standInDrawn(family);
    if (drawn) {
      if (applied === false) continue;
      // Past the stand-in's own families: Inter has two (fonts.ts).
      let after = index + 1;
      while (after < probe.families.length && isStandInFamily(probe.families[after])) after++;
      const rest = resolveFontFamily({ families: probe.families.slice(after), applied: probe.applied.slice(after) });
      return { family: drawn, available: true, asked: rest.family };
    }
    const keyword = isFontKeyword(family);
    if (applied === false && (keyword || platformList)) {
      platformList = true;
      continue;
    }
    if (applied === false) return { family, available: false };
    return { family, available: keyword ? null : applied };
  }
  // Nothing in the stack applied, so the browser's default font drew it.
  return { family: probe.families[0] ?? "", available: probe.families.length ? false : null };
}

export function normalizeFontWeight(value: string | undefined): number {
  const raw = (value ?? "").trim();
  const named: Record<string, number> = { normal: 400, bold: 700, lighter: 300, bolder: 700 };
  if (named[raw] != null) return named[raw];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 400;
}

export function normalizeLineHeight(value: string | undefined): number | "normal" {
  const raw = (value ?? "").trim();
  if (!raw || raw === "normal") return "normal";
  const px = pxToNumber(raw);
  if (px != null) return px;
  const n = Number(raw);
  return Number.isFinite(n) ? round2(n) : "normal";
}

/** Chromium keeps a percentage letter-spacing as written; it is a share of the font size. */
export function normalizeLetterSpacing(value: string | undefined, fontSize: number): number {
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
 * A hex color drawn at an opacity: its alpha multiplied by it, rounded as
 * formatHex rounds alpha, the byte dropped when opaque and the color null,
 * no fill, when nothing is left.
 */
function withOpacity(hex: string | null, opacity: number): string | null {
  if (hex == null || !Number.isFinite(opacity) || opacity >= 1) return hex;
  const alpha = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255;
  const scaled = Math.round(alpha * Math.max(0, opacity));
  if (scaled === 0) return null;
  return scaled >= 255 ? hex.slice(0, 7) : `${hex.slice(0, 7)}${scaled.toString(16).padStart(2, "0")}`;
}

/** A color function as Chromium serializes one, in any space. */
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\([^)]*\)/i;

/**
 * The clip of the bottom layer, the one that clips the background color,
 * or null for `border-box`: a value per background layer is listed top
 * first, so it is the last.
 */
function normalizeBackgroundClip(value: string | undefined): string | null {
  const clip = splitTopLevel((value ?? "").trim()).pop()?.trim() ?? "";
  return clip && clip !== "border-box" ? clip : null;
}

/**
 * A computed `background-image`, or null for none, with each color in its
 * gradients written as hex like every other color snap records: Tailwind
 * v4's `bg-linear-to-r` computes to `linear-gradient(to right, oklch(...) 0%,
 * oklch(...) 100%)`, Chromium dropping its default `in oklab`. A `url()`
 * layer is kept as written.
 */
export function normalizeBackgroundImage(value: string | undefined): string | null {
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
export function resolveRadii(
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
 * Its background is transparent by its color's alpha, in whatever space
 * Chromium writes it: Tailwind v4's `bg-black/0` computes to
 * `oklab(0 0 0 / 0)`, not `rgba(0, 0, 0, 0)`. A color that can't be read is
 * not taken for transparent, and nor is a background image, which is drawn
 * whatever the color beneath it.
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

// --- Choosing the element to measure ----------------------------------------

/**
 * Elements that never draw, so are never a story's component. input-otp
 * renders a `<noscript>` ahead of its input, and measuring the first child of
 * the story's root then found no layout box at all.
 */
export const NON_RENDERED_TAGS: readonly string[] = ["noscript", "script", "style", "template", "link", "meta", "title", "base"];

/** One element of a rendered story, as snap-browser reads it out of the page. */
export interface StoryNode {
  tag: string;
  /** `data-slot`, which shadcn/ui puts on each component's root element: `switch`, `dialog-trigger`. */
  slot: string | null;
  role: string | null;
  /** `aria-haspopup`, `aria-expanded` and `aria-controls`, as written. */
  hasPopup: string | null;
  expanded: string | null;
  controls: string | null;
  /** `data-state`, which Radix sets to `open` or `closed`. */
  state: string | null;
  /** Whether it carries `data-popup-open` or `data-open`, Base UI's mark of an open trigger. */
  open: boolean;
  /** Its `id`, which a trigger's `aria-controls` names; absent where it wasn't read. */
  id?: string | null;
  /** `dir`, `data-orientation` (else `aria-orientation`) and `aria-label` (else `aria-labelledby`), as written. */
  dir: string | null;
  orientation: string | null;
  label: string | null;
  /** The computed `position`. */
  position: string;
  /** Whether it is a toast, as Sonner marks one with `data-sonner-toast`; absent where it isn't, or wasn't read. */
  toast?: boolean;
  /** Whether it has a layout box: false for `display: none` and `display: contents`. */
  rendered: boolean;
  /**
   * Whether it holds text of its own, not only whitespace. Absent where it
   * wasn't read, which counts as text: see subtreeDraws.
   */
  text?: boolean;
  /**
   * Its ::before and ::after that have content, `none` and `normal` left
   * out: the content as computed (`""`, `"★"`, `url(...)`) and their
   * WRAPPER_PROPERTIES. Absent where none has, or they weren't read.
   */
  pseudos?: { content: string; styles: RawComputedStyles }[];
  /** WRAPPER_PROPERTIES, computed. */
  styles: RawComputedStyles;
  /**
   * Element children in DOM order, so a child's index here is its index among
   * the element's children. Cut short past a size limit, from the end.
   */
  children: StoryNode[];
}

/** An element outside the story's root that may be its content, rendered into a portal. */
export interface PortalNode {
  tag: string;
  slot: string | null;
  role: string | null;
  id: string | null;
  rendered: boolean;
  /** Whether it is an open overlay's content: OVERLAY_SELECTOR matches it, and no element around it. */
  overlay?: boolean;
}

/**
 * What an open overlay's content is, wherever it renders: a dialog, alert
 * dialog, tooltip, menu or select's listbox by its role; shadcn/ui's
 * `*-content` slot, as `popover-content`; and what Radix's popper places,
 * a popover's or a select's content without either. An overlay renders into a portal, a
 * child of the body outside the story's root (Base UI's in a
 * `data-base-ui-portal` holder).
 */
export const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="tooltip"], [role="menu"], [role="listbox"], [data-slot$="-content"], [data-radix-popper-content-wrapper] > *';

/**
 * Why the element snap measured may not be the component. A closed
 * trigger's `reason` says why snap didn't open it (see snap-browser.ts's
 * openOverlay); a snap from before it opened overlays has none.
 */
export type MeasurementNote =
  /** `toast`: for a toast's story, why snap couldn't raise one to measure (see chooseMeasuredElement). */
  | { kind: "layout-wrapper"; element: string; children: number; toast?: string }
  | { kind: "closed-trigger"; element: string; reason?: string };

/** How snap opens an overlay through its trigger, as a user would: see openInteractions. */
export type OpenInteraction = "click" | "hover" | "focus" | "contextmenu";

/**
 * How snap opened the overlay it measured, where the story rendered it
 * closed: recorded on the variant as `opened`.
 */
export interface OverlayOpened {
  /**
   * `arg`: snap set the story's `arg`, `open` or `defaultOpen`, to true
   * through Storybook's preview. Otherwise what it did to the trigger:
   * clicked it, hovered over it, focused it or right-clicked it.
   */
  via: "arg" | OpenInteraction;
  arg?: "open" | "defaultOpen";
  /** The trigger, as describeElement names it. */
  trigger: string;
}

/** One way snap tried to open an overlay, and what came of it, for describeOpenFailure. */
export interface OpenAttempt {
  via: "arg" | OpenInteraction;
  arg?: "open" | "defaultOpen";
  /**
   * `nothing`: nothing opened within `waitMs`. `no-content`: the trigger
   * said it was open, but snap found nothing it opened outside the
   * story's root. `closed`: it opened, and closed again as the pointer
   * left. `failed`: the attempt itself failed, as `error` says.
   */
  outcome: "nothing" | "no-content" | "closed" | "failed";
  waitMs?: number;
  error?: string;
}

const ATTEMPT_PHRASES: Record<OpenInteraction, string> = {
  click: "clicking it", hover: "hovering over it", focus: "focusing it", contextmenu: "right-clicking it",
};

/** One way snap tries to open an overlay, as a note says it: "clicking it". */
export function describeOpenWay(attempt: Pick<OpenAttempt, "via" | "arg">): string {
  return attempt.via === "arg" ? `setting its ${attempt.arg ?? "open"} arg through Storybook's preview` : ATTEMPT_PHRASES[attempt.via];
}

function listed(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Why snap couldn't open a closed trigger, from what it tried, in order:
 * the rest of a closed-trigger note. A run of attempts that opened nothing
 * in the same wait is said once, so the note is the same for every variant
 * it is the same for: "clicking it, hovering over it, focusing it and
 * right-clicking it opened nothing within 3000ms each".
 */
export function describeOpenFailure(attempts: readonly OpenAttempt[]): string {
  const parts: string[] = [];
  let run: OpenAttempt[] = [];
  const flush = () => {
    if (!run.length) return;
    const wait = run[0].waitMs;
    parts.push(`${listed(run.map(describeOpenWay))} opened nothing${wait !== undefined ? ` within ${wait}ms${run.length > 1 ? " each" : ""}` : ""}`);
    run = [];
  };
  for (const attempt of attempts) {
    if (attempt.outcome === "nothing") {
      if (run.length && run[0].waitMs !== attempt.waitMs) flush();
      run.push(attempt);
      continue;
    }
    flush();
    parts.push(attempt.outcome === "no-content"
      ? `${describeOpenWay(attempt)} opened it, but snap found nothing it opened to measure`
      : attempt.outcome === "closed"
        ? `${describeOpenWay(attempt)} opened it, but it closed again as the pointer left`
        : `${describeOpenWay(attempt)} failed${attempt.error ? ` (${attempt.error.replace(/[.\s]+$/, "")})` : ""}`);
  }
  flush();
  return parts.join("; ");
}

/**
 * A measured element snap may open before it measures: a closed trigger,
 * with the interactions to try in order, or a select or combobox `field`,
 * which is the component while closed and measured as it is when clicking
 * it opens nothing.
 */
export interface OpenableTrigger {
  field: boolean;
  interactions: OpenInteraction[];
  /**
   * For a toast's story: the element measured is the story's own, and
   * this, the button at `at` under the story's container, `opener` as
   * describeElement names it, raises the toast, which is measured instead.
   */
  toast?: { at: number[]; opener: string };
}

/**
 * A select's or combobox's field, open, under the story's root: measured
 * with the content it opened, as one (snap-browser.ts captureStory).
 */
export interface OpenField { path: number[]; element: string }

export type MeasuredChoice =
  /**
   * An element under the story's root, by its index at each level down
   * from the root's container. `content`: what an open trigger beside it
   * controls, rendered inline rather than into a portal.
   */
  | { kind: "tree"; path: number[]; element: string; notes: MeasurementNote[]; trigger?: OpenableTrigger; content?: true; field?: OpenField }
  /** One of the portal candidates, by index. */
  | { kind: "portal"; index: number; element: string; notes: MeasurementNote[]; field?: OpenField }
  | { kind: "none"; error: string };

/** How deep snap looks past wrappers that draw nothing, as it always has. */
const MAX_WRAPPER_DEPTH = 4;

/** Whether a component is a toast, by its slots: shadcn/ui's Sonner, whose component is `Toaster`. */
export function isToastComponent(slots: readonly string[]): boolean {
  return slots.some((slot) => /(?:^|-)(?:sonner|toasts?|toaster)(?:$|-)/.test(slot));
}

/** The first element at or under `node`, in document order, with a box that `wanted` takes. */
function findFirst(node: StoryNode, path: number[], wanted: (node: StoryNode) => boolean): { path: number[]; node: StoryNode } | null {
  for (const [index, child] of node.children.entries()) {
    if (child.rendered && wanted(child)) return { path: [...path, index], node: child };
    const found = findFirst(child, [...path, index], wanted);
    if (found) return found;
  }
  return null;
}

/**
 * The `data-slot` values a component's own root would carry: its name and its
 * title's last segment, kebab-cased, as shadcn/ui writes them (`InputOTP` is
 * `input-otp`, `ResizablePanelGroup` is `resizable-panel-group`).
 */
export function componentSlots(name: string, title?: string): string[] {
  const kebab = (value: string) => value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const leaf = title?.split("/").pop() ?? "";
  return [...new Set([kebab(name), kebab(leaf)].filter(Boolean))];
}

/**
 * The `data-slot` values of a component's content, which an overlay renders
 * outside the story's root while open: each of its own slots' `-content`
 * form, as an open Dialog's `dialog-content`, and a slot already ending in
 * `-content` as it is, as TooltipContent's `tooltip-content`.
 */
export function contentSlots(slots: readonly string[]): string[] {
  return [...new Set(slots.map((slot) => (slot.endsWith("-content") ? slot : `${slot}-content`)))];
}

/** `tag`, with its `data-slot` or else its `role`: how a measured element is named in styles.json and warnings. */
export function describeElement(node: { tag: string; slot: string | null; role: string | null }): string {
  if (node.slot) return `${node.tag}[data-slot="${node.slot}"]`;
  if (node.role) return `${node.tag}[role="${node.role}"]`;
  return node.tag;
}

function isNonRendered(node: StoryNode): boolean {
  return NON_RENDERED_TAGS.includes(node.tag);
}

function isDisplayContents(node: StoryNode): boolean {
  return (node.styles["display"] ?? "").trim() === "contents";
}

/** Children that take up space: what a reader would see as the element's parts. */
function drawnChildren(node: StoryNode): StoryNode[] {
  return node.children.filter((child) => !isNonRendered(child) && (child.rendered || isDisplayContents(child)));
}

/** Tags that draw by what they are, as a picture, a meter or an embedded page does, or as a form field does. */
const DRAWING_TAGS: readonly string[] = [
  "svg", "img", "canvas", "video", "input", "textarea", "select", "progress", "meter", "iframe", "object", "embed",
];

/**
 * Whether an element, or anything in it, draws: a fill, picture, shadow,
 * border or outline, text, a ::before or ::after that draws, or what an
 * `<svg>`, `<img>`, `<progress>` or form field is. Text the page didn't
 * read for counts, so this says no only where it knows.
 */
function subtreeDraws(node: StoryNode): boolean {
  if (isNonRendered(node) || (!node.rendered && !isDisplayContents(node))) return false;
  return node.text !== false || paints(node.styles) || DRAWING_TAGS.includes(node.tag) ||
    (node.pseudos ?? []).some(pseudoDraws) || node.children.some(subtreeDraws);
}

/** Whether an element paints its own box: drawsNothing's fill, picture, shadow or border, or an outline that shows. */
function paints(styles: RawComputedStyles): boolean {
  const outline = styles["outline-style"];
  return !drawsNothing(styles) ||
    (outline !== undefined && outline !== "none" && parseFloat(styles["outline-width"] ?? "") > 0 && !isFullyTransparent(styles["outline-color"]));
}

/** Whether a ::before or ::after draws: any content but an empty string, an icon font's glyph say, or a box that paints. */
function pseudoDraws(pseudo: { content: string; styles: RawComputedStyles }): boolean {
  if ((pseudo.styles["display"] ?? "").trim() === "none") return false;
  return pseudo.content !== '""' || paints(pseudo.styles);
}

/** Whether an element paints nothing itself: no fill, image, shadow or border, whatever its padding. */
function drawsNothing(styles: RawComputedStyles): boolean {
  return isFullyTransparent(styles["background-color"]) &&
    normalizeBackgroundImage(styles["background-image"]) == null &&
    parseBoxShadow(styles["box-shadow"]).length === 0 &&
    ["top", "right", "bottom", "left"].every((side) => parseFloat(styles[`border-${side}-width`] ?? "") === 0);
}

/**
 * Whether an element is the trigger of something it isn't showing: a
 * dialog, menu, popover or tooltip whose content renders only while it is
 * open, usually in a portal outside the story's root. Read off ARIA, which
 * any accessible trigger carries, and shadcn/ui's `*-trigger` slot, which
 * Base UI's tooltip and hover card triggers have nothing else to go by.
 *
 * A select or combobox is left out: closed, it is the field showing its
 * value, which is the component, and what it opens is the transient part.
 */
export function isClosedTrigger(node: StoryNode): boolean {
  return !isField(node) && isTrigger(node) && !isOpen(node);
}

/** A select's or combobox's field: what it opens is a listbox, and closed it is the component. */
function isField(node: StoryNode): boolean {
  return node.role === "combobox" || (node.hasPopup ?? "").trim().toLowerCase() === "listbox";
}

/** Whether an element bears a trigger's marks, open or closed: see isClosedTrigger. */
function isTrigger(node: StoryNode): boolean {
  const popup = (node.hasPopup ?? "").trim().toLowerCase();
  return (popup !== "" && popup !== "false") ||
    (node.slot?.endsWith("-trigger") ?? false) ||
    ((node.expanded === "false" || node.expanded === "true") && node.controls != null) ||
    ((node.state === "closed" || isOpenState(node.state)) && (node.tag === "button" || node.role === "button"));
}

/** Radix's `data-state` of something open: `open`, and a tooltip's `delayed-open` and `instant-open`. */
function isOpenState(state: string | null): boolean {
  return state === "open" || (state?.endsWith("-open") ?? false);
}

function isOpen(node: StoryNode): boolean {
  return node.expanded === "true" || isOpenState(node.state) || node.open;
}

/** All the ways snap opens a trigger, in the order it tries those its marks don't single out. */
const INTERACTIONS: readonly OpenInteraction[] = ["click", "hover", "focus", "contextmenu"];

/**
 * The ways snap tries to open a closed trigger, in order: first the one its
 * marks point to, then the rest in INTERACTIONS' order. A context menu's
 * trigger is right-clicked; a tooltip's or hover card's is hovered over,
 * known by its slot or the component's (`slots`), or as Radix marks one, a
 * `data-state` with no `aria-haspopup` or `aria-expanded`. Anything else is
 * clicked, as a dialog's, popover's, sheet's or menu's is. A select's or
 * combobox's field is clicked, and nothing else: it is the component, and
 * measured as it is when that opens nothing.
 */
export function openInteractions(node: StoryNode, slots: readonly string[] = []): OpenInteraction[] {
  if (isField(node)) return ["click"];
  const names = [node.slot ?? "", ...slots].map((name) => name.toLowerCase());
  const named = (...parts: string[]) => names.some((name) => parts.some((part) => name.includes(part)));
  const radixHover = node.state != null && node.hasPopup == null && node.expanded == null;
  const first: OpenInteraction = named("context-menu", "contextmenu")
    ? "contextmenu"
    : named("tooltip", "hover-card", "hovercard") || radixHover ? "hover" : "click";
  return [first, ...INTERACTIONS.filter((how) => how !== first)];
}

/**
 * The story's own top element: its container's first child that draws,
 * looking through `display: contents`. Falls back to the first child that
 * could, so a story rendering only hidden elements is still reported as
 * having no layout box.
 */
function findStoryRoot(container: StoryNode): { path: number[]; node: StoryNode } | null {
  let fallback: { path: number[]; node: StoryNode } | null = null;
  const visit = (node: StoryNode, path: number[]): { path: number[]; node: StoryNode } | null => {
    for (const [index, child] of node.children.entries()) {
      if (isNonRendered(child)) continue;
      const at = { path: [...path, index], node: child };
      if (child.rendered) return at;
      fallback ??= at;
      if (isDisplayContents(child)) {
        const inside = visit(child, at.path);
        if (inside) return inside;
      }
    }
    return null;
  };
  return visit(container, []) ?? fallback;
}

/**
 * The first element at or under `node`, in document order, whose `data-slot`
 * is one of the component's own and which is laid out in the flow. One taken
 * out of the flow is not what the story lays out: input-otp puts its slot on
 * a transparent `<input>` stretched over the boxes it draws.
 */
function findOwnSlot(node: StoryNode, path: number[], slots: readonly string[]): { path: number[]; node: StoryNode } | null {
  const position = node.position.trim();
  if (node.slot && slots.includes(node.slot) && node.rendered && position !== "absolute" && position !== "fixed") {
    return { path, node };
  }
  for (const [index, child] of node.children.entries()) {
    const found = findOwnSlot(child, [...path, index], slots);
    if (found) return found;
  }
  return null;
}

/**
 * findOwnSlot over each element the story renders at its top level, in
 * document order: a story that returns `<><Label /><Switch /></>` has the
 * switch second.
 */
function findOwnSlotInStory(container: StoryNode, slots: readonly string[]): { path: number[]; node: StoryNode } | null {
  for (const [index, child] of container.children.entries()) {
    if (isNonRendered(child)) continue;
    const found = findOwnSlot(child, [index], slots);
    if (found) return found;
  }
  return null;
}

/** The first element at or under `node`, in document order, that has a box and an id in `ids`. */
function findControlled(node: StoryNode, path: number[], ids: readonly string[]): { path: number[]; node: StoryNode } | null {
  for (const [index, child] of node.children.entries()) {
    if (child.id && ids.includes(child.id) && child.rendered) return { path: [...path, index], node: child };
    const found = findControlled(child, [...path, index], ids);
    if (found) return found;
  }
  return null;
}

/** Tags whose children are its own parts, as a list's items or a form's fields are, never a story's layout. */
const COMPONENT_ROOT_TAGS: readonly string[] = ["nav", "ol", "ul", "menu", "dl", "form", "fieldset", "table"];

/**
 * Whether an element bears a mark of a component's root, which a story's
 * layout `<div>` doesn't: a role, a direction or orientation, an accessible
 * label, or a tag that means a list, form or table. A RadioGroup, Tabs or
 * Accordion root draws nothing and holds several elements, as a layout row
 * does, and in a project without `data-slot` this is what tells them apart.
 */
export function hasComponentRootMarks(node: StoryNode): boolean {
  const role = (node.role ?? "").trim().toLowerCase();
  return (role !== "" && role !== "presentation" && role !== "none") ||
    Boolean(node.dir?.trim()) ||
    Boolean(node.orientation?.trim()) ||
    Boolean(node.label?.trim()) ||
    COMPONENT_ROOT_TAGS.includes(node.tag);
}

function hasOwnSlot(node: StoryNode, slots: readonly string[]): boolean {
  return (node.slot != null && slots.includes(node.slot)) || node.children.some((child) => hasOwnSlot(child, slots));
}

/**
 * Picks the element snap measures for a story, and says why it may not be
 * the component.
 *
 * In order:
 *
 *   1. The first element the story renders carrying the component's own
 *      `data-slot`, at any depth and after any sibling. shadcn/ui marks every
 *      component's root this way, so a Switch story that renders
 *      `<div class="flex gap-2"><Switch/><Label/></div>` measures the switch,
 *      not the row holding it and its label. Any project can point snap at a
 *      component's root the same way.
 *   2. Content rendered into a portal outside the story's root: an element
 *      with the component's own slot, or its `-content` slot, as an open
 *      Dialog's `dialog-content`.
 *   3. An open overlay's content in a portal (OVERLAY_SELECTOR), when nothing
 *      under the story's root draws: a story that renders a dialog open,
 *      with no trigger, shows nothing else.
 *   4. Otherwise, as snap always has, the root, past single-child wrappers
 *      that draw nothing. When that is an open trigger whose `aria-controls`
 *      names an element in a portal, or one rendered inline in the story,
 *      that element is measured instead; when it is a trigger open or
 *      closed, or an open select's field, an open overlay's content in a
 *      portal.
 *
 * What 4 settles on is flagged when it is a closed trigger, or holds several
 * elements while drawing nothing itself and bearing no mark of a component's
 * root, which is how a story's layout wrapper looks. Neither is certain, so
 * each is a note for a warning. A closed trigger, and a closed select's or
 * combobox's field, also come with `trigger`: how snap may open it, which
 * snap-browser.ts does before it measures (openOverlay), choosing again.
 */
export function chooseMeasuredElement(
  container: StoryNode | null,
  portals: readonly PortalNode[],
  slots: readonly string[],
): MeasuredChoice {
  const root = container ? findStoryRoot(container) : null;

  const owned = container ? findOwnSlotInStory(container, slots) : null;
  if (owned) return { kind: "tree", path: owned.path, element: describeElement(owned.node), notes: [] };

  const portal = (wanted: (candidate: PortalNode) => boolean): MeasuredChoice | null => {
    const index = portals.findIndex((candidate) => candidate.rendered && wanted(candidate));
    return index < 0 ? null : { kind: "portal", index, element: describeElement(portals[index]), notes: [] };
  };
  // A select's or combobox's field, open: what it opened is measured with
  // it, as the two render, where a dialog's or menu's content is alone.
  const field = (): OpenField | undefined => {
    const found = container ? findFirst(container, [], (n) => isField(n) && isOpen(n)) : null;
    return found ? { path: found.path, element: describeElement(found.node) } : undefined;
  };
  const withField = <T extends MeasuredChoice>(choice: T): T => {
    const open = field();
    return open ? { ...choice, field: open } : choice;
  };

  const portaled =
    portal((candidate) => candidate.slot != null && slots.includes(candidate.slot)) ??
    portal((candidate) => candidate.slot != null && contentSlots(slots).includes(candidate.slot));
  if (portaled) return withField(portaled);

  // A toast raised, where the story renders its toaster, as Sonner's does.
  const toast = container && isToastComponent(slots) ? findFirst(container, [], (node) => node.toast === true) : null;
  if (toast) return { kind: "tree", path: toast.path, element: describeElement(toast.node), notes: [], content: true };

  const overlay = () => portal((candidate) => candidate.overlay === true);
  const shown = container?.children.some(subtreeDraws) ?? false;
  const open = shown ? null : overlay();
  if (open) return open;

  if (!root) {
    return { kind: "none", error: "the story rendered no element that draws (only elements such as noscript, script or style, or none)" };
  }

  let { path, node } = root;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth++) {
    const children = drawnChildren(node);
    if (children.length !== 1 || !isPassThroughWrapper(node.styles)) break;
    path = [...path, node.children.indexOf(children[0])];
    node = children[0];
  }

  const controls = (node.controls ?? "").split(/\s+/).filter(Boolean);
  const opened = isOpen(node) ? portal((candidate) => candidate.id != null && controls.includes(candidate.id)) : null;
  if (opened) return isField(node) ? withField(opened) : opened;
  // Or rendered inline, beside the trigger, as Headless UI's menu is.
  const inline = isOpen(node) && container ? findControlled(container, [], controls) : null;
  if (inline) {
    const content: MeasuredChoice = { kind: "tree", path: inline.path, element: describeElement(inline.node), notes: [], content: true };
    return isField(node) ? withField(content) : content;
  }
  // An open trigger whose aria-controls names nothing, as a tooltip's or a
  // hover card's: what it opened is the overlay showing.
  const shownBy = isOpen(node) && (isTrigger(node) || isField(node)) ? overlay() : null;
  if (shownBy) return isField(node) ? withField(shownBy) : shownBy;

  const element = describeElement(node);
  const notes: MeasurementNote[] = [];
  // A toast's story, with no toast up: the story's button that raises one.
  const opener = container && isToastComponent(slots)
    ? findFirst(container, [], (n) => n.tag === "button" || n.role === "button")
    : null;
  if (opener) {
    const children = drawnChildren(node).length;
    if (children >= 2 && drawsNothing(node.styles) && !hasComponentRootMarks(node) && !hasOwnSlot(node, slots)) {
      notes.push({ kind: "layout-wrapper", element, children });
    }
    const toast = { at: opener.path, opener: describeElement(opener.node) };
    return { kind: "tree", path, element, notes, trigger: { field: false, interactions: ["click"], toast } };
  }
  if (isClosedTrigger(node)) {
    // Opened by something other than its trigger, as a story's `open` arg does.
    const content = overlay();
    if (content) return content;
    notes.push({ kind: "closed-trigger", element });
    return { kind: "tree", path, element, notes, trigger: { field: false, interactions: openInteractions(node, slots) } };
  }
  if (isField(node) && !isOpen(node)) {
    return { kind: "tree", path, element, notes, trigger: { field: true, interactions: openInteractions(node, slots) } };
  }
  {
    const children = drawnChildren(node).length;
    if (children >= 2 && drawsNothing(node.styles) && !hasComponentRootMarks(node) && !hasOwnSlot(node, slots)) {
      notes.push({ kind: "layout-wrapper", element, children });
    }
  }
  return { kind: "tree", path, element, notes };
}

// --- normalizeStyles --------------------------------------------------------

/**
 * Normalizes one element's raw computed styles.
 *
 * `fonts` carries what the page probed of the root's and the text's font
 * stacks, and with it each family is the one resolveFontFamily picks, and
 * `fontAvailable` its availability. Without it, as from a caller that never
 * probed, each is the stack's first family and `fontAvailable` as passed.
 */
export function normalizeStyles(
  raw: RawComputedStyles,
  box: { width: number; height: number },
  textRaw?: RawComputedStyles | null,
  fontAvailable: boolean | null = null,
  fonts?: { root?: FontProbe | null; text?: FontProbe | null },
  textLayout?: RawTextLayout | null,
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
  const backgroundClip = normalizeBackgroundClip(raw["background-clip"]);
  const rootFont = fonts?.root ? resolveFontFamily(fonts.root) : null;

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
    ...(backgroundClip != null ? { backgroundClip } : {}),
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
    fontFamily: rootFont?.family || firstFontFamily(raw["font-family"]),
    fontSize: pxOrZero(raw["font-size"]),
    fontWeight: normalizeFontWeight(raw["font-weight"]),
    lineHeight: normalizeLineHeight(raw["line-height"]),
    letterSpacing: normalizeLetterSpacing(raw["letter-spacing"], pxOrZero(raw["font-size"])),
    boxShadow: parseBoxShadow(raw["box-shadow"]),
    opacity: Number.isFinite(opacity) ? round2(opacity) : 1,
    boxSizing: (raw["box-sizing"] ?? "content-box").trim(),
    fontAvailable: rootFont ? rootFont.available : fontAvailable,
    text: textRaw ? normalizeText(textRaw, fonts?.text, textLayout) : null,
  };
}

function normalizeText(textRaw: RawComputedStyles, font?: FontProbe | null, raw?: RawTextLayout | null): TextStyles {
  const textTransform = (textRaw["text-transform"] ?? "").trim() || "none";
  const letterSpacing = normalizeLetterSpacing(textRaw["letter-spacing"], pxOrZero(textRaw["font-size"]));
  const layout = normalizeTextLayout(raw);
  return {
    color: withOpacity(normalizeColor(textRaw["color"]), Number(textRaw["opacity"] ?? 1)),
    fontFamily: (font ? resolveFontFamily(font).family : "") || firstFontFamily(textRaw["font-family"]),
    fontSize: pxOrZero(textRaw["font-size"]),
    fontWeight: normalizeFontWeight(textRaw["font-weight"]),
    ...(textTransform !== "none" ? { textTransform } : {}),
    ...(letterSpacing !== 0 ? { letterSpacing } : {}),
    ...(layout ? { layout } : {}),
  };
}

/**
 * How the text fits its box, or null where it sits on one line at its own
 * width, which a Figma text that hugs its content reproduces. A line clamp
 * that cut the text off draws its count of lines, ending in an ellipsis; a
 * line cut off at the side ends in one where `text-overflow` says so, and
 * flat otherwise; text that wraps draws all its lines at its box's width.
 */
export function normalizeTextLayout(raw?: RawTextLayout | null): TextLayout | null {
  if (!raw || !Number.isFinite(raw.width) || raw.width <= 0) return null;
  const width = round2(raw.width);
  if (raw.lineClamp && raw.lineClamp > 0 && raw.overflowsY) return { width, lines: raw.lineClamp, truncation: "ellipsis" };
  if (raw.overflowsX) {
    return { width, lines: Math.max(1, raw.lines), truncation: raw.textOverflow.trim() === "ellipsis" ? "ellipsis" : "clip" };
  }
  return raw.lines > 1 ? { width, lines: raw.lines } : null;
}

// --- Storybook args encoding ------------------------------------------------

/**
 * Storybook's own allowed charset for URL arg keys and values, from its
 * router: `VALIDATION_REGEXP = /^[a-zA-Z0-9 _-]*$/`. Anything outside it is
 * dropped *silently*, and the story then renders with its default args — so a
 * value we can't encode must be set another way (snap sets it through
 * Storybook's preview: see snap-args.ts) or reported rather than measured, or
 * we'd record the default render as though it were that variant.
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
  /** The names of those pairs, left out of `param`. */
  unsupportedNames: string[];
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
  const unsupportedNames: string[] = [];

  for (const [name, value] of Object.entries(combo)) {
    if (!isEncodableArgValue(name)) {
      unsupported.push(`${name}=${value}`);
      unsupportedNames.push(name);
      continue;
    }

    if (byName.get(name)?.type === "BOOLEAN") {
      pairs.push(`${name}:${value === "true" ? "!true" : "!false"}`);
      continue;
    }

    if (!isEncodableArgValue(value)) {
      unsupported.push(`${name}=${value}`);
      unsupportedNames.push(name);
      continue;
    }
    pairs.push(`${name}:${value}`);
  }

  return { param: pairs.length ? pairs.join(";") : null, unsupported, unsupportedNames };
}

/**
 * Builds a story iframe URL. The whole query is assembled with
 * `URLSearchParams`, which percent-encodes spaces as `+` — verified to
 * round-trip through Storybook's arg parser.
 */
export function buildStoryUrl(baseUrl: string, storyId: string, argsParam: string | null, globalsParam?: string | null): string {
  const base = baseUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({ id: storyId, viewMode: "story" });
  if (argsParam) query.set("args", argsParam);
  // Storybook's globals, in the same form: `theme:light`, as snap sets for the light scheme (snap-scheme.ts).
  if (globalsParam) query.set("globals", globalsParam);
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
  "width", "height", "backgroundColor", "backgroundImage", "backgroundClip", "color", "border", "borderUniform",
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
