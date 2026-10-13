// storysync probe 7c, call 1: variables that carry an alpha, as `storysync
// figma tokens` would make them, bound as templates/build.js binds them, in
// the page's default mode, then switched to Dark, Light and Dark again.
// Names: "destructive 10%", "destructive 30%" and "foreground 10%" are made
// in the Colors collection beside their tokens, each Light value the token's
// light color at that alpha and Dark its dark color at that alpha; then
// "destructive/10" (a group named like the destructive variable) and
// "probe 12.5%" (a period) are tried, read back and removed. Nodes: P a fill
// bound from a paint at opacity 1, P2 a fill bound from a paint at the alpha
// and assigned again with it put back, S an OUTSIDE stroke, E a ring (a
// spread-only drop shadow) bound from a shadow at alpha 1. Each is switched
// on its own frame; W's child under a frame around it; I is an instance of a
// component like P, in a frame set to Dark. Each read has the SVG export's
// fill, stroke and feColorMatrix attributes, which say what Figma draws.
// As run, 2026-10-13: cli/__tests__/fixtures/figma-probe-7c.json.
const PAGE = 'storysync probe 7c';
let page = figma.root.children.find((p) => p.name === PAGE);
if (!page) { page = figma.createPage(); page.name = PAGE; }
await figma.setCurrentPageAsync(page);
for (const c of [...page.children]) c.remove();
const colors = await figma.variables.getLocalVariablesAsync('COLOR');
const one = (name) => colors.filter((v) => v.name === name);
if (one('destructive').length !== 1 || one('foreground').length !== 1) return { error: 'need one destructive and one foreground' };
const col = await figma.variables.getVariableCollectionByIdAsync(one('destructive')[0].variableCollectionId);
const light = col.modes.find((m) => m.name === 'Light');
const dark = col.modes.find((m) => m.name === 'Dark');
if (!light || !dark) return { error: 'modes ' + col.modes.map((m) => m.name).join() };
const r3 = (n) => Math.round(n * 1000) / 1000;
const c4 = (c) => c && [r3(c.r), r3(c.g), r3(c.b), c.a === undefined ? null : r3(c.a)];
const before = col.variableIds.length;

// The alpha variables: each mode's value the token's, its alpha times k.
const made = {};
const names = {};
const alpha = (token, k, keep) => {
  const base = one(token)[0];
  const name = keep;
  let v = colors.find((x) => x.name === name && x.variableCollectionId === col.id);
  const created = !v;
  try {
    v = v || figma.variables.createVariable(name, col, 'COLOR');
    v.scopes = ['ALL_FILLS', 'STROKE_COLOR', 'EFFECT_COLOR'];
    for (const m of [light, dark]) {
      const b = base.valuesByMode[m.modeId];
      v.setValueForMode(m.modeId, { r: b.r, g: b.g, b: b.b, a: (b.a === undefined ? 1 : b.a) * k });
    }
    names[name] = { ok: true, created, name: v.name, id: v.id, values: { Light: c4(v.valuesByMode[light.modeId]), Dark: c4(v.valuesByMode[dark.modeId]) }, scopes: v.scopes };
    return v;
  } catch (e) {
    names[name] = { ok: false, error: String((e && e.message) || e).slice(0, 160) };
    if (v && created) v.remove();
    return null;
  }
};
const A10 = 26 / 255;
const A30 = 77 / 255;
made.d10 = alpha('destructive', A10, 'destructive 10%');
made.d30 = alpha('destructive', A30, 'destructive 30%');
made.f10 = alpha('foreground', A10, 'foreground 10%');
// Names tried and removed: a group of the destructive variable's name, and a period.
for (const [token, name] of [['destructive', 'destructive/10'], ['foreground', 'probe 12.5%']]) {
  const v = alpha(token, A10, name);
  if (v) {
    names[name].destructiveAfter = { name: one('destructive')[0].name, count: (await figma.variables.getLocalVariablesAsync('COLOR')).filter((x) => x.name === 'destructive').length };
    v.remove();
  }
}
if (!made.d10 || !made.d30 || !made.f10) return { names };

