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
  toolResultText,
  StorybookClient,
  type DocsTools,
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
 * offers `tools`. Like the real server, a call it can't answer (an unknown
 * tool or component) is an `isError` result, not a protocol error.
 */
async function connectToFakeAddon(tools: DocsTools | null): Promise<StorybookClient> {
  const server = new Server({ name: "fake-addon-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
  const names = tools ? [tools.list, tools.show] : ["preview-stories"];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: names.map((name) => ({ name, inputSchema: { type: "object" as const } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
    if (!names.includes(params.name)) return fail(`Tool ${params.name} not found`);
    if (params.name === tools?.list) return { content: [{ type: "text" as const, text: EXAMPLE_LIST }] };
    if (params.arguments?.id !== "forms-button") return fail(`Component or Docs Entry not found: "${params.arguments?.id}".`);
    return { content: [{ type: "text" as const, text: EXAMPLE_BUTTON_DOC }] };
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new StorybookClient("http://localhost:6006");
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
