import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateVariablesScript,
  generateComponentScript,
  generatePushPlan,
  parseColorToRgb,
  type ComponentInput,
} from "../pushgen.js";
import type { TokenCollection } from "../tokens.js";
import type { InspectionResult } from "../inspect.js";

// --- parseColorToRgb ---

test("parseColorToRgb: 6-digit hex", () => {
  const rgb = parseColorToRgb("#3b82f6");
  assert.ok(rgb);
  assert.equal(rgb!.r.toFixed(4), (0x3b / 255).toFixed(4));
  assert.equal(rgb!.g.toFixed(4), (0x82 / 255).toFixed(4));
  assert.equal(rgb!.b.toFixed(4), (0xf6 / 255).toFixed(4));
});

test("parseColorToRgb: 3-digit hex expands", () => {
  const rgb = parseColorToRgb("#fff");
  assert.deepEqual(rgb, { r: 1, g: 1, b: 1 });
});

test("parseColorToRgb: 8-digit hex carries alpha", () => {
  const rgb = parseColorToRgb("#000000ff");
  assert.equal(rgb!.a, 1);
});

test("parseColorToRgb: rgb() string", () => {
  const rgb = parseColorToRgb("rgb(255, 0, 0)");
  assert.deepEqual(rgb, { r: 1, g: 0, b: 0 });
});

test("parseColorToRgb: rgba() with alpha", () => {
  const rgb = parseColorToRgb("rgba(0, 0, 0, 0.5)");
  assert.deepEqual(rgb, { r: 0, g: 0, b: 0, a: 0.5 });
});

test("parseColorToRgb: hsl() function", () => {
  const rgb = parseColorToRgb("hsl(0, 100%, 50%)");
  assert.equal(rgb!.r, 1);
  assert.equal(Math.round(rgb!.g), 0);
  assert.equal(Math.round(rgb!.b), 0);
});

test("parseColorToRgb: shadcn bare-component HSL form", () => {
  // shadcn stores tokens as `0 0% 100%` (no `hsl()` wrapper).
  const rgb = parseColorToRgb("0 0% 100%");
  assert.deepEqual(rgb, { r: 1, g: 1, b: 1 });
});

