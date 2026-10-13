import assert from "node:assert/strict";
import { test } from "node:test";
import { Binder } from "../figma-bind.js";
import { figmaSize, linearGradient, nodeStyle, outsideInsets, splitHex, textSizesItself, vectorImport } from "../figma-map.js";
import type { MapContext } from "../figma-map.js";
import type { TreeNode } from "../tree-types.js";
import { SHADCN_TOKENS } from "./shadcn-tokens.js";

const ctx = (binder = new Binder(null)): MapContext => ({ binder, notBuilt: [], unbound: [] });
const frame = (fields: Partial<TreeNode>): TreeNode => ({ k: "x", t: "F", el: "div", box: [0, 0, 100, 40], ...fields });

/** Where a gradient transform puts a point of the node's 0-1 space along the gradient. */
const along = (g: number[], u: number, v: number) => g[0] * u + g[1] * v + g[2];

test("linearGradient: 90deg runs left to right across the box, its stops in place", () => {
  const paint = linearGradient("linear-gradient(90deg, #2563eb, #7c3aed)", 100, 40) as { g: number[]; s: [number, string][] };
  assert.deepEqual(paint.g, [1, 0, 0, 0, 0.4, 0.3]);
  assert.deepEqual(paint.s, [[0, "#2563ebff"], [1, "#7c3aedff"]]);
  assert.deepEqual(linearGradient("linear-gradient(to right, #2563eb, #7c3aed)", 100, 40), paint);
});

test("linearGradient: CSS's default runs top to bottom, and an angle along the box's own extent", () => {
  const down = linearGradient("linear-gradient(#000, #fff)", 100, 40) as { g: number[] };
  assert.equal(along(down.g, 0.5, 0), 0);
  assert.equal(along(down.g, 0.5, 1), 1);
  // 45deg on a 100x40 box: the line through the center is |100 sin| + |40 cos| long,
  // so the corners it ends at are exactly 0 and 1.
  const diagonal = linearGradient("linear-gradient(45deg, #000, #fff)", 100, 40) as { g: number[] };
  assert.ok(Math.abs(along(diagonal.g, 0, 1)) < 1e-3);
  assert.ok(Math.abs(along(diagonal.g, 1, 0) - 1) < 1e-3);
});

test("linearGradient: toward a corner, the line is perpendicular to the other diagonal", () => {
  // CSS: "to top right" puts the 50% line through the top-left and bottom-right corners.
  const g = (linearGradient("linear-gradient(to top right, #000, #fff)", 100, 40) as { g: number[] }).g;
  assert.ok(Math.abs(along(g, 0, 0) - 0.5) < 1e-3);
  assert.ok(Math.abs(along(g, 1, 1) - 0.5) < 1e-3);
  assert.ok(along(g, 1, 0) > 0.99 && along(g, 0, 1) < 0.01);
});

test("linearGradient: stops without positions spread between their neighbors; px and % are fractions of the line", () => {
  const paint = linearGradient("linear-gradient(90deg, #000 10%, #111, #222, #333 40px, #444)", 100, 40) as { s: [number, string][] };
  assert.deepEqual(paint.s.map((s) => s[0]), [0.1, 0.2, 0.3, 0.4, 1]);
});

test("linearGradient: anything but a linear gradient of hex stops is not built", () => {
  assert.equal(linearGradient("radial-gradient(circle, #ff000080, #00000000)", 10, 10), null);
  assert.equal(linearGradient('url("a.png")', 10, 10), null);
  assert.equal(linearGradient("linear-gradient(90deg, #000)", 10, 10), null);
});

test("nodeStyle: a fill keeps its alpha as the paint's opacity, and binds where a class names the token", () => {
  assert.deepEqual(nodeStyle(frame({ bg: "#df22251a" }), ctx()).f, [["#df2225", 0.102]]);
  assert.deepEqual(nodeStyle(frame({ bg: "#171717" }), ctx()).f, ["#171717"]);
  const c = ctx(new Binder(SHADCN_TOKENS));
  assert.deepEqual(nodeStyle(frame({ bg: "#171717", cls: ["bg-primary"] }), c).f, [["#171717", 1, "primary"]]);
  assert.deepEqual(nodeStyle(frame({ bg: "#0a0a0a" }), c).f, ["#0a0a0a"]);
  assert.deepEqual(c.unbound, [{ key: "x", property: "fill", value: "#0a0a0a", candidates: ["card/foreground", "foreground", "popover/foreground", "sidebar/foreground"] }]);
});

