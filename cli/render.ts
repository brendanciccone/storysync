// Runtime DOM extractor: opens each Storybook story in a headless browser,
// reads computed CSS off the root element (and its children, optionally), and
// returns a per-variant snapshot shaped like ResolvedStyling. This is what
// closes the fidelity gap with the source parser — anything Tailwind /
// CSS-in-JS / library magic resolves to at runtime, we capture verbatim.
//
// Why this layer exists: the parser can detect *which* class names are
// tokens (so we know to bind to a variable), but it can't always tell what
// they ultimately render as — utility plugins, arbitrary properties, CSS
// custom properties, calc(), and runtime args all win against static
// parsing eventually. Storybook already runs the component in a browser,
// so we read what it actually painted.

import type { Browser, BrowserContext } from "playwright-core";
import type { InspectionResult, ResolvedStyling, RenderedChild } from "./inspect.js";

export interface ComputedSnapshot {
  fill?: string | null;
  text?: string | null;
  borderColor?: string | null;
  borderStyle?: "solid" | "dashed" | "dotted" | "double" | "none" | null;
  borderWidth?: string | null;
  borderRadius?: string | null;
  padding?: string | null;
  fontFamily?: string | null;
  fontSize?: string | null;
  fontWeight?: string | null;
  fontStyle?: "italic" | "normal" | null;
  lineHeight?: string | null;
  letterSpacing?: string | null;
  textAlign?: "left" | "center" | "right" | "justify" | null;
  textTransform?: "uppercase" | "lowercase" | "capitalize" | "none" | null;
  textDecoration?: "underline" | "line-through" | "overline" | "none" | null;
  shadow?: string | null;
  gap?: string | null;
  layout?: "row" | "column" | null;
  alignItems?: "start" | "end" | "center" | "stretch" | "baseline" | null;
  justifyContent?: "start" | "end" | "center" | "between" | "around" | "evenly" | null;
  opacity?: string | null;
  width?: number | null;
  height?: number | null;
  innerText?: string | null;
  tag?: string;
}

export interface ChildSnapshot {
  tag: string;
  computed: ComputedSnapshot;
  text?: string;
  children?: ChildSnapshot[];
}

export interface VariantSnapshot {
  root: ComputedSnapshot;
  children?: ChildSnapshot[];
}

export interface RendererOptions {
  storybookUrl: string;
  childDepth?: number;
  navTimeoutMs?: number;
  selectorTimeoutMs?: number;
  // Path to write raw rendered HTML for each story (debug). Each capture
  // appends `<storyId>--<argHash>.html` so we can see exactly what the
  // browser observed at extraction time.
  debugDumpDir?: string;
}

// One browser per CLI invocation, many pages — Chromium launch is the
// slowest part (~300ms), but every additional page is cheap (~50ms each).
// Reuse aggressively so a 100-story sync stays under a couple minutes.
export class StorybookRenderer {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly opts: Required<RendererOptions>;

  constructor(opts: RendererOptions) {
    this.opts = {
      storybookUrl: opts.storybookUrl.replace(/\/$/, ""),
      childDepth: opts.childDepth ?? 2,
      navTimeoutMs: opts.navTimeoutMs ?? 15_000,
      selectorTimeoutMs: opts.selectorTimeoutMs ?? 4_000,
      debugDumpDir: opts.debugDumpDir ?? "",
    };
  }

