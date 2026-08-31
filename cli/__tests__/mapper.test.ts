import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapComponent,
  mapProp,
  shouldSkip,
  extractEnumValues,
  resolveDefault,
  cartesian,
  totalCombinations,
  enumerateCombinations,
} from "../mapper.js";
import type { StorybookProp, FigmaVariantProperty, StorybookComponent } from "../mapper.js";

function prop(partial: Partial<StorybookProp> & { name: string }): StorybookProp {
  return { type: { name: "string" }, ...partial };
}

function variantProp(name: string, values: string[], defaultValue?: string): FigmaVariantProperty {
  return { name, type: "VARIANT", values, defaultValue: defaultValue ?? values[0] };
}

function component(props: StorybookProp[], name = "Button"): StorybookComponent {
  return { name, props, stories: [] };
}

// --- shouldSkip ---

test("shouldSkip: skips structural and style props", () => {
  for (const name of ["children", "className", "class", "style", "ref", "key", "as"]) {
    assert.equal(shouldSkip(prop({ name })), true, `expected ${name} to be skipped`);
  }
});

test("shouldSkip: skips event handlers", () => {
  assert.equal(shouldSkip(prop({ name: "onClick" })), true);
  assert.equal(shouldSkip(prop({ name: "onMouseEnter" })), true);
  // `once` starts with "on" but not "on[A-Z]", so it is not a handler.
  assert.equal(shouldSkip(prop({ name: "once", type: { name: "boolean" } })), false);
});

test("shouldSkip: skips aria-* and data-* attributes", () => {
  assert.equal(shouldSkip(prop({ name: "aria-label" })), true);
  assert.equal(shouldSkip(prop({ name: "data-testid" })), true);
});

test("shouldSkip: skips callback and non-visual types", () => {
  assert.equal(shouldSkip(prop({ name: "handler", type: { name: "func" } })), true);
  assert.equal(shouldSkip(prop({ name: "cb", type: { name: "(e: Event) => void" } })), true);
  assert.equal(shouldSkip(prop({ name: "icon", type: { name: "ReactNode" } })), true);
  assert.equal(shouldSkip(prop({ name: "el", type: { name: "JSX.Element" } })), true);
  assert.equal(shouldSkip(prop({ name: "r", type: { name: "Ref<HTMLDivElement>" } })), true);
  assert.equal(shouldSkip(prop({ name: "css", type: { name: "CSSProperties" } })), true);
});

test("shouldSkip: skips free string/number but keeps them when options are declared", () => {
  assert.equal(shouldSkip(prop({ name: "label", type: { name: "string" } })), true);
  assert.equal(shouldSkip(prop({ name: "count", type: { name: "number" } })), true);
  assert.equal(
    shouldSkip(prop({ name: "size", type: { name: "string" }, control: { options: ["sm", "lg"] } })),
    false,
  );
});

// --- extractEnumValues ---

test("extractEnumValues: prefers argType control options", () => {
  const values = extractEnumValues(
    prop({ name: "variant", type: { name: "union", raw: '"ignored"' }, control: { options: ["a", "b"] } }),
  );
  assert.deepEqual(values, ["a", "b"]);
});

test("extractEnumValues: reads react-docgen enum objects", () => {
  const values = extractEnumValues(
    prop({
      name: "variant",
      type: { name: "enum", value: [{ name: "literal", raw: "'primary'" }, { name: "literal", raw: "'ghost'" }] },
    }),
  );
  assert.deepEqual(values, ["primary", "ghost"]);
});

test("extractEnumValues: reads react-docgen union literals", () => {
  const values = extractEnumValues(
    prop({
      name: "size",
      type: { name: "union", value: [{ name: "literal", raw: "'sm'" }, { name: "literal", raw: "'lg'" }] },
    }),
  );
  assert.deepEqual(values, ["sm", "lg"]);
});

