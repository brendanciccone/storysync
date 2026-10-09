import assert from "node:assert/strict";
import { test } from "node:test";
import { planLayout } from "../figma-layout.js";
import type { LayoutChild, LayoutParent } from "../figma-layout.js";

const parent = (fields: Partial<LayoutParent> = {}): LayoutParent => ({ k: "", size: [100, 40], inset: [0, 0, 0, 0], ...fields });
const kid = (k: string, box: LayoutChild["box"], fields: Partial<LayoutChild> = {}): LayoutChild => ({ k, kind: "F", box, ...fields });

test("planLayout: a frame with nothing in its flow has no auto layout, and no reason to give", () => {
  const plan = planLayout(parent(), [kid("a", [0, 0, 10, 10], { abs: true })]);
  assert.deepEqual([plan.mode, plan.why], ["NONE", undefined]);
});

test("planLayout: children that overlap are built absolute, and say why", () => {
  const plan = planLayout(parent({ L: { d: "flex" } }), [kid("a", [0, 0, 60, 40]), kid("b", [30, 0, 60, 40])]);
  assert.equal(plan.mode, "NONE");
  assert.match(plan.why!, /overlap|no alignment/);
});

test("planLayout: uneven spacing, a wrap over several lines, a grid of rows and columns: absolute, named", () => {
  const uneven = planLayout(parent({ size: [200, 20], L: { d: "flex" } }), [kid("a", [0, 0, 20, 20]), kid("b", [30, 0, 20, 20]), kid("c", [70, 0, 20, 20])]);
  assert.deepEqual([uneven.mode, uneven.why], ["NONE", "uneven spacing (10, 20)"]);
  const wrapped = planLayout(parent({ size: [50, 50], L: { d: "flex", wrap: 1 } }), [kid("a", [0, 0, 30, 20]), kid("b", [30, 0, 20, 20]), kid("c", [0, 20, 30, 20])]);
  assert.deepEqual([wrapped.mode, wrapped.why], ["NONE", "a wrapping flex whose children wrap onto several lines"]);
  const grid = planLayout(parent({ L: { d: "grid", tracks: [2, 2] } }), [kid("a", [0, 0, 50, 20]), kid("b", [50, 0, 50, 20])]);
  assert.deepEqual([grid.mode, grid.why], ["NONE", "a grid of 2 columns and 2 rows"]);
});

test("planLayout: a hidden child in the flow, or inline content, is built absolute", () => {
  const hidden = planLayout(parent({ L: { d: "flex" } }), [kid("a", [0, 0, 20, 40], { hidden: true })]);
  assert.match(hidden.why!, /hidden/);
  const inline = planLayout(parent({ L: { d: "inline" } }), [kid("a", [0, 0, 20, 40])]);
  assert.equal(inline.why, "display inline, whose content auto layout doesn't model");
});

test("planLayout: children aligned differently across the flow have no one alignment", () => {
  const plan = planLayout(parent({ L: { d: "flex", ai: "center" } }), [kid("a", [0, 0, 20, 20]), kid("b", [20, 10, 20, 20])]);
  assert.deepEqual([plan.mode, plan.why], ["NONE", "its children are aligned differently across the flow"]);
});

test("planLayout: a reordered child that overlaps another is built absolute, rather than painted in another order", () => {
  // b paints last but flows first, so in Figma it would go under the badge it overlaps.
  const plan = planLayout(parent({ size: [100, 20], L: { d: "flex" } }), [
    kid("a", [50, 0, 50, 20]), kid("badge", [40, 0, 20, 20], { abs: true }), kid("b", [0, 0, 50, 20]),
  ]);
  assert.deepEqual([plan.mode, plan.why], ["NONE", "its children paint in another order than they flow, and some of them overlap"]);
  // Where nothing it passes overlaps it, the flow order is taken: paint order shows nowhere.
  const apart = planLayout(parent({ size: [100, 20], L: { d: "flex" } }), [
    kid("a", [50, 0, 50, 20]), kid("badge", [0, 25, 10, 10], { abs: true }), kid("b", [0, 0, 50, 20]),
  ]);
  assert.deepEqual([apart.mode, apart.order], ["HORIZONTAL", ["b", "badge", "a"]]);
});

