// A push end to end, as the skill runs it, for every element-tree fixture:
// the compiled CLI's `figma code` writes the calls; each runs, unchanged, in
// the mock Figma, its response saved unchanged where plan.json says; a build
// that lists uploads gets an upload_assets response and `figma upload`
// posts the thumbnails to it; a read whose result has `more` is continued
// with `figma next`; and `verify --plan --strict` assembles the readback
// from the saved responses and scores it. A faithful pipeline scores every
// element of every fixture, and exits 0.
//
// The CLI runs as a child process, as the agent runs it, and asynchronously,
// so the stand-in upload server in this process can answer `figma upload`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MockFigma, TREE_FIXTURES_DIR, loadTreeFixture, measureFromTrees, treeFixtureNames } from "./mock-figma.js";
import type { NodeView, TreeFixture } from "./mock-figma.js";
import { SHADCN_TOKENS } from "./shadcn-tokens.js";
import { parseReadResult } from "../figma-results.js";
import { stylesJsonText } from "../snap-tree.js";
import { expandTree } from "../tree-types.js";
import type { FigmaPlan, TreeDelta, TreeNode } from "../tree-types.js";
import type { SnapResult } from "../snap.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

interface CliRun { status: number; stdout: string; stderr: string }

function cli(args: string[]): Promise<CliRun> {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const status = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      done({ status, stdout, stderr });
    });
  });
}

