import assert from "node:assert/strict";
import { test } from "node:test";
import { Binder } from "../figma-bind.js";
import { SHADCN_TOKENS } from "./shadcn-tokens.js";


test("Binder: #171717 with bg-primary binds to primary, of the five tokens that share it", () => {
  const binder = new Binder(SHADCN_TOKENS);
  const decision = binder.color("#171717", "fill", ["bg-primary"]);
  assert.equal(decision.variable, "primary");
  assert.deepEqual(decision.candidates, ["accent/foreground", "primary", "secondary/foreground", "sidebar/primary"]);
});

test("Binder: #0a0a0a with no class stays unbound, listing the tokens it matches", () => {
  const decision = new Binder(SHADCN_TOKENS).color("#0a0a0a", "text", undefined);
  assert.equal(decision.variable, null);
  assert.deepEqual(decision.candidates, ["card/foreground", "foreground", "popover/foreground", "sidebar/foreground"]);
});

test("Binder: #0a0a0a with text-card-foreground binds to card/foreground", () => {
  assert.equal(new Binder(SHADCN_TOKENS).color("#0a0a0a", "text", ["bg-card", "text-card-foreground"]).variable, "card/foreground");
});

test("Binder: a translucent paint binds to the opaque token of its color", () => {
  // border-destructive/30: snap strips the /30, and measures #df22254d.
  assert.equal(new Binder(SHADCN_TOKENS).color("#df22254d", "stroke", ["border-destructive"]).variable, "destructive");
});

test("Binder: a class only picks for its own property", () => {
  const binder = new Binder(SHADCN_TOKENS);
  // bg-primary says nothing about a text's color, nor text-primary about a fill.
  assert.equal(binder.color("#171717", "text", ["bg-primary"]).variable, null);
  assert.equal(binder.color("#171717", "fill", ["text-primary"]).variable, null);
  assert.equal(binder.color("#171717", "stroke", ["ring-primary"]).variable, "primary");
  // An icon draws in currentColor, the text-* color, or its own fill-* or stroke-*.
  assert.equal(binder.color("#171717", "vector", ["text-primary"]).variable, "primary");
  assert.equal(binder.color("#fafafa", "vector", ["stroke-primary-foreground"]).variable, "primary/foreground");
});

test("Binder: two classes naming two tokens of the value bind neither", () => {
  // hover:bg-accent and bg-secondary, both #f5f5f5, as a ghost button has.
  const decision = new Binder(SHADCN_TOKENS).color("#f5f5f5", "fill", ["bg-accent", "bg-secondary"]);
  assert.equal(decision.variable, null);
  assert.deepEqual(decision.candidates, ["accent", "muted", "secondary"]);
});

test("Binder: a value one token has binds without a class; one no token has binds nothing", () => {
  const binder = new Binder(SHADCN_TOKENS);
  assert.deepEqual(binder.color("#a1a1a1", "stroke", undefined), { variable: "ring", candidates: ["ring"] });
  assert.deepEqual(binder.color("#123456", "fill", ["bg-primary"]), { variable: null, candidates: [] });
});

test("Binder: radius binds by rounded-* among the radius tokens of its value, a side prefix allowed", () => {
  const binder = new Binder(SHADCN_TOKENS);
  assert.equal(binder.radius(10, ["rounded-lg"]).variable, "lg");
  assert.equal(binder.radius(10, ["rounded-t-lg"]).variable, "lg");
  // tokens.json from before held a DEFAULT that repeats lg: it is no candidate.
  assert.deepEqual(binder.radius(10, undefined), { variable: "lg", candidates: ["lg"] });
  assert.equal(binder.radius(8, undefined).variable, "md");
  assert.equal(binder.radius(9999, ["rounded-full"]).variable, null);
});

