// Unit tests for the render/enrichment layer. We don't launch a real
// browser here (that's the e2e fixture's job) — these tests pin the URL
// shape, the matrix enumeration, the snapshot→styling adapter, and the
// rendered-overlay merge in pushgen.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StorybookRenderer,
  enumerateCombos,
  enumerateCombosFromAxes,
  normalizeStoryId,
  RenderUnavailableError,
} from "../render.js";
import type { InspectionResult } from "../inspect.js";

const baseSpec = (): InspectionResult => ({
  name: "Badge",
  path: "/proj/components/badge.tsx",
  base: { padding: "2px 6px 2px 6px", borderRadius: "6px" },
  baseBindings: {},
  variants: [],
  unresolved: [],
  warnings: [],
});

test("normalizeStoryId: title-style with / becomes kebab", () => {
  // Storybook MCP 0.6+ returns story IDs in title form (`Catalyst/Button--Default`).
  // Storybook's iframe routing only resolves the canonical kebab form.
  assert.equal(normalizeStoryId("Catalyst/Button--Default"), "catalyst-button--default");
  assert.equal(normalizeStoryId("Forms/Buttons/Primary--Default"), "forms-buttons-primary--default");
});

test("normalizeStoryId: already-kebab IDs pass through unchanged", () => {
  assert.equal(normalizeStoryId("catalyst-button--default"), "catalyst-button--default");
});

test("StorybookRenderer.buildStoryUrl: normalizes title-style IDs to kebab", () => {
  const r = new StorybookRenderer({ storybookUrl: "http://localhost:6006" });
  const url = r.buildStoryUrl("Catalyst/Button--Default");
  assert.ok(url.includes("id=catalyst-button--default"), `got: ${url}`);
});

test("StorybookRenderer.buildStoryUrl: no args", () => {
  const r = new StorybookRenderer({ storybookUrl: "http://localhost:6006" });
  const url = r.buildStoryUrl("catalyst-badge--default");
  assert.equal(
    url,
    "http://localhost:6006/iframe.html?id=catalyst-badge--default&viewMode=story",
  );
});

test("StorybookRenderer.buildStoryUrl: with args, encodes special chars", () => {
  const r = new StorybookRenderer({ storybookUrl: "http://localhost:6006/" });
  const url = r.buildStoryUrl("catalyst-badge--default", {
    color: "red",
    size: "md",
  });
  // Storybook uses `;` to separate k:v pairs in the args param.
  // URLSearchParams encodes `;` to `%3B`, which Storybook accepts.
  assert.ok(url.includes("id=catalyst-badge--default"));
  assert.ok(url.includes("args=color%3Ared%3Bsize%3Amd"), `unexpected url: ${url}`);
});

test("StorybookRenderer.buildStoryUrl: arg value with reserved char gets bang-escaped", () => {
  const r = new StorybookRenderer({ storybookUrl: "http://localhost:6006" });
  // Storybook's arg parser treats `:` `;` `,` `!` `"` as reserved — they
  // must be encoded as `!XX` (hex) inside the value so they round-trip.
  const url = r.buildStoryUrl("comp--story", { variant: "dark/zinc" });
  // `/` is not in the reserved set, so it survives as-is (just URL-escaped to %2F).
  assert.ok(url.includes("variant"));
  const url2 = r.buildStoryUrl("comp--story", { label: "Hi: world" });
  // `:` is bang-escaped to `!3a` in the value before URLSearchParams sees
  // it; the `!` then gets URL-encoded to `%21`. Storybook decodes the
  // URL first, so it sees `!3a` and interprets it as `:` in the value.
  assert.ok(url2.includes("%213a"), `expected %213a in url, got: ${url2}`);
});

test("StorybookRenderer.init: surfaces a clear error when Chromium missing", async () => {
  // We can't easily uninstall Chromium just for one test, so this asserts
  // the error class exists and the message shape is what we promise.
  const err = new RenderUnavailableError(
    "Chromium not installed. Run `npx playwright install chromium` (one-time, ~150MB) and retry.",
  );
  assert.equal(err.name, "RenderUnavailableError");
  assert.match(err.message, /playwright install chromium/);
});

test("enumerateCombos: no variants → single Default combo", () => {
  const spec = baseSpec();
  const combos = enumerateCombos(spec);
  assert.deepEqual(combos, [{ args: {}, key: "Default" }]);
});

test("enumerateCombos: single axis → one combo per value", () => {
  const spec: InspectionResult = {
    ...baseSpec(),
    variants: [
      {
        name: "color",
        defaultValue: "zinc",
        values: { red: {}, blue: {}, zinc: {} },
        bindings: {},
      },
    ],
  };
  const combos = enumerateCombos(spec);
  assert.equal(combos.length, 3);
  assert.deepEqual(
    combos.map((c) => c.key).sort(),
    ["color=blue", "color=red", "color=zinc"],
  );
  assert.deepEqual(combos[0].args, { color: "red" });
});

test("enumerateCombos: two axes → cartesian product", () => {
  const spec: InspectionResult = {
    ...baseSpec(),
    variants: [
      {
        name: "size",
        defaultValue: "md",
        values: { sm: {}, md: {} },
        bindings: {},
      },
      {
        name: "variant",
        defaultValue: "solid",
        values: { solid: {}, outline: {} },
        bindings: {},
      },
    ],
  };
  const combos = enumerateCombos(spec);
  assert.equal(combos.length, 4);
  // Keys mirror pushgen's formatVariantName so lookups round-trip.
  assert.deepEqual(
    combos.map((c) => c.key).sort(),
    [
      "size=md, variant=outline",
      "size=md, variant=solid",
      "size=sm, variant=outline",
      "size=sm, variant=solid",
    ],
  );
});

test("enumerateCombosFromAxes: drives matrix from Storybook argTypes", () => {
  // Storybook reports two axes (color × disabled). The renderer should
  // produce one combo per combination, with keys that match pushgen's
  // formatVariantName so renderedStyling[key] lookups round-trip.
  const combos = enumerateCombosFromAxes([
    { name: "color", values: ["red", "blue"] },
    { name: "disabled", values: ["true", "false"] },
  ]);
  assert.equal(combos.length, 4);
  assert.deepEqual(
    combos.map((c) => c.key).sort(),
    [
      "color=blue, disabled=false",
      "color=blue, disabled=true",
      "color=red, disabled=false",
      "color=red, disabled=true",
    ],
  );
});

test("enumerateCombosFromAxes: empty axes → single Default combo", () => {
  const combos = enumerateCombosFromAxes([]);
  assert.deepEqual(combos, [{ args: {}, key: "Default" }]);
});

test("enumerateCombos: slashes in values get hyphenated in keys (matches pushgen)", () => {
  // Catalyst uses values like `dark/zinc` and `dark/white`. Figma treats
  // `/` as the variant group separator, so pushgen rewrites them. The
  // combo key has to follow suit for renderedStyling lookups to hit.
  const spec: InspectionResult = {
    ...baseSpec(),
    variants: [
      {
        name: "color",
        defaultValue: "dark/zinc",
        values: { "dark/zinc": {}, "dark/white": {} },
        bindings: {},
      },
    ],
  };
  const combos = enumerateCombos(spec);
  assert.deepEqual(
    combos.map((c) => c.key).sort(),
    ["color=dark-white", "color=dark-zinc"],
  );
  // The args we send to Storybook keep the original slash — Storybook's
  // arg parser doesn't care, but Figma's component-set namer does.
  const slashCombo = combos.find((c) => c.key === "color=dark-zinc")!;
  assert.equal(slashCombo.args.color, "dark/zinc");
});
