// Tests for snap orchestration. The Storybook client and browser launcher are
// injected, so these run without a network or a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSnap, pickStory, detectFontSubstitution } from "../snap.js";
import type { SnapOptions } from "../snap.js";
import type { StorybookComponent } from "../mapper.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "storysync-snap-"));
}

function options(outDir: string, overrides: Partial<SnapOptions> = {}): SnapOptions {
  return {
    storybookUrl: "http://localhost:6006",
    outDir,
    screenshots: false,
    timeoutMs: 1000,
    variants: "representative",
    ...overrides,
  };
}

/** A launcher that fails if it is ever called. */
const launchShouldNotHappen = async () => {
  throw new Error("browser launched when it should not have been");
};

// --- pickStory ---

function component(stories: { id: string; name: string }[]): StorybookComponent {
  return { name: "Button", props: [], stories };
}

test("pickStory: trusts index story IDs over documentation-scraped ones", () => {
  // The scraped value here is the wrong guess the docs parser used to produce.
  const scraped = component([{ id: "button--default", name: "Default" }]);
  assert.equal(pickStory(["forms-button--default"], scraped), "forms-button--default");
});

test("pickStory: prefers a Default story", () => {
  const ids = ["forms-button--ghost", "forms-button--default", "forms-button--primary"];
  assert.equal(pickStory(ids, component([])), "forms-button--default");
});

test("pickStory: falls back to the first story when none is Default", () => {
  assert.equal(pickStory(["forms-button--ghost", "forms-button--primary"], component([])), "forms-button--ghost");
});

test("pickStory: uses documentation stories when the index gives none", () => {
  assert.equal(pickStory(undefined, component([{ id: "x--only", name: "Only" }])), "x--only");
  assert.equal(pickStory([], component([{ id: "x--only", name: "Only" }])), "x--only");
});

test("pickStory: returns null when there is nothing to render", () => {
  assert.equal(pickStory(undefined, component([])), null);
});

// --- runSnap ---

