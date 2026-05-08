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
  borderRadius?: string | null;
  padding?: string | null;
  fontSize?: string | null;
  fontWeight?: string | null;
  shadow?: string | null;
  gap?: string | null;
  layout?: "row" | "column" | null;
}

export interface InspectVariant {
  name: string;
  defaultValue: string | null;
  values: Record<string, ResolvedStyling>;
}

export interface InspectionResult {
  name: string;
  path: string | null;
  base: ResolvedStyling;
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

  const tokenMap = buildTokenMap(projectPath);
  const cva = parseCvaCall(source);

  const result: InspectionResult = {
    name,
    path,
    base: {},
    variants: [],
    unresolved: [],
    warnings: [],
  };

  if (!cva) {
    // No cva() call found. Fall back to scanning className strings on JSX
    // tags so simple components still emit something useful.
    const classNames = extractInlineClassNames(source);
    if (!classNames.length) {
      result.warnings.push("No cva() call or className strings found; nothing to resolve.");
      return result;
    }
    const all = classNames.flatMap((c) => splitClasses(c));
    const { styling, unresolved } = resolveClasses(all, tokenMap);
    result.base = styling;
    result.unresolved.push(...unresolved);
    result.warnings.push("Component does not use cva(); base styling collapses all className strings.");
    return result;
  }

  const baseClasses = splitClasses(cva.base);
  const { styling: baseStyling, unresolved: baseUnresolved } = resolveClasses(baseClasses, tokenMap);
  result.base = baseStyling;
  result.unresolved.push(...baseUnresolved);

  for (const [variantName, valueMap] of Object.entries(cva.variants)) {
    const variant: InspectVariant = {
      name: variantName,
      defaultValue: cva.defaults[variantName] ?? null,
      values: {},
    };
    for (const [valueName, classes] of Object.entries(valueMap)) {
      const { styling, unresolved } = resolveClasses(splitClasses(classes), tokenMap);
      variant.values[valueName] = styling;
      for (const u of unresolved) if (!result.unresolved.includes(u)) result.unresolved.push(u);
    }
    result.variants.push(variant);
  }

  return result;
}

// --- CVA parser ---

interface ParsedCva {
  base: string;
  variants: Record<string, Record<string, string>>;
  defaults: Record<string, string>;
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
  }

  return { base, variants, defaults };
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

function splitClasses(s: string): string[] {
  return s.split(/\s+/).map((c) => c.trim()).filter(Boolean);
}

// --- Token map ---

function buildTokenMap(projectPath: string): TokenMap {
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
  } catch {
    // No tokens available; resolution falls back to Tailwind defaults.
  }
  return map;
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
  padding: { t?: number; r?: number; b?: number; l?: number };
  border: { width?: string; color?: string };
  unresolved: string[];
}

function resolveClasses(classes: string[], tokens: TokenMap): { styling: ResolvedStyling; unresolved: string[] } {
  const ctx: ResolveCtx = { styling: {}, padding: {}, border: {}, unresolved: [] };

  for (const cls of classes) {
    if (!cls) continue;
    // Strip variant prefixes (sm:, hover:, dark:) — we only resolve the base style.
    const lastColon = cls.lastIndexOf(":");
    const c = lastColon < 0 ? cls : cls.slice(lastColon + 1);
    if (resolveClass(c, ctx, tokens)) continue;
    ctx.unresolved.push(cls);
  }

  // Combine padding shorthand into one CSS-like string when any sides set.
  const p = ctx.padding;
  if (p.t != null || p.r != null || p.b != null || p.l != null) {
    const t = p.t ?? 0, r = p.r ?? 0, b = p.b ?? 0, l = p.l ?? 0;
    ctx.styling.padding = `${t}px ${r}px ${b}px ${l}px`;
  }
  if (ctx.border.width || ctx.border.color) {
    ctx.styling.border = `${ctx.border.width ?? "1px"} solid ${ctx.border.color ?? "currentColor"}`;
    if (ctx.border.color) ctx.styling.borderColor = ctx.border.color;
  }
  return { styling: ctx.styling, unresolved: ctx.unresolved };
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
    const v = resolveColor(m[1], tokens);
    if (v) { ctx.styling.fill = v; return true; }
    return false;
  }

  // Text color
  m = cls.match(/^text-(.+)$/);
  if (m) {
    const v = resolveColor(m[1], tokens);
    if (v) { ctx.styling.text = v; return true; }
    const fs = TEXT_SIZES[m[1]];
    if (fs) { ctx.styling.fontSize = fs; return true; }
    return false;
  }

  // Font weight
  m = cls.match(/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/);
  if (m) { ctx.styling.fontWeight = String(FONT_WEIGHTS[m[1]]); return true; }

  // Border radius
  m = cls.match(/^rounded(?:-(.+))?$/);
  if (m) {
    const key = m[1] ?? "default";
    const v = RADIUS[key] ?? tokens.radius.get(key);
    if (v != null) { ctx.styling.borderRadius = v; return true; }
    return false;
  }

  // Border width / color
  if (cls === "border") { ctx.border.width = "1px"; return true; }
  m = cls.match(/^border-(\d+)$/);
  if (m) { ctx.border.width = `${m[1]}px`; return true; }
  m = cls.match(/^border-(.+)$/);
  if (m) {
    const v = resolveColor(m[1], tokens);
    if (v) { ctx.border.color = v; return true; }
    return false;
  }

  // Padding
  if ((m = cls.match(/^p-(\d+(?:\.\d+)?)$/))) {
    const px = spacingToPx(m[1]);
    ctx.padding.t = ctx.padding.r = ctx.padding.b = ctx.padding.l = px;
    return true;
  }
  if ((m = cls.match(/^px-(\d+(?:\.\d+)?)$/))) { const v = spacingToPx(m[1]); ctx.padding.l = ctx.padding.r = v; return true; }
  if ((m = cls.match(/^py-(\d+(?:\.\d+)?)$/))) { const v = spacingToPx(m[1]); ctx.padding.t = ctx.padding.b = v; return true; }
  if ((m = cls.match(/^pt-(\d+(?:\.\d+)?)$/))) { ctx.padding.t = spacingToPx(m[1]); return true; }
  if ((m = cls.match(/^pr-(\d+(?:\.\d+)?)$/))) { ctx.padding.r = spacingToPx(m[1]); return true; }
  if ((m = cls.match(/^pb-(\d+(?:\.\d+)?)$/))) { ctx.padding.b = spacingToPx(m[1]); return true; }
  if ((m = cls.match(/^pl-(\d+(?:\.\d+)?)$/))) { ctx.padding.l = spacingToPx(m[1]); return true; }

  // Gap
  if ((m = cls.match(/^gap-(\d+(?:\.\d+)?)$/))) { ctx.styling.gap = `${spacingToPx(m[1])}px`; return true; }

  // Shadow
  m = cls.match(/^shadow(?:-(.+))?$/);
  if (m) {
    const key = m[1] ?? "default";
    const v = SHADOWS[key] ?? tokens.shadows.get(key);
    if (v != null) { ctx.styling.shadow = v; return true; }
    return false;
  }

  // Items / justify — layout helpers we don't represent in ResolvedStyling
  // but want to absorb so they don't end up in `unresolved`.
  if (/^(items|justify|content|self|place)-(start|end|center|between|around|evenly|stretch|baseline)$/.test(cls)) return true;
  if (/^(w|h|min-w|min-h|max-w|max-h)-/.test(cls)) return true; // width/height — out of scope
  if (cls === "relative" || cls === "absolute" || cls === "fixed" || cls === "sticky") return true;
  if (/^(top|right|bottom|left|inset)-/.test(cls)) return true;
  if (/^(opacity|transition|duration|ease|animate)-/.test(cls)) return true;
  if (cls === "cursor-pointer" || /^cursor-/.test(cls)) return true;
  if (/^(select|outline|ring|focus|disabled|whitespace|overflow)/.test(cls)) return true;

  return false;
}

