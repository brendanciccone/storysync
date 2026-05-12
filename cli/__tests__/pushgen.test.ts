import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateVariablesScript,
  generateComponentScript,
  generateSetupScript,
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

test("generateComponentScript: emits page lookup, font preload, and component creation in a loop", () => {
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
  // Data-driven loop creates one Component per payload entry
  assert.match(script.code, /figma\.createComponent\(\)/);
  // Two variants in the payload (primary + ghost)
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  assert.ok(payloadMatch, "expected VARIANTS payload literal");
  const payload = JSON.parse(payloadMatch![1]);
  assert.equal(payload.length, 2);
  assert.deepEqual(payload.map((p: { n: string }) => p.n).sort(), ["variant=ghost", "variant=primary"]);
  // combineAsVariants for >1 variant
  assert.match(script.code, /combineAsVariants\(variants, page\)/);
  // Component set name
  assert.match(script.code, /target\.name = "Button"/);
});

test("generateComponentScript: payload carries binding tuples + setBoundVariableForPaint for fills", () => {
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
  // Fill-binding tuple appears as ["Colors", "primary"] in the payload JSON.
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  assert.ok(payloadMatch);
  const payload = JSON.parse(payloadMatch![1]);
  assert.deepEqual(payload[0].fb, ["Colors", "primary"]);
  // The apply loop uses setBoundVariableForPaint (the correct API for
  // binding a paint's color), NOT node.setBoundVariable("fills", v).
  assert.match(script.code, /figma\.variables\.setBoundVariableForPaint\(fp, "color", v\)/);
  assert.doesNotMatch(script.code, /setBoundVariable\("fills", v\)/);
});