test("planLayout: the alignment CSS declares wins where several fit, and space-between spreads", () => {
  // A hugging row: MIN, CENTER and MAX all place it; justify-center is kept, so an edit centers.
  const centered = planLayout(parent({ size: [40, 20], L: { d: "flex", jc: "center", ai: "center" } }), [kid("a", [0, 0, 40, 20])]);
  assert.deepEqual([centered.primary, centered.hug], ["CENTER", [true, true]]);
  const end = planLayout(parent({ size: [100, 20], L: { d: "flex", jc: "flex-end", ai: "center" } }), [kid("a", [60, 0, 40, 20])]);
  assert.deepEqual([end.primary, end.hug], ["MAX", [false, true]]);
  const between = planLayout(parent({ size: [100, 20], L: { d: "flex", jc: "space-between", ai: "center" } }), [kid("a", [0, 0, 20, 20]), kid("b", [80, 0, 20, 20])]);
  assert.deepEqual([between.primary, between.spacing, between.hug], ["SPACE_BETWEEN", 60, [false, true]]);
});

test("planLayout: padding and an included stroke make the content box; text lands within 1px", () => {
  const plan = planLayout(
    parent({ size: [59.2, 36], inset: [1, 1, 1, 1], L: { d: "flex", ai: "center", jc: "center", pad: [0, 10, 0, 10] } }),
    [kid("#text", [11, 7.5, 37.2, 20], { kind: "T", text: "hug" })],
  );
  assert.deepEqual([plan.mode, plan.primary, plan.counter, plan.hug], ["HORIZONTAL", "CENTER", "CENTER", [true, false]]);
});

test("planLayout: a stretched child fills across, and its frame is fixed on that axis", () => {
  // A block holding a label at its own width and a frame stretched to it.
  const kids = [kid("label", [0, 0, 100, 20], { kind: "T", text: "hug" }), kid("box", [0, 20, 100, 40])];
  const plan = planLayout(parent({ size: [100, 60], L: { d: "block" } }), kids);
  assert.deepEqual(plan.fill, { box: [true, false] });
  assert.deepEqual(plan.hug, [false, true], "SPIKE.fillAcrossHug: a frame doesn't hug where a child fills");
  // With the spike's other answer, the frame hugs the label, as CSS shrink-wraps the block, and the box fills it.
  assert.deepEqual(planLayout(parent({ size: [100, 60], L: { d: "block" } }), kids, { fillAcrossHug: true }).hug, [true, true]);
});

test("planLayout: text fills only its width, across a column, at a fixed width; an icon never fills", () => {
  const column = planLayout(parent({ size: [100, 60], L: { d: "block" } }), [
    kid("title", [0, 0, 100, 20], { kind: "T", text: "fixed" }),
    kid("hug", [0, 20, 100, 20], { kind: "T", text: "hug" }),
    kid("icon", [0, 40, 100, 20], { kind: "V" }),
  ]);
  assert.deepEqual(column.fill, { title: [true, false] });
  const row = planLayout(parent({ size: [100, 20], L: { d: "flex" } }), [kid("label", [0, 0, 100, 20], { kind: "T", text: "fixed" })]);
  assert.deepEqual(row.fill, {}, "a text's height is its lines, never its parent's");
});

test("planLayout: a growing child fills along the flow only when filling gives its measured size", () => {
  const grows = planLayout(parent({ size: [100, 20], L: { d: "flex" } }), [kid("a", [0, 0, 70, 20], { grow: 1 }), kid("b", [70, 0, 30, 20])]);
  assert.deepEqual(grows.fill.a, [true, true]);
  assert.deepEqual(grows.hug, [false, false]);
  // Capped by a max-width: it doesn't fill, and the frame keeps its size.
  const capped = planLayout(parent({ size: [100, 20], L: { d: "flex" } }), [kid("a", [0, 0, 50, 20], { grow: 1 }), kid("b", [50, 0, 30, 20])]);
  assert.equal(capped.fill.a?.[0] ?? false, false);
});

test("planLayout: a column is tried after a row it doesn't fit, and a block stacks", () => {
  const stacked = planLayout(parent({ size: [100, 40], L: { d: "flex", dir: "row" } }), [kid("a", [0, 0, 100, 20]), kid("b", [0, 20, 100, 20])]);
  assert.equal(stacked.mode, "VERTICAL");
  const block = planLayout(parent({ size: [100, 40], L: { d: "block" } }), [kid("a", [0, 0, 50, 20]), kid("b", [0, 22, 50, 18])]);
  assert.deepEqual([block.mode, block.spacing], ["VERTICAL", 2]);
});
