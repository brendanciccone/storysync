import { test } from "node:test";
import assert from "node:assert/strict";
import {
  colorToHex,
  numericToPx,
  canonicalizeCompound,
  figmaCollectionToCategory,
  diffTokens,
  diffComponents,
  selectDiffComponents,
  narrowFigmaComponents,
  computeDiffSummary,
  hasDifferences,
} from "../diff.js";
import type { TokenCollection } from "../tokens.js";
import { extractFirstBalancedObject } from "../figma.js";
import type { FigmaVariable, FigmaComponentInfo } from "../figma.js";
import type { FigmaComponentDefinition } from "../mapper.js";

// --- colorToHex ---

test("colorToHex: 6-digit hex passes through lowercased", () => {
  assert.equal(colorToHex("#FFFFFF"), "#ffffff");
  assert.equal(colorToHex("#3B82F6"), "#3b82f6");
});

test("colorToHex: 3-digit hex expands to 6", () => {
  assert.equal(colorToHex("#fff"), "#ffffff");
  assert.equal(colorToHex("#0a0"), "#00aa00");
});

test("colorToHex: 8-digit hex preserved", () => {
  assert.equal(colorToHex("#3b82f680"), "#3b82f680");
});

test("colorToHex: rgb()", () => {
  assert.equal(colorToHex("rgb(255, 255, 255)"), "#ffffff");
  assert.equal(colorToHex("rgb(59, 130, 246)"), "#3b82f6");
});

test("colorToHex: rgba() with alpha", () => {
  assert.equal(colorToHex("rgba(0, 0, 0, 0.5)"), "#00000080");
  assert.equal(colorToHex("rgba(0, 0, 0, 1)"), "#000000");
});

test("colorToHex: rgb percentages", () => {
  assert.equal(colorToHex("rgb(100%, 100%, 100%)"), "#ffffff");
});

test("colorToHex: hsl() to hex", () => {
  assert.equal(colorToHex("hsl(0, 100%, 50%)"), "#ff0000");
  assert.equal(colorToHex("hsl(120, 100%, 50%)"), "#00ff00");
  assert.equal(colorToHex("hsl(240, 100%, 50%)"), "#0000ff");
});

test("colorToHex: named colors", () => {
  assert.equal(colorToHex("white"), "#ffffff");
  assert.equal(colorToHex("BLACK"), "#000000");
  assert.equal(colorToHex("transparent"), "#00000000");
});

test("colorToHex: returns null for non-color input", () => {
  assert.equal(colorToHex("16px"), null);
  assert.equal(colorToHex("not-a-color"), null);
});

// --- numericToPx ---

test("numericToPx: rem to px", () => {
  assert.equal(numericToPx("1rem"), "16");
  assert.equal(numericToPx("0.5rem"), "8");
  assert.equal(numericToPx("1.25rem"), "20");
});

test("numericToPx: px stripped", () => {
  assert.equal(numericToPx("16px"), "16");
  assert.equal(numericToPx("12.5px"), "12.5");
});

test("numericToPx: unitless preserved", () => {
  assert.equal(numericToPx("16"), "16");
});

test("numericToPx: negative values", () => {
  assert.equal(numericToPx("-0.5rem"), "-8");
  assert.equal(numericToPx("-4px"), "-4");
  assert.equal(numericToPx("-16"), "-16");
});

test("numericToPx: non-numeric returned as-is normalized", () => {
  assert.equal(numericToPx("auto"), "auto");
});

// --- canonicalizeCompound ---

test("canonicalizeCompound: collapses whitespace", () => {
  assert.equal(canonicalizeCompound("0  4px   6px"), "0 4px 6px");
});

test("canonicalizeCompound: tidies commas", () => {
  assert.equal(canonicalizeCompound("rgba(0,0,0,0.1)"), "rgba(0, 0, 0, 0.1)");
});

test("canonicalizeCompound: lowercases", () => {
  assert.equal(canonicalizeCompound("0 4px 6px RGBA(0, 0, 0, 0.1)"), "0 4px 6px rgba(0, 0, 0, 0.1)");
});

// --- figmaCollectionToCategory ---

test("figmaCollectionToCategory: maps known names", () => {
  assert.equal(figmaCollectionToCategory("Colors"), "colors");
  assert.equal(figmaCollectionToCategory("Spacing"), "spacing");
  assert.equal(figmaCollectionToCategory("Border Radius"), "radius");
  assert.equal(figmaCollectionToCategory("Shadows"), "shadows");
  assert.equal(figmaCollectionToCategory("Typography"), "typography");
});

