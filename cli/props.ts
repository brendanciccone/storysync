// Which of a component's props become Figma variant properties: one source
// for map, inspect, diff, snap and the Action (which runs map).
//
// Storybook's docs list a component's props. The story's argTypes, which
// only Storybook's preview holds, add to them: values the docs' types don't
// list (supplementOptions), props the docs don't list at all (shadcn/ui
// Button's `disabled`, Sheet's `side`), and marks of props that only change
// behavior (`control: false`, a hidden table row, an event). Where neither
// lists a prop, the stories' own args can: coder's Button takes `variant`
// and `size` from cva's VariantProps, which docgen doesn't list, and its
// stories set them (Outline, DefaultSmall). snap reads the argTypes and the
// stories' args in the browser and records them in styles.json, with each
// prop it left out and why, so the commands that don't start a browser read
// them from there.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapProp, supplementOptions } from "./mapper.js";
import type { StorybookComponent, StorybookProp } from "./mapper.js";
import { argsNotInDocs } from "./snap-args.js";
import type { StoryArgType } from "./snap-args.js";
import type { StoryOwn } from "./snap-stories.js";

/** Why a prop that would be a variant property is left out. */
export type ExclusionReason =
  /** `--exclude-props` names it. */
  | "excluded"
  /** The story's argTypes give it `control: false`. */
  | "no-control"
  /** The story's argTypes hide it from the docs table (`table: { disable: true }`). */
  | "hidden"
  /** The story's argTypes file it under events, or give it an action. */
  | "event"
  /** snap measured every value of it the same: it changes only behavior, or the story drops it. */
  | "no-op"
  /**
   * A value of it opens what the component shows, which renders only while
   * open: snap gives the story that value for every variant (`value`) and
   * measures what opened, as Drawer's `open`.
   */
  | "opens";

export interface PropExclusion {
  name: string;
  reason: ExclusionReason;
  /** For `opens`: the value snap gives the story for every variant. */
  value?: string;
  /** For `no-op`: whether the markup changed with its values, so the args reached the component. */
  markup?: "changed" | "same";
}

export interface PropSourceOptions {
  /**
   * The story's argTypes, as snap records them; absent when they weren't
   * seen (no snap, or the snap doesn't have the component).
   */
  argTypes?: Record<string, StoryArgType>;
  /** `--exclude-props`: names left out of every component, ignoring case. */
  exclude?: readonly string[];
  /** `--keep-props`: names never left out automatically, ignoring case. */
  keep?: readonly string[];
  /** What snap left out from what it measured (`no-op`, `opens`), as styles.json records it. */
  measured?: readonly PropExclusion[];
  /**
   * The component's stories' own args, and the story it is measured from,
   * whose args give a default: absent when they weren't read.
   */
  stories?: { own: readonly StoryOwn[]; storyId?: string | null };
}

export interface PropSource {
  /** The component with the props to map: the docs', the argTypes' additions, less what is left out. */
  component: StorybookComponent;
  /** Each prop left out that would otherwise be a variant property, and why, in prop order. */
  excluded: PropExclusion[];
  /** Props the story's argTypes declare that the docs don't list, added. */
  added: string[];
  /** Props only the stories' own args name, added (storyArgProps). */
  fromStories: string[];
  /** Every prop, the docs' and the added, before any was left out. */
  all: StorybookProp[];
  /** Whether the story's argTypes were seen. */
  argTypes: boolean;
}

/** The names --exclude-props and --keep-props give, lowercased, refusing a name in both. */
export function checkPropFlags(exclude: readonly string[], keep: readonly string[]): void {
  const kept = new Set(keep.map((n) => n.toLowerCase()));
  const both = exclude.filter((n) => kept.has(n.toLowerCase()));
  if (both.length) {
    throw new Error(`--exclude-props and --keep-props both name ${both.map((n) => `"${n}"`).join(", ")}: leave ${both.length === 1 ? "it" : "them"} in one of them`);
  }
}

/** Values an argType's options or initial arg can give a variant property. */
const PRIMITIVE = new Set(["string", "number", "boolean"]);

/**
 * A prop the story's argTypes declare as a choice, as the docs would list
 * it: a boolean, or the options as its values, with the story's own arg as
 * its default. Null for anything else.
 */
