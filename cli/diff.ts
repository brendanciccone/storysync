// Diff engine — compares code-extracted tokens and component mappings against Figma state.

import type { TokenCollection, TokenCategory, TokenValue } from "./tokens.js";
import { tokenColorToHex, lengthToPx } from "./tokens.js";
import type { FigmaComponentDefinition } from "./mapper.js";
import type { FigmaVariable, FigmaComponentInfo } from "./figma.js";
import { componentNames, selectComponents, titleLeaf } from "./storybook.js";
import type { ComponentEntry } from "./storybook.js";
import { colorToHex } from "./color.js";
import { parseAlphaVariable } from "./figma-bind.js";

// --- Token diff ---

export interface TokenDiffEntry {
  category: string;
  name: string;
  codeValue: string | null;
  figmaValue: string | null;
  status: "match" | "value_mismatch" | "missing_from_figma" | "missing_from_code";
  /**
   * The Figma mode a difference is in, where it is the dark theme's: the
   * variable's Dark mode, or `Dark` for a dark value Figma has no mode for.
   * Absent for the light theme, compared with each collection's first mode.
   */
  mode?: string;
}

// --- Component diff ---

export interface ComponentDiffEntry {
  /**
   * The component's set name, or, where another component shares it, its
   * Storybook title or its Figma page and set name: `ui/base/Button`.
   */
  name: string;
  status: "match" | "variant_mismatch" | "code_only" | "figma_only" | "ambiguous" | "errored";
  details: string[];
  /** The Storybook ID of the code component, when there is one and diff knows it. */
  id?: string;
  /** The Figma page of the component set, when there is one. */
  page?: string;
  /** The Figma node id of a set Figma flags as errored, to find it by. */
  nodeId?: string;
}

// --- Combined result ---

export interface DiffResult {
  tokens: TokenDiffEntry[];
  components: ComponentDiffEntry[];
  summary: DiffSummary;
}

export interface DiffSummary {
  tokensMatched: number;
  tokensMismatched: number;
  tokensMissingFromFigma: number;
  tokensMissingFromCode: number;
  componentsMatched: number;
  componentsMismatched: number;
  componentsCodeOnly: number;
  componentsFigmaOnly: number;
  /** Names whose copies no page told apart, so none of them was compared. */
  componentsAmbiguous: number;
  /** Sets Figma flags as errored, whose properties it won't give, so none was compared. */
  componentsErrored: number;
}

// --- Collection name → token category mapping ---

const COLLECTION_CATEGORY_MAP: Record<string, TokenCategory> = {
  colors: "colors",
  colour: "colors",
  color: "colors",
  spacing: "spacing",
  space: "spacing",
  typography: "typography",
  font: "typography",
  "font size": "typography",
  "font sizes": "typography",
  radius: "radius",
  radii: "radius",
  "border radius": "radius",
  shadows: "shadows",
  shadow: "shadows",
  elevation: "shadows",
};

export function figmaCollectionToCategory(collectionName: string): string {
  return COLLECTION_CATEGORY_MAP[collectionName.toLowerCase().trim()] ?? collectionName.toLowerCase().trim();
}

// --- Value normalization ---

// Colors are compared as sRGB hex, converted from any form a browser or a
// token source writes, oklch() and the rest of CSS Color 4 included. The
// converter lives in color.ts, shared with snap; it is re-exported here, where
// it has always been imported from.
export { colorToHex };

// Convert numeric values to a comparable canonical form. A length becomes a
// string of pixels (e.g. "16"), worked out by tokens' lengthToPx, so rem and
// calc() count; a unitless number, as Figma gives a FLOAT variable's value,
// stays itself. Both are rounded to thousandths, so a float with a tail of
// binary noise still matches. Anything else is returned normalized, to
// compare as text.
export function numericToPx(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/;$/, "").replace(/^['"]|['"]$/g, "");

  const px = lengthToPx(s);
  if (px !== null) return stripTrailingZero(px);

  const unitless = s.match(/^-?[\d.]+(?:e[+-]?\d+)?$/);
  if (unitless) return stripTrailingZero(Math.round(parseFloat(s) * 1000) / 1000);

  return s;
}

function stripTrailingZero(n: number): string {
  return n % 1 === 0 ? n.toString() : n.toString().replace(/0+$/, "").replace(/\.$/, "");
}

// Canonicalize a compound value (e.g. shadow `0 4px 6px rgba(...)`) for string-equality comparison.
// Lowercases, collapses whitespace, normalizes hex colors inside the expression.
export function canonicalizeCompound(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/;$/, "");
  // Collapse runs of whitespace to a single space
  s = s.replace(/\s+/g, " ");
  // Tidy commas
  s = s.replace(/\s*,\s*/g, ", ");
  return s;
}

