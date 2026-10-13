import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fnv1a32Bytes } from "../checksum.js";
import { verify } from "../verify.js";
import type { ReadbackFile } from "../verify.js";
import {
  CODE_LIMIT, FONTS, MockFigma, RESPONSE_LIMIT,
  estimateAdvance, figmaFonts, fixtureVariants, imageSize, loadTreeFixture, measureFromTrees, parseSvg, svgShapeBoxes, treeFixtureAsset,
} from "./mock-figma.js";
import type { MockFont, MockRun, NodeView } from "./mock-figma.js";

// The mock is what B's build, C's readback and D's end-to-end tests run
// plugin code against, so what it gets wrong they would pass on. These pin
// use_figma's limits, the Plugin API's refusals, the layout arithmetic, and
// that the skill's 0.4.0 templates run in it unchanged and verify at 100%.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Runs code that must succeed, returning its value. */
async function ok(figma: MockFigma, code: string): Promise<unknown> {
  const run = await figma.run(code);
  assert.ok(run.ok, `the call failed: ${run.text}`);
  return run.value;
}

/** Runs code that must fail, returning the tool's text. */
async function fails(figma: MockFigma, code: string): Promise<string> {
  const run = await figma.run(code);
  assert.equal(run.ok, false, `the call succeeded, returning ${run.text}`);
  return run.text;
}

// --- use_figma's limits ---------------------------------------------------------

test("limits: code of 50,000 characters runs, and 50,001 is refused before anything runs", async () => {
  const figma = new MockFigma();
  const pad = (n: number) => `figma.createFrame(); return 1; //${"x".repeat(n - "figma.createFrame(); return 1; //".length)}`;
  assert.equal(pad(CODE_LIMIT).length, 50_000);
  await ok(figma, pad(CODE_LIMIT));
  const refused = await figma.run(pad(CODE_LIMIT + 1));
  assert.equal(refused.ok, false);
  assert.match(refused.text, /50001 characters, more than 50000/);
  assert.equal(refused.created, 0);
  assert.equal(figma.nodes("FRAME").length, 1, "the refused call created nothing");
});

test("limits: a 20,000-byte response returns, and 20,001 bytes fails the call", async () => {
  const figma = new MockFigma();
  // A string of n characters is n + 2 bytes of JSON.
  const at = await figma.run(`return "${"x".repeat(RESPONSE_LIMIT - 2)}";`);
  assert.equal(at.ok, true);
  assert.equal(at.bytes, 20_000);
  const over = await figma.run(`return "${"x".repeat(RESPONSE_LIMIT - 1)}";`);
  assert.equal(over.ok, false);
  assert.equal(over.bytes, 20_001);
  assert.match(over.text, /20001 bytes exceeds the 20kb limit/);
  // Bytes, not characters: "·" is two bytes of UTF-8, so 10,000 of them pass the limit.
  assert.equal((await figma.run(`return "${"·".repeat(10_000)}";`)).bytes, 20_002);
  assert.equal((await figma.run(`return "${"·".repeat(10_000)}";`)).ok, false);
});

test("limits: one page switch per call; the sync setter throws; each call starts on the first page", async () => {
  const figma = new MockFigma({ pages: ["One", "Two", "Three"] });
  const twice = await fails(figma, `
    await figma.setCurrentPageAsync(figma.root.children[1]);
    await figma.setCurrentPageAsync(figma.root.children[2]);`);
  assert.match(twice, /switched page 2 times/);
  assert.match(await fails(figma, "figma.currentPage = figma.root.children[1];"), /Setting figma.currentPage is not supported/);
  await ok(figma, "await figma.setCurrentPageAsync(figma.root.children[1]); figma.createFrame();");
  assert.equal(await ok(figma, "return figma.currentPage.name;"), "One");
  // Another page's children are unreadable until it is loaded.
  assert.match(await fails(figma, "return figma.root.children[1].children.length;"), /has not been explicitly loaded/);
  assert.equal(await ok(figma, "const p = figma.root.children[1]; await p.loadAsync(); return p.children.length;"), 1);
  assert.equal(await ok(figma, "return figma.root.findAllWithCriteria({ types: ['FRAME'] }).length;"), 0, "a search from the root sees loaded pages only");
});

test("limits: what use_figma does not support throws", async () => {
  const figma = new MockFigma();
  for (const [code, message] of [
    ["figma.createImage(new Uint8Array(4));", /upload_assets/],
    ["await figma.createImageAsync('https://example.com/a.png');", /upload_assets/],
    ["figma.createFrame().setPluginData('k', 'v');", /setPluginData is not supported/],
    ["figma.notify('hi');", /not implemented/],
    ["await figma.loadAllPagesAsync();", /not implemented/],
    ["figma.getNodeById('0:1');", /getNodeByIdAsync/],
  ] as const) {
    assert.match(await fails(figma, code), message, code);
  }
});

test("limits: a failed call keeps what it changed before it threw, as Figma does", async () => {
  const figma = new MockFigma();
  await fails(figma, "figma.createFrame(); throw new Error('half way');");
  assert.equal(figma.nodes("FRAME").length, 1);
});

// --- Nodes as the Plugin API types them --------------------------------------------

test("nodes: a property the type lacks throws, and `in` says it is not there", async () => {
  const figma = new MockFigma();
  assert.match(await fails(figma, "const t = figma.createText(); return t.children;"), /no such property 'children' on TEXT node/);
  assert.match(await fails(figma, "figma.createFrame().characters = 'x';"), /no such property 'characters' on FRAME node/);
  const has = await ok(figma, `
    const t = figma.createText();
    const f = figma.createFrame();
    return ['children' in t, 'children' in f, 'characters' in t, 'layoutMode' in t];`);
  assert.deepEqual(has, [false, true, true, false]);
  assert.match(await fails(figma, "const f = figma.createFrame(); f.remove(); return f.name;"), /does not exist/);
  assert.equal(await ok(figma, "const f = figma.createFrame(); f.remove(); return f.removed;"), true);
});

test("nodes: paints are validated as Figma validates them, and handed out frozen", async () => {
  const figma = new MockFigma();
  assert.match(await fails(figma, "figma.createFrame().fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }];"), /Unrecognized key\(s\) in object: 'a'/);
  assert.match(await fails(figma, "figma.createFrame().fills = [{ type: 'SOLID', color: { r: 255, g: 0, b: 0 } }];"), /out of range/);
  const shadow = "{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 1 }, radius: 2, visible: true }";
  assert.match(await fails(figma, `figma.createFrame().effects = [${shadow}];`), /Required value missing at blendMode/);
  assert.match(await fails(figma, "figma.createFrame().layoutMode = 'ROW';"), /Expected 'NONE' \| 'HORIZONTAL' \| 'VERTICAL'/);
  assert.match(await fails(figma, "figma.createFrame().counterAxisSizingMode = 'FILL';"), /Expected 'FIXED' \| 'AUTO', received "FILL"/);
  const after = await ok(figma, `
    'use strict';
    const f = figma.createFrame();
    f.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }];
    let threw = false;
    try { f.fills[0].color.r = 0; } catch (e) { threw = true; }
    return { threw, paint: f.fills[0] };`);
  assert.deepEqual(after, { threw: true, paint: { type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 0.5, visible: true, blendMode: "NORMAL" } });
});

test("nodes: text writes need the font loaded in this call; a font Figma lacks will not load", async () => {
  const figma = new MockFigma();
  assert.match(await fails(figma, "figma.createText().characters = 'x';"), /Cannot write to node with unloaded font "Inter Regular"/);
  assert.match(await fails(figma, "await figma.loadFontAsync({ family: 'system-ui', style: 'Regular' });"), /could not be loaded/);
  assert.match(await fails(figma, "await figma.loadFontAsync({ family: 'Inter', style: 'SemiBold' });"), /"Inter SemiBold" could not be loaded/);
  const name = await ok(figma, `
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const t = figma.createText();
    t.characters = 'Close';
    return [t.name, t.fontWeight];`);
  assert.deepEqual(name, ["Close", 400], "a text node is named for its characters, as Figma names it");
  // Fonts load per call.
  const id = (figma.nodes("TEXT")[0]).id;
  assert.match(await fails(figma, `(await figma.getNodeByIdAsync('${id}')).characters = 'Open';`), /unloaded font/);
  assert.equal((await figma.run("return (await figma.listAvailableFontsAsync()).length;")).value, Object.values(FONTS).flat().length);
});

