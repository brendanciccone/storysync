import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  detectPackageManager,
  findStorybookConfig,
  getStorybookVersion,
  isStorybookVersionOk,
  hasAddonMcpInPackageJson,
  hasAddonMcpInConfig,
  addAddonToConfig,
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

test("getStorybookVersion: reads from devDependencies", () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ devDependencies: { storybook: "10.3.6" } }),
  });
  try {
    assert.equal(getStorybookVersion(dir), "10.3.6");
  } finally {
    cleanup(dir);
  }
});

test("getStorybookVersion: null when not installed", () => {
  const dir = makeProject({ "package.json": JSON.stringify({ devDependencies: {} }) });
  try {
    assert.equal(getStorybookVersion(dir), null);
  } finally {
    cleanup(dir);
  }
});

test("isStorybookVersionOk: 10.3.6 passes", () => {
  assert.equal(isStorybookVersionOk("10.3.6"), true);
});

test("isStorybookVersionOk: ^10.1.0 passes", () => {
  assert.equal(isStorybookVersionOk("^10.1.0"), true);
});

test("isStorybookVersionOk: 9.1.20 fails", () => {
  assert.equal(isStorybookVersionOk("9.1.20"), false);
});

test("isStorybookVersionOk: 10.0.0 fails (needs 10.1+)", () => {
  assert.equal(isStorybookVersionOk("10.0.0"), false);
});

test("isStorybookVersionOk: 11.0.0 passes", () => {
  assert.equal(isStorybookVersionOk("11.0.0"), true);
});

test("isStorybookVersionOk: null fails", () => {
  assert.equal(isStorybookVersionOk(null), false);
});

test("getStorybookVersion: falls back to @storybook/ framework package", () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ devDependencies: { "@storybook/react-vite": "^10.3.0" } }),
  });
  try {
    assert.equal(getStorybookVersion(dir), "^10.3.0");
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
