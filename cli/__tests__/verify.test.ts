import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verify, verifyVariant, propertyMatches, expandSnap, formatFidelity, parseDuration, formatAge, readSnapAge, hasIntrinsicSize,
  canonicalJson, fnv1a32, readbackChecksum, checkReadback, missingReadbackFields, READBACK_FIELDS, READ_AT_SKEW_MS,
} from "../verify.js";
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

/** When the readbacks in these tests were read, unless one says otherwise. */
const READ_AT = "2026-10-01T12:00:00.000Z";

/**
 * What the readback template returns for a faithful copy of BASE, which has
 * a text child and auto layout: every field it can return, so every one of
 * them is compared.
 */
const FAITHFUL: Record<string, unknown> = {
  source: "measured", backgroundColor: "#2563eb", color: "#ffffff", borderRadiusUniform: 3,
  padding: { top: 4, right: 8, bottom: 4, left: 8 }, borderUniform: null,
  fontSize: 12, fontWeight: 600, fontFamily: "Helvetica", gap: { row: 6, column: 6 },
  opacity: 1, width: 61.5, height: 24, readAt: READ_AT,
};

/**
 * `entry` filled out with FAITHFUL's fields it does not set, as the template
 * would return it: a field set to undefined is left out, as JSON leaves it.
 */
function complete(entry: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...FAITHFUL, ...entry }));
}

/** Each entry with the checksum the readback template gives it under `setId`, as if Figma had returned it. */
function sealed(variants: Record<string, Record<string, unknown>>, setId = "1:2"): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(variants).map(([slug, entry]) => [slug, { ...entry, checksum: readbackChecksum(setId, slug, entry) }]));
}

/**
 * A readback of one component, each entry completed as the template would
 * return it unless `whole` is false, and sealed unless `seal` is false.
 */
function readbackWith(variants: Record<string, Record<string, unknown>>, { seal = true, whole = true } = {}): ReadbackFile {
  const entries = whole ? Object.fromEntries(Object.entries(variants).map(([slug, entry]) => [slug, complete(entry)])) : variants;
  return { version: 1, components: { "Forms/Button": { nodeId: "1:2", variants: (seal ? sealed(entries) : entries) as never } } };
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

// Variants are keyed by slug, so two sharing one would collapse — and because
// the lost variant leaves the denominator too, the score would read *higher*
// for having measured less. `assignVariantSlugs` is what keeps them apart; this
// pins the property expandSnap depends on.
test("expandSnap: distinct slugs each survive into the map", () => {
  const expanded = expandSnap(snapWith([
    { slug: "size-small" },
    { slug: "size-small--2", delta: { fontSize: 18 } },
  ]));
  const button = expanded.get("Forms/Button")!;
  assert.equal(button.size, 2);
  assert.equal(button.get("size-small")!.fontSize, 12);
  assert.equal(button.get("size-small--2")!.fontSize, 18);
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
  // Every one of the template's twelve comparable properties, one of them wrong.
  const result = verify(
    snapWith([{ slug: "primary" }]),
    readbackWith({ primary: { backgroundColor: "#ff0000" } }),
    0.5,
  );
  assert.equal(result.summary.propertiesCompared, 12);
  assert.equal(result.summary.propertiesMatched, 11);
  assert.equal(result.fidelity, 11 / 12);
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
      c: { source: undefined, backgroundColor: "#10b981" },
    }),
    0.5,
  );
  assert.equal(result.summary.inferred, 1);
  assert.equal(result.summary.unrecorded, 1);
  // Provenance is orthogonal to correctness: both that record it still match.
  assert.equal(result.fidelity, 1);
  assert.equal(result.summary.verified, 2);
  // The template always returns source, so an entry without it was not read
  // with the template as it is, and is not scored either.
  assert.deepEqual(result.readbackIssues, [{ component: "Forms/Button", slug: "c", problem: "incomplete", missing: ["source"] }]);
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
    readbackWith({ primary: { source: "measured", width: 120, height: 24 } }),
    0.5,
  );
  assert.deepEqual(result.variants[0].differences.map((d) => d.property), ["width"]);
  assert.equal(result.summary.drifted, 1);
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

