// Tests for snap orchestration. The Storybook client and browser launcher are
// injected, so these run without a network or a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSnap, pickStory, detectFontSubstitution, describeSlugCollisions, writeScreenshot, selectCombinations, describeCap, uncoveredValues,
  detectNoOpProperties, describeNoOpProperties, describeMeasurementNotes, SnapInterruptedError, screenshotName,
} from "../snap.js";
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

// Components are keyed by `title ?? name` in the readback and during
// verification, so two components sharing that key silently collapse into one
// downstream — a measured component vanishing from the score with no signal.
test("runSnap: warns when two components share an identity key", async () => {
  const dir = tempDir();
  try {
    const result = await runSnap(options(dir), {
      storybook: {
        // Untitled components sharing a name — the realistic collision, since
        // Storybook itself rejects duplicate titles.
        listComponents: async () => [
          { id: "a-button", name: "Button" },
          { id: "b-button", name: "Button" },
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

    assert.equal(result.summary.componentsWithWarnings, 2);
    for (const component of result.components) {
      assert.ok(component.warnings.some((w) => /share the key "Button"/.test(w)), "collision warning missing");
    }
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

test("describeCap: names the total, the limit, and how to build the full set", () => {
  const message = describeCap("Forms/Button", {
    maxCombinations: 256, totalPossible: 300, generated: 256, droppedCount: 44, droppedSample: [],
  });
  assert.match(message, /Forms\/Button has 300 variant combinations, more than the limit of 256/);
  assert.match(message, /--max-combinations 300/);
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

test("runSnap: a SIGTERM stops the run, writes nothing and leaves the last styles.json as it was", async () => {
  // Playwright's own handler closed the browser and left the run going, which
  // recorded each component left as a failed browser session, wrote that
  // over the last good styles.json and meta.json, and exited 0.
  const dir = tempDir();
  const earlier = '{"version":1,"components":["the last good snap"]}\n';
  writeFileSync(join(dir, "styles.json"), earlier);
  const listeners = process.listenerCount("SIGTERM");
  try {
    let navigations = 0;
    const browser = stubBrowser(() => {
      if (++navigations === 1) process.emit("SIGTERM", "SIGTERM");
    });
    await assert.rejects(
      () => runSnap(options(dir), { storybook: THREE_COMPONENTS as never, launch: async () => ({ via: "stub", browser }) as never }),
      (err: unknown) => {
        assert.ok(err instanceof SnapInterruptedError, String(err));
        assert.equal(err.exitCode, 143);
        assert.match(err.message, /received SIGTERM, having finished 0 of 3 components, and wrote nothing/);
        return true;
      },
    );
    assert.equal(navigations, 1, "the run went on after the signal");
    assert.equal(readFileSync(join(dir, "styles.json"), "utf8"), earlier);
    assert.equal(existsSync(join(dir, "meta.json")), false);
    // And the run's listeners are gone, so a later signal ends the process as usual.
    assert.equal(process.listenerCount("SIGTERM"), listeners);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnap: a browser that goes away mid-run fails the run rather than failing every component left", async () => {
  const dir = tempDir();
  try {
    let navigations = 0;
    const browser = stubBrowser(() => {
      if (++navigations === 2) browser.disconnect();
    });
    await assert.rejects(
      () => runSnap(options(dir), { storybook: THREE_COMPONENTS as never, launch: async () => ({ via: "stub", browser }) as never }),
      (err: unknown) => {
        assert.ok(err instanceof SnapInterruptedError, String(err));
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /the browser closed part-way through .* having finished 1 of 3 components/);
        return true;
      },
    );
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
