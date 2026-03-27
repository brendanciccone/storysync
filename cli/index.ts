#!/usr/bin/env node

/**
 * storysync CLI — read components from Storybook MCP, write them to Figma MCP.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient } from "./storybook.js";
import { FigmaClient } from "./figma.js";
import { Renderer } from "./renderer.js";
import { mapComponent, type FigmaComponentDefinition } from "./mapper.js";

const program = new Command();

program
  .name("storysync")
  .description("The missing link between Storybook MCP and Figma MCP")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate Figma component library from Storybook")
  .requiredOption("--storybook <url>", "URL of the running Storybook instance")
  .requiredOption("--figma-file <key>", "Figma file key to write components into")
  .option("--figma-token <token>", "Figma personal access token (or set FIGMA_ACCESS_TOKEN env var)")
  .option("--page <name>", "Figma page name for components", "storysync")
  .option("--no-screenshots", "Skip capturing screenshots")
  .option("--components <names>", "Comma-separated list of component names to sync (default: all)")
  .option("--viewport-width <width>", "Screenshot viewport width", "800")
  .option("--viewport-height <height>", "Screenshot viewport height", "600")
  .action(async (options) => {
    const figmaToken = options.figmaToken ?? process.env.FIGMA_ACCESS_TOKEN;
    if (!figmaToken) {
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
      process.exit(1);
    }

    // Connect to Figma MCP
    spinner.start("Connecting to Figma MCP...");
    const figma = new FigmaClient({
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

    // Set up renderer
    let renderer: Renderer | null = null;
    if (options.screenshots !== false) {
      spinner.start("Launching screenshot renderer...");
      renderer = new Renderer({
        storybookUrl: options.storybook,
        width: parseInt(options.viewportWidth, 10),
        height: parseInt(options.viewportHeight, 10),
      });
      try {
        await renderer.launch();
        spinner.succeed("Screenshot renderer ready");
      } catch (err) {
        spinner.warn("Screenshot renderer unavailable — continuing without screenshots");
        console.error(chalk.yellow(String(err)));
        renderer = null;
      }
    }

    try {
      // List components
      spinner.start("Reading components from Storybook...");
      let componentNames = await storybook.listComponents();
      spinner.succeed(`Found ${componentNames.length} components`);

      // Filter if specified
      if (options.components) {
        const filter = new Set(
          (options.components as string).split(",").map((s: string) => s.trim())
        );
        componentNames = componentNames.filter((name) => filter.has(name));
        console.log(chalk.dim(`  Filtered to ${componentNames.length} components`));
      }

      // Ensure Figma page
      spinner.start(`Creating Figma page "${options.page}"...`);
      await figma.ensurePage(options.page);
      spinner.succeed(`Figma page "${options.page}" ready`);

      // Process each component
      let successCount = 0;
      let errorCount = 0;

      for (const componentName of componentNames) {
        spinner.start(`Processing ${chalk.bold(componentName)}...`);

        try {
          // Read from Storybook
          const component = await storybook.getComponent(componentName);

          // Map to Figma structure
          const definition: FigmaComponentDefinition = mapComponent(component);

          // Capture screenshots
          let screenshots = new Map<string, Buffer>();
          if (renderer && component.stories.length > 0) {
            const primaryStory = component.stories[0];
            screenshots = await renderer.captureVariants(
              componentName,
              primaryStory.id,
              definition.variantCombinations
            );
          }

          // Write to Figma
          const result = await figma.writeComponent(definition, screenshots, options.page);

          spinner.succeed(
            `${chalk.bold(componentName)} → ${result.variantCount} variants (${result.figmaNodeId})`
          );
          successCount++;
        } catch (err) {
          spinner.fail(`${chalk.bold(componentName)} — failed`);
          console.error(chalk.red(`  ${String(err)}`));
          errorCount++;
        }
      }

      // Summary
      console.log();
      console.log(chalk.bold("Done."));
      console.log(
        `  ${chalk.green(`${successCount} synced`)}${
          errorCount > 0 ? `, ${chalk.red(`${errorCount} failed`)}` : ""
        }`
      );
    } finally {
      await storybook.disconnect();
      await figma.disconnect();
      if (renderer) await renderer.close();
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
      const components = await storybook.listComponents();
      console.log(chalk.bold(`\nFound ${components.length} components:\n`));
      for (const name of components) {
        console.log(`  ${chalk.cyan("•")} ${name}`);
      }
    } finally {
      await storybook.disconnect();
    }
  });

program
  .command("inspect")
  .description("Inspect a component's props and show how they map to Figma")
  .requiredOption("--storybook <url>", "URL of the running Storybook instance")
  .requiredOption("--component <name>", "Component name to inspect")
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
      const component = await storybook.getComponent(options.component);
      const definition = mapComponent(component);

      console.log(chalk.bold(`\n${component.name}\n`));

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

      console.log(
        `\n${chalk.bold(String(definition.variantProperties.length))} variant properties → ${chalk.bold(
          String(definition.variantCombinations.length)
        )} total combinations\n`
      );
    } finally {
      await storybook.disconnect();
    }
  });

program.parse();
