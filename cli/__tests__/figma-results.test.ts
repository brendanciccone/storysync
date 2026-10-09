// Assembling the readback from the responses a push saved (design 9.4):
// what `verify --plan` reads, and what it reports when a planned read's
// result isn't there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTreeFixture } from "./mock-figma.js";
import { assemble, buildFixture, newFigma, readBack } from "./tree-harness.js";
import { continuationResult, loadPlanResults, parseReadResult } from "../figma-results.js";
import type { ReadResult } from "../figma-results.js";
import type { FigmaPlan, PlanCall } from "../tree-types.js";
import { verify } from "../verify.js";

const call = (seq: number, kind: PlanCall["kind"], result: string): PlanCall => ({
  seq, kind, page: "Components", components: [], file: `calls/${result.slice(8, -5)}-${kind}.js`, result, description: "", chars: 0,
});

function planDir(calls: PlanCall[]): { dir: string; plan: string } {
  const dir = mkdtempSync(join(tmpdir(), "storysync-results-"));
  mkdirSync(join(dir, "figma", "results"), { recursive: true });
  const plan: FigmaPlan = { version: 1, storysyncVersion: "test", snap: { path: "snaps/styles.json", measuredAt: "", digest: "" }, calls };
  writeFileSync(join(dir, "figma", "plan.json"), JSON.stringify(plan));
  return { dir, plan: join(dir, "figma", "plan.json") };
}

test("results: the read result is found in what use_figma's text can be", () => {
  const result: ReadResult = { kind: "read", tpl: 2, page: "p", sets: [] };
  const json = JSON.stringify(result);
  assert.deepEqual(parseReadResult(json), result, "the object as JSON");
  assert.deepEqual(parseReadResult(JSON.stringify(json)), result, "that again as a JSON string");
  assert.deepEqual(parseReadResult(`Result:\n${json}\n`), result, "with text around it");
  assert.deepEqual(parseReadResult(JSON.stringify({ content: [{ type: "text", text: json }] })), result, "inside the MCP result");
  assert.equal(parseReadResult("Error: Found 0 sets with storysync id x"), null, "a failed call's error");
  assert.equal(parseReadResult(JSON.stringify({ kind: "build", sets: [] })), null, "another call's result");
});

