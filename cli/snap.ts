// Orchestration for `storysync snap`: render every variant of every component
// and record what the browser actually computed.
//
// Browser work lives in snap-browser.ts and all value normalization in
// snap-normalize.ts; this module decides *what* to render and how to lay the
// results out on disk.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { VERSION } from "./version.js";
import { mapComponent, withoutProps, representativeCombinations, supplementOptions, DEFAULT_MAX_COMBINATIONS } from "./mapper.js";
import type { CapInfo } from "./mapper.js";
import type { FigmaVariantProperty, StorybookComponent } from "./mapper.js";
import { selectComponents, componentKey } from "./storybook.js";
import type { ComponentEntry, StorybookClient } from "./storybook.js";
import {
  normalizeStyles, encodeStoryArgs, buildStoryUrl,
  assignVariantSlugs, componentSlug, componentSlots, contentSlots, diffFromBase,
} from "./snap-normalize.js";
import type { MeasurementNote, NormalizedStyles, SlugCollision, StyleDelta } from "./snap-normalize.js";
import { resolveAndLaunch, createContext, captureStory, makeThumbnail } from "./snap-browser.js";
import type { CaptureResult, CaptureStatus, CapturedImage } from "./snap-browser.js";
import { argsNotInDocs, describeArgRejections, describeUncheckedArgs, nameSlugs } from "./snap-args.js";
import type { ArgRejection, StoryArgType } from "./snap-args.js";
import { TREE_LIMITS, TREE_VERSION, diffTree } from "./tree-types.js";
import type { ComponentTree, ImageAsset, TreeDelta, TreeNode } from "./tree-types.js";
import { imageAssetFile } from "./snap-assets.js";
import { fnv1a32Bytes } from "./checksum.js";
import { stylesJsonText } from "./snap-tree.js";
import { canonicalJson } from "./checksum.js";

export const SNAP_SCHEMA_VERSION = 1;

export type VariantSelection = "representative" | "all";

export interface SnapOptions {
  storybookUrl: string;
  components?: string[];
  outDir: string;
  screenshots: boolean;
  timeoutMs: number;
  selector?: string;
  variants: VariantSelection;
  /** Ceiling on combinations measured per component under `variants: "all"`. */
  maxCombinations?: number;
  /** Props never to make variant properties of, in any component (`--exclude-props`). */
  excludeProps?: string[];
  /**
   * Measure only the components `components` names and merge them into the
   * styles.json already in `outDir`, replacing those and keeping the rest
   * (`--merge`). Without it, a run writes only what it measured.
   */
  merge?: boolean;
  /**
   * Measure each variant's root element alone, as 0.4.0 did, without its
   * element tree (`--root-only`): styles.json is then what 0.4.0 wrote,
   * with each variant's `innerElements`, how many elements went unmeasured.
   */
  rootOnly?: boolean;
  /**
   * Whether a value Storybook won't take from the story URL is set through
   * its preview's channel and measured (the default), or the variant left
   * unmeasured, as `arg_rejected` (`--no-channel-args`).
   */
  channelArgs?: boolean;
  /**
   * The story to measure a component from, by the component's ID or title,
   * in place of the one snap picks (`--stories ui-base-button=ui-base-button--with-icon`).
   */
  stories?: Record<string, string>;
}

/**
 * `args_unsupported`: a value the args URL can't carry, which Storybook's
 * preview didn't take either. `arg_rejected` (a CaptureStatus): one
 * Storybook wouldn't apply.
 */
export type SnapVariantStatus = CaptureStatus | "args_unsupported";

export interface SnapVariant {
  combination: Record<string, string>;
  slug: string;
  status: SnapVariantStatus;
  error: string | null;
  /** Differences from the component's base styles. Empty for the base itself. */
  delta?: StyleDelta;
  /** PNG path relative to the directory containing styles.json, when screenshots are enabled. */
  screenshot?: string;
  boundingBox?: { width: number; height: number };
  /**
   * The element measured, as its tag with its `data-slot` or `role`:
   * `button[data-slot="switch"]`. Recorded so that a measurement of the
   * wrong element, a story's layout wrapper or an overlay's trigger, can be
   * seen in the file rather than only in a screenshot.
   */
  element?: string;
  /**
   * True when `element` is content the story renders into a portal, outside
   * its root: an open dialog's, say, where nothing in the root draws.
   */
  portal?: true;
  /**
   * Values of the combination Storybook didn't give the story from its URL,
   * and why: see snap-args.ts. With `appliedVia`, snap applied them through
   * Storybook's preview and measured the result; with status
   * `arg_rejected`, it couldn't, and measured nothing.
   */
  rejectedArgs?: ArgRejection[];
  /** `preview` when `rejectedArgs` were applied through Storybook's preview, so this was measured with them. */
  appliedVia?: "preview";
  /**
   * False when snap couldn't read Storybook's preview to check that the
   * story was given this combination, so a value it didn't take would have
   * been measured as its default. Absent when it checked.
   */
  argsChecked?: false;
  /**
   * The variant's element tree as a change to the component's base tree
   * (`tree`): on every measured variant of a tree snap but the base.
   */
  treeDelta?: TreeDelta;
  /**
   * Under `--root-only`, how many elements under the root a tree would
   * have held, none of which were measured.
   */
  innerElements?: number;
}

export interface SnapComponent {
  /** The component's Storybook ID; absent from a snap written before it was recorded. */
  id?: string;
  name: string;
  title?: string;
  category?: string;
  storyId: string | null;
  variantProperties: FigmaVariantProperty[];
  /** Full styles for the reference combination; deltas are relative to this. */
  base: { combination: Record<string, string>; slug: string; styles: NormalizedStyles } | null;
  variants: SnapVariant[];
  warnings: string[];
  error: string | null;
  /**
   * Present when the component has more combinations than the ceiling, so only
   * a subset covering every value was measured. Whoever builds from this must
   * decide how to proceed rather than treat the subset as the whole component.
   */
  cap?: CapInfo & {
    /** Declared values no measured combination includes, as `prop=value`. */
    uncovered: string[];
  };
  /**
   * The argTypes of the story snap rendered, as Storybook's preview holds
   * them: each arg's type, control, options and `if`. Recorded, not acted
   * on: variant properties still come from Storybook's docs.
   */
  argTypes?: Record<string, StoryArgType>;
  /** The story's file, as Storybook records it. */
  storyFile?: string;
  /**
   * Args the story declares as a choice (options, or a boolean or select
   * control) that Storybook's docs don't list, so they are not variant
   * properties: shadcn/ui Button's `disabled`, say.
   */
  argsNotInDocs?: string[];
  /** What was measured of each variant: its element tree, or (`--root-only`) its root alone. Absent from a root-only snap. */
  capture?: "tree" | "root";
  /** The base variant's element tree, and the assets every variant's draws. */
  tree?: ComponentTree;
}

export interface SnapResult {
  version: number;
  storysyncVersion: string;
  storybookUrl: string;
  variantSelection: VariantSelection;
  /**
   * The props `--exclude-props` left out of every component, when it named
   * any: the push builds from this file, so it records what an audit has to
   * leave out too, or it reports each as missing from Figma.
   */
  excludeProps?: string[];
  /** The element-tree format, on a snap that measured trees; absent from a root-only one. */
  treeVersion?: number;
  /** Where the tree walk stopped: elements, depth, and SVG markup kept as a vector. */
  treeLimits?: typeof TREE_LIMITS;
  components: SnapComponent[];
  summary: {
    components: number;
    variants: number;
    rendered: number;
    failed: number;
    /**
     * Components that produced no variants at all — no stories, unreadable
     * documentation, or a failed browser session. Counted separately because
     * such a component contributes nothing to `failed`, which would otherwise
     * let a total failure pass `--strict` unnoticed.
     */
    componentsFailed: number;
    componentsWithWarnings: number;
    /** Components with more combinations than the ceiling, measured as a subset. */
    componentsCapped: number;
  };
}

/** Whether `snap --strict` fails on `result`. */
export function snapFailsStrict(result: SnapResult): boolean {
  // Measuring nothing is a failure, not a clean run: snap still writes a
  // styles.json and a freshly-stamped meta.json, so downstream freshness
  // checks would read an empty result as a good one.
  // A capped component was measured as a subset; building from it as if it
  // were the whole component is the silent gap --strict exists to stop.
  // So is a variant measured without knowing Storybook gave the story its
  // values: one it didn't take leaves the default on screen.
  return result.summary.failed > 0
    || result.summary.componentsFailed > 0
    || result.summary.components === 0
    || result.summary.componentsCapped > 0
    || result.components.some((c) => c.variants.some((v) => v.status === "ok" && v.argsChecked === false));
}

