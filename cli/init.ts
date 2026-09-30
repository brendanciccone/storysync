// `storysync init` — detect Storybook MCP setup gaps and offer to fix them.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import chalk from "chalk";

export type PackageManager = "pnpm" | "yarn" | "npm";

export interface StorybookConfigFile {
  path: string;
  content: string;
}

const MIN_STORYBOOK_MAJOR = 10;

// addon-mcp moved into the Storybook monorepo at 10.6 and now releases in
// lockstep with it: each version requires Storybook at or above its own
// (10.6.0 peers on `storybook@^10.6.0`) and imports Storybook internals that
// 10.5 does not ship. 0.7, the last release on its own numbering, accepts any
// Storybook 10. An unpinned install takes `latest`, which on a 10.5 project
// fails with ERESOLVE under npm — or, with `storybook@^10.5.0` in
// package.json, quietly upgrades storybook past its framework package.
//
// The first lockstep release was 10.6.0-alpha.4: Storybook's 10.6.0-alpha.0
// to alpha.3 have no addon-mcp of their own version, so they get 0.7 too.
const ADDON_MCP_FIRST_LOCKSTEP = "10.6.0-alpha.4";
const ADDON_MCP_PRE_LOCKSTEP_RANGE = "^0.7.0";

export function detectPackageManager(projectPath: string): PackageManager {
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectPath, "yarn.lock"))) return "yarn";
  return "npm";
}

export function findStorybookConfig(projectPath: string): StorybookConfigFile | null {
  for (const name of ["main.ts", "main.js", "main.mts", "main.mjs"]) {
    const p = join(projectPath, ".storybook", name);
    if (existsSync(p)) return { path: p, content: readFileSync(p, "utf8") };
  }
  return null;
}

export function getStorybookVersion(projectPath: string): string | null {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps["storybook"]) return deps["storybook"];
  const framework = Object.entries(deps).find(([name]) => name.startsWith("@storybook/"));
  return framework?.[1] ?? null;
}

/**
 * The version of a package installed for the project, read from node_modules.
 * Looks upward, the way Node resolves it, so a workspace package finds a
 * hoisted install. Null before the project has been installed.
 */
function getInstalledVersion(projectPath: string, name: string): string | null {
  let dir = resolve(projectPath);
  for (;;) {
    const pkgPath = join(dir, "node_modules", name, "package.json");
    if (existsSync(pkgPath)) {
      try {
        return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The version of Storybook installed for the project; see getInstalledVersion. */
export function getInstalledStorybookVersion(projectPath: string): string | null {
  return getInstalledVersion(projectPath, "storybook");
}

/** The version of @storybook/addon-mcp installed for the project; see getInstalledVersion. */
export function getInstalledAddonMcpVersion(projectPath: string): string | null {
  return getInstalledVersion(projectPath, "@storybook/addon-mcp");
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  floor: string;
}

/**
 * Reads an installed version (`10.6.0`) or a declared range (`^10.6.0`) as the
 * lowest version it allows. Null for anything else (`latest`, `workspace:*`).
 */
function parseStorybookVersion(version: string | null): ParsedVersion | null {
  const m = version?.replace(/^[\^~>=<\s]*/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3] ?? "0", 10),
    prerelease: m[4] ? m[4].split(".") : [],
    floor: `${m[1]}.${m[2]}.${m[3] ?? "0"}${m[4] ? `-${m[4]}` : ""}`,
  };
}

/** Orders two parsed versions by semver precedence: negative when `a` is older. */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core) return core;
  // A release is newer than any of its prereleases (10.6.0 > 10.6.0-beta.3).
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? parseInt(x, 10) - parseInt(y, 10) : x < y ? -1 : x > y ? 1 : 0;
    if (order) return order;
  }
  return 0;
}

const FIRST_LOCKSTEP = parseStorybookVersion(ADDON_MCP_FIRST_LOCKSTEP)!;

export function isStorybookVersionOk(version: string | null): boolean {
  const v = parseStorybookVersion(version);
  if (!v) return false;
  return v.major > MIN_STORYBOOK_MAJOR || (v.major === MIN_STORYBOOK_MAJOR && v.minor >= 1);
}

/**
 * The `@storybook/addon-mcp` install spec that fits a project's Storybook
 * version: from 10.6 the addon's version equal to Storybook's, since a later
 * one would require a later Storybook; before that, 0.7. Unpinned when the
 * version is unknown.
 */
