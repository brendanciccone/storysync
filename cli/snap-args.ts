// Whether Storybook rendered a variant with the args snap asked for.
//
// snap sets each variant's values through the story URL's `?args=`, and
// Storybook drops a value it won't take there without failing the story:
//
//   - one the story's argTypes `options` don't list, with a console warning
//     ("Received illegal value for 'variant'");
//   - one for an arg the story's argTypes don't declare at all, silently;
//   - one an argTypes `if` hides for the combination, at render, silently;
//   - and the URL can't carry a value outside [a-zA-Z0-9 _-] at all, so
//     snap leaves it out of the URL.
//
// The story then renders its default, which snap would measure under the
// variant's name, Figma would copy, and verify would score as faithful. So
// after each story loads, snap reads from Storybook's preview which args
// the story actually received (snap-browser.ts), and this module works out
// which requested values it didn't, why, and what to tell the user.
//
// Everything here is pure, so it is tested without a browser.

import type { FigmaVariantProperty } from "./mapper.js";

/** Why Storybook didn't apply a value the story URL asked for. */
export type ArgRejectionReason =
  /**
   * The value, or the arg's name, has characters outside the URL's
   * [a-zA-Z0-9 _-], so snap left it out of the URL: `Nav/Primary`, say.
   */
  | "url-unsafe"
  /** The story's argTypes give `options` for the arg that don't list the value. */
  | "not-in-options"
  /** The story's argTypes have no entry for the arg, so the URL's value is dropped. */
  | "not-in-argtypes"
  /** The arg's argTypes `if` is false for the combination, so the story isn't given it. */
  | "hidden-by-if"
  /**
   * The value looks like a number, which Storybook's URL parser reads as
   * one, and the story's options list it only as a string, so no argTypes
   * change lets the URL carry it: cols "2", say.
   */
  | "number-in-url"
  /** None of the above explains it: the arg's type, say, which the value doesn't fit. */
  | "not-applied";

/** The order a rejection lists its reasons in. */
const REASON_ORDER: ArgRejectionReason[] = ["url-unsafe", "not-in-options", "not-in-argtypes", "number-in-url", "hidden-by-if", "not-applied"];

/** Reasons no change to the story fixes: the URL can't carry the value, and only the preview can set it. */
export const NO_STORY_FIX: ReadonlySet<ArgRejectionReason> = new Set(["url-unsafe", "number-in-url"]);

/** What Storybook's URL parser reads as a number rather than a string. */
const URL_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;

export interface ArgRejection {
  name: string;
  value: string;
  /** Every reason that applies, in the order above: a value can be both unlisted and hidden. */
  reasons: ArgRejectionReason[];
  /** The story's options for the arg, for `not-in-options`. */
  options?: unknown[];
  /** The arg's argTypes `if`, for `hidden-by-if`. */
  condition?: Record<string, unknown>;
}

/** One of the story's argTypes, as snap records it: what a later step can use. */
export interface StoryArgType {
  /** Storybook's type name, such as `enum`, `boolean` or `string`. */
  type?: string;
  /** The control's type, such as `select` or `boolean`, or `false` when the story disables it. */
  control?: string | false;
  options?: unknown[];
  if?: Record<string, unknown>;
  /** Whether the argType maps option keys to other values. */
  mapping?: true;
  /** Set when the story hides it from the docs table (`table: { disable: true }`). */
  hidden?: true;
  /** Its docs table category (`table.category`), such as `events`. */
  category?: string;
  /** Set when the argType has an action (`action: "clicked"`), which marks an event. */
  action?: true;
  /** The value the story's own args give it, before any snap asks for: a string, number, boolean or null. */
  initial?: string | number | boolean | null;
}

/** What the page read from Storybook's preview about the story it rendered. */
export interface StoryArgsSnapshot {
  /** The story's file, from its `parameters.fileName`. */
  fileName: string | null;
  argTypes: Record<string, StoryArgType>;
  /** The args Storybook's store holds for the story. */
  stored: Record<string, unknown>;
  /**
   * The args the story is given, after argTypes `if` conditions, each by its
   * value before any `mapping`. Values that are not strings, numbers,
   * booleans or null are recorded as `{ "$type": ... }`.
   */
  rendered: Record<string, unknown>;
  globals: Record<string, unknown>;
  /**
   * Each argType's `mapping`, from option key to the value the story is
   * given, recorded as `rendered` is: Storybook judges an `if` on mapped
   * values. Absent from a snapshot that has none.
   */
  mappings?: Record<string, Record<string, unknown>>;
}

