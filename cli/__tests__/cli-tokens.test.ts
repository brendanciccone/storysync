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
      assert.match(r.out, /`mkdir -p -- \.storysync && storysync tokens --json > \.storysync\/tokens-baseline\.json`/);
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

test("tokens CLI: --check --strict passes an unchanged config with a commented-out key", () => {
  // The comment was a second token of the same name, and the check failed
  // on every run, a fresh baseline included.
  withProject((dir) => {
    writeFileSync(join(dir, "tailwind.config.ts"), `export default { theme: { extend: { colors: {\n  // brand: "#ff0000",\n  brand: "#abcdef",\n} } } }`);
    const created = spawnSync(process.execPath, [CLI, "tokens", "--json"], { cwd: dir, encoding: "utf8" });
    assert.equal((JSON.parse(created.stdout) as { summary: { totalTokens: number } }).summary.totalTokens, 1);
    mkdirSync(join(dir, ".storysync"));
    writeFileSync(join(dir, ".storysync", "tokens-baseline.json"), created.stdout);

    const r = tokens(dir, "--check", "--strict");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /No token drift detected/);
  });
});

test("tokens CLI: the suggested command makes a baseline directory whose name starts with a dash", () => {
  // Without `--`, mkdir read "-baselines" as its options and failed, so the
  // command the message gives never wrote the baseline.
  withProject((dir) => {
    const missing = tokens(dir, "--check", "--baseline=-baselines/tokens.json");
    assert.equal(missing.status, 1, missing.out);
    const command = missing.out.match(/Create one with `([^`]+)`/)?.[1];
    assert.equal(command, "mkdir -p -- -baselines && storysync tokens --json > -baselines/tokens.json");

    const shim = `storysync() { ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"; }; ${command}`;
    const created = spawnSync("sh", ["-c", shim], { cwd: dir, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);

    const clean = tokens(dir, "--check", "--strict", "--baseline=-baselines/tokens.json");
    assert.equal(clean.status, 0, clean.out);
    assert.match(clean.out, /No token drift detected/);
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
    assert.match(r.out, /has no "collections", so it is not a baseline\. Recreate it with `mkdir -p -- \.storysync && storysync tokens --json/);
  });
});

test("tokens CLI: --check with malformed collections in the baseline fails with the command to recreate it", () => {
  withProject((dir) => {
    // `{"collections":[{}]}` crashed the text report with a TypeError and
    // passed under --json, listing a removed collection with no name.
    mkdirSync(join(dir, ".storysync"));
    const baseline = join(dir, ".storysync", "tokens-baseline.json");
    for (const bad of [`{"collections":[{}]}`, `{"collections":[{"category":"colors","tokens":[{"value":"#fff"}]}]}`]) {
      writeFileSync(baseline, bad);
      const text = tokens(dir, "--check");
      assert.equal(text.status, 1, text.out);
      assert.match(text.out, /so it is not a baseline\. Recreate it with `mkdir -p -- \.storysync && storysync tokens --json/);
      assert.doesNotMatch(text.out, /TypeError/);

      const json = tokens(dir, "--check", "--json");
      assert.equal(json.status, 1, json.out);
      assert.match((JSON.parse(json.stdout) as { error: string }).error, /so it is not a baseline/);
    }
  });
});

/** Runs fn in a directory with no token source at all: nothing is extracted. */
function withEmptyProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "storysync-tokens-cli-empty-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("tokens CLI: --check with no baseline fails even when no tokens are found", () => {
  // It used to return before reading the baseline, so a typo'd --project, or
  // a project with nothing detected, passed every check having compared nothing.
  withEmptyProject((dir) => {
    for (const flags of [[], ["--project", "no-such-dir"]]) {
      const r = tokens(dir, "--check", ...flags);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /No token source found/);
      assert.match(r.out, /No token baseline at \.storysync\/tokens-baseline\.json/);
      // The suggested baseline would be empty, and match the same mistake forever.
      assert.match(r.out, /No tokens were found either, so check --project and --source first/);
    }

    const json = tokens(dir, "--check", "--json");
    assert.equal(json.status, 1, json.out);
    const data = JSON.parse(json.stdout) as { drift: unknown; error: string; collections: unknown[] };
    assert.equal(data.drift, "new");
    assert.match(data.error, /No token baseline at/);
    assert.deepEqual(data.collections, []);
  });
});

