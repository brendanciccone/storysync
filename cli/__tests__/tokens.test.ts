import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { extractTokens, detectTokenSource, compareTokens, hasDrift, readTokenBaseline, baselineCommand, parseTokenSource, tokenColorToHex, lengthToPx, resolveTailwindCssRefs, TOKEN_SOURCES, baseDefaults, withoutRepeatedDefault } from "../tokens.js";
import type { TokenBaseline, TokenExtractionResult } from "../tokens.js";

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

test("CSS: values in any CSS color function are colors, not uncategorized", () => {
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

test("CSS: bare HSL channels with decimals are colors, as shadcn/ui writes them", () => {
  // Whole numbers only were read, so shadcn's sidebar colors were dropped
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

// --- Tailwind v4 @theme ---

/** Every collection as [category, [[name, value], ...]], for one deepEqual. */
function tokenTable(result: ReturnType<typeof extractTokens>) {
  return result.collections.map((c) => [c.category, c.tokens.map((t) => [t.name, t.value])]);
}

test("Tailwind v4: a CSS-first project's @theme is its token source, read by namespace", () => {
  // Nothing but @theme: no config, no :root, so no token source was found.
  const dir = makeProject({
    "src/app.css": `@import "tailwindcss";

@theme {
  --color-brand-500: oklch(62.3% 0.214 259.815);
  --color-card-foreground: #0a0a0a;
  --spacing: 0.25rem;
  --spacing-18: 4.5rem;
  --radius-card: 0.75rem;
  --shadow-soft: 0 2px 8px rgb(0 0 0 / 0.1);
  --text-hero: 3.5rem;
  --text-hero--line-height: 1.1;
  --font-display: "Satoshi", sans-serif;
  --font-weight-heavy: 850;
  --leading-snug: 1.375;
  --tracking-tightest: -0.075em;
}`,
  });
  try {
    const detected = detectTokenSource(dir);
    assert.equal(detected?.type, "tailwind");
    assert.equal(detected?.path, join(dir, "src/app.css"));
    for (const result of [extractTokens(dir), extractTokens(dir, "tailwind")]) {
      assert.equal(result.source, "tailwind");
      assert.equal(result.sourcePath, join(dir, "src/app.css"));
      assert.deepEqual(tokenTable(result), [
        ["colors", [["brand/500", "oklch(62.3% 0.214 259.815)"], ["card/foreground", "#0a0a0a"]]],
        ["spacing", [["DEFAULT", "0.25rem"], ["18", "4.5rem"]]],
        ["typography", [
          ["text/hero", "3.5rem"],
          ["font/display", `"Satoshi", sans-serif`],
          ["font/weight/heavy", "850"],
          ["leading/snug", "1.375"],
          ["tracking/tightest", "-0.075em"],
        ]],
        ["radius", [["card", "0.75rem"]]],
        ["shadows", [["soft", "0 2px 8px rgb(0 0 0 / 0.1)"]]],
      ]);
      assert.equal(result.collections[0].tokens[0].hex, "#2b7fff");
      assert.deepEqual(result.warnings, []);
    }
  } finally { cleanup(dir); }
});

test("Tailwind v4: var() resolves against the theme, :root and Tailwind's own theme", () => {
  // shadcn/ui's v4 globals.css: @theme inline points at :root, and a
  // project's theme can name Tailwind's default palette.
  const dir = makeProject({
    "app/globals.css": `@import "tailwindcss";
@custom-variant dark (&:is(.dark *));

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-lg: var(--radius);
  --color-background: var(--background);
  --color-primary: var(--color-blue-500);
  --color-accent: var(--color-brand);
  --color-brand: #3b82f6;
  --color-link: var(--nowhere);
}

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
}`,
    "node_modules/tailwindcss/theme.css": `@theme default {
  --color-blue-500: oklch(62.3% 0.214 259.815);
  --font-sans: ui-sans-serif, system-ui, sans-serif;
}`,
  });
  try {
    // :root stays the detected source, so a project like this keeps the
    // tokens it had; --source tailwind reads its @theme.
    assert.equal(detectTokenSource(dir)?.type, "css");
    const result = extractTokens(dir, "tailwind");
    assert.deepEqual(tokenTable(result), [
      ["colors", [
        ["background", "oklch(1 0 0)"],
        ["primary", "oklch(62.3% 0.214 259.815)"],
        ["accent", "#3b82f6"],
        ["brand", "#3b82f6"],
        // Kept as written, as a Tailwind config's unresolved var() is.
        ["link", "var(--nowhere)"],
      ]],
      ["radius", [["sm", "calc(0.625rem - 4px)"], ["lg", "0.625rem"]]],
    ]);
    // Tailwind's defaults resolve references but aren't the project's tokens.
    assert.equal(result.collections.flatMap((c) => c.tokens).some((t) => t.name.includes("blue") || t.name.includes("sans")), false);
    // --source css reads :root's colors, not @theme's, and its radius with
    // the scale @theme builds from it.
    assert.deepEqual(tokenTable(extractTokens(dir, "css")), [
      ["colors", [["background", "oklch(1 0 0)"]]],
      // --radius is lg, so it isn't made a variable of its own as DEFAULT.
      ["radius", [["sm", "calc(0.625rem - 4px)"], ["lg", "0.625rem"]]],
    ]);
  } finally { cleanup(dir); }
});

test("Tailwind v4: initial removes a variable or a namespace, and nested rules and other namespaces aren't tokens", () => {
  const dir = makeProject({
    "src/theme.css": `@theme {
  --color-red-500: #ef4444;
  --color-old: #ff0000;
  --color-old: initial;
  --spacing-*: initial;
  --spacing-4: 1rem;
  --breakpoint-3xl: 120rem;
  --text-shadow-glow: 0 0 4px #ff0000;
  --animate-wiggle: wiggle 1s ease-in-out infinite;
  @keyframes wiggle {
    0%, 100% { transform: rotate(-3deg); }
    50% { --color-not-a-token: #000; }
  }
}
/* @theme { --color-commented: #123456; } */
@theme {
  --color-*: initial;
  --color-brand: #3b82f6;
}`,
  });
  try {
    const result = extractTokens(dir);
    assert.deepEqual(tokenTable(result), [
      ["colors", [["brand", "#3b82f6"]]],
      ["spacing", [["4", "1rem"]]],
    ]);
    assert.deepEqual(result.warnings, [
      "Uncategorized: --breakpoint-3xl: 120rem",
      "Uncategorized: --text-shadow-glow: 0 0 4px #ff0000",
      "Uncategorized: --animate-wiggle: wiggle 1s ease-in-out infinite",
    ]);
  } finally { cleanup(dir); }
});

test("Tailwind v4: a tailwind.config still comes first, and an @theme only in a comment isn't one", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { colors: { brand: "#ff0000" } } } }`,
    "src/app.css": `@theme { --color-brand: #0000ff; }`,
  });
  try {
    assert.equal(detectTokenSource(dir)?.path, join(dir, "tailwind.config.js"));
    assert.deepEqual(tokenTable(extractTokens(dir)), [["colors", [["brand", "#ff0000"]]]]);
  } finally { cleanup(dir); }

  const commented = makeProject({ "src/app.css": `@import "tailwindcss";\n/* @theme { --color-brand: #0000ff; } */\n` });
  try {
    assert.equal(detectTokenSource(commented), null);
    assert.deepEqual(extractTokens(commented, "tailwind").warnings, ["No tailwind.config or CSS @theme block found"]);
  } finally { cleanup(commented); }
});

// --- Color hex ---

test("hex: each color token carries its sRGB hex next to the value as written", () => {
  // figma.util.rgb() takes only hex, rgb(), hsl() and lab(), so the push
  // threw on an oklch() token or bare HSL channels; it sets colors from hex.
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
      ["spacing", [{ name: "spacing/4", value: "1rem", px: 16 }]],
    ]);
  } finally { cleanup(dir); }
});

test("hex: a Tailwind color resolved from :root carries the hex of what it resolved to", () => {
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
    // And a hex that differs, as a later color conversion fix might make it, is not drift.
    const shifted = baselineOf({ ...current, collections: current.collections.map((c) => ({ ...c, tokens: c.tokens.map((t) => ({ ...t, hex: "#fb2c37" })) })) });
    assert.equal(hasDrift(compareTokens(shifted, current)), false);
  } finally { cleanup(dir); }
});

test("hex: a color whose :root value holds a var() gets the hex of what it resolves to, its value kept as written", () => {
  // :root resolves a var() only when it is the whole value, so this one had
  // no hex, and diff compared `hsl(var(--brand))` with Figma's as text.
  const dir = makeProject({ "styles.css": `:root { --brand: 210 40% 50%; --ring: hsl(var(--brand) / 50%); }` });
  try {
    const colors = extractTokens(dir).collections.find((c) => c.category === "colors");
    assert.deepEqual(colors?.tokens.map((t) => [t.name, t.value, t.hex]), [
      ["brand", "210 40% 50%", tokenColorToHex("hsl(210 40% 50%)")],
      ["ring", "hsl(var(--brand) / 50%)", tokenColorToHex("hsl(210 40% 50% / 50%)")],
    ]);
  } finally { cleanup(dir); }
});

// --- Bare scale names and shadcn/ui v4 ---

test("CSS: a bare --radius, --spacing or --shadow is its category's DEFAULT, not uncategorized", () => {
  // shadcn/ui's :root holds its one radius as the bare --radius. Reported
  // uncategorized, it reached neither the push nor --check, so a changed
  // radius passed. DEFAULT is what @theme's bare --spacing is named.
  const dir = makeProject({
    "styles.css": `:root {
      --radius: 0.5rem;
      --spacing: 0.25rem;
      --shadow: 0 1px 2px rgb(0 0 0 / 0.05);
      --radius-card: 0.75rem;
    }`,
  });
  try {
    const result = extractTokens(dir, "css");
    assert.deepEqual(tokenTable(result), [
      ["spacing", [["DEFAULT", "0.25rem"]]],
      ["radius", [["DEFAULT", "0.5rem"], ["radius/card", "0.75rem"]]],
      ["shadows", [["DEFAULT", "0 1px 2px rgb(0 0 0 / 0.05)"]]],
    ]);
    assert.deepEqual(result.warnings, []);
  } finally { cleanup(dir); }
});

