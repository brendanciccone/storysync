import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStyles,
  normalizeColor,
  pxToNumber,
  firstFontFamily,
  parseBorderSide,
  parseBoxShadow,
  splitTopLevel,
  encodeStoryArgs,
  buildStoryUrl,
  isEncodableArgValue,
  slugifyCombination,
  componentSlug,
  diffFromBase,
  applyDelta,
} from "../snap-normalize.js";
import type { RawComputedStyles } from "../snap-normalize.js";
import type { FigmaVariantProperty } from "../mapper.js";

// Captured from a real Chromium render of a Storybook story, so the fixtures
// match the exact shapes `getComputedStyle` produces.
const PRIMARY_SM: RawComputedStyles = {
  display: "inline-flex",
  "flex-direction": "row",
  "align-items": "center",
  "justify-content": "normal",
  "row-gap": "6px",
  "column-gap": "6px",
  "background-color": "rgb(37, 99, 235)",
  color: "rgb(255, 255, 255)",
  opacity: "1",
  "border-top-width": "0px", "border-right-width": "0px",
  "border-bottom-width": "0px", "border-left-width": "0px",
  "border-top-style": "solid", "border-right-style": "solid",
  "border-bottom-style": "solid", "border-left-style": "solid",
  "border-top-color": "rgba(0, 0, 0, 0)", "border-right-color": "rgba(0, 0, 0, 0)",
  "border-bottom-color": "rgba(0, 0, 0, 0)", "border-left-color": "rgba(0, 0, 0, 0)",
  "border-top-left-radius": "3px", "border-top-right-radius": "3px",
  "border-bottom-right-radius": "3px", "border-bottom-left-radius": "3px",
  "padding-top": "4px", "padding-right": "8px", "padding-bottom": "4px", "padding-left": "8px",
  "font-family": "Helvetica, Arial, sans-serif",
  "font-size": "12px", "font-weight": "600",
  "line-height": "normal", "letter-spacing": "normal",
  "box-shadow": "none",
};

function withOverrides(overrides: RawComputedStyles): RawComputedStyles {
  return { ...PRIMARY_SM, ...overrides };
}

const BOX = { width: 61.5, height: 24 };

// --- pxToNumber / colors / fonts --------------------------------------------

test("pxToNumber: parses lengths and rejects non-lengths", () => {
  assert.equal(pxToNumber("14px"), 14);
  assert.equal(pxToNumber("12.5px"), 12.5);
  assert.equal(pxToNumber("-2px"), -2);
  assert.equal(pxToNumber("0px"), 0);
  assert.equal(pxToNumber("normal"), null);
  assert.equal(pxToNumber("1rem"), null);
  assert.equal(pxToNumber(undefined), null);
});

test("normalizeColor: converts computed rgb() to hex", () => {
  assert.equal(normalizeColor("rgb(37, 99, 235)"), "#2563eb");
  assert.equal(normalizeColor("rgb(220, 38, 38)"), "#dc2626");
  assert.equal(normalizeColor("rgb(255, 255, 255)"), "#ffffff");
});

test("normalizeColor: fully transparent is absent, not black", () => {
  // getComputedStyle reports an unset background as rgba(0, 0, 0, 0).
  assert.equal(normalizeColor("rgba(0, 0, 0, 0)"), null);
  assert.equal(normalizeColor("transparent"), null);
  assert.equal(normalizeColor("none"), null);
  assert.equal(normalizeColor(""), null);
  assert.equal(normalizeColor(undefined), null);
});

test("normalizeColor: partial alpha is preserved", () => {
  assert.equal(normalizeColor("rgba(0, 0, 0, 0.5)"), "#00000080");
});

test("firstFontFamily: takes the first family and strips quotes", () => {
  assert.equal(firstFontFamily("Helvetica, Arial, sans-serif"), "Helvetica");
  assert.equal(firstFontFamily('"Inter var", sans-serif'), "Inter var");
  assert.equal(firstFontFamily(undefined), "");
});

// --- Borders ----------------------------------------------------------------

test("parseBorderSide: zero width or style none draws nothing", () => {
  assert.equal(parseBorderSide("0px", "solid", "rgb(0, 0, 0)"), null);
  assert.equal(parseBorderSide("2px", "none", "rgb(0, 0, 0)"), null);
  assert.equal(parseBorderSide("2px", "hidden", "rgb(0, 0, 0)"), null);
});

