// Tests for the element tree snap builds from what the page read: captures
// of the shadcn/ui registry's stories (fixtures/raw), and synthetic ones for
// each rule. No browser: snap-browser.ts's page function made the captures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTree, classEvidence, countInnerElements, firstLineHeight, lineBox, lineCount, paintsOwnBox, stylesJsonText } from "../snap-tree.js";
import type { RawBox, RawTreeCapture, RawTreeElement, RawTreeItem, RawTreePseudo, RawTreeText } from "../snap-tree.js";
import { expandTree } from "../tree-types.js";
import type { ComponentTree, TreeDelta, TreeNode } from "../tree-types.js";
import { canonicalJson } from "../checksum.js";
import { loadTreeFixture } from "./mock-figma.js";

const RAW_DIR = fileURLToPath(new URL("../../../cli/__tests__/fixtures/raw/", import.meta.url));

function raw(name: string): RawTreeCapture {
  return (JSON.parse(readFileSync(`${RAW_DIR}${name}.json`, "utf8")) as { capture: RawTreeCapture }).capture;
}

const byKey = (nodes: TreeNode[]) => new Map(nodes.map((n) => [n.k, n]));

// --- Synthetic captures ------------------------------------------------------------

function el(tag: string, box: RawBox, cs: Record<string, string> = {}, kids: RawTreeItem[] = [], extra: Partial<RawTreeElement> = {}): RawTreeElement {
  return { k: "e", tag, box, cs, kids, path: [], ...extra };
}

function run(text: string, rects: RawBox[]): RawTreeText {
  return { k: "t", text, rects };
}

/** A text holder's computed text properties, as the page reads them. */
const TEXT: Record<string, string> = {
  color: "rgb(10, 10, 10)", "font-family": "Inter", "font-size": "14px", "font-weight": "400", "font-style": "normal",
  "line-height": "20px", "letter-spacing": "normal", "text-transform": "none", "text-decoration-line": "none",
  "text-align": "start", "white-space": "normal", "text-overflow": "clip", "-webkit-line-clamp": "none",
};

const BORDER = { "border-top-width": "1px", "border-right-width": "1px", "border-bottom-width": "1px", "border-left-width": "1px",
  "border-top-color": "rgb(229, 229, 229)", "border-right-color": "rgb(229, 229, 229)", "border-bottom-color": "rgb(229, 229, 229)", "border-left-color": "rgb(229, 229, 229)" };

const tree = (root: RawTreeElement, fonts: RawTreeCapture["fonts"] = {}): RawTreeCapture => ({ root, fonts });

// --- What the registry's stories give ------------------------------------------------

test("buildTree: Switch is its track and its thumb, the thumb a 16px white pill 1px in", () => {
  const { nodes } = buildTree(raw("switch"));
  assert.deepEqual(nodes.map((n) => n.k), ["", "switch-thumb"]);
  const thumb = byKey(nodes).get("switch-thumb")!;
  assert.deepEqual(thumb.box, [1, 1.19, 16, 16]);
  assert.equal(thumb.bg, "#ffffff");
  assert.equal(thumb.r, 8);
  // The root keeps its paint in its styles, not on its node.
  assert.equal(nodes[0].bg, undefined);
  assert.deepEqual(nodes[0].L, { d: "flex", ai: "center" });
});

test("buildTree: Switch at sm has a 12px thumb, its radius scaled to fit", () => {
  const thumb = byKey(buildTree(raw("switch-sm")).nodes).get("switch-thumb")!;
  assert.deepEqual(thumb.box, [1, 1, 12, 12]);
  assert.equal(thumb.r, 6);
});

test("buildTree: Avatar is its photo, waiting for its bytes, and the ring its ::after draws", () => {
  const built = buildTree(raw("avatar"));
  assert.equal(built.nodes.length, 3);
  const map = byKey(built.nodes);
  const image = map.get("avatar-image")!;
  assert.equal(image.t, "I");
  assert.equal(image.r, 16);
  assert.equal(image.clip, 1);
  const ring = map.get("::after")!;
  assert.deepEqual(ring.box, [0, 0, 32, 32]);
  assert.deepEqual(ring.bd, { w: 1, s: "solid", c: "#e5e5e5" });
  assert.equal(ring.bm, "darken");
  assert.equal(ring.abs, 1);
  // Painted last: it is the ring over the photo.
  assert.equal(built.nodes[2].k, "::after");
  assert.deepEqual(built.images, [{
    key: "avatar-image", path: [0], src: "https://github.com/shadcn.png", natural: [460, 460], fit: "cover", position: "50% 50%", content: [32, 32],
  }]);
  // Section 15's "the root has clip" is wrong, as package T found: the image clips itself.
  assert.equal(built.nodes[0].clip, undefined);
});

test("buildTree: InputOTP is its six slots sharing borders, without the input laid over them", () => {
  const { nodes } = buildTree(raw("inputotp"));
  assert.equal(nodes.length, 8);
  assert.equal(nodes[0].el, "div");
  const slots = nodes.filter((n) => n.el === "div[data-slot=input-otp-slot]");
  assert.equal(slots.length, 6);
  assert.deepEqual(slots.map((s) => s.bd!.w), [1, [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0]]);
  assert.deepEqual(slots[0].r, [8, 0, 0, 8]);
  assert.deepEqual(slots[5].r, [0, 8, 8, 0]);
  assert.equal(slots[3].k, "input-otp-group/input-otp-slot:4");
  assert.ok(!nodes.some((n) => /input/.test(n.el) && !/input-otp/.test(n.el)));
});

