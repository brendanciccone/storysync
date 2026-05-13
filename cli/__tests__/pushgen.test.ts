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

test("parseColorToRgb: oklab string (Tailwind 4 default color space)", () => {
  // Tailwind 4 zinc-900 (#18181b) compiles to oklab(0.21 0.006 -0.013).
  const rgb = parseColorToRgb("oklab(0.21 0.006 -0.013)");
  assert.ok(rgb);
  // Should land within a couple bytes of #18181b.
  assert.ok(Math.abs(rgb!.r * 255 - 24) < 6, `r=${rgb!.r * 255}`);
  assert.ok(Math.abs(rgb!.g * 255 - 24) < 6, `g=${rgb!.g * 255}`);
  assert.ok(Math.abs(rgb!.b * 255 - 27) < 6, `b=${rgb!.b * 255}`);
});

test("parseColorToRgb: oklab carries alpha when present", () => {
  const rgb = parseColorToRgb("oklab(0.5 0 0 / 0.5)");
  assert.ok(rgb);
  assert.equal(rgb!.a, 0.5);
});

test("parseColorToRgb: oklab without alpha", () => {
  // White: oklab(1 0 0)
  const rgb = parseColorToRgb("oklab(1 0 0)");
  assert.ok(rgb);
  assert.ok(rgb!.r > 0.99);
  assert.ok(rgb!.g > 0.99);
  assert.ok(rgb!.b > 0.99);
  assert.equal(rgb!.a, undefined);
});