/**
 * What tokens worked out for a token, compared in place of its value when it
 * has it: a color's hex, a length's px. tokens resolves a var() inside a
 * value for them, which a value from `:root` can keep, as in
 * `calc(var(--radius) - 4px)`.
 */
function workedOutForCompare(category: string, token: TokenValue): string | undefined {
  if (category === "colors") return token.hex?.toLowerCase();
  if (category === "spacing" || category === "radius" || category === "typography") {
    return token.px === undefined ? undefined : stripTrailingZero(token.px);
  }
  return undefined;
}

function normalizeForCompare(category: string, value: string): string {
  if (category === "colors") {
    // tokenColorToHex also reads bare HSL channels, `0 0% 100%`, as hsl().
    return tokenColorToHex(value) ?? value.trim().toLowerCase();
  }
  if (category === "spacing" || category === "radius" || category === "typography") {
    return numericToPx(value);
  }
  // Shadows and unknown categories: canonicalize the raw expression
  return canonicalizeCompound(value);
}

// --- Token diffing ---

/** Whether a Figma mode is a dark theme's, by its name: `Dark`, `Dark mode`, `dark`. */
const isDarkMode = (mode: string) => /dark/i.test(mode);

/** The variable's dark mode, by name, other than the one its `value` is in, or undefined. */
function darkModeOf(fv: FigmaVariable): string | undefined {
  return Object.keys(fv.modes ?? {}).find((mode) => mode !== fv.mode && isDarkMode(mode));
}

export interface TokenDiffOptions {
  /** The modes the code's tokens fill, tokens' `modes`: the dark theme is compared only where they include Dark. */
  codeModes?: string[];
  /** The one Figma mode read, as `diff --mode` names it; then no other is compared. */
  mode?: string;
}

/**
 * Each code token against the Figma variable of its category and name: the
 * light value against the variable's first mode, or the mode `--mode`
 * read, and, where the code has a dark theme, its dark value against the
 * variable's Dark mode. A token's dark value is its light one where it has
 * none, as in the browser. A token with a dark value whose variable has no
 * Dark mode is missing from Figma there. Each difference is an entry, the
 * dark theme's with its `mode`; a token that matches in every mode
 * compared is one `match`.
 */
