// The only browser-bound module in storysync.
//
// Everything that can be tested without Chromium lives in snap-normalize.ts;
// this file is limited to launching a browser and reading one story's rendered
// styles out of the page.

import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page, ElementHandle } from "playwright-core";
import { CAPTURED_PROPERTIES, TEXT_PROPERTIES } from "./snap-normalize.js";
import type { RawComputedStyles } from "./snap-normalize.js";

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
      "  - download a browser: npx playwright@latest install chromium\n" +
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
  raw: RawComputedStyles | null;
  textRaw: RawComputedStyles | null;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  screenshot: Buffer | null;
  /** What the root-element heuristic settled on, for debugging. */
  matchedSelector: string | null;
  /**
   * Whether the browser could render the element's first declared font family,
   * or null when it could not be determined. A declared font that never loaded
   * would otherwise be measured as though it had been used.
   */
  fontAvailable: boolean | null;
}

const ROOT_SELECTORS = ["#storybook-root > *", "#root > *"] as const;

/**
 * Reads one story's rendered styles.
 *
 * Failures are returned rather than thrown: a single story that won't render
 * should not abandon a whole snap run.
 */
export async function captureStory(
  page: Page,
  url: string,
  opts: { timeoutMs: number; selector?: string; screenshot: boolean },
): Promise<CaptureResult> {
  const empty: Omit<CaptureResult, "status" | "error"> = {
    raw: null, textRaw: null, boundingBox: null, screenshot: null,
    matchedSelector: null, fontAvailable: null,
  };

  try {
    await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs });

    const renderError = await readStorybookError(page);
    if (renderError) return { status: "render_error", error: renderError, ...empty };

    const rootSelector = await waitForRoot(page, opts.selector, opts.timeoutMs);
    if (!rootSelector) {
      return { status: "element_not_found", error: `no element matched ${opts.selector ?? ROOT_SELECTORS.join(" or ")}`, ...empty };
    }

    await settle(page);

    const handle = await page.$(rootSelector);
    if (!handle) return { status: "element_not_found", error: `element vanished after load: ${rootSelector}`, ...empty };

    // Descend past layout-only wrappers so measurements describe the component.
    const target = opts.selector ? handle : await descendToComponent(page, handle);

    const raw = await readComputedStyles(page, target, CAPTURED_PROPERTIES);
    const textRaw = await readTextStyles(page, target, TEXT_PROPERTIES);
    const fontAvailable = await readFontAvailability(page, target);
    const boundingBox = await target.boundingBox();
    const screenshot = opts.screenshot ? await target.screenshot({ type: "png" }) : null;

    if (!boundingBox) {
      return { status: "element_not_found", error: "element has no layout box (display:none?)", ...empty, raw, textRaw, fontAvailable };
    }

    return { status: "ok", error: null, raw, textRaw, boundingBox, screenshot, matchedSelector: rootSelector, fontAvailable };
  } catch (err) {
    const message = firstLine(err);
    const isTimeout = /timeout|timed out/i.test(message);
    return { status: isTimeout ? "timeout" : "render_error", error: message, ...empty };
  }
}

/** Storybook renders thrown errors into the preview rather than failing the load. */
async function readStorybookError(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const shown =
      document.body.classList.contains("sb-show-errordisplay") ||
      document.body.classList.contains("sb-show-preparingstory-error");
    if (!shown) return null;
    const node = document.querySelector("#error-message, .sb-errordisplay_code, #error-stack");
    const text = (node?.textContent ?? document.body.innerText ?? "").trim();
    return text.slice(0, 300) || "Storybook reported a render error";
  });
}

async function waitForRoot(page: Page, selector: string | undefined, timeoutMs: number): Promise<string | null> {
  const candidates = selector ? [selector] : ROOT_SELECTORS;
  for (const candidate of candidates) {
    try {
      await page.waitForSelector(candidate, { state: "attached", timeout: timeoutMs });
      return candidate;
    } catch {
      // Try the next candidate; older Storybook mounts at #root.
    }
  }
  return null;
}

/** Kill animations and wait for fonts and two frames, so styles are stable. */
async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
  }).catch(() => { /* a missing head is not worth failing over */ });

  await page.evaluate(async () => {
    try { await document.fonts.ready; } catch { /* fonts API unavailable */ }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
  });
}

/**
 * Storybook decorators commonly wrap a story in padding-free, background-free
 * containers. Measuring those would describe the wrapper, not the component, so
 * descend while the current node is a single-child pass-through element.
 */
async function descendToComponent(
  page: Page,
  handle: ElementHandle<Element>,
): Promise<ElementHandle<Element>> {
  const MAX_DEPTH = 4;
  const result = await page.evaluateHandle(
    ([start, maxDepth]) => {
      let node = start as Element;
      for (let depth = 0; depth < (maxDepth as number); depth++) {
        const children = Array.from(node.children);
        if (children.length !== 1) break;
        const cs = getComputedStyle(node);
        const transparent = cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent";
        const noBorder = ["Top", "Right", "Bottom", "Left"]
          .every((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) === 0);
        const noPadding = ["top", "right", "bottom", "left"]
          .every((s) => parseFloat(cs.getPropertyValue(`padding-${s}`)) === 0);
        const passThrough = cs.display === "block" || cs.display === "contents";
        const noShadow = cs.boxShadow === "none";
        if (!(transparent && noBorder && noPadding && passThrough && noShadow)) break;
        node = children[0];
      }
      return node;
    },
    [handle, MAX_DEPTH] as const,
  );
  return (result.asElement() as ElementHandle<Element>) ?? handle;
}

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
      return out;
    },
    [handle, properties] as const,
  );
}

/** Styles of the nearest descendant that actually owns text. */
async function readTextStyles(
  page: Page,
  handle: ElementHandle<Element>,
  properties: readonly string[],
): Promise<RawComputedStyles | null> {
  return page.evaluate(
    ([node, props]) => {
      const findTextHolder = (el: Element): Element | null => {
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim()) return el;
          if (child.nodeType === Node.ELEMENT_NODE) {
            const found = findTextHolder(child as Element);
            if (found) return found;
          }
        }
        return null;
      };
      const holder = findTextHolder(node as Element);
      if (!holder) return null;
      const cs = getComputedStyle(holder);
      const out: Record<string, string> = {};
      for (const p of props as string[]) out[p] = cs.getPropertyValue(p);
      return out;
    },
    [handle, properties] as const,
  );
}

/**
 * Whether the first declared font family can actually be rendered.
 *
 * `getComputedStyle` reports the font stack as authored, not what the browser
 * resolved to, so a project naming a font it never loaded measures identically
 * to one that loaded it — and would score full marks against Figma while the
 * screenshots showed a different typeface.
 *
 * `document.fonts.check` is the honest signal available here. It answers "could
 * this be rendered", which catches the common case of a webfont that failed to
 * load. It cannot detect a system-level alias silently satisfying the request,
 * so a true result is weaker evidence than a false one.
 */
async function readFontAvailability(
  page: Page,
  handle: ElementHandle<Element>,
): Promise<boolean | null> {
  return page.evaluate((node) => {
    try {
      const cs = getComputedStyle(node as Element);
      const first = (cs.fontFamily || "").split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
      if (!first) return null;
      // Generic families are always satisfiable; reporting on them is noise.
      if (["sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui"].includes(first.toLowerCase())) {
        return null;
      }
      const size = cs.fontSize || "16px";
      const weight = cs.fontWeight || "400";
      return document.fonts.check(`${weight} ${size} "${first}"`);
    } catch {
      return null;
    }
  }, handle);
}
