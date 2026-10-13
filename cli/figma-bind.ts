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

import { tokenClassName, withoutRepeatedDefault } from "./tokens.js";
import type { TokenExtractionResult } from "./tokens.js";

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

export interface BindDecision {
  /** The token, as `tokens` names it and the variable is named, or null to leave the value unbound. */
  variable: string | null;
  /** Every token with the value, sorted: what an unbound value is listed with. */
  candidates: string[];
}

export class Binder {
  private readonly colors = new Map<string, string[]>();
  private readonly radii: { name: string; px: number }[] = [];

  constructor(tokens?: Pick<TokenExtractionResult, "collections"> | null) {
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
    return decide(candidates, PREFIXES[role], cls);
  }

  /** The radius token a corner radius of `px` binds to, given the node's classes. */
  radius(px: number, cls: readonly string[] | undefined): BindDecision {
    const candidates = [...new Set(this.radii.filter((t) => Math.abs(t.px - px) < 0.01).map((t) => t.name))].sort();
    return decide(candidates, PREFIXES.radius, cls);
  }
}

function decide(candidates: string[], prefixes: string[], cls: readonly string[] | undefined): BindDecision {
  if (candidates.length <= 1) return { variable: candidates[0] ?? null, candidates };
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
  return { variable: named.size === 1 ? [...named][0] : null, candidates };
}
