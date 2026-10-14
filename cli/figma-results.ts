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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { callCode, callConstants } from "./checksum.js";
import type { CallWriter, TemplateCarry } from "./checksum.js";
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

/**
 * The readback template's default LIMIT, the bytes a read call returns at
 * most, under use_figma's 20kb and the template's own guard at 19,000.
 * `storysync figma code` packs each call's slices to a predicted 17,000
 * and writes this, 1,000 above, so a call stops short only where its
 * prediction was low. Section 9.1's 15,000 left the fifth live push's
 * reads at 10,700 to 12,700 bytes each, 12 calls each carrying the 8,000
 * character template; the sixth probe saw a response of 18,999 bytes come
 * back whole (fixtures/figma-tsum-probe.json, call 5). The seventh
 * (fixtures/figma-probe-7.json) saw what use_figma counts: the bytes of
 * the JSON it returns, not that JSON escaped again, up to 20,480. 18,999
 * characters, 30% of them quotes or backslashes, twice a read's share,
 * came back whole, as did 17,969 bytes half outside ASCII, which the
 * template counts at 19,000; 20,500 was refused, the call's changes not
 * kept.
 */
export const READ_LIMIT = 18_000;

/** The readback template this CLI writes calls for (templates/readback.js), which refuses a call for another. */
export const READBACK_TPL = 4;

/**
 * The lines the CLI writes ahead of templates/readback.js to make a read
 * call (design section 9.1): the page to read on, the slices, the bytes to
 * return at most, and the template the call is for, then SUM, their
 * checksum, which the call checks before the template reads anything
 * (checksum.ts, callCode). The template is data-free, so this is all a read
 * call carries. `storysync figma code` writes a call's header in this form,
 * one constant a line, and finds a call's LIMIT again by its line when it
 * writes the call that continues it.
 */
export function readbackHeader(page: string, slices: ReadSlice[], limit = READ_LIMIT): string {
  return callConstants(readbackConstants(page, slices, limit));
}

const readbackConstants = (page: string, slices: ReadSlice[], limit: number) =>
  [["PAGE", page], ["SLICES", slices], ["LIMIT", limit], ["TPL", READBACK_TPL]] as const;

/**
 * A read call's code: the header, then the template (readable or minified)
 * as it is, run as checksum.ts's callCode runs it, refusing a change as one
 * to the file `writer` wrote: `figma next` writes a continuation.
 */
export function readbackCall(template: string, page: string, slices: ReadSlice[], limit = READ_LIMIT, writer: CallWriter = "figma code", carry?: TemplateCarry): string {
  return callCode(readbackConstants(page, slices, limit), template, writer, carry);
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

/**
 * When a read result's entries were read, from their `readAt`: the first
 * and the last, as times. Null for a result with no entry that has one.
 */
export function readTimes(result: { sets?: unknown }): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const set of Array.isArray(result.sets) ? (result.sets as Partial<ReadSet>[]) : []) {
    for (const entry of Object.values(set?.entries ?? {})) {
      const at = typeof entry?.readAt === "string" ? Date.parse(entry.readAt) : NaN;
      if (!Number.isFinite(at)) continue;
      first = Math.min(first, at);
      last = Math.max(last, at);
    }
  }
  return Number.isFinite(first) ? { first, last } : null;
}

/**
 * Whether a continuation's result was read before the results it
 * continues, which were read up to `after`. A read call sent again after a
 * change in Figma leaves its continuations' results from the reading
 * before, and they hold Figma as it was: scored, they would pass a change
 * nobody read. A continuation is always sent after what it continues, so
 * one read earlier is one of those.
 */
export function readBefore(result: { sets?: unknown }, after: number | null): boolean {
  const times = readTimes(result);
  return after !== null && times !== null && times.first < after;
}

function isReadResult(value: unknown): value is ReadResult {
  const v = value as Partial<ReadResult> | null;
  return v != null && typeof v === "object" && v.kind === "read" && Array.isArray(v.sets);
}

/**
 * The read result in what the agent saved: use_figma's text as it came, the
 * returned object as JSON, which is what the spike saw the tool give (item
 * 7); or that again as a JSON string, as the template returns one with its
 * RETURN_TEXT on; or the MCP result around it, `{ content: [{ type: "text",
 * text }] }`. Null when none of those holds one: the call failed, and the
 * text is its error.
 */
