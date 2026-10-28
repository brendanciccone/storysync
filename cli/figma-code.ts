// `storysync figma code`: every use_figma call a push makes, as files.
//
// The agent used to write the build and readback code itself, from snap's
// values and the skill's tables: about half a million characters per push,
// transcribed by hand, where one slip built a wrong layer that the readback
// then faithfully read back. Now this writes each call: the generic template
// from templates/, minified, after a constant holding exactly the facts that
// call needs. The agent sends each file unchanged and saves each response
// unchanged (section 12 of the design), so it writes no styling code at all.
//
// It plans, in order: the build calls, by page in snap order, packed by
// characters and by nodes (a variant is never split); an images call per page
// that has images; one label call; and the readback calls, by page, packed by
// the response each is predicted to return. plan.json lists them, with where
// each response goes, and is what upload, next and verify read.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callCode, canonicalJson, fnv1a32, fnv1a32Bytes, templateKey } from "./checksum.js";
import type { CallWriter, TemplateCarry } from "./checksum.js";
import { extractFirstBalancedObject } from "./figma.js";
import { Binder } from "./figma-bind.js";
import type { Scheme } from "./figma-bind.js";
import { planLayout } from "./figma-layout.js";
import { tailwindPalette } from "./palette.js";
import type { Palette } from "./palette.js";
import type { LayoutChild, LayoutPlan } from "./figma-layout.js";
import { figmaSize, nodeStyle, outsideInsets, textSizesItself } from "./figma-map.js";
import type { BoundByDefault, FigmaStyle, MapContext, NotBuilt, Unbound } from "./figma-map.js";
import { READBACK_TPL, parseReadResult, readBefore, readTimes, readbackCall } from "./figma-results.js";
import type { ReadSlice } from "./figma-results.js";
import { MAX_CALL_CHARS, MAX_UPLOADS_PER_CALL, SPIKE, USE_FIGMA_CODE_LIMIT } from "./figma-spike.js";
import type { Spike } from "./figma-spike.js";
import { describeVariantStories, parseMeasurementWarning } from "./snap.js";
import type { SnapComponent, SnapResult, SnapVariant } from "./snap.js";
import { nameSlugs } from "./snap-args.js";
import { applyDelta } from "./snap-normalize.js";
import { componentKey, selectComponents, selectEach } from "./storybook.js";
import type { ComponentEntry } from "./storybook.js";
import { alphaCalls } from "./figma-tokens.js";
import type { TokenExtractionResult } from "./tokens.js";
import { absoluteBoxes, expandTree, outlineDraws, parentKey, rootWithStyles, transformedAround, treeDigest } from "./tree-types.js";
import type { Box, ComponentTree, FigmaPlan, PlanAlpha, PlanBinding, PlanCall, TreeDelta, TreeNode } from "./tree-types.js";
import { VERSION } from "./version.js";

export interface FigmaCodeOptions {
  /** styles.json, as snap wrote it. */
  snap: string;
  /** `storysync tokens --json` output, for variable bindings; without it nothing binds. */
  tokens?: string;
  /** Components to build, by ID, title, name or the title's last segment, as `--components` takes them; all when absent. */
  components?: string[];
  /** Components to leave out, named the same way. */
  skip?: string[];
  /** Where plan.json, calls/ and results/ go. */
  out: string;
  maxChars?: number;
  maxNodes?: number;
  /** The most characters a readback call is predicted to return. */
  readLimit?: number;
  /** Minified templates (the default); false sends the readable ones, for debugging. */
  minify?: boolean;
  /** Template sources by name, in place of the shipped ones: for tests, and for a readback template not yet shipped. */
  templates?: Partial<Record<TemplateName, string>>;
  /** The spike's answers in place of SPIKE's, so tests can build either way. */
  spike?: Partial<Spike>;
  /** The project, whose Tailwind gives the palette a palette pair's variable takes its values from; the working directory when absent. */
  project?: string;
  /** The palette itself, in place of the project's (palette.ts). */
  palette?: Palette;
  /**
   * Build "Not measured" placeholders over variants Figma has measured
   * from an earlier push, where the story now fails: only once the user
   * has said so (`--replace-measured`).
   */
  replaceMeasured?: boolean;
  /** The readback verify assembled, for what Figma has measured; figma-readback.json beside `out` when absent. */
  readback?: string;
  /**
   * Components, named as `components` takes them, whose plain component an
   * earlier push built the user said to make the first variant of their
   * set, in place, where they now have variant properties: `--convert`.
   */
  convert?: string[];
  /**
   * Remove, from each set built, the variants an earlier push built that no
   * variant property names now, once the user said to: `--remove-extra`.
   * Only a set whose last build Figma answered counted some in `extra` is
   * told to, so the calls of the others stay as they were; one no saved
   * answer counted is left alone, and named in a warning. Names, as
   * `--convert` takes them, limit it to those components' sets: those the
   * user said yes for.
   */
  removeExtra?: boolean | string[];
  /**
   * Every build and read call carries its template, as before 0.4.0's last
   * fix pass, rather than the first of each kind storing it in the Figma
   * file for the rest (checksum.ts, TemplateCarry): `--inline-templates`.
   */
  inlineTemplates?: boolean;
}

export type TemplateName = "build" | "images" | "label" | "readback" | "variables";

/** The readback template a read call is written for (section 9.1), which refuses a call written for another. */
export { READBACK_TPL };

/**
 * The constants each kind of call writes before its template, which the
 * template reads and must not declare itself, or it reads its own. The
 * last, SUM, is the checksum of the others' values (checksum.ts, callSum),
 * which the call checks, and TSUM, the template's, before the template
 * changes or reads anything (callCode).
 */
export const CALL_CONSTANTS: Record<TemplateName, readonly string[]> = {
  build: ["DATA", "SUM"],
  images: ["PAGE", "SUM"],
  label: ["DATA", "SUM"],
  readback: ["PAGE", "SLICES", "LIMIT", "TPL", "SUM"],
  variables: ["DATA", "SUM"],
};

/** use_figma runs a call's code as the body of an async function. */
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => unknown;

/**
 * Refuses a call that isn't JavaScript use_figma can run, before any is
 * sent: compiled, not run. And `template`, the call's own of `kind`, which
 * the call compiles and runs as the body of an async function of `figma`,
 * the constants its call writes and TC (checksum.ts, callCode), compiled
 * here the same way: a template that declares one of them fails to compile,
 * as it would in Figma.
 */
export function assertCompiles(code: string, file: string, kind: TemplateName, template: string): void {
  const params = [...CALL_CONSTANTS[kind].filter((name) => name !== "SUM"), "TC"];
  for (const compile of [() => new AsyncFunction("figma", code), () => new AsyncFunction("figma", ...params, template)]) {
    try {
      compile();
    } catch (e) {
      throw new Error(`${file} is not code use_figma can run (${(e as Error).message}): a template must not declare the constants its call writes before it`);
    }
  }
}

/** What figma code packs each read call's slices to, predicted (figma-results.ts READ_LIMIT says why). */
export const DEFAULT_READ_LIMIT = 17_000;

/**
 * Throws where a call figma code, figma next or figma tokens writes is
 * longer than use_figma takes: Figma refuses such a call whole, so it is
 * a plan no one can send, which every writer packs its calls to avoid.
 */
export function assertWithinLimit(code: string, file: string): void {
  if (code.length > USE_FIGMA_CODE_LIMIT) {
    throw new Error(`${file} is ${code.length} characters, more than use_figma takes (${USE_FIGMA_CODE_LIMIT}): a storysync bug, since every call is packed under it`);
  }
}

/** The readback template's own limit sits this far above what each call is predicted to return. */
const READ_GUARD_MARGIN = 1_000;

type SnapComponentWithTree = SnapComponent & { tree?: ComponentTree; capture?: string };
type SnapVariantWithTree = SnapVariant & {
  treeDelta?: TreeDelta;
  args?: { hidden?: { arg: string }[]; dropped?: { arg: string }[] };
};

// --- Templates --------------------------------------------------------------

const SOURCE_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));
const MINIFIED_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

/**
 * A template's code: the minified build output (dist/templates/*.min.js,
 * from scripts/build-templates.mjs) or the readable source. The readable
 * one has its comment lines blanked but the first, which names it: each
 * line stays the file's line, and a build call keeps the room for its data
 * that the comments, a third of the build template, would take.
 */
