import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StorybookComponent } from "./mapper.js";
import { parseComponentList, parseProps, parseStories } from "./parsers.js";
import type { ComponentEntry } from "./parsers.js";

export type { ComponentEntry } from "./parsers.js";

export class StorybookClient {
  private client: Client | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: "0.1.0" }, {});
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
    return parseComponentList(result);
  }

  async getComponent(id: string, displayName?: string): Promise<StorybookComponent> {
    const text = await this.call("get-documentation", { id });
    const name = displayName ?? id;
    return { name, props: parseProps(text), stories: parseStories(name, text) };
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Not connected");
    const result = await this.client.callTool({ name: tool, arguments: args });
    const r = result as { content?: { type: string; text?: string }[] };
    const texts = r.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text!) ?? [];
    return texts.length ? texts.join("\n") : JSON.stringify(result);
  }
}
