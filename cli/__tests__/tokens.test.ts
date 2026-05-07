import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { extractTokens } from "../tokens.js";

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "storysync-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    const parent = dirname(full);
    if (parent !== dir) mkdirSync(parent, { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

// --- CSS extraction ---

test("CSS: captures last declaration without trailing semicolon", () => {
  const dir = makeProject({
    "styles.css": `:root { --color-primary: #3b82f6; --color-secondary: #ef4444 }`,
  });
  try {
    const result = extractTokens(dir, "css");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.ok(colors, "should have colors collection");
    const names = colors!.tokens.map((t) => t.name);
    assert.ok(names.includes("color/primary"), "should capture --color-primary");
    assert.ok(names.includes("color/secondary"), "should capture --color-secondary even without trailing semicolon");
  } finally { cleanup(dir); }
});

test("CSS: resolves chained var() references", () => {
  const dir = makeProject({
    "styles.css": `:root {
      --base-blue: #3b82f6;
      --brand-blue: var(--base-blue);
      --color-primary: var(--brand-blue);
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    const colors = result.collections.find((c) => c.category === "colors");
    const primary = colors!.tokens.find((t) => t.name === "color/primary");
    assert.equal(primary?.value, "#3b82f6", "chained var() should resolve to final value");
  } finally { cleanup(dir); }
});

test("CSS: var() with fallback uses fallback when reference is missing", () => {
  const dir = makeProject({
    "styles.css": `:root {
      --color-primary: var(--undefined-var, #ff0000);
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    const colors = result.collections.find((c) => c.category === "colors");
    const primary = colors!.tokens.find((t) => t.name === "color/primary");
    assert.equal(primary?.value, "#ff0000", "should fall back when var is undefined");
  } finally { cleanup(dir); }
});

test("CSS: --text-* with rem value categorized as typography", () => {
  const dir = makeProject({
    "styles.css": `:root {
      --text-sm: 0.875rem;
      --text-lg: 1.125rem;
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    const typography = result.collections.find((c) => c.category === "typography");
    assert.ok(typography, "should have typography collection");
    const names = typography!.tokens.map((t) => t.name);
    assert.ok(names.includes("text/sm"), "--text-sm should be typography");
    assert.ok(names.includes("text/lg"), "--text-lg should be typography");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.equal(colors, undefined, "no color collection should be created");
  } finally { cleanup(dir); }
});

test("CSS: --text-* with hex value categorized as colors", () => {
  const dir = makeProject({
    "styles.css": `:root {
      --text-primary: #000000;
      --text-secondary: #666666;
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.ok(colors, "should have colors collection");
    const names = colors!.tokens.map((t) => t.name);
    assert.ok(names.includes("text/primary"), "--text-primary should be color");
  } finally { cleanup(dir); }
});

test("CSS: cycle in var() references doesn't loop forever", () => {
  const dir = makeProject({
    "styles.css": `:root {
      --color-a: var(--color-b);
      --color-b: var(--color-a);
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    // Should complete without hanging — values may be the original var() string
    assert.ok(Array.isArray(result.collections));
  } finally { cleanup(dir); }
});

test("CSS: standard prefixes categorized correctly", () => {
  const dir = makeProject({
    "styles.css": `:root {
      --color-primary: #3b82f6;
      --spacing-4: 1rem;
      --radius-md: 0.375rem;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
      --font-size-base: 1rem;
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    const cats = new Set(result.collections.map((c) => c.category));
    assert.ok(cats.has("colors"));
    assert.ok(cats.has("spacing"));
    assert.ok(cats.has("radius"));
    assert.ok(cats.has("shadows"));
    assert.ok(cats.has("typography"));
  } finally { cleanup(dir); }
});

// --- Tailwind extraction ---

test("Tailwind: extracts colors from theme.extend", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = {
      theme: {
        extend: {
          colors: {
            primary: { 500: '#3b82f6', 600: '#2563eb' },
            danger: '#ef4444'
          }
        }
      }
    }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.ok(colors, "should have colors collection");
    const map = new Map(colors!.tokens.map((t) => [t.name, t.value]));
    assert.equal(map.get("primary/500"), "#3b82f6");
    assert.equal(map.get("primary/600"), "#2563eb");
    assert.equal(map.get("danger"), "#ef4444");
  } finally { cleanup(dir); }
});

test("Tailwind: extracts spacing and borderRadius", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = {
      theme: {
        extend: {
          spacing: { 1: '0.25rem', 2: '0.5rem' },
          borderRadius: { sm: '0.125rem', md: '0.375rem' }
        }
      }
    }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const spacing = result.collections.find((c) => c.category === "spacing");
    const radius = result.collections.find((c) => c.category === "radius");
    assert.equal(spacing?.tokens.length, 2);
    assert.equal(radius?.tokens.length, 2);
  } finally { cleanup(dir); }
});

test("Tailwind: skips theme() and require() dynamic calls but emits warning", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = {
      theme: {
        extend: {
          colors: {
            primary: theme('colors.blue.500'),
            secondary: '#ff0000'
          }
        }
      }
    }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const colors = result.collections.find((c) => c.category === "colors");
    const map = new Map(colors!.tokens.map((t) => [t.name, t.value]));
    assert.equal(map.has("primary"), false, "dynamic theme() call should be skipped");
    assert.equal(map.get("secondary"), "#ff0000");
    assert.ok(result.warnings.some((w) => w.includes("primary")), "should warn about skipped dynamic value");
  } finally { cleanup(dir); }
});

// --- Tailwind + CSS var resolution (shadcn/ui pattern) ---

test("Tailwind: resolves hsl(var(--name)) refs against :root in globals.css", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default {
      theme: {
        extend: {
          colors: {
            background: 'hsl(var(--background))',
            foreground: 'hsl(var(--foreground))',
            primary: 'hsl(var(--primary))'
          }
        }
      }
    }`,
    "app/globals.css": `:root {
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --primary: 221.2 83.2% 53.3%;
    }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const colors = result.collections.find((c) => c.category === "colors");
    const map = new Map(colors!.tokens.map((t) => [t.name, t.value]));
    assert.equal(map.get("background"), "hsl(0 0% 100%)");
    assert.equal(map.get("foreground"), "hsl(222.2 84% 4.9%)");
    assert.equal(map.get("primary"), "hsl(221.2 83.2% 53.3%)");
    assert.ok(result.warnings.some((w) => w.includes("Resolved CSS variable")));
  } finally { cleanup(dir); }
});

test("Tailwind: strips <alpha-value> placeholder", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default {
      theme: { extend: { colors: { background: 'hsl(var(--background) / <alpha-value>)' } } }
    }`,
    "app/globals.css": `:root { --background: 0 0% 100%; }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.equal(colors!.tokens[0].value, "hsl(0 0% 100%)");
  } finally { cleanup(dir); }
});