/** What became of one variant's requested args. */
export interface StoryArgsCheck {
  /** Whether Storybook's preview could be read, so what the story was given is known. */
  checked: boolean;
  /** Requested values the story URL didn't apply, and why. */
  rejected: ArgRejection[];
  /**
   * `preview` when snap then applied `rejected` through Storybook's preview,
   * and the story was given every one of them.
   */
  appliedVia?: "preview";
  /** Of `rejected`, the values the story still wasn't given. */
  unapplied: ArgRejection[];
  /** Why the preview couldn't be read, or why applying through it failed. */
  error?: string;
  argTypes?: Record<string, StoryArgType>;
  storyFile?: string;
}

const PRIMITIVE = new Set(["string", "number", "boolean"]);

/** Whether `value`, as the page recorded it, is the string snap asked for. */
export function argMatches(value: unknown, requested: string): boolean {
  return (value === null || PRIMITIVE.has(typeof value)) && String(value) === requested;
}

/**
 * A requested value as the story's Controls would give it: a boolean for a
 * boolean prop or argType; the story's own option, as typed, when its
 * options list the value, since Storybook types the options it infers from
 * the docs' literals, `2` a number and `"2"` a string; a number for a number
 * argType, or one whose options are all numbers; else the string.
 */
export function typedArgValue(value: string, argType: StoryArgType | undefined, property?: FigmaVariantProperty): unknown {
  if (property?.type === "BOOLEAN" || argType?.type === "boolean") return value === "true";
  const options = argType?.options ?? [];
  const option = options.find((o) => argMatches(o, value));
  if (option !== undefined) return option;
  const numeric = value.trim() !== "" && Number.isFinite(Number(value));
  if (numeric && (argType?.type === "number" || (options.length > 0 && options.every((o) => typeof o === "number")))) return Number(value);
  return value;
}

/** Storybook's equality for an argTypes `if`: values are JSON, so compared as JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A value the page recorded by its type alone, as `{ "$type": "object" }`. */
function isOpaque(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "$type");
}

/** `args` as the story is given them, each through its argType's mapping, as Storybook's prepareContext maps them. */
export function mapArgs(args: Record<string, unknown>, mappings: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    const mapping = mappings[name];
    const key = value === null || PRIMITIVE.has(typeof value) ? String(value) : null;
    out[name] = mapping && key !== null && Object.hasOwn(mapping, key) ? mapping[key] : value;
  }
  return out;
}

/**
 * Whether an argTypes `if` shows its arg, as Storybook's own
 * includeConditionalArg decides it: `{ arg | global, truthy | exists | eq | neq }`.
 * Null for a condition Storybook itself would reject.
 */
export function conditionHolds(
  condition: Record<string, unknown>,
  args: Record<string, unknown>,
  globals: Record<string, unknown>,
): boolean | null {
  const defined = (values: unknown[]) => values.filter((v) => v !== undefined).length;
  const { arg, global, truthy, exists, eq, neq } = condition;
  if (defined([arg, global]) !== 1 || defined([truthy, exists, eq, neq]) > 1) return null;
  const value = typeof arg === "string" ? args[arg] : typeof global === "string" ? globals[global] : undefined;
  // A value known only by its type can't be compared with an object; with
  // anything else it is unequal, as Storybook's own comparison finds.
  const compared = eq !== undefined ? eq : neq;
  if (isOpaque(value) && typeof compared === "object" && compared !== null) return null;
  if (eq !== undefined) return sameValue(value, eq);
  if (neq !== undefined) return !sameValue(value, neq);
  if (exists !== undefined) return exists ? value !== undefined : value === undefined;
  return (truthy === undefined ? true : !!truthy) ? !!value : !value;
}

/**
 * Whether the component draws `value` with its prop left unset, as far as
 * its property says: the value standing for it unset, or a boolean's false
 * where the docs default it to false. A default only assumed says nothing.
 */
