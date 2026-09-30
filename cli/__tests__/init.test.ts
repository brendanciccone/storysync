import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  getInstalledStorybookVersion,
  addonMcpInstallSpec,
  installCommand,
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

test("getInstalledStorybookVersion: reads the version from node_modules", () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ devDependencies: { storybook: "^10.5.0" } }),
    "node_modules/storybook/package.json": JSON.stringify({ name: "storybook", version: "10.6.0" }),
  });
  try {
    assert.equal(getInstalledStorybookVersion(dir), "10.6.0");
  } finally {
    cleanup(dir);
  }
});

test("getInstalledStorybookVersion: finds a workspace root's hoisted install", () => {
  const dir = makeProject({
    "node_modules/storybook/package.json": JSON.stringify({ name: "storybook", version: "10.5.5" }),
    "packages/ui/package.json": JSON.stringify({ devDependencies: { storybook: "^10.5.0" } }),
  });
  try {
    assert.equal(getInstalledStorybookVersion(join(dir, "packages", "ui")), "10.5.5");
  } finally {
    cleanup(dir);
  }
});

test("getInstalledStorybookVersion: null before install", () => {
  const dir = makeProject({ "package.json": JSON.stringify({ devDependencies: { storybook: "^10.5.0" } }) });
  try {
    assert.equal(getInstalledStorybookVersion(dir), null);
  } finally {
    cleanup(dir);
  }
});

// addon-mcp 10.6.0 peers on storybook ^10.6.0; 0.7.0 on any Storybook 10.
test("addonMcpInstallSpec: Storybook 10.6+ gets the addon version equal to its own", () => {
  assert.equal(addonMcpInstallSpec("10.6.0"), "@storybook/addon-mcp@10.6.0");
  assert.equal(addonMcpInstallSpec("10.6.3"), "@storybook/addon-mcp@10.6.3");
  assert.equal(addonMcpInstallSpec("11.0.0"), "@storybook/addon-mcp@11.0.0");
});

test("addonMcpInstallSpec: a declared range uses its lowest version", () => {
  // Anything newer than the floor could require a newer Storybook than the
  // range guarantees.
  assert.equal(addonMcpInstallSpec("^10.6.2"), "@storybook/addon-mcp@10.6.2");
  assert.equal(addonMcpInstallSpec("~10.7"), "@storybook/addon-mcp@10.7.0");
  assert.equal(addonMcpInstallSpec(">=10.6.0 <11"), "@storybook/addon-mcp@10.6.0");
});

test("addonMcpInstallSpec: keeps a prerelease tag", () => {
  assert.equal(addonMcpInstallSpec("10.7.0-beta.1"), "@storybook/addon-mcp@10.7.0-beta.1");
  assert.equal(addonMcpInstallSpec("10.6.0-beta.3"), "@storybook/addon-mcp@10.6.0-beta.3");
  assert.equal(addonMcpInstallSpec("10.6.0-alpha.4"), "@storybook/addon-mcp@10.6.0-alpha.4");
  assert.equal(addonMcpInstallSpec("11.0.0-alpha.1"), "@storybook/addon-mcp@11.0.0-alpha.1");
});

test("addonMcpInstallSpec: a 10.6 prerelease from before addon-mcp's first lockstep release gets 0.7", () => {
  // addon-mcp's first release in lockstep with Storybook was 10.6.0-alpha.4;
  // there is no @storybook/addon-mcp@10.6.0-alpha.0 to .3.
  for (const version of ["10.6.0-alpha.0", "10.6.0-alpha.3", "^10.6.0-alpha.2"]) {
    assert.equal(addonMcpInstallSpec(version), "@storybook/addon-mcp@^0.7.0", version);
  }
  // Numeric identifiers compare as numbers, not text.
  assert.equal(addonMcpInstallSpec("10.6.0-alpha.10"), "@storybook/addon-mcp@10.6.0-alpha.10");
});

test("addonMcpInstallSpec: Storybook before 10.6 gets addon-mcp 0.7", () => {
  assert.equal(addonMcpInstallSpec("10.5.5"), "@storybook/addon-mcp@^0.7.0");
  assert.equal(addonMcpInstallSpec("^10.1.0"), "@storybook/addon-mcp@^0.7.0");
  assert.equal(addonMcpInstallSpec("9.1.20"), "@storybook/addon-mcp@^0.7.0");
});

test("addonMcpInstallSpec: unpinned when the version can't be read", () => {
  assert.equal(addonMcpInstallSpec(null), "@storybook/addon-mcp");
  assert.equal(addonMcpInstallSpec("workspace:*"), "@storybook/addon-mcp");
});

test("installCommand: passes the spec to each package manager, quoting a range", () => {
  assert.equal(installCommand("pnpm", "@storybook/addon-mcp@10.6.0"), "pnpm add -D @storybook/addon-mcp@10.6.0");
  assert.equal(installCommand("pnpm", "@storybook/addon-mcp@10.6.0-beta.3"), "pnpm add -D @storybook/addon-mcp@10.6.0-beta.3");
  assert.equal(installCommand("pnpm", "@storybook/addon-mcp@^0.7.0"), `pnpm add -D "@storybook/addon-mcp@^0.7.0"`);
  assert.equal(installCommand("yarn", "@storybook/addon-mcp@^0.7.0"), `yarn add -D "@storybook/addon-mcp@^0.7.0"`);
  assert.equal(installCommand("npm", "@storybook/addon-mcp@^0.7.0"), `npm install -D "@storybook/addon-mcp@^0.7.0"`);
});

const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;

test("installCommand: survives zsh with extendedglob, where an unquoted ^ is a glob", { skip: !hasZsh && "zsh is not installed" }, () => {
  // `pnpm` stands in for the package manager and prints what it was given.
  const run = (command: string) =>
    spawnSync("zsh", ["-f", "-c", `setopt extendedglob; pnpm() { print -rl -- "$@"; }; ${command}`], { encoding: "utf8" });
  const quoted = run(installCommand("pnpm", "@storybook/addon-mcp@^0.7.0"));
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.equal(quoted.stdout, "add\n-D\n@storybook/addon-mcp@^0.7.0\n");
  // The failure the quotes prevent.
  assert.match(run("pnpm add -D @storybook/addon-mcp@^0.7.0").stderr, /no matches found/);
});
