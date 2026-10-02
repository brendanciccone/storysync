// Tests for the browser-bound module that need no browser: the Page is a
// stand-in, and playwright-core is never loaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { captureStory } from "../snap-browser.js";

/** A page whose navigation fails with `err`. */
function failingPage(err: unknown): Page {
  return { goto: async () => { throw err; } } as unknown as Page;
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
