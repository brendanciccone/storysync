// storysync probe 7c, call 3: binding again in a frame set to Dark, as a
// build sent again into a set a designer left in Dark binds, and a
// variable whose alpha differs by mode. "destructive 10% dark 20%" is made
// in Colors beside "destructive" and "destructive 10%", its Light value
// destructive's light color at 10%, its Dark value destructive's dark
// color at 20%. In R D, a frame set to Dark: R1's fill, OUTSIDE stroke and
// ring are bound to it from a paint at opacity 1 (fresh), bound again from
// a new paint at 0.102 (rebound, as the build put back an opacity), then
// assigned [] and bound from a paint at 0.102 (cleared). R2's fill is
// bound to "border", whose Dark value is white at 10%, the same three
// ways from a paint at opacity 1. R3 is bound in the page's default mode
// and then appended into R D; R V2 is a component bound on the page and
// then appended to R S, a set of one variant set to Dark. Then R D is
// switched to Light, Dark and Light, and resolveForConsumer read.
// As run, 2026-10-13: cli/__tests__/fixtures/figma-probe-7c-rebind.json.
const PAGE = 'storysync probe 7c';
const page = figma.root.children.find((p) => p.name === PAGE);
if (!page) return { error: 'no page ' + PAGE };
await figma.setCurrentPageAsync(page);
for (const c of page.children.filter((c) => /^R /.test(c.name))) c.remove();
const colors = await figma.variables.getLocalVariablesAsync('COLOR');
const one = (name) => colors.filter((v) => v.name === name);
for (const name of ['destructive', 'border', 'destructive 10%']) if (one(name).length !== 1) return { error: one(name).length + ' variables named ' + name };
const col = await figma.variables.getVariableCollectionByIdAsync(one('destructive')[0].variableCollectionId);
const light = col.modes.find((m) => m.name === 'Light');
const dark = col.modes.find((m) => m.name === 'Dark');
if (!light || !dark) return { error: 'modes ' + col.modes.map((m) => m.name).join() };
const r3 = (n) => Math.round(n * 1000) / 1000;
const c4 = (c) => c && [r3(c.r), r3(c.g), r3(c.b), c.a === undefined ? null : r3(c.a)];
const before = col.variableIds.length;

const NAME = 'destructive 10% dark 20%';
let pm = colors.find((x) => x.name === NAME && x.variableCollectionId === col.id);
const created = !pm;
pm = pm || figma.variables.createVariable(NAME, col, 'COLOR');
pm.scopes = ['ALL_FILLS', 'STROKE_COLOR', 'EFFECT_COLOR'];
const base = one('destructive')[0];
const K = {};
K[light.modeId] = 26 / 255;
K[dark.modeId] = 51 / 255;
for (const m of [light, dark]) {
  const b = base.valuesByMode[m.modeId];
  pm.setValueForMode(m.modeId, { r: b.r, g: b.g, b: b.b, a: (b.a === undefined ? 1 : b.a) * K[m.modeId] });
}
const all = await figma.variables.getLocalVariablesAsync('COLOR');
const names = {
  made: { created, name: pm.name, id: pm.id, values: { Light: c4(pm.valuesByMode[light.modeId]), Dark: c4(pm.valuesByMode[dark.modeId]) } },
  destructiveNames: all.filter((v) => /^destructive/.test(v.name)).map((v) => v.name).sort(),
  destructiveCount: all.filter((v) => v.name === 'destructive').length,
  border: { Light: c4(one('border')[0].valuesByMode[light.modeId]), Dark: c4(one('border')[0].valuesByMode[dark.modeId]) },
};

