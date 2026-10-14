// storysync probe 7c, call 4: call 3's nodes read again in a call of their
// own, then R D and R S switched to Dark and Light once more. Then a move:
// T1, a fill bound to "destructive" on the page and assigned again with
// 0.102 put back, as a build without its alpha variable binds it, appended
// into R L, a frame in the page's mode; T2 the same, appended into R D set
// to Dark. T3 is bound so inside R D, in Dark, first assigned [] as the
// build now does, then moved to the front of R D. R2, bound to "border",
// is bound to "destructive 10% dark 20%" without being cleared.
// As run, 2026-10-13: cli/__tests__/fixtures/figma-probe-7c-rebind.json, call4.
const PAGE = 'storysync probe 7c';
const page = figma.root.children.find((p) => p.name === PAGE);
if (!page) return { error: 'no page ' + PAGE };
await figma.setCurrentPageAsync(page);
const colors = await figma.variables.getLocalVariablesAsync('COLOR');
const one = (name) => colors.filter((v) => v.name === name);
for (const name of ['destructive', 'destructive 10% dark 20%']) if (one(name).length !== 1) return { error: one(name).length + ' variables named ' + name };
const pm = one('destructive 10% dark 20%')[0];
const destructive = one('destructive')[0];
const col = await figma.variables.getVariableCollectionByIdAsync(pm.variableCollectionId);
const light = col.modes.find((m) => m.name === 'Light');
const dark = col.modes.find((m) => m.name === 'Dark');
const r3 = (n) => Math.round(n * 1000) / 1000;
const c4 = (c) => c && [r3(c.r), r3(c.g), r3(c.b), c.a === undefined ? null : r3(c.a)];
const modeOf = (n) => (col.modes.find((m) => m.modeId === n.resolvedVariableModes[col.id]) || {}).name;
const read = (n) => ({
  mode: modeOf(n),
  f: n.fills.map((p) => [c4(p.color), r3(p.opacity)]),
  s: n.strokes.map((p) => [c4(p.color), r3(p.opacity)]),
  e: n.effects.map((e) => c4(e.color)),
});
const named = (name) => page.findOne((n) => n.name === name);
const D = named('R D frame set Dark');
const S = named('R S set Dark');
const at = { R1: named('R1 per-mode alpha'), R2: named('R2 border'), R3: named('R3 bound on the page, then appended'), V2: S && S.children.find((c) => c.name === 'kind=b') };
for (const [key, n] of Object.entries(at)) if (!n) return { error: 'no ' + key };
const nodes = {};
for (const [key, n] of Object.entries(at)) nodes[key] = { kept: read(n) };
for (const [when, m] of [['dark', dark], ['light', light]]) {
  D.setExplicitVariableModeForCollection(col, m.modeId);
  S.setExplicitVariableModeForCollection(col, m.modeId);
  for (const [key, n] of Object.entries(at)) nodes[key][when] = read(n);
}

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
const fallback = (n, clear) => {
  if (clear) n.fills = [];
  n.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: red, opacity: A10 }, 'color', destructive)];
  n.fills = n.fills.map((p) => Object.assign({}, p, { opacity: A10 }));
};
D.setExplicitVariableModeForCollection(col, dark.modeId);
const L = frame('R L frame in the page mode', page, 0, 600, 300, 120);
const T1 = frame('R T1 fallback, moved within the mode', page, 700, 300, 100, 60);
fallback(T1, false);
nodes.T1 = { onPage: read(T1) };
L.appendChild(T1);
nodes.T1.appended = read(T1);
const T2 = frame('R T2 fallback, moved into Dark', page, 700, 400, 100, 60);
fallback(T2, false);
nodes.T2 = { onPage: read(T2) };
D.appendChild(T2);
nodes.T2.appended = read(T2);
const T3 = frame('R T3 fallback, bound in Dark', D, 420, 30, 100, 60);
fallback(T3, true);
nodes.T3 = { built: read(T3) };
D.insertChild(0, T3);
nodes.T3.moved = read(T3);
const R2 = at.R2;
R2.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: red, opacity: 1 }, 'color', pm)];
nodes.R2.otherVariable = read(R2);
return { nodes, createdNodeIds: ids, mutatedNodeIds: [D.id, S.id, R2.id] };
