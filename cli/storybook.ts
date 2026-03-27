/**
 * Storybook MCP client. Reads components and their props via @storybook/addon-mcp.
 *
 * Tools:
 *   - list-all-documentation({ withStoryIds?: boolean }) → markdown list
 *   - get-documentation({ id: string }) → markdown with TypeScript Props type
 *
 * Transport: Streamable HTTP at /mcp (e.g. http://localhost:6006/mcp)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StorybookComponent, StorybookProp, StorybookStory, PropType } from "./mapper.js";

export interface ComponentEntry {
  id: string;
  name: string;
  storyIds?: string[];
}

export class StorybookClient {
  private client: Client | null = null;
  private url: string;

  constructor(options: { url: string }) {
    this.url = options.url;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: "0.1.0" }, {});
    const mcpUrl = new URL("/mcp", this.url);

    try {
      const transport = new StreamableHTTPClientTransport(mcpUrl);
      await this.client.connect(transport);
    } catch {
      // Fallback to SSE for older Storybook versions
      const transport = new SSEClientTransport(mcpUrl);
      await this.client.connect(transport);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  async listComponents(): Promise<ComponentEntry[]> {
    this.ensureConnected();

    const result = await this.client!.callTool({
      name: "list-all-documentation",
      arguments: { withStoryIds: true },
    });

    return this.parseComponentList(this.extractText(result));
  }

  async getComponent(componentId: string, displayName?: string): Promise<StorybookComponent> {
    this.ensureConnected();

    const result = await this.client!.callTool({
      name: "get-documentation",
      arguments: { id: componentId },
    });

    const text = this.extractText(result);
    const name = displayName ?? componentId;
    const props = this.parseTypeScriptProps(text);
    const stories = this.parseStories(name, text);

    return { name, props, stories };
  }

  /**
   * Parse component list from markdown.
   *
   * Official format:
   *   - **Button** (id: `button`) - A clickable button
   *     - Primary (id: `button--primary`)
   */
  private parseComponentList(text: string): ComponentEntry[] {
    const entries: ComponentEntry[] = [];
    const lines = text.split("\n");
    let current: ComponentEntry | null = null;

    for (const line of lines) {
      // Component line: - **Button** (id: `button`) - summary
      const componentMatch = line.match(
        /^[\-\*]\s+(?:\*\*)?([^*(\n]+?)(?:\*\*)?\s*\((?:id:\s*)?[`"']?([^)`"'\n]+)[`"']?\)/
      );

      if (componentMatch && !line.match(/^\s{2,}/)) {
        current = {
          name: componentMatch[1].trim(),
          id: componentMatch[2].trim(),
          storyIds: [],
        };
        entries.push(current);
        continue;
      }

      // Story sub-item:   - Primary (id: `button--primary`)
      if (current && /^\s{2,}/.test(line)) {
        const storyMatch = line.match(
          /[\-\*]\s+(?:\*\*)?([^*(\n]+?)(?:\*\*)?\s*\((?:id:\s*)?[`"']?([^)`"'\n]+)[`"']?\)/
        );
        if (storyMatch) {
          current.storyIds?.push(storyMatch[2].trim());
        }
      }
    }

    return entries;
  }

  /**
   * Parse TypeScript `export type Props = { ... }` blocks.
   *
   * Format:
   *   variant?: "default" | "destructive" = "default";
   *   disabled?: boolean = false;
   */
  private parseTypeScriptProps(text: string): StorybookProp[] {
    const props: StorybookProp[] = [];

    // Find TypeScript code blocks
    const codeBlockRegex = /```(?:typescript|ts|tsx)?\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      props.push(...this.parsePropsBlock(match[1]));
    }

    // Try without code fences
    if (props.length === 0) {
      const inlineMatch = text.match(/export\s+type\s+Props\s*=\s*\{([\s\S]*?)\}/);
      if (inlineMatch) {
        props.push(...this.parsePropsBlock(`export type Props = {${inlineMatch[1]}}`));
      }
    }

    return props;
  }

  private parsePropsBlock(block: string): StorybookProp[] {
    const props: StorybookProp[] = [];
    const bodyMatch = block.match(/(?:export\s+)?type\s+\w+\s*=\s*\{([\s\S]*)\}/);
    if (!bodyMatch) return props;

    for (const line of bodyMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("/**") || trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed === "}") continue;

      const propMatch = trimmed.match(/^(\w+)(\?)?:\s*(.+);?\s*$/);
      if (!propMatch) continue;

      const [, name, optional, rawTypeAndDefault] = propMatch;

      // Split on last ` = ` to separate type from default
      const lastEqIdx = rawTypeAndDefault.lastIndexOf(" = ");
      let typeStr: string;
      let defaultStr: string | undefined;

      if (lastEqIdx !== -1) {
        typeStr = rawTypeAndDefault.slice(0, lastEqIdx).trim();
        defaultStr = rawTypeAndDefault.slice(lastEqIdx + 3).replace(/;$/, "").trim();
      } else {
        typeStr = rawTypeAndDefault.replace(/;$/, "").trim();
      }

      const type = this.parseTypeString(typeStr);
      const defaultValue = defaultStr?.replace(/^["']|["']$/g, "");

      props.push({
        name,
        type,
        defaultValue: defaultValue ?? undefined,
        required: !optional,
      });
    }

    return props;
  }

  private parseStories(componentName: string, text: string): StorybookStory[] {
    const stories: StorybookStory[] = [];
    const seenIds = new Set<string>();

    for (const line of text.split("\n")) {
      const idMatch = line.match(/(?:id:\s*|storyId:\s*)[`"']([^`"']+)[`"']/g);
      if (idMatch) {
        for (const m of idMatch) {
          const id = m.replace(/.*[`"']([^`"']+)[`"'].*/, "$1");
          if (!seenIds.has(id) && id.includes("--")) {
            seenIds.add(id);
            const namePart = id.split("--").pop() ?? id;
            stories.push({
              id,
              name: namePart.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            });
          }
        }
      }
    }

    if (stories.length === 0) {
      stories.push({ id: `${componentName.toLowerCase()}--default`, name: "Default" });
    }

    return stories;
  }

  private parseTypeString(typeStr: string): PropType {
    const trimmed = typeStr.trim();
    if (trimmed.includes("|")) {
      return { name: "union", raw: trimmed };
    }
    return { name: trimmed };
  }

  private extractText(result: unknown): string {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    if (r.content && Array.isArray(r.content)) {
      const texts = r.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!);
      if (texts.length > 0) return texts.join("\n");
    }
    return JSON.stringify(result);
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("StorybookClient not connected. Call connect() first.");
    }
  }
}
