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

function readback(variant: Record<string, unknown>) {
  return { version: 1, components: { "Forms/Button": { nodeId: "1:2", variants: { a: variant } } } };
}

const MATCHING = { source: "measured", backgroundColor: "#2563eb", fontSize: 12 };

function verify(snapFile: unknown, readbackFile: unknown, ...flags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "storysync-verify-"));
  try {
    writeFileSync(join(dir, "styles.json"), JSON.stringify(snapFile));
    writeFileSync(join(dir, "readback.json"), JSON.stringify(readbackFile));
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
