// storysync probe 6, call 2: the guard as callCode writes it.
const DATA = "x";
const SUM = "04684771";
const TSUM = "87b2d693";
const T = async()=>{
let page = figma.root.children.find((p) => p.name === 'storysync probe 6');
await figma.setCurrentPageAsync(page);
const s = String(P), t = String(T);
return { kind: 'probe', n: DATA.length, tc: TC ? 1 : 0, p: s, pcodes: [...s].map((c) => c.charCodeAt(0)).join(','), tlen: t.length, tsum: fnv(t), want: TSUM, head: t.slice(0, 60), tail: t.slice(-40) };
};
const fnv=x=>{let h=2166136261;for(let i=0;i<x.length;i++)h=Math.imul(h^x.charCodeAt(i),16777619)>>>0;return h.toString(16).padStart(8,"0")};
if(fnv(JSON.stringify([DATA]))!==SUM)throw new Error("This call differs from the file storysync figma code wrote: its data fails its checksum, SUM. Nothing was changed. Send the file again, exactly as it is.");
const P=async()=>{
return 1.50},TC=String(P)==="async()=>{\nreturn 1.50}";
if(TC&&fnv(String(T))!==TSUM)throw new Error("This call differs from the file storysync figma code wrote: its template fails its checksum, TSUM. Nothing was changed. Send the file again, exactly as it is.");
return await T();
