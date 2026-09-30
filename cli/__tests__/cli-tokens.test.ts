// Runs the compiled `tokens --check` against temporary projects, so its exit
// codes are covered in CI. Each run's working directory is the project, which
// is where the default --baseline path resolves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

function tailwind(brand: string): string {
  return `export default { theme: { extend: { colors: { brand: "${brand}" } } } }`;
}

function withProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "storysync-tokens-cli-"));
  try {
    writeFileSync(join(dir, "tailwind.config.ts"), tailwind("#abcdef"));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tokens(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, "tokens", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, "") };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

test("tokens CLI: --check with no baseline fails whatever the flags, and says how to make one", () => {
  withProject((dir) => {
    for (const flags of [[], ["--strict"]]) {
      const r = tokens(dir, "--check", ...flags);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /No token baseline at \.storysync\/tokens-baseline\.json, so there is nothing to check against/);
      assert.match(r.out, /`mkdir -p \.storysync && storysync tokens --json > \.storysync\/tokens-baseline\.json`/);
      assert.doesNotMatch(r.out, /first run/);
    }
  });
});

test("tokens CLI: --check --json with no baseline still prints parseable JSON, and fails", () => {
  withProject((dir) => {
    const r = tokens(dir, "--check", "--json", "--baseline", "missing.json");
    assert.equal(r.status, 1, r.out);
    const data = JSON.parse(r.stdout) as { drift: unknown; error: string; collections: unknown[] };
    assert.equal(data.drift, "new");
    assert.match(data.error, /No token baseline at missing\.json/);
    assert.equal(data.collections.length, 1);
  });
});

test("tokens CLI: the suggested command writes a baseline --check accepts, and catches a change", () => {
  withProject((dir) => {
    const missing = tokens(dir, "--check");
    const command = missing.out.match(/Create one with `([^`]+)`/)?.[1];
    assert.ok(command, missing.out);

    // Runs the suggestion exactly as printed, with `storysync` standing in for
    // this build.
    const shim = `storysync() { ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"; }; ${command}`;
    const created = spawnSync("sh", ["-c", shim], { cwd: dir, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);

    const clean = tokens(dir, "--check", "--strict");
    assert.equal(clean.status, 0, clean.out);
    assert.match(clean.out, /No token drift detected/);

    writeFileSync(join(dir, "tailwind.config.ts"), tailwind("#123456"));
    const drifted = tokens(dir, "--check", "--strict");
    assert.equal(drifted.status, 1, drifted.out);
    assert.match(drifted.out, /colors\/brand: #abcdef → #123456/);
  });
});

test("tokens CLI: a baseline that is not one fails with the command to recreate it", () => {
  withProject((dir) => {
    // A saved passing `--check --json` is the realistic mistake: it is only
    // {"drift":false}, and used to crash on its missing collections.
    mkdirSync(join(dir, ".storysync"));
    writeFileSync(join(dir, ".storysync", "tokens-baseline.json"), `{"drift":false}`);
    const r = tokens(dir, "--check");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /has no "collections", so it is not a baseline\. Recreate it with `mkdir -p \.storysync && storysync tokens --json/);
  });
});
