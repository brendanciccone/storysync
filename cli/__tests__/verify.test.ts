import { test } from "node:test";
import assert from "node:assert/strict";
import { verify, verifyVariant, propertyMatches, expandSnap, formatFidelity, parseDuration, formatAge, readSnapAge } from "../verify.js";
import type { ReadbackFile } from "../verify.js";
import type { NormalizedStyles } from "../snap-normalize.js";
import type { SnapResult } from "../snap.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE: NormalizedStyles = {
  display: "inline-flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "normal",
  gap: { row: 6, column: 6 },
  width: 61.5,
  height: 24,
  backgroundColor: "#2563eb",
  color: "#ffffff",
  border: null,
  borderUniform: null,
  borderRadius: { topLeft: 3, topRight: 3, bottomRight: 3, bottomLeft: 3 },
  borderRadiusUniform: 3,
  padding: { top: 4, right: 8, bottom: 4, left: 8 },
  fontFamily: "Helvetica",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: "normal",
  letterSpacing: 0,
  boxShadow: [],
  opacity: 1,
  text: null,
  boxSizing: "content-box",
  fontAvailable: true,
};

function snapWith(variants: { slug: string; delta?: Record<string, unknown>; status?: string }[]): SnapResult {
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
      base: { combination: {}, slug: variants[0].slug, styles: BASE },
      variants: variants.map((v) => ({
        combination: {}, slug: v.slug, status: (v.status ?? "ok") as never,
        error: null, delta: v.delta ?? {},
      })),
      warnings: [],
      error: null,
    }],
    summary: {
      components: 1, variants: variants.length, rendered: variants.length,
      failed: 0, componentsFailed: 0, componentsWithWarnings: 0,
    },
  } as unknown as SnapResult;
}

function readbackWith(variants: Record<string, Record<string, unknown>>): ReadbackFile {
  return { version: 1, components: { "Forms/Button": { nodeId: "1:2", variants: variants as never } } };
}

// --- propertyMatches ---

test("propertyMatches: colors compare case-insensitively", () => {
  assert.equal(propertyMatches("backgroundColor", "#2563eb", "#2563EB", 0.5), true);
  assert.equal(propertyMatches("backgroundColor", "#2563eb", "#dc2626", 0.5), false);
  assert.equal(propertyMatches("backgroundColor", null, null, 0.5), true);
  assert.equal(propertyMatches("backgroundColor", null, "#000000", 0.5), false);
});

test("propertyMatches: lengths honour the tolerance", () => {
  assert.equal(propertyMatches("fontSize", 12, 12.3, 0.5), true);
  assert.equal(propertyMatches("fontSize", 12, 13, 0.5), false);
  assert.equal(propertyMatches("borderRadiusUniform", 3, 3, 0), true);
});

test("propertyMatches: font weight is exact, family case-insensitive", () => {
  assert.equal(propertyMatches("fontWeight", 600, 600, 0.5), true);
  assert.equal(propertyMatches("fontWeight", 600, 700, 5), false);
  assert.equal(propertyMatches("fontFamily", "Helvetica", "helvetica", 0.5), true);
});

test("propertyMatches: padding compares each side", () => {
  const p = { top: 4, right: 8, bottom: 4, left: 8 };
  assert.equal(propertyMatches("padding", p, { ...p }, 0.5), true);
  assert.equal(propertyMatches("padding", p, { ...p, left: 24 }, 0.5), false);
});

test("propertyMatches: shadows compare layer by layer", () => {
  const layer = { offsetX: 0, offsetY: 1, blur: 2, spread: 0, color: "#0000001a", inset: false };
  assert.equal(propertyMatches("boxShadow", [layer], [{ ...layer }], 0.5), true);
  assert.equal(propertyMatches("boxShadow", [layer], [], 0.5), false);
  assert.equal(propertyMatches("boxShadow", [], [], 0.5), true);
  assert.equal(propertyMatches("boxShadow", [layer], [{ ...layer, blur: 9 }], 0.5), false);
});

test("propertyMatches: borders compare width and colour", () => {
  const b = { width: 2, style: "solid", color: "#9ca3af" };
  assert.equal(propertyMatches("borderUniform", b, { ...b }, 0.5), true);
  assert.equal(propertyMatches("borderUniform", b, { ...b, width: 4 }, 0.5), false);
  assert.equal(propertyMatches("borderUniform", null, null, 0.5), true);
});

// --- verifyVariant ---

test("verifyVariant: an exact match verifies", () => {
  const v = verifyVariant("Forms/Button", "default", BASE, {
    backgroundColor: "#2563eb", fontSize: 12, padding: { top: 4, right: 8, bottom: 4, left: 8 },
  }, 0.5);
  assert.equal(v.status, "verified");
  assert.equal(v.matched, 3);
  assert.equal(v.mismatched, 0);
});

