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
    componentsWithWarnings: number;
  };
}

export interface SnapDeps {
  storybook: StorybookClient;
  launch: typeof resolveAndLaunch;
  /** Called with human-readable progress; no-op under --json. */
  onProgress?: (message: string) => void;
}

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

export async function runSnap(opts: SnapOptions, deps: SnapDeps): Promise<SnapResult> {
  const progress = deps.onProgress ?? (() => {});
  const entries = await listSelectedComponents(deps.storybook, opts.components);

  const { browser, via } = await deps.launch({ headless: true });
  progress(`Browser: ${via}`);

  const components: SnapComponent[] = [];
  try {
    for (const entry of entries) {
      components.push(await snapComponent(entry, opts, deps, browser, progress));
    }
  } finally {
    await browser.close().catch(() => { /* already gone */ });
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
      componentsWithWarnings: components.filter((c) => c.warnings.length > 0).length,
    },
  };

  writeStylesJson(opts.outDir, result);
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
  const context = await createContext(browser);
  const page = await context.newPage();

  try {
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

      const styles = normalizeStyles(capture.raw, capture.boundingBox, capture.textRaw);
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
  } finally {
    await context.close().catch(() => { /* already gone */ });
  }

  const identical = detectIdenticalVariants(shell.variants);
  if (identical) shell.warnings.push(identical);

  const ok = shell.variants.filter((v) => v.status === "ok").length;
  progress(`  ${ok === shell.variants.length ? "✓" : "!"} ${entry.title ?? entry.name} ${ok}/${shell.variants.length} variants measured`);
  return shell;
}

function writeScreenshot(
  outDir: string,
  entry: ComponentEntry,
  slug: string,
  png: Buffer,
): string {
  const relative = join(componentSlug(entry.name, entry.title), `${slug}.png`);
  const absolute = join(outDir, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, png);
  return join(outDir, relative).split("\\").join("/");
}

/**
 * Writes styles.json. Deliberately carries no timestamp: two runs against
 * unchanged code should produce byte-identical output so the file can be
 * committed and diffed.
 */
function writeStylesJson(outDir: string, result: SnapResult): string {
  const path = join(outDir, "styles.json");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}
