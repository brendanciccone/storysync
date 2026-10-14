// The element-tree readback template (templates/readback.js), run in mock
// Figma as use_figma runs it: what it finds, what it returns, how it slices
// what doesn't fit, and how it refuses what it can't read truly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FONTS, loadTreeFixture } from "./mock-figma.js";
import { PAGE, READBACK_TEMPLATE, assemble, buildFixture, newFigma, readBack } from "./tree-harness.js";
import { callSum, templateLiteral } from "../checksum.js";
import { withConstant } from "./figma-build-harness.js";
import { READ_LIMIT, parseReadResult, readbackCall, readbackHeader } from "../figma-results.js";
import type { ReadSlice } from "../figma-results.js";
import { RECORD } from "../tree-types.js";
import { formatElementReport, readbackChecksum, treeStrictFailures, verify } from "../verify.js";
import { readbackChars } from "../verify-tree.js";

/** The template with its comments and indentation stripped: an upper bound on what a minifier leaves. */
function stripped(source: string): string {
  return source.split("\n").map((line) => line.replace(/^\s+/, "")).filter((line) => line && !line.startsWith("//")).join("\n");
}

test("template: carries no data of its own, and a call is the five header lines, then the template as T and its guard", () => {
  const code = stripped(READBACK_TEMPLATE);
  assert.doesNotMatch(code, /\b(const|let|var) (PAGE|SLICES|LIMIT|TPL|SUM)\b/, "the CLI's header declares these");
  assert.doesNotMatch(code, /SLUG_BY_NAME|SOURCE_BY_SLUG|SET_ID/, "no slugs, sources or set ids to fill in");
  // Design section 9.1's header, one constant a line, as `storysync figma
  // code` writes it, and SUM, the checksum of the four.
  const sum = callSum(["ui/base", [["ui-base-card", 0, 1, 0]], 9000, 4]);
  assert.equal(readbackHeader("ui/base", [["ui-base-card", 0, 1, 0]], 9000), `const PAGE = "ui/base";\nconst SLICES = [["ui-base-card",0,1,0]];\nconst LIMIT = 9000;\nconst TPL = 4;\nconst SUM = "${sum}";\n`);
  assert.equal(readbackHeader("p", []), `const PAGE = "p";\nconst SLICES = [];\nconst LIMIT = 18000;\nconst TPL = 4;\nconst SUM = "${callSum(["p", [], 18000, 4])}";\n`, "LIMIT 18,000 unless told otherwise");
  const call = readbackCall(READBACK_TEMPLATE, "p", [], 1);
  assert.ok(call.startsWith(`${readbackHeader("p", [], 1)}const TSUM = "`));
  assert.ok(call.includes(`\nconst T = ${templateLiteral(READBACK_TEMPLATE)};\n`));
  assert.ok(call.endsWith(`\nreturn await new(async()=>{}).constructor("figma","PAGE","SLICES","LIMIT","TPL","TC",T)(figma,PAGE,SLICES,LIMIT,TPL,1);\n`));
  // How `storysync figma next` finds the LIMIT a call was written with, to continue it with the same.
  assert.equal(/\nconst LIMIT = (\d+);/.exec(`// storysync figma code, call 07: read back\n${call}`)?.[1], "1");
});

test("template: runs as `storysync figma code` writes a read call, and refuses a call for another template", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  // A call file as figma-code.ts readCode writes it: a comment, then the
  // four constants a line each, each slice with its first node, and their
  // SUM, then the template as T and the guard that checks both.
  const call = `// storysync figma code, call 07: read back on "${PAGE}"\n${readbackCall(READBACK_TEMPLATE, PAGE, [[built.component, 0, 1, 0]])}`;
  const run = await figma.run(call);
  assert.ok(run.ok, run.text);
  const result = run.value as { tpl: number; sets: { entries: Record<string, unknown> }[] };
  assert.equal(result.tpl, 4);
  assert.deepEqual(Object.keys(result.sets[0].entries), ["size-default", "size-sm"]);
  // Written for template 2, its SUM to match.
  const other = await figma.run(withConstant(call, "TPL", 2));
  assert.equal(other.ok, false);
  assert.match(other.text, /This is readback template 4, not 2/);
});

test("template: refuses a call whose template is one character off, before it reads anything", async () => {
  const figma = newFigma();
  const built = await buildFixture(figma, loadTreeFixture("switch"));
  const call = readbackCall(READBACK_TEMPLATE, PAGE, [[built.component, 0, 1, 0]]);
  const at = call.indexOf("\nconst T = ");
  const digit = at + /\d/.exec(call.slice(at))!.index;
  const run = await figma.run(call.slice(0, digit) + String((Number(call[digit]) + 1) % 10) + call.slice(digit + 1));
  assert.equal(run.ok, false);
  assert.match(run.text, /^Error: This call differs from the file storysync figma code wrote: its template fails its checksum, TSUM\. Nothing was changed\. Send the file again, exactly as it is\.$/);
  assert.deepEqual(run.switches, [], "not even its page switched to");
});

