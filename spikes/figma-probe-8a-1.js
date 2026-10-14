// storysync probe 8a, call 1 (2026-10-13): what Figma refuses on a frame
// without auto layout, as a variant copied from an auto layout one and
// turned NONE meets it (A); whether a ring, a spread-only drop shadow,
// draws on a frame without fills, clipped or not (B, each exported as PNG);
// and the widths Figma gives the texts of shadcn/ui's Item, Breadcrumb and
// Empty, hugging and at the browser's width, and a line separator (C).
// Only on the page "storysync probe 8a", which it creates and marks.
const PAGE = 'storysync probe 8a';
let page = figma.root.children.find((p) => p.name === PAGE);
if (page && page.getSharedPluginData('storysync', 'probe8a') !== '1') throw new Error('A page named "' + PAGE + '" exists that this probe did not create');
if (!page) {
  page = figma.createPage();
  page.name = PAGE;
  page.setSharedPluginData('storysync', 'probe8a', '1');
}
await figma.setCurrentPageAsync(page);
for (const n of [...page.children]) n.remove();
for (const s of ['Regular', 'Medium']) await figma.loadFontAsync({ family: 'Inter', style: s });
const r4 = (n) => (typeof n === 'number' ? Math.round(n * 10000) / 10000 : n);
const out = { page: page.id, none: {}, ring: {}, text: {} };
const tryset = (node, prop, value) => {
  try { node[prop] = value; return 'ok'; } catch (e) { return String(e.message || e).slice(0, 120); }
};

// A. An auto layout frame with strokes included, a frame child (absolute)
// and a text child, copied and turned NONE.
const P = figma.createFrame();
page.appendChild(P);
P.x = 0; P.y = 0;
P.layoutMode = 'VERTICAL';
P.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
P.strokeWeight = 1;
P.strokeAlign = 'INSIDE';
P.strokesIncludedInLayout = true;
P.paddingTop = 4;
P.itemSpacing = 6;
const pc = figma.createFrame();
P.appendChild(pc);
pc.resize(20, 10);
const pa = figma.createFrame();
P.appendChild(pa);
pa.resize(10, 10);
pa.layoutPositioning = 'ABSOLUTE';
const pt = figma.createText();
P.appendChild(pt);
pt.characters = 'Hi';
const Q = P.clone();
page.appendChild(Q);
Q.x = 200;
out.none.cloneBefore = { sil: Q.strokesIncludedInLayout, mode: Q.layoutMode };
out.none.setNone = tryset(Q, 'layoutMode', 'NONE');
out.none.read = {};
for (const p of ['strokesIncludedInLayout', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'itemSpacing', 'paddingTop', 'layoutWrap', 'primaryAxisAlignItems', 'itemReverseZIndex']) {
  try { out.none.read[p] = Q[p]; } catch (e) { out.none.read[p] = 'error: ' + String(e.message || e).slice(0, 80); }
}
const qc = Q.children[0];
const qa = Q.children[1];
const qt = Q.children[2];
out.none.kids = { absAfterNone: qa.layoutPositioning, cSizing: [qc.layoutSizingHorizontal, qc.layoutSizingVertical] };
const frameProps = [
  ['strokesIncludedInLayout', false], ['strokesIncludedInLayout', true], ['layoutWrap', 'NO_WRAP'], ['layoutWrap', 'WRAP'],
  ['primaryAxisSizingMode', 'FIXED'], ['primaryAxisSizingMode', 'AUTO'], ['counterAxisSizingMode', 'AUTO'],
  ['primaryAxisAlignItems', 'CENTER'], ['counterAxisAlignItems', 'CENTER'], ['counterAxisAlignItems', 'BASELINE'],
  ['paddingTop', 3], ['paddingLeft', 3], ['itemSpacing', 5], ['counterAxisSpacing', 4], ['counterAxisAlignContent', 'AUTO'],
  ['itemReverseZIndex', true], ['layoutSizingHorizontal', 'HUG'], ['layoutSizingHorizontal', 'FIXED'], ['layoutSizingVertical', 'HUG'],
];
out.none.frame = frameProps.map(([p, v]) => [p, v, tryset(Q, p, v)]);
const kidProps = [
  [qc, 'layoutPositioning', 'ABSOLUTE'], [qc, 'layoutPositioning', 'AUTO'], [qa, 'layoutPositioning', 'AUTO'],
  [qc, 'layoutSizingHorizontal', 'FILL'], [qc, 'layoutSizingHorizontal', 'FIXED'], [qc, 'layoutSizingHorizontal', 'HUG'],
  [qc, 'layoutGrow', 1], [qc, 'layoutGrow', 0], [qc, 'layoutAlign', 'STRETCH'], [qc, 'layoutAlign', 'INHERIT'],
  [qt, 'layoutSizingHorizontal', 'HUG'], [qt, 'layoutSizingHorizontal', 'FIXED'],
];
out.none.child = kidProps.map(([n, p, v]) => [n === qt ? 'text' : n === qa ? 'abs' : 'frame', p, v, tryset(n, p, v)]);
// A frame that never had auto layout.
const R = figma.createFrame();
page.appendChild(R);
R.x = 400;
out.none.fresh = { read: R.strokesIncludedInLayout, setFalse: tryset(R, 'strokesIncludedInLayout', false), setTrue: tryset(R, 'strokesIncludedInLayout', true) };
// Cleared while still auto layout, then turned NONE: what a build can do.
const Q2 = P.clone();
page.appendChild(Q2);
Q2.x = 600;
out.none.clearFirst = [tryset(Q2, 'strokesIncludedInLayout', false), tryset(Q2, 'layoutMode', 'NONE'), Q2.strokesIncludedInLayout];