/** shadcn/ui's v4 globals.css, cut down: @theme inline points at :root. */
const SHADCN_V4_GLOBALS = `@import "tailwindcss";
@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-primary: var(--primary);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-geist-mono);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --animate-accordion-down: accordion-down 0.2s ease-out;
}

:root {
  --radius: 0.625rem;
  --primary: oklch(0.205 0 0);
  --background: oklch(1 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
}
`;

test("CSS: shadcn/ui v4 gives :root's colors and radius, and the radius scale @theme builds from it, in px", () => {
  // Read through :root alone, there was no radius at all, and the bare
  // --radius alone would leave the push one radius to bind sm, md, lg and
  // xl to. @theme's colors point at :root's and aren't read twice; its
  // fonts don't resolve from any stylesheet, so a warning names them.
  const dir = makeProject({ "app/globals.css": SHADCN_V4_GLOBALS });
  try {
    assert.equal(detectTokenSource(dir)?.type, "css");
    const auto = extractTokens(dir);
    assert.deepEqual(extractTokens(dir, "css"), auto);
    assert.equal(auto.source, "css");
    assert.deepEqual(auto.collections.map((c) => [c.category, c.tokens.map((t) => [t.name, t.value, t.hex ?? t.px])]), [
      ["colors", [["primary", "oklch(0.205 0 0)", "#171717"], ["background", "oklch(1 0 0)", "#ffffff"]]],
      ["radius", [
        ["sm", "calc(0.625rem - 4px)", 6],
        ["md", "calc(0.625rem - 2px)", 8],
        ["lg", "0.625rem", 10],
        ["xl", "calc(0.625rem + 4px)", 14],
      ]],
    ]);
    // --source tailwind would find them unresolved too, so it isn't offered.
    assert.deepEqual(auto.warnings, [
      "Unresolved: not read from @theme, since a var() in them doesn't resolve: typography font/sans (--font-sans is set only in terms of itself), font/mono (--font-geist-mono isn't set in :root or @theme)",
    ]);
    // The .dark block's background is the token's dark value; primary,
    // which .dark leaves alone, has none.
    assert.deepEqual(auto.modes, ["Light", "Dark"]);
    assert.deepEqual(auto.collections[0].tokens.map((t) => [t.name, t.dark]), [
      ["primary", undefined],
      ["background", { value: "oklch(0.145 0 0)", hex: "#0a0a0a" }],
    ]);

    // A baseline from before lists the colors alone, so it sees the radius
    // as added once, and nothing changed or removed.
    const colorsOnly = baselineOf({ ...auto, collections: auto.collections.filter((c) => c.category === "colors") });
    const upgraded = compareTokens(colorsOnly, auto);
    assert.deepEqual(upgraded.added.map((a) => [a.category, a.tokens.map((t) => t.name)]), [["radius", ["sm", "md", "lg", "xl"]]]);
    assert.deepEqual([upgraded.removed, upgraded.changed], [[], []]);

    // A baseline from before holds the DEFAULT that repeats lg: it checks clean.
    const withDefault = (from: TokenExtractionResult, value: string, px: number) => ({
      ...from, collections: from.collections.map((c) => (c.category === "radius" ? { ...c, tokens: [{ name: "DEFAULT", value, px }, ...c.tokens] } : c)),
    });
    const before = baselineOf(withDefault(auto, "0.625rem", 10));
    assert.equal(hasDrift(compareTokens(before, auto)), false);

    // And a changed --radius is drift on every radius, that baseline's included.
    const baseline = baselineOf(auto);
    writeFileSync(join(dir, "app/globals.css"), SHADCN_V4_GLOBALS.replace("--radius: 0.625rem", "--radius: 0.5rem"));
    assert.deepEqual(compareTokens(before, extractTokens(dir)).changed.map((c) => c.token), ["sm", "md", "lg", "xl"]);
    assert.deepEqual(compareTokens(baseline, extractTokens(dir)).changed.map((c) => [c.token, c.to]), [
      ["sm", "calc(0.5rem - 4px)"],
      ["md", "calc(0.5rem - 2px)"],
      ["lg", "0.5rem"],
      ["xl", "calc(0.5rem + 4px)"],
    ]);
  } finally { cleanup(dir); }
});

test("CSS: only @theme variables built from :root are read through it, and :root's own declaration wins", () => {
  const dir = makeProject({
    "src/app.css": `@theme {
  --radius-card: 0.75rem;
  --spacing: var(--space-unit);
  --radius-pill: var(--radius-card);
  --radius-xs: calc(var(--radius-sm) / 2);
  --radius-sm: calc(var(--radius) - 4px);
  --color-brand: #3b82f6;
  --shadow-soft: 0 2px 4px var(--shadow-color);
  --radius-md: var(--radius);
}`,
    "src/tokens.css": `:root {
  --space-unit: 4px;
  --radius: 8px;
  --radius-md: 6px;
  --shadow-color: rgb(0 0 0 / 0.1);
}`,
  });
  try {
    const result = extractTokens(dir, "css");
    assert.deepEqual(tokenTable(result), [
      ["colors", [["shadow/color", "rgb(0 0 0 / 0.1)"]]],
      // Through another @theme variable counts.
      ["spacing", [["space/unit", "4px"], ["DEFAULT", "4px"]]],
      ["radius", [["DEFAULT", "8px"], ["radius/md", "6px"], ["xs", "calc(calc(8px - 4px) / 2)"], ["sm", "calc(8px - 4px)"]]],
      ["shadows", [["soft", "0 2px 4px rgb(0 0 0 / 0.1)"]]],
    ]);
    assert.deepEqual(result.warnings, [
      "Not read from @theme, since they aren't built from :root's variables: radius card, pill; colors brand. Pass --source tailwind to read @theme instead",
    ]);
  } finally { cleanup(dir); }
});

test("CSS: an @theme variable built from one both declare is worked out from :root's value", () => {
  // Tailwind puts @theme's --radius in its theme layer, which :root's
  // overrides, so rounded-sm renders 4px. @theme's 1rem gave sm 12px next to
  // a DEFAULT of 8.
  const dir = makeProject({
    "app/globals.css": `@theme {
  --radius: 1rem;
  --radius-sm: calc(var(--radius) - 4px);
}
:root { --radius: 0.5rem; }`,
  });
  try {
    const result = extractTokens(dir, "css");
    assert.deepEqual(result.collections.map((c) => [c.category, c.tokens]), [
      ["radius", [{ name: "DEFAULT", value: "0.5rem", px: 8 }, { name: "sm", value: "calc(0.5rem - 4px)", px: 4 }]],
    ]);
    assert.deepEqual(result.warnings, []);
  } finally { cleanup(dir); }
});

test("CSS: a :root for the dark color scheme doesn't override the light one", () => {
  // create-next-app's globals.css. Read in order with the rest, its dark
  // :root won, and the light theme's tokens came out #0a0a0a on #ededed.
  const globals = `@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #171717;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
  }
}

@media not all and (prefers-color-scheme: dark) {
  :root { --foreground: #111111; }
}
`;
  const dir = makeProject({ "app/globals.css": globals });
  try {
    const light = [["colors", [["background", "#ffffff"], ["foreground", "#111111"]]]];
    assert.deepEqual(tokenTable(extractTokens(dir)), light);
    assert.deepEqual(tokenTable(extractTokens(dir, "tailwind")).slice(0, 1), light);
    assert.deepEqual(extractTokens(dir).warnings, [
      "Unresolved: not read from @theme, since a var() in them doesn't resolve: typography font/sans (--font-geist-sans isn't set in :root or @theme), font/mono (--font-geist-mono isn't set in :root or @theme)",
    ]);
    // The dark scheme's :root is the dark theme, through @theme's var()s
    // too; the `not` one is light, so it never reaches dark.
    const dark = [["background", "#0a0a0a"], ["foreground", "#ededed"]];
    for (const source of [undefined, "tailwind"] as const) {
      assert.deepEqual(extractTokens(dir, source).collections[0].tokens.map((t) => [t.name, t.dark?.hex]), dark, String(source));
    }
  } finally { cleanup(dir); }

  // A Tailwind config resolves against the light :root too.
  const v3 = makeProject({
    "tailwind.config.ts": `export default { theme: { extend: { colors: { background: "hsl(var(--background))" } } } }`,
    "app/globals.css": `@layer base {
  :root { --background: 0 0% 100%; }
  @media screen and (prefers-color-scheme: dark) { :root { --background: 0 0% 4%; } }
}`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(v3)), [["colors", [["background", "hsl(0 0% 100%)"]]]]);
    assert.deepEqual(extractTokens(v3).collections[0].tokens[0].dark, { value: "hsl(0 0% 4%)", hex: "#0a0a0a" });
  } finally { cleanup(v3); }
});

test("CSS: the warning naming what @theme declares beyond :root names a few of a palette, not all of it", () => {
  const steps = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
  const dir = makeProject({
    "app/globals.css": `@theme {\n${steps.map((n) => `  --color-brand-${n}: #3b82f6;`).join("\n")}\n}\n:root { --background: #ffffff; }`,
  });
  try {
    assert.deepEqual(extractTokens(dir).warnings, [
      "Not read from @theme, since they aren't built from :root's variables: colors brand/100, brand/200, brand/300, brand/400, brand/500, brand/600 and 4 more. Pass --source tailwind to read @theme instead",
    ]);
  } finally { cleanup(dir); }
});

