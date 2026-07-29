import { test } from "node:test";
import assert from "node:assert/strict";
import { verify, verifyVariant, propertyMatches, expandSnap, formatFidelity } from "../verify.js";
import type { ReadbackFile } from "../verify.js";
import type { NormalizedStyles } from "../snap-normalize.js";
import type { SnapResult } from "../snap.js";

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
