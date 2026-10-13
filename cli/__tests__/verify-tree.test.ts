// verify v2, element by element (design section 10), on the harness: each
// fixture built faithfully in mock Figma, read back with the real template,
// and scored; then broken the ways the live push was broken, each of which
// must cost what the design says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { figmaFonts, loadTreeFixture, treeFixtureNames } from "./mock-figma.js";
import type { MockFont, TreeFixture } from "./mock-figma.js";
import { READBACK_TEMPLATE, assemble, buildAndRead, buildFixture, fixtureMeasure, linearGradientPaint, newFigma, readBack, reread } from "./tree-harness.js";
import { readbackChecksum, treeStrictFailures, verify } from "../verify.js";
import type { ReadbackFile, ReadbackStyles, VerifyResult } from "../verify.js";
import { SPIKE, cssLinearGradient, scoreTree, svgShapePaints, visibleReorder } from "../verify-tree.js";
import type { TreeScore } from "../verify-tree.js";
import type { Box, TreeNode } from "../tree-types.js";
import type { NormalizedStyles } from "../snap-normalize.js";

/** Every node verify didn't verify, as `slug key: property measured→figma`, for an assertion's message. */
function drift(result: VerifyResult): string {
  return result.variants.flatMap((v) => (v.nodes ?? []).map((n) => `${v.slug} ${n.key || "(root)"} ${n.status}${n.gate ? ` [${n.gate}]` : ""}: ${n.differences.map((d) => `${d.property} ${JSON.stringify(d.measured)}→${JSON.stringify(d.figma)}`).join("; ")}`))
    .concat(result.readbackIssues.map((i) => `${i.slug} ${i.problem} ${JSON.stringify(i.missing ?? "")}`))
    .join("\n");
}

for (const name of treeFixtureNames()) {
  test(`faithful build: ${name} scores 100% of elements, with no issues`, async () => {
    const { fixture, readback } = await buildAndRead(name);
    const result = verify(fixture, readback, 0.5);
    assert.equal(result.elementFidelity, 1, drift(result));
    assert.deepEqual(result.readbackIssues, []);
    assert.equal(result.fidelity, 1, drift(result));
  });
}

// Every fixture but example-button draws its text in system-ui, which Figma
// sets in a stand-in, Inter, a few percent wider: that text's width is
// allowed 6% (design 10.5), and costs nothing around it. example-button's
// is Inter in both, so the same font drawn 4.5% wider is drift, on that
// text alone, below. But a text that truncates at the box the browser drew
// it whole in is cut short there in Inter, as the fourth live push's
// Attachment titles were: drift on its truncation alone, that many in
// these fixtures. (The build widens such a label where it can, keepLines;
// this harness builds every box as measured.)
const CUT_SHORT_IN_INTER: Record<string, number> = { attachment: 2, sidebar: 5 };
for (const name of treeFixtureNames().filter((n) => n !== "example-button")) {
  test(`faithful build: ${name} in Figma's Inter costs nothing but the texts Inter cuts short, laid out absolute or in auto layout`, async () => {
    for (const autoLayout of [false, true]) {
      for (const [fonts, measure] of [["the browser's widths", fixtureMeasure()], ["Figma's Inter", figmaFonts()]] as const) {
        const { fixture, readback } = await buildAndRead(name, { figma: newFigma({ measure }), autoLayout });
        const result = verify(fixture, readback, 0.5);
        const where = `${autoLayout ? "auto layout" : "absolute"}, ${fonts}:\n${drift(result)}`;
        const nodes = result.variants.flatMap((v) => v.nodes ?? []);
        assert.equal(nodes.length, fonts === "Figma's Inter" ? CUT_SHORT_IN_INTER[name] ?? 0 : 0, where);
        for (const n of nodes) {
          assert.deepEqual(n.differences, [{ property: "truncation", measured: { maxLines: 1, cut: false }, figma: { truncation: "ENDING", maxLines: 1, cut: true } }], where);
        }
      }
    }
  });
}

test("faithful build: the same font drawn 4.5% wider costs each label its width, and nothing around it", async () => {
  const browser = fixtureMeasure();
  const wider = { advance: (chars: string, font: MockFont) => browser.advance(chars, font) * 1.045 };
  const { fixture, readback } = await buildAndRead("example-button", { figma: newFigma({ measure: wider }), autoLayout: true });
  const result = verify(fixture, readback, 0.5);
  const nodes = result.variants.flatMap((v) => v.nodes ?? []);
  assert.equal(nodes.length, 12);
  assert.ok(nodes.every((n) => n.key === "#text" && n.differences.length === 1 && n.differences[0].property === "w"), drift(result));
  // The hugging buttons grew with their labels, and that is not drift on them.
  assert.equal(result.summary.elements!.verified, 12);
});

test("faithful build: every fixture's elements are all scored, not passed by default", async () => {
  // Elements measured, elements verified, and properties compared: every
  // element of every variant, each on its kind's properties (design 10.2).
  // A property left uncompared, or an element passed without its record,
  // changes the count. The tooltip's arrow, turned, is scored on its turn
  // too.
  const counts: Record<string, [number, number, number]> = {};
  for (const name of treeFixtureNames()) {
    const { fixture, readback } = await buildAndRead(name, { autoLayout: true });
    const result = verify(fixture, readback, 0.5);
    counts[name] = [result.summary.elements!.measured, result.summary.elements!.verified, result.summary.propertiesCompared];
  }
  assert.deepEqual(counts, {
    attachment: [32, 32, 396], avatar: [9, 9, 93], "button-icon": [30, 30, 360], card: [46, 46, 648], dialog: [11, 11, 156], "example-button": [24, 24, 312],
    inputotp: [8, 8, 94], select: [43, 43, 633], sidebar: [25, 25, 321], switch: [4, 4, 42], toggle: [12, 12, 102], tooltip: [3, 3, 42],
  });
});

// --- Falsification (design section 15, package C) ------------------------------------
//
// The live push's defects, made in Figma after a faithful build, as a person
// would make them: each must cost what the design says, and nothing else.

/** A layer's live handle, to change as a person would in Figma between calls. */
type Handle = any;
const node = (figma: { handle(id: string): unknown }, id: string): Handle => figma.handle(id);

/** The Figma layer of `key` in each variant built, by slug. */
function layers(built: Awaited<ReturnType<typeof buildAndRead>>["built"], key: string): { slug: string; id: string }[] {
  return built.variants.filter((v) => v.layers[key]).map((v) => ({ slug: v.slug, id: v.layers[key] }));
}

async function falsified(name: string | TreeFixture, change: (ctx: Awaited<ReturnType<typeof buildAndRead>>) => void | Promise<void>, options: { autoLayout?: boolean } = {}): Promise<VerifyResult> {
  const ctx = await buildAndRead(name, options);
  await change(ctx);
  return verify(ctx.fixture, await reread(ctx.figma, ctx.fixture, ctx.built), 0.5);
}

const near = (actual: number | null | undefined, expected: number, message: string) =>
  assert.ok(actual != null && Math.abs(actual * 100 - expected) <= 0.5, `${message}: ${actual == null ? actual : (actual * 100).toFixed(2)}%, not ${expected}% ± 0.5`);

/** The drifted, missing and extra nodes, as `slug key: properties`. */
function findings(result: VerifyResult): string[] {
  return result.variants.flatMap((v) => (v.nodes ?? []).map((n) => `${v.slug} ${n.key}: ${n.status === "drifted" ? n.differences.map((d) => d.property).join(",") : n.status}`));
}

test("falsify: a Switch without its thumb scores 50%", async () => {
  const result = await falsified("switch", ({ figma, built }) => {
    for (const { id } of layers(built, "switch-thumb")) node(figma, id).remove();
  });
  near(result.elementFidelity, 50, "Switch without its thumb");
  assert.deepEqual(findings(result), ["size-default switch-thumb: missing", "size-sm switch-thumb: missing"]);
  // And in the share of properties, every property of the thumb's kind, unmatched.
  const { fixture, readback } = await buildAndRead("switch");
  const whole = verify(fixture, readback, 0.5).summary;
  assert.equal(result.summary.propertiesCompared, whole.propertiesCompared);
  assert.equal(result.summary.propertiesMatched, whole.propertiesMatched - 2 * 12, "x, y, w, h, fills, stroke, radius, effects, opacity, blend, clip and visible, twice");
});

