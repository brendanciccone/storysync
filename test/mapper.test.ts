import { describe, test, expect } from "vitest";
import { mapComponent } from "../cli/mapper.js";
import type { StorybookComponent, StorybookProp, PropType } from "../cli/mapper.js";

function component(props: StorybookProp[], name = "Test"): StorybookComponent {
  return { name, props, stories: [] };
}

function prop(name: string, type: PropType, opts?: Partial<StorybookProp>): StorybookProp {
  return { name, type, required: false, ...opts };
}

// --- Boolean props ---

describe("boolean props", () => {
  test("boolean type becomes BOOLEAN variant", () => {
    const result = mapComponent(component([prop("disabled", { name: "boolean" })]));
    expect(result.variantProperties).toEqual([
      { name: "disabled", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" },
    ]);
  });

  test("bool type becomes BOOLEAN variant", () => {
    const result = mapComponent(component([prop("loading", { name: "bool" })]));
    expect(result.variantProperties).toHaveLength(1);
    expect(result.variantProperties[0].type).toBe("BOOLEAN");
  });

  test("boolean control type becomes BOOLEAN variant", () => {
    const result = mapComponent(component([
      prop("active", { name: "unknown" }, { control: { type: "boolean" } }),
    ]));
    expect(result.variantProperties[0].type).toBe("BOOLEAN");
  });

  test("boolean with default true preserves default", () => {
    const result = mapComponent(component([
      prop("visible", { name: "boolean" }, { defaultValue: "true" }),
    ]));
    expect(result.variantProperties[0].defaultValue).toBe("true");
  });

  test("boolean with default false", () => {
    const result = mapComponent(component([
      prop("disabled", { name: "boolean" }, { defaultValue: "false" }),
    ]));
    expect(result.variantProperties[0].defaultValue).toBe("false");
  });

  test("boolean with no default defaults to false", () => {
    const result = mapComponent(component([prop("disabled", { name: "boolean" })]));
    expect(result.variantProperties[0].defaultValue).toBe("false");
  });
});

// --- Enum / union props ---

describe("enum and union props", () => {
  test("raw union of string literals becomes VARIANT", () => {
    const result = mapComponent(component([
      prop("size", { name: "union", raw: "'sm' | 'md' | 'lg'" }),
    ]));
    expect(result.variantProperties).toEqual([
      { name: "size", type: "VARIANT", values: ["sm", "md", "lg"], defaultValue: "sm" },
    ]);
  });

  test("double-quoted union", () => {
    const result = mapComponent(component([
      prop("variant", { name: "union", raw: '"primary" | "secondary"' }),
    ]));
    expect(result.variantProperties[0].values).toEqual(["primary", "secondary"]);
  });

  test("react-docgen enum format", () => {
    const result = mapComponent(component([
      prop("color", {
        name: "enum",
        value: [{ value: "'red'" }, { value: "'blue'" }, { value: "'green'" }] as any,
      }),
    ]));
    expect(result.variantProperties[0].values).toEqual(["red", "blue", "green"]);
  });

  test("react-docgen union with literal members", () => {
    const result = mapComponent(component([
      prop("size", {
        name: "union",
        value: [
          { name: "literal", raw: "'sm'" },
          { name: "literal", raw: "'md'" },
          { name: "literal", raw: "'lg'" },
        ] as PropType[],
      }),
    ]));
    expect(result.variantProperties[0].values).toEqual(["sm", "md", "lg"]);
  });

  test("argType control options take priority", () => {
    const result = mapComponent(component([
      prop("size", { name: "union", raw: "'sm' | 'md'" }, {
        control: { type: "select", options: ["small", "medium", "large"] },
      }),
    ]));
    expect(result.variantProperties[0].values).toEqual(["small", "medium", "large"]);
  });

  test("enum with default value uses it", () => {
    const result = mapComponent(component([
      prop("size", { name: "union", raw: "'sm' | 'md' | 'lg'" }, { defaultValue: "md" }),
    ]));
    expect(result.variantProperties[0].defaultValue).toBe("md");
  });

  test("enum with default not in values falls back to first value", () => {
    const result = mapComponent(component([
      prop("size", { name: "union", raw: "'sm' | 'md'" }, { defaultValue: "xl" }),
    ]));
    expect(result.variantProperties[0].defaultValue).toBe("sm");
  });

  test("default value with object summary format", () => {
    const result = mapComponent(component([
      prop("size", { name: "union", raw: "'sm' | 'md' | 'lg'" }, {
        defaultValue: { summary: "md" } as any,
      }),
    ]));
    expect(result.variantProperties[0].defaultValue).toBe("md");
  });
});

// --- Skipped props ---

describe("skipped props", () => {
  test("children is skipped", () => {
    const result = mapComponent(component([prop("children", { name: "ReactNode" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("className is skipped", () => {
    const result = mapComponent(component([prop("className", { name: "string" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("style is skipped", () => {
    const result = mapComponent(component([prop("style", { name: "CSSProperties" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("ref is skipped", () => {
    const result = mapComponent(component([prop("ref", { name: "Ref<HTMLElement>" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("key is skipped", () => {
    const result = mapComponent(component([prop("key", { name: "string" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("as is skipped", () => {
    const result = mapComponent(component([prop("as", { name: "string" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("onEvent handlers are skipped", () => {
    const result = mapComponent(component([prop("onClick", { name: "function" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("aria-* props are skipped", () => {
    const result = mapComponent(component([prop("aria-label", { name: "string" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("data-* props are skipped", () => {
    const result = mapComponent(component([prop("data-testid", { name: "string" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("callback types are skipped", () => {
    const types = ["func", "function", "(e: Event) => void"];
    for (const t of types) {
      const result = mapComponent(component([prop("handler", { name: t })]));
      expect(result.variantProperties).toHaveLength(0);
    }
  });

  test("ReactNode types are skipped", () => {
    const types = ["ReactNode", "ReactElement", "JSX.Element", "node"];
    for (const t of types) {
      const result = mapComponent(component([prop("icon", { name: t })]));
      expect(result.variantProperties).toHaveLength(0);
    }
  });

  test("free string without control options is skipped", () => {
    const result = mapComponent(component([prop("label", { name: "string" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("free number without control options is skipped", () => {
    const result = mapComponent(component([prop("count", { name: "number" })]));
    expect(result.variantProperties).toHaveLength(0);
  });

  test("string with control options is NOT skipped", () => {
    const result = mapComponent(component([
      prop("label", { name: "string" }, { control: { options: ["Hello", "World"] } }),
    ]));
    expect(result.variantProperties).toHaveLength(1);
    expect(result.variantProperties[0].values).toEqual(["Hello", "World"]);
  });
});

// --- Cartesian product ---

describe("cartesian product", () => {
  test("single boolean produces 2 combinations", () => {
    const result = mapComponent(component([prop("disabled", { name: "boolean" })]));
    expect(result.variantCombinations).toHaveLength(2);
    expect(result.wasCapped).toBe(false);
  });

  test("two booleans produce 4 combinations", () => {
    const result = mapComponent(component([
      prop("disabled", { name: "boolean" }),
      prop("loading", { name: "boolean" }),
    ]));
    expect(result.variantCombinations).toHaveLength(4);
    expect(result.wasCapped).toBe(false);
  });

  test("boolean + 3-value enum produces 6 combinations", () => {
    const result = mapComponent(component([
      prop("disabled", { name: "boolean" }),
      prop("size", { name: "union", raw: "'sm' | 'md' | 'lg'" }),
    ]));
    expect(result.variantCombinations).toHaveLength(6);
  });

  test("combinations include all property values", () => {
    const result = mapComponent(component([
      prop("disabled", { name: "boolean" }),
      prop("size", { name: "union", raw: "'sm' | 'md'" }),
    ]));
    const combos = result.variantCombinations;
    expect(combos).toContainEqual({ disabled: "true", size: "sm" });
    expect(combos).toContainEqual({ disabled: "true", size: "md" });
    expect(combos).toContainEqual({ disabled: "false", size: "sm" });
    expect(combos).toContainEqual({ disabled: "false", size: "md" });
  });

  test("caps at 256 combinations", () => {
    // 9 boolean props = 512 combinations, should cap at 256
    const props = Array.from({ length: 9 }, (_, i) => prop(`flag${i}`, { name: "boolean" }));
    const result = mapComponent(component(props));
    expect(result.variantCombinations).toHaveLength(256);
    expect(result.wasCapped).toBe(true);
  });

  test("no variant props produces single empty combination", () => {
    const result = mapComponent(component([prop("children", { name: "ReactNode" })]));
    expect(result.variantCombinations).toEqual([{}]);
  });

  test("no props produces single empty combination", () => {
    const result = mapComponent(component([]));
    expect(result.variantCombinations).toEqual([{}]);
  });
});

// --- Component name ---

describe("component metadata", () => {
  test("preserves component name", () => {
    const result = mapComponent(component([], "Button"));
    expect(result.name).toBe("Button");
  });
});
