// Reads simulated Figma files through FigmaClient, over MCP, from a stand-in
// use_figma that runs the plugin code it is sent the way Figma does: pages
// load only as a call switches to them, a call switches at most once, and a
// response over 20kb fails. See figma-standin.ts.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { FigmaClient, FigmaRateLimitError, RESPONSE_GUARD } from "../figma.js";
import type { FigmaComponentInfo } from "../figma.js";
import { startFigmaStandIn, useFigma, set, component, frame, divider, pageId, CODE_LIMIT, RESPONSE_LIMIT } from "./figma-standin.js";
import type { CollectionSpec, FileSpec, PageSpec, RateLimit, UseFigmaCall } from "./figma-standin.js";

const servers: Server[] = [];

after(() => {
  for (const s of servers) s.close();
});

/** Connects a FigmaClient to a stand-in serving `file`, runs `read`, and returns what it read or threw, with every call made. */
async function read<T>(file: Parameters<typeof startFigmaStandIn>[0], what: (client: FigmaClient) => Promise<T>, limit?: RateLimit) {
  const standIn = await startFigmaStandIn(file, limit);
  servers.push(standIn.server);
  const client = new FigmaClient(standIn.url);
  await client.connect();
  try {
    return { result: await what(client), error: null, calls: standIn.calls };
  } catch (err) {
    return { result: null, error: err instanceof Error ? err : new Error(String(err)), calls: standIn.calls };
  } finally {
    await client.disconnect();
  }
}

const components = (client: FigmaClient) => client.getComponents("file-key");

/** The calls that read a page's components on their own: those that switch page. */
const pageCalls = (calls: UseFigmaCall[], id?: string) => calls.filter((c) => c.switches.length && (!id || c.switches[0] === id));

// A library as the push leaves one: each Storybook category on its own page,
// with an empty page after them, as a file often has.
const LIBRARY: FileSpec = {
  pages: [
    { name: "Forms", nodes: [set("Button", { size: ["sm", "md", "lg"], disabled: "BOOLEAN" }), frame("Inputs", [set("Input", { state: ["default", "error"] })])] },
    { name: "Navigation", nodes: [set("Tabs", { variant: ["line", "pill"] }), component("Link")] },
    { name: "Feedback", nodes: [frame("Section", [component("Badge")])] },
    { name: "Archive", nodes: [] },
  ],
};

const LIBRARY_COMPONENTS: FigmaComponentInfo[] = [
  { name: "Button", variantProperties: [{ name: "size", type: "VARIANT", values: ["sm", "md", "lg"] }, { name: "disabled", type: "BOOLEAN", values: ["true", "false"] }], variantCount: 6 },
  { name: "Input", variantProperties: [{ name: "state", type: "VARIANT", values: ["default", "error"] }], variantCount: 2 },
  { name: "Tabs", variantProperties: [{ name: "variant", type: "VARIANT", values: ["line", "pill"] }], variantCount: 2 },
  { name: "Link", variantProperties: [], variantCount: 1 },
  { name: "Badge", variantProperties: [], variantCount: 1 },
];

test("getComponents: finds the components on every page, a page a call, switching once in each", async () => {
  const { result, error, calls } = await read(LIBRARY, components);
  assert.equal(error, null);
  assert.deepEqual(result, LIBRARY_COMPONENTS);
  // One call lists the pages and reads the first, which every call starts on,
  // loaded; then one reads each other page.
  assert.equal(calls.length, LIBRARY.pages.length);
  assert.deepEqual(calls[0].switches, []);
  assert.deepEqual(calls.slice(1).map((c) => c.switches), LIBRARY.pages.slice(1).map((_, i) => [pageId(i + 1)]));
  assert.ok(calls.every((c) => !c.error && c.code.length <= CODE_LIMIT));
});