test("template: refuses a call one character off the file figma code wrote, before it reads anything", async () => {
  const figma = newFigma();
  const built = await buildFixture(figma, loadTreeFixture("switch"));
  const call = readbackCall(READBACK_TEMPLATE, PAGE, [[built.component, 0, 1, 0]]);
  assert.ok((await figma.run(call)).ok);
  // Copied with one character changed: the last index to read, the
  // limit, the page's name, the template it is for (checked after SUM, so
  // a call to send again, not a template to doubt), or the SUM itself.
  const sum = /const SUM = "(.)/.exec(call)!;
  for (const changed of [
    call.replace(",0,1,0]]", ",0,0,0]]"),
    call.replace("const LIMIT = 18000;", "const LIMIT = 18001;"),
    call.replace(`const PAGE = "${PAGE}";`, `const PAGE = "${PAGE.toLowerCase()}";`),
    call.replace("const TPL = 4;", "const TPL = 2;"),
    call.replace(sum[0], `const SUM = "${sum[1] === "0" ? "1" : "0"}`),
  ]) {
    assert.equal(changed.length, call.length);
    assert.notEqual(changed, call);
    const run = await figma.run(changed);
    assert.equal(run.ok, false);
    assert.match(run.text, /^Error: This call differs from the file storysync figma code wrote: its data fails its checksum, SUM\. Nothing was changed\. Send the file again, exactly as it is\.$/);
    assert.deepEqual(run.switches, [], "not even its page switched to");
  }
});

test("template: stays small enough to minify under 9,000 characters", () => {
  // The limit is on the minified template, which `storysync figma code`
  // sends (scripts/build-templates.mjs, terser, checked by the templates
  // test beside it, which says why it is 9,000 and not design 9.1's 8,000).
  // Stripped of comments and indentation, it is 11,681 characters, which
  // minify to 7,908: about 0.68 of it. So 13,200 stripped is about 8,940
  // minified, and this fails on growth that would near the limit without
  // terser to measure it.
  assert.ok(stripped(READBACK_TEMPLATE).length <= 13_200, `${stripped(READBACK_TEMPLATE).length} characters stripped`);
});

test("template: returns an object, each entry sealed under its set's id and key, with records of their kind's length", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("attachment");
  const built = await buildFixture(figma, fixture);
  const [result] = await readBack(figma, [[built.component, 0, 3, 0]]);
  assert.equal(typeof result, "object");
  assert.deepEqual([result.kind, result.tpl, result.page, result.more], ["read", 4, PAGE, undefined]);
  const [set] = result.sets;
  assert.deepEqual([set.id, set.component, set.title, set.total, set.unbuilt, set.absent], [built.id, "ui-base-attachment", "ui/base/Attachment", 4, [], []]);
  for (const [slug, entry] of Object.entries(set.entries)) {
    assert.equal(entry.checksum, readbackChecksum(set.id, slug, entry));
    assert.equal(entry.tpl, 4);
    assert.equal(entry.source, "measured");
    for (const record of entry.tree!) assert.equal(record.length, RECORD[record[1] as "F" | "T" | "V"]);
    assert.deepEqual(entry.tree!.map((r) => r[0]), ["", "attachment-content", "attachment-content/attachment-title", "attachment-content/attachment-description", "attachment-media", "attachment-media/svg", "attachment-action", "attachment-action/svg"]);
  }
  // A record in the browser's terms: the title, cut off after one line, and
  // cut short in Figma too, as in the browser.
  const title = set.entries["size-default--orientation-vertical--state-done"].tree![2];
  assert.deepEqual(title.slice(0, 7), ["attachment-content/attachment-title", "T", 4, 0, 94, 17.5, "sales-dashboard.pdf"]);
  assert.deepEqual(title.slice(17, 20), ["ENDING", 1, "HEIGHT"]);
  assert.equal(title[23], 1);
});

test("template: an OUTSIDE stroke is read back in the browser's terms, its border box and outer radius", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("button-icon");
  const built = await buildFixture(figma, fixture);
  const [result] = await readBack(figma, [[built.component, 0, 0, 0]]);
  const entry = result.sets[0].entries["variant-default--size-default"];
  const [k, kind, x, y, w, h, fills, stroke, radius] = entry.tree![0];
  assert.deepEqual([k, kind, x, y, w, h, fills, radius], ["", "F", 0, 0, 206.8, 36, ["#171717"], 8]);
  assert.deepEqual(stroke, [1, [], "solid", "O"]);
  // The icon sits 11px into the border box, 10px into Figma's frame.
  assert.deepEqual(entry.tree![1].slice(0, 6), ["svg", "V", 11, 10, 16, 16]);
  assert.equal(figmaX(figma, built.variants[0].layers.svg), 10);
});