test("figmaCollectionToCategory: unknown name lowercased", () => {
  assert.equal(figmaCollectionToCategory("Brand Primitives"), "brand primitives");
});

// --- diffTokens ---

test("diffTokens: matching color in different formats", () => {
  const code: TokenCollection[] = [
    { category: "colors", tokens: [{ name: "primary/500", value: "rgb(59, 130, 246)" }] },
  ];
  const figma: FigmaVariable[] = [
    { name: "primary/500", value: "#3b82f6", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
  ];
  const diffs = diffTokens(code, figma);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].status, "match");
});

test("diffTokens: a Tailwind v4 oklch token matches Figma's hex variable for it", () => {
  // Tailwind v4 and shadcn/ui write colours in oklch, and Figma reads its
  // variables back as sRGB hex. Compared as written, every one was a mismatch.
  const code: TokenCollection[] = [
    {
      category: "colors",
      tokens: [
        { name: "red/500", value: "oklch(63.7% 0.237 25.331)" },
        { name: "red/600", value: "oklch(57.7% 0.245 27.325)" },
        { name: "primary", value: "oklch(0.205 0 0)" },
        { name: "brand", value: "color(display-p3 1 0 0)" },
        { name: "ring", value: "oklch(63.7% 0.237 25.331 / 50%)" },
      ],
    },
  ];
  const figma: FigmaVariable[] = [
    { name: "red/500", value: "#fb2c36", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
    { name: "red/600", value: "#e7000b", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
    { name: "primary", value: "#171717", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
    { name: "brand", value: "#ff0000", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
    { name: "ring", value: "#fb2c3680", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
  ];
  for (const entry of diffTokens(code, figma)) assert.equal(entry.status, "match", entry.name);
});

test("diffTokens: bare HSL channels, as shadcn/ui's :root writes them, match Figma's hex", () => {
  // colorToHex can't read `0 0% 100%`, so these were compared as strings
  // with Figma's hex, a mismatch every time.
  const code: TokenCollection[] = [
    {
      category: "colors",
      tokens: [
        { name: "background", value: "0 0% 100%" },
        { name: "sidebar/primary", value: "240 5.9% 10%" },
        { name: "foreground", value: "222.2 84% 4.9%" },
        { name: "overlay", value: "240 5.9% 10% / 0.5" },
      ],
    },
  ];
  const figma: FigmaVariable[] = [
    { name: "background", value: "#ffffff", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
    { name: "sidebar/primary", value: "#18181b", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
    { name: "foreground", value: "#020817", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
    { name: "overlay", value: "#18181b80", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
  ];
  for (const entry of diffTokens(code, figma)) assert.equal(entry.status, "match", entry.name);
  const off = [{ ...figma[0], value: "#fefefe" }];
  assert.equal(diffTokens([{ category: "colors", tokens: [code[0].tokens[0]] }], off)[0].status, "value_mismatch");
});

test("diffTokens: an oklch token still mismatches a Figma colour one step off", () => {
  const code: TokenCollection[] = [{ category: "colors", tokens: [{ name: "red/500", value: "oklch(63.7% 0.237 25.331)" }] }];
  const figma: FigmaVariable[] = [
    { name: "red/500", value: "#fb2c37", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
  ];
  assert.equal(diffTokens(code, figma)[0].status, "value_mismatch");
});

test("diffTokens: rem vs px equivalence", () => {
  const code: TokenCollection[] = [
    { category: "spacing", tokens: [{ name: "4", value: "1rem" }] },
  ];
  const figma: FigmaVariable[] = [
    { name: "4", value: "16", collection: "Spacing", resolvedType: "FLOAT", mode: "Default" },
  ];
  const diffs = diffTokens(code, figma);
  assert.equal(diffs[0].status, "match");
});

test("diffTokens: value mismatch", () => {
  const code: TokenCollection[] = [
    { category: "colors", tokens: [{ name: "primary", value: "#ff0000" }] },
  ];
  const figma: FigmaVariable[] = [
    { name: "primary", value: "#00ff00", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
  ];
  const diffs = diffTokens(code, figma);
  assert.equal(diffs[0].status, "value_mismatch");
});

test("diffTokens: missing from Figma", () => {
  const code: TokenCollection[] = [
    { category: "colors", tokens: [{ name: "primary", value: "#ff0000" }] },
  ];
  const diffs = diffTokens(code, []);
  assert.equal(diffs[0].status, "missing_from_figma");
  assert.equal(diffs[0].codeValue, "#ff0000");
  assert.equal(diffs[0].figmaValue, null);
});

test("diffTokens: missing from code", () => {
  const figma: FigmaVariable[] = [
    { name: "primary", value: "#ff0000", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
  ];
  const diffs = diffTokens([], figma);
  assert.equal(diffs[0].status, "missing_from_code");
});

test("diffTokens: token name with slash preserved", () => {
  const code: TokenCollection[] = [
    { category: "colors", tokens: [{ name: "primary/500", value: "#3b82f6" }] },
  ];
  const figma: FigmaVariable[] = [
    { name: "primary/500", value: "#3b82f6", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
  ];
  const diffs = diffTokens(code, figma);
  assert.equal(diffs[0].name, "primary/500");
  assert.equal(diffs[0].status, "match");
});

test("diffTokens: shadow comparison via canonicalization", () => {
  const code: TokenCollection[] = [
    { category: "shadows", tokens: [{ name: "sm", value: "0 1px 2px rgba(0,0,0,0.05)" }] },
  ];
  const figma: FigmaVariable[] = [
    { name: "sm", value: "0  1px  2px RGBA(0, 0, 0, 0.05)", collection: "Shadows", resolvedType: "STRING", mode: "Default" },
  ];
  const diffs = diffTokens(code, figma);
  assert.equal(diffs[0].status, "match");
});

// --- diffComponents ---

test("diffComponents: matching component", () => {
  const code: FigmaComponentDefinition[] = [{
    name: "Button",
    variantProperties: [{ name: "size", type: "VARIANT", values: ["sm", "md"], defaultValue: "md" }],
    variantCombinations: [],
    wasCapped: false,
  }];
  const figma: FigmaComponentInfo[] = [{
    name: "Button",
    variantProperties: [{ name: "size", type: "VARIANT", values: ["sm", "md"] }],
    variantCount: 2,
  }];
  const diffs = diffComponents(code, figma);
  assert.equal(diffs[0].status, "match");
});

test("diffComponents: code-only component reports prop count", () => {
  const code: FigmaComponentDefinition[] = [{
    name: "Card",
    variantProperties: [{ name: "elevated", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" }],
    variantCombinations: [],
    wasCapped: false,
  }];
  const diffs = diffComponents(code, []);
  assert.equal(diffs[0].status, "code_only");
  assert.equal(diffs[0].details[0], "1 variant prop in code");
});

test("diffComponents: code-only component with no variants", () => {
  const code: FigmaComponentDefinition[] = [{
    name: "Avatar",
    variantProperties: [],
    variantCombinations: [],
    wasCapped: false,
  }];
  const diffs = diffComponents(code, []);
  assert.equal(diffs[0].details[0], "no variants in code");
});

test("diffComponents: variant value mismatch", () => {
  const code: FigmaComponentDefinition[] = [{
    name: "Button",
    variantProperties: [{ name: "size", type: "VARIANT", values: ["sm", "md", "lg"], defaultValue: "md" }],
    variantCombinations: [],
    wasCapped: false,
  }];
  const figma: FigmaComponentInfo[] = [{
    name: "Button",
    variantProperties: [{ name: "size", type: "VARIANT", values: ["sm", "md"] }],
    variantCount: 2,
  }];
  const diffs = diffComponents(code, figma);
  assert.equal(diffs[0].status, "variant_mismatch");
  assert.ok(diffs[0].details.some((d) => d.includes("lg")));
});

// --- summary ---

test("computeDiffSummary: counts each status correctly", () => {
  const summary = computeDiffSummary(
    [
      { category: "colors", name: "a", codeValue: "#fff", figmaValue: "#fff", status: "match" },
      { category: "colors", name: "b", codeValue: "#000", figmaValue: "#111", status: "value_mismatch" },
      { category: "colors", name: "c", codeValue: "#222", figmaValue: null, status: "missing_from_figma" },
      { category: "colors", name: "d", codeValue: null, figmaValue: "#333", status: "missing_from_code" },
    ],
    [
      { name: "Button", status: "match", details: [] },
      { name: "Card", status: "variant_mismatch", details: [] },
      { name: "Modal", status: "code_only", details: [] },
      { name: "Toast", status: "figma_only", details: [] },
    ],
  );
  assert.equal(summary.tokensMatched, 1);
  assert.equal(summary.tokensMismatched, 1);
  assert.equal(summary.tokensMissingFromFigma, 1);
  assert.equal(summary.tokensMissingFromCode, 1);
  assert.equal(summary.componentsMatched, 1);
  assert.equal(summary.componentsMismatched, 1);
  assert.equal(summary.componentsCodeOnly, 1);
  assert.equal(summary.componentsFigmaOnly, 1);
});

test("hasDifferences: false when only matches", () => {
  const summary = computeDiffSummary(
    [{ category: "colors", name: "a", codeValue: "#fff", figmaValue: "#fff", status: "match" }],
    [{ name: "Button", status: "match", details: [] }],
  );
  assert.equal(hasDifferences(summary), false);
});

test("hasDifferences: true when any mismatch", () => {
  const summary = computeDiffSummary(
    [{ category: "colors", name: "a", codeValue: "#fff", figmaValue: "#000", status: "value_mismatch" }],
    [],
  );
  assert.equal(hasDifferences(summary), true);
});

// --- extractFirstBalancedObject ---

test("extractFirstBalancedObject: simple object", () => {
  assert.equal(extractFirstBalancedObject('{"total":0,"next":null,"items":[]}'), '{"total":0,"next":null,"items":[]}');
});

test("extractFirstBalancedObject: nested objects, after other text", () => {
  const input = 'Result:\n{"total":1,"next":null,"items":[{"name":"Button","values":["sm","md"]}]}\nDone';
  assert.equal(extractFirstBalancedObject(input), '{"total":1,"next":null,"items":[{"name":"Button","values":["sm","md"]}]}');
});

test("extractFirstBalancedObject: braces inside strings", () => {
  const input = '{"name":"test}value","data":"a{b"}';
  assert.equal(extractFirstBalancedObject(input), input);
});

test("extractFirstBalancedObject: escaped quotes in strings", () => {
  const input = '{"name":"say \\"hello}\\""}';
  assert.equal(extractFirstBalancedObject(input), input);
});

test("extractFirstBalancedObject: no object returns null", () => {
  assert.equal(extractFirstBalancedObject('no objects here'), null);
});

test("extractFirstBalancedObject: unbalanced returns null", () => {
  assert.equal(extractFirstBalancedObject('{"items":[1,2,3]'), null);
});

test("diffComponents: two code components sharing a bare name are flagged, not silently dropped", () => {
  // Forms/Button and Nav/Button are ordinary in a real design system. Keyed on
  // the bare name, one would overwrite the other and `diff --strict` would
  // report "no differences" for a library it never fully read.
  const code = [
    { name: "Button", variantProperties: [{ name: "variant", type: "VARIANT", values: ["a"] }] },
    { name: "Button", variantProperties: [{ name: "size", type: "VARIANT", values: ["sm"] }] },
  ] as never[];
  const figma = [
    { name: "Button", variantProperties: [{ name: "variant", type: "VARIANT", values: ["a"] }] },
  ] as never[];

  const entries = diffComponents(code, figma);
  // The first code Button matches Figma's, but which of the two Figma's is
  // was never chosen: a match beside the ambiguous entry would count the one
  // name twice, and vouch for a pairing nothing made.
  assert.deepEqual(entries.map((e) => [e.name, e.status]), [["Button", "ambiguous"]]);
  assert.deepEqual(entries[0].details, ["2 components share this name in code, and Figma has one; none was compared"]);
  const summary = computeDiffSummary([], entries);
  assert.equal(summary.componentsAmbiguous, 1);
  assert.equal(summary.componentsMatched, 0);
  assert.equal(hasDifferences(summary), true);
});

test("diffComponents: a name on two Figma pages is flagged, and neither page's compared", () => {
  // diff reads every page, in order, and an archive page after the library
  // can keep an old Button. Keyed on the name alone, the archived copy would
  // be the one compared, and with no word that another existed. Comparing the
  // first page's instead would still pick one, and count Button twice: as
  // ambiguous and as matched.
  const code = [
    { name: "Button", variantProperties: [{ name: "size", type: "VARIANT", values: ["sm", "lg"] }] },
  ] as never[];
  const figma = [
    { name: "Button", variantProperties: [{ name: "size", type: "VARIANT", values: ["sm", "lg"] }], variantCount: 2 },
    { name: "Badge", variantProperties: [], variantCount: 1 },
    { name: "button", variantProperties: [{ name: "size", type: "VARIANT", values: ["sm"] }], variantCount: 1 },
  ];

  const entries = diffComponents(code, figma);
  assert.deepEqual(entries.map((e) => [e.name, e.status]), [["Button", "ambiguous"], ["Badge", "figma_only"]]);
  assert.deepEqual(entries[0].details, ["2 Figma components share this name, and code has one; none was compared"]);
  const summary = computeDiffSummary([], entries);
  assert.equal(summary.componentsAmbiguous, 1);
  assert.equal(summary.componentsMatched, 0);
  assert.equal(summary.componentsMismatched, 0);
  assert.equal(hasDifferences(summary), true);
});

test("diffComponents: a name repeated in code and in Figma is one ambiguous entry that says both", () => {
  const button = { name: "Button", variantProperties: [], variantCount: 1 };
  const entries = diffComponents([button, button, button] as never[], [button, button]);
  assert.deepEqual(entries.map((e) => [e.status, e.details]), [["ambiguous", ["3 components share this name in code, and 2 in Figma; none was compared"]]]);
});

test("diffComponents: a repeated name one side lacks is ambiguous only, not also missing from the other", () => {
  // Each name is one entry, so the summary's counts add up to the names read.
  const button = { name: "Button", variantProperties: [{ name: "size", type: "VARIANT", values: ["sm"] }], variantCount: 1 };
  const card = { name: "Card", variantProperties: [], variantCount: 1 };
  const entries = diffComponents([button, button, card] as never[], [card, card]);
  assert.deepEqual(entries.map((e) => [e.name, e.status, e.details]), [
    ["Button", "ambiguous", ["2 components share this name in code, and Figma has none; none was compared"]],
    ["Card", "ambiguous", ["2 Figma components share this name, and code has one; none was compared"]],
  ]);
  const summary = computeDiffSummary([], entries);
  assert.deepEqual(
    [summary.componentsAmbiguous, summary.componentsCodeOnly, summary.componentsFigmaOnly, summary.componentsMatched],
    [2, 0, 0, 0],
  );

  const figmaOnly = diffComponents([], [button, button]);
  assert.deepEqual(figmaOnly.map((e) => [e.status, e.details]), [["ambiguous", ["2 Figma components share this name, and code has none; none was compared"]]]);
});

// --- selectDiffComponents ---

const STORYBOOK = [
  { id: "forms-button", name: "Button" },
  { id: "data-display-card", name: "Card" },
];

function figmaComponent(name: string): FigmaComponentInfo {
  return { name, variantProperties: [], variantCount: 1 };
}

const FIGMA = [figmaComponent("Button"), figmaComponent("Card"), figmaComponent("Badge")];

/** Diffs the selection the way the diff command does, with no variant props on either side. */
function diffSelection(names: string[]) {
  const { entries, figmaComponents } = selectDiffComponents(STORYBOOK, FIGMA, names);
  const code = entries.map((e) => ({ name: e.name, variantProperties: [], variantCombinations: [], wasCapped: false }));
  return diffComponents(code, figmaComponents);
}

test("selectDiffComponents: narrows Figma too, so unselected components are not reported missing from code", () => {
  // Card is in code; it was only left out of the diff. Reporting it (and Badge)
  // as figma_only made `diff --components Button --strict` fail on any file
  // holding more than Button.
  const diffs = diffSelection(["Button"]);
  assert.deepEqual(diffs.map((d) => [d.name, d.status]), [["Button", "match"]]);
});

test("selectDiffComponents: a name picked by Storybook ID carries over to Figma by name", () => {
  const diffs = diffSelection(["data-display-card"]);
  assert.deepEqual(diffs.map((d) => [d.name, d.status]), [["Card", "match"]]);
});

test("selectDiffComponents: a name only Figma has is reported as not in code, not rejected as a typo", () => {
  const diffs = diffSelection(["Button", "badge"]);
  assert.deepEqual(diffs.map((d) => [d.name, d.status]), [["Button", "match"], ["Badge", "figma_only"]]);
  assert.equal(hasDifferences(computeDiffSummary([], diffs)), true);
});

test("selectDiffComponents: a name neither side has is an error listing both sides", () => {
  assert.throws(
    () => selectDiffComponents(STORYBOOK, FIGMA, ["Button", "Buton"]),
    { message: '--components matched no component named "Buton". Available: Badge, Button, Card' },
  );
});

test("selectDiffComponents: no names leaves both sides whole", () => {
  const { entries, figmaComponents } = selectDiffComponents(STORYBOOK, FIGMA, [" "]);
  assert.equal(entries, STORYBOOK);
  assert.equal(figmaComponents, FIGMA);
});

// --- narrowFigmaComponents ---

test("narrowFigmaComponents: keeps the named Figma components, by name, without rejecting any name", () => {
  // For a diff whose Storybook listing failed: an ID, or a name Figma lacks,
  // can't be told from a typo, so it narrows to nothing rather than throwing.
  const kept = narrowFigmaComponents(FIGMA, [" button", "forms-card", "Nope"]);
  assert.deepEqual(kept.map((c) => c.name), ["Button"]);
});

test("narrowFigmaComponents: no names leaves Figma whole", () => {
  assert.equal(narrowFigmaComponents(FIGMA, ["", " "]), FIGMA);
  assert.equal(narrowFigmaComponents(FIGMA, undefined), FIGMA);
});