test("results: a continuation's result follows its call's, b, c and on", () => {
  assert.equal(continuationResult("results/05.json"), "results/05b.json");
  assert.equal(continuationResult("results/05b.json"), "results/05c.json");
  assert.throws(() => continuationResult("results/notes.txt"), /not a read result's path/);
});

test("results: verify --plan reads every saved result, follows continuations, writes the readback, and reports what wasn't read", async () => {
  const figma = newFigma();
  const card = loadTreeFixture("card");
  const toggle = loadTreeFixture("toggle");
  const builtCard = await buildFixture(figma, card);
  const builtToggle = await buildFixture(figma, toggle);
  // The Card read in two calls, the second as `storysync figma next` writes it.
  const cardReads = await readBack(figma, [[builtCard.component, 0, 1, 0]], { limit: 5000 });
  assert.equal(cardReads.length, 2);
  const [toggleRead] = await readBack(figma, [[builtToggle.component, 0, 5, 0]]);
  const { dir, plan } = planDir([
    call(1, "build", "results/01.json"),
    call(2, "read", "results/02.json"),
    call(3, "read", "results/03.json"),
    call(4, "read", "results/04.json"),
  ]);
  try {
    const results = join(dir, "figma", "results");
    writeFileSync(join(results, "01.json"), JSON.stringify({ kind: "build" }));
    writeFileSync(join(results, "02.json"), JSON.stringify(cardReads[0]));
    // Saved as the tool's text holds a string: parsed twice.
    writeFileSync(join(results, "02b.json"), JSON.stringify(JSON.stringify(cardReads[1])));
    writeFileSync(join(results, "03.json"), `use_figma returned:\n${JSON.stringify(toggleRead)}`);
    const loaded = loadPlanResults(plan);
    assert.deepEqual(loaded.notRead, [4]);
    assert.match(loaded.problems.join("\n"), /call 4: no result saved at/);
    assert.equal(loaded.written, join(dir, "figma-readback.json"));
    const written = readFileSync(loaded.written, "utf8");
    assert.deepEqual(JSON.parse(written), loaded.readback);
    assert.deepEqual(Object.keys(loaded.readback.components), ["ui/base/Card", "ui/base/Toggle"]);
    // Entries as the template sealed them, byte for byte.
    assert.deepEqual(loaded.readback.components["ui/base/Card"].variants["size-sm"], cardReads[1].sets[0].entries["size-sm"]);
    // The same results give the same file.
    assert.equal(readFileSync(loadPlanResults(plan).written, "utf8"), written);

    const scored = verify(card, loaded.readback, 0.5, { notRead: loaded.notRead });
    assert.equal(scored.elementFidelity, 1);
    assert.deepEqual(scored.notRead, [4]);

    // A continuation the plan asks for but nobody saved, and a result that holds an error.
    rmSync(join(results, "02b.json"));
    writeFileSync(join(results, "04.json"), "Error: Script exceeded time limit");
    const partial = loadPlanResults(plan);
    assert.deepEqual(partial.notRead, [2, 4]);
    assert.match(partial.problems.join("\n"), /call 2: no result saved at .*02b\.json, where `storysync figma next` asks for one/);
    assert.match(partial.problems.join("\n"), /call 4: results\/04\.json holds no read result/);
    assert.deepEqual(Object.keys(partial.readback.components["ui/base/Card"].variants), ["size-default"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("results: an entry read twice keeps the first reading, and the file is in key order whatever order the calls came in", async () => {
  const figma = newFigma();
  const switchFixture = loadTreeFixture("switch");
  const toggleFixture = loadTreeFixture("toggle");
  const builtSwitch = await buildFixture(figma, switchFixture);
  const builtToggle = await buildFixture(figma, toggleFixture);
  const [toggleRead] = await readBack(figma, [[builtToggle.component, 0, 5, 0]]);
  const [first] = await readBack(figma, [[builtSwitch.component, 1, 1, 0], [builtSwitch.component, 0, 0, 0]]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const [again] = await readBack(figma, [[builtSwitch.component, 0, 1, 0]]);
  const { dir, plan } = planDir([call(1, "read", "results/01.json"), call(2, "read", "results/02.json"), call(3, "read", "results/03.json")]);
  try {
    const results = join(dir, "figma", "results");
    writeFileSync(join(results, "01.json"), JSON.stringify(toggleRead));
    writeFileSync(join(results, "02.json"), JSON.stringify(first));
    writeFileSync(join(results, "03.json"), JSON.stringify(again));
    const loaded = loadPlanResults(plan);
    assert.deepEqual(loaded.problems, [
      "results/03.json reads ui/base/Switch size-default again; the first reading is kept",
      "results/03.json reads ui/base/Switch size-sm again; the first reading is kept",
    ]);
    assert.deepEqual(loaded.readback.components["ui/base/Switch"].variants["size-sm"], first.sets[0].entries["size-sm"]);
    const written = readFileSync(loaded.written, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(written).components), ["ui/base/Switch", "ui/base/Toggle"]);
    assert.deepEqual(Object.keys(JSON.parse(written).components["ui/base/Switch"]), ["nodeId", "total", "unbuilt", "variants"]);
    assert.deepEqual(Object.keys(JSON.parse(written).components["ui/base/Switch"].variants), ["size-default", "size-sm"]);
    assert.deepEqual(JSON.parse(written).components["ui/base/Switch"].total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("results: one component read from two sets is reported, not merged", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  const [read] = await readBack(figma, [[built.component, 0, 1, 0]]);
  const other: ReadResult = JSON.parse(JSON.stringify(read));
  other.sets[0].id = "99:1";
  assert.throws(() => assemble([read, other]), /two sets carry its id/);
});

test("results: a plan that isn't one says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-results-"));
  try {
    assert.throws(() => loadPlanResults(join(dir, "plan.json")), /Could not read the plan .* Run `storysync figma code` first/);
    writeFileSync(join(dir, "plan.json"), "{}");
    assert.throws(() => loadPlanResults(join(dir, "plan.json")), /has no "calls"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
