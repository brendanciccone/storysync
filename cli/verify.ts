// Compares what was written to Figma against what was measured in Storybook.
//
// The agent writes the component, then has the plugin read the created node's
// real properties back out and save them as JSON. This module diffs that
// readback against `snap`'s measurements and produces a fidelity score.
//
// Numeric rather than visual on purpose: comparing rendered screenshots means
// feeding images to a model and getting a judgment, where comparing measured
// values is deterministic, cheap, and reproducible.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { canonicalJson, fnv1a32 } from "./checksum.js";
import { sameFamily } from "./fonts.js";
import { applyDelta, isFontKeyword } from "./snap-normalize.js";
import { expandTree, rootWithStyles, treeDigest } from "./tree-types.js";
import type { ComponentTree, TreeDelta, TreeNode } from "./tree-types.js";
import { SPIKE, recordProblem, scoreTree } from "./verify-tree.js";
import type { NodeVerdict, ReadRecord, SpikeAssumptions, UnscorableProperty } from "./verify-tree.js";
import type { NormalizedStyles, BorderSide, BoxShadowLayer, TextLayout } from "./snap-normalize.js";
import {
  SNAP_META_FILENAME, describeOpenedOverlays, describeVariantStories, detectIdenticalVariants, parseBehaviorOnlyWarning, parseMeasurementWarning,
  parseSnapWarning,
} from "./snap.js";
import { NO_STORY_FIX } from "./snap-args.js";
import { componentKey, componentNames, selectComponents } from "./storybook.js";
import type { ComponentEntry } from "./storybook.js";
import type { SnapComponent, SnapResult, SnapVariant } from "./snap.js";

/**
 * A snap's component and variant with the element-tree fields snap writes
 * (design section 7.2), as verify reads them: a component's `tree`, a
 * variant's `treeDelta` against it, and `innerElements`, the inner elements
 * `snap --root-only` counted without measuring.
 */
type TreeComponent = SnapComponent & { tree?: ComponentTree };
type TreeVariant = SnapVariant & { treeDelta?: TreeDelta; innerElements?: number };
const treeOf = (component: SnapComponent): ComponentTree | undefined => (component as TreeComponent).tree;

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
export type StyleSource = "measured" | "inferred" | "unmeasured";

export interface ReadbackStyles {
  /** Omitted by older writers; treated as `unrecorded`, never as measured. */
  source?: StyleSource;
  /**
   * Colors as snap writes them: `#rrggbb`, `#rrggbbaa` when translucent, and
   * null when nothing is drawn, so a Figma paint's opacity is the alpha byte.
   */
  backgroundColor?: string | null;
  color?: string | null;
  borderRadiusUniform?: number | null;
  borderRadius?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  padding?: { top: number; right: number; bottom: number; left: number };
  /** The stroke, its `style` read from its dash pattern: solid, dashed or dotted. */
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
   * The text child's width and the line Figma ends it in an ellipsis after,
   * its `maxLines`, null where it isn't cut off, where the text has a fixed
   * width or is cut off; null where it hugs its content, or there is none.
   * Compared where snap measured how the browser fitted the text, its
   * `text.layout`, and only there: see sameTextLayout. A readback from an
   * earlier template has none, and isn't compared on it.
   */
  textLayout?: ReadbackTextLayout | null;
  /**
   * The variable each field is bound to, by name, for the fields bound to
   * one: `backgroundColor`, `color`, `borderColor`, `borderRadiusUniform`,
   * the four `padding` sides, `gap` and `fontSize`. Not scored: see
   * bindingReport. An earlier template's readback has none.
   */
  bound?: Record<string, string>;
  /**
   * The fields of those bound to no variable, though a local variable of
   * the field's kind has the value they show, in one of its modes: a token
   * detached in Figma at the same value, or one the push never bound. The
   * template matches a field only with variables of its kind, by their
   * scopes or else their collection, so a padding of 8 isn't taken for a
   * radius of 8.
   */
  unbound?: string[];
  /**
   * The element-tree readback's (templates/readback.js, `tpl: 4`; 3
   * before its records read a layer's turn, 2 before its T records said
   * whether Figma cuts a text short): the
   * variant's name in Figma; the digest of the facts the build built it
   * from, `built`; for a variant read in parts, which records this part
   * holds, `part: [first, count, total]`; the records, `tree`; and the
   * layers nothing keyed, `designerLayers`, as `[name, type, id]`. All
   * sealed under the checksum, so verify can trust each as read.
   */
  tpl?: number;
  name?: string;
  built?: string | null;
  part?: [first: number, count: number, total: number];
  tree?: ReadRecord[];
  designerLayers?: [name: string, type: string, id: string][];
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

/** See ReadbackStyles.textLayout. */
export interface ReadbackTextLayout {
  width: number;
  maxLines: number | null;
}

export interface ReadbackFile {
  version: number;
  fileKey?: string;
  components: Record<string, {
    /** The component set's id, which every entry's checksum is sealed under. */
    nodeId?: string;
    /**
     * From the element-tree readback's read calls (figma-results.ts):
     * every variant in Figma's set, read or not, and the names of those
     * without a slug, which storysync's element-tree build didn't make (a
     * designer's, or one an earlier storysync built). Not sealed, since
     * nothing is scored from them: verify lists, from them, the variants
     * in Figma it couldn't read. See VerifyResult.unreadInFigma.
     */
    total?: number;
    unbuilt?: string[];
    /** Keyed by the variant slug `snap` emitted. */
    variants: Record<string, ReadbackStyles>;
  }>;
}

/** Properties compared, in report order. */
export const COMPARABLE_PROPERTIES = [
  "backgroundColor", "color", "borderRadiusUniform", "padding", "borderUniform",
  "boxShadow", "fontSize", "fontWeight", "fontFamily", "gap", "flexDirection", "opacity",
  "width", "height", "textLayout",
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
   *
   * `not_read` is the variant a planned read call was to read, under
   * `verify --plan`, that has no entry because the call wasn't read whole:
   * its result, or a continuation's, isn't saved, holds no read, or is from
   * before the reading it continues. Not missing from Figma, since nothing
   * looked; not scored either, its elements left out of the score as an
   * unverified entry's are.
   */
  status: "verified" | "drifted" | "missing_from_figma" | "unscored" | "unverified_readback" | "not_measured" | "parts_missing" | "not_read";
  /** `unrecorded` when the writer did not say — not the same as measured. */
  source: StyleSource | "unrecorded";
  matched: number;
  mismatched: number;
  differences: PropertyDiff[];
  /**
   * Properties snap measured on this variant that the entry, read with an
   * earlier template, has no field for, so they weren't compared: only
   * `textLayout`, where snap measured how the browser fitted the text. Left
   * out where there are none. See VerifyResult.uncompared.
   */
  uncompared?: string[];
  /**
   * For a variant scored element by element: its elements, snap's nodes
   * and the keyed layers snap lacks, and how they scored, `fidelity` being
   * the sum of their scores over their number. Only then.
   */
  elements?: { measured: number; verified: number; drifted: number; missing: number; extra: number; fidelity: number | null };
  /** The elements that are not verified, by key. */
  nodes?: NodeVerdict[];
  /** The variant's name in Figma, as the readback sealed it. */
  name?: string;
  /**
   * For `not_measured`: why snap couldn't measure it, its status and error,
   * and whether snap's warning for the component names a story change that
   * would let it (only an `arg_rejected` variant's can).
   */
  unmeasured?: { status: string; error: string | null; storyChange: boolean };
  /** Layers in the variant nothing keyed, a designer's: listed, not scored. */
  designerLayers?: [name: string, type: string, id: string][];
  /**
   * True where snap measured the variant's tree and its readback, from a
   * template before trees, has none: its root was scored as before, and
   * nothing under it. A --strict failure.
   */
  childrenNotReadBack?: true;
}

export interface SnapAgeKnown {
  known: true;
  /** When the snap was measured; for a merged snap, its oldest component. */
  measuredAt: string;
  ageMs: number;
  storybookUrl?: string;
  /** True once older than the configured limit. */
  stale: boolean;
  /** When each component was measured, for a snap `snap --merge` wrote: see SnapMeta. */
  componentsMeasuredAt?: Record<string, string>;
}

/**
 * Why the age could not be established.
 *
 * Modeled explicitly rather than as an absent value: `meta.json` is the file a
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
    /**
     * The rest only where a snap has trees or a readback holds element
     * records. Variants snap couldn't measure that Figma has a placeholder
     * for: listed, never scored. A --strict-measured failure.
     */
    notMeasured?: number;
    /** Variants read in parts that don't add up, so nothing in them was scored. */
    partsMissing?: number;
    /** Variants in Figma's sets verify couldn't read: see VerifyResult.unreadInFigma. A --strict-measured failure. */
    unread?: number;
    /** Under --plan: variants a planned read wasn't read whole for, so nothing read them (status `not_read`). */
    notRead?: number;
    /** Elements across the variants scored: see VariantVerdict.elements. */
    elements?: {
      measured: number;
      verified: number;
      drifted: number;
      missing: number;
      extra: number;
      /** Layers a designer added inside variants. */
      designerLayers: number;
      /** Nodes under roots whose readback has no tree: see VariantVerdict.childrenNotReadBack. */
      notReadBack: number;
      /**
       * Variants in Figma's sets that snap no longer measures, read back
       * or not (unmeasuredInFigma, and unreadInFigma's `uncovered`), as an
       * earlier push left under other properties: extra in the headline,
       * and a --strict failure until the user has them removed.
       */
      extraVariants?: number;
    };
  };
  /**
   * Where a snap has trees: the elements' scores summed over their number,
   * 0-1, the headline score, beside `fidelity`, the share of properties.
   * Null when no element was scored. Absent for a snap without trees, which
   * is scored as before.
   */
  elementFidelity?: number | null;
  /**
   * What verify can't score, by component, element and property, with the
   * number of variants each is in: a font named by a CSS keyword, a CSS
   * feature Figma doesn't draw. Never in a denominator.
   */
  unscorable?: (UnscorableProperty & { component: string; variants: number })[];
  /** The properties scored over those plus the ones `unscorable` counts, 0-1. */
  coverage?: number | null;
  /** Planned read calls not read whole, by seq: see figma-results.ts. A --strict failure. */
  notRead?: number[];
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
   * What snap warned about a scored component's measurement that a score
   * can't show: snap measured a closed trigger or what may be a layout
   * wrapper rather than the component, its variants all measured the same,
   * or a VARIANT property's default is assumed. Figma can match such a measurement
   * exactly, so 100% on a dialog's trigger is not a faithful dialog.
   * Also some of its values or properties measuring the same, values set
   * through Storybook's preview, a font the browser couldn't render, and,
   * as `snap-warning`, every other warning snap wrote about it, as written,
   * so none is dropped (unsaidWarnings).
   * Reported beside the score; not a --strict failure.
   */
  caveats: ScoreCaveat[];
  /**
   * Readback components the snap has no record of at all: measured by
   * another snap run, as one re-run with `--components` and without
   * `--merge` leaves styles.json, or never. Nothing in them is scored, and
   * they fail --strict, since a score over the rest is not a score of the
   * push.
   */
  componentsNotInSnap: string[];
  /**
   * Components left out of the score as `--skip` asked, by key: ones the
   * user chose not to push, which the snap still holds. Said beside the
   * score, since it is a score of the rest.
   */
  skipped: string[];
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
   * Where an element-tree readback says what else a component's set in
   * Figma holds (ReadbackFile `total` and `unbuilt`): variants it couldn't
   * read, which are written to Figma but unscored, as unmeasuredInFigma
   * are. `unbuilt`, by name, have no slug: storysync's element-tree build
   * didn't make them, a designer or an earlier storysync did. `uncovered`
   * counts those with a slug no read call covered: one an earlier push
   * built for a variant this snap no longer measures. Not counted while a
   * planned read has no result (`notRead`), which leaves variants unread
   * already. A --strict-measured failure.
   */
  unreadInFigma?: { component: string; unbuilt: string[]; uncovered: number }[];
  /** What the readback says of variable bindings: see bindingReport. */
  bindings: BindingReport;
  /**
   * Per component and property, how many scored variants snap measured it
   * on that their entry has no field for: a text the browser wrapped or cut
   * off, and an entry an earlier template read, without `textLayout`. Not
   * drift, since nothing was compared, but not a match either: a title
   * that runs past its card scored 100% that way. A --strict failure.
   */
  uncompared: { component: string; property: string; variants: number }[];
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

