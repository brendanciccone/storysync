// The only browser-bound module in storysync.
//
// Everything that can be tested without Chromium lives in snap-normalize.ts
// and snap-args.ts; this file is limited to launching a browser, reading one
// story's rendered styles out of the page, and seeing that Storybook gave the
// story the args snap asked for.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Browser, BrowserContext, ConsoleMessage, Page, ElementHandle, Request, Response } from "playwright-core";
import {
  CAPTURED_PROPERTIES, TEXT_PROPERTIES, WRAPPER_PROPERTIES, NON_RENDERED_TAGS, OVERLAY_SELECTOR,
  chooseMeasuredElement, componentSlots, contentSlots, describeElement, resolveFontFamily,
} from "./snap-normalize.js";
import type { RawComputedStyles, RawTextLayout, FontProbe, MeasurementNote, PortalNode, StoryNode } from "./snap-normalize.js";
import {
  compactArgTypes, findRejectedArgs, previewArgUpdate, rejectionsFromWarnings, stillRejected,
} from "./snap-args.js";
import type { ArgRejection, StoryArgsCheck, StoryArgsSnapshot, StoryArgType } from "./snap-args.js";
import type { FigmaVariantProperty } from "./mapper.js";
import type { StoryOwn } from "./snap-stories.js";
import { RAW_TREE_LIMITS, TEXT_TREE_PROPERTIES, TREE_PROPERTY_DEFAULTS, buildTree, countInnerElements } from "./snap-tree.js";
import type { PendingImage, RawBox, RawTreeCapture, RawTreeElement, RawTreeItem, RawTreePseudo, RawTreeText } from "./snap-tree.js";
import {
  SVG_DROPPED_TAGS, SVG_GEOMETRY, SVG_GROUP_PROPERTIES, SVG_PAINT_PROPERTIES, SVG_SHAPE_TAGS, THUMBNAIL_ENCODING,
  decodeDataUrl, imageAssetId, imageCrop, pngSize, sniffImageType, thumbnailSize,
} from "./snap-assets.js";
import type { ImageCrop, RawSvgNode } from "./snap-assets.js";
import type { TreeNode } from "./tree-types.js";
import { STAND_IN_PREFIX, standInFaces, standInStack } from "./fonts.js";
import type { StandIn } from "./fonts.js";

// --- Browser resolution -----------------------------------------------------

/**
 * Where a system Chromium is usually found. Probed only after playwright's own
 * resolution has failed.
 */
const SYSTEM_BROWSER_PATHS: readonly string[] = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

export interface LaunchResult {
  browser: Browser;
  /** How the browser was found, for diagnostics. */
  via: string;
}

/** playwright-core refuses to load below this and exits the process. */
const MINIMUM_NODE_MAJOR = 20;

/**
 * Loads playwright lazily.
 *
 * playwright-core requires Node 20+ and terminates the process on import when
 * it is older. Importing it at module scope would therefore break every
 * command — `tokens`, `map`, `diff` — for anyone on Node 18, even though only
 * `snap` needs a browser at all. Keeping the import inside this function means
 * the version requirement applies to `snap` alone.
 */
async function loadChromium(): Promise<typeof import("playwright-core")["chromium"]> {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `storysync snap needs Node ${MINIMUM_NODE_MAJOR} or newer (running ${process.versions.node}), ` +
        "because it renders stories with playwright.\n" +
        "Every other storysync command still works on Node 18.",
    );
  }
  const { chromium } = await import("playwright-core");
  return chromium;
}

/**
 * The command that downloads a browser this copy of playwright-core can
 * launch.
 *
 * Each playwright release launches only the browser build it shipped with,
 * so `npx playwright@latest install chromium` installs one that an older
 * playwright-core, from a lockfile or a global install, then can't find.
 * `playwright@<version>` depends on exactly that playwright-core, so it
 * installs the build this one looks for. Reading the version loads no
 * playwright code, so it holds on Node 18 too.
 */
export function browserInstallCommand(): string {
  let version = "latest";
  try {
    const manifest = createRequire(import.meta.url)("playwright-core/package.json") as { version?: unknown };
    if (typeof manifest.version === "string") version = manifest.version;
  } catch {
    // Not resolvable from here: latest is the best guess left.
  }
  return `npx playwright@${version} install chromium`;
}

/**
 * Finds and launches a Chromium-based browser.
 *
 * storysync depends on playwright-core, which ships no browser binaries, so a
 * browser has to be located at runtime. Each strategy is tried in turn and its
 * failure recorded, so a total failure can explain everything it attempted
 * rather than reporting only the last error.
 */
export async function resolveAndLaunch(opts: { headless?: boolean } = {}): Promise<LaunchResult> {
  const headless = opts.headless ?? true;
  const attempts: string[] = [];
  const chromium = await loadChromium();

  const tryLaunch = async (
    label: string,
    launch: () => Promise<Browser>,
  ): Promise<LaunchResult | null> => {
    try {
      return { browser: await launch(), via: label };
    } catch (err) {
      attempts.push(`  ${label}: ${firstLine(err)}`);
      return null;
    }
  };

  const explicit = process.env.STORYSYNC_BROWSER_PATH || process.env.CHROME_PATH;
  if (explicit) {
    const result = await tryLaunch(
      `executable from ${process.env.STORYSYNC_BROWSER_PATH ? "STORYSYNC_BROWSER_PATH" : "CHROME_PATH"} (${explicit})`,
      () => chromium.launch({ headless, executablePath: explicit }),
    );
    if (result) return result;
  }

  for (const channel of ["chrome", "msedge"] as const) {
    const result = await tryLaunch(`installed ${channel}`, () => chromium.launch({ headless, channel }));
    if (result) return result;
  }

  // Picks up a playwright-managed download, including PLAYWRIGHT_BROWSERS_PATH.
  const managed = await tryLaunch("playwright-managed chromium", () => chromium.launch({ headless }));
  if (managed) return managed;

  for (const path of SYSTEM_BROWSER_PATHS) {
    if (!existsSync(path)) continue;
    const result = await tryLaunch(`system browser at ${path}`, () =>
      chromium.launch({ headless, executablePath: path }),
    );
    if (result) return result;
  }

  throw new Error(
    "Could not find a Chromium-based browser to render Storybook stories.\n" +
      "Tried:\n" +
      (attempts.length ? attempts.join("\n") : "  (no candidates found)") +
      "\n\nFix this by any one of:\n" +
      "  - install Google Chrome or Microsoft Edge\n" +
      `  - download a browser: ${browserInstallCommand()}\n` +
      "  - point storysync at an existing binary: STORYSYNC_BROWSER_PATH=/path/to/chrome\n" +
      "\nNote: use the full `playwright` package to download browsers — storysync\n" +
      "depends on playwright-core, which cannot download them itself.",
  );
}

function firstLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split("\n")[0].trim();
}

// --- Page setup -------------------------------------------------------------

export async function createContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 1280, height: 720 },
    // Sharper PNGs for human comparison; does not affect computed styles.
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
}

// --- Capture ----------------------------------------------------------------

/**
 * `arg_rejected`: Storybook didn't give the story a value its URL asked for,
 * and snap couldn't apply it through the preview either, so what rendered
 * is not that variant and was not measured. See snap-args.ts.
 */
export type CaptureStatus = "ok" | "render_error" | "timeout" | "element_not_found" | "arg_rejected";

export interface CaptureResult {
  status: CaptureStatus;
  error: string | null;
  /**
   * Whether trying again may succeed: a timeout while the story loaded, as a
   * busy Storybook's are. One later on, as a screenshot's of an element that
   * never becomes visible, would only time out again.
   */
  retryable: boolean;
  raw: RawComputedStyles | null;
  textRaw: RawComputedStyles | null;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  screenshot: Buffer | null;
  /** What the root-element heuristic settled on, for debugging. */
  matchedSelector: string | null;
  /** The element measured, as describeElement names it: `button[data-slot="switch"]`. */
  element: string | null;
  /** Why the measured element may not be the component, for snap to warn about. */
  notes: MeasurementNote[];
  /**
   * Whether the browser could render the element's font, as resolveFontFamily
   * decides it from `fonts.root`, or null when it could not be determined.
   * A declared font that never loaded would otherwise be measured as though
   * it had been used.
   */
  fontAvailable: boolean | null;
  /** What the page probed of the root's and the text's font stacks, for normalizeStyles. */
  fonts: { root: FontProbe | null; text: FontProbe | null };
  /** How the text fits its box, as readTextLayout reads it, for normalizeStyles; null without text. */
  textLayout: RawTextLayout | null;
  /**
   * A checksum of the story's markup, as readMarkup reads it, or null when
   * it changed while the variant was measured, or couldn't be read. snap
   * compares it across a component's variants and doesn't record it: see
   * describeIdenticalVariants.
   */
  markup: string | null;
  /**
   * Which of `story.args` Storybook gave the story, and what snap did about
   * any it didn't, when `story` was given and the story loaded.
   */
  args: StoryArgsCheck | null;
  /**
   * Each family the code asked for that snap drew in a stand-in instead,
   * `[asked, drawn]`: system-ui in Inter, so Chrome lays the text out as
   * Figma will (fonts.ts). Absent where none was.
   */
  standIns?: [asked: string, drawn: string][];
  /** The element tree under the measured element, when `tree` was "tree". */
  tree?: CapturedTree;
  /** How many elements that tree would hold, when `tree` was "count" (`--root-only`). */
  innerElements?: number;
  /**
   * The element snap would have measured, when it drew nothing and held
   * nothing that does, so the nearest one around it that draws was measured
   * instead (section 6.1 of the design).
   */
  climbedFrom?: string;
  /** True when the element measured is content the story renders into a portal, outside its root. */
  portal?: true;
}

export interface CaptureOptions {
  timeoutMs: number;
  /** Measures the element this matches as it is, rather than choosing one. */
  selector?: string;
  screenshot: boolean;
  /** The component the story renders, whose `data-slot` marks its root: see chooseMeasuredElement. */
  component?: { name: string; title?: string };
  /**
   * The story `url` loads, with the args its URL asks for: snap's
   * combination, and the component's variant properties, so a boolean is
   * applied as one. Given, captureStory checks that Storybook gave the story
   * each of them, applies any it didn't through Storybook's preview, and
   * fails the capture as `arg_rejected` if that doesn't take either.
   */
  story?: {
    id: string;
    args: Record<string, string>;
    properties?: readonly FigmaVariantProperty[];
    /** Args left out of the URL, which can't carry their values: each is set through the preview. */
    notInUrl?: readonly string[];
  };
  /**
   * Whether a value Storybook didn't take from the URL is set through its
   * preview (the default), or the variant left unmeasured (`--no-channel-args`).
   */
  channelArgs?: boolean;
  /**
   * What to read under the measured element: its tree ("tree"), only how
   * many elements a tree would hold ("count", for `--root-only`), or nothing.
   */
  tree?: "tree" | "count";
  /** Whether text Figma sets in a stand-in is drawn in it before it is measured. Default true. */
  standIns?: boolean;
}

/** Where Storybook mounts a story: `#storybook-root` from Storybook 7, `#root` before. */
const ROOT_CONTAINERS = ["#storybook-root", "#root"] as const;

/** Storybook's mark, on <body>, of a story that threw while it rendered. */
const STORYBOOK_ERROR_SELECTORS = ["body.sb-show-errordisplay", "body.sb-show-preparingstory-error"] as const;

/** The longest settle() waits for images still loading, within --timeout. */
const IMAGE_WAIT_MS = 5000;

