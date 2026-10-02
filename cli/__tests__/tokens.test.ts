import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { extractTokens, detectTokenSource, compareTokens, hasDrift, readTokenBaseline, baselineCommand, parseTokenSource, tokenColorToHex, TOKEN_SOURCES } from "../tokens.js";
import type { TokenBaseline } from "../tokens.js";

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

// --- --source ---

test("parseTokenSource: takes each source there is, and nothing for detection", () => {
  for (const source of TOKEN_SOURCES) assert.equal(parseTokenSource(source), source);
  assert.equal(parseTokenSource(undefined), undefined);
});

test("parseTokenSource: auto detects, as leaving it out does", () => {
  // auto is the drift-check action's token_source default, and its users
  // are told to pass token_source on to --source for their baseline.
  assert.equal(parseTokenSource("auto"), undefined);
});

test("parseTokenSource: an unknown source throws, naming the ones there are, rather than detecting one", () => {
  // extractTokens has no case for one and detects a source, so it passed as
  // a run on whatever the project had first. Matched as written, as the
  // sources are, so AUTO is not auto.
  for (const source of ["scss", "CSS", "AUTO", ""]) {
    assert.throws(
      () => parseTokenSource(source),
      { message: `--source must be "tailwind", "css" or "theme", received "${source}". Leave it out, or pass "auto", to detect the source.` },
      source,
    );
  }
});

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