  async init(): Promise<void> {
    if (this.browser) return;
    const { chromium } = await import("playwright-core");
    try {
      this.browser = await chromium.launch({ headless: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Playwright-core ships without bundled browsers. When the binary is
      // missing it throws a fairly specific error pointing at the install
      // command — wrap it so storysync's caller gets a one-step fix.
      if (/Executable doesn't exist/i.test(msg) || /browserType\.launch/i.test(msg)) {
        throw new RenderUnavailableError(
          "Chromium not installed. Run `npx playwright install chromium` (one-time, ~150MB) and retry.",
        );
      }
      throw err;
    }
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
  }

  // Renders one story with optional arg overrides. The Storybook iframe URL
  // pattern `iframe.html?id=<storyId>&args=k:v;k:v` is a documented public
  // API of Storybook — same mechanism the controls panel uses, so what we
  // capture is byte-identical to what a designer would see by clicking that
  // arg in the Storybook UI.
  async captureStory(storyId: string, args?: Record<string, string>): Promise<VariantSnapshot> {
    if (!this.context) throw new Error("Renderer not initialized — call init() first");
    const url = this.buildStoryUrl(storyId, args);
    const page = await this.context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.opts.navTimeoutMs });
      // Race three signals so we wait long enough but not too long:
      //   1) Storybook's `storyRendered` event (the canonical "done"),
      //   2) network idle (no requests for 500ms — bundle finished),
      //   3) a fallback timer.
      // Whichever finishes first wins. This catches both fast stories
      // (synchronous render) and slow ones (bundle still streaming).
      await Promise.race([
        page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              const w = window as unknown as {
                __STORYBOOK_PREVIEW__?: { channel?: { on: (e: string, cb: () => void) => void } };
              };
              const channel = w.__STORYBOOK_PREVIEW__?.channel;
              if (!channel) return resolve();
              const done = () => resolve();
              channel.on("storyRendered", done);
              channel.on("storyMissing", done);
              channel.on("storyThrewException", done);
              channel.on("storyErrored", done);
              // Belt + suspenders: resolve after 2.5s no matter what.
              setTimeout(done, 2500);
            }),
        ).catch(() => undefined),
        page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      // Final settle — gives transitions / font-swap a paint to land.
      await page.waitForTimeout(200);
      if (this.opts.debugDumpDir) {
        try {
          const fs = await import("node:fs/promises");
          const pathMod = await import("node:path");
          await fs.mkdir(this.opts.debugDumpDir, { recursive: true });
          const safe = `${storyId}--${hashArgs(args ?? {})}.html`.replace(/[^a-zA-Z0-9._-]/g, "_");
          const html = await page.content();
          await fs.writeFile(pathMod.join(this.opts.debugDumpDir, safe), `<!-- ${url} -->\n${html}`);
        } catch {
          // Debug dump is best-effort — failures shouldn't block the capture.
        }
      }
      return await page.evaluate(extractInBrowser, { childDepth: this.opts.childDepth });
    } finally {
      await page.close();
    }
  }

  async captureManyStories(
    requests: Array<{ key: string; storyId: string; args?: Record<string, string> }>,
    concurrency = 4,
  ): Promise<Map<string, VariantSnapshot>> {
    const out = new Map<string, VariantSnapshot>();
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= requests.length) return;
        const req = requests[idx];
        try {
          const snap = await this.captureStory(req.storyId, req.args);
          out.set(req.key, snap);
        } catch (err) {
          // Per-story failure shouldn't kill the whole batch — leave it
          // missing from the map and the caller falls back to parser data.
          const msg = err instanceof Error ? err.message : String(err);
          out.set(req.key, { root: { tag: "error", innerText: `render failed: ${msg}` } });
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  async dispose(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }

  buildStoryUrl(storyId: string, args?: Record<string, string>): string {
    const u = new URL("/iframe.html", this.opts.storybookUrl);
    u.searchParams.set("id", normalizeStoryId(storyId));
    u.searchParams.set("viewMode", "story");
    if (args && Object.keys(args).length) {
      // Storybook serializes args as `k:v;k:v`. Values are URL-encoded.
      const argStr = Object.entries(args)
        .map(([k, v]) => `${encodeArgPart(k)}:${encodeArgPart(v)}`)
        .join(";");
      u.searchParams.set("args", argStr);
    }
    return u.toString();
  }
}

// Storybook's iframe URL routing expects story IDs in canonical kebab
// form (`catalyst-button--default`). Some MCP server versions return the
// title-style form (`Catalyst/Button--Default`) instead — converting
// here lets the renderer work against either output without touching
// the MCP parser. The transform mirrors Storybook's own `storyNameFromExport`:
// lowercase + replace `/` and whitespace with `-`.
export function normalizeStoryId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class RenderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderUnavailableError";
  }
}