export function diffTokens(codeTokens: TokenCollection[], figmaVars: FigmaVariable[], options: TokenDiffOptions = {}): TokenDiffEntry[] {
  const entries: TokenDiffEntry[] = [];
  const codeDark = !!options.codeModes?.includes("Dark");
  // With --mode naming the dark one, that mode is compared with the dark theme.
  const readDark = options.mode !== undefined && codeDark && isDarkMode(options.mode);

  // Build code map: "category/tokenName" → value
  type Side = { value: string; workedOut?: string };
  const codeMap = new Map<string, Side & { category: string; dark?: Side }>();
  for (const coll of codeTokens) {
    for (const token of coll.tokens) {
      const dark = token.dark ? { value: token.dark.value, workedOut: workedOutForCompare(coll.category, { name: token.name, ...token.dark }) } : undefined;
      const light = { value: token.value, workedOut: workedOutForCompare(coll.category, token) };
      codeMap.set(`${coll.category}/${token.name}`, { ...(readDark && dark ? dark : light), category: coll.category, dark: readDark ? undefined : dark });
    }
  }

  // Build Figma map: "category/variableName" → value
  const figmaMap = new Map<string, FigmaVariable>();
  for (const fv of figmaVars) {
    const category = figmaCollectionToCategory(fv.collection);
    figmaMap.set(`${category}/${fv.name}`, fv);
  }
  // An earlier push made a radius DEFAULT that repeats a step, which tokens
  // now leaves out (withoutRepeatedDefault): it isn't missing from code.
  const radii = [...figmaMap].filter(([key]) => key.startsWith("radius/")).map(([, fv]) => fv);
  const valuesOf = (fv: FigmaVariable) => JSON.stringify([normalizeForCompare("radius", fv.value), ...Object.values(fv.modes ?? {}).map((v) => normalizeForCompare("radius", v))]);
  const repeat = figmaMap.get("radius/DEFAULT");
  if (repeat && !codeMap.has("radius/DEFAULT") && radii.some((fv) => fv !== repeat && valuesOf(fv) === valuesOf(repeat))) figmaMap.delete("radius/DEFAULT");
  // An alpha variable, `destructive 10%`, is a code color token at an
  // alpha, which `figma tokens` makes beside it for the paints a push binds
  // translucent (figma-bind.ts) and keeps up to date with it: it isn't
  // missing from code while its token is in it.
  for (const [key, fv] of [...figmaMap]) {
    const alpha = key.startsWith("colors/") ? parseAlphaVariable(fv.name) : null;
    if (alpha && codeMap.has(`colors/${alpha.token}`)) figmaMap.delete(key);
  }

  const same = (category: string, code: Side, figmaValue: string) =>
    (code.workedOut ?? normalizeForCompare(category, code.value)) === normalizeForCompare(category, figmaValue);

  // Code tokens vs Figma
  for (const [key, code] of codeMap) {
    const figma = figmaMap.get(key);
    const slash = key.indexOf("/");
    const category = key.slice(0, slash);
    const name = key.slice(slash + 1);

    if (!figma) {
      entries.push({ category, name, codeValue: code.value, figmaValue: null, status: "missing_from_figma" });
      continue;
    }
    const light: TokenDiffEntry = {
      category,
      name,
      codeValue: code.value,
      figmaValue: figma.value,
      status: same(category, code, figma.value) ? "match" : "value_mismatch",
    };
    let dark: TokenDiffEntry | null = null;
    if (codeDark && options.mode === undefined) {
      const mode = darkModeOf(figma);
      const codeValue = code.dark ?? code;
      if (mode !== undefined) {
        const figmaValue = figma.modes![mode];
        if (!same(category, codeValue, figmaValue)) dark = { category, name, codeValue: codeValue.value, figmaValue, status: "value_mismatch", mode };
      } else if (code.dark) {
        dark = { category, name, codeValue: code.dark.value, figmaValue: null, status: "missing_from_figma", mode: "Dark" };
      }
    }
    if (light.status !== "match" || !dark) entries.push(light);
    if (dark) entries.push(dark);
  }

  // Figma tokens not in code
  for (const [key, figma] of figmaMap) {
    if (!codeMap.has(key)) {
      const slash = key.indexOf("/");
      const category = key.slice(0, slash);
      const name = key.slice(slash + 1);
      entries.push({ category, name, codeValue: null, figmaValue: figma.value, status: "missing_from_code" });
    }
  }

  return entries;
}

/**
 * The Figma modes diffTokens compared with nothing, by collection: every
 * mode but the first and the Dark one, and the Dark one too where the code
 * has no dark theme. None with `--mode`, which reads the one mode asked
 * for. For the report to name, so a count of matches isn't read as
 * covering them.
 */
export function modesNotCompared(figmaVars: FigmaVariable[], options: TokenDiffOptions = {}): { collection: string; modes: string[] }[] {
  const codeDark = !!options.codeModes?.includes("Dark");
  const byCollection = new Map<string, Set<string>>();
  for (const fv of figmaVars) {
    if (options.mode !== undefined || !fv.modes) continue;
    const left = byCollection.get(fv.collection) ?? new Set<string>();
    const dark = codeDark ? darkModeOf(fv) : undefined;
    for (const mode of Object.keys(fv.modes)) if (mode !== fv.mode && mode !== dark) left.add(mode);
    byCollection.set(fv.collection, left);
  }
  return [...byCollection].filter(([, modes]) => modes.size).map(([collection, modes]) => ({ collection, modes: [...modes] }));
}

// --- Component diffing ---

/** A component mapped from Storybook, with its Storybook ID where diff knows it. */
export type CodeComponent = FigmaComponentDefinition & { id?: string };

/**
 * The page the push puts a component's set on, as the skill's Components step
 * 4 says: its whole category, `ui/base` for `ui/base/Button`, or `Components`
 * when it has none.
 */
export function pushPage(component: { category?: string }): string {
  return component.category || "Components";
}

/**
 * The name the push gives a component's set: its title's last segment, the
 * name Storybook's sidebar shows (`Tooltip` for `ui/base/Tooltip`, whose
 * `component` may be `TooltipContent`), or its name when it has no title.
 */