const ids = [];
const top = 0;
const box = (name, parent, x, y, component) => {
  const f = component ? figma.createComponent() : figma.createFrame();
  parent.appendChild(f);
  f.name = name;
  f.resize(100, 60);
  f.x = x;
  f.y = y;
  f.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  f.cornerRadius = 8;
  ids.push(f.id);
  return f;
};
const red = { r: 223 / 255, g: 34 / 255, b: 37 / 255 };
const fill = (n, putBack) => {
  n.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: red, opacity: putBack ? A10 : 1 }, 'color', made.d10)];
  if (putBack) n.fills = n.fills.map((p) => Object.assign({}, p, { opacity: A10 }));
};
const stroke = (n) => {
  n.strokes = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: red, opacity: 1 }, 'color', made.d30)];
  n.strokeWeight = 1;
  n.strokeAlign = 'OUTSIDE';
};
const ring = (n) => {
  n.effects = [figma.variables.setBoundVariableForEffect({ type: 'DROP_SHADOW', color: { r: 10 / 255, g: 10 / 255, b: 10 / 255, a: 1 }, offset: { x: 0, y: 0 }, radius: 0, spread: 1, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false }, 'color', made.f10)];
};
const modeOf = (n) => (col.modes.find((m) => m.modeId === n.resolvedVariableModes[col.id]) || {}).name;
const svg = async (n) => {
  const s = await n.exportAsync({ format: 'SVG_STRING' });
  return (s.match(/<feColorMatrix type="matrix"[^>]*>/g) || []).map((m) => m.replace(/^.*values="([^"]*)".*$/, 'shadow $1')).concat(s.match(/(?:fill|stroke)(?:-opacity)?="[^"]*"/g) || []).filter((a) => !/="(?:none|white|#FFFFFF)"/.test(a));
};
const read = async (n, drawn) => ({
  mode: modeOf(n),
  fills: n.fills.filter((p) => p.boundVariables && p.boundVariables.color).map((p) => ({ color: c4(p.color), opacity: r3(p.opacity), bound: p.boundVariables.color.id })),
  strokes: n.strokes.map((p) => ({ color: c4(p.color), opacity: r3(p.opacity), bound: p.boundVariables && p.boundVariables.color ? p.boundVariables.color.id : null })),
  effects: n.effects.map((e) => ({ color: c4(e.color), bound: e.boundVariables && e.boundVariables.color ? e.boundVariables.color.id : null })),
  svg: await svg(drawn || n),
});
const nodes = {};
const switches = async (key, n, at) => {
  const out = { built: await read(n) };
  for (const [when, m] of [['dark', dark], ['light', light], ['dark2', dark]]) {
    (at || n).setExplicitVariableModeForCollection(col, m.modeId);
    out[when] = await read(n, at);
  }
  (at || n).clearExplicitVariableModeForCollection(col);
  out.cleared = await read(n, at);
  nodes[key] = out;
};
const p = box('P fill bound at opacity 1', page, 0, top);
fill(p, false);
await switches('P', p);
const p2 = box('P2 fill bound at the alpha, put back', page, 150, top);
fill(p2, true);
await switches('P2', p2);
const s = box('S outside stroke', page, 300, top);
s.fills = [];
stroke(s);
await switches('S', s);
const e = box('E ring', page, 450, top);
ring(e);
await switches('E', e);
const w = box('W frame around', page, 600, top);
w.resize(140, 100);
w.fills = [];
const wc = box('W child: fill, stroke and ring', w, 20, 20);
fill(wc, false);
stroke(wc);
ring(wc);
await switches('W', wc, w);
const c = box('C component', page, 800, top, true);
fill(c, false);
stroke(c);
ring(c);
const wi = box('I frame set Dark', page, 950, top);
wi.resize(140, 100);
wi.fills = [];
wi.setExplicitVariableModeForCollection(col, dark.modeId);
const inst = c.createInstance();
wi.appendChild(inst);
inst.x = 20;
inst.y = 20;
ids.push(inst.id);
nodes.I = { main: await read(c), instance: await read(inst, wi) };
wi.setExplicitVariableModeForCollection(col, light.modeId);
nodes.I.light = await read(inst, wi);
wi.setExplicitVariableModeForCollection(col, dark.modeId);
nodes.I.dark2 = await read(inst, wi);
return { collection: col.name, variablesBefore: before, variablesAfter: col.variableIds.length, names, nodes, createdNodeIds: ids };
