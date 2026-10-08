// Storybook props -> Figma variant properties.

export interface StorybookProp {
  name: string;
  type: PropType;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
  control?: ArgTypeControl;
}

export interface PropType {
  name: string;
  value?: string[] | PropType[];
  raw?: string;
}

export interface ArgTypeControl {
  type?: string;
  options?: string[];
}

export interface FigmaVariantProperty {
  name: string;
  type: "BOOLEAN" | "VARIANT";
  values: string[];
  defaultValue: string;
  /**
   * Present, and true, only when the docs gave no default the values
   * include, so `defaultValue` is a guess. Left out otherwise, so map JSON
   * written before it existed still matches wherever the docs give one.
   */
  defaultAssumed?: true;
}

// Details about a truncated variant expansion. Present only when `wasCapped`.
export interface CapInfo {
  maxCombinations: number;
  totalPossible: number;
  generated: number;
  droppedCount: number;
  /** First few dropped combinations, in cartesian order, for reporting. */
  droppedSample: Record<string, string>[];
}

export interface FigmaComponentDefinition {
  name: string;
  title?: string;
  category?: string;
  variantProperties: FigmaVariantProperty[];
  variantCombinations: Record<string, string>[];
  wasCapped: boolean;
  cap?: CapInfo;
}

export interface StorybookComponent {
  name: string;
  title?: string;
  category?: string;
  props: StorybookProp[];
  stories: { id: string; name: string }[];
}

/**
 * Default ceiling on combinations generated for one component.
 *
 * Combinations multiply — four props of four values is already 256 — and a Figma
 * component set with thousands of variants is unusable. Above the ceiling a
 * covering subset is generated and the cap reported, never applied silently.
 */
export const DEFAULT_MAX_COMBINATIONS = 256;
const DROPPED_SAMPLE_SIZE = 20;

const SKIP_PROPS = new Set([
  "children", "className", "class", "style", "ref", "key",
]);

// Props that choose which element renders, not how it looks: `as`, Radix's
// (and Ark UI's) `asChild`, and Base UI's `render`. asChild hands the
// component's props and styles to its child instead of rendering its own
// element, so `asChild=true` looks like whatever the story passes as the
// child, and with the text child most stories pass, Radix's Slot throws and
// nothing renders at all. `render`'s type, an element or a render function,
// already kept it out; naming it here lets inspect say why.
const COMPOSITION_PROPS = new Set(["as", "asChild", "render"]);

const CALLBACK_TYPES = [
  /^func(tion)?$/i, /^\(.*\)\s*=>/, /Event/,
];

const NON_VISUAL_TYPES = [
  /^ReactNode$/, /^ReactElement$/, /^JSX\.Element$/, /^node$/i,
  /^Ref</, /^CSSProperties$/,
];

function stripQuotes(s: string): string {
  let r = s.trim();
  while (r.length >= 2 && "'\"`".includes(r[0]) && r[r.length - 1] === r[0]) {
    r = r.slice(1, -1).trim();
  }
  return r;
}

export function resolveDefault(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return stripQuotes(raw);
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.summary != null) return stripQuotes(String(obj.summary));
    if (obj.value != null) return stripQuotes(String(obj.value));
  }
  return null;
}

// Why a prop is never a variant property, judged by its name or type alone,
// before its values are looked at; null when it may be one. `shouldSkip` and
// `explainProp` both read it, so inspect's reason is the rule that applied.
function skipReason(prop: StorybookProp): string | null {
  if (SKIP_PROPS.has(prop.name)) return "structural prop";
  if (COMPOSITION_PROPS.has(prop.name)) return "composition prop: it changes what renders, not how it looks";
  if (/^on[A-Z]/.test(prop.name)) return "event handler";
  if (prop.name.startsWith("aria-") || prop.name.startsWith("data-")) return "aria-* or data-* attribute";

  const t = prop.type.name;
  if (CALLBACK_TYPES.some((p) => p.test(t))) return "callback";
  if (NON_VISUAL_TYPES.some((p) => p.test(t))) return "content, ref or style object, not a value";

  if ((t === "string" || t === "number") && !prop.control?.options?.length) {
    return `free ${t}, with no fixed values`;
  }

  return null;
}

export function shouldSkip(prop: StorybookProp): boolean {
  return skipReason(prop) !== null;
}

function isLiteral(member: PropType): boolean {
  if (member.name === "literal") return true;
  if (member.raw && isQuotedLiteral(member.raw)) return true;
  return false;
}