// --- geometry meaningfulness and tolerance ---

// A block element fills its container, so the browser reports the viewport
// width — 1248px for a component that renders 30px wide. Comparing that would
// flag every card, row and layout wrapper in a real design system.
test("hasIntrinsicSize: only shrink-to-fit displays have a comparable size", () => {
  for (const d of ["inline", "inline-block", "inline-flex", "inline-grid", "table"]) {
    assert.equal(hasIntrinsicSize(d), true, `${d} should be comparable`);
  }
  for (const d of ["block", "flex", "grid", "flow-root", "", undefined]) {
    assert.equal(hasIntrinsicSize(d), false, `${d} should not be comparable`);
  }
});

test("verify: geometry is skipped for block elements", () => {
  const snap = snapWith([{ slug: "a", delta: { display: "block", width: 1248 } }]);
  const result = verify(snap, readbackWith({ a: { source: "measured", width: 30, height: 24 } }), 0.5);
  // Width and height dropped out of the twelve; the rest match.
  assert.equal(result.summary.propertiesCompared, 10);
  assert.equal(result.variants[0].status, "verified");
});

test("verify: geometry is compared for inline-flex elements", () => {
  const result = verify(
    snapWith([{ slug: "a" }]),
    readbackWith({ a: { source: "measured", width: 30, height: 24 } }),
    0.5,
  );
  assert.equal(result.summary.propertiesCompared, 12);
  assert.deepEqual(result.variants[0].differences.map((d) => d.property), ["width"]);
});

// Figma re-lays out text with its own metrics, so disagreement scales with size
// rather than staying in a sub-pixel band.
test("propertyMatches: geometry tolerance scales with the dimension", () => {
  assert.equal(propertyMatches("width", 54.19, 55, 0.5), true);      // 0.81px at ~55
  assert.equal(propertyMatches("width", 58.19, 57, 0.5), true);      // 1.19px at ~58
  assert.equal(propertyMatches("width", 105.28, 107, 0.5), true);    // 1.72px at ~107
});

test("propertyMatches: geometry still catches a real mismatch at every scale", () => {
  assert.equal(propertyMatches("width", 55, 107, 0.5), false);
  assert.equal(propertyMatches("height", 23, 46, 0.5), false);
  assert.equal(propertyMatches("width", 30, 1248, 0.5), false);
});

// --- an absent measurement must not read as a passing one ---

test("verifyVariant: a variant Figma reports with no comparable property is unscored, not verified", () => {
  // Only properties the readback volunteers are compared, so a writer that
  // reports nothing would otherwise choose its own denominator and score a
  // perfect nothing. This is the default failure mode, not an attack: a plugin
  // read that came back empty still yields `{ source: "measured" }`.
  const v = verifyVariant("Forms/Button", "a", BASE, { source: "measured" }, 0.5);
  assert.equal(v.status, "unscored");
  assert.equal(v.matched + v.mismatched, 0);
});

test("verify: a sealed entry with no comparable property is incomplete, so nothing is scored", () => {
  // Through verify, the same entry lacks every field the template always
  // returns but source, so it is not scored at all, rather than unscored.
  const result = verify(snapWith([{ slug: "a" }]), readbackWith({ a: { source: "measured", readAt: READ_AT } }, { whole: false }), 0.5);
  assert.deepEqual(result.readbackIssues, [{
    component: "Forms/Button", slug: "a", problem: "incomplete",
    missing: ["backgroundColor", "color", "borderRadiusUniform", "padding", "borderUniform", "opacity", "width", "height"],
  }]);
  assert.equal(result.variants[0].status, "unverified_readback");
  assert.equal(result.summary.verified, 0);
  assert.equal(result.fidelity, null);
});

