// Runs the compiled CLI against servers that refuse it, or take too long to
// answer, end to end: what a run says when Storybook or Figma answers the
// connection with an HTTP error, how long a request may take once
// connected, and what a snap stopped while it waits leaves behind. The
// servers are stand-ins on local ports, so this needs no network, no
// Storybook and no Figma.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectFailure } from "../mcp-connect.js";
import { runSnap } from "../snap.js";

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
  // The SSE fallback's GET got the same 404, which says nothing more.
  assert.doesNotMatch(list.out, /SSE/);

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

test("list CLI: localhost refused on both its addresses is said once, with the hint at the end", async () => {
  // localhost is ::1 and 127.0.0.1, and Node's fetch, refused on both, gives
  // a cause with no message, only a code. The reason read "fetch failed:
  // ECONNREFUSED", which didn't match the SSE fallback's list of addresses,
  // so the refusal was said twice with the hint between. localhost is the
  // --storybook the README uses throughout.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const r = await run("list", "--storybook", `http://localhost:${port}`);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`Couldn't connect to http://localhost:${port}/mcp: fetch failed: (connect ECONNREFUSED \\S+:${port}(, )?)+\\. Is Storybook running there\\?\\n`));
  assert.doesNotMatch(r.out, /SSE/);

  const json = await run("map", "--storybook", `http://localhost:${port}`, "--json");
  assert.equal(json.status, 1, json.out);
  assert.match((JSON.parse(json.stdout) as { error: string }).error, /ECONNREFUSED .*\. Is Storybook running there\?$/);
});

