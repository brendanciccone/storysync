// Runs the drift-check action's Detect drift and Detect token drift scripts
// as its runner does: the `node << 'SCRIPT'` body from action/action.yml on
// node's stdin, in a working directory holding what Map components and
// Extract tokens write, with GITHUB_OUTPUT set and the step's env.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ACTION = fileURLToPath(new URL("../../../action/action.yml", import.meta.url));

// The heredoc of the step with this name. The run: block is indented eight
// spaces in the file, which YAML strips.
function script(step: string): string {
  const yml = readFileSync(ACTION, "utf8");
  const at = yml.indexOf(`    - name: ${step}\n`);
  assert.notEqual(at, -1, `action.yml has no step named ${step}`);
  const open = "node << 'SCRIPT'\n";
  const start = yml.indexOf(open, at) + open.length;
  const end = yml.indexOf("\n        SCRIPT\n", start);
  return yml.slice(start, end).split("\n").map((line) => line.replace(/^ {8}/, "")).join("\n");
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  report: string | null;
}

function run(step: string, report: string, files: Record<string, string>, env: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), "storysync-action-"));
  try {
    mkdirSync(join(dir, ".storysync"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const outputFile = join(dir, "github-output");
    writeFileSync(outputFile, "");
    const r = spawnSync(process.execPath, [], {
      cwd: dir,
      input: script(step),
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputFile, WORKING_DIRECTORY: ".", STORYSYNC_VERSION: "0.3.0", ...env },
    });
    const outputs: Record<string, string> = {};
    for (const m of readFileSync(outputFile, "utf8").matchAll(/^(\w+)<<STORYSYNC_EOF\n([\s\S]*?)\nSTORYSYNC_EOF$/gm)) outputs[m[1]] = m[2];
    let body: string | null = null;
    try {
      body = readFileSync(join(dir, report), "utf8");
    } catch {}
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs, report: body };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Detect drift ---

interface Component {
  name: string;
  title?: string;
  category?: string;
  variantProperties: { name: string; type: string; values: string[]; defaultValue: string }[];
  combinations: number;
  capped: boolean;
  error: null;
}

function component(title: string, props: number): Component {
  const parts = title.split("/");
  return {
    name: parts[parts.length - 1],
    title,
    category: parts.slice(0, -1).join("/") || undefined,
    variantProperties: Array.from({ length: props }, (_, i) => ({ name: `p${i}`, type: "VARIANT", values: ["a", "b"], defaultValue: "a" })),
    combinations: 2 ** props,
    capped: false,
    error: null,
  };
}

function mapJson(components: Component[]): string {
  const totalCombinations = components.reduce((sum, c) => sum + c.combinations, 0);
  return JSON.stringify({ components, summary: { total: components.length, mapped: components.length, failed: 0, capped: 0, totalCombinations } });
}

function detectDrift(baseline: string, current: Component[]): Run {
  return run("Detect drift", "storysync-drift.md", { ".storysync/baseline.json": baseline, "storysync-current.json": mapJson(current) }, {
    BASELINE_PATH: ".storysync/baseline.json",
    STORYBOOK_URL: "http://localhost:6006",
    COMPONENTS: "",
  });
}

const formsButton = component("Forms/Button", 3);
const frozen = component("Forms/Frozen", 1);
const navButton = component("Nav/Button", 1);

test("action Detect drift: two components named Button are told apart by their titles", () => {
  // Keyed on the name, the last Button stood for both: an unchanged library
  // was drift on every run, which no new baseline could fix.
  const both = mapJson([formsButton, frozen, navButton]);
  const unchanged = detectDrift(both, [formsButton, frozen, navButton]);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.outputs.result, "false", unchanged.stdout);
  assert.match(unchanged.stdout, /No drift detected/);

  // Storybook can list them in another order.
  const reordered = detectDrift(both, [navButton, frozen, formsButton]);
  assert.equal(reordered.outputs.result, "false", reordered.stdout);

  // With one of them gone, the other one used to stand in for it.
  const removed = detectDrift(both, [frozen, navButton]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.outputs.result, "true", removed.stdout);
  assert.match(removed.report ?? "", /### Removed\n- \*\*Forms\/Button\*\*\n/);
  assert.doesNotMatch(removed.report ?? "", /### Changed|Nav\/Button/);

  // And a new one was reported as a change to the old one.
  const added = detectDrift(mapJson([formsButton, frozen]), [formsButton, frozen, navButton]);
  assert.equal(added.outputs.result, "true", added.stdout);
  assert.match(added.report ?? "", /### Added\n- \*\*Nav\/Button\*\* \(2 combinations\)\n/);
  assert.doesNotMatch(added.report ?? "", /### Changed|### Removed/);
});

test("action Detect drift: a changed component is reported under its title, and one with no title under its name", () => {
  const changed = detectDrift(mapJson([formsButton, navButton]), [formsButton, component("Nav/Button", 2)]);
  assert.equal(changed.outputs.result, "true", changed.stdout);
  assert.match(changed.report ?? "", /### Changed\n- \*\*Nav\/Button\*\*: 1 → 2 props, 2 → 4 combinations\n\n/);

  const { title: _title, category: _category, ...untitled } = component("Button", 1);
  const grown = { ...untitled, variantProperties: component("Button", 2).variantProperties, combinations: 4 };
  const r = detectDrift(mapJson([untitled]), [grown]);
  assert.equal(r.outputs.result, "true", r.stdout);
  assert.match(r.report ?? "", /### Changed\n- \*\*Button\*\*: 1 → 2 props, 2 → 4 combinations\n/);
  assert.doesNotMatch(r.report ?? "", /### Added|### Removed/);
});

// --- Detect token drift ---

interface Collection {
  category: string;
  tokens: { name: string; value: string }[];
}

function tokensJson(collections: Collection[]): string {
  return JSON.stringify({ version: 1, source: "theme", sourcePath: "src/theme.ts", collections, warnings: [] });
}

function detectTokenDrift(baseline: string, current: Collection[]): Run {
  return run("Detect token drift", "storysync-token-drift.md", { ".storysync/tokens-baseline.json": baseline, "storysync-tokens-current.json": tokensJson(current) }, {
    TOKEN_BASELINE_PATH: ".storysync/tokens-baseline.json",
    TOKEN_SOURCE: "auto",
  });
}

// A theme file's fontSizes and fontWeights are both typography.
const colors = { category: "colors", tokens: [{ name: "primary", value: "#0000ff" }] };
const fontSizes = { category: "typography", tokens: [{ name: "sm", value: "14px" }, { name: "md", value: "16px" }] };
const fontWeights = { category: "typography", tokens: [{ name: "regular", value: "400" }, { name: "bold", value: "700" }] };

test("action Detect token drift: every collection of a category is compared, not only the last", () => {
  const baseline = tokensJson([colors, fontSizes, fontWeights]);
  const unchanged = detectTokenDrift(baseline, [colors, fontSizes, fontWeights]);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.outputs.result, "false", unchanged.stdout);

  // fontSizes was hidden behind fontWeights on both sides.
  const resized = { category: "typography", tokens: [{ name: "sm", value: "99px" }, { name: "md", value: "16px" }] };
  const changed = detectTokenDrift(baseline, [colors, resized, fontWeights]);
  assert.equal(changed.outputs.result, "true", changed.stdout);
  assert.match(changed.report ?? "", /### Changed collections\n- \*\*typography\*\*: 0 added, 1 changed\n/);
  assert.doesNotMatch(changed.report ?? "", /### Removed tokens|### New collections/);

  // With fontWeights gone, sm and md were reported as added.
  const dropped = detectTokenDrift(baseline, [colors, fontSizes]);
  assert.equal(dropped.outputs.result, "true", dropped.stdout);
  assert.match(dropped.report ?? "", /### Removed tokens\n- \*\*typography\*\*: 2 token\(s\) removed\n/);
  assert.doesNotMatch(dropped.report ?? "", /### Changed collections|### New collections/);

  // Moved from one collection of the category to another is no change.
  const merged = detectTokenDrift(baseline, [colors, { category: "typography", tokens: [...fontSizes.tokens, ...fontWeights.tokens] }]);
  assert.equal(merged.outputs.result, "false", merged.stdout);
});
