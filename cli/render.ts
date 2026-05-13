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

import type { Browser, BrowserContext, Page } from "playwright-core";
import type { InspectionResult, ResolvedStyling, RenderedChild } from "./inspect.js";
import { fetchAssets, type ImageAsset } from "./assets.js";

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
  // §1.1 width constraints — captured so pushgen can emit FIXED sizing
  // instead of leaving every frame at AUTO/AUTO (which stretches cards
  // when content is wider than the design intent).
  widthExplicit?: boolean;
  maxWidth?: string | null;
  minWidth?: string | null;
  maxHeight?: string | null;
  minHeight?: string | null;
  // §1.2 multi-line text — DOM-derived. True when rendered height
  // exceeds line-height; the leaf actually wrapped.
  multiLine?: boolean;
  // Width available to children after the host's padding. Threaded
  // down `snapshotTree` so text leaves know what width to wrap at.
  parentInnerWidth?: number | null;
  // §1.3 SVG icons — outerHTML of an `<svg>`, fed to
  // `figma.createNodeFromSvg` in the apply loop so icons render as
  // editable Figma vectors instead of dropping out.
  svgMarkup?: string | null;
  // §2.1 margins — captured for translation into parent padding/gap.
  marginTop?: string | null;
  marginRight?: string | null;
  marginBottom?: string | null;
  marginLeft?: string | null;
  // §2.2 gradients — backgroundImage value (linear-gradient(...) etc.)
  backgroundImage?: string | null;
  // §2.3 overflow — `hidden`/`clip`/`auto` map to Figma's clipsContent.
  overflow?: string | null;
  // §2.5 absolute positioning — position + offsets per side.
  position?: string | null;
  topOffset?: string | null;
  rightOffset?: string | null;
  bottomOffset?: string | null;
  leftOffset?: string | null;
  // §3.2 rotation — parsed from CSS transform.
  rotation?: number | null;
  // §3.3 aspect ratio — `cs.aspectRatio` literal (e.g. "16 / 9").
  aspectRatio?: string | null;
  // §3.1 image content — the resolved URL for an `<img>` element OR a
  // `background-image: url(...)` value. assets.ts fetches these and
  // pushgen emits ImagePaint fills referencing the IMAGES library.
  imageUrl?: string | null;
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
  async captureStory(storyId: string, args?: Record<string, string>, state?: "hover" | "focus" | "active"): Promise<VariantSnapshot> {
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
      // §3.4 — trigger a pseudo-state before extracting if requested.
      // We target the first interactive descendant (button/a/input)
      // to maximize the chance of activating the actual styled
      // pseudo-class rather than a wrapper.
      if (state) {
        try {
          const handle = await page.evaluateHandle(() => {
            const root = document.querySelector("#storybook-root, #root");
            if (!root) return null;
            return root.querySelector("button, a, input, select, textarea, [role='button']") || root;
          });
          const el = handle.asElement();
          if (el) {
            if (state === "hover") await el.hover().catch(() => undefined);
            else if (state === "focus") await el.focus().catch(() => undefined);
            else if (state === "active") {
              await el.hover().catch(() => undefined);
              await page.mouse.down().catch(() => undefined);
            }
            // Give the pseudo-class CSS one paint to apply.
            await page.waitForTimeout(120);
          }
          await handle.dispose();
        } catch {
          // Best-effort — fall through and capture the default state.
        }
      }
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
    requests: Array<{ key: string; storyId: string; args?: Record<string, string>; state?: "hover" | "focus" | "active" }>,
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
          const snap = await this.captureStory(req.storyId, req.args, req.state);
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

  // §3.1 — Fetch image assets in the same browser context that
  // rendered the stories, so cookies/auth/referer survive. Opens a
  // single throwaway page, navigates to the Storybook origin (so
  // relative URLs resolve), and runs the bulk fetch.
  async fetchImageAssets(urls: string[]): Promise<{ assets: Map<string, ImageAsset>; failures: Array<{ url: string; reason: string }> }> {
    if (!this.context || !urls.length) return { assets: new Map(), failures: [] };
    const page = await this.context.newPage();
    try {
      // Navigate to the Storybook origin so `fetch` in the page can
      // resolve relative URLs and inherit any auth state Storybook
      // set during the previous renders.
      await page.goto(this.opts.storybookUrl, { waitUntil: "domcontentloaded", timeout: this.opts.navTimeoutMs }).catch(() => undefined);
      return await fetchAssets(page, urls);
    } finally {
      await page.close();
    }
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

// Fetches Storybook's own story index — the canonical map of every
// story ID, title, and name. Use this instead of MCP-derived IDs:
// MCP servers sometimes synthesize a `--default` ID even when the
// component has no Default story (Catalyst Button: Solid, Outline,
// Plain — no Default), which leads to 404s in the iframe.
export async function fetchStorybookIndex(
  storybookUrl: string,
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const base = storybookUrl.replace(/\/$/, "");
  // Storybook 7+ serves `/index.json`; older versions use `/stories.json`.
  // Try in order.
  for (const path of ["/index.json", "/stories.json"]) {
    try {
      const res = await fetch(`${base}${path}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { entries?: Record<string, { type?: string; id: string; name: string; title?: string }> };
      const entries = data.entries;
      if (!entries) continue;
      const byTitle = new Map<string, Array<{ id: string; name: string }>>();
      for (const v of Object.values(entries)) {
        if (v.type && v.type !== "story") continue;
        if (!v.title) continue;
        const list = byTitle.get(v.title) ?? [];
        list.push({ id: v.id, name: v.name });
        byTitle.set(v.title, list);
      }
      return byTitle;
    } catch {
      continue;
    }
  }
  return new Map();
}

// Picks a base story ID to render for a given component title. Prefers
// the first non-aggregate story (`All Colors`, `All Variants`,
// `All Sizes` are usually showcase stories that already iterate; we
// want a single-variant base instead so arg overrides have something
// clean to apply on top of).
export function pickBaseStoryId(
  stories: Array<{ id: string; name: string }>,
): string | null {
  if (!stories.length) return null;
  const isAggregate = (s: { name: string }) => /^all\b/i.test(s.name);
  const baseStory = stories.find((s) => !isAggregate(s)) ?? stories[0];
  return baseStory.id;
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
    // §1.2 multi-line detection — the rendered DOM's height exceeds
    // one line-height when text wrapped. Used to gate
    // `textAutoResize: HEIGHT` so single-line labels stay AUTO.
    const lineHeightPx = parsePxNumber(cs.lineHeight) ?? parsePxNumber(cs.fontSize) ?? 0;
    const multiLine = el.childElementCount === 0 && lineHeightPx > 0 && rect.height > lineHeightPx * 1.4;
    // §1.4 pseudo-element fill — when host bg is transparent, Catalyst
    // and similar patterns put the actual paint on `::before`. We
    // overwrite the captured host fill with the pseudo's color.
    const fill = composeFill(el, cs);
    // §2.2 gradient — capture backgroundImage when present and parse
    // linear/radial-gradient at this layer; the resulting paint spec
    // flows through ResolvedStyling.gradient to pushgen.
    const backgroundImage = cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage : null;
    // §1.3 SVG outerHTML — feed to figma.createNodeFromSvg. Cap at 8KB
    // to avoid inlining full illustrations (likely user-content, not
    // icons; we'd blow the per-script size budget).
    let svgMarkup: string | null = null;
    if (el.tagName.toLowerCase() === "svg") {
      const html = (el as Element).outerHTML;
      if (html && html.length <= 8192) svgMarkup = html;
    }
    // §3.2 rotation — parse from CSS transform matrix.
    const rotation = parseRotation(cs.transform);
    // §3.1 image URL — `<img>` resolves to `currentSrc`/`src`;
    // `background-image: url(...)` is parsed from cs.backgroundImage.
    let imageUrl: string | null = null;
    if (el.tagName.toLowerCase() === "img") {
      const img = el as HTMLImageElement;
      imageUrl = img.currentSrc || img.src || null;
    }
    if (!imageUrl && backgroundImage) {
      const urlMatch = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
      if (urlMatch) imageUrl = urlMatch[1];
    }
    return {
      tag: el.tagName.toLowerCase(),
      fill,
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
      // §1.1 width constraints
      widthExplicit: cs.width !== "auto" && cs.width !== "" && !cs.width.endsWith("%"),
      maxWidth: cs.maxWidth && cs.maxWidth !== "none" ? cs.maxWidth : null,
      minWidth: cs.minWidth && cs.minWidth !== "0px" && cs.minWidth !== "auto" ? cs.minWidth : null,
      maxHeight: cs.maxHeight && cs.maxHeight !== "none" ? cs.maxHeight : null,
      minHeight: cs.minHeight && cs.minHeight !== "0px" && cs.minHeight !== "auto" ? cs.minHeight : null,
      // §1.2 multi-line
      multiLine,
      // §1.3 SVG
      svgMarkup,
      // §2.1 margins
      marginTop: cs.marginTop !== "0px" ? cs.marginTop : null,
      marginRight: cs.marginRight !== "0px" ? cs.marginRight : null,
      marginBottom: cs.marginBottom !== "0px" ? cs.marginBottom : null,
      marginLeft: cs.marginLeft !== "0px" ? cs.marginLeft : null,
      // §2.2 gradient (raw string; parsed later into a paint spec)
      backgroundImage,
      // §2.3 overflow
      overflow: cs.overflow === "visible" ? null : cs.overflow,
      // §2.5 absolute positioning
      position: cs.position && cs.position !== "static" ? cs.position : null,
      topOffset: cs.top !== "auto" ? cs.top : null,
      rightOffset: cs.right !== "auto" ? cs.right : null,
      bottomOffset: cs.bottom !== "auto" ? cs.bottom : null,
      leftOffset: cs.left !== "auto" ? cs.left : null,
      // §3.2 rotation
      rotation,
      // §3.3 aspect ratio
      aspectRatio: cs.aspectRatio && cs.aspectRatio !== "auto" ? cs.aspectRatio : null,
      // §3.1 image URL
      imageUrl,
    };
  }

  function parsePxNumber(v: string | null | undefined): number | null {
    if (!v) return null;
    const m = v.match(/^(-?\d+(?:\.\d+)?)px$/);
    return m ? parseFloat(m[1]) : null;
  }

  // §1.4 — Pseudo-element fill resolution. Catalyst's button paints
  // its visible fill on `::before` while the host is transparent. We
  // detect that pattern and report the pseudo's color as the host's
  // fill. When the host is *not* transparent we keep the host value;
  // a non-transparent host with a separate pseudo bg is rare and
  // would benefit from stacking that we defer to Tier 2+.
  function composeFill(el: Element, cs: CSSStyleDeclaration): string | null {
    const hostHex = toHex(cs.backgroundColor);
    if (hostHex) return hostHex;
    try {
      const before = getComputedStyle(el as HTMLElement, "::before");
      if (before.content && before.content !== "none" && before.content !== "normal") {
        const bg = toHex(before.backgroundColor);
        if (bg) return bg;
      }
      const after = getComputedStyle(el as HTMLElement, "::after");
      if (after.content && after.content !== "none" && after.content !== "normal") {
        const bg = toHex(after.backgroundColor);
        if (bg) return bg;
      }
    } catch {
      // Some elements / browsers throw on pseudo queries — fall through.
    }
    return null;
  }

  // §3.2 rotation — parse `rotate(Ndeg)` or `matrix(a,b,c,d,e,f)` and
  // return the rotation angle in degrees. Translate/scale ignored.
  function parseRotation(transform: string): number | null {
    if (!transform || transform === "none") return null;
    const rot = transform.match(/rotate\((-?\d+(?:\.\d+)?)(deg|rad|turn)?\)/);
    if (rot) {
      const v = parseFloat(rot[1]);
      const unit = rot[2] || "deg";
      if (unit === "rad") return (v * 180) / Math.PI;
      if (unit === "turn") return v * 360;
      return v;
    }
    const m = transform.match(/matrix\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const a = parseFloat(m[1]);
      const b = parseFloat(m[2]);
      const deg = (Math.atan2(b, a) * 180) / Math.PI;
      return Math.abs(deg) < 0.01 ? null : Math.round(deg * 100) / 100;
    }
    return null;
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

  function snapshotTree(el: Element, depth: number, parentInnerWidth?: number): ChildSnapshot {
    const out: ChildSnapshot = {
      tag: el.tagName.toLowerCase(),
      computed: snapshot(el),
    };
    // §1.2 — stamp parentInnerWidth onto this element's computed snapshot
    // so leaf text nodes can call `lb.resize(parentInnerWidth, ...)` in
    // Figma and wrap to the parent's content width.
    if (parentInnerWidth != null) out.computed.parentInnerWidth = parentInnerWidth;
    if (el.childElementCount === 0) {
      const t = (el.textContent || "").trim();
      if (t) out.text = t;
      return out;
    }
    if (depth <= 0) return out;
    // Compute the inner content-width this element exposes to its kids —
    // own rendered width minus horizontal padding. Threaded down so a
    // text leaf inside `<div class="p-6">` knows its wrap width.
    const cs = getComputedStyle(el as HTMLElement);
    const rect = (el as HTMLElement).getBoundingClientRect();
    const padL = parsePxNumber(cs.paddingLeft) ?? 0;
    const padR = parsePxNumber(cs.paddingRight) ?? 0;
    const childInnerWidth = rect.width > 0 ? Math.max(0, Math.round(rect.width - padL - padR)) : undefined;
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
        // default Inter Regular 14px fallback. Also gate multiLine
        // on text length × parent width — anything beyond a single
        // line gets `textAutoResize: HEIGHT` downstream.
        const approxCharWidth = (parsePxNumber(out.computed.fontSize) ?? 14) * 0.55;
        const projectedWidth = t.length * approxCharWidth;
        const willWrap = childInnerWidth != null && projectedWidth > childInnerWidth;
        kids.push({
          tag: "#text",
          computed: {
            tag: "#text",
            fontFamily: out.computed.fontFamily,
            fontSize: out.computed.fontSize,
            fontWeight: out.computed.fontWeight,
            text: out.computed.text,
            textAlign: out.computed.textAlign,
            lineHeight: out.computed.lineHeight,
            letterSpacing: out.computed.letterSpacing,
            multiLine: willWrap,
            parentInnerWidth: childInnerWidth ?? null,
          },
          text: t,
        });
        continue;
      }
      if (c.nodeType !== Node.ELEMENT_NODE) continue;
      const child = c as Element;
      if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
      kids.push(snapshotTree(child, depth - 1, childInnerWidth));
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
  // §3.4 — additional pseudo-states to render per combo. Each entry
  // produces a parallel snapshot with `state=<name>` folded into the
  // combo key, becoming a Figma variant property at push time. Skipped
  // by default since hover state doubles the render time.
  captureStates?: Array<"hover" | "focus" | "active">;
}

export async function enrichInspectionWithRender(
  spec: InspectionResult,
  renderer: StorybookRenderer,
  opts: EnrichOptions,
): Promise<InspectionResult> {
  const baseCombos = opts.axes && opts.axes.length
    ? enumerateCombosFromAxes(opts.axes)
    : enumerateCombos(spec);
  // §3.4 — expand with state combos. The `default` state stays the
  // first entry so combo[0] is always the default; opt-in states
  // append additional combos keyed by `state=<name>`.
  const states: Array<"default" | "hover" | "focus" | "active"> = ["default", ...(opts.captureStates ?? [])];
  const combos: Array<{ args: Record<string, string>; key: string; state?: "hover" | "focus" | "active" }> = [];
  for (const c of baseCombos) {
    for (const s of states) {
      if (s === "default") combos.push({ args: c.args, key: c.key });
      else combos.push({ args: c.args, key: c.key === "Default" ? `state=${s}` : `${c.key}, state=${s}`, state: s });
    }
  }
  const capped = opts.maxCombos ? combos.slice(0, opts.maxCombos) : combos;
  const requests = capped.map(({ key, args, state }) => ({ key, storyId: opts.storyId, args, state }));
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
      if (kids.length) {
        // §2.1 — fold child margins into parent padding/gap. Modifies
        // `renderedStyling[key]` in place to absorb child margins that
        // don't have a natural Figma analog as raw values.
        foldChildMarginsIntoParent(renderedStyling[key], kids);
        renderedChildren[key] = kids;
      }
    }
  }

  // §3.1 — Collect every imageUrl we saw across all snapshots, fetch
  // their bytes once via the same browser context, and stamp the
  // resulting hash back onto each RenderedChild's styling so pushgen
  // can emit `{ im: <hash> }` payloads.
  const allUrls: string[] = [];
  for (const snap of snapshots.values()) collectImageUrls(snap, allUrls);
  let renderedImageAssets: Record<string, { base64: string; mime: string; width: number; height: number }> | undefined;
  if (allUrls.length) {
    const fetched = await renderer.fetchImageAssets(Array.from(new Set(allUrls)));
    if (fetched.assets.size) {
      renderedImageAssets = {};
      for (const a of fetched.assets.values()) {
        renderedImageAssets[a.hash] = { base64: a.base64, mime: a.mime, width: a.width, height: a.height };
      }
      // Walk every captured tree and replace imageUrl → imageHash.
      for (const key of Object.keys(renderedChildren)) {
        for (const k of renderedChildren[key]) stampImageHashes(k, fetched.assets);
      }
      // Also root-level styling (for img-only stories).
      for (const key of Object.keys(renderedStyling)) {
        const url = renderedStyling[key].imageUrl;
        if (url) {
          const a = fetched.assets.get(url);
          if (a) renderedStyling[key].imageHash = a.hash;
        }
      }
    }
  }

  return {
    ...spec,
    renderedStyling,
    renderedLabels,
    renderedStoryId: opts.storyId,
    renderedChildren,
    renderedImageAssets,
  };
}

function collectImageUrls(snap: VariantSnapshot, out: string[]): void {
  if (snap.root.imageUrl) out.push(snap.root.imageUrl);
  const walk = (children: ChildSnapshot[] | undefined): void => {
    if (!children) return;
    for (const c of children) {
      if (c.computed.imageUrl) out.push(c.computed.imageUrl);
      walk(c.children);
    }
  };
  walk(snap.children);
}

function stampImageHashes(child: RenderedChild, assets: Map<string, ImageAsset>): void {
  const url = child.styling.imageUrl;
  if (url) {
    const a = assets.get(url);
    if (a) child.styling.imageHash = a.hash;
  }
  if (child.children) for (const k of child.children) stampImageHashes(k, assets);
}

function childToRenderedChild(c: ChildSnapshot): RenderedChild | null {
  const styling = snapshotToStyling(c.computed);
  // §1.5 — recurse FIRST so we can test emptiness against the
  // post-filter child set. Previously the raw `c.children.length`
  // check kept wrappers whose children all filtered to null,
  // emitting them as ghost 100x100 frames in Figma.
  const inner = c.children?.length
    ? c.children.map((k) => childToRenderedChild(k)).filter((k): k is RenderedChild => k !== null)
    : [];
  const hasText = !!c.text || !!c.computed.innerText;
  const hasStyling =
    !!styling.fill || !!styling.text || !!styling.borderColor || !!styling.padding || !!styling.borderRadius || !!styling.shadow || !!styling.gradient;
  // §1.3 — SVG content is never "styling" in the CSS sense (no fill/
  // border on the host), but it is the visible artifact. Preserve.
  const hasSvg = !!c.computed.svgMarkup;
  if (!hasText && !hasStyling && !inner.length && !hasSvg) return null;
  const out: RenderedChild = { styling };
  const t = c.text ?? c.computed.innerText ?? null;
  if (t) out.text = t;
  if (inner.length) out.children = inner;
  if (c.computed.multiLine) out.multiLine = true;
  if (c.computed.parentInnerWidth != null) out.parentInnerWidth = c.computed.parentInnerWidth;
  if (c.computed.svgMarkup) out.svgMarkup = c.computed.svgMarkup;
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
  // §1.1 width constraints
  if (snap.width !== undefined) out.width = snap.width;
  if (snap.height !== undefined) out.height = snap.height;
  if (snap.widthExplicit !== undefined) out.widthExplicit = snap.widthExplicit;
  if (snap.maxWidth !== undefined) out.maxWidth = snap.maxWidth;
  if (snap.minWidth !== undefined) out.minWidth = snap.minWidth;
  if (snap.maxHeight !== undefined) out.maxHeight = snap.maxHeight;
  if (snap.minHeight !== undefined) out.minHeight = snap.minHeight;
  // §2.1 margins
  if (snap.marginTop !== undefined) out.marginTop = snap.marginTop;
  if (snap.marginRight !== undefined) out.marginRight = snap.marginRight;
  if (snap.marginBottom !== undefined) out.marginBottom = snap.marginBottom;
  if (snap.marginLeft !== undefined) out.marginLeft = snap.marginLeft;
  // §2.2 gradient (parsed on the way out so pushgen receives a paint spec).
  if (snap.backgroundImage) {
    const g = parseGradientPaintSpec(snap.backgroundImage);
    if (g) out.gradient = g;
  }
  // §2.3 overflow
  if (snap.overflow !== undefined) out.overflow = snap.overflow;
  // §2.5 absolute positioning
  if (snap.position !== undefined) out.position = snap.position;
  if (snap.topOffset !== undefined) out.topOffset = snap.topOffset;
  if (snap.rightOffset !== undefined) out.rightOffset = snap.rightOffset;
  if (snap.bottomOffset !== undefined) out.bottomOffset = snap.bottomOffset;
  if (snap.leftOffset !== undefined) out.leftOffset = snap.leftOffset;
  // §3.2 rotation
  if (snap.rotation !== undefined) out.rotation = snap.rotation;
  // §3.3 aspect ratio
  if (snap.aspectRatio !== undefined) out.aspectRatio = snap.aspectRatio;
  // §3.1 image URL — assets.ts later replaces with a hash in pushgen.
  if (snap.imageUrl !== undefined) out.imageUrl = snap.imageUrl;
  return out;
}

// §2.1 — Fold child margins into the parent's padding/gap. Figma's
// autolayout uses `itemSpacing` between siblings, not per-child
// margins, so we translate CSS margins one level up. Heuristic:
//   - first child's marginTop → parent.paddingTop (added on)
//   - last child's marginBottom → parent.paddingBottom (added on)
//   - uniform marginBottom across siblings (except last) → parent gap
//   - non-uniform sibling margins survive as ResolvedStyling marginTop/
//     etc. but pushgen drops them silently; that's the lossy case.
// Mutates `parent` and clears the folded margin fields on each child.
export function foldChildMarginsIntoParent(parent: ResolvedStyling, kids: RenderedChild[]): void {
  if (!parent || !kids.length) return;
  // Add the first kid's marginTop onto parent.paddingTop.
  const first = kids[0];
  const firstTop = parsePxStr(first.styling.marginTop);
  if (firstTop != null && firstTop > 0) {
    parent.padding = addToPaddingSide(parent.padding, "top", firstTop);
    first.styling.marginTop = null;
  }
  const last = kids[kids.length - 1];
  const lastBottom = parsePxStr(last.styling.marginBottom);
  if (lastBottom != null && lastBottom > 0) {
    parent.padding = addToPaddingSide(parent.padding, "bottom", lastBottom);
    last.styling.marginBottom = null;
  }
  // If all non-last kids have the same marginBottom > 0 AND parent has
  // no gap declared, treat that uniform margin as the gap.
  if (kids.length >= 2 && !parsePxStr(parent.gap)) {
    const margins: number[] = [];
    for (let i = 0; i < kids.length - 1; i++) {
      const m = parsePxStr(kids[i].styling.marginBottom);
      if (m == null || m <= 0) {
        margins.length = 0;
        break;
      }
      margins.push(m);
    }
    if (margins.length === kids.length - 1 && margins.every((m) => m === margins[0])) {
      parent.gap = `${margins[0]}px`;
      for (let i = 0; i < kids.length - 1; i++) kids[i].styling.marginBottom = null;
    }
  }
}

function parsePxStr(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = v.match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? parseFloat(m[1]) : null;
}

// Returns a new padding string with the given side incremented by `add`.
function addToPaddingSide(padding: string | null | undefined, side: "top" | "right" | "bottom" | "left", add: number): string {
  const parts = (padding ?? "0px 0px 0px 0px").split(/\s+/);
  let t = parsePxStr(parts[0]) ?? 0;
  let r = parsePxStr(parts[1]) ?? t;
  let b = parsePxStr(parts[2]) ?? t;
  let l = parsePxStr(parts[3]) ?? r;
  if (side === "top") t += add;
  else if (side === "right") r += add;
  else if (side === "bottom") b += add;
  else l += add;
  return `${t}px ${r}px ${b}px ${l}px`;
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

// §2.2 — Parse a CSS `background-image` value into a GradientPaintSpec
// pushgen can emit as a Figma GradientPaint. Returns null when the
// input is `url(...)` (image, handled separately in §3.1), `none`, or
// otherwise unparseable. Exported for unit testing.
export function parseGradientPaintSpec(value: string): import("./inspect.js").GradientPaintSpec | null {
  const trimmed = (value || "").trim();
  if (!trimmed || trimmed === "none" || trimmed.startsWith("url(")) return null;
  // Use greedy `.+` so nested parens (like `rgb(255, 0, 0)` inside the
  // gradient body) don't truncate the body at the first `)`. The
  // trailing `\)$` anchors to the outermost close.
  const linear = trimmed.match(/^linear-gradient\(\s*(.+)\)$/i);
  const radial = trimmed.match(/^radial-gradient\(\s*(.+)\)$/i);
  if (!linear && !radial) return null;
  const body = (linear ? linear[1] : radial![1]);
  // Split on top-level commas (not inside rgba()/oklab() parens).
  const parts = splitTopLevelCommas(body);
  let angleDeg: number | undefined;
  let startIdx = 0;
  if (linear) {
    // First part may be the direction: `90deg`, `to right`, `to top right`, etc.
    const first = parts[0]?.trim();
    if (first && (/\d+(?:\.\d+)?deg$/.test(first) || /^to\s/i.test(first))) {
      angleDeg = parseAngleOrSide(first);
      startIdx = 1;
    } else {
      angleDeg = 180; // CSS default: top-to-bottom
    }
  }
  const stops: Array<{ position: number; color: { r: number; g: number; b: number; a?: number } }> = [];
  for (let i = startIdx; i < parts.length; i++) {
    const stop = parseGradientStop(parts[i].trim(), (i - startIdx) / Math.max(1, parts.length - startIdx - 1));
    if (stop) stops.push(stop);
  }
  if (stops.length < 2) return null;
  return {
    type: linear ? "GRADIENT_LINEAR" : "GRADIENT_RADIAL",
    stops,
    angleDeg,
  };
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
  }
  out.push(s.slice(last));
  return out;
}

function parseAngleOrSide(s: string): number {
  const deg = s.match(/(-?\d+(?:\.\d+)?)deg/);
  if (deg) return parseFloat(deg[1]);
  // CSS `to <side>` syntax. `to top` = 0deg, `to right` = 90deg, etc.
  if (/to\s+top\s+right/i.test(s)) return 45;
  if (/to\s+bottom\s+right/i.test(s)) return 135;
  if (/to\s+bottom\s+left/i.test(s)) return 225;
  if (/to\s+top\s+left/i.test(s)) return 315;
  if (/to\s+top/i.test(s)) return 0;
  if (/to\s+right/i.test(s)) return 90;
  if (/to\s+bottom/i.test(s)) return 180;
  if (/to\s+left/i.test(s)) return 270;
  return 180;
}

function parseGradientStop(part: string, fallback: number): { position: number; color: { r: number; g: number; b: number; a?: number } } | null {
  // Try `<color> <position>` first; position may be `Npx`, `N%`, or absent.
  const m = part.match(/^(.*?)\s+(\d+(?:\.\d+)?)(%|px)?$/);
  let colorStr = part;
  let position = fallback;
  if (m) {
    colorStr = m[1].trim();
    const v = parseFloat(m[2]);
    position = m[3] === "%" ? v / 100 : v / 100; // px positions rare; approximate
  }
  const rgb = parseRgbForGradient(colorStr);
  if (!rgb) return null;
  return { position: Math.max(0, Math.min(1, position)), color: rgb };
}

// Minimal color parser for gradient stops. Defers to the browser side
// for oklab/hsl resolution where possible; this is invoked during
// `snapshotToStyling` (Node side), so we accept the common forms.
function parseRgbForGradient(s: string): { r: number; g: number; b: number; a?: number } | null {
  const v = s.trim();
  let m = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : undefined,
      };
    }
  }
  m = v.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*(?:[,\/]\s*(\d+(?:\.\d+)?%?))?\s*\)$/i);
  if (m) {
    const r: { r: number; g: number; b: number; a?: number } = {
      r: parseFloat(m[1]) / 255,
      g: parseFloat(m[2]) / 255,
      b: parseFloat(m[3]) / 255,
    };
    if (m[4] != null) {
      const a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (!isNaN(a)) r.a = a;
    }
    return r;
  }
  return null;
}
