// Diff engine — compares code-extracted tokens and component mappings against Figma state.

import type { TokenCollection, TokenCategory } from "./tokens.js";
import type { FigmaComponentDefinition } from "./mapper.js";
import type { FigmaVariable, FigmaComponentInfo } from "./figma.js";

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
  status: "match" | "variant_mismatch" | "code_only" | "figma_only";
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

function figmaCollectionToCategory(collectionName: string): string {
  return COLLECTION_CATEGORY_MAP[collectionName.toLowerCase().trim()] ?? collectionName.toLowerCase().trim();
}

// --- Value normalization ---

function normalizeColorValue(v: string): string {
  let s = v.trim().toLowerCase();
  s = s.replace(/;$/, "").replace(/^['"]|['"]$/g, "");
  // Expand 3-char hex to 6-char
  const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex3) {
    s = `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`;
  }
  return s;
}

function normalizeNumericValue(v: string): string {
  let s = v.trim().toLowerCase();
  s = s.replace(/;$/, "").replace(/^['"]|['"]$/g, "");
  // Convert rem to px (1rem = 16px)
  const remMatch = s.match(/^([\d.]+)rem$/);
  if (remMatch) {
    s = String(parseFloat(remMatch[1]) * 16);
  }
  // Strip px suffix
  const pxMatch = s.match(/^([\d.]+)px$/);
  if (pxMatch) {
    s = pxMatch[1];
  }
  return s;
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
    const [category, ...nameParts] = key.split("/");
    const name = nameParts.join("/");

    if (!figma) {
      entries.push({ category, name, codeValue: code.value, figmaValue: null, status: "missing_from_figma" });
    } else {
      const isColor = category === "colors";
      const codeNorm = isColor ? normalizeColorValue(code.value) : normalizeNumericValue(code.value);
      const figmaNorm = isColor ? normalizeColorValue(figma.value) : normalizeNumericValue(figma.value);

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
      const [category, ...nameParts] = key.split("/");
      entries.push({ category, name: nameParts.join("/"), codeValue: null, figmaValue: figma.value, status: "missing_from_code" });
    }
  }

  return entries;
}

// --- Component diffing ---

export function diffComponents(
  codeComponents: FigmaComponentDefinition[],
  figmaComponents: FigmaComponentInfo[],
): ComponentDiffEntry[] {
  const entries: ComponentDiffEntry[] = [];

  const codeMap = new Map(codeComponents.map((c) => [c.name.toLowerCase(), c]));
  const figmaMap = new Map(figmaComponents.map((c) => [c.name.toLowerCase(), c]));

  for (const [key, code] of codeMap) {
    const figma = figmaMap.get(key);
    if (!figma) {
      entries.push({ name: code.name, status: "code_only", details: [`${code.variantProperties.length} variant props in code`] });
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
    if (!codeMap.has(key)) {
      entries.push({ name: figma.name, status: "figma_only", details: [`${figma.variantProperties.length} variant props in Figma`] });
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
  };
}

export function hasDifferences(summary: DiffSummary): boolean {
  return (
    summary.tokensMismatched > 0 ||
    summary.tokensMissingFromFigma > 0 ||
    summary.tokensMissingFromCode > 0 ||
    summary.componentsMismatched > 0 ||
    summary.componentsCodeOnly > 0 ||
    summary.componentsFigmaOnly > 0
  );
}