// B. Rings: box-shadow 0 0 0 2px #61a6fa on a 40x24 frame, radius 6, a 1px
// INSIDE border #27272a and a text child, in a white 64x48 holder, each
// holder exported at 1x.
const ring = (sb) => ({ type: 'DROP_SHADOW', color: { r: 0x61 / 255, g: 0xa6 / 255, b: 0xfa / 255, a: 1 }, offset: { x: 0, y: 0 }, radius: 0, spread: 2, visible: true, blendMode: 'NORMAL', showShadowBehindNode: sb });
const cases = {
  noFill: [[], false, false], noFillClip: [[], true, false], clearFill: [[0], false, false], clearFillClip: [[0], true, false],
  opaque: [[1], false, false], opaqueClip: [[1], true, false], noFillBehind: [[], false, true], clearFillBehind: [[0], false, true],
  hiddenFillClip: [['h'], true, false],
};
let x = 0;
for (const [name, [fills, clip, behind]] of Object.entries(cases)) {
  const h = figma.createFrame();
  page.appendChild(h);
  h.x = x; h.y = 300; x += 80;
  h.resize(64, 48);
  h.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  h.name = 'ring ' + name;
  const b = figma.createFrame();
  h.appendChild(b);
  b.x = 12; b.y = 12;
  b.resize(40, 24);
  b.cornerRadius = 6;
  b.fills = fills.map((o) => (o === 'h' ? { type: 'SOLID', color: { r: 1, g: 1, b: 1 }, visible: false } : { type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: o }));
  b.strokes = [{ type: 'SOLID', color: { r: 0x27 / 255, g: 0x27 / 255, b: 0x2a / 255 } }];
  b.strokeWeight = 1;
  b.strokeAlign = 'INSIDE';
  b.clipsContent = clip;
  const t = figma.createText();
  b.appendChild(t);
  t.characters = 'Ok';
  t.fontSize = 10;
  t.x = 12; t.y = 5;
  const set = tryset(b, 'effects', [ring(behind)]);
  const e = b.effects[0];
  const png = await h.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
  out.ring[name] = { id: b.id, set, kept: e ? [e.spread, e.showShadowBehindNode] : null, png: figma.base64Encode(png) };
}

// C. Texts: [chars, style, size, line height, the browser's width].
const T = [['Action', 'Medium', 14, 20, 43.13], ['Basic Item', 'Medium', 14, 19.25, 69.27], ['Home', 'Regular', 14, 20, 39.05],
  ['Components', 'Regular', 14, 20, 84.4], ['Breadcrumb', 'Regular', 14, 20, 80.85],
  ['A simple item with title and description.', 'Regular', 14, 21, 260.52],
  ['Upload files to your cloud storage', 'Regular', 14, 22.75, 0], ['to access them anywhere.', 'Regular', 14, 22.75, 0],
  ['Upload files to your cloud storage to', 'Regular', 14, 22.75, 0]];
const text = (chars, style, size, lh) => {
  const t = figma.createText();
  page.appendChild(t);
  t.y = 500;
  t.fontName = { family: 'Inter', style };
  t.fontSize = size;
  t.lineHeight = { unit: 'PIXELS', value: lh };
  t.characters = chars;
  return t;
};
out.text.rows = [];
for (const [chars, style, size, lh, w] of T) {
  const t = text(chars, style, size, lh);
  const hug = t.width;
  const row = [chars, hug];
  if (w) {
    t.resize(w, lh);
    t.textAutoResize = 'HEIGHT';
    row.push(r4(t.height));
    t.resize(Math.round((w - 0.87) * 100) / 100, lh);
    row.push(r4(t.height));
  }
  out.text.rows.push(row);
  t.remove();
}
// Empty's description, centered, at the browser's box width and at its
// lines' (the ink's) width, and with a line separator at the browser's break.
const E = 'Upload files to your cloud storage to access them anywhere.';
const e1 = text(E, 'Regular', 14, 22.75);
e1.textAlignHorizontal = 'CENTER';
e1.resize(384, 22.75);
e1.textAutoResize = 'HEIGHT';
const e2 = text(E, 'Regular', 14, 22.75);
e2.textAlignHorizontal = 'CENTER';
e2.resize(223.86, 22.75);
e2.textAutoResize = 'HEIGHT';
const e3 = text(E.replace('storage to', 'storage to'), 'Regular', 14, 22.75);
e3.textAlignHorizontal = 'CENTER';
e3.resize(384, 22.75);
e3.textAutoResize = 'HEIGHT';
const codes = (s) => [...s].map((c, i) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126 ? i + ':' + c.charCodeAt(0) : null)).filter(Boolean);
const e4 = text('Upload files to your cloud storage to', 'Regular', 14, 22.75);
out.text.empty = { atBox: [e1.width, r4(e1.height)], atInk: [r4(e2.width), r4(e2.height)], sep: [e3.width, r4(e3.height), codes(e3.characters)], sepHug: [r4(e4.width), r4(e4.height)] };
// A value centered in an input's content box.
const v = text('Describe another approach', 'Regular', 14, 20);
v.resize(475.47, 26);
v.textAutoResize = 'NONE';
v.textAlignVertical = 'CENTER';
out.text.value = [r4(v.width), r4(v.height), v.textAutoResize, v.textAlignVertical];
return out;