test("order: tokens are listed as their source declares them, @theme's in its order and :root's in its", () => {
  // shadcn/ui's v4 globals.css declares its @theme colors in the reverse
  // of :root's order; each source keeps its own.
  const dir = makeProject({
    "app/globals.css": `@theme inline {
  --color-card: var(--card);
  --color-background: var(--background);
}
:root {
  --background: #ffffff;
  --card: #000000;
}`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(dir, "tailwind")), [["colors", [["card", "#000000"], ["background", "#ffffff"]]]]);
    assert.deepEqual(tokenTable(extractTokens(dir, "css")), [["colors", [["background", "#ffffff"], ["card", "#000000"]]]]);
  } finally { cleanup(dir); }
});

// --- px ---

test("lengthToPx: px, rem at 16px and calc() over them, and nothing for a value with no fixed length", () => {
  const cases: [string, number | null][] = [
    ["4px", 4], ["0.625rem", 10], ["-0.5rem", -8], ["0", 0], ["9999px", 9999], ["1e3px", 1000], ["1PX", 1],
    ["calc(0.625rem - 4px)", 6], ["calc(0.625rem + 16px)", 26], ["calc(0.25rem * 4)", 16], ["calc(4 * 0.25rem)", 16],
    ["calc((1rem + 2px) * 2)", 36], ["calc(calc(1rem - 2px) / 2)", 7], ["calc(0px - 4px)", -4],
    ["calc( 1rem - 4px )", 12], ["calc(1rem - -4px)", 20], ["calc(2*4px)", 8], ["CALC(1REM / 2)", 8],
    // Rounded, so binary noise doesn't make a mismatch.
    ["0.1rem", 1.6],
    // Relative to the element, or no length at all.
    ["1em", null], ["-0.025em", null], ["50%", null], ["100vw", null], ["min(1rem, 4px)", null],
    ["700", null], ["1.375", null], ["ui-sans-serif, system-ui", null], ["auto", null], ["", null],
    // Not CSS: a length and a number don't add, lengths don't multiply, and nothing divides by a length or 0.
    ["calc(1rem + 2)", null], ["calc(1px * 2px)", null], ["calc(4px / 1px)", null], ["calc(4px / 0)", null],
    ["1rem / 1.5rem", null], ["1rem 2rem", null], ["calc(1rem", null], ["calc(1rem) + 2px", null],
    // Not CSS either, though it reads as sums: arithmetic outside calc(), + or
    // - with no space on each side, which CSS reads as one dimension or two
    // values, and a unitless 0 in calc(), which is a number there.
    ["1rem/2", null], ["(4px)", null], ["4px + 2px", null],
    ["calc(1rem-4px)", null], ["calc(4px+2px)", null], ["calc(1rem -4px)", null], ["calc(1rem- 4px)", null],
    ["calc(0 + 4px)", null], ["calc(0 - 4px)", null], ["calc(0)", null],
    ["var(--radius)", null], ["calc(var(--radius) - 4px)", null],
  ];
  for (const [value, px] of cases) assert.equal(lengthToPx(value), px, value);
});

test("px: radius, spacing and font-size tokens carry their px; weights, ratios, em, fonts, shadows and colors don't", () => {
  // The skill had the agent convert rem itself, and calc() not at all.
  const dir = makeProject({
    "src/app.css": `@theme {
  --spacing: 0.25rem;
  --radius-sm: calc(var(--radius-base) - 4px);
  --radius-base: 0.625rem;
  --text-sm: 0.875rem;
  --font-weight-bold: 700;
  --leading-snug: 1.375;
  --tracking-tight: -0.025em;
  --font-display: "Satoshi", sans-serif;
  --shadow-soft: 0 2px 8px rgb(0 0 0 / 0.1);
  --color-brand: #3b82f6;
}`,
  });
  try {
    assert.deepEqual(extractTokens(dir).collections.map((c) => [c.category, c.tokens]), [
      ["colors", [{ name: "brand", value: "#3b82f6", hex: "#3b82f6" }]],
      ["spacing", [{ name: "DEFAULT", value: "0.25rem", px: 4 }]],
      ["typography", [
        { name: "text/sm", value: "0.875rem", px: 14 },
        { name: "font/weight/bold", value: "700" },
        { name: "leading/snug", value: "1.375" },
        { name: "tracking/tight", value: "-0.025em" },
        { name: "font/display", value: `"Satoshi", sans-serif` },
      ]],
      ["radius", [{ name: "sm", value: "calc(0.625rem - 4px)", px: 6 }, { name: "base", value: "0.625rem", px: 10 }]],
      ["shadows", [{ name: "soft", value: "0 2px 8px rgb(0 0 0 / 0.1)" }]],
    ]);
  } finally { cleanup(dir); }
});

test("px: a Tailwind config's radius built on :root's --radius, as shadcn/ui v3 writes it, carries px", () => {
  const dir = makeProject({
    "tailwind.config.ts": `export default { theme: { extend: { borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" } } } }`,
    "app/globals.css": `@layer base { :root { --background: 0 0% 100%; --radius: 0.5rem; } }`,
  });
  try {
    const radius = extractTokens(dir).collections.find((c) => c.category === "radius");
    assert.deepEqual(radius?.tokens.map((t) => [t.name, t.value, t.px]), [
      ["lg", "0.5rem", 8],
      ["md", "calc(0.5rem - 2px)", 6],
      ["sm", "calc(0.5rem - 4px)", 4],
    ]);
  } finally { cleanup(dir); }
});

test("px: a :root value that holds a var() gets the px of what it resolves to, its value kept as written", () => {
  // --check compares the value, so resolving it would be drift on every
  // baseline that has it.
  const dir = makeProject({ "styles.css": `:root { --radius: 0.5rem; --radius-sm: calc(var(--radius) - 2px); }` });
  try {
    const radius = extractTokens(dir).collections.find((c) => c.category === "radius");
    assert.deepEqual(radius?.tokens, [
      { name: "DEFAULT", value: "0.5rem", px: 8 },
      { name: "radius/sm", value: "calc(var(--radius) - 2px)", px: 6 },
    ]);
  } finally { cleanup(dir); }
});

test("px: --check compares the value, so a baseline written before px checks clean", () => {
  const dir = makeProject({ "src/app.css": `@theme { --radius-sm: calc(0.625rem - 4px); --spacing: 0.25rem; }` });
  try {
    const current = extractTokens(dir);
    assert.ok(current.collections.every((c) => c.tokens.every((t) => t.px !== undefined)));
    const old = baselineOf({ ...current, collections: current.collections.map((c) => ({ ...c, tokens: c.tokens.map(({ name, value }) => ({ name, value })) })) });
    assert.equal(hasDrift(compareTokens(old, current)), false);
    const shifted = baselineOf({ ...current, collections: current.collections.map((c) => ({ ...c, tokens: c.tokens.map((t) => ({ ...t, px: 99 })) })) });
    assert.equal(hasDrift(compareTokens(shifted, current)), false);
  } finally { cleanup(dir); }
});

// --- Unresolved var() ---

test("unresolved: a token whose var() didn't resolve is named in a warning, saying why", () => {
  // shadcn/ui's @theme inline sets --font-sans to itself, and next/font sets
  // --font-geist-mono at runtime. Both were listed as ordinary tokens, and
  // the push took `var(--font-sans)` for a font family.
  const theme = makeProject({
    "app/globals.css": `@theme inline {
  --font-sans: var(--font-sans);
  --font-mono: var(--font-geist-mono);
  --radius-card: calc(var(--radius) + 2px);
  --color-brand: #3b82f6;
}`,
  });
  try {
    const result = extractTokens(theme);
    assert.deepEqual(result.warnings, [
      "Unresolved: typography font/sans = var(--font-sans) (--font-sans is set only in terms of itself)",
      "Unresolved: typography font/mono = var(--font-geist-mono) (--font-geist-mono isn't set in :root or @theme)",
      "Unresolved: radius card = calc(var(--radius) + 2px) (--radius isn't set in :root or @theme)",
    ]);
    // Kept as written, with no px to guess at.
    assert.deepEqual(result.collections.find((c) => c.category === "radius")?.tokens, [{ name: "card", value: "calc(var(--radius) + 2px)" }]);
  } finally { cleanup(theme); }

  const config = makeProject({ "tailwind.config.ts": `export default { theme: { extend: { colors: { brand: "hsl(var(--brand))", plain: "#ffffff" } } } }` });
  try {
    assert.deepEqual(extractTokens(config).warnings, [
      "Unresolved: colors brand = hsl(var(--brand)) (--brand isn't set in :root)",
    ]);
  } finally { cleanup(config); }
});

test("unresolved: the warning tells a loop from a variable set only in terms of itself, and says where it looked", () => {
  // Read after resolution, a loop of two looked like each set to itself.
  const css = makeProject({
    "styles.css": `:root {
  --font-a: var(--font-b);
  --font-b: var(--font-a);
  --font-c: var(--font-c);
  --font-d: calc(var(--font-d) + 1px);
  --font-e: var(--font-runtime);
  --font-f: var(--font-unset, var(--font-runtime));
  --font-g: var(--font-unset, Inter);
}`,
  });
  try {
    assert.deepEqual(extractTokens(css, "css").warnings, [
      "Unresolved: typography font/a = var(--font-a) (--font-a is in a loop of var() references)",
      "Unresolved: typography font/b = var(--font-a) (--font-a is in a loop of var() references)",
      "Unresolved: typography font/c = var(--font-c) (--font-c is set only in terms of itself)",
      "Unresolved: typography font/d = calc(var(--font-d) + 1px) (--font-d is set in terms of itself)",
      "Unresolved: typography font/e = var(--font-runtime) (--font-runtime isn't set in :root)",
      // A fallback that doesn't resolve either: both are named.
      "Unresolved: typography font/f = var(--font-unset, var(--font-runtime)) (--font-unset isn't set in :root; --font-runtime isn't set in :root)",
    ]);
  } finally { cleanup(css); }

  // A theme file's tokens aren't resolved against any stylesheet.
  const theme = makeProject({ "src/theme.ts": `export const colors = { brand: "var(--brand)" };` });
  try {
    assert.deepEqual(extractTokens(theme, "theme").warnings, [
      "Unresolved: colors brand = var(--brand) (--brand isn't set in the theme file)",
    ]);
  } finally { cleanup(theme); }
});

