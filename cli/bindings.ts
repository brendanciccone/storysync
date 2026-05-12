// Phase 2: Binding overlay. The renderer captures raw computed values
// (concrete hex colors, px lengths). For the design-system handoff to be
// useful, those values need to bind to the project's token variables so
// designers get a maintainable library — not 92 components all carrying
// the literal `#2563eb`.
//
// This module owns the reverse lookup: take a TokenCollection list (from
// tokens.ts) and a rendered value, return the FieldBinding that points at
// the right variable, or null when no token matches. Semantic preference
// applies — `primary` beats `blue-600` when both resolve to the same hex.

import type { TokenCollection, TokenValue } from "./tokens.js";
import type { FieldBinding } from "./inspect.js";

interface ColorMatch {
  token: TokenValue;
  collectionCategory: FieldBinding["collection"];
  // Lower wins. Built from category + name heuristics so semantic tokens
  // (`primary`, `accent`) outrank palette steps (`blue-600`).
  score: number;
}

export class TokenLookup {
  // hex (lowercase, 6-char) → list of candidate tokens sorted by score asc.
  private byColor = new Map<string, ColorMatch[]>();
  // hex with alpha (rgba(...)) → list of candidate tokens, separate map so
  // alpha-aware Catalyst lookups (`bg-red-500/15`) don't collide with the
  // base palette entry.
  private byColorAlpha = new Map<string, ColorMatch[]>();
  // Spacing/radius values keyed by their resolved px integer. Built once,
  // queried per rendered field.
  private byPx = new Map<number, { token: TokenValue; collectionCategory: FieldBinding["collection"] }[]>();

  constructor(collections: TokenCollection[]) {
    for (const coll of collections) {
      // Only the categories we know how to bind through Figma variables.
      // Typography binding lands on text font props (out of scope here).
      const cat = coerceCategory(coll.category);
      if (!cat) continue;
      for (const t of coll.tokens) {
        if (cat === "colors") {
          this.addColor(t, cat);
        } else if (cat === "spacing" || cat === "radius") {
          const px = parsePxStrict(t.value);
          if (px != null) {
            const bucket = this.byPx.get(px) ?? [];
            bucket.push({ token: t, collectionCategory: cat });
            this.byPx.set(px, bucket);
          }
        }
      }
    }
  }

  // Resolves a rendered color (hex like "#2563eb" or rgba(...)) to a
  // binding. Returns null when no token in the project matches.
  lookupColor(value: string | null | undefined): FieldBinding | null {
    if (!value) return null;
    const norm = normalizeColor(value);
    if (!norm) return null;

    // Try alpha-aware first when present; if no hit, fall back to the
    // base hex (a renderer that captured `rgba(220, 38, 38, 0.15)` should
    // still bind to a `red-500/15` token if the project defines one, but
    // we also accept just `red-500` as a partial bind).
    if (norm.kind === "rgba") {
      const candidates = this.byColorAlpha.get(norm.key);
      if (candidates && candidates.length) {
        return toBinding(candidates[0]);
      }
      const fallback = this.byColor.get(norm.hex);
      if (fallback && fallback.length) return toBinding(fallback[0]);
      return null;
    }
    const candidates = this.byColor.get(norm.hex);
    if (!candidates || !candidates.length) return null;
    return toBinding(candidates[0]);
  }

  // Resolves a rendered pixel value (`"16px"`) to a binding against the
  // spacing or radius collection. Only exact px matches bind — fuzzy
  // matching here would create ambiguous design-system links.
  lookupLength(value: string | null | undefined, category: "spacing" | "radius"): FieldBinding | null {
    if (!value) return null;
    const px = parsePxStrict(value);
    if (px == null) return null;
    const bucket = this.byPx.get(px);
    if (!bucket || !bucket.length) return null;
    // Prefer a match from the requested category when both exist.
    const inCat = bucket.find((b) => b.collectionCategory === category) ?? bucket[0];
    return toBinding({
      token: inCat.token,
      collectionCategory: inCat.collectionCategory,
      score: 0,
    });
  }

