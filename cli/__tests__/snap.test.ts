// Tests for snap orchestration. The Storybook client and browser launcher are
// injected, so these run without a network or a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSnap, pickStory, detectFontSubstitution, describeSlugCollisions, writeScreenshot, selectCombinations, describeCap, uncoveredValues,
  detectNoOpProperties, describeNoOpProperties, describeMeasurementNotes, BrowserLostError, screenshotName, ScreenshotStage,
  describeIdenticalVariants, parseBehaviorOnlyWarning, detectIdenticalVariants,
  parseMeasurementWarning, snapFailsStrict, resolveStoryOverrides, detectIdenticalValues, describeIdenticalValues,
  describeTruncatedTrees, describeClimbed, describeFontStandIns, parseSnapWarning,
  contentOverflow, describeOverflow, describeVariantStories,
} from "../snap.js";
import { describeArgRejections, describeUncheckedArgs } from "../snap-args.js";
import { VERSION } from "../version.js";
import type { SnapOptions, SnapVariant } from "../snap.js";
import type { FigmaVariantProperty, StorybookComponent } from "../mapper.js";
import { storyArgsInPage, applyStoryArgsInPage, captureTreeInPage, storiesOwnInPage, thumbnailInPage } from "../snap-browser.js";
import type { RawTreeCapture } from "../snap-tree.js";
import type { TreeNode } from "../tree-types.js";
import { imageAssetId } from "../snap-assets.js";
import { fnv1a32Bytes } from "../checksum.js";
import { fakePreview, inPage, urlArgs } from "./preview-standin.js";
import type { FakeArgType } from "./preview-standin.js";

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

