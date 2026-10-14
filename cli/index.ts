#!/usr/bin/env node

import { existsSync, readFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient, selectComponents, findComponent } from "./storybook.js";
import { FigmaClient } from "./figma.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, requestLimit } from "./mcp-connect.js";
import { mapComponent, explainProp, parsePropNames, DEFAULT_MAX_COMBINATIONS } from "./mapper.js";
import { checkPropFlags, describeExclusions, describeUnseenArgTypes, exclusionReason, readSnapProps, snapPropSource } from "./props.js";
import type { PropExclusion, SnapProps } from "./props.js";
import { detectTokenSource, extractTokens, compareTokens, hasDrift, readTokenBaseline, baselineCommand, parseTokenSource } from "./tokens.js";
import { diffTokens, diffComponents, selectDiffComponents, narrowFigmaComponents, computeDiffSummary, hasDifferences, modesNotCompared } from "./diff.js";
import { describeFontStandIns, describeOpenedOverlays, describeVariantStories, runSnap, snapFailsStrict } from "./snap.js";
import { resolveAndLaunch } from "./snap-browser.js";
import { nameSlugs } from "./snap-args.js";
import { verify, loadJsonFile, formatFidelity, parseDuration, formatAge, readSnapAge, formatElementReport, treeStrictFailures, headlineFidelity } from "./verify.js";
import { DEFAULT_READ_LIMIT, describeEstimate, estimatePush, readPlan, runFigmaCode, runFigmaNext } from "./figma-code.js";
import { MAX_CALL_CHARS, SPIKE, USE_FIGMA_CODE_LIMIT } from "./figma-spike.js";
import { runFigmaUpload } from "./figma-upload.js";
import { DEFAULT_MAX_VARIABLES, runFigmaTokens } from "./figma-tokens.js";
import { loadPlanResults } from "./figma-results.js";
import { fnv1a32Bytes } from "./checksum.js";
import type { ReadbackFile, ReadbackIssue, ScoreCaveat, SnapAgeInfo } from "./verify.js";
import type { SnapResult } from "./snap.js";
import { runInit } from "./init.js";
import { runSetup, type Client } from "./setup.js";
import { VERSION } from "./version.js";
import { Progress, widenZeroWidthTerminal } from "./progress.js";
import type { TokenBaseline, TokenExtractionResult, TokenSourceType } from "./tokens.js";
import type { CapInfo } from "./mapper.js";
import type { FigmaVariable, FigmaComponentInfo } from "./figma.js";
import type { TokenDiffEntry, ComponentDiffEntry, CodeComponent } from "./diff.js";
import type { ComponentEntry } from "./storybook.js";

/**
 * How long to wait to connect to an MCP server before giving up on it, as
 * --connect-timeout's default. It is the 60 seconds the MCP SDK gives a
 * request, so a server that answered before still does. A Storybook that is
 * still starting refuses connections until it listens, which fails at once
 * rather than waiting, and the example's Storybook 10.6 answered initialize
 * within 25ms of its port opening. Each request once connected has
 * --request-timeout, DEFAULT_REQUEST_TIMEOUT_MS by default.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

/** --request-timeout's help, for the server or servers a command reads. */
const requestTimeoutHelp = (servers: string) =>
  `How long each request to ${servers} may take once connected, in milliseconds (default: ${DEFAULT_REQUEST_TIMEOUT_MS}, or --connect-timeout's when that is longer)`;

/**
 * Connects to a Storybook or Figma MCP server, or ends the run with exit code
 * 1 when it can't be reached. Under --json the reason is printed as JSON on
 * stdout, as reportError prints one, naming the server, since no spinner says
 * which failed. On stderr alone, a script piping the output to jq got nothing
 * to parse. It exits rather than returning, since a transport that failed to
 * connect can leave a reconnect timer running, and only after stdout has taken
 * the JSON: on a pipe the write can still be pending when the process exits.
 *
 * A server that takes the connection and never answers is unreachable too,
 * once `timeoutMs` has passed. Without a limit the run waited forever: the
 * Streamable HTTP initialize gives up after its request limit, but the SSE
 * fallback after it waits for its event stream with no limit at all.
 */
async function connectMcp<T extends { connect(): Promise<void> }>(client: T, server: string, url: string, json: boolean, timeoutMs: number): Promise<T> {
  const spinner = json ? null : ora(`Connecting to ${server}...`).start();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the server didn't answer within ${timeoutMs / 1000}s; raise --connect-timeout if it needs longer`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([client.connect(), deadline]);
    spinner?.succeed(`Connected to ${server}`);
    return client;
  } catch (err) {
    spinner?.fail(`Failed to connect to ${server}`);
    if (json) {
      const error = new Error(`Failed to connect to ${server} at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify({ error: String(error) })}\n`, () => resolve()));
    } else {
      console.error(chalk.red(String(err)));
    }
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

// Each request once connected has its own limit: a docs-show that never
// answers fails that component, naming the flag, rather than waiting on the
// SDK's own 60 seconds whatever the flags said.
function connectStorybook(url: string, json: boolean, { connectMs, requestMs }: McpTimeouts, cache = false): Promise<StorybookClient> {
  return connectMcp(new StorybookClient(url, { requestTimeoutMs: requestMs, connectTimeoutMs: connectMs, ...(cache ? {} : { cacheDir: null }) }), "Storybook MCP", url, json, connectMs);
}

const MAX_TIMER_MS = 2_147_483_647;

/** Parses a flag that takes milliseconds, exiting with a clear message on anything but a positive number of them. */
function parseTimeout(value: unknown, flag: string): number {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    console.error(chalk.red(`${flag} must be a positive number of milliseconds, received "${value}"`));
    process.exit(1);
  }
  // Node fires any longer timer after 1ms, which would fail every connect.
  if (ms > MAX_TIMER_MS) {
    console.error(chalk.red(`${flag} can be at most ${MAX_TIMER_MS} milliseconds (about 24 days), received "${value}"`));
    process.exit(1);
  }
  return ms;
}

interface McpTimeouts {
  /** --connect-timeout: how long connecting may take. */
  connectMs: number;
  /** --request-timeout: how long each request may take once connected. */
  requestMs: number;
}

/** Parses --connect-timeout and --request-timeout, a request's limit as requestLimit gives it. */
function parseTimeouts(opts: { connectTimeout?: unknown; requestTimeout?: unknown }): McpTimeouts {
  const connectMs = parseTimeout(opts.connectTimeout, "--connect-timeout");
  const requested = opts.requestTimeout === undefined ? undefined : parseTimeout(opts.requestTimeout, "--request-timeout");
  return { connectMs, requestMs: requestLimit(connectMs, requested) };
}

// Before any spinner starts: ora loops forever on a terminal reporting 0 columns.
widenZeroWidthTerminal();

const program = new Command();
program.name("storysync").description("Sync design tokens and Storybook components to Figma").version(VERSION);

/** Prints an error that ends a command: as JSON on stdout under --json, so the output still parses. */
function reportError(err: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify({ error: String(err) }));
  else console.error(chalk.red(`\n${err instanceof Error ? err.message : String(err)}`));
}

/**
 * Why verify left a readback entry unscored, as the rest of a line naming it.
 * Says what is wrong and how it came about, never what would have passed.
 */
function readbackIssueReason(issue: ReadbackIssue, snapAge: SnapAgeInfo): string {
  switch (issue.problem) {
    case "no_checksum":
      return "has no checksum, so it is not as the readback template returned it";
    case "no_node_id":
      return "has no nodeId on its component, the set's id its checksum is sealed under, so its checksum cannot be checked";
    case "duplicate_node_id":
      return `has a nodeId its component shares with ${(issue.sharedWith ?? []).join(", ")}, though every component is read back from a set of its own, so one component's entries were copied onto another`;
    case "checksum_mismatch":
      return "does not match its checksum, so it was edited, composed, or copied from another variant or component after Figma returned it";
    case "incomplete":
      return `is incomplete: it lacks ${(issue.missing ?? []).join(", ")}, which the readback template always returns, so the template was cut down`;
    case "stale":
      if (issue.readAt == null) return "is stale: it has no readAt, so when Figma read it is unknown";
      if (!Number.isFinite(Date.parse(issue.readAt))) return `is stale: its readAt (${issue.readAt}) is not a time, so when Figma read it is unknown`;
      return `is stale: Figma read it at ${issue.readAt}, before the snap was measured${issue.measuredAt ? ` at ${issue.measuredAt}` : snapAge.known ? ` at ${snapAge.measuredAt}` : ""}, so it is from an earlier run`;
    case "parts_missing":
      return "is one of the parts a variant was read in, and they don't add up: one is missing, repeated or out of order";
    case "name_mismatch":
      return `is sealed under the name "${issue.name}", not "${issue.expected}", the variant snap measured under this slug: a variant was renamed, or its slug moved onto another`;
  }
}

/** Caveats verify draws from what it compared, rather than from snap's warnings. */
const VERIFY_CAVEATS = new Set<ScoreCaveat["kind"]>(["root-only", "truncated-tree", "built-from-other-measurement"]);

/** Caveats said beside the score rather than warned: how snap measured, where nothing is wrong with it. */
const SAID_CAVEATS = new Set<ScoreCaveat["kind"]>(["variant-stories", "opened"]);

/** What a caveat beside verify's score says about its component, as the rest of a line naming it. */
function describeCaveat(caveat: ScoreCaveat): string {
  switch (caveat.kind) {
    case "closed-trigger":
      return `snap measured ${caveat.element}, a closed trigger, so this scores the trigger, not what it opens` +
        (caveat.reason ? `; snap didn't open it: ${caveat.reason}` : "");
    case "layout-wrapper":
      return `snap measured ${caveat.element}, which may be the story's layout wrapper rather than the component`;
    case "identical-variants":
      return "every variant measured the same, so the story may not pass its args through and this scores its default state";
    case "behavior-only": {
      const names = (caveat.properties ?? []).map((name) => `\`${name}\``).join(", ");
      const one = (caveat.properties ?? []).length === 1;
      return `every variant measured the same though the args reached it: ${names} ${one ? "changes" : "change"} nothing snap measures, so its variants in Figma look alike; \`--exclude-props ${(caveat.properties ?? []).join(",")}\` leaves ${one ? "it" : "them"} out`;
    }
    case "default-assumed": {
      const names = (caveat.properties ?? []).map((name) => `\`${name}\``).join(", ");
      return `Storybook's docs give no default for ${names}, so the default variant in Figma is a guess`;
    }
    case "args-rejected": {
      const count = caveat.variants ?? 0;
      return `Storybook wouldn't render ${(caveat.values ?? []).join(", ")}, so snap didn't measure ${count} ${count === 1 ? "variant" : "variants"} and nothing here scored ${count === 1 ? "it" : "them"}; snap's warning names the story change that lets it`;
    }
    case "args-unchecked": {
      const count = caveat.variants ?? 0;
      const one = count === 1;
      return `snap couldn't check that Storybook gave the story the values of ${one ? "variant" : `${count} variants,`} ${nameSlugs(caveat.slugs ?? [])}, so ${one ? "it" : "they"} may have scored the story's default under ${one ? "its name" : "their names"}; measure the component again`;
    }
    case "identical-values": {
      const values = caveat.values ?? [];
      const ticked = values.map((v) => `\`${v}\``);
      const list = ticked.length > 1 ? `${ticked.slice(0, -1).join(", ")} and ${ticked[ticked.length - 1]}` : ticked.join("");
      const property = values[0]?.split("=")[0] ?? "";
      return `${list} measured the same, so their variants in Figma look alike; if the code draws them differently, the story may not pass \`${property}\` through for them`;
    }
    case "no-op-properties": {
      const names = caveat.properties ?? [];
      const one = names.length === 1;
      return `every value of ${names.map((n) => `\`${n}\``).join(", ")} measured the same, so ${one ? "its" : "their"} variants in Figma look alike; if ${one ? "it changes" : "they change"} only behavior, \`--exclude-props ${names.join(",")}\` leaves ${one ? "it" : "them"} out`;
    }
    case "preview-set": {
      const count = caveat.variants ?? 0;
      const it = (caveat.values ?? []).length === 1 ? "it" : "them";
      return `the story's URL wouldn't take ${nameSlugs(caveat.values ?? [])}, so snap set ${it} through Storybook's preview and measured ${count} ${count === 1 ? "variant" : "variants"} as the component renders ${it}; snap's warning names the story change that lets the URL take ${it}`;
    }
    case "font-not-rendered": {
      const fonts = (caveat.fonts ?? []).map((f) => `"${f}"`).join(", ");
      return `the browser couldn't render ${fonts}, so snap measured the font it drew instead, and Figma was built from that; load the font in Storybook and measure again`;
    }
    case "snap-warning":
      return caveat.warning ?? "";
    case "variant-stories":
    case "opened":
      return caveat.note ?? "";
    case "root-only": {
      const inner = caveat.innerElements;
      return `only the outer element was measured and compared${inner !== undefined ? ` (${inner} inner ${inner === 1 ? "element" : "elements"} not measured)` : ""}`;
    }
    case "truncated-tree":
      return `snap stopped at ${caveat.nodes} elements, leaving out ${caveat.at} and what follows it, so those weren't measured or compared`;
    case "built-from-other-measurement": {
      const one = (caveat.variants ?? 0) === 1;
      return `Figma says ${one ? "variant" : `${caveat.variants} variants,`} ${nameSlugs(caveat.slugs ?? [])}, ${one ? "was" : "were"} built from other measurements than this snap's: the score says what Figma has, and re-sending the build calls brings ${one ? "it" : "them"} up to date`;
    }
  }
}

