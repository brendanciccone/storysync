// A stand-in for Figma's use_figma tool, for tests: it runs the plugin code it
// is sent against a simulated Figma file, under the limits the real tool
// sets, so the CLI's reads are checked as Figma would run them, with no
// network and no Figma file.
//
// - Pages load incrementally. Each call starts on the first page with only it
//   loaded; a page loads when the call switches to it; a search sees only
//   loaded pages, whether it starts from figma.root or from an unloaded page.
// - A call switches page at most once, as Figma's figma-use guidance says;
//   a second switch fails the call here, so no test can pass by looping pages.
// - figma.loadAllPagesAsync() is not implemented, and figma.currentPage can't
//   be set, as in use_figma.
// - A page divider is a page, with isPageDivider true and nothing on it, as
//   Figma's plugin API types it. Switching to one fails the call here, so a
//   read that switches to every page in the list fails on a file with one.
// - The code is at most 50,000 characters, use_figma's input schema's limit.
// - The return value is serialized as JSON, and a response over 20kb, counted
//   as 20,000 bytes of that JSON, fails the call.
//
// A failed call answers as an MCP tool does when it can't: an `isError` result
// with the reason as text. The server can also be given a rate limit, past
// which it refuses every call, as Figma's MCP server does past a seat's
// limit.

import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const CODE_LIMIT = 50_000;
export const RESPONSE_LIMIT = 20_000;

/** A component set: each property's options, or BOOLEAN, with one variant per combination. */
export interface SetSpec {
  type: "COMPONENT_SET";
  name: string;
  options: Record<string, string[] | "BOOLEAN">;
}

/** A component outside any set. */
export interface ComponentSpec {
  type: "COMPONENT";
  name: string;
}

/** A frame or section holding other nodes, as a page's components often are. */
export interface FrameSpec {
  type: "FRAME";
  name: string;
  children: NodeSpec[];
}

export type NodeSpec = SetSpec | ComponentSpec | FrameSpec;

export interface PageSpec {
  name: string;
  nodes: NodeSpec[];
  /** A page divider: a line in the page list, holding nothing. */
  divider?: boolean;
}