// Storybook escapes a few characters in arg values; mirror its rules so the
// URL we emit round-trips through Storybook's arg parser.
function encodeArgPart(s: string): string {
  return String(s).replace(/[:;,!"]/g, (c) => `!${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

// Short stable suffix for debug-dump filenames so different arg combos
// don't overwrite each other.
function hashArgs(args: Record<string, string>): string {
  const s = Object.entries(args).sort().map(([k, v]) => `${k}=${v}`).join("&");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).padStart(6, "0");
}

// === Browser-side extraction =================================================
//
// This entire function is serialized and re-evaluated inside the page, so it
// must be self-contained — no closures, no module imports, no TypeScript-only
// syntax that survives compilation. The signature uses `unknown` so the
// playwright type-checker stays happy while we still get the result back as
// VariantSnapshot to the caller.

function extractInBrowser(opts: { childDepth: number }): VariantSnapshot {
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template"]);

  function toHex(rgb: string | null | undefined): string | null {
    if (!rgb) return null;
    const trimmed = rgb.trim();
    if (!trimmed || trimmed === "transparent" || trimmed === "none") return null;
    if (trimmed.startsWith("#")) return trimmed.toLowerCase();
    const m = trimmed.match(/rgba?\(([^)]+)\)/i);
    if (!m) return trimmed;
    const parts = m[1].split(",").map((p) => p.trim());
    if (parts.length < 3) return trimmed;
    const r = Math.round(parseFloat(parts[0]));
    const g = Math.round(parseFloat(parts[1]));
    const b = Math.round(parseFloat(parts[2]));
    const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    if (isNaN(r) || isNaN(g) || isNaN(b)) return trimmed;
    if (a === 0) return null;
    const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
    if (a < 1) {
      // Keep alpha as a comma-separated rgba for the consumer to split.
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    return hex;
  }

  function compactPx(top: string, right: string, bottom: string, left: string): string | null {
    const all = [top, right, bottom, left];
    if (all.every((v) => v === "0px" || v === "0" || !v)) return null;
    return all.join(" ");
  }

  function snapshot(el: Element): ComputedSnapshot {
    const cs = getComputedStyle(el as HTMLElement);
    const rect = (el as HTMLElement).getBoundingClientRect();
    const display = cs.display;
    const isFlex = display === "flex" || display === "inline-flex";
    const isGrid = display === "grid" || display === "inline-grid";
    return {
      tag: el.tagName.toLowerCase(),
      fill: toHex(cs.backgroundColor),
      text: toHex(cs.color),
      borderColor:
        cs.borderTopWidth !== "0px" || cs.borderRightWidth !== "0px" || cs.borderBottomWidth !== "0px" || cs.borderLeftWidth !== "0px"
          ? toHex(cs.borderTopColor)
          : null,
      borderStyle: cs.borderTopStyle === "none" ? null : (cs.borderTopStyle as ComputedSnapshot["borderStyle"]),
      borderWidth: cs.borderTopWidth === "0px" ? null : cs.borderTopWidth,
      borderRadius:
        cs.borderTopLeftRadius === "0px" && cs.borderTopRightRadius === "0px" && cs.borderBottomRightRadius === "0px" && cs.borderBottomLeftRadius === "0px"
          ? null
          : `${cs.borderTopLeftRadius} ${cs.borderTopRightRadius} ${cs.borderBottomRightRadius} ${cs.borderBottomLeftRadius}`,
      padding: compactPx(cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft),
      fontFamily: cs.fontFamily || null,
      fontSize: cs.fontSize || null,
      fontWeight: cs.fontWeight || null,
      fontStyle: (cs.fontStyle === "italic" ? "italic" : cs.fontStyle === "normal" ? "normal" : null),
      lineHeight: cs.lineHeight === "normal" ? null : cs.lineHeight,
      letterSpacing: cs.letterSpacing === "normal" ? null : cs.letterSpacing,
      textAlign: (["left", "center", "right", "justify"].includes(cs.textAlign) ? (cs.textAlign as ComputedSnapshot["textAlign"]) : null),
      textTransform: (["uppercase", "lowercase", "capitalize", "none"].includes(cs.textTransform)
        ? (cs.textTransform as ComputedSnapshot["textTransform"])
        : null),
      textDecoration:
        cs.textDecorationLine && cs.textDecorationLine !== "none"
          ? ((["underline", "line-through", "overline"].includes(cs.textDecorationLine)
              ? cs.textDecorationLine
              : "underline") as ComputedSnapshot["textDecoration"])
          : null,
      shadow: cs.boxShadow === "none" ? null : cs.boxShadow,
      gap: cs.rowGap === "0px" && cs.columnGap === "0px" ? null : cs.rowGap === cs.columnGap ? cs.rowGap : `${cs.rowGap} ${cs.columnGap}`,
      layout: isFlex || isGrid ? (cs.flexDirection?.startsWith("column") ? "column" : "row") : null,
      alignItems: mapAlign(cs.alignItems),
      justifyContent: mapJustify(cs.justifyContent),
      opacity: cs.opacity !== "1" ? cs.opacity : null,
      width: Math.round(rect.width) || null,
      height: Math.round(rect.height) || null,
      innerText:
        el.childElementCount === 0
          ? ((el as HTMLElement).innerText || el.textContent || "").trim() || null
          : null,
    };
  }

  function mapAlign(v: string | null | undefined): ComputedSnapshot["alignItems"] {
    if (!v) return null;
    if (v === "flex-start" || v === "start") return "start";
    if (v === "flex-end" || v === "end") return "end";
    if (v === "center") return "center";
    if (v === "stretch") return "stretch";
    if (v === "baseline") return "baseline";
    return null;
  }
  function mapJustify(v: string | null | undefined): ComputedSnapshot["justifyContent"] {
    if (!v) return null;
    if (v === "flex-start" || v === "start") return "start";
    if (v === "flex-end" || v === "end") return "end";
    if (v === "center") return "center";
    if (v === "space-between") return "between";
    if (v === "space-around") return "around";
    if (v === "space-evenly") return "evenly";
    return null;
  }

  function snapshotTree(el: Element, depth: number): ChildSnapshot {
    const out: ChildSnapshot = {
      tag: el.tagName.toLowerCase(),
      computed: snapshot(el),
    };
    if (el.childElementCount === 0) {
      const t = (el.textContent || "").trim();
      if (t) out.text = t;
      return out;
    }
    if (depth <= 0) return out;
    // Walk childNodes (not just element children) so direct text-node
    // siblings of elements survive — e.g. `<div>Label<svg/>...</div>`
    // would otherwise lose "Label". Each text node becomes its own
    // synthetic "text" ChildSnapshot so pushgen can emit it as a leaf.
    const kids: ChildSnapshot[] = [];
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const t = (c.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        // Inherit the parent's font/color for the text leaf so it
        // renders in Figma with the right typography rather than the
        // default Inter Regular 14px fallback.
        kids.push({
          tag: "#text",
          computed: { tag: "#text", fontFamily: out.computed.fontFamily, fontSize: out.computed.fontSize, fontWeight: out.computed.fontWeight, text: out.computed.text },
          text: t,
        });
        continue;
      }
      if (c.nodeType !== Node.ELEMENT_NODE) continue;
      const child = c as Element;
      if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
      kids.push(snapshotTree(child, depth - 1));
    }
    if (kids.length) out.children = kids;
    return out;
  }

  const root = document.querySelector("#storybook-root, #root");
  if (!root) return { root: {} };
  // Storybook wraps the story in one or more empty divs; the actual
  // component is the first descendant that *carries visible styling*.
  // We descend through transparent single-child wrappers and stop on the
  // styled element (or a multi-child / leaf), so the snapshot reflects
  // the component's own paint — not the wrapper's nothing.
  function isStyled(element: Element): boolean {
    const cs = getComputedStyle(element as HTMLElement);
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") return true;
    if (cs.borderTopWidth !== "0px" || cs.borderRightWidth !== "0px" || cs.borderBottomWidth !== "0px" || cs.borderLeftWidth !== "0px") return true;
    if (cs.boxShadow && cs.boxShadow !== "none") return true;
    if (cs.paddingTop !== "0px" || cs.paddingRight !== "0px" || cs.paddingBottom !== "0px" || cs.paddingLeft !== "0px") return true;
    if (cs.borderTopLeftRadius !== "0px" || cs.borderTopRightRadius !== "0px" || cs.borderBottomLeftRadius !== "0px" || cs.borderBottomRightRadius !== "0px") return true;
    // Tailwind's `before:` overlay pattern (Catalyst): the visible fill
    // lives on a `::before` pseudo-element while the host element has
    // a transparent background. Detect by querying the pseudo and
    // checking for a non-empty `content` + colored background.
    try {
      const before = getComputedStyle(element as HTMLElement, "::before");
      if (before.content && before.content !== "none" && before.content !== "normal") {
        const bg = before.backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return true;
      }
    } catch {
      // Some elements / browsers reject ::before queries — ignore.
    }
    return false;
  }

  let target: Element = root;
  // Root itself is the storybook container — never the component. Always
  // descend at least one level if root has exactly one child.
  if (target.children.length === 1 && target.firstElementChild) {
    target = target.firstElementChild;
  }
  // Continue descending through purely-empty single-child wrappers until
  // we hit a styled element or a multi-child / leaf node.
  let guard = 0;
  while (guard++ < 12 && target.children.length === 1 && target.firstElementChild) {
    if (isStyled(target)) break;
    target = target.firstElementChild;
  }

  const result: VariantSnapshot = { root: snapshot(target) };
  if (opts.childDepth > 0 && target.childElementCount > 0) {
    const kids: ChildSnapshot[] = [];
    for (const c of Array.from(target.children)) {
      if (SKIP_TAGS.has(c.tagName.toLowerCase())) continue;
      kids.push(snapshotTree(c, opts.childDepth - 1));
    }
    if (kids.length) result.children = kids;
  }
  return result;
}

// === Inspection enrichment ====================================================
//
// Bridges the runtime render output into the inspect pipeline. Given an
// InspectionResult and a Storybook story ID, expands the variant matrix the
// same way pushgen does, renders each combo via arg overrides, and writes
// the result back into `spec.renderedStyling` so the rest of the pipeline
// can consume it without knowing whether render is on or off.

export interface EnrichOptions {
  storyId: string;
  concurrency?: number;
  // Maximum number of variant combos to render — protects against the
  // Catalyst-Button case (92 combos) blowing the wall-clock budget. The
  // unrendered combos still get the parser's values, so output stays
  // complete, just less faithful for the tail.
  maxCombos?: number;
  // When set, drives the combo matrix from these axes instead of from
  // spec.variants. Used to align render keys with pushgen's matrix
  // (which is built from Storybook's variantProperties when present).
  axes?: Array<{ name: string; values: string[]; defaultValue?: string }>;
}

export async function enrichInspectionWithRender(
  spec: InspectionResult,
  renderer: StorybookRenderer,
  opts: EnrichOptions,
): Promise<InspectionResult> {
  const combos = opts.axes && opts.axes.length
    ? enumerateCombosFromAxes(opts.axes)
    : enumerateCombos(spec);
  const capped = opts.maxCombos ? combos.slice(0, opts.maxCombos) : combos;
  const requests = capped.map(({ key, args }) => ({ key, storyId: opts.storyId, args }));
  const snapshots = await renderer.captureManyStories(requests, opts.concurrency ?? 4);

  const renderedStyling: Record<string, ResolvedStyling> = {};
  const renderedLabels: Record<string, string> = {};
  const renderedChildren: Record<string, RenderedChild[]> = {};
  for (const { key } of capped) {
    const snap = snapshots.get(key);
    if (!snap) continue;
    renderedStyling[key] = snapshotToStyling(snap.root);
    const label = pickLabel(snap);
    if (label) renderedLabels[key] = label;
    if (snap.children && snap.children.length) {
      const kids = snap.children
        .map((c) => childToRenderedChild(c))
        .filter((c): c is RenderedChild => c !== null);
      if (kids.length) renderedChildren[key] = kids;
    }
  }
  return {
    ...spec,
    renderedStyling,
    renderedLabels,
    renderedStoryId: opts.storyId,
    renderedChildren,
  };
}

function childToRenderedChild(c: ChildSnapshot): RenderedChild | null {
  // Skip purely-empty wrappers (no styling, no text, no interesting kids).
  const styling = snapshotToStyling(c.computed);
  const hasText = !!c.text || !!c.computed.innerText;
  const hasStyling =
    !!styling.fill || !!styling.text || !!styling.borderColor || !!styling.padding || !!styling.borderRadius || !!styling.shadow;
  const hasKids = !!c.children?.length;
  if (!hasText && !hasStyling && !hasKids) return null;
  const out: RenderedChild = { styling };
  const t = c.text ?? c.computed.innerText ?? null;
  if (t) out.text = t;
  if (c.children?.length) {
    const inner = c.children.map((k) => childToRenderedChild(k)).filter((k): k is RenderedChild => k !== null);
    if (inner.length) out.children = inner;
  }
  return out;
}

// Variant matrix enumeration kept in sync with pushgen's expansion. Each
// entry is { args: <Storybook URL args>, key: <human-readable combo sig> }.
// We mirror pushgen's `formatVariantName` so lookups by combo signature
// hit the right snapshot.
export function enumerateCombos(spec: InspectionResult): Array<{ args: Record<string, string>; key: string }> {
  if (!spec.variants.length) return [{ args: {}, key: "Default" }];
  let acc: Array<Record<string, string>> = [{}];
  for (const v of spec.variants) {
    const next: Array<Record<string, string>> = [];
    for (const existing of acc) {
      for (const valueName of Object.keys(v.values)) {
        next.push({ ...existing, [v.name]: valueName });
      }
    }
    acc = next;
  }
  return acc.map((args) => ({ args, key: formatComboKey(args) }));
}

// Same matrix expansion as enumerateCombos, but driven by axes supplied
// externally (Storybook's argTypes via `mapComponent`). This is what
// pushgen feeds into enumerateVariantMatrix, so render-side keys round-
// trip with pushgen-side keys when both use this form.
export function enumerateCombosFromAxes(
  axes: Array<{ name: string; values: string[] }>,
): Array<{ args: Record<string, string>; key: string }> {
  if (!axes.length) return [{ args: {}, key: "Default" }];
  let acc: Array<Record<string, string>> = [{}];
  for (const a of axes) {
    const next: Array<Record<string, string>> = [];
    for (const existing of acc) {
      for (const value of a.values) {
        next.push({ ...existing, [a.name]: value });
      }
    }
    acc = next;
  }
  return acc.map((args) => ({ args, key: formatComboKey(args) }));
}

function formatComboKey(combo: Record<string, string>): string {
  const parts = Object.entries(combo).map(([k, v]) => {
    // Match pushgen's separator substitution so keys round-trip.
    const safe = String(v).replace(/\//g, "-");
    return `${k}=${safe}`;
  });
  return parts.length ? parts.join(", ") : "Default";
}

// Maps a ComputedSnapshot back onto the ResolvedStyling shape. Almost all
// fields share names; the few that don't (borderWidth, width, height,
// innerText, tag) either fold into composite fields or get dropped.
function snapshotToStyling(snap: ComputedSnapshot): ResolvedStyling {
  const out: ResolvedStyling = {};
  if (snap.fill !== undefined) out.fill = snap.fill;
  if (snap.text !== undefined) out.text = snap.text;
  // Synthesize the composite `border` field if all three pieces are present.
  if (snap.borderWidth && snap.borderStyle && snap.borderColor) {
    out.border = `${snap.borderWidth} ${snap.borderStyle} ${snap.borderColor}`;
  }
  if (snap.borderColor !== undefined) out.borderColor = snap.borderColor;
  if (snap.borderStyle !== undefined) out.borderStyle = snap.borderStyle;
  if (snap.borderRadius !== undefined) out.borderRadius = snap.borderRadius;
  if (snap.padding !== undefined) out.padding = snap.padding;
  if (snap.fontFamily !== undefined) out.fontFamily = snap.fontFamily;
  if (snap.fontSize !== undefined) out.fontSize = snap.fontSize;
  if (snap.fontWeight !== undefined) out.fontWeight = snap.fontWeight;
  if (snap.fontStyle !== undefined) out.fontStyle = snap.fontStyle;
  if (snap.lineHeight !== undefined) out.lineHeight = snap.lineHeight;
  if (snap.letterSpacing !== undefined) out.letterSpacing = snap.letterSpacing;
  if (snap.textAlign !== undefined) out.textAlign = snap.textAlign;
  if (snap.textTransform !== undefined) out.textTransform = snap.textTransform;
  if (snap.textDecoration !== undefined) out.textDecoration = snap.textDecoration;
  if (snap.shadow !== undefined) out.shadow = snap.shadow;
  if (snap.gap !== undefined) out.gap = snap.gap;
  if (snap.layout !== undefined) out.layout = snap.layout;
  if (snap.alignItems !== undefined) out.alignItems = snap.alignItems;
  if (snap.justifyContent !== undefined) out.justifyContent = snap.justifyContent;
  if (snap.opacity !== undefined) out.opacity = snap.opacity;
  return out;
}

function pickLabel(snap: VariantSnapshot): string | null {
  // Prefer the root's innerText when it's a leaf with text content.
  if (snap.root.innerText) return snap.root.innerText;
  // Otherwise scan child snapshots breadth-first for a text leaf.
  for (const c of snap.children ?? []) {
    if (c.text) return c.text;
    if (c.computed.innerText) return c.computed.innerText;
  }
  return null;
}
