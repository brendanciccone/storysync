// Which variable a measured paint or radius binds to (section 8.9).
//
// A value binds when exactly one token has it. Several often do: on
// shadcn/ui's neutral theme #0a0a0a is `foreground`, `card/foreground`,
// `popover/foreground` and `sidebar/foreground`, and #171717 five more. So
// binding by value alone would pick one at random, and the push used to ask
// the agent to read the component's source to choose. snap now records the
// node's own class evidence (`cls`: `bg-primary`, `text-card-foreground`,
// `rounded-lg`, with any variant prefix and `/NN` opacity stripped, but a
// `dark:` class's, `dark:bg-destructive/20`), which names the token the
// code used: a value binds when exactly one of its
// tokens is named by a class for that property. Otherwise it stays as
// measured, unbound, and is listed with the tokens it matches, rather than
// guessed. The value is always snap's; the class only picks among the
// tokens that have it.
//
// Where no class names one, the project's base styles can: shadcn/ui's
// dialog title has no color class, and inherits `body`'s `text-foreground`
// from `@layer base`; a card's border takes `* { @apply border-border }`.
// tokens reads those as `defaults`. Only where snap found that no class
// sets the property (the node's `nocls`) does a value whose tokens include
// the default bind to it, with the rule as its evidence: a class that sets
// it to a color no token names (`text-neutral-950`, `text-[#0a0a0a]`), or
// sets it on an element the text inherits from, is no such evidence, and a
// tree from before `nocls` takes no default.

import { tokenClassName, withoutRepeatedDefault } from "./tokens.js";
import type { BaseDefault, TokenExtractionResult } from "./tokens.js";
import { SIDE, utilitySetsColor } from "./tree-types.js";
import type { NoClassPaint } from "./tree-types.js";

/** What a paint colors, which decides the classes that can name its token: `effect` is a shadow's color. */
export type PaintRole = "fill" | "text" | "stroke" | "vector" | "effect";

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
  effect: ["ring", "shadow"],
  radius: ["rounded"],
};

/**
 * The roles whose value alone binds none: a shadow's color binds only where
 * a class names its token, since Tailwind's shadow scale draws in a black
 * no token was set from, which a project's one `black` token would match.
 */
const NAMED_ONLY = new Set<PaintRole>(["effect"]);

/**
 * The property of the base styles' defaults a role takes when no class
 * names its token: a text, and an icon in `currentColor`, inherit `color`;
 * a stroke is a border, whose color `*` sets. A fill takes none, since no
 * background is inherited.
 */
const DEFAULT_PROPERTY: Partial<Record<PaintRole, NoClassPaint>> = { text: "color", vector: "color", stroke: "border-color" };

/** The color properties a role's classes set: an icon's `fill-*` and `stroke-*` as well as its `text-*`. */
const SETS: Partial<Record<PaintRole, string[]>> = { text: ["color"], vector: ["color", "fill", "stroke"], stroke: ["border-color"] };

export interface BindDecision {
  /** The token, as `tokens` names it and the variable is named, or null to leave the value unbound. */
  variable: string | null;
  /** Every token with the value, sorted: what an unbound value is listed with. */
  candidates: string[];
  /** True where the classes name two of them and the value is left unbound for it, rather than for none being named. */
  ambiguous?: true;
  /** Where `ambiguous`: the candidates the classes name, sorted, which tie, as `text-card-foreground` and `text-foreground` do. */
  named?: string[];
  /** Where a base style picked the token, not a class: the rule, as `defaults` gives it. */
  from?: string;
}

export class Binder {
  private readonly colors = new Map<string, string[]>();
  private readonly radii: { name: string; px: number }[] = [];
  private readonly defaults = new Map<BaseDefault["property"], BaseDefault>();
  /** Each color token whose light value is opaque, which a translucent paint of its color binds through an alpha variable. */
  private readonly opaqueColors = new Set<string>();
  /** Every color token as a class names it (`card-foreground`), and each font size as its `text-*` class. */
  private readonly colorNames = new Set<string>();
  private readonly sizeClasses = new Set<string>();

