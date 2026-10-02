// Runs the compiled `verify` command against fixture files, so the exit codes
// and printed verdicts are covered in CI — the acceptance suite checks the same
// behaviour end to end, but needs a running Storybook and does not run there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readbackChecksum } from "../verify.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

const STYLES = { display: "inline-flex", backgroundColor: "#2563eb", fontSize: 12, text: null };

function snap(overrides: Record<string, unknown> = {}, component: Record<string, unknown> = {}) {
  return {
    version: 1,
    storysyncVersion: "test",
    storybookUrl: "http://localhost:6006",
    variantSelection: "representative",
    components: [{
      name: "Button",
      title: "Forms/Button",
      storyId: "forms-button--default",
      variantProperties: [],
      base: { combination: {}, slug: "a", styles: STYLES },
      variants: [{ combination: {}, slug: "a", status: "ok", error: null, delta: {} }],
      warnings: [],
      error: null,
      ...component,
    }],
    summary: { components: 1, variants: 1, rendered: 1, failed: 0, componentsFailed: 0, componentsWithWarnings: 0 },
    ...overrides,
  };
}

/** A readback of one variant, sealed with the checksum the template gives it unless `seal` is false. */
function readback(variant: Record<string, unknown>, { seal = true } = {}) {
  const entry = seal ? { ...variant, checksum: readbackChecksum("a", variant) } : variant;
  return { version: 1, components: { "Forms/Button": { nodeId: "1:2", variants: { a: entry } } } };
}

const MATCHING = { source: "measured", backgroundColor: "#2563eb", fontSize: 12 };

function verify(snapFile: unknown, readbackFile: unknown, ...flags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "storysync-verify-"));
  try {
    writeFileSync(join(dir, "styles.json"), JSON.stringify(snapFile));
    // A string is written as it is, to test how a file is laid out.
    writeFileSync(join(dir, "readback.json"), typeof readbackFile === "string" ? readbackFile : JSON.stringify(readbackFile));
    const r = spawnSync(process.execPath, [
      CLI, "verify", "--snap", join(dir, "styles.json"), "--readback", join(dir, "readback.json"), ...flags,
    ], { encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("verify CLI: a matching readback passes --strict and says what it matched", () => {
  const r = verify(snap(), readback(MATCHING), "--strict");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Figma matches the measured styles for Forms\/Button/);
});

test("verify CLI: a readback with nothing comparable fails --strict and claims no match", () => {
  const r = verify(snap(), readback({ source: "measured" }), "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /1 unscored/);
  assert.match(r.out, /reported no comparable properties/);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: a component the snap failed to measure fails --strict and claims no match", () => {
  const r = verify(
    snap({ summary: { components: 1, variants: 1, rendered: 1, failed: 0, componentsFailed: 1, componentsWithWarnings: 0 } },
      { error: "render timed out" }),
    readback(MATCHING),
    "--strict",
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /snap recorded a failure: Forms\/Button: render timed out/);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: a snap with no components fails --strict and claims no match", () => {
  const r = verify(snap({ components: [], summary: { components: 0, variants: 0, rendered: 0, failed: 0, componentsFailed: 0, componentsWithWarnings: 0 } }),
    { version: 1, components: {} }, "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no components at all/);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: a single unmeasurable variant is reported but does not fail --strict alone", () => {
  // args_unsupported is expected for values Storybook cannot pass in a URL; the
  // skill builds those from source and labels them inferred, which
  // --strict-measured already fails. Failing --strict too would make a correct
  // run impossible to pass.
  const r = verify(
    snap({ summary: { components: 1, variants: 2, rendered: 1, failed: 1, componentsFailed: 0, componentsWithWarnings: 0 } }, {
      variants: [
        { combination: {}, slug: "a", status: "ok", error: null, delta: {} },
        { combination: {}, slug: "b", status: "args_unsupported", error: "value contains /", delta: null },
      ],
    }),
    readback(MATCHING),
    "--strict",
  );
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /1 variant\(s\) could not be measured/);
});

test("verify CLI: a readback entry edited after Figma returned it fails --strict, unscored, without saying what would pass", () => {
  // Figma reported magenta; the file was then edited to the measured blue.
  const file = readback({ ...MATCHING, backgroundColor: "#ff00ff" });
  file.components["Forms/Button"].variants.a.backgroundColor = "#2563eb";
  const r = verify(snap(), file, "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /1 with an unverified readback/);
  assert.match(r.out, /Forms\/Button a readback entry does not match its checksum, so it was edited or composed after Figma returned it — nothing in it was scored/);
  assert.match(r.out, /Read these variants back again[^\n]*exactly as returned/);
  assert.match(r.out, /Fidelity: n\/a \(0\/0 properties\) — 1 unverified readback entry excluded/);
  assert.doesNotMatch(r.out, /Figma matches/);
  assert.doesNotMatch(r.out, new RegExp(readbackChecksum("a", MATCHING).slice("fnv1a:".length)), "printed the checksum that would pass");
  // Reported without --strict, as drift is, but not failed.
  assert.equal(verify(snap(), file).status, 0);
});

test("verify CLI: a readback entry with no checksum fails --strict and claims no match", () => {
  const r = verify(snap(), readback(MATCHING, { seal: false }), "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /readback entry has no checksum, so it is not as the readback template returned it/);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: a readback indented with tabs and its keys in another order still passes --strict", () => {
  const entry = readback({ source: "measured", backgroundColor: "#2563eb", fontSize: 12, gap: { row: 0, column: 0 } })
    .components["Forms/Button"].variants.a as Record<string, unknown>;
  const reordered = Object.fromEntries(Object.entries(entry).reverse());
  reordered.gap = { column: 0, row: 0 };
  const text = JSON.stringify({ components: { "Forms/Button": { variants: { a: reordered }, nodeId: "1:2" } }, version: 1 }, null, "\t");
  const r = verify(snap(), text, "--strict");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Figma matches the measured styles for Forms\/Button/);
});