test("buildTree: Card holds 23 elements, its title 24px in from the header's edge", () => {
  const { nodes } = buildTree(raw("card"));
  assert.equal(nodes.length, 23);
  const title = byKey(nodes).get("card-header/card-title")!;
  assert.equal(title.t, "T");
  assert.equal(title.box[0], 24);
  assert.equal(title.tx!.c, "Notifications");
  // A title inherits the card's text color, so the class that sets it goes with it.
  assert.ok(title.cls!.includes("text-card-foreground"), String(title.cls));
});

test("buildTree: a vertical Attachment's title is cut off with an ellipsis, narrower than its glyphs", () => {
  const title = byKey(buildTree(raw("attachment-vertical")).nodes).get("attachment-content/attachment-title")!;
  assert.equal(title.tx!.el, 1);
  assert.ok(title.box[2] < title.tx!.ink[2], `${title.box[2]} vs ${title.tx!.ink[2]}`);
  assert.equal(title.clip, undefined);
});

test("buildTree: Attachment's media tile, positioned, paints after the content it sits before", () => {
  const { nodes } = buildTree(raw("attachment"));
  assert.deepEqual(nodes.filter((n) => !n.k.includes("/")).map((n) => n.k), ["", "attachment-content", "attachment-media", "attachment-action"]);
  assert.deepEqual(byKey(nodes).get("attachment-action")!.S, { shrink: 0, z: 20 });
});

test("buildTree: Toggle is its button and a lucide icon, kept as markup in hex paints", () => {
  const built = buildTree(raw("toggle"));
  assert.equal(built.nodes.length, 2);
  const icon = built.nodes[1];
  assert.equal(icon.t, "V");
  assert.equal(icon.el, "svg.lucide-bold");
  const markup = built.svg[icon.svg!];
  assert.ok(markup.length <= 1000, String(markup.length));
  assert.ok(!/oklch|rgb/.test(markup), markup);
  assert.match(markup, /stroke="#0a0a0a"/);
  // The same id package T's fixture has for the same icon.
  assert.equal(icon.svg, "svg:3a1614af");
});

test("buildTree: Button with an icon is the button, its icon and its label", () => {
  const { nodes } = buildTree(raw("button-icon"));
  assert.deepEqual(nodes.map((n) => [n.k, n.t]), [["", "F"], ["svg", "V"], ["#text", "T"]]);
  // The label's box is its line, not its glyphs: 20px high for 14px type.
  assert.deepEqual(nodes[2].box, [41, 7.5, 154.8, 20]);
  assert.deepEqual(nodes[2].tx!.ink, [0, 1.5, 154.8, 17]);
});

test("buildTree: the stories package T's fixtures came from build to the same trees, plus class evidence", () => {
  // Package T converted prototype captures; these are snap's own. They
  // match but for what the prototypes didn't capture: class evidence, a
  // flex-basis, the Toggle icon's lucide class, and the image's id, which
  // needs the photo's bytes.
  const pairs: [string, string, string | null][] = [
    ["switch", "switch", null], ["switch-sm", "switch", "size-sm"], ["avatar", "avatar", null], ["inputotp", "inputotp", null],
    ["card", "card", null], ["attachment", "attachment", null], ["attachment-vertical", "attachment", "size-default--orientation-vertical--state-done"],
    ["toggle", "toggle", null], ["button-icon", "button-icon", null], ["sidebar", "sidebar", null],
  ];
  for (const [name, fixture, slug] of pairs) {
    const component = loadTreeFixture(fixture).components[0] as unknown as { tree: ComponentTree; variants: { slug: string; treeDelta?: TreeDelta }[] };
    const variant = slug ? component.variants.find((v) => v.slug === slug) : undefined;
    const theirs = expandTree(component.tree, variant?.treeDelta).map((n) => {
      const node = structuredClone(n);
      delete node.img;
      if (node.el === "svg" && node.svg === "svg:3a1614af") node.el = "svg.lucide-bold";
      return node;
    });
    const ours = buildTree(raw(name)).nodes.map((n) => {
      const node = structuredClone(n);
      delete node.cls;
      if (node.S) {
        delete node.S.basis;
        if (!Object.keys(node.S).length) delete node.S;
      }
      return node;
    });
    assert.equal(canonicalJson(ours), canonicalJson(theirs), name);
  }
});

test("buildTree: two builds of one capture are the same, byte for byte", () => {
  for (const file of readdirSync(RAW_DIR).filter((f) => f.endsWith(".json"))) {
    const name = file.replace(/\.json$/, "");
    assert.equal(canonicalJson(buildTree(raw(name))), canonicalJson(buildTree(raw(name))), name);
  }
});

// --- Pruning -----------------------------------------------------------------------