export interface SnapDeps {
  storybook: StorybookClient;
  launch: typeof resolveAndLaunch;
  /** Called with human-readable progress; no-op under --json. */
  onProgress?: (message: string) => void;
  /**
   * Called as each component starts, and as each of its variants does, so a
   * terminal can say where a long run is. Given under --json too: it draws
   * on stderr, and a component with many variants can take minutes.
   */
  onComponentStart?: (position: number, total: number, label: string) => void;
  onVariantStart?: (position: number, total: number) => void;
  /** Injectable clock, so tests can assert on the recorded time. */
  now?: () => number;
}

/**
 * Volatile metadata about a snap run.
 *
 * Kept beside `styles.json` rather than inside it: `styles.json` is meant to be
 * committed and diffed, so an embedded timestamp would churn on every run and
 * bury the changes that matter. This file carries the things that legitimately
 * change run to run, and is what lets `verify` notice it is reading a stale
 * measurement.
 */
export interface SnapMeta {
  version: number;
  measuredAt: string;
  storysyncVersion: string;
  storybookUrl: string;
  variantSelection: VariantSelection;
  components: number;
  variants: number;
  /**
   * When each component was measured, by its key (`componentKey`), written
   * by a merge (`--merge`), which keeps components an earlier run measured.
   * `measuredAt` is then the oldest of these, so the snap's age is that of
   * its oldest part, and verify holds each component's readback to its own
   * time. Absent when one run measured every component at `measuredAt`.
   */
  componentsMeasuredAt?: Record<string, string>;
  /**
   * Where this run measured: the OS and CPU (`darwin-arm64`), and the
   * browser's version. Text is drawn a little wider or narrower from one
   * platform to the next, so snaps compared with each other are best taken
   * on one (in CI, say).
   */
  platform?: string;
  browser?: string;
  /**
   * False where the run that wrote this file left the values Storybook
   * won't take from a story's URL unmeasured rather than setting them
   * through its preview (`--no-channel-args`): its arg_rejected variants
   * may be ones the preview would have measured. Absent otherwise.
   */
  channelArgs?: false;
}

export const SNAP_META_FILENAME = "meta.json";
export const SNAP_STYLES_FILENAME = "styles.json";

/**
 * Prefer an explicit Default story, since it is the least decorated.
 *
 * Story IDs from `listComponents` come straight out of Storybook's index, so
 * they are trusted ahead of the ones scraped out of documentation markdown.
 */
export function pickStory(
  storyIds: readonly string[] | undefined,
  component: StorybookComponent,
): string | null {
  const candidates = storyIds?.length ? [...storyIds] : component.stories.map((s) => s.id);
  if (!candidates.length) return null;
  return candidates.find((id) => id.toLowerCase().endsWith("--default")) ?? candidates[0];
}

export function selectCombinations(
  selection: VariantSelection,
  properties: FigmaVariantProperty[],
  full: Record<string, string>[],
): Record<string, string>[] {
  if (selection !== "all") return representativeCombinations(properties);
  // Lead with the all-defaults combination so it becomes the base, as it does in
  // representative mode. In cartesian order the first value of every prop would
  // be the base instead — for a boolean declared [true, false], the disabled
  // variant — and every enabled variant would read as a delta from it.
  const index = full.findIndex((combo) => properties.every((p) => combo[p.name] === p.defaultValue));
  if (index <= 0) return full;
  return [full[index], ...full.slice(0, index), ...full.slice(index + 1)];
}

/**
 * Declared values that no combination in the set includes, as `prop=value`.
 *
 * A capped subset is chosen to cover every value, but a limit below the number
 * of combinations that takes cannot — so coverage is checked, not assumed.
 */
export function uncoveredValues(properties: FigmaVariantProperty[], combinations: Record<string, string>[]): string[] {
  const missing: string[] = [];
  for (const prop of properties) {
    for (const value of prop.values) {
      if (!combinations.some((combo) => combo[prop.name] === value)) missing.push(`${prop.name}=${value}`);
    }
  }
  return missing;
}

/** Warning for a component measured as a subset because it exceeds the ceiling. */
export function describeCap(name: string, cap: CapInfo & { uncovered?: string[] }): string {
  const coverage = cap.uncovered?.length
    ? `, which leave out ${cap.uncovered.join(", ")} entirely`
    : " that cover every value";
  return (
    `${name} has ${cap.totalPossible} variant combinations, more than the limit of ${cap.maxCombinations}, ` +
    `so ${cap.generated} were measured${coverage}. Building the full set needs ` +
    `--max-combinations ${cap.totalPossible}; otherwise build the subset, or leave out props that don't change ` +
    `how it looks with --exclude-props.`
  );
}

/**
 * Flags the one failure mode that measurement cannot otherwise detect: a story
 * that ignores its args (hardcoded props, a custom `render`, or a decorator
 * that drops them) renders identically for every combination, so the measured
 * values would silently describe the default state for all of them.
 */
export function detectIdenticalVariants(variants: SnapVariant[]): string | null {
  const measured = variants.filter((v) => v.status === "ok");
  if (measured.length < 2) return null;
  // Under a tree, a variant that changes only what is inside the root, as
  // Attachment's error state colors its icon, didn't measure identically.
  const allEmpty = measured.every((v) => (!v.delta || Object.keys(v.delta).length === 0) && !treeChanged(v));
  if (!allEmpty) return null;
  return (
    `all ${measured.length} rendered variants measured identically — the story may not pass args ` +
    `through to the component (hardcoded props, a custom render function, or a decorator). ` +
    `Measured values may describe only the default state.`
  );
}

/**
 * The warning for a component whose rendered variants all measured the
 * same, or null when they didn't, told apart by the markup each variant
 * rendered, `markups` in the order of its measured variants, as
 * captureStory reads it:
 *
 * - the same markup on every variant: nothing the args set reached the
 *   page, so the story may not pass them through, the one failure
 *   measurement can't otherwise see;
 * - markup that changed with the args: they reach the component, and its
 *   properties change only what snap doesn't measure, as input-otp's
 *   `textAlign` and `pushPasswordManagerStrategy` do. A live push's warning
 *   blamed the story, whose args were passed through, and the summary
 *   repeated it. So this names the properties and the `--exclude-props`
 *   that leaves them out;
 * - markup not read on every variant, or one that changed as it was
 *   measured: either, so it says both.
 *
 * With `tree`, the elements inside the root were measured too, so what
 * snap doesn't measure is a state or an animation, not a child element.
 */
export function describeIdenticalVariants(
  variants: SnapVariant[],
  properties: FigmaVariantProperty[],
  markups: (string | null)[],
  options: { tree?: boolean } = {},
): string | null {
  const identical = detectIdenticalVariants(variants);
  if (!identical) return null;
  const names = properties.map((p) => p.name);
  const measured = variants.filter((v) => v.status === "ok").length;
  const known = markups.length === measured && markups.every((m) => m !== null);
  if (known && new Set(markups).size === 1) {
    return identical.replace(" — the story may not", " and rendered the same markup — the story may not");
  }
  if (!names.length) return identical;
  const list = names.map((name) => `\`${name}\``).join(", ");
  const exclude = `\`--exclude-props ${names.join(",")}\``;
  const one = names.length === 1;
  const change = one ? "changes" : "change";
  if (known) {
    return (
      `all ${measured} rendered variants measured identically, though their markup changed with the args, so the story ` +
      `passes them through: ${list} ${change} nothing snap measures, likely only behavior, or something it doesn't measure, ` +
      `such as ${options.tree ? "a hover or focus state, or an animation" : "a child element"}. ` +
      `If ${one ? "it doesn't" : "they don't"} change how it looks, leave ${one ? "it" : "them"} out ` +
      `of every component with ${exclude}, and build it as one variant.`
    );
  }
  return `${identical} Or ${list} ${change} only behavior, which snap doesn't measure: if so, leave ${one ? "it" : "them"} out of every component with ${exclude}.`;
}

/**
 * The properties a warning describeIdenticalVariants wrote names as
 * changing nothing snap measures, though the args reached the component,
 * or null for any other warning.
 */
