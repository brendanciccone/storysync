// Figma MCP client — reads variables and components from a Figma file.
//
// Everything is read through use_figma, which runs plugin code in the file and
// has two limits that shape every read here (developers.figma.com/docs/
// figma-mcp-server/write-to-canvas, and the figma-use skill's rule 9):
//
// - It returns at most 20kb per call. A full palette or component library
//   passes that, so each read returns a slice, as much as fits under
//   RESPONSE_GUARD, with where the next one starts, and the client calls again
//   from there until nothing is left.
// - It loads a file's pages only as a call switches to them, and each call
//   starts on the first page. A search from figma.root sees only the loaded
//   pages, so it misses every component off the first page, and the push puts
//   each Storybook category on a page of its own. figma.loadAllPagesAsync() is
//   not implemented there. So components are read a page at a time: one call
//   lists the pages, leaving out dividers, then each call switches to one
//   page, once, as Figma's guidance says, and searches only that page.
//
// Figma's guidance has an agent issue the per-page calls together; the CLI
// makes them one after another. Either way each call counts toward the seat's
// limits on Figma's MCP server, by the minute and by the day (developers.
// figma.com/docs/figma-mcp-server/rate-limits-access), and a file of many
// pages may meet the per-minute one. So the reads save calls where it costs
// nothing. Each slice is filled as far as the guard allows, rather than to a
// fixed count. And every call starts on the first page, already loaded, so the
// call that lists the pages reads that page's components too, as many as fit
// beside the list. A file whose pages and palette each fit in one response
// takes one call for the variables, one for the page list and the first page,
// and one for each other page. A call refused for the limit fails the read,
// saying so, rather than as a page that can't be read.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { VERSION } from "./version.js";

export interface FigmaVariable {
  name: string;
  resolvedType: string;
  value: string;
  collection: string;
  mode: string;
}

export interface FigmaComponentInfo {
  name: string;
  variantProperties: { name: string; type: string; values: string[] }[];
  variantCount: number;
}

/** A page of the Figma file, as the page list returns it. */
export interface FigmaPage {
  id: string;
  name: string;
}

/**
 * The most a read returns in one call, in bytes of the JSON use_figma makes
 * of it: under the 20kb Figma documents, with room to spare, as in the skills'
 * templates. Bytes rather than characters, since a name in another script
 * takes two or three bytes a character.
 */
export const RESPONSE_GUARD = 17000;

/**
 * Shared by every read: `slice` returns the items from START that fit under
 * GUARD, with `next`, where the following call starts, or null after the
 * last. An item too big to return on its own is an error rather than a
 * response the limit would cut short. The plugin code returns an object,
 * which use_figma serializes as JSON, so that JSON is what is measured.
 */
const SLICE_PLUGIN_CODE = `
const GUARD = ${RESPONSE_GUARD};

function encodedBytes(value) {
  const json = JSON.stringify(value);
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

// describe(item) gives an item's entry, or null to leave it out; wrap(entries,
// next, total) gives what the call returns; label(entry) names an entry in an
// error.
async function slice(items, describe, wrap, label) {
  const taken = [];
  let size = encodedBytes(wrap([], items.length, items.length));
  while (START + taken.length < items.length && size <= GUARD) {
    const entry = await describe(items[START + taken.length]);
    taken.push(entry);
    if (entry !== null) size += encodedBytes(entry) + 1;
  }
  for (let cut = taken.length; ; cut--) {
    const entries = taken.slice(0, cut).filter(e => e !== null);
    const end = START + cut;
    const result = wrap(entries, end < items.length ? end : null, items.length);
    const bytes = encodedBytes(result);
    // A slice that reads nothing while items remain doesn't move on: refused,
    // like one too big, so the page list's call leaves the first page to a
    // call of its own.
    if (bytes <= GUARD && (cut > 0 || end >= items.length)) return result;
    if (entries.length <= 1) {
      throw new Error((entries.length ? label(entries[0]) : 'A slice') + ' comes to ' + bytes
        + ' bytes as use_figma returns it, more than the ' + GUARD + ' one call can carry under its 20kb response limit');
    }
  }
}
`.trim();

/**
 * Shared by the component reads: `readComponents(page, around)` returns a
 * loaded page's component sets, and its components outside any set, as a
 * slice from START, and `around(slice)` what the call returns.
 */
