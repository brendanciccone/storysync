// The element tree under a component's root, from what the page read to the
// facts styles.json keeps (cli/tree-types.ts).
//
// snap-browser.ts walks the measured root's subtree in one page.evaluate and
// hands back raw computed values: every element's box and the CSS that
// differs from a default, each run of text with its line rects, the pseudo-
// elements that may paint, an SVG's structure, an image's source. Everything
// that decides what the tree holds happens here, in Node, so it is tested
// without a browser from captures of real pages (fixtures/raw):
//
//   - pruning: what draws nothing and takes no room, what is hidden or cut to
//     a pixel, an overlay input no one sees (section 6.2 of the design);
//   - collapse: a wrapper the size of its one child, an element that is only
//     its text;
//   - keys, from data-slot or the tag, numbered among siblings in DOM order,
//     and siblings stored in paint order (6.9, 6.11);
//   - facts, each value through the normalizers the root's styles use, and
//     boxes made relative to the parent (6.3-6.8);
//   - the limits on nodes and depth (6.2).

import {
  isFontKeyword, isFullyTransparent, normalizeBackgroundImage, normalizeColor, normalizeFontWeight,
  normalizeLetterSpacing, normalizeLineHeight, parseBoxShadow, pxToNumber, resolveFontFamily, resolveRadii, splitTopLevel,
} from "./snap-normalize.js";
import type { FontProbe } from "./snap-normalize.js";
import { isStandInFamily, stackFamilies, standInDrawn } from "./fonts.js";
import { serializeSvg, svgAssetId } from "./snap-assets.js";
import type { RawSvgNode } from "./snap-assets.js";
import { ROOT_FIELDS, TREE_LIMITS } from "./tree-types.js";
import { canonicalJson } from "./checksum.js";
import type { Box, Shadow, Sides, TextFacts, TreeLayout, TreeNode, TreeSelf } from "./tree-types.js";

// --- What the page reads ------------------------------------------------------

/**
 * The computed properties the page reads off each element, with the value
 * it leaves out when an element has it: the page sends only what differs, so
 * a 400-element sidebar crosses back as kilobytes, not megabytes. A default
 * here only saves bytes; each is the value an element most often has.
 */
export const TREE_PROPERTY_DEFAULTS: Readonly<Record<string, string>> = {
  display: "block", position: "static", "z-index": "auto", "box-sizing": "border-box",
  "padding-top": "0px", "padding-right": "0px", "padding-bottom": "0px", "padding-left": "0px",
  "flex-direction": "row", "flex-wrap": "nowrap", "justify-content": "normal", "align-items": "normal",
  "align-self": "auto", "flex-grow": "0", "flex-shrink": "1", "flex-basis": "auto", order: "0",
  "row-gap": "normal", "column-gap": "normal", "grid-template-columns": "none", "grid-template-rows": "none",
  "background-color": "rgba(0, 0, 0, 0)", "background-image": "none", "background-clip": "border-box",
  "background-size": "auto", "background-position": "0% 0%", "background-repeat": "repeat",
  "border-top-width": "0px", "border-right-width": "0px", "border-bottom-width": "0px", "border-left-width": "0px",
  // A side's style and color are read only where its width isn't 0.
  "border-top-style": "solid", "border-right-style": "solid", "border-bottom-style": "solid", "border-left-style": "solid",
  "border-top-color": "", "border-right-color": "", "border-bottom-color": "", "border-left-color": "",
  "border-top-left-radius": "0px", "border-top-right-radius": "0px", "border-bottom-right-radius": "0px", "border-bottom-left-radius": "0px",
  "box-shadow": "none", opacity: "1", "mix-blend-mode": "normal", filter: "none", "backdrop-filter": "none",
  transform: "none", "clip-path": "none", isolation: "auto", "overflow-x": "visible", "overflow-y": "visible", visibility: "visible",
  "outline-style": "none", "outline-width": "0px", "outline-color": "", "outline-offset": "0px",
  "object-fit": "fill", "object-position": "50% 50%", appearance: "none",
  // What else makes an element the containing block of fixed and absolute ones: see holdsFixed.
  translate: "none", rotate: "none", scale: "none", perspective: "none", "offset-path": "none",
  "will-change": "auto", contain: "none", "content-visibility": "visible", "transform-style": "flat",
};

/** What the page reads off an element holding a run of text, an input, or a pseudo-element with text: all of them, every time. */
export const TEXT_TREE_PROPERTIES: readonly string[] = [
  "color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "text-transform", "text-decoration-line", "text-align", "white-space", "text-overflow", "-webkit-line-clamp",
];

/**
 * Where the page stops reading: elements read, and depth below the root. Wider
 * than TREE_LIMITS, which count what is kept, since wrappers and pruned
 * elements are read and then dropped.
 */
export const RAW_TREE_LIMITS = { maxElements: 4000, maxDepth: 64, maxSvgElements: 2000 } as const;

/** A border box relative to the measured root's border box, in px, unrounded. */
export type RawBox = [x: number, y: number, w: number, h: number];

/** An element, as the page read it. */
export interface RawTreeElement {
  k: "e";
  /** Lowercase tag. */
  tag: string;
  slot?: string;
  role?: string;
  /** Class tokens that may be class evidence, as written; classEvidence picks them. */
  cls?: string[];
  /** The first `lucide-*` class of an `<svg>`. */
  lucide?: string;
  box: RawBox;
  /** offsetWidth and offsetHeight, when a transform other than a translation is set. */
  size?: [number, number];
  /** TREE_PROPERTY_DEFAULTS' properties whose computed value differs from its default. */
  cs: Record<string, string>;
  /** TEXT_TREE_PROPERTIES, on an element holding a run of text, or an input. */
  text?: Record<string, string>;
  /** Children in DOM order: elements (with `display: contents` flattened), runs of text, ::before first and ::after last. */
  kids: RawTreeItem[];
  /** Its index at each level down from the root, for a screenshot of it. */
  path: number[];
  /** An `<svg>`'s structure, and each painted shape's box relative to its own. */
  svg?: RawSvgNode;
  shapes?: RawBox[];
  /** An `<svg>` too big to read as structure: how many elements it holds. */
  svgElements?: number;
  img?: { src: string; natural: [number, number] };
  /** An input's, a textarea's or a select's: its value (a select's chosen option's label), placeholder, and how wide the one shown draws. */
  input?: { type: string; value: string; placeholder: string; placeholderColor?: string; advance: number };
}

/** A run of text: its characters as the DOM holds them, and its line rects. */
export interface RawTreeText {
  k: "t";
  text: string;
  /** Range.getClientRects() with area, relative to the root. */
  rects: RawBox[];
  /**
   * TEXT_TREE_PROPERTIES of the `display: contents` element the run is in,
   * whose style it is drawn in, when that isn't the element it is a child
   * of in the tree.
   */
  style?: Record<string, string>;
}

