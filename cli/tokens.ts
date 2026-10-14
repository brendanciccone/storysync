// Design token extraction from project source files.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { colorToHex } from "./color.js";

/** The token sources `--source` takes. Leaving it out, or `auto`, detects one. */
export const TOKEN_SOURCES = ["tailwind", "css", "theme"] as const;

export type TokenSourceType = (typeof TOKEN_SOURCES)[number];

export type TokenCategory = "colors" | "spacing" | "typography" | "radius" | "shadows";

export interface TokenValue {
  name: string;
  /** As the source writes it. `tokens --check` compares this. */
  value: string;
  /**
   * A color token's value as sRGB hex, `#rrggbb` or `#rrggbbaa`, for the
   * push: figma.util.rgb() and rgba() take only hex, rgb(), hsl() and lab(),
   * so a token in oklch() or bare HSL channels threw. Absent when the value
   * is no color storysync can convert, and on every other category.
   */
  hex?: string;
  /**
   * A radius, spacing or typography token's value in px, for the push's
   * FLOAT variables and for diff: rem is 16px, and calc() is worked out, so
   * shadcn/ui's `calc(0.625rem - 4px)` is 6. The agent did that arithmetic
   * itself, and diff compared `calc(...)` with Figma's 6 as text, a mismatch
   * every time. Absent when the value is no fixed length: em and % depend on
   * the element, and a weight or a line-height ratio is no length at all.
   * Like `hex`, `tokens --check` never compares it.
   */
  px?: number;
  group?: string;
  /**
   * The dark theme's value, where the project's stylesheets set one that
   * differs from this: in `.dark`, `[data-theme="dark"]` and the like, or a
   * `:root` in `@media (prefers-color-scheme: dark)`. Read as the light value
   * is, with the dark theme's variables over `:root`'s, so shadcn/ui's
   * `background`, `hsl(var(--background))` in a v3 config or `var(--background)`
   * in v4's `@theme inline`, gets `.dark`'s `--background`. The push makes it
   * the variable's Dark mode; where a token has none, its Dark mode is its
   * light value, as in the browser, where `.dark` leaves it as `:root` sets it.
   */
  dark?: TokenModeValue;
}

/** A token's value in a mode other than the default, with its `hex` or `px` as the default's has them. */
export interface TokenModeValue {
  value: string;
  hex?: string;
  px?: number;
}

export interface TokenCollection {
  category: TokenCategory;
  tokens: TokenValue[];
}

export interface TokenExtractionResult {
  source: TokenSourceType;
  sourcePath: string;
  collections: TokenCollection[];
  warnings: string[];
  /**
   * The Figma variable modes the tokens fill, as the skill names them:
   * `["Light", "Dark"]` when a token has a `dark` value, else `["Default"]`
   * (`["Light"]` in a baseline an earlier build wrote). extractTokens
   * always sets it, so a baseline that has it, either way, was written by a
   * storysync that reads the dark theme, and `--check` compares dark values
   * only against one that has.
   */
  modes?: string[];
  /**
   * The color tokens the project's base styles give an element no class
   * colors (baseDefaults): absent when they give none a token names.
   * `figma code` binds a value several tokens share by them, and `--check`
   * doesn't compare them.
   */
  defaults?: BaseDefault[];
}

/**
 * A color the project's base styles set for every element, as shadcn/ui's
 * `@layer base { * { @apply border-border } body { @apply text-foreground } }`
 * does: a text inherits `color` from `body`, and a border takes its color
 * from `*`, with no class on the element to say so.
 */
export interface BaseDefault {
  property: "color" | "border-color" | "outline-color";
  /** The color token it is, by name. */
  token: string;
  /** The rule that sets it, as written, after its file: `app/globals.css, @layer base: body { @apply text-foreground }`. */
  from: string;
}

/**
 * Reads `--source`, as tokens and diff take it: one of TOKEN_SOURCES, or
 * undefined when it was left out or is `auto`, for the source to be
 * detected. `auto` is the drift-check action's token_source default, which
 * docs/reference.md has action users pass on to `tokens --source` for their
 * baseline. Anything else throws, naming the sources there are.
 * extractTokens has no case for it and detects a source instead, so
 * `--source scss` read whatever the project had first, a Tailwind config
 * say, and exited 0 as though it had read what was asked for.
 */
export function parseTokenSource(value: string | undefined): TokenSourceType | undefined {
  if (value === undefined || value === "auto") return undefined;
  const source = TOKEN_SOURCES.find((s) => s === value);
  if (!source) {
    const names = TOKEN_SOURCES.map((s) => `"${s}"`);
    throw new Error(
      `--source must be ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}, received "${value}". ` +
      "Leave it out, or pass \"auto\", to detect the source.",
    );
  }
  return source;
}

// --- Detection ---

interface DetectedSource {
  type: TokenSourceType;
  path: string;
}

/** The names of a Tailwind config storysync has always read, in the order that decides between two. */
const TAILWIND_CONFIGS = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];

/**
 * The names Tailwind v3 also finds a config by, which storysync missed, so
 * edu-design-system's tailwind.config.mts was never read. `--source
 * tailwind` reads one; detection comes to one only after every source an
 * earlier version found, so a project that has one keeps the source, and
 * the baseline, it had.
 */
const LATE_TAILWIND_CONFIGS = ["tailwind.config.mts", "tailwind.config.cts"];

function findTailwindConfig(projectPath: string, names = [...TAILWIND_CONFIGS, ...LATE_TAILWIND_CONFIGS]): string | null {
  for (const name of names) {
    const p = join(projectPath, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * A Tailwind config comes first, then `:root` custom properties, then a
 * Tailwind v4 `@theme` block. `:root` stays ahead of `@theme` so a v4 project
 * that has both, as shadcn/ui's v4 globals.css does, keeps the tokens, names
 * and baselines it had before `@theme` was read; `@theme` is for a CSS-first
 * project that declares its palette nowhere else.
 *
 * What earlier versions didn't find comes after all of these, so a project
 * keeps the source, and the baseline, it had: a `tailwind.config.mts` or
 * `.cts`, then a stylesheet that sets its variables only in a selector list,
 * as `:root, .light { }`, with no `:root {` of its own.
 */
export function detectTokenSource(projectPath: string): DetectedSource | null {
  const config = findTailwindConfig(projectPath, TAILWIND_CONFIGS);
  if (config) return { type: "tailwind", path: config };

  const cssFiles = findCSSWithCustomProperties(projectPath);
  const plainRoot = cssFiles.find((file) => {
    try { return /:root\s*\{/.test(readCss(file)); } catch { return false; }
  });
  if (plainRoot) return { type: "css", path: cssFiles[0] };

  const themeCss = findTailwindThemeCSS(projectPath);
  if (themeCss.length) return { type: "tailwind", path: themeCss[0] };

  const themeFile = findThemeFile(projectPath);
  if (themeFile) return { type: "theme", path: themeFile };

  const lateConfig = findTailwindConfig(projectPath, LATE_TAILWIND_CONFIGS);
  if (lateConfig) return { type: "tailwind", path: lateConfig };

  if (cssFiles.length) return { type: "css", path: cssFiles[0] };

  return null;
}

/** Stylesheets that declare a custom property for the default theme, as rootDeclarations reads it. */
function findCSSWithCustomProperties(projectPath: string): string[] {
  return findCSS(projectPath, (css, file) => rootDeclarations(css, isBundled(file)).length > 0);
}

/**
 * Whether a stylesheet bundles other packages' styles rather than being
 * the project's own: a minified `.min.css`, as a vendored Bootstrap is.
 * Its selector lists, as Bootstrap's `:root, [data-bs-theme=light]` and
 * Radix Colors' `:root, .light, .light-theme`, hold no project tokens, and
 * no earlier version read them, so they aren't read there: read, they
 * added a package's palette to a project's tokens. A Storybook build in
 * storybook-static/ bundles them too, but walkCSS skips that folder.
 */
function isBundled(file: string): boolean {
  return file.endsWith(".min.css");
}

/** Stylesheets with a Tailwind v4 `@theme` block that declares a variable. */
function findTailwindThemeCSS(projectPath: string): string[] {
  return findCSS(projectPath, (css) => readThemeBlocks(css).some((block) => readDeclarations(block).length > 0));
}

/** The project's stylesheets, CSS modules aside, whose text without comments passes `test`. */
function findCSS(projectPath: string, test: (css: string, file: string) => boolean): string[] {
  const results: string[] = [];
  const srcDir = join(projectPath, "src");
  const appDir = join(projectPath, "app");
  const stylesDir = join(projectPath, "styles");

  for (const dir of [srcDir, appDir, stylesDir, projectPath]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    walkCSS(dir, results, test, 0);
  }
  return results;
}

/**
 * Directories of installed or built files, not the project's own
 * stylesheets: `storybook build` writes its compiled CSS, every Tailwind
 * utility of the stories included, to storybook-static, Next's static export
 * to out, and a coverage report its own CSS to coverage.
 */
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".next", "build", "storybook-static", "out", "coverage"]);

function walkCSS(dir: string, results: string[], test: (css: string, file: string) => boolean, depth: number): void {
  if (depth > 5) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walkCSS(full, results, test, depth + 1);
    } else if (entry.endsWith(".css") && !entry.endsWith(".module.css")) {
      try {
        if (test(readCss(full), full)) results.push(full);
      } catch { /* skip unreadable */ }
    }
  }
}

const THEME_FILE_NAMES = [
  "tokens.ts", "tokens.js", "theme.ts", "theme.js",
  "design-tokens.ts", "design-tokens.js",
  "tokens/index.ts", "tokens/index.js",
  "theme/index.ts", "theme/index.js",
];

