/**
 * Figma MCP client — writes components to a Figma file via the `use_figma` tool.
 *
 * Official remote server: https://mcp.figma.com/mcp
 * Transport: Streamable HTTP
 * Auth: OAuth 2.0 (handled by the MCP transport layer)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FigmaComponentDefinition } from "./mapper.js";

export interface FigmaConnectionOptions {
  fileKey: string;
  accessToken?: string;
  pageName?: string;
}

export interface WriteResult {
  componentName: string;
  figmaNodeId: string;
  variantCount: number;
}

export class FigmaClient {
  private client: Client | null = null;
  private options: FigmaConnectionOptions;

  constructor(options: FigmaConnectionOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: "0.1.0" }, {});
    const url = new URL("https://mcp.figma.com/mcp");

    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: this.options.accessToken
          ? { headers: { Authorization: `Bearer ${this.options.accessToken}` } }
          : undefined,
      });
      await this.client.connect(transport);
    } catch {
      const transport = new SSEClientTransport(url);
      await this.client.connect(transport);
    }

    // Verify write capability
    const result = await this.client.listTools();
    const tools = new Set(result.tools.map((t) => t.name));
    if (tools.size > 0 && !tools.has("use_figma")) {
      throw new Error(
        "Figma MCP server is read-only (no use_figma tool). Write operations require the remote server at https://mcp.figma.com/mcp"
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  async ensurePage(pageName: string): Promise<void> {
    this.ensureConnected();
    await this.client!.callTool({
      name: "use_figma",
      arguments: {
        instruction: `In file ${this.options.fileKey}, ensure a page named "${pageName}" exists. If it doesn't exist, create it.`,
        fileKey: this.options.fileKey,
      },
    });
  }

  async writeComponent(definition: FigmaComponentDefinition, pageName?: string): Promise<WriteResult> {
    this.ensureConnected();
    const page = pageName ?? this.options.pageName ?? "storysync";

    const variantDesc = definition.variantProperties
      .map((p) => `  - ${p.name} (${p.type}): [${p.values.join(", ")}] (default: ${p.defaultValue})`)
      .join("\n");

    const instruction = [
      `Create a component set in file ${this.options.fileKey} on page "${page}":`,
      ``,
      `Component name: ${definition.name}`,
      ``,
      `Variant properties:`,
      variantDesc || `  (no variant properties)`,
      ``,
      `Create ${definition.variantCombinations.length} variants for all combinations of these properties.`,
      `Each variant should be named using the format: "property1=value1, property2=value2".`,
    ].join("\n");

    const result = await this.client!.callTool({
      name: "use_figma",
      arguments: { instruction, fileKey: this.options.fileKey },
    });

    const nodeId = this.extractNodeId(this.extractText(result));

    return {
      componentName: definition.name,
      figmaNodeId: nodeId,
      variantCount: definition.variantCombinations.length,
    };
  }

  private extractNodeId(text: string): string {
    try {
      const parsed = JSON.parse(text);
      return parsed.nodeId ?? parsed.id ?? parsed.node_id ?? text;
    } catch {
      const match = text.match(/\b(\d+:\d+)\b/);
      if (match) return match[1];
      return text.slice(0, 100);
    }
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
      throw new Error("FigmaClient not connected. Call connect() first.");
    }
  }
}
