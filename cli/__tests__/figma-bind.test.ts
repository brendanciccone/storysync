import assert from "node:assert/strict";
import { test } from "node:test";
import { ALPHA_VARIABLE, Binder, alphaVariableName, colorOfClass, parseAlphaVariable, readEvidence } from "../figma-bind.js";
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

test("Binder: of the tokens the classes name, the one a dark: class names fits both modes", () => {
  const binder = new Binder(WITH_DEFAULTS);
  // An outline button: border-border, dark:border-input. Both are #e5e5e5 in
  // light, and input is the dark theme's, so input is right in both modes.
  assert.deepEqual(binder.color("#e5e5e5", "stroke", ["border-border", "dark:border-input"]), { variable: "input", candidates: ["border", "input"] });
  assert.equal(binder.color("#ffffff", "fill", ["bg-card", "dark:bg-background"]).variable, "background");
  // A dark: class alone names one as any class does.
  assert.equal(binder.color("#e5e5e5", "stroke", ["dark:border-input"], ["border-color"]).variable, "input");
  // Two a dark: class names: still ambiguous.
  assert.equal(binder.color("#e5e5e5", "stroke", ["dark:border-border", "dark:border-input"]).variable, null);
  // A dark theme's palette color is no token's: no base style stands in for it.
  assert.equal(binder.color("#0a0a0a", "text", ["dark:text-neutral-50"], ["color"]).variable, null);
  assert.equal(binder.color("#0a0a0a", "text", ["dark:text-muted-foreground"], ["color"]).variable, "foreground");
});

test("Binder: a Tailwind config's DEFAULT key is unnamed in a class", () => {
  // shadcn/ui v3's `primary: { DEFAULT: "hsl(var(--primary))" }` is the token primary/DEFAULT, and bg-primary names it.
  const binder = new Binder({ collections: [{ category: "colors", tokens: [{ name: "primary/DEFAULT", value: "", hex: "#18181b" }, { name: "foreground", value: "", hex: "#18181b" }] }] });
  assert.equal(binder.color("#18181b", "fill", ["bg-primary"]).variable, "primary/DEFAULT");
});

test("Binder: a shadow's color binds only where a ring-* or shadow-* class names its token, never by its value alone", () => {
  // shadcn/ui's dialog: ring-1 ring-foreground/10, measured #0a0a0a1a.
  const binder = new Binder(SHADCN_TOKENS);
  assert.deepEqual(binder.color("#0a0a0a1a", "effect", ["bg-background", "ring-foreground", "rounded-xl"]), {
    variable: "foreground", candidates: ["card/foreground", "foreground", "popover/foreground", "sidebar/foreground"],
  });
  assert.equal(binder.color("#171717", "effect", ["shadow-primary"]).variable, "primary");
  // A fill's class names no shadow's token, and a value one token has
  // binds a stroke without a class, but no shadow: Tailwind's shadow scale
  // draws in a black no token was set from.
  assert.equal(binder.color("#0a0a0a1a", "effect", ["text-foreground"]).variable, null);
  assert.deepEqual(binder.color("#a1a1a1", "effect", undefined), { variable: null, candidates: ["ring"] });
  assert.equal(binder.color("#a1a1a1", "effect", ["ring-ring"]).variable, "ring");
});

test("Binder: a token is opaque where its light value is, which a translucent paint then takes at an alpha", () => {
  const binder = new Binder({ collections: [{ category: "colors", tokens: [
    { name: "destructive", value: "", hex: "#df2225" }, { name: "overlay", value: "", hex: "#0000001a" }, { name: "white", value: "", hex: "#ffffffff" },
  ] }] });
  assert.deepEqual(["destructive", "overlay", "white", "missing"].map((t) => binder.opaque(t)), [true, false, true, false]);
});

