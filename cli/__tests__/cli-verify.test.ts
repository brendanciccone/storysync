// Runs the compiled `verify` command against fixture files, so the exit codes
// and printed verdicts are covered in CI — the acceptance suite checks the same
// behavior end to end, but needs a running Storybook and does not run there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readbackChecksum } from "../verify.js";
import type { ReadbackFile } from "../verify.js";
import { buildAndRead, buildFixture, newFigma, readBack, assemble } from "./tree-harness.js";
import { loadTreeFixture } from "./mock-figma.js";

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
  assert.match(r.out, /Fidelity: n\/a \(0\/0 properties\); 1 entry unverified, not scored/);
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
  // args_unsupported is expected for values Storybook cannot pass in a URL or
  // take through its preview; the skill builds those from source and labels
  // them inferred, which --strict-measured already fails. Failing --strict
  // too would make a correct run impossible to pass.
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
  assert.match(r.out, /Fidelity: n\/a \(0\/0 properties\); 1 entry unverified, not scored/);
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
  assert.match(r.out, /^Fidelity: 100\.0% of verified entries \(12\/12 properties\); 1 entry unverified, not scored$/m);
  assert.match(r.out, /1 verified, 0 drifted, 0 missing from Figma, 1 with an unverified readback, across 2 variants/);
  assert.match(r.out, /Forms\/Button b readback entry does not match its checksum/);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: without --strict, a score that left entries out says so on its own line, and a clean one doesn't", () => {
  // A falsification run read "Fidelity: 100.0%" with an entry failing its
  // checksum, and the run exited 0: the percentage alone read as a pass.
  const file = readbackOf({ a: MATCHING, b: MATCHING });
  file.components["Forms/Button"].variants.b.backgroundColor = "#ff00ff";
  const r = verify(snapOfTwo(), file);
  assert.equal(r.status, 0, r.out);
  const headline = r.out.split("\n").find((line) => line.startsWith("Fidelity:"));
  assert.equal(headline, "Fidelity: 100.0% of verified entries (12/12 properties); 1 entry unverified, not scored");

  const clean = verify(snapOfTwo(), readbackOf({ a: MATCHING, b: MATCHING }));
  assert.equal(clean.status, 0, clean.out);
  assert.equal(clean.out.split("\n").find((line) => line.startsWith("Fidelity:")), "Fidelity: 100.0% (24/24 properties)");
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

test("verify CLI: a push scored on a snap re-run for some components alone fails --strict, naming the rest", () => {
  // The push's timeout advice re-ran snap with --components, which wrote a
  // styles.json of those alone: verify --strict-age then scored the push at
  // 100% with a drifted Button left out.
  const card = snap({}, { name: "Card", title: "Forms/Card" });
  const button = readback({ ...MATCHING, backgroundColor: "#ff00ff" }).components["Forms/Button"];
  const cardEntry = readback(MATCHING).components["Forms/Button"];
  const r = verifyMeasuredAt("2026-10-01T11:59:00.000Z", card, { version: 1, components: { "Forms/Card": { ...cardEntry, nodeId: "1:2" }, "Forms/Button": { ...button, nodeId: "3:4", variants: { a: { ...button.variants.a, checksum: readbackChecksum("3:4", "a", { ...MATCHING, backgroundColor: "#ff00ff", readAt: READ_AT }) } } } } }, "--strict-age", "--max-age", "1000d");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /! Forms\/Button is in the readback but not in the snap, so none of it was scored: another snap run measured it, or none did\. Measure it into this snap with `snap --components "Forms\/Button" --merge`, or run the whole snap again\./);
  assert.doesNotMatch(r.out, /Figma matches/);
});

