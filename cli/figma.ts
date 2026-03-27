/**
 * Figma MCP client — writes components and variants to a Figma file.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { FigmaComponentDefinition, FigmaVariantProperty } from "./mapper.js";

export interface FigmaConnectionOptions {
  /** Figma file key to write components into. */
  fileKey: string;
  /** Figma personal access token. */
  accessToken: string;
  /** Optional: URL of the Figma MCP server (SSE transport). */
  mcpServerUrl?: string;
  /** Optional: path to a local Figma MCP server binary (stdio transport). */
  mcpServerPath?: string;
  /** Page name in Figma to organize components into. Defaults to "storysync". */
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

    if (this.options.mcpServerPath) {
      const transport = new StdioClientTransport({
        command: "node",
        args: [this.options.mcpServerPath],
        env: {
          FIGMA_FILE_KEY: this.options.fileKey,
          FIGMA_ACCESS_TOKEN: this.options.accessToken,
        },
      });
      await this.client.connect(transport);
    } else {
      const serverUrl = this.options.mcpServerUrl ?? "https://figma.com/.mcp";
      const url = new URL(serverUrl);
      url.searchParams.set("fileKey", this.options.fileKey);
      url.searchParams.set("token", this.options.accessToken);
      const transport = new SSEClientTransport(url);
      await this.client.connect(transport);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  async ensurePage(pageName: string): Promise<string> {
    this.ensureConnected();

    const result = await this.client!.callTool({
      name: "create_page",
      arguments: {
        fileKey: this.options.fileKey,
        name: pageName,
      },
    });

    return this.extractText(result);
  }

  async writeComponent(
    definition: FigmaComponentDefinition,
    screenshots: Map<string, Buffer>,
    pageName?: string
  ): Promise<WriteResult> {
    this.ensureConnected();

    const page = pageName ?? this.options.pageName ?? "storysync";

    const variantProps = definition.variantProperties.map((p) =>
      this.formatVariantProperty(p)
    );

    const createResult = await this.client!.callTool({
      name: "create_component_set",
      arguments: {
        fileKey: this.options.fileKey,
        pageName: page,
        name: definition.name,
        variantProperties: variantProps,
      },
    });

    const nodeId = this.extractNodeId(createResult);

    for (const combination of definition.variantCombinations) {
      const variantName = Object.entries(combination)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");

      await this.client!.callTool({
        name: "create_variant",
        arguments: {
          fileKey: this.options.fileKey,
          componentSetId: nodeId,
          name: variantName,
          properties: combination,
        },
      });

      const screenshotKey = this.buildScreenshotKey(definition.name, combination);
      const screenshot = screenshots.get(screenshotKey);

      if (screenshot) {
        await this.client!.callTool({
          name: "attach_image",
          arguments: {
            fileKey: this.options.fileKey,
            nodeId,
            imageData: screenshot.toString("base64"),
            name: `${definition.name} - ${variantName}`,
          },
        });
      }
    }

    return {
      componentName: definition.name,
      figmaNodeId: nodeId,
      variantCount: definition.variantCombinations.length,
    };
  }

  private formatVariantProperty(prop: FigmaVariantProperty): Record<string, unknown> {
    return {
      name: prop.name,
      type: prop.type,
      values: prop.values,
      defaultValue: prop.defaultValue,
    };
  }

  private buildScreenshotKey(
    componentName: string,
    combination: Record<string, string>
  ): string {
    const parts = Object.entries(combination)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`);
    return `${componentName}__${parts.join("__")}`;
  }

  private extractNodeId(result: unknown): string {
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      return parsed.nodeId ?? parsed.id ?? text;
    } catch {
      return text;
    }
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
      throw new Error("FigmaClient not connected. Call connect() first.");
    }
  }
}
