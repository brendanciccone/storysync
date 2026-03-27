/**
 * Playwright screenshot capture — renders each variant state and captures a screenshot.
 */

import { chromium, type Browser, type Page } from "playwright";

export interface RendererOptions {
  /** Base URL of the running Storybook instance. */
  storybookUrl: string;
  /** Viewport width for screenshots. Defaults to 800. */
  width?: number;
  /** Viewport height for screenshots. Defaults to 600. */
  height?: number;
  /** Wait time in ms after page load before capturing. Defaults to 1000. */
  waitAfterLoad?: number;
}

export class Renderer {
  private browser: Browser | null = null;
  private options: RendererOptions;

  constructor(options: RendererOptions) {
    this.options = options;
  }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
  }

  async close(): Promise<void> {
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
    if (!this.browser) {
      throw new Error("Renderer not launched. Call launch() first.");
    }

    const page = await this.browser.newPage({
      viewport: {
        width: this.options.width ?? 800,
        height: this.options.height ?? 600,
      },
    });

    try {
      const url = this.buildStoryUrl(storyId, args);
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForTimeout(this.options.waitAfterLoad ?? 1000);

      await this.waitForStoryReady(page);

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
   * Returns a map of screenshot key → PNG buffer.
   */
  async captureVariants(
    componentName: string,
    storyId: string,
    variantCombinations: Record<string, string>[]
  ): Promise<Map<string, Buffer>> {
    const screenshots = new Map<string, Buffer>();

    for (const combination of variantCombinations) {
      const key = this.buildScreenshotKey(componentName, combination);
      const screenshot = await this.captureStory(storyId, combination);
      screenshots.set(key, screenshot);
    }

    return screenshots;
  }

  private buildStoryUrl(storyId: string, args?: Record<string, unknown>): string {
    const base = this.options.storybookUrl.replace(/\/$/, "");
    const url = new URL(`${base}/iframe.html`);
    url.searchParams.set("id", storyId);
    url.searchParams.set("viewMode", "story");

    if (args) {
      const argsString = Object.entries(args)
        .map(([key, value]) => `${key}:${this.encodeArgValue(value)}`)
        .join(";");
      url.searchParams.set("args", argsString);
    }

    return url.toString();
  }

  private encodeArgValue(value: unknown): string {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return value;
    return String(value);
  }

  private async waitForStoryReady(page: Page): Promise<void> {
    try {
      await page.waitForSelector("#storybook-root > *", { timeout: 5000 });
    } catch {
      // Component may use a different root — continue with the screenshot.
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