test("getComponents: a search from figma.root, as diff made before, misses every page but the first", async () => {
  // The stand-in loads pages as use_figma does, so the test above passes only
  // because each call past the first page's switches to its page and searches
  // that page. Run the same calls with either step undone and the other pages
  // go missing.
  const { calls } = await read(LIBRARY, components);
  const reads = pageCalls(calls);
  assert.equal(reads.length, LIBRARY.pages.length - 1);
  async function names(mutate: (code: string) => string): Promise<string[]> {
    const found: string[] = [];
    for (const call of reads) {
      const code = mutate(call.code);
      assert.notEqual(code, call.code, "the mutation changed nothing");
      const answer = await useFigma(LIBRARY, code, []);
      assert.equal(answer.isError, undefined, answer.content[0].text);
      found.push(...(JSON.parse(answer.content[0].text) as { items: FigmaComponentInfo[] }).items.map((c) => c.name));
    }
    return found;
  }
  const unswitched = (code: string) => code.replace("await figma.setCurrentPageAsync(page);", "");
  const rooted = (code: string) => code.replace("page.findAllWithCriteria(", "figma.root.findAllWithCriteria(");

  // diff's old read: no switch, a search from figma.root. Every call sees the
  // first page and nothing else.
  assert.deepEqual(await names((code) => rooted(unswitched(code))), Array(reads.length).fill(["Button", "Input"]).flat());
  // Switching, but searching from figma.root: the first page's components
  // come back from every page.
  const fromRoot = await names(rooted);
  assert.equal(fromRoot.filter((n) => n === "Button").length, reads.length);
  // Searching the page without switching to it: nothing past the first page.
  assert.deepEqual(await names(unswitched), []);
});

test("getComponents: reads a page too big for one response in slices, each as full as the guard allows", async () => {
  const appearance = Array.from({ length: 8 }, (_, i) => `appearance-option-${i}`);
  const library = Array.from({ length: 300 }, (_, i) => set(`Component ${i}`, { appearance, size: ["sm", "md", "lg"], disabled: "BOOLEAN" }));
  const file: FileSpec = { pages: [{ name: "Brand", nodes: [component("Logo")] }, { name: "Library", nodes: library }] };
  const { result, error, calls } = await read(file, components);
  assert.equal(error, null);
  assert.deepEqual(result?.map((c) => c.name), ["Logo", ...library.map((s) => s.name)]);
  assert.ok(result?.every((c) => c.name === "Logo" || (c.variantCount === 48 && c.variantProperties.length === 3)));

  // The whole page is over 100,000 bytes: more than five calls' worth.
  const slices = pageCalls(calls, pageId(1));
  const bytes = slices.reduce((n, c) => n + c.bytes, 0);
  assert.ok(bytes > 5 * RESPONSE_LIMIT, `the page came to ${bytes} bytes`);
  assert.ok(slices.every((c) => !c.error && c.bytes <= RESPONSE_GUARD), slices.map((c) => c.bytes).join(", "));
  // Filled, not cut to a fixed count: every slice but the last is within an
  // entry of the guard, so the page takes as few calls as it can.
  const entry = Math.max(...(result ?? []).map((c) => Buffer.byteLength(JSON.stringify(c)) + 1));
  assert.ok(slices.slice(0, -1).every((c) => c.bytes > RESPONSE_GUARD - entry), `${slices.map((c) => c.bytes).join(", ")}, entries up to ${entry} bytes`);
});