export function addonMcpInstallSpec(storybookVersion: string | null): string {
  const v = parseStorybookVersion(storybookVersion);
  if (!v) return "@storybook/addon-mcp";
  const lockstep = compareVersions(v, FIRST_LOCKSTEP) >= 0;
  return `@storybook/addon-mcp@${lockstep ? v.floor : ADDON_MCP_PRE_LOCKSTEP_RANGE}`;
}

/**
 * Whether an installed addon-mcp requires a newer Storybook than the project
 * has: a lockstep release (10.6 on) newer than Storybook, which it peers on
 * at its own version or later. Storybook fails to load its preset, so the
 * addon looks installed while nothing works. An older init installed it
 * unpinned, which put 10.6 on Storybook 10.5 projects.
 */
export function addonMcpNeedsNewerStorybook(addonVersion: string | null, storybookVersion: string | null): boolean {
  const addon = parseStorybookVersion(addonVersion);
  const storybook = parseStorybookVersion(storybookVersion);
  if (!addon || !storybook) return false;
  return compareVersions(addon, FIRST_LOCKSTEP) >= 0 && compareVersions(addon, storybook) > 0;
}

export function hasAddonMcpInPackageJson(projectPath: string): boolean {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Boolean(pkg.devDependencies?.["@storybook/addon-mcp"] || pkg.dependencies?.["@storybook/addon-mcp"]);
}

