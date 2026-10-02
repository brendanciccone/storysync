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

/** What snap measured: an inline-flex element, so its size is compared too. */
const STYLES = {
  display: "inline-flex", backgroundColor: "#2563eb", color: "#ffffff", borderRadiusUniform: 3,
  padding: { top: 4, right: 8, bottom: 4, left: 8 }, borderUniform: null, fontSize: 12, fontWeight: 600,
  fontFamily: "Inter", gap: { row: 6, column: 6 }, opacity: 1, width: 61.5, height: 24, text: null,
};

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

/** When the readbacks here were read, unless a test says otherwise. */
const READ_AT = "2026-10-01T12:00:00.000Z";

/**
 * A readback of these variants, each read at `readAt`, or with none if it is
 * null, and sealed with the checksum the template gives it under the set's
 * id, unless `seal` is false.
 */
function readbackOf(variants: Record<string, Record<string, unknown>>, { seal = true, readAt = READ_AT as string | null } = {}) {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [slug, variant] of Object.entries(variants)) {
    const read = readAt == null ? { ...variant } : { ...variant, readAt };
    entries[slug] = seal ? { ...read, checksum: readbackChecksum("1:2", slug, read) } : read;
  }
  return { version: 1, components: { "Forms/Button": { nodeId: "1:2" as string | undefined, variants: entries } } };
}

/** A readback of the one variant `a`. */
function readback(variant: Record<string, unknown>, options: { seal?: boolean; readAt?: string | null } = {}) {
  return readbackOf({ a: variant }, options);
}

/** Every field the readback template returns, as it would for a faithful copy of STYLES. */
const MATCHING = {
  source: "measured", backgroundColor: "#2563eb", color: "#ffffff", borderRadiusUniform: 3,
  padding: { top: 4, right: 8, bottom: 4, left: 8 }, borderUniform: null, fontSize: 12, fontWeight: 600,
  fontFamily: "Inter", gap: { row: 6, column: 6 }, opacity: 1, width: 61.5, height: 24,
};

/** Runs verify on these files; with `measuredAt`, beside a meta.json saying the snap was taken then. */
function verify(snapFile: unknown, readbackFile: unknown, ...flags: string[]) {
  return verifyMeasuredAt(null, snapFile, readbackFile, ...flags);
}