/**
 * What the readback entries verify could score say of variable bindings,
 * from a template that reads them: see bindingReport.
 */
export interface BindingReport {
  /** Entries that carry bindings. Fewer than were scored means a readback from an earlier template. */
  read: number;
  /** Fields bound to a variable, across those entries. */
  bound: number;
  /**
   * Per component and field, how many variants have it bound to no
   * variable though a local variable of its kind has its value: a token
   * detached in Figma at the same value, or one the push left unbound, as
   * it does where several variables share a value and the source names
   * none.
   */
  unbound: { component: string; field: string; variants: number }[];
}

export interface ScoreCaveat {
  component: string;
  /**
   * `behavior-only`: every variant measured the same though the markup
   * changed with the args, so they reach the component and its properties
   * change nothing snap measures, rather than the story dropping them, as
   * `identical-variants` has it.
   */
  kind: "closed-trigger" | "layout-wrapper" | "identical-variants" | "behavior-only" | "default-assumed" | "args-rejected" | "args-unchecked"
    | "identical-values" | "no-op-properties" | "preview-set" | "font-not-rendered" | "snap-warning" | "variant-stories" | "opened"
    | "root-only" | "truncated-tree" | "built-from-other-measurement";
  /** The element snap measured, for a closed trigger or a layout wrapper. */
  element?: string;
  /** For a closed trigger: why snap didn't open it, as its warning says. */
  reason?: string;
  /**
   * The properties whose default is assumed, for `default-assumed`, that
   * change nothing measured, for `behavior-only`, or whose every value
   * measured the same, for `no-op-properties`.
   */
  properties?: string[];
  /**
   * For `args-rejected`: the values Storybook wouldn't give the story, as
   * `prop=value`, and how many variants snap therefore didn't measure. For
   * `preview-set`: the values the story's URL wouldn't take, which snap set
   * through Storybook's preview, and how many variants it measured so. For
   * `identical-values`: values of one property that measured the same.
   */
  values?: string[];
  variants?: number;
  /**
   * For `font-not-rendered`: the fonts the browser couldn't render, so it
   * drew another. Named `font-stand-in` until snap drew text in stand-ins
   * of its own, Figma's fonts, which a component's `fontStandIns` lists:
   * nothing reads a caveat back, so no file holds the old name to read.
   */
  fonts?: string[];
  /** For `snap-warning`: a warning of snap's no other kind stands for, as snap wrote it. */
  warning?: string;
  /**
   * For `variant-stories`, said rather than warned: the stories variants
   * were measured from other than the component's, each with the variants'
   * slugs, and `note`, which says it as snap did. For `opened`, also said
   * rather than warned: how snap opened the overlay it measured, as `note`
   * (describeOpenedOverlays).
   */
  stories?: { story: string; slugs: string[] }[];
  note?: string;
  /**
   * For `args-unchecked`: the variants snap measured without being able to
   * check that Storybook gave the story their values, so any of them may
   * have scored the story's default. `variants` counts them. For
   * `built-from-other-measurement`: the variants Figma says were built from
   * other facts than these, a snap taken since the push; the score still
   * says what Figma has.
   */
  slugs?: string[];
  /**
   * For `root-only`: snap measured only the component's outer element, so
   * only it was compared, and this many inner elements went unmeasured,
   * where snap counted them.
   */
  innerElements?: number;
  /** For `truncated-tree`: the nodes snap found, and the key of the first it left out. */
  nodes?: number;
  at?: string;
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
   * variant or component, afterward.
   *
   * The rest are entries whose checksum matches. `incomplete`: it lacks a
   * field the readback template always returns, listed in `missing`, so the
   * template was cut down. `stale`: its `readAt` is missing, is not a time,
   * or falls before the snap it is scored against by more than
   * READ_AT_SKEW_MS, so it was read in an earlier run. An entry can be both.
   */
  problem: "no_checksum" | "no_node_id" | "duplicate_node_id" | "checksum_mismatch" | "incomplete" | "stale" | "parts_missing" | "name_mismatch";
  /** For `duplicate_node_id`: the other components with the same `nodeId`. */
  sharedWith?: string[];
  /** For `incomplete`: the fields the entry lacks. */
  missing?: string[];
  /** For `stale`: the entry's `readAt`, or null when it has none, or one that is not a string. */
  readAt?: string | null;
  /** For `stale`: when its component was measured, where a merged snap gives each its own time. */
  measuredAt?: string;
  /**
   * For `name_mismatch`: the variant's name in Figma, as the entry sealed
   * it, and the name snap's combination gives its slug. A variant renamed,
   * or a slug moved onto another variant, isn't scored.
   */
  name?: string;
  expected?: string;
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
  // A dashed or dotted border built as a solid stroke is drift, as is one
  // whose style Figma's strokes cannot draw: a double border built solid.
  const style = (side: BorderSide) => String(side.style ?? "solid").toLowerCase();
  return closeEnough(x.width, y.width, tolerance) && sameColor(x.color, y.color) && style(x) === style(y);
}

function sameShadows(a: unknown, b: unknown, tolerance: number, spike: SpikeAssumptions): boolean {
  const xs = (a ?? []) as BoxShadowLayer[];
  const ys = (b ?? []) as BoxShadowLayer[];
  if (xs.length !== ys.length) return false;
  return xs.every((x, i) => {
    const y = ys[i];
    return closeEnough(x.offsetX, y.offsetX, tolerance)
      && closeEnough(x.offsetY, y.offsetY, tolerance)
      && closeEnough(x.blur, y.blur, tolerance)
      // Figma keeps a spread, as the spike saw (verify-tree SPIKE).
      && (!spike.shadowSpreadKept || closeEnough(x.spread, y.spread, tolerance))
      && sameColor(x.color, y.color)
      // An inset ring built as a drop shadow draws outside the element.
      && Boolean(x.inset) === Boolean(y.inset);
  });
}

/**
 * Whether Figma fits the text as the browser did: at the width it was laid
 * out in, and, where the browser cut it off, ending in an ellipsis after as
 * many lines as it drew, or, where it wrapped, not cut off at all. Figma has
 * no flat cut, so text the browser clipped is built ending in an ellipsis,
 * and matches one. A text that hugs its content reads as null, and matches
 * none: a live push built Attachment's truncated title that way, and it ran
 * past its card.
 */
