// storysync probe 7, call 4: a response of 20,500 ASCII characters, past
// use_figma's 20kb, to see what the tool does with one too big.
await figma.setCurrentPageAsync(figma.root.children.find((p) => p.name === 'storysync probe 6'));
const out = { kind: 'probe', chars: 20500, pad: '', end: 'END' };
out.pad = 'x'.repeat(20500 - JSON.stringify(out).length);
return out;
