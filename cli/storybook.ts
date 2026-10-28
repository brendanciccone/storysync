import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { VERSION } from "./version.js";
import { connectWithFallback, isRequestTimeout, requestTimeoutError, DEFAULT_REQUEST_TIMEOUT_MS } from "./mcp-connect.js";
import type { StorybookComponent, StorybookProp, PropType } from "./mapper.js";

export interface ComponentEntry {
  /** Storybook's ID for the component, `ui-base-button`: unique, and what docs-show takes. */
  id: string;
  /** The component's display name, from the story's `component`: `Button`, or `TooltipContent` under `ui/base/Tooltip`. */
  name: string;
  /** Storybook's title, `ui/base/Button`, from its index; rebuilt from the ID when the index can't be read. */
  title?: string;
  /** The title minus its last segment, `ui/base`: the sidebar folder, and the push's Figma page. */
  category?: string;
  storyIds?: string[];
  /** Set when the title was rebuilt from the ID, since Storybook's index couldn't be read or doesn't list it. */
  titleDerived?: boolean;
  /**
   * Set when Storybook's index shows the entry's stories name no component
   * (none has a `componentPath`), as shadcn's `design/*` token pages: with
   * no component behind it, storysync leaves it out unless `--components`
   * names it.
   */
  docsOnly?: true;
}

/** The last segment of a title, the name Storybook's sidebar shows: `Button` for `ui/base/Button`. */
export function titleLeaf(title: string | undefined): string | undefined {
  const leaf = title?.split("/").pop()?.trim();
  return leaf || undefined;
}

/**
 * What identifies a component in the snap, the readback and verify: its
 * Storybook title, which Storybook keeps unique, else its ID, which is unique
 * too, and its name only for output written before either was recorded. The
 * name alone was the key for a component with no title, and two such of one
 * name, `Toaster` under both `ui/base/Sonner` and `ui/radix/Sonner`, collapsed
 * into one.
 */
export function componentKey(component: { name: string; title?: string; id?: string }): string {
  return component.title ?? component.id ?? component.name;
}