test("buildTree: what is hidden, cut to a pixel, out of the flow drawing nothing, or of no size is left out", () => {
  const root = el("div", [0, 0, 100, 40], { display: "flex" }, [
    // sr-only: absolute, 1px, clipping.
    el("span", [0, 0, 1, 1], { position: "absolute", "overflow-x": "hidden", "overflow-y": "hidden" }, [run("Close", [[0, 0, 1, 1]])], { text: TEXT }),
    // Opacity 0, though it draws.
    el("div", [0, 0, 10, 10], { opacity: "0", "background-color": "rgb(255, 0, 0)" }),
    // Out of the flow, drawing nothing in all of it: input-otp's overlay.
    el("div", [0, 0, 100, 40], { position: "absolute" }, [el("div", [0, 0, 100, 40])]),
    // Of no size, drawing nothing.
    el("div", [10, 0, 0, 40]),
    // A pseudo-element that draws nothing: Switch's hit area.
    { k: "p", which: "after", cs: { position: "absolute" }, content: "", box: [-12, 0, 124, 40], how: "abs" },
    // Kept: in the flow, drawing nothing, but taking room.
    el("div", [20, 0, 30, 40]),
  ]);
  const { nodes } = buildTree(tree(root));
  assert.deepEqual(nodes.map((n) => n.k), ["", "div"]);
  assert.deepEqual(nodes[1].box, [20, 0, 30, 40]);
});

test("buildTree: an input laid over what draws, transparent and drawing nothing, is left out; one showing text is kept", () => {
  const overlay = el("input", [0, 0, 100, 40], { position: "absolute" }, [], {
    text: { ...TEXT, color: "rgba(0, 0, 0, 0)" }, input: { type: "text", value: "", placeholder: "", advance: 0 },
  });
  assert.deepEqual(buildTree(tree(el("div", [0, 0, 100, 40], {}, [overlay, el("div", [0, 0, 100, 40], BORDER)]))).nodes.map((n) => n.k), ["", "div"]);

  const field = el("input", [0, 0, 200, 36], { ...BORDER, "padding-left": "12px", "padding-right": "12px" }, [], {
    text: { ...TEXT }, input: { type: "email", value: "", placeholder: "Email", placeholderColor: "rgb(115, 115, 115)", advance: 36.5 },
  });
  const { nodes } = buildTree(tree(el("div", [0, 0, 200, 36], {}, [field])));
  const value = byKey(nodes).get("input/#value")!;
  assert.equal(value.t, "T");
  assert.equal(value.el, "#value");
  // At the content box, in the placeholder's color, marked as one.
  assert.deepEqual(value.box, [13, 1, 174, 34]);
  assert.equal(value.tx!.c, "Email");
  assert.equal(value.tx!.ph, 1);
  assert.equal(value.tx!.col, "#737373");
  assert.deepEqual(value.tx!.ink, [0, 0, 36.5, 34]);
});

test("buildTree: a native checkbox is kept as a picture of itself; one restyled with appearance: none is a frame", () => {
  const native = el("input", [0, 0, 16, 16], { appearance: "auto" }, [], { path: [0], text: TEXT, input: { type: "checkbox", value: "on", placeholder: "", advance: 0 } });
  const built = buildTree(tree(el("div", [0, 0, 16, 16], {}, [native])));
  assert.deepEqual(built.nodes[1], { k: "input", t: "I", el: "input", box: [0, 0, 16, 16], raster: 1 });
  assert.deepEqual(built.rasters, [{ key: "input", path: [0], why: "input" }]);
  // Restyled, it is its box; its value, `on`, is never drawn.
  const styled = el("input", [0, 0, 16, 16], { appearance: "none", ...BORDER }, [], { path: [0], text: TEXT, input: { type: "checkbox", value: "on", placeholder: "", advance: 14 } });
  assert.deepEqual(buildTree(tree(el("div", [0, 0, 16, 16], {}, [styled]))).nodes.slice(1).map((n) => [n.k, n.t]), [["input", "F"]]);
  // Native, it draws though nothing of its box does: never pruned as empty.
  const floating = el("input", [0, 0, 16, 16], { appearance: "auto", position: "absolute" }, [], { path: [0], text: TEXT, input: { type: "radio", value: "on", placeholder: "", advance: 0 } });
  assert.equal(buildTree(tree(el("div", [0, 0, 16, 16], {}, [floating]))).nodes[1]?.raster, 1);
});

test("buildTree: a select is a picture of itself, or restyled, its chosen option's label; options, which have no box, are never nodes", () => {
  const select = (cs: Record<string, string>) => el("select", [0, 0, 120, 36], { ...BORDER, "padding-left": "12px", ...cs }, [], {
    path: [0], text: TEXT, input: { type: "select", value: "Banana", placeholder: "", advance: 42 },
  });
  const native = buildTree(tree(el("div", [0, 0, 120, 36], {}, [select({ appearance: "auto" })])));
  assert.deepEqual(native.nodes.slice(1).map((n) => [n.k, n.t, n.raster]), [["select", "I", 1]]);
  assert.deepEqual(native.rasters, [{ key: "select", path: [0], why: "select" }]);
  const styled = buildTree(tree(el("div", [0, 0, 120, 36], {}, [select({})]))).nodes;
  assert.deepEqual(styled.slice(1).map((n) => [n.k, n.t, n.tx?.c]), [["select", "F", undefined], ["select/#value", "T", "Banana"]]);
  // Text the page found no line of draws nothing: an element holding only that is no box to keep.
  const option = el("option", [-4, -4, 0, 0], {}, [run("Banana", [])], { text: TEXT });
  assert.deepEqual(buildTree(tree(el("div", [0, 0, 120, 36], {}, [option, el("div", [0, 0, 10, 10], BORDER)]))).nodes.map((n) => n.k), ["", "div"]);
});

// --- Collapse ----------------------------------------------------------------------