test("connectFailure: a refusal on each of several addresses is said once, naming them", () => {
  const url = new URL("http://localhost:6006/mcp");
  const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED" });
  const both = Object.assign(new AggregateError([refused("::1:6006"), refused("127.0.0.1:6006")], ""), { code: "ECONNREFUSED" });
  const streamable = new TypeError("fetch failed", { cause: both });
  const sse = new Error("SSE error: TypeError: fetch failed: connect ECONNREFUSED ::1:6006, connect ECONNREFUSED 127.0.0.1:6006");
  assert.equal(
    connectFailure("Storybook", url, streamable, sse).message,
    "Couldn't connect to http://localhost:6006/mcp: fetch failed: connect ECONNREFUSED ::1:6006, connect ECONNREFUSED 127.0.0.1:6006. Is Storybook running there?",
  );
  // Said differently by the fallback, the same refusal is still said once.
  assert.doesNotMatch(connectFailure("Storybook", url, streamable, new Error("SSE error: connect ECONNREFUSED 127.0.0.1:6006")).message, /SSE/);
  // A different reason is worth saying.
  assert.match(connectFailure("Storybook", url, streamable, new Error("SSE error: getaddrinfo ENOTFOUND localhost")).message, /\(The SSE fallback failed too: getaddrinfo ENOTFOUND localhost\.\)$/);
  // With only a code to go on, the code is said, and the fallback's
  // refusal is the same one.
  const bare = new TypeError("fetch failed", { cause: Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }) });
  assert.equal(connectFailure("Figma", url, bare, sse).message, "Couldn't connect to http://localhost:6006/mcp: fetch failed: ECONNREFUSED.");
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
  // The fallback's GET answered with the same status: said once.
  assert.equal(
    connectFailure("Figma", url, status(404, ""), Object.assign(new Error("SSE error: Non-200 status code (404)"), { code: 404 })).message,
    "http://localhost:6006/mcp answered HTTP 404 Not Found. There's no MCP endpoint at that URL. Check --figma.",
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

const CLEAR = "\r\u001b[2K";

for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const) {
  test(`snap CLI: ${signal} stops the run without writing a styles.json, and clears the status line`, { timeout: 30_000, skip: process.platform === "win32" }, async (t) => {
    // Playwright closed the browser on SIGTERM and left snap running: every
    // component left was recorded as a failed browser session, written over
    // the last styles.json, and the run exited 0. SIGHUP, a closed terminal,
    // did the same. Ctrl-C ended it by Playwright's handler, saying nothing.
    // The docs request in flight never answers, so the run stops at once,
    // not when the request gives up.
    const { url, calls } = await slowStandIn({ "docs-show": Infinity });
    const out = mkdtempSync(join(tmpdir(), "storysync-sigterm-"));
    // stderr made to look like a terminal, so the status line is drawn.
    const preload = join(out, "tty.cjs");
    writeFileSync(preload, "Object.defineProperty(process.stderr, 'isTTY', { value: true }); process.stderr.columns = 120;\n");
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
    delete env.CI;
    delete env.STORYSYNC_PROGRESS;
    try {
      const child = spawn(process.execPath, ["--require", preload, CLI, "snap", "--storybook", url, "--out", out, "--json", "--connect-timeout", "20000"], { env, stdio: ["ignore", "pipe", "pipe"] });
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

      child.kill(signal);
      const exit = await exited;
      assert.equal(exit.code, code, output);
      assert.equal(existsSync(join(out, "styles.json")), false, "a stopped snap must not write styles.json");
      assert.equal(existsSync(join(out, "meta.json")), false);
      // The line was drawn, then cleared before snap said it stopped.
      assert.ok(output.includes(`${CLEAR}snap 1/1 Forms/Button`), JSON.stringify(output));
      assert.ok(output.endsWith(`${CLEAR}snap was stopped by ${signal} before it finished, so styles.json and meta.json in ${out} were left as they were.\n`), JSON.stringify(output));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

test("runSnap: a browser that goes partway through twice stops the run, leaving the last styles.json as it was", async () => {
  // Chrome crashing, or killed from outside, failed every component left as
  // a broken browser session; the run then wrote that over the last
  // styles.json and meta.json, and exited 0. It is launched once more now,
  // and a second loss stops the run. Here the browsers say so only by their
  // disconnected event.
  const out = mkdtempSync(join(tmpdir(), "storysync-lost-"));
  writeFileSync(join(out, "styles.json"), "last good snap\n");
  const read: string[] = [];
  let disconnected: (() => void) | undefined;
  let launches = 0;
  let closed = 0;
  try {
    await assert.rejects(
      runSnap({ storybookUrl: "http://localhost:6006", outDir: out, screenshots: false, timeoutMs: 1000, variants: "representative" }, {
        storybook: {
          listComponents: async () => [
            { id: "forms-button", name: "Button" },
            { id: "forms-card", name: "Card" },
            { id: "forms-input", name: "Input" },
          ],
          getComponent: async (id: string) => {
            read.push(id);
            // Each browser goes while the first component is read.
            if (id === "forms-button") disconnected?.();
            return { name: id, props: [], stories: [{ id: `${id}--default`, name: "Default" }] };
          },
        } as never,
        launch: async () => {
          launches++;
          return {
            via: "stub",
            browser: {
              on: (event: string, listener: () => void) => { if (event === "disconnected") disconnected = listener; },
              newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
              close: async () => { closed++; },
            },
          } as never;
        },
      }),
      /^Error: The browser closed before snap finished \(it crashed, or something stopped it\), with 0 of 3 components read\. styles\.json and meta\.json were left as they were\. Run snap again\.$/,
    );
    // The first component was read again with the second browser, and no
    // more components were tried, and nothing was written.
    assert.equal(launches, 2);
    assert.deepEqual(read, ["forms-button", "forms-button"]);
    assert.equal(readFileSync(join(out, "styles.json"), "utf8"), "last good snap\n");
    assert.equal(existsSync(join(out, "meta.json")), false);
    assert.ok(closed >= 2, `closed ${closed} browsers`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("runSnap: a browser found closed once a component has finished is relaunched, and the component measured again", async () => {
  // The disconnected event and the failures it causes can arrive in either
  // order, so the browser is asked too, after each component as well: the
  // component's failures may have been the browser going.
  const out = mkdtempSync(join(tmpdir(), "storysync-lost-"));
  const read: string[] = [];
  try {
    const browsers = [false, true].map((stays) => {
      let connected = true;
      return {
        on: () => {},
        isConnected: () => connected,
        newContext: async () => ({ newPage: async () => ({}), close: async () => { if (!stays) connected = false; } }),
        close: async () => {},
      };
    });
    const result = await runSnap({ storybookUrl: "http://localhost:6006", outDir: out, screenshots: false, timeoutMs: 1000, variants: "representative" }, {
      storybook: {
        listComponents: async () => [{ id: "forms-button", name: "Button" }],
        getComponent: async (id: string) => {
          read.push(id);
          return { name: "Button", props: [], stories: [{ id: "forms-button--default", name: "Default" }] };
        },
      } as never,
      launch: async () => ({ via: "stub", browser: browsers.shift() }) as never,
    });
    assert.deepEqual(read, ["forms-button", "forms-button"]);
    assert.equal(result.components.length, 1);
    assert.ok(existsSync(join(out, "styles.json")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("runSnap: a browser found closed after the last component, twice, still writes nothing", async () => {
  const out = mkdtempSync(join(tmpdir(), "storysync-lost-"));
  try {
    await assert.rejects(
      runSnap({ storybookUrl: "http://localhost:6006", outDir: out, screenshots: false, timeoutMs: 1000, variants: "representative" }, {
        storybook: {
          listComponents: async () => [{ id: "forms-button", name: "Button" }],
          getComponent: async () => ({ name: "Button", props: [], stories: [{ id: "forms-button--default", name: "Default" }] }),
        } as never,
        launch: async () => {
          let connected = true;
          return {
            via: "stub",
            browser: {
              on: () => {},
              isConnected: () => connected,
              newContext: async () => ({ newPage: async () => ({}), close: async () => { connected = false; } }),
              close: async () => {},
            },
          } as never;
        },
      }),
      /with 0 of 1 components read/,
    );
    assert.equal(existsSync(join(out, "styles.json")), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
