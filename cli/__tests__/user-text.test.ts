// What users read stays in plain sentences: no em dashes in the CLI's
// output, the skills, the commands or the docs, and Storysync named as a
// name in prose, `storysync` kept for the command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled to dist/cli/__tests__/, so the repo is three levels up.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const inDir = (dir: string, pattern: RegExp) => readdirSync(join(ROOT, dir)).filter((n) => pattern.test(n)).map((n) => `${dir}/${n}`);

const DOCS = [
  "README.md", "CONTRIBUTING.md", "examples/storybook-vite/README.md",
  ...inDir("skills", /\.(md|mdc)$/), ...inDir("commands", /\.md$/), ...inDir("docs", /\.md$/),
];

test("the docs, skills and commands have no em dashes", () => {
  const found = DOCS.flatMap((path) => read(path).split("\n").flatMap((line, i) => (line.includes("—") ? [`${path}:${i + 1}`] : [])));
  assert.deepEqual(found, []);
});

test("the CLI prints no em dashes", () => {
  // Every line of source but comments: strings the CLI prints, throws or
  // writes. The heading an earlier setup wrote is matched, not printed.
  const found = inDir("cli", /\.ts$/).flatMap((path) => read(path).split("\n").flatMap((line, i) => {
    const code = line.trim();
    if (!line.includes("—") || /^(\/\/|\*|\/\*)/.test(code) || code.startsWith("const LEGACY_CODEX_HEADING =")) return [];
    return [`${path}:${i + 1}`];
  }));
  assert.deepEqual(found, []);
});

test("prose names Storysync with a capital, as the skills' and the example's headings do", () => {
  for (const path of ["skills/claude-code.md", "skills/codex.md", "skills/cursor.mdc", "examples/storybook-vite/README.md"]) {
    const heading = read(path).split("\n").find((line) => line.startsWith("# ")) ?? "";
    assert.match(heading, /^# Storysync\b/, path);
  }
  // In the example's prose, outside code, `storysync` is only ever a command or a path.
  const prose = read("examples/storybook-vite/README.md").replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  assert.doesNotMatch(prose, /(?<![./-])\bstorysync\b(?![/-])/);
});

test("CONTRIBUTING's acceptance steps install the example's own dependencies", () => {
  // The example has its own lockfile and is no workspace package, so a
  // fresh clone's `pnpm storybook` there fails without its install.
  const line = read("CONTRIBUTING.md").split("\n").find((l) => l.includes("`pnpm acceptance`")) ?? "";
  assert.match(line, /cd examples\/storybook-vite && pnpm install && pnpm storybook/);
});

test("the reference's troubleshooting quotes the 404 message the CLI prints", () => {
  // It quoted "Storybook has no MCP endpoint", which nothing prints, so a
  // reader searching for the line they saw found nothing.
  const printed = /"(There's no MCP endpoint there)\./.exec(read("cli/mcp-connect.ts"))?.[1];
  assert.ok(printed, "mcp-connect.ts no longer prints the 404 line");
  assert.ok(read("docs/reference.md").includes(`**"${printed}" (HTTP 404).**`));
});