test("buildTree: a wrapper the size of its one child gives way to it, which takes the wrapper's place in its parent's flow", () => {
  const icon = el("span", [8, 8, 16, 16], { "background-color": "rgb(0, 0, 0)" });
  const wrapper = el("span", [8, 8, 16, 16], { "flex-shrink": "0" }, [icon], { slot: "icon-wrapper" });
  const { nodes } = buildTree(tree(el("div", [0, 0, 32, 32], { display: "flex" }, [wrapper])));
  // No segment for the wrapper; its shrink, as the child set none.
  assert.deepEqual(nodes.map((n) => n.k), ["", "span"]);
  assert.deepEqual(nodes[1].S, { shrink: 0 });
  // One that clips, pads or fades what it holds stays.
  const keeping: Record<string, string>[] = [{ "overflow-x": "hidden", "overflow-y": "hidden" }, { "padding-top": "2px" }, { opacity: "0.5" }];
  for (const cs of keeping) {
    const kept = el("span", [8, 8, 16, 16], cs, [icon]);
    assert.equal(buildTree(tree(el("div", [0, 0, 32, 32], {}, [kept]))).nodes.length, 3, JSON.stringify(cs));
  }
});

test("buildTree: an element that is only its text becomes the text, sized as the element; one with padding keeps a text inside", () => {
  const leaf = el("p", [0, 0, 200, 20], {}, [run(" Hello\n  world ", [[0, 1, 70, 17]])], { text: TEXT });
  const [, node] = buildTree(tree(el("div", [0, 0, 200, 20], {}, [leaf]))).nodes;
  assert.equal(node.k, "p");
  assert.equal(node.t, "T");
  assert.deepEqual(node.box, [0, 0, 200, 20]);
  assert.equal(node.tx!.c, "Hello world");
  assert.deepEqual(node.tx!.ink, [0, 1, 70, 17]);

  const padded = el("p", [0, 0, 200, 28], { "padding-top": "4px", "padding-bottom": "4px" }, [run("Hello", [[0, 5, 40, 17]])], { text: TEXT });
  const nodes = buildTree(tree(el("div", [0, 0, 200, 28], {}, [padded]))).nodes;
  assert.deepEqual(nodes.map((n) => [n.k, n.t]), [["", "F"], ["p", "F"], ["p/#text", "T"]]);
  // The run's box is its line: 20px, its half-leading above the glyphs.
  assert.deepEqual(nodes[2].box, [0, 3.5, 40, 20]);
  // The root never becomes its text: its text is a child.
  assert.deepEqual(buildTree(tree(leaf)).nodes.map((n) => n.k), ["", "#text"]);
});

test("buildTree: a run that wraps starts where its first line does, whatever its leading and however many lines", () => {
  // A paragraph padded 10px: its text's line box starts at 10, as the
  // browser lays it out. Each line's 17px of glyphs sits mid-line.
  for (const [lh, lines] of [[20, 4], [22.75, 4], [22.75, 7], [28, 7]]) {
    const half = (lh - 17) / 2;
    const rects = Array.from({ length: lines }, (_, i): RawBox => [10, 10 + i * lh + half, 180, 17]);
    const p = el("p", [0, 0, 200, 20 + lh * lines], { "padding-top": "10px", "padding-bottom": "10px", "padding-left": "10px", "padding-right": "10px" },
      [run("words ".repeat(40), rects)], { text: { ...TEXT, "line-height": `${lh}px` } });
    const text = byKey(buildTree(tree(el("div", [0, 0, 200, 20 + lh * lines], {}, [p]))).nodes).get("p/#text")!;
    assert.equal(text.tx!.n, lines);
    assert.deepEqual(text.box, [10, 10, 180, Math.round(lh * lines * 100) / 100], `${lh}px x ${lines}`);
  }
  // A line pushed down by something taller beside it: the first line still says where the box starts.
  const pushed = el("p", [0, 0, 200, 50], { "padding-top": "10px" }, [run("a b", [[0, 11.5, 50, 17], [0, 35, 50, 17]])], { text: TEXT });
  assert.equal(byKey(buildTree(tree(el("div", [0, 0, 200, 50], {}, [pushed]))).nodes).get("p/#text")!.box[1], 10);
});

test("buildTree: a text keeps whitespace where white-space says to, and records how it is cut off", () => {
  const pre = el("pre", [0, 0, 100, 40], {}, [run("a  b\n c", [[0, 0, 30, 20], [0, 20, 20, 20]])], { text: { ...TEXT, "white-space": "pre" } });
  const node = buildTree(tree(el("div", [0, 0, 100, 40], {}, [pre]))).nodes[1];
  assert.equal(node.tx!.c, "a  b\n c");
  assert.equal(node.tx!.ws, "pre");
  assert.equal(node.tx!.n, 2);
  // pre-line keeps the breaks, not the spaces: the browser draws "x\ny z".
  const preLine = el("p", [0, 0, 100, 40], {}, [run(" x \n  y\t\tz ", [[0, 0, 10, 20], [0, 20, 30, 20]])], { text: { ...TEXT, "white-space": "pre-line" } });
  const lines = buildTree(tree(el("div", [0, 0, 100, 40], {}, [preLine]))).nodes[1];
  assert.deepEqual([lines.tx!.c, lines.tx!.ws], ["x\ny z", "pre-line"]);

  // A clamp clips, so its text stays a child of the box that clips it.
  const clamped = el("p", [0, 0, 100, 40], { "overflow-x": "hidden", "overflow-y": "hidden" }, [run("long", [[0, 0, 100, 20], [0, 20, 100, 20], [0, 40, 50, 20]])], {
    text: { ...TEXT, "-webkit-line-clamp": "2" },
  });
  const facts = byKey(buildTree(tree(el("div", [0, 0, 100, 40], {}, [clamped]))).nodes);
  assert.equal(facts.get("p")!.clip, 1);
  assert.equal(facts.get("p/#text")!.tx!.cl, 2);
  assert.equal(facts.get("p/#text")!.tx!.n, 3);
});

