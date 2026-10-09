// The Figma templates figma code sends: their size, and the use_figma rules
// every call must keep.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CALL_CONSTANTS, loadTemplate } from "../figma-code.js";
import type { TemplateName } from "../figma-code.js";

/**
 * Most characters each minified template may take (section 8.2 sets the
 * build's, section 9.1 the readback's): every call carries one, under
 * use_figma's 50,000.
 */
const BUDGETS = { build: 16_000, images: 2_000, label: 3_000, readback: 8_000 } as const;

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => unknown;

test("templates: each minified template is within its budget", () => {
  for (const [name, budget] of Object.entries(BUDGETS)) {
    const code = loadTemplate(name as keyof typeof BUDGETS);
    assert.ok(code.length <= budget, `${name}.min.js is ${code.length} characters, more than ${budget}`);
    assert.ok(code.length < loadTemplate(name as keyof typeof BUDGETS, false).length, `${name} is minified`);
  }
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
