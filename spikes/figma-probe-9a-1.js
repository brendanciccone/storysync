const NS = 'storysync';
let page = figma.root.children.find((p) => p.name === 'storysync probe 9a');
if (!page) { page = figma.createPage(); page.name = 'storysync probe 9a'; }
await figma.setCurrentPageAsync(page);
const out = { page: page.id };
// 1. Shared plugin data of 45,000 characters on a page, 24,000 on the document, run as code.
page.setSharedPluginData(NS, 'probe9a.part', 'x'.repeat(45000));
out.pagePart = page.getSharedPluginData(NS, 'probe9a.part').length;
figma.root.setSharedPluginData(NS, 'probe9a.T', 'return [A * 7, typeof figma.root];//' + 'y'.repeat(24000));
const T = figma.root.getSharedPluginData(NS, 'probe9a.T');
out.rootT = T.length;
out.ran = await new (async () => {}).constructor('figma', 'A', T)(figma, 6);
try {
  page.setSharedPluginData(NS, 'probe9a.over', 'z'.repeat(101000));
  out.over = 'kept ' + page.getSharedPluginData(NS, 'probe9a.over').length;
  page.setSharedPluginData(NS, 'probe9a.over', '');
} catch (e) { out.over = String((e && e.message) || e).slice(0, 160); }
// 2. Text boxes: hugging, fixed width, fixed size; whole-pixel rounding.
out.geist = (await figma.listAvailableFontsAsync()).filter((f) => f.fontName.family === 'Geist').map((f) => f.fontName.style);
const inter = { family: 'Inter', style: 'Regular' };
await figma.loadFontAsync(inter);
const geist = out.geist.includes('Medium') ? { family: 'Geist', style: 'Medium' } : null;
if (geist) await figma.loadFontAsync(geist);
const r3 = (v) => Math.round(v * 1000) / 1000;
const box = (n) => [n.x, n.y, n.width, n.height].map(r3);
const text = (s, lh, mode, font) => {
  const t = figma.createText();
  t.fontName = font || inter; t.characters = s; t.fontSize = 14;
  t.lineHeight = lh ? { unit: 'PIXELS', value: lh } : { unit: 'AUTO' };
  if (mode) t.textAutoResize = mode;
  return t;
};
const row = (name) => {
  const f = figma.createAutoLayout('HORIZONTAL', { name, itemSpacing: 6 });
  f.fills = []; f.y = 0; page.appendChild(f);
  return f;
};
const words = ['Home', 'Components', 'Breadcrumb'];
// a. A hugging row of hugging texts.
const a = row('a hug');
for (const w of words) a.appendChild(text(w, 19.25, 'WIDTH_AND_HEIGHT'));
out.a = { frame: box(a), kids: a.children.map(box) };
// b. The same texts fixed at fractional sizes (NONE), the row hugging them.
const b = row('b fixed'); b.y = 40;
for (const [w, s] of [['Home', [39.05, 19.25]], ['Components', [84.4, 19.25]], ['Breadcrumb', [80.85, 19.25]]]) {
  const t = text(w, 19.25, 'NONE'); t.resize(s[0], s[1]); b.appendChild(t);
}
out.b = { frame: box(b), kids: b.children.map(box), modes: b.children.map((t) => t.textAutoResize) };
// c. Fixed width, auto height (HEIGHT): one line and two at 19.25.
const c1 = text('Home', 19.25, 'HEIGHT'); c1.resize(39.05, 10); c1.textAutoResize = 'HEIGHT';
const c2 = text('Home Home Home Home Home', 19.25, 'HEIGHT'); c2.resize(80.85, 10); c2.textAutoResize = 'HEIGHT';
out.c = [box(c1), box(c2)];
// d. A fixed width in a hugging row: FIXED sizing on a NONE text, and a frame of a fractional size.
const d = figma.createFrame(); d.resize(272.29, 19.25); out.d = box(d);
// e. Geist Medium 14 "Select a fruit": hugging, then fixed at 84.5 with one line, truncated.
if (geist) {
  const e1 = text('Select a fruit', 24, 'WIDTH_AND_HEIGHT', geist);
  const e2 = text('Select a fruit', 24, 'NONE', geist); e2.resize(84.5, 24); e2.textTruncation = 'ENDING'; e2.maxLines = 1;
  const e3 = text('Select a fruit', 24, 'HEIGHT', geist); e3.resize(84.5, 24); e3.textAutoResize = 'HEIGHT';
  out.e = { hug: box(e1), fixedTruncated: box(e2), wrapsAt845: box(e3) };
}
for (const n of page.children.filter((n) => n.type === 'TEXT' || n.type === 'FRAME')) n.y += 200;
// 3. For the next call: a plain component with an instance; a set of two with an instance.
const plain = figma.createComponent(); plain.name = 'Probe Plain'; plain.resize(40, 20); plain.x = 600;
const pi = plain.createInstance(); pi.x = 700;
const sm = figma.createComponent(); sm.name = 'size=sm'; sm.resize(30, 20);
const lg = figma.createComponent(); lg.name = 'size=lg'; lg.resize(50, 20); lg.x = 40;
const set = figma.combineAsVariants([sm, lg], page); set.name = 'Probe Set'; set.x = 600; set.y = 100;
const si = sm.createInstance(); si.x = 800; si.y = 100;
out.ids = { plain: plain.id, plainInstance: pi.id, set: set.id, sm: sm.id, lg: lg.id, setInstance: si.id };
return out;