test("falsify: the Tooltip's arrow built unturned, as the fifth live push built it, drifts on its turn alone", async () => {
  const result = await falsified("tooltip", ({ figma, built }) => {
    for (const { id } of layers(built, "div")) Object.assign(node(figma, id), { rotation: 0, x: 45.5, y: 21 });
  });
  assert.deepEqual(findings(result), ["default div: turn"]);
  assert.deepEqual(result.variants[0].nodes!.find((n) => n.key === "div")!.differences, [{ property: "turn", measured: 45, figma: 0 }]);
  // Turned the wrong way, it drifts on its turn too; turned right but
  // about its corner, as Figma turns a layer, it drifts on its place.
  const other = await falsified("tooltip", ({ figma, built }) => {
    for (const { id } of layers(built, "div")) Object.assign(node(figma, id), { rotation: 45, x: 45.5, y: 21 });
  });
  assert.deepEqual(findings(other), ["default div: x,y,turn"]);
  const corner = await falsified("tooltip", ({ figma, built }) => {
    for (const { id } of layers(built, "div")) Object.assign(node(figma, id), { rotation: -45, x: 45.5, y: 21 });
  });
  assert.deepEqual(findings(corner), ["default div: x,y"]);
});

test("falsify: a thumb moved from x 1 to 15 drifts on x alone", async () => {
  const result = await falsified("switch", ({ figma, built }) => {
    node(figma, layers(built, "switch-thumb")[0].id).x = 15;
  });
  assert.deepEqual(findings(result), ["size-default switch-thumb: x"]);
});

test("falsify: a thumb filled #f5f5f5 drifts on its fills alone", async () => {
  const result = await falsified("switch", ({ figma, built }) => {
    node(figma, layers(built, "switch-thumb")[0].id).fills = [{ type: "SOLID", color: { r: 0xf5 / 255, g: 0xf5 / 255, b: 0xf5 / 255 } }];
  });
  assert.deepEqual(findings(result), ["size-default switch-thumb: fills"]);
  const thumb = result.variants[0].nodes![0];
  assert.deepEqual(thumb.differences, [{ property: "fills", measured: ["#ffffff"], figma: ["#f5f5f5"] }]);
  assert.match(thumb.figmaId!, /^\d+:\d+$/);
});

test("falsify: an Avatar built as an invisible circle scores 33.3%, and with only its ring 66.7%", async () => {
  const invisible = await falsified("avatar", ({ figma, built }) => {
    for (const key of ["avatar-image", "::after"]) for (const { id } of layers(built, key)) node(figma, id).remove();
  });
  near(invisible.elementFidelity, 33.3, "Avatar invisible");
  const ring = await falsified("avatar", ({ figma, built }) => {
    for (const { id } of layers(built, "avatar-image")) node(figma, id).remove();
  });
  near(ring.elementFidelity, 66.7, "Avatar ring without photo");
});

test("falsify: an empty InputOTP scores 12.5%, and a first slot without its left border drifts on its stroke", async () => {
  const empty = await falsified("inputotp", ({ figma, built }) => {
    node(figma, built.variants[0].layers["input-otp-group"]).remove();
  });
  near(empty.elementFidelity, 12.5, "InputOTP empty");
  const border = await falsified("inputotp", ({ figma, built }) => {
    node(figma, built.variants[0].layers["input-otp-group/input-otp-slot"]).strokeLeftWeight = 0;
  });
  assert.deepEqual(findings(border), ["default input-otp-group/input-otp-slot: stroke"]);
});

test("falsify: a Card built as a shell with its title at x=0 scores 8.3%, and one without its footer button 91.3%", async () => {
  const shell = await falsified("card", ({ figma, built }) => {
    for (const v of built.variants) {
      const root = node(figma, v.id) as { appendChild(n: unknown): void };
      const title = node(figma, v.layers["card-header/card-title"]);
      root.appendChild(title);
      // Where 0.4.0's build put its one label: at the root's left edge, below its padding.
      Object.assign(title, { x: 0, y: 24 });
      for (const key of ["card-header", "card-content", "card-footer"]) node(figma, v.layers[key]).remove();
    }
  });
  near(shell.elementFidelity, 8.3, "Card shell");
  const noButton = await falsified("card", ({ figma, built }) => {
    for (const { id } of layers(built, "card-footer/button")) node(figma, id).remove();
  });
  near(noButton.elementFidelity, 91.3, "Card without its footer button");
});

test("falsify: a Toggle whose icon is a placeholder frame scores 50%, by the kind gate", async () => {
  const result = await falsified("toggle", ({ figma, built }) => {
    // The icon's vector frame stripped of its svg: a frame of the icon's size, as 0.4.0's 'Icon (Bold)'.
    for (const { id } of layers(built, "svg")) {
      const icon = node(figma, id) as { setSharedPluginData(ns: string, k: string, v: string): void; children: { remove(): void }[] };
      icon.setSharedPluginData("storysync", "svg", "");
      for (const shape of [...icon.children]) shape.remove();
    }
  });
  near(result.elementFidelity, 50, "Toggle placeholder icon");
  assert.ok(result.variants.every((v) => v.nodes!.every((n) => n.gate === "kind")));
});

test("falsify: a Button label 3px right of its place drifts on x, on that node alone", async () => {
  const result = await falsified("button-icon", ({ figma, built }) => {
    node(figma, built.variants[0].layers["#text"]).x += 3;
  });
  assert.deepEqual(findings(result), ["variant-default--size-default #text: x"]);
});

test("falsify: a Card row shifted 0.8px passes, and 3px is exactly one difference", async () => {
  const shift = (dx: number) => falsified("card", ({ figma, built }) => {
    (node(figma, built.variants[0].layers["card-content/div:2"]) as { x: number }).x += dx;
  });
  assert.deepEqual(findings(await shift(0.8)), []);
  assert.deepEqual(findings(await shift(3)), ["size-default card-content/div:2: x"]);
});

test("falsify: a vertical Attachment built as its root and an untruncated title scores what its elements have", async () => {
  const result = await falsified("attachment", ({ figma, built }) => {
    const v = built.variants.find((x) => x.slug === "size-default--orientation-vertical--state-done")!;
    const root = node(figma, v.id) as { appendChild(n: unknown): void };
    const title = node(figma, v.layers["attachment-content/attachment-title"]) as Record<string, unknown> & { resize(w: number, h: number): void };
    root.appendChild(title);
    title.textTruncation = "DISABLED";
    title.maxLines = null;
    title.textAutoResize = "WIDTH_AND_HEIGHT";
    Object.assign(title, { x: 8, y: 8 });
    for (const key of ["attachment-content", "attachment-media", "attachment-action"]) node(figma, v.layers[key]).remove();
  });
  const vertical = result.variants.find((x) => x.slug === "size-default--orientation-vertical--state-done")!;
  // 8 elements: the root, right, and the title, wrong on x, y, width and
  // truncation of the 18 it is scored on: (1 + 14/18) / 8.
  near(vertical.elements!.fidelity, 22.2, "Attachment vertical untruncated");
  assert.deepEqual(vertical.nodes!.find((n) => n.key.endsWith("attachment-title"))!.differences.map((d) => d.property), ["x", "y", "w", "truncation"]);
});

// --- Each property, scored -------------------------------------------------------------
//
// One change in Figma per property a node's kind is scored on (design
// 10.2), on a faithful build: each must cost that property on that node,
// and nothing else; a gate's, the whole node.

/** A solid paint of `hex` (#rrggbb). */
const paint = (hex: string) => ({ type: "SOLID", color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 } });

/** A text layer, sized as it is, so a change to its style changes nothing else about it. */
function textOf(ctx: Awaited<ReturnType<typeof buildAndRead>>, key: string): Handle {
  const text = node(ctx.figma, ctx.built.variants[0].layers[key]);
  text.textAutoResize = "NONE";
  return text;
}

