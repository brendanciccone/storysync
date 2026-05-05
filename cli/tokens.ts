// Design token extraction from project source files.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type TokenSourceType = "tailwind" | "css" | "theme";

export type TokenCategory = "colors" | "spacing" | "typography" | "radius" | "shadows";

export interface TokenValue {
  name: string;
  value: string;
  group?: string;
}

export interface TokenCollection {
  category: TokenCategory;
  tokens: TokenValue[];
}

export interface TokenExtractionResult {
  source: TokenSourceType;
  sourcePath: string;
  collections: TokenCollection[];
  warnings: string[];
}

// --- Detection ---

interface DetectedSource {
  type: TokenSourceType;
  path: string;
}

export function detectTokenSource(projectPath: string): DetectedSource | null {
  for (const name of ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"]) {
    const p = join(projectPath, name);
    if (existsSync(p)) return { type: "tailwind", path: p };
  }

  const cssFiles = findCSSWithCustomProperties(projectPath);
  if (cssFiles.length) return { type: "css", path: cssFiles[0] };

  const themeFile = findThemeFile(projectPath);
  if (themeFile) return { type: "theme", path: themeFile };

  return null;
}

function findCSSWithCustomProperties(projectPath: string): string[] {
  const results: string[] = [];
  const srcDir = join(projectPath, "src");
  const appDir = join(projectPath, "app");
  const stylesDir = join(projectPath, "styles");

  for (const dir of [srcDir, appDir, stylesDir, projectPath]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    walkCSS(dir, results, projectPath, 0);
  }
  return results;
}

function walkCSS(dir: string, results: string[], root: string, depth: number): void {
  if (depth > 5) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "build") continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walkCSS(full, results, root, depth + 1);
    } else if (entry.endsWith(".css") && !entry.endsWith(".module.css")) {
      try {
        const content = readFileSync(full, "utf8");
        if (/:root\s*\{/.test(content) && /--[\w-]+\s*:/.test(content)) {
          results.push(full);
        }
      } catch { /* skip unreadable */ }
    }
  }
}

const THEME_FILE_NAMES = [
  "tokens.ts", "tokens.js", "theme.ts", "theme.js",
  "design-tokens.ts", "design-tokens.js",
  "tokens/index.ts", "tokens/index.js",
  "theme/index.ts", "theme/index.js",
];