/** How much of a story chooseMeasuredElement is shown: a chart can render thousands of SVG nodes. */
const TREE_LIMITS = { maxDepth: 12, maxNodes: 600 } as const;

/**
 * Reads one story's rendered styles.
 *
 * Failures are returned rather than thrown: a single story that won't render
 * should not abandon a whole snap run.
 */
export async function captureStory(page: Page, url: string, opts: CaptureOptions): Promise<CaptureResult> {
  const empty: Omit<CaptureResult, "status" | "error"> = {
    retryable: false, raw: null, textRaw: null, boundingBox: null, screenshot: null,
    matchedSelector: null, element: null, notes: [], fontAvailable: null, fonts: { root: null, text: null }, textLayout: null, markup: null, args: null,
  };
  const slots = opts.component ? componentSlots(opts.component.name, opts.component.title) : [];
  let images: ImageRequests | null = null;
  let responses: ImageResponses | null = null;
  let warnings: ArgWarnings | null = null;
  let loaded = false;

  try {
    // From before the navigation, so a request the story makes as it renders is seen.
    images = watchImageRequests(page);
    // And the bytes of each, which a tree's images are made from.
    if (opts.tree === "tree") responses = watchImageResponses(page);
    // Likewise Storybook's warning for a value it rejects, read if its preview can't be.
    if (opts.story) warnings = watchArgWarnings(page);
    await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs });
    loaded = true;

    let renderError = await readStorybookError(page);
    if (renderError) return { status: "render_error", error: renderError, ...empty };

    const appeared = await waitForStory(page, opts.selector, slots, opts.timeoutMs);
    // Storybook paints a story's error after the page has loaded. The wait
    // ends on it, or times out on a story that threw before rendering
    // anything; either way an error shown now is why nothing is there.
    renderError = await readStorybookError(page);
    if (renderError) return { status: "render_error", error: renderError, ...empty };
    if (!appeared) {
      // What was waited for: storyReadySelector passes over a <noscript> or
      // <style> in the root, so `#storybook-root > *` may well match one.
      const error = opts.selector
        ? `no element matched ${opts.selector}`
        : `nothing that draws rendered under ${ROOT_CONTAINERS.join(" or ")}`;
      return { status: "element_not_found", error, ...empty };
    }

    // Before anything is measured: a value Storybook didn't give the story
    // leaves its default on screen, under the variant's name. Kept on
    // `empty`, so a capture that fails after this still says what it found.
    if (opts.story) {
      empty.args = await checkStoryArgs(page, opts.story, opts.timeoutMs, warnings?.texts ?? [], opts.channelArgs ?? true);
      if (empty.args.unapplied.length) {
        return { status: "arg_rejected", error: describeUnapplied(empty.args), ...empty };
      }
      if (empty.args.appliedVia) {
        renderError = await readStorybookError(page);
        const values = empty.args.rejected.map((r) => `${r.name}=${r.value}`).join(", ");
        if (renderError) return { status: "render_error", error: `${renderError} (after snap set ${values} through Storybook's preview)`, ...empty };
      }
    }

    await settle(page, images, Math.min(opts.timeoutMs, IMAGE_WAIT_MS));
    // Before anything is measured, or chosen by its box.
    if (opts.standIns !== false) await drawStandIns(page, Math.min(opts.timeoutMs, IMAGE_WAIT_MS));

    const located = opts.selector ? await locateSelector(page, opts.selector) : await locateComponent(page, slots);
    if ("error" in located) return { status: "element_not_found", error: located.error, ...empty };
    // Under a tree, an element that draws nothing and holds nothing that
    // does is no root to build: the nearest one around it that draws is.
    const climbedFrom = opts.tree === "tree" && !opts.selector ? await climbToDrawing(located) : null;
    const { target, element, notes, matchedSelector, portal } = located;

    // Read before the styles and again after the picture: markup that
    // changes in between, a story that animates, is no evidence either way.
    const markupBefore = await readMarkup(page);
    const raw = await readComputedStyles(page, target, CAPTURED_PROPERTIES);
    const holder = await findTextHolder(target);
    const textRaw = holder ? await readTextStyles(page, holder, target, TEXT_PROPERTIES) : null;
    const textLayout = holder ? await readTextLayout(holder, target) : null;
    const fonts = { root: await probeFontStack(target), text: holder ? await probeFontStack(holder) : null };
    const fontAvailable = fonts.root ? resolveFontFamily(fonts.root).available : null;
    const boundingBox = await target.boundingBox();

    // Before the screenshot, which throws on an element with no box.
    if (!boundingBox) {
      return { status: "element_not_found", error: "element has no layout box (display:none?)", ...empty, raw, textRaw, element, fontAvailable, fonts, textLayout };
    }

    // Playwright waits for an element to be visible before taking its
    // picture, which one with no width or height never is: it waited its own
    // 30 seconds, whatever --timeout said, and failed a variant whose styles
    // had been read. So an empty box is measured without a picture, and a
    // picture otherwise waits no longer than --timeout.
    const drawable = boundingBox.width > 0 && boundingBox.height > 0;
    const screenshot = opts.screenshot && drawable ? await target.screenshot({ type: "png", timeout: opts.timeoutMs }) : null;
    const markupAfter = await readMarkup(page);
    const markup = markupBefore !== null && markupBefore === markupAfter ? markupBefore : null;
    // After the markup is read again: Playwright's screenshots, of an
    // element the tree keeps as a picture, rewrite inline style attributes,
    // which would read as a story that changed while it was measured.
    let tree: CapturedTree | undefined;
    let innerElements: number | undefined;
    try {
      if (opts.tree === "tree") tree = await captureTree(page, target, responses, opts.timeoutMs);
      if (opts.tree === "count") innerElements = await countTree(target);
    } catch (err) {
      // Not measured, rather than measured without its tree: a variant
      // with no tree delta reads as its base's tree.
      return { status: "render_error", error: `snap couldn't read the element tree: ${firstLine(err)}`, ...empty };
    }
    const standIns = standInsMeasured(fonts, tree);
    return {
      status: "ok", error: null, retryable: false, raw, textRaw, boundingBox, screenshot, matchedSelector, element, notes, fontAvailable, fonts, textLayout, markup, args: empty.args,
      ...(standIns.length ? { standIns } : {}),
      ...(tree ? { tree } : {}), ...(innerElements !== undefined ? { innerElements } : {}), ...(climbedFrom ? { climbedFrom } : {}),
      ...(portal ? { portal } : {}),
    };
  } catch (err) {
    // By the error's class, not its text: Playwright puts the story URL in
    // the message, so a story id or arg value containing "timeout" would turn
    // a refused connection into a timeout. Its TimeoutError names itself, and
    // this file imports only playwright's types, so the class isn't to hand.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return { status: isTimeout ? "timeout" : "render_error", error: firstLine(err), ...empty, retryable: isTimeout && !loaded };
  } finally {
    images?.stop();
    responses?.stop();
    warnings?.stop();
  }
}

/**
 * Moves `located` to the nearest element around it that draws, when neither
 * it nor anything in it does (section 6.1 of the design), returning the
 * element it was on, or null when it stays.
 */
async function climbToDrawing(located: Located): Promise<string | null> {
  const handle = await located.target.evaluateHandle(drawingElementInPage, [...ROOT_CONTAINERS]);
  const climbed = handle.asElement() as ElementHandle<Element> | null;
  if (!climbed || await climbed.evaluate((el, from) => el === from, located.target)) {
    await handle.dispose();
    return null;
  }
  const from = located.element;
  located.target = climbed;
  located.element = describeElement(await climbed.evaluate((el) => ({
    tag: el.tagName.toLowerCase(), slot: el.getAttribute("data-slot"), role: el.getAttribute("role"),
  })));
  return from;
}

/** Storybook renders thrown errors into the preview rather than failing the load. */
export function storybookErrorInPage(): string | null {
  const shown =
    document.body.classList.contains("sb-show-errordisplay") ||
    document.body.classList.contains("sb-show-preparingstory-error");
  if (!shown) return null;
  const node = document.querySelector("#error-message, .sb-errordisplay_code, #error-stack");
  const text = (node?.textContent ?? document.body.innerText ?? "").trim();
  return text.slice(0, 300) || "Storybook reported a render error";
}

async function readStorybookError(page: Page): Promise<string | null> {
  return page.evaluate(storybookErrorInPage);
}

// --- Stand-in fonts ---------------------------------------------------------
//
// Text Figma sets in a stand-in, Inter for system-ui, is drawn in it before
// anything is measured, from the same font files (fonts.ts), so Chrome and
// Figma lay it out alike. An element whose font stack opens with a CSS
// keyword or a platform face Figma lacks gets the stand-in ahead of its
// stack, inline; a child that inherits the stack inherits that too.

/**
 * The distinct computed font stacks of the text the page draws, in document
 * order: an element's whose text node lays out on screen, a form control's
 * and a ::before or ::after's with text of its own. A stack no drawn text is
 * on, html's default Times or that of Storybook's own UI, hidden while a
 * story shows, needs no stand-in.
 */
export function textFontStacksInPage(root: Element = document.documentElement): string[] {
  const visit = (el: Element, out: Element[]) => {
    out.push(el);
    for (const child of Array.from(el.children)) visit(child, out);
    const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) for (const child of Array.from(shadow.children)) visit(child, out);
    return out;
  };
  const drawn = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getClientRects().length > 0;
  };
  const stacks: string[] = [];
  const add = (stack: string) => {
    if (stack && !stacks.includes(stack)) stacks.push(stack);
  };
  for (const el of visit(root, [])) {
    const control = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.getClientRects().length > 0;
    if (control || Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()) && drawn(node))) {
      add(getComputedStyle(el).fontFamily);
    }
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      // A quoted string with something in it: `""` draws no text.
      if (/^["'][^"']/.test(style.content) && el.getClientRects().length > 0) add(style.fontFamily);
    }
  }
  return stacks;
}

/**
 * Adds the stand-ins' faces to the page and puts each element whose
 * computed stack `stacks` names on the stand-in's stack instead, inline and
 * important, so no rule of the story's outranks it. An element is read after
 * those before it are changed, so one that inherits a changed stack is left
 * as it is. Returns how many elements it changed.
 */
export function standInFontsInPage(
  args: { stacks: Record<string, string>; faces: { family: string; style: string; weight: string; unicodeRange: string; data: string }[] },
  root: Element = document.documentElement,
): number {
  for (const face of args.faces) {
    const bytes = Uint8Array.from(atob(face.data), (c) => c.charCodeAt(0));
    document.fonts.add(new FontFace(face.family, bytes, { style: face.style, weight: face.weight, unicodeRange: face.unicodeRange }));
  }
  const visit = (el: Element, out: Element[]) => {
    out.push(el);
    for (const child of Array.from(el.children)) visit(child, out);
    const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) for (const child of Array.from(shadow.children)) visit(child, out);
    return out;
  };
  let changed = 0;
  for (const el of visit(root, [])) {
    const next = args.stacks[getComputedStyle(el).fontFamily];
    if (next === undefined) continue;
    (el as HTMLElement).style.setProperty("font-family", next, "important");
    changed++;
  }
  return changed;
}

/**
 * Waits, at most `ms`, for the faces snap added (their family starts with
 * `prefix`) to load, then for two frames, so text is laid out in them. Only
 * those: a face the project declares and nothing draws in would be fetched
 * by load(), and one whose request hangs would hold the capture.
 */
