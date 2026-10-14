// templates/build.js, run as figma code writes it, in the mock Figma.

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleReorder } from "../figma-layout.js";
import { textSizesItself } from "../figma-map.js";
import { applyDelta } from "../snap-normalize.js";
import { absoluteBoxes, parentKey, rootWithStyles, treeDigest } from "../tree-types.js";
import type { Box, TreeNode } from "../tree-types.js";
import { SHADCN_TOKENS, boxDrift, codeFor, drawnInSet, mockFor, readBoxes, runPlan, variantsBySlug, withConstant } from "./figma-build-harness.js";
import { MockFigma, figmaFonts, fixtureVariants, loadTreeFixture, treeFixtureAsset, treeFixtureNames, withNoClass } from "./mock-figma.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTree } from "../snap-tree.js";
import { readBack } from "./tree-harness.js";
import type { RawTreeCapture, RawTreeItem } from "../snap-tree.js";
import type { MockFigmaOptions, MockRun, NodeView, TreeFixture } from "./mock-figma.js";

type BuildResult = {
  kind: string; page: string; sets: { id: string; component: string; name: string; variants: number; added: number; updated: number; migrated: number; designerLayers: number; absoluteContainers: unknown[] }[];
  uploads: [string, string][]; unbound: string[][]; fallbacks: [string, string, string, number][]; fonts: Record<string, string>; omitted?: number;
};
const result = (run: MockRun) => run.value as BuildResult;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The layer keyed `key` in a built variant. */
function keyed(view: NodeView, key: string): NodeView | undefined {
  for (const child of view.children ?? []) {
    if (child.data["storysync.k"] === key) return child;
    const found = keyed(child, key);
    if (found) return found;
  }
  return undefined;
}

/** The layers of a built variant that carry no key, an icon's own shapes aside: none, unless a designer added them. */
function unkeyed(view: NodeView): string[] {
  const out: string[] = [];
  for (const child of view.children ?? []) {
    if (!child.data["storysync.k"] && !child.data["storysync.vs"]) out.push(`${child.type} ${child.name}`);
    else if (!child.data["storysync.svg"]) out.push(...unkeyed(child));
  }
  return out;
}

async function buildAll(fixture: TreeFixture, mockOptions: MockFigmaOptions = {}, codeOptions = {}) {
  const coded = await codeFor(fixture, codeOptions);
  const mock = mockFor([fixture], mockOptions);
  const runs = await runPlan(mock, coded, ["build"]);
  return { coded, mock, runs, results: runs.map(result) };
}

test("build: a faithful build puts every keyed layer where snap measured it, with no frame left absolute", async () => {
  for (const name of treeFixtureNames()) {
    const fixture = loadTreeFixture(name);
    const { mock, results } = await buildAll(fixture);
    for (const r of results) {
      for (const set of r.sets) assert.deepEqual(set.absoluteContainers, [], `${name}: ${JSON.stringify(set.absoluteContainers)}`);
      assert.deepEqual(r.fallbacks, [], name);
    }
    const built = variantsBySlug(mock);
    for (const variant of fixtureVariants(fixture)) {
      const node = built.get(variant.slug);
      assert.ok(node, `${name} ${variant.slug} was built`);
      // A component with no variant properties is one plain component, named as the set would be.
      assert.equal(node.name, variant.name || fixture.components[0].title!.split("/").pop());
      assert.deepEqual(boxDrift(mock, node, variant.nodes, absoluteBoxes(variant.nodes)), [], `${name} ${variant.slug}`);
      // Each icon's shapes where the browser drew them in it, as verify's
      // shape gate checks: not one snap could measure only roughly, as a
      // turned one, which verify leaves unscored.
      for (const icon of variant.nodes.filter((n) => n.t === "V" && !n.approx && !n.raster)) {
        const view: NodeView = keyed(node, icon.k)!;
        const shapes: number[][] = view.children!.map((c) => [c.x, c.y, c.width, c.height]);
        const tol = Math.max(0.5, 0.03 * icon.box[2]);
        assert.equal(shapes.length, icon.shapes!.length, `${name} ${icon.k}`);
        shapes.forEach((box: number[], i: number) => assert.ok(box.every((v: number, a: number) => Math.abs(v - Math.max(icon.shapes![i][a], a > 1 ? 0.01 : -Infinity)) <= tol), `${name} ${icon.k} shape ${i}: ${box} vs ${icon.shapes![i]}`));
      }
      assert.equal(node.data["storysync.src"], "measured");
      assert.equal(node.data["storysync.tpl"], "2");
      // The digest verify checks the variant against: of its facts, the root's paint from its styles included.
      const component = fixture.components[0];
      const styles = applyDelta(component.base!.styles, component.variants.find((v) => v.slug === variant.slug)!.delta ?? {});
      assert.equal(node.data["storysync.d"], treeDigest([rootWithStyles(variant.nodes[0], styles), ...variant.nodes.slice(1)]), `${name} ${variant.slug}`);
      assert.deepEqual(unkeyed(node), [], `${name} ${variant.slug}`);
    }
  }
});

test("build: in Figma's own fonts, Inter where snap measured system-ui, no container falls back; a hugging root grows by its label's growth", async () => {
  for (const name of treeFixtureNames()) {
    const { results } = await buildAll(loadTreeFixture(name), { measure: figmaFonts() });
    for (const r of results) for (const set of r.sets) assert.deepEqual(set.absoluteContainers, [], name);
  }
  const fixture = loadTreeFixture("button-icon");
  const { mock } = await buildAll(fixture, { measure: figmaFonts() });
  const variant = fixtureVariants(fixture)[0];
  const boxes = readBoxes(mock, variantsBySlug(mock).get(variant.slug)!);
  // Measured 154.8 in system-ui; Figma set it 158 in Inter Medium, in the spike and in the text probe.
  assert.equal(boxes.get("#text")![2], 158);
  assert.equal(boxes.get("")![2], 206.8 + 158 - 154.8, "the button hugs its label");
  assert.deepEqual(boxes.get("svg"), [11, 10, 16, 16], "the icon before it stays");
});

/** A one-variant component of the given tree and root styles, as a snap writes it. */
function synthetic(name: string, tree: TreeNode[], styles: object, svg: Record<string, string> = {}, extra: object = {}): TreeFixture {
  const base = copy(loadTreeFixture("example-button"));
  const component = base.components[0];
  Object.assign(component, {
    id: `test-${name.toLowerCase()}`, name, title: `test/${name}`, category: "test", variantProperties: [],
    base: { combination: {}, slug: "default", styles: { ...component.base!.styles, ...styles } },
    variants: [{ combination: {}, slug: "default", status: "ok", error: null, delta: {} }],
    warnings: [], tree: { version: 1, base: tree, assets: { svg, img: {} } }, ...extra,
  });
  return base;
}

const CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>';

test("build: Figma's layer order differs from snap's paint order only between siblings that don't overlap (verify's `order`)", async () => {
  // Attachment's media tile is `relative`, so it paints after the content it
  // flows before. Its layers follow the flow, which auto layout needs; verify
  // scores order with the same visibleReorder, so it counts as the same.
  let reordered = 0;
  for (const name of treeFixtureNames()) {
    const fixture = loadTreeFixture(name);
    const { mock } = await buildAll(fixture);
    for (const variant of fixtureVariants(fixture)) {
      const built = variantsBySlug(mock).get(variant.slug)!;
      const parents = new Map<string, TreeNode[]>();
      for (const node of variant.nodes.slice(1)) {
        const p = parentKey(node.k)!;
        parents.set(p, [...(parents.get(p) ?? []), node]);
      }
      for (const [p, kids] of parents) {
        const view = p === "" ? built : keyed(built, p)!;
        const layers = view.children!.map((c) => c.data["storysync.k"]).filter((k): k is string => Boolean(k));
        assert.equal(visibleReorder(kids, layers), null, `${name} ${variant.slug} › ${p || "(root)"}`);
        if (layers.join() !== kids.map((k) => k.k).join()) reordered++;
      }
    }
  }
  assert.equal(reordered, 4, "Attachment's root, in each of its 4 variants");
});

test("build: a text's alignment, truncation and line count, and a hidden layer, are built as snap measured them", async () => {
  const fixture = synthetic("Texts", [
    { k: "", t: "F", el: "div", box: [0, 0, 120, 100], L: { d: "block" } },
    { k: "center", t: "T", el: "p", box: [0, 0, 120, 20], tx: { c: "Centered", f: "Inter", sz: 14, wt: 400, col: "#0a0a0a", lh: 20, n: 1, ta: "center", ink: [33, 1.5, 54, 17] } },
    { k: "cut", t: "T", el: "p", box: [0, 20, 120, 20], tx: { c: "A title that runs past its box", f: "Inter", sz: 14, wt: 400, col: "#0a0a0a", lh: 20, n: 1, el: 1, ink: [0, 1.5, 120, 17] } },
    { k: "clamp", t: "T", el: "p", box: [0, 40, 120, 40], tx: { c: "Two lines of text, then the rest cut off at the second", f: "Inter", sz: 14, wt: 400, col: "#0a0a0a", lh: 20, n: 2, cl: 2, ink: [0, 1.5, 118, 37] } },
    { k: "gone", t: "F", el: "span", box: [0, 80, 120, 20], bg: "#eeeeee", vis: 0, abs: 1 },
  ], { width: 120, height: 100, display: "block" });
  const { mock } = await buildAll(fixture);
  const variant = variantsBySlug(mock).get("default")!;
  const props = (key: string, names: string[]) => names.map((p) => mock.handle(keyed(variant, key)!.id)[p]);
  const text = ["textAlignHorizontal", "textTruncation", "maxLines", "textAutoResize"];
  assert.deepEqual(props("center", text), ["CENTER", "DISABLED", null, "HEIGHT"]);
  assert.deepEqual(props("cut", text), ["LEFT", "ENDING", 1, "HEIGHT"]);
  assert.deepEqual(props("clamp", text), ["LEFT", "ENDING", 2, "HEIGHT"]);
  assert.deepEqual(props("gone", ["visible"]), [false]);
  assert.deepEqual(props("center", ["visible"]), [true]);
});

/** Each text keyed `key` in a mock, with what Figma holds of it. */
function texts(mock: MockFigma, key: RegExp) {
  return mock.nodes("TEXT").filter((n) => key.test(n.data["storysync.k"] ?? "")).map((n) => {
    const h = mock.handle(n.id) as Record<string, unknown>;
    return { key: n.data["storysync.k"], chars: h.characters as string, w: n.width, h: n.height, ar: h.textAutoResize, tr: h.textTruncation, max: h.maxLines };
  });
}

test("build: truncation is set after the size and textAutoResize, which turn it off in Figma, so a cut-off title stays one line, built again too", async () => {
  // Attachment's titles end in an ellipsis; in its vertical tiles the browser cut them at 94px.
  const fixture = loadTreeFixture("attachment");
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture], { measure: figmaFonts() });
  for (const round of [1, 2]) {
    await runPlan(mock, coded, ["build"]);
    const cut = texts(mock, /attachment-(title|description)$/);
    assert.equal(cut.length, 8);
    for (const t of cut) assert.deepEqual([t.tr, t.max, t.ar], ["ENDING", 1, "HEIGHT"], `${t.key}, build ${round}`);
    // One line each: 17.5 for the title, Figma's own height where it cuts at maxLines.
    assert.deepEqual([...new Set(cut.filter((t) => /title$/.test(t.key!)).map((t) => t.h))], [17.5], `build ${round}`);
  }
});