function figmaX(figma: ReturnType<typeof newFigma>, id: string): number {
  return figma.node(id)!.x;
}

test("template: reads each field as the header says, in the browser's terms", async () => {
  const figma = newFigma({ fonts: { ...FONTS, Inter: [...FONTS.Inter, "Semi Bold Italic"] } });
  const run = await figma.run(`
    const solid = (r, g, b, opacity = 1, visible = true) => ({ type: 'SOLID', color: { r, g, b }, opacity, visible });
    // The variant: a CENTER stroke, half outside its box; hidden paints on
    // top, a color and an image, and a hidden shadow, none of them drawn.
    const root = figma.createComponent();
    root.resize(100, 50);
    root.fills = [solid(0x11 / 255, 0x22 / 255, 0x33 / 255), solid(1, 1, 1, 1, false), { type: 'IMAGE', scaleMode: 'FILL', visible: false }];
    root.strokes = [solid(0x44 / 255, 0x55 / 255, 0x66 / 255)];
    root.strokeWeight = 2;
    root.strokeAlign = 'CENTER';
    root.cornerRadius = 6;
    root.effects = [
      { type: 'DROP_SHADOW', offset: { x: 1, y: 2 }, radius: 3, spread: 4, color: { r: 0, g: 0, b: 0, a: 0.5 }, visible: true, blendMode: 'NORMAL' },
      { type: 'INNER_SHADOW', offset: { x: 0, y: 1 }, radius: 2, spread: 0, color: { r: 1, g: 0, b: 0, a: 1 }, visible: true, blendMode: 'NORMAL' },
      { type: 'LAYER_BLUR', radius: 5, visible: true },
      { type: 'BACKGROUND_BLUR', radius: 6, visible: true },
      { type: 'DROP_SHADOW', offset: { x: 9, y: 9 }, radius: 9, spread: 9, color: { r: 0, g: 0, b: 0, a: 1 }, visible: false, blendMode: 'NORMAL' },
    ];
    root.blendMode = 'MULTIPLY';
    root.clipsContent = true;
    for (const [k, v] of [['id', 'enc'], ['slug', 'default'], ['i', '0'], ['src', 'measured'], ['d', 'abc']]) root.setSharedPluginData('storysync', k, v);
    // OUTSIDE strokes of a weight a side, dotted; a fill at 0.7 as Figma
    // keeps it, a 32-bit float.
    const a = figma.createFrame(); root.appendChild(a);
    a.x = 3; a.y = 5; a.resize(20, 10);
    a.fills = [solid(0, 0, 0, ${Math.fround(0.7)})];
    a.strokes = [solid(0, 0, 1)];
    a.strokeTopWeight = 1; a.strokeRightWeight = 2; a.strokeBottomWeight = 3; a.strokeLeftWeight = 4;
    a.strokeAlign = 'OUTSIDE';
    a.dashPattern = [2, 2];
    a.clipsContent = false;
    a.setSharedPluginData('storysync', 'k', 'a');
    // Dashed, and hidden.
    const b = figma.createFrame(); root.appendChild(b);
    b.resize(10, 10); b.strokes = [solid(0, 0, 0)]; b.strokeWeight = 1; b.dashPattern = [10, 5]; b.visible = false;
    b.setSharedPluginData('storysync', 'k', 'b');
    await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold Italic' });
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    // A designer's note inside a, ahead of every keyed text: not the text
    // whose color and font the root fields give.
    const note = figma.createText(); a.appendChild(note);
    note.characters = 'Note'; note.name = 'Note'; note.fontSize = 20;
    // Percent units, two fills (the top one shows), each style property.
    const t = figma.createText(); root.appendChild(t);
    t.fontName = { family: 'Inter', style: 'Semi Bold Italic' };
    t.characters = 'Hi';
    t.fontSize = 10;
    t.lineHeight = { unit: 'PERCENT', value: 150 };
    t.letterSpacing = { unit: 'PERCENT', value: 10 };
    t.fills = [solid(1, 0, 0), solid(0, 1, 0)];
    t.textCase = 'UPPER'; t.textDecoration = 'UNDERLINE'; t.textAlignHorizontal = 'CENTER';
    t.textAutoResize = 'HEIGHT'; t.textTruncation = 'ENDING'; t.maxLines = 2;
    t.setSharedPluginData('storysync', 'k', 't');
    const long = figma.createText(); root.appendChild(long);
    long.characters = ${JSON.stringify("x".repeat(301))};
    long.setSharedPluginData('storysync', 'k', 'long');
    const v = figma.createNodeFromSvg('<svg width="10" height="10"><rect x="1" y="2" width="4" height="5" fill="#0000ff" stroke="#00ff00" stroke-width="1.5"/></svg>');
    root.appendChild(v);
    v.setSharedPluginData('storysync', 'k', 'v'); v.setSharedPluginData('storysync', 'svg', 'svg:1');
    // A designer's layers: one hidden, then 22 shown.
    const hidden = figma.createRectangle(); hidden.name = 'Hidden'; hidden.visible = false; root.appendChild(hidden);
    for (let i = 0; i < 22; i++) { const d = figma.createRectangle(); d.name = 'D' + i; root.appendChild(d); }`);
  assert.ok(run.ok, run.text);
  const [result] = await readBack(figma, [["enc", 0, 0, 0]], { page: "Page 1" });
  const { tree, designerLayers, readAt: _readAt, checksum: _checksum, ...fields } = result.sets[0].entries.default;
  // Each record's node id, before its turn, and a text's `cut` before that.
  const idAt = (r: unknown[]) => (r[1] === "T" ? 22 : r.length - 2);
  const records = tree!.map((r) => r.filter((_, i) => i !== idAt(r)));
  assert.ok(tree!.every((r) => /^\d+:\d+$/.test(String(r[idAt(r)]))), "each record has its node id");
  assert.deepEqual(records, [
    ["", "F", 0, 0, 102, 52, ["#112233"], [2, ["#445566"], "solid", "C"], 7, [["D", 1, 2, 3, 4, "#00000080"], ["I", 0, 1, 2, 0, "#ff0000"], ["L", 5], ["B", 6]], 1, "MULTIPLY", 1, 1, 0],
    // Its place from the root's border box, 1px outside the frame, and its own, 4px out on the left.
    ["a", "F", 0, 5, 26, 14, ["#000000b3"], [[1, 2, 3, 4], ["#0000ff"], "dotted", "O"], 0, [], 1, "PASS_THROUGH", 0, 1, 0],
    ["b", "F", 1, 1, 10, 10, ["#ffffff"], [1, ["#000000"], "dashed", "I"], 0, [], 1, "PASS_THROUGH", 1, 0, 0],
    ["t", "T", 1, 1, 100, 15, "Hi", "Inter", 600, 1, 10, 15, 1, "#00ff00", "UPPER", "UNDERLINE", "CENTER", "ENDING", 2, "HEIGHT", 1, 1, 0, 0],
    // AUTO line height at 12px is 15, as Figma sets it (the spike's labels).
    // As wide as the measure says, 1986.6, rounded up to a pixel, as Figma sizes a text.
    ["long", "T", 1, 1, 1987, 15, readbackChars("x".repeat(301)), "Inter", 400, 0, 12, "auto", 0, "#000000", "ORIGINAL", "NONE", "LEFT", "DISABLED", null, "WIDTH_AND_HEIGHT", 1, 1, 0, 0],
    ["v", "V", 1, 1, 10, 10, [[1, 2, 4, 5, "#0000ff", "#00ff00", 1.5]], 1, 1, 0],
  ]);
  assert.deepEqual(designerLayers!.map(([name, type]) => [name, type]), [["Note", "TEXT"], ...Array.from({ length: 19 }, (_, i) => [`D${i}`, "RECTANGLE"])], "the hidden one not, and the first 20 shown");
  // 0.4.0's root fields, in the same terms: its radius and size with the
  // stroke outside it; its text's color and font as 0.4.0 read them, from
  // the first keyed text and its first paint.
  assert.deepEqual(fields, {
    backgroundColor: "#112233", color: "#ff0000", borderRadiusUniform: 7, padding: { top: 0, right: 0, bottom: 0, left: 0 },
    borderUniform: { width: 2, style: "solid", color: "#445566" }, fontSize: 10, fontWeight: 600, fontFamily: "Inter", gap: null,
    opacity: 1, width: 102, height: 52,
    boxShadow: [
      { offsetX: 1, offsetY: 2, blur: 3, spread: 4, color: "#00000080", inset: false },
      { offsetX: 0, offsetY: 1, blur: 2, spread: 0, color: "#ff0000", inset: true },
    ],
    name: "", source: "measured", tpl: 4, built: "abc",
  });
});