/** The names in a `--components` list, trimmed, with empty entries dropped. */
export function componentNames(names: readonly string[] | undefined): string[] {
  return (names ?? []).map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether `key`, lowercased, names `e`: its ID, its title as map prints it,
 * its name, or its title's last segment, the name Storybook's sidebar shows.
 * The name and that segment can differ: the stories titled `ui/base/Tooltip`
 * may document `TooltipContent`, and a name or segment can be shared, as
 * `Button` is by `ui/base/Button` and `ui/radix/Button`.
 */
function isNamed(e: ComponentEntry, key: string): boolean {
  return e.id.toLowerCase() === key
    || e.title?.toLowerCase() === key
    || e.name.toLowerCase() === key
    || titleLeaf(e.title)?.toLowerCase() === key;
}

/**
 * Narrows a component list to the names given with `--components`, as snap,
 * map and diff all do. A name matches a component's ID, its title, its name
 * or its title's last segment, ignoring case, and selects every component it
 * matches: `Button` both `ui/base/Button` and `ui/radix/Button`, where the ID
 * or the title picks one. A list with no names in it selects everything, as
 * leaving the flag off does, rather than nothing.
 *
 * A name that matches nothing is a typo, not a request for zero components.
 * Left to filter silently it produces an empty run that still exits cleanly,
 * so the whole pipeline goes green having checked nothing — and a partial typo
 * is worse, because the run looks populated. So it throws, naming what is
 * available.
 *
 * `alsoKnown` names count as matched without selecting an entry: diff passes
 * Figma's components, since a name found only there is a difference to report
 * rather than a typo. `flag` is the option the names came from, for the error.
 */
export function selectComponents(
  entries: ComponentEntry[],
  names: readonly string[] | undefined,
  alsoKnown: readonly string[] = [],
  flag = "--components",
): ComponentEntry[] {
  // An entry whose stories name no component is left out unless named:
  // there is no component to push, as on shadcn's design/* token pages.
  const components = entries.some((e) => e.docsOnly) ? entries.filter((e) => !e.docsOnly) : entries;
  const wanted = componentNames(names).map((name) => ({ name, key: name.toLowerCase() }));
  if (!wanted.length) return components;
  const known = new Set(alsoKnown.map((n) => n.toLowerCase()));

  const unmatched = wanted.filter(({ key }) => !known.has(key) && !entries.some((e) => isNamed(e, key)));
  if (unmatched.length) {
    throw new Error(
      `${flag} matched no component named ${unmatched.map(({ name }) => `"${name}"`).join(", ")}. ` +
      `Available: ${available(components, alsoKnown)}`,
    );
  }

  // Such an entry only for a name that names no component.
  return entries.filter((e) => wanted.some(({ key }) => isNamed(e, key) && (!e.docsOnly || !components.some((c) => isNamed(c, key)))));
}

/**
 * Finds the one component `inspect --component` names, as `--components`
 * names one: by ID, title, name or the title's last segment, ignoring case and
 * surrounding space. A name that matches nothing throws, naming what is
 * available as `selectComponents` does, rather than asking Storybook for the
 * documentation of a component it never listed.
 *
 * So does a name several components share, `Button` for both `ui/base/Button`
 * and `ui/radix/Button`, listing each one's title and ID. Taking the first, as
 * inspect did, showed one of them as if it were the only one. An ID or a
 * title is one component's alone, so one matched exactly wins.
 */
export function findComponent(entries: ComponentEntry[], name: string, purpose = "inspect"): ComponentEntry {
  const key = name.trim().toLowerCase();
  const matched = entries.filter((e) => isNamed(e, key));
  if (!matched.length) {
    throw new Error(`No component named "${name.trim()}". Available: ${available(entries)}`);
  }
  const exact = [
    matched,
    matched.filter((e) => e.id.toLowerCase() === key),
    matched.filter((e) => e.title?.toLowerCase() === key),
  ].find((m) => m.length === 1);
  if (exact) return exact[0];
  throw new Error(
    `"${name.trim()}" names ${matched.length} components: ` +
    `${matched.map((e) => `${e.title ?? e.name} (${e.id})`).join(", ")}. Pass the ID or title of the one to ${purpose}.`,
  );
}

/**
 * The one component each name picks, for a flag that acts on what the
 * user said yes to: `--convert` and `--remove-extra`. A name that matches
 * nothing throws as selectComponents does, and so does a name several
 * components share, `Button` for both `ui/base/Button` and
 * `ui/radix/Button`, listing each one's title and ID as inspect does, so
 * the agent asks which one rather than acting on both. An ID or a title
 * picks one.
 */
export function selectEach(entries: ComponentEntry[], names: readonly string[], flag: string): ComponentEntry[] {
  selectComponents(entries, names, [], flag);
  return componentNames(names).map((name) => findComponent(entries, name, `name with ${flag}`));
}

/** The names a component goes by in an "Available" list: its name, and its title's last segment where that differs. */
function shownNames(e: ComponentEntry): string[] {
  const leaf = titleLeaf(e.title);
  return leaf && leaf !== e.name ? [e.name, leaf] : [e.name];
}

/**
 * The names an "Available" list gives, sorted, each name several components
 * go by with their IDs, `Button (ui-base-button, ui-radix-button)`: the name
 * selects every one of them, and an ID picks one. `alsoKnown` are Figma's.
 */
function available(entries: ComponentEntry[], alsoKnown: readonly string[] = []): string {
  const ids = new Map<string, string[]>();
  for (const e of entries) for (const name of shownNames(e)) ids.set(name, [...(ids.get(name) ?? []), e.id]);
  for (const name of alsoKnown) if (!ids.has(name)) ids.set(name, []);
  return [...ids.keys()].sort().map((name) => {
    const of = ids.get(name)!;
    return of.length > 1 ? `${name} (${of.join(", ")})` : name;
  }).join(", ") || "none";
}

// Derives a Figma-friendly category label from a Storybook ID by stripping
// the kebab-cased component name from the end, for a component whose title
// Storybook's index can't give. Storybook IDs are
// `kebab(title)`, so `ui-icon-button` for component `IconButton` yields
// category `UI`. Multi-word categories like `Data Display` round-trip too:
// `data-display-card` minus `card` → `data-display` → "Data Display".
export function deriveCategoryFromId(id: string, name: string): string | undefined {
  const idPath = id.split("--")[0];
  if (!idPath) return undefined;

  // Storybook is inconsistent about whether it splits PascalCase in IDs:
  // `EmptyState` may become `empty-state` or `emptystate`. Try both.
  const nameSplit = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/\s+/g, "-").toLowerCase();
  const nameJoined = name.replace(/\s+/g, "").toLowerCase();

  let prefix: string | null = null;
  for (const candidate of [nameSplit, nameJoined]) {
    const suffix = `-${candidate}`;
    if (idPath.endsWith(suffix)) {
      prefix = idPath.slice(0, -suffix.length);
      break;
    }
  }
  if (prefix == null || !prefix) return undefined;

  const ACRONYMS = new Set(["ui", "ux", "api", "html", "css", "svg", "js", "ts"]);

  return prefix
    .split("-")
    .map((seg) => {
      if (!seg.length) return seg;
      if (ACRONYMS.has(seg)) return seg.toUpperCase();
      return seg[0].toUpperCase() + seg.slice(1);
    })
    .join(" ");
}