test("build: a label the browser drew whole stays whole on one line where Figma's font sets it wider, and is named", async () => {
  // Sidebar's menu labels were measured in system-ui, which Figma sets in
  // Inter, wider: "Home" 38.25 in the browser, 39.04 in Inter. At its
  // measured width it would end in an ellipsis the browser didn't draw.
  const fixture = loadTreeFixture("sidebar");
  const { mock, results } = await buildAll(fixture, { measure: figmaFonts() });
  const spans = texts(mock, /sidebar-menu-button(:\d)?\/span$/);
  assert.equal(spans.length, 5);
  const inter = figmaFonts();
  for (const t of spans) {
    const own = inter.advance(t.chars, { family: "Inter", style: "Regular", size: 14, letterSpacing: 0 });
    // At least as wide as Inter sets it, rounded up as Figma rounds a hugging text, so nothing is cut; still truncating, on one line.
    assert.deepEqual([t.w, t.h, t.tr, t.max, t.ar], [Math.ceil(own), 20, "ENDING", 1, "HEIGHT"], t.key);
  }
  assert.deepEqual(results[0].fallbacks.map(([, key, what, n]) => [key.replace(/.*\//, ""), what, n]).filter(([key]) => key === "span"),
    spans.map(() => ["span", "kept on one line: Figma sets it wider", 1]));
  // As wide as the browser drew it, it is left as built, and nothing is named.
  const faithful = await buildAll(fixture);
  assert.deepEqual(faithful.results[0].fallbacks, []);
  assert.ok(texts(faithful.mock, /\/span$/).every((t) => t.w < 60 && t.max === 1));
});

test("build: a one-line label in a box Figma's font overflows is set to its own width instead of wrapping; one that fills its parent is named", async () => {
  const fixture = synthetic("Labels", [
    { k: "", t: "F", el: "div", box: [0, 0, 200, 60], L: { d: "block" } },
    // In a box 10% wider than its glyphs as the browser drew them, which Inter, wider, doesn't fit.
    { k: "label", t: "T", el: "p", box: [0, 0, 33, 20], tx: { c: "Home", f: "system-ui", fk: 1, sz: 14, wt: 400, col: "#0a0a0a", lh: 20, n: 1, ink: [0, 1, 30, 17] } },
    // Across the block, whole and truncatable in the browser, wider than the block in Inter.
    { k: "fill", t: "T", el: "span", box: [0, 20, 200, 20], tx: { c: "sales-dashboard.pdf sales-dashboard.pdf", f: "system-ui", fk: 1, sz: 14, wt: 400, col: "#0a0a0a", lh: 20, n: 1, el: 1, ws: "nowrap", ink: [0, 1, 190, 17] } },
    // Across it too, not truncated: it wraps in Figma, as verify's lines see, and isn't named.
    { k: "wrap", t: "T", el: "p", box: [0, 40, 200, 20], tx: { c: "sales-dashboard.pdf sales-dashboard.pdf", f: "system-ui", fk: 1, sz: 14, wt: 400, col: "#0a0a0a", lh: 20, n: 1, ink: [0, 1, 150, 17] } },
  ], { width: 200, height: 60, display: "block" });
  const { mock, results } = await buildAll(fixture, { measure: figmaFonts() });
  const [label] = texts(mock, /^label$/);
  // Inter's 39.04, rounded up as Figma rounds a hugging text: on one line, past its 33px box.
  assert.deepEqual([label.ar, label.w, label.h, label.tr], ["WIDTH_AND_HEIGHT", 40, 20, "DISABLED"]);
  // The filling one keeps its width and its truncation, cut short where the browser showed it whole: named.
  const [fill] = texts(mock, /^fill$/);
  assert.deepEqual([fill.ar, fill.w, fill.h, fill.tr, fill.max], ["HEIGHT", 200, 20, "ENDING", 1]);
  const [wrap] = texts(mock, /^wrap$/);
  assert.deepEqual([wrap.ar, wrap.w, wrap.h, wrap.tr], ["HEIGHT", 200, 40, "DISABLED"]);
  assert.deepEqual(results[0].fallbacks.map(([, key, what]) => `${key} ${what}`), [
    "label kept on one line: Figma sets it wider",
    "fill cut short: Figma sets it wider",
  ]);
});

test("build: an Attachment title snap measured as wide as Figma sets it stays whole, its boxes rounded up, not to the nearest 0.01", async () => {
  // The fourth push's Attachment, its title "financial-model.xlsx", which
  // the stand-in sets 134.38068 wide, as Figma does: to the nearest 0.01
  // its column and the card were 134.38 and 0.0007px too narrow, and Figma
  // cut the title short where Storybook showed it whole.
  const capture = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../cli/__tests__/fixtures/raw/attachment.json", import.meta.url)), "utf8")) as { capture: RawTreeCapture }).capture;
  const font = { family: "Inter", style: "Medium", size: 14, letterSpacing: 0 };
  const width = figmaFonts().advance("financial-model.xlsx", font);
  assert.ok(Math.round(width * 100) / 100 < width, `${width} rounds up to the nearest 0.01: pick a title that rounds down`);
  // The card fits its content: what holds the title grows with it, and what follows moves along.
  const title = (capture.root.kids[1] as { kids: { kids: { text: string; rects: number[][] }[] }[] }).kids[0].kids[0];
  const [left, , was] = title.rects[0];
  const grow = width - was;
  const walk = (item: RawTreeItem) => {
    const box = item.k === "t" ? item.rects[0] : "box" in item ? item.box : null;
    if (!box) return;
    if (box[0] >= left + was) box[0] += grow;
    else if (box[0] <= left && box[0] + box[2] >= left + was) box[2] += grow;
    if (item.k === "e") item.kids.forEach(walk);
  };
  walk(capture.root);
  title.text = "financial-model.xlsx";
  title.rects[0][2] = width;
  const built = buildTree(capture);
  const root = built.nodes[0].box;
  const fixture = synthetic("Attachment", built.nodes, { width: root[2], height: root[3], display: "flex" }, built.svg);
  const { mock, results } = await buildAll(fixture, { measure: figmaFonts() });
  const [shown] = texts(mock, /attachment-title$/);
  // One line of Inter at 14px, not cut short.
  assert.equal(shown.chars, "financial-model.xlsx");
  assert.ok(shown.h < 25, `the title is ${shown.h} high`);
  assert.deepEqual(results[0].fallbacks, []);
});

/** A one-line text as a snap from before the stand-ins measured it, in system-ui with a 20px line. */
const systemText = (c: string, ink: [number, number, number, number], extra: object = {}) =>
  ({ c, f: "system-ui", fk: 1 as const, sz: 14, wt: 400, col: "#0a0a0a", lh: 20, n: 1, ink, ...extra });

test("build: whether a one-line label wraps in Figma is told by Figma's line, not by the box measured, taller or flat", async () => {
  // A row stretches its items: the label's box is the row's 40px, two of
  // its 20px lines. Whole in its 36px in system-ui, cut short in Inter's 39.05.
  const stretched = synthetic("Stretched", [
    { k: "", t: "F", el: "div", box: [0, 0, 200, 40], L: { d: "flex" } },
    { k: "label", t: "T", el: "span", box: [0, 0, 36, 40], tx: systemText("Home", [0, 11, 36, 17], { el: 1, ws: "nowrap" }) },
    { k: "after", t: "F", el: "i", box: [36, 0, 20, 40], bg: "#ff0000" },
  ], { width: 200, height: 40, display: "flex" });
  const wide = await buildAll(stretched, { measure: figmaFonts() });
  const [label] = texts(wide.mock, /^label$/);
  assert.deepEqual([label.w, label.h, label.ar, label.tr, label.max], [40, 20, "HEIGHT", "ENDING", 1]);
  assert.deepEqual(wide.results[0].fallbacks.map(([, key, what]) => `${key} ${what}`), ["label kept on one line: Figma sets it wider"]);
  // A box with no height, which a line in Figma always overtops: whole in
  // Inter too, it is left as built, and nothing is named.
  const flat = synthetic("Flat", [
    { k: "", t: "F", el: "div", box: [0, 0, 200, 40], L: { d: "block" } },
    { k: "label", t: "T", el: "span", box: [0, 10, 44, 0], tx: systemText("Home", [0, -8.5, 38.25, 17]) },
  ], { width: 200, height: 40, display: "block" });
  const kept = await buildAll(flat, { measure: figmaFonts() });
  const [whole] = texts(kept.mock, /^label$/);
  assert.deepEqual([whole.w, whole.h, whole.ar, whole.tr], [44, 20, "HEIGHT", "DISABLED"]);
  assert.deepEqual(kept.results[0].fallbacks, []);
});

test("build: a label set wider than measured stays so in a frame built without auto layout", async () => {
  const fixture = synthetic("Row", [
    { k: "", t: "F", el: "div", box: [0, 0, 200, 20], L: { d: "flex", ai: "center", gap: [8, 8] } },
    { k: "label", t: "T", el: "span", box: [0, 0, 36, 20], tx: systemText("Home", [0, 1.5, 36, 17], { el: 1, ws: "nowrap" }) },
    { k: "after", t: "F", el: "i", box: [44, 2, 16, 16], bg: "#ff0000" },
  ], { width: 200, height: 20, display: "flex" });
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture], { measure: figmaFonts() });
  const code = coded.code(coded.plan.calls[0]);
  const data = JSON.parse(/\nconst DATA = (.*);\n/.exec(code)![1]) as { S: unknown[] };
  // The row's gap, wrong as Figma might take it: the frame falls back to absolute.
  const at = data.S.findIndex((st) => typeof st === "object" && st !== null && "L" in st);
  (data.S[at] as { L: { g: number } }).L.g += 12;
  const run = await mock.run(withConstant(code, "DATA", data));
  assert.ok(run.ok, run.text);
  assert.deepEqual((result(run).sets[0].absoluteContainers as string[][]).map(([, key]) => key), [""]);
  // At Inter's width still, whole, not cut back to its 36px and an ellipsis.
  const [label] = texts(mock, /^label$/);
  assert.deepEqual([label.w, label.h, label.ar, label.tr, label.max], [40, 20, "HEIGHT", "ENDING", 1]);
  assert.deepEqual(result(run).fallbacks.map(([, key, what]) => `${key} ${what}`), ["label kept on one line: Figma sets it wider"]);
});

test("build: a frame Figma lays out otherwise than planned is built without auto layout, each child where snap measured it", async () => {
  for (const [name, tweak] of [
    ["button-icon", (L: { g: number }) => { L.g += 12; }],
    ["card", (L: { p: number[] }) => { L.p = L.p.map((p) => p + 5); }],
    ["attachment", (L: { ca: string }) => { L.ca = L.ca === "CENTER" ? "MAX" : "CENTER"; }],
  ] as const) {
    const fixture = loadTreeFixture(name);
    const coded = await codeFor(fixture);
    const mock = mockFor([fixture]);
    const code = coded.code(coded.plan.calls[0]);
    const data = JSON.parse(/\nconst DATA = (.*);\n/.exec(code)![1]) as { S: unknown[] };
    // The first auto layout style the call has, wrong as Figma might take it.
    const at = data.S.findIndex((st) => typeof st === "object" && st !== null && "L" in st);
    (tweak as (L: unknown) => void)((data.S[at] as { L: unknown }).L);
    const run = await mock.run(withConstant(code, "DATA", data));
    assert.ok(run.ok, run.text);
    const absolute = result(run).sets[0].absoluteContainers as [string, string, string][];
    assert.ok(absolute.length > 0, name);
    for (const [slug, key, why] of absolute) {
      assert.match(why, /lands -?[\d.]+px off (along|across) the flow$/);
      const built = variantsBySlug(mock).get(slug)!;
      assert.equal(mock.handle((key ? keyed(built, key)! : built).id).layoutMode, "NONE", `${name} ${slug} ${key}`);
    }
    for (const variant of fixtureVariants(fixture)) {
      assert.deepEqual(boxDrift(mock, variantsBySlug(mock).get(variant.slug)!, variant.nodes, absoluteBoxes(variant.nodes)), [], `${name} ${variant.slug}`);
    }
  }
});

test("build: a new variant that shares few layers with the first is made afresh, not copied and mostly removed", async () => {
  // As Sidebar's collapsible="none" against "offcanvas": one wrapper more, so every key differs.
  const box = (i: number): TreeNode => ({ k: `item:${i + 1}`.replace(/:1$/, ""), t: "F", el: "div", box: [0, i * 10, 40, 10], bg: "#eeeeee" });
  const fixture = synthetic("Panel", [{ k: "", t: "F", el: "div", box: [0, 0, 40, 40], L: { d: "block" } }, ...[0, 1, 2, 3].map(box)], { width: 40, height: 40, display: "block" });
  const component = fixture.components[0];
  component.variantProperties = [{ name: "wrap", type: "VARIANT", values: ["no", "yes", "same"], defaultValue: "no" }];
  component.base = { ...component.base!, combination: { wrap: "no" }, slug: "wrap-no" };
  const inner = [0, 1, 2, 3].map((i) => ({ ...box(i), k: `inner/${box(i).k}` }));
  component.variants = [
    { combination: { wrap: "no" }, slug: "wrap-no", status: "ok", error: null, delta: {} },
    {
      combination: { wrap: "yes" }, slug: "wrap-yes", status: "ok", error: null, delta: {},
      treeDelta: { keys: ["", "inner", ...inner.map((n) => n.k)], set: Object.fromEntries([{ k: "inner", t: "F", el: "div", box: [0, 0, 40, 40], L: { d: "block" } }, ...inner].map((n) => [n.k, n])) },
    },
    { combination: { wrap: "same" }, slug: "wrap-same", status: "ok", error: null, delta: {}, treeDelta: { set: { item: { bg: "#dddddd" } } } },
  ] as never;
  const { mock, runs } = await buildAll(fixture);
  // The page and the set; 5 layers for the first, 6 for the second, none copied to be removed; the third a copy of the first.
  assert.deepEqual([runs[0].removed, runs[0].created], [0, 2 + 5 + 6 + 5]);
  for (const variant of fixtureVariants(fixture)) {
    assert.deepEqual(boxDrift(mock, variantsBySlug(mock).get(variant.slug)!, variant.nodes, absoluteBoxes(variant.nodes)), [], variant.slug);
  }
});

test("build: an icon's imported frame has no fill, and no label meant to hug is resized", async () => {
  // Figma gives an imported SVG's frame a fill (spike item 1), and resize()
  // fixes a hugging text's size (item 3): neither may reach what is built.
  for (const name of treeFixtureNames()) {
    const fixture = loadTreeFixture(name);
    const { mock } = await buildAll(fixture);
    for (const variant of fixtureVariants(fixture)) {
      const node = variantsBySlug(mock).get(variant.slug)!;
      for (const n of variant.nodes) {
        const view = n.k === "" ? node : keyed(node, n.k)!;
        const handle = mock.handle(view.id) as { fills: unknown[]; textAutoResize?: string };
        if (n.t === "V") assert.deepEqual(handle.fills, [], `${name} ${variant.slug} ${n.k}`);
        if (n.t === "T" && textSizesItself(n)) assert.equal(handle.textAutoResize, "WIDTH_AND_HEIGHT", `${name} ${variant.slug} ${n.k}`);
      }
    }
  }
});

test("build: a variant copied from one already in its set goes into the set, though clone() puts it on the page", async () => {
  // clone() lands a variant's copy on the page (spike item 5): the build moves it into its set beside the original.
  const fixture = loadTreeFixture("switch");
  const first = copy(fixture);
  first.components[0].variants = first.components[0].variants.filter((v) => v.slug === first.components[0].base!.slug);
  const mock = mockFor([fixture]);
  await runPlan(mock, await codeFor(first), ["build"]);
  const [build] = await runPlan(mock, await codeFor(fixture), ["build"]);
  assert.deepEqual([result(build).sets[0].added, result(build).sets[0].updated], [1, 1]);
  const page = mock.pages().find((p) => p.name === "ui/base")!;
  assert.deepEqual(page.children!.map((n) => n.type), ["COMPONENT_SET"], "nothing left on the page");
  for (const variant of fixtureVariants(fixture)) {
    const built = variantsBySlug(mock).get(variant.slug)!;
    assert.deepEqual(unkeyed(built), [], variant.slug);
    assert.deepEqual(boxDrift(mock, built, variant.nodes, absoluteBoxes(variant.nodes)), [], variant.slug);
  }
  const again = await runPlan(mock, await codeFor(fixture), ["build"]);
  assert.deepEqual([again[0].created, again[0].removed], [0, 0]);
});

test("build: a keyed layer duplicated in Figma is removed, the first of them kept", async () => {
  const fixture = loadTreeFixture("switch");
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture]);
  await runPlan(mock, coded, ["build"]);
  const thumb = keyed(variantsBySlug(mock).get("size-default")!, "switch-thumb")!;
  await mock.run(`
    const page = figma.root.children.find((p) => p.name === 'ui/base');
    await figma.setCurrentPageAsync(page);
    const thumb = page.findOne((n) => n.id === ${JSON.stringify(thumb.id)});
    thumb.parent.appendChild(thumb.clone());
  `);
  assert.equal(variantsBySlug(mock).get("size-default")!.children!.length, 2);
  const [again] = await runPlan(mock, coded, ["build"]);
  assert.deepEqual([again.created, again.removed], [0, 1]);
  assert.deepEqual(variantsBySlug(mock).get("size-default")!.children!.map((c) => c.id), [thumb.id]);
});

test("build: a sibling after a label moves by as much as Figma's font widens the label", async () => {
  const fixture = synthetic("Next", [
    { k: "", t: "F", el: "button", box: [0, 0, 86, 24], L: { d: "inline-flex", ai: "center", gap: [4, 4], pad: [0, 8, 0, 8] } },
    { k: "#text", t: "T", el: "#text", box: [8, 2, 50, 20], tx: { c: "Next", f: "system-ui", fk: 1, sz: 14, wt: 500, col: "#ffffff", lh: 20, n: 1, ink: [0, 1.5, 50, 17] } },
    { k: "svg", t: "V", el: "svg.lucide-chevron-right", box: [62, 4, 16, 16], svg: "svg:chevron", shapes: [[6, 4, 4, 8]] },
  ], { width: 86, height: 24, display: "inline-flex" }, { "svg:chevron": CHEVRON });
  // Figma sets it 52.25 wide, which a hugging text rounds up to 53.
  const { mock, results } = await buildAll(fixture, { measure: { advance: (chars) => (chars === "Next" ? 52.25 : 0) } });
  assert.deepEqual(results[0].sets[0].absoluteContainers, []);
  const boxes = readBoxes(mock, variantsBySlug(mock).get("default")!);
  assert.equal(boxes.get("#text")![2], 53);
  assert.equal(boxes.get("svg")![0], 65);
  assert.equal(boxes.get("")![2], 89);
});

test("build: running the same calls again creates and removes nothing, and keeps every node id", async () => {
  for (const name of treeFixtureNames()) {
    const fixture = loadTreeFixture(name);
    const coded = await codeFor(fixture);
    const mock = mockFor([fixture]);
    await runPlan(mock, coded, ["build"]);
    const ids = mock.nodes().map((n) => n.id).sort();
    const again = await runPlan(mock, coded, ["build"]);
    for (const run of again) assert.deepEqual([run.created, run.removed], [0, 0], name);
    assert.deepEqual(mock.nodes().map((n) => n.id).sort(), ids, name);
  }
});

test("build: where clone() drops plugin data, which the spike didn't see, a copy is built afresh and a rerun changes nothing", async () => {
  const fixture = loadTreeFixture("attachment");
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture], { clonePluginData: false });
  const [first] = await runPlan(mock, coded, ["build"]);
  // The copy's layers, with no key, went as a designer's would: none is left beside those converge made.
  assert.equal(result(first).sets[0].designerLayers, 0);
  const again = await runPlan(mock, coded, ["build"]);
  assert.deepEqual([again[0].created, again[0].removed], [0, 0]);
  for (const variant of fixtureVariants(fixture)) {
    const built = variantsBySlug(mock).get(variant.slug)!;
    assert.deepEqual(unkeyed(built), [], variant.slug);
    assert.deepEqual(boxDrift(mock, built, variant.nodes, absoluteBoxes(variant.nodes)), []);
  }
});

