// Which variable a measured paint or radius binds to (section 8.9).
//
// A value binds when exactly one token has it. Several often do: on
// shadcn/ui's neutral theme #0a0a0a is `foreground`, `card/foreground`,
// `popover/foreground` and `sidebar/foreground`, and #171717 five more. So
// binding by value alone would pick one at random, and the push used to ask
// the agent to read the component's source to choose. snap now records the
// node's own class evidence (`cls`: `bg-primary`, `text-card-foreground`,
// `rounded-lg`, with any variant prefix and `/NN` opacity stripped), which
// names the token the code used: a value binds when exactly one of its
// tokens is named by a class for that property. Otherwise it stays as
// measured, unbound, and is listed with the tokens it matches, rather than
// guessed. The value is always snap's; the class only picks among the
// tokens that have it.
//
// Where no class names one, the project's base styles can: shadcn/ui's
// dialog title has no color class, and inherits `body`'s `text-foreground`
// from `@layer base`; a card's border takes `* { @apply border-border }`.
// tokens reads those as `defaults`, and a value whose tokens include the
// default for its property binds to it, with the rule as its evidence.

import { tokenClassName, withoutRepeatedDefault } from "./tokens.js";
import type { BaseDefault, TokenExtractionResult } from "./tokens.js";

/** What a paint colors, which decides the classes that can name its token. */
export type PaintRole = "fill" | "text" | "stroke" | "vector";

/**
 * The class prefixes that name a token for each role. A vector's strokes and
 * fills are its markup's colors, which lucide draws in `currentColor`, the
 * `text-*` color: a `text-*` class on the svg names that token as well as
 * `fill-*` and `stroke-*` do.
 */
const PREFIXES: Record<PaintRole | "radius", string[]> = {
  fill: ["bg"],
  text: ["text"],
  stroke: ["border", "ring"],
  vector: ["fill", "stroke", "text"],
  radius: ["rounded"],
};

/** A side or corner before the token in `border-t-input` or `rounded-tl-lg`. */
const SIDE = /^(?:[trblxyse]|tl|tr|br|bl|ss|se|es|ee)-/;

/**
 * The property of the base styles' defaults a role takes when no class
 * names its token: a text, and an icon in `currentColor`, inherit `color`;
 * a stroke is a border, whose color `*` sets. A fill takes none, since no
 * background is inherited.
 */
const DEFAULT_PROPERTY: Partial<Record<PaintRole, BaseDefault["property"]>> = { text: "color", vector: "color", stroke: "border-color" };

export interface BindDecision {
  /** The token, as `tokens` names it and the variable is named, or null to leave the value unbound. */
  variable: string | null;
  /** Every token with the value, sorted: what an unbound value is listed with. */
  candidates: string[];
  /** Where a base style picked the token, not a class: the rule, as `defaults` gives it. */
  from?: string;
}

export class Binder {
  private readonly colors = new Map<string, string[]>();
  private readonly radii: { name: string; px: number }[] = [];
  private readonly defaults = new Map<BaseDefault["property"], BaseDefault>();

  constructor(tokens?: Pick<TokenExtractionResult, "collections" | "defaults"> | null) {
    for (const d of tokens?.defaults ?? []) this.defaults.set(d.property, d);
    // tokens.json from before held a radius DEFAULT that repeats a step: a
    // 10px corner matched it and lg, and no class names DEFAULT.
    for (const collection of withoutRepeatedDefault(tokens?.collections ?? [])) {
      for (const token of collection.tokens) {
        if (collection.category === "colors" && token.hex) {
          // An opaque token is keyed by #rrggbb, so a translucent paint of its
          // color (`border-destructive/30`) finds it; a translucent token only
          // by its whole value, since binding takes the variable's alpha.
          const hex = token.hex.toLowerCase();
          const key = hex.length === 9 && !hex.endsWith("ff") ? hex : hex.slice(0, 7);
          const names = this.colors.get(key) ?? [];
          if (!names.includes(token.name)) names.push(token.name);
          this.colors.set(key, names);
        }
        if (collection.category === "radius" && typeof token.px === "number") this.radii.push({ name: token.name, px: token.px });
      }
    }
  }

  /** Whether any token was read at all: without one, nothing binds and nothing is worth listing. */
  get empty(): boolean {
    return this.colors.size === 0 && this.radii.length === 0;
  }

  /** The token a paint of `hex` (`#rrggbb` or `#rrggbbaa`) binds to, in `role`, given the node's classes. */
  color(hex: string, role: PaintRole, cls: readonly string[] | undefined): BindDecision {
    const value = hex.toLowerCase();
    const candidates = [...new Set([...(this.colors.get(value.slice(0, 7)) ?? []), ...(value.length === 9 ? this.colors.get(value) ?? [] : [])])].sort();
    const decision = decide(candidates, PREFIXES[role], cls);
    if (decision.variable || decision.named) return { variable: decision.variable, candidates };
    // No class names any of them: the base style for the property, if it is one.
    const fallback = DEFAULT_PROPERTY[role] && this.defaults.get(DEFAULT_PROPERTY[role]!);
    if (fallback && candidates.includes(fallback.token)) return { variable: fallback.token, candidates, from: fallback.from };
    return { variable: null, candidates };
  }

  /** The radius token a corner radius of `px` binds to, given the node's classes. */
  radius(px: number, cls: readonly string[] | undefined): BindDecision {
    const candidates = [...new Set(this.radii.filter((t) => Math.abs(t.px - px) < 0.01).map((t) => t.name))].sort();
    return { variable: decide(candidates, PREFIXES.radius, cls).variable, candidates };
  }
}

/**
 * The one candidate the classes name, or the only candidate; `named` says
 * how many the classes named, so a value two classes name isn't then
 * handed to a default.
 */
function decide(candidates: string[], prefixes: string[], cls: readonly string[] | undefined): { variable: string | null; named: number } {
  if (candidates.length <= 1) return { variable: candidates[0] ?? null, named: 0 };
  const named = new Set<string>();
  for (const c of cls ?? []) {
    const prefix = prefixes.find((p) => c.startsWith(`${p}-`));
    if (!prefix) continue;
    const rest = c.slice(prefix.length + 1).toLowerCase();
    for (const name of [rest, rest.replace(SIDE, "")]) {
      const token = candidates.find((t) => tokenClassName(t) === name);
      if (token) named.add(token);
    }
  }
  return { variable: named.size === 1 ? [...named][0] : null, named: named.size };
}