/**
 * How long to keep waiting for Storybook's index.json once the docs list has
 * answered, before rebuilding titles from IDs instead. The docs list is built
 * from the same index, so by then Storybook has it ready, and a server that
 * still hasn't sent it isn't going to: with a timeout of its own, 30 seconds,
 * an index.json that never answered held up every command that lists
 * components for all of it, or twice that for a Storybook under a sub-path.
 */
const INDEX_GRACE_MS = 5_000;

/**
 * Where Storybook serves index.json: beside the Storybook URL's path, for one
 * served under a sub-path, and at the root of its origin, where `storybook
 * dev` serves it and where the MCP endpoint is looked for.
 */
export function indexUrls(storybookUrl: string): URL[] {
  const dir = new URL(storybookUrl);
  dir.search = "";
  dir.hash = "";
  if (!dir.pathname.endsWith("/")) dir.pathname += "/";
  const urls = [new URL("index.json", dir), new URL("/index.json", dir)];
  return urls.filter((url, i) => urls.findIndex((u) => u.href === url.href) === i);
}

/** Storybook's component manifest, which its docs are made from, or null when it can't be read before `signal` aborts. */
async function fetchManifest(storybookUrl: string, signal: AbortSignal): Promise<unknown> {
  for (const url of indexUrls(storybookUrl).map((u) => new URL(u.pathname.replace(/index\.json$/, "manifests/components.json"), u))) {
    if (signal.aborted) break;
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return await res.json();
    } catch {
      // Not there, or not JSON: nothing to key a cache by.
    }
  }
  return null;
}

/** Storybook's index.json, or null when it can't be read before `signal` aborts. */
async function fetchIndex(storybookUrl: string, signal: AbortSignal): Promise<unknown> {
  for (const url of indexUrls(storybookUrl)) {
    if (signal.aborted) break;
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return await res.json();
    } catch {
      // Not there, or not JSON: try the next place, then rebuild from IDs.
    }
  }
  return null;
}

/**
 * Each component's title, by component ID, from Storybook's index.json:
 * `{ entries: { "ui-base-button--default": { id, title, ... } } }`, one
 * entry a story or docs page, each ID the component's and `--` and its own.
 * Null for anything else.
 */
export function indexTitles(index: unknown): Map<string, string> | null {
  const entries = (index as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== "object") return null;
  const titles = new Map<string, string>();
  for (const entry of Object.values(entries)) {
    const { id, title } = (entry ?? {}) as { id?: unknown; title?: unknown };
    if (typeof id !== "string" || typeof title !== "string" || !title.trim()) continue;
    const componentId = id.split("--")[0];
    if (!titles.has(componentId)) titles.set(componentId, title);
  }
  return titles;
}

/**
 * The component IDs whose stories, by Storybook's index.json, name no
 * component: none of their story entries has a `componentPath`, which
 * Storybook gives a story whose meta names a `component`. shadcn's
 * `design/*` token pages are such: a table of swatches with no component
 * behind it, whose docs list no props. Null when the index gives no story
 * a `componentPath`, as one written before Storybook recorded it doesn't,
 * so nothing can be told from it.
 */
export function indexDocsOnly(index: unknown): Set<string> | null {
  const entries = (index as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== "object") return null;
  const stories = new Set<string>();
  const withComponent = new Set<string>();
  for (const entry of Object.values(entries)) {
    const { id, type, componentPath } = (entry ?? {}) as { id?: unknown; type?: unknown; componentPath?: unknown };
    if (typeof id !== "string" || type === "docs") continue;
    const componentId = id.split("--")[0];
    stories.add(componentId);
    if (typeof componentPath === "string" && componentPath.trim()) withComponent.add(componentId);
  }
  if (!withComponent.size) return null;
  return new Set([...stories].filter((id) => !withComponent.has(id)));
}

/** The title minus its last segment, the sidebar folder it is in: `ui/base` for `ui/base/Button`. */
export function titleCategory(title: string): string | undefined {
  return title.split("/").slice(0, -1).map((s) => s.trim()).join("/") || undefined;
}

/**
 * Gives each component listed in Storybook's index its title there, and the
 * category that title implies, in place of what the docs list let it rebuild.
 */
export function applyIndexTitles(entries: ComponentEntry[], titles: Map<string, string> | null, docsOnly: Set<string> | null = null): ComponentEntry[] {
  for (const entry of entries) {
    if (docsOnly?.has(entry.id)) entry.docsOnly = true;
    const title = titles?.get(entry.id);
    if (!title) continue;
    entry.title = title;
    entry.category = titleCategory(title);
    delete entry.titleDerived;
  }
  return entries;
}

/** The Storybook MCP tools that list components and return one's documentation. */
export interface DocsTools {
  list: string;
  show: string;
}