export interface CollectionSpec {
  name: string;
  modes: string[];
  /** Each variable's value in each mode, in `modes` order. `{ alias: "Collection/name" }` refers to another variable. */
  variables: { name: string; type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN"; values: unknown[] }[];
}

export interface FileSpec {
  pages: PageSpec[];
  collections?: CollectionSpec[];
  /** Pages whose every call fails, with this reason, as a page Figma can't load would. */
  failingPages?: Record<string, string>;
}

/** One use_figma call: the pages it switched to, the bytes it returned, and why it failed, if it did. */
export interface UseFigmaCall {
  code: string;
  switches: string[];
  bytes: number;
  error?: string;
}

export const set = (name: string, options: SetSpec["options"]): SetSpec => ({ type: "COMPONENT_SET", name, options });
export const component = (name: string): ComponentSpec => ({ type: "COMPONENT", name });
export const frame = (name: string, children: NodeSpec[]): FrameSpec => ({ type: "FRAME", name, children });
/** A page divider, named as Figma names one it creates. */
export const divider = (name = "---"): PageSpec => ({ name, nodes: [], divider: true });

/** Page ids as Figma gives them: 0:1, 0:2, ... */
export const pageId = (index: number) => `0:${index + 1}`;

type Node = { id: string; type: string; name: string; parent: Node | null; children: Node[]; [key: string]: unknown };

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

function combinations(options: SetSpec["options"]): number {
  return Object.values(options).reduce((n, values) => n * (values === "BOOLEAN" ? 2 : values.length), 1);
}

/** Builds one call's figma global over the file, loading pages as use_figma does. */
function figmaFor(file: FileSpec, call: UseFigmaCall): unknown {
  let nextId = 1;
  const loaded = new Set<string>([pageId(0)]);

  function build(spec: NodeSpec, parent: Node): Node {
    const node: Node = { id: `1:${nextId++}`, type: spec.type, name: spec.name, parent, children: [] };
    if (spec.type === "FRAME") {
      node.children = spec.children.map((c) => build(c, node));
    } else if (spec.type === "COMPONENT_SET") {
      node.componentPropertyDefinitions = Object.fromEntries(Object.entries(spec.options).map(([prop, values]) =>
        [prop, values === "BOOLEAN" ? { type: "BOOLEAN", defaultValue: false } : { type: "VARIANT", defaultValue: values[0], variantOptions: values }]));
      node.children = Array.from({ length: combinations(spec.options) }, (_, i): Node => {
        const variant: Node = { id: `1:${nextId++}`, type: "COMPONENT", name: `variant ${i}`, parent: node, children: [] };
        // Figma throws on reading a variant's componentPropertyDefinitions.
        Object.defineProperty(variant, "componentPropertyDefinitions", {
          get() { throw new Error("Can only get component property definitions of a component set or non-variant component"); },
        });
        return variant;
      });
    }
    return node;
  }

  function search(node: Node, types: string[], out: Node[]): Node[] {
    for (const child of node.children) {
      if (types.includes(child.type)) out.push(child);
      search(child, types, out);
    }
    return out;
  }

  const pages = file.pages.map((spec, index) => {
    const page: Node = { id: pageId(index), type: "PAGE", name: spec.name, parent: null, children: [], isPageDivider: Boolean(spec.divider) };
    page.children = spec.nodes.map((n) => build(n, page));
    page.findAllWithCriteria = ({ types }: { types: string[] }) => {
      const reason = file.failingPages?.[spec.name];
      if (reason && loaded.has(page.id)) throw new Error(reason);
      return loaded.has(page.id) ? search(page, types, []) : [];
    };
    return page;
  });
  let currentPage = pages[0];

  const collections = (file.collections ?? []).map((c, ci) => ({
    id: `VariableCollectionId:${ci}`,
    name: c.name,
    modes: c.modes.map((name, mi) => ({ modeId: `${ci}:${mi}`, name })),
    variableIds: c.variables.map((_, vi) => `VariableID:${ci}:${vi}`),
  }));
  const variableIds = new Map<string, string>();
  (file.collections ?? []).forEach((c, ci) => c.variables.forEach((v, vi) => variableIds.set(`${c.name}/${v.name}`, `VariableID:${ci}:${vi}`)));
  const variables = new Map<string, unknown>();
  (file.collections ?? []).forEach((c, ci) => c.variables.forEach((v, vi) => {
    const valuesByMode = Object.fromEntries(v.values.map((value, mi) => {
      const alias = (value as { alias?: string } | null)?.alias;
      return [`${ci}:${mi}`, alias ? { type: "VARIABLE_ALIAS", id: variableIds.get(alias) } : value];
    }));
    variables.set(`VariableID:${ci}:${vi}`, { id: `VariableID:${ci}:${vi}`, name: v.name, resolvedType: v.type, valuesByMode });
  }));

  return {
    root: {
      type: "DOCUMENT",
      children: pages,
      // Walks every loaded page, and only those.
      findAllWithCriteria: ({ types }: { types: string[] }) => pages.flatMap((p) => (p.findAllWithCriteria as (c: unknown) => Node[])({ types })),
    },
    get currentPage() {
      return currentPage;
    },
    set currentPage(_page: unknown) {
      throw new Error("Setting figma.currentPage is not supported");
    },
    getNodeByIdAsync: async (id: string) => pages.find((p) => p.id === id) ?? null,
    setCurrentPageAsync: async (page: Node) => {
      call.switches.push(page.id);
      if (call.switches.length > 1) throw new Error(`switched page ${call.switches.length} times in one call; Figma's guidance is once`);
      if (page.isPageDivider) throw new Error(`Page ${page.id} is a page divider, which can't be the current page`);
      loaded.add(page.id);
      currentPage = page;
    },
    loadAllPagesAsync: async () => {
      throw new Error("figma.loadAllPagesAsync is not implemented");
    },
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getVariableByIdAsync: async (id: string) => variables.get(id) ?? null,
    },
  };
}

