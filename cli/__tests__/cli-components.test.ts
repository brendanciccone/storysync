// Runs the compiled CLI's --components handling, and its errors from a
// Storybook that fails, end to end against stand-in MCP servers: just enough
// JSON-RPC over HTTP for Storybook's two documentation tools and Figma's
// use_figma, so this needs no network, no running Storybook and no Figma file.
// use_figma runs the plugin code diff sends against a simulated file, loading
// pages as Figma does (see figma-standin.ts). The acceptance suite checks map
// and inspect against the real Storybook.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useFigma, set, component } from "./figma-standin.js";
import type { FileSpec, UseFigmaCall } from "./figma-standin.js";

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

// The Figma file, a category a page as the push leaves it: Button agrees with
// the code, Card is in code too, and Badge exists only in Figma.
const FIGMA_FILE: FileSpec = {
  pages: [
    { name: "Forms", nodes: [set("Button", { size: ["sm", "lg"] })] },
    { name: "Data display", nodes: [component("Card")] },
    { name: "Feedback", nodes: [component("Badge")] },
  ],
};

type Rpc = { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: { id?: string; code?: string } } };

interface StandIn {
  url: string;
  /** Every tool called, with the component ID where there is one: `docs-show forms-button`. */
  calls: string[];
  /** Every use_figma call, as the Figma stand-in ran it. */
  figmaCalls: UseFigmaCall[];
  server: Server;
}

/**
 * Serves a stand-in Storybook (and Figma) MCP server. `docs` names its docs
 * tools, 0.7's or 10.6's, or null for a server without them. A tool named in
 * `failing` answers as addon-mcp does when it can't: an `isError` result
 * with the reason as text, not a protocol error. use_figma runs its code
 * against `figma`.
 */