function drawnUnset(property: FigmaVariantProperty | undefined, value: string): boolean {
  if (!property) return false;
  if (property.unset !== undefined) return property.unset === value;
  return property.type === "BOOLEAN" && value === "false" && property.defaultValue === "false" && !property.defaultAssumed;
}

/**
 * The requested values the story wasn't given, each with every reason that
 * explains it. `requested` is snap's combination; `properties` give each
 * prop's type, so a boolean is compared as one; `notInUrl` names the args
 * snap left out of the URL, as it can't carry their values.
 */
export function findRejectedArgs(
  requested: Record<string, string>,
  snapshot: StoryArgsSnapshot,
  properties: readonly FigmaVariantProperty[] = [],
  notInUrl: readonly string[] = [],
): ArgRejection[] {
  const byName = new Map(properties.map((p) => [p.name, p]));
  // The combination as Storybook would hold it, over what it holds now, for
  // judging each `if` against the args the variant asks for.
  const asked: Record<string, unknown> = { ...snapshot.stored };
  for (const [name, value] of Object.entries(requested)) asked[name] = typedArgValue(value, snapshot.argTypes[name], byName.get(name));
  // Storybook judges each `if` on the values the story is given, after mapping.
  const mapped = mapArgs(asked, snapshot.mappings);

  const rejected: ArgRejection[] = [];
  for (const [name, value] of Object.entries(requested)) {
    const argType = snapshot.argTypes[name];
    // Judged on the combination asked for: a value the story is given now,
    // while another it rejected is missing, may be hidden once that one is
    // applied, as size is for variant=link.
    const hidden = !!argType?.if && conditionHolds(argType.if, mapped, snapshot.globals) === false;
    if (!hidden && Object.hasOwn(snapshot.rendered, name) && argMatches(snapshot.rendered[name], value)) continue;
    // Not given at all, so the component draws the value it takes for the
    // prop left unset: where that is the value asked for, as coder's
    // Button's `disabled` false, nothing was refused that would change it.
    if (!hidden && !Object.hasOwn(snapshot.rendered, name) && !Object.hasOwn(snapshot.stored, name) && drawnUnset(byName.get(name), value)) continue;
    const rejection: ArgRejection = { name, value, reasons: [] };
    if (notInUrl.includes(name)) {
      // Never sent, so nothing the URL would have done to it applies.
      rejection.reasons.push("url-unsafe");
    } else if (!argType) {
      rejection.reasons.push("not-in-argtypes");
    } else if (Array.isArray(argType.options) && !argType.options.some((option) => argMatches(option, value))) {
      rejection.reasons.push("not-in-options");
      rejection.options = argType.options;
    } else if (
      Array.isArray(argType.options) && URL_NUMBER.test(value) && !argType.mapping && argType.type !== "string" &&
      argType.options.includes(value) && !argType.options.includes(Number(value))
    ) {
      // Storybook's URL gave the number, which the options don't list, and
      // dropped it; an argType of type string would have turned it back.
      rejection.reasons.push("number-in-url");
      rejection.options = argType.options;
    }
    const stored = Object.hasOwn(snapshot.stored, name) && argMatches(snapshot.stored[name], value);
    if (argType?.if && (hidden || stored)) {
      rejection.reasons.push("hidden-by-if");
      rejection.condition = argType.if;
    }
    if (!rejection.reasons.length) rejection.reasons.push("not-applied");
    rejection.reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
    rejected.push(rejection);
  }
  return rejected;
}

/**
 * The arg snap sets to true through Storybook's preview to open an overlay
 * the story renders closed: `open`, else `defaultOpen`, where the story's
 * argTypes or the component's documented props (`props`, by name) have
 * it, and an argType gives it no type but boolean. Null where neither has
 * one, and snap opens the overlay through its trigger instead. Neither is
 * ever a variant property: what an overlay's state is, not how it looks.
 */
export function openArg(argTypes: Record<string, StoryArgType> | undefined, props: readonly string[] = []): "open" | "defaultOpen" | null {
  for (const name of ["open", "defaultOpen"] as const) {
    const argType = argTypes?.[name];
    if (argType && argType.type !== undefined && argType.type !== "boolean") continue;
    if (argType || props.includes(name)) return name;
  }
  return null;
}

