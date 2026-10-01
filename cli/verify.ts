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
import { dirname, join } from "node:path";
import { applyDelta } from "./snap-normalize.js";
import type { NormalizedStyles, BorderSide, BoxShadowLayer } from "./snap-normalize.js";
import { SNAP_META_FILENAME } from "./snap.js";
import type { SnapResult } from "./snap.js";

export const READBACK_SCHEMA_VERSION = 1;

/**
 * What a Figma node can actually report back.
 *
 * A deliberate subset of NormalizedStyles: Figma has no equivalent for
 * `lineHeight: "normal"`, `display`, or measured `width`/`height` on an
 * auto-layout frame, so comparing them would manufacture mismatches.
 */
/**
 * Where the styling written to Figma came from.
 *
 * Recorded per variant rather than reported once, because "it produced a
 * result" and "it produced a *measured* result" look identical from the
 * outside. A run inspected later, or by CI, must be able to tell them apart
 * without scrollback — an unrecorded state reads as the good one.
 */
export type StyleSource = "measured" | "inferred";

export interface ReadbackStyles {
  /** Omitted by older writers; treated as `unrecorded`, never as measured. */
  source?: StyleSource;
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
  /** The node's own size plus the stroke outside it, painted or not: see below. */
  width?: number;
  height?: number;
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
  "width", "height",
] as const;

/**
 * Geometry needs a proportional allowance, not a fixed one.
 *
 * Figma re-lays out text with its own metrics and rounds each text node to
 * whole pixels, and a hugging frame's width is padding plus that text width —
 * so the disagreement grows with font size and string length rather than
 * staying within a sub-pixel band. Measured against a real push: 1.19px at a
 * 12px font, 1.72px at 18px. A fixed floor tight enough to be useful at 12px
 * produces false drift at 18px.
 *
 * The readback must supply these as the browser's border box: the node's own
 * size plus whatever of its stroke lies outside it, painted or not. Not
 * `node.width` alone, which leaves out an OUTSIDE stroke, and not its render
 * bounds, which leave out a stroke that paints nothing, where a transparent
 * CSS border still takes its space, and take in drop shadows, where a
 * box-shadow takes none.
 */
const MIN_GEOMETRY_TOLERANCE_PX = 1;
const GEOMETRY_TOLERANCE_RATIO = 0.03;

/** Opacity is a 0-1 ratio, so it gets its own allowance rather than `--tolerance`. */
const OPACITY_TOLERANCE = 0.01;

/**
 * Properties the readback reads off Figma's text child rather than the frame.
 *
 * `snap` measures these twice — once on the root element and once on the
 * nearest text-owning descendant — precisely because they differ when the text
 * lives in a child. The readback template reads Figma's TEXT node, so these
 * must be compared against the measured `text` values, not the root's.
 */
const TEXT_PROPERTIES = new Set<string>(["color", "fontSize", "fontWeight", "fontFamily"]);

function geometryTolerance(explicit: number, a: unknown, b: unknown): number {
  const largest = Math.max(Number(a) || 0, Number(b) || 0);
  return Math.max(explicit, MIN_GEOMETRY_TOLERANCE_PX, largest * GEOMETRY_TOLERANCE_RATIO);
}

/**
 * Whether a measured element's own width and height mean anything.
 *
 * A block-level element fills its container, so the browser reports the
 * viewport width — 1248px for a component that renders 30px wide. That is not
 * an imprecise measurement of the component, it is a measurement of something
 * else, and comparing it would light up every card, row, and layout wrapper in
 * a real design system with drift that is not there.
 *
 * Only shrink-to-fit elements — inline, inline-block, inline-flex, and inline
 * grid — have an intrinsic size that Figma's hugging auto-layout is trying to
 * reproduce.
 */
export function hasIntrinsicSize(display: string | undefined): boolean {
  const d = (display ?? "").trim().toLowerCase();
  return d.startsWith("inline") || d === "table" || d === "inline-table";
}

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
  /**
   * `unscored` is the variant Figma reported without any comparable property.
   *
   * Only properties the readback volunteers are compared, so a writer that
   * reports nothing would otherwise pick its own denominator and score a
   * perfect nothing. That is not an attack but the default failure mode: a
   * plugin read that came back empty still yields `{ source: "measured" }`.
   * An absent measurement must not read as a passing one.
   */
  status: "verified" | "drifted" | "missing_from_figma" | "unscored";
  /** `unrecorded` when the writer did not say — not the same as measured. */
  source: StyleSource | "unrecorded";
  matched: number;
  mismatched: number;
  differences: PropertyDiff[];
}

export interface SnapAgeKnown {
  known: true;
  measuredAt: string;
  ageMs: number;
  storybookUrl?: string;
  /** True once older than the configured limit. */
  stale: boolean;
}