test("verify: a populated readback still verifies normally", () => {
  const result = verify(
    snapWith([{ slug: "a" }]),
    readbackWith({ a: { source: "measured", backgroundColor: "#2563eb", fontSize: 12 } }),
    0.5,
  );
  assert.equal(result.variants[0].status, "verified");
  assert.equal(result.summary.unscored, 0);
  assert.equal(result.fidelity, 1);
});

test("verify: surfaces failures the snap recorded about itself", () => {
  // styles.json is built to be committed, so verify routinely runs against a
  // snap from a job where nobody saw snap's exit code.
  const snap = snapWith([{ slug: "a" }]);
  snap.summary.failed = 2;
  snap.summary.componentsFailed = 1;
  const result = verify(snap, readbackWith({ a: { source: "measured", fontSize: 12 } }), 0.5);
  // A failed component is a --strict failure; a failed variant is reported
  // only, because some are expected and provenance already gates them.
  assert.equal(result.snapIssues.length, 1);
  assert.match(result.snapIssues[0], /component\(s\) failed/);
  assert.equal(result.snapWarnings.length, 1);
  assert.match(result.snapWarnings[0], /2 variant\(s\) could not be measured/);
});

test("verify: a snap with no components at all is reported as an issue", () => {
  const empty = { ...snapWith([{ slug: "a" }]), components: [] } as unknown as SnapResult;
  const result = verify(empty, readbackWith({}), 0.5);
  assert.match(result.snapIssues.join(" "), /no components at all/);
});

test("propertyMatches: opacity does not borrow the pixel tolerance", () => {
  // --tolerance is a pixel budget; sharing it would let a variant twice as
  // opaque as measured pass, and any --tolerance >= 1 would disable the check.
  assert.equal(propertyMatches("opacity", 0.4, 0.8, 0.5), false);
  assert.equal(propertyMatches("opacity", 0.4, 1, 2), false);
  // A float-rounding difference still matches.
  assert.equal(propertyMatches("opacity", 0.4, 0.4000000059604645, 0.5), true);
});

test("verify: text properties are scored against the measured text node, not the root", () => {
  // snap measures these twice because they differ when the text lives in a
  // child; the readback reads Figma's TEXT node, so it must be compared to the
  // text side.
  const snap = snapWith([{ slug: "a" }]);
  (snap.components[0].base as { styles: NormalizedStyles }).styles = {
    ...BASE,
    color: "#111111",
    text: { color: "#ffffff", fontFamily: "Helvetica", fontSize: 12, fontWeight: 600 },
  };
  const result = verify(snap, readbackWith({ a: { source: "measured", color: "#ffffff" } }), 0.5);
  assert.equal(result.variants[0].status, "verified");
});

test("propertyMatches: a zero gap and no gap are the same rendering", () => {
  // Figma needs auto-layout to express padding, so it always reports an
  // itemSpacing; a block element measures null because CSS gap does not apply.
  assert.equal(propertyMatches("gap", null, { row: 0, column: 0 }, 0.5), true);
  assert.equal(propertyMatches("gap", { row: 0, column: 0 }, null, 0.5), true);
  // A real gap against none is still a mismatch.
  assert.equal(propertyMatches("gap", null, { row: 6, column: 6 }, 0.5), false);
  assert.equal(propertyMatches("gap", { row: 6, column: 6 }, { row: 6, column: 6 }, 0.5), true);
});

// --- readback checksums ---

// On a live push the agent wrote figma-readback.json from snap's values plus
// the sizes Figma reported, rather than from what the readback calls returned,
// and verify compared snap with snap. The template now checksums each entry in
// Figma, over exactly what it returns, under the set's id and the slug, with
// the time it was read, and verify recomputes it.

test("fnv1a32: matches FNV-1a's published 32-bit test vectors", () => {
  assert.equal(fnv1a32(""), "811c9dc5");
  assert.equal(fnv1a32("a"), "e40c292c");
  assert.equal(fnv1a32("foobar"), "bf9cf968");
});