const PROPERTY_CASES: { property: string; fixture: string; key: string; change: (ctx: Awaited<ReturnType<typeof buildAndRead>>) => void; finding: string }[] = [
  // A frame: fills (above, on the thumb), stroke, radius, effects, opacity, blend, clip, order, size.
  { property: "stroke color", fixture: "inputotp", key: "input-otp-group/input-otp-slot", finding: "stroke", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["input-otp-group/input-otp-slot"]).strokes = [paint("#ff0000")]; } },
  { property: "stroke style", fixture: "inputotp", key: "input-otp-group/input-otp-slot", finding: "stroke", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["input-otp-group/input-otp-slot"]).dashPattern = [3, 3]; } },
  { property: "stroke align", fixture: "inputotp", key: "input-otp-group/input-otp-slot", finding: "stroke", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["input-otp-group/input-otp-slot"]).strokeAlign = "CENTER"; } },
  { property: "radius", fixture: "card", key: "", finding: "radius", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].id).cornerRadius = 18; } },
  {
    property: "shadow color", fixture: "inputotp", key: "input-otp-group/input-otp-slot", finding: "effects", change: (ctx) => {
      const slot = node(ctx.figma, ctx.built.variants[0].layers["input-otp-group/input-otp-slot"]);
      slot.effects = slot.effects.map((e: Record<string, unknown>) => ({ ...e, color: { r: 1, g: 0, b: 0, a: 0.05 } }));
    },
  },
  {
    property: "an effect snap didn't measure", fixture: "switch", key: "switch-thumb", finding: "effects", change: (ctx) => {
      node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).effects = [{ type: "LAYER_BLUR", radius: 4, visible: true }];
    },
  },
  { property: "opacity", fixture: "switch", key: "switch-thumb", finding: "opacity", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).opacity = 0.5; } },
  { property: "blend, measured normal", fixture: "switch", key: "switch-thumb", finding: "blend", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).blendMode = "MULTIPLY"; } },
  { property: "blend, measured darken", fixture: "avatar", key: "::after", finding: "blend", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["::after"]).blendMode = "MULTIPLY"; } },
  { property: "clip", fixture: "switch", key: "switch-thumb", finding: "clip", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).clipsContent = true; } },
  {
    // Avatar's ring, painted over its photo, put under it.
    property: "order", fixture: "avatar", key: "", finding: "order", change: (ctx) => {
      node(ctx.figma, ctx.built.variants[0].id).insertChild(0, node(ctx.figma, ctx.built.variants[0].layers["::after"]));
    },
  },
  { property: "width", fixture: "switch", key: "switch-thumb", finding: "w", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).resize(20, 16); } },
  // A text: each property of its style, its lines and opacity.
  { property: "family", fixture: "example-button", key: "#text", finding: "family", change: (ctx) => { textOf(ctx, "#text").fontName = { family: "Roboto Mono", style: "SemiBold" }; } },
  { property: "weight", fixture: "button-icon", key: "#text", finding: "weight", change: (ctx) => { textOf(ctx, "#text").fontName = { family: "Inter", style: "Bold" }; } },
  { property: "italic", fixture: "button-icon", key: "#text", finding: "italic", change: (ctx) => { textOf(ctx, "#text").fontName = { family: "Inter", style: "Medium Italic" }; } },
  { property: "font size", fixture: "button-icon", key: "#text", finding: "size", change: (ctx) => { textOf(ctx, "#text").fontSize = 16; } },
  { property: "line height", fixture: "button-icon", key: "#text", finding: "lineHeight", change: (ctx) => { textOf(ctx, "#text").lineHeight = { unit: "PIXELS", value: 24 }; } },
  { property: "letter spacing", fixture: "button-icon", key: "#text", finding: "letterSpacing", change: (ctx) => { textOf(ctx, "#text").letterSpacing = { unit: "PIXELS", value: 1 }; } },
  { property: "text color", fixture: "button-icon", key: "#text", finding: "color", change: (ctx) => { textOf(ctx, "#text").fills = [paint("#ff0000")]; } },
  { property: "case", fixture: "button-icon", key: "#text", finding: "case", change: (ctx) => { textOf(ctx, "#text").textCase = "UPPER"; } },
  { property: "decoration", fixture: "button-icon", key: "#text", finding: "decoration", change: (ctx) => { textOf(ctx, "#text").textDecoration = "UNDERLINE"; } },
  { property: "align", fixture: "button-icon", key: "#text", finding: "align", change: (ctx) => { textOf(ctx, "#text").textAlignHorizontal = "LEFT"; } },
  {
    property: "lines", fixture: "button-icon", key: "#text", finding: "h,lines", change: (ctx) => {
      const text = textOf(ctx, "#text");
      text.resize(text.width, 40);
    },
  },
  { property: "text opacity", fixture: "button-icon", key: "#text", finding: "opacity", change: (ctx) => { textOf(ctx, "#text").opacity = 0.5; } },
  {
    // In a stand-in font a text may be 6% wider than the browser drew it, not 10%.
    property: "stand-in width", fixture: "button-icon", key: "#text", finding: "w", change: (ctx) => {
      const text = textOf(ctx, "#text");
      text.resize(text.width * 1.1, text.height);
    },
  },
  // A vector: its shapes' paint and its opacity; an image: its radius and clip.
  { property: "shape paint", fixture: "toggle", key: "svg", finding: "paint", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers.svg).children[0].strokes = [paint("#ff0000")]; } },
  { property: "vector opacity", fixture: "toggle", key: "svg", finding: "opacity", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers.svg).opacity = 0.5; } },
  { property: "image radius", fixture: "avatar", key: "avatar-image", finding: "radius", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["avatar-image"]).cornerRadius = 0; } },
  { property: "image clip", fixture: "avatar", key: "avatar-image", finding: "clip", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers["avatar-image"]).clipsContent = false; } },
];

for (const c of PROPERTY_CASES) {
  test(`property: ${c.property} wrong in Figma drifts on that alone, on that node alone`, async () => {
    const result = await falsified(c.fixture, c.change);
    const slug = loadTreeFixture(c.fixture).components[0].variants[0].slug;
    assert.deepEqual(findings(result), [`${slug} ${c.key}: ${c.finding}`]);
    const verdict = result.variants[0].nodes![0];
    assert.equal(verdict.gate, undefined);
    assert.ok(verdict.score > 0 && verdict.score < 1, `${verdict.score}`);
  });
}

const GATE_CASES: { gate: string; fixture: string; key: string; change: (ctx: Awaited<ReturnType<typeof buildAndRead>>) => void }[] = [
  { gate: "chars", fixture: "button-icon", key: "#text", change: (ctx) => { textOf(ctx, "#text").characters = "Logout"; } },
  { gate: "shapes", fixture: "button-icon", key: "svg", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers.svg).children[0].remove(); } },
  // A shape 1px out of place in a 16px icon, past its 0.5px.
  { gate: "shapes", fixture: "toggle", key: "svg", change: (ctx) => { node(ctx.figma, ctx.built.variants[0].layers.svg).children[0].x += 1; } },
];

for (const c of GATE_CASES) {
  test(`gate: wrong ${c.gate} in Figma scores the node 0, as another node`, async () => {
    const result = await falsified(c.fixture, c.change);
    const nodes = result.variants.flatMap((v) => v.nodes ?? []);
    assert.equal(nodes.length, 1, findings(result).join("\n"));
    assert.deepEqual([nodes[0].key, nodes[0].gate, nodes[0].score], [c.key, c.gate, 0]);
  });
}

test("order: visibleReorder judges as the build does, on the same cases as the build's test", () => {
  // cli/__tests__/figma-layout.test.ts holds the build's rule to these.
  const painted: { k: string; box: Box }[] = [{ k: "content", box: [56, 8, 200, 40] }, { k: "media", box: [8, 8, 40, 40] }, { k: "x", box: [260, 16, 24, 24] }];
  const media = (box: Box) => painted.map((p) => (p.k === "media" ? { ...p, box } : p));
  assert.equal(visibleReorder(painted, ["content", "media", "x"]), null, "the same order");
  assert.equal(visibleReorder(painted, ["media", "content", "x"]), null, "Attachment's: media and content keep apart");
  assert.deepEqual(visibleReorder(media([8, 8, 60, 40]), ["media", "content", "x"]), ["content", "media"], "12px over each other");
  assert.deepEqual(visibleReorder(media([8, 8, 49, 40]), ["media", "content", "x"]), ["content", "media"], "1px over each other");
  assert.equal(visibleReorder(media([8, 8, 48.5, 40]), ["media", "content", "x"]), null, "within half a pixel");
  assert.equal(visibleReorder(painted, ["x", "media"]), null, "a key in only one is skipped");
  assert.equal(visibleReorder(media([8, 8, 60, 40]), ["x", "content"]), null, "and one over another is skipped too");
});

