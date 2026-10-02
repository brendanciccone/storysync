import { test } from "node:test";
import assert from "node:assert/strict";
import { colorToHex, formatHex } from "../color.js";

// Expected values are CSS Color 4's conversions, clipped to sRGB, and each
// was checked against the pixel Chromium paints for the same colour on an
// sRGB canvas, read back with getImageData; sRGB red is also round-tripped
// through Chromium's own serialisation of it in each space. The authored and
// computed forms are both tested because a token holds the first and
// getComputedStyle returns the second.

test("colorToHex: Tailwind v4's oklch palette converts to the sRGB hex Chromium paints for it", () => {
  // As written in Tailwind's theme.css, and as Chromium serialises it computed.
  for (const [authored, computed, hex] of [
    ["oklch(63.7% 0.237 25.331)", "oklch(0.637 0.237 25.331)", "#fb2c36"], // red-500
    ["oklch(62.3% 0.214 259.815)", "oklch(0.623 0.214 259.815)", "#2b7fff"], // blue-500
  ]) {
    assert.equal(colorToHex(authored), hex, authored);
    assert.equal(colorToHex(computed), hex, computed);
  }
});

test("colorToHex: an oklch colour outside sRGB is clipped, as Chromium's sRGB canvas is", () => {
  // red-600 converts to a negative green, green-500 to a negative red.
  assert.equal(colorToHex("oklch(57.7% 0.245 27.325)"), "#e7000b");
  assert.equal(colorToHex("oklch(72.3% 0.219 149.579)"), "#00c950");
});

test("colorToHex: a display-p3 colour outside sRGB is clipped to the nearest sRGB value", () => {
  // P3's red is about (1.093, -0.227, -0.150) in sRGB.
  assert.equal(colorToHex("color(display-p3 1 0 0)"), "#ff0000");
  assert.equal(colorToHex("color(display-p3 0 1 0)"), "#00ff00");
  // One inside sRGB converts rather than being read as sRGB.
  assert.equal(colorToHex("color(display-p3 0.5 0.4 0.3)"), "#846549");
});

test("colorToHex: white and black in every space", () => {
  const white = [
    "oklch(1 0 0)", "oklch(100% 0 0)", "oklab(1 0 0)", "lab(100 0 0)", "lch(100% 0 0)",
    "color(srgb 1 1 1)", "color(srgb-linear 1 1 1)", "color(display-p3 1 1 1)", "color(display-p3-linear 1 1 1)",
    "color(a98-rgb 1 1 1)", "color(prophoto-rgb 1 1 1)", "color(rec2020 1 1 1)",
    "color(xyz-d65 0.9504559270516716 1 1.0890577507598784)", "color(xyz-d50 0.9642956764295677 1 0.8251046025104602)",
    "hwb(0 100% 0%)",
  ];
  for (const c of white) assert.equal(colorToHex(c), "#ffffff", c);
  const black = [
    "oklch(0 0 0)", "oklab(0% 0 0)", "lab(0 0 0)", "lch(0 0 0)", "color(srgb 0 0 0)", "color(display-p3 0 0 0)",
    "color(rec2020 0 0 0)", "color(xyz 0 0 0)", "hwb(0 0% 100%)",
  ];
  for (const c of black) assert.equal(colorToHex(c), "#000000", c);
});

test("colorToHex: sRGB red, as Chromium writes it in each space, comes back as #ff0000", () => {
  // Each is Chromium's computed value for `<space>(from red ...)`.
  for (const c of [
    "lab(54.29 80.8198 69.8997)", "lch(54.29 106.854 40.856)",
    "oklab(0.627966 0.22488 0.125859)", "oklch(0.627966 0.257704 29.2346)",
    "color(display-p3 0.91753 0.200241 0.138502)", "color(xyz-d50 0.436066 0.222488 0.013916)",
    "color(srgb-linear 1 0 0)",
  ]) {
    assert.equal(colorToHex(c), "#ff0000", c);
  }
});

