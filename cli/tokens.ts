// Design token extraction from project source files.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
}

/**
 * Reads `--source`, as tokens and diff take it: one of TOKEN_SOURCES, or
 * undefined when it was left out or is `auto`, for the source to be
 * detected. `auto` is the drift-check action's token_source default, which
 * the README has action users pass on to `tokens --source` for their
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

const TAILWIND_CONFIGS = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];

function findTailwindConfig(projectPath: string): string | null {
  for (const name of TAILWIND_CONFIGS) {
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
 */
export function detectTokenSource(projectPath: string): DetectedSource | null {
  const config = findTailwindConfig(projectPath);
  if (config) return { type: "tailwind", path: config };

  const cssFiles = findCSSWithCustomProperties(projectPath);
  if (cssFiles.length) return { type: "css", path: cssFiles[0] };

  const themeCss = findTailwindThemeCSS(projectPath);
  if (themeCss.length) return { type: "tailwind", path: themeCss[0] };

  const themeFile = findThemeFile(projectPath);
  if (themeFile) return { type: "theme", path: themeFile };

  return null;
}

function findCSSWithCustomProperties(projectPath: string): string[] {
  return findCSS(projectPath, (css) => /:root\s*\{/.test(css) && /--[\w-]+\s*:/.test(css));
}

/** Stylesheets with a Tailwind v4 `@theme` block that declares a variable. */
function findTailwindThemeCSS(projectPath: string): string[] {
  return findCSS(projectPath, (css) => readThemeBlocks(css).some((block) => readDeclarations(block).length > 0));
}

/** The project's stylesheets, CSS modules aside, whose text without comments passes `test`. */
function findCSS(projectPath: string, test: (css: string) => boolean): string[] {
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

function walkCSS(dir: string, results: string[], test: (css: string) => boolean, depth: number): void {
  if (depth > 5) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "build") continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walkCSS(full, results, test, depth + 1);
    } else if (entry.endsWith(".css") && !entry.endsWith(".module.css")) {
      try {
        if (test(readCss(full))) results.push(full);
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
 * has only block comments: there `//` can start an unquoted `url(//cdn...)`.
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
  for (const collection of result.collections) {
    collection.tokens = collection.tokens.map((token) => {
      // `value` stays as the source writes it, for --check. CSS custom
      // properties resolve a var() only when it is the whole value, so
      // `calc(var(--radius) - 4px)` is resolved here, for hex and px alone.
      const resolved = vars ? resolveTailwindCssRefs(token.value, vars) : token.value;
      const unresolved = unresolvedRefs(resolved, written ?? vars, varsFrom ?? ":root", token.value);
      if (unresolved) result.warnings.push(`Unresolved: ${collection.category} ${token.name} = ${token.value} (${unresolved})`);
      if (collection.category === "colors") {
        const hex = tokenColorToHex(resolved);
        return hex ? { ...token, hex } : token;
      }
      if (LENGTH_CATEGORIES.has(collection.category)) {
        const px = lengthToPx(resolved);
        return px === null ? token : { ...token, px };
      }
      return token;
    });
  }
  return result;
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
 * follows: eight var()s deep, or a var() in a var()'s fallback.
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

function extractFromSource(projectPath: string, sourceType?: TokenSourceType): Extraction {
  if (sourceType) {
    switch (sourceType) {
      case "tailwind": {
        const config = findTailwindConfig(projectPath);
        if (config) return extractFromTailwind(config, projectPath);
        const themeCss = findTailwindThemeCSS(projectPath);
        if (themeCss.length) return extractFromTailwindTheme(themeCss, projectPath);
        return { source: "tailwind", sourcePath: "", collections: [], warnings: ["No tailwind.config or CSS @theme block found"] };
      }
      case "css": {
        const files = findCSSWithCustomProperties(projectPath);
        if (files.length) return extractFromCSS(files, projectPath);
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

  switch (detected.type) {
    case "tailwind":
      return detected.path.endsWith(".css")
        ? extractFromTailwindTheme(findTailwindThemeCSS(projectPath), projectPath)
        : extractFromTailwind(detected.path, projectPath);
    case "css": return extractFromCSS(findCSSWithCustomProperties(projectPath), projectPath);
    case "theme": return extractFromTheme(detected.path);
  }
}

// --- Tailwind extraction ---

function extractFromTailwind(configPath: string, projectRoot?: string): Extraction {
  const content = stripComments(readFileSync(configPath, "utf8"));
  const warnings: string[] = [];
  const collections: TokenCollection[] = [];

  if (/require\s*\(/.test(content)) {
    warnings.push("Config uses require() - some values may not be extracted");
  }
  if (/\.\.\./.test(content)) {
    warnings.push("Config uses spread syntax - some values may not be extracted");
  }

  // Extract theme.extend and theme objects
  const themeBlocks = extractThemeBlocks(content);

  const colorTokens = extractTailwindColors(themeBlocks, warnings);
  if (colorTokens.length) collections.push({ category: "colors", tokens: colorTokens });

  const spacingTokens = extractTailwindFlat(themeBlocks, "spacing");
  if (spacingTokens.length) collections.push({ category: "spacing", tokens: spacingTokens });

  const radiusTokens = extractTailwindFlat(themeBlocks, "borderRadius");
  if (radiusTokens.length) collections.push({ category: "radius", tokens: radiusTokens });

  const fontTokens = extractTailwindTypography(themeBlocks);
  if (fontTokens.length) collections.push({ category: "typography", tokens: fontTokens });

  const shadowTokens = extractTailwindFlat(themeBlocks, "boxShadow");
  if (shadowTokens.length) collections.push({ category: "shadows", tokens: shadowTokens });

  // Resolve any `var(--name)` refs in token values against the project's :root CSS vars.
  // Common in shadcn/ui: `colors: { background: "hsl(var(--background))" }` with the actual
  // value defined in globals.css as `:root { --background: 0 0% 100%; }`.
  const root = projectRoot ?? join(configPath, "..");
  const cssFiles = findCSSWithCustomProperties(root);
  let vars: Map<string, string> | undefined;
  let written: Map<string, string> | undefined;
  if (cssFiles.length && collectionsHaveCssVarRefs(collections)) {
    const declared = readRootDeclarations(cssFiles);
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

function collectionsHaveCssVarRefs(collections: TokenCollection[]): boolean {
  for (const c of collections) {
    for (const t of c.tokens) {
      if (/var\(\s*--/.test(t.value)) return true;
    }
  }
  return false;
}

/**
 * Where a stylesheet's `@media (prefers-color-scheme: dark)` blocks start
 * and end. The `:root` in one holds the dark values, as create-next-app's
 * globals.css does: read in order with the rest, it overrode the light ones,
 * so its background was extracted as #0a0a0a. `@media not ...` is light.
 */
function darkSchemeRanges(css: string): [number, number][] {
  const ranges: [number, number][] = [];
  const start = /@media\b([^{;]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(css)) !== null) {
    if (!/prefers-color-scheme\s*:\s*dark/i.test(m[1]) || /\bnot\b/i.test(m[1])) continue;
    let depth = 1;
    let i = start.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    ranges.push([m.index, i]);
  }
  return ranges;
}

/**
 * The custom properties of the stylesheets' `:root` blocks, as written, a
 * later declaration winning, leaving out a `:root` for the dark color
 * scheme. A file that can't be read is skipped, and named in `warnings`
 * when there are any.
 */
function readRootDeclarations(files: string[], warnings?: string[]): Map<string, string> {
  const declared = new Map<string, string>();
  for (const file of files) {
    try {
      const content = readCss(file);
      const dark = darkSchemeRanges(content);
      const rootBlocks = content.matchAll(/:root\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g);
      for (const block of rootBlocks) {
        if (dark.some(([from, to]) => block.index >= from && block.index < to)) continue;
        const declarations = block[1].matchAll(/\s*(--[\w-]+)\s*:\s*([^;}]+);?/g);
        for (const decl of declarations) {
          declared.set(decl[1].trim(), decl[2].trim());
        }
      }
    } catch {
      warnings?.push(`Could not read ${file}`);
    }
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

// Replace `var(--name)` and `var(--name, fallback)` inside a Tailwind token value.
// Also strips Tailwind's `<alpha-value>` opacity placeholder.
export function resolveTailwindCssRefs(value: string, cssVars: Map<string, string>): string {
  // Strip Tailwind opacity placeholder: `hsl(var(--bg) / <alpha-value>)` → `hsl(var(--bg))`
  let s = value.replace(/\s*\/\s*<alpha-value>\s*/g, "");

  // Replace each var(--name) or var(--name, fallback) with its resolved CSS value (depth-guarded).
  for (let depth = 0; depth < 8 && /var\(\s*--/.test(s); depth++) {
    s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/g, (_match, name: string, fallback?: string) => {
      const resolved = cssVars.get(name);
      if (resolved != null) return resolved;
      if (fallback != null) return fallback.trim();
      return _match;
    });
  }
  return s.trim();
}

interface ThemeBlocks {
  extend: string;
  root: string;
}

function extractThemeBlocks(content: string): ThemeBlocks {
  const rootMatch = findBalancedBlock(content, /theme\s*:\s*\{/);
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

function extractTailwindFlat(blocks: ThemeBlocks, key: string): TokenValue[] {
  const tokens: TokenValue[] = [];
  for (const block of [blocks.extend, blocks.root]) {
    if (!block) continue;
    const propBlock = findPropertyBlock(block, key);
    if (!propBlock) continue;
    flattenObject(propBlock, "", tokens, key, []);
    if (tokens.length) break;
  }
  return tokens;
}

function extractTailwindTypography(blocks: ThemeBlocks): TokenValue[] {
  const tokens: TokenValue[] = [];
  for (const block of [blocks.extend, blocks.root]) {
    if (!block) continue;
    const propBlock = findPropertyBlock(block, "fontSize");
    if (!propBlock) continue;

    // fontSize can be { sm: '0.875rem' } or { sm: ['0.875rem', { lineHeight: '1.25rem' }] }
    const pairs = extractKeyValuePairs(propBlock);
    for (const [name, value] of pairs) {
      // Handle array values - take just the size
      const sizeMatch = value.match(/^\[?\s*['"]?([^'"[\],]+)/);
      const resolved = sizeMatch ? sizeMatch[1].trim() : value;
      tokens.push({ name, value: resolved });
    }
    if (tokens.length) break;
  }
  return tokens;
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

function flattenObject(block: string, prefix: string, tokens: TokenValue[], _context: string, warnings: string[]): void {
  const pairs = extractKeyValuePairs(block);

  for (const [key, value] of pairs) {
    const name = prefix ? `${prefix}/${key}` : key;

    if (value.trim().startsWith("{")) {
      // Nested object - recurse
      flattenObject(value.slice(1, -1), name, tokens, _context, warnings);
    } else {
      const cleaned = value.replace(/^['"]|['"]$/g, "").trim();
      if (cleaned && cleaned !== "...") {
        // Skip dynamic calls like theme() or require(), but allow CSS values that contain parentheses like rgb()
        const isDynamicCall = /(?:theme|require|resolve|fn)\s*\(/.test(cleaned);
        if (isDynamicCall) {
          warnings.push(`Skipped dynamic value: ${name} = ${cleaned}`);
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
          if (ch === inQuote) inQuote = null;
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
function extractFromTailwindTheme(files: string[], projectPath: string): Extraction {
  const warnings: string[] = [];
  const declared = readThemeDeclarations(files, warnings);
  const root = readRootDeclarations(findCSSWithCustomProperties(projectPath));
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
  if (unresolved.size) {
    warnings.push(`Not read from @theme, since a var() in them doesn't resolve: ${named(unresolved)}`);
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
function extractFromCSS(files: string[], projectPath: string): Extraction {
  const warnings: string[] = [];
  const declared = readRootDeclarations(files, warnings);

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
  changed: { category: TokenCategory; token: string; from: string; to: string }[];
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

export function compareTokens(baseline: TokenBaseline, current: TokenExtractionResult): TokenDrift {
  const drift: TokenDrift = { added: [], removed: [], changed: [] };

  const baseMap = tokensByCategory(baseline.collections);
  const currMap = tokensByCategory(current.collections);

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
      } else if (base.value !== token.value) {
        drift.changed.push({ category, token: token.name, from: base.value, to: token.value });
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
