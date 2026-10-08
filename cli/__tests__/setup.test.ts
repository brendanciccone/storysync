import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSetup } from "../setup.js";
import type { Client } from "../setup.js";
import { COMPARABLE_PROPERTIES, READBACK_FIELDS, readbackChecksum, checkReadback } from "../verify.js";
import type { ReadbackFile } from "../verify.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "storysync-setup-"));
}

/** Runs setup and returns what it printed, without color codes. */
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

test("setup: a storysync folder or a dangling link among the commands is not taken for a stale command", () => {
  const project = tempProject();
  try {
    const commands = join(project, ".claude", "commands");
    // Claude Code reads a folder of commands as a namespace: /storysync:release.
    mkdirSync(join(commands, "storysync"), { recursive: true });
    writeFileSync(join(commands, "storysync", "release.md"), "# release\n");
    mkdirSync(join(commands, "storysync-archive.md"));
    if (process.platform !== "win32") symlinkSync(join(project, "nowhere.md"), join(commands, "storysync-old.md"));
    // A real stale command beside them is still reported.
    writeFileSync(join(commands, "storysync-push.md"), "at `.claude/skills/storysync.md`\n");

    const out = setupOutput(project, false);

    assert.match(out, /wrote \.claude\/skills\/storysync\/SKILL\.md/);
    assert.match(out, /^\s+storysync-push\.md still point at \.claude\/skills\/storysync\.md\. Re-run with --force/m);
    assert.match(out, /Next steps:/);
    assert.equal(readFileSync(join(commands, "storysync", "release.md"), "utf8"), "# release\n");
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
  // snap's, so verify could pass at 100% while fill, text color, radius and
  // border were never compared.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "cursor");
    const claude = readFileSync(join(project, ".claude", "skills", "storysync", "SKILL.md"), "utf8");
    const cursor = readFileSync(join(project, ".cursor", "rules", "storysync.mdc"), "utf8");

    const template = /readback\[slug\] = seal\(componentSet\.id, slug, \{([\s\S]*?)\n\s*\}\);/.exec(claude);
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
    // And the checksum the template seals each entry with.
    assert.ok(readbackStep[1].includes("`checksum`") && readbackStep[1].includes("`readAt`")
      && readbackStep[1].includes("seal(componentSet.id, slug, fields)"),
      "Cursor rule's readback never seals an entry, under its set's id, with its readAt and checksum");

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

test("the Claude and Codex skills call no MCP protocol method as a tool", () => {
  // tools/list is how a client asks a server for its tools; an agent has no
  // tool by that name, so a step that says to call it can't be followed.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    for (const path of [join(".claude", "skills", "storysync", "SKILL.md"), join(".agents", "skills", "storysync", "SKILL.md")]) {
      assert.equal(readFileSync(join(project, path), "utf8").includes("tools/list"), false, `${path} mentions tools/list`);
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

test("every push instruction re-pushes in place and says what to do when a readback throws", () => {
  // A part that only added its variants doubled every one of them on a second
  // push, and one that looked for the set only at its page's top level built
  // a second set beside one a designer had moved into a section. The readback
  // throws on a variant the set lacks or holds twice, and on a slice too big
  // to return, and each needs its own remedy: lowering BATCH alone does not
  // shrink a call that already carries its names.
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
      assert.match(text, /anywhere on its page/, `${path} looks for the set only at its page's top level`);
      assert.match(text, /adds only the ones the set lacks/, `${path} never has a part add only the variants the set lacks`);
      assert.match(text, /never creates a second variant/, `${path} lets a part create a variant the set already has`);
      assert.doesNotMatch(text, /finds it by id and adds the next 25/, `${path} still has each part add its variants`);
      // Where step 5 leaves alone a variant no part names: the listing's own
      // "delete one only if the user asks" further on would satisfy it too.
      assert.match(text, /named by no part[^\n]*only if the user asks/, `${path} never says to ask before deleting a variant snap no longer has`);
      assert.match(text, /two of a name it carries/, `${path} never says a part refuses a set holding two of a name it carries`);
      if (path !== join(".claude", "commands", "storysync-push.md")) {
        // The build template's applyStyles, and the rule's prose for it, run on
        // variants an earlier push made, which already have their label.
        assert.match(text, /variant\.findOne\(\(n\) => n\.type === 'TEXT'\)/, `${path} never says to reuse the label an earlier push made`);
      }
      assert.match(text, /`The set has 0 variants named …`[^\n]*re-run the build part/, `${path} gives no remedy for a variant the set lacks`);
      assert.match(text, /`The set has 2 variants named …`[^\n]*(?:ask the user|which one is current)/, `${path} gives no remedy for a variant made twice`);
      assert.match(text, /split its names across two calls/, `${path} says only to lower BATCH for a slice too big to return`);
      assert.match(text, /children\.slice\(START, START \+ (?:BATCH|100)\)/, `${path} never lists the set's names a slice at a time`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction lays the set out again after re-running a part", () => {
  // A part re-run to add a variant the readback found missing appended it at
  // 0,0 on top of another, where nothing checked for overlaps, when only the
  // last part laid the set out. Every part lays the whole set out now, so a
  // part re-run on its own leaves the set laid out.
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
      assert.match(text, /every part lays the whole set out again and checks it, so a part re-run on its own leaves the set laid out/i, `${path} lets a re-run part leave the set unlaid`);
      assert.doesNotMatch(text, /only the last part lays/i, `${path} still has only the last part lay the set out`);
      assert.match(text, /`The set has 0 variants named …`[^`]*re-run the build part that names it, which adds only [^`]*and lays the whole set out again[^`]*then read that slice again/,
        `${path} adds a missing variant without laying the set out again`);
      // A part refused for a variant the set holds twice changed nothing, so
      // the slice it would have built is still to build.
      assert.match(text, /`The set has 2 variants named …`[^\n]*raised it, the refused part changed nothing, and the parts after it never ran: re-run that build part and every part after it, through the last part, then read the slices/,
        `${path} never re-runs a build part the doubled variant refused`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction lays a set out in snap's order, not its children's", () => {
  // A re-push laid a set out in the order an earlier build had left its
  // children in, so the primary row's columns read sm, lg, sm disabled, lg
  // disabled and the others' sm, sm disabled, lg disabled, lg. The layout
  // follows snap's variantProperties as snap records them, each VARIANT's
  // default first and the rest as Storybook's docs list them, a BOOLEAN's
  // default first too, and the layers panel, which shows the last child at
  // the top, reads the same way. Figma takes the set's default variant from
  // the top-left, which is then the component's default, and the agent says
  // which it is when it is not.
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
      assert.match(text, /`variantProperties`[^\n]*copied as they are/, `${path} never has each part carry snap's variantProperties`);
      assert.match(text, /never by the set's children/, `${path} lets the layout follow the set's child order`);
      assert.match(text, /in the order snap records them: a `VARIANT`'s default value first, then the rest in the order of the component's prop type as Storybook's docs list it \(a story's `argTypes` options are not read\)/,
        `${path} never says the values run default first, then in Storybook's declared order`);
      assert.doesNotMatch(text, /not default first/, `${path} still says snap's values are not default first`);
      assert.doesNotMatch(text, /all-defaults variant[^\n]*top-left/, `${path} says the all-defaults variant is the top-left one, which it is not where a BOOLEAN defaults to true`);
      assert.match(text, /a `BOOLEAN` property runs its default first, `false, true`, or `true, false` when it defaults to `true`/i,
        `${path} never says a BOOLEAN property runs its default first`);
      assert.doesNotMatch(text, /`false` for a `BOOLEAN`, even one that defaults to `true`|`open=false` even if the component defaults to `open=true`/,
        `${path} still makes false Figma's default for a BOOLEAN that defaults to true`);
      assert.match(text, /Figma makes the top-left variant the set's default variant/, `${path} never says where Figma takes the default variant from`);
      assert.match(text, /the component's own default for a `VARIANT`, since snap records it first, and for a `BOOLEAN`/,
        `${path} never says Figma's default is the component's own`);
      assert.match(text, /`open=true` where the component defaults to `open=true`/, `${path} gives no example of a BOOLEAN that defaults to true`);
      assert.match(text, /say in the summary which variant Figma will treat as the default/, `${path} never has the agent report Figma's default`);
      assert.match(text, /A property marked `defaultAssumed: true` has no default in Storybook's docs, so its `defaultValue` is a guess: name those in the summary too\./,
        `${path} never has the agent report a default snap had to guess`);
      assert.match(text, /^\d+\. Summarize[^\n]*which variant Figma will treat as a set's default where that is not the component's default/m,
        `${path}'s summary step leaves out Figma's default variant`);
      assert.match(text, /With one property, each value is a row of one/i, `${path} never says how one property is laid out`);
      assert.match(text, /three rows, primary, danger and outline, of four columns: sm, sm disabled, lg, lg disabled/, `${path} gives no example of the grid`);
      assert.match(text, /a row of its own below the others/, `${path} never says where a variant snap does not have goes`);
      assert.match(text, /last child at the top/, `${path} never says the layers panel shows the last child at the top`);
      assert.match(text, /`extra`/, `${path} never has the build count the variants snap does not have`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction refuses a set with auto layout and checks each variant's place", () => {
  // On a set with auto layout, x and y do nothing and the layer order flows
  // the variants, the last one into the top-left, while every other check
  // passes. The build refuses such a set before changing anything and asks
  // the user, and checks each variant is where the layout put it. Cells come
  // from the set's own variants, not every combination, which 20 BOOLEANs
  // take past a million, and a name's lower-id copy stays in the grid.
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
      assert.match(text, /`layoutMode` is not `'NONE'`[^\n]*before changing anything/, `${path} never refuses a set with auto layout`);
      assert.match(text, /ask the user whether to turn auto layout off on the set[^\n]*or to leave its layout alone and skip the set/i,
        `${path} never says what to ask the user about a set with auto layout`);
      assert.match(text, /^\d+\. Summarize[^\n]*any set skipped for its auto layout/m, `${path}'s summary step leaves out a set skipped for its auto layout`);
      assert.match(text, /every variant is where the layout put it, so a move Figma ignored fails/, `${path} never checks each variant's position`);
      assert.match(text, /the work grows with the set's variants, not with every combination/, `${path} lays a set out from every combination`);
      assert.match(text, /the one whose node id sorts first as text stays in the grid/, `${path} never says which copy of a name stays in the grid`);
      assert.match(text, /moving only (?:those|the ones) out of place|`appendChild`-ing only the rest/, `${path} moves every variant on every part`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction reads a variant's size from its geometry and keeps a transparent border's stroke", () => {
  // A live push read 24 soft Chips 2px short each way. Their CSS border is
  // transparent, and the readback took the size from Figma's render bounds,
  // which leave out a stroke that paints nothing and take in drop shadows,
  // where snap's border box keeps the border's space and leaves the shadow
  // out. The build keeps a transparent border as a stroke whose paint draws
  // nothing, and the readback adds the stroke outside the node by strokeAlign.
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
      assert.doesNotMatch(text, /\(child\.absoluteRenderBounds \|\| child\)|from `absoluteRenderBounds`(?:, not| so)/, `${path} still reads a variant's size from its render bounds`);
      assert.match(text, /never (?:take width and height from )?`?absoluteRenderBounds/i, `${path} never says not to read the size from render bounds`);
      assert.match(text, /own (?:`width` and `height`|width and height|size) (?:and add|plus) the stroke (?:that lies )?outside/, `${path} never adds the stroke outside the node to its size`);
      assert.match(text, /transparent border[^\n]*a paint that draws nothing/, `${path} never keeps a transparent border as a stroke`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction reports a pixel of text width as a font-rendering difference", () => {
  // The same push drifted on 8 small bold Chips that Figma set 40 wide where
  // Chrome measured 38.59. Nothing in the node is wrong, and squeezing the
  // text box to fit would only trade the drift for a clipped label. But an
  // INSIDE stroke on a frame that hugs its text leaves it exactly twice the
  // border short, 2px for a 1px border, as does a transparent border built
  // with no stroke, so the rule holds only for a stroke OUTSIDE or none, and
  // a difference other than twice the border.
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
      assert.match(text, /`width` a pixel or two off on a variant that hugs its text[^\n]*font-rendering difference[^\n]*clip the label/,
        `${path} never says to report a pixel of text width as a font-rendering difference`);
      assert.match(text, /font-rendering difference[^\n]*only when the variant's stroke is `OUTSIDE`, `INSIDE` with `strokesIncludedInLayout`, or it has none, and the difference is not exactly twice the measured border's weight\. Otherwise check its `strokeAlign` first: an `INSIDE` stroke on a hugging frame without `strokesIncludedInLayout` leaves the variant short by exactly twice the border/,
        `${path} calls a stroke built INSIDE a font-rendering difference`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction reads a translucent color back with its alpha, and a hidden paint as null", () => {
  // snap writes a translucent color as #rrggbbaa, a soft Chip's background
  // #4b556322, and verify compares colors as written. The readback converted
  // only the paint's color, so every translucent fill and stroke drifted:
  // Figma keeps the alpha in the paint's opacity. A paint hidden with the eye
  // icon draws nothing at any opacity, as snap records a transparent border.
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
      assert.doesNotMatch(text, /toHex\((?:fill|stroke|text\.fills\[0\])\.color\)|fill as `#rrggbb`/, `${path} still reads a color without its alpha`);
      assert.match(text, /alpha[^\n]*(?:as )?two more (?:lowercase )?hex digits/, `${path} never appends a translucent color's alpha`);
      assert.match(text, /`?#rrggbbaa`?[^\n]*`?opacity`?/, `${path} never says a translucent color's alpha is its paint's opacity`);
      assert.match(text, /visible: false/, `${path} never reads a hidden paint as drawing nothing`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction sets itemSpacing from the gap along the layout's direction", () => {
  // Figma's itemSpacing is the main-axis gap. The table said gap.column for
  // every layout, which is 0 for a flex column's gap-y-3, where the items
  // are 12 apart.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    const files = [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
    ];
    for (const path of files) {
      const text = readFileSync(join(project, path), "utf8");
      assert.match(text, /`gap\.column`, or `gap\.row` when `flexDirection` is `column` or `column-reverse`,? (?:\||→) `itemSpacing`/,
        `${path} sets itemSpacing from gap.column whatever the layout's direction`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction builds an inset shadow as an inner shadow, and says verify doesn't read shadows back", () => {
  // snap records inset, but the table built every layer as a DROP_SHADOW, so
  // an input's ring-1 ring-inset border, and shadow-inner, landed outside the
  // element, and nothing scored it.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    const files = [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
    ];
    for (const path of files) {
      const text = readFileSync(join(project, path), "utf8");
      const row = /`boxShadow\[\]` (?:\||→)([^|\n]*)/.exec(text)?.[1] ?? "";
      assert.match(row, /`INNER_SHADOW` where `inset` is true[^\n]*else `DROP_SHADOW`/, `${path} builds every shadow layer as a drop shadow`);
      assert.match(row, /`offset` from `offsetX`\/`offsetY`, `radius` from `blur`, and `spread`/, `${path} never says how a layer's lengths map`);
      assert.match(row, /`verify` (?:does not|doesn't) read effects back/, `${path} lets a shadow pass for scored`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

/**
 * The readback template an instruction file gives the agent, run as written
 * on these variants of one set: its two tables are filled in for them, and
 * `figma` serves the set by its id. Returns what the call returns, parsed.
 */
async function runReadback(text: string, path: string, children: Record<string, unknown>[]): Promise<{ readback: Record<string, Record<string, unknown>> }> {
  const at = text.indexOf("const SLUG_BY_NAME");
  assert.ok(at > 0, `${path} has no readback template`);
  const code = text.slice(text.lastIndexOf("code: `", at) + "code: `".length, text.indexOf("`,", at));
  const table = (name: string, entries: Record<string, string>) => (src: string) =>
    src.replace(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\s*\\};`), () => `const ${name} = ${JSON.stringify(entries)};`);
  const names = children.map((child) => String(child.name));
  const body = [
    table("SLUG_BY_NAME", Object.fromEntries(names.map((name) => [name, name]))),
    table("SOURCE_BY_SLUG", Object.fromEntries(names.map((name) => [name, "measured"]))),
  ].reduce((src, fill) => fill(src), code);
  const set = { id: "12:34", type: "COMPONENT_SET", name: "Dropzone", children };
  const figma = { getNodeByIdAsync: async () => set };
  const run = new Function("figma", `return (async () => {${body}})();`) as (f: unknown) => Promise<string>;
  return JSON.parse(await run(figma));
}

test("every push instruction builds a border's style as a dash pattern and reads it back from one", async () => {
  // snap measures a dashed border as dashed, but the table built every
  // border as a plain stroke, and the readback wrote style 'solid' whatever
  // the stroke, so a dashed dropzone pushed solid verified clean.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    // A frame with a stroke of width w, dashed as the table says.
    const node = (name: string, w: number, dashPattern: number[]) => ({
      name, fills: [], strokes: [{ type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 }, opacity: 1 }], dashPattern,
      strokeWeight: w, strokeTopWeight: w, strokeRightWeight: w, strokeBottomWeight: w, strokeLeftWeight: w, strokeAlign: "OUTSIDE",
      cornerRadius: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, layoutMode: "NONE", itemSpacing: 0,
      opacity: 1, width: 100, height: 40, findOne: () => null,
    });
    for (const path of [join(".claude", "skills", "storysync", "SKILL.md"), join(".agents", "skills", "storysync", "SKILL.md")]) {
      const text = readFileSync(join(project, path), "utf8");
      const row = /^ *\| `borderUniform` \|[^\n]*/m.exec(text)?.[0] ?? "";
      assert.match(row, /`style` as the stroke's `dashPattern`, for a width `w`: none for `solid`, `\[3w, 3w\]` for `dashed`, `\[w, w\]` for `dotted`/, `${path} builds every border as a solid stroke`);
      assert.match(row, /`double`, `groove`, `ridge`, `inset` or `outset`: build those solid, and name them in the summary/, `${path} never says what to do with a style Figma's strokes lack`);
      const { readback } = await runReadback(text, path, [
        node("solid", 2, []), node("dashed", 2, [6, 6]), node("dotted", 2, [2, 2]),
        node("thin-dashed", 1, [3, 3]), node("thick-dotted", 4, [4, 4]),
      ]);
      const styles = Object.fromEntries(Object.entries(readback).map(([slug, entry]) => [slug, (entry.borderUniform as { style: string }).style]));
      assert.deepEqual(styles, { solid: "solid", dashed: "dashed", dotted: "dotted", "thin-dashed": "dashed", "thick-dotted": "dotted" }, `${path} reads back a border's style`);
      // One whose sides' weights differ, so strokeWeight is figma.mixed, is read against its top's.
      const mixed = { ...node("mixed", 2, [6, 6]), strokeWeight: Symbol("figma.mixed"), strokeBottomWeight: 4 };
      const { readback: odd } = await runReadback(text, path, [mixed]);
      assert.equal((odd.mixed.borderUniform as { style: string }).style, "dashed", `${path} reads a dashed stroke of mixed weight`);
    }
    const cursor = readFileSync(join(project, ".cursor", "rules", "storysync.mdc"), "utf8");
    assert.match(cursor, /`borderUniform` → stroke[^\n]*`style` as the stroke's `dashPattern`, for a width `w`: none for `solid`, `\[3w, 3w\]` for `dashed`, `\[w, w\]` for `dotted`/, "the Cursor rule builds every border as a solid stroke");
    assert.match(cursor, /^ *- `borderUniform` — [^\n]*`style` is the border style the stroke's `dashPattern` was built from/m, "the Cursor rule's readback writes every border's style as solid");
    assert.doesNotMatch(cursor, /style: "solid"/, "the Cursor rule's readback writes every border's style as solid");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction builds a transparent border to fill as the browser does, by backgroundClip", () => {
  // The skill said the browser always paints the background under a
  // transparent border, and had the summary call every OUTSIDE ring wrong.
  // That holds only where the background is not clipped: shadcn's Button
  // has bg-clip-padding, so its fill stops at the border as Figma's does at
  // an OUTSIDE stroke, and its Badge doesn't, so its fill runs under the
  // border, as Figma's does under an INSIDE stroke that strokesIncludedInLayout
  // keeps in the hugging frame's size.
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
      assert.doesNotMatch(text, /In the browser the background runs under a transparent border, where Figma's fill stops/, `${path} still says the browser always fills under a transparent border`);
      assert.match(text, /`backgroundClip`[^\n]*padding-box`[^\n]*`OUTSIDE`[^\n]*`INSIDE`, with `strokesIncludedInLayout = true` on a hugging frame/,
        `${path} never builds a transparent border by backgroundClip`);
      // One rule for a hugging frame, which used to say INSIDE only at a
      // fixed size, then INSIDE on a hugging frame, and OUTSIDE at a fixed
      // size "less the border", a border's width too large.
      assert.match(text, /hugging frame[^\n]*OUTSIDE'?`, or `INSIDE` with `strokesIncludedInLayout = true`/, `${path} never builds a border INSIDE in a hugging frame's layout`);
      assert.doesNotMatch(text, /Use `INSIDE` only when you give the frame a fixed size/, `${path} still allows INSIDE only at a fixed size`);
      assert.doesNotMatch(text, /sized to the measured size less the border\b/, `${path} still sizes a padding-box frame less one border`);
      const summary = /^\d+\. Summarize[^\n]*/m.exec(text);
      assert.ok(summary, `${path} has no summary step`);
      assert.match(summary[0], /transparent or translucent border, say how its fill meets that border[^\n]*`backgroundClip: padding-box` the fill stops at the border, and Figma's `OUTSIDE` stroke leaves the same unfilled ring; without it the fill runs under the border, built as an `INSIDE` stroke with `strokesIncludedInLayout`/,
        `${path}'s summary never says how a transparent border's fill was built`);
      assert.match(summary[0], /unfilled ring the browser fills[^\n]*stroke tinted[^\n]*`verify` will then score as a border colou?r the code does not have/,
        `${path}'s summary never says when a ring is unfilled where the browser fills it`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction builds a component with no variant properties as one plain component", () => {
  // A live push built Button, Badge, Dialog and Tooltip, which have no variant
  // properties, as sets of one variant named '', which Figma renamed "=" and
  // marked as broken, so the readback and the audit threw on them. Such a
  // component is one plain component, read back as its one variant, named
  // '', under the slug default, and a broken set an earlier push left is
  // refused rather than built beside.
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
      assert.match(text, /no variant properties is one plain component/, `${path} builds a component with no variant properties as a set`);
      assert.match(text, /renames (?:a set's one unnamed variant )?`=` and marks (?:the set )?as broken/, `${path} never says why a set of one unnamed variant is wrong`);
      assert.match(text, /plain component[^\n]*`''`[^\n]*`default`/, `${path} never says how a plain component reads back`);
      assert.match(text, /ask the user whether to convert it/, `${path} never asks before converting what an earlier push left`);
      if (!path.includes("commands")) {
        // appendChild moved the variant onto the page at its place inside the
        // set, near 0,0, and out of any section the set was in.
        assert.match(text, /parent\.insertChild\(parent\.children\.indexOf\(set\), variant\); Object\.assign\(variant, \{ x, y, name \}\)/,
          `${path} never puts a converted variant where its set was`);
        assert.doesNotMatch(text, /page\.appendChild\(variant\)/, `${path} still moves a converted variant onto the page`);
      }
      assert.match(text, /^\d+\. Summarize[^\n]*built as one plain component/m, `${path}'s summary leaves out the plain components`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction places a new set below the page's others and keeps its Storybook id on it", () => {
  // Every set a live push created landed at 0,0, on top of the others.
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
      assert.match(text, /100 below (?:the lowest thing there|everything on its page)/, `${path} never says where a new set goes`);
      assert.match(text, /[sg]etSharedPluginData\('storysync', 'id'/, `${path} never keeps the Storybook id on a set`);
      // Sets a push before 0.4.0 left stacked at 0,0 are counted, never moved
      // unasked.
      assert.match(text, /`overlaps`[^\n]*never move one on your own/, `${path} never reports sets an earlier push stacked`);
      assert.match(text, /^\d+\. Summarize[^\n]*`overlaps`/m, `${path}'s summary leaves out stacked sets`);
      // A copy of a set keeps its id, so the id is a fallback for a renamed set.
      assert.match(text, /by its name, (?:and |or )?where (?:none|nothing) has the name,? by (?:that id|the Storybook id it carries)/,
        `${path} never finds a set by its name before its id`);
      assert.match(text, /findAllWithCriteria\(\{ types: \['COMPONENT_SET', 'COMPONENT'\] \}\)/, `${path} never looks for a plain component`);
      assert.match(text, /designer's own/, `${path} takes a designer's own plain component for one a push built`);
      assert.doesNotMatch(text, /Look for it anywhere on its page with `page\.findAllWithCriteria\(\{ types: \['COMPONENT_SET'\] \}\)`|\(`page\.findAllWithCriteria\(\{ types: \['COMPONENT_SET'\] \}\)`, since a designer/,
        `${path} still looks for a set by name among sets alone`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction keeps a bound color's alpha and never fails over a font", () => {
  // A live push bound Attachment's #df22254d border to the destructive
  // variable and read it back #df2225: Figma resets a paint assigned freshly
  // bound to opacity 1. And Figma's plugin context loads neither a CSS
  // keyword such as system-ui nor a platform face such as Menlo.
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
      assert.match(text, /opacity (?:of )?1/, `${path} never says Figma resets a bound paint's opacity`);
      assert.match(text, /Roboto Mono[^\n]*Inter|Inter[^\n]*Roboto Mono/, `${path} names no stand-in for a font Figma can't load`);
      assert.match(text, /Noto Serif for a serif/, `${path} sets a serif face in Inter`);
      assert.match(text, /next one toward `?Regular`?/, `${path} never says which weight a family that lacks one loads`);
      assert.match(text, /never (?:let a font fail the push|fails the part over a font)/i, `${path} lets a font fail the push`);
      assert.match(text, /^\d+\. Summarize[^\n]*every font stand-in the build parts returned in `fonts`/m, `${path}'s summary leaves out the font stand-ins`);
      assert.doesNotMatch(text, /the Google font used for a `fontFamily` that is a CSS keyword/, `${path} still names only a keyword's stand-in`);
    }
    for (const path of files.slice(0, 2)) {
      const text = readFileSync(join(project, path), "utf8");
      assert.match(text, /const setPaints = /, `${path}'s build template has no setPaints`);
      assert.match(text, /const loadFont = /, `${path}'s build template has no loadFont`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction prices a part at real entries, and builds a long one in smaller parts", () => {
  // A live shadcn/ui snap's entries come to about a thousand characters, and
  // 25 of Command's with the template and a push's own code came to some
  // 48,000, near use_figma's 50,000. The skill said a few hundred, and never
  // said to shrink a part.
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
      assert.doesNotMatch(text, /measured values run to a few hundred characters/, `${path} still prices an entry at a few hundred characters`);
      assert.match(text, /passes 45,000 characters, build that set in parts of 15 instead/, `${path} never says to build a long part smaller`);
      assert.match(text, /`border`[^\n]*`borderUniform`[^\n]*`borderRadius`[^\n]*`borderRadiusUniform`[^\n]*repeat/, `${path} never leaves the repeated border fields out`);
    }
    for (const path of files.slice(0, 3)) {
      assert.match(readFileSync(join(project, path), "utf8"), /about a thousand characters/, `${path} never says how long an entry runs`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction sets FLOAT variables from px, and leaves out a token whose var() didn't resolve", () => {
  // Told only to convert rem, the agent did shadcn/ui's calc() radii by
  // hand, or passed the string to a FLOAT variable, and took
  // `var(--font-sans)` for a font family. Told to leave out any value with
  // a var(), it dropped :root's `calc(var(--radius) - 4px)`, which has its
  // px; and with no px from an older storysync, every length.
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
      assert.match(text, /setting each `FLOAT` variable from its token's `px`|Set each `FLOAT` variable from its token's `px`/, `${path} never sets FLOAT variables from px`);
      assert.match(text, /`calc\(0\.625rem - 4px\)` is 6/, `${path} never says px works out calc()`);
      assert.match(text, /leave out[^\n]*any token a `tokens` warning starting `Unresolved:` names/i, `${path} sets a token whose var() didn't resolve`);
      assert.doesNotMatch(text, /any token whose `value` still holds a `var\(\)`/, `${path} leaves out tokens whose var() resolved`);
      assert.match(text, /If no token (?:in the output )?has a `px` at all, an older storysync ran: use a plain rem `value` times 16/, `${path} drops every length when an older storysync gives no px`);
      assert.doesNotMatch(text, /Convert rem values to px/, `${path} still has the agent convert rem itself`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every audit instruction compares a length by its px and a color by its hex", () => {
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    const files = [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
      join(".claude", "commands", "storysync-diff.md"),
    ];
    for (const path of files) {
      const text = readFileSync(join(project, path), "utf8");
      assert.match(text, /Normalize before comparing: compare a color by its token's `hex` and a [^\n]*by its `px`/, `${path} compares calc() radii as text`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction offers --exclude-props for a capped component", () => {
  // Told to "narrow which props are variants", the agent had no way to: the
  // CLI took every boolean, behavioral ones like vaul's Drawer's included.
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
      assert.match(text, /narrow which props are variants: re-run snap with `--exclude-props` naming the props that don't change how it looks/, `${path} offers no way to narrow a capped component's props`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction re-measures with --merge, runs snap in the background, and asks about what snap measured instead", () => {
  // Told to re-run timed-out components with --components alone, the agent
  // wrote a styles.json of those, and the push's verify scored part of the
  // push. A foreground snap outlasted the agent's shell and wrote nothing,
  // and a dialog's closed trigger was built and labeled measured.
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
      assert.match(text, /npx storysync list --storybook http:\/\/localhost:6006 --json/, `${path} doesn't count the components first`);
      assert.match(text, /more than about 20 components, stop and ask the user what to push/, `${path} doesn't ask what to push`);
      assert.doesNotMatch(text, /^\d\. [^\n]*Run `npx storysync map/m, `${path} still maps every component before snap`);
      assert.match(text, /STORYSYNC_PROGRESS=1 npx storysync snap [^\n]*2> \.storysync\/snap-progress\.log; echo "exit \$\?" >> \.storysync\/snap-progress\.log/, `${path} doesn't log snap's progress and exit code`);
      assert.match(text, /in the background/, `${path} runs snap in the foreground`);
      assert.match(text, /`exit 130`, `143` or `129`/, `${path} doesn't say what a stopped snap's exit codes mean`);
      assert.match(text, /`measuredAt` is after you started it/, `${path} doesn't check the snap is this run's`);
      // --merge keeps measuredAt at the oldest component's time, so a merge
      // that worked failed a check of measuredAt alone.
      assert.match(text, /after a `--merge`, which keeps `measuredAt` at the oldest component's time on purpose, its `componentsMeasuredAt` time for each component you named is/, `${path} fails every merge on its measuredAt`);
      assert.match(text, /read the measurements from `\.storysync\/snaps\/styles\.json` on disk/i, `${path} reads snap's one-line stdout`);
      assert.match(text, /adding `--components <their IDs> --merge` and a longer `--timeout`/, `${path} re-measures timeouts without --merge`);
      assert.match(text, /Never re-measure some components with `--components` alone/, `${path} doesn't warn against --components alone`);
      assert.doesNotMatch(text, /re-run `?snap`? for those components with `--components` and a longer/, `${path} still re-runs timeouts with --components alone`);
      assert.match(text, /closed trigger[^\n]*ask the user once/, `${path} builds a closed trigger without asking`);
      assert.match(text, /on a line of each such set's description that starts `storysync:`/, `${path} doesn't label a trigger built as measured in Figma`);
      // A plain assignment replaced a designer's description, and nothing
      // took the label off a set rebuilt from a story that renders it open.
      assert.doesNotMatch(text, /\.description = '/, `${path} overwrites a set's description`);
      assert.match(text, /on every push/, `${path} labels only this push's triggers, never clearing an earlier push's label`);
      assert.match(text, /a designer's own included/, `${path} drops a designer's description`);
      // Skipped, they stayed in styles.json, and verify failed on them as missing.
      assert.match(text, /`--skip`[^\n]*leaves them out of the score/, `${path} lets verify fail a push on the components the user skipped`);
      assert.match(text, /names a component's error,? (?:means )?measure that component again/, `${path} re-measures for every recorded snap failure`);
      assert.match(text, /restart Storybook/, `${path} leaves out restarting Storybook after init`);
      assert.match(text, /`bg-primary`[^\n]*`primary`[^\n]*leave it unbound and list it in the summary|`bg-primary` is `primary`[^\n]*leave the value unbound and list it in the summary/, `${path} picks among variables that share a value`);
      // Variables are named as tokens names them, and a class with an
      // opacity modifier bound to its opaque variable lost the measured alpha
      // when the paint was assigned: it binds at its alpha through setPaints
      // (the Cursor rule, which has no template, by assigning it twice).
      assert.match(text, /`text-primary-foreground` (?:is|as) `primary\/foreground`/, `${path} names a variable tokens never creates`);
      assert.doesNotMatch(text, /is `primary-foreground`/, `${path} names a variable tokens never creates`);
      assert.match(text, /opacity modifier[^\n]*bind it to (?:its variable, )?`destructive`,? with the paint's opacity at its alpha/, `${path} loses a translucent paint's alpha, or leaves it unbound`);
      assert.doesNotMatch(text, /leave that paint unbound|reads back opaque/, `${path} still leaves an opacity-modified class unbound`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction makes a page per whole category and names a set by its title's last segment", () => {
  // With Storybook's own titles, ui/base/Button's top-level category is "ui",
  // as is ui/radix/Button's: one page a top-level category put them on one
  // page as one set. And named by the component, the DatePicker stories'
  // Calendar was Calendar's set.
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
      assert.doesNotMatch(text, /top-level categor/, `${path} still makes a page per top-level category`);
      assert.match(text, /page per `?category`?, the whole of it/, `${path} never makes a page per whole category`);
      assert.match(text, /named by the last segment of its `title`/, `${path} never names a set by its title's last segment`);
      assert.match(text, /ignoring case, spaces, `\/`, `-` and `_`/, `${path} never finds a page an earlier push named another way`);
    }
    for (const path of files.slice(0, 2)) {
      const text = readFileSync(join(project, path), "utf8");
      assert.match(text, /const pageKey = \(name\) => name\.toLowerCase\(\)\.replace\(\/\[ \/_-\]\+\/g, ''\);/, `${path}'s template finds a page only by its exact name`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every audit instruction reports a name repeated in code or in Figma as ambiguous", () => {
  // diff reads every page now, so Figma can repeat a name too, an archived
  // copy or each category's Button, and reports it as ambiguous. Comparing
  // one copy and saying nothing of the other hides it; comparing the first
  // copies as well counts the name twice, as ambiguous and as matched.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    const files = [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
      join(".claude", "commands", "storysync-diff.md"),
    ];
    for (const path of files) {
      const text = readFileSync(join(project, path), "utf8");
      assert.match(text, /two code components share a name[^\n]*or two Figma component sets do[^\n]*ambiguous/, `${path} reports only a name code repeats as ambiguous`);
      assert.match(text, /share a name[^\n]*report the name as ambiguous, and only as ambiguous: compare none of the copies left, and don't also count them as matched, mismatched or missing/, `${path} has a repeated name compared as well as reported ambiguous`);
      // Told apart by page first, as the push lays a category out on a page
      // of its own: by name alone, a library with Base UI and Radix copies of
      // every component compared none of them.
      assert.match(text, /share a name[^\n]*tell them apart by page|share a name[^\n]*on its category's page/, `${path} never tells a repeated name's copies apart by page`);
      // A copy left on each side is no pair: the set may be the component's,
      // moved, or an archived one beside a component not pushed yet.
      assert.doesNotMatch(text, /one code component and one set are a pair, code|one on each side are a pair/, `${path} pairs the copies pages left by guess`);
      assert.match(text, /share a name[^\n]*Copies left on both sides, even one of each, can't be told apart/, `${path} pairs the copies pages left by guess`);
      assert.match(text, /ignoring case, spaces, `\/`, `-` and `_`/, `${path} compares page names as written, not as diff does`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every audit summary counts code-only, Figma-only, ambiguous and errored components, and isn't in sync while a name is ambiguous or a set errored", () => {
  // The summary counted only matched and mismatched components, so a report
  // whose every compared name matched read "Figma and code are in sync."
  // beside a component Figma lacked, or a name compared on neither copy.
  // A designer's own components outside any set, an icon library's, are
  // counted apart and don't keep the audit from being in sync.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    const files = [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
      join(".claude", "commands", "storysync-diff.md"),
    ];
    for (const path of files) {
      const text = readFileSync(join(project, path), "utf8");
      const audit = text.slice(text.search(/^(?:## Audit|Workflow:)$/m));
      assert.match(audit, /N components matched,? \/? ?(?:N )?mismatched,? \/? ?(?:N )?code-only,? \/? ?(?:N )?Figma-only,? \/? ?(?:N )?ambiguous,? \/? ?(?:N )?errored in Figma, and N components outside any set not from the push, not compared\./, `${path}'s summary leaves out code-only, Figma-only, ambiguous or errored components, or those not from the push`);
      assert.match(audit, /`\?` (?:for )?ambiguous/, `${path} gives an ambiguous name no label`);
      assert.match(audit, /`!` (?:for )?errored in Figma/, `${path} gives a set Figma flags as errored no label`);
      assert.match(audit, /"Figma and code are in sync\." only if everything matches and no name is ambiguous or set errored; components outside any set not from the push don't count against it\. An ambiguous name was compared on none of its copies, and an errored set on nothing, so either can hide drift: while any is, name them instead, and never say the two are in sync\./,
        `${path} lets a report with an ambiguous name or an errored set say Figma and code are in sync`);
      assert.doesNotMatch(audit, /If everything matches, (?:confirm|say) "Figma and code are in sync/, `${path} still says in sync whenever everything compared matches`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the Codex skill says how to raise the tool timeout however Figma was added", () => {
  // codex mcp add writes a [mcp_servers.figma] table; Figma's plugin writes
  // none, and its server has no timeout setting of its own.
  const project = tempProject();
  try {
    setupOutput(project, false, "codex");
    const text = readFileSync(join(project, ".agents", "skills", "storysync", "SKILL.md"), "utf8");
    const note = text.slice(0, text.indexOf("\n## Tokens\n")).split("\n").find((line) => line.includes("tool_timeout_sec"));
    assert.ok(note, "the Codex skill never mentions tool_timeout_sec");
    assert.match(note, /codex mcp add figma/);
    assert.match(note, /plugin/, "the timeout note assumes Figma was added with codex mcp add");
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

type Seal = (setId: string, slug: string, fields: object) => Record<string, unknown>;

/** The canon and seal functions an instruction file gives the agent, run as written. */
function sealFrom(text: string, path: string): Seal {
  const code = /const canon = [\s\S]*?const seal = \(setId, slug, fields\) => \{[\s\S]*?\n\s*return entry;\n\s*\};/.exec(text);
  assert.ok(code, `${path} gives no canon and seal to checksum a readback entry with`);
  return new Function(`${code[0]}\nreturn seal;`)() as Seal;
}

test("every readback's checksum code computes what verify recomputes", () => {
  // The Claude template is run against simulated nodes in acceptance, which CI
  // does not run; the Cursor rule gives the agent the same code in prose. Run
  // both here, on entries with the values that are easy to get wrong.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    const mixed = Symbol("figma.mixed");
    const entries: [string, Record<string, unknown>][] = [
      ["variant-primary--size-sm--disabled-false", {
        source: "measured", backgroundColor: "#4b556322", color: null,
        padding: { top: 4, right: 8, bottom: 4, left: 8 }, borderUniform: { width: 1, style: "solid", color: null },
        fontSize: 11, fontWeight: 700, fontFamily: "Inter", gap: { row: 6, column: 6 },
        opacity: Math.fround(0.4), width: 38.59, height: 1e-7 + 24,
      }],
      // A variant with no text child or auto layout, whose fields are null,
      // and one whose stroke weights differ, so Figma reports figma.mixed,
      // which drops out of what is returned, as an undefined field does.
      ["no-text", { source: "inferred", backgroundColor: null, fontSize: null, fontFamily: null, gap: null, color: undefined, width: 0, height: -0 }],
      ["mixed-stroke", { source: "measured", borderUniform: { width: mixed, style: "solid", color: "#9ca3af" }, tiny: 1e-7, label: "Bouton étiqueté" }],
    ];
    const files = [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
    ];
    for (const path of files) {
      const seal = sealFrom(readFileSync(join(project, path), "utf8"), path);
      for (const [slug, fields] of entries) {
        const before = Date.now();
        const entry = seal("12:34", slug, fields);
        // What reaches the file is the call's JSON, read back.
        const written = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
        assert.equal(written.checksum, readbackChecksum("12:34", slug, written), `${path}: ${slug}`);
        // Sealed with the time it was read, as an ISO 8601 time from the clock it ran on.
        const readAt = Date.parse(String(written.readAt));
        assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(String(written.readAt)) && readAt >= before && readAt <= Date.now(),
          `${path}: ${slug} was read at ${String(written.readAt)}`);
        // And under the set's id: the same entry under another set's is another checksum.
        assert.notEqual(written.checksum, readbackChecksum("56:78", slug, written), `${path}: ${slug} is not sealed under its set's id`);
      }
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every readback example is one verify accepts: sealed under its set's id, complete and with a readAt", () => {
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    const files = [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
    ];
    for (const path of files) {
      const text = readFileSync(join(project, path), "utf8");
      const example = /figma-readback\.json`[^\n]*\n+```json\n([\s\S]*?)\n```/.exec(text);
      assert.ok(example, `${path} shows no figma-readback.json`);
      const file = JSON.parse(example[1]) as ReadbackFile;
      assert.deepEqual(checkReadback(file), [], `${path}'s example is not one verify would accept`);
      for (const { nodeId, variants } of Object.values(file.components)) {
        for (const [slug, entry] of Object.entries(variants)) {
          assert.equal(entry.checksum, readbackChecksum(String(nodeId), slug, entry), `${path}'s example ${slug} carries a checksum verify would not accept`);
          assert.ok(typeof entry.readAt === "string", `${path}'s example ${slug} has no readAt`);
        }
      }
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction writes the readback exactly as returned, and says verify flags a checksum that doesn't match", () => {
  // On a live push the agent wrote figma-readback.json from snap's values plus
  // the sizes off the Figma nodes, rather than from the readback responses,
  // so verify compared snap with snap for every property but size.
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
      const merge = /^[^\n]*figma-readback\.json`[^\n]*$/m.exec(text.slice(text.search(/[Ww]rite (?:every slice's|the entries each call)/)));
      assert.ok(merge, `${path} never says how to write the readback file`);
      const line = merge[0];
      assert.match(line, /exactly as (?:the calls )?returned/, `${path} never says to write the entries exactly as returned`);
      assert.match(line, /merging the slices/, `${path} never says to merge the slices`);
      assert.match(line, /[Nn]ever fill in or recompute a value, from snap/, `${path} never forbids filling a value in from snap`);
      assert.match(line, /read fewer variants per call[^\n]*rather than summarizing/, `${path} lets a long response be summarized`);
      assert.match(line, /`verify`[^\n]*checksum is missing or (?:does not|doesn't) match[^\n]*`--strict`/, `${path} never says verify flags a checksum that doesn't match`);
      assert.match(line, /`readAt` and `checksum` included/, `${path} never says to copy each entry's readAt`);
      assert.match(line, /`verify`[^\n]*lacks a field[^\n]*before the snap[^\n]*`--strict`/, `${path} never says verify flags an entry cut down or read before the snap`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("verify requires exactly the fields the Claude template returns on every variant", () => {
  // A template cut down to { source, width, height } still sealed what it
  // returned, and scored 100% on every strict flag; so did one cut down to
  // leave out the text fields and gap, which the template used to leave out
  // where Figma had none and verify let any entry leave out. The template
  // now returns every field, null where Figma has nothing to report, and
  // verify requires them all, so the two lists have to agree: a field the
  // template returns but verify does not require could be cut, and one verify
  // requires that the template leaves out would fail every honest run.
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    const claude = readFileSync(join(project, ".claude", "skills", "storysync", "SKILL.md"), "utf8");
    const template = /readback\[slug\] = seal\(componentSet\.id, slug, \{([\s\S]*?)\n\s*\}\);/.exec(claude);
    assert.ok(template, "Claude skill has no readback template");
    const body = template[1].replace(/\/\/[^\n]*/g, "");
    const indent = /^( *)source:/m.exec(body)?.[1] ?? "";
    // Each top-level field with its value, up to the next one.
    const fields = [...body.matchAll(new RegExp(`^${indent}(\\w+):([\\s\\S]*?)(?=^${indent}\\w+:|$(?![\\s\\S]))`, "gm"))]
      .map(([, key, value]) => ({ key, value }));
    assert.ok(fields.length > 10, `read ${fields.length} fields from the template`);
    assert.deepEqual(fields.map((f) => f.key).sort(), [...READBACK_FIELDS].sort(), "verify's required fields are not the ones the template returns");
    // None of them is left out where Figma has nothing to report: a field
    // that can be undefined drops out of what the call returns.
    for (const { key, value } of fields) {
      assert.doesNotMatch(value, /\bundefined\b/, `${key} can be left out of what the template returns`);
    }
    // The text child's three, and gap, are null where there is nothing to read.
    for (const key of ["fontSize", "fontWeight", "fontFamily", "gap"]) {
      assert.match(fields.find((f) => f.key === key)?.value ?? "", /:\s*null,\s*$/, `${key} is not null where Figma has nothing to report`);
    }
    // And the font's two from a fontName that is not figma.mixed, off the text child.
    assert.match(claude, /const font = text && typeof text\.fontName === 'object' \? text\.fontName : null;/, "the template does not read the font off the text child, null when mixed");
    assert.match(fields.find((f) => f.key === "fontSize")?.value ?? "", /text && typeof text\.fontSize === 'number'/, "fontSize is not null when mixed");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

/** Each push instruction setup installs, as [path, text]: the three skills and the push command. */
function installedPushTexts(): [string, string][] {
  const project = tempProject();
  try {
    setupOutput(project, false, "claude");
    setupOutput(project, false, "codex");
    setupOutput(project, false, "cursor");
    return [
      join(".claude", "skills", "storysync", "SKILL.md"),
      join(".agents", "skills", "storysync", "SKILL.md"),
      join(".cursor", "rules", "storysync.mdc"),
      join(".claude", "commands", "storysync-push.md"),
    ].map((path) => [path, readFileSync(join(project, path), "utf8")]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test("every push summary says how many entries verify left unverified when its score doesn't cover them", () => {
  // Without --strict, verify exits 0 under a score of the entries it could
  // verify: a summary quoting the percentage alone reads as a clean pass.
  for (const [path, text] of installedPushTexts()) {
    assert.match(text, /fidelity score\**, worded as `verify` words it: where its line says `of verified entries`, how many entries it left unverified/,
      `${path} reports the score without the entries verify left out of it`);
  }
});

test("every push instruction labels a set without escaping its description again, and removes only an untouched Page 1", () => {
  // Figma returns a description HTML-escaped, and a label call that wrote
  // back what it read turned Dialog's note into
  // button[data-slot=&quot;dialog-trigger&quot;], once more on every push. And
  // the push left Figma's empty Page 1 beside the pages it made.
  for (const [path, text] of installedPushTexts()) {
    assert.match(text, /Figma returns (?:it|a description) HTML-escaped/, `${path} writes a description back as it read it`);
    assert.match(text, /descriptionMarkdown/, `${path} drops a designer's formatting`);
    assert.match(text, /removes Figma's default page, `Page 1`,[^\n]*(?:still named `Page 1`, empty[^\n]*not the file's only page|still named so, empty and not the only page)/,
      `${path} doesn't remove Page 1 only while Figma's own`);
    assert.match(text, /whether the label call removed Figma's default page `Page 1` or why it kept it/, `${path}'s summary doesn't say what became of Page 1`);
  }
});