/** A pseudo-element that may paint, as the page measured it. */
export interface RawTreePseudo {
  k: "p";
  which: "before" | "after";
  cs: Record<string, string>;
  text?: Record<string, string>;
  /** Its `content`, unquoted, when it is a string. */
  content: string;
  box: RawBox;
  /**
   * How the box was found: from its computed insets and size within its
   * parent's padding box (`abs`), or by a stand-in span (`flow`).
   */
  how: "abs" | "flow";
  /** An absolute one whose parent isn't positioned: its containing block is somewhere up the tree. */
  unanchored?: true;
  /** The stand-in moved its parent or a sibling, so selectors matched it that the pseudo doesn't. */
  moved?: true;
}

/** Where the page stopped reading at RAW_TREE_LIMITS. */
export interface RawTreeCut { k: "cut" }

export type RawTreeItem = RawTreeElement | RawTreeText | RawTreePseudo | RawTreeCut;

/** One variant's capture, as captureTreeInPage returns it. */
export interface RawTreeCapture {
  root: RawTreeElement;
  /** Each font stack the text holders use, as probeFontStack reads it. */
  fonts: Record<string, FontProbe | null>;
}

// --- What the build hands on ---------------------------------------------------

/** An image node whose asset is still to be made from its source's bytes. */
export interface PendingImage {
  key: string;
  path: number[];
  src: string;
  natural: [number, number];
  fit: string;
  position: string;
  /** The content box the image is drawn into, in CSS px. */
  content: [number, number];
}

/** A node snap can only keep as a screenshot of itself. */
export interface PendingRaster {
  key: string;
  path: number[];
  why: string;
}

export interface BuiltTree {
  /** Preorder, siblings in paint order, the root first with only ROOT_FIELDS. */
  nodes: TreeNode[];
  /** Nodes past the limits, dropped with their subtrees. */
  truncated?: { nodes: number; at: string };
  /** Every SVG kept as a vector, by asset id. */
  svg: Record<string, string>;
  images: PendingImage[];
  rasters: PendingRaster[];
  /** Things worth a warning: a data-slot with a `/` in it, say. */
  notes: string[];
  /**
   * Keys of the elements placed against the browser window or the page
   * that drew outside the root's box, which the tree holds moved inside it
   * (anchorToRoot). Nothing to fix, so no warning: the variant records it.
   */
  movedInside: string[];
}

export interface TreeBuildOptions {
  maxNodes?: number;
  maxDepth?: number;
  maxSvgChars?: number;
}

// --- Reading values ------------------------------------------------------------

const r2 = (n: number): number => Math.round(Math.round(n * 1e8) / 1e6) / 100 || 0;
const roundBox = (b: RawBox): Box => [r2(b[0]), r2(b[1]), r2(b[2]), r2(b[3])];

type Css = (property: string) => string;
const reader = (cs: Record<string, string>): Css => (p) => cs[p] ?? TREE_PROPERTY_DEFAULTS[p] ?? "";

const px = (value: string): number => pxToNumber(value) ?? 0;
const SIDES = ["top", "right", "bottom", "left"] as const;

const outOfFlow = (css: Css) => css("position") === "absolute" || css("position") === "fixed";
const positioned = (css: Css) => css("position") !== "static";
const clips = (css: Css) => css("overflow-x") !== "visible" || css("overflow-y") !== "visible";
const sideWidth = (css: Css, side: string) => {
  const style = css(`border-${side}-style`);
  return style === "none" || style === "hidden" ? 0 : px(css(`border-${side}-width`));
};
const hasBorder = (css: Css) => SIDES.some((side) => sideWidth(css, side) > 0);
const hasPadding = (css: Css) => SIDES.some((side) => px(css(`padding-${side}`)) !== 0);
const hasOutline = (css: Css) => css("outline-style") !== "none" && px(css("outline-width")) > 0;

/**
 * Whether an element's own box draws: a background color with any alpha, a
 * background image, a border of any color (a transparent one still takes
 * room), a shadow that shows, or an outline.
 */
export function paintsOwnBox(cs: Record<string, string>): boolean {
  const css = reader(cs);
  return !isFullyTransparent(css("background-color")) ||
    normalizeBackgroundImage(css("background-image")) != null ||
    hasBorder(css) ||
    parseBoxShadow(css("box-shadow")).length > 0 ||
    hasOutline(css);
}

/** Tags that draw by what they are. */
const DRAWING_TAGS = new Set(["svg", "img", "canvas", "video"]);

/** Native controls the browser draws itself, unless `appearance: none` hands them to CSS. */
const NATIVE_INPUTS = new Set(["checkbox", "radio", "range", "color", "file"]);

/** Classes that may say which token a node's paint is: section 6.3's class evidence. */
const EVIDENCE = /^(bg|text|border|ring|fill|stroke|outline|rounded|shadow)-([a-z][\w/-]*)$/;