test("getComponents: reads as much of the first page as fits in the page list's call, and the rest in calls of its own", async () => {
  const appearance = Array.from({ length: 8 }, (_, i) => `appearance-option-${i}`);
  const library = Array.from({ length: 300 }, (_, i) => set(`Component ${i}`, { appearance, size: ["sm", "md", "lg"], disabled: "BOOLEAN" }));
  const file: FileSpec = { pages: [{ name: "Library", nodes: library }, { name: "Brand", nodes: [component("Logo")] }] };
  const { result, error, calls } = await read(file, components);
  assert.equal(error, null);
  assert.deepEqual(result?.map((c) => c.name), [...library.map((s) => s.name), "Logo"]);
  // The list's call, switching nowhere, comes within an entry of the guard;
  // the first page goes on from there in calls switching to it.
  const entry = Math.max(...(result ?? []).map((c) => Buffer.byteLength(JSON.stringify(c)) + 1));
  assert.deepEqual(calls[0].switches, []);
  assert.ok(calls[0].bytes > RESPONSE_GUARD - entry && calls[0].bytes <= RESPONSE_GUARD, String(calls[0].bytes));
  const rest = pageCalls(calls, pageId(0));
  assert.ok(rest.length > 1);
  assert.equal(calls.length, 1 + rest.length + 1);
  assert.ok(calls.every((c) => !c.error && c.bytes <= RESPONSE_GUARD), calls.map((c) => c.bytes).join(", "));
});

test("getComponents: a first page with no room beside the page list is read in a call of its own", async () => {
  // The page list takes about half the guard, and the icon set more than the
  // other half, though it fits in a call alone.
  const icons = Array.from({ length: 500 }, (_, i) => `icon-glyph-${i}`);
  const others = Array.from({ length: 20 }, (_, i) => ({ name: `${"A page with a very long name ".repeat(14)}${i}`, nodes: [] }));
  const file: FileSpec = { pages: [{ name: "Icons", nodes: [set("Icon", { name: icons })] }, ...others] };
  const { result, error, calls } = await read(file, components);
  assert.equal(error, null);
  assert.deepEqual(result?.map((c) => [c.name, c.variantCount]), [["Icon", 500]]);
  assert.ok(calls[0].bytes > RESPONSE_GUARD / 2 && !calls[0].switches.length, String(calls[0].bytes));
  assert.equal(pageCalls(calls, pageId(0)).length, 1);
  assert.equal(calls.length, 1 + file.pages.length);
  assert.ok(calls.every((c) => !c.error && c.bytes <= RESPONSE_GUARD), calls.map((c) => c.bytes).join(", "));
});

test("getComponents: a page list that leaves the first page no room still moves on to it", async () => {
  // The list's call measures the first page's slice with \`next\` at the
  // page's length. Where that comes just over the guard and \`next: 0\` just
  // under, an empty slice pointing back at 0 came back, read as a slice that
  // doesn't move on, and failed the whole read. The window is a byte or two
  // wide, so sweep one page name across it.
  const nodes = Array.from({ length: 120 }, (_, i) => component(`Component ${i}`));
  const filler = Array.from({ length: 29 }, (_, i) => ({ name: `${"A page with a long name ".repeat(23)}${i}`, nodes: [] }));
  const fileFor = (first: PageSpec["nodes"], pad: number): FileSpec => ({
    pages: [{ name: "Library", nodes: first }, ...filler, { name: "x".repeat(pad), nodes: [] }],
  });
  // With nothing on the first page, the list's call is the list alone.
  const base = await read(fileFor([], 0), components);
  assert.equal(base.error, null);
  const room = RESPONSE_GUARD - base.calls[0].bytes;
  assert.ok(room > 40, String(room));
  for (let pad = room - 40; pad <= room + 10; pad++) {
    const { result, error, calls } = await read(fileFor(nodes, pad), components);
    assert.equal(error, null, `pad ${pad}: ${error?.message}`);
    assert.equal(result?.length, nodes.length, `pad ${pad}`);
    assert.ok(calls.every((c) => !c.error && c.bytes <= RESPONSE_GUARD), `pad ${pad}: ${calls.map((c) => c.bytes).join(", ")}`);
  }
});