test("extractEnumValues: ignores non-literal members of a union", () => {
  const values = extractEnumValues(
    prop({
      name: "size",
      type: { name: "union", value: [{ name: "literal", raw: "'sm'" }, { name: "string" }] },
    }),
  );
  assert.deepEqual(values, ["sm"]);
});

test("extractEnumValues: parses a raw union type string", () => {
  const values = extractEnumValues(prop({ name: "size", type: { name: "union", raw: `"sm" | "md" | "lg"` } }));
  assert.deepEqual(values, ["sm", "md", "lg"]);
});

test("extractEnumValues: rejects a raw union with non-literal members", () => {
  assert.equal(extractEnumValues(prop({ name: "size", type: { name: "union", raw: `"sm" | number` } })), null);
});

test("extractEnumValues: returns null when there is nothing to extract", () => {
  assert.equal(extractEnumValues(prop({ name: "label", type: { name: "string" } })), null);
});

// --- resolveDefault ---

test("resolveDefault: unwraps primitives, quotes, and docgen shapes", () => {
  assert.equal(resolveDefault("'md'"), "md");
  assert.equal(resolveDefault(true), "true");
  assert.equal(resolveDefault(3), "3");
  assert.equal(resolveDefault({ summary: "'lg'" }), "lg");
  assert.equal(resolveDefault({ value: '"sm"' }), "sm");
  assert.equal(resolveDefault(null), null);
  assert.equal(resolveDefault(undefined), null);
});

// --- mapProp ---

test("mapProp: maps booleans, honouring the declared default", () => {
  assert.deepEqual(mapProp(prop({ name: "disabled", type: { name: "boolean" } })), {
    name: "disabled", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false",
  });
  assert.deepEqual(mapProp(prop({ name: "loading", type: { name: "bool" }, defaultValue: true })), {
    name: "loading", type: "BOOLEAN", values: ["true", "false"], defaultValue: "true",
  });
  // A boolean *control* is honoured when the declared type isn't itself
  // something `shouldSkip` rejects outright.
  assert.deepEqual(mapProp(prop({ name: "open", type: { name: "any" }, control: { type: "boolean" } })), {
    name: "open", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false",
  });
});

// Pins an ordering subtlety rather than leaving it accidental: `shouldSkip`
// runs before the boolean check, and it rejects `string`/`number` props that
// carry no `control.options`. So a prop declaring `type: string` alongside
// `control: { type: "boolean" }` — contradictory metadata — is skipped rather
// than mapped to a BOOLEAN variant.
test("mapProp: a string-typed prop with a boolean control is skipped", () => {
  assert.equal(mapProp(prop({ name: "open", type: { name: "string" }, control: { type: "boolean" } })), null);
});

test("mapProp: uses the declared default when it is one of the values", () => {
  const result = mapProp(prop({
    name: "size", type: { name: "union", raw: `"sm" | "md" | "lg"` }, defaultValue: "md",
  }));
  assert.equal(result?.defaultValue, "md");
});

test("mapProp: falls back to the first value when the default is not a valid option", () => {
  const result = mapProp(prop({
    name: "size", type: { name: "union", raw: `"sm" | "md" | "lg"` }, defaultValue: "enormous",
  }));
  assert.equal(result?.defaultValue, "sm");
});

test("mapProp: returns null for skipped and unmappable props", () => {
  assert.equal(mapProp(prop({ name: "children" })), null);
  assert.equal(mapProp(prop({ name: "label", type: { name: "string" } })), null);
});

// --- totalCombinations ---

test("totalCombinations: multiplies value counts", () => {
  assert.equal(totalCombinations([]), 1);
  assert.equal(totalCombinations([variantProp("a", ["1", "2", "3"])]), 3);
  assert.equal(
    totalCombinations([variantProp("a", ["1", "2", "3"]), variantProp("b", ["x", "y"])]),
    6,
  );
});

