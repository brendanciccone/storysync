// Compares what was written to Figma against what was measured in Storybook.
//
// The agent writes the component, then has the plugin read the created node's
// real properties back out and save them as JSON. This module diffs that
// readback against `snap`'s measurements and produces a fidelity score.
//
// Numeric rather than visual on purpose: comparing rendered screenshots means
// feeding images to a model and getting a judgement, where comparing measured
// values is deterministic, cheap, and reproducible.

import { readFileSync } from "node:fs";
import { applyDelta } from "./snap-normalize.js";
import type { NormalizedStyles, BorderSide, BoxShadowLayer } from "./snap-normalize.js";
import type { SnapResult } from "./snap.js";

export const READBACK_SCHEMA_VERSION = 1;

/**
 * What a Figma node can actually report back.
 *
 * A deliberate subset of NormalizedStyles: Figma has no equivalent for
 * `lineHeight: "normal"`, `display`, or measured `width`/`height` on an
 * auto-layout frame, so comparing them would manufacture mismatches.
 */
export interface ReadbackStyles {
  backgroundColor?: string | null;
  color?: string | null;
  borderRadiusUniform?: number | null;
  borderRadius?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  padding?: { top: number; right: number; bottom: number; left: number };
  borderUniform?: BorderSide | null;
  boxShadow?: BoxShadowLayer[];
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  gap?: { row: number; column: number } | null;
  flexDirection?: string | null;
  opacity?: number;
}

export interface ReadbackFile {
  version: number;
  fileKey?: string;
  components: Record<string, {
    nodeId?: string;
    /** Keyed by the variant slug `snap` emitted. */
    variants: Record<string, ReadbackStyles>;
  }>;
}

/** Properties compared, in report order. */
export const COMPARABLE_PROPERTIES = [
  "backgroundColor", "color", "borderRadiusUniform", "padding", "borderUniform",
  "boxShadow", "fontSize", "fontWeight", "fontFamily", "gap", "flexDirection", "opacity",
] as const;

export type ComparableProperty = (typeof COMPARABLE_PROPERTIES)[number];

export interface PropertyDiff {
  property: ComparableProperty;
  status: "match" | "mismatch";
  measured: unknown;
  figma: unknown;
}

export interface VariantVerdict {
  component: string;
  slug: string;
  status: "verified" | "drifted" | "missing_from_figma";
  matched: number;
  mismatched: number;
  differences: PropertyDiff[];
}

export interface VerifyResult {
  version: number;
  /** Share of compared properties that matched, 0-1. Null when nothing compared. */
  fidelity: number | null;
  summary: {
    components: number;
    variants: number;
    verified: number;
    drifted: number;
    missingFromFigma: number;
    propertiesCompared: number;
    propertiesMatched: number;
  };
  variants: VariantVerdict[];
}

// --- Comparison --------------------------------------------------------------

function closeEnough(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

function sameColor(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v ?? null);
  return norm(a) === norm(b);
}

function sameBorder(a: unknown, b: unknown, tolerance: number): boolean {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  const x = a as BorderSide;
  const y = b as BorderSide;
  return closeEnough(x.width, y.width, tolerance) && sameColor(x.color, y.color);
}

function sameShadows(a: unknown, b: unknown, tolerance: number): boolean {
  const xs = (a ?? []) as BoxShadowLayer[];
  const ys = (b ?? []) as BoxShadowLayer[];
  if (xs.length !== ys.length) return false;
  return xs.every((x, i) => {
    const y = ys[i];
    return closeEnough(x.offsetX, y.offsetX, tolerance)
      && closeEnough(x.offsetY, y.offsetY, tolerance)
      && closeEnough(x.blur, y.blur, tolerance)
      && closeEnough(x.spread, y.spread, tolerance)
      && sameColor(x.color, y.color);
  });
}

function sameNumericRecord(a: unknown, b: unknown, tolerance: number): boolean {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  const x = a as Record<string, number>;
  const y = b as Record<string, number>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const key of keys) {
    if (!closeEnough(x[key] ?? 0, y[key] ?? 0, tolerance)) return false;
  }
  return true;
}

/**
 * True when a Figma value matches the measured one. Comparison is per-property
 * because the meaningful notion of equality differs: colors are
 * case-insensitive strings, lengths need a tolerance for sub-pixel rounding.
 */