export async function standInsLoadedInPage(args: { prefix: string; ms: number }): Promise<void> {
  try {
    const ours = Array.from(document.fonts).filter((face) => face.family.replace(/^["']|["']$/g, "").startsWith(args.prefix));
    await Promise.race([
      Promise.all(ours.map((face) => face.load().catch(() => null))),
      new Promise((r) => setTimeout(r, args.ms)),
    ]);
  } catch {
    // The fonts API missing is no reason to fail a capture.
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
}

/** The families a capture measured in a stand-in, `[asked, drawn]`, from its root's and text's fonts and its tree's texts, sorted. */
export function standInsMeasured(fonts: CaptureResult["fonts"], tree?: { nodes: TreeNode[] }): [string, string][] {
  const pairs = new Set<string>();
  for (const probe of [fonts.root, fonts.text]) {
    const font = probe ? resolveFontFamily(probe) : null;
    if (font?.asked) pairs.add(JSON.stringify([font.asked, font.family]));
  }
  for (const node of tree?.nodes ?? []) if (node.tx?.fs) pairs.add(JSON.stringify([node.tx.fs, node.tx.f]));
  return [...pairs].sort().map((pair) => JSON.parse(pair) as [string, string]);
}

/**
 * Draws the page's text in the stand-ins Figma will set it in (fonts.ts),
 * waiting at most `ms` for their faces, and returns how many elements it
 * put on one. Only the stand-ins the page's text needs are sent: none for
 * a story set in the project's own font.
 */
async function drawStandIns(page: Page, ms: number): Promise<number> {
  const stacks: Record<string, string> = {};
  const used = new Set<StandIn>();
  // Called with no argument, each takes the document as its root.
  const listed: unknown = await page.evaluate(textFontStacksInPage as () => string[]);
  // Only a stand-in for a page lists none.
  if (!Array.isArray(listed)) return 0;
  for (const stack of listed as string[]) {
    const standIn = standInStack(stack);
    if (!standIn) continue;
    stacks[stack] = standIn.stack;
    used.add(standIn.standIn);
  }
  if (!used.size) return 0;
  const faces = [...used].sort().flatMap((standIn) => standInFaces(standIn));
  const changed = await page.evaluate(standInFontsInPage, { stacks, faces });
  await page.evaluate(standInsLoadedInPage, { prefix: STAND_IN_PREFIX, ms });
  return changed;
}

/**
 * What waitForStory waits for, unless --selector names something else: a
 * child of the story's root that can draw, the component's own `data-slot`
 * or its `-content` slot anywhere, or an open overlay's content
 * (OVERLAY_SELECTOR), so content rendered only into a portal counts, or
 * Storybook's error display.
 *
 * One selector, so one wait: a story that never renders costs one --timeout,
 * where waiting on each root in turn cost one per root, and `#root` never
 * exists from Storybook 7 on.
 */
export function storyReadySelector(slots: readonly string[]): string {
  return [
    ...ROOT_CONTAINERS.map((container) => `${container} > :not(${NON_RENDERED_TAGS.join(", ")})`),
    ...[...new Set([...slots, ...contentSlots(slots)])].map((slot) => `[data-slot="${slot}"]`),
    OVERLAY_SELECTOR,
    ...STORYBOOK_ERROR_SELECTORS,
  ].join(", ");
}

async function waitForStory(page: Page, selector: string | undefined, slots: readonly string[], timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForSelector(selector ?? storyReadySelector(slots), { state: "attached", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Image requests in flight on a page, from now until stop(). */
interface ImageRequests {
  pending(): number;
  stop(): void;
}

function watchImageRequests(page: Page): ImageRequests {
  const inFlight = new Set<Request>();
  const started = (request: Request) => {
    if (request.resourceType() === "image") inFlight.add(request);
  };
  const ended = (request: Request) => {
    inFlight.delete(request);
  };
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return {
    pending: () => inFlight.size,
    stop: () => {
      page.off("request", started);
      page.off("requestfinished", ended);
      page.off("requestfailed", ended);
    },
  };
}

/** Whether an `<img>` on the page is still loading. A lazy one off screen never starts, so it isn't waited for. */
function imagesLoadingInPage(): boolean {
  return Array.from(document.images).some((img) => !img.complete && img.loading !== "lazy");
}

/**
 * Kills animations, then waits for fonts, two frames, and any image still
 * loading, so styles are stable and an image is measured as it ends up.
 *
 * An image is waited for while an `<img>` is incomplete or a request for one
 * is in flight. Radix's and Base UI's Avatar load theirs with `new Image()`
 * and show the fallback until it has loaded, so without the request there is
 * nothing in the page to say one is coming, and the same story measured its
 * initials in one run and its photo in the next. Bounded by `budgetMs`: an
 * image slower than that is measured as the page shows it then.
 */
async function settle(page: Page, images: ImageRequests, budgetMs: number): Promise<void> {
  await page.addStyleTag({
    content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
  }).catch(() => { /* a missing head is not worth failing over */ });

  const deadline = Date.now() + budgetMs;
  for (;;) {
    await page.evaluate(async () => {
      try { await document.fonts.ready; } catch { /* fonts API unavailable */ }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    });
    const loading = images.pending() > 0 || await page.evaluate(imagesLoadingInPage);
    if (!loading || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** What `--selector` matched, measured as it is. */
async function locateSelector(page: Page, selector: string): Promise<Located | { error: string }> {
  const target = await page.$(selector);
  if (!target) return { error: `element vanished after load: ${selector}` };
  const element = describeElement(await target.evaluate((el) => ({
    tag: el.tagName.toLowerCase(), slot: el.getAttribute("data-slot"), role: el.getAttribute("role"),
  })));
  return { target, element, notes: [], matchedSelector: selector };
}

interface Located {
  target: ElementHandle<Element>;
  element: string;
  notes: MeasurementNote[];
  matchedSelector: string | null;
  /** Content in a portal outside the story's root. */
  portal?: true;
}

/**
 * The element chooseMeasuredElement picks, from what the page shows of the
 * story's root and of any portal outside it.
 */
async function locateComponent(page: Page, slots: readonly string[]): Promise<Located | { error: string }> {
  // The root holding the story, or failing that the first that exists.
  let container: ElementHandle<Element> | null = null;
  let containerSelector: string | null = null;
  for (const candidate of ROOT_CONTAINERS) {
    const found = await page.$(candidate);
    if (!found) continue;
    const holdsStory = await found.evaluate(
      (el, tags) => Array.from(el.children).some((child) => !tags.includes(child.tagName.toLowerCase())),
      [...NON_RENDERED_TAGS],
    );
    if (!container || holdsStory) {
      container = found;
      containerSelector = candidate;
    }
    if (holdsStory) break;
  }

  const tree = container
    ? await container.evaluate(readStoryTreeInPage, { props: WRAPPER_PROPERTIES, ...TREE_LIMITS })
    : null;
  const portalsHandle = await page.evaluateHandle(findPortalsInPage, { container, slots: [...new Set([...slots, ...contentSlots(slots)])], overlay: OVERLAY_SELECTOR });
  try {
    const portals: PortalNode[] = await portalsHandle.evaluate((elements, overlay) => elements.map((el) => ({
      tag: el.tagName.toLowerCase(),
      slot: el.getAttribute("data-slot"),
      role: el.getAttribute("role"),
      id: el.id || null,
      rendered: el.getClientRects().length > 0,
      // The content, not something in it matching too: Radix's tooltip holds a hidden copy of its text as role=tooltip.
      overlay: el.matches(overlay) && !el.parentElement?.closest(overlay),
    })), OVERLAY_SELECTOR);
    const choice = chooseMeasuredElement(tree, portals, slots);
    if (choice.kind === "none") return { error: choice.error };

    const handle = choice.kind === "tree" && container
      ? await container.evaluateHandle((el, path) => path.reduce<Element>((node, index) => node.children[index], el), choice.path)
      : await portalsHandle.evaluateHandle((elements, index) => elements[index], choice.kind === "portal" ? choice.index : -1);
    const target = handle.asElement();
    if (!target) {
      await handle.dispose();
      return { error: `element vanished after load: ${choice.element}` };
    }
    return {
      target,
      element: choice.element,
      notes: choice.notes,
      matchedSelector: choice.kind === "portal" ? `portal ${choice.element}` : containerSelector,
      ...(choice.kind === "portal" ? { portal: true as const } : {}),
    };
  } finally {
    await portalsHandle.dispose();
  }
}

/**
 * Runs in the page: the story's container and everything under it, as
 * StoryNodes, cut short past `maxDepth` levels or `maxNodes` elements.
 */
export function readStoryTreeInPage(
  container: Element,
  args: { props: readonly string[]; maxDepth: number; maxNodes: number },
): StoryNode {
  let budget = args.maxNodes;
  const read = (el: Element, depth: number): StoryNode => {
    budget--;
    const cs = getComputedStyle(el);
    const styles: Record<string, string> = {};
    for (const p of args.props) styles[p] = cs.getPropertyValue(p);
    const node: StoryNode = {
      tag: el.tagName.toLowerCase(),
      slot: el.getAttribute("data-slot"),
      role: el.getAttribute("role"),
      hasPopup: el.getAttribute("aria-haspopup"),
      expanded: el.getAttribute("aria-expanded"),
      controls: el.getAttribute("aria-controls"),
      state: el.getAttribute("data-state"),
      open: el.hasAttribute("data-popup-open") || el.hasAttribute("data-open"),
      dir: el.getAttribute("dir"),
      orientation: el.getAttribute("data-orientation") ?? el.getAttribute("aria-orientation"),
      label: el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby"),
      position: cs.position,
      rendered: el.getClientRects().length > 0,
      text: Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== ""),
      styles,
      children: [],
    };
    // An icon font's glyph, or a dot, drawn by a pseudo-element alone.
    const pseudos: NonNullable<StoryNode["pseudos"]> = [];
    for (const which of ["::before", "::after"]) {
      const ps = getComputedStyle(el, which);
      const content = ps.getPropertyValue("content");
      if (content === "none" || content === "normal" || content === "") continue;
      const own: Record<string, string> = {};
      for (const p of args.props) own[p] = ps.getPropertyValue(p);
      pseudos.push({ content, styles: own });
    }
    if (pseudos.length) node.pseudos = pseudos;
    if (depth < args.maxDepth) {
      for (const child of Array.from(el.children)) {
        if (budget <= 0) break;
        node.children.push(read(child, depth + 1));
      }
    }
    return node;
  };
  return read(container, 0);
}

/**
 * Runs in the page: elements outside the story's container that may be its
 * content in a portal, in document order. One carrying one of `slots`, the
 * component's own and its content's, one an element in the container names
 * in `aria-controls`, or an open overlay's content, as `overlay`
 * (OVERLAY_SELECTOR) finds it. Storybook's own error and loading screens
 * are left out.
 */
function findPortalsInPage(args: { container: Element | null; slots: string[]; overlay: string }): Element[] {
  const wanted = new Set(args.slots);
  const controlled = new Set<string>();
  for (const el of Array.from(args.container?.querySelectorAll("[aria-controls]") ?? [])) {
    for (const id of (el.getAttribute("aria-controls") ?? "").split(/\s+/)) if (id) controlled.add(id);
  }
  const storybook = "#storybook-docs, .sb-errordisplay, .sb-nopreview, .sb-preparing-story, .sb-preparing-docs";
  return Array.from(document.body.querySelectorAll(`[data-slot], [id], ${args.overlay}`)).filter((el) =>
    !(args.container?.contains(el) ?? false) &&
    !el.closest(storybook) &&
    (wanted.has(el.getAttribute("data-slot") ?? "") || controlled.has(el.id) || el.matches(args.overlay)));
}

/**
 * Reads the computed styles, with any corner radius that only layout can
 * resolve resolved to px.
 *
 * Chromium computes `border-radius: calc(50% - 2px)` or `min(8px, 10%)` to
 * itself, since the percentage depends on the box. Plain px and plain
 * percentages are left for snap-normalize to read; anything else is sized
 * here on a hidden probe whose containing block is the element's border box,
 * so its percentages resolve as the radius's do, and comes back as
 * `"<h>px <v>px"`, to layout's precision of 1/64px.
 */
async function readComputedStyles(
  page: Page,
  handle: ElementHandle<Element>,
  properties: readonly string[],
): Promise<RawComputedStyles> {
  return page.evaluate(
    ([node, props]) => {
      const cs = getComputedStyle(node as Element);
      const out: Record<string, string> = {};
      for (const p of props as string[]) out[p] = cs.getPropertyValue(p);

      const plain = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|%)$/i;
      for (const p of Object.keys(out).filter((key) => key.endsWith("-radius"))) {
        // Split on top-level spaces: an elliptical corner is two values.
        const parts: string[] = [];
        let depth = 0;
        let current = "";
        for (const ch of out[p].trim()) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (/\s/.test(ch) && depth === 0) {
            if (current) parts.push(current);
            current = "";
          } else {
            current += ch;
          }
        }
        if (current) parts.push(current);
        if (!parts.length || parts.every((t) => plain.test(t))) continue;

        const rect = (node as Element).getBoundingClientRect();
        const host = document.createElement("div");
        const probe = document.createElement("div");
        const pin = (el: HTMLElement, styles: Record<string, string>) => {
          for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, "important");
        };
        const bare = {
          position: "absolute", left: "0", top: "0", margin: "0", padding: "0", border: "0",
          "box-sizing": "content-box", "min-width": "0", "min-height": "0",
          "max-width": "none", "max-height": "none", visibility: "hidden",
        };
        pin(host, { ...bare, width: `${rect.width}px`, height: `${rect.height}px` });
        pin(probe, { ...bare, width: parts[0], height: parts[1] ?? parts[0] });
        // A value width or height won't take leaves the radius as it was.
        if (!probe.style.getPropertyValue("width") || !probe.style.getPropertyValue("height")) continue;
        host.appendChild(probe);
        document.body.appendChild(host);
        const size = probe.getBoundingClientRect();
        host.remove();
        out[p] = `${size.width}px ${size.height}px`;
      }
      return out;
    },
    [handle, properties] as const,
  );
}


/**
 * A checksum of the story's markup: its root container's, and that of what
 * it renders into the body beside it, as a portal does, leaving out
 * Storybook's own nodes, scripts and styles. Null when it can't be read.
 *
 * Every variant of a component can measure the same for two reasons a
 * score can't tell apart: the story drops its args, so nothing they set
 * reaches the page, or they reach the component and change only what snap
 * doesn't measure, as input-otp's `textAlign` sets the alignment of an
 * input that draws no text. The markup tells them apart: a dropped arg
 * changes none of it.
 */
async function readMarkup(page: Page): Promise<string | null> {
  return page.evaluate((containers) => {
    const root = containers.map((selector) => document.querySelector(selector)).find((el) => el != null) ?? null;
    const parts = [root ? root.outerHTML : ""];
    for (const el of Array.from(document.body.children)) {
      if (el === root || el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") continue;
      if (/^storybook-/.test(el.id) || /(?:^|\s)sb-/.test(el.getAttribute("class") ?? "")) continue;
      parts.push(el.outerHTML);
    }
    const text = parts.join("\n");
    // 32-bit FNV-1a, with the length: a checksum to compare, not to keep.
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return `${hash.toString(16).padStart(8, "0")}:${text.length}`;
  }, [...ROOT_CONTAINERS]).catch(() => null);
}

/**
 * The nearest element at or under `root` holding text the browser shows, or
 * null when there is none.
 *
 * Text that is in the page but not drawn is passed over, with everything
 * under it: an element not displayed, text whose `visibility` hides it, and
 * an element cut down to a pixel or less that clips what it holds, as
 * Tailwind's `sr-only` does (1px, `overflow: hidden`) and as Base UI's
 * Progress hides a span. Measured, an icon button's `sr-only` label gave
 * the button a text it doesn't show, and the hidden span gave Progress a
 * text cut off at 1px, which the push would build as a 1px label.
 */
async function findTextHolder(root: ElementHandle<Element>): Promise<ElementHandle<Element> | null> {
  const handle = await root.evaluateHandle((node) => {
    const hidden = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      if (cs.display === "none") return true;
      // display: contents draws no box of its own, its children do.
      if (cs.display === "contents") return false;
      const box = el.getBoundingClientRect();
      const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible"
        || (cs.clip !== "" && cs.clip !== "auto") || (cs.clipPath !== "" && cs.clipPath !== "none");
      return box.width <= 1 && box.height <= 1 && clips;
    };
    const find = (el: Element): Element | null => {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() && getComputedStyle(el).visibility === "visible") return el;
        if (child.nodeType === Node.ELEMENT_NODE && !hidden(child as Element)) {
          const found = find(child as Element);
          if (found) return found;
        }
      }
      return null;
    };
    return find(node);
  });
  const holder = handle.asElement();
  if (!holder) await handle.dispose();
  return holder;
}

/**
 * How the text fits the block that lays it out, for normalizeTextLayout:
 * that block is the holder, or its nearest ancestor up to the measured root
 * that isn't `display: inline`, since an inline element wraps at its
 * container's width and has none of its own to clip at. The lines are
 * counted from the holder's own text, its rects grouped by height, so a
 * line cut off with an ellipsis is one, as is a nested label's line.
 */
async function readTextLayout(holder: ElementHandle<Element>, root: ElementHandle<Element>): Promise<RawTextLayout | null> {
  return holder.evaluate((text, node) => {
    let block = text as HTMLElement;
    while (block !== node && block.parentElement && getComputedStyle(block).display === "inline") block = block.parentElement;
    const cs = getComputedStyle(block);
    const px = (value: string) => parseFloat(value) || 0;
    const width = block.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
    const rects: DOMRect[] = [];
    for (const child of Array.from(text.childNodes)) {
      if (child.nodeType !== Node.TEXT_NODE || !(child.textContent ?? "").trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      rects.push(...Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0));
    }
    rects.sort((a, b) => a.top - b.top);
    let lines = 0;
    let bottom = -Infinity;
    for (const rect of rects) {
      if ((rect.top + rect.bottom) / 2 > bottom) {
        lines++;
        bottom = rect.bottom;
      } else {
        bottom = Math.max(bottom, rect.bottom);
      }
    }
    const clamp = parseInt(cs.getPropertyValue("-webkit-line-clamp") || cs.getPropertyValue("line-clamp"), 10);
    return {
      width,
      lines,
      overflowsX: cs.overflowX !== "visible" && block.scrollWidth > block.clientWidth + 0.5,
      overflowsY: cs.overflowY !== "visible" && block.scrollHeight > block.clientHeight + 0.5,
      textOverflow: cs.textOverflow,
      lineClamp: Number.isFinite(clamp) && clamp > 0 ? clamp : null,
    };
  }, root).catch(() => null);
}

/**
 * Styles of the element holding the text, with `opacity` the product of
 * every opacity from it up to the measured root, the root's excluded:
 * `<button><span style="opacity: 0.6">` draws its label at 60%.
 */
async function readTextStyles(
  page: Page,
  holder: ElementHandle<Element>,
  root: ElementHandle<Element>,
  properties: readonly string[],
): Promise<RawComputedStyles> {
  return page.evaluate(
    ([text, node, props]) => {
      const cs = getComputedStyle(text as Element);
      const out: Record<string, string> = {};
      for (const p of props as string[]) out[p] = cs.getPropertyValue(p);
      let opacity = 1;
      for (let el: Element | null = text as Element; el && el !== node; el = el.parentElement) {
        const own = parseFloat(getComputedStyle(el).opacity);
        if (Number.isFinite(own)) opacity *= own;
      }
      out["opacity"] = String(opacity);
      return out;
    },
    [holder, root, properties] as const,
  );
}

/**
 * Which families of an element's font stack the browser draws with.
 *
 * `getComputedStyle` reports the stack as authored, not what the browser
 * resolved it to, so a project naming a font it never loaded measures
 * identically to one that loaded it, and would score full marks against
 * Figma while the screenshots showed a different typeface. resolveFontFamily
 * reads the result.
 *
 * Two signals, because neither is sufficient alone:
 *
 *   - `document.fonts.check` returns *true* for any family not declared via
 *     `@font-face`, including names that categorically do not exist. It is
 *     only meaningful when it returns false, which happens for a declared
 *     webfont whose file failed to load, the one case the canvas probe
 *     cannot see.
 *   - A canvas width probe renders a string as `X, monospace` and again as
 *     `monospace`. Identical advance widths mean X never applied. This is
 *     what catches a missing system font, and a keyword the browser doesn't
 *     implement: Chrome draws `-apple-system, monospace` exactly as
 *     `monospace`.
 *
 * Each family is probed as it is written: quoted, `"system-ui"`, it is a
 * family name, which Chrome gives to `BlinkMacSystemFont`, and unquoted a
 * keyword. Two fallbacks are probed because a family whose metrics happen
 * to coincide with one base would be misread as absent. A generic family is
 * not probed: it always resolves to some face.
 */
async function probeFontStack(handle: ElementHandle<Element>): Promise<FontProbe | null> {
  return handle.evaluate((node) => {
    try {
      const cs = getComputedStyle(node);
      // Split on the commas between families, not those inside quotes.
      const written: string[] = [];
      let current = "";
      let quote: string | null = null;
      for (const ch of cs.fontFamily || "") {
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ",") {
          if (current.trim()) written.push(current.trim());
          current = "";
          continue;
        }
        current += ch;
      }
      if (current.trim()) written.push(current.trim());
      if (!written.length) return null;

      const families = written.map((family) => family.replace(/^(['"])(.*)\1$/, "$2"));
      const GENERIC = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "math", "emoji", "fangsong"];
      const size = cs.fontSize || "16px";
      const weight = cs.fontWeight || "400";

      const ctx = document.createElement("canvas").getContext("2d");
      const PROBE = "mmmmmmmmmmlliWWQQ@#%&08";
      const widthWith = (stack: string) => {
        ctx!.font = `${weight} 72px ${stack}`;
        return ctx!.measureText(PROBE).width;
      };
      const bases = ["monospace", "serif"];
      const baseWidths = ctx ? bases.map(widthWith) : [];

      const applied = written.map((family, index) => {
        if (family === families[index] && GENERIC.includes(family.toLowerCase())) return null;
        // A declared webfont that failed to load is definitively unavailable.
        try {
          if (document.fonts.check(`${weight} ${size} ${family}`) === false) return false;
        } catch {
          // Not a font the shorthand can parse; the canvas can still tell.
        }
        if (!ctx) return null;
        // Applied if it changes the advance width against *either* base.
        return bases.some((base, b) => widthWith(`${family}, ${base}`) !== baseWidths[b]);
      });
      return { families, applied };
    } catch {
      return null;
    }
  });
}

// --- Args -----------------------------------------------------------------
//
// Whether Storybook gave the story the args its URL asked for, and applying
// through its preview any it didn't: see snap-args.ts for why. Storybook's
// preview is read as `window.__STORYBOOK_PREVIEW__`, there from Storybook 7,
// and written to through its channel's `updateStoryArgs` and `forceRemount`
// events, which its Controls panel and toolbar send.

/** The longest the check waits for Storybook's preview to hold the story's render. */
const ARGS_WAIT_MS = 5000;

/** Storybook's preview, as much of it as snap reads. */
interface PreviewInPage {
  storyRenders?: ({ id?: string; phase?: string; story?: StoryInPage } | undefined)[];
  storyStoreValue?: {
    args: { get(storyId: string): Record<string, unknown> };
    getStoryContext(story: StoryInPage): {
      args?: Record<string, unknown>;
      unmappedArgs?: Record<string, unknown>;
      argsByTarget?: Record<string, Record<string, unknown> | undefined>;
      globals?: Record<string, unknown>;
    };
  };
  channel?: {
    on(event: string, listener: (payload: unknown) => void): void;
    off?(event: string, listener: (payload: unknown) => void): void;
    removeListener?(event: string, listener: (payload: unknown) => void): void;
    emit(event: string, payload: unknown): void;
  };
}

interface StoryInPage {
  argTypes?: Record<string, ArgTypeInPage | undefined>;
  parameters?: { fileName?: unknown };
  /** The story's own args, before the URL's. */
  initialArgs?: Record<string, unknown>;
}

interface ArgTypeInPage {
  type?: string | { name?: string };
  control?: string | false | { type?: string; disable?: boolean };
  options?: unknown;
  if?: unknown;
  mapping?: unknown;
  table?: { disable?: unknown; category?: unknown };
  action?: unknown;
}

/**
 * Runs in the page: what Storybook's preview holds for the story, as
 * snap-args.ts reads it, once it holds a render of it, waiting up to
 * `waitMs` for one. `{ error }` when there is no preview to read.
 */
export async function storyArgsInPage(args: { storyId: string; waitMs: number }): Promise<StoryArgsSnapshot | { error: string }> {
  try {
    const preview = (window as unknown as { __STORYBOOK_PREVIEW__?: PreviewInPage }).__STORYBOOK_PREVIEW__;
    if (!preview) return { error: "the page has no window.__STORYBOOK_PREVIEW__" };
    const deadline = Date.now() + args.waitMs;
    let story: StoryInPage | undefined;
    for (;;) {
      story = preview.storyRenders?.find((r) => r?.id === args.storyId && r.story)?.story;
      if (story || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const store = preview.storyStoreValue;
    if (!story || !store) return { error: `Storybook's preview holds no render of ${args.storyId}` };

    // What crosses back to Node: a value that isn't a string, number,
    // boolean or null is recorded by its type.
    const plain = (value: unknown): unknown =>
      value === null || ["string", "number", "boolean"].includes(typeof value) ? value : { $type: typeof value };
    const record = (from: Record<string, unknown> | undefined): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(from ?? {})) if (value !== undefined) out[name] = plain(value);
      return out;
    };

    const argTypes: Record<string, StoryArgType> = {};
    const mappings: Record<string, Record<string, unknown>> = {};
    for (const [name, t] of Object.entries(story.argTypes ?? {})) {
      if (!t) continue;
      if (t.mapping && typeof t.mapping === "object") {
        mappings[name] = {};
        for (const [key, value] of Object.entries(t.mapping)) mappings[name][key] = plain(value);
      }
      const control = t.control === false || (typeof t.control === "object" && t.control?.disable)
        ? false
        : typeof t.control === "string" ? t.control : t.control?.type;
      let condition: Record<string, unknown> | undefined;
      try {
        condition = t.if && typeof t.if === "object" ? JSON.parse(JSON.stringify(t.if)) : undefined;
      } catch {
        condition = undefined;
      }
      argTypes[name] = {
        type: typeof t.type === "string" ? t.type : t.type?.name,
        control,
        options: Array.isArray(t.options) ? t.options.map(plain) : undefined,
        if: condition,
        mapping: t.mapping ? true : undefined,
        hidden: t.table?.disable === true ? true : undefined,
        category: typeof t.table?.category === "string" ? t.table.category : undefined,
        action: t.action ? true : undefined,
        initial: story.initialArgs && Object.hasOwn(story.initialArgs, name) && (story.initialArgs[name] === null || ["string", "number", "boolean"].includes(typeof story.initialArgs[name]))
          ? story.initialArgs[name] as string | number | boolean | null
          : undefined,
      };
    }

    // The args the story is given: those left after argTypes `if`
    // conditions, and any aimed at another target, which skip them, each by
    // its value before a `mapping`.
    const context = store.getStoryContext(story);
    const values = context.unmappedArgs ?? context.args ?? {};
    const given = new Set(Object.keys(context.args ?? {}));
    for (const [target, group] of Object.entries(context.argsByTarget ?? {})) {
      if (target !== "UNTARGETED") for (const name of Object.keys(group ?? {})) given.add(name);
    }
    const rendered: Record<string, unknown> = {};
    for (const name of given) if (values[name] !== undefined) rendered[name] = plain(values[name]);

    let stored: Record<string, unknown> = {};
    try {
      stored = record(store.args.get(args.storyId));
    } catch {
      // No args recorded for it: everything the store would hold is in `rendered`.
    }
    const fileName = story.parameters?.fileName;
    return {
      fileName: typeof fileName === "string" ? fileName : null, argTypes, stored, rendered, globals: record(context.globals),
      ...(Object.keys(mappings).length ? { mappings } : {}),
    };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err).split("\n")[0] };
  }
}

/**
 * Runs in the page: gives the story `updates` through Storybook's channel,
 * as its Controls panel does, after lifting the argTypes `if` of each arg in
 * `lift`, then remounts it, so it renders from scratch with them as from
 * its URL. Waits for the render in progress to finish first: Storybook
 * queues a rerender asked for during one, and reloads the page for a
 * remount. `{ error }` when it can't, or Storybook doesn't confirm it.
 */
export async function applyStoryArgsInPage(args: {
  storyId: string;
  updates: Record<string, unknown>;
  lift: string[];
  waitMs: number;
}): Promise<{ ok: true } | { error: string }> {
  try {
    const preview = (window as unknown as { __STORYBOOK_PREVIEW__?: PreviewInPage }).__STORYBOOK_PREVIEW__;
    const channel = preview?.channel;
    const render = preview?.storyRenders?.find((r) => r?.id === args.storyId && r.story);
    if (!channel || !render?.story) return { error: `Storybook's preview has no channel or no render of ${args.storyId}` };
    const deadline = Date.now() + args.waitMs;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Storybook 8 and later end a render at "finished"; 7 at "completed",
    // or "played" after a play function.
    const settled = async (): Promise<boolean> => {
      let last = render.phase;
      let since = Date.now();
      while (Date.now() < deadline) {
        const phase = render.phase;
        if (phase !== last) {
          last = phase;
          since = Date.now();
        }
        if (phase === "finished" || phase === "errored" || phase === "aborted") return true;
        if ((phase === "completed" || phase === "played") && Date.now() - since >= 300) return true;
        await sleep(20);
      }
      return false;
    };
    // The first of `wanted`'s events whose payload matches, or false at the deadline.
    const once = (wanted: Record<string, (payload: unknown) => boolean>) => new Promise<boolean>((resolve) => {
      const listeners = Object.entries(wanted).map(([event, matches]) => [event, (payload: unknown) => {
        if (matches(payload)) done(true);
      }] as const);
      const done = (value: boolean) => {
        clearTimeout(timer);
        for (const [event, listener] of listeners) (channel.off ?? channel.removeListener)?.call(channel, event, listener);
        resolve(value);
      };
      const timer = setTimeout(() => done(false), Math.max(0, deadline - Date.now()));
      for (const [event, listener] of listeners) channel.on(event, listener);
    });
    const forStory = (payload: unknown) =>
      payload === args.storyId || (typeof payload === "object" && payload !== null && (payload as { storyId?: unknown }).storyId === args.storyId);
    const any = () => true;

    if (!(await settled())) return { error: "the story was still rendering" };
    const argTypes = render.story.argTypes ?? {};
    for (const name of args.lift) {
      const argType = argTypes[name];
      if (argType?.if) argTypes[name] = { ...argType, if: undefined };
      if (argTypes[name]?.if) return { error: `argTypes.${name}.if couldn't be lifted` };
    }
    const updated = once({ storyArgsUpdated: forStory });
    channel.emit("updateStoryArgs", { storyId: args.storyId, updatedArgs: args.updates });
    if (!(await updated)) return { error: "Storybook didn't confirm the args" };
    // Rendered, or threw: a story that can't render the values never says
    // storyRendered, but shows Storybook's error display, which the capture
    // reads next, so it is a render error rather than a refusal.
    const rendered = once({ storyRendered: forStory, storyThrewException: any, storyErrored: any });
    channel.emit("forceRemount", { storyId: args.storyId });
    if (!(await rendered)) return { error: "the story didn't render again with them" };
    if (!(await settled())) return { error: "the story was still rendering with them" };
    return { ok: true };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err).split("\n")[0] };
  }
}

/** A page's console warnings that Storybook rejected an arg value, from now until stop(). */
interface ArgWarnings {
  texts: string[];
  stop(): void;
}

function watchArgWarnings(page: Page): ArgWarnings {
  const texts: string[] = [];
  const listener = (message: ConsoleMessage) => {
    const text = message.text();
    if (text.includes("Received illegal value for")) texts.push(text);
  };
  page.on("console", listener);
  return { texts, stop: () => page.off("console", listener) };
}

/**
 * Runs in the page: each story's own annotations, from the CSF file
 * Storybook's preview loaded it from (`loadCSFFileByStoryId`, there from
 * Storybook 7): its own args, not its component's, and whether it has a
 * render (or, a CSF2 story, is a function itself), decorators or a play
 * function of its own, for snap to choose
 * which story measures each variant (snap-stories.ts). `{ error }` when the
 * preview can't give them.
 */
export async function storiesOwnInPage(args: { storyIds: string[] }): Promise<StoryOwn[] | { error: string }> {
  type Csf = { stories?: Record<string, { args?: Record<string, unknown>; render?: unknown; userStoryFn?: unknown; decorators?: unknown; play?: unknown } | undefined> };
  try {
    const preview = (window as unknown as { __STORYBOOK_PREVIEW__?: { storyStoreValue?: { loadCSFFileByStoryId?: (id: string) => Promise<Csf> } } }).__STORYBOOK_PREVIEW__;
    const store = preview?.storyStoreValue;
    if (typeof store?.loadCSFFileByStoryId !== "function") return { error: "Storybook's preview can't load a story's file (loadCSFFileByStoryId)" };
    const plain = (value: unknown): unknown =>
      value === null || ["string", "number", "boolean"].includes(typeof value) ? value : { $type: typeof value };
    const out: StoryOwn[] = [];
    for (const id of args.storyIds) {
      const story = (await store.loadCSFFileByStoryId(id)).stories?.[id];
      if (!story) return { error: `Storybook's preview has no story ${id} in its file` };
      const own: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(story.args ?? {})) if (value !== undefined) own[name] = plain(value);
      out.push({
        id, args: own,
        // A CSF2 story, a function, is kept as its userStoryFn, which Storybook renders in place of any render.
        ...(typeof story.render === "function" || typeof story.userStoryFn === "function" ? { render: true as const } : {}),
        ...(Array.isArray(story.decorators) && story.decorators.length ? { decorators: true as const } : {}),
        ...(typeof story.play === "function" ? { play: true as const } : {}),
      });
    }
    return out;
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err).split("\n")[0] };
  }
}

