// Component styling inspector. Reads a React component's source file,
// parses CVA / Tailwind class lists, resolves utilities to concrete pixel
// and hex values via the project's token map, and emits a per-variant
// styling spec that the push workflow can hand to `use_figma` directly —
// instead of letting the agent re-derive everything from raw source.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname, extname, resolve } from "node:path";
import { extractTokens, type TokenCollection } from "./tokens.js";

export interface ResolvedStyling {
  fill?: string | null;
  text?: string | null;
  border?: string | null;
  borderColor?: string | null;
  borderStyle?: "solid" | "dashed" | "dotted" | "double" | "none" | null;
  borderRadius?: string | null;
  padding?: string | null;
  fontFamily?: string | null;
  fontSize?: string | null;
  fontWeight?: string | null;
  fontStyle?: "italic" | "normal" | null;
  lineHeight?: string | null;
  letterSpacing?: string | null;
  textAlign?: "left" | "center" | "right" | "justify" | null;
  textTransform?: "uppercase" | "lowercase" | "capitalize" | "none" | null;
  textDecoration?: "underline" | "line-through" | "overline" | "none" | null;
  shadow?: string | null;
  gap?: string | null;
  layout?: "row" | "column" | null;
  alignItems?: "start" | "end" | "center" | "stretch" | "baseline" | null;
  justifyContent?: "start" | "end" | "center" | "between" | "around" | "evenly" | null;
  opacity?: string | null;
}

export interface FieldBinding {
  token: string;
  collection: "colors" | "spacing" | "radius" | "shadows" | "typography";
}

// Per-field token provenance. Present only for fields whose value resolved
// through a project token (not a Tailwind default or arbitrary value), so
// the agent can bind the Figma property to the variable instead of writing
// a literal that's ambiguous on the way back.
export type Bindings = Partial<Record<keyof ResolvedStyling, FieldBinding>>;

export interface InspectVariant {
  name: string;
  defaultValue: string | null;
  values: Record<string, ResolvedStyling>;
  bindings: Record<string, Bindings>;
}

export interface InspectionResult {
  name: string;
  path: string | null;
  base: ResolvedStyling;
  baseBindings: Bindings;
  variants: InspectVariant[];
  unresolved: string[];
  warnings: string[];
}

// --- Component file lookup ---

const COMPONENT_DIRS = ["src/components", "components", "app/components", "src/ui", "ui"];

export function findComponentFile(projectPath: string, nameOrPath: string): string | null {
  // If the input looks like a path that exists, use it directly.
  const direct = resolve(projectPath, nameOrPath);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;

  const lowered = nameOrPath.toLowerCase();
  const candidates: string[] = [];

  for (const rel of COMPONENT_DIRS) {
    const dir = join(projectPath, rel);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    walkForComponent(dir, lowered, candidates, 0);
  }

  if (!candidates.length) return null;

  // Prefer exact basename match, then shortest path.
  candidates.sort((a, b) => {
    const aBase = basename(a, extname(a)).toLowerCase();
    const bBase = basename(b, extname(b)).toLowerCase();
    if (aBase === lowered && bBase !== lowered) return -1;
    if (bBase === lowered && aBase !== lowered) return 1;
    return a.length - b.length;
  });
  return candidates[0];
}

function walkForComponent(dir: string, target: string, out: string[], depth: number): void {
  if (depth > 6) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry.startsWith(".")) continue;
      walkForComponent(full, target, out, depth + 1);
      continue;
    }
    const ext = extname(entry);
    if (ext !== ".tsx" && ext !== ".jsx" && ext !== ".ts" && ext !== ".js") continue;
    const base = basename(entry, ext).toLowerCase();
    if (base === target || base.replace(/[-_]/g, "") === target.replace(/[-_]/g, "")) {
      out.push(full);
    }
  }
}

// --- Top-level inspect ---

export function inspectComponent(projectPath: string, nameOrPath: string): InspectionResult | null {
  const path = findComponentFile(projectPath, nameOrPath);
  if (!path) return null;

  const source = readFileSync(path, "utf8");
  const name = basename(path, extname(path));

  const { map: tokenMap, warning: tokenWarning } = buildTokenMap(projectPath);
  const cva = parseCvaCall(source) ?? parseCnCall(source);
  if (cva) cva.defaults = { ...inferDefaultsFromPropDestructure(source), ...cva.defaults };

  const result: InspectionResult = {
    name,
    path,
    base: {},
    baseBindings: {},
    variants: [],
    unresolved: [],
    warnings: [],
  };
  if (tokenWarning) result.warnings.push(tokenWarning);

  const pushWarning = (w: string) => {
    if (!result.warnings.includes(w)) result.warnings.push(w);
  };

  if (!cva) {
    // Neither cva() nor a recognized cn()/clsx() conditional pattern. Fall
    // back to scanning bare className="..." strings on JSX tags so simple
    // components still emit something useful.
    const classNames = extractInlineClassNames(source);
    if (!classNames.length) {
      result.warnings.push("No cva(), cn()/clsx() conditional pattern, or className strings found; nothing to resolve.");
      return result;
    }
    const all = classNames.flatMap((c) => splitClasses(c));
    const { styling, bindings, unresolved, warnings } = resolveClasses(all, tokenMap);
    result.base = styling;
    result.baseBindings = bindings;
    result.unresolved.push(...unresolved);
    for (const w of warnings) pushWarning(w);
    result.warnings.push("No variant pattern detected; base styling collapses all className strings.");
    return result;
  }

  const baseClasses = splitClasses(cva.base);
  const { styling: baseStyling, bindings: baseBindings, unresolved: baseUnresolved, warnings: baseWarnings } = resolveClasses(baseClasses, tokenMap);
  result.base = baseStyling;
  result.baseBindings = baseBindings;
  result.unresolved.push(...baseUnresolved);
  for (const w of baseWarnings) pushWarning(w);

  for (const [variantName, valueMap] of Object.entries(cva.variants)) {
    const variant: InspectVariant = {
      name: variantName,
      defaultValue: cva.defaults[variantName] ?? null,
      values: {},
      bindings: {},
    };
    for (const [valueName, classes] of Object.entries(valueMap)) {
      const { styling, bindings, unresolved, warnings } = resolveClasses(splitClasses(classes), tokenMap);
      variant.values[valueName] = styling;
      variant.bindings[valueName] = bindings;
      for (const u of unresolved) if (!result.unresolved.includes(u)) result.unresolved.push(u);
      for (const w of warnings) pushWarning(w);
    }
    result.variants.push(variant);
  }

  if (cva.compoundCount > 0) {
    result.warnings.push(
      `Component has ${cva.compoundCount} compoundVariants entries that aren't representable in Figma's per-axis variant model — those styles are NOT in this output. Either flatten them by hand or skip the variant combinations they target.`,
    );
  }

  return result;
}