test("Binder: a translucent token binds only a paint of exactly its value", () => {
  const binder = new Binder({ collections: [{ category: "colors", tokens: [{ name: "overlay", value: "x", hex: "#00000080" }, { name: "ink", value: "x", hex: "#000000" }] }] });
  assert.deepEqual(binder.color("#00000080", "fill", undefined).candidates, ["ink", "overlay"]);
  assert.deepEqual(binder.color("#000000", "fill", undefined).candidates, ["ink"]);
});

test("Binder: no tokens binds nothing", () => {
  const binder = new Binder(null);
  assert.equal(binder.empty, true);
  assert.deepEqual(binder.color("#171717", "fill", ["bg-primary"]), { variable: null, candidates: [] });
});

test("Binder: a token's dark value is no candidate, since snap measures the light theme the variable's default mode holds", () => {
  const tokens = {
    collections: [
      { category: "colors" as const, tokens: [
        { name: "background", value: "#ffffff", hex: "#ffffff", dark: { value: "#0a0a0a", hex: "#0a0a0a" } },
        { name: "foreground", value: "#0a0a0a", hex: "#0a0a0a", dark: { value: "#fafafa", hex: "#fafafa" } },
      ] },
      { category: "radius" as const, tokens: [{ name: "lg", value: "0.5rem", px: 8, dark: { value: "0.75rem", px: 12 } }] },
    ],
  };
  const binder = new Binder(tokens);
  // bg-background would pick background, were its dark #0a0a0a a candidate.
  assert.deepEqual(binder.color("#0a0a0a", "fill", ["bg-background"]), { variable: "foreground", candidates: ["foreground"] });
  assert.deepEqual(binder.radius(12, ["rounded-lg"]), { variable: null, candidates: [] });
  assert.equal(binder.radius(8, ["rounded-lg"]).variable, "lg");
});

// The project's base styles, as tokens reads shadcn/ui's @layer base.
const DEFAULTS = [
  { property: "color" as const, token: "foreground", from: "app/globals.css, @layer base: body { @apply bg-background text-foreground }" },
  { property: "border-color" as const, token: "border", from: "app/globals.css, @layer base: * { @apply border-border outline-ring/50 }" },
];
const WITH_DEFAULTS = { ...SHADCN_TOKENS, defaults: DEFAULTS };

test("Binder: a text no class colors takes body's color from the base styles, with the rule as its evidence", () => {
  // Dialog's title: inherited from body, so no class says it, and #0a0a0a is four tokens.
  assert.deepEqual(new Binder(WITH_DEFAULTS).color("#0a0a0a", "text", undefined, ["color"]), {
    variable: "foreground", candidates: ["card/foreground", "foreground", "popover/foreground", "sidebar/foreground"], from: DEFAULTS[0].from,
  });
  // An icon in currentColor too.
  assert.equal(new Binder(WITH_DEFAULTS).color("#0a0a0a", "vector", undefined, ["color"]).variable, "foreground");
  // A ghost button's text: its hover:text-accent-foreground names no candidate, and only a state.
  assert.equal(new Binder(WITH_DEFAULTS).color("#0a0a0a", "text", ["text-accent-foreground"], ["color"]).variable, "foreground");
});

test("Binder: a border no class colors takes *'s border color from the base styles, a width or another state's color aside", () => {
  const binder = new Binder(WITH_DEFAULTS);
  // Attachment: `border` and data-[state=error]:border-destructive/30, measured #e5e5e5.
  assert.deepEqual(binder.color("#e5e5e5", "stroke", ["border-destructive", "border-dashed"], ["border-color"]), {
    variable: "border", candidates: ["border", "input"], from: DEFAULTS[1].from,
  });
  // Sheet: border-l names a side, no color.
  assert.equal(binder.color("#e5e5e5", "stroke", ["border-l"], ["border-color"]).variable, "border");
  // A translucent paint of it too.
  assert.equal(binder.color("#e5e5e540", "stroke", undefined, ["border-color"]).variable, "border");
});

