// `storysync setup` — drops the skill file, slash commands, and MCP config hints into a project.

import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

export type Client = "claude" | "cursor" | "codex";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "skills"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const PACKAGE_ROOT = findPackageRoot(__dirname);

function copyIfMissing(src: string, dest: string, force: boolean): "wrote" | "skipped" | "exists" {
  if (existsSync(dest) && !force) return "exists";
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return "wrote";
}

interface SetupResult {
  written: string[];
  skipped: string[];
  notes: string[];
}

function setupClaude(projectPath: string, force: boolean): SetupResult {
  const skillsSrc = join(PACKAGE_ROOT, "skills", "claude-code.md");
  const skillsDest = join(projectPath, ".claude", "skills", "storysync.md");
  const commandsSrcDir = join(PACKAGE_ROOT, "commands");
  const commandsDestDir = join(projectPath, ".claude", "commands");

  const written: string[] = [];
  const skipped: string[] = [];

  if (copyIfMissing(skillsSrc, skillsDest, force) === "wrote") written.push(relative(projectPath, skillsDest));
  else skipped.push(relative(projectPath, skillsDest));

  if (existsSync(commandsSrcDir)) {
    for (const file of readdirSync(commandsSrcDir)) {
      if (!file.endsWith(".md")) continue;
      const src = join(commandsSrcDir, file);
      const dest = join(commandsDestDir, file);
      if (copyIfMissing(src, dest, force) === "wrote") written.push(relative(projectPath, dest));
      else skipped.push(relative(projectPath, dest));
    }
  }

  return {
    written,
    skipped,
    notes: [
      "Add Storybook MCP:  claude mcp add --transport http storybook http://localhost:6006/mcp",
      "Add Figma plugin:    claude plugin install figma@claude-plugins-official",
      "Then in Claude Code: /storysync-push <figma-file-key>",
    ],
  };
}

function setupCursor(projectPath: string, force: boolean): SetupResult {
  const ruleSrc = join(PACKAGE_ROOT, "skills", "cursor.mdc");
  const ruleDest = join(projectPath, ".cursor", "rules", "storysync.mdc");

  const written: string[] = [];
  const skipped: string[] = [];

  if (copyIfMissing(ruleSrc, ruleDest, force) === "wrote") written.push(relative(projectPath, ruleDest));
  else skipped.push(relative(projectPath, ruleDest));

  return {
    written,
    skipped,
    notes: [
      "In Cursor settings, add Storybook MCP: http://localhost:6006/mcp",
      "In Cursor chat, run: /add-plugin figma",
      "Then say: \"Push my Storybook to Figma (file key: <key>)\"",
    ],
  };
}

function setupCodex(projectPath: string, force: boolean): SetupResult {
  const skillSrc = join(PACKAGE_ROOT, "skills", "codex.md");
  const agentsDest = join(projectPath, "AGENTS.md");

  const written: string[] = [];
  const skipped: string[] = [];

  if (existsSync(agentsDest) && !force) {
    skipped.push(relative(projectPath, agentsDest));
  } else {
    copyFileSync(skillSrc, agentsDest);
    written.push(relative(projectPath, agentsDest));
  }

  return {
    written,
    skipped,
    notes: [
      "Add Storybook + Figma MCP servers to .codex/config.toml:",
      "  [mcp.storybook] type = \"http\", url = \"http://localhost:6006/mcp\"",
      "  [mcp.figma]     type = \"http\", url = \"https://mcp.figma.com/mcp\"",
      "Then say: \"Push my Storybook to Figma (file key: <key>)\"",
    ],
  };
}

export function runSetup(client: Client, projectInput: string, force: boolean): void {
  const projectPath = resolve(projectInput);

  console.log(chalk.bold(`\nstorysync setup — ${client}`));
  console.log(chalk.dim(`Project: ${projectPath}\n`));

  let result: SetupResult;
  if (client === "claude") result = setupClaude(projectPath, force);
  else if (client === "cursor") result = setupCursor(projectPath, force);
  else result = setupCodex(projectPath, force);

  for (const f of result.written) console.log(`  ${chalk.green("✔")} wrote ${f}`);
  for (const f of result.skipped) console.log(`  ${chalk.dim("•")} ${chalk.dim(f)} ${chalk.dim("(exists, use --force to overwrite)")}`);

  if (result.notes.length) {
    console.log(`\n${chalk.bold("Next steps:")}`);
    for (const n of result.notes) console.log(`  ${chalk.dim(n)}`);
  }

  console.log("");
}
