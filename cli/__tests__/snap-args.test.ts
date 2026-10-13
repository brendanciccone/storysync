// Tests for working out which args Storybook gave a story, and what to say
// about the ones it didn't. Pure, so no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  argMatches, argsNotInDocs, compactArgTypes, conditionHolds, describeArgRejections, describeUncheckedArgs,
  findRejectedArgs, mapArgs, nameSlugs, openArg, parseIllegalValueWarning, previewArgUpdate, rejectionsFromWarnings, stillRejected, typedArgValue,
} from "../snap-args.js";
import type { StoryArgsSnapshot } from "../snap-args.js";
import type { FigmaVariantProperty } from "../mapper.js";

/** shadcn/ui's Badge story, as Storybook's preview holds it after `?args=variant:ghost`. */
const BADGE: StoryArgsSnapshot = {
  fileName: "./registry/ui/badge-story/badge-base.stories.tsx",
  argTypes: {
    children: { type: "string", control: "text" },
    variant: { type: "enum", control: "select", options: ["default", "secondary", "destructive", "outline"] },
  },
  stored: { variant: "default", children: "Badge" },
  rendered: { variant: "default", children: "Badge" },
  globals: {},
};

/** shadcn/ui's base Button story after `?args=variant:link;size:xs`: the store took size, the `if` hid it. */
const BUTTON: StoryArgsSnapshot = {
  fileName: "./registry/ui/button-story/button-base.stories.tsx",
  argTypes: {
    variant: { type: "enum", control: "select", options: ["default", "destructive", "outline", "secondary", "ghost", "link"] },
    size: {
      type: "enum", control: "select",
      options: ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"],
      if: { arg: "variant", neq: "link" },
    },
    disabled: { type: "boolean", control: "boolean" },
  },
  stored: { variant: "link", size: "xs", children: "Button", disabled: false },
  rendered: { variant: "link", children: "Button", disabled: false },
  globals: {},
};

/** The Radix Button story after `?args=variant:link;size:icon-sm`: unlisted, and hidden too. */
const RADIX: StoryArgsSnapshot = {
  fileName: "./registry/ui/button-story/button-radix.stories.tsx",
  argTypes: {
    variant: { type: "enum", options: ["default", "destructive", "outline", "secondary", "ghost", "link"] },
    size: { type: "enum", options: ["default", "sm", "lg", "icon"], if: { arg: "variant", neq: "link" } },
  },
  stored: { variant: "link", size: "default" },
  rendered: { variant: "link" },
  globals: {},
};

