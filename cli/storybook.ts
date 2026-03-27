/**
 * Storybook MCP client — reads components and their props via the official
 * @storybook/addon-mcp server.
 *
 * Real tools (kebab-case):
 *   - list-all-documentation: lists all components with IDs and metadata
 *   - get-documentation: gets full documentation for a component (props, stories, etc.)
 *   - get-documentation-for-story: gets documentation for a specific story
 *   - preview-stories: preview rendered stories
 *   - run-story-tests: run component/accessibility tests
 *
 * Transport: Streamable HTTP at /mcp (e.g. http://localhost:6006/mcp)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StorybookComponent, StorybookProp, StorybookStory, PropType, ArgTypeControl } from "./mapper.js";

export interface StorybookConnectionOptions {
  /** URL of the running Storybook instance (e.g. http://localhost:6006). */
  url: string;
  /** Optional: path to a local MCP server binary (stdio transport). */
  mcpServerPath?: string;
}

export class StorybookClient {
  private client: Client | null = null;
  private options: StorybookConnectionOptions;
  private availableTools: Set<string> = new Set();

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
      // Official addon-mcp endpoint is /mcp, using Streamable HTTP.
      // Fall back to SSE if Streamable HTTP fails (older versions).
      const mcpUrl = new URL("/mcp", this.options.url);
      try {
        const transport = new StreamableHTTPClientTransport(mcpUrl);
        await this.client.connect(transport);
      } catch {
        // Fallback: try SSE transport for older Storybook MCP versions
        const sseUrl = new URL("/mcp", this.options.url);
        const transport = new SSEClientTransport(sseUrl);
        await this.client.connect(transport);
      }
    }

    // Discover available tools so we can adapt to different server versions
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
      // If tool discovery fails, we'll try known tool names and handle errors per-call
      this.availableTools = new Set();
    }
  }

  /** Check if a specific tool is available on this server. */
  hasToolAvailable(name: string): boolean {
    return this.availableTools.size === 0 || this.availableTools.has(name);
  }

  /** Get the set of discovered tool names (empty if discovery failed). */
  getAvailableTools(): Set<string> {
    return this.availableTools;
  }

  async listComponents(): Promise<string[]> {
    this.ensureConnected();

    // Official tool: list-all-documentation
    // Fallback: list_components, list_all_components (third-party servers)
    const toolName = this.resolveToolName([
      "list-all-documentation",
      "list_all_components",
      "list_components",
      "getComponentList",
    ]);

    const result = await this.client!.callTool({
      name: toolName,
      arguments: {},
    });

    const text = this.extractText(result);
    return this.parseComponentList(text);
  }

  async getComponent(componentName: string): Promise<StorybookComponent> {
    this.ensureConnected();

    // Official tool: get-documentation
    // Fallback: get_component, get_component_documentation (third-party)
    const toolName = this.resolveToolName([
      "get-documentation",
      "get_component",
      "get_component_documentation",
      "getComponentsProps",
    ]);

    const result = await this.client!.callTool({
      name: toolName,
      arguments: { name: componentName, component: componentName },
    });

    const text = this.extractText(result);
    return this.parseComponentDocumentation(componentName, text);
  }

  async getStoryUrl(storyId: string): Promise<string> {
    // Construct the URL directly — this doesn't need a tool call.
    const base = this.options.url.replace(/\/$/, "");
    return `${base}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;
  }

  /**
   * Pick the first available tool from a list of candidates.
   * If tool discovery succeeded, pick the first match.
   * If discovery failed (empty set), use the first candidate.
   */
  private resolveToolName(candidates: string[]): string {
    if (this.availableTools.size > 0) {
      for (const name of candidates) {
        if (this.availableTools.has(name)) return name;
      }
      // None matched — use first candidate and let it fail with a clear error
    }
    return candidates[0];
  }

  /**
   * Parse a component list from the MCP response.
   * Handles multiple formats:
   *   - JSON array of strings: ["Button", "Input"]
   *   - JSON array of objects: [{ name: "Button", ... }]
   *   - JSON object with components key: { components: [...] }
   *   - MDX/documentation text with component names
   */
  private parseComponentList(text: string): string[] {
    // Try JSON first
    try {
      const parsed = JSON.parse(text);

      // Bare array of strings
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        return parsed;
      }

      // Array of objects with name field
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") {
        return parsed
          .map((v) => v.name ?? v.component ?? v.title)
          .filter((v): v is string => typeof v === "string");
      }

      // Object with a components/items key
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        const arr = parsed.components ?? parsed.items ?? parsed.stories ?? parsed.docs;
        if (Array.isArray(arr)) {
          return arr.map((v: unknown) =>
            typeof v === "string" ? v : (v as Record<string, string>).name ?? (v as Record<string, string>).title
          ).filter((v): v is string => typeof v === "string");
        }
      }
    } catch {
      // Not JSON — parse as documentation text
    }

    // Parse MDX/text documentation: look for component names in headings or lists
    const names: string[] = [];
    const lines = text.split("\n");
    for (const line of lines) {
      // Match markdown headings: ## Button, ### Input
      const headingMatch = line.match(/^#{1,4}\s+(.+?)(?:\s*\{.*\})?\s*$/);
      if (headingMatch) {
        const name = headingMatch[1].trim();
        // Skip generic headings
        if (!["components", "documentation", "overview", "api", "props"].includes(name.toLowerCase())) {
          names.push(name);
        }
      }
      // Match list items: - Button, * Input
      const listMatch = line.match(/^[\-\*]\s+\[?([A-Z][a-zA-Z0-9]*)\]?/);
      if (listMatch) {
        names.push(listMatch[1]);
      }
    }

    return [...new Set(names)];
  }

  /**
   * Parse component documentation into our internal StorybookComponent format.
   * Handles structured JSON or MDX documentation from either official or third-party servers.
   */
  private parseComponentDocumentation(componentName: string, text: string): StorybookComponent {
    // Try structured JSON first
    try {
      const raw = JSON.parse(text);
      return this.parseStructuredComponent(componentName, raw);
    } catch {
      // Not JSON — parse as documentation text
    }

    // Parse documentation/MDX format
    return this.parseDocumentationText(componentName, text);
  }

  /**
   * Parse a structured JSON response into StorybookComponent.
   * Handles docgen-style, argTypes-style, and mixed formats.
   */
  private parseStructuredComponent(componentName: string, raw: Record<string, unknown>): StorybookComponent {
    const rawProps = this.normalizeRawProps(raw);

    const props: StorybookProp[] = rawProps.map((p: Record<string, unknown>) => ({
      name: p.name as string,
      type: this.normalizeType(p.type),
      description: p.description as string | undefined,
      defaultValue: p.defaultValue,
      required: p.required as boolean | undefined,
      control: this.normalizeControl(p.control ?? p.argType),
    }));

    const stories: StorybookStory[] = this.extractStories(raw);

    return {
      name: raw.name as string ?? componentName,
      props,
      stories,
    };
  }

  /**
   * Parse documentation text (MDX/Markdown) to extract props and stories.
   * This handles the official Storybook MCP which returns documentation, not raw data.
   */
  private parseDocumentationText(componentName: string, text: string): StorybookComponent {
    const props: StorybookProp[] = [];
    const stories: StorybookStory[] = [];

    const lines = text.split("\n");
    let inPropsTable = false;
    let inStoriesSection = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Detect props/API table section
      if (/^#{1,4}\s+(Props|API|Properties|Args|ArgTypes)/i.test(line)) {
        inPropsTable = true;
        inStoriesSection = false;
        continue;
      }

      // Detect stories section
      if (/^#{1,4}\s+(Stories|Examples|Variants)/i.test(line)) {
        inPropsTable = false;
        inStoriesSection = true;
        continue;
      }

      // Exit section on next heading
      if (/^#{1,4}\s+/.test(line) && !/(Props|API|Properties|Args|Stories|Examples|Variants)/i.test(line)) {
        inPropsTable = false;
        inStoriesSection = false;
        continue;
      }

      // Parse props table rows: | propName | type | default | description |
      if (inPropsTable && line.startsWith("|") && !line.includes("---")) {
        const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
        if (cells.length >= 2) {
          const name = cells[0].replace(/`/g, "").trim();
          const typeStr = cells[1].replace(/`/g, "").trim();

          // Skip header row
          if (name.toLowerCase() === "name" || name.toLowerCase() === "prop") continue;

          const prop = this.parsePropFromDocRow(name, typeStr, cells[2], cells[3]);
          if (prop) props.push(prop);
        }
      }

      // Parse props from definition list format: **propName** (`type`) - description
      if (inPropsTable) {
        const defMatch = line.match(/\*\*(\w+)\*\*\s*(?:\(`?([^)]+)`?\))?/);
        if (defMatch) {
          const prop = this.parsePropFromDocRow(defMatch[1], defMatch[2] ?? "unknown", undefined, undefined);
          if (prop) props.push(prop);
        }
      }

      // Parse story references
      if (inStoriesSection) {
        // Story ID references: story-button--primary
        const storyIdMatch = line.match(/story[_-](\S+)/i);
        if (storyIdMatch) {
          const id = storyIdMatch[1];
          stories.push({ id, name: id.replace(/--/g, "/").replace(/-/g, " ") });
        }
        // Story name in list: - Primary, - Destructive
        const storyListMatch = line.match(/^[\-\*]\s+(.+)/);
        if (storyListMatch && !storyIdMatch) {
          const name = storyListMatch[1].trim();
          const id = `${componentName.toLowerCase()}--${name.toLowerCase().replace(/\s+/g, "-")}`;
          stories.push({ id, name });
        }
      }
    }

    // If no stories found, create a default one
    if (stories.length === 0) {
      stories.push({
        id: `${componentName.toLowerCase()}--default`,
        name: "Default",
      });
    }

    return { name: componentName, props, stories };
  }

  private parsePropFromDocRow(
    name: string,
    typeStr: string | undefined,
    defaultStr: string | undefined,
    descriptionStr: string | undefined
  ): StorybookProp | null {
    if (!name || name.length === 0) return null;

    const cleanType = (typeStr ?? "unknown").replace(/`/g, "").trim();
    const type = this.parseTypeString(cleanType);
    const defaultValue = defaultStr?.replace(/`/g, "").trim();

    return {
      name,
      type,
      description: descriptionStr?.trim(),
      defaultValue: defaultValue === "-" || defaultValue === "" ? undefined : defaultValue,
    };
  }

  /**
   * Parse a type string from documentation into a PropType.
   * e.g. "'sm' | 'md' | 'lg'" → { name: "union", raw: "'sm' | 'md' | 'lg'" }
   * e.g. "boolean" → { name: "boolean" }
   * e.g. "enum" → { name: "enum" }
   */
  private parseTypeString(typeStr: string): PropType {
    const trimmed = typeStr.trim();

    // Union of string literals: 'a' | 'b' | 'c' or "a" | "b" | "c"
    if (trimmed.includes("|")) {
      const parts = trimmed.split("|").map((p) => p.trim());
      const allQuoted = parts.every((p) => /^["'`].*["'`]$/.test(p));

      if (allQuoted) {
        return { name: "union", raw: trimmed };
      }

      // Mixed union — still return it, the mapper will filter
      return { name: "union", raw: trimmed };
    }

    return { name: trimmed };
  }

  /**
   * Normalize raw props from structured JSON — handles:
   *   - docgen-style: { props: [{ name, type, ... }] }
   *   - argTypes-style: { argTypes: { propName: { control, options, ... } } }
   *   - props-as-object: { props: { propName: { type, ... } } }
   */
  private normalizeRawProps(raw: Record<string, unknown>): Record<string, unknown>[] {
    if (Array.isArray(raw.props) && raw.props.length > 0) {
      return raw.props as Record<string, unknown>[];
    }

    if (raw.argTypes && typeof raw.argTypes === "object" && !Array.isArray(raw.argTypes)) {
      const argTypes = raw.argTypes as Record<string, Record<string, unknown>>;
      return Object.entries(argTypes).map(([name, argType]) => {
        const controlObj = argType.control as Record<string, unknown> | undefined;
        return {
          name,
          type: argType.type ?? { name: controlObj?.type ?? "unknown" },
          description: argType.description,
          defaultValue: argType.defaultValue,
          required: argType.required,
          control: argType.control ?? (argType.options ? { type: "select", options: argType.options } : undefined),
        };
      });
    }

    if (raw.props && typeof raw.props === "object" && !Array.isArray(raw.props)) {
      const propsObj = raw.props as Record<string, Record<string, unknown>>;
      return Object.entries(propsObj).map(([name, prop]) => ({
        name,
        ...prop,
      }));
    }

    return [];
  }

  private extractStories(raw: Record<string, unknown>): StorybookStory[] {
    const storiesRaw = raw.stories;
    if (!storiesRaw) return [];

    if (Array.isArray(storiesRaw)) {
      return storiesRaw.map((s: unknown) => {
        if (typeof s === "string") return { id: s, name: s };
        const obj = s as Record<string, unknown>;
        return {
          id: (obj.id ?? obj.storyId ?? obj.name) as string,
          name: (obj.name ?? obj.title ?? obj.id) as string,
          args: obj.args as Record<string, unknown> | undefined,
        };
      });
    }

    return [];
  }

  private normalizeControl(raw: unknown): ArgTypeControl | undefined {
    if (!raw || typeof raw !== "object") return undefined;

    const obj = raw as Record<string, unknown>;

    if (obj.type || obj.options) {
      return {
        type: obj.type as string | undefined,
        options: Array.isArray(obj.options)
          ? obj.options.map((o) => String(o))
          : undefined,
      };
    }

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
      return this.parseTypeString(raw);
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
