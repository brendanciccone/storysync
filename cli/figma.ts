// Figma MCP client — reads variables and components from a Figma file.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface FigmaVariable {
  name: string;
  resolvedType: string;
  value: string;
  collection: string;
  mode: string;
}

export interface FigmaComponentInfo {
  name: string;
  variantProperties: { name: string; type: string; values: string[] }[];
  variantCount: number;
}

const READ_VARIABLES_PLUGIN_CODE = `
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const results = [];
const MAX_ALIAS_DEPTH = 8;

async function resolveAlias(varId, depth) {
  if (depth > MAX_ALIAS_DEPTH) return { value: '<alias-cycle>', type: 'STRING' };
  const v = await figma.variables.getVariableByIdAsync(varId);
  if (!v) return { value: '<missing>', type: 'STRING' };
  const mode = v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  if (mode && typeof mode === 'object' && 'type' in mode && mode.type === 'VARIABLE_ALIAS') {
    return resolveAlias(mode.id, depth + 1);
  }
  return { value: mode, type: v.resolvedType };
}

function rgbToHex(c) {
  const r = Math.round((c.r || 0) * 255);
  const g = Math.round((c.g || 0) * 255);
  const b = Math.round((c.b || 0) * 255);
  const a = c.a == null ? 1 : c.a;
  const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  if (a >= 1) return hex;
  return hex + Math.round(a * 255).toString(16).padStart(2, '0');
}

for (const coll of collections) {
  const targetMode = MODE_NAME ? coll.modes.find(m => m.name === MODE_NAME) : coll.modes[0];
  if (!targetMode) continue;
  for (const varId of coll.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(varId);
    if (!v) continue;
    let raw = v.valuesByMode[targetMode.modeId];
    let type = v.resolvedType;
    if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'VARIABLE_ALIAS') {
      const resolved = await resolveAlias(raw.id, 0);
      raw = resolved.value;
    }
    let value = '';
    if (type === 'COLOR' && raw && typeof raw === 'object' && 'r' in raw) {
      value = rgbToHex(raw);
    } else if (type === 'BOOLEAN') {
      value = String(Boolean(raw));
    } else {
      value = String(raw);
    }
    results.push({ name: v.name, resolvedType: type, value, collection: coll.name, mode: targetMode.name });
  }
}
return JSON.stringify(results);
`.trim();

const READ_COMPONENTS_PLUGIN_CODE = `
const componentSets = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] });
const standalones = figma.root.findAllWithCriteria({ types: ['COMPONENT'] })
  .filter(c => c.parent && c.parent.type !== 'COMPONENT_SET');
const results = [];

for (const cs of componentSets) {
  const defs = cs.componentPropertyDefinitions || {};
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

  async getVariables(fileKey: string, mode?: string): Promise<FigmaVariable[]> {
    const code = `const MODE_NAME = ${mode ? JSON.stringify(mode) : "null"};\n${READ_VARIABLES_PLUGIN_CODE}`;
    const text = await this.callFigma(fileKey, code, "Read all variable collections and their values");
    return parseJsonResult<FigmaVariable[]>(text, "variables");
  }

  async getComponents(fileKey: string): Promise<FigmaComponentInfo[]> {
    const text = await this.callFigma(fileKey, READ_COMPONENTS_PLUGIN_CODE, "Read all component sets and their variant properties");
    return parseJsonResult<FigmaComponentInfo[]>(text, "components");
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

function parseJsonResult<T>(text: string, label: string): T {
  // Some MCP responses wrap return values in extra text; try to extract the first JSON array.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try { return JSON.parse(arrayMatch[0]) as T; } catch { /* fall through */ }
    }
    throw new Error(`Failed to parse Figma ${label} response. The use_figma tool may not return plugin code's return value. Got: ${trimmed.slice(0, 200)}`);
  }
}
