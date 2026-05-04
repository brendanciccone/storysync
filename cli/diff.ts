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

export function figmaCollectionToCategory(collectionName: string): string {
  return COLLECTION_CATEGORY_MAP[collectionName.toLowerCase().trim()] ?? collectionName.toLowerCase().trim();
}

// --- Value normalization ---

// Convert any supported color expression to lowercase 6- or 8-char hex (#rrggbb / #rrggbbaa).
// Returns null if the value isn't recognizable as a color.
export function colorToHex(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/;$/, "").replace(/^['"]|['"]$/g, "");

  // 8-digit hex (#rrggbbaa)
  const hex8 = s.match(/^#([0-9a-f]{8})$/);
  if (hex8) return `#${hex8[1]}`;

  // 6-digit hex
  const hex6 = s.match(/^#([0-9a-f]{6})$/);
  if (hex6) return `#${hex6[1]}`;

  // 3-digit hex
  const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex3) return `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`;

  // 4-digit hex (rgba shorthand)
  const hex4 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex4) {
    const [, r, g, b, a] = hex4;
    return `#${r}${r}${g}${g}${b}${b}${a}${a}`;
  }

  // rgb()/rgba() — accepts integers 0-255 or percentages
  const rgb = s.match(/^rgba?\s*\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const [, r, g, b, a] = rgb;
    const rh = channelToHex(r);
    const gh = channelToHex(g);
    const bh = channelToHex(b);
    if (rh == null || gh == null || bh == null) return null;
    if (a != null) {
      const ah = alphaToHex(a);
      if (ah == null) return null;
      return ah === "ff" ? `#${rh}${gh}${bh}` : `#${rh}${gh}${bh}${ah}`;
    }
    return `#${rh}${gh}${bh}`;
  }

  // hsl()/hsla() — convert via standard formula
  const hsl = s.match(/^hsla?\s*\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (hsl) {
    const [, h, sPct, l, a] = hsl;
    const [r, g, b] = hslToRgb(parseFloat(h), parseFloat(sPct) / 100, parseFloat(l) / 100);
    const rh = r.toString(16).padStart(2, "0");
    const gh = g.toString(16).padStart(2, "0");
    const bh = b.toString(16).padStart(2, "0");
    if (a != null) {
      const ah = alphaToHex(a);
      if (ah == null) return null;
      return ah === "ff" ? `#${rh}${gh}${bh}` : `#${rh}${gh}${bh}${ah}`;
    }
    return `#${rh}${gh}${bh}`;
  }

  // Named CSS colors — small subset that designers commonly use
  const named: Record<string, string> = {
    white: "#ffffff",
    black: "#000000",
    transparent: "#00000000",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
  };
  if (s in named) return named[s];

  return null;
}

function channelToHex(s: string): string | null {
  const isPercent = s.endsWith("%");
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  const v = isPercent ? Math.round((n / 100) * 255) : Math.round(n);
  if (v < 0 || v > 255) return null;
  return v.toString(16).padStart(2, "0");
}

function alphaToHex(s: string): string | null {
  const isPercent = s.endsWith("%");
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  const v = isPercent ? Math.round((n / 100) * 255) : Math.round(n * 255);
  if (v < 0 || v > 255) return null;
  return v.toString(16).padStart(2, "0");
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Convert numeric values (rem/px/unitless) to a comparable canonical form.
// Returns the value as a string of pixels (e.g. "16") for numeric values, or the original normalized string otherwise.
export function numericToPx(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/;$/, "").replace(/^['"]|['"]$/g, "");

  const rem = s.match(/^([\d.]+)rem$/);
  if (rem) return stripTrailingZero(parseFloat(rem[1]) * 16);

  const px = s.match(/^([\d.]+)px$/);
  if (px) return stripTrailingZero(parseFloat(px[1]));

  const unitless = s.match(/^[\d.]+$/);
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
    return colorToHex(value) ?? value.trim().toLowerCase();
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
    if (!codeMap.has(key)) {
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