test("parseBorderSide: reads a drawn side", () => {
  assert.deepEqual(parseBorderSide("2px", "solid", "rgb(156, 163, 175)"), {
    width: 2, style: "solid", color: "#9ca3af",
  });
});

test("normalizeStyles: no drawn border yields null border", () => {
  const s = normalizeStyles(PRIMARY_SM, BOX);
  assert.equal(s.border, null);
  assert.equal(s.borderUniform, null);
});

test("normalizeStyles: uniform border is collapsed for Figma strokes", () => {
  const s = normalizeStyles(withOverrides({
    "border-top-width": "2px", "border-right-width": "2px",
    "border-bottom-width": "2px", "border-left-width": "2px",
    "border-top-color": "rgb(156, 163, 175)", "border-right-color": "rgb(156, 163, 175)",
    "border-bottom-color": "rgb(156, 163, 175)", "border-left-color": "rgb(156, 163, 175)",
  }), BOX);
  assert.deepEqual(s.borderUniform, { width: 2, style: "solid", color: "#9ca3af" });
});

test("normalizeStyles: a mismatched side prevents collapsing", () => {
  const s = normalizeStyles(withOverrides({
    "border-top-width": "2px", "border-right-width": "4px",
    "border-bottom-width": "2px", "border-left-width": "2px",
  }), BOX);
  assert.equal(s.borderUniform, null);
  assert.ok(s.border);
  assert.equal(s.border!.right!.width, 4);
});

// --- Radius, padding, layout ------------------------------------------------

test("normalizeStyles: equal corners collapse to a uniform radius", () => {
  const s = normalizeStyles(PRIMARY_SM, BOX);
  assert.equal(s.borderRadiusUniform, 3);
  assert.deepEqual(s.borderRadius, { topLeft: 3, topRight: 3, bottomRight: 3, bottomLeft: 3 });
});

test("normalizeStyles: mixed corners keep per-corner values", () => {
  const s = normalizeStyles(withOverrides({ "border-top-left-radius": "9px" }), BOX);
  assert.equal(s.borderRadiusUniform, null);
  assert.equal(s.borderRadius.topLeft, 9);
  assert.equal(s.borderRadius.topRight, 3);
});

test("normalizeStyles: reads padding, size, and layout", () => {
  const s = normalizeStyles(PRIMARY_SM, BOX);
  assert.deepEqual(s.padding, { top: 4, right: 8, bottom: 4, left: 8 });
  assert.equal(s.width, 61.5);
  assert.equal(s.height, 24);
  assert.equal(s.display, "inline-flex");
  assert.equal(s.flexDirection, "row");
  assert.deepEqual(s.gap, { row: 6, column: 6 });
});

test("normalizeStyles: flex-only properties are omitted for block elements", () => {
  const s = normalizeStyles(withOverrides({ display: "block" }), BOX);
  assert.equal(s.flexDirection, null);
  assert.equal(s.alignItems, null);
  assert.equal(s.justifyContent, null);
});

test("normalizeStyles: typography normalizes keywords to numbers", () => {
  const s = normalizeStyles(PRIMARY_SM, BOX);
  assert.equal(s.fontSize, 12);
  assert.equal(s.fontWeight, 600);
  assert.equal(s.fontFamily, "Helvetica");
  assert.equal(s.lineHeight, "normal");
  assert.equal(s.letterSpacing, 0);

  const named = normalizeStyles(withOverrides({
    "font-weight": "bold", "line-height": "18px", "letter-spacing": "0.5px",
  }), BOX);
  assert.equal(named.fontWeight, 700);
  assert.equal(named.lineHeight, 18);
  assert.equal(named.letterSpacing, 0.5);
});

test("normalizeStyles: captures text-descendant styles when provided", () => {
  const s = normalizeStyles(PRIMARY_SM, BOX, {
    color: "rgb(17, 24, 39)", "font-family": "Inter, sans-serif",
    "font-size": "18px", "font-weight": "500",
  });
  assert.deepEqual(s.text, { color: "#111827", fontFamily: "Inter", fontSize: 18, fontWeight: 500 });
  assert.equal(normalizeStyles(PRIMARY_SM, BOX).text, null);
});