// --- :root in a selector list ---

/** As tokens --json writes it, which leaves out a Tailwind token's undefined group. */
function asJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("Tailwind: :root's variables are read from a selector list such as `:root, .light` in @layer base, and a theme class's aren't", () => {
  // coder's index.css declares its palette as `:root, .light { ... }`, with
  // .dark and colorblind classes after it. Only a `:root {` was read, and
  // its one held a scroll setting, so none of its 55 colors had a hex.
  const dir = makeProject({
    "tailwind.config.js": `module.exports = {
  darkMode: ["selector"],
  theme: {
    extend: {
      fontSize: {
        tiny: ["0.6875rem", "1rem"],
        body: ["0.9375rem", { lineHeight: "1.4rem", fontWeight: "450" }],
      },
      borderRadius: { lg: "var(--corner)", md: "calc(var(--corner) - 3px)" },
      colors: {
        ink: { strong: "hsl(var(--ink-strong))", soft: "hsl(var(--ink-soft))" },
        paper: { base: "hsl(var(--paper-base))", raised: { top: "hsl(var(--paper-raised-top))" } },
        accent: "hsl(var(--accent))",
        scrim: "hsla(var(--scrim))",
      },
    },
  },
  plugins: [],
};`,
    "src/main.css": `@layer base {
  :root,
  .theme-day {
    --ink-strong: 220 20% 12%;
    --ink-soft: 220 10% 40%;
    --paper-base: 0 0% 100%;
    --paper-raised-top: 40 30% 97%;
    --link-blue: 210 90% 45%;
    --accent: var(--link-blue);
    --scrim: 220 20% 12% / 60%;
    --corner: 0.625rem;
  }
  .theme-night {
    --ink-strong: 0 0% 98%;
    --paper-base: 220 20% 8%;
  }
  .theme-day-deuteranopia {
    --link-blue: 30 90% 45%;
  }
}

@layer base {
  :root { scroll-behavior: smooth; }
}
`,
  });
  try {
    const result = extractTokens(dir);
    const hex = (v: string) => tokenColorToHex(v);
    assert.deepEqual(asJson(result.collections.map((c) => [c.category, c.tokens])), [
      ["colors", [
        { name: "ink/strong", value: "hsl(220 20% 12%)", group: "ink", hex: hex("hsl(220 20% 12%)") },
        { name: "ink/soft", value: "hsl(220 10% 40%)", group: "ink", hex: hex("hsl(220 10% 40%)") },
        { name: "paper/base", value: "hsl(0 0% 100%)", group: "paper", hex: "#ffffff" },
        { name: "paper/raised/top", value: "hsl(40 30% 97%)", group: "paper/raised", hex: hex("hsl(40 30% 97%)") },
        // A var() chain resolves to the default theme's value.
        { name: "accent", value: "hsl(210 90% 45%)", hex: hex("hsl(210 90% 45%)") },
        { name: "scrim", value: "hsla(220 20% 12% / 60%)", hex: hex("hsla(220 20% 12% / 60%)") },
      ]],
      ["radius", [{ name: "lg", value: "0.625rem", px: 10 }, { name: "md", value: "calc(0.625rem - 3px)", px: 7 }]],
      ["typography", [{ name: "tiny", value: "0.6875rem", px: 11 }, { name: "body", value: "0.9375rem", px: 15 }]],
    ]);
    assert.ok(!result.warnings.some((w) => w.startsWith("Unresolved:")), result.warnings.join("\n"));

    // CSS mode reads the same list, and not the theme classes.
    const css = new Map(extractTokens(dir, "css").collections.flatMap((c) => c.tokens.map((t) => [t.name, t.value])));
    assert.equal(css.get("ink/strong"), "220 20% 12%");
    assert.equal(css.get("paper/base"), "0 0% 100%");
    assert.equal(css.get("accent"), "210 90% 45%");
  } finally { cleanup(dir); }
});

test("CSS: a rule counts when its selector list holds a bare :root, not when it scopes :root to a theme, nests in one, or is the dark scheme's", () => {
  // valbuild/val declares its palette under `:host, :root, *[data-mode="light"]`.
  const dir = makeProject({
    "src/theme.css": `:host, :root, *[data-mode="light"] {
  --color-surface: #fafafa;
  --color-text: #111111;
}
:root { --color-text: #222222; }
[data-mode="dark"]:root { --color-surface: #000001; }
:root[data-theme="dark"] { --color-surface: #000002; }
.dark, [data-mode="dark"] { --color-surface: #000003; }
:root {
  &.dark { --color-surface: #000004; }
  @media (prefers-color-scheme: dark) { --color-text: #000005; }
  @media (min-width: 40rem) { --color-accent: #3355ff; }
}
.quote::before { content: "}"; }
:root { --color-border: #dddddd; }
`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(dir, "css")), [
      ["colors", [["color/surface", "#fafafa"], ["color/text", "#222222"], ["color/accent", "#3355ff"], ["color/border", "#dddddd"]]],
    ]);
  } finally { cleanup(dir); }
});

test("CSS: html:root, *:root and :root:root are :root, as earlier versions read them, and html alone isn't", () => {
  const alone = makeProject({ "src/app.css": `html:root { --color-ink: #111111; --radius: 4px; }` });
  try {
    assert.deepEqual(detectTokenSource(alone), { type: "css", path: join(alone, "src", "app.css") });
    assert.deepEqual(tokenTable(extractTokens(alone)), [["colors", [["color/ink", "#111111"]]], ["radius", [["DEFAULT", "4px"]]]]);
  } finally { cleanup(alone); }

  const mixed = makeProject({
    "src/app.css": `:root { --color-paper: #ffffff; }
HTML:root { --color-ink: #111111; }
html { --color-rule: #222222; }
*:root, .light { --color-link: #0000ee; }
:root:root { --color-mark: #ffff00; }`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(mixed, "css")), [
      ["colors", [["color/paper", "#ffffff"], ["color/ink", "#111111"], ["color/link", "#0000ee"], ["color/mark", "#ffff00"]]],
    ]);
  } finally { cleanup(mixed); }
});

