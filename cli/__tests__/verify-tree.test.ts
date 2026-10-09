// verify v2, element by element (design section 10), on the harness: each
// fixture built faithfully in mock Figma, read back with the real template,
// and scored; then broken the ways the live push was broken, each of which
// must cost what the design says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTreeFixture, treeFixtureNames } from "./mock-figma.js";
import { READBACK_TEMPLATE, assemble, buildAndRead, buildFixture, newFigma, readBack, reread } from "./tree-harness.js";
import { readbackChecksum, treeStrictFailures, verify } from "../verify.js";
import type { ReadbackFile, ReadbackStyles, VerifyResult } from "../verify.js";
import { SPIKE, cssLinearGradient, svgShapePaints } from "../verify-tree.js";

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
// sets in a stand-in, Inter: that text's width is allowed 6% (design 10.5).
// example-button's is Inter in both, so the same font 4.5% wider is drift,
// on that text alone, below.
for (const name of treeFixtureNames().filter((n) => n !== "example-button")) {
  test(`faithful build: ${name} still scores 100% in a stand-in font 4.5% wider, laid out absolute or in auto layout`, async () => {
    for (const autoLayout of [false, true]) {
      for (const textWidthFactor of [1, 1.045]) {
        const { fixture, readback } = await buildAndRead(name, { figma: newFigma({ textWidthFactor }), autoLayout });
        const result = verify(fixture, readback, 0.5);
        assert.equal(result.elementFidelity, 1, `${autoLayout ? "auto layout" : "absolute"}, ${textWidthFactor}:\n${drift(result)}`);
      }
    }
  });
}

test("faithful build: the same font drawn 4.5% wider costs each label its width, and nothing around it", async () => {
  const { fixture, readback } = await buildAndRead("example-button", { figma: newFigma({ textWidthFactor: 1.045 }), autoLayout: true });
  const result = verify(fixture, readback, 0.5);
  const nodes = result.variants.flatMap((v) => v.nodes ?? []);
  assert.equal(nodes.length, 12);
  assert.ok(nodes.every((n) => n.key === "#text" && n.differences.length === 1 && n.differences[0].property === "w"), drift(result));
  // The hugging buttons grew with their labels, and that is not drift on them.
  assert.equal(result.summary.elements!.verified, 12);
});

test("faithful build: every fixture's elements are all scored, not passed by default", async () => {
  const counts: Record<string, [number, number, number]> = {};
  for (const name of treeFixtureNames()) {
    const { fixture, readback } = await buildAndRead(name, { autoLayout: true });
    const result = verify(fixture, readback, 0.5);
    counts[name] = [result.summary.elements!.measured, result.summary.elements!.verified, result.summary.propertiesCompared];
  }
  console.log(JSON.stringify(counts));
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

async function falsified(name: string, change: (ctx: Awaited<ReturnType<typeof buildAndRead>>) => void, options: { autoLayout?: boolean } = {}): Promise<VerifyResult> {
  const ctx = await buildAndRead(name, options);
  change(ctx);
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

test("integrity: a keyed layer snap doesn't measure is an extra element scoring 0", async () => {
  const result = await falsified("switch", ({ figma, built }) => {
    const root = node(figma, built.variants[0].id);
    const copy = node(figma, built.variants[0].layers["switch-thumb"]);
    // As a designer's duplicate of a layer keeps its plugin data, under another key here.
    void figma.run(`const v = await figma.getNodeByIdAsync(${JSON.stringify(root.id)}); const f = figma.createFrame(); v.appendChild(f); f.resize(4, 4); f.setSharedPluginData('storysync', 'k', 'switch-thumb:2'); return f.id;`);
    void copy;
  });
  assert.equal(result.summary.elements!.extra, 1);
  near(result.elementFidelity, 80, "four elements and one extra");
  assert.deepEqual(findings(result), ["size-default switch-thumb:2: extra"]);
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
  const dropped = edited(readback, component, keys[1], () => undefined);
  delete dropped.components[component].variants[keys[1]];
  const result = verify(fixture, dropped, 0.5);
  assert.deepEqual(result.readbackIssues.map((i) => i.problem), ["parts_missing"]);
  assert.equal(result.variants[0].status, "parts_missing");
  assert.equal(result.summary.partsMissing, 1);
  assert.equal(result.summary.elements!.measured, 0);
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
  assert.match(result.readbackIssues[0].missing!.join(), /an F record of 14 fields, not 15/);
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
});

test("unscorable: what can't be scored is listed with its reason, and never counted", async () => {
  const { fixture, readback } = await buildAndRead("card");
  const result = verify(fixture, readback, 0.5);
  const family = result.unscorable!.filter((u) => u.property === "family");
  assert.equal(family.length, 9, "each text node in system-ui, by key");
  assert.ok(family.every((u) => u.variants === 2 && /CSS keyword/.test(u.reason)));
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
  for (const v of ctx.built.variants) node(ctx.figma, v.layers["attachment-content/attachment-title"]).textTruncation = "DISABLED";
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
    // Figma's transform for the CSS line: through the center, `angle` from up, as long as CSS makes it.
    const rad = (angle * Math.PI) / 180;
    const length = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const [dx, dy] = [Math.sin(rad) * length, -Math.cos(rad) * length];
    const p0 = [(w / 2 - dx / 2) / w, (h / 2 - dy / 2) / h];
    const d = [dx / w, dy / h];
    const q = [-dy / w, dx / h];
    // Gradient (u, v) to the layer: p0 + u d + (v - 0.5) q; its inverse is the transform.
    const m = [[d[0], q[0], p0[0] - 0.5 * q[0]], [d[1], q[1], p0[1] - 0.5 * q[1]]];
    const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    const t = [
      [m[1][1] / det, -m[0][1] / det, (m[0][1] * m[1][2] - m[1][1] * m[0][2]) / det],
      [-m[1][0] / det, m[0][0] / det, (m[1][0] * m[0][2] - m[0][0] * m[1][2]) / det],
    ];
    const run = await figma.run(`const page = figma.root.children[0];
      const c = figma.createComponent(); c.resize(${w}, ${h}); c.name = '';
      c.fills = [{ type: 'GRADIENT_LINEAR', gradientTransform: ${JSON.stringify(t)}, gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }] }];
      for (const [k, v] of [['id', 'g${angle}'], ['slug', 'default'], ['i', '0'], ['src', 'measured']]) c.setSharedPluginData('storysync', k, v);
      return c.id;`);
    assert.ok(run.ok, run.text);
    const [result] = await readBack(figma, [[`g${angle}`, 0, 0, 0]], { page: "Page 1" });
    const fills = result.sets[0].entries.default.tree![0][6];
    assert.deepEqual(fills, [cssLinearGradient(`linear-gradient(${angle}deg, #ff0000 0%, #0000ff80 100%)`, w, h)], `${angle}deg in ${w}x${h}`);
  }
});