test("order: siblings in another order that keep apart draw the same, and verify, as the build lays them out", async () => {
  // Card's content put under its header and footer, which it doesn't touch.
  const card = await falsified("card", ({ figma, built }) => {
    node(figma, built.variants[0].id).insertChild(0, node(figma, built.variants[0].layers["card-content"]));
  });
  assert.deepEqual(findings(card), []);
  // Attachment's media tile paints after the content it flows before; the
  // build lays its layers out in flow order, media first.
  const attachment = await falsified("attachment", ({ figma, built }) => {
    for (const v of built.variants) node(figma, v.id).insertChild(0, node(figma, v.layers["attachment-media"]));
  });
  assert.equal(attachment.elementFidelity, 1, findings(attachment).join("\n"));
  // Moved 30px right, over the content, it drifts on x. Whether an order
  // shows is judged where snap drew the two, apart, as the build judges it,
  // so the order is not drift as well.
  const over = await falsified("attachment", ({ figma, built }) => {
    const v = built.variants[0];
    node(figma, v.id).insertChild(0, node(figma, v.layers["attachment-media"]));
    node(figma, v.layers["attachment-media"]).x += 30;
  });
  const slug = loadTreeFixture("attachment").components[0].variants[0].slug;
  assert.deepEqual(findings(over), [`${slug} attachment-media: x`]);
});

test("positions and sizes: a container grows across its flow by its tallest child's growth, and no more", async () => {
  // Two of InputOTP's slots 4px taller, which a hugging row grows by 4,
  // not by both.
  const grow = (dh: number) => falsified("inputotp", ({ figma, built }) => {
    const v = built.variants[0];
    for (const key of ["input-otp-group/input-otp-slot", "input-otp-group/input-otp-slot:2"]) {
      const layer = node(figma, v.layers[key]);
      layer.resize(layer.width, layer.height + 4);
    }
    const group = node(figma, v.layers["input-otp-group"]);
    group.resize(group.width, group.height + dh);
  });
  const slots = ["default input-otp-group/input-otp-slot: h", "default input-otp-group/input-otp-slot:2: h"];
  assert.deepEqual(findings(await grow(4)), slots);
  assert.deepEqual(findings(await grow(6)), ["default input-otp-group: h", ...slots]);
});

test("positions and sizes: a child deleted or hidden in a hugging frame costs itself, not its frame's size or its siblings' places", async () => {
  // Figma's auto layout gives a missing or hidden layer no room: the frame
  // hugging it shrinks, and the layers after it move up. Both follow from
  // the one change, which is the one finding.
  const deleted = await falsified("switch", ({ figma, built }) => {
    node(figma, layers(built, "switch-thumb")[0].id).remove();
  }, { autoLayout: true });
  assert.deepEqual(findings(deleted), ["size-default switch-thumb: missing"]);
  const hidden = await falsified("inputotp", ({ figma, built }) => {
    node(figma, built.variants[0].layers["input-otp-group/input-otp-slot:3"]).visible = false;
  }, { autoLayout: true });
  assert.deepEqual(findings(hidden), ["default input-otp-group/input-otp-slot:3: visible"]);
  // A frame that shrinks by more than the child it lost still drifts.
  const shrunk = await falsified("inputotp", ({ figma, built }) => {
    const v = built.variants[0];
    node(figma, v.layers["input-otp-group/input-otp-slot:3"]).visible = false;
    const group = node(figma, v.layers["input-otp-group"]);
    group.layoutMode = "NONE";
    group.resize(group.width - 60, group.height);
  }, { autoLayout: true });
  assert.ok(findings(shrunk).includes("default input-otp-group: w"), findings(shrunk).join("; "));
});

test("positions and sizes: an approximate node's geometry is scored within 2px, and past that listed, not scored", async () => {
  const fixture = loadTreeFixture("card");
  const footer = fixture.components[0].tree.base.find((n) => n.k === "card-footer/button")!;
  footer.approx = "a transform snap measured by its box";
  const move = (dx: number) => falsified(JSON.parse(JSON.stringify(fixture)) as TreeFixture, ({ figma, built }) => {
    node(figma, built.variants[0].layers["card-footer/button"]).x += dx;
  });
  const near2 = await move(1.5);
  assert.deepEqual(findings(near2), []);
  const far = await move(4);
  assert.deepEqual(findings(far), []);
  assert.ok(far.unscorable!.some((u) => u.key === "card-footer/button" && u.property === "x" && /approximate geometry/.test(u.reason)), JSON.stringify(far.unscorable));
});

test("linear gradients: a gradient built faithfully verifies, transparent stops too, and one turned 10 degrees drifts on its fills", async () => {
  const fixture = loadTreeFixture("switch");
  const thumb = fixture.components[0].tree.base.find((n) => n.k === "switch-thumb")!;
  // A fade from nothing, as snap writes rgba(255 255 255 / 0), and from
  // `transparent`, which Figma draws only in its neighbor's color.
  thumb.bgi = "linear-gradient(90deg, #ffffff00 0%, #000000 100%), linear-gradient(to bottom, #00000000, #ff0000 40%, #0000ff)";
  const ctx = await buildAndRead(fixture);
  assert.equal(verify(ctx.fixture, ctx.readback, 0.5).elementFidelity, 1);
  const fills = node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).fills as Record<string, unknown>[];
  const read = ctx.readback.components["ui/base/Switch"].variants["size-default"].tree![1][6] as string[];
  assert.deepEqual(read.slice(1), ["lin:180:#00000000@0,#ff0000@0.4,#0000ff@1", "lin:90:#ffffff00@0,#000000@1"]);
  // `transparent` built in its neighbor's color, as Figma needs it.
  const borrowed = { ...fills[1], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 0 } }, ...(fills[1].gradientStops as unknown[]).slice(1)] };
  node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).fills = [fills[0], borrowed, fills[2]];
  assert.equal(verify(ctx.fixture, await reread(ctx.figma, ctx.fixture, ctx.built), 0.5).elementFidelity, 1);
  // Not another color, though.
  const blue = { ...fills[1], gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 1, a: 0 } }, ...(fills[1].gradientStops as unknown[]).slice(1)] };
  node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).fills = [fills[0], blue, fills[2]];
  assert.deepEqual(findings(verify(ctx.fixture, await reread(ctx.figma, ctx.fixture, ctx.built), 0.5)), ["size-default switch-thumb: fills"]);
  // Turned 10 degrees.
  node(ctx.figma, ctx.built.variants[0].layers["switch-thumb"]).fills = [fills[0], fills[1], linearGradientPaint("lin:100:#ffffff00@0,#000000@1", 16, 16)];
  assert.deepEqual(findings(verify(ctx.fixture, await reread(ctx.figma, ctx.fixture, ctx.built), 0.5)), ["size-default switch-thumb: fills"]);
});

// --- Integrity (design section 15, package C) -------------------------------------

/** The readback with `slug`'s entry changed by `edit`, its checksum left as it was. */
function edited(readback: ReadbackFile, component: string, slug: string, edit: (entry: ReadbackStyles) => void): ReadbackFile {
  const copy = JSON.parse(JSON.stringify(readback)) as ReadbackFile;
  edit(copy.components[component].variants[slug]);
  return copy;
}

test("integrity: a hidden layer scores 0, by the visibility gate", async () => {
  const result = await falsified("switch", ({ figma, built }) => {
    node(figma, layers(built, "switch-thumb")[0].id).visible = false;
  });
  near(result.elementFidelity, 75, "one of four elements hidden");
  assert.equal(result.variants[0].nodes![0].gate, "visible");
});

test("strict: drifted, missing and extra elements and reads with no result each fail --strict, and say so", async () => {
  const drifted = await falsified("switch", ({ figma, built }) => {
    node(figma, layers(built, "switch-thumb")[0].id).opacity = 0.5;
  });
  assert.deepEqual(treeStrictFailures(drifted), ["1 element drifted"]);
  const missing = await falsified("switch", ({ figma, built }) => {
    for (const { id } of layers(built, "switch-thumb")) node(figma, id).remove();
  });
  assert.deepEqual(treeStrictFailures(missing), ["2 elements are missing from Figma"]);
  const { fixture, readback } = await buildAndRead("switch");
  const unread = verify(fixture, readback, 0.5, { notRead: [7, 9] });
  assert.deepEqual(treeStrictFailures(unread), ["planned read calls 7, 9 not read whole"]);
  assert.deepEqual(treeStrictFailures(verify(fixture, readback, 0.5, { notRead: [7] })), ["planned read call 7 not read whole"]);
  assert.deepEqual(treeStrictFailures(verify(fixture, readback, 0.5)), []);
});

