#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient } from "./storybook.js";
import { mapComponent } from "./mapper.js";
import { detectTokenSource, extractTokens, compareTokens, hasDrift } from "./tokens.js";
import type { TokenBaseline } from "./tokens.js";

async function connectStorybook(url: string, quiet = false) {
  const spinner = quiet ? null : ora("Connecting to Storybook MCP...").start();
  const client = new StorybookClient(url);
  try {
    await client.connect();
    spinner?.succeed("Connected to Storybook MCP");
    return client;
  } catch (err) {
    spinner?.fail("Failed to connect to Storybook MCP");
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}

const program = new Command();
program.name("storysync").description("Sync design tokens and Storybook components to Figma").version("0.2.0");

program
  .command("map")
  .description("Map all Storybook components to Figma variant definitions")
  .requiredOption("--storybook <url>", "Storybook URL")
  .option("--components <names>", "Comma-separated component names")
  .option("--json", "Output JSON instead of formatted text")
  .option("--strict", "Exit with code 1 if any component fails or is capped")
  .action(async (opts) => {
    const json = !!opts.json;
    const storybook = await connectStorybook(opts.storybook, json);
    try {
      const spinner = json ? null : ora("Reading components...").start();
      let entries = await storybook.listComponents();
      spinner?.succeed(`Found ${entries.length} components`);

      if (opts.components) {
        const filter = new Set((opts.components as string).split(",").map((s: string) => s.trim().toLowerCase()));
        entries = entries.filter((e) => filter.has(e.name.toLowerCase()) || filter.has(e.id.toLowerCase()));
        if (!json) console.log(chalk.dim(`  Filtered to ${entries.length}`));
      }

      if (!entries.length) {
        if (json) console.log(JSON.stringify({ components: [], summary: { total: 0, mapped: 0, failed: 0, capped: 0, totalCombinations: 0 } }));
        else console.log(chalk.yellow("\nNo components found."));
        return;
      }

      const results: { name: string; variantProperties: { name: string; type: string; values: string[]; defaultValue: string }[]; combinations: number; capped: boolean; error: string | null }[] = [];
      let total = 0, capped = 0, failed = 0;

      for (const entry of entries) {
        try {
          const component = await storybook.getComponent(entry.id, entry.name);
          const def = mapComponent(component);
          results.push({ name: entry.name, variantProperties: def.variantProperties, combinations: def.variantCombinations.length, capped: def.wasCapped, error: null });
          if (!json) {
            const info = def.variantProperties.map((p) => `${p.name}(${p.values.length})`).join(", ");
            const tag = def.wasCapped ? chalk.yellow(" [CAPPED]") : "";
            console.log(`  ${chalk.green("✓")} ${chalk.bold(entry.name)} ${chalk.dim(info || "no variants")} -> ${def.variantCombinations.length} combinations${tag}`);
          }
          total += def.variantCombinations.length;
          if (def.wasCapped) capped++;
        } catch (err) {
          failed++;
          results.push({ name: entry.name, variantProperties: [], combinations: 0, capped: false, error: String(err) });
          if (!json) console.log(`  ${chalk.red("✗")} ${chalk.bold(entry.name)} ${chalk.red(String(err))}`);
        }
      }

      if (json) {
        console.log(JSON.stringify({ components: results, summary: { total: entries.length, mapped: entries.length - failed, failed, capped, totalCombinations: total } }));
      } else {
        console.log(`\n${entries.length} components, ${total} total variants${capped ? `, ${capped} capped` : ""}`);
        console.log(chalk.dim("To write to Figma, use the Claude Code skill or Cursor rules file."));
      }

      if (opts.strict && (failed > 0 || capped > 0)) process.exitCode = 1;
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("list")
  .description("List components in Storybook")
  .requiredOption("--storybook <url>", "Storybook URL")
  .action(async (opts) => {
    const storybook = await connectStorybook(opts.storybook);
    try {
      const entries = await storybook.listComponents();
      console.log(`\n${entries.length} components:\n`);
      for (const e of entries) {
        const stories = e.storyIds?.length ? chalk.dim(` (${e.storyIds.length} stories)`) : "";
        console.log(`  ${e.name} ${chalk.dim(e.id)}${stories}`);
      }
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("tokens")
  .description("Extract design tokens from project source and preview Figma variable collections")
  .option("--project <path>", "Project root to scan", ".")
  .option("--source <type>", "Token source: tailwind, css, or theme (auto-detect if omitted)")
  .option("--json", "Output JSON instead of formatted text")
  .option("--check", "Compare against baseline and detect drift")
  .option("--baseline <path>", "Path to token baseline JSON", ".storysync/tokens-baseline.json")
  .option("--strict", "Exit with code 1 if no tokens found or drift detected")
  .action(async (opts) => {
    const json = !!opts.json;
    const projectPath = opts.project as string;

    if (!json) {
      const spinner = ora("Detecting token source...").start();
      const detected = detectTokenSource(projectPath);
      if (detected) {
        spinner.succeed(`Detected: ${detected.type} (${detected.path})`);
      } else {
        spinner.fail("No token source found");
        if (opts.strict) process.exitCode = 1;
        return;
      }
    }

    const result = extractTokens(projectPath, opts.source as "tailwind" | "css" | "theme" | undefined);

    if (!result.collections.length) {
      if (json) {
        console.log(JSON.stringify({ source: result.source, sourcePath: result.sourcePath, collections: [], warnings: result.warnings, summary: { totalTokens: 0, collections: 0 } }));
      } else {
        console.log(chalk.yellow("\nNo tokens found."));
        for (const w of result.warnings) console.log(chalk.dim(`  ${w}`));
      }
      if (opts.strict) process.exitCode = 1;
      return;
    }

    if (opts.check) {
      const baselinePath = opts.baseline as string;
      let baseline: TokenBaseline;
      try {
        const { readFileSync } = await import("node:fs");
        baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as TokenBaseline;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          if (json) {
            console.log(JSON.stringify({ drift: "new", ...result, summary: { totalTokens: result.collections.reduce((s, c) => s + c.tokens.length, 0), collections: result.collections.length } }));
          } else {
            console.log(chalk.yellow(`\nNo baseline found at ${baselinePath} - first run`));
            console.log(chalk.dim("Save current output with --json to create a baseline."));
          }
          return;
        }
        throw err;
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
        for (const token of collection.tokens.slice(0, 8)) {
          console.log(`    ${token.name.padEnd(24)} ${chalk.dim(token.value)}`);
        }
        if (collection.tokens.length > 8) {
          console.log(chalk.dim(`    ... and ${collection.tokens.length - 8} more`));
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
  .requiredOption("--component <name>", "Component name or ID")
  .action(async (opts) => {
    const storybook = await connectStorybook(opts.storybook);
    try {
      const entries = await storybook.listComponents();
      const match = entries.find(
        (e) => e.id.toLowerCase() === opts.component.toLowerCase() || e.name.toLowerCase() === opts.component.toLowerCase()
      );

      const component = await storybook.getComponent(match?.id ?? opts.component.toLowerCase(), match?.name ?? opts.component);
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
    } finally {
      await storybook.disconnect();
    }
  });

program.parse();