test("canonicalJson: sorts every object's keys, keeps array order, and adds no whitespace", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, { z: null, y: "#FFF" }], c: true } }),
    '{"a":{"c":true,"d":[3,{"y":"#FFF","z":null}]},"b":1}',
  );
  assert.equal(canonicalJson([2, 1]), "[2,1]");
});

const ENTRY = {
  source: "measured",
  backgroundColor: "#2563eb",
  color: null,
  padding: { top: 4, right: 8, bottom: 4, left: 8 },
  borderUniform: { width: 1, style: "solid", color: "#9ca3af" },
  gap: { row: 6, column: 6 },
  opacity: 0.4000000059604645,
  width: 38.59,
  height: 24,
  readAt: READ_AT,
};

test("readbackChecksum: is fnv1a: and 8 hex digits, and leaves out its own checksum field", () => {
  const checksum = readbackChecksum("1:2", "a", ENTRY);
  assert.match(checksum, /^fnv1a:[0-9a-f]{8}$/);
  assert.equal(readbackChecksum("1:2", "a", { ...ENTRY, checksum }), checksum);
  assert.equal(readbackChecksum("1:2", "a", { ...ENTRY, checksum: "fnv1a:00000000" }), checksum);
  // Over { [setId]: { [slug]: entry } }, as the template computes it.
  assert.equal(checksum, `fnv1a:${fnv1a32(canonicalJson({ "1:2": { a: ENTRY } }))}`);
});

test("readbackChecksum: a pretty-printed file, or one with its keys in another order, still matches", () => {
  const checksum = readbackChecksum("1:2", "a", ENTRY);
  const reversed = (value: unknown): unknown => (Array.isArray(value) ? value.map(reversed)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
      : value);
  for (const text of [
    JSON.stringify(ENTRY),
    JSON.stringify(ENTRY, null, 2),
    JSON.stringify(ENTRY, null, "\t").replace(/\n/g, "\r\n"),
    JSON.stringify(reversed(ENTRY), null, 4),
  ]) {
    assert.equal(readbackChecksum("1:2", "a", JSON.parse(text)), checksum, text);
  }
});

test("readbackChecksum: numbers are compared as values, whatever notation the file writes them in", () => {
  const entry = { width: 38.59, opacity: 0.4, tiny: 1e-7 };
  const checksum = readbackChecksum("1:2", "a", entry);
  const same = ['{"width":38.590,"opacity":0.40,"tiny":1E-7}', '{"width":3.859e1,"opacity":4e-1,"tiny":0.0000001}'];
  for (const text of same) assert.equal(readbackChecksum("1:2", "a", JSON.parse(text)), checksum, text);
  // But a value is a value: rounding one, even to what it was meant to be, is a change.
  const changed = [
    '{"width":38.6,"opacity":0.4,"tiny":1e-7}',
    '{"width":38.59,"opacity":0.4000000059604645,"tiny":1e-7}',
    '{"width":38.59,"opacity":0.4,"tiny":1e-6}',
    '{"width":38.59,"opacity":0.4,"tiny":0}',
  ];
  for (const text of changed) assert.notEqual(readbackChecksum("1:2", "a", JSON.parse(text)), checksum, text);
  // And Figma's float32 value has to round-trip exactly through the file.
  const float = { opacity: Math.fround(0.4) };
  assert.equal(readbackChecksum("1:2", "a", JSON.parse(JSON.stringify(float))), readbackChecksum("1:2", "a", float));
});

