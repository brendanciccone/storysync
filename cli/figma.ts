// Figma MCP client — reads variables and components from a Figma file.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface FigmaVariable {
  name: string;
  resolvedType: string;
  value: string;
  collection: string;
}

export interface FigmaComponentInfo {
  name: string;
  variantProperties: { name: string; type: string; values: string[] }[];
  variantCount: number;
}

export class FigmaClient {
  private client: Client | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "storysync", version: "0.2.0" }, {});
    const mcpUrl = new URL(this.url);

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

  async getVariables(fileKey: string): Promise<FigmaVariable[]> {
    const code = `
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const results = [];
for (const coll of collections) {
  for (const varId of coll.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(varId);
    if (!v) continue;
    const mode = coll.modes[0];
    const raw = v.valuesByMode[mode.modeId];
    let value = '';
    if (v.resolvedType === 'COLOR' && raw && typeof raw === 'object' && 'r' in raw) {
      const r = Math.round(raw.r * 255);
      const g = Math.round(raw.g * 255);
      const b = Math.round(raw.b * 255);
      value = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    } else if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'VARIABLE_ALIAS') {
      const aliased = await figma.variables.getVariableByIdAsync(raw.id);
      value = aliased ? aliased.name + ' (alias)' : String(raw.id);
    } else {
      value = String(raw);
    }
    results.push({ name: v.name, resolvedType: v.resolvedType, value, collection: coll.name });
  }
}
return JSON.stringify(results);
    `.trim();

    const text = await this.callFigma(fileKey, code, "Read all variable collections and their values");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Failed to parse Figma variables response: ${text.slice(0, 200)}`);
    }
  }

  async getComponents(fileKey: string): Promise<FigmaComponentInfo[]> {
    const code = `
const componentSets = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] });
const standalones = figma.root.findAllWithCriteria({ types: ['COMPONENT'] })
  .filter(c => c.parent && c.parent.type !== 'COMPONENT_SET');
const results = [];

for (const cs of componentSets) {
  const defs = cs.componentPropertyDefinitions;
  const props = [];
  for (const [key, def] of Object.entries(defs)) {
    if (def.type === 'VARIANT') {
      props.push({ name: key, type: 'VARIANT', values: def.variantOptions || [] });
    } else if (def.type === 'BOOLEAN') {
      props.push({ name: key, type: 'BOOLEAN', values: ['true', 'false'] });
    }
  }
  results.push({ name: cs.name, variantProperties: props, variantCount: cs.children.length });
}

for (const c of standalones) {
  results.push({ name: c.name, variantProperties: [], variantCount: 1 });
}

return JSON.stringify(results);
    `.trim();

    const text = await this.callFigma(fileKey, code, "Read all component sets and their variant properties");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Failed to parse Figma components response: ${text.slice(0, 200)}`);
    }
  }

  private async callFigma(fileKey: string, code: string, description: string): Promise<string> {
    if (!this.client) throw new Error("Not connected");
    const result = await this.client.callTool({
      name: "use_figma",
      arguments: { code, description, fileKey, skillNames: "figma-use" },
    });
    const r = result as { content?: { type: string; text?: string }[] };
    const texts = r.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text!) ?? [];
    return texts.length ? texts.join("\n") : JSON.stringify(result);
  }
}
