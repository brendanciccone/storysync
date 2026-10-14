// `storysync figma tokens`: the calls that push the tokens' variables, run
// in the mock Figma as an agent sends them, twice and over what earlier
// pushes left.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { alphaCalls, runFigmaTokens, variablesFromTokens } from "../figma-tokens.js";
import type { FigmaTokensOptions, TokensPlan } from "../figma-tokens.js";
import type { TokenExtractionResult } from "../tokens.js";
import type { PlanAlpha } from "../tree-types.js";
import { SHADCN_TOKENS, codeFor, mockFor, runPlan, variantsBySlug } from "./figma-build-harness.js";
import { MockFigma, loadTreeFixture } from "./mock-figma.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

interface Result {
  kind: string; collection: string; part: [number, number]; createdCollection: boolean;
  modes: string[]; renamedModes: [string, string][]; addedModes: string[]; darkError: string | null;
  created: string[]; updated: string[]; unchanged: number; skipped: string[]; variables: number; alpha: string[];
  stale?: string[]; conflicts?: [string, string][]; removed?: string[];
}

type Token = { name: string; value: string; hex?: string; px?: number; dark?: { value: string; hex?: string; px?: number } };
type Tokens = { source: string; sourcePath: string; modes: string[]; warnings: string[]; collections: { category: string; tokens: Token[] }[] };

/** Tokens as `storysync tokens --json` reads push 5b's shadcn/ui project, cut down: colors in two themes, and radius in one. */
const TOKENS: Tokens = {
  source: "css", sourcePath: "app/globals.css", modes: ["Light", "Dark"], warnings: [],
  collections: [
    {
      category: "colors",
      tokens: [
        { name: "background", value: "oklch(1 0 0)", hex: "#ffffff", dark: { value: "oklch(0.145 0 0)", hex: "#0a0a0a" } },
        { name: "border", value: "oklch(0.922 0 0)", hex: "#e5e5e5", dark: { value: "oklch(1 0 0 / 10%)", hex: "#ffffff1a" } },
        { name: "chart/1", value: "oklch(0.809 0.105 251.813)", hex: "#8ec5ff" },
      ],
    },
    {
      category: "radius",
      tokens: [
        { name: "sm", value: "calc(var(--radius) - 4px)", px: 6 },
        { name: "md", value: "calc(var(--radius) - 2px)", px: 8 },
        { name: "lg", value: "var(--radius)", px: 10 },
      ],
    },
  ],
};

const copy = <T>(value: T): T => structuredClone(value);

interface Planned {
  dir: string;
  plan: TokensPlan;
  code(seq: number): string;
}

/**
 * Writes `tokens` as tokens.json in a new directory, and `alphas` as the
 * alpha variables of a plan figma code wrote, and runs figma tokens over it.
 */
function planFor(tokens: object, options: Partial<FigmaTokensOptions> = {}, alphas?: PlanAlpha[]): Planned {
  const dir = mkdtempSync(join(tmpdir(), "storysync-figma-tokens-"));
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens));
  if (alphas) {
    mkdirSync(join(dir, "figma"), { recursive: true });
    writeFileSync(join(dir, "figma", "plan.json"), JSON.stringify({ version: 1, storysyncVersion: "0.4.0", snap: { path: "", measuredAt: "", digest: "" }, calls: [], alphas }));
    options = { plan: join(dir, "figma", "plan.json"), ...options };
  }
  const out = join(dir, "figma", "tokens");
  const { plan } = runFigmaTokens({ tokens: join(dir, "tokens.json"), out, ...options });
  return { dir, plan, code: (seq) => readFileSync(join(out, plan.calls.find((c) => c.seq === seq)!.file), "utf8") };
}

/** Sends every call of a plan, in seq order and unchanged, and returns what each returned. */
async function push(mock: MockFigma, planned: Planned): Promise<Result[]> {
  const out: Result[] = [];
  for (const call of planned.plan.calls) {
    const run = await mock.run(planned.code(call.seq));
    assert.ok(run.ok, `call ${call.seq}: ${run.text}`);
    out.push(run.value as Result);
  }
  return out;
}

const pushTokens = (mock: MockFigma, tokens: object, options: Partial<FigmaTokensOptions> = {}, alphas?: PlanAlpha[]) => push(mock, planFor(tokens, options, alphas));

/** What a result changed: nothing, on a push sent again. */
const changes = (r: Result) => ({ created: r.created, updated: r.updated, renamedModes: r.renamedModes, addedModes: r.addedModes, removed: r.removed ?? [] });
const NOTHING = { created: [], updated: [], renamedModes: [], addedModes: [], removed: [] };