test("readbackChecksum: a colour is its string, null is not absent, and the entry is bound to its set, its slug and its readAt", () => {
  const checksum = readbackChecksum("1:2", "a", ENTRY);
  assert.notEqual(readbackChecksum("1:2", "a", { ...ENTRY, backgroundColor: "#2563EB" }), checksum, "a colour's case is a change");
  const { color: _color, ...absent } = ENTRY;
  assert.notEqual(readbackChecksum("1:2", "a", absent), checksum, "a null removed is a change");
  assert.notEqual(readbackChecksum("1:2", "a", { ...ENTRY, fontSize: null }), checksum, "a null added is a change");
  // An undefined field is absent, as JSON.stringify leaves it out of the file.
  assert.equal(readbackChecksum("1:2", "a", { ...ENTRY, fontSize: undefined }), checksum);
  assert.notEqual(readbackChecksum("1:2", "b", ENTRY), checksum, "an entry copied onto another variant is a change");
  assert.notEqual(readbackChecksum("3:4", "a", ENTRY), checksum, "an entry copied onto another component's variant is a change");
  assert.notEqual(readbackChecksum("1:2", "a", { ...ENTRY, source: "inferred" }), checksum, "source is covered too");
  assert.notEqual(readbackChecksum("1:2", "a", { ...ENTRY, readAt: "2026-10-01T12:00:00.001Z" }), checksum, "readAt is covered too");
});

test("verify: an entry whose checksum matches is scored, with no readback issues", () => {
  const result = verify(snapWith([{ slug: "a" }]), readbackWith({ a: { source: "measured", backgroundColor: "#2563eb", fontSize: 12 } }), 0.5);
  assert.deepEqual(result.readbackIssues, []);
  assert.equal(result.variants[0].status, "verified");
  assert.equal(result.summary.unverifiedReadback, 0);
  assert.equal(result.fidelity, 1);
});

test("verify: an entry changed after Figma returned it is flagged on that variant and not scored", () => {
  // Figma drifted on b; the entry was then edited to snap's value, which
  // without the checksum would read as a match.
  const snap = snapWith([{ slug: "a" }, { slug: "b", delta: { backgroundColor: "#dc2626" } }]);
  const file = readbackWith({
    a: { source: "measured", backgroundColor: "#2563eb", fontSize: 12 },
    b: { source: "measured", backgroundColor: "#ff00ff", fontSize: 12 },
  });
  (file.components["Forms/Button"].variants.b as Record<string, unknown>).backgroundColor = "#dc2626";
  const result = verify(snap, file, 0.5);
  assert.deepEqual(result.readbackIssues, [{ component: "Forms/Button", slug: "b", problem: "checksum_mismatch" }]);
  const b = result.variants.find((v) => v.slug === "b")!;
  assert.equal(b.status, "unverified_readback");
  assert.equal(b.matched + b.mismatched, 0, "an unverified entry's properties were scored");
  assert.deepEqual(b.differences, []);
  const a = result.variants.find((v) => v.slug === "a")!;
  assert.equal(a.status, "verified");
  assert.equal(result.summary.unverifiedReadback, 1);
  assert.equal(result.summary.verified, 1);
  assert.equal(result.summary.drifted, 0);
  assert.equal(result.summary.propertiesCompared, a.matched, "only a's properties are scored");
});

test("verify: an entry with no checksum is unverified, so neither its matches nor its drift are scored", () => {
  const file = readbackWith({ a: { source: "measured", fontSize: 12 } });
  file.components["Forms/Button"].variants.b = complete({ source: "measured", backgroundColor: "#ff00ff", fontSize: 12 }) as never;
  const result = verify(snapWith([{ slug: "a" }, { slug: "b" }]), file, 0.5);
  assert.deepEqual(result.readbackIssues, [{ component: "Forms/Button", slug: "b", problem: "no_checksum" }]);
  assert.equal(result.variants.find((v) => v.slug === "b")!.status, "unverified_readback");
  assert.equal(result.summary.drifted, 0);
  assert.equal(result.fidelity, 1, "the score is over a alone");
});

