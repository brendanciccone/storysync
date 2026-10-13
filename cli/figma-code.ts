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

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callCode, canonicalJson, fnv1a32Bytes } from "./checksum.js";
import { extractFirstBalancedObject } from "./figma.js";
import { Binder } from "./figma-bind.js";
import { planLayout } from "./figma-layout.js";
import type { LayoutChild, LayoutPlan } from "./figma-layout.js";
import { figmaSize, nodeStyle, outsideInsets, textSizesItself } from "./figma-map.js";
import type { BoundByDefault, FigmaStyle, MapContext, NotBuilt, Unbound } from "./figma-map.js";
import { READBACK_TPL, readBefore, readTimes, readbackCall } from "./figma-results.js";
import type { ReadSlice } from "./figma-results.js";
import { MAX_CALL_CHARS, MAX_UPLOADS_PER_CALL, SPIKE, USE_FIGMA_CODE_LIMIT } from "./figma-spike.js";
import type { Spike } from "./figma-spike.js";
import { describeVariantStories, parseMeasurementWarning } from "./snap.js";
import type { SnapComponent, SnapResult, SnapVariant } from "./snap.js";
import { applyDelta } from "./snap-normalize.js";
import { componentKey, selectComponents } from "./storybook.js";
import type { ComponentEntry } from "./storybook.js";
import type { TokenExtractionResult } from "./tokens.js";
import { expandTree, parentKey, rootWithStyles, transformedAround, treeDigest } from "./tree-types.js";
import type { Box, ComponentTree, FigmaPlan, PlanBinding, PlanCall, TreeDelta, TreeNode } from "./tree-types.js";
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
 * from scripts/build-templates.mjs) or the readable source.
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
  return readFileSync(path, "utf8").trim();
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
    const ctx: MapContext = { binder, notBuilt: findings.notBuilt, unbound: findings.unbound, byDefault: findings.byDefault, parentCls: parent?.cls, spike, around };
    const markup = node.svg ? tree.assets.svg[node.svg] : undefined;
    styleOf.set(node.k, nodeStyle(node, ctx, markup));
  }

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
    if (node.t === "T") return textSizesItself(node) || axis === 1 ? "H" : "X";
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
 * at the base variant's size saying why, never a guess at its looks.
 */