export function parseReadResult(text: string): ReadResult | null {
  return resultIn(text, isReadResult) as ReadResult | null;
}

/** The value `is` takes in what the agent saved, read as parseReadResult reads a read result, or null. */
function resultIn(text: string, is: (value: unknown) => boolean): unknown {
  const found = findToolValue([text], is);
  if (found !== undefined) return found;
  try {
    const wrapper = JSON.parse(text) as { content?: { type?: string; text?: string }[] };
    const texts = (wrapper?.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text!);
    const inner = findToolValue(texts, is);
    return inner === undefined ? null : inner;
  } catch {
    return null;
  }
}

/** A build call's `fallbacks` entry: [component, key, what, variants]. */
type Fallback = [component: string, key: string, what: string, variants: number];

/**
 * The paints and shadows a build bound without their alpha variable, from
 * its saved response's `fallbacks`: each bound to its token at its opacity,
 * which Figma resets to 1 at a mode switch, or a shadow left unbound. A
 * readback can't see a binding, so verify says these beside the score.
 */
export function alphaFallbacks(text: string): Fallback[] {
  const result = resultIn(text, (v) => v != null && typeof v === "object" && (v as { kind?: unknown }).kind === "build") as { fallbacks?: unknown } | null;
  const list = Array.isArray(result?.fallbacks) ? (result!.fallbacks as unknown[]) : [];
  return list.filter((f): f is Fallback => Array.isArray(f) && typeof f[2] === "string" && /^(?:no alpha variable |\d+ alpha variables named )/.test(f[2]));
}

/**
 * Adds a read result's entries to `readback`, as they were sealed: under
 * each set's title (else its Storybook id), the key verify scores a
 * component by, with the set's id as `nodeId`; and, beside them, the set's
 * `total` and `unbuilt`, for verify to list the variants no read covered.
 * Returns what it couldn't add: a set read from two sets in different
 * calls, or an entry read twice.
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
    // Each call counts the whole set, so any one call's list is all of it:
    // the longest, should a variant have been added between calls, names
    // in order, two variants of one name twice.
    if (Number.isInteger(set.total)) component.total = Math.max(component.total ?? 0, set.total);
    if (Array.isArray(set.unbuilt) && set.unbuilt.length >= (component.unbuilt?.length ?? 0)) component.unbuilt = set.unbuilt.map(String).sort();
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
  /**
   * Planned read calls whose result, or a continuation of it, isn't saved,
   * holds no read result, or was read before the result it continues, by
   * seq.
   */
  notRead: number[];
  /** Where the assembled readback was written. */
  written: string;
  /** Why each of notRead wasn't read, and anything else that couldn't be assembled. */
  problems: string[];
  /**
   * Each build call's paints and shadows bound without their alpha variable,
   * as `call NN: component › key: what (N variants)`: they turn opaque at a
   * mode switch, which no readback shows.
   */
  alphaFallbacks: string[];
  /**
   * The alpha variables the plan's `variables` call made for components no
   * build with a result built, so nothing binds them, as `name (Collection):
   * made for ui/base/Alert, whose build call 04 saved no build result`.
   */
  unusedAlphas: string[];
}

/** Whether a saved response holds a build result: a build that threw, or wasn't sent, has none. */
function built(text: string): boolean {
  return resultIn(text, (v) => v != null && typeof v === "object" && (v as { kind?: unknown }).kind === "build") !== null;
}

/**
 * How much later a build call's result must have been saved than a read
 * call's for the read to be one from before that build: more than copying
 * or checking out the results folder spreads its files' times, and less
 * than sending a call and saving its response takes.
 */
