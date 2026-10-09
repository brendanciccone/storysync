import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapComponent,
  supplementOptions,
  mapProp,
  shouldSkip,
  extractEnumValues,
  splitUnion,
  explainProp,
  withoutProps,
  parsePropNames,
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

// Radix's asChild hands the component's look to its child, and with the
// text child most stories pass it renders nothing; Base UI's render swaps
// the element. Neither is a design choice a Figma variant can show.
test("shouldSkip: skips composition props that swap the rendered element", () => {
  assert.equal(shouldSkip(prop({ name: "asChild", type: { name: "boolean" }, defaultValue: "false" })), true);
  assert.equal(shouldSkip(prop({ name: "render", type: { name: "union", raw: "ReactElement | ComponentRenderFn<HTMLProps, ButtonState>" } })), true);
  assert.equal(mapProp(prop({ name: "asChild", type: { name: "boolean" } })), null);
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

// react-docgen-typescript prints cva's VariantProps as `"a" | "b" | null`,
// so every variant of a shadcn component carries a `| null`. It means the
// prop can be left unset, not that null is a value.
test("extractEnumValues: leaves null and undefined out of a raw union", () => {
  assert.deepEqual(extractEnumValues(prop({ name: "variant", type: { name: "union", raw: `"a" | "b" | null` } })), ["a", "b"]);
  assert.deepEqual(extractEnumValues(prop({ name: "variant", type: { name: "union", raw: `"a" | undefined` } })), ["a"]);
  assert.deepEqual(extractEnumValues(prop({ name: "variant", type: { name: "union", raw: `null | "a" | undefined | "b"` } })), ["a", "b"]);
});

test("extractEnumValues: still rejects a union with other non-literal members, or none at all", () => {
  assert.equal(extractEnumValues(prop({ name: "size", type: { name: "union", raw: `"sm" | number | null` } })), null);
  assert.equal(extractEnumValues(prop({ name: "size", type: { name: "union", raw: `null | undefined` } })), null);
});

// With null and undefined left out, a template literal type was all that
// was left of `${number}px | null`, and it became a value named "${number}px".
test("extractEnumValues: a template literal type with a placeholder is not a value", () => {
  assert.equal(extractEnumValues(prop({ name: "width", type: { name: "union", raw: "`${number}px` | null" } })), null);
  assert.equal(extractEnumValues(prop({ name: "width", type: { name: "union", raw: "`${number}px` | \"auto\"" } })), null);
});

test("splitUnion: splits only on a top-level |", () => {
  assert.deepEqual(splitUnion(`"sm" | "lg" | null`), [`"sm"`, `"lg"`, "null"]);
  assert.deepEqual(splitUnion("(value: string | null) => void"), ["(value: string | null) => void"]);
  assert.deepEqual(splitUnion(`("a" | "b")[] | null`), [`("a" | "b")[]`, "null"]);
  assert.deepEqual(splitUnion(`Array<"a" | "b"> | { kind: "x" | "y" }`), [`Array<"a" | "b">`, `{ kind: "x" | "y" }`]);
  assert.deepEqual(splitUnion("(() => void) | null"), ["(() => void)", "null"]);
  // A literal may hold a | of its own, or an escaped quote.
  assert.deepEqual(splitUnion(`"a|b" | 'c\\'d' | "e"`), [`"a|b"`, `'c\\'d'`, `"e"`]);
});

test("extractEnumValues: a literal holding a | is one value", () => {
  assert.deepEqual(extractEnumValues(prop({ name: "sep", type: { name: "union", raw: `"a|b" | "c" | undefined` } })), ["a|b", "c"]);
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

test("mapProp: maps booleans, honoring the declared default", () => {
  assert.deepEqual(mapProp(prop({ name: "disabled", type: { name: "boolean" }, defaultValue: "false" })), {
    name: "disabled", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false",
  });
  assert.deepEqual(mapProp(prop({ name: "disabled", type: { name: "boolean" } })), {
    name: "disabled", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false", defaultAssumed: true,
  });
  assert.deepEqual(mapProp(prop({ name: "loading", type: { name: "bool" }, defaultValue: true })), {
    name: "loading", type: "BOOLEAN", values: ["true", "false"], defaultValue: "true",
  });
  // A boolean *control* is honored when the declared type isn't itself
  // something `shouldSkip` rejects outright.
  assert.deepEqual(mapProp(prop({ name: "open", type: { name: "any" }, control: { type: "boolean" } })), {
    name: "open", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false", defaultAssumed: true,
  });
});

test("mapProp: a boolean that may be null or undefined is still a BOOLEAN", () => {
  // cva's boolean variants print as `boolean | null`.
  assert.deepEqual(mapProp(prop({ name: "inset", type: { name: "union", raw: "boolean | null" }, defaultValue: "true" })), {
    name: "inset", type: "BOOLEAN", values: ["true", "false"], defaultValue: "true",
  });
  assert.deepEqual(mapProp(prop({ name: "dot", type: { name: "union", raw: "true | false | undefined" } })), {
    name: "dot", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false", defaultAssumed: true,
  });
  // A boolean with another value besides is neither a BOOLEAN nor a set of literals.
  assert.equal(mapProp(prop({ name: "checked", type: { name: "union", raw: `boolean | "indeterminate"` } })), null);
});

// Only `boolean` left once null is gone is a BOOLEAN. Any other single member
// is not: Base UI's InputOTP has `noScriptCSSFallback: string | null`.
test("mapProp: a nullable union of one other member is not a BOOLEAN", () => {
  assert.equal(mapProp(prop({ name: "noScriptCSSFallback", type: { name: "union", raw: "string | null" } })), null);
  assert.equal(mapProp(prop({ name: "count", type: { name: "union", raw: "number | undefined" } })), null);
  assert.deepEqual(mapProp(prop({ name: "tone", type: { name: "union", raw: `"a" | null` }, defaultValue: "a" })), {
    name: "tone", type: "VARIANT", values: ["a"], defaultValue: "a",
  });
  assert.deepEqual(mapProp(prop({ name: "tone", type: { name: "union", raw: `"true" | null` }, defaultValue: "true" })), {
    name: "tone", type: "VARIANT", values: ["true"], defaultValue: "true",
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

// Figma makes a set's top-left variant its default, and the skill lays the
// set out in this order, so the default leads. The docs print TypeScript's
// order, not the author's: shadcn's Button reads link first.
test("mapProp: puts the declared default first and keeps the rest in order", () => {
  assert.deepEqual(mapProp(prop({
    name: "variant",
    type: { name: "union", raw: `"link" | "default" | "outline" | "secondary" | "ghost" | "destructive" | null` },
    defaultValue: "default",
  })), {
    name: "variant", type: "VARIANT",
    values: ["default", "link", "outline", "secondary", "ghost", "destructive"],
    defaultValue: "default",
  });
  assert.deepEqual(
    mapProp(prop({ name: "size", type: { name: "union", raw: `"sm" | "md" | "lg"` }, defaultValue: "lg" }))?.values,
    ["lg", "sm", "md"],
  );
  // With no declared default, nothing moves.
  assert.deepEqual(mapProp(prop({ name: "size", type: { name: "union", raw: `"sm" | "md" | "lg"` } }))?.values, ["sm", "md", "lg"]);
});

test("mapProp: falls back to the first value when the default is not a valid option", () => {
  const result = mapProp(prop({
    name: "size", type: { name: "union", raw: `"sm" | "md" | "lg"` }, defaultValue: "enormous",
  }));
  assert.equal(result?.defaultValue, "sm");
  assert.equal(result?.defaultAssumed, true);
});

// shadcn/ui's Tailwind v3 Button sets its defaults only in cva's
// defaultVariants, so the docs print none, and TypeScript's union order
// put link first: Figma's default, and snap's base, were variant=link.
test("mapProp: with no default in the docs, assumes the value named default", () => {
  const variant = { name: "union", raw: `"link" | "default" | "outline" | null` };
  assert.deepEqual(mapProp(prop({ name: "variant", type: variant })), {
    name: "variant", type: "VARIANT", values: ["default", "link", "outline"], defaultValue: "default", defaultAssumed: true,
  });
  // A default the docs give wins over the name.
  assert.equal(mapProp(prop({ name: "variant", type: variant, defaultValue: "outline" }))?.defaultValue, "outline");
  // With no value of that name, the first.
  assert.equal(mapProp(prop({ name: "align", type: { name: "union", raw: `"center" | "left"` } }))?.defaultValue, "center");
});

// Map JSON is a baseline the GitHub Action compares whole, so a property
// whose default the docs give must come out exactly as it did before the
// field existed.
test("mapProp: leaves defaultAssumed out where the docs give a default", () => {
  for (const p of [
    prop({ name: "size", type: { name: "union", raw: `"sm" | "lg"` }, defaultValue: "sm" }),
    prop({ name: "disabled", type: { name: "boolean" }, defaultValue: "false" }),
    prop({ name: "open", type: { name: "boolean" }, defaultValue: true }),
  ]) {
    assert.equal(Object.hasOwn(mapProp(p) ?? {}, "defaultAssumed"), false, p.name);
  }
});

test("mapProp: returns null for skipped and unmappable props", () => {
  assert.equal(mapProp(prop({ name: "children" })), null);
  assert.equal(mapProp(prop({ name: "label", type: { name: "string" } })), null);
});

// --- withoutProps / parsePropNames (--exclude-props) ---

test("parsePropNames: splits a comma-separated list, trimming and dropping blanks", () => {
  assert.deepEqual(parsePropNames(" modal, loop ,,shouldFilter "), ["modal", "loop", "shouldFilter"]);
  assert.deepEqual(parsePropNames(undefined), []);
});

test("withoutProps: leaves out the named props, ignoring case, and nothing else", () => {
  const drawer = component([
    prop({ name: "modal", type: { name: "boolean" } }),
    prop({ name: "direction", type: { name: "union", raw: `"bottom" | "top"` } }),
    prop({ name: "shouldScaleBackground", type: { name: "boolean" } }),
  ], "Drawer");
  assert.deepEqual(withoutProps(drawer, ["Modal", "shouldscalebackground"]).props.map((p) => p.name), ["direction"]);
  assert.deepEqual(mapComponent(withoutProps(drawer, ["modal", "nope"])).variantProperties.map((p) => p.name), ["direction", "shouldScaleBackground"]);
  assert.equal(withoutProps(drawer, []), drawer);
  // The component it was given is left as it was.
  assert.equal(drawer.props.length, 3);
});

// --- explainProp ---

test("explainProp: says which rule left a prop out", () => {
  const reason = (p: StorybookProp) => explainProp(p).reason;
  assert.equal(reason(prop({ name: "className", type: { name: "union", raw: "string | ((state: ButtonState) => string)" } })), "structural prop");
  assert.match(reason(prop({ name: "asChild", type: { name: "boolean" } })) ?? "", /^composition prop/);
  assert.equal(reason(prop({ name: "onOpenChange", type: { name: "func" } })), "event handler");
  assert.equal(reason(prop({ name: "label", type: { name: "string" } })), "free string, with no fixed values");
  assert.equal(reason(prop({ name: "size", type: { name: "union", raw: `"sm" | number` } })), "union with non-literal members: number");
  assert.equal(reason(prop({ name: "snap", type: { name: "union", raw: "string | number | null" } })), "union with non-literal members: string, number");
  // addon-mcp prints an alias by name, without its members.
  assert.equal(reason(prop({ name: "shortcuts", type: { name: "QuestionnaireShortcutMode" } })), "its type, QuestionnaireShortcutMode, lists no values");
  // A type the parser calls a union for a | nested inside it is named whole.
  assert.equal(reason(prop({ name: "validate", type: { name: "union", raw: "(value: string | null) => boolean" } })), "callback");
  assert.equal(reason(prop({ name: "picked", type: { name: "union", raw: `("a" | "b")[] | null` } })), `its type, ("a" | "b")[], lists no values`);
  assert.equal(reason(prop({ name: "fallback", type: { name: "union", raw: "string | null" } })), "free string, with no fixed values");
  assert.equal(reason(prop({ name: "width", type: { name: "union", raw: "`${number}px` | null" } })), "its type, `${number}px`, lists no values");
  assert.equal(reason(prop({ name: "variant", type: { name: "union", raw: `"a" | "b" | null` } })), null);
});

test("explainProp: marks a default the docs don't give as assumed", () => {
  const union = { name: "union", raw: `"center" | "left" | "right"` };
  assert.equal(explainProp(prop({ name: "align", type: union, defaultValue: "left" })).defaultAssumed, false);
  assert.equal(explainProp(prop({ name: "textAlign", type: union })).defaultAssumed, true);
  assert.equal(explainProp(prop({ name: "loop", type: { name: "boolean" }, defaultValue: "false" })).defaultAssumed, false);
  assert.equal(explainProp(prop({ name: "shouldFilter", type: { name: "boolean" } })).defaultAssumed, true);
  // A JSDoc default in prose is not a value either, nor is one outside the
  // values, `null` among them: inspect says the docs give no usable default.
  assert.equal(explainProp(prop({
    name: "repositionInputs", type: { name: "boolean" }, defaultValue: "true when {@link snapPoints } is defined",
  })).defaultAssumed, true);
  assert.equal(explainProp(prop({ name: "align", type: union, defaultValue: "justify" })).defaultAssumed, true);
  assert.equal(explainProp(prop({ name: "align", type: { name: "union", raw: `"a" | "b" | null` }, defaultValue: "null" })).defaultAssumed, true);
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

// --- capped behavior ---

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

test("mapComponent: maps a shadcn Radix Button's cva variants, without asChild", () => {
  // The Props block addon-mcp 10.6 prints for shadcn/ui's Radix Button.
  const def = mapComponent(component([
    prop({ name: "variant", type: { name: "union", raw: `"link" | "default" | "outline" | "secondary" | "ghost" | "destructive" | null` }, defaultValue: "default" }),
    prop({ name: "size", type: { name: "union", raw: `"default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg" | null` }, defaultValue: "default" }),
    prop({ name: "asChild", type: { name: "boolean" }, defaultValue: "false" }),
  ]));
  assert.deepEqual(def.variantProperties.map((p) => [p.name, p.values[0], p.values.length]), [["variant", "default", 6], ["size", "default", 8]]);
  assert.equal(def.variantCombinations.length, 48);
  assert.deepEqual(def.variantCombinations[0], { variant: "default", size: "default" });
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

test("cartesian: honors a custom ceiling", () => {
  const props = [
    { name: "a", type: "VARIANT", values: ["1", "2", "3"], defaultValue: "1" },
    { name: "b", type: "VARIANT", values: ["x", "y", "z"], defaultValue: "x" },
  ] as never[];
  const capped = cartesian(props, 4);
  assert.equal(capped.wasCapped, true);
  assert.equal(capped.combinations.length, 4);
  assert.equal(capped.cap?.maxCombinations, 4);
  // Raising the ceiling above the product yields every combination.
  const full = cartesian(props, 9);
  assert.equal(full.wasCapped, false);
  assert.equal(full.combinations.length, 9);
});

test("supplementOptions: the story's options add values after the type's own, and make an axis of a prop whose type lists none", () => {
  const component = {
    name: "Tooltip",
    props: [
      { name: "variant", type: { name: "union", raw: '"default" | "ghost"' }, defaultValue: "default" },
      { name: "side", type: { name: "Side" }, defaultValue: "top" },
      { name: "open", type: { name: "boolean" } },
      { name: "children", type: { name: "ReactNode" } },
      { name: "align", type: { name: "union", raw: '"start" | "end"' } },
    ],
    stories: [],
  };
  const widened = supplementOptions(component, {
    // Only adds: the type's ghost stays though the options lack it.
    variant: { options: ["default", "outline", null] },
    side: { options: ["top", "right", "bottom", "left", { nope: 1 }] },
    open: { options: [true, false, "maybe"] },
    children: { options: ["a", "b"] },
    align: { options: ["start", "end"] },
  });
  const mapped = mapComponent(widened).variantProperties;
  assert.deepEqual(mapped.map((p) => [p.name, p.values, p.defaultValue]), [
    ["variant", ["default", "ghost", "outline"], "default"],
    ["side", ["top", "right", "bottom", "left"], "top"],
    ["open", ["true", "false"], "false"],
    ["align", ["start", "end"], "start"],
  ]);
  // Nothing to add, nothing changed: the same component.
  assert.equal(supplementOptions(component, { align: { options: ["start"] } }), component);
  assert.equal(supplementOptions(component, {}), component);
});