// --- CVA parser ---

interface ParsedCva {
  base: string;
  variants: Record<string, Record<string, string>>;
  defaults: Record<string, string>;
  compoundCount: number;
}

export function parseCvaCall(source: string): ParsedCva | null {
  const callIdx = findCvaCall(source);
  if (callIdx < 0) return null;

  // Walk to the opening `(` and then read balanced contents.
  const open = source.indexOf("(", callIdx);
  if (open < 0) return null;
  const close = matchClose(source, open, "(", ")");
  if (close < 0) return null;

  const args = splitTopLevelArgs(source.slice(open + 1, close));
  if (!args.length) return null;

  const base = readStringOrTemplate(args[0]);
  if (base == null) return null;

  const config = args.length >= 2 ? args[1].trim() : "";
  const variants: Record<string, Record<string, string>> = {};
  const defaults: Record<string, string> = {};
  let compoundCount = 0;

  if (config.startsWith("{")) {
    const variantsBlock = readObjectField(config, "variants");
    if (variantsBlock) {
      for (const [vName, vBody] of iterateObjectEntries(variantsBlock)) {
        if (!vBody.startsWith("{")) continue;
        const inner: Record<string, string> = {};
        for (const [valName, valBody] of iterateObjectEntries(vBody)) {
          const str = readStringOrTemplate(valBody);
          if (str != null) inner[valName] = str;
        }
        if (Object.keys(inner).length) variants[vName] = inner;
      }
    }
    const defaultsBlock = readObjectField(config, "defaultVariants");
    if (defaultsBlock) {
      for (const [vName, vBody] of iterateObjectEntries(defaultsBlock)) {
        const str = readStringOrTemplate(vBody);
        if (str != null) defaults[vName] = str;
      }
    }
    // CVA's compoundVariants apply styling only when multiple variant values
    // co-occur (e.g. variant=primary AND size=sm). They can't be expressed
    // in Figma's per-axis variant model, so we count them and surface a
    // warning rather than silently dropping the styling.
    const compoundsBlock = readArrayField(config, "compoundVariants");
    if (compoundsBlock) {
      compoundCount = countTopLevelObjects(compoundsBlock);
    }
  }

  return { base, variants, defaults, compoundCount };
}

// Parses the hand-rolled "cn(base, cond === 'val' && 'classes', ...)" pattern
// — extremely common in shadcn/ui-derived codebases and anywhere a maintainer
// preferred conditional class strings over CVA. Each conditional argument
// becomes a synthetic variant entry, so the same downstream resolver can
// handle both this shape and the CVA shape uniformly.
//
// Recognized arguments:
//   'string literal'                  → base classes
//   `template literal`                → base classes
//   varName === 'value' && '...'      → variant value
//   'value' === varName && '...'      → variant value (other order)
//   varName && '...'                  → boolean variant (true case)
//   !varName && '...'                 → boolean variant (false case)
//   identifier (e.g. className)       → ignored
//
// Things deliberately not supported (would expand surface for marginal gain):
//   ternaries (cond ? a : b), object syntax (cn({ active: x })),
//   nested cn() calls, cn(...spread).
export function parseCnCall(source: string): ParsedCva | null {
  const callIdx = findClassMergerCall(source);
  if (callIdx < 0) return null;

  const open = source.indexOf("(", callIdx);
  if (open < 0) return null;
  const close = matchClose(source, open, "(", ")");
  if (close < 0) return null;

  const args = splitTopLevelArgs(stripComments(source.slice(open + 1, close)));
  if (!args.length) return null;

  const baseParts: string[] = [];
  const variants: Record<string, Record<string, string>> = {};

  const addVariantClasses = (varName: string, valueName: string, classes: string) => {
    if (!variants[varName]) variants[varName] = {};
    const existing = variants[varName][valueName];
    variants[varName][valueName] = existing ? `${existing} ${classes}` : classes;
  };

  for (const rawArg of args) {
    const arg = rawArg.trim();
    if (!arg) continue;

    // Plain string or template literal → base classes
    const lit = readStringOrTemplate(arg);
    if (lit !== null) {
      baseParts.push(lit);
      continue;
    }

    // Equality conditional: `varName === 'value' && '...'` or `'value' === varName && '...'`
    const eq = arg.match(/^(.+?)\s*===\s*(.+?)\s*&&\s*([\s\S]+)$/);
    if (eq) {
      const lhs = eq[1].trim();
      const rhs = eq[2].trim();
      const classExpr = eq[3].trim();
      const classStr = readStringOrTemplate(classExpr);
      if (classStr === null) continue;

      const lhsName = identifierOf(lhs);
      const rhsName = identifierOf(rhs);
      const lhsLit = readStringOrTemplate(lhs);
      const rhsLit = readStringOrTemplate(rhs);

      if (lhsName && rhsLit !== null) {
        addVariantClasses(lhsName, rhsLit, classStr);
        continue;
      }
      if (rhsName && lhsLit !== null) {
        addVariantClasses(rhsName, lhsLit, classStr);
        continue;
      }
      continue;
    }

    // Boolean conditional: `varName && '...'` or `!varName && '...'`
    const bool = arg.match(/^(!?)\s*([A-Za-z_$][\w$]*)\s*&&\s*([\s\S]+)$/);
    if (bool) {
      const negated = !!bool[1];
      const varName = bool[2];
      const classStr = readStringOrTemplate(bool[3].trim());
      if (classStr === null) continue;
      addVariantClasses(varName, negated ? "false" : "true", classStr);
      continue;
    }

    // Bare identifier (className) or anything else: ignore.
  }

  if (!baseParts.length && !Object.keys(variants).length) return null;

  return {
    base: baseParts.join(" "),
    variants,
    defaults: {},
    compoundCount: 0,
  };
}