const SETUP_040 = `
  const page = figma.createPage();
  page.name = 'ui/base';
  await figma.setCurrentPageAsync(page);
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  const v = figma.createComponent();
  v.name = 'size=default';
  const label = figma.createText();
  label.characters = 'Label';
  v.appendChild(label);
  const icon = figma.createFrame();
  icon.name = 'Icon (Bold)';
  v.appendChild(icon);
  const note = figma.createRectangle();
  note.name = 'Designer note';
  v.appendChild(note);
  const set = figma.combineAsVariants([v], page);
  set.name = 'Switch';
  set.setSharedPluginData('storysync', 'id', 'ui-base-switch');
  return { set: set.id, variant: v.id, note: note.id };
`;

test("build: a variant 0.4.0 built loses its label and icon frames, keeps a designer's layer, and says so", async () => {
  const fixture = loadTreeFixture("switch");
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture]);
  const setup = await mock.run(SETUP_040);
  const ids = setup.value as { set: string; variant: string; note: string };
  const [build] = await runPlan(mock, coded, ["build"]);
  const set = result(build).sets[0];
  assert.deepEqual([set.id, set.migrated, set.designerLayers, set.updated, set.added], [ids.set, 1, 1, 1, 1]);
  const variant = mock.node(ids.variant)!;
  assert.deepEqual(variant.children!.map((c) => [c.type, c.name, c.data["storysync.k"] ?? ""]), [
    ["RECTANGLE", "Designer note", ""], ["FRAME", "span[data-slot=switch-thumb]", "switch-thumb"],
  ]);
  const again = result((await runPlan(mock, coded, ["build"]))[0]).sets[0];
  assert.deepEqual([again.migrated, again.designerLayers], [0, 1], "built by this template now, so nothing more is migrated");
});

test("build: a part that fails on its third new variant leaves the set as it was, with nothing loose on the page", async () => {
  const fixture = loadTreeFixture("example-button");
  const first = copy(fixture);
  first.components[0].variants = first.components[0].variants.slice(0, 1);
  const mock = mockFor([fixture]);
  await runPlan(mock, await codeFor(first), ["build"]);
  const before = JSON.stringify(mock.pages());
  const coded = await codeFor(fixture);
  const code = coded.code(coded.plan.calls[0]);
  const data = JSON.parse(/\nconst DATA = (.*);\n/.exec(code)![1]) as { S: unknown[]; sets: { base: unknown[][]; v: unknown[][] }[] };
  // The third new variant (the set has the first) gets a style Figma refuses.
  const records = copy(data.sets[0].base);
  data.S.push({ b: "NOT_A_BLEND_MODE" });
  records[0][7] = data.S.length - 1;
  data.sets[0].v[3][5] = { r: records };
  const broken = withConstant(code, "DATA", data);
  const run = await mock.run(broken);
  assert.equal(run.ok, false);
  assert.match(run.text, /blendMode/);
  assert.equal(JSON.stringify(mock.pages()), before);
});

test("build: a variant snap couldn't measure is a labeled placeholder at the base size", async () => {
  const fixture = loadTreeFixture("button-icon");
  const { mock } = await buildAll(fixture);
  const placeholder = variantsBySlug(mock).get("variant-link--size-xs")!;
  assert.equal(placeholder.data["storysync.src"], "unmeasured");
  assert.equal(placeholder.data["storysync.d"], undefined, "no digest: nothing was measured");
  assert.deepEqual([placeholder.width, placeholder.height], [206.8, 36]);
  const root = mock.handle(placeholder.id) as Record<string, unknown>;
  assert.deepEqual([root.dashPattern, root.strokeWeight, (root.strokes as { color: object }[])[0].color], [[3, 3], 1, { r: 161 / 255, g: 161 / 255, b: 161 / 255 }]);
  const label = placeholder.children!.map((c) => mock.handle(c.id) as Record<string, unknown>);
  assert.deepEqual(label.map((t) => [t.characters, t.fontSize]), [["Not measured: args_hidden (size)", 11]]);
  assert.equal(variantsBySlug(mock).get("variant-link--size-default")!.data["storysync.src"], "measured");
});

test("images: the build lists one layer per image to upload; the images call fills the rest; a rebuild reuses the hash", async () => {
  const fixture = loadTreeFixture("avatar");
  const coded = await codeFor(fixture);
  assert.deepEqual(coded.plan.calls.map((c) => c.kind), ["build", "images", "label", "read"]);
  const mock = mockFor([fixture]);
  const [build] = await runPlan(mock, coded, ["build"]);
  const uploads = result(build).uploads;
  assert.deepEqual(uploads.map((u) => u[1]), ["img:513d06f54269-262b"], "three avatars, one image");
  const asset = fixture.components[0].tree.assets.img["img:513d06f54269-262b"];
  mock.uploadAssets([uploads[0][0]], [treeFixtureAsset(asset.file)]);
  const [images] = await runPlan(mock, coded, ["images"]);
  assert.deepEqual(images.value, { kind: "images", page: "ui/base", filled: 2, unfilled: [] });
  const filled = mock.nodes("FRAME").filter((n) => n.data["storysync.img"]).map((n) => (mock.handle(n.id).fills as { imageHash: string }[])[0]?.imageHash);
  assert.equal(filled.length, 3);
  assert.equal(new Set(filled).size, 1);
  const [rebuild] = await runPlan(mock, coded, ["build"]);
  assert.deepEqual(result(rebuild).uploads, []);
});

test("images: a build on a page that already shows the image fills from it and lists no upload", async () => {
  const fixture = loadTreeFixture("avatar");
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture]);
  const [build] = await runPlan(mock, coded, ["build"]);
  const [nodeId] = result(build).uploads[0];
  mock.uploadAssets([nodeId], [treeFixtureAsset("assets/513d06f54269-262b.jpg")]);
  const [rebuild] = await runPlan(mock, coded, ["build"]);
  assert.deepEqual(result(rebuild).uploads, []);
  const hashes = mock.nodes("FRAME").filter((n) => n.data["storysync.img"]).map((n) => (mock.handle(n.id).fills as { imageHash?: string }[])[0]?.imageHash);
  assert.equal(hashes.filter(Boolean).length, 3);
});

test("bindings: paints, text colors and radii bind to the variables their classes name, opacity kept", async () => {
  const button = copy(loadTreeFixture("button-icon"));
  // Its radius is bound: its transparent border paints nothing, so it is built at the border box.
  button.components[0].tree.base[0].cls = ["bg-primary", "rounded-md", "text-primary-foreground"];
  const toggle = copy(loadTreeFixture("toggle"));
  toggle.components[0].tree.base[0].cls = ["rounded-md"];
  const attachment = copy(loadTreeFixture("attachment"));
  attachment.components[0].tree.base[0].cls = ["border-destructive"];
  const card = copy(loadTreeFixture("card"));
  card.components[0].tree.base.find((n) => n.k === "card-header/card-title")!.cls = ["text-card-foreground"];
  for (const [fixture, check] of [
    [button, (mock: MockFigma, vars: Record<string, string>, r: BuildResult) => {
      const root = mock.handle(variantsBySlug(mock).get("variant-default--size-default")!.id) as Record<string, unknown>;
      const fill = (root.fills as { boundVariables?: { color: { id: string } }; opacity: number }[])[0];
      assert.equal(fill.boundVariables?.color.id, vars.primary);
      assert.deepEqual((root.boundVariables as Record<string, unknown>).topLeftRadius, { type: "VARIABLE_ALIAS", id: vars.md });
      const label = mock.nodes("TEXT").find((n) => n.name === "Login with Email Button")!;
      assert.equal((mock.handle(label.id).fills as { boundVariables?: { color: { id: string } } }[])[0].boundVariables?.color.id, vars["primary/foreground"]);
      assert.deepEqual(r.unbound, []);
    }],
    [toggle, (mock: MockFigma, vars: Record<string, string>) => {
      const root = mock.handle(variantsBySlug(mock).get("variant-default--size-default")!.id) as Record<string, unknown>;
      for (const corner of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]) {
        assert.deepEqual((root.boundVariables as Record<string, unknown>)[corner], { type: "VARIABLE_ALIAS", id: vars.md });
      }
    }],
    [attachment, (mock: MockFigma, vars: Record<string, string>) => {
      const root = mock.handle(variantsBySlug(mock).get("size-default--orientation-horizontal--state-error")!.id) as Record<string, unknown>;
      const stroke = (root.strokes as { boundVariables?: { color: { id: string } }; opacity: number }[])[0];
      assert.equal(stroke.boundVariables?.color.id, vars.destructive);
      assert.ok(Math.abs(stroke.opacity - 0.302) < 0.001, `opacity ${stroke.opacity}`);
    }],
    [card, (_mock: MockFigma, _vars: Record<string, string>, r: BuildResult) => {
      // The tokens name it, but the file has no variable of that name: left as measured, and listed.
      // Once, though both variants have it.
      assert.deepEqual(r.unbound.filter((u) => u[1] === "card-header/card-title"), [["ui/base/Card", "card-header/card-title", "color", "card/foreground: no variable has this name"]]);
    }],
  ] as const) {
    const recoded = await codeFor(fixture, {}, SHADCN_TOKENS);
    const mock = mockFor([fixture]);
    const vars: Record<string, string> = {};
    for (const [name, hex] of [["primary", "#171717"], ["primary/foreground", "#fafafa"], ["destructive", "#df2225"]]) vars[name] = mock.addVariable(name, "COLOR", hex).id;
    // A spacing step named like the radius: the one in a radius collection binds.
    mock.addVariable("md", "FLOAT", 12, "Spacing");
    vars.md = mock.addVariable("md", "FLOAT", 8, "Radius").id;
    const [build] = await runPlan(mock, recoded, ["build"]);
    (check as (m: MockFigma, v: Record<string, string>, r: BuildResult) => void)(mock, vars, result(build));
  }
});

test("bindings: a Button's radius binds wherever its border is built INSIDE at the border box, and the fill under a clear border is said", async () => {
  // The fifth live push's 97 Button frames: rounded-md, md = 8, a 1px
  // border with bg-clip-padding, all built OUTSIDE at radius 7, bound to
  // nothing, and nothing said. Outline's opaque border hides the background
  // under it, and link has none: both are built INSIDE at the border box,
  // radius 8, bound to md. Push 5b built default's and destructive's the
  // same way, OUTSIDE at radius 7: their transparent border paints
  // nothing, so they are built INSIDE at the border box too, radius 8,
  // bound to md, with the fill running under the clear stroke, said once.
  const button = copy(loadTreeFixture("button-icon"));
  button.components[0].tree.base[0].cls = ["bg-primary", "rounded-md", "text-primary-foreground"];
  const coded = await codeFor(button, {}, SHADCN_TOKENS);
  const mock = mockFor([button]);
  const md = mock.addVariable("md", "FLOAT", 8, "Radius").id;
  await runPlan(mock, coded, ["build"]);
  const built = variantsBySlug(mock);
  for (const variant of ["outline", "link", "default", "destructive"]) {
    // Link's other sizes are placeholders: snap couldn't measure them.
    for (const size of variant === "link" ? ["default"] : ["default", "xs", "sm"]) {
      const root = mock.handle(built.get(`variant-${variant}--size-${size}`)!.id) as Record<string, unknown>;
      assert.deepEqual([root.strokeAlign, root.cornerRadius, root.strokesIncludedInLayout], ["INSIDE", 8, true], `${variant} ${size}`);
      const corner = (root.boundVariables as Record<string, { id: string }>).topLeftRadius;
      assert.equal(corner?.id, md, `${variant} ${size}`);
    }
  }
  assert.deepEqual(coded.warnings.filter((w) => /radius|background-clip/.test(w)), [
    "ui/base/Button › (root): background-clip padding-box inside a transparent border is built as a fill to the border box, under the border's clear stroke",
  ]);
});

test("bindings: a variant copied from one whose radius is bound has its corners unbound where its own radius binds none, so a mode switch keeps its radius", async () => {
  // The Button's destructive variants with border-destructive/30: built
  // OUTSIDE at the padding box, radius 7, which no token holds. Each starts
  // as a copy of the default variant, whose radius 8 is bound to md, and
  // kept that binding, which a switch of the set's mode resolved to 8.
  const button = copy(loadTreeFixture("button-icon"));
  button.components[0].tree.base[0].cls = ["bg-primary", "rounded-md", "text-primary-foreground"];
  const side = { width: 1, style: "solid", color: "#df22254d" };
  for (const v of button.components[0].variants) {
    if (v.slug.startsWith("variant-destructive") && v.delta) Object.assign(v.delta, { border: { top: side, right: side, bottom: side, left: side }, borderUniform: side });
  }
  const coded = await codeFor(button, {}, SHADCN_TOKENS);
  const mock = mockFor([button]);
  const md = mock.addVariable("md", "FLOAT", { Light: 8, Dark: 8 }, "Radius").id;
  await runPlan(mock, coded, ["build"]);
  const built = variantsBySlug(mock);
  const corners = (slug: string) => {
    const root = mock.handle(built.get(slug)!.id) as Record<string, unknown>;
    return [root.cornerRadius, (root.boundVariables as Record<string, { id: string }>).topLeftRadius?.id];
  };
  assert.deepEqual(corners("variant-default--size-default"), [8, md]);
  assert.deepEqual(corners("variant-destructive--size-default"), [7, undefined]);
  const set = (mock.handle(built.get("variant-destructive--size-default")!.id) as { parent: { id: string } }).parent.id;
  const run = await mock.run(`const [md] = await figma.variables.getLocalVariablesAsync('FLOAT');
    const col = await figma.variables.getVariableCollectionByIdAsync(md.variableCollectionId);
    (await figma.getNodeByIdAsync('${set}')).setExplicitVariableModeForCollection(col, col.modes[1].modeId);`);
  assert.ok(run.ok, run.text);
  assert.deepEqual(corners("variant-destructive--size-default"), [7, undefined], "in Dark");
});

test("bindings: a variable with Light and Dark modes binds by its name, as one of one mode does, its paint showing Light", async () => {
  // The push makes a Dark mode for the dark theme's values. The build finds
  // a variable by name, so the modes change nothing it does: the paint is
  // bound, and shows the default mode's value, the light theme snap measured.
  const button = copy(loadTreeFixture("button-icon"));
  button.components[0].tree.base[0].cls = ["bg-primary", "rounded-md", "text-primary-foreground"];
  const coded = await codeFor(button, {}, SHADCN_TOKENS);
  const mock = mockFor([button]);
  const primary = mock.addVariable("primary", "COLOR", { Light: "#171717", Dark: "#e5e5e5" }, "Colors").id;
  const foreground = mock.addVariable("primary/foreground", "COLOR", { Light: "#fafafa", Dark: "#171717" }, "Colors").id;
  const [build] = await runPlan(mock, coded, ["build"]);
  // The other variants' tokens are no variable here; primary's are found.
  assert.equal(result(build).unbound.some((u) => /^primary/.test(u[3])), false, JSON.stringify(result(build).unbound));
  const root = mock.handle(variantsBySlug(mock).get("variant-default--size-default")!.id) as Record<string, unknown>;
  const fill = (root.fills as { boundVariables?: { color: { id: string } }; color: { r: number } }[])[0];
  assert.equal(fill.boundVariables?.color.id, primary);
  assert.equal(Math.round(fill.color.r * 255), 0x17);
  const label = mock.nodes("TEXT").find((n) => n.name === "Login with Email Button")!;
  assert.equal((mock.handle(label.id).fills as { boundVariables?: { color: { id: string } } }[])[0].boundVariables?.color.id, foreground);
});