// --- Box shadow -------------------------------------------------------------

test("splitTopLevel: ignores commas inside parentheses", () => {
  assert.deepEqual(
    splitTopLevel("rgba(0, 0, 0, 0.1) 0px 1px 2px, rgb(0, 0, 0) 0px 4px 8px"),
    ["rgba(0, 0, 0, 0.1) 0px 1px 2px", "rgb(0, 0, 0) 0px 4px 8px"],
  );
});

test("parseBoxShadow: none yields no layers", () => {
  assert.deepEqual(parseBoxShadow("none"), []);
  assert.deepEqual(parseBoxShadow(""), []);
  assert.deepEqual(parseBoxShadow(undefined), []);
});

test("parseBoxShadow: parses a single computed layer", () => {
  assert.deepEqual(parseBoxShadow("rgba(0, 0, 0, 0.1) 0px 1px 2px 0px"), [
    { offsetX: 0, offsetY: 1, blur: 2, spread: 0, color: "#0000001a", inset: false },
  ]);
});

test("parseBoxShadow: parses multiple layers despite rgba commas", () => {
  const layers = parseBoxShadow("rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.06) 0px 1px 2px 0px");
  assert.equal(layers.length, 2);
  assert.equal(layers[0].blur, 3);
  assert.equal(layers[1].blur, 2);
});

test("parseBoxShadow: detects inset", () => {
  const [layer] = parseBoxShadow("rgba(0, 0, 0, 0.5) 0px 2px 4px 0px inset");
  assert.equal(layer.inset, true);
  assert.equal(layer.offsetY, 2);
});

test("parseBoxShadow: handles negative offsets and hex colors", () => {
  const [layer] = parseBoxShadow("#ff0000 -2px -4px 6px 1px");
  assert.deepEqual(layer, { offsetX: -2, offsetY: -4, blur: 6, spread: 1, color: "#ff0000", inset: false });
});

// --- Storybook args encoding ------------------------------------------------