test("Tailwind: var() ref with no matching CSS uses fallback", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default {
      theme: { extend: { colors: { brand: 'hsl(var(--missing, 200 50% 50%))' } } }
    }`,
    "app/globals.css": `:root { --other: 0 0% 100%; }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.equal(colors!.tokens[0].value, "hsl(200 50% 50%)");
  } finally { cleanup(dir); }
});

test("Tailwind: nested CSS var refs resolve transitively", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default {
      theme: { extend: { colors: { brand: 'hsl(var(--brand))' } } }
    }`,
    "app/globals.css": `:root {
      --brand: var(--blue-500);
      --blue-500: 221 83% 53%;
    }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.equal(colors!.tokens[0].value, "hsl(221 83% 53%)");
  } finally { cleanup(dir); }
});

test("Tailwind: literal values pass through unchanged when no CSS file present", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default {
      theme: { extend: { colors: { primary: '#3b82f6' } } }
    }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.equal(colors!.tokens[0].value, "#3b82f6");
    assert.ok(!result.warnings.some((w) => w.includes("Resolved CSS variable")));
  } finally { cleanup(dir); }
});

test("Tailwind: var() with no match and no fallback stays as raw var()", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default {
      theme: { extend: { colors: { brand: 'hsl(var(--missing))' } } }
    }`,
    "app/globals.css": `:root { --other: 0 0% 100%; }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.equal(colors!.tokens[0].value, "hsl(var(--missing))");
  } finally { cleanup(dir); }
});