test("alpha variables: a token at an alpha is named by its percent, whole where Tailwind's /NN gives it, and the name gives back the byte snap measured", () => {
  assert.equal(alphaVariableName("destructive", 0x1a / 255), "destructive 10%");
  assert.equal(alphaVariableName("destructive", 0.302), "destructive 30%");
  assert.equal(alphaVariableName("card/foreground", 0.5), "card/foreground 50%");
  assert.equal(alphaVariableName("muted", 0.051), "muted 5%");
  // Every Tailwind modifier, /0 to /100, has a whole name, from the byte
  // snap measures it at: the browser's alpha, n / 100, times 255, rounded.
  for (let n = 0; n <= 100; n++) assert.equal(alphaVariableName("x", Math.round((n / 100) * 255) / 255), `x ${n}%`);
  // An alpha of no whole percent, /[.125], has a tenth, after a comma: Figma refuses a period in a name (probe 7c).
  assert.equal(alphaVariableName("ring", 32 / 255), "ring 12,5%");
  // Each byte has one name, which reads back as that byte, and holds no period.
  const names = new Set<string>();
  for (let byte = 0; byte < 256; byte++) {
    const name = alphaVariableName("destructive", byte / 255);
    assert.doesNotMatch(name, /\./);
    assert.match(name, ALPHA_VARIABLE);
    assert.deepEqual(parseAlphaVariable(name), { token: "destructive", alpha: byte / 255 }, name);
    names.add(name);
  }
  assert.equal(names.size, 256);
  // No token's name is one: a CSS variable has no space or %.
  assert.equal(parseAlphaVariable("destructive"), null);
  assert.equal(parseAlphaVariable("destructive/10"), null);
  assert.equal(parseAlphaVariable("x 101%"), null);
});

test("alpha variables: where the dark theme paints the token at another alpha, the name says both, and gives both back", () => {
  // shadcn/ui's destructive Button: bg-destructive/10 dark:bg-destructive/20.
  assert.equal(alphaVariableName("destructive", 0x1a / 255, 0.2), "destructive 10% dark 20%");
  assert.equal(alphaVariableName("destructive", 1, 0.6), "destructive 100% dark 60%");
  assert.equal(alphaVariableName("ring", 0.5, 32 / 255), "ring 50% dark 12,5%");
  // The same byte in both is the one alpha's name.
  assert.equal(alphaVariableName("destructive", 0.102, 0.1), "destructive 10%");
  for (const name of ["destructive 10% dark 20%", "card/foreground 100% dark 60%", "ring 50% dark 12,5%"]) assert.match(name, ALPHA_VARIABLE);
  assert.deepEqual(parseAlphaVariable("destructive 10% dark 20%"), { token: "destructive", alpha: 26 / 255, dark: 51 / 255 });
  assert.deepEqual(parseAlphaVariable("card/foreground 100% dark 60%"), { token: "card/foreground", alpha: 1, dark: 153 / 255 });
  assert.equal(parseAlphaVariable("destructive 10% dark 120%"), null);
  assert.equal(parseAlphaVariable("destructive 10% dark"), null);
});

test("Binder: a dark: class gives the alpha the dark theme paints its token at, where a snap keeps it, in the role its prefix colors", () => {
  assert.deepEqual(readEvidence("dark:bg-destructive/20"), { dark: true, utility: "bg-destructive", alpha: 0.2 });
  assert.deepEqual(readEvidence("dark:bg-destructive/[.25]"), { dark: true, utility: "bg-destructive", alpha: 0.25 });
  assert.deepEqual(readEvidence("dark:border-t-input/[50%]"), { dark: true, utility: "border-t-input", alpha: 0.5 });
  assert.deepEqual(readEvidence("dark:border-input"), { dark: true, utility: "border-input" });
  assert.deepEqual(readEvidence("bg-destructive"), { dark: false, utility: "bg-destructive" });
  const binder = new Binder(SHADCN_TOKENS);
  const cls = ["bg-destructive", "dark:bg-destructive/20", "dark:border-t-destructive/40", "text-destructive"];
  assert.equal(binder.darkAlpha("destructive", "fill", cls), 0.2);
  assert.equal(binder.darkAlpha("destructive", "stroke", cls), 0.4);
  // No dark: class names it in that role: the light theme's alpha holds.
  assert.equal(binder.darkAlpha("destructive", "text", cls), undefined);
  // dark: alone, without an opacity, paints it whole.
  assert.equal(binder.darkAlpha("input", "stroke", ["border-border", "dark:border-input"]), 1);
  // Two at different alphas say nothing.
  assert.equal(binder.darkAlpha("destructive", "fill", ["dark:bg-destructive/20", "dark:bg-destructive/30"]), undefined);
  // The opacity changes nothing a class picks: an outline button's
  // dark:border-input/50 still names input among #e5e5e5's tokens.
  assert.equal(binder.color("#e5e5e5", "stroke", ["border-border", "dark:border-input/50"]).variable, "input");
});

