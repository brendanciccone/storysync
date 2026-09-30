// `storysync init` — detect Storybook MCP setup gaps and offer to fix them.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
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
const ADDON_MCP_LOCKSTEP_MINOR = 6;
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
 * The version of Storybook installed for the project, read from
 * node_modules. Looks upward, the way Node resolves it, so a workspace package
 * finds a hoisted install. Null before the project has been installed.
 */
export function getInstalledStorybookVersion(projectPath: string): string | null {
  let dir = resolve(projectPath);
  for (;;) {
    const pkgPath = join(dir, "node_modules", "storybook", "package.json");
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

/**
 * Reads an installed version (`10.6.0`) or a declared range (`^10.6.0`) as the
 * lowest version it allows. Null for anything else (`latest`, `workspace:*`).
 */
function parseStorybookVersion(version: string | null): { major: number; minor: number; floor: string } | null {
  const m = version?.replace(/^[\^~>=<\s]*/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), floor: `${m[1]}.${m[2]}.${m[3] ?? "0"}${m[4] ?? ""}` };
}

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
  const lockstep = v.major > MIN_STORYBOOK_MAJOR || (v.major === MIN_STORYBOOK_MAJOR && v.minor >= ADDON_MCP_LOCKSTEP_MINOR);
  return `@storybook/addon-mcp@${lockstep ? v.floor : ADDON_MCP_PRE_LOCKSTEP_RANGE}`;
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

function confirm(message: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} ${chalk.dim("[Y/n]")} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolveP(a === "" || a === "y" || a === "yes");
    });
  });
}

export function installCommand(pm: PackageManager, spec: string): string {
  if (pm === "pnpm") return `pnpm add -D ${spec}`;
  if (pm === "yarn") return `yarn add -D ${spec}`;
  return `npm install -D ${spec}`;
}

function upgradeCommand(pm: PackageManager): string {
  if (pm === "pnpm") return "pnpm dlx storybook@latest upgrade";
  if (pm === "yarn") return "npx storybook@latest upgrade";
  return "npx storybook@latest upgrade";
}

export async function runInit(projectInput: string): Promise<void> {
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
  const inConfig = hasAddonMcpInConfig(config.content);

  console.log(`${sbOk ? chalk.green("✔") : chalk.red("✖")} Storybook 10.1+ ${chalk.dim(sbVersion ? `(found ${sbVersion})` : "(not found)")}`);
  console.log(`${hasAddon ? chalk.green("✔") : chalk.yellow("✖")} @storybook/addon-mcp installed`);
  console.log(`${inConfig ? chalk.green("✔") : chalk.yellow("✖")} addon-mcp registered in addons array`);
  console.log("");

  if (sbOk && hasAddon && inConfig) {
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

  if (!hasAddon) {
    const spec = addonMcpInstallSpec(sbVersion);
    const command = installCommand(pm, spec);
    const yes = await confirm(`Install ${spec} via ${pm}?`);
    if (yes) {
      try {
        execSync(command, { cwd: projectPath, stdio: "inherit" });
        installed = true;
      } catch (err) {
        console.log(chalk.red(`Install failed: ${String(err)}`));
        process.exitCode = 1;
        return;
      }
    } else {
      console.log(chalk.dim(`  Skipped. Run manually: ${command}`));
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