test("getComponents: measures a slice in bytes, so names in other scripts still fit under 20kb", async () => {
  // A CJK character is one character of JSON and three bytes of it. Counted
  // in characters, a slice of these would come to about twice 20kb.
  const sizes = ["小型", "中型", "大型", "超大型"];
  const library = Array.from({ length: 200 }, (_, i) => set(`按钮组件第${i}号`, { 尺寸: sizes, 外观: ["主要按钮样式", "次要按钮样式", "幽灵按钮样式"] }));
  const { result, error, calls } = await read({ pages: [{ name: "组件", nodes: library }] }, components);
  assert.equal(error, null);
  assert.equal(result?.length, library.length);
  assert.ok(pageCalls(calls).length > 1);
  assert.ok(calls.every((c) => !c.error && c.bytes <= RESPONSE_GUARD), calls.map((c) => c.bytes).join(", "));
});

test("getComponents: a component too big for any response fails the read, naming it and its page", async () => {
  // 1,500 icons as one set's variant options: its entry alone passes 20kb.
  const icons = Array.from({ length: 1500 }, (_, i) => `icon-glyph-${i}`);
  const file: FileSpec = { pages: [LIBRARY.pages[0], { name: "Icons", nodes: [component("Logo"), set("Icon", { name: icons })] }] };
  const { result, error, calls } = await read(file, components);
  assert.equal(result, null);
  assert.match(error?.message ?? "", /^Failed to read page "Icons" of the Figma file: Figma MCP tool "use_figma" failed: Error: Component "Icon" on page "Icons" comes to \d+ bytes as use_figma returns it, more than the 17000 one call can carry under its 20kb response limit$/);
  // The read refused it before use_figma had to: no response passed 20kb.
  assert.ok(calls.every((c) => c.bytes <= RESPONSE_GUARD && !/exceeds/.test(c.error ?? "")));
  // Logo, before it, came back in the slice before.
  assert.equal(pageCalls(calls, pageId(1)).length, 2);
});

test("getComponents: a too-big component named like a rate-limit notice is still reported as too big", async () => {
  // The guard's refusal names the component and its page, which are the
  // user's words; they mustn't turn it into a rate limit.
  const icons = Array.from({ length: 1500 }, (_, i) => `icon-glyph-${i}`);
  const file: FileSpec = { pages: [{ name: "Too many requests", nodes: [set("Rate limit reached", { name: icons })] }] };
  const { error } = await read(file, components);
  assert.ok(error && !(error instanceof FigmaRateLimitError), error?.message);
  assert.match(error.message, /Component "Rate limit reached" on page "Too many requests" comes to \d+ bytes/);
});

test("getComponents: a page that can't be read fails the read, naming the page", async () => {
  // The first page too, though the page list's call reads it as well.
  for (const name of ["Forms", "Navigation"]) {
    const file: FileSpec = { ...LIBRARY, failingPages: { [name]: "Page could not be loaded" } };
    const { result, error } = await read(file, components);
    assert.equal(result, null);
    assert.equal(error?.message, `Failed to read page "${name}" of the Figma file: Figma MCP tool "use_figma" failed: Error: Page could not be loaded`);
  }
});

test("getComponents: skips page dividers, which hold nothing and can't be switched to", async () => {
  // Dividers between a file's sections are pages to the plugin API, flagged
  // isPageDivider. Switching to one fails in the stand-in, so a read that
  // switched to every page would fail here, or spend a call on nothing.
  const file: FileSpec = { pages: [LIBRARY.pages[0], divider(), LIBRARY.pages[1], LIBRARY.pages[2], divider("———"), LIBRARY.pages[3]] };
  const dividers = [pageId(1), pageId(4)];
  const { result, error, calls } = await read(file, components);
  assert.equal(error, null);
  assert.deepEqual(result, LIBRARY_COMPONENTS);
  assert.equal(calls.length, LIBRARY.pages.length);
  assert.ok(calls.every((c) => !c.error && !c.switches.some((id) => dividers.includes(id))), calls.map((c) => c.error).join(", "));
  const listed = await read(file, (client) => client.getPages("file-key"));
  assert.deepEqual(listed.result?.map((p) => p.id), [0, 2, 3, 5].map(pageId));
});