test("totalCombinations: clamps instead of overflowing", () => {
  const many = Array.from({ length: 60 }, (_, i) => variantProp(`p${i}`, ["a", "b", "c", "d"]));
  assert.equal(totalCombinations(many), Number.MAX_SAFE_INTEGER);
});

// --- enumerateCombinations / uncapped ordering ---

test("enumerateCombinations: last property varies fastest", () => {
  const combos = [...enumerateCombinations([
    variantProp("variant", ["a", "b"]),
    variantProp("size", ["sm", "lg"]),
  ])];
  assert.deepEqual(combos, [
    { variant: "a", size: "sm" },
    { variant: "a", size: "lg" },
    { variant: "b", size: "sm" },
    { variant: "b", size: "lg" },
  ]);
});

test("cartesian: no properties yields a single empty combination", () => {
  assert.deepEqual(cartesian([]), { combinations: [{}], wasCapped: false });
});

test("cartesian: uncapped output preserves historical ordering and omits cap info", () => {
  const result = cartesian([
    variantProp("variant", ["default", "destructive"]),
    variantProp("size", ["sm", "md", "lg"]),
  ]);
  assert.equal(result.wasCapped, false);
  assert.equal(result.cap, undefined);
  assert.deepEqual(result.combinations, [
    { variant: "default", size: "sm" },
    { variant: "default", size: "md" },
    { variant: "default", size: "lg" },
    { variant: "destructive", size: "sm" },
    { variant: "destructive", size: "md" },
    { variant: "destructive", size: "lg" },
  ]);
});

test("cartesian: a product exactly at the cap is not treated as capped", () => {
  const props = Array.from({ length: 8 }, (_, i) => variantProp(`p${i}`, ["a", "b"])); // 2^8 = 256
  const result = cartesian(props);
  assert.equal(result.wasCapped, false);
  assert.equal(result.combinations.length, 256);
});

// --- capped behaviour ---

// Regression test for the original bug: cartesian() returned early from inside
// the property loop, so combinations were emitted without keys for properties
// it had not reached yet.
test("cartesian: every capped combination carries every property key", () => {
  const props = [
    variantProp("a", Array.from({ length: 20 }, (_, i) => `a${i}`)),
    variantProp("b", Array.from({ length: 20 }, (_, i) => `b${i}`)),
    variantProp("c", ["c0", "c1"]),
  ];
  const result = cartesian(props);
  assert.equal(result.wasCapped, true);
  assert.equal(result.combinations.length, 256);
  for (const combo of result.combinations) {
    assert.deepEqual(Object.keys(combo).sort(), ["a", "b", "c"]);
  }
});

test("cartesian: capped output leads with the all-defaults combination", () => {
  const props = [
    variantProp("a", Array.from({ length: 20 }, (_, i) => `a${i}`), "a5"),
    variantProp("b", Array.from({ length: 20 }, (_, i) => `b${i}`), "b7"),
    variantProp("c", ["c0", "c1"], "c1"),
  ];
  const result = cartesian(props);
  assert.deepEqual(result.combinations[0], { a: "a5", b: "b7", c: "c1" });
});

test("cartesian: capped output represents every declared value at least once", () => {
  const props = [
    variantProp("a", Array.from({ length: 20 }, (_, i) => `a${i}`)),
    variantProp("b", Array.from({ length: 20 }, (_, i) => `b${i}`)),
    variantProp("c", ["c0", "c1"]),
  ];
  const result = cartesian(props);
  for (const p of props) {
    const seen = new Set(result.combinations.map((c) => c[p.name]));
    for (const value of p.values) {
      assert.ok(seen.has(value), `value ${p.name}=${value} missing from capped output`);
    }
  }
});

test("cartesian: capped output contains no duplicates", () => {
  const props = [
    variantProp("a", Array.from({ length: 20 }, (_, i) => `a${i}`)),
    variantProp("b", Array.from({ length: 20 }, (_, i) => `b${i}`)),
  ];
  const result = cartesian(props);
  const keys = result.combinations.map((c) => JSON.stringify(c));
  assert.equal(new Set(keys).size, keys.length);
});