  constructor(tokens?: Pick<TokenExtractionResult, "collections" | "defaults"> | null) {
    for (const d of tokens?.defaults ?? []) this.defaults.set(d.property, d);
    for (const collection of tokens?.collections ?? []) {
      for (const token of collection.tokens) {
        if (collection.category === "colors") this.colorNames.add(tokenClassName(token.name));
        // A v4 theme's `--text-body`, or a config's fontSize `body`: `text-body` is a size.
        if (collection.category === "typography" && (token.name.startsWith("text/") || !token.name.includes("/"))) {
          this.sizeClasses.add(`text-${tokenClassName(token.name.replace(/^text\//, ""))}`);
        }
      }
    }
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
          if (key.length === 7) this.opaqueColors.add(token.name);
        }
        if (collection.category === "radius" && typeof token.px === "number") this.radii.push({ name: token.name, px: token.px });
      }
    }
  }

  /** Whether any token was read at all: without one, nothing binds and nothing is worth listing. */
  get empty(): boolean {
    return this.colors.size === 0 && this.radii.length === 0;
  }

  /**
   * The token a paint of `hex` (`#rrggbb` or `#rrggbbaa`) binds to, in
   * `role`, given the node's classes and the properties snap found no class
   * sets (`nocls`).
   */
  color(hex: string, role: PaintRole, cls: readonly string[] | undefined, nocls?: readonly string[]): BindDecision {
    const value = hex.toLowerCase();
    const candidates = [...new Set([...(this.colors.get(value.slice(0, 7)) ?? []), ...(value.length === 9 ? this.colors.get(value) ?? [] : [])])].sort();
    const decision = decide(candidates, PREFIXES[role], cls, !NAMED_ONLY.has(role));
    if (decision.variable || decision.named.length) return { variable: decision.variable, candidates, ...(decision.variable ? {} : { ambiguous: true as const, named: decision.named }) };
    // No class names any of them: the base style for the property, where
    // snap found no class sets it, and none of the classes it lists sets it
    // in some state to a color no token names.
    const property = DEFAULT_PROPERTY[role];
    const fallback = property && this.defaults.get(property);
    if (fallback && candidates.includes(fallback.token) && nocls?.includes(property!) && !this.unnamedColor(role, cls)) {
      return { variable: fallback.token, candidates, from: fallback.from };
    }
    return { variable: null, candidates };
  }

  /**
   * A class among `cls` that sets the role's color to one no token names:
   * a palette color, `hover:text-neutral-950`, which may be the color
   * measured in that state, or `dark:text-neutral-50`, the dark theme's.
   * A project's font size (`text-body`) sets none.
   */
  private unnamedColor(role: PaintRole, cls: readonly string[] | undefined): string | undefined {
    return (cls ?? []).map((c) => readEvidence(c).utility).find((c) => {
      const property = utilitySetsColor(c);
      if (!property || !SETS[role]?.includes(property) || this.sizeClasses.has(c)) return false;
      const name = c.slice(c.indexOf("-") + 1);
      return !this.colorNames.has(name) && !this.colorNames.has(name.replace(SIDE, ""));
    });
  }

  /**
   * Whether a color token's light value is opaque: a translucent paint
   * bound to it is the token at an alpha (`border-destructive/30`), which
   * its alpha variable holds (alphaVariableName). A translucent token's own
   * variable holds its alpha already.
   */
  opaque(name: string): boolean {
    return this.opaqueColors.has(name);
  }

  /**
   * The alpha (0-1) the dark theme paints `token` at in `role`, where a
   * `dark:` class names it, `dark:bg-destructive/20` 0.2 and
   * `dark:bg-destructive` 1, as a snap that keeps a `dark:` class's
   * opacity writes them; undefined where none names it, or two name it at
   * different alphas.
   */
  darkAlpha(token: string, role: PaintRole, cls: readonly string[] | undefined): number | undefined {
    const found = new Set<number>();
    for (const entry of cls ?? []) {
      const { dark, utility, alpha } = readEvidence(entry);
      if (!dark) continue;
      const prefix = PREFIXES[role].find((p) => utility.startsWith(`${p}-`));
      if (!prefix) continue;
      const rest = utility.slice(prefix.length + 1).toLowerCase();
      if (tokenClassName(token) === rest || tokenClassName(token) === rest.replace(SIDE, "")) found.add(alpha ?? 1);
    }
    return found.size === 1 ? [...found][0] : undefined;
  }

  /** The radius token a corner radius of `px` binds to, given the node's classes. */
  radius(px: number, cls: readonly string[] | undefined): BindDecision {
    const candidates = [...new Set(this.radii.filter((t) => Math.abs(t.px - px) < 0.01).map((t) => t.name))].sort();
    const decision = decide(candidates, PREFIXES.radius, cls);
    return { variable: decision.variable, candidates, ...(!decision.variable && decision.named.length > 1 ? { ambiguous: true as const, named: decision.named } : {}) };
  }
}

/**
 * The one candidate the classes name, or the only candidate where the value
 * alone may bind (`byValue`); `named` lists those the classes named, so a
 * value two classes name isn't then handed to a default. Where they name several, the one a `dark:` class
 * names, alone: it has the light value measured, and is the token the dark
 * theme paints, so its variable is right in both modes, as an outline
 * button's `border-border dark:border-input` border is `input`.
 */
function decide(candidates: string[], prefixes: string[], cls: readonly string[] | undefined, byValue = true): { variable: string | null; named: string[] } {
  if (byValue && candidates.length <= 1) return { variable: candidates[0] ?? null, named: [] };
  const named = new Set<string>();
  const dark = new Set<string>();
  for (const entry of cls ?? []) {
    const { dark: isDark, utility: c } = readEvidence(entry);
    const prefix = prefixes.find((p) => c.startsWith(`${p}-`));
    if (!prefix) continue;
    const rest = c.slice(prefix.length + 1).toLowerCase();
    for (const name of [rest, rest.replace(SIDE, "")]) {
      const token = candidates.find((t) => tokenClassName(t) === name);
      if (token) named.add(token);
      if (token && isDark) dark.add(token);
    }
  }
  const variable = named.size === 1 ? [...named][0] : dark.size === 1 ? [...dark][0] : null;
  return { variable, named: [...named].sort() };
}