const VARIANT: FigmaVariantProperty = { name: "variant", type: "VARIANT", values: ["primary", "danger"], defaultValue: "primary" };
const SIZE: FigmaVariantProperty = { name: "size", type: "VARIANT", values: ["sm", "lg"], defaultValue: "sm" };
const DISABLED: FigmaVariantProperty = { name: "disabled", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" };

test("isEncodableArgValue: mirrors Storybook's charset", () => {
  // /^[a-zA-Z0-9 _-]*$/ — spaces, underscores and hyphens are allowed.
  assert.equal(isEncodableArgValue("danger"), true);
  assert.equal(isEncodableArgValue("Data Display"), true);
  assert.equal(isEncodableArgValue("nav_primary"), true);
  assert.equal(isEncodableArgValue("nav-primary"), true);
  // Anything else Storybook discards silently.
  assert.equal(isEncodableArgValue("Nav/Primary"), false);
  assert.equal(isEncodableArgValue("size:lg"), false);
  assert.equal(isEncodableArgValue("a;b"), false);
  assert.equal(isEncodableArgValue("2.5"), false);
});

test("encodeStoryArgs: encodes variants and booleans", () => {
  const { param, unsupported } = encodeStoryArgs(
    { variant: "danger", size: "lg", disabled: "true" },
    [VARIANT, SIZE, DISABLED],
  );
  assert.equal(param, "variant:danger;size:lg;disabled:!true");
  assert.deepEqual(unsupported, []);
});

test("encodeStoryArgs: false booleans use the !false marker", () => {
  const { param } = encodeStoryArgs({ disabled: "false" }, [DISABLED]);
  assert.equal(param, "disabled:!false");
});

test("encodeStoryArgs: values with spaces are encodable", () => {
  const tone: FigmaVariantProperty = {
    name: "tone", type: "VARIANT", values: ["plain", "Data Display"], defaultValue: "plain",
  };
  const { param, unsupported } = encodeStoryArgs({ tone: "Data Display" }, [tone]);
  assert.equal(param, "tone:Data Display");
  assert.deepEqual(unsupported, []);
});

// Storybook drops out-of-charset values without a word, then renders the story
// with its defaults — so these must be reported, never measured.
test("encodeStoryArgs: reports values Storybook would silently drop", () => {
  const tone: FigmaVariantProperty = {
    name: "tone", type: "VARIANT", values: ["plain", "Nav/Primary"], defaultValue: "plain",
  };
  const { param, unsupported } = encodeStoryArgs({ tone: "Nav/Primary" }, [tone]);
  assert.equal(param, null);
  assert.deepEqual(unsupported, ["tone=Nav/Primary"]);
});

test("encodeStoryArgs: keeps encodable pairs and reports only the bad one", () => {
  const tone: FigmaVariantProperty = {
    name: "tone", type: "VARIANT", values: ["Nav/Primary"], defaultValue: "Nav/Primary",
  };
  const { param, unsupported } = encodeStoryArgs(
    { variant: "danger", tone: "Nav/Primary" },
    [VARIANT, tone],
  );
  assert.equal(param, "variant:danger");
  assert.deepEqual(unsupported, ["tone=Nav/Primary"]);
});

test("encodeStoryArgs: an empty combination encodes to nothing", () => {
  assert.deepEqual(encodeStoryArgs({}, []), { param: null, unsupported: [] });
});

test("buildStoryUrl: builds an iframe URL and encodes the query", () => {
  assert.equal(
    buildStoryUrl("http://localhost:6006", "forms-button--default", "variant:danger"),
    "http://localhost:6006/iframe.html?id=forms-button--default&viewMode=story&args=variant%3Adanger",
  );
});

test("buildStoryUrl: spaces become +, which Storybook accepts", () => {
  const url = buildStoryUrl("http://localhost:6006", "forms-label--default", "tone:Data Display");
  assert.match(url, /args=tone%3AData\+Display$/);
});

test("buildStoryUrl: trailing slashes on the base are ignored", () => {
  assert.equal(
    buildStoryUrl("http://localhost:6006/", "x--default", null),
    "http://localhost:6006/iframe.html?id=x--default&viewMode=story",
  );
});

// --- Naming -----------------------------------------------------------------

test("slugifyCombination: stable, filesystem-safe names", () => {
  assert.equal(slugifyCombination({ variant: "default", size: "sm" }), "variant-default--size-sm");
  assert.equal(slugifyCombination({ tone: "Data Display" }), "tone-data-display");
  assert.equal(slugifyCombination({}), "default");
});

test("componentSlug: flattens titles into a single segment", () => {
  assert.equal(componentSlug("Button", "Forms/Button"), "forms-button");
  assert.equal(componentSlug("Button"), "button");
  assert.equal(componentSlug("!!!"), "component");
});

// --- Base + delta -----------------------------------------------------------

test("diffFromBase: identical styles produce an empty delta", () => {
  const base = normalizeStyles(PRIMARY_SM, BOX);
  assert.deepEqual(diffFromBase(base, normalizeStyles(PRIMARY_SM, BOX)), {});
});

test("diffFromBase: records only the properties that changed", () => {
  const base = normalizeStyles(PRIMARY_SM, BOX);
  const variant = normalizeStyles(withOverrides({ "background-color": "rgb(220, 38, 38)" }), BOX);
  assert.deepEqual(diffFromBase(base, variant), { backgroundColor: "#dc2626" });
});

test("diffFromBase: detects nested and array changes", () => {
  const base = normalizeStyles(PRIMARY_SM, BOX);
  const variant = normalizeStyles(withOverrides({
    "padding-top": "12px", "padding-left": "24px",
    "box-shadow": "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px",
  }), BOX);
  const delta = diffFromBase(base, variant);
  assert.deepEqual(Object.keys(delta).sort(), ["boxShadow", "padding"]);
  assert.deepEqual(delta.padding, { top: 12, right: 8, bottom: 4, left: 24 });
});

test("applyDelta: round-trips back to the original variant", () => {
  const base = normalizeStyles(PRIMARY_SM, BOX);
  const variant = normalizeStyles(withOverrides({
    "background-color": "rgb(220, 38, 38)", "font-size": "18px",
  }), { width: 90, height: 44 });
  assert.deepEqual(applyDelta(base, diffFromBase(base, variant)), variant);
});
