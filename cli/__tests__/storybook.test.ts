import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  deriveCategoryFromId,
  parseStories,
  resolveDocsTools,
  selectComponents,
  findComponent,
  toolResultText,
  StorybookClient,
  indexTitles,
  indexUrls,
  titleLeaf,
  componentKey,
  type DocsTools,
  type StorybookClientOptions,
} from "../storybook.js";

test("deriveCategoryFromId: single-word category", () => {
  assert.equal(deriveCategoryFromId("ui-button", "Button"), "UI");
  assert.equal(deriveCategoryFromId("catalyst-badge", "Badge"), "Catalyst");
  assert.equal(deriveCategoryFromId("tailwind-emptystate", "EmptyState"), "Tailwind");
});

test("deriveCategoryFromId: PascalCase name kebab-cases correctly", () => {
  assert.equal(deriveCategoryFromId("ui-iconbutton", "IconButton"), "UI");
  assert.equal(deriveCategoryFromId("ui-delta-pill", "DeltaPill"), "UI");
});

test("deriveCategoryFromId: multi-word category round-trips", () => {
  assert.equal(deriveCategoryFromId("data-display-card", "Card"), "Data Display");
  assert.equal(deriveCategoryFromId("forms-inputs-text-field", "TextField"), "Forms Inputs");
});

test("deriveCategoryFromId: strips story suffix after --", () => {
  assert.equal(deriveCategoryFromId("ui-button--primary", "Button"), "UI");
});

test("deriveCategoryFromId: name with spaces", () => {
  assert.equal(deriveCategoryFromId("ui-card-header", "Card Header"), "UI");
});

test("deriveCategoryFromId: no category prefix returns undefined", () => {
  assert.equal(deriveCategoryFromId("button", "Button"), undefined);
});

test("deriveCategoryFromId: name doesn't match ID returns undefined", () => {
  assert.equal(deriveCategoryFromId("ui-button", "Card"), undefined);
});

// --- parseStories ---

test("parseStories: reads unquoted `Story ID:` labels from addon-mcp docs", () => {
  // The shape @storybook/addon-mcp actually returns.
  const doc = [
    "# Button", "", "ID: forms-button", "", "## Stories", "",
    "### Default", "", "Story ID: forms-button--default", "",
    "### Hardcoded", "", "Story ID: forms-button--hardcoded-ignores-args", "",
  ].join("\n");
  assert.deepEqual(parseStories("forms-button", doc), [
    { id: "forms-button--default", name: "Default" },
    { id: "forms-button--hardcoded-ignores-args", name: "Hardcoded Ignores Args" },
  ]);
});

test("parseStories: still reads quoted id forms", () => {
  const doc = `- Primary (id: \`forms-button--primary\`)\n- Ghost (storyId: "forms-button--ghost")`;
  assert.deepEqual(parseStories("forms-button", doc).map((s) => s.id), [
    "forms-button--primary",
    "forms-button--ghost",
  ]);
});

test("parseStories: does not mistake the component ID for a story ID", () => {
  // `ID: forms-button` has no `--`, so it must not be picked up.
  const stories = parseStories("forms-button", "# Button\n\nID: forms-button\n");
  assert.deepEqual(stories, [{ id: "forms-button--default", name: "Default" }]);
});

test("parseStories: de-duplicates repeated IDs", () => {
  const doc = "Story ID: a-b--default\nreferenced again: id: a-b--default";
  assert.deepEqual(parseStories("a-b", doc).length, 1);
});

test("parseStories: falls back to the documentation ID, not the component name", () => {
  // Guessing from a bare name would produce `button--default`, which does not
  // exist for a component titled Forms/Button.
  assert.deepEqual(parseStories("forms-button", "no story ids here"), [
    { id: "forms-button--default", name: "Default" },
  ]);
});

test("parseStories: ignores words that merely end in \"id\"", () => {
  // Without a word boundary the bare `id` alternative matches the tail of
  // `grid`, `valid`, `pyramid`, ... turning ordinary prop docs into stories.
  for (const line of ["grid: layout--wide", "valid: some--thing", "pyramid: a--b"]) {
    assert.deepEqual(
      parseStories("forms-x", line),
      [{ id: "forms-x--default", name: "Default" }],
      `"${line}" should not yield a story ID`,
    );
  }
});

