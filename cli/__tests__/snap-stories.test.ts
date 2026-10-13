// Which story measures each variant (cli/snap-stories.ts), held to the
// stories of shadcn/ui Button in the registry the fourth live push measured.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseStory, storyAddsContent, storyClaims, storyKeys } from "../snap-stories.js";
import type { StoryOwn } from "../snap-stories.js";
import type { FigmaVariantProperty } from "../mapper.js";

const PROPERTIES: FigmaVariantProperty[] = [
  { name: "variant", type: "VARIANT", values: ["default", "destructive", "outline", "secondary", "ghost", "link"], defaultValue: "default" },
  { name: "size", type: "VARIANT", values: ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"], defaultValue: "default" },
];

const ELEMENT = { $type: "object" };
/** ui/base/Button's stories, each its own args as Storybook's preview read them live (2026-10-13), in the index's order. */
const BUTTON: StoryOwn[] = [
  { id: "ui-base-button--default", args: {} },
  { id: "ui-base-button--outline", args: { variant: "outline" } },
  { id: "ui-base-button--ghost", args: { variant: "ghost" } },
  { id: "ui-base-button--secondary", args: { variant: "secondary" } },
  { id: "ui-base-button--destructive", args: { variant: "destructive" } },
  { id: "ui-base-button--link", args: { variant: "link" } },
  { id: "ui-base-button--loading", args: { variant: "outline", disabled: true }, render: true },
  { id: "ui-base-button--with-icon", args: { variant: "secondary" }, render: true },
  { id: "ui-base-button--small", args: { size: "sm" } },
  { id: "ui-base-button--large", args: { size: "lg" } },
  { id: "ui-base-button--icon", args: { variant: "secondary", size: "icon", title: "Mail", children: ELEMENT } },
  { id: "ui-base-button--icon-small", args: { variant: "secondary", size: "icon-sm", title: "Mail", children: ELEMENT } },
  { id: "ui-base-button--icon-large", args: { variant: "secondary", size: "icon-lg", title: "Mail", children: ELEMENT } },
  { id: "ui-base-button--disabled", args: { disabled: true } },
];

const every = () => PROPERTIES[0].values.flatMap((variant) => PROPERTIES[1].values.map((size) => ({ variant, size })));

test("storyClaims: the values a story's own args give the variant properties, a value the property lacks or a React element none", () => {
  assert.deepEqual(storyClaims(BUTTON[10], PROPERTIES), { variant: "secondary", size: "icon" });
  assert.deepEqual(storyClaims({ id: "x", args: { size: "huge", variant: ELEMENT, disabled: true } }, PROPERTIES), {});
  // A boolean or a number, as the combination holds it, a string.
  const flag: FigmaVariantProperty = { name: "disabled", type: "BOOLEAN", values: ["false", "true"], defaultValue: "false" };
  assert.deepEqual(storyClaims(BUTTON[13], [flag]), { disabled: "true" });
});

test("storyAddsContent: an arg that is no variant property, or a render or decorators of its own; not a handler", () => {
  assert.equal(storyAddsContent(BUTTON[10], PROPERTIES), true, "Icon's children and title");
  assert.equal(storyAddsContent(BUTTON[7], PROPERTIES), true, "WithIcon's render");
  assert.equal(storyAddsContent(BUTTON[1], PROPERTIES), false, "Outline names a variant property alone");
  assert.equal(storyAddsContent({ id: "x", args: { variant: "outline" }, decorators: true }, PROPERTIES), true);
  assert.equal(storyAddsContent({ id: "x", args: { variant: "outline", onClick: { $type: "function" } } }, PROPERTIES), false);
});

test("storyKeys: what each story is for, less what a plainer story already sets", () => {
  const keys = storyKeys(BUTTON, PROPERTIES);
  // Icon sets what Secondary does, and size=icon besides.
  assert.deepEqual(keys.get("ui-base-button--icon"), { size: "icon" });
  assert.deepEqual(keys.get("ui-base-button--icon-small"), { size: "icon-sm" });
  // WithIcon and Loading set no more than Secondary and Outline do, and draw more: for nothing.
  assert.deepEqual(keys.get("ui-base-button--with-icon"), {});
  assert.deepEqual(keys.get("ui-base-button--loading"), {});
  assert.deepEqual(keys.get("ui-base-button--secondary"), { variant: "secondary" });
  assert.deepEqual(keys.get("ui-base-button--default"), {});
  // Only a story that adds nothing explains a value away: one that draws something of its own is for what it sets.
  const both = storyKeys([
    { id: "outline", args: { variant: "outline", children: "Outline" } }, { id: "small", args: { size: "sm" } },
    { id: "outline-small", args: { variant: "outline", size: "sm", children: "Both" } },
  ], PROPERTIES);
  assert.deepEqual(both.get("outline-small"), { variant: "outline" });
  assert.deepEqual(both.get("outline"), { variant: "outline" });
});

test("chooseStory: Button's icon sizes from its Icon stories, every other variant from the component's story", () => {
  const chosen = new Map<string, string[]>();
  for (const combination of every()) {
    const { storyId, values } = chooseStory(combination, BUTTON, PROPERTIES, "ui-base-button--default");
    chosen.set(storyId, [...(chosen.get(storyId) ?? []), `${combination.variant}/${combination.size}`]);
    if (storyId !== "ui-base-button--default") assert.deepEqual(values, [`size=${combination.size}`]);
    else assert.equal(values, undefined);
  }
  assert.deepEqual([...chosen.keys()].sort(), ["ui-base-button--default", "ui-base-button--icon", "ui-base-button--icon-large", "ui-base-button--icon-small"]);
  assert.deepEqual(chosen.get("ui-base-button--icon"), PROPERTIES[0].values.map((v) => `${v}/icon`));
  assert.deepEqual(chosen.get("ui-base-button--icon-small"), PROPERTIES[0].values.map((v) => `${v}/icon-sm`));
  // Storybook has no story for icon-xs, so the component's story measures it, and the overflow warning says so.
  assert.equal(chooseStory({ variant: "default", size: "icon-xs" }, BUTTON, PROPERTIES, "ui-base-button--default").storyId, "ui-base-button--default");
});

test("chooseStory: a story --stories named stays the story for every variant no other story is for", () => {
  const fallback = "ui-base-button--with-icon";
  assert.equal(chooseStory({ variant: "outline", size: "sm" }, BUTTON, PROPERTIES, fallback).storyId, fallback, "not Outline or Small, which add nothing");
  assert.equal(chooseStory({ variant: "secondary", size: "default" }, BUTTON, PROPERTIES, fallback).storyId, fallback);
  assert.deepEqual(chooseStory({ variant: "destructive", size: "icon-lg" }, BUTTON, PROPERTIES, fallback), { storyId: "ui-base-button--icon-large", values: ["size=icon-lg"] });
  // Named as the component's own, a story is recorded as no other.
  assert.deepEqual(chooseStory({ variant: "secondary", size: "icon" }, BUTTON, PROPERTIES, "ui-base-button--icon"), { storyId: "ui-base-button--icon" });
});

test("chooseStory: the story for the most of the variant's values, then the one that sets more of its own, then the first; never one with a play function", () => {
  const stories: StoryOwn[] = [
    { id: "small", args: { size: "sm", children: "Small" } },
    { id: "outline", args: { variant: "outline", children: "Outline" } },
    { id: "outline-small", args: { variant: "outline", size: "sm", children: "Both" } },
    { id: "ghost", args: { variant: "ghost", children: "Ghost", title: "t" } },
    { id: "played", args: { size: "lg", children: "Played" }, play: true },
  ];
  const pick = (variant: string, size: string) => chooseStory({ variant, size }, stories, PROPERTIES, "default").storyId;
  assert.equal(pick("outline", "sm"), "outline-small");
  assert.equal(pick("outline", "default"), "outline");
  assert.equal(pick("ghost", "sm"), "ghost", "Ghost sets more of its own than Small");
  assert.equal(pick("default", "lg"), "default", "a story with a play function acts on what it renders");
  // The same stories in another order pick the same, but for a tie, which the first wins.
  const tie: StoryOwn[] = [{ id: "a", args: { size: "sm", children: "A" } }, { id: "b", args: { variant: "outline", children: "B" } }];
  assert.equal(chooseStory({ variant: "outline", size: "sm" }, tie, PROPERTIES, "default").storyId, "a");
  assert.equal(chooseStory({ variant: "outline", size: "sm" }, [...tie].reverse(), PROPERTIES, "default").storyId, "b");
});