// --- Keys and paint order ------------------------------------------------------------

test("buildTree: keys are data-slot, else the tag, numbered among siblings in DOM order, whatever the paint order", () => {
  const root = el("div", [0, 0, 300, 40], { display: "flex" }, [
    el("div", [0, 0, 10, 10], { ...BORDER, position: "relative", "z-index": "2" }),
    el("div", [10, 0, 10, 10], BORDER),
    el("div", [20, 0, 10, 10], { ...BORDER, position: "relative", "z-index": "-1" }),
    el("span", [30, 0, 10, 10], { ...BORDER, position: "absolute" }),
    el("div", [40, 0, 10, 10], BORDER, [], { slot: "a/b" }),
    { k: "p", which: "before", cs: BORDER, content: "", box: [0, 0, 4, 4], how: "flow" },
    { k: "p", which: "after", cs: BORDER, content: "", box: [0, 0, 4, 4], how: "flow" },
  ]);
  const built = buildTree(tree(root));
  // Negative z, then what isn't positioned (::before first, ::after last
  // as the DOM has them), then positioned, then positive z.
  assert.deepEqual(built.nodes.map((n) => n.k), ["", "div:3", "div:2", "a∕b", "::before", "::after", "span", "div"]);
  assert.deepEqual(built.notes, ['data-slot="a/b" holds a "/", which separates a key\'s parts, so its key writes it as "∕" (U+2215)']);
  assert.deepEqual(byKey(built.nodes).get("div")!.S, { z: 2 });
});

test("buildTree: what makes a stacking context paints with the positioned, and a flex item's z-index counts though it isn't positioned", () => {
  const red = { ...BORDER, "background-color": "rgb(255, 0, 0)" };
  // A translucent box over the next one: Chrome paints it on top.
  const faded = buildTree(tree(el("div", [0, 0, 40, 20], {}, [el("div", [0, 0, 20, 20], { ...red, opacity: "0.5" }), el("div", [10, 0, 20, 20], red)]))).nodes;
  assert.deepEqual(faded.map((n) => n.k), ["", "div:2", "div"]);
  const contexts: Record<string, string>[] = [{ transform: "matrix(1, 0, 0, 1, 2, 0)" }, { filter: "blur(1px)" }, { isolation: "isolate" }, { "mix-blend-mode": "multiply" }];
  for (const cs of contexts) {
    const nodes = buildTree(tree(el("div", [0, 0, 40, 20], {}, [el("div", [0, 0, 20, 20], { ...red, ...cs }), el("div", [10, 0, 20, 20], red)]))).nodes;
    assert.deepEqual(nodes.map((n) => n.k), ["", "div:2", "div"], JSON.stringify(cs));
  }
  // In a flex row, z-index orders items that aren't positioned: 1 after the
  // rest, 0 with the positioned; in a block, it does nothing.
  const items = (display: string) => buildTree(tree(el("div", [0, 0, 60, 20], { display }, [
    el("div", [0, 0, 20, 20], { ...red, "z-index": "1" }),
    el("div", [20, 0, 20, 20], { ...red, "z-index": "0" }),
    el("div", [40, 0, 20, 20], red),
  ]))).nodes;
  const flex = items("flex");
  assert.deepEqual(flex.map((n) => [n.k, n.S?.z]), [["", undefined], ["div:3", undefined], ["div:2", 0], ["div", 1]]);
  assert.deepEqual(items("block").map((n) => [n.k, n.S?.z]), [["", undefined], ["div", undefined], ["div:2", undefined], ["div:3", undefined]]);
});

test("buildTree: a run of text between elements is its own node, in DOM order", () => {
  const root = el("p", [0, 0, 300, 20], { display: "block" }, [
    run("Read the ", [[0, 1, 60, 17]]),
    el("a", [60, 0, 30, 20], {}, [run("docs", [[60, 1, 30, 17]])], { text: TEXT }),
    run(" first.", [[90, 1, 40, 17]]),
  ], { text: TEXT });
  const { nodes } = buildTree(tree(root));
  assert.deepEqual(nodes.map((n) => n.k), ["", "#text", "a", "#text:2"]);
  assert.deepEqual(nodes.map((n) => n.tx?.c), [undefined, "Read the", "docs", "first."]);
});

// --- Facts --------------------------------------------------------------------------

