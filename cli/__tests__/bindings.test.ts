import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenLookup, normalizeColor, overlayBindings } from "../bindings.js";
import type { InspectionResult } from "../inspect.js";
import type { TokenCollection } from "../tokens.js";

// --- normalizeColor ----------------------------------------------------------

test("normalizeColor: hex 6-digit", () => {
  const n = normalizeColor("#2563EB");
  assert.ok(n);
  assert.equal(n!.hex, "#2563eb");
  assert.equal(n!.alpha, 1);
  assert.equal(n!.kind, "rgb");
  assert.equal(n!.key, "#2563eb");
});

test("normalizeColor: hex 3-digit expands", () => {
  const n = normalizeColor("#0f0");
  assert.equal(n?.hex, "#00ff00");
});

test("normalizeColor: hex 8-digit splits alpha", () => {
  const n = normalizeColor("#2563eb26"); // 0x26 = 38/255 ≈ 0.149
  assert.equal(n?.hex, "#2563eb");
  assert.equal(n?.kind, "rgba");
  assert.ok(n!.alpha < 0.16 && n!.alpha > 0.14);
});

test("normalizeColor: rgb() comma form", () => {
  const n = normalizeColor("rgb(37, 99, 235)");
  assert.equal(n?.hex, "#2563eb");
  assert.equal(n?.kind, "rgb");
});

test("normalizeColor: rgba() with fractional alpha", () => {
  const n = normalizeColor("rgba(220, 38, 38, 0.15)");
  assert.equal(n?.hex, "#dc2626");
  assert.equal(n?.kind, "rgba");
  assert.equal(n?.key, "#dc2626@015");
});

test("normalizeColor: oklab matches its sRGB equivalent for token lookup", () => {
  // Tailwind 4 zinc-900 compiles to oklab(0.21 0.006 -0.013). Project
  // tokens stored as `zinc-900: #18181b` (rgb 24,24,27) should still
  // resolve through this normalized form.
  const n = normalizeColor("oklab(0.21 0.006 -0.013)");
  assert.ok(n);
  const r = parseInt(n!.hex.slice(1, 3), 16);
  const g = parseInt(n!.hex.slice(3, 5), 16);
  const b = parseInt(n!.hex.slice(5, 7), 16);
  assert.ok(Math.abs(r - 24) < 6, `r=${r}`);
  assert.ok(Math.abs(g - 24) < 6, `g=${g}`);
  assert.ok(Math.abs(b - 27) < 6, `b=${b}`);
});

test("normalizeColor: oklab with alpha tracks alpha separately", () => {
  const n = normalizeColor("oklab(0.5 0 0 / 0.9)");
  assert.ok(n);
  assert.equal(n!.kind, "rgba");
  assert.ok(Math.abs(n!.alpha - 0.9) < 0.01);
});

test("normalizeColor: transparent and none return null", () => {
  assert.equal(normalizeColor("transparent"), null);
  assert.equal(normalizeColor("none"), null);
  assert.equal(normalizeColor(""), null);
});

// --- TokenLookup -------------------------------------------------------------

function makeTokens(): TokenCollection[] {
  return [
    {
      category: "colors",
      tokens: [
        { name: "blue-600", value: "#2563eb" },
        { name: "red-500", value: "#ef4444" },
        { name: "primary", value: "#2563eb" }, // same color as blue-600
        { name: "zinc-200", value: "#e4e4e7" },
        { name: "card-foreground", value: "#0a0a0a" },
        // Alpha-aware token: Catalyst-style 15% tint.
        { name: "red-500/15", value: "rgba(239, 68, 68, 0.15)" },
      ],
    },
    {
      category: "spacing",
      tokens: [
        { name: "spacing-1", value: "4px" },
        { name: "spacing-2", value: "8px" },
        { name: "spacing-4", value: "16px" },
      ],
    },
    {
      category: "radius",
      tokens: [
        { name: "radius-sm", value: "4px" }, // ties with spacing-1 on px
        { name: "radius-md", value: "6px" },
        { name: "radius-lg", value: "12px" },
      ],
    },
  ];
}

test("TokenLookup.lookupColor: opaque hex hits the semantic token over palette", () => {
  // Both `primary` and `blue-600` resolve to #2563eb; the semantic
  // token should win the binding so the design system survives a future
  // palette rotation.
  const l = new TokenLookup(makeTokens());
  const b = l.lookupColor("#2563eb");
  assert.ok(b);
  assert.equal(b!.token, "primary");
  assert.equal(b!.collection, "colors");
  assert.equal(b!.source, "token");
});

