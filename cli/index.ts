#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient } from "./storybook.js";
import { mapComponent } from "./mapper.js";

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
program.name("storysync").description("Preview how Storybook components map to Figma variants").version("0.1.0");

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