function sameTextLayout(measured: unknown, figma: unknown, tolerance: number): boolean {
  const want = measured as TextLayout;
  const got = figma as ReadbackTextLayout | null;
  if (got == null || typeof got !== "object") return false;
  const width = closeEnough(want.width, Number(got.width), geometryTolerance(tolerance, want.width, got.width));
  return width && (want.truncation ? got.maxLines === want.lines : got.maxLines == null);
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
 * `spike` is what Figma does, as the spike saw it (verify-tree SPIKE):
 * whether a shadow's spread survives, here.
 */
export function propertyMatches(
  property: ComparableProperty,
  measured: unknown,
  figma: unknown,
  tolerance: number,
  spike: SpikeAssumptions = SPIKE,
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
      return sameFamily(String(measured ?? ""), String(figma ?? ""));
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
      return sameShadows(measured, figma, tolerance, spike);
    case "flexDirection":
      return String(measured ?? "").toLowerCase() === String(figma ?? "").toLowerCase();
    case "textLayout":
      return sameTextLayout(measured, figma, tolerance);
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
  spike: SpikeAssumptions = SPIKE,
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

  const uncompared: string[] = [];

  for (const property of COMPARABLE_PROPERTIES) {
    if (!(property in figma)) {
      // An entry an earlier template read has no textLayout. Where snap
      // measured one, that is a property it can't compare, not one that
      // matched, so it is said beside the score.
      if (property === "textLayout" && (measuredText as { layout?: TextLayout } | null | undefined)?.layout) uncompared.push(property);
      continue;
    }
    // A block element's measured size is its container's, not its own.
    if ((property === "width" || property === "height") && !geometryMeaningful) continue;
    // Only where the browser wrapped or cut the text off: a label on one
    // line at its own width is one Figma's own metrics set a pixel apart,
    // however it is built.
    if (property === "textLayout") {
      const layout = (measuredText as { layout?: TextLayout } | null | undefined)?.layout;
      if (!layout) continue;
      if (sameTextLayout(layout, figma.textLayout, tolerance)) {
        matched++;
      } else {
        mismatched++;
        differences.push({ property, status: "mismatch", measured: layout, figma: figma.textLayout });
      }
      continue;
    }
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
    // No text in Figma and none measured: the root's color and font, which
    // every element has, style no text there to compare them with.
    const noTextEitherSide = TEXT_PROPERTIES.has(property) && figmaValue == null && measuredText == null;
    // A family snap measured as a CSS keyword, `system-ui` or `sans-serif`,
    // names the platform's font, which no Figma font is called, so whatever
    // the push set it to would drift on every variant with no fix to make.
    // Unscored, as `lineHeight: "normal"` is.
    if (!noTextEitherSide && property === "fontFamily" && typeof measuredValue === "string" && isFontKeyword(measuredValue)) continue;

    if (noTextEitherSide || propertyMatches(property, measuredValue, figmaValue, tolerance, spike)) {
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
    ...(uncompared.length > 0 ? { uncompared } : {}),
  };
}

/**
 * Rebuilds each variant's full styles from the base plus its delta, by
 * component key: its title, as the readback is keyed, else its ID.
 */
export function expandSnap(snap: SnapResult): Map<string, Map<string, NormalizedStyles>> {
  const byComponent = new Map<string, Map<string, NormalizedStyles>>();
  for (const component of snap.components) {
    if (!component.base) continue;
    const variants = new Map<string, NormalizedStyles>();
    for (const variant of component.variants) {
      if (variant.status !== "ok") continue;
      variants.set(variant.slug, applyDelta(component.base.styles, variant.delta ?? {}));
    }
    byComponent.set(componentKey(component), variants);
  }
  return byComponent;
}

// --- Readback checksums ------------------------------------------------------
//
// verify compares two local files and cannot contact Figma, so on its own it
// scores whatever the readback file says. On a live push the agent wrote that
// file from snap's values plus the sizes that came off the Figma nodes, rather
// than from what the readback calls returned, and verify then compared snap
// with snap for every property but size: the score said nothing about color,
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

// In checksum.ts, which the element tree shares; re-exported for existing importers.
export { canonicalJson, fnv1a32 };

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
 * strict flag without comparing color, padding, type or radius, and cut
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
 * The fields the readback template returns that verify doesn't require of
 * every entry: `textLayout`, `bound` and `unbound`, added after
 * READBACK_FIELDS, so a readback an earlier template read, which has none
 * of them, still verifies. Each is sealed under the checksum like any
 * other where an entry has it. An entry without them says nothing of
 * bindings, and where snap measured how the browser fitted its text, isn't
 * compared on how Figma fits it: verify says both beside the score, and
 * --strict fails on the second (see VerifyResult.uncompared). The template
 * that returns one returns all three, so an entry with some but not all
 * was read with the template cut down, and is incomplete: a template cut
 * down to leave out `textLayout` alone would otherwise score a title that
 * runs past its card as one never compared.
 */
export const READBACK_LATER_FIELDS = ["textLayout", "bound", "unbound"] as const;

/**
 * Fields the root-only template returns that verify scores where an entry
 * has them and requires of none: `boxShadow`, each shadow as snap writes
 * a box-shadow layer, which a readback read before the template returned
 * it lacks, and is still scored without.
 */
export const READBACK_SCORED_IF_PRESENT = ["boxShadow"] as const;

/**
 * The fields the element-tree template (templates/readback.js) returns on
 * an entry beside READBACK_FIELDS, `boxShadow` among them, or on a later
 * part of a variant read in parts, which carries no root fields.
 */
export const READBACK_TREE_FIELDS = ["boxShadow", "name", "tpl", "built", "tree", "designerLayers"] as const;
export const READBACK_PART_FIELDS = ["name", "source", "tpl", "built", "part", "tree"] as const;

/** Fields only the element-tree template returns: an entry with any is one it read. */
const TREE_MARKS = ["tpl", "tree", "built", "part", "designerLayers"];

/**
 * The fields of READBACK_FIELDS an entry lacks, and, where it has any of
 * READBACK_LATER_FIELDS, those of them it lacks. Present as `null` is
 * present; absent, or undefined as JSON leaves it, is not.
 *
 * An entry the element-tree template read must have its fields too
 * (READBACK_TREE_FIELDS, or READBACK_PART_FIELDS on a later part), and
 * each record in its tree the length its kind has: one shorter was read
 * with the template cut down to leave a property out, and would otherwise
 * score as though that property matched.
 */
export function missingReadbackFields(entry: object): string[] {
  const record = entry as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
  if (TREE_MARKS.some(has)) {
    const part = record.part;
    const later = Array.isArray(part) && Number(part[0]) > 0;
    const fields = later ? READBACK_PART_FIELDS : [...READBACK_FIELDS, ...READBACK_TREE_FIELDS];
    const missing: string[] = fields.filter((key) => !has(key));
    if (has("tree")) {
      if (!Array.isArray(record.tree)) missing.push("tree, as a list of records");
      else record.tree.forEach((r, i) => {
        const problem = recordProblem(r, i, record.tpl);
        if (problem) missing.push(problem);
      });
    }
    return missing;
  }
  const later = READBACK_LATER_FIELDS.some(has) ? READBACK_LATER_FIELDS.filter((key) => !has(key)) : [];
  return [...READBACK_FIELDS.filter((key) => !has(key)), ...later];
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
  /**
   * When each component was measured, by key, from a merged snap's
   * meta.json. An entry is held to its own component's time where this
   * gives one: a component measured again after the rest, and its readback
   * from before that, is stale though the rest are not.
   */
  componentsMeasuredAt?: Record<string, string>;
}

/**
 * Every readback entry, measured or not, that verify cannot score as what
 * Figma returned: see ReadbackIssue. A checksum that is missing, a nodeId
 * that is missing or another component's too, or a checksum that does not
 * match, means nothing in the entry can be trusted, its fields and `readAt`
 * included, so that is the one issue reported for it, in that order.
 */
export function checkReadback(readback: ReadbackFile, { measuredAt, componentsMeasuredAt }: ReadbackCheckOptions = {}): ReadbackIssue[] {
  const issues: ReadbackIssue[] = [];
  // The components under each nodeId. An honest readback reads each one from
  // a set of its own, so an id under two means one component's entries were
  // copied onto another, nodeId and all.
  const byNodeId = new Map<string, string[]>();
  for (const [component, entry] of Object.entries(readback.components ?? {})) {
    const setId = entry?.nodeId;
    if (typeof setId !== "string" || setId === "") continue;
    const group = byNodeId.get(setId);
    if (group) group.push(component);
    else byNodeId.set(setId, [component]);
  }
  for (const [component, entry] of Object.entries(readback.components ?? {})) {
    const setId = entry?.nodeId;
    // One list for all of the component's variants, not a copy each.
    const sharedWith = typeof setId === "string" ? (byNodeId.get(setId) ?? []).filter((other) => other !== component) : [];
    const own = componentsMeasuredAt?.[component];
    const measured = Date.parse(own ?? measuredAt ?? "");
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
        issues.push({ component, slug, problem: "stale", readAt, ...(own != null ? { measuredAt: own } : {}) });
      }
    }
  }
  return issues;
}

/** A variant whose readback entry has an issue: reported, not scored. */
function unverifiedVerdict(component: string, slug: string, figma: unknown): VariantVerdict {
  const declared = figma != null && typeof figma === "object" ? (figma as ReadbackStyles).source : undefined;
  return {
    component, slug, status: "unverified_readback",
    source: declared === "measured" || declared === "inferred" || declared === "unmeasured" ? declared : "unrecorded",
    matched: 0, mismatched: 0, differences: [],
  };
}

