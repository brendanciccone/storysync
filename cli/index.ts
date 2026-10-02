#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient, selectComponents, findComponent } from "./storybook.js";
import { FigmaClient } from "./figma.js";
import { mapComponent, DEFAULT_MAX_COMBINATIONS } from "./mapper.js";
import { detectTokenSource, extractTokens, compareTokens, hasDrift, readTokenBaseline, baselineCommand, parseTokenSource } from "./tokens.js";
import { diffTokens, diffComponents, selectDiffComponents, narrowFigmaComponents, computeDiffSummary, hasDifferences } from "./diff.js";
import { runSnap } from "./snap.js";
import { resolveAndLaunch } from "./snap-browser.js";
import { verify, loadJsonFile, formatFidelity, parseDuration, formatAge, readSnapAge } from "./verify.js";
import type { ReadbackFile, ReadbackIssue, SnapAgeInfo } from "./verify.js";
import type { SnapResult } from "./snap.js";
import { runInit } from "./init.js";
import { runSetup, type Client } from "./setup.js";
import { VERSION } from "./version.js";
import type { TokenBaseline, TokenExtractionResult, TokenSourceType } from "./tokens.js";
import type { FigmaComponentDefinition, CapInfo } from "./mapper.js";
import type { FigmaVariable, FigmaComponentInfo } from "./figma.js";
import type { TokenDiffEntry, ComponentDiffEntry } from "./diff.js";
import type { ComponentEntry } from "./storybook.js";

/**
 * How long to wait for an MCP server to answer before giving up on it, as
 * --connect-timeout's default. It is the 60 seconds the MCP SDK gives the
 * initialize request, so a server that connected before still does. A
 * Storybook that is still starting refuses connections until it listens,
 * which fails at once rather than waiting, and the example's Storybook 10.6
 * answered initialize within 25ms of its port opening.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

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
 * Streamable HTTP initialize gives up after the SDK's 60 seconds, but the SSE
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

function connectStorybook(url: string, json: boolean, timeoutMs: number): Promise<StorybookClient> {
  return connectMcp(new StorybookClient(url), "Storybook MCP", url, json, timeoutMs);
}

/** Parses --connect-timeout, exiting with a clear message on anything but a positive number of milliseconds. */
const MAX_TIMER_MS = 2_147_483_647;

function parseConnectTimeout(value: unknown): number {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    console.error(chalk.red(`--connect-timeout must be a positive number of milliseconds, received "${value}"`));
    process.exit(1);
  }
  // Node fires any longer timer after 1ms, which would fail every connect.
  if (ms > MAX_TIMER_MS) {
    console.error(chalk.red(`--connect-timeout can be at most ${MAX_TIMER_MS} milliseconds (about 24 days), received "${value}"`));
    process.exit(1);
  }
  return ms;
}

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
      return `is stale: Figma read it at ${issue.readAt}, before the snap was measured${snapAge.known ? ` at ${snapAge.measuredAt}` : ""}, so it is from an earlier run`;
  }
}

/** Parses --max-combinations, exiting with a clear message on anything but a positive integer. */
function parseMaxCombinations(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    console.error(chalk.red(`--max-combinations must be a positive whole number, received "${value}"`));
    process.exit(1);
  }
  return n;
}