test("tokens CLI: --check against a baseline when no tokens are found reports every token removed", () => {
  withProject((dir) => {
    const created = spawnSync(process.execPath, [CLI, "tokens", "--json"], { cwd: dir, encoding: "utf8" });
    mkdirSync(join(dir, ".storysync"));
    writeFileSync(join(dir, ".storysync", "tokens-baseline.json"), created.stdout);
    rmSync(join(dir, "tailwind.config.ts"));

    const text = tokens(dir, "--check");
    assert.equal(text.status, 0, text.out);
    assert.match(text.out, /Token drift detected/);
    assert.match(text.out, /- colors: brand/);

    const strict = tokens(dir, "--check", "--strict");
    assert.equal(strict.status, 1, strict.out);

    // A mistyped --project is the same: nothing found, everything removed.
    const json = tokens(dir, "--check", "--json", "--project", "no-such-dir");
    assert.equal(json.status, 0, json.out);
    const data = JSON.parse(json.stdout) as { drift: boolean; removed: { category: string; tokens: { name: string }[] }[] };
    assert.equal(data.drift, true);
    assert.deepEqual(data.removed.map((r) => [r.category, r.tokens.map((t) => t.name)]), [["colors", ["brand"]]]);
  });
});

const UNKNOWN_SOURCE = (source: string) => new RegExp(`--source must be "tailwind", "css" or "theme", received "${source}"`);

test("tokens CLI: an unknown --source fails naming the ones there are, rather than detecting one", () => {
  // It used to fall through to detection, so `--source scss` read the
  // Tailwind config and exited 0, and --check compared whatever was detected.
  withProject((dir) => {
    for (const flags of [[], ["--strict"], ["--check"]]) {
      const r = tokens(dir, "--source", "scss", ...flags);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, UNKNOWN_SOURCE("scss"));
      assert.equal(r.stdout, "");
      assert.doesNotMatch(r.out, /Detected|brand|No token baseline/);
    }
  });
});

test("tokens CLI: an unknown --source fails under --json with an error that still parses", () => {
  withProject((dir) => {
    // An empty value, as `--source "$UNSET"` gives, is not leaving it out.
    for (const source of ["scss", "CSS", "AUTO", ""]) {
      for (const flags of [[], ["--check"]]) {
        const r = tokens(dir, "--source", source, "--json", ...flags);
        assert.equal(r.status, 1, r.out);
        const data = JSON.parse(r.stdout) as { error?: string; collections?: unknown };
        assert.match(data.error ?? "", UNKNOWN_SOURCE(source));
        assert.equal(data.collections, undefined);
      }
    }
  });
});

test("tokens CLI: each --source there is still reads that source", () => {
  withProject((dir) => {
    for (const source of ["tailwind", "css", "theme"]) {
      const r = tokens(dir, "--source", source, "--json");
      assert.equal(r.status, 0, r.out);
      const data = JSON.parse(r.stdout) as { source: string; summary: { totalTokens: number } };
      assert.equal(data.source, source);
      // Only the Tailwind config exists, so only it finds tokens.
      assert.equal(data.summary.totalTokens, source === "tailwind" ? 1 : 0);
    }
  });
});

test("tokens CLI: --source auto detects the source, as leaving it out does", () => {
  // auto is the drift-check action's token_source default, which the README
  // tells action users to pass on to --source when they write the baseline.
  withProject((dir) => {
    const auto = tokens(dir, "--source", "auto", "--json");
    assert.equal(auto.status, 0, auto.out);
    assert.equal(auto.stdout, tokens(dir, "--json").stdout);

    // The command it gives for a missing baseline detects too, without --source.
    const missing = tokens(dir, "--source", "auto", "--check");
    assert.equal(missing.status, 1, missing.out);
    assert.match(missing.out, /`mkdir -p -- \.storysync && storysync tokens --json > \.storysync\/tokens-baseline\.json`/);

    // And a baseline written without --source checks clean against it.
    mkdirSync(join(dir, ".storysync"));
    writeFileSync(join(dir, ".storysync", "tokens-baseline.json"), auto.stdout);
    const check = tokens(dir, "--source", "auto", "--check", "--strict");
    assert.equal(check.status, 0, check.out);
    assert.match(check.out, /No token drift detected/);
  });
});