test("template: a turned layer reads back as its box unturned about its center, and its turn clockwise, as CSS says it", async () => {
  // The fifth push's Tooltip arrow as the build turns it: Figma's rotation
  // -45 about its top left corner, which sits at 50.5,18.93, out of the
  // bubble's auto layout. Snap measured it as a 10px box at 45.5,21 turned
  // 45 degrees clockwise.
  const figma = newFigma();
  const run = await figma.run(`
    const root = figma.createComponent();
    root.resize(101, 28);
    root.layoutMode = 'HORIZONTAL';
    root.setSharedPluginData('storysync', 'id', 'tip'); root.setSharedPluginData('storysync', 'slug', 'default'); root.setSharedPluginData('storysync', 'i', '0');
    const arrow = figma.createFrame(); root.appendChild(arrow);
    arrow.layoutPositioning = 'ABSOLUTE';
    arrow.resize(10, 10); arrow.rotation = -45; arrow.x = 50.5; arrow.y = 18.93;
    arrow.setSharedPluginData('storysync', 'k', 'div');
    const label = figma.createText(); root.appendChild(label);
    label.setSharedPluginData('storysync', 'k', '#text');`);
  assert.ok(run.ok, run.text);
  const [result] = await readBack(figma, [["tip", 0, 0, 0]], { page: "Page 1" });
  const tree = result.sets[0].entries.default.tree!;
  const arrow = tree.find((r) => r[0] === "div")!;
  assert.deepEqual([...arrow.slice(2, 6), arrow[arrow.length - 1]], [45.5, 21, 10, 10, 45]);
  assert.deepEqual(tree.filter((r) => r[0] !== "div").map((r) => r[r.length - 1]), [0, 0], "an unturned layer's turn is 0");
});

