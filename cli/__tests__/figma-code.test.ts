import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callConstants, callSum } from "../checksum.js";
import { CALL_CONSTANTS, DEFAULT_READ_LIMIT, ESTIMATE, describeBinding, describeEstimate, estimatePush, formatTokens, loadTemplate, parseCallResult, planSnapChanged, predictRead, readPlan, runFigmaCode, runFigmaNext } from "../figma-code.js";
import { READ_LIMIT, loadPlanResults } from "../figma-results.js";
import { MAX_CALL_CHARS } from "../figma-spike.js";
import { describeMeasurementNotes } from "../snap.js";
import { componentKey } from "../storybook.js";
import { expandTree } from "../tree-types.js";
import type { FigmaPlan, NoClassPaint, PlanCall, TreeDelta, TreeNode } from "../tree-types.js";
import { formatElementReport, verify } from "../verify.js";
import { SHADCN_TOKENS, STUB_READBACK, codeFor, mockFor, runPlan } from "./figma-build-harness.js";
import { FONTS, loadTreeFixture, svgShapeBoxes, treeFixtureNames, withNoClass } from "./mock-figma.js";
import type { TreeFixture } from "./mock-figma.js";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Every fixture's component in one snap, ordered by key as snap writes several. */
function allFixtures(): TreeFixture {
  const fixtures = treeFixtureNames().map(loadTreeFixture);
  const snap = copy(fixtures[0]);
  snap.components = fixtures.flatMap((f) => f.components).sort((a, b) => componentKey(a).localeCompare(componentKey(b)));
  return snap;
}

/** A variant's records, from its part's base and its delta, as the build template expands them. */
function recordsOf(base: unknown[][], delta: unknown): unknown[][] {
  if (!Array.isArray(delta)) return (delta as { r: unknown[][] }).r;
  const records = base.map((r) => [...r]);
  for (const [i, box, style] of delta as [number, number[] | 0, number][]) {
    if (box) records[i].splice(3, 4, ...box);
    if (style >= 0) records[i][7] = style;
  }
  return records;
}

/** The DATA a call carries. */
const dataOf = (code: string) => JSON.parse(/\nconst DATA = (.*);\n/.exec(code)![1]) as Record<string, unknown>;

/** Every file under a directory, by path, with its text. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name), `${rel}${entry.name}/`);
      else out[`${rel}${entry.name}`] = readFileSync(join(at, entry.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}

test("figma code: builds by page, then images, one label, then reads, each file and result named by its order", async () => {
  const coded = await codeFor(allFixtures());
  const calls = coded.plan.calls;
  const order = calls.map((c) => `${c.kind} ${c.page}`).join(", ");
  assert.match(order, /^build Forms, (build ui\/base, )+images ui\/base, label , read Forms, (read ui\/base, )*read ui\/base$/);
  assert.deepEqual(calls.map((c) => c.seq), calls.map((_, i) => i + 1));
  assert.deepEqual(calls.slice(0, 2).map((c) => [c.file, c.result]), [["calls/01-build-forms.js", "results/01.json"], ["calls/02-build-ui-base.js", "results/02.json"]]);
  const label = calls.find((c) => c.kind === "label")!;
  assert.equal(label.file, `calls/${String(label.seq).padStart(2, "0")}-label.js`);
  assert.equal(coded.plan.version, 1);
  assert.equal(coded.plan.snap.path, "../snaps/styles.json");
  assert.match(coded.plan.snap.digest, /^[0-9a-f]{8}$/);
  for (const call of calls) {
    const code = coded.code(call);
    assert.equal(code.length, call.chars, `${call.file}: chars is the file's length`);
    assert.ok(code.length <= MAX_CALL_CHARS, `${call.file} is ${code.length} characters`);
    assert.ok(code.startsWith(`// storysync figma code, call ${String(call.seq).padStart(2, "0")}:`));
  }
  assert.ok(existsSync(join(coded.out, "results")));
});

test("figma code: two runs over the same snap write the same bytes", async () => {
  const snap = allFixtures();
  const a = await codeFor(snap);
  const b = await codeFor(snap);
  assert.deepEqual(files(b.out), files(a.out));
});

test("figma code: every call is at most --max-chars and --max-nodes, and no variant is split", async () => {
  // Sidebar, its one variant 25 nodes, as 60 variants of one component.
  const snap = copy(loadTreeFixture("sidebar"));
  const component = snap.components[0];
  component.variantProperties = [{ name: "n", type: "VARIANT", values: Array.from({ length: 60 }, (_, i) => String(i)), defaultValue: "0" }];
  component.variants = Array.from({ length: 60 }, (_, i) => ({ ...copy(component.variants[0]), combination: { n: String(i) }, slug: `n-${i}`, ...(i ? { treeDelta: {} } : {}) }));
  component.base!.slug = "n-0";
  // 28,000: one variant, about 7,400, beside the build template at its budget (19,500, templates.test.ts)
  // and the guard, about 700, and room for a few of the variants whose deltas are empty.
  for (const [maxChars, maxNodes] of [[45_000, 400], [28_000, 400], [45_000, 100]]) {
    const coded = await codeFor(snap, { maxChars, maxNodes });
    const builds = coded.plan.calls.filter((c) => c.kind === "build");
    assert.ok(builds.length > 1, `${maxChars}/${maxNodes} packs into ${builds.length} calls`);
    const slugs: string[] = [];
    for (const call of builds) {
      assert.ok(call.chars <= maxChars, `${call.file}: ${call.chars} characters`);
      assert.ok(call.nodes! <= maxNodes, `${call.file}: ${call.nodes} nodes`);
      const data = dataOf(coded.code(call)) as { sets: { v: [string, string][] }[] };
      for (const set of data.sets) slugs.push(...set.v.map((v) => v[1]));
    }
    assert.deepEqual(slugs, component.variants.map((v) => v.slug), "every variant once, in snap order");
  }
});

test("figma code: a variant too big for any one call is left out and said, and everything else is planned", async () => {
  for (const big of [1, 0]) {
    const snap = copy(loadTreeFixture("card"));
    snap.components.push(copy(loadTreeFixture("switch").components[0]));
    const card = snap.components[0];
    const variants = card.variants as (typeof card.variants[number] & { treeDelta?: TreeDelta })[];
    // A title of 60,000 characters: more code than use_figma takes in one call.
    const title = expandTree(card.tree, variants[big].treeDelta).find((n) => n.k === "card-header/card-title")!;
    const delta = variants[big].treeDelta ?? {};
    delta.set = { ...delta.set, "card-header/card-title": { ...delta.set?.["card-header/card-title"], tx: { ...title.tx!, c: "x".repeat(60_000) } } };
    if (big) variants[big].treeDelta = delta;
    else card.tree.base.find((n) => n.k === "card-header/card-title")!.tx!.c = "x".repeat(60_000);
    const coded = await codeFor(snap);
    const slug = card.variants[big].slug;
    assert.equal(coded.warnings.length, 1);
    assert.match(coded.warnings[0], new RegExp(`^ui/base/Card ${slug}: not built: its 23 nodes need \\d+ characters of code, more than one use_figma call takes \\(50000\\), and a variant is never split across calls$`));
    const kept = card.variants[1 - big].slug;
    const builds = coded.plan.calls.filter((c) => c.kind === "build");
    assert.deepEqual(builds.flatMap((c) => (dataOf(coded.code(c)) as { sets: { v: string[][] }[] }).sets.flatMap((s) => s.v.map((v) => v[1]))), [kept, "size-default", "size-sm"]);
    assert.deepEqual(builds[0].description, `Create or update Card (variant ${2 - big} of 2), Switch (2 variants) on page "ui/base"`);
    assert.deepEqual(coded.plan.calls.filter((c) => c.kind === "read").flatMap((c) => c.slices), [["ui-base-card", 1 - big, 1 - big], ["ui-base-switch", 0, 1]]);
    const mock = mockFor([loadTreeFixture("card"), loadTreeFixture("switch")]);
    await runPlan(mock, coded);
  }
});

test("figma code: a build call lists at most 60 images to upload, as many URLs as upload_assets hands out", async () => {
  // Avatar as 61 variants, each its own photo: the images, not the nodes, split the calls.
  const snap = copy(loadTreeFixture("avatar"));
  const component = snap.components[0];
  const asset = Object.values(component.tree.assets.img)[0];
  component.tree.assets.img = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`img:${String(i).padStart(12, "0")}-0000`, asset]));
  component.variantProperties = [{ name: "n", type: "VARIANT", values: Array.from({ length: 61 }, (_, i) => String(i)), defaultValue: "0" }];
  component.variants = Array.from({ length: 61 }, (_, i) => ({
    ...copy(component.variants[0]), combination: { n: String(i) }, slug: `n-${i}`,
    ...(i ? { treeDelta: { set: { "avatar-image": { img: `img:${String(i).padStart(12, "0")}-0000` } } } } : {}),
  }));
  component.tree.base.find((n) => n.k === "avatar-image")!.img = "img:000000000000-0000";
  component.base = { ...component.base!, combination: { n: "0" }, slug: "n-0" };
  const coded = await codeFor(snap);
  const builds = coded.plan.calls.filter((c) => c.kind === "build");
  const images = builds.map((call) => new Set((dataOf(coded.code(call)) as { S: { im?: string }[] }).S.map((st) => st?.im).filter(Boolean)).size);
  assert.deepEqual(images, [60, 1]);
});

test("figma next: a continuation reads with the limit its call was written with", async () => {
  const coded = await codeFor(loadTreeFixture("card"), { readLimit: 4_000 });
  const read = coded.plan.calls.find((c) => c.kind === "read")!;
  assert.match(coded.code(read), /\nconst LIMIT = 5000;\n/);
  writeFileSync(join(coded.out, read.result), JSON.stringify({ kind: "read", more: { slices: [["ui-base-card", 1, 1, 12]] } }));
  const next = await runFigmaNext({ plan: join(coded.out, "plan.json"), seq: read.seq, templates: { readback: STUB_READBACK } });
  assert.match(readFileSync(next!.file, "utf8"), /\nconst LIMIT = 5000;\n/);
});

test("figma next: a continuation refuses a change as one to the file figma next wrote, as a read call does to the one figma code wrote", async () => {
  const coded = await codeFor(loadTreeFixture("card"));
  const read = coded.plan.calls.find((c) => c.kind === "read")!;
  assert.match(coded.code(read), /This call differs from the file storysync figma code wrote/);
  writeFileSync(join(coded.out, read.result), JSON.stringify({ kind: "read", more: { slices: [["ui-base-card", 1, 1, 12]] } }));
  const next = await runFigmaNext({ plan: join(coded.out, "plan.json"), seq: read.seq });
  const code = readFileSync(next!.file, "utf8");
  assert.match(code, /This call differs from the file storysync figma next wrote: its data fails its checksum, SUM/);
  assert.doesNotMatch(code, /figma code wrote/);
});

test("figma next: a continuation is written from the template its call was, readable after figma code --no-minify", async () => {
  for (const minify of [true, false]) {
    const coded = await codeFor(loadTreeFixture("card"), { minify, templates: {} });
    const read = coded.plan.calls.find((c) => c.kind === "read")!;
    const readable = (code: string) => code.includes("// storysync readback, template");
    assert.equal(readable(coded.code(read)), !minify);
    writeFileSync(join(coded.out, read.result), JSON.stringify({ kind: "read", more: { slices: [["ui-base-card", 1, 1, 12]] } }));
    const next = await runFigmaNext({ plan: join(coded.out, "plan.json"), seq: read.seq });
    assert.equal(readable(readFileSync(next!.file, "utf8")), !minify, `minify ${minify}`);
  }
});

/** A call's constants, in order, each line's value parsed, SUM's as written. */
function constantsOf(code: string): { names: string[]; values: unknown[]; sum: unknown } {
  // The constants, as JSON, a line each; T, the template, is a string of code.
  const lines = [...code.matchAll(/^const (?!T = )(\w+) = (.*);$/gm)].map((m) => [m[1], JSON.parse(m[2])] as const);
  const at = lines.findIndex(([name]) => name === "SUM");
  return { names: lines.slice(0, at + 1).map(([name]) => name), values: lines.slice(0, at).map(([, v]) => v), sum: lines[at]?.[1] };
}