test("figma tokens: a collection a category, each token typed and scoped as the skill's table says, and what no variable holds left out with why", () => {
  const tokens = {
    ...copy(TOKENS),
    warnings: ["Unresolved: spacing gutter = var(--gutter) (--gutter isn't set in :root or @theme)"],
    collections: [
      ...copy(TOKENS.collections),
      { category: "colors", tokens: [{ name: "current", value: "currentColor" }] },
      { category: "spacing", tokens: [{ name: "4", value: "1rem", px: 16 }, { name: "gutter", value: "var(--gutter)" }] },
      // A radius DEFAULT that repeats lg: push 5 made both, and neither bound.
      { category: "radius", tokens: [{ name: "DEFAULT", value: "0.625rem", px: 10 }] },
      {
        category: "typography",
        tokens: [
          { name: "text/sm", value: "0.875rem", px: 14 }, { name: "base", value: "1rem", px: 16 },
          { name: "font/weight/bold", value: "700" }, { name: "leading/tight", value: "1.25" },
          { name: "tracking/wide", value: "0.025em" }, { name: "tracking/px", value: "1px", px: 1 },
          { name: "font/sans", value: "ui-sans-serif, system-ui, sans-serif" }, { name: "font/mono", value: "var(--font-geist-mono)" },
          // Each family as Figma names the one it sets the stack's text in.
          { name: "font/heading", value: '"Geist Variable", sans-serif' }, { name: "font/code", value: "ui-monospace, SFMono-Regular, Menlo, monospace" },
        ],
      },
      { category: "shadows", tokens: [{ name: "sm", value: "0 1px 2px 0 rgb(0 0 0 / 0.05)" }] },
    ],
  } as unknown as TokenExtractionResult;
  const { collections, leftOut } = variablesFromTokens(tokens);
  const shape = Object.fromEntries(collections.map((c) => [c.name, { modes: c.modes, variables: c.variables.map((v) => [v.name, v.type, v.scopes.join("|"), v.light, v.dark]) }]));
  assert.deepEqual(shape, {
    Colors: {
      modes: ["Light", "Dark"],
      variables: [
        ["background", "COLOR", "ALL_FILLS|STROKE_COLOR|EFFECT_COLOR", "#ffffff", "#0a0a0a"],
        ["border", "COLOR", "ALL_FILLS|STROKE_COLOR|EFFECT_COLOR", "#e5e5e5", "#ffffff1a"],
        ["chart/1", "COLOR", "ALL_FILLS|STROKE_COLOR|EFFECT_COLOR", "#8ec5ff", undefined],
      ],
    },
    Radius: { modes: ["Default"], variables: [["sm", "FLOAT", "CORNER_RADIUS", 6, undefined], ["md", "FLOAT", "CORNER_RADIUS", 8, undefined], ["lg", "FLOAT", "CORNER_RADIUS", 10, undefined]] },
    Spacing: { modes: ["Default"], variables: [["4", "FLOAT", "GAP|WIDTH_HEIGHT", 16, undefined]] },
    Typography: {
      modes: ["Default"],
      variables: [
        ["text/sm", "FLOAT", "FONT_SIZE", 14, undefined], ["base", "FLOAT", "FONT_SIZE", 16, undefined],
        ["font/weight/bold", "FLOAT", "FONT_WEIGHT", 700, undefined], ["leading/tight", "FLOAT", "LINE_HEIGHT", 1.25, undefined],
        ["tracking/px", "FLOAT", "LETTER_SPACING", 1, undefined], ["font/sans", "STRING", "FONT_FAMILY", "Inter", undefined],
        ["font/heading", "STRING", "FONT_FAMILY", "Geist", undefined], ["font/code", "STRING", "FONT_FAMILY", "Roboto Mono", undefined],
      ],
    },
  });
  assert.deepEqual(leftOut.map((t) => [t.category, t.name]), [
    ["colors", "current"], ["spacing", "gutter"], ["typography", "tracking/wide"], ["typography", "font/mono"], ["shadows", "sm"],
  ]);
  assert.match(leftOut[0].why, /currentColor is no color/);
  assert.match(leftOut[1].why, /didn't resolve/);
  assert.match(leftOut[2].why, /no fixed size in px/);
  assert.match(leftOut[4].why, /can't hold a shadow/);
});

test("figma tokens: pushed twice, the second push changes nothing in Figma", async () => {
  const mock = new MockFigma();
  const first = await pushTokens(mock, TOKENS);
  assert.deepEqual(first.map((r) => [r.collection, r.createdCollection, r.modes, r.created.length, r.stale]), [
    ["Colors", true, ["Light", "Dark"], 3, []],
    ["Radius", true, ["Default"], 3, []],
  ]);
  assert.deepEqual(first.map((r) => r.renamedModes), [[["Mode 1", "Light"]], [["Mode 1", "Default"]]]);
  assert.deepEqual(mock.collections(), [
    {
      name: "Colors", modes: ["Light", "Dark"],
      variables: [
        { name: "background", type: "COLOR", scopes: ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"], values: { Light: "#ffffff", Dark: "#0a0a0a" } },
        { name: "border", type: "COLOR", scopes: ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"], values: { Light: "#e5e5e5", Dark: "#ffffff1a" } },
        { name: "chart/1", type: "COLOR", scopes: ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"], values: { Light: "#8ec5ff", Dark: "#8ec5ff" } },
      ],
    },
    {
      name: "Radius", modes: ["Default"],
      variables: ["sm", "md", "lg"].map((name, i) => ({ name, type: "FLOAT", scopes: ["CORNER_RADIUS"], values: { Default: [6, 8, 10][i] } })),
    },
  ]);

  const writes = mock.variableWrites.length;
  const before = mock.collections();
  const again = await pushTokens(mock, TOKENS);
  assert.deepEqual(mock.variableWrites.slice(writes), [], "the second push wrote nothing");
  assert.deepEqual(mock.collections(), before);
  assert.deepEqual(again.map(changes), [NOTHING, NOTHING]);
  assert.deepEqual(again.map((r) => [r.createdCollection, r.unchanged, r.variables, r.stale, r.conflicts]), [[false, 3, 3, [], []], [false, 3, 3, [], []]]);
});

test("figma tokens: over the file push 5 left, Radius's Mode 1 becomes Default, each scope is fixed, and its stale DEFAULT is listed and kept until the user confirms", async () => {
  // Push 5 sent the skill's first template: no scopes, so ALL_SCOPES, a
  // radius collection left in "Mode 1", and the DEFAULT that repeats lg,
  // which tokens has since dropped.
  const mock = new MockFigma();
  for (const t of TOKENS.collections[0].tokens) mock.addVariable(t.name, "COLOR", { Light: t.hex!, Dark: (t.dark ?? t).hex! }, "Colors");
  for (const [name, px] of [["DEFAULT", 10], ["sm", 6], ["md", 8], ["lg", 10]] as const) mock.addVariable(name, "FLOAT", px, "Radius");

  const [colors, radius] = await pushTokens(mock, TOKENS);
  assert.deepEqual([colors.createdCollection, colors.created, colors.updated, colors.renamedModes, colors.addedModes], [false, [], ["background", "border", "chart/1"], [], []]);
  assert.deepEqual([radius.createdCollection, radius.created, radius.updated, radius.renamedModes, radius.modes], [false, [], ["sm", "md", "lg"], [["Mode 1", "Default"]], ["Default"]]);
  assert.deepEqual([radius.stale, radius.removed, radius.variables], [["Radius/DEFAULT"], [], 4]);
  const kept = mock.collections()[1];
  assert.deepEqual(kept.variables.map((v) => [v.name, v.scopes.join(), v.values.Default]), [["DEFAULT", "ALL_SCOPES", 10], ["sm", "CORNER_RADIUS", 6], ["md", "CORNER_RADIUS", 8], ["lg", "CORNER_RADIUS", 10]]);

  // Sent again unconfirmed: DEFAULT still listed, still there, nothing written.
  const writes = mock.variableWrites.length;
  const [, unconfirmed] = await pushTokens(mock, TOKENS);
  assert.deepEqual([unconfirmed.stale, mock.variableWrites.length], [["Radius/DEFAULT"], writes]);

  // The user confirms: `--remove Radius/DEFAULT` removes it alone.
  const confirmed = planFor(TOKENS, { remove: ["Radius/DEFAULT"] });
  assert.match(confirmed.plan.calls[1].description, /and remove Radius\/DEFAULT, as the user confirmed$/);
  assert.deepEqual(confirmed.plan.remove, ["Radius/DEFAULT"]);
  const [, removed] = await push(mock, confirmed);
  assert.deepEqual([removed.removed, removed.stale, removed.updated, removed.variables], [["Radius/DEFAULT"], [], [], 3]);
  assert.deepEqual(mock.variableWrites.slice(writes), ["remove DEFAULT"]);
  assert.deepEqual(mock.collections()[1].variables.map((v) => v.name), ["sm", "md", "lg"]);
});

test("figma tokens: a changed value is updated in place, that value alone", async () => {
  const mock = new MockFigma();
  await pushTokens(mock, TOKENS);
  const writes = mock.variableWrites.length;
  const changed = copy(TOKENS);
  changed.collections[0].tokens[1].hex = "#d4d4d4";
  changed.collections[1].tokens[2].px = 12;
  const [colors, radius] = await pushTokens(mock, changed);
  assert.deepEqual([colors.updated, colors.unchanged, radius.updated, radius.unchanged], [["border"], 2, ["lg"], 2]);
  assert.deepEqual(mock.variableWrites.slice(writes), ["value border Light", "value lg Default"]);
  assert.deepEqual(mock.collections().map((c) => c.variables.length), [3, 3]);
  assert.deepEqual(mock.collections()[0].variables[1].values, { Light: "#d4d4d4", Dark: "#ffffff1a" });
});

test("figma tokens: a dark theme the tokens gain renames the lone Default mode Light and adds Dark, in place", async () => {
  const mock = new MockFigma();
  const lightOnly = copy(TOKENS);
  for (const t of lightOnly.collections[0].tokens) delete t.dark;
  const [first] = await pushTokens(mock, lightOnly);
  assert.deepEqual(first.modes, ["Default"]);

  const [colors] = await pushTokens(mock, TOKENS);
  assert.deepEqual([colors.renamedModes, colors.addedModes, colors.modes, colors.created, colors.updated], [[["Default", "Light"]], ["Dark"], ["Light", "Dark"], [], ["background", "border"]]);
  assert.deepEqual(mock.collections()[0].variables.map((v) => v.values), [
    { Light: "#ffffff", Dark: "#0a0a0a" }, { Light: "#e5e5e5", Dark: "#ffffff1a" }, { Light: "#8ec5ff", Dark: "#8ec5ff" },
  ]);
  const writes = mock.variableWrites.length;
  await pushTokens(mock, TOKENS);
  assert.equal(mock.variableWrites.length, writes);

  // The dark theme gone again: the Dark mode stays, and keeps its values; the tokens carry none to write.
  const [dropped] = await pushTokens(mock, lightOnly);
  assert.deepEqual([dropped.modes, dropped.renamedModes, dropped.updated], [["Light", "Dark"], [], []]);
  assert.deepEqual(mock.collections()[0].variables[0].values, { Light: "#ffffff", Dark: "#0a0a0a" });
});

test("figma tokens: tokens of no dark value never write a designer's hand-made Dark mode, and a variable made new takes its light value there", async () => {
  const mock = new MockFigma();
  // A designer's own Dark mode, painted by hand.
  mock.addVariable("background", "COLOR", { Light: "#ffffff", Dark: "#0a0a0a" }, "Colors");
  mock.addVariable("border", "COLOR", { Light: "#e5e5e5", Dark: "#27272a" }, "Colors");
  const lightOnly = copy(TOKENS);
  for (const t of lightOnly.collections[0].tokens) delete t.dark;
  const writes = mock.variableWrites.length;
  const [colors] = await pushTokens(mock, lightOnly);
  assert.deepEqual([colors.modes, colors.renamedModes, colors.addedModes, colors.created], [["Light", "Dark"], [], [], ["chart/1"]]);
  const values = Object.fromEntries(mock.collections()[0].variables.map((v) => [v.name, v.values]));
  assert.deepEqual(values.background, { Light: "#ffffff", Dark: "#0a0a0a" });
  assert.deepEqual(values.border, { Light: "#e5e5e5", Dark: "#27272a" });
  assert.deepEqual(values["chart/1"], { Light: "#8ec5ff", Dark: "#8ec5ff" });
  assert.equal(mock.variableWrites.slice(writes).some((w) => /^value (?:background|border) Dark$/.test(w)), false, mock.variableWrites.slice(writes).join("; "));
});

test("figma tokens: a plan of one mode keeps Light alone and says why, on every push", async () => {
  const mock = new MockFigma({ maxModes: 1 });
  const [colors] = await pushTokens(mock, TOKENS);
  assert.deepEqual(colors.modes, ["Light"]);
  assert.match(colors.darkError ?? "", /Limited to 1 modes/);
  const writes = mock.variableWrites.length;
  const [again] = await pushTokens(mock, TOKENS);
  assert.match(again.darkError ?? "", /Limited to 1 modes/);
  assert.equal(mock.variableWrites.length, writes);
});

test("figma tokens: a variable of a token's name that can't be its variable is a conflict, left alone until the user confirms removing it", async () => {
  const mock = new MockFigma();
  mock.addVariable("border", "FLOAT", 1, "Colors");
  const [colors] = await pushTokens(mock, TOKENS);
  assert.deepEqual([colors.conflicts, colors.skipped, colors.created], [[["Colors/border", "a FLOAT variable, not COLOR"]], ["Colors/border"], ["background", "chart/1"]]);
  assert.deepEqual(mock.collections()[0].variables.map((v) => [v.name, v.type]), [["border", "FLOAT"], ["background", "COLOR"], ["chart/1", "COLOR"]]);

  const [confirmed] = await pushTokens(mock, TOKENS, { remove: ["Colors/border"] });
  assert.deepEqual([confirmed.removed, confirmed.conflicts, confirmed.created], [["Colors/border"], [], ["border"]]);
  assert.deepEqual(mock.collections()[0].variables.map((v) => [v.name, v.type]), [["background", "COLOR"], ["chart/1", "COLOR"], ["border", "COLOR"]]);

  // A token's own variable is never removed, named or not.
  const writes = mock.variableWrites.length;
  const [named] = await pushTokens(mock, TOKENS, { remove: ["Colors/background"] });
  assert.deepEqual([named.removed, mock.variableWrites.length], [[], writes]);
});

test("figma tokens: a large collection is split into calls, the first listing what is stale, and sent twice changes nothing", async () => {
  const mock = new MockFigma();
  mock.addVariable("old", "COLOR", "#000000", "Colors");
  const planned = planFor(TOKENS, { maxVariables: 2 });
  assert.deepEqual(planned.plan.calls.map((c) => [c.collection, c.part, c.variables]), [["Colors", [1, 2], 2], ["Colors", [2, 2], 1], ["Radius", [1, 2], 2], ["Radius", [2, 2], 1]]);
  assert.match(planned.plan.calls[1].description, /variables 3-3 of 3, in Light and Dark modes$/);
  const results = await push(mock, planned);
  assert.deepEqual(results.map((r) => [r.part, r.created, r.stale]), [[[1, 2], ["background", "border"], ["Colors/old"]], [[2, 2], ["chart/1"], undefined], [[1, 2], ["sm", "md"], []], [[2, 2], ["lg"], undefined]]);
  const writes = mock.variableWrites.length;
  await push(mock, planned);
  assert.equal(mock.variableWrites.length, writes);
});

test("figma tokens: two collections of the name are refused before anything changes, for the user to choose", async () => {
  // The mock keeps a collection by name; Figma doesn't, and the skill's old
  // template made a second Colors on every push.
  const planned = planFor(TOKENS);
  let created = 0;
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [{ id: "VariableCollectionId:1:2", name: "Colors" }, { id: "VariableCollectionId:9:2", name: "Colors" }],
      createVariableCollection: () => created++,
    },
  };
  const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (figma: unknown) => Promise<unknown>;
  await assert.rejects(new AsyncFunction("figma", planned.code(1))(figma), /2 variable collections are named "Colors" \(VariableCollectionId:1:2, VariableCollectionId:9:2\): ask the user which to keep/);
  assert.equal(created, 0);
});

test("figma tokens: --remove names a variable of a collection the plan makes, and an earlier plan's calls and results go", () => {
  const planned = planFor(TOKENS);
  for (const entry of ["Spacing/4", "Colors", "Colors/", "/border"]) {
    assert.throws(() => runFigmaTokens({ tokens: join(planned.dir, "tokens.json"), out: join(planned.dir, "figma", "tokens"), remove: [entry] }), /name a variable as Collection\/name.*in Colors, Radius/);
  }
  const out = join(planned.dir, "figma", "tokens");
  writeFileSync(join(out, "results", "01.json"), "{}");
  writeFileSync(join(out, "results", "notes.txt"), "mine");
  const split = runFigmaTokens({ tokens: join(planned.dir, "tokens.json"), out, maxVariables: 2 });
  assert.equal(split.plan.calls.length, 4);
  assert.throws(() => readFileSync(join(out, "results", "01.json")));
  assert.equal(readFileSync(join(out, "results", "notes.txt"), "utf8"), "mine");
  assert.throws(() => runFigmaTokens({ tokens: join(planned.dir, "missing.json"), out }), /no tokens at .*missing\.json: save them first/);
});

/** The alpha variables a plan binds, as figma code lists them: background and border at 10% and 50%, and a token the tokens lack. */
const ALPHAS: PlanAlpha[] = [
  { variable: "background 10%", token: "background", alpha: 0.102 },
  { variable: "border 50%", token: "border", alpha: 0.502 },
  { variable: "ring 10%", token: "ring", alpha: 0.102 },
];

test("figma tokens: the plan's alpha variables are made beside their tokens, each the token's color at its alpha in Light and Dark, and sent twice change nothing", async () => {
  const planned = planFor(TOKENS, {}, ALPHAS);
  assert.deepEqual(planned.plan.plan, { path: "../plan.json", alphas: 2 });
  assert.equal(planned.plan.calls[0].description, "Create or update the Colors variable collection (3 variables, with 2 alpha variables of their colors), in Light and Dark modes");
  const mock = new MockFigma();
  const [colors] = await push(mock, planned);
  assert.deepEqual([colors.created, colors.alpha, colors.stale], [["background", "border", "chart/1", "background 10%", "border 50%"], ["background 10%", "border 50%"], []]);
  // border is translucent in Dark, #ffffff1a: at 50%, 5%, as the browser draws border-border/50 there.
  assert.deepEqual(mock.collections()[0].variables.slice(3), [
    { name: "background 10%", type: "COLOR", scopes: ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"], values: { Light: "#ffffff1a", Dark: "#0a0a0a1a" } },
    { name: "border 50%", type: "COLOR", scopes: ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"], values: { Light: "#e5e5e580", Dark: "#ffffff0d" } },
  ]);
  const writes = mock.variableWrites.length;
  const [again] = await push(mock, planFor(TOKENS, {}, ALPHAS));
  assert.deepEqual([changes(again), again.unchanged, mock.variableWrites.length], [NOTHING, 5, writes]);
});

test("figma tokens: an alpha variable an earlier push made is no stale variable, and follows its token, the plan naming it or not; one whose token is gone is stale", async () => {
  const mock = new MockFigma();
  await pushTokens(mock, TOKENS, {}, ALPHAS);
  const changed = copy(TOKENS);
  changed.collections[0].tokens[1].hex = "#d4d4d4";
  // No plan: a tokens-only push, or one before figma code has written one.
  const [colors] = await pushTokens(mock, changed, { plan: join(tmpdir(), "no-such-plan.json") });
  assert.deepEqual([colors.stale, colors.updated, colors.alpha], [[], ["border", "border 50%"], ["background 10%", "border 50%"]]);
  assert.deepEqual(mock.collections()[0].variables.find((v) => v.name === "border 50%")!.values, { Light: "#d4d4d480", Dark: "#ffffff0d" });
  const gone = copy(TOKENS);
  gone.collections[0].tokens.shift();
  const [without] = await pushTokens(mock, gone);
  assert.deepEqual([without.stale, without.alpha], [["Colors/background", "Colors/background 10%"], ["border 50%"]]);
});

test("figma tokens: a large collection puts each alpha variable in the call of its token, and a plan's token the tokens lack is said and left out", async () => {
  const planned = planFor(TOKENS, { maxVariables: 2 }, ALPHAS);
  assert.deepEqual(planned.plan.calls.filter((c) => c.collection === "Colors").map((c) => [c.part, c.variables, c.alphas]), [[[1, 3], 1, 1], [[2, 3], 1, 1], [[3, 3], 1, undefined]]);
  const { warnings } = runFigmaTokens({ tokens: join(planned.dir, "tokens.json"), out: join(planned.dir, "again"), plan: join(planned.dir, "figma", "plan.json") });
  assert.deepEqual(warnings, ["ring 10%: the plan binds it, but no color token is named ring, so it isn't made: run `figma code` again with these tokens"]);
  const mock = new MockFigma();
  const results = await push(mock, planned);
  assert.deepEqual(results.filter((r) => r.collection === "Colors").map((r) => r.alpha), [["background 10%"], ["border 50%"], []]);
});

test("figma tokens: a call changed on its way says it differs from the file figma tokens wrote, and changes nothing", async () => {
  const planned = planFor(TOKENS);
  const mock = new MockFigma();
  const run = await mock.run(planned.code(1).replace('"#e5e5e5"', '"#e5e5e6"'));
  assert.equal(run.ok, false);
  assert.match(run.text, /^Error: This call differs from the file storysync figma tokens wrote: its data fails its checksum, SUM\. Nothing was changed\./);
  assert.deepEqual(mock.variableWrites, []);
});

test("figma tokens: the build binds by name to the variables two pushes made, one of each", async () => {
  const button = loadTreeFixture("button-icon");
  button.components[0].tree.base[0].cls = ["bg-primary", "rounded-md", "text-primary-foreground"];
  const coded = await codeFor(button, {}, SHADCN_TOKENS);
  const mock = mockFor([button]);
  await pushTokens(mock, SHADCN_TOKENS);
  await pushTokens(mock, SHADCN_TOKENS);
  assert.deepEqual(mock.collections().map((c) => [c.name, c.variables.length]), [["Colors", 21], ["Radius", 4]]);
  const [build] = await runPlan(mock, coded, ["build"]);
  const unbound = (build.value as { unbound: [string, string, string, string][] }).unbound;
  assert.deepEqual(unbound.filter((u) => /variables have this name/.test(u[3])), []);
  const root = mock.handle(variantsBySlug(mock).get("variant-default--size-default")!.id) as { fills: { boundVariables?: { color?: { id: string } } }[] };
  assert.ok(root.fills[0].boundVariables?.color?.id, "the fill is bound to primary");
});

test("CLI: figma tokens reads the plan figma code wrote for its alpha variables, by default where figma code writes it", () => {
  const planned = planFor(TOKENS, {}, ALPHAS);
  const args = ["figma", "tokens", "--tokens", join(planned.dir, "tokens.json"), "--out", join(planned.dir, "out")];
  const text = execFileSync(process.execPath, [CLI, ...args, "--plan", join(planned.dir, "figma", "plan.json")], { encoding: "utf8" });
  assert.match(text, /with the alpha variables translucent paints bind to, each a color token at an alpha in every mode: background 10%, border 50%/);
  assert.match(text, /! ring 10%: the plan binds it, but no color token is named ring/);
  const json = JSON.parse(execFileSync(process.execPath, [CLI, ...args, "--plan", join(planned.dir, "figma", "plan.json"), "--json"], { encoding: "utf8" })) as { alphas: string[] };
  assert.deepEqual(json.alphas, ["background 10%", "border 50%"]);
  // By default, the plan where figma code writes it: .storysync/figma/plan.json, from the project.
  const none = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: planned.dir });
  assert.doesNotMatch(none, /alpha variable/);
  mkdirSync(join(planned.dir, ".storysync", "figma"), { recursive: true });
  writeFileSync(join(planned.dir, ".storysync", "figma", "plan.json"), readFileSync(join(planned.dir, "figma", "plan.json")));
  assert.match(execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: planned.dir }), /background 10%, border 50%/);
});

test("figma tokens: --alpha makes an alpha variable a root-only push binds, by its name, at each theme's alpha where the name gives two; a name of no color token is refused", async () => {
  // A root-only push binds by hand, so no plan names them: the agent does,
  // from the classes it binds, as shadcn/ui's bg-destructive/10
  // dark:bg-destructive/20 and border-border/50.
  const planned = planFor(TOKENS, { alpha: ["background 10% dark 20%", "border 50%", "border 50,0%"] });
  assert.deepEqual(planned.plan.alpha, ["background 10% dark 20%", "border 50%", "border 50,0%"]);
  const mock = new MockFigma();
  const [colors] = await push(mock, planned);
  assert.deepEqual(colors.alpha, ["background 10% dark 20%", "border 50%"]);
  assert.deepEqual(Object.fromEntries(mock.collections()[0].variables.filter((v) => /%/.test(v.name)).map((v) => [v.name, v.values])), {
    "background 10% dark 20%": { Light: "#ffffff1a", Dark: "#0a0a0a33" },
    "border 50%": { Light: "#e5e5e580", Dark: "#ffffff0d" },
  });
  const [again] = await push(mock, planFor(TOKENS, { alpha: ["background 10% dark 20%", "border 50%"] }));
  assert.deepEqual([changes(again), again.unchanged], [NOTHING, 5]);
  for (const name of ["ring 10%", "background", "background 10% dark"]) {
    assert.throws(() => planFor(TOKENS, { alpha: [name] }), new RegExp(`--alpha ${name}: name an alpha variable as a color token`));
  }
  const cli = execFileSync(process.execPath, [CLI, "figma", "tokens", "--tokens", join(planned.dir, "tokens.json"), "--out", join(planned.dir, "cli"), "--alpha", "border 50%", "--alpha", "background 10% dark 20%"], { encoding: "utf8" });
  assert.match(cli, /each a color token at an alpha in every mode: background 10% dark 20%, border 50%/);
});

test("figma tokens: a plan that can't be read is said, by its path, and the calls are written without its alpha variables", () => {
  const planned = planFor(TOKENS);
  const bad = join(planned.dir, "bad-plan.json");
  writeFileSync(bad, "{\n");
  const { plan, warnings } = runFigmaTokens({ tokens: join(planned.dir, "tokens.json"), out: join(planned.dir, "again"), plan: bad });
  assert.equal(plan.calls.length, 2);
  assert.equal(plan.plan, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad-plan\.json can't be read \(.*JSON.*\), so no alpha variable is made from it: run `figma code` again, whose plan makes its own/);
});

test("figma tokens: a plan's dark alpha gives its alpha variable that alpha in Dark", async () => {
  const mock = new MockFigma();
  const [colors] = await pushTokens(mock, TOKENS, {}, [{ variable: "background 10% dark 20%", token: "background", alpha: 0.102, dark: 0.2 }]);
  assert.deepEqual(colors.alpha, ["background 10% dark 20%"]);
  assert.deepEqual(mock.collections()[0].variables.find((v) => v.name === "background 10% dark 20%")!.values, { Light: "#ffffff1a", Dark: "#0a0a0a33" });
});

test("alphaCalls: the data of a call per collection that makes only a plan's alpha variables, beside the tokens they are of, listing nothing stale; a token the tokens lack is said", async () => {
  const notes: string[] = [];
  const calls = alphaCalls(TOKENS as unknown as TokenExtractionResult, ALPHAS, notes);
  assert.deepEqual(notes, ["ring 10%: no color token is named ring in the tokens, so it isn't made and its paints bind to none: save the tokens again"]);
  assert.deepEqual(calls.map((c) => [c.collection, c.alpha, (c.data.vars as unknown[][]).map((v) => v[0]), c.data.all]), [["Colors", ["background 10%", "border 50%"], ["background", "border"], undefined]]);
  // Sent to a file whose Colors an earlier push filled, it adds the two, and lists nothing stale.
  const mock = new MockFigma();
  await pushTokens(mock, TOKENS);
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "templates", "variables.js"), "utf8");
  const run = await mock.run(`const DATA = ${JSON.stringify(calls[0].data)};\n${template}`);
  assert.ok(run.ok, run.text);
  const result = run.value as Result;
  assert.deepEqual([result.created, result.updated, result.unchanged, result.stale, result.alpha], [["background 10%", "border 50%"], [], 2, undefined, ["background 10%", "border 50%"]]);
  // At most --max-variables a call, each alpha variable in its token's.
  assert.deepEqual(alphaCalls(TOKENS as unknown as TokenExtractionResult, ALPHAS, [], 2).map((c) => [c.data.part, c.alpha]), [[[1, 2], ["background 10%"]], [[2, 2], ["border 50%"]]]);
});

