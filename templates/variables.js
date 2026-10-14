// storysync variables template: creates or updates one variable collection
// from the tokens, found by name, so a push sent again changes nothing.
//
// `storysync figma tokens` writes the call as `const DATA = {...};`, then
// this file as the string T, whose checksum, TSUM, the call checks with
// DATA's, SUM, before it runs T (cli/checksum.ts, callCode):
//   DATA = { collection, modes, part: [i, n], vars: [[name, type, scopes,
//            light, dark?], ...], all?: [[name, type], ...], remove?: [name],
//            alpha?: [name] }
// `modes` is ['Default'], or ['Light', 'Dark'] where a token of the
// collection has a dark value; a var's dark is its light value where it
// has none, as the browser keeps a variable the dark theme doesn't set. A
// color is '#rrggbb' or '#rrggbbaa', a FLOAT a number, a STRING a string.
// A large collection is split into parts; the first carries `all`, every
// token of the collection with its type, and lists the variables the
// collection holds that no token has (`stale`) and those of a token's name
// that can't be its variable (`conflicts`: another type, or a second of the
// name). It removes only those `remove` names, which the user confirmed;
// nothing else is ever removed.
//
// An alpha variable, `destructive 10%`, is a color token at an alpha
// (cli/figma-bind.ts): a translucent paint the build binds to it keeps its
// opacity at a mode switch, where bound to the token Figma would reset it
// to the token's alpha (probes 7b and 7c). Each is made beside its token,
// with the token's scopes, its value in each mode the token's at that
// alpha, or at the dark theme's own in Dark, `destructive 10% dark 20%`:
// those `alpha` names, which the plan's paints bind, and every one an
// earlier push made, kept up to date with its token. One whose token is
// gone is stale.

const NAME = DATA.collection;
const entry = (name) => NAME + '/' + name;
const named = (await figma.variables.getLocalVariableCollectionsAsync()).filter((c) => c.name === NAME);
if (named.length > 1) {
  throw new Error(named.length + ' variable collections are named "' + NAME + '" (' + named.map((c) => c.id).join(', ') + '): ask the user which to keep and to delete the others in Figma, then send this call again. Nothing was changed.');
}
const collection = named[0] || figma.variables.createVariableCollection(NAME);
const renamedModes = [];
const addedModes = [];
let darkError = null;
const modeNamed = (name) => collection.modes.find((m) => m.name === name);

// The first mode: Light, or Default where no token has a dark value. A
// collection's one mode is renamed to it, Figma's "Mode 1" included; of
// several, the one of that name is it, or the other of the two, or the
// collection's default, none renamed.
const FIRST = DATA.modes[0];
const modes = collection.modes;
const first = modes.length === 1
  ? modes[0]
  : modeNamed(FIRST) || modeNamed(FIRST === 'Light' ? 'Default' : 'Light') || modes.find((m) => m.modeId === collection.defaultModeId) || modes[0];
if (modes.length === 1 && first.name !== FIRST) {
  renamedModes.push([first.name, FIRST]);
  collection.renameMode(first.modeId, FIRST);
}
const light = first.modeId;
// Dark: the collection's own, or added where the tokens have one. A Dark
// mode the tokens no longer fill takes each light value, as the browser does.
const darkMode = modeNamed('Dark');
let dark = darkMode && darkMode.modeId !== light ? darkMode.modeId : null;
if (!dark && DATA.modes.length > 1) {
  try {
    dark = collection.addMode('Dark');
    addedModes.push('Dark');
  } catch (e) {
    // The file's plan allows fewer modes: Light alone, said in the result.
    darkError = String((e && e.message) || e);
  }
}

const byName = {};
let total = 0;
for (const v of await figma.variables.getLocalVariablesAsync()) {
  if (v.variableCollectionId !== collection.id) continue;
  (byName[v.name] = byName[v.name] || []).push(v);
  total++;
}

// An alpha variable's token and alphas, Light's and Dark's, from its name,
// or null.
const ALPHA = /^(.+?) (\d{1,3}(?:,\d)?)%(?: dark (\d{1,3}(?:,\d)?)%)?$/;
const alphaOf = (name) => {
  const m = ALPHA.exec(name);
  if (!m) return null;
  const [k, kDark] = [m[2], m[3] || m[2]].map((p) => Number(p.replace(',', '.')));
  return k <= 100 && kDark <= 100 ? [m[1], Math.round((k / 100) * 255) / 255, Math.round((kDark / 100) * 255) / 255] : null;
};

