// storysync images template: fills image layers from images already in the
// file, one page per call, carrying no data but the page's name.
//
// `storysync figma code` writes the call as `const PAGE = "...";`, then
// this file as the function T, whose checksum, TSUM, the call checks with
// PAGE's, SUM, before T runs (cli/checksum.ts, callCode). The build lists
// one layer per image it could not fill for upload_assets, which puts the
// image on that layer; every other layer that shows the same image, by its
// shared plugin data `img`, the asset id snap gave it, takes the same
// imageHash here: reusing a hash already in the
// file is the one use of one that figma-use allows.

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