/** `text-*` classes that set no color, passed over when finding the one a text inherits. */
const TEXT_NOT_COLOR = /^text-(?:xs|sm|base|lg|\d?xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;

/**
 * Class tokens naming what paints a node, for binding its paint to a
 * variable: each token's variant prefixes (`hover:`, `data-[state=on]:`)
 * and any `/NN` opacity cut off, arbitrary values (`bg-[#fff]`) left out,
 * at most 8, the unprefixed first, then sorted.
 */
export function classEvidence(tokens: readonly string[]): string[] {
  const found = evidenceOf(tokens);
  const ordered = [...found.filter((f) => !f.prefixed), ...found.filter((f) => f.prefixed)].map((f) => f.name);
  return [...new Set(ordered)].slice(0, 8).sort();
}

/** Each token that is class evidence, as its utility, and whether a variant prefix applies it only sometimes. */
function evidenceOf(tokens: readonly string[]): { name: string; prefixed: boolean }[] {
  const found: { name: string; prefixed: boolean }[] = [];
  for (const token of tokens) {
    // The utility is what follows the last `:` outside brackets.
    let depth = 0;
    let cut = -1;
    for (let i = 0; i < token.length; i++) {
      const ch = token[i];
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth--;
      else if (ch === ":" && depth === 0) cut = i;
    }
    const utility = token.slice(cut + 1).replace(/^!|!$/g, "").replace(/\/[^/]*$/, "");
    if (!EVIDENCE.test(utility)) continue;
    found.push({ name: utility, prefixed: cut >= 0 });
  }
  return found;
}

// --- Items: the tree after pruning and collapse --------------------------------

interface Item {
  kind: "el" | "text" | "pseudo" | "value" | "cut";
  box: Box;
  kids: Item[];
  /** The element, for "el"; the holder, for "text" and "value". */
  el?: RawTreeElement;
  css?: Css;
  run?: RawTreeText;
  pseudo?: RawTreePseudo;
  /** An element that is only its text, made a text node (section 6.2's text leaf). */
  leaf?: RawTreeText;
  /** Wrappers collapsed into this element, innermost first. */
  wrappers: RawTreeElement[];
  /** Whether it draws: its own box, or what it is, or its text. */
  paints: boolean;
  /** The element item it sits in, for inherited class evidence. */
  parent?: Item;
  /** How far anchorToRoot moved it, an element placed against something outside the root. */
  shift?: [number, number];
  /** Of those it moved, one that drew outside the root's box, not only moved along with one that did. */
  drewOutside?: true;
}

/**
 * Whether an element draws: its own box, what it is, a native control the
 * browser draws, text that has a line on screen (an `<option>`'s has none),
 * or an input's value or placeholder.
 */
function elementPaints(el: RawTreeElement): boolean {
  if (paintsOwnBox(el.cs) || DRAWING_TAGS.has(el.tag) || isNativeControl(el)) return true;
  if (el.kids.some((kid) => kid.k === "t" && kid.rects.length > 0 && kid.text.trim() !== "")) return true;
  return showsValue(el);
}

/**
 * Whether an input, textarea or select shows its value or placeholder as
 * text: not a native control, which is a picture, nor a checkbox, radio,
 * range, color or file input restyled, whose value (a checkbox's `on`) is
 * never drawn.
 */
function showsValue(el: RawTreeElement): boolean {
  if (!el.input || isNativeControl(el) || (el.tag === "input" && NATIVE_INPUTS.has(el.input.type))) return false;
  return el.input.value !== "" || el.input.placeholder !== "";
}

/**
 * A control the browser draws itself, kept as a picture: a checkbox, radio,
 * range, color or file input, or a `<select>`, unless `appearance: none`
 * hands it to CSS, as shadcn's NativeSelect does, when its value is text.
 */
function isNativeControl(el: RawTreeElement): boolean {
  if (!el.input || reader(el.cs)("appearance") === "none") return false;
  return el.tag === "select" || (el.tag === "input" && NATIVE_INPUTS.has(el.input.type));
}

const subtreePaints = (item: Item): boolean => item.kind !== "el" || item.paints || item.kids.some(subtreePaints);
const sameBox = (a: Box, b: Box) => a.every((v, i) => Math.abs(v - b[i]) <= 0.5);

/**
 * A run's characters as drawn: every space and break as written under
 * `pre`, `pre-wrap` and `break-spaces`; under `pre-line`, its line breaks,
 * with spaces and tabs collapsed to one and dropped around a break;
 * otherwise all whitespace collapsed to one space and trimmed.
 */
function runCharacters(text: string, whiteSpace: string): string {
  if (whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces") return text;
  if (whiteSpace === "pre-line") return text.replace(/\r\n?/g, "\n").replace(/[ \t\f]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/^ +| +$/g, "");
  return text.replace(/[ \t\n\r\f]+/g, " ").trim();
}

/**
 * The items an element becomes: none when pruned, its one child when it is
 * a wrapper the child's size, or itself. The root is never pruned or
 * collapsed: its box is the component's.
 */
function buildItem(el: RawTreeElement, isRoot: boolean): Item[] {
  const css = reader(el.cs);
  const box = roundBox(el.box);
  const item: Item = { kind: "el", box, kids: [], el, css, wrappers: [], paints: elementPaints(el) };

  // 1. sr-only: out of flow, a pixel or less, clipping what it holds.
  if (!isRoot && outOfFlow(css) && el.box[2] <= 1 && el.box[3] <= 1 && (clips(css) || css("clip-path") !== "none")) return [];
  // 2. Opacity 0: nothing of it shows, and Figma would show nothing either.
  if (!isRoot && Number(css("opacity")) === 0) return [];

  if (el.tag !== "svg") {
    for (const kid of el.kids) {
      if (kid.k === "t") {
        if (!kid.text.trim() || !kid.rects.length) continue;
        item.kids.push({ kind: "text", box: [0, 0, 0, 0], kids: [], el, css, run: kid, wrappers: [], paints: true });
      } else if (kid.k === "p") {
        // 5. A pseudo-element that paints nothing: Switch's hit area, say.
        const content = kid.content.trim() !== "";
        if (!paintsOwnBox(kid.cs) && !content) continue;
        item.kids.push({ kind: "pseudo", box: roundBox(kid.box), kids: [], pseudo: kid, css: reader(kid.cs), wrappers: [], paints: true });
      } else if (kid.k === "cut") {
        item.kids.push({ kind: "cut", box: [0, 0, 0, 0], kids: [], wrappers: [], paints: false });
      } else {
        item.kids.push(...buildItem(kid, false));
      }
    }
  }
  if (showsValue(el)) {
    item.kids.push({ kind: "value", box: contentBox(el), kids: [], el, css, wrappers: [], paints: true });
  }
  for (const kid of item.kids) kid.parent = item;
  if (isRoot) return [item];

  // 3. Out of flow with nothing in it that draws: input-otp's overlay.
  if (outOfFlow(css) && !subtreePaints(item)) return [];
  // 4. An input no one sees, laid over what draws: its box paints nothing and its text is transparent.
  if ((el.tag === "input" || el.tag === "textarea") && !paintsOwnBox(el.cs) && el.text && isFullyTransparent(el.text["color"])) return [];
  // 6. Drawing nothing, holding nothing, and out of flow or of no size.
  if (!item.paints && !item.kids.length && (outOfFlow(css) || el.box[2] <= 0 || el.box[3] <= 0)) return [];

  // A wrapper the size of its one child, drawing nothing and clipping
  // nothing: the child takes its place, keeping its own flow facts if it has
  // any. What would change how the child draws keeps the wrapper.
  const only = item.kids.length === 1 ? item.kids[0] : null;
  if (
    only?.kind === "el" && !item.paints && !hasPadding(css) && !clips(css) && sameBox(only.box, box) &&
    css("opacity") === "1" && css("mix-blend-mode") === "normal" && css("filter") === "none" &&
    css("backdrop-filter") === "none" && css("transform") === "none" && css("clip-path") === "none" &&
    css("isolation") === "auto" && css("visibility") === "visible"
  ) {
    only.wrappers.push(el);
    return [only];
  }

  // An element that is only its text becomes the text node, sized as the
  // element. A clip that only cuts the text off with an ellipsis is the
  // truncation, kept as `el` on the text, so it doesn't stop this. A flex
  // or grid container that moves its text off the start, centering it as
  // a button does, places it where a text the element's size can't say:
  // it stays a frame, its layout and its text's line box kept.
  const text = el.text ?? {};
  const ellipsisOnly = text["text-overflow"] === "ellipsis" && text["white-space"] === "nowrap";
  if (
    only?.kind === "text" && !paintsOwnBox(el.cs) && !hasPadding(css) && (!clips(css) || ellipsisOnly) &&
    !DRAWING_TAGS.has(el.tag) && !movesItsContent(css)
  ) {
    item.leaf = only.run;
    item.kids = [];
  }
  return [item];
}

/**
 * Whether a flex or grid container puts its one item anywhere but its
 * start: centered, at the end, or spaced around. Stretched, at the start,
 * at its baseline, or spaced between, one item sits at the start.
 */
function movesItsContent(css: Css): boolean {
  if (!/flex|grid/.test(css("display"))) return false;
  return !["normal", "flex-start", "start", "left", "space-between", "stretch"].includes(css("justify-content")) ||
    !["normal", "stretch", "flex-start", "start", "self-start", "baseline", "first baseline"].includes(css("align-items"));
}

/** An element's content box, root-relative: its border box less border and padding. */
function contentBox(el: RawTreeElement): Box {
  const css = reader(el.cs);
  const [t, r, b, l] = SIDES.map((side) => sideWidth(css, side) + px(css(`padding-${side}`)));
  return roundBox([el.box[0] + l, el.box[1] + t, el.box[2] - l - r, el.box[3] - t - b]);
}

// --- Elements placed against the page -------------------------------------------

/** Properties whose every value but `none` makes an element the containing block of fixed and absolute elements in it. */
const CONTAINING = ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter", "offset-path"];

/**
 * Whether an element is the containing block of `fixed` elements in it, as
 * of `absolute` ones. In Chromium 154 these make one, each checked in the
 * browser (SPEC-NOTES L5): CONTAINING, `will-change` naming one of them,
 * `contain` or `transform-style`, layout or paint containment, and
 * `content-visibility` other than `visible`. Base UI's Slider thumb, at
 * `translate: -50% -50%`, holds its `fixed` input so. `container-type`
 * doesn't, nor size or style containment alone.
 */
const holdsFixed = (css: Css) =>
  CONTAINING.some((p) => css(p) !== "none") ||
  css("will-change").split(/,\s*/).some((p) => CONTAINING.includes(p) || p === "contain" || p === "transform-style") ||
  /\b(layout|paint|strict|content)\b/.test(css("contain")) ||
  css("content-visibility") !== "visible" || css("transform-style") === "preserve-3d";

/**
 * Moves the elements the root's own box doesn't place, so what they draw
 * starts inside it: each element `fixed` with nothing in the tree a
 * transform or filter makes its containing block, or `absolute` with
 * nothing positioned around it in the tree (it or a wrapper collapsed into
 * it, the outermost such). Where the browser window or the page put them
 * is no part of the component: shadcn's Sidebar container is `fixed` at
 * `right-0` for side=right, and drew 1024px to the right of its own 256px
 * root in snap's 1280px window, where a Figma component would hold it off
 * to its side. They move together, as far as it takes and no further, so
 * they keep their places relative to each other and one already inside the
 * box stays. Each is given its `shift`, and `drewOutside` where it did.
 */
function anchorToRoot(root: Item): void {
  const outside: Item[] = [];
  const walk = (item: Item, absolute: boolean, fixed: boolean) => {
    for (const kid of item.kids) {
      if (kid.kind !== "el") continue;
      let [a, f, out] = [absolute, fixed, false];
      // Its collapsed wrappers sit between it and its parent, the outermost last.
      for (const el of [...kid.wrappers].reverse().concat(kid.el!)) {
        const css = reader(el.cs);
        if ((css("position") === "fixed" && !f) || (css("position") === "absolute" && !a)) out = true;
        if (positioned(css)) a = true;
        if (holdsFixed(css)) a = f = true;
      }
      if (out) outside.push(kid);
      else walk(kid, a, f);
    }
  };
  const css = root.css!;
  walk(root, positioned(css) || holdsFixed(css), holdsFixed(css));
  if (!outside.length) return;
  const by = [0, 1].map((a) => {
    const start = Math.min(...outside.map((i) => i.box[a]));
    const size = Math.max(...outside.map((i) => i.box[a] + i.box[a + 2])) - start;
    return r2(Math.max(0, Math.min(start, root.box[a + 2] - size)) - start);
  }) as [number, number];
  if (!by[0] && !by[1]) return;
  const [, , w, h] = root.box;
  for (const item of outside) {
    item.shift = by;
    const [x, y, iw, ih] = item.box;
    if (x < -0.5 || y < -0.5 || x + iw > w + 0.5 || y + ih > h + 0.5) item.drewOutside = true;
  }
}

// --- Keys and paint order ------------------------------------------------------

function segmentOf(item: Item, notes: Set<string>): string {
  switch (item.kind) {
    case "text": return "#text";
    case "value": return "#value";
    case "pseudo": return `::${item.pseudo!.which}`;
    case "cut": return "…";
    default: {
      const slot = item.el!.slot;
      if (slot?.includes("/")) {
        notes.add(`data-slot="${slot}" holds a "/", which separates a key's parts, so its key writes it as "∕" (U+2215)`);
        return slot.replace(/\//g, "∕");
      }
      return slot ?? item.el!.tag;
    }
  }
}

/** The CSS that places an item in its parent: its own, or, when it has none, its outermost collapsed wrapper's. */
function flowCss(item: Item): Css {
  const own = item.css!;
  const outer = item.wrappers[item.wrappers.length - 1];
  if (!outer || item.kind !== "el") return own;
  return positioned(own) || own("z-index") !== "auto" ? own : reader(outer.cs);
}

/** The z-index that orders an item among its siblings: positioned, or a flex or grid item. */
function zOf(item: Item, parentLays: boolean): number | null {
  if (item.kind === "text" || item.kind === "value" || item.kind === "cut") return null;
  const css = flowCss(item);
  const z = css("z-index");
  if (z === "auto" || !(positioned(css) || parentLays)) return null;
  const n = Number(z);
  return Number.isFinite(n) ? n : null;
}

/**
 * Whether an element makes a stacking context of its own without being
 * positioned: an opacity below 1, a transform, a filter, a backdrop
 * filter, a blend mode, a clip path or `isolation: isolate`. Chrome paints
 * such an element with the positioned ones at z-index 0, after its in-flow
 * siblings: a translucent box overlapping the next one is drawn over it.
 * (`will-change`, `contain` and masks do too; snap doesn't read them.)
 */
function makesStackingContext(css: Css): boolean {
  return Number(css("opacity")) < 1 || css("transform") !== "none" || css("filter") !== "none" || css("backdrop-filter") !== "none" ||
    css("mix-blend-mode") !== "normal" || css("clip-path") !== "none" || css("isolation") === "isolate";
}

/**
 * Siblings in paint order, which is the order Figma stacks layers in:
 * negative z-index first, then what isn't positioned (text, and ::before
 * first and ::after last, as the DOM has them), then positioned elements
 * with no z-index or 0, and elements making a stacking context of their
 * own (a flex or grid item's z-index 0 among them), then positive
 * z-index, each in DOM order.
 */
function paintOrder<T extends { item: Item; dom: number }>(kids: T[], parentLays: boolean): T[] {
  const group = ({ item }: T) => {
    const z = zOf(item, parentLays);
    if (z !== null && z < 0) return 0;
    if (z !== null && z > 0) return 3;
    if ((item.kind === "el" || item.kind === "pseudo") && (positioned(flowCss(item)) || z === 0 || makesStackingContext(item.css!))) return 2;
    return 1;
  };
  return [...kids].sort((a, b) =>
    group(a) - group(b) ||
    (group(a) === 0 || group(a) === 3 ? (zOf(a.item, parentLays) ?? 0) - (zOf(b.item, parentLays) ?? 0) : 0) ||
    a.dom - b.dom);
}

// --- Facts -------------------------------------------------------------------

/** `tag[data-slot=x]`, `tag[role=x]`, or an icon's `svg.lucide-x`: without quotes, as a label line can carry it. */
function elementName(el: RawTreeElement): string {
  const tag = el.tag === "svg" && el.lucide ? `svg.${el.lucide}` : el.tag;
  if (el.slot) return `${tag}[data-slot=${el.slot}]`;
  if (el.role) return `${tag}[role=${el.role}]`;
  return tag;
}

/** One value for all four sides when they agree, else the four in CSS order. */
function sides<T>(values: T[]): Sides<T> {
  return values.every((v) => JSON.stringify(v) === JSON.stringify(values[0])) ? values[0] : (values as [T, T, T, T]);
}

function borderFacts(css: Css): TreeNode["bd"] | undefined {
  const drawn = SIDES.map((side) => {
    const w = sideWidth(css, side);
    return w > 0 ? { w, s: css(`border-${side}-style`), c: normalizeColor(css(`border-${side}-color`)) } : null;
  });
  const first = drawn.find((d) => d !== null);
  if (!first) return undefined;
  return {
    w: sides(drawn.map((d) => d?.w ?? 0)),
    s: sides(drawn.map((d) => (d ?? first).s)),
    c: sides(drawn.map((d) => (d ?? first).c)),
  };
}

function radiusFacts(cs: Record<string, string>, box: RawBox): Sides<number> | undefined {
  const css = reader(cs);
  const raw: Record<string, string> = {};
  for (const corner of ["top-left", "top-right", "bottom-right", "bottom-left"]) raw[`border-${corner}-radius`] = css(`border-${corner}-radius`);
  const { topLeft, topRight, bottomRight, bottomLeft } = resolveRadii(raw, { width: box[2], height: box[3] });
  const values = [topLeft, topRight, bottomRight, bottomLeft];
  return values.every((v) => v === 0) ? undefined : sides(values);
}

function shadowFacts(css: Css): Shadow[] | undefined {
  const layers = parseBoxShadow(css("box-shadow")).map((s): Shadow =>
    s.inset ? [s.offsetX, s.offsetY, s.blur, s.spread, s.color, 1] : [s.offsetX, s.offsetY, s.blur, s.spread, s.color]);
  return layers.length ? layers : undefined;
}

/** Track count of a computed grid template, line names left out. */
function trackCount(value: string): number {
  if (!value || value === "none") return 0;
  return splitTopLevel(value.replace(/\[[^\]]*\]/g, " "), " ").length;
}

function layoutFacts(css: Css): TreeLayout {
  const display = css("display");
  const flex = display.includes("flex");
  const grid = display.includes("grid");
  const L: TreeLayout = { d: display };
  if (flex && css("flex-direction") !== "row") L.dir = css("flex-direction") as TreeLayout["dir"];
  if (flex && css("flex-wrap") !== "nowrap") L.wrap = 1;
  if ((flex || grid) && !["normal", "flex-start"].includes(css("justify-content"))) L.jc = css("justify-content");
  if ((flex || grid) && !["normal", "stretch"].includes(css("align-items"))) L.ai = css("align-items");
  if (flex || grid) {
    const gap: [number, number] = [px(css("row-gap")), px(css("column-gap"))];
    if (gap[0] || gap[1]) L.gap = gap;
  }
  const pad = SIDES.map((side) => px(css(`padding-${side}`))) as [number, number, number, number];
  if (pad.some(Boolean)) L.pad = pad;
  if (grid) L.tracks = [Math.max(1, trackCount(css("grid-template-columns"))), trackCount(css("grid-template-rows"))];
  return L;
}

/**
 * A node's facts as a flex or grid item of its parent: those of the
 * outermost wrapper collapsed into it, when there is one, since that is
 * the element its parent laid out, else its own. Its z-index as flowCss
 * finds it.
 */
function selfFacts(item: Item, parentCss: Css): TreeSelf | undefined {
  const flex = parentCss("display").includes("flex");
  const grid = parentCss("display").includes("grid");
  const of = (css: Css): TreeSelf => {
    const S: TreeSelf = {};
    if (flex) {
      if (css("flex-grow") !== "0") S.grow = Number(css("flex-grow"));
      if (css("flex-shrink") !== "1") S.shrink = Number(css("flex-shrink"));
      if (css("flex-basis") !== "auto") S.basis = css("flex-basis");
    }
    if ((flex || grid) && css("align-self") !== "auto") S.as = css("align-self");
    if ((flex || grid) && css("order") !== "0") S.order = Number(css("order"));
    return S;
  };
  // Section 6.2 takes the child's own and a wrapper's only when it has
  // none, but the child's grow or shrink worked inside the wrapper, which
  // is what grew or shrank in the parent: a child's shrink-0 under a
  // wrapper's flex-1 was stored as the item's, and the grow lost.
  const outer = item.wrappers[item.wrappers.length - 1];
  const S = of(outer ? reader(outer.cs) : item.css!);
  const z = zOf(item, flex || grid);
  if (z !== null) S.z = z;
  return Object.keys(S).length ? S : undefined;
}

/** A transform other than a translation, which moves a box without changing its shape. */
function shapeTransform(value: string): string | null {
  if (!value || value === "none") return null;
  const m = /^matrix\(([^)]*)\)$/.exec(value);
  if (m) {
    const [a, b, c, d] = m[1].split(",").map((v) => Number(v.trim()));
    if (a === 1 && b === 0 && c === 0 && d === 1) return null;
  }
  const m3 = /^matrix3d\(([^)]*)\)$/.exec(value);
  if (m3) {
    const v = m3[1].split(",").map((x) => Number(x.trim()));
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    if (identity.every((want, i) => v[i] === want) && v[15] === 1) return null;
  }
  return value;
}

