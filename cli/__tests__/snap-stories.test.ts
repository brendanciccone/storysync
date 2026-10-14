// Which story measures each variant (cli/snap-stories.ts), held to the
// stories of shadcn/ui Button in the registry the fourth live push measured.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SIBLING_TRIES, chooseStory, kinship, siblingStories, storyAddsContent, storyClaims, storyKeys } from "../snap-stories.js";
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

test("chooseStory: the story for the most of the variant's values, then the plainest, then the first; never one with a play function", () => {
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
  assert.equal(pick("ghost", "sm"), "small", "Small sets less of its own than Ghost");
  assert.equal(pick("default", "lg"), "default", "a story with a play function acts on what it renders");
  // The same stories in another order pick the same, but for a tie, which the first wins.
  const tie: StoryOwn[] = [{ id: "a", args: { size: "sm", children: "A" } }, { id: "b", args: { variant: "outline", children: "B" } }];
  assert.equal(chooseStory({ variant: "outline", size: "sm" }, tie, PROPERTIES, "default").storyId, "a");
  assert.equal(chooseStory({ variant: "outline", size: "sm" }, [...tie].reverse(), PROPERTIES, "default").storyId, "b");
});

/** ui/base/Toggle's stories, each its own args as its CSF file sets them: WithText is `{ ...Outline.args }` and a render that adds a label. */
const TOGGLE_PROPERTIES: FigmaVariantProperty[] = [
  { name: "variant", type: "VARIANT", values: ["default", "outline"], defaultValue: "default" },
  { name: "size", type: "VARIANT", values: ["default", "sm", "lg"], defaultValue: "default" },
];
const TOGGLE: StoryOwn[] = [
  { id: "ui-base-toggle--default", args: {} },
  { id: "ui-base-toggle--outline", args: { variant: "outline", children: ELEMENT, "aria-label": "Toggle italic" } },
  { id: "ui-base-toggle--with-text", args: { variant: "outline", children: ELEMENT, "aria-label": "Toggle italic" }, render: true },
  { id: "ui-base-toggle--small", args: { size: "sm" } },
  { id: "ui-base-toggle--large", args: { size: "lg" } },
  { id: "ui-base-toggle--disabled", args: { disabled: true } },
];

test("chooseStory: Toggle's outline variants from Outline, not WithText, which adds a label to the same args", () => {
  const keys = storyKeys(TOGGLE, TOGGLE_PROPERTIES);
  assert.deepEqual(keys.get("ui-base-toggle--outline"), { variant: "outline" });
  assert.deepEqual(keys.get("ui-base-toggle--with-text"), {}, "WithText is Outline with more of its own");
  for (const size of TOGGLE_PROPERTIES[1].values) {
    assert.deepEqual(chooseStory({ variant: "outline", size }, TOGGLE, TOGGLE_PROPERTIES, "ui-base-toggle--default"), { storyId: "ui-base-toggle--outline", values: ["variant=outline"] });
    assert.deepEqual(chooseStory({ variant: "default", size }, TOGGLE, TOGGLE_PROPERTIES, "ui-base-toggle--default"), { storyId: "ui-base-toggle--default" });
  }
  // Without the rule that takes WithText's values away, the plainer of two stories for the same values still wins, whichever comes first.
  const tied: StoryOwn[] = [
    { id: "decorated", args: { variant: "outline", children: "Italic", title: "t" } },
    { id: "plain", args: { variant: "outline", children: ELEMENT } },
  ];
  assert.equal(chooseStory({ variant: "outline", size: "sm" }, tied, TOGGLE_PROPERTIES, "default").storyId, "plain");
  assert.equal(chooseStory({ variant: "outline", size: "sm" }, [...tied].reverse(), TOGGLE_PROPERTIES, "default").storyId, "plain");
});