test("bindings: what no class colors binds to the base styles' token, so Dark mode shows its dark value", async () => {
  // Dialog's title and Cancel inherit body's text-foreground; Attachment's
  // border is *'s border-border. #0a0a0a and #e5e5e5 are each several tokens.
  const tokens = {
    ...SHADCN_TOKENS,
    defaults: [
      { property: "color", token: "foreground", from: "app/globals.css, @layer base: body { @apply bg-background text-foreground }" },
      { property: "border-color", token: "border", from: "app/globals.css, @layer base: * { @apply border-border outline-ring/50 }" },
    ],
  };
  // snap says so (`nocls`), which these fixtures predate.
  const dialog = withNoClass(loadTreeFixture("dialog"), { "dialog-header/dialog-title": ["color"], "dialog-footer/dialog-close/#text": ["color"] });
  const attachment = withNoClass(loadTreeFixture("attachment"), { "": ["border-color"] });
  const mock = mockFor([dialog, attachment]);
  const foreground = mock.addVariable("foreground", "COLOR", { Light: "#0a0a0a", Dark: "#fafafa" }, "Colors").id;
  const border = mock.addVariable("border", "COLOR", { Light: "#e5e5e5", Dark: "#ffffff1a" }, "Colors").id;
  for (const fixture of [dialog, attachment]) {
    const coded = await codeFor(fixture, {}, tokens);
    // The fixture's fills carry no class: a background is no base style's.
    // Nor do Attachment's texts, which inherit its text-card-foreground,
    // and no nocls says no class colors them: they stay unbound.
    assert.equal(coded.warnings.some((w) => /stroke #\w+ left unbound|Dialog: color #\w+ left unbound/.test(w)), false, coded.warnings.join("\n"));
    await runPlan(mock, coded, ["build"]);
  }
  const fillOf = (name: string) => (mock.handle(mock.nodes("TEXT").find((n) => n.name === name)!.id).fills as { boundVariables?: { color: { id: string } } }[])[0];
  assert.equal(fillOf("Are you absolutely sure?").boundVariables?.color.id, foreground);
  assert.equal(fillOf("Cancel").boundVariables?.color.id, foreground);
  const root = mock.handle(variantsBySlug(mock, "ui-base-attachment").get("size-default--orientation-horizontal--state-done")!.id) as Record<string, unknown>;
  assert.equal((root.strokes as { boundVariables?: { color: { id: string } } }[])[0].boundVariables?.color.id, border);
});

/** Sets the mode of the frame `id` for the Colors collection: Light or Dark, or none, the default. */
async function switchMode(mock: MockFigma, id: string, mode: "Light" | "Dark" | null): Promise<void> {
  const run = await mock.run(`const [fg] = (await figma.variables.getLocalVariablesAsync('COLOR')).filter((v) => v.name === 'foreground');
    const col = await figma.variables.getVariableCollectionByIdAsync(fg.variableCollectionId);
    const n = await figma.getNodeByIdAsync('${id}');
    ${mode ? `n.setExplicitVariableModeForCollection(col, col.modes.find((m) => m.name === '${mode}').modeId);` : "n.clearExplicitVariableModeForCollection(col);"}`);
  assert.ok(run.ok, run.text);
}

/** Colors as push 5b's shadcn/ui tokens have them, light and dark, and their alpha variables as `figma tokens` makes them. */
function addColors(mock: MockFigma, alphas: boolean): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, light, dark] of [["foreground", "#0a0a0a", "#fafafa"], ["destructive", "#df2225", "#ff6467"]]) {
    vars[name] = mock.addVariable(name, "COLOR", { Light: light, Dark: dark }, "Colors").id;
    for (const [percent, aa] of alphas ? [["10", "1a"], ["30", "4d"], ["80", "cc"]] : []) {
      vars[`${name} ${percent}%`] = mock.addVariable(`${name} ${percent}%`, "COLOR", { Light: light + aa, Dark: dark + aa }, "Colors").id;
    }
  }
  return vars;
}

test("bindings: a dialog's ring binds to foreground 10%, which keeps its 10% in Dark and back in Light; without it, the ring stays unbound at its own alpha, said", async () => {
  // The fifth live push's Dialog: ring-1 ring-foreground/10, a spread-only
  // shadow. Probe 7b bound it to foreground at 10%, which Figma kept only
  // until the frame's mode changed: then it drew foreground opaque, in
  // Dark and back in Light. Probe 7c bound it to foreground 10%, a variable
  // that carries the alpha, which kept it through every switch.
  const dialog = loadTreeFixture("dialog");
  const coded = await codeFor(dialog, {}, SHADCN_TOKENS);
  assert.deepEqual(coded.plan.alphas, [{ variable: "foreground 10%", token: "foreground", alpha: 0.102, components: ["ui/base/Dialog"], collection: "Colors" }]);
  for (const alphas of [true, false]) {
    const mock = mockFor([dialog]);
    const vars = addColors(mock, alphas);
    const [build] = await runPlan(mock, coded, ["build"]);
    const variant = variantsBySlug(mock).get("default")!;
    const ring = () => (mock.handle(variant.id) as { effects: { type: string; spread: number; color: { r: number; a: number }; boundVariables?: { color?: { id: string } } }[] }).effects
      .map((e) => [e.type, e.spread, Math.round(e.color.r * 255), Math.round(e.color.a * 255), e.boundVariables?.color?.id]);
    const bound = alphas ? vars["foreground 10%"] : undefined;
    assert.deepEqual(ring(), [["DROP_SHADOW", 1, 0x0a, 0x1a, bound]]);
    assert.deepEqual(result(build).fallbacks, alphas ? [] : [["ui/base/Dialog", "", "no alpha variable foreground 10%: shadow unbound", 1]]);
    await switchMode(mock, variant.id, "Dark");
    assert.deepEqual(ring(), [["DROP_SHADOW", 1, alphas ? 0xfa : 0x0a, 0x1a, bound]], "in Dark");
    await switchMode(mock, variant.id, "Light");
    assert.deepEqual(ring(), [["DROP_SHADOW", 1, 0x0a, 0x1a, bound]], "back in Light");
  }
});

test("bindings: each translucent paint binds to its token's alpha variable, which keeps its alpha in Dark and back; without one, the token at its opacity, which the switch resets, said", async () => {
  // shadcn/ui's Attachment in its error state: border-destructive/30, a
  // bg-destructive/10 media frame and a text-destructive/80 description;
  // and the Button's bg-destructive/10. Bound to destructive at those
  // opacities, a switch to Dark made each opaque (probe 7b).
  const attachment = loadTreeFixture("attachment");
  const button = loadTreeFixture("button-icon");
  const coded = await codeFor({ ...attachment, components: [...attachment.components, ...button.components] }, {}, SHADCN_TOKENS);
  assert.deepEqual(coded.plan.alphas!.map((a) => a.variable), ["destructive 10%", "destructive 30%", "destructive 80%"]);
  for (const alphas of [true, false]) {
    const mock = mockFor([attachment, button]);
    const vars = addColors(mock, alphas);
    const builds = await runPlan(mock, coded, ["build"]);
    const built = [...variantsBySlug(mock, "ui-base-attachment")].filter(([slug]) => /state-error/.test(slug)).concat([...variantsBySlug(mock, "ui-base-button")].filter(([slug]) => /variant-destructive/.test(slug)));
    assert.equal(built.length, 5);
    // Every translucent paint of these variants, as built: where it is, then its color's red, its opacity's byte, and its variable.
    type Paint = { type: string; color: { r: number }; opacity: number; boundVariables?: { color?: { id: string } } };
    const paints = (id: string, key: "fills" | "strokes") => ((mock.handle(id) as Record<string, unknown>)[key] ?? []) as Paint[];
    const nodesOf = (v: NodeView): NodeView[] => [v, ...(v.children ?? []).flatMap(nodesOf)];
    const spots = built.flatMap(([slug, v]) => nodesOf(v).flatMap((n) => (["fills", "strokes"] as const).flatMap((key) => paints(n.id, key)
      .map((p, i) => ({ p, i })).filter(({ p }) => p.type === "SOLID" && p.boundVariables?.color && p.opacity < 0.99)
      .map(({ i }) => ({ id: n.id, key, i, where: `${slug} ${n.name} ${key}` })))));
    const read = () => spots.map((s) => {
      const p = paints(s.id, s.key)[s.i];
      return [s.where, Math.round(p.color.r * 255), Math.round(p.opacity * 255), p.boundVariables?.color?.id];
    });
    const light = read();
    // The media frame, the description and the border in 2 variants, the Button's fill in 3.
    assert.equal(light.length, 9, JSON.stringify(light));
    assert.ok(light.every((p) => p[1] === 0xdf));
    assert.deepEqual([...new Set(light.map((p) => p[2] as number))].sort((a, b) => a - b), [0x1a, 0x4d, 0xcc]);
    assert.deepEqual(new Set(light.map((p) => p[3])), alphas ? new Set([vars["destructive 10%"], vars["destructive 30%"], vars["destructive 80%"]]) : new Set([vars.destructive]));
    const fallbacks = builds.flatMap((b) => result(b).fallbacks).map((f) => f[2]);
    assert.deepEqual([...new Set(fallbacks)].sort(), alphas ? [] : ["destructive 10%", "destructive 30%", "destructive 80%"].map((n) => `no alpha variable ${n}: bound to destructive at its opacity`));
    // A designer switches each set to Dark, then back to Light.
    const sets = [...new Set(built.map(([, v]) => ((mock.handle(v.id) as { parent: { id: string } }).parent.id)))];
    for (const id of sets) await switchMode(mock, id, "Dark");
    const dark = read();
    if (alphas) assert.deepEqual(dark, light.map((p) => [p[0], 0xff, p[2], p[3]]), "in Dark");
    else assert.deepEqual(dark.map((p) => p[2]), light.map(() => 0xff), "each turned opaque in Dark");
    for (const id of sets) await switchMode(mock, id, "Light");
    if (alphas) assert.deepEqual(read(), light, "back in Light");
  }
});

test("bindings: built again into sets a designer left in Dark, every bound paint and shadow takes its variable's Dark value, as a switch would, a variant made there too, and back in Light each is Light's", async () => {
  // Figma keeps the color and opacity a paint bound to the same variable
  // again is given, the light theme's as measured, in Dark too; one bound
  // afresh takes the variable's value in the node's mode (probe 7c, call 3).
  // Attachment's border is * { border-border }, white at 10% in Dark; its
  // error state and the Button's destructive variants are translucent
  // destructive, the Dialog's ring foreground at 10%.
  const tokens = { ...SHADCN_TOKENS, defaults: [{ property: "border-color", token: "border", from: "app/globals.css, @layer base: * { @apply border-border }" }] };
  const attachment = withNoClass(loadTreeFixture("attachment"), { "": ["border-color"] });
  const dialog = loadTreeFixture("dialog");
  // The Button's first variant, here bg-destructive/10, which a build makes
  // afresh where its set lacks it, not as a copy of another variant.
  const button = copy(loadTreeFixture("button-icon"));
  button.components[0].base!.styles.backgroundColor = "#df22251a";
  button.components[0].tree.base[0].cls = ["bg-destructive"];
  const fixtures = [attachment, dialog, button];
  const coded = await codeFor({ ...attachment, components: fixtures.flatMap((f) => f.components) }, {}, tokens);
  for (const alphas of [true, false]) {
    const mock = mockFor(fixtures);
    addColors(mock, alphas);
    mock.addVariable("border", "COLOR", { Light: "#e5e5e5", Dark: "#ffffff1a" }, "Colors");
    await runPlan(mock, coded, ["build"]);
    const ids = (await mock.run("return Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.id, v.name]));")).value as Record<string, string>;
    // Every bound paint and shadow, by variant, layer and place: its red, alpha and variable.
    type Bound = { boundVariables?: { color?: { id: string } } };
    const read = () => {
      const out: Record<string, [number, number, string]> = {};
      for (const [slug, variant] of variantsBySlug(mock)) {
        const walk = (n: NodeView) => {
          const h = mock.handle(n.id) as Record<string, unknown>;
          const at = `${slug}/${n.data["storysync.k"] ?? ""}`;
          for (const key of ["fills", "strokes"] as const) {
            ((h[key] ?? []) as ({ type: string; color?: { r: number }; opacity: number } & Bound)[]).forEach((p, i) => {
              if (p.boundVariables?.color) out[`${at} ${key} ${i}`] = [Math.round(p.color!.r * 255), Math.round(p.opacity * 255), ids[p.boundVariables.color.id]];
            });
          }
          ((h.effects ?? []) as ({ color?: { r: number; a: number } } & Bound)[]).forEach((e, i) => {
            if (e.boundVariables?.color) out[`${at} effects ${i}`] = [Math.round(e.color!.r * 255), Math.round(e.color!.a * 255), ids[e.boundVariables.color.id]];
          });
          for (const c of n.children ?? []) walk(c);
        };
        walk(variant);
      }
      return out;
    };
    const light = read();
    assert.ok(Object.values(light).some(([, , v]) => v === "border"), "the border is bound");
    // Each set, and the Dialog, a plain component, itself: not the page around them.
    const sets = [...new Set([...variantsBySlug(mock)].map(([, v]) => {
      const parent = (mock.handle(v.id) as { parent: { id: string; type: string } }).parent;
      return parent.type === "COMPONENT_SET" ? parent.id : v.id;
    }))];
    for (const id of sets) await switchMode(mock, id, "Dark");
    const dark = read();
    // A designer's switch: border takes its Dark alpha, 10%; with alpha variables, each keeps its alpha in Dark's color.
    for (const [where, [r, a, v]] of Object.entries(dark)) {
      if (v === "border") assert.deepEqual([r, a], [0xff, 0x1a], where);
      if (alphas && /%$/.test(v)) assert.equal(a, light[where][1], where);
    }
    // Variants gone, as a snap adds them: made again, in their set's Dark,
    // the Attachment's as a copy of another, the Button's first afresh.
    const gone = ["size-default--orientation-horizontal--state-error", "variant-default--size-default"];
    for (const [component, slug] of [["ui-base-attachment", gone[0]], ["ui-base-button", gone[1]]]) {
      const removed = await mock.run(`(await figma.getNodeByIdAsync('${variantsBySlug(mock, component).get(slug)!.id}')).remove();`);
      assert.ok(removed.ok, removed.text);
    }
    const builds = await runPlan(mock, coded, ["build"]);
    const again = read();
    if (alphas) assert.deepEqual(again, dark, "built again in Dark, as a switch to Dark left them");
    else {
      // Without alpha variables, a paint bound to destructive at its opacity
      // keeps the opacity measured, in Dark's color; every other paint is as a switch left it.
      for (const [where, [r, a, v]] of Object.entries(again)) {
        if (v === "destructive" && light[where][1] < 0xff) assert.deepEqual([r, a], [0xff, light[where][1]], where);
        else assert.deepEqual([r, a, v], dark[where], where);
      }
      assert.ok(builds.some((b) => result(b).fallbacks.some((f) => /^no alpha variable destructive 10%/.test(f[2]))));
    }
    for (const slug of gone) assert.ok(Object.keys(again).some((k) => k.startsWith(`${slug}/`)), `${slug}, made again, is read`);
    for (const id of sets) await switchMode(mock, id, "Light");
    if (alphas) assert.deepEqual(read(), light, "back in Light");
  }
});

test("label: a set measured from its closed trigger says so on one line, written once, its description unescaped", async () => {
  const fixture = copy(loadTreeFixture("switch"));
  fixture.components[0].warnings = ['snap measured button[data-slot="dialog-trigger"], a closed trigger, rather than Switch. What it opens renders only while open.'];
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture]);
  const [build] = await runPlan(mock, coded, ["build"]);
  const setId = result(build).sets[0].id;
  // Figma hands a description back HTML-escaped.
  (mock.handle(setId) as Record<string, unknown>).description = "Use &quot;on&quot; for a setting";
  const [label] = await runPlan(mock, coded, ["label"]);
  assert.deepEqual((label.value as { changed: string[] }).changed, [setId]);
  assert.equal(mock.handle(setId).description, 'Use "on" for a setting\nstorysync: measured from its closed trigger, button[data-slot=dialog-trigger], not the open Switch');
  const [again] = await runPlan(mock, coded, ["label"]);
  assert.deepEqual((again.value as { changed: string[]; missing: string[] }), { kind: "label", changed: [], missing: [], pageOne: (again.value as { pageOne: string }).pageOne });
});