test("nodeStyle: a background color under gradients comes first, the CSS top layer last", () => {
  const style = nodeStyle(frame({ bg: "#ffffff", bgi: "linear-gradient(90deg, #000, #111), linear-gradient(90deg, #222, #333)" }), ctx());
  assert.equal(style.f!.length, 3);
  assert.equal(style.f![0], "#ffffff");
  assert.deepEqual((style.f![2] as { s: [number, string][] }).s.map((s) => s[1]), ["#000000ff", "#111111ff"]);
  const c = ctx();
  nodeStyle(frame({ bgi: "radial-gradient(circle, #000, #fff)" }), c);
  assert.deepEqual(c.notBuilt.map((n) => n.what), ["background radial-gradient(circle, #000, #fff)"]);
});

test("nodeStyle: a border is an INSIDE stroke; one the background stops at, which shows what is behind it, is OUTSIDE, the frame its padding box", () => {
  const inside = nodeStyle(frame({ bd: { w: 1, s: "solid", c: "#e5e5e5" }, r: 8 }), ctx());
  assert.deepEqual(inside.s, { w: 1, p: "#e5e5e5" });
  assert.equal(inside.r, 8);
  // A translucent 1px border and bg-clip-padding.
  const button = frame({ bd: { w: 1, s: "solid", c: "#e5e5e580" }, bgc: "padding-box", bg: "#171717", r: 8, box: [0, 0, 206.8, 36] });
  const outside = nodeStyle(button, ctx());
  assert.deepEqual(outside.s, { w: 1, p: ["#e5e5e5", 0.502], o: 1 });
  assert.equal(outside.r, 7);
  assert.deepEqual(outsideInsets(button), [1, 1, 1, 1]);
  assert.deepEqual(figmaSize(button), [204.8, 34]);
  assert.deepEqual(figmaSize(frame({ bd: { w: 1, s: "solid", c: null }, r: 8 })), [100, 40]);
});

test("nodeStyle: a border the background stops at is INSIDE where that draws the same, so its radius binds; elsewhere the radius that can't is said", () => {
  // The fifth live push's Button: rounded-md, md = 8, a 1px border and
  // bg-clip-padding in every variant. Its outline variant's border is
  // opaque and hides the background under it; ghost and link have none to
  // show. Each is built INSIDE at its border box, radius 8, bound to md.
  const button = (fields: Partial<TreeNode>) => frame({ k: "", bgc: "padding-box", r: 8, box: [0, 0, 66.63, 36], cls: ["rounded-md"], ...fields });
  const outline = button({ bd: { w: 1, s: "solid", c: "#e5e5e5" }, bg: "#ffffff" });
  const ghost = button({ bd: { w: 1, s: "solid", c: null } });
  for (const node of [outline, ghost]) {
    const c = ctx(new Binder(SHADCN_TOKENS));
    const style = nodeStyle(node, c);
    assert.equal(style.s!.o, undefined, "INSIDE");
    assert.deepEqual([style.r, style.rv], [8, "md"]);
    assert.deepEqual([outsideInsets(node), figmaSize(node)], [[0, 0, 0, 0], [66.63, 36]]);
    assert.deepEqual(c.unbound.filter((u) => u.property === "radius"), []);
    assert.deepEqual(c.notBuilt, []);
  }
  // A translucent, dashed or partly transparent border over the
  // background shows what is behind the element where the background
  // stops, as Figma's fill under an INSIDE stroke can't. Built OUTSIDE at
  // the padding box, radius 7, which no token holds: said as what it is.
  const borders: [TreeNode["bd"], string][] = [
    [{ w: 1, s: "solid", c: "#e5e5e580" }, "translucent"], [{ w: 1, s: "dashed", c: "#e5e5e5" }, "dashed"],
    [{ w: 1, s: "solid", c: ["#e5e5e5", null, "#e5e5e5", null] }, "partly transparent"],
  ];
  for (const [bd, kind] of borders) {
    const c = ctx(new Binder(SHADCN_TOKENS));
    const style = nodeStyle(button({ bd, bg: "#171717" }), c);
    assert.deepEqual([style.s!.o, style.r, style.rv], [1, 7, undefined], JSON.stringify(bd));
    assert.deepEqual(c.unbound.filter((u) => u.property === "radius"), [{
      key: "", property: "radius", value: "8", candidates: ["md"],
      why: `its background stops inside its ${kind} border (background-clip padding-box), which shows what is behind the element there, so the frame is built as the padding box, at radius 7, which no token holds`,
    }]);
  }
});