test("verify: a readback rebuilt from snap's values is unverified on every variant and scores nothing", () => {
  // The live failure: every entry composed from what snap measured. It matches
  // snap exactly, which is why it proves nothing.
  const snap = snapWith([{ slug: "a" }, { slug: "b", delta: { backgroundColor: "#dc2626" } }]);
  const rebuilt: Record<string, Record<string, unknown>> = {};
  for (const [slug, styles] of expandSnap(snap).get("Forms/Button")!) {
    rebuilt[slug] = { source: "measured", backgroundColor: styles.backgroundColor, padding: styles.padding, fontSize: styles.fontSize };
  }
  const result = verify(snap, readbackWith(rebuilt, { seal: false }), 0.5);
  assert.equal(result.summary.unverifiedReadback, 2);
  assert.equal(result.summary.verified, 0);
  assert.equal(result.summary.propertiesCompared, 0);
  assert.equal(result.fidelity, null);
  assert.deepEqual(result.readbackIssues.map((i) => i.problem), ["no_checksum", "no_checksum"]);
});

test("verify: entries snap never measured are checked too, and one that is not an object is unverified, not a crash", () => {
  const file = readbackWith({ a: { source: "measured", fontSize: 12 }, extra: { source: "measured", fontSize: 13 } });
  (file.components["Forms/Button"].variants.extra as Record<string, unknown>).fontSize = 12;
  (file.components["Forms/Button"].variants as Record<string, unknown>).b = "copied from snap";
  const result = verify(snapWith([{ slug: "a" }, { slug: "b" }]), file, 0.5);
  assert.deepEqual(result.readbackIssues, [
    { component: "Forms/Button", slug: "extra", problem: "checksum_mismatch" },
    { component: "Forms/Button", slug: "b", problem: "no_checksum" },
  ]);
  assert.equal(result.variants.find((v) => v.slug === "b")!.status, "unverified_readback");
  assert.deepEqual(checkReadback(readbackWith({ a: { fontSize: 12 } })), []);
});

test("verify: never says what a checksum should have been", () => {
  // Printing the expected value would make the fix to copy it in.
  const entry = complete({ source: "measured", backgroundColor: "#2563eb" });
  const file = readbackWith({ a: { ...entry, backgroundColor: "#ffffff" } });
  (file.components["Forms/Button"].variants.a as Record<string, unknown>).backgroundColor = "#2563eb";
  const result = verify(snapWith([{ slug: "a" }]), file, 0.5);
  assert.equal(result.readbackIssues.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(readbackChecksum("1:2", "a", entry).slice("fnv1a:".length)));
});

/** A snap of two components with no variant props, each with the one slug snap gives them, `default`. */
function twoPropless(): SnapResult {
  const snap = snapWith([{ slug: "default" }]);
  const [badge] = snap.components;
  snap.components = [
    { ...badge, name: "Badge", title: "Data/Badge", storyId: "data-badge--default" },
    { ...badge, name: "Tag", title: "Data/Tag", storyId: "data-tag--default" },
  ];
  return snap;
}

test("verify: an entry copied onto the same slug in another component is flagged", () => {
  // Every component without variant props has the slug default, so a slug
  // alone would let Badge's entry stand in for Tag's, whose Figma fill drifted.
  const badge = complete({});
  const file: ReadbackFile = {
    version: 1,
    components: {
      "Data/Badge": { nodeId: "10:1", variants: sealed({ default: badge }, "10:1") as never },
      "Data/Tag": { nodeId: "20:1", variants: sealed({ default: complete({ backgroundColor: "#ff00ff" }) }, "20:1") as never },
    },
  };
  const faithful = verify(twoPropless(), file, 0.5);
  assert.deepEqual(faithful.readbackIssues, []);
  assert.deepEqual(faithful.variants.map((v) => `${v.component} ${v.status}`), ["Data/Badge verified", "Data/Tag drifted"]);

  file.components["Data/Tag"].variants.default = file.components["Data/Badge"].variants.default;
  const copied = verify(twoPropless(), file, 0.5);
  assert.deepEqual(copied.readbackIssues, [{ component: "Data/Tag", slug: "default", problem: "checksum_mismatch" }]);
  assert.deepEqual(copied.variants.map((v) => `${v.component} ${v.status}`), ["Data/Badge verified", "Data/Tag unverified_readback"]);
});