/** What a stand-in page's element gives captureTreeInPage: itself, `width` by `height`, holding nothing. */
function bareTree(width = 40, height = 20) {
  return { root: { k: "e", tag: "div", box: [0, 0, width, height], cs: {}, kids: [], path: [] }, fonts: {} };
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

test("runSnap: a --components name that matches nothing is an error, not an empty run", async () => {
  const dir = tempDir();
  try {
    // Silently filtering to zero produced an empty styles.json alongside a
    // freshly-stamped meta.json, so the pipeline went green having measured
    // nothing. The failure must still arrive before the browser launches: a
    // typo must not surface as a browser error on a machine without one.
    await assert.rejects(
      () => runSnap(options(dir, { components: ["Nonexistent"] }), {
        storybook: {
          listComponents: async () => [{ id: "forms-button", name: "Button" }],
          getComponent: async () => { throw new Error("should not be reached"); },
        } as never,
        launch: launchShouldNotHappen as never,
      }),
      /matched no component named "Nonexistent".*Available: Button/s,
    );

    // Nothing was written, so no stale snap is left behind to be scored later.
    assert.equal(existsSync(join(dir, "styles.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a partial --components typo fails rather than silently dropping the name", async () => {
  const dir = tempDir();
  try {
    // The more dangerous shape: one name matches, so the run looks populated
    // while the misspelled component is never measured.
    await assert.rejects(
      () => runSnap(options(dir, { components: ["Button", "Buton"] }), {
        storybook: {
          listComponents: async () => [{ id: "forms-button", name: "Button" }],
          getComponent: async () => { throw new Error("should not be reached"); },
        } as never,
        launch: launchShouldNotHappen as never,
      }),
      /matched no component named "Buton"/,
    );
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
    // With no --exclude-props, nothing is recorded of it.
    assert.equal("excludeProps" in JSON.parse(first), false);
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

// --- describeSlugCollisions ---

test("describeSlugCollisions: silent when every name is already distinct", () => {
  assert.equal(describeSlugCollisions([]), null);
});

test("describeSlugCollisions: names the combination and both slugs", () => {
  const warning = describeSlugCollisions([
    { base: "size-small", slug: "size-small--2", combination: { size: "small" } },
  ]);
  assert.match(warning!, /size=small/);
  assert.match(warning!, /"size-small--2"/);
  assert.match(warning!, /"size-small"/);
  // The measurements are fine; only the name changed. Saying so keeps this
  // from reading as a measurement failure.
  assert.match(warning!, /measurements are correct/);
});

test("describeSlugCollisions: counts and pluralizes", () => {
  const one = describeSlugCollisions([
    { base: "a", slug: "a--2", combination: { x: "1" } },
  ]);
  assert.match(one!, /^1 variant name collides/);

  const two = describeSlugCollisions([
    { base: "a", slug: "a--2", combination: { x: "1" } },
    { base: "b", slug: "b--2", combination: { y: "2" } },
  ]);
  assert.match(two!, /^2 variant names collide/);
});

/** Snaps `entries`, each with one story and no props, with a browser that renders nothing. */
async function snapEntries(dir: string, entries: object[]) {
  return runSnap(options(dir), {
    storybook: {
      listComponents: async () => entries,
      getComponent: async (id: string) => ({
        name: "Button", props: [], stories: [{ id: `${id}--default`, name: "Default" }],
      }),
    } as never,
    launch: async () => ({
      via: "stub",
      browser: {
        newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
        close: async () => {},
      },
    }) as never,
  });
}

// Components are keyed by `title ?? id` in the readback and during
// verification, so two components sharing that key silently collapse into one
// downstream — a measured component vanishing from the score with no signal.
test("runSnap: warns when two components share an identity key", async () => {
  const dir = tempDir();
  try {
    // Titles rebuilt from IDs, without Storybook's index, that came out the
    // same: the fix is to let storysync read the index, not to retitle.
    const derived = await snapEntries(dir, [
      { id: "a-button", name: "Button", title: "Forms/Button", titleDerived: true },
      { id: "b-button", name: "Button", title: "Forms/Button", titleDerived: true },
    ]);
    assert.equal(derived.summary.componentsWithWarnings, 2);
    for (const component of derived.components) {
      const warning = component.warnings.find((w) => /share the key "Forms\/Button"/.test(w));
      assert.ok(warning, "collision warning missing");
      assert.match(warning, /rebuilt from their Storybook IDs, since http:\/\/localhost:6006\/index\.json couldn't be read/);
      assert.doesNotMatch(warning, /distinct Storybook titles/);
    }

    // Storybook's own title on both.
    const titled = await snapEntries(dir, [
      { id: "a-button", name: "Button", title: "Forms/Button" },
      { id: "b-button", name: "Button", title: "Forms/Button" },
    ]);
    assert.ok(titled.components.every((c) => c.warnings.some((w) => /share the key "Forms\/Button"[\s\S]*Give them distinct Storybook titles\./.test(w))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: untitled components of one name are told apart by their IDs", async () => {
  // Keyed by name, Toaster under ui/base/Sonner and under ui/radix/Sonner
  // collided, and the warning told the user to give them distinct titles,
  // which Storybook already had.
  const dir = tempDir();
  try {
    const result = await snapEntries(dir, [
      { id: "ui-base-sonner", name: "Toaster" },
      { id: "ui-radix-sonner", name: "Toaster" },
    ]);
    assert.equal(result.summary.componentsWithWarnings, 0);
    assert.deepEqual(result.components.map((c) => [c.id, c.name]), [["ui-base-sonner", "Toaster"], ["ui-radix-sonner", "Toaster"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The formatter is unit-tested above; this pins the wiring — that a collision
// detected while assigning names actually reaches the component's warnings, and
// so the `--strict-warnings` gate, rather than being computed and dropped.
test("runSnap: a variant name collision reaches the warnings and the strict gate", async () => {
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir), {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button", title: "Forms/Button" }],
        getComponent: async () => ({
          name: "Button",
          // Two values Storybook treats as distinct that slugify identically.
          props: [{
            name: "size",
            type: { name: "string" },
            control: { type: "select", options: ["Small", "small"] },
          }],
          stories: [{ id: "forms-button--default", name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
          close: async () => {},
        },
      }) as never,
    });

    const [button] = result.components;
    assert.ok(
      button.warnings.some((w) => /variant name collides/.test(w)),
      `expected a collision warning, got: ${JSON.stringify(button.warnings)}`,
    );
    assert.equal(result.summary.componentsWithWarnings, 1);

    // And the two variants really do carry different names.
    const slugs = button.variants.map((v) => v.slug);
    assert.equal(new Set(slugs).size, slugs.length, `slugs not distinct: ${slugs.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: distinct titles produce no collision warning", async () => {
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir), {
      storybook: {
        listComponents: async () => [
          { id: "forms-button", name: "Button", title: "Forms/Button" },
          { id: "marketing-button", name: "Button", title: "Marketing/Button" },
        ],
        getComponent: async (id: string) => ({
          name: "Button", props: [], stories: [{ id: `${id}--default`, name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
          close: async () => {},
        },
      }) as never,
    });

    assert.equal(result.summary.componentsWithWarnings, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeScreenshot: records the PNG path relative to styles.json, never absolute", () => {
  // styles.json is committed and diffed. An absolute path differs between
  // machines and checkouts for identical code, and writes the local
  // filesystem layout — username included — into the file.
  const dir = tempDir();
  try {
    const recorded = writeScreenshot(dir, { id: "forms-button", name: "Button", title: "Forms/Button" } as never,
      "variant-primary", Buffer.from("png"));
    assert.equal(recorded, "forms-button/variant-primary.png");
    assert.ok(existsSync(join(dir, recorded)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeScreenshot: an untitled component's screenshots go under its ID, not its name", () => {
  // By name, ui/base/Sonner's and ui/radix/Sonner's Toaster wrote one file.
  const dir = tempDir();
  try {
    const base = writeScreenshot(dir, { id: "ui-base-sonner", name: "Toaster" } as never, "default", Buffer.from("base"));
    const radix = writeScreenshot(dir, { id: "ui-radix-sonner", name: "Toaster" } as never, "default", Buffer.from("radix"));
    assert.deepEqual([base, radix], ["ui-base-sonner/default.png", "ui-radix-sonner/default.png"]);
    assert.equal(readFileSync(join(dir, base), "utf8"), "base");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeScreenshot: a slug too long for a file name is shortened, distinctly and the same every run", () => {
  // Every combination of vaul's Drawer is a slug of some 330 characters, past
  // the 255 a file name can have: writing it failed the whole component.
  const long = Array.from({ length: 16 }, (_, i) => `prop${i}-false`).join("--") + "--direction-bottom";
  // Differing only past the part of it kept whole.
  const other = long.replace("direction-bottom", "direction-top");
  const dir = tempDir();
  try {
    const recorded = writeScreenshot(dir, { id: "ui-drawer", name: "Drawer", title: "UI/Drawer" } as never, long, Buffer.from("png"));
    assert.ok(existsSync(join(dir, recorded)));
    const name = recorded.split("/").pop()!;
    assert.ok(name.length <= 124, name);
    assert.equal(name, screenshotName(long));
    assert.notEqual(screenshotName(other), name);
    // A slug that fits is the file name, as before.
    assert.equal(screenshotName("variant-primary"), "variant-primary.png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- every combination, and the cap ---

const SIZE_PROPS = [
  { name: "variant", type: "VARIANT", values: ["primary", "danger", "outline"], defaultValue: "primary" },
  { name: "size", type: "VARIANT", values: ["sm", "lg"], defaultValue: "sm" },
  { name: "disabled", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" },
] as never[];

test("selectCombinations: under --variants all, the default combination leads, so it becomes the base", () => {
  // In cartesian order a boolean declared [true, false] would make the disabled
  // variant the base, and every enabled variant would read as a delta from it.
  const full = [
    { variant: "primary", size: "sm", disabled: "true" },
    { variant: "primary", size: "sm", disabled: "false" },
    { variant: "danger", size: "sm", disabled: "true" },
  ];
  const picked = selectCombinations("all", SIZE_PROPS, full);
  assert.deepEqual(picked[0], { variant: "primary", size: "sm", disabled: "false" });
  assert.equal(picked.length, full.length);
  assert.deepEqual(new Set(picked.map((c) => JSON.stringify(c))), new Set(full.map((c) => JSON.stringify(c))));
});

test("selectCombinations: representative mode is unchanged by the reordering", () => {
  const picked = selectCombinations("representative", SIZE_PROPS, []);
  assert.deepEqual(picked[0], { variant: "primary", size: "sm", disabled: "false" });
  assert.equal(picked.length, 5);
});

test("runSnap: a component over the limit is recorded as capped, warned about, and counted", async () => {
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir, { variants: "all", maxCombinations: 4 }), {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button", title: "Forms/Button" }],
        getComponent: async () => ({
          name: "Button",
          props: [
            { name: "variant", type: { name: "string" }, control: { type: "select", options: ["a", "b", "c"] } },
            { name: "size", type: { name: "string" }, control: { type: "select", options: ["sm", "md", "lg"] } },
          ],
          stories: [{ id: "forms-button--default", name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
          close: async () => {},
        },
      }) as never,
    });

    const [button] = result.components;
    // 3 x 3 = 9 combinations against a limit of 4: a subset was measured, and
    // whoever builds from it has to be told rather than handed it as the whole.
    assert.equal(button.cap?.totalPossible, 9);
    assert.equal(button.cap?.maxCombinations, 4);
    assert.ok(button.warnings.some((w) => /9 variant combinations, more than the limit of 4/.test(w)), JSON.stringify(button.warnings));
    assert.equal(result.summary.componentsCapped, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a component within the limit is not capped", async () => {
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir, { variants: "all" }), {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async () => ({
          name: "Button",
          props: [{ name: "size", type: { name: "string" }, control: { type: "select", options: ["sm", "lg"] } }],
          stories: [{ id: "forms-button--default", name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: { newContext: async () => ({ newPage: async () => ({}), close: async () => {} }), close: async () => {} },
      }) as never,
    });
    assert.equal(result.components[0].cap, undefined);
    assert.equal(result.summary.componentsCapped, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// vaul's Drawer maps 15 booleans, 131072 combinations, and was capped with no
// way to leave its behavioral props out.
test("runSnap: --exclude-props leaves the named props out of every component's variants", async () => {
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir, { variants: "all", excludeProps: ["MODAL", "loop"] }), {
      storybook: {
        listComponents: async () => [{ id: "overlay-drawer", name: "Drawer" }],
        getComponent: async () => ({
          name: "Drawer",
          props: [
            { name: "modal", type: { name: "boolean" }, defaultValue: "true" },
            { name: "direction", type: { name: "union", raw: `"bottom" | "top"` }, defaultValue: "bottom" },
            { name: "loop", type: { name: "boolean" } },
          ],
          stories: [{ id: "overlay-drawer--default", name: "Default" }],
        }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: { newContext: async () => ({ newPage: async () => ({}), close: async () => {} }), close: async () => {} },
      }) as never,
    });
    const [drawer] = result.components;
    assert.deepEqual(drawer.variantProperties.map((p) => p.name), ["direction"]);
    assert.deepEqual(drawer.variants.map((v) => v.combination), [{ direction: "bottom" }, { direction: "top" }]);
    // Recorded in styles.json, which the push builds from, so an audit can
    // leave out the same props rather than report them missing from Figma.
    assert.deepEqual(result.excludeProps, ["MODAL", "loop"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "styles.json"), "utf8")).excludeProps, ["MODAL", "loop"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("describeCap: names the total, the limit, and how to build the full set", () => {
  const message = describeCap("Forms/Button", {
    maxCombinations: 256, totalPossible: 300, generated: 256, droppedCount: 44, droppedSample: [],
  });
  assert.match(message, /Forms\/Button has 300 variant combinations, more than the limit of 256/);
  assert.match(message, /--max-combinations 300/);
  assert.match(message, /leave out props that don't change how it looks with --exclude-props/);
});

test("uncoveredValues: names declared values no combination includes", () => {
  // Covering every value of this Button takes 5 combinations; a limit of 4 cannot,
  // and the capped subset measured in practice had no disabled variant at all.
  const measured = [
    { variant: "primary", size: "sm", disabled: "false" },
    { variant: "danger", size: "sm", disabled: "false" },
    { variant: "outline", size: "sm", disabled: "false" },
    { variant: "primary", size: "lg", disabled: "false" },
  ];
  assert.deepEqual(uncoveredValues(SIZE_PROPS, measured), ["disabled=true"]);
  assert.deepEqual(uncoveredValues(SIZE_PROPS, [...measured, { variant: "primary", size: "sm", disabled: "true" }]), []);
});

test("describeCap: never claims coverage the subset does not have", () => {
  const cap = { maxCombinations: 4, totalPossible: 12, generated: 4, droppedCount: 8, droppedSample: [] };
  const short = describeCap("Forms/Button", { ...cap, uncovered: ["disabled=true"] });
  assert.match(short, /which leave out disabled=true entirely/);
  assert.doesNotMatch(short, /cover every value/);
  assert.match(describeCap("Forms/Button", { ...cap, uncovered: [] }), /cover every value/);
});

// --- properties that change nothing ---

const SWITCH_PROPS = [
  { name: "asChild", type: "BOOLEAN", values: ["false", "true"], defaultValue: "false" },
  { name: "size", type: "VARIANT", values: ["default", "sm"], defaultValue: "default" },
] as never[];

function measuredVariant(combination: Record<string, string>, delta: Record<string, unknown>, status: SnapVariant["status"] = "ok"): SnapVariant {
  return { combination, slug: JSON.stringify(combination), status, error: null, delta: delta as never };
}

test("detectNoOpProperties: names a property whose values measure the same wherever the others hold still", () => {
  // Radix Switch, every combination: asChild changed nothing, size did, so
  // the all-identical warning never fired and asChild became a Figma axis.
  const small = { width: 24, height: 14 };
  const variants = [
    measuredVariant({ asChild: "false", size: "default" }, {}),
    measuredVariant({ asChild: "true", size: "default" }, {}),
    measuredVariant({ asChild: "false", size: "sm" }, small),
    measuredVariant({ asChild: "true", size: "sm" }, small),
  ];
  assert.deepEqual(detectNoOpProperties(SWITCH_PROPS, variants), ["asChild"]);
  // Representative mode measures each value against the others' defaults.
  assert.deepEqual(detectNoOpProperties(SWITCH_PROPS, [variants[0], variants[1], variants[2]]), ["asChild"]);
});

test("detectNoOpProperties: a property is judged only on values measured side by side", () => {
  const variants = [
    measuredVariant({ asChild: "false", size: "default" }, {}),
    measuredVariant({ asChild: "true", size: "default" }, {}, "element_not_found"),
    measuredVariant({ asChild: "false", size: "sm" }, { width: 24 }),
  ];
  // asChild=true never rendered, so nothing says asChild changes nothing.
  assert.deepEqual(detectNoOpProperties(SWITCH_PROPS, variants), []);
  // One that differs anywhere is live.
  assert.deepEqual(detectNoOpProperties(SWITCH_PROPS, [
    measuredVariant({ asChild: "false", size: "default" }, {}),
    measuredVariant({ asChild: "true", size: "default" }, {}),
    measuredVariant({ asChild: "false", size: "sm" }, { width: 24 }),
    measuredVariant({ asChild: "true", size: "sm" }, { width: 30 }),
  ]), []);
});

test("describeIdenticalVariants: blames the story only where the markup didn't change either", () => {
  // InputOTP's story passes its args through, but textAlign and
  // pushPasswordManagerStrategy change only input-otp's hidden input, so
  // every variant measured the same, and snap's warning, and the push's
  // summary after it, said the story wasn't passing its args through.
  const OTP_PROPS = [
    { name: "textAlign", type: "VARIANT", values: ["center", "left", "right"], defaultValue: "center", defaultAssumed: true },
    { name: "pushPasswordManagerStrategy", type: "VARIANT", values: ["none", "increase-width"], defaultValue: "none", defaultAssumed: true },
  ] as never[];
  const variants = [
    measuredVariant({ textAlign: "center", pushPasswordManagerStrategy: "none" }, {}),
    measuredVariant({ textAlign: "left", pushPasswordManagerStrategy: "none" }, {}),
    measuredVariant({ textAlign: "right", pushPasswordManagerStrategy: "none" }, {}),
    measuredVariant({ textAlign: "center", pushPasswordManagerStrategy: "increase-width" }, {}, "timeout"),
  ];

  // The markup changed with the args: they reach the component.
  const behavior = describeIdenticalVariants(variants, OTP_PROPS, ["a", "b", "c"])!;
  assert.doesNotMatch(behavior, /story may not pass/);
  assert.match(behavior, /^all 3 rendered variants measured identically, though their markup changed with the args, so the story passes them through: `textAlign`, `pushPasswordManagerStrategy` change nothing snap measures, likely only behavior/);
  assert.match(behavior, /leave them out of every component with `--exclude-props textAlign,pushPasswordManagerStrategy`/);
  assert.deepEqual(parseBehaviorOnlyWarning(behavior), ["textAlign", "pushPasswordManagerStrategy"]);
  assert.match(behavior, /something it doesn't measure, such as a child element\./);
  // With trees, a child element is measured: what isn't is a state or an animation.
  const treeBehavior = describeIdenticalVariants(variants, OTP_PROPS, ["a", "b", "c"], { tree: true })!;
  assert.match(treeBehavior, /something it doesn't measure, such as a hover or focus state, or an animation\. If they don't change how it looks/);
  assert.deepEqual(parseBehaviorOnlyWarning(treeBehavior), ["textAlign", "pushPasswordManagerStrategy"]);

  // The same markup on every variant: nothing the args set reached the page.
  const frozen = describeIdenticalVariants(variants, OTP_PROPS, ["a", "a", "a"])!;
  assert.match(frozen, /^all 3 rendered variants measured identically and rendered the same markup — the story may not pass args through to the component/);
  assert.equal(parseBehaviorOnlyWarning(frozen), null);

  // A markup not read, or one that changed while it was measured: either.
  for (const markups of [["a", null, "b"], ["a", "b"]]) {
    const either = describeIdenticalVariants(variants, OTP_PROPS, markups)!;
    assert.match(either, /the story may not pass args through[\s\S]* Or `textAlign`, `pushPasswordManagerStrategy` change only behavior, which snap doesn't measure: if so, leave them out of every component with `--exclude-props textAlign,pushPasswordManagerStrategy`\.$/);
    assert.equal(parseBehaviorOnlyWarning(either), null);
  }

  // Variants that differ: nothing to say, as before.
  assert.equal(describeIdenticalVariants([variants[0], measuredVariant({ textAlign: "left", pushPasswordManagerStrategy: "none" }, { width: 30 })], OTP_PROPS, ["a", "b"]), null);
  assert.equal(detectIdenticalVariants(variants) !== null, true);
});

test("describeNoOpProperties: names each property and what to do about it", () => {
  assert.equal(describeNoOpProperties([]), null);
  const one = describeNoOpProperties(["asChild"])!;
  assert.match(one, /^`asChild`: every value measured the same, so it changes nothing snap records/);
  assert.match(one, /may not belong as Figma variant properties/);
  assert.match(describeNoOpProperties(["asChild", "side"])!, /^`asChild`, `side`: .* they change nothing/);
  // Ready to run, as the cap warning's advice is.
  assert.match(one, /leave it out of every component with `--exclude-props asChild`\. If the story drops it, pass it through/);
  assert.match(describeNoOpProperties(["asChild", "side"])!, /leave them out of every component with `--exclude-props asChild,side`\./);
});

// --- elements that may not be the component ---

test("describeMeasurementNotes: a closed trigger says what to change so the content is measured", () => {
  const [warning] = describeMeasurementNotes("Dialog", [
    { slug: "default", note: { kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]' } },
  ], 1);
  assert.match(warning, /^snap measured button\[data-slot="dialog-trigger"\], a closed trigger, rather than Dialog\./);
  assert.match(warning, /render Dialog open, with defaultOpen/);
  assert.match(warning, /data-slot="dialog-content"/);
});

test("describeMeasurementNotes: a closed trigger names the content slots snap takes, from the title too", () => {
  const trigger = [{ slug: "default", note: { kind: "closed-trigger" as const, element: 'button[data-slot="tooltip-trigger"]' } }];
  // TooltipContent's own slot is already its content's: it was told to add
  // data-slot="tooltip-content-content".
  const [tooltip] = describeMeasurementNotes("TooltipContent", trigger, 1, "ui/base/Tooltip");
  assert.match(tooltip, /carries data-slot="tooltip-content", that/);
  assert.doesNotMatch(tooltip, /content-content/);
  // Or any open overlay's content in a portal, which needs no slot.
  assert.match(tooltip, /that the trigger's aria-controls names, or that is a dialog, alert dialog, tooltip or menu in a portal\.$/);
  // A component named apart from its title is matched by both.
  const [demo] = describeMeasurementNotes("DialogDemo", trigger, 1, "Overlays/Dialog");
  assert.match(demo, /data-slot="dialog-demo-content" or "dialog-content"/);
});

test("describeMeasurementNotes: a layout wrapper says how to point snap at the component", () => {
  const notes = [
    { slug: "size-default", note: { kind: "layout-wrapper" as const, element: "div", children: 2 } },
    { slug: "size-sm", note: { kind: "layout-wrapper" as const, element: "div", children: 2 } },
  ];
  const warnings = describeMeasurementNotes("Switch", notes, 3);
  // One warning for the same element across variants, saying how many.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^snap measured div, which holds 2 elements and draws nothing itself/);
  assert.match(warnings[0], /rather than Switch in 2 of 3 measured variants\./);
  assert.match(warnings[0], /data-slot="switch"/);
  // Measured again with --components alone, styles.json held Switch alone,
  // and verify scored a push of one component.
  assert.match(warnings[0], /measure it by itself into this snap with --components, --selector and --merge \(without --merge, styles\.json would hold Switch alone\)\./);
  assert.deepEqual(describeMeasurementNotes("Switch", [], 3), []);
});

test("parseMeasurementWarning: reads back the element a measurement warning names, and nothing else", () => {
  const [trigger] = describeMeasurementNotes("Dialog", [
    { slug: "default", note: { kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]' } },
  ], 1, "Overlays/Dialog");
  assert.deepEqual(parseMeasurementWarning(trigger), { kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]' });
  const [wrapper] = describeMeasurementNotes("Switch", [{ slug: "a", note: { kind: "layout-wrapper", element: "div", children: 3 } }], 2);
  assert.deepEqual(parseMeasurementWarning(wrapper), { kind: "layout-wrapper", element: "div", children: 3 });
  assert.equal(parseMeasurementWarning(describeNoOpProperties(["asChild"])!), null);
  assert.equal(parseMeasurementWarning("the browser could not render \"Inter\""), null);
});

test("parseSnapWarning: names each warning snap writes as it writes it, so verify can say it beside the score", () => {
  // A third live push's verify said nothing of what snap had warned: values
  // alike on Attachment and Sidebar, values set through the preview on
  // Badge and Button. Each warning is read back from the function that
  // writes it, so a change to its words can't leave verify blind to it.
  const [trigger] = describeMeasurementNotes("Dialog", [{ slug: "a", note: { kind: "closed-trigger", element: "button" } }], 1);
  const [wrapper] = describeMeasurementNotes("Switch", [{ slug: "a", note: { kind: "layout-wrapper", element: "div", children: 3 } }], 1);
  const property: FigmaVariantProperty = { name: "size", type: "VARIANT", values: ["sm", "lg"], defaultValue: "sm" };
  const same = [{ slug: "a", status: "ok", combination: { size: "sm" }, delta: {} }, { slug: "b", status: "ok", combination: { size: "lg" }, delta: {} }] as unknown as SnapVariant[];
  const identical = describeIdenticalVariants(same, [property], [null, null])!;
  const [values] = describeIdenticalValues([{ property: "state", values: ["done", "uploading", "processing"] }]);
  const [pair] = describeIdenticalValues([{ property: "collapsible", values: ["offcanvas", "icon"] }]);
  const rejection = { name: "variant", value: "link", reasons: ["not-in-options" as const], options: ["default"] };
  const [preview] = describeArgRejections("ui/base/Badge", [{ combination: { variant: "link" }, status: "ok", appliedVia: "preview", rejectedArgs: [rejection] }]);
  const [rejected] = describeArgRejections("ui/base/Badge", [{ combination: { variant: "link" }, status: "arg_rejected", rejectedArgs: [rejection] }]);
  const unchecked = describeUncheckedArgs("ui/base/Badge", ["a"], 2)!;
  const truncated = describeTruncatedTrees([{ slug: "a", truncated: { nodes: 900, at: "list/item" } }], 1)!;
  const font = detectFontSubstitution(componentWithFonts(false))!;
  const shared = `2 components share the key "Forms/Button", which identifies a component in the readback and during verification — their variants will collide and only one will be scored. Give them distinct Storybook titles.`;
  assert.deepEqual(
    [trigger, wrapper, identical, values, pair, describeNoOpProperties(["asChild", "modal"])!, preview, rejected, unchecked, truncated, font, shared].map(parseSnapWarning),
    [
      { kind: "closed-trigger" }, { kind: "layout-wrapper" }, { kind: "identical-variants" },
      { kind: "identical-values", values: ["state=done", "state=uploading", "state=processing"] },
      { kind: "identical-values", values: ["collapsible=offcanvas", "collapsible=icon"] },
      { kind: "no-op-properties", properties: ["asChild", "modal"] },
      { kind: "preview-set" }, { kind: "args-rejected" }, { kind: "args-unchecked" }, { kind: "truncated-tree" },
      { kind: "font-stand-in", fonts: ["Inter"] }, { kind: "shared-key" },
    ],
  );
  // The rest verify says as snap wrote them.
  const climbed = describeClimbed([{ slug: "a", element: "div[data-slot=\"card\"]", from: "span" }], 1)!;
  const cap = describeCap("Forms/Button", { totalPossible: 300, maxCombinations: 256, generated: 256, wasCapped: true } as never);
  const collided = describeSlugCollisions([{ combination: { size: "Sm" }, slug: "size-sm-2", base: "size-sm" }] as never)!;
  for (const warning of [climbed, cap, collided, "ui/base/Avatar: snap couldn't draw a thumbnail of img:1 (boom), so the nodes showing it are kept as frames without it."]) {
    assert.equal(parseSnapWarning(warning), null, warning);
  }
});

// --- a run that is stopped ---

/** A browser whose pages fail to load, as stand-ins for runSnap, closed when `close` is called. */
function stubBrowser(onNavigate: () => void = () => {}) {
  let connected = true;
  return {
    isConnected: () => connected,
    newContext: async () => ({
      newPage: async () => ({
        on: () => {}, off: () => {},
        goto: async () => { onNavigate(); throw new Error("net::ERR_CONNECTION_REFUSED"); },
      }),
      close: async () => {},
    }),
    close: async () => { connected = false; },
    disconnect: () => { connected = false; },
  };
}

const THREE_COMPONENTS = {
  listComponents: async () => [
    { id: "forms-a", name: "A" }, { id: "forms-b", name: "B" }, { id: "forms-c", name: "C" },
  ],
  getComponent: async (id: string) => ({ name: id, props: [], stories: [{ id: `${id}--default`, name: "Default" }] }),
};

test("runSnap: leaves signals to the snap command, which exits on them at once", async () => {
  // runSnap and the CLI each listened for SIGTERM: two notices, and a stop
  // that waited on a docs request still in flight. The snap command's
  // handlers are the only ones (cli-connect.test.ts runs them for real).
  const dir = tempDir();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = signals.map((signal) => process.listenerCount(signal));
  try {
    const during: number[][] = [];
    const browser = stubBrowser(() => { during.push(signals.map((signal) => process.listenerCount(signal))); });
    await runSnap(options(dir), { storybook: THREE_COMPONENTS as never, launch: async () => ({ via: "stub", browser }) as never });
    assert.equal(during.length, 3);
    for (const counts of during) assert.deepEqual(counts, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a browser that goes away mid-run is launched again, and the component it was on measured again", async () => {
  // Stopping lost the whole run, however long it had been going, for one crash.
  const dir = tempDir();
  try {
    const visited: string[] = [];
    const first = stubBrowser(() => {
      if (visited.push("first") === 2) first.disconnect();
    });
    const second = stubBrowser(() => { visited.push("second"); });
    const browsers = [first, second];
    const result = await runSnap(options(dir), {
      storybook: THREE_COMPONENTS as never,
      launch: async () => ({ via: "stub", browser: browsers.shift() }) as never,
    });
    // B's first try went with the first browser; B and C were measured with the second.
    assert.deepEqual(visited, ["first", "first", "second", "second"]);
    assert.deepEqual(result.components.map((c) => [c.name, c.error, c.variants.length]), [["A", null, 1], ["B", null, 1], ["C", null, 1]]);
    assert.ok(existsSync(join(dir, "styles.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a browser that goes away twice fails the run rather than failing every component left", async () => {
  const dir = tempDir();
  try {
    let navigations = 0;
    const launch = async () => {
      const browser = stubBrowser(() => {
        if (++navigations >= 2) browser.disconnect();
      });
      return { via: "stub", browser } as never;
    };
    await assert.rejects(
      () => runSnap(options(dir), { storybook: THREE_COMPONENTS as never, launch }),
      (err: unknown) => {
        assert.ok(err instanceof BrowserLostError, String(err));
        assert.equal(
          String(err),
          "Error: The browser closed before snap finished (it crashed, or something stopped it), with 1 of 3 components read. " +
            "styles.json and meta.json were left as they were. Run snap again.",
        );
        return true;
      },
    );
    assert.equal(navigations, 3);
    assert.equal(existsSync(join(dir, "styles.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a story that times out is tried once more before it is recorded", async () => {
  // A busy Storybook times out stories that render a moment later, and the
  // push builds an unmeasured variant from source.
  const dir = tempDir();
  try {
    let navigations = 0;
    const timeout = Object.assign(new Error("page.goto: Timeout 1000ms exceeded."), { name: "TimeoutError" });
    const result = await runSnap(options(dir), {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async () => ({ name: "Button", props: [], stories: [{ id: "forms-button--default", name: "Default" }] }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({
            newPage: async () => ({ on: () => {}, off: () => {}, goto: async () => { navigations++; throw timeout; } }),
            close: async () => {},
          }),
          close: async () => {},
        },
      }) as never,
    });
    assert.equal(navigations, 2);
    assert.equal(result.components[0].variants[0].status, "timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a story that times out after it loaded is not tried again", async () => {
  // A screenshot of an element that never becomes visible times out the
  // same way every time.
  const dir = tempDir();
  try {
    let navigations = 0;
    const timeout = Object.assign(new Error("elementHandle.screenshot: Timeout 1000ms exceeded."), { name: "TimeoutError" });
    let described = false;
    const target = {
      evaluate: async () => {
        if (described) return null;
        described = true;
        return { tag: "div", slot: null, role: null };
      },
      evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
      boundingBox: async () => ({ x: 0, y: 0, width: 40, height: 20 }),
      screenshot: async () => { throw timeout; },
    };
    const page = {
      on: () => {}, off: () => {},
      goto: async () => { navigations++; return null; },
      waitForSelector: async () => null,
      addStyleTag: async () => null,
      $: async () => target,
      evaluate: async (_fn: unknown, arg?: unknown) => (arg ? {} : null),
    };
    const result = await runSnap(options(dir, { screenshots: true, selector: "#storybook-root > div" }), {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async () => ({ name: "Button", props: [], stories: [{ id: "forms-button--default", name: "Default" }] }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: { newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} },
      }) as never,
    });
    assert.equal(navigations, 1);
    assert.equal(result.components[0].variants[0].status, "timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A page on which every story loads and its --selector element measures, with a screenshot. */
function screenshotPage(onNavigate: () => void = () => {}) {
  return {
    on: () => {}, off: () => {},
    goto: async () => { onNavigate(); return null; },
    waitForSelector: async () => null,
    addStyleTag: async () => null,
    $: async () => {
      let described = false;
      return {
        evaluate: async (fn: unknown) => {
          if (fn === captureTreeInPage) return bareTree();
          if (described) return null;
          described = true;
          return { tag: "div", slot: null, role: null };
        },
        evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
        boundingBox: async () => ({ x: 0, y: 0, width: 40, height: 20 }),
        screenshot: async () => Buffer.from("new png"),
      };
    },
    evaluate: async (_fn: unknown, arg?: unknown) => (arg ? {} : null),
  };
}

test("runSnap: screenshots reach the output directory once the run has finished", async () => {
  const dir = tempDir();
  try {
    const page = screenshotPage();
    const result = await runSnap(options(dir, { screenshots: true, selector: "#storybook-root > div" }), {
      storybook: THREE_COMPONENTS as never,
      launch: async () => ({
        via: "stub",
        browser: { newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} },
      }) as never,
    });
    const recorded = result.components.map((c) => c.variants[0].screenshot);
    assert.deepEqual(recorded, ["forms-a/default.png", "forms-b/default.png", "forms-c/default.png"]);
    for (const path of recorded) assert.equal(readFileSync(join(dir, path!), "utf8"), "new png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a stopped run leaves the last run's screenshots as they were", async () => {
  // Each PNG was written as its variant was measured, so a run stopped
  // part-way replaced some of the screenshots of the styles.json it kept.
  const dir = tempDir();
  const earlier = join(dir, "forms-a", "default.png");
  mkdirSync(dirname(earlier), { recursive: true });
  writeFileSync(earlier, "earlier png");
  try {
    // A measured, then the browser lost on B, and lost again once relaunched.
    let navigations = 0;
    let current = { connected: true };
    const page = screenshotPage(() => {
      if (++navigations >= 2) current.connected = false;
    });
    const launch = async () => {
      const state = { connected: true };
      current = state;
      const browser = {
        isConnected: () => state.connected,
        newContext: async () => ({ newPage: async () => page, close: async () => {} }),
        close: async () => {},
      };
      return { via: "stub", browser } as never;
    };
    await assert.rejects(
      () => runSnap(options(dir, { screenshots: true, selector: "#storybook-root > div" }), { storybook: THREE_COMPONENTS as never, launch }),
      (err: unknown) => err instanceof BrowserLostError && /styles\.json, meta\.json and the screenshots were left as they were/.test(err.message),
    );
    assert.equal(navigations, 3);
    assert.equal(readFileSync(earlier, "utf8"), "earlier png");
    assert.equal(existsSync(join(dir, "forms-b")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ScreenshotStage: moves what it staged into the output directory, or discards it", () => {
  const dir = tempDir();
  const entry = { id: "forms-button", name: "Button", title: "Forms/Button" } as never;
  try {
    const kept = new ScreenshotStage(dir);
    assert.equal(kept.write(entry, "variant-primary", Buffer.from("png")), "forms-button/variant-primary.png");
    assert.equal(existsSync(join(dir, "forms-button")), false);
    kept.commit();
    assert.equal(readFileSync(join(dir, "forms-button", "variant-primary.png"), "utf8"), "png");

    const dropped = new ScreenshotStage(dir);
    dropped.write(entry, "variant-danger", Buffer.from("png"));
    dropped.discard();
    assert.equal(existsSync(join(dir, "forms-button", "variant-danger.png")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ScreenshotStage: what it staged goes with the process when it exits part-way", { skip: process.platform === "win32" }, () => {
  // The snap command exits at once on a signal, past runSnap's finally, which
  // left the staged PNGs in the OS's temporary directory.
  const out = tempDir();
  const tmp = tempDir();
  try {
    const snap = new URL("../snap.js", import.meta.url).href;
    const script = [
      `const { ScreenshotStage } = await import(${JSON.stringify(snap)});`,
      `const { readdirSync, writeSync } = await import("node:fs");`,
      `new ScreenshotStage(${JSON.stringify(out)}).write({ id: "forms-button", name: "Button" }, "default", Buffer.from("png"));`,
      `writeSync(1, String(readdirSync(${JSON.stringify(tmp)}).length));`,
      `process.exit(143);`,
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      encoding: "utf8",
    });
    assert.equal(run.status, 143, run.stderr);
    assert.equal(run.stdout, "1", "nothing was staged");
    assert.deepEqual(readdirSync(tmp), []);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ScreenshotStage: drops what it staged for one component, leaving the others", () => {
  const dir = tempDir();
  const button = { id: "forms-button", name: "Button", title: "Forms/Button" } as never;
  const card = { id: "forms-card", name: "Card", title: "Forms/Card" } as never;
  try {
    const stage = new ScreenshotStage(dir);
    stage.write(button, "size-sm", Buffer.from("first try"));
    stage.write(card, "default", Buffer.from("card"));
    stage.drop(button);
    stage.commit();
    assert.equal(existsSync(join(dir, "forms-button")), false);
    assert.equal(readFileSync(join(dir, "forms-card", "default.png"), "utf8"), "card");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a component measured again after a relaunch keeps none of its first attempt's screenshots", async () => {
  // Its first attempt's PNG stayed staged, and was committed over the last
  // run's although the second attempt took none and styles.json no longer
  // pointed to it.
  const dir = tempDir();
  const earlier = join(dir, "forms-a", "default.png");
  mkdirSync(dirname(earlier), { recursive: true });
  writeFileSync(earlier, "earlier png");
  try {
    const first = { connected: true };
    const page = screenshotPage(() => { first.connected = false; });
    const browsers = [
      { isConnected: () => first.connected, newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} },
      stubBrowser(),
    ];
    const result = await runSnap(options(dir, { screenshots: true, selector: "#storybook-root > div" }), {
      storybook: { listComponents: async () => [{ id: "forms-a", name: "A" }], getComponent: THREE_COMPONENTS.getComponent } as never,
      launch: async () => ({ via: "stub", browser: browsers.shift() }) as never,
    });
    assert.notEqual(result.components[0].variants[0].status, "ok");
    assert.equal(result.components[0].variants[0].screenshot, undefined);
    assert.equal(readFileSync(earlier, "utf8"), "earlier png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: the browser is closed before the screenshots and styles.json are written", async () => {
  // A signal while it closed, after the screenshots were moved in, left them
  // beside the last run's styles.json.
  const dir = tempDir();
  try {
    const page = screenshotPage();
    const seen: string[] = [];
    await runSnap(options(dir, { screenshots: true, selector: "#storybook-root > div" }), {
      storybook: { listComponents: async () => [{ id: "forms-a", name: "A" }], getComponent: THREE_COMPONENTS.getComponent } as never,
      launch: async () => ({
        via: "stub",
        browser: {
          newContext: async () => ({ newPage: async () => page, close: async () => {} }),
          close: async () => { seen.push(readdirSync(dir).join(",")); },
        },
      }) as never,
    });
    assert.deepEqual(seen, [""]);
    assert.ok(existsSync(join(dir, "forms-a", "default.png")));
    assert.ok(existsSync(join(dir, "styles.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- --merge ---

/** Three components with no props; each run's stories are named `story`, so a run can be told by them. */
function mergeStorybook(story: string) {
  return {
    listComponents: async () => ["a", "b", "c"].map((x) => ({ id: `forms-${x}`, name: x.toUpperCase(), title: `Forms/${x.toUpperCase()}` })),
    getComponent: async (id: string) => ({ name: id, props: [], stories: [{ id: `${id}--${story}`, name: story }] }),
  };
}

async function snapAt(dir: string, story: string, at: string, overrides: Partial<SnapOptions> = {}) {
  return runSnap(options(dir, overrides), {
    storybook: mergeStorybook(story) as never,
    launch: async () => ({ via: "stub", browser: stubBrowser() }) as never,
    now: () => Date.parse(at),
  });
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("runSnap --merge: measures only the components named and keeps the rest of the snap, with each one's time", async () => {
  // Re-run for some components alone, snap wrote a styles.json of those
  // alone, and verify then scored a push of every component on them.
  const dir = tempDir();
  try {
    await snapAt(dir, "first", "2026-10-01T10:00:00.000Z");
    const merged = await snapAt(dir, "second", "2026-10-01T11:00:00.000Z", { components: ["forms-b"], merge: true });
    assert.deepEqual(merged.components.map((c) => [c.title, c.storyId]), [
      ["Forms/A", "forms-a--first"], ["Forms/B", "forms-b--second"], ["Forms/C", "forms-c--first"],
    ]);
    assert.equal(merged.summary.components, 3);
    assert.deepEqual(readJson(join(dir, "styles.json")), JSON.parse(JSON.stringify(merged)));
    const meta = readJson(join(dir, "meta.json"));
    // As old as its oldest component.
    assert.equal(meta.measuredAt, "2026-10-01T10:00:00.000Z");
    assert.equal(meta.components, 3);
    assert.deepEqual(meta.componentsMeasuredAt, {
      "Forms/A": "2026-10-01T10:00:00.000Z", "Forms/B": "2026-10-01T11:00:00.000Z", "Forms/C": "2026-10-01T10:00:00.000Z",
    });

    // Merged again, each keeps the time it was measured, and the snap is
    // as old as whichever is now oldest.
    await snapAt(dir, "third", "2026-10-01T12:00:00.000Z", { components: ["Forms/A", "C"], merge: true });
    const again = readJson(join(dir, "meta.json"));
    assert.equal(again.measuredAt, "2026-10-01T11:00:00.000Z");
    assert.deepEqual(again.componentsMeasuredAt, {
      "Forms/A": "2026-10-01T12:00:00.000Z", "Forms/B": "2026-10-01T11:00:00.000Z", "Forms/C": "2026-10-01T12:00:00.000Z",
    });

    // A run of every component, without --merge, is one time again.
    await snapAt(dir, "fourth", "2026-10-01T13:00:00.000Z");
    const whole = readJson(join(dir, "meta.json"));
    assert.equal(whole.measuredAt, "2026-10-01T13:00:00.000Z");
    assert.equal(whole.componentsMeasuredAt, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap --merge: refuses a snap it can't add to honestly, before measuring anything, and writes nothing", async () => {
  const dir = tempDir();
  const refuse = async (pattern: RegExp, overrides: Partial<SnapOptions> = {}) => {
    const before = existsSync(join(dir, "styles.json")) ? readFileSync(join(dir, "styles.json"), "utf8") : null;
    await assert.rejects(
      () => runSnap(options(dir, { components: ["forms-b"], merge: true, ...overrides }), { storybook: mergeStorybook("x") as never, launch: launchShouldNotHappen }),
      (err: unknown) => pattern.test(String(err)) || assert.fail(String(err)),
    );
    assert.equal(existsSync(join(dir, "styles.json")) ? readFileSync(join(dir, "styles.json"), "utf8") : null, before);
  };
  try {
    await refuse(/--merge adds to the snap in .*, but .*styles\.json doesn't exist\. Run snap without --merge/);
    await snapAt(dir, "first", "2026-10-01T10:00:00.000Z");
    await refuse(/which were measured with --variants representative: pass the same/, { variants: "all" });
    await refuse(/which were measured from http:\/\/localhost:6006, not http:\/\/localhost:6007/, { storybookUrl: "http://localhost:6007" });
    // A trailing slash is the same Storybook.
    await runSnap(options(dir, { components: ["forms-b"], merge: true, storybookUrl: "http://localhost:6006/" }), {
      storybook: mergeStorybook("x") as never, launch: async () => ({ via: "stub", browser: stubBrowser() }) as never,
    });

    const styles = readJson(join(dir, "styles.json"));
    writeFileSync(join(dir, "styles.json"), JSON.stringify({ ...styles, storysyncVersion: "0.3.0" }));
    await refuse(new RegExp(`storysync 0\\.3\\.0 measured them, not ${VERSION.replace(/\./g, "\\.")}`));
    writeFileSync(join(dir, "styles.json"), JSON.stringify(styles));

    rmSync(join(dir, "meta.json"));
    await refuse(/meta\.json doesn't exist, so how old they are is unknown\. Run snap without --merge/);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ version: 1 }));
    await refuse(/meta\.json has no measuredAt, so how old they are is unknown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap --merge: refuses other --exclude-props than the snap's, and keeps its record with the same", async () => {
  // A merge without the flag measured those props again for the components
  // it named, and wrote a styles.json with no excludeProps for the audit.
  const dir = tempDir();
  const merge = (excludeProps?: string[]) =>
    runSnap(options(dir, { components: ["forms-b"], merge: true, ...(excludeProps ? { excludeProps } : {}) }), {
      storybook: mergeStorybook("x") as never, launch: async () => ({ via: "stub", browser: stubBrowser() }) as never,
    });
  try {
    await snapAt(dir, "first", "2026-10-01T10:00:00.000Z", { excludeProps: ["modal", "loop"] });
    const before = readFileSync(join(dir, "styles.json"), "utf8");
    for (const other of [undefined, ["modal"], ["modal", "loop", "orientation"]]) {
      await assert.rejects(() => merge(other), /which were measured with --exclude-props modal,loop: pass the same, or run snap without --merge/);
      assert.equal(readFileSync(join(dir, "styles.json"), "utf8"), before);
    }
    // The same names, in another order or case, are the same list.
    const merged = await merge(["Loop", "modal"]);
    assert.deepEqual(merged.excludeProps, ["Loop", "modal"]);
    assert.deepEqual(readJson(join(dir, "styles.json")).excludeProps, ["Loop", "modal"]);

    await snapAt(dir, "second", "2026-10-01T11:00:00.000Z");
    await assert.rejects(() => merge(["modal"]), /which were measured with no --exclude-props: pass the same/);
    await merge([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap --merge: two components sharing a key are warned about across the whole snap, once", async () => {
  const dir = tempDir();
  try {
    const twice = {
      listComponents: async () => [
        { id: "forms-a", name: "A", title: "Forms/A" }, { id: "forms-a2", name: "A", title: "Forms/A" }, { id: "forms-b", name: "B", title: "Forms/B" },
      ],
      getComponent: async (id: string) => ({ name: id, props: [], stories: [{ id: `${id}--default`, name: "Default" }] }),
    };
    const launch = async () => ({ via: "stub", browser: stubBrowser() }) as never;
    await runSnap(options(dir), { storybook: twice as never, launch });
    const merged = await runSnap(options(dir, { components: ["forms-a2"], merge: true }), { storybook: twice as never, launch });
    const shared = merged.components.map((c) => c.warnings.filter((w) => /share the key/.test(w)).length);
    assert.deepEqual(shared, [1, 1, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Args Storybook rejects ---

/**
 * A browser whose one page serves a Badge story through a stand-in
 * Storybook preview that `configure` sets up for each URL's args. The
 * element's fill is the variant the story was given.
 */
function badgeBrowser(configure: (args: Record<string, unknown>) => Omit<Parameters<typeof fakePreview>[0], "url" | "storyId">) {
  const fill: Record<string, string> = { default: "rgb(23, 23, 23)", secondary: "rgb(245, 245, 245)", ghost: "rgba(0, 0, 0, 0)", "Nav/Primary": "rgb(37, 99, 235)" };
  let fake = fakePreview({ argTypes: {}, initial: {}, url: {} });
  // The element's description, then its font stack, which the stand-in can't probe.
  let described = false;
  const target = {
    evaluate: async (fn: unknown) => {
      if (fn === captureTreeInPage) return bareTree(55, 20);
      if (described) return null;
      described = true;
      return { tag: "span", slot: "badge", role: null };
    },
    evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
    boundingBox: async () => ({ x: 0, y: 0, width: 55, height: 20 }),
  };
  const page = {
    on: () => {}, off: () => {},
    goto: async (url: string) => {
      described = false;
      const args = urlArgs(url);
      fake = fakePreview({ storyId: "ui-base-badge--default", url: args, ...configure(args) });
      return null;
    },
    waitForSelector: async () => null,
    addStyleTag: async () => null,
    $: async () => target,
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === storyArgsInPage || fn === applyStoryArgsInPage) return inPage(fake.preview, () => (fn as (a: unknown) => Promise<unknown>)(arg));
      // The element's computed styles.
      if (Array.isArray(arg) && Array.isArray(arg[1])) {
        const given = fake.preview.storyStoreValue.getStoryContext().args.variant as string;
        return { "background-color": fill[given] ?? "rgb(255, 0, 0)" };
      }
      return arg ? {} : null;
    },
  };
  return async () => ({
    via: "stub",
    browser: { newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} },
  }) as never;
}

/** The Badge as Storybook's docs describe it, with `props`. */
function badgeDocs(props: object[]) {
  return {
    listComponents: async () => [{ id: "ui-base-badge", name: "Badge", title: "ui/base/Badge" }],
    getComponent: async () => ({ name: "Badge", props, stories: [{ id: "ui-base-badge--default", name: "Default" }] }),
  } as never;
}

const BADGE_VARIANT = { name: "variant", type: { name: "union" }, defaultValue: "default", control: { type: "select", options: ["default", "secondary", "ghost", "link"] } };

test("runSnap: a value the story rejects is measured through the preview, or marked arg_rejected, never measured as the default", async () => {
  // The docs list four variants; the story's options only two, as shadcn/ui's
  // Badge story does. Its preview applies ghost and never confirms link.
  const launch = badgeBrowser((args) => ({
    argTypes: {
      variant: { options: ["default", "secondary"], type: { name: "enum" }, control: { type: "select" } },
      disabled: { type: { name: "boolean" }, control: { type: "boolean" } },
    },
    initial: { variant: "default" },
    silent: args.variant === "link",
  }));
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir, { variants: "all", selector: "[data-slot=badge]", timeoutMs: 200 }), {
      storybook: badgeDocs([BADGE_VARIANT]),
      launch,
    });
    const badge = result.components[0];
    const by = Object.fromEntries(badge.variants.map((v) => [v.combination.variant, v]));
    assert.deepEqual(Object.keys(by), ["default", "secondary", "ghost", "link"]);
    assert.deepEqual([by.default.status, by.secondary.status, by.ghost.status, by.link.status], ["ok", "ok", "ok", "arg_rejected"]);

    // ghost measured as it renders, not as the default, and says how.
    assert.equal(badge.base?.combination.variant, "default");
    assert.equal(by.ghost.delta?.backgroundColor, null);
    assert.equal(by.ghost.appliedVia, "preview");
    assert.deepEqual(by.ghost.rejectedArgs, [{ name: "variant", value: "ghost", reasons: ["not-in-options"], options: ["default", "secondary"] }]);
    assert.equal(by.secondary.rejectedArgs, undefined);

    // link measured nothing, and fails the run as an unmeasured variant does.
    assert.equal(by.link.delta, undefined);
    assert.equal(by.link.appliedVia, undefined);
    assert.match(by.link.error!, /^Storybook didn't give the story variant=link \(not-in-options\); through Storybook's preview, Storybook didn't confirm the args/);
    assert.deepEqual([result.summary.rendered, result.summary.failed], [3, 1]);

    const [applied, refused, ...rest] = badge.warnings;
    assert.match(applied, /^Storybook wouldn't take some of ui\/base\/Badge's values from the story URL, and would have rendered that variant without them/);
    assert.match(applied, /add 'ghost' to argTypes\.variant\.options in \.\/badge\.stories\.tsx\.$/);
    assert.match(refused, /^Storybook wouldn't render 1 of ui\/base\/Badge's variants with the values asked for/);
    assert.match(refused, /add 'link' to argTypes\.variant\.options in \.\/badge\.stories\.tsx, then measure the component again with --components ui-base-badge --merge\.$/);
    assert.deepEqual(rest, []);

    // The story's argTypes are recorded, and the choice the docs omit named.
    assert.deepEqual(badge.argTypes, {
      disabled: { type: "boolean", control: "boolean" },
      variant: { type: "enum", control: "select", options: ["default", "secondary"] },
    });
    assert.equal(badge.storyFile, "./badge.stories.tsx");
    assert.deepEqual(badge.argsNotInDocs, ["disabled"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a value the URL can't carry is set through the preview and measured, or args_unsupported if that fails too", async () => {
  // Nav/Primary is outside the URL's [a-zA-Z0-9 _-], so it is left out of
  // the URL, and the story renders its default until the preview sets it.
  const tone = { name: "variant", type: { name: "union" }, defaultValue: "default", control: { type: "select", options: ["default", "Nav/Primary"] } };
  const run = async (silent: boolean) => {
    const dir = tempDir();
    try {
      const launch = badgeBrowser(() => ({
        argTypes: { variant: { options: ["default", "Nav/Primary"], type: { name: "enum" } } },
        initial: { variant: "default" },
        silent,
      }));
      const result = await runSnap(options(dir, { variants: "all", selector: "[data-slot=badge]", timeoutMs: 200 }), {
        storybook: badgeDocs([tone]),
        launch,
      });
      return result.components[0];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const measured = await run(false);
  const nav = measured.variants.find((v) => v.combination.variant === "Nav/Primary")!;
  assert.equal(nav.status, "ok", nav.error ?? "");
  assert.equal(nav.delta?.backgroundColor, "#2563eb");
  assert.equal(nav.appliedVia, "preview");
  assert.deepEqual(nav.rejectedArgs, [{ name: "variant", value: "Nav/Primary", reasons: ["url-unsafe"] }]);
  // Nothing in the story to change, so nothing to warn about.
  assert.deepEqual(measured.warnings, []);

  const refused = await run(true);
  const unsupported = refused.variants.find((v) => v.combination.variant === "Nav/Primary")!;
  assert.equal(unsupported.status, "args_unsupported");
  assert.equal(unsupported.delta, undefined);
  assert.equal(unsupported.error,
    "Storybook cannot receive variant=Nav/Primary through the args URL (outside its allowed character set), and snap couldn't set it through Storybook's preview either (Storybook didn't confirm the args), so this variant was not measured");
});

test("runSnap: an arg_rejected variant records only the values the story still wasn't given", async () => {
  // The preview took variant=link, but the story kept hiding size for it.
  const launch = badgeBrowser(() => ({
    argTypes: {
      variant: { options: ["default", "secondary"], type: { name: "enum" } },
      size: { options: ["sm", "lg"], if: { arg: "variant", neq: "link" }, type: { name: "enum" } },
    },
    initial: { variant: "default", size: "sm" },
    ignoreLift: true,
  }));
  const dir = tempDir();
  try {
    const size = { name: "size", type: { name: "union" }, defaultValue: "sm", control: { type: "select", options: ["sm", "lg"] } };
    const result = await runSnap(options(dir, { variants: "all", selector: "[data-slot=badge]", timeoutMs: 200 }), {
      storybook: badgeDocs([BADGE_VARIANT, size]),
      launch,
    });
    const link = result.components[0].variants.find((v) => v.slug === "variant-link--size-lg")!;
    assert.equal(link.status, "arg_rejected");
    assert.deepEqual(link.rejectedArgs, [{ name: "size", value: "lg", reasons: ["hidden-by-if"], condition: { arg: "variant", neq: "link" } }]);
    // The other variants of link are rejected for size alone too; ghost's are measured.
    const statuses = Object.fromEntries(result.components[0].variants.map((v) => [v.slug, v.status]));
    assert.deepEqual(statuses, {
      "variant-default--size-sm": "ok", "variant-default--size-lg": "ok", "variant-secondary--size-sm": "ok", "variant-secondary--size-lg": "ok",
      "variant-ghost--size-sm": "ok", "variant-ghost--size-lg": "ok", "variant-link--size-sm": "arg_rejected", "variant-link--size-lg": "arg_rejected",
    });
    assert.match(result.components[0].warnings.find((w) => /arg_rejected/.test(w))!, /`size` sm, lg: its argTypes `if: \{"arg":"variant","neq":"link"\}` hides it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a variant whose args can't be checked is measured, marked, named and fails --strict", async () => {
  // A page with no Storybook preview to read: what was given can't be known.
  const dir = tempDir();
  try {
    const page = screenshotPage();
    const size = { name: "size", type: { name: "union" }, defaultValue: "sm", control: { type: "select", options: ["sm", "lg"] } };
    const result = await runSnap(options(dir, { selector: "#storybook-root > div" }), {
      storybook: {
        listComponents: async () => [{ id: "forms-a", name: "A" }, { id: "forms-b", name: "B" }],
        getComponent: async (id: string) => ({ name: id, props: id === "forms-a" ? [size] : [], stories: [{ id: `${id}--default`, name: "Default" }] }),
      } as never,
      launch: async () => ({
        via: "stub",
        browser: { newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} },
      }) as never,
    });
    const [a, b] = result.components;
    // Measured, and marked: a value the story didn't take would be its default.
    assert.deepEqual(a.variants.map((v) => [v.slug, v.status, v.argsChecked]), [["size-sm", "ok", false], ["size-lg", "ok", false]]);
    const [warning, ...rest] = a.warnings.filter((w) => /couldn't read Storybook's preview/.test(w));
    assert.deepEqual(rest, []);
    assert.match(warning, /for its variants \(Storybook's preview returned nothing snap can read\)\./);
    assert.match(warning, /Measure the component again with --components forms-a --merge\.$/);
    assert.equal(a.argTypes, undefined);
    // A story asked for nothing can't have refused anything.
    assert.deepEqual([b.variants.map((v) => v.argsChecked), b.warnings], [[undefined], []]);
    // The marked variants fail --strict, as a variant that couldn't be measured does.
    assert.equal(snapFailsStrict(result), true);
    for (const variant of a.variants) delete variant.argsChecked;
    assert.equal(snapFailsStrict(result), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Element trees ---

const RAW_DIR = new URL("../../../cli/__tests__/fixtures/raw/", import.meta.url);

/** A capture from fixtures/raw: what the page read of a shadcn/ui story. */
function rawCapture(name: string): RawTreeCapture {
  return (JSON.parse(readFileSync(new URL(`${name}.json`, RAW_DIR), "utf8")) as { capture: RawTreeCapture }).capture;
}

/**
 * A browser whose one page serves a story through a stand-in preview with
 * `argTypes`, measuring at --selector, its tree as `capture` gives it for the
 * args the story was given and the story's ID, and drawing every thumbnail
 * as `thumbnail` gives its bytes ("thumbnail bytes", by default), each one
 * asked for recorded in `drawn`.
 */
function treeBrowser(opts: {
  storyId: string;
  capture: (args: Record<string, unknown>, storyId: string) => RawTreeCapture;
  argTypes?: Record<string, FakeArgType>;
  version?: string;
  thumbnail?: (arg: { size: [number, number] }) => Buffer;
  /** How many loads time out before any loads, as a cold Storybook's first story may. */
  timeouts?: number;
  /** The story's markup checksum, as readMarkup reads it, for the args it was given; unread by default. */
  markup?: (args: Record<string, unknown>) => string;
  /** The stories' own annotations the preview loads from their file (fakePreview's `csf`); none by default. */
  csf?: Parameters<typeof fakePreview>[0]["csf"];
}) {
  const drawn: unknown[] = [];
  let timeouts = opts.timeouts ?? 0;
  let storyId = opts.storyId;
  let fake = fakePreview({ argTypes: {}, initial: {}, url: {}, storyId, csf: opts.csf });
  let described = false;
  const given = () => fake.preview.storyStoreValue.getStoryContext().args;
  const target = {
    evaluate: async (fn: unknown) => {
      if (fn === captureTreeInPage) return opts.capture(given(), storyId);
      if (described) return null;
      described = true;
      return { tag: "span", slot: "switch", role: null };
    },
    evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
    boundingBox: async () => {
      const root = opts.capture(given(), storyId).root.box;
      return { x: 0, y: 0, width: root[2], height: root[3] };
    },
    screenshot: async () => Buffer.from("png"),
  };
  const page = {
    on: () => {}, off: () => {},
    goto: async (url: string) => {
      if (timeouts-- > 0) throw Object.assign(new Error("page.goto: Timeout 1000ms exceeded."), { name: "TimeoutError" });
      described = false;
      storyId = new URL(url).searchParams.get("id") ?? opts.storyId;
      fake = fakePreview({ storyId, url: urlArgs(url), argTypes: opts.argTypes ?? {}, initial: {}, csf: opts.csf });
      return null;
    },
    waitForSelector: async () => null,
    addStyleTag: async () => null,
    $: async () => target,
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === storyArgsInPage || fn === applyStoryArgsInPage || fn === storiesOwnInPage) return inPage(fake.preview, () => (fn as (a: unknown) => Promise<unknown>)(arg));
      if (fn === thumbnailInPage) {
        drawn.push(arg);
        const bytes = opts.thumbnail ? opts.thumbnail(arg as { size: [number, number] }) : Buffer.from("thumbnail bytes");
        return { mime: "image/jpeg", base64: bytes.toString("base64") };
      }
      // readMarkup, given the story's root containers.
      if (opts.markup && Array.isArray(arg) && arg[0] === "#storybook-root") return opts.markup(given());
      if (Array.isArray(arg) && Array.isArray(arg[1])) return { display: "flex", "background-color": "rgb(229, 229, 229)" };
      return arg ? {} : null;
    },
  };
  const launch = async () => ({
    via: "stub",
    browser: { version: () => opts.version ?? "154.0.0.0", newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} },
  }) as never;
  return { launch, drawn };
}

const SWITCH_SIZE = { name: "size", type: { name: "union", raw: '"default" | "sm"' }, defaultValue: "default" };

function switchDocs(props: object[] = [SWITCH_SIZE]) {
  return {
    listComponents: async () => [{ id: "ui-base-switch", name: "Switch", title: "ui/base/Switch", storyIds: ["ui-base-switch--default", "ui-base-switch--disabled"] }],
    getComponent: async () => ({ name: "Switch", props, stories: [{ id: "ui-base-switch--default", name: "Default" }] }),
  } as never;
}

const switchCapture = (args: Record<string, unknown>) => rawCapture(args.size === "sm" ? "switch-sm" : "switch");

test("runSnap: each variant's element tree, the base whole and the rest as deltas, written a node a line", async () => {
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture: switchCapture, argTypes: { size: { options: ["default", "sm"] } } });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]" }), { storybook: switchDocs(), launch });
    assert.equal(result.treeVersion, 1);
    assert.deepEqual(result.treeLimits, { maxNodes: 400, maxDepth: 24, maxSvgChars: 20000 });
    const [component] = result.components;
    assert.equal(component.capture, "tree");
    assert.deepEqual(component.tree!.base.map((n) => n.k), ["", "switch-thumb"]);
    assert.deepEqual(component.tree!.assets, { svg: {}, img: {} });
    const [base, sm] = component.variants;
    assert.equal(base.treeDelta, undefined);
    assert.deepEqual(sm.treeDelta, { set: { "": { box: [0, 0, 24, 14] }, "switch-thumb": { box: [1, 1, 12, 12], r: 6 } } });
    assert.deepEqual(Object.keys(sm), ["combination", "slug", "status", "error", "boundingBox", "element", "delta", "treeDelta"]);

    const text = readFileSync(join(dir, "styles.json"), "utf8");
    assert.match(text, /\n {6}"capture": "tree",\n/);
    assert.match(text, /\n {10}\{"bg":"#ffffff","box":\[1,1\.19,16,16\],"cls":\[[^\]]*\],"el":"span\[data-slot=switch-thumb\]","k":"switch-thumb","r":8,"t":"F"\}\n/);
    assert.match(text, /\n {14}"switch-thumb": \{"box":\[1,1,12,12\],"r":6\}\n/);
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(result)));
    const meta = readJson(join(dir, "meta.json"));
    assert.equal(meta.platform, `${process.platform}-${process.arch}`);
    assert.equal(meta.browser, "154.0.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: an element placed against the window, measured moved inside the root, is recorded on its variant, not warned about", async () => {
  // shadcn's Sidebar at side=right: its container, `fixed` at `right-0`,
  // drew 1024px right of its 256px root. A warning there failed
  // --strict-warnings on a stock Sidebar, with nothing to fix.
  const right = (): RawTreeCapture => {
    const capture = rawCapture("sidebar");
    const shift = (item: RawTreeCapture["root"]["kids"][number]) => {
      if (item.k === "e" || item.k === "p") item.box[0] += 1024;
      if (item.k === "t") for (const r of item.rects) r[0] += 1024;
      if (item.k === "e") item.kids.forEach(shift);
    };
    shift(capture.root.kids.find((k) => k.k === "e" && k.slot === "sidebar-container")!);
    return capture;
  };
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture: (args) => (args.size === "sm" ? right() : rawCapture("sidebar")), argTypes: { size: { options: ["default", "sm"] } } });
    const result = await runSnap(options(dir, { selector: "[data-slot=sidebar]" }), { storybook: switchDocs(), launch });
    const [component] = result.components;
    assert.deepEqual(component.variants.map((v) => [v.slug, v.movedInside]), [["size-default", undefined], ["size-sm", ["sidebar-container"]]]);
    assert.deepEqual(Object.keys(component.variants[1]), ["combination", "slug", "status", "error", "boundingBox", "element", "movedInside", "delta", "treeDelta"]);
    assert.deepEqual(component.warnings.filter((w) => /sidebar-container|placed against|inside the box/.test(w)), []);
    assert.deepEqual(readJson(join(dir, "styles.json")).components[0].variants[1].movedInside, ["sidebar-container"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: two snaps of one render write the same styles.json, byte for byte", async () => {
  const dirs = [tempDir(), tempDir()];
  try {
    for (const dir of dirs) {
      const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture: switchCapture, argTypes: { size: { options: ["default", "sm"] } } });
      await runSnap(options(dir, { selector: "[data-slot=switch]", variants: "all" }), { storybook: switchDocs(), launch });
    }
    assert.equal(readFileSync(join(dirs[0], "styles.json"), "utf8"), readFileSync(join(dirs[1], "styles.json"), "utf8"));
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap --root-only: styles.json as before trees, each variant saying how many elements went unmeasured", async () => {
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture: () => rawCapture("card"), argTypes: { size: { options: ["default", "sm"] } } });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]", rootOnly: true }), { storybook: switchDocs(), launch });
    assert.equal(result.treeVersion, undefined);
    assert.equal(result.treeLimits, undefined);
    const [component] = result.components;
    assert.equal(component.capture, undefined);
    assert.equal(component.tree, undefined);
    assert.deepEqual(component.variants.map((v) => [v.innerElements, v.treeDelta]), [[22, undefined], [22, undefined]]);
    // Without trees, written as JSON.stringify writes it, as 0.4.0 did.
    assert.equal(readFileSync(join(dir, "styles.json"), "utf8"), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap --merge: a tree snap and a root-only one are not mixed, either way round", async () => {
  const dir = tempDir();
  try {
    const run = (rootOnly: boolean, merge: boolean) => {
      const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture: switchCapture });
      return runSnap(options(dir, { selector: "[data-slot=switch]", rootOnly, merge, components: ["ui-base-switch"] }), { storybook: switchDocs(), launch });
    };
    await run(false, false);
    await assert.rejects(() => run(true, true), /which were measured with their element trees: pass no --root-only, or run snap without --merge/);
    await run(false, true);
    await run(true, false);
    await assert.rejects(() => run(false, true), /which were measured root only \(--root-only, or by a storysync that measured no trees\): pass --root-only/);
    await run(true, true);
    // Trees of another format: not mixed with this one's either.
    await run(false, false);
    const path = join(dir, "styles.json");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n {2}"treeVersion": 1,\n/, '\n  "treeVersion": 2,\n'));
    await assert.rejects(() => run(false, true), /which were measured with their element trees: pass no --root-only, or run snap without --merge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: an image is kept as a thumbnail of what its box shows, named by its bytes and crop, beside styles.json", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000208060000007b", "hex");
  const photo = (size: number): RawTreeCapture => ({
    root: {
      k: "e", tag: "span", box: [0, 0, size, size], cs: { display: "flex" }, path: [],
      kids: [{ k: "e", tag: "img", box: [0, 0, size, size], cs: { "object-fit": "cover" }, kids: [], path: [0], img: { src: `data:image/png;base64,${png.toString("base64")}`, natural: [2, 2] } }],
    },
    fonts: {},
  });
  const dir = tempDir();
  try {
    // The base shows it at 24px, a later variant at 32.
    const { launch, drawn } = treeBrowser({ storyId: "ui-base-switch--default", capture: (args) => photo(args.size === "sm" ? 32 : 24), argTypes: { size: { options: ["default", "sm"] } } });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]" }), { storybook: switchDocs(), launch });
    const { tree } = result.components[0];
    const id = imageAssetId(png, "0,0,2,2");
    assert.equal(tree!.base[1].img, id);
    // Drawn once, at twice the largest box it showed in, whichever variant that was.
    assert.equal(drawn.length, 1);
    assert.deepEqual((drawn[0] as { size: number[] }).size, [64, 64]);
    const fnv = fnv1a32Bytes(Buffer.from("thumbnail bytes"));
    const file = `assets/${id.slice(4)}-${fnv}.jpg`;
    assert.deepEqual(tree!.assets.img, { [id]: { file, mime: "image/jpeg", size: [64, 64], natural: [2, 2], fnv } });
    assert.equal(readFileSync(join(dir, file), "utf8"), "thumbnail bytes");
    assert.equal(result.components[0].variants[1].treeDelta?.set?.["avatar-image"], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: an image whose thumbnail can't be drawn is a frame in every variant, saying so, and warned about", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000208060000007b", "hex");
  const photo = (size: number): RawTreeCapture => ({
    root: {
      k: "e", tag: "span", box: [0, 0, size, size], cs: { display: "flex" }, path: [],
      kids: [{ k: "e", tag: "img", box: [0, 0, size, size], cs: { "object-fit": "cover" }, kids: [], path: [0], img: { src: `data:image/png;base64,${png.toString("base64")}`, natural: [2, 2] } }],
    },
    fonts: {},
  });
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({
      storyId: "ui-base-switch--default", capture: (args) => photo(args.size === "sm" ? 24 : 32), argTypes: { size: { options: ["default", "sm"] } },
      thumbnail: () => { throw new Error("EncodingError: The source image cannot be decoded."); },
    });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]" }), { storybook: switchDocs(), launch });
    const [component] = result.components;
    const img = component.tree!.base[1];
    assert.deepEqual([img.t, img.img, img.approx], ["F", undefined, "image-unavailable"]);
    assert.deepEqual(component.tree!.assets.img, {});
    // The smaller variant differs only in size, not in what it is.
    assert.deepEqual(Object.keys(component.variants[1].treeDelta!.set!.img), ["box"]);
    assert.ok(component.warnings.some((w) => /couldn't draw a thumbnail of img:[0-9a-f]{12}-[0-9a-f]{4} \(EncodingError: The source image cannot be decoded\.\)/.test(w)), JSON.stringify(component.warnings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: two components showing one photo at two sizes each keep their own thumbnail, on --merge too", async () => {
  // shadcn.png is the Avatar's photo at 32px and Empty's at 48px: one id,
  // as the crop is the same, but two thumbnails. Named by id alone, the
  // second written replaced the first, whose record then named other bytes.
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000208060000007b", "hex");
  const photo = (size: number): RawTreeCapture => ({
    root: {
      k: "e", tag: "span", box: [0, 0, size, size], cs: { display: "flex" }, path: [],
      kids: [{ k: "e", tag: "img", box: [0, 0, size, size], cs: { "object-fit": "cover" }, kids: [], path: [0], img: { src: `data:image/png;base64,${png.toString("base64")}`, natural: [2, 2] } }],
    },
    fonts: {},
  });
  const docs = {
    listComponents: async () => [
      { id: "ui-base-avatar", name: "Avatar", title: "ui/base/Avatar", storyIds: ["ui-base-avatar--default"] },
      { id: "ui-base-empty", name: "Empty", title: "ui/base/Empty", storyIds: ["ui-base-empty--with-avatar"] },
    ],
    getComponent: async (id: string) => ({ name: id === "ui-base-avatar" ? "Avatar" : "Empty", props: [], stories: [] }),
  } as never;
  const dir = tempDir();
  try {
    const snap = (sizes: Record<string, number>, overrides: Partial<SnapOptions> = {}) => {
      const { launch } = treeBrowser({
        storyId: "ui-base-avatar--default",
        capture: (_args, storyId) => photo(sizes[storyId.split("--")[0]]),
        thumbnail: ({ size }) => Buffer.from(`thumbnail at ${size.join("x")}`),
      });
      return runSnap(options(dir, { selector: "[data-slot=avatar]", ...overrides }), { storybook: docs, launch });
    };
    const check = (result: Awaited<ReturnType<typeof snap>>, expected: Record<string, string>) => {
      const id = imageAssetId(png, "0,0,2,2");
      const records = result.components.map((c) => c.tree!.assets.img[id]);
      assert.deepEqual(records.map((r) => r.size), Object.values(expected).map((s) => s.split("x").map(Number)));
      assert.notEqual(records[0].file, records[1].file);
      for (const record of records) assert.equal(fnv1a32Bytes(readFileSync(join(dir, record.file))), record.fnv, record.file);
    };
    check(await snap({ "ui-base-avatar": 32, "ui-base-empty": 48 }), { avatar: "64x64", empty: "96x96" });
    // A merge that measures Empty at another size leaves the Avatar's file as it was.
    check(await snap({ "ui-base-avatar": 32, "ui-base-empty": 40 }, { merge: true, components: ["ui-base-empty"] }), { avatar: "64x64", empty: "80x80" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: --stories measures a component from the story it names, and refuses one that isn't its", async () => {
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({ storyId: "ui-base-switch--disabled", capture: switchCapture });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]", stories: { "ui-base-switch": "ui-base-switch--disabled" } }), { storybook: switchDocs(), launch });
    assert.equal(result.components[0].storyId, "ui-base-switch--disabled");
    await assert.rejects(
      () => runSnap(options(dir, { stories: { "ui-base-switch": "ui-base-switch--checked" } }), { storybook: switchDocs(), launch: launchShouldNotHappen }),
      /--stories gives ui-base-switch the story "ui-base-switch--checked", which isn't one of its stories: ui-base-switch--default, ui-base-switch--disabled\./,
    );
    await assert.rejects(
      () => runSnap(options(dir, { stories: { Toggle: "ui-base-toggle--default" } }), { storybook: switchDocs(), launch: launchShouldNotHappen }),
      /--stories names "Toggle", which is none of the components being measured \(ui-base-switch\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStoryOverrides: by ID or title; a name two components share is refused unless the story tells them apart", () => {
  const entries = [
    { id: "ui-base-button", name: "Button", title: "ui/base/Button", storyIds: ["ui-base-button--default", "ui-base-button--with-icon"] },
    { id: "ui-radix-button", name: "Button", title: "ui/radix/Button", storyIds: ["ui-radix-button--default"] },
  ];
  assert.deepEqual([...resolveStoryOverrides(entries, { "ui/radix/button": "ui-radix-button--default" })], [["ui-radix-button", "ui-radix-button--default"]]);
  assert.deepEqual([...resolveStoryOverrides(entries, { Button: "ui-base-button--with-icon" })], [["ui-base-button", "ui-base-button--with-icon"]]);
  assert.throws(() => resolveStoryOverrides(entries, { Button: "ui-x--y" }), /--stories names "Button", which is 2 components \(ui-base-button, ui-radix-button\)/);
  assert.equal(resolveStoryOverrides(entries, undefined).size, 0);
});

test("resolveStoryOverrides: a pair for a component Storybook has and the run doesn't measure is checked, then left out", () => {
  const listed = [
    { id: "ui-base-button", name: "Button", title: "ui/base/Button", storyIds: ["ui-base-button--default", "ui-base-button--with-icon"] },
    { id: "ui-base-switch", name: "Switch", title: "ui/base/Switch", storyIds: ["ui-base-switch--default"] },
  ];
  // A push's pairs, given to a re-measure of the Switch alone.
  const measured = [listed[1]];
  assert.deepEqual([...resolveStoryOverrides(measured, { "ui-base-button": "ui-base-button--with-icon" }, listed)], []);
  assert.deepEqual([...resolveStoryOverrides(measured, { "ui-base-button": "ui-base-button--with-icon", Switch: "ui-base-switch--default" }, listed)], [["ui-base-switch", "ui-base-switch--default"]]);
  // Still a typo when it names no component Storybook has, or a story not the component's.
  assert.throws(() => resolveStoryOverrides(measured, { Nope: "nope--x" }, listed), /--stories names "Nope", which is none of the components being measured \(ui-base-switch\)/);
  assert.throws(() => resolveStoryOverrides(measured, { "ui-base-button": "ui-base-button--x" }, listed), /--stories gives ui-base-button the story "ui-base-button--x", which isn't one of its stories/);
});

test("runSnap: --merge measures a component again from the story the snap measured it from, unless --stories names another", async () => {
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture: switchCapture });
    const run = (more: Partial<SnapOptions>) => runSnap(options(dir, { selector: "[data-slot=switch]", ...more }), { storybook: switchDocs(), launch });
    await run({ stories: { "ui-base-switch": "ui-base-switch--disabled" } });
    const kept = await run({ merge: true, components: ["ui-base-switch"] });
    assert.equal(kept.components[0].storyId, "ui-base-switch--disabled", "a re-measure went back to the default story");
    const named = await run({ merge: true, components: ["ui-base-switch"], stories: { "ui-base-switch": "ui-base-switch--default" } });
    assert.equal(named.components[0].storyId, "ui-base-switch--default");
    // Without --merge, snap picks as it always has.
    assert.equal((await run({})).components[0].storyId, "ui-base-switch--default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: with channelArgs off, a value the story won't take leaves its variant unmeasured, never measured as the default", async () => {
  const launch = badgeBrowser(() => ({ argTypes: { variant: { options: ["default", "secondary"], type: { name: "enum" } } }, initial: { variant: "default" } }));
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir, { variants: "all", selector: "[data-slot=badge]", timeoutMs: 200, channelArgs: false }), {
      storybook: badgeDocs([BADGE_VARIANT]),
      launch,
    });
    const statuses = result.components[0].variants.map((v) => [v.combination.variant, v.status]);
    assert.deepEqual(statuses, [["default", "ok"], ["secondary", "ok"], ["ghost", "arg_rejected"], ["link", "arg_rejected"]]);
    assert.match(result.components[0].variants[2].error!, /--no-channel-args/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: the story's argTypes options add the values the docs' type lacks, measured after the planned ones", async () => {
  const dir = tempDir();
  try {
    const sides = { name: "side", type: { name: "Side" }, defaultValue: "top" };
    const { launch } = treeBrowser({
      storyId: "ui-base-switch--default",
      capture: switchCapture,
      argTypes: { size: { options: ["default", "sm", "lg"] }, side: { options: ["top", "bottom"] } },
    });
    // size's type has default and sm; the options add lg. side's type
    // lists nothing; the options make it an axis, and the plan starts again.
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]" }), { storybook: switchDocs([SWITCH_SIZE, sides]), launch });
    const [component] = result.components;
    assert.deepEqual(component.variantProperties.map((p) => [p.name, p.values, p.defaultValue]), [["size", ["default", "sm", "lg"], "default"], ["side", ["top", "bottom"], "top"]]);
    assert.deepEqual(component.variants.map((v) => [v.slug, v.combination, v.status]), [
      ["size-default--side-top", { size: "default", side: "top" }, "ok"],
      ["size-sm--side-top", { size: "sm", side: "top" }, "ok"],
      ["size-lg--side-top", { size: "lg", side: "top" }, "ok"],
      ["size-default--side-bottom", { size: "default", side: "bottom" }, "ok"],
    ]);
    assert.deepEqual(component.base!.combination, { size: "default", side: "top" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a variant that failed before the options added an axis is measured again in the new plan, not kept without it", async () => {
  const dir = tempDir();
  try {
    const sides = { name: "side", type: { name: "Side" }, defaultValue: "top" };
    // The first story times out twice, as a cold Storybook's may, so its
    // args are never read; the second's add the side axis.
    const { launch } = treeBrowser({
      storyId: "ui-base-switch--default",
      capture: switchCapture,
      argTypes: { size: { options: ["default", "sm"] }, side: { options: ["top", "bottom"] } },
      timeouts: 2,
    });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]", screenshots: true }), { storybook: switchDocs([SWITCH_SIZE, sides]), launch });
    const [component] = result.components;
    assert.deepEqual(component.variants.map((v) => [v.slug, v.combination, v.status]), [
      ["size-default--side-top", { size: "default", side: "top" }, "ok"],
      ["size-sm--side-top", { size: "sm", side: "top" }, "ok"],
      ["size-default--side-bottom", { size: "default", side: "bottom" }, "ok"],
    ]);
    assert.equal(result.summary.variants, 3);
    // Only the new plan's screenshots: none for a slug no variant has.
    assert.deepEqual(readdirSync(join(dir, "ui-base-switch")).sort(), ["size-default--side-bottom.png", "size-default--side-top.png", "size-sm--side-top.png"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: values the options add to an axis already planned come after the planned ones, their slugs unchanged", async () => {
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture: switchCapture, argTypes: { size: { options: ["default", "sm", "lg"] } } });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]", variants: "all" }), { storybook: switchDocs(), launch });
    assert.deepEqual(result.components[0].variants.map((v) => v.slug), ["size-default", "size-sm", "size-lg"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: values the options add past --max-combinations start a capped plan that measures them, not one cut short of them", async () => {
  const dir = tempDir();
  try {
    // size x tone is 4, within the limit; the options' lg makes it 6, past it.
    const tone = { name: "tone", type: { name: "union", raw: '"a" | "b"' }, defaultValue: "a" };
    const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture: switchCapture, argTypes: { size: { options: ["default", "sm", "lg"] } } });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]", variants: "all", maxCombinations: 4 }), { storybook: switchDocs([SWITCH_SIZE, tone]), launch });
    const [component] = result.components;
    assert.deepEqual(component.variants.map((v) => v.slug), ["size-default--tone-a", "size-sm--tone-a", "size-lg--tone-a", "size-default--tone-b"]);
    assert.deepEqual([component.cap!.totalPossible, component.cap!.generated, component.cap!.uncovered], [6, 4, []]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a tree snap whose variants measure alike though their markup changed names a state or an animation as what it didn't measure", async () => {
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({
      storyId: "ui-base-switch--default", capture: () => rawCapture("switch"), argTypes: { size: { options: ["default", "sm"] } },
      markup: (args) => `markup-${String(args.size)}`,
    });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]" }), { storybook: switchDocs(), launch });
    const warning = result.components[0].warnings.find((w) => parseBehaviorOnlyWarning(w));
    assert.match(warning ?? "", /something it doesn't measure, such as a hover or focus state, or an animation\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectIdenticalValues: values that measured the same, root and tree, wherever both were measured", () => {
  const props: FigmaVariantProperty[] = [
    { name: "variant", type: "VARIANT", values: ["default", "ghost", "link"], defaultValue: "default" },
    { name: "size", type: "VARIANT", values: ["sm", "lg"], defaultValue: "sm" },
  ];
  const v = (variant: string, size: string, delta: object, treeDelta?: object): SnapVariant =>
    ({ combination: { variant, size }, slug: `${variant}-${size}`, status: "ok", error: null, delta, ...(treeDelta ? { treeDelta } : {}) }) as SnapVariant;
  const variants = [
    v("default", "sm", {}), v("ghost", "sm", { backgroundColor: null }), v("link", "sm", { backgroundColor: null }),
    v("default", "lg", { width: 50 }), v("ghost", "lg", { width: 50, backgroundColor: null }), v("link", "lg", { width: 50, backgroundColor: null }),
  ];
  assert.deepEqual(detectIdenticalValues(props, variants), [{ property: "variant", values: ["ghost", "link"] }]);
  // A property already named as changing nothing isn't named again.
  assert.deepEqual(detectIdenticalValues(props, variants, ["variant"]), []);
  // A tree that differs tells them apart.
  variants[5] = v("link", "lg", { width: 50, backgroundColor: null }, { set: { "#text": { tx: { td: "underline" } } } });
  assert.deepEqual(detectIdenticalValues(props, variants), []);
  assert.deepEqual(describeIdenticalValues([{ property: "variant", values: ["ghost", "link"] }]), [
    "`variant=ghost` and `variant=link` render identically: everything snap measures, the root and the elements in it, is the same wherever both were measured. " +
      "If the code draws them differently, the story may not pass variant through for these values; if it doesn't, they could be one Figma variant.",
  ]);
});

test("detectIdenticalVariants and detectNoOpProperties: a change inside the root is a change", () => {
  const props: FigmaVariantProperty[] = [{ name: "state", type: "VARIANT", values: ["done", "error"], defaultValue: "done" }];
  const done = { combination: { state: "done" }, slug: "state-done", status: "ok", error: null, delta: {} } as SnapVariant;
  const error = { combination: { state: "error" }, slug: "state-error", status: "ok", error: null, delta: {}, treeDelta: { set: { "attachment-media": { bg: "#df22251a" } } } } as SnapVariant;
  assert.equal(detectIdenticalVariants([done, error]), null);
  assert.deepEqual(detectNoOpProperties(props, [done, error]), []);
  const unchanged = { ...error, treeDelta: {} };
  assert.match(detectIdenticalVariants([done, unchanged])!, /^all 2 rendered variants measured identically/);
  assert.deepEqual(detectNoOpProperties(props, [done, unchanged]), ["state"]);
});

test("describeTruncatedTrees and describeClimbed: what snap left out of a tree, and where it measured instead", () => {
  assert.equal(describeTruncatedTrees([], 3), null);
  assert.equal(
    describeTruncatedTrees([{ slug: "default", truncated: { nodes: 1001, at: "div:400" } }], 1),
    "the element tree of every variant holds more than snap keeps (400 elements, 24 levels deep): up to 1001 elements, so everything from `div:400` on was left out, " +
      "and verify lists it as not measured. To measure all of it, snap a story that renders less, with --stories, or measure its parts as components of their own.",
  );
  assert.equal(
    describeClimbed([{ slug: "a", element: "div[data-slot=\"toaster\"]", from: "section" }], 2),
    "snap measured div[data-slot=\"toaster\"] rather than section in 1 of 2 variants (a): section draws nothing and holds nothing that does, so its tree would be empty, and div[data-slot=\"toaster\"] is the nearest element around it that draws.",
  );
});

test("ScreenshotStage: a file two components staged stays until neither is measured again", () => {
  const dir = tempDir();
  const a = { id: "a", name: "A" } as never;
  const b = { id: "b", name: "B" } as never;
  try {
    const stage = new ScreenshotStage(dir);
    stage.writeFile(a, "assets/x.jpg", Buffer.from("x"));
    stage.writeFile(b, "assets/x.jpg", Buffer.from("x"));
    stage.drop(a);
    stage.commit();
    assert.equal(readFileSync(join(dir, "assets", "x.jpg"), "utf8"), "x");
    const again = new ScreenshotStage(dir);
    again.writeFile(a, "assets/y.jpg", Buffer.from("y"));
    again.drop(a);
    again.commit();
    assert.equal(existsSync(join(dir, "assets", "y.jpg")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectFontSubstitution: a text inside the root drawn in a font that didn't load is named too", () => {
  const component = {
    name: "Card", storyId: null, variantProperties: [], warnings: [], error: null,
    base: { combination: {}, slug: "default", styles: { fontFamily: "Inter", fontAvailable: true } },
    variants: [
      { combination: {}, slug: "default", status: "ok", error: null, delta: {} },
      { combination: {}, slug: "b", status: "ok", error: null, delta: {}, treeDelta: { set: { p: { k: "p", t: "T", el: "p", box: [0, 0, 1, 1], tx: { c: "x", f: "Geist", fa: 0, sz: 14, wt: 400, col: null, lh: 20, n: 1, ink: [0, 0, 1, 1] } } } } },
    ],
    tree: { version: 1, base: [{ k: "", t: "F", el: "div", box: [0, 0, 1, 1] }], assets: { svg: {}, img: {} } },
  } as unknown as Parameters<typeof detectFontSubstitution>[0];
  assert.match(detectFontSubstitution(component)!, /^the browser could not render "Geist"/);
});

// --- Stand-in fonts --------------------------------------------------------------

test("runSnap: text drawn in a stand-in is recorded in it, with the family asked for, on the component and the run", async () => {
  const stack = '"storysync Inter", ui-sans-serif, system-ui, sans-serif';
  const TEXT = {
    color: "rgb(10, 10, 10)", "font-family": stack, "font-size": "14px", "font-weight": "400", "font-style": "normal",
    "line-height": "20px", "letter-spacing": "normal", "text-transform": "none", "text-decoration-line": "none",
    "text-align": "start", "white-space": "nowrap", "text-overflow": "clip", "-webkit-line-clamp": "none",
  };
  const capture = (): RawTreeCapture => ({
    root: { k: "e", tag: "span", box: [0, 0, 40, 20], cs: { display: "flex" }, path: [], kids: [
      { k: "e", tag: "span", box: [0, 0, 40, 20], cs: {}, path: [0], text: TEXT, kids: [{ k: "t", text: "Home", rects: [[0, 1.5, 39.05, 17]] }] },
    ] },
    fonts: { [stack]: { families: ["storysync Inter", "ui-sans-serif", "system-ui", "sans-serif"], applied: [true, false, null, null] } },
  });
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({ storyId: "ui-base-switch--default", capture });
    const result = await runSnap(options(dir, { selector: "[data-slot=switch]" }), { storybook: switchDocs([]), launch });
    const [component] = result.components;
    assert.deepEqual(component.fontStandIns, [["system-ui", "Inter"]]);
    assert.deepEqual(result.fontStandIns, [["system-ui", "Inter"]]);
    const tx = component.tree!.base.find((n) => n.tx)!.tx!;
    assert.deepEqual([tx.f, tx.fs], ["Inter", "system-ui"]);
    // In styles.json as returned.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "styles.json"), "utf8")).fontStandIns, [["system-ui", "Inter"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("describeFontStandIns: once a run, what each family was measured in and why; nothing when none was", () => {
  assert.equal(describeFontStandIns(undefined), null);
  assert.equal(describeFontStandIns([]), null);
  assert.equal(describeFontStandIns([["system-ui", "Inter"]]),
    "Text in system-ui was measured in Inter, the font Figma sets it in, so the browser and Figma lay the text out alike.");
  assert.equal(describeFontStandIns([["Menlo", "Roboto Mono"], ["system-ui", "Inter"]]),
    "Text in Menlo was measured in Roboto Mono and text in system-ui in Inter, the fonts Figma sets them in, so the browser and Figma lay the text out alike.");
});

// --- The story each variant is measured from, and content past its box -------------

const BUTTON_SIZE = { name: "size", type: { name: "union", raw: '"default" | "icon"' }, defaultValue: "default" };

/**
 * shadcn/ui Button as its stories draw it (fixtures/raw/button-icon.json):
 * the Icon story an icon alone in its 36px square; any other story its
 * label, which at `size=icon` spills out of the square by 5px a side.
 */
function buttonCapture(args: Record<string, unknown>, storyId: string): RawTreeCapture {
  const capture = structuredClone(rawCapture("button-icon"));
  const [svg, text] = capture.root.kids as [RawTreeCapture["root"], { rects: number[][]; text: string }];
  if (storyId.endsWith("--icon")) {
    capture.root.box = [0, 0, 36, 36];
    svg.box = [10, 10, 16, 16];
    capture.root.kids = [svg];
  } else if (args.size === "icon") {
    capture.root.box = [0, 0, 36, 36];
    capture.root.kids = [{ ...text, text: "Button", rects: [[-5, 9, 46, 17]] }] as never;
  } else {
    capture.root.box = [0, 0, 70, 36];
    capture.root.kids = [{ ...text, text: "Button", rects: [[12, 9, 46, 17]] }] as never;
  }
  return capture;
}

function buttonDocs(storyIds = ["ui-base-button--default", "ui-base-button--icon"]) {
  return {
    listComponents: async () => [{ id: "ui-base-button", name: "Button", title: "ui/base/Button", storyIds }],
    getComponent: async () => ({ name: "Button", props: [BUTTON_SIZE], stories: storyIds.map((id) => ({ id, name: id })) }),
  } as never;
}

const BUTTON_CSF = {
  "ui-base-button--default": { args: {} },
  "ui-base-button--icon": { args: { size: "icon", title: "Mail", children: { type: "svg" } } },
};

test("runSnap: a variant is measured from the story whose own args are for its values, recorded on it; the rest from the component's story", async () => {
  const dir = tempDir();
  try {
    const { launch } = treeBrowser({ storyId: "ui-base-button--default", capture: buttonCapture, argTypes: { size: { options: ["default", "icon"] } }, csf: BUTTON_CSF });
    const progress: string[] = [];
    const result = await runSnap(options(dir, { selector: "button" }), { storybook: buttonDocs(), launch, onProgress: (m) => progress.push(m) });
    const [button] = result.components;
    assert.equal(button.storyId, "ui-base-button--default");
    const [base, icon] = button.variants;
    assert.deepEqual([base.combination, base.storyId], [{ size: "default" }, undefined]);
    assert.deepEqual([icon.combination, icon.storyId, icon.status], [{ size: "icon" }, "ui-base-button--icon", "ok"]);
    assert.deepEqual(Object.keys(icon).slice(0, 4), ["combination", "slug", "storyId", "status"]);
    // The icon alone, its label gone: nothing draws past the square.
    assert.equal(icon.boundingBox!.width, 36);
    assert.deepEqual(icon.treeDelta!.keys, ["", "svg"]);
    assert.deepEqual(button.warnings, []);
    assert.equal(describeVariantStories(button), "measured `size=icon` from ui-base-button--icon, the rest from ui-base-button--default");
    assert.deepEqual(progress.filter((m) => /stories' args/.test(m)), []);
    // Written as measured.
    assert.equal((readJson(join(dir, "styles.json")) as { components: { variants: SnapVariant[] }[] }).components[0].variants[1].storyId, "ui-base-button--icon");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: where the stories' args can't be read, every variant is measured from the component's story, and a label spilling out of its box is warned of", async () => {
  const dir = tempDir();
  try {
    // A preview that can't load a story's file, as before Storybook 7.
    const { launch } = treeBrowser({ storyId: "ui-base-button--default", capture: buttonCapture, argTypes: { size: { options: ["default", "icon"] } } });
    const progress: string[] = [];
    const result = await runSnap(options(dir, { selector: "button" }), { storybook: buttonDocs(), launch, onProgress: (m) => progress.push(m) });
    const [button] = result.components;
    assert.ok(button.variants.every((v) => v.storyId === undefined));
    assert.deepEqual(progress.filter((m) => /stories' args/.test(m)), [
      "  ui/base/Button: snap couldn't read its stories' args (Storybook's preview can't load a story's file (loadCSFFileByStoryId)), so it measured every variant from ui-base-button--default",
    ]);
    assert.equal(describeVariantStories(button), null);
    assert.deepEqual(button.warnings, [
      "the variant with `size=icon` draws past its box, by up to 5px at the right and left (`#text`), so Figma shows it spilling out: " +
        "ui-base-button--default gives it content that doesn't fit. A story whose own args set size=icon and give it content that fits " +
        "would measure it; snap picks such a story by itself. Or measure the component from another of its stories, with --stories ui-base-button=<story ID>.",
    ]);
    // verify says it as written.
    assert.equal(parseSnapWarning(button.warnings[0]), null);
    // --stories names the Icon story: the component's story for every variant, the label gone from both.
    const named = await runSnap(options(dir, { selector: "button", stories: { "ui-base-button": "ui-base-button--icon" } }), { storybook: buttonDocs(), launch });
    assert.equal(named.components[0].storyId, "ui-base-button--icon");
    assert.ok(!named.components[0].warnings.some((w) => /draws? past/.test(w)), named.components[0].warnings.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A tree node, with only what contentOverflow reads. */
const node = (k: string, box: [number, number, number, number], extra: Partial<TreeNode> = {}): TreeNode =>
  ({ k, t: "F", el: k ? k.split("/").pop()! : "button", box, bg: "#000000", ...extra }) as TreeNode;
const label = (k: string, box: [number, number, number, number], extra: Partial<TreeNode> = {}): TreeNode =>
  node(k, box, { t: "T", el: "#text", bg: undefined, tx: { c: "Button", f: "Inter", sz: 14, wt: 500, col: "#000000", lh: 20, n: 1, ink: [0, 0, box[2], box[3]] }, ...extra });

test("contentOverflow: how far what draws reaches past the root's box, and which elements do", () => {
  const root = node("", [0, 0, 36, 36]);
  assert.deepEqual(contentOverflow([root, label("#text", [-5, 9, 46, 17])]), { by: 5, sides: ["right", "left"], elements: ["#text"] });
  assert.equal(contentOverflow([root, label("#text", [5, 9, 26, 17])]), null);
  // Within a pixel is a glyph's overhang, not overflow.
  assert.equal(contentOverflow([root, label("#text", [-0.8, 9, 37.6, 17])]), null);
  // A text by its glyphs: a line box wider than the ink isn't content past the box.
  assert.equal(contentOverflow([root, label("#text", [-5, 9, 46, 17], { tx: { c: "B", f: "Inter", sz: 14, wt: 500, col: null, lh: 20, n: 1, ink: [10, 0, 20, 17] } })]), null);
  // Down by its lines, not the font's content area: shadcn/ui Label, `leading-none`, 14px Inter in a 14px root, its glyph rects 17px tall (live, 2026-10-13).
  const labelRoot = node("", [0, 0, 1248, 14], { bg: undefined, t: "F" });
  const leadingNone = label("#text", [0, -0.5, 127.23, 14], { tx: { c: "Accept terms and conditions", f: "Inter", sz: 14, wt: 500, col: null, lh: 14, n: 1, ink: [0, -1.5, 127.23, 17] } });
  assert.equal(contentOverflow([labelRoot, leadingNone]), null);
  // Lines that do run past the box still count.
  assert.deepEqual(contentOverflow([node("", [0, 0, 100, 20]), label("#text", [0, 0, 90, 40], { tx: { c: "Two lines", f: "Inter", sz: 14, wt: 500, col: null, lh: 20, n: 2, ink: [0, 1.5, 90, 37] } })])?.sides, ["bottom"]);
  // Down the tree, each box relative to its parent's.
  assert.deepEqual(contentOverflow([root, node("row", [4, 4, 28, 28], { bg: undefined }), node("row/dot", [20, 20, 16, 16])]), { by: 4, sides: ["right", "bottom"], elements: ["dot"] });
});

test("contentOverflow: not what is clipped, positioned, transformed, hidden or paints nothing, nor what no box holds", () => {
  const spill = label("#text", [-5, 9, 46, 17]);
  // The root clips both axes, or the axis it spills on.
  assert.equal(contentOverflow([node("", [0, 0, 36, 36], { clip: 1 }), spill]), null);
  assert.equal(contentOverflow([node("", [0, 0, 36, 36], { clip: "x" }), spill]), null);
  assert.deepEqual(contentOverflow([node("", [0, 0, 36, 36], { clip: "y" }), spill])?.sides, ["right", "left"]);
  // An element around it clips it to its own box.
  assert.equal(contentOverflow([node("", [0, 0, 36, 36]), node("wrap", [0, 0, 36, 36], { bg: undefined, clip: 1 }), label("wrap/#text", [-5, 9, 46, 17])]), null);
  // A badge's dot positioned past the corner, a spinner turned, a hidden or transparent layer: the design's.
  const root = node("", [0, 0, 36, 36]);
  assert.equal(contentOverflow([root, node("dot", [30, -4, 10, 10], { abs: 1 })]), null);
  assert.equal(contentOverflow([root, node("abs", [0, 0, 36, 36], { abs: 1, bg: undefined }), node("abs/dot", [30, -4, 10, 10])]), null);
  assert.equal(contentOverflow([root, node("spin", [-4, -4, 44, 44], { tf: "matrix(0.7,0.7,-0.7,0.7,0,0)" })]), null);
  assert.equal(contentOverflow([root, node("ghost", [-4, 0, 44, 36], { vis: 0 })]), null);
  assert.equal(contentOverflow([root, node("ghost", [-4, 0, 44, 36], { op: 0 })]), null);
  // A frame that paints nothing; a shadow or a focus ring, which no box holds.
  assert.equal(contentOverflow([root, node("layout", [-4, 0, 44, 36], { bg: undefined })]), null);
  assert.equal(contentOverflow([node("", [0, 0, 36, 36], { sh: [[0, 4, 12, 0, "#00000040"]], ol: [2, "solid", "#3b82f6", 2] })]), null);
  // A text that cuts itself off at its box, by its box.
  assert.equal(contentOverflow([root, label("#text", [2, 9, 32, 17], { tx: { c: "sales-dashboard.pdf", f: "Inter", sz: 14, wt: 500, col: null, lh: 20, n: 1, el: 1, ink: [0, 0, 139.4, 17] } })]), null);
});

test("describeOverflow: the variants by the values they share, how far, and the story that would measure them, with --stories", () => {
  const variant = (size: string, variant: string, storyId?: string): SnapVariant =>
    ({ combination: { variant, size }, slug: `${variant}-${size}`, status: "ok", error: null, ...(storyId ? { storyId } : {}) });
  const over = (v: SnapVariant, by: number) => ({ variant: v, overflow: { by, sides: ["right", "left"] as ("right" | "left")[], elements: ["#text"] } });
  const component = { id: "ui-base-button", label: "ui/base/Button", storyId: "ui-base-button--default" };
  const own = [
    { id: "ui-base-button--default", args: {} },
    { id: "ui-base-button--secondary", args: { variant: "secondary" } },
    // Small is for size=sm, but draws nothing of its own, so it shows nothing of what a story for icon-xs would be.
    { id: "ui-base-button--small", args: { size: "sm" } },
    { id: "ui-base-button--icon", args: { variant: "secondary", size: "icon", children: { $type: "object" } } },
  ];
  const properties: FigmaVariantProperty[] = [
    { name: "variant", type: "VARIANT", values: ["default", "secondary"], defaultValue: "default" },
    { name: "size", type: "VARIANT", values: ["default", "icon", "icon-xs"], defaultValue: "default" },
  ];
  const said = describeOverflow(component, [over(variant("icon-xs", "default"), 6.5), over(variant("icon-xs", "secondary"), 6)], 6, { own, properties });
  assert.equal(said,
    "the 2 variants with `size=icon-xs` draw past their box, by up to 6.5px at the right and left (`#text`), so Figma shows them spilling out: " +
    "ui-base-button--default gives them content that doesn't fit. A story whose own args set size=icon-xs and give it content that fits, " +
    "as ui-base-button--icon is for `size=icon`, would measure them; snap picks such a story by itself. " +
    "Or measure the component from another of its stories, with --stories ui-base-button=<story ID>.");
  // Every variant, or some sharing nothing: by slug, and the story each was measured from.
  const all = describeOverflow(component, [over(variant("default", "default"), 2), over(variant("icon", "secondary", "ui-base-button--icon"), 3)], 2, null)!;
  assert.match(all, /^all 2 variants draw past their box, by up to 3px .* ui-base-button--default and ui-base-button--icon give them content that doesn't fit\. Or measure/);
  assert.equal(describeOverflow(component, [], 6, null), null);
});