test("verify CLI: --skip leaves a component the user chose not to push out of --strict, and says so under the score", () => {
  // Skipped at the push's question about a closed trigger, the dialog stayed
  // in styles.json, and verify --strict failed on its variants as missing.
  const two = snap();
  two.components.push({ ...two.components[0], id: "ui-base-dialog", name: "Dialog", title: "ui/base/Dialog" } as never);
  const without = verify(two, readback(MATCHING), "--strict");
  assert.equal(without.status, 1, without.out);
  assert.match(without.out, /ui\/base\/Dialog a not found in Figma/);

  const r = verify(two, readback(MATCHING), "--strict", "--skip", "ui-base-dialog");
  assert.equal(r.status, 0, r.out);
  const lines = r.out.split("\n");
  const at = lines.findIndex((line) => line.startsWith("Fidelity: 100.0%"));
  assert.equal(lines[at + 1], "  Left out of the score, as --skip asked: ui/base/Dialog");
  assert.doesNotMatch(r.out, /not found in Figma/);

  const typo = verify(two, readback(MATCHING), "--strict", "--skip", "Dialgo");
  assert.equal(typo.status, 1, typo.out);
  assert.match(typo.out, /--skip matched no component named "Dialgo"/);
});

test("verify CLI: what snap warned about a scored component is said beside the score, and fails nothing", () => {
  const warning = "snap measured button[data-slot=\"dialog-trigger\"], a closed trigger, rather than Dialog. What it opens renders only while open.";
  const r = verify(
    snap({}, { warnings: [warning], variantProperties: [{ name: "size", type: "VARIANT", values: ["md"], defaultValue: "md", defaultAssumed: true }] }),
    readback(MATCHING), "--strict",
  );
  assert.equal(r.status, 0, r.out);
  const lines = r.out.split("\n");
  const at = lines.findIndex((line) => line.startsWith("Fidelity: 100.0%"));
  assert.deepEqual(lines.slice(at + 1, at + 4), [
    "  ! The score compares Figma with what snap measured, and snap warned about that for this component:",
    "      Forms/Button: snap measured button[data-slot=\"dialog-trigger\"], a closed trigger, so this scores the trigger, not what it opens",
    "      Forms/Button: Storybook's docs give no default for `size`, so the default variant in Figma is a guess",
  ]);
});

test("verify CLI: props that reach the component and change nothing measured are said as such, not as the story's fault", () => {
  const warning = "all 2 rendered variants measured identically, though their markup changed with the args, so the story passes them through: " +
    "`textAlign` changes nothing snap measures, likely only behavior, or something it doesn't measure, such as a child element. " +
    "If it doesn't change how it looks, leave it out of every component with `--exclude-props textAlign`, and build it as one variant.";
  const r = verify(snapOfTwo(), readbackOf({ a: MATCHING, b: MATCHING }));
  const withWarning = verify({ ...snapOfTwo(), components: [{ ...snapOfTwo().components[0], warnings: [warning] }] }, readbackOf({ a: MATCHING, b: MATCHING }));
  assert.match(r.out, /Forms\/Button: every variant measured the same, so the story may not pass its args through/);
  assert.equal(withWarning.status, 0, withWarning.out);
  assert.match(withWarning.out, /\n {6}Forms\/Button: every variant measured the same though the args reached it: `textAlign` changes nothing snap measures, so its variants in Figma look alike; `--exclude-props textAlign` leaves it out\n/);
  assert.doesNotMatch(withWarning.out, /story may not pass/);
});

