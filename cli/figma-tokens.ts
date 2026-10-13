// `storysync figma tokens`: the use_figma calls that make the tokens'
// variables, as files the agent sends unchanged.
//
// The skill had the agent fill in a template that created a collection and
// each variable every time it ran. The push command said "create or
// update", but sent to a file an earlier push had filled, as the fifth live
// push's second run was, it would have made a second Colors and Radius, and
// the build's lookup by name would have found two of every variable. The
// agent of that run rewrote the template to find things by name, and still
// never said that Radius held a DEFAULT the tokens had dropped, with the
// ALL_SCOPES the first push left on it. Now storysync writes the calls: each
// finds its collection by name, adds the Dark mode it lacks, renames a lone
// mode as the skill names it, creates or updates each variable by name and
// sets its scopes, writing only what differs, so a call sent twice changes
// nothing the second time. It lists the variables of the collection that
// no token has, and removes them only once the user has confirmed, through
// `--remove`.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { callCode, fnv1a32Bytes } from "./checksum.js";
import { assertCompiles, loadTemplate, pageSlug } from "./figma-code.js";
import type { FigmaCodeOptions } from "./figma-code.js";
import { lengthToPx, tokenColorToHex, withoutRepeatedDefault } from "./tokens.js";
import type { TokenCategory, TokenExtractionResult, TokenValue } from "./tokens.js";
import { VERSION } from "./version.js";

/** Each category's collection, by the name the skill gives it and diff reads back. */
export const COLLECTION_NAMES: Record<TokenCategory, string> = {
  colors: "Colors", spacing: "Spacing", radius: "Radius", typography: "Typography", shadows: "Shadows",
};

/** The most variables a call creates or updates: creating variables is slow, and a call that runs too long fails. */
export const DEFAULT_MAX_VARIABLES = 40;

export type VariableType = "COLOR" | "FLOAT" | "STRING";

/** A token as the variable it becomes: a color as `#rrggbb(aa)`, a FLOAT in px or as its number, a STRING as written. */
export interface PlannedVariable {
  name: string;
  type: VariableType;
  scopes: string[];
  light: string | number;
  /** Its value in Dark, where its collection has one and the value differs. */
  dark?: string | number;
}

export interface PlannedCollection {
  name: string;
  category: TokenCategory;
  modes: ["Default"] | ["Light", "Dark"];
  variables: PlannedVariable[];
}

/** A token no variable is made for, and why. */
export interface LeftOut { category: TokenCategory; name: string; why: string }