test("parseColorToRgb: transparent / white / black aliases", () => {
  assert.deepEqual(parseColorToRgb("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseColorToRgb("white"), { r: 1, g: 1, b: 1 });
  assert.deepEqual(parseColorToRgb("black"), { r: 0, g: 0, b: 0 });
});

test("parseColorToRgb: returns null for non-color", () => {
  assert.equal(parseColorToRgb("foo"), null);
  assert.equal(parseColorToRgb("16px"), null);
});

// --- generateVariablesScript ---

test("generateVariablesScript: emits createVariableCollection + setValueForMode for colors", () => {
  const collections: TokenCollection[] = [
    {
      category: "colors",
      tokens: [
        { name: "primary", value: "#3b82f6" },
        { name: "danger", value: "rgba(255, 0, 0, 0.8)" },
      ],
    },
  ];
  const script = generateVariablesScript(collections);
  assert.match(script.code, /upsertCollection\("Colors"\)/);
  assert.match(script.code, /upsertVariable\(coll, "primary", "COLOR"\)/);
  assert.match(script.code, /setValueForMode\(mode, \{ r: /);
  assert.match(script.code, /v\.scopes = \["ALL_FILLS","STROKE_COLOR"\]/);
  assert.match(script.label, /2 variables/);
});

test("generateVariablesScript: idempotent helpers (find existing before create)", () => {
  const script = generateVariablesScript([
    { category: "colors", tokens: [{ name: "x", value: "#fff" }] },
  ]);
  // The upsert helpers should look up existing collection/variable by name first.
  assert.match(script.code, /getLocalVariableCollections\(\)\.find/);
  assert.match(script.code, /\.find\(\(v\) => v\.variableCollectionId === collection\.id && v\.name === name\)/);
});

test("generateVariablesScript: rem values converted to px for FLOAT collections", () => {
  const script = generateVariablesScript([
    { category: "spacing", tokens: [{ name: "4", value: "1rem" }] },
  ]);
  assert.match(script.code, /upsertVariable\(coll, "4", "FLOAT"\)/);
  assert.match(script.code, /setValueForMode\(mode, 16\)/);
});

test("generateVariablesScript: skips unknown categories", () => {
  // The TokenCollection type is `category: TokenCategory` so passing an
  // arbitrary string is a TS error; cast to test the runtime guard.
  const script = generateVariablesScript([
    { category: "unknown" as never, tokens: [{ name: "x", value: "1" }] },
  ]);
  // No upsert lines for the unknown collection.
  assert.doesNotMatch(script.code, /upsertCollection\("unknown"\)/);
});

// --- generateComponentScript ---

function makeStyling(overrides: Partial<InspectionResult> = {}): InspectionResult {
  return {
    name: "Test",
    path: "/tmp/test.tsx",
    base: { borderRadius: "6px", padding: "8px 16px 8px 16px", gap: "8px", layout: "row" },
    baseBindings: {},
    variants: [],
    unresolved: [],
    warnings: [],
    ...overrides,
  };
}

test("generateComponentScript: creates page lookup, font preload, variants array, combineAsVariants", () => {
  const input: ComponentInput = {
    name: "Button",
    category: "Forms",
    variantProperties: [
      { name: "variant", type: "VARIANT", values: ["primary", "ghost"], defaultValue: "primary" },
    ],
    styling: makeStyling({
      variants: [
        {
          name: "variant",
          defaultValue: "primary",
          values: {
            primary: { fill: "#2563eb", text: "#ffffff" },
            ghost: { fill: "transparent", text: "hsl(0 0% 0%)" },
          },
          bindings: {
            primary: {},
            ghost: { text: { token: "foreground", collection: "colors" } },
          },
        },
      ],
    }),
  };
  const script = generateComponentScript(input);

  // Page lookup
  assert.match(script.code, /figma\.root\.children\.find\(\(p\) => p\.name === "Forms"\)/);
  // Font preload
  assert.match(script.code, /figma\.loadFontAsync/);
  // Two variant frames
  const frameMatches = script.code.match(/figma\.createFrame\(\)/g) ?? [];
  assert.equal(frameMatches.length, 2);
  // combineAsVariants for >1 variant
  assert.match(script.code, /combineAsVariants\(variants, page\)/);
  // Set name to Button
  assert.match(script.code, /set\.name = "Button"/);
});

test("generateComponentScript: emits setBoundVariable when bindings present", () => {
  const input: ComponentInput = {
    name: "Button",
    category: "UI",
    variantProperties: [
      { name: "variant", type: "VARIANT", values: ["primary"], defaultValue: "primary" },
    ],
    styling: makeStyling({
      base: { fill: "#000000" },
      baseBindings: { fill: { token: "primary", collection: "colors" } },
      variants: [
        {
          name: "variant",
          defaultValue: "primary",
          values: { primary: {} },
          bindings: { primary: {} },
        },
      ],
    }),
  };
  const script = generateComponentScript(input);
  // Look up the variable by collection + variable name at runtime.
  assert.match(script.code, /lookupVar\("Colors", "primary"\)/);
  // And bind the fills property.
  assert.match(script.code, /setBoundVariable\("fills", v\)/);
});

test("generateComponentScript: removes prior component set with same name (re-run safety)", () => {
  const input: ComponentInput = {
    name: "Card",
    variantProperties: [],
    styling: makeStyling({ name: "Card" }),
  };
  const script = generateComponentScript(input);
  assert.match(script.code, /child\.type === "COMPONENT_SET" && child\.name === "Card"/);
  assert.match(script.code, /child\.remove\(\)/);
});

test("generateComponentScript: single-variant components use createComponent (not combineAsVariants)", () => {
  const input: ComponentInput = {
    name: "Card",
    variantProperties: [],
    styling: makeStyling({ name: "Card" }),
  };
  const script = generateComponentScript(input);
  assert.match(script.code, /figma\.createComponent\(\)/);
  assert.doesNotMatch(script.code, /combineAsVariants/);
});

test("generateComponentScript: fill='transparent' produces empty fills array", () => {
  const input: ComponentInput = {
    name: "Ghost",
    variantProperties: [],
    styling: makeStyling({ base: { fill: "transparent" } }),
  };
  const script = generateComponentScript(input);
  assert.match(script.code, /f\.fills = \[\]/);
});

// --- generatePushPlan ---

test("generatePushPlan: bundles variables script + per-component script", () => {
  const plan = generatePushPlan({
    fileKey: "abc123",
    collections: [{ category: "colors", tokens: [{ name: "x", value: "#fff" }] }],
    components: [
      {
        name: "Button",
        variantProperties: [],
        styling: makeStyling({ name: "Button" }),
      },
    ],
  });
  assert.equal(plan.fileKey, "abc123");
  assert.equal(plan.scripts.length, 2);
  assert.match(plan.scripts[0].label, /1 variables/);
  assert.match(plan.scripts[1].label, /Button/);
});

test("generatePushPlan: warns when no token collections", () => {
  const plan = generatePushPlan({ fileKey: "x", collections: [], components: [] });
  assert.equal(plan.scripts.length, 0);
  assert.ok(plan.warnings.some((w) => w.includes("No token collections")));
});
