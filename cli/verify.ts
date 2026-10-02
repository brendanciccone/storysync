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
  /**
   * Colours as snap writes them: `#rrggbb`, `#rrggbbaa` when translucent, and
   * null when nothing is drawn, so a Figma paint's opacity is the alpha byte.
   */
  backgroundColor?: string | null;
  color?: string | null;
  borderRadiusUniform?: number | null;
  borderRadius?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  padding?: { top: number; right: number; bottom: number; left: number };
  borderUniform?: BorderSide | null;
  boxShadow?: BoxShadowLayer[];
  /**
   * The text child's, null when the variant has none, or when Figma reports
   * the value as mixed; `fontWeight` and `fontFamily` both when the font is.
   */
  fontSize?: number | null;
  fontWeight?: number | null;
  fontFamily?: string | null;
  /**
   * The auto layout's `itemSpacing` on both keys, null when the frame has no
   * auto layout. `itemSpacing` is the gap along the layout's direction only,
   * so a flex element's measured gap is compared on that axis alone: see
   * comparableGap.
   */
  gap?: { row: number; column: number } | null;
  flexDirection?: string | null;
  opacity?: number;
  /** The node's own size plus the stroke outside it, painted or not: see below. */
  width?: number;
  height?: number;
  /**
   * When the readback template read this entry, as an ISO 8601 time from
   * Figma's clock, sealed under the checksum: see READ_AT_SKEW_MS. Not a
   * style property.
   */
  readAt?: string;
  /**
   * The checksum the readback template computed in Figma over this entry, as
   * `fnv1a:` and 8 hex digits: see readbackChecksum. Not a style property.
   */
  checksum?: string;
}