/**
 * Why the age could not be established.
 *
 * Modelled explicitly rather than as an absent value: `meta.json` is the file a
 * consuming project is most likely to gitignore, precisely because it churns
 * every run — which is the whole reason the timestamp lives outside
 * `styles.json`. An unknown age silently passing would mean the intended usage
 * pattern produces a repository where `--strict-age` succeeds unconditionally,
 * forever, on a measurement of unknown vintage.
 */
export interface SnapAgeUnknown {
  known: false;
  reason: string;
}

export type SnapAgeInfo = SnapAgeKnown | SnapAgeUnknown;

/** A `measuredAt` this far ahead of now means a bad clock, not a fresh snap. */
const MAX_CLOCK_SKEW_MS = 60_000;

export interface VerifyResult {
  version: number;
  /** Share of compared properties that matched, 0-1. Null when nothing compared. */
  fidelity: number | null;
  /** Age of the measurement, or why it could not be established. */
  snapAge?: SnapAgeInfo;
  summary: {
    components: number;
    variants: number;
    verified: number;
    drifted: number;
    missingFromFigma: number;
    propertiesCompared: number;
    propertiesMatched: number;
    /** Variants whose styling was inferred from source rather than measured. */
    inferred: number;
    /** Variants whose writer recorded no provenance at all. */
    unrecorded: number;
    /** Variants present in Figma that snap never measured, so nothing scored them. */
    unmeasured: number;
    /** Variants Figma reported with no comparable property, so nothing was scored. */
    unscored: number;
  };
  /**
   * Failures the snap file recorded about itself.
   *
   * styles.json is built to be committed and diffed, so verify routinely runs
   * against a snap produced in another job where nobody saw snap's exit code.
   * Everything needed to refuse is already inside the file verify parsed.
   */
  snapIssues: string[];
  /** Variants the snap could not measure. Reported, but not a --strict failure on their own. */
  snapWarnings: string[];
  /**
   * Readback entries with no corresponding measurement.
   *
   * These are written to Figma but unscored, so without listing them a run can
   * report a clean match while a whole component went unchecked — which is
   * exactly what happens when snap fails for a component and the agent falls
   * back to inferring it wholesale.
   */
  unmeasuredInFigma: { component: string; slug: string }[];
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

/** Absent, or present with every component at zero — the same rendering either way. */
function isAbsentOrZeroRecord(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((n) => Number(n) === 0);
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
      if (measured == null || figma == null) return (measured ?? null) === (figma ?? null);
      return closeEnough(Number(measured), Number(figma), tolerance);
    case "opacity":
      // Opacity is a 0-1 ratio, not a length. Sharing --tolerance (a pixel
      // budget, default 0.5) would let a variant twice as opaque as measured
      // score as a match, and any --tolerance >= 1 would disable the check
      // outright.
      if (measured == null || figma == null) return (measured ?? null) === (figma ?? null);
      return closeEnough(Number(measured), Number(figma), OPACITY_TOLERANCE);
    case "width":
    case "height":
      if (measured == null || figma == null) return (measured ?? null) === (figma ?? null);
      return closeEnough(Number(measured), Number(figma), geometryTolerance(tolerance, measured, figma));
    case "fontWeight":
      return Number(measured ?? 0) === Number(figma ?? 0);
    case "fontFamily":
      return String(measured ?? "").toLowerCase() === String(figma ?? "").toLowerCase();
    case "gap":
      // "No gap" and "a gap of zero" render identically. A block element
      // measures `null` because CSS gap does not apply to it, while Figma must
      // use auto-layout to express padding at all and so always reports an
      // itemSpacing — treating those as a mismatch would drift on every
      // block-level component that was reproduced correctly.
      if (isAbsentOrZeroRecord(measured) && isAbsentOrZeroRecord(figma)) return true;
      return sameNumericRecord(measured, figma, tolerance);
    case "padding":
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
    return {
      component, slug, status: "missing_from_figma", source: "unrecorded",
      matched: 0, mismatched: 0, differences: [],
    };
  }

  const source: StyleSource | "unrecorded" =
    figma.source === "measured" || figma.source === "inferred" ? figma.source : "unrecorded";
  const differences: PropertyDiff[] = [];
  let matched = 0;
  let mismatched = 0;

  const geometryMeaningful = hasIntrinsicSize(measured.display);

  for (const property of COMPARABLE_PROPERTIES) {
    if (!(property in figma)) continue;
    // A block element's measured size is its container's, not its own.
    if ((property === "width" || property === "height") && !geometryMeaningful) continue;
    const figmaValue = (figma as Record<string, unknown>)[property];
    // Compare like with like: the readback reads these off Figma's text child,
    // so score them against the text styles snap measured on the corresponding
    // descendant. Falls back to the root when the element owns no text.
    const measuredText = measured.text as Record<string, unknown> | null | undefined;
    const measuredValue = TEXT_PROPERTIES.has(property) && measuredText?.[property] != null
      ? measuredText[property]
      : (measured as unknown as Record<string, unknown>)[property];

    if (propertyMatches(property, measuredValue, figmaValue, tolerance)) {
      matched++;
    } else {
      mismatched++;
      differences.push({ property, status: "mismatch", measured: measuredValue, figma: figmaValue });
    }
  }

