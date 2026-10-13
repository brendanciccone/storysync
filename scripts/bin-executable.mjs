// Makes every `bin` that package.json names executable, after `tsc` writes it.
//
// tsc writes each file it emits as an ordinary one, without the execute
// bits, and `pnpm clean` before a build means every file is new. npm sets
// them when it installs a package from the registry, but not on a package
// linked or installed from a directory, where node_modules/.bin points at
// this very file: there `npx storysync` failed with "Permission denied"
// after a rebuild. Windows has no execute bits, and npm's shims run the
// file through node there, so the mode changes nothing.

import { chmodSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const file of typeof bin === "string" ? [bin] : Object.values(bin ?? {})) {
  const path = join(root, file);
  chmodSync(path, statSync(path).mode | 0o111);
}
