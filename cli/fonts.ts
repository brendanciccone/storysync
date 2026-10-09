// The fonts Figma sets text in, and the stand-ins snap measures text with.
//
// Figma's plugin context loads only its own library, Google Fonts and a few
// more. A CSS keyword such as `system-ui` names no font, and a platform face
// such as Menlo or Segoe UI is not one Figma has, so the build sets such text
// in a stand-in: Roboto Mono for a monospace family, Noto Serif for a serif,
// Inter for anything else. snap used to measure that text in the browser's
// own face, SF Pro on a Mac, which Inter sets a few percent wider, up to 10%
// for a short word: a label measured to fit its box wrapped in Figma ("Hom"
// over "e"), and a title pushed what followed it out of its tile (the third
// live push). So snap draws such text in the stand-in itself before it
// measures, from the same font files Figma has, and the build asks Figma for
// the same stand-in. This module is the one place both read the mapping.
//
// The files are npm packages, so nothing is fetched while measuring:
// @fontsource-variable/inter pinned at 5.0.18, the last with Inter 3.19, the
// Inter Figma has (axes slnt and wght; the live text probe of 2026-10-09 set
// 35 of 35 strings exactly as wide as Chrome does with 5.0.18, rounded up to
// a pixel, and 13 of 35 with 5.3.0's Inter 4), and Roboto Mono and Noto Serif
// at 5.3.0, which the probe set as wide as Chrome does too. All three are
// under the SIL Open Font License, whose text ships in each package.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The families Figma sets text in where it lacks the one the code asked for. */
export type StandIn = "Inter" | "Roboto Mono" | "Noto Serif";

export const STAND_INS: readonly StandIn[] = ["Inter", "Roboto Mono", "Noto Serif"];

/**
 * The stand-in for a family Figma can't load: Roboto Mono for a monospace
 * one, Noto Serif for a serif, Inter for any other. The build template once
 * held these two patterns itself; figma code now passes it the answer.
 */
export function standInFor(family: string): StandIn {
  if (/mono|menlo|monaco|consolas|courier|lucida console/i.test(family)) return "Roboto Mono";
  if (/^(?!.*sans).*(serif|georgia|times)/i.test(family)) return "Noto Serif";
  return "Inter";
}

/** CSS's generic families, each resolving to whatever face the platform maps it to. */
export const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
]);

/**
 * A platform's name for its own UI font: Safari's `-apple-system`, Chrome's
 * old `BlinkMacSystemFont`, which Chromium computes to `"system-ui"`, and the
 * `ui-*` keywords only Safari implements. A system font stack lists several
 * so that each browser finds one, so one a browser passes over is not a font
 * that failed to load.
 */
export function isSystemFontAlias(family: string): boolean {
  const name = family.trim().toLowerCase();
  return name.startsWith("-") || name.startsWith("ui-") || name === "system-ui" || name === "blinkmacsystemfont";
}

/**
 * Whether a family is a CSS keyword rather than a font: a generic family or a
 * platform's alias for its UI font. No font in Figma has that name, so there
 * is nothing to set it to or compare it with.
 */
export function isFontKeyword(family: string | null | undefined): boolean {
  const name = (family ?? "").trim().toLowerCase();
  return GENERIC_FONT_FAMILIES.has(name) || isSystemFontAlias(name);
}

/**
 * Platform faces Figma's plugin context lacks, lowercased: each was asked of
 * listAvailableFontsAsync in the live text probe (2026-10-09) and wasn't
 * there. It has SF Pro, Roboto, Ubuntu, Cantarell and Noto Sans, which are
 * left alone, as is any font the project loads itself.
 */
export const PLATFORM_FACES: ReadonlySet<string> = new Set([
  "sf pro text", "sf pro display", "sf mono", "sfmono-regular", "san francisco", "segoe ui", "segoe ui variable",
  "helvetica neue", "helvetica", "arial", "menlo", "monaco", "consolas", "courier new", "courier",
  "liberation mono", "liberation sans", "lucida grande", "lucida console", "dejavu sans", "dejavu sans mono",
  "georgia", "times new roman", "times", "verdana", "tahoma", "trebuchet ms",
]);