export function hasAddonMcpInConfig(content: string): boolean {
  return /["']@storybook\/addon-mcp["']/.test(content);
}

export function addAddonToConfig(content: string): { content: string; ok: boolean } {
  const m = content.match(/(addons\s*:\s*\[)/);
  if (!m) return { content, ok: false };
  const insertAt = (m.index ?? 0) + m[0].length;
  const entry = `\n    { name: "@storybook/addon-mcp", options: { toolsets: { docs: true } } },`;
  return { content: content.slice(0, insertAt) + entry + content.slice(insertAt), ok: true };
}

// One reader of stdin for every prompt. A readline interface per prompt lost
// piped answers: given "n\ny\n", the first read both lines, took its answer
// and closed, and the second prompt was left waiting for input already gone,
// so init exited without registering the addon.
let answers: { rl: Interface; lines: AsyncIterableIterator<string> } | null = null;

async function confirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} ${chalk.dim("[Y/n]")} `);
  if (!answers) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    answers = { rl, lines: rl[Symbol.asyncIterator]() };
  }
  const next = await answers.lines.next();
  if (next.done) {
    // Input ended with no answer: nothing was agreed to.
    process.stdout.write("\n");
    return false;
  }
  const a = next.value.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
}

/** Stops reading stdin, if a prompt started to, so the process can exit. */
function closeAnswers(): void {
  answers?.rl.close();
  answers = null;
}

/**
 * The command that installs `spec`, as run and as printed for running by
 * hand. A spec with a range in it is quoted: zsh with extendedglob reads
 * `^0.7.0` as a glob and fails with "no matches found". Double quotes, since
 * cmd.exe, which runs it on Windows, keeps single quotes as part of the name.
 */
export function installCommand(pm: PackageManager, spec: string): string {
  const arg = /^[\w@/.:+-]+$/.test(spec) ? spec : `"${spec}"`;
  if (pm === "pnpm") return `pnpm add -D ${arg}`;
  if (pm === "yarn") return `yarn add -D ${arg}`;
  return `npm install -D ${arg}`;
}

/** Asks before installing `spec`. A failed install ends init with exit code 1. */
async function offerInstall(pm: PackageManager, spec: string, projectPath: string): Promise<"installed" | "skipped" | "failed"> {
  const command = installCommand(pm, spec);
  if (!(await confirm(`Install ${spec} via ${pm}?`))) {
    console.log(chalk.dim(`  Skipped. Run manually: ${command}`));
    return "skipped";
  }
  try {
    execSync(command, { cwd: projectPath, stdio: "inherit" });
    return "installed";
  } catch (err) {
    console.log(chalk.red(`Install failed: ${String(err)}`));
    process.exitCode = 1;
    return "failed";
  }
}

function upgradeCommand(pm: PackageManager): string {
  if (pm === "pnpm") return "pnpm dlx storybook@latest upgrade";
  if (pm === "yarn") return "npx storybook@latest upgrade";
  return "npx storybook@latest upgrade";
}

export async function runInit(projectInput: string): Promise<void> {
  try {
    await checkAndFix(projectInput);
  } finally {
    closeAnswers();
  }
}

async function checkAndFix(projectInput: string): Promise<void> {
  const projectPath = resolve(projectInput);
  console.log(chalk.bold("\nstorysync init"));
  console.log(chalk.dim(`Project: ${projectPath}\n`));

  const config = findStorybookConfig(projectPath);
  if (!config) {
    console.log(chalk.red("✖ No Storybook config found at .storybook/main.ts"));
    console.log(chalk.dim("  Initialize Storybook first: npx storybook init"));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green("✔") + ` Found ${relative(projectPath, config.path)}`);

  const pm = detectPackageManager(projectPath);

  // The installed version when there is one: `^10.5.0` in package.json may
  // well be 10.6 on disk, and the addon has to match what actually runs.
  const sbVersion = getInstalledStorybookVersion(projectPath) ?? getStorybookVersion(projectPath);
  const sbOk = isStorybookVersionOk(sbVersion);
  const hasAddon = hasAddonMcpInPackageJson(projectPath);
  const addonVersion = hasAddon ? getInstalledAddonMcpVersion(projectPath) : null;
  // Installed, but a release for a newer Storybook, so it doesn't load.
  const addonTooNew = addonMcpNeedsNewerStorybook(addonVersion, sbVersion);
  const inConfig = hasAddonMcpInConfig(config.content);

  const addonMark = addonTooNew ? chalk.red("✖") : hasAddon ? chalk.green("✔") : chalk.yellow("✖");
  console.log(`${sbOk ? chalk.green("✔") : chalk.red("✖")} Storybook 10.1+ ${chalk.dim(sbVersion ? `(found ${sbVersion})` : "(not found)")}`);
  console.log(`${addonMark} @storybook/addon-mcp installed${addonVersion ? ` ${chalk.dim(`(found ${addonVersion})`)}` : ""}`);
  console.log(`${inConfig ? chalk.green("✔") : chalk.yellow("✖")} addon-mcp registered in addons array`);
  console.log("");

  if (sbOk && hasAddon && !addonTooNew && inConfig) {
    console.log(chalk.green("Everything looks good. Restart Storybook if it's running."));
    return;
  }

  if (!sbOk) {
    console.log(chalk.red(`storysync requires Storybook 10.1+ for component sync (list, map, inspect, diff).`));
    console.log(chalk.red(`Token extraction (storysync tokens) works with any version.`));
    console.log(chalk.dim(`\n  Upgrade: ${upgradeCommand(pm)}\n`));
    process.exitCode = 1;
  }

  let updatedContent = config.content;
  let configChanged = false;
  let installed = false;

  if (!hasAddon || addonTooNew) {
    const spec = addonMcpInstallSpec(sbVersion);
    if (addonTooNew) {
      console.log(chalk.red(
        `@storybook/addon-mcp ${addonVersion} needs Storybook ${addonVersion} or later, ` +
        `but this project has Storybook ${sbVersion}, so Storybook can't load the addon.`,
      ));
    }
    const outcome = await offerInstall(pm, spec, projectPath);
    if (outcome === "failed") return;
    installed = outcome === "installed";
    if (addonTooNew && !installed) {
      // Declined: the addon is left as it is, and it still doesn't load.
      console.log(chalk.dim(`  Or upgrade Storybook: ${upgradeCommand(pm)}`));
      process.exitCode = 1;
    }
  }

  if (!inConfig) {
    const yes = await confirm(`Add @storybook/addon-mcp to .storybook/main config?`);
    if (yes) {
      const result = addAddonToConfig(updatedContent);
      if (result.ok) {
        updatedContent = result.content;
        configChanged = true;
      } else {
        console.log(chalk.yellow("  Couldn't locate `addons: [` in your config. Add this manually:"));
        console.log(chalk.dim(`    { name: "@storybook/addon-mcp", options: { toolsets: { docs: true } } }`));
      }
    }
  }

  if (configChanged) {
    writeFileSync(config.path, updatedContent);
    console.log(chalk.green(`\n✔ Updated ${relative(projectPath, config.path)}`));
  }

  if (configChanged || installed) {
    console.log(chalk.dim("\nRestart Storybook to apply changes, then run:"));
    console.log(chalk.dim("  storysync list --storybook http://localhost:6006"));
  }
}