program
  .command("map")
  .description("Map all Storybook components to Figma variant definitions")
  .requiredOption("--storybook <url>", "Storybook URL")
  .option("--connect-timeout <ms>", "How long to wait for Storybook MCP to answer before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .option("--components <names>", "Comma-separated component names or IDs; a name that matches nothing is an error")
  .option("--json", "Output JSON instead of formatted text")
  .option("--max-combinations <n>", "Most combinations to generate per component before capping", String(DEFAULT_MAX_COMBINATIONS))
  .option("--strict", "Exit with code 1 if any component fails or is capped")
  .action(async (opts) => {
    const json = !!opts.json;
    const maxCombinations = parseMaxCombinations(opts.maxCombinations);
    const storybook = await connectStorybook(opts.storybook, json, parseConnectTimeout(opts.connectTimeout));
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

      if (opts.components) {
        // A typo'd name is an error whatever the flags. Filtered out silently,
        // map would exit 0 with an empty or partial mapping and CI go green.
        entries = selectComponents(entries, (opts.components as string).split(","));
        if (!json) console.log(chalk.dim(`  Filtered to ${entries.length}`));
      }

      if (!entries.length) {
        if (json) console.log(JSON.stringify({ components: [], summary: { total: 0, mapped: 0, failed: 0, capped: 0, totalCombinations: 0 } }));
        else console.log(chalk.yellow("\nNo components found."));
        return;
      }

      const results: { name: string; title?: string; category?: string; variantProperties: { name: string; type: string; values: string[]; defaultValue: string }[]; combinations: number; capped: boolean; cap?: CapInfo; error: string | null }[] = [];
      let total = 0, capped = 0, failed = 0;

      for (const entry of entries) {
        try {
          const component = await storybook.getComponent(entry.id, entry.name, entry.title, entry.category);
          const def = mapComponent(component, maxCombinations);
          results.push({ name: entry.name, title: entry.title, category: entry.category, variantProperties: def.variantProperties, combinations: def.variantCombinations.length, capped: def.wasCapped, ...(def.cap ? { cap: def.cap } : {}), error: null });
          if (!json) {
            const info = def.variantProperties.map((p) => `${p.name}(${p.values.length})`).join(", ");
            const tag = def.cap ? chalk.yellow(` [CAPPED ${def.cap.generated}/${def.cap.totalPossible}]`) : "";
            const label = entry.title ?? entry.name;
            console.log(`  ${chalk.green("✓")} ${chalk.bold(label)} ${chalk.dim(info || "no variants")} -> ${def.variantCombinations.length} combinations${tag}`);
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
          results.push({ name: entry.name, title: entry.title, category: entry.category, variantProperties: [], combinations: 0, capped: false, error: String(err) });
          if (!json) console.log(`  ${chalk.red("✗")} ${chalk.bold(entry.title ?? entry.name)} ${chalk.red(String(err))}`);
        }
      }

      if (json) {
        console.log(JSON.stringify({ components: results, summary: { total: entries.length, mapped: entries.length - failed, failed, capped, totalCombinations: total } }));
      } else {
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
  .description("Measure each component variant's rendered styles from a running Storybook")
  .requiredOption("--storybook <url>", "Storybook URL")
  .option("--connect-timeout <ms>", "How long to wait for Storybook MCP to answer before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .option("--components <names>", "Comma-separated component names or IDs; a name that matches nothing is an error")
  .option("--out <dir>", "Output directory", ".storysync/snaps")
  .option("--variants <mode>", "Which combinations to measure: representative or all", "representative")
  .option("--max-combinations <n>", "With --variants all, most combinations to measure per component before capping", String(DEFAULT_MAX_COMBINATIONS))
  .option("--screenshots", "Also save a PNG per variant (off by default)")
  .option("--timeout <ms>", "Per-story timeout in milliseconds", "10000")
  .option("--selector <css>", "Override the component root selector")
  .option("--json", "Output JSON instead of formatted text")
  .option("--strict", "Exit with code 1 if any variant or component could not be measured, none were, or a component was capped")
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
    const connectTimeoutMs = parseConnectTimeout(opts.connectTimeout);

    const storybook = await connectStorybook(opts.storybook, json, connectTimeoutMs);
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
        },
        {
          storybook,
          launch: resolveAndLaunch,
          onProgress: json ? undefined : (m) => console.log(m),
        },
      );

      if (json) {
        console.log(JSON.stringify(result));
      } else {
        const { summary } = result;
        console.log(`\n${summary.rendered}/${summary.variants} variants measured across ${summary.components} components`);
        console.log(chalk.dim(`  Styles written to ${opts.out}/styles.json`));
        for (const component of result.components) {
          for (const warning of component.warnings) {
            console.log(chalk.yellow(`\n  ! ${component.title ?? component.name}: ${warning}`));
          }
        }
        for (const component of result.components.filter((c) => c.error != null)) {
          console.log(chalk.yellow(`\n  ✗ ${component.title ?? component.name}: ${component.error}`));
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
      // Measuring nothing is a failure, not a clean run: snap still writes a
      // styles.json and a freshly-stamped meta.json, so downstream freshness
      // checks would read an empty result as a good one.
      // A capped component was measured as a subset; building from it as if it
      // were the whole component is the silent gap --strict exists to stop.
      const hasFailures = result.summary.failed > 0
        || result.summary.componentsFailed > 0
        || result.summary.components === 0
        || result.summary.componentsCapped > 0;
      const hasWarnings = result.summary.componentsWithWarnings > 0;

      if ((strict && hasFailures) || (opts.strictWarnings && hasWarnings)) {
        process.exitCode = 1;
      }
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("verify")
  .description("Compare what was written to Figma against the styles measured by snap")
  .option("--snap <path>", "Path to snap output", ".storysync/snaps/styles.json")
  .option("--readback <path>", "Path to the properties read back from Figma", ".storysync/figma-readback.json")
  .option("--tolerance <px>", "Allowed difference for lengths, in pixels", "0.5")
  .option("--max-age <duration>", "Warn when the snap is older than this (e.g. 30m, 2h, 7d)", "2h")
  .option("--json", "Output JSON instead of formatted text")
  .option("--strict", "Exit with code 1 if any variant drifted, is missing from Figma, or reported nothing comparable, if a readback entry is not what Figma returned, is incomplete or was read before the snap, or if the snap recorded a component failure")
  .option("--strict-age", "Implies --strict, and also fails when the snap is older than --max-age")
  .option("--strict-measured", "Implies --strict, and also fails on variants that were inferred rather than measured")
  .action(async (opts) => {
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

    try {
      const snapPath = opts.snap as string;
      const snap = loadJsonFile<SnapResult>(snapPath, "snap output");
      // A readback or meta.json passed as --snap, or a failed `snap --json`
      // captured as one, has no components list, and scoring it ended on a
      // bare TypeError. Say what the file is not, and what it holds instead.
      if (!Array.isArray(snap?.components)) {
        const error = (snap as { error?: unknown } | null)?.error;
        const held = typeof error === "string" ? ` It holds an error instead: ${error}` : "";
        throw new Error(`snap output at ${snapPath} has no "components" list, so it is not a styles.json written by \`storysync snap\`: pass that as --snap, and the Figma readback as --readback.${held}`);
      }
      const readback = loadJsonFile<ReadbackFile>(opts.readback as string, "Figma readback");
      // The snap's time first: an entry Figma read before it is stale.
      const snapAge = readSnapAge(snapPath, maxAgeMs);
      const result = verify(snap, readback, tolerance, { measuredAt: snapAge.known ? snapAge.measuredAt : undefined });
      result.snapAge = snapAge;

      if (json) {
        console.log(JSON.stringify(result));
      } else {
        const { summary } = result;
        // Said on the score's own line: a score over the entries that were
        // left must not be read as a score over all of them.
        const excluded = summary.unverifiedReadback;
        const excludedNote = excluded > 0
          ? chalk.red(` — ${excluded} unverified readback ${excluded === 1 ? "entry" : "entries"} excluded`)
          : "";
        console.log(`\nFidelity: ${chalk.bold(formatFidelity(result.fidelity))} ${chalk.dim(`(${summary.propertiesMatched}/${summary.propertiesCompared} properties)`)}${excludedNote}`);
        const unscoredNote = summary.unscored > 0 ? `, ${summary.unscored} unscored` : "";
        const unverifiedNote = summary.unverifiedReadback > 0 ? `, ${summary.unverifiedReadback} with an unverified readback` : "";
        console.log(`${summary.verified} verified, ${summary.drifted} drifted, ${summary.missingFromFigma} missing from Figma${unscoredNote}${unverifiedNote}, across ${summary.variants} variants\n`);

        for (const issue of result.snapIssues ?? []) {
          console.log(`  ${chalk.red("!")} snap recorded a failure: ${issue}`);
        }
        for (const warning of result.snapWarnings ?? []) {
          console.log(`  ${chalk.yellow("!")} ${warning}`);
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
          console.log(chalk.dim("      Read these variants back again, after the snap, with the skill's readback template as it is, and write each entry into the readback exactly as returned. Never fill one in from snap."));
        }

        for (const variant of result.variants) {
          if (variant.status === "verified" || variant.status === "unverified_readback") continue;
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
          && readbackIssues.length === 0
          && result.summary.propertiesCompared > 0;
        if (cleanRun) {
          // Name what was checked. On a clean run this is otherwise the only
          // output, and "it matches" is not much use without saying what did.
          const names = [...new Set(result.variants.map((v) => v.component))];
          // Only claim "measured" when everything actually was. Saying it of a
          // partly-inferred run is the conflation the provenance line exists
          // to prevent.
          const allMeasured = result.summary.inferred === 0
            && result.summary.unrecorded === 0
            && result.summary.unmeasured === 0;
          const kind = allMeasured ? "measured" : "expected";
          console.log(chalk.green(`  Figma matches the ${kind} styles for ${names.join(", ") || "no components"}.`));
        }

        // Provenance before age: a component styled by guesswork matters more
        // than one measured a while ago, and this is the line that separates
        // "produced a result" from "produced a measured result".
        const { inferred, unrecorded, unmeasured } = result.summary;
        if (inferred > 0 || unrecorded > 0 || unmeasured > 0) {
          const parts: string[] = [];
          if (inferred > 0) parts.push(`${inferred} inferred from source rather than measured`);
          if (unrecorded > 0) parts.push(`${unrecorded} with no recorded provenance`);
          if (unmeasured > 0) parts.push(`${unmeasured} in Figma that snap never measured`);
          const line = `  Provenance: ${parts.join(", ")}`;
          console.log(opts.strictMeasured ? chalk.red(line) : chalk.yellow(line));
          for (const v of result.variants.filter((x) => x.source !== "measured" && x.status !== "missing_from_figma")) {
            console.log(chalk.dim(`      ${v.component} ${v.slug} [${v.source}]`));
          }
          for (const u of result.unmeasuredInFigma) {
            console.log(chalk.dim(`      ${u.component} ${u.slug} [unmeasured — written to Figma but never scored]`));
          }
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
      const hasDrift = result.summary.drifted > 0
        || result.summary.missingFromFigma > 0
        || scoredNothing
        || (result.snapIssues?.length ?? 0) > 0
        || (result.readbackIssues?.length ?? 0) > 0;
      // Unrecorded counts as not-measured, for the same reason an unknown age
      // counts as stale: the absent state must not read as the good one.
      const notMeasured = result.summary.inferred > 0
        || result.summary.unrecorded > 0
        || result.summary.unmeasured > 0;
      // An age that cannot be established is not a pass. `meta.json` is the
      // file most likely to be gitignored, so failing open here would make
      // --strict-age succeed unconditionally in exactly the CI setup the
      // determinism guarantee is designed to enable.
      const ageFailsStrict = !!opts.strictAge && (!result.snapAge?.known || result.snapAge.stale);

      if ((strict && hasDrift) || ageFailsStrict || (opts.strictMeasured && notMeasured)) {
        process.exitCode = 1;
      }
    } catch (err) {
      reportError(err, json);
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .description("List components in Storybook")
  .requiredOption("--storybook <url>", "Storybook URL")
  .option("--connect-timeout <ms>", "How long to wait for Storybook MCP to answer before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .action(async (opts) => {
    const storybook = await connectStorybook(opts.storybook, false, parseConnectTimeout(opts.connectTimeout));
    try {
      const entries = await storybook.listComponents();
      console.log(`\n${entries.length} components:\n`);
      for (const e of entries) {
        const stories = e.storyIds?.length ? chalk.dim(` (${e.storyIds.length} stories)`) : "";
        console.log(`  ${e.name} ${chalk.dim(e.id)}${stories}`);
      }
    } catch (err) {
      reportError(err, false);
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
  if (!hasDrift(drift)) {
    if (json) console.log(JSON.stringify({ drift: false }));
    else console.log(chalk.green("\nNo token drift detected."));
    return;
  }

  if (json) {
    console.log(JSON.stringify({ drift: true, added: drift.added, removed: drift.removed, changed: drift.changed }));
  } else {
    console.log(chalk.red("\nToken drift detected:\n"));
    for (const a of drift.added) {
      console.log(`  ${chalk.green("+")} ${a.category}: ${a.tokens.map((t) => t.name).join(", ")}`);
    }
    for (const r of drift.removed) {
      console.log(`  ${chalk.red("-")} ${r.category}: ${r.tokens.map((t) => t.name).join(", ")}`);
    }
    for (const c of drift.changed) {
      console.log(`  ${chalk.yellow("~")} ${c.category}/${c.token}: ${c.from} → ${c.to}`);
    }
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
    if (!json) {
      const spinner = ora("Detecting token source...").start();
      const source = detectTokenSource(projectPath);
      if (source) {
        spinner.succeed(`Detected: ${source.type} (${source.path})`);
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
      if (json) console.log(JSON.stringify({ source: result.source, sourcePath: result.sourcePath, collections: [], warnings: result.warnings, summary: { totalTokens: 0, collections: 0 } }));
      return;
    }

    // Default: pretty-print discovered tokens
    const totalTokens = result.collections.reduce((sum, c) => sum + c.tokens.length, 0);

    if (json) {
      console.log(JSON.stringify({
        source: result.source,
        sourcePath: result.sourcePath,
        collections: result.collections,
        warnings: result.warnings,
        summary: { totalTokens, collections: result.collections.length },
      }));
    } else {
      console.log("");
      for (const collection of result.collections) {
        console.log(`  ${chalk.bold(collection.category)} ${chalk.dim(`(${collection.tokens.length} tokens)`)}`);
        const shown = opts.all ? collection.tokens : collection.tokens.slice(0, 8);
        for (const token of shown) {
          console.log(`    ${token.name.padEnd(24)} ${chalk.dim(token.value)}`);
        }
        if (!opts.all && collection.tokens.length > 8) {
          console.log(chalk.dim(`    ... and ${collection.tokens.length - 8} more (use --all to show)`));
        }
      }
      console.log(`\n${totalTokens} tokens in ${result.collections.length} collections`);
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
  .requiredOption("--component <name>", "Component name or ID; a name that matches nothing is an error")
  .option("--connect-timeout <ms>", "How long to wait for Storybook MCP to answer before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .action(async (opts) => {
    const storybook = await connectStorybook(opts.storybook, false, parseConnectTimeout(opts.connectTimeout));
    try {
      // A name that matches nothing fails here, naming what exists, before
      // asking Storybook for the documentation of a component it never listed.
      const entry = findComponent(await storybook.listComponents(), opts.component as string);
      const component = await storybook.getComponent(entry.id, entry.name);
      const def = mapComponent(component);

      console.log(`\n${chalk.bold(component.name)}\n`);
      for (const prop of component.props) {
        const v = def.variantProperties.find((vp) => vp.name === prop.name);
        if (v) {
          console.log(`  ${chalk.green("✓")} ${prop.name} (${prop.type.name}) -> ${v.type} [${v.values.join(", ")}]`);
        } else {
          console.log(`  ${chalk.dim("✗")} ${prop.name} (${prop.type.name}) -> skipped`);
        }
      }
      console.log(`\n${def.variantProperties.length} variant properties, ${def.variantCombinations.length} combinations${def.wasCapped ? " (capped)" : ""}\n`);
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
  .option("--connect-timeout <ms>", "How long to wait for Figma MCP, and Storybook MCP, to answer before failing, in milliseconds", String(DEFAULT_CONNECT_TIMEOUT_MS))
  .option("--project <path>", "Project root to scan for tokens", ".")
  .option("--source <type>", "Token source: tailwind, css, or theme (auto-detect if omitted or auto); any other value is an error")
  .option("--mode <name>", "Figma variable mode to read (default: each collection's first mode)")
  .option("--components <names>", "Comma-separated component names or IDs to diff, with --storybook; a name in neither Storybook nor Figma is an error when both were read")
  .option("--json", "Output JSON instead of formatted text")
  .option("--strict", "Exit with code 1 if any differences found or a Figma or Storybook read fails")
  .action(async (opts) => {
    const json = !!opts.json;

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
    const connectTimeoutMs = parseConnectTimeout(opts.connectTimeout);

    const figma = await connectMcp(new FigmaClient(opts.figma as string), "Figma MCP", opts.figma as string, json, connectTimeoutMs);

    // Optionally connect to Storybook MCP
    let storybook: StorybookClient | null = null;
    if (opts.storybook) {
      storybook = await connectStorybook(opts.storybook as string, json, connectTimeoutMs);
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
      const tokenDiffs = figmaReadFailed ? [] : diffTokens(codeResult.collections, figmaVars);

      // --- Component diff ---
      let componentDiffs: ComponentDiffEntry[] = [];
      let mappingFailures: { name: string; error: string }[] = [];
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
          try {
            entries = await storybook.listComponents();
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
                ({ entries, figmaComponents } = selectDiffComponents(entries, figmaComponents, names));
              } catch (err) {
                mapSpinner?.stop();
                reportError(err, json);
                process.exitCode = 1;
                return;
              }
            }
          }

          const codeComponents: FigmaComponentDefinition[] = [];
          mappingFailures = [];
          for (const entry of entries) {
            try {
              const component = await storybook.getComponent(entry.id, entry.name, entry.title, entry.category);
              codeComponents.push(mapComponent(component));
            } catch (err) {
              mappingFailures.push({ name: entry.name, error: String(err) });
            }
          }
          if (!storybookReadFailed) mapSpinner?.succeed(`Mapped ${codeComponents.length} Storybook components`);
          if (!json && mappingFailures.length) {
            console.log(chalk.yellow(`Skipped ${mappingFailures.length} component(s) due to mapping errors.`));
          }

          componentDiffs = diffComponents(codeComponents, figmaComponents);
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
        }));
      } else {
        if (figmaReadFailed) {
          console.log(chalk.yellow("\nFigma read failed — diff results above are partial. See errors for details."));
        }
        if (storybookReadFailed) {
          console.log(chalk.yellow("\nStorybook listing failed — component results are partial: nothing in code was read to match Figma against. See errors for details."));
        }

        const mismatched = tokenDiffs.filter((t) => t.status !== "match");
        if (mismatched.length) {
          console.log(chalk.bold("\nToken differences:\n"));
          for (const t of mismatched) {
            if (t.status === "missing_from_figma") {
              console.log(`  ${chalk.yellow("+")} ${t.category}/${t.name} ${chalk.dim(`(${t.codeValue})`)} ${chalk.yellow("not in Figma")}`);
            } else if (t.status === "missing_from_code") {
              console.log(`  ${chalk.cyan("-")} ${t.category}/${t.name} ${chalk.dim(`(${t.figmaValue})`)} ${chalk.cyan("not in code")}`);
            } else if (t.status === "value_mismatch") {
              console.log(`  ${chalk.red("~")} ${t.category}/${t.name} code=${chalk.dim(t.codeValue!)} figma=${chalk.dim(t.figmaValue!)}`);
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
            }
          }
        } else if (storybook && !figmaReadFailed && !storybookReadFailed) {
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

        if (storybook) {
          const cParts: string[] = [];
          if (summary.componentsMatched) cParts.push(chalk.green(`${summary.componentsMatched} matched`));
          if (summary.componentsMismatched) cParts.push(chalk.red(`${summary.componentsMismatched} mismatched`));
          if (summary.componentsCodeOnly) cParts.push(chalk.yellow(`${summary.componentsCodeOnly} code-only`));
          if (summary.componentsFigmaOnly) cParts.push(chalk.cyan(`${summary.componentsFigmaOnly} Figma-only`));
          if (summary.componentsAmbiguous) cParts.push(chalk.red(`${summary.componentsAmbiguous} ambiguous`));
          if (cParts.length) console.log(`Components: ${cParts.join(", ")}`);
        }

        if (!figmaReadFailed && !storybookReadFailed && !hasDifferences(summary)) {
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