const stale = [];
const conflicts = [];
const removed = [];
if (DATA.all) {
  const TYPE = {};
  for (const [name, type] of DATA.all) TYPE[name] = type;
  const confirmed = new Set(DATA.remove || []);
  for (const name of Object.keys(byName).sort()) {
    const list = byName[name];
    const alpha = alphaOf(name);
    const type = TYPE[name] || (alpha && TYPE[alpha[0]] === 'COLOR' ? 'COLOR' : undefined);
    // The ones no token has, or that can't be the token's variable: a
    // variable's type never changes, and the build binds by name alone.
    const right = type ? list.filter((v) => v.resolvedType === type) : [];
    const extra = type ? list.filter((v) => v !== right[0]) : list;
    if (!extra.length) continue;
    if (!confirmed.has(name)) {
      if (!type) stale.push(entry(name));
      else conflicts.push([entry(name), extra.map((v) => v.resolvedType !== type ? 'a ' + v.resolvedType + ' variable, not ' + type : 'a second ' + type + ' variable of the name').join('; ')]);
      continue;
    }
    for (const v of extra) v.remove();
    removed.push(entry(name));
    total -= extra.length;
    byName[name] = right.slice(0, 1);
  }
}

const hex = (s) => [1, 3, 5, 7].map((i) => (i < s.length ? parseInt(s.slice(i, i + 2), 16) / 255 : 1));
const rgba = (s) => {
  const [r, g, b, a] = hex(s);
  return { r, g, b, a };
};
const same = (type, had, want) => {
  if (type === 'COLOR') {
    if (!had || typeof had.r !== 'number') return false;
    const w = hex(want);
    return ['r', 'g', 'b', 'a'].every((c, i) => Math.abs((c === 'a' && had.a === undefined ? 1 : had[c]) - w[i]) < 0.5 / 255);
  }
  if (type === 'FLOAT') return typeof had === 'number' && Math.abs(had - want) <= 1e-4 * Math.max(1, Math.abs(want));
  return had === want;
};
const sameScopes = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// This part's alpha variables, as vars: the plan's, and those the
// collection holds, of a color token of this part.
const TOKEN = {};
for (const v of DATA.vars) if (v[1] === 'COLOR') TOKEN[v[0]] = v;
const at = (s, k) => s.slice(0, 7) + Math.round(hex(s)[3] * k * 255).toString(16).padStart(2, '0');
const alphas = [...new Set((DATA.alpha || []).concat(Object.keys(byName)))].sort().filter((name) => alphaOf(name) && TOKEN[alphaOf(name)[0]]).map((name) => {
  const [token, k, kDark] = alphaOf(name);
  const [, , scopes, lightValue, darkValue] = TOKEN[token];
  return [name, 'COLOR', scopes, at(lightValue, k), at(darkValue === undefined ? lightValue : darkValue, kDark)];
});

const created = [];
const updated = [];
const skipped = [];
let unchanged = 0;
for (const [name, type, scopes, lightValue, darkValue] of DATA.vars.concat(alphas)) {
  const list = byName[name] || [];
  if (list.length > 1 || (list[0] && list[0].resolvedType !== type)) {
    skipped.push(entry(name));
    continue;
  }
  const had = list[0];
  const v = had || figma.variables.createVariable(name, collection, type);
  if (!had) {
    created.push(name);
    total++;
  }
  let changed = false;
  if (!sameScopes(v.scopes, scopes)) {
    v.scopes = scopes;
    changed = true;
  }
  const values = [[light, lightValue]];
  if (dark) values.push([dark, darkValue === undefined ? lightValue : darkValue]);
  const was = v.valuesByMode || {};
  for (const [mode, value] of values) {
    if (had && same(type, was[mode], value)) continue;
    v.setValueForMode(mode, type === 'COLOR' ? rgba(value) : value);
    changed = true;
  }
  if (!had) continue;
  if (changed) updated.push(name);
  else unchanged++;
}

return {
  kind: 'variables', collection: NAME, id: collection.id, part: DATA.part, createdCollection: !named[0],
  modes: collection.modes.map((m) => m.name), renamedModes, addedModes, darkError,
  created, updated, unchanged, skipped, variables: total, alpha: alphas.map((v) => v[0]),
  ...(DATA.all ? { stale, conflicts, removed } : {}),
};
