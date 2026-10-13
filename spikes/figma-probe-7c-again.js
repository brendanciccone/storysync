// storysync probe 7c, call 2: call 1's nodes read again in a call of their
// own, as Figma kept them, then switched to Dark and Light once more: P's
// frame, S's, E's, the frame around W's child, and the Dark frame around I.
// And two names for an alpha of no whole percent, since call 1 found that a
// period makes a name Figma refuses: "probe 12,5%" and "probe 12_5%", each
// tried, read back and removed.
// As run, 2026-10-13: cli/__tests__/fixtures/figma-probe-7c.json, call2.
const PAGE = 'storysync probe 7c';
const page = figma.root.children.find((p) => p.name === PAGE);
if (!page) return { error: 'no page ' + PAGE };
await figma.setCurrentPageAsync(page);
const colors = await figma.variables.getLocalVariablesAsync('COLOR');
const fg = colors.filter((v) => v.name === 'foreground');
if (fg.length !== 1) return { error: fg.length + ' foreground variables' };
const col = await figma.variables.getVariableCollectionByIdAsync(fg[0].variableCollectionId);
const light = col.modes.find((m) => m.name === 'Light');
const dark = col.modes.find((m) => m.name === 'Dark');
const r3 = (n) => Math.round(n * 1000) / 1000;
const c4 = (c) => c && [r3(c.r), r3(c.g), r3(c.b), c.a === undefined ? null : r3(c.a)];
const names = {};
for (const name of ['probe 12,5%', 'probe 12_5%']) {
  try {
    const v = figma.variables.createVariable(name, col, 'COLOR');
    names[name] = { ok: true, name: v.name };
    v.remove();
  } catch (e) {
    names[name] = { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
}
const named = (name) => page.findOne((n) => n.name === name);
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
const at = {
  P: [named('P fill bound at opacity 1')],
  S: [named('S outside stroke')],
  E: [named('E ring')],
  W: [named('W child: fill, stroke and ring'), named('W frame around')],
  I: [named('I frame set Dark').children[0], named('I frame set Dark')],
};
for (const [key, [n, around]] of Object.entries(at)) {
  const out = { kept: await read(n, around) };
  for (const [when, m] of [['dark', dark], ['light', light]]) {
    (around || n).setExplicitVariableModeForCollection(col, m.modeId);
    out[when] = await read(n, around);
  }
  nodes[key] = out;
}
return { names, nodes, mutatedNodeIds: Object.values(at).map(([n, around]) => (around || n).id) };
