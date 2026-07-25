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

const MAX_COMBINATIONS = 256;
const DROPPED_SAMPLE_SIZE = 20;

const SKIP_PROPS = new Set([
  "children", "className", "class", "style", "ref", "key", "as",
]);

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

export function shouldSkip(prop: StorybookProp): boolean {
  if (SKIP_PROPS.has(prop.name)) return true;
  if (/^on[A-Z]/.test(prop.name)) return true;
  if (prop.name.startsWith("aria-") || prop.name.startsWith("data-")) return true;

  const t = prop.type.name;
  if (CALLBACK_TYPES.some((p) => p.test(t))) return true;
  if (NON_VISUAL_TYPES.some((p) => p.test(t))) return true;

  if (t === "string" || t === "number") {
    return !(prop.control?.options && prop.control.options.length > 0);
  }

  return false;
}

function isLiteral(member: PropType): boolean {
  if (member.name === "literal") return true;
  if (member.raw && /^["'`].*["'`]$/.test(member.raw.trim())) return true;
  return false;
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

  // raw type string: "sm" | "md" | "lg"
  if (raw) {
    const parts = raw.trim().split("|").map((p) => p.trim());
    if (parts.length > 0 && parts.every((p) => /^["'`].*["'`]$/.test(p))) {
      return parts.map(stripQuotes).filter(Boolean);
    }
  }

  return null;
}

export function mapProp(prop: StorybookProp): FigmaVariantProperty | null {
  if (shouldSkip(prop)) return null;

  if (prop.type.name === "bool" || prop.type.name === "boolean" || prop.control?.type === "boolean") {
    const d = resolveDefault(prop.defaultValue);
    return { name: prop.name, type: "BOOLEAN", values: ["true", "false"], defaultValue: d === "true" ? "true" : "false" };
  }

  const vals = extractEnumValues(prop);
  if (vals?.length) {
    const d = resolveDefault(prop.defaultValue);
    const defaultValue = d != null && vals.includes(d) ? d : vals[0];
    return { name: prop.name, type: "VARIANT", values: vals, defaultValue };
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

// When the full product exceeds the cap, pick combinations by usefulness
// instead of truncating mid-expansion:
//   1. every property at its default — the canonical variant;
//   2. one-property sweeps — each value once against defaults, so every
//      declared value is represented somewhere in the output;
//   3. the remainder in cartesian order, to fill the budget.
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

  // Built in `properties` order so every combination has identical key order.
  const defaults: Record<string, string> = {};
  for (const prop of properties) defaults[prop.name] = prop.defaultValue;

  push({ ...defaults });

  for (const prop of properties) {
    for (const value of prop.values) {
      if (value === prop.defaultValue) continue;
      push({ ...defaults, [prop.name]: value });
      if (combinations.length >= max) break;
    }
    if (combinations.length >= max) break;
  }

  for (const combo of enumerateCombinations(properties)) {
    if (combinations.length >= max) break;
    push(combo);
  }

  return { combinations, seen };
}

export function cartesian(
  properties: FigmaVariantProperty[],
): { combinations: Record<string, string>[]; wasCapped: boolean; cap?: CapInfo } {
  if (!properties.length) return { combinations: [{}], wasCapped: false };

  const totalPossible = totalCombinations(properties);
  if (totalPossible <= MAX_COMBINATIONS) {
    return { combinations: [...enumerateCombinations(properties)], wasCapped: false };
  }

  const { combinations, seen } = generateCapped(properties, MAX_COMBINATIONS);

  const droppedSample: Record<string, string>[] = [];
  for (const combo of enumerateCombinations(properties)) {
    if (droppedSample.length >= DROPPED_SAMPLE_SIZE) break;
    if (!seen.has(combinationKey(properties, combo))) droppedSample.push(combo);
  }

  return {
    combinations,
    wasCapped: true,
    cap: {
      maxCombinations: MAX_COMBINATIONS,
      totalPossible,
      generated: combinations.length,
      droppedCount: totalPossible - combinations.length,
      droppedSample,
    },
  };
}

export function mapComponent(component: StorybookComponent): FigmaComponentDefinition {
  const variantProperties = component.props.map(mapProp).filter((v): v is FigmaVariantProperty => v != null);
  const { combinations, wasCapped, cap } = cartesian(variantProperties);
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
