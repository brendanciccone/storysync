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

/**
 * Claude Code loads a skill from `skills/<name>/SKILL.md`, not a flat
 * `skills/<name>.md`, and requires YAML frontmatter with a name and
 * description. Written as a bare file the skill is silently never loaded —
 * `setup` reports success, the slash commands still work because commands do
 * accept flat files, and the plain-English trigger does nothing at all.
 */
const CLAUDE_SKILL_FRONTMATTER = [
  "---",
  "name: storysync",
  "description: Sync Storybook components and design tokens from code to Figma, measuring each variant's rendered styles rather than inferring them. Use when pushing a component library to Figma, scoring what landed against what rendered, or auditing drift between code and a Figma file.",
  "---",
  "",
].join("\n");

function setupClaude(projectPath: string, force: boolean): SetupResult {
  const skillsSrc = join(PACKAGE_ROOT, "skills", "claude-code.md");
  const skillsDest = join(projectPath, ".claude", "skills", "storysync", "SKILL.md");
  const legacySkillPath = join(projectPath, ".claude", "skills", "storysync.md");
  const commandsSrcDir = join(PACKAGE_ROOT, "commands");
  const commandsDestDir = join(projectPath, ".claude", "commands");

  const written: string[] = [];
  const skipped: string[] = [];
  const extraNotes: string[] = [];

  if (existsSync(skillsDest) && !force) {
    skipped.push(relative(projectPath, skillsDest));
  } else {
    const body = readFileSync(skillsSrc, "utf8");
    mkdirSync(dirname(skillsDest), { recursive: true });
    writeFileSync(skillsDest, body.startsWith("---") ? body : CLAUDE_SKILL_FRONTMATTER + body);
    written.push(relative(projectPath, skillsDest));
  }



  if (existsSync(commandsSrcDir)) {
    for (const file of readdirSync(commandsSrcDir)) {
      if (!file.endsWith(".md")) continue;
      const src = join(commandsSrcDir, file);
      const dest = join(commandsDestDir, file);
      if (copyIfMissing(src, dest, force) === "wrote") written.push(relative(projectPath, dest));
      else skipped.push(relative(projectPath, dest));
    }
  }

  // Commands kept from an earlier setup still send the agent to the old flat
  // skill path. Without --force they are skipped, so say so — otherwise the
  // skill is updated but the command that points at it is not.
  const staleCommands = existsSync(commandsDestDir)
    ? readdirSync(commandsDestDir).filter((file) =>
        file.startsWith("storysync") &&
        readFileSync(join(commandsDestDir, file), "utf8").includes(".claude/skills/storysync.md"))
    : [];
  if (staleCommands.length) {
    extraNotes.push(
      `${staleCommands.join(", ")} still point at .claude/skills/storysync.md. Re-run with --force to update them.`,
    );
  }
  // Earlier versions wrote the flat path, which never loaded. Only suggest
  // removing it once nothing points at it any more.
  if (existsSync(legacySkillPath)) {
    extraNotes.push(
      staleCommands.length
        ? `Then remove ${relative(projectPath, legacySkillPath)} — it predates the skill directory layout and is never loaded.`
        : `Remove ${relative(projectPath, legacySkillPath)} — it predates the skill directory layout and is never loaded.`,
    );
  }

  return {
    written,
    skipped,
    notes: [
      ...extraNotes,
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