test("CSS: Tailwind v4's compiled :root, :host theme in a build is not the project's :root", () => {
  // A Storybook build, or Tailwind CLI output, holds Tailwind's default
  // theme in `@layer theme { :root, :host { } }`, in a folder storysync
  // walks: read as :root, Tailwind's red-500 and font-sans became tokens.
  const globals = `@import "tailwindcss";
:root { --radius: 0.625rem; --background: oklch(1 0 0); }
@theme inline { --color-background: var(--background); --radius-sm: calc(var(--radius) - 4px); }`;
  const compiled = `@layer properties;
@layer theme, base, components, utilities;
@layer theme {
  :root, :host {
    --font-sans: ui-sans-serif, system-ui, sans-serif;
    --color-red-500: oklch(63.7% 0.237 25.331);
    --spacing: 0.25rem;
    --text-sm: 0.875rem;
  }
}
@layer base {
  html, :host { line-height: 1.5; }
}
:root { --radius: 0.625rem; --background: oklch(1 0 0); }
@layer properties {
  @supports (-webkit-hyphens: none) {
    :root, :host { --glow: #ff00ff; }
    *, ::before, ::after { --tw-border-style: solid; }
  }
}`;
  const minified = compiled.replace(/\s*\n\s*/g, "").replace(/, /g, ",").replace(/ \{/g, "{");
  const plain = makeProject({ "app/globals.css": globals });
  try {
    const expected = extractTokens(plain);
    assert.deepEqual(tokenTable(expected), [
      ["colors", [["background", "oklch(1 0 0)"]]],
      ["radius", [["DEFAULT", "0.625rem"], ["sm", "calc(0.625rem - 4px)"]]],
    ]);
    for (const [path, css] of [["storybook-static/assets/iframe-abc.css", compiled], ["src/output.css", minified]]) {
      const built = makeProject({ "app/globals.css": globals, [path]: css });
      try {
        assert.deepEqual(tokenTable(extractTokens(built)), tokenTable(expected), path);
        assert.deepEqual(tokenTable(extractTokens(built, "css")), tokenTable(expected), path);
      } finally { cleanup(built); }
    }
  } finally { cleanup(plain); }

  // A :root, :host list a project writes itself, outside those layers, is read.
  const own = makeProject({ "src/app.css": `:root, :host { --color-ink: #111111; }\n@layer theme { :root { --color-paper: #ffffff; } }` });
  try {
    assert.deepEqual(tokenTable(extractTokens(own)), [["colors", [["color/ink", "#111111"], ["color/paper", "#ffffff"]]]]);
  } finally { cleanup(own); }
});

test("CSS: a .min.css is read as earlier versions read it, without its selector lists, and a Storybook build not at all", () => {
  // A vendored kit is minified: its `:root, .light` lists are a package's
  // palette, which no earlier version read. A build bundles the
  // stylesheets of the packages a project imports, and its folder isn't
  // walked, so neither its lists nor its plain `:root` are read.
  const dir = makeProject({
    "src/app.css": `:root { --color-brand: #ff0000; }`,
    "storybook-static/assets/iframe-1.css": `:root, .light, .light-theme { --gray-1: #fcfcfc; }
.light, :root { --color-surface: #fafafa; }
:root { --color-brand: #ff0000; }`,
    "public/vendor/kit.min.css": `:root,[data-kit-theme=light]{--kit-blue:#0d6efd}:root{--color-line:#dddddd}`,
    "src/themes.css": `:root, .light { --color-ink: #111111; }`,
  });
  try {
    for (const source of [undefined, "css"] as const) {
      assert.deepEqual(tokenTable(extractTokens(dir, source)), [
        ["colors", [["color/brand", "#ff0000"], ["color/ink", "#111111"], ["color/line", "#dddddd"]]],
      ]);
    }
  } finally { cleanup(dir); }
});

test("CSS: an escaped quote in a class name, or a bare backtick, hides no :root rule after it", () => {
  // Tailwind compiles `after:content-['']` to the class below. Its \\' was
  // read as the start of a string, which swallowed the rest of the file,
  // the comment included, so the file had no :root at all.
  const dir = makeProject({
    "src/app.css": `.after\\:content-\\[\\'\\'\\]::after { content: ''; }
.say\\"hi { color: red; }
/* Don't read this: :root { --color-old: #999999; } */
:root { --color-ink: #111111; --tick: \`; }
:root, .light { --color-paper: #ffffff; }
:root { --color-link: #0000ee; }
.odd\\{name, :root { --color-mark: #ffff00; }`,
  });
  try {
    assert.deepEqual(detectTokenSource(dir)?.type, "css");
    assert.deepEqual(tokenTable(extractTokens(dir)), [
      ["colors", [["color/ink", "#111111"], ["color/paper", "#ffffff"], ["color/link", "#0000ee"], ["color/mark", "#ffff00"]]],
    ]);
  } finally { cleanup(dir); }
});

test("detectTokenSource: a stylesheet whose :root is only in a selector list is CSS, after @theme and a theme file", () => {
  // `.light, :root {` was read already, as it ends in `:root {`.
  const listed = `:root, .light { --color-brand: #ff0000; }`;
  const alone = makeProject({ "src/vars.css": listed });
  try {
    assert.deepEqual(detectTokenSource(alone), { type: "css", path: join(alone, "src", "vars.css") });
    assert.deepEqual(tokenTable(extractTokens(alone)), [["colors", [["color/brand", "#ff0000"]]]]);
  } finally { cleanup(alone); }

  // storysync read no such list before, so a project with @theme or a theme
  // file keeps the source, and the baseline, it had.
  const v4 = makeProject({ "src/app.css": `@theme { --color-brand: #0000ff; }`, "src/vars.css": listed });
  try {
    assert.equal(detectTokenSource(v4)?.type, "tailwind");
    assert.deepEqual(tokenTable(extractTokens(v4)), [["colors", [["brand", "#0000ff"]]]]);
  } finally { cleanup(v4); }
  const themed = makeProject({ "src/tokens.ts": `export const colors = { brand: "#00ff00" };`, "src/vars.css": listed });
  try {
    assert.equal(detectTokenSource(themed)?.type, "theme");
  } finally { cleanup(themed); }
});

// --- var() fallbacks ---

test("resolveTailwindCssRefs: a fallback holding parentheses is read whole, leaving no stray )", () => {
  // quary's `--border: var(--vscode-input-border, hsl(...))` came out as
  // `#cecece)` once --vscode-input-border resolved, and had no hex.
  const vars = new Map([["--line", "#cccccc"], ["--thin", "1px"]]);
  assert.equal(resolveTailwindCssRefs("var(--line, hsl(0 0% 80%))", vars), "#cccccc");
  assert.equal(resolveTailwindCssRefs("var(--line, var(--thin))", vars), "#cccccc");
  assert.equal(resolveTailwindCssRefs("var(--missing, hsl(0 0% 80%))", vars), "hsl(0 0% 80%)");
  assert.equal(resolveTailwindCssRefs("var(--missing, var(--line))", vars), "#cccccc");
  assert.equal(resolveTailwindCssRefs("var(--missing, var(--gone, rgb(1 2 3)))", vars), "rgb(1 2 3)");
  assert.equal(resolveTailwindCssRefs("0 0 0 var(--thin, calc(1px + 1px)) var(--line)", vars), "0 0 0 1px #cccccc");
  assert.equal(resolveTailwindCssRefs("var(--missing)", vars), "var(--missing)");
});

test("Tailwind: a var() with an empty fallback and nothing set stays as written, with its warning", () => {
  assert.equal(resolveTailwindCssRefs("var(--missing,)", new Map()), "var(--missing,)");
  assert.equal(resolveTailwindCssRefs("var(--missing, )", new Map()), "var(--missing, )");
  assert.equal(resolveTailwindCssRefs("var(--set,)", new Map([["--set", "#123456"]])), "#123456");
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { colors: { haze: "var(--haze,)", ink: "var(--ink)" } } } }`,
    "src/app.css": `:root { --ink: #111111; }`,
  });
  try {
    const result = extractTokens(dir);
    assert.deepEqual(tokenTable(result), [["colors", [["haze", "var(--haze,)"], ["ink", "#111111"]]]]);
    assert.ok(result.warnings.includes("Unresolved: colors haze = var(--haze,) (--haze isn't set in :root)"), result.warnings.join("\n"));
  } finally { cleanup(dir); }
});

test("Tailwind and CSS: a var() whose fallback holds parentheses resolves, so the color gets its hex", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { colors: { edge: "var(--edge)" } } } }`,
    "src/app.css": `:root {
  --vendor-edge: #c0c0c0;
  --edge: var(--vendor-edge, hsl(0 0% 80%));
  --color-rule: var(--vendor-edge, rgb(0 0 0));
}`,
  });
  try {
    assert.deepEqual(asJson(extractTokens(dir).collections[0].tokens), [{ name: "edge", value: "#c0c0c0", hex: "#c0c0c0" }]);
    // CSS mode keeps a value with a var() as written, and gives its hex.
    const rule = extractTokens(dir, "css").collections[0].tokens.find((t) => t.name === "color/rule");
    assert.deepEqual(rule, { name: "color/rule", value: "var(--vendor-edge, rgb(0 0 0))", hex: "#c0c0c0" });
  } finally { cleanup(dir); }
});

// --- Template literals ---

test("Tailwind: a template literal is read as a string, and one with ${...} is skipped with a warning naming the token", () => {
  // langflow and ever-teams write their radius scale in backticks, which
  // were kept in the value, so it had no px.
  const dir = makeProject({
    "tailwind.config.mjs": `const base = 4;
export default {
  theme: {
    extend: {
      borderRadius: { lg: \`var(--corner)\`, md: \`calc(var(--corner) - 2px)\`, xl: \`\${base * 3}px\` },
      fontSize: { lead: [\`1.125rem\`, { lineHeight: "1.6" }], huge: \`\${base}rem\` },
      colors: { brand: \`#0f62fe\`, tint: \`\${"#0f62fe"}33\` },
    },
  },
};`,
    "src/app.css": `:root { --corner: 0.75rem; }`,
  });
  try {
    const result = extractTokens(dir);
    assert.deepEqual(asJson(result.collections.map((c) => [c.category, c.tokens])), [
      ["colors", [{ name: "brand", value: "#0f62fe", hex: "#0f62fe" }]],
      ["radius", [{ name: "lg", value: "0.75rem", px: 12 }, { name: "md", value: "calc(0.75rem - 2px)", px: 10 }]],
      ["typography", [{ name: "lead", value: "1.125rem", px: 18 }]],
    ]);
    for (const warning of [
      "Skipped dynamic value: colors tint = `${\"#0f62fe\"}33`",
      "Skipped dynamic value: borderRadius xl = `${base * 3}px`",
      "Skipped dynamic value: fontSize huge = `${base}rem`",
    ]) assert.ok(result.warnings.includes(warning), `${warning}\n${result.warnings.join("\n")}`);
  } finally { cleanup(dir); }
});

// --- Tailwind config file names ---

test("detectTokenSource: finds tailwind.config.mts and .cts after every source earlier versions found, and names one passed over", () => {
  // edu-design-system's config is tailwind.config.mts, which wasn't found.
  const config = `export default { theme: { extend: { colors: { brand: "#ff0000" } } } }`;
  for (const name of ["tailwind.config.mts", "tailwind.config.cts"]) {
    const alone = makeProject({ [name]: config });
    try {
      assert.deepEqual(detectTokenSource(alone), { type: "tailwind", path: join(alone, name) });
      const result = extractTokens(alone);
      assert.deepEqual(tokenTable(result), [["colors", [["brand", "#ff0000"]]]]);
      assert.deepEqual(result.warnings, []);
    } finally { cleanup(alone); }

    // A project that has a source an earlier version read keeps it, and
    // its baseline, and is told of the config. --source tailwind reads it.
    const earlier: [Record<string, string>, string, string][] = [
      [{ "src/app.css": `:root { --color-brand: #000000; }` }, "css", "src/app.css"],
      [{ "src/app.css": `@theme { --color-brand: #0000ff; }` }, "tailwind", "src/app.css"],
      [{ "src/tokens.ts": `export const colors = { brand: "#00ff00" };` }, "theme", "src/tokens.ts"],
    ];
    for (const [files, type, path] of earlier) {
      const dir = makeProject({ [name]: config, ...files });
      try {
        assert.deepEqual(detectTokenSource(dir), { type, path: join(dir, path) });
        assert.ok(extractTokens(dir).warnings.includes(
          `Read ${join(dir, path)}, as earlier versions of storysync did, rather than ${join(dir, name)}, which they didn't find. Pass --source tailwind to read the config`,
        ));
        assert.deepEqual(tokenTable(extractTokens(dir, "tailwind")), [["colors", [["brand", "#ff0000"]]]]);
      } finally { cleanup(dir); }
    }

    // One ahead of a stylesheet no earlier version read.
    const listed = makeProject({ [name]: config, "src/app.css": `:root, .light { --color-brand: #000000; }` });
    try {
      assert.deepEqual(detectTokenSource(listed), { type: "tailwind", path: join(listed, name) });
    } finally { cleanup(listed); }
  }

  const both = makeProject({
    "tailwind.config.mts": `export default { theme: { extend: { colors: { brand: "#ff0000" } } } }`,
    "tailwind.config.ts": `export default { theme: { extend: { colors: { brand: "#00ff00" } } } }`,
  });
  try {
    assert.equal(detectTokenSource(both)?.path, join(both, "tailwind.config.ts"));
    assert.equal(extractTokens(both, "tailwind").sourcePath, join(both, "tailwind.config.ts"));
  } finally { cleanup(both); }
});

// --- Presets, re-exports and wrappers ---

