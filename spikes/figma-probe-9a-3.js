// Probe 9a, call 3 (Figma file KoShLIaIOXj6vWAuwLTff8, page "storysync probe 9a"):
// what the build does to a variant no property names now before it is
// removed. getInstancesAsync finds its instances, on the page and inside
// another component; swapComponent moves each to another variant; the
// variant then goes, its instances still on the one they moved to. And what
// an instance of a removed variant is left on. It removes all it made, the
// page too, which it makes where it isn't (the first try found none).
let page = figma.root.children.find((p) => p.name === 'storysync probe 9a');
const made = !page;
if (made) {
  page = figma.createPage();
  page.name = 'storysync probe 9a';
}
await figma.setCurrentPageAsync(page);
const out = {};
const mk = (name) => {
  const c = figma.createComponent();
  c.name = name;
  c.resize(40, 20);
  return c;
};
const a = mk('size=sm');
const b = mk('size=lg');
const c = mk('size=sm, disabled=false');
const set = figma.combineAsVariants([a, b, c], page);
set.name = 'Probe 9a-3';
set.x = 1200;
const i1 = a.createInstance();
i1.x = 1200;
i1.y = 200;
const host = figma.createComponent();
host.name = 'Probe 9a-3 host';
host.resize(100, 50);
host.x = 1300;
host.y = 200;
const i2 = a.createInstance();
host.appendChild(i2);
const i3 = b.createInstance();
i3.x = 1450;
i3.y = 200;
const t0 = Date.now();
const found = await a.getInstancesAsync();
out.ms = Date.now() - t0;
out.found = found.map((i) => i.id).sort();
out.expected = [i1.id, i2.id].sort();
for (const i of found) i.swapComponent(c);
out.movedToC = await Promise.all([i1, i2].map(async (i) => (await i.getMainComponentAsync()).id === c.id));
out.leftOnA = (await a.getInstancesAsync()).length;
a.remove();
out.aRemoved = a.removed;
out.onC = (await c.getInstancesAsync()).length;
out.i1Main = (await i1.getMainComponentAsync()).name;
out.i3Untouched = (await i3.getMainComponentAsync()).id === b.id;
const d = mk('size=xl');
set.appendChild(d);
const i4 = d.createInstance();
i4.x = 1500;
d.remove();
const m4 = await i4.getMainComponentAsync();
out.orphan = m4 ? { removed: m4.removed, parent: m4.parent ? m4.parent.type : null } : null;
for (const n of [i1, i3, i4, host, set]) if (!n.removed) n.remove();
out.cleaned = page.children.filter((n) => /^Probe 9a-3/.test(n.name)).length;
if (made && !page.children.length) {
  await figma.setCurrentPageAsync(figma.root.children[0]);
  page.remove();
  out.pageRemoved = true;
}
return out;