test("colorToHex: every color() space matches the pixel Chromium paints", () => {
  for (const [c, hex] of [
    ["lab(50 40 59.5)", "#bf5700"],
    ["lch(50 72 56)", "#bf5700"],
    ["oklab(0.6 0.1 -0.1)", "#9f63ba"],
    ["color(srgb 0.5 0.2 0.1)", "#80331a"],
    ["color(srgb-linear 0.2 0.5 0.1)", "#7cbc59"],
    ["color(a98-rgb 0.5 0.2 0.8)", "#9330d1"],
    ["color(prophoto-rgb 0.5 0.2 0.8)", "#9d01e3"],
    ["color(rec2020 0.5 0.2 0.8)", "#a02cdb"],
    ["color(xyz-d50 0.2 0.3 0.4)", "#00a8bd"],
    ["color(xyz-d65 0.2 0.3 0.4)", "#00a7a4"],
    ["color(xyz 0.2 0.3 0.4)", "#00a7a4"],
  ]) {
    assert.equal(colorToHex(c), hex, c);
  }
});

test("colorToHex: display-p3-linear is read as linear light, not gamma-encoded like display-p3", () => {
  // Chromium serialises color(from <this> srgb r g b) as color(srgb 0.778111 0.47012 0.932468).
  assert.equal(colorToHex("color(display-p3-linear 0.5 0.2 0.8)"), "#c678ee");
});

test("colorToHex: a very dark lab() takes CIE Lab's linear segment", () => {
  // L under 8 is below the cube's knee. Chromium: color(srgb 0.145944 0.00976897 0.121996).
  assert.equal(colorToHex("lab(5 20 -10)"), "#25021f");
  // With a and b small too, all three axes are linear; red and blue fall outside sRGB.
  assert.equal(colorToHex("lab(5 -20 10)"), "#001a00");
});

test("colorToHex: lightness past its range and negative chroma are clamped, as Chromium clamps them when parsing", () => {
  // Chromium computes each of the first to the second.
  const same = (a: string, b: string, hex: string) => {
    assert.equal(colorToHex(a), hex, a);
    assert.equal(colorToHex(b), hex, b);
  };
  same("lab(110 20 30)", "lab(100 20 30)", "#fff0c5");
  same("oklch(1.2 0.1 30)", "oklch(1 0.1 30)", "#ffe6d7");
  same("lch(50 -10 30)", "lch(50 0 30)", "#777777");
});

test("colorToHex: alpha as a number, a percentage or none, rounded as rgba() always was", () => {
  assert.equal(colorToHex("oklch(0.637 0.237 25.331 / 0.5)"), "#fb2c3680");
  assert.equal(colorToHex("oklch(63.7% 0.237 25.331 / 50%)"), "#fb2c3680");
  // Tailwind v4's bg-red-500/50 is color-mix(in oklab, red-500 50%, transparent),
  // which Chromium computes to this.
  assert.equal(colorToHex("oklab(0.637 0.214213 0.1014 / 0.5)"), "#fb2c3680");
  // A color-mix in sRGB, HSL or HWB computes to color(srgb ...).
  assert.equal(colorToHex("color(srgb 1 0 0 / 0.5)"), "#ff000080");
  assert.equal(colorToHex("lab(50 40 59.5 / 0.25)"), "#bf570040");
  // Opaque drops the alpha byte; none, a missing alpha, is transparent.
  assert.equal(colorToHex("oklch(0.637 0.237 25.331 / 1)"), "#fb2c36");
  assert.equal(colorToHex("oklch(0.5 0.1 30 / none)")?.slice(7), "00");
  assert.equal(colorToHex("oklch(0.5 0.1 30 / 0)")?.slice(7), "00");
});

test("colorToHex: a none component is zero", () => {
  assert.equal(colorToHex("oklch(0.7 none 120)"), colorToHex("oklch(0.7 0 0)"));
  assert.equal(colorToHex("color(display-p3 none 0.5 0.5)"), colorToHex("color(display-p3 0 0.5 0.5)"));
  assert.equal(colorToHex("lch(50 72 none)"), colorToHex("lch(50 72 0)"));
  assert.equal(colorToHex("rgb(none 20 30)"), "#00141e");
});