  return {
    component, slug,
    status: mismatched > 0 ? "drifted" : matched === 0 ? "unscored" : "verified",
    source, matched, mismatched, differences,
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

  // The mirror of missing_from_figma: something Figma has that we never
  // measured, and therefore never scored.
  const unmeasuredInFigma: { component: string; slug: string }[] = [];
  for (const [component, entry] of Object.entries(readback.components ?? {})) {
    const measured = measuredByComponent.get(component);
    for (const slug of Object.keys(entry?.variants ?? {})) {
      if (!measured?.has(slug)) unmeasuredInFigma.push({ component, slug });
    }
  }

  const propertiesMatched = verdicts.reduce((n, v) => n + v.matched, 0);
  const propertiesCompared = propertiesMatched + verdicts.reduce((n, v) => n + v.mismatched, 0);

  // A snap that recorded its own failures must not be scored as if it had not.
  const snapIssues: string[] = [];
  const snapWarnings: string[] = [];
  const componentErrors = (snap.components ?? []).filter((c) => c.error);
  for (const component of componentErrors) {
    snapIssues.push(`${component.title ?? component.name}: ${component.error}`);
  }
  if (!componentErrors.length && snap.summary?.componentsFailed) {
    snapIssues.push(`${snap.summary.componentsFailed} component(s) failed to measure`);
  }
  // A snap that measured nothing at all is not a clean run. `measuredAt`
  // attests to when the CLI ran, not to whether anything was measured, so
  // freshness alone would let an empty snap read as a good one.
  if ((snap.components ?? []).length === 0) {
    snapIssues.push("the snap recorded no components at all");
  }
  // A single unmeasured variant is reported but does not fail --strict on its
  // own. Some are expected — args_unsupported, for a value Storybook cannot
  // pass in a URL — and the skill has the agent build those from source and
  // label them inferred, which provenance already fails under
  // --strict-measured. `snap --strict` is the gate for measurement failures.
  if (snap.summary?.failed) {
    snapWarnings.push(
      `${snap.summary.failed} variant(s) could not be measured; any built from source are listed under provenance`,
    );
  }

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
      inferred: verdicts.filter((v) => v.source === "inferred").length,
      // Only count variants Figma actually has; a missing variant is a
      // different problem and is already reported as one.
      unrecorded: verdicts.filter((v) => v.source === "unrecorded" && v.status !== "missing_from_figma").length,
      unmeasured: unmeasuredInFigma.length,
      unscored: verdicts.filter((v) => v.status === "unscored").length,
    },
    snapIssues,
    snapWarnings,
    unmeasuredInFigma,
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

/** Parses `30m`, `2h`, `7d`, or a bare number of minutes. Null if unparseable. */
export function parseDuration(input: string): number | null {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] || "m").toLowerCase();
  const scale = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return scale == null ? null : value * scale;
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/**
 * Reads the sidecar written beside `styles.json`.
 *
 * A stale snap of the *right* component is the one drift case nothing else
 * catches: every property matches, the score reads 100%, and it is describing
 * code that has since changed. Comparing against the wrong component is loud
 * — everything reports missing — but this is silent, so it needs the clock.
 */
export function readSnapAge(
  snapPath: string,
  maxAgeMs: number | null,
  now: number = Date.now(),
): SnapAgeInfo {
  const metaPath = join(dirname(snapPath), SNAP_META_FILENAME);

  let meta: { measuredAt?: unknown; storybookUrl?: unknown };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return {
      known: false,
      reason: missing
        ? `no ${SNAP_META_FILENAME} beside ${snapPath}`
        : `${metaPath} could not be read: ${firstLine(err)}`,
    };
  }

  if (typeof meta.measuredAt !== "string" || !meta.measuredAt) {
    return { known: false, reason: `${metaPath} has no measuredAt` };
  }

  const measured = Date.parse(meta.measuredAt);
  if (!Number.isFinite(measured)) {
    return { known: false, reason: `${metaPath} has an unparseable measuredAt (${meta.measuredAt})` };
  }

  // Clamping a future date to "0s ago" would report a skewed clock as
  // maximally fresh, which is the wrong way to be wrong.
  if (measured > now + MAX_CLOCK_SKEW_MS) {
    return { known: false, reason: `measuredAt is in the future (${meta.measuredAt}) — check the clock` };
  }

  const ageMs = Math.max(0, now - measured);
  return {
    known: true,
    measuredAt: meta.measuredAt,
    ageMs,
    storybookUrl: typeof meta.storybookUrl === "string" ? meta.storybookUrl : undefined,
    stale: maxAgeMs != null && ageMs > maxAgeMs,
  };
}

function firstLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split("\n")[0].trim();
}