test("buildTree: paint as the root's styles have it: hex colors, scaled radii, visible shadows, borders by side", () => {
  const card = el("div", [0, 0, 100, 40], {
    "background-color": "oklch(0.97 0 0)", "border-top-width": "2px", "border-top-color": "rgba(223, 34, 37, 0.3)",
    "border-top-left-radius": "3.35544e+07px", "border-top-right-radius": "3.35544e+07px", "border-bottom-right-radius": "3.35544e+07px", "border-bottom-left-radius": "3.35544e+07px",
    "box-shadow": "rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px", opacity: "0.5", "mix-blend-mode": "multiply",
    filter: "blur(4px)", "backdrop-filter": "blur(8px)", "outline-style": "solid", "outline-width": "2px", "outline-color": "rgb(0, 0, 0)", "outline-offset": "1px",
    visibility: "hidden", "clip-path": "inset(1px)", "overflow-x": "hidden", "background-clip": "padding-box",
  }, [], { cls: ["bg-muted", "hover:bg-accent/50", "border-destructive/30", "rounded-full", "bg-[#fff]", "p-2"] });
  const node = buildTree(tree(el("div", [0, 0, 100, 40], {}, [card]))).nodes[1];
  assert.deepEqual(node, {
    k: "div", t: "F", el: "div", box: [0, 0, 100, 40],
    bg: "#f5f5f5", bgc: "padding-box", bd: { w: [2, 0, 0, 0], s: "solid", c: "#df22254d" }, r: 20, sh: [[0, 1, 3, 0, "#0000001a"]], op: 0.5,
    bm: "multiply", clip: "x", fl: "blur(4px)", bf: "blur(8px)", ol: [2, "solid", "#000000", 1], vis: 0, cp: "inset(1px)",
    cls: ["bg-accent", "bg-muted", "border-destructive", "rounded-full"],
  });
  assert.equal(paintsOwnBox({ "background-color": "rgba(0, 0, 0, 0)" }), false);
  assert.equal(paintsOwnBox({ "border-left-width": "1px", "border-left-color": "rgba(0, 0, 0, 0)" }), true);
});

test("buildTree: a flex or grid container's layout, leaving CSS's defaults out", () => {
  const root = el("div", [0, 0, 300, 100], {
    display: "grid", "grid-template-columns": "[full-start] 100px 200px [full-end]", "grid-template-rows": "50px 50px",
    "justify-content": "space-between", "align-items": "center", "row-gap": "8px", "column-gap": "normal", "padding-top": "4px",
  }, [el("div", [0, 4, 100, 50], BORDER)]);
  assert.deepEqual(buildTree(tree(root)).nodes[0].L, { d: "grid", jc: "space-between", ai: "center", gap: [8, 0], pad: [4, 0, 0, 0], tracks: [2, 2] });
  const row = el("div", [0, 0, 300, 100], { display: "flex", "flex-direction": "column-reverse", "flex-wrap": "wrap" }, [
    el("div", [0, 0, 300, 50], { ...BORDER, "flex-grow": "1", "flex-basis": "0%", "align-self": "center", order: "2" }),
  ]);
  const built = buildTree(tree(row));
  assert.deepEqual(built.nodes[0].L, { d: "flex", dir: "column-reverse", wrap: 1 });
  assert.deepEqual(built.nodes[1].S, { grow: 1, basis: "0%", as: "center", order: 2 });
});

test("buildTree: under a rotation, a box is its element's own size, centered where it drew", () => {
  const turned = el("div", [-10, -10, 120, 120], { ...BORDER, transform: "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)" }, [], { size: [100, 100] });
  const moved = el("div", [5, 5, 10, 10], { ...BORDER, transform: "matrix(1, 0, 0, 1, 5, 5)" });
  const nodes = buildTree(tree(el("div", [0, 0, 100, 100], {}, [turned, moved]))).nodes;
  assert.deepEqual(nodes[1].box, [0, 0, 100, 100]);
  assert.equal(nodes[1].tf, "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)");
  assert.equal(nodes[1].approx, "transform");
  // A translation needs nothing: the box is where it drew.
  assert.equal(nodes[2].tf, undefined);
});

test("buildTree: a pseudo-element's box as the page found it, flagged where it can only be approximate", () => {
  const flow: RawTreePseudo = { k: "p", which: "before", cs: { "background-color": "rgb(0, 0, 0)" }, content: "", box: [0, 0, 8, 8], how: "flow", moved: true };
  const unanchored: RawTreePseudo = { k: "p", which: "after", cs: { position: "absolute", ...BORDER }, content: "", box: [0, 0, 20, 20], how: "abs", unanchored: true };
  const text: RawTreePseudo = { k: "p", which: "before", cs: {}, text: TEXT, content: "→", box: [0, 0, 10, 20], how: "flow" };
  const nodes = buildTree(tree(el("div", [0, 0, 20, 20], {}, [flow, unanchored]))).nodes;
  assert.equal(nodes[1].approx, "pseudo-stand-in");
  assert.equal(nodes[2].approx, "containing-block");
  const arrow = buildTree(tree(el("div", [0, 0, 20, 20], {}, [text]))).nodes[1];
  assert.equal(arrow.t, "T");
  assert.equal(arrow.tx!.c, "→");
  // Turned, it says so, as an element does; moved, its box says where.
  const turned: RawTreePseudo = { k: "p", which: "after", cs: { position: "absolute", ...BORDER, transform: "matrix(0, 1, -1, 0, 0, 0)" }, content: "", box: [5, 0, 10, 10], how: "abs" };
  const moved: RawTreePseudo = { ...turned, which: "before", cs: { ...turned.cs, transform: "matrix(1, 0, 0, 1, -5, 0)" } };
  const [, before, after] = buildTree(tree(el("div", [0, 0, 20, 20], { position: "relative" }, [moved, turned]))).nodes;
  assert.deepEqual([after.tf, after.approx], ["matrix(0, 1, -1, 0, 0, 0)", "transform"]);
  assert.deepEqual([before.tf, before.approx, before.box], [undefined, undefined, [5, 0, 10, 10]]);
});