test("getPages: lists a file of more pages than one response holds, in slices", async () => {
  const pages = Array.from({ length: 700 }, (_, i) => ({ name: `Page with a fairly long name ${i}`, nodes: [] }));
  const { result, error, calls } = await read({ pages }, (client) => client.getPages("file-key"));
  assert.equal(error, null);
  assert.deepEqual(result, pages.map((p, i) => ({ id: pageId(i), name: p.name })));
  assert.ok(calls.length > 1 && calls.every((c) => !c.error && !c.switches.length && c.bytes <= RESPONSE_GUARD), calls.map((c) => c.bytes).join(", "));
});

// --- Variables ---

const hex = (i: number) => ({ r: (i % 7) / 7, g: (i % 5) / 5, b: (i % 3) / 3, a: 1 });

const TOKENS: FileSpec = {
  pages: [{ name: "Cover", nodes: [] }],
  collections: [
    {
      name: "Colors",
      modes: ["Light", "Dark"],
      variables: [
        ...Array.from({ length: 400 }, (_, i) => ({ name: `color/palette-${Math.floor(i / 10)}/${(i % 10 + 1) * 100}`, type: "COLOR" as const, values: [hex(i), hex(i + 1)] })),
        { name: "color/overlay", type: "COLOR", values: [{ r: 0, g: 0, b: 0, a: 0.5 }, { r: 1, g: 1, b: 1, a: 0.5 }] },
      ],
    },
    { name: "Semantic", modes: ["Light", "Dark"], variables: [{ name: "primary", type: "COLOR", values: [{ alias: "Colors/color/palette-0/100" }, { alias: "Colors/color/palette-0/100" }] }] },
    { name: "Spacing", modes: ["Default"], variables: Array.from({ length: 50 }, (_, i) => ({ name: `space/${i}`, type: "FLOAT" as const, values: [i * 4] })) },
  ],
};

test("getVariables: reads every variable a slice at a time, in each collection's first mode", async () => {
  const { result, error, calls } = await read(TOKENS, (client) => client.getVariables("file-key"));
  assert.equal(error, null);
  assert.equal(result?.length, 452);
  assert.ok(calls.length > 1 && calls.every((c) => !c.error && c.bytes <= RESPONSE_GUARD && !c.switches.length), calls.map((c) => c.bytes).join(", "));
  assert.equal(new Set(result?.map((v) => `${v.collection}/${v.name}`)).size, 452);
  const byName = new Map(result?.map((v) => [`${v.collection}/${v.name}`, v]));
  assert.deepEqual(byName.get("Colors/color/palette-0/100"), { name: "color/palette-0/100", resolvedType: "COLOR", value: "#000000", collection: "Colors", mode: "Light" });
  assert.equal(byName.get("Colors/color/overlay")?.value, "#00000080");
  assert.equal(byName.get("Semantic/primary")?.value, "#000000");
  assert.deepEqual(byName.get("Spacing/space/3"), { name: "space/3", resolvedType: "FLOAT", value: "12", collection: "Spacing", mode: "Default" });
});

test("getVariables: --mode reads that mode, from the collections that have it", async () => {
  const { result, error } = await read(TOKENS, (client) => client.getVariables("file-key", "Dark"));
  assert.equal(error, null);
  assert.equal(result?.length, 402);
  assert.ok(result?.every((v) => v.mode === "Dark" && v.collection !== "Spacing"));
  assert.equal(result?.find((v) => v.name === "color/palette-0/100")?.value, "#243355");
  assert.equal(result?.find((v) => v.name === "color/overlay")?.value, "#ffffff80");
});

