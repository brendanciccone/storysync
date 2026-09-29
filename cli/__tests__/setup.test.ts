import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSetup } from "../setup.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "storysync-setup-"));
}

/** Runs setup and returns what it printed, without colour codes. */
function setupOutput(project: string, force: boolean): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    runSetup("claude", project, force);
  } finally {
    console.log = original;
  }
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

test("setup --client claude installs the skill as a directory Claude Code loads", () => {
  const project = tempProject();
  try {
    setupOutput(project, false);
    // Claude Code loads skills/<name>/SKILL.md with frontmatter; a flat
    // skills/<name>.md is silently never loaded.
    const skill = join(project, ".claude", "skills", "storysync", "SKILL.md");
    assert.ok(existsSync(skill));
    const head = readFileSync(skill, "utf8").slice(0, 400);
    assert.ok(head.startsWith("---\n"));
    assert.match(head, /\nname: storysync\n/);
    assert.match(head, /\ndescription: \S/);
    assert.equal(existsSync(join(project, ".claude", "skills", "storysync.md")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup: every path an installed command sends the agent to exists", () => {
  // Moving the skill without updating the commands leaves /storysync-push
  // pointing at nothing — the command runs, the agent never finds the procedure.
  const project = tempProject();
  try {
    setupOutput(project, false);
    const dir = join(project, ".claude", "commands");
    const files = readdirSync(dir);
    assert.ok(files.includes("storysync-push.md"));
    let references = 0;
    for (const file of files) {
      for (const [, path] of readFileSync(join(dir, file), "utf8").matchAll(/`(\.claude\/[^`\s]+)`/g)) {
        references++;
        assert.ok(existsSync(join(project, path)), `${file} points at ${path}, which setup did not create`);
      }
    }
    assert.ok(references > 0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup: re-running over an earlier install says to update the commands before removing the old skill", () => {
  const project = tempProject();
  try {
    // What an earlier version left behind: the flat skill, and a command that
    // points at it.
    mkdirSync(join(project, ".claude", "skills"), { recursive: true });
    mkdirSync(join(project, ".claude", "commands"), { recursive: true });
    writeFileSync(join(project, ".claude", "skills", "storysync.md"), "# old skill\n");
    const stale = "Use the storysync skill at `.claude/skills/storysync.md`.\n";
    writeFileSync(join(project, ".claude", "commands", "storysync-push.md"), stale);

    const out = setupOutput(project, false);

    // Without --force the stale command is kept, so removing the old skill
    // first would leave it pointing at nothing.
    assert.equal(readFileSync(join(project, ".claude", "commands", "storysync-push.md"), "utf8"), stale);
    assert.match(out, /storysync-push\.md still point at \.claude\/skills\/storysync\.md\. Re-run with --force/);
    assert.match(out, /Then remove \.claude\/skills\/storysync\.md/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup --force updates commands from an earlier install", () => {
  const project = tempProject();
  try {
    mkdirSync(join(project, ".claude", "commands"), { recursive: true });
    writeFileSync(join(project, ".claude", "commands", "storysync-push.md"), "at `.claude/skills/storysync.md`\n");

    const out = setupOutput(project, true);

    const updated = readFileSync(join(project, ".claude", "commands", "storysync-push.md"), "utf8");
    assert.equal(updated.includes(".claude/skills/storysync.md"), false);
    assert.equal(/Re-run with --force/.test(out), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
