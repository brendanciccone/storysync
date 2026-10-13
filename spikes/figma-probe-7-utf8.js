// storysync probe 7, call 3: a response the readback template counts as
// 19,000 (its JSON's length, plus 2 for each UTF-16 unit outside ASCII,
// plus 1), the most its guard lets through, about half of its 17,969
// bytes in characters outside ASCII: `…` (3 bytes), `·` and `é` (2), and 📎 (4,
// two units). Were use_figma's 20kb counted with each written as \uXXXX,
// it would be 28,839.
await figma.setCurrentPageAsync(figma.root.children.find((p) => p.name === 'storysync probe 6'));
const count = (v) => { const t = JSON.stringify(v); return t.length + (t.match(/[^\x00-\x7f]/g) || []).length * 2 + 1; };
const bytes = (s) => { let b = 0; for (const c of s) { const p = c.codePointAt(0); b += p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4; } return b; };
const out = { kind: 'probe', counted: '00000', utf8: '00000', units: '00000', rows: [], pad: '', end: 'END' };
for (let i = 0; count(out) < 18900; i++) out.rows.push('PDF · 2.4 MB … café ' + '…'.repeat(4) + (i % 7 ? '' : '📎'));
out.pad = 'x'.repeat(19000 - count(out));
const t = JSON.stringify(out);
out.counted = String(count(out)).padStart(5, '0');
out.utf8 = String(bytes(t)).padStart(5, '0');
out.units = String(t.length).padStart(5, '0');
return out;
