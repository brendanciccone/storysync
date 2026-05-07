import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { VERSION } from "./version.js";
import type { StorybookComponent, StorybookProp, PropType } from "./mapper.js";

export interface ComponentEntry {
  id: string;
  name: string;
  title?: string;
  category?: string;
  storyIds?: string[];
}

// Derives a Figma-friendly category label from a Storybook ID by stripping
// the kebab-cased component name from the end. Storybook IDs are
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

export class StorybookClient {
  private client: Client | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: VERSION }, {});
    const mcpUrl = new URL("/mcp", this.url);

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

  async listAvailableTools(): Promise<string[]> {
    if (!this.client) throw new Error("Not connected");
    const result = await this.client.listTools();
    return result.tools.map((t) => t.name);
  }

  async listComponents(): Promise<ComponentEntry[]> {
    try {
      const result = await this.call("list-all-documentation", { withStoryIds: true });
      return this.parseComponentList(result);
    } catch (err) {
      let toolMissing = false;
      try {
        const tools = await this.listAvailableTools();
        toolMissing = !tools.includes("list-all-documentation");
      } catch { /* tool listing failed */ }
      if (toolMissing) {
        throw new Error(
          "Storybook MCP is missing the docs tools (list-all-documentation, get-documentation).\n" +
            "  The docs tools require Storybook 10.1+ — they are not available in Storybook 9.x.\n" +
            "  Run `storysync init` to check your setup, or upgrade with: pnpm dlx storybook@latest upgrade",
        );
      }
      throw err;
    }
  }

  async getComponent(id: string, displayName?: string, title?: string, category?: string): Promise<StorybookComponent> {
    const text = await this.call("get-documentation", { id });
    const name = displayName ?? id;
    return { name, title, category, props: parseProps(text, name), stories: this.parseStories(name, text) };
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Not connected");
    const result = await this.client.callTool({ name: tool, arguments: args });
    const r = result as { content?: { type: string; text?: string }[] };
    const texts = r.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text!) ?? [];
    if (!texts.length) {
      throw new Error(`Storybook MCP tool "${tool}" returned no text content. Raw result: ${JSON.stringify(result).slice(0, 200)}`);
    }
    return texts.join("\n");
  }

  // Parses the markdown list from list-all-documentation.
  // Category is derived from the component ID prefix (Storybook IDs are
  // kebab-case versions of the title, so `ui-button` → category "UI").
  // Falls back to slashed names (`Forms/Button`) and section headings
  // when present, since not all Storybook MCP responses include IDs.
  private parseComponentList(text: string): ComponentEntry[] {
    const entries: ComponentEntry[] = [];
    let current: ComponentEntry | null = null;
    let currentSection: string | null = null;

    for (const line of text.split("\n")) {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
      if (heading) {
        currentSection = heading[1].trim();
        continue;
      }

      const m = line.match(/^[\-\*]\s+(?:\*\*)?([^*(\n]+?)(?:\*\*)?\s*\((?:id:\s*)?[`"']?([^)`"'\n]+)[`"']?\)/);
      if (m && !/^\s{2,}/.test(line)) {
        const rawName = m[1].trim();
        const id = m[2].trim();
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

        if (category && !title) {
          title = `${category}/${name}`;
        }

        current = { id, name, title, category, storyIds: [] };
        entries.push(current);
      } else if (current && /^\s{2,}/.test(line)) {
        const s = line.match(/[\-\*]\s+(?:\*\*)?[^*(\n]+?(?:\*\*)?\s*\((?:id:\s*)?[`"']?([^)`"'\n]+)[`"']?\)/);
        if (s) current.storyIds?.push(s[1].trim());
      }
    }
    return entries;
  }

  private parseStories(componentName: string, text: string): { id: string; name: string }[] {
    const stories: { id: string; name: string }[] = [];
    const seen = new Set<string>();

    for (const line of text.split("\n")) {
      const ids = line.match(/(?:id:\s*|storyId:\s*)[`"']([^`"']+)[`"']/g);
      if (!ids) continue;
      for (const raw of ids) {
        const id = raw.replace(/.*[`"']([^`"']+)[`"'].*/, "$1");
        if (seen.has(id) || !id.includes("--")) continue;
        seen.add(id);
        const slug = id.split("--").pop() ?? id;
        stories.push({ id, name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) });
      }
    }

    if (!stories.length) {
      stories.push({ id: `${componentName.toLowerCase()}--default`, name: "Default" });
    }
    return stories;
  }
}

// Extracts props from a Storybook MCP `get-documentation` response.
// Tries TypeScript type defs, then markdown argType tables, then JSX in
// story snippets — the official addon-mcp emits TS types only, but we
// fall back to snippets so argTypes-only components still produce variants.
export function parseProps(text: string, componentName?: string): StorybookProp[] {
  const fromTypes: StorybookProp[] = [];
  const codeBlocks = /```(?:typescript|ts|tsx)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = codeBlocks.exec(text)) !== null) {
    fromTypes.push(...parsePropsBlock(m[1]));
  }

  if (!fromTypes.length) {
    const inline = text.match(/export\s+type\s+Props\s*=\s*\{([\s\S]*?)\}/)
      ?? text.match(/export\s+interface\s+\w+\s*\{([\s\S]*?)\}/);
    if (inline) fromTypes.push(...parsePropsBlock(`export type Props = {${inline[1]}}`));
  }

  if (fromTypes.length) return fromTypes;

  const fromTable = parseArgTable(text);
  if (fromTable.length) return fromTable;

  return parseStorySnippets(text, componentName);
}

// Parses a `type X = { ... }` or `interface X { ... }` body into props.
// Skips comment lines so JSDoc above each prop doesn't confuse the parser.
export function parsePropsBlock(block: string): StorybookProp[] {
  const body = block.match(/(?:export\s+)?type\s+\w+\s*=\s*\{([\s\S]*)\}/)
    ?? block.match(/(?:export\s+)?interface\s+\w+(?:\s+extends\s+\w+(?:<[^>]*>)?)?\s*\{([\s\S]*)\}/);
  if (!body) return [];

  const props: StorybookProp[] = [];
  for (const line of body[1].split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("/") || t.startsWith("*") || t === "}") continue;

    const m = t.match(/^(\w+)(\?)?:\s*(.+?);?\s*$/);
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

// Splits a markdown table row by `|`, preserving cell positions even when
// some cells are empty. Strips the leading/trailing pipes if present and
// honors `\|` escapes inside cells.
function splitTableRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);

  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(buf.trim());
      buf = "";
    } else {
      buf += s[i];
    }
  }
  cells.push(buf.trim());
  return cells;
}

function isTableSeparator(row: string): boolean {
  const t = row.trim();
  if (!t.includes("-")) return false;
  // Allow leading/trailing pipes optional. Body must be only pipes, dashes,
  // colons, and whitespace.
  const stripped = t.replace(/^\|/, "").replace(/\|$/, "");
  return /^[\s\-:|]+$/.test(stripped) && stripped.includes("-");
}

// Parses Storybook argType/controls markdown tables. Storybook's official
// addon-mcp does not currently emit these, but third-party MCP servers and
// custom doc pages sometimes do — and the diff reporter prints them too.
// Recognizes columns: name/property/prop, type/control, default, options.
export function parseArgTable(text: string): StorybookProp[] {
  const props: StorybookProp[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i];
    const separator = lines[i + 1];
    if (!header.includes("|") || !separator || !isTableSeparator(separator)) continue;

    const headerCells = splitTableRow(header);
    const sepCells = splitTableRow(separator);
    if (headerCells.length < 2 || headerCells.length !== sepCells.length) continue;

    const cols = headerCells.map((c) => c.toLowerCase().replace(/\*+/g, "").trim());
    const nameIdx = cols.findIndex((c) => c === "name" || c === "property" || c === "prop");
    const typeIdx = cols.findIndex((c) => c === "type" || c === "control" || c === "control type");
    const defaultIdx = cols.findIndex((c) => c === "default" || c === "default value");
    const optionsIdx = cols.findIndex((c) => c === "options" || c === "values");
    if (nameIdx < 0 || (typeIdx < 0 && optionsIdx < 0)) continue;

    for (let j = i + 2; j < lines.length; j++) {
      const row = lines[j];
      if (!row.trim() || isTableSeparator(row)) break;
      if (!row.includes("|")) break;
      const cells = splitTableRow(row);
      if (cells.length !== headerCells.length) continue;

      const name = cells[nameIdx].replace(/[`*]/g, "").trim();
      if (!name || name === "-") continue;

      const typeStr = typeIdx >= 0 ? cells[typeIdx].replace(/`/g, "").trim() : "";
      const defaultRaw = defaultIdx >= 0 ? cells[defaultIdx].replace(/`/g, "").trim() : "";
      const optionsRaw = optionsIdx >= 0 ? cells[optionsIdx].replace(/`/g, "").trim() : "";

      const options = optionsRaw && optionsRaw !== "-"
        ? optionsRaw.split(/[,|]/).map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : [];

      const defaultValue = defaultRaw && defaultRaw !== "-"
        ? defaultRaw.replace(/^["']|["']$/g, "")
        : undefined;

      const ctrl = typeStr.toLowerCase();
      const isBoolean = ctrl === "boolean" || ctrl === "bool";
      const isSelect = ctrl === "select" || ctrl === "radio" || ctrl === "inline-radio"
        || ctrl === "check" || ctrl === "inline-check" || ctrl === "multi-select";

      let type: PropType;
      if (isBoolean) {
        type = { name: "boolean" };
      } else if (typeStr.includes("|")) {
        type = { name: "union", raw: typeStr };
      } else if (options.length) {
        type = { name: "union", value: options.map((o) => ({ name: "literal", raw: `"${o}"` })) };
      } else {
        type = { name: typeStr || "unknown" };
      }

      const prop: StorybookProp = { name, type, defaultValue, required: false };
      if (isBoolean) {
        prop.control = { type: "boolean" };
      } else if (options.length) {
        prop.control = { type: isSelect ? ctrl : "select", options };
      }
      props.push(prop);
    }
    break;
  }
  return props;
}

// Extracts prop usage from JSX in story code snippets. This is the fallback
// for components whose props live in stories' argTypes (no TS type), since
// the official addon-mcp omits those entirely. We accumulate values across
// snippets and emit a prop only when we see enough signal to be useful.
export function parseStorySnippets(text: string, componentName?: string): StorybookProp[] {
  if (!componentName) return [];

  type Acc = {
    stringValues: Set<string>;
    sawBooleanShorthand: boolean;
    sawBooleanTrue: boolean;
    sawBooleanFalse: boolean;
    sawNumber: boolean;
    sawUnknown: boolean;
  };
  const acc = new Map<string, Acc>();
  const ensure = (name: string): Acc => {
    let a = acc.get(name);
    if (!a) {
      a = { stringValues: new Set(), sawBooleanShorthand: false, sawBooleanTrue: false, sawBooleanFalse: false, sawNumber: false, sawUnknown: false };
      acc.set(name, a);
    }
    return a;
  };

  // Match the component's opening tag, allowing for whitespace and
  // multi-line attributes. Stop at the first `>` that isn't inside a
  // brace-expression or string.
  const escaped = componentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagStart = new RegExp(`<\\s*${escaped}(?![A-Za-z0-9_])`, "g");
  let match: RegExpExecArray | null;
  while ((match = tagStart.exec(text)) !== null) {
    const attrs = readAttributesUntilTagEnd(text, match.index + match[0].length);
    if (!attrs) continue;
    for (const { name, value, kind } of parseJsxAttributes(attrs)) {
      const a = ensure(name);
      if (kind === "string") a.stringValues.add(value as string);
      else if (kind === "boolean-shorthand") a.sawBooleanShorthand = true;
      else if (kind === "boolean-true") a.sawBooleanTrue = true;
      else if (kind === "boolean-false") a.sawBooleanFalse = true;
      else if (kind === "number") a.sawNumber = true;
      else a.sawUnknown = true;
    }
  }

  const props: StorybookProp[] = [];
  for (const [name, a] of acc) {
    const isBoolean = !a.stringValues.size && !a.sawNumber
      && (a.sawBooleanShorthand || a.sawBooleanTrue || a.sawBooleanFalse);

    if (isBoolean) {
      props.push({
        name,
        type: { name: "boolean" },
        control: { type: "boolean" },
        defaultValue: a.sawBooleanShorthand || a.sawBooleanTrue ? "true" : "false",
        required: false,
      });
      continue;
    }

    const values = [...a.stringValues];
    if (values.length >= 2) {
      props.push({
        name,
        type: { name: "union", value: values.map((v) => ({ name: "literal", raw: `"${v}"` })) },
        control: { type: "select", options: values },
        defaultValue: values[0],
        required: false,
      });
    }
    // Single-value props and unknown-only props are skipped — too little
    // signal to emit a Figma variant.
  }
  return props;
}

// Walks `text` from `start` and returns the substring up to the matching
// `>` (or `/>`) that closes a JSX opening tag, ignoring `>` inside strings
// or `{...}` expressions. Returns null if no end is found.
function readAttributesUntilTagEnd(text: string, start: number): string | null {
  let depth = 0;
  let i = start;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
    } else if (ch === ">" && depth === 0) {
      const slice = text.slice(start, i);
      return slice.endsWith("/") ? slice.slice(0, -1) : slice;
    }
    i++;
  }
  return null;
}

interface ParsedJsxAttr {
  name: string;
  value: string | null;
  kind: "string" | "boolean-shorthand" | "boolean-true" | "boolean-false" | "number" | "unknown";
}

// Parses a JSX attribute list (e.g. ` variant="primary" disabled size={3}`)
// into discrete attributes. Keeps it simple: skips spread, JSX fragments,
// and attributes whose expression we can't statically resolve.
function parseJsxAttributes(attrs: string): ParsedJsxAttr[] {
  const result: ParsedJsxAttr[] = [];
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    if (i >= attrs.length) break;
    if (attrs[i] === "{") {
      // Spread or stray expression: skip the whole `{...}` block.
      i = skipBraceBlock(attrs, i);
      continue;
    }
    const nameMatch = attrs.slice(i).match(/^([A-Za-z_][\w-]*)/);
    if (!nameMatch) { i++; continue; }
    const name = nameMatch[1];
    i += name.length;
    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    if (attrs[i] !== "=") {
      result.push({ name, value: null, kind: "boolean-shorthand" });
      continue;
    }
    i++;
    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    const ch = attrs[i];
    if (ch === '"' || ch === "'") {
      const end = attrs.indexOf(ch, i + 1);
      if (end < 0) break;
      result.push({ name, value: attrs.slice(i + 1, end), kind: "string" });
      i = end + 1;
    } else if (ch === "{") {
      const end = skipBraceBlock(attrs, i);
      const inner = attrs.slice(i + 1, end - 1).trim();
      result.push({ name, ...classifyExpression(inner) });
      i = end;
    } else {
      // Unrecognized; bail on this attribute.
      while (i < attrs.length && !/\s/.test(attrs[i])) i++;
    }
  }
  return result;
}

function skipBraceBlock(s: string, start: number): number {
  let depth = 0;
  let i = start;
  let quote: string | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return s.length;
}

function classifyExpression(expr: string): { value: string | null; kind: ParsedJsxAttr["kind"] } {
  const t = expr.trim();
  if (t === "true") return { value: "true", kind: "boolean-true" };
  if (t === "false") return { value: "false", kind: "boolean-false" };
  const strMatch = t.match(/^["'`]([^"'`]*)["'`]$/);
  if (strMatch) return { value: strMatch[1], kind: "string" };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: t, kind: "number" };
  return { value: null, kind: "unknown" };
}