test("verify CLI: variants Storybook wouldn't render are named beside the score as unmeasured, and fail --strict-measured", () => {
  // Storybook rendered its default for variant=link, as for a value outside
  // the story's options: snap measured nothing, so nothing may score it.
  const rejectedArgs = [{ name: "variant", value: "link", reasons: ["not-in-options"], options: ["default"] }];
  const twoVariants = snap({ summary: { components: 1, variants: 2, rendered: 1, failed: 1, componentsFailed: 0, componentsWithWarnings: 1 } }, {
    variants: [
      { combination: {}, slug: "a", status: "ok", error: null, delta: {} },
      { combination: {}, slug: "b", status: "arg_rejected", error: "Storybook didn't give the story variant=link", rejectedArgs },
    ],
  });
  const figma = readbackOf({ a: MATCHING, b: { ...MATCHING, source: "inferred" } });
  const r = verify(twoVariants, figma, "--strict");
  assert.equal(r.status, 0, r.out);
  const lines = r.out.split("\n");
  const at = lines.findIndex((line) => line.startsWith("Fidelity: 100.0%"));
  assert.deepEqual(lines.slice(at + 1, at + 3), [
    "  ! The score compares Figma with what snap measured, and snap warned about that for this component:",
    "      Forms/Button: Storybook wouldn't render variant=link, so snap didn't measure 1 variant and nothing here scored it; snap's warning names the story change that lets it",
  ]);
  assert.match(r.out, /Forms\/Button b \[unmeasured — written to Figma but never scored\]/);
  assert.equal(verify(twoVariants, figma, "--strict-measured").status, 1);
});

test("verify CLI: variants snap measured without checking their args are named beside the score, and fail --strict-measured", () => {
  // snap couldn't read Storybook's preview for b, so b may be the story's
  // default under its name: scored, but not as surely measured.
  const twoVariants = snap({ summary: { components: 1, variants: 2, rendered: 2, failed: 0, componentsFailed: 0, componentsWithWarnings: 1 } }, {
    variants: [
      { combination: {}, slug: "a", status: "ok", error: null, delta: {} },
      { combination: {}, slug: "b", status: "ok", error: null, delta: {}, argsChecked: false },
    ],
  });
  const figma = readbackOf({ a: MATCHING, b: MATCHING });
  const r = verify(twoVariants, figma, "--strict");
  assert.equal(r.status, 0, r.out);
  // Under the score, beside the caveat that a and b measured the same.
  const lines = r.out.split("\n");
  const at = lines.findIndex((line) => line.startsWith("Fidelity: 100.0%"));
  assert.equal(lines[at + 1], "  ! The score compares Figma with what snap measured, and snap warned about that for this component:");
  assert.deepEqual(lines.slice(at + 2, at + 4).filter((line) => line.includes("couldn't check")), [
    "      Forms/Button: snap couldn't check that Storybook gave the story the values of variant b, so it may have scored the story's default under its name; measure the component again",
  ]);
  assert.equal(verify(twoVariants, figma, "--strict-measured").status, 1);
});

test("verify CLI: a component snap measured again holds its readback to that time, the rest to theirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-verify-"));
  try {
    const two = snap();
    two.components.push({ ...two.components[0], name: "Card", title: "Forms/Card" });
    writeFileSync(join(dir, "styles.json"), JSON.stringify(two));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      measuredAt: "2026-10-01T11:00:00.000Z",
      componentsMeasuredAt: { "Forms/Button": "2026-10-01T11:00:00.000Z", "Forms/Card": "2026-10-01T13:00:00.000Z" },
    }));
    const button = readback(MATCHING).components["Forms/Button"];
    const card = { ...button, nodeId: "3:4", variants: { a: { ...MATCHING, readAt: READ_AT, checksum: readbackChecksum("3:4", "a", { ...MATCHING, readAt: READ_AT }) } } };
    writeFileSync(join(dir, "readback.json"), JSON.stringify({ version: 1, components: { "Forms/Button": button, "Forms/Card": card } }));
    const r = spawnSync(process.execPath, [CLI, "verify", "--snap", join(dir, "styles.json"), "--readback", join(dir, "readback.json"), "--strict", "--max-age", "1000d"], { encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
    assert.equal(r.status, 1, out);
    assert.match(out, /Forms\/Card a readback entry is stale: Figma read it at 2026-10-01T12:00:00\.000Z, before the snap was measured at 2026-10-01T13:00:00\.000Z/);
    assert.doesNotMatch(out, /Forms\/Button a readback entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify CLI: a field bound to no variable though one has its value is named beside the score, and fails nothing", () => {
  // A token detached in Figma keeps its value, so the values alone scored a
  // detached radius 100%.
  const file = readbackOf({
    a: { ...MATCHING, textLayout: null, bound: { backgroundColor: "primary", borderRadiusUniform: "radius/sm" }, unbound: [] },
    b: { ...MATCHING, textLayout: null, bound: { backgroundColor: "primary" }, unbound: ["borderRadiusUniform"] },
  });
  const r = verify(snapOfTwo(), file, "--strict");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\n {2}Variables: 3 fields bound across 2 variants\n {2}! Bound to no variable, though a variable of its kind has the value: a token detached in Figma, or one the push left unbound \(its summary says which\):\n {6}Forms\/Button borderRadiusUniform, on 1 variant\n/);

  // A readback from an earlier template says nothing of bindings, and still scores.
  const older = verify(snapOfTwo(), readbackOf({ a: MATCHING, b: MATCHING }), "--strict");
  assert.equal(older.status, 0, older.out);
  assert.match(older.out, /Variables: this readback doesn't say what is bound, so a token detached in Figma at the same value can't be seen/);
});

