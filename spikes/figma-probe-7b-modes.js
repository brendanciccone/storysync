// storysync probe 7b, call 2: a ring bound as templates/build.js binds it,
// in the page's default mode, then shown in Dark the ways a designer
// would, after the binding. Call 1 set each frame's mode before binding.
// C: the frame's own mode set to Dark, then Light. D: a frame around it
// set to Dark. E: a component whose ring is bound so, and an instance of
// it in a frame set to Dark. F: the OUTSIDE stroke fallback, its paint
// bound with the alpha as its opacity, then its own mode set to Dark.
// G and H: a ring and a stroke left in the default mode, kept for a third
// call, which C to F made unneeded. Each is read back, with the SVG
// export's feColorMatrix (a shadow) or stroke attributes, which say what
// Figma draws. As run, 2026-10-13: cli/__tests__/fixtures/figma-probe-7b.json.
const PAGE = 'storysync probe 7b';
const page = figma.root.children.find((p) => p.name === PAGE);
if (!page) return { error: 'no page ' + PAGE };
await figma.setCurrentPageAsync(page);
const found = (await figma.variables.getLocalVariablesAsync('COLOR')).filter((v) => v.name === 'foreground');
if (found.length !== 1) return { error: found.length + ' COLOR variables named foreground' };
const fg = found[0];
const col = await figma.variables.getVariableCollectionByIdAsync(fg.variableCollectionId);
const dark = col.modes.find((m) => m.name === 'Dark');
const light = col.modes.find((m) => m.name === 'Light');
const r3 = (n) => Math.round(n * 1000) / 1000;
const c4 = (c) => c && [r3(c.r), r3(c.g), r3(c.b), c.a === undefined ? null : r3(c.a)];
const A = 26 / 255;
const shadow = { type: 'DROP_SHADOW', color: { r: 10 / 255, g: 10 / 255, b: 10 / 255, a: A }, offset: { x: 0, y: 0 }, radius: 0, spread: 1, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false };
const ids = [];
const top = Math.max(0, ...page.children.map((n) => n.y + n.height)) + 100;
// As templates/build.js: bind, assign, then assign again with the alpha put back.
const ring = (n) => {
  n.effects = [figma.variables.setBoundVariableForEffect(shadow, 'color', fg)];
  n.effects = n.effects.map((e) => (e.boundVariables && e.boundVariables.color ? Object.assign({}, e, { color: Object.assign({}, e.color, { a: A }) }) : e));
};
const outline = (n) => {
  n.strokes = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 10 / 255, g: 10 / 255, b: 10 / 255 }, opacity: A }, 'color', fg)];
  n.strokes = n.strokes.map((q) => Object.assign({}, q, { opacity: A }));
  n.strokeWeight = 1;
  n.strokeAlign = 'OUTSIDE';
};
const box = (name, parent, x, y, component) => {
  const f = component ? figma.createComponent() : figma.createFrame();
  parent.appendChild(f);
  f.name = name;
  f.resize(100, 60);
  f.x = x;
  f.y = y;
  f.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  f.cornerRadius = 14;
  ids.push(f.id);
  return f;
};
const wrap = (name, x) => {
  const w = box(name, page, x, top);
  w.resize(140, 100);
  w.fills = [];
  return w;
};
const modeOf = (n) => (col.modes.find((m) => m.modeId === n.resolvedVariableModes[col.id]) || {}).name;
const svg = async (n) => {
  const s = await n.exportAsync({ format: 'SVG_STRING' });
  return (s.match(/<feColorMatrix type="matrix"[^>]*>/g) || []).concat(s.match(/stroke(-opacity)?="[^"]*"/g) || []);
};
const read = async (n, drawn) => ({
  mode: modeOf(n),
  effects: n.effects.map((e) => ({ color: c4(e.color), bound: e.boundVariables && e.boundVariables.color ? e.boundVariables.color.id : null })),
  strokes: n.strokes.map((p) => ({ color: c4(p.color), opacity: r3(p.opacity), bound: p.boundVariables && p.boundVariables.color ? p.boundVariables.color.id : null })),
  svg: await svg(drawn || n),
});
const out = { variable: fg.id, defaultMode: (col.modes.find((m) => m.modeId === col.defaultModeId) || {}).name, pageModes: Object.keys(page.explicitVariableModes || {}).length, nodes: {} };

const c = box('C ring, built default, own mode Dark then Light', page, 0, top);
ring(c);
out.nodes.C = { built: await read(c) };
c.setExplicitVariableModeForCollection(col, dark.modeId);
out.nodes.C.dark = await read(c);
c.setExplicitVariableModeForCollection(col, light.modeId);
out.nodes.C.light = await read(c);

const wd = wrap('D frame set Dark', 150);
const d = box('D ring, built default', wd, 20, 20);
ring(d);
out.nodes.D = { built: await read(d) };
wd.setExplicitVariableModeForCollection(col, dark.modeId);
out.nodes.D.dark = await read(d, wd);

const e = box('E ring component, built default', page, 330, top, true);
ring(e);
const we = wrap('E frame set Dark', 480);
we.setExplicitVariableModeForCollection(col, dark.modeId);
const inst = e.createInstance();
we.appendChild(inst);
inst.x = 20;
inst.y = 20;
ids.push(inst.id);
out.nodes.E = { main: await read(e), instance: await read(inst, we) };

const f = box('F outside stroke, built default, own mode Dark', page, 660, top);
outline(f);
out.nodes.F = { built: await read(f) };
f.setExplicitVariableModeForCollection(col, dark.modeId);
out.nodes.F.dark = await read(f);

const g = box('G ring, built default, for call 3', page, 810, top);
ring(g);
const h = box('H outside stroke, built default, for call 3', page, 960, top);
outline(h);
out.nodes.G = { built: await read(g) };
out.nodes.H = { built: await read(h) };
out.createdNodeIds = ids;
return out;