test("nodes: shared plugin data, and finding nodes by it or by type", async () => {
  const figma = new MockFigma();
  const found = await ok(figma, `
    const a = figma.createFrame(); a.setSharedPluginData('storysync', 'k', 'thumb');
    const b = figma.createFrame(); b.setSharedPluginData('storysync', 'svg', 'svg:1');
    const c = figma.createFrame(); c.setSharedPluginData('storysync', 'k', 'x'); c.setSharedPluginData('storysync', 'k', '');
    const page = figma.currentPage;
    return {
      k: page.findAllWithCriteria({ sharedPluginData: { namespace: 'storysync', keys: ['k'] } }).length,
      either: page.findAllWithCriteria({ sharedPluginData: { namespace: 'storysync', keys: ['k', 'svg'] } }).length,
      any: page.findAllWithCriteria({ sharedPluginData: { namespace: 'storysync' } }).length,
      frames: page.findAllWithCriteria({ types: ['FRAME'] }).length,
      read: [a.getSharedPluginData('storysync', 'k'), c.getSharedPluginData('storysync', 'k'), b.getSharedPluginDataKeys('storysync')],
    };`);
  assert.deepEqual(found, { k: 1, either: 2, any: 2, frames: 3, read: ["thumb", "", ["svg"]] });
  assert.match(await fails(figma, "figma.createFrame().setSharedPluginData('ss', 'k', 'v');"), /at least 3/);
  assert.match(await fails(figma, "figma.createFrame().setSharedPluginData('storysync', 'k', 3);"), /must be strings/);
});

test("nodes: clone() lands on the current page, with plugin data copied unless told otherwise", async () => {
  for (const clonePluginData of [true, false]) {
    const figma = new MockFigma({ clonePluginData });
    const result = await ok(figma, `
      const a = figma.createComponent(); a.name = 'size=a';
      const b = figma.createComponent(); b.name = 'size=b';
      const kid = figma.createFrame(); a.appendChild(kid); kid.setSharedPluginData('storysync', 'k', 'thumb');
      a.setSharedPluginData('storysync', 'slug', 'size-a');
      const set = figma.combineAsVariants([a, b], figma.currentPage);
      const copy = a.clone();
      return { parent: copy.parent.type, slug: copy.getSharedPluginData('storysync', 'slug'), k: copy.children[0].getSharedPluginData('storysync', 'k'),
        set: [set.type, set.children.length, Object.keys(set.componentPropertyDefinitions)], props: a.variantProperties, newId: copy.id !== a.id };`);
    assert.deepEqual(result, {
      parent: "PAGE", slug: clonePluginData ? "size-a" : "", k: clonePluginData ? "thumb" : "",
      set: ["COMPONENT_SET", 2, ["size"]], props: { size: "a" }, newId: true,
    });
  }
  const figma = new MockFigma();
  const combine = "const s = figma.combineAsVariants([figma.createComponent()], figma.currentPage);";
  assert.match(await fails(figma, `${combine} s.appendChild(figma.createFrame());`), /can only contain components/);
  assert.match(await fails(figma, `${combine} return s.children[0].componentPropertyDefinitions;`), /Can only get component property definitions of a component set/);
});

// --- Auto layout ------------------------------------------------------------------

/** Builds an auto-layout frame of `kids` (width, height) in one call and returns every box. */
async function layout(setup: string, kids: [number, number][], after = ""): Promise<{ frame: number[]; kids: number[][] }> {
  const figma = new MockFigma();
  return (await ok(figma, `
    const f = figma.createFrame();
    f.fills = [];
    ${setup}
    const kids = ${JSON.stringify(kids)}.map(([w, h]) => { const k = figma.createFrame(); k.resize(w, h); f.appendChild(k); return k; });
    ${after}
    return { frame: [f.width, f.height], kids: kids.map((k) => [k.x, k.y, k.width, k.height]) };`)) as { frame: number[]; kids: number[][] };
}

const HUG = "f.layoutMode = 'HORIZONTAL'; f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO';";
const PAD = "f.paddingTop = 8; f.paddingRight = 12; f.paddingBottom = 8; f.paddingLeft = 12; f.itemSpacing = 6;";

test("auto layout: a hugging row places children in order from its padding, itemSpacing apart", async () => {
  assert.deepEqual(await layout(`${HUG} ${PAD}`, [[20, 10], [30, 16]]), { frame: [80, 32], kids: [[12, 8, 20, 10], [38, 8, 30, 16]] });
  assert.deepEqual(await layout(`${HUG} ${PAD} f.counterAxisAlignItems = 'CENTER';`, [[20, 10], [30, 16]]), { frame: [80, 32], kids: [[12, 11, 20, 10], [38, 8, 30, 16]] });
  assert.deepEqual(await layout(`${HUG} ${PAD} f.counterAxisAlignItems = 'MAX';`, [[20, 10], [30, 16]]), { frame: [80, 32], kids: [[12, 14, 20, 10], [38, 8, 30, 16]] });
  // A column runs down.
  assert.deepEqual(await layout(`f.layoutMode = 'VERTICAL'; f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO'; ${PAD}`, [[20, 10], [30, 16]]),
    { frame: [54, 48], kids: [[12, 8, 20, 10], [12, 24, 30, 16]] });
});

test("auto layout: a fixed row packs its children at the start, center or end, or spreads them", async () => {
  const fixed = "f.layoutMode = 'HORIZONTAL'; f.resize(200, 40); f.itemSpacing = 10; f.paddingLeft = 10; f.paddingRight = 10;";
  const kids: [number, number][] = [[20, 10], [30, 10]];
  assert.deepEqual((await layout(`${fixed} f.primaryAxisAlignItems = 'MIN';`, kids)).kids.map((k) => k[0]), [10, 40]);
  assert.deepEqual((await layout(`${fixed} f.primaryAxisAlignItems = 'CENTER';`, kids)).kids.map((k) => k[0]), [70, 100]);
  assert.deepEqual((await layout(`${fixed} f.primaryAxisAlignItems = 'MAX';`, kids)).kids.map((k) => k[0]), [130, 160]);
  // SPACE_BETWEEN ignores itemSpacing.
  assert.deepEqual((await layout(`${fixed} f.primaryAxisAlignItems = 'SPACE_BETWEEN';`, kids)).kids.map((k) => k[0]), [10, 160]);
  assert.deepEqual((await layout(fixed, kids)).frame, [200, 40], "a fixed frame keeps its size");
});

test("auto layout: FILL takes the room left along the flow and the whole room across it", async () => {
  const row = await layout("f.layoutMode = 'HORIZONTAL'; f.resize(200, 50); f.paddingLeft = 10; f.paddingRight = 10; f.itemSpacing = 5; f.paddingTop = 5; f.paddingBottom = 5;",
    [[20, 10], [30, 10]], "kids[1].layoutSizingHorizontal = 'FILL'; kids[0].layoutSizingVertical = 'FILL';");
  assert.deepEqual(row.kids, [[10, 5, 20, 40], [35, 5, 155, 10]]);
  // In a hugging frame, a stretched child takes the size the others give, as
  // the spike saw (item 11, fillAcross).
  const hug = await layout(`${HUG}`, [[20, 30], [10, 10]], "kids[1].layoutAlign = 'STRETCH';");
  assert.deepEqual(hug, { frame: [30, 30], kids: [[0, 0, 20, 30], [20, 0, 10, 30]] });
  const reads = await ok(new MockFigma(), `
    const f = figma.createFrame(); f.layoutMode = 'HORIZONTAL'; f.primaryAxisSizingMode = 'FIXED';
    const k = figma.createFrame(); f.appendChild(k); k.layoutSizingHorizontal = 'FILL';
    const g = figma.createFrame(); f.appendChild(g); g.layoutMode = 'VERTICAL'; g.layoutSizingVertical = 'HUG';
    return [k.layoutSizingHorizontal, k.layoutSizingVertical, g.layoutSizingVertical, f.layoutSizingHorizontal];`);
  assert.deepEqual(reads, ["FILL", "FIXED", "HUG", "FIXED"]);
});

