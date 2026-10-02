import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStyles,
  normalizeColor,
  pxToNumber,
  firstFontFamily,
  parseBorderSide,
  parseBoxShadow,
  isFullyTransparent,
  isPassThroughWrapper,
  splitTopLevel,
  encodeStoryArgs,
  buildStoryUrl,
  isEncodableArgValue,
  slugifyCombination,
  assignVariantSlugs,
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

test("pxToNumber: reads the exponent form Chromium writes a huge length in", () => {
  // Tailwind v4's rounded-full, calc(infinity * 1px), computes to this.
  assert.equal(pxToNumber("3.35544e+07px"), 33554400);
  assert.equal(pxToNumber("1E2px"), 100);
  assert.equal(pxToNumber(".5px"), 0.5);
  assert.equal(pxToNumber("1e2"), null);
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

test("normalizeColor: reads Chromium's CSS Color 4 serialisations rather than recording no fill", () => {
  // Chromium reports a computed colour in its authored space. Each of these
  // used to come back null, which snap records as nothing drawn: Tailwind v4's
  // red-500 button measured as unfilled.
  assert.equal(normalizeColor("oklch(0.637 0.237 25.331)"), "#fb2c36");
  // bg-red-500/50, a color-mix in oklab.
  assert.equal(normalizeColor("oklab(0.637 0.214213 0.1014 / 0.5)"), "#fb2c3680");
  // A color-mix in sRGB.
  assert.equal(normalizeColor("color(srgb 1 0 0 / 0.5)"), "#ff000080");
  assert.equal(normalizeColor("lab(50 40 59.5)"), "#bf5700");
  assert.equal(normalizeColor("lch(50 72 56)"), "#bf5700");
  assert.equal(normalizeColor("color(display-p3 1 0 0)"), "#ff0000");
});

test("normalizeColor: a CSS Color 4 colour with zero alpha is still absent", () => {
  // color-mix(in oklab, red 0%, transparent) computes to this.
  assert.equal(normalizeColor("oklab(0 0 0 / 0)"), null);
  assert.equal(normalizeColor("oklch(0.5 0.1 30 / none)"), null);
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

/** Every corner set to one computed radius. */
function radii(value: string): RawComputedStyles {
  return withOverrides(Object.fromEntries(
    ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => [`border-${c}-radius`, value]),
  ));
}

test("normalizeStyles: a radius too big for the box is recorded as the one the browser draws", () => {
  // Tailwind v4's rounded-full, as Chromium computes it, on a 32px-tall pill
  // and an 8px dot. Read as no radius, it scored a square Figma frame a match.
  assert.equal(normalizeStyles(radii("3.35544e+07px"), { width: 55.92, height: 32 }).borderRadiusUniform, 16);
  assert.equal(normalizeStyles(radii("3.35544e+07px"), { width: 8, height: 8 }).borderRadiusUniform, 4);
  // Tailwind v3's rounded-full draws the same pill.
  assert.equal(normalizeStyles(radii("9999px"), { width: 42.67, height: 32 }).borderRadiusUniform, 16);
});

test("normalizeStyles: overlapping corners all scale by one factor, as CSS scales them", () => {
  const s = normalizeStyles(withOverrides({
    "border-top-left-radius": "30px", "border-top-right-radius": "10px",
    "border-bottom-right-radius": "0px", "border-bottom-left-radius": "4px",
  }), { width: 20, height: 100 });
  // The top side needs 40px of its 20, so every corner is halved.
  assert.deepEqual(s.borderRadius, { topLeft: 15, topRight: 5, bottomRight: 0, bottomLeft: 2 });
});

test("normalizeStyles: a percentage radius resolves against the border box", () => {
  // Chromium keeps percentages as written.
  assert.equal(normalizeStyles(radii("50%"), { width: 8, height: 8 }).borderRadiusUniform, 4);
  assert.equal(normalizeStyles(radii("100%"), { width: 32, height: 32 }).borderRadiusUniform, 16);
  // Horizontal of the width, vertical of the height: 10px by 5px, kept as 5.
  assert.equal(normalizeStyles(radii("25%"), { width: 40, height: 20 }).borderRadiusUniform, 5);
});

test("normalizeStyles: an elliptical corner keeps its smaller radius, since Figma has none", () => {
  // border-radius: 10px / 20px computes to two values per corner.
  assert.equal(normalizeStyles(radii("10px 20px"), { width: 64, height: 48 }).borderRadiusUniform, 10);
  // 50% of a box that isn't square is an ellipse; the nearest Figma corner is a pill.
  assert.equal(normalizeStyles(radii("50%"), { width: 60, height: 32 }).borderRadiusUniform, 16);
});

test("normalizeStyles: a calc() radius reads as the browser side resolved it", () => {
  // snap-browser sizes calc(50% - 2px) on a 32px box to this.
  assert.equal(normalizeStyles(radii("14px 14px"), { width: 32, height: 32 }).borderRadiusUniform, 14);
  // Unresolved, it can't be read without layout, and reads as square.
  assert.equal(normalizeStyles(radii("calc(50% - 2px)"), { width: 32, height: 32 }).borderRadiusUniform, 0);
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
  assert.deepEqual(s.text, {
    color: "#111827", fontFamily: "Inter", fontSize: 18, fontWeight: 500, textTransform: "none", letterSpacing: 0,
  });
  assert.equal(normalizeStyles(PRIMARY_SM, BOX).text, null);
});

const LABEL: RawComputedStyles = {
  color: "rgb(255, 255, 255)", "font-family": "Inter, sans-serif", "font-size": "12px", "font-weight": "600",
  "text-transform": "none", "letter-spacing": "normal", opacity: "1",
};

test("normalizeStyles: records the text's transform, which the label's width depends on", () => {
  // An uppercase badge draws BETA from args of Beta, about 6px wider at 12px.
  const s = normalizeStyles(PRIMARY_SM, BOX, { ...LABEL, "text-transform": "uppercase" });
  assert.equal(s.text?.textTransform, "uppercase");
  assert.equal(normalizeStyles(PRIMARY_SM, BOX, LABEL).text?.textTransform, "none");
});

test("normalizeStyles: records the text holder's own letter-spacing, not only the root's", () => {
  // <button><span style="letter-spacing: 0.05em">, at 13.33px.
  const s = normalizeStyles(PRIMARY_SM, BOX, { ...LABEL, "font-size": "13.3333px", "letter-spacing": "0.666667px" });
  assert.equal(s.letterSpacing, 0);
  assert.equal(s.text?.letterSpacing, 0.67);
});

test("normalizeStyles: a percentage letter-spacing is a share of the font size", () => {
  // Chromium keeps letter-spacing: 10% as written; on a 20px font it draws 2px.
  const root = normalizeStyles(withOverrides({ "font-size": "20px", "letter-spacing": "10%" }), BOX);
  assert.equal(root.letterSpacing, 2);
  const text = normalizeStyles(PRIMARY_SM, BOX, { ...LABEL, "font-size": "20px", "letter-spacing": "-5%" });
  assert.equal(text.text?.letterSpacing, -1);
});

test("normalizeStyles: an opacity between the root and its text is folded into the text colour", () => {
  // <button style="color: #fff"><span style="opacity: 0.6">Draft</span></button>:
  // drawn at 60%, so verify can tell it from an opaque white label.
  assert.equal(normalizeStyles(PRIMARY_SM, BOX, { ...LABEL, opacity: "0.6" }).text?.color, "#ffffff99");
  // A translucent colour's alpha is multiplied, not replaced.
  assert.equal(normalizeStyles(PRIMARY_SM, BOX, { ...LABEL, color: "rgba(255, 255, 255, 0.5)", opacity: "0.5" }).text?.color, "#ffffff40");
  // Opaque stays #rrggbb, and nothing left is no colour at all.
  assert.equal(normalizeStyles(PRIMARY_SM, BOX, LABEL).text?.color, "#ffffff");
  assert.equal(normalizeStyles(PRIMARY_SM, BOX, { ...LABEL, opacity: "0" }).text?.color, null);
  // The root's own opacity stays the frame's, out of the text colour.
  const faded = normalizeStyles(withOverrides({ opacity: "0.4" }), BOX, LABEL);
  assert.equal(faded.opacity, 0.4);
  assert.equal(faded.text?.color, "#ffffff");
});

// --- Background image -------------------------------------------------------

test("normalizeStyles: a gradient fill is recorded, though its backgroundColor is null", () => {
  // background: linear-gradient(90deg, #2563eb, #7c3aed), as Chromium computes it.
  const s = normalizeStyles(withOverrides({
    "background-color": "rgba(0, 0, 0, 0)",
    "background-image": "linear-gradient(90deg, rgb(37, 99, 235), rgb(124, 58, 237))",
  }), BOX);
  assert.equal(s.backgroundColor, null);
  assert.equal(s.backgroundImage, "linear-gradient(90deg, #2563eb, #7c3aed)");
});

test("normalizeStyles: a gradient's colours are written as hex, in whatever space Chromium gives them", () => {
  // Tailwind v4's bg-linear-to-r from-blue-600 to-violet-600.
  const tailwind = normalizeStyles(withOverrides({
    "background-image": "linear-gradient(to right, oklch(0.546 0.245 262.881) 0%, oklch(0.541 0.281 293.009) 100%)",
  }), BOX);
  assert.equal(tailwind.backgroundImage, "linear-gradient(to right, #155dfc 0%, #7f22fe 100%)");
  const radial = normalizeStyles(withOverrides({
    "background-image": "radial-gradient(circle, color(display-p3 1 0 0 / 0.5), rgba(0, 0, 0, 0))",
  }), BOX);
  assert.equal(radial.backgroundImage, "radial-gradient(circle, #ff000080, #00000000)");
});

test("normalizeStyles: an image layered over a fill keeps both, and a url() as written", () => {
  const s = normalizeStyles(withOverrides({
    "background-image": 'url("http://localhost:6006/rgb(1).png"), linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0))',
  }), BOX);
  // The fill is still measured: it is the layer beneath.
  assert.equal(s.backgroundColor, "#2563eb");
  assert.equal(s.backgroundImage, 'url("http://localhost:6006/rgb(1).png"), linear-gradient(#00000000, #000000)');
});

test("normalizeStyles: no background image is null", () => {
  assert.equal(normalizeStyles(withOverrides({ "background-image": "none" }), BOX).backgroundImage, null);
  assert.equal(normalizeStyles(PRIMARY_SM, BOX).backgroundImage, null);
});

test("diffFromBase: a gradient variant of a solid button differs from it", () => {
  // Both used to measure the same backgroundColor, so the variant's delta was
  // empty and Figma built it as the solid fill it covers.
  const base = normalizeStyles(PRIMARY_SM, BOX);
  const layered = normalizeStyles(withOverrides({
    "background-image": "linear-gradient(90deg, rgb(249, 115, 22), rgb(219, 39, 119))",
  }), BOX);
  assert.deepEqual(diffFromBase(base, layered), { backgroundImage: "linear-gradient(90deg, #f97316, #db2777)" });
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

test("parseBoxShadow: reads a colour Chromium writes in oklch, oklab or color()", () => {
  // Chromium's computed box-shadow for a ring and an inset layer in Tailwind v4's red-500.
  assert.deepEqual(
    parseBoxShadow("oklch(0.637 0.237 25.331) 0px 1px 2px 3px, oklch(0.637 0.237 25.331 / 0.5) 1px 1px 0px 0px inset"),
    [
      { offsetX: 0, offsetY: 1, blur: 2, spread: 3, color: "#fb2c36", inset: false },
      { offsetX: 1, offsetY: 1, blur: 0, spread: 0, color: "#fb2c3680", inset: true },
    ],
  );
  const [mixed, srgb] = parseBoxShadow("oklab(0.637 0.214213 0.1014 / 0.5) 0px 4px 6px -1px, color(srgb 0 0 0 / 0.1) 0px 2px 4px -2px");
  assert.deepEqual(mixed, { offsetX: 0, offsetY: 4, blur: 6, spread: -1, color: "#fb2c3680", inset: false });
  assert.deepEqual(srgb, { offsetX: 0, offsetY: 2, blur: 4, spread: -2, color: "#0000001a", inset: false });
});

test("parseBoxShadow: drops the 0 0 #0000 layers Tailwind fills its unused slots with", () => {
  // Chromium's computed box-shadow for Tailwind v4's shadow-sm: four empty
  // slots (ring, inset ring, ring offset, inset shadow), then its two layers.
  const empty = "rgba(0, 0, 0, 0) 0px 0px 0px 0px";
  assert.deepEqual(
    parseBoxShadow(`${empty}, ${empty}, ${empty}, ${empty}, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px`),
    [
      { offsetX: 0, offsetY: 1, blur: 3, spread: 0, color: "#0000001a", inset: false },
      { offsetX: 0, offsetY: 1, blur: 2, spread: -1, color: "#0000001a", inset: false },
    ],
  );
  // v4's ring-1 ring-inset keeps only the ring.
  assert.deepEqual(
    parseBoxShadow(`oklch(0.872 0.01 258.338) 0px 0px 0px 1px inset, ${empty}, ${empty}, ${empty}, ${empty}`),
    [{ offsetX: 0, offsetY: 0, blur: 0, spread: 1, color: "#d1d5dc", inset: true }],
  );
});

test("parseBoxShadow: a layer with no offset, blur or spread draws nothing, whatever its colour", () => {
  // v3's ring-1: a white ring-offset layer of zero size, the ring, an empty slot.
  assert.deepEqual(
    parseBoxShadow("rgb(255, 255, 255) 0px 0px 0px 0px, rgb(59, 130, 246) 0px 0px 0px 1px, rgba(0, 0, 0, 0) 0px 0px 0px 0px"),
    [{ offsetX: 0, offsetY: 0, blur: 0, spread: 1, color: "#3b82f6", inset: false }],
  );
  assert.deepEqual(parseBoxShadow("rgb(255, 255, 255) 0px 0px 0px 0px inset"), []);
  // A fully transparent layer draws nothing however big, in any colour space.
  assert.deepEqual(parseBoxShadow("oklab(0 0 0 / 0) 0px 4px 6px -1px"), []);
  assert.deepEqual(parseBoxShadow("transparent 0px 4px 6px 0px"), []);
});

test("isFullyTransparent: zero alpha in any form, and nothing it can't read", () => {
  for (const c of ["rgba(0, 0, 0, 0)", "transparent", "oklab(0 0 0 / 0)", "color(srgb 1 0 0 / 0)", "#0000"]) {
    assert.equal(isFullyTransparent(c), true, c);
  }
  for (const c of ["rgb(0, 0, 0)", "rgba(0, 0, 0, 0.1)", "oklch(0.5 0.1 30)", "", undefined, "var(--x)"]) {
    assert.equal(isFullyTransparent(c), false, String(c));
  }
});

test("normalizeStyles: a Tailwind v4 component's colours, as Chromium computes them, all reach hex", () => {
  const sides = ["top", "right", "bottom", "left"];
  const raw = withOverrides({
    "background-color": "oklch(0.637 0.237 25.331)",
    color: "oklch(0.985 0 0)",
    ...Object.fromEntries(sides.flatMap((s) => [
      [`border-${s}-width`, "1px"], [`border-${s}-style`, "solid"], [`border-${s}-color`, "color(display-p3 0.5 0.4 0.3)"],
    ])),
    "box-shadow": "oklab(0 0 0 / 0.1) 0px 1px 3px 0px",
  });
  const styles = normalizeStyles(raw, BOX, { ...raw, color: "lab(50 40 59.5)" });
  assert.equal(styles.backgroundColor, "#fb2c36");
  assert.equal(styles.color, "#fafafa");
  assert.deepEqual(styles.borderUniform, { width: 1, style: "solid", color: "#846549" });
  assert.equal(styles.boxShadow[0].color, "#0000001a");
  assert.equal(styles.text?.color, "#bf5700");
});

// --- Wrappers ---------------------------------------------------------------

/** A block wrapper that draws nothing, as Chromium computes one. */
const WRAPPER: RawComputedStyles = {
  display: "block",
  "background-color": "rgba(0, 0, 0, 0)",
  "background-image": "none",
  "box-shadow": "none",
  ...Object.fromEntries(["top", "right", "bottom", "left"].flatMap((s) => [[`border-${s}-width`, "0px"], [`padding-${s}`, "0px"]])),
};

test("isPassThroughWrapper: a block or contents wrapper that draws nothing is looked past", () => {
  assert.equal(isPassThroughWrapper(WRAPPER), true);
  assert.equal(isPassThroughWrapper({ ...WRAPPER, display: "contents" }), true);
  assert.equal(isPassThroughWrapper({ ...WRAPPER, "background-color": "transparent" }), true);
});

test("isPassThroughWrapper: a transparent background in any colour space is transparent", () => {
  // Tailwind v4's bg-black/0, a color-mix in oklab, computes to this. Read as
  // a fill, it stopped the descent and snap measured the full-width wrapper.
  assert.equal(isPassThroughWrapper({ ...WRAPPER, "background-color": "oklab(0 0 0 / 0)" }), true);
  assert.equal(isPassThroughWrapper({ ...WRAPPER, "background-color": "color(srgb 1 0 0 / 0)" }), true);
  // Tailwind's empty shadow slots draw nothing either.
  assert.equal(isPassThroughWrapper({ ...WRAPPER, "box-shadow": "rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px" }), true);
});

test("isPassThroughWrapper: a wrapper that draws anything is the component", () => {
  for (const [property, value] of [
    ["background-color", "oklch(0.637 0.237 25.331)"],
    ["background-color", "oklab(0 0 0 / 0.05)"],
    // A colour it can't read is not taken for transparent.
    ["background-color", "device-cmyk(0 0 0 1)"],
    ["background-image", "linear-gradient(90deg, rgb(37, 99, 235), rgb(124, 58, 237))"],
    ["box-shadow", "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px"],
    ["border-top-width", "1px"],
    ["padding-left", "8px"],
    ["display", "flex"],
  ]) {
    assert.equal(isPassThroughWrapper({ ...WRAPPER, [property]: value }), false, `${property}: ${value}`);
  }
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

test("assignVariantSlugs: distinct combinations keep their natural names", () => {
  const { slugs, collisions } = assignVariantSlugs([
    { variant: "primary" },
    { variant: "secondary" },
  ]);
  assert.deepEqual(slugs, ["variant-primary", "variant-secondary"]);
  assert.deepEqual(collisions, []);
});

test("assignVariantSlugs: values differing only by case stay distinct", () => {
  // Storybook treats these as two values, but slugifying lowercases both.
  const { slugs, collisions } = assignVariantSlugs([{ size: "Small" }, { size: "small" }]);

  assert.deepEqual(slugs, ["size-small", "size-small--2"]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0], {
    base: "size-small",
    slug: "size-small--2",
    combination: { size: "small" },
  });
});

test("assignVariantSlugs: values differing only by punctuation stay distinct", () => {
  const { slugs } = assignVariantSlugs([{ size: "x-large" }, { size: "x large" }]);
  assert.deepEqual(slugs, ["size-x-large", "size-x-large--2"]);
});

test("assignVariantSlugs: three-way collisions keep counting", () => {
  const { slugs, collisions } = assignVariantSlugs([
    { tone: "Warning" },
    { tone: "warning" },
    { tone: "WARNING" },
  ]);
  assert.deepEqual(slugs, ["tone-warning", "tone-warning--2", "tone-warning--3"]);
  assert.equal(collisions.length, 2);
});

test("assignVariantSlugs: every slug is distinct, whatever the input", () => {
  // The invariant the rest of the pipeline relies on, over input chosen to be
  // awkward: empty keys and values, punctuation that collapses to nothing, and
  // several spellings of one word.
  const { slugs } = assignVariantSlugs([
    { size: "Small" },
    { size: "small" },
    { size: "SMALL" },
    { size: "s m a l l" },
    { size: "small", extra: "" },
    { "": "" },
    {},
    {},
  ]);
  assert.equal(new Set(slugs).size, slugs.length, `expected distinct slugs, got ${slugs.join(", ")}`);
});

test("assignVariantSlugs: assignment is stable across runs", () => {
  const combos = [{ size: "Small" }, { size: "small" }, { size: "SMALL" }];
  assert.deepEqual(assignVariantSlugs(combos).slugs, assignVariantSlugs(combos).slugs);
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

// --- box-sizing and font availability ---

test("normalizeStyles: records box-sizing, defaulting to content-box", () => {
  assert.equal(normalizeStyles(PRIMARY_SM, BOX).boxSizing, "content-box");
  assert.equal(normalizeStyles(withOverrides({ "box-sizing": "border-box" }), BOX).boxSizing, "border-box");
  const { "box-sizing": _omitted, ...without } = withOverrides({});
  assert.equal(normalizeStyles(without, BOX).boxSizing, "content-box");
});

// The measured fontFamily is the *declared* first family, so a project naming a
// font it never loaded measures identically to one that did. Availability is
// what keeps that visible.
test("normalizeStyles: carries font availability through, defaulting to unknown", () => {
  assert.equal(normalizeStyles(PRIMARY_SM, BOX).fontAvailable, null);
  assert.equal(normalizeStyles(PRIMARY_SM, BOX, null, true).fontAvailable, true);
  assert.equal(normalizeStyles(PRIMARY_SM, BOX, null, false).fontAvailable, false);
});

test("diffFromBase: a font that stopped resolving shows up as a delta", () => {
  const base = normalizeStyles(PRIMARY_SM, BOX, null, true);
  const variant = normalizeStyles(PRIMARY_SM, BOX, null, false);
  assert.deepEqual(diffFromBase(base, variant), { fontAvailable: false });
});
