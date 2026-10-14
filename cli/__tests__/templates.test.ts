// The Figma templates figma code sends: their size, and the use_figma rules
// every call must keep.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callCode, callConstants, templateLiteral } from "../checksum.js";
import type { TemplateCarry } from "../checksum.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_CONSTANTS, loadTemplate, runFigmaNext } from "../figma-code.js";
import { runFigmaTokens } from "../figma-tokens.js";
import { MAX_CALL_CHARS, USE_FIGMA_CODE_LIMIT } from "../figma-spike.js";
import type { TemplateName } from "../figma-code.js";
import { SHADCN_TOKENS, codeFor } from "./figma-build-harness.js";
import { loadTreeFixture, treeFixtureNames } from "./mock-figma.js";

/**
 * Most characters each minified template may take (section 8.2 sets the
 * build's, section 9.1 the readback's): every call carries one, under
 * use_figma's 50,000.
 *
 * The build's and the readback's have each been raised once, by 1,000, to
 * make room for the call's checksums and for the readback's check of what
 * Figma cuts short, against these limits, which the test below holds them
 * to. A call carries a template as a string (checksum.ts, templateLiteral),
 * a few characters of escapes more than the minified file, which the
 * budget counts. Each call also carries the guard that checks its SUM and
 * TSUM and runs it (checksum.ts, callCode), about 700 characters, outside
 * the template:
 *
 * - A build call is its guard and DATA, packed to MAX_CALL_CHARS
 *   (45,000) in all: the first build call of a plan carries the template
 *   too, and stores it in the Figma file, from which the others run it
 *   (checksum.ts, TemplateCarry; probe 9a), so only that one call gives
 *   the template room. Through 0.4.0's eighth fix pass every build call
 *   carried it, at 19,500, which left 24,500 for DATA; a call after the
 *   first now keeps over 43,000. The ninth raised it by 5,000, to 24,500,
 *   for what the live re-check found the build must do itself: a variant
 *   continued across calls, a set refused alone, a plain component made a
 *   set, variants renamed onto new properties, a set that grew moving
 *   what it grew onto, and a wider font given room. The first call keeps
 *   19,700 for DATA, over 2.5 times the fourth live push's largest
 *   variant, 7,454 beside the template, and the template 2,500 below it.
 * - A variant too big for a call's room is sent in parts, each in a call
 *   of its own (figma-code.ts), so no variant needs more room than that.
 * - A read call is its template, the guard and a header of a few hundred
 *   characters, nowhere near 45,000, and what it returns is held by its
 *   LIMIT, not by its code.
 * - A variables call is its template, the guard and 40 variables at most,
 *   with the alpha variables of their colors (figma-bind.ts), under 10,000.
 *   Its budget was raised by 500 for those alpha variables, and by 1,000
 *   more for per-mode ones made from two colors, a palette's among them,
 *   and the removal of one nothing binds: far under 10,000 still.
 */
const BUDGETS = { build: 24_500, images: 2_000, label: 3_000, readback: 9_000, variables: 4_500 } as const;

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => unknown;

test("templates: each minified template, as the string a call carries it in, is within its budget", () => {
  for (const [name, budget] of Object.entries(BUDGETS)) {
    const code = loadTemplate(name as keyof typeof BUDGETS);
    const carried = templateLiteral(code).length;
    assert.ok(carried <= budget, `${name}.min.js takes ${carried} characters in a call, more than ${budget}`);
    assert.ok(code.length < loadTemplate(name as keyof typeof BUDGETS, false).length, `${name} is minified`);
  }
});

test("templates: the build's budget leaves a call room for its data, packed and alone", () => {
  // The room the comment on BUDGETS argues from: a budget raised past it
  // needs the argument made again. 7,454 is what the fourth live push's
  // largest variant took beside the template, in a call of its own.
  const guard = (carry?: TemplateCarry) => callCode([["DATA", 0]], "", "figma code", carry).length - callConstants([["DATA", 0]]).length;
  const storing = guard({ kind: "build", store: true });
  const loading = guard({ kind: "build", from: "01" });
  assert.ok(storing < 900 && loading < 1_000, `the guard is ${storing} characters storing, ${loading} loading`);
  assert.ok(MAX_CALL_CHARS - BUDGETS.build - storing >= 19_500, "the first call keeps 19,500 for DATA");
  assert.ok(MAX_CALL_CHARS - BUDGETS.build - storing >= 2.5 * 7_454, "over 2.5 times the room the largest took");
  assert.ok(MAX_CALL_CHARS - loading >= 43_000, "a call after it keeps 43,000 for DATA");
  assert.ok(BUDGETS.build - templateLiteral(loadTemplate("build")).length >= 2_500, "the build template keeps 2,500 below its budget");
  assert.ok(BUDGETS.readback + storing + 1_000 < MAX_CALL_CHARS, "a read call is its template, the guard and a short header");
});

