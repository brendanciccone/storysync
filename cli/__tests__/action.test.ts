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

const formsButton = withId(component("Forms/Button", 3));
const frozen = withId(component("Forms/Frozen", 1));
const navButton = withId(component("Nav/Button", 1));

test("action Detect drift: two components named Button are told apart", () => {
  // Keyed on the name, the last Button stood for both: an unchanged library
  // was drift on every run, which no new baseline could fix.
  const both = mapJson([formsButton, frozen, navButton]);
  const unchanged = detectDrift(both, [formsButton, frozen, navButton]);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.outputs.result, "false", unchanged.stdout);
  assert.match(unchanged.stdout, /No drift detected/);
  assert.doesNotMatch(unchanged.stdout, /::warning::/);

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

test("action Detect drift: a changed component is reported under its title, one with no title under its ID, and one from an old baseline under its name", () => {
  const changed = detectDrift(mapJson([formsButton, navButton]), [formsButton, withId(component("Nav/Button", 2))]);
  assert.equal(changed.outputs.result, "true", changed.stdout);
  assert.match(changed.report ?? "", /### Changed\n- \*\*Nav\/Button\*\*: 1 → 2 props, 2 → 4 combinations\n\n/);

  const { title: _title, category: _category, ...untitled } = component("Button", 1);
  const grown = { ...untitled, variantProperties: component("Button", 2).variantProperties, combinations: 4 };
  const r = detectDrift(mapJson([withId(untitled, "button")]), [withId(grown, "button")]);
  assert.equal(r.outputs.result, "true", r.stdout);
  assert.match(r.report ?? "", /### Changed\n- \*\*button\*\*: 1 → 2 props, 2 → 4 combinations\n/);
  assert.doesNotMatch(r.report ?? "", /### Added|### Removed/);

  // A baseline from before IDs: its untitled component matched by name.
  const old = detectDrift(mapJson([untitled]), [grown]);
  assert.match(old.report ?? "", /### Changed\n- \*\*Button\*\*: 1 → 2 props, 2 → 4 combinations\n/);
  assert.doesNotMatch(old.report ?? "", /### Added|### Removed/);
});

test("action Detect drift: a baseline that is not map --json output fails with the command to recreate it", () => {
  // The first is what the printed command writes with Storybook down: under
  // --json, map's error goes to stdout, into the baseline.
  const notBaselines = [
    JSON.stringify({ error: "Error: Failed to connect to Storybook MCP at http://localhost:6006: fetch failed" }),
    JSON.stringify({ components: [] }),
    JSON.stringify({ summary: { total: 0 } }),
    JSON.stringify({ components: [{}], summary: { total: 1 } }),
    JSON.stringify([]),
    "null",
    "",
    "{",
  ];
  for (const baseline of notBaselines) {
    const r = detectDrift(baseline, [formsButton]);
    assert.equal(r.status, 1, `${baseline}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /TypeError|SyntaxError/, baseline);
    const errors = r.stdout.split("\n").filter((line) => line.startsWith("::error::"));
    assert.equal(errors.length, 1, `${baseline}: ${r.stdout}`);
    assert.match(errors[0], /^::error::The baseline at \.storysync\/baseline\.json \(relative to the repository root\) is not map --json output/);
    assert.ok(
      errors[0].includes("Recreate it by running this in the repository root with Storybook running, then commit it: mkdir -p -- .storysync && npx storysync@0.3.0 map --storybook http://localhost:6006 --json > .storysync/baseline.json"),
      errors[0],
    );
    assert.equal(r.outputs.result, undefined, baseline);
    assert.equal(r.report, null, baseline);
  }

  const r = detectDrift(notBaselines[0], [formsButton]);
  assert.match(r.stdout, /is not map --json output \(it holds an error: Failed to connect to Storybook MCP at http:\/\/localhost:6006: fetch failed\)\. Recreate/);
});

/** `c` as map --json writes it now: with its Storybook ID, from the title as Storybook makes one. */
function withId(c: Component, id = (c.title ?? c.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")): Component & { id: string } {
  return { id, ...c };
}

test("action Detect drift: two components of one name and no title are told apart by their IDs", () => {
  // A shadcn registry's Sonner stories document Toaster, under both
  // ui/base/Sonner and ui/radix/Sonner. Keyed by title, then name, both were
  // "Toaster": the check failed on every baseline map --json wrote, and its
  // advice, to write the baseline again, wrote the same one.
  const { title: _t1, category: _c1, ...toaster } = component("Toaster", 1);
  const base = withId(toaster, "ui-base-sonner");
  const radix = withId(toaster, "ui-radix-sonner");
  const both = mapJson([base, radix]);
  const unchanged = detectDrift(both, [base, radix]);
  assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
  assert.equal(unchanged.outputs.result, "false", unchanged.stdout);
  assert.doesNotMatch(unchanged.stdout, /::warning::|::error::/);

  const grown = { ...radix, variantProperties: component("x", 2).variantProperties, combinations: 4 };
  const changed = detectDrift(both, [base, grown]);
  assert.equal(changed.outputs.result, "true", changed.stdout);
  assert.match(changed.report ?? "", /### Changed\n- \*\*ui-radix-sonner\*\*: 1 → 2 props, 2 → 4 combinations\n\n/);
  assert.doesNotMatch(changed.report ?? "", /### Added|### Removed|ui-base-sonner/);
});

test("action Detect drift: a baseline from before IDs is matched by title, with a warning to recreate it", () => {
  // storysync 0.3.0 wrote no IDs, and titles rebuilt from them: "UI Base/
  // Button" for Storybook's ui/base/Button. Matched by title as written,
  // every component was removed and added again.
  const old = [component("UI Base/Button", 2), component("UI Radix/Button", 1), component("Forms/Frozen", 1)];
  const now = [
    withId(component("ui/base/Button", 2)),
    withId(component("ui/radix/Button", 1)),
    withId(component("Forms/Frozen", 1)),
  ];
  const r = detectDrift(mapJson(old), now);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.result, "false", r.stdout);
  const warnings = r.stdout.split("\n").filter((line) => line.startsWith("::warning::"));
  assert.equal(warnings.length, 1, r.stdout);
  assert.match(warnings[0], /^::warning::The baseline at \.storysync\/baseline\.json \(relative to the repository root\) was written before map --json recorded each component's Storybook ID, so its components were matched by title\. Recreate it by running this in the repository root/);

  // A real change still shows, under the new title.
  const changed = detectDrift(mapJson(old), [withId(component("ui/base/Button", 3)), now[1], now[2]]);
  assert.equal(changed.outputs.result, "true", changed.stdout);
  assert.match(changed.report ?? "", /### Changed\n- \*\*ui\/base\/Button\*\*: 2 → 3 props, 4 → 8 combinations\n\n/);
  assert.doesNotMatch(changed.report ?? "", /### Added|### Removed/);

  // The untitled components of one name such a baseline holds can't be
  // matched: they are reported as removed and added, never paired by guess.
  // map --json now gives them Storybook's titles, but the name is still
  // Toaster, the story's component, on both.
  const { title: _t, category: _c, ...toaster } = component("Toaster", 1);
  const sonners = ["ui/base/Sonner", "ui/radix/Sonner"].map((title) => ({ ...withId(component(title, 1)), name: "Toaster" }));
  const untitled = detectDrift(mapJson([toaster, toaster]), sonners);
  assert.equal(untitled.status, 0, untitled.stdout + untitled.stderr);
  assert.equal(untitled.outputs.result, "true", untitled.stdout);
  assert.equal(untitled.report?.match(/^### Added\n((?:- .*\n)*)/m)?.[1], "- **ui/base/Sonner** (2 combinations)\n- **ui/radix/Sonner** (2 combinations)\n");
  assert.equal(untitled.report?.match(/^### Removed\n((?:- .*\n)*)/m)?.[1], "- **Toaster**\n- **Toaster**\n");
  assert.doesNotMatch(untitled.report ?? "", /### Changed/);
  assert.match(untitled.stdout, /::warning::The baseline at .* was written before map --json recorded/);

  // Nor is one untitled Toaster paired with either of two.
  const one = detectDrift(mapJson([toaster]), sonners);
  assert.equal(one.report?.match(/^### Added\n((?:- .*\n)*)/m)?.[1], "- **ui/base/Sonner** (2 combinations)\n- **ui/radix/Sonner** (2 combinations)\n");
  assert.equal(one.report?.match(/^### Removed\n((?:- .*\n)*)/m)?.[1], "- **Toaster**\n");
  assert.doesNotMatch(one.report ?? "", /### Changed/);

  // Nor either of two with the one left.
  const left = detectDrift(mapJson([toaster, toaster]), sonners.slice(0, 1));
  assert.equal(left.report?.match(/^### Added\n((?:- .*\n)*)/m)?.[1], "- **ui/base/Sonner** (2 combinations)\n");
  assert.equal(left.report?.match(/^### Removed\n((?:- .*\n)*)/m)?.[1], "- **Toaster**\n- **Toaster**\n");

  // But the one untitled Toaster is the one Toaster now.
  const single = detectDrift(mapJson([toaster]), sonners.slice(0, 1));
  assert.equal(single.outputs.result, "false", single.stdout);

  // A component 0.3.0 would have titled, its ID ending in its name, is not
  // the untitled one of its name: that one's gone, and Forms/Button is new.
  const { title: _t2, category: _c2, ...loose } = component("Button", 1);
  const misattributed = detectDrift(mapJson([loose, component("Nav/Button", 1)]), [withId(component("Forms/Button", 3)), navButton]);
  assert.equal(misattributed.report?.match(/^### Added\n((?:- .*\n)*)/m)?.[1], "- **Forms/Button** (8 combinations)\n");
  assert.equal(misattributed.report?.match(/^### Removed\n((?:- .*\n)*)/m)?.[1], "- **Button**\n");
  assert.doesNotMatch(misattributed.report ?? "", /### Changed/);
});

test("action Detect drift: with IDs on both sides, a title is compared as its letters and digits", () => {
  const button = withId(component("ui/base/Button", 1));
  // Storybook's index unread, so the title was rebuilt: the same component.
  const rebuilt = detectDrift(mapJson([button]), [{ ...button, title: "UI Base/Button", category: "UI Base" }]);
  assert.equal(rebuilt.outputs.result, "false", rebuilt.stdout);

  // Moved to another folder under the same ID: a change, said as one.
  const moved = detectDrift(mapJson([button]), [{ ...button, title: "ui/legacy/Button", category: "ui/legacy" }]);
  assert.equal(moved.outputs.result, "true", moved.stdout);
  assert.match(moved.report ?? "", /### Changed\n- \*\*ui\/legacy\/Button\*\*: 1 → 1 props, 2 → 2 combinations, was ui\/base\/Button\n/);

  // A new ID is another component, whatever its name: not paired by guess.
  const renamed = detectDrift(mapJson([button]), [withId(component("ui/core/Button", 1))]);
  assert.match(renamed.report ?? "", /### Added\n- \*\*ui\/core\/Button\*\* \(2 combinations\)\n\n### Removed\n- \*\*ui\/base\/Button\*\*\n/);
  assert.doesNotMatch(renamed.report ?? "", /### Changed/);
});

test("action Detect drift: two components with one key, on either side, fail rather than one hiding the other", () => {
  // A baseline with IDs that repeats one, as only a hand edit could.
  const button = withId(component("Forms/Button", 1));
  const old = detectDrift(mapJson([button, { ...button, title: "Nav/Button" }]), [button]);
  assert.equal(old.status, 1, old.stdout + old.stderr);
  const oldErrors = old.stdout.split("\n").filter((line) => line.startsWith("::error::"));
  assert.equal(oldErrors.length, 1, old.stdout);
  assert.match(oldErrors[0], /^::error::The baseline at \.storysync\/baseline\.json \(relative to the repository root\) has more than one component keyed "forms-button", so they can't be told apart\. Recreate it by /);
  assert.equal(old.outputs.result, undefined);

  // Current map output with two untitled Buttons and no IDs, as no map
  // --json writes any more.
  const { title: _t1, category: _c1, ...untitled } = component("Button", 1);
  const cur = detectDrift(mapJson([untitled]), [untitled, untitled]);
  assert.equal(cur.status, 1, cur.stdout + cur.stderr);
  assert.match(cur.stdout, /::error::storysync map returned more than one component keyed "Button", so their drift can't be checked\./);
  assert.equal(cur.outputs.result, undefined);
  assert.equal(cur.report, null);
});

test("action: an issue is still filed for drift found before a step that failed", () => {
  // Detect drift fails on a baseline that isn't map --json output. Without a
  // status function, the issue step was skipped with it, and the token drift
  // found before never reached an issue.
  const yml = readFileSync(ACTION, "utf8");
  const step = yml.slice(yml.indexOf("    - name: Create or update issue\n"));
  const condition = step.match(/^ {6}if: (.+)$/m)?.[1] ?? "";
  assert.match(condition, /!cancelled\(\)|always\(\)/, condition);
  assert.match(condition, /steps\.token-drift\.outputs\.result == 'true'/);
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

test("action Detect token drift: a token baseline that is not tokens --json output fails with the command to recreate it", () => {
  const notBaselines = [
    JSON.stringify({ error: "Error: Could not read src/theme.ts" }),
    JSON.stringify({ drift: false }),
    JSON.stringify({ collections: [{ category: "colors" }] }),
    JSON.stringify({ collections: [{ category: "colors", tokens: [{ name: "primary" }] }] }),
    "null",
    "",
  ];
  for (const baseline of notBaselines) {
    const r = detectTokenDrift(baseline, [colors]);
    assert.equal(r.status, 1, `${baseline}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /TypeError|SyntaxError/, baseline);
    const errors = r.stdout.split("\n").filter((line) => line.startsWith("::error::"));
    assert.equal(errors.length, 1, `${baseline}: ${r.stdout}`);
    assert.match(errors[0], /^::error::The token baseline at \.storysync\/tokens-baseline\.json \(relative to the repository root\) is not tokens --json output/);
    assert.ok(
      errors[0].includes("Recreate it by running this in the repository root, then commit it: mkdir -p -- .storysync && npx storysync@0.3.0 tokens --json > .storysync/tokens-baseline.json"),
      errors[0],
    );
    assert.equal(r.outputs.result, undefined, baseline);
    assert.equal(r.report, null, baseline);
  }

  const r = detectTokenDrift(notBaselines[0], [colors]);
  assert.match(r.stdout, /is not tokens --json output \(it holds an error: Could not read src\/theme\.ts\)\. Recreate/);
});

// --- Both ---

test("action: the command a missing baseline prints makes a directory whose name starts with a dash", () => {
  // Without `--`, mkdir read "-x" as its options and failed, so the command
  // never wrote the baseline.
  const steps: { step: string; report: string; path: string; files: Record<string, string>; env: Record<string, string> }[] = [
    { step: "Detect drift", report: "storysync-drift.md", path: "-x/baseline.json", files: { "storysync-current.json": mapJson([formsButton]) }, env: { BASELINE_PATH: "-x/baseline.json", STORYBOOK_URL: "http://localhost:6006", COMPONENTS: "" } },
    { step: "Detect token drift", report: "storysync-token-drift.md", path: "-x/tokens.json", files: { "storysync-tokens-current.json": tokensJson([colors]) }, env: { TOKEN_BASELINE_PATH: "-x/tokens.json", TOKEN_SOURCE: "auto" } },
  ];
  for (const { step, report, path, files, env } of steps) {
    const r = run(step, report, files, env);
    assert.equal(r.outputs.result, "new", r.stdout);
    const command = r.stdout.match(/then commit it: (.+?) \(the action's/)?.[1];
    assert.match(command ?? "", /^mkdir -p -- -x && npx storysync@0\.3\.0 /, r.stdout);

    // Run as printed, with an npx that echoes what it was asked to run.
    const dir = mkdtempSync(join(tmpdir(), "storysync-action-"));
    try {
      const created = spawnSync("sh", ["-c", `npx() { echo "$*"; }; ${command}`], { cwd: dir, encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
      assert.match(readFileSync(join(dir, path), "utf8"), /^storysync@0\.3\.0 (map|tokens) .*--json\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
