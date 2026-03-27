/**
 * Storybook MCP client — reads components and their props via the official
 * @storybook/addon-mcp server.
 *
 * Real tools (from storybookjs/mcp source):
 *   - list-all-documentation: lists components with IDs and summaries
 *       params: { withStoryIds?: boolean }
 *       returns: markdown list with component IDs and optionally story IDs
 *   - get-documentation: gets full docs for a component by ID
 *       params: { id: string, storybookId?: string }
 *       returns: markdown with TypeScript Props type definition + story snippets
 *   - get-documentation-for-story: gets docs for a specific story
 *       params: { componentId: string, storyName: string }
 *   - preview-stories: preview rendered stories
 *   - run-story-tests: run component/accessibility tests
 *
 * Transport: Streamable HTTP at /mcp (e.g. http://localhost:6006/mcp)
 *
 * The response for get-documentation formats props as TypeScript type definitions:
 *   export type Props = {
 *     variant?: "default" | "destructive" = "default";
 *     disabled?: boolean = false;
 *     size?: "sm" | "md" | "lg";
 *   }
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

/** A component entry from list-all-documentation. */
export interface ComponentEntry {
  /** Component ID used with get-documentation (e.g. "button", "ui-input"). */
  id: string;
  /** Display name (e.g. "Button", "Input"). */
  name: string;
  /** Story IDs if withStoryIds was true. */
  storyIds?: string[];
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
        const sseUrl = new URL("/mcp", this.options.url);
        const transport = new SSEClientTransport(sseUrl);
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
   * List all components available in Storybook.
   * Returns ComponentEntry objects with both ID and display name,
   * plus story IDs when available.
   */
  async listComponents(): Promise<ComponentEntry[]> {
    this.ensureConnected();

    const toolName = this.resolveToolName([
      "list-all-documentation",
      "list_all_components",
      "list_components",
      "getComponentList",
    ]);

    // Use withStoryIds: true to get story IDs in one call
    const isOfficial = toolName === "list-all-documentation";
    const result = await this.client!.callTool({
      name: toolName,
      arguments: isOfficial ? { withStoryIds: true } : {},
    });

    const text = this.extractText(result);
    return this.parseComponentList(text);
  }

  /**
   * Get full component documentation by ID.
   * The `id` parameter must match what list-all-documentation returned
   * (e.g. "button", not "Button").
   */
  async getComponent(componentId: string, displayName?: string): Promise<StorybookComponent> {
    this.ensureConnected();

    const toolName = this.resolveToolName([
      "get-documentation",
      "get_component",
      "get_component_documentation",
      "getComponentsProps",
    ]);

    // Official tool uses `id`, third-party might use `name` or `component`
    const isOfficial = toolName === "get-documentation";
    const args = isOfficial
      ? { id: componentId }
      : { id: componentId, name: displayName ?? componentId, component: displayName ?? componentId };

    const result = await this.client!.callTool({
      name: toolName,
      arguments: args,
    });

    const text = this.extractText(result);
    return this.parseComponentDocumentation(displayName ?? componentId, text);
  }