/** Whether Figma would set text in this family in a stand-in: a CSS keyword, or a platform face it lacks. */
export function needsStandIn(family: string): boolean {
  return isFontKeyword(family) || PLATFORM_FACES.has(family.trim().toLowerCase());
}

/**
 * What snap names a stand-in in the page: its own family, so a project's
 * own Inter, should it load one, keeps its faces.
 */
export const STAND_IN_PREFIX = "storysync ";

/** The Figma family a family snap added to the page stands for, or null for any other family. */
export function standInDrawn(family: string): StandIn | null {
  if (!family.startsWith(STAND_IN_PREFIX)) return null;
  const name = family.slice(STAND_IN_PREFIX.length);
  return (STAND_INS as readonly string[]).includes(name) ? (name as StandIn) : null;
}

/** A computed font-family's families, unquoted, split at the commas outside quotes. */
export function stackFamilies(stack: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of stack) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

/**
 * The font-family snap draws an element's text with before measuring it,
 * where Figma would set it in a stand-in: the stand-in ahead of the stack as
 * written, so a glyph it lacks still falls back as before. That is a stack
 * whose first family is a CSS keyword or a platform face Figma lacks, as
 * Tailwind's `ui-sans-serif, system-ui, ...` and `ui-monospace, SFMono-Regular,
 * Menlo, ...` are. A stack that opens with a font the project loads, Geist or
 * Inter, keeps it, and so does one snap already put a stand-in in. Null where
 * the stack stays as it is.
 */
export function standInStack(stack: string): { stack: string; standIn: StandIn } | null {
  const [first] = stackFamilies(stack);
  if (!first || standInDrawn(first) || !needsStandIn(first)) return null;
  const standIn = standInFor(first);
  return { stack: `"${STAND_IN_PREFIX}${standIn}", ${stack}`, standIn };
}

/** One face of a stand-in, as the page adds it with the FontFace API. */
export interface StandInFace {
  family: string;
  style: string;
  weight: string;
  unicodeRange: string;
  /** The woff2 file, base64. */
  data: string;
}

/** Each stand-in's package and the stylesheets of its faces: the weight axis, upright and italic. */
const PACKAGES: Record<StandIn, { name: string; css: string[] }> = {
  Inter: { name: "@fontsource-variable/inter", css: ["wght.css"] },
  "Roboto Mono": { name: "@fontsource-variable/roboto-mono", css: ["wght.css", "wght-italic.css"] },
  "Noto Serif": { name: "@fontsource-variable/noto-serif", css: ["wght.css", "wght-italic.css"] },
};

const faces = new Map<StandIn, StandInFace[]>();

/**
 * A stand-in's faces, read once from its package: every unicode-range
 * subset, so text in Cyrillic or Greek is set in it too. Inter 3.19 has no
 * italic of its own (Figma's Inter Italic is its slant axis, as wide as its
 * upright), so Chrome slants the upright, which keeps the widths.
 */
export function standInFaces(standIn: StandIn): StandInFace[] {
  const known = faces.get(standIn);
  if (known) return known;
  const pkg = PACKAGES[standIn];
  const require = createRequire(import.meta.url);
  const out: StandInFace[] = [];
  for (const sheet of pkg.css) {
    const path = require.resolve(`${pkg.name}/${sheet}`);
    for (const block of readFileSync(path, "utf8").match(/@font-face\s*{[^}]*}/g) ?? []) {
      const get = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1].trim() ?? "";
      const file = /url\(([^)]+)\)/.exec(get("src"))?.[1];
      if (!file) continue;
      out.push({
        family: `${STAND_IN_PREFIX}${standIn}`, style: get("font-style") || "normal", weight: get("font-weight") || "400",
        unicodeRange: get("unicode-range") || "U+0-10FFFF", data: readFileSync(join(dirname(path), file)).toString("base64"),
      });
    }
  }
  if (!out.length) throw new Error(`${pkg.name} has no font faces in ${pkg.css.join(", ")}: reinstall storysync`);
  faces.set(standIn, out);
  return out;
}
