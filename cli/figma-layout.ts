// Auto layout from measured boxes, checked offline (section 8.4).
//
// A frame built with absolute children looks right and edits wrong: change a
// label in Figma and nothing after it moves. So each frame with children in
// its flow becomes an auto layout frame, but only when Figma's model,
// direction, padding, one item spacing, one alignment along and one across,
// puts every child where the browser drew it. The spacing is the measured gap
// between neighbors rather than the CSS gap, so a margin such as an icon's
// `mr-2` is absorbed. When no direction fits, the frame is built without auto
// layout, every child at its measured offset, and the reason is named: it is
// never laid out by a guess.
//
// Boxes here are Figma frame boxes: each relative to its parent frame's
// corner, less any stroke built OUTSIDE (figma-map.ts). The template checks
// the result again inside Figma after the build (section 8.5).

import { SPIKE } from "./figma-spike.js";
import type { Spike } from "./figma-spike.js";
import type { Box, Kind, TreeLayout } from "./tree-types.js";

/**
 * Whether to put siblings in flow order when paint order differs and the
 * reordered ones don't overlap; see planLayout. False sends every such frame
 * to NONE (section 8.4.6 as written): Attachment's root, for one. verify's
 * `order` check must use visibleReorder while this is true.
 */
export const REORDER_NON_OVERLAPPING = true;

/**
 * The first pair of siblings that Figma's layer order paints the other way
 * round from the browser's paint order, and that overlap, so the difference
 * shows: [the one painted first, the one painted after it]. Null when every
 * pair whose order changed keeps apart, so both orders draw the same.
 *
 * `painted` is the siblings in paint order (as a tree stores them), each with
 * its border box in their parent's frame; `layers` is their keys in Figma's
 * layer order, bottom to top. A key in only one of them is skipped. The
 * build orders layers by this, and verify scores `order` by it, so the two
 * agree on what counts as the same order.
 */
export function visibleReorder(painted: readonly { k: string; box: Box }[], layers: readonly string[]): [string, string] | null {
  const at = new Map(layers.map((k, i) => [k, i]));
  const present = painted.filter((c) => at.has(c.k));
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const [a, b] = [present[i], present[j]];
      if (at.get(a.k)! > at.get(b.k)! && overlaps(a.box, b.box)) return [a.k, b.k];
    }
  }
  return null;
}

/** A child as planLayout sees it. */
export interface LayoutChild {
  k: string;
  kind: Kind;
  /** Its frame box, relative to the parent frame's corner. */
  box: Box;
  /** Its border box in the same frame, where it differs, for what it paints over (visibleReorder). */
  paint?: Box;
  /** Out of flow: absolute or fixed. */
  abs?: boolean;
  /** visibility: hidden, which Figma's auto layout skips but CSS gives room. */
  hidden?: boolean;
  /** flex-grow, align-self. */
  grow?: number;
  alignSelf?: string;
  /** A text node: "hug" sizes itself (WIDTH_AND_HEIGHT), "fixed" is laid out at its box's width (HEIGHT). */
  text?: "hug" | "fixed";
}

/** The frame being planned. */
export interface LayoutParent {
  k: string;
  /** Its frame size. */
  size: [number, number];
  L?: TreeLayout;
  /** Its stroke, where built INSIDE, which insets its content once included in layout: top, right, bottom, left. */
  inset: [number, number, number, number];
}

export type Sizing = "FIXED" | "HUG" | "FILL";

export interface LayoutPlan {
  mode: "HORIZONTAL" | "VERTICAL" | "NONE";
  /** Why a frame with children in its flow is built without auto layout. */
  why?: string;
  padding: [number, number, number, number];
  spacing: number;
  primary: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counter: "MIN" | "CENTER" | "MAX";
  /** Whether the frame hugs its children, horizontally and vertically. */
  hug: [boolean, boolean];
  /** The children's keys in Figma's layer order, which is also their flow order in auto layout. */
  order: string[];
  /** Children that fill the frame: along it (they grow) or across it (they stretch), by key. */
  fill: Record<string, [boolean, boolean]>;
}