/** Runs one use_figma call against the file, recording it in `calls`, and answers as the tool would. */
export async function useFigma(file: FileSpec, code: string, calls: UseFigmaCall[]): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const call: UseFigmaCall = { code, switches: [], bytes: 0 };
  calls.push(call);
  const fail = (reason: string) => {
    call.error = reason;
    return { content: [{ type: "text" as const, text: reason }], isError: true };
  };
  if (code.length > CODE_LIMIT) return fail(`code is ${code.length} characters, more than ${CODE_LIMIT}`);
  let value: unknown;
  try {
    value = await new AsyncFunction("figma", code)(figmaFor(file, call));
  } catch (err) {
    return fail(String(err));
  }
  const text = JSON.stringify(value) ?? "undefined";
  call.bytes = Buffer.byteLength(text);
  if (call.bytes > RESPONSE_LIMIT) return fail(`Response of ${call.bytes} bytes exceeds the 20kb limit`);
  return { content: [{ type: "text", text }] };
}

export interface FigmaStandIn {
  url: string;
  calls: UseFigmaCall[];
  server: Server;
}

type Rpc = { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: { code?: string } } };

type UseFigmaResult = Awaited<ReturnType<typeof useFigma>>;

/** What Figma's MCP server has been reported to answer past a seat's limit. */
export const RATE_LIMIT_MESSAGE = "You've reached the Figma MCP tool call limit for your seat type or plan. You can upgrade for more tool calls.";

/**
 * A rate limit: the server answers the first `calls` use_figma calls and
 * refuses every one after, with HTTP 429 and no body, or saying the seat
 * reached its limit in an `isError` result or a JSON-RPC error. A refused
 * call is recorded with the error "rate limited".
 */
export interface RateLimit {
  calls: number;
  refuse: "http" | "result" | "rpc";
}

/**
 * Serves the file over just enough MCP, JSON-RPC over HTTP, for use_figma. Or,
 * given a function instead, answers each use_figma call with what it returns,
 * for a server that misbehaves in a particular way.
 */
export async function startFigmaStandIn(file: FileSpec | ((code: string, calls: UseFigmaCall[]) => Promise<UseFigmaResult>), limit?: RateLimit): Promise<FigmaStandIn> {
  const calls: UseFigmaCall[] = [];
  const answer = typeof file === "function" ? file : (code: string, c: UseFigmaCall[]) => useFigma(file, code, c);

  async function respond(message: Rpc): Promise<unknown> {
    switch (message.method) {
      case "initialize":
        return { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-figma", version: "0" } };
      case "tools/list":
        return { tools: [{ name: "use_figma", inputSchema: { type: "object" } }] };
      case "tools/call":
        return answer(message.params?.arguments?.code ?? "", calls);
      default:
        return {};
    }
  }

  const server = createServer((req, res) => {
    // No standalone event stream: the client asks for one and carries on
    // without it when refused.
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const message = JSON.parse(body) as Rpc;
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "tools/call" && limit && calls.length >= limit.calls) {
        calls.push({ code: message.params?.arguments?.code ?? "", switches: [], bytes: 0, error: "rate limited" });
        if (limit.refuse === "http") {
          res.writeHead(429, { "retry-after": "60" }).end();
          return;
        }
        if (limit.refuse === "rpc") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: RATE_LIMIT_MESSAGE } }));
          return;
        }
        result = { content: [{ type: "text", text: RATE_LIMIT_MESSAGE }], isError: true };
      } else {
        result = await respond(message);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls, server };
}