const SAVED_AFTER_MS = 2000;

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
  const fellBack: string[] = [];
  // When each build's result and each read's first was saved: a read saved
  // before a build of its components was sent again read what that build
  // replaced.
  const builds: { seq: number; components: string[]; at: number }[] = [];
  const reads: { seq: number; components: string[]; at: number; result: string }[] = [];
  // Each component a build call built, and the calls that were to build the rest.
  const builtBy = new Set<string>();
  const failed = new Map<string, number[]>();
  for (const call of plan.calls) {
    if (call.kind !== "build") continue;
    const ok = existsSync(join(base, call.result)) && built(readFileSync(join(base, call.result), "utf8"));
    for (const c of call.components) {
      if (ok) builtBy.add(c);
      else failed.set(c, [...(failed.get(c) ?? []), call.seq]);
    }
  }
  const unusedAlphas: string[] = [];
  for (const alpha of plan.alphas ?? []) {
    if (!alpha.components?.length || alpha.components.some((c) => builtBy.has(c))) continue;
    const seqs = [...new Set(alpha.components.flatMap((c) => failed.get(c) ?? []))].sort((a, b) => a - b).map((n) => String(n).padStart(2, "0"));
    const name = `${alpha.variable}${alpha.collection ? ` (${alpha.collection})` : ""}: made for ${alpha.components.join(", ")}`;
    // A component no call builds, as one whose every variant was too big
    // for a call, has no call to name.
    unusedAlphas.push(seqs.length
      ? `${name}, whose build ${seqs.length === 1 ? "call" : "calls"} ${seqs.join(", ")} saved no build result`
      : `${name}, which no build call builds, so nothing binds it`);
  }
  for (const call of plan.calls) {
    if (call.kind === "build" && existsSync(join(base, call.result))) {
      builds.push({ seq: call.seq, components: call.components ?? [], at: statSync(join(base, call.result)).mtimeMs });
      for (const [component, key, what, variants] of alphaFallbacks(readFileSync(join(base, call.result), "utf8"))) {
        fellBack.push(`call ${String(call.seq).padStart(2, "0")}: ${component}${key ? ` › ${key}` : ""}: ${what} (${variants} ${variants === 1 ? "variant" : "variants"})`);
      }
    }
    if (call.kind !== "read") continue;
    let result = call.result;
    let previous = result;
    // The last time the chain so far was read at.
    let latest: number | null = null;
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
      // Left out, and what it reads with it: it is from before the reading it continues.
      if (result !== call.result && readBefore(parsed, latest)) {
        notRead.push(call.seq);
        problems.push(`call ${call.seq}: ${result} was read before ${previous}, which it continues, so it holds Figma as it was: \`storysync figma next\` asks for it again`);
        break;
      }
      if (result === call.result) reads.push({ seq: call.seq, components: call.components ?? [], at: statSync(path).mtimeMs, result });
      problems.push(...addReadResult(readback, parsed, result));
      const times = readTimes(parsed);
      if (times) latest = Math.max(latest ?? -Infinity, times.last);
      if (!parsed.more) break;
      previous = result;
      result = continuationResult(result);
    }
  }
  for (const read of reads) {
    const later = builds.filter((b) => b.at > read.at + SAVED_AFTER_MS && b.components.some((c) => read.components.includes(c)));
    if (!later.length) continue;
    const components = [...new Set(later.flatMap((b) => b.components.filter((c) => read.components.includes(c))))];
    const seqs = later.map((b) => b.seq).join(", ");
    const one = later.length === 1;
    problems.push(
      `call ${read.seq}: ${read.result} read ${components.join(", ")} before build ${one ? "call" : "calls"} ${seqs} ${one ? "was" : "were"} sent again (${one ? "its result was" : "their results were"} saved after it), ` +
      `so what it scores is Figma before ${one ? "that build" : "those builds"}, not now: send read call ${read.seq} again and save its response`,
    );
  }
  const sorted: ReadbackFile = {
    version: readback.version,
    components: Object.fromEntries(Object.keys(readback.components).sort().map((key) => {
      const { nodeId, total, unbuilt, variants } = readback.components[key];
      return [key, {
        nodeId,
        ...(total !== undefined ? { total } : {}),
        ...(unbuilt !== undefined ? { unbuilt } : {}),
        variants: Object.fromEntries(Object.keys(variants).sort().map((slug) => [slug, variants[slug]])),
      }];
    })),
  };
  const written = out ?? join(base, "..", "figma-readback.json");
  mkdirSync(dirname(written), { recursive: true });
  writeFileSync(written, `${JSON.stringify(sorted, null, 2)}\n`);
  return { readback: sorted, notRead, written, problems, alphaFallbacks: fellBack, unusedAlphas };
}
