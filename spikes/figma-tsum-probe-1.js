let page = figma.root.children.find((p) => p.name === 'storysync probe 6');
if (!page) { page = figma.createPage(); page.name = 'storysync probe 6'; }
await figma.setCurrentPageAsync(page);
const out = { page: page.id };
const cut = (t) => (t.length > 240 ? t.slice(0, 240) + '...(' + t.length + ')' : t);
const str = (f) => { try { return cut(String(f)); } catch (e) { return 'throws: ' + String(e && e.message || e).slice(0, 160); } };
const P = async()=>{
return 1.50};
function F(a) { return a + 1.50; }
const T = async()=>{
const q = "a'b\"c";
return `t${q}` + 2.0;
};
out.P = str(P); out.F = str(F); out.T = str(T); out.max = str(Math.max);
out.TC = String(P) === "async()=>{\nreturn 1.50}";
out.typeofToString = typeof Function.prototype.toString;
out.ownToString = P.toString === Function.prototype.toString;
out.callToString = str({ toString: () => Function.prototype.toString.call(P) });
out.typeofEval = typeof eval;
const tryIt = (name, f) => { try { out[name] = f(); } catch (e) { out[name] = 'throws: ' + String(e && e.message || e).slice(0, 160); } };
tryIt('eval', () => eval('1+1'));
tryIt('indirectEval', () => (0, eval)('2+2'));
tryIt('newFunction', () => new Function('a', 'return a*3')(2));
tryIt('FunctionCall', () => Function('return 7')());
const AF = (async () => {}).constructor;
tryIt('AFname', () => AF.name);
try { out.asyncFunction = await new AF('figma', 'return typeof figma + ":" + (await Promise.resolve(5))')(figma); } catch (e) { out.asyncFunction = 'throws: ' + String(e && e.message || e).slice(0, 160); }
tryIt('stack', () => { try { throw new Error('x'); } catch (e) { return cut(String(e.stack)); } });
tryIt('globals', () => ['window', 'self', 'globalThis', 'TextEncoder', 'WebAssembly', 'Proxy', 'Reflect'].map((g) => g + ':' + typeof globalThis[g]).join(' '));

// Rotation: rotate about the top-left, x/y before or after, in and out of auto layout.
const info = (n) => ({ x: n.x, y: n.y, w: n.width, h: n.height, rot: n.rotation, rt: n.relativeTransform, abb: n.absoluteBoundingBox, pos: n.layoutPositioning });
const box = (name, parent) => { const n = figma.createFrame(); n.name = name; n.resize(10, 10); n.cornerRadius = 2; n.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; parent.appendChild(n); return n; };
const auto = figma.createFrame(); auto.name = 'auto'; auto.x = 0; auto.y = 0; auto.resize(120, 40);
auto.layoutMode = 'HORIZONTAL'; auto.primaryAxisSizingMode = 'FIXED'; auto.counterAxisSizingMode = 'FIXED'; auto.itemSpacing = 0;
auto.paddingLeft = auto.paddingRight = auto.paddingTop = auto.paddingBottom = 0; auto.counterAxisAlignItems = 'MIN';
const a = box('a abs rot-then-xy', auto); a.layoutPositioning = 'ABSOLUTE'; a.rotation = -45; a.x = 50.5; a.y = 18.93;
const b = box('b abs xy-then-rot', auto); b.layoutPositioning = 'ABSOLUTE'; b.x = 50.5; b.y = 18.93; b.rotation = -45;
const c = box('c flow rot', auto); c.rotation = -45;
const d = box('d flow after', auto);
const free = figma.createFrame(); free.name = 'free'; free.x = 0; free.y = 100; free.resize(120, 40);
const e = box('e free', free); e.rotation = -45; e.x = 50.5; e.y = 18.93;
const g = box('g free resized after', free); g.rotation = -45; g.x = 50.5; g.y = 18.93; g.resize(12, 12);
const h = box('h rot 0 again', free); h.rotation = -45; h.x = 50.5; h.y = 18.93; h.rotation = 0;
out.rot = { auto: info(auto), a: info(a), b: info(b), c: info(c), d: info(d), free: info(free), e: info(e), g: info(g), h: info(h) };
return out;