/**
 * The component's stories' own annotations, read in `page`, which must
 * hold Storybook's preview, as it does once a story has loaded; null, with
 * why, when they can't be read, and snap measures every variant from the
 * component's story as before.
 */
export async function readStoriesOwn(page: Page, storyIds: readonly string[]): Promise<{ stories: StoryOwn[] } | { error: string }> {
  let read: unknown;
  try {
    read = await page.evaluate(storiesOwnInPage, { storyIds: [...storyIds] });
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err).split("\n")[0] };
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isRecord(read) && typeof read.error === "string") return { error: read.error };
  if (!Array.isArray(read) || read.length !== storyIds.length || !read.every((s, i) => isRecord(s) && s.id === storyIds[i] && isRecord(s.args))) {
    return { error: "Storybook's preview returned nothing snap can read" };
  }
  return { stories: read as StoryOwn[] };
}

/** A value read from the page, as a snapshot, or why it isn't one. */
function asSnapshot(value: unknown): StoryArgsSnapshot | { error: string } {
  const read = value as Partial<StoryArgsSnapshot & { error: unknown }> | null;
  if (typeof read?.error === "string") return { error: read.error };
  const isRecord = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isRecord(read?.argTypes) || !isRecord(read?.stored) || !isRecord(read?.rendered)) {
    return { error: "Storybook's preview returned nothing snap can read" };
  }
  return {
    fileName: typeof read!.fileName === "string" ? read!.fileName : null,
    argTypes: read!.argTypes!,
    stored: read!.stored!,
    rendered: read!.rendered!,
    globals: isRecord(read!.globals) ? read!.globals! : {},
    ...(isRecord(read!.mappings) ? { mappings: read!.mappings! } : {}),
  };
}