test("template: says whether Figma cuts each truncated text short, from a copy it measures and removes", async () => {
  const figma = newFigma();
  const run = await figma.run(`
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const root = figma.createComponent();
    root.resize(300, 200);
    for (const [k, v] of [['id', 'cut'], ['slug', 'default'], ['i', '0'], ['src', 'measured']]) root.setSharedPluginData('storysync', k, v);
    // [key, characters, width, autoResize, maxLines]: one line in a box too
    // narrow, one that fits, two lines of three, two of two, a fixed box
    // (TRUNCATE) too narrow, and one that doesn't truncate.
    for (const [k, chars, w, resize, lines] of [
      ['narrow', 'sales-dashboard.pdf', 60, 'HEIGHT', 1],
      ['fits', 'Home', 100, 'HEIGHT', 1],
      ['three', 'one two three four five six', 70, 'HEIGHT', 2],
      ['two', 'one two three', 70, 'HEIGHT', 2],
      ['box', 'sales-dashboard.pdf', 60, 'TRUNCATE', 0],
      ['wraps', 'sales-dashboard.pdf', 60, 'HEIGHT', 0],
    ]) {
      const t = figma.createText(); root.appendChild(t);
      t.characters = chars;
      t.resize(w, 15);
      t.textAutoResize = resize;
      if (lines) { t.textTruncation = 'ENDING'; t.maxLines = lines; }
      t.setSharedPluginData('storysync', 'k', k);
    }
    return { kind: 'setup', page: figma.currentPage.children.map((n) => n.id) };`);
  assert.ok(run.ok, run.text);
  const [result] = await readBack(figma, [["cut", 0, 0, 0]], { page: "Page 1" });
  const cut = Object.fromEntries(result.sets[0].entries.default.tree!.slice(1).map((r) => [r[0], [r[17], r[23]]]));
  assert.deepEqual(cut, {
    narrow: ["ENDING", 1], fits: ["ENDING", 0], three: ["ENDING", 1], two: ["ENDING", 0], box: ["ENDING", 1], wraps: ["DISABLED", 0],
  });
  // Each copy made was removed, and the page holds what it held.
  const read = figma.runs[figma.runs.length - 1];
  assert.deepEqual([read.created, read.removed], [5, 5]);
  assert.deepEqual(figma.pages().find((p) => p.name === "Page 1")!.children!.map((n) => n.id), (run.value as { page: string[] }).page);
  // A font that won't load: whether it is cut can't be told.
  const fontless = `figma.loadFontAsync = async () => { throw new Error("no font"); };\n${READBACK_TEMPLATE}`;
  const [unknown] = await readBack(figma, [["cut", 0, 0, 0]], { page: "Page 1", template: fontless });
  assert.deepEqual(unknown.sets[0].entries.default.tree!.slice(1).map((r) => r[23]), [null, null, null, null, null, 0]);
});

test("template: an image whose bytes can't be read reads as unreadable, and the read goes on", async () => {
  const figma = newFigma();
  const run = await figma.run(`
    const root = figma.createComponent();
    root.resize(10, 10);
    root.fills = [{ type: 'IMAGE', imageHash: 'f00d', scaleMode: 'FILL' }];
    for (const [k, v] of [['id', 'img'], ['slug', 'default'], ['i', '0'], ['src', 'measured']]) root.setSharedPluginData('storysync', k, v);`);
  assert.ok(run.ok, run.text);
  // As the sandbox would, should it refuse an image it can't find.
  const refusing = `figma.getImageByHash = () => { throw new Error("no image f00d"); };\n${READBACK_TEMPLATE}`;
  const [result] = await readBack(figma, [["img", 0, 0, 0]], { page: "Page 1", template: refusing });
  assert.deepEqual(result.sets[0].entries.default.tree![0][6], ["img:?:FILL:?"]);
});

