import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCategoryFromId, parseStories } from "../storybook.js";

test("deriveCategoryFromId: single-word category", () => {
  assert.equal(deriveCategoryFromId("ui-button", "Button"), "UI");
  assert.equal(deriveCategoryFromId("catalyst-badge", "Badge"), "Catalyst");
  assert.equal(deriveCategoryFromId("tailwind-emptystate", "EmptyState"), "Tailwind");
});

test("deriveCategoryFromId: PascalCase name kebab-cases correctly", () => {
  assert.equal(deriveCategoryFromId("ui-iconbutton", "IconButton"), "UI");
  assert.equal(deriveCategoryFromId("ui-delta-pill", "DeltaPill"), "UI");
});

test("deriveCategoryFromId: multi-word category round-trips", () => {
  assert.equal(deriveCategoryFromId("data-display-card", "Card"), "Data Display");
  assert.equal(deriveCategoryFromId("forms-inputs-text-field", "TextField"), "Forms Inputs");
});

test("deriveCategoryFromId: strips story suffix after --", () => {
  assert.equal(deriveCategoryFromId("ui-button--primary", "Button"), "UI");
});

test("deriveCategoryFromId: name with spaces", () => {
  assert.equal(deriveCategoryFromId("ui-card-header", "Card Header"), "UI");
});

test("deriveCategoryFromId: no category prefix returns undefined", () => {
  assert.equal(deriveCategoryFromId("button", "Button"), undefined);
});

test("deriveCategoryFromId: name doesn't match ID returns undefined", () => {
  assert.equal(deriveCategoryFromId("ui-button", "Card"), undefined);
});

// --- parseStories ---

test("parseStories: reads unquoted `Story ID:` labels from addon-mcp docs", () => {
  // The shape @storybook/addon-mcp actually returns.
  const doc = [
    "# Button", "", "ID: forms-button", "", "## Stories", "",
    "### Default", "", "Story ID: forms-button--default", "",
    "### Hardcoded", "", "Story ID: forms-button--hardcoded-ignores-args", "",
  ].join("\n");
  assert.deepEqual(parseStories("forms-button", doc), [
    { id: "forms-button--default", name: "Default" },
    { id: "forms-button--hardcoded-ignores-args", name: "Hardcoded Ignores Args" },
  ]);
});

test("parseStories: still reads quoted id forms", () => {
  const doc = `- Primary (id: \`forms-button--primary\`)\n- Ghost (storyId: "forms-button--ghost")`;
  assert.deepEqual(parseStories("forms-button", doc).map((s) => s.id), [
    "forms-button--primary",
    "forms-button--ghost",
  ]);
});

test("parseStories: does not mistake the component ID for a story ID", () => {
  // `ID: forms-button` has no `--`, so it must not be picked up.
  const stories = parseStories("forms-button", "# Button\n\nID: forms-button\n");
  assert.deepEqual(stories, [{ id: "forms-button--default", name: "Default" }]);
});

test("parseStories: de-duplicates repeated IDs", () => {
  const doc = "Story ID: a-b--default\nreferenced again: id: a-b--default";
  assert.deepEqual(parseStories("a-b", doc).length, 1);
});

test("parseStories: falls back to the documentation ID, not the component name", () => {
  // Guessing from a bare name would produce `button--default`, which does not
  // exist for a component titled Forms/Button.
  assert.deepEqual(parseStories("forms-button", "no story ids here"), [
    { id: "forms-button--default", name: "Default" },
  ]);
});

test("parseStories: ignores words that merely end in \"id\"", () => {
  // Without a word boundary the bare `id` alternative matches the tail of
  // `grid`, `valid`, `pyramid`, ... turning ordinary prop docs into stories.
  for (const line of ["grid: layout--wide", "valid: some--thing", "pyramid: a--b"]) {
    assert.deepEqual(
      parseStories("forms-x", line),
      [{ id: "forms-x--default", name: "Default" }],
      `"${line}" should not yield a story ID`,
    );
  }
});

test("parseStories: still matches a genuine label preceded by punctuation", () => {
  assert.deepEqual(parseStories("x", "(id: forms-button--primary)")[0].id, "forms-button--primary");
  assert.deepEqual(parseStories("x", "- **Ghost** (storyId: `a-b--ghost`)")[0].id, "a-b--ghost");
});