test("label: Figma's empty Page 1 is removed once the sets are on their own page, and kept when it holds anything", async () => {
  const fixture = loadTreeFixture("switch");
  const coded = await codeFor(fixture);
  for (const [setup, pageOne, pages] of [
    ["", "removed", ["ui/base"]],
    ["figma.createFrame();", "kept: it holds layers", ["Page 1", "ui/base"]],
  ] as const) {
    const mock = mockFor([fixture], { pages: ["Page 1"] });
    if (setup) await mock.run(setup);
    await runPlan(mock, coded, ["build"]);
    const [label] = await runPlan(mock, coded, ["label"]);
    assert.equal((label.value as { pageOne: string }).pageOne, pageOne);
    assert.deepEqual(mock.pages().map((p) => p.name), pages);
    assert.equal(label.switches.length, pageOne === "removed" ? 1 : 0, "off it only to remove it");
  }
  // A file whose only page is Page 1 keeps it.
  const alone = mockFor([fixture], { pages: ["Page 1"] });
  const run = await alone.run(coded.code(coded.plan.calls.find((c) => c.kind === "label")!));
  assert.deepEqual(run.value, { kind: "label", changed: [], missing: ["ui-base-switch"], pageOne: "kept: it is the only page" });
});

test("spike item 1: icons import at their measured size, as Figma scales their strokes; the fallback rescales", async () => {
  const fixture = loadTreeFixture("toggle");
  const weights = async (mockOptions: MockFigmaOptions, svgStrokesScale?: boolean) => {
    const { mock } = await buildAll(fixture, mockOptions, svgStrokesScale === undefined ? {} : { spike: { svgStrokesScale } });
    return [...new Set(mock.nodes("VECTOR").map((n) => Math.round((mock.handle(n.id).strokeWeight as number) * 100) / 100))];
  };
  // lucide's 2 at 24 drawn at 16, as the browser draws it and the spike saw Figma import it.
  assert.deepEqual(await weights({}), [1.33]);
  assert.deepEqual(await weights({}, false), [1.33], "imported at 24 and rescaled, the same");
  // Where a Figma kept the strokes as written, only the fallback would be right.
  assert.deepEqual(await weights({ svgStrokeScales: false }), [2]);
  assert.deepEqual(await weights({ svgStrokeScales: false }, false), [1.33]);
});

test("spike item 2: a shadow's spread on a frame something draws past is built without it, and said; one Figma refuses anyway is left out, and said", async () => {
  const fixture = copy(loadTreeFixture("switch"));
  fixture.components[0].base!.styles.boxShadow = [{ offsetX: 0, offsetY: 0, blur: 0, spread: 1, color: "#0a0a0a1a", inset: false }];
  // A thumb whose shadow draws past the root, which figma code then can't clip for the spread (spreadDrawn).
  fixture.components[0].tree.base.find((n) => n.k !== "")!.sh = [[0, 0, 8, 0, "#0000001a"]];
  const coded = await codeFor(fixture);
  assert.ok(coded.warnings.some((w) => w.includes("(root): a shadow's spread on a frame whose content draws past it is built as the shadow without its spread")), coded.warnings.join("\n"));
  // Built as said, without the spread Figma wouldn't draw, which the readback then reads and verify scores.
  const mock = mockFor([fixture], { shadowSpread: "refuse" });
  const runs = await runPlan(mock, coded, ["build"]);
  assert.deepEqual(result(runs[0]).fallbacks, []);
  const root = () => mock.handle(variantsBySlug(mock).get("size-default")!.id) as { effects: { spread: number }[] };
  assert.equal(root().effects[0].spread, 0);
  // A call that asks for the spread anyway: Figma refuses it, and the build says so, once for the root in both variants.
  const code = coded.code(coded.plan.calls.find((c) => c.kind === "build")!);
  const data = JSON.parse(/\nconst DATA = (.*);\n/.exec(code)![1]) as { S: unknown[] };
  for (const st of data.S) if (st && typeof st === "object" && "e" in st) (st as { e: unknown[][] }).e = (st as { e: unknown[][] }).e.map((e) => (e.length > 2 && e[4] === 0 && e[3] === 0 ? [...e.slice(0, 4), 1, ...e.slice(5)] : e));
  const run = await mock.run(withConstant(code, "DATA", data));
  assert.ok(run.ok, run.text);
  assert.equal(result(run).fallbacks.length, 1);
  assert.deepEqual(result(run).fallbacks[0].map((v, i) => (i === 2 ? String(v).replace(/: .*/, "") : v)), ["ui/base/Switch", "", "shadow spread left out", 2]);
  assert.equal(root().effects[0].spread, 0);
});

test("spike item 3: truncation Figma refuses is built as a text box of the measured size", async () => {
  const fixture = loadTreeFixture("attachment");
  const { mock, results } = await buildAll(fixture, { textTruncation: "refuse" });
  assert.ok(results[0].fallbacks.every((f) => /truncation refused/.test(f.join(" "))));
  const title = mock.nodes("TEXT").find((n) => n.data["storysync.k"] === "attachment-content/attachment-title" && n.width === 94)!;
  assert.deepEqual([mock.handle(title.id).textAutoResize, title.width, title.height], ["NONE", 94, 17.5]);
});

test("spike item 11: a frame hugs across a child that fills it, as Figma stretches it; the fallback doesn't rely on that", async () => {
  // Each of Card's notifications hugs its first line and stretches the second across it, which a Figma that refused would collapse.
  await assert.rejects(buildAll(loadTreeFixture("card"), { fillAcrossHug: "refuse" }), /FILL across a parent that hugs/);
  for (const name of treeFixtureNames()) await buildAll(loadTreeFixture(name), { fillAcrossHug: "refuse" }, { spike: { fillAcrossHug: false } });
});

test("build: an SVG Figma won't import is an empty keyed frame, named so, tried again next time", async () => {
  const fixture = copy(loadTreeFixture("toggle"));
  fixture.components[0].tree.assets.svg["svg:3a1614af"] = "<svg-not-really/>";
  const { coded, mock, results } = await buildAll(fixture);
  assert.equal(results[0].fallbacks.length, 1);
  assert.match(results[0].fallbacks[0].join("|"), /^ui\/base\/Toggle\|svg\|svg import failed: .*\|6$/);
  const failed = mock.nodes("FRAME").filter((n) => n.data["storysync.k"] === "svg");
  assert.deepEqual([...new Set(failed.map((n) => [n.name, n.width, n.height, n.children!.length].join()))], ["svg (import failed),16,16,0"]);
  const [again] = await runPlan(mock, coded, ["build"]);
  assert.equal(result(again).fallbacks[0][3], 6, "the import is tried again");
});

test("build: a response stays under use_figma's 20kb when every fallback fires, and keeps its uploads", async () => {
  // Sidebar's 25 nodes as 60 variants, every icon one Figma won't import, every truncation and spread refused.
  const snap = copy(loadTreeFixture("sidebar"));
  const component = snap.components[0];
  component.variantProperties = [{ name: "n", type: "VARIANT", values: Array.from({ length: 60 }, (_, i) => String(i)), defaultValue: "0" }];
  component.variants = Array.from({ length: 60 }, (_, i) => ({ ...copy(component.variants[0]), combination: { n: String(i) }, slug: `n-${i}`, ...(i ? { treeDelta: {} } : {}) }));
  component.base = { ...component.base!, combination: { n: "0" }, slug: "n-0" };
  for (const id of Object.keys(component.tree.assets.svg)) component.tree.assets.svg[id] = "<svg-not-really/>";
  // Every node a key of its own in `unbound` too: a name no variable has.
  component.tree.base.forEach((n) => { if (n.t === "F" && !n.bg) n.bg = "#171717"; n.cls = ["bg-primary"]; });
  snap.components.push(copy(loadTreeFixture("avatar").components[0]));
  // And 380 icons in one variant, each its own key, none of which imports.
  const icons = synthetic("Icons", [
    { k: "", t: "F", el: "div", box: [0, 0, 16, 380 * 16], L: { d: "flex", dir: "column" } },
    ...Array.from({ length: 380 }, (_, i): TreeNode => ({ k: i ? `svg:${i + 1}` : "svg", t: "V", el: "svg.lucide-circle", box: [0, i * 16, 16, 16], svg: "svg:x", shapes: [[2, 2, 12, 12]] })),
  ], { width: 16, height: 380 * 16, display: "flex" }, { "svg:x": "<svg-not-really/>" });
  snap.components.push(icons.components[0]);
  const coded = await codeFor(snap, {}, SHADCN_TOKENS);
  const mock = mockFor([snap as TreeFixture], { textTruncation: "refuse", shadowSpread: "refuse" });
  const runs = await runPlan(mock, coded, ["build"]);
  for (const run of runs) assert.ok(run.bytes <= 16_500, `${run.bytes} bytes`);
  // Sidebar's: each once per key, with how many variants it happened in.
  const sidebar = runs.map(result).filter((r) => r.sets.some((set) => set.component === "ui-base-sidebar"));
  assert.ok(sidebar.length > 1 && sidebar.every((r) => r.fallbacks.length && r.fallbacks.every(([, , , n]) => n === r.sets[0].added)));
  assert.deepEqual(runs.flatMap((r) => result(r).uploads.map((u) => u[1])), ["img:513d06f54269-262b"], "the upload is kept");
  // The icons' 380 keys don't fit: half and half again go, and are counted.
  const many = result(runs.find((r) => result(r).page === "test")!);
  assert.equal(many.fallbacks.length + many.omitted!, 380);
  assert.ok(many.fallbacks.length >= 95, `${many.fallbacks.length} kept`);
});

test("build: a component whose root is an icon holds the icon's shapes itself, replaced only when the icon changes", async () => {
  const spinner = (markup: string, id: string) => synthetic("Spinner", [
    { k: "", t: "V", el: "svg.lucide-loader-circle", box: [0, 0, 16, 16], svg: id, shapes: [[2, 2, 12, 12]] },
  ], { width: 16, height: 16, display: "block" }, { [id]: markup });
  const ring = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  const first = spinner(ring, "svg:ring");
  const coded = await codeFor(first);
  const mock = mockFor([first]);
  const [build] = await runPlan(mock, coded, ["build"]);
  const root = variantsBySlug(mock).get("default")!;
  assert.deepEqual(root.children!.map((c) => c.type), ["VECTOR"]);
  assert.equal(result(build).sets[0].designerLayers, 0);
  const again = await runPlan(mock, coded, ["build"]);
  assert.deepEqual([again[0].created, again[0].removed], [0, 0]);
  const next = spinner(ring.replace("M21 12", "M22 12"), "svg:ring2");
  await runPlan(mock, await codeFor(next), ["build"]);
  assert.equal(variantsBySlug(mock).get("default")!.children!.length, 1, "the old icon's shapes went with it");
});

/** Every layer under a view, depth first. */
const under = (view: NodeView): NodeView[] => (view.children ?? []).flatMap((c) => [c, ...under(c)]);

/** The paints of an icon's shapes, the layers under `view` with any. */
function shapePaints(mock: MockFigma, view: NodeView): string {
  return JSON.stringify(under(view).map((v) => mock.handle(v.id) as { fills?: unknown; strokes?: unknown }).map((h) => [h.fills, h.strokes]));
}

/** A designer's recolor: every paint of every shape under `view` made magenta. */
function recolor(mock: MockFigma, view: NodeView): void {
  const magenta = [{ type: "SOLID", color: { r: 1, g: 0, b: 1 } }];
  for (const v of under(view)) {
    const h = mock.handle(v.id) as { fills?: unknown[]; strokes?: unknown[] };
    if (h.fills?.length) h.fills = magenta;
    if (h.strokes?.length) h.strokes = magenta;
  }
}

test("build: an icon a designer recolored is imported again as measured, and the build after that keeps it", async () => {
  // The build sets an icon's shapes only by importing them, so it kept a
  // recolored icon as it was, and a repair by sending the build again left
  // the designer's colors for verify to report as a limit of the mapping.
  const fixture = loadTreeFixture("attachment");
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture]);
  await runPlan(mock, coded, ["build"]);
  const key = "attachment-media/svg";
  const [slug] = [...variantsBySlug(mock)].find(([, v]) => keyed(v, key))!;
  const icon = () => keyed(variantsBySlug(mock).get(slug)!, key)!;
  const built = icon();
  const measured = shapePaints(mock, built);
  recolor(mock, built);
  assert.notEqual(shapePaints(mock, icon()), measured);
  await runPlan(mock, coded, ["build"]);
  assert.equal(shapePaints(mock, icon()), measured, "the recolored icon was kept");
  assert.notEqual(icon().id, built.id, "imported again, as the build makes an icon");
  const repaired = icon().id;
  const [again] = await runPlan(mock, coded, ["build"]);
  assert.deepEqual([again.created, again.removed], [0, 0], "an icon as the build left it is imported again");
  assert.equal(icon().id, repaired);
});

test("build: a root icon a designer recolored is imported again as measured", async () => {
  const fixture = spinners();
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture]);
  await runPlan(mock, coded, ["build"]);
  const root = () => variantsBySlug(mock).get("size-sm")!;
  const measured = shapePaints(mock, root());
  recolor(mock, root());
  await runPlan(mock, coded, ["build"]);
  assert.equal(shapePaints(mock, root()), measured, "the recolored root icon was kept");
  assert.deepEqual(root().children!.map((c) => [c.type, c.data["storysync.vs"]]), [["VECTOR", "1"]], "the old shapes stayed beside the new");
  const [again] = await runPlan(mock, coded, ["build"]);
  assert.deepEqual([again.created, again.removed], [0, 0]);
});

const RING = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

/** A two-variant component whose root is an icon, as shadcn's Spinner, the second a size larger. */
function spinners(): TreeFixture {
  const fixture = synthetic("Spinner", [
    { k: "", t: "V", el: "svg.lucide-loader-circle", box: [0, 0, 16, 16], svg: "svg:ring", shapes: [[2, 2, 12, 12]] },
  ], { width: 16, height: 16, display: "block" }, { "svg:ring": RING });
  const component = fixture.components[0];
  component.variantProperties = [{ name: "size", type: "VARIANT", values: ["sm", "lg"], defaultValue: "sm" }];
  component.base = { ...component.base!, combination: { size: "sm" }, slug: "size-sm" };
  component.variants = [
    { combination: { size: "sm" }, slug: "size-sm", status: "ok", error: null, delta: {} },
    { combination: { size: "lg" }, slug: "size-lg", status: "ok", error: null, delta: { width: 24, height: 24 }, treeDelta: { set: { "": { box: [0, 0, 24, 24], shapes: [[3, 3, 18, 18]] } } } } as never,
  ];
  return fixture;
}

test("build: a variant copied from an icon-root variant keeps the icon's shapes, whether or not clone() keeps plugin data", async () => {
  for (const clonePluginData of [true, false]) {
    const fixture = spinners();
    const coded = await codeFor(fixture);
    const mock = mockFor([fixture], { clonePluginData });
    const [build] = await runPlan(mock, coded, ["build"]);
    assert.equal(result(build).sets[0].designerLayers, 0, `clonePluginData ${clonePluginData}`);
    // Keeping plugin data, as the spike saw clone() do, the copy keeps the shapes it was made
    // with: the one layer removed is the first import's own frame, emptied of its shapes.
    // Without it, the copy's unmarked shapes go too, and the icon is imported again.
    assert.equal(build.removed, clonePluginData ? 1 : 3, `clonePluginData ${clonePluginData}`);
    for (const [slug, size] of [["size-sm", 16], ["size-lg", 24]] as const) {
      const variant = variantsBySlug(mock).get(slug)!;
      assert.deepEqual(variant.children!.map((c) => [c.type, c.data["storysync.vs"]]), [["VECTOR", "1"]], `${slug}, clonePluginData ${clonePluginData}`);
      assert.deepEqual([variant.data["storysync.svg"], variant.width], ["svg:ring", size]);
    }
    const again = await runPlan(mock, coded, ["build"]);
    assert.deepEqual([again[0].created, again[0].removed], [0, 0]);
  }
});