export interface ReadbackFile {
  version: number;
  fileKey?: string;
  components: Record<string, {
    /** The component set's id, which every entry's checksum is sealed under. */
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
 * The measured gap as Figma's auto layout can reproduce it.
 *
 * snap records each axis: `row-gap` and `column-gap`. Figma's `itemSpacing`
 * is the gap along the layout's direction only, between the items, which in
 * a flex row is CSS's column gap and in a flex column its row gap; the other
 * axis's gap only parts wrapped lines. The readback reports `itemSpacing` on
 * both keys, so comparing both measured axes, `gap-x-2`'s `{ row: 0, column:
 * 8 }` say, would drift on every push that got it right, and a column's gap
 * would be scored against its row's. So a flex element's gap is compared on
 * its main axis alone, the same on both keys; any other display's as it was
 * measured.
 */
function comparableGap(measured: NormalizedStyles, gap: unknown): unknown {
  if (gap == null || typeof gap !== "object" || !String(measured.display ?? "").includes("flex")) return gap;
  const { row, column } = gap as { row: number; column: number };
  const main = String(measured.flexDirection ?? "row").startsWith("column") ? row : column;
  return { row: main, column: main };
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
   *
   * `unverified_readback` is the variant whose readback entry is not one
   * verify can score as what Figma returned: its checksum is missing or does
   * not match, its component's nodeId is missing or another component's too,
   * it lacks a field the readback template always returns, or it was read
   * before the snap. Nothing in it is scored, matched or mismatched, since
   * none of it can be trusted as a reading of Figma now.
   */
  status: "verified" | "drifted" | "missing_from_figma" | "unscored" | "unverified_readback";
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
    /** Measured variants with a readback issue, so nothing in them was scored. */
    unverifiedReadback: number;
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
  /**
   * Readback entries verify cannot score as what Figma returned, measured or
   * not: see ReadbackIssue.
   *
   * Never says what the checksum should have been: that would turn the check
   * into a value to copy in.
   */
  readbackIssues: ReadbackIssue[];
  variants: VariantVerdict[];
}

export interface ReadbackIssue {
  component: string;
  slug: string;
  /**
   * `no_checksum`: the entry carries none, so it was not written as the
   * readback template returned it. `no_node_id`: its component has no
   * `nodeId`, the set's id the checksum is sealed under, so the checksum
   * cannot be checked. `duplicate_node_id`: another component has the same
   * `nodeId`, listed in `sharedWith`. An honest readback reads each component
   * from a set of its own, so one component's entries were copied onto
   * another, `nodeId` and all, where their checksums match as they did; which
   * of the two Figma returned cannot be told, so every entry of both is
   * reported. `checksum_mismatch`: it carries one its contents, set and slug
   * do not produce, so it was edited, composed, or copied from another
   * variant or component, afterwards.
   *
   * The rest are entries whose checksum matches. `incomplete`: it lacks a
   * field the readback template always returns, listed in `missing`, so the
   * template was cut down. `stale`: its `readAt` is missing, is not a time,
   * or falls before the snap it is scored against by more than
   * READ_AT_SKEW_MS, so it was read in an earlier run. An entry can be both.
   */
  problem: "no_checksum" | "no_node_id" | "duplicate_node_id" | "checksum_mismatch" | "incomplete" | "stale";
  /** For `duplicate_node_id`: the other components with the same `nodeId`. */
  sharedWith?: string[];
  /** For `incomplete`: the fields the entry lacks. */
  missing?: string[];
  /** For `stale`: the entry's `readAt`, or null when it has none, or one that is not a string. */
  readAt?: string | null;
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
 * not the same as a mismatch and must not count against the score. (verify
 * itself scores only complete entries, which report every one the template
 * reads: see READBACK_FIELDS.)
 *
 * A text field reported as null, as the readback template reports the text
 * child's on a variant with none, and its size and font where they are
 * mixed, matches only where snap found no text on the variant either: where
 * it found some, Figma lacks the text or sets it in more than one style,
 * which is drift. A null gap, from a frame without auto layout, is compared
 * as any gap is: it matches a measured gap of null or zero, and no other. A
 * flex element's gap is compared on its main axis alone: see comparableGap.
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
  // The text snap measured on the element that owns it, or null where the
  // variant has none.
  const measuredText = measured.text as Record<string, unknown> | null | undefined;

  for (const property of COMPARABLE_PROPERTIES) {
    if (!(property in figma)) continue;
    // A block element's measured size is its container's, not its own.
    if ((property === "width" || property === "height") && !geometryMeaningful) continue;
    const figmaValue = (figma as Record<string, unknown>)[property];
    // Compare like with like: the readback reads these off Figma's text child,
    // so score them against the text styles snap measured on the corresponding
    // descendant. Falls back to the root when the element owns no text. And
    // a flex element's gap on the one axis Figma's itemSpacing spans.
    const measuredValue = TEXT_PROPERTIES.has(property) && measuredText?.[property] != null
      ? measuredText[property]
      : property === "gap"
        ? comparableGap(measured, measured.gap)
        : (measured as unknown as Record<string, unknown>)[property];
    // No text in Figma and none measured: the root's colour and font, which
    // every element has, style no text there to compare them with.
    const noTextEitherSide = TEXT_PROPERTIES.has(property) && figmaValue == null && measuredText == null;

    if (noTextEitherSide || propertyMatches(property, measuredValue, figmaValue, tolerance)) {
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

// --- Readback checksums ------------------------------------------------------
//
// verify compares two local files and cannot contact Figma, so on its own it
// scores whatever the readback file says. On a live push the agent wrote that
// file from snap's values plus the sizes that came off the Figma nodes, rather
// than from what the readback calls returned, and verify then compared snap
// with snap for every property but size: the score said nothing about colour,
// padding, type or radius.
//
// So the skill's readback template computes a checksum of each entry inside
// Figma, over exactly what the call returns, and verify recomputes it. An entry
// edited, or composed from anything else, after Figma returned it no longer
// matches. It is not a signature: the code is in the skill, so an agent that
// deliberately computes it over values it made up will pass. It catches the
// shortcut, not a forgery.
//
// Sealed with it are the set's id and the slug, so an entry copied onto
// another variant, or onto the same slug in another component (every
// component without variant props has the slug `default`), matches neither;
// and readAt, the time Figma read the entry, so one read back in an earlier
// run, before the snap it is scored against, can be told from one read now.
// And a template cut down to fewer fields still seals what it returns, so
// verify also requires every field the shipped template returns; and a whole
// component's entries copied onto another, its nodeId with them, still match
// under that id, so verify also refuses two components with one nodeId.

/** Names the algorithm, so a later change of it reads as one rather than as an edit. */
export const CHECKSUM_PREFIX = "fnv1a:";

/**
 * JSON with every object's keys sorted and no whitespace.
 *
 * Indentation and key order are how a file happens to be written, not what it
 * says, so they must not change the checksum; any change of value must.
 * Numbers are written as JavaScript writes them, the shortest form that reads
 * back as the same double, so 0.0000001, 1E-7 and 1e-7 are one number, while
 * 0.4 and the 0.4000000059604645 Figma reports for it are two. Strings are
 * compared exactly, so a colour's case counts, and null is a value where an
 * absent key is not. Mirrors `canon` in the skill's readback template: the
 * two must agree character for character.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 32-bit FNV-1a over a string's UTF-16 code units, as 8 lowercase hex digits.
 *
 * Over the code units rather than UTF-8 bytes because the plugin context has
 * no TextEncoder; for the ASCII a readback is made of, they are the same.
 * Small enough to paste into every readback call, and a checksum, not a
 * cryptographic hash: nothing here could stop a deliberate forger anyway.
 */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * The checksum the readback template gives an entry: FNV-1a over the
 * canonical JSON of `{ [setId]: { [slug]: entry } }`, without its `checksum`
 * field, where `setId` is the component set's id, the readback's `nodeId`.
 *
 * The set's id and the slug are part of it so that an entry copied onto
 * another variant, or onto the same slug in another component, one read back
 * standing in for one that was not, matches neither. The entry goes through
 * JSON first, as the template's does and as it reached the file, so a field
 * that is undefined is absent on both sides.
 */
export function readbackChecksum(setId: string, slug: string, entry: object): string {
  const { checksum: _checksum, ...rest } = entry as Record<string, unknown>;
  return CHECKSUM_PREFIX + fnv1a32(canonicalJson({ [setId]: { [slug]: JSON.parse(JSON.stringify(rest)) } }));
}

/**
 * The fields the readback template returns on every entry, `null` where
 * there is nothing to report: `source` and every comparable property it
 * reads, which is all of them but `boxShadow` and `flexDirection`.
 *
 * A template cut down to fewer fields still seals what it returns, so its
 * checksums match, and verify scores only the properties an entry reports:
 * cut down to `{ source, width, height }`, it would score 100% on every
 * strict flag without comparing colour, padding, type or radius, and cut
 * down to leave out the text child's three fields and `gap`, without
 * comparing type or spacing. So an entry that lacks any of these is
 * incomplete, and none of it is scored. Where Figma has nothing to report
 * the template returns `null`, never leaves the field out: the text child's
 * fields on a variant with none, `fontSize`, `fontWeight` and `fontFamily`
 * where Figma reports them as mixed, and `gap` on a frame without auto
 * layout. verifyVariant scores those nulls against what snap measured.
 */
export const READBACK_FIELDS = [
  "source", "backgroundColor", "color", "borderRadiusUniform", "padding", "borderUniform",
  "fontSize", "fontWeight", "fontFamily", "gap", "opacity", "width", "height",
] as const;

/**
 * The fields of READBACK_FIELDS an entry lacks. Present as `null` is
 * present; absent, or undefined as JSON leaves it, is not.
 */
export function missingReadbackFields(entry: object): string[] {
  const record = entry as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
  return READBACK_FIELDS.filter((key) => !has(key));
}

/**
 * How far before the snap's `measuredAt` an entry's `readAt` may fall and
 * still count as read after it.
 *
 * `use_figma` runs the plugin code in Figma's environment, not on the machine
 * that ran snap (its fonts are Google's, not the machine's), so `readAt` is
 * Figma's clock and `measuredAt` the machine's. Network time keeps both well
 * within a second as a rule, but a machine whose time sync is off can drift
 * by minutes, and an honest readback follows the snap only by the build calls
 * between them, a minute or two. Five minutes lets the machine's clock run
 * that far ahead of Figma's, and the build's length further, before an honest
 * run fails, while a readback reused from a run more than five minutes before
 * the snap is still caught.
 */
export const READ_AT_SKEW_MS = 5 * 60_000;

export interface ReadbackCheckOptions {
  /**
   * The snap's `measuredAt`, from its meta.json. An entry read before it is
   * stale; without it, only that each entry has a `readAt` is checked.
   */
  measuredAt?: string;
}

/**
 * Every readback entry, measured or not, that verify cannot score as what
 * Figma returned: see ReadbackIssue. A checksum that is missing, a nodeId
 * that is missing or another component's too, or a checksum that does not
 * match, means nothing in the entry can be trusted, its fields and `readAt`
 * included, so that is the one issue reported for it, in that order.
 */
export function checkReadback(readback: ReadbackFile, { measuredAt }: ReadbackCheckOptions = {}): ReadbackIssue[] {
  const issues: ReadbackIssue[] = [];
  const measured = measuredAt == null ? NaN : Date.parse(measuredAt);
  // The components under each nodeId. An honest readback reads each one from
  // a set of its own, so an id under two means one component's entries were
  // copied onto another, nodeId and all.
  const byNodeId = new Map<string, string[]>();
  for (const [component, entry] of Object.entries(readback.components ?? {})) {
    const setId = entry?.nodeId;
    if (typeof setId === "string" && setId !== "") byNodeId.set(setId, [...(byNodeId.get(setId) ?? []), component]);
  }
  for (const [component, entry] of Object.entries(readback.components ?? {})) {
    const setId = entry?.nodeId;
    for (const [slug, variant] of Object.entries(entry?.variants ?? {})) {
      // An entry that is null is a variant Figma never reported, which the
      // scoring reports as missing; there is nothing to check.
      if (variant == null) continue;
      const fields = typeof variant === "object" ? (variant as ReadbackStyles) : null;
      if (fields?.checksum == null) {
        issues.push({ component, slug, problem: "no_checksum" });
        continue;
      }
      if (typeof setId !== "string" || setId === "") {
        issues.push({ component, slug, problem: "no_node_id" });
        continue;
      }
      const sharedWith = (byNodeId.get(setId) ?? []).filter((other) => other !== component);
      if (sharedWith.length > 0) {
        issues.push({ component, slug, problem: "duplicate_node_id", sharedWith });
        continue;
      }
      if (fields.checksum !== readbackChecksum(setId, slug, fields)) {
        issues.push({ component, slug, problem: "checksum_mismatch" });
        continue;
      }
      const missing = missingReadbackFields(fields);
      if (missing.length > 0) issues.push({ component, slug, problem: "incomplete", missing });
      // A readAt that is not a time is no more a reading time than none.
      const readAt = typeof fields.readAt === "string" ? fields.readAt : null;
      const read = readAt == null ? NaN : Date.parse(readAt);
      if (!Number.isFinite(read) || read < measured - READ_AT_SKEW_MS) {
        issues.push({ component, slug, problem: "stale", readAt });
      }
    }
  }
  return issues;
}

/** A variant whose readback entry has an issue: reported, not scored. */
function unverifiedVerdict(component: string, slug: string, figma: unknown): VariantVerdict {
  const declared = typeof figma === "object" ? (figma as ReadbackStyles).source : undefined;
  return {
    component, slug, status: "unverified_readback",
    source: declared === "measured" || declared === "inferred" ? declared : "unrecorded",
    matched: 0, mismatched: 0, differences: [],
  };
}

export function verify(
  snap: SnapResult,
  readback: ReadbackFile,
  tolerance: number,
  options: ReadbackCheckOptions = {},
): VerifyResult {
  const measuredByComponent = expandSnap(snap);
  const verdicts: VariantVerdict[] = [];

  const readbackIssues = checkReadback(readback, options);
  const unverified = new Set(readbackIssues.map((issue) => JSON.stringify([issue.component, issue.slug])));
  // A readback with no components, {"version":1} say, has read nothing back
  // from Figma: every variant is missing from it, as from an empty map.
  const readbackComponents = readback.components ?? {};

  for (const [component, measuredVariants] of measuredByComponent) {
    const figmaComponent = readbackComponents[component];
    for (const [slug, measured] of measuredVariants) {
      const figma = figmaComponent?.variants?.[slug];
      verdicts.push(figma != null && unverified.has(JSON.stringify([component, slug]))
        ? unverifiedVerdict(component, slug, figma)
        : verifyVariant(component, slug, measured, figma, tolerance));
    }
  }

  // The mirror of missing_from_figma: something Figma has that we never
  // measured, and therefore never scored.
  const unmeasuredInFigma: { component: string; slug: string }[] = [];
  for (const [component, entry] of Object.entries(readbackComponents)) {
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
      unverifiedReadback: verdicts.filter((v) => v.status === "unverified_readback").length,
    },
    snapIssues,
    snapWarnings,
    unmeasuredInFigma,
    readbackIssues,
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