export function parseBehaviorOnlyWarning(warning: string): string[] | null {
  const m = /^all \d+ rendered variants measured identically, though their markup changed with the args\b.*`--exclude-props ([^`]+)`/.exec(warning);
  return m ? m[1].split(",") : null;
}

/**
 * Variant properties whose values all measured the same wherever the other
 * properties held still: an axis that changes nothing snap records, such as
 * Radix's `asChild`, or a prop the story drops on its way to the component.
 * detectIdenticalVariants only fires when every variant matches, which one
 * live axis beside a dead one hides.
 *
 * A property is judged only where at least two of its values were measured
 * against the same values of the others, and is named only if none of those
 * comparisons differed.
 */
export function detectNoOpProperties(properties: FigmaVariantProperty[], variants: SnapVariant[]): string[] {
  const measured = variants.filter((v) => v.status === "ok");
  const noOps: string[] = [];
  for (const property of properties) {
    // Keyed by the other properties' values: this property's value -> what it measured.
    const groups = new Map<string, Map<string, string>>();
    for (const variant of measured) {
      const value = variant.combination[property.name];
      if (value === undefined) continue;
      const others = JSON.stringify(Object.entries(variant.combination).filter(([name]) => name !== property.name));
      const group = groups.get(others) ?? new Map<string, string>();
      group.set(value, measuredAs(variant));
      groups.set(others, group);
    }
    const compared = [...groups.values()].filter((group) => group.size >= 2);
    if (compared.length && compared.every((group) => new Set(group.values()).size === 1)) noOps.push(property.name);
  }
  return noOps;
}

/** Whether a variant's tree differs from its base's. */
function treeChanged(variant: SnapVariant): boolean {
  return !!variant.treeDelta && (variant.treeDelta.keys !== undefined || Object.keys(variant.treeDelta.set ?? {}).length > 0);
}

/**
 * What a variant measured, as one string to compare: its root's delta, and
 * its tree's when it has one. Canonical, so key order doesn't count.
 */
function measuredAs(variant: SnapVariant): string {
  return canonicalJson({ delta: variant.delta ?? {}, tree: treeChanged(variant) ? variant.treeDelta : {} });
}

/**
 * Values of one property that measured the same as each other wherever
 * both were measured with the other properties held still, root and tree
 * alike (section 5.3 of the design): `variant=ghost` and `variant=link`
 * drawing one thing. detectNoOpProperties names a property all of whose
 * values do; `skip` are those it named, which this leaves out. Each group
 * lists the values that matched, in the property's order.
 */
export function detectIdenticalValues(
  properties: FigmaVariantProperty[],
  variants: SnapVariant[],
  skip: readonly string[] = [],
): { property: string; values: string[] }[] {
  const measured = variants.filter((v) => v.status === "ok");
  const found: { property: string; values: string[] }[] = [];
  for (const property of properties) {
    if (skip.includes(property.name)) continue;
    // For each pair of values: whether every comparison found them equal, and how many there were.
    const pairs = new Map<string, { same: boolean }>();
    const groups = new Map<string, Map<string, string>>();
    for (const variant of measured) {
      const value = variant.combination[property.name];
      if (value === undefined) continue;
      const others = JSON.stringify(Object.entries(variant.combination).filter(([name]) => name !== property.name));
      const group = groups.get(others) ?? new Map<string, string>();
      group.set(value, measuredAs(variant));
      groups.set(others, group);
    }
    for (const group of groups.values()) {
      const values = property.values.filter((v) => group.has(v));
      for (let i = 0; i < values.length; i++) {
        for (let j = i + 1; j < values.length; j++) {
          const key = `${values[i]}\u0000${values[j]}`;
          const pair = pairs.get(key) ?? { same: true };
          pair.same &&= group.get(values[i]) === group.get(values[j]);
          pairs.set(key, pair);
        }
      }
    }
    // Values joined into groups by the pairs that always matched.
    const joined = new Map<string, string[]>();
    for (const [key, { same }] of pairs) {
      if (!same) continue;
      const [a, b] = key.split("\u0000");
      const into = joined.get(a) ?? joined.get(b) ?? [a];
      for (const v of [a, b]) if (!into.includes(v)) into.push(v);
      for (const v of into) joined.set(v, into);
    }
    const seen = new Set<string[]>();
    for (const value of property.values) {
      const group = joined.get(value);
      if (!group || seen.has(group)) continue;
      seen.add(group);
      found.push({ property: property.name, values: property.values.filter((v) => group.includes(v)) });
    }
  }
  return found;
}

/** Warnings for what detectIdenticalValues found: one per group of values. */
export function describeIdenticalValues(groups: { property: string; values: string[] }[]): string[] {
  return groups.map(({ property, values }) => {
    const named = values.map((v) => `\`${property}=${v}\``);
    const list = named.length === 2 ? named.join(" and ") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
    return (
      `${list} render identically: everything snap measures, the root and the elements in it, is the same wherever ` +
      `${values.length === 2 ? "both were" : "they were"} measured. If the code draws them differently, the story ` +
      `may not pass ${property} through for these values; if it doesn't, they could be one Figma variant.`
    );
  });
}

/** Warning for variants whose tree was cut off at TREE_LIMITS, or null. */
export function describeTruncatedTrees(cut: { slug: string; truncated: { nodes: number; at: string } }[], measured: number): string | null {
  if (!cut.length) return null;
  const largest = Math.max(...cut.map((c) => c.truncated.nodes));
  const first = cut[0].truncated.at;
  const which = cut.length < measured ? `${cut.length} of ${measured} variants (${nameSlugs(cut.map((c) => c.slug))})` : "every variant";
  return (
    `the element tree of ${which} holds more than snap keeps (${TREE_LIMITS.maxNodes} elements, ${TREE_LIMITS.maxDepth} levels deep): ` +
    `up to ${largest} elements, so everything from ${first === "" ? "the root" : `\`${first}\``} on was left out, and verify lists it as not measured. ` +
    `To measure all of it, snap a story that renders less, with --stories, or measure its parts as components of their own.`
  );
}

/** Warning for variants measured at an element around the one snap chose, or null. */
export function describeClimbed(climbed: { slug: string; element: string; from: string }[], measured: number): string | null {
  if (!climbed.length) return null;
  const { element, from } = climbed[0];
  const which = climbed.length < measured ? ` in ${climbed.length} of ${measured} variants (${nameSlugs(climbed.map((c) => c.slug))})` : "";
  return (
    `snap measured ${element} rather than ${from}${which}: ${from} draws nothing and holds nothing that does, ` +
    `so its tree would be empty, and ${element} is the nearest element around it that draws.`
  );
}

/** Warning for properties detectNoOpProperties found. */
export function describeNoOpProperties(names: string[]): string | null {
  if (!names.length) return null;
  const list = names.map((name) => `\`${name}\``).join(", ");
  const one = names.length === 1;
  return (
    `${list}: every value measured the same, so ${one ? "it changes" : "they change"} nothing snap records. ` +
    `If ${one ? "it changes" : "they change"} only behavior, or something snap doesn't measure, such as content ` +
    `that renders elsewhere, ${one ? "it" : "they"} may not belong as Figma variant properties: leave ` +
    `${one ? "it" : "them"} out of every component with \`--exclude-props ${names.join(",")}\`. If the story ` +
    `drops ${one ? "it" : "them"}, pass ${one ? "it" : "them"} through to the component.`
  );
}

/**
 * Warnings for a component whose measured element may not be the component:
 * a closed trigger, or a story's layout wrapper. One per distinct note, which
 * says how many variants it applies to when not all of them.
 */