/**
 * Which of the story's requested args Storybook gave it, and, for any it
 * didn't, the result of applying them through its preview.
 */
export async function checkStoryArgs(
  page: Page,
  story: NonNullable<CaptureOptions["story"]>,
  timeoutMs: number,
  warnings: readonly string[],
  apply = true,
): Promise<StoryArgsCheck> {
  const read = async () => asSnapshot(await page.evaluate(storyArgsInPage, { storyId: story.id, waitMs: Math.min(timeoutMs, ARGS_WAIT_MS) }));
  const notInUrl = story.notInUrl ?? [];
  const first = await read();
  if ("error" in first) {
    // A value left out of the URL wasn't given. Storybook's console warning
    // still names one outside the options.
    const rejected: ArgRejection[] = [
      ...notInUrl.map((name): ArgRejection => ({ name, value: story.args[name], reasons: ["url-unsafe"] })),
      ...rejectionsFromWarnings(story.args, warnings).filter((r) => !notInUrl.includes(r.name)),
    ];
    return { checked: false, rejected, unapplied: rejected, error: first.error };
  }

  const known = { argTypes: compactArgTypes(first.argTypes), ...(first.fileName ? { storyFile: first.fileName } : {}) };
  const rejected = findRejectedArgs(story.args, first, story.properties, notInUrl);
  if (!rejected.length) return { checked: true, rejected, unapplied: [], ...known };
  if (!apply) return { checked: true, rejected, unapplied: rejected, error: "snap was told not to set values through it (--no-channel-args)", ...known };

  const { updates, lift } = previewArgUpdate(rejected, first, story.properties);
  let applied: { ok: true } | { error: string };
  try {
    applied = await page.evaluate(applyStoryArgsInPage, { storyId: story.id, updates, lift, waitMs: timeoutMs });
  } catch (err) {
    // The page went, as a remount Storybook can't do in place reloads it.
    applied = { error: firstLine(err) };
  }
  if ("error" in applied) return { checked: true, rejected, unapplied: rejected, error: applied.error, ...known };

  const after = await read();
  if ("error" in after) return { checked: true, rejected, unapplied: rejected, error: after.error, ...known };
  const unapplied = stillRejected(story.args, rejected, after);
  if (unapplied.length) {
    return { checked: true, rejected, unapplied, error: "the story still wasn't given them after Storybook's preview took them", ...known };
  }
  return { checked: true, rejected, unapplied: [], appliedVia: "preview", ...known };
}

