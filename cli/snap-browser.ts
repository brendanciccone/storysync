// The only browser-bound module in storysync.
//
// Everything that can be tested without Chromium lives in snap-normalize.ts;
// this file is limited to launching a browser and reading one story's rendered
// styles out of the page.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Browser, BrowserContext, Page, ElementHandle, Request } from "playwright-core";
import {
  CAPTURED_PROPERTIES, TEXT_PROPERTIES, WRAPPER_PROPERTIES, NON_RENDERED_TAGS,
  chooseMeasuredElement, componentSlots, contentSlots, describeElement, resolveFontFamily,
} from "./snap-normalize.js";
import type { RawComputedStyles, FontProbe, MeasurementNote, PortalNode, StoryNode } from "./snap-normalize.js";

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

export type CaptureStatus = "ok" | "render_error" | "timeout" | "element_not_found";

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
  /**
   * A checksum of the story's markup, as readMarkup reads it, or null when
   * it changed while the variant was measured, or couldn't be read. snap
   * compares it across a component's variants and doesn't record it: see
   * describeIdenticalVariants.
   */
  markup: string | null;
}

export interface CaptureOptions {
  timeoutMs: number;
  /** Measures the element this matches as it is, rather than choosing one. */
  selector?: string;
  screenshot: boolean;
  /** The component the story renders, whose `data-slot` marks its root: see chooseMeasuredElement. */
  component?: { name: string; title?: string };
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
    matchedSelector: null, element: null, notes: [], fontAvailable: null, fonts: { root: null, text: null }, markup: null,
  };
  const slots = opts.component ? componentSlots(opts.component.name, opts.component.title) : [];
  let images: ImageRequests | null = null;
  let loaded = false;

  try {
    // From before the navigation, so a request the story makes as it renders is seen.
    images = watchImageRequests(page);
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

    await settle(page, images, Math.min(opts.timeoutMs, IMAGE_WAIT_MS));

    const located = opts.selector ? await locateSelector(page, opts.selector) : await locateComponent(page, slots);
    if ("error" in located) return { status: "element_not_found", error: located.error, ...empty };
    const { target, element, notes, matchedSelector } = located;

    // Read before the styles and again after the picture: markup that
    // changes in between, a story that animates, is no evidence either way.
    const markupBefore = await readMarkup(page);
    const raw = await readComputedStyles(page, target, CAPTURED_PROPERTIES);
    const holder = await findTextHolder(target);
    const textRaw = holder ? await readTextStyles(page, holder, target, TEXT_PROPERTIES) : null;
    const fonts = { root: await probeFontStack(target), text: holder ? await probeFontStack(holder) : null };
    const fontAvailable = fonts.root ? resolveFontFamily(fonts.root).available : null;
    const boundingBox = await target.boundingBox();

    // Before the screenshot, which throws on an element with no box.
    if (!boundingBox) {
      return { status: "element_not_found", error: "element has no layout box (display:none?)", ...empty, raw, textRaw, element, fontAvailable, fonts };
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
    return { status: "ok", error: null, retryable: false, raw, textRaw, boundingBox, screenshot, matchedSelector, element, notes, fontAvailable, fonts, markup };
  } catch (err) {
    // By the error's class, not its text: Playwright puts the story URL in
    // the message, so a story id or arg value containing "timeout" would turn
    // a refused connection into a timeout. Its TimeoutError names itself, and
    // this file imports only playwright's types, so the class isn't to hand.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return { status: isTimeout ? "timeout" : "render_error", error: firstLine(err), ...empty, retryable: isTimeout && !loaded };
  } finally {
    images?.stop();
  }
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

/**
 * What waitForStory waits for, unless --selector names something else: a
 * child of the story's root that can draw, the component's own `data-slot`
 * or its `-content` slot anywhere, so content rendered only into a portal
 * counts, or Storybook's error display.
 *
 * One selector, so one wait: a story that never renders costs one --timeout,
 * where waiting on each root in turn cost one per root, and `#root` never
 * exists from Storybook 7 on.
 */
export function storyReadySelector(slots: readonly string[]): string {
  return [
    ...ROOT_CONTAINERS.map((container) => `${container} > :not(${NON_RENDERED_TAGS.join(", ")})`),
    ...[...new Set([...slots, ...contentSlots(slots)])].map((slot) => `[data-slot="${slot}"]`),
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
  const portalsHandle = await page.evaluateHandle(findPortalsInPage, { container, slots: [...new Set([...slots, ...contentSlots(slots)])] });
  try {
    const portals: PortalNode[] = await portalsHandle.evaluate((elements) => elements.map((el) => ({
      tag: el.tagName.toLowerCase(),
      slot: el.getAttribute("data-slot"),
      role: el.getAttribute("role"),
      id: el.id || null,
      rendered: el.getClientRects().length > 0,
    })));
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
    };
  } finally {
    await portalsHandle.dispose();
  }
}

/**
 * Runs in the page: the story's container and everything under it, as
 * StoryNodes, cut short past `maxDepth` levels or `maxNodes` elements.
 */
function readStoryTreeInPage(
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
      styles,
      children: [],
    };
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
 * component's own and its content's, or one an element in the container
 * names in `aria-controls`. Storybook's own error and loading screens are
 * left out.
 */
function findPortalsInPage(args: { container: Element | null; slots: string[] }): Element[] {
  const wanted = new Set(args.slots);
  const controlled = new Set<string>();
  for (const el of Array.from(args.container?.querySelectorAll("[aria-controls]") ?? [])) {
    for (const id of (el.getAttribute("aria-controls") ?? "").split(/\s+/)) if (id) controlled.add(id);
  }
  const storybook = "#storybook-docs, .sb-errordisplay, .sb-nopreview, .sb-preparing-story, .sb-preparing-docs";
  return Array.from(document.body.querySelectorAll("[data-slot], [id]")).filter((el) =>
    !(args.container?.contains(el) ?? false) &&
    !el.closest(storybook) &&
    (wanted.has(el.getAttribute("data-slot") ?? "") || controlled.has(el.id)));
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

/** The nearest element at or under `root` holding text of its own, or null when there is none. */
async function findTextHolder(root: ElementHandle<Element>): Promise<ElementHandle<Element> | null> {
  const handle = await root.evaluateHandle((node) => {
    const find = (el: Element): Element | null => {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim()) return el;
        if (child.nodeType === Node.ELEMENT_NODE) {
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
