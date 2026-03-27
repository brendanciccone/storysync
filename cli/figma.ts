/**
 * Figma MCP client — writes components and variants to a Figma file.
 *
 * Official Figma MCP server:
 *   - URL: https://mcp.figma.com/mcp
 *   - Transport: Streamable HTTP
 *   - Auth: Figma account auth (handled by the server)
 *   - Write tool: `use_figma` (general-purpose — create, edit, delete, inspect)
 *   - Read tools: `get_design_context`, `search_design_system`, etc.
 *
 * There are NO granular tools like create_component_set or create_variant.
 * All writes go through the single `use_figma` tool with a description of intent.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { FigmaComponentDefinition, FigmaVariantProperty } from "./mapper.js";

export interface FigmaConnectionOptions {
  /** Figma file key to write components into. */
  fileKey: string;
  /** Figma personal access token (used for non-interactive auth). */
  accessToken?: string;
  /** Override MCP server URL (default: https://mcp.figma.com/mcp). */
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
  private availableTools: Set<string> = new Set();

  constructor(options: FigmaConnectionOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: "0.1.0" }, {});

    if (this.options.mcpServerPath) {
      const env: Record<string, string> = {
        FIGMA_FILE_KEY: this.options.fileKey,
      };
      if (this.options.accessToken) {
        env.FIGMA_ACCESS_TOKEN = this.options.accessToken;
      }
      const transport = new StdioClientTransport({
        command: "node",
        args: [this.options.mcpServerPath],
        env,
      });
      await this.client.connect(transport);
    } else {
      const serverUrl = this.options.mcpServerUrl ?? "https://mcp.figma.com/mcp";
      const url = new URL(serverUrl);

      try {
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: this.options.accessToken
            ? { headers: { Authorization: `Bearer ${this.options.accessToken}` } }
            : undefined,
        });
        await this.client.connect(transport);
      } catch {
        // Fallback to SSE for older/third-party servers
        const transport = new SSEClientTransport(url);
        await this.client.connect(transport);
      }
    }

    await this.discoverTools();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  /** Discover what tools the server actually exposes. */
  private async discoverTools(): Promise<void> {
    this.ensureConnected();
    try {
      const result = await this.client!.listTools();
      this.availableTools = new Set(result.tools.map((t) => t.name));
    } catch {
      this.availableTools = new Set();
    }
  }

  getAvailableTools(): Set<string> {
    return this.availableTools;
  }

  /**
   * Check if a component already exists in the Figma file.
   * Uses search_design_system or get_design_context to look for it.
   * Returns the node ID if found, null otherwise.
   */
  async findExistingComponent(componentName: string): Promise<string | null> {
    this.ensureConnected();

    const searchTool = this.resolveToolName([
      "search_design_system",
      "get_design_context",
    ]);

    if (!searchTool) return null;

    try {
      const result = await this.client!.callTool({
        name: searchTool,
        arguments: {
          query: componentName,
          fileKey: this.options.fileKey,
        },
      });

      const text = this.extractText(result);
      // Try to find a matching component node ID
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          const match = parsed.find((item: Record<string, unknown>) =>
            (item.name as string)?.toLowerCase() === componentName.toLowerCase()
          );
          if (match) return (match.nodeId ?? match.id) as string;
        }
      } catch {
        // Response wasn't JSON — check for node IDs in text
        const nodeIdMatch = text.match(/(\d+:\d+)/);
        if (nodeIdMatch) return nodeIdMatch[1];
      }
    } catch {
      // Search not available or failed — proceed without idempotency check
    }

    return null;
  }

  /**
   * Write a component to Figma.
   *
   * Uses the `use_figma` tool (official) or falls back to granular tools
   * if available on third-party servers.
   */
  async writeComponent(
    definition: FigmaComponentDefinition,
    screenshots: Map<string, Buffer>,
    pageName?: string
  ): Promise<WriteResult> {
    this.ensureConnected();

    const page = pageName ?? this.options.pageName ?? "storysync";
    const hasUseFigma = this.availableTools.has("use_figma");
    const hasGranularTools = this.availableTools.has("create_component_set");

    if (hasUseFigma) {
      return this.writeComponentViaUseFigma(definition, screenshots, page);
    } else if (hasGranularTools) {
      return this.writeComponentViaGranularTools(definition, screenshots, page);
    } else if (this.availableTools.size === 0) {
      // Discovery failed — try use_figma first, fall back to granular
      try {
        return await this.writeComponentViaUseFigma(definition, screenshots, page);
      } catch {
        return this.writeComponentViaGranularTools(definition, screenshots, page);
      }
    } else {
      throw new Error(
        `Figma MCP server does not expose a write tool. Available tools: ${[...this.availableTools].join(", ")}`
      );
    }
  }

  /**
   * Write a component using the official `use_figma` tool.
   * This is a general-purpose tool — we describe what to create in structured detail.
   */
  private async writeComponentViaUseFigma(
    definition: FigmaComponentDefinition,
    screenshots: Map<string, Buffer>,
    pageName: string
  ): Promise<WriteResult> {
    // Build a structured description of the component to create
    const variantDesc = definition.variantProperties.map((p) => {
      const valuesStr = p.values.join(", ");
      return `  - ${p.name} (${p.type}): [${valuesStr}] (default: ${p.defaultValue})`;
    }).join("\n");

    const instruction = [
      `Create a component set in file ${this.options.fileKey} on page "${pageName}":`,
      ``,
      `Component name: ${definition.name}`,
      ``,
      `Variant properties:`,
      variantDesc || "  (no variant properties)",
      ``,
      `Create ${definition.variantCombinations.length} variants for all combinations of these properties.`,
      `Each variant should be named using the format: "property1=value1, property2=value2".`,
    ].join("\n");

    const result = await this.client!.callTool({
      name: "use_figma",
      arguments: {
        instruction,
        fileKey: this.options.fileKey,
      },
    });

    const nodeId = this.extractNodeId(this.extractText(result));

    // Attach screenshots if available and if there's a way to do it
    if (screenshots.size > 0) {
      await this.attachScreenshots(definition, screenshots, nodeId);
    }

    return {
      componentName: definition.name,
      figmaNodeId: nodeId,
      variantCount: definition.variantCombinations.length,
    };
  }

  /**
   * Write a component using granular tools (third-party MCP servers).
   */
  private async writeComponentViaGranularTools(
    definition: FigmaComponentDefinition,
    screenshots: Map<string, Buffer>,
    pageName: string
  ): Promise<WriteResult> {
    const variantProps = definition.variantProperties.map((p) =>
      this.formatVariantProperty(p)
    );

    // Create component set
    const createResult = await this.client!.callTool({
      name: "create_component_set",
      arguments: {
        fileKey: this.options.fileKey,
        pageName,
        name: definition.name,
        variantProperties: variantProps,
      },
    });

    const nodeId = this.extractNodeId(this.extractText(createResult));

    // Create each variant
    for (const combination of definition.variantCombinations) {
      const variantName = Object.entries(combination)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");

      try {
        await this.client!.callTool({
          name: "create_variant",
          arguments: {
            fileKey: this.options.fileKey,
            componentSetId: nodeId,
            name: variantName,
            properties: combination,
          },
        });
      } catch (err) {
        // Log but continue — partial creation is better than total failure
        console.error(`  Warning: failed to create variant "${variantName}": ${String(err)}`);
      }
    }

    if (screenshots.size > 0) {
      await this.attachScreenshots(definition, screenshots, nodeId);
    }

    return {
      componentName: definition.name,
      figmaNodeId: nodeId,
      variantCount: definition.variantCombinations.length,
    };
  }

  private async attachScreenshots(
    definition: FigmaComponentDefinition,
    screenshots: Map<string, Buffer>,
    _parentNodeId: string
  ): Promise<void> {
    // Only attempt if the server has an image attachment tool
    const imageTool = this.resolveToolName(["attach_image", "upload_image"]);
    if (!imageTool) return;

    for (const combination of definition.variantCombinations) {
      const key = this.buildScreenshotKey(definition.name, combination);
      const screenshot = screenshots.get(key);
      if (!screenshot) continue;

      const variantName = Object.entries(combination)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");

      try {
        await this.client!.callTool({
          name: imageTool,
          arguments: {
            fileKey: this.options.fileKey,
            imageData: screenshot.toString("base64"),
            name: `${definition.name} - ${variantName}`,
          },
        });
      } catch {
        // Screenshots are best-effort — don't fail the whole component
      }
    }
  }

  async ensurePage(pageName: string): Promise<string> {
    this.ensureConnected();

    // Try use_figma for official server
    if (this.availableTools.has("use_figma") || this.availableTools.size === 0) {
      try {
        const result = await this.client!.callTool({
          name: "use_figma",
          arguments: {
            instruction: `In file ${this.options.fileKey}, ensure a page named "${pageName}" exists. If it doesn't exist, create it.`,
            fileKey: this.options.fileKey,
          },
        });
        return this.extractText(result);
      } catch {
        // Fall through to granular tool
      }
    }

    if (this.availableTools.has("create_page")) {
      const result = await this.client!.callTool({
        name: "create_page",
        arguments: {
          fileKey: this.options.fileKey,
          name: pageName,
        },
      });
      return this.extractText(result);
    }

    return pageName;
  }

  private resolveToolName(candidates: string[]): string | null {
    if (this.availableTools.size > 0) {
      for (const name of candidates) {
        if (this.availableTools.has(name)) return name;
      }
      return null;
    }
    return candidates[0];
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

  private extractNodeId(text: string): string {
    try {
      const parsed = JSON.parse(text);
      return parsed.nodeId ?? parsed.id ?? parsed.node_id ?? text;
    } catch {
      // Try to find a node ID pattern in the text (e.g. "123:456")
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
