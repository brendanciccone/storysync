// templates/build.js, run as figma code writes it, in the mock Figma.

import assert from "node:assert/strict";
import { test } from "node:test";
import { absoluteBoxes } from "../tree-types.js";
import type { TreeNode } from "../tree-types.js";
import { SHADCN_TOKENS, boxDrift, codeFor, mockFor, readBoxes, runPlan, variantsBySlug } from "./figma-build-harness.js";
import { MockFigma, fixtureVariants, loadTreeFixture, treeFixtureAsset, treeFixtureNames } from "./mock-figma.js";
import type { MockFigmaOptions, MockRun, NodeView, TreeFixture } from "./mock-figma.js";

type BuildResult = {
  kind: string; sets: { id: string; component: string; name: string; variants: number; added: number; updated: number; migrated: number; designerLayers: number; absoluteContainers: unknown[] }[];
  uploads: [string, string][]; unbound: string[][]; fallbacks: string[][]; fonts: Record<string, string>;
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
    }
  }
});

test("build: with a stand-in font 4.5% wider, no container falls back; a hugging root grows by its label's growth", async () => {
  for (const name of treeFixtureNames()) {
    const { results } = await buildAll(loadTreeFixture(name), { textWidthFactor: 1.045 });
    for (const r of results) for (const set of r.sets) assert.deepEqual(set.absoluteContainers, [], name);
  }
  const fixture = loadTreeFixture("button-icon");
  const { mock } = await buildAll(fixture, { textWidthFactor: 1.045 });
  const variant = fixtureVariants(fixture)[0];
  const boxes = readBoxes(mock, variantsBySlug(mock).get(variant.slug)!);
  const label = boxes.get("#text")!;
  const grown = label[2] - 154.8;
  assert.ok(Math.abs(grown - 154.8 * 0.045) < 0.05, `the label grew ${grown}`);
  assert.ok(Math.abs(boxes.get("")![2] - (206.8 + grown)) < 0.05, "the button hugs its label");
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

test("build: a sibling after a label moves by as much as a wider stand-in widens the label", async () => {
  const fixture = synthetic("Next", [
    { k: "", t: "F", el: "button", box: [0, 0, 86, 24], L: { d: "inline-flex", ai: "center", gap: [4, 4], pad: [0, 8, 0, 8] } },
    { k: "#text", t: "T", el: "#text", box: [8, 2, 50, 20], tx: { c: "Next", f: "Inter", sz: 14, wt: 500, col: "#ffffff", lh: 20, n: 1, ink: [0, 1.5, 50, 17] } },
    { k: "svg", t: "V", el: "svg.lucide-chevron-right", box: [62, 4, 16, 16], svg: "svg:chevron", shapes: [[6, 4, 4, 8]] },
  ], { width: 86, height: 24, display: "inline-flex" }, { "svg:chevron": CHEVRON });
  const { mock, results } = await buildAll(fixture, { textWidthFactor: 1.045 });
  assert.deepEqual(results[0].sets[0].absoluteContainers, []);
  const boxes = readBoxes(mock, variantsBySlug(mock).get("default")!);
  assert.equal(boxes.get("#text")![2], 52.25);
  assert.equal(boxes.get("svg")![0], 64.25);
  assert.equal(boxes.get("")![2], 88.25);
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

test("build: where clone() drops plugin data (spike item 5), keys are copied and a rerun still changes nothing", async () => {
  const fixture = loadTreeFixture("attachment");
  const coded = await codeFor(fixture);
  const mock = mockFor([fixture], { clonePluginData: false });
  await runPlan(mock, coded, ["build"]);
  const again = await runPlan(mock, coded, ["build"]);
  assert.deepEqual([again[0].created, again[0].removed], [0, 0]);
  for (const variant of fixtureVariants(fixture)) {
    assert.deepEqual(boxDrift(mock, variantsBySlug(mock).get(variant.slug)!, variant.nodes, absoluteBoxes(variant.nodes)), []);
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

test("spike item 1: where Figma doesn't scale an SVG's strokes, importing at the viewBox and rescaling does", async () => {
  const fixture = loadTreeFixture("toggle");
  const weights = async (svgStrokesScale: boolean) => {
    const { mock } = await buildAll(fixture, { svgStrokeScales: false }, { spike: { svgStrokesScale } });
    return [...new Set(mock.nodes("VECTOR").map((n) => Math.round((mock.handle(n.id).strokeWeight as number) * 100) / 100))];
  };
  assert.deepEqual(await weights(false), [1.33], "lucide's 2 at 24 drawn at 16, as the browser draws it");
  assert.deepEqual(await weights(true), [2], "imported at 16, the strokes stay 2 wide");
  // Where Figma does scale them, the fallback is right all the same.
  const { mock } = await buildAll(fixture);
  assert.deepEqual([...new Set(mock.nodes("VECTOR").map((n) => Math.round((mock.handle(n.id).strokeWeight as number) * 100) / 100))], [1.33]);
});

test("spike item 2: a shadow's spread Figma refuses on a frame that doesn't clip is left out, and said", async () => {
  const fixture = copy(loadTreeFixture("switch"));
  fixture.components[0].base!.styles.boxShadow = [{ offsetX: 0, offsetY: 0, blur: 0, spread: 1, color: "#0a0a0a1a", inset: false }];
  const { mock, results } = await buildAll(fixture, { shadowSpread: "refuse" });
  assert.equal(results[0].fallbacks.length, 2);
  assert.match(results[0].fallbacks[0].join(" "), /^ui\/base\/Switch size-default  shadow spread left out: /);
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

test("spike item 11: no build relies on a frame hugging a child that fills it, which the mock can refuse", async () => {
  for (const name of treeFixtureNames()) await buildAll(loadTreeFixture(name), { fillAcrossHug: "refuse" });
  // Taking the spike's other answer is what makes Card rely on it.
  await assert.rejects(buildAll(loadTreeFixture("card"), { fillAcrossHug: "refuse" }, { spike: { fillAcrossHug: true } }), /FILL across a parent that hugs/);
});

test("build: an SVG Figma won't import is an empty keyed frame, named so, tried again next time", async () => {
  const fixture = copy(loadTreeFixture("toggle"));
  fixture.components[0].tree.assets.svg["svg:3a1614af"] = "<svg-not-really/>";
  const { coded, mock, results } = await buildAll(fixture);
  assert.equal(results[0].fallbacks.length, 6);
  assert.match(results[0].fallbacks[0].join(" "), /^ui\/base\/Toggle variant-default--size-default svg svg import failed: /);
  const failed = mock.nodes("FRAME").filter((n) => n.data["storysync.k"] === "svg");
  assert.deepEqual([...new Set(failed.map((n) => [n.name, n.width, n.height, n.children!.length].join()))], ["svg (import failed),16,16,0"]);
  const [again] = await runPlan(mock, coded, ["build"]);
  assert.equal(result(again).fallbacks.length, 6, "the import is tried again");
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
