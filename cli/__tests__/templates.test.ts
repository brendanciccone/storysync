// The Figma templates figma code sends: their size, and the use_figma rules
// every call must keep.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CALL_CONSTANTS, loadTemplate } from "../figma-code.js";
import { MAX_CALL_CHARS, USE_FIGMA_CODE_LIMIT } from "../figma-spike.js";
import type { TemplateName } from "../figma-code.js";

/**
 * Most characters each minified template may take (section 8.2 sets the
 * build's, section 9.1 the readback's): every call carries one, under
 * use_figma's 50,000.
 *
 * The build's and the readback's have each been raised once, by 1,000, to
 * make room for a checksum each call checks of its own data and for the
 * readback's check of what Figma cuts short, against these limits, which
 * the test below holds them to:
 *
 * - A build call is its template and DATA, packed to MAX_CALL_CHARS
 *   (45,000) in all, so the template takes from what a call can carry. At
 *   18,000 a packed call keeps 27,000 for DATA. Each of the fourth live
 *   push's 100 variants, in a call of its own, took 1,364 characters
 *   beside the template at the median and 7,454 at most, so the 1,000
 *   costs a packed call less than one variant.
 * - A variant too big to share a call goes in one of its own, up to
 *   use_figma's 50,000 (USE_FIGMA_CODE_LIMIT): 32,000 of DATA, over four
 *   times that push's largest.
 * - A read call is its template and a header of a few hundred characters,
 *   nowhere near 45,000, and what it returns is held by its LIMIT, not by
 *   its code.
 */
const BUDGETS = { build: 18_000, images: 2_000, label: 3_000, readback: 9_000 } as const;

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => unknown;

test("templates: each minified template is within its budget", () => {
  for (const [name, budget] of Object.entries(BUDGETS)) {
    const code = loadTemplate(name as keyof typeof BUDGETS);
    assert.ok(code.length <= budget, `${name}.min.js is ${code.length} characters, more than ${budget}`);
    assert.ok(code.length < loadTemplate(name as keyof typeof BUDGETS, false).length, `${name} is minified`);
  }
});

test("templates: the build's budget leaves a call room for its data, packed and alone", () => {
  // The room the comment on BUDGETS argues from: a budget raised past it
  // needs the argument made again. 7,454 is what the fourth live push's
  // largest variant took beside the template, in a call of its own.
  assert.ok(MAX_CALL_CHARS - BUDGETS.build >= 27_000, "a packed call keeps 27,000 for DATA");
  assert.ok(USE_FIGMA_CODE_LIMIT - BUDGETS.build >= 4 * 7_454, "a variant alone has four times the room the largest took");
  assert.ok(BUDGETS.readback + 1_000 < MAX_CALL_CHARS, "a read call is its template and a short header");
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
