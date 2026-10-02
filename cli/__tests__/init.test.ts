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
  getInstalledAddonMcpVersion,
  addonMcpInstallSpec,
  addonMcpNeedsNewerStorybook,
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

test("detectPackageManager: bun.lock or bun.lockb -> bun", () => {
  for (const lockfile of ["bun.lock", "bun.lockb"]) {
    const dir = makeProject({ [lockfile]: "" });
    try {
      assert.equal(detectPackageManager(dir), "bun", lockfile);
    } finally {
      cleanup(dir);
    }
  }
});

test("detectPackageManager: a workspace package uses the lockfile at the workspace root", () => {
  for (const [lockfile, pm] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"]] as const) {
    const dir = makeProject({
      [lockfile]: "",
      "packages/ui/package.json": JSON.stringify({ dependencies: { "@acme/tokens": "workspace:*" } }),
    });
    try {
      assert.equal(detectPackageManager(join(dir, "packages", "ui")), pm, lockfile);
    } finally {
      cleanup(dir);
    }
  }
});

test("detectPackageManager: the nearest lockfile wins", () => {
  const dir = makeProject({
    "pnpm-lock.yaml": "",
    "app/package.json": "{}",
    "app/package-lock.json": "{}",
  });
  try {
    assert.equal(detectPackageManager(join(dir, "app")), "npm");
  } finally {
    cleanup(dir);
  }
});

test("detectPackageManager: stops at the repository root", () => {
  // A stray lockfile above the repository, such as one in the home
  // directory, is not the project's.
  const dir = makeProject({
    "pnpm-lock.yaml": "",
    "repo/.git/HEAD": "ref: refs/heads/main\n",
    "repo/packages/ui/package.json": "{}",
  });
  try {
    assert.equal(detectPackageManager(join(dir, "repo", "packages", "ui")), "npm");
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

test("hasAddonMcpInConfig: an entry inside a comment is not registered", () => {
  assert.equal(hasAddonMcpInConfig(`addons: [\n  "@storybook/addon-docs",\n  // "@storybook/addon-mcp", // off until the upgrade\n]`), false);
  assert.equal(hasAddonMcpInConfig(`addons: [\n  "@storybook/addon-docs",\n  /* { name: "@storybook/addon-mcp" }, */\n]`), false);
  assert.equal(hasAddonMcpInConfig(`/*\n addons: ["@storybook/addon-mcp"],\n*/\naddons: []`), false);
});

test("hasAddonMcpInConfig: a string's // or slash-star doesn't hide the entry after it", () => {
  assert.equal(hasAddonMcpInConfig(`refs: { a: { url: "https://x.dev" } }, addons: ["@storybook/addon-mcp"]`), true);
  assert.equal(hasAddonMcpInConfig(`stories: ["../src/**/*.stories.tsx"], addons: ["@storybook/addon-mcp"]`), true);
  assert.equal(hasAddonMcpInConfig(`stories: ['../docs/**'], addons: ["@storybook/addon-mcp"] // the MCP server`), true);
  assert.equal(hasAddonMcpInConfig(`test: /https?:\\/\\//, addons: ["@storybook/addon-mcp"]`), true);
});

test("addAddonToConfig: inserts into the addons array that isn't commented out", () => {
  const line = `const config = {\n  // addons: ["@storybook/addon-essentials"],\n  addons: ["@storybook/addon-docs"],\n};`;
  const block = `const config = {\n  /* addons: [\n    "@storybook/addon-essentials",\n  ], */\n  addons: ["@storybook/addon-docs"],\n};`;
  for (const input of [line, block]) {
    const result = addAddonToConfig(input);
    assert.equal(result.ok, true);
    const entry = `\n    { name: "@storybook/addon-mcp", options: { toolsets: { docs: true } } },`;
    const live = input.lastIndexOf(`addons: [`) + `addons: [`.length;
    assert.equal(result.content, input.slice(0, live) + entry + input.slice(live));
    assert.equal(hasAddonMcpInConfig(result.content), true);
  }
});

test("addAddonToConfig: ok=false when the only addons array is commented out", () => {
  const input = `const config = {\n  // addons: ["@storybook/addon-essentials"],\n  framework: "@storybook/react-vite",\n};`;
  assert.deepEqual(addAddonToConfig(input), { content: input, ok: false });
});

test("addAddonToConfig: a glob or URL before the addons array doesn't throw the match off", () => {
  const input = `const config = {\n  stories: ["../src/**/*.stories.tsx"],\n  refs: { a: { url: "https://x.dev//a" } },\n  addons: [],\n};`;
  const result = addAddonToConfig(input);
  assert.equal(result.ok, true);
  assert.match(result.content, /\n  addons: \[\n    \{ name: "@storybook\/addon-mcp"/);
  assert.match(result.content, /stories: \["\.\.\/src\/\*\*\/\*\.stories\.tsx"\],\n  refs: \{ a: \{ url: "https:\/\/x\.dev\/\/a" \} \},\n/);
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
  assert.equal(installCommand("bun", "@storybook/addon-mcp@^0.7.0"), `bun add -d "@storybook/addon-mcp@^0.7.0"`);
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

test("getInstalledAddonMcpVersion: reads the scoped package from node_modules", () => {
  const dir = makeProject({
    "node_modules/@storybook/addon-mcp/package.json": JSON.stringify({ name: "@storybook/addon-mcp", version: "10.6.0" }),
    "packages/ui/package.json": "{}",
  });
  try {
    assert.equal(getInstalledAddonMcpVersion(dir), "10.6.0");
    assert.equal(getInstalledAddonMcpVersion(join(dir, "packages", "ui")), "10.6.0");
  } finally {
    cleanup(dir);
  }
});

test("addonMcpNeedsNewerStorybook: a lockstep addon-mcp newer than Storybook", () => {
  // Each lockstep release peers on Storybook at its own version or later.
  assert.equal(addonMcpNeedsNewerStorybook("10.6.0", "10.5.5"), true);
  assert.equal(addonMcpNeedsNewerStorybook("10.6.1", "10.6.0"), true);
  assert.equal(addonMcpNeedsNewerStorybook("10.6.0", "10.6.0-beta.3"), true);
  assert.equal(addonMcpNeedsNewerStorybook("10.6.0-alpha.4", "10.5.5"), true);
  assert.equal(addonMcpNeedsNewerStorybook("11.0.0-alpha.1", "10.6.0"), true);
});

test("addonMcpNeedsNewerStorybook: not for a matching or older addon, 0.7, or an unknown version", () => {
  assert.equal(addonMcpNeedsNewerStorybook("10.6.0", "10.6.0"), false);
  assert.equal(addonMcpNeedsNewerStorybook("10.6.0", "10.7.1"), false);
  assert.equal(addonMcpNeedsNewerStorybook("10.6.0-beta.3", "10.6.0"), false);
  assert.equal(addonMcpNeedsNewerStorybook("0.7.0", "10.5.5"), false);
  assert.equal(addonMcpNeedsNewerStorybook(null, "10.5.5"), false);
  assert.equal(addonMcpNeedsNewerStorybook("10.6.0", null), false);
});