test("verify CLI: a text layout snap measured, against a readback without textLayout, is said beside the score and fails --strict", () => {
  // A readback from a template before textLayout, or an older skill beside
  // a newer CLI, scored a title that runs past its card 100%, said Figma
  // matched, and passed --strict.
  const text = { color: "#ffffff", fontFamily: "Inter", fontSize: 12, fontWeight: 600, layout: { width: 40, lines: 1, truncation: "ellipsis" } };
  const cut = snapOfTwo();
  cut.components[0].base = { combination: {}, slug: "a", styles: { ...STYLES, text } as never };
  const older = readbackOf({ a: MATCHING, b: MATCHING });
  const strict = verify(cut, older, "--strict");
  assert.equal(strict.status, 1, strict.out);
  assert.match(strict.out, /Fidelity: 100\.0%/);
  assert.match(strict.out, /\n {2}! Not compared, since the readback has no textLayout[^\n]*\n {6}Forms\/Button, 2 variants\n/);
  assert.doesNotMatch(strict.out, /Figma matches/);
  assert.equal(verify(cut, older).status, 0, "a score, not a failure, without --strict");

  // Read with the template as it is, it is compared, and passes.
  const current = readbackOf({ a: { ...MATCHING, textLayout: { width: 40, maxLines: 1 }, bound: {}, unbound: [] }, b: { ...MATCHING, textLayout: { width: 40, maxLines: 1 }, bound: {}, unbound: [] } });
  const passed = verify(cut, current, "--strict");
  assert.equal(passed.status, 0, passed.out);
  assert.doesNotMatch(passed.out, /Not compared/);
  assert.match(passed.out, /Figma matches the measured styles for Forms\/Button\./);

  // Where snap measured no layout, an older readback is compared on all it has.
  const plain = verify(snapOfTwo(), older, "--strict");
  assert.equal(plain.status, 0, plain.out);
  assert.doesNotMatch(plain.out, /Not compared/);
});


// --- Element trees ---------------------------------------------------------------

test("verify CLI: a tree snap is scored by elements, a faithful build passes --strict and says so", async () => {
  const { fixture, readback } = await buildAndRead("switch");
  const r = verify(fixture, readback, "--strict");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Fidelity: 100\.0% of elements \(4 of 4 verified\), 100\.0% of properties \(\d+\/\d+\)/);
  assert.match(r.out, /missing 0 · drifted 0 · extra 0 · designer layers 0 · not measured 0/);
  assert.match(r.out, /Figma matches the measured styles for ui\/base\/Switch/);
  assert.doesNotMatch(r.out, /only the outer element/);
  assert.doesNotMatch(r.out, /Variables: this readback doesn't say/);
  const json = JSON.parse(verify(fixture, readback, "--json").out);
  assert.equal(json.elementFidelity, 1);
  assert.equal(json.summary.elements.measured, 4);
});