test("integrity: a keyed layer snap doesn't measure is an extra element scoring 0", async () => {
  const result = await falsified("switch", async ({ figma, built }) => {
    // As a designer's duplicate of a layer keeps its plugin data, under another key here.
    const run = await figma.run(`const v = await figma.getNodeByIdAsync(${JSON.stringify(built.variants[0].id)}); const f = figma.createFrame(); v.appendChild(f); f.resize(4, 4); f.setSharedPluginData('storysync', 'k', 'switch-thumb:2'); return f.id;`);
    assert.ok(run.ok, run.text);
  });
  assert.equal(result.summary.elements!.extra, 1);
  near(result.elementFidelity, 80, "four elements and one extra");
  assert.deepEqual(findings(result), ["size-default switch-thumb:2: extra"]);
  assert.deepEqual(treeStrictFailures(result), ["1 keyed layer in Figma snap no longer measures"]);
});

test("integrity: a designer's layer is listed, not scored, and fails --strict unless allowed", async () => {
  const ctx = await buildAndRead("toggle");
  const v = ctx.built.variants[0];
  await ctx.figma.run(`const v = await figma.getNodeByIdAsync(${JSON.stringify(v.id)}); const r = figma.createRectangle(); r.name = 'Note'; v.appendChild(r); return r.id;`);
  const result = verify(ctx.fixture, await reread(ctx.figma, ctx.fixture, ctx.built), 0.5);
  assert.equal(result.elementFidelity, 1);
  assert.equal(result.summary.elements!.designerLayers, 1);
  assert.deepEqual(result.variants[0].designerLayers!.map(([name, type]) => [name, type]), [["Note", "RECTANGLE"]]);
  assert.deepEqual(treeStrictFailures(result), ["1 designer layer inside variants"]);
  assert.deepEqual(treeStrictFailures(result, { allowDesignerLayers: true }), []);
});

test("integrity: a child's fill edited in the file fails that entry's checksum, and only that one", async () => {
  const { fixture, readback } = await buildAndRead("switch");
  const tampered = edited(readback, "ui/base/Switch", "size-sm", (entry) => {
    (entry.tree![1] as unknown[])[6] = ["#ff00ff"];
  });
  const result = verify(fixture, tampered, 0.5);
  assert.deepEqual(result.readbackIssues.map((i) => [i.slug, i.problem]), [["size-sm", "checksum_mismatch"]]);
  assert.deepEqual(result.variants.map((v) => v.status), ["verified", "unverified_readback"]);
});

test("integrity: a variant read in parts with one dropped is parts_missing, and nothing in it is scored", async () => {
  const { fixture, readback, results } = await buildAndRead("sidebar", { limit: 1500 });
  assert.ok(results.length > 2, "the sidebar was read in parts");
  const component = Object.keys(readback.components)[0];
  const keys = Object.keys(readback.components[component].variants);
  assert.ok(keys.some((k) => k.includes("#")));
  const whole = verify(fixture, readback, 0.5);
  assert.equal(whole.elementFidelity, 1, "read in parts, it still scores whole");
  assert.deepEqual(whole.unmeasuredInFigma, [], "a later part is no variant of its own");
  // The first part, one in the middle, or the last: each leaves the parts
  // short, and the variant unscored.
  for (const key of [keys[0], keys[1], keys[keys.length - 1]]) {
    const dropped = edited(readback, component, key, () => undefined);
    delete dropped.components[component].variants[key];
    const result = verify(fixture, dropped, 0.5);
    assert.deepEqual(result.readbackIssues.map((i) => i.problem), ["parts_missing"], key);
    assert.deepEqual(result.variants.map((v) => v.status), ["parts_missing"], key);
    assert.equal(result.summary.partsMissing, 1, key);
    assert.equal(result.summary.elements!.measured, 0, key);
    assert.deepEqual(result.unmeasuredInFigma, [], key);
  }
});

/** The readback with `key`'s entry changed by `edit` and sealed again, as a template that read it so would have. */
function resealed(readback: ReadbackFile, component: string, key: string, edit: (entry: ReadbackStyles) => void): ReadbackFile {
  const copy = edited(readback, component, key, edit);
  const { checksum: _checksum, ...rest } = copy.components[component].variants[key];
  copy.components[component].variants[key] = { ...rest, checksum: readbackChecksum(copy.components[component].nodeId!, key, rest) };
  return copy;
}

test("integrity: parts that say the wrong count, total or first node are parts_missing, sealed as they are", async () => {
  const { fixture, readback } = await buildAndRead("sidebar", { limit: 1500 });
  const component = Object.keys(readback.components)[0];
  const keys = Object.keys(readback.components[component].variants).sort((a, b) => (readback.components[component].variants[a].part?.[0] ?? 0) - (readback.components[component].variants[b].part?.[0] ?? 0));
  const second = keys[1];
  const cases: [string, (e: ReadbackStyles) => void][] = [
    ["a count that isn't its records'", (e) => { e.part = [e.part![0], e.part![1] + 1, e.part![2]]; }],
    ["a total other parts don't give", (e) => { e.part = [e.part![0], e.part![1], e.part![2] + 1]; }],
    ["a first node its key doesn't give", (e) => { e.part = [e.part![0] + 1, e.part![1], e.part![2]]; }],
  ];
  for (const [what, edit] of cases) {
    const result = verify(fixture, resealed(readback, component, second, edit), 0.5);
    assert.deepEqual(result.readbackIssues.map((i) => i.problem), ["parts_missing"], what);
  }
  // A part under a key its first node doesn't give, its count and place
  // right, sealed under that key.
  const rekeyed = JSON.parse(JSON.stringify(readback)) as ReadbackFile;
  const variants = rekeyed.components[component].variants;
  const { checksum: _checksum, ...moved } = variants[second];
  delete variants[second];
  variants[`${second}0`] = { ...moved, checksum: readbackChecksum(rekeyed.components[component].nodeId!, `${second}0`, moved) };
  assert.deepEqual(verify(fixture, rekeyed, 0.5).readbackIssues.map((i) => i.problem), ["parts_missing"], "a key its first node doesn't give");
  // Every part saying one more record than there are: no gap, but no end.
  let longer = readback;
  for (const key of keys) longer = resealed(longer, component, key, (e) => { e.part = [e.part![0], e.part![1], e.part![2] + 1]; });
  assert.deepEqual(verify(fixture, longer, 0.5).readbackIssues.map((i) => i.problem), ["parts_missing"]);
  // And the last saying it holds that record too, which it doesn't: each
  // count is held to the records its part has.
  const counted = resealed(longer, component, keys[keys.length - 1], (e) => { e.part = [e.part![0], e.part![1] + 1, e.part![2]]; });
  assert.deepEqual(verify(fixture, counted, 0.5).readbackIssues.map((i) => i.problem), ["parts_missing"]);
});

test("integrity: a record of the wrong length is incomplete", async () => {
  const cut = READBACK_TEMPLATE.replace("n.opacity, n.blendMode, n.clipsContent ? 1 : 0, ...tail.slice(1)];", "n.opacity, n.blendMode, ...tail.slice(1)];");
  assert.notEqual(cut, READBACK_TEMPLATE);
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  const readback = assemble(await readBack(figma, [[built.component, 0, 1, 0]], { template: cut }));
  const result = verify(fixture, readback, 0.5);
  assert.deepEqual(result.readbackIssues.map((i) => [i.slug, i.problem]), [["size-default", "incomplete"], ["size-sm", "incomplete"]]);
  assert.match(result.readbackIssues[0].missing!.join(), /an F record of 15 fields, not 16/);
});

/**
 * Attachment built faithfully where Figma sets its title `scale` times as
 * wide as the browser drew it: wider, it cuts short the horizontal titles
 * the browser drew whole, as the fourth live push's Figma did; narrower, it
 * shows whole the vertical ones the browser cut.
 */
async function titleScaled(scale: number) {
  const browser = fixtureMeasure();
  const measure = { advance: (chars: string, font: MockFont) => browser.advance(chars, font) * (chars === "sales-dashboard.pdf" ? scale : 1) };
  return buildAndRead("attachment", { figma: newFigma({ measure }) });
}

