// Minifies templates/*.js into dist/templates/*.min.js for `storysync figma code`.
//
// A template is the body of the async function a call runs it as: it reads
// the constants the call passes it (DATA, PAGE, ...), and awaits and returns
// at its top level (cli/checksum.ts, callCode). terser takes a script or a module, not a function body, so
// each is minified as the body of a function and taken back out of it. Names
// the template only reads, such as `figma` and DATA, are never declared in
// that function, so they keep their names.
//
// terser is pure JavaScript with no install scripts, and only a dev
// dependency: the published package ships the minified output, and `figma
// code --no-minify` the readable sources beside it.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "templates");
const target = join(root, "dist", "templates");
const OPEN = "async function __template(){";

mkdirSync(target, { recursive: true });
for (const name of readdirSync(source).filter((f) => f.endsWith(".js")).sort()) {
  const code = readFileSync(join(source, name), "utf8");
  const result = await minify(`${OPEN}${code}\n}`, {
    ecma: 2020,
    compress: { passes: 2, unused: false },
    mangle: true,
    // ASCII only: the call's TSUM is over this text, so a character an
    // agent retyping it could turn into another is written as its escape.
    format: { comments: false, ascii_only: true },
  });
  const out = result.code ?? "";
  if (!out.startsWith(OPEN) || !out.endsWith("}")) {
    throw new Error(`${name}: terser did not keep the wrapping function, so its body can't be taken back out`);
  }
  const body = out.slice(OPEN.length, -1);
  writeFileSync(join(target, name.replace(/\.js$/, ".min.js")), `${body}\n`);
  console.log(`templates/${name}: ${code.length} -> ${body.length} characters`);
}
