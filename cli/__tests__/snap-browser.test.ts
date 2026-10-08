// Tests for the browser-bound module that need no browser: the Page is a
// stand-in, and playwright-core is never loaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";
import { fakePreview, inPage } from "./preview-standin.js";
import type { FakeArgType } from "./preview-standin.js";
import {
  captureStory, browserInstallCommand, storybookErrorInPage, storyReadySelector, storyArgsInPage, applyStoryArgsInPage,
} from "../snap-browser.js";

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

/**
 * A story that loads and is measured through --selector, whose element has
 * `box` and whose screenshot is `shoot`'s. Each screenshot's options are
 * recorded.
 */
function measuredPage(box: { x: number; y: number; width: number; height: number }, shoot: () => Promise<Buffer>) {
  const shots: { timeout?: number }[] = [];
  let described = false;
  const target = {
    // The element's description, then its font stack, which the stand-in can't probe.
    evaluate: async () => {
      if (described) return null;
      described = true;
      return { tag: "div", slot: null, role: null };
    },
    evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
    boundingBox: async () => box,
    screenshot: async (options: { timeout?: number }) => {
      shots.push(options);
      return shoot();
    },
  };
  const page = {
    ...LISTENS,
    goto: async () => null,
    waitForSelector: async () => null,
    addStyleTag: async () => null,
    $: async () => target,
    // Storybook's error display, settling and images: nothing to report.
    // The computed styles: none to speak of.
    evaluate: async (fn: unknown, arg?: unknown) => (fn === storybookErrorInPage ? null : arg ? {} : false),
  };
  return { page: page as unknown as Page, shots };
}

const SHOT = { ...OPTS, screenshot: true, selector: "#storybook-root > div" };

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
  // What was waited for, which a root holding only a <noscript> doesn't have.
  assert.equal(result.error, "nothing that draws rendered under #storybook-root or #root");
  assert.deepEqual(waits.map((w) => w.timeout), [OPTS.timeoutMs]);
  const selected = await captureStory(storyPage({ appears: false }).page, "http://localhost:6006/iframe.html?id=x--default", { ...OPTS, selector: ".card" });
  assert.equal(selected.error, "no element matched .card");
});

