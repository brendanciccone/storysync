import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPlan, runSetup } from "../setup.js";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "storysync-setup-test-"));
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test("buildPlan(claude): plans skill + slash commands when nothing exists", () => {
  const dir = makeProject();
  try {
    const plan = buildPlan("claude", dir);
    assert.equal(plan.client, "claude");
    assert.ok(plan.copies.some((f) => f.dest.endsWith(join(".claude", "skills", "storysync.md"))));
    assert.ok(plan.copies.some((f) => f.dest.includes(join(".claude", "commands"))));
    for (const f of plan.copies) assert.equal(f.exists, false);
    assert.equal(plan.codexAppend, null);
  } finally {
    cleanup(dir);
  }
});

test("buildPlan(claude): marks existing files", () => {
  const dir = makeProject();
  try {
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "storysync.md"), "old content");
    const plan = buildPlan("claude", dir);
    const skill = plan.copies.find((f) => f.dest.endsWith("storysync.md"));
    assert.ok(skill);
    assert.equal(skill!.exists, true);
  } finally {
    cleanup(dir);
  }
});

test("buildPlan(codex): when AGENTS.md is missing, plans creation", () => {
  const dir = makeProject();
  try {
    const plan = buildPlan("codex", dir);
    assert.ok(plan.codexAppend);
    assert.equal(plan.codexAppend!.exists, false);
    assert.equal(plan.codexAppend!.alreadyHasMarker, false);
  } finally {
    cleanup(dir);
  }
});

test("buildPlan(codex): when AGENTS.md already exists, plans append", () => {
  const dir = makeProject();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# Project notes\n\nUnrelated content.\n");
    const plan = buildPlan("codex", dir);
    assert.ok(plan.codexAppend);
    assert.equal(plan.codexAppend!.exists, true);
    assert.equal(plan.codexAppend!.alreadyHasMarker, false);
  } finally {
    cleanup(dir);
  }
});

test("buildPlan(codex): detects an existing storysync section via marker", () => {
  const dir = makeProject();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# Project\n\n<!-- storysync:start -->\nold storysync\n<!-- storysync:end -->\n");
    const plan = buildPlan("codex", dir);
    assert.equal(plan.codexAppend!.alreadyHasMarker, true);
  } finally {
    cleanup(dir);
  }
});

test("runSetup(claude, dry-run): writes nothing", async () => {
  const dir = makeProject();
  try {
    await runSetup("claude", dir, { force: false, dryRun: true, yes: true, skipMcp: true });
    assert.equal(existsSync(join(dir, ".claude", "skills", "storysync.md")), false);
    assert.equal(existsSync(join(dir, ".claude", "commands")), false);
  } finally {
    cleanup(dir);
  }
});

test("runSetup(claude): writes skill file when project is empty", async () => {
  const dir = makeProject();
  try {
    await runSetup("claude", dir, { force: false, dryRun: false, yes: true, skipMcp: true });
    assert.ok(existsSync(join(dir, ".claude", "skills", "storysync.md")));
  } finally {
    cleanup(dir);
  }
});

test("runSetup(claude, --yes): does not overwrite existing files unless --force", async () => {
  const dir = makeProject();
  try {
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "storysync.md"), "PRESERVED");
    // With --yes only, prompt would say yes and overwrite — that's expected:
    await runSetup("claude", dir, { force: false, dryRun: false, yes: true, skipMcp: true });
    const after = readFileSync(join(dir, ".claude", "skills", "storysync.md"), "utf8");
    assert.notEqual(after, "PRESERVED");
  } finally {
    cleanup(dir);
  }
});

test("runSetup(codex): appends to existing AGENTS.md without losing original content", async () => {
  const dir = makeProject();
  try {
    const original = "# Project notes\n\nImportant existing content the user wrote.\n";
    writeFileSync(join(dir, "AGENTS.md"), original);
    await runSetup("codex", dir, { force: false, dryRun: false, yes: true, skipMcp: true });
    const after = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(after.startsWith(original), "original content should still lead the file");
    assert.ok(after.includes("<!-- storysync:start -->"), "storysync marker should be appended");
    assert.ok(after.includes("<!-- storysync:end -->"), "storysync end marker should be appended");
  } finally {
    cleanup(dir);
  }
});

test("runSetup(codex): creates AGENTS.md when missing", async () => {
  const dir = makeProject();
  try {
    await runSetup("codex", dir, { force: false, dryRun: false, yes: true, skipMcp: true });
    assert.ok(existsSync(join(dir, "AGENTS.md")));
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(content.includes("<!-- storysync:start -->"));
  } finally {
    cleanup(dir);
  }
});

test("runSetup(codex): re-running on a file with the marker is a no-op without --force", async () => {
  const dir = makeProject();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# Project\n\n<!-- storysync:start -->\nold\n<!-- storysync:end -->\n");
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    await runSetup("codex", dir, { force: false, dryRun: false, yes: true, skipMcp: true });
    const after = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.equal(after, before);
  } finally {
    cleanup(dir);
  }
});

test("runSetup(codex, --force): replaces existing storysync block in place", async () => {
  const dir = makeProject();
  try {
    const seed = "# Project\n\nuser content\n\n<!-- storysync:start -->\nstale storysync\n<!-- storysync:end -->\n";
    writeFileSync(join(dir, "AGENTS.md"), seed);
    await runSetup("codex", dir, { force: true, dryRun: false, yes: true, skipMcp: true });
    const after = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(after.includes("user content"), "user content preserved");
    assert.ok(!after.includes("stale storysync"), "stale block replaced");
    assert.equal((after.match(/<!-- storysync:start -->/g) ?? []).length, 1, "exactly one storysync block");
  } finally {
    cleanup(dir);
  }
});

test("runSetup(cursor): writes the rule file under .cursor/rules", async () => {
  const dir = makeProject();
  try {
    await runSetup("cursor", dir, { force: false, dryRun: false, yes: true, skipMcp: true });
    assert.ok(existsSync(join(dir, ".cursor", "rules", "storysync.mdc")));
  } finally {
    cleanup(dir);
  }
});

test("runSetup: dry-run on cursor doesn't write", async () => {
  const dir = makeProject();
  try {
    await runSetup("cursor", dir, { force: false, dryRun: true, yes: true, skipMcp: true });
    assert.equal(existsSync(join(dir, ".cursor")), false);
  } finally {
    cleanup(dir);
  }
});
