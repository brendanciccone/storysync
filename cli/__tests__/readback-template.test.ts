// The element-tree readback template (templates/readback.js), run in mock
// Figma as use_figma runs it: what it finds, what it returns, how it slices
// what doesn't fit, and how it refuses what it can't read truly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTreeFixture } from "./mock-figma.js";
import { PAGE, READBACK_TEMPLATE, assemble, buildFixture, newFigma, readBack } from "./tree-harness.js";
import { parseReadResult, readbackCall, readbackHeader } from "../figma-results.js";
import { RECORD } from "../tree-types.js";
import { readbackChecksum, verify } from "../verify.js";

/** The template with its comments and indentation stripped: an upper bound on what a minifier leaves. */
function stripped(source: string): string {
  return source.split("\n").map((line) => line.replace(/^\s+/, "")).filter((line) => line && !line.startsWith("//")).join("\n");
}

test("template: carries no data of its own, and a call is the four header lines and the template", () => {
  const code = stripped(READBACK_TEMPLATE);
  assert.doesNotMatch(code, /\b(const|let|var) (PAGE|SLICES|LIMIT|TPL)\b/, "the CLI's header declares these");
  assert.doesNotMatch(code, /SLUG_BY_NAME|SOURCE_BY_SLUG|SET_ID/, "no slugs, sources or set ids to fill in");
  // Design section 9.1's header, one constant a line, as `storysync figma code` writes it.
  assert.equal(readbackHeader("ui/base", [["ui-base-card", 0, 1, 0]], 9000), 'const PAGE = "ui/base";\nconst SLICES = [["ui-base-card",0,1,0]];\nconst LIMIT = 9000;\nconst TPL = 2;\n');
  assert.equal(readbackHeader("p", []), "const PAGE = \"p\";\nconst SLICES = [];\nconst LIMIT = 15000;\nconst TPL = 2;\n", "LIMIT 15,000 unless told otherwise");
  const call = readbackCall(READBACK_TEMPLATE, "p", [], 1);
  assert.ok(call.endsWith(READBACK_TEMPLATE));
  // How `storysync figma next` finds the LIMIT a call was written with, to continue it with the same.
  assert.equal(/\nconst LIMIT = (\d+);/.exec(`// storysync figma code, call 07: read back\n${call}`)?.[1], "1");
});

test("template: runs as `storysync figma code` writes a read call, and refuses a call for another template", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  // A call file as figma-code.ts readCode writes it: a comment, then the
  // four constants a line each, each slice with its first node.
  const header = (tpl: number) => `// storysync figma code, call 07: read back on "${PAGE}"\nconst PAGE = ${JSON.stringify(PAGE)};\nconst SLICES = ${JSON.stringify([[built.component, 0, 1, 0]])};\nconst LIMIT = 15000;\nconst TPL = ${tpl};\n`;
  const run = await figma.run(`${header(2)}${READBACK_TEMPLATE}\n`);
  assert.ok(run.ok, run.text);
  const result = run.value as { tpl: number; sets: { entries: Record<string, unknown> }[] };
  assert.equal(result.tpl, 2);
  assert.deepEqual(Object.keys(result.sets[0].entries), ["size-default", "size-sm"]);
  const other = await figma.run(`${header(3)}${READBACK_TEMPLATE}\n`);
  assert.equal(other.ok, false);
  assert.match(other.text, /This is readback template 2, not 3/);
});

test("template: stays small enough to minify under 8,000 characters", () => {
  // terser takes it to about 7.8k (B's templates test checks the minified
  // file); stripped of comments and indentation alone it must stay under this.
  assert.ok(stripped(READBACK_TEMPLATE).length <= 12_000, `${stripped(READBACK_TEMPLATE).length} characters stripped`);
});

test("template: returns an object, each entry sealed under its set's id and key, with records of their kind's length", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("attachment");
  const built = await buildFixture(figma, fixture);
  const [result] = await readBack(figma, [[built.component, 0, 3, 0]]);
  assert.equal(typeof result, "object");
  assert.deepEqual([result.kind, result.tpl, result.page, result.more], ["read", 2, PAGE, undefined]);
  const [set] = result.sets;
  assert.deepEqual([set.id, set.component, set.title, set.total, set.unbuilt, set.absent], [built.id, "ui-base-attachment", "ui/base/Attachment", 4, [], []]);
  for (const [slug, entry] of Object.entries(set.entries)) {
    assert.equal(entry.checksum, readbackChecksum(set.id, slug, entry));
    assert.equal(entry.tpl, 2);
    assert.equal(entry.source, "measured");
    for (const record of entry.tree!) assert.equal(record.length, RECORD[record[1] as "F" | "T" | "V"]);
    assert.deepEqual(entry.tree!.map((r) => r[0]), ["", "attachment-content", "attachment-content/attachment-title", "attachment-content/attachment-description", "attachment-media", "attachment-media/svg", "attachment-action", "attachment-action/svg"]);
  }
  // A record in the browser's terms: the title, cut off after one line.
  const title = set.entries["size-default--orientation-vertical--state-done"].tree![2];
  assert.deepEqual(title.slice(0, 7), ["attachment-content/attachment-title", "T", 4, 0, 94, 17.5, "sales-dashboard.pdf"]);
  assert.deepEqual(title.slice(17, 20), ["ENDING", 1, "HEIGHT"]);
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
  for (const r of figma.runs.slice(-results.length)) assert.ok(r.ok && r.bytes <= 15_000 + 100, `${r.bytes} bytes`);
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
});
