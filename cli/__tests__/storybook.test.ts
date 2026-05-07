import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCategoryFromId } from "../storybook.js";

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