function isQuotedLiteral(text: string): boolean {
  const t = text.trim();
  // A template literal type with a placeholder, `${number}px`, stands for
  // every string of that shape, not one value.
  return /^["'`].*["'`]$/.test(t) && !(t.startsWith("`") && t.includes("${"));
}

/**
 * A printed type's members: split on each `|` outside a string literal and
 * outside brackets, braces, parentheses and type arguments, so a function
 * type, `(value: string | null) => void`, or an array of a union, `("a" |
 * "b")[]`, stays one member, and a literal holding a `|` stays whole.
 */
export function splitUnion(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if ("([{<".includes(c)) {
      depth++;
    } else if (")]}".includes(c) || (c === ">" && raw[i - 1] !== "=")) {
      // The `>` of an arrow, `=>`, closes nothing.
      depth = Math.max(0, depth - 1);
    } else if (c === "|" && depth === 0) {
      parts.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(raw.slice(start).trim());
  return parts;
}

/**
 * The members of a raw union type string, without `null` and `undefined`.
 *
 * Those two mean the prop can be left unset, not that it has another value.
 * cva's `VariantProps` types every variant that way, `"default" | "outline" |
 * null`, as react-docgen-typescript prints it, so counting them as members
 * rejected every variant of every cva component (all of shadcn/ui's).
 */
export function definedMembers(raw: string): string[] {
  return splitUnion(raw).filter((p) => p && p !== "null" && p !== "undefined");
}

// A boolean, or a boolean that may be left unset: cva's boolean variants
// print as `boolean | null`, and TypeScript can spell boolean `true | false`.
function isBoolean(prop: StorybookProp): boolean {
  const { name, raw } = prop.type;
  if (name === "bool" || name === "boolean" || prop.control?.type === "boolean") return true;
  if (!raw) return false;
  const members = definedMembers(raw);
  if (members.length === 1) return members[0] === "boolean";
  return members.length === 2 && members.includes("true") && members.includes("false");
}

export function extractEnumValues(prop: StorybookProp): string[] | null {
  // argType options are the most reliable source
  if (prop.control?.options?.length) {
    return prop.control.options.map((v) => stripQuotes(String(v)));
  }

  const { name, value, raw } = prop.type;

  // react-docgen enum: { name: "enum", value: [{ value: "'primary'" }, ...] }
  if (name === "enum" && Array.isArray(value)) {
    const vals = value
      .map((v: unknown) => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          return typeof o.value === "string" ? o.value
            : typeof o.raw === "string" ? o.raw
            : typeof o.name === "string" ? o.name
            : null;
        }
        return null;
      })
      .filter((v): v is string => v != null)
      .map(stripQuotes)
      .filter(Boolean);
    if (vals.length) return vals;
  }

  // react-docgen union: { name: "union", value: [{ name: "literal", raw: "'sm'" }, ...] }
  if (name === "union" && Array.isArray(value)) {
    const vals = (value as PropType[])
      .filter(isLiteral)
      .map((v) => stripQuotes(v.raw ?? v.name))
      .filter(Boolean);
    if (vals.length) return vals;
  }

  // raw type string: "sm" | "md" | "lg", with any `| null` or `| undefined`
  // left out. A union with any other non-literal member, `"sm" | number`, is
  // not a fixed set of values and is rejected whole.
  if (raw) {
    const parts = definedMembers(raw);
    if (parts.length > 0 && parts.every(isQuotedLiteral)) {
      return parts.map(stripQuotes).filter(Boolean);
    }
  }

  return null;
}

/**
 * How one prop maps, and why when it doesn't, for `inspect` to print.
 *
 * `defaultAssumed` is true when the docs gave no default the property's
 * values include, so `mapProp` fell back to a guess (see `guessDefault`),
 * which is right only by luck when a library sets the default internally
 * (cmdk's `shouldFilter` is true, mapped `false`).
 */
export function explainProp(prop: StorybookProp): {
  property: FigmaVariantProperty | null;
  reason: string | null;
  defaultAssumed: boolean;
} {
  const property = mapProp(prop);
  if (property) return { property, reason: null, defaultAssumed: property.defaultAssumed === true };
  return { property: null, reason: skipReason(prop) ?? valuesReason(prop), defaultAssumed: false };
}