/**
 * What snap sends through Storybook's preview to apply `rejected`: each
 * value as Storybook holds it, and the args whose `if` to lift so the story
 * is given them.
 */
export function previewArgUpdate(
  rejected: readonly ArgRejection[],
  snapshot: StoryArgsSnapshot,
  properties: readonly FigmaVariantProperty[] = [],
): { updates: Record<string, unknown>; lift: string[] } {
  const byName = new Map(properties.map((p) => [p.name, p]));
  const updates: Record<string, unknown> = {};
  const lift: string[] = [];
  for (const { name, value, reasons } of rejected) {
    updates[name] = typedArgValue(value, snapshot.argTypes[name], byName.get(name));
    if (reasons.includes("hidden-by-if")) lift.push(name);
  }
  return { updates, lift };
}

/**
 * Requested values the story still isn't given, from a snapshot read after
 * applying `rejected`: each of those that remains, and any other requested
 * value the story has lost since, as not applied.
 */
export function stillRejected(
  requested: Record<string, string>,
  rejected: readonly ArgRejection[],
  after: StoryArgsSnapshot,
): ArgRejection[] {
  const remaining: ArgRejection[] = [];
  for (const [name, value] of Object.entries(requested)) {
    if (Object.hasOwn(after.rendered, name) && argMatches(after.rendered[name], value)) continue;
    remaining.push(rejected.find((r) => r.name === name) ?? { name, value, reasons: ["not-applied"] });
  }
  return remaining;
}

/**
 * Storybook's console warning for a URL value outside an arg's options,
 * read when its preview can't be: the arg's name and the options listed.
 */
export function parseIllegalValueWarning(text: string): { name: string; options: string[] } | null {
  const match = /Received illegal value for '([^'[\]]+)(?:\[\d+\])?'\. Supported options: (.*)$/s.exec(text);
  if (!match) return null;
  const options = [...match[2].matchAll(/'((?:[^'\\]|\\.)*)'|([^,\s][^,]*)/g)].map((m) => (m[1] ?? m[2]).trim());
  return { name: match[1], options };
}

/** Rejections from Storybook's console warnings alone, for a preview that can't be read. */
export function rejectionsFromWarnings(requested: Record<string, string>, warnings: readonly string[]): ArgRejection[] {
  const rejected: ArgRejection[] = [];
  for (const warning of warnings) {
    const parsed = parseIllegalValueWarning(warning);
    if (!parsed || !Object.hasOwn(requested, parsed.name) || rejected.some((r) => r.name === parsed.name)) continue;
    rejected.push({ name: parsed.name, value: requested[parsed.name], reasons: ["not-in-options"], options: parsed.options });
  }
  return rejected;
}

/** Compacts a page-read argType to what snap records, dropping what's absent. */
export function compactArgTypes(raw: Record<string, StoryArgType>): Record<string, StoryArgType> {
  const out: Record<string, StoryArgType> = {};
  for (const name of Object.keys(raw).sort()) {
    const t = raw[name];
    const entry: StoryArgType = {};
    if (typeof t.type === "string") entry.type = t.type;
    if (typeof t.control === "string" || t.control === false) entry.control = t.control;
    if (Array.isArray(t.options)) entry.options = t.options;
    if (t.if && typeof t.if === "object") entry.if = t.if;
    if (t.mapping) entry.mapping = true;
    if (t.hidden) entry.hidden = true;
    if (typeof t.category === "string" && t.category) entry.category = t.category;
    if (t.action) entry.action = true;
    if (t.initial === null || ["string", "number", "boolean"].includes(typeof t.initial)) entry.initial = t.initial;
    out[name] = entry;
  }
  return out;
}

/** Controls that pick among values, as a Figma variant property does. */
const CHOICE_CONTROLS = new Set(["select", "radio", "inline-radio", "check", "inline-check", "multi-select", "boolean"]);

/**
 * Args the story declares as a choice (with options, or a boolean or
 * select-like control) that Storybook's docs don't list among the
 * component's props, so map never makes a variant property of them: such
 * as shadcn/ui Button's `disabled`.
 */