test("verifyVariant: reports each drifted property", () => {
  const v = verifyVariant("Forms/Button", "default", BASE, {
    backgroundColor: "#ff0000", fontSize: 12, borderRadiusUniform: 99,
  }, 0.5);
  assert.equal(v.status, "drifted");
  assert.equal(v.matched, 1);
  assert.equal(v.mismatched, 2);
  assert.deepEqual(v.differences.map((d) => d.property).sort(), ["backgroundColor", "borderRadiusUniform"]);
});

// Figma cannot express everything getComputedStyle reports, so an absent
// property must not be scored as a mismatch.
test("verifyVariant: properties absent from the readback are not compared", () => {
  const v = verifyVariant("Forms/Button", "default", BASE, { backgroundColor: "#2563eb" }, 0.5);
  assert.equal(v.matched, 1);
  assert.equal(v.mismatched, 0);
  assert.equal(v.status, "verified");
});

test("verifyVariant: a variant absent from Figma is flagged, not scored", () => {
  const v = verifyVariant("Forms/Button", "default", BASE, undefined, 0.5);
  assert.equal(v.status, "missing_from_figma");
  assert.equal(v.matched, 0);
  assert.equal(v.mismatched, 0);
});

// --- expandSnap ---

test("expandSnap: rebuilds each variant from base plus delta", () => {
  const expanded = expandSnap(snapWith([
    { slug: "primary" },
    { slug: "danger", delta: { backgroundColor: "#dc2626" } },
  ]));
  const button = expanded.get("Forms/Button")!;
  assert.equal(button.get("primary")!.backgroundColor, "#2563eb");
  assert.equal(button.get("danger")!.backgroundColor, "#dc2626");
  // Untouched fields carry through from the base.
  assert.equal(button.get("danger")!.fontSize, 12);
});

test("expandSnap: skips variants that were never measured", () => {
  const expanded = expandSnap(snapWith([
    { slug: "primary" },
    { slug: "broken", status: "render_error" },
  ]));
  assert.deepEqual([...expanded.get("Forms/Button")!.keys()], ["primary"]);
});

// --- verify ---

test("verify: a perfect match scores 100%", () => {
  const result = verify(
    snapWith([{ slug: "primary" }]),
    readbackWith({ primary: { backgroundColor: "#2563eb", fontSize: 12 } }),
    0.5,
  );
  assert.equal(result.fidelity, 1);
  assert.equal(result.summary.verified, 1);
  assert.equal(result.summary.drifted, 0);
});

test("verify: fidelity is the share of properties that matched", () => {
  const result = verify(
    snapWith([{ slug: "primary" }]),
    readbackWith({ primary: { backgroundColor: "#ff0000", fontSize: 12, fontWeight: 600, opacity: 1 } }),
    0.5,
  );
  assert.equal(result.summary.propertiesCompared, 4);
  assert.equal(result.summary.propertiesMatched, 3);
  assert.equal(result.fidelity, 0.75);
  assert.equal(result.summary.drifted, 1);
});

test("verify: deltas are applied before comparing", () => {
  // The danger variant differs from base only by background, and Figma agrees.
  const result = verify(
    snapWith([{ slug: "primary" }, { slug: "danger", delta: { backgroundColor: "#dc2626" } }]),
    readbackWith({
      primary: { backgroundColor: "#2563eb" },
      danger: { backgroundColor: "#dc2626" },
    }),
    0.5,
  );
  assert.equal(result.fidelity, 1);
  assert.equal(result.summary.verified, 2);
});

test("verify: variants Figma never received are reported separately", () => {
  const result = verify(
    snapWith([{ slug: "primary" }, { slug: "danger", delta: { backgroundColor: "#dc2626" } }]),
    readbackWith({ primary: { backgroundColor: "#2563eb" } }),
    0.5,
  );
  assert.equal(result.summary.missingFromFigma, 1);
  assert.equal(result.summary.verified, 1);
  // A missing variant must not drag the score down; it is a different problem.
  assert.equal(result.fidelity, 1);
});

test("verify: nothing comparable yields a null score rather than a fake one", () => {
  const result = verify(snapWith([{ slug: "primary" }]), { version: 1, components: {} }, 0.5);
  assert.equal(result.fidelity, null);
  assert.equal(result.summary.missingFromFigma, 1);
});

test("formatFidelity: renders a percentage, or n/a", () => {
  assert.equal(formatFidelity(1), "100.0%");
  assert.equal(formatFidelity(0.9412), "94.1%");
  assert.equal(formatFidelity(null), "n/a");
});

// --- snap age ---