export function pushSetName(component: { name: string; title?: string }): string {
  return titleLeaf(component.title) ?? component.name;
}

/**
 * A page name as pages are compared: lowercased, without spaces, `/`, `-` or
 * `_`. A page an earlier push named `UI Base`, from a title rebuilt from its
 * ID, is still the page of the category `ui/base`, as the push finds it.
 */
export function pageKey(page: string): string {
  return page.toLowerCase().replace(/[\s/_-]+/g, "");
}

/**
 * The names a Figma set goes by in `--components`: its name, its page and
 * name, `ui/base/Button`, and the Storybook ID the push stored on it.
 */
function figmaNames(component: FigmaComponentInfo): string[] {
  const names = component.page ? [component.name, `${component.page}/${component.name}`] : [component.name];
  return component.storybookId != null ? [...names, component.storybookId] : names;
}

/** What `--components` selects for a component diff. */
export interface DiffSelection {
  /** The code components it selects: the ones to map, compare and report. */
  entries: ComponentEntry[];
  /**
   * Code's other components. diffComponents pairs them as it pairs the rest,
   * with those code couldn't map, and reports nothing of them: left out of
   * the pairing, they would change what a selected component pairs with.
   */
  others: ComponentEntry[];
  /** The Figma sets that may be reported as not in code: those it names. */
  figmaReported: FigmaComponentInfo[];
}

/**
 * Narrows a component diff to the names given with `--components`.
 *
 * Storybook components are selected exactly as snap and map select them. A
 * name found only in Figma is not a typo, though: it asks whether that
 * component exists in code yet, and the answer is a `figma_only` entry, which
 * fails `--strict`. So only a name neither side has is an error.
 *
 * The selected components are paired with every Figma set, beside every other
 * code component, so each is paired as the whole diff pairs it. Narrowed to
 * the sets named like the selection, a component could pair otherwise: with
 * Radix's Button moved off its page, `ui-radix-button` was weighed against
 * Base UI's set too, which the whole diff pairs with Base UI's Button. Of the
 * sets no code component pairs with, only those the names name are reported:
 * the rest weren't asked about, and would fail `--strict` on any file that
 * holds more than the selection.
 */
export function selectDiffComponents(
  entries: ComponentEntry[],
  figmaComponents: FigmaComponentInfo[],
  names: readonly string[] | undefined,
): DiffSelection {
  const selected = selectComponents(entries, names, figmaComponents.flatMap(figmaNames));
  if (!componentNames(names).length) return { entries: selected, others: [], figmaReported: figmaComponents };
  const chosen = new Set(selected);
  return {
    entries: selected,
    others: entries.filter((e) => !chosen.has(e)),
    figmaReported: narrowFigmaComponents(figmaComponents, names),
  };
}

/**
 * Narrows Figma's components to the names given with `--components`, by name
 * or page and name, ignoring case, and without checking any name for a typo.
 * On its own, it is for a diff whose Storybook listing failed: with the code
 * side unknown, a name can't be told from a typo, but the components left out
 * must still not all be reported as missing from code.
 */
export function narrowFigmaComponents(
  figmaComponents: FigmaComponentInfo[],
  names: readonly string[] | undefined,
): FigmaComponentInfo[] {
  const wanted = componentNames(names);
  if (!wanted.length) return figmaComponents;
  const keep = new Set(wanted.map((n) => n.toLowerCase()));
  return figmaComponents.filter((c) => figmaNames(c).some((n) => keep.has(n.toLowerCase())));
}