  private addColor(t: TokenValue, category: FieldBinding["collection"]): void {
    const norm = normalizeColor(t.value);
    if (!norm) return;
    const score = scoreColorToken(t);
    if (norm.kind === "rgba") {
      const bucket = this.byColorAlpha.get(norm.key) ?? [];
      bucket.push({ token: t, collectionCategory: category, score });
      bucket.sort((a, b) => a.score - b.score);
      this.byColorAlpha.set(norm.key, bucket);
      // Also index by the base hex so a fully-opaque rendered value can
      // still find an alpha token if no opaque match exists.
      const baseBucket = this.byColor.get(norm.hex) ?? [];
      baseBucket.push({ token: t, collectionCategory: category, score: score + 100 });
      baseBucket.sort((a, b) => a.score - b.score);
      this.byColor.set(norm.hex, baseBucket);
      return;
    }
    const bucket = this.byColor.get(norm.hex) ?? [];
    bucket.push({ token: t, collectionCategory: category, score });
    bucket.sort((a, b) => a.score - b.score);
    this.byColor.set(norm.hex, bucket);
  }
}

function toBinding(m: ColorMatch | { token: TokenValue; collectionCategory: FieldBinding["collection"]; score: number }): FieldBinding {
  return {
    token: m.token.name,
    collection: m.collectionCategory,
    source: "token",
  };
}

function coerceCategory(c: string): FieldBinding["collection"] | null {
  if (c === "colors" || c === "spacing" || c === "radius" || c === "shadows" || c === "typography") return c;
  return null;
}

// === Color normalization =====================================================
//
// Computed-style strings come back as `rgb(r, g, b)` or `rgba(r, g, b, a)`.
// Token sources may store `#rrggbb`, `rgb()`, or even `hsl()`. We normalize
// both sides to a comparable key, with alpha tracked separately so
// `bg-red-500/15` is distinguishable from `bg-red-500`.

interface NormalizedColor {
  hex: string;           // "#rrggbb"
  alpha: number;         // 0..1, 1 if opaque
  kind: "rgb" | "rgba";  // rgba when alpha < 1
  key: string;           // "#rrggbb" or "#rrggbb@<alpha-bucket>"
}

