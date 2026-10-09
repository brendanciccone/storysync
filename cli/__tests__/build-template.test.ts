// templates/build.js, run as figma code writes it, in the mock Figma.

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleReorder } from "../figma-layout.js";
import { textSizesItself } from "../figma-map.js";
import { applyDelta } from "../snap-normalize.js";
import { absoluteBoxes, parentKey, rootWithStyles, treeDigest } from "../tree-types.js";
import type { TreeNode } from "../tree-types.js";
import { SHADCN_TOKENS, boxDrift, codeFor, mockFor, readBoxes, runPlan, variantsBySlug } from "./figma-build-harness.js";
import { MockFigma, figmaFonts, fixtureVariants, loadTreeFixture, treeFixtureAsset, treeFixtureNames } from "./mock-figma.js";
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
      // Each icon's shapes where the browser drew them in it, as verify's shape gate checks.
      for (const icon of variant.nodes.filter((n) => n.t === "V")) {
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
    const run = await mock.run(code.replace(/\nconst DATA = .*;\n/, () => `\nconst DATA = ${JSON.stringify(data)};\n`));
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
  const broken = code.replace(/\nconst DATA = .*;\n/, () => `\nconst DATA = ${JSON.stringify(data)};\n`);
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
  // Its radius isn't bound: its border is built outside it, at the inner radius, which no token has.
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
      assert.equal((root.boundVariables as Record<string, unknown>).topLeftRadius, undefined);
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

test("spike item 2: a shadow's spread Figma refuses on a frame that doesn't clip is left out, and said", async () => {
  const fixture = copy(loadTreeFixture("switch"));
  fixture.components[0].base!.styles.boxShadow = [{ offsetX: 0, offsetY: 0, blur: 0, spread: 1, color: "#0a0a0a1a", inset: false }];
  const { mock, results } = await buildAll(fixture, { shadowSpread: "refuse" });
  // Once for the root, in both variants.
  assert.equal(results[0].fallbacks.length, 1);
  assert.deepEqual(results[0].fallbacks[0].map((v, i) => (i === 2 ? String(v).replace(/: .*/, "") : v)), ["ui/base/Switch", "", "shadow spread left out", 2]);
  const root = mock.handle(variantsBySlug(mock).get("size-default")!.id) as { effects: { spread: number }[] };
  assert.equal(root.effects[0].spread, 0);
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

test("build: a call refused for one of its sets changes none of them", async () => {
  const snap = copy(loadTreeFixture("switch"));
  snap.components.push(copy(loadTreeFixture("toggle").components[0]));
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
  const before = JSON.stringify(mock.pages());
  const call = coded.plan.calls[0];
  assert.deepEqual(call.components, ["ui/base/Switch", "ui/base/Toggle"]);
  const run = await mock.run(coded.code(call));
  assert.match(run.text, /The page has COMPONENT_SET "Toggle" .*, COMPONENT_SET "Toggle" .*: ask the user which to update/);
  assert.equal(JSON.stringify(mock.pages()), before, "Switch, first in the call, wasn't built either");
});