export function argTypeProp(name: string, argType: StoryArgType): StorybookProp | null {
  const initial = argType.initial !== undefined && argType.initial !== null && PRIMITIVE.has(typeof argType.initial) ? String(argType.initial) : undefined;
  if (argType.type === "boolean" || argType.control === "boolean") {
    return { name, type: { name: "boolean" }, ...(initial !== undefined ? { defaultValue: initial } : {}) };
  }
  const options = (argType.options ?? []).filter((o) => PRIMITIVE.has(typeof o)).map((o) => String(o));
  if (!options.length) return null;
  return {
    name,
    type: { name: "enum" },
    control: { ...(typeof argType.control === "string" ? { type: argType.control } : {}), options: [...new Set(options)] },
    ...(initial !== undefined ? { defaultValue: initial } : {}),
  };
}

/** Args a story's own args set that name content or behavior, never a look of the component's. */
const NOT_A_LOOK = new Set([
  "open", "defaultOpen", "placeholder", "title", "label", "alt", "href", "src", "value", "defaultValue", "name", "id",
  "description", "text", "content", "htmlFor", "autoComplete", "role", "tabIndex", "type", "form", "target", "rel",
]);

/** A value a story's args can give a variant property: a short lowercase word, as cva's `outline` or `icon-lg`. */
const STORY_VALUE = /^[a-z0-9][A-Za-z0-9_-]{0,31}$/;

/** The value that stands for a prop left unset, where no story names the component's default. */
export const UNSET_VALUE = "default";

/**
 * Props the stories' own args set that `known` doesn't name, as the docs
 * would list them: coder's Button's `variant` and `size`, which come from
 * cva's VariantProps, so docgen lists neither, and no argType declares
 * them. A prop is one where every story that sets it gives a boolean, or
 * every one a short lowercase word (`outline`, `sm`): never content, a
 * handler, or an overlay's open state. Its values are those the stories
 * give, its default the value the component's story (`storyId`) gives it,
 * else `initial` (the story's argTypes), else, for a boolean, false. A
 * word no story gives as the default is the component's own, which none
 * names: `default` then stands for the prop left unset (`unset`), which
 * snap measures by leaving the arg out, unless a story names `default`,
 * which is then the default, a guess.
 */
export function storyArgProps(
  stories: readonly StoryOwn[],
  known: (name: string) => boolean,
  storyId?: string | null,
  initial: (name: string) => unknown = () => undefined,
): StorybookProp[] {
  const found = new Map<string, { words: string[]; bools: boolean[]; other: boolean }>();
  for (const story of stories) {
    for (const [name, value] of Object.entries(story.args)) {
      if (known(name) || NOT_A_LOOK.has(name) || /^on[A-Z]/.test(name) || /^(aria|data)-/.test(name)) continue;
      if (value === null || value === undefined) continue;
      const entry = found.get(name) ?? { words: [], bools: [], other: false };
      found.set(name, entry);
      if (typeof value === "boolean") {
        if (!entry.bools.includes(value)) entry.bools.push(value);
      } else if (typeof value === "string" && STORY_VALUE.test(value)) {
        if (!entry.words.includes(value)) entry.words.push(value);
      } else entry.other = true;
    }
  }
  const own = stories.find((s) => s.id === storyId)?.args ?? {};
  const props: StorybookProp[] = [];
  for (const [name, { words, bools, other }] of found) {
    if (other || (words.length && bools.length)) continue;
    const given = Object.hasOwn(own, name) ? own[name] : initial(name);
    // Only a prop some story gives another value than its default: one
    // every story leaves at it shows no other look.
    if (bools.length) {
      if (bools.some((b) => b !== (given === true))) props.push({ name, type: { name: "boolean" }, defaultValue: given === true ? "true" : "false" });
      continue;
    }
    const value = typeof given === "string" && STORY_VALUE.test(given) ? given : null;
    if (value !== null) {
      if (!words.some((w) => w !== value)) continue;
      props.push({ name, type: { name: "enum" }, control: { options: [value, ...words.filter((w) => w !== value)] }, defaultValue: value });
    } else if (words.includes(UNSET_VALUE)) {
      // A guess, which mapProp marks defaultAssumed.
      if (words.length > 1) props.push({ name, type: { name: "enum" }, control: { options: words } });
    } else {
      props.push({ name, type: { name: "enum" }, control: { options: [UNSET_VALUE, ...words] }, defaultValue: UNSET_VALUE, unset: UNSET_VALUE });
    }
  }
  return props;
}

/** Why the story's argTypes mark a prop as one that changes no look, or null. */
export function argTypeExclusion(argType: StoryArgType | undefined): ExclusionReason | null {
  if (!argType) return null;
  if (argType.control === false) return "no-control";
  if (argType.hidden) return "hidden";
  if (argType.action || (argType.category && /^events?$/i.test(argType.category.trim()))) return "event";
  return null;
}