/** Tolerance for where a child lands: 0.5px, or 1px for text, whose half-leading Chrome rounds. */
const tolerance = (child: LayoutChild) => (child.kind === "T" ? 1 : 0.5);

const BLOCK_FLOW = new Set(["block", "flow-root", "list-item", "inline-block"]);

const round2 = (n: number): number => Math.round(Math.round(n * 1e8) / 1e6) / 100 || 0;

const overlaps = (a: Box, b: Box) =>
  Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]) > 0.5 && Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > 0.5;

/** The alignment along the flow CSS asks for, as Figma names it. */
function declaredPrimary(L: TreeLayout | undefined, reverse: boolean): LayoutPlan["primary"] {
  const jc = (L?.jc ?? "normal").replace(/^(?:safe|unsafe)\s+/, "");
  if (jc === "center") return "CENTER";
  if (jc === "space-between") return "SPACE_BETWEEN";
  const end = jc === "flex-end" || jc === "end" || jc === "right";
  return end !== reverse ? "MAX" : "MIN";
}

function declaredCounter(L: TreeLayout | undefined, flex: boolean): LayoutPlan["counter"] {
  if (!flex) return "MIN";
  const ai = L?.ai ?? "normal";
  if (ai === "center") return "CENTER";
  if (ai === "flex-end" || ai === "end" || ai === "self-end") return "MAX";
  return "MIN";
}

/**
 * The auto layout for `parent`, from its children's boxes: a direction,
 * spacing and alignments that put every child in its flow within tolerance
 * of where the browser drew it, or NONE with the reason none does.
 *
 * - Directions: the flex direction first, then the other; anything else, a
 *   block or a grid, vertical first.
 * - The children's order along the flow is where their boxes sit. Figma's
 *   layer order is both its flow order and its paint order, while a tree
 *   stores siblings in paint order, where a `relative` child paints after the
 *   static siblings beside it. When the two differ, the flow order is taken
 *   if no reordered sibling overlaps another (REORDER_NON_OVERLAPPING), since
 *   paint order then shows nowhere; otherwise NONE.
 * - A wrapping flex whose children sit on one line is laid out as one line.
 * - Sizing: the frame hugs an axis where its padding, stroke and children
 *   (with their spacing, along the flow; the largest, across it) make its
 *   measured size, and no child fills that axis (SPIKE.fillAcrossHug).
 *   A child fills along the flow when it grows and filling gives its
 *   measured size, and across when CSS stretches it (flex's default
 *   alignment, or any block or grid child) to the frame's content size. Text
 *   fills only its width, and only when laid out at a fixed width.
 */