function verifyMeasuredAt(measuredAt: string | null, snapFile: unknown, readbackFile: unknown, ...flags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "storysync-verify-"));
  try {
    writeFileSync(join(dir, "styles.json"), JSON.stringify(snapFile));
    if (measuredAt) writeFileSync(join(dir, "meta.json"), JSON.stringify({ measuredAt, storybookUrl: "http://localhost:6006" }));
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

test("verify CLI: a readback with nothing comparable fails --strict as incomplete and claims no match", () => {
  const r = verify(snap(), readback({ source: "measured" }), "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Forms\/Button a readback entry is incomplete: it lacks backgroundColor, color, borderRadiusUniform, padding, borderUniform, fontSize, fontWeight, fontFamily, gap, opacity, width, height, which the readback template always returns, so the template was cut down — nothing in it was scored/);
  assert.match(r.out, /1 with an unverified readback/);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: a readback cut down to source, width and height, still sealed, fails --strict and claims no match", () => {
  // Every flag passed on it, at 100%, before verify required the template's
  // fields: width and height match, and nothing else was compared.
  const r = verify(snap(), readback({ source: "measured", width: 61.5, height: 24 }), "--strict-measured");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /readback entry is incomplete: it lacks backgroundColor, color, borderRadiusUniform, padding, borderUniform, fontSize, fontWeight, fontFamily, gap, opacity, which/);
  assert.match(r.out, /Fidelity: n\/a \(0\/0 properties\) — 1 unverified readback entry excluded/);
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

test("verify CLI: a readback with no components reports the variant missing from Figma and fails --strict", () => {
  // It threw a TypeError reading {"version":1}'s components, a crash where an
  // empty readback says what Figma lacks.
  for (const file of [{ version: 1 }, { version: 1, components: {} }]) {
    const r = verify(snap(), file, "--strict");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\? Forms\/Button a not found in Figma/);
    assert.match(r.out, /0 verified, 0 drifted, 1 missing from Figma, across 1 variants/);
    assert.doesNotMatch(r.out, /TypeError|Cannot read|Figma matches/);
  }
});

test("verify CLI: a --snap that is not a snap fails saying so, not with a TypeError, as JSON under --json", () => {
  // The readback and snap swapped, snap's meta.json, a failed `snap --json`
  // captured as styles.json, or no components at all: each ended on
  // "snap.components is not iterable".
  const failed = { error: "Error: Failed to connect to Storybook MCP at http://localhost:6006/mcp: fetch failed" };
  for (const file of [{ version: 1, components: {} }, { measuredAt: READ_AT, components: 1 }, failed, { version: 1 }, null]) {
    const r = verify(file, readback(MATCHING), "--strict");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /snap output at \S+styles\.json has no "components" list, so it is not a styles\.json written by `storysync snap`: pass that as --snap, and the Figma readback as --readback\./);
    assert.doesNotMatch(r.out, /TypeError|not iterable|Figma matches/);
  }
  const r = verify(failed, readback(MATCHING), "--json");
  assert.equal(r.status, 1, r.out);
  const { error } = JSON.parse(r.out) as { error: string };
  assert.match(error, /has no "components" list[^]*It holds an error instead: Error: Failed to connect to Storybook MCP at http:\/\/localhost:6006\/mcp: fetch failed$/);
  // A snap with an empty list is a snap, which recorded no components.
  assert.match(verify(snap({ components: [] }), readback(MATCHING), "--strict").out, /snap recorded a failure: the snap recorded no components at all/);
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
  assert.match(r.out, /Forms\/Button a readback entry does not match its checksum, so it was edited, composed, or copied from another variant or component after Figma returned it — nothing in it was scored/);
  assert.match(r.out, /Read these variants back again[^\n]*exactly as returned/);
  assert.match(r.out, /Fidelity: n\/a \(0\/0 properties\) — 1 unverified readback entry excluded/);
  assert.doesNotMatch(r.out, /Figma matches/);
  const { checksum: _checksum, ...edited } = file.components["Forms/Button"].variants.a;
  assert.doesNotMatch(r.out, new RegExp(readbackChecksum("1:2", "a", edited).slice("fnv1a:".length)), "printed the checksum that would pass");
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
  const entry = readback(MATCHING).components["Forms/Button"].variants.a as Record<string, unknown>;
  const reordered = Object.fromEntries(Object.entries(entry).reverse());
  reordered.gap = { column: 6, row: 6 };
  const text = JSON.stringify({ components: { "Forms/Button": { variants: { a: reordered }, nodeId: "1:2" } }, version: 1 }, null, "\t");
  const r = verify(snap(), text, "--strict");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Figma matches the measured styles for Forms\/Button/);
});

/** The snap of two variants, `a` and `b`, measured alike. */
function snapOfTwo() {
  return snap({ summary: { components: 1, variants: 2, rendered: 2, failed: 0, componentsFailed: 0, componentsWithWarnings: 0 } }, {
    variants: [
      { combination: {}, slug: "a", status: "ok", error: null, delta: {} },
      { combination: {}, slug: "b", status: "ok", error: null, delta: {} },
    ],
  });
}