function compilePlaceholder(component: SnapComponentWithTree, variant: SnapVariantWithTree, index: number): CompiledVariant {
  const base = component.base!.styles;
  const [w, h] = [round2(Math.max(0.01, base.width)), round2(Math.max(0.01, base.height))];
  const text = `Not measured: ${unmeasuredReason(variant)}`;
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

function compileComponent(component: SnapComponentWithTree, binder: Binder, warnings: string[], spike: Spike): CompiledComponent | null {
  const key = componentKey(component);
  if (component.error || !component.base) {
    warnings.push(`${key}: not built: ${component.error ?? "snap measured no variant of it"}`);
    return null;
  }
  const findings: Findings = { notBuilt: [], unbound: [], byDefault: [], absolute: new Map() };
  const variants = component.variants.map((variant, i) => (variant.status === "ok"
    ? compileVariant(component, variant as SnapVariantWithTree, i, binder, findings, spike)
    : compilePlaceholder(component, variant as SnapVariantWithTree, i)));
  const placeholders = variants.filter((v) => !v.src).length;
  if (placeholders) warnings.push(`${key}: ${placeholders} variant${placeholders === 1 ? "" : "s"} built as a "Not measured" placeholder, since snap couldn't measure ${placeholders === 1 ? "it" : "them"}`);
  for (const [where, { slugs }] of findings.absolute) {
    warnings.push(`${key} › ${where}, so it is built without auto layout (${slugs.length === variants.length ? "every variant" : `${slugs.length} of ${variants.length} variants`})`);
  }
  // Each once: what isn't built, or what is built in its place.
  const notBuilt = new Set<string>();
  for (const n of findings.notBuilt) notBuilt.add(`${n.key || "(root)"}: ${n.what} ${n.as ? `is built as ${n.as}` : "is not built"}`);
  for (const line of notBuilt) warnings.push(`${key} › ${line}`);
  const unbound = new Map<string, Unbound>();
  for (const u of findings.unbound) unbound.set(`${u.property} ${u.value}`, u);
  for (const u of [...unbound.values()].sort((a, b) => `${a.property} ${a.value}`.localeCompare(`${b.property} ${b.value}`))) {
    warnings.push(`${key}: ${u.property} ${u.value} left unbound: ${u.why ?? `it matches ${u.candidates.join(", ")}, and no class names one`}`);
  }
  // Each value a base style bound, once, with the layers it bound in any
  // variant: the evidence for a binding no class shows.
  const bindings = new Map<string, PlanBinding>();
  for (const b of findings.byDefault) {
    const id = `${b.property} ${b.value}`;
    const was = bindings.get(id) ?? { component: key, property: b.property, value: b.value, variable: b.variable, from: b.from, keys: [] };
    if (!was.keys.includes(b.key)) was.keys = [...was.keys, b.key].sort();
    bindings.set(id, was);
  }
  return {
    key, id: component.id ?? key, title: component.title, name: setNameOf(component), page: pageOf(component),
    props: component.variantProperties, variants, note: labelLine(component),
    bindings: [...bindings.keys()].sort().map((k) => bindings.get(k)!),
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

function header(seq: number, kind: string, page: string): string {
  return `// storysync figma code, call ${pad(seq)}: ${kind}${page ? ` on page "${page}"` : ""}. Send this file unchanged as use_figma's code.\n`;
}

/**
 * The code of a build call over these parts, all on `page`. Each part's
 * variants are sent as changes to its first variant's records, so a variant
 * alone in a call carries its own records only.
 */
function buildCode(seq: number, page: string, parts: Part[], template: string): string {
  const table = new Table();
  const sets = parts.map(({ component, variants }) => {
    const base = intern(variants[0].records, table);
    return {
      id: component.id, title: component.title ?? "", name: component.name, props: component.props, base,
      v: variants.map((v) => [v.name, v.slug, v.i, v.src, v.digest, deltaOf(base, intern(v.records, table))]),
    };
  });
  return `${header(seq, "build", page)}${callCode([["DATA", { page, S: table.values, sets }]], template)}`;
}

const pad = (seq: number) => String(seq).padStart(2, "0");

/** A page's name as part of a file name. */
export function pageSlug(page: string): string {
  return page.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

function describeParts(parts: Part[]): string {
  return parts.map(({ component, variants }) => {
    const all = component.variants.length;
    if (variants.length === all) return `${component.name} (${all} variant${all === 1 ? "" : "s"})`;
    const first = component.variants.indexOf(variants[0]) + 1;
    const last = component.variants.indexOf(variants[variants.length - 1]) + 1;
    const span = last - first + 1 === variants.length ? `variants ${first}-${last}` : `${variants.length} variants of ${first}-${last}`;
    return `${component.name} (${first === last ? `variant ${first}` : span} of ${all})`;
  }).join(", ");
}

/** A readback call's slices, as plan.json lists them: [storysync id, first i, last i]. */
type Slice = [string, number, number];

function readCode(seq: number, page: string, slices: (Slice | [string, number, number, number])[], limit: number, template: string): string {
  const full = slices.map((s): ReadSlice => (s.length === 4 ? s : [...s, 0]));
  return `${header(seq, "read back", page)}${readbackCall(template, page, full, limit)}`;
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
  calls: /^\d{2,}[b-z]?-(?:build|images|label|read)(?:-[a-z0-9-]+)?\.js$/,
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
 * Writes plan.json and every call file for a push of `snap`, removing an
 * earlier plan's calls and results under `out` (clearPlanFiles). Two runs
 * over the same inputs write the same bytes.
 */
export async function runFigmaCode(opts: FigmaCodeOptions): Promise<{ plan: FigmaPlan; planPath: string; warnings: string[]; bindings: PlanBinding[] }> {
  const maxChars = opts.maxChars ?? MAX_CALL_CHARS;
  const spike: Spike = { ...SPIKE, ...opts.spike };
  const maxNodes = opts.maxNodes ?? spike.maxNodes;
  const readLimit = opts.readLimit ?? DEFAULT_READ_LIMIT;
  const minify = opts.minify ?? true;
  if (maxChars > USE_FIGMA_CODE_LIMIT) throw new Error(`--max-chars ${maxChars} is more than use_figma takes (${USE_FIGMA_CODE_LIMIT})`);
  const warnings: string[] = [];
  const bytes = readFileSync(opts.snap);
  const snap = JSON.parse(bytes.toString("utf8")) as SnapResult & { components: SnapComponentWithTree[] };
  const metaPath = join(dirname(opts.snap), "meta.json");
  const measuredAt = existsSync(metaPath) ? String((JSON.parse(readFileSync(metaPath, "utf8")) as { measuredAt?: string }).measuredAt ?? "") : "";
  const binder = new Binder(readTokens(opts.tokens, warnings));

  const all = (snap.components ?? []) as SnapComponentWithTree[];
  const entries = all.map((c): ComponentEntry => ({ id: c.id ?? componentKey(c), name: c.name, title: c.title }));
  const chosen = new Set(selectComponents(entries, opts.components));
  const skipped = opts.skip?.length ? new Set(selectComponents(entries, opts.skip, [], "--skip")) : new Set<ComponentEntry>();
  const picked = all.filter((_, i) => chosen.has(entries[i]) && !skipped.has(entries[i]));
  const rootOnly = picked.filter((c) => !c.error && c.base && !c.tree).map(componentKey);
  if (rootOnly.length) {
    throw new Error(
      `${opts.snap} has no element tree for ${rootOnly.join(", ")}: it was taken with --root-only, or before trees were measured. ` +
      "figma code builds from trees: take the snap again without --root-only, or build it with the skill's root-only templates.",
    );
  }
  const components = picked.map((c) => compileComponent(c, binder, warnings, spike)).filter((c): c is CompiledComponent => c !== null);
  if (!components.length) throw new Error("No component to build: snap measured none of those named, or each failed");

  const pages: string[] = [];
  for (const c of components) if (!pages.includes(c.page)) pages.push(c.page);
  const templates = {
    build: loadTemplate("build", minify, opts.templates),
    images: loadTemplate("images", minify, opts.templates),
    label: loadTemplate("label", minify, opts.templates),
    readback: loadTemplate("readback", minify, opts.templates),
  };

  const calls: (PlanCall & { code: string })[] = [];
  const add = (call: Omit<PlanCall, "seq" | "file" | "result" | "chars">, code: (seq: number) => string) => {
    const seq = calls.length + 1;
    const text = code(seq);
    const file = `calls/${pad(seq)}-${call.kind}${call.page ? `-${pageSlug(call.page)}` : ""}.js`;
    const kind = call.kind === "read" ? "readback" : call.kind;
    assertCompiles(text, file, kind, templates[kind]);
    calls.push({
      seq, kind: call.kind, page: call.page, components: call.components,
      file, result: `results/${pad(seq)}.json`,
      description: call.description, chars: text.length,
      ...(call.nodes !== undefined ? { nodes: call.nodes } : {}),
      ...(call.slices ? { slices: call.slices } : {}),
      ...(call.predicted !== undefined ? { predicted: call.predicted } : {}),
      code: text,
    });
  };

  // Builds: by page, each component's variants in snap order, packed. A
  // variant too big for one call on its own is left out, and the rest built.
  const tooBig = new Set<CompiledVariant>();
  for (const page of pages) {
    let parts: Part[] = [];
    const flush = () => {
      if (!parts.length) return;
      const done = parts;
      parts = [];
      const nodes = done.reduce((t, p) => t + p.variants.reduce((u, v) => u + v.records.length, 0), 0);
      add(
        { kind: "build", page, components: [...new Set(done.map((p) => p.component.key))], description: `Create or update ${describeParts(done)} on page "${page}"`, nodes },
        (seq) => buildCode(seq, page, done, templates.build),
      );
      const call = calls[calls.length - 1];
      if (call.chars > maxChars) warnings.push(`call ${pad(call.seq)} holds one variant of ${call.chars} characters, over --max-chars ${maxChars}`);
      if (nodes > maxNodes) warnings.push(`call ${pad(call.seq)} holds one variant of ${nodes} nodes, over --max-nodes ${maxNodes}`);
    };
    for (const component of components.filter((c) => c.page === page)) {
      for (const variant of component.variants) {
        const next = parts.map((p) => ({ ...p, variants: [...p.variants] }));
        const last = next[next.length - 1];
        if (last?.component === component) last.variants.push(variant);
        else next.push({ component, variants: [variant] });
        const nodes = next.reduce((t, p) => t + p.variants.reduce((u, v) => u + v.records.length, 0), 0);
        const images = new Set(next.flatMap((p) => p.variants.flatMap((v) => v.images))).size;
        if (nodes <= maxNodes && images <= MAX_UPLOADS_PER_CALL && buildCode(calls.length + 1, page, next, templates.build).length <= maxChars) {
          parts = next;
          continue;
        }
        // It starts a call of its own: over --max-chars or --max-nodes is
        // warned, and over what use_figma takes at all is left out.
        const alone: Part[] = [{ component, variants: [variant] }];
        const chars = buildCode(calls.length + 1, page, alone, templates.build).length;
        if (chars > USE_FIGMA_CODE_LIMIT) {
          tooBig.add(variant);
          warnings.push(
            `${component.key} ${variant.slug}: not built: its ${variant.records.length} nodes need ${chars} characters of code, ` +
            `more than one use_figma call takes (${USE_FIGMA_CODE_LIMIT}), and a variant is never split across calls`,
          );
          continue;
        }
        flush();
        parts = alone;
      }
    }
    flush();
  }
  // What is left to fill, label and read back: the variants built.
  for (const component of components) component.variants = component.variants.filter((v) => !tooBig.has(v));
  const built = components.filter((c) => c.variants.length);
  if (!built.length) throw new Error("No component to build: every variant is too big for one use_figma call");
  const builtPages = pages.filter((page) => built.some((c) => c.page === page));

  // Images: one call per page whose sets show one.
  for (const page of builtPages) {
    const shown = built.filter((c) => c.page === page && c.variants.some((v) => v.images.length));
    if (!shown.length) continue;
    add(
      { kind: "images", page, components: shown.map((c) => c.key), description: `Fill the image layers on page "${page}" with images already uploaded` },
      (seq) => `${header(seq, "images", page)}${callCode([["PAGE", page]], templates.images)}`,
    );
  }

  // Label: every set built, with a line for those snap measured from something else.
  const label = { pages: builtPages, sets: built.map((c) => [c.id, c.note]) };
  add(
    { kind: "label", page: "", components: built.map((c) => c.key), description: "Label the sets snap measured from something other than the component or from more than one story, and remove Figma's empty default page" },
    (seq) => `${header(seq, "label", "")}${callCode([["DATA", label]], templates.label)}`,
  );

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
        (seq) => readCode(seq, page, done.slices, readLimit + READ_GUARD_MARGIN, templates.readback),
      );
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

  const out = resolve(opts.out);
  clearPlanFiles(out);
  mkdirSync(join(out, "calls"), { recursive: true });
  mkdirSync(join(out, "results"), { recursive: true });
  for (const call of calls) writeFileSync(join(out, call.file), call.code);
  const plan: FigmaPlan = {
    version: 1, storysyncVersion: VERSION,
    snap: { path: relative(out, resolve(opts.snap)).split("\\").join("/"), measuredAt, digest: fnv1a32Bytes(bytes) },
    calls: calls.map(({ code: _code, ...call }) => call),
  };
  const bindings = built.flatMap((c) => c.bindings);
  if (bindings.length) plan.bindings = bindings;
  const planPath = join(out, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, planPath, warnings, bindings };
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
    // readable template, which keeps its comments, after `figma code --no-minify`.
    const parent = existsSync(join(dir, call.file)) ? readFileSync(join(dir, call.file), "utf8") : "";
    const template = loadTemplate("readback", opts.minify ?? !parent.includes("// storysync readback, template"), opts.templates);
    const written = /\nconst LIMIT = (\d+);/.exec(parent);
    const limit = written ? Number(written[1]) : DEFAULT_READ_LIMIT + READ_GUARD_MARGIN;
    const ids = [...new Set((slices as [string][]).map((s) => s[0]))];
    const description = `Continue reading back ${ids.join(", ")} on page "${call.page}" (call ${pad(call.seq)}${suffix})`;
    const code = readCode(call.seq, call.page, slices as [string, number, number, number][], limit, template).replace(`call ${pad(call.seq)}:`, `call ${pad(call.seq)}${suffix}:`);
    assertCompiles(code, file, "readback", template);
    writeFileSync(join(dir, file), code);
    return { file: join(dir, file), result: join(dir, resultFile), description, ...(again ? { again: true as const } : {}) };
  }
}
