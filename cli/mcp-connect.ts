// Connecting to an MCP server, Storybook's or Figma's, and saying why it
// failed, or why a request to it did.

import { STATUS_CODES } from "node:http";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export type McpServer = "Storybook" | "Figma";

/**
 * How long a request waits for its answer when no limit was given: the MCP
 * SDK's own. Named here so an error can say what the limit was.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MSEC;

/**
 * Connects `client` over Streamable HTTP, which addon-mcp and Figma serve,
 * falling back to the older SSE transport for a server that only has that.
 * `timeoutMs` bounds the initialize request: left to the SDK, it gave up after
 * 60 seconds whatever --connect-timeout said.
 *
 * When both fail, the error is the Streamable HTTP one. Only the fallback's
 * was reported, and a server that answers a POST with 401 and a GET with 405,
 * as Figma's does without OAuth, read as "SSE error: Non-200 status code
 * (405)", hiding the 401 that says what is wrong.
 */
export async function connectWithFallback(client: Client, url: URL, server: McpServer, timeoutMs?: number): Promise<void> {
  const options = timeoutMs ? { timeout: timeoutMs } : undefined;
  let streamable: unknown;
  try {
    await client.connect(new StreamableHTTPClientTransport(url), options);
    return;
  } catch (err) {
    streamable = err;
  }
  try {
    await client.connect(new SSEClientTransport(url), options);
  } catch (sse) {
    throw connectFailure(server, url, streamable, sse);
  }
}

/** The HTTP status a transport error carries, or null for one that never got an answer. */
function httpStatus(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
}

/**
 * An error's message without the transport's own prefixes, and with its
 * cause, which is where fetch keeps the reason: "fetch failed: connect
 * ECONNREFUSED 127.0.0.1:6006". When localhost is refused on both its
 * addresses, ::1 and 127.0.0.1, the cause is an AggregateError with no
 * message of its own, so its errors are said in turn, as the SSE transport
 * says them. Its code alone, "fetch failed: ECONNREFUSED", read differently
 * from the SSE fallback's, which was then said as well.
 */
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let message = err.message.replace(/^(Streamable HTTP error|SSE error): /, "").replace(/^(\w*Error: )+/, "");
  const cause = err.cause as { message?: unknown; code?: unknown; errors?: unknown } | undefined;
  const each = Array.isArray(cause?.errors)
    ? cause.errors.map((e) => (e instanceof Error ? e.message : "")).filter(Boolean).join(", ")
    : "";
  const said = (typeof cause?.message === "string" && cause.message) || each || (typeof cause?.code === "string" && cause.code) || "";
  if (said && !message.includes(said)) message += `: ${said}`;
  // Said inside a sentence of its own, which supplies the period.
  return message.replace(/\.$/, "");
}

/** The system error a reason names, such as ECONNREFUSED or ENOTFOUND. */
function errno(text: string): string | null {
  return text.match(/\bE[A-Z]{3,}\b/)?.[0] ?? null;
}

/**
 * What the server said along with its status, when it is short enough to
 * help: Figma's `{"error":"invalid_token",...}`, or Storybook's "Not Found".
 * Not an HTML error page, which would bury the rest.
 */
function responseText(err: unknown): string | null {
  const m = err instanceof Error ? err.message.match(/Error POSTing to endpoint: ([\s\S]*)$/) : null;
  const text = m?.[1].replace(/\s+/g, " ").trim();
  if (!text || text === "null" || text.startsWith("<") || text.length > 200) return null;
  return text;
}

/** What to do about a status, for each server, where there is something to say. */
function statusHint(server: McpServer, status: number): string | null {
  if (status === 401 || status === 403) {
    return server === "Figma"
      ? "It needs you signed in to Figma, which the CLI can't do. Use the skill's audit flow in a client that's signed in (/storysync-diff in Claude Code), or point --figma at a local MCP endpoint that's already signed in."
      : "Something in front of Storybook needs you signed in, which the CLI can't do. Point --storybook at the Storybook dev server itself.";
  }
  if (status === 404) {
    return server === "Figma"
      ? "There's no MCP endpoint at that URL. Check --figma."
      : "There's no MCP endpoint there. Is @storybook/addon-mcp installed and registered? Run `storysync init`, then restart Storybook. If it is, check that --storybook is your Storybook's URL.";
  }
  return null;
}

/**
 * Why neither transport could connect, led by the Streamable HTTP attempt:
 * its HTTP status and what to do about it, or the reason it got no answer.
 * The SSE fallback's own failure follows, where it says something else: a
 * different status, as Figma's 405 to a GET, or a different reason. Both
 * refused, or both answered 404, is said once.
 */
export function connectFailure(server: McpServer, url: URL, streamable: unknown, sse: unknown): Error {
  const status = httpStatus(streamable);
  const fallback = reason(sse);
  let message: string;
  let same: boolean;
  if (status !== null) {
    const name = STATUS_CODES[status];
    // Not when it only repeats the status, as Figma's "Unauthorized" does.
    const text = responseText(streamable);
    const said = text && text.toLowerCase() !== name?.toLowerCase() ? text : null;
    const hint = statusHint(server, status);
    message = `${url} answered HTTP ${status}${name ? ` ${name}` : ""}${said ? ` (${said})` : ""}.${hint ? ` ${hint}` : ""}`;
    same = httpStatus(sse) === status;
  } else {
    const primary = reason(streamable);
    const refused = /ECONNREFUSED/.test(primary) && server === "Storybook" ? " Is Storybook running there?" : "";
    message = `Couldn't connect to ${url}: ${primary}.${refused}`;
    const code = errno(primary);
    same = fallback === primary || (code !== null && httpStatus(sse) === null && errno(fallback) === code);
  }
  return new Error(same ? message : `${message} (The SSE fallback failed too: ${fallback}.)`);
}

/** Whether a request failed because its answer didn't come within the limit. */
export function isRequestTimeout(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.RequestTimeout;
}

/**
 * A request's timeout, said as connecting's is: what didn't answer, the
 * limit, and the flag that raises it. The SDK's own, "MCP error -32001:
 * Request timed out", named neither.
 */
export function requestTimeoutError(server: McpServer, tool: string, timeoutMs: number): Error {
  return new Error(`${server} MCP didn't answer ${tool} within ${timeoutMs / 1000}s; raise --connect-timeout if it needs longer`);
}
