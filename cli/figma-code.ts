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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, fnv1a32Bytes } from "./checksum.js";
import { extractFirstBalancedObject } from "./figma.js";
import { Binder } from "./figma-bind.js";
import { planLayout } from "./figma-layout.js";
import type { LayoutChild, LayoutPlan } from "./figma-layout.js";
import { figmaSize, nodeStyle, outsideInsets, textSizesItself } from "./figma-map.js";
import type { FigmaStyle, MapContext, NotBuilt, Unbound } from "./figma-map.js";
import { MAX_CALL_CHARS, MAX_UPLOADS_PER_CALL, SPIKE, USE_FIGMA_CODE_LIMIT } from "./figma-spike.js";
import type { Spike } from "./figma-spike.js";
import { parseMeasurementWarning } from "./snap.js";
import type { SnapComponent, SnapResult, SnapVariant } from "./snap.js";
import { applyDelta } from "./snap-normalize.js";
import { componentKey, selectComponents } from "./storybook.js";
import type { ComponentEntry } from "./storybook.js";
import type { TokenExtractionResult } from "./tokens.js";
import { expandTree, parentKey, rootWithStyles, treeDigest } from "./tree-types.js";
import type { Box, ComponentTree, FigmaPlan, PlanCall, TreeDelta, TreeNode } from "./tree-types.js";
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

export type TemplateName = "build" | "images" | "label" | "readback";

export const DEFAULT_READ_LIMIT = 14_000;

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
    const ctx: MapContext = { binder, notBuilt: findings.notBuilt, unbound: findings.unbound, parentCls: parent?.cls, spike };
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
        k: c.k, kind: c.t, box: layoutBox(c), abs: Boolean(c.abs), hidden: c.vis === 0,
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
  const findings: Findings = { notBuilt: [], unbound: [], absolute: new Map() };
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