test("template: counts what it returns in bytes, as use_figma does, so text outside ASCII stops a call at LIMIT, not past 20kb", async () => {
  const figma = newFigma();
  const label = "読み込み中".repeat(58);
  const run = await figma.run(`
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const variants = [];
    for (let i = 0; i < 24; i++) {
      const c = figma.createComponent();
      c.name = 'n=' + i;
      c.resize(100, 20);
      const t = figma.createText(); c.appendChild(t);
      t.characters = ${JSON.stringify(label)};
      t.setSharedPluginData('storysync', 'k', 't');
      for (const [k, v] of [['slug', 'n-' + i], ['i', String(i)], ['src', 'measured']]) c.setSharedPluginData('storysync', k, v);
      variants.push(c);
    }
    const set = figma.combineAsVariants(variants, figma.currentPage);
    set.setSharedPluginData('storysync', 'id', 'wide');`);
  assert.ok(run.ok, run.text);
  const results = await readBack(figma, [["wide", 0, 23, 0]], { page: "Page 1" });
  assert.ok(results.length >= 2, "more than one call's worth");
  for (const r of figma.runs.slice(-results.length)) assert.ok(r.ok && r.bytes <= READ_LIMIT, `${r.bytes} bytes`);
  assert.equal(results.flatMap((r) => Object.keys(r.sets[0].entries)).length, 24);
});

test("template: a read over LIMIT returns more, and the calls after it cover the rest once each", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("card");
  const built = await buildFixture(figma, fixture);
  const whole = await readBack(figma, [[built.component, 0, 1, 0]]);
  assert.equal(whole.length, 1);
  // Room for one variant a call: the second comes in a call of its own.
  const one = await readBack(figma, [[built.component, 0, 1, 0]], { limit: 5000 });
  assert.equal(one.length, 2);
  assert.deepEqual(one[0].more, { slices: [[built.component, 1, 1, 0]] });
  assert.deepEqual(one.map((r) => Object.keys(r.sets[0].entries)), [["size-default"], ["size-sm"]]);
  // Room for less than a variant: it is read in parts, at node boundaries.
  const parts = await readBack(figma, [[built.component, 0, 1, 0]], { limit: 2500 });
  assert.ok(parts.length > 2);
  const keys = parts.flatMap((r) => Object.keys(r.sets[0].entries));
  assert.equal(keys[0], "size-default");
  assert.ok(keys.some((k) => /^size-default#\d+$/.test(k)) && keys.some((k) => /^size-sm#\d+$/.test(k)), keys.join());
  const records = (file: ReturnType<typeof assemble>, slug: string) => Object.entries(file.components["ui/base/Card"].variants)
    .filter(([key]) => key === slug || key.startsWith(`${slug}#`))
    .sort((a, b) => (a[1].part?.[0] ?? 0) - (b[1].part?.[0] ?? 0))
    .flatMap(([, e]) => e.tree!);
  const inParts = assemble(parts);
  const inOne = assemble(whole);
  for (const slug of ["size-default", "size-sm"]) assert.deepEqual(records(inParts, slug), records(inOne, slug), slug);
  for (const [key, entry] of Object.entries(inParts.components["ui/base/Card"].variants)) {
    if (key.includes("#")) assert.equal(entry.backgroundColor, undefined, "a later part carries no root fields");
    assert.ok(entry.part, `${key} says which part it is`);
  }
  assert.equal(verify(fixture, inParts, 0.5).elementFidelity, 1);
});

test("template: every response stays under use_figma's 20kb, at its default LIMIT, across sets", async () => {
  const figma = newFigma();
  const slices: [string, number, number, number][] = [];
  for (const name of ["card", "sidebar", "attachment", "button-icon", "avatar"]) {
    const fixture = loadTreeFixture(name);
    const built = await buildFixture(figma, fixture);
    slices.push([built.component, 0, fixture.components[0].variants.length - 1, 0]);
  }
  const results = await readBack(figma, slices);
  assert.ok(results.length >= 2, "more than one call's worth");
  for (const r of figma.runs.slice(-results.length)) assert.ok(r.bytes < 20_000, `${r.bytes} bytes`);
  assert.equal(new Set(results.flatMap((r) => r.sets.map((s) => s.component))).size, 5);
  // A call written with a LIMIT past 20kb fails, rather than return a read
  // use_figma would cut short.
  await assert.rejects(readBack(figma, slices, { limit: 60_000 }), /This read returns \d+ bytes, too near 20kb/);
});

test("template: a variant the build left no source on reads as inferred, never as measured", async () => {
  const figma = newFigma();
  const run = await figma.run(`
    const root = figma.createComponent();
    root.resize(10, 10);
    for (const [k, v] of [['id', 'nosrc'], ['slug', 'default'], ['i', '0']]) root.setSharedPluginData('storysync', k, v);`);
  assert.ok(run.ok, run.text);
  const [result] = await readBack(figma, [["nosrc", 0, 0, 0]], { page: "Page 1" });
  assert.equal(result.sets[0].entries.default.source, "inferred");
});

test("template: finds a set only by its storysync id, and refuses none or two", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  await assert.rejects(readBack(figma, [["ui-base-nothing", 0, 1, 0]]), /Found 0 sets with storysync id ui-base-nothing/);
  await assert.rejects(readBack(figma, [[built.component, 0, 1, 0]], { page: "Nowhere" }), /No page named "Nowhere"/);
  // A copy of the set keeps its plugin data, so two carry the id.
  await figma.run(`const s = await figma.getNodeByIdAsync(${JSON.stringify(built.id)}); const page = figma.root.children.find((p) => p.name === ${JSON.stringify(PAGE)}); await figma.setCurrentPageAsync(page); s.clone();`);
  await assert.rejects(readBack(figma, [[built.component, 0, 1, 0]]), /Found 2 sets with storysync id ui-base-switch/);
});