test("build: a root that changes kind between snaps leaves nothing of what it was", async () => {
  const icon = spinners();
  icon.components[0].variants = icon.components[0].variants.slice(0, 1);
  const frame = synthetic("Spinner", [
    { k: "", t: "F", el: "span", box: [0, 0, 16, 16], L: { d: "block" } },
    { k: "svg", t: "V", el: "svg.lucide-loader-circle", box: [0, 0, 16, 16], svg: "svg:ring", shapes: [[2, 2, 12, 12]] },
  ], { width: 16, height: 16, display: "block" }, { "svg:ring": RING });
  const mock = mockFor([icon, frame]);
  const shape = () => {
    const root = variantsBySlug(mock).get("default") ?? variantsBySlug(mock).get("size-sm")!;
    return [root.data["storysync.svg"] ?? "", root.children!.map((c) => [c.type, c.data["storysync.k"] ?? "", c.data["storysync.vs"] ?? ""])];
  };
  await runPlan(mock, await codeFor(frame), ["build"]);
  assert.deepEqual(shape(), ["", [["FRAME", "svg", ""]]]);
  // A COMPONENT, so found by its name and rebuilt in place: from a frame with an icon to the icon itself, and back.
  const iconOnly = copy(icon);
  iconOnly.components[0].variantProperties = [];
  iconOnly.components[0].variants[0].combination = {};
  iconOnly.components[0].base!.combination = {};
  await runPlan(mock, await codeFor(iconOnly), ["build"]);
  assert.deepEqual(shape(), ["svg:ring", [["VECTOR", "", "1"]]]);
  await runPlan(mock, await codeFor(frame), ["build"]);
  assert.deepEqual(shape(), ["", [["FRAME", "svg", ""]]]);
});

test("build: a root icon Figma won't import is tried again next time", async () => {
  const fixture = spinners();
  fixture.components[0].tree.assets.svg["svg:ring"] = "<svg-not-really/>";
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture]);
  await runPlan(mock, coded, ["build"]);
  assert.equal(variantsBySlug(mock).get("size-sm")!.data["storysync.svg"], "failed");
  const [again] = await runPlan(mock, coded, ["build"]);
  assert.ok(result(again).fallbacks.length > 0, "the import is tried again");
});

/** Adds a designer's text, in a font no build uses, to the layer keyed `key` (or the variant) of the built variant `slug`. */
async function designerText(mock: MockFigma, slug: string, key = ""): Promise<void> {
  const variant = variantsBySlug(mock).get(slug)!;
  const target = key ? keyed(variant, key)! : variant;
  const run = await mock.run(`
    const page = figma.root.children.find((p) => p.name === 'ui/base');
    await figma.setCurrentPageAsync(page);
    await figma.loadFontAsync({ family: 'Roboto Mono', style: 'Regular' });
    const t = figma.createText();
    t.fontName = { family: 'Roboto Mono', style: 'Regular' };
    t.characters = 'note';
    page.findOne((n) => n.id === ${JSON.stringify(target.id)}).appendChild(t);
  `);
  assert.ok(run.ok, run.text);
}

test("build: a layer that moves is moved with every font in it loaded, a designer's text's included", async () => {
  const row = (a: number, b: number) => synthetic("Row", [
    { k: "", t: "F", el: "div", box: [0, 0, 100, 20], L: { d: "flex" } },
    { k: "a", t: "F", el: "span", box: [a, 0, 50, 20], bg: "#eeeeee" },
    { k: "b", t: "F", el: "span", box: [b, 0, 50, 20], bg: "#dddddd" },
  ], { width: 100, height: 20, display: "flex", backgroundColor: "#ffffff" }, {}, { category: "ui/base" });
  const mock = mockFor([row(0, 50)]);
  await runPlan(mock, await codeFor(row(0, 50)), ["build"]);
  await designerText(mock, "default", "a");
  // b now flows first: a, with the designer's text in Roboto Mono, moves after it.
  const [build] = await runPlan(mock, await codeFor(row(50, 0)), ["build"]);
  assert.equal(result(build).sets[0].designerLayers, 1);
  assert.deepEqual(variantsBySlug(mock).get("default")!.children!.map((c) => c.data["storysync.k"]), ["b", "a"]);
});

test("build: a variant another call built is moved in the set's grid with its fonts loaded", async () => {
  const fixture = loadTreeFixture("switch");
  // One variant a call: the second call lays out the set, moving the first variant.
  const coded = await codeFor(fixture, { maxNodes: 1 });
  const mock = mockFor([fixture]);
  const [first, second] = coded.plan.calls.filter((c) => c.kind === "build");
  const one = await mock.run(coded.code(first));
  assert.ok(one.ok, one.text);
  await designerText(mock, "size-default");
  const two = await mock.run(coded.code(second));
  assert.ok(two.ok, two.text);
  assert.deepEqual(result(two).sets[0].variants, 2);
});

test("build: a set the user must answer for is refused and left as it was, and the call builds the others in it", async () => {
  // Toggle first: its refusal stops nothing after it.
  const snap = copy(loadTreeFixture("switch"));
  snap.components.unshift(copy(loadTreeFixture("toggle").components[0]));
  const coded = await codeFor(snap);
  const mock = mockFor([loadTreeFixture("switch"), loadTreeFixture("toggle")]);
  await mock.run(`
    const page = figma.createPage();
    page.name = 'ui/base';
    await figma.setCurrentPageAsync(page);
    for (const x of [0, 200]) {
      const v = figma.createComponent();
      v.name = 'variant=default, size=default';
      const set = figma.combineAsVariants([v], page);
      set.name = 'Toggle';
      set.x = x;
    }
  `);
  const toggles = () => JSON.stringify(mock.pages()[0].children!.filter((n) => n.name === "Toggle"));
  const before = toggles();
  const call = coded.plan.calls[0];
  assert.deepEqual(call.components, ["ui/base/Toggle", "ui/base/Switch"]);
  const run = await mock.run(coded.code(call));
  assert.ok(run.ok, run.text);
  const sets = result(run).sets as { component: string; refused?: string; variants?: number }[];
  const toggle = sets.find((s) => s.component === "ui-base-toggle")!;
  assert.match(toggle.refused!, /^The page has COMPONENT_SET "Toggle" .*, COMPONENT_SET "Toggle" .*: ask the user which to update$/);
  assert.deepEqual(Object.keys(toggle).sort(), ["component", "name", "refused"]);
  assert.equal(toggles(), before, "Toggle's sets are as they were");
  assert.equal(sets.find((s) => s.component === "ui-base-switch")!.variants, loadTreeFixture("switch").components[0].variants.length, "Switch is built");
});

/** The error every call throws when it fails its SUM. */
const CHANGED_CALL = /^Error: This call differs from the file storysync figma code wrote: its data fails its checksum, SUM\. Nothing was changed\. Send the file again, exactly as it is\.$/;
/** The error every call throws when its template fails its TSUM. */
const CHANGED_TEMPLATE = /^Error: This call differs from the file storysync figma code wrote: its template fails its checksum, TSUM\. Nothing was changed\. Send the file again, exactly as it is\.$/;

/** `code` with the first digit of its template, the string T, one more, as a mistyped number: keepLines' 1.27 in the build's. */
function templateDigitOff(code: string, after = ""): string {
  const at = code.indexOf(after, code.indexOf("\nconst T = "));
  const digit = at + /\d/.exec(code.slice(at))!.index;
  return code.slice(0, digit) + String((Number(code[digit]) + 1) % 10) + code.slice(digit + 1);
}

test("build, images and label: a call one character off the file figma code wrote is refused, and changes nothing", async () => {
  // Avatar's picture makes an images call, Card's icon a path to mistype.
  const snap = copy(loadTreeFixture("avatar"));
  snap.components.push(copy(loadTreeFixture("card").components[0]));
  const coded = await codeFor(snap);
  const code = (kind: string) => coded.code(coded.plan.calls.find((c) => c.kind === kind)!);
  assert.deepEqual(coded.plan.calls.map((c) => c.kind), ["build", "images", "label", "read"]);
  const build = code("build");
  // As the fourth live push's agent pasted `1.790` for `1.79` in an icon's
  // path: the same number, but not the call figma code wrote. And a digit
  // changed, a variant's name, and the SUM itself.
  const svg = build.indexOf("<svg");
  assert.ok(svg > 0, "the call holds an icon");
  const number = /\d\.\d+/.exec(build.slice(svg))!;
  const end = svg + number.index + number[0].length;
  const digit = build[end - 1] === "9" ? "8" : "9";
  const name = /"(size=[^"]+)"/.exec(build)!;
  const sum = /const SUM = "(.)/.exec(build)!;
  const changes = [
    build.slice(0, end) + "0" + build.slice(end),
    build.slice(0, end - 1) + digit + build.slice(end),
    build.replace(name[0], `"${name[1]} "`),
    build.replace(sum[0], `const SUM = "${sum[1] === "0" ? "1" : "0"}`),
  ];
  const mock = mockFor([loadTreeFixture("avatar"), loadTreeFixture("card")], { pages: ["Page 1"] });
  const before = JSON.stringify(mock.pages());
  for (const changed of changes) {
    assert.equal(changed.length - build.length <= 1 && changed !== build, true);
    const run = await mock.run(changed);
    assert.equal(run.ok, false);
    assert.match(run.text, CHANGED_CALL);
    assert.deepEqual([run.created, run.switches, JSON.stringify(mock.pages())], [0, [], before], "not even its page made");
  }
  // The file as written builds.
  await runPlan(mock, coded, ["build"]);
  const built = JSON.stringify(mock.pages());
  for (const kind of ["images", "label"]) {
    const call = code(kind);
    // The page's name in the call's constant, not in the comment above it.
    const page = call.indexOf("ui/base", call.indexOf("\nconst "));
    const run = await mock.run(call.slice(0, page) + "ui/Base" + call.slice(page + "ui/base".length));
    assert.match(run.text, CHANGED_CALL, kind);
    assert.deepEqual([run.created, run.removed, run.switches, JSON.stringify(mock.pages())], [0, 0, [], built], `${kind}: Page 1 kept, nothing filled`);
  }
  await runPlan(mock, coded, ["images", "label"]);
});

test("build, images and label: a call whose template is one character off is refused, and changes nothing", async () => {
  const snap = copy(loadTreeFixture("avatar"));
  snap.components.push(copy(loadTreeFixture("card").components[0]));
  const coded = await codeFor(snap);
  const code = (kind: string) => coded.code(coded.plan.calls.find((c) => c.kind === kind)!);
  const mock = mockFor([loadTreeFixture("avatar"), loadTreeFixture("card")], { pages: ["Page 1"] });
  const before = JSON.stringify(mock.pages());
  // keepLines' 1.27, the line height it takes for a font's own, as 2.27:
  // every label kept on its lines by a different measure, without a word.
  const build = code("build");
  assert.ok(build.includes("||1.27"), "keepLines' fallback line height is in the call");
  for (const changed of [templateDigitOff(build, "||1.27"), templateDigitOff(build)]) {
    const run = await mock.run(changed);
    assert.match(run.text, CHANGED_TEMPLATE);
    assert.deepEqual([run.created, run.switches, JSON.stringify(mock.pages())], [0, [], before], "not even its page made");
  }
  // The file as written builds, and says its template was checked.
  const [ran] = await runPlan(mock, coded, ["build"]);
  assert.equal((ran.value as { tc: number }).tc, 1);
  const built = JSON.stringify(mock.pages());
  for (const kind of ["images", "label"]) {
    const run = await mock.run(templateDigitOff(code(kind)));
    assert.match(run.text, CHANGED_TEMPLATE, kind);
    assert.deepEqual([run.created, run.removed, run.switches, JSON.stringify(mock.pages())], [0, 0, [], built], kind);
  }
});

test("build: where use_figma rewrites a call, a changed template is still refused, and an honest one says it was checked", async () => {
  // The sixth probe (fixtures/figma-tsum-probe.json, call 2) saw use_figma
  // give back the guard's `async()=>{\nreturn 1.50}` reprinted, as
  // `async () => {\n      return 1.50;}`: 0.4.0's guard, which compared a
  // function's text, then skipped the check, in every build of the fifth
  // live push. Function.prototype.toString here reprints every function so.
  const probe = JSON.parse(readFileSync(new URL("../../../cli/__tests__/fixtures/figma-tsum-probe.json", import.meta.url), "utf8")) as { call2: { p: string; tc: number } };
  assert.deepEqual([probe.call2.p, probe.call2.tc], ["async () => {\n      return 1.50;}", 0]);
  const coded = await codeFor(loadTreeFixture("switch"));
  const build = coded.code(coded.plan.calls.find((c) => c.kind === "build")!);
  const original = Function.prototype.toString;
  Function.prototype.toString = function (this: () => unknown) {
    return original.call(this).replace(/^async\(\)=>\{\n/, "async () => {\n      ").replace(/\}$/, ";}");
  };
  try {
    const mock = mockFor([loadTreeFixture("switch")], { pages: ["Page 1"] });
    const before = JSON.stringify(mock.pages());
    const changedData = await mock.run(build.replace(/"size=([^"]+)"/, '"size=$1 "'));
    assert.match(changedData.text, CHANGED_CALL);
    const changed = await mock.run(templateDigitOff(build, "||1.27"));
    assert.match(changed.text, CHANGED_TEMPLATE);
    assert.deepEqual([changed.created, JSON.stringify(mock.pages())], [0, before], "nothing changed");
    const run = await mock.run(build);
    assert.ok(run.ok, run.text);
    assert.equal((run.value as { tc: number }).tc, 1);
  } finally {
    Function.prototype.toString = original;
  }
});

