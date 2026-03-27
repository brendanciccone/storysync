/**
 * Playwright screenshot capture — renders each variant state and captures a screenshot.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface RendererOptions {
  /** Base URL of the running Storybook instance. */
  storybookUrl: string;
  /** Viewport width for screenshots. Defaults to 800. */
  width?: number;
  /** Viewport height for screenshots. Defaults to 600. */
  height?: number;
  /** Wait time in ms after navigation before capturing. Defaults to 500. */
  waitAfterLoad?: number;
  /** Max concurrent pages for parallel screenshots. Defaults to 4. */
  concurrency?: number;
}

export class Renderer {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private options: RendererOptions;

  constructor(options: RendererOptions) {
    this.options = options;
  }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    // Reuse a single browser context for all screenshots — much faster
    // than creating a new page + context per screenshot.
    this.context = await this.browser.newContext({
      viewport: {
        width: this.options.width ?? 800,
        height: this.options.height ?? 600,
      },
    });
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Capture a screenshot of a specific story with given args.
   * Returns the screenshot as a PNG buffer.
   */
  async captureStory(
    storyId: string,
    args?: Record<string, unknown>
  ): Promise<Buffer> {
    if (!this.context) {
      throw new Error("Renderer not launched. Call launch() first.");
    }

    const page = await this.context.newPage();

    try {
      const url = this.buildStoryUrl(storyId, args);
      await page.goto(url, { waitUntil: "networkidle" });

      await this.waitForStoryReady(page);

      // Short stabilization wait after the component has rendered
      const waitMs = this.options.waitAfterLoad ?? 500;
      if (waitMs > 0) {
        await page.waitForTimeout(waitMs);
      }

      const screenshot = await page.screenshot({
        type: "png",
        fullPage: false,
      });

      return Buffer.from(screenshot);
    } finally {
      await page.close();
    }
  }

  /**
   * Capture screenshots for all variant combinations of a component.
   * Uses parallel page loads for speed (controlled by concurrency option).
   * Returns a map of screenshot key → PNG buffer.
   */
  async captureVariants(
    componentName: string,
    storyId: string,
    variantCombinations: Record<string, string>[]
  ): Promise<Map<string, Buffer>> {
    const screenshots = new Map<string, Buffer>();
    const concurrency = this.options.concurrency ?? 4;

    // Process in batches for controlled parallelism
    for (let i = 0; i < variantCombinations.length; i += concurrency) {
      const batch = variantCombinations.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (combination) => {
          const key = this.buildScreenshotKey(componentName, combination);
          const screenshot = await this.captureStory(storyId, combination);
          return { key, screenshot };
        })
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          screenshots.set(result.value.key, result.value.screenshot);
        }
        // Silently skip failed screenshots — partial coverage is fine
      }
    }

    return screenshots;
  }

  private buildStoryUrl(storyId: string, args?: Record<string, unknown>): string {
    const base = this.options.storybookUrl.replace(/\/$/, "");
    const url = new URL(`${base}/iframe.html`);
    url.searchParams.set("id", storyId);
    url.searchParams.set("viewMode", "story");

    if (args && Object.keys(args).length > 0) {
      const argsString = Object.entries(args)
        .map(([key, value]) => `${encodeArgKey(key)}:${encodeArgValue(value)}`)
        .join(";");
      url.searchParams.set("args", argsString);
    }

    return url.toString();
  }

  private async waitForStoryReady(page: Page): Promise<void> {
    try {
      // Wait for the Storybook root to have content
      await page.waitForSelector("#storybook-root > *", { timeout: 5000 });
    } catch {
      // Try alternate root selectors used by different Storybook versions
      try {
        await page.waitForSelector("#root > *", { timeout: 2000 });
      } catch {
        // Component may use a custom root or not be DOM-based — continue
      }
    }
  }

  private buildScreenshotKey(
    componentName: string,
    combination: Record<string, string>
  ): string {
    const parts = Object.entries(combination)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`);
    return `${componentName}__${parts.join("__")}`;
  }
}

/**
 * Encode a value for Storybook URL args format.
 * Storybook uses a specific encoding:
 *   - Booleans: !true, !false (bang-prefixed)
 *   - Numbers: plain number
 *   - Null: !null
 *   - Undefined: !undefined
 *   - Strings: plain value (special chars escaped)
 */
function encodeArgValue(value: unknown): string {
  if (value === null) return "!null";
  if (value === undefined) return "!undefined";
  if (typeof value === "boolean") return `!${value}`;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Escape special characters in the Storybook args format
    return value
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/:/g, "\\:")
      .replace(/!/g, "\\!");
  }
  return String(value);
}

function encodeArgKey(key: string): string {
  // Keys with dots indicate nested args: "style.color" → "style.color"
  // Keys should not contain special chars, but escape just in case
  return key.replace(/;/g, "\\;").replace(/:/g, "\\:");
}