test("figma code: every call, and a read's continuation, ends its constants with SUM, the checksum of their values its template checks", async () => {
  const coded = await codeFor(allFixtures());
  assert.deepEqual([...new Set(coded.plan.calls.map((c) => c.kind))], ["build", "images", "label", "read"]);
  for (const call of coded.plan.calls) {
    const { names, values, sum } = constantsOf(coded.code(call));
    assert.deepEqual(names, CALL_CONSTANTS[call.kind === "read" ? "readback" : call.kind], call.file);
    assert.equal(sum, callSum(values), call.file);
  }
  const read = coded.plan.calls.find((c) => c.kind === "read")!;
  writeFileSync(join(coded.out, read.result), JSON.stringify({ kind: "read", more: { slices: [["ui-base-card", 1, 1, 12]] } }));
  const next = await runFigmaNext({ plan: join(coded.out, "plan.json"), seq: read.seq });
  const { values, sum } = constantsOf(readFileSync(next!.file, "utf8"));
  assert.deepEqual(values.slice(1, 3), [[["ui-base-card", 1, 1, 12]], DEFAULT_READ_LIMIT + 1000]);
  assert.equal(sum, callSum(values));
});

test("figma code: a variant over --max-nodes gets a call of its own, and a warning", async () => {
  const coded = await codeFor(loadTreeFixture("sidebar"), { maxNodes: 10 });
  assert.equal(coded.plan.calls.filter((c) => c.kind === "build").length, 1);
  assert.deepEqual(coded.warnings, ["call 01 holds one variant of 25 nodes, over --max-nodes 10"]);
});

test("figma code: a call's variants share their base's records and styles, each sent once", async () => {
  const coded = await codeFor(loadTreeFixture("toggle"));
  const data = dataOf(coded.code(coded.plan.calls[0])) as { S: unknown[]; sets: { base: unknown[][]; v: unknown[][] }[] };
  const [set] = data.sets;
  assert.equal(set.v.length, 6);
  assert.deepEqual(set.v[0][5], [], "the base itself changes nothing");
  // size=sm moves its icon and pads less: two records change, by box and style.
  assert.deepEqual((set.v[1][5] as unknown[]).map((d) => (d as unknown[])[0]), [0, 1]);
  const markups = data.S.filter((s) => typeof s === "string" && s.startsWith("<svg"));
  assert.equal(markups.length, 1, "the icon's markup is in the table once");
});

test("figma code: reads pack to 17,000 predicted, stopping at 18,000, under what use_figma was seen to return whole", async () => {
  // The fifth live push's 12 reads came back at 10,700 to 12,700 bytes,
  // packed to 14,000 predicted, each carrying the 8,000 character
  // template. The sixth probe saw use_figma return 18,999 bytes whole.
  const probe = JSON.parse(readFileSync(new URL("../../../cli/__tests__/fixtures/figma-tsum-probe.json", import.meta.url), "utf8")) as { call5: { bytes: number } };
  assert.equal(DEFAULT_READ_LIMIT, 17_000);
  assert.equal(READ_LIMIT, DEFAULT_READ_LIMIT + 1000);
  assert.ok(READ_LIMIT < probe.call5.bytes, "a read stops under what came back whole");
  // And the template's guard throws past 19,000, a byte over that.
  assert.match(loadTemplate("readback"), />19e3\)throw/);
  // The seventh probe: use_figma counts the JSON it returns, not that JSON
  // escaped again, and in bytes, its limit 20,480. A response of 18,999
  // characters, 30% of them quotes or backslashes (a read's records run
  // 15%), came back whole, as did one the template counts at 19,000 with
  // half its bytes outside ASCII; one of 20,500 was refused.
  const seventh = JSON.parse(readFileSync(new URL("../../../cli/__tests__/fixtures/figma-probe-7.json", import.meta.url), "utf8")) as {
    call2: { chars: string; dense: string; end: string }; call3: { counted: string; utf8: string; end: string }; call4: string;
  };
  assert.deepEqual([seventh.call2.end, seventh.call3.end], ["END", "END"]);
  assert.ok(Number(seventh.call2.dense) / Number(seventh.call2.chars) > 0.25 && Number(seventh.call2.chars) >= 18_999);
  assert.equal(Number(seventh.call3.counted), 19_000);
  const limit = Number(/exceeds the (\d+)-byte limit \(20500 bytes\)/.exec(seventh.call4)?.[1]);
  assert.equal(limit, 20_480);
  assert.ok(19_000 < limit, "the most a read returns, its guard's, is under the limit");
});

