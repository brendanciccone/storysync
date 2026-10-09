// Smoke tests for the CLI entry point.
//
// These run the *compiled* CLI (dist/cli/index.js) with the same Node binary
// running the tests, so they exercise the artifact users actually get rather
// than the TypeScript source. That means they depend on `tsc` having run —
// which the `test` script guarantees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// npm makes a bin executable when it installs a package from the registry,
// but a package linked or installed from a directory runs the build's own
// file, as `npx storysync` does there: tsc writes it without the execute
// bits, and it failed with "Permission denied" after every rebuild.
test("CLI: the build leaves each bin executable, so a linked storysync runs through npx", { skip: process.platform === "win32" && "Windows has no execute bits" }, () => {
  const root = join(__dirname, "..", "..", "..");
  const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin: Record<string, string> };
  assert.deepEqual(Object.values(bin), ["dist/cli/index.js"]);
  for (const file of Object.values(bin)) {
    const path = join(root, file);
    assert.equal(statSync(path).mode & 0o111, 0o111, `${file} is executable by everyone who can read it`);
    // Run as a shell runs node_modules/.bin/storysync: the file itself, through its #! line.
    assert.match(execFileSync(path, ["--version"], { encoding: "utf8" }).trim(), /^\d+\.\d+\.\d+/);
  }
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

test("CLI: every command's --help lists each of its options, the element-tree ones included", () => {
  const options: Record<string, string[]> = {
    snap: ["--root-only", "--no-channel-args", "--stories <pairs>", "--merge", "--exclude-props <names>", "--strict-warnings"],
    verify: ["--plan <path>", "--min-fidelity <pct>", "--allow-designer-layers", "--roots-only", "--strict", "--strict-age", "--strict-measured", "--skip <names>"],
    "figma code": ["--snap <path>", "--tokens <path>", "--components <names>", "--skip <names>", "--out <dir>", "--max-chars <n>", "--max-nodes <n>", "--read-limit <n>", "--no-minify", "--json"],
    "figma upload": ["--plan <path>", "--seq <n>", "--json"],
    "figma next": ["--plan <path>", "--seq <n>", "--json"],
  };
  for (const [command, flags] of Object.entries(options)) {
    const help = run(...command.split(" "), "--help");
    for (const flag of flags) assert.ok(help.includes(flag), `${command} --help doesn't list ${flag}`);
  }
  const figma = run("figma", "--help");
  for (const sub of ["code", "upload", "next"]) assert.match(figma, new RegExp(`\\n  ${sub} \\[options\\]`));
  assert.match(run("--help"), /\n  figma +Write the use_figma calls/);
});

test("CLI: snap refuses a --stories pair it can't read before connecting to Storybook", () => {
  // Port 9 has nothing listening: the refusal must come first, as JSON under --json.
  for (const [value, why] of [["ui-base-button", /component=storyId pairs/], ["a=b,A=c", /names "A" twice/], ["=story", /component=storyId pairs/]] as const) {
    let out = "";
    let status = 0;
    try {
      run("snap", "--storybook", "http://127.0.0.1:9", "--stories", value, "--json");
    } catch (err) {
      status = (err as { status?: number }).status ?? -1;
      out = String((err as { stdout?: string }).stdout ?? "");
    }
    assert.equal(status, 1, value);
    const error = (JSON.parse(out) as { error?: string }).error ?? "";
    assert.match(error, why);
    assert.doesNotMatch(error, /Failed to connect/);
  }
});

test("CLI: the README's verify options say what verify --help says", () => {
  // The README's block had --strict and --strict-measured as they read
  // before readback checks and placeholders, so it told CI less than the
  // flags fail on. Each option's text, whitespace aside, must be the help's.
  const options = (block: string): Map<string, string> => {
    const out = new Map<string, string>();
    let flag = "";
    for (const line of block.split("\n")) {
      const start = /^ {2}(--[a-z-]+(?: <[a-z]+>)?)\s*(.*)$/.exec(line);
      if (start) {
        flag = start[1];
        out.set(flag, start[2]);
      } else if (flag && /^ {3,}\S/.test(line)) {
        out.set(flag, `${out.get(flag)} ${line.trim()}`);
      } else {
        flag = "";
      }
    }
    for (const [key, text] of out) out.set(key, text.replace(/\s+/g, " ").trim());
    return out;
  };
  const readme = readFileSync(join(__dirname, "..", "..", "..", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("### `storysync verify`"));
  const block = /```text\n(Options:[\s\S]*?)```/.exec(section)?.[1] ?? "";
  const documented = options(block);
  const help = options(run("verify", "--help"));
  help.delete("--help");
  assert.deepEqual([...documented.keys()], [...help.keys()], "the README lists other options than verify --help, or in another order");
  for (const [flag, text] of help) assert.equal(documented.get(flag), text, `the README describes ${flag} otherwise than verify --help`);
});