// Sidebar's sidebar-inner as section 8.4.7 would build it: hugging 16 + 688 + 16, its content growing.
const SIDEBAR = `
  const p = figma.createAutoLayout('VERTICAL'); p.name = 'sidebar-inner';
  const kid = (h) => { const k = figma.createFrame(); k.resize(100, h); p.appendChild(k); return k; };
  const [a, b, c] = [kid(16), kid(688), kid(16)];`;

test("auto layout: a child filling or growing along a hugging parent keeps its size, and the parent hugs it", async () => {
  // As the spike saw (item 11, fillAlong and growAlong): the column hugs 720, the child keeps its 688.
  const read = "return [p.height, p.layoutSizingVertical, p.children.map((k) => [k.y, k.height, k.layoutSizingVertical])];";
  const want = [720, "HUG", [[0, 16, "FIXED"], [16, 688, "FILL"], [704, 16, "FIXED"]]];
  assert.deepEqual(await ok(new MockFigma(), `${SIDEBAR} b.layoutSizingVertical = 'FILL'; ${read}`), want);
  assert.deepEqual(await ok(new MockFigma(), `${SIDEBAR} b.layoutGrow = 1; ${read}`), want);
  // Fixed, the column gives it the room the others leave.
  const fixed = await ok(new MockFigma(), `${SIDEBAR} b.layoutGrow = 1; p.primaryAxisSizingMode = 'FIXED'; p.resize(100, 800); ${read}`);
  assert.deepEqual(fixed, [800, "FIXED", [[0, 16, "FIXED"], [16, 768, "FILL"], [784, 16, "FIXED"]]]);
  // Across a hugging parent it stretches, unless the test refuses that too.
  const across = `${SIDEBAR} b.layoutSizingHorizontal = 'FILL'; a.resize(120, 16); return [p.width, b.width];`;
  assert.deepEqual(await ok(new MockFigma(), across), [120, 120]);
  assert.match(await fails(new MockFigma({ fillAcrossHug: "refuse" }), across), /mock-figma: FILL across a parent that hugs that axis is not modeled/);
});

test("auto layout: FILL turns a hugging label to HEIGHT; any other fill of a text that sizes itself is refused", async () => {
  const text = (setup: string, fixed = true) => `
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const p = figma.createAutoLayout('HORIZONTAL'); ${fixed ? "p.resize(300, 40);" : ""} p.paddingLeft = 10; p.paddingRight = 10;
    const t = figma.createText(); t.characters = 'hello'; p.appendChild(t);
    ${setup}
    return [t.width, t.textAutoResize, t.layoutSizingHorizontal];`;
  const ignored = /mock-figma: FILL on a text node that sizes itself on that axis is not modeled .*set textAutoResize to HEIGHT/;
  // As the spike saw (item 11, textInFixedRow and textInHuggingRow): it fills a fixed row, and keeps its width in a hugging one.
  const measure = { advance: (chars: string) => (chars === "hello" ? 27 : 0) };
  assert.deepEqual(await ok(new MockFigma({ measure }), text("t.layoutSizingHorizontal = 'FILL';")), [280, "HEIGHT", "FILL"]);
  assert.deepEqual(await ok(new MockFigma({ measure }), text("t.layoutSizingHorizontal = 'FILL';", false)), [27, "HEIGHT", "FILL"]);
  assert.deepEqual(await ok(new MockFigma(), text("t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';")), [280, "HEIGHT", "FILL"]);
  // layoutGrow alone the spike didn't try.
  assert.match(await fails(new MockFigma(), text("t.layoutGrow = 1;")), ignored);
  // Its height, too, while it hugs it.
  const column = `
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const p = figma.createAutoLayout('VERTICAL'); p.resize(300, 200);
    const t = figma.createText(); t.characters = 'hello'; p.appendChild(t); t.textAutoResize = 'HEIGHT';
    t.layoutGrow = 1;`;
  assert.match(await fails(new MockFigma(), column), ignored);
  assert.deepEqual(await ok(new MockFigma(), `${column} t.textAutoResize = 'NONE'; return t.height;`), 200);
});

test("auto layout: sizing values only where Figma allows them, with its errors", async () => {
  const figma = new MockFigma();
  const plain = "const f = figma.createFrame(); const k = figma.createFrame(); f.appendChild(k);";
  const auto = "const f = figma.createFrame(); f.layoutMode = 'HORIZONTAL'; const k = figma.createRectangle(); f.appendChild(k);";
  assert.match(await fails(figma, `${plain} k.layoutSizingHorizontal = 'FILL';`), /FILL can only be set on children of auto-layout frames/);
  assert.match(await fails(figma, `${auto} k.layoutSizingHorizontal = 'HUG';`), /HUG can only be set on auto-layout frames or text children/);
  assert.match(await fails(figma, "figma.createFrame().layoutSizingVertical = 'HUG';"), /node must be an auto-layout frame or a child of an auto-layout frame/);
  assert.match(await fails(figma, `${auto} k.layoutPositioning = 'ABSOLUTE'; k.layoutSizingHorizontal = 'FILL';`), /absolute positioned/);
});

test("auto layout: an ABSOLUTE child keeps its place and takes no space; a hidden one takes none either", async () => {
  const result = await layout(`${HUG} f.itemSpacing = 4;`, [[20, 20], [5, 5], [10, 10], [7, 7]], `
    kids[1].layoutPositioning = 'ABSOLUTE'; kids[1].x = 3; kids[1].y = 4;
    kids[3].visible = false;`);
  assert.deepEqual(result.frame, [34, 20]);
  assert.deepEqual(result.kids.slice(0, 3), [[0, 0, 20, 20], [3, 4, 5, 5], [24, 0, 10, 10]]);
  // Moving a child in flow does nothing, as in Figma.
  assert.deepEqual((await layout(HUG, [[20, 20]], "kids[0].x = 50;")).kids[0], [0, 0, 20, 20]);
});

test("auto layout: strokes included in layout inset the children by the frame's own stroke, when INSIDE", async () => {
  const stroke = "f.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; f.strokeWeight = 2;";
  assert.deepEqual(await layout(`${HUG} ${stroke} f.strokesIncludedInLayout = true;`, [[20, 10]]), { frame: [24, 14], kids: [[2, 2, 20, 10]] });
  // Only an INSIDE stroke takes room, as the spike saw (item 4).
  assert.deepEqual(await layout(`${HUG} ${stroke} f.strokesIncludedInLayout = true; f.strokeAlign = 'CENTER';`, [[20, 10]]), { frame: [20, 10], kids: [[0, 0, 20, 10]] });
  assert.deepEqual(await layout(`${HUG} ${stroke} f.strokesIncludedInLayout = true; f.strokeAlign = 'OUTSIDE';`, [[20, 10]]), { frame: [20, 10], kids: [[0, 0, 20, 10]] });
  assert.deepEqual(await layout(`${HUG} ${stroke}`, [[20, 10]]), { frame: [20, 10], kids: [[0, 0, 20, 10]] }, "excluded, the stroke overlaps them");
});

test("auto layout: resize() fixes a hugging frame's size; resizeWithoutConstraints leaves children alone", async () => {
  assert.deepEqual(await layout(HUG, [[20, 10]], "f.resize(100, 50);"), { frame: [100, 50], kids: [[0, 0, 20, 10]] });
  const result = await ok(new MockFigma(), `
    const f = figma.createFrame(); f.resize(100, 100);
    const a = figma.createFrame(); a.resize(10, 10); a.x = 80; f.appendChild(a); a.constraints = { horizontal: 'MAX', vertical: 'SCALE' };
    f.resize(200, 50);
    const g = figma.createFrame(); g.resize(100, 100);
    const b = figma.createFrame(); b.resize(10, 10); b.x = 80; g.appendChild(b); b.constraints = { horizontal: 'MAX', vertical: 'MIN' };
    g.resizeWithoutConstraints(200, 200);
    return [[a.x, a.y, a.width, a.height], [b.x, b.width], f.primaryAxisSizingMode];`);
  assert.deepEqual(result, [[180, 0, 10, 5], [80, 10], "AUTO"]);
});

