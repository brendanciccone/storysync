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
  // follows snap's variantProperties in the order Storybook declares them, a
  // BOOLEAN false then true, and the layers panel, which shows the last child
  // at the top, reads the same way. Figma takes the set's default variant
  // from the top-left, so the agent says which that is when it is not the
  // component's own default.
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
      assert.match(text, /in the order snap records them, which is the order of the component's prop type as Storybook's docs list it \(a story's `argTypes` options are not read\), not default first/,
        `${path} never says the values run in Storybook's declared order`);
      assert.doesNotMatch(text, /default first, then|all-defaults variant[^\n]*top-left/, `${path} still puts each property's default first`);
      assert.match(text, /a `BOOLEAN` property runs `false, true`, though snap lists its values `true, false`/i,
        `${path} never says how a BOOLEAN property is ordered`);
      assert.match(text, /Figma makes the top-left variant the set's default variant/, `${path} never says where Figma takes the default variant from`);
      assert.match(text, /`size=sm` even if the component defaults to `md`/, `${path} gives no example of a default that is not the component's`);
      assert.match(text, /say in the summary which variant Figma will treat as the default/, `${path} never has the agent report Figma's default`);
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
  // text box to fit would only trade the drift for a clipped label.
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
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every push instruction reads a translucent colour back with its alpha, and a hidden paint as null", () => {
  // snap writes a translucent colour as #rrggbbaa, a soft Chip's background
  // #4b556322, and verify compares colours as written. The readback converted
  // only the paint's colour, so every translucent fill and stroke drifted:
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
      assert.doesNotMatch(text, /toHex\((?:fill|stroke|text\.fills\[0\])\.color\)|fill as `#rrggbb`/, `${path} still reads a colour without its alpha`);
      assert.match(text, /alpha[^\n]*(?:as )?two more (?:lowercase )?hex digits/, `${path} never appends a translucent colour's alpha`);
      assert.match(text, /`?#rrggbbaa`?[^\n]*`?opacity`?/, `${path} never says a translucent colour's alpha is its paint's opacity`);
      assert.match(text, /visible: false/, `${path} never reads a hidden paint as drawing nothing`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every audit instruction reports a name repeated in code or in Figma as ambiguous", () => {
  // diff reads every page now, so Figma can repeat a name too, an archived
  // copy or each category's Button, and reports it as ambiguous. Comparing
  // one copy and saying nothing of the other hides it.
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
