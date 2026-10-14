// What a build does to what an earlier push left (sets whose properties
// changed, a plain component that became a set, a set that grew onto
// another), and how a plan carries what one call can't: its templates,
// stored in the file by the first call of their kind, and a variant too
// big for one call, sent in parts.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { missingTemplate, templateKey } from "../checksum.js";
import { loadTemplate } from "../figma-code.js";
import type { PlanCall } from "../tree-types.js";
import { boxDrift, codeFor, mockFor, runPlan, variantsBySlug } from "./figma-build-harness.js";
import type { Coded } from "./figma-build-harness.js";
import { MockFigma, figmaFonts, fixtureVariants, loadTreeFixture } from "./mock-figma.js";
import type { MockRun, NodeView, TreeFixture } from "./mock-figma.js";
import { absoluteBoxes } from "../tree-types.js";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface SetResult {
  id: string; component: string; name: string; variants: number; added: number; updated: number; extra: number; overlaps: number;
  refused?: string; converted?: 1; renamed?: number; removed?: number; stashed?: number; moved?: string[];
}
const sets = (run: MockRun) => (run.value as { sets: SetResult[] }).sets;

/** Example's Button without one of its properties: only its variants at `keep`, named without it. */
function withoutProp(fixture: TreeFixture, prop: string, keep: string): TreeFixture {
  const out = copy(fixture);
  const c = out.components[0];
  const drop = (combination: Record<string, string>) => Object.fromEntries(Object.entries(combination).filter(([k]) => k !== prop));
  const slug = (s: string) => s.replace(`--${prop}-${keep}`, "");
  c.variantProperties = c.variantProperties.filter((p) => p.name !== prop);
  c.variants = c.variants.filter((v) => v.combination[prop] === keep).map((v) => ({ ...v, combination: drop(v.combination), slug: slug(v.slug) }));
  c.base = { ...c.base!, combination: drop(c.base!.combination), slug: slug(c.base!.slug) };
  return out;
}

/** Runs a plan's calls, and saves each build's response as its result, as an agent does. */
async function push(mock: MockFigma, coded: Coded, kinds: PlanCall["kind"][] = ["build"]): Promise<MockRun[]> {
  const runs = await runPlan(mock, coded, kinds);
  coded.plan.calls.filter((c) => kinds.includes(c.kind)).forEach((call, i) => writeFileSync(join(coded.out, call.result), JSON.stringify(runs[i].value)));
  return runs;
}

/** figma code run again over `snap`, into the plan directory `out` an earlier run wrote. */
async function codeIn(snap: TreeFixture, out: string, options: object = {}): Promise<Coded> {
  const coded = await codeFor(snap, { ...options, out });
  return { ...coded, out, code: (call) => readFileSync(join(out, call.file), "utf8") };
}

const children = (mock: MockFigma, id: string) => (mock.handle(id) as { children: { id: string; name: string }[] }).children.map((c) => [c.id, c.name]);

test("build: variants an earlier push built are renamed onto a property added since, keeping their node ids, so instances follow (probe 9a)", async () => {
  // ToggleGroup gained `disabled`: the old variants are its disabled=false ones.
  const before = withoutProp(loadTreeFixture("example-button"), "disabled", "false");
  const mock = mockFor([loadTreeFixture("example-button")]);
  const [first] = await push(mock, await codeFor(before));
  const old = new Map(children(mock, sets(first)[0].id).map(([id, name]) => [name, id]));
  // One whose name gives its values in another order is found by its values.
  const swapped = old.get("variant=danger, size=lg")!;
  (mock.handle(swapped) as { name: string }).name = "size=lg, variant=danger";
  const [then] = await push(mock, await codeFor(loadTreeFixture("example-button")));
  const [set] = sets(then);
  assert.deepEqual([set.renamed, set.added, set.updated, set.extra, set.variants], [6, 6, 6, 0, 12]);
  const now = new Map(children(mock, set.id).map(([id, name]) => [name, id]));
  for (const [name, id] of old) assert.equal(now.get(`${name}, disabled=false`), id, name);
});