test("Tailwind: a preset in a relative file is read as the config is, and the config wins a name they share", () => {
  // sameera/quantum's config is only `presets: [require("./tailwind.preset.js")]`,
  // which read as no tokens at all.
  const dir = makeProject({
    "tailwind.config.js": `module.exports = {
  presets: [require("./config/brand-preset")],
  content: ["./src/**/*.tsx"],
  theme: { extend: { colors: { accent: "#ff5500" } } },
};`,
    "config/brand-preset.js": `module.exports = {
  theme: {
    extend: {
      colors: { accent: "#0055ff", surface: "hsl(var(--surface))" },
      borderRadius: { card: "var(--card-radius)" },
    },
  },
};`,
    "src/app.css": `:root { --surface: 0 0% 98%; --card-radius: 12px; }`,
  });
  try {
    const result = extractTokens(dir);
    assert.deepEqual(tokenTable(result), [
      ["colors", [["surface", "hsl(0 0% 98%)"], ["accent", "#ff5500"]]],
      ["radius", [["card", "12px"]]],
    ]);
    assert.ok(!result.warnings.some((w) => w.includes("statically") || w.includes("Unresolved")), result.warnings.join("\n"));
  } finally { cleanup(dir); }
});

test("Tailwind: a config's theme key replaces a preset's, and every extend adds to it, as Tailwind merges them", () => {
  const preset = `module.exports = {
  theme: {
    colors: { canvas: "#aaaaaa", line: "#000000" },
    extend: { spacing: { gutter: "1rem" }, colors: { glow: "#ff00ff" } },
  },
};`;
  const cases: [string, string[][]][] = [
    // theme.colors replaces the preset's theme.colors, but its extend stays.
    [`theme: { colors: { ink: "#111111" } }`, [["ink", "#111111"], ["glow", "#ff00ff"]]],
    // theme.extend.colors adds to them, and wins a name.
    [`theme: { extend: { colors: { ink: "#111111", line: "#222222" } } }`, [["canvas", "#aaaaaa"], ["glow", "#ff00ff"], ["ink", "#111111"], ["line", "#222222"]]],
    // Both: the config's theme.colors, then each extend on top.
    [`theme: { colors: { ink: "#111111" }, extend: { colors: { mark: "#ffff00" } } }`, [["ink", "#111111"], ["glow", "#ff00ff"], ["mark", "#ffff00"]]],
  ];
  for (const [theme, colors] of cases) {
    const dir = makeProject({
      "tailwind.config.js": `module.exports = { presets: [require("./preset.js")], ${theme} };`,
      "preset.js": preset,
    });
    try {
      assert.deepEqual(tokenTable(extractTokens(dir)), [["colors", colors], ["spacing", [["gutter", "1rem"]]]], theme);
    } finally { cleanup(dir); }
  }

  // A later preset's theme key replaces an earlier one's.
  const two = makeProject({
    "tailwind.config.js": `module.exports = { presets: [require("./preset.js"), require("./later.js")] };`,
    "preset.js": preset,
    "later.js": `module.exports = { theme: { colors: { paper: "#ffffff" } } };`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(two)), [["colors", [["paper", "#ffffff"], ["glow", "#ff00ff"]]], ["spacing", [["gutter", "1rem"]]]]);
  } finally { cleanup(two); }
});

test("Tailwind: a preset declared above the config in its own file leaves the config's theme its own", () => {
  // JavaScript runs a preset declared in the file only above the config,
  // where its theme was the first in the file, read as the config's.
  const dir = makeProject({
    "tailwind.config.js": `const base = {
  theme: { extend: { colors: { canvas: "#aaaaaa", line: "#000000" } } },
};

module.exports = {
  presets: [base],
  content: [],
  theme: { extend: { colors: { ink: "#bbbbbb", line: "#111111" } } },
};`,
  });
  try {
    const result = extractTokens(dir);
    assert.deepEqual(tokenTable(result), [["colors", [["canvas", "#aaaaaa"], ["ink", "#bbbbbb"], ["line", "#111111"]]]]);
    assert.ok(!result.warnings.some((w) => w.includes("statically")), result.warnings.join("\n"));
  } finally { cleanup(dir); }

  // Through a const, as a typed config is exported.
  const typed = makeProject({
    "tailwind.config.ts": `const base = { theme: { colors: { canvas: "#aaaaaa" } } };
const config: Config = { presets: [base], theme: { extend: { spacing: { gutter: "1rem" } } } };
export default config;`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(typed)), [["colors", [["canvas", "#aaaaaa"]]], ["spacing", [["gutter", "1rem"]]]]);
  } finally { cleanup(typed); }

  // With no theme of the config's own, the local preset's is the first in
  // the file, but it is still a preset: a later one's theme.colors wins.
  const ranked = makeProject({
    "tailwind.config.js": `const base = { theme: { colors: { canvas: "#aaaaaa" }, extend: { spacing: { gutter: "1rem" } } } };
module.exports = { presets: [base, require("./brand.js")], content: [] };`,
    "brand.js": `module.exports = { theme: { colors: { ink: "#111111" } } };`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(ranked)), [["colors", [["ink", "#111111"]]], ["spacing", [["gutter", "1rem"]]]]);
  } finally { cleanup(ranked); }
});

test("Tailwind: a preset imported by name from a TypeScript file is that export, not another in the file", () => {
  const dir = makeProject({
    "tailwind.config.ts": `import type { Config } from "tailwindcss";
import { studioPreset } from "./src/theme/preset";

export default { presets: [studioPreset], content: [] } satisfies Config;`,
    "src/theme/preset.ts": `import type { Config } from "tailwindcss";

export const unrelated = { theme: { colors: { wrong: "#000000" } } };

export const studioPreset = {
  theme: { extend: { spacing: { gutter: "1.5rem" }, colors: { brand: { 500: "#7c3aed" } } } },
} satisfies Partial<Config>;`,
  });
  try {
    assert.deepEqual(asJson(extractTokens(dir).collections.map((c) => [c.category, c.tokens])), [
      ["colors", [{ name: "brand/500", value: "#7c3aed", group: "brand", hex: "#7c3aed" }]],
      ["spacing", [{ name: "gutter", value: "1.5rem", px: 24 }]],
    ]);
  } finally { cleanup(dir); }
});

test("Tailwind: a preset storysync can't read is named in a warning, never read as silently empty", () => {
  // zenkigen's and medusa's presets are packages, and Sundsvall's is built
  // by preset(): each gave no tokens and no warning.
  const dir = makeProject({
    "tailwind.config.js": `import shared from "@acme/tailwind-config";
import makePreset from "./preset-factory";
const legacy = require("@acme/legacy-preset");

module.exports = {
  presets: [shared, makePreset({ dense: true }), legacy, require("./missing-preset")],
  content: [],
};`,
    "preset-factory.js": `export default function makePreset() { return { theme: {} }; }`,
  });
  const config = join(dir, "tailwind.config.js");
  try {
    const result = extractTokens(dir);
    assert.deepEqual(result.collections, []);
    assert.deepEqual(result.warnings.filter((w) => w.startsWith(config)), [
      `${config} takes the preset shared, from the package @acme/tailwind-config, which storysync can't read statically, so the tokens it declares are missing`,
      `${config} takes the preset makePreset(), from ./preset-factory, built by a function call, which storysync can't read statically, so the tokens it declares are missing`,
      `${config} takes the preset legacy, from the package @acme/legacy-preset, which storysync can't read statically, so the tokens it declares are missing`,
      `${config} takes the preset require("./missing-preset"), but storysync can't find ./missing-preset, so the tokens it declares are missing`,
    ]);
  } finally { cleanup(dir); }

  // A preset's own presets are named, not followed.
  const nested = makeProject({
    "tailwind.config.cjs": `module.exports = { presets: [require("./base.cjs")] };`,
    "base.cjs": `module.exports = { presets: [require("./deeper.cjs")], theme: { extend: { colors: { brand: "#123456" } } } };`,
  });
  try {
    const result = extractTokens(nested);
    assert.deepEqual(tokenTable(result), [["colors", [["brand", "#123456"]]]]);
    assert.ok(result.warnings.includes(`${join(nested, "base.cjs")} takes presets of its own, require("./deeper.cjs"), which storysync doesn't follow, so the tokens they declare are missing`), result.warnings.join("\n"));
  } finally { cleanup(nested); }
});

test("Tailwind: a config that re-exports another is read through it when it is relative, and a wrapper is named", () => {
  const relative = makeProject({
    "tailwind.config.js": `module.exports = require("./tailwind.base.cjs");`,
    "tailwind.base.cjs": `module.exports = { theme: { extend: { colors: { brand: "#123456" } } } };`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(relative)), [["colors", [["brand", "#123456"]]]]);
  } finally { cleanup(relative); }

  const cases: [Record<string, string>, (config: string) => string][] = [
    // snowball-tech's config is this one line.
    [{ "tailwind.config.ts": `export { default } from "@acme/design-tokens/tailwind";` },
      (config) => `${config} re-exports its config from @acme/design-tokens/tailwind, a package, which storysync can't read statically, so the tokens it declares are missing`],
    // The theme passed to a wrapper is read; what the wrapper adds isn't.
    [{ "tailwind.config.js": `module.exports = withBrand({ content: [], theme: { extend: { colors: { brand: "#123456" } } } });` },
      (config) => `${config} passes its config through withBrand(), which storysync can't read statically: the theme passed to it is read, but any tokens the function adds are missing`],
    [{ "tailwind.config.js": `const config = withBrand(base);\nmodule.exports = config;` },
      (config) => `${config} builds its config with withBrand(), which storysync can't read statically, so the tokens it adds are missing`],
    // A wrapper passed no theme gives every token.
    [{ "tailwind.config.js": `module.exports = withBrand({ content: [], plugins: [] });` },
      (config) => `${config} builds its config with withBrand(), which storysync can't read statically, so the tokens it adds are missing`],
    [{ "tailwind.config.js": `const config = require("@acme/ui/tailwind")("docs");\nconfig.content = [];\nmodule.exports = config;` },
      (config) => `${config} builds its config with require("@acme/ui/tailwind")(), which storysync can't read statically, so the tokens it adds are missing`],
  ];
  for (const [files, warning] of cases) {
    const dir = makeProject(files);
    try {
      const result = extractTokens(dir);
      const expected = warning(join(dir, Object.keys(files)[0]));
      assert.ok(result.warnings.includes(expected), `${expected}\n${result.warnings.join("\n")}`);
    } finally { cleanup(dir); }
  }
});

