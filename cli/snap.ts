// Orchestration for `storysync snap`: render every variant of every component
// and record what the browser actually computed.
//
// Browser work lives in snap-browser.ts and all value normalization in
// snap-normalize.ts; this module decides *what* to render and how to lay the
// results out on disk.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "./version.js";
import { mapComponent, representativeCombinations } from "./mapper.js";
import type { FigmaVariantProperty, StorybookComponent } from "./mapper.js";
import type { ComponentEntry, StorybookClient } from "./storybook.js";
import {
  normalizeStyles, encodeStoryArgs, buildStoryUrl,
  slugifyCombination, componentSlug, diffFromBase,
} from "./snap-normalize.js";
import type { NormalizedStyles, StyleDelta } from "./snap-normalize.js";
import { resolveAndLaunch, createContext, captureStory } from "./snap-browser.js";
import type { CaptureStatus } from "./snap-browser.js";

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
}

export type SnapVariantStatus = CaptureStatus | "args_unsupported";

export interface SnapVariant {
  combination: Record<string, string>;
  slug: string;
  status: SnapVariantStatus;
  error: string | null;
  /** Differences from the component's base styles. Empty for the base itself. */
  delta?: StyleDelta;
  /** Project-relative PNG path, when screenshots are enabled. */
  screenshot?: string;
  boundingBox?: { width: number; height: number };
}

export interface SnapComponent {
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
}

export interface SnapResult {
  version: number;
  storysyncVersion: string;
  storybookUrl: string;
  variantSelection: VariantSelection;
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
  };
}

export interface SnapDeps {
  storybook: StorybookClient;
  launch: typeof resolveAndLaunch;
  /** Called with human-readable progress; no-op under --json. */
  onProgress?: (message: string) => void;
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

function selectCombinations(
  selection: VariantSelection,
  properties: FigmaVariantProperty[],
  full: Record<string, string>[],
): Record<string, string>[] {
  return selection === "all" ? full : representativeCombinations(properties);
}

/**
 * Flags the one failure mode that measurement cannot otherwise detect: a story
 * that ignores its args (hardcoded props, a custom `render`, or a decorator
 * that drops them) renders identically for every combination, so the measured
 * values would silently describe the default state for all of them.
 */
function detectIdenticalVariants(variants: SnapVariant[]): string | null {
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
 * Flags a declared font the browser could not render.
 *
 * The measured `fontFamily` is the first *declared* family, not the resolved
 * one, so a project naming a font it never loaded measures identically to one
 * that loaded it — and would score full marks against Figma while rendering a
 * different typeface. Worth saying out loud, because the resulting Figma text
 * will be wrong in a way no numeric comparison can see.
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

export async function runSnap(opts: SnapOptions, deps: SnapDeps): Promise<SnapResult> {
  const progress = deps.onProgress ?? (() => {});
  const entries = await listSelectedComponents(deps.storybook, opts.components);

  const components: SnapComponent[] = [];

  // Launching only when there is something to render keeps a typo in
  // `--components` from surfacing as a browser-resolution failure on a machine
  // that has no browser at all.
  if (entries.length) {
    const { browser, via } = await deps.launch({ headless: true });
    progress(`Browser: ${via}`);
    try {
      for (const entry of entries) {
        components.push(await snapComponent(entry, opts, deps, browser, progress));
      }
    } finally {
      await browser.close().catch(() => { /* already gone */ });
    }
  }

  // Deterministic ordering so repeated runs produce identical output.
  components.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));

  const allVariants = components.flatMap((c) => c.variants);
  const result: SnapResult = {
    version: SNAP_SCHEMA_VERSION,
    storysyncVersion: VERSION,
    storybookUrl: opts.storybookUrl,
    variantSelection: opts.variants,
    components,
    summary: {
      components: components.length,
      variants: allVariants.length,
      rendered: allVariants.filter((v) => v.status === "ok").length,
      failed: allVariants.filter((v) => v.status !== "ok").length,
      componentsFailed: components.filter((c) => c.error != null).length,
      componentsWithWarnings: components.filter((c) => c.warnings.length > 0).length,
    },
  };