test("build: of a property dropped since, the variants at the value snap pins it to are kept and renamed; the rest are extra, unread, until the user has them removed", async () => {
  // ConfirmDialog lost `open`, which snap now pins open: here `disabled`, pinned false.
  const full = loadTreeFixture("example-button");
  const after = withoutProp(full, "disabled", "false");
  after.components[0].excludedProps = [{ name: "disabled", reason: "opens", value: "false" }];
  const mock = mockFor([full]);
  const [first] = await push(mock, await codeFor(full));
  const old = new Map(children(mock, sets(first)[0].id).map(([id, name]) => [name, id]));
  const [then] = await push(mock, await codeFor(after));
  const [set] = sets(then);
  assert.deepEqual([set.renamed, set.added, set.extra, set.variants, set.removed], [6, 0, 6, 12, undefined]);
  const now = children(mock, set.id);
  for (const [id, name] of now) {
    const was = [...old].find(([, i]) => i === id)![0];
    const variant = mock.nodes("COMPONENT").find((n) => n.id === id)!;
    if (was.endsWith("disabled=false")) assert.equal(name, was.replace(", disabled=false", ""));
    // Left as they were, and no longer read back by an index the plan's variants take.
    else assert.deepEqual([name, variant.data["storysync.i"] ?? ""], [was, ""]);
  }
  // Removed once the user says so, and only those.
  const [removed] = await push(mock, await codeFor(after, { removeExtra: true }));
  assert.deepEqual([sets(removed)[0].removed, sets(removed)[0].extra, sets(removed)[0].variants], [6, 0, 6]);
  assert.ok(children(mock, set.id).every(([id]) => old.get([...old].find(([, i]) => i === id)![0]) === id));
});

test("build: a plain component an earlier push built, now with variant properties, is refused until the user says to convert it, then made its set's first variant in place", async () => {
  // Questionnaire gained `shortcuts`: one variant, then two.
  const full = loadTreeFixture("switch");
  const plain = copy(full);
  const c = plain.components[0];
  c.variantProperties = [];
  c.variants = [{ ...c.variants[0], combination: {}, slug: "default" }];
  c.base = { ...c.base!, combination: {}, slug: "default" };
  // Card on the same page, in the same call: the refusal stops nothing.
  const card = copy(loadTreeFixture("card").components[0]);
  plain.components.push(card);
  const both = copy(full);
  both.components.push(card);
  const mock = mockFor([full, loadTreeFixture("card")]);
  const a = await codeFor(plain);
  const [first] = await push(mock, a);
  const component = sets(first).find((s) => s.component === "ui-base-switch")!;
  const at = mock.handle(component.id) as { x: number; y: number; type: string };
  assert.equal(at.type, "COMPONENT");
  const [x, y] = [at.x, at.y];

  const asked = await codeIn(both, a.out);
  assert.ok(asked.warnings.some((w) => /^ui\/base\/Switch: an earlier push built it as one plain component, and it now has variant properties \(size\): ask the user .*--convert ui\/base\/Switch/.test(w)), asked.warnings.join("\n"));
  const [refused] = await runPlan(mock, asked, ["build"]);
  const answer = sets(refused).find((s) => s.component === "ui-base-switch")!;
  assert.match(answer.refused!, /this part builds a COMPONENT_SET: ask the user whether to convert it in place \(figma code --convert\) or skip it$/);
  assert.equal((mock.handle(component.id) as { type: string }).type, "COMPONENT", "left as it was");
  assert.ok(sets(refused).find((s) => s.component === "ui-base-card")!.variants > 0, "Card is built");

  const yes = await codeIn(both, a.out, { convert: ["Switch"] });
  assert.ok(!yes.warnings.some((w) => /plain component/.test(w)));
  const [converted] = await runPlan(mock, yes, ["build"]);
  const set = sets(converted).find((s) => s.component === "ui-base-switch")!;
  assert.deepEqual([set.converted, set.variants, set.added, set.refused], [1, 2, 1, undefined]);
  const node = mock.handle(set.id) as { type: string; x: number; y: number; name: string };
  assert.deepEqual([node.type, node.name, node.x, node.y], ["COMPONENT_SET", "Switch", x, y]);
  // The plain component is the default variant now, under its own node id.
  const variant = variantsBySlug(mock, "ui-base-switch").get(full.components[0].variants.find((v) => v.combination.size === "default")!.slug)!;
  assert.equal(variant.id, component.id);
});

