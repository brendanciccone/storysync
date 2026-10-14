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

test("buildTree: a text snap drew in a stand-in records the family Figma sets it in, and the one the code asked for", () => {
  const stack = '"storysync Inter", ui-sans-serif, system-ui, sans-serif';
  const label = el("span", [0, 0, 40, 20], {}, [run("Home", [[0, 1.5, 39.05, 17]])], { text: { ...TEXT, "font-family": stack } });
  const { nodes } = buildTree(tree(el("div", [0, 0, 40, 20], { display: "flex" }, [label]), {
    [stack]: { families: ["storysync Inter", "ui-sans-serif", "system-ui", "sans-serif"], applied: [true, false, null, null] },
  }));
  const tx = nodes.find((n) => n.tx)!.tx!;
  assert.deepEqual([tx.f, tx.fs, tx.fk, tx.fa], ["Inter", "system-ui", undefined, undefined]);
  // As before the stand-ins, where snap drew none.
  const plain = 'ui-sans-serif, system-ui, sans-serif';
  const { nodes: before } = buildTree(tree(el("div", [0, 0, 40, 20], { display: "flex" }, [el("span", [0, 0, 40, 20], {}, [run("Home", [[0, 1.5, 38.25, 17]])], { text: { ...TEXT, "font-family": plain } })]), {
    [plain]: { families: ["ui-sans-serif", "system-ui", "sans-serif"], applied: [false, null, null] },
  }));
  const old = before.find((n) => n.tx)!.tx!;
  assert.deepEqual([old.f, old.fs, old.fk], ["system-ui", undefined, 1]);
  // And where the page couldn't probe the stack, by the name Figma has the stand-in under, never snap's own.
  const { nodes: unprobed } = buildTree(tree(el("div", [0, 0, 40, 20], { display: "flex" }, [label])));
  const bare = unprobed.find((n) => n.tx)!.tx!;
  assert.deepEqual([bare.f, bare.fs, bare.fk, bare.fa], ["Inter", "ui-sans-serif", undefined, undefined]);
  // Inter's stack as snap sets it, its other scripts a second family of snap's (fonts.ts), read past too.
  const both = '"storysync Inter", "storysync Inter scripts", ui-sans-serif, system-ui, sans-serif';
  const scripts = el("span", [0, 0, 40, 20], {}, [run("Home", [[0, 1.5, 39.05, 17]])], { text: { ...TEXT, "font-family": both } });
  const { nodes: unprobedBoth } = buildTree(tree(el("div", [0, 0, 40, 20], { display: "flex" }, [scripts])));
  const second = unprobedBoth.find((n) => n.tx)!.tx!;
  assert.deepEqual([second.f, second.fs], ["Inter", "ui-sans-serif"]);
});

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
      delete node.nocls;
      if (node.S) {
        delete node.S.basis;
        if (!Object.keys(node.S).length) delete node.S;
      }
      return node;
    });
    // A box that holds text is now rounded up (S14), where the fixtures rounded to the nearest 0.01: up to 0.01 wider.
    const was = new Map(theirs.map((t) => [t.k, t]));
    for (const node of ours) {
      const width = was.get(node.k)?.box[2];
      if (width !== undefined && node.box[2] > width && node.box[2] - width <= 0.0100001) node.box = [node.box[0], node.box[1], width, node.box[3]];
    }
    assert.equal(canonicalJson(ours), canonicalJson(theirs), name);
  }
});

test("buildTree: a box that holds text is rounded up to 0.01, never narrower than the text; any other to the nearest", () => {
  const label = el("div", [0, 0, 106.23036, 20.004], { display: "flex" }, [run("design-system.zip", [[0, 1.5, 106.23036, 17]])], { text: TEXT });
  const nodes = buildTree(tree(el("div", [0, 0, 120.004, 40.006], { display: "flex", "background-color": "rgb(255, 0, 0)" }, [
    label, el("div", [106.23036, 0, 13.77364, 40.006], { "background-color": "rgb(0, 0, 255)" }),
  ]))).nodes;
  const box = (k: string) => nodes.find((n) => n.k === k)!.box;
  // The root holds the label: 120.01, its height to the nearest.
  assert.deepEqual(box(""), [0, 0, 120.01, 40.01]);
  assert.deepEqual(box("div").slice(2), [106.24, 20]);
  // A box without text, to the nearest, and float noise taken off first.
  assert.deepEqual(box("div:2").slice(2), [13.77, 40.01]);
  const exact = buildTree(tree(el("div", [0, 0, 139.39999999999998, 20], { display: "flex" }, [run("x", [[0, 0, 139.40000000000003, 20]])], { text: TEXT }))).nodes;
  assert.equal(exact[0].box[2], 139.4);
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
    // sr-only by a clip path rather than overflow: as hidden.
    el("span", [0, 0, 1, 1], { position: "absolute", "clip-path": "inset(50%)" }, [run("Open", [[0, 0, 1, 1]])], { text: TEXT }),
    // Kept: in the flow, drawing nothing, but taking room.
    el("div", [20, 0, 30, 40]),
  ]);
  const { nodes } = buildTree(tree(root));
  assert.deepEqual(nodes.map((n) => n.k), ["", "div"]);
  assert.deepEqual(nodes[1].box, [20, 0, 30, 40]);
  // Out of the flow, drawing only a shadow: it draws.
  const glow = el("div", [0, 0, 10, 10], { position: "absolute", "box-shadow": "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px" });
  assert.deepEqual(buildTree(tree(el("div", [0, 0, 100, 40], {}, [glow]))).nodes.map((n) => [n.k, n.sh]), [["", undefined], ["div", [[0, 1, 3, 0, "#0000001a"]]]]);
});

