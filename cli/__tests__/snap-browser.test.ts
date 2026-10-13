// Tests for the browser-bound module that need no browser: the Page is a
// stand-in, and playwright-core is never loaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";
import { fakePreview, inPage } from "./preview-standin.js";
import { compactArgTypes } from "../snap-args.js";
import type { FakeArgType } from "./preview-standin.js";
import {
  captureStory, browserInstallCommand, storybookErrorInPage, storyReadySelector, storyArgsInPage, applyStoryArgsInPage,
  captureTree, captureTreeInPage, drawingElementInPage, readStoryTreeInPage, thumbnailInPage, textFontStacksInPage, standInFontsInPage, standInsLoadedInPage, standInsMeasured,
  storiesOwnInPage, readStoriesOwn, overlaySettledInPage, triggerOpenInPage,
} from "../snap-browser.js";
import type { OpenMemory } from "../snap-browser.js";
import { SVG_DROPPED_TAGS, SVG_GEOMETRY, SVG_GROUP_PROPERTIES, SVG_PAINT_PROPERTIES, SVG_SHAPE_TAGS, THUMBNAIL_ENCODING, imageAssetId } from "../snap-assets.js";
import { RAW_TREE_LIMITS, TEXT_TREE_PROPERTIES, TREE_PROPERTY_DEFAULTS } from "../snap-tree.js";
import type { RawTreeElement, RawTreePseudo, RawTreeText } from "../snap-tree.js";
import { NON_RENDERED_TAGS, OVERLAY_SELECTOR, WRAPPER_PROPERTIES } from "../snap-normalize.js";
import { inFakePage } from "./dom-standin.js";
import { standInFamilies } from "../fonts.js";
import type { FakeElementSpec } from "./dom-standin.js";
import { overlayPage } from "./overlay-standin.js";

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
  // So does an open overlay's content, as a story that renders only an open dialog shows.
  assert.ok(selector.includes(`, ${OVERLAY_SELECTOR}, `));
  // A select's listbox included, which snap opens a select's field to show.
  assert.match(OVERLAY_SELECTOR, /\[role="dialog"\], \[role="alertdialog"\], \[role="tooltip"\], \[role="menu"\], \[role="listbox"\], \[data-slot\$="-content"\]/);
  assert.match(selector, /body\.sb-show-errordisplay, body\.sb-show-preparingstory-error$/);
  // A slot already ending in -content is not doubled.
  const tooltip = storyReadySelector(["tooltip-content", "tooltip"]);
  assert.match(tooltip, /\[data-slot="tooltip-content"\], \[data-slot="tooltip"\], \[role="dialog"\]/);
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

test("storyArgsInPage: reads the marks of an arg that changes no look, and the story's own value of each", async () => {
  const fake = fakePreview({
    argTypes: {
      open: { type: { name: "boolean" }, control: { type: "boolean" }, table: { disable: true } },
      onOpenChange: { type: { name: "function" }, action: "onOpenChange", table: { category: "events" } },
      loop: { type: { name: "boolean" }, control: false },
    },
    initial: { open: false, onOpenChange: () => {}, loop: true },
    url: {},
  });
  const snapshot = await inPage(fake.preview, () => storyArgsInPage({ storyId: fake.storyId, waitMs: 100 }));
  assert.ok(snapshot && "argTypes" in snapshot);
  assert.deepEqual(compactArgTypes(snapshot.argTypes), {
    loop: { type: "boolean", control: false, initial: true },
    onOpenChange: { type: "function", category: "events", action: true },
    open: { type: "boolean", control: "boolean", hidden: true, initial: false },
  });
});