test("templates: a readable build call, after figma code --no-minify, keeps a packed call's room for a variant: its comment lines blank, each line the file's", async () => {
  // The build's comments, a third of it, took a card's call to 49,915
  // characters, and then past use_figma's 50,000, which left it unbuilt.
  const source = readFileSync(fileURLToPath(new URL("../../../templates/build.js", import.meta.url)), "utf8").trim().split("\n");
  const readable = loadTemplate("build", false).split("\n");
  assert.equal(readable.length, source.length);
  assert.equal(readable[0], source[0]);
  readable.forEach((line, i) => assert.equal(line, i > 0 && /^\s*\/\//.test(source[i]) ? "" : source[i], `line ${i + 1}`));
  const guard = callCode([["DATA", 0]], "").length - callConstants([["DATA", 0]]).length;
  assert.ok(templateLiteral(readable.join("\n")).length + guard + 7_454 <= MAX_CALL_CHARS, "a readable call has the room the largest variant took, under --max-chars");
  for (const name of treeFixtureNames()) {
    const coded = await codeFor(loadTreeFixture(name), { minify: false });
    assert.deepEqual(coded.warnings.filter((w) => /use_figma call takes|over --max-chars/.test(w)), [], name);
  }
});

test("templates: a call carries its template as a string whose value is the template exactly, which TSUM covers and the call runs", async () => {
  const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => () => Promise<unknown>;
  for (const text of ["a`b${c}\\d", "/^#\\w{6}00$/.test(x)", "`${`", "\\`", "a\r\nb\rc", "\\r", ...Object.keys(BUDGETS).map((name) => loadTemplate(name as keyof typeof BUDGETS)), loadTemplate("readback", false)]) {
    assert.equal(new Function(`return ${templateLiteral(text)};`)(), text);
  }
  // The guard checks T, the string, and runs that string: a template's
  // text changed in its literal is refused, wherever the runtime would
  // give back a function's text otherwise.
  const call = callCode([["DATA", 1]], "return DATA + TC;");
  assert.match(call, /\nconst T = `return DATA \+ TC;`;\n/);
  assert.equal(await new AsyncFunction("figma", call)(), 2);
  await assert.rejects(new AsyncFunction("figma", call.replace("return DATA + TC;`", "return DATA + 2;`"))(), /its template fails its checksum, TSUM/);

  // A readable template with Windows line ends passes its TSUM and runs:
  // its literal keeps each CR, which a literal makes a line feed of.
  const crlf = callCode([["DATA", 1]], "const a = 1;\r\nreturn DATA + a + TC;\r\n");
  assert.equal(await new AsyncFunction("figma", crlf)(), 3);
});

test("templates: each minified template is ASCII, so no character of the text TSUM covers can be retyped as another", () => {
  for (const name of Object.keys(BUDGETS)) assert.match(loadTemplate(name as keyof typeof BUDGETS), /^[\n\x20-\x7e]*$/, name);
});

/** Every template this checkout has, which must be every one figma code writes a call for. */
const PRESENT = (Object.keys(CALL_CONSTANTS) as TemplateName[]).filter((name) => existsSync(fileURLToPath(new URL(`../../../templates/${name}.js`, import.meta.url))));

test("templates: each is a function body use_figma can run, reading only the constants its call puts before it", () => {
  assert.deepEqual(PRESENT, Object.keys(BUDGETS));
  for (const name of PRESENT) {
    for (const minify of [true, false]) {
      const code = loadTemplate(name, minify);
      // Compiles as use_figma runs it: an async function of `figma`, after exactly the constants its call writes.
      const prefix = CALL_CONSTANTS[name].map((c) => `const ${c} = undefined;\n`).join("");
      assert.doesNotThrow(() => new AsyncFunction("figma", `${prefix}${code}`), name);
      const statements = code.replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(statements, new RegExp(`\\b(?:const|let|var)\\s+(?:${CALL_CONSTANTS[name].join("|")})\\b`), `${name} declares no constant its call gives`);
    }
  }
});

test("templates: none uses what use_figma doesn't support, and each switches page at most once", () => {
  for (const name of Object.keys(BUDGETS)) {
    const code = loadTemplate(name as keyof typeof BUDGETS, false);
    for (const banned of [/createImage(?:Async)?\(/, /\.setPluginData\(/, /\.getPluginData\(/, /loadAllPagesAsync/, /figma\.notify/, /figma\.currentPage\s*=(?!=)/, /getNodeById\(/, /closePlugin/]) {
      assert.doesNotMatch(code, banned, `${name} uses ${banned}`);
    }
    assert.ok((code.match(/setCurrentPageAsync\(/g) ?? []).length <= 1, `${name} switches page once at most`);
  }
});

test("templates: figma code, figma next and figma tokens refuse to write a call longer than use_figma takes", async () => {
  // A template that alone passes the limit stands in for any call packed
  // wrong: Figma would refuse it whole, so no writer may leave it in a plan.
  const huge = `return { kind: 'read', tpl: 3, page: PAGE, sets: [], slices: SLICES, limit: LIMIT, more: { slices: SLICES } };//${"x".repeat(USE_FIGMA_CODE_LIMIT)}`;
  const switchSnap = loadTreeFixture("switch");
  for (const [name, fixture] of [["readback", "switch"], ["label", "switch"], ["images", "avatar"]] as const) {
    await assert.rejects(codeFor(loadTreeFixture(fixture), { templates: { [name]: huge } }), /is \d+ characters, more than use_figma takes \(50000\)/, name);
  }
  // A plan whose calls carry their templates: a continuation carries it too.
  const coded = await codeFor(switchSnap, { inlineTemplates: true });
  const read = coded.plan.calls.find((c) => c.kind === "read")!;
  writeFileSync(join(coded.out, read.result), JSON.stringify({ kind: "read", tpl: 3, page: read.page, sets: [], more: { slices: [["ui-base-switch", 0, 0, 0]] } }));
  await assert.rejects(runFigmaNext({ plan: join(coded.out, "plan.json"), seq: read.seq, templates: { readback: huge } }), /more than use_figma takes/);
  const dir = mkdtempSync(join(tmpdir(), "storysync-limit-"));
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(SHADCN_TOKENS));
  assert.throws(() => runFigmaTokens({ tokens: join(dir, "tokens.json"), out: join(dir, "out"), templates: { variables: huge } }), /more than use_figma takes/);
});