// coder's tokens, cut down: two that swap #ffffff and #09090b between themes.
const CODER = {
  collections: [{ category: "colors" as const, tokens: [
    { name: "content/primary", value: "#09090b", hex: "#09090b", dark: { value: "#ffffff", hex: "#ffffff" } },
    { name: "surface/primary", value: "#ffffff", hex: "#ffffff", dark: { value: "#09090b", hex: "#09090b" } },
    { name: "surface/invert/primary", value: "#27272a", hex: "#27272a", dark: { value: "#e4e4e7", hex: "#e4e4e7" } },
    { name: "border/default", value: "#e4e4e7", hex: "#e4e4e7", dark: { value: "#27272a", hex: "#27272a" } },
  ] }],
};

test("Binder: a full radius binds only to a token named full, and a pill only where a class names its token", () => {
  const binder = new Binder(SHADCN_TOKENS);
  assert.deepEqual(binder.radius(8, ["rounded-full"], true), { variable: null, candidates: [] });
  assert.deepEqual(binder.radius(8, ["dark:bg-input/30", "rounded-l-full"], true), { variable: null, candidates: [] });
  assert.equal(binder.radius(8, undefined, true).variable, null);
  assert.equal(binder.radius(8, ["rounded-md"], true).variable, "md");
  const full = new Binder({ collections: [{ category: "radius", tokens: [{ name: "md", value: "8px", px: 8 }, { name: "full", value: "9999px", px: 9999 }] }] });
  assert.deepEqual(full.radius(8, ["rounded-full"], true), { variable: "full", candidates: ["full"] });
  // Not a pill: the rounded-full, its variant gone (sm:, data-[x]:), is
  // inactive, and md draws an 8px radius on a 36px button.
  assert.equal(binder.radius(8, ["rounded-md", "rounded-full"]).variable, "md");
  assert.equal(full.radius(8, ["rounded-md", "rounded-full"]).variable, "md");
});

test("Binder: a component snap measured dark matches the tokens' dark values, never a light value that happens to equal its paint", () => {
  const binder = new Binder(CODER);
  // coder's dark #ffffff text: content/primary in the dark theme, not surface/primary, whose light value it is.
  assert.deepEqual(binder.color("#ffffff", "text", ["text-content-primary"], undefined, "dark"), { variable: "content/primary", candidates: ["content/primary"] });
  assert.equal(binder.color("#ffffff", "text", ["text-content-primary"]).variable, "surface/primary");
  // Its button's #e4e4e7 fill, which light values give to border/default, and the class to none.
  assert.equal(binder.color("#e4e4e7", "fill", ["bg-surface-invert-primary"], undefined, "dark").variable, "surface/invert/primary");
  // Measured dark, a dark: class is what the paint shows, over the light theme's.
  const shadcn = new Binder({ collections: [{ category: "colors" as const, tokens: [
    { name: "border", value: "#e5e5e5", hex: "#e5e5e5", dark: { value: "#ffffff1a", hex: "#ffffff1a" } },
    { name: "input", value: "#e5e5e5", hex: "#e5e5e5", dark: { value: "#ffffff1a", hex: "#ffffff1a" } },
  ] }] });
  assert.equal(shadcn.color("#ffffff1a", "stroke", ["border-border", "dark:border-input"], undefined, "dark").variable, "input");
  // border is translucent in the dark theme, so a paint of it binds no alpha variable there.
  assert.deepEqual([shadcn.opaque("border", "dark"), shadcn.opaque("border")], [false, true]);
});