/**
 * Compares code's components with Figma's component sets, and its components
 * outside any set, pairing each code component with the node the push would
 * have made for it.
 *
 * A node the push stored a Storybook ID on (`storybookId`) is that
 * component's, whatever its name or page: a designer may have renamed it or
 * moved it to a page of their own. It pairs with the code component of that
 * ID and with no other, so a node whose ID no code component has is not in
 * code. Two nodes of one ID, a set duplicated, are told apart by page as two
 * of a name are below.
 *
 * The rest pair by name. A code component's set is named by its title's last
 * segment (pushSetName), or by its display name where Figma has a set of that
 * and none of the title's, as a push before titles named them, unless another
 * code component's set goes by that name: that set is the other component's,
 * and the two would be one name nothing tells apart. A name one code
 * component and one set have is a pair, whatever page the set is on, unless
 * another of that name was paired by ID. Radix's Button, left behind when
 * Base UI's paired by ID, is still one of two Buttons: it pairs by page as
 * below, not with whatever set of the name is left, such as a designer's own
 * on another page.
 *
 * Two distinct components can share a name. `Forms/Button` and `Nav/Button`
 * are ordinary in a real design system, and a library with Base UI and Radix
 * copies shares every name. Paired on the name alone, one would be dropped
 * before any comparison and `diff --strict` would report "no differences" for
 * a library it never fully read; reported as ambiguous, all of them were, and
 * on such a library nothing was ever compared. The push puts each category on
 * a page of its own, so a shared name is told apart by page: a code component
 * and a set of its name on the page the push gives it, each the only one of
 * the name on that page on its side, are a pair. Of the copies left, code
 * components alone are not in Figma, and sets alone not in code. Copies left
 * on both sides are a name nothing can tell apart, even one of each: the set
 * may be the component's, moved to another page, or an archived copy beside
 * a component not pushed yet, and compared, either would be vouched for as a
 * pair nothing chose. They are reported as ambiguous, and nothing else.
 *
 * A component outside any set with no Storybook ID on it is a designer's
 * own, as an icon or a part is, unless its page says otherwise: the push
 * makes a component with no variant properties a plain component, and an
 * icon named `Calendar` is not shadcn's Calendar. So it pairs only with a
 * code component the sets left not in Figma, of its name, on that
 * component's page, each the only one there; and it never makes a set's name
 * ambiguous. One left unpaired is not in code, as a set is.
 *
 * A set Figma flags as errored, whose properties it won't give, pairs as any
 * set does but is reported as errored, compared with nothing.
 *
 * `notCompared` are the components code has that were not compared: those it
 * could not map, and those `--components` left out. They are paired like the
 * rest, so a selection pairs as the whole diff does, but report nothing, and
 * neither does a set paired with one: never compared, it is not "not in
 * code". Of the sets paired with none, only those in `figmaReported` are
 * reported, and an ambiguous name only with a compared component or such a
 * set among its copies.
 *
 * `codeRead: false` says Storybook's listing failed, so nothing of code is
 * known: a node whose stored ID no component has is then not said to be one
 * code no longer has.
 */
