// Tests for reading a story's color scheme and asking Storybook for light.

import { test } from "node:test";
import assert from "node:assert/strict";
import { colorSchemeInPage, describeDarkScheme, globalsParam, lightGlobals, schemeOfGlobals, themeGlobalsInPage } from "../snap-scheme.js";
import { inFakePage } from "./dom-standin.js";
import type { FakeElementSpec } from "./dom-standin.js";

/** A story's element inside html and body, with `html` and `body` attributes. */
function page(html: Record<string, string>, el: FakeElementSpec, body: Record<string, string> = {}): FakeElementSpec {
  return { tag: "html", attrs: html, rect: [0, 0, 1280, 720], kids: [{ tag: "body", attrs: body, rect: [0, 0, 1280, 720], kids: [el] }] };
}
const button: FakeElementSpec = { tag: "button", attrs: { id: "b", class: "dark:bg-input/30 bg-background" }, rect: [0, 0, 80, 36] };
const at = (root: Element) => root.children[0].children[0];

test("colorSchemeInPage: a dark class on html, as coder's theme decorator sets, is dark", () => {
  const reading = inFakePage(page({ class: "dark dark-tritan" }, button), colorSchemeInPage, [], at);
  assert.deepEqual(reading, { scheme: "dark", by: "html.dark" });
});

test("colorSchemeInPage: the nearest mark wins, and a data-theme attribute names one", () => {
  const wrapped: FakeElementSpec = { tag: "div", attrs: { "data-theme": "light" }, rect: [0, 0, 80, 36], kids: [button] };
  const reading = inFakePage(page({ class: "dark" }, wrapped), colorSchemeInPage, [], (root) => root.children[0].children[0].children[0]);
  assert.deepEqual(reading, { scheme: "light", by: 'div[data-theme="light"]' });
});

test("colorSchemeInPage: dark: variant classes and an unmarked page are light", () => {
  assert.deepEqual(inFakePage(page({}, button), colorSchemeInPage, [], at), { scheme: "light" });
});

test("colorSchemeInPage: a computed color-scheme of dark alone is dark", () => {
  const dark: FakeElementSpec = { ...button, style: { "color-scheme": "dark" } };
  assert.deepEqual(inFakePage(page({}, dark), colorSchemeInPage, [], at), { scheme: "dark", by: "color-scheme: dark" });
});

test("lightGlobals: an empty theme global a decorator reads as dark is set to light, and others are left", () => {
  assert.deepEqual(lightGlobals({ globals: { theme: "", viewport: "", measureEnabled: { $type: "boolean" } }, allowed: ["theme", "viewport", "measureEnabled"], options: {} }), { theme: "light" });
});

test("lightGlobals: a value naming dark becomes its light counterpart, or the toolbar's light value", () => {
  assert.deepEqual(lightGlobals({ globals: { theme: "dark-tritan" }, allowed: ["theme"], options: {} }), { theme: "light-tritan" });
  assert.deepEqual(lightGlobals({ globals: { scheme: "Dark" }, allowed: ["scheme"], options: { scheme: ["Night", "Day light"] } }), { scheme: "Day light" });
});

test("lightGlobals: nothing to set where no global names a theme, or the URL can't carry it", () => {
  assert.equal(lightGlobals({ globals: { locale: "en" }, allowed: ["locale"], options: {} }), null);
  assert.equal(lightGlobals({ globals: { theme: "dark" }, allowed: [], options: {} }), null);
  assert.equal(lightGlobals({ globals: { theme: "dark/blue" }, allowed: ["theme"], options: {} }), null);
});

test("globalsParam and describeDarkScheme", () => {
  assert.equal(globalsParam({ theme: "light", mode: "a b" }), "theme:light;mode:a b");
  const warning = describeDarkScheme("html.dark", "its preview has no theme global", { dark: 2, measured: 4 });
  assert.match(warning, /^It was measured in its dark color scheme \(html\.dark\) \(2 of 4 measured variants\), as its preview has no theme global/);
  assert.match(warning, /`scheme: "dark"`/);
});

test("themeGlobalsInPage: addon-themes' empty theme global is its default, and the backgrounds global's value is read as a URL sets it", () => {
  const held = globalThis as { window?: unknown };
  held.window = {
    __STORYBOOK_PREVIEW__: {
      storyStoreValue: {
        userGlobals: { get: () => ({ theme: "", backgrounds: { value: "dark", grid: false } }), allowedGlobalNames: new Set(["theme", "backgrounds"]) },
        projectAnnotations: { globalTypes: {} },
      },
    },
    __STORYBOOK_ADDONS_CHANNEL__: {
      last: (event: string) => (event === "storybook/addon-themes/REGISTER_THEMES" ? [{ defaultTheme: "dark", themes: ["light", "dark"] }] : undefined),
    },
  };
  try {
    const read = themeGlobalsInPage();
    assert.deepEqual(read, {
      globals: { theme: "dark", backgrounds: { $type: "object" }, "backgrounds.value": "dark" },
      allowed: ["theme", "backgrounds", "backgrounds.value"],
      options: { theme: ["light", "dark"] },
      defaulted: ["theme"],
    });
    assert.deepEqual(schemeOfGlobals(read), { scheme: "dark", by: "addon-themes' default theme, dark" });
    assert.deepEqual(lightGlobals(read!), { theme: "light", "backgrounds.value": "light" });
  } finally {
    delete held.window;
  }
});

test("schemeOfGlobals: a theme, scheme or mode global naming dark is dark; others say nothing", () => {
  assert.deepEqual(schemeOfGlobals({ globals: { mode: "dark" }, allowed: ["mode"], options: {} }), { scheme: "dark", by: "globals mode:dark" });
  assert.equal(schemeOfGlobals({ globals: { theme: "light", locale: "dark" }, allowed: [], options: {} }), null);
  assert.equal(schemeOfGlobals(null), null);
});