test("cartesian: cap info reports accurate totals and a bounded sample", () => {
  const props = [
    variantProp("a", Array.from({ length: 20 }, (_, i) => `a${i}`)),
    variantProp("b", Array.from({ length: 20 }, (_, i) => `b${i}`)),
  ]; // 400 possible
  const result = cartesian(props);
  assert.ok(result.cap);
  assert.equal(result.cap!.maxCombinations, 256);
  assert.equal(result.cap!.totalPossible, 400);
  assert.equal(result.cap!.generated, 256);
  assert.equal(result.cap!.droppedCount, 400 - 256);
  assert.ok(result.cap!.droppedSample.length > 0);
  assert.ok(result.cap!.droppedSample.length <= 20);
  for (const combo of result.cap!.droppedSample) {
    assert.deepEqual(Object.keys(combo).sort(), ["a", "b"]);
  }
});

test("cartesian: dropped sample excludes emitted combinations", () => {
  const props = [
    variantProp("a", Array.from({ length: 20 }, (_, i) => `a${i}`)),
    variantProp("b", Array.from({ length: 20 }, (_, i) => `b${i}`)),
  ];
  const result = cartesian(props);
  const emitted = new Set(result.combinations.map((c) => JSON.stringify(c)));
  for (const combo of result.cap!.droppedSample) {
    assert.equal(emitted.has(JSON.stringify(combo)), false);
  }
});

test("cartesian: capped output is deterministic across runs", () => {
  const build = () => [
    variantProp("a", Array.from({ length: 20 }, (_, i) => `a${i}`)),
    variantProp("b", Array.from({ length: 20 }, (_, i) => `b${i}`)),
  ];
  assert.deepEqual(cartesian(build()), cartesian(build()));
});

test("cartesian: distinguishes values that differ only by space placement", () => {
  const props = [
    variantProp("a", ["x y", "x"]),
    variantProp("b", ["z", "y z"]),
  ];
  const result = cartesian(props);
  assert.equal(result.combinations.length, 4);
});

// --- mapComponent ---

test("mapComponent: maps props and carries metadata through", () => {
  const def = mapComponent({
    name: "Button",
    title: "Forms/Button",
    category: "Forms",
    props: [
      prop({ name: "variant", type: { name: "union", raw: `"default" | "ghost"` } }),
      prop({ name: "disabled", type: { name: "boolean" } }),
      prop({ name: "children" }),
      prop({ name: "onClick", type: { name: "func" } }),
    ],
    stories: [],
  });

  assert.equal(def.name, "Button");
  assert.equal(def.title, "Forms/Button");
  assert.equal(def.category, "Forms");
  assert.deepEqual(def.variantProperties.map((p) => p.name), ["variant", "disabled"]);
  assert.equal(def.variantCombinations.length, 4);
  assert.equal(def.wasCapped, false);
  assert.equal(def.cap, undefined);
});

test("mapComponent: a component with no mappable props yields one empty combination", () => {
  const def = mapComponent(component([prop({ name: "children" }), prop({ name: "label", type: { name: "string" } })]));
  assert.deepEqual(def.variantProperties, []);
  assert.deepEqual(def.variantCombinations, [{}]);
  assert.equal(def.wasCapped, false);
});

test("mapComponent: surfaces cap info when the product is truncated", () => {
  const def = mapComponent(component([
    prop({ name: "a", control: { options: Array.from({ length: 20 }, (_, i) => `a${i}`) } }),
    prop({ name: "b", control: { options: Array.from({ length: 20 }, (_, i) => `b${i}`) } }),
  ]));
  assert.equal(def.wasCapped, true);
  assert.equal(def.cap?.totalPossible, 400);
  assert.equal(def.variantCombinations.length, 256);
});