test("per-mode variables: the light class's color and the dark: class's, each percent left out at 100%, read back", () => {
  assert.equal(alphaVariableName("background", 1, 0.3, "input"), "background dark input 30%");
  assert.equal(alphaVariableName("slate-50", 1, 1, "slate-900"), "slate-50 dark slate-900");
  assert.equal(alphaVariableName("destructive", 0x1a / 255, 0.2, "ring"), "destructive 10% dark ring 20%");
  assert.equal(alphaVariableName("input", 0, 0.3), "input 0% dark 30%");
  // The same token is the alpha variable's name, as before.
  assert.equal(alphaVariableName("destructive", 0x1a / 255, 0.2, "destructive"), "destructive 10% dark 20%");
  assert.deepEqual(parseAlphaVariable("background dark input 30%"), { token: "background", alpha: 1, darkToken: "input", dark: 77 / 255 });
  assert.deepEqual(parseAlphaVariable("slate-50 dark slate-900"), { token: "slate-50", alpha: 1, darkToken: "slate-900" });
  assert.deepEqual(parseAlphaVariable("destructive 10% dark ring 20%"), { token: "destructive", alpha: 26 / 255, darkToken: "ring", dark: 51 / 255 });
  for (const name of ["input dark 30%", "background dark", "background dark background", "dark dark x", "a dark b c", "a 10% dark b 120%"]) assert.equal(parseAlphaVariable(name), null, name);
});

test("Binder: a dark: class paints a token or a palette color, at its alpha; a light class names the palette color measured", () => {
  const palette = new Map([["slate-50", "#f8fafc"], ["slate-900", "#0f172b"], ["transparent", "#00000000"]]);
  const binder = new Binder(SHADCN_TOKENS, palette);
  assert.deepEqual(binder.darkPaint("fill", ["bg-background", "dark:bg-input/30"]), { name: "input", alpha: 0.3 });
  assert.deepEqual(binder.darkPaint("fill", ["bg-slate-50", "dark:bg-slate-900"]), { name: "slate-900", hex: "#0f172b", alpha: 1 });
  assert.deepEqual(binder.darkPaint("fill", ["bg-card", "dark:bg-transparent"]), { name: "transparent", hex: "#00000000", alpha: 1 });
  // Another role's, or two that differ, say nothing.
  assert.equal(binder.darkPaint("stroke", ["dark:bg-input/30"]), undefined);
  assert.equal(binder.darkPaint("fill", ["dark:bg-input/30", "dark:bg-muted"]), undefined);
  assert.equal(binder.lightPalette("#f8fafc", "fill", ["bg-slate-50", "dark:bg-slate-900"]), "slate-50");
  assert.equal(binder.lightPalette("#f8fafc", "fill", ["bg-slate-100"]), undefined);
  assert.equal(binder.hexOf("input"), "#e5e5e5");
  assert.equal(binder.hexOf("slate-900"), "#0f172b");
});

test("readEvidence and darkPaint: a dark: class with a state snap couldn't tell applies leaves Dark undecided", () => {
  assert.deepEqual(readEvidence("dark:group-data-[state=open]:bg-input/30"), { dark: true, utility: "bg-input", alpha: 0.3, state: "group-data-[state=open]" });
  assert.deepEqual(readEvidence("dark:bg-[color:var(--x)]"), { dark: true, utility: "bg-[color:var(--x)]" });
  const binder = new Binder(SHADCN_TOKENS);
  assert.deepEqual(binder.darkPaint("text", ["dark:text-muted-foreground", "text-foreground"]), { name: "muted/foreground", alpha: 1 });
  assert.equal(binder.darkPaint("text", ["dark:data-active:text-foreground", "dark:text-muted-foreground", "text-foreground"]), undefined);
  assert.equal(binder.darkAlpha("destructive", "fill", ["dark:bg-destructive/20", "dark:hover:bg-destructive/30"]), undefined);
  // Another role's says nothing of this one.
  assert.deepEqual(binder.darkPaint("fill", ["dark:bg-input/30", "dark:hover:text-foreground"]), { name: "input", alpha: 0.3 });
});