/** The family a text is drawn in, as resolveFontFamily picks it from the page's probe of its stack. */
function fontOf(stack: string, fonts: Record<string, FontProbe | null>): { family: string; available: boolean | null; asked?: string } {
  const probe = fonts[stack];
  if (probe) return resolveFontFamily(probe);
  const first = (stack.split(",")[0] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
  // A stand-in snap drew (fonts.ts), by the name Figma has it under, and
  // the family after it as asked.
  const drawn = standInDrawn(first);
  if (!drawn) return { family: first, available: null };
  const next = stackFamilies(stack).slice(1).find((family) => !isStandInFamily(family));
  return { family: drawn, available: null, ...(next ? { asked: next } : {}) };
}

function textFacts(
  text: Record<string, string>,
  holder: Css,
  chars: string,
  run: { rects: RawBox[]; ink: RawBox } | null,
  own: Box,
  fonts: Record<string, FontProbe | null>,
  extra: { ph?: boolean; n?: number } = {},
): TextFacts {
  const font = fontOf(text["font-family"] ?? "", fonts);
  const size = px(text["font-size"] ?? "");
  const tx: TextFacts = { c: chars, f: font.family, sz: size, wt: normalizeFontWeight(text["font-weight"]), col: null, lh: "normal", n: 1, ink: [0, 0, 0, 0] };
  if (isFontKeyword(font.family)) tx.fk = 1;
  if (font.available === false) tx.fa = 0;
  if (font.asked) tx.fs = font.asked;
  if (/italic|oblique/.test(text["font-style"] ?? "")) tx.it = 1;
  tx.col = normalizeColor(text["color"]);
  tx.lh = normalizeLineHeight(text["line-height"]);
  const ls = normalizeLetterSpacing(text["letter-spacing"], size);
  if (ls) tx.ls = ls;
  const transform = text["text-transform"] ?? "none";
  if (transform === "uppercase" || transform === "lowercase" || transform === "capitalize") tx.tt = transform;
  const decoration = text["text-decoration-line"] ?? "none";
  if (/underline/.test(decoration)) tx.td = "underline";
  else if (/line-through/.test(decoration)) tx.td = "line-through";
  const align = (text["text-align"] ?? "start").replace(/^-webkit-/, "");
  if (align === "center" || align === "right" || align === "justify" || align === "end") tx.ta = align;
  const ws = text["white-space"] ?? "normal";
  if (ws === "nowrap" || ws === "pre" || ws === "pre-wrap" || ws === "pre-line") tx.ws = ws;
  if (text["text-overflow"] === "ellipsis" && ws === "nowrap" && clips(holder)) tx.el = 1;
  const clamp = Number.parseInt(text["-webkit-line-clamp"] ?? "", 10);
  if (Number.isFinite(clamp) && clamp > 0) tx.cl = clamp;
  if (run) {
    tx.n = lineCount(run.rects);
    tx.ink = roundBox([run.ink[0] - own[0], run.ink[1] - own[1], run.ink[2], run.ink[3]]);
  } else {
    tx.n = extra.n ?? 1;
  }
  if (extra.ph) tx.ph = 1;
  return tx;
}

/** Lines a run of text took: its rects' distinct tops, within 1px of each other counted as one. */
export function lineCount(rects: readonly RawBox[]): number {
  const tops = rects.map((r) => r[1]).sort((a, b) => a - b);
  let lines = 0;
  let last = -Infinity;
  for (const top of tops) {
    if (top - last > 1) lines++;
    last = top;
  }
  return Math.max(1, lines);
}

/** The union of a run's rects: its glyphs' box. */
function inkOf(rects: readonly RawBox[]): RawBox {
  const x0 = Math.min(...rects.map((r) => r[0]));
  const y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** The height of a run's first line of glyphs: the tallest of its rects at the topmost top, within 1px. */
export function firstLineHeight(rects: readonly RawBox[]): number {
  const top = Math.min(...rects.map((r) => r[1]));
  return Math.max(...rects.filter((r) => r[1] - top <= 1).map((r) => r[3]));
}

/**
 * A run's line box, which is what Figma's text node is: as wide as its
 * glyphs, as tall as its lines, its top where the first line's half-leading
 * starts. A glyph box is 17px tall for 14px type where the line is 20, and
 * building to it drifted every label by about 3px. At `line-height: normal`
 * the line is the glyphs'.
 *
 * `glyph` is one line's glyph height, the first line's (firstLineHeight).
 * Section 6.4's `inkH / n` is not it: the glyphs' union is n − 1 lines plus
 * one line's glyphs, so that put every wrapped run (lh − glyph) / 2 × (1 −
 * 1/n) too low, 1.5px for 4 lines at 20px and 5px for 7 at 28px. Without
 * rects, it is the union less the lines below the first.
 */
export function lineBox(ink: RawBox, lines: number, lineHeight: number | "normal", glyph?: number): RawBox {
  if (lineHeight === "normal") return ink;
  const g = glyph ?? ink[3] - (lines - 1) * lineHeight;
  return [ink[0], ink[1] - (lineHeight - g) / 2, ink[2], lineHeight * lines];
}

// --- Build -----------------------------------------------------------------------

interface Ctx {
  fonts: Record<string, FontProbe | null>;
  svg: Record<string, string>;
  images: PendingImage[];
  rasters: PendingRaster[];
  notes: Set<string>;
  maxSvgChars: number;
}

/**
 * The `text-*` evidence a text or icon inherits its color by: from the
 * nearest element up the DOM that sets one always, as a card sets its
 * title's; failing that, from the nearest that sets one in some state
 * (`hover:text-accent-foreground`). The DOM's elements are each item's
 * own and then the wrappers collapsed into it, innermost first, which sat
 * between it and its parent: a wrapper's `text-muted-foreground` is
 * nearer than the card's.
 */
function inheritedTextEvidence(item: Item): string[] {
  const colors = (el: RawTreeElement, prefixed: boolean) => [...new Set(evidenceOf(el.cls ?? [])
    .filter((e) => e.prefixed === prefixed && e.name.startsWith("text-") && !TEXT_NOT_COLOR.test(e.name)).map((e) => e.name))].sort();
  for (const prefixed of [false, true]) {
    for (let at: Item | undefined = item.kind === "el" ? item : item.parent; at; at = at.parent) {
      for (const el of [at.el, ...at.wrappers]) {
        const found = el ? colors(el, prefixed) : [];
        if (found.length) return found.slice(0, 8);
      }
    }
  }
  return [];
}

function factsOf(item: Item, key: string, parent: Item | null, parentBox: Box, ctx: Ctx): TreeNode {
  const rel = (box: Box): Box => [r2(box[0] - parentBox[0]), r2(box[1] - parentBox[1]), box[2], box[3]];
  const isRoot = parent === null;

  if (item.kind === "text" || item.kind === "value") {
    const holder = item.css!;
    const text = item.run?.style ?? item.el!.text ?? {};
    let node: TreeNode;
    if (item.kind === "text") {
      const run = item.run!;
      const ink = inkOf(run.rects);
      const lh = normalizeLineHeight(text["line-height"]);
      const box = roundBox(lineBox(ink, lineCount(run.rects), lh, firstLineHeight(run.rects)));
      const chars = runCharacters(run.text, text["white-space"] ?? "normal");
      node = { k: key, t: "T", el: "#text", box: rel(box), tx: textFacts(text, holder, chars, { rects: run.rects, ink }, box, ctx.fonts) };
    } else {
      const input = item.el!.input!;
      const box = item.box;
      const shown = input.value !== "" ? input.value : input.placeholder;
      const facts = { ...text, ...(input.value === "" && input.placeholderColor ? { color: input.placeholderColor } : {}) };
      const tx = textFacts(facts, holder, input.type === "password" ? "•".repeat(shown.length) : shown, null, box, ctx.fonts, { ph: input.value === "" });
      // The value's glyphs, as the page measured their advance, at the start
      // of the box (or where text-align puts them) and its full height.
      const w = r2(Math.min(input.advance, box[2]));
      const x = tx.ta === "center" ? r2((box[2] - w) / 2) : tx.ta === "right" || tx.ta === "end" ? r2(box[2] - w) : 0;
      tx.ink = [x, 0, w, box[3]];
      node = { k: key, t: "T", el: "#value", box: rel(box), tx };
    }
    if (holder("visibility") !== "visible") node.vis = 0;
    const cls = inheritedTextEvidence(item);
    if (cls.length) node.cls = cls;
    return node;
  }

  if (item.kind === "pseudo") {
    const p = item.pseudo!;
    const css = item.css!;
    const content = p.content.trim();
    const paints = paintsOwnBox(p.cs);
    const node: TreeNode = { k: key, t: paints || !content ? "F" : "T", el: `::${p.which}`, box: rel(item.box) };
    if (p.how === "abs") node.abs = 1;
    // A translation is in its box already; a rotation or scale is not one
    // a box can hold, as on an element.
    const transform = shapeTransform(css("transform"));
    if (transform) node.tf = transform;
    applyPaint(node, p.cs, p.box, css);
    applyEffects(node, css, false);
    if (node.t === "T") {
      node.tx = textFacts(p.text ?? {}, css, content, null, item.box, ctx.fonts);
      node.tx.ink = [0, 0, item.box[2], item.box[3]];
    }
    const approx = [
      p.unanchored ? "containing-block" : null, p.moved ? "pseudo-stand-in" : null, paints && content ? "pseudo-text" : null, transform ? "transform" : null,
    ].filter(Boolean);
    if (approx.length) node.approx = approx.join(",");
    return node;
  }

  const el = item.el!;
  const css = item.css!;
  const transform = shapeTransform(css("transform"));
  let box = item.box;
  // Under a rotation or scale, the box the transform drew is no rectangle
  // Figma can hold: keep the element's own size, centered where it drew.
  if (transform && el.size) {
    const [cx, cy] = [el.box[0] + el.box[2] / 2, el.box[1] + el.box[3] / 2];
    box = roundBox([cx - el.size[0] / 2, cy - el.size[1] / 2, el.size[0], el.size[1]]);
  }
  const raster = isNativeControl(el) || el.tag === "canvas" || el.tag === "video";
  let kind: TreeNode["t"] = item.leaf ? "T" : el.tag === "svg" ? "V" : el.tag === "img" || raster ? "I" : "F";
  const node: TreeNode = { k: key, t: kind, el: elementName(el), box: isRoot ? [0, 0, box[2], box[3]] : rel(box) };
  // Its children stay where they were in it: their boxes are relative to its unmoved one.
  if (item.shift) node.box = [r2(node.box[0] + item.shift[0]), r2(node.box[1] + item.shift[1]), node.box[2], node.box[3]];
  const approx: string[] = [];

  if (!isRoot) {
    // Out of the flow if it, or a wrapper it stands in for, is.
    if (outOfFlow(item.css!) || item.wrappers.some((w) => outOfFlow(reader(w.cs)))) node.abs = 1;
    const S = selfFacts(item, parent!.css!);
    if (S) node.S = S;
  }
  if (transform) {
    node.tf = transform;
    approx.push("transform");
  }
  if (item.kids.length && !item.leaf) node.L = layoutFacts(css);
  if (!isRoot) applyPaint(node, el.cs, el.box, css);
  applyEffects(node, css, kind === "T");

  if (item.leaf) {
    const run = item.leaf;
    const ink = inkOf(run.rects);
    const style = run.style ?? el.text ?? {};
    node.tx = textFacts(style, css, runCharacters(run.text, style["white-space"] ?? "normal"), { rects: run.rects, ink }, box, ctx.fonts);
  }

  if (el.tag === "svg") {
    const tooBig = el.svgElements !== undefined || !el.svg;
    const built = tooBig ? null : serializeSvg(el.svg!, box);
    if (built && built.markup.length <= ctx.maxSvgChars) {
      const id = svgAssetId(built.markup);
      ctx.svg[id] = built.markup;
      node.svg = id;
      node.shapes = (el.shapes ?? []).map(roundBox);
      if (built.flags.length) approx.push(`svg:${built.flags.join(",")}`);
    } else {
      // A chart's worth of markup: a picture of it instead (section 6.6).
      kind = node.t = "I";
      node.raster = 1;
      ctx.rasters.push({ key, path: el.path, why: "svg" });
    }
  } else if (raster) {
    node.raster = 1;
    ctx.rasters.push({ key, path: el.path, why: el.tag });
  } else if (el.tag === "img" && el.img) {
    const content = contentBox(el);
    ctx.images.push({
      key, path: el.path, src: el.img.src, natural: el.img.natural,
      fit: css("object-fit"), position: css("object-position"), content: [content[2], content[3]],
    });
  } else if (kind === "F" && backgroundLayers(css("background-image")).some((layer) => layerUrl(layer) !== null)) {
    // A url() background (section 6.7). One picture drawn once, or covering
    // the box, in a box holding nothing else, is an image whose bytes snap
    // keeps; any other in a box holding nothing else, tiled, layered or
    // under a gradient, is a screenshot of the box. A box with children
    // can be neither, as a screenshot would bake them in: it is a frame
    // without the picture, saying so, its url() never written into bgi.
    const plain = plainImageBackground(css);
    if (!item.kids.length && plain) {
      kind = node.t = "I";
      delete node.bgi;
      ctx.images.push({
        key, path: el.path, src: plain, natural: [0, 0],
        fit: css("background-size"), position: css("background-position"), content: [item.box[2], item.box[3]],
      });
    } else if (!item.kids.length) {
      kind = node.t = "I";
      node.raster = 1;
      delete node.bgi;
      ctx.rasters.push({ key, path: el.path, why: "background-image" });
    } else {
      approx.push("background-image");
    }
  }

  // Class evidence, on what draws: its own classes, and for text and icons
  // the text color they inherit, as a card's title takes the card's.
  if (item.paints || kind === "T" || kind === "V") {
    let cls = classEvidence(el.cls ?? []);
    const setsColor = evidenceOf(el.cls ?? []).some((e) => !e.prefixed && e.name.startsWith("text-") && !TEXT_NOT_COLOR.test(e.name));
    if ((kind === "T" || kind === "V") && !setsColor) {
      cls = [...new Set([...cls, ...inheritedTextEvidence(item)])].sort().slice(0, 8);
    }
    if (cls.length) node.cls = cls;
  }
  if (approx.length) node.approx = approx.join(",");
  return isRoot ? rootOnly(node) : node;
}

/**
 * A background's layers, split at the commas between them: a quoted url's
 * own commas and parentheses, as an inline SVG's `rgb(255,0,0)` has, are
 * left alone, where splitTopLevel would count them.
 */
export function backgroundLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < value.length) current += value[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      if (current.trim()) layers.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() && current.trim() !== "none") layers.push(current.trim());
  return layers;
}