export function argsNotInDocs(argTypes: Record<string, StoryArgType>, documented: readonly string[]): string[] {
  const docs = new Set(documented);
  return Object.entries(argTypes)
    .filter(([name, t]) => !docs.has(name) && t.control !== false &&
      (Array.isArray(t.options) || t.type === "boolean" || (typeof t.control === "string" && CHOICE_CONTROLS.has(t.control))))
    .map(([name]) => name)
    .sort();
}

// --- Warnings -----------------------------------------------------------------

/** What a variant records about its args, as snap.ts writes it. */
export interface VariantArgs {
  combination: Record<string, string>;
  status: string;
  rejectedArgs?: ArgRejection[];
  appliedVia?: "preview";
}

const quoteList = (values: readonly unknown[]) => values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ");

/**
 * The one-line story change that lets Storybook take every value of one arg
 * that it rejected for one reason, in `file` when it is known; null for a
 * reason no story change fixes.
 */
function storyFix(name: string, reason: ArgRejectionReason, values: string[], group: ArgRejection, file: string, boolean: boolean): string | null {
  switch (reason) {
    case "not-in-options":
      return `add ${quoteList(values)} to argTypes.${name}.options${file}`;
    case "not-in-argtypes":
      // Storybook's URL gives a boolean as `!true`, which options of the
      // strings 'true' and 'false' would refuse in turn.
      return boolean
        ? `declare ${name} in the story's argTypes as a boolean, \`${name}: { control: "boolean" }\`${file}`
        : `declare ${name} in the story's argTypes, with options ${quoteList(values)}${file}`;
    case "hidden-by-if":
      return `remove \`if: ${JSON.stringify(group.condition)}\` from argTypes.${name}${file}`;
    case "not-applied":
      return `check that argTypes.${name} takes ${quoteList(values)}${file}`;
    case "url-unsafe":
    case "number-in-url":
      return null;
  }
}

function reasonText(reason: ArgRejectionReason, group: ArgRejection): string {
  switch (reason) {
    case "not-in-options":
      return `the story's argTypes options for it are ${quoteList(group.options ?? [])}`;
    case "not-in-argtypes":
      return "the story's argTypes don't declare it, so Storybook drops it from the URL";
    case "hidden-by-if":
      return `its argTypes \`if: ${JSON.stringify(group.condition)}\` hides it for these combinations`;
    case "not-applied":
      return "Storybook didn't give it to the story, for no reason snap could read";
    case "number-in-url":
      return "Storybook's URL reads it as a number, and the story's options list it only as a string, so no argTypes change lets the URL carry it";
    case "url-unsafe":
      return "Storybook's URL can't carry it, as it has characters outside [a-zA-Z0-9 _-]";
  }
}

/**
 * Warnings for a component some of whose requested values Storybook didn't
 * apply from the story URL: one for the values snap then set through
 * Storybook's preview, and one for those it couldn't, each naming the
 * values, why, and the story change that would let the URL take them. A
 * value no story change would let the URL carry, and that the preview set,
 * is left out: there is nothing to tell the user to do.
 */