test("build: a set that grows where it is moves down the set it grew onto, and counts no overlap", async () => {
  const before = withoutProp(loadTreeFixture("example-button"), "disabled", "false");
  const other = copy(loadTreeFixture("switch").components[0]);
  other.category = "Forms";
  before.components.push(other);
  const mock = mockFor([loadTreeFixture("example-button"), loadTreeFixture("switch")]);
  const [first] = await push(mock, await codeFor(before));
  const [button, toggle] = sets(first);
  // A designer put Switch beside Button, where Button grows into once it has `disabled`.
  const b = mock.handle(button.id) as { x: number; y: number; width: number };
  await mock.run(`const s = await figma.getNodeByIdAsync(${JSON.stringify(toggle.id)}); s.x = ${b.x + b.width + 40}; s.y = ${b.y};`);
  const after = loadTreeFixture("example-button");
  after.components.push(other);
  const [then] = await push(mock, await codeFor(after));
  const [grown] = sets(then);
  const g = mock.handle(grown.id) as { x: number; y: number; width: number; height: number };
  const s = mock.handle(toggle.id) as { x: number; y: number };
  assert.deepEqual([grown.moved, grown.overlaps], [[toggle.id], 0]);
  assert.equal(s.y, g.y + g.height + 100);
  // Built again, nothing moves.
  const [again] = await push(mock, await codeFor(after));
  assert.deepEqual([sets(again)[0].moved, sets(again)[0].overlaps], [undefined, 0]);
});

test("build and read: the first call of each kind stores its template in the file, the rest run it from there, refused where the file holds another", async () => {
  const snap = copy(loadTreeFixture("switch"));
  snap.components.push(copy(loadTreeFixture("example-button").components[0]));
  const coded = await codeFor(snap);
  const builds = coded.plan.calls.filter((c) => c.kind === "build");
  assert.equal(builds.length, 2);
  const [first, later] = builds.map((c) => coded.code(c));
  const template = loadTemplate("build");
  assert.ok(first.includes(`figma.root.setSharedPluginData("storysync","template build",T);`) && first.length > template.length);
  assert.ok(!later.includes(template.slice(0, 200)) && later.length < 3_000 + later.indexOf("const SUM"), `${later.length} characters`);
  // Sent before the first, it changes nothing, and says what to send.
  const mock = mockFor([loadTreeFixture("switch"), loadTreeFixture("example-button")]);
  const pages = JSON.stringify(mock.pages());
  const alone = await mock.run(later);
  assert.equal(alone.text, `Error: ${missingTemplate("build", "01")}`);
  assert.equal(JSON.stringify(mock.pages()), pages);
  // In order, the second runs what the first stored: the very template.
  await runPlan(mock, coded);
  assert.equal(mock.node("0:0")!.data[`storysync.${templateKey("build")}`], template);
  // Another storysync's push stores its own: refused again, until the first is sent again.
  await mock.run(`figma.root.setSharedPluginData("storysync", ${JSON.stringify(templateKey("build"))}, "return 1;");`);
  assert.equal((await mock.run(later)).text, `Error: ${missingTemplate("build", "01")}`);
  assert.ok((await mock.run(first)).ok);
  assert.ok((await mock.run(later)).ok);
  // So do the reads: the first carries the readback template, the rest load it.
  const reads = coded.plan.calls.filter((c) => c.kind === "read").map((c) => coded.code(c));
  assert.ok(reads.slice(1).every((r) => r.includes('const T = figma.root.getSharedPluginData("storysync","template readback");')));
});

