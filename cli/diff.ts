// Diff engine — compares code-extracted tokens and component mappings against Figma state.

import type { TokenCollection, TokenCategory } from "./tokens.js";
import { tokenColorToHex } from "./tokens.js";
import type { FigmaComponentDefinition } from "./mapper.js";
import type { FigmaVariable, FigmaComponentInfo } from "./figma.js";
import { componentNames, selectComponents } from "./storybook.js";
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
  name: string;
  status: "match" | "variant_mismatch" | "code_only" | "figma_only" | "ambiguous";
  details: string[];
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

/**
 * Narrows both sides of a component diff to the names given with `--components`.
 *
 * Storybook components are selected exactly as snap and map select them. A
 * name found only in Figma is not a typo, though: it asks whether that
 * component exists in code yet, and the answer is a `figma_only` entry, which
 * fails `--strict`. So only a name neither side has is an error.
 *
 * Figma is narrowed to the same components, by name — including those picked
 * by Storybook ID. Left whole, every Figma component outside the selection
 * would be reported as missing from code when it was only left out of the diff.
 */
export function selectDiffComponents(
  entries: ComponentEntry[],
  figmaComponents: FigmaComponentInfo[],
  names: readonly string[] | undefined,
): { entries: ComponentEntry[]; figmaComponents: FigmaComponentInfo[] } {
  const selected = selectComponents(entries, names, figmaComponents.map((c) => c.name));
  const wanted = componentNames(names);
  if (!wanted.length) return { entries, figmaComponents };
  return { entries: selected, figmaComponents: narrowFigmaComponents(figmaComponents, [...wanted, ...selected.map((e) => e.name)]) };
}

/**
 * Narrows Figma's components to the names given with `--components`, by name,
 * ignoring case, and without checking any name for a typo. On its own, it is
 * for a diff whose Storybook listing failed: with the code side unknown, a
 * name can't be told from a typo, but the components left out must still not
 * all be reported as missing from code.
 */
export function narrowFigmaComponents(
  figmaComponents: FigmaComponentInfo[],
  names: readonly string[] | undefined,
): FigmaComponentInfo[] {
  const wanted = componentNames(names);
  if (!wanted.length) return figmaComponents;
  const keep = new Set(wanted.map((n) => n.toLowerCase()));
  return figmaComponents.filter((c) => keep.has(c.name.toLowerCase()));
}

export function diffComponents(
  codeComponents: FigmaComponentDefinition[],
  figmaComponents: FigmaComponentInfo[],
): ComponentDiffEntry[] {
  const entries: ComponentDiffEntry[] = [];

  // Components are paired on their bare name, which two distinct components can
  // share — `Forms/Button` and `Nav/Button` are ordinary in a real design
  // system. Building the map alone would let the second silently overwrite the
  // first, so one component would be dropped before any comparison and `diff
  // --strict` would report "no differences" for a library it never fully read.
  const codeMap = new Map<string, FigmaComponentDefinition>();
  const ambiguous = new Map<string, string[]>();
  for (const component of codeComponents) {
    const key = component.name.toLowerCase();
    const existing = codeMap.get(key);
    if (existing) {
      const seen = ambiguous.get(key) ?? [existing.name];
      seen.push(component.name);
      ambiguous.set(key, seen);
      continue;
    }
    codeMap.set(key, component);
  }
  // Figma can repeat a name too, now that every page is read: an archive page
  // keeping an old Button, or Forms/Button and Nav/Button pushed to their
  // categories' pages. Keyed on the name alone, the last page read would
  // silently be the one compared.
  const figmaMap = new Map<string, FigmaComponentInfo>();
  const figmaRepeats = new Map<string, number>();
  for (const component of figmaComponents) {
    const key = component.name.toLowerCase();
    if (figmaMap.has(key)) {
      figmaRepeats.set(key, (figmaRepeats.get(key) ?? 1) + 1);
      continue;
    }
    figmaMap.set(key, component);
  }

  // A repeated name is reported as ambiguous and nothing else. Comparing its
  // first copies too would count the one name twice, as ambiguous and as
  // matched, say, and the match would vouch for a pairing nothing chose.
  for (const [key, names] of ambiguous) {
    const repeats = figmaRepeats.get(key);
    entries.push({
      name: names[0],
      status: "ambiguous",
      details: [repeats
        ? `${names.length} components share this name in code, and ${repeats} in Figma; none was compared`
        : `${names.length} components share this name in code, and Figma has ${figmaMap.has(key) ? "one" : "none"}; none was compared`],
    });
  }
  for (const [key, repeats] of figmaRepeats) {
    if (ambiguous.has(key)) continue;
    entries.push({
      name: figmaMap.get(key)!.name,
      status: "ambiguous",
      details: [`${repeats} Figma components share this name, and code has ${codeMap.has(key) ? "one" : "none"}; none was compared`],
    });
  }
  const isAmbiguous = (key: string) => ambiguous.has(key) || figmaRepeats.has(key);

  for (const [key, code] of codeMap) {
    if (isAmbiguous(key)) continue;
    const figma = figmaMap.get(key);
    if (!figma) {
      const propCount = code.variantProperties.length;
      const detail = propCount === 0
        ? "no variants in code"
        : `${propCount} variant prop${propCount === 1 ? "" : "s"} in code`;
      entries.push({ name: code.name, status: "code_only", details: [detail] });
      continue;
    }

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

    entries.push({ name: code.name, status: details.length ? "variant_mismatch" : "match", details });
  }

  // Figma components not in code
  for (const [key, figma] of figmaMap) {
    if (!codeMap.has(key) && !isAmbiguous(key)) {
      const propCount = figma.variantProperties.length;
      const detail = propCount === 0
        ? "no variants in Figma"
        : `${propCount} variant prop${propCount === 1 ? "" : "s"} in Figma`;
      entries.push({ name: figma.name, status: "figma_only", details: [detail] });
    }
  }

  return entries;
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