export function describeMeasurementNotes(
  name: string,
  notes: { slug: string; note: MeasurementNote }[],
  measured: number,
  title?: string,
): string[] {
  const slot = componentSlots(name)[0] ?? "";
  // The content slots chooseMeasuredElement takes, as it takes them.
  const content = contentSlots(componentSlots(name, title)).map((s) => `"${s}"`).join(" or ");
  const groups = new Map<string, { note: MeasurementNote; slugs: string[] }>();
  for (const { slug, note } of notes) {
    const key = JSON.stringify(note);
    const group = groups.get(key) ?? { note, slugs: [] };
    group.slugs.push(slug);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ note, slugs }) => {
    const which = slugs.length < measured ? ` in ${slugs.length} of ${measured} measured variants` : "";
    if (note.kind === "closed-trigger") {
      return (
        `snap measured ${note.element}, a closed trigger, rather than ${name}${which}. What it opens renders ` +
        `only while open, usually in a portal outside the story's root, so the Figma component would be the ` +
        `trigger. To measure the content, have the story snap renders (the Default story, or else the first) ` +
        `render ${name} open, with defaultOpen for example: snap measures open content that carries ` +
        `data-slot=${content}, that the trigger's aria-controls names, or that is a dialog, alert dialog, ` +
        `tooltip or menu in a portal.`
      );
    }
    return (
      `snap measured ${note.element}, which holds ${note.children} elements and draws nothing itself (no fill, ` +
      `border or shadow), so it may be the story's layout wrapper rather than ${name}${which}. If it is, give ` +
      `${name}'s root element data-slot="${slot}", render ${name} on its own in the story snap renders, or ` +
      `measure it by itself into this snap with --components, --selector and --merge (without --merge, styles.json ` +
      `would hold ${name} alone). If ${name} is itself a layout container, this is expected.`
    );
  });
}

/**
 * What a warning from describeMeasurementNotes says snap measured, so verify
 * can say it beside a score of that element: a closed trigger, or a possible
 * layout wrapper. Null for any other warning.
 */
export function parseMeasurementWarning(warning: string): MeasurementNote | null {
  const trigger = /^snap measured (.+?), a closed trigger, rather than /.exec(warning);
  if (trigger) return { kind: "closed-trigger", element: trigger[1] };
  const wrapper = /^snap measured (.+?), which holds (\d+) elements and draws nothing itself/.exec(warning);
  if (wrapper) return { kind: "layout-wrapper", element: wrapper[1], children: Number(wrapper[2]) };
  return null;
}

/**
 * Thrown when the browser goes away part-way through a run. runSnap launches
 * it once more on the first; on a second, the run stops with this before
 * anything is written, so an earlier styles.json, meta.json and screenshots
 * are left as they were: a partial result written over them, with a fresh
 * measuredAt, would read to verify as a current measurement with most of its
 * components failed.
 */
export class BrowserLostError extends Error {}

/**
 * Screenshots taken during a run, kept in a directory of their own until it
 * finishes, then moved to where styles.json records them. A run that stops
 * part-way leaves the last run's screenshots as it leaves its styles.json,
 * rather than some of them replaced by pictures of code they don't describe.
 */
export class ScreenshotStage {
  private dir: string | null = null;
  /**
   * Each staged file's recorded path, with the IDs of the components that
   * wrote it: an image's thumbnail is named by its content, so two
   * components showing one image stage one file.
   */
  private readonly files = new Map<string, Set<string>>();

  constructor(private readonly outDir: string) {}

  // The snap command exits at once on a signal, past runSnap's finally, so
  // what is staged goes with the process however it ends.
  private readonly onExit = (): void => {
    try {
      this.discard();
    } catch {
      // Left in the OS's temporary directory, which it clears.
    }
  };

  /** Stages a variant's PNG, returning the path styles.json records for it. */
  write(entry: ComponentEntry, slug: string, png: Buffer): string {
    const recorded = writeScreenshot(this.open(), entry, slug, png);
    this.claim(recorded, entry);
    return recorded;
  }

  /**
   * Stages a file at `recorded`, relative to the output directory: an
   * image's thumbnail, which a run that stops part-way must not leave
   * beside the last run's styles.json either.
   */
  writeFile(entry: ComponentEntry, recorded: string, bytes: Buffer): void {
    const path = join(this.open(), recorded);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    this.claim(recorded, entry);
  }

  private claim(recorded: string, entry: ComponentEntry): void {
    this.files.set(recorded, (this.files.get(recorded) ?? new Set<string>()).add(entry.id));
  }

  private open(): string {
    if (!this.dir) {
      this.dir = mkdtempSync(join(tmpdir(), "storysync-screenshots-"));
      process.on("exit", this.onExit);
    }
    return this.dir;
  }

  /**
   * Removes what is staged for one component, before it is measured again:
   * a variant that then fails, or measures no box, takes no screenshot, and
   * its first attempt's would otherwise replace the last run's file.
   */
  drop(entry: ComponentEntry): void {
    for (const [recorded, ids] of this.files) {
      if (!ids.delete(entry.id) || ids.size) continue;
      rmSync(join(this.dir!, recorded), { force: true });
      this.files.delete(recorded);
    }
  }

  /** Moves every staged file into the output directory. */
  commit(): void {
    for (const recorded of this.files.keys()) {
      const from = join(this.dir!, recorded);
      const to = join(this.outDir, recorded);
      mkdirSync(dirname(to), { recursive: true });
      try {
        renameSync(from, to);
      } catch (err) {
        // The temporary directory is on another filesystem, as a tmpfs /tmp is.
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        copyFileSync(from, to);
      }
    }
    this.files.clear();
    this.discard();
  }

  /** Removes whatever is still staged. */
  discard(): void {
    if (this.dir) {
      rmSync(this.dir, { recursive: true, force: true });
      process.off("exit", this.onExit);
    }
    this.dir = null;
    this.files.clear();
  }
}

/**
 * Reports variant names that had to be renumbered to stay distinct.
 *
 * Renumbering keeps the measurements intact, but the slug is the name the
 * variant carries into Figma, so the designer sees `size-small--2` with nothing
 * saying which of the two declared values it came from. Naming the combination
 * makes the mapping recoverable, and points at the fix — the clash is in the
 * declared values, not in storysync.
 */
export function describeSlugCollisions(collisions: SlugCollision[]): string | null {
  if (!collisions.length) return null;

  const named = collisions
    .map((c) => {
      const pairs = Object.entries(c.combination).map(([k, v]) => `${k}=${v}`).join(", ");
      return `${pairs || "the default combination"} became "${c.slug}" rather than "${c.base}"`;
    })
    .join("; ");

  return (
    `${collisions.length} variant ${collisions.length === 1 ? "name collides" : "names collide"} with ` +
    `an earlier one, because names ignore case and punctuation: ${named}. The measurements are correct, ` +
    `but the renumbered name is what reaches Figma. Rename the declared values so they differ by more ` +
    `than case or punctuation.`
  );
}

/**
 * Flags a declared font the browser could not render.
 *
 * A named font that never loaded is recorded as the `fontFamily` the code
 * asked for, so it measures like one that loaded, and would score full marks
 * against Figma while rendering a different typeface. Worth saying out loud,
 * because the resulting Figma text will be wrong in a way no numeric
 * comparison can see. Another platform's alias for its UI font, such as
 * `-apple-system`, or a platform's font a system stack lists after one, such
 * as `SFMono-Regular`, is passed over rather than flagged: see
 * resolveFontFamily.
 */
export function detectFontSubstitution(component: SnapComponent): string | null {
  const base = component.base?.styles;
  if (!base) return null;

  // Check every variant, not just the base — a variant that switches font
  // family carries its own `fontAvailable` in its delta, and inspecting only
  // the base would record the substitution without ever reporting it.
  const families = new Set<string>();
  if (base.fontAvailable === false && base.fontFamily) families.add(base.fontFamily);
  for (const variant of component.variants) {
    const delta = variant.delta;
    if (!delta || delta.fontAvailable !== false) continue;
    const family = delta.fontFamily ?? base.fontFamily;
    if (family) families.add(family);
  }
  // And every text in the tree: a card's description can be set in a font
  // its title, the root's text, isn't.
  if (component.tree) {
    const texts = [component.tree.base, ...component.variants.map((v) => Object.values(v.treeDelta?.set ?? {}))];
    for (const nodes of texts) {
      for (const node of nodes) {
        const tx = (node as Partial<TreeNode>).tx;
        if (tx?.fa === 0 && tx.f) families.add(tx.f);
      }
    }
  }
  if (!families.size) return null;

  const named = [...families].map((f) => `"${f}"`).join(", ");
  return (
    `the browser could not render ${named}, so the measurements describe a ` +
    `substituted typeface. Load the font in Storybook (a preview-head.html <link> is enough), ` +
    `or expect the Figma text to differ. Figma also needs the font available to its editor — ` +
    `storysync cannot install fonts into Figma.`
  );
}

/** An earlier snap a merge adds to: what is in `outDir` before the run. */
interface MergeBase {
  result: SnapResult;
  meta: SnapMeta;
}