const BOOL: FigmaVariantProperty = { name: "disabled", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" };

test("findRejectedArgs: a value outside the story's options is rejected, with the options", () => {
  assert.deepEqual(findRejectedArgs({ variant: "ghost" }, BADGE), [
    { name: "variant", value: "ghost", reasons: ["not-in-options"], options: ["default", "secondary", "destructive", "outline"] },
  ]);
  // One the story took is not.
  assert.deepEqual(findRejectedArgs({ variant: "default" }, BADGE), []);
});

test("findRejectedArgs: a value the store took but an argTypes if hid is rejected, with the condition", () => {
  assert.deepEqual(findRejectedArgs({ variant: "link", size: "xs" }, BUTTON), [
    { name: "size", value: "xs", reasons: ["hidden-by-if"], condition: { arg: "variant", neq: "link" } },
  ]);
});

test("findRejectedArgs: a value both unlisted and hidden names both reasons", () => {
  assert.deepEqual(findRejectedArgs({ variant: "link", size: "icon-sm" }, RADIX), [{
    name: "size", value: "icon-sm", reasons: ["not-in-options", "hidden-by-if"],
    options: ["default", "sm", "lg", "icon"], condition: { arg: "variant", neq: "link" },
  }]);
  // Hidden only once another rejected value would apply: judged on the
  // combination asked for, not on what the store fell back to.
  const fallback: StoryArgsSnapshot = { ...RADIX, stored: { variant: "default", size: "sm" }, rendered: { variant: "default", size: "sm" } };
  const rejected = findRejectedArgs({ variant: "link-ish", size: "xs" }, {
    ...fallback,
    argTypes: { ...fallback.argTypes, size: { ...fallback.argTypes.size, if: { arg: "variant", neq: "link-ish" } } },
  });
  assert.deepEqual(rejected.map((r) => [r.name, r.reasons]), [["variant", ["not-in-options"]], ["size", ["not-in-options", "hidden-by-if"]]]);
});

test("findRejectedArgs: an if is judged on the values the story is given, after mapping, as Storybook judges it", () => {
  // tone a is given to the story as "loud", which shows size: Storybook
  // gave size lg, so nothing was refused, and no if is to blame.
  const snapshot: StoryArgsSnapshot = {
    fileName: null,
    argTypes: {
      tone: { type: "enum", options: ["a", "b"], mapping: true },
      size: { type: "enum", options: ["sm", "lg"], if: { arg: "tone", eq: "loud" } },
    },
    mappings: { tone: { a: "loud", b: "quiet" } },
    stored: { tone: "a", size: "lg" },
    rendered: { tone: "a", size: "lg" },
    globals: {},
  };
  assert.deepEqual(findRejectedArgs({ tone: "a", size: "lg" }, snapshot), []);
  // tone b maps to "quiet", which hides size.
  const quiet = { ...snapshot, stored: { tone: "b", size: "lg" }, rendered: { tone: "b" } };
  assert.deepEqual(findRejectedArgs({ tone: "b", size: "lg" }, quiet).map((r) => [r.name, r.reasons]), [["size", ["hidden-by-if"]]]);
  assert.deepEqual(mapArgs({ tone: "a", size: "lg", on: true }, { tone: { a: "loud" }, on: { true: 1 } }), { tone: "loud", size: "lg", on: 1 });
});

test("findRejectedArgs: a value left out of the URL is rejected as one it can't carry, unless the story has it anyway", () => {
  const tone: StoryArgsSnapshot = {
    fileName: null,
    argTypes: {
      tone: { type: "enum", options: ["plain"] },
      size: { type: "enum", options: ["sm", "lg"], if: { arg: "tone", neq: "Nav/Primary" } },
    },
    stored: { tone: "plain", size: "sm" },
    rendered: { tone: "plain", size: "sm" },
    globals: {},
  };
  // Not in the options either, but the URL never had the chance to drop it.
  assert.deepEqual(findRejectedArgs({ tone: "Nav/Primary" }, tone, [], ["tone"]), [{ name: "tone", value: "Nav/Primary", reasons: ["url-unsafe"] }]);
  // Its value hides size: both said, so the preview lifts the if.
  assert.deepEqual(findRejectedArgs({ tone: "Nav/Primary", size: "sm" }, tone, [], ["tone"]).map((r) => [r.name, r.reasons]),
    [["tone", ["url-unsafe"]], ["size", ["hidden-by-if"]]]);
  // A value the story renders by default was given, URL or not.
  const byDefault = { ...tone, stored: { tone: "Nav/Primary" }, rendered: { tone: "Nav/Primary" } };
  assert.deepEqual(findRejectedArgs({ tone: "Nav/Primary" }, byDefault, [], ["tone"]), []);
  // Set through the preview, with nothing in the story to change: no warning.
  assert.deepEqual(describeArgRejections("Nav", [
    { combination: { tone: "Nav/Primary" }, status: "ok", appliedVia: "preview" as const, rejectedArgs: findRejectedArgs({ tone: "Nav/Primary" }, tone, [], ["tone"]) },
  ]), []);
});

test("findRejectedArgs: an arg the story's argTypes don't declare is rejected as such", () => {
  const rejected = findRejectedArgs({ orientation: "vertical" }, { ...BADGE, stored: {}, rendered: {} });
  assert.deepEqual(rejected, [{ name: "orientation", value: "vertical", reasons: ["not-in-argtypes"] }]);
});

test("findRejectedArgs: a number-like value the options list as a string is one the URL can't carry", () => {
  // Storybook's URL reads cols:2 as the number 2, which ["1", "2"] doesn't
  // list, and drops it: no argTypes change lets the URL give the string.
  const grid: StoryArgsSnapshot = {
    fileName: "./grid.stories.tsx",
    argTypes: { cols: { type: "enum", control: "radio", options: ["1", "2"] } },
    stored: { cols: "1" },
    rendered: { cols: "1" },
    globals: {},
  };
  assert.deepEqual(findRejectedArgs({ cols: "2" }, grid), [{ name: "cols", value: "2", reasons: ["number-in-url"], options: ["1", "2"] }]);
  assert.deepEqual(previewArgUpdate(findRejectedArgs({ cols: "2" }, grid), grid), { updates: { cols: "2" }, lift: [] });
  // An argType of type string turns the number back, so the URL can.
  const typed = { ...grid, argTypes: { cols: { ...grid.argTypes.cols, type: "string" } } };
  assert.deepEqual(findRejectedArgs({ cols: "2" }, typed).map((r) => r.reasons), [["not-applied"]]);
  // Nor is a value the options leave out one: that's not-in-options.
  assert.deepEqual(findRejectedArgs({ cols: "3" }, grid).map((r) => r.reasons), [["not-in-options"]]);
});

test("findRejectedArgs: booleans and numbers compare as Storybook holds them", () => {
  assert.deepEqual(findRejectedArgs({ disabled: "false" }, BUTTON, [BOOL]), []);
  const snapshot: StoryArgsSnapshot = { ...BUTTON, argTypes: { count: { type: "number" } }, stored: { count: 3 }, rendered: { count: 3 } };
  assert.deepEqual(findRejectedArgs({ count: "3" }, snapshot), []);
  // A value it didn't take and nothing explains.
  assert.deepEqual(findRejectedArgs({ count: "4" }, snapshot), [{ name: "count", value: "4", reasons: ["not-applied"] }]);
  // An object is never the string asked for.
  assert.equal(argMatches({ $type: "object" }, "[object Object]"), false);
});

test("conditionHolds: follows Storybook's includeConditionalArg", () => {
  const args = { variant: "link", on: true, off: false, count: 0 };
  assert.equal(conditionHolds({ arg: "variant", neq: "link" }, args, {}), false);
  assert.equal(conditionHolds({ arg: "variant", eq: "link" }, args, {}), true);
  assert.equal(conditionHolds({ arg: "on" }, args, {}), true);
  assert.equal(conditionHolds({ arg: "off" }, args, {}), false);
  assert.equal(conditionHolds({ arg: "off", truthy: false }, args, {}), true);
  assert.equal(conditionHolds({ arg: "count", exists: true }, args, {}), true);
  assert.equal(conditionHolds({ arg: "missing", exists: true }, args, {}), false);
  assert.equal(conditionHolds({ global: "theme", eq: "dark" }, args, { theme: "dark" }), true);
  // A value known only by its type, as a mapping to an icon is: unequal to
  // a string, and not to be compared with an object.
  assert.equal(conditionHolds({ arg: "icon", eq: "star" }, { icon: { $type: "object" } }, {}), false);
  assert.equal(conditionHolds({ arg: "icon", neq: { name: "star" } }, { icon: { $type: "object" } }, {}), null);
  assert.equal(conditionHolds({ arg: "icon" }, { icon: { $type: "object" } }, {}), true);
  // One Storybook would throw on.
  assert.equal(conditionHolds({ arg: "variant", global: "theme" }, args, {}), null);
  assert.equal(conditionHolds({ arg: "variant", eq: "a", neq: "b" }, args, {}), null);
});

test("previewArgUpdate: sends each value typed, and lifts the if of each hidden one", () => {
  const rejected = [
    ...findRejectedArgs({ variant: "link", size: "icon-sm" }, RADIX),
    { name: "disabled", value: "true", reasons: ["not-in-argtypes" as const] },
  ];
  assert.deepEqual(previewArgUpdate(rejected, RADIX, [BOOL]), { updates: { size: "icon-sm", disabled: true }, lift: ["size"] });
});

test("stillRejected: keeps only the values the story still isn't given, and any it lost", () => {
  const requested = { variant: "link", size: "xs" };
  const rejected = findRejectedArgs(requested, BUTTON);
  assert.deepEqual(stillRejected(requested, rejected, { ...BUTTON, rendered: { ...BUTTON.rendered, size: "xs" } }), []);
  assert.deepEqual(stillRejected(requested, rejected, BUTTON), rejected);
  assert.deepEqual(stillRejected(requested, rejected, { ...BUTTON, rendered: { size: "xs" } }), [{ name: "variant", value: "link", reasons: ["not-applied"] }]);
});

test("findRejectedArgs: a value given now but hidden once a rejected one applies is rejected too", () => {
  // The example's Button with outline left out of the options and size
  // hidden for it: ?args=variant:outline;size:sm leaves variant primary, so
  // size sm is given, until outline is applied.
  const snapshot: StoryArgsSnapshot = {
    fileName: null,
    argTypes: {
      variant: { type: "enum", options: ["primary", "danger"] },
      size: { type: "enum", options: ["sm", "lg"], if: { arg: "variant", neq: "outline" } },
    },
    stored: { variant: "primary", size: "sm" },
    rendered: { variant: "primary", size: "sm" },
    globals: {},
  };
  const rejected = findRejectedArgs({ variant: "outline", size: "sm" }, snapshot);
  assert.deepEqual(rejected.map((r) => [r.name, r.reasons]), [["variant", ["not-in-options"]], ["size", ["hidden-by-if"]]]);
  assert.deepEqual(previewArgUpdate(rejected, snapshot).lift, ["size"]);
});

test("parseIllegalValueWarning and rejectionsFromWarnings read Storybook's console warning", () => {
  const text = "Received illegal value for 'variant'. Supported options: 'default', 'secondary', 'destructive', 'outline'";
  assert.deepEqual(parseIllegalValueWarning(text), { name: "variant", options: ["default", "secondary", "destructive", "outline"] });
  assert.deepEqual(parseIllegalValueWarning("Received illegal value for 'tags[1]'. Supported options: 'a', 2"), { name: "tags", options: ["a", "2"] });
  assert.equal(parseIllegalValueWarning("something else"), null);
  assert.deepEqual(rejectionsFromWarnings({ variant: "ghost", size: "sm" }, [text, text]), [
    { name: "variant", value: "ghost", reasons: ["not-in-options"], options: ["default", "secondary", "destructive", "outline"] },
  ]);
});

test("typedArgValue: a boolean prop or argType is a boolean, a number argType a number", () => {
  assert.equal(typedArgValue("true", undefined, BOOL), true);
  assert.equal(typedArgValue("false", { type: "boolean" }), false);
  assert.equal(typedArgValue("2", { type: "number" }), 2);
  assert.equal(typedArgValue("sm", { type: "number" }), "sm");
  assert.equal(typedArgValue("sm", { type: "enum" }), "sm");
  // As the story's options type it: Storybook infers them from the docs'
  // literals, `"2"` a string and `2` a number.
  assert.equal(typedArgValue("2", { type: "enum", options: ["1", "2"] }), "2");
  assert.equal(typedArgValue("2", { type: "enum", options: [1, 2] }), 2);
  // One the options leave out, a number when they are all numbers.
  assert.equal(typedArgValue("4", { type: "enum", options: [1, 2, 3] }), 4);
  assert.equal(typedArgValue("4", { type: "enum", options: ["1", 2] }), "4");
});

test("compactArgTypes keeps what's there, sorted by name", () => {
  assert.deepEqual(compactArgTypes({
    variant: { type: "enum", control: "select", options: ["a"], if: undefined, mapping: undefined },
    children: { type: "other", control: "object" },
    hidden: { control: false },
  }), {
    children: { type: "other", control: "object" },
    hidden: { control: false },
    variant: { type: "enum", control: "select", options: ["a"] },
  });
});

test("argsNotInDocs: names the choices the story declares that the docs don't list", () => {
  // shadcn/ui's base Button: the docs list className, render, style, variant and size.
  const argTypes = compactArgTypes({
    ...BUTTON.argTypes,
    children: { type: "string", control: "text" },
    className: { type: "other", control: "object" },
    off: { type: "boolean", control: false },
  });
  assert.deepEqual(argsNotInDocs(argTypes, ["className", "render", "style", "variant", "size"]), ["disabled"]);
});

test("describeArgRejections: values measured through the preview are named with the story change", () => {
  const variants = [
    { combination: { variant: "default" }, status: "ok" },
    { combination: { variant: "ghost" }, status: "ok", appliedVia: "preview" as const, rejectedArgs: findRejectedArgs({ variant: "ghost" }, BADGE) },
    { combination: { variant: "link" }, status: "ok", appliedVia: "preview" as const, rejectedArgs: findRejectedArgs({ variant: "link" }, BADGE) },
  ];
  const [warning, ...rest] = describeArgRejections("ui/base/Badge", variants, { storyFile: BADGE.fileName, id: "ui-base-badge" });
  assert.equal(rest.length, 0);
  assert.match(warning, /^Storybook wouldn't take some of ui\/base\/Badge's values from the story URL, and would have rendered those 2 variants without them, as its default/);
  assert.match(warning, /`variant` ghost, link: the story's argTypes options for it are 'default', 'secondary', 'destructive', 'outline'/);
  assert.match(warning, /snap set them through Storybook's preview instead and measured what the component renders with them/);
  assert.match(warning, /add 'ghost', 'link' to argTypes\.variant\.options in \.\/registry\/ui\/badge-story\/badge-base\.stories\.tsx\.$/);
});

test("describeArgRejections: values not measured say so, how to measure them, and the if to remove", () => {
  const variants = [
    { combination: { variant: "link", size: "xs" }, status: "arg_rejected", rejectedArgs: findRejectedArgs({ variant: "link", size: "xs" }, BUTTON) },
    { combination: { variant: "link", size: "sm" }, status: "arg_rejected", rejectedArgs: [{ ...findRejectedArgs({ variant: "link", size: "xs" }, BUTTON)[0], value: "sm" }] },
  ];
  const [warning, ...rest] = describeArgRejections("ui/base/Button", variants, { storyFile: BUTTON.fileName, id: "ui-base-button" });
  assert.equal(rest.length, 0);
  assert.match(warning, /^Storybook wouldn't render 2 of ui\/base\/Button's variants with the values asked for, and snap couldn't set them through its preview either, so they were not measured \(status arg_rejected\)/);
  assert.match(warning, /`size` xs, sm: its argTypes `if: \{"arg":"variant","neq":"link"\}` hides it/);
  assert.match(warning, /remove `if: \{"arg":"variant","neq":"link"\}` from argTypes\.size in \.\/registry\/ui\/button-story\/button-base\.stories\.tsx, then measure the component again with --components ui-base-button --merge\.$/);
  // Nothing to say about a component whose story took every value.
  assert.deepEqual(describeArgRejections("ui/base/Card", [{ combination: {}, status: "ok" }]), []);
});

test("describeArgRejections: a value no story change lets the URL carry is set without a warning, or said to be beyond one", () => {
  const cols = (value: string) => [{ name: "cols", value, reasons: ["number-in-url" as const], options: ["1", "2"] }];
  // Measured through the preview, with nothing the user can change: no warning.
  assert.deepEqual(describeArgRejections("Grid", [
    { combination: { cols: "1" }, status: "ok" },
    { combination: { cols: "2" }, status: "ok", appliedVia: "preview" as const, rejectedArgs: cols("2") },
  ]), []);
  // Not measured: said, without a story change that wouldn't help.
  const [refused, ...rest] = describeArgRejections("Grid", [{ combination: { cols: "2" }, status: "arg_rejected", rejectedArgs: cols("2") }], { id: "grid" });
  assert.deepEqual(rest, []);
  assert.match(refused, /`cols` 2: Storybook's URL reads it as a number, and the story's options list it only as a string, so no argTypes change lets the URL carry it\./);
  assert.match(refused, /No change to the story lets its URL carry it, and the variant's error says why the preview didn't take it either\.$/);
});

test("describeArgRejections: values set through the preview of a variant that then failed still name the story change", () => {
  const ghost = findRejectedArgs({ variant: "ghost" }, BADGE);
  const [some] = describeArgRejections("ui/base/Badge", [
    { combination: { variant: "ghost" }, status: "ok", appliedVia: "preview" as const, rejectedArgs: ghost },
    { combination: { variant: "link" }, status: "render_error", appliedVia: "preview" as const, rejectedArgs: findRejectedArgs({ variant: "link" }, BADGE) },
  ], { storyFile: BADGE.fileName });
  assert.match(some, /would have rendered those 2 variants without them/);
  assert.match(some, /measured what the component renders with them, though 1 of those variants then failed, as their errors say\./);
  assert.match(some, /add 'ghost', 'link' to argTypes\.variant\.options in /);
  const [all] = describeArgRejections("ui/base/Badge", [
    { combination: { variant: "ghost" }, status: "element_not_found", appliedVia: "preview" as const, rejectedArgs: ghost },
  ]);
  assert.match(all, /snap set them through Storybook's preview instead and then that variant failed, as its error says\. To let the story take them as well, add 'ghost' to argTypes\.variant\.options\.$/);
});

test("describeUncheckedArgs: says when the preview couldn't be read, naming the variants", () => {
  assert.equal(describeUncheckedArgs("X", [], 3), null);
  const all = describeUncheckedArgs("X", ["a", "b", "c"], 3, { error: "the page has no window.__STORYBOOK_PREVIEW__", id: "x" })!;
  assert.match(all, /^snap couldn't read Storybook's preview to confirm that X's story was given the values asked for, for its variants \(the page has no window\.__STORYBOOK_PREVIEW__\)\./);
  assert.match(all, /those variants are marked argsChecked: false, which fails --strict and which verify names beside its score\. Measure the component again with --components x --merge\.$/);
  // Some of them: named, the first few, so the user can find them.
  assert.match(describeUncheckedArgs("X", ["variant-ghost"], 3)!, /for 1 of 3 variants \(variant-ghost\)\. .*that variant is marked argsChecked: false/);
  const slugs = ["a", "b", "c", "d", "e", "f", "g"];
  assert.match(describeUncheckedArgs("X", slugs, 9)!, /for 7 of 9 variants \(a, b, c, d, e and 2 more\)\./);
  assert.equal(nameSlugs(["a", "b"]), "a, b");
});

test("openArg: open, else defaultOpen, where the story's argTypes or the component's documented props have it, and nothing else", () => {
  assert.equal(openArg({ open: { type: "boolean", control: "boolean" }, defaultOpen: { type: "boolean" } }), "open");
  assert.equal(openArg({ defaultOpen: { control: "boolean" } }), "defaultOpen");
  assert.equal(openArg({}, ["modal", "defaultOpen"]), "defaultOpen");
  assert.equal(openArg(undefined, ["open"]), "open");
  // An `open` that isn't a boolean is something else: a callback's name, say.
  assert.equal(openArg({ open: { type: "function" } }, ["defaultOpen"]), "defaultOpen");
  assert.equal(openArg({ side: { options: ["left", "right"] } }, ["modal"]), null);
  assert.equal(openArg(undefined), null);
});
