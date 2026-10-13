import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, fnv1a32, fnv1a32Bytes } from "../checksum.js";
import * as verifyModule from "../verify.js";
import {
  RECORD, RECORD_BY_TPL, ROOT_FIELDS, TREE_LIMITS, TREE_VERSION,
  absoluteBoxes, diffTree, expandTree, flowOf, parentKey, rootWithStyles, textHugs, treeDigest,
} from "../tree-types.js";
import type { Box, ComponentTree, TreeDelta, TreeNode } from "../tree-types.js";
import { fixtureVariants, loadTreeFixture, treeFixtureAsset, treeFixtureNames, imageSize } from "./mock-figma.js";
import type { TreeFixture } from "./mock-figma.js";

// The contract every tree package reads through. diffTree and expandTree
// carry a variant's whole measurement between snap and the build, and
// absoluteBoxes and flowOf decide where verify expects each node: a slip in
// any of them shows up as a wrong Figma layer that verify then scores as
// right, so each is pinned here on small trees and on every T fixture.

const frame = (k: string, box: Box, extra: Partial<TreeNode> = {}): TreeNode => ({ k, t: "F", el: "div", box, ...extra });
const text = (k: string, box: Box, c: string, ink: Box, extra: Partial<TreeNode> = {}): TreeNode => ({
  k, t: "T", el: "#text", box, tx: { c, f: "system-ui", fk: 1, sz: 14, wt: 500, col: "#0a0a0a", lh: 20, n: 1, ink }, ...extra,
});
const treeOf = (base: TreeNode[]): ComponentTree => ({ version: 1, base, assets: { svg: {}, img: {} } });

// --- checksum.ts --------------------------------------------------------------

test("checksum: verify.ts re-exports canonicalJson and fnv1a32 from checksum.ts, the same functions", () => {
  assert.equal(verifyModule.canonicalJson, canonicalJson);
  assert.equal(verifyModule.fnv1a32, fnv1a32);
});

test("fnv1a32Bytes: FNV-1a's published vectors, and the same digest as fnv1a32 over ASCII", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(fnv1a32Bytes(new Uint8Array()), "811c9dc5");
  assert.equal(fnv1a32Bytes(bytes("a")), "e40c292c");
  assert.equal(fnv1a32Bytes(bytes("foobar")), "bf9cf968");
  for (const s of ["", "card-header/card-title", '{"a":[1,2]}']) assert.equal(fnv1a32Bytes(bytes(s)), fnv1a32(s));
  // Every byte value counts, high ones included: a JPEG is mostly above 0x7f.
  assert.notEqual(fnv1a32Bytes(Uint8Array.of(0xff, 0xd8)), fnv1a32Bytes(Uint8Array.of(0xff, 0xd9)));
  assert.match(fnv1a32Bytes(Uint8Array.of(0xff, 0xd8, 0xff)), /^[0-9a-f]{8}$/);
});

// --- Constants ------------------------------------------------------------------

test("constants: the limits, record arities and root fields the design fixes", () => {
  assert.equal(TREE_VERSION, 1);
  assert.deepEqual(TREE_LIMITS, { maxNodes: 400, maxDepth: 24, maxSvgChars: 20_000 });
  assert.deepEqual(RECORD, { F: 15, T: 24, V: 10 });
  assert.deepEqual(RECORD_BY_TPL, { 2: { F: 15, T: 23, V: 10 }, 3: RECORD });
  // Paint, size and type stay in the root's styles, so the root node never carries them.
  for (const paint of ["bg", "bd", "r", "sh", "op", "tx", "S", "abs"]) assert.ok(!(ROOT_FIELDS as readonly string[]).includes(paint), paint);
  // What no style holds does go on it, so a root that is an <svg> or an <img> can be written down.
  for (const fact of ["L", "clip", "tf", "cp", "svg", "shapes", "img", "raster", "approx"]) assert.ok((ROOT_FIELDS as readonly string[]).includes(fact), fact);
});

// --- parentKey ------------------------------------------------------------------

test("parentKey: the key up to its last slash, the root for a top-level key, null for the root", () => {
  assert.equal(parentKey(""), null);
  assert.equal(parentKey("card-header"), "");
  assert.equal(parentKey("::after"), "");
  assert.equal(parentKey("#text"), "");
  assert.equal(parentKey("card-header/card-title"), "card-header");
  assert.equal(parentKey("card-content/div:2/p:2"), "card-content/div:2");
  assert.equal(parentKey("attachment-action/svg"), "attachment-action");
  // A slot holding a slash was written with U+2215, so it stays one segment.
  assert.equal(parentKey("a∕b/c"), "a∕b");
});

// --- expandTree -----------------------------------------------------------------

const BASE: TreeNode[] = [
  frame("", [0, 0, 100, 40], { L: { d: "flex", ai: "center", pad: [0, 10, 0, 10] } }),
  frame("icon", [10, 12, 16, 16], { bg: "#ffffff", r: 8 }),
  text("#text", [30, 10, 50, 20], "Label", [0, 1.5, 50, 17]),
];

test("expandTree: no delta is the base variant's own nodes, as copies", () => {
  const nodes = expandTree(treeOf(BASE), undefined);
  assert.deepEqual(nodes, BASE);
  nodes[1].box[0] = 99;
  nodes[1].bg = "#000000";
  assert.equal(BASE[1].box[0], 10, "the base is not shared with what expandTree returns");
  assert.equal(BASE[1].bg, "#ffffff");
});

test("expandTree: set changes whole fields, and null or undefined removes one", () => {
  const nodes = expandTree(treeOf(BASE), { set: { icon: { box: [10, 10, 20, 20], bg: null, op: 0.5 }, "#text": { r: undefined } } });
  assert.deepEqual(nodes[1], { k: "icon", t: "F", el: "div", box: [10, 10, 20, 20], r: 8, op: 0.5 });
  assert.deepEqual(nodes[2], BASE[2]);
  assert.deepEqual(nodes[0], BASE[0]);
});