/** The JSON a CLI command printed under --json: its last line. */
function jsonOf(run: CliRun): Record<string, unknown> {
  const line = run.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`no JSON from the CLI (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
  }
}

// --- upload_assets' URLs ----------------------------------------------------

// The URLs upload_assets hands out, served here: a POST to /<node id> puts
// its bytes on that layer of the mock in use, as Figma's upload does.
let server: Server;
let uploadBase = "";
let mockInUse: MockFigma | null = null;
const posted: { nodeId: string; type: string; bytes: number }[] = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const nodeId = decodeURIComponent((req.url ?? "/").slice(1));
      try {
        const bytes = new Uint8Array(Buffer.concat(chunks));
        mockInUse!.uploadAssets([nodeId], [bytes]);
        posted.push({ nodeId, type: String(req.headers["content-type"]), bytes: bytes.length });
        res.writeHead(200).end();
      } catch (err) {
        res.writeHead(400).end(String(err));
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  uploadBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((done) => server.close(() => done())));

// --- A push -----------------------------------------------------------------

/** A fixture as snap writes one: no `fixture` block, written by snap's own writer. */
function asSnap(fixture: TreeFixture): SnapResult {
  const { fixture: _drop, ...snap } = JSON.parse(JSON.stringify(fixture)) as TreeFixture;
  return snap as unknown as SnapResult;
}

type TreeComponent = TreeFixture["components"][number];

/** Every measured variant's nodes, so the mock's text measures the widths the browser drew. */
function treesOf(snap: SnapResult): TreeNode[][] {
  return (snap.components as TreeComponent[]).flatMap((c) => c.variants
    .filter((v) => v.status === "ok")
    .map((v) => expandTree(c.tree, (v as { treeDelta?: TreeDelta }).treeDelta)));
}

interface Push {
  dir: string;
  snapPath: string;
  planPath: string;
  plan: FigmaPlan;
  mock: MockFigma;
  /** Each read call's results, continuations included, by seq. */
  reads: Map<number, string[]>;
}

/**
 * Takes a snap through the push as the skill has the agent run it: tokens
 * saved, `figma code`, then every call in seq order, sent unchanged and its
 * response saved unchanged, with upload_assets and `figma upload` after a
 * build that lists uploads, and `figma next` after a read with `more`.
 * `edit` changes each call file before it is sent, standing in for a plan
 * whose read predictions ran low.
 */
async function push(snap: SnapResult, { codeArgs = [], edit }: { codeArgs?: string[]; edit?: (code: string, kind: string) => string } = {}): Promise<Push> {
  const dir = mkdtempSync(join(tmpdir(), "storysync-tree-e2e-"));
  const snapPath = join(dir, "snaps", "styles.json");
  mkdirSync(dirname(snapPath), { recursive: true });
  writeFileSync(snapPath, stylesJsonText(snap as Parameters<typeof stylesJsonText>[0]));
  // meta.json as snap writes it, a minute before the push reads anything.
  writeFileSync(join(dir, "snaps", "meta.json"), JSON.stringify({
    version: 1, measuredAt: new Date(Date.now() - 60_000).toISOString(), storysyncVersion: "0.4.0",
    storybookUrl: "http://localhost:6006", variantSelection: "all", components: snap.components.length,
    variants: snap.components.reduce((n, c) => n + c.variants.length, 0),
  }));
  // The thumbnails beside styles.json, where snap saves them.
  for (const c of snap.components as TreeComponent[]) {
    for (const asset of Object.values(c.tree?.assets.img ?? {})) {
      const to = join(dirname(snapPath), asset.file);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(TREE_FIXTURES_DIR, asset.file), to);
    }
  }
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(SHADCN_TOKENS));

  const out = join(dir, "figma");
  const code = await cli(["figma", "code", "--snap", snapPath, "--tokens", join(dir, "tokens.json"), "--out", out, "--json", ...codeArgs]);
  assert.equal(code.status, 0, `figma code exited ${code.status}\n${code.stdout}${code.stderr}`);
  const { planPath } = jsonOf(code) as { planPath: string };
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as FigmaPlan;

  const mock = new MockFigma({ measure: measureFromTrees(treesOf(snap)), moveNeedsFonts: true });
  for (const t of SHADCN_TOKENS.collections[0].tokens as { name: string; hex: string }[]) mock.addVariable(t.name, "COLOR", t.hex);
  for (const t of SHADCN_TOKENS.collections[1].tokens as { name: string; px: number }[]) mock.addVariable(t.name, "FLOAT", t.px, "Radius");
  mockInUse = mock;

  const send = async (file: string, result: string, kind: string) => {
    const text = readFileSync(file, "utf8");
    const run = await mock.run(edit ? edit(text, kind) : text);
    assert.ok(run.ok, `${file} failed in Figma: ${run.text}`);
    mkdirSync(dirname(result), { recursive: true });
    writeFileSync(result, run.text);
    return run.value as Record<string, unknown>;
  };

  const reads = new Map<number, string[]>();
  for (const call of plan.calls) {
    assert.ok(call.chars <= 45_000, `call ${call.seq} is ${call.chars} characters`);
    const value = await send(join(out, call.file), join(out, call.result), call.kind);
    if (call.kind === "build" && Array.isArray(value.uploads) && value.uploads.length) {
      // upload_assets, called with the build's node ids in order, its response saved unchanged.
      const uploads = value.uploads as [string, string][];
      writeFileSync(join(out, call.result.replace(/\.json$/, ".upload.json")), JSON.stringify({
        uploads: uploads.map(([nodeId]) => ({ submitUrl: `${uploadBase}/${encodeURIComponent(nodeId)}`, targetNodeId: nodeId })),
      }));
      const up = await cli(["figma", "upload", "--plan", planPath, "--seq", String(call.seq), "--json"]);
      assert.equal(up.status, 0, `figma upload exited ${up.status}\n${up.stdout}${up.stderr}`);
      assert.equal((jsonOf(up).uploaded as unknown[]).length, uploads.length);
    }
    if (call.kind === "read") {
      const results = [call.result];
      for (;;) {
        const next = await cli(["figma", "next", "--plan", planPath, "--seq", String(call.seq), "--json"]);
        assert.equal(next.status, 0, `figma next exited ${next.status}\n${next.stdout}${next.stderr}`);
        const more = jsonOf(next).next as { file: string; result: string } | null;
        if (!more) break;
        await send(more.file, more.result, "read");
        results.push(more.result);
      }
      reads.set(call.seq, results);
    }
  }
  return { dir, snapPath, planPath, plan, mock, reads };
}

/**
 * Sends a push's read calls again, as the skill has the agent do after a
 * change in Figma: each read call, then what `figma next` asks for after
 * it, until it says there is nothing left. `continued: false` stops at the
 * read calls, as an agent that skipped `figma next` would. Returns the
 * continuations `figma next` asked for again, by result path.
 */
async function readAgain(p: Push, { edit, continued = true }: { edit?: (code: string, kind: string) => string; continued?: boolean } = {}): Promise<string[]> {
  const out = dirname(p.planPath);
  const send = async (file: string, result: string) => {
    const text = readFileSync(file, "utf8");
    const run = await p.mock.run(edit ? edit(text, "read") : text);
    assert.ok(run.ok, run.text);
    writeFileSync(result, run.text);
  };
  const again: string[] = [];
  for (const call of p.plan.calls.filter((c) => c.kind === "read")) {
    await send(join(out, call.file), join(out, call.result));
    while (continued) {
      const next = await cli(["figma", "next", "--plan", p.planPath, "--seq", String(call.seq), "--json"]);
      assert.equal(next.status, 0, `figma next exited ${next.status}\n${next.stdout}${next.stderr}`);
      const more = jsonOf(next).next as { file: string; result: string; again?: true } | null;
      if (!more) break;
      if (more.again) again.push(more.result);
      await send(more.file, more.result);
    }
  }
  return again;
}

async function verifyPlan(p: Push, ...flags: string[]): Promise<{ status: number; json: Record<string, unknown>; text: CliRun }> {
  const json = await cli(["verify", "--plan", p.planPath, "--json", ...flags]);
  const text = await cli(["verify", "--plan", p.planPath, ...flags]);
  assert.equal(json.status, text.status, "verify exits the same with and without --json");
  return { status: json.status, json: jsonOf(json), text };
}

type Elements = { measured: number; verified: number; drifted: number; missing: number; extra: number; designerLayers: number; notReadBack: number };

function elementsOf(json: Record<string, unknown>): Elements {
  return (json.summary as { elements: Elements }).elements;
}

/** A keyed layer of a variant in the mock, by the variant's slug and the node's key. */
function layerOf(mock: MockFigma, slug: string, key: string): NodeView {
  const variant = mock.nodes("COMPONENT").find((v) => v.data["storysync.slug"] === slug);
  assert.ok(variant, `no variant ${slug} in Figma`);
  const walk = (view: NodeView): NodeView | null => {
    if (view.data["storysync.k"] === key) return view;
    for (const child of view.children ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const found = key === "" ? variant : (variant.children ?? []).map(walk).find(Boolean);
  assert.ok(found, `no layer ${key} in ${slug}`);
  return found;
}

/** Runs plugin code in the mock between calls, as a person editing the file would. */
async function editInFigma(mock: MockFigma, code: string): Promise<void> {
  const run = await mock.run(`${code}\nreturn { kind: "edit" };`);
  assert.ok(run.ok, run.text);
}

const cleanup = (p: Push) => rmSync(p.dir, { recursive: true, force: true });

// --- Every fixture at 100% --------------------------------------------------

for (const name of treeFixtureNames()) {
  test(`tree e2e: ${name} is built, read back and verified at 100% of its elements, and passes --strict`, async () => {
    const p = await push(asSnap(loadTreeFixture(name)));
    try {
      const { status, json, text } = await verifyPlan(p, "--strict");
      const e = elementsOf(json);
      assert.equal(status, 0, `verify --strict exited ${status}\n${text.stdout}${text.stderr}`);
      assert.equal(json.elementFidelity, 1);
      assert.equal(json.fidelity, 1);
      assert.ok(e.measured > 0);
      assert.deepEqual([e.verified, e.drifted, e.missing, e.extra, e.designerLayers, e.notReadBack], [e.measured, 0, 0, 0, 0, 0]);
      assert.deepEqual(json.readbackIssues, []);
      assert.deepEqual(json.plan, { path: p.planPath, readback: join(p.dir, "figma-readback.json"), problems: [] });
      assert.match(text.stdout, /Fidelity: 100\.0% of elements/);
      // The readback was assembled beside the plan's directory, for committing.
      assert.ok(existsSync(join(p.dir, "figma-readback.json")));
    } finally {
      cleanup(p);
    }
  });
}

test("tree e2e: every fixture in one push packs several components a call, and all of it verifies under --strict", async () => {
  const all = treeFixtureNames().map((n) => asSnap(loadTreeFixture(n)));
  const snap = { ...all[0], components: all.flatMap((s) => s.components) } as SnapResult;
  const p = await push(snap);
  try {
    const builds = p.plan.calls.filter((c) => c.kind === "build");
    assert.ok(builds.some((c) => c.components.length > 1), "no build call packed two components");
    const { status, json, text } = await verifyPlan(p, "--strict", "--min-fidelity", "100");
    assert.equal(status, 0, `${text.stdout}${text.stderr}`);
    const e = elementsOf(json);
    assert.equal(json.elementFidelity, 1);
    assert.equal(e.verified, e.measured);
    assert.equal(e.measured, 190);
  } finally {
    cleanup(p);
  }
});

test("tree e2e: a read that stops at its LIMIT is continued with figma next, and the parts verify as one", async () => {
  // A low prediction, as a read call whose responses ran long: the template
  // stops at LIMIT and returns `more`, and figma next writes the rest.
  const squeeze = (code: string, kind: string) => (kind === "read" ? code.replace(/\nconst LIMIT = \d+;\n/, "\nconst LIMIT = 2500;\n") : code);
  const p = await push(asSnap(loadTreeFixture("card")), { edit: squeeze });
  try {
    const continued = [...p.reads.values()].flat().filter((r) => /\d+[b-z]\.json$/.test(r));
    assert.ok(continued.length > 0, "no read was continued");
    const { status, json, text } = await verifyPlan(p, "--strict");
    assert.equal(status, 0, `${text.stdout}${text.stderr}`);
    assert.equal(json.elementFidelity, 1);
    assert.equal(elementsOf(json).measured, 46);
  } finally {
    cleanup(p);
  }
});

test("tree e2e: a read call sent again after a change in Figma has its continuations asked for again, so the change is read", async () => {
  const squeeze = (code: string, kind: string) => (kind === "read" ? code.replace(/\nconst LIMIT = \d+;\n/, "\nconst LIMIT = 2500;\n") : code);
  const p = await push(asSnap(loadTreeFixture("card")), { edit: squeeze });
  try {
    const out = dirname(p.planPath);
    const [seq, results] = [...p.reads].find(([, r]) => r.length > 1)!;
    // A text only the call's last continuation read, changed by a designer.
    const last = parseReadResult(readFileSync(resolve(out, results[results.length - 1]), "utf8"))!;
    const text = Object.values(last.sets[0].entries).flatMap((e) => (e as { tree?: unknown[][] }).tree ?? []).find((r) => r[1] === "T")!;
    const [key, id] = [text[0] as string, text[text.length - 1] as string];
    await editInFigma(p.mock, `const t = await figma.getNodeByIdAsync(${JSON.stringify(id)}); await figma.loadFontAsync(t.fontName); t.characters = "Changed by a designer";`);

    // The read call alone sent again: its continuations are from before.
    await readAgain(p, { edit: squeeze, continued: false });
    const stale = await verifyPlan(p, "--strict-age");
    assert.equal(stale.status, 1, "a continuation from before the change was scored as Figma now");
    assert.deepEqual(stale.json.notRead, [seq]);
    assert.match((stale.json.plan as { problems: string[] }).problems.join("\n"), new RegExp(`call ${seq}: \\S+b\\.json was read before results/${String(seq).padStart(2, "0")}\\.json, which it continues`));

    // As the skill says: figma next after the read call, until nothing is left.
    const again = await readAgain(p, { edit: squeeze });
    assert.deepEqual(again.map((r) => basename(r)), results.slice(1).map((r) => basename(r)), "figma next didn't ask for each continuation again");
    const now = await verifyPlan(p, "--strict-age");
    assert.equal(now.status, 1);
    assert.deepEqual(now.json.notRead, []);
    const drift = (now.json.variants as { nodes?: { key: string; status: string; differences: { property: string }[] }[] }[])
      .flatMap((v) => v.nodes ?? []).map((n) => [n.key, n.status, n.differences.map((d) => d.property)]);
    assert.deepEqual(drift.map(([k, status, properties]) => [k, status, (properties as string[]).includes("chars")]), [[key, "drifted", true]]);
    assert.match(now.text.stdout, /chars measured .*, Figma Changed by a designer/);
  } finally {
    cleanup(p);
  }
});

test("tree e2e: figma next says when a read has nothing left, and refuses a call that isn't a read", async () => {
  const p = await push(asSnap(loadTreeFixture("switch")));
  try {
    const read = p.plan.calls.find((c) => c.kind === "read")!;
    const build = p.plan.calls.find((c) => c.kind === "build")!;
    const done = await cli(["figma", "next", "--plan", p.planPath, "--seq", String(read.seq)]);
    assert.equal(done.status, 0);
    assert.match(done.stdout, /nothing left to continue/);
    const refused = await cli(["figma", "next", "--plan", p.planPath, "--seq", String(build.seq)]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /only a read call continues/);
  } finally {
    cleanup(p);
  }
});

// --- verify's flags -----------------------------------------------------------

test("verify --plan: a read call with no result saved is named, unscored, and fails --strict alone", async () => {
  const p = await push(asSnap(loadTreeFixture("toggle")));
  try {
    const read = p.plan.calls.find((c) => c.kind === "read")!;
    unlinkSync(join(dirname(p.planPath), read.result));
    const loose = await verifyPlan(p);
    assert.equal(loose.status, 0, "without --strict a missing result is reported, not failed");
    assert.deepEqual(loose.json.notRead, [read.seq]);
    assert.match((loose.json.plan as { problems: string[] }).problems.join("\n"), new RegExp(`call ${read.seq}: no result saved`));
    assert.match(loose.text.stdout, new RegExp(`call ${read.seq}: no result saved`));
    const strict = await verifyPlan(p, "--strict");
    assert.equal(strict.status, 1);
  } finally {
    cleanup(p);
  }
});

test("verify --plan: writes the readback where --readback says, and scores the snap the plan names unless --snap does", async () => {
  const p = await push(asSnap(loadTreeFixture("switch")));
  try {
    const where = join(p.dir, "elsewhere", "readback.json");
    const run = await cli(["verify", "--plan", p.planPath, "--readback", where, "--strict", "--json"]);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.ok(existsSync(where));
    assert.ok(!existsSync(join(p.dir, "figma-readback.json")), "wrote the default readback as well as --readback");
    // The assembled file scores the same through --readback, as CI reads it.
    const again = await cli(["verify", "--snap", p.snapPath, "--readback", where, "--strict", "--json"]);
    assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
    assert.equal(jsonOf(again).elementFidelity, 1);
    // A --snap that isn't the plan's is the one scored, and said to differ.
    const other = join(p.dir, "other.json");
    writeFileSync(other, readFileSync(p.snapPath, "utf8").replace(/\n$/, "\n\n"));
    copyFileSync(join(p.dir, "snaps", "meta.json"), join(p.dir, "meta.json"));
    const changed = await cli(["verify", "--plan", p.planPath, "--snap", other]);
    assert.equal(changed.status, 0, `${changed.stdout}${changed.stderr}`);
    assert.match(changed.stdout, /has changed since `storysync figma code` made this plan from it/);
    assert.equal((jsonOf(await cli(["verify", "--plan", p.planPath, "--snap", other, "--json"])).plan as { snapChanged?: boolean }).snapChanged, true);
  } finally {
    cleanup(p);
  }
});

test("verify --min-fidelity: holds the element score to a percentage, with or without --strict, and fails a run that scored nothing", async () => {
  const p = await push(asSnap(loadTreeFixture("card")));
  try {
    assert.equal((await verifyPlan(p, "--min-fidelity", "100")).status, 0);
    // A title deleted in Figma by hand: one element of 46 missing in one variant.
    const slug = loadTreeFixture("card").components[0].variants[0].slug;
    const title = layerOf(p.mock, slug, "card-header/card-title");
    await editInFigma(p.mock, `(await figma.getNodeByIdAsync(${JSON.stringify(title.id)})).remove();`);
    await readAgain(p);
    const below = await verifyPlan(p, "--min-fidelity", "99");
    assert.equal(below.status, 1, "an element score under the minimum passed");
    assert.ok((below.json.elementFidelity as number) < 0.99 && (below.json.elementFidelity as number) > 0.9);
    assert.match(below.text.stdout, /The score, element fidelity, is [\d.]+%: below --min-fidelity 99%/);
    assert.equal((await verifyPlan(p, "--min-fidelity", "90%")).status, 0);
    // With every component skipped nothing is scored, which is no pass.
    const none = await cli(["verify", "--plan", p.planPath, "--skip", "ui-base-card", "--min-fidelity", "0"]);
    assert.equal(none.status, 1, `${none.stdout}${none.stderr}`);
    assert.match(none.stdout, /Nothing was scored/);
    const bad = await cli(["verify", "--plan", p.planPath, "--min-fidelity", "high"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--min-fidelity must be a percentage/);
  } finally {
    cleanup(p);
  }
});

test("verify --allow-designer-layers: a layer a designer added inside a variant is listed, fails --strict, and passes with the flag", async () => {
  const p = await push(asSnap(loadTreeFixture("toggle")));
  try {
    const slug = loadTreeFixture("toggle").components[0].variants[0].slug;
    const variant = layerOf(p.mock, slug, "");
    await editInFigma(p.mock, `const v = await figma.getNodeByIdAsync(${JSON.stringify(variant.id)}); const r = figma.createRectangle(); r.name = "Sticker"; v.appendChild(r); r.layoutPositioning = "ABSOLUTE"; r.resize(4, 4);`);
    await readAgain(p);
    const strict = await verifyPlan(p, "--strict");
    assert.equal(strict.status, 1);
    assert.equal(elementsOf(strict.json).designerLayers, 1);
    assert.match(strict.text.stdout, /"Sticker" \(RECTANGLE, node [^)]+\): a designer's, not scored/);
    const allowed = await verifyPlan(p, "--strict", "--allow-designer-layers");
    assert.equal(allowed.status, 0, `${allowed.text.stdout}${allowed.text.stderr}`);
    assert.equal(allowed.json.elementFidelity, 1);
  } finally {
    cleanup(p);
  }
});

test("verify --roots-only: scores each variant's outer element alone, as 0.4.0 did, beside the element score", async () => {
  const p = await push(asSnap(loadTreeFixture("attachment")));
  try {
    const roots = await verifyPlan(p, "--roots-only", "--strict");
    assert.equal(roots.status, 0, `${roots.text.stdout}${roots.text.stderr}`);
    assert.equal(roots.json.elementFidelity, undefined);
    assert.equal(roots.json.fidelity, 1);
    assert.ok((roots.json.caveats as { kind: string }[]).some((c) => c.kind === "root-only"));
    assert.match(roots.text.stdout, /Only the outer element was measured and compared/);
    const full = await verifyPlan(p);
    assert.ok((full.json.summary as { propertiesCompared: number }).propertiesCompared > (roots.json.summary as { propertiesCompared: number }).propertiesCompared);
  } finally {
    cleanup(p);
  }
});

// --- figma code and upload ----------------------------------------------------

test("figma code: prints the calls it planned and where, and refuses a snap without element trees, naming --root-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-tree-e2e-"));
  try {
    const snap = asSnap(loadTreeFixture("switch"));
    const snapPath = join(dir, "styles.json");
    writeFileSync(snapPath, stylesJsonText(snap as Parameters<typeof stylesJsonText>[0]));
    const run = await cli(["figma", "code", "--snap", snapPath, "--tokens", join(dir, "none.json"), "--out", join(dir, "figma")]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\d+ use_figma calls \(\d+ build, 1 label, \d+ read\), planned in /);
    assert.match(run.stdout, /no tokens at .*none\.json, so nothing is bound/);
    const plan = JSON.parse(readFileSync(join(dir, "figma", "plan.json"), "utf8")) as FigmaPlan;
    for (const call of plan.calls) assert.ok(run.stdout.includes(call.description), `the output doesn't list call ${call.seq}`);
    // Two runs write the same files.
    const first = readFileSync(join(dir, "figma", plan.calls[0].file), "utf8");
    await cli(["figma", "code", "--snap", snapPath, "--tokens", join(dir, "none.json"), "--out", join(dir, "figma")]);
    assert.equal(readFileSync(join(dir, "figma", plan.calls[0].file), "utf8"), first);

    // A root-only snap: the same components with no trees.
    const roots = JSON.parse(JSON.stringify(snap)) as SnapResult & { components: { tree?: unknown; variants: { treeDelta?: unknown }[] }[] };
    for (const c of roots.components) {
      delete c.tree;
      for (const v of c.variants) delete v.treeDelta;
    }
    writeFileSync(snapPath, JSON.stringify(roots));
    const refused = await cli(["figma", "code", "--snap", snapPath, "--out", join(dir, "figma"), "--json"]);
    assert.equal(refused.status, 1);
    assert.match(String(jsonOf(refused).error), /no element tree for .*--root-only/);
    const over = await cli(["figma", "code", "--snap", snapPath, "--max-chars", "0"]);
    assert.equal(over.status, 1);
    assert.match(over.stderr, /--max-chars must be a positive whole number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figma upload: posts each thumbnail as its own type, and says what is missing before posting anything", async () => {
  const before = posted.length;
  const p = await push(asSnap(loadTreeFixture("avatar")));
  try {
    const uploads = posted.slice(before);
    assert.ok(uploads.length > 0, "the avatar's photo was never uploaded");
    assert.ok(uploads.every((u) => u.type === "image/jpeg" && u.bytes > 0), JSON.stringify(uploads));
    const build = p.plan.calls.find((c) => c.kind === "build")!;
    unlinkSync(join(dirname(p.planPath), build.result.replace(/\.json$/, ".upload.json")));
    const missing = await cli(["figma", "upload", "--plan", p.planPath, "--seq", String(build.seq)]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /upload\.json is missing: call upload_assets/);
    assert.equal(posted.length, before + uploads.length, "posted with no upload_assets response");
  } finally {
    cleanup(p);
  }
});