test("Tailwind: a config spread in at the top of the exported one is read when relative, and named when not", () => {
  // A monorepo app's config is often its shared config spread in, with
  // its own content globs: that read as empty, and the warning blamed
  // Tailwind's default theme.
  const base = `module.exports = { theme: { extend: { colors: { brand: "#123456" } } } };`;
  const required = makeProject({
    "apps/web/tailwind.config.js": `module.exports = { ...require("../../packages/ui/tailwind.base.js"), content: ["./src/**/*.tsx"] };`,
    "packages/ui/tailwind.base.js": base,
  });
  try {
    const result = extractTokens(join(required, "apps", "web"));
    assert.deepEqual(tokenTable(result), [["colors", [["brand", "#123456"]]]]);
    assert.ok(!result.warnings.some((w) => w.startsWith("Read no colors")), result.warnings.join("\n"));
  } finally { cleanup(required); }

  const imported = makeProject({
    "tailwind.config.ts": `import base from "./tailwind.base";
export default { ...base, content: [] };`,
    "tailwind.base.ts": `export default { theme: { extend: { colors: { brand: "#123456" } } } };`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(imported)), [["colors", [["brand", "#123456"]]]]);
  } finally { cleanup(imported); }

  // A theme after the spread replaces the spread's, as in JavaScript.
  const replaced = makeProject({
    "tailwind.config.js": `const base = require("./tailwind.base.js");
module.exports = { ...base, theme: { extend: { colors: { ink: "#111111" } } } };`,
    "tailwind.base.js": base,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(replaced)), [["colors", [["ink", "#111111"]]]]);
  } finally { cleanup(replaced); }

  const packaged = makeProject({
    "tailwind.config.js": `const shared = require("@acme/tailwind-config");
module.exports = { ...shared, content: [] };`,
  });
  const config = join(packaged, "tailwind.config.js");
  try {
    const result = extractTokens(packaged);
    assert.ok(result.warnings.includes(
      `${config} spreads in shared, from the package @acme/tailwind-config, which storysync can't read statically, so the tokens it declares are missing`,
    ), result.warnings.join("\n"));
    assert.ok(!result.warnings.some((w) => w.startsWith("Read no colors")), result.warnings.join("\n"));
  } finally { cleanup(packaged); }
});

test("Tailwind: a preset built by a call, or required from a path worked out at run time, is named as such", () => {
  const dir = makeProject({
    "tailwind.config.js": `const path = require("path");
function makePreset() { return { theme: {} }; }
module.exports = {
  presets: [makePreset(), require(path.join(__dirname, "preset")), require(\`./\${"preset"}\`)],
  content: [],
};`,
  });
  const config = join(dir, "tailwind.config.js");
  try {
    assert.deepEqual(extractTokens(dir).warnings.filter((w) => w.startsWith(config)), [
      `${config} takes the preset makePreset(), built by a function call, which storysync can't read statically, so the tokens it declares are missing`,
      `${config} takes the preset require(path.join(__dirname, "preset")), whose path is worked out when the config runs, which storysync can't read statically, so the tokens it declares are missing`,
      `${config} takes the preset require(\`./\${"preset"}\`), whose path is worked out when the config runs, which storysync can't read statically, so the tokens it declares are missing`,
    ]);
  } finally { cleanup(dir); }

  // The theme passed to a wrapper such as defineConfig() is read.
  const wrapped = makeProject({
    "tailwind.config.ts": `export default defineConfig({ theme: { extend: { colors: { brand: "#123456" } } } });`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(wrapped)), [["colors", [["brand", "#123456"]]]]);
  } finally { cleanup(wrapped); }
});

test("Tailwind: a config with no theme storysync reads says so, and a theme exported on its own is read", () => {
  const empty = makeProject({ "tailwind.config.js": `module.exports = { content: [], plugins: [require("some-palette-plugin")] };` });
  try {
    assert.ok(extractTokens(empty).warnings.includes(
      `Read no colors, spacing, borderRadius, fontSize or boxShadow from the theme of ${join(empty, "tailwind.config.js")}. Tailwind's default theme isn't read, nor what a plugin adds`,
    ));
  } finally { cleanup(empty); }

  // An ES module config can export its keys one by one.
  const named = makeProject({
    "tailwind.config.js": `export const content = ["./src/**/*.tsx"];
export const theme = { extend: { colors: { brand: "#0f62fe" } } };`,
  });
  try {
    assert.deepEqual(tokenTable(extractTokens(named)), [["colors", [["brand", "#0f62fe"]]]]);
  } finally { cleanup(named); }

  // edu-design-system's theme is `{ ...applyTailwindConfig(edsTokens) }`.
  const spread = makeProject({ "tailwind.config.ts": `export default { theme: { ...buildTheme(tokens) } };` });
  try {
    assert.ok(extractTokens(spread).warnings.includes(
      `The theme in ${join(spread, "tailwind.config.ts")} spreads in buildTheme(tokens), which storysync can't read statically, so the tokens it adds are missing`,
    ));
  } finally { cleanup(spread); }
});

// --- Config warnings ---