export function diffComponents(
  codeComponents: CodeComponent[],
  figmaComponents: FigmaComponentInfo[],
  notCompared: { name: string; title?: string; category?: string; id?: string }[] = [],
  figmaReported: readonly FigmaComponentInfo[] = figmaComponents,
  { codeRead = true }: { codeRead?: boolean } = {},
): ComponentDiffEntry[] {
  const code: (CodeComponent & { notCompared?: true })[] = [
    ...codeComponents,
    ...notCompared.map((c) => ({ ...c, variantProperties: [], variantCombinations: [], wasCapped: false, notCompared: true as const })),
  ];
  const reported = new Set(figmaReported);
  const isStray = (f: FigmaComponentInfo) => f.type === "COMPONENT" && f.storybookId == null;

  // Each node with a Storybook ID code has goes in that ID's group, beside its
  // component; one with an ID code lacks is in none, and not in code. The
  // rest are grouped by name, but for strays, which pair after the sets.
  const codeIds = new Set(code.flatMap((c) => (c.id != null ? [c.id] : [])));
  const ID = "id\u0000";
  const figmaKey = figmaComponents.map((f) => {
    if (f.storybookId != null) return codeIds.has(f.storybookId) ? ID + f.storybookId : null;
    return isStray(f) ? null : f.name.toLowerCase();
  });
  const byName = (j: number) => figmaKey[j] !== null && !figmaKey[j]!.startsWith(ID);
  const idGroups = new Set(figmaKey.filter((k, j) => k !== null && !byName(j)));
  const figmaOnly = new Set(figmaComponents.flatMap((f, j) => (f.storybookId != null && figmaKey[j] === null ? [j] : [])));

  const figmaNamed = new Set(figmaComponents.filter((_, j) => byName(j)).map((f) => f.name.toLowerCase()));
  const ownSets = new Set(code.map((c) => pushSetName(c).toLowerCase()));
  const byId = code.map((c) => c.id != null && idGroups.has(ID + c.id));
  // A component paired by ID goes by the name the push gives its set: an
  // earlier name is only for finding a set an earlier push named so.
  const setName = code.map((c, i) => {
    const name = pushSetName(c);
    const earlier = c.name.toLowerCase();
    return byId[i] || figmaNamed.has(name.toLowerCase()) || !figmaNamed.has(earlier) || ownSets.has(earlier) ? name : c.name;
  });

  const groups = new Map<string, { code: number[]; figma: number[] }>();
  const group = (key: string) => groups.get(key) ?? groups.set(key, { code: [], figma: [] }).get(key)!;
  code.forEach((_, i) => group(byId[i] ? ID + code[i].id : setName[i].toLowerCase()).code.push(i));
  figmaComponents.forEach((_, j) => {
    if (figmaKey[j] !== null) group(figmaKey[j]!).figma.push(j);
  });

  // How many components go by each name on each side, counted before IDs
  // take any out of their name's group: a copy left alone in its group is
  // still one of a shared name, which only a page tells apart. Strays never
  // make a name shared.
  const codeNameCount = count(setName.map((n) => n.toLowerCase()));
  const figmaSetNameCount = count(figmaComponents.filter((f) => !isStray(f)).map((f) => f.name.toLowerCase()));

  const pairedWith = new Map<number, number>();
  const codeOnly = new Set<number>();
  const entries: ComponentDiffEntry[] = [];
  const undecided: { codeLeft: number[]; figmaLeft: number[]; byPage: number; key: string }[] = [];

  for (const [key, { code: codeCopies, figma: figmaCopies }] of groups) {
    const nameShared = !key.startsWith(ID) && ((codeNameCount.get(key) ?? 0) > 1 || (figmaSetNameCount.get(key) ?? 0) > 1);
    if (codeCopies.length === 1 && figmaCopies.length === 1 && !nameShared) {
      pairedWith.set(codeCopies[0], figmaCopies[0]);
      continue;
    }
    let codeLeft = codeCopies;
    let figmaLeft = figmaCopies;
    let byPage = 0;
    if (codeCopies.length > 1 || figmaCopies.length > 1 || nameShared) {
      byPage = pairByPage(codeCopies, figmaCopies, code, figmaComponents, pairedWith);
      const paired = new Set(pairedWith.values());
      codeLeft = codeCopies.filter((i) => !pairedWith.has(i));
      figmaLeft = figmaCopies.filter((j) => !paired.has(j));
    }

    if (!figmaLeft.length) codeLeft.forEach((i) => codeOnly.add(i));
    else if (!codeLeft.length) figmaLeft.forEach((j) => figmaOnly.add(j));
    else if (codeLeft.some((i) => !code[i].notCompared) || figmaLeft.some((j) => reported.has(figmaComponents[j]))) {
      undecided.push({ codeLeft, figmaLeft, byPage, key });
    }
  }
  // An ambiguous name says how many of its copies IDs paired, once all have.
  const pairedById = count(code.flatMap((_, i) => (byId[i] && pairedWith.has(i) ? [setName[i].toLowerCase()] : [])));
  for (const { codeLeft, figmaLeft, byPage, key } of undecided) {
    const idKey = key.startsWith(ID);
    entries.push(ambiguousEntry(codeLeft.map((i) => code[i]), figmaLeft.map((j) => figmaComponents[j]), byPage, setName[codeLeft[0]], idKey, idKey ? 0 : pairedById.get(key) ?? 0));
  }

  // A component outside any set, with no ID on it, pairs only on the page of
  // a code component the sets left not in Figma.
  const strays = figmaComponents.flatMap((f, j) => (isStray(f) ? [j] : []));
  pairByPage([...codeOnly], strays, code, figmaComponents, pairedWith, (i) => setName[i].toLowerCase(), (f) => f.name.toLowerCase());
  for (const i of pairedWith.keys()) codeOnly.delete(i);
  const strayPaired = new Set(pairedWith.values());
  for (const j of strays) if (!strayPaired.has(j)) figmaOnly.add(j);

  // A shared name is said with what tells its copies apart.
  const figmaNameCount = count(figmaComponents.map((f) => f.name.toLowerCase()));
  const shared = (name: string) => (codeNameCount.get(name) ?? 0) > 1 || (figmaNameCount.get(name) ?? 0) > 1;
  const codeLabel = (i: number) => {
    const c = code[i];
    return shared(setName[i].toLowerCase()) ? c.title ?? c.id ?? `${pushPage(c)}/${setName[i]}` : setName[i];
  };
  const figmaLabel = (f: FigmaComponentInfo) =>
    shared(f.name.toLowerCase()) && f.page != null ? `${f.page}/${f.name}` : f.name;
  const where = (c: CodeComponent | null, f?: FigmaComponentInfo) => ({
    ...(c?.id != null ? { id: c.id } : {}),
    ...(f?.page != null ? { page: f.page } : {}),
    ...(f?.error != null && f.nodeId != null ? { nodeId: f.nodeId } : {}),
  });

  code.forEach((c, i) => {
    if (c.notCompared) return;
    if (codeOnly.has(i)) {
      const propCount = c.variantProperties.length;
      const detail = propCount === 0
        ? "no variants in code"
        : `${propCount} variant prop${propCount === 1 ? "" : "s"} in code`;
      entries.push({ name: codeLabel(i), status: "code_only", details: [detail], ...where(c) });
      return;
    }
    const j = pairedWith.get(i);
    if (j === undefined) return;
    const f = figmaComponents[j];
    if (f.error != null) {
      entries.push({ name: codeLabel(i), status: "errored", details: [erroredDetail(f)], ...where(c, f) });
      return;
    }
    const details = compareVariants(c, f);
    entries.push({ name: codeLabel(i), status: details.length ? "variant_mismatch" : "match", details, ...where(c, f) });
  });

  // Figma components not in code
  figmaComponents.forEach((f, j) => {
    if (!figmaOnly.has(j) || !reported.has(f)) return;
    // A node carrying an ID code has is a second copy of that component's.
    const notInCode = f.storybookId == null
      ? null
      : codeIds.has(f.storybookId)
        ? `carries the Storybook ID ${f.storybookId} of a component paired with another`
        : codeRead
          ? `pushed from ${f.storybookId}, which code no longer has`
          : `pushed from ${f.storybookId}`;
    if (f.error != null) {
      entries.push({ name: figmaLabel(f), status: "errored", details: [erroredDetail(f), notInCode ?? "no component in code pairs with it"], ...where(null, f) });
      return;
    }
    const propCount = f.variantProperties.length;
    const detail = propCount === 0
      ? "no variants in Figma"
      : `${propCount} variant prop${propCount === 1 ? "" : "s"} in Figma`;
    entries.push({ name: figmaLabel(f), status: "figma_only", details: notInCode ? [detail, notInCode] : [detail], ...where(null, f) });
  });

  return entries;
}