test("parseDuration: accepts common units and defaults to minutes", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("7d"), 604_800_000);
  assert.equal(parseDuration("45"), 2_700_000);
  assert.equal(parseDuration(" 2h "), 7_200_000);
});

test("parseDuration: rejects nonsense", () => {
  for (const bad of ["abc", "2y", "", "-5m", "2 hours"]) {
    assert.equal(parseDuration(bad), null, `"${bad}" should not parse`);
  }
});

test("formatAge: scales the unit to the magnitude", () => {
  assert.equal(formatAge(5_000), "5s");
  assert.equal(formatAge(120_000), "2m");
  assert.equal(formatAge(9_000_000), "2.5h");
  assert.equal(formatAge(172_800_000), "2.0d");
});

// --- readSnapAge ---

function snapDir(meta?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "storysync-age-"));
  writeFileSync(join(dir, "styles.json"), "{}");
  if (meta !== undefined) writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return dir;
}

const NOW = Date.parse("2026-03-04T12:00:00.000Z");

test("readSnapAge: reports age from a well-formed sidecar", () => {
  const dir = snapDir({ measuredAt: "2026-03-04T11:00:00.000Z", storybookUrl: "http://localhost:6006" });
  try {
    const age = readSnapAge(join(dir, "styles.json"), 2 * 3_600_000, NOW);
    assert.equal(age.known, true);
    assert.equal(age.known && age.ageMs, 3_600_000);
    assert.equal(age.known && age.storybookUrl, "http://localhost:6006");
    assert.equal(age.known && age.stale, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSnapAge: marks a snap past the limit stale", () => {
  const dir = snapDir({ measuredAt: "2026-03-04T06:00:00.000Z" });
  try {
    const age = readSnapAge(join(dir, "styles.json"), 2 * 3_600_000, NOW);
    assert.equal(age.known && age.stale, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// meta.json is the file a consuming project is most likely to gitignore, so an
// absent sidecar must read as "unknown", never as "fresh".
test("readSnapAge: a missing sidecar is unknown, not fresh", () => {
  const dir = snapDir();
  try {
    const age = readSnapAge(join(dir, "styles.json"), 2 * 3_600_000, NOW);
    assert.equal(age.known, false);
    assert.match(age.known === false ? age.reason : "", /no meta\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSnapAge: malformed sidecars are unknown, with a reason", () => {
  for (const [meta, pattern] of [
    [{}, /no measuredAt/],
    [{ measuredAt: "" }, /no measuredAt/],
    [{ measuredAt: 12345 }, /no measuredAt/],
    [{ measuredAt: "not-a-date" }, /unparseable measuredAt/],
  ] as const) {
    const dir = snapDir(meta);
    try {
      const age = readSnapAge(join(dir, "styles.json"), 2 * 3_600_000, NOW);
      assert.equal(age.known, false, `${JSON.stringify(meta)} should be unknown`);
      assert.match(age.known === false ? age.reason : "", pattern);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// Clamping a future date to "0s ago" would report a skewed clock as maximally
// fresh — the wrong way to be wrong.
test("readSnapAge: a future measuredAt is unknown, not maximally fresh", () => {
  const dir = snapDir({ measuredAt: "2026-03-04T21:00:00.000Z" });
  try {
    const age = readSnapAge(join(dir, "styles.json"), 2 * 3_600_000, NOW);
    assert.equal(age.known, false);
    assert.match(age.known === false ? age.reason : "", /in the future/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSnapAge: tolerates trivial clock skew", () => {
  const dir = snapDir({ measuredAt: "2026-03-04T12:00:10.000Z" }); // 10s ahead
  try {
    const age = readSnapAge(join(dir, "styles.json"), 2 * 3_600_000, NOW);
    assert.equal(age.known, true);
    assert.equal(age.known && age.ageMs, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSnapAge: no limit means never stale", () => {
  const dir = snapDir({ measuredAt: "2020-01-01T00:00:00.000Z" });
  try {
    const age = readSnapAge(join(dir, "styles.json"), null, NOW);
    assert.equal(age.known && age.stale, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- provenance ---

test("verifyVariant: records the writer's declared source", () => {
  const measured = verifyVariant("C", "s", BASE, { source: "measured", fontSize: 12 }, 0.5);
  assert.equal(measured.source, "measured");
  const inferred = verifyVariant("C", "s", BASE, { source: "inferred", fontSize: 12 }, 0.5);
  assert.equal(inferred.source, "inferred");
});

// "It produced a result" and "it produced a measured result" must not look the
// same, so an absent marker is its own state rather than an optimistic default.
test("verifyVariant: an absent source is unrecorded, not measured", () => {
  const v = verifyVariant("C", "s", BASE, { fontSize: 12 }, 0.5);
  assert.equal(v.source, "unrecorded");
});

test("verifyVariant: a nonsense source value is unrecorded", () => {
  const v = verifyVariant("C", "s", BASE, { source: "vibes", fontSize: 12 } as never, 0.5);
  assert.equal(v.source, "unrecorded");
});

test("verifyVariant: source is not scored as a style property", () => {
  // `source` sits alongside the styles, so it must not inflate the denominator.
  const v = verifyVariant("C", "s", BASE, { source: "measured", fontSize: 12 }, 0.5);
  assert.equal(v.matched, 1);
  assert.equal(v.mismatched, 0);
});

test("verify: counts inferred and unrecorded variants separately", () => {
  const result = verify(
    snapWith([
      { slug: "a" },
      { slug: "b", delta: { backgroundColor: "#dc2626" } },
      { slug: "c", delta: { backgroundColor: "#10b981" } },
    ]),
    readbackWith({
      a: { source: "measured", backgroundColor: "#2563eb" },
      b: { source: "inferred", backgroundColor: "#dc2626" },
      c: { backgroundColor: "#10b981" },
    }),
    0.5,
  );
  assert.equal(result.summary.inferred, 1);
  assert.equal(result.summary.unrecorded, 1);
  // Provenance is orthogonal to correctness: all three still match.
  assert.equal(result.fidelity, 1);
  assert.equal(result.summary.verified, 3);
});

test("verify: a variant missing from Figma is not also counted as unrecorded", () => {
  const result = verify(
    snapWith([{ slug: "a" }, { slug: "b", delta: { backgroundColor: "#dc2626" } }]),
    readbackWith({ a: { source: "measured", backgroundColor: "#2563eb" } }),
    0.5,
  );
  assert.equal(result.summary.missingFromFigma, 1);
  assert.equal(result.summary.unrecorded, 0);
});

// --- geometry ---

// Auto-layout derives size from font metrics and padding, and Figma rounds text
// advance to whole pixels where the browser reports fractions.
test("propertyMatches: geometry tolerates sub-pixel text rounding", () => {
  assert.equal(propertyMatches("width", 54.19, 55, 0.5), true);
  assert.equal(propertyMatches("height", 23.4, 23, 0.5), true);
});

test("propertyMatches: geometry still catches a real mismatch", () => {
  // The overlapping-variants failure: a box never grown to fit its contents.
  assert.equal(propertyMatches("width", 220, 55, 0.5), false);
  assert.equal(propertyMatches("height", 23, 120, 0.5), false);
});

test("propertyMatches: an explicit tolerance above the floor is honoured", () => {
  assert.equal(propertyMatches("width", 55, 58, 0.5), false);
  assert.equal(propertyMatches("width", 55, 58, 4), true);
});

test("verify: geometry participates in the score when the readback reports it", () => {
  const result = verify(
    snapWith([{ slug: "primary" }]),
    readbackWith({ primary: { source: "measured", width: 61.5, height: 24 } }),
    0.5,
  );
  assert.equal(result.summary.propertiesCompared, 2);
  assert.equal(result.fidelity, 1);
});

// --- unmeasured Figma content ---

// The mirror of missing_from_figma. Without this, snap failing for a whole
// component and the agent inferring it wholesale produces a readback entry
// nothing scores — and a run that reports a clean match.
test("verify: reports readback components snap never measured", () => {
  const result = verify(
    snapWith([{ slug: "a" }]),
    {
      version: 1,
      components: {
        "Forms/Button": { variants: { a: { source: "measured", backgroundColor: "#2563eb" } } as never },
        "Forms/Ghost": { variants: { z: { source: "measured", backgroundColor: "#ff0000" } } as never },
      },
    },
    0.5,
  );
  assert.equal(result.summary.unmeasured, 1);
  assert.deepEqual(result.unmeasuredInFigma, [{ component: "Forms/Ghost", slug: "z" }]);
});

test("verify: reports individual variant slugs snap never measured", () => {
  const result = verify(
    snapWith([{ slug: "a" }]),
    readbackWith({
      a: { source: "measured", backgroundColor: "#2563eb" },
      typo: { source: "measured", backgroundColor: "#2563eb" },
    }),
    0.5,
  );
  assert.equal(result.summary.unmeasured, 1);
  assert.deepEqual(result.unmeasuredInFigma, [{ component: "Forms/Button", slug: "typo" }]);
});

test("verify: a fully matched readback reports nothing unmeasured", () => {
  const result = verify(
    snapWith([{ slug: "a" }]),
    readbackWith({ a: { source: "measured", backgroundColor: "#2563eb" } }),
    0.5,
  );
  assert.equal(result.summary.unmeasured, 0);
  assert.deepEqual(result.unmeasuredInFigma, []);
});