/** A capture with every box under the root's child `slot` moved by `dx`, as the page would have read it there. */
function moved(capture: RawTreeCapture, slot: string, dx: number): RawTreeCapture {
  const out = JSON.parse(JSON.stringify(capture)) as RawTreeCapture;
  const shift = (item: RawTreeItem) => {
    if (item.k === "e" || item.k === "p") item.box[0] += dx;
    if (item.k === "t") for (const r of item.rects) r[0] += dx;
    if (item.k === "e") item.kids.forEach(shift);
  };
  shift(out.root.kids.find((k) => k.k === "e" && k.slot === slot)!);
  return out;
}

test("buildTree: an element placed against the window or page, drawn outside the root, is measured inside the root's box", () => {
  // shadcn's Sidebar at side=right: its container is `fixed` at `right-0`,
  // so in snap's 1280px window it drew 1024px right of its 256px root,
  // and the Figma component held it off to its side.
  const left = buildTree(raw("sidebar"));
  const right = buildTree(moved(raw("sidebar"), "sidebar-container", 1024));
  assert.deepEqual(byKey(left.nodes).get("sidebar-container")!.box, [0, 0, 256, 720]);
  assert.deepEqual(byKey(right.nodes).get("sidebar-container")!.box, [0, 0, 256, 720]);
  // Everything in it is where it was in it: the same tree as at side=left.
  assert.equal(canonicalJson(right.nodes), canonicalJson(left.nodes));
  // Recorded, not warned about: there is nothing to fix.
  assert.deepEqual([left.notes, left.movedInside], [[], []]);
  assert.deepEqual([right.notes, right.movedInside], [[], ["sidebar-container"]]);

  // Such elements move together, only as far as it takes: a window-wide
  // overlay stays at the root's corner, and the panel keeps its place on it.
  const overlay = el("div", [-40, -10, 1280, 720], { position: "fixed", "background-color": "rgba(0, 0, 0, 0.5)" });
  const panel = el("div", [880, -10, 360, 720], { position: "fixed", "background-color": "rgb(255, 255, 255)" });
  const sheet = buildTree(tree(el("div", [0, 0, 100, 40], {}, [el("button", [0, 0, 100, 40], BORDER), overlay, panel])));
  assert.deepEqual(sheet.nodes.map((n) => [n.k, n.box]), [["", [0, 0, 100, 40]], ["button", [0, 0, 100, 40]], ["div", [0, 0, 1280, 720]], ["div:2", [920, 0, 360, 720]]]);
  assert.deepEqual(sheet.movedInside, ["div", "div:2"]);
  // One inside the box that moves only along with one outside it is not recorded as drawing outside.
  const dot = (box: RawBox) => el("span", box, { position: "fixed", "background-color": "rgb(255, 0, 0)" });
  const along = buildTree(tree(el("div", [0, 0, 100, 40], {}, [dot([-20, 0, 10, 10]), dot([50, 10, 10, 10])])));
  assert.deepEqual([along.nodes.map((n) => n.box), along.movedInside], [[[0, 0, 100, 40], [0, 0, 10, 10], [70, 10, 10, 10]], ["span"]]);

  // Placed by something in the tree, it stays where it drew, inside the box or out.
  const badge = (cs: Record<string, string>) => el("span", [0, 0, 40, 40], cs, [el("span", [36, -6, 10, 10], { position: "absolute", "background-color": "rgb(255, 0, 0)" })]);
  for (const holder of [{ position: "relative" }, { transform: "matrix(1, 0, 0, 1, 0, 0.5)" }] as Record<string, string>[]) {
    assert.deepEqual(buildTree(tree(badge(holder))).nodes[1].box, [36, -6, 10, 10], JSON.stringify(holder));
  }
  // An absolute one placed by nothing in the tree moves in, as a fixed one does.
  const loose = buildTree(tree(badge({})));
  assert.deepEqual([loose.nodes[1].box, loose.notes, loose.movedInside], [[30, 0, 10, 10], [], ["span"]]);
  // A fixed one in a transformed element is placed by it.
  const inTransform = el("div", [0, 0, 40, 40], { transform: "matrix(1, 0, 0, 1, 0, 0.5)" }, [el("span", [600, 0, 10, 10], { position: "fixed", "background-color": "rgb(255, 0, 0)" })]);
  assert.deepEqual(buildTree(tree(inTransform)).nodes[1].box, [600, 0, 10, 10]);
});