test("build: the set's grid gives each variant the room it draws in: a label past its icon button, a shadow, overlap nothing", async () => {
  // push3's base Button: at size icon the button is 36 by 36 and its icon
  // and label, centered, overflow it on both sides, as the browser draws
  // them. Laid out by their boxes, the label covered the next column's
  // button. Raised adds shadow-2xl, 63px below the button.
  const fixture = copy(loadTreeFixture("button-icon"));
  const c = fixture.components[0];
  c.variantProperties = [
    { name: "variant", type: "VARIANT", values: ["default", "raised"], defaultValue: "default" },
    { name: "size", type: "VARIANT", values: ["default", "icon"], defaultValue: "default" },
  ];
  const base = c.variants.find((v) => v.slug === "variant-default--size-default")!;
  const icon = {
    delta: { gap: null, width: 36, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    treeDelta: { set: { "": { L: { ai: "center", d: "inline-flex", jc: "center" }, box: [0, 0, 36, 36] }, svg: { box: [-71.39, 10, 16, 16] }, "#text": { box: [-47.39, 7.5, 154.8, 20] } } },
  };
  const shadow = { boxShadow: [{ offsetX: 0, offsetY: 25, blur: 50, spread: -12, color: "#00000040", inset: false }] };
  c.variants = [
    { ...base, combination: { variant: "default", size: "default" }, slug: "variant-default--size-default" },
    { ...base, ...icon, combination: { variant: "default", size: "icon" }, slug: "variant-default--size-icon", boundingBox: { width: 36, height: 36 } },
    { ...base, delta: shadow, treeDelta: {}, combination: { variant: "raised", size: "default" }, slug: "variant-raised--size-default" },
    { ...base, ...icon, delta: { ...icon.delta, ...shadow }, combination: { variant: "raised", size: "icon" }, slug: "variant-raised--size-icon", boundingBox: { width: 36, height: 36 } },
  ] as typeof c.variants;
  for (const [fonts, options] of [["the browser's widths", {}], ["Figma's fonts", { measure: figmaFonts() }]] as const) {
    const { mock, results } = await buildAll(fixture, options);
    assert.deepEqual([results[0].sets[0].variants, results[0].sets[0].absoluteContainers], [4, []]);
    const set = mock.nodes("COMPONENT_SET")[0];
    const drawn = set.children!.map((v) => ({ name: v.name, box: drawnInSet(mock, v) }));
    for (const [i, a] of drawn.entries()) {
      assert.ok(a.box[0] >= 0 && a.box[1] >= 0 && a.box[2] <= set.width && a.box[3] <= set.height, `${a.name} draws past the set: ${a.box}`);
      for (const b of drawn.slice(i + 1)) {
        const apart = a.box[2] <= b.box[0] || b.box[2] <= a.box[0] || a.box[3] <= b.box[1] || b.box[3] <= a.box[1];
        assert.ok(apart, `${a.name} (${a.box.map(Math.round)}) draws over ${b.name} (${b.box.map(Math.round)}), in ${fonts}`);
      }
    }
    // The icon button's label, wider than it, keeps GAP from the button before it.
    const at = (name: string) => drawn.find((d) => d.name === name)!.box;
    assert.ok(at("variant=default, size=icon")[0] - at("variant=default, size=default")[2] >= 20);
    assert.ok(at("variant=raised, size=default")[1] - at("variant=default, size=default")[3] >= 20);
  }
});

test("build: the set's grid keeps each row's boxes on one top edge and each column's on one left, the default top-left, whatever draws past them", async () => {
  // Only the default variant has a shadow, shadow-2xl, reaching 63px below
  // it and 38px every other way. Placed where its own drawn bounds start,
  // it sat lower and further right than its neighbors, and Figma takes the
  // set's default from the top-left variant.
  const fixture = copy(loadTreeFixture("button-icon"));
  const c = fixture.components[0];
  c.variantProperties = [
    { name: "variant", type: "VARIANT", values: ["default", "outline"], defaultValue: "default" },
    { name: "size", type: "VARIANT", values: ["default", "sm", "lg"], defaultValue: "default" },
  ];
  const base = c.variants.find((v) => v.slug === "variant-default--size-default")!;
  const shadow = [{ offsetX: 0, offsetY: 25, blur: 50, spread: -12, color: "#00000040", inset: false }];
  // The base's delta is its own styles, so the shadow goes on them; every other variant takes it off.
  base.delta = {};
  const styles = (c.base as unknown as { styles: Record<string, unknown> }).styles;
  styles.boxShadow = shadow;
  c.variants = (["default", "outline"] as const).flatMap((variant) => (["default", "sm", "lg"] as const).map((size) => {
    const slug = `variant-${variant}--size-${size}`;
    const own = variant === "default" && size === "default";
    return { ...base, combination: { variant, size }, slug, delta: own ? {} : { boxShadow: [] }, treeDelta: own ? base.treeDelta : {} };
  })) as typeof c.variants;
  const { mock, results } = await buildAll(fixture);
  assert.equal(results[0].sets[0].variants, 6);
  const set = mock.nodes("COMPONENT_SET")[0];
  const at = new Map(set.children!.map((v) => [v.name, v]));
  const cell = (variant: string, size: string) => at.get(`variant=${variant}, size=${size}`)!;
  const def = cell("default", "default");
  for (const v of set.children!) {
    if (v !== def) assert.ok(v.x > def.x && v.y >= def.y || v.y > def.y && v.x >= def.x, `${v.name} at ${v.x},${v.y} is not right of or below the default at ${def.x},${def.y}`);
  }
  for (const variant of ["default", "outline"]) {
    assert.deepEqual(new Set(["default", "sm", "lg"].map((size) => cell(variant, size).y)).size, 1, `row ${variant} shares a top edge`);
  }
  for (const size of ["default", "sm", "lg"]) assert.equal(cell("default", size).x, cell("outline", size).x, `column ${size} shares a left edge`);
  // The shadow's room is kept: 38px left of and above the default, GAP past that.
  assert.ok(def.x >= 20 + 38 && def.y >= 20 + 38, `${def.x},${def.y}`);
  const drawn = set.children!.map((v) => ({ name: v.name, box: drawnInSet(mock, v) }));
  for (const [i, a] of drawn.entries()) {
    for (const b of drawn.slice(i + 1)) {
      assert.ok(a.box[2] <= b.box[0] || b.box[2] <= a.box[0] || a.box[3] <= b.box[1] || b.box[3] <= a.box[1], `${a.name} draws over ${b.name}`);
    }
  }
});

test("drawnInSet: a group's shapes draw where the frame around the group puts them, as in Figma", async () => {
  // An imported icon, its frame not clipping, its <g> moved 30px left of
  // the frame: the group's x and its shape's are both in the frame's
  // coordinates, so the shape draws at the frame's x less 30, once.
  const mock = new MockFigma();
  const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g><rect x="0" y="0" width="4" height="4"/></g></svg>';
  const run = await mock.run(`const v = figma.createComponent(); v.resize(40, 40); v.x = 100; v.y = 50; v.clipsContent = false;
    const f = figma.createNodeFromSvg(${JSON.stringify(markup)}); v.appendChild(f); f.x = 10; f.y = 20; f.clipsContent = false;
    const g = f.children[0]; g.x = -30; g.y = -40;
    return [g.x, g.y, g.children[0].x, g.children[0].y];`);
  assert.ok(run.ok, run.text);
  assert.deepEqual(run.value, [-30, -40, -30, -40]);
  const variant = mock.nodes("COMPONENT")[0];
  // The frame draws to 134 by 94; the shape at 110 - 30 and 70 - 40.
  assert.deepEqual(drawnInSet(mock, variant), [80, 30, 140, 94]);
});

test("build: the set's grid gives room to an outside stroke and a layer blur, which draw past a box too", async () => {
  // A badge over the corner with a 30px translucent border it keeps its
  // fill inside, built as a frame its fill's size with an OUTSIDE stroke,
  // and an icon blurred by 40px: each draws further past its frame than
  // GAP, so laid out by boxes and shadows alone, the variants drew over
  // each other.
  const fixture = copy(loadTreeFixture("button-icon"));
  const c = fixture.components[0];
  c.variantProperties = [{ name: "look", type: "VARIANT", values: ["plain", "ring", "blur"], defaultValue: "plain" }];
  const base = c.variants.find((v) => v.slug === "variant-default--size-default")!;
  const keys = c.tree!.base.map((n) => n.k);
  const ring = { k: "ring", t: "F", el: "span", box: [150, -40, 100, 110], abs: 1, bg: "#ffffff", bgc: "padding-box", bd: { w: 30, s: "solid", c: "#ff000080" } };
  Object.assign(c.base!, { combination: { look: "plain" }, slug: "look-plain" });
  c.variants = [
    { ...base, combination: { look: "plain" }, slug: "look-plain" },
    { ...base, combination: { look: "ring" }, slug: "look-ring", delta: {}, treeDelta: { keys: [...keys, "ring"], set: { ring } } },
    { ...base, combination: { look: "blur" }, slug: "look-blur", delta: {}, treeDelta: { set: { svg: { fl: "blur(40px)" } } } },
  ] as typeof c.variants;
  const { mock, results } = await buildAll(fixture);
  assert.deepEqual([results[0].sets[0].variants, results[0].fallbacks], [3, []]);
  const set = mock.nodes("COMPONENT_SET")[0];
  const at = new Map(set.children!.map((v) => [v.name, drawnInSet(mock, v)]));
  const own = new Map(set.children!.map((v) => [v.name, [v.x, v.y, v.x + v.width, v.y + v.height]]));
  const badge = mock.handle(mock.nodes("FRAME").find((n) => n.data["storysync.k"] === "ring")!.id) as Record<string, number | string>;
  assert.deepEqual([badge.strokeAlign, badge.strokeWeight, badge.width, badge.height], ["OUTSIDE", 30, 40, 50]);
  // The stroke draws the badge's border box, 40px above the button's and
  // 70 down, the button's frame being its border box, its transparent
  // border built INSIDE; the blur 40px round the icon at 10 down.
  assert.deepEqual([at.get("look=ring")![1] - own.get("look=ring")![1], at.get("look=ring")![3] - own.get("look=ring")![1]], [-40, 70]);
  assert.equal(at.get("look=blur")![1] - own.get("look=blur")![1], 10 - 40);
  const drawn = [...at.entries()];
  for (const [i, [name, a]] of drawn.entries()) {
    assert.ok(a[0] >= 0 && a[1] >= 0 && a[2] <= set.width && a[3] <= set.height, `${name} draws past the set: ${a}`);
    for (const [other, b] of drawn.slice(i + 1)) {
      assert.ok(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], `${name} (${a.map(Math.round)}) draws over ${other} (${b.map(Math.round)})`);
    }
  }
});

test("build: the set's grid gives room to a turned layer, by the box its turned corners span", async () => {
  // A bar 120 by 4 out of the flow, centered on the button, turned 90
  // degrees: it draws 4 wide and 120 tall, 42px above the button and 42
  // below. Laid out by its unturned box, the variants above and below
  // would draw over it.
  const fixture = copy(loadTreeFixture("button-icon"));
  const c = fixture.components[0];
  c.variantProperties = [
    { name: "variant", type: "VARIANT", values: ["plain", "turned"], defaultValue: "plain" },
    { name: "size", type: "VARIANT", values: ["default", "wide"], defaultValue: "default" },
  ];
  const base = c.variants.find((v) => v.slug === "variant-default--size-default")!;
  const keys = c.tree!.base.map((n) => n.k);
  const bar = { k: "bar", t: "F", el: "span", box: [43.4, 16, 120, 4], abs: 1, bg: "#ff0000", tf: "rotate: 90deg", approx: "transform" };
  Object.assign(c.base!, { combination: { variant: "plain", size: "default" }, slug: "variant-plain--size-default" });
  c.variants = (["plain", "turned"] as const).flatMap((variant) => (["default", "wide"] as const).map((size) => ({
    ...base, combination: { variant, size }, slug: `variant-${variant}--size-${size}`, delta: {},
    treeDelta: variant === "turned" ? { keys: [...keys, "bar"], set: { bar } } : {},
  }))) as typeof c.variants;
  const { mock, results } = await buildAll(fixture);
  assert.deepEqual([results[0].sets[0].variants, results[0].fallbacks], [4, []]);
  const set = mock.nodes("COMPONENT_SET")[0];
  const at = new Map(set.children!.map((v) => [v.name, drawnInSet(mock, v)]));
  const own = new Map(set.children!.map((v) => [v.name, [v.x, v.y, v.x + v.width, v.y + v.height]]));
  // From the variant's frame, the button's border box: 42 above it, to 78 down.
  const turned = "variant=turned, size=default";
  assert.deepEqual([at.get(turned)![1] - own.get(turned)![1], at.get(turned)![3] - own.get(turned)![1]].map(Math.round), [-42, 78]);
  const drawn = [...at.entries()];
  for (const [i, [name, a]] of drawn.entries()) {
    assert.ok(a[0] >= 0 && a[1] >= 0 && a[2] <= set.width && a[3] <= set.height, `${name} draws past the set: ${a}`);
    for (const [other, b] of drawn.slice(i + 1)) {
      assert.ok(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], `${name} (${a.map(Math.round)}) draws over ${other} (${b.map(Math.round)})`);
    }
  }
});

test("boxDrift: a layer may move by what packs it, the siblings between it and where its row is packed, not by any sibling's growth", () => {
  // A flex row packed at its start, buttons a then b, each 40x20 and only its label, as snap measured them.
  const nodes = [
    { k: "", t: "F", L: { d: "flex", dir: "row" } }, { k: "a", t: "F" }, { k: "a/t", t: "T" }, { k: "b", t: "F" }, { k: "b/t", t: "T" },
  ] as unknown as TreeNode[];
  const facts = new Map<string, Box>([["", [0, 0, 80, 20]], ["a", [0, 0, 40, 20]], ["a/t", [0, 0, 40, 20]], ["b", [40, 0, 40, 20]], ["b/t", [40, 0, 40, 20]]]);
  const mock = { handle: () => ({}) } as unknown as MockFigma;
  // Each button as Figma set it, its label filling it.
  const built = (a: Box, b: Box) => ({
    id: "root", x: 0, y: 0, width: a[2] + b[2], height: Math.max(a[3], b[3]), data: {},
    children: [a, b].map((box, i) => {
      const k = i ? "b" : "a";
      const label = { id: `${k}t`, x: 0, y: 0, width: box[2], height: box[3], data: { "storysync.k": `${k}/t` }, children: [] };
      return { id: k, x: box[0], y: box[1], width: box[2], height: box[3], data: { "storysync.k": k }, children: [label] };
    }),
  }) as unknown as NodeView;
  // a's label set 1px wider moves b along by as much.
  assert.deepEqual(boxDrift(mock, built([0, 0, 41, 20], [41, 0, 40, 20]), nodes, facts), []);
  // b's set 1px wider and taller moves nothing before it, along the row or across it.
  assert.deepEqual(boxDrift(mock, built([1, 0, 40, 20], [40, 0, 41, 21]), nodes, facts), ["a: snap 0,0,40,20, Figma 1,0,40,20"]);
  assert.deepEqual(boxDrift(mock, built([0, 1, 40, 20], [40, 0, 41, 21]), nodes, facts), ["a: snap 0,0,40,20, Figma 0,1,40,20"]);
  // Packed at its end, a moves by b's growth and its own, and b by its own alone.
  const end = [{ ...nodes[0], L: { d: "flex", dir: "row", jc: "flex-end" } }, ...nodes.slice(1)] as TreeNode[];
  assert.deepEqual(boxDrift(mock, built([-1, 0, 40, 20], [39, 0, 41, 20]), end, facts), []);
  assert.deepEqual(boxDrift(mock, built([0, 0, 41, 20], [42, 0, 40, 20]), end, facts), ["b/t: snap 40,0,40,20, Figma 42,0,40,20", "b: snap 40,0,40,20, Figma 42,0,40,20"]);
});

/** A component snap measured in the final live test of 0.4.0 (fixtures/final), as a fixture of its own. */
function finalFixture(name: string): TreeFixture {
  const base = copy(loadTreeFixture("example-button"));
  base.components = [JSON.parse(readFileSync(fileURLToPath(new URL(`../../../cli/__tests__/fixtures/final/${name}.json`, import.meta.url)), "utf8")).component];
  return base;
}

test("build: a variant copied from one with auto layout and strokes included, built without it, as Alert's destructive grid, is built, and built again", async () => {
  // Figma refuses strokesIncludedInLayout on a frame without auto layout,
  // to either value (probe 8a), and the copy keeps its original's true.
  const fixture = finalFixture("alert");
  const { coded, mock } = await buildAll(fixture);
  const roots = variantsBySlug(mock);
  const read = (slug: string) => mock.handle(roots.get(slug)!.id) as { layoutMode: string; strokesIncludedInLayout: boolean };
  assert.deepEqual([read("variant-default").layoutMode, read("variant-default").strokesIncludedInLayout], ["VERTICAL", true]);
  assert.deepEqual([read("variant-destructive").layoutMode, read("variant-destructive").strokesIncludedInLayout], ["NONE", false]);
  const again = await runPlan(mock, coded, ["build"]);
  assert.deepEqual([again[0].created, again[0].removed], [0, 0]);
  for (const variant of fixtureVariants(fixture)) {
    assert.deepEqual(boxDrift(mock, variantsBySlug(mock).get(variant.slug)!, variant.nodes, absoluteBoxes(variant.nodes)), [], variant.slug);
  }
});

