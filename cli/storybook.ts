import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StorybookComponent, StorybookProp, PropType } from "./mapper.js";

export interface ComponentEntry {
  id: string;
  name: string;
  storyIds?: string[];
}

export class StorybookClient {
  private client: Client | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: "0.2.0" }, {});
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

  async listComponents(): Promise<ComponentEntry[]> {
    const result = await this.call("list-all-documentation", { withStoryIds: true });
    return this.parseComponentList(result);
  }

  async getComponent(id: string, displayName?: string): Promise<StorybookComponent> {
    const text = await this.call("get-documentation", { id });
    const name = displayName ?? id;
    return { name, props: this.parseProps(text), stories: this.parseStories(name, text) };
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Not connected");
    const result = await this.client.callTool({ name: tool, arguments: args });
    const r = result as { content?: { type: string; text?: string }[] };
    const texts = r.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text!) ?? [];
    return texts.length ? texts.join("\n") : JSON.stringify(result);
  }

  // Parses the markdown list from list-all-documentation.
  // Format: - **Button** (id: `button`) - description
  //           - Primary (id: `button--primary`)
  private parseComponentList(text: string): ComponentEntry[] {
    const entries: ComponentEntry[] = [];
    let current: ComponentEntry | null = null;

    for (const line of text.split("\n")) {
      const m = line.match(/^[\-\*]\s+(?:\*\*)?([^*(\n]+?)(?:\*\*)?\s*\((?:id:\s*)?[`"']?([^)`"'\n]+)[`"']?\)/);
      if (m && !/^\s{2,}/.test(line)) {
        current = { name: m[1].trim(), id: m[2].trim(), storyIds: [] };
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
      const inline = text.match(/export\s+type\s+Props\s*=\s*\{([\s\S]*?)\}/);
      if (inline) props.push(...this.parsePropsBlock(`export type Props = {${inline[1]}}`));
    }
    return props;
  }

  private parsePropsBlock(block: string): StorybookProp[] {
    const body = block.match(/(?:export\s+)?type\s+\w+\s*=\s*\{([\s\S]*)\}/);
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