const COMPONENTS_PLUGIN_CODE = `
function describeComponent(node) {
  if (node.type !== 'COMPONENT_SET') {
    return { name: node.name, variantProperties: [], variantCount: 1 };
  }
  const defs = node.componentPropertyDefinitions || {};
  const props = [];
  for (const [key, def] of Object.entries(defs)) {
    if (def.type === 'VARIANT') {
      props.push({ name: key, type: 'VARIANT', values: def.variantOptions || [] });
    } else if (def.type === 'BOOLEAN') {
      props.push({ name: key, type: 'BOOLEAN', values: ['true', 'false'] });
    }
  }
  return { name: node.name, variantProperties: props, variantCount: node.children.length };
}

async function readComponents(page, around) {
  const nodes = page.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
    .filter(n => n.type === 'COMPONENT_SET' || (n.parent && n.parent.type !== 'COMPONENT_SET'));
  return slice(
    nodes,
    describeComponent,
    (items, next, total) => around({ page: page.name, total, next, items }),
    c => 'Component "' + c.name + '" on page "' + page.name + '"'
  );
}
`.trim();

const LIST_PAGES_PLUGIN_CODE = `
${COMPONENTS_PLUGIN_CODE}

// A page divider is a page with nothing on it, only a line in the page list
// (PageNode.isPageDivider): there is nothing to read, and no call to spend on
// switching to it. Left out here, so every slice is cut from the same list.
const list = await slice(
  figma.root.children.filter(p => !p.isPageDivider),
  p => ({ id: p.id, name: p.name }),
  (items, next, total) => ({ total, next, items }),
  p => 'Page "' + p.name + '"'
);

// The call starts on a page already loaded, the first, so the call that lists
// the pages from the start reads its components too, from 0, as many as fit
// beside the list. The client reads the rest, or the whole page if none fit
// or it can't be read here, in calls of the page's own.
if (START === 0) {
  const page = figma.currentPage;
  try {
    return await readComponents(page, first => ({ ...list, first: { id: page.id, ...first } }));
  } catch {
    // Read again in a call of the page's own, which says why if it fails.
  }
}
return list;
`.trim();

const READ_VARIABLES_PLUGIN_CODE = `
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const MAX_ALIAS_DEPTH = 8;

async function resolveAlias(varId, modeId, depth) {
  if (depth > MAX_ALIAS_DEPTH) return { value: '<alias-cycle>', type: 'STRING' };
  const v = await figma.variables.getVariableByIdAsync(varId);
  if (!v) return { value: '<missing>', type: 'STRING' };
  const mode = v.valuesByMode[modeId] ?? v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  if (mode && typeof mode === 'object' && 'type' in mode && mode.type === 'VARIABLE_ALIAS') {
    return resolveAlias(mode.id, modeId, depth + 1);
  }
  return { value: mode, type: v.resolvedType };
}

function rgbToHex(c) {
  const r = Math.round((c.r || 0) * 255);
  const g = Math.round((c.g || 0) * 255);
  const b = Math.round((c.b || 0) * 255);
  const a = c.a == null ? 1 : c.a;
  const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  if (a >= 1) return hex;
  return hex + Math.round(a * 255).toString(16).padStart(2, '0');
}

// Every variable in a collection that has the mode asked for, in order, so
// each call slices the same list.
const all = [];
for (const coll of collections) {
  const targetMode = MODE_NAME ? coll.modes.find(m => m.name === MODE_NAME) : coll.modes[0];
  if (!targetMode) continue;
  for (const varId of coll.variableIds) all.push({ coll, targetMode, varId });
}

async function describe({ coll, targetMode, varId }) {
  const v = await figma.variables.getVariableByIdAsync(varId);
  if (!v) return null;
  let raw = v.valuesByMode[targetMode.modeId] ?? v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  let type = v.resolvedType;
  if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'VARIABLE_ALIAS') {
    const resolved = await resolveAlias(raw.id, targetMode.modeId, 0);
    raw = resolved.value;
  }
  let value = '';
  if (type === 'COLOR' && raw && typeof raw === 'object' && 'r' in raw) {
    value = rgbToHex(raw);
  } else if (type === 'BOOLEAN') {
    value = String(Boolean(raw));
  } else {
    value = String(raw);
  }
  return { name: v.name, resolvedType: type, value, collection: coll.name, mode: targetMode.name };
}

return await slice(
  all,
  describe,
  (items, next, total) => ({ total, next, items }),
  v => 'Variable "' + v.collection + '/' + v.name + '"'
);
`.trim();