test("expandTree: keys reorder, drop and add nodes; an added node comes whole from set", () => {
  const badge = frame("badge", [80, 0, 10, 10], { bg: "#ff0000" });
  const nodes = expandTree(treeOf(BASE), { keys: ["", "#text", "badge"], set: { badge } });
  assert.deepEqual(nodes.map((n) => n.k), ["", "#text", "badge"]);
  assert.deepEqual(nodes[2], badge);
  // A full node may leave out its key: the delta's key is it.
  const { k: _k, ...keyless } = badge;
  assert.deepEqual(expandTree(treeOf(BASE), { keys: ["", "badge"], set: { badge: keyless } })[1], badge);
});

test("expandTree: refuses a delta that describes no tree, rather than guess", () => {
  const tree = treeOf(BASE);
  assert.throws(() => expandTree(tree, { keys: ["", "icon", "icon"] }), /lists the key "icon" twice/);
  assert.throws(() => expandTree(tree, { keys: ["", "ghost"] }), /"ghost" is not in the base tree/);
  assert.throws(() => expandTree(tree, { keys: [""], set: { icon: { op: 0.5 } } }), /changes "icon", which the variant does not have/);
  assert.throws(() => expandTree(tree, { set: { ghost: { op: 0.5 } } }), /changes "ghost"/);
  assert.throws(() => expandTree(tree, { keys: ["", "x"], set: { x: { k: "x", t: "F", el: "div" } as unknown as TreeNode } }), /without "box"/);
  assert.throws(() => expandTree(tree, { set: { icon: { k: "other" } } }), /changes the key of "icon"/);
  assert.throws(() => expandTree(treeOf([...BASE, BASE[1]]), undefined), /holds the key "icon" twice/);
});

test("expandTree: refuses key lists that are no tree in preorder, the root first and parents before children", () => {
  const tree = treeOf([frame("", [0, 0, 100, 40]), frame("a", [0, 0, 10, 10]), frame("a/x", [1, 1, 2, 2]), frame("b", [10, 0, 10, 10])]);
  assert.throws(() => expandTree(tree, { keys: ["a", "b"] }), /first node is "a", not the root ""/);
  assert.throws(() => expandTree(tree, { keys: ["a", "", "b"] }), /first node is "a", not the root ""/);
  assert.throws(() => expandTree(tree, { keys: [] }), /has no nodes, not even the root/);
  assert.throws(() => expandTree(tree, { keys: ["", "a/x", "a", "b"] }), /"a\/x" comes before its parent "a"/);
  assert.throws(() => expandTree(tree, { keys: ["", "a/x", "b"] }), /"a\/x" comes before its parent "a", or the variant has no "a"/);
  // The base is held to the same, delta or none.
  assert.throws(() => expandTree(treeOf([frame("a", [0, 0, 1, 1])]), undefined), /not the root ""/);
  assert.deepEqual(expandTree(tree, { keys: ["", "b", "a", "a/x"] }).map((n) => n.k), ["", "b", "a", "a/x"], "siblings in any order");
});

test("expandTree: refuses a change that is not fields, and fields that would reach the prototype", () => {
  const tree = treeOf(BASE);
  assert.throws(() => expandTree(tree, { set: { icon: null } } as unknown as TreeDelta), /sets "icon" to null, not a node or the fields that change/);
  assert.throws(() => expandTree(tree, { set: { icon: [1] } } as unknown as TreeDelta), /sets "icon" to \[1\]/);
  const poisoned = JSON.parse('{"set":{"icon":{"__proto__":{"bg":"#ffffff"}}}}') as TreeDelta;
  assert.throws(() => expandTree(tree, poisoned), /sets a field named "__proto__" on "icon"/);
  const added = JSON.parse('{"keys":["","badge"],"set":{"badge":{"t":"F","el":"div","box":[0,0,1,1],"constructor":{}}}}') as TreeDelta;
  assert.throws(() => expandTree(tree, added), /sets a field named "constructor" on "badge"/);
});

test("expandTree: a null in a base node is absent, as diffTree reads it, so the round trip holds", () => {
  const base = [frame("", [0, 0, 10, 10]), frame("a", [0, 0, 1, 1], { bg: null })];
  const variant = [frame("", [0, 0, 10, 10]), frame("a", [0, 0, 1, 1])];
  assert.deepEqual(diffTree(base, variant), {});
  assert.deepEqual(expandTree(treeOf(base), diffTree(base, variant)), variant);
  assert.deepEqual(expandTree(treeOf(base), undefined), variant);
  assert.equal(treeDigest(base), treeDigest(variant), "and digests the same");
});

// --- diffTree ---------------------------------------------------------------------

test("diffTree: an identical variant has no delta; a restyle sets only what changed", () => {
  assert.deepEqual(diffTree(BASE, structuredClone(BASE)), {});
  const variant = structuredClone(BASE);
  variant[1].bg = "#f5f5f5";
  delete variant[1].r;
  variant[2].tx!.ink = [0, 1.5, 52, 17];
  assert.deepEqual(diffTree(BASE, variant), {
    set: { icon: { bg: "#f5f5f5", r: null }, "#text": { tx: { ...BASE[2].tx!, ink: [0, 1.5, 52, 17] } } },
  });
});

test("diffTree: compares values, not how a file wrote them", () => {
  const variant = structuredClone(BASE).map((n) => Object.fromEntries(Object.entries(n).reverse()) as unknown as TreeNode);
  variant[0].L = { pad: [0, 10, 0, 10], ai: "center", d: "flex" };
  assert.deepEqual(diffTree(BASE, variant), {});
});