/**
 * The default to assume for a union whose docs give none: a value named
 * `default` if there is one, else the first.
 *
 * cva's convention, which shadcn/ui follows, names a variant's default
 * value `default` and sets it in `defaultVariants`, where docgen can't see
 * it. A component that doesn't also destructure it with a default, as
 * shadcn/ui's Tailwind v3 Button doesn't, prints none, and the first value
 * is then TypeScript's union order, `link` for shadcn/ui's Button, which
 * says nothing about the default.
 */
function guessDefault(values: string[]): string {
  return values.includes("default") ? "default" : values[0];
}

// Why a prop that passed `skipReason` still has no values to map.
function valuesReason(prop: StorybookProp): string {
  const { name, raw } = prop.type;
  if (raw) {
    const members = definedMembers(raw);
    if (!members.length) return "union of only null or undefined";
    // The parser calls any type with a `|` in it a union, a function type
    // whose parameter may be null among them, so say what the one member is.
    if (members.length === 1) {
      const [only] = members;
      if (CALLBACK_TYPES.some((p) => p.test(only))) return "callback";
      if (only === "string" || only === "number") return `free ${only}, with no fixed values`;
      return `its type, ${only}, lists no values`;
    }
    return `union with non-literal members: ${members.filter((p) => !isQuotedLiteral(p)).join(", ")}`;
  }
  if (name === "union" || name === "enum") return `${name} with no literal members`;
  return `its type, ${name}, lists no values`;
}

export function mapProp(prop: StorybookProp): FigmaVariantProperty | null {
  if (shouldSkip(prop)) return null;

  if (isBoolean(prop)) {
    const d = resolveDefault(prop.defaultValue);
    const assumed = d !== "true" && d !== "false";
    return { name: prop.name, type: "BOOLEAN", values: ["true", "false"], defaultValue: d === "true" ? "true" : "false", ...(assumed ? { defaultAssumed: true } : {}) };
  }

  const vals = extractEnumValues(prop);
  if (vals?.length) {
    const d = resolveDefault(prop.defaultValue);
    const assumed = d == null || !vals.includes(d);
    const defaultValue = assumed ? guessDefault(vals) : d;
    // The default leads, the rest keep their order. The skill lays a Figma
    // set out in this order, and Figma makes its top-left variant the set's
    // default, so a default further along made Figma's default a variant the
    // code never renders unasked. The order Storybook's docs print is
    // TypeScript's, not the author's: shadcn's Button reads `"link" |
    // "default" | ...` though its cva declares default first. A BOOLEAN keeps
    // `true, false`, which the skill lays out `false, true` whatever it holds.
    return { name: prop.name, type: "VARIANT", values: [defaultValue, ...vals.filter((v) => v !== defaultValue)], defaultValue, ...(assumed ? { defaultAssumed: true } : {}) };
  }

  return null;
}

