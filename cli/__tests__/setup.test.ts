import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSetup } from "../setup.js";
import type { Client } from "../setup.js";
import { COMPARABLE_PROPERTIES } from "../verify.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "storysync-setup-"));
}

/** Runs setup and returns what it printed, without colour codes. */
function setupOutput(project: string, force: boolean, client: Client = "claude"): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    runSetup(client, project, force);
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

/** The YAML frontmatter of a rule or skill file, as key → raw value. */
function frontmatter(text: string): Map<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "file has no frontmatter block");
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const field = /^(\w+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2]);
  }
  return fields;
}

test("setup --client cursor installs a rule Cursor applies when the request matches", () => {
  const project = tempProject();
  try {
    setupOutput(project, false, "cursor");
    // Cursor reads project rules only as .mdc under .cursor/rules; a plain .md
    // there is ignored.
    const rule = join(project, ".cursor", "rules", "storysync.mdc");
    assert.ok(existsSync(rule));
    const fields = frontmatter(readFileSync(rule, "utf8"));
    // "Apply Intelligently": a description, alwaysApply false, and no globs.
    // Globs would make it attach by file pattern instead, and without a
    // description it applies only when @-mentioned.
    assert.equal(fields.get("alwaysApply"), "false");
    assert.equal(fields.has("globs"), false);
    const description = fields.get("description") ?? "";
    // Each magic phrase has to match it: push, verify, and audit.
    for (const word of [/push/i, /scor/i, /drift|audit/i]) assert.match(description, word);
    // A ": " inside an unquoted YAML value ends the scalar early.
    assert.equal(description.includes(": "), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup --client cursor prints a .cursor/mcp.json entry for Storybook", () => {
  const project = tempProject();
  try {
    const out = setupOutput(project, false, "cursor");
    assert.match(out, /\.cursor\/mcp\.json/);
    const snippet = out.split("\n").map((line) => line.trim()).find((line) => line.startsWith("{"));
    assert.ok(snippet, "no JSON printed");
    // Cursor's remote-server shape: mcpServers.<name>.url, no transport field.
    const config = JSON.parse(snippet) as { mcpServers: Record<string, { url?: string }> };
    assert.equal(config.mcpServers.storybook?.url, "http://localhost:6006/mcp");
    assert.match(out, /\/add-plugin figma/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the Cursor rule asks for every readback property the Claude template returns", () => {
  // The Claude skill's readback template is the one tested against a live
  // push. The Cursor rule describes the readback in prose instead, and verify
  // ignores any property it doesn't know by snap's name. The rule used to ask
  // for Figma's fields (fills, cornerRadius, strokeWeight) beside a few of
  // snap's, so verify could pass at 100% while fill, text colour, radius and
  // border were never compared.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "cursor");
    const claude = readFileSync(join(project, ".claude", "skills", "storysync", "SKILL.md"), "utf8");
    const cursor = readFileSync(join(project, ".cursor", "rules", "storysync.mdc"), "utf8");

    const template = /readback\[slugFor\(child\)\] = \{([\s\S]*?)\n\s*\};/.exec(claude);
    assert.ok(template, "Claude skill has no readback template");
    // Top-level keys only: padding's own fields sit on a deeper continuation line.
    const indent = /^( *)source:/m.exec(template[1])?.[1] ?? "";
    const keys = [...template[1].matchAll(new RegExp(`^${indent}(\\w+):`, "gm"))].map(([, key]) => key);
    assert.ok(keys.length > 5);
    // Only where the rule describes the readback: the snap-to-Figma mapping
    // further up names these too, but as inputs.
    const readbackStep = /properties back([\s\S]*?)figma-readback\.json/.exec(cursor);
    assert.ok(readbackStep, "Cursor rule never describes the readback");
    for (const key of keys) {
      assert.ok(key === "source" || (COMPARABLE_PROPERTIES as readonly string[]).includes(key), `${key} is not compared`);
      assert.ok(readbackStep[1].includes(`\`${key}\``), `Cursor rule's readback never asks for ${key}`);
    }

    // And it writes the file in the shape verify reads.
    const example = /figma-readback\.json`[^\n]*\n+```json\n([\s\S]*?)\n```/.exec(cursor);
    assert.ok(example, "Cursor rule shows no figma-readback.json");
    const file = JSON.parse(example[1]) as { version: number; components: Record<string, { variants: object }> };
    assert.equal(file.version, 1);
    for (const entry of Object.values(file.components)) assert.equal(typeof entry.variants, "object");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the Cursor rule says to run the commands that reach Storybook outside the sandbox", () => {
  // Cursor's sandbox blocks loopback addresses, so map, inspect and snap fail
  // inside it, and an agent that isn't told why reports Storybook as down.
  const project = tempProject();
  try {
    setupOutput(project, false, "cursor");
    const rule = readFileSync(join(project, ".cursor", "rules", "storysync.mdc"), "utf8");
    const passage = /\n## Running storysync from Cursor\n([\s\S]*?)\n## /.exec(rule)?.[1];
    assert.ok(passage, "Cursor rule has no section on running storysync");
    assert.match(passage, /sandbox/);
    assert.match(passage, /full permissions/);
    for (const command of ["map", "inspect", "snap"]) {
      assert.ok(passage.includes(`\`${command}\``), `the sandbox guidance never names ${command}`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup --client cursor says when Cursor will also load another editor's copy of the skill", () => {
  // Cursor loads .agents/skills and .claude/skills too, so the Codex or Claude
  // copy reaches its agent with setup lines meant for that editor.
  const project = tempProject();
  try {
    const alone = setupOutput(project, false, "cursor");
    assert.equal(/Cursor also loads/.test(alone), false);

    setupOutput(project, false, "codex");
    setupOutput(project, false, "claude");
    const out = setupOutput(project, false, "cursor");
    assert.match(out, /Cursor also loads \.agents\/skills\/storysync, the Codex copy of this skill/);
    assert.match(out, /Cursor also loads \.claude\/skills\/storysync, the Claude Code copy of this skill/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the Cursor rule names no step Cursor can't take", () => {
  const project = tempProject();
  try {
    setupOutput(project, false, "cursor");
    const rule = readFileSync(join(project, ".cursor", "rules", "storysync.mdc"), "utf8");
    // Claude Code commands, and an MCP protocol method no agent can call as a tool.
    for (const step of ["claude mcp", "claude plugin", "/storysync-push", "tools/list"]) {
      assert.equal(rule.includes(step), false, `rule mentions ${step}`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction keeps each use_figma call inside Figma's limits", () => {
  // use_figma takes at most 50,000 characters of code and returns at most
  // 20kb per call. A build that returned its own readback, or one call that
  // carried a whole set's slugs, stopped fitting well short of the 256
  // combinations snap measures by default.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    const files = [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
      join(".claude", "commands", "storysync-push.md"),
    ];
    for (const path of files) {
      const text = readFileSync(join(project, path), "utf8");
      assert.match(text, /50,000 characters of code/, `${path} never names use_figma's code limit`);
      assert.match(text, /20kb/, `${path} never names use_figma's response limit`);
      assert.doesNotMatch(text, /plugin code by reading/i, `${path} still has the build call read its own result back`);
      assert.match(text, /set's id/, `${path} never has the build return the set's id`);
      assert.match(text, /`total`/, `${path} never checks the slices against the set's total`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup --client codex installs a skill Codex discovers and leaves AGENTS.md alone", () => {
  const project = tempProject();
  try {
    // AGENTS.md is the project's own instructions. Writing the skill there was
    // skipped whenever one existed, and --force replaced it.
    const own = "# Team rules\n\n- Run the tests.\n";
    writeFileSync(join(project, "AGENTS.md"), own);
    for (const force of [false, true]) {
      setupOutput(project, force, "codex");
      assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), own);
    }
    // Codex scans .agents/skills/<name>/SKILL.md and needs a name and description.
    const head = readFileSync(join(project, ".agents", "skills", "storysync", "SKILL.md"), "utf8").slice(0, 1200);
    const frontmatter = head.match(/^---\nname: ([a-z0-9-]{1,64})\ndescription: (.+)\n---\n/);
    assert.ok(frontmatter, "SKILL.md has no name/description frontmatter");
    assert.equal(frontmatter[1], "storysync");
    assert.ok(frontmatter[2].length <= 1024);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup --client codex prints MCP setup Codex accepts", () => {
  const project = tempProject();
  try {
    const out = setupOutput(project, false, "codex");
    // Codex reads [mcp_servers.<name>] with a url; [mcp.<name>] with a type is
    // not its config, and the servers it described were never registered.
    assert.match(out, /codex mcp add storybook --url http:\/\/localhost:6006\/mcp/);
    assert.match(out, /codex mcp add figma --url https:\/\/mcp\.figma\.com\/mcp/);
    assert.equal(/\[mcp\./.test(out), false);
    assert.equal(/AGENTS\.md/.test(out), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup --client codex --force refreshes the skill with Codex's own setup", () => {
  // An earlier install, or one edited by hand, is replaced with --force, and
  // what replaces it tells Codex how to add the servers and use its sandbox.
  const project = tempProject();
  try {
    const skill = join(project, ".agents", "skills", "storysync", "SKILL.md");
    mkdirSync(join(project, ".agents", "skills", "storysync"), { recursive: true });
    writeFileSync(skill, "stale");
    setupOutput(project, true, "codex");
    const text = readFileSync(skill, "utf8");
    assert.notEqual(text, "stale");
    const tokens = text.indexOf("\n## Tokens\n");
    assert.ok(tokens > 0, "the skill has no Tokens section");
    const head = text.slice(0, tokens);
    assert.match(head, /codex mcp add/);
    assert.match(head, /\n## Codex's sandbox\n/);
    assert.equal(head.includes("[mcp."), false);
    assert.equal(head.includes('type = "http"'), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup --client codex says to remove the copy an earlier setup wrote to AGENTS.md", () => {
  const project = tempProject();
  try {
    const old = "# storysync — Storybook to Figma\n\nRead components from Storybook MCP.\n";
    writeFileSync(join(project, "AGENTS.md"), old);
    const out = setupOutput(project, false, "codex");
    assert.match(out, /Remove the storysync instructions from AGENTS\.md/);
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), old);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setup: the Codex skill carries the same procedure as the Claude skill", () => {
  // The Codex copy was condensed by hand and drifted: it lost the variant
  // naming rule, the readback's property names and its source default. Only
  // the client setup above the procedure may differ.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    const procedure = (path: string) => {
      const text = readFileSync(join(project, path), "utf8");
      const start = text.indexOf("\n## Tokens\n");
      assert.ok(start > 0, `${path} has no Tokens section`);
      return text.slice(start);
    };
    assert.equal(
      procedure(join(".agents", "skills", "storysync", "SKILL.md")),
      procedure(join(".claude", "skills", "storysync", "SKILL.md")),
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
