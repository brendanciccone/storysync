#!/usr/bin/env node
// Push storysync tokens and components to a Figma file via MCP.
// Usage: node scripts/push-to-figma.mjs --figma http://127.0.0.1:3845/mcp --file-key <key> --project <path>

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const figmaUrl = flag("--figma") || "http://127.0.0.1:3845/mcp";
const fileKey = flag("--file-key");
const projectPath = flag("--project") || ".";

if (!fileKey) {
  console.error("Usage: node scripts/push-to-figma.mjs --file-key <key> [--figma <url>] [--project <path>]");
  process.exit(1);
}

// Dynamically import storysync modules
const { extractTokens } = await import("../dist/cli/tokens.js");
const { StorybookClient } = await import("../dist/cli/storybook.js");
const { mapComponent } = await import("../dist/cli/mapper.js");

// Extract tokens
console.log("Extracting tokens from project...");
const tokenResult = extractTokens(projectPath);
const totalTokens = tokenResult.collections.reduce((s, c) => s + c.tokens.length, 0);
console.log(`  Found ${totalTokens} tokens in ${tokenResult.collections.length} collections`);

// Connect to Figma MCP
console.log("\nConnecting to Figma MCP...");
const client = new Client({ name: "storysync-push", version: "0.2.0" }, {});
const mcpUrl = new URL(figmaUrl);
try {
  await client.connect(new StreamableHTTPClientTransport(mcpUrl));
} catch {
  await client.connect(new SSEClientTransport(mcpUrl));
}
console.log("  Connected");

async function callFigma(code, description) {
  const result = await client.callTool({
    name: "use_figma",
    arguments: { code, description, fileKey, skillNames: "figma-use" },
  });
  const r = result;
  const texts = r.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text) ?? [];
  return texts.join("\n") || JSON.stringify(result);
}

// --- Push tokens as Figma variables ---
console.log("\nCreating Figma variable collections...");

for (const collection of tokenResult.collections) {
  const collectionName = collection.category.charAt(0).toUpperCase() + collection.category.slice(1);
  const tokensJson = JSON.stringify(collection.tokens);

  const isColor = collection.category === "colors";

  const code = `
const tokens = ${tokensJson};
const collectionName = ${JSON.stringify(collectionName)};
const isColor = ${isColor};

// Find or create the collection
let collections = await figma.variables.getLocalVariableCollectionsAsync();
let coll = collections.find(c => c.name === collectionName);
if (!coll) {
  coll = figma.variables.createVariableCollection(collectionName);
}
const modeId = coll.modes[0].modeId;

// Get existing variables in this collection
const existingVars = [];
for (const varId of coll.variableIds) {
  const v = await figma.variables.getVariableByIdAsync(varId);
  if (v) existingVars.push(v);
}

function parseHSL(str) {
  const m = str.match(/hsl\\((\\d+\\.?\\d*)\\s+(\\d+\\.?\\d*)%\\s+(\\d+\\.?\\d*)%\\)/);
  if (!m) return null;
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m2 = l - c / 2;
  let r, g, b;
  const hue = h * 6;
  if (hue < 1) [r, g, b] = [c, x, 0];
  else if (hue < 2) [r, g, b] = [x, c, 0];
  else if (hue < 3) [r, g, b] = [0, c, x];
  else if (hue < 4) [r, g, b] = [0, x, c];
  else if (hue < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: r + m2, g: g + m2, b: b + m2, a: 1 };
}

function parseRGB(str) {
  const m = str.match(/rgb\\((\\d+)\\s+(\\d+)\\s+(\\d+)\\s*\\/\\s*([\\d.]+)\\)/);
  if (m) return { r: parseInt(m[1])/255, g: parseInt(m[2])/255, b: parseInt(m[3])/255, a: parseFloat(m[4]) };
  const m2 = str.match(/rgb\\((\\d+)\\s+(\\d+)\\s+(\\d+)\\)/);
  if (m2) return { r: parseInt(m2[1])/255, g: parseInt(m2[2])/255, b: parseInt(m2[3])/255, a: 1 };
  return null;
}

let created = 0;
let updated = 0;

for (const token of tokens) {
  const name = token.name.replace(/\\//g, '/');
  let existing = existingVars.find(v => v.name === name);

  if (isColor) {
    const color = parseHSL(token.value) || parseRGB(token.value);
    if (!color) { continue; }

    if (!existing) {
      const v = figma.variables.createVariable(name, coll, 'COLOR');
      v.setValueForMode(modeId, color);
      created++;
    } else {
      existing.setValueForMode(modeId, color);
      updated++;
    }
  } else {
    // For non-color tokens, store as FLOAT if numeric, STRING otherwise
    const numMatch = token.value.match(/^([\\d.]+)\\s*(?:rem|px)?$/);
    if (numMatch) {
      const num = parseFloat(numMatch[1]);
      const resolvedType = 'FLOAT';
      if (!existing) {
        const v = figma.variables.createVariable(name, coll, resolvedType);
        v.setValueForMode(modeId, num);
        created++;
      } else {
        existing.setValueForMode(modeId, num);
        updated++;
      }
    } else {
      if (!existing) {
        const v = figma.variables.createVariable(name, coll, 'STRING');
        v.setValueForMode(modeId, token.value);
        created++;
      } else {
        existing.setValueForMode(modeId, token.value);
        updated++;
      }
    }
  }
}

return JSON.stringify({ collection: collectionName, created, updated, total: tokens.length });
`.trim();

  try {
    const result = await callFigma(code, `Create ${collectionName} variable collection with ${collection.tokens.length} tokens`);
    console.log(`  ${collectionName}: ${result}`);
  } catch (err) {
    console.error(`  ${collectionName} failed: ${err}`);
  }
}