function count(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}

/**
 * Pairs each code component with the Figma node on the page the push gives
 * it, where each is the only one there on its side, matched by `codeKey` and
 * `figmaKey` too when given. Returns how many it paired.
 */
function pairByPage(
  codeCopies: number[],
  figmaCopies: number[],
  code: CodeComponent[],
  figma: FigmaComponentInfo[],
  pairedWith: Map<number, number>,
  codeKey: (i: number) => string = () => "",
  figmaKey: (f: FigmaComponentInfo) => string = () => "",
): number {
  const pages = new Map<string, { code: number[]; figma: number[] }>();
  const page = (key: string) => pages.get(key) ?? pages.set(key, { code: [], figma: [] }).get(key)!;
  for (const i of codeCopies) page(`${pageKey(pushPage(code[i]))}\u0000${codeKey(i)}`).code.push(i);
  for (const j of figmaCopies) {
    const name = figma[j].page;
    if (name != null) page(`${pageKey(name)}\u0000${figmaKey(figma[j])}`).figma.push(j);
  }
  let paired = 0;
  for (const { code: [i, ...moreCode], figma: [j, ...moreFigma] } of pages.values()) {
    if (i === undefined || j === undefined || moreCode.length || moreFigma.length) continue;
    pairedWith.set(i, j);
    paired++;
  }
  return paired;
}

function erroredDetail(f: FigmaComponentInfo): string {
  return `errored in Figma (can't read its properties): ${f.error}`;
}

/**
 * The entry for the copies of a name nothing could tell apart. Said as before
 * pages told any apart when none were, and with the pages each side's copies
 * are on when Figma's are known, since a page is what would tell them apart.
 * `byId`: the Figma copies all carry the component's Storybook ID.
 * `pairedById`: how many other copies of the name their IDs paired.
 */