/**
 * The props of `component` to map, from its docs, the story's argTypes
 * where they were seen, and what is left out: `--exclude-props`, then,
 * unless `--keep-props` names it, what the argTypes mark as behavior and
 * what snap measured as such. Only a prop that would be a variant property
 * is listed as left out.
 */
export function resolveProps(component: StorybookComponent, options: PropSourceOptions = {}): PropSource {
  const { argTypes } = options;
  let base = component;
  const added: string[] = [];
  if (argTypes) {
    base = supplementOptions(component, argTypes);
    const extra: StorybookProp[] = [];
    for (const name of argsNotInDocs(argTypes, component.props.map((p) => p.name))) {
      const prop = argTypeProp(name, argTypes[name]);
      if (prop && mapProp(prop)) {
        extra.push(prop);
        added.push(name);
      }
    }
    if (extra.length) base = { ...base, props: [...base.props, ...extra] };
  }
  const fromStories: string[] = [];
  if (options.stories?.own.length) {
    const listed = new Set(base.props.map((p) => p.name));
    const extra = storyArgProps(options.stories.own, (name) => listed.has(name), options.stories.storyId, (name) => argTypes?.[name]?.initial)
      .filter((prop) => mapProp(prop));
    if (extra.length) {
      base = { ...base, props: [...base.props, ...extra] };
      fromStories.push(...extra.map((p) => p.name));
    }
  }

  const exclude = new Set((options.exclude ?? []).map((n) => n.toLowerCase()));
  const keep = new Set((options.keep ?? []).map((n) => n.toLowerCase()));
  const measured = new Map((options.measured ?? []).map((e) => [e.name.toLowerCase(), e]));
  const excluded: PropExclusion[] = [];
  const props = base.props.filter((prop) => {
    const key = prop.name.toLowerCase();
    if (exclude.has(key)) {
      if (mapProp(prop)) excluded.push({ name: prop.name, reason: "excluded" });
      return false;
    }
    if (keep.has(key) || !mapProp(prop)) return true;
    const marked = argTypeExclusion(argTypes?.[prop.name]);
    if (marked) {
      excluded.push({ name: prop.name, reason: marked });
      return false;
    }
    const found = measured.get(key);
    if (found) {
      excluded.push({ ...found, name: prop.name });
      return false;
    }
    return true;
  });
  return { component: props.length === base.props.length ? base : { ...base, props }, excluded, added, fromStories, all: base.props, argTypes: !!argTypes };
}

/** `name1, name2` as a sentence names them, each in backticks. */
function ticked(names: readonly string[]): string {
  const list = names.map((n) => `\`${n}\``);
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list.join("");
}

/** Why one prop was left out, as inspect says it. */
export function exclusionReason(exclusion: PropExclusion): string {
  switch (exclusion.reason) {
    case "opens":
      return `${exclusion.name}=${exclusion.value} opens what it shows, so snap measures every variant with it`;
    case "no-op":
      return exclusion.markup === "same"
        // Not a word of the component's markup changed, as when the story
        // never hands the arg on (shadcn's Item story drops `variant`):
        // that and its fix first, as a prop that changes only behavior,
        // such as cmdk's `loop`, is rightly left out as it is.
        ? "every value measured the same, markup included, as when the story drops the arg: if it should change the look, pass the story's args through to the component and measure it again"
        : exclusion.markup === "changed"
          ? "every value measured the same though the markup changed with it: behavior only"
          : "every value measured the same: behavior only";
    case "no-control":
      return "the story's argTypes give it control: false";
    case "hidden":
      return "the story's argTypes hide it from the docs table";
    case "event":
      return "the story's argTypes mark it as an event";
    case "excluded":
      return "--exclude-props";
  }
}

/**
 * What the exclusions say, once per component, as the rest of a line naming
 * it: each reason with the props it applies to, and how to keep one.
 * Null when nothing was left out automatically or by --exclude-props.
 */
export function describeExclusions(excluded: readonly PropExclusion[]): string | null {
  if (!excluded.length) return null;
  // Props by why they were left out, in the order first met.
  const groups = new Map<string, string[]>();
  for (const e of excluded) {
    const why = exclusionReason(e);
    groups.set(why, [...(groups.get(why) ?? []), e.name]);
  }
  const parts = [...groups].map(([why, names]) => `${ticked(names)} (${why})`);
  const auto = excluded.filter((e) => e.reason !== "excluded").map((e) => e.name);
  const keep = auto.length ? `; to make ${auto.length === 1 ? "it" : "one"} a variant property again, pass --keep-props ${auto.length === 1 ? auto[0] : "<name>"}` : "";
  return `left out ${parts.join(", ")}${keep}`;
}

