#!/usr/bin/env node

/**
 * storysync CLI — preview how Storybook components map to Figma variants.
 *
 * Writing to Figma requires the `mcp:connect` OAuth scope, which is only
 * available to first-party MCP clients (Claude Code, Cursor, VS Code, etc.).
 * Use the skill files for the actual Figma write path.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient } from "./storybook.js";
import { mapComponent } from "./mapper.js";

const program = new Command();

program
  .name("storysync")
  .description("Preview how Storybook components map to Figma variants")
  .version("0.1.0");

program
  .command("map")
  .description("Map all Storybook components to Figma variant definitions")
  .requiredOption("--storybook <url>", "URL of the running Storybook instance")
  .option("--components <names>", "Comma-separated list of component names (default: all)")
  .action(async (options) => {
    const spinner = ora();

    spinner.start("Connecting to Storybook MCP...");
    const storybook = new StorybookClient({ url: options.storybook });
    try {
      await storybook.connect();
      spinner.succeed("Connected to Storybook MCP");
    } catch (err) {
      spinner.fail("Failed to connect to Storybook MCP");
      console.error(chalk.red(String(err)));
      console.error(chalk.dim("  Make sure @storybook/addon-mcp is installed and Storybook dev server is running."));
      process.exit(1);
    }

    try {
      spinner.start("Reading components from Storybook...");
      let entries = await storybook.listComponents();
      spinner.succeed(`Found ${entries.length} components`);

      if (options.components) {
        const filter = new Set(
          (options.components as string).split(",").map((s: string) => s.trim().toLowerCase())
        );
        entries = entries.filter(
          (e) => filter.has(e.name.toLowerCase()) || filter.has(e.id.toLowerCase())
        );
        console.log(chalk.dim(`  Filtered to ${entries.length} components`));
      }

      if (entries.length === 0) {
        console.log(chalk.yellow("\nNo components found."));
        return;
      }

      let totalVariants = 0;
      let cappedCount = 0;

      for (const entry of entries) {
        spinner.start(`Processing ${chalk.bold(entry.name)}...`);

        try {
          const component = await storybook.getComponent(entry.id, entry.name);
          const definition = mapComponent(component);

          const propsInfo = definition.variantProperties
            .map((p) => `${p.name}(${p.values.length})`)
            .join(", ");
          const cappedNote = definition.wasCapped ? chalk.yellow(" [CAPPED]") : "";

          spinner.succeed(
            `${chalk.bold(entry.name)} — ${definition.variantProperties.length} props [${propsInfo || "none"}] → ${definition.variantCombinations.length} variants${cappedNote}`
          );

          totalVariants += definition.variantCombinations.length;
          if (definition.wasCapped) cappedCount++;
        } catch (err) {
          spinner.fail(`${chalk.bold(entry.name)} — failed`);
          console.error(chalk.red(`  ${String(err)}`));
        }
      }

      console.log();
      console.log(chalk.bold("Summary"));
      console.log(`  ${entries.length} components → ${totalVariants} total variants`);
      if (cappedCount > 0) {
        console.log(chalk.yellow(`  ${cappedCount} components capped at 256 combinations`));
      }
      console.log();
      console.log(chalk.dim("To write these to Figma, use the Claude Code skill or Cursor rules file."));
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("list")
  .description("List components available in Storybook")
  .requiredOption("--storybook <url>", "URL of the running Storybook instance")
  .action(async (options) => {
    const spinner = ora();

    spinner.start("Connecting to Storybook MCP...");
    const storybook = new StorybookClient({ url: options.storybook });
    try {
      await storybook.connect();
      spinner.succeed("Connected to Storybook MCP");
    } catch (err) {
      spinner.fail("Failed to connect to Storybook MCP");
      console.error(chalk.red(String(err)));
      process.exit(1);
    }

    try {
      const entries = await storybook.listComponents();
      console.log(chalk.bold(`\nFound ${entries.length} components:\n`));
      for (const entry of entries) {
        const storyCount = entry.storyIds?.length ?? 0;
        const storyInfo = storyCount > 0 ? chalk.dim(` (${storyCount} stories)`) : "";
        console.log(`  ${chalk.cyan("•")} ${entry.name} ${chalk.dim(`[${entry.id}]`)}${storyInfo}`);
      }
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("inspect")
  .description("Inspect a component's props and show how they map to Figma variants")
  .requiredOption("--storybook <url>", "URL of the running Storybook instance")
  .requiredOption("--component <name>", "Component name or ID to inspect")
  .action(async (options) => {
    const spinner = ora();

    spinner.start("Connecting to Storybook MCP...");
    const storybook = new StorybookClient({ url: options.storybook });
    try {
      await storybook.connect();
      spinner.succeed("Connected to Storybook MCP");
    } catch (err) {
      spinner.fail("Failed to connect to Storybook MCP");
      console.error(chalk.red(String(err)));
      process.exit(1);
    }

    try {
      const entries = await storybook.listComponents();
      const match = entries.find(
        (e) =>
          e.id.toLowerCase() === options.component.toLowerCase() ||
          e.name.toLowerCase() === options.component.toLowerCase()
      );

      const componentId = match?.id ?? options.component.toLowerCase();
      const componentName = match?.name ?? options.component;

      const component = await storybook.getComponent(componentId, componentName);
      const definition = mapComponent(component);

      console.log(chalk.bold(`\n${component.name}`) + chalk.dim(` [${componentId}]`) + "\n");

      if (component.props.length === 0) {
        console.log(chalk.yellow("  No props found in documentation."));
      } else {
        console.log(chalk.dim("Props → Figma mapping:\n"));
        for (const prop of component.props) {
          const variant = definition.variantProperties.find((v) => v.name === prop.name);
          if (variant) {
            const values = variant.values.join(", ");
            console.log(
              `  ${chalk.green("✓")} ${chalk.bold(prop.name)} (${prop.type.name}) → ${variant.type} [${values}]`
            );
          } else {
            console.log(
              `  ${chalk.dim("✗")} ${chalk.dim(prop.name)} (${prop.type.name}) → ${chalk.dim("skipped")}`
            );
          }
        }
      }

      console.log(
        `\n${chalk.bold(String(definition.variantProperties.length))} variant properties → ${chalk.bold(
          String(definition.variantCombinations.length)
        )} total combinations${definition.wasCapped ? chalk.yellow(" (capped at 256)") : ""}\n`
      );
    } finally {
      await storybook.disconnect();
    }
  });

program.parse();