  async getStoryUrl(storyId: string): Promise<string> {
    const base = this.options.url.replace(/\/$/, "");
    return `${base}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;
  }

  private resolveToolName(candidates: string[]): string {
    if (this.availableTools.size > 0) {
      for (const name of candidates) {
        if (this.availableTools.has(name)) return name;
      }
    }
    return candidates[0];
  }

  /**
   * Parse component list from MCP response.
   *
   * Official format (markdown list):
   *   - **Button** (id: `button`) — A clickable button element
   *     - Primary (id: `button--primary`)
   *     - Secondary (id: `button--secondary`)
   *   - **Input** (id: `input`) — Text input field
   *
   * Also handles JSON formats from third-party servers.
   */
  private parseComponentList(text: string): ComponentEntry[] {
    // Try JSON first (third-party servers)
    try {
      const parsed = JSON.parse(text);
      return this.parseJsonComponentList(parsed);
    } catch {
      // Not JSON
    }

    // Parse official markdown list format
    const entries: ComponentEntry[] = [];
    const lines = text.split("\n");
    let currentEntry: ComponentEntry | null = null;

    for (const line of lines) {
      // Match component line: - **Button** (id: `button`) — summary
      // or: - Button (id: "button") — summary
      // or simpler: - Button (button)
      const componentMatch = line.match(
        /^[\-\*]\s+(?:\*\*)?([^*(\n]+?)(?:\*\*)?\s*\((?:id:\s*)?[`"']?([^)`"'\n]+)[`"']?\)/
      );

      if (componentMatch && !line.match(/^\s{2,}/)) {
        // Top-level component entry
        currentEntry = {
          name: componentMatch[1].trim(),
          id: componentMatch[2].trim(),
          storyIds: [],
        };
        entries.push(currentEntry);
        continue;
      }

      // Match story sub-item:   - Primary (id: `button--primary`)
      // or:   - Primary (button--primary)
      if (currentEntry && /^\s{2,}/.test(line)) {
        const storyMatch = line.match(
          /[\-\*]\s+(?:\*\*)?([^*(\n]+?)(?:\*\*)?\s*\((?:id:\s*)?[`"']?([^)`"'\n]+)[`"']?\)/
        );
        if (storyMatch) {
          currentEntry.storyIds?.push(storyMatch[2].trim());
        }
      }
    }

    // If the markdown parsing found nothing, try simpler patterns
    if (entries.length === 0) {
      return this.parseSimpleComponentList(text);
    }

    return entries;
  }

  private parseJsonComponentList(parsed: unknown): ComponentEntry[] {
    if (Array.isArray(parsed)) {
      return parsed.map((v) => {
        if (typeof v === "string") return { id: v, name: v };
        const obj = v as Record<string, unknown>;
        const id = (obj.id ?? obj.name ?? obj.component) as string;
        const name = (obj.name ?? obj.title ?? obj.id) as string;
        return { id, name };
      }).filter((e) => e.id != null);
    }

    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const arr = obj.components ?? obj.items ?? obj.docs;
      if (Array.isArray(arr)) return this.parseJsonComponentList(arr);
    }

    return [];
  }

  /** Fallback: parse simple markdown list or headings. */
  private parseSimpleComponentList(text: string): ComponentEntry[] {
    const entries: ComponentEntry[] = [];
    const seen = new Set<string>();

    for (const line of text.split("\n")) {
      // Headings: ## Button
      const heading = line.match(/^#{1,4}\s+([A-Z][a-zA-Z0-9]*)/);
      if (heading && !seen.has(heading[1])) {
        const name = heading[1];
        entries.push({ id: name.toLowerCase(), name });
        seen.add(name);
        continue;
      }

      // List items with component-like names: - Button, * Input
      const listItem = line.match(/^[\-\*]\s+([A-Z][a-zA-Z0-9]*)\b/);
      if (listItem && !seen.has(listItem[1])) {
        const name = listItem[1];
        entries.push({ id: name.toLowerCase(), name });
        seen.add(name);
      }
    }

    return entries;
  }

  /**
   * Parse component documentation into StorybookComponent.
   *
   * The official Storybook MCP returns props as TypeScript type definitions:
   *   ```typescript
   *   export type Props = {
   *     variant?: "default" | "destructive" = "default";
   *     disabled?: boolean = false;
   *   }
   *   ```
   *
   * Plus story snippets with IDs.
   */
  private parseComponentDocumentation(componentName: string, text: string): StorybookComponent {
    // Try structured JSON first (third-party servers)
    try {
      const raw = JSON.parse(text);
      return this.parseStructuredComponent(componentName, raw);
    } catch {
      // Not JSON
    }

    // Parse as documentation text (official server)
    const props = this.parsePropsFromDocumentation(text);
    const stories = this.parseStoriesFromDocumentation(componentName, text);

    return { name: componentName, props, stories };
  }

  /**
   * Parse props from TypeScript type definitions in documentation.
   *
   * Handles:
   *   export type Props = {
   *     variant?: "default" | "destructive" = "default";
   *     disabled?: boolean = false;
   *     size?: "sm" | "md" | "lg";
   *     /** Description of the prop *​/
   *     label?: string;
   *   }
   *
   * Also handles markdown table format as fallback.
   */
  private parsePropsFromDocumentation(text: string): StorybookProp[] {
    const props: StorybookProp[] = [];

    // Strategy 1: Parse TypeScript type definition blocks
    const tsProps = this.parseTypeScriptProps(text);
    if (tsProps.length > 0) return tsProps;

    // Strategy 2: Parse markdown table format
    const tableProps = this.parseMarkdownTableProps(text);
    if (tableProps.length > 0) return tableProps;

    // Strategy 3: Parse definition list format
    return this.parseDefinitionListProps(text);
  }

  /**
   * Parse TypeScript `export type Props = { ... }` blocks.
   * This is the primary format from official Storybook MCP.
   */
  private parseTypeScriptProps(text: string): StorybookProp[] {
    const props: StorybookProp[] = [];

    // Find TypeScript code blocks containing Props type
    const codeBlockRegex = /```(?:typescript|ts|tsx)?\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      const block = match[1];
      const propsFromBlock = this.parsePropsTypeBlock(block);
      props.push(...propsFromBlock);
    }

    // Also try without code fences (sometimes inline)
    if (props.length === 0) {
      const inlineMatch = text.match(/export\s+type\s+Props\s*=\s*\{([\s\S]*?)\}/);
      if (inlineMatch) {
        props.push(...this.parsePropsTypeBlock(`export type Props = {${inlineMatch[1]}}`));
      }
    }

    return props;
  }

  /**
   * Parse individual prop lines from a TypeScript Props type block.
   *
   * Lines look like:
   *   variant?: "default" | "destructive" = "default";
   *   disabled?: boolean = false;
   *   size?: "sm" | "md" | "lg";
   *   onClick?: (event: MouseEvent) => void;
   */
  private parsePropsTypeBlock(block: string): StorybookProp[] {
    const props: StorybookProp[] = [];

    // Match the content inside `type Props = { ... }`
    const bodyMatch = block.match(/(?:export\s+)?type\s+\w+\s*=\s*\{([\s\S]*)\}/);
    if (!bodyMatch) return props;

    const body = bodyMatch[1];
    let currentDescription: string | undefined;

    for (const line of body.split("\n")) {
      const trimmed = line.trim();

      // Collect JSDoc comments as descriptions
      if (trimmed.startsWith("/**") || trimmed.startsWith("*")) {
        const commentText = trimmed.replace(/^\/?\*\*?\s*|\*\/\s*$/g, "").trim();
        if (commentText.length > 0) {
          currentDescription = commentText;
        }
        continue;
      }

      // Match: propName?: type = defaultValue;
      // or:   propName: type;
      // Split on the LAST ` = ` to avoid mis-splitting types containing `=`.
      const propBaseMatch = trimmed.match(/^(\w+)(\?)?:\s*(.+);?\s*$/);

      if (!propBaseMatch) {
        if (trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("}")) {
          currentDescription = undefined;
        }
        continue;
      }

      const [, name, optional, rawTypeAndDefault] = propBaseMatch;
      // Split on last ` = ` (space-equals-space) to separate type from default
      const lastEqIdx = rawTypeAndDefault.lastIndexOf(" = ");
      let typeStr: string;
      let defaultStr: string | undefined;
      if (lastEqIdx !== -1) {
        typeStr = rawTypeAndDefault.slice(0, lastEqIdx).trim();
        defaultStr = rawTypeAndDefault.slice(lastEqIdx + 3).replace(/;$/, "").trim();
      } else {
        typeStr = rawTypeAndDefault.replace(/;$/, "").trim();
        defaultStr = undefined;
      }
      const type = this.parseTypeString(typeStr);
      const defaultValue = defaultStr?.trim().replace(/^["']|["']$/g, "");

      props.push({
        name,
        type,
        description: currentDescription,
        defaultValue: defaultValue ?? undefined,
        required: !optional,
      });

      currentDescription = undefined;
    }

    return props;
  }

  /** Parse markdown table props (fallback for non-standard servers). */
  private parseMarkdownTableProps(text: string): StorybookProp[] {
    const props: StorybookProp[] = [];
    let inPropsSection = false;

    for (const line of text.split("\n")) {
      const trimmed = line.trim();

      if (/^#{1,4}\s+(Props|API|Properties|Args|ArgTypes)/i.test(trimmed)) {
        inPropsSection = true;
        continue;
      }
      if (/^#{1,4}\s+/.test(trimmed) && inPropsSection) {
        inPropsSection = false;
        continue;
      }

      if (inPropsSection && trimmed.startsWith("|") && !trimmed.includes("---")) {
        const cells = trimmed.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
        if (cells.length >= 2) {
          const name = cells[0].replace(/`/g, "").trim();
          if (name.toLowerCase() === "name" || name.toLowerCase() === "prop") continue;

          const typeStr = cells[1].replace(/`/g, "").trim();
          const defaultStr = cells[2]?.replace(/`/g, "").trim();

          props.push({
            name,
            type: this.parseTypeString(typeStr),
            defaultValue: defaultStr === "-" || defaultStr === "" ? undefined : defaultStr,
            description: cells[3]?.trim(),
          });
        }
      }
    }

    return props;
  }

  /** Parse definition list props: **propName** (`type`) - description */
  private parseDefinitionListProps(text: string): StorybookProp[] {
    const props: StorybookProp[] = [];
    let inPropsSection = false;

    for (const line of text.split("\n")) {
      const trimmed = line.trim();

      if (/^#{1,4}\s+(Props|API|Properties)/i.test(trimmed)) {
        inPropsSection = true;
        continue;
      }
      if (/^#{1,4}\s+/.test(trimmed) && inPropsSection) {
        inPropsSection = false;
        continue;
      }

      if (inPropsSection) {
        const defMatch = trimmed.match(/\*\*(\w+)\*\*\s*(?:\(`?([^)]+)`?\))?/);
        if (defMatch) {
          props.push({
            name: defMatch[1],
            type: this.parseTypeString(defMatch[2] ?? "unknown"),
          });
        }
      }
    }

    return props;
  }

  /**
   * Parse story references from documentation.
   * Official format includes story snippets with IDs.
   */
  private parseStoriesFromDocumentation(componentName: string, text: string): StorybookStory[] {
    const stories: StorybookStory[] = [];
    const seenIds = new Set<string>();

    for (const line of text.split("\n")) {
      // Match story ID patterns: (id: `button--primary`) or id: "button--primary"
      const idMatch = line.match(/(?:id:\s*|storyId:\s*)[`"']([^`"']+)[`"']/g);
      if (idMatch) {
        for (const m of idMatch) {
          const id = m.replace(/.*[`"']([^`"']+)[`"'].*/, "$1");
          if (!seenIds.has(id) && id.includes("--")) {
            seenIds.add(id);
            const namePart = id.split("--").pop() ?? id;
            const name = namePart.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            stories.push({ id, name });
          }
        }
      }

      // Match story headings: ### Primary, ### Secondary
      const headingMatch = line.match(/^#{3,4}\s+(\w[\w\s]*)/);
      if (headingMatch) {
        const name = headingMatch[1].trim();
        // Skip generic headings
        if (!["props", "api", "stories", "usage", "examples", "description", "overview"].includes(name.toLowerCase())) {
          const id = `${componentName.toLowerCase()}--${name.toLowerCase().replace(/\s+/g, "-")}`;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            stories.push({ id, name });
          }
        }
      }
    }

    if (stories.length === 0) {
      stories.push({
        id: `${componentName.toLowerCase()}--default`,
        name: "Default",
      });
    }

    return stories;
  }

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

    return {
      name: raw.name as string ?? componentName,
      props,
      stories: this.extractStories(raw),
    };
  }

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
      return Object.entries(propsObj).map(([name, prop]) => ({ name, ...prop }));
    }

    return [];
  }

  private extractStories(raw: Record<string, unknown>): StorybookStory[] {
    const storiesRaw = raw.stories;
    if (!Array.isArray(storiesRaw)) return [];

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

  private normalizeControl(raw: unknown): ArgTypeControl | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const obj = raw as Record<string, unknown>;

    if (obj.type || obj.options) {
      return {
        type: obj.type as string | undefined,
        options: Array.isArray(obj.options) ? obj.options.map((o) => String(o)) : undefined,
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
    if (typeof raw === "string") return this.parseTypeString(raw);

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
