// Which of a component's stories measures each variant.
//
// snap renders every variant through a story, its combination in the URL's
// args, which override the story's own. What a story adds besides those is
// what the variant is drawn with: shadcn/ui Button's Icon story gives the
// button a lucide icon and no label, its WithIcon story an icon and a long
// label. Measured from one story, every variant got that story's content,
// so the fourth live push, measuring Button from WithIcon, put a label
// spilling out of each icon size's 34px square.
//
// So each variant is measured from the story whose own args name the values
// it has, where that story adds something of its own: Button's `size=icon`
// variants from Icon, `size=icon-sm` from Icon Small. Every other variant is
// measured from the component's story, Default or the one `--stories`
// names. Deterministic: the same stories and combination always pick the
// same story.

import type { FigmaVariantProperty } from "./mapper.js";

/** A story's own annotations, as its CSF file holds them: what it adds to its component's. */
export interface StoryOwn {
  id: string;
  /**
   * The story's own args, not those of its component or the project: a
   * string, number, boolean or null as it is, any other value recorded by
   * its type (`{ $type: "object" }` for a React element).
   */
  args: Record<string, unknown>;
  /** A render function of its own. */
  render?: true;
  /** Decorators of its own. */
  decorators?: true;
  /** A play function of its own, which acts on what renders: such a story is never picked for a variant. */
  play?: true;
}

/** The values a story's own args give the variant properties, as `prop=value` pairs by property. */
export function storyClaims(story: StoryOwn, properties: readonly FigmaVariantProperty[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const property of properties) {
    if (!Object.hasOwn(story.args, property.name)) continue;
    const value = story.args[property.name];
    if (value === null || !["string", "number", "boolean"].includes(typeof value)) continue;
    if (property.values.includes(String(value))) out[property.name] = String(value);
  }
  return out;
}

/**
 * Whether a story draws anything its component's story doesn't, given the
 * same variant: an arg that is no variant property (`children`, `title`),
 * or a render or decorators of its own. A story whose own args only name
 * variant properties renders as the component's story does once a URL sets
 * them, so it has nothing to give a variant; nor does a function arg, a
 * handler such as `onClick: fn()` far more often than something drawn.
 */
export function storyAddsContent(story: StoryOwn, properties: readonly FigmaVariantProperty[]): boolean {
  const names = new Set(properties.map((p) => p.name));
  const isFunction = (value: unknown) => typeof value === "object" && value !== null && (value as { $type?: unknown }).$type === "function";
  return Boolean(story.render || story.decorators
    || Object.entries(story.args).some(([name, value]) => !names.has(name) && !isFunction(value)));
}

/** How much a story sets of its own: its args, render and decorators. */
function weight(story: StoryOwn): number {
  return Object.keys(story.args).length + (story.render ? 1 : 0) + (story.decorators ? 1 : 0);
}

const contains = (outer: Record<string, string>, inner: Record<string, string>) =>
  Object.entries(inner).every(([name, value]) => outer[name] === value);

/**
 * The values each story is for, by its ID: what its own args give the
 * variant properties, less what a story that adds nothing (storyAddsContent)
 * gives them too. Icon sets `variant=secondary` and `size=icon`, and
 * Secondary, which adds nothing, sets `variant=secondary`, so Icon is for
 * `size=icon`, its variant being what it is drawn in; WithIcon sets what
 * Secondary does and draws an icon and a long label, so it is for nothing,
 * as it would otherwise be for every secondary button. Stories with a play
 * function count for nothing.
 */
export function storyKeys(stories: readonly StoryOwn[], properties: readonly FigmaVariantProperty[]): Map<string, Record<string, string>> {
  const usable = stories.filter((s) => !s.play);
  const claims = usable.map((s) => storyClaims(s, properties));
  const plain = usable.map((s) => !storyAddsContent(s, properties));
  const out = new Map<string, Record<string, string>>();
  usable.forEach((story, i) => {
    const key: Record<string, string> = { ...claims[i] };
    usable.forEach((_, j) => {
      if (i === j || !plain[j] || !contains(claims[i], claims[j])) return;
      for (const name of Object.keys(claims[j])) delete key[name];
    });
    out.set(story.id, key);
  });
  return out;
}

/** The story a variant is measured from, and the values that chose it: none where it is the component's. */
export interface StoryChoice {
  storyId: string;
  /** The values of the variant's that the story is for, as `prop=value`; absent for the component's story. */
  values?: string[];
}

/**
 * The story to measure `combination` from: the one that adds content of its
 * own and whose values (storyKeys) the combination all has, the most of
 * them first, then the story that sets more of its own, then the earlier;
 * else `fallback`, the component's story.
 */
export function chooseStory(
  combination: Record<string, string>,
  stories: readonly StoryOwn[],
  properties: readonly FigmaVariantProperty[],
  fallback: string,
  keys: Map<string, Record<string, string>> = storyKeys(stories, properties),
): StoryChoice {
  let best: { story: StoryOwn; key: Record<string, string>; index: number } | null = null;
  stories.forEach((story, index) => {
    const key = keys.get(story.id);
    if (!key || !Object.keys(key).length || story.play || !storyAddsContent(story, properties)) return;
    if (!contains(combination, key)) return;
    if (best) {
      const [a, b] = [Object.keys(key).length, Object.keys(best.key).length];
      if (a < b || (a === b && weight(story) <= weight(best.story))) return;
    }
    best = { story, key, index };
  });
  const chosen = best as { story: StoryOwn; key: Record<string, string> } | null;
  if (!chosen || chosen.story.id === fallback) return { storyId: fallback };
  return { storyId: chosen.story.id, values: Object.entries(chosen.key).map(([name, value]) => `${name}=${value}`) };
}