test("TokenLookup.lookupColor: rgb() input normalizes and matches", () => {
  const l = new TokenLookup(makeTokens());
  const b = l.lookupColor("rgb(239, 68, 68)");
  assert.equal(b?.token, "red-500");
});

test("TokenLookup.lookupColor: rgba with alpha matches an alpha-aware token", () => {
  // Catalyst's `bg-red-500/15` renders as rgba(239, 68, 68, 0.15). The
  // project defines a matching token; we should bind to it, not to the
  // base `red-500`.
  const l = new TokenLookup(makeTokens());
  const b = l.lookupColor("rgba(239, 68, 68, 0.15)");
  assert.equal(b?.token, "red-500/15");
});

test("TokenLookup.lookupColor: rgba falls back to the base hex token when no alpha match", () => {
  const tokens: TokenCollection[] = [
    {
      category: "colors",
      tokens: [{ name: "blue-600", value: "#2563eb" }],
    },
  ];
  const l = new TokenLookup(tokens);
  const b = l.lookupColor("rgba(37, 99, 235, 0.5)");
  // No alpha token; base hex match is still preferable to no binding.
  assert.equal(b?.token, "blue-600");
});

test("TokenLookup.lookupColor: returns null when nothing matches", () => {
  const l = new TokenLookup(makeTokens());
  assert.equal(l.lookupColor("#123456"), null);
});

test("TokenLookup.lookupLength: matches px against spacing collection", () => {
  const l = new TokenLookup(makeTokens());
  const b = l.lookupLength("8px", "spacing");
  assert.equal(b?.token, "spacing-2");
  assert.equal(b?.collection, "spacing");
});

test("TokenLookup.lookupLength: prefers requested category when both match", () => {
  // Both spacing-1 and radius-sm are 4px. Asking for spacing should
  // return the spacing token.
  const l = new TokenLookup(makeTokens());
  const sb = l.lookupLength("4px", "spacing");
  assert.equal(sb?.token, "spacing-1");
  assert.equal(sb?.collection, "spacing");
  const rb = l.lookupLength("4px", "radius");
  assert.equal(rb?.token, "radius-sm");
  assert.equal(rb?.collection, "radius");
});

test("TokenLookup.lookupLength: only exact px matches (no fuzzy)", () => {
  const l = new TokenLookup(makeTokens());
  assert.equal(l.lookupLength("9px", "spacing"), null);
  assert.equal(l.lookupLength("8.5rem", "spacing"), null);
});

// --- overlayBindings ---------------------------------------------------------

const baseSpec = (overrides: Partial<InspectionResult> = {}): InspectionResult => ({
  name: "Badge",
  path: "/p/badge.tsx",
  base: {},
  baseBindings: {},
  variants: [],
  unresolved: [],
  warnings: [],
  ...overrides,
});

test("overlayBindings: fills binding gap when parser left one", () => {
  // Parser captured the hex (maybe via render) but didn't know which
  // token it came from. The overlay should attach the binding.
  const spec = baseSpec({
    variants: [
      {
        name: "color",
        defaultValue: "red",
        values: { red: { fill: "rgba(239, 68, 68, 0.15)", text: "#ef4444" } },
        bindings: { red: {} },
      },
    ],
    renderedStyling: { "color=red": { fill: "rgba(239, 68, 68, 0.15)" } },
  });
  const enriched = overlayBindings(spec, new TokenLookup(makeTokens()));
  const b = enriched.variants[0].bindings.red;
  assert.equal(b.fill?.token, "red-500/15");
  assert.equal(b.text?.token, "red-500");
});

test("overlayBindings: doesn't clobber an existing parser binding", () => {
  // Parser already bound fill to `primary`. Even if the rendered value
  // matches another token coincidentally, we keep the parser's call.
  const spec = baseSpec({
    variants: [
      {
        name: "color",
        defaultValue: "primary",
        values: { primary: { fill: "#2563eb" } },
        bindings: {
          primary: {
            fill: { token: "primary", collection: "colors", source: "token" },
          },
        },
      },
    ],
  });
  const enriched = overlayBindings(spec, new TokenLookup(makeTokens()));
  const b = enriched.variants[0].bindings.primary;
  // Unchanged.
  assert.equal(b.fill?.token, "primary");
  assert.equal(b.fill?.source, "token");
});

test("overlayBindings: also annotates base styling", () => {
  const spec = baseSpec({
    base: { fill: "#ef4444" },
    baseBindings: {},
  });
  const enriched = overlayBindings(spec, new TokenLookup(makeTokens()));
  assert.equal(enriched.baseBindings.fill?.token, "red-500");
});