// Total size of the full cartesian product, clamped so a pathological
// component can't overflow into a meaningless number.
export function totalCombinations(properties: FigmaVariantProperty[]): number {
  let total = 1;
  for (const prop of properties) {
    if (!prop.values.length) return 0;
    total *= prop.values.length;
    if (total > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

// Enumerates the full product in property order, last property varying
// fastest — the same order the previous nested-loop implementation produced.
export function* enumerateCombinations(
  properties: FigmaVariantProperty[],
): Generator<Record<string, string>> {
  if (!properties.length) {
    yield {};
    return;
  }
  if (properties.some((p) => !p.values.length)) return;

  const indices = new Array(properties.length).fill(0);
  for (;;) {
    const combo: Record<string, string> = {};
    for (let i = 0; i < properties.length; i++) {
      combo[properties[i].name] = properties[i].values[indices[i]];
    }
    yield combo;

    let i = properties.length - 1;
    for (; i >= 0; i--) {
      indices[i]++;
      if (indices[i] < properties[i].values.length) break;
      indices[i] = 0;
    }
    if (i < 0) return;
  }
}

// Identity of a combination, for de-duplication. NUL is the separator because
// variant values may legitimately contain spaces ("Data Display"), which would
// otherwise let ["a b", "c"] and ["a", "b c"] collide.
function combinationKey(properties: FigmaVariantProperty[], combo: Record<string, string>): string {
  return properties.map((p) => combo[p.name]).join("\u0000");
}

/**
 * The smallest set that still exercises every declared value: every property
 * at its default, then each remaining value once against those defaults.
 *
 * Size is the *sum* of value counts rather than their product — 1 + Σ(values-1)
 * — which is why `snap` can measure a component in a handful of renders instead
 * of one per combination. It is also the leading section of the capped ordering
 * below, so the two stay consistent by construction.
 */
export function representativeCombinations(
  properties: FigmaVariantProperty[],
): Record<string, string>[] {
  if (!properties.length) return [{}];

  const combinations: Record<string, string>[] = [];
  const seen = new Set<string>();
  const push = (combo: Record<string, string>): void => {
    const key = combinationKey(properties, combo);
    if (seen.has(key)) return;
    seen.add(key);
    combinations.push(combo);
  };

  // Built in `properties` order so every combination has identical key order.
  const defaults: Record<string, string> = {};
  for (const prop of properties) defaults[prop.name] = prop.defaultValue;

  push({ ...defaults });
  for (const prop of properties) {
    for (const value of prop.values) {
      if (value === prop.defaultValue) continue;
      push({ ...defaults, [prop.name]: value });
    }
  }
  return combinations;
}

// When the full product exceeds the cap, pick combinations by usefulness
// instead of truncating mid-expansion:
//   1. the representative set above — defaults, then every declared value;
//   2. the remainder in cartesian order, to fill the budget.
// Every emitted combination carries every property key.
function generateCapped(
  properties: FigmaVariantProperty[],
  max: number,
): { combinations: Record<string, string>[]; seen: Set<string> } {
  const combinations: Record<string, string>[] = [];
  const seen = new Set<string>();

  const push = (combo: Record<string, string>): void => {
    if (combinations.length >= max) return;
    const key = combinationKey(properties, combo);
    if (seen.has(key)) return;
    seen.add(key);
    combinations.push(combo);
  };

  for (const combo of representativeCombinations(properties)) push(combo);

  for (const combo of enumerateCombinations(properties)) {
    if (combinations.length >= max) break;
    push(combo);
  }

  return { combinations, seen };
}

export function cartesian(
  properties: FigmaVariantProperty[],
  maxCombinations: number = DEFAULT_MAX_COMBINATIONS,
): { combinations: Record<string, string>[]; wasCapped: boolean; cap?: CapInfo } {
  if (!properties.length) return { combinations: [{}], wasCapped: false };

  const totalPossible = totalCombinations(properties);
  if (totalPossible <= maxCombinations) {
    return { combinations: [...enumerateCombinations(properties)], wasCapped: false };
  }

  const { combinations, seen } = generateCapped(properties, maxCombinations);

  const droppedSample: Record<string, string>[] = [];
  for (const combo of enumerateCombinations(properties)) {
    if (droppedSample.length >= DROPPED_SAMPLE_SIZE) break;
    if (!seen.has(combinationKey(properties, combo))) droppedSample.push(combo);
  }

  return {
    combinations,
    wasCapped: true,
    cap: {
      maxCombinations,
      totalPossible,
      generated: combinations.length,
      droppedCount: totalPossible - combinations.length,
      droppedSample,
    },
  };
}

/**
 * The names `--exclude-props` gives, comma-separated, trimmed; empty when
 * the option isn't given.
 */
export function parsePropNames(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((n) => n.trim()).filter(Boolean);
}

/**
 * `component` without the props named in `names`, matched ignoring case,
 * for `--exclude-props`.
 *
 * Every boolean a component's docs list becomes a variant property, though
 * many only change behavior: vaul's Drawer has 15 (`modal`, `dismissible`,
 * `snapToSequentialPoint`...), 131072 combinations of what looks like one
 * closed trigger, so its push stopped at the cap with no way to go on. Which
 * props are visual is the project's call, not a list of names here to keep
 * up, so the user names the ones to leave out. A prop left out is not passed
 * to the story at all, so the story's own args decide it.
 */
export function withoutProps(component: StorybookComponent, names: readonly string[]): StorybookComponent {
  if (!names.length) return component;
  const excluded = new Set(names.map((n) => n.toLowerCase()));
  return { ...component, props: component.props.filter((p) => !excluded.has(p.name.toLowerCase())) };
}

export function mapComponent(
  component: StorybookComponent,
  maxCombinations: number = DEFAULT_MAX_COMBINATIONS,
): FigmaComponentDefinition {
  const variantProperties = component.props.map(mapProp).filter((v): v is FigmaVariantProperty => v != null);
  const { combinations, wasCapped, cap } = cartesian(variantProperties, maxCombinations);
  return {
    name: component.name,
    title: component.title,
    category: component.category,
    variantProperties,
    variantCombinations: combinations,
    wasCapped,
    ...(cap ? { cap } : {}),
  };
}
