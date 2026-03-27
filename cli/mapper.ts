/**
 * Core mapping rules: Storybook props → Figma variant properties.
 * Deterministic. No LLM.
 */

export interface StorybookProp {
  name: string;
  type: PropType;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
  /** Storybook argType control definition — often the real source of variant info. */
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
  /** Set when combinations were capped to avoid explosion. */
  wasCapped?: boolean;
}

export interface StorybookComponent {
  name: string;
  props: StorybookProp[];
  stories: StorybookStory[];
}

export interface StorybookStory {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface MapperOptions {
  /** Maximum variant combinations before capping. Defaults to 256. */
  maxCombinations?: number;
}

const DEFAULT_MAX_COMBINATIONS = 256;

/** Props that are never visual variants — always skip. */
const SKIP_PROP_NAMES = new Set([
  "children",
  "className",
  "class",
  "style",
  "ref",
  "key",
  "as",
  "dangerouslySetInnerHTML",
]);

/** Prop type names that indicate callbacks — always skip. */
const CALLBACK_TYPE_PATTERNS = [
  /^func$/i,
  /^function$/i,
  /^\(.*\)\s*=>/,
  /^MouseEvent/,
  /^KeyboardEvent/,
  /^ChangeEvent/,
  /^FormEvent/,
  /^FocusEvent/,
  /^React\..*EventHandler/,
  /^EventHandler/,
];

/** Prop type names that indicate non-visual types — skip. */
const NON_VISUAL_TYPE_PATTERNS = [
  /^ReactNode$/,
  /^ReactElement$/,
  /^JSX\.Element$/,
  /^Element$/,
  /^node$/i,
  /^element$/i,
  /^Ref</,
  /^MutableRefObject/,
  /^RefObject/,
  /^CSSProperties$/,
];

/**
 * Strip all layers of surrounding quotes from a value.
 * Handles: "value", 'value', "'value'", '"value"', etc.
 */
function stripQuotes(s: string): string {
  let result = s.trim();
  while (
    result.length >= 2 &&
    ((result[0] === '"' && result[result.length - 1] === '"') ||
      (result[0] === "'" && result[result.length - 1] === "'") ||
      (result[0] === "`" && result[result.length - 1] === "`"))
  ) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

/**
 * Extract the actual default value from Storybook's defaultValue field.
 * React-docgen returns { summary: "value", detail?: "..." } objects.
 * Some setups return the bare value directly.
 */
function resolveDefaultValue(raw: unknown): string | null {
  if (raw == null) return null;

  if (typeof raw === "string") return stripQuotes(raw);
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "number") return String(raw);

  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("summary" in obj && obj.summary != null) {
      return stripQuotes(String(obj.summary));
    }
    if ("value" in obj && obj.value != null) {
      return stripQuotes(String(obj.value));
    }
  }

  return null;
}

export function shouldSkipProp(prop: StorybookProp): boolean {
  if (SKIP_PROP_NAMES.has(prop.name)) return true;

  // Skip event handlers: onClick, onChange, onFocus, etc.
  if (prop.name.startsWith("on") && prop.name.length > 2 && prop.name[2] === prop.name[2].toUpperCase()) {
    return true;
  }

  // Skip accessibility and data attributes
  if (prop.name.startsWith("aria-") || prop.name.startsWith("data-")) {
    return true;
  }

  const typeName = prop.type.name;

  for (const pattern of CALLBACK_TYPE_PATTERNS) {
    if (pattern.test(typeName)) return true;
  }

  for (const pattern of NON_VISUAL_TYPE_PATTERNS) {
    if (pattern.test(typeName)) return true;
  }

  if (typeName === "string" || typeName === "number") {
    // Exception: if the prop has argType control with explicit options,
    // it's a constrained value — don't skip it. Let it fall through
    // to the argType extraction path.
    if (prop.control?.options && prop.control.options.length > 0) {
      return false;
    }
    return true;
  }

  return false;
}

export function mapBooleanProp(prop: StorybookProp): FigmaVariantProperty {
  const defaultVal = resolveDefaultValue(prop.defaultValue);
  return {
    name: prop.name,
    type: "BOOLEAN",
    values: ["true", "false"],
    defaultValue: defaultVal === "true" ? "true" : "false",
  };
}

/**
 * Check if a union member looks like a string literal value
 * (as opposed to a type name like ReactNode, HTMLElement, etc.)
 */