/** Parses --max-combinations, exiting with a clear message on anything but a positive integer. */
function parseMaxCombinations(value: unknown): number {
  return parsePositiveInteger(value, "--max-combinations");
}

/** Parses a flag that takes a positive whole number, exiting with a clear message on anything else. */
function parsePositiveInteger(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    console.error(chalk.red(`${flag} must be a positive whole number, received "${value}"`));
    process.exit(1);
  }
  return n;
}

/** Collects a flag given more than once, as `--stories a=x --stories b=y`. */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/**
 * Parses --stories: `component=storyId` pairs, comma-separated or given as
 * the flag more than once, a story ending in `!` kept so. Which component each names, and whether the
 * story is one of its own, runSnap checks against Storybook's list
 * (resolveStoryOverrides) before anything is measured; this refuses what
 * can't be a pair at all, before connecting, rather than measuring the
 * default story under a typo.
 */
function parseStories(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const pair of values.flatMap((v) => v.split(",")).map((p) => p.trim()).filter(Boolean)) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const story = pair.slice(at + 1).trim();
    // A story may end in `!`, to measure every variant from it.
    if (at < 0 || !name || !story.replace(/!$/, "").trim() || story.includes("=") || story.slice(0, -1).includes("!")) {
      throw new Error(`--stories takes component=storyId pairs, such as ui-base-button=ui-base-button--with-icon, received "${pair}"`);
    }
    if (seen.has(name.toLowerCase())) throw new Error(`--stories names "${name}" twice: give each component one story`);
    seen.add(name.toLowerCase());
    out[name] = story;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Parses --min-fidelity, a percentage from 0 to 100, with or without its
 * `%`: exits with a clear message on anything else, as a threshold that
 * can't be read must not pass every run.
 */
function parseMinFidelity(value: unknown): number {
  const text = String(value).trim().replace(/%$/, "");
  const pct = text === "" ? NaN : Number(text);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    console.error(chalk.red(`--min-fidelity must be a percentage from 0 to 100, such as 99 or 99.5, received "${value}"`));
    process.exit(1);
  }
  return pct;
}

/** A path as the user would type it: relative to where they are, unless it is somewhere else entirely. */
function shownPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** A share as a percentage, with as many decimals as it takes to tell it from a threshold beside it. */
function exactPercent(share: number): string {
  return `${Number((share * 100).toFixed(3))}%`;
}

/**
 * --exclude-props and --keep-props, parsed, refusing a name in both, with
 * a clear message under --json too.
 */
function parsePropFlags(opts: { excludeProps?: unknown; keepProps?: unknown }, json: boolean): { exclude: string[]; keep: string[] } {
  const exclude = parsePropNames(opts.excludeProps);
  const keep = parsePropNames(opts.keepProps);
  try {
    checkPropFlags(exclude, keep);
  } catch (err) {
    reportError(err, json);
    process.exit(1);
  }
  return { exclude, keep };
}

/**
 * The snap whose argTypes and exclusions map, inspect and diff read
 * (`--snap`, `.storysync/snaps` by default), or null with `--no-snap` or
 * none there. One that can't be read as JSON is an error.
 */
function readPropSnap(opts: { snap?: unknown }, json: boolean): SnapProps | null {
  if (opts.snap === false) return null;
  try {
    return readSnapProps(String(opts.snap ?? ".storysync/snaps"));
  } catch (err) {
    reportError(err, json);
    process.exit(1);
  }
}

const SNAP_OPTION_HELP = "Directory of the snap whose recorded argTypes and left-out props to use, as snap wrote them; --no-snap uses none";
const KEEP_PROPS_HELP = "Comma-separated prop names never to leave out on their own, in any component: not for what the story's argTypes mark as behavior, nor for snap measuring every value the same";

