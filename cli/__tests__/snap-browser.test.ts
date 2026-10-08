// Tests for the browser-bound module that need no browser: the Page is a
// stand-in, and playwright-core is never loaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";
import { captureStory, browserInstallCommand, storybookErrorInPage, storyReadySelector } from "../snap-browser.js";

/** Listening for requests, which captureStory does to wait for images. */
const LISTENS = { on: () => {}, off: () => {} };

/** A page whose navigation fails with `err`. */
function failingPage(err: unknown): Page {
  return { ...LISTENS, goto: async () => { throw err; } } as unknown as Page;
}

/**
 * A page that loads, shows Storybook's error display from the `errorFrom`th
 * look at it on (never, by default), and whose wait for the story either
 * ends or times out. Every wait is recorded.
 */
function storyPage(opts: { errorFrom?: number; appears: boolean }) {
  const waits: { selector: string; timeout: number | undefined }[] = [];
  let looks = 0;
  const page = {
    ...LISTENS,
    goto: async () => null,
    evaluate: async (fn: unknown) => {
      if (fn !== storybookErrorInPage) throw new Error("the stand-in only shows Storybook's error display");
      looks++;
      return opts.errorFrom != null && looks >= opts.errorFrom ? "SB_PREVIEW_API_0002 (ImplicitActionsDuringRendering)" : null;
    },
    waitForSelector: async (selector: string, options?: { timeout?: number }) => {
      waits.push({ selector, timeout: options?.timeout });
      if (!opts.appears) throw new TimeoutError(`page.waitForSelector: Timeout ${options?.timeout}ms exceeded.`);
      return null;
    },
  };
  return { page: page as unknown as Page, waits };
}

const OPTS = { timeoutMs: 1000, screenshot: false };

/** Playwright's TimeoutError, which sets its own name. */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

test("captureStory: a navigation that times out is a timeout", async () => {
  const result = await captureStory(failingPage(new TimeoutError("page.goto: Timeout 1500ms exceeded.\nCall log: ...")), "http://localhost:6006/iframe.html?id=forms-button--default", OPTS);
  assert.equal(result.status, "timeout");
  assert.equal(result.error, "page.goto: Timeout 1500ms exceeded.");
});

test("captureStory: a refused connection is a render error, even when the URL says timeout", async () => {
  // Playwright's message carries the URL, and a story id or an arg value can
  // hold the word: neither makes a refused connection a timeout.
  for (const url of [
    "http://localhost:6598/iframe.html?id=forms-button--default&viewMode=story&args=status%3Aidle",
    "http://localhost:6598/iframe.html?id=forms-button--default&viewMode=story&args=status%3Atimeout",
    "http://localhost:6598/iframe.html?id=feedback-session-timeout--default&viewMode=story",
  ]) {
    const result = await captureStory(failingPage(new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${url}`)), url, OPTS);
    assert.equal(result.status, "render_error", url);
    assert.equal(result.error, `page.goto: net::ERR_CONNECTION_REFUSED at ${url}`);
  }
});

test("captureStory: a thrown non-Error is a render error", async () => {
  const result = await captureStory(failingPage("timed out"), "http://localhost:6006/iframe.html?id=x", OPTS);
  assert.equal(result.status, "render_error");
  assert.equal(result.error, "timed out");
});

test("browserInstallCommand: names the playwright release matching the installed playwright-core", () => {
  // playwright@latest installs the browser build the newest release launches,
  // which an older playwright-core can't find.
  const require = createRequire(import.meta.url);
  const { version } = JSON.parse(readFileSync(require.resolve("playwright-core/package.json"), "utf8")) as { version: string };
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.equal(browserInstallCommand(), `npx playwright@${version} install chromium`);
});

test("captureStory: a story whose error Storybook paints after load is a render error, not a missing element", async () => {
  // ResizablePanelGroup throws as it renders: Storybook shows its error after
  // the load event, and snap, which looked once, reported no root element.
  const { page } = storyPage({ errorFrom: 2, appears: false });
  const result = await captureStory(page, "http://localhost:6006/iframe.html?id=ui-base-resizablepanelgroup--default", OPTS);
  assert.equal(result.status, "render_error");
  assert.match(result.error!, /ImplicitActionsDuringRendering/);
});

test("captureStory: the wait for the story ends on Storybook's error display", async () => {
  const { page, waits } = storyPage({ errorFrom: 2, appears: true });
  const result = await captureStory(page, "http://localhost:6006/iframe.html?id=x--default", OPTS);
  assert.equal(result.status, "render_error");
  assert.match(waits[0].selector, /body\.sb-show-errordisplay/);
});

test("captureStory: a story that never renders costs one --timeout, not one per root", async () => {
  // It waited for #storybook-root, then for #root, which no Storybook from 7
  // on has, each for the whole timeout.
  const { page, waits } = storyPage({ appears: false });
  const result = await captureStory(page, "http://localhost:6006/iframe.html?id=x--default", OPTS);
  assert.equal(result.status, "element_not_found");
  assert.equal(result.error, "no element matched #storybook-root > * or #root > *");
  assert.deepEqual(waits.map((w) => w.timeout), [OPTS.timeoutMs]);
});

test("storyReadySelector: waits for an element that can draw, the component's slots, or an error, in one selector", () => {
  const selector = storyReadySelector(["input-otp"]);
  // input-otp's <noscript> comes first, and must not end the wait.
  assert.match(selector, /#storybook-root > :not\(noscript, script, style, template/);
  assert.match(selector, /#root > :not\(noscript/);
  // Content only in a portal, as an open dialog's, ends it too.
  assert.match(selector, /\[data-slot="input-otp"\], \[data-slot="input-otp-content"\]/);
  assert.match(selector, /body\.sb-show-errordisplay, body\.sb-show-preparingstory-error$/);
});
