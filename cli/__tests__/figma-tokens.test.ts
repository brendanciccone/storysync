// `storysync figma tokens`: the calls that push the tokens' variables, run
// in the mock Figma as an agent sends them, twice and over what earlier
// pushes left.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runFigmaTokens, variablesFromTokens } from "../figma-tokens.js";
import type { FigmaTokensOptions, TokensPlan } from "../figma-tokens.js";
import type { TokenExtractionResult } from "../tokens.js";
import { SHADCN_TOKENS, codeFor, mockFor, runPlan, variantsBySlug } from "./figma-build-harness.js";
import { MockFigma, loadTreeFixture } from "./mock-figma.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

interface Result {
  kind: string; collection: string; part: [number, number]; createdCollection: boolean;
  modes: string[]; renamedModes: [string, string][]; addedModes: string[]; darkError: string | null;
  created: string[]; updated: string[]; unchanged: number; skipped: string[]; variables: number;
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

/** Writes `tokens` as tokens.json in a new directory and runs figma tokens over it. */
function planFor(tokens: object, options: Partial<FigmaTokensOptions> = {}): Planned {
  const dir = mkdtempSync(join(tmpdir(), "storysync-figma-tokens-"));
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens));
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

const pushTokens = (mock: MockFigma, tokens: object, options: Partial<FigmaTokensOptions> = {}) => push(mock, planFor(tokens, options));

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
        ["tracking/px", "FLOAT", "LETTER_SPACING", 1, undefined], ["font/sans", "STRING", "FONT_FAMILY", "ui-sans-serif, system-ui, sans-serif", undefined],
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

  // The dark theme gone again: the Dark mode stays, each value its light one, as the browser has it.
  const [dropped] = await pushTokens(mock, lightOnly);
  assert.deepEqual([dropped.modes, dropped.renamedModes, dropped.updated], [["Light", "Dark"], [], ["background", "border"]]);
  assert.deepEqual(mock.collections()[0].variables[0].values, { Light: "#ffffff", Dark: "#ffffff" });
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
