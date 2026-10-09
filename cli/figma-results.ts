// Assembles the readback from what a push saved: each read call's response,
// written unchanged by the agent to the result path plan.json gives it.
//
// `storysync figma code` plans the push as calls the agent sends unchanged,
// saving each response unchanged (design D22). Then nobody writes
// figma-readback.json by hand: verify reads the saved responses itself,
// takes the entries out of them as the readback template sealed them, and
// writes the file, so there is no merge step for an agent to get wrong, and
// nothing an agent could fill in. An entry edited on the way still fails its
// checksum, as it always has.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { findToolValue } from "./figma.js";
import type { FigmaPlan } from "./tree-types.js";
import { READBACK_SCHEMA_VERSION } from "./verify.js";
import type { ReadbackFile, ReadbackStyles } from "./verify.js";

/**
 * One slice of a read call: a set's storysync id, the first and last
 * variant index `i` to read, and the record of the first variant to start
 * at, for a variant a call before read in part.
 */
export type ReadSlice = [componentId: string, firstI: number, lastI: number, firstNode?: number];

/** One set as a read call returns it (templates/readback.js). */
export interface ReadSet {
  /** The set's Figma id, every entry's checksum is sealed under. */
  id: string;
  /** Its Storybook id, from its storysync plugin data. */
  component: string;
  /** Its Storybook title, from its plugin data, or empty. */
  title: string;
  name: string;
  /** Every variant in the set, built by storysync or not. */
  total: number;
  /** Variants in the set without a slug: not built by storysync's element-tree build. */
  unbuilt: string[];
  /** Variant indexes in the slice the set has no variant for. */
  absent: number[];
  entries: Record<string, ReadbackStyles>;
}

/** What one read call returns. */
export interface ReadResult {
  kind: "read";
  tpl: number;
  page: string;
  sets: ReadSet[];
  /** The slices left when the call stopped at LIMIT: `storysync figma next` writes the call that reads them. */
  more?: { slices: ReadSlice[] };
}

/** The readback template's default LIMIT: entries a call returns, in characters, under use_figma's 20kb. */
export const READ_LIMIT = 14_000;

/**
 * The line the CLI writes ahead of templates/readback.js to make a read
 * call: the page to read on, the slices, and the characters to return at
 * most. The template is data-free, so this is all a read call carries.
 */
export function readbackHeader(page: string, slices: ReadSlice[], limit = READ_LIMIT): string {
  return `const PAGE = ${JSON.stringify(page)}, SLICES = ${JSON.stringify(slices)}, LIMIT = ${limit};\n`;
}

/** A read call's code: the header, then the template (readable or minified) as it is. */
export function readbackCall(template: string, page: string, slices: ReadSlice[], limit = READ_LIMIT): string {
  return readbackHeader(page, slices, limit) + template;
}

/**
 * Where the result of the call that continues `result` is saved: the read
 * call `NN` saves to results/NN.json, the one `storysync figma next` writes
 * for what it left to results/NNb.json, the next to NNc, and so on.
 */
export function continuationResult(result: string): string {
  const m = /^(.*?)(\d+)([a-z]?)\.json$/.exec(result);
  if (!m) throw new Error(`${result} is not a read result's path (results/NN.json)`);
  const next = m[3] ? String.fromCharCode(m[3].charCodeAt(0) + 1) : "b";
  if (next > "z") throw new Error(`${result} has no continuation after z`);
  return `${m[1]}${m[2]}${next}.json`;
}

function isReadResult(value: unknown): value is ReadResult {
  const v = value as Partial<ReadResult> | null;
  return v != null && typeof v === "object" && v.kind === "read" && Array.isArray(v.sets);
}

/**
 * The read result in what the agent saved: use_figma's text as it came, the
 * returned object as JSON, or that again as a JSON string, as the template
 * returns one should the tool not show objects (its RETURN_TEXT), or the
 * MCP result around it, `{ content: [{ type: "text", text }] }`. Null when
 * none of those holds one: the call failed, and the text is its error.
 */