/** The capture's error for values the story wasn't given. */
function describeUnapplied(check: StoryArgsCheck): string {
  const values = check.unapplied.map((r) => `${r.name}=${r.value} (${r.reasons.join(", ")})`).join(", ");
  const why = check.error ? `; through Storybook's preview, ${check.error}` : "";
  return `Storybook didn't give the story ${values}${why}, so this variant was not measured`;
}

// --- Element tree -------------------------------------------------------------
//
// Everything under the measured root that draws, read in one page.evaluate
// as raw computed values; snap-tree.ts decides what the tree keeps. Images
// are fetched and screenshots taken here, after it has.

/** What captureTreeInPage is told, from snap-tree.ts and snap-assets.ts, as a page function can import nothing. */
interface TreeInPageArgs {
  mode: "tree" | "count";
  defaults: Record<string, string>;
  textProperties: readonly string[];
  maxElements: number;
  maxDepth: number;
  maxSvgElements: number;
  svgShapes: readonly string[];
  svgGeometry: readonly string[];
  svgPaint: readonly string[];
  svgGroup: readonly string[];
  svgDropped: readonly string[];
  nonRendered: readonly string[];
}

/**
 * Runs in the page: the subtree of `root`, as snap-tree.ts reads it. Boxes
 * are relative to the root's border box, unrounded. Elements not displayed,
 * at opacity 0, and the inside of an `<svg>`, `<img>` or form control are not
 * walked; `display: contents` is, its children taken as its parent's. In
 * `count` mode, for `--root-only`, nothing is measured that would take more
 * than reading: no pseudo-element stand-ins, SVG markup or font probes.
 *
 * A pseudo-element that may paint and sits in the flow is measured on a
 * stand-in span carrying its computed style, the real one hidden by a rule
 * on a temporary attribute meanwhile; both are gone before this returns, so
 * the markup snap compares across variants is as it was.
 */
