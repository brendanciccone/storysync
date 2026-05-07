// `storysync setup` — drops the skill file, slash commands, and MCP config hints into a project.

import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { confirm } from "./init.js";

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
const CODEX_APPEND_MARKER = "<!-- storysync:start -->";

export interface SetupOptions {
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  // Skip the post-write Claude MCP/plugin auto-setup. Tests set this so
  // execSync doesn't actually invoke `claude` against the host system.
  skipMcp?: boolean;
}

export interface PlannedFile {
  src: string;
  dest: string;
  exists: boolean;
}

export interface SetupPlan {
  client: Client;
  copies: PlannedFile[];
  codexAppend: { dest: string; exists: boolean; alreadyHasMarker: boolean } | null;
}

function listClaudeFiles(projectPath: string): PlannedFile[] {
  const files: PlannedFile[] = [];
  const skillsSrc = join(PACKAGE_ROOT, "skills", "claude-code.md");
  const skillsDest = join(projectPath, ".claude", "skills", "storysync.md");
  files.push({ src: skillsSrc, dest: skillsDest, exists: existsSync(skillsDest) });

  const commandsSrcDir = join(PACKAGE_ROOT, "commands");
  if (existsSync(commandsSrcDir)) {
    for (const name of readdirSync(commandsSrcDir)) {
      if (!name.endsWith(".md")) continue;
      const src = join(commandsSrcDir, name);
      const dest = join(projectPath, ".claude", "commands", name);
      files.push({ src, dest, exists: existsSync(dest) });
    }
  }
  return files;
}

function listCursorFiles(projectPath: string): PlannedFile[] {
  const src = join(PACKAGE_ROOT, "skills", "cursor.mdc");
  const dest = join(projectPath, ".cursor", "rules", "storysync.mdc");
  return [{ src, dest, exists: existsSync(dest) }];
}

export function buildPlan(client: Client, projectPath: string): SetupPlan {
  if (client === "claude") {
    return { client, copies: listClaudeFiles(projectPath), codexAppend: null };
  }
  if (client === "cursor") {
    return { client, copies: listCursorFiles(projectPath), codexAppend: null };
  }
  // Codex: append to AGENTS.md if it exists, otherwise create it.
  const dest = join(projectPath, "AGENTS.md");
  const exists = existsSync(dest);
  const alreadyHasMarker = exists && readFileSync(dest, "utf8").includes(CODEX_APPEND_MARKER);
  return { client, copies: [], codexAppend: { dest, exists, alreadyHasMarker } };
}