const COLOR_SCOPES = ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"];
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** How a typography token is pushed, by its name (the skill's scopes table). */
function typographyKind(name: string): { type: VariableType; scopes: string[]; number?: true } {
  if (/^font\/weight\//.test(name)) return { type: "FLOAT", scopes: ["FONT_WEIGHT"], number: true };
  if (/^(?:leading|line\/height|lh)\//.test(name)) return { type: "FLOAT", scopes: ["LINE_HEIGHT"], number: true };
  if (/^tracking\//.test(name)) return { type: "FLOAT", scopes: ["LETTER_SPACING"] };
  if (/^font\//.test(name) && !/^font\/size\//.test(name)) return { type: "STRING", scopes: ["FONT_FAMILY"] };
  // text/*, font/size/*, fs/*, and a Tailwind config's fontSize, which has no namespace.
  return { type: "FLOAT", scopes: ["FONT_SIZE"] };
}

/** A token's value as its variable takes it, or why it has none. */
function valueOf(category: TokenCategory, token: { value: string; hex?: string; px?: number }, kind: { type: VariableType; number?: true }): string | number | { why: string } {
  if (kind.type === "COLOR") {
    const hex = token.hex ?? tokenColorToHex(token.value);
    return hex && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(hex) ? hex : { why: `${token.value} is no color storysync can convert to sRGB` };
  }
  if (kind.type === "STRING") {
    return /\bvar\(/.test(token.value) ? { why: `${token.value} holds a var() storysync couldn't resolve` } : token.value;
  }
  // An older tokens output has no px: the value in px or rem is worked out here.
  const px = token.px ?? lengthToPx(token.value);
  if (px !== null && px !== undefined) return px;
  if (kind.number && NUMBER.test(token.value.trim())) return Number(token.value.trim());
  return { why: `${token.value} has no fixed size in px${category === "typography" ? " (em and % depend on the element)" : ""}` };
}

/**
 * The collections the tokens make, one per category, and the tokens left
 * out: a shadow, which no Figma variable holds; a color storysync couldn't
 * convert; a length with no px, in em or %; a value whose var() a
 * `tokens` warning says didn't resolve. A collection whose tokens have a
 * dark value has Light and Dark modes, and every other one Default.
 */
export function variablesFromTokens(tokens: TokenExtractionResult): { collections: PlannedCollection[]; leftOut: LeftOut[]; notes: string[] } {
  const unresolved = new Set<string>();
  for (const w of tokens.warnings ?? []) {
    const m = /^Unresolved: (\w+) (\S+) = /.exec(w);
    if (m) unresolved.add(`${m[1]}/${m[2]}`);
  }
  const leftOut: LeftOut[] = [];
  const notes: string[] = [];
  const byName = new Map<string, PlannedCollection>();
  for (const { category, tokens: list } of withoutRepeatedDefault(tokens.collections ?? [])) {
    for (const token of list as TokenValue[]) {
      if (category === "shadows") {
        leftOut.push({ category, name: token.name, why: "a Figma variable can't hold a shadow" });
        continue;
      }
      if (unresolved.has(`${category}/${token.name}`)) {
        leftOut.push({ category, name: token.name, why: "a `tokens` warning says its var() didn't resolve" });
        continue;
      }
      const kind = category === "colors"
        ? { type: "COLOR" as const, scopes: COLOR_SCOPES }
        : category === "typography" ? typographyKind(token.name)
        : { type: "FLOAT" as const, scopes: category === "radius" ? ["CORNER_RADIUS"] : ["GAP", "WIDTH_HEIGHT"] };
      const light = valueOf(category, token, kind);
      if (typeof light === "object") {
        leftOut.push({ category, name: token.name, why: light.why });
        continue;
      }
      const variable: PlannedVariable = { name: token.name, type: kind.type, scopes: kind.scopes, light };
      if (token.dark) {
        const dark = valueOf(category, token.dark, kind);
        if (typeof dark === "object") notes.push(`${category} ${token.name}: its dark value ${token.dark.value} can't be pushed (${dark.why}), so Dark keeps its light value`);
        else if (dark !== light) variable.dark = dark;
      }
      const name = COLLECTION_NAMES[category];
      const collection: PlannedCollection = byName.get(name) ?? { name, category, modes: ["Default"], variables: [] };
      if (collection.variables.some((v) => v.name === variable.name)) {
        notes.push(`${category} ${token.name}: the tokens give it twice, so the first is pushed`);
        continue;
      }
      collection.variables.push(variable);
      byName.set(name, collection);
    }
  }
  const collections = [...byName.values()];
  for (const c of collections) if (c.variables.some((v) => v.dark !== undefined)) c.modes = ["Light", "Dark"];
  return { collections, leftOut, notes };
}

export interface FigmaTokensOptions {
  /** `storysync tokens --json` output. */
  tokens: string;
  /** Where plan.json, calls/ and results/ go. */
  out: string;
  /** Variables the user confirmed removing, as `Collection/name`, from a response's `stale` or `conflicts`. */
  remove?: string[];
  maxVariables?: number;
  minify?: boolean;
  templates?: FigmaCodeOptions["templates"];
}

/** One planned call: a part of one collection. Paths are relative to the plan's directory. */
export interface TokensPlanCall {
  seq: number;
  kind: "variables";
  collection: string;
  part: [number, number];
  variables: number;
  file: string;
  result: string;
  description: string;
  chars: number;
}

export interface TokensPlan {
  version: 1;
  kind: "variables";
  storysyncVersion: string;
  tokens: { path: string; digest: string };
  calls: TokensPlanCall[];
  leftOut: LeftOut[];
  remove?: string[];
}

const PLAN_FILES: Record<"calls" | "results", RegExp> = {
  calls: /^\d{2,}-variables-[a-z0-9-]+\.js$/,
  results: /^\d{2,}\.json$/,
};

const pad = (seq: number) => String(seq).padStart(2, "0");

/**
 * Writes plan.json and a call per collection, or per part of a large one,
 * removing an earlier plan's calls and results under `out` and nothing
 * else. Each `--remove` entry must name a collection the plan makes.
 */
export function runFigmaTokens(opts: FigmaTokensOptions): { plan: TokensPlan; planPath: string; collections: PlannedCollection[]; warnings: string[] } {
  const max = opts.maxVariables ?? DEFAULT_MAX_VARIABLES;
  if (!Number.isInteger(max) || max < 1) throw new Error(`--max-variables ${max} is not a positive whole number`);
  if (!existsSync(opts.tokens)) {
    throw new Error(`no tokens at ${opts.tokens}: save them first with \`npx storysync tokens --json --project . > ${opts.tokens}\``);
  }
  const bytes = readFileSync(opts.tokens);
  const tokens = JSON.parse(bytes.toString("utf8")) as TokenExtractionResult;
  if (!Array.isArray(tokens?.collections)) throw new Error(`${opts.tokens} is not \`storysync tokens --json\` output`);
  const { collections, leftOut, notes } = variablesFromTokens(tokens);
  if (!collections.length) throw new Error(`${opts.tokens} has no token a Figma variable can hold: there is nothing to push`);

  // Each confirmed removal, by the collection it is in.
  const removals = new Map<string, string[]>();
  for (const raw of opts.remove ?? []) {
    const slash = raw.indexOf("/");
    const collection = collections.find((c) => c.name === raw.slice(0, slash));
    if (slash < 1 || slash === raw.length - 1 || !collection) {
      throw new Error(`--remove ${raw}: name a variable as Collection/name, as a response's stale or conflicts list it, in ${collections.map((c) => c.name).join(", ")}`);
    }
    removals.set(collection.name, [...new Set([...(removals.get(collection.name) ?? []), raw.slice(slash + 1)])]);
  }

  const template = loadTemplate("variables", opts.minify ?? true, opts.templates);
  const calls: (TokensPlanCall & { code: string })[] = [];
  for (const collection of collections) {
    const parts = Math.ceil(collection.variables.length / max);
    const remove = removals.get(collection.name);
    for (let p = 0; p < parts; p++) {
      const vars = collection.variables.slice(p * max, (p + 1) * max);
      const seq = calls.length + 1;
      const data = {
        collection: collection.name,
        modes: collection.modes,
        part: [p + 1, parts],
        vars: vars.map((v) => (v.dark === undefined ? [v.name, v.type, v.scopes, v.light] : [v.name, v.type, v.scopes, v.light, v.dark])),
        ...(p === 0 ? { all: collection.variables.map((v) => [v.name, v.type]) } : {}),
        ...(p === 0 && remove ? { remove } : {}),
      };
      const modes = collection.modes.length > 1 ? "in Light and Dark modes" : "in one mode, Default";
      const span = parts > 1 ? `, variables ${p * max + 1}-${p * max + vars.length} of ${collection.variables.length}` : ` (${vars.length} variable${vars.length === 1 ? "" : "s"})`;
      const removing = p === 0 && remove ? `, and remove ${remove.map((r) => `${collection.name}/${r}`).join(", ")}, as the user confirmed` : "";
      const description = `Create or update the ${collection.name} variable collection${span}, ${modes}${removing}`;
      const file = `calls/${pad(seq)}-variables-${pageSlug(collection.name)}.js`;
      const code = `// storysync figma tokens, call ${pad(seq)}: the ${collection.name} variables. Send this file unchanged as use_figma's code.\n${callCode([["DATA", data]], template)}`;
      assertCompiles(code, file, "variables", template);
      calls.push({ seq, kind: "variables", collection: collection.name, part: [p + 1, parts], variables: vars.length, file, result: `results/${pad(seq)}.json`, description, chars: code.length, code });
    }
  }

  const out = resolve(opts.out);
  for (const [dir, pattern] of Object.entries(PLAN_FILES)) {
    const at = join(out, dir);
    if (!existsSync(at) || !lstatSync(at).isDirectory()) continue;
    for (const name of readdirSync(at)) if (pattern.test(name) && lstatSync(join(at, name)).isFile()) rmSync(join(at, name));
  }
  mkdirSync(join(out, "calls"), { recursive: true });
  mkdirSync(join(out, "results"), { recursive: true });
  for (const call of calls) writeFileSync(join(out, call.file), call.code);
  const plan: TokensPlan = {
    version: 1, kind: "variables", storysyncVersion: VERSION,
    tokens: { path: relative(out, resolve(opts.tokens)).split("\\").join("/"), digest: fnv1a32Bytes(bytes) },
    calls: calls.map(({ code: _code, ...call }) => call),
    leftOut,
    ...(opts.remove?.length ? { remove: [...removals].flatMap(([c, names]) => names.map((n) => `${c}/${n}`)) } : {}),
  };
  const planPath = join(out, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, planPath, collections, warnings: notes };
}