export function normalizeColor(v: string): NormalizedColor | null {
  const trimmed = v.trim().toLowerCase();
  if (!trimmed || trimmed === "transparent" || trimmed === "none") return null;

  // Hex (#rgb, #rrggbb, #rrggbbaa)
  let m = trimmed.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length === 6) return { hex: `#${hex}`, alpha: 1, kind: "rgb", key: `#${hex}` };
    if (hex.length === 8) {
      const a = parseInt(hex.slice(6, 8), 16) / 255;
      const base = `#${hex.slice(0, 6)}`;
      return { hex: base, alpha: a, kind: "rgba", key: `${base}@${alphaBucket(a)}` };
    }
    return null;
  }

  // rgb() / rgba() — accept both legacy comma form and space form
  m = trimmed.match(/^rgba?\(\s*([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const r = clampByte(parseFloat(parts[0]));
    const g = clampByte(parseFloat(parts[1]));
    const b = clampByte(parseFloat(parts[2]));
    let a = 1;
    if (parts.length >= 4) {
      const p = parts[3];
      a = p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p);
      if (isNaN(a)) a = 1;
    }
    const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
    if (a >= 1) return { hex, alpha: 1, kind: "rgb", key: hex };
    return { hex, alpha: a, kind: "rgba", key: `${hex}@${alphaBucket(a)}` };
  }

  // hsl() — fall through, less common to match exactly. We don't try to
  // convert; design tokens almost never appear as raw hsl strings on the
  // wire. (CSS-var-resolved hsl is handled by tokens.ts before it reaches
  // us.)
  return null;
}

// Group alpha values into 1% buckets. Slightly fuzzy on purpose: Catalyst
// uses `/15` (15% opacity) which renders as `0.15`, but rounding noise
// could land it at `0.149999` — a hard equality would miss the match.
function alphaBucket(a: number): string {
  const pct = Math.round(a * 100);
  return pct.toString().padStart(3, "0");
}

function clampByte(n: number): number {
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

// Strict px parser: accepts only values that resolve cleanly to a
// non-negative integer pixel count. Avoids accidentally matching `0.5px`
// or `8rem` against a `8px` token.
function parsePxStrict(v: string): number | null {
  const t = v.trim();
  const m = t.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (m) return Math.round(parseFloat(m[1]));
  const numOnly = t.match(/^(-?\d+(?:\.\d+)?)$/);
  if (numOnly) return Math.round(parseFloat(numOnly[1]));
  return null;
}

// Tokens like `primary`, `accent`, `foreground` are higher-fidelity binds
// than palette entries like `blue-600` even when both resolve to the same
// color — the semantic name survives a future palette rotation. Lower
// score = better match.
function scoreColorToken(t: TokenValue): number {
  const name = t.name.toLowerCase();
  // Generic semantic tokens (shadcn-style) win first.
  if (/^(primary|secondary|accent|destructive|success|warning|info|background|foreground|muted|popover|card|border|input|ring)\b/.test(name)) return 0;
  // Tokens with a hyphen-suffix variant (`primary-foreground`, `card-foreground`) still preferred over palette.
  if (/-foreground$/.test(name)) return 5;
  // Bare palette colors come next (`blue-600`, `zinc-200`).
  if (/^[a-z]+-\d{2,3}$/.test(name)) return 50;
  // Anything else (custom names) — middle ground; prefer over palette,
  // since project-specific tokens are usually more intentional.
  return 25;
}

// === Inspection overlay ======================================================
//
// Walks an InspectionResult's `renderedStyling` map and, for each rendered
// field that doesn't already have a binding from the parser, tries to
// resolve one via TokenLookup. Mutates the result in place (returns it
// for ergonomic chaining).

import type { InspectionResult, ResolvedStyling, Bindings } from "./inspect.js";

export function overlayBindings(spec: InspectionResult, lookup: TokenLookup): InspectionResult {
  // We only want to add bindings where the parser didn't already supply
  // one — overriding the parser's decision risks turning a confident
  // `bg-primary` binding into a coincidental palette match. This runs
  // even when render didn't supply values: if the parser captured a
  // concrete hex and a matching token exists, the binding is still
  // available for the agent to apply.
  for (const variant of spec.variants) {
    for (const valueName of Object.keys(variant.values)) {
      const styling = variant.values[valueName];
      const bindings = variant.bindings[valueName] ?? {};
      attachLookupBindings(styling, bindings, lookup);
      variant.bindings[valueName] = bindings;
    }
  }
  attachLookupBindings(spec.base, spec.baseBindings, lookup);
  return spec;
}

function attachLookupBindings(styling: ResolvedStyling, bindings: Bindings, lookup: TokenLookup): void {
  if (styling.fill && !bindings.fill) {
    const b = lookup.lookupColor(styling.fill);
    if (b) bindings.fill = b;
  }
  if (styling.text && !bindings.text) {
    const b = lookup.lookupColor(styling.text);
    if (b) bindings.text = b;
  }
  if (styling.borderColor && !bindings.borderColor) {
    const b = lookup.lookupColor(styling.borderColor);
    if (b) bindings.borderColor = b;
  }
  if (styling.borderRadius && !bindings.borderRadius) {
    const b = lookup.lookupLength(styling.borderRadius, "radius");
    if (b) bindings.borderRadius = b;
  }
  if (styling.gap && !bindings.gap) {
    const b = lookup.lookupLength(styling.gap, "spacing");
    if (b) bindings.gap = b;
  }
}