export function loadTemplate(name: TemplateName, minify = true, overrides?: FigmaCodeOptions["templates"]): string {
  const given = overrides?.[name];
  if (given !== undefined) return given.trim();
  const path = minify ? join(MINIFIED_DIR, `${name}.min.js`) : join(SOURCE_DIR, `${name}.js`);
  if (!existsSync(path)) {
    throw new Error(
      minify
        ? `${path} is missing: this storysync was built without its templates (scripts/build-templates.mjs, which \`pnpm build\` runs)`
        : `${path} is missing: this storysync has no ${name} template`,
    );
  }
  const code = readFileSync(path, "utf8").trim();
  return minify ? code : code.split("\n").map((line, i) => (i > 0 && /^\s*\/\//.test(line) ? "" : line)).join("\n");
}

// --- Records ----------------------------------------------------------------

/** A node to build: key, parent's index, kind, frame x, y, w, h, and style (with its SVG markup, if any). */
type Record_ = [key: string, parent: number, kind: string, x: number, y: number, w: number, h: number, style: FigmaStyle & { markup?: string }];

interface CompiledVariant {
  name: string;
  slug: string;
  i: number;
  /** 1 measured, 0 a placeholder for a variant snap couldn't measure. */
  src: 0 | 1;
  digest: string;
  records: Record_[];
  /** Image asset ids. */
  images: string[];
  /** Predicted characters of its readback entry. */
  read: number;
}

interface CompiledComponent {
  key: string;
  /** The storysync id written on the set: Storybook's ID, else the key. */
  id: string;
  title?: string;
  name: string;
  page: string;
  props: SnapComponent["variantProperties"];
  variants: CompiledVariant[];
  /** The label line for the set's description, or "". */
  note: string;
  /** What its base styles bound, for the plan. */
  bindings: PlanBinding[];
  /** Whether snap measured it in the dark theme, so the label call puts its set in Dark. */
  dark?: true;
  /** The value snap pins each prop it left out to, as an overlay's `open`: the variant of a dropped property the build keeps. */
  pin?: Record<string, string>;
  /** The default the last push's build gave each property dropped since and not pinned, so the build keeps its variant at that value. */
  od?: Record<string, string>;
}

const round2 = (n: number): number => Math.round(Math.round(n * 1e8) / 1e6) / 100 || 0;
const sides = <T>(value: T | [T, T, T, T]): [T, T, T, T] => (Array.isArray(value) ? value : [value, value, value, value]) as [T, T, T, T];

/** A variant's Figma name, from its combination, as 0.4.0 named variants: `size=sm, disabled=false`. */
export function variantName(combination: Record<string, string>): string {
  return Object.entries(combination).map(([k, v]) => `${k}=${v}`).join(", ");
}

/** Facts gathered while compiling a component, reported once per component. */
interface Findings {
  notBuilt: NotBuilt[];
  unbound: Unbound[];
  byDefault: BoundByDefault[];
  absolute: Map<string, { why: string; slugs: string[] }>;
  /** The alpha variables bound, by name, across the plan. */
  alphas?: Map<string, PlanAlpha>;
}

/**
 * A measured variant's nodes, each with its style and, for each frame with
 * children, its layout plan: everything the records are made of.
 */
function prepareVariant(component: SnapComponentWithTree, variant: SnapVariantWithTree, binder: Binder, findings: Findings, spike: Spike) {
  const tree = component.tree!;
  if (!variant.treeDelta && variant.slug !== component.base!.slug) {
    // Without one it would be built as the base variant's tree, under its own name.
    throw new Error(`${componentKey(component)} ${variant.slug} was measured, but has no treeDelta: snap writes one for every measured variant but the base`);
  }
  const nodes = expandTree(tree, variant.treeDelta);
  const styles = applyDelta(component.base!.styles, variant.delta ?? {});
  // The root's paint lives in its styles: both the build and verify digest
  // the root with it (tree-types.ts, treeDigest).
  const full = [rootWithStyles(nodes[0], styles), ...nodes.slice(1)];
  const digest = treeDigest(full);
  const byKey = new Map(full.map((n) => [n.k, n]));
  const kids = new Map<string, TreeNode[]>();
  for (const node of full.slice(1)) {
    const parent = parentKey(node.k)!;
    kids.set(parent, [...(kids.get(parent) ?? []), node]);
  }
  const inset = (node: TreeNode): [number, number, number, number] => (node.k === "" || !byKey.has(parentKey(node.k)!) ? [0, 0, 0, 0] : outsideInsets(byKey.get(parentKey(node.k)!)!));
  // A node's frame box relative to its parent's frame: its border box, less
  // its own outside stroke, moved by its parent's.
  const frameBox = (node: TreeNode): Box => {
    const own = outsideInsets(node);
    const parent = inset(node);
    const [w, h] = figmaSize(node);
    return node.k === "" ? [0, 0, w, h] : [round2(node.box[0] + own[3] - parent[3]), round2(node.box[1] + own[0] - parent[0]), w, h];
  };
  const layoutBox = (node: TreeNode): Box => {
    if (!spike.outsideStrokeTakesSpace) return frameBox(node);
    const parent = inset(node);
    return [round2(node.box[0] - parent[3]), round2(node.box[1] - parent[0]), node.box[2], node.box[3]];
  };

  const styleOf = new Map<string, FigmaStyle & { markup?: string }>();
  for (const node of full) {
    const parent = node.k === "" ? undefined : byKey.get(parentKey(node.k)!);
    const around = { children: kids.get(node.k)?.length ?? 0, transformed: transformedAround(node.k, (k) => byKey.get(k)) };
    const ctx: MapContext = { binder, notBuilt: findings.notBuilt, unbound: findings.unbound, byDefault: findings.byDefault, alphas: findings.alphas, darkAlpha: tree.darkAlpha === 1, scheme: schemeOf(component), component: componentKey(component), parentCls: parent?.cls, parentEl: parent?.el, spike, around };
    const markup = node.svg ? tree.assets.svg[node.svg] : undefined;
    styleOf.set(node.k, nodeStyle(node, ctx, markup));
  }
  spreadDrawn(full, styleOf, findings.notBuilt);

  const plans = new Map<string, LayoutPlan>();
  for (const node of full) {
    const children = kids.get(node.k);
    if (!children?.length || node.t !== "F") continue;
    const stroke = styleOf.get(node.k)!.s;
    const strokeInset: [number, number, number, number] = stroke && !stroke.o ? sides(stroke.w) : [0, 0, 0, 0];
    const plan = planLayout(
      { k: node.k, size: figmaSize(node), L: node.L, inset: strokeInset },
      children.map((c): LayoutChild => ({
        k: c.k, kind: c.t, box: layoutBox(c), paint: c.box, abs: Boolean(c.abs), hidden: c.vis === 0,
        grow: c.S?.grow, alignSelf: c.S?.as, text: c.t === "T" ? (textSizesItself(c) ? "hug" : "fixed") : undefined,
      })),
      spike,
    );
    plans.set(node.k, plan);
    if (plan.why) {
      const where = `${node.k || "(root)"}: ${plan.why}`;
      const entry = findings.absolute.get(where) ?? { why: plan.why, slugs: [] };
      entry.slugs.push(variant.slug);
      findings.absolute.set(where, entry);
    }
    if (plan.mode !== "NONE") {
      const style = styleOf.get(node.k)!;
      style.L = {
        m: plan.mode === "HORIZONTAL" ? "H" : "V", p: plan.padding, g: plan.spacing, pa: plan.primary, ca: plan.counter,
        ...(stroke && !stroke.o ? { i: 1 as const } : {}), h: [plan.hug[0] ? 1 : 0, plan.hug[1] ? 1 : 0],
      };
    }
  }
  return { full, digest, byKey, kids, frameBox, styleOf, plans };
}

/**
 * Figma draws a shadow's spread, a ring's whole width, only on a frame that
 * clips its content and has a visible fill (its Plugin API; probe 8a saw a
 * ring on a frame without either draw nothing): the build clips a frame
 * whose shadow spreads, where its content draws inside it, so clipping cuts
 * nothing the browser drew, and gives one without a fill a white fill
 * multiplied, which leaves what is behind it as it was and lets the ring
 * draw (probe 8a, call 2). `rc` says which it added, `c` the clip and `f`
 * the fill, and the readback reads the frame without them. Where content
 * draws past the frame, the shadow is built without its spread, and said.
 */
function spreadDrawn(nodes: TreeNode[], styleOf: Map<string, FigmaStyle>, notBuilt: NotBuilt[]): void {
  const abs = absoluteBoxes(nodes);
  for (const node of nodes) {
    const style = styleOf.get(node.k)!;
    if (node.t !== "F" || !style.e?.some((e) => e.length > 2 && e[4] !== 0)) continue;
    let rc = "";
    if (!style.c) {
      const [t, r, b, l] = outsideInsets(node);
      const [x, y, w, h] = abs.get(node.k)!;
      const inside = nodes.every((n) => {
        if (n.vis === 0 || !(node.k === "" ? n.k !== "" : n.k.startsWith(`${node.k}/`))) return true;
        const reach = Math.max(0, ...(n.sh ?? []).filter((s) => !s[5]).map(([sx, sy, blur, spread]) => Math.max(Math.abs(sx), Math.abs(sy)) + blur + Math.max(0, spread)), outlineDraws(n.ol) ? n.ol![0] + n.ol![3] : 0);
        const [nx, ny, nw, nh] = abs.get(n.k)!;
        return nx - reach >= x + l - 0.5 && ny - reach >= y + t - 0.5 && nx + nw + reach <= x + w - r + 0.5 && ny + nh + reach <= y + h - b + 0.5;
      });
      if (!inside) {
        // Built without it, so the readback reads what Figma draws, and verify scores it.
        style.e = style.e.map((e) => (e.length > 2 && e[4] !== 0 ? [e[0], e[1], e[2], e[3], 0, ...e.slice(5)] : e)) as typeof style.e;
        notBuilt.push({ key: node.k, what: "a shadow's spread on a frame whose content draws past it", as: "the shadow without its spread, which Figma draws only on a frame that clips" });
        continue;
      }
      style.c = 1;
      rc += "c";
    }
    if (!style.f?.length) rc += "f";
    if (rc) style.rc = rc;
  }
}

/**
 * The layout plan of each frame with children in a measured variant, by key:
 * what figma code builds, for a test or a report to read.
 */
export function variantLayouts(component: SnapComponent, variant: SnapVariant, spike: Partial<Spike> = {}): Map<string, LayoutPlan> {
  const findings: Findings = { notBuilt: [], unbound: [], byDefault: [], absolute: new Map() };
  return prepareVariant(component as SnapComponentWithTree, variant as SnapVariantWithTree, new Binder(null), findings, { ...SPIKE, ...spike }).plans;
}

/**
 * The records of one measured variant: its nodes in build order (each
 * parent's children in Figma's layer order), each with its frame box and its
 * style, auto layout and sizing included.
 */
function compileVariant(
  component: SnapComponentWithTree,
  variant: SnapVariantWithTree,
  index: number,
  binder: Binder,
  findings: Findings,
  spike: Spike,
): CompiledVariant {
  const { full, digest, byKey, kids, frameBox, styleOf, plans } = prepareVariant(component, variant, binder, findings, spike);
  const records: Record_[] = [];
  const images: string[] = [];
  const own = (node: TreeNode, axis: 0 | 1): string => {
    // A control's value keeps the box measured: its control is as tall as the browser drew it (FigmaText `v`).
    if (node.t === "T") return node.el === "#value" ? "X" : textSizesItself(node) || axis === 1 ? "H" : "X";
    const plan = plans.get(node.k);
    return plan && plan.mode !== "NONE" && plan.hug[axis] ? "H" : "X";
  };
  const visit = (node: TreeNode, parentIndex: number) => {
    const style = { ...styleOf.get(node.k)! };
    const box = frameBox(node);
    const parent = node.k === "" ? undefined : byKey.get(parentKey(node.k)!);
    const plan = parent ? plans.get(parent.k) : undefined;
    if (node.k === "") delete style.n;
    if (plan && plan.mode !== "NONE") {
      if (node.abs) {
        style.a = 1;
        if (spike.absoluteInsetByStroke) {
          const stroke = styleOf.get(parent!.k)!.s;
          const [t, , , l] = stroke && !stroke.o ? sides(stroke.w) : [0, 0, 0, 0];
          box[0] = round2(box[0] - l);
          box[1] = round2(box[1] - t);
        }
      } else {
        const fill = plan.fill[node.k] ?? [false, false];
        style.z = [fill[0] ? "L" : own(node, 0), fill[1] ? "L" : own(node, 1)];
      }
    }
    if (style.rt) {
      // Figma turns a layer about its top left corner, and x and y are where
      // that corner goes: placed so the box turns about its center, as CSS
      // turns it (tree-types builtTurn). In the flow, auto layout puts it
      // there, and the build checks it did (checkLayout).
      const t = (style.rt * Math.PI) / 180;
      const [cx, cy, w, h] = [box[0] + box[2] / 2, box[1] + box[3] / 2, box[2], box[3]];
      box[0] = round2(cx - (Math.cos(t) * w) / 2 - (Math.sin(t) * h) / 2);
      box[1] = round2(cy + (Math.sin(t) * w) / 2 - (Math.cos(t) * h) / 2);
    }
    if (node.img) images.push(node.img);
    const at = records.length;
    records.push([node.k, parentIndex, node.t, box[0], box[1], box[2], box[3], style]);
    const order = plans.get(node.k)?.order ?? (kids.get(node.k) ?? []).map((c) => c.k);
    for (const k of order) visit(byKey.get(k)!, at);
  };
  visit(full[0], -1);
  return {
    name: variantName(variant.combination), slug: variant.slug, i: index, src: 1, digest, records,
    images: [...new Set(images)], read: predictRead(full, variant.slug),
  };
}

/** Why snap couldn't measure a variant, as a placeholder says it: `args_hidden (size)`. */
function unmeasuredReason(variant: SnapVariantWithTree): string {
  const args = [
    ...(variant.args?.hidden ?? []).map((a) => a.arg),
    ...(variant.args?.dropped ?? []).map((a) => a.arg),
    ...(variant.rejectedArgs ?? []).map((a) => a.name),
  ];
  const unique = [...new Set(args)];
  return unique.length ? `${variant.status} (${unique.join(", ")})` : variant.status;
}

/**
 * A variant snap couldn't measure, built as what it is (D18): a dashed frame
 * at the base variant's size saying why, never a guess at its looks. Where
 * snap measured no variant of the component, so there is no base, the frame
 * is as wide as its line at 11px and as tall as the line and its inset.
 */
function compilePlaceholder(component: SnapComponentWithTree, variant: SnapVariantWithTree, index: number): CompiledVariant {
  const text = `Not measured: ${unmeasuredReason(variant)}`;
  const base = component.base?.styles ?? { width: Math.ceil(text.length * 6.5) + 8, height: 21 };
  const [w, h] = [round2(Math.max(0.01, base.width)), round2(Math.max(0.01, base.height))];
  const records: Record_[] = [
    ["", -1, "F", 0, 0, w, h, { f: [], s: { w: 1, p: "#a1a1a1", d: [3, 3] }, r: 0, c: 1 }],
    ["#unmeasured", 0, "T", 4, 4, round2(Math.max(1, w - 8)), 13, { f: ["#737373"], t: { c: text, f: "Inter", w: 400, z: 11, l: 0, ar: "H" } }],
  ];
  return { name: variantName(variant.combination), slug: variant.slug, i: index, src: 0, digest: "", records, images: [], read: READ_ENTRY + 2 * variant.slug.length + 2 * READ_RECORD.F + text.length };
}

// --- Readback prediction ----------------------------------------------------

/**
 * One entry's 13 v1 root fields, readAt and checksum (push2's 0.4.0
 * entries ran 330 to 403 characters), with v2's boxShadow, name, source,
 * tpl, built and designerLayers.
 */
const READ_ENTRY = 520;
/** A record's fixed fields, by kind, with its node id (section 9.2). */
const READ_RECORD = { F: 80, T: 130, V: 55, I: 100 } as const;

/**
 * About how many characters a variant's readback entry takes, from section
 * 9.2's records: on the generous side of the prototypes' measurements,
 * since the readback template returns `more` and continues where a slice
 * runs over, while a call predicted too large only costs another call.
 */
export function predictRead(nodes: TreeNode[], slug: string): number {
  let total = READ_ENTRY + 2 * slug.length;
  for (const node of nodes) {
    total += READ_RECORD[node.t] + node.k.length;
    if (node.bg || node.bgi) total += 26;
    if (node.bd) total += 40;
    total += 34 * (node.sh?.length ?? 0);
    if (node.tx) total += Math.min(node.tx.c.length, 300) + node.tx.f.length;
    total += 36 * (node.shapes?.length ?? 0);
  }
  return total;
}

// --- Components -------------------------------------------------------------

/**
 * The color scheme snap measured a component in, its `scheme`: dark where
 * the preview rendered the dark theme, whose paints then match the tokens'
 * dark values; light where it says so or, from a snap before it did, says
 * nothing.
 */
export function schemeOf(component: SnapComponent): Scheme {
  return (component as SnapComponent & { scheme?: unknown }).scheme === "dark" ? "dark" : "light";
}

/** The Figma page a component goes on: its Storybook category, as the 0.4.0 push placed it. */
export function pageOf(component: SnapComponent): string {
  return component.category || "Components";
}

/** The set's name: the last segment of the title, the name Storybook's sidebar shows. */
export function setNameOf(component: SnapComponent): string {
  return component.title?.split("/").pop() || component.name;
}

/**
 * The description line for a set snap measured from something other than
 * the component, or from more than one story, or "": what it measured, and
 * for a closed trigger why snap didn't open it, then which variants came
 * from a story of their own (describeVariantStories), so someone looking at
 * the set can see Toggle's outline variants came from another story than
 * its others. An overlay snap opened and measured open is the component,
 * and gets no line for it.
 */
function labelLine(component: SnapComponent): string {
  const parts: string[] = [];
  for (const warning of component.warnings ?? []) {
    const note = parseMeasurementWarning(warning);
    if (!note) continue;
    // No double quotes: Figma escapes them in a description (D20).
    const element = note.element.replace(/"/g, "");
    const why = note.kind === "closed-trigger" && note.reason ? `, as snap didn't open it (${note.reason.replace(/"/g, "")})` : "";
    parts.push(note.kind === "closed-trigger"
      ? `measured from its closed trigger, ${element}, not the open ${component.name}${why}`
      : `measured from ${element}, which may be the story's layout wrapper rather than ${component.name}`);
    break;
  }
  const stories = describeVariantStories(component);
  if (stories) parts.push(stories.replace(/"/g, ""));
  return parts.join("; ");
}

/**
 * Why a value its classes should settle stays unbound: none of them names
 * one of its tokens, or several do, as an Alert title's
 * `text-card-foreground`, inherited, and its own `text-foreground`.
 */
function tie(named: string[] | undefined): string {
  if (!named || named.length < 2) return "no class names one";
  const list = named.length === 2 ? `${named[0]} and ${named[1]}` : `${named.slice(0, -1).join(", ")}, and ${named[named.length - 1]}`;
  return `its classes name ${named.length === 2 ? "two" : named.length} of them, ${list}, so it binds to ${named.length === 2 ? "neither" : "none"} rather than to a guess`;
}

/**
 * Whether a variant snap couldn't measure failed in its story, so a
 * placeholder saying why stands for it: a render error, an element not
 * found though the story rendered, args Storybook refused. A timeout, or a
 * story that never rendered, as when Storybook was down or busy, is the
 * run's failure: built as a placeholder, it would replace a good variant
 * in Figma with one, so it isn't built and Figma keeps what it has.
 */
export function failedInStory(variant: Pick<SnapVariant, "status" | "error" | "rendered">): boolean {
  if (variant.status === "ok" || variant.status === "timeout" || variant.rendered === false) return false;
  // A snap from before `rendered` was recorded says a page that never
  // loaded only in its error: a refused connection, a reset, a lookup.
  return !(variant.status === "render_error" && /\bnet::ERR_|\bECONNREFUSED\b/.test(variant.error ?? ""));
}

/**
 * The variants Figma has measured, by component key, then slug: those a
 * readback found built from a measurement (`source` measured), in the
 * readback verify assembled and in every read result saved under `out`,
 * this plan's and the earlier ones'. Any one saying so is enough: a
 * placeholder goes over one only once the user has said so.
 */
export function measuredInFigma(out: string, readback = join(out, "..", "figma-readback.json")): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (component: string, slug: string, entry: unknown) => {
    if ((entry as { source?: unknown } | null)?.source !== "measured") return;
    const slugs = found.get(component) ?? new Set<string>();
    // A part of a variant read across calls is `slug#<first node>`.
    slugs.add(slug.replace(/#\d+$/, ""));
    found.set(component, slugs);
  };
  try {
    const file = JSON.parse(readFileSync(readback, "utf8")) as { components?: Record<string, { variants?: Record<string, unknown> }> };
    for (const [component, read] of Object.entries(file?.components ?? {})) {
      for (const [slug, entry] of Object.entries(read?.variants ?? {})) add(component, slug, entry);
    }
  } catch {
    // None yet, or not one verify wrote: the results below may still say.
  }
  const earlier = join(out, EARLIER_PLANS_DIR);
  const dirs = [join(out, "results")];
  if (existsSync(earlier) && lstatSync(earlier).isDirectory()) {
    for (const name of readdirSync(earlier).sort()) dirs.push(join(earlier, name, "results"));
  }
  for (const dir of dirs) {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json") || !lstatSync(join(dir, name)).isFile()) continue;
      const result = parseReadResult(readFileSync(join(dir, name), "utf8"));
      for (const set of result?.sets ?? []) {
        for (const [slug, entry] of Object.entries(set.entries ?? {})) add(set.title || set.component, slug, entry);
      }
    }
  }
  return found;
}

function compileComponent(
  component: SnapComponentWithTree, binder: Binder, warnings: string[], spike: Spike, alphas: Map<string, PlanAlpha>,
  inFigma: ReadonlySet<string> = new Set(), replaceMeasured = false,
): CompiledComponent | null {
  const key = componentKey(component);
  // A component snap couldn't measure at all has no variants to build.
  if (component.error || (!component.base && !component.variants?.length)) {
    warnings.push(`${key}: not built: ${component.error ?? "snap measured no variant of it"}`);
    return null;
  }
  const findings: Findings = { notBuilt: [], unbound: [], byDefault: [], absolute: new Map(), alphas };
  // A variant that failed in its story is built as a placeholder, unless
  // Figma has it measured, which only the user may have replaced. One the
  // run failed (a timeout, Storybook down) isn't built: Figma keeps it.
  const variants: CompiledVariant[] = [];
  const ofRun: string[] = [];
  const kept: string[] = [];
  component.variants.forEach((variant, i) => {
    if (variant.status === "ok" && component.base) variants.push(compileVariant(component, variant as SnapVariantWithTree, i, binder, findings, spike));
    else if (!failedInStory(variant)) ofRun.push(variant.slug);
    else if (!replaceMeasured && inFigma.has(variant.slug)) kept.push(variant.slug);
    else variants.push(compilePlaceholder(component, variant as SnapVariantWithTree, i));
  });
  const them = (slugs: string[]) => (slugs.length === 1 ? "it" : "them");
  const count = (slugs: string[]) => (slugs.length === 1 ? "1 variant" : `${slugs.length} variants`);
  const why: string[] = [];
  if (ofRun.length) {
    why.push(
      `snap timed out or couldn't reach Storybook for ${count(ofRun)} (${nameSlugs(ofRun)}), which ${ofRun.length === 1 ? "is" : "are"} not built, so Figma keeps what it has for ${them(ofRun)}: ` +
      `measure ${them(ofRun)} again with --components ${component.id ?? key} --merge once Storybook answers`,
    );
  }
  if (kept.length) {
    why.push(
      `${count(kept)} failed in the story (${nameSlugs(kept)}), which Figma has measured from an earlier push, so ${kept.length === 1 ? "it is" : "they are"} left as ${kept.length === 1 ? "it is" : "they are"}, ` +
      `not replaced by "Not measured" placeholders: ask the user, and only on a yes run figma code again with --replace-measured`,
    );
  }
  if (!variants.length) {
    warnings.push(`${key}: not built: ${why.join("; ")}`);
    return null;
  }
  for (const line of why) warnings.push(`${key}: ${line}`);
  const placeholders = variants.filter((v) => !v.src).length;
  const counted = placeholders === variants.length && placeholders > 1 ? `all ${placeholders} variants` : `${placeholders} variant${placeholders === 1 ? "" : "s"}`;
  if (placeholders) warnings.push(`${key}: ${counted} built as a "Not measured" placeholder, since snap couldn't measure ${placeholders === 1 ? "it" : "them"}`);
  for (const [where, { slugs }] of findings.absolute) {
    warnings.push(`${key} › ${where}, so it is built without auto layout (${slugs.length === variants.length ? "every variant" : `${slugs.length} of ${variants.length} variants`})`);
  }
  // Each once: what isn't built, or what is built in its place.
  const notBuilt = new Set<string>();
  for (const n of findings.notBuilt) notBuilt.add(`${n.key || "(root)"}: ${n.what} ${n.as ? `is built as ${n.as}` : "is not built"}`);
  for (const line of notBuilt) warnings.push(`${key} › ${line}`);
  // Each value once for each reason: no class naming any of its tokens,
  // or classes naming several, which tie.
  const unbound = new Map<string, Unbound>();
  for (const u of findings.unbound) unbound.set(`${u.property} ${u.value} ${u.why ?? u.named?.join(",") ?? ""}`, u);
  for (const [, u] of [...unbound].sort(([a], [b]) => a.localeCompare(b))) {
    warnings.push(`${key}: ${u.property} ${u.value} left unbound: ${u.why ?? `it matches ${u.candidates.join(", ")}, and ${tie(u.named)}`}`);
  }
  // Each value a base style bound, once, with the layers it bound in any
  // variant: the evidence for a binding no class shows.
  const bindings = new Map<string, PlanBinding>();
  for (const b of findings.byDefault) {
    const id = `${b.property} ${b.value}`;
    const was = bindings.get(id) ?? { component: key, property: b.property, value: b.value, variable: b.variable, from: b.from, ...(b.alike ? { alike: b.alike } : {}), ...(b.named ? { named: b.named } : {}), keys: [] };
    if (!was.keys.includes(b.key)) was.keys = [...was.keys, b.key].sort();
    bindings.set(id, was);
  }
  // Measured dark, its paints matched the tokens' dark values, and the
  // label call puts its set in Dark, where they show as measured.
  const dark = schemeOf(component) === "dark";
  if (dark && !binder.empty) {
    warnings.push(`${key}: snap measured it in the dark theme, so its paints bind by the tokens' dark values, and the label call puts its set in each collection's Dark mode, where they show as measured; a translucent paint keeps its dark alpha in Light too. Snap it in the light theme to bind by light values`);
  }
  const pin = Object.fromEntries((component.excludedProps ?? []).filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
  return {
    key, id: component.id ?? key, title: component.title, name: setNameOf(component), page: pageOf(component),
    props: component.variantProperties, variants, note: labelLine(component),
    ...(Object.keys(pin).length ? { pin } : {}),
    bindings: [...bindings.keys()].sort().map((k) => bindings.get(k)!),
    ...(dark ? { dark: true as const } : {}),
  };
}

// --- Calls ------------------------------------------------------------------

/** Strings and styles a call shares between its records, each written once. */
class Table {
  readonly values: unknown[] = [];
  private readonly index = new Map<string, number>();
  add(value: unknown): number {
    const id = typeof value === "string" ? `s${value}` : `o${canonicalJson(value)}`;
    let at = this.index.get(id);
    if (at === undefined) {
      at = this.values.length;
      this.values.push(value);
      this.index.set(id, at);
    }
    return at;
  }
}

/** A run of one component's variants in one build call. */
interface Part {
  component: CompiledComponent;
  variants: CompiledVariant[];
  /**
   * One part (`p`) of a variant too big for one call, alone in its part:
   * its records, from the variant's record `o`, the hash of each part (`h`
   * this one's, `e` those before it) and the calls of those before.
   */
  chunk?: { records: Record_[]; p: [number, number]; o: number; h: string; e: string[]; calls?: string };
  /** Whether this part holds the component's last variant, whole or its last part: the set's last part. */
  end?: boolean;
}

/** What a build call's set says beyond its variants: the user's answers, and the values snap pinned. */
interface SetFlags {
  convert: Set<string>;
  /** Whether this component's set removes its extra variants (`rm`). */
  removeExtra: (component: { id: string; key: string }) => boolean;
  /** The key of the Figma file whose build counted the extras, which `rm` holds, so a build in another file removes none. */
  extrasFile?: string;
}

type Interned = [number, number, string, number, number, number, number, number];

function intern(records: Record_[], table: Table): Interned[] {
  return records.map(([key, parent, kind, x, y, w, h, style]) => {
    const { markup, ...rest } = style;
    const value: FigmaStyle = markup === undefined ? rest : { ...rest, m: table.add(markup) };
    return [table.add(key), parent, kind, x, y, w, h, table.add(value)];
  });
}

/** A variant's records as a change to the base's, or in full where its nodes differ. */
function deltaOf(base: Interned[], records: Interned[]): unknown {
  const same = base.length === records.length && base.every((b, i) => b[0] === records[i][0] && b[1] === records[i][1] && b[2] === records[i][2]);
  if (!same) return { r: records };
  const out: unknown[] = [];
  records.forEach((r, i) => {
    const b = base[i];
    const box = r[3] !== b[3] || r[4] !== b[4] || r[5] !== b[5] || r[6] !== b[6] ? [r[3], r[4], r[5], r[6]] : 0;
    const style = r[7] !== b[7] ? r[7] : -1;
    if (box || style >= 0) out.push([i, box, style]);
  });
  return out;
}

/**
 * A call's first line, a comment. The page is a Storybook category, which a
 * title in index.json can give a line break: one left in would end the
 * comment, and what followed it would run as the call's code.
 */
function header(seq: number, kind: string, page: string): string {
  const name = page.replace(/[\r\n\u2028\u2029]+/g, " ");
  return `// storysync figma code, call ${pad(seq)}: ${kind}${name ? ` on page "${name}"` : ""}. Send this file unchanged as use_figma's code.\n`;
}

/**
 * The code of a build call over these parts, all on `page`. Each part's
 * variants are sent as changes to its first variant's records, so a variant
 * alone in a call carries its own records only.
 */
function buildCode(seq: number, page: string, parts: Part[], template: string, flags: SetFlags, carry?: TemplateCarry): string {
  const table = new Table();
  const sets = parts.map(({ component, variants, chunk, end }) => {
    const base = chunk ? [] : intern(variants[0].records, table);
    const set: Record<string, unknown> = {
      id: component.id, title: component.title ?? "", name: component.name, props: component.props, base,
      v: chunk
        ? variants.map((v) => [v.name, v.slug, v.i, v.src, v.digest, { r: intern(chunk.records, table), p: chunk.p, o: chunk.o, h: chunk.h, e: chunk.e, ...(chunk.calls ? { c: chunk.calls } : {}) }])
        : variants.map((v) => [v.name, v.slug, v.i, v.src, v.digest, deltaOf(base, intern(v.records, table))]),
    };
    if (flags.convert.has(component.key) && component.props.length) set.cv = 1;
    if (component.pin) set.pin = component.pin;
    if (component.od) set.od = component.od;
    if (end) set.end = 1;
    if (end && flags.removeExtra(component)) set.rm = flags.extrasFile ?? 1;
    return set;
  });
  return `${header(seq, "build", page)}${callCode([["DATA", { page, S: table.values, sets }]], template, "figma code", carry)}`;
}

const pad = (seq: number) => String(seq).padStart(2, "0");

/** A page's name as part of a file name. */
export function pageSlug(page: string): string {
  return page.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

function describeParts(parts: Part[]): string {
  return parts.map(({ component, variants, chunk }) => {
    const all = component.variants.length;
    if (chunk) return `${component.name} (variant ${component.variants.indexOf(variants[0]) + 1} of ${all}, part ${chunk.p[0]} of ${chunk.p[1]})`;
    if (variants.length === all) return `${component.name} (${all} variant${all === 1 ? "" : "s"})`;
    const first = component.variants.indexOf(variants[0]) + 1;
    const last = component.variants.indexOf(variants[variants.length - 1]) + 1;
    const span = last - first + 1 === variants.length ? `variants ${first}-${last}` : `${variants.length} variants of ${first}-${last}`;
    return `${component.name} (${first === last ? `variant ${first}` : span} of ${all})`;
  }).join(", ");
}

/** A readback call's slices, as plan.json lists them: [storysync id, first i, last i]. */
type Slice = [string, number, number];

function readCode(seq: number, page: string, slices: (Slice | [string, number, number, number])[], limit: number, template: string, writer: CallWriter = "figma code", carry?: TemplateCarry): string {
  const full = slices.map((s): ReadSlice => (s.length === 4 ? s : [...s, 0]));
  return `${header(seq, "read back", page)}${readbackCall(template, page, full, limit, writer, carry)}`;
}

// --- figma code -------------------------------------------------------------

function readTokens(path: string | undefined, warnings: string[]): TokenExtractionResult | null {
  if (!path) return null;
  if (!existsSync(path)) {
    warnings.push(`no tokens at ${path}, so nothing is bound to a variable: save them first with \`npx storysync tokens --json > ${path}\``);
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as TokenExtractionResult;
}

/**
 * The files a plan has under calls/ and results/: its calls and their
 * continuations (`07-read-ui-base.js`, `07b-read-ui-base.js`), and the
 * responses saved for them (`07.json`, `07b.json`, `03.upload.json`).
 */
const PLAN_FILES: Record<"calls" | "results", RegExp> = {
  calls: /^\d{2,}[b-z]?-(?:variables|build|images|label|read)(?:-[a-z0-9-]+)?\.js$/,
  results: /^\d{2,}[b-z]?(?:\.upload)?\.json$/,
};

/**
 * Removes an earlier plan's calls and results under `out`, and nothing else:
 * a result saved for an earlier plan's call would otherwise be read as this
 * plan's, while `out` may be a directory the user keeps other files in.
 */
function clearPlanFiles(out: string): void {
  for (const [dir, pattern] of Object.entries(PLAN_FILES)) {
    const at = join(out, dir);
    if (!existsSync(at) || !lstatSync(at).isDirectory()) continue;
    for (const name of readdirSync(at)) {
      if (pattern.test(name) && lstatSync(join(at, name)).isFile()) rmSync(join(at, name));
    }
  }
}

/**
 * Refuses `rel` under `out` where a symbolic link is on its way or in its
 * place. A plan's files have fixed names there, so a link committed as one
 * of them, `calls` to another directory or `plan.json` to `~/.bashrc`, had
 * them written, or moved, wherever it led.
 */
export function assertNoLinks(out: string, rel: string): void {
  let at = out;
  for (const part of rel.split("/")) {
    at = join(at, part);
    let link: boolean;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      return;
    }
    if (link) throw new Error(`${at} is a symbolic link, and storysync writes its plan only to files of its own under ${out}: remove the link, or pass another --out`);
  }
}

/** Where under `out` an earlier plan Figma answered is kept (keepEarlierPlan). */
export const EARLIER_PLANS_DIR = "earlier";

/**
 * Moves the plan under `out`, with its calls and results, to
 * `out/earlier/<its digest>/` where Figma answered one of its read calls,
 * so verify --plan can still score it once this plan replaces it: each
 * push writes its plan to one directory, while the snap keeps every push's
 * components. Its snap path is rewritten to lead from there. A plan none
 * of whose reads has a result has nothing to verify, as one stopped by an
 * error and planned again, and is removed as before (clearPlanFiles).
 * Returns the moved plan's path, or null.
 */
function keepEarlierPlan(out: string): string | null {
  const planPath = join(out, "plan.json");
  if (!existsSync(planPath)) return null;
  let bytes: Buffer;
  let plan: FigmaPlan;
  try {
    bytes = readFileSync(planPath);
    plan = JSON.parse(bytes.toString("utf8")) as FigmaPlan;
  } catch {
    return null;
  }
  if (plan?.version !== 1 || !Array.isArray(plan.calls) || typeof plan.snap?.path !== "string") return null;
  if (!plan.calls.some((c) => c.kind === "read" && typeof c.result === "string" && existsSync(join(out, c.result)))) return null;
  const dir = join(out, EARLIER_PLANS_DIR, fnv1a32Bytes(bytes));
  rmSync(dir, { recursive: true, force: true });
  for (const [sub, pattern] of Object.entries(PLAN_FILES)) {
    const at = join(out, sub);
    mkdirSync(join(dir, sub), { recursive: true });
    if (!existsSync(at) || !lstatSync(at).isDirectory()) continue;
    for (const name of readdirSync(at)) {
      if (pattern.test(name) && lstatSync(join(at, name)).isFile()) renameSync(join(at, name), join(dir, sub, name));
    }
  }
  const moved: FigmaPlan = { ...plan, snap: { ...plan.snap, path: relative(dir, resolve(out, plan.snap.path)).split("\\").join("/") } };
  writeFileSync(join(dir, "plan.json"), `${JSON.stringify(moved, null, 2)}\n`);
  rmSync(planPath);
  return join(dir, "plan.json");
}

/** A variant property as a build call's DATA gives it. */
type Prop = SnapComponent["variantProperties"][number];

/**
 * The variant properties the last build Figma answered of each set built it
 * with, none where it built one plain component, by storysync id: from the plan
 * under `out` and those kept under `out/earlier/`, the newest first, each
 * from its build calls' DATA, the latest first, where a result was saved
 * and didn't refuse the set.
 */
export function builtShapes(out: string): Map<string, Prop[]> {
  const dir = resolve(out);
  const earlier = join(dir, EARLIER_PLANS_DIR);
  const kept = existsSync(earlier) ? readdirSync(earlier).map((d) => join(earlier, d)).filter((d) => existsSync(join(d, "plan.json"))) : [];
  kept.sort((a, b) => statSync(join(b, "plan.json")).mtimeMs - statSync(join(a, "plan.json")).mtimeMs);
  const shapes = new Map<string, Prop[]>();
  for (const at of [...(existsSync(join(dir, "plan.json")) ? [dir] : []), ...kept]) {
    try {
      const plan = JSON.parse(readFileSync(join(at, "plan.json"), "utf8")) as FigmaPlan;
      for (const call of [...plan.calls].reverse()) {
        if (call.kind !== "build" || !existsSync(join(at, call.result)) || !existsSync(join(at, call.file))) continue;
        const result = parseCallResult(readFileSync(join(at, call.result), "utf8"));
        const refused = new Set(((result?.sets ?? []) as { component?: string; refused?: string }[]).filter((r) => r.refused).map((r) => r.component));
        const data = /\nconst DATA = (.*);\n/.exec(readFileSync(join(at, call.file), "utf8"));
        for (const set of data ? (JSON.parse(data[1]) as { sets: { id: string; props: Prop[] }[] }).sets : []) {
          if (!shapes.has(set.id) && !refused.has(set.id)) shapes.set(set.id, set.props);
        }
      }
    } catch {
      // Not a plan, or calls, this storysync wrote: nothing to go by.
    }
  }
  return shapes;
}

/**
 * The `extra` the last build Figma answered of each set counted, by
 * storysync id, read as builtShapes reads: from the plan under `out` and
 * those kept under `out/earlier/`, the newest first, each from its build
 * calls' results, the latest first, where it didn't refuse the set. Only
 * answers from the file the newest came from count (`file`, its key), so
 * a plan another file answered says nothing of this one's sets; that key
 * is `file`, for the builds to check they run in that file.
 */
export function builtExtras(out: string): { counts: Map<string, number>; file?: string } {
  const dir = resolve(out);
  const earlier = join(dir, EARLIER_PLANS_DIR);
  const kept = existsSync(earlier) ? readdirSync(earlier).map((d) => join(earlier, d)).filter((d) => existsSync(join(d, "plan.json"))) : [];
  kept.sort((a, b) => statSync(join(b, "plan.json")).mtimeMs - statSync(join(a, "plan.json")).mtimeMs);
  const extras = new Map<string, number>();
  let file: unknown = null;
  for (const at of [...(existsSync(join(dir, "plan.json")) ? [dir] : []), ...kept]) {
    try {
      const plan = JSON.parse(readFileSync(join(at, "plan.json"), "utf8")) as FigmaPlan;
      for (const call of [...plan.calls].reverse()) {
        if (call.kind !== "build" || !existsSync(join(at, call.result))) continue;
        const result = parseCallResult(readFileSync(join(at, call.result), "utf8"));
        if (!result) continue;
        if (file === null) file = result.file;
        if (result.file !== file) continue;
        for (const set of (result?.sets ?? []) as { component?: string; refused?: string; stashed?: number; extra?: number }[]) {
          if (set.component && !set.refused && !set.stashed && !extras.has(set.component)) extras.set(set.component, set.extra ?? 0);
        }
      }
    } catch {
      // Not a plan, or results, this storysync wrote: nothing to go by.
    }
  }
  return { counts: extras, ...(typeof file === "string" ? { file } : {}) };
}

/**
 * The styles.json `--snap` names: the path itself, or the one in a
 * directory it names, such as `.storysync/snaps`. An error that says what
 * to do where there is none, not the file system's ENOENT or EISDIR.
 */
export function snapFile(path: string): string {
  const file = existsSync(path) && lstatSync(path).isDirectory() ? join(path, "styles.json") : path;
  if (!existsSync(file)) {
    throw new Error(
      `No snap at ${file}: run \`storysync snap\` first, or pass --snap the styles.json it wrote (or its directory)`,
    );
  }
  if (lstatSync(file).isDirectory()) throw new Error(`${file} is a directory: pass --snap the styles.json snap wrote, or the directory that holds it`);
  return file;
}

/**
 * Writes plan.json and every call file for a push of `snap`, first moving
 * an earlier plan Figma answered to `out/earlier/` (keepEarlierPlan) and
 * removing any other's calls and results under `out` (clearPlanFiles).
 * Two runs over the same inputs write the same bytes.
 */
export async function runFigmaCode(opts: FigmaCodeOptions): Promise<{ plan: FigmaPlan; planPath: string; warnings: string[]; bindings: PlanBinding[]; alphas: PlanAlpha[]; earlier?: string }> {
  const maxChars = opts.maxChars ?? MAX_CALL_CHARS;
  const spike: Spike = { ...SPIKE, ...opts.spike };
  const maxNodes = opts.maxNodes ?? spike.maxNodes;
  const readLimit = opts.readLimit ?? DEFAULT_READ_LIMIT;
  const minify = opts.minify ?? true;
  if (maxChars > USE_FIGMA_CODE_LIMIT) throw new Error(`--max-chars ${maxChars} is more than use_figma takes (${USE_FIGMA_CODE_LIMIT})`);
  const warnings: string[] = [];
  const snapPath = snapFile(opts.snap);
  const bytes = readFileSync(snapPath);
  const snap = JSON.parse(bytes.toString("utf8")) as SnapResult & { components: SnapComponentWithTree[] };
  const metaPath = join(dirname(snapPath), "meta.json");
  const measuredAt = existsSync(metaPath) ? String((JSON.parse(readFileSync(metaPath, "utf8")) as { measuredAt?: string }).measuredAt ?? "") : "";
  const tokens = readTokens(opts.tokens, warnings);
  const binder = new Binder(tokens, opts.palette ?? tailwindPalette(opts.project ?? process.cwd()));

  const all = (snap.components ?? []) as SnapComponentWithTree[];
  const entries = all.map((c): ComponentEntry => ({ id: c.id ?? componentKey(c), name: c.name, title: c.title }));
  const chosen = new Set(selectComponents(entries, opts.components));
  const skipped = opts.skip?.length ? new Set(selectComponents(entries, opts.skip, [], "--skip")) : new Set<ComponentEntry>();
  const picked = all.filter((_, i) => chosen.has(entries[i]) && !skipped.has(entries[i]));
  const rootOnly = picked.filter((c) => !c.error && c.base && !c.tree).map(componentKey);
  if (rootOnly.length) {
    throw new Error(
      `${snapPath} has no element tree for ${rootOnly.join(", ")}: it was taken with --root-only, or before trees were measured. ` +
      "figma code builds from trees: take the snap again without --root-only, or build it with the skill's root-only templates.",
    );
  }
  const bound = new Map<string, PlanAlpha>();
  // Before an earlier plan moves: what Figma has measured, which no
  // placeholder replaces unasked.
  const inFigma = measuredInFigma(opts.out, opts.readback);
  const components = picked
    .map((c) => compileComponent(c, binder, warnings, spike, bound, inFigma.get(componentKey(c)), opts.replaceMeasured))
    .filter((c): c is CompiledComponent => c !== null);
  if (!components.length) {
    // Why each wasn't, which the warnings that would have said it can't.
    const why = warnings.filter((w) => w.includes(": not built: "));
    throw new Error(`No component to build: ${why.length ? why.join("; ") : "snap measured none of those named, or each failed"}`);
  }

  const pages: string[] = [];
  for (const c of components) if (!pages.includes(c.page)) pages.push(c.page);
  const templates = {
    build: loadTemplate("build", minify, opts.templates),
    images: loadTemplate("images", minify, opts.templates),
    label: loadTemplate("label", minify, opts.templates),
    readback: loadTemplate("readback", minify, opts.templates),
    variables: loadTemplate("variables", minify, opts.templates),
  };

  const calls: (PlanCall & { code: string })[] = [];
  const add = (call: Omit<PlanCall, "seq" | "file" | "result" | "chars">, code: (seq: number) => string) => {
    const seq = calls.length + 1;
    const text = code(seq);
    const named = call.page || call.collection;
    const file = `calls/${pad(seq)}-${call.kind}${named ? `-${pageSlug(named)}` : ""}.js`;
    const kind = call.kind === "read" ? "readback" : call.kind;
    assertCompiles(text, file, kind, templates[kind]);
    assertWithinLimit(text, file);
    calls.push({
      seq, kind: call.kind, page: call.page, components: call.components,
      ...(call.collection ? { collection: call.collection } : {}),
      file, result: `results/${pad(seq)}.json`,
      description: call.description, chars: text.length,
      ...(call.nodes !== undefined ? { nodes: call.nodes } : {}),
      ...(call.slices ? { slices: call.slices } : {}),
      ...(call.predicted !== undefined ? { predicted: call.predicted } : {}),
      code: text,
    });
  };

  // First the alpha variables the translucent paints bind to, each a
  // token's color at an alpha in every mode, which Figma keeps at a mode
  // switch (figma-bind.ts): a call per color collection, before the builds
  // that bind them, so the plan sent in order needs nothing else first.
  // It finds and updates what `figma tokens` made already, and changes
  // nothing then. A build that finds none binds the token at the paint's
  // opacity, which a mode switch resets to 1, and says so in `fallbacks`.
  const alphas = [...bound.values()].sort((a, b) => (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0));
  for (const { collection, data, alpha } of tokens && alphas.length ? alphaCalls(tokens, alphas, warnings) : []) {
    for (const a of alphas) if (alpha.includes(a.variable)) a.collection = collection;
    add(
      { kind: "variables", page: "", components: [], collection, description: `Create or update the alpha variables ${alpha.join(", ")} in the ${collection} variable collection, each a token's color at an alpha in every mode, for the translucent paints the builds bind` },
      (seq) => `${header(seq, "variables", "")}${callCode([["DATA", data]], templates.variables)}`,
    );
  }

  // What the last push built each set with: the default of each property
  // dropped since and not pinned, so the build keeps that variant.
  const shapes = builtShapes(opts.out);
  for (const c of components) {
    const od = Object.fromEntries((shapes.get(c.id) ?? []).filter((p) => !c.props.some((q) => q.name === p.name) && !(p.name in (c.pin ?? {}))).map((p) => [p.name, p.defaultValue]));
    if (Object.keys(od).length) c.od = od;
  }

  // Builds: by page, each component's variants in snap order, packed. A
  // variant too big for one call, by its characters or its nodes, is sent
  // in parts, each call as many of its records as fit: each part's call
  // builds its records, in the order snap gave them, so each one's parent
  // is built before it, and keeps them on the page for the parts after it;
  // the last part's call removes what snap no longer measures and lays
  // the variant out whole.
  const keys = new Map(entries.map((e, i) => [e, componentKey(all[i])]));
  const convert = new Set(opts.convert?.length ? selectEach(entries, opts.convert, "--convert").map((e) => keys.get(e)!) : []);
  // --remove-extra tells a set to remove its extra variants only where
  // its last build Figma answered counted some: one with none to remove
  // keeps its call as it was, byte for byte, and one no saved answer
  // counted, as after a fresh clone or a teammate's push, is left alone,
  // never removed from on a guess.
  const { counts: extras, file } = opts.removeExtra ? builtExtras(opts.out) : { counts: new Map<string, number>(), file: undefined };
  const named = Array.isArray(opts.removeExtra) ? new Set(selectEach(entries, opts.removeExtra, "--remove-extra").map((e) => keys.get(e)!)) : null;
  const asked = (c: { key: string }) => Boolean(opts.removeExtra) && (!named || named.has(c.key));
  const flags: SetFlags = { convert, removeExtra: (c) => asked(c) && (extras.get(c.id) ?? 0) > 0, extrasFile: file };
  const unknown = components.filter((c) => asked(c) && !extras.has(c.id)).map((c) => c.title ?? c.name);
  if (unknown.length) {
    warnings.push(`--remove-extra left ${unknown.join(", ")} as ${unknown.length === 1 ? "it is" : "they are"}: no saved build response says how many extra variants ${unknown.length === 1 ? "it has" : "they have"}. Send this plan, then run figma code --remove-extra again to remove those its builds count in \`extra\``);
  }
  const isEnd = (p: Part) => p.variants[p.variants.length - 1] === p.component.variants[p.component.variants.length - 1] && (!p.chunk || p.chunk.p[0] === p.chunk.p[1]);
  // The first build call, and the first read, carries its template and
  // stores it in the file; the rest of their kind run what it stored.
  const first: Partial<Record<"build" | "read", number>> = {};
  const carry = (kind: "build" | "read", seq: number): TemplateCarry | undefined => {
    if (opts.inlineTemplates) return undefined;
    const from = first[kind];
    const name = kind === "read" ? "readback" : kind;
    return from === undefined || seq <= from ? { kind: name, store: true } : { kind: name, from: pad(from) };
  };
  const code = (seq: number, page: string, parts: Part[], storing?: boolean) =>
    buildCode(seq, page, parts.map((p) => ({ ...p, end: isEnd(p) })), templates.build, flags, storing === false ? { kind: "build", from: "00" } : carry("build", seq));
  const tooBig = new Set<CompiledVariant>();
  for (const page of pages) {
    let parts: Part[] = [];
    const flush = () => {
      if (!parts.length) return;
      const done = parts;
      parts = [];
      const nodes = done.reduce((t, p) => t + (p.chunk ? p.chunk.records.length : p.variants.reduce((u, v) => u + v.records.length, 0)), 0);
      add(
        { kind: "build", page, components: [...new Set(done.map((p) => p.component.key))], description: `Create or update ${describeParts(done)} on page "${page}"`, nodes },
        (seq) => code(seq, page, done),
      );
      const call = calls[calls.length - 1];
      first.build ??= call.seq;
      if (!done[0].chunk && nodes > maxNodes) warnings.push(`call ${pad(call.seq)} holds one variant of ${nodes} nodes, over --max-nodes ${maxNodes}`);
    };
    for (const component of components.filter((c) => c.page === page)) {
      for (const variant of component.variants) {
        const next = parts.map((p) => ({ ...p, variants: [...p.variants] }));
        const last = next[next.length - 1];
        if (last?.component === component) last.variants.push(variant);
        else next.push({ component, variants: [variant] });
        const nodes = next.reduce((t, p) => t + p.variants.reduce((u, v) => u + v.records.length, 0), 0);
        const images = new Set(next.flatMap((p) => p.variants.flatMap((v) => v.images))).size;
        if (nodes <= maxNodes && images <= MAX_UPLOADS_PER_CALL && code(calls.length + 1, page, next).length <= maxChars) {
          parts = next;
          continue;
        }
        // It starts a call of its own.
        flush();
        const alone: Part[] = [{ component, variants: [variant] }];
        if (variant.records.length <= maxNodes && code(calls.length + 1, page, alone).length <= maxChars) {
          parts = alone;
          continue;
        }
        // In parts, each as many of its records as fit beside the template,
        // and at most --max-nodes: a node too big for --max-chars alone is a
        // part of its own, warned, and one too big for any call leaves its
        // variant out, said.
        const { records } = variant;
        const chunks: Record_[][] = [];
        const offsets: number[] = [];
        for (let a = 0; a < records.length;) {
          // Only the first call of the plan's builds carries the template.
          const seq = calls.length + 1 + chunks.length;
          const storing = opts.inlineTemplates || (first.build === undefined && !chunks.length) ? undefined : false;
          const before = chunks.map(() => "ffffffff");
          const size = (b: number) => code(seq, page, [{ component, variants: [variant], chunk: { records: records.slice(a, b), p: [99, 99], o: a, h: "ffffffff", e: before, ...(before.length ? { calls: before.map(() => "99").join(", ") } : {}) } }], storing).length + 100;
          const fits = (b: number) => b - a <= maxNodes && size(b) <= maxChars;
          offsets.push(a);
          if (!fits(a + 1)) {
            const chars = size(a + 1);
            if (chars > USE_FIGMA_CODE_LIMIT) {
              tooBig.add(variant);
              warnings.push(`${component.key} ${variant.slug}: not built: its node ${records[a][0] || "(root)"} alone needs ${chars} characters of code, more than one use_figma call takes (${USE_FIGMA_CODE_LIMIT})`);
              break;
            }
            warnings.push(`${component.key} ${variant.slug}: its node ${records[a][0] || "(root)"} alone needs ${chars} characters of code, over --max-chars ${maxChars}, so it is a call of its own`);
            chunks.push([records[a]]);
            a++;
            continue;
          }
          let [lo, hi] = [a + 1, records.length];
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (fits(mid)) lo = mid;
            else hi = mid - 1;
          }
          chunks.push(records.slice(a, lo));
          a = lo;
        }
        if (tooBig.has(variant)) continue;
        // Each part's hash, over its records and where they start, which
        // each later part checks against what the earlier ones kept, so a
        // part another split of the variant kept is never built on.
        const hashes = chunks.map((chunk, k) => fnv1a32(canonicalJson([offsets[k], chunk])));
        const seqs: string[] = [];
        chunks.forEach((chunk, k) => {
          const p: [number, number] = [k + 1, chunks.length];
          parts = [{ component, variants: [variant], chunk: { records: chunk, p, o: offsets[k], h: hashes[k], e: hashes.slice(0, k), ...(k ? { calls: seqs.join(", ") } : {}) } }];
          seqs.push(pad(calls.length + 1));
          flush();
        });
      }
    }
    flush();
  }
  // What is left to fill, label and read back: the variants built.
  for (const component of components) component.variants = component.variants.filter((v) => !tooBig.has(v));
  const built = components.filter((c) => c.variants.length);
  if (!built.length) throw new Error("No component to build: every variant has a node too big for one use_figma call");
  const builtPages = pages.filter((page) => built.some((c) => c.page === page));
  // An earlier push of a component as one plain component, where it now
  // has variant properties, is the user's to convert: the build refuses
  // its part until figma code is run again with --convert.
  for (const c of built) {
    const before = shapes.get(c.id);
    if (before && !before.length && c.props.length && !convert.has(c.key)) {
      warnings.push(`${c.key}: an earlier push built it as one plain component, and it now has variant properties (${c.props.map((p) => p.name).join(", ")}): ask the user whether to make that component the first variant of its set, in place, which keeps its instances, then run figma code again with --convert ${c.key}; without it, its build part is refused and the rest built`);
    }
    if (before?.length && !c.props.length) warnings.push(`${c.key}: an earlier push built it as a set, and it now has no variant properties: its build part is refused and the rest built, so ask the user whether to skip it`);
  }

  // Images: one call per page whose sets show one.
  for (const page of builtPages) {
    const shown = built.filter((c) => c.page === page && c.variants.some((v) => v.images.length));
    if (!shown.length) continue;
    add(
      { kind: "images", page, components: shown.map((c) => c.key), description: `Fill the image layers on page "${page}" with images already uploaded` },
      (seq) => `${header(seq, "images", page)}${callCode([["PAGE", page]], templates.images)}`,
    );
  }

  // Label: every set built, with a line for those snap measured from
  // something else, packed into calls under --max-chars as the builds are,
  // since a line naming each variant's story grows with the library. Each
  // call carries the pages its sets are on; the last alone removes Page 1,
  // once every set is on its page.
  const labelCode = (seq: number, sets: CompiledComponent[], last: boolean) => {
    const data = {
      pages: builtPages.filter((page) => sets.some((c) => c.page === page)),
      sets: sets.map((c) => (c.dark ? [c.id, c.note, 1] : [c.id, c.note])),
      ...(last ? { last: 1 } : {}),
    };
    return `${header(seq, "label", "")}${callCode([["DATA", data]], templates.label)}`;
  };
  const labels: CompiledComponent[][] = [];
  for (const c of built) {
    const last = labels[labels.length - 1];
    if (last && labelCode(calls.length + labels.length, [...last, c], true).length <= maxChars) last.push(c);
    else labels.push([c]);
  }
  labels.forEach((sets, i) => {
    const last = i === labels.length - 1;
    const dark = sets.some((c) => c.dark) ? "put those it measured in the dark theme in each collection's Dark mode, " : "";
    const what = `Label the sets snap measured from something other than the component or from more than one story${labels.length > 1 ? ` (${sets.map((c) => c.name).join(", ")})` : ""}`;
    add(
      { kind: "label", page: "", components: sets.map((c) => c.key), description: last ? `${what}, ${dark}and remove Figma's empty default page` : `${what}${dark ? `, and ${dark.slice(0, -2)}` : ""}` },
      (seq) => labelCode(seq, sets, last),
    );
  });

  // Reads: by page, slices of each set's variants packed by predicted size.
  for (const page of builtPages) {
    let slices: Slice[] = [];
    let predicted = 0;
    let keys: string[] = [];
    let names: string[] = [];
    const flush = () => {
      if (!slices.length) return;
      const done = { slices, predicted, keys, names };
      slices = [];
      predicted = 0;
      keys = [];
      names = [];
      add(
        { kind: "read", page, components: done.keys, description: `Read back ${done.names.join(", ")} on page "${page}"`, slices: done.slices, predicted: done.predicted },
        (seq) => readCode(seq, page, done.slices, readLimit + READ_GUARD_MARGIN, templates.readback, "figma code", carry("read", seq)),
      );
      first.read ??= calls[calls.length - 1].seq;
    };
    for (const component of built.filter((c) => c.page === page)) {
      for (const variant of component.variants) {
        if (slices.length && predicted + variant.read > readLimit) flush();
        const last = slices[slices.length - 1];
        if (last && last[0] === component.id && last[2] === variant.i - 1) last[2] = variant.i;
        else slices.push([component.id, variant.i, variant.i]);
        predicted += variant.read;
        if (!keys.includes(component.key)) {
          keys.push(component.key);
          names.push(component.name);
        }
      }
    }
    flush();
  }
  // The last read, once it has read all it was for, removes what the
  // plan's calls stored in the file (checksum.ts, CLEAR).
  const lastRead = calls.filter((c) => c.kind === "read").pop();
  const stored = lastRead && carry("read", lastRead.seq);
  if (lastRead && stored) {
    lastRead.code = readCode(lastRead.seq, lastRead.page, lastRead.slices!, readLimit + READ_GUARD_MARGIN, templates.readback, "figma code", { ...stored, clear: true });
    assertCompiles(lastRead.code, lastRead.file, "readback", templates.readback);
    assertWithinLimit(lastRead.code, lastRead.file);
    lastRead.chars = lastRead.code.length;
  }

  const out = resolve(opts.out);
  for (const rel of ["plan.json", "calls", "results", EARLIER_PLANS_DIR, ...calls.map((c) => c.file)]) assertNoLinks(out, rel);
  const earlier = keepEarlierPlan(out);
  clearPlanFiles(out);
  mkdirSync(join(out, "calls"), { recursive: true });
  mkdirSync(join(out, "results"), { recursive: true });
  for (const call of calls) writeFileSync(join(out, call.file), call.code);
  const plan: FigmaPlan = {
    version: 1, storysyncVersion: VERSION,
    snap: {
      path: relative(out, resolve(snapPath)).split("\\").join("/"), measuredAt, digest: fnv1a32Bytes(bytes),
      // Each built component's record, which a later snap of other
      // components keeps as it is, so the plan can be verified after it.
      components: Object.fromEntries(built.map((c) => [c.key, componentDigest(all.find((a) => componentKey(a) === c.key)!)])),
    },
    calls: calls.map(({ code: _code, ...call }) => call),
  };
  const bindings = built.flatMap((c) => c.bindings);
  if (bindings.length) plan.bindings = bindings;
  // Each alpha variable a translucent paint binds to, which the first
  // calls make, and `figma tokens` keeps up to date with its token.
  if (alphas.length) plan.alphas = alphas;
  const planPath = join(out, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, planPath, warnings, bindings, alphas, ...(earlier ? { earlier } : {}) };
}

// --- Estimate ---------------------------------------------------------------

/**
 * What a push costs the agent that sends it, in tokens, never time. Most
 * of it is the calls: the agent writes each file out whole as use_figma's
 * code and reads each response back, and both stay in its context. So the
 * estimate is the README's per-push share plus a share per component
 * (reading its snap, asking about it, reporting it) plus a share per
 * character the calls send and return.
 *
 * Calibrated on push 4 (5 components, 100 variants, 872 elements, 22
 * calls, about 570k agent tokens): its calls sent and returned about
 * 475,000 characters, which the low end puts at 530k. The high end allows
 * a repair round, which sends a component's build and read calls again,
 * and the questions a component can raise.
 */
export const ESTIMATE = {
  /** Setup and verification: tokens, list, snap, verify and the summary. */
  perPush: 100_000,
  /** Reading a component's snap, asking about it and reporting it. */
  perComponent: [10_000, 30_000],
  /** Tokens per character the calls send and return. */
  perChar: [0.8, 1.6],
  /** The README's rule of thumb: 100k tokens a component, plus perPush. */
  ruleOfThumb: 100_000,
} as const;

export interface PushEstimate {
  /** Components the plan builds. */
  components: number;
  /** Planned use_figma calls, and how many of each kind. */
  calls: number;
  byKind: Partial<Record<PlanCall["kind"], number>>;
  /** Characters of code the agent sends: every call's file, whole. */
  charsSent: number;
  /** Characters the read calls are predicted to return, which the agent saves. */
  charsReturned: number;
  /** Agent tokens for the push, setup and verification included, rounded to thousands. */
  tokens: { low: number; high: number };
  /** The rule of thumb for as many components, for comparison. */
  ruleOfThumb: number;
}

/** A push's cost in tokens, from what plan.json says each call holds and returns. */
export function estimatePush(plan: FigmaPlan): PushEstimate {
  const byKind: PushEstimate["byKind"] = {};
  let charsSent = 0;
  let charsReturned = 0;
  const components = new Set<string>();
  for (const call of plan.calls) {
    byKind[call.kind] = (byKind[call.kind] ?? 0) + 1;
    charsSent += call.chars;
    charsReturned += call.predicted ?? 0;
    if (call.kind === "build") for (const key of call.components) components.add(key);
  }
  const moved = charsSent + charsReturned;
  const at = (i: 0 | 1) => Math.round((ESTIMATE.perPush + components.size * ESTIMATE.perComponent[i] + moved * ESTIMATE.perChar[i]) / 1000) * 1000;
  return {
    components: components.size,
    calls: plan.calls.length,
    byKind,
    charsSent,
    charsReturned,
    tokens: { low: at(0), high: at(1) },
    ruleOfThumb: ESTIMATE.perPush + components.size * ESTIMATE.ruleOfThumb,
  };
}

/** Tokens as a person reads them: 530k, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 995_000) return `${Math.round(n / 10_000) * 10}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
}

/** The estimate as one line: what the calls send and return, and the tokens to plan on. */
/**
 * A binding no class showed, as `figma code` prints it: by the base
 * style's rule, or as tokens alike in every mode, with the ones the classes
 * named where they tie (`which its classes name with surface/tertiary`).
 */
export function describeBinding(b: PlanBinding): string {
  const layers = b.keys.map((k) => (k === "" ? "its root" : k)).join(", ");
  const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")}${names.length > 2 ? "," : ""} and ${names[names.length - 1]}`);
  const why = b.alike ? `as ${list(b.alike)} hold it in every mode, so any of them is right in each` : `by the base style ${b.from}`;
  const named = b.named && b.named.length > 1 ? `which its classes name with ${list(b.named.filter((n) => n !== b.variable))}` : "which no class names";
  return `${b.component}: ${b.property} ${b.value} bound to ${b.variable}, ${named}, ${why} (${layers})`;
}

export function describeEstimate(e: PushEstimate): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const returned = e.charsReturned ? ` and read back about ${n(Math.round(e.charsReturned / 1000) * 1000)}` : "";
  return (
    `Estimate: ${e.calls} use_figma ${e.calls === 1 ? "call sends" : "calls send"} ${n(e.charsSent)} characters of code${returned}. ` +
    `Plan on about ${formatTokens(e.tokens.low)}-${formatTokens(e.tokens.high)} agent tokens for this push of ${e.components} ${e.components === 1 ? "component" : "components"}, ` +
    `setup and verification included (the rule of thumb, 100k a component plus 100k a push, gives ${formatTokens(e.ruleOfThumb)}).`
  );
}

// --- Results ----------------------------------------------------------------

/**
 * The object a call returned, from its response saved unchanged: the tool's
 * text holding the returned object as JSON, which is what use_figma gave
 * the spike (item 7), or that JSON once more as a string, an MCP envelope of
 * text parts, or text around it, each read the same. Null when none holds
 * an object with a `kind`.
 */
export function parseCallResult(text: string): Record<string, unknown> | null {
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const visit = (value: unknown, depth: number): Record<string, unknown> | null => {
    if (depth > 8 || value === null || value === undefined) return null;
    if (typeof value === "string") {
      const parsed = parse(value.trim());
      if (parsed !== undefined) return visit(parsed, depth + 1);
      const found = extractFirstBalancedObject(value);
      return found ? visit(parse(found), depth + 1) : null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.kind === "string") return record;
      if (Array.isArray(record.content)) return visit(record.content, depth + 1);
      if (typeof record.text === "string") return visit(record.text, depth + 1);
    }
    return null;
  };
  return visit(text, 0);
}

/**
 * A digest of one component's record in a snap: what verify --plan
 * compares to tell whether a later snap measured it again, as a later
 * push's snap of other components leaves it as it was.
 */
export function componentDigest(component: SnapComponent): string {
  return fnv1a32(canonicalJson(component));
}

/**
 * Whether the snap a plan was made from, `bytes` as it is now, has
 * changed for the plan: a component it built measured again or gone,
 * where the plan records their digests, else the file at all.
 */
export function planSnapChanged(plan: FigmaPlan, bytes: Uint8Array): boolean {
  if (fnv1a32Bytes(bytes) === plan.snap.digest) return false;
  const recorded = plan.snap.components;
  if (!recorded || !Object.keys(recorded).length) return true;
  let snap: SnapResult;
  try {
    snap = JSON.parse(Buffer.from(bytes).toString("utf8")) as SnapResult;
  } catch {
    return true;
  }
  const byKey = new Map((snap?.components ?? []).map((c) => [componentKey(c), c]));
  return Object.entries(recorded).some(([key, digest]) => {
    const component = byKey.get(key);
    return !component || componentDigest(component) !== digest;
  });
}

/** Reads plan.json. */
export function readPlan(path: string): FigmaPlan {
  const plan = JSON.parse(readFileSync(path, "utf8")) as FigmaPlan;
  if (plan?.version !== 1 || !Array.isArray(plan.calls)) throw new Error(`${path} is not a plan figma code wrote`);
  return plan;
}

/** A call's result file, parsed, or a thrown error saying what is missing. */
export function readCallResult(planPath: string, file: string, kind: string): Record<string, unknown> {
  const path = join(dirname(planPath), file);
  if (!existsSync(path)) throw new Error(`${path} is missing: save the call's response there, unchanged`);
  const result = parseCallResult(readFileSync(path, "utf8"));
  if (!result) throw new Error(`${path} holds no result a storysync call returns: save the response unchanged`);
  if (result.kind !== kind) throw new Error(`${path} holds a ${String(result.kind)} result, not the ${kind} result this call returns`);
  return result;
}

/**
 * Writes the continuation of a readback call whose result carries `more`,
 * as its next file (`07b`, then `07c`, ...), and returns it; null when the
 * last result in that call's chain needs none. Run again before its result
 * is saved, it returns the same file. A continuation whose result was read
 * before the result it continues, as a read call sent again leaves the
 * ones saved after it the time before, is written and returned again,
 * with `again`, for its result to be read now.
 */
export async function runFigmaNext(opts: { plan: string; seq: number; minify?: boolean; templates?: FigmaCodeOptions["templates"] }): Promise<{ file: string; result: string; description: string; again?: true } | null> {
  const plan = readPlan(opts.plan);
  const call = plan.calls.find((c) => c.seq === opts.seq);
  if (!call) throw new Error(`${opts.plan} has no call ${opts.seq}`);
  if (call.kind !== "read") throw new Error(`call ${pad(opts.seq)} is a ${call.kind} call: only a read call continues`);
  const dir = dirname(opts.plan);
  let suffix = "";
  let read = call.result;
  let result = readCallResult(opts.plan, read, "read");
  // The last time the chain so far was read at.
  let latest = readTimes(result)?.last ?? null;
  for (;;) {
    const more = result.more as { slices?: unknown } | undefined;
    if (!more) return null;
    const slices = more.slices;
    if (!Array.isArray(slices) || !slices.length || slices.some((s) => !Array.isArray(s) || s.length < 3 || s.length > 4 || typeof s[0] !== "string")) {
      throw new Error(`${read} has a "more" without the slices to continue from`);
    }
    // The read goes on through each index from a slice's first to its last,
    // so each is one of the call's own: a saved result that gave 0 to 1e15
    // had the next call loop in Figma until it was closed.
    const index = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    const asked = (s: unknown[]) => !call.slices || call.slices.some(([id, first, last]) => id === s[0] && first <= (s[1] as number) && (s[2] as number) <= last);
    if (slices.some((s: unknown[]) => !index(s[1]) || !index(s[2]) || (s.length === 4 && !index(s[3])) || (s[1] as number) > (s[2] as number) || !asked(s))) {
      throw new Error(`${read} has a "more" whose slices aren't within the ones call ${pad(call.seq)} read: send call ${pad(call.seq)} again and save its response unchanged`);
    }
    suffix = suffix ? String.fromCharCode(suffix.charCodeAt(0) + 1) : "b";
    if (suffix > "z") throw new Error(`call ${pad(opts.seq)} has continued more than 25 times`);
    const file = `calls/${pad(call.seq)}${suffix}-read-${pageSlug(call.page)}.js`;
    const resultFile = `results/${pad(call.seq)}${suffix}.json`;
    let again = false;
    if (existsSync(join(dir, resultFile))) {
      const saved = readCallResult(opts.plan, resultFile, "read");
      again = readBefore(saved, latest);
      if (!again) {
        read = resultFile;
        result = saved;
        const times = readTimes(saved);
        if (times) latest = Math.max(latest ?? -Infinity, times.last);
        continue;
      }
    }
    // The template and the limit the call it continues was written with: the
    // readable template, which keeps its first line, after `figma code --no-minify`.
    // The plan's first read carries it, and stored it in the file, where
    // the plan's reads run it from: so does a continuation.
    const text = (c?: PlanCall) => (c && existsSync(join(dir, c.file)) ? readFileSync(join(dir, c.file), "utf8") : "");
    const parent = text(call);
    const firstRead = plan.calls.find((c) => c.kind === "read");
    const carrier = text(firstRead);
    const template = loadTemplate("readback", opts.minify ?? !(carrier || parent).includes("// storysync readback, template"), opts.templates);
    // Stored by the first read, unless another storysync wrote that call:
    // one whose template isn't this install's is carried whole instead,
    // so a continuation after an upgrade still runs.
    const stored = carrier.includes(`figma.root.setSharedPluginData("storysync",${JSON.stringify(templateKey("readback"))},T);`)
      && carrier.includes(`const TSUM = ${JSON.stringify(fnv1a32(template))};`);
    const written = /\nconst LIMIT = (\d+);/.exec(parent);
    const limit = written ? Number(written[1]) : DEFAULT_READ_LIMIT + READ_GUARD_MARGIN;
    const ids = [...new Set((slices as [string][]).map((s) => s[0]))];
    const description = `Continue reading back ${ids.join(", ")} on page "${call.page}" (call ${pad(call.seq)}${suffix})`;
    const lastRead = plan.calls.filter((c) => c.kind === "read").pop();
    const carry = stored ? { kind: "readback", from: pad(firstRead!.seq), ...(lastRead?.seq === call.seq ? { clear: true as const } : {}) } : undefined;
    const code = readCode(call.seq, call.page, slices as [string, number, number, number][], limit, template, "figma next", carry).replace(`call ${pad(call.seq)}:`, `call ${pad(call.seq)}${suffix}:`);
    assertCompiles(code, file, "readback", template);
    assertWithinLimit(code, file);
    assertNoLinks(dir, file);
    writeFileSync(join(dir, file), code);
    return { file: join(dir, file), result: join(dir, resultFile), description, ...(again ? { again: true as const } : {}) };
  }
}
