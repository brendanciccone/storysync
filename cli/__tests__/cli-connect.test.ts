// Runs the compiled CLI against servers that refuse it, or take too long to
// answer, end to end: what a run says when Storybook or Figma answers the
// connection with an HTTP error, how long a request may take once
// connected, and what a snap stopped while it waits leaves behind. The
// servers are stand-ins on local ports, so this needs no network, no
// Storybook and no Figma.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectFailure } from "../mcp-connect.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Runs the CLI without blocking, since the stand-ins share this process. */
function run(...args: string[]): Promise<{ status: number; stdout: string; stderr: string; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 25_000, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      const status = err ? Number((err as { code?: unknown }).code ?? -1) : 0;
      resolve({ status, stdout, stderr, out: `${stdout}${stderr}`.replace(/\u001b\[[0-9;]*m/g, "") });
    });
  });
}

function emptyProject(): string {
  return mkdtempSync(join(tmpdir(), "storysync-connect-"));
}

// --- A server that answers the connection with an HTTP error ---

/**
 * An MCP endpoint that needs OAuth, as Figma's does to a client that isn't
 * signed in: a POST gets 401 with WWW-Authenticate, and the GET the SSE
 * fallback makes gets 405.
 */
function needsSignIn(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "POST") {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' });
    res.end(JSON.stringify({ error: "invalid_token", error_description: "Missing or invalid access token" }));
    return;
  }
  res.writeHead(405).end();
}

/** A Storybook without addon-mcp, which answers /mcp as it answers any path it doesn't serve. */
function noMcpEndpoint(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(404).end("Not Found");
}