test("storyArgsInPage: reads what the store holds, what the story is given, and its argTypes", async () => {
  const fake = fakePreview({ argTypes: BADGE_TYPES, initial: { variant: "default", size: "sm", children: "Badge" }, url: { variant: "ghost", size: "lg" } });
  const snapshot = await inPage(fake.preview, () => storyArgsInPage({ storyId: fake.storyId, waitMs: 100 }));
  assert.deepEqual(snapshot, {
    fileName: "./badge.stories.tsx",
    argTypes: {
      variant: { type: "enum", control: "select", options: ["default", "secondary"], if: undefined, mapping: undefined, hidden: undefined, category: undefined, action: undefined, initial: "default" },
      size: { type: "enum", control: undefined, options: ["sm", "lg"], if: { arg: "variant", neq: "link" }, mapping: undefined, hidden: undefined, category: undefined, action: undefined, initial: "sm" },
      children: { type: "string", control: "text", options: undefined, if: undefined, mapping: undefined, hidden: undefined, category: undefined, action: undefined, initial: "Badge" },
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

test("captureStory: a number-like value is set through the preview as the story's options type it", async () => {
  // The URL gives cols the number 2, which options of strings don't list.
  const strings = fakePreview({ argTypes: { cols: { options: ["1", "2"], type: { name: "enum" } } }, initial: { cols: "1" }, url: { cols: 2 } });
  const result = await captureStory(previewPage(strings.preview), "http://localhost:6006/iframe.html?id=x", STORY_OPTS({ cols: "2" }));
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual([result.args?.appliedVia, result.args?.rejected.map((r) => r.reasons)], ["preview", [["number-in-url"]]]);
  assert.equal(strings.stored.cols, "2");
  // A value numeric options leave out goes as a number, as the component takes it.
  const numbers = fakePreview({ argTypes: { size: { options: [1, 2, 3], type: { name: "enum" } } }, initial: { size: 1 }, url: { size: 4 } });
  const four = await captureStory(previewPage(numbers.preview), "http://localhost:6006/iframe.html?id=x", STORY_OPTS({ size: "4" }));
  assert.equal(four.status, "ok", four.error ?? "");
  assert.equal(numbers.stored.size, 4);
});

test("captureStory: a value left out of the URL is set through the preview, or rejected unread without a preview", async () => {
  const argTypes: Record<string, FakeArgType> = { tone: { options: ["plain", "Nav/Primary"], type: { name: "enum" } } };
  const opts = { ...SHOT, story: { id: "ui-base-badge--default", args: { tone: "Nav/Primary" }, notInUrl: ["tone"] } };
  const fake = fakePreview({ argTypes, initial: { tone: "plain" }, url: {} });
  const result = await captureStory(previewPage(fake.preview), "http://localhost:6006/iframe.html?id=x", opts);
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual([result.args?.appliedVia, result.args?.rejected.map((r) => r.reasons)], ["preview", [["url-unsafe"]]]);
  assert.equal(fake.stored.tone, "Nav/Primary");
  // With no preview to read, it is known not to have been given.
  const unread = await captureStory(previewPage(undefined), "http://localhost:6006/iframe.html?id=x", opts);
  assert.equal(unread.status, "arg_rejected");
  assert.deepEqual(unread.args?.unapplied.map((r) => [r.name, r.reasons]), [["tone", ["url-unsafe"]]]);
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

// --- Element trees ---

test("captureTree: what only a picture can keep is a screenshot of its element, and an image whose bytes can't be had too", async () => {
  // A 4 by 2 PNG's header is all the screenshot needs to be.
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000400000002080600000000", "hex");
  const shot: number[][] = [];
  const element = (path: number[]) => ({
    // The video, third, has no box to take a picture of by the time it is taken.
    boundingBox: async () => (path[0] === 2 ? null : { x: 0, y: 0, width: 2, height: 1 }),
    screenshot: async () => { shot.push(path); return png; },
    dispose: async () => {},
  });
  const capture = {
    root: {
      k: "e", tag: "div", box: [0, 0, 20, 10], cs: {}, path: [],
      kids: [
        { k: "e", tag: "canvas", box: [0, 0, 2, 1], cs: {}, kids: [], path: [0] },
        { k: "e", tag: "img", box: [2, 0, 2, 1], cs: {}, kids: [], path: [1], img: { src: "https://example.test/private.png", natural: [10, 5] } },
        { k: "e", tag: "video", box: [4, 0, 2, 1], cs: {}, kids: [], path: [2] },
      ],
    },
    fonts: {},
  };
  const target = {
    evaluate: async (fn: unknown) => { assert.equal(fn, captureTreeInPage); return capture; },
    evaluateHandle: async (_fn: unknown, path: number[]) => ({ asElement: () => element(path), dispose: async () => {} }),
  };
  const page = {
    context: () => ({ request: { get: async () => { throw new Error("401"); } } }),
    evaluate: async () => { throw new Error("TypeError: Failed to fetch"); },
  };
  const tree = await captureTree(page as unknown as Page, target as never, null, 1000);
  const id = imageAssetId(png, "raster:0,0,4,2");
  assert.deepEqual(tree.nodes.slice(1).map((n) => [n.k, n.t, n.raster, n.img]), [["canvas", "I", 1, id], ["img", "I", 1, id], ["video", "F", undefined, undefined]]);
  // Nothing to keep a picture of: a frame its size, saying so.
  assert.equal(tree.nodes[3].approx, "raster-unavailable");
  assert.deepEqual(shot, [[1], [0]]);
  assert.deepEqual(Object.keys(tree.images), [id]);
  assert.equal(tree.images[id].raster, true);
  assert.deepEqual(tree.images[id].natural, [4, 2]);
});

test("captureTree: an image's bytes from the page's own response, its id from them and its crop", async () => {
  const bytes = Buffer.from("ffd8ffe000104a464946", "hex");
  const capture = {
    root: {
      k: "e", tag: "span", box: [0, 0, 32, 32], cs: {}, path: [],
      kids: [{ k: "e", tag: "img", box: [0, 0, 32, 32], cs: { "object-fit": "cover" }, kids: [], path: [0], img: { src: "https://example.test/a.jpg", natural: [460, 460] } }],
    },
    fonts: {},
  };
  const target = { evaluate: async () => capture };
  const responses = { body: (url: string) => (url === "https://example.test/a.jpg" ? Promise.resolve(bytes) : undefined), stop: () => {} };
  const tree = await captureTree({} as Page, target as never, responses, 1000);
  const id = imageAssetId(bytes, "0,0,460,460");
  assert.equal(tree.nodes[1].img, id);
  assert.deepEqual({ ...tree.images[id], bytes: undefined }, { bytes: undefined, mime: "image/jpeg", natural: [460, 460], crop: { src: [0, 0, 460, 460], dst: [0, 0, 1, 1], key: "0,0,460,460" }, box: [32, 32] });
});

test("captureTree: an image whose bytes throw as they are read is a screenshot of it, not a variant that failed", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000400000002080600000000", "hex");
  const capture = {
    root: {
      k: "e", tag: "span", box: [0, 0, 32, 32], cs: {}, path: [],
      kids: [{ k: "e", tag: "img", box: [0, 0, 32, 32], cs: {}, kids: [], path: [0], img: { src: "https://example.test/a.jpg", natural: [460, 460] } }],
    },
    fonts: {},
  };
  const target = {
    evaluate: async () => capture,
    evaluateHandle: async () => ({
      asElement: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 4, height: 2 }), screenshot: async () => png, dispose: async () => {} }),
      dispose: async () => {},
    }),
  };
  const responses = { body: () => { throw new Error("the response went away"); }, stop: () => {} };
  const tree = await captureTree({} as Page, target as never, responses, 1000);
  assert.deepEqual([tree.nodes[1].t, tree.nodes[1].raster, tree.nodes[1].img], ["I", 1, imageAssetId(png, "raster:0,0,4,2")]);
});

test("captureStory: with a tree, a variant whose tree can't be read is not measured, rather than built as its base", async () => {
  // The variant would otherwise have no treeDelta, which reads as the base's tree.
  const { page } = measuredPage({ x: 0, y: 0, width: 10, height: 10 }, async () => Buffer.from("png"));
  const result = await captureStory(page, "http://localhost:6006/iframe.html?id=x--y", { ...OPTS, selector: "#storybook-root > div", tree: "tree" });
  assert.equal(result.status, "render_error");
  assert.match(result.error!, /element tree/);
});

/** A StoryNode as readStoryTreeInPage reads one: `tag` with `slot`, drawn, holding `children`. */
function storyNode(tag: string, slot: string | null, children: object[] = []) {
  return {
    tag, slot, role: null, hasPopup: null, expanded: null, controls: null, state: null, open: false, dir: null, orientation: null, label: null,
    position: "static", rendered: true, styles: {}, children,
  };
}

test("captureStory: with a tree, a root that draws nothing gives way to the nearest one that does, its images' bytes from the page's own responses", async () => {
  // The Toaster's own element draws nothing and holds nothing that does;
  // the element around it draws. Its photo answered from another URL,
  // which the <img> doesn't name.
  const bytes = Buffer.from("ffd8ffe000104a464946", "hex");
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const capture = {
    root: {
      k: "e", tag: "div", box: [0, 0, 64, 64], cs: { "background-color": "rgb(250, 250, 250)" }, path: [],
      kids: [{ k: "e", tag: "img", box: [16, 16, 32, 32], cs: { "object-fit": "cover" }, kids: [], path: [0], img: { src: "https://example.test/photo", natural: [460, 460] } }],
    },
    fonts: {},
  };
  let described = false;
  const around = {
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === captureTreeInPage) return capture;
      // Whether it is the element it climbed from; then its description; then its font stack.
      if (arg !== undefined) return false;
      if (described) return null;
      described = true;
      return { tag: "div", slot: "toaster-viewport", role: null };
    },
    evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
    boundingBox: async () => ({ x: 0, y: 0, width: 64, height: 64 }),
  };
  const own = {
    evaluateHandle: async (fn: unknown) => {
      assert.equal(fn, drawingElementInPage);
      return { asElement: () => around, dispose: async () => {} };
    },
  };
  const container = {
    evaluate: async (_fn: unknown, arg: unknown) => (Array.isArray(arg) ? true : storyNode("div", null, [storyNode("section", "toaster")])),
    evaluateHandle: async () => ({ asElement: () => own, dispose: async () => {} }),
  };
  const response = {
    status: () => 200,
    body: async () => bytes,
    request: () => ({
      resourceType: () => "image",
      url: () => "https://avatars.example.test/u/1",
      redirectedFrom: () => ({ url: () => "https://example.test/photo", redirectedFrom: () => null }),
    }),
  };
  const page = {
    on: (event: string, fn: (payload: unknown) => void) => listeners.set(event, (listeners.get(event) ?? new Set()).add(fn)),
    off: (event: string, fn: (payload: unknown) => void) => listeners.get(event)?.delete(fn),
    goto: async () => {
      for (const fn of listeners.get("response") ?? []) fn(response);
      return null;
    },
    waitForSelector: async () => null,
    addStyleTag: async () => null,
    $: async (selector: string) => (selector === "#storybook-root" ? container : null),
    evaluateHandle: async () => ({ evaluate: async () => [], dispose: async () => {} }),
    // Nothing else reaches the photo: not a request of snap's own, nor a fetch in the page.
    context: () => ({ request: { get: async () => { throw new Error("offline"); } } }),
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === storybookErrorInPage) return null;
      if (typeof arg === "string") throw new Error("TypeError: Failed to fetch");
      return Array.isArray(arg) && Array.isArray(arg[1]) ? {} : null;
    },
  };
  const result = await captureStory(page as unknown as Page, "http://localhost:6006/iframe.html?id=ui-toaster--default", {
    ...OPTS, component: { name: "Toaster", title: "ui/Toaster" }, tree: "tree",
  });
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual([result.climbedFrom, result.element], ['section[data-slot="toaster"]', 'div[data-slot="toaster-viewport"]']);
  assert.equal(result.tree!.nodes[1].img, imageAssetId(bytes, "0,0,460,460"));
  // Listening only while it captured.
  assert.equal(listeners.get("response")?.size, 0);
});

test("captureStory: a story that renders only an open dialog, into a portal, measures the dialog and says it came from one", async () => {
  // coder's ConfirmDialog: Radix's Dialog, open with no trigger, renders
  // nothing under the story's root; its content, role=dialog, is a child of
  // the body. It was element_not_found in every variant.
  const capture = {
    root: { k: "e", tag: "div", box: [0, 0, 512, 180], cs: { "background-color": "rgb(255, 255, 255)", position: "fixed" }, path: [], kids: [], role: "dialog" },
    fonts: {},
  };
  const dialog = {
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === captureTreeInPage) return capture;
      // Whether it is the element it climbed from: it is, as it draws.
      if (arg !== undefined) return true;
      return null;
    },
    evaluateHandle: async () => ({ asElement: () => dialog, dispose: async () => {} }),
    boundingBox: async () => ({ x: 384, y: 270, width: 512, height: 180 }),
  };
  let found: unknown = null;
  const portals = {
    // Radix's backdrop first, which is no overlay content, then the dialog.
    evaluate: async () => [
      { tag: "div", slot: null, role: null, id: null, rendered: true, overlay: false },
      { tag: "div", slot: null, role: "dialog", id: "radix-r1", rendered: true, overlay: true },
    ],
    evaluateHandle: async (_fn: unknown, index: unknown) => ({ asElement: () => (index === 1 ? dialog : null), dispose: async () => {} }),
    dispose: async () => {},
  };
  const container = {
    // Holds nothing: Radix put the dialog in the body.
    evaluate: async (_fn: unknown, arg: unknown) => (Array.isArray(arg) ? false : storyNode("div", null, [])),
  };
  const page = {
    ...LISTENS,
    goto: async () => null,
    waitForSelector: async (selector: string) => {
      assert.ok(selector.includes('[role="dialog"]'), "the wait ends on the open dialog");
      return null;
    },
    addStyleTag: async () => null,
    $: async (selector: string) => (selector === "#storybook-root" ? container : null),
    evaluateHandle: async (_fn: unknown, arg: unknown) => {
      found = arg;
      return portals;
    },
    evaluate: async (fn: unknown) => (fn === storybookErrorInPage ? null : {}),
  };
  const result = await captureStory(page as unknown as Page, "http://localhost:6006/iframe.html?id=components-dialog-confirmdialog--example", {
    ...OPTS, component: { name: "ConfirmDialog", title: "components/Dialog/ConfirmDialog" }, tree: "tree",
  });
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual([result.element, result.matchedSelector, result.portal], ['div[role="dialog"]', 'portal div[role="dialog"]', true]);
  assert.deepEqual(found, { container, slots: ["confirm-dialog", "confirm-dialog-content"], overlay: OVERLAY_SELECTOR });
  assert.deepEqual(result.tree!.nodes.map((n) => n.k), [""]);
});

