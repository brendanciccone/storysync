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
import { MockFigma, TREE_FIXTURES_DIR, figmaFonts, loadTreeFixture, measureFromTrees, treeFixtureNames } from "./mock-figma.js";
import type { NodeView, TreeFixture } from "./mock-figma.js";
import { SHADCN_TOKENS } from "./shadcn-tokens.js";
import { drawnInSet, withConstant } from "./figma-build-harness.js";
import { parseReadResult } from "../figma-results.js";
import { stylesJsonText } from "../snap-tree.js";
import { expandTree } from "../tree-types.js";
import type { FigmaPlan, TreeDelta, TreeNode } from "../tree-types.js";
import type { SnapResult } from "../snap.js";
import { describeClimbed, describeIdenticalValues, describeMeasurementNotes } from "../snap.js";
import { describeArgRejections } from "../snap-args.js";

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
async function push(
  snap: SnapResult,
  { codeArgs = [], edit, fonts = "figma" }: { codeArgs?: string[]; edit?: (code: string, kind: string) => string; fonts?: "figma" | "browser" } = {},
): Promise<Push> {
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

  // Text as wide as Figma sets it in its own fonts, Inter for the system-ui
  // the fixtures were measured in (figmaFonts), or as wide as the browser
  // drew it.
  const browser = measureFromTrees(treesOf(snap));
  const mock = new MockFigma({ measure: fonts === "figma" ? figmaFonts(browser) : browser, moveNeedsFonts: true });
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

/**
 * The texts a push's build responses name `cut short`, by component and
 * key, with the variants each was in: a text that fills its row, which
 * Figma's font sets wider than the box the browser drew it whole in, so
 * its truncation cuts it short there. The fixtures were measured in
 * system-ui, which Figma sets in a wider Inter, as a snap from before the
 * stand-ins (fonts.ts) was.
 */
function cutShortNamed(p: Push): Record<string, number> {
  const out: Record<string, number> = {};
  for (const call of p.plan.calls.filter((c) => c.kind === "build")) {
    const result = JSON.parse(readFileSync(join(dirname(p.planPath), call.result), "utf8")) as { fallbacks: [string, string, string, number][] };
    for (const [component, key, what, variants] of result.fallbacks) {
      if (what.startsWith("cut short")) out[`${component} ${key}`] = (out[`${component} ${key}`] ?? 0) + variants;
    }
  }
  return out;
}

/**
 * What verify drifted, the same way: each a text Figma cuts short where the
 * browser drew it whole, on its truncation alone, by component and key;
 * anything else by its variant and key, so it shows.
 */
function cutShortDrifted(json: Record<string, unknown>): Record<string, number> {
  type Found = { component: string; slug: string; nodes?: { key: string; status: string; differences: { property: string; measured: { cut?: boolean }; figma: { cut?: boolean } }[] }[] };
  const out: Record<string, number> = {};
  for (const v of json.variants as Found[]) {
    for (const n of v.nodes ?? []) {
      const [d] = n.differences;
      const cut = n.status === "drifted" && n.differences.length === 1 && d.property === "truncation" && d.measured.cut === false && d.figma.cut === true;
      const at = cut ? `${v.component} ${n.key}` : `not a cut text: ${v.slug} ${n.key} ${n.status}`;
      out[at] = (out[at] ?? 0) + 1;
    }
  }
  return out;
}

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

// --- Every fixture at 100%, but what Figma cuts short -------------------------

for (const name of treeFixtureNames()) {
  test(`tree e2e: ${name} is built, read back and verified at 100% of its elements but the texts the build says Figma cuts short, and passes --strict without them`, async () => {
    const p = await push(asSnap(loadTreeFixture(name)));
    try {
      const { status, json, text } = await verifyPlan(p, "--strict");
      const e = elementsOf(json);
      // What the build named, verify now scores: Figma cutting a title the
      // browser drew whole is drift, as the fourth live push's was, where
      // verify once saw only matching truncation.
      const cut = cutShortNamed(p);
      assert.deepEqual(cutShortDrifted(json), cut, text.stdout);
      assert.equal(sum(cut) > 0, name === "attachment", "the fixture with a title that fills its row");
      assert.equal(status, sum(cut) ? 1 : 0, `verify --strict exited ${status}\n${text.stdout}${text.stderr}`);
      if (!sum(cut)) {
        assert.equal(json.elementFidelity, 1);
        assert.equal(json.fidelity, 1);
        assert.match(text.stdout, /Fidelity: 100\.0% of elements/);
      }
      assert.ok(e.measured > 0);
      assert.deepEqual([e.verified, e.drifted, e.missing, e.extra, e.designerLayers, e.notReadBack], [e.measured - sum(cut), sum(cut), 0, 0, 0, 0]);
      assert.deepEqual(json.readbackIssues, []);
      assert.deepEqual(json.plan, { path: p.planPath, readback: join(p.dir, "figma-readback.json"), problems: [] });
      // The readback was assembled beside the plan's directory, for committing.
      assert.ok(existsSync(join(p.dir, "figma-readback.json")));
    } finally {
      cleanup(p);
    }
  });
}

/**
 * A live snap's base Button (its with-icon story) at its default and icon
 * sizes, whose label draws far past the icon buttons, and its Sidebar at
 * side left and right, the floating ones with shadows: what the third live
 * push laid over each other, and, for side=right, built off to the side.
 */
const LAYOUT_FIXTURE = fileURLToPath(new URL("../../../cli/__tests__/fixtures/layout/drawn.json", import.meta.url));

test("tree e2e: variants that draw past their boxes are laid out apart, each where it draws, and verify at 100%", async () => {
  const p = await push(JSON.parse(readFileSync(LAYOUT_FIXTURE, "utf8")) as SnapResult);
  try {
    const { status, json, text } = await verifyPlan(p, "--strict");
    assert.equal(status, 0, `${text.stdout}${text.stderr}`);
    assert.equal(json.elementFidelity, 1);
    const sets = p.mock.nodes("COMPONENT_SET");
    assert.deepEqual(sets.map((s) => [s.name, s.children!.length]), [["Button", 8], ["Sidebar", 4]]);
    for (const set of sets) {
      const drawn = set.children!.map((v) => ({ name: v.name, box: drawnInSet(p.mock, v), own: [v.x, v.y, v.x + v.width, v.y + v.height] }));
      for (const [i, a] of drawn.entries()) {
        assert.ok(a.box[0] >= 0 && a.box[1] >= 0 && a.box[2] <= set.width && a.box[3] <= set.height, `${set.name} ${a.name} draws past the set`);
        for (const b of drawn.slice(i + 1)) {
          assert.ok(a.box[2] <= b.box[0] || b.box[2] <= a.box[0] || a.box[3] <= b.box[1] || b.box[3] <= a.box[1], `${set.name}: ${a.name} draws over ${b.name}`);
        }
        // An icon button's label draws far past it; anything else only by a shadow, a sidebar at either side included.
        const past = Math.max(a.own[0] - a.box[0], a.own[1] - a.box[1], a.box[2] - a.own[2], a.box[3] - a.own[3]);
        assert.ok(/size=icon/.test(a.name) ? past > 50 : past <= 4, `${a.name} draws ${past}px past its box`);
      }
    }
  } finally {
    cleanup(p);
  }
});

for (const fonts of ["figma", "browser"] as const) test(`tree e2e: every fixture in one push packs several components a call, and all of it verifies under --strict, with text as wide as ${fonts === "figma" ? "Figma sets it, but the titles it cuts short" : "the browser drew it"}`, async () => {
  const all = treeFixtureNames().map((n) => asSnap(loadTreeFixture(n)));
  const snap = { ...all[0], components: all.flatMap((s) => s.components) } as SnapResult;
  const p = await push(snap, { fonts });
  try {
    const builds = p.plan.calls.filter((c) => c.kind === "build");
    assert.ok(builds.some((c) => c.components.length > 1), "no build call packed two components");
    const { status, json, text } = await verifyPlan(p, "--strict", "--min-fidelity", "100");
    // In Figma's fonts, the titles the build names cut short drift, and nothing else.
    const cut = cutShortNamed(p);
    assert.deepEqual(cutShortDrifted(json), cut, text.stdout);
    assert.equal(sum(cut) > 0, fonts === "figma");
    assert.equal(status, sum(cut) ? 1 : 0, `${text.stdout}${text.stderr}`);
    const e = elementsOf(json);
    assert.equal(json.elementFidelity === 1, !sum(cut));
    assert.equal(e.verified, e.measured - sum(cut));
    assert.equal(e.measured, 247);
  } finally {
    cleanup(p);
  }
});

test("tree e2e: what snap warned is said beside the score, before the drift under it, and in --json, failing nothing", async () => {
  // A third live push's verify printed none of what its snap warned (values
  // that measured alike, values set through the preview) and its --json
  // had no caveat: the warnings were written for the element-tree snap and
  // verify had no kind for them. Each comes back here as snap writes it.
  const toggle = asSnap(loadTreeFixture("toggle"));
  const buttons = asSnap(loadTreeFixture("button-icon"));
  const [alike] = describeIdenticalValues([{ property: "size", values: ["sm", "lg"] }]);
  const climbed = describeClimbed([{ slug: "variant-default--size-sm", element: "div[data-slot=\"toggle\"]", from: "span" }], 6)!;
  toggle.components[0].warnings = [alike, climbed];
  const button = buttons.components[0];
  const link = button.variants.find((v) => v.slug === "variant-link--size-default")!;
  link.appliedVia = "preview";
  link.rejectedArgs = [{ name: "size", value: "default", reasons: ["hidden-by-if"], condition: { arg: "variant", neq: "link" } }];
  button.warnings = describeArgRejections(button.title!, button.variants, { storyFile: "./button.stories.tsx", id: button.id });
  assert.equal(button.warnings.length, 1);
  const p = await push({ ...toggle, components: [...toggle.components, button] } as SnapResult);
  try {
    // A drifted element, so the score has drift under it.
    const label = layerIn(p.mock, "ui-base-toggle", toggle.components[0].variants[0].slug, "");
    await editInFigma(p.mock, `(await figma.getNodeByIdAsync(${JSON.stringify(label.id)})).opacity = 0.5;`);
    await readAgain(p);
    const run = await verifyPlan(p);
    assert.equal(run.status, 0, `${run.text.stdout}${run.text.stderr}`);
    assert.deepEqual((run.json.caveats as { kind: string }[]).filter((c) => !["root-only"].includes(c.kind)), [
      { component: "ui/base/Toggle", kind: "identical-values", values: ["size=sm", "size=lg"] },
      { component: "ui/base/Toggle", kind: "snap-warning", warning: climbed },
      { component: "ui/base/Button", kind: "preview-set", values: ["size=default"], variants: 1 },
    ]);
    const lines = run.text.stdout.split("\n");
    const at = lines.findIndex((line) => line.startsWith("  ! The score compares Figma with what snap measured"));
    assert.ok(at > 0, run.text.stdout);
    assert.match(lines[at - 1], /^ {2}(missing \d+ ·|coverage )/, "right under the score's lines");
    assert.deepEqual(lines.slice(at + 1, at + 4), [
      "      ui/base/Toggle: `size=sm` and `size=lg` measured the same, so their variants in Figma look alike; if the code draws them differently, the story may not pass `size` through for them",
      `      ui/base/Toggle: ${climbed}`,
      "      ui/base/Button: the story's URL wouldn't take size=default, so snap set it through Storybook's preview and measured 1 variant as the component renders it; snap's warning names the story change that lets the URL take it",
    ]);
    assert.ok(lines.findIndex((line) => line.startsWith("  ~ ")) > at + 3, "before the drift");
    // And --strict fails on the drift alone.
    const strict = await verifyPlan(p, "--strict");
    assert.equal(strict.status, 1);
    assert.deepEqual(strict.json.caveats, run.json.caveats);
  } finally {
    cleanup(p);
  }
});

// --- Overlays snap opened before it measured them ------------------------------

/** The description a push's label call left on the set or plain component of `id`. */
function descriptionOf(mock: MockFigma, id: string): string {
  const built = [...mock.nodes("COMPONENT_SET"), ...mock.nodes("COMPONENT")].find((n) => n.data["storysync.id"] === id && !n.data["storysync.slug"])
    ?? mock.nodes("COMPONENT").find((n) => n.data["storysync.id"] === id);
  assert.ok(built, `no set or component for ${id}`);
  return String(mock.handle(built.id).description ?? "");
}

test("tree e2e: a Dialog snap clicked open is built from its open content, read back and verified by element, with nothing on its label, and verify says how it was opened", async () => {
  // The registry's Dialog story renders only its trigger: snap clicked it
  // open and measured the content in its portal (fixtures/tree/dialog.json).
  const dialog = asSnap(loadTreeFixture("dialog"));
  const [variant] = dialog.components[0].variants;
  assert.deepEqual([variant.element, variant.portal, variant.opened], [
    'div[data-slot="dialog-content"]', true, { via: "click", trigger: 'button[data-slot="dialog-trigger"]' },
  ]);
  assert.deepEqual(dialog.components[0].warnings, []);
  const p = await push(dialog);
  try {
    // The open dialog in Figma: its header, its footer's buttons and its close button.
    const built = p.mock.nodes("COMPONENT").find((n) => n.data["storysync.id"] === "ui-base-dialog")!;
    assert.deepEqual([built.name, built.width, built.height], ["Dialog", 448, 170]);
    for (const key of ["dialog-header/dialog-title", "dialog-footer/dialog-close", "dialog-footer/dialog-close:2/#text", "dialog-close/svg"]) {
      assert.ok(layerOf(p.mock, variant.slug, key), `${key} built`);
    }
    // Its content is the component: no storysync: line.
    assert.doesNotMatch(descriptionOf(p.mock, "ui-base-dialog"), /storysync:/);
    const { status, json, text } = await verifyPlan(p, "--strict");
    assert.equal(status, 0, `${text.stdout}${text.stderr}`);
    assert.equal(json.elementFidelity, 1);
    const e = elementsOf(json);
    assert.deepEqual([e.verified, e.drifted, e.missing], [e.measured, 0, 0]);
    assert.deepEqual((json.caveats as { kind: string }[]).filter((c) => c.kind === "opened"), [{
      component: "ui/base/Dialog", kind: "opened",
      note: 'measured open: snap clicked button[data-slot="dialog-trigger"] to open it, and measured div[data-slot="dialog-content"]',
    }]);
    assert.ok(text.stdout.includes('  i ui/base/Dialog: measured open: snap clicked button[data-slot="dialog-trigger"] to open it, and measured div[data-slot="dialog-content"]'), text.stdout);
    assert.doesNotMatch(text.stdout, /a closed trigger/);
  } finally {
    cleanup(p);
  }
});

test("tree e2e: a Tooltip snap hovered open keeps its arrow below the bubble, where the browser drew it, and verifies by element", async () => {
  // The registry's Tooltip story renders only its trigger: snap hovered
  // over it and measured the content in its portal (fixtures/tree/tooltip.json).
  const tooltip = asSnap(loadTreeFixture("tooltip"));
  const [variant] = tooltip.components[0].variants;
  assert.deepEqual([variant.element, variant.opened, variant.movedInside], [
    'div[data-slot="tooltip-content"]', { via: "hover", trigger: 'button[data-slot="tooltip-trigger"]' }, undefined,
  ]);
  const p = await push(tooltip);
  try {
    // The bubble hugs its label, which Figma sets a whole pixel wide.
    const bubble = layerOf(p.mock, variant.slug, "");
    assert.deepEqual([bubble.width, bubble.height], [101, 28]);
    // The arrow past the bubble's bottom, where Base UI's positioner placed it.
    const arrow = layerOf(p.mock, variant.slug, "div");
    assert.deepEqual([arrow.x, arrow.y, arrow.width, arrow.height], [45.5, 21, 10, 10]);
    assert.doesNotMatch(descriptionOf(p.mock, "ui-base-tooltip"), /storysync:/);
    const { status, json, text } = await verifyPlan(p, "--strict");
    assert.equal(status, 0, `${text.stdout}${text.stderr}`);
    assert.equal(json.elementFidelity, 1);
    const e = elementsOf(json);
    assert.deepEqual([e.verified, e.drifted, e.missing], [e.measured, 0, 0]);
    assert.ok(text.stdout.includes('  i ui/base/Tooltip: measured open: snap hovered over button[data-slot="tooltip-trigger"] to open it, and measured div[data-slot="tooltip-content"]'), text.stdout);
  } finally {
    cleanup(p);
  }
});

test("tree e2e: a Select snap clicked open is built from its listbox with no item hovered, and verifies by element", async () => {
  const select = asSnap(loadTreeFixture("select"));
  const [variant] = select.components[0].variants;
  assert.deepEqual([variant.element, variant.opened], ['div[data-slot="select-content"]', { via: "click", trigger: 'button[data-slot="select-trigger"]' }]);
  const nodes = expandTree(select.components[0].tree as never, undefined);
  // No item paints: the first isn't measured hovered and highlighted.
  const items = nodes.filter((n) => /select-item(:\d+)?$/.test(n.k));
  assert.equal(items.length, 14);
  assert.deepEqual(items.filter((n) => n.bg), []);
  const p = await push(select);
  try {
    assert.deepEqual((p.mock.handle(layerOf(p.mock, variant.slug, "div/select-group/select-item").id) as { fills: unknown[] }).fills, []);
    const { status, json, text } = await verifyPlan(p, "--strict");
    assert.equal(status, 0, `${text.stdout}${text.stderr}`);
    assert.equal(json.elementFidelity, 1);
    const e = elementsOf(json);
    assert.deepEqual([e.measured, e.verified, e.drifted, e.missing], [43, 43, 0, 0]);
  } finally {
    cleanup(p);
  }
});

test("tree e2e: a trigger snap couldn't open is built as measured, and its label and verify say why", async () => {
  const snap = asSnap(loadTreeFixture("switch"));
  const reason = "clicking it, hovering over it, focusing it and right-clicking it opened nothing within 3000ms each";
  snap.components[0].warnings = describeMeasurementNotes("Switch", [{ slug: "size-default", note: { kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]', reason } }], 2);
  const p = await push(snap);
  try {
    assert.match(descriptionOf(p.mock, "ui-base-switch"),
      new RegExp(`^storysync: measured from its closed trigger, button\\[data-slot=dialog-trigger\\], not the open Switch, as snap didn't open it \\(${reason}\\)$`, "m"));
    const { status, json, text } = await verifyPlan(p, "--strict");
    assert.equal(status, 0, `${text.stdout}${text.stderr}`);
    assert.deepEqual((json.caveats as { kind: string }[]).filter((c) => c.kind === "closed-trigger"), [
      { component: "ui/base/Switch", kind: "closed-trigger", element: 'button[data-slot="dialog-trigger"]', reason },
    ]);
    assert.ok(text.stdout.includes(`      ui/base/Switch: snap measured button[data-slot="dialog-trigger"], a closed trigger, so this scores the trigger, not what it opens; snap didn't open it: ${reason}`), text.stdout);
  } finally {
    cleanup(p);
  }
});

test("tree e2e: a read that stops at its LIMIT is continued with figma next, and the parts verify as one", async () => {
  // A low prediction, as a read call whose responses ran long: the template
  // stops at LIMIT and returns `more`, and figma next writes the rest.
  const squeeze = (code: string, kind: string) => (kind === "read" ? withConstant(code, "LIMIT", 2500) : code);
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
  const squeeze = (code: string, kind: string) => (kind === "read" ? withConstant(code, "LIMIT", 2500) : code);
  // At the browser's widths, so the changed text, which the line below it
  // stretches across, keeps that line within its width tolerance: drift on
  // the changed text alone.
  const p = await push(asSnap(loadTreeFixture("card")), { edit: squeeze, fonts: "browser" });
  try {
    const out = dirname(p.planPath);
    const [seq, results] = [...p.reads].find(([, r]) => r.length > 1)!;
    // A text only the call's last continuation read, changed by a designer.
    const last = parseReadResult(readFileSync(resolve(out, results[results.length - 1]), "utf8"))!;
    const text = Object.values(last.sets[0].entries).flatMap((e) => (e as { tree?: unknown[][] }).tree ?? []).find((r) => r[1] === "T")!;
    // A T record's node id, before its `cut`.
    const [key, id] = [text[0] as string, text[22] as string];
    await editInFigma(p.mock, `const t = await figma.getNodeByIdAsync(${JSON.stringify(id)}); await figma.loadFontAsync(t.fontName); t.characters = "Changed by a designer";`);

    // The read call alone sent again: its continuations are from before.
    await readAgain(p, { edit: squeeze, continued: false });
    const stale = await verifyPlan(p, "--strict-age");
    assert.equal(stale.status, 1, "a continuation from before the change was scored as Figma now");
    assert.deepEqual(stale.json.notRead, [seq]);
    // What only its stale continuations held is not read, and nothing is said to be missing from Figma.
    const staleSummary = stale.json.summary as { missingFromFigma: number; notRead: number };
    assert.equal(staleSummary.missingFromFigma, 0);
    assert.ok(staleSummary.notRead > 0, JSON.stringify(staleSummary));
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

// --- Falsification (design section 17) ------------------------------------------

/** A keyed layer of one component's variant in the mock: the set by its storysync id, then the variant by slug. */
function layerIn(mock: MockFigma, component: string, slug: string, key: string): NodeView {
  const owner = mock.nodes().find((n) => n.data["storysync.id"] === component);
  assert.ok(owner, `no set for ${component} in Figma`);
  const variant = owner.type === "COMPONENT" ? owner : (owner.children ?? []).find((v) => v.data["storysync.slug"] === slug);
  assert.ok(variant, `no variant ${slug} of ${component}`);
  if (key === "") return variant;
  const walk = (view: NodeView): NodeView | null => {
    if (view.data["storysync.k"] === key) return view;
    for (const child of view.children ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const found = (variant.children ?? []).map(walk).find(Boolean);
  assert.ok(found, `no layer ${key} in ${component} ${slug}`);
  return found;
}

/** What verify found, as `component slug key: status`, with a gate or the properties that differ. */
function findingsOf(json: Record<string, unknown>): string[] {
  type Found = { component: string; slug: string; nodes?: { key: string; status: string; gate?: string; figmaId?: string; differences: { property: string }[] }[] };
  return (json.variants as Found[]).flatMap((v) => (v.nodes ?? []).map((n) => `${v.component} ${v.slug} ${n.key}: ${n.status}${n.gate ? ` [${n.gate}]` : n.differences.length ? ` ${n.differences.map((d) => d.property).join(",")}` : ""}${n.figmaId ? " (id)" : ""}`)).sort();
}

test("tree e2e: each of the spec's hand edits is reported as exactly that element, and sending the build calls again undoes the rest", async () => {
  // Section 17's edits, but the move: a layer in auto layout can't move
  // without leaving the flow, which moves its neighbors and its parent's
  // size with it (SPEC-NOTES). Each must be exactly one finding, by key and
  // node id, and nothing else may change.
  const names = ["switch", "attachment", "card", "inputotp", "toggle"];
  const all = names.map((n) => asSnap(loadTreeFixture(n)));
  const snap = { ...all[0], components: all.flatMap((s) => s.components) } as SnapResult;
  const p = await push(snap);
  try {
    // Before any edit: Attachment's titles that Figma's font cuts short,
    // and nothing else (the fixtures were measured in system-ui).
    const base = await verifyPlan(p, "--strict");
    const cut = findingsOf(base.json);
    assert.deepEqual(cutShortDrifted(base.json), cutShortNamed(p));
    assert.equal(cut.length, 2, `${base.text.stdout}${base.text.stderr}`);
    const baseline = readFileSync(join(p.dir, "figma-readback.json"), "utf8");
    const attachment = (snap.components as TreeComponent[]).find((c) => c.id === "ui-base-attachment")!;
    const iconSlug = attachment.variants.find((v) => v.status === "ok" && expandTree(attachment.tree, (v as { treeDelta?: TreeDelta }).treeDelta).some((n) => n.k === "attachment-media/svg"))!.slug;
    const thumb = layerIn(p.mock, "ui-base-switch", "size-sm", "switch-thumb");
    const icon = layerIn(p.mock, "ui-base-attachment", iconSlug, "attachment-media/svg");
    const title = layerIn(p.mock, "ui-base-card", "size-default", "card-header/card-title");
    const slot = layerIn(p.mock, "ui-base-inputotp", "default", "input-otp-group/input-otp-slot:3");
    const toggle = layerIn(p.mock, "ui-base-toggle", loadTreeFixture("toggle").components[0].variants[0].slug, "");
    const titleText = (p.mock.handle(title.id) as { characters: string }).characters;
    await editInFigma(p.mock, `
      const g = (id) => figma.getNodeByIdAsync(id);
      (await g(${JSON.stringify(thumb.id)})).remove();
      for (const v of (await g(${JSON.stringify(icon.id)})).findAll(() => true)) {
        if (v.strokes && v.strokes.length) v.strokes = [{ type: "SOLID", color: { r: 1, g: 0, b: 1 } }];
        if (v.fills && v.fills.length) v.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 1 } }];
      }
      const t = await g(${JSON.stringify(title.id)}); await figma.loadFontAsync(t.fontName); t.characters = "Edited title";
      (await g(${JSON.stringify(slot.id)})).visible = false;
      const r = figma.createRectangle(); r.name = "Sticker"; (await g(${JSON.stringify(toggle.id)})).appendChild(r); r.layoutPositioning = "ABSOLUTE"; r.resize(4, 4);
    `);
    await readAgain(p);
    const edited = await verifyPlan(p, "--strict");
    assert.equal(edited.status, 1);
    assert.deepEqual(findingsOf(edited.json), [
      `ui/base/Attachment ${iconSlug} attachment-media/svg: drifted paint (id)`,
      ...cut,
      "ui/base/Card size-default card-header/card-title: drifted [chars] (id)",
      "ui/base/InputOTP default input-otp-group/input-otp-slot:3: drifted [visible] (id)",
      "ui/base/Switch size-sm switch-thumb: missing",
    ].sort());
    assert.equal(elementsOf(edited.json).designerLayers, 1);
    assert.match(edited.text.stdout, /"Sticker" \(RECTANGLE, node [^)]+\): a designer's, not scored/);

    // Undone: what can be by hand, and the rest by sending the build calls again, as the skill's repair does.
    await editInFigma(p.mock, `
      const g = (id) => figma.getNodeByIdAsync(id);
      const t = await g(${JSON.stringify(title.id)}); await figma.loadFontAsync(t.fontName); t.characters = ${JSON.stringify(titleText)};
      (await g(${JSON.stringify(slot.id)})).visible = true;
      for (const c of (await g(${JSON.stringify(toggle.id)})).children.filter((c) => c.name === "Sticker")) c.remove();
    `);
    const out = dirname(p.planPath);
    for (const call of p.plan.calls.filter((c) => c.kind === "build")) {
      const run = await p.mock.run(readFileSync(join(out, call.file), "utf8"));
      assert.ok(run.ok, run.text);
    }
    await readAgain(p);
    const undone = await verifyPlan(p, "--strict");
    assert.deepEqual(findingsOf(undone.json), cut, `${undone.text.stdout}${undone.text.stderr}`);
    // The readback is the baseline's, but for when it was read, its seals, and the two layers built again.
    const plain = (text: string) => JSON.stringify(JSON.parse(text), (k, v) => (k === "readAt" || k === "checksum" ? undefined : typeof v === "string" && /^\d+:\d+$/.test(v) ? "id" : v));
    assert.equal(plain(readFileSync(join(p.dir, "figma-readback.json"), "utf8")), plain(baseline));
  } finally {
    cleanup(p);
  }
});

// --- verify's flags -----------------------------------------------------------

test("verify --plan: a read call with no result saved is named, its variants not read rather than missing, and fails --strict alone", async () => {
  const p = await push(asSnap(loadTreeFixture("toggle")));
  try {
    const read = p.plan.calls.find((c) => c.kind === "read")!;
    unlinkSync(join(dirname(p.planPath), read.result));
    const loose = await verifyPlan(p);
    assert.equal(loose.status, 0, "without --strict a missing result is reported, not failed");
    assert.deepEqual(loose.json.notRead, [read.seq]);
    assert.match((loose.json.plan as { problems: string[] }).problems.join("\n"), new RegExp(`call ${read.seq}: no result saved`));
    assert.match(loose.text.stdout, new RegExp(`call ${read.seq}: no result saved`));
    // Nothing read them, so none is said to be missing from Figma, and none is scored.
    const variants = loadTreeFixture("toggle").components[0].variants.length;
    const summary = loose.json.summary as { missingFromFigma: number; notRead: number; elements: Elements };
    assert.deepEqual((loose.json.variants as { status: string }[]).map((v) => v.status), Array(variants).fill("not_read"));
    assert.deepEqual([summary.missingFromFigma, summary.notRead, summary.elements.measured, summary.elements.missing], [0, variants, 0, 0]);
    assert.equal(loose.json.elementFidelity, null);
    assert.doesNotMatch(loose.text.stdout, /not found in Figma/);
    assert.match(loose.text.stdout, new RegExp(`; ${variants} variants not read, not scored`));
    assert.match(loose.text.stdout, new RegExp(`planned read call ${read.seq} wasn't read whole`));
    const strict = await verifyPlan(p, "--strict");
    assert.equal(strict.status, 1);
  } finally {
    cleanup(p);
  }
});

test("verify --plan: a problem assembling the readback fails --strict on its own, with every element verified", async () => {
  const all = ["switch", "toggle"].map((n) => asSnap(loadTreeFixture(n)));
  const p = await push({ ...all[0], components: all.flatMap((s) => s.components) } as SnapResult, { codeArgs: ["--read-limit", "3000"] });
  try {
    const [first, second] = p.plan.calls.filter((c) => c.kind === "read");
    assert.ok(second, "the reads weren't split into two calls");
    // The second read's response saved with the first's sets in it too, as
    // they came: every entry is still sealed, and one is read twice.
    const out = dirname(p.planPath);
    const one = JSON.parse(readFileSync(join(out, first.result), "utf8")) as { sets: unknown[] };
    const two = JSON.parse(readFileSync(join(out, second.result), "utf8")) as { sets: unknown[] };
    writeFileSync(join(out, second.result), JSON.stringify({ ...two, sets: [...two.sets, ...one.sets] }));
    const loose = await verifyPlan(p);
    assert.equal(loose.status, 0, `${loose.text.stdout}${loose.text.stderr}`);
    assert.equal(loose.json.elementFidelity, 1);
    assert.deepEqual(loose.json.notRead, []);
    assert.match((loose.json.plan as { problems: string[] }).problems.join("\n"), /again; the first reading is kept/);
    const strict = await verifyPlan(p, "--strict");
    assert.equal(strict.status, 1, "a readback assembled with a problem passed --strict");
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
    const full = await verifyPlan(p, "--min-fidelity", "100");
    assert.equal(full.status, 0);
    assert.deepEqual(full.json.minFidelity, { min: 1, score: 1, passed: true });
    assert.equal((await verifyPlan(p)).json.minFidelity, undefined, "minFidelity without the flag");
    // A title deleted in Figma by hand: one element of 46 missing in one variant.
    const slug = loadTreeFixture("card").components[0].variants[0].slug;
    const title = layerOf(p.mock, slug, "card-header/card-title");
    await editInFigma(p.mock, `(await figma.getNodeByIdAsync(${JSON.stringify(title.id)})).remove();`);
    await readAgain(p);
    const below = await verifyPlan(p, "--min-fidelity", "99");
    assert.equal(below.status, 1, "an element score under the minimum passed");
    assert.ok((below.json.elementFidelity as number) < 0.99 && (below.json.elementFidelity as number) > 0.9);
    // Said in the JSON, so a CI reading it can tell this failure from a --strict one.
    assert.deepEqual(below.json.minFidelity, { min: 0.99, score: below.json.elementFidelity, passed: false });
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

test("figma code: prints each value the base styles bound, with the rule, and lists them under --json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-tree-e2e-"));
  try {
    const snapPath = join(dir, "styles.json");
    writeFileSync(snapPath, stylesJsonText(asSnap(loadTreeFixture("dialog")) as Parameters<typeof stylesJsonText>[0]));
    const from = "app/globals.css, @layer base: body { @apply bg-background text-foreground }";
    writeFileSync(join(dir, "tokens.json"), JSON.stringify({ ...SHADCN_TOKENS, defaults: [{ property: "color", token: "foreground", from }] }));
    const args = ["figma", "code", "--snap", snapPath, "--tokens", join(dir, "tokens.json"), "--out", join(dir, "figma")];
    const run = await cli(args);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(`  = ui/base/Dialog: color #0a0a0a bound to foreground, which no class names, by the base style ${from}\n`), run.stdout);
    assert.deepEqual(jsonOf(await cli([...args, "--json"])).bindings, [{ component: "ui/base/Dialog", property: "color", value: "#0a0a0a", variable: "foreground", from }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
