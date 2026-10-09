// The live text probe, call 1 of 3 (2026-10-09): how wide Figma sets text
// in its fonts, and in which order of textTruncation, maxLines, resize(),
// textAutoResize and layout sizing it keeps truncation. Sent to use_figma
// exactly as below, in the third live push's file, on a page of its own,
// "storysync probe 2", which it creates and marks; it changes nothing else.
// Its response is cli/__tests__/fixtures/figma-text-probe.json `call1`,
// unchanged; mock-figma.test.ts runs it in the mock and holds the mock to it.
// storysync text probe 2: font widths and the order in which Figma keeps
// text truncation. Works only on its own page, "storysync probe 2".
const PAGE = 'storysync probe 2';
let page = figma.root.children.find((p) => p.name === PAGE);
if (page && page.getSharedPluginData('storysync', 'probe2') !== '1') throw new Error('A page named "' + PAGE + '" exists that this probe did not create');
if (!page) {
  page = figma.createPage();
  page.name = PAGE;
  page.setSharedPluginData('storysync', 'probe2', '1');
}
await figma.setCurrentPageAsync(page);
for (const n of [...page.children]) n.remove();
const out = { page: page.id, fonts: {}, widths: [], orders: {} };
const r3 = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n === figma.mixed ? 'mixed' : n);

// 1. Fonts: variation axes and styles.
const avail = await figma.listAvailableFontsAsync();
for (const fam of ['Inter', 'Inter Display', 'Roboto Mono', 'Noto Serif', 'Geist', 'Geist Mono']) {
  let axes = 'n/a';
  try { axes = figma.getFontFamilyVariationAxes ? figma.getFontFamilyVariationAxes(fam) : 'no api'; } catch (e) { axes = 'error: ' + String(e.message || e).slice(0, 60); }
  out.fonts[fam] = { axes, styles: avail.filter((f) => f.fontName.family === fam).map((f) => f.fontName.style) };
}

// 2. Widths of hugging texts.
const W = [
  ['Home', 'Inter', 'Regular', 14], ['Inbox', 'Inter', 'Regular', 14], ['Calendar', 'Inter', 'Regular', 14], ['Search', 'Inter', 'Regular', 14], ['Settings', 'Inter', 'Regular', 14],
  ['Application', 'Inter', 'Medium', 12], ['sales-dashboard.pdf', 'Inter', 'Medium', 14], ['sales-dashboard.pdf', 'Inter', 'Medium', 12], ['PDF · 2.4 MB', 'Inter', 'Regular', 12],
  ['Login with Email Button', 'Inter', 'Medium', 14], ['Login with Email Button', 'Inter', 'Medium', 12], ['Badge', 'Inter', 'Medium', 12], ['Button', 'Inter', 'Medium', 12], ['Button', 'Inter', 'Medium', 14],
  ['Close', 'Inter', 'Medium', 14], ['Notifications', 'Inter', 'Medium', 14], ['Notifications', 'Inter', 'Medium', 16],
  ['1 hour ago', 'Inter', 'Regular', 14], ['2 hours ago', 'Inter', 'Regular', 14], ['You have 3 unread messages.', 'Inter', 'Regular', 14], ['You have a new message!', 'Inter', 'Regular', 14],
  ['Your call has been confirmed.', 'Inter', 'Regular', 14], ['Your subscription is expiring soon!', 'Inter', 'Regular', 14],
  ['Button', 'Inter', 'Semi Bold', 12], ['Button', 'Inter', 'Semi Bold', 18],
  ['Heading text', 'Inter', 'Semi Bold', 24], ['Heading text', 'Inter', 'Bold', 32], ['Display heading', 'Inter', 'Bold', 48],
  ['abcdefghijklmnopqrstuvwxyz', 'Inter', 'Regular', 14], ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'Inter', 'Regular', 14], ['0123456789 .,:;!?-()', 'Inter', 'Regular', 14],
  ['abcdefghijklmnopqrstuvwxyz', 'Inter', 'Medium', 14], ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'Inter', 'Semi Bold', 14], ['Type AV To Wa', 'Inter', 'Regular', 14], ['Type AV To Wa', 'Inter', 'Regular', 100],
  ['const x = 42;', 'Roboto Mono', 'Regular', 14], ['npm run build', 'Roboto Mono', 'Medium', 12],
  ['The quick brown fox', 'Noto Serif', 'Regular', 16], ['Quietly Waving', 'Noto Serif', 'Bold', 20],
];
const loaded = {};
for (const [chars, family, style, size] of W) {
  const id = family + style;
  try {
    await (loaded[id] = loaded[id] || figma.loadFontAsync({ family, style }));
    const t = figma.createText();
    t.fontName = { family, style };
    t.fontSize = size;
    t.characters = chars;
    const rb = t.absoluteRenderBounds;
    out.widths.push([chars, family, style, size, r3(t.width), r3(t.height), rb ? r3(rb.width) : null, t.textAutoResize]);
    t.remove();
  } catch (e) {
    out.widths.push([chars, family, style, size, 'error: ' + String(e.message || e).slice(0, 80)]);
  }
}