test("auto layout: createAutoLayout hugs both axes; set() applies layoutMode first and resizes through resize()", async () => {
  const result = await ok(new MockFigma(), `
    const f = figma.createAutoLayout('VERTICAL', { name: 'Column', itemSpacing: 4 });
    const a = figma.createFrame(); a.resize(10, 10); f.appendChild(a);
    const b = figma.createFrame(); b.resize(20, 5); f.appendChild(b);
    const g = figma.createFrame().set({ width: 30, layoutMode: 'HORIZONTAL', paddingLeft: 3 });
    g.x = 100; g.y = 50;
    const inner = figma.createFrame(); inner.resize(4, 4); g.appendChild(inner);
    return { f: [f.name, f.width, f.height, f.layoutSizingHorizontal, f.fills.length], g: [g.width, g.height, g.primaryAxisSizingMode],
      abs: inner.absoluteBoundingBox, transform: inner.absoluteTransform };`);
  assert.deepEqual(result, {
    f: ["Column", 20, 19, "HUG", 0], g: [30, 100, "FIXED"],
    abs: { x: 103, y: 50, width: 4, height: 4 }, transform: [[1, 0, 103], [0, 1, 50]],
  });
});

// --- Text ------------------------------------------------------------------------

const TEXT_SETUP = (resize: string) => `
  await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
  const t = figma.createText();
  t.fontName = { family: 'Inter', style: 'Medium' };
  t.fontSize = 14;
  t.lineHeight = { unit: 'PIXELS', value: 20 };
  t.characters = 'Login with Email Button';
  ${resize}
  return [t.width, t.height, t.textAutoResize];`;

test("text: a hugging label is as wide as the measure says, rounded up to a whole pixel as Figma rounds it", async () => {
  const measure = { advance: (chars: string) => (chars === "Login with Email Button" ? 154.8 : 0) };
  assert.deepEqual(await ok(new MockFigma({ measure }), TEXT_SETUP("")), [155, 20, "WIDTH_AND_HEIGHT"]);
  // Figma's Inter Medium, as the spike and the text probe saw it set: 157.13 wide, 158 rounded up.
  assert.deepEqual(await ok(new MockFigma(), TEXT_SETUP("")), [158, 20, "WIDTH_AND_HEIGHT"]);
  // AUTO line height is the font's own, taken as 1.21em, to a whole pixel: 17 at 14px, as the spike's label came out.
  assert.deepEqual(await ok(new MockFigma({ measure }), TEXT_SETUP("t.lineHeight = { unit: 'AUTO' };")), [155, 17, "WIDTH_AND_HEIGHT"]);
});

test("text: a fixed width wraps by words and grows in height; ENDING with maxLines stops at that many", async () => {
  const measure = { advance: (chars: string) => chars.length * 7 };
  const wrapped = await ok(new MockFigma({ measure }), TEXT_SETUP("t.textAutoResize = 'HEIGHT'; t.resize(70, 20);"));
  assert.deepEqual(wrapped, [70, 60, "HEIGHT"], "'Login with' 'Email' 'Button': three lines of 10 characters or fewer");
  const truncated = await ok(new MockFigma({ measure }), TEXT_SETUP("t.textAutoResize = 'HEIGHT'; t.resize(70, 20); t.textTruncation = 'ENDING'; t.maxLines = 1;"));
  assert.deepEqual(truncated, [70, 20, "HEIGHT"]);
  // resize() on a hugging label fixes it, as the spike saw (item 3): a label meant to hug is never resized.
  assert.deepEqual(await ok(new MockFigma({ measure }), TEXT_SETUP("t.resize(50, 20);")), [50, 20, "NONE"]);
});

test("text: measureFromTrees learns each label's width from snap's ink boxes", () => {
  const nodes = fixtureVariants(loadTreeFixture("card"))[0].nodes;
  const measure = measureFromTrees([nodes]);
  const font = { family: "Inter", style: "Medium", size: 16, letterSpacing: 0 };
  assert.equal(measure.advance("Notifications", font), 94.17);
  assert.equal(measure.advance("Notifications", { ...font, style: "Regular" }), estimateAdvance("Notifications", { ...font, style: "Regular" }), "another weight is another text");
  assert.equal(measure.advance("unknown", font), estimateAdvance("unknown", font));
  const wrapped = measureFromTrees([[{
    k: "p", t: "T", el: "p", box: [0, 0, 100, 40],
    tx: { c: "two lines", f: "system-ui", sz: 14, wt: 400, col: null, lh: 20, n: 2, ink: [0, 0, 90, 34] },
  }]]);
  assert.equal(wrapped.lines!("two lines", { ...font, size: 14, style: "Regular" }, 100), 2);
  assert.equal(wrapped.lines!("two lines", { ...font, size: 14, style: "Regular" }, 300), undefined);
});

// --- SVG --------------------------------------------------------------------------

test("svg: shape boxes are the geometry's exact bounds, arcs and curves included", () => {
  // lucide Bell's clapper, an arc, and its right sound wave, a curve: as Chrome measures them.
  const bell = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M22 8c0-2.3-.8-4.3-2-6"/></svg>';
  assert.deepEqual(svgShapeBoxes(bell), [[10.27, 21, 3.46, 1], [20, 2, 2, 6]]);
  const basic = '<svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/>'
    + '<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="0" y1="0" x2="24" y2="0"/></svg>';
  assert.deepEqual(svgShapeBoxes(basic), [[1, 1, 10, 10], [1, 2, 10, 8], [0, 0, 12, 0]]);
  // A viewBox of another aspect is fitted and centered, as xMidYMid meet does.
  assert.deepEqual(svgShapeBoxes('<svg width="20" height="10" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10"/></svg>'), [[5, 0, 10, 10]]);
  // A group's transform is applied to its shapes, and the shapes say which group holds them.
  assert.deepEqual(svgShapeBoxes('<svg width="10" height="10"><g transform="translate(2 3)"><rect width="4" height="4"/></g></svg>'), [[2, 3, 4, 4]]);
  const grouped = parseSvg('<svg width="10" height="10"><g opacity="0.5"><g><rect width="4" height="4" opacity="0.8"/></g></g><circle r="1"/></svg>');
  assert.deepEqual([grouped.groups, grouped.shapes.map((sh) => [sh.groups, sh.opacity])], [[{ opacity: 0.5 }, { opacity: 1 }], [[[0, 1], 0.8], [[], 1]]]);
  const parsed = parseSvg('<svg width="16" height="16" viewBox="0 0 24 24" stroke="#0a0a0a" stroke-width="2" fill="none"><path d="M0 0L24 24"/><defs/></svg>');
  assert.deepEqual([Math.round(parsed.shapes[0].strokeWidth * 1000) / 1000, parsed.shapes[0].fill, parsed.dropped], [1.333, null, ["defs"]]);
  assert.throws(() => parseSvg('<svg><path d="M0 0" fill="oklch(0.5 0 0)"/></svg>'), /not hex/);
});

test("svg: every fixture icon's shapes come out where Chrome measured them", () => {
  for (const name of ["card", "toggle", "button-icon", "attachment", "sidebar"]) {
    const fixture = loadTreeFixture(name);
    const { svg } = fixture.components[0].tree.assets;
    for (const { nodes } of fixtureVariants(fixture)) {
      for (const node of nodes.filter((n) => n.t === "V")) {
        const computed = svgShapeBoxes(svg[node.svg!]);
        assert.equal(computed.length, node.shapes!.length, `${name} ${node.k}`);
        computed.forEach((box, i) => box.forEach((v, j) => assert.ok(Math.abs(v - node.shapes![i][j]) <= 0.02, `${name} ${node.k} shape ${i}: ${box} against ${node.shapes![i]}`)));
      }
    }
  }
});