test("parseStories: still matches a genuine label preceded by punctuation", () => {
  assert.deepEqual(parseStories("x", "(id: forms-button--primary)")[0].id, "forms-button--primary");
  assert.deepEqual(parseStories("x", "- **Ghost** (storyId: `a-b--ghost`)")[0].id, "a-b--ghost");
});

// --- docs tool names ---

const ADDON_MCP_0_7: DocsTools = { list: "list-all-documentation", show: "get-documentation" };
const ADDON_MCP_10_6: DocsTools = { list: "docs-list", show: "docs-show" };

test("resolveDocsTools: reads addon-mcp 10.6's renamed tools", () => {
  const tools = ["stories-preview", "get-storybook-story-instructions", "docs-list", "docs-show", "docs-show-story"];
  assert.deepEqual(resolveDocsTools(tools), ADDON_MCP_10_6);
});

test("resolveDocsTools: still reads the names addon-mcp used through 0.7", () => {
  const tools = ["preview-stories", "get-storybook-story-instructions", "list-all-documentation", "get-documentation"];
  assert.deepEqual(resolveDocsTools(tools), ADDON_MCP_0_7);
});

test("resolveDocsTools: null without both docs tools", () => {
  // Storybook 9, or the docs toolset turned off, lists only the dev tools.
  assert.equal(resolveDocsTools(["preview-stories", "get-storybook-story-instructions"]), null);
  assert.equal(resolveDocsTools(["docs-list"]), null);
});

// --- toolResultText ---

test("toolResultText: an isError result throws rather than being read as documentation", () => {
  // What addon-mcp 10.6 answers when called by a pre-10.6 tool name.
  const result = { content: [{ type: "text", text: "Tool list-all-documentation not found" }], isError: true };
  assert.throws(() => toolResultText("list-all-documentation", result), /"list-all-documentation" failed: Tool list-all-documentation not found/);
});

test("toolResultText: joins the text parts of a successful result", () => {
  const result = { content: [{ type: "text", text: "a" }, { type: "image", data: "" }, { type: "text", text: "b" }] };
  assert.equal(toolResultText("docs-show", result), "a\nb");
});

test("toolResultText: a result with no text throws", () => {
  assert.throws(() => toolResultText("docs-show", { content: [] }), /returned no text content/);
});

// --- StorybookClient against both addon-mcp generations ---

// Captured from the example project, whose responses are identical under
// addon-mcp 0.7 and 10.6 apart from the tool names.
const EXAMPLE_LIST = [
  "# Components", "",
  "- Button (forms-button)", "  - Default (forms-button--default)",
  "- Frozen (forms-frozen)", "  - Default (forms-frozen--default)",
].join("\n");
const EXAMPLE_BUTTON_DOC = [
  "# Button", "", "ID: forms-button", "", "## Stories", "", "### Default", "", "Story ID: forms-button--default", "",
  "## Props", "", "```", "export type Props = {",
  '  variant?: "primary" | "danger" | "outline" = "primary";',
  '  size?: "sm" | "lg" = "sm";',
  "  disabled?: boolean = false;",
  "}", "```",
].join("\n");

/**
 * Connects a StorybookClient to an in-memory stand-in for addon-mcp that
 * offers `tools`, answering the docs list with `list` and docs-show with the
 * entry in `docs` under the ID asked for. Like the real server, a call it
 * can't answer (an unknown tool or component) is an `isError` result, not a
 * protocol error.
 */