  writeStylesJson(opts.outDir, result);
  writeMetaJson(opts.outDir, result, new Date(deps.now?.() ?? Date.now()).toISOString());
  return result;
}

async function listSelectedComponents(
  storybook: StorybookClient,
  filter?: string[],
): Promise<ComponentEntry[]> {
  const entries = await storybook.listComponents();
  if (!filter?.length) return entries;
  const wanted = new Set(filter.map((s) => s.trim().toLowerCase()));
  return entries.filter((e) => wanted.has(e.name.toLowerCase()) || wanted.has(e.id.toLowerCase()));
}

async function snapComponent(
  entry: ComponentEntry,
  opts: SnapOptions,
  deps: SnapDeps,
  browser: Awaited<ReturnType<typeof resolveAndLaunch>>["browser"],
  progress: (m: string) => void,
): Promise<SnapComponent> {
  const shell: SnapComponent = {
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

  const definition = mapComponent(component);
  const storyId = pickStory(entry.storyIds, component);
  shell.variantProperties = definition.variantProperties;
  shell.storyId = storyId;

  if (!storyId) {
    shell.error = "no stories found for this component";
    progress(`  ✗ ${entry.name}: ${shell.error}`);
    return shell;
  }

  const combinations = selectCombinations(opts.variants, definition.variantProperties, definition.variantCombinations);

  // Context creation is inside the guarded block so a failure here is recorded
  // against this component rather than abandoning the whole run, and so a
  // context whose first page fails to open still gets closed.
  let context: Awaited<ReturnType<typeof createContext>> | null = null;
  try {
    context = await createContext(browser);
    const page = await context.newPage();

    for (const combination of combinations) {
      const slug = slugifyCombination(combination);
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

      const capture = await captureStory(page, buildStoryUrl(opts.storybookUrl, storyId, param), {
        timeoutMs: opts.timeoutMs,
        selector: opts.selector,
        screenshot: opts.screenshots,
      });

      if (capture.status !== "ok" || !capture.raw || !capture.boundingBox) {
        shell.variants.push({ combination, slug, status: capture.status, error: capture.error });
        continue;
      }

      const styles = normalizeStyles(capture.raw, capture.boundingBox, capture.textRaw, capture.fontAvailable);
      const variant: SnapVariant = {
        combination, slug, status: "ok", error: null,
        boundingBox: { width: styles.width, height: styles.height },
      };

      // The first successful render becomes the reference for every delta.
      if (!shell.base) {
        shell.base = { combination, slug, styles };
        variant.delta = {};
      } else {
        variant.delta = diffFromBase(shell.base.styles, styles);
      }

      if (capture.screenshot) {
        variant.screenshot = writeScreenshot(opts.outDir, entry, slug, capture.screenshot);
      }

      shell.variants.push(variant);
    }
  } catch (err) {
    shell.error = `browser session failed: ${String(err)}`;
  } finally {
    await context?.close().catch(() => { /* already gone */ });
  }

  const identical = detectIdenticalVariants(shell.variants);
  if (identical) shell.warnings.push(identical);

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

function writeScreenshot(
  outDir: string,
  entry: ComponentEntry,
  slug: string,
  png: Buffer,
): string {
  const path = join(outDir, componentSlug(entry.name, entry.title), `${slug}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  // Posix separators so the recorded path is stable across platforms.
  return path.split("\\").join("/");
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

function writeMetaJson(outDir: string, result: SnapResult, measuredAt: string): string {
  const meta: SnapMeta = {
    version: SNAP_SCHEMA_VERSION,
    measuredAt,
    storysyncVersion: result.storysyncVersion,
    storybookUrl: result.storybookUrl,
    variantSelection: result.variantSelection,
    components: result.summary.components,
    variants: result.summary.variants,
  };
  const path = join(outDir, SNAP_META_FILENAME);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
  return path;
}