test("svg: createNodeFromSvg builds a frame of the shapes, strokes scaled to the size or not", async () => {
  const markup = Object.values(loadTreeFixture("button-icon").components[0].tree.assets.svg)[0];
  const read = `const f = figma.createNodeFromSvg(${JSON.stringify(markup)});
    return {
      frame: [f.type, f.width, f.height, f.fills.length, f.clipsContent],
      kids: f.children.map((c) => [c.type, c.x, c.y, c.width, c.height, c.strokeWeight, c.strokes.length, c.fills.length, c.strokeAlign]),
    };`;
  // As the spike saw lucide Mail come in (item 1): a clipping frame with a fill, a rect as a VECTOR.
  assert.deepEqual(await ok(new MockFigma(), read), {
    frame: ["FRAME", 16, 16, 1, true],
    kids: [["VECTOR", 1.33, 4.67, 13.33, 4, 1.33, 1, 0, "CENTER"], ["VECTOR", 1.33, 2.67, 13.33, 10.67, 1.33, 1, 0, "CENTER"]],
  });
  const unscaled = (await ok(new MockFigma({ svgStrokeScales: false }), read)) as { kids: unknown[][] };
  assert.deepEqual(unscaled.kids.map((k) => k[5]), [2, 2]);
  // Imported at the viewBox's size and rescaled, the strokes scale with it.
  const rescaled = await ok(new MockFigma({ svgStrokeScales: false }), `
    const f = figma.createNodeFromSvg(${JSON.stringify(markup.replace('width="16" height="16"', 'width="24" height="24"'))});
    f.rescale(16 / 24);
    return f.children.map((c) => [c.x, c.y, c.width, c.height, Math.round(c.strokeWeight * 100) / 100]);`);
  assert.deepEqual(rescaled, [[1.33, 4.67, 13.33, 4, 1.33], [1.33, 2.67, 13.33, 10.67, 1.33]]);
  // resize() scales the shapes by their SCALE constraints, not their strokes.
  const resized = await ok(new MockFigma({ svgStrokeScales: false }), `
    const f = figma.createNodeFromSvg(${JSON.stringify(markup.replace('width="16" height="16"', 'width="24" height="24"'))});
    f.resize(16, 16);
    return f.children.map((c) => [c.width, c.strokeWeight]);`);
  assert.deepEqual(resized, [[13.33, 2], [13.33, 2]]);
});

test("svg: a <g> comes in as a GROUP, whose shapes keep the frame's coordinates", async () => {
  // As the spike saw (item 1): a group of the import's own. Its box is what its shapes cover.
  const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
    + '<g opacity="0.5" transform="translate(4 2)"><circle cx="4" cy="4" r="3"/><rect x="10" y="10" width="4" height="8"/></g><path d="M0 0L2 2"/></svg>';
  const figma = new MockFigma();
  const read = `const at = figma.createFrame(); at.x = 100; at.y = 50;
    const f = figma.createNodeFromSvg(${JSON.stringify(markup)}); at.appendChild(f); f.x = 10; f.y = 20;
    const g = f.children[0];
    const box = (n) => [n.x, n.y, n.width, n.height];
    const abs = (n) => { const b = n.absoluteBoundingBox; return [b.x, b.y]; };
    const before = { kids: f.children.map((c) => c.type), group: [...box(g), g.opacity, 'fills' in g], shapes: g.children.map(box), abs: g.children.map(abs) };
    g.x += 2;
    const moved = g.children.map(box);
    f.rescale(0.5);
    return { before, moved, rescaled: [box(g), ...g.children.map(box)], found: f.findAll((n) => /VECTOR|ELLIPSE/.test(n.type)).length };`;
  assert.deepEqual(await ok(figma, read), {
    before: {
      kids: ["GROUP", "VECTOR"],
      group: [5, 3, 13, 17, 0.5, false],
      shapes: [[5, 3, 6, 6], [14, 12, 4, 8]],
      abs: [[115, 73], [124, 82]],
    },
    moved: [[7, 3, 6, 6], [16, 12, 4, 8]],
    rescaled: [[3.5, 1.5, 6.5, 8.5], [3.5, 1.5, 3, 3], [8, 6, 2, 4]],
    found: 3,
  });
  // A group its last shape leaves goes with it, as Figma never keeps an empty one.
  const emptied = await ok(figma, `
    const f = figma.currentPage.findOne((n) => n.name === 'svg');
    const g = f.children[0];
    for (const c of [...g.children]) c.remove();
    return [g.removed, f.children.map((c) => c.type)];`);
  assert.deepEqual(emptied, [true, ["VECTOR"]]);
});

// --- Images and variables ---------------------------------------------------------

test("images: an upload fills the node; its hash is the bytes' SHA-1 and its bytes and size read back", async () => {
  const [asset] = Object.values(loadTreeFixture("avatar").components[0].tree.assets.img);
  const bytes = treeFixtureAsset(asset.file);
  const figma = new MockFigma();
  const id = (await ok(figma, "const f = figma.createFrame(); f.fills = []; return f.id;")) as string;
  const [{ imageHash }] = figma.uploadAssets([id], [bytes]);
  assert.equal(imageHash, createHash("sha1").update(bytes).digest("hex"));
  const read = await ok(figma, `
    const node = await figma.getNodeByIdAsync('${id}');
    const paint = node.fills[0];
    const image = figma.getImageByHash(paint.imageHash);
    const got = await image.getBytesAsync();
    let h = 0x811c9dc5; for (const b of got) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    const copy = figma.createFrame(); copy.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: paint.imageHash }];
    return {
      scaleMode: paint.scaleMode, fnv: h.toString(16).padStart(8, '0'), length: got.length, size: await image.getSizeAsync(),
      reused: copy.fills[0].imageHash === paint.imageHash, none: figma.getImageByHash('nope'),
    };`);
  assert.deepEqual(read, { scaleMode: "FILL", fnv: asset.fnv, length: bytes.length, size: { width: 80, height: 80 }, reused: true, none: null });
  assert.equal(fnv1a32Bytes(bytes), asset.fnv);
  // A Figma that re-encodes uploads changes the bytes, and with them the fnv.
  const reencoding = new MockFigma({ reencodeImage: (b) => Uint8Array.from([...b, 0]) });
  const other = (await ok(reencoding, "return figma.createFrame().id;")) as string;
  reencoding.uploadAssets([other], [bytes]);
  const stored = await ok(reencoding, `
    const n = await figma.getNodeByIdAsync('${other}');
    return (await figma.getImageByHash(n.fills[0].imageHash).getBytesAsync()).length;`);
  assert.notEqual(stored, bytes.length);
  // A PNG's size is in its IHDR chunk.
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2];
  assert.deepEqual(imageSize(Uint8Array.from(png)), { width: 2, height: 3 });
});

test("variables: a paint bound afresh takes the variable's alpha as its opacity; rebound, it keeps its own", async () => {
  const figma = new MockFigma();
  const { id } = figma.addVariable("destructive", "COLOR", "#df22254d");
  const radius = figma.addVariable("radius/lg", "FLOAT", 10);
  const result = await ok(figma, `
    const v = await figma.variables.getVariableByIdAsync('${id}');
    const f = figma.createFrame();
    f.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }, 'color', v)];
    const fresh = f.fills[0].opacity;
    f.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }, 'color', v)];
    const again = f.fills[0].opacity;
    f.setBoundVariable('topLeftRadius', await figma.variables.getVariableByIdAsync('${radius.id}'));
    const locals = await figma.variables.getLocalVariablesAsync('COLOR');
    return {
      fresh: Math.round(fresh * 1000) / 1000, again, color: f.fills[0].color.r > 0.87,
      radius: f.topLeftRadius, bound: f.boundVariables.topLeftRadius.id, names: locals.map((l) => l.name),
    };`);
  assert.deepEqual(result, { fresh: 0.302, again: 1, color: true, radius: 10, bound: radius.id, names: ["destructive"] });
});

// --- The 0.4.0 skill templates, unchanged -----------------------------------------------

const SKILL = readFileSync(`${ROOT}skills/claude-code.md`, "utf8");

/** Every use_figma code block in the shipped skill, as scripts/acceptance.mjs extracts them. */
function skillBlocks(): { code: string; description: string }[] {
  const blocks: { code: string; description: string }[] = [];
  let at = 0;
  while ((at = SKILL.indexOf("code: `", at)) >= 0) {
    const start = at + "code: `".length;
    const end = SKILL.indexOf("`,", start);
    blocks.push({ code: SKILL.slice(start, end), description: /description: "([^"]*)"/.exec(SKILL.slice(end, end + 400))?.[1] ?? "" });
    at = end;
  }
  return blocks;
}