test("readStoryTreeInPage: reads each element's own text, outline, and the ::before and ::after that have content", () => {
  // An icon font draws its glyph with ::before alone: the story's root
  // holds no text and paints nothing else, yet it shows.
  const read = inFakePage({
    tag: "div", rect: [0, 0, 100, 40], attrs: { id: "storybook-root" },
    kids: [
      { tag: "span", rect: [0, 0, 24, 24], before: { content: '"★"', display: "inline-block" } },
      { tag: "div", rect: [0, 30, 40, 10], attrs: { id: "menu-1" }, style: { "outline-style": "solid", "outline-width": "2px", "outline-color": "rgb(255, 0, 0)" }, after: { content: "none" }, kids: [{ text: "  ", rects: [] }] },
    ],
  }, (el) => readStoryTreeInPage(el, { props: WRAPPER_PROPERTIES, maxDepth: 12, maxNodes: 600 }));
  const [glyph, ring] = read.children;
  // Its id, which an open trigger's aria-controls may name, inline.
  assert.deepEqual([glyph.id, ring.id], [null, "menu-1"]);
  assert.deepEqual([glyph.text, glyph.pseudos?.map((p) => [p.content, p.styles.display])], [false, [['"★"', "inline-block"]]]);
  assert.deepEqual([ring.text, ring.pseudos, ring.styles["outline-style"], ring.styles["outline-width"]], [false, undefined, "solid", "2px"]);
  assert.equal(read.pseudos, undefined);
});

// --- captureTreeInPage, in a stand-in page ---

/** captureTreeInPage's arguments, as captureTree passes them. */
const TREE_ARGS: Parameters<typeof captureTreeInPage>[1] = {
  mode: "tree", defaults: { ...TREE_PROPERTY_DEFAULTS }, textProperties: TEXT_TREE_PROPERTIES, ...RAW_TREE_LIMITS,
  svgShapes: SVG_SHAPE_TAGS, svgGeometry: SVG_GEOMETRY, svgPaint: SVG_PAINT_PROPERTIES, svgGroup: SVG_GROUP_PROPERTIES, svgDropped: SVG_DROPPED_TAGS, nonRendered: NON_RENDERED_TAGS,
};

const readTree = (root: FakeElementSpec, args: Partial<typeof TREE_ARGS> = {}, moves: Parameters<typeof inFakePage>[2] = []) =>
  inFakePage(root, (el) => captureTreeInPage(el, { ...TREE_ARGS, ...args }), moves);

test("captureTreeInPage: sends only what differs from a default, and nothing a property doesn't apply to", () => {
  const raw = readTree({
    tag: "div", rect: [0, 0, 100, 40],
    style: { display: "flex", "border-top-width": "1px", "border-top-style": "solid", "border-top-color": "rgb(229, 229, 229)", "border-left-color": "rgb(1, 2, 3)", "background-size": "cover", "object-fit": "cover", appearance: "button", "box-sizing": "border-box" },
  });
  assert.deepEqual(raw.root.cs, { display: "flex", "border-top-width": "1px", "border-top-color": "rgb(229, 229, 229)" });
});

test("captureTreeInPage: reads what makes an element hold the fixed and absolute elements in it, a translate as a transform", () => {
  // Base UI's Slider thumb: `translate`, not `transform`, holds its `fixed` input.
  const holds = { translate: "-50% -50%", rotate: "5deg", scale: "1.1", perspective: "100px", "offset-path": 'path("M 0 0")', "will-change": "transform", contain: "paint", "content-visibility": "auto", "transform-style": "preserve-3d" };
  assert.deepEqual(readTree({ tag: "div", rect: [0, 0, 16, 16], style: { ...holds, "box-sizing": "border-box" } }).root.cs, holds);
});

test("captureTreeInPage: for an overlay's content, reads what is around it, innermost first, which places it", () => {
  // Radix's popper wrapper around a tooltip's content, in a portal holder.
  const page = {
    tag: "div", rect: [0, 0, 1280, 720] as [number, number, number, number], style: { "z-index": "50", "box-sizing": "border-box" },
    kids: [{ tag: "div", rect: [590, 300, 100, 28] as [number, number, number, number], style: { position: "fixed", transform: "matrix(1, 0, 0, 1, 590, 300)", "box-sizing": "border-box" },
      kids: [{ tag: "div", rect: [590, 300, 100, 28] as [number, number, number, number], attrs: { "data-slot": "tooltip-content" } }] }],
  };
  const content = (root: Element) => root.children[0].children[0];
  const read = inFakePage(page, (el) => captureTreeInPage(el, { ...TREE_ARGS, around: true }), [], content);
  assert.deepEqual(read.around, [{ position: "fixed", transform: "matrix(1, 0, 0, 1, 590, 300)" }, { "z-index": "50" }]);
  // Not for any other root.
  assert.equal(inFakePage(page, (el) => captureTreeInPage(el, TREE_ARGS), [], content).around, undefined);
});

test("captureTreeInPage: an element a rotate or scale of its own turns gives its own size, an svg its CSS size", () => {
  const read = readTree({
    tag: "span", rect: [0, 0, 10, 10], style: { "box-sizing": "border-box" },
    kids: [
      { tag: "svg", rect: [-2.07, -9.07, 14.14, 14.14], style: { rotate: "45deg", width: "10px", height: "10px", "box-sizing": "border-box" } },
      { tag: "div", rect: [0, 0, 15, 15], offset: [10, 10], style: { scale: "1.5", "box-sizing": "border-box" } },
      { tag: "div", rect: [0, 0, 10, 10], style: { rotate: "0deg", "box-sizing": "border-box" } },
    ],
  });
  assert.deepEqual(read.root.kids.map((k) => (k as RawTreeElement).size), [[10, 10], [10, 10], undefined]);
});

test("captureTreeInPage: a pseudo-element that draws, though its color's last channel is 0, and none that is transparent", () => {
  // rgb(255, 165, 0) is orange: read as transparent, its ::after went missing.
  const raw = readTree({
    tag: "div", rect: [0, 0, 100, 40], style: { position: "relative", "border-left-width": "2px" },
    before: { content: '""', position: "absolute", "background-color": "rgba(0, 0, 0, 0)" },
    after: { content: '""', position: "absolute", "background-color": "rgb(255, 165, 0)", left: "4px", top: "6px", width: "10px", height: "12px", "box-sizing": "border-box" },
  });
  assert.deepEqual(raw.root.kids.map((k) => (k as RawTreePseudo).which), ["after"]);
  const after = raw.root.kids[0] as RawTreePseudo;
  // In its parent's padding box: inside the 2px border.
  assert.deepEqual([after.how, after.box, after.unanchored], ["abs", [6, 6, 10, 12], undefined]);
  const loose = readTree({ tag: "div", rect: [0, 0, 100, 40], after: { content: '""', position: "absolute", "background-color": "oklch(0.5 0.1 30 / 0.5)" } });
  assert.equal((loose.root.kids[0] as RawTreePseudo).unanchored, true);
  assert.equal(readTree({ tag: "div", rect: [0, 0, 1, 1], after: { content: '""', "background-color": "oklab(0 0 0 / 0)" } }).root.kids.length, 0);
});

