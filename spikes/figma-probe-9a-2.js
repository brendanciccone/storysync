const NS = 'storysync';
const page = figma.root.children.find((p) => p.name === 'storysync probe 9a');
await figma.setCurrentPageAsync(page);
const out = {};
// 1. What call 1 stored, read in a later call, and run.
out.part = page.getSharedPluginData(NS, 'probe9a.part').length;
const T = figma.root.getSharedPluginData(NS, 'probe9a.T');
out.T = T.length;
out.ran = await new (async () => {}).constructor('figma', 'A', T)(figma, 2);
page.setSharedPluginData(NS, 'probe9a.part', '');
figma.root.setSharedPluginData(NS, 'probe9a.T', '');
out.cleared = [page.getSharedPluginData(NS, 'probe9a.part'), figma.root.getSharedPluginData(NS, 'probe9a.T')];
const node = async (id) => figma.getNodeByIdAsync(id);
// 2. A plain component converted to a set in place, its instance kept.
const plain = await node('74:17');
const pi = await node('74:18');
const at = [plain.x, plain.y];
const set = figma.combineAsVariants([plain], page);
plain.name = 'shortcuts=letters';
set.name = 'Probe Plain';
const pm = await pi.getMainComponentAsync();
out.convert = { set: set.id, setAt: [set.x, set.y, set.width, set.height], was: at, variant: plain.id, variantParent: plain.parent.id, instanceMain: pm && pm.id, props: pi.componentProperties };
// 3. A set's variants renamed onto a new axis, one at a time, then a variant added.
const s2 = await node('74:21');
const sm = await node('74:19');
const lg = await node('74:20');
const si = await node('74:22');
sm.name = 'size=sm, disabled=false';
try { out.midway = Object.keys(s2.componentPropertyDefinitions); } catch (e) { out.midway = 'threw: ' + String((e && e.message) || e).slice(0, 120); }
lg.name = 'size=lg, disabled=false';
const dis = figma.createComponent(); dis.resize(30, 20); dis.name = 'size=sm, disabled=true';
s2.appendChild(dis); dis.x = 0; dis.y = 30;
const sim = await si.getMainComponentAsync();
let defs;
try { defs = Object.fromEntries(Object.entries(s2.componentPropertyDefinitions).map(([k, v]) => [k, [v.type, v.defaultValue, v.variantOptions]])); } catch (e) { defs = 'threw: ' + String((e && e.message) || e).slice(0, 120); }
out.axis = { instanceMain: sim && sim.id, sm: sm.id, props: si.componentProperties, defs };
// 4. Dropping an axis: the variant with the other value removed, the kept one renamed back.
dis.remove();
sm.name = 'size=sm';
lg.name = 'size=lg';
const sim2 = await si.getMainComponentAsync();
out.dropped = { instanceMain: sim2 && sim2.id, props: si.componentProperties };
return out;