test("nodeStyle: a background inside a border that paints nothing is built at the border box, its radius bound, the fill under the clear ring and said", () => {
  // The fifth live push's Button, default, secondary and destructive: a
  // fill under a 1px transparent border, bg-clip-padding, rounded-md. 48 of
  // its 96 variants were built OUTSIDE at the padding box, radius 7, bound
  // to nothing. The border draws nothing, so the frame is the border box
  // the class rounds, radius 8, bound to md; Figma's fill, which no stroke
  // insets, runs under the clear ring, and figma code says so.
  const button = frame({ k: "", bd: { w: 1, s: "solid", c: null }, bgc: "padding-box", bg: "#171717", r: 8, box: [0, 0, 66.63, 36], cls: ["bg-primary", "border-transparent", "rounded-md"] });
  for (const node of [button, frame({ ...button, bd: { w: [1, 0, 1, 0], s: "solid", c: null } })]) {
    const c = ctx(new Binder(SHADCN_TOKENS));
    const style = nodeStyle(node, c);
    assert.deepEqual([style.s, style.r, style.rv], [{ w: node.bd!.w, p: ["#000000", 0] }, 8, "md"]);
    assert.deepEqual(style.f, [["#171717", 1, "primary"]]);
    assert.deepEqual([outsideInsets(node), figmaSize(node)], [[0, 0, 0, 0], [66.63, 36]]);
    assert.deepEqual(c.unbound, []);
    assert.deepEqual(c.notBuilt, [{ key: "", what: "background-clip padding-box inside a transparent border", as: "a fill to the border box, under the border's clear stroke" }]);
  }
});

test("nodeStyle: per-side widths are kept; per-side colors are built in the most common and named", () => {
  const slot = nodeStyle(frame({ bd: { w: [1, 1, 1, 0], s: "solid", c: "#e5e5e5" } }), ctx());
  assert.deepEqual(slot.s, { w: [1, 1, 1, 0], p: "#e5e5e5" });
  const c = ctx();
  const mixed = nodeStyle(frame({ k: "tab", bd: { w: [0, 0, 2, 0], s: "solid", c: ["#e5e5e5", "#e5e5e5", "#171717", "#e5e5e5"] } }), c);
  assert.deepEqual(mixed.s, { w: [0, 0, 2, 0], p: "#171717" });
  assert.deepEqual(c.notBuilt, []);
  const c2 = ctx();
  const two = nodeStyle(frame({ k: "cell", bd: { w: 1, s: "solid", c: ["#e5e5e5", "#e5e5e5", "#e5e5e5", "#171717"] } }), c2);
  assert.deepEqual(two.s, { w: 1, p: "#e5e5e5" });
  assert.deepEqual(c2.notBuilt, [{ key: "cell", what: "per-side border colors (#e5e5e5 #e5e5e5 #e5e5e5 #171717)", as: "one color, #e5e5e5" }]);
});

test("nodeStyle: dashes are three widths, dots one; a style strokes lack is built solid and named", () => {
  assert.deepEqual(nodeStyle(frame({ bd: { w: 2, s: "dashed", c: "#000000" } }), ctx()).s!.d, [6, 6]);
  assert.deepEqual(nodeStyle(frame({ bd: { w: 1, s: "dotted", c: "#000000" } }), ctx()).s!.d, [1, 1]);
  const c = ctx();
  assert.equal(nodeStyle(frame({ bd: { w: 3, s: "double", c: "#000000" } }), c).s!.d, undefined);
  assert.deepEqual(c.notBuilt.map((n) => [n.what, n.as]), [["border style double", "solid"]]);
});