/**
 * Reads the snap `--merge` adds to, refusing one it can't add to honestly:
 * none at all, one with no time to keep its components' age by, or one
 * measured another way, with other props left out, from another Storybook
 * or by another storysync, whose components and the new ones would not
 * describe the same thing.
 * Read before anything is measured, so a long run doesn't end on it.
 */
export function readMergeBase(opts: SnapOptions): MergeBase {
  const stylesPath = join(opts.outDir, SNAP_STYLES_FILENAME);
  const metaPath = join(opts.outDir, SNAP_META_FILENAME);
  const rerun = "Run snap without --merge to measure every component again.";
  const read = (path: string, lead: string, after: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "doesn't exist" : "can't be read as JSON";
      throw new Error(`${lead}, but ${path} ${why}${after}. ${rerun}`);
    }
  };
  const result = read(stylesPath, `--merge adds to the snap in ${opts.outDir}`, "") as SnapResult;
  if (!Array.isArray(result?.components)) {
    throw new Error(`--merge adds to the snap in ${opts.outDir}, but ${stylesPath} has no "components" list, so snap didn't write it. ${rerun}`);
  }
  const unknownAge = ", so how old they are is unknown";
  const meta = read(metaPath, `--merge keeps the components ${stylesPath} holds`, unknownAge) as SnapMeta;
  if (typeof meta?.measuredAt !== "string" || !Number.isFinite(Date.parse(meta.measuredAt))) {
    throw new Error(`--merge keeps the components ${stylesPath} holds, but ${metaPath} has no measuredAt${unknownAge}. ${rerun}`);
  }
  if (result.version !== SNAP_SCHEMA_VERSION || result.storysyncVersion !== VERSION) {
    throw new Error(`--merge keeps the components ${stylesPath} holds, but storysync ${result.storysyncVersion ?? "(unknown)"} measured them, not ${VERSION}. ${rerun}`);
  }
  if (result.variantSelection !== opts.variants) {
    throw new Error(`--merge keeps the components ${stylesPath} holds, which were measured with --variants ${result.variantSelection}: pass the same, or run snap without --merge.`);
  }
  // The kept components were measured without these props, and styles.json
  // records this run's list alone, which the audit reads: another list would
  // mix components measured two ways, and lose or misstate that record.
  const excluded = (names: readonly string[] | undefined) => [...new Set((names ?? []).map((n) => n.toLowerCase()))].sort().join(",");
  if (excluded(result.excludeProps) !== excluded(opts.excludeProps)) {
    const was = result.excludeProps?.length ? `--exclude-props ${result.excludeProps.join(",")}` : "no --exclude-props";
    throw new Error(`--merge keeps the components ${stylesPath} holds, which were measured with ${was}: pass the same, or run snap without --merge.`);
  }
  // A tree snap's components carry their elements, a root-only one's don't:
  // mixed, a push would build some components whole and some as their outer
  // element, and verify score them two ways.
  const trees = result.treeVersion !== undefined;
  if (trees !== !opts.rootOnly || (trees && result.treeVersion !== TREE_VERSION)) {
    const was = trees ? "with their element trees" : "root only (--root-only, or by a storysync that measured no trees)";
    const pass = trees ? "pass no --root-only" : "pass --root-only";
    throw new Error(`--merge keeps the components ${stylesPath} holds, which were measured ${was}: ${pass}, or run snap without --merge.`);
  }
  const url = (u: string) => String(u).replace(/\/+$/, "");
  if (url(result.storybookUrl) !== url(opts.storybookUrl)) {
    throw new Error(`--merge keeps the components ${stylesPath} holds, which were measured from ${result.storybookUrl}, not ${opts.storybookUrl}: pass the same --storybook, or run snap without --merge.`);
  }
  return { result, meta };
}

/**
 * The story `--stories` names for each component it names, by the
 * component's ID: refused before anything is measured when a name matches
 * no component Storybook lists (`listed`), or several, or the story isn't
 * one of the component's, so a typo isn't measured as the default story.
 * A pair for a component Storybook has that this run doesn't measure,
 * under `--components`, is checked the same way and left out: a push
 * passes the same pairs to every snap, re-measures of a few included.
 */
export function resolveStoryOverrides(entries: readonly ComponentEntry[], stories: Record<string, string> | undefined, listed: readonly ComponentEntry[] = entries): Map<string, string> {
  const out = new Map<string, string>();
  const measured = new Set(entries.map((e) => e.id));
  for (const [name, storyId] of Object.entries(stories ?? {})) {
    const key = name.trim().toLowerCase();
    const exact = listed.filter((e) => e.id.toLowerCase() === key || e.title?.toLowerCase() === key);
    const named = exact.length ? exact : listed.filter((e) => e.name.toLowerCase() === key || e.title?.split("/").pop()?.toLowerCase() === key);
    if (!named.length) {
      throw new Error(`--stories names "${name}", which is none of the components being measured (${entries.map((e) => e.id).join(", ") || "none"}). Name each by its ID or title.`);
    }
    // A name two components share, as Button is under ui/base and ui/radix, is the one whose story it is.
    const matched = named.length > 1 ? named.filter((e) => e.storyIds?.includes(storyId.trim())) : named;
    if (matched.length !== 1) {
      throw new Error(`--stories names "${name}", which is ${named.length} components (${named.map((e) => e.id).join(", ")}). Name it by its ID or title.`);
    }
    const [entry] = matched;
    const story = storyId.trim();
    if (entry.storyIds?.length && !entry.storyIds.includes(story)) {
      throw new Error(`--stories gives ${entry.id} the story "${story}", which isn't one of its stories: ${entry.storyIds.join(", ")}.`);
    }
    if (measured.has(entry.id)) out.set(entry.id, story);
  }
  return out;
}

/** The warning runSnap gives each of two components that share a key. */
const SHARED_KEY_WARNING = /^\d+ components share the key "/;

export async function runSnap(opts: SnapOptions, deps: SnapDeps): Promise<SnapResult> {
  const progress = deps.onProgress ?? (() => {});
  // A typo'd name throws here rather than filtering to nothing, which would
  // still stamp a fresh `measuredAt` over an empty snap.
  const listed = await deps.storybook.listComponents();
  const entries = selectComponents(listed, opts.components);
  const earlier = opts.merge ? readMergeBase(opts) : null;
  const stories = resolveStoryOverrides(entries, opts.stories, listed);
  // A component measured again into a snap keeps the story it was measured
  // from where --stories names none, so a re-measure of a push that chose
  // another story doesn't switch it back to the default.
  for (const entry of earlier ? entries : []) {
    const was = earlier!.result.components.find((c) => (c.id ?? componentKey(c)) === entry.id)?.storyId;
    if (!stories.has(entry.id) && was && entry.storyIds?.includes(was)) stories.set(entry.id, was);
  }
  let browserVersion: string | undefined;

  const components: SnapComponent[] = [];
  const stage = new ScreenshotStage(opts.outDir);
  try {
    // Launching only when there is something to render keeps a typo in
    // `--components` from surfacing as a browser-resolution failure on a
    // machine that has no browser at all.
    if (entries.length) {
      let { browser, via } = await deps.launch({ headless: true });
      progress(`Browser: ${via}`);
      // For meta.json: text widths differ from one browser build to the next.
      const versionOf = (b: typeof browser) => {
        try {
          return typeof b.version === "function" ? b.version() : undefined;
        } catch {
          return undefined;
        }
      };
      browserVersion = versionOf(browser);
      // A browser that goes before the run ends, crashed or killed from
      // outside, failed every component left as a broken session, and the
      // run then wrote that over the last styles.json and exited 0. It is
      // launched once more instead, and the component it was on measured
      // again from the start: the run, however long it had been going, is
      // otherwise lost whole, as snap has no resume. If it goes a second
      // time the run stops, writing nothing. Signals are the CLI's to
      // handle: the snap command exits on SIGINT, SIGTERM and SIGHUP at
      // once, writing nothing either.
      let lost = false;
      const watch = (watched: typeof browser) => {
        lost = false;
        // Only the browser in use: the one it replaced can report its loss late.
        watched.on?.("disconnected", () => { if (watched === browser) lost = true; });
      };
      watch(browser);
      // Called between steps, so a run that can't finish stops before
      // anything is written. The disconnected event and the failures it
      // causes can arrive in either order, so the browser is asked too. `on`
      // and `isConnected` are absent only from test stand-ins.
      const checkpoint = () => {
        if (!lost && browser.isConnected?.() !== false) return;
        const kept = opts.screenshots
          ? `${SNAP_STYLES_FILENAME}, ${SNAP_META_FILENAME} and the screenshots were`
          : `${SNAP_STYLES_FILENAME} and ${SNAP_META_FILENAME} were`;
        throw new BrowserLostError(
          `The browser closed before snap finished (it crashed, or something stopped it), with ${components.length} of ${entries.length} components read. ` +
            `${kept} left as they were. Run snap again.`,
        );
      };

      let relaunched = false;
      try {
        for (let index = 0; index < entries.length;) {
          const entry = entries[index];
          deps.onComponentStart?.(index + 1, entries.length, entry.title ?? entry.name);
          try {
            checkpoint();
            const measured = await snapComponent(entry, opts, deps, browser, progress, checkpoint, stage, stories.get(entry.id));
            // Its failures may have been the browser going.
            checkpoint();
            components.push(measured);
            index++;
          } catch (err) {
            if (!(err instanceof BrowserLostError) || relaunched) throw err;
            relaunched = true;
            progress(`  The browser closed part-way through ${entry.title ?? entry.name}; launching it again`);
            // Measured again from the start, so its first attempt's
            // screenshots go: one the second attempt doesn't take would
            // still replace the last run's.
            stage.drop(entry);
            await browser.close().catch(() => { /* already gone */ });
            ({ browser } = await deps.launch({ headless: true }));
            browserVersion = versionOf(browser) ?? browserVersion;
            watch(browser);
          }
        }
      } finally {
        // Closed before anything is written: a signal while it closes stops
        // the run with nothing written, screenshots included.
        await browser.close().catch(() => { /* already gone */ });
      }
    }

    // From here to the last file nothing awaits, so a signal, which the
    // snap command handles between tasks, comes before any of it is written
    // or after all of it is.
    stage.commit();
    return writeSnap(opts, deps, listed, components, earlier, progress, browserVersion);
  } finally {
    stage.discard();
  }
}