test("alphaVariableName: a per-mode variable writes its Dark color by its class name, and colorOfClass reads it back", () => {
  assert.equal(alphaVariableName("foreground", 0.6, 1, "muted/foreground"), "foreground 60% dark muted-foreground");
  assert.equal(alphaVariableName("surface/primary", 1, 1, "content/primary"), "surface/primary dark content-primary");
  assert.deepEqual(parseAlphaVariable("foreground 60% dark muted-foreground"), { token: "foreground", alpha: 153 / 255, darkToken: "muted-foreground" });
  const colors = ["muted", "muted/foreground", "primary/DEFAULT", "input"];
  assert.equal(colorOfClass("muted-foreground", colors), "muted/foreground");
  assert.equal(colorOfClass("primary", colors), "primary/DEFAULT");
  assert.equal(colorOfClass("input", colors), "input");
  assert.equal(colorOfClass("slate-900", colors), "slate-900");
});

// coder/coder's light and dark values (site/.storysync/tokens.json), several shared.
const CODER_SHARED = {
  collections: [{ category: "colors" as const, tokens: ([
    ["content/primary", "#09090b", "#ffffff"], ["ring", "#09090b", "#d4d4d8"],
    ["content/disabled", "#a1a1aa", "#3f3f46"], ["border/secondary", "#a1a1aa", "#3f3f46"],
    ["border/DEFAULT", "#e4e4e7", "#27272a"], ["input", "#e4e4e7", "#27272a"], ["surface/tertiary", "#e4e4e7", "#27272a"],
    ["surface/secondary", "#f4f4f5", "#18181b"],
  ] as const).map(([name, hex, dark]) => ({ name, value: hex, hex, dark: { value: dark, hex: dark } })) }],
  defaults: [{ property: "border-color" as const, token: "border/DEFAULT", from: "app.css: * { border-color: var(--border) }" }],
};

test("Binder: a value its tokens all hold in Light and in Dark binds to one of them, the base style's where it is one, and says they are alike", () => {
  const binder = new Binder(CODER_SHARED);
  // An outline Button's #e4e4e7 border, named by a class of another state: any of the three is right in both modes.
  assert.deepEqual(binder.color("#e4e4e7", "stroke", ["border-surface-secondary"]), { variable: "border/DEFAULT", candidates: ["border/DEFAULT", "input", "surface/tertiary"], alike: ["border/DEFAULT", "input", "surface/tertiary"] });
  // No base style among them: the one whose name fits the role, a text's content/disabled, not border/secondary.
  assert.deepEqual(binder.color("#a1a1aa", "text", undefined), { variable: "content/disabled", candidates: ["border/secondary", "content/disabled"], alike: ["border/secondary", "content/disabled"] });
  assert.equal(binder.color("#a1a1aa", "stroke", undefined).variable, "border/secondary");
  // Two classes that tie: the first of those they name, and which they are.
  assert.deepEqual(binder.color("#e4e4e7", "stroke", ["border-input", "border-surface-tertiary"]), { variable: "input", candidates: ["border/DEFAULT", "input", "surface/tertiary"], alike: ["border/DEFAULT", "input", "surface/tertiary"], named: ["input", "surface/tertiary"] });
  // Measured dark, by the dark values, alike in Light too: a fill's surface/tertiary.
  assert.equal(binder.color("#27272a", "fill", undefined, undefined, "dark").variable, "surface/tertiary");
  // Tokens that differ in Dark stay unbound without evidence: a highlighted option's #09090b.
  assert.deepEqual(binder.color("#09090b", "text", ["text-content-secondary"]), { variable: null, candidates: ["content/primary", "ring"] });
  // A shadow's color still binds only where named.
  assert.equal(binder.color("#e4e4e7", "effect", undefined).variable, null);
});

test("Binder: a class names a DEFAULT token by its key too, border-border-default, in any case", () => {
  const binder = new Binder(CODER_SHARED);
  assert.equal(binder.color("#e4e4e7", "stroke", ["border-border-default"]).variable, "border/DEFAULT");
  assert.deepEqual(binder.color("#e4e4e7", "stroke", ["border-border"]).alike, undefined);
  assert.equal(binder.color("#e4e4e7", "stroke", ["border-border"]).variable, "border/DEFAULT");
  // A state's class is evidence for the state measured: a disabled button's text.
  assert.equal(binder.color("#a1a1aa", "text", ["text-content-disabled", "text-content-invert"]).variable, "content/disabled");
});