function spacingToPx(scale: string): number {
  return Math.round(parseFloat(scale) * 4 * 100) / 100;
}

function resolveColor(spec: string, tokens: TokenMap): string | null {
  // Arbitrary value: bg-[#ff0000] or bg-[rgb(...)]
  if (spec.startsWith("[") && spec.endsWith("]")) {
    return spec.slice(1, -1);
  }
  // Token lookup: try the spec verbatim, then dash-normalized.
  const direct = tokens.colors.get(normalizeTokenKey(spec));
  if (direct) return direct;
  // Tailwind palette default (e.g. blue-500).
  const def = TAILWIND_PALETTE[spec];
  if (def) return def;
  // CSS named colors (white/black/transparent).
  if (CSS_NAMED_COLORS[spec]) return CSS_NAMED_COLORS[spec];
  return null;
}

// --- Tailwind defaults (subset) ---

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

const TAILWIND_PALETTE: Record<string, string> = {
  // A pragmatic subset; extend as needed. Anything missing falls through to
  // `unresolved` so the agent can ask the user.
  "slate-50": "#f8fafc", "slate-100": "#f1f5f9", "slate-200": "#e2e8f0",
  "slate-300": "#cbd5e1", "slate-400": "#94a3b8", "slate-500": "#64748b",
  "slate-600": "#475569", "slate-700": "#334155", "slate-800": "#1e293b",
  "slate-900": "#0f172a", "slate-950": "#020617",
  "gray-50": "#f9fafb", "gray-100": "#f3f4f6", "gray-200": "#e5e7eb",
  "gray-300": "#d1d5db", "gray-400": "#9ca3af", "gray-500": "#6b7280",
  "gray-600": "#4b5563", "gray-700": "#374151", "gray-800": "#1f2937",
  "gray-900": "#111827", "gray-950": "#030712",
  "zinc-50": "#fafafa", "zinc-100": "#f4f4f5", "zinc-200": "#e4e4e7",
  "zinc-300": "#d4d4d8", "zinc-400": "#a1a1aa", "zinc-500": "#71717a",
  "zinc-600": "#52525b", "zinc-700": "#3f3f46", "zinc-800": "#27272a",
  "zinc-900": "#18181b", "zinc-950": "#09090b",
  "red-500": "#ef4444", "red-600": "#dc2626", "red-700": "#b91c1c",
  "blue-500": "#3b82f6", "blue-600": "#2563eb", "blue-700": "#1d4ed8",
  "green-500": "#22c55e", "green-600": "#16a34a", "green-700": "#15803d",
  "yellow-500": "#eab308", "yellow-600": "#ca8a04",
  "amber-500": "#f59e0b", "amber-600": "#d97706",
  "indigo-500": "#6366f1", "indigo-600": "#4f46e5",
  "purple-500": "#a855f7", "purple-600": "#9333ea",
  "pink-500": "#ec4899", "pink-600": "#db2777",
};