// --- Push components as Figma component sets ---
console.log("\nCreating Figma components...");

// Try to connect to Storybook for component data
const storybookUrl = flag("--storybook");
if (storybookUrl) {
  try {
    const sb = new StorybookClient(storybookUrl);
    await sb.connect();
    const entries = await sb.listComponents();
    console.log(`  Found ${entries.length} components in Storybook`);

    for (const entry of entries) {
      try {
        const component = await sb.getComponent(entry.id, entry.name);
        const def = mapComponent(component);

        if (!def.variantProperties.length) {
          // Simple component — create a single component
          const code = `
const comp = figma.createComponent();
comp.name = ${JSON.stringify(entry.name)};
comp.resize(200, 100);
const text = figma.createText();
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
text.characters = ${JSON.stringify(entry.name)};
text.fontSize = 14;
comp.appendChild(text);
text.x = 16;
text.y = 40;
return JSON.stringify({ name: ${JSON.stringify(entry.name)}, variants: 0 });
`.trim();
          const result = await callFigma(code, `Create ${entry.name} component`);
          console.log(`  ${entry.name}: ${result}`);
        } else {
          // Component with variants — create a component set
          const propsJson = JSON.stringify(def.variantProperties);
          const combosJson = JSON.stringify(def.variantCombinations.slice(0, 32)); // Cap at 32 for initial creation

          const code = `
const props = ${propsJson};
const combos = ${combosJson};
const name = ${JSON.stringify(entry.name)};

await figma.loadFontAsync({ family: "Inter", style: "Regular" });

const components = [];
for (let i = 0; i < combos.length; i++) {
  const combo = combos[i];
  const comp = figma.createComponent();
  const parts = [];
  for (const [key, val] of Object.entries(combo)) {
    parts.push(key + '=' + String(val));
  }
  comp.name = parts.join(', ');
  comp.resize(200, 60);

  const text = figma.createText();
  text.characters = comp.name;
  text.fontSize = 10;
  comp.appendChild(text);
  text.x = 8;
  text.y = 24;

  comp.x = (i % 8) * 220;
  comp.y = Math.floor(i / 8) * 80;

  components.push(comp);
}

if (components.length > 1) {
  const cs = figma.combineAsVariants(components, figma.currentPage);
  cs.name = name;
  return JSON.stringify({ name, variants: components.length, properties: props.length });
} else if (components.length === 1) {
  components[0].name = name;
  return JSON.stringify({ name, variants: 1, properties: props.length });
}
return JSON.stringify({ name, variants: 0, error: 'no combos' });
`.trim();

          const result = await callFigma(code, `Create ${entry.name} component set with variants`);
          console.log(`  ${entry.name}: ${result}`);
        }
      } catch (err) {
        console.error(`  ${entry.name} failed: ${err.message || err}`);
      }
    }

    await sb.disconnect();
  } catch (err) {
    console.error(`  Storybook connection failed: ${err.message || err}`);
    console.log("  Skipping component creation (run with --storybook <url> to include components)");
  }
} else {
  console.log("  Skipped (no --storybook URL provided). Add --storybook http://localhost:6006 to include components.");
}

await client.close();
console.log("\nDone! Open your Figma file to see the results.");
console.log(`Then run: node dist/cli/index.js diff --figma ${figmaUrl} --file-key ${fileKey} --project ${projectPath}${storybookUrl ? ' --storybook ' + storybookUrl : ''}`);