export interface VerifyOptions extends ReadbackCheckOptions {
  /** Components to leave out of the score: see withoutComponents. */
  skip?: readonly string[];
  /**
   * The only components to score, by componentKey: a plan's (`verify
   * --plan`), as a snap that kept other pushes' components holds more
   * than it built. Absent, every component the snap holds.
   */
  only?: readonly string[];
  /** Score every variant by its root alone, as before trees, for comparison (`--roots-only`). */
  rootsOnly?: boolean;
  /** Planned read calls not read whole, from loadPlanResults: reported, and a --strict failure. */
  notRead?: number[];
  /**
   * What those calls were to read, as plan.json's slices: [storysync id,
   * first variant index, last]. A variant in one with no entry is
   * `not_read` rather than missing from Figma.
   */
  notReadSlices?: [componentId: string, firstI: number, lastI: number][];
  /** What Figma does, as the spike saw it: see verify-tree SPIKE. */
  spike?: SpikeAssumptions;
  /**
   * Whether layers a designer added inside variants pass --strict
   * (`--allow-designer-layers`). verify lists them either way; this is
   * read by treeStrictFailures, which takes the same options.
   */
  allowDesignerLayers?: boolean;
}

/**
 * The snap and the readback without the components `names` gives, each
 * matched by ID, title, name or title's last segment, ignoring case, as
 * `--components` matches them, or by its key in the readback. These are
 * components the user chose not to push, such as a dialog snap measured
 * closed: the snap still holds them, so verify would count each of their
 * variants as missing from Figma, and --strict fail on them. A name that
 * matches nothing throws, as a typo would leave a component in to fail.
 * No names leaves everything in. Returns the keys it left out.
 */
export function withoutComponents(
  snap: SnapResult,
  readback: ReadbackFile,
  names: readonly string[] | undefined,
): { snap: SnapResult; readback: ReadbackFile; skipped: string[] } {
  if (!componentNames(names).length) return { snap, readback, skipped: [] };
  const components = snap.components ?? [];
  const readbackKeys = Object.keys(readback.components ?? {});
  const entries = components.map((c): ComponentEntry => ({ id: c.id ?? componentKey(c), name: c.name, title: c.title }));
  const chosen = new Set(selectComponents(entries, names, readbackKeys, "--skip"));
  const left = components.filter((_, i) => chosen.has(entries[i]));
  const wanted = new Set(componentNames(names).map((n) => n.toLowerCase()));
  const skipped = new Set(left.map((c) => componentKey(c)));
  for (const key of readbackKeys) if (wanted.has(key.toLowerCase())) skipped.add(key);

  const kept = components.filter((_, i) => !chosen.has(entries[i]));
  const variants = left.flatMap((c) => c.variants ?? []);
  const summary = snap.summary && {
    ...snap.summary,
    components: snap.summary.components - left.length,
    variants: snap.summary.variants - variants.length,
    rendered: snap.summary.rendered - variants.filter((v) => v.status === "ok").length,
    failed: snap.summary.failed - variants.filter((v) => v.status !== "ok").length,
    componentsFailed: snap.summary.componentsFailed - left.filter((c) => c.error != null).length,
  };
  const readbackComponents = Object.fromEntries(Object.entries(readback.components ?? {}).filter(([key]) => !skipped.has(key)));
  return {
    snap: { ...snap, components: kept, summary },
    readback: { ...readback, components: readbackComponents },
    skipped: [...skipped].sort(),
  };
}

/**
 * `snap` with only the components `keys` names, by componentKey, and its
 * summary counting those: the components a plan built, of a snap that kept
 * the components of other pushes too, which aren't missing from Figma for
 * not being in this plan's readback.
 */
export function onlyComponents(snap: SnapResult, keys: readonly string[]): SnapResult {
  const wanted = new Set(keys);
  const components = (snap.components ?? []).filter((c) => wanted.has(componentKey(c)));
  if (components.length === (snap.components ?? []).length) return snap;
  const variants = components.flatMap((c) => c.variants ?? []);
  const summary = snap.summary && {
    ...snap.summary,
    components: components.length,
    variants: variants.length,
    rendered: variants.filter((v) => v.status === "ok").length,
    failed: variants.filter((v) => v.status !== "ok").length,
    componentsFailed: components.filter((c) => c.error != null).length,
    componentsWithWarnings: components.filter((c) => (c.warnings ?? []).length > 0).length,
    componentsCapped: components.filter((c) => c.cap != null).length,
  };
  return { ...snap, components, summary };
}