test("runSnap: does not launch a browser when no components match", async () => {
  const dir = tempDir();
  try {
    // A typo in --components must not surface as a browser failure on a
    // machine that has no browser installed.
    const result = await runSnap(options(dir, { components: ["Nonexistent"] }), {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async () => { throw new Error("should not be reached"); },
      } as never,
      launch: launchShouldNotHappen as never,
    });

    assert.equal(result.components.length, 0);
    assert.equal(result.summary.variants, 0);
    assert.ok(existsSync(join(dir, "styles.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a component that cannot be read is recorded, not fatal", async () => {
  const dir = tempDir();
  let closed = false;
  try {
    const result = await runSnap(options(dir), {
      storybook: {
        listComponents: async () => [
          { id: "forms-broken", name: "Broken" },
          { id: "forms-fine", name: "Fine" },
        ],
        getComponent: async (id: string) => {
          if (id === "forms-broken") throw new Error("documentation unavailable");
          return { name: "Fine", props: [], stories: [{ id: "forms-fine--default", name: "Default" }] };
        },
      } as never,
      // No variant properties means one combination, which this stub renders.
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({
            newPage: async () => ({}),
            close: async () => { closed = true; },
          }),
          close: async () => {},
        },
      }) as never,
    });

    const broken = result.components.find((c) => c.name === "Broken");
    assert.match(broken!.error!, /documentation unavailable/);
    assert.equal(broken!.variants.length, 0);

    // The other component was still attempted.
    assert.ok(result.components.some((c) => c.name === "Fine"));
    assert.equal(result.summary.componentsFailed, 1);
    assert.equal(closed, true, "browser context should be closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a failed browser session is attributed to the component", async () => {
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir), {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async () => ({
          name: "Button", props: [], stories: [{ id: "forms-button--default", name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          // Page creation failing must not abandon the run.
          newContext: async () => ({
            newPage: async () => { throw new Error("target crashed"); },
            close: async () => {},
          }),
          close: async () => {},
        },
      }) as never,
    });

    assert.match(result.components[0].error!, /browser session failed.*target crashed/);
    assert.equal(result.summary.componentsFailed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: styles.json carries no timestamp, so runs are reproducible", async () => {
  const dir = tempDir();
  try {
    const deps = {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async () => ({
          name: "Button", props: [], stories: [{ id: "forms-button--default", name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
          close: async () => {},
        },
      }) as never,
    };

    await runSnap(options(dir), deps);
    const first = readFileSync(join(dir, "styles.json"), "utf8");
    await runSnap(options(dir), deps);
    const second = readFileSync(join(dir, "styles.json"), "utf8");

    assert.equal(first, second);
    assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T/, "output must not embed a timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: writes volatile metadata beside styles.json, not inside it", async () => {
  const dir = tempDir();
  try {
    const FIXED = Date.parse("2026-03-04T05:06:07.000Z");
    const deps = {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async () => ({
          name: "Button", props: [], stories: [{ id: "forms-button--default", name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
          close: async () => {},
        },
      }) as never,
      now: () => FIXED,
    };

    await runSnap(options(dir), deps);

    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    assert.equal(meta.measuredAt, "2026-03-04T05:06:07.000Z");
    assert.equal(meta.storybookUrl, "http://localhost:6006");
    assert.equal(meta.variantSelection, "representative");

    // The timestamp must stay out of styles.json, which is meant to be
    // committed and diffed.
    const styles = readFileSync(join(dir, "styles.json"), "utf8");
    assert.doesNotMatch(styles, /measuredAt|\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: styles.json stays byte-identical even as the clock moves", async () => {
  const dir = tempDir();
  try {
    const build = (now: number) => ({
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async () => ({
          name: "Button", props: [], stories: [{ id: "forms-button--default", name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
          close: async () => {},
        },
      }) as never,
      now: () => now,
    });

    await runSnap(options(dir), build(1_000_000));
    const first = readFileSync(join(dir, "styles.json"), "utf8");
    const firstMeta = readFileSync(join(dir, "meta.json"), "utf8");

    await runSnap(options(dir), build(9_999_999));
    assert.equal(readFileSync(join(dir, "styles.json"), "utf8"), first);
    // The sidecar is where the churn is allowed to live.
    assert.notEqual(readFileSync(join(dir, "meta.json"), "utf8"), firstMeta);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- font substitution warning ---

function componentWithFonts(
  baseAvailable: boolean | null,
  variantDeltas: Record<string, unknown>[] = [],
): Parameters<typeof detectFontSubstitution>[0] {
  return {
    name: "Button", title: "Forms/Button", storyId: "b--default",
    variantProperties: [], warnings: [], error: null,
    base: {
      combination: {}, slug: "a",
      styles: { fontFamily: "Inter", fontAvailable: baseAvailable } as never,
    },
    variants: variantDeltas.map((delta, i) => ({
      combination: {}, slug: `v${i}`, status: "ok" as const, error: null, delta: delta as never,
    })),
  };
}

test("detectFontSubstitution: silent when the font resolved", () => {
  assert.equal(detectFontSubstitution(componentWithFonts(true)), null);
  assert.equal(detectFontSubstitution(componentWithFonts(null)), null);
});

test("detectFontSubstitution: names an unavailable base font", () => {
  const warning = detectFontSubstitution(componentWithFonts(false));
  assert.match(warning!, /could not render "Inter"/);
  assert.match(warning!, /cannot install fonts into Figma/);
});

// A variant that switches family carries its own availability in its delta;
// inspecting only the base would record the substitution without reporting it.
test("detectFontSubstitution: catches a variant-only substitution", () => {
  const warning = detectFontSubstitution(
    componentWithFonts(true, [{ fontAvailable: false, fontFamily: "Helvetica" }]),
  );
  assert.match(warning!, /could not render "Helvetica"/);
});

test("detectFontSubstitution: names every distinct unavailable family once", () => {
  const warning = detectFontSubstitution(componentWithFonts(false, [
    { fontAvailable: false, fontFamily: "Helvetica" },
    { fontAvailable: false, fontFamily: "Helvetica" },
  ]));
  assert.match(warning!, /"Inter"/);
  assert.match(warning!, /"Helvetica"/);
  assert.equal((warning!.match(/Helvetica/g) ?? []).length, 1);
});

test("detectFontSubstitution: a variant delta without a family falls back to the base name", () => {
  const warning = detectFontSubstitution(componentWithFonts(true, [{ fontAvailable: false }]));
  assert.match(warning!, /could not render "Inter"/);
});
