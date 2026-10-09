// The live text probe, call 2 of 3 (2026-10-09): the width at which Figma
// keeps a line whole, a text's height in each mode, and more orders. Sent
// after call 1, exactly as below, on its page. Its response is
// fixtures/figma-text-probe.json `call2`.
// storysync text probe 2, call 2: the width at which Figma stops wrapping a
// line, heights, and what keeps truncation. Only on "storysync probe 2".
const PAGE = 'storysync probe 2';
const page = figma.root.children.find((p) => p.name === PAGE);
if (!page || page.getSharedPluginData('storysync', 'probe2') !== '1') throw new Error('Run call 1 first: no "' + PAGE + '" page of this probe');
await figma.setCurrentPageAsync(page);
const r4 = (n) => (typeof n === 'number' ? Math.round(n * 10000) / 10000 : n);
const out = { thresholds: [], heights: {}, orders: {} };
for (const s of ['Regular', 'Medium', 'Semi Bold']) await figma.loadFontAsync({ family: 'Inter', style: s });

// 1. The narrowest width that keeps each string on one line (HEIGHT, no truncation).
const T = [['Home', 'Regular', 14, 39.047], ['Inbox', 'Regular', 14, 36.188], ['Settings', 'Regular', 14, 54.641], ['sales-dashboard.pdf', 'Medium', 14, 139.375],
  ['PDF · 2.4 MB', 'Regular', 12, 73.469], ['Login with Email Button', 'Medium', 14, 157.141], ['abcdefghijklmnopqrstuvwxyz', 'Regular', 14, 194], ['Button', 'Semi Bold', 18, 58.281]];
for (const [chars, style, size, chrome] of T) {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style };
  t.fontSize = size;
  t.characters = chars;
  t.lineHeight = { unit: 'PIXELS', value: 20 };
  t.resize(Math.ceil(chrome) + 2, 20);
  t.textAutoResize = 'HEIGHT';
  let lo = Math.floor(chrome) - 2;
  let hi = Math.ceil(chrome) + 2;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    t.resize(mid, 20);
    if (t.height > 20.5) lo = mid;
    else hi = mid;
  }
  // At Chrome's advance, and 0.004 below it.
  const at = (w) => { t.resize(w, 20); return t.height; };
  out.thresholds.push([chars, style, size, chrome, r4(hi), at(chrome), at(Math.round((chrome - 0.004) * 1000) / 1000), at(Math.round(chrome * 100) / 100)]);
  t.remove();
}

// 2. Heights: a line height of 17.5 in each mode.
const make = (chars) => {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style: 'Medium' };
  t.fontSize = 14;
  t.characters = chars;
  t.lineHeight = { unit: 'PIXELS', value: 17.5 };
  return t;
};
const hw = make('Home');
out.heights.W1 = [hw.width, hw.height];
const hh = make('Home');
hh.resize(80, 17.5);
hh.textAutoResize = 'HEIGHT';
out.heights.H1 = [hh.width, hh.height];
const h2 = make('Home Home Home');
h2.resize(80, 17.5);
h2.textAutoResize = 'HEIGHT';
out.heights.H2 = [h2.width, h2.height];
const h3 = make('Home Home Home Home Home Home');
h3.resize(80, 17.5);
h3.textAutoResize = 'HEIGHT';
out.heights.H3 = [h3.width, h3.height];
h3.textTruncation = 'ENDING';
out.heights.H3E = [h3.width, h3.height, h3.maxLines];
h3.maxLines = 2;
out.heights.H3E2 = [h3.width, h3.height, h3.maxLines];
const he = make('Home');
he.resize(80, 17.5);
he.textAutoResize = 'HEIGHT';
he.textTruncation = 'ENDING';
he.maxLines = 1;
out.heights.H1E = [he.width, he.height, he.maxLines];
for (const n of [hw, hh, h2, h3, he]) n.remove();

// 3. More orders, as in call 1: [autoResize truncation maxLines w x h] after each step that changes it.
const CH = 'sales-dashboard.pdf sales-dashboard.pdf';
let x = 0;
const parentOf = (kind) => {
  const p = figma.createAutoLayout(kind === 'col' ? 'VERTICAL' : 'HORIZONTAL');
  p.x = x;
  p.y = 800;
  x += 340;
  if (kind === 'row') { p.resize(300, 40); p.primaryAxisSizingMode = 'FIXED'; p.counterAxisSizingMode = 'FIXED'; }
  if (kind === 'col') { p.resize(94, 40); p.counterAxisSizingMode = 'FIXED'; p.primaryAxisSizingMode = 'AUTO'; }
  return p;
};
const STEP = {
  P: (t, p) => p.appendChild(t),
  F: (t) => { t.fontName = { family: 'Inter', style: 'Medium' }; },
  C: (t) => { t.characters = CH; },
  Cs: (t) => { t.characters = 'sales'; },
  Z: (t) => { t.fontSize = 14; },
  L: (t) => { t.lineHeight = { unit: 'PIXELS', value: 17.5 }; },
  E: (t) => { t.textTruncation = 'ENDING'; },
  D: (t) => { t.textTruncation = 'DISABLED'; },
  M1: (t) => { t.maxLines = 1; },
  Mn: (t) => { t.maxLines = null; },
  R: (t) => t.resize(94, 17.5),
  AH: (t) => { t.textAutoResize = 'HEIGHT'; },
  AW: (t) => { t.textAutoResize = 'WIDTH_AND_HEIGHT'; },
  AN: (t) => { t.textAutoResize = 'NONE'; },
  SX: (t) => { t.layoutSizingHorizontal = 'FIXED'; },
  SF: (t) => { t.layoutSizingHorizontal = 'FILL'; },
  SH: (t) => { t.layoutSizingHorizontal = 'HUG'; },
  VY: (t) => { t.layoutSizingVertical = 'HUG'; },
  VX: (t) => { t.layoutSizingVertical = 'FIXED'; },
  G1: (t) => { t.layoutGrow = 1; },
  ST: (t) => { t.layoutAlign = 'STRETCH'; },
};
const SEQ = {
  maxNullBack: ['row', 'P F C Z L R AH E M1 Mn M1'],
  disabledBack: ['row', 'P F C Z L R AH E M1 D E M1'],
  vertFixed: ['row', 'P F C Z L R AH E M1 VX'],
  vertFixedThenHug: ['row', 'P F C Z L R AH E M1 VX VY'],
  growRow: ['row', 'P F C Z L R AH E M1 G1'],
  stretchCol: ['col', 'P F C Z L R AH E M1 ST'],
  fillThenHug: ['col', 'P F C Z L R AH E M1 SF SX'],
  wideNoTrunc: ['row', 'P F Cs Z L R AH E M1'],
  hugToFixed: ['row', 'P F C Z L AW SX'],
  resizeAuto: ['row', 'P F C Z L AW E M1 R AH E M1'],
};
const state = (t) => t.textAutoResize[0] + t.textTruncation[0] + (t.maxLines === null ? '-' : t.maxLines) + ' ' + r4(t.width) + 'x' + r4(t.height);
for (const [name, [kind, steps]] of Object.entries(SEQ)) {
  const p = parentOf(kind);
  const t = figma.createText();
  t.name = name;
  const trail = [];
  let last = state(t);
  try {
    for (const s of steps.split(' ')) {
      STEP[s](t, p);
      const now = state(t);
      trail.push(s + (now === last ? '' : ' -> ' + now));
      last = now;
    }
  } catch (e) {
    trail.push('error ' + String(e.message || e).slice(0, 120));
  }
  out.orders[name] = trail.join(' | ');
}
return out;
