// Helpers for package B's tests: `figma code` over a snap in a temporary
// directory, its calls run in the mock Figma, and the built layers read
// back as the browser measures boxes, to set against snap's facts.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFigmaCode } from "../figma-code.js";
import type { FigmaCodeOptions } from "../figma-code.js";
import type { Box, FigmaPlan, PlanCall, TreeNode } from "../tree-types.js";
import { MockFigma, TREE_FIXTURES_DIR, fixtureVariants, measureFromTrees } from "./mock-figma.js";
import type { MockFigmaOptions, MockRun, NodeView, TreeFixture } from "./mock-figma.js";

export { SHADCN_TOKENS } from "./shadcn-tokens.js";

/**
 * A readback template standing in for package C's, which is not in this
 * package: it returns an empty read, so a plan's read calls run.
 */
export const STUB_READBACK = "return { kind: 'read', tpl: 2, page: PAGE, sets: [], slices: SLICES, limit: LIMIT };";

export interface Coded {
  dir: string;
  snapPath: string;
  out: string;
  plan: FigmaPlan;
  warnings: string[];
  code(call: PlanCall): string;
}

/**
 * Writes `snap` as styles.json in a new directory, with any image assets it
 * names and `tokens` as tokens.json, and runs figma code over it.
 */
export async function codeFor(snap: object, options: Partial<FigmaCodeOptions> = {}, tokens?: object): Promise<Coded> {
  const dir = mkdtempSync(join(tmpdir(), "storysync-figma-code-"));
  const snapPath = join(dir, "snaps", "styles.json");
  mkdirSync(dirname(snapPath), { recursive: true });
  writeFileSync(snapPath, JSON.stringify(snap, null, 2));
  for (const component of (snap as TreeFixture).components ?? []) {
    for (const asset of Object.values(component.tree?.assets.img ?? {})) {
      const to = join(dirname(snapPath), asset.file);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(TREE_FIXTURES_DIR, asset.file), to);
    }
  }
  if (tokens) writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens));
  const out = join(dir, "figma");
  const { plan, warnings } = await runFigmaCode({
    snap: snapPath, out, templates: { readback: STUB_READBACK }, ...(tokens ? { tokens: join(dir, "tokens.json") } : {}), ...options,
  });
  return { dir, snapPath, out, plan, warnings, code: (call) => readFileSync(join(out, call.file), "utf8") };
}

/** A mock that measures text as the fixture's browser did, at `factor` times its width. */
export function mockFor(fixtures: TreeFixture[], options: MockFigmaOptions = {}): MockFigma {
  const trees = fixtures.flatMap((f) => fixtureVariants(f).map((v) => v.nodes));
  return new MockFigma({ measure: measureFromTrees(trees), ...options });
}

/** Runs a plan's calls in order, `kinds` only when given; throws on a call that fails. */
export async function runPlan(mock: MockFigma, coded: Coded, kinds?: PlanCall["kind"][]): Promise<MockRun[]> {
  const runs: MockRun[] = [];
  for (const call of coded.plan.calls) {
    if (kinds && !kinds.includes(call.kind)) continue;
    const run = await mock.run(coded.code(call));
    if (!run.ok) throw new Error(`call ${call.seq} (${call.kind}) failed: ${run.text}`);
    runs.push(run);
  }
  return runs;
}

/** The variant components a mock holds, by slug: of the set with storysync id `component` only, when given. */
export function variantsBySlug(mock: MockFigma, component?: string): Map<string, NodeView> {
  const out = new Map<string, NodeView>();
  const walk = (n: NodeView, set: string) => {
    const slug = n.data["storysync.slug"];
    const id = n.data["storysync.id"] ?? set;
    if (n.type === "COMPONENT" && slug && (!component || id === component)) out.set(slug, n);
    for (const c of n.children ?? []) walk(c, id);
  };
  for (const page of mock.pages()) walk(page, "");
  return out;
}

/** A frame's strokes built OUTSIDE it, top, right, bottom, left. */
function outside(mock: MockFigma, id: string): [number, number, number, number] {
  const h = mock.handle(id) as Record<string, unknown>;
  if (!("strokeAlign" in h) || h.strokeAlign !== "OUTSIDE" || !(h.strokes as unknown[]).length) return [0, 0, 0, 0];
  return [h.strokeTopWeight, h.strokeRightWeight, h.strokeBottomWeight, h.strokeLeftWeight] as [number, number, number, number];
}

/**
 * Each keyed layer's border box relative to the variant root's, by key, the
 * root `""`: as the browser measures a box, a stroke built outside a frame
 * included in it, so it compares with absoluteBoxes of snap's facts.
 */
export function readBoxes(mock: MockFigma, variant: NodeView): Map<string, Box> {
  const out = new Map<string, Box>();
  const visit = (n: NodeView, origin: [number, number], key: string) => {
    const o = outside(mock, n.id);
    out.set(key, [origin[0] - o[3], origin[1] - o[0], n.width + o[1] + o[3], n.height + o[0] + o[2]]);
    if (n.data["storysync.svg"] && key !== "") return;
    for (const c of n.children ?? []) {
      const k = c.data["storysync.k"];
      if (k) visit(c, [origin[0] + c.x, origin[1] + c.y], k);
    }
  };
  const o = outside(mock, variant.id);
  visit(variant, [o[3], o[0]], "");
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Where a built variant differs from snap's facts beyond tolerance: a
 * missing layer, or a box off by more than 0.5px (1px for text). A frame's
 * size may differ by what its children's sizes differ by, as section 10.4
 * allows a container: so Figma's AUTO line height for a `normal` one, a
 * fraction off Chrome's, moves no score.
 */
export function boxDrift(mock: MockFigma, variant: NodeView, nodes: TreeNode[], factBoxes: Map<string, Box>): string[] {
  const got = readBoxes(mock, variant);
  const drift: string[] = [];
  for (const node of [...nodes].reverse()) {
    const fact = factBoxes.get(node.k)!;
    const box = got.get(node.k);
    if (!box) {
      drift.push(`${node.k || "(root)"}: missing`);
      continue;
    }
    const tol = node.t === "T" ? 1 : 0.5;
    const kids = nodes.filter((n) => n.k !== node.k && (node.k === "" ? !n.k.includes("/") && n.k !== "" : n.k.startsWith(`${node.k}/`) && !n.k.slice(node.k.length + 1).includes("/")));
    const allow = [0, 1].map((a) => kids.reduce((t, k) => t + Math.abs((got.get(k.k)?.[a + 2] ?? 0) - factBoxes.get(k.k)![a + 2]), 0));
    const bad = [0, 1].some((a) => Math.abs(box[a] - fact[a]) > tol) || [0, 1].some((a) => Math.abs(box[a + 2] - fact[a + 2]) > tol + allow[a]);
    if (bad) drift.push(`${node.k || "(root)"}: snap ${fact.join(",")}, Figma ${box.map(r2).join(",")}`);
  }
  return drift;
}