/**
 * A `cls` entry as the utility it names, whether the dark theme alone
 * applies it, and the opacity a `dark:` one keeps: `dark:bg-destructive/20`
 * is `bg-destructive`, dark, at 0.2; `/[.25]` and `/[25%]` are 0.25. snap
 * keeps no other entry's opacity, which the paint's measured alpha holds.
 */
export function readEvidence(entry: string): { dark: boolean; utility: string; alpha?: number } {
  const dark = entry.startsWith("dark:");
  const rest = dark ? entry.slice(5) : entry;
  const m = /^(.+?)\/(?:(\d+(?:\.\d+)?)|\[(\d*\.?\d+)(%?)\])$/.exec(rest);
  if (!m) return { dark, utility: rest };
  const alpha = m[2] !== undefined ? Number(m[2]) / 100 : Number(m[3]) / (m[4] ? 100 : 1);
  return { dark, utility: m[1], ...(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1 ? { alpha } : {}) };
}

// --- Alpha variables ------------------------------------------------------------
//
// Figma resolves a paint bound to a color variable again at every explicit
// mode switch, on its frame or one around it, and gives it the variable's
// own alpha as its opacity, a shadow its variable's alpha: probe 7b saw
// shadcn/ui's `bg-destructive/10` and `ring-foreground/10`, bound to
// `destructive` and `foreground` at 10%, turn opaque at the first switch to
// Dark and stay so back in Light. A variable that carries the alpha keeps
// it: probe 7c bound a fill, an OUTSIDE stroke and a ring to
// `destructive 10%`, `destructive 30%` and `foreground 10%`, each mode's
// value the token's at that alpha, and each kept its alpha through every
// switch, its frame's, a frame's around it and an instance's, in a call of
// their own too. So a variable is made for each token and alpha the plan
// binds below 1, beside the token in its collection, and the build binds
// the paint to it: the plan's first call makes those (figma-code.ts), and
// `figma tokens` keeps them up to date with their tokens. The name is the
// token's and the alpha as a percent, `destructive 10%`: no token is named
// with a space or `%`, so none can clash, and Figma lists it beside its
// token. Figma refuses a period in a name (probe 7c), so an alpha of no
// whole percent, which Tailwind's `/NN` never gives, has a comma:
// `destructive 12,5%`. Where the dark theme paints the token at another
// alpha, as shadcn/ui's destructive button's `bg-destructive/10
// dark:bg-destructive/20` does, the variable holds each mode's own alpha
// and says both, `destructive 10% dark 20%`, which probe 7c's third call
// made beside `destructive` and `destructive 10%` and saw keep 10% in Light
// and 20% in Dark through every switch.

/** An alpha variable's name: its token's, a space, the alpha in percent, and the dark theme's where it differs. */
export const ALPHA_VARIABLE = /^(.+?) (\d{1,3}(?:,\d)?)%(?: dark (\d{1,3}(?:,\d)?)%)?$/;

/** An alpha 0-1 as the byte `#rrggbbaa` writes, which is what snap measures. */
export const alphaByte = (alpha: number): number => Math.max(0, Math.min(255, Math.round(alpha * 255)));

/**
 * The alpha variable of `token` at `alpha` (0-1), and at `dark` in the dark
 * theme where that is another byte: `destructive 10%`, `destructive 10% dark
 * 20%`. Each percent is the shortest, whole or to a tenth, that reads back
 * as the same byte, so each byte has one name and the name gives the byte.
 */
export function alphaVariableName(token: string, alpha: number, dark?: number): string {
  const percent = (a: number) => {
    const byte = alphaByte(a);
    const whole = Math.round((byte * 100) / 255);
    return alphaOfPercent(whole) === byte ? String(whole) : (Math.round((byte * 1000) / 255) / 10).toFixed(1).replace(".", ",");
  };
  const darkPart = dark === undefined || alphaByte(dark) === alphaByte(alpha) ? "" : ` dark ${percent(dark)}%`;
  return `${token} ${percent(alpha)}%${darkPart}`;
}

/**
 * The byte a percent, as an alpha variable's name writes it, stands for:
 * the alpha `percent / 100` as snap writes it in `#rrggbbaa`, rounded as
 * snap rounds it, so each of Tailwind's `/NN` has its whole name.
 */
function alphaOfPercent(percent: number): number {
  return Math.round((percent / 100) * 255);
}

/**
 * The token and alphas (0-1, as the bytes give them) an alpha variable's
 * name stands for, `dark` where the dark theme's differs, or null for
 * another name.
 */
export function parseAlphaVariable(name: string): { token: string; alpha: number; dark?: number } | null {
  const m = ALPHA_VARIABLE.exec(name);
  if (!m) return null;
  const [light, dark] = [m[2], m[3]].map((p) => (p === undefined ? undefined : Number(p.replace(",", "."))));
  if (light! > 100 || (dark ?? 0) > 100) return null;
  return { token: m[1], alpha: alphaOfPercent(light!) / 255, ...(dark !== undefined ? { dark: alphaOfPercent(dark) / 255 } : {}) };
}
