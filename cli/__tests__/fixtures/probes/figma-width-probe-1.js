// The fourth push's text probe, call 1 of 4 (2026-10-09): the width at
// which Figma keeps each string on one line, measured on a fresh text each
// time, and the Attachment title as the push built it. Sent to use_figma
// exactly as below in the fourth push's file, on a page of its own,
// "storysync probe 3", which it creates and marks; it changes nothing else.
// Its response is cli/__tests__/fixtures/figma-text-probe-3.json `call1`.
// storysync probe 3, call 1: the width at which Figma keeps each string on
// one line, measured on a fresh text each time. Only on "storysync probe 3".
const PAGE = 'storysync probe 3';
let page = figma.root.children.find((p) => p.name === PAGE);
if (page && page.getSharedPluginData('storysync', 'probe3') !== '1') throw new Error('A page named "' + PAGE + '" exists that this probe did not create');
if (!page) {
  page = figma.createPage();
  page.name = PAGE;
  page.setSharedPluginData('storysync', 'probe3', '1');
}
await figma.setCurrentPageAsync(page);
for (const n of [...page.children]) n.remove();
const STYLE = { 400: 'Regular', 500: 'Medium', 600: 'Semi Bold' };
for (const s of Object.values(STYLE)) await figma.loadFontAsync({ family: 'Inter', style: s });
const r5 = (n) => Math.round(n * 1e5) / 1e5;
const out = { page: page.id, axes: null, fontName: null, rows: [], attachment: {}, sameNode: null };
try { out.axes = figma.getFontFamilyVariationAxes('Inter'); } catch (e) { out.axes = 'error: ' + String(e.message || e).slice(0, 80); }
const make = (s, w, z, lh) => {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style: STYLE[w] };
  t.fontSize = z;
  t.characters = s;
  if (lh) t.lineHeight = { unit: 'PIXELS', value: lh };
  return t;
};
// One line at this width: a fresh text, resized, then HEIGHT.
const fits = (s, w, z, width) => {
  const t = make(s, w, z, 20);
  t.resize(width, 20);
  t.textAutoResize = 'HEIGHT';
  const h = t.height;
  t.remove();
  return h < 30;
};
const S = [
  ['sales-dashboard.pdf', 500, 14], ['sales-dashboard.pdf', 500, 12], ['PDF · 2.4 MB', 400, 12],
  ['Login with Email Button', 500, 14], ['Login with Email Button', 500, 12],
  ['Home', 400, 14], ['Inbox', 400, 14], ['Calendar', 400, 14], ['Search', 400, 14], ['Settings', 400, 14], ['Application', 500, 12],
  ['Notifications', 500, 16], ['Notifications', 500, 14], ['Close', 500, 14],
  ['You have 3 unread messages.', 400, 14], ['Your call has been confirmed.', 400, 14], ['1 hour ago', 400, 14],
  ['You have a new message!', 400, 14], ['Your subscription is expiring soon!', 400, 14], ['2 hours ago', 400, 14],
  ['Button', 500, 14], ['Button', 500, 12], ['Button', 600, 18], ['Badge', 500, 12],
  ['abcdefghijklmnopqrstuvwxyz', 400, 14], ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 400, 14], ['0123456789 .,:;!?-()', 400, 14],
  ['abcdefghijklmnopqrstuvwxyz', 500, 14], ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 600, 14], ['Type AV To Wa', 400, 14],
  ['f', 500, 14], ['pdf', 500, 14], ['sales', 500, 14], ['-', 500, 14], ['s-d', 500, 14], ['iiiiiiiiii', 400, 14], ['mmmmmmmmmm', 400, 14],
];
for (const [s, w, z] of S) {
  // Hugging: its width, rounded up, and its ink against its own x.
  const t = make(s, w, z);
  const auto = t.width;
  const rb = t.absoluteRenderBounds;
  const ink = rb ? [r5(rb.x - t.absoluteTransform[0][2]), r5(rb.width)] : null;
  if (!out.fontName && w === 500) out.fontName = t.fontName;
  t.remove();
  // A hundred times the size, to read the advance to 0.01.
  let big = null;
  try {
    const b = make(s, w, z * 100);
    big = r5(b.width / 100);
    b.remove();
  } catch (e) {
    big = 'error: ' + String(e.message || e).slice(0, 60);
  }
  // The narrowest width that keeps it on one line.
  let lo = auto - 1.5;
  let hi = auto + 0.5;
  const ends = [fits(s, w, z, lo), fits(s, w, z, hi)];
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (fits(s, w, z, mid)) hi = mid;
    else lo = mid;
  }
  out.rows.push([s, w, z, auto, big, r5(hi), ink, ends]);
}

// The Attachment title as the fourth push built it: 139.38 wide, lines of
// 17.5, filling a fixed column, and on a text of its own.
const col = figma.createAutoLayout('VERTICAL');
col.resize(139.38, 40);
col.counterAxisSizingMode = 'FIXED';
const title = make('sales-dashboard.pdf', 500, 14, 17.5);
col.appendChild(title);
title.layoutSizingHorizontal = 'FILL';
title.textAutoResize = 'HEIGHT';
out.attachment.fill = [r5(title.width), title.height];
title.textTruncation = 'ENDING';
title.maxLines = 1;
title.maxLines = null;
out.attachment.fillEndingNoMax = [r5(title.width), title.height, title.maxLines];
col.remove();
for (const width of [139.375, 139.38, 139.39, 139.4, 139.42, 139.45, 139.5, 140]) {
  const t = make('sales-dashboard.pdf', 500, 14, 17.5);
  t.resize(width, 17.5);
  t.textAutoResize = 'HEIGHT';
  out.attachment[width] = t.height;
  t.remove();
}

// The second probe's way: one text, resized again and again.
const one = make('sales-dashboard.pdf', 500, 14, 20);
one.resize(141.375, 20);
one.textAutoResize = 'HEIGHT';
let lo = 137;
let hi = 142;
for (let i = 0; i < 24; i++) {
  const mid = (lo + hi) / 2;
  one.resize(mid, 20);
  if (one.height > 20.5) lo = mid;
  else hi = mid;
}
out.sameNode = [r5(hi), one.textAutoResize];
one.remove();
return out;
