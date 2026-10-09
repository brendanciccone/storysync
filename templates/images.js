// storysync images template: fills image layers from images already in the
// file, one page per call, carrying no data but the page's name.
//
// `storysync figma code` writes the call as `const PAGE = "...";` and
// `const SUM = "...";`, the checksum of PAGE (cli/checksum.ts, callSum),
// followed by this file. The build lists one layer per image it could not fill for
// upload_assets, which puts the image on that layer; every other layer that
// shows the same image, by its shared plugin data `img`, the asset id snap
// gave it, takes the same imageHash here: reusing a hash already in the
// file is the one use of one that figma-use allows.

// The call as the file holds it, before anything changes: one changed on
// its way from the file fails SUM.
const fnv = (x) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};
if (fnv(JSON.stringify([PAGE])) !== SUM) throw new Error('This call differs from the file storysync figma code wrote: its data fails its checksum, SUM. Nothing was changed. Send the file again, exactly as it is.');
const NS = 'storysync';
const pageKey = (name) => name.toLowerCase().replace(/[ /_-]+/g, '');
const page = figma.root.children.find((p) => pageKey(p.name) === pageKey(PAGE));
if (!page) throw new Error('No page "' + PAGE + '": send the build calls for it first');
await figma.setCurrentPageAsync(page);
const nodes = page.findAllWithCriteria({ sharedPluginData: { namespace: NS, keys: ['img'] } });
const hashOf = (n) => {
  const fill = n.fills !== figma.mixed && n.fills.find((p) => p.type === 'IMAGE' && p.imageHash);
  return fill ? fill.imageHash : null;
};
const hashes = {};
for (const n of nodes) {
  const id = n.getSharedPluginData(NS, 'img');
  if (!hashes[id] && hashOf(n)) hashes[id] = hashOf(n);
}
let filled = 0;
const unfilled = new Set();
for (const n of nodes) {
  if (hashOf(n)) continue;
  const id = n.getSharedPluginData(NS, 'img');
  if (!hashes[id]) {
    unfilled.add(id);
    continue;
  }
  n.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: hashes[id] }];
  filled++;
}
return { kind: 'images', page: page.name, filled, unfilled: [...unfilled].sort() };
