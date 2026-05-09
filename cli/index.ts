#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StorybookClient } from "./storybook.js";
import { FigmaClient, extractFileKey } from "./figma.js";
import { mapComponent } from "./mapper.js";
import { detectTokenSource, extractTokens, compareTokens, hasDrift } from "./tokens.js";
import { inspectComponent, type FieldBinding } from "./inspect.js";
import { generatePushPlan, type ComponentInput } from "./pushgen.js";
import { diffTokens, diffComponents, computeDiffSummary, hasDifferences } from "./diff.js";
import { runInit } from "./init.js";
import { runSetup, type Client } from "./setup.js";
import { VERSION } from "./version.js";
import type { TokenBaseline } from "./tokens.js";
import type { FigmaComponentDefinition } from "./mapper.js";
import type { FigmaVariable, FigmaComponentInfo } from "./figma.js";
import type { TokenDiffEntry, ComponentDiffEntry } from "./diff.js";

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
program.name("storysync").description("Sync design tokens and Storybook components to Figma").version(VERSION);

program
  .command("map")
  .description("Map all Storybook components to Figma variant definitions")
  .requiredOption("--storybook <url>", "Storybook URL")
  .option("--components <names>", "Comma-separated component names")
  .option("--inspect", "Bundle the per-component styling spec from `storysync inspect` inline (recommended for push workflows)")
  .option("--project <path>", "Project root used when --inspect is set", ".")
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

      const results: { name: string; title?: string; category?: string; variantProperties: { name: string; type: string; values: string[]; defaultValue: string }[]; combinations: number; capped: boolean; styling?: ReturnType<typeof inspectComponent>; error: string | null }[] = [];
      let total = 0, capped = 0, failed = 0;

      for (const entry of entries) {
        try {
          const component = await storybook.getComponent(entry.id, entry.name, entry.title, entry.category);
          const def = mapComponent(component);
          const result: typeof results[number] = { name: entry.name, title: entry.title, category: entry.category, variantProperties: def.variantProperties, combinations: def.variantCombinations.length, capped: def.wasCapped, error: null };
          if (opts.inspect) {
            result.styling = inspectComponent(opts.project, entry.name);
          }
          results.push(result);
          if (!json) {
            const info = def.variantProperties.map((p) => `${p.name}(${p.values.length})`).join(", ");
            const tag = def.wasCapped ? chalk.yellow(" [CAPPED]") : "";
            const label = entry.title ?? entry.name;
            const stylingTag = opts.inspect && result.styling
              ? chalk.dim(` styling✓${result.styling.unresolved.length ? ` ${chalk.yellow(`(${result.styling.unresolved.length} unresolved)`)}` : ""}`)
              : opts.inspect && !result.styling
              ? chalk.yellow(" styling✗ source not found")
              : "";
            console.log(`  ${chalk.green("✓")} ${chalk.bold(label)} ${chalk.dim(info || "no variants")} -> ${def.variantCombinations.length} combinations${tag}${stylingTag}`);
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
  .option("--all", "Show all tokens instead of truncating")
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
  .description("Resolve a component's CVA/Tailwind classes into a per-variant styling spec")
  .argument("[component]", "Component name (e.g. Button) or path to a .tsx/.jsx file")
  .option("--project <path>", "Project root to scan", ".")
  .option("--storybook <url>", "Optionally enrich with Storybook prop-to-variant mapping")
  .option("--component <name>", "Legacy alias for the positional component argument")
  .option("--json", "Output JSON instead of formatted text")
  .action(async (nameOrPath: string | undefined, opts) => {
    const target = nameOrPath ?? opts.component;
    if (!target) {
      if (opts.json) {
        console.log(JSON.stringify({ error: "Missing component argument", hint: "Pass a component name or path." }));
      } else {
        console.error(chalk.red("Pass a component name or path. Example: storysync inspect Button"));
      }
      process.exitCode = 1;
      return;
    }
    const result = inspectComponent(opts.project, target);
    if (!result) {
      if (opts.json) {
        console.log(JSON.stringify({ error: "Component not found", name: target, project: opts.project }));
      } else {
        console.error(chalk.red(`Could not find component "${target}".`));
        console.error(chalk.dim("  Pass an explicit path or check that the component lives under src/components, components, or app/components."));
      }
      process.exitCode = 1;
      return;
    }

    let propMapping: { name: string; included: { type: string; values: string[] } | null; type: string }[] | undefined;
    if (opts.storybook) {
      const storybook = await connectStorybook(opts.storybook, !!opts.json);
      try {
        // Use the inspected component's resolved name (e.g. "Button"), not
        // the raw target — when the user passed a path like
        // `src/components/button.tsx`, the path itself isn't a Storybook ID.
        const lookupName = result.name.toLowerCase();
        const entries = await storybook.listComponents();
        const match = entries.find(
          (e) => e.id.toLowerCase() === lookupName || e.name.toLowerCase() === lookupName,
        );
        const component = await storybook.getComponent(match?.id ?? lookupName, match?.name ?? result.name);
        const def = mapComponent(component);
        propMapping = component.props.map((prop) => {
          const v = def.variantProperties.find((vp) => vp.name === prop.name);
          return { name: prop.name, included: v ? { type: v.type, values: v.values } : null, type: prop.type.name };
        });
      } finally {
        await storybook.disconnect();
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ ...result, propMapping }, null, 2));
      return;
    }
    console.log(`\n${chalk.bold(result.name)} ${chalk.dim(result.path ?? "")}`);
    for (const w of result.warnings) console.log(chalk.yellow(`  ! ${w}`));
    const renderField = (k: string, v: unknown, binding?: FieldBinding) => {
      const tag = binding ? chalk.dim(` ← bind to ${binding.collection}/${binding.token}`) : "";
      console.log(`      ${k}: ${v}${tag}`);
    };
    if (Object.keys(result.base).length) {
      console.log(chalk.bold("\n  Base"));
      for (const [k, v] of Object.entries(result.base)) if (v != null) renderField(k, v, result.baseBindings[k as keyof typeof result.baseBindings]);
    }
    for (const variant of result.variants) {
      console.log(chalk.bold(`\n  ${variant.name}${variant.defaultValue ? chalk.dim(` (default: ${variant.defaultValue})`) : ""}`));
      for (const [valueName, styling] of Object.entries(variant.values)) {
        console.log(`    ${chalk.cyan(valueName)}`);
        const binds = variant.bindings[valueName] ?? {};
        for (const [k, v] of Object.entries(styling)) if (v != null) renderField(k, v, binds[k as keyof typeof binds]);
      }
    }
    if (result.unresolved.length) {
      console.log(chalk.bold("\n  Unresolved utilities (ask the user before writing):"));
      for (const u of result.unresolved) console.log(`    ${chalk.yellow(u)}`);
    }
    if (propMapping) {
      console.log(chalk.bold("\n  Storybook prop mapping"));
      for (const p of propMapping) {
        if (p.included) {
          console.log(`    ${chalk.green("✓")} ${p.name} (${p.type}) -> ${p.included.type} [${p.included.values.join(", ")}]`);
        } else {
          console.log(`    ${chalk.dim("✗")} ${p.name} (${p.type}) -> skipped`);
        }
      }
    }
    console.log("");
  });

program
  .command("diff")
  .description("Compare Figma file against code tokens and Storybook components")
  .requiredOption("--figma <url>", "Figma MCP server URL")
  .requiredOption("--file-key <key>", "Figma file key or URL (e.g. 4dWAJJAwIisK5pmyOGDW7p or https://www.figma.com/design/4dWAJJAwIisK5pmyOGDW7p/...)")
  .option("--storybook <url>", "Storybook URL (enables component diff)")
  .option("--project <path>", "Project root to scan for tokens", ".")
  .option("--source <type>", "Token source: tailwind, css, or theme (auto-detect if omitted)")
  .option("--mode <name>", "Figma variable mode to read (default: each collection's first mode)")
  .option("--components <names>", "Comma-separated component names to diff")
  .option("--json", "Output JSON instead of formatted text")
  .option("--strict", "Exit with code 1 if any differences found or Figma reads fail")
  .action(async (opts) => {
    const json = !!opts.json;

    let fileKey: string;
    try {
      fileKey = extractFileKey(opts.fileKey as string);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    }

    const figma = new FigmaClient(opts.figma as string);
    let storybook: StorybookClient | null = null;
    let figmaReadFailed = false;

    try {
      const figmaSpinner = json ? null : ora("Connecting to Figma MCP...").start();
      try {
        await figma.connect();
        figmaSpinner?.succeed("Connected to Figma MCP");
      } catch (err) {
        figmaSpinner?.fail("Failed to connect to Figma MCP");
        console.error(chalk.red(String(err)));
        process.exit(1);
      }

      if (opts.storybook) {
        storybook = await connectStorybook(opts.storybook as string, json);
      }

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

      const codeResult = extractTokens(opts.project as string, opts.source as "tailwind" | "css" | "theme" | undefined);
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
            mapSpinner?.fail("Failed to list Storybook components");
            console.error(chalk.red(String(err)));
            if (opts.strict) process.exitCode = 1;
          }
          if (opts.components) {
            const filter = new Set((opts.components as string).split(",").map((s: string) => s.trim().toLowerCase()));
            entries = entries.filter((e) => filter.has(e.name.toLowerCase()) || filter.has(e.id.toLowerCase()));
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
          mapSpinner?.succeed(`Mapped ${codeComponents.length} Storybook components`);
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
        }));
      } else {
        if (figmaReadFailed) {
          console.log(chalk.yellow("\nFigma read failed — diff results above are partial. See errors for details."));
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
            }
          }
        } else if (storybook && !figmaReadFailed) {
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
          if (cParts.length) console.log(`Components: ${cParts.join(", ")}`);
        }

        if (!figmaReadFailed && !hasDifferences(summary)) {
          console.log(chalk.green("\nNo differences found."));
        }
      }

      if (opts.strict && (figmaReadFailed || hasDifferences(summary) || mappingFailures.length)) process.exitCode = 1;
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
  .option("--force", "Overwrite existing files without prompting")
  .option("--dry-run", "Print what would be written without making changes")
  .option("--yes", "Accept all prompts (also implied in non-TTY environments)")
  .action(async (opts) => {
    const client = String(opts.client).toLowerCase();
    if (client !== "claude" && client !== "cursor" && client !== "codex") {
      console.error(`Unknown client: ${opts.client}. Use one of: claude, cursor, codex.`);
      process.exitCode = 1;
      return;
    }
    await runSetup(client as Client, opts.project as string, {
      force: !!opts.force,
      dryRun: !!opts.dryRun,
      yes: !!opts.yes,
    });
  });

