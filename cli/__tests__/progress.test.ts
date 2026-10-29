// The status line long runs draw on a terminal, and the CLI wiring that
// keeps it off stdout and out of logs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusLine, Progress, isInteractive, progressMode, widenZeroWidthTerminal } from "../progress.js";
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

test("progressMode: redrawn on a terminal, a line each where STORYSYNC_PROGRESS asks, otherwise nothing", () => {
  assert.equal(progressMode(terminal(), NO_CI), "redraw");
  assert.equal(progressMode(terminal(false), NO_CI), "off");
  // An agent's shell and a CI log can't redraw, but can follow lines.
  assert.equal(progressMode(terminal(false), { ...NO_CI, STORYSYNC_PROGRESS: "1" }), "lines");
  assert.equal(progressMode(terminal(true), { CI: "true", STORYSYNC_PROGRESS: "1" }), "lines");
  // And can turn it off on a terminal.
  assert.equal(progressMode(terminal(), { ...NO_CI, STORYSYNC_PROGRESS: "0" }), "off");
  assert.equal(progressMode(terminal(false), { ...NO_CI, STORYSYNC_PROGRESS: "false" }), "off");
  assert.equal(progressMode(terminal(false), { ...NO_CI, STORYSYNC_PROGRESS: "" }), "off");
});

test("StatusLine: with STORYSYNC_PROGRESS and no terminal, writes a plain line each, never a redraw", () => {
  const stream = terminal(false);
  const line = new StatusLine(stream, { STORYSYNC_PROGRESS: "1" });
  line.show("map 1/2 Forms/Button");
  line.around(() => stream.write("printed\n"));
  line.show("map 2/2 Forms/Card");
  line.clear();
  assert.deepEqual(stream.writes, ["map 1/2 Forms/Button\n", "printed\n", "map 2/2 Forms/Card\n"]);
});

test("StatusLine: a title with a line break in it is still one line, so a CI log reads no workflow command from it", () => {
  const stream = terminal(false);
  const line = new StatusLine(stream, { STORYSYNC_PROGRESS: "1" });
  line.show("map 1/1 Forms/Button\n::error::forged\r\n\u2028x");
  // The runner reads ##[ anywhere in a line, and :: at its start.
  line.show("map 1/1 Forms/##[stop-commands]x");
  line.show("::warning::forged");
  assert.deepEqual(stream.writes, ["map 1/1 Forms/Button ::error::forged x\n", "map 1/1 Forms/## [stop-commands]x\n", ": :warning::forged\n"]);
});

/** A stand-in for the process's events, recording the signals it is sent. */
function processEvents() {
  const events = Object.assign(new EventEmitter(), { pid: 4242, sent: [] as string[] });
  return Object.assign(events, { kill: (_pid: number, signal: string) => { events.sent.push(signal); return true; } });
}