async function startStandIn(docs: { list: string; show: string } | null, failing: string[] = [], figma: FileSpec = FIGMA_FILE): Promise<StandIn> {
  const calls: string[] = [];
  const figmaCalls: UseFigmaCall[] = [];
  const tools = [...(docs ? [docs.list, docs.show] : ["preview-stories"]), "use_figma"];

  function call(name = "", args: { id?: string; code?: string } = {}): unknown {
    calls.push(args.id ? `${name} ${args.id}` : name);
    const text = (t: string) => ({ content: [{ type: "text", text: t }] });
    if (failing.includes(name)) return { ...text(`Storybook index could not be built (${name})`), isError: true };
    if (name === docs?.list) return text(LIST);
    if (name === docs?.show) return text(DOCS[args.id ?? ""] ?? "");
    return useFigma(figma, args.code ?? "", figmaCalls);
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
    req.on("end", async () => {
      const message = JSON.parse(body) as Rpc;
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result = await respond(message);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, figmaCalls, server };
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

/**
 * Runs the CLI without blocking, since the stand-in Storybook shares this
 * process. The kill is a backstop under the 30s test timeouts: a CLI that
 * hangs (on a server that never answers, say) fails its test instead of
 * keeping the whole run alive.
 */
function run(...args: string[]): Promise<{ status: number; stdout: string; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 25_000, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
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

// --- Reading Figma a page at a time ---

/** Runs diff, in a project with no tokens, against a stand-in serving both Storybook and Figma. */
async function diffAgainst(standIn: StandIn, ...args: string[]) {
  const project = mkdtempSync(join(tmpdir(), "storysync-diff-cli-"));
  try {
    return await run("diff", "--figma", `${standIn.url}/mcp`, "--file-key", "x", "--storybook", standIn.url, "--project", project, ...args);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test("diff CLI: compares the components on every page of the Figma file, not only the first", async () => {
  // Button, Card and Badge are each on a page of their own. Searched from
  // figma.root, as diff did, use_figma sees only the first page, and Card was
  // reported missing from Figma while Badge went unreported.
  const standIn = await startStandIn(ADDON_MCP_10_6);
  standIns.push(standIn);
  const r = await diffAgainst(standIn, "--json");
  assert.equal(r.status, 0, r.out);
  const data = JSON.parse(r.stdout) as DiffJson & { summary: { componentsMatched: number } };
  assert.equal(data.figmaReadFailed, false);
  assert.deepEqual(data.components.map((c) => [c.name, c.status]), [["Badge", "figma_only"]]);
  assert.equal(data.summary.componentsMatched, 2);
  // The variables, the page list with the first page, already loaded, then
  // each other page once, switching to it once.
  assert.deepEqual(standIn.figmaCalls.map((c) => c.switches), [[], [], ["0:2"], ["0:3"]]);
  assert.ok(standIn.figmaCalls.every((c) => !c.error));
});

test("diff CLI: a Figma component too big for one use_figma response fails the read, and --strict", async () => {
  // A set of 1,500 icons can't come back in one 20kb response. Left out, the
  // diff would look complete without it; cut short by the limit, the response
  // wouldn't parse. The read fails instead, naming the component and page.
  const icons = Array.from({ length: 1500 }, (_, i) => `icon-glyph-${i}`);
  const standIn = await startStandIn(ADDON_MCP_10_6, [], { pages: [...FIGMA_FILE.pages, { name: "Icons", nodes: [set("Icon", { name: icons })] }] });
  standIns.push(standIn);
  const r = await diffAgainst(standIn);
  assert.match(r.out, /Failed to read Figma components/);
  assert.match(r.out, /Failed to read page "Icons" of the Figma file: .*Component "Icon" on page "Icons" comes to \d+ bytes as use_figma returns it, more than the 17000 one call can carry under its 20kb response limit/);
  assert.match(r.out, /Figma read failed — diff results above are partial/);
  assert.doesNotMatch(r.out, /not in Figma|not in code|No differences found|Components in sync/);

  const strict = await diffAgainst(standIn, "--strict", "--json");
  assert.equal(strict.status, 1, strict.out);
  const data = JSON.parse(strict.stdout) as DiffJson;
  assert.equal(data.figmaReadFailed, true);
  assert.deepEqual(data.components, []);
  // use_figma never had to refuse a response: the read stopped first.
  assert.ok(standIn.figmaCalls.every((c) => c.bytes <= 17000 && !/exceeds/.test(c.error ?? "")));
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

// --- A Storybook or Figma that can't be reached ---

/** A URL nothing answers at: a port the system handed out and has taken back. */
async function unreachable(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("map, snap and diff CLI: a Storybook that can't be reached is an error that parses under --json", async () => {
  // The reason went only to stderr, so a script piping the output to jq got
  // nothing at all to parse.
  const url = await unreachable();
  const out = mkdtempSync(join(tmpdir(), "storysync-unreachable-"));
  try {
    for (const command of [["map"], ["snap", "--out", out]]) {
      const r = await run(...command, "--storybook", url, "--json");
      assert.equal(r.status, 1, r.out);
      const data = JSON.parse(r.stdout) as { error?: string };
      assert.match(data.error ?? "", new RegExp(`^Error: Failed to connect to Storybook MCP at ${escapeRegExp(url)}: \\S`), command[0]);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  // Figma is reached, so Storybook is the server it names.
  const r = await diffWith(url, "--json");
  assert.equal(r.status, 1, r.out);
  assert.match((JSON.parse(r.stdout) as { error?: string }).error ?? "", new RegExp(`^Error: Failed to connect to Storybook MCP at ${escapeRegExp(url)}: \\S`));
});

test("diff CLI: a Figma that can't be reached is an error that parses under --json", async () => {
  const url = `${await unreachable()}/mcp`;
  const r = await run("diff", "--figma", url, "--file-key", "x", "--storybook", storybook, "--json");
  assert.equal(r.status, 1, r.out);
  assert.match((JSON.parse(r.stdout) as { error?: string }).error ?? "", new RegExp(`^Error: Failed to connect to Figma MCP at ${escapeRegExp(url)}: \\S`));
});

test("list, inspect, map, snap and diff CLI: a Storybook that can't be reached fails on stderr without --json", async () => {
  const url = await unreachable();
  const out = mkdtempSync(join(tmpdir(), "storysync-unreachable-"));
  try {
    for (const command of [["list"], ["inspect", "--component", "Button"], ["map"], ["snap", "--out", out]]) {
      const r = await run(...command, "--storybook", url);
      assert.equal(r.status, 1, r.out);
      assert.equal(r.stdout, "", command[0]);
      assert.match(r.out, /Failed to connect to Storybook MCP/, command[0]);
      assert.doesNotMatch(r.out, STACK, command[0]);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  const r = await diffWith(url);
  assert.equal(r.status, 1, r.out);
  assert.equal(r.stdout, "");
  assert.match(r.out, /Connected to Figma MCP[\s\S]*Failed to connect to Storybook MCP/);
});

// --- A Storybook or Figma that takes the connection and never answers ---

/**
 * A server that accepts connections and never says a word, as a wrong host or
 * a hung server can. The run used to wait on it forever: the Streamable HTTP
 * initialize gave up after a minute, and the SSE fallback then waited with no
 * limit at all.
 */
async function silent(): Promise<{ url: string; close(): void }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

const NO_ANSWER = (server: string, url: string) =>
  new RegExp(`^Error: Failed to connect to ${server} at ${escapeRegExp(url)}: the server didn't answer within 0\\.5s; raise --connect-timeout`);

// A test that hangs would hold CI until the job's own limit, so each of these
// fails after 30 seconds instead.
test("map, snap and diff CLI: a Storybook that never answers fails after --connect-timeout, as JSON under --json", { timeout: 30_000 }, async () => {
  const server = await silent();
  const out = mkdtempSync(join(tmpdir(), "storysync-silent-"));
  try {
    for (const command of [["map"], ["snap", "--out", out]]) {
      const r = await run(...command, "--storybook", server.url, "--connect-timeout", "500", "--json");
      assert.equal(r.status, 1, r.out);
      assert.match((JSON.parse(r.stdout) as { error?: string }).error ?? "", NO_ANSWER("Storybook MCP", server.url), command[0]);
    }

    // Figma answers, so Storybook is the one it names.
    const r = await diffWith(server.url, "--connect-timeout", "500", "--json");
    assert.equal(r.status, 1, r.out);
    assert.match((JSON.parse(r.stdout) as { error?: string }).error ?? "", NO_ANSWER("Storybook MCP", server.url));
  } finally {
    rmSync(out, { recursive: true, force: true });
    server.close();
  }
});

test("diff CLI: a Figma that never answers fails after --connect-timeout, as JSON under --json", { timeout: 30_000 }, async () => {
  const server = await silent();
  try {
    const url = `${server.url}/mcp`;
    const r = await run("diff", "--figma", url, "--file-key", "x", "--storybook", storybook, "--connect-timeout", "500", "--json");
    assert.equal(r.status, 1, r.out);
    assert.match((JSON.parse(r.stdout) as { error?: string }).error ?? "", NO_ANSWER("Figma MCP", url));
  } finally {
    server.close();
  }
});

test("list and inspect CLI: a Storybook that never answers fails after --connect-timeout, on stderr", { timeout: 30_000 }, async () => {
  const server = await silent();
  try {
    for (const command of [["list"], ["inspect", "--component", "Button"]]) {
      const r = await run(...command, "--storybook", server.url, "--connect-timeout", "500");
      assert.equal(r.status, 1, r.out);
      assert.equal(r.stdout, "", command[0]);
      assert.match(r.out, /Failed to connect to Storybook MCP[\s\S]*the server didn't answer within 0\.5s/, command[0]);
      assert.doesNotMatch(r.out, STACK, command[0]);
    }
  } finally {
    server.close();
  }
});

test("map CLI: a server that answers isn't held to --connect-timeout once connected", { timeout: 30_000 }, async () => {
  // The limit's timer is cleared on connecting. Left running, it would keep
  // every run alive for the full minute after its work was done.
  const started = Date.now();
  const r = await run("map", "--storybook", storybook, "--json");
  assert.equal(r.status, 0, r.out);
  assert.ok(Date.now() - started < 20_000, `map took ${Date.now() - started}ms`);
});

test("map, snap, list, inspect and diff CLI: a --connect-timeout that isn't a positive number fails before connecting", async () => {
  const url = await unreachable();
  for (const value of ["0", "-1", "soon"]) {
    for (const command of [["map"], ["snap"], ["list"], ["inspect", "--component", "Button"], ["diff", "--figma", `${url}/mcp`, "--file-key", "x"]]) {
      const r = await run(...command, "--storybook", url, "--connect-timeout", value);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, new RegExp(`--connect-timeout must be a positive number of milliseconds, received "${value}"`), command[0]);
      assert.doesNotMatch(r.out, /MCP/, command[0]);
    }
  }
});

test("map CLI: a --connect-timeout past Node's longest timer is refused, not fired at once", async () => {
  // setTimeout fires after 1ms for anything above 2^31 - 1, so such a value
  // would fail every connect while telling the user to raise it.
  const url = await unreachable();
  for (const value of ["2147483648", "1e10"]) {
    const r = await run("map", "--storybook", url, "--connect-timeout", value);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--connect-timeout can be at most 2147483647 milliseconds/);
    assert.doesNotMatch(r.out, /MCP/);
  }
});