export function captureTreeInPage(root: Element, args: TreeInPageArgs): RawTreeCapture {
  const R = root.getBoundingClientRect();
  const rel = (r: DOMRect): RawBox => [r.left - R.left, r.top - R.top, r.width, r.height];
  const properties = Object.keys(args.defaults);
  const nonRendered = new Set(args.nonRendered);
  const fonts: Record<string, FontProbe | null> = {};
  const tree = args.mode === "tree";
  let read = 0;
  let hider: HTMLStyleElement | null = null;
  const HIDE = "data-storysync-pseudo";

  // A color drawn at alpha 0, in any space Chromium writes one in.
  // rgba() with alpha 0, or the slash syntax's `/ 0`: not rgb(r, g, 0), which is opaque.
  const clear = (c: string) => !c || c === "transparent" || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(c) || /\/\s*0(?:\.0+)?\s*\)$/.test(c);
  const evidence = /(?:^|[:!])(?:bg|text|border|ring|fill|stroke|outline|rounded|shadow)-/;

  // Radii only layout can resolve, calc() of a percentage, sized on a probe
  // the element's size, as readComputedStyles sizes the root's.
  const plain = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|%)$/i;
  const resolveRadius = (value: string, rect: DOMRect): string => {
    const parts = value.trim().split(/\s+(?![^(]*\))/);
    if (!parts.length || parts.every((t) => plain.test(t))) return value;
    const host = document.createElement("div");
    const probe = document.createElement("div");
    const pin = (el: HTMLElement, styles: Record<string, string>) => {
      for (const [name, v] of Object.entries(styles)) el.style.setProperty(name, v, "important");
    };
    const bare = {
      position: "absolute", left: "0", top: "0", margin: "0", padding: "0", border: "0", "box-sizing": "content-box",
      "min-width": "0", "min-height": "0", "max-width": "none", "max-height": "none", visibility: "hidden",
    };
    pin(host, { ...bare, width: `${rect.width}px`, height: `${rect.height}px` });
    pin(probe, { ...bare, width: parts[0], height: parts[1] ?? parts[0] });
    if (!probe.style.getPropertyValue("width") || !probe.style.getPropertyValue("height")) return value;
    host.appendChild(probe);
    document.body.appendChild(host);
    const size = probe.getBoundingClientRect();
    host.remove();
    return `${size.width}px ${size.height}px`;
  };

  // Properties that say nothing about an element unless another says so:
  // a side's style and color without its width, an outline's width without
  // its style, a background's layout without a picture, an object's fit
  // anywhere but an image, a control's appearance anywhere but an input or
  // a select.
  const readCss = (cs: CSSStyleDeclaration, rect: DOMRect | null, tag = ""): Record<string, string> => {
    const out: Record<string, string> = {};
    const outline = cs.getPropertyValue("outline-style") !== "none";
    const picture = /url\(/.test(cs.getPropertyValue("background-image"));
    for (const p of properties) {
      const side = /^border-(top|right|bottom|left)-(?:style|color)$/.exec(p);
      if (side && cs.getPropertyValue(`border-${side[1]}-width`) === "0px") continue;
      if (p.startsWith("outline-") && p !== "outline-style" && !outline) continue;
      if (/^background-(size|position|repeat)$/.test(p) && !picture) continue;
      if (p.startsWith("object-") && tag !== "img") continue;
      if (p === "appearance" && tag !== "input" && tag !== "select") continue;
      let v = cs.getPropertyValue(p);
      if (rect && p.endsWith("-radius") && v !== args.defaults[p]) v = resolveRadius(v, rect);
      if (v !== args.defaults[p]) out[p] = v;
    }
    return out;
  };
  const readText = (cs: CSSStyleDeclaration): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of args.textProperties) out[p] = cs.getPropertyValue(p);
    if (tree && !(out["font-family"] in fonts)) fonts[out["font-family"]] = probeFonts(cs);
    return out;
  };

  // Which families of a stack the browser draws with: probeFontStack's
  // reading, once per stack.
  const probeFonts = (cs: CSSStyleDeclaration): FontProbe | null => {
    try {
      const written: string[] = [];
      let current = "";
      let quote: string | null = null;
      for (const ch of cs.fontFamily || "") {
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ",") {
          if (current.trim()) written.push(current.trim());
          current = "";
          continue;
        }
        current += ch;
      }
      if (current.trim()) written.push(current.trim());
      if (!written.length) return null;
      const families = written.map((family) => family.replace(/^(['"])(.*)\1$/, "$2"));
      const GENERIC = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "math", "emoji", "fangsong"];
      const size = cs.fontSize || "16px";
      const weight = cs.fontWeight || "400";
      const ctx = document.createElement("canvas").getContext("2d");
      const PROBE = "mmmmmmmmmmlliWWQQ@#%&08";
      const widthWith = (stack: string) => {
        ctx!.font = `${weight} 72px ${stack}`;
        return ctx!.measureText(PROBE).width;
      };
      const bases = ["monospace", "serif"];
      const baseWidths = ctx ? bases.map(widthWith) : [];
      const applied = written.map((family, index) => {
        if (family === families[index] && GENERIC.includes(family.toLowerCase())) return null;
        try {
          if (document.fonts.check(`${weight} ${size} ${family}`) === false) return false;
        } catch {
          // Not a font the shorthand can parse; the canvas can still tell.
        }
        if (!ctx) return null;
        return bases.some((base, b) => widthWith(`${family}, ${base}`) !== baseWidths[b]);
      });
      return { families, applied };
    } catch {
      return null;
    }
  };

  const svgOf = (svg: Element): { svg?: RawSvgNode; shapes?: RawBox[]; svgElements?: number } => {
    const count = svg.getElementsByTagName("*").length;
    if (count > args.maxSvgElements) return { svgElements: count };
    if (!tree) return { svg: { tag: "svg", attrs: {}, kids: [] }, shapes: [] };
    const box = svg.getBoundingClientRect();
    const hidden = "defs, clipPath, mask, symbol, pattern, marker";
    const visit = (el: Element): RawSvgNode | null => {
      const tag = el.tagName;
      if (args.svgDropped.includes(tag)) return null;
      const attrs: Record<string, string> = {};
      for (const a of args.svgGeometry) {
        const v = el.getAttribute(a);
        if (v !== null) attrs[a] = v;
      }
      if (tag === "g") {
        // What a group does to its shapes as one, which their own computed style doesn't show.
        const cs = getComputedStyle(el);
        const paint: Record<string, string> = {};
        for (const p of args.svgGroup) paint[p] = cs.getPropertyValue(p);
        return { tag, attrs, paint, kids: Array.from(el.children).map(visit).filter((k): k is RawSvgNode => k !== null) };
      }
      if (args.svgShapes.includes(tag)) {
        const cs = getComputedStyle(el);
        if (cs.display === "none") return null;
        const paint: Record<string, string> = {};
        for (const p of args.svgPaint) {
          const v = cs.getPropertyValue(p);
          paint[p] = /^currentcolor$/i.test(v) ? cs.color : v;
        }
        return { tag, attrs, paint };
      }
      return { tag, attrs: {}, raw: el.outerHTML.replace(/>\s+</g, "><") };
    };
    const attrs: Record<string, string> = {};
    for (const a of ["viewBox", "preserveAspectRatio"]) {
      const v = svg.getAttribute(a);
      if (v !== null) attrs[a] = v;
    }
    const kids = Array.from(svg.children).map(visit).filter((k): k is RawSvgNode => k !== null);
    const shapes = Array.from(svg.querySelectorAll(args.svgShapes.join(",")))
      .filter((s) => {
        if (s.closest(hidden)) return false;
        const cs = getComputedStyle(s);
        return cs.display !== "none" && cs.visibility === "visible" && (cs.fill !== "none" || cs.stroke !== "none");
      })
      .map((s) => {
        const r = s.getBoundingClientRect();
        return [r.left - box.left, r.top - box.top, r.width, r.height] as RawBox;
      });
    return { svg: { tag: "svg", attrs, kids }, shapes };
  };

  const pseudoOf = (el: Element, which: "before" | "after", elCs: CSSStyleDeclaration, rect: DOMRect): RawTreePseudo | null => {
    const pcs = getComputedStyle(el, `::${which}`);
    const content = pcs.content;
    if (!content || content === "none" || content === "normal" || pcs.display === "none") return null;
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(content);
    const text = quoted ? quoted[1].replace(/\\(.)/g, "$1") : "";
    // Whether it may paint, leaning to yes: snap-tree.ts decides exactly.
    const border = ["top", "right", "bottom", "left"].some((s) =>
      parseFloat(pcs.getPropertyValue(`border-${s}-width`)) > 0 && !["none", "hidden"].includes(pcs.getPropertyValue(`border-${s}-style`)));
    const shadow = pcs.boxShadow !== "none" && !pcs.boxShadow.split(/,(?![^(]*\))/).every((layer) => {
      const color = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/.exec(layer)?.[0] ?? "";
      return color !== "" && clear(color);
    });
    const outline = pcs.outlineStyle !== "none" && parseFloat(pcs.outlineWidth) > 0;
    if (clear(pcs.backgroundColor) && pcs.backgroundImage === "none" && !border && !shadow && !outline && !text.trim()) return null;
    const out: RawTreePseudo = { k: "p", which, cs: readCss(pcs, null), content: text, box: [0, 0, 0, 0], how: "flow" };
    if (text.trim()) out.text = readText(pcs);
    const px = (v: string) => parseFloat(v) || 0;
    if (pcs.position === "absolute" || pcs.position === "fixed") {
      // A pseudo-element has no rect: placed from its insets and size, in
      // its parent's padding box, which is its containing block when the
      // parent is positioned.
      let w = px(pcs.width);
      let h = px(pcs.height);
      if (pcs.boxSizing === "content-box") {
        w += px(pcs.paddingLeft) + px(pcs.paddingRight) + px(pcs.borderLeftWidth) + px(pcs.borderRightWidth);
        h += px(pcs.paddingTop) + px(pcs.paddingBottom) + px(pcs.borderTopWidth) + px(pcs.borderBottomWidth);
      }
      out.box = [rect.left - R.left + px(elCs.borderLeftWidth) + px(pcs.left), rect.top - R.top + px(elCs.borderTopWidth) + px(pcs.top), w, h];
      // Its transform moves it from where its insets put it, as shadcn's
      // `after:-translate-x-1/2` centers a handle on its line. A matrix's
      // last terms are that move, which about the default centered origin
      // is also where a rotation or scale leaves its middle; snap-tree.ts
      // flags those.
      const matrix = /^matrix(3d)?\((.*)\)$/.exec(pcs.transform);
      if (matrix) {
        const terms = matrix[2].split(",").map(Number);
        const [tx, ty] = matrix[1] ? [terms[12], terms[13]] : [terms[4], terms[5]];
        if (Number.isFinite(tx) && Number.isFinite(ty)) out.box = [out.box[0] + tx, out.box[1] + ty, w, h];
      }
      out.how = "abs";
      if (elCs.position === "static" || pcs.position === "fixed") out.unanchored = true;
      // Its radii resolve against its own size.
      for (const p of Object.keys(out.cs)) if (p.endsWith("-radius")) out.cs[p] = resolveRadius(out.cs[p], new DOMRect(0, 0, w, h));
      return out;
    }
    if (!tree) return out;
    if (!hider) {
      hider = document.createElement("style");
      hider.textContent = `[${HIDE}="before"]::before, [${HIDE}="after"]::after { content: none !important; display: none !important; }`;
      document.head.appendChild(hider);
    }
    const span = document.createElement("span");
    for (let i = 0; i < pcs.length; i++) span.style.setProperty(pcs[i], pcs.getPropertyValue(pcs[i]));
    span.textContent = text;
    const watched = [el, ...Array.from(el.children)];
    const before = watched.map((n) => n.getBoundingClientRect());
    el.setAttribute(HIDE, which);
    if (which === "before") el.insertBefore(span, el.firstChild);
    else el.appendChild(span);
    const box = span.getBoundingClientRect();
    const after = watched.map((n) => n.getBoundingClientRect());
    span.remove();
    el.removeAttribute(HIDE);
    out.box = rel(box);
    if (before.some((b, i) => ["left", "top", "width", "height"].some((k) => Math.abs(b[k as "left"] - after[i][k as "left"]) > 0.5))) out.moved = true;
    for (const p of Object.keys(out.cs)) if (p.endsWith("-radius")) out.cs[p] = resolveRadius(out.cs[p], box);
    return out;
  };

  // The element's children, with `display: contents` flattened into it, in DOM order.
  const childrenOf = (el: Element, path: number[], depth: number, into: RawTreeItem[], owner: Element) => {
    const elements = Array.from(el.children);
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const raw = child.textContent ?? "";
        if (!raw.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0).map(rel);
        const run: RawTreeText = { k: "t", text: raw, rects };
        // Text in a `display: contents` element is drawn in that element's
        // style, which may not be the one whose child it becomes.
        if (el !== owner) run.style = readText(getComputedStyle(el));
        into.push(run);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const kid = child as Element;
      const tag = kid.tagName.toLowerCase();
      if (nonRendered.has(tag)) continue;
      const cs = getComputedStyle(kid);
      if (cs.display === "none" || cs.opacity === "0") continue;
      const at = [...path, elements.indexOf(kid)];
      if (cs.display === "contents") {
        childrenOf(kid, at, depth, into, owner);
        continue;
      }
      if (read >= args.maxElements || depth + 1 > args.maxDepth) {
        if (!into.some((item) => item.k === "cut")) into.push({ k: "cut" });
        continue;
      }
      into.push(walk(kid, at, depth + 1));
    }
  };

  const walk = (el: Element, path: number[], depth: number): RawTreeElement => {
    read++;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const node: RawTreeElement = { k: "e", tag, box: rel(rect), cs: readCss(cs, rect, tag), kids: [], path };
    const slot = el.getAttribute("data-slot");
    if (slot) node.slot = slot;
    const role = el.getAttribute("role");
    if (role) node.role = role;
    const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const cls = classes.filter((t) => evidence.test(t));
    if (cls.length) node.cls = cls;
    if (cs.transform !== "none" && !/^matrix\(1, 0, 0, 1, [^,]+, [^,]+\)$/.test(cs.transform) && el instanceof HTMLElement) {
      node.size = [el.offsetWidth, el.offsetHeight];
    }
    if (tag === "svg") {
      const lucide = classes.find((c) => c.startsWith("lucide-"));
      if (lucide) node.lucide = lucide;
      return Object.assign(node, svgOf(el));
    }
    if (tag === "img") {
      const img = el as HTMLImageElement;
      node.img = { src: img.currentSrc || img.src, natural: [img.naturalWidth, img.naturalHeight] };
      return node;
    }
    if (tag === "canvas" || tag === "video") return node;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const input = el as HTMLInputElement;
      node.text = readText(cs);
      // A select shows its chosen option's label, not its options, which have no box.
      const value = tag === "select" ? ((el as HTMLSelectElement).selectedOptions[0]?.label ?? "") : (input.value ?? "");
      const placeholder = tag === "select" ? "" : (input.getAttribute("placeholder") ?? "");
      const shown = value || placeholder;
      let advance = 0;
      const ctx = document.createElement("canvas").getContext("2d");
      if (ctx && shown) {
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        advance = ctx.measureText(input.type === "password" ? "•".repeat(shown.length) : shown).width;
      }
      node.input = { type: tag === "input" ? (input.type || "text") : tag, value, placeholder, advance };
      if (!value && placeholder) node.input.placeholderColor = getComputedStyle(el, "::placeholder").color;
      return node;
    }
    if (Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim())) node.text = readText(cs);
    const before = pseudoOf(el, "before", cs, rect);
    if (before) node.kids.push(before);
    childrenOf(el, path, depth, node.kids, el);
    const after = pseudoOf(el, "after", cs, rect);
    if (after) node.kids.push(after);
    return node;
  };

  try {
    return { root: walk(root, [], 0), fonts };
  } finally {
    (hider as HTMLStyleElement | null)?.remove();
  }
}

/** A variant's tree as captureStory read it, with what its assets are made from. */
export interface CapturedTree {
  nodes: TreeNode[];
  truncated?: { nodes: number; at: string };
  /** Each SVG kept as a vector, by asset id. */
  svg: Record<string, string>;
  /** Each image by asset id: what its thumbnail is made from. */
  images: Record<string, CapturedImage>;
  notes: string[];
  /** BuiltTree's: elements placed against the window or page, measured moved inside the root's box. */
  movedInside: string[];
  /** How long reading the tree took, its images' bytes and screenshots included, in ms. */
  ms: number;
}

/** What an image's thumbnail is drawn from: its source, or for a raster the screenshot that is its thumbnail. */
export interface CapturedImage {
  bytes: Buffer;
  /** The source's type, for the data URL the page draws it from. */
  mime: string;
  natural: [number, number];
  crop: ImageCrop;
  /** The box it was drawn into, in CSS px. */
  box: [number, number];
  raster?: true;
}