test("CLI: figma tokens writes the plan, and says what it left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-figma-tokens-cli-"));
  const tokens = { ...copy(TOKENS), collections: [...copy(TOKENS.collections), { category: "shadows", tokens: [{ name: "sm", value: "0 1px 2px black" }] }] };
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens));
  const out = JSON.parse(execFileSync(process.execPath, [CLI, "figma", "tokens", "--tokens", join(dir, "tokens.json"), "--out", join(dir, "out"), "--remove", "Radius/DEFAULT", "--json"], { encoding: "utf8" })) as { calls: { description: string }[]; leftOut: { name: string }[] };
  assert.deepEqual(out.calls.map((c) => c.description), [
    "Create or update the Colors variable collection (3 variables), in Light and Dark modes",
    "Create or update the Radius variable collection (3 variables), in one mode, Default, and remove Radius/DEFAULT, as the user confirmed",
  ]);
  assert.deepEqual(out.leftOut.map((t) => t.name), ["sm"]);
  const text = execFileSync(process.execPath, [CLI, "figma", "tokens", "--tokens", join(dir, "tokens.json"), "--out", join(dir, "out")], { encoding: "utf8" });
  assert.match(text, /2 use_figma calls for 6 variables in 2 collections/);
  assert.match(text, /! shadows sm: left out, a Figma variable can't hold a shadow/);
  assert.match(text, /ask the user before removing any/);
});