test("Binder: a custom property behind the color names its token as a class does, and is no color the tokens lack", () => {
  // shadcn/ui's Sonner: `background: var(--normal-bg)`, the Toaster's `--normal-bg: var(--popover)`.
  const binder = new Binder({ ...WITH_DEFAULTS, collections: [{ category: "colors" as const, tokens: [
    ["background", "#ffffff", "#0a0a0a"], ["card", "#ffffff", "#171717"], ["popover", "#ffffff", "#171717"],
    ["foreground", "#0a0a0a", "#fafafa"], ["popover/foreground", "#0a0a0a", "#fafafa"], ["primary", "#171717", "#e5e5e5"],
  ].map(([name, hex, dark]) => ({ name, value: hex, hex, dark: { value: dark, hex: dark } })) }] });
  assert.equal(binder.color("#ffffff", "fill", ["var:bg-normal-bg", "var:bg-popover"]).variable, "popover");
  assert.equal(binder.color("#ffffff", "fill", undefined).variable, null);
  // Sonner's action button: `background: var(--normal-text)`, `color: var(--normal-bg)`.
  assert.equal(binder.color("#0a0a0a", "fill", ["var:bg-normal-text", "var:bg-popover-foreground"]).variable, "popover/foreground");
  // A rule's custom property that names no token of the value ends in a
  // color of its own, not body's: the base style doesn't stand in for it.
  assert.equal(binder.color("#0a0a0a", "text", ["var:text-normal-text"], ["color"]).variable, null);
  assert.equal(binder.color("#0a0a0a", "text", undefined, ["color"]).variable, "foreground");
  assert.deepEqual(readEvidence("var:bg-popover"), { dark: false, utility: "bg-popover", fromVar: true });
  assert.deepEqual(readEvidence("var:dark:text-[#e8e8e8]"), { dark: true, utility: "text-[#e8e8e8]", fromVar: true });
});

test("Binder: a value its tokens hold alike in every mode stays unbound where a palette, arbitrary or rule's color sets it", () => {
  // shadcn/ui's #0a0a0a is foreground, card/foreground and popover/foreground, all #fafafa in Dark;
  // `text-neutral-950` stays #0a0a0a there, so binding any of them would turn it light.
  const shadcn = new Binder({ collections: [{ category: "colors" as const, tokens: ([
    ["foreground", "#0a0a0a", "#fafafa"], ["card/foreground", "#0a0a0a", "#fafafa"], ["popover/foreground", "#0a0a0a", "#fafafa"],
    ["border/DEFAULT", "#e4e4e7", "#27272a"], ["input", "#e4e4e7", "#27272a"],
  ] as const).map(([name, hex, dark]) => ({ name, value: hex, hex, dark: { value: dark, hex: dark } })) }] }, new Map([["neutral-950", "#0a0a0a"], ["zinc-200", "#e4e4e7"], ["zinc-700", "#3f3f46"]]));
  assert.equal(shadcn.color("#0a0a0a", "text", undefined).variable, "card/foreground");
  for (const cls of [["text-neutral-950"], ["text-[#0a0a0a]"], ["dark:text-neutral-950"], ["var:text-normal-text"]]) {
    assert.deepEqual(shadcn.color("#0a0a0a", "text", cls), { variable: null, candidates: ["card/foreground", "foreground", "popover/foreground"] }, cls.join(" "));
  }
  // A fill's palette or arbitrary class, with or without a dark: one.
  for (const cls of [["bg-zinc-200"], ["bg-zinc-200", "dark:bg-zinc-700"], ["bg-[#e4e4e7]"], ["var:bg-normal-bg"]]) {
    assert.equal(shadcn.color("#e4e4e7", "fill", cls).variable, null, cls.join(" "));
  }
  assert.equal(shadcn.color("#e4e4e7", "fill", ["bg-size-[10px]"]).variable, "border/DEFAULT");
  // A class of a color the project lacks generates no rule, so it sets none: coder's root `border-border-primary`.
  assert.equal(shadcn.color("#e4e4e7", "stroke", ["border-border-primary"]).variable, "border/DEFAULT");
  assert.equal(shadcn.color("#e4e4e7", "stroke", ["border-t-zinc-200"]).variable, null);
});