test("storyReadySelector: waits for an element that can draw, the component's slots, or an error, in one selector", () => {
  const selector = storyReadySelector(["input-otp"]);
  // input-otp's <noscript> comes first, and must not end the wait.
  assert.match(selector, /#storybook-root > :not\(noscript, script, style, template/);
  assert.match(selector, /#root > :not\(noscript/);
  // Content only in a portal, as an open dialog's, ends it too.
  assert.match(selector, /\[data-slot="input-otp"\], \[data-slot="input-otp-content"\]/);
  assert.match(selector, /body\.sb-show-errordisplay, body\.sb-show-preparingstory-error$/);
  // A slot already ending in -content is not doubled.
  const tooltip = storyReadySelector(["tooltip-content", "tooltip"]);
  assert.match(tooltip, /\[data-slot="tooltip-content"\], \[data-slot="tooltip"\], body/);
  assert.doesNotMatch(tooltip, /content-content/);
});

test("captureStory: a navigation that times out may be tried again", async () => {
  const result = await captureStory(failingPage(new TimeoutError("page.goto: Timeout 1000ms exceeded.")), "http://localhost:6006/iframe.html?id=x", OPTS);
  assert.equal(result.retryable, true);
  const refused = await captureStory(failingPage(new Error("net::ERR_CONNECTION_REFUSED")), "http://localhost:6006/iframe.html?id=x", OPTS);
  assert.equal(refused.retryable, false);
});

test("captureStory: a screenshot waits no longer than --timeout, and timing out is not worth a retry", async () => {
  // It took Playwright's own 30 seconds whatever --timeout said, and snap
  // then tried the variant again for 30 more.
  const { page, shots } = measuredPage({ x: 0, y: 0, width: 40, height: 20 }, async () => {
    throw new TimeoutError("elementHandle.screenshot: Timeout 1000ms exceeded.");
  });
  const result = await captureStory(page, "http://localhost:6006/iframe.html?id=x", SHOT);
  assert.equal(result.status, "timeout");
  assert.equal(result.retryable, false);
  assert.deepEqual(shots.map((s) => s.timeout), [SHOT.timeoutMs]);
});

test("captureStory: an element with no width or height is measured without a screenshot", async () => {
  // Playwright waits for it to be visible, which it never is: a closed
  // Collapsible's content, measured 1264x0, timed out instead.
  for (const box of [{ x: 0, y: 0, width: 1264, height: 0 }, { x: 0, y: 0, width: 0, height: 18 }]) {
    const { page, shots } = measuredPage(box, async () => { throw new Error("screenshot taken"); });
    const result = await captureStory(page, "http://localhost:6006/iframe.html?id=x", SHOT);
    assert.equal(result.status, "ok", result.error ?? "");
    assert.equal(result.screenshot, null);
    assert.deepEqual(result.boundingBox, box);
    assert.equal(shots.length, 0);
  }
  const { page } = measuredPage({ x: 0, y: 0, width: 40, height: 20 }, async () => Buffer.from("png"));
  const drawn = await captureStory(page, "http://localhost:6006/iframe.html?id=x", SHOT);
  assert.equal(drawn.status, "ok", drawn.error ?? "");
  assert.equal(drawn.screenshot?.toString(), "png");
});

// --- Args ---------------------------------------------------------------------
//
// Storybook's preview is stood in for by preview-standin.ts.

const BADGE_TYPES: Record<string, FakeArgType> = {
  variant: { options: ["default", "secondary"], type: { name: "enum" }, control: { type: "select" } },
  size: { options: ["sm", "lg"], if: { arg: "variant", neq: "link" }, type: { name: "enum" } },
  children: { type: { name: "string" }, control: { type: "text" } },
};

test("storyArgsInPage: reads what the store holds, what the story is given, and its argTypes", async () => {
  const fake = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default", size: "sm", children: "Badge" }, url: { variant: "ghost", size: "lg" } });
  const snapshot = await inPage(fake.preview, () => storyArgsInPage({ storyId: fake.storyId, waitMs: 100 }));
  assert.deepEqual(snapshot, {
    fileName: "./badge.stories.tsx",
    argTypes: {
      variant: { type: "enum", control: "select", options: ["default", "secondary"], if: undefined, mapping: undefined },
      size: { type: "enum", control: undefined, options: ["sm", "lg"], if: { arg: "variant", neq: "link" }, mapping: undefined },
      children: { type: "string", control: "text", options: undefined, if: undefined, mapping: undefined },
    },
    // ghost was dropped, as Storybook drops a value outside the options.
    stored: { variant: "default", size: "lg", children: "Badge" },
    rendered: { variant: "default", size: "lg", children: "Badge" },
    globals: { theme: "light" },
  });
  // A hidden arg is in the store and not given to the story.
  const link = fakePreview({ argTypes: { ...BADGE_TYPES, variant: { options: ["default", "link"] } }, initial: { variant: "default", size: "sm" }, url: { variant: "link", size: "lg" } });
  const hidden = await inPage(link.preview, () => storyArgsInPage({ storyId: link.storyId, waitMs: 100 }));
  assert.deepEqual(hidden && "rendered" in hidden ? [hidden.stored, hidden.rendered] : hidden, [{ variant: "link", size: "lg" }, { variant: "link" }]);
  // Without a preview there is nothing to read, said as such.
  assert.deepEqual(await inPage(undefined, () => storyArgsInPage({ storyId: "x", waitMs: 0 })), { error: "the page has no window.__STORYBOOK_PREVIEW__" });
});

test("storyArgsInPage: a mapped arg is read by the value asked for, and one aimed at another target as given", async () => {
  // Storybook gives the story `icon` mapped, and `label` in argsByTarget,
  // not in args: both were given, as the URL asked.
  const argTypes: Record<string, FakeArgType> = {
    icon: { options: ["star", "heart"], mapping: { star: "★", heart: "♥" }, type: { name: "enum" } },
    label: { type: { name: "string" }, target: "wrapper" },
  };
  const fake = fakePreview({ argTypes, initial: { icon: "heart" }, url: { icon: "star", label: "Hi" } });
  const snapshot = await inPage(fake.preview, () => storyArgsInPage({ storyId: fake.storyId, waitMs: 100 }));
  assert.deepEqual(snapshot && "rendered" in snapshot ? snapshot.rendered : snapshot, { icon: "star", label: "Hi" });
  assert.equal(snapshot && "argTypes" in snapshot ? snapshot.argTypes.icon.mapping : snapshot, true);
  // Its mapping is read too, for judging an if as Storybook does.
  assert.deepEqual(snapshot && "mappings" in snapshot ? snapshot.mappings : snapshot, { icon: { star: "★", heart: "♥" } });
});

test("applyStoryArgsInPage: waits for the render, lifts the if, updates, then remounts", async () => {
  const fake = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default", size: "sm" }, url: { variant: "link", size: "lg" }, phase: "afterEach" });
  // The first render is still running its afterEach, as Storybook's a11y
  // addon's does for seconds: a remount now would reload the page.
  setTimeout(() => { fake.render.phase = "finished"; }, 30);
  const result = await inPage(fake.preview, () =>
    applyStoryArgsInPage({ storyId: fake.storyId, updates: { variant: "link", size: "lg" }, lift: ["size"], waitMs: 2000 }));
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(fake.events, ["updateStoryArgs@finished", "storyArgsUpdated@finished", "forceRemount@finished", "storyRendered@completed"]);
  assert.equal(fake.story.argTypes.size.if, undefined);
  const snapshot = await inPage(fake.preview, () => storyArgsInPage({ storyId: fake.storyId, waitMs: 100 }));
  assert.deepEqual(snapshot && "rendered" in snapshot ? snapshot.rendered : snapshot, { variant: "link", size: "lg" });
});

test("applyStoryArgsInPage: returns once the remount has finished, its afterEach included, and not before", async () => {
  // An addon's afterEach, as the a11y addon's, runs after storyRendered:
  // measured then, the story could still change under it.
  const slow = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default" }, url: {}, afterEachMs: 40 });
  const result = await inPage(slow.preview, () =>
    applyStoryArgsInPage({ storyId: slow.storyId, updates: { variant: "ghost" }, lift: [], waitMs: 2000 }));
  assert.deepEqual([result, slow.render.phase], [{ ok: true }, "finished"]);
  // One that never finishes within the time allowed is an error.
  const stuck = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default" }, url: {}, afterEachMs: Infinity });
  assert.deepEqual(await inPage(stuck.preview, () =>
    applyStoryArgsInPage({ storyId: stuck.storyId, updates: { variant: "ghost" }, lift: [], waitMs: 200 })),
  { error: "the story was still rendering with them" });
});

test("applyStoryArgsInPage: a Storybook 7 render ends at completed, or played after a play function", async () => {
  for (const sb7 of ["completed", "played"] as const) {
    const fake = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default" }, url: {}, sb7 });
    const result = await inPage(fake.preview, () =>
      applyStoryArgsInPage({ storyId: fake.storyId, updates: { variant: "ghost" }, lift: [], waitMs: 2000 }));
    assert.deepEqual(result, { ok: true }, sb7);
    assert.equal(fake.stored.variant, "ghost");
  }
});

test("applyStoryArgsInPage: a preview that never confirms is an error, not a wait forever", async () => {
  const fake = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default" }, url: {}, silent: true });
  const result = await inPage(fake.preview, () =>
    applyStoryArgsInPage({ storyId: fake.storyId, updates: { variant: "ghost" }, lift: [], waitMs: 50 }));
  assert.deepEqual(result, { error: "Storybook didn't confirm the args" });
  const busy = fakePreview({ argTypes: BADGE_TYPES, initial: {}, url: {}, phase: "rendering" });
  assert.deepEqual(await inPage(busy.preview, () => applyStoryArgsInPage({ storyId: busy.storyId, updates: {}, lift: [], waitMs: 50 })),
    { error: "the story was still rendering" });
});

/**
 * A story page measured through --selector, whose Storybook preview is
 * `preview`: the page functions run against it, and every other look at
 * the page finds nothing to report but the error Storybook shows in
 * `shown`. `warnings` are logged as it loads.
 */
function previewPage(preview: unknown, warnings: string[] = [], shown: { error: string | null } = { error: null }) {
  const { page } = measuredPage({ x: 0, y: 0, width: 40, height: 20 }, async () => Buffer.from("png"));
  const consoleListeners: ((message: { text(): string }) => void)[] = [];
  const stand = page as unknown as Record<string, unknown>;
  const evaluate = stand.evaluate as (fn: unknown, arg?: unknown) => Promise<unknown>;
  stand.on = (event: string, listener: (message: { text(): string }) => void) => { if (event === "console") consoleListeners.push(listener); };
  stand.goto = async () => {
    for (const text of warnings) for (const listener of consoleListeners) listener({ text: () => text });
    return null;
  };
  stand.evaluate = async (fn: unknown, arg?: unknown) =>
    fn === storyArgsInPage || fn === applyStoryArgsInPage
      ? inPage(preview, () => (fn as (a: unknown) => Promise<unknown>)(arg))
      : fn === storybookErrorInPage ? shown.error : evaluate(fn, arg);
  return page;
}

const STORY_OPTS = (args: Record<string, string>) => ({ ...SHOT, story: { id: "ui-base-badge--default", args } });

test("captureStory: a value the URL didn't apply is applied through the preview and measured, saying so", async () => {
  const fake = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default", size: "sm" }, url: { size: "lg" } });
  const result = await captureStory(previewPage(fake.preview), "http://localhost:6006/iframe.html?id=x", STORY_OPTS({ variant: "ghost", size: "lg" }));
  assert.equal(result.status, "ok", result.error ?? "");
  assert.equal(result.args?.appliedVia, "preview");
  assert.deepEqual(result.args?.rejected, [{ name: "variant", value: "ghost", reasons: ["not-in-options"], options: ["default", "secondary"] }]);
  assert.deepEqual(result.args?.unapplied, []);
  assert.equal(fake.stored.variant, "ghost");
  assert.equal(result.args?.storyFile, "./badge.stories.tsx");
  // A story given everything asked for is measured as it is.
  const plain = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default" }, url: { variant: "secondary" } });
  const taken = await captureStory(previewPage(plain.preview), "http://localhost:6006/iframe.html?id=x", STORY_OPTS({ variant: "secondary" }));
  assert.equal(taken.status, "ok");
  assert.deepEqual([taken.args?.rejected, taken.args?.appliedVia, plain.events], [[], undefined, []]);
});

test("captureStory: an if on a mapped arg is judged as Storybook judges it, so a value it gave isn't set again", async () => {
  const argTypes: Record<string, FakeArgType> = {
    tone: { options: ["a", "b"], mapping: { a: "loud", b: "quiet" }, type: { name: "enum" } },
    size: { options: ["sm", "lg"], if: { arg: "tone", eq: "loud" }, type: { name: "enum" } },
  };
  const fake = fakePreview({ argTypes, initial: { tone: "b", size: "sm" }, url: { tone: "a", size: "lg" } });
  const result = await captureStory(previewPage(fake.preview), "http://localhost:6006/iframe.html?id=x", STORY_OPTS({ tone: "a", size: "lg" }));
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual([result.args?.rejected, result.args?.appliedVia, fake.events], [[], undefined, []]);
});

test("captureStory: a value the preview won't apply either is arg_rejected, not the default measured as it", async () => {
  const fake = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default" }, url: {}, silent: true });
  const result = await captureStory(previewPage(fake.preview), "http://localhost:6006/iframe.html?id=x", { ...STORY_OPTS({ variant: "ghost" }), timeoutMs: 50 });
  assert.equal(result.status, "arg_rejected");
  assert.equal(result.raw, null);
  assert.equal(result.screenshot, null);
  assert.equal(result.error, "Storybook didn't give the story variant=ghost (not-in-options); through Storybook's preview, Storybook didn't confirm the args, so this variant was not measured");
  assert.deepEqual(result.args?.unapplied.map((r) => r.value), ["ghost"]);
});

test("captureStory: a story that throws on a value set through the preview is a render error, saying how it was set", async () => {
  const fake = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default" }, url: {}, remountThrows: true });
  const result = await captureStory(previewPage(fake.preview, [], fake.shown), "http://localhost:6006/iframe.html?id=x", STORY_OPTS({ variant: "ghost" }));
  assert.equal(result.status, "render_error");
  assert.equal(result.error, "TypeError: Cannot read properties of undefined (after snap set variant=ghost through Storybook's preview)");
  assert.equal(result.raw, null);
  assert.equal(result.args?.appliedVia, "preview");
});

test("captureStory: with no preview to read, Storybook's warning still rejects the value it names", async () => {
  const warning = "Received illegal value for 'variant'. Supported options: 'default', 'secondary'";
  const rejected = await captureStory(previewPage(undefined, [warning]), "http://localhost:6006/iframe.html?id=x", STORY_OPTS({ variant: "ghost" }));
  assert.equal(rejected.status, "arg_rejected");
  assert.deepEqual([rejected.args?.checked, rejected.args?.error], [false, "the page has no window.__STORYBOOK_PREVIEW__"]);
  // Without one, it is measured, and the check recorded as not made.
  const unchecked = await captureStory(previewPage(undefined), "http://localhost:6006/iframe.html?id=x", STORY_OPTS({ variant: "ghost" }));
  assert.equal(unchecked.status, "ok");
  assert.deepEqual([unchecked.args?.checked, unchecked.args?.rejected], [false, []]);
});