test("skills: every skill and the push command send the calls figma tokens writes, write no variable code, and remove a variable only once the user confirms", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const file of ["skills/claude-code.md", "skills/codex.md", "skills/cursor.mdc", "commands/storysync-push.md"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.match(text, /npx storysync figma tokens`?/, file);
    assert.match(text, /storysync tokens --json --project \. > \.storysync\/tokens\.json/, file);
    assert.match(text, /Never remove a variable on your own/, file);
    assert.match(text, /figma tokens --remove/, file);
    assert.doesNotMatch(text, /createVariableCollection|createVariable\(/, `${file} still has the agent create variables itself`);
  }
});

test("skills: every skill, the push command and the reference send the plan's variables call first for its alpha variables, name the dark theme's own, make a root-only push's with --alpha, and say a bound paint takes its variable's Dark color and alpha", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const file of ["skills/claude-code.md", "skills/codex.md", "skills/cursor.mdc", "commands/storysync-push.md", "docs/reference.md"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.match(text, /destructive 10%/, file);
    assert.match(text, /destructive 10% dark 20%/, file);
    assert.match(text, /figma tokens wrote/, file);
    assert.match(text, /figma next wrote/, file);
    assert.match(text, /`variables` call/, file);
    // No second run of figma tokens for a plan's alpha variables: the plan's first call makes them.
    assert.doesNotMatch(text, /run `npx storysync figma tokens` again|So run it again after `figma code`|Before a plan exists it says so/, file);
    // The claims probe 7c disproved: a bound variable simply taking its Dark value, and shadows left unbound.
    assert.doesNotMatch(text, /A (?:bound )?variable (?:bound this way )?takes its `?Dark`? value wherever/, file);
    assert.doesNotMatch(text, /Shadows stay unbound|Shadow colors stay unbound/, file);
    assert.match(text, /color and (?:its )?alpha|its color, and its alpha/, file);
    if (file !== "commands/storysync-push.md") assert.match(text, /--alpha/, file);
    if (file !== "docs/reference.md") {
      assert.match(text, /Translucent paints bind to N alpha variables/, file);
      assert.match(text, /Bound without their alpha variable/, file);
      assert.match(text, /no alpha variable/, file);
    }
  }
});

// shadcn/ui's outline button, `bg-background dark:bg-input/30`, here with
// border for input; AspectRatio's `bg-slate-50 dark:bg-slate-900`, palette
// colors no token names; an input's `bg-transparent dark:bg-input/30`.
const PER_MODE: PlanAlpha[] = [
  { variable: "background dark border 30%", token: "background", alpha: 1, darkToken: "border", dark: 0.302 },
  { variable: "border 0% dark 30%", token: "border", alpha: 0, dark: 0.302 },
  { variable: "slate-50 dark slate-900", token: "slate-50", alpha: 1, darkToken: "slate-900", palette: { "slate-50": "#f8fafc", "slate-900": "#0f172b" } },
];

test("figma tokens: a per-mode variable holds the light class's color in Light and the dark: class's in Dark, a palette color's too, and a push sent again changes nothing", async () => {
  const mock = new MockFigma();
  const planned = planFor(TOKENS, {}, PER_MODE);
  // The palette colors' values ride along in `ref`, never made themselves.
  assert.deepEqual(JSON.parse(/const DATA = (\{.*?\});/s.exec(planned.code(1))![1]).ref, [["slate-50", "COLOR", ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"], "#f8fafc"], ["slate-900", "COLOR", ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"], "#0f172b"]]);
  const [colors] = await push(mock, planned);
  assert.deepEqual(colors.alpha, ["background dark border 30%", "border 0% dark 30%", "slate-50 dark slate-900"]);
  assert.deepEqual(colors.stale, []);
  const values = (name: string) => mock.collections()[0].variables.find((v) => v.name === name)!.values;
  // Dark: border's dark #ffffff1a at 30% more, as Tailwind's color-mix paints input/30.
  assert.deepEqual(values("background dark border 30%"), { Light: "#ffffff", Dark: "#ffffff08" });
  assert.deepEqual(values("border 0% dark 30%"), { Light: "#e5e5e500", Dark: "#ffffff08" });
  assert.deepEqual(values("slate-50 dark slate-900"), { Light: "#f8fafc", Dark: "#0f172b" });
  assert.equal(mock.collections()[0].variables.some((v) => v.name === "slate-50" || v.name === "slate-900"), false);
  const again = await push(mock, planned);
  assert.deepEqual(changes(again[0]), NOTHING);
  // A tokens push with no plan keeps them, of its tokens and the palette, and lists none stale.
  const plain = await pushTokens(mock, TOKENS);
  assert.deepEqual([plain[0].stale, changes(plain[0])], [[], NOTHING]);
});

test("figma tokens: an alpha variable nothing binds is removed once the user confirms it, and not made again", async () => {
  const mock = new MockFigma();
  await pushTokens(mock, TOKENS, {}, [{ variable: "background 10%", token: "background", alpha: 0.102 }]);
  assert.ok(mock.collections()[0].variables.some((v) => v.name === "background 10%"));
  const [colors] = await pushTokens(mock, TOKENS, { remove: ["Colors/background 10%"] }, [{ variable: "background 10%", token: "background", alpha: 0.102 }]);
  assert.deepEqual([colors.removed, colors.alpha], [["Colors/background 10%"], []]);
  assert.equal(mock.collections()[0].variables.some((v) => v.name === "background 10%"), false);
});

test("alphaCalls: a palette pair's variable, of no token, is made in the colors' collection from its palette values", () => {
  const calls = alphaCalls(TOKENS as unknown as TokenExtractionResult, [PER_MODE[2]], []);
  assert.deepEqual(calls.map((c) => [c.collection, c.alpha, c.data.vars, (c.data.ref as unknown[][]).map((r) => r[0])]), [["Colors", ["slate-50 dark slate-900"], [], ["slate-50", "slate-900"]]]);
});

test("figma tokens: a per-mode variable writes a slashed Dark color by its class name, so Figma doesn't group it at the slash, and reads it back", async () => {
  const mock = new MockFigma();
  const pair: PlanAlpha = { variable: "background dark chart-1", token: "background", alpha: 1, darkToken: "chart/1", dark: 1 };
  const [colors] = await pushTokens(mock, TOKENS, {}, [pair]);
  assert.deepEqual([colors.alpha, colors.stale], [["background dark chart-1"], []]);
  const values = (name: string) => mock.collections()[0].variables.find((v) => v.name === name)!.values;
  assert.deepEqual(values("background dark chart-1"), { Light: "#ffffff", Dark: "#8ec5ff" });
  // Kept up to date with no plan, and made from an --alpha name alone.
  const plain = await pushTokens(mock, TOKENS);
  assert.deepEqual([plain[0].stale, changes(plain[0])], [[], NOTHING]);
  const named = await pushTokens(new MockFigma(), TOKENS, { alpha: ["border 10% dark chart-1"] });
  assert.deepEqual(named[0].alpha, ["border 10% dark chart-1"]);
});