program
  .command("push")
  .description("Generate Figma Plugin API scripts to create variable collections + component sets — agent pipes each script to use_figma verbatim")
  .argument("<figma>", "Figma file URL or raw file key")
  .requiredOption("--storybook <url>", "Storybook URL (with addon-mcp)")
  .option("--project <path>", "Project root to scan for tokens + components", ".")
  .option("--components <names>", "Comma-separated component names to include (default: all)")
  .option("--json", "Output JSON (default — meant to be piped). Without --json, prints a human-readable summary of script labels.")
  .action(async (figma: string, opts) => {
    let fileKey: string;
    try {
      fileKey = extractFileKey(figma);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
    const json = !!opts.json || !process.stdout.isTTY;

    const storybook = await connectStorybook(opts.storybook, json);
    try {
      // Tokens
      const tokensResult = extractTokens(opts.project);

      // Map components
      const entries = await storybook.listComponents();
      const filter = opts.components
        ? new Set((opts.components as string).split(",").map((s: string) => s.trim().toLowerCase()))
        : null;
      const filtered = filter
        ? entries.filter((e) => filter.has(e.name.toLowerCase()) || filter.has(e.id.toLowerCase()))
        : entries;

      const components: ComponentInput[] = [];
      const failures: { name: string; error: string }[] = [];
      for (const entry of filtered) {
        try {
          const sbComp = await storybook.getComponent(entry.id, entry.name, entry.title, entry.category);
          const def = mapComponent(sbComp);
          const styling = inspectComponent(opts.project, entry.name);
          if (!styling) {
            failures.push({ name: entry.name, error: "source file not found by inspect" });
            continue;
          }
          components.push({
            name: entry.name,
            category: entry.category,
            variantProperties: def.variantProperties,
            styling,
          });
        } catch (err) {
          failures.push({ name: entry.name, error: String(err) });
        }
      }

      const plan = generatePushPlan({ fileKey, collections: tokensResult.collections, components });

      if (json) {
        console.log(JSON.stringify({ ...plan, failures }, null, 2));
      } else {
        console.log(chalk.bold(`\nstorysync push — ${fileKey}`));
        console.log(chalk.dim(`  ${plan.scripts.length} script(s) to send to use_figma:`));
        for (const [i, s] of plan.scripts.entries()) {
          console.log(`  ${chalk.green(`${i + 1}.`)} ${s.label}`);
        }
        for (const w of plan.warnings) console.log(chalk.yellow(`  ! ${w}`));
        for (const f of failures) console.log(chalk.red(`  ✗ ${f.name}: ${f.error}`));
        console.log(chalk.dim(`\n  Run with --json to get the executable scripts.`));
      }
    } finally {
      await storybook.disconnect();
    }
  });

program.parse();