test("buildTree: an overlay's content keeps an absolute element where the element around it that places it drew it, as a tooltip's arrow", () => {
  // Radix's Tooltip: the content isn't positioned, and its arrow is
  // `absolute`, placed by the popper wrapper around the content, which is
  // `fixed` and translated. It pokes 5px out below the 28px bubble.
  const arrow = el("span", [45, 28, 10, 10], { position: "absolute", "background-color": "rgb(23, 23, 23)" });
  const bubble = () => tree(el("div", [0, 0, 100.94, 28], { "background-color": "rgb(23, 23, 23)" }, [structuredClone(arrow)]));
  const wrapper = { position: "fixed", transform: "matrix(1, 0, 0, 1, 590, 300)" };
  const placed = buildTree({ ...bubble(), around: [wrapper] });
  assert.deepEqual([placed.nodes[1].box, placed.nodes[1].abs, placed.movedInside], [[45, 28, 10, 10], 1, []]);
  // Base UI's positioner is `absolute`, and a `relative` element places one as well.
  for (const holder of [{ position: "absolute" }, {}, { position: "relative" }] as Record<string, string>[]) {
    assert.deepEqual(buildTree({ ...bubble(), around: [{}, holder] }).nodes[1].box, Object.keys(holder).length ? [45, 28, 10, 10] : [45, 18, 10, 10], JSON.stringify(holder));
  }
  // Without what is around it, as for any root but an overlay's, it is moved inside the root.
  const alone = buildTree(bubble());
  assert.deepEqual([alone.nodes[1].box, alone.movedInside], [[45, 18, 10, 10], ["span"]]);
  // A `fixed` one is placed only by what holds fixed elements: not by a `relative` element.
  const fixed = () => tree(el("div", [0, 0, 100, 28], {}, [el("span", [600, 0, 10, 10], { position: "fixed", "background-color": "rgb(255, 0, 0)" })]));
  assert.deepEqual(buildTree({ ...fixed(), around: [{ position: "relative" }] }).nodes[1].box, [90, 0, 10, 10]);
  assert.deepEqual(buildTree({ ...fixed(), around: [wrapper] }).nodes[1].box, [600, 0, 10, 10]);
});

test("buildTree: a fixed or absolute element in one that translate, will-change, containment and the like make its containing block stays where it drew", () => {
  // Base UI's Slider: the thumb is at `translate: -50% -50%`, its input
  // `fixed` at the thumb's corner, where Chrome draws it. Read as placed
  // against the window, the input moved 5px down, with a warning.
  const slider = buildTree(raw("slider"));
  assert.deepEqual(byKey(slider.nodes).get("div/slider-thumb/input")!.box, [0, 0, 14, 14]);
  assert.deepEqual([slider.notes, slider.movedInside], [[], []]);

  // What Chromium 154 draws a fixed and an absolute element in as their
  // containing block, and what it doesn't, each checked in the browser.
  const holds: Record<string, string>[] = [
    { translate: "-50% -50%" }, { translate: "0px" }, { rotate: "0deg" }, { scale: "1" }, { perspective: "100px" }, { "offset-path": 'path("M 0 0")' },
    { "will-change": "transform" }, { "will-change": "opacity, filter" }, { "will-change": "contain" }, { "will-change": "transform-style" },
    { contain: "paint" }, { contain: "layout" }, { contain: "content" }, { contain: "strict" }, { contain: "inline-size layout" },
    { "content-visibility": "auto" }, { "content-visibility": "hidden" }, { "transform-style": "preserve-3d" },
  ];
  const not: Record<string, string>[] = [{ "will-change": "opacity" }, { "will-change": "top" }, { contain: "size" }, { contain: "style" }, { isolation: "isolate" }, { "clip-path": "inset(0px)" }];
  for (const position of ["fixed", "absolute"]) {
    const holder = (cs: Record<string, string>) =>
      tree(el("span", [0, 0, 40, 40], cs, [el("span", [36, -6, 10, 10], { position, "background-color": "rgb(255, 0, 0)" })]));
    for (const cs of holds) assert.deepEqual(buildTree(holder(cs)).nodes[1].box, [36, -6, 10, 10], `${position} in ${JSON.stringify(cs)}`);
    for (const cs of not) assert.deepEqual(buildTree(holder(cs)).nodes[1].box, [30, 0, 10, 10], `${position} in ${JSON.stringify(cs)}`);
  }
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
  // Centered, or at the end, its glyphs are where text-align puts them.
  for (const [align, x] of [["center", 68.75], ["right", 137.5], ["end", 137.5]] as const) {
    const aligned = el("input", [0, 0, 200, 36], { ...BORDER, "padding-left": "12px", "padding-right": "12px" }, [], {
      text: { ...TEXT, "text-align": align }, input: { type: "text", value: "Email", placeholder: "", advance: 36.5 },
    });
    const ink = byKey(buildTree(tree(el("div", [0, 0, 200, 36], {}, [aligned]))).nodes).get("input/#value")!.tx!.ink;
    assert.deepEqual(ink, [x, 0, 36.5, 34], align);
  }
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
  // One that clips, pads, fades, turns, blends, filters or isolates what it holds stays.
  const keeping: Record<string, string>[] = [
    { "overflow-x": "hidden", "overflow-y": "hidden" }, { "padding-top": "2px" }, { opacity: "0.5" }, { transform: "matrix(0.5, 0, 0, 0.5, 0, 0)" },
    { "mix-blend-mode": "multiply" }, { filter: "blur(1px)" }, { "backdrop-filter": "blur(1px)" }, { "clip-path": "inset(1px)" }, { isolation: "isolate" },
    { visibility: "hidden" },
  ];
  for (const cs of keeping) {
    const kept = el("span", [8, 8, 16, 16], cs, [icon]);
    assert.equal(buildTree(tree(el("div", [0, 0, 32, 32], {}, [kept]))).nodes.length, 3, JSON.stringify(cs));
  }
  // One bigger than its child, centering it, stays: the child's place in it is a fact.
  const roomy = el("span", [4, 4, 24, 24], { display: "flex", "justify-content": "center", "align-items": "center" }, [icon]);
  assert.deepEqual(buildTree(tree(el("div", [0, 0, 32, 32], {}, [roomy]))).nodes.map((n) => [n.k, n.box]), [["", [0, 0, 32, 32]], ["span", [4, 4, 24, 24]], ["span/span", [4, 4, 16, 16]]]);
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
  // Centered by its flex or grid layout, not its own box: a frame, keeping
  // the layout that centers its text. At the start, it is the text.
  const centered = (cs: Record<string, string>) => buildTree(tree(el("div", [0, 0, 200, 40], {}, [
    el("span", [0, 0, 200, 40], cs, [run("Go", [[90, 11.5, 20, 17]])], { text: TEXT }),
  ]))).nodes.slice(1).map((n) => [n.k, n.t, n.L?.jc ?? n.L?.ai]);
  assert.deepEqual(centered({ display: "flex", "justify-content": "center", "align-items": "center" }), [["span", "F", "center"], ["span/#text", "T", undefined]]);
  assert.deepEqual(centered({ display: "grid", "align-items": "end" }), [["span", "F", "end"], ["span/#text", "T", undefined]]);
  // At the start, a box its lines' height, it is the text.
  const atStart = buildTree(tree(el("div", [0, 0, 200, 40], {}, [
    el("span", [0, 0, 200, 20], { display: "flex", "align-items": "stretch" }, [run("Go", [[0, 1.5, 20, 17]])], { text: TEXT }),
  ]))).nodes.slice(1).map((n) => [n.k, n.t]);
  assert.deepEqual(atStart, [["span", "T"]]);
});