export function describeArgRejections(
  label: string,
  variants: readonly VariantArgs[],
  options: { storyFile?: string | null; id?: string; properties?: readonly FigmaVariantProperty[] } = {},
): string[] {
  const file = options.storyFile ? ` in ${options.storyFile}` : "";
  const booleans = new Set((options.properties ?? []).filter((p) => p.type === "BOOLEAN").map((p) => p.name));
  const fixable = (reason: ArgRejectionReason) => !NO_STORY_FIX.has(reason);
  const describe = (picked: readonly VariantArgs[], reasons: (reason: ArgRejectionReason) => boolean) => {
    // By arg and reason, in the order first met: name -> reason -> values.
    const groups = new Map<string, Map<ArgRejectionReason, { values: string[]; first: ArgRejection }>>();
    for (const variant of picked) {
      for (const rejection of variant.rejectedArgs ?? []) {
        for (const reason of rejection.reasons.filter(reasons)) {
          const byReason = groups.get(rejection.name) ?? new Map();
          groups.set(rejection.name, byReason);
          const group = byReason.get(reason) ?? { values: [], first: rejection };
          if (!group.values.includes(rejection.value)) group.values.push(rejection.value);
          byReason.set(reason, group);
        }
      }
    }
    const causes: string[] = [];
    const fixes: string[] = [];
    for (const [name, byReason] of groups) {
      for (const [reason, { values, first }] of byReason) {
        causes.push(`\`${name}\` ${values.join(", ")}: ${reasonText(reason, first)}`);
        const fix = storyFix(name, reason, values, first, file, booleans.has(name));
        if (fix) fixes.push(fix);
      }
    }
    return { causes, fixes };
  };

  const warnings: string[] = [];
  // Values set through the preview, whatever became of the variant after:
  // a story change would have let the URL take them either way.
  const viaPreview = variants.filter((v) =>
    v.appliedVia === "preview" && v.status !== "arg_rejected" && v.rejectedArgs?.some((r) => r.reasons.some(fixable)));
  if (viaPreview.length) {
    const { causes, fixes } = describe(viaPreview, fixable);
    const one = viaPreview.length === 1;
    const failed = viaPreview.filter((v) => v.status !== "ok").length;
    const outcome = failed === 0
      ? "measured what the component renders with them, so the measurements are right"
      : failed === viaPreview.length
        ? `then ${one ? "that variant failed, as its error says" : "those variants failed, as their errors say"}`
        : `measured what the component renders with them, though ${failed} of those variants then failed, as their errors say`;
    warnings.push(
      `Storybook wouldn't take some of ${label}'s values from the story URL, and would have rendered ${one ? "that variant" : `those ${viaPreview.length} variants`} without them, as its default: ` +
        `${causes.join("; ")}. snap set them through Storybook's preview instead and ${outcome}. ` +
        `To let the story take them as well, ${fixes.join("; and ")}.`,
    );
  }
  const refused = variants.filter((v) => v.status === "arg_rejected");
  if (refused.length) {
    const { causes, fixes } = describe(refused, () => true);
    const one = refused.length === 1;
    const again = options.id ? `--components ${options.id} --merge` : "--components and --merge";
    const how = fixes.length
      ? `To measure ${one ? "it" : "them"}, ${fixes.join("; and ")}, then measure the component again with ${again}.`
      : `No change to the story lets its URL carry ${one ? "it" : "them"}, and ${one ? "the variant's error says" : "each variant's error says"} why the preview didn't take ${one ? "it" : "them"} either.`;
    warnings.push(
      `Storybook wouldn't render ${refused.length} of ${label}'s variants with the values asked for, and snap couldn't set them through its preview either, ` +
        `so ${one ? "it was" : "they were"} not measured (status arg_rejected): ${causes.join("; ")}. ${how}`,
    );
  }
  return warnings;
}

/** How many slugs a warning names before saying how many more there are. */
const SLUGS_NAMED = 5;

/** `slugs` as a warning names them: the first few, then how many more. */
export function nameSlugs(slugs: readonly string[]): string {
  const named = slugs.slice(0, SLUGS_NAMED).join(", ");
  return slugs.length > SLUGS_NAMED ? `${named} and ${slugs.length - SLUGS_NAMED} more` : named;
}

/**
 * Warning for a component some of whose variants' args couldn't be checked:
 * `slugs` are those variants, of `measured` captured. They were measured,
 * and are marked `argsChecked: false`, since a value Storybook didn't take
 * leaves its default on screen under the variant's name.
 */
export function describeUncheckedArgs(
  label: string,
  slugs: readonly string[],
  measured: number,
  options: { error?: string; id?: string } = {},
): string | null {
  if (!slugs.length) return null;
  const which = slugs.length < measured ? `${slugs.length} of ${measured} variants (${nameSlugs(slugs)})` : "its variants";
  const again = options.id ? `--components ${options.id} --merge` : "--components and --merge";
  return (
    `snap couldn't read Storybook's preview to confirm that ${label}'s story was given the values asked for, for ${which}` +
    `${options.error ? ` (${options.error})` : ""}. A value the story's argTypes don't allow would have rendered as its default, ` +
    `and been measured under that variant's name, so ${slugs.length === 1 ? "that variant is" : "those variants are"} marked argsChecked: false, ` +
    `which fails --strict and which verify names beside its score. Measure the component again with ${again}.`
  );
}