test("template: refuses a variant duplicated in Figma, and lists the variants it didn't build and the indexes it lacks", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("card");
  const built = await buildFixture(figma, fixture);
  // A designer's own variant, with no slug, and one of the built removed.
  await figma.run(`const page = figma.root.children.find((p) => p.name === ${JSON.stringify(PAGE)}); await figma.setCurrentPageAsync(page);
    const set = await figma.getNodeByIdAsync(${JSON.stringify(built.id)});
    const c = figma.createComponent(); c.name = 'size=xl'; set.appendChild(c);
    (await figma.getNodeByIdAsync(${JSON.stringify(built.variants[1].id)})).remove();`);
  const [result] = await readBack(figma, [[built.component, 0, 1, 0]]);
  assert.deepEqual([result.sets[0].unbuilt, result.sets[0].absent, result.sets[0].total, Object.keys(result.sets[0].entries)], [["size=xl"], [1], 2, ["size-default"]]);
  const missing = verify(fixture, assemble([result]), 0.5);
  assert.equal(missing.variants[1].status, "missing_from_figma");
  // The designer's variant, listed by name: in Figma, never scored.
  assert.deepEqual(missing.unreadInFigma, [{ component: "ui/base/Card", unbuilt: ["size=xl"], uncovered: 0 }]);
  assert.equal(missing.summary.unread, 1);

  await figma.run(`const page = figma.root.children.find((p) => p.name === ${JSON.stringify(PAGE)}); await figma.setCurrentPageAsync(page);
    const v = await figma.getNodeByIdAsync(${JSON.stringify(built.variants[0].id)}); const copy = v.clone(); (await figma.getNodeByIdAsync(${JSON.stringify(built.id)})).appendChild(copy);`);
  await assert.rejects(readBack(figma, [[built.component, 0, 1, 0]]), /carry the slug size-default: one was duplicated/);
});

/** Gives the variant `id` the index `i`, as the build gives a variant whose index a re-snap changed. */
async function setIndex(figma: ReturnType<typeof newFigma>, id: string, i: number): Promise<void> {
  const run = await figma.run(`(await figma.getNodeByIdAsync(${JSON.stringify(id)})).setSharedPluginData('storysync', 'i', '${i}');`);
  assert.ok(run.ok, run.text);
}

