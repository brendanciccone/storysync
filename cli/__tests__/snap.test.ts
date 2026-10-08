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
  parseMeasurementWarning,
} from "../snap.js";
import { VERSION } from "../version.js";
import type { SnapOptions, SnapVariant } from "../snap.js";
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
  assert.match(tooltip, /carries data-slot="tooltip-content" or that/);
  assert.doesNotMatch(tooltip, /content-content/);
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
        evaluate: async () => {
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