function isLiteralUnionMember(member: PropType): boolean {
  // Explicit literal type
  if (member.name === "literal") return true;

  // Has a raw value with quotes — it's a string literal
  if (member.raw && /^["'`]/.test(member.raw.trim())) return true;

  // Common non-literal type names to reject
  const nonLiteralPatterns = [
    /^React/, /^HTML/, /^SVG/, /^CSS/, /^Event/,
    /^Node$/, /^Element$/, /^Function$/,
    /^object$/i, /^any$/i, /^never$/i, /^void$/i, /^undefined$/i, /^null$/i,
    /^string$/i, /^number$/i, /^boolean$/i, /^symbol$/i, /^bigint$/i,
  ];
  for (const pattern of nonLiteralPatterns) {
    if (pattern.test(member.name)) return false;
  }

  // If name is short, lowercase, and looks like a value (not a type), accept it
  // e.g. "sm", "md", "lg", "primary", "destructive"
  if (member.name === member.name.toLowerCase() && member.name.length <= 30) {
    return true;
  }

  // If raw looks like a quoted value, accept
  if (member.raw) {
    const stripped = stripQuotes(member.raw);
    if (stripped !== member.raw) return true;
  }

  return false;
}

export function extractEnumValues(prop: StorybookProp): string[] | null {
  // Priority 1: argType control options (most reliable in real Storybooks)
  if (prop.control?.options && prop.control.options.length > 0) {
    return prop.control.options.map((v) => stripQuotes(String(v)));
  }

  const typeName = prop.type.name;

  // Priority 2: react-docgen enum type
  if (typeName === "enum" && Array.isArray(prop.type.value)) {
    return (prop.type.value as Array<string | { value: string }>)
      .map((v) => (typeof v === "string" ? v : v.value))
      .map(stripQuotes)
      .filter((v) => v.length > 0);
  }

  // Priority 3: react-docgen union type (with literal filtering)
  if (typeName === "union" && Array.isArray(prop.type.value)) {
    const values = (prop.type.value as PropType[])
      .filter(isLiteralUnionMember)
      .map((v) => stripQuotes(v.raw ?? v.name))
      .filter((v) => v.length > 0);

    if (values.length > 0) return values;
  }

  // Priority 4: parse raw type string as union of string literals
  if (prop.type.raw) {
    const raw = prop.type.raw.trim();
    // Match patterns like: "sm" | "md" | "lg" or 'sm' | 'md' | 'lg'
    const parts = raw.split("|").map((p) => p.trim());
    const allLiterals = parts.every((p) => /^["'`].*["'`]$/.test(p));
    if (allLiterals && parts.length > 0) {
      return parts.map(stripQuotes).filter((v) => v.length > 0);
    }
  }

  return null;
}

export function mapEnumProp(prop: StorybookProp, values: string[]): FigmaVariantProperty {
  const resolved = resolveDefaultValue(prop.defaultValue);
  const defaultVal = resolved != null && values.includes(resolved) ? resolved : values[0];

  return {
    name: prop.name,
    type: "VARIANT",
    values,
    defaultValue: defaultVal,
  };
}

export function mapPropToVariant(prop: StorybookProp): FigmaVariantProperty | null {
  if (shouldSkipProp(prop)) return null;

  // Check for boolean via type name OR argType control
  if (
    prop.type.name === "bool" ||
    prop.type.name === "boolean" ||
    prop.control?.type === "boolean"
  ) {
    return mapBooleanProp(prop);
  }

  const enumValues = extractEnumValues(prop);
  if (enumValues && enumValues.length > 0) {
    return mapEnumProp(prop, enumValues);
  }

  return null;
}

export function generateVariantCombinations(
  properties: FigmaVariantProperty[],
  maxCombinations: number = DEFAULT_MAX_COMBINATIONS
): { combinations: Record<string, string>[]; wasCapped: boolean } {
  if (properties.length === 0) return { combinations: [{}], wasCapped: false };

  // Estimate total combinations first to avoid unnecessary work
  let totalEstimate = 1;
  for (const prop of properties) {
    totalEstimate *= prop.values.length;
    if (totalEstimate > maxCombinations) break;
  }

  const wasCapped = totalEstimate > maxCombinations;

  const [first, ...rest] = properties;
  const { combinations: restCombinations } = generateVariantCombinations(rest, maxCombinations);

  const combinations: Record<string, string>[] = [];
  for (const value of first.values) {
    for (const restCombo of restCombinations) {
      combinations.push({ [first.name]: value, ...restCombo });
      if (combinations.length >= maxCombinations) {
        return { combinations, wasCapped: true };
      }
    }
  }

  return { combinations, wasCapped };
}

export function mapComponent(
  component: StorybookComponent,
  options?: MapperOptions
): FigmaComponentDefinition {
  const maxCombinations = options?.maxCombinations ?? DEFAULT_MAX_COMBINATIONS;
  const variantProperties: FigmaVariantProperty[] = [];

  for (const prop of component.props) {
    const variant = mapPropToVariant(prop);
    if (variant) {
      variantProperties.push(variant);
    }
  }

  const { combinations, wasCapped } = generateVariantCombinations(variantProperties, maxCombinations);

  return {
    name: component.name,
    variantProperties,
    variantCombinations: combinations,
    wasCapped,
  };
}
