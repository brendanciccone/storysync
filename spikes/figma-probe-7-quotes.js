// storysync probe 7, call 2: a response of 18,999 characters, all ASCII,
// over a quarter of them `"` or `\`, as dense as a read's records get or
// denser (push 5's 11.json: 14.8%). The template's own count of it is
// 19,000, the most its guard lets through. Were use_figma's 20kb counted
// on the response escaped once more, it would be over 24,000.
await figma.setCurrentPageAsync(figma.root.children.find((p) => p.name === 'storysync probe 6'));
const out = { kind: 'probe', chars: '00000', dense: '00000', rows: [], pad: '', end: 'END' };
for (let i = 0; JSON.stringify(out).length < 18900; i++) out.rows.push(['k' + i, 'F', i % 9, '#0a0a0a', null, 'a"b\\c']);
out.pad = 'x'.repeat(18999 - JSON.stringify(out).length);
const t = JSON.stringify(out);
out.chars = String(t.length).padStart(5, '0');
out.dense = String((t.match(/["\\]/g) || []).length).padStart(5, '0');
return out;
