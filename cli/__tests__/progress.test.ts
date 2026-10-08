// The status line long runs draw on a terminal, and the CLI wiring that
// keeps it off stdout and out of logs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusLine, Progress, isInteractive } from "../progress.js";
import { runSnap } from "../snap.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));
const CLEAR = "\r\u001b[2K";

/** A stream that records what is written to it. */
function terminal(isTTY = true, columns = 80) {
  const writes: string[] = [];
  return { isTTY, columns, writes, write: (chunk: string) => writes.push(chunk) };
}

const NO_CI: NodeJS.ProcessEnv = { TERM: "xterm-256color" };

test("isInteractive: a terminal, but not a dumb one, and not under CI", () => {
  assert.equal(isInteractive({ isTTY: true, write() {} }, NO_CI), true);
  assert.equal(isInteractive({ isTTY: false, write() {} }, NO_CI), false);
  assert.equal(isInteractive({ write() {} }, NO_CI), false);
  assert.equal(isInteractive({ isTTY: true, write() {} }, { TERM: "dumb" }), false);
  // GitHub Actions sets CI=true; any value counts, as for ora.
  assert.equal(isInteractive({ isTTY: true, write() {} }, { CI: "" }), false);
});

test("StatusLine: redraws one line in place, and clears it", () => {
  const stream = terminal();
  const line = new StatusLine(stream, NO_CI);
  line.show("map 1/2 Forms/Button");
  line.show("map 2/2 Forms/Card");
  line.clear();
  line.clear();
  assert.deepEqual(stream.writes, [`${CLEAR}map 1/2 Forms/Button`, `${CLEAR}map 2/2 Forms/Card`, CLEAR]);
});

test("StatusLine: writes nothing at all when the stream isn't a terminal", () => {
  for (const [stream, env] of [[terminal(false), NO_CI], [terminal(true), { CI: "true" }]] as const) {
    const line = new StatusLine(stream, env);
    line.show("map 1/2 Forms/Button");
    line.around(() => {});
    line.clear();
    assert.deepEqual(stream.writes, []);
  }
});

test("StatusLine: a line wider than the terminal is cut to fit, since a wrapped one can't be redrawn", () => {
  const stream = terminal(true, 20);
  new StatusLine(stream, NO_CI).show("snap 12/134 UI Base/Navigation Menu, variant 3/32");
  assert.deepEqual(stream.writes, [`${CLEAR}snap 12/134 UI Bas…`]);
  assert.equal(stream.writes[0].length - CLEAR.length, 19);

  // No width at all is taken as 80 columns, not none.
  const unsized = terminal(true, 0);
  new StatusLine(unsized, NO_CI).show("map 1/1 UI Base/Button");
  assert.deepEqual(unsized.writes, [`${CLEAR}map 1/1 UI Base/Button`]);
});

test("StatusLine: around() prints with the line cleared, then draws it again", () => {
  const stream = terminal();
  const line = new StatusLine(stream, NO_CI);
  line.show("snap 1/2 Forms/Button");
  line.around(() => stream.write("  ✓ Forms/Button 2/2 variants measured\n"));
  assert.deepEqual(stream.writes, [
    `${CLEAR}snap 1/2 Forms/Button`,
    CLEAR,
    "  ✓ Forms/Button 2/2 variants measured\n",
    `${CLEAR}snap 1/2 Forms/Button`,
  ]);
});

test("Progress: names the command, the component and the variant", () => {
  const stream = terminal();
  const progress = new Progress("snap", new StatusLine(stream, NO_CI));
  progress.component(12, 134, "UI Base/Command");
  progress.variant(3, 32);
  progress.component(13, 134, "UI Base/Dialog");
  progress.done();
  assert.deepEqual(stream.writes, [
    `${CLEAR}snap 12/134 UI Base/Command`,
    `${CLEAR}snap 12/134 UI Base/Command, variant 3/32`,
    `${CLEAR}snap 13/134 UI Base/Dialog`,
    CLEAR,
  ]);
});

test("runSnap: says as each component, and each of its variants, starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-progress-"));
  const steps: string[] = [];
  try {
    await runSnap({ storybookUrl: "http://localhost:6006", outDir: dir, screenshots: false, timeoutMs: 1000, variants: "representative" }, {
      storybook: {
        listComponents: async () => [
          { id: "forms-button", name: "Button", title: "Forms/Button" },
          { id: "forms-card", name: "Card" },
        ],
        getComponent: async (id: string) => id === "forms-button"
          ? { name: "Button", props: [{ name: "size", type: { name: "string" }, control: { type: "select", options: ["sm", "lg"] } }], stories: [{ id: "forms-button--default", name: "Default" }] }
          : { name: "Card", props: [], stories: [{ id: "forms-card--default", name: "Default" }] },
      } as never,
      // A page that renders nothing: each variant still starts.
      launch: async () => ({
        via: "stub",
        browser: { newContext: async () => ({ newPage: async () => ({}), close: async () => {} }), close: async () => {} },
      }) as never,
      onComponentStart: (position, total, label) => steps.push(`${position}/${total} ${label}`),
      onVariantStart: (position, total) => steps.push(`  ${position}/${total}`),
    });
    assert.deepEqual(steps, ["1/2 Forms/Button", "  1/2", "  2/2", "2/2 Card", "  1/1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- map --json on a terminal ---

let server: Server | null = null;
after(() => server?.close());

/** A Storybook MCP stand-in with two components. */
async function storybook(): Promise<string> {
  const list = "- Button (forms-button)\n  - Primary (forms-button--primary)\n- Card (data-display-card)\n  - Default (data-display-card--default)";
  server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string } };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result = message.method === "initialize"
        ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } }
        : message.method === "tools/list"
          ? { tools: ["docs-list", "docs-show"].map((name) => ({ name, inputSchema: { type: "object" } })) }
          : { content: [{ type: "text", text: message.params?.name === "docs-list" ? list : "No props." }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Runs the CLI with stderr made to look like a terminal, or not, and CI unset. */
function run(tty: boolean, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "storysync-tty-"));
  const preload = join(dir, "tty.cjs");
  writeFileSync(preload, tty ? "Object.defineProperty(process.stderr, 'isTTY', { value: true }); process.stderr.columns = 120;\n" : "");
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
  delete env.CI;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--require", preload, CLI, ...args], { encoding: "utf8", env, timeout: 25_000, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ status: err ? Number((err as { code?: unknown }).code ?? -1) : 0, stdout, stderr });
    });
  });
}

test("map CLI: --json says which component it's on, on a terminal's stderr, and keeps stdout to the JSON", { timeout: 30_000 }, async () => {
  const url = await storybook();
  const onTerminal = await run(true, "map", "--storybook", url, "--json");
  assert.equal(onTerminal.status, 0, onTerminal.stderr);
  assert.equal((JSON.parse(onTerminal.stdout) as { summary: { mapped: number } }).summary.mapped, 2);
  assert.ok(onTerminal.stderr.includes(`${CLEAR}map 1/2 Forms/Button`), onTerminal.stderr);
  assert.ok(onTerminal.stderr.includes(`${CLEAR}map 2/2 Data Display/Card`), onTerminal.stderr);
  // Cleared before the JSON is printed, so nothing is left on the line.
  assert.ok(onTerminal.stderr.endsWith(CLEAR), JSON.stringify(onTerminal.stderr));

  // Piped, as in CI or an agent's shell, stderr stays empty.
  const piped = await run(false, "map", "--storybook", url, "--json");
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.stderr, "");
  assert.equal(piped.stdout, onTerminal.stdout);
});