/** The arguments captureTreeInPage takes, from the modules it can't import. */
function treeInPageArgs(mode: "tree" | "count"): TreeInPageArgs {
  return {
    mode,
    defaults: { ...TREE_PROPERTY_DEFAULTS },
    textProperties: TEXT_TREE_PROPERTIES,
    ...RAW_TREE_LIMITS,
    svgShapes: SVG_SHAPE_TAGS,
    svgGeometry: SVG_GEOMETRY,
    svgPaint: SVG_PAINT_PROPERTIES,
    svgGroup: SVG_GROUP_PROPERTIES,
    svgDropped: SVG_DROPPED_TAGS,
    nonRendered: NON_RENDERED_TAGS,
  };
}

/** Image responses a page received, by URL, from now until stop(): the bytes snap keeps a thumbnail of. */
interface ImageResponses {
  body(url: string): Promise<Buffer | null> | undefined;
  stop(): void;
}

/**
 * Keeps each image's bytes as the page receives them, under its URL and
 * every URL that redirected to it: an `<img>` names the URL it asked for,
 * and shadcn.png answers from avatars.githubusercontent.com.
 */
function watchImageResponses(page: Page): ImageResponses {
  const bodies = new Map<string, Promise<Buffer | null>>();
  const listener = (response: Response) => {
    const request = response.request();
    if (request.resourceType() !== "image") return;
    const status = response.status();
    if (status >= 300 && status < 400) return;
    const body = response.body().catch(() => null);
    for (let at: Request | null = request; at; at = at.redirectedFrom()) bodies.set(at.url(), body);
  };
  page.on("response", listener);
  return { body: (url) => bodies.get(url), stop: () => page.off("response", listener) };
}

/**
 * An image's bytes: from the response the page had, a `data:` URL, a
 * request of its own with the page's cookies, or a fetch in the page, which
 * a `blob:` URL needs. Null when none gives an image a browser draws.
 */
async function imageBytes(page: Page, src: string, responses: ImageResponses | null, timeoutMs: number): Promise<{ bytes: Buffer; mime: string } | null> {
  const typed = (bytes: Buffer | null | undefined) => {
    const mime = bytes?.length ? sniffImageType(bytes) : null;
    return mime ? { bytes: bytes!, mime } : null;
  };
  if (!src) return null;
  const data = decodeDataUrl(src);
  if (data) return typed(Buffer.from(data.bytes));
  const cached = typed(await responses?.body(src));
  if (cached) return cached;
  if (/^https?:/i.test(src)) {
    try {
      const response = await page.context().request.get(src, { timeout: timeoutMs });
      const fetched = response.ok() ? typed(await response.body()) : null;
      if (fetched) return fetched;
    } catch {
      // Unreachable from Node; the page may still reach it.
    }
  }
  try {
    const base64 = await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    }, src);
    return base64 ? typed(Buffer.from(base64, "base64")) : null;
  } catch {
    return null;
  }
}

/** The element at `path` under `root`, by child index at each level, or null. */
async function elementAt(root: ElementHandle<Element>, path: number[]): Promise<ElementHandle<Element> | null> {
  const handle = await root.evaluateHandle((el, at) => at.reduce<Element | null>((node, index) => node?.children[index] ?? null, el), path);
  const element = handle.asElement();
  if (!element) await handle.dispose();
  return element as ElementHandle<Element> | null;
}

/** A screenshot of the element at `path`, or null when it has no box to take one of. */
async function rasterOf(root: ElementHandle<Element>, path: number[], timeoutMs: number): Promise<Buffer | null> {
  const element = await elementAt(root, path);
  if (!element) return null;
  try {
    const box = await element.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    return await element.screenshot({ type: "png", timeout: timeoutMs });
  } catch {
    return null;
  } finally {
    await element.dispose();
  }
}

/** Runs in the page: an image's pixel size, decoded from `url`. */
async function naturalSizeInPage(url: string): Promise<[number, number]> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return [img.naturalWidth, img.naturalHeight];
}

const dataUrl = (bytes: Buffer, mime: string) => `data:${mime};base64,${bytes.toString("base64")}`;

/**
 * The tree under `target`, every image's source bytes fetched and every
 * node only a screenshot can keep taken (section 6.7 of the design). An
 * image whose bytes can't be had is kept as a screenshot of its element.
 */
export async function captureTree(
  page: Page,
  target: ElementHandle<Element>,
  responses: ImageResponses | null,
  timeoutMs: number,
): Promise<CapturedTree> {
  const started = Date.now();
  const raw = await target.evaluate(captureTreeInPage, treeInPageArgs("tree")) as RawTreeCapture | null;
  if (!raw?.root) throw new Error("the page returned no tree");
  const built = buildTree(raw);
  const byKey = new Map(built.nodes.map((node) => [node.k, node]));
  const images: Record<string, CapturedImage> = {};

  const raster = async (key: string, path: number[]) => {
    const node = byKey.get(key)!;
    const png = await rasterOf(target, path, timeoutMs);
    const size = png ? pngSize(png) : null;
    if (!png || !size) {
      // Nothing to keep a picture of: a frame its size, saying so.
      node.t = "F";
      delete node.raster;
      delete node.img;
      node.approx = [node.approx, "raster-unavailable"].filter(Boolean).join(",");
      return;
    }
    const crop = imageCrop(size, size, "fill", "0% 0%");
    const id = imageAssetId(png, `raster:${crop.key}`);
    node.t = "I";
    node.raster = 1;
    node.img = id;
    images[id] = { bytes: png, mime: "image/png", natural: size, crop, box: [node.box[2], node.box[3]], raster: true };
  };

  // An image from its source's bytes, or false to keep a screenshot of it.
  const image = async (pending: PendingImage): Promise<boolean> => {
    const node = byKey.get(pending.key)!;
    const source = await imageBytes(page, pending.src, responses, timeoutMs);
    let natural = pending.natural;
    if (source && !(natural[0] > 0 && natural[1] > 0)) {
      natural = await page.evaluate(naturalSizeInPage, dataUrl(source.bytes, source.mime)).catch(() => [0, 0] as [number, number]);
    }
    if (!source || !(natural[0] > 0 && natural[1] > 0) || !(pending.content[0] > 0 && pending.content[1] > 0)) return false;
    const crop = imageCrop(natural, pending.content, pending.fit, pending.position);
    const id = imageAssetId(source.bytes, crop.key);
    node.img = id;
    const known = images[id];
    // Several variants, or nodes, share a crop: the largest box serves all.
    if (!known || pending.content[0] * pending.content[1] > known.box[0] * known.box[1]) {
      images[id] = { bytes: source.bytes, mime: source.mime, natural, crop, box: pending.content };
    }
    return true;
  };
  for (const pending of built.images) {
    // One image that can't be read is a screenshot, never the variant failed.
    const kept = await image(pending).catch(() => false);
    if (!kept) await raster(pending.key, pending.path);
  }
  for (const pending of built.rasters) await raster(pending.key, pending.path);
  return {
    nodes: built.nodes,
    ...(built.truncated ? { truncated: built.truncated } : {}),
    svg: built.svg,
    images,
    notes: built.notes,
    movedInside: built.movedInside,
    ms: Date.now() - started,
  };
}

/** How many elements a tree under `target` would hold, for `--root-only`. */
export async function countTree(target: ElementHandle<Element>): Promise<number> {
  const raw = await target.evaluate(captureTreeInPage, treeInPageArgs("count")) as RawTreeCapture | null;
  if (!raw?.root) throw new Error("the page returned no tree");
  return countInnerElements(raw);
}

/**
 * Runs in the page: an image's thumbnail, drawn from its source as its box
 * shows it, at `size` pixels, encoded as THUMBNAIL_ENCODING says: one type
 * where every pixel is opaque, another where any isn't. The source arrives
 * as a `data:` URL, so a picture from another origin draws without
 * tainting the canvas.
 */
export async function thumbnailInPage(args: {
  url: string;
  src: [number, number, number, number];
  dst: [number, number, number, number];
  size: [number, number];
  encoding: typeof THUMBNAIL_ENCODING;
}): Promise<{ mime: "image/jpeg" | "image/png"; base64: string }> {
  const img = new Image();
  img.src = args.url;
  await img.decode();
  const [w, h] = args.size;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const [sx, sy, sw, sh] = args.src;
  const [dx, dy, dw, dh] = args.dst;
  ctx.drawImage(img, sx, sy, sw, sh, dx * w, dy * h, dw * w, dh * h);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  let alpha = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) {
      alpha = true;
      break;
    }
  }
  const mime = alpha ? args.encoding.alpha : args.encoding.opaque;
  const url = canvas.toDataURL(mime, args.encoding.quality);
  return { mime, base64: url.slice(url.indexOf(",") + 1) };
}

/**
 * An image asset's thumbnail bytes and type: drawn in `page` at twice the
 * largest box it was seen in, or, for a raster, the screenshot itself.
 */
export async function makeThumbnail(page: Page, image: CapturedImage): Promise<{ bytes: Buffer; mime: "image/jpeg" | "image/png"; size: [number, number] }> {
  if (image.raster) return { bytes: image.bytes, mime: "image/png", size: image.natural };
  const size = thumbnailSize(image.box);
  const drawn = await page.evaluate(thumbnailInPage, { url: dataUrl(image.bytes, image.mime), src: image.crop.src, dst: image.crop.dst, size, encoding: THUMBNAIL_ENCODING });
  return { bytes: Buffer.from(drawn.base64, "base64"), mime: drawn.mime, size };
}

/**
 * Runs in the page: `el`, or when neither it nor anything in it draws, the
 * nearest element around it inside the story's root that does (section 6.1
 * of the design). Draws: a fill, picture, border, shadow or outline of its
 * own, an `<svg>`, `<img>`, `<canvas>` or `<video>`, text, or an input
 * showing a value or placeholder.
 */
export function drawingElementInPage(el: Element, containers: readonly string[]): Element {
  // rgba() with alpha 0, or the slash syntax's `/ 0`: not rgb(r, g, 0), which is opaque.
  const clear = (c: string) => !c || c === "transparent" || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(c) || /\/\s*0(?:\.0+)?\s*\)$/.test(c);
  const own = (e: Element, cs: CSSStyleDeclaration): boolean => {
    const tag = e.tagName.toLowerCase();
    if (["svg", "img", "canvas", "video"].includes(tag)) return true;
    if ((tag === "input" || tag === "textarea") && ((e as HTMLInputElement).value || e.getAttribute("placeholder"))) return true;
    if (!clear(cs.backgroundColor) || cs.backgroundImage !== "none") return true;
    if (["Top", "Right", "Bottom", "Left"].some((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0)) return true;
    if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) return true;
    if (cs.boxShadow !== "none" && !cs.boxShadow.split(/,(?![^(]*\))/).every((l) => clear(/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/.exec(l)?.[0] ?? ""))) return true;
    return Array.from(e.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim());
  };
  let budget = 2000;
  const draws = (e: Element): boolean => {
    if (budget-- <= 0) return true;
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.opacity === "0") return false;
    return own(e, cs) || Array.from(e.children).some(draws);
  };
  if (draws(el)) return el;
  const story = containers.map((s) => document.querySelector(s)).find((c) => c?.contains(el)) ?? null;
  for (let at = el.parentElement; at && story && at !== story && story.contains(at); at = at.parentElement) {
    if (draws(at)) return at;
  }
  return el;
}