test("figma code: reads slice each page's variants in order, each call predicted under --read-limit", async () => {
  const snap = allFixtures();
  for (const readLimit of [DEFAULT_READ_LIMIT, 4_000]) {
    const coded = await codeFor(snap, { readLimit });
    const reads = coded.plan.calls.filter((c) => c.kind === "read");
    const seen = new Map<string, number[]>();
    for (const call of reads) {
      assert.ok(call.predicted! <= readLimit || call.slices!.length === 1 && call.slices![0][1] === call.slices![0][2], `${call.file} predicts ${call.predicted}`);
      const code = coded.code(call);
      assert.match(code, new RegExp(`\\nconst PAGE = ${JSON.stringify(call.page).replace(/\//g, "\\/")};\\nconst SLICES = `));
      // The constants the readback template reads, and none it declares.
      assert.match(code, new RegExp(`\\nconst LIMIT = ${readLimit + 1000};\\nconst TPL = 4;\\nconst SUM = "[0-9a-f]{8}";\\nconst TSUM = "[0-9a-f]{8}";\\nconst T = \`${STUB_READBACK.replace(/[()[\]{}.*+?^$|\\]/g, "\\$&")}\`;\\n`));
      assert.deepEqual([...code.matchAll(/^const (\w+) = /gm)].map((m) => m[1]), ["PAGE", "SLICES", "LIMIT", "TPL", "SUM", "TSUM", "T"]);
      for (const [id, first, last] of call.slices!) seen.set(id, [...(seen.get(id) ?? []), ...Array.from({ length: last - first + 1 }, (_, i) => first + i)]);
    }
    for (const component of snap.components) {
      assert.deepEqual(seen.get(component.id ?? component.title!), component.variants.map((_, i) => i), `${component.title} read once each`);
    }
  }
});

test("figma code: refuses a template that declares a constant its call writes, before writing any call", async () => {
  // As package C's readback template once declared the TPL figma code also writes: a SyntaxError in Figma on every read.
  for (const readback of ["const TPL = 2;\nreturn { kind: 'read' };", "const PAGE = 'x', SLICES = [];\nreturn {};"]) {
    const out = await codeFor(loadTreeFixture("switch"), { templates: { readback } }).catch((e: Error) => e.message);
    assert.match(String(out), /^calls\/03-read-ui-base\.js is not code use_figma can run \(.*has already been declared\): a template must not declare the constants its call writes before it$/);
  }
  await assert.rejects(codeFor(loadTreeFixture("switch"), { templates: { readback: STUB_READBACK, build: "return {" } }), /^Error: calls\/01-build-ui-base\.js is not code use_figma can run/);
});

test("predictRead: an entry grows with its nodes, keys, text and shapes", () => {
  const card = loadTreeFixture("card").components[0];
  const nodes = expandTree(card.tree, undefined);
  const size = predictRead(nodes, "size-default");
  assert.ok(size > 520 + 23 * 55 && size < 6000, `card predicts ${size}`);
  assert.ok(predictRead(nodes.slice(0, 2), "size-default") < size);
});

test("figma code: the label call carries a line for a set measured from a closed trigger, without quotes", async () => {
  const snap = allFixtures();
  snap.components.find((c) => c.name === "Switch")!.warnings = ['snap measured button[data-slot="dialog-trigger"], a closed trigger, rather than Switch. Have it render open.'];
  const coded = await codeFor(snap);
  const data = dataOf(coded.code(coded.plan.calls.find((c) => c.kind === "label")!)) as { pages: string[]; sets: [string, string][] };
  assert.deepEqual(data.pages, ["Forms", "ui/base"]);
  assert.deepEqual(data.sets.find(([id]) => id === "ui-base-switch"), ["ui-base-switch", "measured from its closed trigger, button[data-slot=dialog-trigger], not the open Switch"]);
  assert.deepEqual(data.sets.find(([id]) => id === "ui-base-card"), ["ui-base-card", ""]);
  // The example's 0.3.0 snap has no Storybook id: its title stands in, as verify keys it.
  assert.ok(data.sets.some(([id]) => id === "Forms/Button"));
});

test("figma code: the label line of a closed trigger snap didn't open says why, without quotes; an overlay it opened gets none", async () => {
  const snap = allFixtures();
  const switchSet = snap.components.find((c) => c.name === "Switch")!;
  switchSet.warnings = describeMeasurementNotes("Switch", [{
    slug: "a", note: { kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]', reason: 'clicking it failed (locator resolved to "Open")' },
  }], 1);
  const card = snap.components.find((c) => c.name === "Card")!;
  card.variants = card.variants.map((v) => ({ ...v, opened: { via: "click" as const, trigger: 'button[data-slot="dialog-trigger"]' }, portal: true as const }));
  const coded = await codeFor(snap);
  const data = dataOf(coded.code(coded.plan.calls.find((c) => c.kind === "label")!)) as { sets: [string, string][] };
  assert.deepEqual(data.sets.find(([id]) => id === "ui-base-switch"), [
    "ui-base-switch",
    "measured from its closed trigger, button[data-slot=dialog-trigger], not the open Switch, as snap didn't open it (clicking it failed (locator resolved to Open))",
  ]);
  assert.deepEqual(data.sets.find(([id]) => id === "ui-base-card"), ["ui-base-card", ""]);
});

test("figma code: the label call says which variants a story of their own measured, after any other line", async () => {
  const snap = allFixtures();
  const card = snap.components.find((c) => c.name === "Card")!;
  card.variants[card.variants.length - 1].storyId = "ui-base-card--with-footer";
  const switchSet = snap.components.find((c) => c.name === "Switch")!;
  switchSet.warnings = ['snap measured button[data-slot="dialog-trigger"], a closed trigger, rather than Switch. Have it render open.'];
  switchSet.variants[switchSet.variants.length - 1].storyId = "ui-base-switch--checked";
  const coded = await codeFor(snap);
  const data = dataOf(coded.code(coded.plan.calls.find((c) => c.kind === "label")!)) as { pages: string[]; sets: [string, string][] };
  const line = (id: string) => data.sets.find(([set]) => set === id)![1];
  assert.match(line("ui-base-card"), /^measured .* from ui-base-card--with-footer, the rest from ui-base-card--default$/);
  assert.match(line("ui-base-switch"), /^measured from its closed trigger, button\[data-slot=dialog-trigger\], not the open Switch; measured .* from ui-base-switch--checked, the rest from /);
});

test("figma code: a color two of an element's classes name, which tie, is said to be left unbound for that, not for no class naming one", async () => {
  // shadcn's Alert title: text-card-foreground, inherited from the root, and its own text-foreground, both #0a0a0a.
  const snap = copy(loadTreeFixture("dialog"));
  const title = snap.components[0].tree.base.find((n) => n.k === "dialog-header/dialog-title")! as { cls: string[] | null };
  title.cls = ["text-card-foreground", "text-foreground"];
  const coded = await codeFor(snap, {}, SHADCN_TOKENS);
  assert.ok(coded.warnings.includes("ui/base/Dialog: color #0a0a0a left unbound: it matches card/foreground, foreground, popover/foreground, sidebar/foreground, and its classes name two of them, card/foreground and foreground, so it binds to neither rather than to a guess"), coded.warnings.join("\n"));
  // The close button's label, which no class colors, is still said as such.
  assert.ok(coded.warnings.includes("ui/base/Dialog: color #0a0a0a left unbound: it matches card/foreground, foreground, popover/foreground, sidebar/foreground, and no class names one"));
});

test("figma code: --components and --skip pick what to build, matched as snap and verify match them", async () => {
  const coded = await codeFor(allFixtures(), { components: ["ui-base-card", "switch", "Forms/Button"], skip: ["Button"] });
  assert.deepEqual([...new Set(coded.plan.calls.flatMap((c) => c.components))], ["ui/base/Card", "ui/base/Switch"]);
  await assert.rejects(codeFor(allFixtures(), { components: ["Nope"] }), /--components matched no component named "Nope"/);
});