/**
 * Puts the run's components, and under --merge the earlier snap's others,
 * in order, and writes styles.json and meta.json. Synchronous, so the two
 * files are written together or not at all.
 */
function writeSnap(
  opts: SnapOptions,
  deps: SnapDeps,
  listed: ComponentEntry[],
  measured: SnapComponent[],
  earlier: MergeBase | null,
  progress: (m: string) => void,
  browserVersion?: string,
): SnapResult {
  const measuredAt = new Date(deps.now?.() ?? Date.now()).toISOString();
  // Under --merge, every component the earlier snap has that this run didn't
  // measure again: matched by ID, which no two components share, and by key
  // only for one recorded without an ID.
  const ids = new Set(measured.map((c) => c.id));
  const keys = new Set(measured.map((c) => componentKey(c)));
  const kept = (earlier?.result.components ?? []).filter((c) => (c.id != null ? !ids.has(c.id) : !keys.has(componentKey(c))));
  const components = [...measured, ...kept];
  if (earlier) {
    progress(`Measured ${measured.length} ${measured.length === 1 ? "component" : "components"} again and kept ${kept.length} from the earlier snap`);
  }

  // Deterministic ordering so repeated runs produce identical output.
  components.sort((a, b) => componentKey(a).localeCompare(componentKey(b)));

  // Components are keyed by `title ?? id` everywhere downstream — the
  // readback, verify's expansion, the skills' file organization. Two
  // components sharing that key would silently collapse into one during
  // verification, so the collision has to be said out loud here, where the
  // data is produced. A title from Storybook's index is one component's, and
  // an ID always is, so two share a key only when Storybook gave them one
  // title, or when their titles were rebuilt from IDs, without the index,
  // and came out the same. The advice is for whichever it was: telling the
  // user to retitle components whose titles already differ in Storybook, as
  // this did, left nothing they could do. Under --merge it is worked out
  // again over the whole snap, for the components kept too.
  for (const component of kept) component.warnings = component.warnings.filter((w) => !SHARED_KEY_WARNING.test(w));
  const derived = new Set(listed.filter((e) => e.titleDerived).map((e) => e.id));
  const byKey = new Map<string, SnapComponent[]>();
  for (const component of components) {
    const key = componentKey(component);
    byKey.set(key, [...(byKey.get(key) ?? []), component]);
  }
  for (const [key, sharing] of byKey) {
    if (sharing.length < 2) continue;
    const fix = sharing.some((c) => c.id != null && derived.has(c.id))
      ? `Their titles were rebuilt from their Storybook IDs, since ${opts.storybookUrl.replace(/\/+$/, "")}/index.json couldn't be read or doesn't list them: make it reachable, so Storybook's own titles are used.`
      : "Give them distinct Storybook titles.";
    for (const component of sharing) {
      component.warnings.push(
        `${sharing.length} components share the key "${key}", which identifies a component in ` +
          `the readback and during verification — their variants will collide and only one will ` +
          `be scored. ${fix}`,
      );
    }
  }

  const allVariants = components.flatMap((c) => c.variants);
  const result: SnapResult = {
    version: SNAP_SCHEMA_VERSION,
    storysyncVersion: VERSION,
    storybookUrl: opts.storybookUrl,
    variantSelection: opts.variants,
    ...(opts.excludeProps?.length ? { excludeProps: opts.excludeProps } : {}),
    ...(opts.rootOnly ? {} : { treeVersion: TREE_VERSION, treeLimits: { ...TREE_LIMITS } }),
    components,
    summary: {
      components: components.length,
      variants: allVariants.length,
      rendered: allVariants.filter((v) => v.status === "ok").length,
      failed: allVariants.filter((v) => v.status !== "ok").length,
      componentsFailed: components.filter((c) => c.error != null).length,
      componentsWithWarnings: components.filter((c) => c.warnings.length > 0).length,
      componentsCapped: components.filter((c) => c.cap != null).length,
    },
  };

  // A merged snap is only as fresh as its oldest component: its measuredAt
  // is that one's, and each component keeps its own time, so verify holds
  // a readback to when its component was measured.
  let times: Record<string, string> | undefined;
  if (earlier) {
    times = {};
    for (const component of kept) {
      const key = componentKey(component);
      times[key] = earlier.meta.componentsMeasuredAt?.[key] ?? earlier.meta.measuredAt;
    }
    for (const component of measured) times[componentKey(component)] = measuredAt;
  }
  const oldest = Object.values(times ?? {}).reduce((min, t) => (Date.parse(t) < Date.parse(min) ? t : min), measuredAt);

  writeStylesJson(opts.outDir, result);
  writeMetaJson(opts.outDir, result, oldest, times, browserVersion, opts.channelArgs === false);
  return result;
}

/** A variant's tree as captured, until the component's base is known and its assets are written. */
interface VariantTree {
  variant: SnapVariant;
  nodes: TreeNode[];
  truncated?: { nodes: number; at: string };
}

