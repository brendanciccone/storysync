import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  detectPackageManager,
  findStorybookConfig,
  hasAddonMcpInPackageJson,
  hasAddonMcpInConfig,
  hasComponentsManifest,
  addAddonToConfig,
  addComponentsManifest,
} from "../init.js";

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "storysync-init-test-"));
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

test("detectPackageManager: pnpm-lock.yaml -> pnpm", () => {
  const dir = makeProject({ "pnpm-lock.yaml": "lockfileVersion: 9" });
  try {
    assert.equal(detectPackageManager(dir), "pnpm");
  } finally {
    cleanup(dir);
  }
});

test("detectPackageManager: yarn.lock -> yarn", () => {
  const dir = makeProject({ "yarn.lock": "" });
  try {
    assert.equal(detectPackageManager(dir), "yarn");
  } finally {
    cleanup(dir);
  }
});

test("detectPackageManager: no lockfile -> npm fallback", () => {
  const dir = makeProject({ "package.json": "{}" });
  try {
    assert.equal(detectPackageManager(dir), "npm");
  } finally {
    cleanup(dir);
  }
});

test("findStorybookConfig: prefers main.ts over main.js", () => {
  const dir = makeProject({
    ".storybook/main.ts": "export default {}",
    ".storybook/main.js": "module.exports = {}",
  });
  try {
    const found = findStorybookConfig(dir);
    assert.ok(found);
    assert.ok(found!.path.endsWith("main.ts"));
  } finally {
    cleanup(dir);
  }
});

test("findStorybookConfig: returns null when no config exists", () => {
  const dir = makeProject({ "package.json": "{}" });
  try {
    assert.equal(findStorybookConfig(dir), null);
  } finally {
    cleanup(dir);
  }
});

test("hasAddonMcpInPackageJson: detects in devDependencies", () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ devDependencies: { "@storybook/addon-mcp": "^0.6.0" } }),
  });
  try {
    assert.equal(hasAddonMcpInPackageJson(dir), true);
  } finally {
    cleanup(dir);
  }
});

test("hasAddonMcpInPackageJson: false when absent", () => {
  const dir = makeProject({ "package.json": JSON.stringify({ devDependencies: { typescript: "^5" } }) });
  try {
    assert.equal(hasAddonMcpInPackageJson(dir), false);
  } finally {
    cleanup(dir);
  }
});

test("hasAddonMcpInConfig: detects bare string addon entry", () => {
  const config = `addons: ["@storybook/addon-a11y", "@storybook/addon-mcp"]`;
  assert.equal(hasAddonMcpInConfig(config), true);
});

test("hasAddonMcpInConfig: detects object form", () => {
  const config = `addons: [{ name: "@storybook/addon-mcp", options: {} }]`;
  assert.equal(hasAddonMcpInConfig(config), true);
});

test("hasAddonMcpInConfig: false when absent", () => {
  const config = `addons: ["@storybook/addon-a11y"]`;
  assert.equal(hasAddonMcpInConfig(config), false);
});

test("hasComponentsManifest: true when set to true", () => {
  const config = `features: { componentsManifest: true }`;
  assert.equal(hasComponentsManifest(config), true);
});

test("hasComponentsManifest: false when set to false", () => {
  const config = `features: { componentsManifest: false }`;
  assert.equal(hasComponentsManifest(config), false);
});

test("addAddonToConfig: inserts entry with toolsets.docs", () => {
  const input = `const config = {\n  addons: [\n    '@storybook/addon-a11y',\n  ],\n};`;
  const result = addAddonToConfig(input);
  assert.equal(result.ok, true);
  assert.match(result.content, /@storybook\/addon-mcp/);
  assert.match(result.content, /toolsets:\s*\{\s*docs:\s*true/);
});

test("addAddonToConfig: returns ok=false when no addons array found", () => {
  const result = addAddonToConfig(`const config = { framework: '@storybook/nextjs-vite' };`);
  assert.equal(result.ok, false);
});

test("addComponentsManifest: inserts into existing features block", () => {
  const input = `const config = {\n  features: {\n    other: true,\n  },\n  addons: [],\n};`;
  const result = addComponentsManifest(input);
  assert.equal(result.ok, true);
  assert.match(result.content, /componentsManifest:\s*true/);
});

test("addComponentsManifest: creates new features block before addons", () => {
  const input = `const config = {\n  addons: [],\n};`;
  const result = addComponentsManifest(input);
  assert.equal(result.ok, true);
  assert.match(result.content, /features:\s*\{\s*[\s\S]*componentsManifest:\s*true/);
  assert.match(result.content, /addons:\s*\[/);
});

test("addComponentsManifest: ok=false when no anchors found", () => {
  const result = addComponentsManifest(`const x = 1;`);
  assert.equal(result.ok, false);
});
