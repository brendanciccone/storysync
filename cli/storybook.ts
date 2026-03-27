/**
 * Storybook MCP client — reads components and their props from a running Storybook.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StorybookComponent, StorybookProp, StorybookStory, PropType, ArgTypeControl } from "./mapper.js";

export interface StorybookConnectionOptions {
  /** URL of the running Storybook instance. */
  url: string;
  /** Optional: path to a local Storybook MCP server binary (stdio transport). */
  mcpServerPath?: string;
}

export class StorybookClient {
  private client: Client | null = null;
  private options: StorybookConnectionOptions;

  constructor(options: StorybookConnectionOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: "0.1.0" }, {});

    if (this.options.mcpServerPath) {
      const transport = new StdioClientTransport({
        command: "node",
        args: [this.options.mcpServerPath],
        env: { STORYBOOK_URL: this.options.url },
      });
      await this.client.connect(transport);
    } else {
      const sseUrl = new URL("/.mcp", this.options.url);
      const transport = new SSEClientTransport(sseUrl);
      await this.client.connect(transport);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  async listComponents(): Promise<string[]> {
    this.ensureConnected();

    const result = await this.client!.callTool({
      name: "list_components",
      arguments: {},
    });

    const text = this.extractText(result);
    return JSON.parse(text) as string[];
  }

  async getComponent(componentName: string): Promise<StorybookComponent> {
    this.ensureConnected();

    const result = await this.client!.callTool({
      name: "get_component",
      arguments: { name: componentName },
    });

    const raw = JSON.parse(this.extractText(result));

    // Support both docgen-style props array and argTypes-style object
    const rawProps = this.normalizeRawProps(raw);

    const props: StorybookProp[] = rawProps.map((p: Record<string, unknown>) => ({
      name: p.name as string,
      type: this.normalizeType(p.type),
      description: p.description as string | undefined,
      defaultValue: p.defaultValue,
      required: p.required as boolean | undefined,
      control: this.normalizeControl(p.control ?? p.argType),
    }));

    const stories: StorybookStory[] = (raw.stories ?? []).map((s: Record<string, unknown>) => ({
      id: s.id as string,
      name: s.name as string,
      args: s.args as Record<string, unknown> | undefined,
    }));

    return {
      name: raw.name ?? componentName,
      props,
      stories,
    };
  }

  async getStoryScreenshotUrl(storyId: string): Promise<string> {
    this.ensureConnected();

    const result = await this.client!.callTool({
      name: "get_story_url",
      arguments: { storyId },
    });

    return this.extractText(result);
  }

  /**
   * Normalize raw props from Storybook MCP — handles both:
   * - docgen-style: { props: [{ name, type, ... }] }
   * - argTypes-style: { argTypes: { propName: { control, options, ... } } }
   */
  private normalizeRawProps(raw: Record<string, unknown>): Record<string, unknown>[] {
    // If there's a props array, use it directly
    if (Array.isArray(raw.props) && raw.props.length > 0) {
      return raw.props as Record<string, unknown>[];
    }

    // If there's an argTypes object, convert it to an array
    if (raw.argTypes && typeof raw.argTypes === "object" && !Array.isArray(raw.argTypes)) {
      const argTypes = raw.argTypes as Record<string, Record<string, unknown>>;
      return Object.entries(argTypes).map(([name, argType]) => ({
        name,
        type: argType.type ?? { name: argType.control?.type ?? "unknown" },
        description: argType.description,
        defaultValue: argType.defaultValue,
        required: argType.required,
        control: argType.control ?? (argType.options ? { type: "select", options: argType.options } : undefined),
        argType,
      }));
    }

    // Fallback: try props as an object keyed by name (another common format)
    if (raw.props && typeof raw.props === "object" && !Array.isArray(raw.props)) {
      const propsObj = raw.props as Record<string, Record<string, unknown>>;
      return Object.entries(propsObj).map(([name, prop]) => ({
        name,
        ...prop,
      }));
    }

    return [];
  }

  private normalizeControl(raw: unknown): ArgTypeControl | undefined {
    if (!raw || typeof raw !== "object") return undefined;

    const obj = raw as Record<string, unknown>;

    // Direct control object: { type: "select", options: [...] }
    if (obj.type || obj.options) {
      return {
        type: obj.type as string | undefined,
        options: Array.isArray(obj.options)
          ? obj.options.map((o) => String(o))
          : undefined,
      };
    }

    // Nested: { control: { type: "select" }, options: [...] }
    if (obj.control && typeof obj.control === "object") {
      const ctrl = obj.control as Record<string, unknown>;
      return {
        type: ctrl.type as string | undefined,
        options: Array.isArray(obj.options)
          ? obj.options.map((o) => String(o))
          : Array.isArray(ctrl.options)
            ? ctrl.options.map((o) => String(o))
            : undefined,
      };
    }

    return undefined;
  }

  private normalizeType(raw: unknown): PropType {
    if (typeof raw === "string") {
      return { name: raw };
    }

    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      return {
        name: (obj.name as string) ?? "unknown",
        value: obj.value as string[] | PropType[] | undefined,
        raw: obj.raw as string | undefined,
      };
    }

    return { name: "unknown" };
  }

  private extractText(result: unknown): string {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    if (r.content && Array.isArray(r.content)) {
      const textContent = r.content.find((c) => c.type === "text");
      if (textContent?.text) return textContent.text;
    }
    return JSON.stringify(result);
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("StorybookClient not connected. Call connect() first.");
    }
  }
}