test("captureTreeInPage: an absolute pseudo-element is where its transform moves it", () => {
  // after:left-1/2 after:w-2.5 after:-translate-x-1/2 in a 40px box draws at 15, not 20.
  const at = (transform: string) => {
    const raw = readTree({
      tag: "div", rect: [0, 0, 40, 10], style: { position: "relative" },
      after: { content: '""', position: "absolute", "background-color": "rgb(255, 0, 0)", left: "20px", top: "0px", width: "10px", height: "10px", "box-sizing": "border-box", transform },
    });
    const after = raw.root.kids[0] as RawTreePseudo;
    return [after.box, after.cs.transform];
  };
  assert.deepEqual(at("matrix(1, 0, 0, 1, -5, 0)"), [[15, 0, 10, 10], "matrix(1, 0, 0, 1, -5, 0)"]);
  assert.deepEqual(at("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 2, 0, 1)"), [[15, 2, 10, 10], "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 2, 0, 1)"]);
  // Turned about its middle: where its insets put it, its transform kept for snap-tree.ts.
  assert.deepEqual(at("matrix(0, 1, -1, 0, 0, 0)"), [[20, 0, 10, 10], "matrix(0, 1, -1, 0, 0, 0)"]);
});

test("captureTreeInPage: a pseudo-element in the flow is measured on a stand-in, which is gone after, and says when it moved a sibling", () => {
  const sibling: FakeElementSpec = { tag: "b", rect: [10, 0, 20, 20] };
  const root: FakeElementSpec = {
    tag: "p", rect: [0, 0, 100, 20], kids: [sibling],
    before: { content: '"→"', display: "inline-block", "background-color": "rgb(255, 0, 0)", standIn: "[0,2,10,16]" },
  };
  const raw = readTree(root, {}, [[sibling, [12, 0, 20, 20]]]);
  const before = raw.root.kids[0] as RawTreePseudo;
  assert.deepEqual([before.how, before.box, before.content, before.moved], ["flow", [0, 2, 10, 16], "→", true]);
  assert.equal(before.text?.["font-family"], "Times");
  assert.equal(inFakePage(root, (el) => { captureTreeInPage(el, TREE_ARGS); return (el as unknown as { outerHTML: string }).outerHTML; }), "<p><b></b></p>");
});

test("captureTreeInPage: display: contents gives its children to its parent; what isn't drawn isn't read", () => {
  const raw = readTree({
    tag: "div", rect: [0, 0, 100, 40],
    kids: [
      { tag: "span", rect: [0, 0, 0, 0], style: { display: "contents", color: "rgb(255, 0, 0)" }, kids: [{ text: "red", rects: [[0, 0, 20, 20]] }, { tag: "i", rect: [20, 0, 10, 20] }] },
      { tag: "div", rect: [0, 0, 10, 10], style: { display: "none" } },
      { tag: "div", rect: [0, 0, 10, 10], style: { opacity: "0" } },
      { tag: "style", rect: [0, 0, 0, 0] },
      { text: "  ", rects: [] },
    ],
  });
  assert.deepEqual(raw.root.kids.map((k) => (k.k === "e" ? k.tag : k.k === "t" ? k.text : k.k)), ["red", "i"]);
  // The run is drawn in the contents element's style; the element's path,
  // by element children, goes through it.
  assert.equal((raw.root.kids[0] as RawTreeText).style?.color, "rgb(255, 0, 0)");
  assert.deepEqual((raw.root.kids[1] as RawTreeElement).path, [0, 0]);
});

test("captureTreeInPage: stops reading at its limits, saying where", () => {
  const kids = Array.from({ length: 5 }, (_, i): FakeElementSpec => ({ tag: "div", rect: [0, i, 1, 1] }));
  const raw = readTree({ tag: "div", rect: [0, 0, 1, 5], kids }, { maxElements: 3 });
  assert.deepEqual(raw.root.kids.map((k) => k.k), ["e", "e", "cut"]);
  const deep = readTree({ tag: "div", rect: [0, 0, 1, 1], kids: [{ tag: "div", rect: [0, 0, 1, 1], kids: [{ tag: "div", rect: [0, 0, 1, 1] }] }] }, { maxDepth: 1 });
  assert.deepEqual((deep.root.kids[0] as RawTreeElement).kids, [{ k: "cut" }]);
});

test("captureTreeInPage: an SVG as structure and computed paint, its painted shapes' boxes, or its size when too big", () => {
  const path: FakeElementSpec = { tag: "path", svg: true, attrs: { d: "M0 0h4", class: "x" }, rect: [12, 12, 8, 0], style: { stroke: "currentcolor", color: "rgb(10, 10, 10)", fill: "none" } };
  const hidden: FakeElementSpec = { tag: "path", svg: true, attrs: { d: "M1 1" }, rect: [10, 10, 1, 1], style: { fill: "none" } };
  const group: FakeElementSpec = { tag: "g", svg: true, attrs: { transform: "translate(1 1)" }, rect: [0, 0, 0, 0], style: { opacity: "0.3" } };
  const svg: FakeElementSpec = {
    tag: "svg", svg: true, attrs: { viewBox: "0 0 24 24", class: "lucide lucide-x size-4", width: "24" }, rect: [10, 10, 16, 16],
    kids: [{ tag: "title", svg: true, rect: [0, 0, 0, 0] }, path, hidden, { tag: "defs", svg: true, rect: [0, 0, 0, 0] }, group],
  };
  const raw = readTree({ tag: "button", rect: [0, 0, 36, 36], kids: [svg] });
  const icon = raw.root.kids[0] as RawTreeElement;
  assert.equal(icon.lucide, "lucide-x");
  assert.deepEqual(icon.svg!.attrs, { viewBox: "0 0 24 24" });
  assert.deepEqual(icon.svg!.kids!.map((k) => [k.tag, k.raw === undefined]), [["path", true], ["path", true], ["defs", false], ["g", true]]);
  // A group's own opacity and effects, which its shapes' computed style can't show.
  assert.deepEqual(icon.svg!.kids![3], { tag: "g", attrs: { transform: "translate(1 1)" }, paint: { opacity: "0.3", "clip-path": "none", mask: "none", filter: "none" }, kids: [] });
  assert.equal(icon.svg!.kids![0].paint!.stroke, "rgb(10, 10, 10)");
  // Only what paints, relative to the svg's box.
  assert.deepEqual(icon.shapes, [[2, 2, 8, 0]]);
  const big = readTree({ tag: "div", rect: [0, 0, 36, 36], kids: [svg] }, { maxSvgElements: 2 });
  assert.equal((big.root.kids[0] as RawTreeElement).svgElements, 5);
});

test("captureTreeInPage: an input's value or placeholder, with how wide it draws; an image's source", () => {
  const raw = readTree({
    tag: "div", rect: [0, 0, 300, 40],
    kids: [
      { tag: "input", attrs: { placeholder: "Email" }, rect: [0, 0, 200, 36], placeholderColor: "rgb(115, 115, 115)" },
      { tag: "img", attrs: { src: "https://example.test/a.png" }, rect: [200, 0, 40, 40], natural: [80, 80], style: { "object-fit": "cover" } },
    ],
  });
  const [input, img] = raw.root.kids as RawTreeElement[];
  assert.deepEqual(input.input, { type: "text", value: "", placeholder: "Email", advance: 35, placeholderColor: "rgb(115, 115, 115)" });
  // A select: its chosen option's label, its options not walked, its appearance read.
  const chosen = readTree({
    tag: "div", rect: [0, 0, 300, 40],
    kids: [{ tag: "select", rect: [0, 0, 120, 36], kids: [{ tag: "option", rect: [0, 0, 0, 0], kids: [{ text: "Apple", rects: [] }] }, { tag: "option", attrs: { selected: "" }, rect: [0, 0, 0, 0], kids: [{ text: "Banana", rects: [] }] }] }],
  });
  const select = chosen.root.kids[0] as RawTreeElement;
  assert.deepEqual([select.input, select.kids, select.cs.appearance], [{ type: "select", value: "Banana", placeholder: "", advance: 42 }, [], "auto"]);
  assert.equal(input.text?.color, "rgb(0, 0, 0)");
  assert.deepEqual(img.img, { src: "https://example.test/a.png", natural: [80, 80] });
  assert.deepEqual(img.cs, { "box-sizing": "content-box", "object-fit": "cover" });
});

/**
 * thumbnailInPage run against a stand-in canvas whose pixels are `pixels`
 * (RGBA, row by row), recording what it drew and how it encoded it.
 */
