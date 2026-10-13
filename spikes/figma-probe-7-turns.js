// storysync probe 7, call 1: layers turned 180 degrees, or 90 when square,
// in an auto layout's flow, set up in the order templates/build.js sets a
// layer (rotation, then its sizing). Where Figma lays a turned layer out by
// its turned box, as the sixth probe saw at 45 degrees, these take the
// slot the unturned box would, and the next layer lands where CSS puts it.
let page = figma.root.children.find((p) => p.name === 'storysync probe 6');
if (!page) { page = figma.createPage(); page.name = 'storysync probe 6'; }
await figma.setCurrentPageAsync(page);
const r = (v) => Math.round(v * 1000) / 1000;
const ids = [];
const left = Math.max(0, ...page.children.map((n) => n.x + n.width)) + 100;
const black = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
const row = (name, y, mode, w, h, hug) => {
  const f = figma.createFrame();
  f.name = name;
  page.appendChild(f);
  f.x = left;
  f.y = y;
  f.layoutMode = mode;
  f.itemSpacing = 4;
  f.paddingLeft = f.paddingRight = f.paddingTop = f.paddingBottom = 0;
  f.counterAxisAlignItems = 'CENTER';
  f.resize(w, h);
  f.primaryAxisSizingMode = hug ? 'AUTO' : 'FIXED';
  f.counterAxisSizingMode = hug ? 'AUTO' : 'FIXED';
  ids.push(f.id);
  return f;
};
const box = (name, parent, w, h, rotation, sizing) => {
  const n = figma.createFrame();
  n.name = name;
  n.fills = black;
  n.resize(w, h);
  parent.appendChild(n);
  if (rotation !== undefined) n.rotation = rotation;
  n.layoutSizingHorizontal = sizing || 'FIXED';
  n.layoutSizingVertical = 'FIXED';
  ids.push(n.id);
  return n;
};
const info = (n) => ({
  x: r(n.x), y: r(n.y), w: r(n.width), h: r(n.height), rot: r(n.rotation),
  rt: n.relativeTransform.map((row) => row.map(r)), sizing: [n.layoutSizingHorizontal, n.layoutSizingVertical],
});
const out = {};
// 1: a row, fixed 200 by 40, centered across: a 20 by 6 bar turned 180, a
// 10 square, a 16 square turned 90 clockwise (Figma -90), a 10 square.
const r1 = row('turns in a row', 0, 'HORIZONTAL', 200, 40);
const p = box('p 20x6 rot -180', r1, 20, 6, -180);
const q = box('q 10x10 after p', r1, 10, 10);
const s = box('s 16x16 rot -90', r1, 16, 16, -90);
const u = box('u 10x10 after s', r1, 10, 10);
out.row = { frame: info(r1), p: info(p), q: info(q), s: info(s), u: info(u) };
// 2: a column, fixed 100 by 100, centered across: the bar turned 180, a 10 square.
const r2 = row('turns in a column', 60, 'VERTICAL', 100, 100);
const p2 = box('p2 20x6 rot 180', r2, 20, 6, 180);
const q2 = box('q2 10x10 after p2', r2, 10, 10);
out.column = { frame: info(r2), p: info(p2), q: info(q2) };
// 3: a row that hugs both ways: the bar turned 180, a 10 square.
const r3 = row('turns in a hugging row', 180, 'HORIZONTAL', 50, 50, true);
const p3 = box('p3 20x6 rot -180', r3, 20, 6, -180);
const q3 = box('q3 10x10 after p3', r3, 10, 10);
out.hug = { frame: info(r3), p: info(p3), q: info(q3) };
// 4: a fixed row, the bar turned 180 filling it, a 10 square.
const r4 = row('turned fill', 240, 'HORIZONTAL', 200, 40);
const p4 = box('p4 20x6 rot -180 FILL', r4, 20, 6, -180, 'FILL');
const q4 = box('q4 10x10 after p4', r4, 10, 10);
out.fill = { frame: info(r4), p: info(p4), q: info(q4) };
// 5: turned, then resized, as a build over an earlier one resizes a layer.
const r5 = row('turned then resized', 300, 'HORIZONTAL', 200, 40);
const p5 = box('p5 20x6 rot -180 then 24x8', r5, 20, 6, -180);
p5.resize(24, 8);
const q5 = box('q5 10x10 after p5', r5, 10, 10);
out.resized = { frame: info(r5), p: info(p5), q: info(q5) };
// 6: a hugging text turned 180 in a row, a 10 square after it.
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
const r6 = row('turned text', 360, 'HORIZONTAL', 200, 40);
const t = figma.createText();
t.fontName = { family: 'Inter', style: 'Regular' };
t.characters = 'Ab';
t.fontSize = 14;
r6.appendChild(t);
t.rotation = -180;
t.layoutSizingHorizontal = 'HUG';
t.layoutSizingVertical = 'HUG';
ids.push(t.id);
const q6 = box('q6 10x10 after text', r6, 10, 10);
out.text = { frame: info(r6), t: Object.assign(info(t), { autoResize: t.textAutoResize }), q: info(q6) };
// 7: a 20 by 6 bar turned 90 in a row, which is not square: the control.
const r7 = row('non-square 90', 420, 'HORIZONTAL', 200, 40);
const p7 = box('p7 20x6 rot -90', r7, 20, 6, -90);
const q7 = box('q7 10x10 after p7', r7, 10, 10);
out.oblong90 = { frame: info(r7), p: info(p7), q: info(q7) };
out.ids = ids;
return out;