async function snapComponent(
  entry: ComponentEntry,
  opts: SnapOptions,
  deps: SnapDeps,
  browser: Awaited<ReturnType<typeof resolveAndLaunch>>["browser"],
  progress: (m: string) => void,
  checkpoint: () => void,
  stage: ScreenshotStage,
  storyOverride?: string,
): Promise<SnapComponent> {
  const shell: SnapComponent = {
    id: entry.id,
    name: entry.name,
    title: entry.title,
    category: entry.category,
    storyId: null,
    variantProperties: [],
    base: null,
    variants: [],
    warnings: [],
    error: null,
  };

  let component: StorybookComponent;
  try {
    component = await deps.storybook.getComponent(entry.id, entry.name, entry.title, entry.category);
  } catch (err) {
    shell.error = `could not read component documentation: ${String(err)}`;
    progress(`  ✗ ${entry.name}: ${shell.error}`);
    return shell;
  }

  const maxCombinations = opts.maxCombinations ?? DEFAULT_MAX_COMBINATIONS;
  let definition = mapComponent(withoutProps(component, opts.excludeProps ?? []), maxCombinations);
  const storyId = storyOverride ?? pickStory(entry.storyIds, component);
  shell.variantProperties = definition.variantProperties;
  shell.storyId = storyId;

  if (!storyId) {
    shell.error = "no stories found for this component";
    progress(`  ✗ ${entry.name}: ${shell.error}`);
    return shell;
  }

  let combinations = selectCombinations(opts.variants, definition.variantProperties, definition.variantCombinations);
  // Only the full product can exceed the ceiling; representative mode measures
  // one value at a time and never approaches it.
  const capOf = () => {
    delete shell.cap;
    if (opts.variants === "all" && definition.cap) {
      shell.cap = { ...definition.cap, uncovered: uncoveredValues(definition.variantProperties, combinations) };
    }
  };
  capOf();

  // Slugs are assigned up front, for the whole set at once, because uniqueness
  // is a property of the set rather than of any one combination. This is also
  // why it happens before the browser starts: the clash is in the declared
  // values, so it is worth reporting even if nothing renders.
  let { slugs, collisions } = assignVariantSlugs(combinations);

  // Context creation is inside the guarded block so a failure here is recorded
  // against this component rather than abandoning the whole run, and so a
  // context whose first page fails to open still gets closed.
  let context: Awaited<ReturnType<typeof createContext>> | null = null;
  const notes: { slug: string; note: MeasurementNote }[] = [];
  // Each measured variant's markup checksum, for describeIdenticalVariants.
  const markups: (string | null)[] = [];
  // Variants whose args couldn't be checked against Storybook's preview, of
  // those captured, and why.
  let captures = 0;
  const unchecked: string[] = [];
  let uncheckedError: string | undefined;
  // The element tree of each measured variant, and what its assets are made of.
  const trees: VariantTree[] = [];
  const svgAssets: Record<string, string> = {};
  const images = new Map<string, CapturedImage>();
  const treeNotes = new Set<string>();
  const climbed: { slug: string; element: string; from: string }[] = [];
  // Whether the story's argTypes options have been read into the variant properties yet.
  let supplemented = false;
  try {
    checkpoint();
    context = await createContext(browser);
    const page = await context.newPage();

    for (let index = 0; index < combinations.length; index++) {
      const combination = combinations[index];
      deps.onVariantStart?.(index + 1, combinations.length);
      // A value the URL can't carry is left out of it and set through
      // Storybook's preview once the story loads, as one it refused is.
      const { param, unsupported, unsupportedNames } = encodeStoryArgs(combination, definition.variantProperties);

      const capture = (): Promise<CaptureResult> => {
        checkpoint();
        return captureStory(page, buildStoryUrl(opts.storybookUrl, storyId, param), {
          timeoutMs: opts.timeoutMs,
          selector: opts.selector,
          screenshot: opts.screenshots,
          component: { name: entry.name, title: entry.title },
          story: { id: storyId, args: combination, properties: definition.variantProperties, notInUrl: unsupportedNames },
          channelArgs: opts.channelArgs ?? true,
          tree: opts.rootOnly ? "count" : "tree",
        });
      };
      // Once more on a timeout loading the story: a busy Storybook times out
      // stories that render a moment later, and a variant left unmeasured
      // gets built from source instead. Not on one after it loaded, which
      // would only take as long again.
      let captured = await capture();
      if (captured.status === "timeout" && captured.retryable) captured = await capture();

      // The story's argTypes options, read with the first variant, add the
      // values the docs' types don't list, and make a prop whose type lists
      // none an axis (section 5.2 of the design): planned now, measured in
      // this run, after the planned ones. A new axis renames every
      // combination, the first one measured included, so then the plan
      // starts again; so does one the added values would push past
      // --max-combinations, whose tail, the added values, would be cut
      // off, where the wider plan's capped set covers every value.
      if (!supplemented && captured.args?.argTypes) {
        supplemented = true;
        const wider = mapComponent(withoutProps(supplementOptions(component, captured.args.argTypes), opts.excludeProps ?? []), maxCombinations);
        if (JSON.stringify(wider.variantProperties) !== JSON.stringify(definition.variantProperties)) {
          const known = new Set(definition.variantProperties.map((p) => p.name));
          const axis = wider.variantProperties.some((p) => !known.has(p.name));
          const plan = selectCombinations(opts.variants, wider.variantProperties, wider.variantCombinations);
          const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);
          const appended = [...combinations, ...plan.filter((c) => !combinations.some((d) => same(c, d)))];
          const restart = axis || (opts.variants === "all" && appended.length > Math.max(maxCombinations, 1));
          combinations = restart ? plan : appended;
          definition = wider;
          shell.variantProperties = definition.variantProperties;
          ({ slugs, collisions } = assignVariantSlugs(combinations));
          capOf();
          progress(`  ${entry.title ?? entry.name}: the story's argTypes options add ${axis ? "a variant property" : "values"}; ${combinations.length} variants planned`);
          if (restart) {
            // Nothing measured under the old plan stands: a variant that
            // failed before the args could be read has a combination
            // without the new property, which no variant of the set names,
            // and a cold Storybook's first story is the likeliest to time out.
            shell.variants = [];
            shell.base = null;
            captures = 0;
            unchecked.length = 0;
            uncheckedError = undefined;
            notes.length = 0;
            markups.length = 0;
            trees.length = 0;
            for (const id of Object.keys(svgAssets)) delete svgAssets[id];
            images.clear();
            treeNotes.clear();
            climbed.length = 0;
            stage.drop(entry);
            index = -1;
            continue;
          }
        }
      }

      const slug = slugs[index];
      captures++;

      // What the story's argTypes are, from the first variant that read them.
      const args = captured.args;
      if (args?.argTypes && !shell.argTypes) {
        shell.argTypes = args.argTypes;
        if (args.storyFile) shell.storyFile = args.storyFile;
        const undocumented = argsNotInDocs(args.argTypes, component.props.map((p) => p.name));
        if (undocumented.length) shell.argsNotInDocs = undocumented;
      }
      // Of a combination that asks for nothing, nothing can have been refused.
      const notChecked = !!args && !args.checked && Object.keys(combination).length > 0;
      if (notChecked) {
        unchecked.push(slug);
        uncheckedError ??= args.error;
      }
      // For a variant the story still wasn't given values, those values.
      const rejectedArgs = captured.status === "arg_rejected" ? args?.unapplied : args?.rejected;
      const argsRecord = {
        ...(rejectedArgs?.length ? { rejectedArgs, ...(args?.appliedVia ? { appliedVia: args.appliedVia } : {}) } : {}),
        ...(notChecked ? { argsChecked: false as const } : {}),
      };

      if (captured.status !== "ok" || !captured.raw || !captured.boundingBox) {
        // A failure because the browser went is not this variant's.
        checkpoint();
        // Values the URL can't carry, which the preview didn't take either,
        // are args_unsupported, as before snap tried the preview.
        if (captured.status === "arg_rejected" && args?.unapplied.every((r) => r.reasons.includes("url-unsafe"))) {
          shell.variants.push({
            combination, slug, status: "args_unsupported",
            error:
              `Storybook cannot receive ${unsupported.join(", ")} through the args URL (outside its allowed character set), ` +
              `and snap couldn't set ${unsupported.length === 1 ? "it" : "them"} through Storybook's preview either` +
              `${args.error ? ` (${args.error})` : ""}, so this variant was not measured`,
            ...argsRecord,
          });
          continue;
        }
        shell.variants.push({ combination, slug, status: captured.status, error: captured.error, ...argsRecord });
        continue;
      }

      const styles = normalizeStyles(captured.raw, captured.boundingBox, captured.textRaw, captured.fontAvailable, captured.fonts, captured.textLayout);
      const variant: SnapVariant = {
        combination, slug, status: "ok", error: null,
        boundingBox: { width: styles.width, height: styles.height },
        ...(captured.element ? { element: captured.element } : {}),
        ...(captured.portal ? { portal: captured.portal } : {}),
        ...argsRecord,
      };
      for (const note of captured.notes) notes.push({ slug, note });
      if (captured.climbedFrom) climbed.push({ slug, element: captured.element ?? "", from: captured.climbedFrom });
      markups.push(captured.markup ?? null);

      // The first successful render becomes the reference for every delta.
      if (!shell.base) {
        shell.base = { combination, slug, styles };
        variant.delta = {};
      } else {
        variant.delta = diffFromBase(shell.base.styles, styles);
      }
      // Its tree's delta comes once every variant is in, as the base's
      // images may only then have their thumbnails; this keeps its place
      // beside `delta`.
      if (captured.tree) {
        variant.treeDelta = undefined;
        trees.push({ variant, nodes: captured.tree.nodes, ...(captured.tree.truncated ? { truncated: captured.tree.truncated } : {}) });
        Object.assign(svgAssets, captured.tree.svg);
        for (const [id, image] of Object.entries(captured.tree.images)) {
          const known = images.get(id);
          // One thumbnail serves every variant: the largest box's, so the smaller downscale it.
          if (!known || image.box[0] * image.box[1] > known.box[0] * known.box[1]) images.set(id, image);
        }
        for (const note of captured.tree.notes) treeNotes.add(note);
      }
      if (captured.innerElements !== undefined) variant.innerElements = captured.innerElements;

      if (captured.screenshot) {
        variant.screenshot = stage.write(entry, slug, captured.screenshot);
      }

      shell.variants.push(variant);
    }

    // Each image's thumbnail, drawn in the page from its source's bytes.
    if (trees.length) {
      const assets = await writeImageAssets(page, entry, images, stage, shell.warnings);
      shell.capture = "tree";
      shell.tree = assembleTree(trees, svgAssets, assets);
    }
  } catch (err) {
    if (err instanceof BrowserLostError) throw err;
    checkpoint();
    shell.error = `browser session failed: ${String(err)}`;
  } finally {
    await context?.close().catch(() => { /* already gone */ });
  }

  const collided = describeSlugCollisions(collisions);
  if (collided) shell.warnings.unshift(collided);
  if (shell.cap) shell.warnings.unshift(describeCap(entry.title ?? entry.name, shell.cap));

  const measured = shell.variants.filter((v) => v.status === "ok").length;
  shell.warnings.push(...describeMeasurementNotes(entry.name, notes, measured, entry.title));
  const climbedWarning = describeClimbed(climbed, measured);
  if (climbedWarning) shell.warnings.push(climbedWarning);
  const label = entry.title ?? entry.name;
  shell.warnings.push(...describeArgRejections(label, shell.variants, { storyFile: shell.storyFile, id: entry.id }));
  const uncheckedWarning = describeUncheckedArgs(label, unchecked, captures, { error: uncheckedError, id: entry.id });
  if (uncheckedWarning) shell.warnings.push(uncheckedWarning);

  const identical = describeIdenticalVariants(shell.variants, definition.variantProperties, markups, { tree: trees.length > 0 });
  if (identical) {
    shell.warnings.push(identical);
  } else {
    const noOpNames = detectNoOpProperties(definition.variantProperties, shell.variants);
    const noOps = describeNoOpProperties(noOpNames);
    if (noOps) shell.warnings.push(noOps);
    shell.warnings.push(...describeIdenticalValues(detectIdenticalValues(definition.variantProperties, shell.variants, noOpNames)));
  }

  const truncatedWarning = describeTruncatedTrees(trees.filter((t) => t.truncated).map((t) => ({ slug: t.variant.slug, truncated: t.truncated! })), measured);
  if (truncatedWarning) shell.warnings.push(truncatedWarning);
  for (const note of treeNotes) shell.warnings.push(`${label}: ${note}.`);

  const substituted = detectFontSubstitution(shell);
  if (substituted) shell.warnings.push(substituted);

  if (shell.error) {
    progress(`  ✗ ${label}: ${shell.error}`);
    return shell;
  }

  const ok = shell.variants.filter((v) => v.status === "ok").length;
  progress(`  ${ok === shell.variants.length ? "✓" : "!"} ${label} ${ok}/${shell.variants.length} variants measured`);
  return shell;
}