function findThemeFile(projectPath: string): string | null {
  for (const dir of ["src", "lib", "."]) {
    for (const name of THEME_FILE_NAMES) {
      const p = join(projectPath, dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Source with its comments taken out, so a commented-out key or custom
 * property isn't read as a token: `// primary: "#ff0000"` above the real
 * `primary` became a second primary, which made `tokens --check` drift
 * against a baseline taken from the same config, and a commented-out block
 * of colors was read in place of the real ones.
 *
 * Quotes are tracked, so the `/*` in a content glob or the `//` in a URL
 * survives when it is in a string. `lineComments` is false for CSS, which
 * has only block comments: there `//` can start an unquoted `url(//cdn...)`,
 * and a backslash escapes the character after it, so the `'` in Tailwind's
 * `.after\:content-\[\'\'\]` starts no string that keeps the
 * comments after it.
 */
function stripComments(src: string, lineComments = true): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === "\\") out += src[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === "\\" && !lineComments) {
      out += ch + (src[++i] ?? "");
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "/" && src[i + 1] === "/" && lineComments) {
      // The newline stays: it ends a value as a comma does.
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

/** A stylesheet's text without its comments. */
function readCss(file: string): string {
  return stripComments(readFileSync(file, "utf8"), false);
}

// --- Main extraction ---

/**
 * An extraction, with the custom properties a var() left in a value resolves
 * against, when the source has any.
 */
interface Extraction extends TokenExtractionResult {
  vars?: Map<string, string>;
  /**
   * The same variables as written, before a var() in them was resolved, to
   * say why one didn't: in `vars`, a loop of two reads as each set to itself.
   */
  written?: Map<string, string>;
  /** Where `vars` are read from, for that warning: `:root` unless said. */
  varsFrom?: string;
}

/** The categories whose tokens are lengths, and get a `px`. */
const LENGTH_CATEGORIES: ReadonlySet<TokenCategory> = new Set(["radius", "spacing", "typography"]);

export function extractTokens(projectPath: string, sourceType?: TokenSourceType): TokenExtractionResult {
  const { vars, written, varsFrom, ...result } = extractFromSource(projectPath, sourceType);
  // Where the tokens came through the stylesheets' variables, they are read
  // again with the dark theme's variables over :root's, for each token's
  // dark value. Only the light theme's were read, with a warning, so the
  // push made one mode and an audit's "39 matched" covered half the colors.
  const darkFiles = vars && varsFrom !== "the theme file" ? findDarkCSS(projectPath) : [];
  const dark = darkFiles.length ? extractFromSource(projectPath, sourceType, darkFiles) : null;
  const darkTokens = dark ? tokensByCategory(dark.collections) : null;
  for (const collection of result.collections) {
    collection.tokens = collection.tokens.map((token) => {
      // `value` stays as the source writes it, for --check. CSS custom
      // properties resolve a var() only when it is the whole value, so
      // `calc(var(--radius) - 4px)` is resolved here, for hex and px alone.
      const resolved = vars ? resolveTailwindCssRefs(token.value, vars) : token.value;
      const unresolved = unresolvedRefs(resolved, written ?? vars, varsFrom ?? ":root", token.value);
      if (unresolved) result.warnings.push(`Unresolved: ${collection.category} ${token.name} = ${token.value} (${unresolved})`);
      const out: TokenValue = { ...token, ...workedOut(collection.category, resolved) };
      const other = darkTokens?.get(collection.category)?.get(token.name);
      if (other) {
        const darkResolved = dark?.vars ? resolveTailwindCssRefs(other.value, dark.vars) : other.value;
        if (darkResolved !== resolved) out.dark = { value: other.value, ...workedOut(collection.category, darkResolved) };
      }
      return out;
    });
  }
  result.collections = withoutRepeatedDefault(result.collections);
  const hasDark = result.collections.some((c) => c.tokens.some((t) => t.dark));
  const colors = result.collections.filter((c) => c.category === "colors").flatMap((c) => c.tokens.map((t) => t.name));
  const defaults = colors.length ? baseDefaults(projectPath, colors) : [];
  return { ...result, modes: hasDark ? ["Light", "Dark"] : ["Default"], ...(defaults.length ? { defaults } : {}) };
}

/**
 * The collections less a radius `DEFAULT` that only repeats another radius
 * step, in every mode. shadcn/ui's `:root` holds `--radius`, read as radius
 * `DEFAULT`, and its `@theme inline` sets `--radius-lg: var(--radius)`: the
 * push made two variables of one value, and a 10px corner, bound by value
 * alone, matched both and stayed unbound. A baseline or a Figma file from
 * before still has it: `--check` and diff read theirs through this too.
 */
export function withoutRepeatedDefault<T extends Pick<TokenCollection, "category" | "tokens">>(collections: T[]): T[] {
  const radii = collections.filter((c) => c.category === "radius").flatMap((c) => c.tokens);
  const length = (v: { value: string; px?: number } | undefined) => (v === undefined ? undefined : v.px ?? lengthToPx(v.value) ?? v.value.trim());
  const repeats = (a: TokenValue, b: TokenValue) => length(a) === length(b) && length(a.dark) === length(b.dark);
  const repeated = (t: TokenValue) => t.name === "DEFAULT" && radii.some((other) => other.name !== "DEFAULT" && repeats(t, other));
  if (!radii.some(repeated)) return collections;
  return collections.map((c) => (c.category === "radius" ? { ...c, tokens: c.tokens.filter((t) => !repeated(t)) } : c));
}

/** The class form of a token's name, as Tailwind writes it in a utility: `card/foreground` is `card-foreground`, and a `DEFAULT` key is unnamed, so `primary/DEFAULT` is `primary`. */
export function tokenClassName(name: string): string {
  return name.toLowerCase().replace(/\/default$/, "").replace(/\//g, "-");
}

// --- Base styles ---

/**
 * How near an element a selector in a list sets its color, or Infinity: `*`
 * sets it on the element itself, and `body` hands it down nearer than the
 * root does.
 */
function colorRank(selector: string): number {
  if (selector === "*") return 0;
  if (/^body$/i.test(selector)) return 1;
  if (ROOT_SELECTOR.test(selector) || /^:host$/i.test(selector)) return 2;
  return /^html$/i.test(selector) ? 3 : Infinity;
}

/** The utilities and properties that set each default, and how a utility names its token. */
const DEFAULT_UTILITIES: [RegExp, BaseDefault["property"]][] = [[/^text-(.+)$/, "color"], [/^border-(.+)$/, "border-color"], [/^outline-(.+)$/, "outline-color"]];
const DEFAULT_PROPERTIES: Record<string, BaseDefault["property"]> = {
  color: "color", "border-color": "border-color", border: "border-color", "outline-color": "outline-color", outline: "outline-color",
};

/**
 * The color tokens the project's base styles set for every element: `color`
 * from a `*`, `body` or root rule, which a text inherits where no class
 * colors it nearer, and `border-color` and `outline-color` from a `*` rule.
 * Rules in `@layer base` or in no layer count, in the stylesheets of the
 * project, by `@apply text-foreground` or `color: var(--foreground)`. A
 * later rule wins one as near, and a value no token names (`color: red`,
 * or the `border: 0 solid` that resets it) ends what an earlier one set. A
 * property the stylesheets set to different tokens is left out, as is one
 * they set to none: shadcn/ui's `#0a0a0a` is four tokens, and a guess among
 * them would be wrong in Dark mode.
 */
export function baseDefaults(projectPath: string, colorNames: string[]): BaseDefault[] {
  const byClass = new Map(colorNames.map((name) => [tokenClassName(name), name]));
  const tokenOf = (value: string): string | null => {
    const ref = /var\(\s*--([\w-]+)/.exec(value)?.[1] ?? /theme\(\s*['"]?(?:colors\.|--color-)([\w.-]+)/.exec(value)?.[1]?.replace(/\./g, "-");
    if (!ref) return null;
    return byClass.get(ref.toLowerCase()) ?? byClass.get(ref.toLowerCase().replace(/^colors?-/, "")) ?? null;
  };
  const found = new Map<BaseDefault["property"], { tokens: Set<string>; first?: BaseDefault }>();
  for (const file of findCSS(projectPath, (css) => /@apply|color|border|outline/.test(css))) {
    // Per file, what each property is, nearest selector first, later rules winning.
    const set = new Map<BaseDefault["property"], { rank: number; token: string | null; from: string }>();
    const rules = styleRules(readCss(file)).filter((rule) => !rule.nested && rule.atRules.every((at) => /^@layer\s+base$/i.test(at)));
    // Unlayered rules override the base layer's, whatever their order.
    for (const rule of [...rules.filter((r) => r.atRules.length), ...rules.filter((r) => !r.atRules.length)]) {
      const selectors = splitTopLevel(rule.selector, ",").map((s) => s.trim());
      const nearest = Math.min(...selectors.map(colorRank));
      const universal = selectors.includes("*");
      if (nearest === Infinity) continue;
      const where = `${relative(projectPath, file).split("\\").join("/")}${rule.atRules.length ? `, ${rule.atRules.join(" ")}` : ""}`;
      const put = (property: BaseDefault["property"], token: string | null, declaration: string) => {
        const rank = property === "color" ? nearest : universal ? 0 : Infinity;
        if (rank === Infinity) return;
        const was = set.get(property);
        if (was && was.rank < rank) return;
        set.set(property, { rank, token, from: `${where}: ${rule.selector.trim()} { ${declaration} }` });
      };
      for (const raw of splitTopLevel(rule.declarations, ";")) {
        const declaration = raw.trim().replace(/\s+/g, " ");
        if (declaration.startsWith("@apply ")) {
          for (const utility of declaration.slice(7).split(" ")) {
            // A variant applies it only sometimes (`dark:`, `hover:`).
            if (!utility || utility.includes(":") || utility === "!important") continue;
            const name = utility.replace(/^!|!$/g, "").replace(/\/[^/]*$/, "");
            for (const [re, property] of DEFAULT_UTILITIES) {
              const token = byClass.get(re.exec(name)?.[1] ?? "");
              if (token) put(property, token, declaration);
            }
          }
          continue;
        }
        const colon = declaration.indexOf(":");
        const property = DEFAULT_PROPERTIES[declaration.slice(0, colon).trim().toLowerCase()];
        if (colon > 0 && property) put(property, tokenOf(declaration.slice(colon + 1)), declaration);
      }
    }
    for (const [property, { token, from }] of set) {
      const entry = found.get(property) ?? { tokens: new Set<string>() };
      entry.tokens.add(token ?? "");
      if (token && !entry.first) entry.first = { property, token, from };
      found.set(property, entry);
    }
  }
  return [...found.values()].filter((e) => e.tokens.size === 1 && e.first).map((e) => e.first!);
}

/** A resolved value's `hex`, for a color, or `px`, for a length, when it has one. */
function workedOut(category: TokenCategory, resolved: string): { hex?: string; px?: number } {
  if (category === "colors") {
    const hex = tokenColorToHex(resolved);
    return hex ? { hex } : {};
  }
  if (LENGTH_CATEGORIES.has(category)) {
    const px = lengthToPx(resolved);
    return px === null ? {} : { px };
  }
  return {};
}

/**
 * Why a value still holds a var() after resolution, naming each variable,
 * or null when it holds none. Nothing flagged one before: the push took
 * `var(--font-sans)` for a font family, and diff compared it with Figma's
 * as text. A variable set nowhere storysync reads may be set at runtime, as
 * next/font sets `--font-geist-mono`; one set only in terms of itself, as
 * shadcn/ui's `@theme inline { --font-sans: var(--font-sans) }`, can't
 * resolve from a stylesheet either. `written` holds the variables as
 * written, `where` says where they were read from, and `original` is the
 * value before resolution: when a var()'s fallback is a var() that didn't
 * resolve either, only the fallback's is left, so those it names that
 * aren't set are named too.
 */
function unresolvedRefs(value: string, written: Map<string, string> | undefined, where: string, original = value): string | null {
  const left = varRefs(value);
  if (!left.length) return null;
  const unset = varRefs(original).filter((name) => !written?.has(name));
  return [...new Set([...unset, ...left])].map((name) => whyUnresolved(name, written, where)).join("; ");
}

/** The custom properties a value's var()s name, a fallback's included. */
function varRefs(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
}

/**
 * Why a variable left in a resolved value didn't resolve. Resolution goes
 * as deep as it can, so one that is set is in a loop, or past what it
 * follows: eight var()s deep.
 */
function whyUnresolved(name: string, written: Map<string, string> | undefined, where: string): string {
  const value = written?.get(name);
  if (value === undefined) return `${name} isn't set in ${where}`;
  if (value.trim() === `var(${name})`) return `${name} is set only in terms of itself`;
  if (varRefs(value).includes(name)) return `${name} is set in terms of itself`;
  const seen = new Set<string>();
  const next = varRefs(value);
  while (next.length) {
    const ref = next.pop()!;
    if (ref === name) return `${name} is in a loop of var() references`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    next.push(...varRefs(written?.get(ref) ?? ""));
  }
  return `${name} is set through var()s nested deeper than storysync follows`;
}

/**
 * The extraction of `sourceType`, or of the source detected. With
 * `darkFiles`, the stylesheets that set a dark theme, it is read with their
 * dark theme's variables over :root's, for the dark values.
 */
function extractFromSource(projectPath: string, sourceType?: TokenSourceType, darkFiles?: string[]): Extraction {
  if (sourceType) {
    switch (sourceType) {
      case "tailwind": {
        const config = findTailwindConfig(projectPath);
        if (config) return extractFromTailwind(config, projectPath, darkFiles);
        const themeCss = findTailwindThemeCSS(projectPath);
        if (themeCss.length) return extractFromTailwindTheme(themeCss, projectPath, darkFiles);
        return { source: "tailwind", sourcePath: "", collections: [], warnings: ["No tailwind.config or CSS @theme block found"] };
      }
      case "css": {
        const files = findCSSWithCustomProperties(projectPath);
        if (files.length) return extractFromCSS(files, projectPath, darkFiles);
        return { source: "css", sourcePath: "", collections: [], warnings: ["No CSS files with custom properties found"] };
      }
      case "theme": {
        const f = findThemeFile(projectPath);
        if (f) return extractFromTheme(f);
        return { source: "theme", sourcePath: "", collections: [], warnings: ["No theme file found"] };
      }
    }
  }

  const detected = detectTokenSource(projectPath);
  if (!detected) {
    return { source: "tailwind", sourcePath: "", collections: [], warnings: ["No token source detected"] };
  }

  const extraction = extractDetected(detected, projectPath, darkFiles);
  // A tailwind.config.mts or .cts that detection passed over is named, so
  // the user can choose it.
  const passedOver = findTailwindConfig(projectPath, LATE_TAILWIND_CONFIGS);
  if (passedOver && passedOver !== detected.path) {
    extraction.warnings.push(`Read ${detected.path}, as earlier versions of storysync did, rather than ${passedOver}, which they didn't find. Pass --source tailwind to read the config`);
  }
  return extraction;
}

function extractDetected(detected: DetectedSource, projectPath: string, darkFiles?: string[]): Extraction {
  switch (detected.type) {
    case "tailwind":
      return detected.path.endsWith(".css")
        ? extractFromTailwindTheme(findTailwindThemeCSS(projectPath), projectPath, darkFiles)
        : extractFromTailwind(detected.path, projectPath, darkFiles);
    case "css": return extractFromCSS(findCSSWithCustomProperties(projectPath), projectPath, darkFiles);
    case "theme": return extractFromTheme(detected.path);
  }
}

// --- Tailwind extraction ---

function extractFromTailwind(configPath: string, projectRoot?: string, darkFiles?: string[]): Extraction {
  const content = stripComments(readFileSync(configPath, "utf8"));
  const warnings: string[] = [];

  // A preset's require() is named on its own below, and a plugin's, as
  // every shadcn/ui v3 config's `require("tailwindcss-animate")`, is no
  // value storysync misses: the warning was on nearly every config.
  if (/require\s*\(/.test(withoutArrays(content, ["plugins", "presets"]))) {
    warnings.push("Config uses require() - some values may not be extracted");
  }
  if (/\.\.\./.test(content)) {
    warnings.push("Config uses spread syntax - some values may not be extracted");
  }

  // What the config gets from elsewhere: the config it re-exports or
  // spreads in, or its presets, each read below as the config is, and
  // merged by withLayers as Tailwind merges them.
  const exported = exportedObject(content, "default");
  const imports = configImports(content);
  const presets = presetRefs(exported ?? content, imports);
  const spreads = spreadRefs(exported, imports);
  const locals = [...presets, ...spreads].flatMap((ref) => (ref.local && exportedObject(content, ref.local)) || []);

  // Extract theme.extend and theme objects, from the object the config
  // exports when it holds them.
  const themeBlocks = ownThemeBlocks(content, exported, locals);
  const own = themeCollections(themeBlocks, warnings);
  // The warnings from here on name what storysync can't read.
  const unread = warnings.length;
  warnOfSpreads(themeBlocks, configPath, warnings);

  const layers: ThemeLayer[] = [];
  const reexport = reexportRef(content, imports);
  if (reexport) {
    const layer = readConfigRef(reexport, configPath, content, `${configPath} re-exports its config from ${reexport.spec}`, warnings);
    if (layer) layers.push(layer);
  }
  for (const ref of presets) {
    const layer = readConfigRef(ref, configPath, content, `${configPath} takes the preset ${ref.label}`, warnings);
    if (layer) layers.push(layer);
  }
  for (const ref of spreads) {
    const layer = readConfigRef(ref, configPath, content, `${configPath} spreads in ${ref.label}`, warnings);
    if (layer) layers.push(layer);
  }
  const wrapper = reexport ? null : wrapperCall(content, imports);
  if (wrapper && own.length) {
    // As `defineConfig({ theme })`, which may add nothing.
    warnings.push(`${configPath} passes its config through ${wrapper}, which storysync can't read statically: the theme passed to it is read, but any tokens the function adds are missing`);
  } else if (wrapper) {
    warnings.push(`${configPath} builds its config with ${wrapper}, which storysync can't read statically, so the tokens it adds are missing`);
  }
  // The own theme's warnings were given as it was read.
  let collections = withLayers(layers, own, themeLayer(themeBlocks, []));
  const root = projectRoot ?? join(configPath, "..");
  // What the text left unread, a package's preset, a function's config, a
  // value it interpolates, Tailwind knows by running the config, the
  // project's own code: so does storysync then, and takes the theme
  // Tailwind resolves, less Tailwind's defaults, as it reads a config.
  const skipped = warnings.slice(0, unread).filter((w) => w.startsWith("Skipped dynamic value"));
  // Whether the theme was read whole, so an empty one is worth saying.
  let whole = warnings.length === unread;
  if (warnings.length > unread || skipped.length) {
    const loaded = loadTailwindTheme(configPath, root);
    if ("theme" in loaded) {
      const fromRun: string[] = [];
      collections = themeCollections(extractThemeBlocks(`module.exports = { theme: ${configText(loaded.theme)} }`), fromRun);
      warnings.length = 0;
      warnings.push(
        `Loaded ${configPath} as Tailwind does, by running it, since reading it as text left some of it unread: its tokens are the theme Tailwind resolves, less Tailwind's defaults`,
        ...fromRun,
      );
      whole = true;
    } else {
      warnings.push(`Could not load ${configPath} as Tailwind does either: ${loaded.error}`);
    }
  }
  if (!collections.length && whole) {
    const plugins = /\bplugins\s*:\s*\[\s*[^\]\s]/.test(content) ? ", nor what a plugin adds" : "";
    warnings.push(`Read no colors, spacing, borderRadius, fontFamily, fontSize, fontWeight, lineHeight, letterSpacing or boxShadow from the theme of ${configPath}. Tailwind's default theme isn't read${plugins}`);
  }

  // Resolve any `var(--name)` refs in token values against the project's :root CSS vars.
  // Common in shadcn/ui: `colors: { background: "hsl(var(--background))" }` with the actual
  // value defined in globals.css as `:root { --background: 0 0% 100%; }`.
  const cssFiles = findCSSWithCustomProperties(root);
  let vars: Map<string, string> | undefined;
  let written: Map<string, string> | undefined;
  if (cssFiles.length && collectionsHaveCssVarRefs(collections)) {
    const declared = readRootDeclarations(cssFiles, undefined, darkFiles);
    const cssVars = resolveRootVars(declared);
    if (cssVars.size) {
      for (const coll of collections) {
        for (const token of coll.tokens) {
          token.value = resolveTailwindCssRefs(token.value, cssVars);
        }
      }
      warnings.push(`Resolved CSS variable references from ${cssFiles[0]}`);
      vars = cssVars;
      written = declared;
    }
  }

  return { source: "tailwind", sourcePath: configPath, collections, warnings, vars, written };
}

/** How long loading a Tailwind config may take, as a build would. */
const LOAD_CONFIG_TIMEOUT_MS = 30_000;

/**
 * Runs in a child Node, given the config and the project's own Tailwind
 * loadConfig and resolveConfig: prints, as JSON, the theme Tailwind
 * resolves from the config, presets, plugins' themes and functions
 * included, less each value Tailwind's own default theme has the same.
 */
const LOAD_THEME = `
const [config, loadPath, resolvePath] = process.argv.slice(1);
const pick = (m) => (m && m.__esModule ? m.default : m.default || m);
const loadConfig = pick(require(loadPath));
const resolveConfig = pick(require(resolvePath));
const theme = resolveConfig(loadConfig(config)).theme || {};
const base = resolveConfig({ content: ["-"] }).theme || {};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = {};
for (const [key, value] of Object.entries(theme)) {
  if (!value || typeof value !== "object" || Array.isArray(value)) continue;
  const kept = {};
  for (const [name, v] of Object.entries(value)) if (!same(v, (base[key] || {})[name])) kept[name] = v;
  if (Object.keys(kept).length) own[key] = kept;
}
process.stdout.write(JSON.stringify(own, (k, v) => (typeof v === "function" ? undefined : v)));
`;

/**
 * Loads the Tailwind config at `configPath` as Tailwind does, with the
 * project's own tailwindcss (3.3 or later has loadConfig, which takes
 * TypeScript and ESM configs too), in a child process, so the user's code
 * runs as their build runs it and never in storysync's own. The theme it
 * resolves, less Tailwind's defaults; or why it couldn't.
 */
export function loadTailwindTheme(configPath: string, projectRoot: string): { theme: Record<string, unknown> } | { error: string } {
  let loadPath: string;
  let resolvePath: string;
  try {
    const projectRequire = createRequire(join(resolve(projectRoot), "package.json"));
    loadPath = projectRequire.resolve("tailwindcss/loadConfig");
    resolvePath = projectRequire.resolve("tailwindcss/resolveConfig");
  } catch {
    return { error: "the project has no tailwindcss with loadConfig and resolveConfig (Tailwind 3.3 or later) to load it with" };
  }
  try {
    const out = execFileSync(process.execPath, ["-e", LOAD_THEME, resolve(configPath), loadPath, resolvePath], {
      cwd: resolve(projectRoot), encoding: "utf8", timeout: LOAD_CONFIG_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const theme = JSON.parse(out) as unknown;
    if (!theme || typeof theme !== "object" || Array.isArray(theme)) return { error: "it resolved no theme" };
    return { theme: theme as Record<string, unknown> };
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: string };
    if (e.code === "ETIMEDOUT") return { error: `it took longer than ${LOAD_CONFIG_TIMEOUT_MS / 1000} seconds` };
    const lines = (e.stderr || e.message || String(err)).split("\n").map((l) => l.trim()).filter(Boolean);
    // Node prints the line that threw, a caret, then `Error: ...`.
    return { error: lines.find((l) => /^(?:[A-Z]\w*)?Error\b/.test(l)) ?? lines[0] ?? "it failed" };
  }
}

/**
 * `value` as a Tailwind config writes it, which the text reader reads: a
 * key bare where it can be, quoted where it can't (`"2xl"`), one per line.
 */
export function configText(value: unknown, indent = ""): string {
  if (Array.isArray(value)) return `[${value.map((v) => configText(v, indent)).join(", ")}]`;
  if (value && typeof value === "object") {
    const inner = `${indent}  `;
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${configText(v, inner)},`);
    return entries.length ? `{\n${entries.join("\n")}\n${indent}}` : "{}";
  }
  return JSON.stringify(value) ?? "null";
}

function collectionsHaveCssVarRefs(collections: TokenCollection[]): boolean {
  for (const c of collections) {
    for (const t of c.tokens) {
      if (/var\(\s*--/.test(t.value)) return true;
    }
  }
  return false;
}

/**
 * A config's own theme: the one in `exported`, the object it exports, when
 * that holds one, or else the first in the file, as storysync always read
 * it. A preset a config declares above itself, as `const base = { theme:
 * {...} }`, holds the first `theme:` in the file, so the config's own were
 * lost. A config that exports no object literal, or one with no theme of
 * its own, is read as before, unless the first theme in the file is one of
 * `locals`, the objects it takes as presets or spreads in: those are read
 * as such, and read as its own too, a local preset outranked every other.
 */
function ownThemeBlocks(content: string, exported: string | null, locals: string[]): ThemeBlocks {
  const blocks = exported ? extractThemeBlocks(exported) : null;
  if (blocks?.root) return blocks;
  const first = extractThemeBlocks(content);
  return first.root && locals.some((local) => local.includes(first.root)) ? { root: "", extend: "" } : first;
}

/** `content` without the `key: [...]` array of each key, the first of each. */
function withoutArrays(content: string, keys: string[]): string {
  return keys.reduce((text, key) => {
    const m = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(text);
    return m ? text.slice(0, m.index) + text.slice(closingIndex(text, m.index + m[0].length - 1)) : text;
  }, content);
}

/** A theme's tokens, by category, in the order a Tailwind config's are listed. */
function themeCollections(themeBlocks: ThemeBlocks, warnings: string[]): TokenCollection[] {
  const collections: TokenCollection[] = [];

  const colorTokens = extractTailwindColors(themeBlocks, warnings);
  if (colorTokens.length) collections.push({ category: "colors", tokens: colorTokens });

  const spacingTokens = extractTailwindFlat(themeBlocks, "spacing", warnings);
  if (spacingTokens.length) collections.push({ category: "spacing", tokens: spacingTokens });

  const radiusTokens = extractTailwindFlat(themeBlocks, "borderRadius", warnings);
  if (radiusTokens.length) collections.push({ category: "radius", tokens: radiusTokens });

  const fontTokens = extractTailwindTypography(themeBlocks, warnings);
  if (fontTokens.length) collections.push({ category: "typography", tokens: fontTokens });

  const shadowTokens = extractTailwindFlat(themeBlocks, "boxShadow", warnings);
  if (shadowTokens.length) collections.push({ category: "shadows", tokens: shadowTokens });

  return collections;
}

const CATEGORY_ORDER: TokenCategory[] = ["colors", "spacing", "radius", "typography", "shadows"];

/** The theme keys each category is read from. */
const CATEGORY_KEYS: [TokenCategory, string][] = [
  ["colors", "colors"], ["spacing", "spacing"], ["radius", "borderRadius"],
  ["typography", "fontSize"], ["typography", "fontFamily"], ["typography", "fontWeight"], ["typography", "lineHeight"], ["typography", "letterSpacing"],
  ["shadows", "boxShadow"],
];

/**
 * A config's theme, or a preset's, as Tailwind merges it with others: the
 * tokens under `theme` itself and under `theme.extend` apart, and the
 * categories whose key `theme` itself sets.
 */
interface ThemeLayer {
  root: TokenCollection[];
  extend: TokenCollection[];
  sets: Set<TokenCategory>;
}

/** A theme's ThemeLayer, its dynamic values named in `warnings`. */
function themeLayer(blocks: ThemeBlocks, warnings: string[]): ThemeLayer {
  const entries = blocks.root ? splitTopLevel(blocks.root.slice(1, -1), ",") : [];
  const keyOf = (entry: string) => /^\s*(['"]?)([\w$]+)\1\s*(?::|$)/.exec(entry)?.[2];
  const root = `{ ${entries.filter((entry) => keyOf(entry) !== "extend").join(",")} }`;
  const keys = new Set(entries.map(keyOf));
  return {
    root: themeCollections({ root, extend: "" }, warnings),
    extend: themeCollections({ root: "", extend: blocks.extend }, warnings),
    sets: new Set(CATEGORY_KEYS.filter(([, key]) => keys.has(key)).map(([category]) => category)),
  };
}

/** A selector for a dark theme: `.dark`, as shadcn/ui and Tailwind's class strategy write it, or a `data-theme="dark"` or like attribute. */
const DARK_SELECTOR = /\.(?:dark|dark-mode|dark-theme|theme-dark)(?![\w-])|\[data-[\w-]*(?:theme|mode|scheme)[\w-]*\s*=\s*["']?dark["']?\s*\]/i;

/**
 * Whether a selector sets the variables of a dark theme for the page: a
 * dark selector alone, as `.dark` or `[data-theme="dark"]`, or on the root
 * or the body, as `:root.dark`, `html.dark` or `body.dark`, or nested in
 * `:root` as `&.dark`, or `.dark *`. `.dark .card { }` sets a card's.
 */
function isDarkThemeSelector(selector: string): boolean {
  const m = DARK_SELECTOR.exec(selector);
  if (!m) return false;
  const rest = (selector.slice(0, m.index) + selector.slice(m.index + m[0].length)).replace(/\s+/g, "");
  return /^(?:html|body|&|\*)?(?::root)*\*?$/i.test(rest);
}

/** Whether a rule sets the dark theme: one for a dark selector, or a `:root` in `@media (prefers-color-scheme: dark)`. */
function setsDarkTheme(rule: StyleRule): boolean {
  const selectors = splitTopLevel(rule.selector, ",").map((selector) => selector.trim());
  if (rule.atRules.some(isDarkScheme) && selectors.some((selector) => ROOT_SELECTOR.test(selector))) return true;
  return selectors.some(isDarkThemeSelector);
}

/**
 * The custom properties a stylesheet declares for the dark theme, as
 * written, in order. Tailwind's own `--tw-` variables, which a compiled
 * `dark:` utility sets, are no theme's, and left out.
 */
function darkDeclarations(css: string): [string, string][] {
  const declarations: [string, string][] = [];
  for (const rule of styleRules(css)) {
    if (!setsDarkTheme(rule)) continue;
    for (const decl of rule.declarations.matchAll(/\s*(--[\w-]+)\s*:\s*([^;}]+);?/g)) {
      if (!decl[1].startsWith("--tw-")) declarations.push([decl[1].trim(), decl[2].trim()]);
    }
  }
  return declarations;
}

/** The project's stylesheets that declare a custom property for the dark theme. */
function findDarkCSS(projectPath: string): string[] {
  return findCSS(projectPath, (css) => darkDeclarations(css).length > 0);
}

/**
 * The tokens of a config and the layers it takes a theme from, presets and
 * the like, merged as Tailwind merges them. A category is the `theme` one
 * of the last layer that sets it there, the config's own last of all, and
 * then each layer's `theme.extend` on top in turn, a later one winning a
 * name: Tailwind applies every extend over the theme. So a config's
 * `theme.colors` replaces a preset's, and its `theme.extend.colors` adds to
 * them. With no layers, `own`, the config's tokens as storysync has always
 * read them, as they are.
 */
function withLayers(layers: ThemeLayer[], own: TokenCollection[], ownLayer: ThemeLayer): TokenCollection[] {
  if (!layers.length) return own;
  const all = [...layers, ownLayer];
  const tokensIn = (collections: TokenCollection[], category: TokenCategory) =>
    collections.filter((c) => c.category === category).flatMap((c) => c.tokens);
  return CATEGORY_ORDER.map((category) => {
    const top = [...all].reverse().find((layer) => layer.sets.has(category));
    let tokens = top ? tokensIn(top.root, category) : [];
    for (const layer of all) {
      const over = tokensIn(layer.extend, category);
      const names = new Set(over.map((t) => t.name));
      tokens = [...tokens.filter((t) => !names.has(t.name)), ...over];
    }
    return { category, tokens };
  }).filter((c) => c.tokens.length);
}

/**
 * Where a config gets a theme from outside itself: a preset, or the config
 * it re-exports.
 */
interface ConfigRef {
  /** As the config writes it, for a warning: `preset`, `require("./preset")`, `preset()`. */
  label: string;
  /** The module it comes from, when the config names one. */
  spec?: string;
  /** The export it is: `default`, or a named export's name. */
  name?: string;
  /** Built by a function call, so known only when the config runs. */
  call?: boolean;
  /** A require() of a path worked out when the config runs, as `require(path.join(__dirname, "preset"))`. */
  computed?: boolean;
  /** An object the config itself declares under this name. */
  local?: string;
}

/** An imported name's module and export, and whether a call builds it. */
interface ConfigImport { spec: string; name: string; call?: boolean }

/**
 * What each name a config imports or requires refers to: `import preset
 * from "./preset"`, `import { a, b as c } from "m"`, `import * as m from
 * "m"`, `const preset = require("./preset")` and `const { a } = require("m")`.
 */
function configImports(content: string): Map<string, ConfigImport> {
  const imports = new Map<string, ConfigImport>();
  const named = (list: string, spec: string, as: RegExp) => {
    for (const part of list.split(",")) {
      const m = as.exec(part.trim());
      if (m) imports.set(m[2] ?? m[1], { spec, name: m[1] });
    }
  };
  for (const m of content.matchAll(/\bimport\s+([\w$]+)\s*(?:,\s*\{([^}]*)\})?\s*from\s*(['"])([^'"]+)\3/g)) {
    if (m[1] === "type") continue;
    imports.set(m[1], { spec: m[4], name: "default" });
    if (m[2]) named(m[2], m[4], /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
  }
  for (const m of content.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    named(m[1], m[3], /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
  }
  for (const m of content.matchAll(/\bimport\s+\*\s+as\s+([\w$]+)\s+from\s*(['"])([^'"]+)\2/g)) {
    imports.set(m[1], { spec: m[3], name: "*" });
  }
  for (const m of content.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*(['"`])([^'"`]+)\2\s*\)(?:\.([\w$]+))?(\s*\()?/g)) {
    imports.set(m[1], { spec: m[3], name: m[4] ?? "default", call: !!m[5] });
  }
  for (const m of content.matchAll(/\b(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*(['"`])([^'"`]+)\2\s*\)/g)) {
    named(m[1], m[3], /^([\w$]+)(?:\s*:\s*([\w$]+))?$/);
  }
  return imports;
}

/** A config expression's ConfigRef: a require(), an imported name, or a call. */
function configRef(expr: string, imports: Map<string, ConfigImport>): ConfigRef {
  const label = expr.replace(/\s+/g, " ");
  // A path that is no string literal, or a template literal that interpolates.
  if (/^require\s*\(/.test(expr) && (!/^require\(\s*(['"`])[^'"`]+\1\s*\)/.test(expr) || /^require\(\s*`[^`]*\$\{/.test(expr))) {
    return { label, computed: true };
  }
  const required = /^require\(\s*(['"`])([^'"`]+)\1\s*\)(?:\.([\w$]+))?$/.exec(expr);
  if (required) return { label, spec: required[2], name: required[3] ?? "default" };
  const id = /^([\w$]+)(?:\.([\w$]+))?$/.exec(expr);
  if (id) {
    const imported = imports.get(id[1]);
    if (!imported) return id[2] ? { label } : { label, local: id[1] };
    if (imported.call) return { label, spec: imported.spec, call: true };
    if (!id[2] || id[2] === "default") return { label, spec: imported.spec, name: imported.name };
    // A namespace's member is its named export; another member, a property
    // of an export, isn't read.
    return imported.name === "*" ? { label, spec: imported.spec, name: id[2] } : { label, spec: imported.spec, call: true };
  }
  const call = /^(require\(\s*(['"`])([^'"`]+)\2\s*\)|[\w$.]+)\s*\(/.exec(expr);
  if (call) {
    const callee = call[3] ? `require("${call[3]}")` : call[1];
    return { label: `${callee}()`, spec: call[3] ?? imports.get(call[1].split(".")[0])?.spec, call: true };
  }
  return { label };
}

/** The entries of a config's `presets: [...]`, as ConfigRefs. */
function presetRefs(content: string, imports: Map<string, ConfigImport>): ConfigRef[] {
  const m = /\bpresets\s*:\s*\[/.exec(content);
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  const list = content.slice(open + 1, closingIndex(content, open) - 1);
  return splitTopLevel(list, ",").map((entry) => entry.trim()).filter(Boolean).map((entry) => configRef(entry, imports));
}

/**
 * The configs spread in at the top of the object a config exports, as a
 * monorepo's `module.exports = { ...require("./base"), content }` or
 * `export default { ...base, content }` does, as ConfigRefs. These were
 * neither read nor named: the config read as empty, with a warning that
 * blamed Tailwind's default theme. One that a `theme` key after it
 * replaces is left out, as JavaScript leaves out its theme.
 */
function spreadRefs(exported: string | null, imports: Map<string, ConfigImport>): ConfigRef[] {
  if (!exported) return [];
  const entries = splitTopLevel(exported.slice(1, -1), ",");
  const refs: ConfigRef[] = [];
  entries.forEach((entry, i) => {
    const spread = /^\s*\.\.\.\s*([\s\S]+?)\s*$/.exec(entry);
    if (!spread) return;
    if (entries.slice(i + 1).some((later) => /^\s*(['"]?)theme\1\s*(?::|$)/.test(later))) return;
    refs.push(configRef(spread[1], imports));
  });
  return refs;
}

/** The expression a config exports, `module.exports = ...` or `export default ...`. */
const EXPORTED = /(?:\bmodule\.exports\s*=|\bexport\s+default\b)\s*/;

/**
 * The config a config re-exports, as snowball-tech's `export { default }
 * from "@snowball-tech/design-tokens/..."` does, or `module.exports =
 * require("./base")`, or `export default` an imported name. Null when it
 * exports a config of its own.
 */
function reexportRef(content: string, imports: Map<string, ConfigImport>): ConfigRef | null {
  const from = /\bexport\s*\{\s*(?:default|([\w$]+)\s+as\s+default)\s*\}\s*from\s*(['"])([^'"]+)\2/.exec(content);
  if (from) return { label: `export { ${from[1] ? `${from[1]} as ` : ""}default } from "${from[3]}"`, spec: from[3], name: from[1] ?? "default" };
  const exported = new RegExp(EXPORTED.source + /(require\(\s*(['"`])[^'"`]+\2\s*\)(?:\.[\w$]+)?|[\w$]+)\s*(?:;|$|\bsatisfies\b|\bas\b)/.source, "m").exec(content);
  if (!exported) return null;
  if (exported[1].startsWith("require(")) return configRef(exported[1], imports);
  // An imported call, as `require("x")("docs")`, is wrapperCall's.
  const imported = imports.get(exported[1]);
  return imported && !imported.call ? configRef(exported[1], imports) : null;
}

/** `text` as a regex matching it literally: every metacharacter, the backslash too, escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The function a config's export is built by, as `module.exports =
 * withTW({ ... })` or `const config = require("@inmediam/ui/tailwind")("docs")`
 * then `module.exports = config`, for a warning that what it adds isn't
 * read. Null when the export is no call.
 */
function wrapperCall(content: string, imports: Map<string, ConfigImport>): string | null {
  const direct = new RegExp(EXPORTED.source + /([\w$.]+)\s*\(/.source).exec(content);
  if (direct && direct[1] !== "require" && direct[1] !== "function") return `${direct[1]}()`;
  const required = new RegExp(EXPORTED.source + /require\(\s*(['"`])([^'"`]+)\1\s*\)(?:\.[\w$]+)?\s*\(/.source).exec(content);
  if (required) return `require("${required[2]}")()`;
  const id = new RegExp(EXPORTED.source + /([\w$]+)\s*(?:;|$|\bsatisfies\b|\bas\b)/.source, "m").exec(content);
  if (!id) return null;
  const imported = imports.get(id[1]);
  if (imported?.call) return `require("${imported.spec}")()`;
  const assigned = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(id[1])}\\s*(?::[^=]+)?=\\s*([\\w$.]+)\\s*\\(`).exec(content);
  return assigned && assigned[1] !== "require" ? `${assigned[1]}()` : null;
}

/**
 * The object literal `name` is in a module: for `default`, what
 * `module.exports` or `export default` is, directly or through a const; for
 * another name, the const of that name, or `exports.name`. Null when it is
 * no object literal, as when a function builds it.
 */
function exportedObject(content: string, name: string): string | null {
  const objectAfter = (pattern: RegExp) => {
    const m = pattern.exec(content);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    return content.slice(open, closingIndex(content, open));
  };
  const local = (id: string) => objectAfter(new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(id)}\\s*(?::[^=]+)?=\\s*\\{`));
  if (name === "default" || name === "*") {
    const direct = objectAfter(new RegExp(EXPORTED.source + "\\{"));
    if (direct) return direct;
    const id = new RegExp(EXPORTED.source + /([\w$]+)\s*(?:;|$|\bsatisfies\b|\bas\b)/.source, "m").exec(content);
    return id ? local(id[1]) : null;
  }
  return local(name) ?? objectAfter(new RegExp(`\\b(?:module\\.)?exports\\.${escapeRegExp(name)}\\s*=\\s*\\{`));
}

/** The file a relative import names, with the extensions a Tailwind config's imports can leave out. */
function resolveModule(from: string, spec: string): string | null {
  const base = resolve(from, spec);
  const extensions = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"];
  // TypeScript's ESM imports name a .ts file by its .js.
  const swapped = /\.[cm]?js$/.test(base) ? [".ts", ".cts", ".mts"].map((ext) => base.replace(/\.[cm]?js$/, ext)) : [];
  const candidates = [base, ...extensions.map((ext) => base + ext), ...swapped, ...extensions.map((ext) => join(base, `index${ext}`))];
  return candidates.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

/**
 * The tokens of a preset, or of a config re-exported, read as the config
 * is: an object literal in a relative file, or in the config itself, one
 * level deep. Anything else, a package, a call, or a file storysync can't
 * find, is named in a warning that starts with `subject`, and is null.
 * zenkigen's config is `presets: [componentConfig]` from a package, and
 * sameera/quantum's `presets: [require("./tailwind.preset.js")]`: each read
 * as no tokens at all, with no warning to say why.
 */
function readConfigRef(ref: ConfigRef, configPath: string, content: string, subject: string, warnings: string[]): ThemeLayer | null {
  const missing = "so the tokens it declares are missing";
  const from = ref.spec && !subject.endsWith(ref.spec) ? `, from ${ref.spec},` : "";
  let file = configPath;
  let object: string | null = null;
  if (ref.call) {
    warnings.push(`${subject}${from || ","} built by a function call, which storysync can't read statically, ${missing}`);
    return null;
  }
  if (ref.computed) {
    warnings.push(`${subject}, whose path is worked out when the config runs, which storysync can't read statically, ${missing}`);
    return null;
  }
  if (ref.local) {
    object = exportedObject(content, ref.local);
  } else if (!ref.spec) {
    warnings.push(`${subject}, which storysync can't read statically, ${missing}`);
    return null;
  } else if (!ref.spec.startsWith(".")) {
    warnings.push(`${subject}${from ? `, from the package ${ref.spec},` : ", a package,"} which storysync can't read statically, ${missing}`);
    return null;
  } else {
    const found = resolveModule(dirname(configPath), ref.spec);
    if (!found) {
      warnings.push(`${subject}, but storysync can't find ${ref.spec}, ${missing}`);
      return null;
    }
    // Shown as the config's path is, relative when it is.
    file = join(dirname(configPath), relative(resolve(dirname(configPath)), found));
    try {
      content = stripComments(readFileSync(file, "utf8"));
    } catch {
      warnings.push(`${subject}, but storysync can't read ${file}, ${missing}`);
      return null;
    }
    object = exportedObject(content, ref.name ?? "default");
  }
  if (!object) {
    warnings.push(`${subject}, which ${file} builds in a way storysync can't read statically, ${missing}`);
    return null;
  }
  const nested = presetRefs(object, configImports(content));
  if (nested.length) {
    warnings.push(`${file} takes presets of its own, ${nested.map((r) => r.label).join(", ")}, which storysync doesn't follow, so the tokens they declare are missing`);
  }
  const blocks = extractThemeBlocks(object);
  warnOfSpreads(blocks, file, warnings);
  return themeLayer(blocks, warnings);
}

/**
 * Names, in a warning, what a theme or its extend spreads in at the top,
 * as edu-design-system's `theme: { ...applyTailwindConfig(edsTokens) }`
 * does: storysync can't run it, so it read the theme as empty, saying only
 * that the config used spread syntax.
 */
function warnOfSpreads(blocks: ThemeBlocks, path: string, warnings: string[]): void {
  const spreads: string[] = [];
  for (const block of [blocks.root, blocks.extend]) {
    if (!block) continue;
    for (const entry of splitTopLevel(block.slice(1, -1), ",")) {
      const m = /^\s*\.\.\.\s*([\s\S]+?)\s*$/.exec(entry);
      if (m) spreads.push(m[1].replace(/\s+/g, " "));
    }
  }
  if (spreads.length) {
    warnings.push(`The theme in ${path} spreads in ${spreads.join(", ")}, which storysync can't read statically, so the tokens it adds are missing`);
  }
}

/**
 * `text` split at each `separator` outside brackets, parentheses, braces
 * and quotes, so `:is(.a, .b), :root` is two selectors and
 * `require("a"), preset({ b, c })` two presets. A backslash escapes the
 * character after it, so the `\{` in a selector such as `.a\{b, :root`
 * opens nothing, and its `:root` is a selector of its own.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "\\") i++;
    else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * The index just past the bracket that closes the one at `open`, `{` or
 * `[`, skipping quoted text and escaped characters, or the text's length
 * when it isn't closed. In `css`, a backtick is no quote. A backslash
 * escapes what follows it outside quotes too: in CSS, as Tailwind's
 * `.after\:content-\[\'\'\]` class does, and in a config's regex.
 * Read as the start of a string, that `'` hid every rule after it.
 */
function closingIndex(text: string, open: number, css = false): number {
  const [opener, closer] = text[open] === "[" ? ["[", "]"] : ["{", "}"];
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "\\") i++;
    else if (ch === "'" || ch === '"' || (ch === "`" && !css)) quote = ch;
    else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * Whether an at-rule is `@media` for the dark color scheme. The `:root` in
 * one holds the dark values, as create-next-app's globals.css does: read in
 * order with the rest, it overrode the light ones, so its background was
 * extracted as #0a0a0a. `@media not ...` is light.
 */
function isDarkScheme(atRule: string): boolean {
  return /^@media\b/i.test(atRule) && /prefers-color-scheme\s*:\s*dark/i.test(atRule) && !/\bnot\b/i.test(atRule);
}

/** A style rule, as styleRules reads it. */
interface StyleRule {
  /** Its selector list, as written. */
  selector: string;
  /** Its own declarations' text, without the rules nested in it. */
  declarations: string;
  /** The at-rules it is in, outermost first. */
  atRules: string[];
  /** Nested in another style rule, as CSS nesting writes `&.dark { }`. */
  nested: boolean;
}

/**
 * A stylesheet's style rules, in order, each with the at-rules it is in,
 * `@layer` and `@media` included. A rule's declarations in an at-rule nested
 * in it, as in `:root { @media print { --x: 1 } }`, are listed as the rule
 * again inside that at-rule, after it. Quoted text is skipped, so a `}` in
 * a `content` string ends no block.
 */
function styleRules(css: string): StyleRule[] {
  const rules: StyleRule[] = [];
  // Reads the block from `start` to `end`, listing its rules, and returns its
  // own declarations' text. `parent` is the style rule it is in, if any.
  const walk = (start: number, end: number, atRules: string[], parent: StyleRule | null): string => {
    let own = "";
    let from = start;
    let prelude = start;
    let quote: string | null = null;
    for (let i = start; i < end; i++) {
      const ch = css[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if (ch === "\\") i++;
      else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === ";" || ch === "}") prelude = i + 1;
      else if (ch === "{") {
        const close = closingIndex(css, i, true);
        const head = css.slice(prelude, i).trim();
        own += css.slice(from, prelude);
        if (head.startsWith("@")) {
          const inner = [...atRules, head];
          const rule = parent && { ...parent, declarations: "", atRules: inner };
          if (rule) rules.push(rule);
          const declarations = walk(i + 1, close - 1, inner, parent);
          if (rule) rule.declarations = declarations;
        } else {
          const rule: StyleRule = { selector: head, declarations: "", atRules, nested: parent !== null };
          rules.push(rule);
          rule.declarations = walk(i + 1, close - 1, atRules, rule);
        }
        i = close - 1;
        from = prelude = close;
      }
    }
    return own + css.slice(from, end);
  };
  walk(0, css.length, [], null);
  return rules;
}

/**
 * A selector for the root element alone: `:root`, or `html:root`, `*:root`
 * and `:root:root`, which select the same element and which storysync read
 * before selector lists were. A rule that sets `html:root { }` alone lost
 * every token when only a bare `:root` counted.
 */
const ROOT_SELECTOR = /^(?:html|\*)?(?::root)+$/i;

/**
 * Whether a rule sets the default theme: its selector list holds `:root`,
 * as `:root { }`, `html:root { }` and `:root, .light { }` do, and it is no
 * rule nested in another, nor in `@media` for the dark color scheme. A rule
 * that only names a theme, as `.dark`, `.light`, `[data-theme="dark"]` or
 * `:root.dark` do, sets that theme's values, not the default's. `html` is
 * left out: `:root` outranks it whatever their order, so its values
 * couldn't be read in turn with `:root`'s, and storysync never read it.
 * In a `bundled` stylesheet, only a list that ends in `:root` counts, as
 * earlier versions read it.
 */
function setsDefaultTheme(rule: StyleRule, bundled = false): boolean {
  const selectors = splitTopLevel(rule.selector, ",").map((selector) => selector.trim());
  return !rule.nested &&
    !rule.atRules.some(isDarkScheme) &&
    !isCompiledTailwindTheme(rule) &&
    (bundled ? ROOT_SELECTOR.test(selectors[selectors.length - 1]) : selectors.some((selector) => ROOT_SELECTOR.test(selector)));
}

/**
 * Whether a rule is Tailwind v4's compiled output of its own theme: the
 * `:root, :host` it writes in `@layer theme`, holding Tailwind's default
 * palette, fonts and scales, and in `@layer properties`, holding
 * `@property` fallbacks. The src/output.css of Tailwind's CLI docs has
 * one, as a Storybook build does, and storysync walks src/: read as the
 * default theme, Tailwind's red-500, font-sans and text-sm became the
 * project's tokens. No earlier version read a list
 * that doesn't end in `:root`, so leaving this one out keeps what they
 * read.
 */
function isCompiledTailwindTheme(rule: StyleRule): boolean {
  return /^:root\s*,\s*:host$/i.test(rule.selector) &&
    rule.atRules.some((atRule) => /^@layer\s+(?:theme|properties)$/i.test(atRule));
}

/**
 * The custom properties a stylesheet declares for the default theme, as
 * written, in order. coder's index.css declares its palette in
 * `@layer base { :root, .light { ... } }`: only a `:root {` was read,
 * and its one was a scrollbar-color, so none of its 55 colors resolved.
 * `bundled` is isBundled's.
 */
function rootDeclarations(css: string, bundled = false): [string, string][] {
  const declarations: [string, string][] = [];
  for (const rule of styleRules(css)) {
    if (!setsDefaultTheme(rule, bundled)) continue;
    for (const decl of rule.declarations.matchAll(/\s*(--[\w-]+)\s*:\s*([^;}]+);?/g)) {
      declarations.push([decl[1].trim(), decl[2].trim()]);
    }
  }
  return declarations;
}

/**
 * The custom properties the stylesheets declare for the default theme, as
 * written, a later declaration winning: those of each rule whose selector
 * list holds `:root`, leaving out the dark color scheme's. A file that
 * can't be read is skipped, and named in `warnings` when there are any.
 * With `darkFiles`, the dark theme's declarations in them follow, over
 * the default theme's, as `.dark` on the root overrides `:root` in the
 * browser: the variables the dark theme renders with.
 */
function readRootDeclarations(files: string[], warnings?: string[], darkFiles?: string[]): Map<string, string> {
  const declared = new Map<string, string>();
  for (const file of files) {
    try {
      for (const [name, value] of rootDeclarations(readCss(file), isBundled(file))) declared.set(name, value);
    } catch {
      warnings?.push(`Could not read ${file}`);
    }
  }
  for (const file of darkFiles ?? []) {
    try {
      for (const [name, value] of darkDeclarations(readCss(file))) declared.set(name, value);
    } catch { /* read as the light theme was */ }
  }
  return declared;
}

/**
 * `:root`'s variables with each one that is a var() resolved, chains and
 * fallbacks included. Resolved in place, in order, so a later variable sees
 * an earlier one resolved; a copy, so the declarations stay as written.
 */
function resolveRootVars(declared: Map<string, string>): Map<string, string> {
  const allVars = new Map(declared);
  for (const [name, value] of allVars) {
    allVars.set(name, resolveCssVar(value, allVars, 0));
  }
  return allVars;
}

/**
 * `value` with each var() in it replaced by what `replace` returns for its
 * name and fallback, or kept when that is undefined. A fallback runs to its
 * var()'s own `)`, so one that holds parentheses, as `var(--a, rgb(0 0 0))`
 * and `var(--a, var(--b))` do, is read whole. A regex that ended it at the
 * first `)` left the second behind once `--a` resolved, so quary's
 * `var(--vscode-input-border, hsl(...))` came out as `#cecece)`, no color.
 */
function replaceVars(value: string, replace: (name: string, fallback: string | undefined) => string | undefined): string {
  let out = "";
  let from = 0;
  const start = /var\(\s*(--[\w-]+)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(value)) !== null) {
    let depth = 1;
    let comma = -1;
    let i = start.lastIndex;
    for (; i < value.length; i++) {
      const ch = value[i];
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
      else if (ch === "," && depth === 1 && comma === -1) comma = i;
    }
    // Not closed: the rest is left as written.
    if (i === value.length) break;
    // Anything but a comma after the name makes it no var() to resolve.
    if (value.slice(start.lastIndex, comma === -1 ? i : comma).trim()) continue;
    const replacement = replace(m[1], comma === -1 ? undefined : value.slice(comma + 1, i));
    if (replacement !== undefined) {
      out += value.slice(from, m.index) + replacement;
      from = i + 1;
    }
    start.lastIndex = i + 1;
  }
  return out + value.slice(from);
}

// Replace `var(--name)` and `var(--name, fallback)` inside a Tailwind token value.
// Also strips Tailwind's `<alpha-value>` opacity placeholder.
export function resolveTailwindCssRefs(value: string, cssVars: Map<string, string>): string {
  // Strip Tailwind opacity placeholder: `hsl(var(--bg) / <alpha-value>)` → `hsl(var(--bg))`
  let s = value.replace(/\s*\/\s*<alpha-value>\s*/g, "");

  // Replace each var(--name) or var(--name, fallback) with its resolved CSS value (depth-guarded).
  // An empty fallback, as in `var(--unset,)`, leaves the var() as written,
  // with its Unresolved warning, as earlier versions left it: replaced, it
  // made a token with no value and no warning.
  for (let depth = 0; depth < 8 && /var\(\s*--/.test(s); depth++) {
    s = replaceVars(s, (name, fallback) => cssVars.get(name) ?? (fallback?.trim() || undefined));
  }
  return s.trim();
}

interface ThemeBlocks {
  extend: string;
  root: string;
}

/**
 * A config's theme, and its extend. An ES module config can export its
 * keys one by one, as `export const theme = { ... }`, which Tailwind reads
 * as it does `theme: { ... }`; it was read as no theme at all.
 */
function extractThemeBlocks(content: string): ThemeBlocks {
  const rootMatch = findBalancedBlock(content, /theme\s*:\s*\{/) ??
    findBalancedBlock(content, /\bexport\s+(?:const|let|var)\s+theme\s*(?::[^=]+)?=\s*\{/);
  const extendBlock = rootMatch ? findPropertyBlock(rootMatch, "extend") : null;
  return {
    extend: extendBlock ? `{${extendBlock}}` : "",
    root: rootMatch ?? "",
  };
}

function findBalancedBlock(content: string, startPattern: RegExp): string | null {
  const match = startPattern.exec(content);
  if (!match) return null;

  // Find the opening brace position at the end of the match
  let braceStart = match.index + match[0].length - 1;
  let depth = 1;
  let i = braceStart + 1;

  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
    i++;
  }

  return content.slice(braceStart, i);
}

function extractTailwindColors(blocks: ThemeBlocks, warnings: string[]): TokenValue[] {
  const tokens: TokenValue[] = [];
  // Try extend first, then root
  for (const block of [blocks.extend, blocks.root]) {
    if (!block) continue;
    const colorsBlock = findPropertyBlock(block, "colors");
    if (!colorsBlock) continue;
    flattenObject(colorsBlock, "", tokens, "colors", warnings);
    if (tokens.length) break;
  }
  return tokens;
}

function extractTailwindFlat(blocks: ThemeBlocks, key: string, warnings: string[]): TokenValue[] {
  const tokens: TokenValue[] = [];
  for (const block of [blocks.extend, blocks.root]) {
    if (!block) continue;
    const propBlock = findPropertyBlock(block, key);
    if (!propBlock) continue;
    flattenObject(propBlock, "", tokens, key, warnings);
    if (tokens.length) break;
  }
  return tokens;
}

/**
 * A JS string literal's text, '...', "..." or `...` without `${}`, or a
 * bare number, as a weight's `500`; null for anything the config works
 * out when it runs, as a name it imports.
 */
function literalValue(src: string): string | null {
  const s = src.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)[a-z%]*$/i.test(s)) return s;
  const q = s[0];
  if (s.length < 2 || !(q === "'" || q === '"' || q === "`") || s[s.length - 1] !== q) return null;
  if (q === "`") return templateString(s);
  if (q === '"') {
    try {
      return (JSON.parse(s) as string).trim();
    } catch {
      // Not JSON: unescaped below, as a single-quoted string is.
    }
  }
  return s.slice(1, -1).replace(/\\(.)/g, "$1").trim();
}

/**
 * A config's fontFamily value as the stack Tailwind writes in CSS: a
 * string as it is, an array's families joined with `, `, and a tuple's,
 * `[stack, { fontFeatureSettings }]`, its stack. Null where the config
 * works it out when it runs.
 */
function fontStack(value: string): string | null {
  const v = value.trim();
  if (!v.startsWith("[")) return literalValue(v);
  const items = splitTopLevel(v.slice(1, -1), ",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 2 && items[1].startsWith("{")) return fontStack(items[0]);
  const families = items.map(literalValue);
  return families.every((f): f is string => f !== null && f !== "") ? families.join(", ") : null;
}

/**
 * The typography of a Tailwind config's theme, named as Tailwind v4's
 * theme variables are (THEME_NAMESPACES), so a JS config's tokens push as
 * a CSS theme's do: each fontFamily a stack, `font/sans`, which the push
 * sets in Figma's family for it; each fontWeight `font/weight/medium`,
 * lineHeight `leading/tight` and letterSpacing `tracking/wide`; and each
 * fontSize by its own name, `sm`, as storysync always named it. A size's
 * tuple, `sm: ["0.875rem", { lineHeight: "1.25rem", fontWeight: "500" }]`
 * or `["0.625rem", "0.875rem"]`, gives `leading/sm`, `font/weight/sm` and
 * `tracking/sm`, unless the theme's own key names one so. Each key is
 * read from `theme.extend`, or from `theme` where extend has none.
 */
function extractTailwindTypography(blocks: ThemeBlocks, warnings: string[]): TokenValue[] {
  const pairsOf = (key: string): [string, string][] => {
    for (const block of [blocks.extend, blocks.root]) {
      const prop = block ? findPropertyBlock(block, key) : null;
      const pairs = prop ? extractKeyValuePairs(prop) : [];
      if (pairs.length) return pairs;
    }
    return [];
  };
  const skipped = (key: string, name: string, value: string) => warnings.push(`Skipped dynamic value: ${key} ${name} = ${value.trim()}`);
  const families: TokenValue[] = [];
  for (const [name, value] of pairsOf("fontFamily")) {
    const stack = fontStack(value);
    if (stack) families.push({ name: `font/${name}`, value: stack });
    else skipped("fontFamily", name, value);
  }
  const sizes: TokenValue[] = [];
  const paired: Record<string, TokenValue[]> = { fontWeight: [], lineHeight: [], letterSpacing: [] };
  for (const [name, value] of pairsOf("fontSize")) {
    const v = value.trim();
    const items = v.startsWith("[") ? splitTopLevel(v.slice(1, -1), ",").map((item) => item.trim()).filter(Boolean) : [v];
    const size = items[0] === undefined ? null : literalValue(items[0]);
    if (size === null) {
      skipped("fontSize", name, value);
      continue;
    }
    sizes.push({ name, value: size });
    const second = items[1];
    if (!second) continue;
    // Its line height alone, or an object of line height, weight and letter spacing.
    const options: [string, string][] = second.startsWith("{") ? extractKeyValuePairs(second.slice(1, -1)) : [["lineHeight", second]];
    for (const [key, option] of options) {
      if (!paired[key]) continue;
      const read = literalValue(option);
      if (read === null) skipped(`fontSize ${name}`, key, option);
      else paired[key].push({ name, value: read });
    }
  }
  const named = (key: string, prefix: string): TokenValue[] => {
    const own: TokenValue[] = [];
    for (const [name, value] of pairsOf(key)) {
      const read = literalValue(value);
      if (read === null) skipped(key, name, value);
      else own.push({ name: `${prefix}/${name}`, value: read });
    }
    const names = new Set(own.map((t) => t.name));
    return [...own, ...paired[key].map((t) => ({ name: `${prefix}/${t.name}`, value: t.value })).filter((t) => !names.has(t.name))];
  };
  return [...sizes, ...families, ...named("fontWeight", "font/weight"), ...named("lineHeight", "leading"), ...named("letterSpacing", "tracking")];
}

function findPropertyBlock(block: string, key: string): string | null {
  const pattern = new RegExp(`(?:^|[\\s,])${key}\\s*:\\s*\\{`);
  const match = pattern.exec(block);
  if (!match) return null;

  const braceStart = block.indexOf("{", match.index + match[0].indexOf(key));
  if (braceStart === -1) return null;

  let depth = 1;
  let i = braceStart + 1;
  while (i < block.length && depth > 0) {
    if (block[i] === "{") depth++;
    else if (block[i] === "}") depth--;
    i++;
  }
  return block.slice(braceStart + 1, i - 1);
}

/**
 * A template literal's text, as a quoted string's is read: langflow and
 * ever-teams write their radius scale `calc(var(--radius) - 2px)` in
 * backticks, which were kept, so it had no px. Null when it interpolates
 * `${...}`, whose value is known only when the config runs.
 */
function templateString(literal: string): string | null {
  const text = literal.slice(1, -1);
  return text.includes("${") ? null : text.trim();
}

function flattenObject(block: string, prefix: string, tokens: TokenValue[], context: string, warnings: string[]): void {
  const pairs = extractKeyValuePairs(block);

  for (const [key, value] of pairs) {
    const name = prefix ? `${prefix}/${key}` : key;

    if (value.trim().startsWith("{")) {
      // Nested object - recurse
      flattenObject(value.slice(1, -1), name, tokens, context, warnings);
    } else {
      const literal = /^`[^`]*`$/.test(value.trim()) ? templateString(value.trim()) : undefined;
      if (literal === null) {
        warnings.push(`Skipped dynamic value: ${context} ${name} = ${value.trim()}`);
        continue;
      }
      const cleaned = literal ?? value.replace(/^['"]|['"]$/g, "").trim();
      if (cleaned && cleaned !== "...") {
        // Skip dynamic calls like theme() or require(), but allow CSS values that contain parentheses like rgb()
        const isDynamicCall = /(?:theme|require|resolve|fn)\s*\(/.test(cleaned);
        if (isDynamicCall) {
          warnings.push(`Skipped dynamic value: ${context} ${name} = ${cleaned}`);
        } else {
          tokens.push({ name, value: cleaned, group: prefix || undefined });
        }
      }
    }
  }
}

function extractKeyValuePairs(block: string): [string, string][] {
  const pairs: [string, string][] = [];
  // Match key: value or 'key': value or "key": value (keys can contain dots like '0.5')
  const regex = /(?:^|[\s,])['"]?([\w.-]+)['"]?\s*:\s*/g;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(block)) !== null) {
    const key = m[1];
    const valueStart = m.index + m[0].length;

    if (block[valueStart] === "{") {
      // Nested object
      let depth = 1;
      let i = valueStart + 1;
      while (i < block.length && depth > 0) {
        if (block[i] === "{") depth++;
        else if (block[i] === "}") depth--;
        i++;
      }
      pairs.push([key, block.slice(valueStart, i)]);
      regex.lastIndex = i;
    } else if (block[valueStart] === "[") {
      // Array value
      let depth = 1;
      let i = valueStart + 1;
      while (i < block.length && depth > 0) {
        if (block[i] === "[") depth++;
        else if (block[i] === "]") depth--;
        i++;
      }
      pairs.push([key, block.slice(valueStart, i)]);
      regex.lastIndex = i;
    } else {
      // Simple value - read until unbalanced comma, newline, or closing brace
      // Track paren depth so commas inside rgb(), rgba(), etc. are not treated as separators
      let i = valueStart;
      let parenDepth = 0;
      let inQuote: string | null = null;
      while (i < block.length) {
        const ch = block[i];
        if (inQuote) {
          // An escaped quote, as `"\"Geist Variable\", system-ui"` from a resolved theme, closes nothing.
          if (ch === "\\") i++;
          else if (ch === inQuote) inQuote = null;
        } else if (ch === "'" || ch === '"' || ch === "`") {
          inQuote = ch;
        } else if (ch === "(") {
          parenDepth++;
        } else if (ch === ")") {
          parenDepth--;
        } else if (parenDepth === 0 && (ch === "," || ch === "}" || ch === "\n")) {
          break;
        }
        i++;
      }
      const raw = block.slice(valueStart, i).trim();
      if (raw) {
        pairs.push([key, raw]);
        regex.lastIndex = i;
      }
    }
  }
  return pairs;
}

// --- Tailwind v4 @theme extraction ---

/**
 * The Tailwind v4 theme variable namespaces read as tokens, and their
 * categories. Colors, spacing, radii and shadows are named without the
 * namespace, as a Tailwind config's keys are: `--color-brand-500` is colors
 * `brand/500`, and the bare `--spacing` is spacing `DEFAULT`. Typography
 * holds several namespaces, so its names keep theirs: `--text-sm` is
 * `text/sm`, `--font-sans` `font/sans`, `--font-weight-bold`
 * `font/weight/bold`, `--leading-tight` `leading/tight`.
 */
const THEME_NAMESPACES: { namespace: string; category: TokenCategory; keepNamespace?: true }[] = [
  { namespace: "color", category: "colors" },
  { namespace: "spacing", category: "spacing" },
  { namespace: "radius", category: "radius" },
  { namespace: "shadow", category: "shadows" },
  { namespace: "text", category: "typography", keepNamespace: true },
  { namespace: "font", category: "typography", keepNamespace: true },
  { namespace: "leading", category: "typography", keepNamespace: true },
  { namespace: "tracking", category: "typography", keepNamespace: true },
];

/** A theme variable's category and token name, or null outside THEME_NAMESPACES. */
function themeToken(varName: string): { category: TokenCategory; name: string } | null {
  const bare = varName.slice(2);
  // --text-shadow-* is text shadows, not font sizes.
  if (bare.startsWith("text-shadow-")) return null;
  for (const { namespace, category, keepNamespace } of THEME_NAMESPACES) {
    if (bare !== namespace && !bare.startsWith(`${namespace}-`)) continue;
    if (keepNamespace) return { category, name: bare.replace(/-/g, "/") };
    const key = bare.slice(namespace.length + 1);
    return { category, name: key ? key.replace(/-/g, "/") : "DEFAULT" };
  }
  return null;
}

/** The bodies of a stylesheet's `@theme` blocks, `@theme inline` and the like included. */
function readThemeBlocks(css: string): string[] {
  const blocks: string[] = [];
  const start = /@theme\b[^{;]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(css)) !== null) {
    let depth = 1;
    let i = start.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    blocks.push(css.slice(start.lastIndex, i - 1));
    start.lastIndex = i;
  }
  return blocks;
}

/**
 * A block's own custom property declarations, in order, leaving out nested
 * rules such as the `@keyframes` a theme may hold. A name can end in `*`, as
 * in `--color-*: initial`, which clears a namespace.
 */
function readDeclarations(block: string): [string, string][] {
  let flat = "";
  let depth = 0;
  for (const ch of block) {
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; flat += ";"; }
    else if (depth === 0) flat += ch;
  }
  return [...flat.matchAll(/(?:^|[;\s])(--[\w-]*\*?)\s*:\s*([^;]+)/g)].map((d) => [d[1], d[2].trim()]);
}

/** Tailwind v4's own theme.css, whose variables a project's theme can refer to. */
function findTailwindDefaultTheme(projectPath: string): string | null {
  let dir = resolve(projectPath);
  for (;;) {
    const p = join(dir, "node_modules", "tailwindcss", "theme.css");
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The variables of a project's `@theme` blocks, in the order they are
 * declared, which is the order their tokens are listed in. Later
 * declarations win, as they do in Tailwind, and `initial` removes one, or
 * with `*` a namespace.
 */
function readThemeDeclarations(files: string[], warnings: string[]): Map<string, string> {
  const declared = new Map<string, string>();
  for (const file of files) {
    let css: string;
    try { css = readCss(file); } catch { warnings.push(`Could not read ${file}`); continue; }
    for (const block of readThemeBlocks(css)) {
      for (const [name, value] of readDeclarations(block)) {
        if (value !== "initial") declared.set(name, value);
        else if (name.endsWith("*")) {
          for (const key of declared.keys()) if (key.startsWith(name.slice(0, -1))) declared.delete(key);
        } else declared.delete(name);
      }
    }
  }
  return declared;
}

/**
 * What a theme variable's `var()` resolves against: Tailwind's default theme
 * when it is installed, the project's `:root` (shadcn/ui's v4 `@theme
 * inline` points at it) and the theme itself, each winning over the one
 * before.
 */
function themeVars(projectPath: string, root: Map<string, string>, declared: Map<string, string>): Map<string, string> {
  const vars = new Map<string, string>();
  const defaults = findTailwindDefaultTheme(projectPath);
  if (defaults) {
    try {
      for (const block of readThemeBlocks(readCss(defaults))) {
        for (const [name, value] of readDeclarations(block)) vars.set(name, value);
      }
    } catch { /* resolve without them */ }
  }
  for (const [name, value] of root) vars.set(name, value);
  for (const [name, value] of declared) vars.set(name, value);
  return vars;
}

/**
 * Whether a theme variable can be a token: not a namespace reset such as
 * `--color-*`, nor a modifier such as `--text-sm--line-height`, which
 * belongs to its token.
 */
function isThemeTokenName(varName: string): boolean {
  return !varName.endsWith("*") && !varName.slice(2).includes("--");
}

/**
 * Tokens from Tailwind v4's CSS-first theme: `@theme { --color-brand-500:
 * oklch(...); }`, with each `var()` resolved by themeVars. Tailwind's
 * defaults are not tokens themselves, as a Tailwind config's aren't. A
 * namespace that is no token category is reported as uncategorized.
 */
function extractFromTailwindTheme(files: string[], projectPath: string, darkFiles?: string[]): Extraction {
  const warnings: string[] = [];
  const declared = readThemeDeclarations(files, warnings);
  const root = readRootDeclarations(findCSSWithCustomProperties(projectPath), undefined, darkFiles);
  const vars = themeVars(projectPath, resolveRootVars(root), declared);
  // The same, with :root's as written, to say why a var() didn't resolve.
  const written = new Map(vars);
  for (const [name, value] of root) if (!declared.has(name)) written.set(name, value);

  const categorized: Record<TokenCategory, TokenValue[]> = {
    colors: [], spacing: [], typography: [], radius: [], shadows: [],
  };
  for (const [varName, value] of declared) {
    if (!isThemeTokenName(varName)) continue;
    const token = themeToken(varName);
    if (!token) {
      warnings.push(`Uncategorized: ${varName}: ${value}`);
      continue;
    }
    categorized[token.category].push({ name: token.name, value: resolveTailwindCssRefs(value, vars) });
  }

  const collections: TokenCollection[] = [];
  for (const [category, tokens] of Object.entries(categorized) as [TokenCategory, TokenValue[]][]) {
    if (tokens.length) collections.push({ category, tokens });
  }
  return { source: "tailwind", sourcePath: files[0], collections, warnings, vars, written, varsFrom: ":root or @theme" };
}

/**
 * Whether a theme variable's value refers to a `:root` custom property,
 * directly or through other theme variables.
 */
function refersToRoot(value: string, root: Map<string, string>, declared: Map<string, string>, seen = new Set<string>()): boolean {
  for (const [, name] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (root.has(name)) return true;
    const next = declared.get(name);
    if (next === undefined || seen.has(name)) continue;
    seen.add(name);
    if (refersToRoot(next, root, declared, seen)) return true;
  }
  return false;
}

/**
 * Adds to a `:root` extraction the project's `@theme` variables that are
 * built from `:root`'s. shadcn/ui's v4 globals.css keeps one radius in
 * `:root`, `--radius`, and the scale its components render in `@theme
 * inline`: `--radius-sm: calc(var(--radius) - 4px)`, and so on to 4xl. Read
 * through `:root` alone, the push had one radius to bind sm, md, lg and xl
 * to. So spacing, radius, shadow and typography variables whose value refers
 * to a `:root` variable are read too, named as `--source tailwind` names
 * them, which leaves every `:root` token's name and value as it was.
 * Colors aren't: `:root` already holds what `@theme`'s point at. A variable
 * `:root` declares itself is read from `:root`, and resolved to its `:root`
 * value, as it wins in the browser. The rest of `@theme`'s tokens are named
 * in a warning: those `--source tailwind` would read, and apart, those whose
 * var() it couldn't resolve either. `root` is `:root`'s variables as
 * written.
 */
function addRootDerivedTheme(
  projectPath: string,
  root: Map<string, string>,
  categorized: Record<TokenCategory, TokenValue[]>,
  warnings: string[],
): void {
  const files = findTailwindThemeCSS(projectPath);
  if (!files.length) return;
  const declared = readThemeDeclarations(files, warnings);
  // :root wins a variable both declare, for what a var() resolves to as for
  // which token is read: Tailwind puts @theme's variables in its theme
  // layer, which a :root unlayered or in the base layer overrides. With
  // @theme winning, `--radius` in both gave DEFAULT :root's value and sm one
  // worked out from @theme's.
  const vars = themeVars(projectPath, root, declared);
  for (const [name, value] of root) vars.set(name, value);
  // What isn't read, by category: what --source tailwind would read, and
  // what it would find unresolved too, as shadcn/ui's fonts, which next/font
  // sets at runtime. Told to pass --source tailwind for those, the user got
  // the same fonts back with an Unresolved warning.
  const left = new Map<TokenCategory, string[]>();
  const unresolved = new Map<TokenCategory, string[]>();
  const add = (to: Map<TokenCategory, string[]>, category: TokenCategory, entry: string) => to.set(category, [...(to.get(category) ?? []), entry]);
  for (const [varName, value] of declared) {
    if (!isThemeTokenName(varName) || root.has(varName)) continue;
    const token = themeToken(varName);
    if (!token) continue;
    const resolved = resolveTailwindCssRefs(value, vars);
    if (!refersToRoot(value, root, declared)) {
      const why = unresolvedRefs(resolved, vars, ":root or @theme");
      if (why) add(unresolved, token.category, `${token.name} (${why})`);
      else add(left, token.category, token.name);
      continue;
    }
    if (token.category === "colors") continue;
    if (categorized[token.category].some((t) => t.name === token.name)) continue;
    categorized[token.category].push({ name: token.name, value: resolved });
  }
  // A palette in @theme runs to hundreds, so each category names a few.
  const few = (names: string[]) => names.length > 8 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
  const named = (by: Map<TokenCategory, string[]>) => [...by].map(([category, names]) => `${category} ${few(names)}`).join("; ");
  if (left.size) {
    warnings.push(`Not read from @theme, since they aren't built from :root's variables: ${named(left)}. Pass --source tailwind to read @theme instead`);
  }
  // Starting `Unresolved:`, as a token kept with its var() as written is
  // named: the skill has the agent name every token such a warning names,
  // and these never reach Figma either.
  if (unresolved.size) {
    warnings.push(`Unresolved: not read from @theme, since a var() in them doesn't resolve: ${named(unresolved)}`);
  }
}

// --- CSS custom properties extraction ---

/**
 * The bare names of Tailwind's scales, which are their unnamed value, as
 * `@theme`'s bare `--spacing` is spacing `DEFAULT`. shadcn/ui's `:root`
 * holds its one radius as the bare `--radius`, which matched no prefix: it
 * was reported uncategorized, so no radius reached the push, `tokens --check`
 * or the Action, and a changed radius passed them all.
 */
const BARE_SCALES = new Map<string, TokenCategory>([
  ["--spacing", "spacing"],
  ["--radius", "radius"],
  ["--shadow", "shadows"],
]);

/**
 * Tokens from the project's `:root` custom properties, categorized by name,
 * or by value for a color, and named after the variable: `--radius-md` is
 * radius `radius/md`. A Tailwind v4 project's `@theme` variables built from
 * them are added by addRootDerivedTheme.
 */
function extractFromCSS(files: string[], projectPath: string, darkFiles?: string[]): Extraction {
  const warnings: string[] = [];
  const declared = readRootDeclarations(files, warnings, darkFiles);

  if (!declared.size) {
    return { source: "css", sourcePath: files[0] ?? "", collections: [], warnings: [...warnings, "No custom properties found"] };
  }

  // Resolve var() references — handles chains and var(--x, fallback)
  const allVars = resolveRootVars(declared);

  // Categorize by prefix
  const categorized: Record<TokenCategory, TokenValue[]> = {
    colors: [], spacing: [], typography: [], radius: [], shadows: [],
  };

  const colorPrefixes = ["--color-", "--clr-", "--bg-", "--border-color-"];
  const spacingPrefixes = ["--space-", "--spacing-", "--gap-", "--padding-", "--margin-"];
  const radiusPrefixes = ["--radius-", "--rounded-", "--border-radius-"];
  const fontPrefixes = ["--font-", "--text-size-", "--fs-", "--line-height-", "--lh-"];
  const shadowPrefixes = ["--shadow-", "--elevation-"];
  // --text-* is ambiguous: could be a text color (--text-primary: #000) or
  // a font size (--text-sm: 0.875rem). Decide by value.
  const textAmbiguousPrefix = "--text-";

  // Semantic color names (common in shadcn/ui, Radix, and custom design systems)
  const semanticColorNames = new Set([
    "--background", "--foreground", "--card", "--card-foreground",
    "--muted", "--muted-foreground", "--border", "--ring",
    "--primary", "--primary-foreground", "--secondary", "--secondary-foreground",
    "--accent", "--accent-foreground", "--destructive", "--destructive-foreground",
    "--popover", "--popover-foreground", "--input", "--overlay",
    "--background-contrast", "--success", "--success-foreground",
  ]);
  // Semantic color prefixes for families like --danger-50, --warning-700, --heatmap-0
  const semanticColorFamilies = [
    "--danger", "--warning", "--notice", "--error", "--info",
    "--heatmap", "--chart", "--status",
  ];

  for (const [varName, value] of allVars) {
    const shortName = varName.replace(/^--/, "").replace(/-/g, "/");

    const isSemanticColor = semanticColorNames.has(varName) ||
      semanticColorFamilies.some((f) => varName === f || varName.startsWith(f + "-"));

    if (colorPrefixes.some((p) => varName.startsWith(p)) || isSemanticColor || isColorValue(value)) {
      categorized.colors.push({ name: shortName, value });
    } else if (varName.startsWith(textAmbiguousPrefix)) {
      categorized.typography.push({ name: shortName, value });
    } else if (spacingPrefixes.some((p) => varName.startsWith(p))) {
      categorized.spacing.push({ name: shortName, value });
    } else if (radiusPrefixes.some((p) => varName.startsWith(p))) {
      categorized.radius.push({ name: shortName, value });
    } else if (fontPrefixes.some((p) => varName.startsWith(p))) {
      categorized.typography.push({ name: shortName, value });
    } else if (shadowPrefixes.some((p) => varName.startsWith(p))) {
      categorized.shadows.push({ name: shortName, value });
    } else if (BARE_SCALES.has(varName)) {
      categorized[BARE_SCALES.get(varName)!].push({ name: "DEFAULT", value });
    } else {
      warnings.push(`Uncategorized: ${varName}: ${value}`);
    }
  }

  addRootDerivedTheme(projectPath, declared, categorized, warnings);

  const collections: TokenCollection[] = [];
  for (const [category, tokens] of Object.entries(categorized) as [TokenCategory, TokenValue[]][]) {
    if (tokens.length) collections.push({ category, tokens });
  }

  return { source: "css", sourcePath: files[0], collections, warnings, vars: allVars, written: declared };
}

// Recursively resolve var(--name) and var(--name, fallback). Cycle/depth-guarded.
function resolveCssVar(value: string, allVars: Map<string, string>, depth: number): string {
  if (depth > 8) return value;
  const m = value.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (!m) return value;
  const [, name, fallback] = m;
  const ref = allVars.get(name);
  if (ref != null && ref !== value) return resolveCssVar(ref, allVars, depth + 1);
  if (fallback != null) return resolveCssVar(fallback.trim(), allVars, depth + 1);
  return value;
}

/**
 * Whether a custom property's value is a color, for one whose name doesn't
 * say. Every color function diff converts counts, so a token written in
 * lab(), lch(), oklab(), color(display-p3 ...) or hwb() is a color, as an
 * oklch() one always was, rather than being dropped as uncategorized, where
 * neither diff nor `tokens --check` would ever see it.
 */
function isColorValue(value: string): boolean {
  const v = value.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ||
    /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(v) ||
    BARE_HSL.test(v);
}

/**
 * Bare HSL channels, as shadcn/ui's `:root` holds its colors for a Tailwind
 * config's `hsl(var(--background))`: `0 0% 100%`, `240 5.9% 10%`, with an
 * optional `/ alpha`. Whole numbers only used to be read, so shadcn's
 * `--sidebar-primary: 240 5.9% 10%` was dropped as uncategorized.
 */
const BARE_HSL = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%(?:\s*\/\s*(?:\d+(?:\.\d+)?|\.\d+)%?)?$/;

/**
 * A color token's value as sRGB hex, or null when it is no color colorToHex
 * reads: an unresolved `var()`, `currentColor` or `color-mix()`. Bare HSL
 * channels are read as the hsl() they are written for; colorToHex alone
 * returned null for them, so diff compared `0 0% 100%` with Figma's `#ffffff`
 * as strings, a mismatch every time.
 */
export function tokenColorToHex(value: string): string | null {
  const v = value.trim();
  return colorToHex(BARE_HSL.test(v) ? `hsl(${v})` : v);
}

/**
 * A length in px, or null when it has no fixed one: px, rem at 16px, a
 * unitless 0, and calc() over px and rem with + - * / and parentheses,
 * nested calc() included, as shadcn/ui writes its radius scale
 * (`calc(0.625rem - 4px)`) and Tailwind v4 multiplies its spacing. em and %
 * depend on the element, and vw, min() and the rest on more, so they are
 * null, as is a number with no unit other than 0: a font weight or a
 * line-height ratio is no length. Rounded to thousandths, so 0.1rem is 1.6,
 * not 1.6000000000000001, and diff rounds Figma's float to match.
 *
 * Only what the browser accepts has a px, since a value it drops renders as
 * nothing: arithmetic outside calc() (`1rem/2`), + or - without a space on
 * each side (`calc(1rem-4px)` is one unknown unit to CSS), and a unitless 0
 * inside calc() (`calc(0 + 4px)`, where 0 is a number) are null.
 */
export function lengthToPx(value: string): number | null {
  const src = value.trim().toLowerCase();
  const round = (n: number) => Math.round(n * 1000) / 1000 + 0; // + 0 makes -0 plain 0.
  if (!src.startsWith("calc(")) {
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|rem)?$/.exec(src);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!m[2]) return n === 0 ? 0 : null;
    return round(m[2] === "rem" ? n * 16 : n);
  }
  let i = 0;
  // A term's px, or its number when it has no unit. A syntax error, or an
  // operation CSS has no length for, throws, and the value is null.
  type Term = { n: number; length: boolean };
  const space = (at: number) => /\s/.test(src[at] ?? "");
  const skip = () => { while (space(i)) i++; };
  const close = () => { skip(); if (src[i++] !== ")") throw new Error("no )"); };
  const atom = (): Term => {
    skip();
    if (src.startsWith("calc(", i) || src[i] === "(") {
      i = src.indexOf("(", i) + 1;
      const t = sum();
      close();
      return t;
    }
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(px|rem)?(?![\w%.-])/.exec(src.slice(i));
    if (!m) throw new Error("no length");
    i += m[0].length;
    const n = parseFloat(m[0]);
    return m[1] === "rem" ? { n: n * 16, length: true } : { n, length: m[1] === "px" };
  };
  const product = (): Term => {
    let t = atom();
    for (skip(); src[i] === "*" || src[i] === "/"; skip()) {
      const op = src[i++];
      const r = atom();
      if (op === "*" ? t.length && r.length : r.length || r.n === 0) throw new Error("no length");
      t = op === "*" ? { n: t.n * r.n, length: t.length || r.length } : { n: t.n / r.n, length: t.length };
    }
    return t;
  };
  const sum = (): Term => {
    let t = product();
    for (skip(); src[i] === "+" || src[i] === "-"; skip()) {
      // CSS reads `1rem-4px` as one dimension, and `1rem -4px` as two values.
      if (!space(i - 1) || !space(i + 1)) throw new Error("no space around + or -");
      const op = src[i++];
      const r = product();
      // A length and a number don't add, a unitless 0 included.
      if (t.length !== r.length) throw new Error("no length");
      t = { n: op === "+" ? t.n + r.n : t.n - r.n, length: t.length };
    }
    return t;
  };
  try {
    const t = atom();
    skip();
    if (i !== src.length || !t.length || !Number.isFinite(t.n)) return null;
    return round(t.n);
  } catch {
    return null;
  }
}

// --- Theme file extraction ---

function extractFromTheme(filePath: string): Extraction {
  const content = stripComments(readFileSync(filePath, "utf8"));
  const warnings: string[] = [];
  const collections: TokenCollection[] = [];

  // Look for exported objects: export const colors = { ... }
  const exportPattern = /export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = exportPattern.exec(content)) !== null) {
    const name = m[1].toLowerCase();
    const braceStart = content.lastIndexOf("{", m.index + m[0].length);
    let depth = 1;
    let i = braceStart + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      i++;
    }
    const block = content.slice(braceStart + 1, i - 1);

    const category = mapNameToCategory(name);
    if (category) {
      const tokens: TokenValue[] = [];
      flattenObject(block, "", tokens, name, warnings);
      if (tokens.length) collections.push({ category, tokens });
    }
  }

  // Also try: export default { colors: { ... }, spacing: { ... } }
  if (!collections.length) {
    const defaultExport = content.match(/export\s+default\s+\{/);
    if (defaultExport) {
      const braceStart = content.indexOf("{", defaultExport.index);
      let depth = 1;
      let i = braceStart + 1;
      while (i < content.length && depth > 0) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") depth--;
        i++;
      }
      const outerBlock = content.slice(braceStart + 1, i - 1);

      for (const key of ["colors", "colour", "spacing", "space", "borderRadius", "radii", "radius", "fontSize", "fontSizes", "typography", "shadows", "boxShadow"]) {
        const propBlock = findPropertyBlock(outerBlock, key);
        if (!propBlock) continue;
        const category = mapNameToCategory(key);
        if (!category) continue;
        const tokens: TokenValue[] = [];
        flattenObject(propBlock, "", tokens, key, warnings);
        if (tokens.length) collections.push({ category, tokens });
      }
    }
  }

  return { source: "theme", sourcePath: filePath, collections, warnings, varsFrom: "the theme file" };
}

function mapNameToCategory(name: string): TokenCategory | null {
  const lower = name.toLowerCase();
  if (lower.includes("color") || lower.includes("colour") || lower === "palette") return "colors";
  if (lower.includes("space") || lower.includes("spacing") || lower === "gap") return "spacing";
  if (lower.includes("radius") || lower.includes("radii") || lower.includes("borderradius") || lower.includes("rounded")) return "radius";
  if (lower.includes("font") || lower.includes("typo") || lower.includes("text")) return "typography";
  if (lower.includes("shadow") || lower.includes("elevation")) return "shadows";
  return null;
}

// --- Drift checking ---

export interface TokenBaseline {
  version: 1;
  source: TokenSourceType;
  sourcePath: string;
  collections: TokenCollection[];
  generatedAt: string;
  /** As TokenExtractionResult's: absent from a baseline an earlier storysync wrote, which `--check` compares no dark values against. */
  modes?: string[];
}

/**
 * Reads a baseline for `tokens --check`. `tokens --json` writes one: only its
 * `collections` are compared. Null when the file does not exist, which the
 * caller reports; throws when it exists but is not a baseline — for instance
 * the saved output of a passing `--check --json`, which is only `{"drift":false}`.
 *
 * Every collection needs a `category` and a `tokens` list, and every token a
 * `name` and a `value`, all as `tokens --json` writes them. `{"collections":[{}]}`
 * used to crash the text report and pass under --json, listing a removed
 * collection with no name.
 */
export function readTokenBaseline(path: string): TokenBaseline | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read the token baseline at ${path}: ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The token baseline at ${path} is not valid JSON: ${String(err)}`);
  }
  const collections = (parsed as Partial<TokenBaseline> | null)?.collections;
  if (!Array.isArray(collections)) {
    throw new Error(`The token baseline at ${path} has no "collections", so it is not a baseline`);
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  for (const collection of collections as unknown[]) {
    if (!isRecord(collection) || typeof collection.category !== "string" || !Array.isArray(collection.tokens)) {
      throw new Error(`The token baseline at ${path} has a collection without a "category" and a "tokens" list, so it is not a baseline`);
    }
    if (!collection.tokens.every((t: unknown) => isRecord(t) && typeof t.name === "string" && typeof t.value === "string")) {
      throw new Error(`The token baseline at ${path} has a ${collection.category} token without a "name" and a "value", so it is not a baseline`);
    }
    if (!collection.tokens.every((t: Record<string, unknown>) => t.dark === undefined || (isRecord(t.dark) && typeof t.dark.value === "string"))) {
      throw new Error(`The token baseline at ${path} has a ${collection.category} token whose "dark" has no "value", so it is not a baseline`);
    }
  }
  return parsed as TokenBaseline;
}

/**
 * The shell command that writes a baseline `--check` can read, for the same
 * project and source. The directory is created first because the default,
 * `.storysync/`, need not exist yet, and a redirect into it would fail.
 */
export function baselineCommand(path: string, opts: { project?: string; source?: string } = {}): string {
  const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const args = ["storysync", "tokens"];
  if (opts.project && opts.project !== ".") args.push("--project", quote(opts.project));
  if (opts.source) args.push("--source", quote(opts.source));
  args.push("--json", ">", quote(path));
  const dir = dirname(path);
  return `${dir === "." ? "" : `mkdir -p -- ${quote(dir)} && `}${args.join(" ")}`;
}

export interface TokenDrift {
  added: { category: TokenCategory; tokens: TokenValue[] }[];
  removed: { category: TokenCategory; tokens: TokenValue[] }[];
  /** A token's value changed, or with `mode: "Dark"`, its dark theme's. */
  changed: { category: TokenCategory; token: string; from: string; to: string; mode?: "Dark" }[];
  /**
   * The baseline was written by a storysync that didn't read the dark
   * theme, so the dark values the current tokens have weren't compared.
   */
  darkNotChecked?: boolean;
}

/**
 * Every token of each category, one per name, the last of a name winning, as
 * diff pairs them. A theme file's `fontSizes` and `fontWeights` are two
 * typography collections; keyed by category alone, only the last was compared,
 * so a changed font size passed --check, and dropping `fontWeights` reported
 * the sizes as added. A name listed twice compares once, so a baseline that
 * holds a duplicate checks clean against the same extraction.
 */
function tokensByCategory(collections: TokenCollection[]): Map<TokenCategory, Map<string, TokenValue>> {
  const byCategory = new Map<TokenCategory, Map<string, TokenValue>>();
  for (const collection of collections) {
    const tokens = byCategory.get(collection.category) ?? new Map<string, TokenValue>();
    for (const token of collection.tokens) tokens.set(token.name, token);
    byCategory.set(collection.category, tokens);
  }
  return byCategory;
}

/**
 * What changed from `baseline` to `current`. A token's dark value is
 * compared only against a baseline that has `modes`, one a storysync that
 * reads the dark theme wrote: an earlier one's has no dark values, and
 * would otherwise report every dark token as changed. Its dark value is
 * its light one where it has none, as in the browser, so a token whose
 * light value changed, with no dark value on either side, changed once.
 */
export function compareTokens(baseline: TokenBaseline, current: TokenExtractionResult): TokenDrift {
  const drift: TokenDrift = { added: [], removed: [], changed: [] };
  const darkChecked = Array.isArray(baseline.modes);
  if (!darkChecked && current.collections.some((c) => c.tokens.some((t) => t.dark))) drift.darkNotChecked = true;

  // A baseline from before holds a radius DEFAULT that repeats a step,
  // which extraction now leaves out: neither side compares it.
  const baseMap = tokensByCategory(withoutRepeatedDefault(baseline.collections));
  const currMap = tokensByCategory(withoutRepeatedDefault(current.collections));

  // Find added and changed
  for (const [category, currTokens] of currMap) {
    const baseTokens = baseMap.get(category);
    if (!baseTokens) {
      drift.added.push({ category, tokens: [...currTokens.values()] });
      continue;
    }
    const newTokens: TokenValue[] = [];

    for (const token of currTokens.values()) {
      const base = baseTokens.get(token.name);
      if (!base) {
        newTokens.push(token);
      } else {
        if (base.value !== token.value) drift.changed.push({ category, token: token.name, from: base.value, to: token.value });
        const [was, now] = [base.dark?.value, token.dark?.value];
        if (darkChecked && (was !== undefined || now !== undefined) && (was ?? base.value) !== (now ?? token.value)) {
          drift.changed.push({ category, token: token.name, from: was ?? base.value, to: now ?? token.value, mode: "Dark" });
        }
      }
    }
    if (newTokens.length) drift.added.push({ category, tokens: newTokens });
  }

  // Find removed
  for (const [category, baseTokens] of baseMap) {
    const currTokens = currMap.get(category);
    if (!currTokens) {
      drift.removed.push({ category, tokens: [...baseTokens.values()] });
      continue;
    }
    const removedTokens = [...baseTokens.values()].filter((t) => !currTokens.has(t.name));
    if (removedTokens.length) drift.removed.push({ category, tokens: removedTokens });
  }

  return drift;
}

export function hasDrift(drift: TokenDrift): boolean {
  return drift.added.length > 0 || drift.removed.length > 0 || drift.changed.length > 0;
}