export function propertyMatches(
  property: ComparableProperty,
  measured: unknown,
  figma: unknown,
  tolerance: number,
): boolean {
  switch (property) {
    case "backgroundColor":
    case "color":
      return sameColor(measured, figma);
    case "borderRadiusUniform":
    case "fontSize":
    case "opacity":
      if (measured == null || figma == null) return (measured ?? null) === (figma ?? null);
      return closeEnough(Number(measured), Number(figma), tolerance);
    case "fontWeight":
      return Number(measured ?? 0) === Number(figma ?? 0);
    case "fontFamily":
      return String(measured ?? "").toLowerCase() === String(figma ?? "").toLowerCase();
    case "padding":
    case "gap":
      return sameNumericRecord(measured, figma, tolerance);
    case "borderUniform":
      return sameBorder(measured, figma, tolerance);
    case "boxShadow":
      return sameShadows(measured, figma, tolerance);
    case "flexDirection":
      return String(measured ?? "").toLowerCase() === String(figma ?? "").toLowerCase();
  }
}

/**
 * Compares one variant. Only properties the readback actually reports are
 * considered — an absent property means Figma could not express it, which is
 * not the same as a mismatch and must not count against the score.
 */
export function verifyVariant(
  component: string,
  slug: string,
  measured: NormalizedStyles,
  figma: ReadbackStyles | undefined,
  tolerance: number,
): VariantVerdict {
  if (!figma) {
    return { component, slug, status: "missing_from_figma", matched: 0, mismatched: 0, differences: [] };
  }

  const differences: PropertyDiff[] = [];
  let matched = 0;
  let mismatched = 0;

  for (const property of COMPARABLE_PROPERTIES) {
    if (!(property in figma)) continue;
    const figmaValue = (figma as Record<string, unknown>)[property];
    const measuredValue = (measured as unknown as Record<string, unknown>)[property];

    if (propertyMatches(property, measuredValue, figmaValue, tolerance)) {
      matched++;
    } else {
      mismatched++;
      differences.push({ property, status: "mismatch", measured: measuredValue, figma: figmaValue });
    }
  }

  return {
    component, slug,
    status: mismatched > 0 ? "drifted" : "verified",
    matched, mismatched, differences,
  };
}

/** Rebuilds each variant's full styles from the base plus its delta. */
export function expandSnap(snap: SnapResult): Map<string, Map<string, NormalizedStyles>> {
  const byComponent = new Map<string, Map<string, NormalizedStyles>>();
  for (const component of snap.components) {
    if (!component.base) continue;
    const variants = new Map<string, NormalizedStyles>();
    for (const variant of component.variants) {
      if (variant.status !== "ok") continue;
      variants.set(variant.slug, applyDelta(component.base.styles, variant.delta ?? {}));
    }
    byComponent.set(component.title ?? component.name, variants);
  }
  return byComponent;
}

export function verify(snap: SnapResult, readback: ReadbackFile, tolerance: number): VerifyResult {
  const measuredByComponent = expandSnap(snap);
  const verdicts: VariantVerdict[] = [];

  for (const [component, measuredVariants] of measuredByComponent) {
    const figmaComponent = readback.components[component];
    for (const [slug, measured] of measuredVariants) {
      verdicts.push(verifyVariant(component, slug, measured, figmaComponent?.variants?.[slug], tolerance));
    }
  }

  const propertiesMatched = verdicts.reduce((n, v) => n + v.matched, 0);
  const propertiesCompared = propertiesMatched + verdicts.reduce((n, v) => n + v.mismatched, 0);

  return {
    version: READBACK_SCHEMA_VERSION,
    fidelity: propertiesCompared > 0 ? propertiesMatched / propertiesCompared : null,
    summary: {
      components: measuredByComponent.size,
      variants: verdicts.length,
      verified: verdicts.filter((v) => v.status === "verified").length,
      drifted: verdicts.filter((v) => v.status === "drifted").length,
      missingFromFigma: verdicts.filter((v) => v.status === "missing_from_figma").length,
      propertiesCompared,
      propertiesMatched,
    },
    variants: verdicts,
  };
}

// --- Loading -----------------------------------------------------------------

export function loadJsonFile<T>(path: string, label: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : String(err);
    throw new Error(`Could not read ${label} at ${path}: ${reason}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label} at ${path} is not valid JSON: ${String(err)}`);
  }
}

export function formatFidelity(fidelity: number | null): string {
  return fidelity == null ? "n/a" : `${(fidelity * 100).toFixed(1)}%`;
}