async function connectToFakeAddon(
  tools: DocsTools | null,
  list = EXAMPLE_LIST,
  docs: Record<string, string> = { "forms-button": EXAMPLE_BUTTON_DOC },
  options: StorybookClientOptions = {},
): Promise<StorybookClient> {
  const server = new Server({ name: "fake-addon-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
  const names = tools ? [tools.list, tools.show] : ["preview-stories"];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: names.map((name) => ({ name, inputSchema: { type: "object" as const } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
    if (!names.includes(params.name)) return fail(`Tool ${params.name} not found`);
    if (params.name === tools?.list) return { content: [{ type: "text" as const, text: list }] };
    const doc = docs[String(params.arguments?.id)];
    if (doc === undefined) return fail(`Component or Docs Entry not found: "${params.arguments?.id}".`);
    return { content: [{ type: "text" as const, text: doc }] };
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new StorybookClient("http://localhost:6006", options);
  await client.connect(clientSide);
  return client;
}

async function assertReadsExample(tools: DocsTools) {
  const client = await connectToFakeAddon(tools);
  try {
    const entries = await client.listComponents();
    assert.deepEqual(entries.map((e) => [e.id, e.name, e.storyIds]), [
      ["forms-button", "Button", ["forms-button--default"]],
      ["forms-frozen", "Frozen", ["forms-frozen--default"]],
    ]);
    const button = await client.getComponent("forms-button", "Button");
    assert.deepEqual(button.props.map((p) => p.name), ["variant", "size", "disabled"]);
    assert.deepEqual(button.stories, [{ id: "forms-button--default", name: "Default" }]);
  } finally {
    await client.disconnect();
  }
}

test("StorybookClient: reads components through addon-mcp 0.7's tool names", async () => {
  await assertReadsExample(ADDON_MCP_0_7);
});

test("StorybookClient: reads components through addon-mcp 10.6's tool names", async () => {
  await assertReadsExample(ADDON_MCP_10_6);
});

test("StorybookClient: a server without the docs tools fails listComponents with setup advice", async () => {
  const client = await connectToFakeAddon(null);
  try {
    await assert.rejects(client.listComponents(), /missing the docs tools[\s\S]*storysync init/);
    // An upgrade command that runs whatever the project's package manager:
    // npx ships with Node, and Storybook's upgrade finds the package manager
    // itself. `pnpm dlx` is "command not found" on a machine without pnpm.
    await assert.rejects(client.listComponents(), (err: Error) => {
      assert.match(err.message, /upgrade with: npx storybook@latest upgrade$/);
      assert.doesNotMatch(err.message, /pnpm/);
      return true;
    });
  } finally {
    await client.disconnect();
  }
});

test("StorybookClient: an unknown component ID is an error, not a component with no props", async () => {
  const client = await connectToFakeAddon(ADDON_MCP_10_6);
  try {
    await assert.rejects(client.getComponent("forms-buton"), /"docs-show" failed: Component or Docs Entry not found: "forms-buton"/);
  } finally {
    await client.disconnect();
  }
});

// --- Titles from Storybook's index ---

// A shadcn registry's docs list: every component twice, as Base UI's and
// Radix's, and some named for the story's `component` rather than the title.
const REGISTRY_LIST = [
  "# Components", "",
  "- Button (ui-base-button)", "  - Default (ui-base-button--default)",
  "- Button (ui-radix-button)", "  - Default (ui-radix-button--default)",
  "- Toaster (ui-base-sonner)", "  - Default (ui-base-sonner--default)",
  "- Toaster (ui-radix-sonner)", "  - Default (ui-radix-sonner--default)",
  "- Color (design-base-color)", "  - Palette (design-base-color--palette)",
].join("\n");

/** index.json as `storybook dev` serves it, with an entry for each story and docs page. */
function storybookIndex(titles: Record<string, string>): unknown {
  const entries: Record<string, unknown> = {};
  for (const [id, title] of Object.entries(titles)) {
    for (const story of ["default", "docs"]) {
      entries[`${id}--${story}`] = { id: `${id}--${story}`, title, name: story, importPath: `./${id}.stories.tsx`, type: story === "docs" ? "docs" : "story", tags: [] };
    }
  }
  return { v: 5, entries };
}

const REGISTRY_TITLES = {
  "ui-base-button": "ui/base/Button",
  "ui-radix-button": "ui/radix/Button",
  "ui-base-sonner": "ui/base/Sonner",
  "ui-radix-sonner": "ui/radix/Sonner",
  "design-base-color": "design/base/Color",
};

test("StorybookClient: titles and categories come from Storybook's index, not rebuilt from IDs", async () => {
  // Rebuilt from the IDs, ui/base/Button was "UI Base/Button", and the two
  // Toasters, whose IDs don't end in their name, had no title at all, so
  // nothing told them apart.
  const client = await connectToFakeAddon(ADDON_MCP_10_6, REGISTRY_LIST, {}, { readIndex: async () => storybookIndex(REGISTRY_TITLES) });
  try {
    const entries = await client.listComponents();
    assert.deepEqual(entries.map((e) => [e.id, e.name, e.title, e.category, e.titleDerived]), [
      ["ui-base-button", "Button", "ui/base/Button", "ui/base", undefined],
      ["ui-radix-button", "Button", "ui/radix/Button", "ui/radix", undefined],
      ["ui-base-sonner", "Toaster", "ui/base/Sonner", "ui/base", undefined],
      ["ui-radix-sonner", "Toaster", "ui/radix/Sonner", "ui/radix", undefined],
      ["design-base-color", "Color", "design/base/Color", "design/base", undefined],
    ]);
    assert.equal(new Set(entries.map(componentKey)).size, entries.length);
  } finally {
    await client.disconnect();
  }
});

test("StorybookClient: without Storybook's index, titles are rebuilt from IDs as before, and say so", async () => {
  for (const readIndex of [null, async () => { throw new Error("404"); }, async () => "<html>"]) {
    const client = await connectToFakeAddon(ADDON_MCP_10_6, REGISTRY_LIST, {}, { readIndex });
    try {
      const entries = await client.listComponents();
      assert.deepEqual(entries.map((e) => [e.title, e.category, e.titleDerived]), [
        ["UI Base/Button", "UI Base", true],
        ["UI Radix/Button", "UI Radix", true],
        [undefined, undefined, undefined],
        [undefined, undefined, undefined],
        ["Design Base/Color", "Design Base", true],
      ]);
      // With no title, the ID keys them, so they still don't collide.
      assert.deepEqual(entries.slice(2, 4).map(componentKey), ["ui-base-sonner", "ui-radix-sonner"]);
    } finally {
      await client.disconnect();
    }
  }

  // A component the index doesn't list keeps its rebuilt title.
  const client = await connectToFakeAddon(ADDON_MCP_10_6, REGISTRY_LIST, {}, { readIndex: async () => storybookIndex({ "ui-base-button": "ui/base/Button" }) });
  try {
    const [base, radix] = await client.listComponents();
    assert.deepEqual([base.title, base.titleDerived, radix.title, radix.titleDerived], ["ui/base/Button", undefined, "UI Radix/Button", true]);
  } finally {
    await client.disconnect();
  }
});

test("StorybookClient: an index that doesn't answer is given up soon after the docs list, its request with it", async () => {
  // With a timeout of its own, 30 seconds, an index.json that never answered
  // held up every command that lists components for all of it.
  let signal: AbortSignal | undefined;
  const hanging = (s: AbortSignal) => {
    signal = s;
    return new Promise<unknown>(() => {});
  };
  const client = await connectToFakeAddon(ADDON_MCP_10_6, REGISTRY_LIST, {}, { readIndex: hanging, indexGraceMs: 20 });
  try {
    const started = Date.now();
    const [base] = await client.listComponents();
    assert.ok(Date.now() - started < 2_000, `waited ${Date.now() - started}ms`);
    assert.deepEqual([base.title, base.titleDerived], ["UI Base/Button", true]);
    assert.equal(signal?.aborted, true);
  } finally {
    await client.disconnect();
  }

  // One that answers after the docs list, within those seconds, is read.
  const late = () => new Promise<unknown>((resolve) => setTimeout(() => resolve(storybookIndex(REGISTRY_TITLES)), 30));
  const patient = await connectToFakeAddon(ADDON_MCP_10_6, REGISTRY_LIST, {}, { readIndex: late, indexGraceMs: 5_000 });
  try {
    const [base] = await patient.listComponents();
    assert.deepEqual([base.title, base.titleDerived], ["ui/base/Button", undefined]);
  } finally {
    await patient.disconnect();
  }
});

test("indexTitles: each component's title, by the ID its stories share", () => {
  const titles = indexTitles({ v: 5, entries: {
    "forms-button--primary": { id: "forms-button--primary", title: "Forms/Button" },
    "forms-button--docs": { id: "forms-button--docs", title: "Forms/Button", type: "docs" },
    "introduction--docs": { id: "introduction--docs", title: "Introduction", type: "docs" },
    "broken": { title: 1 },
    "blank--a": { id: "blank--a", title: " " },
  } });
  assert.deepEqual([...(titles ?? [])], [["forms-button", "Forms/Button"], ["introduction", "Introduction"]]);
  for (const notAnIndex of [null, "", [], { stories: [] }, { entries: null }]) assert.equal(indexTitles(notAnIndex), null);
});

test("indexUrls: beside the Storybook URL's path, then at its origin's root", () => {
  assert.deepEqual(indexUrls("http://localhost:6006").map(String), ["http://localhost:6006/index.json"]);
  assert.deepEqual(indexUrls("http://localhost:6006/?path=/story/x").map(String), ["http://localhost:6006/index.json"]);
  assert.deepEqual(indexUrls("https://example.com/storybook").map(String), ["https://example.com/storybook/index.json", "https://example.com/index.json"]);
});

test("titleLeaf: the title's last segment, the name Storybook's sidebar shows", () => {
  assert.equal(titleLeaf("ui/base/Form (React Hook Form)"), "Form (React Hook Form)");
  assert.equal(titleLeaf("Button"), "Button");
  assert.equal(titleLeaf(undefined), undefined);
});

/** The components StorybookClient reads from a docs list of `list`. */
async function listed(list: string) {
  const client = await connectToFakeAddon(ADDON_MCP_10_6, list);
  try {
    return await client.listComponents();
  } finally {
    await client.disconnect();
  }
}

test("StorybookClient: MDX docs pages in the docs list are not components", async () => {
  // addon-mcp 10.6 with addon-docs and two unattached MDX pages, one of them
  // a guide titled Guidelines/Button.
  const entries = await listed([
    "# Components", "",
    "- Button (forms-button)", "  - Default (forms-button--default)",
    "- Frozen (forms-frozen)", "  - Default (forms-frozen--default)",
    "", "# Docs", "",
    "- Guidelines/Button (guidelines-button--docs): # Button guidelines Use one primary button per view.",
    "- Foundations/Introduction (foundations-introduction--docs): # Welcome This is the design system introduction.",
  ].join("\n"));
  assert.deepEqual(entries.map((e) => [e.id, e.name, e.storyIds]), [
    ["forms-button", "Button", ["forms-button--default"]],
    ["forms-frozen", "Frozen", ["forms-frozen--default"]],
  ]);
  // The guide no longer makes the name Button ambiguous.
  assert.deepEqual(selectComponents(entries, ["Button"]).map((e) => e.id), ["forms-button"]);
});

test("StorybookClient: docs pages are left out of each source's part of a composed docs list", async () => {
  const entries = await listed([
    "# Design System", "id: design-system", "",
    "## Components", "",
    "- Button (forms-button)", "  - Default (forms-button--default)", "",
    "## Docs", "",
    "- Introduction (introduction--docs): Welcome", "",
    "# Marketing", "id: marketing", "",
    "## Components", "",
    "- Card (card)", "  - Default (card--default)", "",
    "## Docs", "",
    "- Guidelines/Card (guidelines-card--docs)",
  ].join("\n"));
  assert.deepEqual(entries.map((e) => [e.id, e.storyIds]), [
    ["forms-button", ["forms-button--default"]],
    ["card", ["card--default"]],
  ]);
});

test("StorybookClient: a docs page is told from a component by its ID, whatever heading it is under", async () => {
  // A component's ID is its story IDs' part before `--`, so it never holds one.
  const entries = await listed([
    "- Button (forms-button)", "  - Default (forms-button--default)",
    "- Introduction (introduction--docs): Welcome",
    "- Card (data-display-card)", "  - Default (data-display-card--default)",
  ].join("\n"));
  assert.deepEqual(entries.map((e) => [e.id, e.storyIds]), [
    ["forms-button", ["forms-button--default"]],
    ["data-display-card", ["data-display-card--default"]],
  ]);
});

test("StorybookClient: a story name with parentheses doesn't take the place of its ID", async () => {
  // A story named "Playground (all tones)", as addon-mcp 10.6 lists it.
  const entries = await listed([
    "# Components", "",
    "- Badge (display-badge): A small status label.",
    "  - Playground (all tones) (display-badge--playground)",
    "  - Light (inactive) (display-badge--light)",
  ].join("\n"));
  assert.deepEqual(entries.map((e) => [e.id, e.storyIds]), [
    ["display-badge", ["display-badge--playground", "display-badge--light"]],
  ]);
});

test("StorybookClient: a line of a component's description is not a component", async () => {
  // addon-mcp prints the description as written, so the second line of
  // `Labels an item.\n- Use (sparingly) next to titles` is a line of its own.
  const entries = await listed([
    "# Components", "",
    "- Tag (display-tag): Labels an item.",
    "- Use (sparingly) next to titles",
    "  - Basic (display-tag--basic)",
    "- Button (forms-button)", "  - Default (forms-button--default)",
  ].join("\n"));
  assert.deepEqual(entries.map((e) => [e.id, e.name, e.storyIds]), [
    ["display-tag", "Tag", ["display-tag--basic"]],
    ["forms-button", "Button", ["forms-button--default"]],
  ]);
});

test("StorybookClient: a story line without an ID adds no story", async () => {
  const entries = await listed(["- Button (forms-button)", "  - Primary (large)", "  - Default (forms-button--default)"].join("\n"));
  assert.deepEqual(entries[0].storyIds, ["forms-button--default"]);
});

test("StorybookClient: still reads bold, labelled and quoted IDs, non-ASCII IDs and CRLF line ends", async () => {
  const entries = await listed([
    "- **Button** (id: `forms-button`)", "  - **Primary** (id: `forms-button--primary`)",
    "- Schaltfläche (formulare-schaltfläche): Ein Knopf (rund).", "  - Standard (formulare-schaltfläche--standard)",
    "- Forms/Card (\"forms-card\")", "  - Default ('forms-card--default')",
  ].join("\r\n"));
  assert.deepEqual(entries.map((e) => [e.id, e.name, e.title, e.storyIds]), [
    ["forms-button", "Button", "Forms/Button", ["forms-button--primary"]],
    ["formulare-schaltfläche", "Schaltfläche", "Formulare/Schaltfläche", ["formulare-schaltfläche--standard"]],
    ["forms-card", "Card", "Forms/Card", ["forms-card--default"]],
  ]);
});

/** The props StorybookClient reads from a docs-show response of `doc`. */
async function propsOf(doc: string) {
  const client = await connectToFakeAddon(ADDON_MCP_10_6, EXAMPLE_LIST, { "x-card": doc });
  try {
    return (await client.getComponent("x-card")).props.map((p) => [p.name, p.type.raw ?? p.type.name]);
  } finally {
    await client.disconnect();
  }
}

test("StorybookClient: a subcomponent's props are not the component's", async () => {
  // addon-mcp 10.6 for a meta with `subcomponents: { CardHeader }`.
  const props = await propsOf([
    "# Card", "", "ID: display-card", "",
    "## Subcomponents", "", "### CardHeader", "",
    "```", "import { CardHeader } from 'storysync-example';", "```", "",
    "#### Props", "",
    "```", "export type CardHeaderProps = {", "  /**", "    ", "  */",
    '  align?: "start" | "center" = "start";', "  /**", "    ", "  */", "  children?: ReactNode;", "}", "```", "",
    "## Stories", "", "### Default", "", "Story ID: display-card--default", "",
    "```", "import { Card, CardHeader } from 'storysync-example';", "", 'const Default = () => <Card elevation="flat" />;', "```", "",
    "## Props", "",
    "```", "export type Props = {", "  /**", "    ", "  */", '  elevation?: "flat" | "raised" = "flat";', "}", "```",
  ].join("\n"));
  assert.deepEqual(props, [["elevation", '"flat" | "raised"']]);
});

test("StorybookClient: a component description with its own Props or Docs heading keeps the component's props", async () => {
  // A JSDoc description is printed above the stories and may hold markdown
  // headings of its own; only addon-mcp's generated Props block counts.
  const props = await propsOf([
    "# Notice", "", "ID: x-card", "",
    "Shows a message.", "", "## Docs", "", "See the guidelines page.", "", "## Props", "", "Pass `level` to set the colour.", "",
    "## Stories", "", "### Default", "", "Story ID: x-card--default", "",
    "## Props", "",
    "```", "export type Props = {", "  /**", "    ", "  */", '  level?: "info" | "warn" = "info";', "}", "```",
  ].join("\n"));
  assert.deepEqual(props, [["level", '"info" | "warn"']]);
});

test("StorybookClient: a type in an attached MDX page's code is not a prop", async () => {
  // addon-mcp 10.6 for a component with `<Meta of={FrozenStories} />` in an MDX page.
  const props = await propsOf([
    "# Frozen", "", "ID: forms-frozen", "",
    "## Props", "",
    "```", "export type Props = {", "  /**", "    ", "  */", '  variant?: "a" | "b" | "c" = "a";', "}", "```", "",
    "## Docs", "", "### Docs", "",
    'import { Meta } from "@storybook/addon-docs/blocks";', "", "<Meta of={FrozenStories} />", "", "# Frozen", "",
    "```ts", "interface FrozenTheme {", '  surface: "light" | "dark";', "}", "```",
  ].join("\n"));
  assert.deepEqual(props, [["variant", '"a" | "b" | "c"']]);
});

test("StorybookClient: without a Props section, props are still read, but not a subcomponent's or an MDX page's", async () => {
  // A component that documents its API in prose (addon-mcp's apiDescription,
  // printed after the subcomponents, in place of the Props section).
  const props = await propsOf([
    "# Card", "", "ID: x-card", "",
    "## Subcomponents", "", "### CardHeader", "", "#### Props", "",
    "```", "export type CardHeaderProps = {", '  align?: "start" | "center";', "}", "```", "",
    "Card's API:", "",
    "```ts", "export type Props = {", '  elevation?: "flat" | "raised";', "}", "```", "",
    "## Stories", "", "### Default", "", "Story ID: x-card--default", "",
    "## Docs", "", "### Docs", "", "## Props", "",
    "```ts", "interface CardTheme {", '  surface: "light" | "dark";', "}", "```",
  ].join("\n"));
  assert.deepEqual(props, [["elevation", '"flat" | "raised"']]);

  // With no props of its own, a component has none.
  assert.deepEqual(await propsOf([
    "# Card", "", "ID: x-card", "",
    "## Subcomponents", "", "### CardHeader", "", "#### Props", "",
    "```", "export type CardHeaderProps = {", '  align?: "start" | "center";', "}", "```", "",
    "## Stories", "", "### Default", "", "Story ID: x-card--default",
  ].join("\n")), []);
});

test("StorybookClient: a line of a prop's description is not a prop", async () => {
  // addon-mcp 10.6 for `/** Visual tone of the badge.\n * Accepts: "neutral" | "success" | "danger" */`.
  const props = await propsOf([
    "# Badge", "", "ID: display-badge", "",
    "## Props", "",
    "```", "export type Props = {",
    "  /**", "    Visual tone of the badge.", 'Accepts: "neutral" | "success" | "danger"', "  */",
    '  tone?: "neutral" | "success" | "danger" = "neutral";',
    "  /** Shown when: true */", "  dot?: boolean = false;",
    "  /*", "label: string", "  */", "  label: string;",
    "}", "```",
  ].join("\n"));
  assert.deepEqual(props, [["tone", '"neutral" | "success" | "danger"'], ["dot", "boolean"], ["label", "string"]]);
});

// --- selectComponents ---
// Shared by snap, map and diff, so a --components list means the same thing
// to each of them.

const ENTRIES = [
  { id: "forms-button", name: "Button" },
  { id: "forms-icon-button", name: "IconButton" },
  { id: "data-display-card", name: "Card" },
];

test("selectComponents: matches a name or an ID, ignoring case and surrounding space", () => {
  const picked = selectComponents(ENTRIES, [" button", "DATA-DISPLAY-CARD "]);
  assert.deepEqual(picked.map((e) => e.name), ["Button", "Card"]);
});

test("selectComponents: no list, or a list of only empty entries, selects everything", () => {
  assert.equal(selectComponents(ENTRIES, undefined), ENTRIES);
  // `--components ","` used to filter to nothing and pass; it names nothing,
  // so it means what leaving the flag off means.
  assert.equal(selectComponents(ENTRIES, ["", " "]), ENTRIES);
  assert.deepEqual(selectComponents(ENTRIES, ["Card", ""]).map((e) => e.name), ["Card"]);
});

test("selectComponents: a name that matches nothing throws, quoting it as typed and listing what exists", () => {
  assert.throws(
    () => selectComponents(ENTRIES, ["Buton"]),
    { message: '--components matched no component named "Buton". Available: Button, Card, IconButton' },
  );
});

test("selectComponents: a partial typo throws rather than silently dropping the name", () => {
  assert.throws(() => selectComponents(ENTRIES, ["Button", "Crad", "Card"]), /no component named "Crad"\./);
});

test("selectComponents: names from the other side count as matched without selecting anything", () => {
  assert.deepEqual(selectComponents(ENTRIES, ["Button", "Badge"], ["Badge"]).map((e) => e.name), ["Button"]);
  assert.throws(
    () => selectComponents(ENTRIES, ["Bdage"], ["Badge", "Button"]),
    { message: '--components matched no component named "Bdage". Available: Badge, Button, Card, IconButton' },
  );
});

test("selectComponents: an empty Storybook says so rather than listing nothing", () => {
  assert.throws(() => selectComponents([], ["Button"]), /Available: none$/);
});

// --- findComponent ---

test("findComponent: finds inspect's one component by name or ID, ignoring case and surrounding space", () => {
  assert.equal(findComponent(ENTRIES, " iconbutton ").id, "forms-icon-button");
  assert.equal(findComponent(ENTRIES, "DATA-DISPLAY-CARD").name, "Card");
});

const REGISTRY = [
  { id: "ui-base-button", name: "Button", title: "ui/base/Button", category: "ui/base" },
  { id: "ui-radix-button", name: "Button", title: "ui/radix/Button", category: "ui/radix" },
  { id: "ui-base-tooltip", name: "TooltipContent", title: "ui/base/Tooltip", category: "ui/base" },
  { id: "ui-radix-tooltip", name: "TooltipContent", title: "ui/radix/Tooltip", category: "ui/radix" },
];

test("selectComponents: also matches a title, as map prints it, and its last segment, as the sidebar shows it", () => {
  const ids = (names: string[]) => selectComponents(REGISTRY, names).map((e) => e.id);
  assert.deepEqual(ids(["ui/base/Button"]), ["ui-base-button"]);
  assert.deepEqual(ids(["UI/RADIX/TOOLTIP"]), ["ui-radix-tooltip"]);
  assert.deepEqual(ids(["Tooltip"]), ["ui-base-tooltip", "ui-radix-tooltip"]);
  assert.deepEqual(ids(["TooltipContent"]), ["ui-base-tooltip", "ui-radix-tooltip"]);
  // A name several components go by is listed with their IDs, which pick one.
  assert.throws(() => ids(["Tooltp"]), {
    message: '--components matched no component named "Tooltp". Available: Button (ui-base-button, ui-radix-button), ' +
      "Tooltip (ui-base-tooltip, ui-radix-tooltip), TooltipContent (ui-base-tooltip, ui-radix-tooltip)",
  });
  assert.throws(() => findComponent(REGISTRY, "Tooltp"), /^Error: No component named "Tooltp"\. Available: Button \(ui-base-button, ui-radix-button\), Tooltip/);
});

test("findComponent: a name several components share is an error naming each one's title and ID", () => {
  // inspect took the first, Base UI's, and showed it as if it were the only Button.
  assert.throws(
    () => findComponent(REGISTRY, "Button"),
    { message: '"Button" names 2 components: ui/base/Button (ui-base-button), ui/radix/Button (ui-radix-button). Pass the ID or title of the one to inspect.' },
  );
  assert.throws(() => findComponent(REGISTRY, "tooltip"), /"tooltip" names 2 components: ui\/base\/Tooltip \(ui-base-tooltip\), ui\/radix\/Tooltip/);
  assert.equal(findComponent(REGISTRY, "ui-radix-button").id, "ui-radix-button");
  assert.equal(findComponent(REGISTRY, " ui/base/tooltip ").id, "ui-base-tooltip");
  // An ID is one component's, even where another's name is the same word.
  assert.equal(findComponent([...ENTRIES, { id: "button", name: "Button", title: "Button" }], "button").id, "button");
});

test("findComponent: a name that matches nothing throws, listing what exists as selectComponents does", () => {
  assert.throws(
    () => findComponent(ENTRIES, "Buton"),
    { message: 'No component named "Buton". Available: Button, Card, IconButton' },
  );
  assert.throws(() => findComponent([], "Button"), /Available: none$/);
});
