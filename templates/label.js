// storysync label template: says on each set what snap measured, and
// removes Figma's empty default page.
//
// `storysync figma code` writes the call as `const DATA = {...};`, then
// this file as the string T, whose checksum, TSUM, the call checks with
// DATA's, SUM, before it runs T (cli/checksum.ts, callCode):
//   DATA = { pages, sets: [[storysync id, line, dark?], ...], last? }
// with sets the build made, on the pages it made them on. A plan holds as
// many label calls as its sets need to keep each under use_figma's 50,000
// characters; `last` marks the last of them, which alone removes Page 1,
// once every set is on its page. A line is a
// note for a set snap measured from something other than the component, a
// closed trigger or a layout wrapper, and "" for every other set. It goes on
// the description's line that starts MARK, every other line kept, a
// designer's own included; "" removes the line an earlier push left.
// `dark` is 1 for a set snap measured in the dark theme, whose paints bind
// by the tokens' dark values: it is put in each collection's Dark mode,
// where it has no mode of that collection a designer chose, and Figma
// resolves its bound paints again to the values measured (probe 7b). The
// set records (shared plugin data `dark`) the collections this put it in
// Dark for, so a later push that measured it light, its paints bound by
// the light values, takes each back off Dark, where it is still the mode
// this set; a mode a designer chose since stays theirs.

const NS = 'storysync';
const MARK = 'storysync:';
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
// Figma returns a description HTML-escaped, " as &quot;, so one written back
// as read gains an escape on every push: read it unescaped, once. A
// designer's formatted description is markdown in descriptionMarkdown: edit
// that where there is one, with the note's markdown characters escaped. Write
// only a description this changes.
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const unescape = (s) => (s || '').replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, e) => ENTITY[e]);
const SPECIAL = '*_[]<>' + String.fromCharCode(96) + BS;
const markdown = (s) => [...s].map((c) => (SPECIAL.includes(c) ? BS + c : c)).join('');
const pageKey = (name) => name.toLowerCase().replace(/[ /_-]+/g, '');
const wanted = new Set(DATA.pages.map(pageKey));
// Each page is loaded to search it without switching to it: the user stays on theirs.
const found = {};
for (const p of figma.root.children.filter((p) => wanted.has(pageKey(p.name)))) {
  await p.loadAsync();
  for (const n of p.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'], sharedPluginData: { namespace: NS, keys: ['id'] } })) {
    const id = n.getSharedPluginData(NS, 'id');
    if (id && n.parent.type !== 'COMPONENT_SET') (found[id] = found[id] || []).push(n);
  }
}
const changed = [];
const missing = [];
const darkened = [];
const lightened = [];
let DARK = null;
const darkModes = async () => DARK || (DARK = (await figma.variables.getLocalVariableCollectionsAsync()).map((c) => [c, c.modes.find((m) => m.name === 'Dark')]).filter((d) => d[1]));
for (const [id, note, dark] of DATA.sets) {
  const nodes = found[id] || [];
  if (nodes.length !== 1) {
    if (nodes.length) throw new Error('Found ' + nodes.length + ' sets with storysync id ' + id + ': ' + nodes.map((n) => n.id).join(', '));
    missing.push(id);
    continue;
  }
  const node = nodes[0];
  const had = node.getSharedPluginData(NS, 'dark');
  const ours = had ? had.split(',') : [];
  if (dark) {
    for (const [c, m] of await darkModes()) {
      if (node.explicitVariableModes[c.id]) continue;
      node.setExplicitVariableModeForCollection(c, m.modeId);
      ours.push(c.id);
      darkened.push(node.id);
    }
  } else if (ours.length) {
    for (const [c, m] of await darkModes()) {
      if (!ours.includes(c.id) || node.explicitVariableModes[c.id] !== m.modeId) continue;
      node.clearExplicitVariableModeForCollection(c);
      lightened.push(node.id);
    }
    ours.length = 0;
  }
  const now = [...new Set(ours)].sort().join(',');
  if (now !== had) node.setSharedPluginData(NS, 'dark', now);
  const rich = Boolean(node.descriptionMarkdown);
  const key = rich ? 'descriptionMarkdown' : 'description';
  const before = unescape(node[key]);
  const lines = before ? before.split(NL).filter((line) => !line.startsWith(MARK)) : [];
  if (note) lines.push(MARK + ' ' + (rich ? markdown(note) : note));
  const after = lines.join(NL);
  if (after !== before) {
    node[key] = after;
    changed.push(node.id);
  }
}
// Figma's default page, left empty once every set is on its category's page:
// removed only as Figma made it, named Page 1 and empty, while another page
// remains. The user is moved off it only to remove it: use_figma switches
// page once per call, so if Figma then refuses, they stay on the other page.
let pageOne = 'none';
const blank = DATA.last && figma.root.children.find((p) => p.name === 'Page 1');
if (blank) {
  await blank.loadAsync();
  const other = figma.root.children.find((p) => p !== blank);
  pageOne = blank.children.length ? 'kept: it holds layers' : !other ? 'kept: it is the only page' : 'removed';
  if (pageOne === 'removed') {
    const onIt = figma.currentPage.id === blank.id;
    if (onIt) await figma.setCurrentPageAsync(other);
    try {
      blank.remove();
    } catch (e) {
      pageOne = 'kept: Figma refused to remove it (' + String((e && e.message) || e) + ')';
    }
  }
}
return Object.assign({ kind: 'label', changed, missing }, DATA.last ? { pageOne } : {}, darkened.length ? { darkened: [...new Set(darkened)] } : {}, lightened.length ? { lightened: [...new Set(lightened)] } : {});
