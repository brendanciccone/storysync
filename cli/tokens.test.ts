// Smoke tests for token extraction.
// Uses Node's built-in test runner with tsx (devDependency) for TypeScript.
// Run: npm test

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { detectTokenSource, extractTokens, compareTokens, hasDrift } from "./tokens.js";
import type { TokenBaseline } from "./tokens.js";

const CLI = join(import.meta.dirname, "index.ts");

function run(...args: string[]): string {
  return execFileSync("tsx", [CLI, ...args], { encoding: "utf8" });
}

// --- Unit tests: token extraction logic ---

describe("detectTokenSource", () => {
  it("finds tailwind config", () => {
    const tmp = join(tmpdir(), `storysync-test-tw-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "tailwind.config.ts"), `export default { theme: { extend: { colors: { brand: "#ff0000" } } } }`);
    try {
      const source = detectTokenSource(tmp);
      assert.equal(source?.type, "tailwind");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("finds CSS custom properties", () => {
    const tmp = join(tmpdir(), `storysync-test-css-${Date.now()}`);
    const stylesDir = join(tmp, "styles");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(join(stylesDir, "globals.css"), `:root { --color-primary: #3b82f6; }`);
    try {
      const source = detectTokenSource(tmp);
      assert.equal(source?.type, "css");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when nothing found", () => {
    const tmp = join(tmpdir(), `storysync-test-empty-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      assert.equal(detectTokenSource(tmp), null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("extractTokens — Tailwind", () => {
  it("extracts color tokens from theme.extend.colors", () => {
    const tmp = join(tmpdir(), `storysync-test-tw-extract-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "tailwind.config.ts"), `
      export default {
        theme: {
          extend: {
            colors: {
              brand: "#ff0000",
              accent: { light: "#e0f0ff", dark: "#003366" },
            },
          },
        },
      }
    `);
    try {
      const result = extractTokens(tmp);
      assert.equal(result.source, "tailwind");
      const colors = result.collections.find((c) => c.category === "colors");
      assert.ok(colors, "should have a colors collection");
      assert.ok(colors.tokens.length >= 3, `expected >= 3 color tokens, got ${colors.tokens.length}`);
      assert.ok(colors.tokens.some((t) => t.name === "brand" && t.value === "#ff0000"));
      assert.ok(colors.tokens.some((t) => t.name === "accent/light"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves hsl(var(--x)) references from CSS files", () => {
    const tmp = join(tmpdir(), `storysync-test-tw-resolve-${Date.now()}`);
    const stylesDir = join(tmp, "styles");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(join(tmp, "tailwind.config.ts"), `
      export default {
        theme: {
          extend: {
            colors: {
              primary: "hsl(var(--primary))",
              bg: "hsl(var(--background))",
            },
          },
        },
      }
    `);
    writeFileSync(join(stylesDir, "globals.css"), `
      :root {
        --primary: 217 91% 60%;
        --background: 240 5% 98%;
      }
    `);
    try {
      const result = extractTokens(tmp);
      const colors = result.collections.find((c) => c.category === "colors")!;
      const primary = colors.tokens.find((t) => t.name === "primary");
      assert.ok(primary, "should find primary token");
      assert.equal(primary.value, "hsl(217 91% 60%)", "should resolve var reference");
      assert.ok(!primary.value.includes("var("), "should not contain unresolved var()");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves chained var references", () => {
    const tmp = join(tmpdir(), `storysync-test-tw-chain-${Date.now()}`);
    const stylesDir = join(tmp, "styles");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(join(tmp, "tailwind.config.ts"), `
      export default {
        theme: {
          extend: {
            colors: {
              main: "hsl(var(--main))",
            },
          },
        },
      }
    `);
    writeFileSync(join(stylesDir, "globals.css"), `
      :root {
        --main: var(--brand);
        --brand: 217 91% 60%;
      }
    `);
    try {
      const result = extractTokens(tmp);
      const colors = result.collections.find((c) => c.category === "colors")!;
      const main = colors.tokens.find((t) => t.name === "main");
      assert.ok(main, "should find main token");
      assert.equal(main.value, "hsl(217 91% 60%)", "should resolve chained var");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("extractTokens — CSS", () => {
  it("categorizes bare HSL channel values as colors", () => {
    const tmp = join(tmpdir(), `storysync-test-css-hsl-${Date.now()}`);
    const stylesDir = join(tmp, "styles");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(join(stylesDir, "globals.css"), `
      :root {
        --primary: 217 91% 60%;
        --background: 240 5% 98%;
      }
    `);
    try {
      const result = extractTokens(tmp, "css");
      const colors = result.collections.find((c) => c.category === "colors");
      assert.ok(colors, "should have colors collection");
      assert.equal(colors.tokens.length, 2);
      assert.deepEqual(result.warnings, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("categorizes semantic color names without prefix", () => {
    const tmp = join(tmpdir(), `storysync-test-css-semantic-${Date.now()}`);
    const stylesDir = join(tmp, "styles");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(join(stylesDir, "globals.css"), `
      :root {
        --background: 240 5% 98%;
        --foreground: 224 71% 4%;
        --danger: 0 84% 60%;
        --danger-50: 0 86% 97%;
        --warning-700: 21 90% 48%;
        --heatmap-0: 240 5% 96%;
        --chart-likes: 0 84% 60%;
      }
    `);
    try {
      const result = extractTokens(tmp, "css");
      const colors = result.collections.find((c) => c.category === "colors");
      assert.ok(colors, "should have colors collection");
      assert.equal(colors.tokens.length, 7, "all 7 should be categorized as colors");
      assert.deepEqual(result.warnings, [], "should have no uncategorized warnings");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("categorizes --color-* and other standard prefixes", () => {
    const tmp = join(tmpdir(), `storysync-test-css-prefix-${Date.now()}`);
    const stylesDir = join(tmp, "styles");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(join(stylesDir, "globals.css"), `
      :root {
        --color-primary: #3b82f6;
        --color-secondary: rgb(100, 200, 150);
        --bg-surface: #ffffff;
        --spacing-sm: 0.5rem;
        --spacing-md: 1rem;
        --radius-md: 0.375rem;
        --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
        --font-sans: "Inter", sans-serif;
      }
    `);
    try {
      const result = extractTokens(tmp, "css");
      const colors = result.collections.find((c) => c.category === "colors");
      const spacing = result.collections.find((c) => c.category === "spacing");
      const radius = result.collections.find((c) => c.category === "radius");
      const shadows = result.collections.find((c) => c.category === "shadows");
      const typography = result.collections.find((c) => c.category === "typography");
      assert.ok(colors, "should have colors");
      assert.equal(colors.tokens.length, 3, "3 color tokens (--color-primary, --color-secondary, --bg-surface)");
      assert.ok(spacing, "should have spacing");
      assert.equal(spacing.tokens.length, 2);
      assert.ok(radius, "should have radius");
      assert.equal(radius.tokens.length, 1);
      assert.ok(shadows, "should have shadows");
      assert.equal(shadows.tokens.length, 1);
      assert.ok(typography, "should have typography");
      assert.equal(typography.tokens.length, 1);
      assert.deepEqual(result.warnings, [], "no uncategorized warnings");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("drift detection", () => {
  it("detects added and removed tokens", () => {
    const baseline: TokenBaseline = {
      version: 1,
      source: "tailwind",
      sourcePath: "/fake",
      collections: [{ category: "colors", tokens: [{ name: "old", value: "#000" }] }],
      generatedAt: new Date().toISOString(),
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

  it("detects changed values", () => {
    const baseline: TokenBaseline = {
      version: 1,
      source: "css",
      sourcePath: "/fake",
      collections: [{ category: "colors", tokens: [{ name: "primary", value: "#000" }] }],
      generatedAt: new Date().toISOString(),
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
});

// --- CLI integration tests ---

describe("CLI: storysync tokens", () => {
  it("runs with --json and returns valid JSON", () => {
    const tmp = join(tmpdir(), `storysync-test-cli-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "tailwind.config.ts"), `
      export default { theme: { extend: { colors: { test: "#abcdef" } } } }
    `);
    try {
      const out = run("tokens", "--project", tmp, "--json");
      const data = JSON.parse(out);
      assert.equal(data.source, "tailwind");
      assert.ok(data.summary.totalTokens >= 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 1 with --strict when no tokens found", () => {
    const tmp = join(tmpdir(), `storysync-test-strict-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      execFileSync("tsx", [CLI, "tokens", "--project", tmp, "--strict"], { encoding: "utf8" });
      assert.fail("should have exited with code 1");
    } catch (err: any) {
      assert.equal(err.status, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