export function planLayout(parent: LayoutParent, children: LayoutChild[], spike: Pick<Spike, "fillAcrossHug"> = SPIKE): LayoutPlan {
  const L = parent.L;
  const pad = L?.pad ?? [0, 0, 0, 0];
  const none = (why?: string): LayoutPlan => ({
    mode: "NONE", ...(why ? { why } : {}), padding: [pad[0], pad[1], pad[2], pad[3]], spacing: 0, primary: "MIN", counter: "MIN",
    hug: [false, false], order: children.map((c) => c.k), fill: {},
  });
  const inflow = children.filter((c) => !c.abs);
  if (!inflow.length) return none();
  const display = L?.d ?? "block";
  const flex = display.includes("flex");
  const grid = display.includes("grid");
  if (inflow.some((c) => c.hidden)) return none("a child in its flow is hidden (visibility: hidden), which takes room in CSS and none in Figma's auto layout");
  if (grid && (L?.tracks?.[0] ?? 1) > 1 && (L?.tracks?.[1] ?? 1) > 1) {
    return none(`a grid of ${L!.tracks![0]} columns and ${L!.tracks![1]} rows`);
  }
  if (!flex && !grid && !BLOCK_FLOW.has(display)) return none(`display ${display}, whose content auto layout doesn't model`);
  const dir = L?.dir ?? "row";
  const first: "HORIZONTAL" | "VERTICAL" = flex && dir.startsWith("row") ? "HORIZONTAL" : "VERTICAL";
  const tries = [first, first === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL"] as const;
  const reasons: string[] = [];
  for (const mode of tries) {
    const result = fit(parent, children, inflow, mode, flex, dir.endsWith("-reverse"), spike.fillAcrossHug);
    if (typeof result !== "string") return result;
    reasons.push(result);
  }
  return none(L?.wrap && reasons[0].startsWith("children overlap") ? "a wrapping flex whose children wrap onto several lines" : reasons[0]);
}

function fit(
  parent: LayoutParent,
  children: LayoutChild[],
  inflow: LayoutChild[],
  mode: "HORIZONTAL" | "VERTICAL",
  flex: boolean,
  reverse: boolean,
  fillAcrossHug: boolean,
): LayoutPlan | string {
  const L = parent.L;
  const pad = L?.pad ?? [0, 0, 0, 0];
  const H = mode === "HORIZONTAL";
  const [m, ms, c, cs] = H ? [0, 2, 1, 3] : [1, 3, 0, 2];
  // Content box along and across the flow, in the frame's own coordinates.
  const [startSide, endSide, crossStartSide, crossEndSide] = H ? [3, 1, 0, 2] : [0, 2, 3, 1];
  const start = pad[startSide] + parent.inset[startSide];
  const end = parent.size[H ? 0 : 1] - pad[endSide] - parent.inset[endSide];
  const room = end - start;
  const crossStart = pad[crossStartSide] + parent.inset[crossStartSide];
  const crossEnd = parent.size[H ? 1 : 0] - pad[crossEndSide] - parent.inset[crossEndSide];
  const crossRoom = crossEnd - crossStart;

  // Flow order: by position along the axis; ties keep paint order. Figma's
  // layer order is that flow, each absolute child kept in its paint place.
  const flow = [...inflow].sort((a, b) => a.box[m] - b.box[m]);
  const order = layerOrder(children, flow.map((k) => k.k));
  if (order.some((k, i) => k !== children[i].k)) {
    // Where the reordered siblings keep apart, paint order shows nowhere.
    const shown = REORDER_NON_OVERLAPPING ? visibleReorder(children.map((k) => ({ k: k.k, box: k.paint ?? k.box })), order) : true;
    if (shown) return REORDER_NON_OVERLAPPING ? "its children paint in another order than they flow, and some of them overlap" : "its children paint in another order than they flow";
  }
  const size = (k: LayoutChild) => k.box[ms];
  const gaps = flow.slice(1).map((k, i) => k.box[m] - (flow[i].box[m] + size(flow[i])));
  if (gaps.some((g) => g < -0.5)) return `children overlap along the ${H ? "row" : "column"}`;
  const spacing = gaps.length ? round2(gaps.reduce((a, b) => a + b, 0) / gaps.length) : flex ? (L?.gap?.[H ? 1 : 0] ?? 0) : 0;
  if (gaps.some((g) => Math.abs(g - spacing) > 0.5)) return `uneven spacing (${gaps.map(round2).join(", ")})`;
  const sum = flow.reduce((t, k) => t + size(k), 0);
  const total = sum + spacing * (flow.length - 1);

  // Along the flow: the alignment CSS declares when it fits, else the first that does.
  const lands = (k: LayoutChild, at: number, axis: number) => Math.abs(k.box[axis] - at) <= tolerance(k);
  const along = (primary: LayoutPlan["primary"]): boolean => {
    if (primary === "SPACE_BETWEEN" && flow.length < 2) return false;
    const gap = primary === "SPACE_BETWEEN" ? (room - sum) / (flow.length - 1) : spacing;
    let at = primary === "CENTER" ? start + (room - total) / 2 : primary === "MAX" ? end - total : start;
    return flow.every((k) => {
      const ok = lands(k, at, m);
      at += size(k) + gap;
      return ok;
    });
  };
  const declared = flex ? declaredPrimary(L, reverse) : "MIN";
  const primary = [declared, "MIN", "CENTER", "MAX", "SPACE_BETWEEN"].find((p) => along(p as LayoutPlan["primary"])) as LayoutPlan["primary"] | undefined;
  if (!primary) return `no alignment along the ${H ? "row" : "column"} places every child`;

  // Across: children CSS stretches fill; the rest share one alignment.
  const fill: Record<string, [boolean, boolean]> = {};
  const stretches = (k: LayoutChild): boolean => {
    // An icon or an image keeps its own size. A text fills only its width,
    // across a column, and only when it is laid out at a fixed width.
    if (k.kind === "V" || k.kind === "I") return false;
    if (k.kind === "T" && (H || k.text !== "fixed")) return false;
    const align = flex ? (k.alignSelf && k.alignSelf !== "auto" ? k.alignSelf : (L?.ai ?? "normal")) : "stretch";
    return (align === "normal" || align === "stretch") && Math.abs(k.box[cs] - crossRoom) <= 0.5 && Math.abs(k.box[c] - crossStart) <= 0.5;
  };
  const rest = flow.filter((k) => !stretches(k));
  const acrossFits = (counter: LayoutPlan["counter"]) =>
    rest.every((k) => lands(k, counter === "CENTER" ? crossStart + (crossRoom - k.box[cs]) / 2 : counter === "MAX" ? crossEnd - k.box[cs] : crossStart, c));
  const counter = [declaredCounter(L, flex), "MIN", "CENTER", "MAX"].find((a) => acrossFits(a as LayoutPlan["counter"])) as LayoutPlan["counter"] | undefined;
  if (!counter) return "its children are aligned differently across the flow";

  // Along: a growing child fills when filling gives it its measured size.
  const growers = flow.filter((k) => (k.grow ?? 0) > 0 && !(k.kind === "T" && k.text === "hug"));
  if (growers.length) {
    const fixed = flow.filter((k) => !growers.includes(k)).reduce((t, k) => t + size(k), 0) + spacing * (flow.length - 1);
    const share = (room - fixed) / growers.length;
    for (const k of growers) if (Math.abs(share - size(k)) <= tolerance(k)) fill[k.k] = H ? [true, false] : [false, true];
  }
  for (const k of flow) {
    if (!stretches(k)) continue;
    const both = fill[k.k] ?? [false, false];
    fill[k.k] = H ? [both[0], true] : [true, both[1]];
  }
  const fillsAlong = flow.some((k) => fill[k.k]?.[H ? 0 : 1]);
  const fillers = flow.filter((k) => fill[k.k]?.[H ? 1 : 0]);
  const across = rest.length ? Math.max(...rest.map((k) => k.box[cs])) : 0;
  const hugAlong = !fillsAlong && primary !== "SPACE_BETWEEN" && Math.abs(room - total) <= 0.5;
  const hugAcross = (fillers.length === 0 || (fillAcrossHug && rest.length > 0)) && Math.abs(crossRoom - across) <= 0.5;
  return {
    mode, padding: [pad[0], pad[1], pad[2], pad[3]], spacing, primary, counter,
    hug: H ? [hugAlong, hugAcross] : [hugAcross, hugAlong], order, fill,
  };
}

/**
 * The layer order: the in-flow children in flow order, each absolute child
 * where it paints among them, so an overlay painted last stays on top.
 */
function layerOrder(children: LayoutChild[], flow: string[]): string[] {
  const inflow = [...flow];
  return children.map((child) => (child.abs ? child.k : inflow.shift()!));
}