test("Tailwind: a plugin's require() doesn't warn that values may be missing, and one elsewhere does", () => {
  // Every shadcn/ui v3 config, and coder's, requires its plugins, so the
  // warning was on nearly every config, where it pointed at nothing missing.
  const plugins = makeProject({
    "tailwind.config.js": `module.exports = {
  theme: { extend: { colors: { brand: "#123456" } } },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
};`,
  });
  try {
    assert.deepEqual(extractTokens(plugins).warnings, []);
  } finally { cleanup(plugins); }

  const palette = makeProject({
    "tailwind.config.js": `const palette = require("./palette");
module.exports = { theme: { extend: { colors: { brand: "#123456" } } } };`,
  });
  try {
    assert.deepEqual(extractTokens(palette).warnings, ["Config uses require() - some values may not be extracted"]);
  } finally { cleanup(palette); }
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
  return { version: 1, source: result.source, sourcePath: result.sourcePath, modes: result.modes, collections: result.collections, generatedAt: FIXED_TIMESTAMP };
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
    "valueless-dark.json": `{"collections":[{"category":"colors","tokens":[{"name":"bg","value":"#fff","dark":{"hex":"#000"}}]}]}`,
  });
  try {
    for (const name of ["empty-collection", "no-tokens", "no-category", "null-collection"]) {
      assert.throws(() => readTokenBaseline(join(dir, `${name}.json`)), /has a collection without a "category" and a "tokens" list, so it is not a baseline$/, name);
    }
    assert.throws(() => readTokenBaseline(join(dir, "unnamed-token.json")), /has a colors token without a "name" and a "value", so it is not a baseline$/);
    assert.throws(() => readTokenBaseline(join(dir, "numeric-value.json")), /has a spacing token without a "name" and a "value"/);
    assert.throws(() => readTokenBaseline(join(dir, "null-token.json")), /has a colors token without/);
    // Compared as a string, a dark value without one crashed the check.
    assert.throws(() => readTokenBaseline(join(dir, "valueless-dark.json")), /has a colors token whose "dark" has no "value", so it is not a baseline$/);
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

test("CSS: each token gets the dark theme's value, from every dark selector, a later one winning, and a light-only project has none", () => {
  // tokens read the light theme alone, and warned of the dark one, so the
  // push made one mode and an audit of shadcn/ui compared half its colors.
  const dir = makeProject({
    "app/globals.css": `@custom-variant dark (&:is(.dark *));
:root { --background: #ffffff; --foreground: #171717; --muted: #f5f5f5; --radius: 0.625rem; }
.dark { --background: #0a0a0a; --foreground: #ededed; }
[data-theme="dark"] { --background: #000000; --ring: #333333; }
.darker { --muted: #111111; }
.dark .card { --muted: #222222; }
:root { &.dark { --radius: 0.5rem; } }
@media (prefers-color-scheme: dark) { :root { --background: #0b0b0b; } }
`,
  });
  try {
    const result = extractTokens(dir);
    assert.deepEqual(result.modes, ["Light", "Dark"]);
    assert.deepEqual(result.collections.map((c) => [c.category, c.tokens.map((t) => [t.name, t.dark])]), [
      ["colors", [
        ["background", { value: "#0b0b0b", hex: "#0b0b0b" }],
        ["foreground", { value: "#ededed", hex: "#ededed" }],
        // .darker is no dark theme, and .dark .card sets a card's.
        ["muted", undefined],
      ]],
      ["radius", [["DEFAULT", { value: "0.5rem", px: 8 }]]],
    ]);
    assert.equal(result.warnings.some((w) => /light theme/i.test(w)), false, result.warnings.join("\n"));
  } finally { cleanup(dir); }

  const light = makeProject({ "app/globals.css": `:root { --background: #ffffff; }\n.card { --inset: 4px; }\n` });
  try {
    const result = extractTokens(light);
    assert.deepEqual(result.modes, ["Light"]);
    assert.equal(result.collections[0].tokens[0].dark, undefined);
  } finally { cleanup(light); }

  // A theme file holds no stylesheet's dark theme.
  const theme = makeProject({ "src/theme.ts": `export const colors = { primary: "#0000ff" };`, "src/app.css": `.dark { --primary: #ffffff; }` });
  try {
    const result = extractTokens(theme, "theme");
    assert.deepEqual([result.modes, result.collections[0].tokens[0].dark], [["Light"], undefined]);
  } finally { cleanup(theme); }
});

test("CSS: a built Storybook's stylesheet, and Tailwind's own --tw- variables, are no dark theme", () => {
  // storybook build writes the stories' compiled CSS to storybook-static,
  // where a dark: utility sets --tw- variables under .dark: neither is the
  // project's dark theme.
  const dir = makeProject({
    "src/globals.css": `:root { --background: #ffffff; --ring: #999999; }\n.dark { --background: #0a0a0a; }\n`,
    "storybook-static/assets/iframe-abc123.css": `:root { --background: #ffffff; }\n.dark { --background: #010101; --ring: #333333; }\n.dark\\:shadow-xs:is(.dark *) { --tw-shadow: 0 1px 2px #0000000d; }\n`,
    "src/compiled.css": `:root { --tw-ring-offset-width: 0px; }\n.dark\\:ring:is(.dark *) { --tw-ring-color: #333333; --ring: #444444; }\n`,
    "out/_next/static/css/app.css": `.dark { --ring: #555555; }\n`,
    "coverage/lcov-report/base.css": `.dark { --ring: #666666; }\n`,
  });
  try {
    const result = extractTokens(dir);
    const colors = result.collections.find((c) => c.category === "colors");
    assert.deepEqual(colors?.tokens.map((t) => [t.name, t.dark?.hex]), [["background", "#0a0a0a"], ["ring", undefined]]);
    assert.equal(JSON.stringify(result).includes("storybook-static"), false, "the built bundle is read as a source");
  } finally { cleanup(dir); }
});

test("Tailwind config: shadcn/ui v3's hsl(var()) colors get .dark's channels, and radius its --radius", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { darkMode: ["class"], theme: { extend: {
  colors: { background: "hsl(var(--background))", primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" } },
  borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)" },
} } };`,
    "app/globals.css": `@tailwind base;
@layer base {
  :root { --background: 0 0% 100%; --primary: 240 5.9% 10%; --primary-foreground: 0 0% 98%; --radius: 0.5rem; }
  .dark { --background: 240 10% 3.9%; --primary: 0 0% 98%; --primary-foreground: 240 5.9% 10%; --radius: 0.75rem; }
}`,
  });
  try {
    const result = extractTokens(dir);
    assert.equal(result.source, "tailwind");
    assert.deepEqual(result.collections.map((c) => [c.category, c.tokens.map((t) => [t.name, t.hex ?? t.px, t.dark?.hex ?? t.dark?.px])]), [
      ["colors", [["background", "#ffffff", "#09090b"], ["primary/DEFAULT", "#18181b", "#fafafa"], ["primary/foreground", "#fafafa", "#18181b"]]],
      ["radius", [["lg", 8, 12], ["md", 6, 10]]],
    ]);
    assert.equal(result.collections[0].tokens[0].dark?.value, "hsl(240 10% 3.9%)");
  } finally { cleanup(dir); }
});

test("drift: a dark value is compared against a baseline that read the dark theme, and an earlier one's is left alone", () => {
  const globals = (bg: string, darkBg: string, darkFg = "#ededed") =>
    `:root { --background: ${bg}; --foreground: #171717; }\n.dark { --background: ${darkBg}; --foreground: ${darkFg}; }\n`;
  const dir = makeProject({ "app/globals.css": globals("#ffffff", "#0a0a0a") });
  try {
    const before = extractTokens(dir);
    const baseline = baselineOf(before);
    assert.equal(hasDrift(compareTokens(baseline, before)), false);

    // A changed dark value is drift on that token's dark theme alone.
    writeFileSync(join(dir, "app/globals.css"), globals("#ffffff", "#000000"));
    const darker = compareTokens(baseline, extractTokens(dir));
    assert.deepEqual(darker.changed, [{ category: "colors", token: "background", from: "#0a0a0a", to: "#000000", mode: "Dark" }]);

    // A dark value that goes, leaving the light one, changed to it.
    writeFileSync(join(dir, "app/globals.css"), globals("#ffffff", "#0a0a0a", "#171717"));
    assert.deepEqual(compareTokens(baseline, extractTokens(dir)).changed, [{ category: "colors", token: "foreground", from: "#ededed", to: "#171717", mode: "Dark" }]);

    // An earlier storysync's baseline has no dark values and no modes: it
    // still checks clean, saying the dark theme wasn't compared.
    const { modes: _modes, ...old } = baseline;
    const oldBaseline = { ...old, collections: before.collections.map((c) => ({ ...c, tokens: c.tokens.map(({ dark: _dark, ...t }) => t) })) };
    const fromOld = compareTokens(oldBaseline, extractTokens(dir));
    assert.deepEqual([hasDrift(fromOld), fromOld.darkNotChecked], [false, true]);
  } finally { cleanup(dir); }

  // A light value that changes, with no dark value on either side, changed once.
  const plain = makeProject({ "app/globals.css": `:root { --background: #ffffff; --muted: #eeeeee; }\n.dark { --background: #0a0a0a; }\n` });
  try {
    const baseline = baselineOf(extractTokens(plain));
    writeFileSync(join(plain, "app/globals.css"), `:root { --background: #ffffff; --muted: #dddddd; }\n.dark { --background: #0a0a0a; }\n`);
    assert.deepEqual(compareTokens(baseline, extractTokens(plain)).changed, [{ category: "colors", token: "muted", from: "#eeeeee", to: "#dddddd" }]);
  } finally { cleanup(plain); }
});

// --- Base styles (figma code's evidence where no class names a token) ---

test("base styles: shadcn/ui's @layer base gives body's text-foreground and *'s border-border and outline-ring, with the rule", () => {
  const dir = makeProject({
    "app/globals.css": `@import "tailwindcss";
:root { --background: oklch(1 0 0); --foreground: oklch(0.145 0 0); --card-foreground: oklch(0.145 0 0); --border: oklch(0.922 0 0); --input: oklch(0.922 0 0); --ring: oklch(0.708 0 0); }
@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}`,
  });
  try {
    assert.deepEqual(extractTokens(dir).defaults, [
      { property: "border-color", token: "border", from: "app/globals.css, @layer base: * { @apply border-border outline-ring/50 }" },
      { property: "outline-color", token: "ring", from: "app/globals.css, @layer base: * { @apply border-border outline-ring/50 }" },
      { property: "color", token: "foreground", from: "app/globals.css, @layer base: body { @apply bg-background text-foreground }" },
    ]);
  } finally { cleanup(dir); }
});

test("base styles: the nearest selector's color wins, a value no token names ends one, and other rules don't count", () => {
  const names = ["foreground", "muted/foreground", "border", "input", "primary", "ring"];
  const dir = makeProject({
    "src/base.css": `body { color: hsl(var(--foreground)); border-color: var(--input); }
html { color: var(--muted-foreground); }
*, ::before, ::after { border-color: var(--color-border); outline-color: var(--ring); }
* { outline: 2px solid transparent; }
.dark body { color: var(--primary); }
@media (prefers-color-scheme: dark) { body { color: var(--primary); } }
@layer components { * { color: var(--primary); } }
body { @apply hover:text-primary; }
:root { --x: 1px; }`,
  });
  try {
    // body hands its color down nearer than html, whatever their order;
    // body's border-color is body's own; the outline shorthand resets it.
    assert.deepEqual(baseDefaults(dir, names), [
      { property: "color", token: "foreground", from: "src/base.css: body { color: hsl(var(--foreground)) }" },
      { property: "border-color", token: "border", from: "src/base.css: *, ::before, ::after { border-color: var(--color-border) }" },
    ]);
    // A later `color: red` on body ends what it set.
    writeFileSync(join(dir, "src/base.css"), "body { color: var(--foreground); }\nbody { color: red; }\n");
    assert.deepEqual(baseDefaults(dir, names), []);
  } finally { cleanup(dir); }
});

test("base styles: stylesheets that set a default to different tokens leave it out; agreeing ones keep it", () => {
  const names = ["foreground", "card/foreground", "border"];
  const dir = makeProject({
    "app/globals.css": "@layer base { body { @apply text-foreground; } * { @apply border-border; } }",
    "src/other.css": "body { color: var(--card-foreground); } * { border-color: var(--border); }",
  });
  try {
    assert.deepEqual(baseDefaults(dir, names).map((d) => [d.property, d.token]), [["border-color", "border"]]);
  } finally { cleanup(dir); }
});

test("radius: a DEFAULT that repeats a step in every mode is left out; one that differs is kept", () => {
  const radius = (tokens: TokenExtractionResult["collections"][number]["tokens"]) => [{ category: "radius" as const, tokens }];
  const names = (c: TokenExtractionResult["collections"]) => c.flatMap((x) => x.tokens.map((t) => t.name));
  assert.deepEqual(names(withoutRepeatedDefault(radius([{ name: "DEFAULT", value: "0.625rem", px: 10 }, { name: "lg", value: "0.625rem", px: 10 }]))), ["lg"]);
  // A baseline from before has no px: the value is worked out.
  assert.deepEqual(names(withoutRepeatedDefault(radius([{ name: "DEFAULT", value: "0.5rem" }, { name: "md", value: "8px" }]))), ["md"]);
  // A Tailwind config's own DEFAULT, the `rounded` step, stays.
  assert.deepEqual(names(withoutRepeatedDefault(radius([{ name: "DEFAULT", value: "0.25rem", px: 4 }, { name: "sm", value: "0.125rem", px: 2 }]))), ["DEFAULT", "sm"]);
  // So does one whose dark value differs.
  assert.deepEqual(names(withoutRepeatedDefault(radius([
    { name: "DEFAULT", value: "0.5rem", px: 8, dark: { value: "0.75rem", px: 12 } }, { name: "lg", value: "0.5rem", px: 8 },
  ]))), ["DEFAULT", "lg"]);
  // Spacing's DEFAULT is a step of its own.
  assert.deepEqual(names(withoutRepeatedDefault([{ category: "spacing", tokens: [{ name: "DEFAULT", value: "4px", px: 4 }, { name: "1", value: "4px", px: 4 }] }])), ["DEFAULT", "1"]);
});