/**
 * Writes each image's thumbnail into the snap's assets, returning their
 * records by id. One that can't be drawn is left out, with a warning, and
 * the nodes showing it become frames that say so.
 */
async function writeImageAssets(
  page: Parameters<typeof makeThumbnail>[0],
  entry: ComponentEntry,
  images: Map<string, CapturedImage>,
  stage: ScreenshotStage,
  warnings: string[],
): Promise<Record<string, ImageAsset>> {
  const assets: Record<string, ImageAsset> = {};
  for (const id of [...images.keys()].sort()) {
    const image = images.get(id)!;
    try {
      const thumbnail = await makeThumbnail(page, image);
      const fnv = fnv1a32Bytes(thumbnail.bytes);
      const file = imageAssetFile(id, thumbnail.mime, fnv);
      stage.writeFile(entry, file, thumbnail.bytes);
      assets[id] = {
        file, mime: thumbnail.mime, size: thumbnail.size, natural: image.natural, fnv,
        ...(image.raster ? { raster: 1 as const } : {}),
      };
    } catch (err) {
      warnings.push(`${entry.title ?? entry.name}: snap couldn't draw a thumbnail of ${id} (${String(err instanceof Error ? err.message : err).split("\n")[0]}), so the nodes showing it are kept as frames without it.`);
    }
  }
  return assets;
}

/**
 * The component's tree: the base variant's nodes, and each other variant's
 * as a delta against them. A node showing an image that has no asset is a
 * frame, flagged, in every variant alike.
 */
function assembleTree(trees: VariantTree[], svg: Record<string, string>, img: Record<string, ImageAsset>): ComponentTree {
  for (const { nodes } of trees) {
    for (const node of nodes) {
      if (node.img && !img[node.img]) {
        node.t = "F";
        delete node.img;
        delete node.raster;
        node.approx = [node.approx, "image-unavailable"].filter(Boolean).join(",");
      }
    }
  }
  const [base, ...rest] = trees;
  for (const tree of rest) tree.variant.treeDelta = diffTree(base.nodes, tree.nodes);
  const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.keys(record).sort().map((id) => [id, record[id]]));
  // The component's truncation is its largest variant's.
  const truncated = trees.map((t) => t.truncated).filter((t) => t !== undefined).sort((a, b) => b.nodes - a.nodes)[0];
  return {
    version: TREE_VERSION,
    base: base.nodes,
    assets: { svg: sorted(svg), img: sorted(img) },
    ...(truncated ? { truncated } : {}),
  };
}

/** Longest variant slug used whole as a screenshot's file name. */
const MAX_SCREENSHOT_NAME = 120;

/**
 * A screenshot's file name: its variant's slug, or for a slug too long for a
 * file name, its start and a hash of the whole. Every combination of
 * vaul's Drawer, 16 props, comes to a slug of some 330 characters, past the
 * 255 most filesystems allow, and writing it failed the whole component.
 */
export function screenshotName(slug: string): string {
  if (slug.length <= MAX_SCREENSHOT_NAME) return `${slug}.png`;
  const hash = createHash("sha1").update(slug).digest("hex").slice(0, 10);
  return `${slug.slice(0, MAX_SCREENSHOT_NAME - hash.length - 2)}--${hash}.png`;
}

export function writeScreenshot(
  outDir: string,
  entry: ComponentEntry,
  slug: string,
  png: Buffer,
): string {
  // By title, or by ID without one: by name, two untitled components of one
  // name wrote over each other's screenshots.
  const path = join(outDir, componentSlug(entry.name, entry.title ?? entry.id), screenshotName(slug));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  // Recorded relative to the directory holding styles.json, with posix
  // separators. styles.json is meant to be committed and diffed; an absolute
  // path would differ between machines and checkouts for identical code, and
  // would write the local filesystem layout — username included — into it.
  return relative(outDir, path).split("\\").join("/");
}

/**
 * Writes styles.json. Deliberately carries no timestamp: two runs against
 * unchanged code should produce byte-identical output so the file can be
 * committed and diffed.
 */
function writeStylesJson(outDir: string, result: SnapResult): string {
  const path = join(outDir, SNAP_STYLES_FILENAME);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, stylesJsonText(result));
  return path;
}

function writeMetaJson(
  outDir: string,
  result: SnapResult,
  measuredAt: string,
  componentsMeasuredAt?: Record<string, string>,
  browserVersion?: string,
  noChannelArgs = false,
): string {
  const meta: SnapMeta = {
    version: SNAP_SCHEMA_VERSION,
    measuredAt,
    storysyncVersion: result.storysyncVersion,
    storybookUrl: result.storybookUrl,
    variantSelection: result.variantSelection,
    components: result.summary.components,
    variants: result.summary.variants,
    ...(componentsMeasuredAt ? { componentsMeasuredAt } : {}),
    platform: `${process.platform}-${process.arch}`,
    ...(browserVersion ? { browser: browserVersion } : {}),
    ...(noChannelArgs ? { channelArgs: false as const } : {}),
  };
  const path = join(outDir, SNAP_META_FILENAME);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
  return path;
}