test("figma code: refuses a snap without element trees, pointing to --root-only and the skill's templates", async () => {
  const snap = copy(loadTreeFixture("switch")) as unknown as { components: { tree?: unknown }[] };
  delete snap.components[0].tree;
  await assert.rejects(codeFor(snap), /no element tree for ui\/base\/Switch: it was taken with --root-only.*skill's root-only templates/);
});

test("figma code: a component that failed is left out and said; variants snap couldn't measure are said", async () => {
  const snap = allFixtures();
  snap.components.find((c) => c.name === "Switch")!.error = "Story failed to render";
  const coded = await codeFor(snap);
  assert.ok(!coded.plan.calls.some((c) => c.components.includes("ui/base/Switch")));
  assert.ok(coded.warnings.includes("ui/base/Switch: not built: Story failed to render"));
  assert.ok(coded.warnings.includes('ui/base/Button: 2 variants built as a "Not measured" placeholder, since snap couldn\'t measure them'));
});

test("figma code: what it builds another way says what it builds instead, and never that it isn't built", async () => {
  // The fifth push's warning: `transform rotate: 45deg, built as its
  // bounding box is not built`. The Tooltip's arrow out of the flow is now
  // built turned, and says nothing; in the flow, it says how it is built.
  assert.deepEqual((await codeFor(loadTreeFixture("tooltip"))).warnings, []);
  const inFlow = copy(loadTreeFixture("tooltip"));
  delete inFlow.components[0].tree.base[2].abs;
  const coded = await codeFor(inFlow);
  assert.deepEqual(coded.warnings.filter((w) => /transform/.test(w)), [
    "ui/base/Tooltip › div: transform rotate: 45deg is built as its own box, unturned, as Figma's auto layout would place it by its turned box",
  ]);
});

test("figma code: what it can't build, and values several tokens share with no class to pick, are said per component", async () => {
  const snap = copy(loadTreeFixture("sidebar"));
  snap.components[0].tree.base[1].bf = "blur(8px) saturate(1.8)";
  const dir = await codeFor(snap, {}, { collections: [{ category: "colors", tokens: [{ name: "a", value: "", hex: "#fafafa" }, { name: "b", value: "", hex: "#fafafa" }] }] });
  assert.deepEqual(dir.warnings, [
    "ui/base/Sidebar › sidebar-container: backdrop-filter blur(8px) saturate(1.8) is not built",
    "ui/base/Sidebar: fill #fafafa left unbound: it matches a, b, and no class names one",
  ]);
  const without = await codeFor(loadTreeFixture("switch"), { tokens: "/nonexistent/tokens.json" });
  assert.deepEqual(without.warnings, ["no tokens at /nonexistent/tokens.json, so nothing is bound to a variable: save them first with `npx storysync tokens --json > /nonexistent/tokens.json`"]);
});

/** What snap now says of Dialog's title and Cancel: no class colors them, and body's base style does. */
const DIALOG_NO_CLASS: Record<string, NoClassPaint[]> = { "dialog-header/dialog-title": ["color"], "dialog-footer/dialog-close/#text": ["color"] };

test("figma code: a value the base styles bind is recorded in the plan with its rule, and not warned as unbound", async () => {
  const from = "app/globals.css, @layer base: body { @apply bg-background text-foreground }";
  const tokens = { ...SHADCN_TOKENS, defaults: [{ property: "color", token: "foreground", from }] };
  const coded = await codeFor(withNoClass(loadTreeFixture("dialog"), DIALOG_NO_CLASS), {}, tokens);
  // The title and Cancel both: once, with each layer it bound.
  assert.deepEqual(coded.plan.bindings, [{
    component: "ui/base/Dialog", property: "color", value: "#0a0a0a", variable: "foreground", from,
    keys: ["dialog-footer/dialog-close/#text", "dialog-header/dialog-title"],
  }]);
  assert.deepEqual(JSON.parse(readFileSync(join(coded.out, "plan.json"), "utf8")).bindings, coded.plan.bindings);
  assert.equal(coded.warnings.some((w) => /left unbound/.test(w)), false);
  // Without them, as tokens.json from before, or from a snap that didn't
  // say no class colors them: warned as it was, and no bindings.
  for (const [snap, t] of [[withNoClass(loadTreeFixture("dialog"), DIALOG_NO_CLASS), SHADCN_TOKENS], [loadTreeFixture("dialog"), tokens]] as [object, object][]) {
    const before = await codeFor(snap, {}, t);
    assert.equal(before.plan.bindings, undefined);
    assert.ok(before.warnings.includes("ui/base/Dialog: color #0a0a0a left unbound: it matches card/foreground, foreground, popover/foreground, sidebar/foreground, and no class names one"));
  }
});

test("figma code: with a dark theme, a value whose tokens are alike in every mode binds to one, recorded in the plan with them, not warned as unbound", async () => {
  // shadcn/ui's neutral theme: the four hold #0a0a0a in Light and #fafafa in Dark.
  const tokens = structuredClone(SHADCN_TOKENS) as { collections: { category: string; tokens: { name: string; hex?: string; dark?: { value: string; hex: string } }[] }[] };
  for (const t of tokens.collections[0].tokens) if (t.hex === "#0a0a0a") t.dark = { value: "#fafafa", hex: "#fafafa" };
  const coded = await codeFor(loadTreeFixture("dialog"), {}, tokens);
  const alike = ["card/foreground", "foreground", "popover/foreground", "sidebar/foreground"];
  assert.deepEqual(coded.plan.bindings?.map((b) => [b.property, b.value, b.variable, b.alike]), [["color", "#0a0a0a", "card/foreground", alike]]);
  assert.equal(coded.warnings.some((w) => /#0a0a0a left unbound/.test(w)), false);
});

test("figma code: a new plan clears the last plan's calls and results, and leaves every other file", async () => {
  const coded = await codeFor(allFixtures());
  const old = ["results/05.json", "results/07b.json", "results/03.upload.json", "calls/99-build-old.js", "calls/07b-read-ui-base.js"];
  // --out may be a directory with folders of these names: what a plan didn't write stays.
  const foreign = ["results/quarterly.csv", "results/notes.json", "results/05.json.bak", "calls/notes.md", "calls/build.js", "plan-notes.txt"];
  for (const file of [...old, ...foreign]) writeFileSync(join(coded.out, file), "{}");
  mkdirSync(join(coded.out, "results", "06.json"));
  await runFigmaCode({ snap: coded.snapPath, out: coded.out, templates: { readback: STUB_READBACK } });
  for (const file of old) assert.ok(!existsSync(join(coded.out, file)), `${file} is removed`);
  for (const file of [...foreign, "results/06.json"]) assert.ok(existsSync(join(coded.out, file)), `${file} is kept`);
  assert.deepEqual(readdirSync(join(coded.out, "calls")).filter((f) => !foreign.includes(`calls/${f}`)), coded.plan.calls.map((c) => c.file.slice(6)));
});

test("figma code: a new plan keeps the one Figma answered under earlier/, which verify --plan can still score", async () => {
  // Each push writes its plan to .storysync/figma, while the snap keeps
  // every push's components: the last push's plan must stay verifiable.
  const snap = loadTreeFixture("example-button");
  const coded = await codeFor(snap, { templates: {} });
  const mock = mockFor([snap]);
  mkdirSync(join(coded.out, "results"), { recursive: true });
  for (const call of coded.plan.calls) {
    const run = await mock.run(coded.code(call));
    assert.ok(run.ok, `${call.file}: ${run.text}`);
    writeFileSync(join(coded.out, call.result), run.text);
  }
  const again = await runFigmaCode({ snap: coded.snapPath, out: coded.out, templates: {} });
  assert.ok(again.earlier, "the answered plan is kept");
  assert.equal(dirname(dirname(again.earlier!)), join(coded.out, "earlier"));
  assert.deepEqual(readdirSync(join(coded.out, "results")), []);
  const earlier = readPlan(again.earlier!);
  assert.equal(resolve(dirname(again.earlier!), earlier.snap.path), coded.snapPath);
  assert.equal(planSnapChanged(earlier, readFileSync(coded.snapPath)), false);
  const { readback, notRead, problems } = loadPlanResults(again.earlier!);
  assert.deepEqual([notRead, problems], [[], []]);
  const result = verify(JSON.parse(readFileSync(coded.snapPath, "utf8")), readback, 0.5, { notRead });
  assert.ok((result.summary.elements?.verified ?? 0) > 0);
  // A plan with no read answered has nothing to verify: removed, as before.
  writeFileSync(join(coded.out, again.plan.calls[0].result), "{}");
  const third = await runFigmaCode({ snap: coded.snapPath, out: coded.out, templates: {} });
  assert.equal(third.earlier, undefined);
  assert.deepEqual(readdirSync(join(coded.out, "results")), []);
  assert.deepEqual(readdirSync(join(coded.out, "earlier"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(coded.out, "earlier", e.name, "plan.json")), [again.earlier]);
});

test("figma code: every planned call runs in the mock, in order", async () => {
  const snap = allFixtures();
  const coded = await codeFor(snap);
  const mock = mockFor(treeFixtureNames().map(loadTreeFixture), { pages: ["Page 1"] });
  const runs = await runPlan(mock, coded);
  assert.deepEqual(runs.map((r) => (r.value as { kind: string }).kind), coded.plan.calls.map((c) => c.kind));
  // One page switch per call, as use_figma allows.
  for (const [i, call] of coded.plan.calls.entries()) if (call.kind !== "read") assert.equal(runs[i].switches.length, 1, call.file);
});

/** Whether this checkout has package C's readback template, which figma code ships once it lands. */
const READBACK = existsSync(fileURLToPath(new URL("../../../templates/readback.js", import.meta.url)));

test("figma code: with the readback template shipped, every call of every fixture runs in the mock", { skip: READBACK ? false : "templates/readback.js (package C) is not in this checkout" }, async () => {
  for (const name of treeFixtureNames()) {
    const fixture = loadTreeFixture(name);
    const coded = await codeFor(fixture, { templates: {} });
    const runs = await runPlan(mockFor([fixture]), coded);
    assert.deepEqual(runs.map((r) => (r.value as { kind: string }).kind), coded.plan.calls.map((c) => c.kind), name);
  }
});

test("figma code: an icon that keeps a <g>, which Figma imports as a GROUP, is built and read back whole", { skip: READBACK ? false : "templates/readback.js (package C) is not in this checkout" }, async () => {
  // snap keeps a <g> with a transform (A15), and the spike saw Figma import one as a GROUP (item 1).
  const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2">'
    + '<g transform="translate(0 4)"><path d="M4 4h16"/><path d="M4 12h10"/></g><path d="M12 2v4"/></svg>';
  const snap = copy(loadTreeFixture("example-button"));
  const component = snap.components[0];
  const nodes: TreeNode[] = [
    { k: "", t: "F", el: "span", box: [0, 0, 16, 16] },
    { k: "svg", t: "V", el: "svg.lucide-list", box: [0, 0, 16, 16], svg: "svg:list", shapes: svgShapeBoxes(markup) },
  ];
  Object.assign(component, {
    id: "test-list", name: "List", title: "test/List", category: "test", variantProperties: [], warnings: [],
    base: { combination: {}, slug: "default", styles: { ...component.base!.styles, width: 16, height: 16, display: "block" } },
    variants: [{ combination: {}, slug: "default", status: "ok", error: null, delta: {} }],
    tree: { version: 1, base: nodes, assets: { svg: { "svg:list": markup }, img: {} } },
  });
  const coded = await codeFor(snap, { templates: {} });
  const mock = mockFor([snap]);
  for (const call of coded.plan.calls) {
    const run = await mock.run(coded.code(call));
    assert.ok(run.ok, `${call.file}: ${run.text}`);
    mkdirSync(join(coded.out, "results"), { recursive: true });
    writeFileSync(join(coded.out, call.result), run.text);
  }
  const icon = mock.nodes("FRAME").find((n) => n.data["storysync.k"] === "svg")!;
  assert.deepEqual(icon.children!.map((c) => [c.type, c.children?.length ?? 0]), [["GROUP", 2], ["VECTOR", 0]]);
  const { readback, notRead, problems } = loadPlanResults(join(coded.out, "plan.json"));
  assert.deepEqual([notRead, problems], [[], []]);
  const result = verify(JSON.parse(readFileSync(coded.snapPath, "utf8")), readback, 0.5, { notRead });
  // Every element verified, the icon's shapes and paints found through the group.
  assert.deepEqual(result.variants[0].nodes ?? [], []);
  assert.deepEqual([result.elementFidelity, result.summary.elements?.verified, result.summary.elements?.measured], [1, 2, 2]);
});

/** Builds and reads every call of a plan in `mock`, saving each response where the plan says, as an agent does. */
async function sendAll(coded: Awaited<ReturnType<typeof codeFor>>, mock: ReturnType<typeof mockFor>, kinds?: PlanCall["kind"][]): Promise<unknown[]> {
  const values: unknown[] = [];
  mkdirSync(join(coded.out, "results"), { recursive: true });
  for (const call of coded.plan.calls) {
    if (kinds && !kinds.includes(call.kind)) continue;
    const run = await mock.run(coded.code(call));
    assert.ok(run.ok, `${call.file}: ${run.text}`);
    writeFileSync(join(coded.out, call.result), run.text);
    values.push(run.value);
  }
  return values;
}

test("figma code: a text in fontsource's Geist Variable is set in Figma's Geist, no stand-in, and verify takes it for the family measured", { skip: READBACK ? false : "templates/readback.js (package C) is not in this checkout" }, async () => {
  // Probe 8e: Figma has Geist, and refuses Geist Variable.
  const probe = JSON.parse(readFileSync(fileURLToPath(new URL("../../../cli/__tests__/fixtures/figma-probe-8e-fonts.json", import.meta.url)), "utf8")) as { geist: Record<string, string[]> };
  const snap = copy(loadTreeFixture("example-button"));
  let renamed = 0;
  const rename = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(rename);
    else if (value && typeof value === "object") {
      const tx = (value as { tx?: { f?: string } }).tx;
      if (tx?.f === "Inter") {
        tx.f = "Geist Variable";
        renamed++;
      }
      Object.values(value).forEach(rename);
    }
  };
  rename(snap);
  assert.ok(renamed > 0);
  const coded = await codeFor(snap, { templates: {} });
  const mock = mockFor([snap], { fonts: { ...FONTS, ...probe.geist } });
  const values = await sendAll(coded, mock) as { kind: string; fonts?: Record<string, string> }[];
  for (const value of values.filter((v) => v.kind === "build")) assert.deepEqual(value.fonts, {}, "Geist is no stand-in");
  const { readback, notRead } = loadPlanResults(join(coded.out, "plan.json"));
  const result = verify(JSON.parse(readFileSync(coded.snapPath, "utf8")), readback, 0.5, { notRead });
  const family = result.variants.flatMap((v) => (v.nodes ?? []).flatMap((n) => n.differences.filter((d) => d.property === "family")));
  assert.deepEqual(family, []);
  assert.ok(result.summary.elements!.verified > 0);
});

/** A component snap measured no variant of, as the shadcn ResizablePanelGroup: every variant failed, so no base and no tree. */
function allFailed(snap: TreeFixture): TreeFixture {
  const error = "We detected that you use an implicit action arg while rendering of your story.";
  (snap.components as unknown[]).push({
    id: "ui-radix-resizablepanelgroup", name: "ResizablePanelGroup", title: "ui/radix/ResizablePanelGroup", category: "ui/radix", error: null,
    variantProperties: [{ name: "orientation", type: "VARIANT", values: ["horizontal", "vertical"], defaultValue: "horizontal" }],
    base: null, tree: null, warnings: [],
    variants: [
      { combination: { orientation: "horizontal" }, slug: "orientation-horizontal", status: "render_error", error },
      { combination: { orientation: "vertical" }, slug: "orientation-vertical", status: "element_not_found", error: "no element matched the story's root" },
    ],
  });
  const summary = (snap as { summary: { failed: number; variants: number } }).summary;
  summary.failed += 2;
  summary.variants += 2;
  return snap;
}

test("figma code: a component snap measured no variant of is built as placeholders, and verify counts and names them, each with why", { skip: READBACK ? false : "templates/readback.js (package C) is not in this checkout" }, async () => {
  const snap = allFailed(copy(loadTreeFixture("example-button")));
  const coded = await codeFor(snap, { templates: {} });
  assert.ok(coded.warnings.includes('ui/radix/ResizablePanelGroup: all 2 variants built as a "Not measured" placeholder, since snap couldn\'t measure them'), coded.warnings.join("\n"));
  assert.ok(!coded.warnings.some((w) => w.includes("not built")));
  await sendAll(coded, mockFor([snap]));
  const { readback, notRead } = loadPlanResults(join(coded.out, "plan.json"));
  const result = verify(JSON.parse(readFileSync(coded.snapPath, "utf8")), readback, 0.5, { notRead });
  assert.equal(result.summary.notMeasured, 2);
  assert.deepEqual(result.unmeasuredInFigma, [], "the placeholders are not variants snap never measured");
  assert.match(result.snapWarnings![0], /^2 variant\(s\) could not be measured, of ui\/radix\/ResizablePanelGroup \(all 2\); /);
  const lines = formatElementReport(result).join("\n");
  assert.match(lines, /not measured 2/);
  assert.match(lines, /\? ui\/radix\/ResizablePanelGroup orientation=horizontal: not measured \(render_error: We detected that you use an implicit action arg while rendering of your story\.\), so Figma holds a placeholder for it\n/);
  assert.match(lines, /orientation=vertical: not measured \(element_not_found: no element matched the story's root\), so Figma holds a placeholder for it/);
  assert.doesNotMatch(lines, /story change/, "snap named no story change for these");
  // An arg_rejected variant whose warning names a story change says so.
  const changed = JSON.parse(readFileSync(coded.snapPath, "utf8")) as TreeFixture;
  const group = changed.components.find((c) => c.name === "ResizablePanelGroup")! as unknown as { variants: { status: string; error: string }[]; warnings: string[] };
  Object.assign(group.variants[1], { status: "arg_rejected", error: "Storybook kept orientation at horizontal" });
  group.warnings = ["Storybook wouldn't render 1 of ResizablePanelGroup's variants with the values asked for, and snap couldn't set them through its preview either, so it was not measured (status arg_rejected): vertical isn't among orientation's options. To measure it, add vertical to orientation's options, then measure the component again with --components ui-radix-resizablepanelgroup --merge."];
  const again = formatElementReport(verify(changed, readback, 0.5, { notRead })).join("\n");
  assert.match(again, /orientation=vertical: not measured \(arg_rejected: Storybook kept orientation at horizontal\), so Figma holds a placeholder for it; snap's warning names the story change it needs/);
  assert.match(again, /orientation=horizontal: not measured \(render_error: [^\n]*placeholder for it\n/);
});

test("verify --plan: reads saved before a build of their components was sent again are said to score Figma before it", { skip: READBACK ? false : "templates/readback.js (package C) is not in this checkout" }, async () => {
  const snap = copy(loadTreeFixture("example-button"));
  const coded = await codeFor(snap, { templates: {} });
  await sendAll(coded, mockFor([snap]));
  const at = (call: PlanCall) => join(coded.out, call.result);
  const build = coded.plan.calls.find((c) => c.kind === "build")!;
  const read = coded.plan.calls.find((c) => c.kind === "read")!;
  // Saved in order, within a second, as a copy of the folder leaves them: no problem.
  const now = Date.now() / 1000;
  utimesSync(at(build), now, now + 1);
  utimesSync(at(read), now, now);
  assert.deepEqual(loadPlanResults(join(coded.out, "plan.json")).problems, []);
  // The build sent again a minute after the read was saved.
  utimesSync(at(build), now, now + 60);
  const { problems } = loadPlanResults(join(coded.out, "plan.json"));
  assert.deepEqual(problems, [
    `call ${read.seq}: ${read.result} read Forms/Button before build call ${build.seq} was sent again (its result was saved after it), so what it scores is Figma before that build, not now: send read call ${read.seq} again and save its response`,
  ]);
  // Read again after it: nothing to say.
  utimesSync(at(read), now, now + 120);
  assert.deepEqual(loadPlanResults(join(coded.out, "plan.json")).problems, []);
});

test("loadTemplate: the minified build template is what the call carries, and a missing one says so", () => {
  const min = loadTemplate("build");
  assert.ok(min.length < loadTemplate("build", false).length);
  if (!READBACK) assert.throws(() => loadTemplate("readback", false), /templates\/readback\.js is missing/);
  assert.equal(loadTemplate("readback", true, { readback: " x " }), "x");
});

test("parseCallResult: a returned object, as JSON, as a JSON string, in an MCP envelope or in prose", () => {
  const value = { kind: "read", more: { slices: [["a", 3, 9, 0]] } };
  const json = JSON.stringify(value);
  for (const text of [json, JSON.stringify(json), JSON.stringify({ content: [{ type: "text", text: json }] }), `Result: ${json} (done)`, JSON.stringify([{ type: "text", text: json }])]) {
    assert.deepEqual(parseCallResult(text), value, text);
  }
  assert.equal(parseCallResult("Error: Script exceeded time limit"), null);
  assert.equal(parseCallResult('{"id": "1:2"}'), null);
});

test("figma next: a read result with `more` gets its continuation, b then c; without it, none", async () => {
  const coded = await codeFor(loadTreeFixture("card"));
  const read = coded.plan.calls.find((c) => c.kind === "read")!;
  const nn = String(read.seq).padStart(2, "0");
  const planPath = join(coded.out, "plan.json");
  const opts = { plan: planPath, seq: read.seq, templates: { readback: STUB_READBACK } };
  await assert.rejects(runFigmaNext(opts), new RegExp(`results/${nn}\\.json is missing`));
  writeFileSync(join(coded.out, read.result), JSON.stringify({ kind: "read", sets: [] }));
  assert.equal(await runFigmaNext(opts), null);
  writeFileSync(join(coded.out, read.result), JSON.stringify(JSON.stringify({ kind: "read", more: { slices: [["ui-base-card", 1, 1, 12]] } })));
  const next = await runFigmaNext(opts);
  assert.deepEqual(next, {
    file: join(coded.out, `calls/${nn}b-read-ui-base.js`), result: join(coded.out, `results/${nn}b.json`),
    description: `Continue reading back ui-base-card on page "ui/base" (call ${nn}b)`,
  });
  const code = readFileSync(next!.file, "utf8");
  assert.ok(code.startsWith(`// storysync figma code, call ${nn}b: read back on page "ui/base"`));
  assert.match(code, /\nconst SLICES = \[\["ui-base-card",1,1,12\]\];\nconst LIMIT = 18000;\n/);
  assert.deepEqual(await runFigmaNext(opts), next, "until its result is saved, the same file");
  writeFileSync(join(coded.out, `results/${nn}b.json`), JSON.stringify({ kind: "read", more: { slices: [["ui-base-card", 1, 1, 20]] } }));
  assert.equal((await runFigmaNext(opts))!.file, join(coded.out, `calls/${nn}c-read-ui-base.js`));
  writeFileSync(join(coded.out, `results/${nn}c.json`), JSON.stringify({ kind: "read", more: {} }));
  await assert.rejects(runFigmaNext(opts), new RegExp(`^Error: results/${nn}c\\.json has a "more" without the slices to continue from$`));
  writeFileSync(join(coded.out, `results/${nn}c.json`), JSON.stringify({ kind: "read", sets: [] }));
  assert.equal(await runFigmaNext(opts), null);
  await assert.rejects(runFigmaNext({ ...opts, seq: 1 }), /call 01 is a build call: only a read call continues/);
});

test("figma next: a continuation read before the result it continues, as a read call sent again leaves it, is asked for again", async () => {
  const coded = await codeFor(loadTreeFixture("card"));
  const read = coded.plan.calls.find((c) => c.kind === "read")!;
  const nn = String(read.seq).padStart(2, "0");
  const opts = { plan: join(coded.out, "plan.json"), seq: read.seq, templates: { readback: STUB_READBACK } };
  // A result whose one entry Figma read at `at`.
  const readAt = (at: string, more?: unknown[]) => JSON.stringify({
    kind: "read", sets: [{ id: "1:1", component: "ui-base-card", entries: { [`e${at}`]: { readAt: at } } }], ...(more ? { more: { slices: more } } : {}),
  });
  const slices = [["ui-base-card", 1, 1, 12]];
  writeFileSync(join(coded.out, read.result), readAt("2026-10-09T10:00:00.000Z", slices));
  writeFileSync(join(coded.out, `results/${nn}b.json`), readAt("2026-10-09T10:00:01.000Z"));
  assert.equal(await runFigmaNext(opts), null, "a continuation read after its call's result is taken");
  // The read call sent again, later: the continuation saved before is from the reading before.
  writeFileSync(join(coded.out, read.result), readAt("2026-10-09T11:00:00.000Z", slices));
  const again = await runFigmaNext(opts);
  assert.deepEqual(again, {
    file: join(coded.out, `calls/${nn}b-read-ui-base.js`), result: join(coded.out, `results/${nn}b.json`),
    description: `Continue reading back ui-base-card on page "ui/base" (call ${nn}b)`, again: true,
  });
  assert.deepEqual(await runFigmaNext(opts), again, "until its result is saved again, the same file");
  writeFileSync(join(coded.out, `results/${nn}b.json`), readAt("2026-10-09T11:00:01.000Z", [["ui-base-card", 1, 1, 20]]));
  // And the one after it, saved before too, is asked for again in turn.
  writeFileSync(join(coded.out, `results/${nn}c.json`), readAt("2026-10-09T10:00:02.000Z"));
  assert.equal((await runFigmaNext(opts))!.again, true);
  writeFileSync(join(coded.out, `results/${nn}c.json`), readAt("2026-10-09T11:00:02.000Z"));
  assert.equal(await runFigmaNext(opts), null);
});

test("figma code: the spike's absolute-inset answer moves an absolute child by its parent's included stroke", async () => {
  const xOf = async (absoluteInsetByStroke: boolean) => {
    const coded = await codeFor(loadTreeFixture("attachment"), { spike: { absoluteInsetByStroke } });
    const data = dataOf(coded.code(coded.plan.calls[0])) as { S: unknown[]; sets: { base: unknown[][]; v: unknown[][] }[] };
    const vertical = data.sets[0].v.find((v) => v[1] === "size-default--orientation-vertical--state-done")!;
    return recordsOf(data.sets[0].base, vertical[5]).find((r) => data.S[r[0] as number] === "attachment-action")!.slice(3, 5);
  };
  assert.deepEqual(await xOf(false), [83, 13]);
  assert.deepEqual(await xOf(true), [82, 12]);
});

test("figma code: images go in one call per page whose sets show one; a page with none has no images call", async () => {
  const coded = await codeFor(loadTreeFixture("switch"));
  assert.deepEqual(coded.plan.calls.map((c) => c.kind), ["build", "label", "read"]);
  const avatar = await codeFor(loadTreeFixture("avatar"));
  const images = avatar.plan.calls.find((c) => c.kind === "images")!;
  assert.match(avatar.code(images), /\nconst PAGE = "ui\/base";\n/);
});

test("figma code: a snap's tree without an asset it names is refused, rather than built wrong", async () => {
  const snap = copy(loadTreeFixture("toggle"));
  snap.components[0].tree.assets.svg = {};
  await assert.rejects(codeFor(snap), /is a vector whose svg asset svg:3a1614af is not in the tree's assets/);
});

test("figma code: a measured variant without its tree delta is refused, rather than built as the base", async () => {
  const snap = copy(loadTreeFixture("switch"));
  delete (snap.components[0].variants[1] as { treeDelta?: unknown }).treeDelta;
  await assert.rejects(codeFor(snap), /ui\/base\/Switch size-sm was measured, but has no treeDelta/);
});

test("figma code: a call's constants are written in ASCII, the same values, which still match their SUM", () => {
  // A no-break space an agent retyping the call turns into a space, a
  // zero-width space, a soft hyphen, an emoji, U+2028 and a lone surrogate.
  const value = { name: "Save draft​­", icon: "\u{1f600}", line: "a b", lone: "\ud800", big: 1e21, keys: { "é": 1 } };
  const text = callConstants([["DATA", value], ["PAGE", "ui/café"]]);
  assert.match(text, /^[\n\x20-\x7e]*$/, "ASCII only");
  const [data, page, sum] = new Function(`${text}return [DATA, PAGE, SUM];`)() as [unknown, unknown, string];
  assert.deepEqual([data, page], [value, "ui/café"]);
  assert.equal(sum, callSum([data, page]));
});

// A push isn't lightweight: figma code says what this one costs in tokens,
// and the skills show it and ask before sending a call.
test("estimatePush: counts every call and its characters, and puts push 4's size at the low end", () => {
  const call = (seq: number, kind: PlanCall["kind"], components: string[], chars: number, predicted?: number): PlanCall => ({
    seq, kind, page: "ui/base", components, file: `calls/${seq}.js`, result: `results/${seq}.json`, description: "", chars,
    ...(predicted !== undefined ? { predicted } : {}),
  });
  // Push 4's shape: 5 components, 3 builds, a label and 18 reads, about
  // 475,000 characters sent and returned, which took about 570k tokens.
  const calls: PlanCall[] = [
    call(1, "build", ["a", "b"], 44_000), call(2, "build", ["b", "c", "d"], 44_000), call(3, "build", ["d", "e"], 30_000), call(4, "label", ["a", "b", "c", "d", "e"], 2_000),
  ];
  for (let i = 0; i < 18; i++) calls.push(call(5 + i, "read", ["a"], 8_600, 10_000));
  const plan: FigmaPlan = { version: 1, storysyncVersion: "0.4.0", snap: { path: "", measuredAt: "", digest: "00000000" }, calls };
  const e = estimatePush(plan);
  assert.equal(e.components, 5);
  assert.equal(e.calls, 22);
  assert.deepEqual(e.byKind, { build: 3, label: 1, read: 18 });
  assert.equal(e.charsSent, 44_000 + 44_000 + 30_000 + 2_000 + 18 * 8_600);
  assert.equal(e.charsReturned, 180_000);
  const moved = e.charsSent + e.charsReturned;
  assert.equal(e.tokens.low, Math.round((ESTIMATE.perPush + 5 * ESTIMATE.perComponent[0] + moved * ESTIMATE.perChar[0]) / 1000) * 1000);
  assert.ok(e.tokens.low <= 570_000 && 570_000 <= e.tokens.high, `push 4 took about 570k, outside ${e.tokens.low}-${e.tokens.high}`);
  assert.equal(e.ruleOfThumb, 600_000);
  assert.ok(e.tokens.low <= e.ruleOfThumb && e.ruleOfThumb <= e.tokens.high);
  const line = describeEstimate(e);
  assert.match(line, /^Estimate: 22 use_figma calls send 274,800 characters of code and read back about 180,000\. /);
  assert.match(line, new RegExp(`Plan on about ${formatTokens(e.tokens.low)}-${formatTokens(e.tokens.high)} agent tokens for this push of 5 components`));
  assert.match(line, /gives 600k\)\.$/);
});

test("formatTokens: thousands as k, millions as M with one decimal", () => {
  assert.equal(formatTokens(530_000), "530k");
  assert.equal(formatTokens(94_000), "90k");
  assert.equal(formatTokens(994_000), "990k");
  assert.equal(formatTokens(995_000), "1.0M");
  assert.equal(formatTokens(1_260_000), "1.3M");
  assert.equal(formatTokens(6_100_000), "6.1M");
});

test("figma code: prints the push's estimate, in text and in --json, from the calls it wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-estimate-"));
  try {
    const snapPath = join(dir, "snaps", "styles.json");
    mkdirSync(join(dir, "snaps"), { recursive: true });
    writeFileSync(snapPath, JSON.stringify(loadTreeFixture("switch"), null, 2));
    const cli = join(fileURLToPath(new URL(".", import.meta.url)), "..", "index.js");
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, "figma", "code", "--snap", snapPath, "--tokens", join(dir, "none.json"), "--out", join(dir, "figma"), ...args], { encoding: "utf8" });
    const out = JSON.parse(run("--json")) as { calls: PlanCall[]; estimate: ReturnType<typeof estimatePush> };
    const plan = JSON.parse(readFileSync(join(dir, "figma", "plan.json"), "utf8")) as FigmaPlan;
    assert.deepEqual(out.estimate, estimatePush(plan));
    assert.equal(out.estimate.calls, out.calls.length);
    assert.equal(out.estimate.charsSent, out.calls.reduce((t, c) => t + c.chars, 0));
    assert.equal(out.estimate.charsReturned, out.calls.reduce((t, c) => t + (c.predicted ?? 0), 0));
    assert.equal(out.estimate.components, 1);
    assert.ok(out.estimate.tokens.low > ESTIMATE.perPush && out.estimate.tokens.low < out.estimate.tokens.high);
    const text = run();
    assert.ok(text.includes(describeEstimate(out.estimate)), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figma code: a variant the run failed is never built, and one Figma has measured gets a placeholder only with --replace-measured", { skip: READBACK ? false : "templates/readback.js (package C) is not in this checkout" }, async () => {
  const snap = copy(loadTreeFixture("example-button"));
  const coded = await codeFor(snap, { templates: {} });
  const mock = mockFor([snap]);
  await sendAll(coded, mock);
  // verify --plan assembles the readback beside the plan's directory.
  loadPlanResults(join(coded.out, "plan.json"));
  const slugs = snap.components[0].variants.map((v) => v.slug);
  const srcOf = (slug: string) => mock.nodes("COMPONENT").filter((n) => n.data["storysync.slug"] === slug).map((n) => n.data["storysync.src"]);
  assert.deepEqual(srcOf(slugs[1]), ["measured"]);

  // The next snap: one variant fails in its story; the others because the
  // run did, a timeout, Storybook down, a story that never rendered.
  const failed = copy(snap);
  const fail = (i: number, change: object) => {
    const v = failed.components[0].variants[i] as unknown as Record<string, unknown>;
    for (const field of ["delta", "treeDelta", "boundingBox", "element"]) delete v[field];
    Object.assign(v, change);
  };
  fail(1, { status: "render_error", error: "TypeError: Cannot read properties of undefined (reading 'map')" });
  fail(2, { status: "timeout", error: "page.goto: Timeout 15000ms exceeded." });
  fail(3, { status: "render_error", error: "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:6006/iframe.html" });
  fail(4, { status: "element_not_found", error: "nothing that draws rendered under #storybook-root", rendered: false });
  writeFileSync(coded.snapPath, JSON.stringify(failed));
  const again = await runFigmaCode({ snap: coded.snapPath, out: coded.out, templates: {} });
  const run = again.warnings.find((w) => /snap timed out or couldn't reach Storybook for 3 variants/.test(w)) ?? "";
  assert.match(run, new RegExp(`\\(${slugs[2]}, ${slugs[3]}, ${slugs[4]}\\), which are not built, so Figma keeps what it has for them`));
  const kept = again.warnings.find((w) => w.includes(slugs[1])) ?? "";
  assert.match(kept, /1 variant failed in the story .*which Figma has measured from an earlier push, so it is left as it is, not replaced by "Not measured" placeholders: ask the user/);
  assert.ok(!again.warnings.some((w) => /"Not measured" placeholder, since/.test(w)), again.warnings.join("\n"));
  const code = (call: PlanCall) => readFileSync(join(coded.out, call.file), "utf8");
  for (const slug of slugs.slice(1, 5)) assert.ok(!again.plan.calls.some((c) => c.kind === "build" && code(c).includes(`"${slug}"`)), `${slug} is not in a build call`);
  await sendAll({ ...coded, plan: again.plan }, mock);
  for (const slug of slugs.slice(1, 5)) assert.deepEqual(srcOf(slug), ["measured"], `${slug} is as it was`);

  // Once the user says so, the story's failure replaces it; the run's never do.
  const replaced = await runFigmaCode({ snap: coded.snapPath, out: coded.out, templates: {}, replaceMeasured: true });
  assert.ok(replaced.warnings.includes('Forms/Button: 1 variant built as a "Not measured" placeholder, since snap couldn\'t measure it'), replaced.warnings.join("\n"));
  await sendAll({ ...coded, plan: replaced.plan }, mock);
  assert.deepEqual(srcOf(slugs[1]), ["unmeasured"]);
  for (const slug of slugs.slice(2, 5)) assert.deepEqual(srcOf(slug), ["measured"]);

  // Every variant failed by the run: not built at all, and said why.
  const down = copy(failed);
  for (const v of down.components[0].variants as unknown as Record<string, unknown>[]) Object.assign(v, { status: "timeout", error: "Timeout" });
  (down.components[0] as unknown as { base: unknown }).base = null;
  writeFileSync(coded.snapPath, JSON.stringify(down));
  await assert.rejects(runFigmaCode({ snap: coded.snapPath, out: coded.out, templates: {} }), /^Error: No component to build: Forms\/Button: not built: snap timed out or couldn't reach Storybook for 12 variants .*Figma keeps what it has for them/);
});

test("figma code: --snap takes the directory snap wrote, and says to run snap where there is none", async () => {
  const snap = copy(loadTreeFixture("example-button"));
  const coded = await codeFor(snap, { templates: {} });
  const fromDir = await runFigmaCode({ snap: dirname(coded.snapPath), out: join(coded.dir, "dir-out"), templates: { readback: STUB_READBACK } });
  assert.equal(fromDir.plan.snap.digest, coded.plan.snap.digest);
  const empty = mkdtempSync(join(tmpdir(), "storysync-no-snap-"));
  await assert.rejects(
    runFigmaCode({ snap: join(empty, ".storysync", "snaps", "styles.json"), out: join(empty, "out") }),
    (err: Error) => /^No snap at .*styles\.json: run `storysync snap` first, or pass --snap/.test(err.message) && !/ENOENT/.test(err.message),
  );
  await assert.rejects(runFigmaCode({ snap: empty, out: join(empty, "out") }), /No snap at .*styles\.json/);
});

test("verify --plan: an alpha variable made for a component no build call builds says so, naming no call", () => {
  // Every variant of a component too big for one call: it has no build call.
  const dir = mkdtempSync(join(tmpdir(), "storysync-unused-alpha-"));
  const plan: FigmaPlan = {
    version: 1, storysyncVersion: "0.4.0", snap: { path: "styles.json", measuredAt: "", digest: "" },
    calls: [{ seq: 1, kind: "variables", page: "", components: [], file: "calls/01-variables.js", result: "results/01.json", chars: 0, description: "" } as PlanCall],
    alphas: [{ variable: "foreground 10%", token: "foreground", alpha: 0.1, components: ["ui/base/Table"], collection: "Colors" }],
  };
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  const { unusedAlphas } = loadPlanResults(join(dir, "plan.json"));
  assert.deepEqual(unusedAlphas, ["foreground 10% (Colors): made for ui/base/Table, which no build call builds, so nothing binds it"]);
});

test("describeBinding: says whether classes named the tokens that tie, or none did, and why any of them is right", () => {
  const alike = ["border/DEFAULT", "input", "surface/tertiary"];
  const b = { component: "button", property: "stroke", value: "#e4e4e7", variable: "input", from: "", alike, keys: ["", "icon"] };
  assert.equal(describeBinding({ ...b, named: ["input", "surface/tertiary"] }), "button: stroke #e4e4e7 bound to input, which its classes name with surface/tertiary, as border/DEFAULT, input, and surface/tertiary hold it in every mode, so any of them is right in each (its root, icon)");
  assert.equal(describeBinding({ ...b, variable: "border/DEFAULT" }), "button: stroke #e4e4e7 bound to border/DEFAULT, which no class names, as border/DEFAULT, input, and surface/tertiary hold it in every mode, so any of them is right in each (its root, icon)");
  assert.equal(describeBinding({ component: "dialog", property: "color", value: "#0a0a0a", variable: "foreground", from: "body { color: var(--foreground) }", keys: ["t"] }), "dialog: color #0a0a0a bound to foreground, which no class names, by the base style body { color: var(--foreground) } (t)");
});
