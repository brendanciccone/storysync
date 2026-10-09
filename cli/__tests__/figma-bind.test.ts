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
  assert.deepEqual(binder.radius(10, undefined), { variable: null, candidates: ["DEFAULT", "lg"] });
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