test("getVariables: leaves out ids that read as null, wherever the slices fall, and reads every variable once", async () => {
  // getVariableByIdAsync returns null for an id a collection lists with no
  // variable behind it. Nine ids in ten here are one, through several slices:
  // each slice has to go on from the last id it looked at, not from how many
  // variables it returned, and return none of the nulls, nor count them
  // toward the guard, where they would come to a call's worth.
  const listed = Array.from({ length: 4000 }, (_, i) => i % 10 ? null : { name: `color/${i}`, type: "COLOR" as const, values: [hex(i)] });
  const file = (variables: CollectionSpec["variables"]): FileSpec => ({ pages: [{ name: "Cover", nodes: [] }], collections: [{ name: "Colors", modes: ["Light"], variables }] });
  const { result, error, calls } = await read(file(listed), (client) => client.getVariables("file-key"));
  assert.equal(error, null);
  assert.equal(result?.length, 400);
  assert.equal(new Set(result?.map((v) => v.name)).size, 400);
  assert.ok(calls.length > 2 && calls.every((c) => !c.error && c.bytes <= RESPONSE_GUARD), calls.map((c) => c.bytes).join(", "));
  // The nulls take no room: the same variables come back, in as many calls,
  // as from the collection without them.
  const without = await read(file(listed.filter((v) => v !== null)), (client) => client.getVariables("file-key"));
  assert.deepEqual(result, without.result);
  assert.equal(calls.length, without.calls.length);
});

// --- What use_figma hands back ---

test("reads: a slice that comes back JSON-encoded again, or with text around it, still parses", async () => {
  for (const wrap of [(t: string) => JSON.stringify(t), (t: string) => `Result:\n${t}\nDone.`]) {
    const { result, error } = await read(async (code, calls) => {
      const answer = await useFigma(LIBRARY, code, calls);
      return answer.isError ? answer : { content: [{ type: "text", text: wrap(answer.content[0].text) }] };
    }, components);
    assert.equal(error, null);
    assert.deepEqual(result, LIBRARY_COMPONENTS);
  }
});

test("reads: a slice that doesn't move on is an error, not a loop", { timeout: 10_000 }, async () => {
  const { error } = await read(async () => ({ content: [{ type: "text", text: JSON.stringify({ total: 3, next: 0, items: [] }) }] }), components);
  assert.equal(error?.message, "use_figma returned pages from 0 saying to read on from 0 of 3");
});

test("reads: a total that changes between slices is an error, since items would be skipped or read twice", async () => {
  let total = 4;
  const { error } = await read(async () => ({ content: [{ type: "text", text: JSON.stringify({ total: total++, next: 1, items: [] }) }] }), (client) => client.getVariables("file-key"));
  assert.equal(error?.message, "The Figma file changed while its variables were read: 4 at first, then 5. Run diff again.");
});

test("reads: a response that isn't a slice fails with what came back", async () => {
  const { error } = await read(async () => ({ content: [{ type: "text", text: "[]" }] }), components);
  assert.match(error?.message ?? "", /^Failed to parse Figma pages response\. .* Got: \[\]$/);
});

test("reads: a call refused for the rate limit fails the read saying so, and to run diff later, not as a page that can't be read", async () => {
  // Figma's MCP server caps a seat's tool calls a minute and a day, and past
  // the cap refuses each call, with HTTP 429 or a message saying so.
  for (const refuse of ["http", "result", "rpc"] as const) {
    // LIBRARY takes four calls: the third, reading the Feedback page, is refused.
    const { result, error, calls } = await read(LIBRARY, components, { calls: 2, refuse });
    assert.equal(result, null);
    assert.ok(error instanceof FigmaRateLimitError, `${refuse}: ${error?.message}`);
    assert.match(error.message, /^Figma's MCP server rate limit was hit: it caps each seat's tool calls a minute and a day \(.*\)\. Run diff again later\. Figma said: \S/);
    assert.doesNotMatch(error.message, /Failed to read page/);
    // The read stopped at the refusal rather than calling on.
    assert.deepEqual(calls.map((c) => c.error ?? null), [null, null, "rate limited"]);

    const variables = await read(TOKENS, (client) => client.getVariables("file-key"), { calls: 0, refuse });
    assert.ok(variables.error instanceof FigmaRateLimitError, `${refuse}: ${variables.error?.message}`);
  }
});