test("falsify: a title Figma cuts short where the browser drew it whole drifts on truncation, and one Figma shows whole where the browser cut it", async () => {
  for (const [scale, orientation, cut] of [[1.2, "horizontal", true], [0.5, "vertical", false]] as const) {
    const { fixture, readback } = await titleScaled(scale);
    const result = verify(fixture, readback, 0.5);
    const slugs = fixture.components[0].variants.map((v) => v.slug).filter((s) => s.includes(`orientation-${orientation}`));
    assert.ok(slugs.length > 0);
    assert.deepEqual(findings(result), slugs.map((s) => `${s} attachment-content/attachment-title: truncation`), `${scale}`);
    const [title] = result.variants.flatMap((v) => v.nodes ?? []);
    // Its truncation is as measured: only what it hides differs.
    assert.deepEqual(title.differences, [{ property: "truncation", measured: { maxLines: 1, cut: !cut }, figma: { truncation: "ENDING", maxLines: 1, cut } }]);
  }
});

test("integrity: an entry read with template 2, which can't tell what Figma cuts, or 3, which reads no turn, scores as it did", async () => {
  const { fixture, readback } = await titleScaled(1.2);
  const component = Object.keys(readback.components)[0];
  // What template 2 returned, no `cut` on a text's record and no `turn` on
  // any; and template 3, no `turn`.
  const read = (tpl: number, lengths: Record<string, number>) => {
    const copy = JSON.parse(JSON.stringify(readback)) as ReadbackFile;
    for (const [key, entry] of Object.entries(copy.components[component].variants)) {
      const { checksum: _checksum, ...rest } = entry;
      rest.tpl = tpl;
      rest.tree = rest.tree!.map((r) => r.slice(0, lengths[r[1] as string]));
      copy.components[component].variants[key] = { ...rest, checksum: readbackChecksum(copy.components[component].nodeId!, key, rest) };
    }
    return verify(fixture, copy, 0.5);
  };
  const old = read(2, { F: 15, T: 23, V: 10 });
  assert.deepEqual(old.readbackIssues, []);
  assert.equal(old.elementFidelity, 1, drift(old));
  // Template 3 scores what Figma cuts, as template 4 does, which cuts the
  // titles 1.2 times as wide: the same score, nothing turned to miss.
  const three = read(3, { F: 15, T: 24, V: 10 });
  assert.deepEqual(three.readbackIssues, []);
  assert.equal(three.elementFidelity, verify(fixture, readback, 0.5).elementFidelity);
  assert.ok((three.elementFidelity ?? 1) < 1);
  // A template 3 entry without `cut`, or a template 4 one without `turn`,
  // was read with the template cut down.
  const cut = read(3, { F: 15, T: 23, V: 10 });
  assert.deepEqual(cut.readbackIssues.map((i) => i.problem), ["incomplete", "incomplete", "incomplete", "incomplete"]);
  assert.match(cut.readbackIssues[0].missing!.join(), /a T record of 23 fields, not 24/);
  const unturned = read(4, { F: 15, T: 24, V: 10 });
  assert.deepEqual(unturned.readbackIssues.map((i) => i.problem), ["incomplete", "incomplete", "incomplete", "incomplete"]);
  assert.match(unturned.readbackIssues[0].missing!.join(), /an F record of 15 fields, not 16/);
});

test("integrity: a variant renamed in Figma is a name_mismatch, not scored", async () => {
  const result = await falsified("switch", ({ figma, built }) => {
    node(figma, built.variants[1].id).name = "size=small";
  });
  assert.deepEqual(result.readbackIssues.map((i) => [i.slug, i.problem, i.name, i.expected]), [["size-sm", "name_mismatch", "size=small", "size=sm"]]);
  assert.equal(result.variants[1].status, "unverified_readback");
});

test("integrity: a variant built from another snap is a caveat, and still scored", async () => {
  const result = await falsified("switch", ({ figma, built }) => {
    node(figma, built.variants[0].id).setSharedPluginData("storysync", "d", "00000000");
  });
  assert.equal(result.elementFidelity, 1);
  assert.deepEqual(result.caveats.filter((c) => c.kind === "built-from-other-measurement").map((c) => c.slugs), [["size-default"]]);
  // A snap since that changed only the root's paint, which its styles hold.
  const { fixture, readback } = await buildAndRead("switch");
  const resnap = JSON.parse(JSON.stringify(fixture)) as TreeFixture;
  resnap.components[0].base!.styles.backgroundColor = "#d4d4d4";
  const repainted = verify(resnap, readback, 0.5);
  assert.deepEqual(repainted.caveats.filter((c) => c.kind === "built-from-other-measurement").map((c) => c.slugs), [["size-default", "size-sm"]]);
});

test("integrity: a tree snap cut short says so, and lists what it left out as unscorable", async () => {
  const fixture = loadTreeFixture("switch");
  fixture.components[0].tree.truncated = { nodes: 2, at: "switch-thumb/after" };
  const { readback } = await buildAndRead(JSON.parse(JSON.stringify(fixture)) as TreeFixture);
  const result = verify(fixture, readback, 0.5);
  assert.deepEqual(result.caveats.filter((c) => c.kind === "truncated-tree").map((c) => [c.nodes, c.at]), [[2, "switch-thumb/after"]]);
  assert.deepEqual(result.unscorable!.filter((u) => u.property === "subtree").map((u) => [u.key, u.variants]), [["switch-thumb/after", 2]]);
  assert.equal(result.elementFidelity, 1);
});

test("integrity: two reads of an unchanged set differ only in readAt and checksum", async () => {
  const { figma, fixture, built, readback } = await buildAndRead("card");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = await reread(figma, fixture, built);
  const strip = (file: ReadbackFile) => JSON.stringify(file, (key, value) => (key === "readAt" || key === "checksum" ? undefined : value));
  assert.equal(strip(again), strip(readback));
  assert.notEqual(JSON.stringify(again), JSON.stringify(readback));
});

test("integrity: a readback from before trees, against a tree snap, scores roots alone and fails --strict", async () => {
  const { fixture, readback } = await buildAndRead("switch");
  const v1 = JSON.parse(JSON.stringify(readback)) as ReadbackFile;
  for (const entry of Object.values(v1.components)) {
    for (const [slug, e] of Object.entries(entry.variants)) {
      const { tpl: _t, name: _n, built: _b, tree: _tr, designerLayers: _d, boxShadow: _s, checksum: _c, ...rest } = e;
      entry.variants[slug] = { ...rest, checksum: readbackChecksum(entry.nodeId!, slug, rest) };
    }
  }
  const result = verify(fixture, v1, 0.5);
  assert.deepEqual(result.readbackIssues, []);
  assert.ok(result.variants.every((v) => v.childrenNotReadBack && v.status === "verified"));
  assert.equal(result.summary.elements!.notReadBack, 2);
  assert.deepEqual(treeStrictFailures(result), ["2 elements under roots read back without their tree"]);
});

test("integrity: placeholders for variants snap couldn't measure are listed as not measured, never scored", async () => {
  const { fixture, readback } = await buildAndRead("button-icon");
  const result = verify(fixture, readback, 0.5);
  assert.deepEqual(result.variants.filter((v) => v.status === "not_measured").map((v) => [v.slug, v.source]), [
    ["variant-link--size-xs", "unmeasured"], ["variant-link--size-sm", "unmeasured"],
  ]);
  assert.equal(result.summary.notMeasured, 2);
  assert.deepEqual(result.unmeasuredInFigma, []);
  assert.equal(result.elementFidelity, 1);
});

test("integrity: a variant missing from Figma costs every element snap measured in it", async () => {
  const result = await falsified("card", ({ figma, built }) => {
    node(figma, built.variants[1].id).remove();
  });
  assert.equal(result.variants[1].status, "missing_from_figma");
  near(result.elementFidelity, 50, "one of two Card variants missing");
  assert.equal(result.summary.elements!.missing, 23);
  // Its properties are all unmatched in the share of properties too.
  assert.equal(result.variants[1].mismatched, result.variants[0].matched);
});

test("unscorable: what can't be scored is listed with its reason, and never counted", async () => {
  const { fixture, readback } = await buildAndRead("card");
  const result = verify(fixture, readback, 0.5);
  const family = result.unscorable!.filter((u) => u.property === "family");
  assert.equal(family.length, 9, "each text node in system-ui, by key");
  assert.ok(family.every((u) => u.variants === 2 && /CSS keyword/.test(u.reason)));
  // Coverage: the properties scored over those and the ones listed, each
  // listed once a variant.
  const listed = result.unscorable!.reduce((n, u) => n + u.variants, 0);
  assert.equal(result.coverage, result.summary.propertiesCompared / (result.summary.propertiesCompared + listed));
  assert.ok(result.coverage! < 1 && result.coverage! > 0.9);
  assert.equal(result.elementFidelity, 1);
});