function copyFile(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

// Wrap the imported skills/codex.md content in a delimited block so a later
// re-run can identify and replace the section without touching the rest of
// AGENTS.md. Trailing newline keeps the file tidy when other content follows.
function buildCodexAppendBlock(): string {
  const skillSrc = join(PACKAGE_ROOT, "skills", "codex.md");
  const body = readFileSync(skillSrc, "utf8").trim();
  return `\n\n${CODEX_APPEND_MARKER}\n## storysync\n\n${body}\n<!-- storysync:end -->\n`;
}

function isClaudeCliAvailable(): boolean {
  try {
    execSync("claude --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function claudeMcpAlreadyRegistered(name: string): boolean {
  try {
    const out = execSync("claude mcp list", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    // `claude mcp list` prints lines like "storybook  http://..."; just look
    // for the name as a word so we don't false-match a substring.
    return new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(out);
  } catch {
    return false;
  }
}

function claudePluginAlreadyInstalled(name: string): boolean {
  try {
    const out = execSync("claude plugin list", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    return new RegExp(`(^|\\s)${name}(@|\\s|$)`).test(out);
  } catch {
    return false;
  }
}

async function offerClaudeMcpSetup(opts: SetupOptions): Promise<string[]> {
  const messages: string[] = [];
  if (!isClaudeCliAvailable()) {
    messages.push(chalk.dim("`claude` CLI not on PATH — skipping MCP auto-setup."));
    messages.push(chalk.dim("  Add Storybook MCP:  claude mcp add --transport http storybook http://localhost:6006/mcp"));
    messages.push(chalk.dim("  Add Figma plugin:    claude plugin install figma@claude-plugins-official"));
    return messages;
  }

  if (claudeMcpAlreadyRegistered("storybook")) {
    messages.push(chalk.dim("• Storybook MCP already registered with Claude"));
  } else {
    const yes = opts.yes || (await confirm("Add Storybook MCP to Claude now?"));
    if (yes) {
      const cmd = "claude mcp add --transport http storybook http://localhost:6006/mcp";
      if (opts.dryRun) {
        messages.push(chalk.dim(`(dry-run) would run: ${cmd}`));
      } else {
        try {
          execSync(cmd, { stdio: "inherit" });
          messages.push(chalk.green("✔ Registered Storybook MCP with Claude"));
        } catch (err) {
          messages.push(chalk.red(`Failed to register Storybook MCP: ${String(err)}`));
        }
      }
    } else {
      messages.push(chalk.dim("Skipped — run manually: claude mcp add --transport http storybook http://localhost:6006/mcp"));
    }
  }

  if (claudePluginAlreadyInstalled("figma")) {
    messages.push(chalk.dim("• Figma plugin already installed"));
  } else {
    const yes = opts.yes || (await confirm("Install the Figma plugin for Claude now?"));
    if (yes) {
      const cmd = "claude plugin install figma@claude-plugins-official";
      if (opts.dryRun) {
        messages.push(chalk.dim(`(dry-run) would run: ${cmd}`));
      } else {
        try {
          execSync(cmd, { stdio: "inherit" });
          messages.push(chalk.green("✔ Installed Figma plugin"));
        } catch (err) {
          messages.push(chalk.red(`Failed to install Figma plugin: ${String(err)}`));
        }
      }
    } else {
      messages.push(chalk.dim("Skipped — run manually: claude plugin install figma@claude-plugins-official"));
    }
  }
  return messages;
}

async function applyPlan(plan: SetupPlan, projectPath: string, opts: SetupOptions): Promise<{ written: string[]; skipped: string[]; appended: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  const appended: string[] = [];

  // Copy phase: write fresh files, optionally with prompt-to-overwrite.
  for (const f of plan.copies) {
    const rel = relative(projectPath, f.dest);
    if (f.exists && !opts.force) {
      const ok = opts.yes || (await confirm(`Overwrite ${rel}?`));
      if (!ok) {
        skipped.push(rel);
        continue;
      }
    }
    if (opts.dryRun) {
      written.push(`${rel} ${chalk.dim("(dry-run)")}`);
    } else {
      copyFile(f.src, f.dest);
      written.push(rel);
    }
  }

  // Codex append phase.
  if (plan.codexAppend) {
    const { dest, exists, alreadyHasMarker } = plan.codexAppend;
    const rel = relative(projectPath, dest);
    if (alreadyHasMarker && !opts.force) {
      skipped.push(`${rel} ${chalk.dim("(storysync section already present)")}`);
    } else {
      const block = buildCodexAppendBlock();
      if (opts.dryRun) {
        appended.push(`${rel} ${chalk.dim(exists ? "(would append)" : "(would create)")}`);
      } else if (exists && !alreadyHasMarker) {
        appendFileSync(dest, block);
        appended.push(`${rel} ${chalk.dim("(appended)")}`);
      } else if (alreadyHasMarker && opts.force) {
        // Replace existing storysync block in-place.
        const cur = readFileSync(dest, "utf8");
        const updated = cur.replace(/\n*<!-- storysync:start -->[\s\S]*?<!-- storysync:end -->\n*/g, block);
        writeFileSync(dest, updated.trimStart().endsWith("\n") ? updated : updated + "\n");
        appended.push(`${rel} ${chalk.dim("(replaced)")}`);
      } else {
        // exists is false: write a new file with just the block (trim leading newlines).
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, block.trimStart());
        written.push(rel);
      }
    }
  }

  return { written, skipped, appended };
}

export async function runSetup(client: Client, projectInput: string, opts: SetupOptions): Promise<void> {
  const projectPath = resolve(projectInput);

  console.log(chalk.bold(`\nstorysync setup — ${client}${opts.dryRun ? chalk.yellow(" (dry-run)") : ""}`));
  console.log(chalk.dim(`Project: ${projectPath}\n`));

  const plan = buildPlan(client, projectPath);
  const { written, skipped, appended } = await applyPlan(plan, projectPath, opts);

  for (const f of written) console.log(`  ${chalk.green("✔")} wrote ${f}`);
  for (const f of appended) console.log(`  ${chalk.green("✚")} ${f}`);
  for (const f of skipped) console.log(`  ${chalk.dim("•")} ${chalk.dim(f)}`);

  // MCP auto-setup is currently Claude-only — Cursor and Codex still need
  // manual configuration in their own settings.
  if (client === "claude" && !opts.skipMcp) {
    console.log("");
    const notes = await offerClaudeMcpSetup(opts);
    for (const n of notes) console.log(`  ${n}`);
  } else if (client === "cursor") {
    console.log(`\n${chalk.bold("Next steps:")}`);
    console.log(chalk.dim("  In Cursor settings, add Storybook MCP: http://localhost:6006/mcp"));
    console.log(chalk.dim("  In Cursor chat, run: /add-plugin figma"));
    console.log(chalk.dim("  Then say: \"Push my Storybook to Figma (URL: <figma-url>)\""));
  } else {
    console.log(`\n${chalk.bold("Next steps:")}`);
    console.log(chalk.dim("  Add Storybook + Figma MCP servers to .codex/config.toml:"));
    console.log(chalk.dim("    [mcp.storybook] type = \"http\", url = \"http://localhost:6006/mcp\""));
    console.log(chalk.dim("    [mcp.figma]     type = \"http\", url = \"https://mcp.figma.com/mcp\""));
    console.log(chalk.dim("  Then say: \"Push my Storybook to Figma (URL: <figma-url>)\""));
  }

  console.log("");
}

// Re-exported for tests; lets harnesses confirm a planned write set without
// touching the filesystem.
export function describePlan(plan: SetupPlan): string[] {
  const lines: string[] = [];
  for (const f of plan.copies) {
    lines.push(`copy ${f.src} -> ${f.dest}${f.exists ? " (overwrite)" : ""}`);
  }
  if (plan.codexAppend) {
    if (plan.codexAppend.alreadyHasMarker) {
      lines.push(`codex: storysync section already present in ${plan.codexAppend.dest}`);
    } else if (plan.codexAppend.exists) {
      lines.push(`codex: append to ${plan.codexAppend.dest}`);
    } else {
      lines.push(`codex: create ${plan.codexAppend.dest}`);
    }
  }
  return lines;
}

// Lightweight helper to read AGENTS.md size — exposed so a test can verify
// append behavior without re-implementing path joining.
export function agentsFileLength(projectPath: string): number {
  const p = join(projectPath, "AGENTS.md");
  return existsSync(p) ? statSync(p).size : 0;
}