const constant = (name: string) => new RegExp(`const ${name} = [^;\\n]*;`);
function withConstants(code: string, values: Record<string, unknown>): string {
  let out = code;
  for (const [name, value] of Object.entries(values)) {
    assert.match(out, constant(name), `the template defines no ${name}`);
    out = out.replace(constant(name), () => `const ${name} = ${JSON.stringify(value)};`);
  }
  return out;
}
const table = (name: string, open: string, close: string) => new RegExp(`const ${name} = \\${open}[\\s\\S]*?\\n\\s*\\${close};`);

/**
 * An agent's applyStyles for the example Button, as the skill's step 3 table
 * maps measured values: auto layout from display and padding, fills and
 * strokes through the template's setPaints, the label through its loadFont.
 */
const APPLY_STYLES = `const applyStyles = async (variant, styles) => {
      const paintOf = (hex) => {
        const n = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
        return { type: 'SOLID', color: { r: n(1), g: n(3), b: n(5) }, opacity: hex.length > 7 ? n(7) : 1 };
      };
      variant.layoutMode = 'HORIZONTAL';
      variant.primaryAxisAlignItems = 'CENTER';
      variant.counterAxisAlignItems = 'CENTER';
      variant.itemSpacing = styles.gap ? styles.gap.column : 0;
      variant.paddingTop = styles.padding.top;
      variant.paddingRight = styles.padding.right;
      variant.paddingBottom = styles.padding.bottom;
      variant.paddingLeft = styles.padding.left;
      setPaints(variant, 'fills', styles.backgroundColor ? [paintOf(styles.backgroundColor)] : []);
      if (styles.borderUniform) {
        setPaints(variant, 'strokes', [styles.borderUniform.color ? paintOf(styles.borderUniform.color) : { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0 }]);
        variant.strokeWeight = styles.borderUniform.width;
        variant.strokeAlign = 'INSIDE';
        variant.strokesIncludedInLayout = true;
      } else {
        variant.strokes = [];
      }
      variant.cornerRadius = styles.borderRadiusUniform || 0;
      variant.opacity = styles.opacity;
      let text = variant.findOne((n) => n.type === 'TEXT');
      if (styles.text) {
        if (!text) {
          text = figma.createText();
          variant.appendChild(text);
        }
        text.fontName = await loadFont(styles.text.fontFamily, styles.text.fontWeight);
        text.fontSize = styles.text.fontSize;
        text.characters = 'Button';
        setPaints(text, 'fills', [paintOf(styles.text.color)]);
      }
      variant.resize(styles.width, styles.height);
    };`;

test("mock: a variable's scopes are ALL_SCOPES until set, and Figma's for its type only", async () => {
  const figma = new MockFigma();
  const make = (type: string, scopes: string) => `const c = figma.variables.createVariableCollection('C${type}${scopes.length}');
const v = figma.variables.createVariable('x', c, '${type}');
const was = v.scopes;
v.scopes = ${scopes};
return JSON.stringify([was, (await figma.variables.getVariableByIdAsync(v.id)).scopes]);`;
  assert.deepEqual(JSON.parse((await ok(figma, make("FLOAT", "['CORNER_RADIUS']"))) as string), [["ALL_SCOPES"], ["CORNER_RADIUS"]]);
  for (const [type, scopes, error] of [
    ["COLOR", "['CORNER_RADIUS']", /CORNER_RADIUS is not a scope of a COLOR variable/],
    ["COLOR", "['ALL_FILLS', 'TEXT_FILL']", /ALL_FILLS takes no other fill scope/],
  ] as const) {
    const run = await figma.run(make(type, scopes));
    assert.equal(run.ok, false);
    assert.match(run.text, error);
  }
});

test("templates: the skill's Tokens step 3 makes a collection in Light and Dark, and the Audit's read gives each mode", async () => {
  // tokens gives a dark value, and the push makes it a Dark mode beside
  // Light; a token without one keeps its light value there.
  const blocks = skillBlocks();
  const create = blocks.filter((b) => /^Create the Colors variable collection/.test(b.description));
  const read = blocks.filter((b) => /^Read all variable collections/.test(b.description));
  assert.equal(create.length, 1);
  assert.equal(read.length, 1);
  const figma = new MockFigma();
  assert.deepEqual(JSON.parse((await ok(figma, create[0].code)) as string), { collection: "Colors", modes: ["Light", "Dark"], variables: 3, darkError: null });
  const audit = JSON.parse((await ok(figma, read[0].code)) as string) as { next: unknown; variables: unknown[] };
  assert.deepEqual(audit, { total: 3, next: null, variables: [
    { name: "background", type: "COLOR", value: "#ffffff", collection: "Colors", modes: { Light: "#ffffff", Dark: "#0a0a0a" } },
    { name: "primary", type: "COLOR", value: "#171717", collection: "Colors", modes: { Light: "#171717", Dark: "#e5e5e5" } },
    { name: "chart/1", type: "COLOR", value: "#3b82f6", collection: "Colors", modes: { Light: "#3b82f6", Dark: "#3b82f6" } },
  ] });

  // A plan of one mode: Light alone, and the error to tell the user.
  const free = new MockFigma({ maxModes: 1 });
  const made = JSON.parse((await ok(free, create[0].code)) as string) as { modes: string[]; darkError: string | null };
  assert.deepEqual(made.modes, ["Light"]);
  assert.match(made.darkError ?? "", /Limited to 1 modes/);
  const lightOnly = JSON.parse((await ok(free, read[0].code)) as string) as { variables: { value: string; modes?: unknown }[] };
  assert.deepEqual(lightOnly.variables.map((v) => [v.value, v.modes]), [["#ffffff", undefined], ["#171717", undefined], ["#3b82f6", undefined]]);
});

test("templates: the 0.4.0 skill's build and readback run unchanged, and verify scores the result 100%", async () => {
  const blocks = skillBlocks();
  const build = blocks.filter((b) => /^Create or update/.test(b.description));
  const read = blocks.filter((b) => b.code.includes("const SLUG_BY_NAME"));
  assert.equal(build.length, 1);
  assert.equal(read.length, 1);
  const snap = loadTreeFixture("example-button");
  const component = snap.components[0];
  const variants = component.variants.map((v) => {
    const styles: Record<string, unknown> = { ...component.base!.styles, ...v.delta };
    if (styles.borderUniform) delete styles.border;
    if (styles.borderRadiusUniform != null) delete styles.borderRadius;
    return { name: Object.entries(v.combination).map(([k, value]) => `${k}=${value}`).join(", "), slug: v.slug, styles };
  });
  const buildCode = withConstants(build[0].code, { PAGE_NAME: "Forms", SET_NAME: "Button", ID: "forms-button", TITLE: "Forms/Button", SET_ID: null, PART: 25 })
    .replace(table("PROPERTIES", "[", "]"), () => `const PROPERTIES = [\n${component.variantProperties.map((p) => `      ${JSON.stringify(p)},`).join("\n")}\n    ];`)
    .replace(table("VARIANTS", "[", "]"), () => `const VARIANTS = [\n${variants.map(({ name, styles }) => `      ${JSON.stringify({ name, styles })},`).join("\n")}\n    ];`)
    .replace(/const applyStyles = async \(variant, styles\) => \{[\s\S]*?\n\s*\};/, () => APPLY_STYLES);
  const figma = new MockFigma();
  type Built = { id: string; variants: number; added: number; rows: number; columns: number; extra: number; overlaps: number; fonts: Record<string, string> };
  const built = JSON.parse((await ok(figma, buildCode)) as string) as Built;
  assert.deepEqual([built.variants, built.added, built.rows, built.columns, built.extra, built.overlaps], [12, 12, 3, 4, 0, 0]);
  assert.deepEqual(built.fonts, {}, "Inter Semi Bold loads as itself");
  // Run again: the template updates every variant in place and adds none.
  const again = JSON.parse((await ok(figma, buildCode)) as string) as { id: string; added: number; updated: number };
  assert.deepEqual([again.id, again.added, again.updated], [built.id, 0, 12]);

  const readback: ReadbackFile = { version: 1, components: { [component.title!]: { nodeId: built.id, variants: {} } } };
  for (let start = 0; start < variants.length; start += 5) {
    const slice = variants.slice(start, start + 5);
    const code = withConstants(read[0].code, { SET_ID: built.id, BATCH: 20 })
      .replace(table("SLUG_BY_NAME", "{", "}"), () => `const SLUG_BY_NAME = {\n${slice.map((v) => `      ${JSON.stringify(v.name)}: ${JSON.stringify(v.slug)},`).join("\n")}\n    };`)
      .replace(table("SOURCE_BY_SLUG", "{", "}"), () => `const SOURCE_BY_SLUG = {\n${slice.map((v) => `      ${JSON.stringify(v.slug)}: "measured",`).join("\n")}\n    };`);
    const result = JSON.parse((await ok(figma, code)) as string) as { id: string; total: number; readback: Record<string, never> };
    assert.equal(result.total, 12);
    Object.assign(readback.components[component.title!].variants, result.readback);
  }
  const verdict = verify(snap, readback, 0.5);
  assert.deepEqual(verdict.readbackIssues, []);
  assert.equal(verdict.summary.verified, 12, JSON.stringify(verdict.variants.filter((v) => v.status !== "verified").map((v) => [v.slug, v.differences]), null, 1));
  assert.equal(verdict.fidelity, 1);
});