test("colorToHex: percentages scale to each channel's own reference range", () => {
  const same = (a: string, b: string) => assert.equal(colorToHex(a), colorToHex(b), `${a} vs ${b}`);
  same("oklch(63.7% 59.25% 25.331)", "oklch(0.637 0.237 25.331)"); // chroma 100% = 0.4
  same("oklab(60% 25% -25%)", "oklab(0.6 0.1 -0.1)"); // a and b 100% = 0.4
  same("lab(50% 32% 47.6%)", "lab(50 40 59.5)"); // L 100% = 100, a and b 100% = 125
  same("lch(50% 48% 56)", "lch(50 72 56)"); // chroma 100% = 150
  same("color(srgb 50% 20% 10%)", "color(srgb 0.5 0.2 0.1)");
});

test("colorToHex: hues in any angle unit, wrapped", () => {
  const hex = colorToHex("oklch(0.6 0.1 180)");
  for (const c of ["oklch(0.6 0.1 180deg)", "oklch(0.6 0.1 200grad)", `oklch(0.6 0.1 ${Math.PI}rad)`, "oklch(0.6 0.1 0.5turn)", "oklch(0.6 0.1 -180)", "oklch(0.6 0.1 540)"]) {
    assert.equal(colorToHex(c), hex, c);
  }
});

test("colorToHex: numbers in exponent form, as Chromium writes a tiny channel", () => {
  // Chromium's computed color-mix(in srgb-linear, red, blue).
  assert.equal(colorToHex("color(srgb-linear 0.5 -6.85395e-9 0.5)"), "#bc00bc");
});

test("colorToHex: hwb(), and modern rgb() and hsl(), as Chromium computes them", () => {
  // Chromium computes each of these to rgb(): hwb(120 20% 30%) is rgb(51, 179, 51).
  assert.equal(colorToHex("hwb(120 20% 30%)"), "#33b333");
  assert.equal(colorToHex("hwb(120 20% 30% / 0.5)"), "#33b33380");
  assert.equal(colorToHex("hwb(0 60% 60%)"), "#808080"); // whiteness and blackness past 100% are grey
  assert.equal(colorToHex("hsl(120 50 50)"), "#40bf40");
  assert.equal(colorToHex("hsl(0.5turn 50% 50%)"), "#40bfbf");
  assert.equal(colorToHex("rgb(10 20 30 / 40%)"), "#0a141e66");
});

test("colorToHex: case, quotes and a trailing semicolon are ignored, as for every other form", () => {
  assert.equal(colorToHex("  OKLCH(63.7% 0.237 25.331); "), "#fb2c36");
  assert.equal(colorToHex("'color(Display-P3 1 0 0)'"), "#ff0000");
});

test("colorToHex: what it can't convert is null, never a guess", () => {
  for (const c of [
    "color-mix(in oklab, red 50%, blue)", // computed values are always resolved mixes
    "oklch(var(--l) 0.1 30)",
    "color(rec2100-pq 0.5 0.5 0.5)",
    "color(--brand 1 0 0)",
    "oklch(0.5 0.1)",
    "oklch(0.5 0.1 30 40)",
    "oklch(0.5, 0.1, 30)",
    "color(srgb 1 0)",
    "lab(50 40 59.5 /)",
    "lab(50 40 59.5 / 1 / 1)",
    "oklch(abc 0.1 30)",
    "oklch(0.5deg 0.1 30)",
    "oklch(0.5 0.1 30px)",
    "oklch(0.5 0.1 30",
    "device-cmyk(0 0 0 1)",
    "constructor", // a key every object has, not a named colour
  ]) {
    assert.equal(colorToHex(c), null, c);
  }
});

test("formatHex: clips each channel and keeps alpha's rounding", () => {
  assert.equal(formatHex({ r: 278.7, g: -57.8, b: 38.3, alpha: 1 }), "#ff0026");
  assert.equal(formatHex({ r: 0, g: 0, b: 0, alpha: 0.5 }), "#00000080");
  assert.equal(formatHex({ r: Number.NaN, g: 0, b: 0, alpha: 1 }), null);
});