// Strips line and block comments while preserving strings — needed before
// splitting cn() args because crenel-style codebases interleave comments
// between conditional entries (`// Solid variants ...`) and the comment
// becomes part of the next arg, breaking the regex match silently.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  let template = false;
  while (i < source.length) {
    const ch = source[i];
    if (template) {
      out += ch;
      if (ch === "\\") { out += source[i + 1] ?? ""; i += 2; continue; }
      if (ch === "`") template = false;
      i++;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\") { out += source[i + 1] ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; i++; continue; }
    if (ch === "`") { template = true; out += ch; i++; continue; }
    if (ch === "/" && source[i + 1] === "/") {
      const eol = source.indexOf("\n", i);
      i = eol === -1 ? source.length : eol;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findClassMergerCall(source: string): number {
  // cn / clsx / classNames / twMerge / cx — the common merge helpers.
  const re = /(?<![A-Za-z0-9_$])(cn|clsx|classNames|twMerge|cx)\s*\(/g;
  const matches = [...source.matchAll(re)];
  for (const m of matches) {
    const lineStart = source.lastIndexOf("\n", m.index!) + 1;
    const eol = source.indexOf("\n", m.index!);
    const line = source.slice(lineStart, eol === -1 ? source.length : eol);
    if (/^\s*import\b/.test(line)) continue;
    return m.index!;
  }
  return -1;
}

// Returns the trimmed expression as a bare identifier name, or null when the
// expression is not a simple identifier. Used to disambiguate which side of
// `a === b` is the variable vs. the literal.
function identifierOf(expr: string): string | null {
  const t = expr.trim();
  return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
}

// Pulls default variant values from a destructured prop list like
// `({ variant = 'primary', size = 'md', ... }) => ...`. cn()-pattern
// components don't have CVA's defaultVariants block, so this is the only
// way to know which value should be marked as the default in the output.
function inferDefaultsFromPropDestructure(source: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  // Find each `name = 'value'` inside any `{ ... }` argument list near a
  // function/arrow function. We don't try to scope it to the component's
  // own param list — that's a rabbit hole; collisions are rare in practice.
  const re = /([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (!defaults[m[1]]) defaults[m[1]] = m[3];
  }
  return defaults;
}

function findCvaCall(source: string): number {
  // Match the cva identifier followed by `(`, ignoring the import line.
  const re = /(?<![A-Za-z0-9_$])cva\s*\(/g;
  const matches = [...source.matchAll(re)];
  // Skip the import declaration if `cva` shows up there too.
  for (const m of matches) {
    const lineStart = source.lastIndexOf("\n", m.index!) + 1;
    const line = source.slice(lineStart, source.indexOf("\n", m.index!));
    if (/^\s*import\b/.test(line)) continue;
    return m.index!;
  }
  return -1;
}

function matchClose(s: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let i = openIdx;
  let quote: string | null = null;
  let template = false;
  while (i < s.length) {
    const ch = s[i];
    if (template) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") template = false;
      else if (ch === "$" && s[i + 1] === "{") { i = matchClose(s, i + 1, "{", "}"); continue; }
    } else if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "`") {
      template = true;
    } else if (ch === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl;
      continue;
    } else if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function splitTopLevelArgs(body: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let buf = "";
  let quote: string | null = null;
  let template = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (template) {
      buf += ch;
      if (ch === "\\") { buf += body[i + 1] ?? ""; i++; continue; }
      if (ch === "`") template = false;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === "\\") { buf += body[i + 1] ?? ""; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "`") { template = true; buf += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; buf += ch; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth--; buf += ch; continue; }
    if (ch === "," && depth === 0) { args.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) args.push(buf.trim());
  return args;
}

function readStringOrTemplate(expr: string): string | null {
  const t = expr.trim();
  if (!t) return null;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t.startsWith("`") && t.endsWith("`")) {
    // Template literal: only safe to use if there are no `${...}` substitutions.
    const inner = t.slice(1, -1);
    if (!inner.includes("${")) return inner;
    return null;
  }
  return null;
}

function readObjectField(objBody: string, fieldName: string): string | null {
  // Walk top-level entries of `{ ... }` and find the named field's value.
  if (!objBody.startsWith("{")) return null;
  const inner = objBody.slice(1, objBody.lastIndexOf("}"));
  for (const [k, v] of iterateObjectEntries("{" + inner + "}")) {
    if (k === fieldName) return v.trim();
  }
  return null;
}

function readArrayField(objBody: string, fieldName: string): string | null {
  const v = readObjectField(objBody, fieldName);
  if (v == null) return null;
  return v.startsWith("[") ? v : null;
}

function countTopLevelObjects(arrayBody: string): number {
  if (!arrayBody.startsWith("[")) return 0;
  const close = matchClose(arrayBody, 0, "[", "]");
  if (close < 0) return 0;
  const entries = splitTopLevelArgs(arrayBody.slice(1, close));
  return entries.filter((e) => e.trim().startsWith("{")).length;
}

function* iterateObjectEntries(objBody: string): Generator<[string, string]> {
  if (!objBody.startsWith("{")) return;
  const close = matchClose(objBody, 0, "{", "}");
  if (close < 0) return;
  const inner = objBody.slice(1, close);
  const entries = splitTopLevelArgs(inner);
  for (const entry of entries) {
    const colonIdx = findTopLevelColon(entry);
    if (colonIdx < 0) continue;
    let key = entry.slice(0, colonIdx).trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1);
    } else if (key.startsWith("[") && key.endsWith("]")) {
      const inner = key.slice(1, -1).trim();
      const s = readStringOrTemplate(inner);
      if (s != null) key = s;
    }
    const value = entry.slice(colonIdx + 1).trim();
    yield [key, value];
  }
}

function findTopLevelColon(entry: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
    if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

// --- Inline className extraction (fallback when no cva is found) ---

function extractInlineClassNames(source: string): string[] {
  const out: string[] = [];
  // Match: className="..." or className='...' or className={"..."} or className={`...`}
  const re = /className\s*=\s*("([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\})/g;
  for (const m of source.matchAll(re)) {
    const v = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
    if (v) out.push(v);
  }
  return out;
}

// True when `cls` is a Tailwind modifier-prefixed class like `hover:bg-blue-500`,
// `md:px-4`, `dark:hover:bg-zinc-900`, or `data-[state=open]:opacity-100`.
// Colons inside `[...]` brackets (arbitrary values) are NOT modifiers.
function hasModifierPrefix(cls: string): boolean {
  let depth = 0;
  for (let i = 0; i < cls.length; i++) {
    const ch = cls[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ":" && depth === 0) return true;
  }
  return false;
}

function splitClasses(s: string): string[] {
  return s.split(/\s+/).map((c) => c.trim()).filter(Boolean);
}

// --- Token map ---

function buildTokenMap(projectPath: string): { map: TokenMap; warning: string | null } {
  const map: TokenMap = { colors: new Map(), spacing: new Map(), radius: new Map(), shadows: new Map(), typography: new Map() };
  try {
    const result = extractTokens(projectPath);
    for (const coll of result.collections) {
      const target = map[coll.category];
      if (!target) continue;
      for (const t of coll.tokens) {
        target.set(normalizeTokenKey(t.name), t.value);
      }
    }
    return { map, warning: null };
  } catch (err) {
    // Token extraction failed (malformed config, missing file, etc).
    // Fall back to bundled Tailwind defaults but surface the failure so the
    // user notices instead of getting "unresolved" for `bg-primary`.
    return {
      map,
      warning: `Token extraction failed (${String(err).split("\n")[0]}); falling back to Tailwind defaults.`,
    };
  }
}

interface TokenMap {
  colors: Map<string, string>;
  spacing: Map<string, string>;
  radius: Map<string, string>;
  shadows: Map<string, string>;
  typography: Map<string, string>;
}

function normalizeTokenKey(name: string): string {
  return name.toLowerCase().replace(/\//g, "-").replace(/\s+/g, "-");
}

// --- Class resolver ---

interface ResolveCtx {
  styling: ResolvedStyling;
  bindings: Bindings;
  padding: { t?: number; r?: number; b?: number; l?: number };
  paddingBindings: { t?: FieldBinding; r?: FieldBinding; b?: FieldBinding; l?: FieldBinding };
  border: { width?: string; color?: string };
  unresolved: string[];
  warnings: string[];
}

interface ResolvedSource {
  value: string;
  binding?: FieldBinding;
}

function resolveClasses(classes: string[], tokens: TokenMap): { styling: ResolvedStyling; bindings: Bindings; unresolved: string[]; warnings: string[] } {
  const ctx: ResolveCtx = { styling: {}, bindings: {}, padding: {}, paddingBindings: {}, border: {}, unresolved: [], warnings: [] };

  for (const cls of classes) {
    if (!cls) continue;
    // Skip modifier-prefixed classes entirely — `hover:`, `dark:`, `md:`,
    // `active:`, `focus-visible:`, `group-hover:`, `data-[...]:`, etc.
    // We only emit the BASE/default state to Figma. Previously we stripped
    // the prefix and applied the underlying class, which meant `dark:bg-zinc-900`
    // overwrote the real default `bg-blue-600`. Anything with a `:` outside
    // brackets is a modifier and gets skipped.
    if (hasModifierPrefix(cls)) continue;
    if (resolveClass(cls, ctx, tokens)) continue;
    ctx.unresolved.push(cls);
  }

  // Combine padding shorthand into one CSS-like string when any sides set.
  // Record a binding only when every set side resolved through the same
  // spacing token — Figma can't express per-side variable binding via this
  // output shape, so a mixed-token padding stays a literal.
  const p = ctx.padding;
  if (p.t != null || p.r != null || p.b != null || p.l != null) {
    const t = p.t ?? 0, r = p.r ?? 0, b = p.b ?? 0, l = p.l ?? 0;
    ctx.styling.padding = `${t}px ${r}px ${b}px ${l}px`;
    const pb = ctx.paddingBindings;
    const setSides = (["t", "r", "b", "l"] as const).filter((s) => p[s] != null);
    const bindings = setSides.map((s) => pb[s]);
    if (bindings.length && bindings.every((b) => b != null)) {
      const first = bindings[0]!;
      if (bindings.every((b) => b!.token === first.token && b!.collection === first.collection)) {
        ctx.bindings.padding = first;
      } else {
        ctx.warnings.push(
          `Padding sides resolved through different spacing tokens (${bindings.map((b) => b!.token).join(", ")}); writing literal pixels — bind sides individually in Figma.`,
        );
      }
    }
  }
  if (ctx.border.width || ctx.border.color) {
    ctx.styling.border = `${ctx.border.width ?? "1px"} solid ${ctx.border.color ?? "currentColor"}`;
    if (ctx.border.color) ctx.styling.borderColor = ctx.border.color;
  }
  return { styling: ctx.styling, bindings: ctx.bindings, unresolved: ctx.unresolved, warnings: ctx.warnings };
}

function resolveClass(cls: string, ctx: ResolveCtx, tokens: TokenMap): boolean {
  // Layout
  if (cls === "flex") return true;
  if (cls === "flex-row" || cls === "flex-row-reverse") { ctx.styling.layout = "row"; return true; }
  if (cls === "flex-col" || cls === "flex-col-reverse") { ctx.styling.layout = "column"; return true; }
  if (cls === "inline-flex") return true;

  // Background fill
  let m = cls.match(/^bg-(.+)$/);
  if (m) {
    const r = resolveColor(m[1], tokens);
    if (r) {
      ctx.styling.fill = r.value;
      if (r.binding) ctx.bindings.fill = r.binding;
      return true;
    }
    return false;
  }

  // text-align (handle before color/size since `text-center` would otherwise
  // fall into the catch-all and be unresolved).
  m = cls.match(/^text-(left|center|right|justify)$/);
  if (m) { ctx.styling.textAlign = m[1] as ResolvedStyling["textAlign"]; return true; }

  // Text color and font size — project token wins over Tailwind default.
  // Tailwind 3+ supports `text-{size}/{lineHeight}` shorthand: split first
  // so the size resolver doesn't try to look up "sm/5" as a color.
  m = cls.match(/^text-(.+)$/);
  if (m) {
    const arg = m[1];
    const slashIdx = !arg.startsWith("[") ? arg.indexOf("/") : -1;
    const sizeKey = slashIdx > 0 ? arg.slice(0, slashIdx) : arg;
    const lhKey = slashIdx > 0 ? arg.slice(slashIdx + 1) : null;

    // Color first (only on the unsplit form, since color names don't contain `/`).
    if (slashIdx < 0) {
      const r = resolveColor(arg, tokens);
      if (r) {
        ctx.styling.text = r.value;
        if (r.binding) ctx.bindings.text = r.binding;
        return true;
      }
    }
    // Font size — project token wins over bundled.
    const tFs = tokens.typography.get(normalizeTokenKey(sizeKey));
    if (tFs != null) {
      ctx.styling.fontSize = tFs;
      ctx.bindings.fontSize = { token: normalizeTokenKey(sizeKey), collection: "typography" };
    } else if (TEXT_SIZES[sizeKey]) {
      ctx.styling.fontSize = TEXT_SIZES[sizeKey];
    } else {
      return false;
    }
    // Optional line-height portion (`text-sm/5` → also set lineHeight=20px).
    if (lhKey != null) {
      const tLh = tokens.typography.get(normalizeTokenKey(`leading-${lhKey}`))
        ?? tokens.typography.get(normalizeTokenKey(`line-height-${lhKey}`))
        ?? tokens.typography.get(normalizeTokenKey(lhKey));
      if (tLh != null) {
        ctx.styling.lineHeight = tLh;
        ctx.bindings.lineHeight = { token: normalizeTokenKey(lhKey), collection: "typography" };
      } else if (LINE_HEIGHTS[lhKey]) {
        ctx.styling.lineHeight = LINE_HEIGHTS[lhKey];
      } else {
        const n = parseFloat(lhKey);
        if (!isNaN(n)) ctx.styling.lineHeight = `${Math.round(n * 4 * 100) / 100}px`;
      }
    }
    return true;
  }

  // text-transform / text-decoration / font-style — discrete, no token bindings.
  if (cls === "uppercase") { ctx.styling.textTransform = "uppercase"; return true; }
  if (cls === "lowercase") { ctx.styling.textTransform = "lowercase"; return true; }
  if (cls === "capitalize") { ctx.styling.textTransform = "capitalize"; return true; }
  if (cls === "normal-case") { ctx.styling.textTransform = "none"; return true; }
  if (cls === "underline") { ctx.styling.textDecoration = "underline"; return true; }
  if (cls === "line-through") { ctx.styling.textDecoration = "line-through"; return true; }
  if (cls === "overline") { ctx.styling.textDecoration = "overline"; return true; }
  if (cls === "no-underline") { ctx.styling.textDecoration = "none"; return true; }
  if (cls === "italic") { ctx.styling.fontStyle = "italic"; return true; }
  if (cls === "not-italic") { ctx.styling.fontStyle = "normal"; return true; }

  // Unified `font-{key}` resolver: weight, family, or custom typography token.
  // Bundled weight names take precedence (closed set). Otherwise we treat it
  // as a font-family lookup, with project tokens winning over bundled families.
  m = cls.match(/^font-([a-z][\w-]*)$/);
  if (m) {
    const key = m[1];
    if (FONT_WEIGHTS[key] != null) {
      ctx.styling.fontWeight = String(FONT_WEIGHTS[key]);
      // Bind when the project explicitly redefines the weight in tokens.
      const fromToken = tokens.typography.get(normalizeTokenKey(key));
      if (fromToken && /^\d+$/.test(fromToken)) {
        ctx.styling.fontWeight = fromToken;
        ctx.bindings.fontWeight = { token: normalizeTokenKey(key), collection: "typography" };
      }
      return true;
    }
    // Family — project token first (try both `display` and `font-display`
    // since CSS-var-derived tokens carry the `font-` prefix), then bundled.
    const tokenKey = tokens.typography.has(normalizeTokenKey(`font-${key}`))
      ? normalizeTokenKey(`font-${key}`)
      : tokens.typography.has(normalizeTokenKey(key))
      ? normalizeTokenKey(key)
      : null;
    if (tokenKey) {
      ctx.styling.fontFamily = tokens.typography.get(tokenKey)!;
      ctx.bindings.fontFamily = { token: tokenKey, collection: "typography" };
      return true;
    }
    if (FONT_FAMILIES[key]) { ctx.styling.fontFamily = FONT_FAMILIES[key]; return true; }
    return false;
  }

  // Line height (`leading-`)
  m = cls.match(/^leading-(.+)$/);
  if (m) {
    const key = m[1];
    if (key.startsWith("[") && key.endsWith("]")) {
      ctx.styling.lineHeight = key.slice(1, -1);
      return true;
    }
    const fromToken = tokens.typography.get(normalizeTokenKey(`leading-${key}`))
      ?? tokens.typography.get(normalizeTokenKey(`line-height-${key}`))
      ?? tokens.typography.get(normalizeTokenKey(key));
    if (fromToken != null) {
      ctx.styling.lineHeight = fromToken;
      ctx.bindings.lineHeight = { token: normalizeTokenKey(key), collection: "typography" };
      return true;
    }
    if (LINE_HEIGHTS[key]) { ctx.styling.lineHeight = LINE_HEIGHTS[key]; return true; }
    // Numeric scale: leading-3 → 0.75rem → 12px
    const n = parseFloat(key);
    if (!isNaN(n)) { ctx.styling.lineHeight = `${Math.round(n * 4 * 100) / 100}px`; return true; }
    return false;
  }

  // Letter spacing (`tracking-`)
  m = cls.match(/^tracking-(.+)$/);
  if (m) {
    const key = m[1];
    if (key.startsWith("[") && key.endsWith("]")) {
      ctx.styling.letterSpacing = key.slice(1, -1);
      return true;
    }
    const fromToken = tokens.typography.get(normalizeTokenKey(`tracking-${key}`))
      ?? tokens.typography.get(normalizeTokenKey(`letter-spacing-${key}`))
      ?? tokens.typography.get(normalizeTokenKey(key));
    if (fromToken != null) {
      ctx.styling.letterSpacing = fromToken;
      ctx.bindings.letterSpacing = { token: normalizeTokenKey(key), collection: "typography" };
      return true;
    }
    if (LETTER_SPACINGS[key]) { ctx.styling.letterSpacing = LETTER_SPACINGS[key]; return true; }
    return false;
  }

  // align-items, justify-content
  m = cls.match(/^items-(start|end|center|stretch|baseline)$/);
  if (m) { ctx.styling.alignItems = m[1] as ResolvedStyling["alignItems"]; return true; }
  m = cls.match(/^justify-(start|end|center|between|around|evenly)$/);
  if (m) { ctx.styling.justifyContent = m[1] as ResolvedStyling["justifyContent"]; return true; }

  // Border style (handle before the generic `border-{color}` matcher).
  if (cls === "border-solid") { ctx.styling.borderStyle = "solid"; return true; }
  if (cls === "border-dashed") { ctx.styling.borderStyle = "dashed"; return true; }
  if (cls === "border-dotted") { ctx.styling.borderStyle = "dotted"; return true; }
  if (cls === "border-double") { ctx.styling.borderStyle = "double"; return true; }
  if (cls === "border-none") { ctx.styling.borderStyle = "none"; return true; }

  // Opacity — `opacity-50` → "0.5", `opacity-[0.85]` → "0.85"
  m = cls.match(/^opacity-(.+)$/);
  if (m) {
    const key = m[1];
    if (key.startsWith("[") && key.endsWith("]")) {
      ctx.styling.opacity = key.slice(1, -1);
      return true;
    }
    const n = parseFloat(key);
    if (!isNaN(n)) { ctx.styling.opacity = String(Math.round((n / 100) * 100) / 100); return true; }
    return false;
  }

  // Border radius — project token wins over Tailwind default
  m = cls.match(/^rounded(?:-(.+))?$/);
  if (m) {
    const key = m[1] ?? "default";
    // Arbitrary value: rounded-[10px] — never a token binding.
    if (key.startsWith("[") && key.endsWith("]")) {
      ctx.styling.borderRadius = key.slice(1, -1);
      return true;
    }
    const fromToken = tokens.radius.get(normalizeTokenKey(key));
    if (fromToken != null) {
      ctx.styling.borderRadius = fromToken;
      ctx.bindings.borderRadius = { token: normalizeTokenKey(key), collection: "radius" };
      return true;
    }
    const fromDefault = RADIUS[key];
    if (fromDefault != null) { ctx.styling.borderRadius = fromDefault; return true; }
    return false;
  }

  // Border width / color
  if (cls === "border") { ctx.border.width = "1px"; return true; }
  m = cls.match(/^border-(\d+)$/);
  if (m) { ctx.border.width = `${m[1]}px`; return true; }
  m = cls.match(/^border-(.+)$/);
  if (m) {
    const r = resolveColor(m[1], tokens);
    if (r) {
      ctx.border.color = r.value;
      if (r.binding) ctx.bindings.borderColor = r.binding;
      return true;
    }
    return false;
  }

  // Padding — project token wins over Tailwind's 0.25rem-per-step default
  if ((m = cls.match(/^p-(.+)$/))) {
    const r = resolveSpacing(m[1], tokens);
    if (r) {
      ctx.padding.t = ctx.padding.r = ctx.padding.b = ctx.padding.l = r.px;
      if (r.binding) ctx.paddingBindings.t = ctx.paddingBindings.r = ctx.paddingBindings.b = ctx.paddingBindings.l = r.binding;
      return true;
    }
    return false;
  }
  if ((m = cls.match(/^px-(.+)$/))) {
    const r = resolveSpacing(m[1], tokens);
    if (r) {
      ctx.padding.l = ctx.padding.r = r.px;
      if (r.binding) ctx.paddingBindings.l = ctx.paddingBindings.r = r.binding;
      return true;
    }
    return false;
  }
  if ((m = cls.match(/^py-(.+)$/))) {
    const r = resolveSpacing(m[1], tokens);
    if (r) {
      ctx.padding.t = ctx.padding.b = r.px;
      if (r.binding) ctx.paddingBindings.t = ctx.paddingBindings.b = r.binding;
      return true;
    }
    return false;
  }
  if ((m = cls.match(/^pt-(.+)$/))) { const r = resolveSpacing(m[1], tokens); if (r) { ctx.padding.t = r.px; if (r.binding) ctx.paddingBindings.t = r.binding; return true; } return false; }
  if ((m = cls.match(/^pr-(.+)$/))) { const r = resolveSpacing(m[1], tokens); if (r) { ctx.padding.r = r.px; if (r.binding) ctx.paddingBindings.r = r.binding; return true; } return false; }
  if ((m = cls.match(/^pb-(.+)$/))) { const r = resolveSpacing(m[1], tokens); if (r) { ctx.padding.b = r.px; if (r.binding) ctx.paddingBindings.b = r.binding; return true; } return false; }
  if ((m = cls.match(/^pl-(.+)$/))) { const r = resolveSpacing(m[1], tokens); if (r) { ctx.padding.l = r.px; if (r.binding) ctx.paddingBindings.l = r.binding; return true; } return false; }

  // Gap (`gap-N`, `gap-x-N`, `gap-y-N`). Figma auto-layout has a single
  // gap field per direction, but our ResolvedStyling has only one `gap` —
  // we keep the last value seen, which means a class-string ordering of
  // gap-x-1 gap-y-2 would emit gap=2 (last wins). Acceptable for the
  // common case where authors set one direction or both equal.
  if ((m = cls.match(/^gap(?:-[xy])?-(.+)$/))) {
    const r = resolveSpacing(m[1], tokens);
    if (r) {
      ctx.styling.gap = `${r.px}px`;
      if (r.binding) ctx.bindings.gap = r.binding;
      return true;
    }
    return false;
  }

  // Shadow — project token wins over Tailwind default
  m = cls.match(/^shadow(?:-(.+))?$/);
  if (m) {
    const key = m[1] ?? "default";
    const fromToken = tokens.shadows.get(normalizeTokenKey(key));
    if (fromToken != null) {
      ctx.styling.shadow = fromToken;
      ctx.bindings.shadow = { token: normalizeTokenKey(key), collection: "shadows" };
      return true;
    }
    const fromDefault = SHADOWS[key];
    if (fromDefault != null) { ctx.styling.shadow = fromDefault; return true; }
    return false;
  }

  // Utilities we deliberately don't model — silently absorbed so they don't
  // pollute `unresolved` and force the agent to interrupt the push to ask
  // about them. None of these are actionable in Figma's auto-layout model:
  if (/^(content|self|place)-(start|end|center|between|around|evenly|stretch|baseline)$/.test(cls)) return true;
  if (/^(w|h|min-w|min-h|max-w|max-h|size)-/.test(cls)) return true; // sizing — content-driven in Figma
  if (/^(m|mx|my|mt|mr|mb|ml)-/.test(cls)) return true; // margin — Figma uses padding + gap on the parent
  if (/^space-[xy]-/.test(cls)) return true; // sibling spacing — same as gap
  if (cls === "relative" || cls === "absolute" || cls === "fixed" || cls === "sticky") return true;
  if (/^(top|right|bottom|left|inset)-/.test(cls)) return true;
  if (/^(transition|duration|ease|animate)-/.test(cls)) return true;
  if (cls === "cursor-pointer" || /^cursor-/.test(cls)) return true;
  if (/^(select|outline|ring|focus|disabled|whitespace|overflow|pointer-events|will-change|backdrop-)/.test(cls)) return true;

  return false;
}

// Resolves a Tailwind spacing scale (`4`, `1.5`, `auto`, or `[12px]`) to
// a pixel number, plus a token binding when the project's spacing tokens
// define the scale value explicitly. Falls back to Tailwind's `0.25rem`-
// per-step default.
function resolveSpacing(spec: string, tokens: TokenMap): { px: number; binding?: FieldBinding } | null {
  if (spec.startsWith("[") && spec.endsWith("]")) {
    const px = lengthToPx(spec.slice(1, -1));
    return px == null ? null : { px };
  }
  const fromToken = tokens.spacing.get(normalizeTokenKey(spec));
  if (fromToken != null) {
    const px = lengthToPx(fromToken);
    if (px != null) {
      return { px, binding: { token: normalizeTokenKey(spec), collection: "spacing" } };
    }
  }
  const n = parseFloat(spec);
  if (isNaN(n)) return null;
  return { px: Math.round(n * 4 * 100) / 100 };
}

// Parses a CSS length string ("16px", "1rem", "0.5em", "20") into pixels.
// Returns null when the input isn't a length we recognize.
function lengthToPx(value: string): number | null {
  const t = value.trim();
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = m[2];
  if (unit === "rem" || unit === "em") return Math.round(n * 16 * 100) / 100;
  return n;
}

function resolveColor(spec: string, tokens: TokenMap): ResolvedSource | null {
  // Arbitrary value: bg-[#ff0000] or bg-[rgb(...)] — never a token binding.
  if (spec.startsWith("[") && spec.endsWith("]")) {
    return { value: spec.slice(1, -1) };
  }
  // Tailwind opacity-modifier syntax: `bg-zinc-900/60` → strip the `/60`.
  // We don't synthesize the rgba, just resolve the base color so the agent
  // sees something useful; the literal-with-opacity case is uncommon enough
  // that flagging in `unresolved` would add more noise than value.
  const slashIdx = spec.lastIndexOf("/");
  const base = slashIdx > 0 && /^\d+$/.test(spec.slice(slashIdx + 1)) ? spec.slice(0, slashIdx) : spec;
  // Token lookup: project tokens win over the bundled palette.
  const key = normalizeTokenKey(base);
  const direct = tokens.colors.get(key);
  if (direct) return { value: direct, binding: { token: key, collection: "colors" } };
  // Tailwind palette default (e.g. blue-500).
  const def = TAILWIND_PALETTE[base];
  if (def) return { value: def };
  // CSS named colors (white/black/transparent).
  if (CSS_NAMED_COLORS[base]) return { value: CSS_NAMED_COLORS[base] };
  return null;
}

// --- Tailwind defaults (subset) ---

const FONT_FAMILIES: Record<string, string> = {
  sans: "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  mono: "ui-monospace, SFMono-Regular, monospace",
};

const LINE_HEIGHTS: Record<string, string> = {
  none: "1", tight: "1.25", snug: "1.375", normal: "1.5",
  relaxed: "1.625", loose: "2",
};

const LETTER_SPACINGS: Record<string, string> = {
  tighter: "-0.05em", tight: "-0.025em", normal: "0em",
  wide: "0.025em", wider: "0.05em", widest: "0.1em",
};

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, light: 300, normal: 400,
  medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900,
};

const TEXT_SIZES: Record<string, string> = {
  xs: "12px", sm: "14px", base: "16px", lg: "18px", xl: "20px",
  "2xl": "24px", "3xl": "30px", "4xl": "36px", "5xl": "48px",
};

const RADIUS: Record<string, string> = {
  default: "4px", none: "0", sm: "2px", md: "6px", lg: "8px",
  xl: "12px", "2xl": "16px", "3xl": "24px", full: "9999px",
};

const SHADOWS: Record<string, string> = {
  default: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  none: "none",
};

const CSS_NAMED_COLORS: Record<string, string> = {
  white: "#ffffff", black: "#000000", transparent: "transparent", current: "currentColor",
};

// The full Tailwind v3+ default color palette. Anything missing falls through
// to `unresolved` so the agent can ask the user. Project-defined tokens take
// precedence over this map (see resolveColor).
const TAILWIND_PALETTE: Record<string, string> = {
  "slate-50": "#f8fafc", "slate-100": "#f1f5f9", "slate-200": "#e2e8f0", "slate-300": "#cbd5e1", "slate-400": "#94a3b8", "slate-500": "#64748b", "slate-600": "#475569", "slate-700": "#334155", "slate-800": "#1e293b", "slate-900": "#0f172a", "slate-950": "#020617",
  "gray-50": "#f9fafb", "gray-100": "#f3f4f6", "gray-200": "#e5e7eb", "gray-300": "#d1d5db", "gray-400": "#9ca3af", "gray-500": "#6b7280", "gray-600": "#4b5563", "gray-700": "#374151", "gray-800": "#1f2937", "gray-900": "#111827", "gray-950": "#030712",
  "zinc-50": "#fafafa", "zinc-100": "#f4f4f5", "zinc-200": "#e4e4e7", "zinc-300": "#d4d4d8", "zinc-400": "#a1a1aa", "zinc-500": "#71717a", "zinc-600": "#52525b", "zinc-700": "#3f3f46", "zinc-800": "#27272a", "zinc-900": "#18181b", "zinc-950": "#09090b",
  "neutral-50": "#fafafa", "neutral-100": "#f5f5f5", "neutral-200": "#e5e5e5", "neutral-300": "#d4d4d4", "neutral-400": "#a3a3a3", "neutral-500": "#737373", "neutral-600": "#525252", "neutral-700": "#404040", "neutral-800": "#262626", "neutral-900": "#171717", "neutral-950": "#0a0a0a",
  "stone-50": "#fafaf9", "stone-100": "#f5f5f4", "stone-200": "#e7e5e4", "stone-300": "#d6d3d1", "stone-400": "#a8a29e", "stone-500": "#78716c", "stone-600": "#57534e", "stone-700": "#44403c", "stone-800": "#292524", "stone-900": "#1c1917", "stone-950": "#0c0a09",
  "red-50": "#fef2f2", "red-100": "#fee2e2", "red-200": "#fecaca", "red-300": "#fca5a5", "red-400": "#f87171", "red-500": "#ef4444", "red-600": "#dc2626", "red-700": "#b91c1c", "red-800": "#991b1b", "red-900": "#7f1d1d", "red-950": "#450a0a",
  "orange-50": "#fff7ed", "orange-100": "#ffedd5", "orange-200": "#fed7aa", "orange-300": "#fdba74", "orange-400": "#fb923c", "orange-500": "#f97316", "orange-600": "#ea580c", "orange-700": "#c2410c", "orange-800": "#9a3412", "orange-900": "#7c2d12", "orange-950": "#431407",
  "amber-50": "#fffbeb", "amber-100": "#fef3c7", "amber-200": "#fde68a", "amber-300": "#fcd34d", "amber-400": "#fbbf24", "amber-500": "#f59e0b", "amber-600": "#d97706", "amber-700": "#b45309", "amber-800": "#92400e", "amber-900": "#78350f", "amber-950": "#451a03",
  "yellow-50": "#fefce8", "yellow-100": "#fef9c3", "yellow-200": "#fef08a", "yellow-300": "#fde047", "yellow-400": "#facc15", "yellow-500": "#eab308", "yellow-600": "#ca8a04", "yellow-700": "#a16207", "yellow-800": "#854d0e", "yellow-900": "#713f12", "yellow-950": "#422006",
  "lime-50": "#f7fee7", "lime-100": "#ecfccb", "lime-200": "#d9f99d", "lime-300": "#bef264", "lime-400": "#a3e635", "lime-500": "#84cc16", "lime-600": "#65a30d", "lime-700": "#4d7c0f", "lime-800": "#3f6212", "lime-900": "#365314", "lime-950": "#1a2e05",
  "green-50": "#f0fdf4", "green-100": "#dcfce7", "green-200": "#bbf7d0", "green-300": "#86efac", "green-400": "#4ade80", "green-500": "#22c55e", "green-600": "#16a34a", "green-700": "#15803d", "green-800": "#166534", "green-900": "#14532d", "green-950": "#052e16",
  "emerald-50": "#ecfdf5", "emerald-100": "#d1fae5", "emerald-200": "#a7f3d0", "emerald-300": "#6ee7b7", "emerald-400": "#34d399", "emerald-500": "#10b981", "emerald-600": "#059669", "emerald-700": "#047857", "emerald-800": "#065f46", "emerald-900": "#064e3b", "emerald-950": "#022c22",
  "teal-50": "#f0fdfa", "teal-100": "#ccfbf1", "teal-200": "#99f6e4", "teal-300": "#5eead4", "teal-400": "#2dd4bf", "teal-500": "#14b8a6", "teal-600": "#0d9488", "teal-700": "#0f766e", "teal-800": "#115e59", "teal-900": "#134e4a", "teal-950": "#042f2e",
  "cyan-50": "#ecfeff", "cyan-100": "#cffafe", "cyan-200": "#a5f3fc", "cyan-300": "#67e8f9", "cyan-400": "#22d3ee", "cyan-500": "#06b6d4", "cyan-600": "#0891b2", "cyan-700": "#0e7490", "cyan-800": "#155e75", "cyan-900": "#164e63", "cyan-950": "#083344",
  "sky-50": "#f0f9ff", "sky-100": "#e0f2fe", "sky-200": "#bae6fd", "sky-300": "#7dd3fc", "sky-400": "#38bdf8", "sky-500": "#0ea5e9", "sky-600": "#0284c7", "sky-700": "#0369a1", "sky-800": "#075985", "sky-900": "#0c4a6e", "sky-950": "#082f49",
  "blue-50": "#eff6ff", "blue-100": "#dbeafe", "blue-200": "#bfdbfe", "blue-300": "#93c5fd", "blue-400": "#60a5fa", "blue-500": "#3b82f6", "blue-600": "#2563eb", "blue-700": "#1d4ed8", "blue-800": "#1e40af", "blue-900": "#1e3a8a", "blue-950": "#172554",
  "indigo-50": "#eef2ff", "indigo-100": "#e0e7ff", "indigo-200": "#c7d2fe", "indigo-300": "#a5b4fc", "indigo-400": "#818cf8", "indigo-500": "#6366f1", "indigo-600": "#4f46e5", "indigo-700": "#4338ca", "indigo-800": "#3730a3", "indigo-900": "#312e81", "indigo-950": "#1e1b4b",
  "violet-50": "#f5f3ff", "violet-100": "#ede9fe", "violet-200": "#ddd6fe", "violet-300": "#c4b5fd", "violet-400": "#a78bfa", "violet-500": "#8b5cf6", "violet-600": "#7c3aed", "violet-700": "#6d28d9", "violet-800": "#5b21b6", "violet-900": "#4c1d95", "violet-950": "#2e1065",
  "purple-50": "#faf5ff", "purple-100": "#f3e8ff", "purple-200": "#e9d5ff", "purple-300": "#d8b4fe", "purple-400": "#c084fc", "purple-500": "#a855f7", "purple-600": "#9333ea", "purple-700": "#7e22ce", "purple-800": "#6b21a8", "purple-900": "#581c87", "purple-950": "#3b0764",
  "fuchsia-50": "#fdf4ff", "fuchsia-100": "#fae8ff", "fuchsia-200": "#f5d0fe", "fuchsia-300": "#f0abfc", "fuchsia-400": "#e879f9", "fuchsia-500": "#d946ef", "fuchsia-600": "#c026d3", "fuchsia-700": "#a21caf", "fuchsia-800": "#86198f", "fuchsia-900": "#701a75", "fuchsia-950": "#4a044e",
  "pink-50": "#fdf2f8", "pink-100": "#fce7f3", "pink-200": "#fbcfe8", "pink-300": "#f9a8d4", "pink-400": "#f472b6", "pink-500": "#ec4899", "pink-600": "#db2777", "pink-700": "#be185d", "pink-800": "#9d174d", "pink-900": "#831843", "pink-950": "#500724",
  "rose-50": "#fff1f2", "rose-100": "#ffe4e6", "rose-200": "#fecdd3", "rose-300": "#fda4af", "rose-400": "#fb7185", "rose-500": "#f43f5e", "rose-600": "#e11d48", "rose-700": "#be123c", "rose-800": "#9f1239", "rose-900": "#881337", "rose-950": "#4c0519",
};