function findThemeFile(projectPath: string): string | null {
  for (const dir of ["src", "lib", "."]) {
    for (const name of THEME_FILE_NAMES) {
      const p = join(projectPath, dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

// --- Main extraction ---

export function extractTokens(projectPath: string, sourceType?: TokenSourceType): TokenExtractionResult {
  if (sourceType) {
    switch (sourceType) {
      case "tailwind": {
        for (const name of ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"]) {
          const p = join(projectPath, name);
          if (existsSync(p)) return extractFromTailwind(p);
        }
        return { source: "tailwind", sourcePath: "", collections: [], warnings: ["No tailwind.config found"] };
      }
      case "css": {
        const files = findCSSWithCustomProperties(projectPath);
        if (files.length) return extractFromCSS(files);
        return { source: "css", sourcePath: "", collections: [], warnings: ["No CSS files with custom properties found"] };
      }
      case "theme": {
        const f = findThemeFile(projectPath);
        if (f) return extractFromTheme(f);
        return { source: "theme", sourcePath: "", collections: [], warnings: ["No theme file found"] };
      }
    }
  }

  const detected = detectTokenSource(projectPath);
  if (!detected) {
    return { source: "tailwind", sourcePath: "", collections: [], warnings: ["No token source detected"] };
  }

  switch (detected.type) {
    case "tailwind": return extractFromTailwind(detected.path);
    case "css": return extractFromCSS(findCSSWithCustomProperties(projectPath));
    case "theme": return extractFromTheme(detected.path);
  }
}

// --- Tailwind extraction ---

function extractFromTailwind(configPath: string): TokenExtractionResult {
  const content = readFileSync(configPath, "utf8");
  const warnings: string[] = [];
  const collections: TokenCollection[] = [];

  if (/require\s*\(/.test(content)) {
    warnings.push("Config uses require() - some values may not be extracted");
  }
  if (/\.\.\./.test(content)) {
    warnings.push("Config uses spread syntax - some values may not be extracted");
  }

  // Extract theme.extend and theme objects
  const themeBlocks = extractThemeBlocks(content);

  const colorTokens = extractTailwindColors(themeBlocks, warnings);
  if (colorTokens.length) collections.push({ category: "colors", tokens: colorTokens });

  const spacingTokens = extractTailwindFlat(themeBlocks, "spacing");
  if (spacingTokens.length) collections.push({ category: "spacing", tokens: spacingTokens });

  const radiusTokens = extractTailwindFlat(themeBlocks, "borderRadius");
  if (radiusTokens.length) collections.push({ category: "radius", tokens: radiusTokens });

  const fontTokens = extractTailwindTypography(themeBlocks);
  if (fontTokens.length) collections.push({ category: "typography", tokens: fontTokens });

  const shadowTokens = extractTailwindFlat(themeBlocks, "boxShadow");
  if (shadowTokens.length) collections.push({ category: "shadows", tokens: shadowTokens });

  return { source: "tailwind", sourcePath: configPath, collections, warnings };
}

interface ThemeBlocks {
  extend: string;
  root: string;
}

function extractThemeBlocks(content: string): ThemeBlocks {
  const rootMatch = findBalancedBlock(content, /theme\s*:\s*\{/);
  const extendBlock = rootMatch ? findPropertyBlock(rootMatch, "extend") : null;
  return {
    extend: extendBlock ? `{${extendBlock}}` : "",
    root: rootMatch ?? "",
  };
}

function findBalancedBlock(content: string, startPattern: RegExp): string | null {
  const match = startPattern.exec(content);
  if (!match) return null;

  // Find the opening brace position at the end of the match
  let braceStart = match.index + match[0].length - 1;
  let depth = 1;
  let i = braceStart + 1;

  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
    i++;
  }

  return content.slice(braceStart, i);
}

function extractTailwindColors(blocks: ThemeBlocks, warnings: string[]): TokenValue[] {
  const tokens: TokenValue[] = [];
  // Try extend first, then root
  for (const block of [blocks.extend, blocks.root]) {
    if (!block) continue;
    const colorsBlock = findPropertyBlock(block, "colors");
    if (!colorsBlock) continue;
    flattenObject(colorsBlock, "", tokens, "colors", warnings);
    if (tokens.length) break;
  }
  return tokens;
}

function extractTailwindFlat(blocks: ThemeBlocks, key: string): TokenValue[] {
  const tokens: TokenValue[] = [];
  for (const block of [blocks.extend, blocks.root]) {
    if (!block) continue;
    const propBlock = findPropertyBlock(block, key);
    if (!propBlock) continue;
    flattenObject(propBlock, "", tokens, key, []);
    if (tokens.length) break;
  }
  return tokens;
}

function extractTailwindTypography(blocks: ThemeBlocks): TokenValue[] {
  const tokens: TokenValue[] = [];
  for (const block of [blocks.extend, blocks.root]) {
    if (!block) continue;
    const propBlock = findPropertyBlock(block, "fontSize");
    if (!propBlock) continue;

    // fontSize can be { sm: '0.875rem' } or { sm: ['0.875rem', { lineHeight: '1.25rem' }] }
    const pairs = extractKeyValuePairs(propBlock);
    for (const [name, value] of pairs) {
      // Handle array values - take just the size
      const sizeMatch = value.match(/^\[?\s*['"]?([^'"[\],]+)/);
      const resolved = sizeMatch ? sizeMatch[1].trim() : value;
      tokens.push({ name, value: resolved });
    }
    if (tokens.length) break;
  }
  return tokens;
}

function findPropertyBlock(block: string, key: string): string | null {
  const pattern = new RegExp(`(?:^|[\\s,])${key}\\s*:\\s*\\{`);
  const match = pattern.exec(block);
  if (!match) return null;

  const braceStart = block.indexOf("{", match.index + match[0].indexOf(key));
  if (braceStart === -1) return null;

  let depth = 1;
  let i = braceStart + 1;
  while (i < block.length && depth > 0) {
    if (block[i] === "{") depth++;
    else if (block[i] === "}") depth--;
    i++;
  }
  return block.slice(braceStart + 1, i - 1);
}

function flattenObject(block: string, prefix: string, tokens: TokenValue[], _context: string, warnings: string[]): void {
  const pairs = extractKeyValuePairs(block);

  for (const [key, value] of pairs) {
    const name = prefix ? `${prefix}/${key}` : key;

    if (value.trim().startsWith("{")) {
      // Nested object - recurse
      flattenObject(value.slice(1, -1), name, tokens, _context, warnings);
    } else {
      const cleaned = value.replace(/^['"]|['"]$/g, "").trim();
      if (cleaned && cleaned !== "...") {
        // Skip dynamic calls like theme() or require(), but allow CSS values that contain parentheses like rgb()
        const isDynamicCall = /(?:theme|require|resolve|fn)\s*\(/.test(cleaned);
        if (isDynamicCall) {
          warnings.push(`Skipped dynamic value: ${name} = ${cleaned}`);
        } else {
          tokens.push({ name, value: cleaned, group: prefix || undefined });
        }
      }
    }
  }
}

function extractKeyValuePairs(block: string): [string, string][] {
  const pairs: [string, string][] = [];
  // Match key: value or 'key': value or "key": value (keys can contain dots like '0.5')
  const regex = /(?:^|[\s,])['"]?([\w.-]+)['"]?\s*:\s*/g;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(block)) !== null) {
    const key = m[1];
    const valueStart = m.index + m[0].length;

    if (block[valueStart] === "{") {
      // Nested object
      let depth = 1;
      let i = valueStart + 1;
      while (i < block.length && depth > 0) {
        if (block[i] === "{") depth++;
        else if (block[i] === "}") depth--;
        i++;
      }
      pairs.push([key, block.slice(valueStart, i)]);
      regex.lastIndex = i;
    } else if (block[valueStart] === "[") {
      // Array value
      let depth = 1;
      let i = valueStart + 1;
      while (i < block.length && depth > 0) {
        if (block[i] === "[") depth++;
        else if (block[i] === "]") depth--;
        i++;
      }
      pairs.push([key, block.slice(valueStart, i)]);
      regex.lastIndex = i;
    } else {
      // Simple value - read until unbalanced comma, newline, or closing brace
      // Track paren depth so commas inside rgb(), rgba(), etc. are not treated as separators
      let i = valueStart;
      let parenDepth = 0;
      let inQuote: string | null = null;
      while (i < block.length) {
        const ch = block[i];
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
        } else if (ch === "'" || ch === '"' || ch === "`") {
          inQuote = ch;
        } else if (ch === "(") {
          parenDepth++;
        } else if (ch === ")") {
          parenDepth--;
        } else if (parenDepth === 0 && (ch === "," || ch === "}" || ch === "\n")) {
          break;
        }
        i++;
      }
      const raw = block.slice(valueStart, i).trim();
      if (raw) {
        pairs.push([key, raw]);
        regex.lastIndex = i;
      }
    }
  }
  return pairs;
}

// --- CSS custom properties extraction ---

function extractFromCSS(files: string[]): TokenExtractionResult {
  const warnings: string[] = [];
  const allVars = new Map<string, string>();

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf8");
      const rootBlocks = content.matchAll(/:root\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g);

      for (const block of rootBlocks) {
        const declarations = block[1].matchAll(/\s*(--[\w-]+)\s*:\s*([^;}]+);?/g);
        for (const decl of declarations) {
          allVars.set(decl[1].trim(), decl[2].trim());
        }
      }
    } catch {
      warnings.push(`Could not read ${file}`);
    }
  }

  if (!allVars.size) {
    return { source: "css", sourcePath: files[0] ?? "", collections: [], warnings: [...warnings, "No custom properties found"] };
  }

  // Resolve var() references
  for (const [name, value] of allVars) {
    const varRef = value.match(/var\(\s*(--[\w-]+)\s*\)/);
    if (varRef && allVars.has(varRef[1])) {
      allVars.set(name, allVars.get(varRef[1])!);
    }
  }

  // Categorize by prefix
  const categorized: Record<TokenCategory, TokenValue[]> = {
    colors: [], spacing: [], typography: [], radius: [], shadows: [],
  };

  const colorPrefixes = ["--color-", "--clr-", "--bg-", "--text-", "--border-color-"];
  const spacingPrefixes = ["--space-", "--spacing-", "--gap-", "--padding-", "--margin-"];
  const radiusPrefixes = ["--radius-", "--rounded-", "--border-radius-"];
  const fontPrefixes = ["--font-", "--text-size-", "--fs-", "--line-height-", "--lh-"];
  const shadowPrefixes = ["--shadow-", "--elevation-"];

  for (const [varName, value] of allVars) {
    const shortName = varName.replace(/^--/, "").replace(/-/g, "/");

    if (colorPrefixes.some((p) => varName.startsWith(p)) || isColorValue(value)) {
      categorized.colors.push({ name: shortName, value });
    } else if (spacingPrefixes.some((p) => varName.startsWith(p))) {
      categorized.spacing.push({ name: shortName, value });
    } else if (radiusPrefixes.some((p) => varName.startsWith(p))) {
      categorized.radius.push({ name: shortName, value });
    } else if (fontPrefixes.some((p) => varName.startsWith(p))) {
      categorized.typography.push({ name: shortName, value });
    } else if (shadowPrefixes.some((p) => varName.startsWith(p))) {
      categorized.shadows.push({ name: shortName, value });
    } else {
      // Fall back to value-based categorization
      if (isColorValue(value)) {
        categorized.colors.push({ name: shortName, value });
      } else {
        warnings.push(`Uncategorized: ${varName}: ${value}`);
      }
    }
  }

  const collections: TokenCollection[] = [];
  for (const [category, tokens] of Object.entries(categorized) as [TokenCategory, TokenValue[]][]) {
    if (tokens.length) collections.push({ category, tokens });
  }

  return { source: "css", sourcePath: files[0], collections, warnings };
}

function isColorValue(value: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ||
    /^rgba?\(/.test(value.trim()) ||
    /^hsla?\(/.test(value.trim()) ||
    /^oklch\(/.test(value.trim());
}

// --- Theme file extraction ---

function extractFromTheme(filePath: string): TokenExtractionResult {
  const content = readFileSync(filePath, "utf8");
  const warnings: string[] = [];
  const collections: TokenCollection[] = [];

  // Look for exported objects: export const colors = { ... }
  const exportPattern = /export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = exportPattern.exec(content)) !== null) {
    const name = m[1].toLowerCase();
    const braceStart = content.lastIndexOf("{", m.index + m[0].length);
    let depth = 1;
    let i = braceStart + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      i++;
    }
    const block = content.slice(braceStart + 1, i - 1);

    const category = mapNameToCategory(name);
    if (category) {
      const tokens: TokenValue[] = [];
      flattenObject(block, "", tokens, name, warnings);
      if (tokens.length) collections.push({ category, tokens });
    }
  }

  // Also try: export default { colors: { ... }, spacing: { ... } }
  if (!collections.length) {
    const defaultExport = content.match(/export\s+default\s+\{/);
    if (defaultExport) {
      const braceStart = content.indexOf("{", defaultExport.index);
      let depth = 1;
      let i = braceStart + 1;
      while (i < content.length && depth > 0) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") depth--;
        i++;
      }
      const outerBlock = content.slice(braceStart + 1, i - 1);

      for (const key of ["colors", "colour", "spacing", "space", "borderRadius", "radii", "radius", "fontSize", "fontSizes", "typography", "shadows", "boxShadow"]) {
        const propBlock = findPropertyBlock(outerBlock, key);
        if (!propBlock) continue;
        const category = mapNameToCategory(key);
        if (!category) continue;
        const tokens: TokenValue[] = [];
        flattenObject(propBlock, "", tokens, key, warnings);
        if (tokens.length) collections.push({ category, tokens });
      }
    }
  }

  return { source: "theme", sourcePath: filePath, collections, warnings };
}

function mapNameToCategory(name: string): TokenCategory | null {
  const lower = name.toLowerCase();
  if (lower.includes("color") || lower.includes("colour") || lower === "palette") return "colors";
  if (lower.includes("space") || lower.includes("spacing") || lower === "gap") return "spacing";
  if (lower.includes("radius") || lower.includes("radii") || lower.includes("borderradius") || lower.includes("rounded")) return "radius";
  if (lower.includes("font") || lower.includes("typo") || lower.includes("text")) return "typography";
  if (lower.includes("shadow") || lower.includes("elevation")) return "shadows";
  return null;
}

// --- Drift checking ---

export interface TokenBaseline {
  version: 1;
  source: TokenSourceType;
  sourcePath: string;
  collections: TokenCollection[];
  generatedAt: string;
}

export interface TokenDrift {
  added: { category: TokenCategory; tokens: TokenValue[] }[];
  removed: { category: TokenCategory; tokens: TokenValue[] }[];
  changed: { category: TokenCategory; token: string; from: string; to: string }[];
}

export function compareTokens(baseline: TokenBaseline, current: TokenExtractionResult): TokenDrift {
  const drift: TokenDrift = { added: [], removed: [], changed: [] };

  const baseMap = new Map(baseline.collections.map((c) => [c.category, c]));
  const currMap = new Map(current.collections.map((c) => [c.category, c]));

  // Find added and changed
  for (const [category, currColl] of currMap) {
    const baseColl = baseMap.get(category);
    if (!baseColl) {
      drift.added.push({ category, tokens: currColl.tokens });
      continue;
    }
    const baseTokenMap = new Map(baseColl.tokens.map((t) => [t.name, t.value]));
    const newTokens: TokenValue[] = [];

    for (const token of currColl.tokens) {
      const baseValue = baseTokenMap.get(token.name);
      if (baseValue == null) {
        newTokens.push(token);
      } else if (baseValue !== token.value) {
        drift.changed.push({ category, token: token.name, from: baseValue, to: token.value });
      }
    }
    if (newTokens.length) drift.added.push({ category, tokens: newTokens });
  }

  // Find removed
  for (const [category, baseColl] of baseMap) {
    const currColl = currMap.get(category);
    if (!currColl) {
      drift.removed.push({ category, tokens: baseColl.tokens });
      continue;
    }
    const currTokenNames = new Set(currColl.tokens.map((t) => t.name));
    const removedTokens = baseColl.tokens.filter((t) => !currTokenNames.has(t.name));
    if (removedTokens.length) drift.removed.push({ category, tokens: removedTokens });
  }

  return drift;
}

export function hasDrift(drift: TokenDrift): boolean {
  return drift.added.length > 0 || drift.removed.length > 0 || drift.changed.length > 0;
}