const ids = [];
const red = { r: 223 / 255, g: 34 / 255, b: 37 / 255 };
const A10 = 26 / 255;
const frame = (name, parent, x, y, w, h) => {
  const f = figma.createFrame();
  parent.appendChild(f);
  f.name = name;
  f.resize(w, h);
  f.x = x;
  f.y = y;
  f.fills = [];
  ids.push(f.id);
  return f;
};
const bp = (v, opacity) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: red, opacity }, 'color', v);
const be = (v, a) => figma.variables.setBoundVariableForEffect({ type: 'DROP_SHADOW', color: Object.assign({}, red, { a }), offset: { x: 0, y: 0 }, radius: 0, spread: 1, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false }, 'color', v);
const all3 = (n, v, opacity, clear) => {
  if (clear) n.fills = [];
  n.fills = [bp(v, opacity)];
  if (clear) n.strokes = [];
  n.strokes = [bp(v, opacity)];
  n.strokeWeight = 1;
  n.strokeAlign = 'OUTSIDE';
  if (clear) n.effects = [];
  n.effects = [be(v, opacity)];
};
const modeOf = (n) => (col.modes.find((m) => m.modeId === n.resolvedVariableModes[col.id]) || {}).name;
const read = (n) => ({
  mode: modeOf(n),
  f: n.fills.map((p) => [c4(p.color), r3(p.opacity)]),
  s: n.strokes.map((p) => [c4(p.color), r3(p.opacity)]),
  e: n.effects.map((e) => c4(e.color)),
});
const svg = async (n) => {
  const s = await n.exportAsync({ format: 'SVG_STRING' });
  return (s.match(/<feColorMatrix type="matrix"[^>]*>/g) || []).map((m) => m.replace(/^.*values="([^"]*)".*$/, 'shadow $1')).concat(s.match(/(?:fill|stroke)(?:-opacity)?="[^"]*"/g) || []).filter((a) => !/="(?:none|white|#FFFFFF)"/.test(a));
};
const nodes = {};

const D = frame('R D frame set Dark', page, 0, 300, 560, 120);
D.setExplicitVariableModeForCollection(col, dark.modeId);
const R1 = frame('R1 per-mode alpha', D, 20, 30, 100, 60);
all3(R1, pm, 1, false);
nodes.R1 = { fresh: read(R1) };
all3(R1, pm, A10, false);
nodes.R1.rebound = read(R1);
all3(R1, pm, A10, true);
nodes.R1.cleared = read(R1);
nodes.R1.clearedSvg = await svg(R1);
let resolved = null;
try {
  resolved = { R1: c4(pm.resolveForConsumer(R1).value), page: c4(pm.resolveForConsumer(page).value) };
} catch (e) {
  resolved = { error: String((e && e.message) || e).slice(0, 160) };
}

const R2 = frame('R2 border', D, 160, 30, 100, 60);
const border = one('border')[0];
R2.fills = [bp(border, 1)];
nodes.R2 = { fresh: read(R2) };
R2.fills = [bp(border, 1)];
nodes.R2.rebound = read(R2);
R2.fills = [];
R2.fills = [bp(border, 1)];
nodes.R2.cleared = read(R2);

const R3 = frame('R3 bound on the page, then appended', page, 600, 300, 100, 60);
all3(R3, pm, 1, false);
nodes.R3 = { onPage: read(R3) };
D.appendChild(R3);
R3.x = 300;
R3.y = 30;
nodes.R3.appended = read(R3);

const V1 = figma.createComponent();
page.appendChild(V1);
V1.name = 'kind=a';
V1.resize(100, 60);
V1.fills = [];
const S = figma.combineAsVariants([V1], page);
S.name = 'R S set Dark';
S.x = 0;
S.y = 460;
ids.push(S.id, V1.id);
S.setExplicitVariableModeForCollection(col, dark.modeId);
const V2 = figma.createComponent();
page.appendChild(V2);
V2.name = 'kind=b';
V2.resize(100, 60);
V2.fills = [];
ids.push(V2.id);
all3(V2, pm, 1, false);
nodes.V2 = { onPage: read(V2) };
S.appendChild(V2);
nodes.V2.appended = read(V2);

for (const [when, m] of [['light', light], ['dark', dark], ['light2', light]]) {
  D.setExplicitVariableModeForCollection(col, m.modeId);
  S.setExplicitVariableModeForCollection(col, m.modeId);
  for (const [key, n] of [['R1', R1], ['R2', R2], ['R3', R3], ['V2', V2]]) nodes[key][when] = read(n);
}
nodes.R1.light2Svg = await svg(R1);
return { collection: col.name, variablesBefore: before, variablesAfter: col.variableIds.length, names, resolved, nodes, createdNodeIds: ids };
