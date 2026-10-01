// Runs the compiled CLI's --components handling, and its errors from a
// Storybook that fails, end to end against stand-in MCP servers: just enough
// JSON-RPC over HTTP for Storybook's two documentation tools and Figma's
// use_figma, so this needs no network, no running Storybook and no Figma file.
// The acceptance suite checks map and inspect against the real Storybook.

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

interface StandIn {
  url: string;
  /** Every tool called, with the component ID where there is one: `docs-show forms-button`. */
  calls: string[];
  server: Server;
}

/**
 * Serves a stand-in Storybook (and Figma) MCP server. `docs` names its docs
 * tools, 0.7's or 10.6's, or null for a server without them. A tool named in
 * `failing` answers as addon-mcp does when it can't: an `isError` result
 * with the reason as text, not a protocol error.
 */
async function startStandIn(docs: { list: string; show: string } | null, failing: string[] = []): Promise<StandIn> {
  const calls: string[] = [];
  const tools = [...(docs ? [docs.list, docs.show] : ["preview-stories"]), "use_figma"];

  function call(name = "", args: { id?: string; code?: string } = {}): unknown {
    calls.push(args.id ? `${name} ${args.id}` : name);
    const text = (t: string) => ({ content: [{ type: "text", text: t }] });
    if (failing.includes(name)) return { ...text(`Storybook index could not be built (${name})`), isError: true };
    if (name === docs?.list) return text(LIST);
    if (name === docs?.show) return text(DOCS[args.id ?? ""] ?? "");
    // use_figma: the component read, or an empty variable read.
    return text(JSON.stringify(args.code?.includes("COMPONENT_SET") ? FIGMA_COMPONENTS : []));
  }

  function respond(message: Rpc): unknown {
    switch (message.method) {
      case "initialize":
        return { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-storybook", version: "0" } };
      case "tools/list":
        return { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) };
      case "tools/call":
        return call(message.params?.name, message.params?.arguments);
      default:
        return {};
    }
  }

  const server = createServer((req, res) => {
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server };
}

const ADDON_MCP_0_7 = { list: "list-all-documentation", show: "get-documentation" };
const ADDON_MCP_10_6 = { list: "docs-list", show: "docs-show" };

let standIns: StandIn[] = [];
/** A working Storybook, and Figma for diff. */
let storybook: string;
/** Storybook whose docs list fails, as addon-mcp 10.6 does when its index can't be built. */
let listFails: StandIn;
/** Storybook whose docs list works but whose docs-show fails. */
let showFails: StandIn;
/** Storybook without the docs tools, as on Storybook 9 or with the docs toolset off. */
let noDocs: StandIn;

before(async () => {
  const good = await startStandIn(ADDON_MCP_0_7);
  listFails = await startStandIn(ADDON_MCP_10_6, ["docs-list"]);
  showFails = await startStandIn(ADDON_MCP_10_6, ["docs-show"]);
  noDocs = await startStandIn(null);
  standIns = [good, listFails, showFails, noDocs];
  storybook = good.url;
});

after(() => {
  for (const s of standIns) s.server.close();
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

/**
 * Runs diff in a project with no tokens, so only components differ, reading
 * Figma from the working stand-in and Storybook from `storybookUrl`.
 */
async function diffWith(storybookUrl: string, ...args: string[]) {
  const project = mkdtempSync(join(tmpdir(), "storysync-diff-cli-"));
  try {
    return await run("diff", "--figma", `${storybook}/mcp`, "--file-key", "x", "--storybook", storybookUrl, "--project", project, ...args);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

/** Runs diff against the working stand-in for both sides. */
function diff(...args: string[]) {
  return diffWith(storybook, ...args);
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

test("diff CLI: --components without --storybook fails under --json with an error that still parses", async () => {
  const r = await run("diff", "--figma", "http://127.0.0.1:9", "--file-key", "x", "--components", "Button", "--json");
  assert.equal(r.status, 1, r.out);
  const data = JSON.parse(r.stdout) as { error?: string };
  assert.match(data.error ?? "", /--components selects the components to diff, which needs --storybook/);
});

test("diff CLI: an unknown --source fails before connecting, as JSON under --json", async () => {
  // Detected instead, `--source scss` diffed whatever the project had first.
  // Checked before connecting, so the unreachable Figma URL is never tried.
  const text = await run("diff", "--figma", "http://127.0.0.1:9", "--file-key", "x", "--source", "scss");
  assert.equal(text.status, 1, text.out);
  assert.match(text.out, /--source must be "tailwind", "css" or "theme", received "scss"/);
  assert.doesNotMatch(text.out, /Figma MCP/);

  const json = await run("diff", "--figma", "http://127.0.0.1:9", "--file-key", "x", "--source", "scss", "--json");
  assert.equal(json.status, 1, json.out);
  assert.match((JSON.parse(json.stdout) as { error: string }).error, /--source must be "tailwind", "css" or "theme", received "scss"/);
});

type DiffJson = { components: { name: string; status: string }[]; storybookReadFailed: boolean; figmaReadFailed: boolean };

test("diff CLI: when Storybook can't be listed, --components still narrows Figma and the run is partial", async () => {
  // Unnarrowed, Card and Badge were reported not in code too, though nobody
  // asked about them and the code side was never read.
  const r = await diffWith(listFails.url, "--components", "Button");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Failed to list Storybook components/);
  assert.match(r.out, /"docs-list" failed: Storybook index could not be built/);
  assert.match(r.out, /Storybook listing failed — component results are partial/);
  assert.doesNotMatch(r.out, /matched no component/);
  assert.doesNotMatch(r.out, /Card|Badge|No differences found|Components in sync/);

  const strict = await diffWith(listFails.url, "--components", "Button", "--strict", "--json");
  assert.equal(strict.status, 1, strict.out);
  const data = JSON.parse(strict.stdout) as DiffJson;
  assert.equal(data.storybookReadFailed, true);
  assert.equal(data.figmaReadFailed, false);
  assert.deepEqual(data.components.map((c) => [c.name, c.status]), [["Button", "figma_only"]]);
});

test("diff CLI: when Storybook can't be listed, a --components name is not rejected as a typo", async () => {
  // An ID names a component only Storybook could confirm. With the list
  // unread, rejecting it would blame the name for the listing failure.
  const r = await diffWith(listFails.url, "--components", "forms-button");
  assert.match(r.out, /"docs-list" failed/);
  assert.doesNotMatch(r.out, /matched no component/);
  assert.match(r.out, /component results are partial/);
  // Figma has no forms-button, so nothing is left to diff: the run must not
  // read as clean, and only the failed read can fail --strict.
  assert.doesNotMatch(r.out, /No differences found|No components to diff/);
  const strict = await diffWith(listFails.url, "--components", "forms-button", "--strict", "--json");
  assert.equal(strict.status, 1, strict.out);
  assert.equal((JSON.parse(strict.stdout) as DiffJson).storybookReadFailed, true);
});

test("diff CLI: a working Storybook reports storybookReadFailed false", async () => {
  const r = await diff("--components", "Button", "--json");
  assert.equal(r.status, 0, r.out);
  assert.equal((JSON.parse(r.stdout) as DiffJson).storybookReadFailed, false);
});

// --- Errors from Storybook end list, map and inspect cleanly ---

/** A Node stack trace: what an uncaught error printed before these commands caught it. */
const STACK = /^\s+at .+\(.*:\d+:\d+\)$/m;

test("list CLI: a docs list that fails ends with the server's reason and exit 1, not a stack trace", async () => {
  const r = await run("list", "--storybook", listFails.url);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Storybook MCP tool "docs-list" failed: Storybook index could not be built/);
  assert.doesNotMatch(r.out, STACK);
});

test("list CLI: a Storybook without the docs tools gets the setup advice, not a stack trace", async () => {
  const r = await run("list", "--storybook", noDocs.url);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Storybook MCP is missing the docs tools[\s\S]*storysync init/);
  assert.doesNotMatch(r.out, STACK);
});

test("map CLI: a docs list that fails ends with the reason, as JSON under --json", async () => {
  const text = await run("map", "--storybook", listFails.url);
  assert.equal(text.status, 1, text.out);
  assert.match(text.out, /Failed to read components/);
  assert.match(text.out, /"docs-list" failed: Storybook index could not be built/);
  assert.doesNotMatch(text.out, STACK);

  const json = await run("map", "--storybook", noDocs.url, "--json");
  assert.equal(json.status, 1, json.out);
  assert.match((JSON.parse(json.stdout) as { error: string }).error, /missing the docs tools/);
});

test("inspect CLI: a name that matches nothing names what exists, without asking for its documentation", async () => {
  const before = showFails.calls.length;
  const r = await run("inspect", "--storybook", showFails.url, "--component", "Buton");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /No component named "Buton"\. Available: Button, Card/);
  assert.doesNotMatch(r.out, STACK);
  assert.deepEqual(showFails.calls.slice(before), ["docs-list"]);
});

test("inspect CLI: a docs-show that fails ends with the server's reason, not a stack trace", async () => {
  const r = await run("inspect", "--storybook", showFails.url, "--component", "Button");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Storybook MCP tool "docs-show" failed: Storybook index could not be built/);
  assert.doesNotMatch(r.out, STACK);
});

test("inspect CLI: finds a component by name or ID, ignoring case", async () => {
  for (const name of ["button", "FORMS-BUTTON"]) {
    const r = await run("inspect", "--storybook", storybook, "--component", name);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^Button$/m);
    assert.match(r.out, /size \(union\) -> VARIANT \[sm, lg\]/);
  }
});
