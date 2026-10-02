// Smoke tests for the CLI entry point.
//
// These run the *compiled* CLI (dist/cli/index.js) with the same Node binary
// running the tests, so they exercise the artifact users actually get rather
// than the TypeScript source. That means they depend on `tsc` having run —
// which the `test` script guarantees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "index.js");

function run(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function makeTempProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "storysync-cli-"));
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test("CLI: --version prints a version", () => {
  const out = run("--version").trim();
  assert.match(out, /^\d+\.\d+\.\d+/);
});

test("CLI: tokens --json returns valid JSON", () => {
  const dir = makeTempProject({
    "tailwind.config.ts": `export default { theme: { extend: { colors: { test: "#abcdef" } } } }`,
  });
  try {
    const data = JSON.parse(run("tokens", "--project", dir, "--json"));
    assert.equal(data.source, "tailwind");
    assert.ok(data.summary.totalTokens >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: tokens --strict exits 1 when no tokens found", () => {
  const dir = makeTempProject();
  try {
    // Captured rather than asserted inside the catch: `assert.fail` there would
    // be swallowed by the same catch, reporting "undefined !== 1" instead of
    // the actual problem.
    let status: number | "exited cleanly" = "exited cleanly";
    try {
      run("tokens", "--project", dir, "--strict");
    } catch (err) {
      status = (err as { status?: number }).status ?? -1;
    }
    assert.equal(status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