test("build: a variant too big for one call is sent in parts, kept on the page until its last part builds it whole, which says what to send where a part is missing", async () => {
  const card = loadTreeFixture("card");
  // At 24,000 the first call, which carries the build template, holds a few
  // of Card's nodes, and the next the rest. Where every call carries the
  // template, each part holds a few, its icons' markup among them.
  for (const inlineTemplates of [false, true]) {
    const coded = await codeFor(card, { maxChars: 24_000, inlineTemplates });
    const builds = coded.plan.calls.filter((c) => c.kind === "build");
    const parts = builds.filter((c) => /variant 1 of 2, part \d+ of/.test(c.description)).length;
    assert.ok(inlineTemplates ? parts > 3 : parts === 2, `${parts} parts`);
    assert.match(builds[0].description, new RegExp(`^Create or update Card \\(variant 1 of 2, part 1 of ${parts}\\) on page "ui/base"$`));
    for (const call of builds) assert.ok(call.chars <= 24_000, `${call.file}: ${call.chars}`);
    const mock = mockFor([card]);
    const runs = await runPlan(mock, coded, ["build"]);
    assert.deepEqual(sets(runs[0]), [{ component: "ui-base-card", name: "Card", stashed: 1 }]);
    assert.deepEqual(runs.flatMap((r) => (r.value as { fallbacks: unknown[] }).fallbacks), [], "every icon imported from its own markup");
    // Built whole: every layer where snap measured it, and nothing left on the page.
    for (const variant of fixtureVariants(card)) {
      const root = variantsBySlug(mock).get(variant.slug)!;
      assert.deepEqual(boxDrift(mock, root, variant.nodes, absoluteBoxes(variant.nodes)), [], variant.slug);
    }
    assert.deepEqual(mock.pages().flatMap((p: NodeView) => Object.keys(p.data).filter((k) => k.startsWith("storysync.part "))), []);
    // Built again, the same; its last part sent without the ones before says which to send.
    await runPlan(mock, coded, ["build"]);
    const last = parts - 1;
    const fresh = mockFor([card]);
    for (const call of builds.slice(0, last)) assert.ok((await fresh.run(coded.code(call))).ok);
    // Its first part's, as a call sent to another file, or not at all, would leave it.
    const slug = card.components[0].variants[0].slug;
    await fresh.run(`figma.root.children.find((p) => p.name === "ui/base").setSharedPluginData("storysync", "part ui-base-card ${slug} 1", "");`);
    const missing = await fresh.run(coded.code(builds[last]));
    assert.match(missing.text, new RegExp(`^Error: Variant ${card.components[0].variants[0].slug} of Card is sent in ${parts} calls: send call ${builds.slice(0, last).map((c) => String(c.seq).padStart(2, "0")).join(", ")} first, then this one again$`));
    // A set refused at its last part keeps none of its parts on the page.
    const twice = mockFor([card]);
    await twice.run(`const p = figma.createPage(); p.name = "ui/base"; for (const x of [0, 400]) { const c = figma.createComponent(); c.name = "size=default"; const s = figma.combineAsVariants([c], p); s.name = "Card"; s.x = x; }`);
    const refused = await runPlan(twice, coded, ["build"]);
    assert.match(sets(refused[last])[0].refused!, /ask the user which to update$/);
    assert.deepEqual(twice.pages().flatMap((p: NodeView) => Object.keys(p.data).filter((k) => k.startsWith("storysync.part "))), []);
  }
});

test("build: a label Figma's font sets wider than the frame it fills grows the frame into its row's free room, so it is drawn whole, as Select's trigger (probe 9a)", async () => {
  const inter = figmaFonts();
  const own = inter.advance("Select a fruit", { family: "Inter", style: "Regular", size: 14, letterSpacing: 0 });
  // The browser's box half a pixel narrower than Figma sets it, in a row with room to spare.
  const w = Math.round((own - 0.5) * 100) / 100;
  const base = copy(loadTreeFixture("example-button"));
  const c = base.components[0];
  const tree = [
    { k: "", t: "F", el: "button", box: [0, 0, 180, 40], L: { d: "flex", jc: "space-between", ai: "center", pad: [8, 12, 8, 12] } },
    { k: "span", t: "F", el: "span", box: [12, 8, w, 24], L: { d: "flow-root" }, clip: 1 },
    { k: "span/#text", t: "T", el: "#text", box: [0, 0, w, 24], tx: { c: "Select a fruit", f: "system-ui", fk: 1, sz: 14, wt: 400, col: "#52525b", lh: 24, n: 1, cl: 1, ws: "nowrap", ink: [0, 3, w, 18] } },
    { k: "box", t: "F", el: "div", box: [150, 11, 18, 18] },
  ];
  Object.assign(c, {
    id: "test-trigger", name: "Trigger", title: "test/Trigger", category: "test", variantProperties: [],
    base: { combination: {}, slug: "default", styles: { ...c.base!.styles, width: 180, height: 40, display: "flex" } },
    variants: [{ combination: {}, slug: "default", status: "ok", error: null, delta: {} }],
    warnings: [], tree: { version: 1, base: tree, assets: { svg: {}, img: {} } },
  });
  const coded = await codeFor(base);
  const mock = mockFor([base], { measure: figmaFonts() });
  const [run] = await runPlan(mock, coded, ["build"]);
  const text = mock.nodes("TEXT").find((n) => n.data["storysync.k"] === "span/#text")!;
  const span = mock.nodes("FRAME").find((n) => n.data["storysync.k"] === "span")!;
  const h = mock.handle(text.id) as { textTruncation: string; maxLines: number };
  assert.deepEqual([span.width, text.width, text.height, h.textTruncation, h.maxLines], [Math.ceil(own), Math.ceil(own), 24, "ENDING", 1]);
  assert.deepEqual((run.value as { fallbacks: unknown[] }).fallbacks, []);
});