test("nodeStyle: shadows, blurs and blend modes as Figma names them; what it lacks is named", () => {
  const c = ctx();
  const style = nodeStyle(frame({
    sh: [[0, 0, 0, 1, "#0a0a0a1a"], [0, 1, 2, 0, "#0000000d"], [0, 2, 4, 0, "#00000040", 1], [0, 0, 0, 0, "#00000000"]],
    fl: "blur(4px)", bf: "blur(8px) saturate(1.8)", bm: "darken",
  }), c);
  assert.deepEqual(style.e, [
    ["D", 0, 0, 0, 1, "#0a0a0a", 0.102], ["D", 0, 1, 2, 0, "#000000", 0.051], ["I", 0, 2, 4, 0, "#000000", 0.251], ["L", 4],
  ]);
  assert.equal(style.b, "DARKEN");
  assert.deepEqual(c.notBuilt.map((n) => n.what), ["backdrop-filter blur(8px) saturate(1.8)"]);
  const c2 = ctx();
  assert.equal(nodeStyle(frame({ bm: "plus-lighter", cp: "inset(0)", ol: [2, "solid", "#000000", 1], tf: "matrix(0, 1, -1, 0, 0, 0)", clip: "x" }), c2).b, undefined);
  assert.deepEqual(c2.notBuilt.map((n) => [n.what, n.as]), [
    ["blend mode plus-lighter", undefined], ["clip-path inset(0)", undefined], ["outline 2px solid #000000", undefined],
    ["transform matrix(0, 1, -1, 0, 0, 0)", "its own box, unturned, as Figma's auto layout would place it by its turned box"],
    ["overflow clipped on x only", "clipping both axes"],
  ]);
});

test("nodeStyle: a shadow's color binds to the token its ring-* class names, at its own alpha; one no class names is listed", () => {
  // The fifth live push's Dialog: ring-1 ring-foreground/10, a spread-only
  // shadow left #0a0a0a1a in Dark, since no effect color was bound.
  const ring = (cls: string[]) => frame({ k: "", sh: [[0, 0, 0, 1, "#0a0a0a1a"], [0, 1, 2, 0, "#0000000d"]], bg: "#ffffff", r: 14, cls });
  const c = ctx(new Binder(SHADCN_TOKENS));
  assert.deepEqual(nodeStyle(ring(["bg-background", "ring-foreground", "rounded-xl"]), c).e, [
    ["D", 0, 0, 0, 1, "#0a0a0a", 0.102, "foreground"], ["D", 0, 1, 2, 0, "#000000", 0.051],
  ]);
  assert.deepEqual(c.unbound.filter((u) => u.property === "effect"), []);
  const c2 = ctx(new Binder(SHADCN_TOKENS));
  assert.deepEqual(nodeStyle(ring(["bg-background"]), c2).e![0], ["D", 0, 0, 0, 1, "#0a0a0a", 0.102]);
  assert.deepEqual(c2.unbound, [{ key: "", property: "effect", value: "#0a0a0a1a", candidates: ["card/foreground", "foreground", "popover/foreground", "sidebar/foreground"] }]);
});

test("nodeStyle: a turn in the plane of a childless node, nothing transformed around it, out of the flow or in it where its turned box is its own, is built as Figma's rotation; any other transform is named", () => {
  // The fifth push's Tooltip arrow: Tailwind's rotate-45, out of the flow.
  const arrow = (fields: Partial<TreeNode>) => frame({ k: "div", abs: 1, bg: "#0a0a0a", r: 2, box: [45.5, 21, 10, 10], tf: "rotate: 45deg", approx: "transform", ...fields });
  const c = ctx();
  assert.equal(nodeStyle(arrow({}), c).rt, -45);
  assert.equal(nodeStyle(arrow({ tf: "matrix(0, 1, -1, 0, 3, 4)" }), c).rt, -90);
  assert.equal(nodeStyle(arrow({ tf: "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0); rotate: -0.5turn" }), c).rt, 135);
  // In the flow, a chevron's rotate-180, and a square icon's rotate-90:
  // auto layout lays out each turned box where the unturned one would go.
  assert.equal(nodeStyle(arrow({ abs: undefined, tf: "rotate: 180deg", box: [0, 0, 16, 6] }), c).rt, -180);
  assert.equal(nodeStyle(arrow({ abs: undefined, tf: "rotate: -90deg", box: [0, 0, 16, 16] }), c).rt, 90);
  assert.deepEqual(c.notBuilt, []);
  const leaf = { children: 0, transformed: false };
  const cases: [Partial<TreeNode>, MapContext["around"], string][] = [
    [{ abs: undefined }, leaf, "its own box, unturned, as Figma's auto layout would place it by its turned box"],
    [{ abs: undefined, tf: "rotate: 90deg", box: [0, 0, 16, 6] }, leaf, "its own box, unturned, as Figma's auto layout would place it by its turned box"],
    [{}, { children: 1, transformed: false }, "its own box, unturned, as its children are measured turned"],
    // Inside a node turned or scaled, which is built untransformed: turned
    // on its own, it would show at another net turn than the browser's.
    [{}, { children: 0, transformed: true }, "its own box, unturned, as a transform around it is built untransformed"],
    [{ tf: "rotate: 45deg; scale: 2" }, leaf, "the element's own box, untransformed"],
    [{ tf: "rotate: x 45deg" }, leaf, "the element's own box, untransformed"],
    [{ tf: "matrix(2, 0, 0, 2, 0, 0)" }, leaf, "the element's own box, untransformed"],
  ];
  for (const [fields, around, as] of cases) {
    const c2: MapContext = { ...ctx(), around };
    assert.equal(nodeStyle(arrow(fields), c2).rt, undefined, JSON.stringify(fields));
    assert.deepEqual(c2.notBuilt, [{ key: "div", what: `transform ${fields.tf ?? "rotate: 45deg"}`, as }]);
  }
});