export function verify(
  snapIn: SnapResult,
  readbackIn: ReadbackFile,
  tolerance: number,
  options: VerifyOptions = {},
): VerifyResult {
  const left = withoutComponents(snapIn, readbackIn, options.skip);
  const { readback, skipped } = left;
  const snap = options.only ? onlyComponents(left.snap, options.only) : left.snap;
  const spike = options.spike ?? SPIKE;
  const measuredByComponent = expandSnap(snap);
  const verdicts: VariantVerdict[] = [];
  // A readback with no components, {"version":1} say, has read nothing back
  // from Figma: every variant is missing from it, as from an empty map.
  const readbackComponents = readback.components ?? {};

  // Element by element where snap measured trees, unless asked to score
  // as before; and the element-tree readback's own checks wherever it read.
  const treeMode = !options.rootsOnly && (snap.components ?? []).some((c) => treeOf(c) != null);
  const treeRead = Object.values(readbackComponents).some((c) => Object.values(c?.variants ?? {}).some((e) => isTreeEntry(e)));
  const extended = treeMode || treeRead;

  const readbackIssues = checkReadback(readback, options);
  if (treeRead) readbackIssues.push(...checkTreeReadback(snap, readback, readbackIssues));
  // An issue on any part of a variant read in parts is the variant's, the
  // first one: checkTreeReadback adds parts_missing or name_mismatch only
  // to a variant with none yet.
  const unverified = new Map<string, ReadbackIssue>();
  for (const issue of readbackIssues) {
    const key = JSON.stringify([issue.component, slugOfKey(issue.slug)]);
    if (!unverified.has(key)) unverified.set(key, issue);
  }

  // The component each key scores, the last of two with one key, as
  // expandSnap keeps it.
  const componentByKey = new Map<string, SnapComponent>();
  for (const component of snap.components ?? []) if (component.base) componentByKey.set(componentKey(component), component);

  const elements = { measured: 0, verified: 0, drifted: 0, missing: 0, extra: 0, designerLayers: 0, notReadBack: 0 };
  let elementScore = 0;
  const unscorable = new Map<string, UnscorableProperty & { component: string; variants: number }>();
  const builtElsewhere = new Map<string, string[]>();
  const notMeasuredSlugs = new Set<string>();

  for (const [component, measuredVariants] of measuredByComponent) {
    const figmaComponent = readbackComponents[component];
    const snapComponent = componentByKey.get(component)!;
    const tree = treeMode ? treeOf(snapComponent) : undefined;
    // The id figma code keys a set's read slices by, and a variant's index.
    const componentId = snapComponent.id ?? component;
    for (const [index, variant] of (snapComponent.variants ?? []).entries()) {
      const slug = variant.slug;
      const figma = figmaComponent?.variants?.[slug];
      if (variant.status !== "ok") {
        // A placeholder the element-tree build made for a variant snap
        // couldn't measure: listed, never scored.
        if (isTreeEntry(figma)) {
          notMeasuredSlugs.add(JSON.stringify([component, slug]));
          verdicts.push({
            component, slug, status: "not_measured", source: sourceOf(figma), matched: 0, mismatched: 0, differences: [],
            ...(typeof figma!.name === "string" ? { name: figma!.name } : {}),
            unmeasured: unmeasuredOf(snapComponent, variant),
          });
        }
        continue;
      }
      const measured = measuredVariants.get(slug);
      if (!measured) continue;
      // Read, whole or in parts: a variant whose first part is missing has
      // the others, which say it was read, and the issue that it wasn't
      // read whole.
      const parts = partsOf(figmaComponent?.variants, slug);
      const issue = parts.length ? unverified.get(JSON.stringify([component, slug])) : undefined;
      if (issue) {
        // Nothing in it scored; parts that don't add up said as such.
        verdicts.push(issue.problem !== "parts_missing"
          ? unverifiedVerdict(component, slug, figma)
          : { ...unverifiedVerdict(component, slug, parts[0]), status: "parts_missing" });
        continue;
      }
      // Nothing read it, so nothing says whether Figma has it.
      if (!parts.length && options.notReadSlices?.some(([id, first, last]) => id === componentId && index >= first && index <= last)) {
        verdicts.push({ component, slug, status: "not_read", source: "unrecorded", matched: 0, mismatched: 0, differences: [] });
        continue;
      }
      if (!extended) {
        verdicts.push(verifyVariant(component, slug, measured, figma, tolerance, spike));
        continue;
      }

      let nodes: TreeNode[] | null = null;
      if (tree) {
        try {
          nodes = expandTree(tree, (variant as TreeVariant).treeDelta);
        } catch (err) {
          throw new Error(`${component} ${slug}: snap's tree can't be expanded, so styles.json is broken: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (nodes && figma != null && isTreeEntry(figma)) {
        const records = recordsOf(figmaComponent!.variants, slug);
        const scored = scoreTree({ nodes, styles: measured, assets: tree!.assets, records, tolerance, spike });
        const counted = scored.measured + scored.extra;
        elements.measured += scored.measured;
        elements.verified += scored.verified;
        elements.drifted += scored.drifted;
        elements.missing += scored.missing;
        elements.extra += scored.extra;
        elementScore += scored.score;
        const designer = Array.isArray(figma.designerLayers) ? figma.designerLayers : [];
        elements.designerLayers += designer.length;
        for (const u of scored.unscorable) addUnscorable(unscorable, component, u);
        if (tree!.truncated) addUnscorable(unscorable, component, { key: tree!.truncated.at, property: "subtree", reason: `snap stopped at ${tree!.truncated.nodes} nodes, so the rest of the tree wasn't measured` });
        if (figma.built !== treeDigest([rootWithStyles(nodes[0], measured), ...nodes.slice(1)])) {
          builtElsewhere.set(component, [...(builtElsewhere.get(component) ?? []), slug]);
        }
        verdicts.push({
          component, slug,
          status: scored.compared === 0 ? "unscored" : scored.nodes.length ? "drifted" : "verified",
          source: sourceOf(figma), matched: scored.matched, mismatched: scored.compared - scored.matched, differences: [],
          elements: {
            measured: scored.measured, verified: scored.verified, drifted: scored.drifted, missing: scored.missing, extra: scored.extra,
            fidelity: counted ? scored.score / counted : null,
          },
          nodes: scored.nodes,
          ...(typeof figma.name === "string" ? { name: figma.name } : {}),
          ...(designer.length ? { designerLayers: designer } : {}),
        });
        continue;
      }

      // The root alone: a snap without trees, a component measured
      // without one, a readback from a template before trees, or
      // --roots-only. An element-tree build places a frame's children
      // itself (design D2), with no padding or with spacing that takes in
      // their margins, so its root's padding and gap are not 0.4.0's and
      // are left out: its children's places, which they stood for, are
      // scored element by element, and not here.
      const rootFigma = isTreeEntry(figma) ? withoutLayoutFields(figma) : figma;
      const verdict = verifyVariant(component, slug, measured, rootFigma, tolerance, spike);
      if (figma == null) {
        // Missing from Figma: every element snap measured is missing, and
        // where it measured a tree, every property of each.
        const all = nodes ? scoreTree({ nodes, styles: measured, assets: tree!.assets, records: [], tolerance, spike }) : null;
        elements.measured += nodes ? nodes.length : 1;
        elements.missing += nodes ? nodes.length : 1;
        if (all) verdict.mismatched = all.compared;
        verdicts.push(verdict);
        continue;
      }
      elements.measured += 1;
      const compared = verdict.matched + verdict.mismatched;
      elementScore += compared ? verdict.matched / compared : 0;
      if (verdict.status === "verified") elements.verified += 1;
      else elements.drifted += 1;
      if (nodes) {
        verdict.childrenNotReadBack = true;
        elements.notReadBack += nodes.length - 1;
      }
      verdicts.push(verdict);
    }
  }

  // A component snap measured no variant of, every one failed: figma code
  // builds each as a placeholder, listed as the placeholders above are.
  for (const snapComponent of snap.components ?? []) {
    if (snapComponent.base || snapComponent.error) continue;
    const component = componentKey(snapComponent);
    for (const variant of snapComponent.variants ?? []) {
      const figma = readbackComponents[component]?.variants?.[variant.slug];
      if (variant.status === "ok" || !isTreeEntry(figma)) continue;
      notMeasuredSlugs.add(JSON.stringify([component, variant.slug]));
      verdicts.push({
        component, slug: variant.slug, status: "not_measured", source: sourceOf(figma), matched: 0, mismatched: 0, differences: [],
        ...(typeof figma!.name === "string" ? { name: figma!.name } : {}),
        unmeasured: unmeasuredOf(snapComponent, variant),
      });
    }
  }

  // The mirror of missing_from_figma: something Figma has that we never
  // measured, and therefore never scored. Not a later part of a variant
  // read in parts, nor a placeholder listed as not measured.
  const unmeasuredInFigma: { component: string; slug: string }[] = [];
  for (const [component, entry] of Object.entries(readbackComponents)) {
    const measured = measuredByComponent.get(component);
    for (const slug of Object.keys(entry?.variants ?? {})) {
      const own = slugOfKey(slug);
      if (own !== slug && (measured?.has(own) || notMeasuredSlugs.has(JSON.stringify([component, own])))) continue;
      if (notMeasuredSlugs.has(JSON.stringify([component, slug]))) continue;
      if (!measured?.has(slug)) unmeasuredInFigma.push({ component, slug });
    }
  }
  // And what the sets hold beyond what was read, where the readback says.
  const unreadInFigma: { component: string; unbuilt: string[]; uncovered: number }[] = [];
  for (const [component, entry] of Object.entries(readbackComponents)) {
    if (!Number.isInteger(entry?.total)) continue;
    const unbuilt = Array.isArray(entry.unbuilt) ? entry.unbuilt.map(String) : [];
    const read = new Set(Object.keys(entry.variants ?? {}).map(slugOfKey)).size;
    const uncovered = options.notRead?.length ? 0 : Math.max(0, entry.total! - unbuilt.length - read);
    if (unbuilt.length || uncovered) unreadInFigma.push({ component, unbuilt, uncovered });
  }
  // Of those, whole components the snap never mentions: what a snap re-run
  // for some components, without --merge, leaves out of a push it scores.
  const inSnap = new Set((snap.components ?? []).map((c) => componentKey(c)));
  const componentsNotInSnap = Object.keys(readbackComponents).filter((component) => !inSnap.has(component));

  const propertiesMatched = verdicts.reduce((n, v) => n + v.matched, 0);
  const propertiesCompared = propertiesMatched + verdicts.reduce((n, v) => n + v.mismatched, 0);

  // A snap that recorded its own failures must not be scored as if it had not.
  const snapIssues: string[] = [];
  const snapWarnings: string[] = [];
  const componentErrors = (snap.components ?? []).filter((c) => c.error);
  for (const component of componentErrors) {
    snapIssues.push(`${componentKey(component)}: ${component.error}`);
  }
  // Two components of one key collapse into one above, the last standing for
  // both, so the other was never scored. snap warns of it; a clean score here
  // would hide it.
  const keyed = new Map<string, number>();
  for (const component of snap.components ?? []) {
    const key = componentKey(component);
    keyed.set(key, (keyed.get(key) ?? 0) + 1);
  }
  for (const [key, count] of keyed) {
    if (count > 1) snapIssues.push(`${count} components share the key "${key}", so only one of them was scored`);
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
  // pass in a URL or take through its preview, or arg_rejected, for one the
  // story's argTypes refuse,
  // which the caveats name too — and the skill has the agent build those
  // from source and label them inferred, which provenance already fails
  // under --strict-measured. `snap --strict` is the gate for measurement
  // failures.
  // Each component by name, so one whose every variant failed, which has
  // nothing scored, isn't hidden in a count.
  if (snap.summary?.failed) {
    const failedBy: string[] = [];
    for (const component of snap.components ?? []) {
      const failed = (component.variants ?? []).filter((v) => v.status !== "ok").length;
      if (!failed) continue;
      const all = failed === component.variants.length;
      failedBy.push(`${componentKey(component)} (${all ? (failed === 1 ? "its one variant" : `all ${failed}`) : failed})`);
    }
    const named = failedBy.length > 3 ? `${failedBy.slice(0, 3).join(", ")} and ${failedBy.length - 3} more` : failedBy.join(", ");
    snapWarnings.push(
      `${snap.summary.failed} variant(s) could not be measured${named ? `, of ${named}` : ""}; any built from source are listed under provenance`,
    );
  }

  const caveats = (snap.components ?? [])
    .filter((component) => readbackComponents[componentKey(component)] != null)
    .flatMap((component) => {
      const own = [
        ...scoreCaveats(component),
        ...treeCaveats(component, { treeMode, builtElsewhere: builtElsewhere.get(componentKey(component)) }),
      ];
      return [...own, ...unsaidWarnings(component, own)];
    });
  const bindings = bindingReport(readbackComponents, new Set(unverified.keys()));
  const uncompared = new Map<string, { component: string; property: string; variants: number }>();
  for (const verdict of verdicts) {
    for (const property of verdict.uncompared ?? []) {
      const key = JSON.stringify([verdict.component, property]);
      const seen = uncompared.get(key) ?? { component: verdict.component, property, variants: 0 };
      seen.variants++;
      uncompared.set(key, seen);
    }
  }

  const unscorableList = [...unscorable.values()];
  const unscorableCount = unscorableList.reduce((n, u) => n + u.variants, 0);
  const counted = elements.measured + elements.extra;
  return {
    version: READBACK_SCHEMA_VERSION,
    fidelity: propertiesCompared > 0 ? propertiesMatched / propertiesCompared : null,
    ...(treeMode ? { elementFidelity: counted > 0 ? elementScore / counted : null } : {}),
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
      unrecorded: verdicts.filter((v) => v.source === "unrecorded" && v.status !== "missing_from_figma" && v.status !== "not_read").length,
      unmeasured: unmeasuredInFigma.length,
      unscored: verdicts.filter((v) => v.status === "unscored").length,
      unverifiedReadback: verdicts.filter((v) => v.status === "unverified_readback" || v.status === "parts_missing").length,
      ...(extended ? {
        notMeasured: verdicts.filter((v) => v.status === "not_measured").length,
        partsMissing: verdicts.filter((v) => v.status === "parts_missing").length,
        unread: unreadInFigma.reduce((n, u) => n + u.unbuilt.length + u.uncovered, 0),
      } : {}),
      ...(options.notRead ? { notRead: verdicts.filter((v) => v.status === "not_read").length } : {}),
      ...(treeMode ? { elements: { ...elements, extraVariants: unmeasuredInFigma.length + (extended ? unreadInFigma : []).reduce((n, u) => n + u.uncovered, 0) } } : {}),
    },
    snapIssues,
    snapWarnings,
    caveats,
    bindings,
    uncompared: [...uncompared.values()],
    componentsNotInSnap,
    skipped,
    unmeasuredInFigma,
    ...(extended ? { unreadInFigma } : {}),
    readbackIssues,
    variants: verdicts,
    ...(treeMode ? {
      unscorable: unscorableList,
      coverage: propertiesCompared + unscorableCount > 0 ? propertiesCompared / (propertiesCompared + unscorableCount) : null,
    } : {}),
    ...(options.notRead ? { notRead: [...options.notRead] } : {}),
  };
}

/**
 * Why snap couldn't measure a variant, for the line verify lists it on: its
 * status and error, and whether the component's warnings name a story
 * change for it. snap's arg_rejected warning does where one would help ("To
 * measure it, ..."); a render_error, element_not_found or timeout has no
 * such warning, and its error is all snap says.
 */
function unmeasuredOf(component: SnapComponent, variant: SnapVariant): NonNullable<VariantVerdict["unmeasured"]> {
  const storyChange = variant.status === "arg_rejected"
    && (component.warnings ?? []).some((w) => w.includes("(status arg_rejected)") && /To measure (?:it|them), /.test(w));
  return { status: variant.status, error: variant.error ?? null, storyChange };
}

/** An error as one line of at most `max` characters, cut at a word with an ellipsis. */
function oneLine(text: string, max = 100): string {
  const line = text.split("\n")[0].trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : max).replace(/[\s,;:.]+$/, "")}…`;
}

/** Whether an entry was read by the element-tree template, which no earlier template's has a field of. */
function isTreeEntry(entry: unknown): entry is ReadbackStyles {
  return entry != null && typeof entry === "object" && TREE_MARKS.some((key) => (entry as Record<string, unknown>)[key] !== undefined);
}

/** The variant slug an entry's key is for: a later part's key is `slug#<first node>`. */
export function slugOfKey(key: string): string {
  const at = key.lastIndexOf("#");
  return at > 0 && /^#\d+$/.test(key.slice(at)) ? key.slice(0, at) : key;
}

function sourceOf(entry: ReadbackStyles | undefined): VariantVerdict["source"] {
  const declared = entry?.source;
  return declared === "measured" || declared === "inferred" || declared === "unmeasured" ? declared : "unrecorded";
}

/** The entries a variant was read in, whole or in parts, in order of their first node. */
function partsOf(entries: Record<string, ReadbackStyles> | undefined, slug: string): ReadbackStyles[] {
  return Object.entries(entries ?? {})
    .filter(([key]) => key === slug || slugOfKey(key) === slug)
    .map(([, entry]) => entry)
    .sort((a, b) => (a.part?.[0] ?? 0) - (b.part?.[0] ?? 0));
}

/** A variant's records, its parts' in order. */
function recordsOf(entries: Record<string, ReadbackStyles>, slug: string): ReadRecord[] {
  return partsOf(entries, slug).flatMap((entry) => entry.tree ?? []);
}

/** An entry without the root's padding and gap, which verifyVariant then doesn't compare. */
function withoutLayoutFields(entry: ReadbackStyles): ReadbackStyles {
  const { padding: _padding, gap: _gap, ...rest } = entry;
  return rest;
}

function addUnscorable(into: Map<string, UnscorableProperty & { component: string; variants: number }>, component: string, u: UnscorableProperty): void {
  const key = JSON.stringify([component, u.key, u.property, u.reason]);
  const seen = into.get(key) ?? { component, ...u, variants: 0 };
  seen.variants++;
  into.set(key, seen);
}

/** The name the build gives the variant of `combination`, as 0.4.0's did: `variant=default, size=sm`. */
export function variantName(combination: Record<string, string>): string {
  return Object.entries(combination).map(([k, v]) => `${k}=${v}`).join(", ");
}

/**
 * The element-tree readback's own problems, on entries whose checksum
 * matches (an entry with an issue already has nothing to trust):
 * `parts_missing`, a variant read in parts whose parts don't cover its
 * records once each, in order; and `name_mismatch`, a variant whose name in
 * Figma is not the one snap's combination gives its slug.
 */
function checkTreeReadback(snap: SnapResult, readback: ReadbackFile, issued: ReadbackIssue[]): ReadbackIssue[] {
  const issues: ReadbackIssue[] = [];
  const already = new Set(issued.map((i) => JSON.stringify([i.component, slugOfKey(i.slug)])));
  const combinations = new Map<string, Map<string, Record<string, string>>>();
  for (const component of snap.components ?? []) {
    combinations.set(componentKey(component), new Map((component.variants ?? []).map((v) => [v.slug, v.combination ?? {}])));
  }
  for (const [component, entry] of Object.entries(readback.components ?? {})) {
    const bySlug = new Map<string, [string, ReadbackStyles][]>();
    for (const [key, variant] of Object.entries(entry?.variants ?? {})) {
      if (!isTreeEntry(variant)) continue;
      const slug = slugOfKey(key);
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), [key, variant]]);
    }
    for (const [slug, parts] of bySlug) {
      if (already.has(JSON.stringify([component, slug]))) continue;
      const whole = parts.length === 1 && parts[0][0] === slug && parts[0][1].part === undefined;
      if (!whole && !partsCover(slug, parts)) {
        issues.push({ component, slug, problem: "parts_missing" });
        continue;
      }
      const combination = combinations.get(component)?.get(slug);
      if (!combination) continue;
      const expected = variantName(combination);
      const wrong = parts.find(([, p]) => p.name !== expected);
      if (wrong) issues.push({ component, slug: wrong[0], problem: "name_mismatch", name: String(wrong[1].name), expected });
    }
  }
  return issues;
}