export function parseReadResult(text: string): ReadResult | null {
  const found = findToolValue([text], isReadResult);
  if (found !== undefined) return found as ReadResult;
  try {
    const wrapper = JSON.parse(text) as { content?: { type?: string; text?: string }[] };
    const texts = (wrapper?.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text!);
    const inner = findToolValue(texts, isReadResult);
    return inner === undefined ? null : (inner as ReadResult);
  } catch {
    return null;
  }
}

/**
 * Adds a read result's entries to `readback`, as they were sealed: under
 * each set's title (else its Storybook id), the key verify scores a
 * component by, with the set's id as `nodeId`. Returns what it couldn't add:
 * a set read from two sets in different calls, or an entry read twice.
 */
export function addReadResult(readback: ReadbackFile, result: ReadResult, from = "a result"): string[] {
  const problems: string[] = [];
  for (const set of result.sets) {
    const key = set.title || set.component;
    const component = (readback.components[key] ??= { nodeId: set.id, variants: {} });
    if (component.nodeId !== set.id) {
      problems.push(`${from} reads ${key} from the set ${set.id}, another call from ${component.nodeId}: two sets carry its id`);
      continue;
    }
    for (const [slug, entry] of Object.entries(set.entries ?? {})) {
      if (component.variants[slug] !== undefined) {
        problems.push(`${from} reads ${key} ${slug} again; the first reading is kept`);
        continue;
      }
      component.variants[slug] = entry;
    }
  }
  return problems;
}

export interface PlanResults {
  readback: ReadbackFile;
  /** Planned read calls whose result, or a continuation of it, isn't saved or holds no read result, by seq. */
  notRead: number[];
  /** Where the assembled readback was written. */
  written: string;
  /** Why each of notRead wasn't read, and anything else that couldn't be assembled. */
  problems: string[];
}

/**
 * Reads every planned read call's saved result, and each continuation's
 * after it, into one readback, writes it beside the plan's directory as
 * figma-readback.json (`.storysync/figma-readback.json` for the default
 * `.storysync/figma/plan.json`), or to `out`, for committing and CI, and
 * returns it. Entries are copied as they were sealed; components and their
 * variants are written in key order, so the same results give the same
 * file.
 */
export function loadPlanResults(planPath: string, { out }: { out?: string } = {}): PlanResults {
  let plan: FigmaPlan;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8")) as FigmaPlan;
  } catch (err) {
    throw new Error(`Could not read the plan at ${planPath}: ${err instanceof Error ? err.message : String(err)}. Run \`storysync figma code\` first.`);
  }
  if (!Array.isArray(plan?.calls)) throw new Error(`${planPath} has no "calls": it is not a plan \`storysync figma code\` wrote`);
  const base = dirname(resolve(planPath));
  const readback: ReadbackFile = { version: READBACK_SCHEMA_VERSION, components: {} };
  const notRead: number[] = [];
  const problems: string[] = [];
  for (const call of plan.calls) {
    if (call.kind !== "read") continue;
    let result = call.result;
    for (;;) {
      const path = join(base, result);
      if (!existsSync(path)) {
        notRead.push(call.seq);
        problems.push(`call ${call.seq}: no result saved at ${relative(process.cwd(), path) || path}${result === call.result ? "" : ", where `storysync figma next` asks for one"}`);
        break;
      }
      const parsed = parseReadResult(readFileSync(path, "utf8"));
      if (!parsed) {
        notRead.push(call.seq);
        problems.push(`call ${call.seq}: ${result} holds no read result, so the call failed or its response wasn't saved as it came`);
        break;
      }
      problems.push(...addReadResult(readback, parsed, result));
      if (!parsed.more) break;
      result = continuationResult(result);
    }
  }
  const sorted: ReadbackFile = {
    version: readback.version,
    components: Object.fromEntries(Object.keys(readback.components).sort().map((key) => {
      const { nodeId, variants } = readback.components[key];
      return [key, { nodeId, variants: Object.fromEntries(Object.keys(variants).sort().map((slug) => [slug, variants[slug]])) }];
    })),
  };
  const written = out ?? join(base, "..", "figma-readback.json");
  mkdirSync(dirname(written), { recursive: true });
  writeFileSync(written, `${JSON.stringify(sorted, null, 2)}\n`);
  return { readback: sorted, notRead: [...new Set(notRead)], written, problems };
}