test("diff CLI: a Figma MCP that needs signing in reports its 401, not the SSE fallback's 405", async () => {
  // The README's own example, https://mcp.figma.com/mcp, failed with
  // "SSE error: Non-200 status code (405)" while the README said to switch to
  // the skill on a 401 the output never showed.
  const url = `${await listen(needsSignIn)}/mcp`;
  const project = emptyProject();
  try {
    const json = await run("diff", "--figma", url, "--file-key", "x", "--project", project, "--json");
    assert.equal(json.status, 1, json.out);
    const error = (JSON.parse(json.stdout) as { error: string }).error;
    assert.match(error, new RegExp(`^Error: Failed to connect to Figma MCP at ${url.replace(/[.]/g, "\\.")}: ${url.replace(/[.]/g, "\\.")} answered HTTP 401 Unauthorized \\(\\{"error":"invalid_token"`));
    assert.match(error, /It needs you signed in to Figma, which the CLI can't do\. Use the skill's audit flow in a client that's signed in \(\/storysync-diff in Claude Code\)/);
    assert.match(error, /\(The SSE fallback failed too: Non-200 status code \(405\)\.\)$/);

    const text = await run("diff", "--figma", url, "--file-key", "x", "--project", project);
    assert.equal(text.status, 1, text.out);
    assert.match(text.out, /Failed to connect to Figma MCP/);
    assert.match(text.out, /answered HTTP 401 Unauthorized/);
    assert.doesNotMatch(text.out, /^Error: SSE error/m);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("list and map CLI: a Storybook with no /mcp endpoint reports the 404 and says to run init", async () => {
  const url = await listen(noMcpEndpoint);
  const list = await run("list", "--storybook", url);
  assert.equal(list.status, 1, list.out);
  assert.match(list.out, new RegExp(`${url.replace(/[.]/g, "\\.")}/mcp answered HTTP 404 Not Found\\. There's no MCP endpoint there\\. Is @storybook/addon-mcp installed and registered\\? Run \`storysync init\`, then restart Storybook\\.`));
  assert.doesNotMatch(list.out, /^Error: SSE error/m);

  const map = await run("map", "--storybook", url, "--json");
  assert.equal(map.status, 1, map.out);
  assert.match((JSON.parse(map.stdout) as { error: string }).error, /^Error: Failed to connect to Storybook MCP at .*: .*\/mcp answered HTTP 404 Not Found.*storysync init/);
});

test("list CLI: a Storybook that isn't running is said to be refused, asking whether it is running", async () => {
  // A port the system handed out and has taken back.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const r = await run("list", "--storybook", `http://127.0.0.1:${port}`);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`Couldn't connect to http://127\\.0\\.0\\.1:${port}/mcp: fetch failed: connect ECONNREFUSED 127\\.0\\.0\\.1:${port}\\. Is Storybook running there\\?`));
  // Both transports were refused alike, so it is said once.
  assert.doesNotMatch(r.out, /SSE/);
});

test("connectFailure: leads with the Streamable HTTP status, with a hint for each server", () => {
  const url = new URL("http://localhost:6006/mcp");
  const status = (code: number, body: string) => Object.assign(new Error(`Streamable HTTP error: Error POSTing to endpoint: ${body}`), { code });
  const sse = Object.assign(new Error("SSE error: Non-200 status code (405)"), { code: 405 });

  // An auth failure in front of Storybook has no skill to turn to.
  // A body that only repeats the status isn't said twice.
  assert.match(connectFailure("Storybook", url, status(403, "Forbidden"), sse).message, /^http:\/\/localhost:6006\/mcp answered HTTP 403 Forbidden\. Something in front of Storybook needs you signed in/);
  assert.match(connectFailure("Storybook", url, status(403, "no access to this proxy"), sse).message, /^http:\/\/localhost:6006\/mcp answered HTTP 403 Forbidden \(no access to this proxy\)\. Something/);
  assert.match(connectFailure("Figma", url, status(404, ""), sse).message, /answered HTTP 404 Not Found\. There's no MCP endpoint at that URL\. Check --figma\./);
  // An HTML error page isn't quoted, and a status with no hint gets none.
  assert.equal(
    connectFailure("Storybook", url, status(502, "<!doctype html><html>Bad gateway</html>"), sse).message,
    "http://localhost:6006/mcp answered HTTP 502 Bad Gateway. (The SSE fallback failed too: Non-200 status code (405).)",
  );
  // A JSON-RPC error has a code too, but it isn't an HTTP status.
  assert.match(connectFailure("Storybook", url, Object.assign(new Error("MCP error -32603: boom."), { code: -32603 }), sse).message, /^Couldn't connect to http:\/\/localhost:6006\/mcp: MCP error -32603: boom\. \(The SSE fallback failed too/);
});

// --- A request that takes too long once connected ---

const LIST = "- Button (forms-button)\n  - Primary (forms-button--primary)";
const DOCS = "```ts\nexport type Props = {\n  size?: \"sm\" | \"lg\" = \"sm\";\n}\n```";

type Rpc = { id?: number; method: string; params?: { protocolVersion?: string; name?: string } };

/**
 * A Storybook (and Figma) MCP stand-in whose tools answer after
 * `delays[tool]` milliseconds, or never when that is Infinity. Records each
 * call by name in `calls`.
 */
async function slowStandIn(delays: Record<string, number>): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = [];
  const tools = ["docs-list", "docs-show", "use_figma"];
  const url = await listen((req, res) => {
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
      const answer = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.method === "initialize") {
        answer({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow", version: "0" } });
      } else if (message.method === "tools/list") {
        answer({ tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
      } else if (message.method === "tools/call") {
        const name = message.params?.name ?? "";
        calls.push(name);
        const text = name === "docs-list" ? LIST : name === "docs-show" ? DOCS : "{}";
        const delay = delays[name] ?? 0;
        if (delay !== Infinity) setTimeout(() => answer({ content: [{ type: "text", text }] }), delay);
      } else {
        answer({});
      }
    });
  });
  return { url, calls };
}

test("map CLI: a docs-show that never answers fails its component within --connect-timeout, and --strict", { timeout: 30_000 }, async () => {
  // Each request got the SDK's fixed 60 seconds, whatever --connect-timeout
  // said, and failed with "MCP error -32001: Request timed out", naming
  // neither the limit nor the flag.
  const { url } = await slowStandIn({ "docs-show": Infinity });
  const started = Date.now();
  const strict = await run("map", "--storybook", url, "--connect-timeout", "1500", "--json", "--strict");
  assert.equal(strict.status, 1, strict.out);
  assert.ok(Date.now() - started < 15_000, `map took ${Date.now() - started}ms`);
  const data = JSON.parse(strict.stdout) as { components: { name: string; error: string | null }[]; summary: { failed: number } };
  assert.equal(data.summary.failed, 1);
  assert.equal(data.components[0].error, "Error: Storybook MCP didn't answer docs-show within 1.5s; raise --connect-timeout if it needs longer");

  // Without --strict a failed component is reported and the run exits 0, as
  // for any other component that can't be read.
  const lenient = await run("map", "--storybook", url, "--connect-timeout", "1500", "--json");
  assert.equal(lenient.status, 0, lenient.out);
  assert.equal((JSON.parse(lenient.stdout) as { summary: { failed: number } }).summary.failed, 1);
});

test("map CLI: --connect-timeout sets how long each request may take, not only connecting", { timeout: 30_000 }, async () => {
  const { url } = await slowStandIn({ "docs-show": 1200 });
  const short = await run("map", "--storybook", url, "--connect-timeout", "500", "--json");
  assert.match((JSON.parse(short.stdout) as { components: { error: string | null }[] }).components[0].error ?? "", /didn't answer docs-show within 0\.5s/);

  const long = await run("map", "--storybook", url, "--connect-timeout", "5000", "--json", "--strict");
  assert.equal(long.status, 0, long.out);
  assert.equal((JSON.parse(long.stdout) as { summary: { mapped: number } }).summary.mapped, 1);
});

test("diff CLI: a use_figma that never answers fails the Figma read within --connect-timeout", { timeout: 30_000 }, async () => {
  const { url } = await slowStandIn({ use_figma: Infinity });
  const project = emptyProject();
  try {
    const r = await run("diff", "--figma", `${url}/mcp`, "--file-key", "x", "--project", project, "--connect-timeout", "1500", "--strict");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Failed to read Figma variables/);
    assert.match(r.out, /Figma MCP didn't answer use_figma within 1\.5s; raise --connect-timeout if it needs longer/);
    assert.match(r.out, /Figma read failed — diff results above are partial/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- A snap that is stopped ---

test("snap CLI: SIGTERM stops the run without writing a styles.json", { timeout: 30_000 }, async (t) => {
  // Playwright closed the browser on SIGTERM and left snap running: every
  // component left was recorded as a failed browser session, written over
  // the last styles.json, and the run exited 0.
  const { url, calls } = await slowStandIn({ "docs-show": Infinity });
  const out = mkdtempSync(join(tmpdir(), "storysync-sigterm-"));
  try {
    const child = spawn(process.execPath, [CLI, "snap", "--storybook", url, "--out", out, "--json", "--connect-timeout", "20000"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

    // The browser is up once snap asks for a component's docs.
    const deadline = Date.now() + 15_000;
    while (!calls.includes("docs-show") && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!calls.includes("docs-show")) {
      child.kill("SIGKILL");
      await exited;
      if (/Could not find a Chromium-based browser|needs Node 20 or newer/.test(output)) {
        t.skip("no browser for snap here");
        return;
      }
      assert.fail(`snap never read a component: ${output}`);
    }

    child.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 143, output);
    assert.equal(existsSync(join(out, "styles.json")), false, "a stopped snap must not write styles.json");
    assert.equal(existsSync(join(out, "meta.json")), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
