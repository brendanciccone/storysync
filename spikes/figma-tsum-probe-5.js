// storysync probe 6, call 5: a response of 18,999 bytes, under the new guard.
const PAGE = "storysync probe 6";
const SUM = "73cf304f";
const TSUM = "de0964e2";
const T = `await figma.setCurrentPageAsync(figma.root.children.find((p) => p.name === PAGE));
const out = { kind: 'probe', page: figma.currentPage.name, tc: TC, s: '' };
out.s = 'x'.repeat(18999 - JSON.stringify(out).length) ;
return out;`;
const fnv=x=>{let h=2166136261;for(let i=0;i<x.length;i++)h=Math.imul(h^x.charCodeAt(i),16777619)>>>0;return h.toString(16).padStart(8,"0")};
if(fnv(JSON.stringify([PAGE]))!==SUM)throw new Error("This call differs from the file storysync figma code wrote: its data fails its checksum, SUM. Nothing was changed. Send the file again, exactly as it is.");
if(fnv(T)!==TSUM)throw new Error("This call differs from the file storysync figma code wrote: its template fails its checksum, TSUM. Nothing was changed. Send the file again, exactly as it is.");
return await new(async()=>{}).constructor("figma","PAGE","TC",T)(figma,PAGE,1);