test("generateComponentScript: removes prior component set with same name (re-run safety)", () => {
  const input: ComponentInput = {
    name: "Card",
    variantProperties: [],
    styling: makeStyling({ name: "Card" }),
  };
  const script = generateComponentScript(input);
  // Re-run safety: remove both prior single COMPONENT and prior COMPONENT_SET
  // with the same name on the page.
  assert.match(script.code, /\(child\.type === "COMPONENT_SET" \|\| child\.type === "COMPONENT"\) && child\.name === "Card"/);
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

test("generateComponentScript: fill='transparent' produces no fill in payload (apply loop emits empty fills array)", () => {
  const input: ComponentInput = {
    name: "Ghost",
    variantProperties: [],
    styling: makeStyling({ base: { fill: "transparent" } }),
  };
  const script = generateComponentScript(input);
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  assert.ok(payloadMatch);
  const payload = JSON.parse(payloadMatch![1]);
  // No `f` (fill) in the payload — the apply loop's `c.fills = fp ? [fp] : []`
  // branch produces an empty fills array at runtime.
  assert.equal(payload[0].f, undefined);
  assert.match(script.code, /c\.fills = fp \? \[fp\] : \[\]/);
});

test("generateComponentScript: variant values with `/` get sanitized to `-`", () => {
  const input: ComponentInput = {
    name: "Button",
    category: "Catalyst",
    variantProperties: [
      { name: "color", type: "VARIANT", values: ["dark/zinc", "dark/white", "red"], defaultValue: "red" },
    ],
    styling: makeStyling({
      variants: [{ name: "color", defaultValue: "red", values: { "dark/zinc": {}, "dark/white": {}, "red": {} }, bindings: { "dark/zinc": {}, "dark/white": {}, "red": {} } }],
    }),
  };
  const script = generateComponentScript(input);
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  const payload = JSON.parse(payloadMatch![1]);
  const names = payload.map((p: { n: string }) => p.n);
  // Figma rejects `/` inside variant property values (it's the group separator).
  assert.deepEqual(names.sort(), ["color=dark-white", "color=dark-zinc", "color=red"]);
});

test("generateComponentScript: applies variant defaults when combo doesn't enumerate the axis", () => {
  // When Storybook's variantProperties is empty (component stories don't
  // expose variant/size via argTypes), the matrix collapses to a single
  // {} combo. The merge logic must still apply per-variant DEFAULTS so the
  // resulting single component carries real styling — without this the
  // component renders as a bare text label (no fill, no padding from size).
  const input: ComponentInput = {
    name: "Button",
    category: "UI",
    variantProperties: [],
    styling: {
      name: "Button",
      path: "/tmp/x.tsx",
      base: { borderRadius: "6px", fontWeight: "500" },
      baseBindings: {},
      variants: [
        {
          name: "variant",
          defaultValue: "primary",
          values: {
            primary: { fill: "#2563eb", text: "#ffffff" },
            ghost: { fill: "transparent" },
          },
          bindings: { primary: {}, ghost: {} },
        },
        {
          name: "size",
          defaultValue: "md",
          values: {
            sm: { padding: "8px 12px 8px 12px", fontSize: "14px" },
            md: { padding: "10px 16px 10px 16px", fontSize: "14px" },
          },
          bindings: { sm: {}, md: {} },
        },
      ],
      unresolved: [],
      warnings: [],
    },
  };
  const script = generateComponentScript(input);
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  assert.ok(payloadMatch);
  const payload = JSON.parse(payloadMatch![1]);
  // Single variant emitted, with primary fill and md padding applied.
  assert.equal(payload.length, 1);
  assert.deepEqual(payload[0].f.slice(0, 3), [0.1451, 0.3882, 0.9216]);
  assert.equal(payload[0].pt, 10);
  assert.equal(payload[0].pl, 16);
  assert.equal(payload[0].lfz, 14);
});

test("generateComponentScript: positions new component below existing peers on the page", () => {
  const input: ComponentInput = {
    name: "Card",
    variantProperties: [],
    styling: makeStyling({ name: "Card" }),
  };
  const script = generateComponentScript(input);
  // Stacking layout — find peers' bottom edge, place target below with 40px gap.
  assert.match(script.code, /const peers = page\.children\.filter/);
  assert.match(script.code, /Math\.max\(\.\.\.peers\.map\(\(c\) => c\.y \+ c\.height\)\)/);
  assert.match(script.code, /target\.y = peers\.length \? bottom \+ 40 : 0/);
});

// --- generatePushPlan ---

test("generatePushPlan: bundles setup + variables + per-component scripts in order", () => {
  const plan = generatePushPlan({
    fileKey: "abc123",
    collections: [{ category: "colors", tokens: [{ name: "x", value: "#fff" }] }],
    components: [
      {
        name: "Button",
        category: "UI",
        variantProperties: [],
        styling: makeStyling({ name: "Button" }),
      },
    ],
  });
  assert.equal(plan.fileKey, "abc123");
  assert.equal(plan.scripts.length, 3);
  // Setup script runs first — Cover page + Page 1 cleanup.
  assert.match(plan.scripts[0].label, /Set up Cover page/);
  assert.match(plan.scripts[0].code, /name === "Cover"/);
  assert.match(plan.scripts[0].code, /name === "Page 1"/);
  // Variables next.
  assert.match(plan.scripts[1].label, /1 variables/);
  // Component last.
  assert.match(plan.scripts[2].label, /Button/);
});

test("generateSetupScript: cover page summary lists each component page with count", () => {
  const script = generateSetupScript({
    pageSummary: [
      { name: "Catalyst", componentCount: 2 },
      { name: "UI", componentCount: 4 },
    ],
    componentTotal: 6,
    variableTotal: 42,
  });
  // Summary rows for each page.
  assert.match(script.code, /Catalyst · 2 components/);
  assert.match(script.code, /UI · 4 components/);
  // Subtitle includes totals.
  assert.match(script.code, /6 components/);
  assert.match(script.code, /42 variables/);
});

test("generatePushPlan: setup script always runs; warns when no token collections", () => {
  const plan = generatePushPlan({ fileKey: "x", collections: [], components: [] });
  // Setup runs even with no collections (cover page + page cleanup still useful).
  assert.equal(plan.scripts.length, 1);
  assert.match(plan.scripts[0].label, /Set up Cover page/);
  assert.ok(plan.warnings.some((w) => w.includes("No token collections")));
});

test("generatePushPlan: palette colors used in components get added to Colors collection", () => {
  // Catalyst pattern: a component fill that resolved through the bundled
  // Tailwind palette (`bg-blue-500` → `#3b82f6`) should appear in the
  // generated variables script so the component can actually bind to it.
  const plan = generatePushPlan({
    fileKey: "abc",
    collections: [{ category: "colors", tokens: [{ name: "primary", value: "#0066ff" }] }],
    components: [{
      name: "Button",
      category: "Catalyst",
      variantProperties: [],
      styling: {
        name: "Button",
        path: "/tmp/x.tsx",
        base: { fill: "#3b82f6" },
        baseBindings: { fill: { token: "blue-500", collection: "colors", source: "palette" } },
        variants: [],
        unresolved: [],
        warnings: [],
      },
    }],
  });

  // Scripts: [setup, variables, Button]. Variables should include both
  // `primary` (project token) and `blue-500` (palette color used by Button).
  assert.equal(plan.scripts.length, 3);
  const varsScript = plan.scripts[1];
  assert.match(varsScript.code, /upsertVariable\(coll, "primary", "COLOR"\)/);
  assert.match(varsScript.code, /upsertVariable\(coll, "blue-500", "COLOR"\)/);

  // The Button script's fill-binding tuple references blue-500.
  const componentScript = plan.scripts[2];
  const payloadMatch = componentScript.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  assert.ok(payloadMatch);
  const payload = JSON.parse(payloadMatch![1]);
  assert.deepEqual(payload[0].fb, ["Colors", "blue-500"]);
});

test("generatePushPlan: doesn't duplicate palette colors already declared as project tokens", () => {
  // If the project's `colors` collection already has `blue-500`, we don't
  // re-emit it.
  const plan = generatePushPlan({
    fileKey: "abc",
    collections: [{ category: "colors", tokens: [{ name: "blue-500", value: "#0066ff" }] }],
    components: [{
      name: "Button",
      variantProperties: [],
      styling: {
        name: "Button",
        path: "/tmp/x.tsx",
        base: { fill: "#3b82f6" },
        baseBindings: { fill: { token: "blue-500", collection: "colors", source: "palette" } },
        variants: [],
        unresolved: [],
        warnings: [],
      },
    }],
  });
  const varsScript = plan.scripts[1];
  const matches = varsScript.code.match(/upsertVariable\(coll, "blue-500", "COLOR"\)/g) ?? [];
  assert.equal(matches.length, 1);
});