/** What map, inspect and diff read from a snap: each component's argTypes and what snap left out. */
export interface SnapProps {
  /** The styles.json read. */
  path: string;
  /** The `--exclude-props` the snap was taken with, which leave those props out of every component. */
  excludeProps: string[];
  byId: Map<string, SnapPropRecord>;
}

/** What a snap recorded of one component's props. */
export interface SnapPropRecord {
  argTypes?: Record<string, StoryArgType>;
  excludedProps?: PropExclusion[];
  /** The story it was measured from. */
  storyId?: string;
  /** Its stories' own args, by story ID, as snap records them (`storyArgs`). */
  storyArgs?: Record<string, Record<string, unknown>>;
}

/**
 * The argTypes and exclusions a snap recorded, from `dir`'s styles.json:
 * null when there is none, or it isn't a snap. A snap that can't be read
 * as JSON is an error, since its exclusions would otherwise be dropped
 * without a word.
 */
export function readSnapProps(dir: string): SnapProps | null {
  const path = join(dir, "styles.json");
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} can't be read as JSON (${err instanceof Error ? err.message : String(err)}), so the argTypes snap recorded in it can't be used: measure again with snap, or pass --no-snap`);
  }
  const components = (data as { components?: unknown })?.components;
  if (!Array.isArray(components)) return null;
  const excludeProps = (data as { excludeProps?: unknown }).excludeProps;
  const byId = new Map<string, SnapPropRecord>();
  for (const c of components as { id?: unknown; argTypes?: unknown; excludedProps?: unknown; storyId?: unknown; storyArgs?: unknown }[]) {
    if (typeof c?.id !== "string") continue;
    byId.set(c.id, {
      ...(c.argTypes && typeof c.argTypes === "object" ? { argTypes: c.argTypes as Record<string, StoryArgType> } : {}),
      ...(Array.isArray(c.excludedProps) ? { excludedProps: c.excludedProps as PropExclusion[] } : {}),
      ...(typeof c.storyId === "string" ? { storyId: c.storyId } : {}),
      ...(c.storyArgs && typeof c.storyArgs === "object" && !Array.isArray(c.storyArgs) ? { storyArgs: c.storyArgs as Record<string, Record<string, unknown>> } : {}),
    });
  }
  return { path, byId, excludeProps: Array.isArray(excludeProps) ? excludeProps.filter((n): n is string => typeof n === "string") : [] };
}

/**
 * The prop source of one component for a command without a browser: its
 * argTypes and snap's exclusions from `snap` when it has the component.
 */
export function snapPropSource(
  component: StorybookComponent,
  id: string,
  snap: SnapProps | null,
  flags: { exclude?: readonly string[]; keep?: readonly string[] },
): PropSource {
  const recorded = snap?.byId.get(id);
  // The snap's --exclude-props too, for a component it has, or one taken
  // before each component recorded what it left out.
  const kept = new Set((flags.keep ?? []).map((n) => n.toLowerCase()));
  const exclude = [...(flags.exclude ?? []), ...(snap?.excludeProps ?? []).filter((n) => !kept.has(n.toLowerCase()))];
  const stories = recorded?.storyArgs && { own: Object.entries(recorded.storyArgs).map(([id, args]) => ({ id, args })), storyId: recorded.storyId };
  return resolveProps(component, { argTypes: recorded?.argTypes, measured: recorded?.excludedProps, exclude, keep: flags.keep, ...(stories ? { stories } : {}) });
}

/** What a command without a browser says when it can't see some components' argTypes. */
export function describeUnseenArgTypes(snapPath: string | null, unseen: readonly string[], total: number): string | null {
  if (!unseen.length) return null;
  const which = unseen.length === total ? "the stories' argTypes" : `the argTypes of ${unseen.length} of ${total} components (${unseen.slice(0, 5).join(", ")}${unseen.length > 5 ? ` and ${unseen.length - 5} more` : ""})`;
  const where = snapPath ? `${snapPath} doesn't have ${unseen.length === total ? "them" : "those"}` : "there is no snap to read them from";
  return (
    `Without a browser, storysync can't see ${which}: ${where}. So props only the argTypes declare aren't variant properties, ` +
    `and props the argTypes or snap mark as behavior aren't left out. Run snap first, or point --snap at its directory.`
  );
}
