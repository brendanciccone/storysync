// storysync probe 7b, call 1: a ring (box-shadow 0 0 0 1px at 10% alpha,
// shadcn/ui's `ring-1 ring-foreground/10`) with its color bound to a
// variable, in each mode of the variable's collection. A: a drop shadow,
// spread only, its color bound with setBoundVariableForEffect, the alpha
// set before binding. A2: the same, then assigned once more with the alpha
// put back, as templates/build.js does for a bound paint's opacity. B: an
// OUTSIDE 1px stroke, its paint bound with the alpha as the paint's
// opacity, assigned the same way. Each is read back and exported as SVG,
// whose feColorMatrix (a shadow) or stroke attributes say what Figma draws.
const PAGE = 'storysync probe 7b';
let page = figma.root.children.find((p) => p.name === PAGE);
if (!page) { page = figma.createPage(); page.name = PAGE; }
await figma.setCurrentPageAsync(page);
for (const c of [...page.children]) c.remove();
const found = (await figma.variables.getLocalVariablesAsync('COLOR')).filter((v) => v.name === 'foreground');
if (found.length !== 1) return { error: found.length + ' COLOR variables named foreground' };
const fg = found[0];
const col = await figma.variables.getVariableCollectionByIdAsync(fg.variableCollectionId);
const r3 = (n) => Math.round(n * 1000) / 1000;
const c4 = (c) => c && [r3(c.r), r3(c.g), r3(c.b), c.a === undefined ? null : r3(c.a)];
const A = 26 / 255;
const shadow = { type: 'DROP_SHADOW', color: { r: 10 / 255, g: 10 / 255, b: 10 / 255, a: A }, offset: { x: 0, y: 0 }, radius: 0, spread: 1, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false };
const ids = [];
const frame = (name, x, y, mode) => {
  const f = figma.createFrame();
  page.appendChild(f);
  f.name = name;
  f.resize(100, 60);
  f.x = x;
  f.y = y;
  f.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  f.cornerRadius = 14;
  f.setExplicitVariableModeForCollection(col, mode.modeId);
  ids.push(f.id);
  return f;
};
const read = (n) => ({
  effects: n.effects.map((e) => ({ color: c4(e.color), bound: e.boundVariables && e.boundVariables.color ? e.boundVariables.color.id : null })),
  strokes: n.strokes.map((p) => ({ color: c4(p.color), opacity: r3(p.opacity), bound: p.boundVariables && p.boundVariables.color ? p.boundVariables.color.id : null })),
  align: n.strokeAlign, size: [n.width, n.height],
});
const svg = async (n) => {
  const s = await n.exportAsync({ format: 'SVG_STRING' });
  return (s.match(/<feColorMatrix[^>]*values="[^"]*"[^>]*>|<feMorphology[^>]*>/g) || []).concat(s.match(/stroke(-opacity|-width)?="[^"]*"/g) || []);
};
const out = { variable: fg.id, modes: {}, nodes: {} };
let y = 0;
for (const mode of col.modes) {
  out.modes[mode.name] = c4(fg.valuesByMode[mode.modeId]);
  const a = frame('A effect bound, ' + mode.name, 0, y, mode);
  a.effects = [figma.variables.setBoundVariableForEffect(shadow, 'color', fg)];
  const a2 = frame('A2 effect bound, alpha put back, ' + mode.name, 150, y, mode);
  a2.effects = [figma.variables.setBoundVariableForEffect(shadow, 'color', fg)];
  a2.effects = a2.effects.map((e) => Object.assign({}, e, { color: Object.assign({}, e.color, { a: A }) }));
  const b = frame('B outside stroke bound, ' + mode.name, 300, y, mode);
  const p = figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 10 / 255, g: 10 / 255, b: 10 / 255 }, opacity: A }, 'color', fg);
  b.strokes = [p];
  b.strokes = b.strokes.map((q) => Object.assign({}, q, { opacity: A }));
  b.strokeWeight = 1;
  b.strokeAlign = 'OUTSIDE';
  out.nodes[mode.name] = {
    A: Object.assign(read(a), { svg: await svg(a) }),
    A2: Object.assign(read(a2), { svg: await svg(a2) }),
    B: Object.assign(read(b), { svg: await svg(b) }),
  };
  y += 100;
}
out.createdNodeIds = ids;
return out;