/** The description line for a set snap measured from something other than the component, or "". */
function labelLine(component: SnapComponent): string {
  for (const warning of component.warnings ?? []) {
    const note = parseMeasurementWarning(warning);
    if (!note) continue;
    // No double quotes: Figma escapes them in a description (D20).
    const element = note.element.replace(/"/g, "");
    return note.kind === "closed-trigger"
      ? `measured from its closed trigger, ${element}, not the open ${component.name}`
      : `measured from ${element}, which may be the story's layout wrapper rather than ${component.name}`;
  }
  return "";
}

function compileComponent(component: SnapComponentWithTree, binder: Binder, warnings: string[], spike: Spike): CompiledComponent | null {
  const key = componentKey(component);
  if (component.error || !component.base) {
    warnings.push(`${key}: not built: ${component.error ?? "snap measured no variant of it"}`);
    return null;
  }
  const findings: Findings = { notBuilt: [], unbound: [], absolute: new Map() };
  const variants = component.variants.map((variant, i) => (variant.status === "ok"
    ? compileVariant(component, variant as SnapVariantWithTree, i, binder, findings, spike)
    : compilePlaceholder(component, variant as SnapVariantWithTree, i)));
  const placeholders = variants.filter((v) => !v.src).length;
  if (placeholders) warnings.push(`${key}: ${placeholders} variant${placeholders === 1 ? "" : "s"} built as a "Not measured" placeholder, since snap couldn't measure ${placeholders === 1 ? "it" : "them"}`);
  for (const [where, { slugs }] of findings.absolute) {
    warnings.push(`${key} › ${where}, so it is built without auto layout (${slugs.length === variants.length ? "every variant" : `${slugs.length} of ${variants.length} variants`})`);
  }
  const notBuilt = new Map<string, string>();
  for (const n of findings.notBuilt) notBuilt.set(`${n.key || "(root)"}: ${n.what}`, "");
  for (const what of notBuilt.keys()) warnings.push(`${key} › ${what} is not built`);
  const unbound = new Map<string, Unbound>();
  for (const u of findings.unbound) unbound.set(`${u.property} ${u.value}`, u);
  for (const u of [...unbound.values()].sort((a, b) => `${a.property} ${a.value}`.localeCompare(`${b.property} ${b.value}`))) {
    warnings.push(`${key}: ${u.property} ${u.value} left unbound: it matches ${u.candidates.join(", ")}, and no class names one`);
  }
  return {
    key, id: component.id ?? key, title: component.title, name: setNameOf(component), page: pageOf(component),
    props: component.variantProperties, variants, note: labelLine(component),
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

/** The code of a build call over these parts, all on `page`. */
function buildCode(seq: number, page: string, parts: Part[], template: string): string {
  const table = new Table();
  const sets = parts.map(({ component, variants }) => {
    const base = intern(component.variants[0].records, table);
    return {
      id: component.id, title: component.title ?? "", name: component.name, props: component.props, base,
      v: variants.map((v) => [v.name, v.slug, v.i, v.src, v.digest, deltaOf(base, intern(v.records, table))]),
    };
  });
  return `${header(seq, "build", page)}const DATA = ${JSON.stringify({ page, S: table.values, sets })};\n${template}\n`;
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
    return `${component.name} (variants ${first}-${first + variants.length - 1} of ${all})`;
  }).join(", ");
}

/** A readback call's slices, as plan.json lists them: [storysync id, first i, last i]. */
type Slice = [string, number, number];

function readCode(seq: number, page: string, slices: (Slice | [string, number, number, number])[], limit: number, template: string): string {
  const full = slices.map((s) => (s.length === 4 ? s : [...s, 0]));
  return `${header(seq, "read back", page)}const PAGE = ${JSON.stringify(page)};\nconst SLICES = ${JSON.stringify(full)};\nconst LIMIT = ${limit};\nconst TPL = 2;\n${template}\n`;
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
 * Writes plan.json and every call file for a push of `snap`, replacing an
 * earlier plan's calls and results under `out`: a result saved for an earlier
 * plan's call would otherwise be read as this plan's. Two runs over the same
 * inputs write the same bytes.
 */
export async function runFigmaCode(opts: FigmaCodeOptions): Promise<{ plan: FigmaPlan; planPath: string; warnings: string[] }> {
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
    calls.push({
      seq, kind: call.kind, page: call.page, components: call.components,
      file: `calls/${pad(seq)}-${call.kind}${call.page ? `-${pageSlug(call.page)}` : ""}.js`, result: `results/${pad(seq)}.json`,
      description: call.description, chars: text.length,
      ...(call.nodes !== undefined ? { nodes: call.nodes } : {}),
      ...(call.slices ? { slices: call.slices } : {}),
      ...(call.predicted !== undefined ? { predicted: call.predicted } : {}),
      code: text,
    });
  };

  // Builds: by page, each component's variants in snap order, packed.
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
      if (call.chars > USE_FIGMA_CODE_LIMIT) {
        throw new Error(`${describeParts(done)} needs ${call.chars} characters of code in one call, more than use_figma takes: a variant is never split across calls`);
      }
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
        const fits = nodes <= maxNodes && images <= MAX_UPLOADS_PER_CALL && buildCode(calls.length + 1, page, next, templates.build).length <= maxChars;
        if (fits || !parts.length) {
          parts = next;
        } else {
          flush();
          parts = [{ component, variants: [variant] }];
        }
      }
    }
    flush();
  }

  // Images: one call per page whose sets show one.
  for (const page of pages) {
    const shown = components.filter((c) => c.page === page && c.variants.some((v) => v.images.length));
    if (!shown.length) continue;
    add(
      { kind: "images", page, components: shown.map((c) => c.key), description: `Fill the image layers on page "${page}" with images already uploaded` },
      (seq) => `${header(seq, "images", page)}const PAGE = ${JSON.stringify(page)};\n${templates.images}\n`,
    );
  }

  // Label: every set built, with a line for those snap measured from something else.
  const label = { pages, sets: components.map((c) => [c.id, c.note]) };
  add(
    { kind: "label", page: "", components: components.map((c) => c.key), description: "Label the sets snap measured from something other than the component, and remove Figma's empty default page" },
    (seq) => `${header(seq, "label", "")}const DATA = ${JSON.stringify(label)};\n${templates.label}\n`,
  );

  // Reads: by page, slices of each set's variants packed by predicted size.
  for (const page of pages) {
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
    for (const component of components.filter((c) => c.page === page)) {
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
  rmSync(join(out, "calls"), { recursive: true, force: true });
  rmSync(join(out, "results"), { recursive: true, force: true });
  mkdirSync(join(out, "calls"), { recursive: true });
  mkdirSync(join(out, "results"), { recursive: true });
  for (const call of calls) writeFileSync(join(out, call.file), call.code);
  const plan: FigmaPlan = {
    version: 1, storysyncVersion: VERSION,
    snap: { path: relative(out, resolve(opts.snap)).split("\\").join("/"), measuredAt, digest: fnv1a32Bytes(bytes) },
    calls: calls.map(({ code: _code, ...call }) => call),
  };
  const planPath = join(out, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, planPath, warnings };
}

// --- Results ----------------------------------------------------------------

/**
 * The object a call returned, from its response saved unchanged: the tool's
 * text holding the returned object as JSON, that JSON once more as a string,
 * an MCP envelope of text parts, or text around it. Spike item 7 settles
 * which use_figma gives; each is read the same. Null when none holds an
 * object with a `kind`.
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
 * is saved, it returns the same file.
 */
export async function runFigmaNext(opts: { plan: string; seq: number; minify?: boolean; templates?: FigmaCodeOptions["templates"] }): Promise<{ file: string; result: string; description: string } | null> {
  const plan = readPlan(opts.plan);
  const call = plan.calls.find((c) => c.seq === opts.seq);
  if (!call) throw new Error(`${opts.plan} has no call ${opts.seq}`);
  if (call.kind !== "read") throw new Error(`call ${pad(opts.seq)} is a ${call.kind} call: only a read call continues`);
  const dir = dirname(opts.plan);
  let suffix = "";
  let result = readCallResult(opts.plan, call.result, "read");
  for (;;) {
    const more = result.more as { slices?: unknown } | undefined;
    if (!more) return null;
    const slices = more.slices;
    if (!Array.isArray(slices) || !slices.length || slices.some((s) => !Array.isArray(s) || s.length < 3 || s.length > 4 || typeof s[0] !== "string")) {
      throw new Error(`${call.result}${suffix} has a "more" without the slices to continue from`);
    }
    suffix = suffix ? String.fromCharCode(suffix.charCodeAt(0) + 1) : "b";
    if (suffix > "z") throw new Error(`call ${pad(opts.seq)} has continued more than 25 times`);
    const file = `calls/${pad(call.seq)}${suffix}-read-${pageSlug(call.page)}.js`;
    const resultFile = `results/${pad(call.seq)}${suffix}.json`;
    if (existsSync(join(dir, resultFile))) {
      result = readCallResult(opts.plan, resultFile, "read");
      continue;
    }
    const template = loadTemplate("readback", opts.minify ?? true, opts.templates);
    // The same limit the call it continues was written with.
    const written = existsSync(join(dir, call.file)) ? /\nconst LIMIT = (\d+);/.exec(readFileSync(join(dir, call.file), "utf8")) : null;
    const limit = written ? Number(written[1]) : DEFAULT_READ_LIMIT + READ_GUARD_MARGIN;
    const ids = [...new Set((slices as [string][]).map((s) => s[0]))];
    const description = `Continue reading back ${ids.join(", ")} on page "${call.page}" (call ${pad(call.seq)}${suffix})`;
    writeFileSync(join(dir, file), readCode(call.seq, call.page, slices as [string, number, number, number][], limit, template).replace(`call ${pad(call.seq)}:`, `call ${pad(call.seq)}${suffix}:`));
    return { file: join(dir, file), result: join(dir, resultFile), description };
  }
}