test("build: where Figma's whole-pixel hugging labels would push a layer, they are fixed at the browser's sizes, so nothing wraps (Item) or runs past its frame (Breadcrumb) and no frame is wider, unless one would wrap so; elsewhere they hug", async () => {
  type Text = { width: number; height: number; x: number; textAutoResize: string };
  // Item: "Action" is 43.13 measured and 44 hugging in Figma, which
  // narrows the description's column by 0.87, its own width, short of one
  // line. Fixed at 43.13, as Figma keeps it (probe 9a), it narrows nothing.
  const item = finalFixture("item");
  const built = await buildAll(item);
  for (const variant of fixtureVariants(item)) {
    const root = variantsBySlug(built.mock).get(variant.slug)!;
    const text = (k: string) => built.mock.handle(keyed(root, k)!.id) as Text;
    const measured = (k: string) => variant.nodes.find((n) => n.k === k)!.box;
    assert.equal(text("item-content/item-description/#text").height, Math.ceil(measured("item-content/item-description/#text")[3]), `${variant.slug}: the description on one line`);
    assert.deepEqual([text("button/#text").width, text("button/#text").height, text("button/#text").textAutoResize], [measured("button/#text")[2], measured("button/#text")[3], "NONE"], variant.slug);
    // As wide as measured; as tall, but for its title's line, which Figma
    // rounds up to a whole pixel, as it grows to its lines (probe 9a).
    assert.ok(Math.abs(root.width - variant.nodes[0].box[2]) < 0.01, `${variant.slug}: ${root.width}`);
    assert.ok(root.height < variant.nodes[0].box[3] + 1, `${variant.slug}: ${root.height}`);
    assert.equal((built.mock.handle(root.id) as { layoutSizingVertical: string }).layoutSizingVertical, "HUG");
    assert.deepEqual(result(built.runs[0]).fallbacks, []);
  }
  // Breadcrumb: three labels, each up to a pixel wider, would end 1.71px
  // past the list, which fills the nav's fixed 272.29: fixed at 39.05, 84.4
  // and 80.85, they end where the browser drew them, the nav as measured.
  const crumbs = finalFixture("breadcrumb");
  const { mock } = await buildAll(crumbs);
  const [variant] = fixtureVariants(crumbs);
  const root = variantsBySlug(mock).get(variant.slug)!;
  const list = mock.handle(keyed(root, "breadcrumb-list")!.id) as { width: number };
  for (const k of ["breadcrumb-list/breadcrumb-link", "breadcrumb-list/breadcrumb-link:2", "breadcrumb-list/breadcrumb-page"]) {
    const text = mock.handle(keyed(root, k)!.id) as Text;
    assert.deepEqual([text.textAutoResize, text.width], ["NONE", variant.nodes.find((n) => n.k === k)!.box[2]], k);
  }
  const page = mock.handle(keyed(root, "breadcrumb-list/breadcrumb-page")!.id) as Text;
  const measured = variant.nodes[0].box[2];
  assert.ok([page.x + page.width, list.width, root.width].every((w) => Math.abs(w - measured) < 0.01), `${page.x + page.width}, ${list.width}, ${root.width}: ${measured}`);
  assert.deepEqual(boxDrift(mock, root, variant.nodes, absoluteBoxes(variant.nodes)), []);
  // Where Figma's font sets them wider than the browser did, each would
  // wrap at its browser width: they hug, one line each, and the nav grows
  // by what they lack, so nothing runs past the list.
  const wide = new Map(variant.nodes.filter((n) => n.tx).map((n) => [n.tx!.c, n.box[2] + 0.1]));
  const base = figmaFonts();
  const wider = await buildAll(crumbs, { measure: { advance: (chars, font) => wide.get(chars) ?? base.advance(chars, font) } });
  const wideRoot = variantsBySlug(wider.mock).get(variant.slug)!;
  const wideList = wider.mock.handle(keyed(wideRoot, "breadcrumb-list")!.id) as { width: number };
  let end = 0;
  for (const k of ["breadcrumb-list/breadcrumb-link", "breadcrumb-list/breadcrumb-link:2", "breadcrumb-list/breadcrumb-page"]) {
    const text = wider.mock.handle(keyed(wideRoot, k)!.id) as Text;
    assert.deepEqual([text.textAutoResize, text.height], ["WIDTH_AND_HEIGHT", Math.ceil(variant.nodes.find((n) => n.k === k)!.box[3])], k);
    end = Math.max(end, text.x + text.width);
  }
  assert.ok(end <= wideList.width + 0.01, `${end}: ${wideList.width}`);
  // A button whose label rounds up and pushes nothing hugs it, as a designer's would.
  const button = loadTreeFixture("example-button");
  const plain = await buildAll(button);
  const [own] = fixtureVariants(button);
  const ownRoot = variantsBySlug(plain.mock).get(own.slug)!;
  assert.equal((plain.mock.handle(ownRoot.id) as { layoutSizingHorizontal: string }).layoutSizingHorizontal, "HUG");
  const label = ownRoot.children!.find((c) => c.type === "TEXT")!;
  assert.equal((plain.mock.handle(label.id) as Text).textAutoResize, "WIDTH_AND_HEIGHT");
});

test("build: a balanced text's lines break where the browser broke them, at its measured box, and read back as its characters", async () => {
  // Empty's description, text-wrap: balance: "Upload files to your cloud
  // storage / to access them anywhere.", lines 223.36 wide at most in a
  // 384px box, where Figma, filling each line first, would break after "them".
  const empty = finalFixture("empty");
  const { coded, mock } = await buildAll(empty, { measure: figmaFonts() });
  const [variant] = fixtureVariants(empty);
  const root = variantsBySlug(mock).get(variant.slug)!;
  const k = "empty-header/empty-description";
  const text = mock.handle(keyed(root, k)!.id) as { characters: string; width: number; height: number };
  assert.equal(text.characters, "Upload files to your cloud storage to access them anywhere.");
  assert.deepEqual([text.width, text.height], [384, 46]);
  assert.equal(keyed(root, k)!.data["storysync.br"], "Upload files to your cloud storage to access them anywhere.");
  // Built again, the same; nothing else gets a break: the title is one line.
  await runPlan(mock, coded, ["build"]);
  assert.equal((mock.handle(keyed(variantsBySlug(mock).get(variant.slug)!, k)!.id) as { characters: string }).characters, text.characters);
  assert.equal(keyed(root, "empty-header/empty-title")!.data["storysync.br"] ?? "", "");
  // The readback reads the characters snap measured.
  const [read] = await readBack(mock, [[empty.components[0].id!, 0, 1, 0]], { page: result((await runPlan(mock, coded, ["build"]))[0]).page });
  const json = String(JSON.stringify(read));
  assert.ok(json.includes('"Upload files to your cloud storage to access them anywhere."'));
  assert.ok(!json.includes("\\u2028"));
});

test("build: an input's value keeps its control's content box, its line at the middle, so the input is as tall as the browser drew it", async () => {
  // Questionnaire's input, h-9: 36 tall, its placeholder's line 20 in a
  // 26px content box, where a text grown to its line made the input 30.
  const fixture = finalFixture("questionnaire");
  const { mock } = await buildAll(fixture);
  const [variant] = fixtureVariants(fixture);
  const root = variantsBySlug(mock).get(variant.slug)!;
  const input = "questionnaire-item/questionnaire-choices/questionnaire-input";
  const value = mock.handle(keyed(root, `${input}/#value`)!.id) as { width: number; height: number; textAutoResize: string; textAlignVertical: string };
  assert.deepEqual([value.width, value.height, value.textAutoResize, value.textAlignVertical], [475.47, 26, "NONE", "CENTER"]);
  assert.equal((mock.handle(keyed(root, input)!.id) as { height: number }).height, 36);
  assert.deepEqual(boxDrift(mock, root, variant.nodes, absoluteBoxes(variant.nodes)).filter((d) => String(d).includes(input)), []);
});

test("build: an input's value Figma sets wider than its box stays on one line in it, cut short and named so, as a textarea's wraps", async () => {
  // The same input 200 wide: "Describe another approach…" takes two lines
  // at 178, which a value built at its box would draw past it, unseen.
  const fixture = finalFixture("questionnaire");
  const input = "questionnaire-item/questionnaire-choices/questionnaire-input";
  const nodes = fixture.components[0].tree!.base;
  nodes.find((n) => n.k === input)!.box[2] = 200;
  nodes.find((n) => n.k === `${input}/#value`)!.box[2] = 178;
  const { mock, runs } = await buildAll(fixture);
  const [variant] = fixtureVariants(fixture);
  const value = mock.handle(keyed(variantsBySlug(mock).get(variant.slug)!, `${input}/#value`)!.id) as { width: number; height: number; textAutoResize: string; textTruncation: string; maxLines: number };
  // A fixed-size text cut short reads TRUNCATE, and no maxLines in auto layout (the live text probe).
  assert.deepEqual([value.width, value.height, value.textAutoResize, value.textTruncation, value.maxLines], [178, 26, "TRUNCATE", "ENDING", null]);
  assert.deepEqual(result(runs[0]).fallbacks.map(([, key, what]) => [key.endsWith("#value"), what]), [[true, "cut short: Figma sets it wider"]]);
  // At its own 475.47 it fits: nothing cut.
  const wide = finalFixture("questionnaire");
  const built = await buildAll(wide);
  const own = built.mock.handle(keyed(variantsBySlug(built.mock).get(variant.slug)!, `${input}/#value`)!.id) as { textTruncation: string };
  assert.equal(own.textTruncation, "DISABLED");
  assert.deepEqual(result(built.runs[0]).fallbacks, []);
});

test("build: a ring on a frame without a fill clips the frame and gives it a fill that draws nothing, so Figma draws it; the readback reads the frame as measured", async () => {
  // coder's ConfirmDialog Cancel button: a 1px border, no background, and
  // a focus ring (box-shadow 0 0 0 2px #61a6fa), which Figma drew nowhere:
  // it draws a spread only on a frame that clips and has a fill (probe 8a).
  const tree = (labelX: number): TreeNode[] => [
    { k: "", t: "F", el: "div", box: [0, 0, 120, 60], L: { d: "block" } },
    { k: "button", t: "F", el: "button", box: [20, 10, 80, 40], bd: { w: 1, s: "solid", c: "#27272a" }, r: 6, sh: [[0, 0, 0, 2, "#61a6fa"]], L: { d: "block" } },
    { k: "button/#text", t: "T", el: "#text", box: [labelX, 10, 50, 20], tx: { c: "Cancel", f: "Inter", sz: 14, wt: 500, col: "#fafafa", lh: 20, n: 1, ink: [0, 1.5, 50, 17] } },
  ];
  const ring = synthetic("Ring", tree(15), { width: 120, height: 60, display: "block" });
  const { mock, runs } = await buildAll(ring);
  const root = variantsBySlug(mock).get("default")!;
  const button = mock.handle(keyed(root, "button")!.id) as { clipsContent: boolean; fills: { type: string; blendMode: string; color: object }[]; effects: { spread: number }[] };
  assert.equal(button.clipsContent, true);
  assert.deepEqual(button.fills.map((p) => [p.type, p.blendMode, p.color]), [["SOLID", "MULTIPLY", { r: 1, g: 1, b: 1 }]]);
  assert.equal(button.effects[0].spread, 2);
  assert.equal(keyed(root, "button")!.data["storysync.rc"], "cf");
  const [read] = await readBack(mock, [[ring.components[0].id!, 0, 1, 0]], { page: result(runs[0]).page });
  const find = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? (v[0] === "button" && v[1] === "F" ? v : v.map(find).find(Boolean))
    : v && typeof v === "object" ? Object.values(v).map(find).find(Boolean) : undefined);
  const record = find(read)!;
  // Its fills, and its clip, as the browser drew it: none.
  assert.deepEqual([record[6], record[12]], [[], 0]);
  // A label past the button: clipping it would cut it, so no clip, and said.
  const spill = synthetic("Spill", tree(60), { width: 120, height: 60, display: "block" });
  const spilled = await buildAll(spill);
  assert.equal((spilled.mock.handle(keyed(variantsBySlug(spilled.mock).get("default")!, "button")!.id) as { clipsContent: boolean }).clipsContent, false);
  assert.ok(spilled.coded.warnings.some((w) => /spread on a frame whose content draws past it/.test(w)), spilled.coded.warnings.join("\n"));
});

test("bindings: a component snap measured dark binds by the tokens' dark values, and the label call puts its set in Dark, where they show as measured", async () => {
  // coder's Storybook renders dark: its dialog's #ffffff is background's
  // dark value here, and its light one #0a0a0a.
  const dialog = copy(loadTreeFixture("dialog"));
  (dialog.components[0] as { scheme?: string }).scheme = "dark";
  const tokens = { collections: [{ category: "colors", tokens: [
    { name: "background", value: "#0a0a0a", hex: "#0a0a0a", dark: { value: "#ffffff", hex: "#ffffff" } },
    { name: "foreground", value: "#ffffff", hex: "#ffffff", dark: { value: "#0a0a0a", hex: "#0a0a0a" } },
  ] }] };
  const coded = await codeFor(dialog, {}, tokens);
  assert.ok(coded.warnings.some((w) => /^ui\/base\/Dialog: snap measured it in the dark theme, so its paints bind by the tokens' dark values/.test(w)), coded.warnings.join("\n"));
  assert.match(coded.plan.calls.find((c) => c.kind === "label")!.description, /put those it measured in the dark theme in each collection's Dark mode/);
  const mock = mockFor([dialog]);
  mock.addVariable("background", "COLOR", { Light: "#0a0a0a", Dark: "#ffffff" }, "Colors");
  mock.addVariable("foreground", "COLOR", { Light: "#ffffff", Dark: "#0a0a0a" }, "Colors");
  await runPlan(mock, coded, ["variables", "build"]);
  const variant = variantsBySlug(mock).get("default")!;
  const fill = () => (mock.handle(variant.id) as { fills: { color: { r: number } }[] }).fills.map((f) => Math.round(f.color.r * 255));
  // Bound to background, in the Light mode the page starts in: its light value.
  assert.deepEqual(fill(), [0x0a]);
  const [label] = await runPlan(mock, coded, ["label"]);
  assert.deepEqual(fill(), [0xff], "in Dark, as measured");
  const setId = (label.value as { darkened: string[] }).darkened[0];
  assert.ok(setId);
  // A mode a designer chose is theirs: sent again, nothing changes.
  await switchMode(mock, setId, "Light");
  const [again] = await runPlan(mock, coded, ["label"]);
  assert.equal((again.value as { darkened?: string[] }).darkened, undefined);
  assert.deepEqual(fill(), [0x0a]);
});

test("bindings: a set the label call put in Dark comes back off it once a push measures it light, unless a designer chose a mode since", async () => {
  const dark = copy(loadTreeFixture("dialog"));
  (dark.components[0] as { scheme?: string }).scheme = "dark";
  const tokens = { collections: [{ category: "colors", tokens: [
    { name: "background", value: "#0a0a0a", hex: "#0a0a0a", dark: { value: "#ffffff", hex: "#ffffff" } },
    { name: "foreground", value: "#ffffff", hex: "#ffffff", dark: { value: "#0a0a0a", hex: "#0a0a0a" } },
  ] }] };
  const darkCode = await codeFor(dark, {}, tokens);
  const lightCode = await codeFor(copy(loadTreeFixture("dialog")), {}, tokens);
  const mock = mockFor([dark]);
  mock.addVariable("background", "COLOR", { Light: "#0a0a0a", Dark: "#ffffff" }, "Colors");
  mock.addVariable("foreground", "COLOR", { Light: "#ffffff", Dark: "#0a0a0a" }, "Colors");
  await runPlan(mock, darkCode, ["variables", "build"]);
  const [label] = await runPlan(mock, darkCode, ["label"]);
  const setId = (label.value as { darkened: string[] }).darkened[0];
  const modes = () => (mock.handle(setId) as { explicitVariableModes: Record<string, string> }).explicitVariableModes;
  assert.equal(Object.keys(modes()).length, 1);
  // Measured light now: the Dark mode storysync set comes off, once.
  const [light] = await runPlan(mock, lightCode, ["label"]);
  assert.deepEqual([(light.value as { lightened?: string[] }).lightened, modes()], [[setId], {}]);
  const [again] = await runPlan(mock, lightCode, ["label"]);
  assert.equal((again.value as { lightened?: string[] }).lightened, undefined);
  // A mode a designer chose after storysync's Dark stays theirs.
  await runPlan(mock, darkCode, ["label"]);
  await switchMode(mock, setId, "Light");
  const chosen = modes();
  const [kept] = await runPlan(mock, lightCode, ["label"]);
  assert.deepEqual([(kept.value as { lightened?: string[] }).lightened, modes()], [undefined, chosen]);
});