test("buildTree: an SVG past the markup limit, or too big to read, is kept as a picture", () => {
  const big = el("svg", [0, 0, 400, 200], {}, [], { path: [0], svgElements: 5000 });
  const built = buildTree(tree(el("div", [0, 0, 400, 200], {}, [big])));
  assert.deepEqual(built.nodes[1], { k: "svg", t: "I", el: "svg", box: [0, 0, 400, 200], raster: 1 });
  assert.deepEqual(built.rasters, [{ key: "svg", path: [0], why: "svg" }]);
  const icon = raw("toggle").root.kids[0] as RawTreeElement;
  const limited = buildTree(tree(el("div", [0, 0, 36, 36], {}, [icon])), { maxSvgChars: 100 });
  assert.equal(limited.nodes[1].raster, 1);
  assert.deepEqual(limited.svg, {});
});

test("buildTree: a box that is only its background picture is an image waiting for its bytes", () => {
  const cover = el("div", [0, 0, 64, 64], {
    "background-image": 'url("https://example.test/a.png")', "background-repeat": "no-repeat", "background-size": "cover", "background-position": "50% 0%",
  }, [], { path: [0] });
  const built = buildTree(tree(el("div", [0, 0, 64, 64], {}, [cover])));
  assert.equal(built.nodes[1].t, "I");
  assert.equal(built.nodes[1].bgi, undefined);
  assert.deepEqual(built.images, [{ key: "div", path: [0], src: "https://example.test/a.png", natural: [0, 0], fit: "cover", position: "50% 0%", content: [64, 64] }]);
});

test("buildTree: any other url() background is a screenshot of its box, or, on a box with children, a frame that says it left the picture out", () => {
  const svg = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect fill='rgb(255,0,0)' width='10' height='10'/></svg>")`;
  const box = (cs: Record<string, string>, kids: RawTreeItem[] = []) => {
    const built = buildTree(tree(el("div", [0, 0, 64, 64], {}, [el("div", [0, 0, 64, 64], cs, kids, { path: [0] })])));
    return { node: built.nodes[1], images: built.images, rasters: built.rasters };
  };
  // A url whose quotes hold parentheses and commas is still one picture,
  // drawn at the size it is given.
  const icon = box({ "background-image": svg, "background-repeat": "no-repeat", "background-size": "16px 16px", "background-position": "50% 50%" });
  assert.equal(icon.node.t, "I");
  assert.deepEqual(icon.images.map((i) => [i.src, i.fit]), [["data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect fill='rgb(255,0,0)' width='10' height='10'/></svg>", "16px 16px"]]);
  // Covering the box, its tiling never shows: tailwind's bg-cover without bg-no-repeat.
  assert.equal(box({ "background-image": 'url("a.png")', "background-size": "cover" }).node.t, "I");
  // Tiled, or one of several layers: a screenshot of the box.
  for (const cs of [
    { "background-image": 'url("a.png")', "background-repeat": "repeat", "background-size": "16px 16px" },
    { "background-image": 'linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 0)), url("a.png")', "background-repeat": "no-repeat, no-repeat", "background-size": "cover" },
  ]) {
    const tiled = box(cs);
    assert.deepEqual([tiled.node.t, tiled.node.raster, tiled.node.bgi, tiled.images], ["I", 1, undefined, []], JSON.stringify(cs));
    assert.deepEqual(tiled.rasters, [{ key: "div", path: [0], why: "background-image" }]);
  }
  // Holding children, which a screenshot would bake in: a frame, its
  // gradient kept, the url() left out and said to be.
  const holder = box({ "background-image": `linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 0)), ${svg}`, "background-repeat": "no-repeat" }, [el("span", [8, 8, 16, 16], BORDER)]);
  assert.deepEqual([holder.node.t, holder.node.bgi, holder.node.approx, holder.images, holder.rasters], ["F", "linear-gradient(#000000, #00000000)", "background-image", [], []]);
});

test("lineBox and lineCount: a run's line box from its glyphs, and its lines counted by top", () => {
  assert.deepEqual(lineBox([10, 21.5, 50, 17], 1, 20), [10, 20, 50, 20]);
  // Two lines of 17px glyphs 20px apart cover 37px: the first line's
  // half-leading starts 1.5px above them, not 0.75.
  assert.deepEqual(lineBox([0, 1, 50, 37], 2, 20), [0, -0.5, 50, 40]);
  assert.deepEqual(lineBox([0, 1, 50, 37], 2, 20, 17), [0, -0.5, 50, 40]);
  assert.deepEqual(lineBox([0, 0, 50, 15], 1, "normal"), [0, 0, 50, 15]);
  assert.equal(firstLineHeight([[0, 20, 10, 17], [0, 0.5, 30, 18], [30, 0, 10, 17]]), 18);
  assert.equal(lineCount([[0, 0, 10, 17], [10, 0.6, 10, 17], [0, 20, 10, 17]]), 2);
  assert.equal(lineCount([]), 1);
});

