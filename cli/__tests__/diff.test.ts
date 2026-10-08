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
import type { CodeComponent } from "../diff.js";
import type { ComponentEntry } from "../storybook.js";

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

test("numericToPx: calc() is worked out, as shadcn/ui writes its radius scale", () => {
  assert.equal(numericToPx("calc(0.625rem - 4px)"), "6");
  assert.equal(numericToPx("calc(0.25rem * 4)"), "16");
  // Not a fixed length: compared as written.
  assert.equal(numericToPx("calc(1em - 4px)"), "calc(1em - 4px)");
  assert.equal(numericToPx("-0.025em"), "-0.025em");
});

test("numericToPx: a float's binary noise is rounded off on both sides", () => {
  // 0.1rem was 1.6000000000000001, and a float Figma hands back can carry
  // the same kind of tail.
  assert.equal(numericToPx("0.1rem"), "1.6");
  assert.equal(numericToPx("1.600000023841858"), "1.6");
  assert.equal(numericToPx("0.30000001192092896"), "0.3");
  // A real difference still shows.
  assert.equal(numericToPx("10.002"), "10.002");
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
  // Tailwind v4 and shadcn/ui write colors in oklch, and Figma reads its
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

test("diffTokens: an oklch token still mismatches a Figma color one step off", () => {
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

test("diffTokens: shadcn/ui's calc() radius scale matches the px a correct push gives Figma", () => {
  // Compared as written, 6 of 7 radii were a mismatch against an exactly
  // right Figma file: only lg, a bare rem, matched.
  const code: TokenCollection[] = [{
    category: "radius",
    tokens: [
      { name: "sm", value: "calc(0.625rem - 4px)", px: 6 },
      { name: "md", value: "calc(0.625rem - 2px)", px: 8 },
      { name: "lg", value: "0.625rem", px: 10 },
      { name: "xl", value: "calc(0.625rem + 4px)", px: 14 },
      { name: "4xl", value: "calc(0.625rem + 16px)", px: 26 },
    ],
  }];
  const figma: FigmaVariable[] = [["sm", "6"], ["md", "8"], ["lg", "10"], ["xl", "14"], ["4xl", "26"]].map(([name, value]) => (
    { name, value, collection: "Radius", resolvedType: "FLOAT", mode: "Default" }
  ));
  for (const entry of diffTokens(code, figma)) assert.equal(entry.status, "match", entry.name);
  // Without px, as a hand-built collection might be, the value is worked out the same way.
  const bare = code.map((c) => ({ ...c, tokens: c.tokens.map(({ name, value }) => ({ name, value })) }));
  for (const entry of diffTokens(bare, figma)) assert.equal(entry.status, "match", entry.name);
  assert.equal(diffTokens(code, [{ ...figma[0], value: "5" }])[0].status, "value_mismatch");
});

test("diffTokens: a :root token's px and hex are compared, as its value keeps the var() they were resolved from", () => {
  const code: TokenCollection[] = [
    { category: "radius", tokens: [{ name: "radius/sm", value: "calc(var(--radius) - 2px)", px: 6 }] },
    { category: "colors", tokens: [{ name: "ring", value: "hsl(var(--brand))", hex: "#4d80b3" }] },
  ];
  const figma: FigmaVariable[] = [
    { name: "radius/sm", value: "6", collection: "Radius", resolvedType: "FLOAT", mode: "Default" },
    { name: "ring", value: "#4D80B3", collection: "Colors", resolvedType: "COLOR", mode: "Default" },
  ];
  for (const entry of diffTokens(code, figma)) assert.equal(entry.status, "match", entry.name);
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

test("diffComponents: a repeated name one side lacks is missing from it, each copy once, not ambiguous", () => {
  // Every copy is missing whichever is which, so there is nothing to tell
  // apart: two Buttons Figma lacks are two components not in Figma, and two
  // Cards code lacks two not in code.
  const button = { name: "Button", variantProperties: [{ name: "size", type: "VARIANT", values: ["sm"] }], variantCount: 1 };
  const card = { name: "Card", variantProperties: [], variantCount: 1 };
  const entries = diffComponents([button, button] as never[], [card, card]);
  assert.deepEqual(entries.map((e) => [e.name, e.status, e.details]), [
    ["Components/Button", "code_only", ["1 variant prop in code"]],
    ["Components/Button", "code_only", ["1 variant prop in code"]],
    ["Card", "figma_only", ["no variants in Figma"]],
    ["Card", "figma_only", ["no variants in Figma"]],
  ]);

  // But one code Card beside two in Figma, on no pages that tell them apart,
  // is ambiguous only.
  const one = diffComponents([card] as never[], [card, card]);
  assert.deepEqual(one.map((e) => [e.name, e.status, e.details]), [
    ["Card", "ambiguous", ["2 Figma components share this name, and code has one; none was compared"]],
  ]);
  const summary = computeDiffSummary([], one);
  assert.deepEqual(
    [summary.componentsAmbiguous, summary.componentsCodeOnly, summary.componentsFigmaOnly, summary.componentsMatched],
    [1, 0, 0, 0],
  );
});

// --- A name told apart by page ---

/** A code component as diff gets it, from a component Storybook titles `title`. */
function titled(title: string, id: string, values: string[] = ["sm"], name = title.split("/").pop()!): CodeComponent {
  const category = title.split("/").slice(0, -1).join("/") || undefined;
  return { id, name, title, category, variantProperties: [{ name: "size", type: "VARIANT", values, defaultValue: values[0] }], variantCombinations: [], wasCapped: false };
}

function onPage(page: string | undefined, name: string, values: string[] = ["sm"]): FigmaComponentInfo {
  return { name, page, variantProperties: [{ name: "size", type: "VARIANT", values }], variantCount: values.length };
}

test("diffComponents: a name two categories share is compared page by page, as the push lays it out", () => {
  // Base UI's and Radix's Button, each pushed to its category's page. Every
  // name in such a library is shared, and paired by name alone all of them
  // were ambiguous: diff compared nothing.
  const code = [titled("ui/base/Button", "ui-base-button"), titled("ui/radix/Button", "ui-radix-button", ["sm", "lg"])];
  const figma = [onPage("ui/radix", "Button", ["sm"]), onPage("ui/base", "Button")];
  const entries = diffComponents(code, figma);
  assert.deepEqual(entries.map((e) => [e.name, e.status, e.id, e.page]), [
    ["ui/base/Button", "match", "ui-base-button", "ui/base"],
    ["ui/radix/Button", "variant_mismatch", "ui-radix-button", "ui/radix"],
  ]);
  assert.deepEqual(entries[1].details, ["size: values [lg] missing from Figma"]);
});

test("diffComponents: pages match ignoring case, spaces, - and _, as an earlier push named them", () => {
  // A push from titles rebuilt from IDs made the pages "UI Base" and "UI Radix".
  const code = [titled("ui/base/Button", "ui-base-button"), titled("ui/radix/Button", "ui-radix-button")];
  const entries = diffComponents(code, [onPage("UI Radix", "Button"), onPage("UI Base", "Button")]);
  assert.deepEqual(entries.map((e) => [e.name, e.status, e.page]), [
    ["ui/base/Button", "match", "UI Base"],
    ["ui/radix/Button", "match", "UI Radix"],
  ]);
});

test("diffComponents: of a shared name's copies left after pages, one on each side are ambiguous, and the rest are missing", () => {
  const code = [titled("ui/base/Button", "ui-base-button"), titled("ui/radix/Button", "ui-radix-button")];
  // Radix's Button was moved to a page of the designer's own, or it was never
  // pushed and the set is someone else's: nothing tells which, so the two are
  // not compared, and the pages are named.
  const moved = diffComponents(code, [onPage("ui/base", "Button"), onPage("Buttons", "Button")]);
  assert.deepEqual(moved.map((e) => [e.name, e.status, e.page, e.details]), [
    ["Button", "ambiguous", undefined, [
      "one copy in code and one in Figma are on different pages, besides 1 paired by page; neither of these was compared",
      "in code for ui/radix; in Figma on Buttons",
    ]],
    ["ui/base/Button", "match", "ui/base", []],
  ]);
  assert.equal(hasDifferences(computeDiffSummary([], moved)), true);

  // Nav's Button not pushed yet, beside an archived Button: paired, it would
  // have been compared with the archive's, and said to match.
  const unpushed = diffComponents(
    [titled("Forms/Button", "forms-button"), titled("Nav/Button", "nav-button")],
    [onPage("Forms", "Button"), onPage("Archive", "Button")],
  );
  assert.deepEqual(unpushed.map((e) => [e.name, e.status]), [["Button", "ambiguous"], ["Forms/Button", "match"]]);
  assert.deepEqual(unpushed[0].details.slice(1), ["in code for Nav; in Figma on Archive"]);

  // One code component and one set of a name nobody else has are still a
  // pair, whatever page the set is on.
  const alone = diffComponents([titled("ui/radix/Button", "ui-radix-button")], [onPage("Buttons", "Button")]);
  assert.deepEqual(alone.map((e) => [e.name, e.status, e.page]), [["Button", "match", "Buttons"]]);

  // An archived copy beside both: it is the Button not in code.
  const archived = diffComponents(code, [onPage("ui/base", "Button"), onPage("ui/radix", "Button"), onPage("Archive", "Button")]);
  assert.deepEqual(archived.map((e) => [e.name, e.status]), [
    ["ui/base/Button", "match"],
    ["ui/radix/Button", "match"],
    ["Archive/Button", "figma_only"],
  ]);

  // Radix's not pushed yet, and no other copy to mistake for it.
  const missing = diffComponents(code, [onPage("ui/base", "Button")]);
  assert.deepEqual(missing.map((e) => [e.name, e.status]), [["ui/base/Button", "match"], ["ui/radix/Button", "code_only"]]);
});

test("diffComponents: copies no page tells apart are ambiguous, and only they are", () => {
  const code = [titled("ui/base/Button", "ui-base-button"), titled("ui/radix/Button", "ui-radix-button"), titled("ui/other/Button", "ui-other-button")];
  const entries = diffComponents(code, [onPage("ui/base", "Button"), onPage("Archive", "Button"), onPage("Library", "Button")]);
  assert.deepEqual(entries.map((e) => [e.name, e.status, e.details]), [
    ["Button", "ambiguous", [
      "2 components share this name in code, and 2 in Figma, besides 1 paired by page; none of these was compared",
      "in code for ui/radix, ui/other; in Figma on Archive, Library",
    ]],
    ["ui/base/Button", "match", []],
  ]);

  // Two sets of the name on its one page can't be told apart either.
  const twice = diffComponents([titled("Forms/Button", "forms-button")], [onPage("Forms", "Button"), onPage("Forms", "Button")]);
  assert.deepEqual(twice.map((e) => [e.name, e.status, e.details]), [["Button", "ambiguous", [
    "2 Figma components share this name, and code has one; none was compared",
    "in code for Forms; in Figma on Forms",
  ]]]);
});

test("diffComponents: a set is named by its title's last segment, or by the component's name where an earlier push named it so", () => {
  // The stories titled ui/base/Tooltip document TooltipContent, and the
  // DatePicker's document Calendar, as Calendar's own do: named by the
  // component, DatePicker's set was Calendar's.
  const code = [
    titled("ui/base/Tooltip", "ui-base-tooltip", ["sm"], "TooltipContent"),
    titled("ui/base/Calendar", "ui-base-calendar"),
    titled("ui/base/DatePicker", "ui-base-datepicker", ["sm"], "Calendar"),
  ];
  const pushed = diffComponents(code, [onPage("ui/base", "Tooltip"), onPage("ui/base", "Calendar"), onPage("ui/base", "DatePicker")]);
  assert.deepEqual(pushed.map((e) => [e.name, e.status]), [["Tooltip", "match"], ["Calendar", "match"], ["DatePicker", "match"]]);

  // A file pushed before: TooltipContent is still compared, as Tooltip.
  const earlier = diffComponents([code[0]], [onPage("ui/base", "TooltipContent")]);
  assert.deepEqual(earlier.map((e) => [e.name, e.status]), [["TooltipContent", "match"]]);

  // But not a name another component's set goes by: Calendar is Calendar's
  // set, so the DatePicker, not pushed yet, is not in Figma, rather than a
  // second Calendar that made both ambiguous.
  const partly = diffComponents(code.slice(1), [onPage("ui/base", "Calendar")]);
  assert.deepEqual(partly.map((e) => [e.name, e.status]), [["Calendar", "match"], ["DatePicker", "code_only"]]);
});

test("diffComponents: a component code couldn't map reports nothing, nor does its set", () => {
  const code = [titled("ui/base/Button", "ui-base-button")];
  const figma = [onPage("ui/base", "Button"), onPage("ui/radix", "Button")];
  const entries = diffComponents(code, figma, [{ id: "ui-radix-button", name: "Button", title: "ui/radix/Button", category: "ui/radix" }]);
  assert.deepEqual(entries.map((e) => [e.name, e.status]), [["ui/base/Button", "match"]]);
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

/** Diffs the selection the way the diff command does, with no variant props on Storybook's side. */
function diffSelection(names: string[], storybook: ComponentEntry[] = STORYBOOK, figma: FigmaComponentInfo[] = FIGMA) {
  const { entries, others, figmaReported } = selectDiffComponents(storybook, figma, names);
  const code = entries.map((e) => ({ ...e, variantProperties: [], variantCombinations: [], wasCapped: false }));
  return diffComponents(code, figma, others, figmaReported);
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
  const { entries, others, figmaReported } = selectDiffComponents(STORYBOOK, FIGMA, [" "]);
  assert.equal(entries, STORYBOOK);
  assert.deepEqual(others, []);
  assert.equal(figmaReported, FIGMA);
});

/** A set with no variant properties, as diffSelection's code components have none. */
function bareOnPage(page: string, name: string): FigmaComponentInfo {
  return { name, page, variantProperties: [], variantCount: 1 };
}

test("selectDiffComponents: a component picked by ID or title is paired as the whole diff pairs it", () => {
  // Narrowed to the sets named like it, ui-base-button brought Radix's Button
  // too, and a set moved off Radix's page was the only one left for
  // ui-radix-button, and its pair, where the whole diff can't tell it apart.
  const entries = [
    { id: "ui-base-button", name: "Button", title: "ui/base/Button", category: "ui/base" },
    { id: "ui-radix-button", name: "Button", title: "ui/radix/Button", category: "ui/radix" },
  ];
  const figma = [bareOnPage("ui/base", "Button"), bareOnPage("ui/radix", "Button")];
  for (const name of ["ui-base-button", "UI/BASE/BUTTON"]) {
    const picked = selectDiffComponents(entries, figma, [name]);
    assert.deepEqual([picked.entries.map((e) => e.id), picked.others.map((e) => e.id)], [["ui-base-button"], ["ui-radix-button"]], name);
    assert.deepEqual(diffSelection([name], entries, figma).map((e) => [e.name, e.status, e.page]), [["ui/base/Button", "match", "ui/base"]], name);
  }

  // Radix's set moved to a page of its own: the same answer for it as the
  // whole diff gives, and none for Base UI's, which nobody asked about.
  const moved = [bareOnPage("ui/base", "Button"), bareOnPage("Buttons", "Button")];
  const whole = diffSelection([], entries, moved);
  assert.deepEqual(whole.map((e) => [e.name, e.status]), [["Button", "ambiguous"], ["ui/base/Button", "match"]]);
  assert.deepEqual(diffSelection(["ui-radix-button"], entries, moved), whole.slice(0, 1));
  assert.deepEqual(diffSelection(["ui-base-button"], entries, moved), whole.slice(1));
  // Asked about by its page and name, the moved set is the same ambiguous name.
  assert.deepEqual(diffSelection(["buttons/button"], entries, moved), whole.slice(0, 1));

  // An archived set isn't reported for a component picked by ID...
  const archived = [...figma, bareOnPage("Archive", "Button")];
  assert.deepEqual(diffSelection(["ui-base-button"], entries, archived).map((e) => [e.name, e.status]), [["ui/base/Button", "match"]]);
  // ...but is for the name both share, which picks every set of it.
  assert.deepEqual(diffSelection(["Button"], entries, archived).map((e) => [e.name, e.status]), [
    ["ui/base/Button", "match"],
    ["ui/radix/Button", "match"],
    ["Archive/Button", "figma_only"],
  ]);
  // And so is a set only Figma has, by its page and name.
  const named = selectDiffComponents(entries, archived, ["archive/button"]);
  assert.deepEqual([named.entries, named.figmaReported.map((c) => c.page)], [[], ["Archive"]]);
  assert.deepEqual(diffSelection(["archive/button"], entries, archived).map((e) => [e.name, e.status]), [["Archive/Button", "figma_only"]]);
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

// --- Translucent color tokens ---

test("diffTokens: a translucent color token matches Figma's color with its alpha, and not without it", () => {
  // shadcn/ui's dark border is oklch(1 0 0 / 10%): tokens gives it the hex
  // #ffffff1a, and a Figma variable set from that hex reads back with its
  // alpha. Read as 6-digit hex, as the audit template wrote every color,
  // it could never match.
  const code: TokenCollection[] = [{ category: "colors", tokens: [{ name: "border", value: "oklch(1 0 0 / 10%)", hex: "#ffffff1a" }] }];
  const variable = (value: string): FigmaVariable[] => [{ name: "border", value, collection: "Colors", resolvedType: "COLOR", mode: "Default" }];
  assert.equal(diffTokens(code, variable("#FFFFFF1A"))[0].status, "match");
  assert.equal(diffTokens(code, variable("#ffffff"))[0].status, "value_mismatch");
  assert.equal(diffTokens(code, variable("#ffffff33"))[0].status, "value_mismatch");
  // Without a hex, the value itself is converted, alpha and all.
  const bare: TokenCollection[] = [{ category: "colors", tokens: [{ name: "border", value: "rgba(255, 255, 255, 0.1)" }] }];
  assert.equal(diffTokens(bare, variable("#ffffff1a"))[0].status, "match");
});

// --- Pairing by the Storybook ID the push stored ---

/** A Figma node the push stored a Storybook ID on, or none. */
function pushed(page: string, name: string, storybookId?: string, values: string[] = ["sm"], extra: Partial<FigmaComponentInfo> = {}): FigmaComponentInfo {
  return { ...onPage(page, name, values), type: "COMPONENT_SET", ...(storybookId ? { storybookId } : {}), ...extra };
}

test("diffComponents: a set carrying a Storybook ID pairs with that component, wherever a designer moved or renamed it", () => {
  // Both Buttons moved to a page of the designer's own. By name and page,
  // nothing told them apart; their IDs do.
  const code = [titled("ui/base/Button", "ui-base-button"), titled("ui/radix/Button", "ui-radix-button", ["sm", "lg"])];
  const moved = diffComponents(code, [pushed("Buttons", "Button", "ui-radix-button"), pushed("Buttons", "Button", "ui-base-button")]);
  assert.deepEqual(moved.map((e) => [e.name, e.status, e.page, e.details]), [
    ["ui/base/Button", "match", "Buttons", []],
    ["ui/radix/Button", "variant_mismatch", "Buttons", ["size: values [lg] missing from Figma"]],
  ]);
  // Renamed: still the component's set.
  const renamed = diffComponents([code[0]], [pushed("ui/base", "Primary button", "ui-base-button")]);
  assert.deepEqual(renamed.map((e) => [e.name, e.status]), [["Button", "match"]]);

  // Without IDs, the same file is a name nothing tells apart, as before.
  const bare = diffComponents(code, [pushed("Buttons", "Button"), pushed("Buttons", "Button")]);
  assert.deepEqual(bare.map((e) => e.status), ["ambiguous"]);
});

test("diffComponents: a set whose Storybook ID code doesn't have is not in code, and never another component's by name", () => {
  // Radix's Button not pushed yet, and Base UI's set the only Button in
  // Figma: by name alone, one of each is a pair, and Radix's code was
  // compared with Base UI's set.
  const radix = titled("ui/radix/Button", "ui-radix-button");
  const entries = diffComponents([radix], [pushed("ui/base", "Button", "ui-base-button")]);
  assert.deepEqual(entries.map((e) => [e.name, e.status, e.details]), [
    ["Button", "code_only", ["1 variant prop in code"]],
    ["Button", "figma_only", ["1 variant prop in Figma", "pushed from ui-base-button, which code no longer has"]],
  ]);
  // Left out of a selection, the other component claims it, and nothing is said of it.
  const selected = diffComponents([radix], [pushed("ui/base", "Button", "ui-base-button")], [{ id: "ui-base-button", name: "Button", title: "ui/base/Button", category: "ui/base" }]);
  assert.deepEqual(selected.map((e) => [e.name, e.status]), [["ui/radix/Button", "code_only"]]);
  // A set with no ID beside it still pairs by name, as before.
  const mixed = diffComponents([radix], [pushed("ui/base", "Button", "ui-base-button"), pushed("ui/radix", "Button")]);
  assert.deepEqual(mixed.map((e) => [e.name, e.status, e.page]), [
    ["ui/radix/Button", "match", "ui/radix"],
    ["ui/base/Button", "figma_only", "ui/base"],
  ]);
});

test("diffComponents: two sets of one Storybook ID, as a duplicated set has, are told apart by page", () => {
  const code = [titled("ui/base/Button", "ui-base-button")];
  const copy = diffComponents(code, [pushed("ui/base", "Button", "ui-base-button"), pushed("Scratch", "Button copy", "ui-base-button")]);
  assert.deepEqual(copy.map((e) => [e.name, e.status, e.page, e.details]), [
    ["Button", "match", "ui/base", []],
    ["Button copy", "figma_only", "Scratch", ["1 variant prop in Figma", "carries the Storybook ID ui-base-button of a component paired with another"]],
  ]);

  const neither = diffComponents(code, [pushed("Scratch", "Button", "ui-base-button"), pushed("Archive", "Button", "ui-base-button")]);
  assert.deepEqual(neither.map((e) => [e.name, e.status, e.details]), [["Button", "ambiguous", [
    "2 Figma components carry the Storybook ID ui-base-button; none was compared",
    "in code for ui/base; in Figma on Scratch, Archive",
  ]]]);
});

test("selectDiffComponents: a Storybook ID picks the Figma node that carries it", () => {
  const figma = [pushed("Archive", "Old button", "forms-old-button")];
  const { figmaReported } = selectDiffComponents(STORYBOOK, figma, ["forms-old-button"]);
  assert.deepEqual(figmaReported, figma);
  assert.deepEqual(narrowFigmaComponents(figma, ["FORMS-OLD-BUTTON"]), figma);
});

// --- Components outside any set ---

/** A component outside any set, as the push makes one with no variant properties. */
function plain(page: string, name: string, storybookId?: string): FigmaComponentInfo {
  return { name, page, type: "COMPONENT", variantProperties: [], variantCount: 1, ...(storybookId ? { storybookId } : {}) };
}

/** A code component with no variant properties. */
function bare(title: string, id: string): CodeComponent {
  return { ...titled(title, id), variantProperties: [] };
}

test("diffComponents: a component with no variant properties pairs with the plain component the push made for it", () => {
  const code = [bare("ui/base/Badge", "ui-base-badge"), bare("ui/radix/Badge", "ui-radix-badge")];
  // By the ID the push stored, wherever it is.
  const byId = diffComponents(code, [plain("Moved", "Badge", "ui-base-badge"), plain("ui/radix", "Badge", "ui-radix-badge")]);
  assert.deepEqual(byId.map((e) => [e.name, e.status, e.page]), [["ui/base/Badge", "match", "Moved"], ["ui/radix/Badge", "match", "ui/radix"]]);
  // With no ID, on its component's page.
  const byPage = diffComponents(code, [plain("ui/base", "Badge"), plain("ui/radix", "Badge")]);
  assert.deepEqual(byPage.map((e) => [e.name, e.status]), [["ui/base/Badge", "match"], ["ui/radix/Badge", "match"]]);

  // A component that has variant properties now, pushed plain when it had
  // none, is a mismatch to push again, not a pair of strangers.
  const grown = diffComponents([titled("ui/base/Badge", "ui-base-badge")], [plain("ui/base", "Badge", "ui-base-badge")]);
  assert.deepEqual(grown.map((e) => [e.status, e.details]), [["variant_mismatch", ['prop "size" missing from Figma']]]);
});

test("diffComponents: a plain component with no ID pairs only on its component's page, and never makes a name ambiguous", () => {
  // An icon library's Calendar is not shadcn's Calendar.
  const calendar = bare("ui/base/Calendar", "ui-base-calendar");
  const icon = diffComponents([calendar], [plain("Icons", "Calendar")]);
  assert.deepEqual(icon.map((e) => [e.name, e.status, e.page]), [["Calendar", "code_only", undefined], ["Calendar", "figma_only", "Icons"]]);

  // Beside the component's set, a plain component of its name elsewhere
  // leaves the set its pair, where a second set would be ambiguous.
  const button = titled("Forms/Button", "forms-button");
  const beside = diffComponents([button], [pushed("Library", "Button"), plain("Icons", "Button")]);
  assert.deepEqual(beside.map((e) => [e.name, e.status, e.page]), [["Forms/Button", "match", "Library"], ["Icons/Button", "figma_only", "Icons"]]);
  const twoSets = diffComponents([button], [pushed("Library", "Button"), pushed("Icons", "Button")]);
  assert.deepEqual(twoSets.map((e) => e.status), ["ambiguous"]);

  // Two plain components of the name on the component's page: neither is chosen.
  const twice = diffComponents([calendar], [plain("ui/base", "Calendar"), plain("ui/base", "Calendar")]);
  assert.deepEqual(twice.map((e) => [e.name, e.status]), [["ui/base/Calendar", "code_only"], ["ui/base/Calendar", "figma_only"], ["ui/base/Calendar", "figma_only"]]);
});

// --- Sets Figma flags as errored ---

test("diffComponents: a set Figma flags as errored is reported as errored, with its page and node, and compared with nothing", () => {
  // A set of one variant named "", as the push made for a component with no
  // variant properties, which Figma renames "=" and refuses to read.
  const error = "in get_componentPropertyDefinitions: Component set has existing errors";
  const errored = (page: string, name: string, nodeId: string, storybookId?: string) =>
    pushed(page, name, storybookId, [], { nodeId, error, variantProperties: [], variantCount: 1 });
  const code = [bare("ui/base/Button", "ui-base-button"), titled("ui/base/Card", "ui-base-card")];
  const figma = [errored("ui/base", "Button", "2:5"), pushed("ui/base", "Card"), errored("ui/base", "Dialog", "7:4", "ui-base-dialog")];
  const entries = diffComponents(code, figma);
  assert.deepEqual(entries.map((e) => [e.name, e.status, e.page, e.nodeId, e.details]), [
    ["Button", "errored", "ui/base", "2:5", [`errored in Figma (can't read its properties): ${error}`]],
    ["Card", "match", "ui/base", undefined, []],
    ["Dialog", "errored", "ui/base", "7:4", [`errored in Figma (can't read its properties): ${error}`, "pushed from ui-base-dialog, which code no longer has"]],
  ]);
  const summary = computeDiffSummary([], entries);
  assert.deepEqual([summary.componentsErrored, summary.componentsMatched, summary.componentsFigmaOnly], [2, 1, 0]);
  assert.equal(hasDifferences(summary), true);
  // Errored alone is still not in sync.
  assert.equal(hasDifferences(computeDiffSummary([], entries.slice(0, 1))), true);
});
