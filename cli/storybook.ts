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
    return { name, title, category, props: this.parseProps(text), stories: this.parseStories(id, text) };
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

  // Extracts props from TypeScript type definitions in the documentation.
  // Looks for `export type Props = { ... }` blocks in code fences.
  private parseProps(text: string): StorybookProp[] {
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
    for (const line of body[1].split("\n")) {
      const t = line.trim();
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

      const cols = header.split("|").map((c) => c.trim().toLowerCase()).filter(Boolean);
      const nameIdx = cols.findIndex((c) => c === "name" || c === "property" || c === "prop");
      const typeIdx = cols.findIndex((c) => c === "type" || c === "control");
      const defaultIdx = cols.findIndex((c) => c === "default" || c === "default value");
      if (nameIdx < 0 || typeIdx < 0) continue;

      for (let j = i + 2; j < lines.length; j++) {
        const row = lines[j];
        if (!row.trim().startsWith("|")) break;
        const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
        if (cells.length <= Math.max(nameIdx, typeIdx)) continue;

        const name = cells[nameIdx].replace(/`/g, "").trim();
        const typeStr = cells[typeIdx].replace(/`/g, "").replace(/\\\|/g, "|").trim();
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

// Matches an ID label followed by a story ID, quoted or bare. Storybook's
// addon-mcp writes `Story ID: forms-button--default` unquoted, so requiring
// quotes here (as an earlier version did) missed every real story and fell
// through to the guessed fallback below.
//
// Requiring the `--` separator is what keeps this from also matching the
// component's own `ID: forms-button` line.
const STORY_ID_PATTERN = /(?:story[\s_-]*id|storyid|id)\s*:\s*[`"']?([A-Za-z0-9][A-Za-z0-9_-]*--[A-Za-z0-9_-]+)[`"']?/gi;

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