test("siblingStories: Button's icon-xs, which no story is for, may come from the Icon stories, Icon first", () => {
  const icons = ["ui-base-button--icon", "ui-base-button--icon-small", "ui-base-button--icon-large"];
  for (const variant of PROPERTIES[0].values) {
    const combination = { variant, size: "icon-xs" };
    assert.equal(chooseStory(combination, BUTTON, PROPERTIES, "ui-base-button--default").storyId, "ui-base-button--default");
    assert.deepEqual(siblingStories(combination, BUTTON, PROPERTIES, "ui-base-button--default"), [
      { storyId: icons[0], values: ["size=icon"] }, { storyId: icons[1], values: ["size=icon-sm"] }, { storyId: icons[2], values: ["size=icon-lg"] },
    ]);
  }
  // Never the component's story, nor Small, Outline or WithIcon, which are for nothing of their own or add nothing.
  assert.deepEqual(siblingStories({ variant: "outline", size: "icon-xs" }, BUTTON, PROPERTIES, "ui-base-button--icon").map((s) => s.storyId), icons.slice(1));
  assert.deepEqual(siblingStories({ variant: "outline", size: "sm" }, BUTTON, PROPERTIES, "ui-base-button--default").map((s) => s.storyId), icons);
});

test("siblingStories: a story for another of the variant's values, the most of its values first, then the fewest others, the plainest, the first; at most SIBLING_TRIES", () => {
  const stories: StoryOwn[] = [
    { id: "ghost-lg", args: { variant: "ghost", size: "lg", children: "Both", title: "t" } },
    { id: "lg", args: { size: "lg", children: "Large", title: "t" } },
    { id: "outline-lg", args: { variant: "outline", size: "lg", children: "Both" } },
    { id: "ghost", args: { variant: "ghost", children: "Ghost" } },
    { id: "played", args: { size: "xs", children: "Played" }, play: true },
    { id: "plain-sm", args: { size: "sm" } },
  ];
  // For outline/sm: outline-lg, which shares its variant, first; not ghost-lg, for two values it lacks, nor a story with a play function or one that adds nothing.
  const ids = (variant: string, size: string) => siblingStories({ variant, size }, stories, PROPERTIES, "default").map((s) => s.storyId);
  assert.deepEqual(ids("outline", "sm"), ["outline-lg", "ghost", "lg"]);
  assert.deepEqual(siblingStories({ variant: "outline", size: "sm" }, stories, PROPERTIES, "default")[0].values, ["variant=outline", "size=lg"]);
  // Of two for one value each, the plainer first, whichever comes first; then those for two other values, the plainer first.
  assert.deepEqual(ids("default", "sm"), ["ghost", "lg", "outline-lg"]);
  assert.equal(SIBLING_TRIES, 3);
});

test("siblingStories: a story for a value of the variant's family first, so a size story's label never crowds out Icon", () => {
  // Plainer stories for other sizes, each with its label, come before Icon but for its family.
  const many: StoryOwn[] = ["xs", "sm", "lg", "icon", "icon-sm"].map((size) => ({ id: size, args: { size, children: size } }));
  assert.deepEqual(siblingStories({ variant: "default", size: "icon-xs" }, many, PROPERTIES, "default").map((s) => s.storyId), ["icon", "icon-sm", "xs"]);
  // The review's probe: Icon also sets a variant no plain story does, so it is for two of icon-xs's values, not one, and still first.
  for (const variant of ["default", "secondary", "outline"]) {
    const probe: StoryOwn[] = [
      { id: "default", args: {} },
      { id: "extra-small", args: { size: "xs", children: "XS" } },
      { id: "small", args: { size: "sm", children: "Small" } },
      { id: "large", args: { size: "lg", children: "Large" } },
      { id: "icon", args: { variant, size: "icon", "aria-label": "Mail", children: ELEMENT } },
    ];
    const [first] = siblingStories({ variant: "default", size: "icon-xs" }, probe, PROPERTIES, "default");
    assert.deepEqual(first, { storyId: "icon", values: [`variant=${variant}`, "size=icon"] });
  }
});

test("kinship: the leading words two values share", () => {
  assert.equal(kinship("icon", "icon-xs"), 1);
  assert.equal(kinship("icon-sm", "icon-xs"), 1);
  assert.equal(kinship("iconSm", "icon_xs"), 1);
  assert.equal(kinship("icon-xs", "icon-xs"), 2);
  assert.equal(kinship("xs", "icon-xs"), 0);
  assert.equal(kinship("default", "destructive"), 0);
});
