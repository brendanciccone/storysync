// storysync probe 8a, call 2 (2026-10-13): call 1 saw a ring (a drop
// shadow of spread 2, no blur) draw only on a frame that clips and has an
// opaque fill. Which fill draws it and paints nothing itself: a white fill
// multiplied (backdrop times white is the backdrop), a white fill at 1%,
// a gradient of clear stops; each on a frame that clips, over a dark and a
// light holder, exported as PNG. Only on "storysync probe 8a".
const PAGE = 'storysync probe 8a';
const page = figma.root.children.find((p) => p.name === PAGE);
if (!page || page.getSharedPluginData('storysync', 'probe8a') !== '1') throw new Error('Run call 1 first: no "' + PAGE + '" page of this probe');
await figma.setCurrentPageAsync(page);
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
const ring = { type: 'DROP_SHADOW', color: { r: 0x61 / 255, g: 0xa6 / 255, b: 0xfa / 255, a: 1 }, offset: { x: 0, y: 0 }, radius: 0, spread: 2, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false };
const W = { r: 1, g: 1, b: 1 };
const fills = {
  multiply: [{ type: 'SOLID', color: W, blendMode: 'MULTIPLY' }],
  onePercent: [{ type: 'SOLID', color: W, opacity: 0.01 }],
  clearGradient: [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 0 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 0 } }] }],
};
const out = { rings: {} };
let x = 0;
for (const [name, paints] of Object.entries(fills)) {
  for (const [shade, bg] of [['dark', { r: 9 / 255, g: 9 / 255, b: 11 / 255 }], ['light', { r: 0.96, g: 0.96, b: 0.96 }]]) {
    const h = figma.createFrame();
    page.appendChild(h);
    h.x = x; h.y = 450; x += 80;
    h.resize(64, 48);
    h.fills = [{ type: 'SOLID', color: bg }];
    h.name = 'ring ' + name + ' ' + shade;
    const b = figma.createFrame();
    h.appendChild(b);
    b.x = 12; b.y = 12;
    b.resize(40, 24);
    b.cornerRadius = 6;
    b.fills = paints;
    b.strokes = [{ type: 'SOLID', color: { r: 0x27 / 255, g: 0x27 / 255, b: 0x2a / 255 } }];
    b.strokeWeight = 1;
    b.strokeAlign = 'INSIDE';
    b.clipsContent = true;
    const t = figma.createText();
    b.appendChild(t);
    t.characters = 'Ok';
    t.fontSize = 10;
    t.x = 12; t.y = 5;
    b.effects = [ring];
    const png = await h.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
    out.rings[name + ' ' + shade] = { id: b.id, fills: b.fills.map((p) => [p.type, p.blendMode, p.opacity]), png: figma.base64Encode(png) };
  }
}
return out;