/** Whether a variant's parts hold its records once each, in order, the first under its slug. */
function partsCover(slug: string, parts: [string, ReadbackStyles][]): boolean {
  const sorted = parts.map(([key, p]) => ({ key, part: p.part, tree: p.tree }))
    .sort((a, b) => (a.part?.[0] ?? 0) - (b.part?.[0] ?? 0));
  let next = 0;
  let total: number | null = null;
  for (const { key, part, tree } of sorted) {
    if (!Array.isArray(part) || part.length !== 3 || !part.every((n) => Number.isInteger(n) && n >= 0)) return false;
    const [first, count, of] = part;
    if (first !== next || key !== (first ? `${slug}#${first}` : slug)) return false;
    if (!Array.isArray(tree) || tree.length !== count || (total !== null && of !== total)) return false;
    total = of;
    next = first + count;
  }
  return total !== null && next === total;
}

/**
 * The caveats about a component that come from what verify compared: only
 * its outer element (`root-only`), where snap measured no tree or verify
 * was asked to score roots alone; a tree snap cut short
 * (`truncated-tree`); and variants Figma says were built from other facts
 * than the snap's (`built-from-other-measurement`).
 */
function treeCaveats(component: SnapComponent, { treeMode, builtElsewhere }: { treeMode: boolean; builtElsewhere?: string[] }): ScoreCaveat[] {
  const key = componentKey(component);
  const caveats: ScoreCaveat[] = [];
  const tree = treeOf(component);
  if (!treeMode || !tree) {
    // How many inner elements went unmeasured: snap --root-only counts them,
    // and a tree snap scored by roots alone has them.
    const counts = (component.variants ?? []).map((v: TreeVariant) => {
      if (tree && v.status === "ok") {
        try {
          return expandTree(tree, v.treeDelta).length - 1;
        } catch {
          return undefined;
        }
      }
      return typeof v.innerElements === "number" ? v.innerElements : undefined;
    }).filter((n): n is number => n !== undefined);
    const inner = counts.length ? Math.max(...counts) : undefined;
    if (inner !== 0) caveats.push({ component: key, kind: "root-only", ...(inner !== undefined ? { innerElements: inner } : {}) });
  }
  if (treeMode && tree?.truncated) {
    caveats.push({ component: key, kind: "truncated-tree", nodes: tree.truncated.nodes, at: tree.truncated.at });
  }
  if (builtElsewhere?.length) caveats.push({ component: key, kind: "built-from-other-measurement", slugs: builtElsewhere, variants: builtElsewhere.length });
  return caveats;
}

/**
 * Why `--strict` fails on what element-by-element scoring found, beyond
 * what it failed on before: elements drifted, missing or extra; roots read
 * back without their trees; planned reads with no result; and layers a
 * designer added inside variants, unless `allowDesignerLayers`. Empty when
 * none. (Drifted variants, readback issues, parts missing and names that
 * don't match fail through the summary and readbackIssues already.)
 */
export function treeStrictFailures(result: VerifyResult, { allowDesignerLayers = false }: { allowDesignerLayers?: boolean } = {}): string[] {
  const out: string[] = [];
  const e = result.summary.elements;
  if (e) {
    if (e.drifted) out.push(`${e.drifted} ${e.drifted === 1 ? "element" : "elements"} drifted`);
    if (e.missing) out.push(`${e.missing} ${e.missing === 1 ? "element is" : "elements are"} missing from Figma`);
    if (e.extra) out.push(`${e.extra} keyed ${e.extra === 1 ? "layer" : "layers"} in Figma snap no longer measures`);
    if (e.extraVariants) out.push(`${e.extraVariants} ${e.extraVariants === 1 ? "variant" : "variants"} in Figma's sets snap no longer measures`);
    if (e.notReadBack) out.push(`${e.notReadBack} ${e.notReadBack === 1 ? "element" : "elements"} under roots read back without their tree`);
    if (e.designerLayers && !allowDesignerLayers) out.push(`${e.designerLayers} designer ${e.designerLayers === 1 ? "layer" : "layers"} inside variants`);
  }
  if (result.notRead?.length) out.push(`planned read ${result.notRead.length === 1 ? "call" : "calls"} ${result.notRead.join(", ")} not read whole`);
  return out;
}

/**
 * The score a run is judged by: element fidelity where verify scored
 * elements, else the share of properties, as before trees. Null when
 * nothing was scored. For `--min-fidelity`.
 */
export function headlineFidelity(result: VerifyResult): number | null {
  return result.elementFidelity !== undefined ? result.elementFidelity : result.fidelity;
}