async function drawThumbnail(pixels: number[], args: Omit<Parameters<typeof thumbnailInPage>[0], "encoding">) {
  const scope = globalThis as Record<string, unknown>;
  const saved = { Image: scope.Image, document: scope.document };
  const drawn: number[][] = [];
  const encoded: unknown[][] = [];
  scope.Image = class { src = ""; async decode() {} };
  scope.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage: (...a: unknown[]) => drawn.push(a.slice(1) as number[]), getImageData: () => ({ data: Uint8ClampedArray.from(pixels) }) }),
      toDataURL: (mime: string, quality: number) => { encoded.push([mime, quality]); return `data:${mime};base64,AAAA`; },
    }),
  };
  try {
    return { result: await thumbnailInPage({ ...args, encoding: THUMBNAIL_ENCODING }), drawn, encoded };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete scope[k];
      else scope[k] = v;
    }
  }
}

test("thumbnailInPage: what the box shows, drawn at the thumbnail's size, a JPEG where it is opaque and a PNG where it isn't", async () => {
  const args = { url: "data:image/png;base64,AAAA", src: [0, 0, 400, 200] as [number, number, number, number], dst: [0, 0.25, 1, 0.5] as [number, number, number, number], size: [64, 64] as [number, number] };
  const opaque = await drawThumbnail([10, 20, 30, 255, 40, 50, 60, 255], args);
  assert.deepEqual(opaque.drawn, [[0, 0, 400, 200, 0, 16, 64, 32]]);
  assert.deepEqual([opaque.result, opaque.encoded], [{ mime: "image/jpeg", base64: "AAAA" }, [["image/jpeg", 0.85]]]);
  // A letterboxed contain leaves pixels clear: a JPEG would turn them black.
  const clear = await drawThumbnail([10, 20, 30, 255, 0, 0, 0, 0], args);
  assert.deepEqual([clear.result.mime, clear.encoded[0][0]], ["image/png", "image/png"]);
});

test("drawingElementInPage: an element that draws nothing, holding nothing that does, gives way to the nearest one around it that draws", () => {
  const empty: FakeElementSpec = { tag: "section", rect: [0, 0, 0, 0] };
  const story: FakeElementSpec = {
    tag: "div", attrs: { id: "storybook-root" }, rect: [0, 0, 300, 100],
    kids: [{ tag: "div", rect: [0, 0, 300, 100], style: { "background-color": "rgb(250, 250, 250)" }, kids: [{ tag: "div", rect: [0, 0, 300, 100], kids: [empty] }] }],
  };
  const pick = (target: (root: Element) => Element) =>
    inFakePage(story, (el) => (drawingElementInPage(el, ["#storybook-root", "#root"]) as unknown as { tagName: string; spec: FakeElementSpec }).spec, [], target);
  const deepest = (root: Element) => (root as unknown as { children: Element[] }).children[0].children[0].children[0];
  // Past the wrapper that draws nothing too, to the one with a fill.
  assert.equal(pick(deepest), story.kids![0]);
  // One that draws stays.
  const drawing = (root: Element) => (root as unknown as { children: Element[] }).children[0];
  assert.equal(pick(drawing), story.kids![0]);
  // Nothing around it draws: it stays, never past the story's root.
  const bare: FakeElementSpec = { tag: "div", attrs: { id: "storybook-root" }, rect: [0, 0, 1, 1], kids: [{ tag: "span", rect: [0, 0, 0, 0] }] };
  const span = inFakePage(bare, (el) => (drawingElementInPage(el, ["#storybook-root"]) as unknown as { spec: FakeElementSpec }).spec, [], (root) => (root as unknown as { children: Element[] }).children[0]);
  assert.equal(span, bare.kids![0]);
});

// --- Stand-in fonts --------------------------------------------------------------

const SANS = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji"';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
/** A story whose root inherits Tailwind's sans stack, a code sample its mono one, and a heading Geist. */
const STACKS: FakeElementSpec = {
  tag: "html", rect: [0, 0, 1280, 720], style: { "font-family": SANS }, kids: [
    { tag: "body", rect: [0, 0, 1280, 720], style: { "font-family": SANS }, kids: [
      { tag: "code", rect: [0, 0, 80, 20], style: { "font-family": MONO } },
      { tag: "h1", rect: [0, 20, 80, 20], style: { "font-family": "Geist, sans-serif" } },
    ] },
  ],
};

const SERIF = "ui-serif, Georgia, serif";
/**
 * A story's page: html and body in Chrome's default Times, holding no text
 * of their own; Storybook's error display, hidden while the story shows;
 * and the story, its button in Tailwind's sans stack, a code sample in its
 * mono one, a heading in Geist, a field in a serif and a bullet a ::before
 * draws in a rounded face.
 */
const TEXT_PAGE: FakeElementSpec = {
  tag: "html", rect: [0, 0, 1280, 720], kids: [
    { tag: "body", rect: [0, 0, 1280, 720], kids: [
      { tag: "div", attrs: { class: "sb-errordisplay sb-wrapper" }, rect: [0, 0, 0, 0], style: { "font-family": '"Nunito Sans", -apple-system, sans-serif' }, kids: [{ text: "No Preview", rects: [] }] },
      { tag: "div", attrs: { id: "storybook-root" }, rect: [0, 0, 1280, 140], style: { "font-family": SANS }, kids: [
        { tag: "button", rect: [0, 0, 80, 20], style: { "font-family": SANS }, kids: [{ text: "Save", rects: [[8, 2, 30, 16]] }] },
        { tag: "code", rect: [0, 20, 80, 20], style: { "font-family": MONO }, kids: [{ text: "pnpm i", rects: [[0, 22, 40, 16]] }] },
        { tag: "h1", rect: [0, 40, 80, 20], style: { "font-family": "Geist, sans-serif" }, kids: [{ text: "Title", rects: [[0, 42, 40, 16]] }] },
        // Whitespace between tags is no text.
        { tag: "div", rect: [0, 60, 80, 20], style: { "font-family": "Arial" }, kids: [{ text: "\n  ", rects: [[0, 60, 4, 16]] }] },
        { tag: "input", rect: [0, 80, 80, 20], style: { "font-family": SERIF }, value: "Ada" },
        { tag: "li", rect: [0, 100, 80, 20], style: { "font-family": SANS }, before: { content: '"•"', "font-family": "ui-rounded, sans-serif" } },
        // An empty ::before draws nothing.
        { tag: "i", rect: [0, 120, 80, 20], before: { content: '""', "font-family": "fantasy" } },
      ] },
    ] },
  ],
};

test("textFontStacksInPage: the stack of each text the page draws, once, in document order; none of a page's that draws no text", () => {
  assert.deepEqual(inFakePage(TEXT_PAGE, (el) => textFontStacksInPage(el)), [SANS, MONO, "Geist, sans-serif", SERIF, "ui-rounded, sans-serif"]);
});