// --- The spike probe ------------------------------------------------------------

const PROBE = readFileSync(`${ROOT}spikes/figma-probe.js`, "utf8");
/** The probe's second call: the one line its header says to change. */
const PROBE_IMAGE = PROBE.replace(/^const MODE = 'probe';$/m, "const MODE = 'image';");

/** What the probe returned when it ran live in Figma, on 2026-10-08, kept unchanged. */
const LIVE = JSON.parse(readFileSync(`${ROOT}cli/__tests__/fixtures/figma-spike.json`, "utf8")) as {
  returnShape: string;
  probe: { mode: string; items: Record<string, Record<string, unknown>> };
  upload: { success: boolean; imageHash: string; sizeBytes: number; contentType: string };
  image: { mode: string; items: { image: Record<string, unknown> } };
};

/** The probe's two labels as wide as Figma set them live, so the mock's stand-in measure doesn't decide them. */
const PROBE_MEASURE = {
  advance: (chars: string, font: MockFont) => (chars === "Login with Email Button" && font.style === "Medium" && font.size === 14 ? 158
    : chars === "Login with Email" && font.style === "Regular" && font.size === 12 ? 93 : estimateAdvance(chars, font)),
};

const find = (views: NodeView[], test: (n: NodeView) => boolean): NodeView | undefined => {
  for (const view of views) {
    if (test(view)) return view;
    const inner = find(view.children ?? [], test);
    if (inner) return inner;
  }
  return undefined;
};

/** Every node outside `page`, by id, with its box: what the probe must leave as it was. */
function outside(figma: MockFigma, page: string): string {
  return JSON.stringify(figma.pages().filter((p) => p.name !== page));
}

test("spike: the probe runs as one call, only on its own page, and the mock answers it as Figma did live", async () => {
  const thumb = Object.values(loadTreeFixture("avatar").components[0].tree.assets.img)[0];
  const figma = new MockFigma({ pages: ["Design", "Components"], measure: PROBE_MEASURE });
  await ok(figma, "const f = figma.createFrame(); f.name = 'mine';");
  const before = outside(figma, "storysync spike");
  const run: MockRun = await figma.run(PROBE);
  assert.ok(run.ok, run.text);
  assert.ok(run.bytes < 20_000, `${run.bytes} bytes`);
  assert.deepEqual(run.switches.length, 1);
  assert.equal(outside(figma, "storysync spike"), before, "nothing outside the spike page changed");
  const result = run.value as { mode: string; page: string; imageNode: string; items: Record<string, Record<string, unknown>> };
  assert.equal(result.mode, "probe");
  for (const name of ["svg", "shadow", "text", "absolute", "clone", "search", "returned", "time", "blend", "defaults", "sizing"]) {
    assert.ok(result.items[name] && !result.items[name].error, `${name}: ${JSON.stringify(result.items[name])}`);
  }
  // Every item as Figma answered it, but the times, which are the mock's own.
  const { time, ...items } = result.items as Record<string, Record<string, unknown>>;
  const { time: liveTime, ...liveItems } = LIVE.probe.items;
  assert.equal(LIVE.probe.mode, "probe");
  for (const [name, live] of Object.entries(liveItems)) assert.deepEqual(items[name], live, name);
  assert.deepEqual(Object.keys(items).sort(), Object.keys(liveItems).sort());
  assert.deepEqual(Object.keys(time), Object.keys(liveTime));
  assert.equal(time.height, liveTime.height, "400 frames of 8 and 100 labels of 15");
  assert.equal(find(figma.pages(), (n) => n.name === "storysync spike")!.children!.filter((n) => n.type === "FRAME" && n.children?.length === 3 && n.height === 720).length, 0, "each case is removed");
  const page = find(figma.pages(), (n) => n.name === "storysync spike")!;
  assert.equal(page.data["storysync.spike"], "1");

  // Item 10: upload the thumbnail, then read it back in MODE 'image'.
  const thumbBytes = treeFixtureAsset(thumb.file);
  const sha1 = createHash("sha1").update(thumbBytes).digest("hex");
  assert.ok(PROBE.includes(`bytes: ${thumbBytes.length}, fnv: '${thumb.fnv}', sha1: '${sha1}'`), "the probe expects the fixture's thumbnail");
  const [uploaded] = figma.uploadAssets([result.imageNode], [thumbBytes]);
  // upload_assets answered live with the bytes' SHA-1 as their hash, as the mock does.
  assert.deepEqual([LIVE.upload.success, LIVE.upload.imageHash, LIVE.upload.sizeBytes], [true, uploaded.imageHash, thumbBytes.length]);
  assert.notEqual(PROBE_IMAGE, PROBE);
  const image = await figma.run(PROBE_IMAGE);
  assert.ok(image.ok, image.text);
  // The live run also named the node it reused the hash on.
  const { reuseNodeId: _reused, ...liveImage } = LIVE.image.items.image;
  assert.deepEqual((image.value as { items: { image: Record<string, unknown> } }).items.image, liveImage);
  assert.deepEqual(liveImage, {
    hash: sha1, scaleMode: "FILL", length: thumbBytes.length, fnv: thumb.fnv,
    size: { width: 80, height: 80 }, sameBytes: true, hashIsSha1: true, sameSize: true, reused: true,
  });

  // A re-run clears only its own page; a page of that name it did not make is refused.
  const rerun = await figma.run(PROBE);
  assert.ok(rerun.ok, rerun.text);
  assert.equal(outside(figma, "storysync spike"), before);
  const other = new MockFigma({ pages: ["storysync spike"] });
  assert.match(await fails(other, PROBE), /exists that this probe did not create/);
  assert.match(await fails(new MockFigma(), PROBE_IMAGE), /Run MODE probe first/);
});

// --- The live text probe ----------------------------------------------------------

/** The text probe's three calls, as sent to use_figma on 2026-10-09. */
const TEXT_PROBE = [1, 2, 3].map((i) => readFileSync(`${ROOT}spikes/figma-text-probe-${i}.js`, "utf8"));

type Widths = [chars: string, family: string, style: string, size: number, width: number, height: number, ...rest: unknown[]][];
/** What Figma answered each call, kept unchanged. */
const TEXT_LIVE = JSON.parse(readFileSync(`${ROOT}cli/__tests__/fixtures/figma-text-probe.json`, "utf8")) as {
  call1: { widths: Widths; orders: Record<string, string> };
  call2: { thresholds: [string, string, number, number, number, number, number, number][]; heights: Record<string, number[]>; orders: Record<string, string> };
  call3: { has: string[]; lacks: string[] };
};