// --- What the spike settles: each fallback, switched on ---------------------------------

test("spike: where Figma re-encodes uploaded images, content is scored by the image's size, and bytes listed", async () => {
  const figma = newFigma({ reencodeImage: (bytes) => new Uint8Array([...bytes, 0]) });
  const { fixture, readback } = await buildAndRead("avatar", { figma });
  const exact = verify(fixture, readback, 0.5);
  assert.deepEqual(findings(exact), ["size-default avatar-image: content", "size-sm avatar-image: content", "size-lg avatar-image: content"]);
  const fallback = verify(fixture, readback, 0.5, { spike: { ...SPIKE, imageBytesKept: false } });
  assert.equal(fallback.elementFidelity, 1);
  assert.ok(fallback.unscorable!.some((u) => u.property === "content bytes"));
});

test("spike: an image not yet uploaded scores its node 0, by the content gate", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("avatar");
  const built = await buildFixture(figma, fixture);
  for (const v of built.variants) node(figma, v.layers["avatar-image"]).fills = [];
  const result = verify(fixture, await reread(figma, fixture, built), 0.5);
  assert.ok(result.variants.every((v) => v.nodes!.length === 1 && v.nodes![0].gate === "content"));
});

test("spike: where Figma drops a shadow's spread, spread is left out and listed", async () => {
  const ctx = await buildAndRead("inputotp");
  const slot = node(ctx.figma, ctx.built.variants[0].layers["input-otp-group/input-otp-slot"]);
  slot.effects = slot.effects.map((e: Record<string, unknown>) => ({ ...e, spread: 3 }));
  const readback = await reread(ctx.figma, ctx.fixture, ctx.built);
  assert.deepEqual(findings(verify(ctx.fixture, readback, 0.5)), ["default input-otp-group/input-otp-slot: effects"]);
  const fallback = verify(ctx.fixture, readback, 0.5, { spike: { ...SPIKE, shadowSpreadKept: false } });
  assert.equal(fallback.elementFidelity, 1);
  assert.ok(fallback.unscorable!.some((u) => u.property === "effects spread"));
});

test("spike: where Figma can't truncate text, truncation is left out and listed", async () => {
  const ctx = await buildAndRead("attachment");
  // As the build's fallback has it (SPIKE(3)): a box of the measured size, which Figma doesn't truncate.
  for (const v of ctx.built.variants) {
    const title = node(ctx.figma, v.layers["attachment-content/attachment-title"]);
    title.textAutoResize = "NONE";
    title.resize(title.width as number, 17.5);
  }
  const readback = await reread(ctx.figma, ctx.fixture, ctx.built);
  assert.ok(findings(verify(ctx.fixture, readback, 0.5)).every((f) => /attachment-title: truncation$/.test(f)));
  const fallback = verify(ctx.fixture, readback, 0.5, { spike: { ...SPIKE, textTruncation: false } });
  assert.equal(fallback.elementFidelity, 1);
});

// --- Facts read where snap wrote them as CSS -----------------------------------------

test("svg paints: each shape's fill and stroke as the browser paints it, the stroke width at the drawn size", () => {
  const toggle = loadTreeFixture("toggle").components[0].tree.assets.svg["svg:3a1614af"];
  assert.deepEqual(svgShapePaints(toggle), [{ fill: null, stroke: "#0a0a0a", strokeWidth: 1.33 }]);
  assert.deepEqual(svgShapePaints('<svg width="10" height="10"><g fill="#ff0000" fill-opacity="0.5"><rect width="4" height="4"/><circle r="1" fill="none" stroke="#00f"/></g><line x1="0" y1="0" x2="1" y2="1" stroke="#000"/></svg>'), [
    { fill: "#ff000080", stroke: null, strokeWidth: null },
    { fill: null, stroke: "#0000ff", strokeWidth: 1 },
    { fill: null, stroke: "#000000", strokeWidth: 1 },
  ]);
  assert.deepEqual(svgShapePaints('<svg width="8" height="8"><defs><path d="M0 0"/></defs><path d="M0 0" transform="scale(2)" stroke="#000"/></svg>'), [
    { fill: "#000000", stroke: "#000000", strokeWidth: null },
  ], "a shape in defs isn't painted there, and a scaled one's width is the matrix's");
  assert.equal(svgShapePaints('<svg><path d="M0 0" fill="red"/></svg>'), null, "a color that isn't hex is not guessed");
});

test("linear gradients: CSS angles, sides and corners, and stop positions as the readback encodes them", () => {
  assert.equal(cssLinearGradient("linear-gradient(90deg, #ff0000 0%, #0000ff 100%)", 100, 50), "lin:90:#ff0000@0,#0000ff@1");
  assert.equal(cssLinearGradient("linear-gradient(to bottom, #ff0000, #00ff0080, #0000ff)", 100, 50), "lin:180:#ff0000@0,#00ff0080@0.5,#0000ff@1");
  assert.equal(cssLinearGradient("linear-gradient(to top right, #000000 10px, #ffffff)", 100, 100), "lin:45:#000000@0.07,#ffffff@1");
  assert.equal(cssLinearGradient("radial-gradient(#000000, #ffffff)", 10, 10), null);
  assert.equal(cssLinearGradient("linear-gradient(90deg, red, blue)", 10, 10), null);
});

test("linear gradients: a gradient fill reads back at the angle and stops CSS gave it", async () => {
  const figma = newFigma();
  for (const [angle, w, h] of [[90, 120, 40], [180, 40, 120], [45, 80, 80], [135, 200, 50], [300, 60, 30]] as const) {
    const paint = linearGradientPaint(`lin:${angle}:#ff0000@0,#0000ff80@1`, w, h);
    const run = await figma.run(`const page = figma.root.children[0];
      const c = figma.createComponent(); c.resize(${w}, ${h}); c.name = '';
      c.fills = [${JSON.stringify(paint)}];
      for (const [k, v] of [['id', 'g${angle}'], ['slug', 'default'], ['i', '0'], ['src', 'measured']]) c.setSharedPluginData('storysync', k, v);
      return c.id;`);
    assert.ok(run.ok, run.text);
    const [result] = await readBack(figma, [[`g${angle}`, 0, 0, 0]], { page: "Page 1" });
    const fills = result.sets[0].entries.default.tree![0][6];
    assert.deepEqual(fills, [cssLinearGradient(`linear-gradient(${angle}deg, #ff0000 0%, #0000ff80 100%)`, w, h)], `${angle}deg in ${w}x${h}`);
  }
});

// --- One text in its holder, scored directly ----------------------------------

/**
 * A holder, the root, and one text in it, scored against Figma records of
 * the same boxes and settings as built: Figma's text `h` tall, cut off
 * after `maxLines` lines, and `cut` as the readback read it (undefined for
 * template 2's record, which has none).
 */
function scoreOne(holder: Partial<TreeNode>, text: TreeNode, figma: { h?: number; maxLines: number; cut: 0 | 1 | null | undefined }): TreeScore {
  const root: TreeNode = { k: "", t: "F", el: "div", box: [0, 0, 116, 20], ...holder };
  const tx = text.tx!;
  const F = ["", "F", 0, 0, root.box[2], root.box[3], [], null, 0, [], 1, "NORMAL", 1, 1, "1:1"];
  const T = [text.k, "T", text.box[0], text.box[1], text.box[2], figma.h ?? text.box[3], tx.c, tx.f, tx.wt, 0, tx.sz, tx.lh, 0, tx.col,
    "ORIGINAL", "NONE", "LEFT", "ENDING", figma.maxLines, "HEIGHT", 1, 1, "1:2", ...(figma.cut === undefined ? [] : [figma.cut])];
  const styles = { borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 }, boxShadow: [], opacity: 1 } as unknown as NormalizedStyles;
  return scoreTree({ nodes: [root, text], styles, assets: { svg: {}, img: {} }, records: [F, T], tolerance: 0.5 });
}

/** The text's differences on these properties, and why any of them went unscored. */
function textVerdict(result: TreeScore, key: string, properties: string[]) {
  return {
    differences: (result.nodes.find((n) => n.key === key)?.differences ?? []).filter((d) => properties.includes(d.property)),
    unscorable: result.unscorable.filter((u) => u.key === key).map((u) => u.property),
  };
}