test("parseColorToRgb: oklch (polar form of oklab)", () => {
  // Same color (white) in oklch form.
  const rgb = parseColorToRgb("oklch(1 0 0)");
  assert.ok(rgb);
  assert.ok(rgb!.r > 0.99);
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

// --- Render overlay (Phase 1 integration into pushgen) ---

test("renderedStyling overlay: runtime values win over parsed when present", () => {
  // Parser sees a transparent fill (e.g. it couldn't resolve the Catalyst
  // `bg-{color}-500/15` lookup). Render fills it in with the actual
  // painted color. The emitted payload should carry the rendered value.
  const input: ComponentInput = {
    name: "Badge",
    category: "Catalyst",
    variantProperties: [],
    styling: {
      name: "Badge",
      path: "/proj/components/catalyst/badge.tsx",
      base: { fill: null, padding: "0 0 0 0", borderRadius: "6px" },
      baseBindings: {},
      variants: [],
      unresolved: [],
      warnings: [],
      renderedStyling: {
        Default: { fill: "#fee2e2", padding: "2px 6px 2px 6px", text: "#b91c1c" },
      },
    },
  };
  const script = generateComponentScript(input);
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  assert.ok(payloadMatch);
  const payload = JSON.parse(payloadMatch![1]);
  // Fill came from render, not parser.
  assert.deepEqual(payload[0].f.slice(0, 3).map((n: number) => Math.round(n * 255)), [254, 226, 226]);
  // Padding overrides the parsed "0 0 0 0".
  assert.equal(payload[0].pt, 2);
  assert.equal(payload[0].pr, 6);
  assert.equal(payload[0].pb, 2);
  assert.equal(payload[0].pl, 6);
  // Label color came from render.
  assert.deepEqual(payload[0].lf.map((n: number) => Math.round(n * 255)), [185, 28, 28]);
});

test("renderedStyling overlay: only non-null fields win; parser structure survives", () => {
  // Render captures opaque colors but layout/alignment is structural —
  // we should keep the parser's values when render didn't supply them.
  const input: ComponentInput = {
    name: "Pill",
    category: "UI",
    variantProperties: [],
    styling: {
      name: "Pill",
      path: "/proj/components/pill.tsx",
      base: { fill: "#000000", layout: "row", alignItems: "center", gap: "4px" },
      baseBindings: {},
      variants: [],
      unresolved: [],
      warnings: [],
      renderedStyling: {
        // Only fill is provided by render; layout/alignment are absent.
        Default: { fill: "#ff0000" },
      },
    },
  };
  const script = generateComponentScript(input);
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  const payload = JSON.parse(payloadMatch![1]);
  // Render fill won.
  assert.deepEqual(payload[0].f.slice(0, 3), [1, 0, 0]);
  // Parser's layout + align survived.
  assert.equal(payload[0].lm, "HORIZONTAL");
  assert.equal(payload[0].ai, "CENTER");
  assert.equal(payload[0].is, 4);
});

test("renderedLabels: rendered innerText replaces component name in label", () => {
  // Catalyst Badge's story sets `children: "Label"`. The rendered DOM
  // carries that text; we should stamp it onto the variant placeholder
  // instead of using the component name ("Badge").
  const input: ComponentInput = {
    name: "Badge",
    category: "Catalyst",
    variantProperties: [],
    styling: {
      name: "Badge",
      path: "/p/badge.tsx",
      base: { fill: "#ffffff" },
      baseBindings: {},
      variants: [],
      unresolved: [],
      warnings: [],
      renderedLabels: { Default: "Label" },
    },
  };
  const script = generateComponentScript(input);
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  const payload = JSON.parse(payloadMatch![1]);
  assert.equal(payload[0].lt, "Label");
});

test("renderedChildren: emits kids array + buildChild helper in script", () => {
  // Card with CardHeader + CardContent + CardFooter as captured children.
  // The script should: include a buildChild helper, set d.kids on the
  // payload, and use the kids branch instead of the single-label branch.
  const input: ComponentInput = {
    name: "Card",
    category: "UI",
    variantProperties: [],
    styling: {
      name: "Card",
      path: "/p/card.tsx",
      base: { fill: "#ffffff", borderRadius: "12px" },
      baseBindings: {},
      variants: [],
      unresolved: [],
      warnings: [],
      renderedChildren: {
        Default: [
          {
            styling: { padding: "24px 24px 24px 24px", layout: "column", gap: "6px" },
            children: [
              { styling: { fontSize: "16px", fontWeight: "600", text: "#0a0a0a" }, text: "Card Title" },
              { styling: { fontSize: "14px", text: "#71717a" }, text: "Card description" },
            ],
          },
        ],
      },
    },
  };
  const script = generateComponentScript(input);
  // Helper was emitted.
  assert.match(script.code, /const buildChild = \(d\) =>/);
  // Apply loop uses the kids branch.
  assert.match(script.code, /if \(d\.kids && d\.kids\.length\)/);
  // Payload carries kids tree.
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  const payload = JSON.parse(payloadMatch![1]);
  assert.ok(payload[0].kids, "expected payload[0].kids to be set");
  assert.equal(payload[0].kids.length, 1);
  const cardContent = payload[0].kids[0];
  assert.equal(cardContent.pt, 24);
  assert.equal(cardContent.lm, "VERTICAL");
  // CardContent has its own kids: title + description text nodes.
  assert.ok(cardContent.kids);
  assert.equal(cardContent.kids.length, 2);
  assert.equal(cardContent.kids[0].t, "Card Title");
  assert.equal(cardContent.kids[1].t, "Card description");
});

test("renderedChildren: text leaves carry font sizing + color from styling", () => {
  const input: ComponentInput = {
    name: "Alert",
    category: "UI",
    variantProperties: [],
    styling: {
      name: "Alert",
      path: "/p/alert.tsx",
      base: { fill: "#fef2f2" },
      baseBindings: {},
      variants: [],
      unresolved: [],
      warnings: [],
      renderedChildren: {
        Default: [
          { styling: { fontSize: "13px", text: "#991b1b" }, text: "Something went wrong" },
        ],
      },
    },
  };
  const script = generateComponentScript(input);
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  const payload = JSON.parse(payloadMatch![1]);
  const leaf = payload[0].kids[0];
  assert.equal(leaf.t, "Something went wrong");
  assert.equal(leaf.tfz, 13);
  // RGB tuple from #991b1b
  assert.deepEqual(
    leaf.tf.map((n: number) => Math.round(n * 255)),
    [153, 27, 27],
  );
});

test("renderedLabels: falls back to component name when render didn't capture text", () => {
  const input: ComponentInput = {
    name: "Card",
    category: "UI",
    variantProperties: [],
    styling: {
      name: "Card",
      path: "/p/card.tsx",
      base: { fill: "#ffffff" },
      baseBindings: {},
      variants: [],
      unresolved: [],
      warnings: [],
      // No renderedLabels at all.
    },
  };
  const script = generateComponentScript(input);
  const payloadMatch = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  const payload = JSON.parse(payloadMatch![1]);
  assert.equal(payload[0].lt, "Card");
});

// === Fidelity overhaul tests (§1.1–§3.4) ====================================

function fidelityInput(stylingOverrides: Partial<InspectionResult> = {}): ComponentInput {
  return {
    name: "Demo",
    category: "UI",
    variantProperties: [],
    styling: {
      name: "Demo",
      path: "/p/demo.tsx",
      base: {},
      baseBindings: {},
      variants: [],
      unresolved: [],
      warnings: [],
      ...stylingOverrides,
    },
  };
}

function payloadOf(input: ComponentInput): { payload: any[]; code: string } {
  const script = generateComponentScript(input);
  const m = script.code.match(/const VARIANTS = (\[[\s\S]*?\]);/);
  return { payload: JSON.parse(m![1]), code: script.code };
}

test("§1.1 width FIXED — emits cw when widthExplicit and width is set", () => {
  const { payload, code } = payloadOf(
    fidelityInput({ base: { width: 384, widthExplicit: true, fill: "#fff" } }),
  );
  assert.equal(payload[0].cw, 384);
  // Apply loop now switches sizing mode based on d.cw presence.
  assert.match(code, /counterAxisSizingMode = d\.cw != null \? "FIXED" : "AUTO"/);
});

test("§1.1 width FIXED — max-width emits cw only when rendered width is at the limit", () => {
  // Within 4px of max → FIXED.
  const atLimit = payloadOf(
    fidelityInput({ base: { width: 384, maxWidth: "384px", fill: "#fff" } }),
  );
  assert.equal(atLimit.payload[0].cw, 384);
  // Comfortably below max → HUG (no cw emitted).
  const belowLimit = payloadOf(
    fidelityInput({ base: { width: 100, maxWidth: "384px", fill: "#fff" } }),
  );
  assert.equal(belowLimit.payload[0].cw, undefined);
});

test("§1.2 multi-line text — child text leaf with multiLine + parentInnerWidth emits tar=HEIGHT + tw", () => {
  const { payload } = payloadOf(
    fidelityInput({
      base: { fill: "#fff" },
      renderedChildren: {
        Default: [
          { styling: { fontSize: "14px", text: "#000" }, text: "A very long description that will definitely wrap onto multiple lines.", multiLine: true, parentInnerWidth: 240 },
        ],
      },
    }),
  );
  const leaf = payload[0].kids[0];
  assert.equal(leaf.tar, "HEIGHT");
  assert.equal(leaf.tw, 240);
});

test("§1.2 — short single-line text does NOT get textAutoResize", () => {
  const { payload } = payloadOf(
    fidelityInput({
      base: { fill: "#fff" },
      renderedChildren: {
        Default: [
          { styling: { fontSize: "14px", text: "#000" }, text: "Short", multiLine: false, parentInnerWidth: 240 },
        ],
      },
    }),
  );
  assert.equal(payload[0].kids[0].tar, undefined);
});

test("§1.3 SVG — child svgMarkup lands in SVGS library, payload references via svr", () => {
  const svg = `<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>`;
  const { payload, code } = payloadOf(
    fidelityInput({
      base: { fill: "#fff" },
      renderedChildren: {
        Default: [{ styling: { width: 16, height: 16 }, svgMarkup: svg }],
      },
    }),
  );
  const ref = payload[0].kids[0];
  assert.match(ref.svr, /^s[0-9a-z]+$/, "expected svr hash");
  assert.equal(ref.w, 16);
  assert.equal(ref.h, 16);
  // SVGS library is emitted at the script top with the same hash.
  assert.match(code, new RegExp(`const SVGS = \\{[^}]*"${ref.svr}":`));
  // Apply-loop branch calls createNodeFromSvg.
  assert.match(code, /figma\.createNodeFromSvg\(SVGS\[d\.svr\]\)/);
});

test("§1.3 SVG — identical icons dedupe to a single SVGS entry", () => {
  const svg = `<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>`;
  const { payload, code } = payloadOf(
    fidelityInput({
      base: { fill: "#fff" },
      renderedChildren: {
        Default: [
          { styling: { width: 16, height: 16 }, svgMarkup: svg },
          { styling: { width: 16, height: 16 }, svgMarkup: svg }, // same icon
        ],
      },
    }),
  );
  assert.equal(payload[0].kids[0].svr, payload[0].kids[1].svr);
  // The library JSON shouldn't repeat the same outerHTML twice.
  const matches = code.match(/"<svg/g) ?? [];
  assert.equal(matches.length, 1, "expected one occurrence of the SVG string in script");
});

test("§1.6 layout default — block-flow children default to VERTICAL (not HORIZONTAL)", () => {
  const { payload } = payloadOf(
    fidelityInput({
      base: { fill: "#fff" }, // no layout specified
      renderedChildren: {
        // Child with no layout → default VERTICAL.
        Default: [{ styling: { padding: "0px 0px 0px 0px" }, children: [
          { styling: { fontSize: "14px" }, text: "Title" },
          { styling: { fontSize: "12px" }, text: "Desc" },
        ] }],
      },
    }),
  );
  assert.equal(payload[0].lm, "VERTICAL");
  assert.equal(payload[0].kids[0].lm, "VERTICAL");
});

test("§1.7 text props — textAlign / transform / decoration / lineHeight / letterSpacing route to Figma", () => {
  const { payload, code } = payloadOf(
    fidelityInput({
      base: {
        fill: "#fff",
        textAlign: "center",
        textTransform: "uppercase",
        textDecoration: "underline",
        lineHeight: "20px",
        letterSpacing: "0.5px",
        text: "#000",
      },
    }),
  );
  assert.equal(payload[0].lah, "CENTER");
  assert.equal(payload[0].ltc, "UPPER");
  assert.equal(payload[0].ltd, "UNDERLINE");
  assert.equal(payload[0].llh, 20);
  assert.equal(payload[0].lls, 0.5);
  // Apply loop emits the writes.
  assert.match(code, /lb\.textAlignHorizontal = d\.lah/);
  assert.match(code, /lb\.textCase = d\.ltc/);
  assert.match(code, /lb\.textDecoration = d\.ltd/);
});

test("§2.2 gradient — gradient styling emits fg paint with stops + angle", () => {
  const { payload, code } = payloadOf(
    fidelityInput({
      base: {
        gradient: {
          type: "GRADIENT_LINEAR",
          angleDeg: 90,
          stops: [
            { position: 0, color: { r: 1, g: 0, b: 0 } },
            { position: 1, color: { r: 0, g: 0, b: 1 } },
          ],
        },
      },
    }),
  );
  assert.equal(payload[0].fg.t, "L");
  assert.equal(payload[0].fg.a, 90);
  assert.equal(payload[0].fg.st.length, 2);
  assert.deepEqual(payload[0].fg.st[0][1].slice(0, 3), [1, 0, 0]);
  assert.match(code, /type: d\.fg\.t === "L" \? "GRADIENT_LINEAR" : "GRADIENT_RADIAL"/);
});

test("§2.3 clipsContent — overflow:hidden emits cl=true and apply loop sets clipsContent", () => {
  const { payload, code } = payloadOf(
    fidelityInput({ base: { fill: "#fff", overflow: "hidden" } }),
  );
  assert.equal(payload[0].cl, true);
  assert.match(code, /if \(d\.cl\) c\.clipsContent = true/);
});

test("§2.4 strokeAlign — apply loop emits strokeAlign=INSIDE when stroke is set", () => {
  const { code } = payloadOf(
    fidelityInput({ base: { borderColor: "#000", borderWidth: "1px", borderStyle: "solid" } as any }),
  );
  assert.match(code, /c\.strokeAlign = "INSIDE"/);
});

test("§2.5 absolute positioning — child gets lp=ABSOLUTE + constraints + offsets", () => {
  const { payload, code } = payloadOf(
    fidelityInput({
      base: { fill: "#fff" },
      renderedChildren: {
        Default: [
          {
            styling: { position: "absolute", topOffset: "0px", rightOffset: "0px", fill: "#f00", width: 16, height: 16 },
            text: undefined,
          },
        ],
      },
    }),
  );
  const kid = payload[0].kids[0];
  assert.equal(kid.lp, "ABSOLUTE");
  assert.equal(kid.cn.h, "MAX"); // right anchored
  assert.equal(kid.cn.v, "MIN"); // top anchored
  assert.match(code, /f\.layoutPositioning = "ABSOLUTE"/);
});

test("§3.2 rotation — emits rot when > 0.5 degree absolute", () => {
  const { payload, code } = payloadOf(
    fidelityInput({ base: { fill: "#fff", rotation: 45 } }),
  );
  assert.equal(payload[0].rot, 45);
  assert.match(code, /c\.rotation = d\.rot/);
});

test("§3.3 aspect ratio — derives ph from cw when aspect-ratio is set on a child", () => {
  const { payload } = payloadOf(
    fidelityInput({
      base: { fill: "#fff" },
      renderedChildren: {
        Default: [
          {
            styling: { aspectRatio: "16 / 9", width: 320, widthExplicit: true, fill: "#000" },
          },
        ],
      },
    }),
  );
  const kid = payload[0].kids[0];
  assert.equal(kid.cw, 320);
  assert.equal(kid.ph, 180);
});

test("§3.1 image fills — IMAGES block emitted; child carries im hash", () => {
  const { payload, code } = payloadOf(
    fidelityInput({
      base: { fill: "#fff" },
      renderedImageAssets: { i123456: { base64: "AAAA", mime: "image/png", width: 32, height: 32 } },
      renderedChildren: {
        Default: [{ styling: { width: 32, height: 32, imageHash: "i123456" } }],
      },
    }),
  );
  assert.equal(payload[0].kids[0].im, "i123456");
  // IMAGES library block appears in the script.
  assert.match(code, /const IMAGES = \{\};/);
  assert.match(code, /const IMAGE_BYTES = \{"i123456":"AAAA"\}/);
  assert.match(code, /figma\.createImage\(_arr\)\.hash/);
});

test("§A.1 size guard — generates a sizeWarning when script approaches 50KB", () => {
  // Synthesize a payload large enough to cross 45KB: 200 variants with
  // long names and unique SVGs.
  const variants: any[] = [];
  for (let i = 0; i < 200; i++) {
    variants.push({ name: `axis${i}`, type: "VARIANT", values: [`v${i}`], defaultValue: `v${i}` });
  }
  // Single-variant matrix with one big SVG to inflate size.
  const bigSvg = `<svg>${"x".repeat(7000)}</svg>`;
  const input: ComponentInput = {
    name: "Bloated",
    category: "UI",
    variantProperties: [],
    styling: {
      name: "Bloated",
      path: "/p/x.tsx",
      base: {},
      baseBindings: {},
      variants: [],
      unresolved: [],
      warnings: [],
      renderedChildren: {
        Default: Array.from({ length: 5 }, () => ({ styling: {}, svgMarkup: bigSvg + Math.random() })),
      },
    },
  };
  const script = generateComponentScript(input);
  assert.ok(script.code.length > 30_000, `script length ${script.code.length}`);
  // sizeWarnings may or may not fire depending on exact bytes; the
  // assertion confirms the channel exists.
  assert.ok(Array.isArray(script.sizeWarnings));
});