test("standInsLoadedInPage: loads only the faces snap added, and waits for them no longer than it is given", { timeout: 10_000 }, async () => {
  const loads: string[] = [];
  const face = (family: string, settles: boolean) => ({
    family, load: () => { loads.push(family); return settles ? Promise.resolve() : new Promise(() => {}); },
  });
  const scope = globalThis as Record<string, unknown>;
  const saved = { document: scope.document, requestAnimationFrame: scope.requestAnimationFrame };
  scope.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  try {
    // A face the project declares and nothing draws in is not fetched.
    scope.document = { fonts: [face('"storysync Inter"', true), face("Geist", true), face("storysync Roboto Mono", true)] };
    await standInsLoadedInPage({ prefix: "storysync ", ms: 100 });
    assert.deepEqual(loads, ['"storysync Inter"', "storysync Roboto Mono"]);
    // One that never loads holds the capture only as long as it is given.
    scope.document = { fonts: [face("storysync Inter", false)] };
    const started = Date.now();
    await standInsLoadedInPage({ prefix: "storysync ", ms: 50 });
    assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started}ms`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete scope[k];
      else scope[k] = v;
    }
  }
});

test("captureStory: sends only the stand-ins the story's text needs, none for a story in the project's own font, and waits for them within the image wait", async () => {
  for (const [stacks, want] of [
    [["Geist, sans-serif"], []],
    [[SANS, "Geist, sans-serif"], ["Inter"]],
    [[MONO, SANS], ["Inter", "Roboto Mono"]],
  ] as const) {
    const { page } = measuredPage({ x: 0, y: 0, width: 10, height: 10 }, async () => Buffer.from(""));
    const stand = page as unknown as { evaluate: (fn: unknown, arg?: unknown) => Promise<unknown> };
    const evaluate = stand.evaluate;
    const sent: [unknown, unknown][] = [];
    stand.evaluate = async (fn, arg) => {
      if (fn === textFontStacksInPage) return stacks;
      if (fn === standInFontsInPage || fn === standInsLoadedInPage) {
        sent.push([fn, arg]);
        return 1;
      }
      return evaluate(fn, arg);
    };
    const result = await captureStory(page, "http://localhost:6006/iframe.html?id=x--default", { ...OPTS, timeoutMs: 60_000, selector: "#storybook-root > div" });
    assert.equal(result.status, "ok", result.error ?? "");
    if (!want.length) {
      assert.deepEqual(sent, [], stacks.join(" | "));
      continue;
    }
    const [[drawFn, drawArg], [waitFn, waitArg]] = sent;
    assert.equal(drawFn, standInFontsInPage);
    const { faces } = drawArg as { faces: { family: string }[] };
    // Inter's two families, its Latin faces and its other scripts (fonts.ts), and Roboto Mono's one.
    assert.deepEqual([...new Set(faces.map((f) => f.family))].sort(), want.flatMap((s) => standInFamilies(s)).sort());
    assert.equal(waitFn, standInsLoadedInPage);
    assert.deepEqual(waitArg, { prefix: "storysync ", ms: 5000 });
  }
});

test("standInFontsInPage: an element on a stack Figma sets in a stand-in gets the stand-in ahead of it, inline and important", () => {
  const stacks = { [SANS]: `"storysync Inter", ${SANS}`, [MONO]: `"storysync Roboto Mono", ${MONO}` };
  const set = inFakePage(STACKS, (el) => {
    const changed = standInFontsInPage({ stacks, faces: [] }, el);
    const all: { tagName: string; style: { values: Record<string, string> } }[] = [];
    const walk = (n: unknown) => {
      const e = n as { tagName: string; style: { values: Record<string, string> }; children: unknown[] };
      all.push(e);
      e.children.forEach(walk);
    };
    walk(el);
    return { changed, fonts: all.map((e) => [e.tagName, e.style.values["font-family"] ?? null]) };
  });
  // The page reads each element after those before it change: in a browser
  // body would inherit html's new stack and be left alone; here it declares its own.
  assert.equal(set.changed, 3);
  assert.deepEqual(set.fonts, [
    ["HTML", `"storysync Inter", ${SANS}`], ["BODY", `"storysync Inter", ${SANS}`],
    ["CODE", `"storysync Roboto Mono", ${MONO}`], ["H1", null],
  ]);
});

test("standInsMeasured: each family the capture drew in a stand-in, asked and drawn, from its fonts and its tree's texts", () => {
  const probe = { families: ["storysync Inter", "ui-sans-serif", "system-ui"], applied: [true, false, null] as (boolean | null)[] };
  const nodes = [
    { k: "", t: "F", el: "div", box: [0, 0, 1, 1] },
    { k: "a", t: "T", el: "#text", box: [0, 0, 1, 1], tx: { c: "x", f: "Roboto Mono", fs: "Menlo", sz: 12, wt: 400, col: null, lh: "normal", n: 1, ink: [0, 0, 1, 1] } },
    { k: "b", t: "T", el: "#text", box: [0, 0, 1, 1], tx: { c: "y", f: "Geist", sz: 12, wt: 400, col: null, lh: "normal", n: 1, ink: [0, 0, 1, 1] } },
  ] as never;
  assert.deepEqual(standInsMeasured({ root: probe, text: probe }, { nodes }), [["Menlo", "Roboto Mono"], ["system-ui", "Inter"]]);
  assert.deepEqual(standInsMeasured({ root: null, text: { families: ["Geist"], applied: [true] } }), []);
});

// --- Each story's own annotations (snap-stories.ts) -------------------------------

test("storiesOwnInPage: each story's own args, plain, and whether it has a render, decorators or a play function of its own", async () => {
  const fake = fakePreview({
    argTypes: {}, initial: {}, url: {},
    csf: {
      "ui-base-button--icon": { args: { size: "icon", children: { type: "svg" }, onClick: () => {}, gone: undefined }, render: () => null, decorators: [() => null] },
      "ui-base-button--played": { args: {}, decorators: [], play: () => {} },
    },
  });
  const read = await inPage(fake.preview, () => storiesOwnInPage({ storyIds: ["ui-base-button--icon", "ui-base-button--played"] }));
  assert.deepEqual(read, [
    { id: "ui-base-button--icon", args: { size: "icon", children: { $type: "object" }, onClick: { $type: "function" } }, render: true, decorators: true },
    { id: "ui-base-button--played", args: {}, play: true },
  ]);
  assert.deepEqual(await inPage(fake.preview, () => storiesOwnInPage({ storyIds: ["ui-base-button--small"] })), { error: "Storybook's preview has no story ui-base-button--small in its file" });
  // A CSF2 story, `Template.bind({})`, which Storybook normalizes to its userStoryFn and no render: drawn by a function of its own.
  const csf2 = fakePreview({ argTypes: {}, initial: {}, url: {}, csf: { "ui-base-button--icon": { args: { size: "icon" }, userStoryFn: () => null } } });
  assert.deepEqual(await inPage(csf2.preview, () => storiesOwnInPage({ storyIds: ["ui-base-button--icon"] })), [{ id: "ui-base-button--icon", args: { size: "icon" }, render: true }]);
  // A preview that can't load a story's file.
  const old = fakePreview({ argTypes: {}, initial: {}, url: {} });
  assert.deepEqual(await inPage(old.preview, () => storiesOwnInPage({ storyIds: ["x"] })), { error: "Storybook's preview can't load a story's file (loadCSFFileByStoryId)" });
});

test("readStoriesOwn: the stories as the page read them, in the order asked; anything else is no reading", async () => {
  const page = (value: unknown) => ({ evaluate: async () => { if (value instanceof Error) throw value; return value; } }) as unknown as Page;
  const ids = ["a--default", "a--icon"];
  const stories = [{ id: "a--default", args: {} }, { id: "a--icon", args: { size: "icon" } }];
  assert.deepEqual(await readStoriesOwn(page(stories), ids), { stories });
  assert.deepEqual(await readStoriesOwn(page({ error: "no preview" }), ids), { error: "no preview" });
  for (const wrong of [{}, null, [stories[0]], [...stories].reverse(), [{ id: "a--default" }, stories[1]]]) {
    assert.deepEqual(await readStoriesOwn(page(wrong), ids), { error: "Storybook's preview returned nothing snap can read" }, JSON.stringify(wrong));
  }
  assert.deepEqual(await readStoriesOwn(page(new Error("Execution context was destroyed\nmore")), ids), { error: "Execution context was destroyed" });
});

// --- Overlays opened before they are measured ---

const DIALOG = { name: "Dialog", title: "ui/radix/Dialog" };
const DIALOG_TRIGGER = { slot: "dialog-trigger", hasPopup: "dialog", expanded: "false", state: "closed" };
const OVERLAY_OPTS = { ...OPTS, component: DIALOG, openWaitMs: 40 };
const URL_OF = "http://localhost:6006/iframe.html?id=ui-radix-dialog--default";

test("captureStory: a story with a closed dialog trigger has it clicked open, its content measured in its portal, and closed again after", async () => {
  const { page, done, open } = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"] });
  const result = await captureStory(page, URL_OF, OVERLAY_OPTS);
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual([result.element, result.portal, result.notes], ['div[data-slot="dialog-content"]', true, []]);
  assert.deepEqual(result.opened, { via: "click", trigger: 'button[data-slot="dialog-trigger"]' });
  assert.deepEqual(result.boundingBox, { x: 416, y: 275, width: 448, height: 170 });
  // Opened, the pointer moved off it, settled before it was measured, then
  // closed: Escape, the mouse off the page, focus dropped.
  assert.deepEqual(done, ["click", "mouse -1,-1", "settled", "Escape", "mouse -1,-1", "blur"]);
  assert.equal(open(), false);
});

test("captureStory: the tree of an overlay's content is read with what is around it, which places it; a trigger's is not", async () => {
  const opened = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"] });
  assert.equal((await captureStory(opened.page, URL_OF, { ...OVERLAY_OPTS, tree: "tree" })).status, "ok");
  assert.deepEqual(opened.treeArgs.map((a) => a.around), [true]);
  const shut = overlayPage({ marks: DIALOG_TRIGGER, opensOn: [] });
  assert.equal((await captureStory(shut.page, URL_OF, { ...OVERLAY_OPTS, tree: "tree" })).status, "ok");
  assert.deepEqual(shut.treeArgs.map((a) => a.around), [undefined]);
});

test("captureStory: a tooltip's trigger is hovered over first, a context menu's right-clicked", async () => {
  const tooltip = overlayPage({ marks: { slot: "tooltip-trigger", state: "closed" }, opensOn: ["hover"], content: { slot: "tooltip-content", role: "tooltip" } });
  const hovered = await captureStory(tooltip.page, URL_OF, { ...OVERLAY_OPTS, component: { name: "TooltipContent", title: "ui/radix/Tooltip" } });
  assert.deepEqual([hovered.element, hovered.opened], ['div[data-slot="tooltip-content"]', { via: "hover", trigger: 'button[data-slot="tooltip-trigger"]' }]);
  // The pointer stays on the trigger while it is measured: moved off, it would close.
  assert.deepEqual(tooltip.done.slice(0, 3), ["hover", "settled", "Escape"]);

  const menu = overlayPage({ marks: { slot: "context-menu-trigger", state: "closed" }, opensOn: ["contextmenu"], content: { slot: "context-menu-content", role: "menu" } });
  const right = await captureStory(menu.page, URL_OF, { ...OVERLAY_OPTS, component: { name: "ContextMenu", title: "ui/radix/ContextMenu" } });
  assert.deepEqual(right.opened, { via: "contextmenu", trigger: 'button[data-slot="context-menu-trigger"]' });
  assert.equal(menu.done[0], "contextmenu");
});

test("captureStory: an overlay with an open arg is opened by setting it through Storybook's preview, and the arg reset after", async () => {
  const argTypes = { open: { type: { name: "boolean" }, control: { type: "boolean" } } };
  const { page, done, open, stored } = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["arg"], argTypes });
  const result = await captureStory(page, URL_OF, { ...OVERLAY_OPTS, story: { id: "ui-radix-dialog--default", args: {} } });
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual(result.opened, { via: "arg", arg: "open", trigger: 'button[data-slot="dialog-trigger"]' });
  // The trigger was never touched, and the arg is the story's own again.
  assert.deepEqual(done, ["set open=true", "mouse -1,-1", "settled", "reset open", "Escape", "mouse -1,-1", "blur"]);
  assert.equal(open(), false);
  assert.equal(Object.hasOwn(stored(), "open"), false);

  // The component's documented props say so too, without an argType.
  const documented = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["arg"] });
  const viaProps = await captureStory(documented.page, URL_OF, {
    ...OVERLAY_OPTS, component: { ...DIALOG, props: ["defaultOpen", "modal"] }, story: { id: "ui-radix-dialog--default", args: {} },
  });
  assert.deepEqual(viaProps.opened, { via: "arg", arg: "defaultOpen", trigger: 'button[data-slot="dialog-trigger"]' });
  assert.equal(documented.done[0], "set defaultOpen=true");

  // A variant that sets defaultOpen itself keeps its value: the arg isn't
  // touched, and the trigger is clicked, as a user opens it.
  const own = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"], argTypes: { defaultOpen: argTypes.open } });
  const kept = await captureStory(own.page, `${URL_OF}&args=defaultOpen:!false`, { ...OVERLAY_OPTS, story: { id: "ui-radix-dialog--default", args: { defaultOpen: "false" } } });
  assert.equal(own.done.some((d) => d.startsWith("set ") || d.startsWith("reset ")), false);
  assert.equal(kept.opened?.via, "click");

  // One that sets open to false holds it closed: nothing is tried, and the note says so.
  const held = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"], argTypes });
  const shut = await captureStory(held.page, `${URL_OF}&args=open:!false`, { ...OVERLAY_OPTS, story: { id: "ui-radix-dialog--default", args: { open: "false" } } });
  assert.deepEqual([shut.element, shut.opened, held.done], ['button[data-slot="dialog-trigger"]', undefined, []]);
  assert.deepEqual(shut.notes, [{ kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]', reason: "the variant sets its open arg to false, which holds it closed" }]);
});

test("captureStory: when the open arg opens nothing, it is reset and the trigger is clicked", async () => {
  // The story doesn't pass `open` on to the overlay: setting it opens nothing.
  const { page, done, stored } = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"], argTypes: { open: { type: { name: "boolean" } } } });
  const result = await captureStory(page, URL_OF, { ...OVERLAY_OPTS, story: { id: "ui-radix-dialog--default", args: {} } });
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual(result.opened, { via: "click", trigger: 'button[data-slot="dialog-trigger"]' });
  assert.deepEqual(done, ["set open=true", "reset open", "click", "mouse -1,-1", "settled", "Escape", "mouse -1,-1", "blur"]);
  assert.equal(Object.hasOwn(stored(), "open"), false);
});

test("captureStory: once a click opens a select's listbox, the pointer moves off it before it is measured, so no item is hovered over", async () => {
  // Radix's item-aligned listbox opens under the pointer, which stayed where
  // the click left it: its first item was measured hovered and highlighted.
  const field = { role: "combobox", expanded: "false", state: "closed", slot: "select-trigger" };
  const select = overlayPage({ marks: field, opensOn: ["click"], content: { slot: "select-content", role: "listbox" } });
  const result = await captureStory(select.page, URL_OF, { ...OVERLAY_OPTS, component: { name: "Select", title: "ui/radix/Select" } });
  assert.equal(result.opened?.via, "click");
  assert.deepEqual(select.done.slice(0, 3), ["click", "mouse -1,-1", "settled"]);
  // A context menu, opened at the pointer, too.
  const menu = overlayPage({ marks: { slot: "context-menu-trigger", state: "closed" }, opensOn: ["contextmenu"], content: { slot: "context-menu-content", role: "menu" } });
  await captureStory(menu.page, URL_OF, { ...OVERLAY_OPTS, component: { name: "ContextMenu", title: "ui/radix/ContextMenu" } });
  assert.deepEqual(menu.done.slice(0, 3), ["contextmenu", "mouse -1,-1", "settled"]);
});

test("captureStory: content a click opened that closes as the pointer leaves is opened by hovering over its trigger instead", async () => {
  // Opens while the pointer is on its trigger, which a click puts it on.
  const { page, done } = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click", "hover"], closesOnLeave: true });
  const result = await captureStory(page, URL_OF, OVERLAY_OPTS);
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual(result.opened, { via: "hover", trigger: 'button[data-slot="dialog-trigger"]' });
  assert.deepEqual(done.slice(0, 7), ["click", "mouse -1,-1", "settled", "Escape", "mouse -1,-1", "blur", "hover"]);
  // Where nothing keeps it open, the note says so.
  const restless = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"], closesOnLeave: true });
  const shut = await captureStory(restless.page, URL_OF, OVERLAY_OPTS);
  assert.equal(shut.notes[0].kind === "closed-trigger" && shut.notes[0].reason,
    "clicking it opened it, but it closed again as the pointer left; hovering over it, focusing it and right-clicking it opened nothing within 40ms each");
});

/** What dismiss does after a way that opened nothing, so the next starts from the story as it rendered. */
const UNDONE = ["Escape", "mouse -1,-1", "blur"];

test("captureStory: a trigger nothing opens is measured as it is, after every way was tried and undone, and the note says why", async () => {
  const { page, done } = overlayPage({ marks: DIALOG_TRIGGER, opensOn: [] });
  const result = await captureStory(page, URL_OF, OVERLAY_OPTS);
  assert.equal(result.status, "ok", result.error ?? "");
  assert.equal(result.element, 'button[data-slot="dialog-trigger"]');
  assert.equal(result.opened, undefined);
  assert.equal(result.portal, undefined);
  assert.deepEqual(result.notes, [{
    kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]',
    reason: "clicking it, hovering over it, focusing it and right-clicking it opened nothing within 40ms each",
  }]);
  assert.deepEqual(done, ["click", ...UNDONE, "hover", ...UNDONE, "focus", ...UNDONE, "contextmenu", ...UNDONE]);
});

test("captureStory: the note says when a trigger opened but showed nothing outside the story's root, or a way failed", async () => {
  const nowhere = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"], where: "nowhere" });
  const result = await captureStory(nowhere.page, URL_OF, OVERLAY_OPTS);
  assert.equal(result.notes[0].kind === "closed-trigger" && result.notes[0].reason,
    "clicking it opened it, but snap found nothing it opened to measure; " +
    "hovering over it, focusing it and right-clicking it opened nothing within 40ms each");

  // A click Playwright couldn't make is undone too, and the next way opens it.
  const covered = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["hover"], clickThrows: "elementHandle.click: Timeout 40ms exceeded.\nCall log: ..." });
  const hovered = await captureStory(covered.page, URL_OF, OVERLAY_OPTS);
  assert.deepEqual(hovered.opened, { via: "hover", trigger: 'button[data-slot="dialog-trigger"]' });
  assert.deepEqual(covered.done.slice(0, 5), ["click", ...UNDONE, "hover"]);
});

test("captureStory: an overlay that opens inline, beside its trigger, is measured where its trigger's aria-controls names it", async () => {
  // Headless UI's menu renders its items beside its button, in no portal.
  const { page, done, open } = overlayPage({ marks: { hasPopup: "menu", expanded: "false" }, opensOn: ["click"], where: "inline", content: { slot: null, role: "menu" } });
  const result = await captureStory(page, URL_OF, { ...OVERLAY_OPTS, component: { name: "Menu", title: "Headless/Menu" } });
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual([result.element, result.portal, result.notes], ['div[role="menu"]', undefined, []]);
  assert.deepEqual(result.opened, { via: "click", trigger: "button" });
  assert.deepEqual(done, ["click", "mouse -1,-1", "settled", "Escape", "mouse -1,-1", "blur"]);
  assert.equal(open(), false);
});

test("captureStory: a way that leaves the trigger open, with nothing to measure, which Escape doesn't close, has the story mounted again", async () => {
  // Opens on a click into something snap can't find, and ignores Escape.
  const stuck = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"], where: "nowhere", escapeIgnored: true });
  const result = await captureStory(stuck.page, URL_OF, OVERLAY_OPTS);
  assert.equal(result.status, "ok", result.error ?? "");
  // Measured closed, as it rendered, with the trigger's note and why.
  assert.deepEqual([result.element, result.opened], ['button[data-slot="dialog-trigger"]', undefined]);
  assert.deepEqual(result.notes, [{
    kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]',
    reason: "clicking it opened it, but snap found nothing it opened to measure; hovering over it, focusing it and right-clicking it opened nothing within 40ms each",
  }]);
  assert.deepEqual(stuck.done.slice(0, 6), ["click", ...UNDONE, "remount", "hover"]);
  assert.equal(stuck.open(), false);

  // One a remount doesn't close either is measured as it is, with the note
  // of the trigger as it was found, and no other way is tried.
  const open = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"], where: "nowhere", staysOpen: true });
  const kept = await captureStory(open.page, URL_OF, OVERLAY_OPTS);
  assert.equal(kept.status, "ok", kept.error ?? "");
  assert.equal(kept.opened, undefined);
  assert.deepEqual(kept.notes, [{
    kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]',
    reason: "clicking it opened it, but snap found nothing it opened to measure; it stayed open, though snap mounted the story again",
  }]);
  assert.deepEqual(open.done, ["click", ...UNDONE, "remount"]);
});

test("captureStory: with --no-open-overlays, a closed trigger is measured untouched, and the note says snap was told so", async () => {
  const { page, done } = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"] });
  const result = await captureStory(page, URL_OF, { ...OVERLAY_OPTS, openOverlays: false });
  assert.equal(result.element, 'button[data-slot="dialog-trigger"]');
  assert.deepEqual(result.notes, [{ kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]', reason: "it was run with --no-open-overlays" }]);
  assert.deepEqual(done, []);
});

test("captureStory: a select's field is clicked open and its listbox measured; one that opens nothing is measured as the field, with no note but why", async () => {
  const field = { role: "combobox", expanded: "false", state: "closed", slot: "select-trigger" };
  const select = overlayPage({ marks: field, opensOn: ["click"], content: { slot: "select-content", role: "listbox" } });
  const opened = await captureStory(select.page, URL_OF, { ...OVERLAY_OPTS, component: { name: "Select", title: "ui/radix/Select" } });
  assert.deepEqual([opened.element, opened.opened], ['div[data-slot="select-content"]', { via: "click", trigger: 'button[data-slot="select-trigger"]' }]);

  const shut = overlayPage({ marks: field, opensOn: [] });
  const asIs = await captureStory(shut.page, URL_OF, { ...OVERLAY_OPTS, component: { name: "Select", title: "ui/radix/Select" } });
  assert.deepEqual([asIs.element, asIs.notes, asIs.opened], ['button[data-slot="select-trigger"]', [], undefined]);
  // Which runSnap notes where it opened other variants.
  assert.deepEqual(asIs.unopened, { element: 'button[data-slot="select-trigger"]', reason: "clicking it opened nothing within 40ms" });
  assert.equal(opened.unopened, undefined);
  // Clicked, and nothing else: closed, the field is the component.
  assert.deepEqual(shut.done, ["click", ...UNDONE]);
});

test("captureStory: a later variant of a story tries the way that opened an earlier one alone, and where none did, only the first way again", async () => {
  const memory: OpenMemory = new Map();
  const opts = { ...OVERLAY_OPTS, openMemory: memory, story: { id: "ui-radix-dialog--default", args: {} } };
  // A tooltip-like trigger whose marks say click, which hovering opens.
  const first = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["hover"] });
  assert.equal((await captureStory(first.page, URL_OF, opts)).opened?.via, "hover");
  assert.deepEqual(first.done.slice(0, 5), ["click", ...UNDONE, "hover"]);
  assert.deepEqual(memory.get("ui-radix-dialog--default"), { worked: "hover" });
  const second = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["hover"] });
  assert.equal((await captureStory(second.page, URL_OF, opts)).opened?.via, "hover");
  assert.equal(second.done[0], "hover");
  // A variant it doesn't open, a disabled one, isn't tried every other way.
  const disabled = overlayPage({ marks: DIALOG_TRIGGER, opensOn: [] });
  const shut = await captureStory(disabled.page, URL_OF, opts);
  assert.deepEqual(disabled.done, ["hover", ...UNDONE]);
  assert.equal(shut.notes[0].kind === "closed-trigger" && shut.notes[0].reason,
    "hovering over it opened nothing within 40ms; snap tried no other way, as hovering over it opened an earlier variant");

  // Where every way failed, a later variant tries the first again, and says what the first found.
  memory.clear();
  const none = overlayPage({ marks: DIALOG_TRIGGER, opensOn: [] });
  const all = await captureStory(none.page, URL_OF, opts);
  const again = overlayPage({ marks: DIALOG_TRIGGER, opensOn: [] });
  const later = await captureStory(again.page, URL_OF, opts);
  assert.deepEqual(again.done, ["click", ...UNDONE]);
  assert.deepEqual(later.notes, all.notes);
  // Where the first way opens it this time, it is remembered as the way.
  const opens = overlayPage({ marks: DIALOG_TRIGGER, opensOn: ["click"] });
  assert.equal((await captureStory(opens.page, URL_OF, opts)).opened?.via, "click");
  assert.deepEqual(memory.get("ui-radix-dialog--default"), { worked: "click" });
});

test("triggerOpenInPage: ARIA's, Radix's and Base UI's marks of an open trigger", () => {
  const el = (attrs: Record<string, string>) => ({
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
  }) as unknown as Element;
  assert.equal(triggerOpenInPage(el({ "aria-expanded": "true" })), true);
  assert.equal(triggerOpenInPage(el({ "data-state": "open" })), true);
  assert.equal(triggerOpenInPage(el({ "data-state": "delayed-open" })), true);
  assert.equal(triggerOpenInPage(el({ "data-popup-open": "" })), true);
  assert.equal(triggerOpenInPage(el({ "aria-expanded": "false", "data-state": "closed" })), false);
  assert.equal(triggerOpenInPage(el({})), false);
});

test("overlaySettledInPage: waits out the animations that end, not one that repeats forever, then for boxes that stay put", async () => {
  const scope = globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => void };
  scope.requestAnimationFrame = (cb) => { setTimeout(cb, 1); };
  try {
    let ended = false;
    const finite = { playState: "running", effect: { getComputedTiming: () => ({ endTime: 150 }) }, finished: new Promise((r) => setTimeout(() => { ended = true; finite.playState = "finished"; r(null); }, 30)) };
    const forever = { playState: "running", effect: { getComputedTiming: () => ({ endTime: Infinity }) }, finished: new Promise(() => {}) };
    // A box that moves twice as it is placed, then stays.
    let reads = 0;
    const el = {
      getAnimations: () => [finite, forever],
      getBoundingClientRect: () => ({ x: reads++ < 3 ? reads : 3, y: 0, width: 100, height: 40 }),
      querySelectorAll: () => [],
    } as unknown as Element;
    assert.equal(await overlaySettledInPage(el, { ms: 2000, frames: 3 }), true);
    assert.equal(ended, true, "the animation that ends was waited for");

    // One that never stays put is given up on once the time runs out.
    let x = 0;
    const restless = { getAnimations: () => [], getBoundingClientRect: () => ({ x: x++, y: 0, width: 1, height: 1 }), querySelectorAll: () => [] } as unknown as Element;
    const started = Date.now();
    assert.equal(await overlaySettledInPage(restless, { ms: 60, frames: 3 }), false);
    assert.ok(Date.now() - started < 1000);
  } finally {
    delete scope.requestAnimationFrame;
  }
});