/**
 * The variable bindings the readback reports, from the entries verify can
 * trust, those `unverified` doesn't name, as `JSON.stringify([component,
 * slug])`.
 *
 * Reported, not scored. Values are compared already, a bound field's at the
 * variable's value, so a binding changed to a variable of another value is
 * drift there. What a value can't show is a field bound to no variable at a
 * value a variable of its kind has: a token detached in Figma keeps its
 * value, and scored 100% while the library had lost the link that keeps it
 * in step with the code. The readback template finds those in Figma, where
 * the variables are, so verify needs neither the tokens nor what the push
 * meant to bind. Only variables of the field's kind count, so a padding of
 * 8 on shadcn/ui, where the radius md is 8, is no detached radius. Which of several variables of one value a field should be
 * bound to only the component's source says, so a binding moved to
 * another of the same value is not reported.
 */
export function bindingReport(components: ReadbackFile["components"], unverified: Set<string>): BindingReport {
  let read = 0;
  let bound = 0;
  const unbound = new Map<string, { component: string; field: string; variants: number }>();
  for (const [component, entry] of Object.entries(components ?? {})) {
    for (const [slug, variant] of Object.entries(entry?.variants ?? {})) {
      if (variant == null || typeof variant !== "object" || unverified.has(JSON.stringify([component, slug]))) continue;
      const hasBound = variant.bound != null && typeof variant.bound === "object";
      const hasUnbound = Array.isArray(variant.unbound);
      if (!hasBound && !hasUnbound) continue;
      read++;
      if (hasBound) bound += Object.keys(variant.bound!).length;
      for (const field of hasUnbound ? variant.unbound! : []) {
        const key = JSON.stringify([component, field]);
        const seen = unbound.get(key) ?? { component, field: String(field), variants: 0 };
        seen.variants++;
        unbound.set(key, seen);
      }
    }
  }
  return { read, bound, unbound: [...unbound.values()] };
}

/**
 * What snap warned about one component's measurement that a score of it
 * can't show: see VerifyResult.caveats. The measured element comes from the
 * warnings snap wrote, and the rest from the measurements themselves.
 */
export function scoreCaveats(component: SnapComponent): ScoreCaveat[] {
  const key = componentKey(component);
  const caveats: ScoreCaveat[] = [];
  const seen = new Set<string>();
  for (const warning of component.warnings ?? []) {
    const note = parseMeasurementWarning(warning);
    if (!note || seen.has(note.kind + note.element)) continue;
    seen.add(note.kind + note.element);
    caveats.push({ component: key, kind: note.kind, element: note.element, ...(note.kind === "closed-trigger" && note.reason ? { reason: note.reason } : {}) });
  }
  // Which of the two snap said, where it said: an older snap's warning
  // blames the story whatever the markup did.
  const behaviorOnly = (component.warnings ?? []).map(parseBehaviorOnlyWarning).find((names) => names != null);
  if (detectIdenticalVariants(component.variants ?? [])) {
    caveats.push(behaviorOnly ? { component: key, kind: "behavior-only", properties: behaviorOnly } : { component: key, kind: "identical-variants" });
  }
  // A VARIANT's only: a boolean with no default is assumed false, as React
  // treats a boolean left out, and the push lays it out default first, so
  // Figma's default is the code's; and every optional boolean has one.
  const assumed = (component.variantProperties ?? []).filter((p) => p.defaultAssumed && p.type === "VARIANT").map((p) => p.name);
  if (assumed.length) caveats.push({ component: key, kind: "default-assumed", properties: assumed });
  // Variants Storybook rendered as its default rather than as asked: not
  // measured, so not scored, which a score over the rest doesn't show.
  const refused = (component.variants ?? []).filter((v) => v.status === "arg_rejected");
  if (refused.length) {
    const values = [...new Set(refused.flatMap((v) => (v.rejectedArgs ?? []).map((r) => `${r.name}=${r.value}`)))];
    caveats.push({ component: key, kind: "args-rejected", values, variants: refused.length });
  }
  // Variants measured, and so scored, without snap knowing the story was
  // given their values: any of them may be the default under their name.
  const unchecked = (component.variants ?? []).filter((v) => v.status === "ok" && v.argsChecked === false).map((v) => v.slug);
  if (unchecked.length) caveats.push({ component: key, kind: "args-unchecked", slugs: unchecked, variants: unchecked.length });
  // Values the story's URL wouldn't take, measured as the component renders
  // them once snap set them through the preview: right, but the story needs
  // the change snap's warning names. Those no story change lets a URL carry
  // snap doesn't warn of, so neither does this.
  const viaPreview = (component.variants ?? []).filter((v) => v.status === "ok" && v.appliedVia === "preview")
    .map((v) => (v.rejectedArgs ?? []).filter((r) => r.reasons.some((reason) => !NO_STORY_FIX.has(reason))))
    .filter((fixable) => fixable.length);
  if (viaPreview.length) {
    const values = [...new Set(viaPreview.flat().map((r) => `${r.name}=${r.value}`))];
    caveats.push({ component: key, kind: "preview-set", values, variants: viaPreview.length });
  }
  // Which variants a story other than the component's measured, as snap said.
  const note = describeVariantStories({ storyId: component.storyId, variants: component.variants ?? [], storiesUnread: component.storiesUnread });
  if (note) {
    const stories = new Map<string, string[]>();
    for (const v of component.variants ?? []) if (v.storyId) stories.set(v.storyId, [...(stories.get(v.storyId) ?? []), v.slug]);
    caveats.push({ component: key, kind: "variant-stories", stories: [...stories].map(([story, slugs]) => ({ story, slugs })), note });
  }
  // How snap opened the overlay it measured, as snap said it.
  const opened = describeOpenedOverlays({ variants: component.variants ?? [] });
  if (opened) caveats.push({ component: key, kind: "opened", note: opened });
  // What snap's warnings alone say: values or properties that measured the
  // same, and a font the browser couldn't render.
  for (const warning of component.warnings ?? []) {
    const note = parseSnapWarning(warning);
    if (note?.kind === "identical-values") caveats.push({ component: key, kind: "identical-values", values: note.values });
    else if (note?.kind === "no-op-properties") caveats.push({ component: key, kind: "no-op-properties", properties: note.properties });
    else if (note?.kind === "font-not-rendered") caveats.push({ component: key, kind: "font-not-rendered", fonts: note.fonts });
  }
  return caveats;
}

/**
 * The warnings snap wrote about a component that none of `caveats` stands
 * for, as `snap-warning` caveats, so verify drops none of them: one of a
 * kind it has no caveat of, as a measurement climbed to an element that
 * draws, or one whose caveat the measurements didn't bear out. Not the
 * one about a shared key, which snapIssues says.
 */
export function unsaidWarnings(component: SnapComponent, caveats: readonly ScoreCaveat[]): ScoreCaveat[] {
  const key = componentKey(component);
  const has = (...kinds: ScoreCaveat["kind"][]) => caveats.some((c) => c.component === key && kinds.includes(c.kind));
  return (component.warnings ?? []).filter((warning) => {
    const note = parseSnapWarning(warning);
    if (!note) return true;
    switch (note.kind) {
      case "shared-key":
        return false;
      case "identical-variants":
        return !has("identical-variants", "behavior-only");
      // Under roots alone, the root-only caveat says the tree went unscored.
      case "truncated-tree":
        return !has("truncated-tree", "root-only");
      default:
        return !has(note.kind);
    }
  }).map((warning) => ({ component: key, kind: "snap-warning" as const, warning }));
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
  only?: readonly string[],
): SnapAgeInfo {
  const metaPath = join(dirname(snapPath), SNAP_META_FILENAME);

  let meta: { measuredAt?: unknown; storybookUrl?: unknown; componentsMeasuredAt?: unknown };
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
    return { known: false, reason: `measuredAt is in the future (${meta.measuredAt}): check the clock` };
  }

  // Only times that are times: a component with none is held to measuredAt.
  const times = typeof meta.componentsMeasuredAt === "object" && meta.componentsMeasuredAt !== null
    ? Object.fromEntries(Object.entries(meta.componentsMeasuredAt as Record<string, unknown>)
      .filter((pair): pair is [string, string] => typeof pair[1] === "string" && Number.isFinite(Date.parse(pair[1]))))
    : null;
  // Scoring `only` some components (verify --plan), the snap is as old as
  // the oldest of those: a merged snap's measuredAt is its oldest
  // component's, which may be another push's, scored by nobody here.
  let at = meta.measuredAt;
  if (only?.length && times) {
    const theirs = only.map((key) => times[key] ?? meta.measuredAt as string);
    at = theirs.reduce((min, t) => (Date.parse(t) < Date.parse(min) ? t : min));
    if (Date.parse(at) > now + MAX_CLOCK_SKEW_MS) {
      return { known: false, reason: `a component's measuredAt is in the future (${at}): check the clock` };
    }
  }
  const ageMs = Math.max(0, now - Date.parse(at));
  return {
    known: true,
    measuredAt: at,
    ageMs,
    storybookUrl: typeof meta.storybookUrl === "string" ? meta.storybookUrl : undefined,
    stale: maxAgeMs != null && ageMs > maxAgeMs,
    ...(times ? { componentsMeasuredAt: times } : {}),
  };
}

function firstLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split("\n")[0].trim();
}

// --- Element report ------------------------------------------------------------

/** How many nodes' drift the report prints before it points at --json for the rest. */
const REPORT_NODE_LINES = 40;
/** How many designer layers, and how many variants not measured, it prints. */
const REPORT_LIST_LINES = 20;

const percent = (n: number | null | undefined) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const count = (n: number) => n.toLocaleString("en-US");