const text = (tx: Partial<NonNullable<TreeNode["tx"]>>, box: TreeNode["box"] = [0, 0, 94.17, 24]): TreeNode => ({
  k: "t", t: "T", el: "#text", box,
  tx: { c: "Notifications", f: "system-ui", fk: 1, sz: 16, wt: 500, col: "#0a0a0a", lh: 24, n: 1, ink: [0, 3, 94.17, 18], ...tx },
});

test("textSizesItself: one line at its glyphs' width hugs; a wider box, more lines or a cut-off don't", () => {
  assert.equal(textSizesItself(text({})), true);
  assert.equal(textSizesItself(text({}, [24, 0, 336, 24])), false);
  assert.equal(textSizesItself(text({ n: 2 })), false);
  assert.equal(textSizesItself(text({ el: 1 })), false);
  assert.equal(textSizesItself(text({ cl: 2 })), false);
});

test("nodeStyle: a text's properties, sizing and truncation", () => {
  assert.deepEqual(nodeStyle(text({}), ctx()).t, { c: "Notifications", f: "system-ui", w: 500, z: 16, l: 24, ar: "W" });
  const all = nodeStyle(text({ tt: "uppercase", td: "line-through", ta: "center", it: 1, ls: 0.5, lh: "normal", el: 1 }), ctx()).t;
  assert.deepEqual(all, { c: "Notifications", f: "system-ui", w: 500, z: 16, l: 0, ar: "H", i: 1, s: 0.5, tc: "UPPER", td: "STRIKETHROUGH", ta: "CENTER", tr: 1, o: 1 });
  assert.equal(nodeStyle(text({ cl: 3, n: 3 }), ctx()).t!.tr, 3);
  // A text has no layer name of its own: Figma names it by its characters.
  assert.equal(nodeStyle(text({}), ctx()).n, undefined);
});

test("nodeStyle: a label the browser drew whole on one line in a box Figma sets at its width is marked to stay so", () => {
  // In a wider box, centered; truncatable, but whole: each is kept on one line should Figma set it wider.
  assert.equal(nodeStyle(text({ ta: "center", ink: [120, 3, 94.17, 18] }, [0, 0, 336, 24]), ctx()).t!.o, 1);
  assert.equal(nodeStyle(text({ el: 1 }), ctx()).t!.o, 1);
  // Cut off by its ellipsis, wrapped, or sizing itself: none is.
  assert.equal(nodeStyle(text({ el: 1, ink: [0, 3, 140, 18] }, [0, 0, 94, 24]), ctx()).t!.o, undefined);
  assert.equal(nodeStyle(text({ n: 2, lh: 24, ink: [0, 3, 90, 42] }, [0, 0, 94, 48]), ctx()).t!.o, undefined);
  assert.equal(nodeStyle(text({}), ctx()).t!.o, undefined);
});

test("nodeStyle: the stand-in a text's family gets in Figma, from the one mapping snap measures with", () => {
  const alt = (f: string, fs?: string) => nodeStyle(text({ f, ...(fs ? { fs } : {}) }), ctx()).t!.a;
  // Inter is loadFont's own last resort, so a family that stands in as Inter names none.
  assert.equal(alt("system-ui"), undefined);
  assert.equal(alt("Inter", "system-ui"), undefined);
  assert.equal(alt("Menlo"), "Roboto Mono");
  assert.equal(alt("ui-monospace"), "Roboto Mono");
  assert.equal(alt("Georgia"), "Noto Serif");
  // Drawn in its stand-in already, it names none; a web font Figma may lack gets its kind's.
  assert.equal(alt("Roboto Mono", "ui-monospace"), undefined);
  assert.equal(alt("Geist Mono"), "Roboto Mono");
  assert.equal(alt("Geist"), undefined);
});