test("verify CLI: one variant sealed and matching beside one edited fails --strict on the edited one alone", () => {
  // The matching variant still scores, so the run compared something and
  // nothing drifted: the readback issue is the only thing left to fail it.
  const file = readbackOf({ a: MATCHING, b: { ...MATCHING, backgroundColor: "#ff00ff" } });
  file.components["Forms/Button"].variants.b.backgroundColor = "#2563eb";
  const r = verify(snapOfTwo(), file, "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Fidelity: 100\.0% \(12\/12 properties\) — 1 unverified readback entry excluded/);
  assert.match(r.out, /1 verified, 0 drifted, 0 missing from Figma, 1 with an unverified readback, across 2 variants/);
  assert.match(r.out, /Forms\/Button b readback entry does not match its checksum/);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: a component with no nodeId, or another set's, fails --strict", () => {
  const file = readbackOf({ a: MATCHING });
  delete file.components["Forms/Button"].nodeId;
  const r = verify(snap(), file, "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /readback entry has no nodeId on its component, the set's id its checksum is sealed under, so its checksum cannot be checked/);
  assert.doesNotMatch(r.out, /Figma matches/);
  file.components["Forms/Button"].nodeId = "9:9";
  assert.match(verify(snap(), file, "--strict").out, /readback entry does not match its checksum/);
});

test("verify CLI: a readback that leaves out the text fields and gap fails --strict as incomplete", () => {
  // The template returns them as null where Figma has nothing to report, so
  // one that leaves them out was cut down: it scored 100% before.
  const { fontSize: _size, fontWeight: _weight, fontFamily: _family, gap: _gap, ...rest } = MATCHING;
  const r = verify(snap(), readback(rest), "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /readback entry is incomplete: it lacks fontSize, fontWeight, fontFamily, gap, which the readback template always returns/);
  assert.doesNotMatch(r.out, /Figma matches/);
  // As null, on a variant snap measured no text on, and no gap, it passes.
  const bare = verify(snap({}, { base: { combination: {}, slug: "a", styles: { ...STYLES, gap: null } } }),
    readback({ ...MATCHING, color: null, fontSize: null, fontWeight: null, fontFamily: null, gap: null }), "--strict");
  assert.equal(bare.status, 0, bare.out);
  assert.match(bare.out, /Figma matches the measured styles for Forms\/Button/);
});

test("verify CLI: a component's entries copied onto another, nodeId and all, fail --strict on both", () => {
  const file = readbackOf({ a: MATCHING });
  const components = file.components as Record<string, { nodeId?: string; variants: Record<string, Record<string, unknown>> }>;
  components["Forms/Link"] = JSON.parse(JSON.stringify(components["Forms/Button"]));
  const r = verify(snap(), file, "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Forms\/Button a readback entry has a nodeId its component shares with Forms\/Link, though every component is read back from a set of its own, so one component's entries were copied onto another — nothing in it was scored/);
  assert.match(r.out, /Forms\/Link a readback entry has a nodeId its component shares with Forms\/Button/);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: a readback read before the snap fails --strict as stale, and one a few minutes before it passes", () => {
  // readAt is Figma's clock and measuredAt this machine's: a couple of
  // minutes either way is the clocks, an hour is an earlier run.
  const measured = Date.now() - 3_600_000;
  const measuredAt = new Date(measured).toISOString();
  const earlier = new Date(measured - 3_600_000).toISOString();
  const stale = verifyMeasuredAt(measuredAt, snap(), readback(MATCHING, { readAt: earlier }), "--strict");
  assert.equal(stale.status, 1, stale.out);
  assert.match(stale.out, new RegExp(`readback entry is stale: Figma read it at ${earlier}, before the snap was measured at ${measuredAt}, so it is from an earlier run — nothing in it was scored`));
  assert.match(stale.out, /Read these variants back again, after the snap,/);
  assert.doesNotMatch(stale.out, /Figma matches/);

  const skewed = verifyMeasuredAt(measuredAt, snap(), readback(MATCHING, { readAt: new Date(measured - 120_000).toISOString() }), "--strict");
  assert.equal(skewed.status, 0, skewed.out);
  assert.match(skewed.out, /Figma matches the measured styles for Forms\/Button/);

  const none = verify(snap(), readback(MATCHING, { readAt: null }), "--strict");
  assert.equal(none.status, 1, none.out);
  assert.match(none.out, /readback entry is stale: it has no readAt, so when Figma read it is unknown/);
});