test("kind gate: a layer of another kind is compared on what its own would be, and its kind, its turn once", () => {
  // A turned arrow out of the flow, which the build turns, and a turned
  // box with a child, which it doesn't: each read back as a text.
  const root: TreeNode = { k: "", t: "F", el: "div", box: [0, 0, 60, 40] };
  const styles = { borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 }, boxShadow: [], opacity: 1 } as unknown as NormalizedStyles;
  const F = (k: string, box: Box) => [k, "F", ...box, [], null, 0, [], 1, "NORMAL", 0, 1, `1:${k.length + 1}`, 0];
  const T = (k: string, box: Box) => [k, "T", ...box, "x", "Inter", 400, 0, 14, 20, 0, "#000000", "ORIGINAL", "NONE", "LEFT", "DISABLED", null, "WIDTH_AND_HEIGHT", 1, 1, `1:${k.length + 1}`, 0, 0];
  const arrow: TreeNode = { k: "arrow", t: "F", el: "div", box: [20, 10, 10, 10], abs: 1, tf: "rotate: 45deg" };
  const wrap: TreeNode = { k: "wrap", t: "F", el: "div", box: [0, 20, 20, 20], abs: 1, tf: "rotate: 90deg" };
  const dot: TreeNode = { k: "wrap/dot", t: "F", el: "span", box: [5, 5, 4, 4] };
  const compared = (arrowKind: typeof F, wrapKind: typeof F) => scoreTree({
    nodes: [root, arrow, wrap, dot], styles, assets: { svg: {}, img: {} }, tolerance: 0.5,
    records: [F("", root.box), arrowKind("arrow", [37.07, 15, 10, 10]), wrapKind("wrap", [20, 20, 20, 20]), F("wrap/dot", dot.box)],
  }).compared;
  const whole = compared(F, F);
  assert.equal(compared(T, F), whole + 1, "the turned arrow: its turn and box, its kind, and a frame's own properties");
  assert.equal(compared(F, T), whole + 1, "the box with a child: no turn, which it isn't scored on");
});

const LONG = "sales-dashboard-quarterly-report.pdf";

test("lines: a clamped text the browser and Figma both cut shows the clamp's lines in each, not the lines Chrome hides", () => {
  // Chrome lays out a clamp's hidden lines too: five line rects for a
  // paragraph clamped at two, which Figma, cutting it, shows two of.
  const text: TreeNode = { k: "p", t: "T", el: "p", box: [0, 0, 116, 40], tx: { c: LONG.repeat(4), f: "Inter", sz: 14, wt: 400, col: "#0a0a0a", lh: 20, cl: 2, n: 5, ink: [0, 2, 116, 96] } };
  assert.deepEqual(textVerdict(scoreOne({ box: [0, 0, 116, 40] }, text, { maxLines: 2, cut: 1 }), "p", ["lines", "truncation"]).differences, []);
  // One Figma shows three lines of, past the clamp, still drifts.
  assert.deepEqual(textVerdict(scoreOne({ box: [0, 0, 116, 40] }, text, { h: 60, maxLines: 2, cut: 1 }), "p", ["lines"]).differences, [{ property: "lines", measured: 2, figma: 3 }]);
});

test("truncation: an ellipsis on a run in a padded frame is measured against the frame's content box, not the run's own glyph box", () => {
  // A `truncate` div with 8px of padding stays a frame, and its run's box is
  // its glyphs': 227 wide where the browser cut it at 100 (Chrome: range
  // rects 227 wide, scrollWidth 243 against clientWidth 116).
  const run: TreeNode = { k: "#text", t: "T", el: "#text", box: [8, 0, 227, 20], tx: { c: LONG, f: "Inter", sz: 14, wt: 400, col: "#0a0a0a", lh: 20, el: 1, ws: "nowrap", n: 1, ink: [0, 2, 227, 16] } };
  const block: Partial<TreeNode> = { L: { d: "block", pad: [0, 8, 0, 8] }, clip: 1 };
  const truncation = (holder: Partial<TreeNode>, cut: 0 | 1) => textVerdict(scoreOne(holder, run, { maxLines: 1, cut }), "#text", ["truncation"]).differences;
  // Figma holding it whole, its frame clipping it, shows no ellipsis.
  assert.deepEqual(truncation(block, 0), [{ property: "truncation", measured: { maxLines: 1, cut: true }, figma: { truncation: "ENDING", maxLines: 1, cut: false } }]);
  assert.deepEqual(truncation(block, 1), []);
  // A border is inside the box too.
  assert.deepEqual(truncation({ ...block, L: { d: "block" }, bd: { w: [0, 8, 0, 8], s: "solid", c: "#000000" } }, 1), []);
  // A run that fits its content box was drawn whole.
  const fits: TreeNode = { ...run, box: [8, 0, 90, 20], tx: { ...run.tx!, ink: [0, 2, 90, 16] } };
  assert.deepEqual(textVerdict(scoreOne(block, fits, { maxLines: 1, cut: 0 }), "#text", ["truncation"]).differences, []);
  // In a flex container the run is an anonymous item text-overflow doesn't
  // reach: Chrome clips it with no ellipsis, as Figma's frame does.
  assert.deepEqual(truncation({ ...block, L: { d: "flex", pad: [0, 8, 0, 8] } }, 0), []);
  assert.deepEqual(truncation({ ...block, L: { d: "inline-grid", pad: [0, 8, 0, 8] } }, 1).map((d) => d.measured), [{ maxLines: 1, cut: false }]);
});

test("truncation: an input's value as wide as its box ran past it, and a pseudo-element's cut is unscored", () => {
  // snap caps a value's advance at its content box: the ink fills it.
  const value: TreeNode = { k: "#value", t: "T", el: "#value", box: [8, 0, 100, 20], tx: { c: LONG, f: "Inter", sz: 14, wt: 400, col: "#0a0a0a", lh: 20, el: 1, ws: "nowrap", n: 1, ink: [0, 0, 100, 20] } };
  const input: Partial<TreeNode> = { el: "input", L: { d: "inline-block", pad: [0, 8, 0, 8] } };
  assert.deepEqual(textVerdict(scoreOne(input, value, { maxLines: 1, cut: 1 }), "#value", ["truncation"]).differences, []);
  assert.deepEqual(textVerdict(scoreOne(input, value, { maxLines: 1, cut: 0 }), "#value", ["truncation"]).differences.map((d) => d.measured), [{ maxLines: 1, cut: true }]);
  const short: TreeNode = { ...value, tx: { ...value.tx!, c: "short", ink: [0, 0, 36.5, 20] } };
  assert.deepEqual(textVerdict(scoreOne(input, short, { maxLines: 1, cut: 0 }), "#value", ["truncation"]).differences, []);
  // A pseudo-element's text is measured as its box, whatever it holds.
  const after: TreeNode = { k: "::after", t: "T", el: "::after", box: [0, 0, 100, 20], tx: { ...value.tx!, ink: [0, 0, 100, 20] } };
  for (const cut of [0, 1] as const) {
    assert.deepEqual(textVerdict(scoreOne({}, after, { maxLines: 1, cut }), "::after", ["truncation"]), { differences: [], unscorable: ["cut"] });
  }
});

test("coverage: where the readback can't say whether Figma cuts a text, its cut is listed as unscorable, and truncation scored on the settings", () => {
  const title: TreeNode = { k: "title", t: "T", el: "span", box: [0, 0, 100, 20], tx: { c: LONG, f: "Inter", sz: 14, wt: 400, col: "#0a0a0a", lh: 20, el: 1, ws: "nowrap", n: 1, ink: [0, 2, 227, 16] } };
  // null: a font that won't load; undefined: template 2's record, with no cut.
  for (const cut of [null, undefined]) {
    assert.deepEqual(textVerdict(scoreOne({}, title, { maxLines: 1, cut }), "title", ["truncation"]), { differences: [], unscorable: ["cut"] }, String(cut));
  }
  for (const cut of [0, 1] as const) assert.deepEqual(textVerdict(scoreOne({}, title, { maxLines: 1, cut }), "title", ["truncation"]).unscorable, [], String(cut));
  // A text that doesn't truncate has no cut to read.
  const whole: TreeNode = { ...title, tx: { ...title.tx!, el: undefined, ink: [0, 2, 90, 16] } };
  assert.deepEqual(textVerdict(scoreOne({}, whole, { maxLines: 1, cut: null }), "title", ["truncation"]).unscorable, []);
});
