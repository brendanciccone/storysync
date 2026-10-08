// Diff engine — compares code-extracted tokens and component mappings against Figma state.

import type { TokenCollection, TokenCategory } from "./tokens.js";
import { tokenColorToHex } from "./tokens.js";
import type { FigmaComponentDefinition } from "./mapper.js";
import type { FigmaVariable, FigmaComponentInfo } from "./figma.js";
import { componentNames, selectComponents, titleLeaf } from "./storybook.js";
import type { ComponentEntry } from "./storybook.js";
import { colorToHex } from "./color.js";

// --- Token diff ---

export interface TokenDiffEntry {
  category: string;
  name: string;
  codeValue: string | null;
  figmaValue: string | null;
  status: "match" | "value_mismatch" | "missing_from_figma" | "missing_from_code";
}

// --- Component diff ---

export interface ComponentDiffEntry {
  /**
   * The component's set name, or, where another component shares it, its
   * Storybook title or its Figma page and set name: `ui/base/Button`.
   */
  name: string;
  status: "match" | "variant_mismatch" | "code_only" | "figma_only" | "ambiguous";
  details: string[];
  /** The Storybook ID of the code component, when there is one and diff knows it. */
  id?: string;
  /** The Figma page of the component set, when there is one. */
  page?: string;
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
  /** Code components sharing a bare name, so only one could be compared. */
  componentsAmbiguous: number;
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

// Colours are compared as sRGB hex, converted from any form a browser or a
// token source writes, oklch() and the rest of CSS Color 4 included. The
// converter lives in color.ts, shared with snap; it is re-exported here, where
// it has always been imported from.
export { colorToHex };

// Convert numeric values (rem/px/unitless) to a comparable canonical form.
// Returns the value as a string of pixels (e.g. "16") for numeric values, or the original normalized string otherwise.
export function numericToPx(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/;$/, "").replace(/^['"]|['"]$/g, "");

  const rem = s.match(/^(-?[\d.]+)rem$/);
  if (rem) return stripTrailingZero(parseFloat(rem[1]) * 16);

  const px = s.match(/^(-?[\d.]+)px$/);
  if (px) return stripTrailingZero(parseFloat(px[1]));

  const unitless = s.match(/^-?[\d.]+$/);
  if (unitless) return stripTrailingZero(parseFloat(s));

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

export function diffTokens(codeTokens: TokenCollection[], figmaVars: FigmaVariable[]): TokenDiffEntry[] {
  const entries: TokenDiffEntry[] = [];

  // Build code map: "category/tokenName" → value
  const codeMap = new Map<string, { value: string; category: string }>();
  for (const coll of codeTokens) {
    for (const token of coll.tokens) {
      codeMap.set(`${coll.category}/${token.name}`, { value: token.value, category: coll.category });
    }
  }

  // Build Figma map: "category/variableName" → value
  const figmaMap = new Map<string, { value: string; collection: string; resolvedType: string }>();
  for (const fv of figmaVars) {
    const category = figmaCollectionToCategory(fv.collection);
    figmaMap.set(`${category}/${fv.name}`, { value: fv.value, collection: fv.collection, resolvedType: fv.resolvedType });
  }

  // Code tokens vs Figma
  for (const [key, code] of codeMap) {
    const figma = figmaMap.get(key);
    const slash = key.indexOf("/");
    const category = key.slice(0, slash);
    const name = key.slice(slash + 1);

    if (!figma) {
      entries.push({ category, name, codeValue: code.value, figmaValue: null, status: "missing_from_figma" });
    } else {
      const codeNorm = normalizeForCompare(category, code.value);
      const figmaNorm = normalizeForCompare(category, figma.value);
      entries.push({
        category,
        name,
        codeValue: code.value,
        figmaValue: figma.value,
        status: codeNorm === figmaNorm ? "match" : "value_mismatch",
      });
    }
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

/** The names a Figma set goes by in `--components`: its name, and its page and name, `ui/base/Button`. */
function figmaNames(component: FigmaComponentInfo): string[] {
  return component.page ? [component.name, `${component.page}/${component.name}`] : [component.name];
}

/**
 * The Figma sets of a set name a code component may be compared with: those
 * on its own page, if any is there, or else any of them. With the set name,
 * its display name, for a file pushed before sets were named by title.
 */
function figmaCandidates(component: { name: string; title?: string; category?: string }, figmaComponents: FigmaComponentInfo[]): FigmaComponentInfo[] {
  const named = (name: string) => figmaComponents.filter((f) => f.name.toLowerCase() === name.toLowerCase());
  let candidates = named(pushSetName(component));
  if (!candidates.length) candidates = named(component.name);
  const page = pageKey(pushPage(component));
  const onPage = candidates.filter((f) => f.page != null && pageKey(f.page) === page);
  return onPage.length ? onPage : candidates;
}

/**
 * Narrows both sides of a component diff to the names given with `--components`.
 *
 * Storybook components are selected exactly as snap and map select them. A
 * name found only in Figma is not a typo, though: it asks whether that
 * component exists in code yet, and the answer is a `figma_only` entry, which
 * fails `--strict`. So only a name neither side has is an error.
 *
 * Figma is narrowed to the same components: the sets named as given, and the
 * sets each selected component would be compared with, by its set name and on
 * its page, so `ui-base-button` brings `ui/base`'s Button and not `ui/radix`'s.
 * Left whole, every Figma component outside the selection would be reported
 * as missing from code when it was only left out of the diff.
 */
export function selectDiffComponents(
  entries: ComponentEntry[],
  figmaComponents: FigmaComponentInfo[],
  names: readonly string[] | undefined,
): { entries: ComponentEntry[]; figmaComponents: FigmaComponentInfo[] } {
  const selected = selectComponents(entries, names, figmaComponents.flatMap(figmaNames));
  const wanted = componentNames(names);
  if (!wanted.length) return { entries, figmaComponents };
  const keep = new Set([
    ...narrowFigmaComponents(figmaComponents, wanted),
    ...selected.flatMap((entry) => figmaCandidates(entry, figmaComponents)),
  ]);
  return { entries: selected, figmaComponents: figmaComponents.filter((c) => keep.has(c)) };
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
 * Compares code's components with Figma's component sets, pairing each code
 * component with the set the push would have made for it.
 *
 * A code component's set is named by its title's last segment (pushSetName),
 * or, where Figma has no set of that name, by its display name, as a push
 * before titles named them. A name one code component and one set have is a
 * pair, whatever page the set is on.
 *
 * Two distinct components can share a name. `Forms/Button` and `Nav/Button`
 * are ordinary in a real design system, and a library with Base UI and Radix
 * copies shares every name. Paired on the name alone, one would be dropped
 * before any comparison and `diff --strict` would report "no differences" for
 * a library it never fully read; reported as ambiguous, all of them were, and
 * on such a library nothing was ever compared. The push puts each category on
 * a page of its own, so a shared name is told apart by page: a code component
 * and a set of its name on the page the push gives it, each the only one of
 * the name on that page on its side, are a pair. Of the copies left, one code
 * component and one set are a pair too, as a name only they had would be; code
 * components alone are not in Figma, and sets alone not in code. Anything else
 * left is a name nothing can tell apart: reported as ambiguous, and nothing
 * else, since comparing any of those copies would vouch for a pairing nothing
 * chose.
 *
 * `unmapped` are the components code has but could not map. They are paired
 * like the rest, but report nothing, and neither does a set paired with one:
 * never compared, it is not "not in code".
 */
export function diffComponents(
  codeComponents: CodeComponent[],
  figmaComponents: FigmaComponentInfo[],
  unmapped: { name: string; title?: string; category?: string; id?: string }[] = [],
): ComponentDiffEntry[] {
  const code: (CodeComponent & { unmapped?: true })[] = [
    ...codeComponents,
    ...unmapped.map((c) => ({ ...c, variantProperties: [], variantCombinations: [], wasCapped: false, unmapped: true as const })),
  ];
  const figmaNamed = new Set(figmaComponents.map((f) => f.name.toLowerCase()));
  const setName = code.map((c) => {
    const name = pushSetName(c);
    return figmaNamed.has(name.toLowerCase()) || !figmaNamed.has(c.name.toLowerCase()) ? name : c.name;
  });

  const groups = new Map<string, { code: number[]; figma: number[] }>();
  const group = (key: string) => groups.get(key) ?? groups.set(key, { code: [], figma: [] }).get(key)!;
  code.forEach((_, i) => group(setName[i].toLowerCase()).code.push(i));
  figmaComponents.forEach((f, j) => group(f.name.toLowerCase()).figma.push(j));

  const pairedWith = new Map<number, number>();
  const codeOnly = new Set<number>();
  const figmaOnly = new Set<number>();
  const shared = new Set<string>();
  const entries: ComponentDiffEntry[] = [];

  for (const [key, { code: codeCopies, figma: figmaCopies }] of groups) {
    let codeLeft = codeCopies;
    let figmaLeft = figmaCopies;
    let byPage = 0;
    if (codeCopies.length > 1 || figmaCopies.length > 1) {
      shared.add(key);
      const pages = new Map<string, { code: number[]; figma: number[] }>();
      const page = (name: string) => pages.get(pageKey(name)) ?? pages.set(pageKey(name), { code: [], figma: [] }).get(pageKey(name))!;
      for (const i of codeCopies) page(pushPage(code[i])).code.push(i);
      for (const j of figmaCopies) {
        const name = figmaComponents[j].page;
        if (name != null) page(name).figma.push(j);
      }
      for (const { code: [i, ...moreCode], figma: [j, ...moreFigma] } of pages.values()) {
        if (i === undefined || j === undefined || moreCode.length || moreFigma.length) continue;
        pairedWith.set(i, j);
        byPage++;
      }
      const paired = new Set(pairedWith.values());
      codeLeft = codeCopies.filter((i) => !pairedWith.has(i));
      figmaLeft = figmaCopies.filter((j) => !paired.has(j));
    }

    if (codeLeft.length === 1 && figmaLeft.length === 1) pairedWith.set(codeLeft[0], figmaLeft[0]);
    else if (!figmaLeft.length) codeLeft.forEach((i) => codeOnly.add(i));
    else if (!codeLeft.length) figmaLeft.forEach((j) => figmaOnly.add(j));
    else entries.push(ambiguousEntry(codeLeft.map((i) => code[i]), figmaLeft.map((j) => figmaComponents[j]), byPage, setName[codeLeft[0]]));
  }

  // A shared name is said with what tells its copies apart.
  const codeLabel = (i: number) => {
    const c = code[i];
    return shared.has(setName[i].toLowerCase()) ? c.title ?? c.id ?? `${pushPage(c)}/${setName[i]}` : setName[i];
  };
  const figmaLabel = (f: FigmaComponentInfo) =>
    shared.has(f.name.toLowerCase()) && f.page != null ? `${f.page}/${f.name}` : f.name;
  const where = (c: CodeComponent, f?: FigmaComponentInfo) => ({
    ...(c.id != null ? { id: c.id } : {}),
    ...(f?.page != null ? { page: f.page } : {}),
  });

  code.forEach((c, i) => {
    if (c.unmapped) return;
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
    const details = compareVariants(c, figmaComponents[j]);
    entries.push({ name: codeLabel(i), status: details.length ? "variant_mismatch" : "match", details, ...where(c, figmaComponents[j]) });
  });

  // Figma components not in code
  figmaComponents.forEach((f, j) => {
    if (!figmaOnly.has(j)) return;
    const propCount = f.variantProperties.length;
    const detail = propCount === 0
      ? "no variants in Figma"
      : `${propCount} variant prop${propCount === 1 ? "" : "s"} in Figma`;
    entries.push({ name: figmaLabel(f), status: "figma_only", details: [detail], ...(f.page != null ? { page: f.page } : {}) });
  });

  return entries;
}

/**
 * The entry for the copies of a name nothing could tell apart. Said as before
 * pages told any apart when none were, and with the pages each side's copies
 * are on when Figma's are known, since a page is what would tell them apart.
 */
function ambiguousEntry(code: CodeComponent[], figma: FigmaComponentInfo[], byPage: number, name: string): ComponentDiffEntry {
  const shared = code.length > 1
    ? `${code.length} components share this name in code, and ${figma.length > 1 ? `${figma.length} in Figma` : "Figma has one"}`
    : `${figma.length} Figma components share this name, and code has one`;
  const details = [byPage
    ? `${shared}, besides ${byPage} paired by page; none of these was compared`
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
    summary.componentsAmbiguous > 0
  );
}
