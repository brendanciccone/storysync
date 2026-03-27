#!/usr/bin/env node

/**
 * storysync CLI — read components from Storybook MCP, write them to Figma MCP.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient, type ComponentEntry } from "./storybook.js";
import { FigmaClient } from "./figma.js";
import { mapComponent } from "./mapper.js";

const program = new Command();

program
  .name("storysync")
  .description("The missing link between Storybook MCP and Figma MCP")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate Figma component library from Storybook")
  .requiredOption("--storybook <url>", "URL of the running Storybook instance")
  .option("--figma-file <key>", "Figma file key to write components into")
  .option("--figma-token <token>", "Figma personal access token (or set FIGMA_ACCESS_TOKEN env var)")
  .option("--page <name>", "Figma page name for components", "storysync")
  .option("--components <names>", "Comma-separated list of component names to sync (default: all)")
  .option("--dry-run", "Show what would be synced without writing to Figma")
  .action(async (options) => {
    if (!options.dryRun && !options.figmaFile) {
      console.error(chalk.red("Error: --figma-file is required (or use --dry-run to preview without Figma)."));
      process.exit(1);
    }

    const figmaToken = options.figmaToken ?? process.env.FIGMA_ACCESS_TOKEN;
    if (!figmaToken && !options.dryRun) {
      console.error(
        chalk.red("Error: Figma access token required. Use --figma-token or set FIGMA_ACCESS_TOKEN env var.")
      );
      process.exit(1);
    }

    const spinner = ora();

    // Connect to Storybook MCP
    spinner.start("Connecting to Storybook MCP...");
    const storybook = new StorybookClient({ url: options.storybook });
    try {
      await storybook.connect();
      spinner.succeed("Connected to Storybook MCP");
    } catch (err) {
      spinner.fail("Failed to connect to Storybook MCP");
      console.error(chalk.red(String(err)));
      console.error(chalk.dim("  Make sure @storybook/addon-mcp is installed and Storybook is running."));
      process.exit(1);
    }

    // Connect to Figma MCP
    let figma: FigmaClient | null = null;
    if (!options.dryRun) {
      spinner.start("Connecting to Figma MCP...");
      figma = new FigmaClient({
        fileKey: options.figmaFile,
        accessToken: figmaToken,
        pageName: options.page,
      });
      try {
        await figma.connect();
        spinner.succeed("Connected to Figma MCP");
      } catch (err) {
        spinner.fail("Failed to connect to Figma MCP");
        console.error(chalk.red(String(err)));
        await storybook.disconnect();
        process.exit(1);
      }
    }

    try {
      // List components
      spinner.start("Reading components from Storybook...");
      let entries = await storybook.listComponents();
      spinner.succeed(`Found ${entries.length} components`);

      // Filter if specified
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
        console.log(chalk.yellow("\nNo components to sync."));
        return;
      }

      // Ensure Figma page
      if (figma) {
        spinner.start(`Creating Figma page "${options.page}"...`);
        await figma.ensurePage(options.page);
        spinner.succeed(`Figma page "${options.page}" ready`);
      }

      // Process each component
      let successCount = 0;
      let errorCount = 0;

      for (const entry of entries) {
        spinner.start(`Processing ${chalk.bold(entry.name)}...`);

        try {
          const component = await storybook.getComponent(entry.id, entry.name);

          // Use story IDs from list call if component didn't have them
          if (component.stories.length <= 1 && entry.storyIds && entry.storyIds.length > 0) {
            component.stories = entry.storyIds.map((id) => {
              const namePart = id.split("--").pop() ?? id;
              return {
                id,
                name: namePart.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
              };
            });
          }

          const definition = mapComponent(component);

          if (options.dryRun) {
            const propsInfo = definition.variantProperties
              .map((p) => `${p.name}(${p.values.length})`)
              .join(", ");
            const cappedNote = definition.wasCapped ? " [CAPPED]" : "";
            spinner.succeed(
              `${chalk.bold(entry.name)} — ${definition.variantProperties.length} props [${propsInfo}] → ${definition.variantCombinations.length} variants${cappedNote}`
            );
            successCount++;
            continue;
          }

          const result = await figma!.writeComponent(definition, options.page);
          const cappedNote = definition.wasCapped ? chalk.yellow(" (capped at 256)") : "";
          spinner.succeed(
            `${chalk.bold(entry.name)} → ${result.variantCount} variants (${result.figmaNodeId})${cappedNote}`
          );
          successCount++;
        } catch (err) {
          spinner.fail(`${chalk.bold(entry.name)} — failed`);
          console.error(chalk.red(`  ${String(err)}`));
          errorCount++;
        }
      }

      // Summary
      console.log();
      console.log(chalk.bold(options.dryRun ? "Dry run complete." : "Done."));
      console.log(
        `  ${chalk.green(`${successCount} synced`)}${
          errorCount > 0 ? `, ${chalk.red(`${errorCount} failed`)}` : ""
        }`
      );
    } finally {
      await storybook.disconnect();
      if (figma) await figma.disconnect();
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
  .description("Inspect a component's props and show how they map to Figma")
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
        console.log(chalk.dim("Props → Figma mapping:"));
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