/** A url() layer's URL, its quotes and CSS escapes undone, or null for any other layer. */
export function layerUrl(layer: string): string | null {
  const m = /^url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"'()\s]*))\s*\)$/s.exec(layer.trim());
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/gs, (_, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch ?? "");
}

/**
 * The URL of a background that is one picture Figma can fill a frame with:
 * one url() layer, drawn once, or covering the box, which hides any tiling.
 * Null for anything else.
 */
function plainImageBackground(css: Css): string | null {
  const layers = backgroundLayers(css("background-image"));
  const url = layers.length === 1 ? layerUrl(layers[0]) : null;
  if (url === null) return null;
  return css("background-repeat") === "no-repeat" || css("background-size") === "cover" ? url : null;
}

/** A background's gradients, with any url() layer left out: what bgi can hold. */
function backgroundWithoutUrls(value: string): string | null {
  return normalizeBackgroundImage(backgroundLayers(value).filter((layer) => layerUrl(layer) === null).join(", "));
}

/** A node's own paint: background, border, radius, shadow and opacity. The root's is its styles'. */
function applyPaint(node: TreeNode, cs: Record<string, string>, box: RawBox, css: Css): void {
  const bg = normalizeColor(css("background-color"));
  if (bg) node.bg = bg;
  const bgi = backgroundWithoutUrls(css("background-image"));
  if (bgi) node.bgi = bgi;
  const clip = splitTopLevel(css("background-clip")).pop()?.trim() ?? "border-box";
  if ((bg || bgi) && (clip === "padding-box" || clip === "content-box")) node.bgc = clip;
  const bd = borderFacts(css);
  if (bd) node.bd = bd;
  const r = radiusFacts(cs, box);
  if (r !== undefined) node.r = r;
  const sh = shadowFacts(css);
  if (sh) node.sh = sh;
  const op = Number(css("opacity"));
  if (Number.isFinite(op) && op !== 1) node.op = r2(op);
}