test("verify CLI: an element missing, or a designer's layer, fails --strict and is named by key and node", async () => {
  const ctx = await buildAndRead("switch");
  const thumb = ctx.built.variants[1].layers["switch-thumb"];
  await ctx.figma.run(`(await figma.getNodeByIdAsync(${JSON.stringify(thumb)})).remove();
    const v = await figma.getNodeByIdAsync(${JSON.stringify(ctx.built.variants[0].id)}); const r = figma.createRectangle(); r.name = 'Note'; v.appendChild(r);`);
  const again = assemble(await readBack(ctx.figma, [[ctx.built.component, 0, 1, 0]]));
  const r = verify(ctx.fixture, again, "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Fidelity: 75\.0% of elements \(3 of 4 verified\)/);
  assert.match(r.out, /- ui\/base\/Switch size=sm › switch-thumb: missing from Figma/);
  assert.match(r.out, /\? ui\/base\/Switch size=default: a layer nothing keyed, "Note" \(RECTANGLE, node \d+:\d+\): a designer's, not scored/);
  assert.doesNotMatch(r.out, /Figma matches/);
  assert.equal(verify(ctx.fixture, again).status, 0, "a score, not a failure, without --strict");
});

test("verify CLI: a readback from before trees against a tree snap fails --strict, its roots still scored", async () => {
  const { fixture, readback } = await buildAndRead("switch");
  const v1 = JSON.parse(JSON.stringify(readback)) as ReadbackFile;
  for (const entry of Object.values(v1.components)) {
    for (const [slug, e] of Object.entries(entry.variants)) {
      const { tpl: _t, name: _n, built: _b, tree: _tr, designerLayers: _d, boxShadow: _s, checksum: _c, ...rest } = e;
      entry.variants[slug] = { ...rest, checksum: readbackChecksum(entry.nodeId!, slug, rest) };
    }
  }
  const r = verify(fixture, v1, "--strict");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not read back 2/);
  assert.match(r.out, /ui\/base\/Switch size-sm: read back without its tree, so only its root was compared/);
});

test("verify CLI: placeholders for variants snap couldn't measure fail --strict-measured, not --strict", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("button-icon");
  const built = await buildFixture(figma, fixture);
  const readback = assemble(await readBack(figma, [[built.component, 0, fixture.components[0].variants.length - 1, 0]]));
  const strict = verify(fixture, readback, "--strict");
  assert.match(strict.out, /not measured 2/);
  assert.match(strict.out, /\? ui\/base\/Button variant=link, size=xs: not measured, so Figma holds a placeholder for it/);
  assert.equal(verify(fixture, readback, "--strict-measured").status, 1);
});

test("verify CLI: a variant in Figma's set no read covered is named under provenance, and fails --strict-measured, not --strict", async () => {
  const figma = newFigma();
  const fixture = loadTreeFixture("switch");
  const built = await buildFixture(figma, fixture);
  await figma.run(`const set = await figma.getNodeByIdAsync(${JSON.stringify(built.id)}); const c = figma.createComponent(); c.name = 'size=xl'; set.appendChild(c);`);
  const resnap = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
  resnap.components[0].variants = resnap.components[0].variants.filter((v) => v.slug === "size-default");
  const readback = assemble(await readBack(figma, [[built.component, 0, 0, 0]]));
  const strict = verify(resnap, readback, "--strict");
  assert.equal(strict.status, 0, strict.out);
  assert.match(strict.out, /Provenance: 2 in Figma's sets that no read covered/);
  assert.match(strict.out, /ui\/base\/Switch size=xl \[not built by storysync — in Figma's set but never scored\]/);
  assert.match(strict.out, /ui\/base\/Switch: 1 variant carries a slug no read covered \[built by an earlier push for a variant snap no longer measures — never scored\]/);
  assert.match(strict.out, /Figma matches the expected styles/, "not all of it measured, so not \"measured\"");
  assert.equal(verify(resnap, readback, "--strict-measured").status, 1);
});
