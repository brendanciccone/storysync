// Runs the compiled CLI's --components handling end to end, against a
// stand-in MCP server: just enough JSON-RPC over HTTP for Storybook's two
// documentation tools and Figma's use_figma, so this needs no network, no
// running Storybook and no Figma file. The acceptance suite checks map against
// the real Storybook.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

const LIST = [
  "- Button (forms-button)",
  "  - Primary (forms-button--primary)",
  "- Card (data-display-card)",
  "  - Default (data-display-card--default)",
].join("\n");

const DOCS: Record<string, string> = {
  "forms-button": "```ts\nexport type Props = {\n  size?: \"sm\" | \"lg\" = \"sm\";\n}\n```",
  "data-display-card": "A card with no props.",
};

// What use_figma reports for the file: Button agrees with the code, Card is
// in code too, and Badge exists only in Figma.
const FIGMA_COMPONENTS = [
  { name: "Button", variantProperties: [{ name: "size", type: "VARIANT", values: ["sm", "lg"] }], variantCount: 2 },
  { name: "Card", variantProperties: [], variantCount: 1 },
  { name: "Badge", variantProperties: [], variantCount: 1 },
];

type Rpc = { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: { id?: string; code?: string } } };

function toolText(name: string | undefined, args: { id?: string; code?: string } = {}): string {
  if (name === "list-all-documentation") return LIST;
  if (name === "get-documentation") return DOCS[args.id ?? ""] ?? "";
  // use_figma: the component read, or an empty variable read.
  return JSON.stringify(args.code?.includes("COMPONENT_SET") ? FIGMA_COMPONENTS : []);
}

function respond(message: Rpc): unknown {
  switch (message.method) {
    case "initialize":
      return { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-storybook", version: "0" } };
    case "tools/list":
      return { tools: ["list-all-documentation", "get-documentation", "use_figma"].map((name) => ({ name, inputSchema: { type: "object" } })) };
    case "tools/call":
      return { content: [{ type: "text", text: toolText(message.params?.name, message.params?.arguments) }] };
    default:
      return {};
  }
}

let server: Server;
let storybook: string;

before(async () => {
  server = createServer((req, res) => {
    // No standalone event stream: the client asks for one and carries on
    // without it when refused.
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body) as Rpc;
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: respond(message) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  storybook = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

/** Runs the CLI without blocking, since the stand-in Storybook shares this process. */
function run(...args: string[]): Promise<{ status: number; stdout: string; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
      const status = err ? Number((err as { code?: unknown }).code ?? -1) : 0;
      resolve({ status, stdout, out: `${stdout}${stderr}`.replace(/\u001b\[[0-9;]*m/g, "") });
    });
  });
}

test("map CLI: a --components name that matches nothing fails and names what exists", async () => {
  const r = await run("map", "--storybook", storybook, "--components", "Buton");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /--components matched no component named "Buton"\. Available: Button, Card/);
  assert.doesNotMatch(r.out, /No components found/);
});

test("map CLI: a partial typo fails under --json with an error that still parses", async () => {
  // The dangerous shape: Button maps, so the output looks populated while
  // the misspelled component is never checked.
  const r = await run("map", "--storybook", storybook, "--components", "Button,Crad", "--json");
  assert.equal(r.status, 1, r.out);
  const data = JSON.parse(r.stdout) as { error?: string; components?: unknown };
  assert.match(data.error ?? "", /no component named "Crad"/);
  assert.equal(data.components, undefined);
});

test("map CLI: matches names and IDs as snap does, ignoring case and spacing", async () => {
  const r = await run("map", "--storybook", storybook, "--components", " button , DATA-DISPLAY-CARD", "--json");
  assert.equal(r.status, 0, r.out);
  const data = JSON.parse(r.stdout) as { components: { name: string; combinations: number }[] };
  assert.deepEqual(data.components.map((c) => [c.name, c.combinations]), [["Button", 2], ["Card", 1]]);
});

/** Runs diff against the stand-in for both sides, in a project with no tokens, so only components differ. */
async function diff(...args: string[]) {
  const project = mkdtempSync(join(tmpdir(), "storysync-diff-cli-"));
  try {
    return await run("diff", "--figma", `${storybook}/mcp`, "--file-key", "x", "--storybook", storybook, "--project", project, ...args);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test("diff CLI: a --components name in neither Storybook nor Figma fails whatever the flags", async () => {
  const r = await diff("--components", "Button,Buton");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /--components matched no component named "Buton"\. Available: Badge, Button, Card/);
});

test("diff CLI: components left out of the diff are not reported as missing from code", async () => {
  // Card is in code and Badge is not, but neither was asked about. Unnarrowed,
  // both were reported not in code, so --strict failed on any fuller file.
  const r = await diff("--components", "forms-button", "--strict");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Components in sync/);
  assert.doesNotMatch(r.out, /Card|Badge/);
});

test("diff CLI: a name only Figma has is reported as not in code, and fails --strict", async () => {
  const r = await diff("--components", "Button,badge", "--strict", "--json");
  assert.equal(r.status, 1, r.out);
  const data = JSON.parse(r.stdout) as { components: { name: string; status: string }[]; summary: { componentsMatched: number } };
  assert.deepEqual(data.components.map((c) => [c.name, c.status]), [["Badge", "figma_only"]]);
  assert.equal(data.summary.componentsMatched, 1);
});

test("diff CLI: --components without --storybook fails instead of being ignored", async () => {
  // Checked before connecting, so the unreachable Figma URL is never tried.
  const r = await run("diff", "--figma", "http://127.0.0.1:9", "--file-key", "x", "--components", "Button");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /--components selects the components to diff, which needs --storybook/);
  assert.doesNotMatch(r.out, /Figma MCP/);
});