test("template: two variants of one index with other slugs are both read, in slug order, the one snap doesn't measure listed as such", async () => {
  // A re-snap dropped size-default: the build gave size-sm index 0 and left
  // size-default, which keeps its plugin data and its index 0.
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  await setIndex(figma, built.variants[1].id, 0);
  // First in the set, which doesn't change the order they are read in.
  const moved = await figma.run(`(await figma.getNodeByIdAsync(${JSON.stringify(built.id)})).insertChild(0, await figma.getNodeByIdAsync(${JSON.stringify(built.variants[1].id)}));`);
  assert.ok(moved.ok, moved.text);
  const [result] = await readBack(figma, [[built.component, 0, 0, 0]]);
  assert.deepEqual(Object.keys(result.sets[0].entries), ["size-default", "size-sm"]);
  const resnap = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
  resnap.components[0].variants = resnap.components[0].variants.filter((v) => v.slug === "size-sm");
  const scored = verify(resnap, assemble([result]), 0.5);
  assert.deepEqual(scored.variants.map((v) => [v.slug, v.status]), [["size-sm", "verified"]]);
  assert.deepEqual(scored.unmeasuredInFigma, [{ component: "ui/base/Switch", slug: "size-default" }]);
  // Counted as extra in the report's headline, which is then not clean,
  // in the JSON summary, and by --strict.
  assert.equal(scored.summary.elements!.extraVariants, 1);
  assert.deepEqual(treeStrictFailures(scored), ["1 variant in Figma's sets snap no longer measures"]);
  const report = formatElementReport(scored).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(report, /missing 0 · drifted 0 · extra 1 · /);
  assert.match(report, /\+ 1 extra variant in Figma's sets that snap no longer measures \(ui\/base\/Switch size-default\): `storysync figma code --remove-extra` removes those a push built, once the user says to/);
});

test("template: a variant a re-snap dropped, past the indexes read, is counted as in Figma and unread", async () => {
  // snap measures size-default alone now, so the plan reads index 0, and
  // size-sm, index 1, stays in the set.
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  const resnap = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
  resnap.components[0].variants = resnap.components[0].variants.filter((v) => v.slug === "size-default");
  const readback = assemble(await readBack(figma, [[built.component, 0, 0, 0]]));
  assert.deepEqual([readback.components["ui/base/Switch"].total, readback.components["ui/base/Switch"].unbuilt], [2, []]);
  const result = verify(resnap, readback, 0.5);
  assert.deepEqual(result.unreadInFigma, [{ component: "ui/base/Switch", unbuilt: [], uncovered: 1 }]);
  assert.equal(result.summary.unread, 1);
  assert.equal(result.elementFidelity, 1, "scored on what was read");
  assert.match(formatElementReport(result).join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /extra 1 · .*\n.*\+ 1 extra variant in Figma's sets that snap no longer measures \(ui\/base\/Switch: 1 variant no read covered\)/);
  // While a planned read has no result, its variants are unread for that reason, said already.
  assert.deepEqual(verify(resnap, readback, 0.5, { notRead: [3] }).unreadInFigma, []);
});

test("template: a call that stops among variants of one index continues at the right one, at the right node", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("card");
  const built = await buildFixture(figma, fixture);
  await setIndex(figma, built.variants[1].id, 0);
  const whole = assemble(await readBack(figma, [[built.component, 0, 0, 0]]));
  const records = (file: ReturnType<typeof assemble>, slug: string) => Object.entries(file.components["ui/base/Card"].variants)
    .filter(([key]) => key === slug || key.startsWith(`${slug}#`))
    .sort((a, b) => (a[1].part?.[0] ?? 0) - (b[1].part?.[0] ?? 0))
    .flatMap(([, e]) => e.tree!);
  // One variant a call: the second at index 0 is the next call's, from its first node.
  const one = await readBack(figma, [[built.component, 0, 0, 0]], { limit: 5000 });
  assert.equal(one.length, 2);
  const firstCount = whole.components["ui/base/Card"].variants["size-default"].tree!.length;
  assert.deepEqual(one[0].more, { slices: [[built.component, 0, 0, firstCount]] });
  assert.deepEqual(one.map((r) => Object.keys(r.sets[0].entries)), [["size-default"], ["size-sm"]]);
  // Less than a variant a call: parts, through both, each record once.
  const parts = await readBack(figma, [[built.component, 0, 0, 0]], { limit: 2500 });
  assert.ok(parts.length > 3);
  const inParts = assemble(parts);
  for (const slug of ["size-default", "size-sm"]) assert.deepEqual(records(inParts, slug), records(whole, slug), slug);
  assert.equal(verify(fixture, inParts, 0.5).elementFidelity, 1);
});

test("template: returned as a JSON string, should use_figma need one, it reads back the same", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  const asText = READBACK_TEMPLATE.replace("const RETURN_TEXT = false;", "const RETURN_TEXT = true;");
  assert.notEqual(asText, READBACK_TEMPLATE);
  const run = await figma.run(readbackCall(asText, PAGE, [[built.component, 0, 1, 0]]));
  assert.equal(typeof run.value, "string");
  const parsed = parseReadResult(run.text);
  assert.ok(parsed);
  assert.equal(verify(fixture, assemble([parsed]), 0.5).elementFidelity, 1);
  // LIMIT holds for the string as the tool returns it, escapes and all: a
  // Card read at 2,500, in parts filled to that, comes back in calls of at
  // most that.
  const card = await buildFixture(figma, loadTreeFixture("card"));
  let left: ReadSlice[] | undefined = [[card.component, 0, 1, 0]];
  const sizes: number[] = [];
  while (left?.length && sizes.length < 40) {
    const call = await figma.run(readbackCall(asText, PAGE, left, 2500));
    assert.ok(call.ok, call.text);
    sizes.push(call.bytes);
    left = parseReadResult(call.text)!.more?.slices;
  }
  assert.ok(sizes.length > 2 && !left?.length && sizes.every((b) => b <= 2500), sizes.join(", "));
});