test("text probe: the mock sets each string as wide and tall as Figma did, and keeps truncation in the orders Figma did", async () => {
  const figma = new MockFigma({ pages: ["Page 1", "Components"] });
  await ok(figma, "const f = figma.createFrame(); f.name = 'mine';");
  const before = outside(figma, "storysync probe 2");
  const one = await figma.run(TEXT_PROBE[0]);
  assert.ok(one.ok, one.text);
  assert.ok(one.bytes < 20_000);
  const first = one.value as typeof TEXT_LIVE.call1;
  // A hugging text's width and height, each as Figma gave it: Inter, Roboto
  // Mono and Noto Serif at their weights and sizes, rounded up to a pixel.
  assert.deepEqual(first.widths.map((w) => w.slice(0, 6)), TEXT_LIVE.call1.widths.map((w) => w.slice(0, 6)));
  // Each sequence of writes leaves the text as Figma did, step by step:
  // textAutoResize turns truncation off, ENDING on a sizing text limits it
  // to a line, resize() makes a hugging one fixed, layout sizing keeps it.
  for (const [name, live] of Object.entries(TEXT_LIVE.call1.orders)) assert.equal(first.orders[name], live, name);
  assert.deepEqual(Object.keys(first.orders), Object.keys(TEXT_LIVE.call1.orders));

  const two = await figma.run(TEXT_PROBE[1]);
  assert.ok(two.ok, two.text);
  const second = two.value as typeof TEXT_LIVE.call2;
  assert.deepEqual(second.heights, TEXT_LIVE.call2.heights);
  for (const [name, live] of Object.entries(TEXT_LIVE.call2.orders)) assert.equal(second.orders[name], live, name);
  // Call 2 resized one text again and again, which Figma stops wrapping
  // again (the fourth push's probe read it at 138.25 for
  // "sales-dashboard.pdf", its textAutoResize NONE), so its thresholds and
  // heights describe that text. A fresh one keeps a line whole only at
  // Figma's own width, which the fourth push's probe read for each of call
  // 2's strings, and the mock wraps there too.
  const fresh = new Map(TEXT_LIVE_3.call1.rows.map((r) => [`${r[0]}|${r[1]}|${r[2]}`, r[5]]));
  for (const [i, live] of TEXT_LIVE.call2.thresholds.entries()) {
    const got = second.thresholds[i];
    const figmaWidth = fresh.get(`${live[0]}|${STYLE_WEIGHT[live[1]]}|${live[2]}`)!;
    assert.ok(Math.abs(got[4] - figmaWidth) <= RESIZE_STEP, `${live[0]}: the mock wraps under ${got[4]}, a fresh text in Figma under ${figmaWidth}`);
  }
  assert.equal(outside(figma, "storysync probe 2"), before, "nothing outside the probe's page changed");

  // Call 3 reads which faces Figma lacks; the mock has only the stand-ins.
  const three = await figma.run(TEXT_PROBE[2]);
  assert.ok(three.ok, three.text);
  const { has } = three.value as { has: string[] };
  assert.deepEqual(has, ["Inter", "Roboto Mono", "Noto Serif"]);
  assert.ok(has.every((f) => TEXT_LIVE.call3.has.includes(f)));
  // A page of the probe's name it didn't make is refused.
  assert.match(await fails(new MockFigma({ pages: ["storysync probe 2"] }), TEXT_PROBE[0]), /exists that this probe did not create/);
});

// --- The fourth push's text probe ------------------------------------------------

/** Its first call, as sent to use_figma on 2026-10-09: each string's width on a fresh text, and the Attachment title. */
const WIDTH_PROBE = readFileSync(`${ROOT}spikes/figma-width-probe-1.js`, "utf8");
type WidthRow = [chars: string, weight: number, size: number, hug: number, big: number, fits: number, ink: unknown, ends: [boolean, boolean]];
/** What Figma answered, kept unchanged. */
const TEXT_LIVE_3 = JSON.parse(readFileSync(`${ROOT}cli/__tests__/fixtures/figma-text-probe-3.json`, "utf8")) as {
  call1: { rows: WidthRow[]; attachment: Record<string, unknown> };
  call2: { size: number; advance: Record<string, number[]> };
  call3: { other: [chars: string, family: string, style: string, size: number, hug: number, exact: number, r2: number][] };
};
const STYLE_WEIGHT: Record<string, number> = { Regular: 400, Medium: 500, "Semi Bold": 600, Bold: 700 };
/**
 * How far from Figma's the width the mock keeps a line whole from can be:
 * the mock rounds a node's size to 0.01 as it is set, so a width it is
 * resized to can be up to half that over what was asked, and
 * fixtures/figma-fonts.json keeps each advance to 0.00001em, 0.002px over a
 * label.
 */
const RESIZE_STEP = 0.007;

test("text probe 3: the mock keeps a line whole at Figma's own width for each string, and wraps the Attachment title where Figma did", async () => {
  const run = await new MockFigma({ pages: ["Page 1"] }).run(WIDTH_PROBE);
  assert.ok(run.ok, run.text);
  const got = run.value as { rows: WidthRow[]; attachment: Record<string, unknown> };
  for (const [i, live] of TEXT_LIVE_3.call1.rows.entries()) {
    const [chars, weight, size] = live;
    const label = `${chars} ${weight} ${size}`;
    assert.deepEqual(got.rows[i].slice(0, 4), live.slice(0, 4), `${label}: as wide, hugging, rounded up to a pixel`);
    // At a hundred times the size, to 0.01: fixtures/figma-fonts.json keeps each advance to 0.00001em.
    assert.ok(Math.abs(got.rows[i][4] - live[4]) <= 0.01, `${label}: ${got.rows[i][4]} at 100x, Figma ${live[4]}`);
    assert.deepEqual(got.rows[i][7], live[7], label);
    // A string that can't wrap fits at any width; any other only from Figma's width on.
    if (!live[7][0]) assert.ok(Math.abs(got.rows[i][5] - live[5]) <= RESIZE_STEP, `${label}: whole from ${got.rows[i][5]}, in Figma from ${live[5]}`);
  }
  // "sales-dashboard.pdf" in a column of 139.38, as the fourth push built
  // the Attachment, takes two lines; it takes one only from 139.4.
  assert.deepEqual(got.attachment, TEXT_LIVE_3.call1.attachment);
});

test("figmaFonts: the mock sets each of the probe's characters as wide as Figma did at every weight of Inter, arrows and check marks included", () => {
  // The probe's second call, each character alone in units of 2048 an em:
  // ←, → and ✓ were set in a fallback font, 2048 and 1565 where Figma has
  // 1954 and 1804, before the stand-ins carried Inter's symbols.
  const measure = figmaFonts();
  const chars = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ...Array.from({ length: 96 }, (_, i) => String.fromCharCode(160 + i)), ..."–—‘’“”…•€←→↑↓−×✓"];
  for (const [weight, advances] of Object.entries(TEXT_LIVE_3.call2.advance)) {
    const style = ["Thin", "ExtraLight", "Light", "Regular", "Medium", "Semi Bold", "Bold", "ExtraBold", "Black"][Number(weight) / 100 - 1];
    chars.forEach((ch, i) => {
      // White space and a soft hyphen alone Figma sets 0 wide: the probe read them between two H.
      if (ch === "\u00ad") return;
      const font = { family: "Inter", style, size: 2048, letterSpacing: 0 };
      const got = /\s/.test(ch) ? measure.advance(`H${ch}H`, font) - measure.advance("HH", font) : measure.advance(ch, font);
      assert.ok(Math.abs(got - advances[i]) <= 2048 * 0.00001, `${JSON.stringify(ch)} at ${weight}: ${got}, Figma ${advances[i]}`);
    });
  }
});

test("figmaFonts: the mock sets each string of the fourth push's probe as wide as Figma did, in Inter, Roboto Mono and Noto Serif", () => {
  const measure = figmaFonts();
  const font = (family: string, weight: number, size: number) => ({ family, size, letterSpacing: 0, style: Object.keys(STYLE_WEIGHT).find((s) => STYLE_WEIGHT[s] === weight)! });
  for (const [chars, weight, size, , , fits, , ends] of TEXT_LIVE_3.call1.rows) {
    if (ends[0]) continue;
    const off = Math.abs(measure.advance(chars, font("Inter", weight, size)) - fits);
    assert.ok(off <= 0.002, `${chars} ${weight} ${size}: ${measure.advance(chars, font("Inter", weight, size))}, Figma ${fits}`);
  }
  for (const [chars, family, style, size, , exact] of TEXT_LIVE_3.call3.other) {
    // Figma's Noto Serif Bold is another release than the package's: no weight of it sets "Quietly Waving" as wide (scripts/figma-font-metrics.mjs).
    if (family === "Noto Serif" && style === "Bold") continue;
    const off = Math.abs(measure.advance(chars, font(family, STYLE_WEIGHT[style], size)) - exact);
    assert.ok(off <= 0.002, `${chars} ${style} ${size}: Figma ${exact}`);
  }
});