// @storybook/addon-mcp renamed its docs tools when it moved into the Storybook
// monorepo at 10.6: `list-all-documentation` became `docs-list` and
// `get-documentation` became `docs-show`, with the same arguments and the same
// markdown. Both names stay in use, since 10.6 requires Storybook 10.6 and
// projects on 10.1–10.5 keep 0.7, so they come from the server's own tool list
// rather than being assumed.
const DOCS_TOOL_NAMES = {
  list: ["docs-list", "list-all-documentation"],
  show: ["docs-show", "get-documentation"],
};

/** Picks the docs tool names a Storybook MCP server offers, or null if it lacks either. */
export function resolveDocsTools(available: string[]): DocsTools | null {
  const pick = (names: string[]) => names.find((name) => available.includes(name));
  const list = pick(DOCS_TOOL_NAMES.list);
  const show = pick(DOCS_TOOL_NAMES.show);
  return list && show ? { list, show } : null;
}

/**
 * Returns the text of a tool result, or throws if the server flagged it as an
 * error.
 *
 * A failed tool call is not a protocol error: the server answers normally, with
 * `isError: true` and the reason as text. Read as documentation, that text
 * parses to nothing, which is how calling a renamed tool reported "0
 * components" and exited 0, and how a mistyped component ID came back as a
 * component with no props.
 */
export function toolResultText(tool: string, result: unknown): string {
  const r = result as { isError?: boolean; content?: { type: string; text?: string }[] };
  const texts = r.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text!) ?? [];
  if (r.isError) {
    throw new Error(`Storybook MCP tool "${tool}" failed: ${texts.join("\n") || "no reason given"}`);
  }
  if (!texts.length) {
    throw new Error(`Storybook MCP tool "${tool}" returned no text content. Raw result: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return texts.join("\n");
}

// A component's line in the docs list: `- Name (id)`, or `- Name (id): summary`.
// The ID is one token, followed by the summary or the end of the line, and
// the name before it may hold parentheses of its own. That is also what keeps
// a line of a summary that runs onto several lines from being read as a
// component: addon-mcp prints a component's description as written, so a
// JSDoc line `- Use (sparingly) next to titles` arrives as a line of its own.
// The name starts and ends with what isn't whitespace: as `.+?`, it could
// take the spaces around it as `\s+` and `\s*` could, so a line of 2,000
// spaces from the server took 3 seconds to fail, growing as its length cubed.
const COMPONENT_LINE = /^[-*]\s+(?:\*\*)?(\S(?:.*?\S)?)(?:\*\*)?\s*\((?:id:\s*)?[`"']?([^\s()`"']+)[`"']?\)(?::.*)?\s*$/;

// A story's line, indented under its component: `  - Name (id)`. A story's
// name may hold parentheses of its own (`Playground (all tones)`), so the ID
// is the parenthesized token that ends the line, and it holds the `--` every
// story ID has. Reading the first one took "all tones" as the story ID, and
// every variant snap rendered from it failed. The name, if any, starts with
// what isn't whitespace, for the reason COMPONENT_LINE's does.
const STORY_LINE = /^\s+[-*]\s+(?:\S.*)?\((?:id:\s*)?[`"']?([^\s()`"']+--[^\s()`"']+)[`"']?\)\s*$/;

/**
 * The part of a docs-show response about the component's own props.
 *
 * addon-mcp prints them under "## Props". The same response prints each
 * subcomponent's props too, under "#### Props" in "## Subcomponents", and,
 * last, the source of any MDX docs page attached to the component, under
 * "## Docs". Read as the component's, a subcomponent's prop, or a type in an
 * MDX code sample, became a Figma variant property the component doesn't
 * have, and multiplied the variants snap measures. So this is the "## Props"
 * section when there is one, and otherwise everything but the Docs section
 * and the subcomponents' props.
 */