function ambiguousEntry(code: CodeComponent[], figma: FigmaComponentInfo[], byPage: number, name: string, byId = false, pairedById = 0): ComponentDiffEntry {
  const shared = byId
    ? `${figma.length} Figma components carry the Storybook ID ${code[0].id}`
    : code.length > 1
      ? `${code.length} components share this name in code, and ${figma.length > 1 ? `${figma.length} in Figma` : "Figma has one"}`
      : figma.length > 1
        ? `${figma.length} Figma components share this name, and code has one`
        // One of each is left only beside copies pages paired, and on pages
        // that don't pair them.
        : "one copy in code and one in Figma are on different pages";
  const none = code.length + figma.length > 2 ? "none" : "neither";
  const besides = [
    ...(byPage ? [`${byPage} paired by page`] : []),
    ...(pairedById ? [`${pairedById} paired by Storybook ID`] : []),
  ];
  const details = [besides.length
    ? `${shared}, besides ${besides.join(" and ")}; ${none} of these was compared`
    : `${shared}; none was compared`];
  if (figma.some((f) => f.page != null)) {
    const pages = (list: (string | undefined)[]) => [...new Set(list.map((p) => p ?? "an unknown page"))].join(", ");
    details.push(`in code for ${pages(code.map(pushPage))}; in Figma on ${pages(figma.map((f) => f.page))}`);
  }
  return { name, status: "ambiguous", details };
}

/** What differs between a code component's variant properties and its Figma set's. */
function compareVariants(code: FigmaComponentDefinition, figma: FigmaComponentInfo): string[] {
  const details: string[] = [];
  const codePropMap = new Map(code.variantProperties.map((p) => [p.name.toLowerCase(), p]));
  const figmaPropMap = new Map(figma.variantProperties.map((p) => [p.name.toLowerCase(), p]));

  // Props in code but not in Figma
  for (const [pName, codeProp] of codePropMap) {
    if (!figmaPropMap.has(pName)) {
      details.push(`prop "${codeProp.name}" missing from Figma`);
    }
  }

  // Props in Figma but not in code
  for (const [pName, figmaProp] of figmaPropMap) {
    if (!codePropMap.has(pName)) {
      details.push(`prop "${figmaProp.name}" in Figma but not in code`);
    }
  }

  // Value mismatches for shared props
  for (const [pName, codeProp] of codePropMap) {
    const figmaProp = figmaPropMap.get(pName);
    if (!figmaProp) continue;

    const codeVals = new Set(codeProp.values.map((v) => v.toLowerCase()));
    const figmaVals = new Set(figmaProp.values.map((v) => v.toLowerCase()));

    const missingFromFigma = codeProp.values.filter((v) => !figmaVals.has(v.toLowerCase()));
    const extraInFigma = figmaProp.values.filter((v) => !codeVals.has(v.toLowerCase()));

    if (missingFromFigma.length) {
      details.push(`${codeProp.name}: values [${missingFromFigma.join(", ")}] missing from Figma`);
    }
    if (extraInFigma.length) {
      details.push(`${codeProp.name}: values [${extraInFigma.join(", ")}] in Figma but not in code`);
    }
  }
  return details;
}

// --- Summary ---

export function computeDiffSummary(tokens: TokenDiffEntry[], components: ComponentDiffEntry[]): DiffSummary {
  return {
    tokensMatched: tokens.filter((t) => t.status === "match").length,
    tokensMismatched: tokens.filter((t) => t.status === "value_mismatch").length,
    tokensMissingFromFigma: tokens.filter((t) => t.status === "missing_from_figma").length,
    tokensMissingFromCode: tokens.filter((t) => t.status === "missing_from_code").length,
    componentsMatched: components.filter((c) => c.status === "match").length,
    componentsMismatched: components.filter((c) => c.status === "variant_mismatch").length,
    componentsCodeOnly: components.filter((c) => c.status === "code_only").length,
    componentsFigmaOnly: components.filter((c) => c.status === "figma_only").length,
    componentsAmbiguous: components.filter((c) => c.status === "ambiguous").length,
    componentsErrored: components.filter((c) => c.status === "errored").length,
  };
}

export function hasDifferences(summary: DiffSummary): boolean {
  return (
    summary.tokensMismatched > 0 ||
    summary.tokensMissingFromFigma > 0 ||
    summary.tokensMissingFromCode > 0 ||
    summary.componentsMismatched > 0 ||
    summary.componentsCodeOnly > 0 ||
    summary.componentsFigmaOnly > 0 ||
    // A component that could not be compared is not a component that matched.
    summary.componentsAmbiguous > 0 ||
    summary.componentsErrored > 0
  );
}