test("StatusLine: is cleared however the process ends, and a signal it alone heard is raised again", () => {
  // Ctrl-C during map --json left "map 3/10 ..." on the terminal, with the
  // shell's prompt drawn on the end of it.
  const events = processEvents();
  const stream = terminal();
  const line = new StatusLine(stream, NO_CI, events as never);
  assert.equal(events.listenerCount("SIGINT"), 0, "nothing is heard before a line is drawn");
  line.show("map 3/10 Forms/Button");
  events.emit("SIGINT", "SIGINT");
  assert.deepEqual(stream.writes, [`${CLEAR}map 3/10 Forms/Button`, CLEAR]);
  // So the process still ends by the signal, as it would have.
  assert.deepEqual(events.sent, ["SIGINT"]);
  for (const name of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(events.listenerCount(name), 0, name);

  // Another listener, such as snap's, ends the run itself.
  const owned = processEvents();
  owned.on("SIGTERM", () => {});
  const second = terminal();
  const snapLine = new StatusLine(second, NO_CI, owned as never);
  snapLine.show("snap 1/2 Forms/Button");
  owned.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(second.writes, [`${CLEAR}snap 1/2 Forms/Button`, CLEAR]);
  assert.deepEqual(owned.sent, []);

  // A listener before it in the same emit that clears the line, as snap's
  // does, leaves it nothing to do: in particular, no signal raised again.
  const cleared = processEvents();
  const third = terminal();
  const clearedLine = new StatusLine(third, NO_CI, cleared as never);
  cleared.on("SIGHUP", () => clearedLine.clear());
  clearedLine.show("snap 1/1 Forms/Button");
  cleared.emit("SIGHUP", "SIGHUP");
  assert.deepEqual(cleared.sent, []);

  // Exiting clears it too, as Playwright's process.exit(130) on Ctrl-C does.
  snapLine.show("snap 2/2 Forms/Card");
  owned.emit("exit", 130);
  assert.equal(second.writes.at(-1), CLEAR);
  assert.equal(owned.listenerCount("exit"), 0);
});

test("widenZeroWidthTerminal: a terminal reporting 0 columns is taken as 80, and nothing else changes", () => {
  const zero = terminal(true, 0);
  widenZeroWidthTerminal(zero);
  assert.equal(zero.columns, 80);
  const sized = terminal(true, 120);
  widenZeroWidthTerminal(sized);
  assert.equal(sized.columns, 120);
  const piped: { isTTY: boolean; columns?: number; write(): void } = { isTTY: false, write() {} };
  widenZeroWidthTerminal(piped);
  assert.equal(piped.columns, undefined);
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

const servers: Server[] = [];
const EMPTY_SLICE = JSON.stringify({ total: 0, next: null, items: [] });
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

/**
 * A Storybook MCP stand-in with two components, whose docs-show answers
 * after `docsDelayMs`, or never. It serves use_figma too, as a Figma file
 * with nothing in it, for diff.
 */
async function storybook(docsDelayMs = 0): Promise<string> {
  const list = "- Button (forms-button)\n  - Primary (forms-button--primary)\n- Card (data-display-card)\n  - Default (data-display-card--default)";
  const server = createServer((req, res) => {
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
          ? { tools: ["docs-list", "docs-show", "use_figma"].map((name) => ({ name, inputSchema: { type: "object" } })) }
          : { content: [{ type: "text", text: message.params?.name === "docs-list" ? list : message.params?.name === "use_figma" ? EMPTY_SLICE : "No props." }] };
      const answer = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.params?.name !== "docs-show" || !docsDelayMs) answer();
      else if (docsDelayMs !== Infinity) setTimeout(answer, docsDelayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Makes stderr look like a terminal `columns` wide, with the cursor methods ora uses. */
function ttyPreload(columns: number): string {
  return [
    "Object.defineProperty(process.stderr, 'isTTY', { value: true });",
    `process.stderr.columns = ${columns};`,
    // ora clears a line at a time; counted, so a spinner that never stops
    // clearing ends the run rather than filling memory.
    "let cleared = 0;",
    "process.stderr.clearLine = () => { if (++cleared > 10000) { require('fs').writeSync(2, '\\nCLEARED FOREVER\\n'); process.exit(99); } return process.stderr.write('\\u001b[2K'); };",
    "process.stderr.cursorTo = (x) => process.stderr.write(`\\u001b[${x + 1}G`);",
    "process.stderr.moveCursor = (dx, dy) => process.stderr.write(dy < 0 ? `\\u001b[${-dy}A` : '');",
    "",
  ].join("\n");
}

/** The environment a run gets: CI unset, as on a developer's machine, and `extra` added. */
function runEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
  delete env.CI;
  delete env.STORYSYNC_PROGRESS;
  return { ...env, ...extra };
}

/** Writes a --require preload for a run, returning its path and a cleanup. */
function preloadFile(source: string): { path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "storysync-tty-"));
  const path = join(dir, "tty.cjs");
  writeFileSync(path, source);
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs the CLI with stderr made to look like a terminal, or not, and CI unset. */
function run(tty: boolean | { columns: number }, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  const preload = preloadFile(tty === false ? "" : ttyPreload(tty === true ? 120 : tty.columns));
  return new Promise((resolve) => {
    execFile(process.execPath, ["--require", preload.path, CLI, ...args], { encoding: "utf8", env: runEnv(extraEnv), timeout: 25_000, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      preload.remove();
      resolve({ status: err ? Number((err as { code?: unknown }).code ?? -1) : 0, stdout, stderr });
    });
  });
}

test("map CLI: --json says which component it's on, on a terminal's stderr, and keeps stdout to the JSON", { timeout: 30_000 }, async () => {
  const url = await storybook();
  const onTerminal = await run(true, ["map", "--storybook", url, "--json"]);
  assert.equal(onTerminal.status, 0, onTerminal.stderr);
  assert.equal((JSON.parse(onTerminal.stdout) as { summary: { mapped: number } }).summary.mapped, 2);
  assert.ok(onTerminal.stderr.includes(`${CLEAR}map 1/2 Forms/Button`), onTerminal.stderr);
  assert.ok(onTerminal.stderr.includes(`${CLEAR}map 2/2 Data Display/Card`), onTerminal.stderr);
  // Cleared before the JSON is printed, so nothing is left on the line.
  assert.ok(onTerminal.stderr.endsWith(CLEAR), JSON.stringify(onTerminal.stderr));

  // Piped, as in CI or an agent's shell, stderr stays empty.
  const piped = await run(false, ["map", "--storybook", url, "--json"]);
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.stderr, "");
  assert.equal(piped.stdout, onTerminal.stdout);

  // Asked for, a line each, which a backgrounded run's stderr file can be
  // read for.
  const asked = await run(false, ["map", "--storybook", url, "--json"], { STORYSYNC_PROGRESS: "1" });
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(asked.stderr, "map 1/2 Forms/Button\nmap 2/2 Data Display/Card\n");
  assert.equal(asked.stdout, onTerminal.stdout);
});

test("diff CLI: --json says which component it's mapping, on a terminal, or a line each when asked", { timeout: 30_000 }, async () => {
  const url = await storybook();
  const project = mkdtempSync(join(tmpdir(), "storysync-diff-progress-"));
  try {
    const args = ["diff", "--figma", `${url}/mcp`, "--file-key", "x", "--storybook", url, "--project", project, "--json"];
    const onTerminal = await run(true, args);
    assert.equal(onTerminal.status, 0, onTerminal.stderr);
    assert.ok(onTerminal.stderr.includes(`${CLEAR}diff 1/2 Forms/Button`), onTerminal.stderr);
    assert.ok(onTerminal.stderr.endsWith(CLEAR), JSON.stringify(onTerminal.stderr));
    assert.equal((JSON.parse(onTerminal.stdout) as { storybookReadFailed: boolean }).storybookReadFailed, false);

    const piped = await run(false, args);
    assert.equal(piped.stderr, "");
    const asked = await run(false, args, { STORYSYNC_PROGRESS: "1" });
    assert.equal(asked.stderr, "diff 1/2 Forms/Button\ndiff 2/2 Data Display/Card\n");
    assert.equal(asked.stdout, piped.stdout);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("map CLI: Ctrl-C clears the status line, and the run still ends by SIGINT", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const url = await storybook(Infinity);
  const preload = preloadFile(ttyPreload(120));
  try {
    const child = spawn(process.execPath, ["--require", preload.path, CLI, "map", "--storybook", url, "--json"], { env: runEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 15_000;
    while (!stderr.includes("map 1/2") && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(stderr.includes(`${CLEAR}map 1/2 Forms/Button`), stderr);

    child.kill("SIGINT");
    const { signal } = await exited;
    assert.equal(signal, "SIGINT");
    assert.ok(stderr.endsWith(CLEAR), JSON.stringify(stderr));
  } finally {
    preload.remove();
  }
});

test("CLI: a spinner on a terminal that reports 0 columns finishes, rather than clearing forever", { timeout: 30_000 }, async () => {
  // ora divides the line by the terminal's width, so it counted infinitely
  // many lines to clear: 941MB written in five minutes under `script`.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const r = await run({ columns: 0 }, ["list", "--storybook", `http://127.0.0.1:${port}`]);
  assert.equal(r.status, 1, r.stderr.slice(-500));
  assert.doesNotMatch(r.stderr, /CLEARED FOREVER/);
  assert.match(r.stderr, /Failed to connect to Storybook MCP/);
});