/** A value as a drift line shows it: a color or name as it is, anything else as JSON. */
function shown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "nothing";
}

/**
 * verify's report where it scored elements (design section 10.6): the
 * headline, element fidelity beside the share of properties; the worst
 * component; the counts; coverage; `beside`, what the caller says beside
 * the score; then each element missing, extra or
 * drifted, by component, variant and key, with its Figma node id; the
 * layers designers added; and the variants not measured. Lines to print,
 * colored. Nothing for a run that scored no elements.
 */
export function formatElementReport(result: VerifyResult, beside: readonly string[] = []): string[] {
  if (result.elementFidelity === undefined) return [];
  const lines: string[] = [];
  const { summary } = result;
  const e = summary.elements ?? { measured: 0, verified: 0, drifted: 0, missing: 0, extra: 0, designerLayers: 0, notReadBack: 0 };
  const excluded = summary.unverifiedReadback;
  const unread = summary.notRead ?? 0;
  const excludedNote = (excluded > 0 ? chalk.red(`; ${excluded} ${excluded === 1 ? "entry" : "entries"} unverified, not scored`) : "")
    + (unread > 0 ? chalk.red(`; ${unread} ${unread === 1 ? "variant" : "variants"} not read, not scored`) : "");
  // The elements' scores summed, so a node right on most of its properties
  // counts for most of one: the count beside it is of the ones right on all.
  lines.push(`\nFidelity: ${chalk.bold(`${percent(result.elementFidelity)} of elements`)} ${chalk.dim(`(${count(e.verified)} of ${count(e.measured + e.extra)} verified)`)}, `
    + `${percent(result.fidelity)} of properties ${chalk.dim(`(${count(summary.propertiesMatched)}/${count(summary.propertiesCompared)})`)}${excludedNote}`);

  // The component scoring lowest, where one is below 100%.
  const byComponent = new Map<string, { score: number; elements: number }>();
  for (const v of result.variants) {
    if (!v.elements) continue;
    const seen = byComponent.get(v.component) ?? { score: 0, elements: 0 };
    seen.score += (v.elements.fidelity ?? 0) * (v.elements.measured + v.elements.extra);
    seen.elements += v.elements.measured + v.elements.extra;
    byComponent.set(v.component, seen);
  }
  const worst = [...byComponent].map(([name, s]) => [name, s.elements ? s.score / s.elements : 1] as const).sort((a, b) => a[1] - b[1])[0];
  if (worst && worst[1] < 1) lines.push(`  worst: ${worst[0]} ${percent(worst[1])} of elements`);

  // Extra too: the variants a push built that snap no longer measures, read
  // back or not, as those an earlier push built under other properties.
  const stale = [
    ...result.unmeasuredInFigma.map((u) => `${u.component} ${u.slug}`),
    ...(result.unreadInFigma ?? []).filter((u) => u.uncovered).map((u) => `${u.component}: ${u.uncovered} ${u.uncovered === 1 ? "variant" : "variants"} no read covered`),
  ];
  const staleCount = e.extraVariants ?? 0;
  const counts = [
    `missing ${e.missing}`, `drifted ${e.drifted}`, `extra ${e.extra + staleCount}`, `designer layers ${e.designerLayers}`,
    `not measured ${summary.notMeasured ?? 0}`,
    ...(e.notReadBack ? [`not read back ${e.notReadBack}`] : []),
    ...(unread ? [`not read ${unread}`] : []),
  ];
  const clean = !e.missing && !e.drifted && !e.extra && !staleCount && !e.notReadBack && !unread;
  lines.push(`  ${(clean ? chalk.dim : chalk.red)(counts.join(" · "))}`);
  if (staleCount) {
    lines.push(chalk.red(`  + ${staleCount} extra ${staleCount === 1 ? "variant" : "variants"} in Figma's sets that snap no longer measures (${stale.slice(0, 3).join("; ")}${stale.length > 3 ? `, and ${stale.length - 3} more` : ""}): \`storysync figma code --remove-extra\` removes those a push built, once the user says to`));
  }

  // Coverage always, 100% too: the skill has the agent report it, and a
  // line that only appeared below 100% read as missing.
  const unscorable = result.unscorable ?? [];
  if (unscorable.length) {
    const named = unscorable.slice(0, 3).map((u) => `${u.reason} on ${u.component} › ${u.key || "(root)"}`);
    const more = unscorable.length > 3 ? `, and ${unscorable.length - 3} more (--json lists them)` : "";
    lines.push(chalk.dim(`  coverage ${percent(result.coverage)}: not scored: ${named.join("; ")}${more}`));
  } else if (result.coverage != null) {
    lines.push(chalk.dim(`  coverage ${percent(result.coverage)}: every property was scored`));
  }
  // What the caller says beside the score, such as what snap warned, before the drift under it.
  lines.push(...beside);

  // Missing first, then extra, then drifted, each by key and Figma node id.
  const drift: { order: number; text: string }[] = [];
  for (const v of result.variants) {
    for (const node of v.nodes ?? []) {
      const where = `${v.component} ${v.name || v.slug} › ${node.key || "(root)"}`;
      const id = node.figmaId ? ` (node ${node.figmaId})` : "";
      if (node.status === "missing") drift.push({ order: 0, text: chalk.red(`  - ${where}: missing from Figma`) });
      else if (node.status === "extra") drift.push({ order: 1, text: chalk.red(`  + ${where}: in Figma${id}, but snap no longer measures it`) });
      else {
        const gate = node.gate ? chalk.red(` [${node.gate} wrong, so it scores 0]`) : "";
        const diffs = node.differences.map((d) => `${d.property} measured ${shown(d.measured)}, Figma ${shown(d.figma)}`).join("; ");
        drift.push({ order: 2, text: `  ${chalk.red("~")} ${where}: ${diffs}${id}${gate}` });
      }
    }
  }
  drift.sort((a, b) => a.order - b.order);
  for (const line of drift.slice(0, REPORT_NODE_LINES)) lines.push(line.text);
  if (drift.length > REPORT_NODE_LINES) lines.push(chalk.dim(`  … and ${drift.length - REPORT_NODE_LINES} more (--json lists every one)`));

  const capped = (list: string[], color: (text: string) => string) => {
    for (const line of list.slice(0, REPORT_LIST_LINES)) lines.push(color(line));
    if (list.length > REPORT_LIST_LINES) lines.push(chalk.dim(`  … and ${list.length - REPORT_LIST_LINES} more (--json lists every one)`));
  };
  capped(result.variants.filter((v) => v.childrenNotReadBack)
    .map((v) => `  ! ${v.component} ${v.slug}: read back without its tree, so only its root was compared; read it again with the calls \`storysync figma code\` writes`), chalk.red);
  capped(result.variants.flatMap((v) => (v.designerLayers ?? [])
    .map(([name, type, id]) => `  ? ${v.component} ${v.name || v.slug}: a layer nothing keyed, "${name}" (${type}, node ${id}): a designer's, not scored`)), chalk.yellow);
  capped(result.variants.filter((v) => v.status === "not_measured").map((v) => {
    const why = v.unmeasured ? ` (${v.unmeasured.status}${v.unmeasured.error ? `: ${oneLine(v.unmeasured.error)}` : ""})` : "";
    const fix = v.unmeasured?.storyChange ? "; snap's warning names the story change it needs" : "";
    return `  ? ${v.component} ${v.name || v.slug}: not measured${why}, so Figma holds a placeholder for it${fix}`;
  }), chalk.yellow);
  for (const seq of result.notRead ?? []) lines.push(chalk.red(`  ! planned read call ${seq} wasn't read whole, so the variants it didn't read weren't scored`));
  return lines;
}

/**
 * What `verify --plan` says when the snap it scores isn't the one the plan
 * was made from (its digest differs), from what that reached: Figma's
 * `built` digests name the components built from another measurement than
 * this snap's, the plan's calls would build those the same way again, and
 * they fail --strict; where none is, every variant scored was built from
 * what this snap measures, and the score stands. `snap` and `planSnap.path`
 * as shown; `planSnapIntact` where the plan's own snap is still as it was,
 * to score the plan against.
 */
export function describeSnapChange(
  snap: string,
  planSnap: { path: string; measuredAt?: string },
  { measuredAt, given, planSnapIntact, builtFromOther, notInSnap }: { measuredAt?: string; given: boolean; planSnapIntact: boolean; builtFromOther: string[]; notInSnap: string[] },
): string[] {
  const when = planSnap.measuredAt && measuredAt && planSnap.measuredAt !== measuredAt ? ` (it was measured at ${measuredAt}, the plan's at ${planSnap.measuredAt})` : "";
  const what = given && snap !== planSnap.path
    ? `--snap ${snap} isn't the snap \`storysync figma code\` made this plan from, ${planSnap.path}${when}`
    : `${snap} has changed since \`storysync figma code\` made this plan from it${when}`;
  if (builtFromOther.length) {
    const one = builtFromOther.length === 1;
    const instead = given && planSnapIntact ? `; or, to score this plan as it was made, pass --snap ${planSnap.path}` : "";
    return [chalk.red(`  ! ${what}, and Figma says ${builtFromOther.join(", ")} ${one ? "was" : "were"} built from an earlier measurement than this snap's, which this plan's calls would build again: run \`storysync figma code\` with this snap, send its calls, and run verify again${instead}.`)];
  }
  const lacks = notInSnap.length ? `; it lacks ${notInSnap.join(", ")}, as said above, and` : ", but";
  return [chalk.dim(`  i ${what}${lacks} every variant scored was built from what this snap measures, so the score stands: what changed is elsewhere in the snap.`)];
}
