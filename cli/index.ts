#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient } from "./storybook.js";
import { mapComponent } from "./mapper.js";

async function connectStorybook(url: string) {
  const spinner = ora("Connecting to Storybook MCP...").start();
  const client = new StorybookClient(url);
  try {
    await client.connect();
    spinner.succeed("Connected to Storybook MCP");
    return client;
  } catch (err) {
    spinner.fail("Failed to connect to Storybook MCP");
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
  .action(async (opts) => {
    const storybook = await connectStorybook(opts.storybook);
    try {
      const spinner = ora("Reading components...").start();
      let entries = await storybook.listComponents();
      spinner.succeed(`Found ${entries.length} components`);

      if (opts.components) {
        const filter = new Set((opts.components as string).split(",").map((s: string) => s.trim().toLowerCase()));
        entries = entries.filter((e) => filter.has(e.name.toLowerCase()) || filter.has(e.id.toLowerCase()));
        console.log(chalk.dim(`  Filtered to ${entries.length}`));
      }

      if (!entries.length) { console.log(chalk.yellow("\nNo components found.")); return; }

      let total = 0, capped = 0;
      for (const entry of entries) {
        try {
          const component = await storybook.getComponent(entry.id, entry.name);
          const def = mapComponent(component);
          const info = def.variantProperties.map((p) => `${p.name}(${p.values.length})`).join(", ");
          const tag = def.wasCapped ? chalk.yellow(" [CAPPED]") : "";
          console.log(`  ${chalk.green("✓")} ${chalk.bold(entry.name)} ${chalk.dim(info || "no variants")} -> ${def.variantCombinations.length} combinations${tag}`);
          total += def.variantCombinations.length;
          if (def.wasCapped) capped++;
        } catch (err) {
          console.log(`  ${chalk.red("✗")} ${chalk.bold(entry.name)} ${chalk.red(String(err))}`);
        }
      }

      console.log(`\n${entries.length} components, ${total} total variants${capped ? `, ${capped} capped` : ""}`);
      console.log(chalk.dim("To write to Figma, use the Claude Code skill or Cursor rules file."));
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