program
  .command("map")
  .description("Map all Storybook components to Figma variant definitions")
  .requiredOption("--storybook <url>", "Storybook URL")
  .option("--connect-timeout <ms>", "How long to wait to connect to Storybook MCP before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .option("--request-timeout <ms>", requestTimeoutHelp("Storybook MCP"))
  .option("--components <names>", "Comma-separated component names, titles or IDs; a name that matches nothing is an error")
  .option("--json", "Output JSON instead of formatted text")
  .option("--max-combinations <n>", "Most combinations to generate per component before capping", String(DEFAULT_MAX_COMBINATIONS))
  .option("--exclude-props <names>", "Comma-separated prop names never to map as variant properties, in any component")
  .option("--keep-props <names>", KEEP_PROPS_HELP)
  .option("--snap <dir>", SNAP_OPTION_HELP, ".storysync/snaps")
  .option("--no-snap", "Use no snap: see only what Storybook's docs list")
  .option("--no-cache", "Read every component's docs from Storybook, not from the docs cache in .storysync/cache")
  .option("--strict", "Exit with code 1 if any component fails or is capped")
  .action(async (opts) => {
    const json = !!opts.json;
    const maxCombinations = parseMaxCombinations(opts.maxCombinations);
    const flags = parsePropFlags(opts, json);
    const snap = readPropSnap(opts, json);
    const storybook = await connectStorybook(opts.storybook, json, parseTimeouts(opts), opts.cache !== false);
    try {
      const spinner = json ? null : ora("Reading components...").start();
      let entries: ComponentEntry[];
      try {
        entries = await storybook.listComponents();
      } catch (err) {
        spinner?.fail("Failed to read components");
        throw err;
      }
      spinner?.succeed(`Found ${entries.length} components`);

      // Entries whose stories name no component aren't mapped unless named.
      const pages = entries.filter((e) => e.docsOnly).length;
      // A typo'd name is an error whatever the flags. Filtered out silently,
      // map would exit 0 with an empty or partial mapping and CI go green.
      entries = selectComponents(entries, opts.components ? (opts.components as string).split(",") : undefined);
      if (!json && opts.components) console.log(chalk.dim(`  Filtered to ${entries.length}`));
      else if (!json && pages) console.log(chalk.dim(`  Skipped ${pages} ${pages === 1 ? "entry" : "entries"} whose stories name no component (see list)`));

      if (!entries.length) {
        if (json) console.log(JSON.stringify({ components: [], summary: { total: 0, mapped: 0, failed: 0, capped: 0, totalCombinations: 0 } }));
        else console.log(chalk.yellow("\nNo components found."));
        return;
      }

      // Each result carries the component's Storybook ID: unique where the
      // name, and a title rebuilt without Storybook's index, needn't be, and
      // what the Action matches a baseline's components by.
      const results: { id: string; name: string; title?: string; category?: string; variantProperties: { name: string; type: string; values: string[]; defaultValue: string }[]; combinations: number; capped: boolean; cap?: CapInfo; excludedProps?: PropExclusion[]; error: string | null }[] = [];
      let total = 0, capped = 0, failed = 0;
      // The components whose argTypes no snap recorded.
      const unseen: string[] = [];

      // Under --json nothing is printed until every component is read, which
      // takes minutes on a large library, so say which one the run is on (on
      // a terminal's stderr). Text mode prints a line as each one is read.
      const progress = json ? new Progress("map") : null;
      for (const entry of entries) {
        progress?.component(results.length + 1, entries.length, entry.title ?? entry.name);
        try {
          const source = snapPropSource(await storybook.getComponent(entry.id, entry.name, entry.title, entry.category), entry.id, snap, flags);
          if (!source.argTypes) unseen.push(entry.id);
          const def = mapComponent(source.component, maxCombinations);
          results.push({ id: entry.id, name: entry.name, title: entry.title, category: entry.category, variantProperties: def.variantProperties, combinations: def.variantCombinations.length, capped: def.wasCapped, ...(def.cap ? { cap: def.cap } : {}), ...(source.excluded.length ? { excludedProps: source.excluded } : {}), error: null });
          if (!json) {
            const info = def.variantProperties.map((p) => `${p.name}(${p.values.length})`).join(", ");
            const tag = def.cap ? chalk.yellow(` [CAPPED ${def.cap.generated}/${def.cap.totalPossible}]`) : "";
            const label = entry.title ?? entry.name;
            console.log(`  ${chalk.green("✓")} ${chalk.bold(label)} ${chalk.dim(info || "no variants")} -> ${def.variantCombinations.length} combination${def.variantCombinations.length === 1 ? "" : "s"}${tag}`);
            const left = describeExclusions(source.excluded);
            if (left) console.log(chalk.dim(`      ${left}`));
            if (def.cap) {
              const example = def.cap.droppedSample[0];
              const suffix = example ? `, e.g. ${JSON.stringify(example)}` : "";
              console.log(chalk.dim(`      ${def.cap.droppedCount} combinations not emitted${suffix}`));
            }
          }
          total += def.variantCombinations.length;
          if (def.wasCapped) capped++;
        } catch (err) {
          failed++;
          results.push({ id: entry.id, name: entry.name, title: entry.title, category: entry.category, variantProperties: [], combinations: 0, capped: false, error: String(err) });
          if (!json) console.log(`  ${chalk.red("✗")} ${chalk.bold(entry.title ?? entry.name)} ${chalk.red(String(err))}`);
        }
      }
      progress?.done();

      // Said once: which argTypes a command without a browser could see.
      const unseenNote = describeUnseenArgTypes(snap ? shownPath(snap.path) : null, unseen, entries.length - failed);
      if (json) {
        const props = { snap: snap ? shownPath(snap.path) : null, argTypesUnseen: unseen };
        console.log(JSON.stringify({ components: results, summary: { total: entries.length, mapped: entries.length - failed, failed, capped, totalCombinations: total }, props }));
      } else {
        if (unseenNote) console.log(chalk.dim(`\n${unseenNote}`));
        console.log(`\n${entries.length} components, ${total} total variants${capped ? `, ${capped} capped` : ""}`);
        console.log(chalk.dim("To write to Figma, use the Claude Code skill or Cursor rules file."));
      }

      if (opts.strict && (failed > 0 || capped > 0)) process.exitCode = 1;
    } catch (err) {
      // A failed listing (a server without the docs tools, or a tool that
      // answered with an error) ends the run with its reason, not a stack trace.
      reportError(err, json);
      process.exitCode = 1;
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("snap")
  .description("Measure each component variant's rendered styles and element tree from a running Storybook")
  .requiredOption("--storybook <url>", "Storybook URL")
  .option("--connect-timeout <ms>", "How long to wait to connect to Storybook MCP before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .option("--request-timeout <ms>", requestTimeoutHelp("Storybook MCP"))
  .option("--components <names>", "Comma-separated component names, titles or IDs; a name that matches nothing is an error")
  .option("--out <dir>", "Output directory", ".storysync/snaps")
  .option("--variants <mode>", "Which combinations to measure: representative or all", "representative")
  .option("--max-combinations <n>", "With --variants all, most combinations to measure per component before capping", String(DEFAULT_MAX_COMBINATIONS))
  .option("--exclude-props <names>", "Comma-separated prop names never to make variant properties, in any component; the story's own args set them")
  .option("--keep-props <names>", KEEP_PROPS_HELP)
  .option("--no-cache", "Read every component's docs from Storybook, not from the docs cache in .storysync/cache")
  .option("--screenshots", "Also save a PNG per variant (off by default)")
  .option("--timeout <ms>", "Per-story timeout in milliseconds; a story that times out loading is tried once more", "10000")
  .option("--selector <css>", "Measure the element this matches instead of choosing one")
  .option("--merge", "With --components, measure only those and merge them into the styles.json in --out, keeping the rest")
  .option("--root-only", "Measure each variant's outer element alone, without its element tree, as 0.3.0 did: for a push through the skill's root-only templates")
  .option("--no-channel-args", "Don't set the values Storybook won't take from the story's URL through its preview: leave those variants unmeasured, as arg_rejected (args_unsupported for a value no URL can carry)")
  .option("--no-open-overlays", "Measure an overlay's closed trigger as the story renders it, rather than opening the overlay (by its open or defaultOpen arg, or by clicking, hovering over, focusing or right-clicking the trigger) and measuring its content")
  .option("--stories <pairs>", "Comma-separated component=storyId pairs, each component by its ID or title and each story by its ID: the component's story, in place of the one snap picks, which measures every variant no other story's own args are for, or every variant where the story ends in ! (ui-base-toggle=ui-base-toggle--default!); a pair for a component the run doesn't measure is checked and left out (also given more than once)", collect)
  .option("--json", "Output JSON instead of formatted text")
  .option("--strict", "Exit with code 1 if any variant or component could not be measured, none were, a variant's args could not be checked, or a component was capped")
  .option("--strict-warnings", "Implies --strict, and also fails on warnings such as variants measuring identically")
  .action(async (opts) => {
    const json = !!opts.json;
    const variants = opts.variants as string;
    if (variants !== "representative" && variants !== "all") {
      console.error(chalk.red(`--variants must be "representative" or "all", received "${variants}"`));
      process.exit(1);
    }

    const timeoutMs = Number(opts.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      console.error(chalk.red(`--timeout must be a positive number of milliseconds, received "${opts.timeout}"`));
      process.exit(1);
    }
    const maxCombinations = parseMaxCombinations(opts.maxCombinations);
    const timeouts = parseTimeouts(opts);
    const flags = parsePropFlags(opts, json);
    // Without --components there is nothing to merge: the run measures
    // every component, which is the whole snap. As JSON under --json, as a
    // merge refused for its base is, since the push reads the reason there.
    if (opts.merge && !opts.components) {
      reportError(new Error("--merge measures the components --components names and keeps the rest of the snap in --out: name them with --components, or leave out --merge to measure every component"), json);
      process.exit(1);
    }
    let stories: Record<string, string> | undefined;
    try {
      stories = parseStories(opts.stories as string[] | undefined);
    } catch (err) {
      reportError(err, json);
      process.exit(1);
    }

    // Where the run is, on a terminal: a component with many variants can
    // take minutes, and under --json nothing else is printed until the end.
    const progress = new Progress("snap");
    // Playwright closes the browser on SIGTERM and SIGHUP but leaves the run
    // going, and snap then recorded every component left as a failed browser
    // session, wrote that over the last styles.json and exited 0. So a CI job
    // canceled, or an agent's command timed out, replaced a good snap with a
    // broken one. Stop instead, at once, writing nothing: not after a docs
    // request or a story still in flight, which can take --request-timeout
    // or --timeout. Exiting runs Playwright's exit handler, which kills the
    // browser, and removes the screenshots staged so far. These are the
    // run's only signal handlers, and come before Playwright's, so Ctrl-C
    // says the same and exits 130 rather than by Playwright's own handler.
    // Said on stderr, written at once since the process ends next, so a log
    // or an agent reading it knows the snap on disk is the last one.
    const left = opts.screenshots ? "styles.json, meta.json and the screenshots" : "styles.json and meta.json";
    const stop = (code: number) => (signal: NodeJS.Signals) => {
      progress.done();
      try {
        writeSync(2, `snap was stopped by ${signal} before it finished, so ${left} in ${opts.out} were left as they were.\n`);
      } catch {
        // A closed or full stderr: the exit code says it.
      }
      process.exit(code);
    };
    // 128 plus the signal's number, as a shell reports a process it killed.
    // Before connecting, so a run stopped while Storybook answers says so
    // too, and only until runSnap ends: by then it has written everything,
    // or stopped writing nothing, and a signal during the disconnect after
    // said it stopped before it finished.
    const handlers = [["SIGINT", stop(130)], ["SIGTERM", stop(143)], ["SIGHUP", stop(129)]] as const;
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const unlisten = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };

    const storybook = await connectStorybook(opts.storybook, json, timeouts, opts.cache !== false);
    try {
      const result = await runSnap(
        {
          storybookUrl: opts.storybook as string,
          components: opts.components ? (opts.components as string).split(",") : undefined,
          outDir: opts.out as string,
          screenshots: !!opts.screenshots,
          timeoutMs,
          selector: opts.selector as string | undefined,
          variants,
          maxCombinations,
          excludeProps: flags.exclude,
          keepProps: flags.keep,
          merge: !!opts.merge,
          rootOnly: !!opts.rootOnly,
          channelArgs: opts.channelArgs !== false,
          openOverlays: opts.openOverlays !== false,
          ...(stories ? { stories } : {}),
        },
        {
          storybook,
          launch: resolveAndLaunch,
          onProgress: json ? undefined : (m) => progress.print(() => console.log(m)),
          onComponentStart: (position, total, label) => progress.component(position, total, label),
          onVariantStart: (position, total) => progress.variant(position, total),
        },
      ).finally(unlisten);
      progress.done();

      if (json) {
        console.log(JSON.stringify(result));
      } else {
        const { summary } = result;
        console.log(`\n${summary.rendered}/${summary.variants} variants measured across ${summary.components} components`);
        console.log(chalk.dim(`  Styles written to ${opts.out}/styles.json`));
        const standIns = describeFontStandIns(result.fontStandIns);
        if (standIns) console.log(chalk.dim(`\n  i ${standIns}`));
        for (const component of result.components) {
          for (const warning of component.warnings) {
            console.log(chalk.yellow(`\n  ! ${component.title ?? component.name}: ${warning}`));
          }
        }
        for (const component of result.components.filter((c) => c.error != null)) {
          console.log(chalk.yellow(`\n  ✗ ${component.title ?? component.name}: ${component.error}`));
        }
        // Said, not warned: the stories each variant was measured from, where not the component's.
        for (const component of result.components) {
          const stories = describeVariantStories(component);
          if (stories) console.log(chalk.dim(`\n  i ${component.title ?? component.name}: ${stories}`));
        }
        // Said, not warned: the overlays snap opened to measure.
        for (const component of result.components) {
          const opened = describeOpenedOverlays(component);
          if (opened) console.log(chalk.dim(`\n  i ${component.title ?? component.name}: ${opened}`));
        }
        // Said, not warned: the props the story's argTypes add, and those left out, and why.
        for (const component of result.components) {
          const added = (component.argsNotInDocs ?? []).filter((name) => component.variantProperties.some((p) => p.name === name));
          if (added.length) {
            const names = added.map((name) => `\`${name}\``).join(", ");
            console.log(chalk.dim(`\n  i ${component.title ?? component.name}: the story's argTypes declare ${names}, which Storybook's docs don't list, so snap made ${added.length === 1 ? "it a variant property" : "them variant properties"}`));
          }
          const left = describeExclusions(component.excludedProps ?? []);
          if (left) console.log(chalk.dim(`\n  i ${component.title ?? component.name}: ${left}`));
        }
        const failed = result.components.flatMap((c) => c.variants.filter((v) => v.status !== "ok").map((v) => ({ c, v })));
        if (failed.length) {
          console.log(chalk.yellow(`\n  ${failed.length} variants not measured:`));
          for (const { c, v } of failed.slice(0, 10)) {
            console.log(chalk.dim(`    ${c.name} ${v.slug} [${v.status}] ${v.error ?? ""}`));
          }
          if (failed.length > 10) console.log(chalk.dim(`    ... and ${failed.length - 10} more`));
        }
      }

      // Warnings are deliberately outside plain --strict. A component whose
      // variants legitimately render identically (aliased option values, say)
      // would otherwise fail every build. But a story silently ignoring its
      // args is exactly the thing worth failing CI over, so --strict-warnings
      // makes that opt-in.
      const strict = !!opts.strict || !!opts.strictWarnings;
      const hasFailures = snapFailsStrict(result);
      const hasWarnings = result.summary.componentsWithWarnings > 0;

      if ((strict && hasFailures) || (opts.strictWarnings && hasWarnings)) {
        process.exitCode = 1;
      }
    } catch (err) {
      progress.done();
      reportError(err, json);
      process.exitCode = 1;
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("verify")
  .description("Compare what was written to Figma against the styles measured by snap")
  .option("--snap <path>", "Path to snap output; with --plan, the snap the plan was made from", ".storysync/snaps/styles.json")
  .option("--readback <path>", "Path to the properties read back from Figma; with --plan, where to write the readback assembled from its results (without this, figma-readback.json beside the plan's directory)", ".storysync/figma-readback.json")
  .option("--plan <path>", "Read back from the responses a push saved for the calls in this plan.json (storysync figma code): assemble them into --readback, then score it")
  .option("--tolerance <px>", "Allowed difference for lengths, in pixels", "0.5")
  .option("--max-age <duration>", "Warn when the snap is older than this (e.g. 30m, 2h, 7d)", "2h")
  .option("--skip <names>", "Comma-separated component names, titles or IDs to leave out of the score, such as ones not pushed; the output names them")
  .option("--roots-only", "Score each variant by its outer element alone, as 0.3.0 did, for comparison with an element-tree score")
  .option("--min-fidelity <pct>", "Exit with code 1 when the score is below this percentage: element fidelity where snap measured element trees, else the share of properties; a run that scored nothing fails it too")
  .option("--json", "Output JSON instead of formatted text")
  .option("--strict", "Exit with code 1 if any variant or element drifted or is missing from Figma, a keyed layer is in Figma that snap no longer measures, a variant reported nothing comparable or was read back without its element tree, a readback entry is not what Figma returned, is incomplete or was read before the snap, a text's layout snap measured wasn't read back, a planned read call wasn't read whole, a layer a designer added is inside a variant, or the snap recorded a component failure or lacks a component the readback has")
  .option("--allow-designer-layers", "With --strict, pass the layers a designer added inside variants, which verify still lists")
  .option("--strict-age", "Implies --strict, and also fails when the snap is older than --max-age")
  .option("--strict-measured", "Implies --strict, and also fails on anything not measured: variants inferred from source or with no recorded provenance, placeholders for variants snap couldn't measure, variants measured without snap checking Storybook gave them their values, and variants in Figma that snap never measured or no read covered")
  .action(async (opts, command: Command) => {
    const json = !!opts.json;
    const tolerance = Number(opts.tolerance);
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      console.error(chalk.red(`--tolerance must be a non-negative number, received "${opts.tolerance}"`));
      process.exit(1);
    }

    const maxAgeMs = parseDuration(opts.maxAge as string);
    if (maxAgeMs == null) {
      console.error(chalk.red(`--max-age must be a duration like 30m, 2h or 7d, received "${opts.maxAge}"`));
      process.exit(1);
    }
    const minFidelity = opts.minFidelity === undefined ? null : parseMinFidelity(opts.minFidelity);

    try {
      let snapPath = opts.snap as string;
      // With --plan, the readback is the responses the agent saved for its
      // read calls, assembled here: there is no file for anyone to write by
      // hand (design D22). It goes where --readback says when that is given,
      // and otherwise beside the plan's directory, so a plan made with
      // `figma code --out` elsewhere doesn't overwrite the push's readback.
      // The snap is the one the plan was made from, unless --snap says.
      let assembled: { readback: ReadbackFile; notRead: number[]; notReadSlices: [string, number, number][]; written: string; problems: string[]; alphaFallbacks: string[]; unusedAlphas: string[]; snapChanged: boolean; planPath: string } | null = null;
      if (opts.plan) {
        const planPath = opts.plan as string;
        const given = (name: string) => command.getOptionValueSource(name) === "cli";
        const loaded = loadPlanResults(planPath, given("readback") ? { out: opts.readback as string } : {});
        const plan = readPlan(planPath);
        if (!given("snap")) snapPath = resolve(dirname(planPath), plan.snap.path);
        // A snap taken again since the plan: the calls built and read what
        // the older one measured, so what it has since added wasn't read.
        const snapChanged = existsSync(snapPath) && fnv1a32Bytes(readFileSync(snapPath)) !== plan.snap.digest;
        // What the calls not read whole were to read: their variants are not read, not missing.
        const notReadSlices = plan.calls.filter((c) => c.kind === "read" && loaded.notRead.includes(c.seq)).flatMap((c) => c.slices ?? []);
        assembled = { ...loaded, notReadSlices, snapChanged, planPath };
      }
      const snap = loadJsonFile<SnapResult>(snapPath, "snap output");
      // A readback or meta.json passed as --snap, or a failed `snap --json`
      // captured as one, has no components list, and scoring it ended on a
      // bare TypeError. Say what the file is not, and what it holds instead.
      if (!Array.isArray(snap?.components)) {
        const error = (snap as { error?: unknown } | null)?.error;
        const held = typeof error === "string" ? ` It holds an error instead: ${error}` : "";
        throw new Error(`snap output at ${snapPath} has no "components" list, so it is not a styles.json written by \`storysync snap\`: pass that as --snap, and the Figma readback as --readback.${held}`);
      }
      const readback = assembled ? assembled.readback : loadJsonFile<ReadbackFile>(opts.readback as string, "Figma readback");
      // The snap's time first: an entry Figma read before it is stale.
      const snapAge = readSnapAge(snapPath, maxAgeMs);
      const skip = opts.skip ? (opts.skip as string).split(",") : undefined;
      const result = verify(snap, readback, tolerance, {
        ...(snapAge.known ? { measuredAt: snapAge.measuredAt, componentsMeasuredAt: snapAge.componentsMeasuredAt } : {}),
        skip,
        ...(opts.rootsOnly ? { rootsOnly: true } : {}),
        ...(assembled ? { notRead: assembled.notRead, notReadSlices: assembled.notReadSlices } : {}),
        allowDesignerLayers: !!opts.allowDesignerLayers,
      });
      result.snapAge = snapAge;
      // What --plan found assembling the readback, beside the score: a read
      // with no result, a set two sets claim, an entry read twice.
      const plan = assembled && {
        path: assembled.planPath,
        readback: assembled.written,
        problems: assembled.problems,
        ...(assembled.alphaFallbacks.length ? { alphaFallbacks: assembled.alphaFallbacks } : {}),
        ...(assembled.unusedAlphas.length ? { unusedAlphas: assembled.unusedAlphas } : {}),
        ...(assembled.snapChanged ? { snapChanged: true } : {}),
      };
      const headline = headlineFidelity(result);
      const belowMinimum = minFidelity !== null && (headline === null || headline < minFidelity / 100 - 1e-9);

      if (json) {
        // With --min-fidelity, what it was held to, so a CI reading the JSON
        // can tell that failure from a --strict one: both 0 to 1, as the score.
        const held = minFidelity === null ? {} : { minFidelity: { min: minFidelity / 100, score: headline, passed: !belowMinimum } };
        console.log(JSON.stringify({ ...result, ...(plan ? { plan } : {}), ...held }));
      } else {
        const { summary } = result;
        // Said on the score's own line, in so many words: a score over the
        // entries that were left must not be read as a score over all of
        // them. A trailing "excluded" after "100.0%" read as a clean pass to
        // anyone who stopped at the percentage, while the run exited 0.
        const excluded = summary.unverifiedReadback;
        const scope = excluded > 0 && result.fidelity != null ? " of verified entries" : "";
        const excludedNote = excluded > 0
          ? chalk.red(`; ${excluded} ${excluded === 1 ? "entry" : "entries"} unverified, not scored`)
          : "";
        // Beside the score, before the element report's drift: Figma can
        // match a measurement of the wrong element exactly, so the score
        // alone would read as a faithful one.
        const beside: string[] = [];
        if (result.skipped.length > 0) {
          beside.push(chalk.yellow(`  Left out of the score, as --skip asked: ${result.skipped.join(", ")}`));
        }
        const snapCaveats = result.caveats.filter((c) => !VERIFY_CAVEATS.has(c.kind) && !SAID_CAVEATS.has(c.kind));
        if (snapCaveats.length > 0) {
          beside.push(chalk.yellow(`  ! The score compares Figma with what snap measured, and snap warned about that for ${new Set(snapCaveats.map((c) => c.component)).size === 1 ? "this component" : "these components"}:`));
          for (const caveat of snapCaveats) beside.push(chalk.yellow(`      ${caveat.component}: ${describeCaveat(caveat)}`));
        }
        // Said, not warned: the variants snap measured from a story of their own, and the overlays it opened.
        for (const caveat of result.caveats.filter((c) => SAID_CAVEATS.has(c.kind))) {
          beside.push(chalk.dim(`  i ${caveat.component}: ${describeCaveat(caveat)}`));
        }
        // Elements first where snap measured them (cli/verify.ts formatElementReport).
        const elementReport = formatElementReport(result, beside);
        if (elementReport.length) for (const line of elementReport) console.log(line);
        else {
          console.log(`\nFidelity: ${chalk.bold(formatFidelity(result.fidelity))}${scope} ${chalk.dim(`(${summary.propertiesMatched}/${summary.propertiesCompared} properties)`)}${excludedNote}`);
          for (const line of beside) console.log(line);
        }
        // And what verify itself found the score covers: the components
        // compared by their outer element alone on one line, which on a
        // snap without trees is every one of them.
        const rootOnly = result.caveats.filter((c) => c.kind === "root-only");
        if (rootOnly.length > 0) {
          const names = rootOnly.map((c) => `${c.component}${c.innerElements ? ` (${c.innerElements} inner ${c.innerElements === 1 ? "element" : "elements"} not measured)` : ""}`);
          console.log(chalk.yellow(`  ! Only the outer element was measured and compared, for ${rootOnly.length === 1 ? "" : `${rootOnly.length} components: `}${names.join(", ")}`));
        }
        for (const caveat of result.caveats.filter((c) => VERIFY_CAVEATS.has(c.kind) && c.kind !== "root-only")) {
          console.log(chalk.yellow(`  ! ${caveat.component}: ${describeCaveat(caveat)}`));
        }
        // Beside the score too: a property snap measured and the readback
        // has no field for was never compared, and a title that runs past
        // its card scored 100% that way.
        if (result.uncompared.length > 0) {
          console.log(chalk.red("  ! Not compared, since the readback has no textLayout, as one read with a template from before it: how Figma fits the text snap measured the browser wrapped or cut off, on"));
          for (const u of result.uncompared) {
            console.log(chalk.red(`      ${u.component}, ${u.variants} ${u.variants === 1 ? "variant" : "variants"}`));
          }
          console.log(chalk.dim("      Read them back with the skill's readback template as it is now, which returns textLayout. A skill installed before it has none: `storysync setup --client <claude|cursor|codex> --force` installs the current one."));
        }
        const unscoredNote = summary.unscored > 0 ? `, ${summary.unscored} unscored` : "";
        const unverifiedNote = summary.unverifiedReadback > 0 ? `, ${summary.unverifiedReadback} with an unverified readback` : "";
        const notMeasuredNote = (summary.notMeasured ?? 0) > 0 ? `, ${summary.notMeasured} not measured` : "";
        const notReadNote = (summary.notRead ?? 0) > 0 ? `, ${summary.notRead} not read` : "";
        console.log(`${summary.verified} verified, ${summary.drifted} drifted, ${summary.missingFromFigma} missing from Figma${unscoredNote}${unverifiedNote}${notMeasuredNote}${notReadNote}, across ${summary.variants} variants\n`);

        for (const issue of result.snapIssues ?? []) {
          console.log(`  ${chalk.red("!")} snap recorded a failure: ${issue}`);
        }
        for (const component of result.componentsNotInSnap) {
          console.log(`  ${chalk.red("!")} ${component} is in the readback but not in the snap, so none of it was scored: another snap run measured it, or none did. Measure it into this snap with \`snap --components "${component}" --merge\`, or run the whole snap again.`);
        }
        for (const warning of result.snapWarnings ?? []) {
          console.log(`  ${chalk.yellow("!")} ${warning}`);
        }

        // Where the readback came from, under --plan, and what couldn't be
        // assembled into it: each a --strict failure, as a read with no
        // result leaves its variants unscored.
        if (plan) {
          console.log(chalk.dim(`  Read back from the results saved for ${shownPath(plan.path)}, assembled into ${shownPath(plan.readback)}`));
          for (const problem of plan.problems) console.log(`  ${chalk.red("!")} ${problem}`);
          if (plan.problems.length > 0) {
            console.log(chalk.dim("      Send each read call in plan.json and save its response unchanged to its result path, running `storysync figma next` for a result with `more`, then run verify again."));
          }
          if (plan.snapChanged) {
            console.log(`  ${chalk.yellow("!")} ${shownPath(snapPath)} has changed since \`storysync figma code\` made this plan from it, so the calls built and read what the earlier snap measured: run figma code again and send its calls.`);
          }
          // Not in the score, which no readback of a binding can show: each
          // turns opaque, or its shadow stays unbound, at a mode switch.
          if (plan.alphaFallbacks?.length) {
            console.log(`  ${chalk.red("!")} Bound without their alpha variable, so Figma makes them opaque when a designer switches a frame's mode, though the score can't show it:`);
            for (const line of plan.alphaFallbacks) console.log(chalk.red(`      ${line}`));
            console.log(chalk.dim("      Send the plan's variables call, its first, then those build calls again, and their read calls."));
          }
          // Made by the plan's first call for builds that then failed: no
          // layer binds them, and nothing else would say so.
          if (plan.unusedAlphas?.length) {
            console.log(`  ${chalk.yellow("!")} Alpha variables the plan made that no build with a result binds:`);
            for (const line of plan.unusedAlphas) console.log(chalk.yellow(`      ${line}`));
            console.log(chalk.dim("      Send those build calls again, or ask the user whether to remove each, with `storysync figma tokens --remove \"Collection/name\"` and its calls."));
          }
        }

        // Before the drift: an entry that is not what Figma returned, or not
        // all of it, or not now, says nothing about Figma as it is, so none of
        // it was scored, and the fix is to read it again rather than to change
        // anything in Figma.
        const readbackIssues = result.readbackIssues ?? [];
        for (const issue of readbackIssues) {
          console.log(`  ${chalk.red("!")} ${issue.component} ${chalk.dim(issue.slug)} readback entry ${readbackIssueReason(issue, snapAge)} — nothing in it was scored`);
        }
        if (readbackIssues.length > 0) {
          console.log(chalk.dim(plan
            ? "      Send their read calls in plan.json again, after the snap, and save each response unchanged to its result path. Never edit a saved response."
            : "      Read these variants back again, after the snap, with the skill's readback template as it is, and write each entry into the readback exactly as returned. Never fill one in from snap."));
        }

        for (const variant of result.variants) {
          // A variant scored element by element is in the element report,
          // and one whose readback has an issue is above, with the issue.
          // One not read is under the plan's problems, by its call.
          if (variant.status === "verified" || variant.status === "unverified_readback" || variant.status === "parts_missing" || variant.elements || variant.status === "not_measured" || variant.status === "not_read") continue;
          if (variant.status === "missing_from_figma") {
            console.log(`  ${chalk.yellow("?")} ${variant.component} ${chalk.dim(variant.slug)} not found in Figma`);
            continue;
          }
          if (variant.status === "unscored") {
            console.log(`  ${chalk.red("!")} ${variant.component} ${chalk.dim(variant.slug)} reported no comparable properties — nothing was scored`);
            continue;
          }
          console.log(`  ${chalk.red("~")} ${variant.component} ${chalk.dim(variant.slug)}`);
          for (const d of variant.differences) {
            console.log(chalk.dim(`      ${d.property}: measured ${JSON.stringify(d.measured)}, Figma ${JSON.stringify(d.figma)}`));
          }
        }

        // Only on a run that genuinely passed: a snap that recorded failures or
        // a run that compared nothing must not end on a green "matches".
        const cleanRun = !result.variants.some((v) => v.status !== "verified")
          && (result.snapIssues?.length ?? 0) === 0
          && result.componentsNotInSnap.length === 0
          && readbackIssues.length === 0
          && (plan?.problems.length ?? 0) === 0
          && treeStrictFailures(result, { allowDesignerLayers: true }).length === 0
          && result.summary.propertiesCompared > 0;
        // Not of a component with something measured left uncompared.
        const uncomparedComponents = new Set(result.uncompared.map((u) => u.component));
        const names = [...new Set(result.variants.map((v) => v.component))].filter((name) => !uncomparedComponents.has(name));
        if (cleanRun && names.length > 0) {
          // Name what was checked. On a clean run this is otherwise the only
          // output, and "it matches" is not much use without saying what did.
          // Only claim "measured" when everything actually was. Saying it of a
          // partly-inferred run is the conflation the provenance line exists
          // to prevent.
          const allMeasured = result.summary.inferred === 0
            && result.summary.unrecorded === 0
            && result.summary.unmeasured === 0
            && (result.summary.unread ?? 0) === 0;
          const kind = allMeasured ? "measured" : "expected";
          console.log(chalk.green(`  Figma matches the ${kind} styles for ${names.join(", ")}.`));
        }

        // Provenance before age: a component styled by guesswork matters more
        // than one measured a while ago, and this is the line that separates
        // "produced a result" from "produced a measured result".
        const { inferred, unrecorded, unmeasured } = result.summary;
        const unread = result.summary.unread ?? 0;
        if (inferred > 0 || unrecorded > 0 || unmeasured > 0 || unread > 0) {
          const parts: string[] = [];
          if (inferred > 0) parts.push(`${inferred} inferred from source rather than measured`);
          if (unrecorded > 0) parts.push(`${unrecorded} with no recorded provenance`);
          if (unmeasured > 0) parts.push(`${unmeasured} in Figma that snap never measured`);
          if (unread > 0) parts.push(`${unread} in Figma's sets that no read covered`);
          const line = `  Provenance: ${parts.join(", ")}`;
          console.log(opts.strictMeasured ? chalk.red(line) : chalk.yellow(line));
          for (const v of result.variants.filter((x) => x.source !== "measured" && x.status !== "missing_from_figma" && x.status !== "not_read")) {
            console.log(chalk.dim(`      ${v.component} ${v.slug} [${v.source}]`));
          }
          for (const u of result.unmeasuredInFigma) {
            console.log(chalk.dim(`      ${u.component} ${u.slug} [unmeasured — written to Figma but never scored]`));
          }
          for (const u of result.unreadInFigma ?? []) {
            for (const name of u.unbuilt) console.log(chalk.dim(`      ${u.component} ${name} [not built by storysync — in Figma's set but never scored]`));
            if (u.uncovered > 0) {
              const one = u.uncovered === 1;
              console.log(chalk.dim(`      ${u.component}: ${u.uncovered} ${one ? "variant carries a slug" : "variants carry slugs"} no read covered [built by an earlier push for ${one ? "a variant" : "variants"} snap no longer measures — never scored]`));
            }
          }
        }

        // Bindings, which no value shows: a token detached in Figma keeps
        // its value. Not a --strict failure, since the push leaves a value
        // unbound on purpose where several variables share it.
        const { bindings } = result;
        const scored = result.variants.filter((v) => v.status === "verified" || v.status === "drifted").length;
        if (bindings.read > 0) {
          console.log(chalk.dim(`  Variables: ${bindings.bound} ${bindings.bound === 1 ? "field" : "fields"} bound across ${bindings.read} ${bindings.read === 1 ? "variant" : "variants"}`));
          if (bindings.unbound.length > 0) {
            console.log(chalk.yellow("  ! Bound to no variable, though a variable of its kind has the value: a token detached in Figma, or one the push left unbound (its summary says which):"));
            for (const u of bindings.unbound) {
              console.log(chalk.yellow(`      ${u.component} ${u.field}, on ${u.variants} ${u.variants === 1 ? "variant" : "variants"}`));
            }
          }
        } else if (scored > 0) {
          // The element-tree readback (templates/readback.js) reads no
          // bindings yet; an older template's would, read again as it is now.
          const elementRead = Object.values(readback.components ?? {}).some((c) => Object.values(c?.variants ?? {}).some((e) => e?.tpl !== undefined));
          console.log(chalk.dim(elementRead
            ? "  Variables: the element-tree readback doesn't read variable bindings yet, so a token detached in Figma at the same value can't be seen."
            : "  Variables: this readback doesn't say what is bound, so a token detached in Figma at the same value can't be seen. Read it back with the skill's template as it is now."));
        }

        const age = result.snapAge;
        if (age?.known) {
          const line = `  Measured ${formatAge(age.ageMs)} ago${age.storybookUrl ? ` from ${age.storybookUrl}` : ""}`;
          if (age.stale) {
            console.log(chalk.yellow(`${line} — re-run \`storysync snap\` if the code has changed since.`));
          } else {
            console.log(chalk.dim(line));
          }
        } else if (age) {
          // Always say something. Printing nothing would let an unchecked age
          // pass for a checked one.
          const line = `  Snap age unknown: ${age.reason}`;
          console.log(opts.strictAge ? chalk.red(line) : chalk.dim(line));
        }

        // Last, so it is the line a CI log ends on when it is why the run failed.
        if (belowMinimum) {
          const scored = result.elementFidelity !== undefined ? "element fidelity" : "the share of properties";
          console.log(chalk.red(headline === null
            ? `  ! Nothing was scored, so there is no score to hold to --min-fidelity ${minFidelity}%`
            : `  ! The score, ${scored}, is ${exactPercent(headline)}: below --min-fidelity ${minFidelity}%`));
        }
      }

      const strict = !!opts.strict || !!opts.strictAge || !!opts.strictMeasured;
      // A variant Figma reported without any comparable property, and a run
      // that compared nothing at all, are both absent measurements rather than
      // passing ones — the same reasoning as an unknown snap age.
      const scoredNothing = result.summary.unscored > 0 || result.summary.propertiesCompared === 0;
      // A readback entry that is not what Figma returned is not a measurement
      // of Figma at all, whether it is missing its checksum or carries one
      // that does not match; nor is one cut down, or read before the snap, a
      // measurement of all of it now: absent is not a pass, as everywhere
      // above. Its own term, since the variants left can still have scored.
      // And a measured text layout the readback has no field for, which
      // was never compared: absent again.
      const hasDrift = result.summary.drifted > 0
        || result.summary.missingFromFigma > 0
        || scoredNothing
        || (result.snapIssues?.length ?? 0) > 0
        || result.componentsNotInSnap.length > 0
        || (result.readbackIssues?.length ?? 0) > 0
        || result.uncompared.length > 0
        || (plan?.problems.length ?? 0) > 0
        || (plan?.alphaFallbacks?.length ?? 0) > 0
        || treeStrictFailures(result, { allowDesignerLayers: !!opts.allowDesignerLayers }).length > 0;
      // Unrecorded counts as not-measured, for the same reason an unknown age
      // counts as stale: the absent state must not read as the good one. So
      // does a variant snap measured without knowing the story was given its
      // values, which may be the story's default under its name.
      const notMeasured = result.summary.inferred > 0
        || result.summary.unrecorded > 0
        || result.summary.unmeasured > 0
        || result.caveats.some((c) => c.kind === "args-unchecked")
        || (result.summary.notMeasured ?? 0) > 0
        || (result.summary.unread ?? 0) > 0;
      // An age that cannot be established is not a pass. `meta.json` is the
      // file most likely to be gitignored, so failing open here would make
      // --strict-age succeed unconditionally in exactly the CI setup the
      // determinism guarantee is designed to enable.
      const ageFailsStrict = !!opts.strictAge && (!result.snapAge?.known || result.snapAge.stale);

      if ((strict && hasDrift) || ageFailsStrict || (opts.strictMeasured && notMeasured) || belowMinimum) {
        process.exitCode = 1;
      }
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
    }
  });

// `storysync figma`: the push's use_figma calls as files, so the agent
// writes no styling code (design section 8.1). The CLI never calls Figma's
// tools itself: the agent sends each file unchanged and saves each response
// unchanged, and these read what it saved.
const figma = program
  .command("figma")
  .description("Write the use_figma calls that push the tokens' variables, and build and read back a snap's components, as files the agent sends unchanged");

figma
  .command("code")
  .description("Write plan.json and every use_figma call that builds, fills, labels and reads back the snap's components")
  .option("--snap <path>", "Path to snap output, with element trees", ".storysync/snaps/styles.json")
  .option("--tokens <path>", "`storysync tokens --json` output, for binding paints and radii to variables; without it nothing is bound", ".storysync/tokens.json")
  .option("--components <names>", "Comma-separated component names, titles or IDs to build (default: every component in the snap); a name that matches nothing is an error")
  .option("--skip <names>", "Comma-separated component names, titles or IDs to leave out")
  .option("--out <dir>", "Where plan.json, calls/ and results/ go; an earlier plan's calls and results there are removed", ".storysync/figma")
  .option("--max-chars <n>", `Most characters of code in one build call (use_figma takes at most ${USE_FIGMA_CODE_LIMIT})`, String(MAX_CALL_CHARS))
  .option("--max-nodes <n>", "Most layers one build call creates or restyles; lower it, to 200 say, after `Script exceeded time limit`", String(SPIKE.maxNodes))
  .option("--read-limit <n>", "Most characters a read call is predicted to return (use_figma returns at most 20kb)", String(DEFAULT_READ_LIMIT))
  .option("--no-minify", "Send the templates' readable sources instead of their minified build, for debugging")
  .option("--json", "Output JSON instead of formatted text")
  .action(async (opts) => {
    const json = !!opts.json;
    const maxChars = parsePositiveInteger(opts.maxChars, "--max-chars");
    const maxNodes = parsePositiveInteger(opts.maxNodes, "--max-nodes");
    const readLimit = parsePositiveInteger(opts.readLimit, "--read-limit");
    try {
      const { plan, planPath, warnings, bindings, alphas } = await runFigmaCode({
        snap: opts.snap as string,
        tokens: opts.tokens as string,
        components: opts.components ? (opts.components as string).split(",") : undefined,
        skip: opts.skip ? (opts.skip as string).split(",") : undefined,
        out: opts.out as string,
        maxChars,
        maxNodes,
        readLimit,
        minify: opts.minify !== false,
      });
      // What the push costs the agent, in tokens: the skills show it and ask before sending.
      const estimate = estimatePush(plan);
      if (json) {
        console.log(JSON.stringify({ planPath, calls: plan.calls, bindings, alphas, warnings, estimate }));
        return;
      }
      const where = shownPath(planPath);
      const counts = new Map<string, number>();
      for (const call of plan.calls) counts.set(call.kind, (counts.get(call.kind) ?? 0) + 1);
      const kinds = [...counts].map(([kind, n]) => `${n} ${kind}`).join(", ");
      console.log(`\n${plan.calls.length} use_figma ${plan.calls.length === 1 ? "call" : "calls"} (${kinds}), planned in ${where}`);
      for (const call of plan.calls) {
        const size = `${call.chars.toLocaleString("en-US")} characters${call.nodes !== undefined ? `, ${call.nodes} nodes` : ""}`;
        console.log(`  ${String(call.seq).padStart(2, "0")} ${call.kind.padEnd(Math.max(6, ...plan.calls.map((c) => c.kind.length)))} ${call.description} ${chalk.dim(`(${size})`)}`);
      }
      // What no class showed, and the project's base styles did: a text that
      // inherits body's color, a border that takes `*`'s.
      for (const b of bindings) {
        const layers = b.keys.map((k) => (k === "" ? "its root" : k)).join(", ");
        console.log(chalk.dim(`  = ${b.component}: ${b.property} ${b.value} bound to ${b.variable}, which no class names, by the base style ${b.from} (${layers})`));
      }
      for (const warning of warnings) console.log(chalk.yellow(`  ! ${warning}`));
      // A translucent paint binds to its token's alpha variable, which keeps
      // its opacity at a mode switch: the plan's first calls make them.
      if (alphas.length) {
        const first = plan.calls.filter((c) => c.kind === "variables").map((c) => String(c.seq).padStart(2, "0"));
        // A per-mode one holds another color in Dark, or none in Light.
        const perMode = alphas.filter((a) => a.darkToken !== undefined || a.alpha === 0).length;
        const modes = perMode ? `, and ${perMode === alphas.length ? (perMode === 1 ? "it holds" : "each holds") : `${perMode} of them hold`} the color a dark: class paints in Dark` : "";
        console.log(`\nTranslucent paints bind to ${alphas.length} alpha ${alphas.length === 1 ? "variable" : "variables"}, each a token's color at an alpha in every mode, which Figma keeps when a designer switches a frame's mode${modes}: ${alphas.map((a) => a.variable).join(", ")}.${first.length ? ` ${first.length === 1 ? "Call" : "Calls"} ${first.join(", ")} ${first.length === 1 ? "makes" : "make"} them, before the builds.` : ""}`);
      }
      console.log(`\n${describeEstimate(estimate)}`);
      console.log(chalk.dim("\nSend each call in seq order: its file unchanged as use_figma's code, with its description, and save the response unchanged to its result. After a build call with uploads, run `storysync figma upload`; after a read call whose result has `more`, run `storysync figma next`. Then `storysync verify --plan`."));
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
    }
  });

figma
  .command("upload")
  .description("Post the images a build call listed in its uploads to the URLs upload_assets gave, from the snap's thumbnails")
  .requiredOption("--plan <path>", "plan.json, as figma code wrote it")
  .requiredOption("--seq <n>", "The build call's seq, whose result lists the uploads and whose NN.upload.json holds upload_assets' response")
  .option("--json", "Output JSON instead of formatted text")
  .action(async (opts) => {
    const json = !!opts.json;
    const seq = parsePositiveInteger(opts.seq, "--seq");
    try {
      const { uploaded } = await runFigmaUpload({ plan: opts.plan as string, seq });
      if (json) {
        console.log(JSON.stringify({ uploaded }));
        return;
      }
      if (!uploaded.length) {
        console.log(`Call ${String(seq).padStart(2, "0")} listed no uploads: nothing to post.`);
        return;
      }
      for (const u of uploaded) console.log(`  ${chalk.green("✓")} ${u.assetId} to node ${u.nodeId} ${chalk.dim(`(${u.bytes.toLocaleString("en-US")} bytes)`)}`);
      console.log(`${uploaded.length} ${uploaded.length === 1 ? "image" : "images"} uploaded. The images call fills the other layers that show ${uploaded.length === 1 ? "it" : "them"}.`);
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
    }
  });

figma
  .command("next")
  .description("Write the call that continues a read call whose result has `more`, and print where it is and where its result goes")
  .requiredOption("--plan <path>", "plan.json, as figma code wrote it")
  .requiredOption("--seq <n>", "The read call's seq")
  .option("--json", "Output JSON instead of formatted text")
  .action(async (opts) => {
    const json = !!opts.json;
    const seq = parsePositiveInteger(opts.seq, "--seq");
    try {
      const next = await runFigmaNext({ plan: opts.plan as string, seq });
      if (json) {
        console.log(JSON.stringify({ next }));
        return;
      }
      if (!next) {
        console.log(`Call ${String(seq).padStart(2, "0")} has read everything it was given: nothing left to continue.`);
        return;
      }
      console.log(`Send ${next.file}`);
      console.log(`  description: ${next.description}`);
      // A read call sent again leaves its continuations from the reading before.
      if (next.again) console.log(`  ${shownPath(next.result)} was read before the result it continues, so it holds Figma as it was: send this again, and save its response over it.`);
      console.log(`  save its response unchanged to ${next.result}, then run this again: a result with \`more\` continues once more.`);
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
    }
  });

figma
  .command("tokens")
  .description("Write the use_figma calls that create or update a variable collection per token category, found by name, so a push sent again changes nothing")
  .option("--tokens <path>", "`storysync tokens --json` output", ".storysync/tokens.json")
  .option("--plan <path>", "The plan `figma code` wrote, whose translucent paints' alpha variables these calls make too; none until it exists", ".storysync/figma/plan.json")
  .option("--alpha <name>", "An alpha variable to make too, a color token at an alpha, as `destructive 30%` or `destructive 10% dark 20%`, as a root-only push binds one; repeat for each", collect)
  .option("--out <dir>", "Where plan.json, calls/ and results/ go; an earlier plan's calls and results there are removed", ".storysync/figma/tokens")
  .option("--remove <variable>", "A variable to remove, as Collection/name, as a response's stale or conflicts list it, once the user has confirmed; repeat for each", collect)
  .option("--max-variables <n>", "Most variables one call creates or updates; lower it after `Script exceeded time limit`", String(DEFAULT_MAX_VARIABLES))
  .option("--no-minify", "Send the template's readable source instead of its minified build, for debugging")
  .option("--json", "Output JSON instead of formatted text")
  .action((opts) => {
    const json = !!opts.json;
    const maxVariables = parsePositiveInteger(opts.maxVariables, "--max-variables");
    try {
      const { plan, planPath, collections, warnings } = runFigmaTokens({
        tokens: opts.tokens as string,
        plan: opts.plan as string,
        alpha: opts.alpha as string[] | undefined,
        out: opts.out as string,
        remove: opts.remove as string[] | undefined,
        maxVariables,
        minify: opts.minify !== false,
      });
      if (json) {
        console.log(JSON.stringify({ planPath, calls: plan.calls, alphas: collections.flatMap((c) => c.alphas ?? []), leftOut: plan.leftOut, warnings }));
        return;
      }
      const count = collections.reduce((n, c) => n + c.variables.length, 0);
      console.log(`\n${plan.calls.length} use_figma ${plan.calls.length === 1 ? "call" : "calls"} for ${count} variables in ${collections.length} ${collections.length === 1 ? "collection" : "collections"}, planned in ${shownPath(planPath)}`);
      for (const call of plan.calls) console.log(`  ${String(call.seq).padStart(2, "0")} ${call.description} ${chalk.dim(`(${call.chars.toLocaleString("en-US")} characters)`)}`);
      const alphas = collections.flatMap((c) => c.alphas ?? []);
      if (alphas.length) console.log(`  with the alpha variables translucent paints bind to, each a color token at an alpha in every mode: ${alphas.join(", ")}`);
      for (const t of plan.leftOut) console.log(chalk.yellow(`  ! ${t.category} ${t.name}: left out, ${t.why}`));
      for (const warning of warnings) console.log(chalk.yellow(`  ! ${warning}`));
      console.log(chalk.dim("\nSend each call in seq order: its file unchanged as use_figma's code, with its description, and save the response unchanged to its result. A response's `stale` lists variables no token has, and `conflicts` those that can't be their token's: ask the user before removing any, then run this again with `--remove <Collection/name>` for each they confirm, and send the calls again."));
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .description("List components in Storybook")
  .requiredOption("--storybook <url>", "Storybook URL")
  .option("--connect-timeout <ms>", "How long to wait to connect to Storybook MCP before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .option("--request-timeout <ms>", requestTimeoutHelp("Storybook MCP"))
  .option("--json", "Output JSON instead of formatted text")
  .action(async (opts) => {
    const json = !!opts.json;
    const storybook = await connectStorybook(opts.storybook, json, parseTimeouts(opts));
    try {
      const listed = await storybook.listComponents();
      if (json) {
        console.log(JSON.stringify({ components: listed.map((e) => ({ id: e.id, name: e.name, title: e.title, category: e.category, ...(e.titleDerived ? { titleDerived: true } : {}), ...(e.docsOnly ? { docsOnly: true } : {}), storyIds: e.storyIds ?? [] })) }));
        return;
      }
      const entries = listed.filter((e) => !e.docsOnly);
      const pages = listed.filter((e) => e.docsOnly);
      // Each by its title and ID, either of which --components and inspect
      // take: names alone left Base UI's Button and Radix's indistinguishable.
      console.log(`\n${entries.length} components:\n`);
      const line = (e: ComponentEntry) => {
        const count = e.storyIds?.length ?? 0;
        const stories = count ? chalk.dim(` (${count} ${count === 1 ? "story" : "stories"})`) : "";
        return `  ${e.title ?? e.name} ${chalk.dim(e.id)}${stories}`;
      };
      for (const e of entries) console.log(line(e));
      // Said, not hidden: what map, snap and diff skip, and why.
      if (pages.length) {
        console.log(`\n${pages.length} ${pages.length === 1 ? "entry" : "entries"} skipped, as Storybook's index shows ${pages.length === 1 ? "its" : "their"} stories name no component (no meta.component), so there is none to push; name one with --components to measure it anyway:\n`);
        for (const e of pages) console.log(line(e));
      }
      const derived = entries.filter((e) => e.titleDerived).length;
      if (derived) {
        console.log(chalk.dim(`\n${derived} ${derived === 1 ? "title was" : "titles were"} rebuilt from IDs, since Storybook's index.json couldn't be read or doesn't list them.`));
      }
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
    } finally {
      await storybook.disconnect();
    }
  });

/** `tokens --check`: compares an extraction, which may be empty, against the baseline. */
function checkTokens(
  result: TokenExtractionResult,
  opts: { baselinePath: string; project: string; source?: string; json: boolean; strict: boolean },
): void {
  const { baselinePath, json } = opts;
  const create = baselineCommand(baselinePath, { project: opts.project, source: opts.source });
  let baseline: TokenBaseline | null;
  try {
    baseline = readTokenBaseline(baselinePath);
  } catch (err) {
    reportError(new Error(`${err instanceof Error ? err.message : String(err)}. Recreate it with \`${create}\`.`), json);
    process.exitCode = 1;
    return;
  }

  // A missing baseline is an error whatever the flags, not a first run.
  // Treated as one, a wrong --baseline path would pass every run, --strict
  // included, having compared nothing.
  if (!baseline) {
    // Following the advice with nothing extracted would commit an empty
    // baseline, which the same mistake then matches on every run.
    const empty = result.collections.length
      ? ""
      : " No tokens were found either, so check --project and --source first, or the baseline will be empty.";
    const message =
      `No token baseline at ${baselinePath}, so there is nothing to check against. ` +
      `Create one with \`${create}\` and commit it, or point --baseline at the one you have.${empty}`;
    if (json) {
      // Still the full extraction, so the output parses as it always has.
      console.log(JSON.stringify({ drift: "new", error: message, ...result, summary: { totalTokens: result.collections.reduce((s, c) => s + c.tokens.length, 0), collections: result.collections.length } }));
    } else {
      console.error(chalk.red(`\n${message}`));
    }
    process.exitCode = 1;
    return;
  }

  const drift = compareTokens(baseline, result);
  // A baseline from before the dark theme was read: its dark values weren't
  // compared, which the check says rather than pass as though they were.
  const darkNote = `The baseline at ${baselinePath} was written by a storysync that didn't read the dark theme, so the tokens' dark values weren't compared. Recreate it with \`${create}\` to check them.`;
  if (!hasDrift(drift)) {
    if (json) console.log(JSON.stringify({ drift: false, ...(drift.darkNotChecked ? { darkNotChecked: true } : {}) }));
    else {
      console.log(chalk.green("\nNo token drift detected."));
      if (drift.darkNotChecked) console.log(chalk.dim(darkNote));
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify({ drift: true, added: drift.added, removed: drift.removed, changed: drift.changed, ...(drift.darkNotChecked ? { darkNotChecked: true } : {}) }));
  } else {
    console.log(chalk.red("\nToken drift detected:\n"));
    for (const a of drift.added) {
      console.log(`  ${chalk.green("+")} ${a.category}: ${a.tokens.map((t) => t.name).join(", ")}`);
    }
    for (const r of drift.removed) {
      console.log(`  ${chalk.red("-")} ${r.category}: ${r.tokens.map((t) => t.name).join(", ")}`);
    }
    for (const c of drift.changed) {
      console.log(`  ${chalk.yellow("~")} ${c.category}/${c.token}${c.mode ? ` (${c.mode})` : ""}: ${c.from} → ${c.to}`);
    }
    if (drift.darkNotChecked) console.log(chalk.dim(`\n${darkNote}`));
    // A newer storysync can read tokens an older one left out, shadcn/ui's
    // radius scale say, which a baseline the older one wrote lists as added.
    const why = drift.removed.length || drift.changed.length
      ? "If the change is intended"
      : "If the tokens are new, or this storysync reads tokens the one that wrote the baseline didn't";
    console.log(chalk.dim(`\n${why}, update the baseline with \`${create}\`.`));
  }
  if (opts.strict) process.exitCode = 1;
}

program
  .command("tokens")
  .description("Extract design tokens from project source and preview Figma variable collections")
  .option("--project <path>", "Project root to scan", ".")
  .option("--source <type>", "Token source: tailwind, css, or theme (auto-detect if omitted or auto); any other value is an error")
  .option("--json", "Output JSON instead of formatted text")
  .option("--all", "Show all tokens instead of truncating")
  .option("--check", "Compare against baseline and detect drift; a missing baseline is an error")
  .option("--baseline <path>", "Path to token baseline JSON, as written by tokens --json", ".storysync/tokens-baseline.json")
  .option("--strict", "Exit with code 1 if no tokens found or drift detected")
  .action(async (opts) => {
    const json = !!opts.json;
    const projectPath = opts.project as string;

    // Before anything is detected or read: an unknown --source used to fall
    // through to detection, and the run passed having read another source.
    let source: TokenSourceType | undefined;
    try {
      source = parseTokenSource(opts.source as string | undefined);
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
      return;
    }

    // --check reads its baseline whatever the extraction found. Finding no
    // tokens (a mistyped --project, say) is not a pass: a missing baseline is
    // still an error, and against one that exists, every token it holds was
    // removed.
    let detected = true;
    // Detection names the source only when --source leaves it to detection:
    // with --source tailwind, it said "Detected: css" and then listed @theme.
    if (!json && !source) {
      const spinner = ora("Detecting token source...").start();
      const detection = detectTokenSource(projectPath);
      if (detection) {
        spinner.succeed(`Detected: ${detection.type} (${detection.path})`);
      } else {
        spinner.fail("No token source found");
        detected = false;
        if (!opts.check) {
          if (opts.strict) process.exitCode = 1;
          return;
        }
      }
    }

    const result = extractTokens(projectPath, source);
    const found = result.collections.length > 0;
    if (!json && source && result.sourcePath) ora().succeed(`Source: ${source} (${result.sourcePath}), from --source`);

    if (!found) {
      if (opts.strict) process.exitCode = 1;
      if (!json && detected) {
        console.log(chalk.yellow("\nNo tokens found."));
        for (const w of result.warnings) console.log(chalk.dim(`  ${w}`));
      }
    }

    if (opts.check) {
      checkTokens(result, {
        baselinePath: opts.baseline as string,
        project: projectPath,
        source,
        json,
        strict: !!opts.strict,
      });
      return;
    }

    if (!found) {
      if (json) console.log(JSON.stringify({ source: result.source, sourcePath: result.sourcePath, modes: result.modes, collections: [], warnings: result.warnings, summary: { totalTokens: 0, collections: 0 } }));
      return;
    }

    // Default: pretty-print discovered tokens
    const totalTokens = result.collections.reduce((sum, c) => sum + c.tokens.length, 0);
    const darkTokens = result.collections.reduce((sum, c) => sum + c.tokens.filter((t) => t.dark).length, 0);

    if (json) {
      console.log(JSON.stringify({
        source: result.source,
        sourcePath: result.sourcePath,
        // Always written, so a baseline says it was read for the dark theme.
        modes: result.modes,
        collections: result.collections,
        ...(result.defaults ? { defaults: result.defaults } : {}),
        warnings: result.warnings,
        summary: { totalTokens, collections: result.collections.length },
      }));
    } else {
      console.log("");
      for (const collection of result.collections) {
        console.log(`  ${chalk.bold(collection.category)} ${chalk.dim(`(${collection.tokens.length} tokens)`)}`);
        const shown = opts.all ? collection.tokens : collection.tokens.slice(0, 8);
        for (const token of shown) {
          // The px a FLOAT variable gets, when the value doesn't say it already.
          const px = token.px === undefined || token.value === `${token.px}px` ? "" : ` = ${token.px}px`;
          const dark = token.dark ? `   dark: ${token.dark.value}${token.dark.px === undefined || token.dark.value === `${token.dark.px}px` ? "" : ` = ${token.dark.px}px`}` : "";
          console.log(`    ${token.name.padEnd(24)} ${chalk.dim(token.value + px + dark)}`);
        }
        if (!opts.all && collection.tokens.length > 8) {
          console.log(chalk.dim(`    ... and ${collection.tokens.length - 8} more (use --all to show)`));
        }
      }
      console.log(`\n${totalTokens} tokens in ${result.collections.length} collections`);
      // Figma gets a Dark mode for them, the rest taking their light value there.
      if (darkTokens) console.log(`${darkTokens} with a dark theme value, for a Dark mode beside Light`);
      if (result.warnings.length) {
        console.log(chalk.dim(`\nWarnings:`));
        for (const w of result.warnings) console.log(chalk.dim(`  ${w}`));
      }
      console.log(chalk.dim("To create Figma variables, use the Claude Code skill or Cursor rules file."));
    }
  });

program
  .command("inspect")
  .description("Show how a component's props map to Figma variants")
  .requiredOption("--storybook <url>", "Storybook URL")
  .requiredOption("--component <name>", "Component name, title or ID; a name that matches nothing, or several, is an error")
  .option("--connect-timeout <ms>", "How long to wait to connect to Storybook MCP before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .option("--request-timeout <ms>", requestTimeoutHelp("Storybook MCP"))
  .option("--exclude-props <names>", "Comma-separated prop names to leave out, as map and snap take them")
  .option("--keep-props <names>", KEEP_PROPS_HELP)
  .option("--snap <dir>", SNAP_OPTION_HELP, ".storysync/snaps")
  .option("--no-snap", "Use no snap: see only what Storybook's docs list")
  .option("--no-cache", "Read the component's docs from Storybook, not from the docs cache in .storysync/cache")
  .action(async (opts) => {
    const flags = parsePropFlags(opts, false);
    const snap = readPropSnap(opts, false);
    const storybook = await connectStorybook(opts.storybook, false, parseTimeouts(opts), opts.cache !== false);
    try {
      // A name that matches nothing fails here, naming what exists, before
      // asking Storybook for the documentation of a component it never listed.
      const entry = findComponent(await storybook.listComponents(), opts.component as string);
      const docs = await storybook.getComponent(entry.id, entry.name, entry.title, entry.category);
      const source = snapPropSource(docs, entry.id, snap, flags);
      const component = source.component;
      const def = mapComponent(component);
      const left = new Map(source.excluded.map((e) => [e.name, e]));

      console.log(`\n${chalk.bold(entry.title ?? entry.name)} ${chalk.dim(entry.id)}\n`);
      for (const prop of source.all) {
        const exclusion = left.get(prop.name);
        if (exclusion) {
          console.log(`  ${chalk.dim("✗")} ${prop.name} (${prop.type.name}) -> left out: ${exclusionReason(exclusion)}`);
          continue;
        }
        const from = source.added.includes(prop.name) ? chalk.dim(" (from the story's argTypes)") : "";
        // Says why a prop was left out, and when a default is a guess, so
        // a missing variant can be traced to its rule rather than to "skipped".
        const { property: v, reason, defaultAssumed } = explainProp(prop);
        if (v) {
          const assumed = defaultAssumed ? chalk.dim(" (assumed: the docs give no usable default)") : "";
          console.log(`  ${chalk.green("✓")} ${prop.name} (${prop.type.name}) -> ${v.type} [${v.values.join(", ")}], default ${v.defaultValue}${assumed}${from}`);
        } else {
          console.log(`  ${chalk.dim("✗")} ${prop.name} (${prop.type.name}) -> skipped: ${reason}`);
        }
      }
      console.log(`\n${def.variantProperties.length} variant properties, ${def.variantCombinations.length} combinations${def.wasCapped ? " (capped)" : ""}\n`);
      const auto = source.excluded.filter((e) => e.reason !== "excluded");
      if (auto.length) console.log(chalk.dim(`To make one a variant property again, pass --keep-props ${auto[0].name}.\n`));
      const unseen = describeUnseenArgTypes(snap ? shownPath(snap.path) : null, source.argTypes ? [] : [entry.id], 1);
      if (unseen) console.log(chalk.dim(`${unseen}\n`));
    } catch (err) {
      reportError(err, false);
      process.exitCode = 1;
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("diff")
  .description("Compare Figma file against code tokens and Storybook components")
  .requiredOption("--figma <url>", "Figma MCP server URL")
  .requiredOption("--file-key <key>", "Figma file key")
  .option("--storybook <url>", "Storybook URL (enables component diff)")
  .option("--connect-timeout <ms>", "How long to wait to connect to Figma MCP, and Storybook MCP, before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .option("--request-timeout <ms>", requestTimeoutHelp("Figma MCP and Storybook MCP"))
  .option("--project <path>", "Project root to scan for tokens", ".")
  .option("--source <type>", "Token source: tailwind, css, or theme (auto-detect if omitted or auto); any other value is an error")
  .option("--mode <name>", "Figma variable mode to read, alone (default: every mode, the first compared with the light theme and one named Dark with the dark theme)")
  .option("--components <names>", "Comma-separated component names, titles or IDs to diff, with --storybook; a name in neither Storybook nor Figma is an error when both were read")
  .option("--exclude-props <names>", "Comma-separated prop names to leave out of every component, besides those the snap records the push left out")
  .option("--keep-props <names>", KEEP_PROPS_HELP)
  .option("--snap <dir>", SNAP_OPTION_HELP, ".storysync/snaps")
  .option("--no-snap", "Use no snap: see only what Storybook's docs list")
  .option("--no-cache", "Read every component's docs from Storybook, not from the docs cache in .storysync/cache")
  .option("--json", "Output JSON instead of formatted text")
  .option("--strict", "Exit with code 1 if any differences found or a Figma or Storybook read fails")
  .action(async (opts) => {
    const json = !!opts.json;
    const flags = parsePropFlags(opts, json);
    const snap = readPropSnap(opts, json);
    const unseen: string[] = [];
    let mapped = 0;

    // Without --storybook there is no component diff for --components to
    // narrow, so the flag would be ignored and the run pass having diffed none.
    if (opts.components && !opts.storybook) {
      reportError(new Error("--components selects the components to diff, which needs --storybook"), json);
      process.exitCode = 1;
      return;
    }

    // An unknown --source fails as it does in tokens, before either server
    // is connected to.
    let source: TokenSourceType | undefined;
    try {
      source = parseTokenSource(opts.source as string | undefined);
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
      return;
    }
    const timeouts = parseTimeouts(opts);

    const figma = await connectMcp(new FigmaClient(opts.figma as string, timeouts.requestMs, timeouts.connectMs), "Figma MCP", opts.figma as string, json, timeouts.connectMs);

    // Optionally connect to Storybook MCP
    let storybook: StorybookClient | null = null;
    if (opts.storybook) {
      storybook = await connectStorybook(opts.storybook as string, json, timeouts, opts.cache !== false);
    }

    let figmaReadFailed = false;
    let storybookReadFailed = false;

    try {
      const fileKey = opts.fileKey as string;
      const mode = opts.mode as string | undefined;

      // --- Token diff ---
      const tokenSpinner = json ? null : ora("Reading Figma variables...").start();
      let figmaVars: FigmaVariable[] = [];
      try {
        figmaVars = await figma.getVariables(fileKey, mode);
        tokenSpinner?.succeed(`Read ${figmaVars.length} Figma variables`);
      } catch (err) {
        figmaReadFailed = true;
        tokenSpinner?.fail("Failed to read Figma variables");
        console.error(chalk.red(String(err)));
      }

      const codeResult = extractTokens(opts.project as string, source);
      const tokenOptions = { codeModes: codeResult.modes, mode };
      const tokenDiffs = figmaReadFailed ? [] : diffTokens(codeResult.collections, figmaVars, tokenOptions);
      const notCompared = figmaReadFailed ? [] : modesNotCompared(figmaVars, tokenOptions);

      // --- Component diff ---
      let componentDiffs: ComponentDiffEntry[] = [];
      let mappingFailures: { name: string; id?: string; title?: string; error: string }[] = [];
      if (storybook) {
        const compSpinner = json ? null : ora("Reading Figma components...").start();
        let figmaComponents: FigmaComponentInfo[] = [];
        let componentReadFailed = false;
        try {
          figmaComponents = await figma.getComponents(fileKey);
          compSpinner?.succeed(`Read ${figmaComponents.length} Figma components`);
        } catch (err) {
          componentReadFailed = true;
          figmaReadFailed = true;
          compSpinner?.fail("Failed to read Figma components");
          console.error(chalk.red(String(err)));
        }

        if (!componentReadFailed) {
          const mapSpinner = json ? null : ora("Mapping Storybook components...").start();
          let entries: Awaited<ReturnType<StorybookClient["listComponents"]>> = [];
          // The components and sets --components leaves out of the report.
          let others: ComponentEntry[] = [];
          let figmaReported = figmaComponents;
          try {
            // Entries whose stories name no component aren't diffed.
            entries = selectComponents(await storybook.listComponents(), undefined);
          } catch (err) {
            storybookReadFailed = true;
            mapSpinner?.fail("Failed to list Storybook components");
            console.error(chalk.red(String(err)));
          }
          if (opts.components) {
            const names = (opts.components as string).split(",");
            if (storybookReadFailed) {
              // Names are checked only against a list that was read: when
              // listing failed, that is the error, and every name would look
              // like a typo. Figma is still narrowed to them, or every Figma
              // component left out would be reported as not in code.
              figmaComponents = narrowFigmaComponents(figmaComponents, names);
            } else {
              try {
                ({ entries, others, figmaReported } = selectDiffComponents(entries, figmaComponents, names));
              } catch (err) {
                mapSpinner?.stop();
                reportError(err, json);
                process.exitCode = 1;
                return;
              }
            }
          }

          const codeComponents: CodeComponent[] = [];
          const unmappedEntries: ComponentEntry[] = [];
          mappingFailures = [];
          // Which component the run is on: in the spinner, or where there
          // is none spinning (--json, or not a terminal) as map says it.
          const progress = mapSpinner?.isSpinning ? null : new Progress("diff");
          for (const entry of entries) {
            const position = codeComponents.length + mappingFailures.length + 1;
            if (mapSpinner) mapSpinner.text = `Mapping Storybook components ${position}/${entries.length} ${entry.title ?? entry.name}`;
            progress?.component(position, entries.length, entry.title ?? entry.name);
            try {
              const source = snapPropSource(await storybook.getComponent(entry.id, entry.name, entry.title, entry.category), entry.id, snap, flags);
              if (!source.argTypes) unseen.push(entry.id);
              mapped++;
              codeComponents.push({ ...mapComponent(source.component), id: entry.id });
            } catch (err) {
              unmappedEntries.push(entry);
              mappingFailures.push({ name: entry.name, id: entry.id, ...(entry.title ? { title: entry.title } : {}), error: String(err) });
            }
          }
          progress?.done();
          if (!storybookReadFailed) mapSpinner?.succeed(`Mapped ${codeComponents.length} Storybook components`);
          if (!json && mappingFailures.length) {
            console.log(chalk.yellow(`Skipped ${mappingFailures.length} component(s) due to mapping errors:`));
            for (const failure of mappingFailures) console.log(chalk.yellow(`  ${failure.title ?? failure.name}: ${failure.error}`));
          }

          // A component code has but could not map, or that --components
          // left out, was never compared, so Figma's copy of it is not "not
          // in code". Each is still paired, as in a diff of everything.
          componentDiffs = diffComponents(codeComponents, figmaComponents, [...unmappedEntries, ...others], figmaReported, { codeRead: !storybookReadFailed });
        }
      }

      // --- Output ---
      const summary = computeDiffSummary(tokenDiffs, componentDiffs);

      if (json) {
        console.log(JSON.stringify({
          tokens: tokenDiffs.filter((t) => t.status !== "match"),
          components: componentDiffs.filter((c) => c.status !== "match"),
          summary,
          hasDifferences: hasDifferences(summary),
          figmaReadFailed,
          storybookReadFailed,
          // The components code has that were never compared.
          mappingFailures,
          // The Figma modes no code value was compared with.
          modesNotCompared: notCompared,
          ...(storybook ? { props: { snap: snap ? shownPath(snap.path) : null, argTypesUnseen: unseen } } : {}),
        }));
      } else {
        if (figmaReadFailed) {
          console.log(chalk.yellow("\nFigma read failed — diff results above are partial. See errors for details."));
        }
        if (storybookReadFailed) {
          console.log(chalk.yellow("\nStorybook listing failed — component results are partial: nothing in code was read to match Figma against. See errors for details."));
        }
        const unseenNote = storybook ? describeUnseenArgTypes(snap ? shownPath(snap.path) : null, unseen, mapped) : null;
        if (unseenNote) console.log(chalk.dim(`\n${unseenNote}`));
        if (mappingFailures.length) {
          console.log(chalk.yellow(`\nMapping failed for ${mappingFailures.length} Storybook component(s) — component results are partial: ${mappingFailures.map((f) => f.title ?? f.name).join(", ")} ${mappingFailures.length === 1 ? "was" : "were"} not compared. See errors for details.`));
        }

        const mismatched = tokenDiffs.filter((t) => t.status !== "match");
        if (mismatched.length) {
          console.log(chalk.bold("\nToken differences:\n"));
          for (const t of mismatched) {
            const mode = t.mode ? ` (${t.mode})` : "";
            if (t.status === "missing_from_figma") {
              const where = t.mode ? `no ${t.mode} mode in Figma` : "not in Figma";
              console.log(`  ${chalk.yellow("+")} ${t.category}/${t.name}${mode} ${chalk.dim(`(${t.codeValue})`)} ${chalk.yellow(where)}`);
            } else if (t.status === "missing_from_code") {
              console.log(`  ${chalk.cyan("-")} ${t.category}/${t.name} ${chalk.dim(`(${t.figmaValue})`)} ${chalk.cyan("not in code")}`);
            } else if (t.status === "value_mismatch") {
              console.log(`  ${chalk.red("~")} ${t.category}/${t.name}${mode} code=${chalk.dim(t.codeValue!)} figma=${chalk.dim(t.figmaValue!)}`);
            }
          }
        } else if (!figmaReadFailed && (figmaVars.length || codeResult.collections.length)) {
          console.log(chalk.green("\nTokens in sync."));
        }

        const compMismatched = componentDiffs.filter((c) => c.status !== "match");
        if (compMismatched.length) {
          console.log(chalk.bold("\nComponent differences:\n"));
          for (const c of compMismatched) {
            if (c.status === "code_only") {
              console.log(`  ${chalk.yellow("+")} ${chalk.bold(c.name)} ${chalk.yellow("not in Figma")} ${chalk.dim(c.details.join(", "))}`);
            } else if (c.status === "figma_only") {
              console.log(`  ${chalk.cyan("-")} ${chalk.bold(c.name)} ${chalk.cyan("not in code")} ${chalk.dim(c.details.join(", "))}`);
            } else if (c.status === "variant_mismatch") {
              console.log(`  ${chalk.red("~")} ${chalk.bold(c.name)}`);
              for (const d of c.details) console.log(`      ${chalk.dim(d)}`);
            } else if (c.status === "ambiguous") {
              console.log(`  ${chalk.red("?")} ${chalk.bold(c.name)} ${chalk.red("ambiguous")} ${chalk.dim(c.details.join(", "))}`);
            } else if (c.status === "errored") {
              const where = [c.page != null ? `page ${c.page}` : null, c.nodeId != null ? `node ${c.nodeId}` : null].filter(Boolean).join(", ");
              const [errored, ...rest] = c.details;
              console.log(`  ${chalk.red("!")} ${chalk.bold(c.name)}${where ? chalk.dim(` (${where})`) : ""} ${chalk.red(errored)}${rest.length ? chalk.dim(`, ${rest.join(", ")}`) : ""}`);
            }
          }
        } else if (storybook && !figmaReadFailed && !storybookReadFailed && !mappingFailures.length) {
          console.log(chalk.green(componentDiffs.length ? "\nComponents in sync." : "\nNo components to diff."));
        }

        // Summary
        console.log("");
        const parts: string[] = [];
        if (summary.tokensMatched) parts.push(chalk.green(`${summary.tokensMatched} tokens matched`));
        if (summary.tokensMismatched) parts.push(chalk.red(`${summary.tokensMismatched} value mismatches`));
        if (summary.tokensMissingFromFigma) parts.push(chalk.yellow(`${summary.tokensMissingFromFigma} missing from Figma`));
        if (summary.tokensMissingFromCode) parts.push(chalk.cyan(`${summary.tokensMissingFromCode} missing from code`));
        if (parts.length) console.log(`Tokens: ${parts.join(", ")}`);
        // So a count of matches isn't read as covering every mode.
        for (const { collection, modes } of notCompared) {
          console.log(chalk.dim(`Not compared: the ${modes.join(", ")} ${modes.length === 1 ? "mode" : "modes"} of ${collection}`));
        }

        if (storybook) {
          const cParts: string[] = [];
          if (summary.componentsMatched) cParts.push(chalk.green(`${summary.componentsMatched} matched`));
          if (summary.componentsMismatched) cParts.push(chalk.red(`${summary.componentsMismatched} mismatched`));
          if (summary.componentsCodeOnly) cParts.push(chalk.yellow(`${summary.componentsCodeOnly} code-only`));
          if (summary.componentsFigmaOnly) cParts.push(chalk.cyan(`${summary.componentsFigmaOnly} Figma-only`));
          if (summary.componentsAmbiguous) cParts.push(chalk.red(`${summary.componentsAmbiguous} ambiguous`));
          if (summary.componentsErrored) cParts.push(chalk.red(`${summary.componentsErrored} errored in Figma`));
          if (cParts.length) console.log(`Components: ${cParts.join(", ")}`);
        }

        if (!figmaReadFailed && !storybookReadFailed && !mappingFailures.length && !hasDifferences(summary)) {
          console.log(chalk.green("\nNo differences found."));
        }
      }

      if (opts.strict && (figmaReadFailed || storybookReadFailed || hasDifferences(summary) || mappingFailures.length)) process.exitCode = 1;
    } finally {
      await figma.disconnect();
      if (storybook) await storybook.disconnect();
    }
  });

program
  .command("init")
  .description("Check and set up @storybook/addon-mcp in your Storybook project")
  .option("--project <path>", "Project root path", ".")
  .action(async (opts) => {
    await runInit(opts.project as string);
  });

program
  .command("setup")
  .description("Drop the storysync skill, slash commands, and MCP setup notes for an AI client")
  .requiredOption("--client <name>", "AI client: claude, cursor, or codex")
  .option("--project <path>", "Project root path", ".")
  .option("--force", "Overwrite existing files")
  .action((opts) => {
    const client = String(opts.client).toLowerCase();
    if (client !== "claude" && client !== "cursor" && client !== "codex") {
      console.error(`Unknown client: ${opts.client}. Use one of: claude, cursor, codex.`);
      process.exitCode = 1;
      return;
    }
    runSetup(client as Client, opts.project as string, !!opts.force);
  });

program.parse();
