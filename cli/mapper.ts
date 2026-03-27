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
}

export interface PropType {
  name: string;
  value?: string[] | PropType[];
  raw?: string;
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

export function shouldSkipProp(prop: StorybookProp): boolean {
  if (SKIP_PROP_NAMES.has(prop.name)) return true;

  if (prop.name.startsWith("on") && prop.name.length > 2 && prop.name[2] === prop.name[2].toUpperCase()) {
    return true;
  }

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
    return true;
  }

  return false;
}

export function mapBooleanProp(prop: StorybookProp): FigmaVariantProperty {
  return {
    name: prop.name,
    type: "BOOLEAN",
    values: ["true", "false"],
    defaultValue: prop.defaultValue === true ? "true" : "false",
  };
}

export function extractEnumValues(prop: StorybookProp): string[] | null {
  const typeName = prop.type.name;

  if (typeName === "enum" && Array.isArray(prop.type.value)) {
    return (prop.type.value as string[])
      .map((v) => (typeof v === "string" ? v : (v as unknown as { value: string }).value))
      .map((v) => v.replace(/^["']|["']$/g, ""));
  }

  if (typeName === "union" && Array.isArray(prop.type.value)) {
    const values = (prop.type.value as PropType[])
      .filter((v) => v.name === "literal" || typeof v.name === "string")
      .map((v) => (v.raw ?? v.name).replace(/^["']|["']$/g, ""));

    if (values.length > 0) return values;
  }

  if (prop.type.raw) {
    const unionMatch = prop.type.raw.match(/^["']([^"']+)["'](\s*\|\s*["']([^"']+)["'])+$/);
    if (unionMatch) {
      return prop.type.raw
        .split("|")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""));
    }
  }

  return null;
}

export function mapEnumProp(prop: StorybookProp, values: string[]): FigmaVariantProperty {
  const defaultVal =
    prop.defaultValue != null
      ? String(prop.defaultValue).replace(/^["']|["']$/g, "")
      : values[0];

  return {
    name: prop.name,
    type: "VARIANT",
    values,
    defaultValue: defaultVal,
  };
}

export function mapPropToVariant(prop: StorybookProp): FigmaVariantProperty | null {
  if (shouldSkipProp(prop)) return null;

  if (prop.type.name === "bool" || prop.type.name === "boolean") {
    return mapBooleanProp(prop);
  }

  const enumValues = extractEnumValues(prop);
  if (enumValues && enumValues.length > 0) {
    return mapEnumProp(prop, enumValues);
  }

  return null;
}

export function generateVariantCombinations(
  properties: FigmaVariantProperty[]
): Record<string, string>[] {
  if (properties.length === 0) return [{}];

  const [first, ...rest] = properties;
  const restCombinations = generateVariantCombinations(rest);

  const combinations: Record<string, string>[] = [];
  for (const value of first.values) {
    for (const restCombo of restCombinations) {
      combinations.push({ [first.name]: value, ...restCombo });
    }
  }

  return combinations;
}

export function mapComponent(component: StorybookComponent): FigmaComponentDefinition {
  const variantProperties: FigmaVariantProperty[] = [];

  for (const prop of component.props) {
    const variant = mapPropToVariant(prop);
    if (variant) {
      variantProperties.push(variant);
    }
  }

  const variantCombinations = generateVariantCombinations(variantProperties);

  return {
    name: component.name,
    variantProperties,
    variantCombinations,
  };
}