// 3. Truncation: which order keeps it. Each sequence builds one text and
// records [step, textAutoResize, textTruncation, maxLines, w, h] after each step.
await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
const CH = 'sales-dashboard.pdf sales-dashboard.pdf';
let x = 0;
const parentOf = (kind) => {
  if (kind === 'none') return null;
  const p = figma.createAutoLayout(kind === 'col' ? 'VERTICAL' : 'HORIZONTAL');
  p.x = x;
  p.y = 400;
  x += 340;
  if (kind === 'row') { p.resize(300, 40); p.primaryAxisSizingMode = 'FIXED'; p.counterAxisSizingMode = 'FIXED'; }
  if (kind === 'col') { p.resize(94, 40); p.counterAxisSizingMode = 'FIXED'; p.primaryAxisSizingMode = 'AUTO'; }
  return p;
};
const STEP = {
  P: (t, p) => p && p.appendChild(t),
  F: (t) => { t.fontName = { family: 'Inter', style: 'Medium' }; },
  C: (t) => { t.characters = CH; },
  Z: (t) => { t.fontSize = 14; },
  L: (t) => { t.lineHeight = { unit: 'PIXELS', value: 17.5 }; },
  E: (t) => { t.textTruncation = 'ENDING'; },
  D: (t) => { t.textTruncation = 'DISABLED'; },
  M1: (t) => { t.maxLines = 1; },
  M2: (t) => { t.maxLines = 2; },
  Mn: (t) => { t.maxLines = null; },
  R: (t) => t.resize(94, 17.5),
  R2: (t) => t.resize(94, 35),
  AH: (t) => { t.textAutoResize = 'HEIGHT'; },
  AW: (t) => { t.textAutoResize = 'WIDTH_AND_HEIGHT'; },
  AN: (t) => { t.textAutoResize = 'NONE'; },
  SX: (t) => { t.layoutSizingHorizontal = 'FIXED'; },
  SH: (t) => { t.layoutSizingHorizontal = 'HUG'; },
  SF: (t) => { t.layoutSizingHorizontal = 'FILL'; },
  VY: (t) => { t.layoutSizingVertical = 'HUG'; },
  VX: (t) => { t.layoutSizingVertical = 'FIXED'; },
};
const SEQ = {
  buildNow: ['row', 'P F C Z L E M1 R AH SX VY'],
  spike: ['row', 'P F C Z L R AH E M1 SX VY'],
  truncLast: ['row', 'P F C Z L R AH SX VY E M1'],
  colFillA: ['col', 'P F C Z L R AH E M1 SF VY'],
  colFillB: ['col', 'P F C Z L R AH SF VY E M1'],
  rowGrow: ['row', 'P F C Z L R AH E M1 SF VY'],
  hugTrunc: ['row', 'P F C Z L R AH E M1 SH VY'],
  widthAuto: ['row', 'P F C Z L AW E M1'],
  noResize: ['row', 'P F C Z L E M1 AH'],
  resizeOnly: ['row', 'P F C Z L E M1 R'],
  resizeAfter: ['row', 'P F C Z L R AH E M1 R'],
  rerun: ['row', 'P F C Z L R AH E M1 SX VY F C Z L E M1 R AH SX VY'],
  rerunSpike: ['row', 'P F C Z L R AH E M1 SX VY F C Z L R AH E M1 SX VY'],
  none: ['row', 'P F C Z L R AN E M1'],
  noneNoMax: ['row', 'P F C Z L R AN E'],
  clamp2: ['row', 'P F C Z L R2 AH E M2 SX VY'],
  fontAfter: ['row', 'P F C Z L R AH E M1 F C Z L'],
  measureFirst: ['row', 'P F C Z L AW R AH E M1 SX VY'],
  page: ['none', 'F C Z L E M1 R AH'],
  pageSpike: ['none', 'F C Z L R AH E M1'],
};
// Compact: autoResize initial (W, H, N, T), truncation initial (D, E), maxLines, width x height.
const state = (t) => t.textAutoResize[0] + t.textTruncation[0] + (t.maxLines === null ? '-' : t.maxLines) + ' ' + r3(t.width) + 'x' + r3(t.height);
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
      // Only the steps that change something.
      trail.push(s + (now === last ? '' : ' -> ' + now));
      last = now;
    }
  } catch (e) {
    trail.push(['error', String(e.message || e).slice(0, 120)]);
  }
  out.orders[name] = trail.join(' | ');
  if (!p) { t.x = x; t.y = 400; x += 120; }
}
return out;