test("diffTree: a reorder, an added node or a dropped one writes the key list", () => {
  const swapped = [BASE[0], BASE[2], BASE[1]];
  assert.deepEqual(diffTree(BASE, swapped), { keys: ["", "#text", "icon"] });
  const dropped = [BASE[0], BASE[2]];
  assert.deepEqual(diffTree(BASE, dropped), { keys: ["", "#text"] });
  const added = [...BASE, frame("::after", [0, 0, 100, 40], { abs: 1, bd: { w: 1, s: "solid", c: "#e5e5e5" } })];
  assert.deepEqual(diffTree(BASE, added), { keys: ["", "icon", "#text", "::after"], set: { "::after": added[3] } });
});

test("diffTree: a null in the variant is absent, as in any node, so a round trip drops it", () => {
  const variant = structuredClone(BASE);
  (variant[1] as unknown as Record<string, unknown>).bg = null;
  const delta = diffTree(BASE, variant);
  assert.deepEqual(delta, { set: { icon: { bg: null } } });
  assert.equal("bg" in expandTree(treeOf(BASE), delta)[1], false);
  assert.throws(() => diffTree(BASE, [...BASE, BASE[2]]), /variant's tree holds the key "#text" twice/);
});

/** A small deterministic generator, so the round trip is tried on trees no one wrote by hand. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0;
    return s / 0x100000000;
  };
}

test("diffTree then expandTree gives back the variant, on generated trees", () => {
  const next = random(7);
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)];
  const node = (k: string): TreeNode => {
    const n: TreeNode = { k, t: pick(["F", "T", "V"] as const), el: pick(["div", "span", "svg"]), box: [Math.round(next() * 100), Math.round(next() * 40), 10, 10] };
    if (next() < 0.5) n.bg = pick(["#ffffff", "#0a0a0a", "#e5e5e5"]);
    if (next() < 0.3) n.r = pick([4, 8, [8, 0, 0, 8] as [number, number, number, number]]);
    if (next() < 0.3) n.L = { d: pick(["flex", "block", "grid"]), gap: [4, 4] };
    if (next() < 0.2) n.sh = [[0, 1, 2, 0, "#0000000d"]];
    return n;
  };
  for (let round = 0; round < 200; round++) {
    const keys = ["", ...Array.from({ length: 1 + Math.floor(next() * 8) }, (_, i) => `n${i}`)];
    const base = keys.map(node);
    let variant = base.map((n) => (next() < 0.5 ? structuredClone(n) : { ...node(n.k) }));
    if (next() < 0.3) variant = variant.filter((n, i) => i === 0 || next() < 0.7);
    if (next() < 0.3) variant.push(node(`extra${round}`));
    if (next() < 0.2) variant = [variant[0], ...variant.slice(1).reverse()];
    assert.deepEqual(expandTree(treeOf(base), diffTree(base, variant)), variant, `round ${round}`);
  }
});

// --- absoluteBoxes ------------------------------------------------------------------

test("absoluteBoxes: adds each parent's position down the tree, rounded to 0.01", () => {
  const nodes = [
    frame("", [0, 0, 200, 100]),
    frame("a", [10.1, 20.2, 50, 50]),
    frame("a/b", [0.2, 0.1, 10, 10]),
    text("a/b/#text", [1, 1, 5, 5], "x", [0, 0, 5, 5]),
    frame("c", [100, 0, 10, 10]),
  ];
  const boxes = absoluteBoxes(nodes);
  assert.deepEqual(boxes.get(""), [0, 0, 200, 100]);
  assert.deepEqual(boxes.get("a/b"), [10.3, 20.3, 10, 10]);
  assert.deepEqual(boxes.get("a/b/#text"), [11.3, 21.3, 5, 5]);
  assert.deepEqual(boxes.get("c"), [100, 0, 10, 10]);
  assert.throws(() => absoluteBoxes([nodes[0], nodes[2], nodes[1]]), /"a\/b" comes before its parent "a"/);
  assert.throws(() => absoluteBoxes([nodes[0], nodes[0]]), /holds the key "" twice/);
});

// --- treeDigest ------------------------------------------------------------------------

test("treeDigest: 8 hex digits of the facts, whatever order a file wrote their keys in", () => {
  const digest = treeDigest(BASE);
  assert.match(digest, /^[0-9a-f]{8}$/);
  assert.equal(digest, fnv1a32(canonicalJson(BASE)));
  const reordered = BASE.map((n) => Object.fromEntries(Object.entries(n).reverse()) as unknown as TreeNode);
  assert.equal(treeDigest(reordered), digest);
  // An undefined field is absent, as it would be in a file.
  assert.equal(treeDigest(BASE.map((n) => ({ ...n, approx: undefined }))), digest);
  const moved = structuredClone(BASE);
  moved[2].box[0] = 31;
  assert.notEqual(treeDigest(moved), digest);
  assert.notEqual(treeDigest([BASE[0], BASE[2], BASE[1]]), digest, "order is part of the facts");
});

test("treeDigest: the root's paint counts once the root goes through rootWithStyles, as the build and verify pass it", () => {
  const component = loadTreeFixture("switch").components[0];
  const [root, ...rest] = fixtureVariants(loadTreeFixture("switch"))[0].nodes;
  const styles = component.base!.styles;
  const digest = (s: typeof styles) => treeDigest([rootWithStyles(root, s), ...rest]);
  assert.notEqual(digest({ ...styles, backgroundColor: "#000000" }), digest(styles), "a re-snap that changes only the root's background");
  assert.notEqual(digest(styles), treeDigest([root, ...rest]), "the root as stored holds none of that paint");
});

// --- textHugs ------------------------------------------------------------------------

test("textHugs: a box at most 6% and 1px wider than its glyphs hugs; a wider block does not", () => {
  assert.equal(textHugs(text("t", [0, 0, 100, 20], "x", [0, 0, 100, 17])), true);
  assert.equal(textHugs(text("t", [0, 0, 107, 20], "x", [0, 0, 100, 17])), true);
  assert.equal(textHugs(text("t", [0, 0, 107.01, 20], "x", [0, 0, 100, 17])), false);
  assert.equal(textHugs(text("t", [0, 0, 336, 24], "Notifications", [0, 3, 94.17, 18])), false);
  // A box narrower than its text is within the formula; a truncation (`el`, `cl`) is decided before it.
  assert.equal(textHugs(text("t", [0, 0, 94, 17.5], "sales-dashboard.pdf", [0, 0, 137.69, 17])), true);
  assert.equal(textHugs(frame("f", [0, 0, 10, 10])), false);
});

// --- flowOf ---------------------------------------------------------------------------

const row = (L: TreeNode["L"], kids: [string, Box, Partial<TreeNode>?][], extra: Partial<TreeNode> = {}) => ({
  parent: frame("p", [0, 0, 100, 40], { L, ...extra }),
  kids: kids.map(([k, box, more]) => frame(k, box, more)),
});

test("flowOf: a flex row packed at the start anchors each child to the one before it", () => {
  const { parent, kids } = row({ d: "flex", ai: "center", pad: [4, 10, 4, 10] }, [["a", [10, 12, 16, 16]], ["b", [32, 10, 40, 20]]]);
  const flow = flowOf(parent, kids);
  assert.equal(flow.axis, "x");
  assert.deepEqual(flow.content, [10, 4, 80, 32]);
  assert.deepEqual(flow.inflow, ["a", "b"]);
  assert.deepEqual(flow.main, { a: 0, b: 6 });
  // Centered across: offsets from the content's center line.
  assert.deepEqual(flow.cross, { a: 0, b: 0 });
});

test("flowOf: a wider child moves its followers without moving their anchors", () => {
  const { parent, kids } = row({ d: "flex" }, [["label", [0, 0, 50, 20]], ["icon", [56, 0, 16, 16]]]);
  const wider = [frame("label", [0, 0, 53, 20]), frame("icon", [59, 0, 16, 16])];
  assert.deepEqual(flowOf(parent, wider).main, flowOf(parent, kids).main);
  // A follower 3px out of place is not explained by its anchor.
  const off = [frame("label", [0, 0, 50, 20]), frame("icon", [59, 0, 16, 16])];
  assert.equal(flowOf(parent, off).main.icon - flowOf(parent, kids).main.icon, 3);
});

test("flowOf: centered, end and space-* rows anchor to where the free space puts them", () => {
  const kids: [string, Box][] = [["a", [20, 0, 20, 10]], ["b", [50, 0, 30, 10]]];
  const center = flowOf(row({ d: "flex", jc: "center", gap: [10, 10] }, kids).parent, row({ d: "flex" }, kids).kids);
  // Sizes of 50 and a gap of 10 leave 40 of 100 free: centered, the first child starts 20 in, 0 from centered.
  assert.deepEqual(center.main, { a: 0, b: 10 });
  const end = flowOf(row({ d: "flex", jc: "flex-end" }, kids).parent, row({ d: "flex" }, kids).kids);
  assert.deepEqual(end.main, { a: 10, b: 20 });
  const apart: [string, Box][] = [["a", [0, 0, 20, 10]], ["b", [70, 0, 30, 10]]];
  const between = flowOf(row({ d: "flex", jc: "space-between" }, apart).parent, row({ d: "flex" }, apart).kids);
  assert.deepEqual(between.main, { a: 0, b: 0 });
  const around = flowOf(row({ d: "flex", jc: "space-around" }, kids).parent, [frame("a", [12.5, 0, 20, 10]), frame("b", [57.5, 0, 30, 10])]);
  assert.deepEqual(around.main, { a: 0, b: 0 });
  const evenly = flowOf(row({ d: "flex", jc: "space-evenly" }, kids).parent, [frame("a", [16.67, 0, 20, 10]), frame("b", [53.33, 0, 30, 10])]);
  assert.deepEqual(evenly.main, { a: 0, b: 0 });
});

test("flowOf: centered, the first child is anchored by the sizes and gaps, so a last child out of place moves only its own anchor", () => {
  const parent = frame("p", [0, 0, 100, 10], { L: { d: "flex", jc: "center", gap: [10, 10] } });
  const snap = flowOf(parent, [frame("a", [35, 0, 10, 10]), frame("b", [55, 0, 10, 10])]);
  assert.deepEqual(snap.main, { a: 0, b: 10 });
  const figma = flowOf(parent, [frame("a", [35, 0, 10, 10]), frame("b", [58, 0, 10, 10])], snap);
  assert.deepEqual(figma.main, { a: 0, b: 13 }, "b is 3px off; a is where it was");
  // A label 6px wider in Figma, centered as Figma centers it, leaves every anchor where it was.
  const wider = flowOf(parent, [frame("a", [32, 0, 16, 10]), frame("b", [58, 0, 10, 10])], snap);
  assert.deepEqual(wider.main, snap.main);
  // A margin the CSS gap does not hold sits in both worlds alike.
  const margin = flowOf(parent, [frame("a", [33, 0, 10, 10]), frame("b", [57, 0, 10, 10])]);
  assert.deepEqual(margin.main, { a: -2, b: 14 });
});

test("flowOf: in a reversed flow, flex-start and flex-end follow the flow while start, end, left and right keep their sides", () => {
  const reversed = (jc: string, kids: [string, Box][]) =>
    flowOf(frame("p", [0, 0, 100, 10], { L: { d: "flex", dir: "row-reverse", jc } }), kids.map(([k, box]) => frame(k, box)));
  const atRight: [string, Box][] = [["a", [90, 0, 10, 10]], ["b", [80, 0, 10, 10]]];
  const atLeft: [string, Box][] = [["a", [10, 0, 10, 10]], ["b", [0, 0, 10, 10]]];
  // Packed at the right: the flow's start in row-reverse, and the row's end.
  for (const jc of ["normal", "flex-start", "end", "right"]) assert.deepEqual(reversed(jc, atRight).main, { a: 0, b: 0 }, jc);
  // Packed at the left: the flow's end, and the row's start.
  for (const jc of ["flex-end", "start", "left"]) assert.deepEqual(reversed(jc, atLeft).main, { b: 0, a: 0 }, jc);
  assert.deepEqual(reversed("end", atLeft).main, { a: 80, b: 0 }, "end packed at the left is 80px off");
  // On a column, left and right act as start.
  const column = (jc: string) => flowOf(frame("p", [0, 0, 10, 100], { L: { d: "flex", dir: "column-reverse", jc } }), [frame("a", [0, 0, 10, 10])]);
  assert.deepEqual([column("right").main, column("left").main, column("flex-start").main], [{ a: 0 }, { a: 0 }, { a: 90 }]);
});

test("flowOf: a reversed row anchors from the content end; a column runs along y", () => {
  const reversed = flowOf(frame("p", [0, 0, 100, 40], { L: { d: "flex", dir: "row-reverse" } }), [frame("a", [80, 0, 20, 10]), frame("b", [50, 0, 26, 10])]);
  assert.equal(reversed.reverse, true);
  assert.deepEqual(reversed.inflow, ["a", "b"]);
  assert.deepEqual(reversed.main, { a: 0, b: 4 });
  const column = flowOf(frame("p", [0, 0, 100, 100], { L: { d: "flex", dir: "column", ai: "flex-end", gap: [8, 8] } }), [frame("a", [60, 0, 40, 20]), frame("b", [90, 28, 10, 10])]);
  assert.equal(column.axis, "y");
  assert.deepEqual(column.main, { a: 0, b: 8 });
  assert.deepEqual(column.cross, { a: 0, b: 0 });
});

test("flowOf: align-self overrides align-items across the flow", () => {
  const flow = flowOf(frame("p", [0, 0, 100, 40], { L: { d: "flex", ai: "center" } }), [
    frame("a", [0, 15, 10, 10]),
    frame("b", [10, 30, 10, 10], { S: { as: "flex-end" } }),
    frame("c", [20, 0, 10, 10], { S: { as: "flex-start" } }),
  ]);
  assert.deepEqual(flow.cross, { a: 0, b: 0, c: 0 });
});

test("flowOf: a block of stacked children runs along y; one whose children share a line has no flow", () => {
  const lines = [text("p", [0, 0, 191.08, 20], "a", [0, 1, 191, 17]), text("p:2", [0, 20, 67.41, 20], "b", [0, 1, 67, 17])];
  const stacked = flowOf(frame("p", [0, 0, 200, 40], { L: { d: "block" } }), lines);
  assert.equal(stacked.axis, "y");
  assert.deepEqual(stacked.main, { p: 0, "p:2": 0 });
  // Half-leading rounding can overlap two lines by a pixel and they still stack.
  assert.equal(flowOf(frame("p", [0, 0, 200, 40], { L: { d: "block" } }), [frame("a", [0, 0, 10, 20]), frame("b", [0, 19, 10, 20])]).axis, "y");
  const inline = flowOf(frame("p", [0, 0, 200, 20], { L: { d: "block" } }), [frame("a", [0, 0, 40, 20]), frame("b", [44, 0, 40, 20])]);
  assert.equal(inline.axis, null);
  assert.deepEqual(inline.main, {});
  // Block flow is how a box lays out its children: an inline-block's stack; an inline's and a table cell's do not.
  const one = [frame("a", [0, 3, 10, 14])];
  assert.deepEqual(["block", "flow-root", "list-item", "inline-block", "inline", "table-cell", "contents"].map((d) => flowOf(frame("p", [0, 0, 100, 20], { L: { d } }), one).axis),
    ["y", "y", "y", "y", null, null, null]);
});

test("flowOf: another world takes snap's axis, so a block child 3px into the one above is scored along y", () => {
  const parent = frame("p", [0, 0, 100, 40], { L: { d: "block" } });
  const snap = flowOf(parent, [frame("a", [0, 0, 10, 20]), frame("b", [0, 20, 10, 20])]);
  assert.deepEqual([snap.axis, snap.main], ["y", { a: 0, b: 0 }]);
  assert.equal(flowOf(parent, [frame("a", [0, 0, 10, 20]), frame("b", [0, 17, 10, 20])]).axis, null, "on its own, it has no flow");
  const figma = flowOf(parent, [frame("a", [0, 0, 10, 20]), frame("b", [0, 17, 10, 20])], snap);
  assert.deepEqual([figma.axis, figma.main], ["y", { a: 0, b: -3 }]);
  // And snap's null: a flow snap could not anchor is not anchored in Figma either.
  const none = flowOf(parent, [frame("a", [0, 0, 10, 20]), frame("b", [0, 20, 10, 20])], { axis: null, inflow: ["a", "b"] });
  assert.deepEqual([none.axis, none.main], [null, {}]);
});

test("flowOf: a single-column grid stacks; several columns, or a wrapping flex, have no flow", () => {
  const kids = [frame("a", [24, 0, 336, 24]), frame("b", [24, 28, 336, 20])];
  const header = frame("card-header", [0, 24, 384, 48], { L: { d: "grid", gap: [4, 4], pad: [0, 24, 0, 24], tracks: [1, 2] } });
  assert.equal(flowOf(header, kids).axis, "y");
  assert.deepEqual(flowOf(header, kids).main, { a: 0, b: 4 });
  assert.equal(flowOf(frame("g", [0, 0, 100, 40], { L: { d: "grid", tracks: [2, 1] } }), kids).axis, null);
  assert.equal(flowOf(frame("w", [0, 0, 100, 40], { L: { d: "flex", wrap: 1 } }), kids).axis, null);
});

test("flowOf: out-of-flow children are left out, and the border and padding bound the content", () => {
  const flow = flowOf(frame("p", [0, 0, 36, 36], { L: { d: "flex", pad: [2, 3, 4, 5] }, bd: { w: [1, 1, 1, 0], s: "solid", c: "#e5e5e5" } }), [
    frame("::after", [0, 0, 36, 36], { abs: 1 }),
    frame("a", [5, 3, 10, 10]),
  ]);
  assert.deepEqual(flow.inflow, ["a"]);
  assert.deepEqual(flow.content, [5, 3, 27, 28]);
  assert.deepEqual(flow.main, { a: 0 });
});

test("flowOf: siblings stored in paint order flow in the order their boxes sit; another world takes snap's order", () => {
  // A relative child paints after the static one beside it, so the tree stores it second.
  const parent = frame("p", [0, 0, 200, 40], { L: { d: "flex", gap: [8, 8] } });
  const snap = [frame("content", [48, 0, 100, 40]), frame("media", [0, 0, 40, 40], { S: { z: 0 } })];
  const flow = flowOf(parent, snap);
  assert.deepEqual(flow.inflow, ["media", "content"]);
  assert.deepEqual(flow.main, { media: 0, content: 8 });
  // In Figma the two were swapped: in snap's order, both are off.
  const figma = [frame("content", [0, 0, 100, 40]), frame("media", [108, 0, 40, 40])];
  const scored = flowOf(parent, figma, flow);
  assert.deepEqual(scored.inflow, ["media", "content"]);
  assert.notEqual(scored.main.media, flow.main.media);
  assert.notEqual(scored.main.content, flow.main.content);
});

// --- rootWithStyles -----------------------------------------------------------------

test("rootWithStyles: the root with its paint from its styles, in the tree's encoding", () => {
  const fixture = loadTreeFixture("switch");
  const component = fixture.components[0];
  const root = rootWithStyles(component.tree.base[0], component.base!.styles);
  assert.deepEqual(root.bd, { w: 1, s: "solid", c: null });
  assert.equal(root.bg, "#e5e5e5");
  assert.equal(root.r, 9.2);
  assert.deepEqual(root.sh, [[0, 1, 2, 0, "#0000000d"]]);
  assert.equal("op" in root, false);
  assert.equal("bd" in component.tree.base[0], false, "the tree's own root is left as it is");
  // With its border, the thumb sits at the content start and centered across.
  const [, thumb] = fixtureVariants(fixture)[0].nodes;
  const flow = flowOf(root, [thumb]);
  assert.deepEqual(flow.content, [1, 1, 30, 16.39]);
  assert.deepEqual(flow.main, { "switch-thumb": 0 });
  assert.deepEqual(flow.cross, { "switch-thumb": 0 });
  // A border on some sides only keeps the drawn side's style and color on the others.
  const styles = structuredClone(component.base!.styles);
  const side = { width: 1, style: "solid", color: "#e5e5e5" };
  styles.border = { top: side, right: side, bottom: side, left: null };
  styles.borderRadius = { topLeft: 0, topRight: 8, bottomRight: 8, bottomLeft: 0 };
  styles.boxShadow = [{ offsetX: 0, offsetY: 0, blur: 0, spread: 1, color: "#000000", inset: true }];
  styles.opacity = 0.5;
  const partial = rootWithStyles(component.tree.base[0], styles);
  assert.deepEqual(partial.bd, { w: [1, 1, 1, 0], s: "solid", c: "#e5e5e5" });
  assert.deepEqual(partial.r, [0, 8, 8, 0]);
  assert.deepEqual(partial.sh, [[0, 0, 0, 1, "#000000", 1]]);
  assert.equal(partial.op, 0.5);
});

// --- The fixtures ---------------------------------------------------------------------

const FIXTURES = treeFixtureNames();

test("fixtures: the components the design lists are all here", () => {
  assert.deepEqual(FIXTURES, ["attachment", "avatar", "button-icon", "card", "example-button", "inputotp", "sidebar", "switch", "toggle"]);
});

function eachFixture(fn: (name: string, fixture: TreeFixture) => void) {
  for (const name of FIXTURES) fn(name, loadTreeFixture(name));
}

test("fixtures: expandTree(diffTree(a, b)) deep-equals b for every pair of variants, in both directions", () => {
  eachFixture((name, fixture) => {
    const variants = fixtureVariants(fixture);
    for (const a of variants) {
      for (const b of variants) {
        const tree = { ...fixture.components[0].tree, base: a.nodes };
        assert.deepEqual(expandTree(tree, diffTree(a.nodes, b.nodes)), b.nodes, `${name}: ${a.slug} to ${b.slug}`);
      }
    }
  });
});

test("fixtures: each is a styles.json of one tree-captured component, its variants as a tree snap writes them", () => {
  eachFixture((name, fixture) => {
    assert.equal(fixture.version, 1, name);
    assert.equal(fixture.treeVersion, TREE_VERSION, name);
    assert.deepEqual(fixture.treeLimits, TREE_LIMITS, name);
    assert.equal(fixture.components.length, 1, name);
    const component = fixture.components[0];
    assert.equal(component.capture, "tree", name);
    assert.equal(component.tree.version, 1, name);
    assert.ok(fixture.fixture.sources.length && fixture.fixture.notes.length, `${name}: says where it came from`);
    const ok = component.variants.filter((v) => v.status === "ok");
    for (const v of component.variants) {
      const delta = (v as { treeDelta?: unknown }).treeDelta;
      if (v.status !== "ok") assert.equal(delta, undefined, `${name} ${v.slug}: a variant not measured has no tree`);
      else if (v.slug === component.base!.slug) assert.equal(delta, undefined, `${name}: the base is the tree's own`);
      else assert.ok(delta, `${name} ${v.slug}: every other measured variant has a delta`);
    }
    for (const { slug, nodes } of fixtureVariants(fixture)) {
      const styles = { ...component.base!.styles, ...ok.find((v) => v.slug === slug)!.delta };
      assert.deepEqual(nodes[0].box, [0, 0, styles.width, styles.height], `${name} ${slug}: the root's box is its measured size`);
    }
    assert.equal(fixture.summary.variants, component.variants.length, name);
  });
});

test("fixtures: keys are unique, parents come before children, and each kind carries its facts", () => {
  eachFixture((name, fixture) => {
    for (const { slug, nodes } of fixtureVariants(fixture)) {
      const at = `${name} ${slug}`;
      const seen = new Set<string>();
      assert.equal(nodes[0].k, "", `${at}: the root comes first`);
      for (const node of nodes) {
        assert.ok(!seen.has(node.k), `${at}: "${node.k}" twice`);
        const parent = parentKey(node.k);
        assert.ok(parent === null || seen.has(parent), `${at}: "${node.k}" before its parent`);
        seen.add(node.k);
        for (const segment of node.k ? node.k.split("/") : []) assert.match(segment, /^(?:[\w∕-]+|#text|#value|::before|::after)(?::\d+)?$/, `${at}: segment ${segment}`);
        for (const [field, value] of Object.entries(node)) assert.notEqual(value, null, `${at} ${node.k}: ${field} is null`);
        if (node.t === "T") assert.ok(node.tx && node.tx.n >= 1 && node.tx.ink.length === 4, `${at} ${node.k}: text facts`);
        if (node.t === "V") assert.ok(node.svg && node.shapes?.length && /^svg(?:\.lucide-[a-z0-9-]+)?$/.test(node.el), `${at} ${node.k}: vector facts`);
        if (node.t === "I") assert.ok(node.img, `${at} ${node.k}: image facts`);
        if (node.t !== "T") assert.equal(node.tx, undefined, `${at} ${node.k}`);
      }
      const extra = Object.keys(nodes[0]).filter((f) => !(ROOT_FIELDS as readonly string[]).includes(f));
      assert.deepEqual(extra, [], `${at}: the root carries only what its styles lack`);
      assert.ok(nodes.length <= TREE_LIMITS.maxNodes, at);
    }
  });
});

test("fixtures: boxes are relative to their parent: every in-flow node lies inside it", () => {
  eachFixture((name, fixture) => {
    for (const { slug, nodes } of fixtureVariants(fixture)) {
      const byKey = new Map(nodes.map((n) => [n.k, n]));
      for (const node of nodes.slice(1)) {
        if (node.abs) continue;
        const parent = byKey.get(parentKey(node.k)!)!;
        const [x, y, w, h] = node.box;
        assert.ok(x >= -1 && y >= -1 && x + w <= parent.box[2] + 1 && y + h <= parent.box[3] + 1,
          `${name} ${slug} ${node.k} ${JSON.stringify(node.box)} outside ${JSON.stringify(parent.box)}`);
      }
      assert.doesNotThrow(() => absoluteBoxes(nodes));
    }
  });
});

test("fixtures: every svg and img id is in the assets, and every asset is used", () => {
  eachFixture((name, fixture) => {
    const { assets } = fixture.components[0].tree;
    const used = { svg: new Set<string>(), img: new Set<string>() };
    for (const { nodes } of fixtureVariants(fixture)) {
      for (const node of nodes) {
        if (node.svg) used.svg.add(node.svg);
        if (node.img) used.img.add(node.img);
      }
    }
    assert.deepEqual([...used.svg].sort(), Object.keys(assets.svg).sort(), `${name}: svg`);
    assert.deepEqual([...used.img].sort(), Object.keys(assets.img).sort(), `${name}: img`);
    for (const [id, markup] of Object.entries(assets.svg)) {
      assert.equal(id, `svg:${fnv1a32(markup)}`, `${name}: an svg's id is its markup's FNV`);
      assert.ok(markup.length <= TREE_LIMITS.maxSvgChars, `${name} ${id}`);
      assert.doesNotMatch(markup, /oklch|oklab|rgb|currentcolor|class=|style=|aria-|data-/i, `${name} ${id}: hex paint only, no classes`);
    }
    for (const [id, asset] of Object.entries(assets.img)) {
      const bytes = treeFixtureAsset(asset.file);
      assert.equal(fnv1a32Bytes(bytes), asset.fnv, `${name} ${id}: fnv of the thumbnail's bytes`);
      assert.deepEqual(imageSize(bytes), { width: asset.size[0], height: asset.size[1] }, `${name} ${id}: size`);
      assert.match(id, /^img:[0-9a-f]{12}-[0-9a-f]{4}$/, `${name} ${id}`);
      assert.ok(asset.mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8, `${name} ${id}: a JPEG`);
    }
  });
});

/** A fixture's node by key in one of its variants. */
function nodeIn(name: string, slug: string | null, key: string): TreeNode {
  const variants = fixtureVariants(loadTreeFixture(name));
  const variant = slug === null ? variants[0] : variants.find((v) => v.slug === slug)!;
  const node = variant.nodes.find((n) => n.k === key);
  assert.ok(node, `${name} ${variant.slug} has no "${key}"`);
  return node!;
}

test("fixtures: hold the facts the design's acceptance names for each component", () => {
  const count = (name: string) => fixtureVariants(loadTreeFixture(name))[0].nodes.length;
  // Switch: the thumb, 16px at default and 12px at sm, a white pill.
  assert.equal(count("switch"), 2);
  assert.deepEqual(nodeIn("switch", "size-default", "switch-thumb"), { k: "switch-thumb", t: "F", el: "span[data-slot=switch-thumb]", box: [1, 1.19, 16, 16], bg: "#ffffff", r: 8 });
  assert.deepEqual(nodeIn("switch", "size-sm", "switch-thumb").box, [1, 1, 12, 12]);
  assert.equal(nodeIn("switch", "size-sm", "switch-thumb").r, 6);
  // Avatar: the photo and the ring, a darkened 1px border over it.
  assert.equal(count("avatar"), 3);
  const ring = nodeIn("avatar", "size-default", "::after");
  assert.deepEqual([ring.box, ring.bd?.w, ring.bm, ring.abs], [[0, 0, 32, 32], 1, "darken", 1]);
  assert.equal(nodeIn("avatar", "size-default", "avatar-image").t, "I");
  // InputOTP: the container div, six slots sharing borders, no input.
  assert.equal(count("inputotp"), 8);
  const slots = fixtureVariants(loadTreeFixture("inputotp"))[0].nodes.filter((n) => n.el === "div[data-slot=input-otp-slot]");
  assert.equal(slots.length, 6);
  assert.deepEqual(slots.map((s) => s.bd?.w), [1, [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0]]);
  assert.deepEqual([slots[0].r, slots[5].r], [[8, 0, 0, 8], [0, 8, 8, 0]]);
  assert.ok(fixtureVariants(loadTreeFixture("inputotp"))[0].nodes.every((n) => !n.el.startsWith("input")));
  // Card: the title 24px in, as the browser drew it.
  assert.equal(count("card"), 23);
  assert.equal(nodeIn("card", "size-default", "card-header/card-title").box[0], 24);
  // Attachment vertical: the title cut off with an ellipsis, narrower than its text.
  const title = nodeIn("attachment", "size-default--orientation-vertical--state-done", "attachment-content/attachment-title");
  assert.equal(title.tx?.el, 1);
  assert.ok(title.box[2] < title.tx!.ink[2]);
  // Toggle: the icon as a vector of hex paint, under 1k.
  assert.equal(count("toggle"), 2);
  const toggle = loadTreeFixture("toggle").components[0].tree.assets.svg;
  assert.ok(Object.values(toggle).every((m) => m.length <= 1000 && !/oklch/.test(m)));
  // Button with an icon: the button, its icon and its label.
  assert.equal(count("button-icon"), 3);
  // Icons are named by their lucide class where a capture recorded it, for B to name the vector layer.
  assert.equal(nodeIn("button-icon", null, "svg").el, "svg.lucide-mail");
  assert.equal(nodeIn("card", null, "card-content/div:2/svg").el, "svg.lucide-bell-ring");
  assert.deepEqual(["attachment-media/svg", "attachment-action/svg"].map((k) => nodeIn("attachment", "size-default--orientation-horizontal--state-error", k).el),
    ["svg.lucide-file-text", "svg.lucide-x"]);
  assert.equal(nodeIn("toggle", null, "svg").el, "svg", "no capture named Toggle's icon");
  // The example Button has no data-slot: tags and #text key it.
  assert.deepEqual(fixtureVariants(loadTreeFixture("example-button"))[0].nodes.map((n) => n.k), ["", "#text"]);
});

test("fixtures: a variant Storybook hid an arg of is kept unmeasured, with what hid it", () => {
  const component = loadTreeFixture("button-icon").components[0];
  const hidden = component.variants.filter((v) => (v.status as string) === "args_hidden");
  assert.deepEqual(hidden.map((v) => v.slug), ["variant-link--size-xs", "variant-link--size-sm"]);
  // Every combination of the properties it lists is there, measured or not, as snap writes them.
  const [variant, size] = component.variantProperties;
  assert.equal(component.variants.length, variant.values.length * size.values.length);
  for (const v of hidden) {
    assert.equal(v.combination.variant, "link");
    assert.equal((v as { delta?: unknown }).delta, undefined);
    assert.deepEqual((v as unknown as { args: unknown }).args, { hidden: [{ arg: "size", value: v.combination.size, if: { arg: "variant", neq: "link" } }] });
  }
});

test("fixtures: the flow of every parent in every variant is defined, and anchored offsets are finite", () => {
  eachFixture((name, fixture) => {
    const styles = fixture.components[0].base!.styles;
    for (const { slug, nodes } of fixtureVariants(fixture)) {
      const kids = new Map<string, TreeNode[]>();
      for (const node of nodes.slice(1)) {
        const p = parentKey(node.k)!;
        kids.set(p, [...(kids.get(p) ?? []), node]);
      }
      for (const [key, children] of kids) {
        const parent = key === "" ? rootWithStyles(nodes[0], styles) : nodes.find((n) => n.k === key)!;
        const flow = flowOf(parent, children);
        assert.equal(flow.inflow.length, children.filter((c) => !c.abs).length, `${name} ${slug} ${key}`);
        for (const value of [...Object.values(flow.main), ...Object.values(flow.cross)]) assert.ok(Number.isFinite(value), `${name} ${slug} ${key}`);
        // The same world in its own order scores itself identically.
        assert.deepEqual(flowOf(parent, children, flow), flow, `${name} ${slug} ${key}`);
      }
    }
  });
});