test("verify: a component with no nodeId has every entry unverified, since its checksums cannot be checked", () => {
  const file = readbackWith({ a: {}, b: { backgroundColor: "#dc2626" } });
  delete file.components["Forms/Button"].nodeId;
  const result = verify(snapWith([{ slug: "a" }, { slug: "b", delta: { backgroundColor: "#dc2626" } }]), file, 0.5);
  assert.deepEqual(result.readbackIssues.map((i) => `${i.slug} ${i.problem}`), ["a no_node_id", "b no_node_id"]);
  assert.equal(result.summary.unverifiedReadback, 2);
  assert.equal(result.summary.propertiesCompared, 0);
  // An empty one is no id either.
  file.components["Forms/Button"].nodeId = "";
  assert.equal(checkReadback(file).length, 2);
});

// --- complete entries ---

// A template cut down to fewer fields still seals what it returns, and verify
// scores only what an entry reports: cut down to { source, width, height }, it
// scored 100% on every strict flag without comparing colour, padding, type or
// radius.

test("verify: a sealed entry cut down to source, width and height is incomplete, and nothing in it is scored", () => {
  const trimmed = { source: "measured", width: 61.5, height: 24, readAt: READ_AT };
  const result = verify(snapWith([{ slug: "a" }]), readbackWith({ a: trimmed }, { whole: false }), 0.5);
  assert.deepEqual(result.readbackIssues, [{
    component: "Forms/Button", slug: "a", problem: "incomplete",
    missing: ["backgroundColor", "color", "borderRadiusUniform", "padding", "borderUniform", "opacity"],
  }]);
  assert.equal(result.variants[0].status, "unverified_readback");
  assert.equal(result.summary.propertiesCompared, 0);
  assert.equal(result.fidelity, null);
});

test("missingReadbackFields: null is present, absent is not, and gap and the text fields may be left out as the template leaves them", () => {
  assert.deepEqual(READBACK_FIELDS, [
    "source", "backgroundColor", "color", "borderRadiusUniform", "padding", "borderUniform", "opacity", "width", "height",
  ]);
  assert.deepEqual(missingReadbackFields(complete({})), []);
  // A variant with no text child and no auto layout: every text field and gap out.
  const bare = complete({ fontSize: undefined, fontWeight: undefined, fontFamily: undefined, gap: undefined, color: null });
  assert.deepEqual(missingReadbackFields(bare), []);
  // A mixed font: fontSize and fontFamily out, fontWeight still 400.
  assert.deepEqual(missingReadbackFields(complete({ fontSize: undefined, fontFamily: undefined, fontWeight: 400 })), []);
  // Every always-returned field may be null, but not absent.
  const nulls = Object.fromEntries(READBACK_FIELDS.map((key) => [key, null]));
  assert.deepEqual(missingReadbackFields(nulls), []);
  for (const key of READBACK_FIELDS) {
    assert.deepEqual(missingReadbackFields(complete({ [key]: undefined })), [key], key);
  }
  // The template reads the three text fields off one child, and fontWeight
  // whenever there is one, so either of the others without it was cut out.
  assert.deepEqual(missingReadbackFields(complete({ fontWeight: undefined })), ["fontWeight"]);
  assert.deepEqual(missingReadbackFields(complete({ fontWeight: undefined, fontSize: undefined })), ["fontWeight"]);
  assert.deepEqual(missingReadbackFields(complete({ fontWeight: undefined, fontFamily: undefined })), ["fontWeight"]);
});

