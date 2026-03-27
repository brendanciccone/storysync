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

export interface FigmaComponentDefinition {
  name: string;
  variantProperties: FigmaVariantProperty[];
  variantCombinations: Record<string, string>[];
  wasCapped: boolean;
}

export interface StorybookComponent {
  name: string;
  props: StorybookProp[];
  stories: { id: string; name: string }[];
}

const MAX_COMBINATIONS = 256;

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

function resolveDefault(raw: unknown): string | null {
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

function shouldSkip(prop: StorybookProp): boolean {
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

function extractEnumValues(prop: StorybookProp): string[] | null {
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

function mapProp(prop: StorybookProp): FigmaVariantProperty | null {
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

function cartesian(properties: FigmaVariantProperty[]): { combinations: Record<string, string>[]; wasCapped: boolean } {
  if (!properties.length) return { combinations: [{}], wasCapped: false };

  let combos: Record<string, string>[] = [{}];
  for (const prop of properties) {
    const next: Record<string, string>[] = [];
    for (const existing of combos) {
      for (const value of prop.values) {
        next.push({ ...existing, [prop.name]: value });
        if (next.length >= MAX_COMBINATIONS) {
          return { combinations: next, wasCapped: true };
        }
      }
    }
    combos = next;
  }
  return { combinations: combos, wasCapped: false };
}

export function mapComponent(component: StorybookComponent): FigmaComponentDefinition {
  const variantProperties = component.props.map(mapProp).filter((v): v is FigmaVariantProperty => v != null);
  const { combinations, wasCapped } = cartesian(variantProperties);
  return { name: component.name, variantProperties, variantCombinations: combinations, wasCapped };
}