test("buildTree: a text or icon takes the text color class of the nearest element around it, a wrapper collapsed away included", () => {
  // card (text-card-foreground) > div (text-muted-foreground, collapsed) > p (padded) > text
  const p = el("p", [0, 0, 200, 40], { "padding-top": "10px" }, [run("Muted", [[0, 11.5, 40, 17]])], { text: TEXT });
  const muted = el("div", [0, 0, 200, 40], {}, [p], { cls: ["text-muted-foreground", "text-sm"] });
  const icon = el("svg", [0, 0, 16, 16], {}, [], { svg: { tag: "svg", attrs: {}, kids: [] }, shapes: [] });
  const iconWrapper = el("span", [0, 0, 16, 16], {}, [icon], { cls: ["hover:text-accent-foreground", "text-destructive"] });
  const card = el("div", [0, 0, 200, 80], { display: "flex" }, [muted, iconWrapper], { cls: ["text-card-foreground"] });
  const nodes = byKey(buildTree(tree(card)).nodes);
  assert.deepEqual(nodes.get("p/#text")!.cls, ["text-muted-foreground"]);
  // The icon's own wrapper sets its color always; its state class only names a state.
  assert.deepEqual(nodes.get("svg")!.cls, ["text-destructive"]);
});

test("classEvidence: the utilities that name a paint's token, variant prefixes and opacity cut off, at most 8", () => {
  assert.deepEqual(
    classEvidence(["bg-primary", "data-[state=checked]:bg-primary", "hover:bg-primary/90", "text-primary-foreground", "dark:bg-input/30", "bg-[#fff]", "p-2", "rounded-md", "[&_svg]:text-x"]),
    ["bg-input", "bg-primary", "rounded-md", "text-primary-foreground", "text-x"],
  );
  const many = ["bg-a", "bg-b", "bg-c", "bg-d", "bg-e", "bg-f", "bg-g", "hover:bg-h", "bg-i"];
  // The unprefixed first when there are more than 8.
  assert.deepEqual(classEvidence(many), ["bg-a", "bg-b", "bg-c", "bg-d", "bg-e", "bg-f", "bg-g", "bg-i"]);
});

// --- Limits -------------------------------------------------------------------------

test("buildTree: a story of 1,000 elements keeps the first 400 and says where it stopped", () => {
  const kids = Array.from({ length: 1000 }, (_, i) => el("div", [0, i * 10, 10, 10], BORDER));
  const built = buildTree(tree(el("div", [0, 0, 10, 10000], {}, kids)));
  assert.equal(built.nodes.length, 400);
  assert.deepEqual(built.truncated, { nodes: 1001, at: "div:400" });
});

test("buildTree: a subtree deeper than 24 levels is dropped from there on", () => {
  let inner = el("div", [0, 0, 10, 10], BORDER);
  for (let depth = 0; depth < 30; depth++) inner = el("div", [0, 0, 10, 10], BORDER, [inner]);
  const built = buildTree(tree(inner));
  assert.equal(built.nodes.length, 25);
  assert.equal(built.truncated!.nodes, 31);
  assert.equal(built.truncated!.at.split("/").length, 25);
});

test("buildTree: where the page stopped reading, the tree says it was cut there", () => {
  const built = buildTree(tree(el("div", [0, 0, 10, 10], {}, [el("div", [0, 0, 10, 10], BORDER), { k: "cut" }])));
  assert.deepEqual(built.nodes.map((n) => n.k), ["", "div"]);
  assert.deepEqual(built.truncated, { nodes: 2, at: "…" });
});

test("countInnerElements: how many elements a tree would hold, without its root, for --root-only", () => {
  assert.equal(countInnerElements(raw("card")), 22);
  assert.equal(countInnerElements(raw("switch")), 1);
});

// --- Writing ------------------------------------------------------------------------

test("stylesJsonText: each tree node on one line, keys sorted; without trees, JSON.stringify's text", () => {
  const plain = { version: 1, components: [{ name: "A", variants: [{ slug: "default", delta: {}, treeDelta: undefined }] }] };
  assert.equal(stylesJsonText(plain), `${JSON.stringify(plain, null, 2)}\n`);

  const withTree = {
    version: 1,
    components: [{
      name: "Switch",
      variants: [{ slug: "a", delta: {} }, { slug: "b", delta: { width: 24 }, treeDelta: { set: { "switch-thumb": { r: 6, box: [1, 1, 12, 12] } } } }],
      tree: { version: 1, base: [{ t: "F", k: "", el: "span", box: [0, 0, 32, 18.39] }, { k: "switch-thumb", t: "F", el: "span", box: [1, 1.19, 16, 16], bg: "#ffffff" }], assets: { svg: {}, img: {} } },
    }],
  };
  const text = stylesJsonText(withTree as never);
  assert.match(text, /\n {10}\{"box":\[0,0,32,18\.39\],"el":"span","k":"","t":"F"\},\n/);
  assert.match(text, /\n {14}"switch-thumb": \{"box":\[1,1,12,12\],"r":6\}\n/);
  assert.deepEqual(JSON.parse(text), withTree);
});

test("buildTree: a child with flex facts of its own keeps them under a wrapper; one out of the flow in a wrapper is out of it", () => {
  const button = el("button", [8, 8, 24, 24], { ...BORDER, "flex-shrink": "0" });
  const actions = el("div", [8, 8, 24, 24], { position: "relative", "z-index": "20", "flex-grow": "1" }, [button]);
  const [, node] = buildTree(tree(el("div", [0, 0, 40, 40], { display: "flex" }, [actions]))).nodes;
  assert.deepEqual(node.S, { shrink: 0, z: 20 });
  assert.equal(node.abs, undefined);
  const floating = el("div", [8, 8, 24, 24], { position: "absolute" }, [el("span", [8, 8, 24, 24], { ...BORDER, position: "relative" })]);
  assert.equal(buildTree(tree(el("div", [0, 0, 40, 40], {}, [floating]))).nodes[1].abs, 1);
});