const READ_COMPONENTS_PLUGIN_CODE = `
${COMPONENTS_PLUGIN_CODE}

const page = await figma.getNodeByIdAsync(PAGE_ID);
if (!page || page.type !== 'PAGE') {
  throw new Error('No page with id ' + PAGE_ID);
}
// The page's nodes load only once the call switches to it, and only this page
// is searched: a search from figma.root would find the first page's too.
await figma.setCurrentPageAsync(page);
return await readComponents(page, s => s);
`.trim();

/** One call's plugin code: the read's constants, the slicing, then the read. */
function pluginCode(constants: Record<string, string | number | null>, read: string): string {
  const lines = Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`);
  return [...lines, SLICE_PLUGIN_CODE, read].join("\n");
}

interface Slice<T> {
  total: number;
  next: number | null;
  items: T[];
}

/** The components the page list's first call read on the page it started on, that page's id with them. */
type FirstPage = Slice<FigmaComponentInfo> & { id: string };

/**
 * A call Figma's MCP server refused for the seat's rate limit. Every read
 * fails with it as it is, not as a page that can't be read, since reading
 * again later, not fixing the file, is what gets past it.
 */
export class FigmaRateLimitError extends Error {
  constructor(reason: string) {
    super(`Figma's MCP server rate limit was hit: it caps each seat's tool calls a minute and a day (developers.figma.com/docs/figma-mcp-server/rate-limits-access). Run diff again later. Figma said: ${reason}`);
  }
}

/**
 * A refusal for the rate limit, in a tool result's text or a request's error:
 * Figma's MCP server has been reported to say a seat reached its "tool call
 * limit", or that a rate limit was hit. The SSE transport words an HTTP 429
 * as "HTTP 429"; the Streamable HTTP one gives the status as the error's code.
 * Kept to the server's wording, since a plugin error can carry the names of
 * the user's components and pages.
 */
const RATE_LIMITED = /tool call limit|\brate limit(ed)?\b|too many requests|\bHTTP 429\b/i;

/** The size guard's own refusal, which names a component or page and is never a rate limit. */
const GUARD_REFUSAL = "bytes as use_figma returns it, more than the";

const isRateLimit = (reason: string) => !reason.includes(GUARD_REFUSAL) && RATE_LIMITED.test(reason);

export class FigmaClient {
  private client: Client | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: VERSION }, {});
    const mcpUrl = new URL(this.url);

    try {
      await this.client.connect(new StreamableHTTPClientTransport(mcpUrl));
    } catch {
      await this.client.connect(new SSEClientTransport(mcpUrl));
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async getVariables(fileKey: string, mode?: string): Promise<FigmaVariable[]> {
    return this.readAll<FigmaVariable>(fileKey, "variables", "Read the variable collections and their values, a slice at a time",
      (start) => pluginCode({ MODE_NAME: mode ?? null, START: start }, READ_VARIABLES_PLUGIN_CODE));
  }

  /** Lists the file's pages, in order, leaving out page dividers. Reading them loads none. */
  async getPages(fileKey: string): Promise<FigmaPage[]> {
    return (await this.listPages(fileKey)).pages;
  }

  /**
   * Lists the pages, with the components the first call read on the page it
   * started on, as far as they fit beside the list, or null if none did.
   */
  private async listPages(fileKey: string): Promise<{ pages: FigmaPage[]; first: FirstPage | null }> {
    const description = "List the pages of the file, and read the component sets on the first";
    const codeFor = (start: number) => pluginCode({ START: start }, LIST_PAGES_PLUGIN_CODE);
    const opening = parseSlice<FigmaPage>(await this.callFigma(fileKey, codeFor(0), description), "pages") as Slice<FigmaPage> & { first?: unknown };
    const pages = await this.readAll<FigmaPage>(fileKey, "pages", description, codeFor, opening);
    const first = opening.first as FirstPage | undefined;
    return { pages, first: first && isSlice(first) && typeof first.id === "string" ? first : null };
  }

  /**
   * Reads the component sets, and the components outside any set, on every
   * page, a page at a time and in page order, the first page's starting with
   * what the page list's call read. A page that can't be read fails the whole
   * read, naming the page, rather than leave its components to be reported as
   * missing from Figma.
   */
  async getComponents(fileKey: string): Promise<FigmaComponentInfo[]> {
    const { pages, first } = await this.listPages(fileKey);
    const components: FigmaComponentInfo[] = [];
    for (const page of pages) {
      try {
        components.push(...await this.readAll<FigmaComponentInfo>(fileKey, `components on page "${page.name}"`,
          `Read the component sets and variant properties on page "${page.name}", a slice at a time`,
          (start) => pluginCode({ PAGE_ID: page.id, START: start }, READ_COMPONENTS_PLUGIN_CODE),
          first?.id === page.id ? first : undefined));
      } catch (err) {
        if (err instanceof FigmaRateLimitError) throw err;
        throw new Error(`Failed to read page "${page.name}" of the Figma file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return components;
  }

  /**
   * Calls a read from 0, or takes `first` as the slice from 0 when another
   * call read it, then from each `next` it returns until that is null, and
   * joins the slices. A slice that doesn't move on, or a total that changes
   * between calls, as when someone edits the file mid-read, is an error:
   * either would leave items read twice or not at all.
   */
  private async readAll<T>(fileKey: string, label: string, description: string, codeFor: (start: number) => string, first?: Slice<T>): Promise<T[]> {
    const items: T[] = [];
    let total: number | null = null;
    for (let start: number | null = 0; start !== null;) {
      const slice: Slice<T> = start === 0 && first ? first : parseSlice<T>(await this.callFigma(fileKey, codeFor(start), description), label);
      if (total !== null && slice.total !== total) {
        throw new Error(`The Figma file changed while its ${label} were read: ${total} at first, then ${slice.total}. Run diff again.`);
      }
      total = slice.total;
      if (slice.next !== null && (slice.next <= start || slice.next > slice.total)) {
        throw new Error(`use_figma returned ${label} from ${start} saying to read on from ${slice.next} of ${slice.total}`);
      }
      items.push(...slice.items);
      start = slice.next;
    }
    return items;
  }

  private async callFigma(fileKey: string, code: string, description: string): Promise<string[]> {
    if (!this.client) throw new Error("Not connected");
    let result: unknown;
    try {
      result = await this.client.callTool({
        name: "use_figma",
        arguments: { code, description, fileKey, skillNames: "figma-use" },
      });
    } catch (err) {
      // Past the limit, the server may refuse the request itself, with HTTP
      // 429, which the transport's error carries as its code.
      const reason = err instanceof Error ? err.message : String(err);
      if ((err as { code?: unknown } | null)?.code === 429) throw new FigmaRateLimitError(`HTTP 429, ${reason.trim()}`);
      if (isRateLimit(reason)) throw new FigmaRateLimitError(reason);
      throw err;
    }
    const r = result as { isError?: boolean; content?: { type: string; text?: string }[] };
    const texts = r.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text!) ?? [];
    // An error thrown in the plugin code, such as a slice refused as too big,
    // comes back as a result flagged isError, with the reason as text, not as
    // a protocol error. Read as a slice, that text would fail to parse and
    // hide the reason. The server's own refusal past the rate limit can come
    // back the same way.
    if (r.isError) {
      const reason = texts.join("\n") || "no reason given";
      if (isRateLimit(reason)) throw new FigmaRateLimitError(reason);
      throw new Error(`Figma MCP tool "use_figma" failed: ${reason}`);
    }
    if (!texts.length) {
      throw new Error(`use_figma returned no text content. Raw result: ${JSON.stringify(result).slice(0, 200)}`);
    }
    return texts;
  }
}

/**
 * Finds the slice in use_figma's text: the whole of one text part, the same
 * JSON-encoded again as a string, or the first object in text around it.
 */
function parseSlice<T>(texts: string[], label: string): Slice<T> {
  const parts = texts.map((t) => t.trim());
  const found = parts.map(extractFirstBalancedObject).filter((f): f is string => f !== null && !parts.includes(f));
  for (const candidate of [...parts, ...found]) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
      if (typeof value === "string") value = JSON.parse(value);
    } catch {
      continue;
    }
    if (isSlice(value)) return value as Slice<T>;
  }
  throw new Error(`Failed to parse Figma ${label} response. The use_figma tool may not return plugin code's return value. Got: ${texts.join("\n").trim().slice(0, 200)}`);
}

function isSlice(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as { total?: unknown; next?: unknown; items?: unknown };
  return Number.isInteger(v.total) && (v.next === null || Number.isInteger(v.next)) && Array.isArray(v.items);
}

/** The first balanced `{...}` in text, ignoring braces inside strings, or null. */
export function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