test("CSS: values in any CSS colour function are colours, not uncategorized", () => {
  // Names that say nothing, so only the value can: oklch() always counted,
  // and lab(), lch(), oklab(), color() and hwb() were dropped with a warning,
  // out of reach of diff and tokens --check.
  const dir = makeProject({
    "styles.css": `:root {
      --brand: oklch(63.7% 0.237 25.331);
      --brand-lab: lab(50 40 59.5);
      --brand-lch: lch(50% 72 56);
      --brand-oklab: oklab(0.6 0.1 -0.1);
      --brand-p3: color(display-p3 1 0 0);
      --brand-hwb: hwb(120 20% 30%);
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.deepEqual(colors?.tokens.map((t) => t.name).sort(), [
      "brand", "brand/hwb", "brand/lab", "brand/lch", "brand/oklab", "brand/p3",
    ]);
    // Kept as written: --check compares against the source, diff converts.
    assert.equal(colors?.tokens.find((t) => t.name === "brand/p3")?.value, "color(display-p3 1 0 0)");
    assert.equal(result.warnings.filter((w) => w.startsWith("Uncategorized")).length, 0, result.warnings.join("\n"));
  } finally { cleanup(dir); }
});

test("CSS: bare HSL channels with decimals are colours, as shadcn/ui writes them", () => {
  // Whole numbers only were read, so shadcn's sidebar colours were dropped
  // as uncategorized.
  const dir = makeProject({
    "styles.css": `:root {
      --sidebar-background: 0 0% 98%;
      --sidebar-primary: 240 5.9% 10%;
      --sidebar-ring: 217.2 91.2% 59.8% / 0.5;
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    const colors = result.collections.find((c) => c.category === "colors");
    assert.deepEqual(colors?.tokens.map((t) => [t.name, t.value]), [
      ["sidebar/background", "0 0% 98%"],
      ["sidebar/primary", "240 5.9% 10%"],
      ["sidebar/ring", "217.2 91.2% 59.8% / 0.5"],
    ]);
    assert.deepEqual(result.warnings, []);
  } finally { cleanup(dir); }
});

test("tokenColorToHex: reads bare HSL channels as hsl(), and anything colorToHex reads", () => {
  assert.equal(tokenColorToHex("0 0% 100%"), "#ffffff");
  assert.equal(tokenColorToHex(" 240 5.9% 10% "), "#18181b");
  assert.equal(tokenColorToHex("240 5.9% 10% / 50%"), "#18181b80");
  assert.equal(tokenColorToHex("oklch(63.7% 0.237 25.331)"), "#fb2c36");
  assert.equal(tokenColorToHex("#ABC"), "#aabbcc");
  for (const value of ["var(--background)", "currentColor", "0 0 100%", "1rem", ""]) {
    assert.equal(tokenColorToHex(value), null, value);
  }
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

test("Tailwind: a commented-out key is not a token, so a baseline of the config checks clean", () => {
  // `// primary` matched as a key: two primaries, and --check compared the
  // first with the baseline's last, drifting on an unchanged project.
  const dir = makeProject({
    "tailwind.config.js": `module.exports = {
      theme: {
        extend: {
          colors: {
            // primary: "#ff0000",
            primary: "#0000ff",
            secondary: "#00ff00",
          },
        },
      },
    }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    assert.deepEqual(result.collections.map((c) => c.tokens.map((t) => [t.name, t.value])), [[["primary", "#0000ff"], ["secondary", "#00ff00"]]]);
    assert.equal(hasDrift(compareTokens(baselineOf(result), extractTokens(dir, "tailwind"))), false);
  } finally { cleanup(dir); }
});

test("Tailwind: a commented-out block is not read in place of the real one, and strings keep their slashes", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = {
      content: ["./src/**/*.{js,ts}"],
      theme: {
        /* colors: { primary: "#111111" }, */
        extend: {
          colors: {
            /* brand: "#999999", */
            primary: "#0000ff", // the brand blue
            secondary: "#00ff00",
          },
          boxShadow: { glow: "0 0 4px url('https://x.test/a')" },
        },
      },
    }`,
  });
  try {
    const result = extractTokens(dir, "tailwind");
    const tokens = (category: string) => result.collections.find((c) => c.category === category)?.tokens.map((t) => [t.name, t.value]);
    assert.deepEqual(tokens("colors"), [["primary", "#0000ff"], ["secondary", "#00ff00"]]);
    assert.deepEqual(tokens("shadows"), [["glow", "0 0 4px url('https://x.test/a')"]]);
  } finally { cleanup(dir); }
});

test("Theme file: a commented-out key is not a token", () => {
  const dir = makeProject({
    "src/theme.ts": `export const colors = {\n  // primary: "#ff0000",\n  primary: "#0000ff", /* accent: "#00ff00", */\n};\n`,
  });
  try {
    const result = extractTokens(dir, "theme");
    assert.deepEqual(result.collections.map((c) => c.tokens.map((t) => [t.name, t.value])), [[["primary", "#0000ff"]]]);
  } finally { cleanup(dir); }
});

test("CSS: a commented-out custom property is not a token, and doesn't override the real one", () => {
  const dir = makeProject({
    "styles.css": `:root {
      /* --color-old: #ff0000; */
      --color-primary: #0000ff; /* was --color-primary: #ff0000; */
      --font-body: "Inter /* not a comment */", sans-serif;
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    assert.deepEqual(result.collections.map((c) => [c.category, c.tokens.map((t) => [t.name, t.value])]), [
      ["colors", [["color/primary", "#0000ff"]]],
      ["typography", [["font/body", `"Inter /* not a comment */", sans-serif`]]],
    ]);
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

// --- Source detection ---

test("detectTokenSource: finds tailwind config", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default { theme: { extend: { colors: { brand: "#ff0000" } } } }`,
  });
  try {
    const source = detectTokenSource(dir);
    assert.equal(source?.type, "tailwind");
  } finally { cleanup(dir); }
});

test("detectTokenSource: finds CSS custom properties", () => {
  const dir = makeProject({
    "src/styles.css": `:root { --color-primary: #3b82f6; }`,
  });
  try {
    const source = detectTokenSource(dir);
    assert.equal(source?.type, "css");
  } finally { cleanup(dir); }
});

test("detectTokenSource: returns null when nothing found", () => {
  const dir = makeProject({ "README.md": "# nothing here" });
  try {
    assert.equal(detectTokenSource(dir), null);
  } finally { cleanup(dir); }
});

// --- Colour hex ---

test("hex: each colour token carries its sRGB hex next to the value as written", () => {
  // figma.util.rgb() takes only hex, rgb(), hsl() and lab(), so the push
  // threw on an oklch() token or bare HSL channels; it sets colours from hex.
  const dir = makeProject({
    "styles.css": `:root {
      --brand: oklch(63.7% 0.237 25.331);
      --background: 0 0% 100%;
      --ring: oklch(63.7% 0.237 25.331 / 50%);
      --color-text: currentColor;
      --color-link: var(--nowhere);
      --spacing-4: 1rem;
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    assert.deepEqual(result.collections.map((c) => [c.category, c.tokens]), [
      ["colors", [
        { name: "brand", value: "oklch(63.7% 0.237 25.331)", hex: "#fb2c36" },
        { name: "background", value: "0 0% 100%", hex: "#ffffff" },
        { name: "ring", value: "oklch(63.7% 0.237 25.331 / 50%)", hex: "#fb2c3680" },
        // Nothing to convert: no hex, rather than a guess.
        { name: "color/text", value: "currentColor" },
        { name: "color/link", value: "var(--nowhere)" },
      ]],
      ["spacing", [{ name: "spacing/4", value: "1rem" }]],
    ]);
  } finally { cleanup(dir); }
});

test("hex: a Tailwind colour resolved from :root carries the hex of what it resolved to", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default { theme: { extend: { colors: { background: "hsl(var(--background))", brand: { 500: "#3B82F6" } } } } }`,
    "app/globals.css": `:root { --background: 222.2 84% 4.9%; }`,
  });
  try {
    const colors = extractTokens(dir).collections.find((c) => c.category === "colors");
    assert.deepEqual(colors?.tokens.map((t) => [t.name, t.value, t.hex]), [
      ["background", "hsl(222.2 84% 4.9%)", "#020817"],
      ["brand/500", "#3B82F6", "#3b82f6"],
    ]);
  } finally { cleanup(dir); }
});

test("hex: --check compares the value, so a baseline written before hex checks clean", () => {
  const dir = makeProject({ "styles.css": `:root { --brand: oklch(63.7% 0.237 25.331); }` });
  try {
    const current = extractTokens(dir);
    assert.equal(current.collections[0].tokens[0].hex, "#fb2c36");
    const old = baselineOf({ ...current, collections: current.collections.map((c) => ({ ...c, tokens: c.tokens.map(({ name, value }) => ({ name, value })) })) });
    assert.equal(hasDrift(compareTokens(old, current)), false);
    // And a hex that differs, as a later colour conversion fix might make it, is not drift.
    const shifted = baselineOf({ ...current, collections: current.collections.map((c) => ({ ...c, tokens: c.tokens.map((t) => ({ ...t, hex: "#fb2c37" })) })) });
    assert.equal(hasDrift(compareTokens(shifted, current)), false);
  } finally { cleanup(dir); }
});

// --- Drift detection ---

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

test("drift: detects added and removed tokens", () => {
  const baseline: TokenBaseline = {
    version: 1,
    source: "tailwind",
    sourcePath: "/fake",
    collections: [{ category: "colors", tokens: [{ name: "old", value: "#000" }] }],
    generatedAt: FIXED_TIMESTAMP,
  };
  const current = {
    source: "tailwind" as const,
    sourcePath: "/fake",
    collections: [{ category: "colors" as const, tokens: [{ name: "new", value: "#fff" }] }],
    warnings: [],
  };
  const drift = compareTokens(baseline, current);
  assert.ok(hasDrift(drift));
  assert.ok(drift.added.some((a) => a.tokens.some((t) => t.name === "new")));
  assert.ok(drift.removed.some((r) => r.tokens.some((t) => t.name === "old")));
});

test("drift: detects changed values", () => {
  const baseline: TokenBaseline = {
    version: 1,
    source: "css",
    sourcePath: "/fake",
    collections: [{ category: "colors", tokens: [{ name: "primary", value: "#000" }] }],
    generatedAt: FIXED_TIMESTAMP,
  };
  const current = {
    source: "css" as const,
    sourcePath: "/fake",
    collections: [{ category: "colors" as const, tokens: [{ name: "primary", value: "#fff" }] }],
    warnings: [],
  };
  const drift = compareTokens(baseline, current);
  assert.ok(hasDrift(drift));
  assert.equal(drift.changed.length, 1);
  assert.equal(drift.changed[0].from, "#000");
  assert.equal(drift.changed[0].to, "#fff");
});

test("drift: identical tokens report no drift", () => {
  const collections = [{ category: "colors" as const, tokens: [{ name: "primary", value: "#000" }] }];
  const baseline: TokenBaseline = {
    version: 1,
    source: "css",
    sourcePath: "/fake",
    collections,
    generatedAt: FIXED_TIMESTAMP,
  };
  const drift = compareTokens(baseline, {
    source: "css" as const, sourcePath: "/fake", collections, warnings: [],
  });
  assert.equal(hasDrift(drift), false);
});

/** A baseline as `tokens --json` would write it for this extraction. */
function baselineOf(result: ReturnType<typeof extractTokens>): TokenBaseline {
  return { version: 1, source: result.source, sourcePath: result.sourcePath, collections: result.collections, generatedAt: FIXED_TIMESTAMP };
}

test("drift: a category a theme file splits across exports is compared whole", () => {
  // fontSizes and fontWeights are both typography collections. Keyed by
  // category, only the last was compared: a changed font size passed, and
  // dropping fontWeights reported the unchanged sizes as added.
  const theme = (sm: string, weights: boolean) =>
    `export const colors = { primary: "#0000ff" };\n` +
    `export const fontSizes = { sm: "${sm}", md: "16px" };\n` +
    (weights ? `export const fontWeights = { regular: "400", bold: "700" };\n` : "");
  const dir = makeProject({ "src/theme.ts": theme("14px", true) });
  try {
    const baseline = baselineOf(extractTokens(dir));
    assert.equal(baseline.collections.filter((c) => c.category === "typography").length, 2);

    writeFileSync(join(dir, "src/theme.ts"), theme("99px", true));
    assert.deepEqual(compareTokens(baseline, extractTokens(dir)), {
      added: [],
      removed: [],
      changed: [{ category: "typography", token: "sm", from: "14px", to: "99px" }],
    });

    writeFileSync(join(dir, "src/theme.ts"), theme("14px", false));
    const drift = compareTokens(baseline, extractTokens(dir));
    assert.deepEqual(drift.added, []);
    assert.deepEqual(drift.changed, []);
    assert.deepEqual(drift.removed.map((r) => r.tokens.map((t) => t.name)), [["regular", "bold"]]);
  } finally { cleanup(dir); }
});

test("drift: a name listed twice compares once, the last of it winning on both sides", () => {
  // Every current entry was compared with the baseline's last, so a baseline
  // taken from the same extraction reported drift, and no new one could fix it.
  const collections = [{ category: "colors" as const, tokens: [{ name: "primary", value: "#ff0000" }, { name: "primary", value: "#0000ff" }] }];
  const current = { source: "tailwind" as const, sourcePath: "/fake", collections, warnings: [] };
  assert.equal(hasDrift(compareTokens(baselineOf(current), current)), false);
  const once = { ...current, collections: [{ category: "colors" as const, tokens: [{ name: "primary", value: "#0000ff" }] }] };
  assert.equal(hasDrift(compareTokens(baselineOf(current), once)), false);
});

// --- Baseline files ---

test("readTokenBaseline: returns null for a missing file, for the caller to report", () => {
  const dir = makeProject({});
  try {
    assert.equal(readTokenBaseline(join(dir, "nope.json")), null);
  } finally { cleanup(dir); }
});

test("readTokenBaseline: reads the output of tokens --json", () => {
  const dir = makeProject({
    "baseline.json": JSON.stringify({ source: "css", sourcePath: "tokens.css", collections: [{ category: "colors", tokens: [] }], warnings: [], summary: {} }),
  });
  try {
    assert.equal(readTokenBaseline(join(dir, "baseline.json"))?.collections[0].category, "colors");
  } finally { cleanup(dir); }
});

test("readTokenBaseline: rejects JSON that is not a baseline, such as a saved passing --check", () => {
  const dir = makeProject({ "check.json": `{"drift":false}`, "broken.json": "{" });
  try {
    assert.throws(() => readTokenBaseline(join(dir, "check.json")), /has no "collections", so it is not a baseline/);
    assert.throws(() => readTokenBaseline(join(dir, "broken.json")), /is not valid JSON/);
  } finally { cleanup(dir); }
});

test("readTokenBaseline: rejects collections and tokens that are not what tokens --json writes", () => {
  const dir = makeProject({
    "empty-collection.json": `{"collections":[{}]}`,
    "no-tokens.json": `{"collections":[{"category":"colors"}]}`,
    "no-category.json": `{"collections":[{"tokens":[]}]}`,
    "null-collection.json": `{"collections":[null]}`,
    "unnamed-token.json": `{"collections":[{"category":"colors","tokens":[{"value":"#fff"}]}]}`,
    "numeric-value.json": `{"collections":[{"category":"spacing","tokens":[{"name":"4","value":4}]}]}`,
    "null-token.json": `{"collections":[{"category":"colors","tokens":[null]}]}`,
  });
  try {
    for (const name of ["empty-collection", "no-tokens", "no-category", "null-collection"]) {
      assert.throws(() => readTokenBaseline(join(dir, `${name}.json`)), /has a collection without a "category" and a "tokens" list, so it is not a baseline$/, name);
    }
    assert.throws(() => readTokenBaseline(join(dir, "unnamed-token.json")), /has a colors token without a "name" and a "value", so it is not a baseline$/);
    assert.throws(() => readTokenBaseline(join(dir, "numeric-value.json")), /has a spacing token without a "name" and a "value"/);
    assert.throws(() => readTokenBaseline(join(dir, "null-token.json")), /has a colors token without/);
  } finally { cleanup(dir); }
});

test("readTokenBaseline: an empty collections list is a baseline", () => {
  const dir = makeProject({ "empty.json": `{"collections":[]}` });
  try {
    assert.deepEqual(readTokenBaseline(join(dir, "empty.json"))?.collections, []);
  } finally { cleanup(dir); }
});

test("baselineCommand: creates the directory the redirect writes into", () => {
  assert.equal(
    baselineCommand(".storysync/tokens-baseline.json"),
    "mkdir -p -- .storysync && storysync tokens --json > .storysync/tokens-baseline.json",
  );
  assert.equal(baselineCommand("baseline.json"), "storysync tokens --json > baseline.json");
});

test("baselineCommand: repeats --project and --source so the baseline matches what --check extracts", () => {
  assert.equal(
    baselineCommand("b.json", { project: "packages/ui", source: "css" }),
    "storysync tokens --project packages/ui --source css --json > b.json",
  );
  assert.equal(baselineCommand("b.json", { project: "." }), "storysync tokens --json > b.json");
});

test("baselineCommand: ends mkdir's options, so a directory starting with a dash is made, not read as one", () => {
  assert.equal(
    baselineCommand("-p/tokens.json"),
    "mkdir -p -- -p && storysync tokens --json > -p/tokens.json",
  );
  assert.equal(
    baselineCommand("--help me/tokens.json"),
    "mkdir -p -- '--help me' && storysync tokens --json > '--help me/tokens.json'",
  );
});

test("baselineCommand: quotes paths the shell would split", () => {
  assert.equal(
    baselineCommand("my tokens/base's.json"),
    `mkdir -p -- 'my tokens' && storysync tokens --json > 'my tokens/base'\\''s.json'`,
  );
});
