import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mapComponent } from "../mapper.js";
import type { StorybookComponent } from "../mapper.js";
import {
  argTypeExclusion, argTypeProp, checkPropFlags, describeExclusions, describeUnseenArgTypes, readSnapProps, resolveProps, snapPropSource,
} from "../props.js";

// shadcn/ui Button as Storybook's docs list it: no `disabled`, which its story declares.
const BUTTON: StorybookComponent = {
  name: "Button",
  props: [
    { name: "variant", type: { name: "union", raw: '"default" | "outline" | null' }, defaultValue: "default" },
    { name: "className", type: { name: "string" } },
  ],
  stories: [],
};

const BUTTON_ARG_TYPES = {
  variant: { type: "enum", control: "select", options: ["default", "outline", "ghost"], initial: "default" },
  disabled: { type: "boolean", control: "boolean", initial: false },
  children: { type: "string", control: "text", initial: "Button" },
};

test("resolveProps: a choice only the story's argTypes declare becomes a variant property, its default the story's own", () => {
  const source = resolveProps(BUTTON, { argTypes: BUTTON_ARG_TYPES });
  const def = mapComponent(source.component);
  assert.deepEqual(def.variantProperties, [
    { name: "variant", type: "VARIANT", values: ["default", "outline", "ghost"], defaultValue: "default" },
    { name: "disabled", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" },
  ]);
  assert.deepEqual(source.added, ["disabled"]);
  assert.equal(source.argTypes, true);
  assert.deepEqual(source.excluded, []);

  // Sheet's `side`: options only, the story's arg its default, led by it.
  const sheet = resolveProps({ name: "Sheet", props: [], stories: [] }, { argTypes: { side: { type: "string", control: "radio", options: ["top", "bottom", "left", "right"], initial: "right" } } });
  assert.deepEqual(mapComponent(sheet.component).variantProperties, [
    { name: "side", type: "VARIANT", values: ["right", "top", "bottom", "left"], defaultValue: "right" },
  ]);

  // Without argTypes, the docs alone, and said so.
  const docsOnly = resolveProps(BUTTON);
  assert.deepEqual(mapComponent(docsOnly.component).variantProperties.map((p) => p.name), ["variant"]);
  assert.equal(docsOnly.argTypes, false);
});

test("resolveProps: what the argTypes mark as behavior is left out, each with its reason, unless --keep-props names it", () => {
  const drawer: StorybookComponent = {
    name: "Drawer",
    props: ["open", "modal", "dismissible", "loop", "checked"].map((name) => ({ name, type: { name: "boolean" } })),
    stories: [],
  };
  const argTypes = {
    open: { type: "boolean", control: false as const },
    modal: { type: "boolean", control: "boolean", hidden: true as const },
    dismissible: { type: "boolean", control: "boolean", category: "Events" },
    loop: { type: "boolean", control: "boolean", action: true as const },
    checked: { type: "boolean", control: "boolean" },
  };
  const source = resolveProps(drawer, { argTypes });
  assert.deepEqual(source.excluded, [
    { name: "open", reason: "no-control" },
    { name: "modal", reason: "hidden" },
    { name: "dismissible", reason: "event" },
    { name: "loop", reason: "event" },
  ]);
  // A prop that changes the look stays.
  assert.deepEqual(source.component.props.map((p) => p.name), ["checked"]);

  const kept = resolveProps(drawer, { argTypes, keep: ["MODAL"] });
  assert.deepEqual(kept.component.props.map((p) => p.name), ["modal", "checked"]);
});

test("resolveProps: what snap measured as behavior, and --exclude-props, are left out; --keep-props keeps the measured", () => {
  const command: StorybookComponent = {
    name: "Command",
    props: ["shouldFilter", "loop", "size"].map((name) => ({ name, type: { name: "boolean" } })),
    stories: [],
  };
  const measured = [{ name: "loop", reason: "no-op" as const, markup: "same" as const }, { name: "shouldFilter", reason: "no-op" as const }];
  const source = resolveProps(command, { measured, exclude: ["SIZE"] });
  assert.deepEqual(source.excluded, [
    { name: "shouldFilter", reason: "no-op" },
    { name: "loop", reason: "no-op", markup: "same" },
    { name: "size", reason: "excluded" },
  ]);
  assert.deepEqual(source.component.props, []);
  assert.deepEqual(resolveProps(command, { measured, keep: ["loop"] }).component.props.map((p) => p.name), ["loop", "size"]);
  // A prop that would never map isn't listed as left out.
  assert.deepEqual(resolveProps(BUTTON, { exclude: ["className"] }).excluded, []);
});

test("argTypeProp and argTypeExclusion: a choice as the docs would list it, and the marks of behavior", () => {
  assert.deepEqual(argTypeProp("disabled", { type: "boolean", initial: true }), { name: "disabled", type: { name: "boolean" }, defaultValue: "true" });
  assert.deepEqual(argTypeProp("cols", { type: "number", control: "select", options: [1, 2, 2] }), { name: "cols", type: { name: "enum" }, control: { type: "select", options: ["1", "2"] } });
  assert.equal(argTypeProp("label", { type: "string", control: "text" }), null);
  assert.equal(argTypeExclusion(undefined), null);
  assert.equal(argTypeExclusion({ control: "boolean" }), null);
  assert.equal(argTypeExclusion({ control: false }), "no-control");
  assert.equal(argTypeExclusion({ hidden: true }), "hidden");
  assert.equal(argTypeExclusion({ category: "events" }), "event");
  assert.equal(argTypeExclusion({ action: true }), "event");
});

test("checkPropFlags: a name both --exclude-props and --keep-props give is refused", () => {
  assert.doesNotThrow(() => checkPropFlags(["open"], ["modal"]));
  assert.throws(() => checkPropFlags(["open", "Modal"], ["modal"]), /--exclude-props and --keep-props both name "Modal": leave it in one of them/);
});

test("describeExclusions: once per component, by reason, saying how to keep one", () => {
  assert.equal(describeExclusions([]), null);
  assert.equal(
    describeExclusions([
      { name: "open", reason: "opens", value: "true" },
      { name: "modal", reason: "no-op", markup: "changed" },
      { name: "nested", reason: "no-op", markup: "changed" },
      { name: "size", reason: "excluded" },
    ]),
    "left out `open` (open=true opens what it shows, so snap measures every variant with it), " +
      "`modal` and `nested` (every value measured the same though the markup changed with it: behavior only), " +
      "`size` (--exclude-props); to make one a variant property again, pass --keep-props <name>",
  );
  assert.equal(
    describeExclusions([{ name: "loop", reason: "no-op", markup: "same" }]),
    "left out `loop` (every value measured the same, markup included: behavior only, or the story doesn't pass it through); to make it a variant property again, pass --keep-props loop",
  );
  assert.equal(describeExclusions([{ name: "size", reason: "excluded" }]), "left out `size` (--exclude-props)");
});

test("readSnapProps and snapPropSource: what a snap recorded, by component ID, for a command without a browser", () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-props-"));
  try {
    assert.equal(readSnapProps(dir), null);
    writeFileSync(join(dir, "styles.json"), JSON.stringify({
      components: [
        { id: "ui-base-button", argTypes: BUTTON_ARG_TYPES },
        { id: "ui-base-command", excludedProps: [{ name: "variant", reason: "no-op" }] },
      ],
    }));
    const snap = readSnapProps(dir)!;
    assert.equal(snap.path, join(dir, "styles.json"));
    assert.deepEqual(mapComponent(snapPropSource(BUTTON, "ui-base-button", snap, {}).component).variantProperties.map((p) => p.name), ["variant", "disabled"]);
    const command = snapPropSource(BUTTON, "ui-base-command", snap, {});
    assert.deepEqual([command.argTypes, command.excluded], [false, [{ name: "variant", reason: "no-op" }]]);
    assert.equal(snapPropSource(BUTTON, "ui-base-other", snap, {}).argTypes, false);

    // A snap taken with --exclude-props leaves those out of every component.
    writeFileSync(join(dir, "styles.json"), JSON.stringify({ excludeProps: ["variant"], components: [] }));
    assert.deepEqual(snapPropSource(BUTTON, "ui-base-button", readSnapProps(dir), {}).excluded, [{ name: "variant", reason: "excluded" }]);
    assert.deepEqual(snapPropSource(BUTTON, "ui-base-button", readSnapProps(dir), { keep: ["variant"] }).excluded, []);

    writeFileSync(join(dir, "styles.json"), "{ not json");
    assert.throws(() => readSnapProps(dir), /styles\.json can't be read as JSON .*, so the argTypes snap recorded in it can't be used: measure again with snap, or pass --no-snap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("describeUnseenArgTypes: says which argTypes a command without a browser couldn't see, and how to let it", () => {
  assert.equal(describeUnseenArgTypes(null, [], 3), null);
  assert.match(describeUnseenArgTypes(null, ["a", "b"], 2)!, /^Without a browser, storysync can't see the stories' argTypes: there is no snap to read them from\. .*Run snap first, or point --snap at its directory\.$/);
  assert.match(describeUnseenArgTypes(".storysync/snaps/styles.json", ["a"], 4)!, /can't see the argTypes of 1 of 4 components \(a\): \.storysync\/snaps\/styles\.json doesn't have those\./);
});