test("buildTree: an element taller than its text's lines stays a frame, its text's line box where the browser drew it", () => {
  // A dialog's Cancel, a <button> with no padding stretched to its 36px
  // footer: the button centers its label without flex. As a text node 36
  // tall, Figma set it at the top, 20 tall.
  const cancel = el("button", [246.83, 0, 45.57, 36], { display: "block" }, [run("Cancel", [[246.83, 9.5, 45.56, 17]])], { text: TEXT });
  const nodes = buildTree(tree(el("div", [0, 0, 400, 36], { display: "flex" }, [cancel]))).nodes;
  assert.deepEqual(nodes.map((n) => [n.k, n.t]), [["", "F"], ["button", "F"], ["button/#text", "T"]]);
  assert.deepEqual(nodes[1].box, [246.83, 0, 45.57, 36]);
  assert.deepEqual(nodes[2].box, [0, 8, 45.56, 20]);
  // Its text at the top of a box taller than its line, as a min-height gives it: a frame too.
  const tall = el("p", [0, 0, 200, 40], {}, [run("Hello", [[0, 1.5, 40, 17]])], { text: TEXT });
  assert.deepEqual(buildTree(tree(el("div", [0, 0, 200, 40], {}, [tall]))).nodes.map((n) => [n.k, n.t]), [["", "F"], ["p", "F"], ["p/#text", "T"]]);
  // Within Chrome's rounding of the half-leading, a pixel, it is the text.
  const rounded = el("p", [0, 0, 200, 21], {}, [run("Hello", [[0, 2, 40, 17]])], { text: TEXT });
  assert.deepEqual(buildTree(tree(el("div", [0, 0, 200, 21], {}, [rounded]))).nodes.map((n) => [n.k, n.t]), [["", "F"], ["p", "T"]]);
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

  // Hidden with its element, a text says so too: CSS lets a child show it again.
  const hidden = el("p", [0, 0, 100, 28], { "padding-top": "4px", visibility: "hidden" }, [run("Hidden", [[0, 5.5, 40, 17]])], { text: TEXT });
  const hiddenNodes = byKey(buildTree(tree(el("div", [0, 0, 100, 28], {}, [hidden]))).nodes);
  assert.deepEqual([hiddenNodes.get("p")!.vis, hiddenNodes.get("p/#text")!.vis], [0, 0]);

  // A clamp clips, so its text stays a child of the box that clips it.
  const clamped = el("p", [0, 0, 100, 40], { "overflow-x": "hidden", "overflow-y": "hidden" }, [run("long", [[0, 0, 100, 20], [0, 20, 100, 20], [0, 40, 50, 20]])], {
    text: { ...TEXT, "-webkit-line-clamp": "2" },
  });
  const facts = byKey(buildTree(tree(el("div", [0, 0, 100, 40], {}, [clamped]))).nodes);
  assert.equal(facts.get("p")!.clip, 1);
  assert.equal(facts.get("p/#text")!.tx!.cl, 2);
  assert.equal(facts.get("p/#text")!.tx!.n, 3);

  // Where the browser chose the line breaks, text-wrap-style says how.
  const wrapped = (style: string) => byKey(buildTree(tree(el("div", [0, 0, 100, 40], {}, [
    el("p", [0, 0, 100, 40], {}, [run("two lines", [[0, 0, 60, 20], [0, 20, 50, 20]])], { text: { ...TEXT, "text-wrap-style": style } }),
  ]))).nodes).get("p")!.tx!.tw;
  assert.deepEqual([wrapped("balance"), wrapped("pretty"), wrapped("auto"), wrapped("stable")], ["balance", "pretty", undefined, undefined]);
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

test("buildTree: a rotate or scale set on its own turns an element as a transform does, as Tailwind 4's rotate-45 turns a tooltip's arrow", () => {
  // The registry's Tooltip arrow: a 10px svg at `rotate: 45deg`, which
  // `transform` doesn't show. Read as unturned, it was a 14.14px square.
  const arrow = el("svg", [-2.07, -9.07, 14.14, 14.14], { "background-color": "rgb(10, 10, 10)", rotate: "45deg" }, [], { size: [10, 10], shapes: [[0, 0, 14.14, 14.14]] });
  const [, turned] = buildTree(tree(el("span", [0, 0, 10, 10], {}, [arrow]))).nodes;
  assert.deepEqual([turned.tf, turned.approx, turned.box], ["rotate: 45deg", "transform", [0, -7, 10, 10]]);
  const scaled = el("div", [-5, -5, 30, 30], { ...BORDER, scale: "1.5", transform: "matrix(1, 0, 0, 1, 2, 0)" }, [], { size: [20, 20] });
  assert.deepEqual(buildTree(tree(el("div", [0, 0, 20, 20], {}, [scaled]))).nodes[1].tf, "scale: 1.5");
  const both = el("div", [0, 0, 20, 20], { ...BORDER, rotate: "90deg", transform: "matrix(2, 0, 0, 2, 0, 0)" }, [], { size: [10, 10] });
  assert.equal(buildTree(tree(el("div", [0, 0, 20, 20], {}, [both]))).nodes[1].tf, "matrix(2, 0, 0, 2, 0, 0); rotate: 90deg");
  // Turned by nothing, nothing is said.
  for (const cs of [{ rotate: "0deg" }, { scale: "1" }, { scale: "1 1" }] as Record<string, string>[]) {
    assert.equal(buildTree(tree(el("div", [0, 0, 20, 20], {}, [el("div", [0, 0, 10, 10], { ...BORDER, ...cs })]))).nodes[1].tf, undefined, JSON.stringify(cs));
  }
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
  // Covering the box, its tiling never shows: Tailwind's bg-cover without bg-no-repeat is a picture, not a screenshot.
  const cover = box({ "background-image": 'url("a.png")', "background-repeat": "repeat", "background-size": "cover" });
  assert.deepEqual([cover.node.t, cover.node.raster, cover.images.map((i) => i.src), cover.rasters], ["I", undefined, ["a.png"], []]);
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
  // The icon's own wrapper sets its color always, and its state class names
  // the color in that state, which may be the one measured: the value picks.
  assert.deepEqual(nodes.get("svg")!.cls, ["text-accent-foreground", "text-destructive"]);
});

test("buildTree: past the root, a text takes the text color class of the elements around it, those inside nearer", () => {
  // A story's wrapper sets text-muted-foreground around a root that sets none.
  const title = el("h2", [0, 0, 200, 20], {}, [run("Title", [[0, 1.5, 40, 17]])], { text: TEXT });
  const own = el("p", [0, 20, 200, 20], {}, [run("Own", [[0, 21.5, 40, 17]])], { text: TEXT, cls: ["text-destructive"] });
  const root = el("div", [0, 0, 200, 40], { display: "flex" }, [title, own]);
  const outer = [["hover:text-primary"], [], ["text-muted-foreground", "bg-background"]];
  const nodes = byKey(buildTree({ ...tree(root), outer }).nodes);
  assert.deepEqual(nodes.get("h2")!.cls, ["text-muted-foreground"]);
  assert.deepEqual(nodes.get("p")!.cls, ["text-destructive"]);
  // None around it, as in a portal: nothing, and figma code takes the base styles.
  assert.equal(byKey(buildTree(tree(root)).nodes).get("h2")!.cls, undefined);
});

test("classEvidence: the utilities that name a paint's token, variant prefixes and opacity cut off but a dark: one's, every one", () => {
  assert.deepEqual(
    classEvidence(["bg-primary", "data-[state=checked]:bg-primary", "hover:bg-primary/90", "text-primary-foreground", "dark:bg-input/30", "bg-[#fff]", "p-2", "rounded-md", "[&_svg]:text-x", "bg-muted/[.5]"]),
    // `[&_svg]:text-x` colors the svg inside, not the element: no evidence of its own.
    ["bg-muted", "bg-primary", "dark:bg-input/30", "rounded-md", "text-primary-foreground"],
  );
  // shadcn/ui's destructive Button: the dark theme paints destructive at
  // 20%, which snap, measuring the light theme, sees only in the class.
  assert.deepEqual(classEvidence(["bg-destructive/10", "hover:bg-destructive/20", "dark:bg-destructive/20", "dark:bg-muted/[.25]", "text-destructive", "dark:hover:bg-destructive/30"], { "dark:hover:bg-destructive/30": false }),
    ["bg-destructive", "dark:bg-destructive/20", "dark:bg-muted/[.25]", "text-destructive"]);
  // An outline button's: past 8, the dark:border-input that names its border in Dark mode is kept.
  const outline = ["focus-visible:border-ring", "focus-visible:ring-ring/50", "aria-invalid:ring-destructive/20", "aria-invalid:border-destructive",
    "rounded-md", "border", "bg-background", "shadow-xs", "hover:bg-accent", "hover:text-accent-foreground", "dark:bg-input/30", "dark:border-input", "text-sm"];
  assert.deepEqual(classEvidence(outline), ["bg-accent", "bg-background", "border-destructive", "border-ring", "dark:bg-input/30", "dark:border-input",
    "ring-destructive", "ring-ring", "rounded-md", "shadow-xs", "text-accent-foreground", "text-sm"]);
});

test("classEvidence and buildTree: a dark: prefix alone stays, naming the token the dark theme paints", () => {
  // dark: alone is the dark theme's color; with a state the page found
  // doesn't apply, not hovered, a state's.
  assert.deepEqual(classEvidence(["border-border", "dark:border-input", "dark:hover:bg-input/50", "hover:dark:bg-muted", "!dark:text-x"], { "dark:hover:bg-input/50": false, "hover:dark:bg-muted": false }),
    ["bg-input", "bg-muted", "border-border", "dark:border-input", "dark:text-x"]);
  // A text takes the dark theme's color with the one it inherits.
  const p = el("p", [0, 0, 200, 20], {}, [run("Muted", [[0, 1.5, 40, 17]])], { text: TEXT });
  const card = el("div", [0, 0, 200, 20], { display: "flex" }, [p], { cls: ["text-foreground", "dark:text-muted-foreground", "dark:bg-card"] });
  const nodes = byKey(buildTree(tree(card)).nodes);
  assert.deepEqual([nodes.get("p")!.cls, nodes.get("p")!.nocls], [["dark:text-muted-foreground", "text-foreground"], undefined]);
  // Alone, the dark theme's sets nothing snap measured: the base styles still color the light theme.
  const lone = el("div", [0, 0, 200, 20], { display: "flex" }, [p], { cls: ["dark:text-muted-foreground"] });
  const alone = byKey(buildTree(tree(lone)).nodes).get("p")!;
  assert.deepEqual([alone.cls, alone.nocls], [["dark:text-muted-foreground"], ["color"]]);
});

test("buildTree: a text takes the state classes of the element it inherits its color from, as that element's own paints do", () => {
  // coder's disabled Button, `text-content-invert disabled:text-content-disabled`,
  // and a highlighted Select option's `data-[highlighted]:text-content-primary`.
  const label = el("span", [0, 0, 80, 20], {}, [run("Button", [[0, 1.5, 40, 17]])], { text: TEXT });
  const button = el("button", [0, 0, 80, 20], { display: "flex" }, [label], { cls: ["text-content-invert", "disabled:text-content-disabled", "hover:bg-x"] });
  const text = byKey(buildTree(tree(button)).nodes).get("span")!;
  assert.deepEqual([text.cls, text.nocls], [["text-content-disabled", "text-content-invert"], undefined]);
});

test("buildTree: the custom properties behind a box's or a text's color go in its cls as var: evidence", () => {
  // Sonner's toast, `background: var(--normal-bg)` and `color: var(--normal-text)`, which the Toaster sets to shadcn/ui's tokens.
  const title = el("div", [16, 16, 200, 20], {}, [run("Event has been created", [[16, 17.5, 160, 17]])], { text: TEXT, vars: ["text-normal-text", "text-popover-foreground"] });
  const toast = el("li", [0, 0, 360, 60], { display: "flex", "background-color": "rgb(255, 255, 255)" }, [title], { vars: ["bg-normal-bg", "bg-popover", "text-normal-text", "text-popover-foreground"] });
  const nodes = byKey(buildTree(tree(toast)).nodes);
  assert.deepEqual(nodes.get("")!.cls, ["var:bg-normal-bg", "var:bg-popover", "var:text-normal-text", "var:text-popover-foreground"]);
  assert.deepEqual(nodes.get("div")!.cls, ["var:text-normal-text", "var:text-popover-foreground"]);
});

test("buildTree: a rule's literal color and the dark theme's go in a text's cls by their hex, and one no color reads is left out", () => {
  // Sonner's description: #3f3f3f, and hsl(0, 0%, 91%) under its dark theme.
  const description = el("div", [16, 36, 200, 20], {}, [run("Sunday, December 03", [[16, 37.5, 140, 17]])], { text: TEXT, vars: ["dark:text-[hsl(0,_0%,_91%)]", "text-[#3f3f3f]", "bg-[no-color]"] });
  const nodes = byKey(buildTree(tree(el("li", [0, 0, 360, 60], { display: "flex" }, [description]))).nodes);
  assert.deepEqual(nodes.get("div")!.cls, ["var:dark:text-[#e8e8e8]", "var:text-[#3f3f3f]"]);
});

test("buildTree: nocls says what no class colors: a text with no color class up the DOM, a border none of its own colors", () => {
  const BORDERED = { ...BORDER, "border-top-style": "solid", "border-right-style": "solid", "border-bottom-style": "solid", "border-left-style": "solid" };
  const text = (cls: string[] = [], css: Record<string, string> = {}) => el("p", [0, 0, 200, 20], css, [run("Text", [[0, 1.5, 40, 17]])], { text: TEXT, cls });
  const of = (root: RawTreeElement, outer?: string[][]) => byKey(buildTree({ ...tree(root), ...(outer ? { outer } : {}) }).nodes);
  // Dialog's title: no class anywhere, a state's aside, so the base styles color it.
  const title = of(el("div", [0, 0, 200, 20], { display: "flex" }, [text(["hover:text-accent-foreground", "text-lg"])])).get("p")!;
  assert.deepEqual([title.cls, title.nocls], [["text-accent-foreground", "text-lg"], ["color"]]);
  // A class sets it on it, on an element around it, or outside the root: none.
  for (const [root, outer] of [
    [el("div", [0, 0, 200, 20], { display: "flex" }, [text(["text-neutral-950"])]), undefined],
    [el("div", [0, 0, 200, 20], { display: "flex" }, [text(["text-[#0a0a0a]"])]), undefined],
    [el("div", [0, 0, 200, 20], { display: "flex" }, [text()], { cls: ["text-card-foreground"] }), undefined],
    [el("div", [0, 0, 200, 20], { display: "flex" }, [text()]), [["text-muted-foreground"]]],
    // A state's arbitrary color names nothing, and may be the one measured.
    [el("div", [0, 0, 200, 20], { display: "flex" }, [text(["hover:text-[#0a0a0a]"])]), undefined],
  ] as [RawTreeElement, string[][] | undefined][]) {
    assert.equal(of(root, outer).get("p")!.nocls, undefined, JSON.stringify(root.kids[0]));
  }
  assert.deepEqual(of(el("div", [0, 0, 200, 20], { display: "flex" }, [text(["text-[#0a0a0a]"])])).get("p")!.cls, undefined);
  // A run of text beside elements, and an icon, the same.
  const button = el("button", [0, 0, 100, 20], { display: "flex" }, [el("svg", [0, 0, 16, 16], {}, [], { svg: { tag: "svg", attrs: {}, kids: [] }, shapes: [] }), run("Cancel", [[20, 1.5, 40, 17]])], { text: TEXT });
  const nodes = of(el("div", [0, 0, 200, 20], { display: "flex" }, [button]));
  assert.deepEqual([nodes.get("button/#text")!.nocls, nodes.get("button/svg")!.nocls], [["color"], ["color"]]);
  const filled = el("svg", [0, 0, 16, 16], {}, [], { svg: { tag: "svg", attrs: {}, kids: [] }, shapes: [], cls: ["fill-foreground"] });
  assert.equal(of(el("div", [0, 0, 200, 20], { display: "flex" }, [filled])).get("svg")!.nocls, undefined);
  // A card's border: `border` alone, a state's color aside, a side or a style.
  const card = (cls: string[]) => el("div", [0, 0, 200, 40], BORDERED, [], { cls });
  assert.deepEqual(of(card(["data-[state=error]:border-destructive/30", "border-dashed", "border-l", "bg-card"])).get("")!.nocls, ["border-color"]);
  for (const cls of [["border-input"], ["border-t-input"], ["border-[#e5e5e5]"], ["border-neutral-200"], ["hover:border-[#e5e5e5]"]]) {
    assert.equal(of(card(cls)).get("")!.nocls, undefined, String(cls));
  }
  // No border, nothing to say.
  assert.equal(of(el("div", [0, 0, 200, 40], { "background-color": "rgb(255, 255, 255)" }, [], { cls: ["bg-card"] })).get("")!.nocls, undefined);
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

test("buildTree: under a wrapper, a child's flex facts are the wrapper's, which its parent laid out; one out of the flow in a wrapper is out of it", () => {
  // The button's shrink-0 worked inside the wrapper; the wrapper is what grew in the row.
  const button = el("button", [8, 8, 24, 24], { ...BORDER, "flex-shrink": "0" });
  const actions = el("div", [8, 8, 24, 24], { position: "relative", "z-index": "20", "flex-grow": "1" }, [button]);
  const [, node] = buildTree(tree(el("div", [0, 0, 40, 40], { display: "flex" }, [actions]))).nodes;
  assert.deepEqual(node.S, { grow: 1, z: 20 });
  assert.equal(node.abs, undefined);
  const floating = el("div", [8, 8, 24, 24], { position: "absolute" }, [el("span", [8, 8, 24, 24], { ...BORDER, position: "relative" })]);
  assert.equal(buildTree(tree(el("div", [0, 0, 40, 40], {}, [floating]))).nodes[1].abs, 1);
});

test("buildTree: an icon's markup draws inside its padding at its border box, as coder's [&>svg]:p-0.5 draws its plus", () => {
  const plus = { tag: "svg", attrs: { viewBox: "0 0 24 24" }, kids: [{ tag: "path", attrs: { d: "M5 12h14" }, paint: {} }] };
  const padded = el("svg", [12, 8, 24, 24], { "padding-top": "2px", "padding-right": "2px", "padding-bottom": "2px", "padding-left": "2px" }, [], { svg: plus, shapes: [[6.17, 12, 11.67, 0]] });
  const button = el("button", [0, 0, 48, 40], { display: "flex" }, [padded]);
  const built = buildTree(tree(button));
  const node = byKey(built.nodes).get("svg")!;
  assert.match(built.svg[node.svg!], / viewBox="-2.4 -2.4 28.8 28.8"/);
});

test("buildTree: a pseudo-element's classes are its host's before: or after: ones, and no class for another box is the element's own", () => {
  const BORDERED = { ...BORDER, "border-top-style": "solid", "border-right-style": "solid", "border-bottom-style": "solid", "border-left-style": "solid" };
  const text = (cls: string[] = []) => el("div", [0, 0, 200, 20], {}, [run("Title", [[0, 1.5, 40, 17]])], { text: TEXT, cls, slot: "alert-title" });
  // Avatar: its ring is the root's ::after, after:border-border; Marker's
  // lines its ::before and ::after, before:bg-border and after:bg-border.
  const avatar = el("span", [0, 0, 32, 32], { display: "flex" }, [
    { k: "p", which: "before", cs: { "background-color": "rgb(229, 229, 229)" }, content: "", box: [0, 0, 32, 1], how: "flow" },
    { k: "p", which: "after", cs: BORDERED, content: "", box: [0, 0, 32, 32], how: "abs" },
  ], { cls: ["after:border-border", "before:bg-border", "dark:after:bg-input/30", "rounded-full", "[&_a]:hover:text-foreground"] });
  const nodes = byKey(buildTree(tree(avatar)).nodes);
  assert.deepEqual(nodes.get("::after")!.cls, ["border-border", "dark:bg-input/30"]);
  assert.deepEqual(nodes.get("::before")!.cls, ["bg-border"]);
  // shadcn/ui's alert title colors its links on hover, [&_a]:hover:text-foreground:
  // its own color is the alert's text-card-foreground, which it inherits.
  const alert = el("div", [0, 0, 200, 40], { display: "flex", "background-color": "rgb(255, 255, 255)" }, [text(["[&_a]:hover:text-foreground"])], { cls: ["bg-card", "text-card-foreground", "*:[svg]:text-current"] });
  const title = byKey(buildTree(tree(alert)).nodes).get("alert-title")!;
  assert.deepEqual([title.cls, title.nocls], [["text-card-foreground"], undefined]);
  assert.deepEqual(classEvidence(["[&>svg]:text-x", "*:bg-x", "**:bg-y", "[.dark_&]:bg-z", "has-[>svg]:bg-w", "[&:hover]:bg-v"]), ["bg-v", "bg-w", "bg-z"]);
});

test("classEvidence: a dark: class with a state is the dark theme's where the page found its state applies, and says nothing where it doesn't", () => {
  // shadcn/ui's Tabs trigger.
  const tabs = ["text-foreground/60", "dark:text-muted-foreground", "data-active:text-foreground", "dark:data-active:text-foreground", "dark:hover:bg-x"];
  // Active: Tailwind puts dark:data-active: after dark:, so it is what Dark paints.
  const states = (active: boolean) => ({ "dark:data-active:text-foreground": active, "dark:hover:bg-x": false });
  assert.deepEqual(classEvidence(tabs, states(true)), ["bg-x", "dark:text-foreground", "text-foreground"]);
  assert.deepEqual(classEvidence(tabs, states(false)), ["bg-x", "dark:text-muted-foreground", "text-foreground"]);
  // A state the page couldn't tell stays as written, for figma code to leave Dark as the token's.
  assert.deepEqual(classEvidence(tabs), ["bg-x", "dark:data-active:text-foreground", "dark:hover:bg-x", "dark:text-muted-foreground", "text-foreground"]);
  // Another property's plain dark: class stays.
  assert.deepEqual(classEvidence(["bg-background", "dark:bg-input/30", "dark:data-checked:bg-primary", "dark:border-input"], { "dark:data-checked:bg-primary": true }), ["bg-background", "bg-primary", "dark:bg-primary", "dark:border-input"]);
});

test("buildTree: a text's inherited dark: class with a state reads its holder's states", () => {
  const label = el("span", [10, 5, 50, 20], {}, [run("Account", [[10, 6.5, 50, 17]])], { text: TEXT });
  const trigger = el("button", [0, 0, 80, 30], { display: "flex" }, [label], { cls: ["text-foreground/60", "dark:text-muted-foreground", "dark:data-active:text-foreground"], states: { "dark:data-active:text-foreground": true } });
  const nodes = buildTree(tree(trigger)).nodes;
  assert.deepEqual(nodes.find((n) => n.t === "T")!.cls, ["dark:text-foreground", "text-foreground"]);
  // A pseudo-element's, by its host's: dark:data-open:after:bg-x is its dark:data-open:bg-x.
  const ring = (on?: boolean) => {
    const host = el("span", [0, 0, 32, 32], { display: "flex" }, [{ k: "p", which: "after", cs: { "background-color": "rgb(229, 229, 229)" }, content: "", box: [0, 0, 32, 32], how: "abs" }],
      { cls: ["after:bg-border", "dark:after:bg-input", "dark:data-open:after:bg-ring"], ...(on === undefined ? {} : { states: { "dark:data-open:after:bg-ring": on } }) });
    return byKey(buildTree(tree(host)).nodes).get("::after")!.cls;
  };
  assert.deepEqual(ring(true), ["bg-border", "bg-ring", "dark:bg-ring"]);
  assert.deepEqual(ring(false), ["bg-border", "bg-ring", "dark:bg-input"]);
  assert.deepEqual(ring(), ["bg-border", "bg-ring", "dark:bg-input", "dark:data-open:bg-ring"]);
});