test("verify: a checksum that does not match is the one issue reported for an entry, however incomplete or old", () => {
  const file = readbackWith({ a: { readAt: undefined, padding: undefined } });
  (file.components["Forms/Button"].variants.a as Record<string, unknown>).opacity = 0.5;
  assert.deepEqual(checkReadback(file, { measuredAt: "2026-10-02T00:00:00.000Z" }), [
    { component: "Forms/Button", slug: "a", problem: "checksum_mismatch" },
  ]);
});

// --- readAt ---

// A readback reused from an earlier run is sealed and complete, and describes
// Figma as it was then. readAt is when Figma read the entry, sealed under its
// checksum, and verify compares it with the snap's measuredAt.

test("verify: an entry with no readAt is stale, and not scored", () => {
  const result = verify(snapWith([{ slug: "a" }]), readbackWith({ a: { readAt: undefined } }), 0.5);
  assert.deepEqual(result.readbackIssues, [{ component: "Forms/Button", slug: "a", problem: "stale", readAt: null }]);
  assert.equal(result.variants[0].status, "unverified_readback");
  assert.equal(result.fidelity, null);
});

test("verify: an entry read before the snap is stale, and not scored", () => {
  const measuredAt = "2026-10-01T13:00:00.000Z";
  const result = verify(snapWith([{ slug: "a" }, { slug: "b" }]), readbackWith({ a: {}, b: { readAt: "2026-10-01T13:01:00.000Z" } }), 0.5, { measuredAt });
  assert.deepEqual(result.readbackIssues, [{ component: "Forms/Button", slug: "a", problem: "stale", readAt: READ_AT }]);
  assert.deepEqual(result.variants.map((v) => v.status), ["unverified_readback", "verified"]);
  assert.equal(result.summary.unverifiedReadback, 1);
});

test("verify: readAt may fall a few minutes before the snap, for the two clocks, and no more", () => {
  // readAt is Figma's clock and measuredAt the machine's that ran snap.
  const measured = Date.parse(READ_AT);
  const at = (ms: number) => ({ measuredAt: new Date(ms).toISOString() });
  const file = readbackWith({ a: {} });
  assert.equal(READ_AT_SKEW_MS, 5 * 60_000);
  assert.deepEqual(verify(snapWith([{ slug: "a" }]), file, 0.5, at(measured + 2 * 60_000)).readbackIssues, []);
  assert.deepEqual(verify(snapWith([{ slug: "a" }]), file, 0.5, at(measured + READ_AT_SKEW_MS)).readbackIssues, []);
  assert.deepEqual(verify(snapWith([{ slug: "a" }]), file, 0.5, at(measured + READ_AT_SKEW_MS + 1)).readbackIssues.map((i) => i.problem), ["stale"]);
  assert.deepEqual(verify(snapWith([{ slug: "a" }]), file, 0.5, at(measured - 60_000)).readbackIssues, []);
});

test("verify: without the snap's time only that readAt is a time is checked", () => {
  assert.deepEqual(checkReadback(readbackWith({ a: { readAt: "1970-01-01T00:00:00.000Z" } })), []);
  assert.deepEqual(checkReadback(readbackWith({ a: { readAt: "yesterday-ish" } })),
    [{ component: "Forms/Button", slug: "a", problem: "stale", readAt: "yesterday-ish" }]);
  assert.deepEqual(checkReadback(readbackWith({ a: { readAt: 1790000000000 } })),
    [{ component: "Forms/Button", slug: "a", problem: "stale", readAt: null }]);
});

test("verify: an entry can be both incomplete and stale, and is reported as both", () => {
  const result = verify(snapWith([{ slug: "a" }]), readbackWith({ a: { opacity: undefined, readAt: undefined } }), 0.5);
  assert.deepEqual(result.readbackIssues, [
    { component: "Forms/Button", slug: "a", problem: "incomplete", missing: ["opacity"] },
    { component: "Forms/Button", slug: "a", problem: "stale", readAt: null },
  ]);
  assert.equal(result.summary.unverifiedReadback, 1, "one variant, however many issues");
});