/** Blend, clip, filters, outline, visibility and clip-path: what the root keeps too. */
function applyEffects(node: TreeNode, css: Css, isText: boolean): void {
  if (css("mix-blend-mode") !== "normal") node.bm = css("mix-blend-mode");
  if (clips(css) && !isText && !node.el.startsWith("::")) {
    const x = css("overflow-x") !== "visible";
    const y = css("overflow-y") !== "visible";
    node.clip = x && y ? 1 : x ? "x" : "y";
  }
  if (css("filter") !== "none") node.fl = css("filter");
  if (css("backdrop-filter") !== "none") node.bf = css("backdrop-filter");
  if (hasOutline(css)) node.ol = [px(css("outline-width")), css("outline-style"), normalizeColor(css("outline-color")), px(css("outline-offset"))];
  if (css("visibility") !== "visible") node.vis = 0;
  if (css("clip-path") !== "none") node.cp = css("clip-path");
}

/** The root as the tree stores it: what its styles don't hold (ROOT_FIELDS). */
function rootOnly(node: TreeNode): TreeNode {
  const out: Record<string, unknown> = {};
  for (const field of ROOT_FIELDS) {
    const value = (node as unknown as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  return out as unknown as TreeNode;
}

/**
 * A variant's tree, from what the page read: pruned, collapsed, keyed,
 * ordered by paint, with facts, cut at the limits (TREE_LIMITS). Images and
 * rasters come back pending: their asset ids need bytes, which
 * snap-browser.ts fetches, and the node's `img` is set from them.
 */
export function buildTree(capture: RawTreeCapture, options: TreeBuildOptions = {}): BuiltTree {
  const maxNodes = options.maxNodes ?? TREE_LIMITS.maxNodes;
  const maxDepth = options.maxDepth ?? TREE_LIMITS.maxDepth;
  const ctx: Ctx = { fonts: capture.fonts, svg: {}, images: [], rasters: [], notes: new Set(), maxSvgChars: options.maxSvgChars ?? TREE_LIMITS.maxSvgChars };
  const [root] = buildItem(capture.root, true);
  anchorToRoot(root);

  const nodes: TreeNode[] = [];
  const movedInside: string[] = [];
  let total = 0;
  let at: string | null = null;
  // The facts of a node are made only when it is kept, so an image past
  // the limit isn't fetched. Both limits only tighten as the walk goes on,
  // so a node dropped at one drops its subtree too.
  const visit = (item: Item, key: string, parent: Item | null, parentBox: Box, depth: number) => {
    if (item.kind === "cut") {
      // Where the page stopped reading: everything from here on is unknown.
      at ??= key;
      return;
    }
    total++;
    const keep = depth <= maxDepth && nodes.length < maxNodes;
    if (!keep && at === null) at = key;
    if (keep) nodes.push(factsOf(item, key, parent, parentBox, ctx));
    if (keep && item.drewOutside) movedInside.push(key);
    if (item.leaf || item.kind !== "el" || item.el!.tag === "svg") return;
    const counts = new Map<string, number>();
    const keyed = item.kids.map((kid, dom) => {
      const segment = segmentOf(kid, ctx.notes);
      const n = (counts.get(segment) ?? 0) + 1;
      counts.set(segment, n);
      return { item: kid, dom, key: (key ? `${key}/` : "") + (n === 1 ? segment : `${segment}:${n}`) };
    });
    const lays = /flex|grid/.test(item.css!("display"));
    const box = parent === null ? [0, 0, item.box[2], item.box[3]] as Box : item.box;
    for (const kid of paintOrder(keyed, lays)) visit(kid.item, kid.key, item, box, depth + 1);
  };
  visit(root, "", null, [0, 0, 0, 0], 0);

  const keptKeys = new Set(nodes.map((n) => n.k));
  return {
    nodes,
    ...(at !== null ? { truncated: { nodes: total, at } } : {}),
    svg: ctx.svg,
    images: ctx.images.filter((i) => keptKeys.has(i.key)),
    rasters: ctx.rasters.filter((r) => keptKeys.has(r.key)),
    notes: [...ctx.notes],
    movedInside,
  };
}

/**
 * How many elements under the root a tree would hold, for `--root-only`,
 * which records the count so verify can say how much went unmeasured.
 */
export function countInnerElements(capture: RawTreeCapture): number {
  const [root] = buildItem(capture.root, true);
  const count = (item: Item): number => (item.kind === "cut" ? 0 : 1) + (item.leaf || item.kind !== "el" ? 0 : item.kids.reduce((sum, kid) => sum + count(kid), 0));
  return count(root) - 1;
}

// --- Writing styles.json ---------------------------------------------------------

/** What stylesJsonText reads of a snap: its components' trees and variants' deltas. */
interface WritableSnap {
  components: { tree?: { base: TreeNode[] }; variants: { treeDelta?: { set?: Record<string, unknown> } }[] }[];
}

/**
 * styles.json's text: pretty-printed with 2 spaces, as it always was, with
 * each tree node, in a component's `base` and a variant's `treeDelta.set`,
 * on one line of its own, its keys sorted (section 7.3 of the design). A
 * change to one element is then one changed line in a pull request, where
 * a node spread over lines tripled the file and buried what changed. A snap
 * with no trees, as `--root-only` writes, comes out as JSON.stringify writes
 * it, byte for byte.
 */
export function stylesJsonText(result: WritableSnap): string {
  const compact: string[] = [];
  // Each node stands in the pretty-printed text as a placeholder string no
  // value can hold, a NUL either side, until it is swapped for its line.
  const hold = (value: unknown) => {
    compact.push(canonicalJson(value));
    return `\u0000${compact.length - 1}\u0000`;
  };
  const components = result.components.map((component) => {
    if (!component.tree && !component.variants.some((v) => v.treeDelta?.set)) return component;
    return {
      ...component,
      ...(component.tree ? { tree: { ...component.tree, base: component.tree.base.map(hold) } } : {}),
      variants: component.variants.map((variant) => {
        const set = variant.treeDelta?.set;
        if (!set) return variant;
        return { ...variant, treeDelta: { ...variant.treeDelta, set: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, hold(v)])) } };
      }),
    };
  });
  const text = JSON.stringify({ ...result, components }, null, 2);
  return `${text.replace(/"\\u0000(\d+)\\u0000"/g, (_, i: string) => compact[Number(i)])}\n`;
}