function ownPropsText(doc: string): string {
  // Anchored on the block addon-mcp generates, not the first "## Props": the
  // component's own description, printed above it, may hold a "## Props" or
  // "## Docs" heading of its own.
  const generated = GENERATED_PROPS.exec(doc);
  if (generated) {
    const body = doc.slice(generated.index + "## Props".length);
    const next = body.search(/^## /m);
    return next === -1 ? body : body.slice(0, next);
  }
  // With no generated block, read the rest, but not a subcomponent's props or
  // an attached MDX page, whose "## Docs" heading is followed by its own "### ".
  const docs = /^## Docs[ \t]*\r?\n\s*^### /m.exec(doc);
  const text = docs ? doc.slice(0, docs.index) : doc;
  return text.replace(SUBCOMPONENT_PROPS, "");
}

// The component's own Props block, as addon-mcp generates it.
const GENERATED_PROPS = /^## Props[ \t]*\r?\n\s*```[^\n]*\n[ \t]*export type Props = \{/m;

// A subcomponent's props: the "#### Props" heading and the code block after it.
const SUBCOMPONENT_PROPS = /^#### Props[ \t]*\r?\n\s*```[\s\S]*?```/gm;

export interface StorybookClientOptions {
  /**
   * Reads Storybook's index.json, for the components' titles, until `signal`
   * aborts. By default it is fetched from the Storybook URL; tests pass their
   * own. null reads none, so every title is rebuilt from its ID.
   */
  readIndex?: ((signal: AbortSignal) => Promise<unknown>) | null;
  /** How long to wait for the index once the docs list has answered: 5 seconds unless a test says otherwise. */
  indexGraceMs?: number;
  /** Each MCP request's limit once connected, --request-timeout's value: DEFAULT_REQUEST_TIMEOUT_MS by default. */
  requestTimeoutMs?: number;
  /** The limit on connecting, --connect-timeout's value: requestTimeoutMs unless given. */
  connectTimeoutMs?: number;
  /**
   * Where the docs cache is kept: `.storysync/cache/docs` under the working
   * directory unless given; null keeps none (`--no-cache`), as does a
   * client connected through a test's transport unless a test gives one.
   */
  cacheDir?: string | null;
  /** Reads Storybook's component manifest, which the docs cache keys by; fetched from the Storybook URL by default. */
  readManifest?: ((signal: AbortSignal) => Promise<unknown>) | null;
}

/** Where the docs cache is kept, under the working directory. */
export const DOCS_CACHE_DIR = ".storysync/cache/docs";

export class StorybookClient {
  private client: Client | null = null;
  private docsTools: DocsTools | null = null;
  private url: string;
  private readIndex: ((signal: AbortSignal) => Promise<unknown>) | null | undefined;
  private indexGraceMs: number;
  // Each request's limit, as --request-timeout gives it. Left to the SDK, a
  // docs-show got 60 seconds whatever the flags said.
  private requestTimeoutMs: number;
  private connectTimeoutMs: number;
  private cacheDir: string | null | undefined;
  private readManifest: ((signal: AbortSignal) => Promise<unknown>) | null | undefined;
  private cacheKeysRead: Promise<{ dir: string; index: string; manifest: Map<string, string> } | null> | null = null;

  constructor(url: string, options: StorybookClientOptions = {}) {
    this.url = url;
    this.readIndex = options.readIndex;
    this.cacheDir = options.cacheDir;
    this.readManifest = options.readManifest;
    this.indexGraceMs = options.indexGraceMs ?? INDEX_GRACE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? this.requestTimeoutMs;
  }

  // `transport` is for tests, which connect to an in-memory server. Nothing
  // serves HTTP behind one, so there is no index to read unless a test gives
  // one.
  async connect(transport?: Transport): Promise<void> {
    this.client = new Client({ name: "storysync", version: VERSION }, {});
    this.docsTools = null;
    if (transport) {
      if (this.readIndex === undefined) this.readIndex = null;
      if (this.cacheDir === undefined) this.cacheDir = null;
      await this.client.connect(transport);
      return;
    }

    await connectWithFallback(this.client, new URL("/mcp", this.url), "Storybook", this.connectTimeoutMs);
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.docsTools = null;
  }

  async listAvailableTools(): Promise<string[]> {
    if (!this.client) throw new Error("Not connected");
    const client = this.client;
    const result = await this.request("tools/list", () => client.listTools(undefined, { timeout: this.requestTimeoutMs }));
    return result.tools.map((t) => t.name);
  }

  /**
   * The components, with Storybook's own titles. The docs list gives only each
   * component's name and ID, and a title can't be rebuilt from an ID: it is
   * lowercased with `/` and spaces both made `-`, and the name is the story's
   * `component`, which needn't be the title's last segment (`TooltipContent`
   * under `ui/base/Tooltip`). Rebuilt, `ui/base/Button` came out `UI Base/
   * Button`, and a component whose name its ID doesn't end with got no title
   * at all, so `ui/base/Tooltip` and `ui/radix/Tooltip` were both just
   * `TooltipContent`. Storybook's index.json has every title, so they come
   * from there, and are rebuilt only for a component it doesn't list, or when
   * it can't be read.
   */
  async listComponents(): Promise<ComponentEntry[]> {
    const { list } = await this.getDocsTools();
    // Read beside the docs list, not after it: on a busy Storybook each can
    // take seconds. Once the list has answered, the index has a few seconds
    // more, and is then given up on, its request with it, so nothing holds
    // the command open.
    const stop = new AbortController();
    const stopped = new Promise<null>((resolve) => stop.signal.addEventListener("abort", () => resolve(null), { once: true }));
    const index = Promise.race([this.readIndexOnce(stop.signal), stopped]);
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      const text = await this.call(list, { withStoryIds: true });
      grace = setTimeout(() => stop.abort(), this.indexGraceMs);
      const read = await index;
      return applyIndexTitles(this.parseComponentList(text), read ? indexTitles(read) : null, read ? indexDocsOnly(read) : null);
    } finally {
      clearTimeout(grace);
      stop.abort();
    }
  }

  /** Storybook's index, or null when there is none to read or it can't be read. */
  private async readIndexOnce(signal: AbortSignal): Promise<unknown> {
    const read = this.readIndex === undefined ? (s: AbortSignal) => fetchIndex(this.url, s) : this.readIndex;
    try {
      return read ? await read(signal) : null;
    } catch {
      return null;
    }
  }

  async getComponent(id: string, displayName?: string, title?: string, category?: string): Promise<StorybookComponent> {
    const text = await this.docsText(id);
    const name = displayName ?? id;
    return { name, title, category, props: this.parseProps(text), stories: this.parseStories(id, text) };
  }

  /**
   * A component's docs, from the docs cache where it holds them for the
   * Storybook as it is now, else from docs-show, which takes seconds a
   * component, and then kept there. Kept per Storybook URL, each component's
   * under the index.json it was read with and the component's entry in
   * Storybook's component manifest, which its docs are made from: a story
   * added, renamed or moved changes the first, and a prop or its type the
   * second. With either unreadable nothing is cached, as nothing would
   * say when it went stale.
   */
  private async docsText(id: string): Promise<string> {
    const { show } = await this.getDocsTools();
    const keys = await this.cacheKeys();
    const manifest = keys?.manifest.get(id);
    const file = keys && manifest ? join(keys.dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`) : null;
    if (file) {
      try {
        const cached = JSON.parse(readFileSync(file, "utf8")) as { index?: unknown; manifest?: unknown; text?: unknown };
        if (cached.index === keys!.index && cached.manifest === manifest && typeof cached.text === "string") return cached.text;
      } catch {
        // Not cached yet, or unreadable: read it from Storybook.
      }
    }
    const text = await this.call(show, { id });
    if (file) {
      try {
        mkdirSync(keys!.dir, { recursive: true });
        // Written whole, then moved into place, so a command reading it alongside never reads half.
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ index: keys!.index, manifest, text }));
        renameSync(temp, file);
      } catch {
        // A cache that can't be written only costs the next command time.
      }
    }
    return text;
  }

  /** What the docs cache keys each component's docs by, read once, or null when there is no cache. */
  private cacheKeys(): Promise<{ dir: string; index: string; manifest: Map<string, string> } | null> {
    if (this.cacheDir === null) return Promise.resolve(null);
    this.cacheKeysRead ??= (async () => {
      const signal = AbortSignal.timeout(this.requestTimeoutMs);
      const readManifest = this.readManifest === undefined ? (s: AbortSignal) => fetchManifest(this.url, s) : this.readManifest;
      const [index, manifest] = await Promise.all([this.readIndexOnce(signal), readManifest ? readManifest(signal).catch(() => null) : null]);
      const components = (manifest as { components?: unknown } | null)?.components;
      if (index == null || !components || typeof components !== "object") return null;
      const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
      const url = this.url.replace(/[?#].*$/, "").replace(/\/+$/, "");
      return {
        dir: join(resolve(this.cacheDir ?? DOCS_CACHE_DIR), hash(url).slice(0, 16)),
        index: hash(index),
        manifest: new Map(Object.entries(components as Record<string, unknown>).map(([id, entry]) => [id, hash(entry)])),
      };
    })();
    return this.cacheKeysRead;
  }

  private async getDocsTools(): Promise<DocsTools> {
    if (this.docsTools) return this.docsTools;
    const tools = resolveDocsTools(await this.listAvailableTools());
    if (!tools) {
      throw new Error(
        "Storybook MCP is missing the docs tools (docs-list and docs-show, or list-all-documentation and get-documentation before addon-mcp 10.6).\n" +
          "  The docs tools require Storybook 10.1 or later. They are not available in Storybook 9.x.\n" +
          "  Run `storysync init` to check your setup, or upgrade with: npx storybook@latest upgrade",
      );
    }
    this.docsTools = tools;
    return tools;
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Not connected");
    const client = this.client;
    return toolResultText(tool, await this.request(tool, () => client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.requestTimeoutMs })));
  }

  /**
   * Makes a request, failing one that outlasts its limit with an error that
   * names the tool, the limit and the flag. map records it as that
   * component's failure, so --strict fails on it.
   */
  private async request<T>(tool: string, send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (err) {
      if (isRequestTimeout(err)) throw requestTimeoutError("Storybook", tool, this.requestTimeoutMs);
      throw err;
    }
  }

  // Parses the markdown list from the docs list tool (`docs-list`, formerly
  // `list-all-documentation`).
  // Category is derived from the component ID prefix (Storybook IDs are
  // kebab-case versions of the title, so `ui-button` → category "UI").
  // Falls back to slashed names (`Forms/Button`) and section headings
  // when present, since not all Storybook MCP responses include IDs.
  // listComponents replaces what this rebuilds with the title from
  // Storybook's index wherever it can read one.
  //
  // The list names MDX docs pages too, under "# Docs" ("## Docs" in each
  // source's part when Storybook composes several). A docs page has no
  // stories, so it is not a component: read as one, it failed every snap and
  // was reported by diff as a component missing from Figma.
  private parseComponentList(text: string): ComponentEntry[] {
    const entries: ComponentEntry[] = [];
    let current: ComponentEntry | null = null;
    let currentSection: string | null = null;
    let inDocs = false;

    for (const line of text.split("\n")) {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
      if (heading) {
        currentSection = heading[1].trim();
        inDocs = currentSection.toLowerCase() === "docs";
        continue;
      }
      if (inDocs) continue;

      const m = line.match(COMPONENT_LINE);
      if (m && !/^\s{2,}/.test(line)) {
        const rawName = m[1].trim();
        const id = m[2].trim();
        // A docs page's ID is a story-style `guidelines-button--docs`.
        // Storybook collapses repeated dashes in a title, so a component's ID
        // never holds `--`, whatever heading the entry is under.
        if (id.includes("--")) {
          current = null;
          continue;
        }
        let title: string | undefined;
        let name = rawName;

        if (rawName.includes("/")) {
          title = rawName;
          name = rawName.split("/").pop()!.trim();
        }

        // Prefer ID-derived category — Storybook IDs encode the title path
        // and survive when the markdown response loses the heading hierarchy.
        let category = deriveCategoryFromId(id, name);

        if (!category && title?.includes("/")) {
          category = title.split("/").slice(0, -1).join("/");
        } else if (!category && currentSection && currentSection.toLowerCase() !== "components") {
          category = currentSection;
        }

        let titleDerived: true | undefined;
        if (category && !title) {
          title = `${category}/${name}`;
          titleDerived = true;
        }

        current = { id, name, title, category, storyIds: [], ...(titleDerived ? { titleDerived } : {}) };
        entries.push(current);
      } else if (current && /^\s{2,}/.test(line)) {
        const s = line.match(STORY_LINE);
        if (s) current.storyIds?.push(s[1].trim());
      }
    }
    return entries;
  }

  // Extracts props from TypeScript type definitions in the documentation.
  // Looks for `export type Props = { ... }` blocks in code fences, in the part
  // of the documentation that is about the component's own props.
  private parseProps(doc: string): StorybookProp[] {
    const text = ownPropsText(doc);
    const props: StorybookProp[] = [];
    const codeBlocks = /```(?:typescript|ts|tsx)?\s*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;

    while ((m = codeBlocks.exec(text)) !== null) {
      props.push(...this.parsePropsBlock(m[1]));
    }

    if (!props.length) {
      const inline = text.match(/export\s+type\s+Props\s*=\s*\{([\s\S]*?)\}/)
        ?? text.match(/export\s+interface\s+\w+\s*\{([\s\S]*?)\}/);
      if (inline) props.push(...this.parsePropsBlock(`export type Props = {${inline[1]}}`));
    }

    if (!props.length) {
      props.push(...this.parseArgTable(text));
    }
    return props;
  }

  private parsePropsBlock(block: string): StorybookProp[] {
    const body = block.match(/(?:export\s+)?type\s+\w+\s*=\s*\{([\s\S]*)\}/)
      ?? block.match(/(?:export\s+)?interface\s+\w+(?:\s+extends\s+\w+(?:<[^>]*>)?)?\s*\{([\s\S]*)\}/);
    if (!body) return [];

    const props: StorybookProp[] = [];
    // addon-mcp prints a prop's description between `/**` and `*/` as written,
    // without a leading `*`, so a line of it can look like a prop:
    // `Accepts: "a" | "b"` was read as a variant property named Accepts.
    let inComment = false;
    for (const line of body[1].split("\n")) {
      const t = line.trim();
      if (inComment) {
        inComment = !t.endsWith("*/");
        continue;
      }
      if (t.startsWith("/*")) {
        inComment = !t.slice(2).endsWith("*/");
        continue;
      }
      if (!t || t.startsWith("/") || t.startsWith("*") || t === "}") continue;

      const m = t.match(/^(\w+)(\?)?:\s*(.+);?\s*$/);
      if (!m) continue;

      const [, name, opt, rest] = m;
      const eqIdx = rest.lastIndexOf(" = ");
      let typeStr: string, defaultValue: string | undefined;

      if (eqIdx !== -1) {
        typeStr = rest.slice(0, eqIdx).trim();
        defaultValue = rest.slice(eqIdx + 3).replace(/;$/, "").trim().replace(/^["']|["']$/g, "");
      } else {
        typeStr = rest.replace(/;$/, "").trim();
      }

      const type: PropType = typeStr.includes("|") ? { name: "union", raw: typeStr } : { name: typeStr };
      props.push({ name, type, defaultValue, required: !opt });
    }
    return props;
  }

  // Parses Storybook argType/controls markdown tables like:
  //   | Name | Type | Default |
  //   |------|------|---------|
  //   | variant | "primary" \| "secondary" | "primary" |
  private parseArgTable(text: string): StorybookProp[] {
    const props: StorybookProp[] = [];
    const lines = text.split("\n");

    for (let i = 0; i < lines.length - 2; i++) {
      const header = lines[i];
      const separator = lines[i + 1];
      if (!separator || !/^\s*\|[\s-:|]+\|\s*$/.test(separator)) continue;

      const cols = tableCells(header).map((c) => c.toLowerCase());
      const nameIdx = cols.findIndex((c) => c === "name" || c === "property" || c === "prop");
      const typeIdx = cols.findIndex((c) => c === "type" || c === "control");
      const defaultIdx = cols.findIndex((c) => c === "default" || c === "default value");
      if (nameIdx < 0 || typeIdx < 0) continue;

      for (let j = i + 2; j < lines.length; j++) {
        const row = lines[j];
        if (!row.trim().startsWith("|")) break;
        const cells = tableCells(row);
        if (cells.length <= Math.max(nameIdx, typeIdx)) continue;

        const name = cells[nameIdx].replace(/`/g, "").trim();
        const typeStr = cells[typeIdx].replace(/`/g, "").trim();
        const defaultValue = defaultIdx >= 0 && cells[defaultIdx]
          ? cells[defaultIdx].replace(/`/g, "").replace(/^["']|["']$/g, "").replace(/-$/, "").trim() || undefined
          : undefined;

        if (!name || name === "-") continue;

        const type: PropType = typeStr.includes("|")
          ? { name: "union", raw: typeStr }
          : typeStr === "boolean" ? { name: "boolean" }
          : { name: typeStr };

        props.push({ name, type, defaultValue, required: false });
      }
      break;
    }
    return props;
  }

  private parseStories(docId: string, text: string): { id: string; name: string }[] {
    return parseStories(docId, text);
  }
}

/**
 * A markdown table row's cells, trimmed. Markdown writes a `|` inside a cell
 * as `\|`, and every union type in a props table has one, so the row is split
 * only on a bare `|` and each `\|` then read as `|`: split on every `|`, a
 * row of `"a" \| "b"` gave the type `"a" \` and moved every cell after it
 * along by one. An empty cell is kept, so the cells after it stay in their
 * columns.
 */
export function tableCells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

// Matches an ID label followed by a story ID, quoted or bare. Storybook's
// addon-mcp writes `Story ID: forms-button--default` unquoted, so requiring
// quotes here (as an earlier version did) missed every real story and fell
// through to the guessed fallback below.
//
// Requiring the `--` separator is what keeps this from also matching the
// component's own `ID: forms-button` line. The leading `\b` matters just as
// much: without it the bare `id` alternative matches the tail of any word
// ending in those letters, so `grid: layout--wide` would be read as a story.
const STORY_ID_PATTERN = /\b(?:story[\s_-]*id|storyid|id)\s*:\s*[`"']?([A-Za-z0-9][A-Za-z0-9_-]*--[A-Za-z0-9_-]+)[`"']?/gi;

/**
 * Extracts story IDs from a documentation response.
 *
 * `docId` is the documentation ID (`forms-button`) — the kebab-cased title
 * path. Story IDs extend it (`forms-button--default`), which makes it the right
 * basis for the fallback; a bare lowercased component name would guess
 * `button--default` and miss for any component under a title path.
 *
 * Prefer the story IDs from `listComponents`, which come from Storybook's own
 * index, when they are available.
 */
export function parseStories(docId: string, text: string): { id: string; name: string }[] {
  const stories: { id: string; name: string }[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(STORY_ID_PATTERN)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const slug = id.split("--").pop() ?? id;
    stories.push({ id, name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) });
  }

  if (!stories.length) {
    stories.push({ id: `${docId}--default`, name: "Default" });
  }
  return stories;
}