test("nodeStyle: a #text run's color is named by its own classes, else its parent element's", () => {
  const c = { ...ctx(new Binder(SHADCN_TOKENS)), parentCls: ["bg-primary", "text-primary-foreground"] };
  assert.deepEqual(nodeStyle(text({ col: "#fafafa" }), c).f, [["#fafafa", 1, "primary/foreground"]]);
  // The class it inherits from a grandparent, under a wrapper that paints nothing and so has none.
  const run = { ...text({}), cls: ["text-card-foreground"] };
  const bare = ctx(new Binder(SHADCN_TOKENS));
  assert.deepEqual(nodeStyle(run, bare).f, [["#0a0a0a", 1, "card/foreground"]]);
  assert.equal(bare.unbound.length, 0);
  assert.deepEqual(nodeStyle({ ...run, el: "#value" }, { ...bare, parentCls: ["text-foreground"] }).f, [["#0a0a0a", 1, "card/foreground"]]);
  // Without either, #0a0a0a stays as measured, listed with the four tokens that have it.
  nodeStyle(text({}), bare);
  assert.deepEqual(bare.unbound.map((u) => u.candidates.length), [4]);
});

const MAIL = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2"><path d="m22 7-10 6L2 7"/></svg>';

test("nodeStyle: a vector carries its markup and asset id, and binds the colors its classes name", () => {
  const icon: TreeNode = { k: "svg", t: "V", el: "svg.lucide-mail", box: [11, 10, 16, 16], svg: "svg:75dee6f9", cls: ["text-primary"] };
  const style = nodeStyle(icon, ctx(new Binder(SHADCN_TOKENS)), MAIL);
  assert.equal(style.markup, MAIL, "imported at its measured size, which snap wrote on it");
  assert.equal(style.id, "svg:75dee6f9");
  assert.equal(style.n, "lucide-mail", "named by its class");
  assert.equal(nodeStyle({ ...icon, el: "svg" }, ctx(), MAIL).n, "svg", "or, without one, its element");
  assert.equal(style.rs, undefined, "Figma scales its strokes with the import (spike item 1): nothing to rescale");
  assert.equal(nodeStyle(icon, { ...ctx(new Binder(SHADCN_TOKENS)), spike: { svgStrokesScale: false } }, MAIL).rs, 0.666667, "the fallback rescales");
  assert.deepEqual(style.vb, undefined, "#0a0a0a is four tokens and text-primary names none of them");
  assert.throws(() => nodeStyle(icon, ctx()), /svg asset svg:75dee6f9 is not in the tree's assets/);
});

test("vectorImport: imports at the measured size, or, where strokes don't scale with the import, at the viewBox, rescaled", () => {
  assert.deepEqual(vectorImport(MAIL, [0, 0, 16, 16], true), { markup: MAIL });
  // An icon drawn at another size than the markup says, or markup with none, is imported at the size drawn.
  assert.deepEqual(vectorImport(MAIL, [0, 0, 20, 20], true), { markup: MAIL.replace('width="16" height="16"', 'width="20" height="20"') });
  const bare = '<svg viewBox="0 0 24 24" stroke-width="2"><path d="M2 2h20"/></svg>';
  assert.deepEqual(vectorImport(bare, [0, 0, 16, 12.5], true), { markup: '<svg width="16" height="12.5" viewBox="0 0 24 24" stroke-width="2"><path d="M2 2h20"/></svg>' });
  const fallback = vectorImport(MAIL, [0, 0, 16, 16], false);
  assert.match(fallback.markup, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24"/);
  assert.equal(fallback.rescale, 0.666667);
  // At the viewBox's own size there is nothing to rescale.
  assert.deepEqual(vectorImport(MAIL.replace('width="16" height="16"', 'width="24" height="24"'), [0, 0, 24, 24], false).rescale, undefined);
});

test("nodeStyle: an image is a frame showing its asset; hidden and translucent nodes say so", () => {
  const style = nodeStyle({ k: "avatar-image", t: "I", el: "img", box: [0, 0, 32, 32], img: "img:513d06f54269-262b", r: 16, clip: 1, op: 0.5, vis: 0 }, ctx());
  assert.deepEqual(style, { n: "img", o: 0.5, v: 0, c: 1, im: "img:513d06f54269-262b", r: 16 });
});

test("splitHex: #rrggbbaa as #rrggbb and an alpha to three places", () => {
  assert.deepEqual(splitHex("#DF22254D"), ["#df2225", 0.302]);
  assert.deepEqual(splitHex("#171717"), ["#171717", 1]);
});