test("Binder: a base style binds only where snap found no class sets the property, and only a candidate", () => {
  const binder = new Binder(WITH_DEFAULTS);
  // A class that names one wins: an Input's border-input.
  assert.deepEqual(binder.color("#e5e5e5", "stroke", ["border-input"], ["border-color"]), { variable: "input", candidates: ["border", "input"] });
  // Two classes naming two: ambiguous, and no default settles it.
  assert.equal(binder.color("#0a0a0a", "text", ["text-card-foreground", "text-popover-foreground"], ["color"]).variable, null);
  // No background is inherited: a fill takes no default.
  assert.equal(binder.color("#f5f5f5", "fill", undefined, ["color", "border-color"]).variable, null);
  // The default isn't one of the value's tokens.
  assert.deepEqual(binder.color("#171717", "text", undefined, ["color"]), {
    variable: null, candidates: ["accent/foreground", "primary", "secondary/foreground", "sidebar/primary"],
  });
  // Without defaults, as tokens.json from before: unbound, as it was.
  assert.equal(new Binder(SHADCN_TOKENS).color("#e5e5e5", "stroke", undefined, ["border-color"]).variable, null);
});

test("Binder: where a class sets the color, or snap didn't say none does, the base style is no evidence", () => {
  const binder = new Binder(WITH_DEFAULTS);
  // snap found a class that sets it (text-neutral-950, text-[#0a0a0a], a
  // mismatched text-muted-foreground, or one on an element it inherits
  // from), so it wrote no nocls: unbound, as before the base styles.
  for (const cls of [["text-neutral-950"], undefined, ["text-muted-foreground"], ["text-body"]]) {
    assert.deepEqual(binder.color("#0a0a0a", "text", cls), {
      variable: null, candidates: ["card/foreground", "foreground", "popover/foreground", "sidebar/foreground"],
    }, String(cls));
  }
  assert.equal(binder.color("#e5e5e5", "stroke", ["border-neutral-200"]).variable, null);
  // A tree snapped before nocls: none, whatever its classes, and a class list cut at 8 can't hide one.
  assert.equal(binder.color("#e5e5e5", "stroke", ["border-l"]).variable, null);
  // A palette color in some state may be the one measured: not the base style's.
  assert.equal(binder.color("#0a0a0a", "text", ["text-neutral-950"], ["color"]).variable, null);
  assert.equal(binder.color("#e5e5e5", "stroke", ["border-t-neutral-200"], ["border-color"]).variable, null);
  assert.equal(binder.color("#0a0a0a", "vector", ["fill-neutral-950"], ["color"]).variable, null);
  // A size or a width sets no color, and a token's class in a state that isn't on names none here.
  assert.equal(binder.color("#0a0a0a", "text", ["text-sm", "text-primary"], ["color"]).variable, "foreground");
  assert.equal(binder.color("#e5e5e5", "stroke", ["border-2", "border-dashed", "border-t-destructive"], ["border-color"]).variable, "border");
  // A project's own font size, a v4 theme's --text-body or a config's fontSize, is a size.
  const sized = { ...WITH_DEFAULTS, collections: [...WITH_DEFAULTS.collections, { category: "typography" as const, tokens: [{ name: "text/body", value: "15px", px: 15 }, { name: "caption", value: "12px", px: 12 }] }] };
  assert.equal(new Binder(sized).color("#0a0a0a", "text", ["text-body", "text-caption"], ["color"]).variable, "foreground");
  assert.equal(binder.color("#0a0a0a", "text", ["text-body"], ["color"]).variable, null);
});

test("Binder: a Tailwind config's DEFAULT key is unnamed in a class", () => {
  // shadcn/ui v3's `primary: { DEFAULT: "hsl(var(--primary))" }` is the token primary/DEFAULT, and bg-primary names it.
  const binder = new Binder({ collections: [{ category: "colors", tokens: [{ name: "primary/DEFAULT", value: "", hex: "#18181b" }, { name: "foreground", value: "", hex: "#18181b" }] }] });
  assert.equal(binder.color("#18181b", "fill", ["bg-primary"]).variable, "primary/DEFAULT");
});
