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
import { mapComponent, withoutProps, representativeCombinations, DEFAULT_MAX_COMBINATIONS } from "./mapper.js";
import type { CapInfo } from "./mapper.js";
import type { FigmaVariantProperty, StorybookComponent } from "./mapper.js";
import { selectComponents, componentKey } from "./storybook.js";
import type { ComponentEntry, StorybookClient } from "./storybook.js";
import {
  normalizeStyles, encodeStoryArgs, buildStoryUrl,
  assignVariantSlugs, componentSlug, componentSlots, contentSlots, diffFromBase,
} from "./snap-normalize.js";
import type { MeasurementNote, NormalizedStyles, SlugCollision, StyleDelta } from "./snap-normalize.js";
import { resolveAndLaunch, createContext, captureStory } from "./snap-browser.js";
import type { CaptureResult, CaptureStatus } from "./snap-browser.js";

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
}

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
  const allEmpty = measured.every((v) => !v.delta || Object.keys(v.delta).length === 0);
  if (!allEmpty) return null;
  return (
    `all ${measured.length} rendered variants measured identically — the story may not pass args ` +
    `through to the component (hardcoded props, a custom render function, or a decorator). ` +
    `Measured values may describe only the default state.`
  );
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
      group.set(value, JSON.stringify(variant.delta ?? {}));
      groups.set(others, group);
    }
    const compared = [...groups.values()].filter((group) => group.size >= 2);
    if (compared.length && compared.every((group) => new Set(group.values()).size === 1)) noOps.push(property.name);
  }
  return noOps;
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
        `data-slot=${content} or that the trigger's aria-controls names.`
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
  /** Each staged PNG's recorded path, with the ID of the component it shows. */
  private readonly files = new Map<string, string>();

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
    if (!this.dir) {
      this.dir = mkdtempSync(join(tmpdir(), "storysync-screenshots-"));
      process.on("exit", this.onExit);
    }
    const recorded = writeScreenshot(this.dir, entry, slug, png);
    this.files.set(recorded, entry.id);
    return recorded;
  }

  /**
   * Removes what is staged for one component, before it is measured again:
   * a variant that then fails, or measures no box, takes no screenshot, and
   * its first attempt's would otherwise replace the last run's file.
   */
  drop(entry: ComponentEntry): void {
    for (const [recorded, id] of this.files) {
      if (id !== entry.id) continue;
      rmSync(join(this.dir!, recorded), { force: true });
      this.files.delete(recorded);
    }
  }

  /** Moves every staged PNG into the output directory. */
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
  const url = (u: string) => String(u).replace(/\/+$/, "");
  if (url(result.storybookUrl) !== url(opts.storybookUrl)) {
    throw new Error(`--merge keeps the components ${stylesPath} holds, which were measured from ${result.storybookUrl}, not ${opts.storybookUrl}: pass the same --storybook, or run snap without --merge.`);
  }
  return { result, meta };
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

  const components: SnapComponent[] = [];
  const stage = new ScreenshotStage(opts.outDir);
  try {
    // Launching only when there is something to render keeps a typo in
    // `--components` from surfacing as a browser-resolution failure on a
    // machine that has no browser at all.
    if (entries.length) {
      let { browser, via } = await deps.launch({ headless: true });
      progress(`Browser: ${via}`);
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
            const measured = await snapComponent(entry, opts, deps, browser, progress, checkpoint, stage);
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
    return writeSnap(opts, deps, listed, components, earlier, progress);
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
  writeMetaJson(opts.outDir, result, oldest, times);
  return result;
}

async function snapComponent(
  entry: ComponentEntry,
  opts: SnapOptions,
  deps: SnapDeps,
  browser: Awaited<ReturnType<typeof resolveAndLaunch>>["browser"],
  progress: (m: string) => void,
  checkpoint: () => void,
  stage: ScreenshotStage,
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

  const definition = mapComponent(withoutProps(component, opts.excludeProps ?? []), opts.maxCombinations ?? DEFAULT_MAX_COMBINATIONS);
  const storyId = pickStory(entry.storyIds, component);
  shell.variantProperties = definition.variantProperties;
  shell.storyId = storyId;

  if (!storyId) {
    shell.error = "no stories found for this component";
    progress(`  ✗ ${entry.name}: ${shell.error}`);
    return shell;
  }

  const combinations = selectCombinations(opts.variants, definition.variantProperties, definition.variantCombinations);
  // Only the full product can exceed the ceiling; representative mode measures
  // one value at a time and never approaches it.
  if (opts.variants === "all" && definition.cap) {
    shell.cap = { ...definition.cap, uncovered: uncoveredValues(definition.variantProperties, combinations) };
    shell.warnings.push(describeCap(entry.title ?? entry.name, shell.cap));
  }

  // Slugs are assigned up front, for the whole set at once, because uniqueness
  // is a property of the set rather than of any one combination. This is also
  // why it happens before the browser starts: the clash is in the declared
  // values, so it is worth reporting even if nothing renders.
  const { slugs, collisions } = assignVariantSlugs(combinations);
  const collided = describeSlugCollisions(collisions);
  if (collided) shell.warnings.push(collided);

  // Context creation is inside the guarded block so a failure here is recorded
  // against this component rather than abandoning the whole run, and so a
  // context whose first page fails to open still gets closed.
  let context: Awaited<ReturnType<typeof createContext>> | null = null;
  const notes: { slug: string; note: MeasurementNote }[] = [];
  try {
    checkpoint();
    context = await createContext(browser);
    const page = await context.newPage();

    for (const [index, combination] of combinations.entries()) {
      const slug = slugs[index];
      deps.onVariantStart?.(index + 1, combinations.length);
      const { param, unsupported } = encodeStoryArgs(combination, definition.variantProperties);

      if (unsupported.length) {
        shell.variants.push({
          combination, slug, status: "args_unsupported",
          error:
            `Storybook cannot receive ${unsupported.join(", ")} through the args URL ` +
            `(outside its allowed character set), so this variant was not measured`,
        });
        continue;
      }

      const capture = (): Promise<CaptureResult> => {
        checkpoint();
        return captureStory(page, buildStoryUrl(opts.storybookUrl, storyId, param), {
          timeoutMs: opts.timeoutMs,
          selector: opts.selector,
          screenshot: opts.screenshots,
          component: { name: entry.name, title: entry.title },
        });
      };
      // Once more on a timeout loading the story: a busy Storybook times out
      // stories that render a moment later, and a variant left unmeasured
      // gets built from source instead. Not on one after it loaded, which
      // would only take as long again.
      let captured = await capture();
      if (captured.status === "timeout" && captured.retryable) captured = await capture();

      if (captured.status !== "ok" || !captured.raw || !captured.boundingBox) {
        // A failure because the browser went is not this variant's.
        checkpoint();
        shell.variants.push({ combination, slug, status: captured.status, error: captured.error });
        continue;
      }

      const styles = normalizeStyles(captured.raw, captured.boundingBox, captured.textRaw, captured.fontAvailable, captured.fonts);
      const variant: SnapVariant = {
        combination, slug, status: "ok", error: null,
        boundingBox: { width: styles.width, height: styles.height },
        ...(captured.element ? { element: captured.element } : {}),
      };
      for (const note of captured.notes) notes.push({ slug, note });

      // The first successful render becomes the reference for every delta.
      if (!shell.base) {
        shell.base = { combination, slug, styles };
        variant.delta = {};
      } else {
        variant.delta = diffFromBase(shell.base.styles, styles);
      }

      if (captured.screenshot) {
        variant.screenshot = stage.write(entry, slug, captured.screenshot);
      }

      shell.variants.push(variant);
    }
  } catch (err) {
    if (err instanceof BrowserLostError) throw err;
    checkpoint();
    shell.error = `browser session failed: ${String(err)}`;
  } finally {
    await context?.close().catch(() => { /* already gone */ });
  }

  const measured = shell.variants.filter((v) => v.status === "ok").length;
  shell.warnings.push(...describeMeasurementNotes(entry.name, notes, measured, entry.title));

  const identical = detectIdenticalVariants(shell.variants);
  if (identical) {
    shell.warnings.push(identical);
  } else {
    const noOps = describeNoOpProperties(detectNoOpProperties(definition.variantProperties, shell.variants));
    if (noOps) shell.warnings.push(noOps);
  }

  const substituted = detectFontSubstitution(shell);
  if (substituted) shell.warnings.push(substituted);

  const label = entry.title ?? entry.name;
  if (shell.error) {
    progress(`  ✗ ${label}: ${shell.error}`);
    return shell;
  }

  const ok = shell.variants.filter((v) => v.status === "ok").length;
  progress(`  ${ok === shell.variants.length ? "✓" : "!"} ${label} ${ok}/${shell.variants.length} variants measured`);
  return shell;
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
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

function writeMetaJson(outDir: string, result: SnapResult, measuredAt: string, componentsMeasuredAt?: Record<string, string>): string {
  const meta: SnapMeta = {
    version: SNAP_SCHEMA_VERSION,
    measuredAt,
    storysyncVersion: result.storysyncVersion,
    storybookUrl: result.storybookUrl,
    variantSelection: result.variantSelection,
    components: result.summary.components,
    variants: result.summary.variants,
    ...(componentsMeasuredAt ? { componentsMeasuredAt } : {}),
  };
  const path = join(outDir, SNAP_META_FILENAME);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
  return path;
}
