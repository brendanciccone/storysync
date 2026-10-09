#!/usr/bin/env node
// End-to-end acceptance checks for storysync, run against the example project.
//
// Unit tests prove the pieces; this proves the pipeline. It drives the built
// CLI against a live Storybook serving examples/storybook-vite, and it runs the
// build, readback and audit code blocks from the shipped Claude skill against
// simulated Figma nodes — so a regression in the skill's templates fails here,
// not in someone's Figma file.
//
//   cd examples/storybook-vite && pnpm storybook     # leave running
//   pnpm build && pnpm acceptance
//
// Environment:
//   STORYBOOK_URL   Storybook serving examples/storybook-vite (default http://localhost:6006)
//   STORYSYNC_ROOT  checkout to test (default: this repo) — point it at another
//                   worktree to check an older or newer build
//   KEEP_WORKDIR=1  keep the temporary directory for inspection

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(process.env.STORYSYNC_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const CLI = join(ROOT, "dist", "cli", "index.js");
const SKILL = join(ROOT, "skills", "claude-code.md");
const EXAMPLE_BUTTON = join(ROOT, "examples", "storybook-vite", "src", "Button.tsx");
const EXAMPLE_STORIES = join(ROOT, "examples", "storybook-vite", "src", "Button.stories.tsx");
const STORYBOOK = (process.env.STORYBOOK_URL ?? "http://localhost:6006").replace(/\/+$/, "");
const WORK = mkdtempSync(join(tmpdir(), "storysync-acceptance-"));

const results = [];
let section = "";

function heading(title) {
  section = title;
  console.log(`\n${title}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ section, name, ok: true });
    console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (err) {
    results.push({ section, name, ok: false, error: err.message });
    console.log(`  ✗ ${name}\n      ${err.message.split("\n").join("\n      ")}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Runs the built CLI, or with `bin` another build of it: a mutant, for one. */
function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [opts.bin ?? CLI, ...args], { encoding: "utf8", cwd: opts.cwd ?? WORK });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Runs the built CLI without blocking, so a server in this process can answer it. */
function cliAsync(args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [opts.bin ?? CLI, ...args], { cwd: opts.cwd ?? WORK });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (status) => done({ status, out }));
  });
}

/**
 * The example's Storybook behind a proxy that serves the module at `path`,
 * as Vite compiles it, through `rewrite`: a story changed for one check
 * while the example's files stay as they are. Everything else, its MCP
 * endpoint and Vite's websocket included, passes through untouched.
 */
async function rewritingStorybook(path, rewrite) {
  const { createServer, request } = await import("node:http");
  const { connect } = await import("node:net");
  const target = new URL(STORYBOOK);
  const port = Number(target.port || 80);
  const server = createServer((req, res) => {
    const rewritten = req.url.split("?")[0] === path;
    const headers = { ...req.headers, host: target.host };
    if (rewritten) headers["accept-encoding"] = "identity";
    const upstream = request({ hostname: target.hostname, port, path: req.url, method: req.method, headers }, (answer) => {
      if (!rewritten) {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
        return;
      }
      const chunks = [];
      answer.on("data", (chunk) => chunks.push(chunk));
      answer.on("end", () => {
        const { "content-length": _length, etag: _etag, ...rest } = answer.headers;
        res.writeHead(answer.statusCode, rest).end(rewrite(Buffer.concat(chunks).toString("utf8")));
      });
    });
    upstream.on("error", (err) => res.writeHead(502).end(String(err)));
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = connect(port, target.hostname, () => {
      const lines = Object.entries({ ...req.headers, host: target.host }).map(([name, value]) => `${name}: ${value}`);
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => {
      server.closeAllConnections?.();
      server.close(() => done());
    }),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function verifyJson(snapDir, readbackPath, extra = [], { bin } = {}) {
  const r = cli(["verify", "--snap", join(snapDir, "styles.json"), "--readback", readbackPath, "--json", ...extra], { bin });
  let json = null;
  try {
    json = JSON.parse(r.out.trim().split("\n").pop());
  } catch {
    // leave null; callers assert on status
  }
  return { status: r.status, json, out: r.out };
}

/**
 * verify's exit code for a set of flags — after proving verify actually scored.
 *
 * An error (unreadable input, a crash) also exits 1, so an assertion that
 * expects 1 would pass without testing anything. Every exit-code check goes
 * through this so a failure to run is reported as one.
 */
function exitOf(snapDir, readbackPath, flags, { bin } = {}) {
  const probe = verifyJson(snapDir, readbackPath, [], { bin });
  if (!probe.json || probe.json.error || !probe.json.summary) {
    throw new Error(`verify did not score this input:\n${probe.out.trim()}`);
  }
  return cli(["verify", "--snap", join(snapDir, "styles.json"), "--readback", readbackPath, ...flags], { bin }).status;
}

const COMPARED = [
  "backgroundColor", "color", "borderRadiusUniform", "padding", "borderUniform", "boxShadow",
  "fontSize", "fontWeight", "fontFamily", "gap", "flexDirection", "opacity", "width", "height",
];
const TEXT_SIDE = new Set(["color", "fontSize", "fontWeight", "fontFamily"]);

/**
 * A readback that reports exactly what snap measured, built without the skill
 * template. The scoring checks use this so they test verify's contract on its
 * own: a broken template must not make them fail — or, worse, pass — for a
 * reason that has nothing to do with scoring. It is also exactly what the live
 * push wrote in place of the readback, snap's values, so it carries no
 * checksums: the scoring checks seal it, and the checksum checks do not.
 */
function referenceReadback(snapDir) {
  const snap = readJson(join(snapDir, "styles.json"));
  const components = {};
  for (const component of snap.components) {
    if (!component.base) continue;
    const variants = {};
    for (const v of expandVariants(component)) {
      const entry = { source: "measured" };
      for (const key of COMPARED) {
        const value = TEXT_SIDE.has(key) && v.styles.text?.[key] != null ? v.styles.text[key] : v.styles[key];
        if (value !== undefined) entry[key] = value;
      }
      variants[v.slug] = entry;
    }
    components[component.title ?? component.name] = { nodeId: `set:${component.name}`, variants };
  }
  return { version: 1, fileKey: "acceptance", components };
}

/** verify's own readbackChecksum, from the build under test: set in main. */
let readbackChecksum = null;

/**
 * `file` with every entry given a readAt of now, unless it has one, and the
 * checksum verify expects under its component's nodeId, as a deliberate forger
 * could, since the code is in the skill. The scoring checks perturb a readback
 * built without the template, and have to reach the scoring to test it; the
 * checksum checks test the checksum on its own.
 */
function sealed(file) {
  const readAt = new Date().toISOString();
  for (const component of Object.values(file.components)) {
    for (const [slug, entry] of Object.entries(component.variants)) {
      const { checksum: _, ...rest } = entry;
      const read = { readAt, ...rest };
      component.variants[slug] = { ...read, checksum: readbackChecksum(component.nodeId, slug, read) };
    }
  }
  return file;
}

// --- Simulated Figma -----------------------------------------------------------

const STYLE_NAME = {
  100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 500: "Medium",
  600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black",
};

function rgb01(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/** The alpha of a `#rrggbbaa` color, 1 for `#rrggbb`. */
function alpha01(hex) {
  const h = hex.replace("#", "");
  return h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
}

/**
 * A SOLID paint of a color snap measured, as Figma holds it: the color's
 * alpha, from `#rrggbbaa`, in the paint's opacity, and each number a 32-bit
 * float, as Figma reports them. `extra` overrides the paint's own fields.
 */
function solidPaint(hex, extra = {}) {
  const { r, g, b } = rgb01(hex);
  return {
    type: "SOLID",
    color: { r: Math.fround(r), g: Math.fround(g), b: Math.fround(b) },
    opacity: Math.fround(alpha01(hex)),
    visible: true,
    ...extra,
  };
}

/** What Figma reports as a frame's strokeWeight when its sides' weights differ. */
const MIXED = Symbol("figma.mixed");
const SIDES = ["Top", "Right", "Bottom", "Left"];
/** How much of a stroke's weight lies outside the node, by strokeAlign. */
const OUTSIDE_SHARE = { OUTSIDE: 1, CENTER: 0.5, INSIDE: 0 };

/**
 * What Figma's absoluteRenderBounds would be for a simulated node: the node,
 * the part of its stroke outside it while one of the stroke's paints shows,
 * and the reach of each visible drop shadow, its offset plus its spread and
 * blur radius. A stroke whose paint draws nothing is left out, as Figma
 * leaves it out, and an inner shadow reaches nowhere.
 */
function renderBounds(node) {
  const shows = node.strokes.some((paint) => paint.visible !== false && paint.opacity !== 0);
  const out = (side) => (shows ? OUTSIDE_SHARE[node.strokeAlign] * node[`stroke${side}Weight`] : 0);
  let left = -out("Left");
  let top = -out("Top");
  let right = node.width + out("Right");
  let bottom = node.height + out("Bottom");
  for (const effect of node.effects) {
    if (effect.type !== "DROP_SHADOW" || effect.visible === false) continue;
    const reach = effect.spread + effect.radius;
    left = Math.min(left, effect.offset.x - reach);
    top = Math.min(top, effect.offset.y - reach);
    right = Math.max(right, node.width + effect.offset.x + reach);
    bottom = Math.max(bottom, node.height + effect.offset.y + reach);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A Figma component node that reproduces one measured variant exactly, built
 * the way the skill says to. A border becomes a stroke of its weight on each
 * side it is on, OUTSIDE on the frame that hugs its content, a transparent
 * one with a paint that draws nothing; a node without one keeps the
 * strokeWeight of 1 Figma gives every node. A box shadow becomes an effect.
 * As in Figma, the node's own width and height leave out the stroke outside
 * them, so they are the measured border box less that stroke, and
 * absoluteRenderBounds is what Figma's would be. A translucent color's alpha
 * is its paint's opacity. `strokeAlign` builds the stroke another way: INSIDE,
 * at the measured size, as the skill says to for a frame given a fixed size,
 * or CENTER. With `hugging`, an INSIDE stroke is on a frame that hugs its
 * content, as for a fill that runs under a transparent border: with
 * `strokesIncludedInLayout` the stroke adds to the frame's size, which comes
 * to the measured size, and without it the stroke eats into the padding and
 * the frame is the measured size less the stroke. `strokeHidden` builds a transparent
 * border's stroke as a designer might, a paint of full opacity hidden with the
 * eye icon, `visible: false`. A width or height of 0, a closed Collapsible's,
 * is built at 0.01, the least Figma takes, as the skill says. A label is built
 * as the skill says too: see textNode below.
 */
function figmaNode(name, st, { strokeAlign = "OUTSIDE", strokeHidden = false, strokesIncludedInLayout = false, hugging = false, textHugs = false } = {}) {
  const text = st.text ?? { color: st.color, fontFamily: st.fontFamily, fontSize: st.fontSize, fontWeight: st.fontWeight };
  // As the skill builds a label: hugging its content, or, where snap
  // measured how the browser fitted it, fixed at that width and cut off
  // after as many lines as the browser drew; with `textHugs`, hugging all
  // the same, as a push before snap measured it built Attachment's title.
  const layout = textHugs ? null : text.layout ?? null;
  const textNode = {
    type: "TEXT",
    fills: text.color ? [solidPaint(text.color)] : [],
    fontSize: text.fontSize,
    // What Figma actually reports: a style *name*, e.g. Inter 600 is "Semi Bold".
    fontName: { family: text.fontFamily, style: STYLE_NAME[text.fontWeight] ?? "Regular" },
    textAutoResize: layout ? "HEIGHT" : "WIDTH_AND_HEIGHT",
    textTruncation: layout?.truncation ? "ENDING" : "DISABLED",
    maxLines: layout?.truncation ? layout.lines : null,
    width: layout ? layout.width : Math.max(1, Math.round(st.width - st.padding.left - st.padding.right)),
  };
  const border = Object.fromEntries(SIDES.map((side) => [side, st.borderUniform ?? st.border?.[side.toLowerCase()] ?? null]));
  const drawn = SIDES.map((side) => border[side]).find(Boolean) ?? null;
  const weight = Object.fromEntries(SIDES.map((side) => [side, drawn ? border[side]?.width ?? 0 : 1]));
  // How much of the stroke the node's own size leaves out of the measured one.
  const share = !drawn ? 0 : strokeAlign === "INSIDE" && hugging && !strokesIncludedInLayout ? 1 : OUTSIDE_SHARE[strokeAlign];
  const node = {
    name,
    fills: st.backgroundColor ? [solidPaint(st.backgroundColor)] : [],
    strokes: !drawn ? []
      : strokeHidden ? [solidPaint(drawn.color ?? "#9ca3af", { visible: false })]
      : [drawn.color ? solidPaint(drawn.color) : solidPaint("#000000", { opacity: 0 })],
    strokeWeight: new Set(Object.values(weight)).size === 1 ? weight.Top : MIXED,
    ...Object.fromEntries(SIDES.map((side) => [`stroke${side}Weight`, weight[side]])),
    strokeAlign,
    strokesIncludedInLayout,
    effects: (st.boxShadow ?? []).map((shadow) => ({
      type: shadow.inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { ...rgb01(shadow.color ?? "#000000"), a: shadow.color ? alpha01(shadow.color) : 0 },
      offset: { x: shadow.offsetX, y: shadow.offsetY },
      radius: shadow.blur,
      spread: shadow.spread,
      visible: true,
    })),
    cornerRadius: st.borderRadiusUniform ?? 0,
    paddingTop: st.padding.top,
    paddingRight: st.padding.right,
    paddingBottom: st.padding.bottom,
    paddingLeft: st.padding.left,
    // Padding needs auto-layout in Figma whatever the element's CSS display.
    layoutMode: "HORIZONTAL",
    itemSpacing: st.gap?.column ?? 0,
    opacity: st.opacity,
    // Figma rounds text to whole pixels, so the border box lands near, not on, CSS.
    width: Math.max(0.01, Math.round(st.width) - share * (weight.Left + weight.Right)),
    height: Math.max(0.01, Math.round(st.height) - share * (weight.Top + weight.Bottom)),
    findOne: (predicate) => (predicate(textNode) ? textNode : null),
  };
  Object.defineProperty(node, "absoluteRenderBounds", { enumerable: true, get: () => renderBounds(node) });
  return node;
}

function expandVariants(component) {
  return component.variants
    .filter((v) => v.status === "ok")
    .map((v) => ({ ...v, styles: { ...component.base.styles, ...(v.delta ?? {}) } }));
}

/** A variant's name as the skill gives it: '' for a component with no variant properties. */
function figmaVariantName(combination) {
  return Object.entries(combination ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
}

/** Text HTML-escaped, as Figma returns a component's description. */
function htmlEscaped(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * A component set or component whose description behaves as a live push
 * found Figma's: `description` returns its text HTML-escaped, `"` as
 * `&quot;` and `&` as `&amp;`, and setting it stores the text as given and
 * empties `descriptionMarkdown`, as it read back after a push set it.
 * `descriptionMarkdown` holds a designer's formatted description as
 * markdown; setting it stores that, with the text shown as the markdown less
 * its emphasis and escapes. Whether Figma returns the markdown escaped too no
 * run has shown, so `escapeMarkdown` returns it both ways. `stored` is what
 * Figma keeps, for the checks to read.
 */
function describedNode(id, type, { text = "", markdown = "", escapeMarkdown = false } = {}) {
  const stored = { text: markdown ? shownText(markdown) : text, markdown };
  const node = { id, type, stored };
  Object.defineProperty(node, "description", {
    enumerable: true,
    get: () => htmlEscaped(stored.text),
    set: (value) => Object.assign(stored, { text: String(value), markdown: "" }),
  });
  Object.defineProperty(node, "descriptionMarkdown", {
    enumerable: true,
    get: () => (escapeMarkdown ? htmlEscaped(stored.markdown) : stored.markdown),
    set: (value) => Object.assign(stored, { markdown: String(value), text: shownText(String(value)) }),
  });
  return node;
}

/** The text markdown shows: without its `**`, `__` and single `*` or `_` emphasis, and its backslash escapes undone. */
function shownText(markdown) {
  const kept = [];
  const out = markdown.replace(/\\(.)/g, (_, c) => `\u0000${kept.push(c) - 1}\u0000`)
    .replace(/\*\*|__|[*_]/g, "");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

/**
 * The pages for the label call, each `[name, layers]`, the user on the one
 * at `current`, the first unless given: as use_figma loads them, only that
 * one is loaded when the call starts, and another lists no layers until the
 * call loads it, with its `loadAsync` or by switching to it. Figma refuses
 * to remove the page it is on, or the last one. `figma` serves them;
 * `pages` is what is left.
 */
function labelPages(spec, current = 0) {
  const pages = [];
  const loaded = new Set();
  for (const [index, [name, layers]] of spec.entries()) {
    const page = { type: "PAGE", id: `0:${index + 1}`, name, layers: Array.from({ length: layers }, (_, i) => ({ id: `${name}:${i}` })) };
    Object.defineProperty(page, "children", { get: () => (loaded.has(page) ? page.layers : []) });
    page.loadAsync = async () => { loaded.add(page); };
    page.remove = () => {
      if (figma.currentPage === page) throw new Error("Cannot remove the current page");
      if (pages.length === 1) throw new Error("Cannot remove the last page");
      pages.splice(pages.indexOf(page), 1);
    };
    pages.push(page);
  }
  loaded.add(pages[current]);
  const figma = {
    root: { children: pages },
    currentPage: pages[current],
    setCurrentPageAsync: async (page) => {
      loaded.add(page);
      figma.currentPage = page;
    },
  };
  return { figma, pages };
}

/**
 * Runs the skill's label call over `nodes`, by id, in a file of `pages`, a
 * labelPages figma, a page of components alone unless one is given, with
 * the NOTES table set to each run's notes.
 */
function labelCall(code, nodes, pages = labelPages([["ui/base", 1]]).figma) {
  const withNotes = (notes) => code.replace(/const NOTES = \{[\s\S]*?\n\s*\};/, () => `const NOTES = ${JSON.stringify(notes)};`);
  const figma = { ...pages, getNodeByIdAsync: async (id) => nodes[id] ?? null };
  Object.defineProperty(figma, "currentPage", { get: () => pages.currentPage });
  return async (notes) => JSON.parse(await new AsyncFunction("figma", withNotes(notes))(figma));
}

const AsyncFunction = (async () => {}).constructor;

// use_figma's limits: its input schema caps `code` at 50,000 characters, and
// Figma documents a 20kb output response limit per call. The templates refuse
// to return a slice whose encoded JSON passes GUARD.
const CODE_LIMIT = 50000;
const RESPONSE_LIMIT = 20000;
const GUARD = 17000;

/**
 * The largest variant snap measured live on shadcn/ui's registry, Command's,
 * 1,019 characters: a real entry to price a build part at, where the
 * example's are smaller. A live push's own code, its applyStyles and helpers,
 * came to AGENT_CODE.
 */
const SHADCN_COMMAND = {
  display: "flex", flexDirection: "column", alignItems: "normal", justifyContent: "normal", gap: null, width: 384, height: 311,
  backgroundColor: "#ffffff", color: "#0a0a0a",
  border: Object.fromEntries(["top", "right", "bottom", "left"].map((side) => [side, { width: 1, style: "solid", color: "#e5e5e5" }])),
  borderUniform: { width: 1, style: "solid", color: "#e5e5e5" },
  borderRadius: { topLeft: 14, topRight: 14, bottomRight: 14, bottomLeft: 14 }, borderRadiusUniform: 14,
  padding: { top: 4, right: 4, bottom: 4, left: 4 }, fontFamily: "system-ui", fontSize: 16, fontWeight: 400, lineHeight: 24, letterSpacing: 0,
  boxShadow: [
    { offsetX: 0, offsetY: 4, blur: 6, spread: -1, color: "#0000001a", inset: false },
    { offsetX: 0, offsetY: 2, blur: 4, spread: -2, color: "#0000001a", inset: false },
  ],
  opacity: 1, boxSizing: "border-box", fontAvailable: null, text: { color: "#737373", fontFamily: "system-ui", fontSize: 12, fontWeight: 500 },
};
const AGENT_CODE = 7038;

/** Every use_figma code block in the skill, with the description it is sent with. */
function useFigmaBlocks() {
  const md = readFileSync(SKILL, "utf8");
  const blocks = [];
  let at = 0;
  while ((at = md.indexOf("code: `", at)) >= 0) {
    const start = at + "code: `".length;
    const end = md.indexOf("`,", start);
    const description = /description: "([^"]*)"/.exec(md.slice(end, end + 400))?.[1] ?? "";
    blocks.push({ code: md.slice(start, end), description, start });
    at = end;
  }
  return blocks;
}

/** The one use_figma code block whose description matches. */
function useFigmaBlock(pattern) {
  const found = useFigmaBlocks().filter((b) => pattern.test(b.description));
  assert(found.length === 1, `expected one use_figma example described as ${pattern}, found ${found.length}`);
  return found[0].code;
}

const constant = (name) => new RegExp(`const ${name} = [^;\\n]*;`);

/** A template's code with `const NAME = ...;` set to each given value. */
function withConstants(code, values) {
  let out = code;
  for (const [name, value] of Object.entries(values)) {
    assert(constant(name).test(out), `the template defines no ${name}`);
    out = out.replace(constant(name), () => `const ${name} = ${JSON.stringify(value)};`);
  }
  return out;
}

/** A template's code with its 20kb guard lifted, to measure what it would return. */
function liftGuard(code) {
  const guards = code.match(/\b17000\b/g) ?? [];
  assert(guards.length === 1, `the template has ${guards.length} guards at ${GUARD} characters, expected one`);
  return code.replace(/\b17000\b/, "Infinity");
}

/** A lookup table written the way the template shows one: an entry a line. */
function jsTable(entries) {
  return `{\n${Object.entries(entries).map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n    }`;
}

/**
 * The smallest slice whose encoded size passes the guard, measured with the
 * guard lifted, then run as shipped: it has to be refused, and the slice one
 * smaller returned. It lands under 20kb, and under the guard before encoding,
 * so a guard loosened toward 20kb, or one measuring the string before
 * use_figma encodes it, returns it and fails here. `run(n, guarded)` makes one
 * call over the first n items and returns the string the template returns;
 * the refusal has to say what to do, matching `remedy`.
 */
async function assertGuardRefuses(run, max, remedy = /lower BATCH/) {
  let over = null;
  for (let n = 1; n <= max && !over; n++) {
    const raw = await run(n, false);
    if (JSON.stringify(raw).length > GUARD) over = { n, raw: raw.length, encoded: JSON.stringify(raw).length };
  }
  assert(over, `no slice of up to ${max} items passes ${GUARD} characters encoded`);
  assert(over.encoded < RESPONSE_LIMIT && over.raw <= GUARD,
    `the smallest slice over the guard is ${over.raw} characters, ${over.encoded} encoded: not between the guard and 20kb`);
  let error = null;
  try {
    await run(over.n, true);
  } catch (err) {
    error = err;
  }
  assert(error && remedy.test(error.message),
    `returned ${over.n} items, ${over.encoded} characters encoded${error ? `, failing with: ${error.message}` : ""}`);
  await run(over.n - 1, true);
  return `${over.n} items, ${over.raw} characters and ${over.encoded} encoded, refused; ${over.n - 1} returned`;
}

/**
 * The readback template from the shipped skill.
 *
 * Extracted from skills/claude-code.md rather than copied, so this exercises
 * exactly what an agent is told to paste: the whole use_figma code block, run
 * against a figma that serves the simulated set by its id. The two lookup
 * tables the agent is told to fill in from snap output are replaced with this
 * call's slice of them, written an entry a line as the template shows, and
 * SET_ID and BATCH with the call's own; everything else runs verbatim.
 * `batch` is the template's own BATCH, `code()` the code an agent would send,
 * and `read()` what that call returns, parsed. `mutate` rewrites the shipped
 * code, to show a check fails a template that gets something wrong.
 */
function loadSkillReadback(mutate = null) {
  const md = readFileSync(SKILL, "utf8");
  const at = md.indexOf("const SLUG_BY_NAME");
  if (at < 0) {
    throw new Error(
      "skill template defines no SLUG_BY_NAME, so it has no way to map a Figma variant back to its snap slug " +
      "(it calls slugFor() without defining it)",
    );
  }
  const open = md.lastIndexOf("code: `", at);
  const close = md.indexOf("`,", at);
  assert(open >= 0 && close > 0, "the skill's readback template is not inside a use_figma code literal");
  const shipped = md.slice(open + "code: `".length, close);
  const block = mutate ? mutate(shipped) : shipped;
  assert(!mutate || block !== shipped, "the mutation no longer matches the readback template");
  assert(!block.includes("`"), "skill template contains a backtick, which would close the use_figma code literal early");
  assert(/\breturn\b[^\n]*;\s*$/.test(block), "skill template has no readback return statement");

  const table = (name) => new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\s*\\};`);
  assert(table("SLUG_BY_NAME").test(block), "could not locate the SLUG_BY_NAME table in the skill template");
  assert(table("SOURCE_BY_SLUG").test(block), "skill template defines no SOURCE_BY_SLUG, so provenance is not derived from snap status");
  for (const name of ["SET_ID", "BATCH"]) {
    assert(constant(name).test(block), `skill template defines no ${name}, so it cannot read a set back a slice at a time`);
  }
  const batch = Number(/const BATCH = (\d+);/.exec(block)?.[1]);
  assert(batch > 0, "skill template's BATCH is not a number");

  const code = (setId, slugByName, sourceBySlug, { batch: callBatch = batch, guarded = true } = {}) => {
    const body = withConstants(block, { SET_ID: setId, BATCH: callBatch })
      .replace(table("SLUG_BY_NAME"), () => `const SLUG_BY_NAME = ${jsTable(slugByName)};`)
      .replace(table("SOURCE_BY_SLUG"), () => `const SOURCE_BY_SLUG = ${jsTable(sourceBySlug)};`);
    return guarded ? body : liftGuard(body);
  };
  // `clock`, the time in ms Figma's Date gives the call, for a readback read
  // at another time: the template's own Date is shadowed with one fixed there.
  const run = async (componentSet, slugByName, sourceBySlug, opts) => {
    // The file's local variables, opts.variables, none unless given: each
    // { id, name, resolvedType, valuesByMode, variableCollectionId, scopes },
    // as Figma gives one, and their collections, opts.collections, each
    // { id, name }. A variable given no scopes has ALL_SCOPES, Figma's default.
    const variables = (opts?.variables ?? []).map((v) => ({ scopes: ["ALL_SCOPES"], ...v }));
    const collections = opts?.collections ?? [];
    const figma = {
      getNodeByIdAsync: async (id) => (id === componentSet.id ? componentSet : null),
      variables: {
        getLocalVariablesAsync: async () => variables,
        getLocalVariableCollectionsAsync: async () => collections,
        getVariableByIdAsync: async (id) => variables.find((v) => v.id === id) ?? null,
      },
    };
    return new AsyncFunction("figma", "Date", code(componentSet.id, slugByName, sourceBySlug, opts))(figma, clockAt(opts?.clock));
  };
  const read = async (...args) => JSON.parse(await run(...args));
  return { batch, code, run, read };
}

/** Date, or with `ms` given, a Date whose current time is fixed at `ms`. */
function clockAt(ms) {
  if (ms == null) return Date;
  return class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [ms]));
    }

    static now() {
      return ms;
    }
  };
}

/** `readback`, a template from loadSkillReadback, with every call it makes reading at `ms`. */
function readingAt(readback, ms) {
  return { ...readback, read: (set, slugs, sources, opts) => readback.read(set, slugs, sources, { ...opts, clock: ms }) };
}

/**
 * Smaller than the template's own BATCH, so the 12-variant Button is read in
 * three calls and merging the slices is part of every round trip. It divides
 * 12, so the last slice ends exactly on the set's last variant.
 */
const READ_BATCH = 4;

/** The entries of `table` for these keys, in their order. */
function pick(table, keys) {
  return Object.fromEntries(keys.filter((key) => key in table).map((key) => [key, table[key]]));
}

/** Names in snap's variant order, cut into slices of at most `batch`. */
function slices(names, batch) {
  const out = [];
  for (let start = 0; start < names.length; start += batch) out.push(names.slice(start, start + batch));
  return out;
}

/** One simulated component set per measured component, as the skill builds it. */
function simulatedSets(snapDir, { mutate, withholdSource } = {}) {
  const snap = readJson(join(snapDir, "styles.json"));
  return snap.components.filter((component) => component.base).map((component) => {
    const slugByName = {};
    const sourceBySlug = {};
    const children = expandVariants(component).map((v) => {
      const name = figmaVariantName(v.combination);
      slugByName[name] = v.slug;
      if (v.slug !== withholdSource) sourceBySlug[v.slug] = "measured";
      const node = figmaNode(name, v.styles);
      mutate?.(node, v, component);
      return node;
    });
    const componentSet = { id: `set:${component.name}`, type: "COMPONENT_SET", name: component.name, children };
    return { component, componentSet, slugByName, sourceBySlug };
  });
}

/**
 * Reads a whole set back the way the skill says to: the variants snap
 * measured, in its order, `batch` a call, each call carrying only its own
 * slice of the two tables. Every call has to read back exactly the variants it
 * named and report the set's size; returns the merged readback, the calls
 * made and the set's `total`. `onSlice(slice)` sees each call's result.
 */
async function readSet(readback, { componentSet, slugByName, sourceBySlug }, batch, onSlice) {
  const variants = {};
  let calls = 0;
  let total = null;
  for (const names of slices(Object.keys(slugByName), batch)) {
    const slugs = names.map((name) => slugByName[name]);
    const slice = await readback.read(componentSet, pick(slugByName, names), pick(sourceBySlug, slugs), { batch });
    calls++;
    onSlice?.(slice);
    const read = Object.keys(slice.readback);
    assert(read.join() === slugs.join(), `a call naming ${slugs.join(", ")} read back ${read.join(", ") || "nothing"}`);
    for (const slug of read) assert(!(slug in variants), `${slug} was read back in two slices`);
    // A plain component is its own one variant.
    const size = componentSet.type === "COMPONENT" ? 1 : componentSet.children.length;
    assert(slice.total === size, `the slice reports a total of ${slice.total}, but the set holds ${size} variants`);
    Object.assign(variants, slice.readback);
    total = slice.total;
  }
  return { variants, calls, total };
}

/**
 * Builds figma-readback.json the way the skill does: one simulated component
 * set per measured component, read back slice by slice by the skill's own
 * template, the slices merged under the component's title.
 * `mutate(node, variant, component)` edits a node after creation, the way a
 * designer might edit Figma by hand; `onRead(component, calls)` sees how many
 * calls each set took. `readback` is the template to read with, the shipped
 * one unless a mutant is given.
 */
async function buildReadback(snapDir, { mutate, withholdSource, onRead, readback = loadSkillReadback() } = {}) {
  const components = {};
  for (const set of simulatedSets(snapDir, { mutate, withholdSource })) {
    const { variants, calls, total } = await readSet(readback, set, READ_BATCH);
    assert(Object.keys(variants).length === total, `${set.component.name}: read ${Object.keys(variants).length} of ${total} variants`);
    onRead?.(set.component, calls);
    components[set.component.title ?? set.component.name] = { nodeId: set.componentSet.id, variants };
  }
  return { version: 1, fileKey: "acceptance", components };
}

/**
 * Variants a readback can get wrong, each one of the example Button's
 * measured variants changed as snap would measure the change, with how the
 * push builds it. Figma's render bounds get the first five's border box
 * wrong: a transparent 1px border is in the border box, 2px each way, though
 * it paints nothing; a box shadow is not; a border on one side only makes
 * Figma report strokeWeight as mixed; and the outline Button's 2px border is
 * built INSIDE at a fixed size, and CENTER. The transparent border is built
 * INSIDE too, on a hugging frame with strokesIncludedInLayout, as the skill
 * says for one the fill runs under. The same transparent border built
 * with its paint hidden by the eye icon, visible at full opacity but for
 * `visible: false`, draws nothing either. And a translucent fill, border and
 * text color, snap's `#rrggbbaa` (the soft Chip's background is #4b556322),
 * are Figma paints whose opacity holds the alpha.
 */
function edgeVariants(snapDir) {
  const button = readJson(join(snapDir, "styles.json")).components.find((c) => c.name === "Button");
  const styleOf = (slug) => expandVariants(button).find((v) => v.slug === slug).styles;
  const plain = styleOf("variant-primary--size-sm--disabled-false");
  const outline = styleOf("variant-outline--size-sm--disabled-false");
  assert(!plain.borderUniform && plain.boxShadow.length === 0 && outline.borderUniform?.width === 2,
    "the example Button's primary sm variant has a border or a shadow, or its outline sm variant no 2px border");
  const grown = (dx, dy) => ({ width: Math.round((plain.width + dx) * 100) / 100, height: plain.height + dy });
  const clear = { width: 1, style: "solid", color: null };
  const under = { width: 2, style: "solid", color: "#9ca3af" };
  const tinted = { width: 2, style: "solid", color: "#2563eb4d" };
  const ink = "#111827b3";
  const transparent = { ...plain, ...grown(2, 2), border: { top: clear, right: clear, bottom: clear, left: clear }, borderUniform: clear };
  return [
    { edge: "transparent-border", styles: transparent },
    { edge: "box-shadow", styles: { ...plain, boxShadow: [{ offsetX: 0, offsetY: 4, blur: 12, spread: 0, color: "#0000001a", inset: false }] } },
    { edge: "bottom-border", styles: { ...plain, ...grown(0, 2), border: { top: null, right: null, bottom: under, left: null }, borderUniform: null } },
    { edge: "inside-stroke", styles: outline, strokeAlign: "INSIDE" },
    { edge: "center-stroke", styles: outline, strokeAlign: "CENTER" },
    { edge: "hidden-stroke", styles: transparent, strokeHidden: true },
    { edge: "clear-inside", styles: transparent, strokeAlign: "INSIDE", strokesIncludedInLayout: true, hugging: true },
    {
      edge: "translucent",
      styles: {
        ...outline, backgroundColor: "#4b556322", color: ink, ...(outline.text ? { text: { ...outline.text, color: ink } } : {}),
        border: { top: tinted, right: tinted, bottom: tinted, left: tinted }, borderUniform: tinted,
      },
    },
  ];
}

/**
 * Scores the edge variants, or `edges`, through a readback template: a snap holding them
 * as one component, a simulated set built from them, read back a slice at a
 * time, and verify's verdict on each, keyed by edge. Each has to report a
 * width and a height, so a template that drops them cannot pass by having
 * nothing compared.
 */
async function scoreEdges(snapDir, readback, edges = edgeVariants(snapDir)) {
  const slug = (e) => `edge-${e.edge}`;
  const dir = join(WORK, "snap-edges");
  mkdirSync(dir, { recursive: true });
  cpSync(join(snapDir, "meta.json"), join(dir, "meta.json"));
  const snap = readJson(join(snapDir, "styles.json"));
  const component = {
    name: "Edges", title: "Forms/Edges", category: "Forms", storyId: "forms-edges--default",
    variantProperties: [{ name: "edge", type: "VARIANT", values: edges.map((e) => e.edge), defaultValue: edges[0].edge }],
    base: { combination: { edge: edges[0].edge }, slug: slug(edges[0]), styles: edges[0].styles },
    variants: edges.map((e) => ({ combination: { edge: e.edge }, slug: slug(e), status: "ok", delta: e.styles })),
    warnings: [], error: null,
  };
  writeJson(join(dir, "styles.json"), { ...snap, components: [component] });

  const slugByName = {};
  const sourceBySlug = {};
  const children = edges.map((e) => {
    const name = `edge=${e.edge}`;
    slugByName[name] = slug(e);
    sourceBySlug[slug(e)] = "measured";
    return figmaNode(name, e.styles, e);
  });
  const componentSet = { id: "set:Edges", type: "COMPONENT_SET", name: "Edges", children };
  const { variants } = await readSet(readback, { componentSet, slugByName, sourceBySlug }, READ_BATCH);
  for (const e of edges) {
    const { width, height } = variants[slug(e)];
    assert(Number.isFinite(width) && Number.isFinite(height), `${e.edge} read back a width of ${String(width)} and a height of ${String(height)}`);
  }
  const path = join(WORK, "readback-edges.json");
  writeJson(path, { version: 1, fileKey: "acceptance", components: { [component.title]: { nodeId: componentSet.id, variants } } });
  const v = verifyJson(dir, path);
  assert(v.json?.summary, `verify did not score the edge variants\n${v.out.trim()}`);
  return Object.fromEntries(edges.map((e) => [e.edge, v.json.variants.find((x) => x.slug === slug(e))]));
}

/**
 * Throws unless no edge variant drifts on width or height, and every one but
 * the one-sided border matches on everything, naming each that does not. The
 * readback reports any stroke as a uniform border, so that one drifts on
 * borderUniform: not on its size. Every one has to carry the checksum the
 * template gave it, the one-sided border too, whose mixed strokeWeight drops
 * out of what the call returns.
 */
function assertEdges(verdicts) {
  const describe = (diffs) => diffs.map((d) => `${d.property}: measured ${JSON.stringify(d.measured)}, Figma ${JSON.stringify(d.figma)}`).join("; ");
  const wrong = [];
  for (const [edge, verdict] of Object.entries(verdicts)) {
    if (!verdict || verdict.status === "unscored" || verdict.status === "unverified_readback") {
      wrong.push(`${edge} was ${verdict ? verdict.status : "not scored"}`);
      continue;
    }
    const sized = verdict.differences.filter((d) => d.property === "width" || d.property === "height");
    if (sized.length) wrong.push(`${edge} drifted on its size: ${describe(sized)}`);
    else if (edge !== "bottom-border" && verdict.status !== "verified") wrong.push(`${edge} drifted: ${describe(verdict.differences)}`);
  }
  assert(wrong.length === 0, wrong.join("\n"));
}

/**
 * A 256-variant set named the way snap names one: four properties of four
 * long-ish values each, slugged by snap's own code, every variant styled from
 * one of the example Button's measured variants.
 */
async function realisticSet(snapDir) {
  const { assignVariantSlugs } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-normalize.js")).href);
  const axes = {
    variant: ["primary-action", "secondary-action", "destructive-action", "subtle-outline"],
    size: ["extra-small", "small", "medium", "extra-large"],
    state: ["default", "hovered", "focus-visible", "pressed"],
    iconPlacement: ["leading-icon", "trailing-icon", "icon-only", "without-icon"],
  };
  let combinations = [{}];
  for (const [prop, values] of Object.entries(axes)) {
    combinations = combinations.flatMap((c) => values.map((value) => ({ ...c, [prop]: value })));
  }
  const { slugs } = assignVariantSlugs(combinations);
  const button = readJson(join(snapDir, "styles.json")).components.find((c) => c.name === "Button");
  const styles = expandVariants(button).map((v) => v.styles);
  const slugByName = {};
  const sourceBySlug = {};
  const children = combinations.map((combination, i) => {
    const name = figmaVariantName(combination);
    slugByName[name] = slugs[i];
    sourceBySlug[slugs[i]] = "measured";
    return figmaNode(name, styles[i % styles.length]);
  });
  const componentSet = { id: "set:Realistic", type: "COMPONENT_SET", name: "Button", children };
  const properties = Object.entries(axes).map(([name, values]) => ({ name, type: "VARIANT", values, defaultValue: values[0] }));
  return { componentSet, slugByName, sourceBySlug, styles, properties };
}

const KIDS = Symbol("children");

/**
 * A Figma document that keeps what each use_figma call builds, for the build
 * template. `call()` gives each call its own figma, as use_figma does: it
 * starts on the first page with only that page loaded, and another page's
 * children show once the call switches to it. A container's
 * findAllWithCriteria searches everything under it, in sections and frames
 * too. `nodes(type)` lists every node of a type, wherever it is, for the
 * checks to inspect, and `container(type, name, parent)` adds a section or
 * frame for a designer's moves. Nodes have a position and a size, a new
 * component 100 by 100 at 0,0 as in Figma; children are kept back to front,
 * so appendChild moves a child already there to the end, the top of the
 * layers panel. A set or frame has a layoutMode, 'NONE' as Figma makes one;
 * set to 'HORIZONTAL' or 'VERTICAL', auto layout places its children itself,
 * in child order from its padding, itemSpacing apart, and setting a child's
 * x or y does nothing, as in Figma. `ignorePositions(true)` makes every x and
 * y written from then on do nothing too, for a write Figma ignores that
 * nothing else would catch.
 *
 * Nodes keep shared plugin data and can be removed. `variable(name, hex)`
 * adds a color variable, and a paint or effect bound to one with
 * figma.variables takes its color as Figma does when assigned: a paint bound
 * afresh, to a variable its node's paint at that place was not bound to,
 * gets the variable's alpha as its opacity, as a live push found it set to 1,
 * and one bound as before keeps the opacity it is given; an effect takes the
 * variable's color, alpha and all. loadFontAsync loads only `FONTS`, as the
 * plugin context has only the fonts Figma can load: no system-ui, no Menlo.
 */
function figmaDocument() {
  let count = 0;
  let loaded = new Set();
  let ignored = false;
  const byId = new Map();
  const pages = [];
  const variables = new Map();
  // Where auto layout puts a node, or null when its parent has none.
  const flowed = (node, axis) => {
    const parent = node.parent;
    if (!parent || !parent.layoutMode || parent.layoutMode === "NONE") return null;
    const along = parent.layoutMode === "HORIZONTAL" ? "x" : "y";
    let at = parent.padding ?? 0;
    if (axis !== along) return at;
    for (const child of parent[KIDS]) {
      if (child === node) break;
      at += (along === "x" ? child.width : child.height) + (parent.itemSpacing ?? 0);
    }
    return at;
  };
  const boundTo = (paint) => paint?.boundVariables?.color?.id ?? null;
  // What Figma stores when a node's fills, strokes or effects are assigned.
  const stored = (key, before, list) => list.map((paint, i) => {
    const id = boundTo(paint);
    if (!id) return { ...paint };
    const { r, g, b, a } = variables.get(id).value;
    if (key === "effects") return { ...paint, color: { r, g, b, a } };
    return { ...paint, color: { r, g, b }, opacity: boundTo(before[i]) === id ? paint.opacity : a };
  });
  const create = (type, name) => {
    const node = { id: `${count++}:1`, type, name, parent: null, width: 100, height: 100 };
    // A component's own layers, which the checks keep out of the document.
    if (type === "COMPONENT") node.children = [];
    const at = { x: 0, y: 0 };
    for (const axis of ["x", "y"]) {
      Object.defineProperty(node, axis, {
        enumerable: true,
        get: () => flowed(node, axis) ?? at[axis],
        set: (value) => {
          if (!ignored && flowed(node, axis) === null) at[axis] = value;
        },
      });
    }
    const paints = { fills: [], strokes: [], effects: [] };
    for (const key of Object.keys(paints)) {
      Object.defineProperty(node, key, {
        enumerable: true,
        get: () => paints[key],
        set: (list) => {
          paints[key] = stored(key, paints[key], list);
        },
      });
    }
    const data = new Map();
    node.setSharedPluginData = (namespace, key, value) => {
      if (typeof value !== "string") throw new Error(`setSharedPluginData takes a string, not ${String(value)}`);
      data.set(`${namespace} ${key}`, value);
    };
    node.getSharedPluginData = (namespace, key) => data.get(`${namespace} ${key}`) ?? "";
    node.remove = () => {
      if (node.parent) node.parent[KIDS].splice(node.parent[KIDS].indexOf(node), 1);
      node.parent = null;
      byId.delete(node.id);
    };
    byId.set(node.id, node);
    return node;
  };
  const adopt = (parent, child) => {
    if (child.parent) child.parent[KIDS].splice(child.parent[KIDS].indexOf(child), 1);
    child.parent = parent;
    parent[KIDS].push(child);
  };
  const container = (type, name) => {
    const node = create(type, name);
    node[KIDS] = [];
    if (type === "COMPONENT_SET" || type === "FRAME") node.layoutMode = "NONE";
    Object.defineProperty(node, "children", {
      enumerable: true,
      get: () => (type === "PAGE" && !loaded.has(node.id) ? [] : node[KIDS]),
    });
    node.appendChild = (child) => {
      if (type === "COMPONENT_SET" && child.type !== "COMPONENT") {
        throw new Error(`a component set takes components, not a ${child.type}`);
      }
      adopt(node, child);
    };
    node.resizeWithoutConstraints = (width, height) => {
      if (!(width >= 0.01 && height >= 0.01)) throw new Error(`cannot resize a ${type} to ${width} by ${height}`);
      Object.assign(node, { width, height });
    };
    node.findAllWithCriteria = ({ types }) => node.children.flatMap((child) => [
      ...(types.includes(child.type) ? [child] : []),
      ...(child.findAllWithCriteria ? child.findAllWithCriteria({ types }) : []),
    ]);
    return node;
  };
  const page = (name) => {
    const node = container("PAGE", name);
    pages.push(node);
    return node;
  };
  page("Page 1");
  const bind = (item, field, variable) => {
    const { [field]: _, ...rest } = item.boundVariables ?? {};
    return { ...item, boundVariables: variable ? { ...rest, [field]: { type: "VARIABLE_ALIAS", id: variable.id } } : rest };
  };
  const call = () => {
    loaded = new Set([pages[0].id]);
    const figma = {
      root: { children: pages },
      currentPage: pages[0],
      createPage: () => page(`Page ${pages.length + 1}`),
      setCurrentPageAsync: async (p) => {
        loaded.add(p.id);
        figma.currentPage = p;
      },
      getNodeByIdAsync: async (id) => byId.get(id) ?? null,
      createComponent: () => {
        const component = create("COMPONENT", "Component 1");
        adopt(figma.currentPage, component);
        return component;
      },
      combineAsVariants: (components, parent) => {
        if (components.length === 0 || components.some((c) => c.type !== "COMPONENT")) {
          throw new Error("combineAsVariants takes one or more components");
        }
        const set = container("COMPONENT_SET", "Component 1");
        adopt(parent, set);
        for (const component of components) adopt(set, component);
        // Figma sizes a new set to its variants where they stand.
        set.width = Math.max(...components.map((c) => c.x + c.width));
        set.height = Math.max(...components.map((c) => c.y + c.height));
        return set;
      },
      variables: {
        setBoundVariableForPaint: (paint, field, variable) => bind(paint, field, variable),
        setBoundVariableForEffect: (effect, field, variable) => bind(effect, field, variable),
      },
      loadFontAsync: async ({ family, style }) => {
        if (!FONTS[family]?.includes(style)) throw new Error(`The font "${family} ${style}" could not be loaded`);
      },
    };
    return figma;
  };
  const nodes = (type) => [...byId.values()].filter((n) => n.type === type);
  const inside = (type, name, parent) => {
    const node = container(type, name);
    adopt(parent, node);
    return node;
  };
  const ignorePositions = (on) => {
    ignored = on;
  };
  const variable = (name, hex) => {
    const made = { id: `VariableID:${variables.size + 1}`, name, resolvedType: "COLOR", value: { ...rgb01(hex), a: alpha01(hex) } };
    variables.set(made.id, made);
    return made;
  };
  return { call, nodes, container: inside, ignorePositions, variable };
}

/**
 * The fonts the simulated plugin context can load, with Figma's own style
 * names: Inter's spaced, Roboto Mono's and Noto Serif's not. Roboto Mono
 * stops at Bold.
 */
const FONTS = {
  Inter: ["Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"],
  "Roboto Mono": ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold"],
  "Noto Serif": ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"],
};

/**
 * The build template from the shipped skill: one part of a set.
 *
 * Its VARIANTS table is replaced with the part's own variants, and its
 * PROPERTIES table with the component's variantProperties from snap, each
 * written an entry a line, and PAGE_NAME, SET_NAME, ID, TITLE, SET_ID and
 * PART with the call's own. applyStyles is where the agent writes the Plugin
 * API code that styles a variant; `run()` gives it the simulated node of
 * figmaNode() for those styles, sized as Figma sizes it, so the readback
 * template reads back exactly what the part sent, or, given `styler`, that
 * code instead, run beside the template's own helpers with `scope`'s names
 * in reach. Everything else, finding the set and its variants, creating what
 * is missing, and laying the set out, runs verbatim. `code(..., { styled:
 * false })` leaves applyStyles as the skill ships it, for pricing what an
 * agent would send. `mutate` rewrites the shipped code, to show a check fails
 * a template that gets something wrong.
 */
function loadSkillBuild(mutate = null) {
  const block = useFigmaBlock(/^Create or update/);
  const list = /const VARIANTS = \[[\s\S]*?\n\s*\];/;
  const table = /const PROPERTIES = \[[\s\S]*?\n\s*\];/;
  const styler = /const applyStyles = async \(variant, styles\) => \{[\s\S]*?\n\s*\};/;
  assert(list.test(block), "the build template has no VARIANTS table to loop over");
  assert(table.test(block), "the build template has no PROPERTIES table to lay the set out by");
  assert(styler.test(block), "the build template has no applyStyles for the agent's styling code");
  for (const name of ["PAGE_NAME", "SET_NAME", "ID", "TITLE", "SET_ID", "PART"]) {
    assert(constant(name).test(block), `the build template defines no ${name}`);
  }
  const part = Number(/const PART = (\d+);/.exec(block)?.[1]);
  assert(part > 0, "the build template's PART is not a number");
  const shipped = mutate ? mutate(block) : block;
  assert(!mutate || shipped !== block, "the mutation no longer matches the build template");
  const code = (variants, constants, properties, { styled = true, styler: own = null } = {}) => {
    assert(Array.isArray(properties), "a build part needs the component's variantProperties");
    const body = withConstants(shipped, constants)
      .replace(table, () => `const PROPERTIES = [\n${properties.map((p) => `      ${JSON.stringify(p)},`).join("\n")}\n    ];`)
      .replace(list, () => `const VARIANTS = [\n${variants.map(({ name, styles }) => `      ${JSON.stringify({ name, styles })},`).join("\n")}\n    ];`);
    const styling = own ?? "Object.assign(variant, look(variant.name, styles));";
    return styled ? body.replace(styler, () => `const applyStyles = async (variant, styles) => {\n      ${styling}\n    };`) : body;
  };
  const look = (name, styles) => {
    const { name: _, ...node } = figmaNode(name, styles);
    return node;
  };
  const run = async (figma, variants, constants, properties, { styler: own = null, scope = {} } = {}) =>
    JSON.parse(await new AsyncFunction("figma", "look", ...Object.keys(scope), code(variants, constants, properties, { styler: own }))(
      figma, look, ...Object.values(scope)));
  return { part, code, run, look };
}

/**
 * Pushes one set the way the skill says to: `variants` in snap's order, in
 * parts of `part`, the first part finding the set by name and every later one
 * by the id the first returned, each carrying the component's `properties`
 * and its Storybook `storyId` and `title`, by default `forms-<set>` and
 * `Forms/<set>`. `styler` and `scope` style the variants another way, as
 * `run()` takes them. Returns what each part returned, calling `after` with
 * each as it does.
 */
async function pushSet(build, doc, { page, set, variants, part, properties, after = null, storyId = null, title = null, styler = null, scope = {} }) {
  const parts = [];
  let id = null;
  const named = { ID: storyId ?? `forms-${set.toLowerCase()}`, TITLE: title ?? `Forms/${set}` };
  for (const slice of slices(variants, part)) {
    const constants = { PAGE_NAME: page, SET_NAME: set, ...named, SET_ID: id, PART: part };
    const result = await build.run(doc.call(), slice, constants, properties, { styler, scope });
    assert(id === null || result.id === id, `a part returned the set ${result.id}, not ${id}`);
    id = result.id;
    parts.push(result);
    if (after) after(result);
  }
  return parts;
}

/** Throws unless no two of a set's variants intersect and the set contains them all. */
function assertLaidOut(set) {
  const boxes = set.children.map((n) => ({ name: n.name, x: n.x, y: n.y, r: n.x + n.width, b: n.y + n.height }));
  boxes.forEach((a, i) => {
    assert(a.x >= 0 && a.y >= 0 && a.r <= set.width && a.b <= set.height,
      `"${a.name}" at ${a.x},${a.y} to ${a.r},${a.b} is outside the set's ${set.width} by ${set.height}`);
    for (const b of boxes.slice(i + 1)) {
      assert(!(a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b), `"${a.name}" and "${b.name}" overlap`);
    }
  });
}

/** A set an earlier build left on a page of its own: `variants` in that order, every one at 0,0. */
async function leftSet(build, doc, variants, { page = "Forms", set = "Button" } = {}) {
  const call = doc.call();
  const onto = call.createPage();
  onto.name = page;
  await call.setCurrentPageAsync(onto);
  const made = call.combineAsVariants(variants.map(({ name, styles }) => {
    const node = call.createComponent();
    Object.assign(node, build.look(name, styles), { name });
    return node;
  }), onto);
  made.name = set;
  return made;
}

/** A set an earlier push left beside the others on `page`, at 0,0: `variants` in that order. */
async function besideSet(build, doc, page, set, variants) {
  const call = doc.call();
  const onto = call.root.children.find((p) => p.name === page);
  await call.setCurrentPageAsync(onto);
  const made = call.combineAsVariants(variants.map(({ name, styles }) => {
    const node = call.createComponent();
    Object.assign(node, build.look(name, styles), { name });
    return node;
  }), onto);
  made.name = set;
  return made;
}

/**
 * Throws unless `set` is laid out as `rows`, each a list of variant names with
 * null for a gap, and `extra` in a row of its own below: neighboring columns
 * and rows exactly `gap` apart, each column as wide as its widest variant and
 * each row as tall as its tallest, the set reaching `gap` past the last of
 * them, nothing overlapping, and the layers panel reading the same way, row by
 * row. Returns the grid's nodes, null for a gap. Lengths agree to within a
 * millionth of a pixel, as a 0.01-high variant's row adds up in floats.
 */
function assertGridOf(set, rows, extra, gap) {
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const panel = [...set.children].reverse();
  const reading = [...rows.flat().filter(Boolean), ...extra];
  assert(panel.map((n) => n.name).join("; ") === reading.join("; "), `the layers panel reads ${panel.map((n) => n.name).join("; ")}`);
  let next = 0;
  const grid = rows.map((row) => row.map((name) => (name ? panel[next++] : null)));
  const below = panel.slice(next);
  const xs = [];
  const widths = [];
  rows[0].forEach((_, c) => {
    const column = grid.map((row) => row[c]).filter(Boolean);
    assert(column.length && new Set(column.map((n) => n.x)).size === 1, `column ${c + 1} is at ${column.map((n) => n.x).join(", ")} across`);
    xs.push(column[0].x);
    widths.push(Math.max(...column.map((n) => n.width)));
  });
  const ys = [];
  const heights = [];
  grid.forEach((row, r) => {
    const cells = row.filter(Boolean);
    assert(cells.length && new Set(cells.map((n) => n.y)).size === 1, `row ${r + 1} is at ${cells.map((n) => n.y).join(", ")} down`);
    ys.push(cells[0].y);
    heights.push(Math.max(...cells.map((n) => n.height)));
  });
  assert(xs[0] === gap && ys[0] === gap, `the first column and row are at ${xs[0]},${ys[0]}, not ${gap},${gap}`);
  xs.slice(1).forEach((x, c) => {
    const space = x - (xs[c] + widths[c]);
    assert(near(space, gap), `column ${c + 2} starts ${space} past column ${c + 1}'s widest variant, not ${gap}`);
  });
  ys.slice(1).forEach((y, r) => {
    const space = y - (ys[r] + heights[r]);
    assert(near(space, gap), `row ${r + 2} starts ${space} below row ${r + 1}'s tallest variant, not ${gap}`);
  });
  let right = xs[xs.length - 1] + widths[widths.length - 1];
  let bottom = ys[ys.length - 1] + heights[heights.length - 1];
  if (below.length) {
    const space = below[0].y - bottom;
    assert(near(space, gap) && below.every((n) => n.y === below[0].y), `the extra row starts ${space} below the grid, not ${gap}`);
    assert(below[0].x === gap, `the extra row starts at ${below[0].x} across, not ${gap}`);
    below.slice(1).forEach((n, k) => {
      const after = n.x - (below[k].x + below[k].width);
      assert(near(after, gap), `"${n.name}" starts ${after} past "${below[k].name}", not ${gap}`);
    });
    right = Math.max(right, below[below.length - 1].x + below[below.length - 1].width);
    bottom = below[0].y + Math.max(...below.map((n) => n.height));
  }
  assert(near(set.width, right + gap) && near(set.height, bottom + gap),
    `the set is ${set.width} by ${set.height}, not ${right + gap} by ${bottom + gap}`);
  assertLaidOut(set);
  return grid;
}

/**
 * The checks on the build template's layout, each `(build) => detail`,
 * throwing when `build` lays a set out wrong, so a mutant of the template can
 * be run through every one. `declared()` checks snap records the example
 * Button's values in the order its story's argTypes declare them. snap reads
 * them from the props Storybook's docs list, the union in the component's own
 * type, not from argTypes, which Storybook's MCP docs do not give; here the
 * two agree.
 */
function layoutScenarios(snapDir) {
  let cached = null;
  const data = () => {
    if (cached) return cached;
    const md = readFileSync(SKILL, "utf8");
    const gap = Number(/each row as tall as its tallest, (\d+) apart/.exec(md)?.[1]);
    assert(gap > 0, "the skill gives no spacing for the layout");
    const { component } = simulatedSets(snapDir).find((s) => s.component.name === "Button");
    const measured = expandVariants(component).map((v) => ({ name: figmaVariantName(v.combination), styles: v.styles }));
    const frozen = simulatedSets(snapDir).find((s) => s.component.name === "Frozen").component;
    cached = { gap, properties: component.variantProperties, measured, frozen };
    return cached;
  };
  const ROWS = ["primary", "danger", "outline"];
  const COLUMNS = ["size=sm, disabled=false", "size=sm, disabled=true", "size=lg, disabled=false", "size=lg, disabled=true"];
  const named = (row, column) => `variant=${row}, ${column}`;
  const GRID = ROWS.map((row) => COLUMNS.map((column) => named(row, column)));
  const EXTRA = "variant=ghost, size=sm, disabled=false";
  const SCRAMBLE = [9, 2, 6, 11, 0, 4, 8, 1, 10, 5, 3, 7];
  const PART = 5;
  const repaint = (variants) => variants.map((v) => ({ ...v, styles: { ...v.styles, backgroundColor: "#7c3aed" } }));
  const scrambled = (measured) => {
    assert([...SCRAMBLE].sort((a, b) => a - b).join() === measured.map((_, i) => i).join(), "SCRAMBLE is not an order of the 12 variants");
    return SCRAMBLE.map((i) => measured[i]);
  };

  return {
    declared() {
      const { properties } = data();
      const read = properties.map((p) => `${p.name}=${p.values.join("|")} (${p.defaultValue})`).join(", ");
      assert(read === "variant=primary|danger|outline (primary), size=sm|lg (sm), disabled=true|false (false)",
        `snap records the Button's properties as ${read}`);
      const story = readFileSync(EXAMPLE_STORIES, "utf8");
      for (const p of properties.filter((q) => q.type === "VARIANT")) {
        const options = new RegExp(`\\b${p.name}:\\s*\\{[^}]*\\boptions:\\s*\\[([^\\]]*)\\]`).exec(story)?.[1];
        assert(options, `the Button's story declares no options for ${p.name}`);
        const values = [...options.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
        assert(values.join("|") === p.values.join("|"), `snap records ${p.name} as ${p.values.join(", ")}, the story declares ${values.join(", ")}`);
      }
      return "snap records the Button's values in the order its story's argTypes declare them";
    },

    async scrambled(build) {
      // Variants stacked at 0,0 in a scrambled order, one snap does not have
      // among them, pushed in parts of 5, in snap's order and in reverse.
      const { gap, properties, measured } = data();
      const run = async (order) => {
        const doc = figmaDocument();
        const earlier = scrambled(measured);
        earlier.splice(4, 0, { name: EXTRA, styles: measured[0].styles });
        const set = await leftSet(build, doc, earlier);
        const parts = await pushSet(build, doc, { page: "Forms", set: "Button", variants: order, part: PART, properties });
        const last = parts[parts.length - 1];
        assert(last.id === set.id && last.variants === 13 && last.rows === 3 && last.columns === 4 && last.extra === 1,
          `the last part returned ${JSON.stringify(last)}`);
        assert(parts.every((p) => p.added === 0), "the push added a variant the set already had");
        assertGridOf(set, GRID, [EXTRA], gap);
        return set.children.map((n) => [n.name, n.x, n.y]);
      };
      const laid = await run(measured);
      assert(JSON.stringify(await run([...measured].reverse())) === JSON.stringify(laid), "parts in another order laid the set out differently");
      return "3 rows of 4 and the extra variant below, from a scrambled set and from parts in reverse";
    },

    async defaults(build) {
      // Each property runs default first. A BOOLEAN that defaults to true
      // runs true, false, though map lists it true, false whatever its
      // default, so Figma's default, the top-left variant, is disabled, as
      // the component's is. A VARIANT's values run as PROPERTIES lists them,
      // which snap does default first: so outline and lg, called the
      // defaults here though listed last, stay where they are listed.
      const { gap, properties, measured } = data();
      const shifted = properties.map((p) => ({ ...p, defaultValue: p.type === "BOOLEAN" ? "true" : p.values[p.values.length - 1] }));
      const doc = figmaDocument();
      const set = await leftSet(build, doc, scrambled(measured));
      await pushSet(build, doc, { page: "Forms", set: "Button", variants: measured, part: PART, properties: shifted });
      const columns = [1, 0, 3, 2].map((c) => COLUMNS[c]);
      assertGridOf(set, ROWS.map((row) => columns.map((column) => named(row, column))), [], gap);
      return "disabled first where it defaults to true; outline and lg, called the defaults, where PROPERTIES lists them";
    },

    async sizes(build) {
      // snap measures a closed Collapsible's content 0 high, and a Drawer's
      // closed trigger, 39.34 by 24, in the set of its open panel, 1280 by
      // 197 or 320 by 800. A zero side is built at 0.01, the least Figma
      // takes; each column is as wide as its widest variant and each row as
      // tall as its tallest, so none overlaps or hides another, and the
      // 0.01-high variant keeps a row of its own.
      const { gap, measured } = data();
      const inline = measured[0].styles;
      const panel = (width, height) => ({ ...inline, display: "block", width, height, border: null, borderUniform: null });
      const trigger = { ...inline, width: 39.34, height: 24 };
      const drawer = (direction, open) => `direction=${direction}, open=${open}`;
      const sets = [
        {
          set: "Drawer",
          properties: [
            { name: "direction", type: "VARIANT", values: ["bottom", "right"], defaultValue: "bottom" },
            { name: "open", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" },
          ],
          variants: [
            { name: drawer("bottom", true), styles: panel(1280, 197) }, { name: drawer("bottom", false), styles: trigger },
            { name: drawer("right", true), styles: panel(320, 800) }, { name: drawer("right", false), styles: trigger },
          ],
          grid: ["bottom", "right"].map((d) => [drawer(d, false), drawer(d, true)]),
        },
        {
          set: "Collapsible",
          properties: [{ name: "open", type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" }],
          variants: [{ name: "open=true", styles: panel(1248, 120) }, { name: "open=false", styles: panel(1248, 0) }],
          grid: [["open=false"], ["open=true"]],
        },
      ];
      const doc = figmaDocument();
      for (const { set, properties, variants, grid } of sets) {
        await pushSet(build, doc, { page: "Overlays", set, variants, part: PART, properties });
        const built = doc.nodes("COMPONENT_SET").find((n) => n.name === set);
        assertGridOf(built, grid, [], gap);
        for (const n of built.children) assert(n.width >= 0.01 && n.height >= 0.01, `"${n.name}" is ${n.width} by ${n.height}`);
      }
      const [closed] = doc.nodes("COMPONENT").filter((n) => n.name === "open=false");
      assert(closed.height === 0.01, `the closed Collapsible is ${closed.height} high, not 0.01`);
      return "a Drawer's 39 by 24 trigger beside its 1280 by 197 and 320 by 800 panels, and a 0.01-high Collapsible, laid out apart";
    },

    async frozen(build) {
      // With one property, each value is a row of one: Frozen's a, b and c.
      const { gap, frozen } = data();
      const doc = figmaDocument();
      const variants = expandVariants(frozen).map((v) => ({ name: figmaVariantName(v.combination), styles: v.styles })).reverse();
      const [only] = await pushSet(build, doc, { page: "Forms", set: "Frozen", part: PART, properties: frozen.variantProperties, variants });
      assert(only.rows === 3 && only.columns === 1 && only.extra === 0, `Frozen's one property laid out as ${only.rows} rows of ${only.columns}`);
      assertGridOf(doc.nodes("COMPONENT_SET")[0], [["variant=a"], ["variant=b"], ["variant=c"]], [], gap);
      return "one property in a column of 3";
    },

    async gaps(build) {
      // An earlier build left the set without the danger row or the lg
      // disabled column, with a variant snap does not have and one no
      // combination names, out of name order, and an outline sm variant made
      // twice, the copy with the higher id first. Two parts that carry
      // neither lay it out in 2 rows of 3, the extras in a row below by name,
      // and both keep the copy with the lower id in the grid.
      const { gap, properties, measured } = data();
      const TWICE = named("outline", COLUMNS[0]);
      const kept = measured.filter((v) => !v.name.startsWith("variant=danger, ") && !v.name.endsWith(COLUMNS[3]));
      const styleOf = (name) => measured.find((v) => v.name === name).styles;
      const doc = figmaDocument();
      const set = await leftSet(build, doc, [
        { name: EXTRA, styles: styleOf(GRID[0][0]) }, ...kept, { name: TWICE, styles: styleOf(TWICE) }, { name: "Size=Large", styles: styleOf(GRID[0][2]) },
      ]);
      const copies = set.children.filter((n) => n.name === TWICE);
      const lower = copies[0].id < copies[1].id ? copies[0] : copies[1];
      set.appendChild(lower);
      assert(set.children.findIndex((n) => n.name === TWICE) !== set.children.indexOf(lower), "the copy with the lower id comes first");
      const rows = ["primary", "outline"].map((row) => COLUMNS.slice(0, 3).map((column) => named(row, column)));
      const extra = ["Size=Large", EXTRA, TWICE];
      const carried = kept.filter((v) => v.name !== TWICE);
      const parts = [];
      await pushSet(build, doc, {
        page: "Forms", set: "Button", variants: carried, part: 3, properties,
        after: (result) => {
          assert(result.variants === 9 && result.rows === 2 && result.columns === 3 && result.extra === 3,
            `part ${parts.length + 1} returned ${JSON.stringify(result)}`);
          const grid = assertGridOf(set, rows, extra, gap);
          assert(grid[1][0].id === lower.id, `part ${parts.length + 1} put ${TWICE} ${grid[1][0].id} in the grid, not ${lower.id}`);
          parts.push(result);
        },
      });
      assert(parts.length === 2, `the push made ${parts.length} parts, not 2`);
      return `2 rows of 3, ${gap} apart, and 3 extra below by name, the same copy in the grid on both parts`;
    },

    async autoLayout(build) {
      // On a set with auto layout, x and y do nothing and the layer order
      // flows the variants, so the part refuses it before changing anything;
      // once the user turns auto layout off, the part lays it out.
      const { gap, properties, measured } = data();
      const doc = figmaDocument();
      const set = await leftSet(build, doc, scrambled(measured));
      Object.assign(set, { layoutMode: "HORIZONTAL", itemSpacing: 8, padding: 8 });
      const state = () => JSON.stringify(set.children.map((n) => [n.id, n.name, n.x, n.y, n.fills]));
      const before = state();
      const components = doc.nodes("COMPONENT").length;
      let refused = null;
      try {
        await pushSet(build, doc, { page: "Forms", set: "Button", variants: repaint(measured), part: PART, properties });
      } catch (err) {
        refused = err.message;
      }
      assert(refused && /has auto layout \(HORIZONTAL\)/.test(refused) && /ask the user/.test(refused),
        `a part on a set with auto layout ${refused ? `failed with: ${refused}` : "was built"}`);
      assert(state() === before && doc.nodes("COMPONENT").length === components, "the refused part changed the set");
      set.layoutMode = "NONE";
      await pushSet(build, doc, { page: "Forms", set: "Button", variants: repaint(measured), part: PART, properties });
      assertGridOf(set, GRID, [], gap);
      return "refused with the set as it was, then laid out with auto layout off";
    },

    async ignored(build) {
      // Two variants of one size swapped, nothing overlapping and the set
      // containing both, in a Figma that ignores their moves: only the check
      // that every variant is where the layout put it can see it.
      const { properties, measured } = data();
      const reference = figmaDocument();
      const laid = await leftSet(build, reference, measured);
      await pushSet(build, reference, { page: "Forms", set: "Button", variants: measured, part: PART, properties });
      const [a, b] = [GRID[0][0], GRID[0][1]].map((name) => laid.children.find((n) => n.name === name));
      assert(a.width === b.width && a.height === b.height, `${a.name} and ${b.name} differ in size`);
      const where = new Map(laid.children.map((n) => [n.name, [n.x, n.y]]));
      where.set(a.name, [b.x, b.y]);
      where.set(b.name, [a.x, a.y]);
      const doc = figmaDocument();
      const set = await leftSet(build, doc, measured);
      for (const n of set.children) [n.x, n.y] = where.get(n.name);
      Object.assign(set, { width: laid.width, height: laid.height });
      assertLaidOut(set);
      doc.ignorePositions(true);
      let failure = null;
      try {
        await pushSet(build, doc, { page: "Forms", set: "Button", variants: measured, part: PART, properties });
      } catch (err) {
        failure = err.message;
      }
      assert(failure && failure.includes(`"${a.name}" is not where the layout put it`),
        `a part whose moves Figma ignored ${failure ? `failed with: ${failure}` : "passed"}`);
      return "refused, naming the first variant out of place";
    },

    async booleans(build) {
      // One VARIANT and 20 BOOLEANs allow 3 × 2^20 combinations; six variants
      // lay out in 2 rows of 3 from their names alone: all false, then the
      // last flag, which varies fastest, then the first.
      const { gap, measured } = data();
      const flags = Array.from({ length: 20 }, (_, i) => `flag${i}`);
      const properties = [
        { name: "variant", type: "VARIANT", values: ["a", "b", "c"], defaultValue: "a" },
        ...flags.map((name) => ({ name, type: "BOOLEAN", values: ["true", "false"], defaultValue: "false" })),
      ];
      const name = (variant, on) => [`variant=${variant}`, ...flags.map((f) => `${f}=${f === on}`)].join(", ");
      const variants = ["c", "a"].flatMap((v) => ["flag0", null, "flag19"].map((on) => ({ name: name(v, on), styles: measured[0].styles })));
      const doc = figmaDocument();
      const started = performance.now();
      const [result] = await pushSet(build, doc, { page: "Forms", set: "Flags", variants, part: 25, properties });
      const ms = performance.now() - started;
      assert(result.rows === 2 && result.columns === 3 && result.extra === 0, `the part returned ${JSON.stringify(result)}`);
      assertGridOf(doc.nodes("COMPONENT_SET")[0], ["a", "c"].map((v) => [null, "flag19", "flag0"].map((on) => name(v, on))), [], gap);
      assert(ms < 1000, `a part of 6 variants took ${Math.round(ms)} ms`);
      return `2 rows of 3 in ${Math.round(ms)} ms`;
    },
  };
}

/**
 * The checks on what the build template does besides the layout, each
 * `(build) => detail`, throwing when `build` gets it wrong, so a mutant of
 * the template can be run through every one, as the layout's are. Each
 * reproduces what a live push of shadcn/ui's components ran into.
 */
function buildScenarios(snapDir) {
  let cached = null;
  const data = () => {
    if (cached) return cached;
    const sets = simulatedSets(snapDir);
    const variantsOf = (component) => expandVariants(component).map((v) => ({ name: figmaVariantName(v.combination), styles: v.styles }));
    const button = sets.find((s) => s.component.name === "Button").component;
    const frozen = sets.find((s) => s.component.name === "Frozen").component;
    cached = { button, frozen, measured: variantsOf(button), frozenVariants: variantsOf(frozen) };
    return cached;
  };
  const refused = async (attempt) => {
    try {
      await attempt();
    } catch (err) {
      return err.message;
    }
    return null;
  };
  // The top-level sets and plain components a document's pages hold.
  const placed = (doc) => ["COMPONENT_SET", "COMPONENT"].flatMap((type) => doc.nodes(type)).filter((n) => n.parent?.type === "PAGE");

  return {
    async plain(build, readback = loadSkillReadback()) {
      // map gave Button, Badge, Dialog and Tooltip no variant properties, and
      // the build made each a set of one variant named '', which Figma
      // renamed "=" and marked as broken: the readback found no variant
      // named '', and componentPropertyDefinitions threw on every one. Such
      // a component is one plain component on its page, restyled in place by
      // the next push, read back as its own one variant, named '', and
      // scored by verify under the slug default. A set an earlier push left
      // of that name is refused, as is a plain one where a set is built.
      const { measured } = data();
      const { dir } = await proplessReadback(snapDir);
      const styles = expandVariants(readJson(join(dir, "styles.json")).components.find((c) => c.name === "Badge"))[0].styles;
      const doc = figmaDocument();
      const push = (st, properties = [], name = "") => pushSet(build, doc, {
        page: "Data", set: "Badge", storyId: "data-badge", title: "Data/Badge", part: 25, properties, variants: [{ name, styles: st }],
      });
      const [first] = await push(styles);
      assert(JSON.stringify({ ...first, id: 0, name: 0 }) === JSON.stringify({ id: 0, name: 0, variants: 1, added: 1, updated: 0, rows: 1, columns: 1, extra: 0, overlaps: 0, fonts: {} }),
        `the part returned ${JSON.stringify(first)}`);
      const [component] = doc.nodes("COMPONENT");
      assert(doc.nodes("COMPONENT_SET").length === 0 && doc.nodes("COMPONENT").length === 1 && component.id === first.id,
        `a component with no variant properties was built as ${doc.nodes("COMPONENT_SET").length} sets and ${doc.nodes("COMPONENT").length} components`);
      assert(component.name === "Badge" && component.parent.type === "PAGE" && component.parent.name === "Data",
        `the component is "${component.name}" on ${component.parent?.type} "${component.parent?.name}"`);
      const read = async () => (await readSet(readback, { componentSet: component, slugByName: { "": "default" }, sourceBySlug: { default: "measured" } }, READ_BATCH)).variants;
      const file = join(WORK, "readback-plain.json");
      writeJson(file, { version: 1, fileKey: "acceptance", components: { "Data/Badge": { nodeId: component.id, variants: await read() } } });
      const verdict = verifyJson(dir, file).json?.variants?.find((v) => v.component === "Data/Badge");
      assert(verdict?.slug === "default" && verdict.status === "verified", `verify scored the plain Badge ${JSON.stringify(verdict)}`);

      const [second] = await push({ ...styles, backgroundColor: "#0f766e" });
      assert(second.id === first.id && second.added === 0 && second.updated === 1 && doc.nodes("COMPONENT").length === 1,
        `the second push returned ${JSON.stringify(second)}, leaving ${doc.nodes("COMPONENT").length} components`);
      const again = await read();
      assert(again.default.backgroundColor === "#0f766e", `the second push left the fill ${again.default.backgroundColor}`);

      // Named other than '', or pushed as a set onto the plain one: refused.
      const typed = await refused(() => build.run(doc.call(), [{ name: "", styles }],
        { PAGE_NAME: "Data", SET_NAME: "Badge", ID: "data-badge", TITLE: "Data/Badge", SET_ID: component.id, PART: 25 },
        [{ name: "variant", type: "VARIANT", values: ["solid"], defaultValue: "solid" }]));
      assert(typed && typed.includes("COMPONENT_SET") && typed.includes("it is a COMPONENT"), `a later part given the plain Badge's id for a set ${typed ? `failed with: ${typed}` : "was built"}`);
      const misnamed = await refused(() => push(styles, [], "default"));
      assert(misnamed && /name the one variant ""/.test(misnamed), `a part naming its one variant "default" ${misnamed ? `failed with: ${misnamed}` : "was built"}`);
      const variant = [{ name: "variant", type: "VARIANT", values: ["solid"], defaultValue: "solid" }];
      const grown = await refused(() => push(styles, variant, "variant=solid"));
      assert(grown && grown.includes(component.id) && /ask the user/.test(grown) && doc.nodes("COMPONENT_SET").length === 0,
        `a set pushed where the plain Badge is ${grown ? `failed with: ${grown}` : "was built"}`);

      // A set a push before 0.4.0 left, its one variant named "=" by Figma.
      const old = figmaDocument();
      const broken = await leftSet(build, old, [{ name: "=", styles: measured[0].styles }], { page: "Data", set: "Badge" });
      const before = old.nodes("COMPONENT").length;
      const left = await refused(() => pushSet(build, old, { page: "Data", set: "Badge", part: 25, properties: [], variants: [{ name: "", styles }] }));
      assert(left && left.includes(broken.id) && /ask the user/.test(left) && old.nodes("COMPONENT").length === before,
        `a plain Badge pushed beside the broken set ${left ? `failed with: ${left}` : "was built"}, leaving ${old.nodes("COMPONENT").length - before} more components`);
      return "built, read back and verified as one component, restyled in place; a misnamed variant, a set pushed onto it and the broken set refused";
    },

    async placed(build) {
      // Every set the build created landed at 0,0, on top of the page's
      // others. A new set or component goes 100 below everything on its
      // page, one already there stays where it is, and each carries its
      // Storybook id and title, so a set a designer renames is still found.
      const { button, frozen, measured, frozenVariants } = data();
      const doc = figmaDocument();
      const pushes = [
        { set: "Button", variants: measured, properties: button.variantProperties, storyId: button.id, title: button.title },
        { set: "Frozen", variants: frozenVariants, properties: frozen.variantProperties, storyId: frozen.id, title: frozen.title },
        { set: "Badge", variants: [{ name: "", styles: measured[0].styles }], properties: [], storyId: "forms-badge", title: "Forms/Badge" },
      ];
      const pushAll = async () => {
        for (const p of pushes) await pushSet(build, doc, { page: "Forms", part: 25, ...p });
      };
      await pushAll();
      const nodes = placed(doc);
      assert(nodes.map((n) => n.name).join() === "Button,Frozen,Badge", `the page holds ${nodes.map((n) => n.name).join(", ")}`);
      nodes.forEach((n, i) => {
        const above = nodes[i - 1];
        const y = above ? above.y + above.height + 100 : 0;
        assert(n.x === 0 && n.y === y, `"${n.name}" is at ${n.x},${n.y}, not 0,${y}`);
        const p = pushes[i];
        const kept = [n.getSharedPluginData("storysync", "id"), n.getSharedPluginData("storysync", "title")];
        assert(kept.join() === [p.storyId, p.title].join(), `"${n.name}" keeps the id and title ${kept.join(", ")}`);
      });
      // A designer moves the Button and renames it: the next push finds it by
      // its id, restyles it there, and moves nothing.
      const [set] = nodes;
      const parts = [];
      const counted = async () => {
        for (const p of pushes) parts.push(...await pushSet(build, doc, { page: "Forms", part: 25, ...p }));
      };
      await counted();
      assert(parts.every((r) => r.overlaps === 0), `parts on a laid-out page returned overlaps ${parts.map((r) => r.overlaps).join(", ")}`);
      Object.assign(set, { x: 600, y: -400, name: "Buttons" });
      const where = () => JSON.stringify(placed(doc).map((n) => [n.id, n.x, n.y]));
      const before = where();
      await pushAll();
      assert(where() === before && placed(doc).length === 3, `a second push moved or added a set: ${where()}`);
      assert(set.name === "Buttons", `the push renamed the set "${set.name}"`);
      // A set an earlier push left with no id on it gets one; and where that
      // push left two at 0,0, one on the other, each part counts the other in
      // overlaps and moves neither.
      const old = figmaDocument();
      const left = await leftSet(build, old, measured, { page: "Forms", set: "Button" });
      const frozenLeft = await besideSet(build, old, "Forms", "Frozen", frozenVariants);
      const [stacked] = await pushSet(build, old, { page: "Forms", part: 25, ...pushes[0] });
      const [under] = await pushSet(build, old, { page: "Forms", part: 25, ...pushes[1] });
      assert(left.getSharedPluginData("storysync", "id") === button.id, "a set an earlier push left was given no id");
      assert(stacked.overlaps === 1 && under.overlaps === 1, `two sets at 0,0 returned overlaps ${stacked.overlaps} and ${under.overlaps}`);
      assert([left, frozenLeft].every((n) => n.x === 0 && n.y === 0), "a part moved a set an earlier push left at 0,0");
      return "Button, Frozen and Badge 100 apart, each with its id and title and no overlaps; a moved, renamed set found by its id and left where it was; " +
        "two sets an earlier push stacked at 0,0 each counted in the other's overlaps, unmoved";
    },

    async found(build) {
      // The first part matched a set by its name or its id at once, so a
      // copy of a set (Ctrl+D), which keeps its plugin data, made two and the
      // part refused; it took a designer's own plain component of the name
      // for one an earlier push built; and it overwrote another component's
      // id on a set of its name. It finds a set by name, by id only where
      // nothing has the name, and refuses a set of the name with another id.
      const { button, measured } = data();
      const push = (doc, extra = {}) => pushSet(build, doc, {
        page: "Forms", set: "Button", part: 25, variants: measured, properties: button.variantProperties, storyId: button.id, title: button.title, ...extra,
      });
      const doc = figmaDocument();
      const [first] = await push(doc);
      const original = await doc.call().getNodeByIdAsync(first.id);
      const copy = await besideSet(build, doc, "Forms", "Button copy", measured.slice(0, 2));
      copy.setSharedPluginData("storysync", "id", button.id);
      const [again] = await push(doc);
      assert(again.id === first.id && again.added === 0 && copy.children.length === 2, `a push beside a copy of the set returned ${JSON.stringify(again)}`);
      // Renamed, beside its copy: nothing has the name, and two have the id.
      original.name = "Buttons";
      const two = await refused(() => push(doc));
      assert(two && two.includes(`"Buttons" (${original.id}`) && two.includes(`"Button copy" (${copy.id}`) && /ask the user which/.test(two),
        `a push with two sets of its id and none of its name ${two ? `failed with: ${two}` : "was built"}`);

      const own = figmaDocument();
      const call = own.call();
      const page = call.createPage();
      page.name = "Forms";
      await call.setCurrentPageAsync(page);
      const designed = call.createComponent();
      designed.name = "Button";
      const [beside] = await push(own);
      assert(beside.added === measured.length && own.nodes("COMPONENT_SET").length === 1 && designed.parent === page && designed.name === "Button",
        `a push beside a designer's own Button component returned ${JSON.stringify(beside)}`);

      const other = figmaDocument();
      const taken = await leftSet(build, other, measured, { page: "Forms", set: "Button" });
      taken.setSharedPluginData("storysync", "id", "forms-iconbutton");
      const kept = await refused(() => push(other));
      assert(kept && kept.includes(taken.id) && kept.includes("forms-iconbutton") && /another component/.test(kept)
        && taken.getSharedPluginData("storysync", "id") === "forms-iconbutton",
        `a push onto a Button carrying another component's id ${kept ? `failed with: ${kept}` : "was built"}`);
      return "a copy left alone, a renamed set beside its copy refused, a designer's own Button left alone, another component's set refused";
    },

    async painted(build) {
      // A live push bound Attachment's error border, #df22254d, to the
      // destructive variable, and it read back #df2225: Figma sets a paint
      // freshly bound to opacity 1 when it is assigned. setPaints puts each
      // paint's opacity back, and leaves a shadow unbound where binding gave
      // it its variable's alpha, keeping one whose variable has its alpha.
      const { measured } = data();
      const doc = figmaDocument();
      const vars = {
        muted: doc.variable("muted", "#4b5563"), destructive: doc.variable("destructive", "#df2225"),
        black: doc.variable("black", "#000000"), shadow: doc.variable("shadow/sm", "#0000001a"),
      };
      const plain = measured[0].styles;
      const border = { width: 1, style: "solid", color: "#df22254d" };
      const layer = (offsetY) => ({ offsetX: 0, offsetY, blur: 2 * offsetY, spread: 0, color: "#0000001a", inset: false });
      const styles = {
        ...plain, backgroundColor: "#4b556322", width: plain.width + 2, height: plain.height + 2,
        border: { top: border, right: border, bottom: border, left: border }, borderUniform: border, boxShadow: [layer(1), layer(4)],
      };
      const styler = [
        "Object.assign(variant, look(variant.name, styles));",
        "setPaints(variant, 'fills', [{ ...variant.fills[0], variable: vars.muted }]);",
        "setPaints(variant, 'strokes', [{ ...variant.strokes[0], variable: vars.destructive }]);",
        "setPaints(variant, 'effects', [{ ...variant.effects[0], variable: vars.black }, { ...variant.effects[1], variable: vars.shadow }]);",
      ].join("\n      ");
      const properties = [{ name: "state", type: "VARIANT", values: ["error"], defaultValue: "error" }];
      const [result] = await pushSet(build, doc, {
        page: "Forms", set: "Attachment", part: 25, properties, variants: [{ name: "state=error", styles }], styler, scope: { vars },
      });
      const set = await doc.call().getNodeByIdAsync(result.id);
      const [variant] = set.children;
      const bound = (paint) => paint.boundVariables?.color?.id ?? null;
      assert(bound(variant.fills[0]) === vars.muted.id && bound(variant.strokes[0]) === vars.destructive.id,
        "setPaints left the fill or the stroke unbound");
      const slice = await loadSkillReadback().read(set, { "state=error": "state-error" }, { "state-error": "measured" });
      const read = slice.readback["state-error"];
      const got = `${read.backgroundColor} ${read.borderUniform?.color}`;
      assert(got === "#4b556322 #df22254d", `the bound fill and stroke read back ${got}, not #4b556322 #df22254d`);
      const [unbound, kept] = variant.effects;
      const alpha = (effect) => Math.round(effect.color.a * 255);
      assert(bound(unbound) === null && alpha(unbound) === 0x1a, `a shadow bound to an opaque black kept ${bound(unbound)} at alpha ${alpha(unbound)}`);
      assert(bound(kept) === vars.shadow.id && alpha(kept) === 0x1a, `a shadow bound to shadow/sm kept ${bound(kept)} at alpha ${alpha(kept)}`);
      return `fill ${read.backgroundColor} and stroke ${read.borderUniform.color} bound; a shadow left unbound where binding took its alpha, one kept bound`;
    },

    async fonts(build) {
      // snap records a CSS keyword such as system-ui, and Menlo for a
      // monospace stack on macOS, and Figma's plugin context loads neither.
      // loadFont loads the measured family where Figma has it, and otherwise
      // Inter, or Roboto Mono for a monospace face, at the measured weight in
      // whichever spelling the family uses, and the part names each stand-in.
      // A part whose own code throws part way leaves no variant it made loose
      // on the page, and the set as it was.
      const { measured } = data();
      const plain = measured[0].styles;
      const fonted = (fontFamily, fontWeight) => ({
        ...plain, fontFamily, fontWeight, text: { color: plain.text?.color ?? plain.color, fontSize: plain.fontSize, fontFamily, fontWeight },
      });
      const faces = {
        keyword: ["system-ui", 600], mono: ["Menlo", 400], named: ["Inter", 500], monoBold: ["ui-monospace", 600],
        spelled: ["Roboto Mono", 600], heavy: ["Roboto Mono", 800], serif: ["Georgia", 400], heaviest: ["Inter", 950],
      };
      const properties = [{ name: "font", type: "VARIANT", values: Object.keys(faces), defaultValue: "keyword" }];
      const variants = Object.entries(faces).map(([face, [family, weight]]) => ({ name: `font=${face}`, styles: fonted(family, weight) }));
      const styler = "Object.assign(variant, look(variant.name, styles));\n      variant.findOne((n) => n.type === 'TEXT').fontName = await loadFont(styles.text.fontFamily, styles.text.fontWeight);";
      const doc = figmaDocument();
      const [result] = await pushSet(build, doc, { page: "Forms", set: "Fonts", part: 25, properties, variants, styler });
      const want = {
        "system-ui 600": "Inter Semi Bold", "Menlo 400": "Roboto Mono Regular", "ui-monospace 600": "Roboto Mono SemiBold",
        "Roboto Mono 800": "Roboto Mono Bold", "Georgia 400": "Noto Serif Regular",
      };
      assert(JSON.stringify(result.fonts) === JSON.stringify(want), `the part named the stand-ins ${JSON.stringify(result.fonts)}`);
      const set = await doc.call().getNodeByIdAsync(result.id);
      const names = Object.fromEntries(variants.map((v) => [v.name, v.name]));
      const slice = await loadSkillReadback().read(set, names, Object.fromEntries(variants.map((v) => [v.name, "measured"])));
      const read = Object.values(slice.readback).map((e) => `${e.fontFamily} ${e.fontWeight}`).join(", ");
      assert(read === "Inter 600, Roboto Mono 400, Inter 500, Roboto Mono 600, Roboto Mono 600, Roboto Mono 700, Noto Serif 400, Inter 900", `read back ${read}`);

      // The agent's own code throws on one variant, after the part made it.
      const throwing = (on) => `if (variant.name === '${on}') throw new Error('applyStyles failed');\n      Object.assign(variant, look(variant.name, styles));`;
      const fresh = figmaDocument();
      const first = await refused(() => pushSet(build, fresh, { page: "Forms", set: "Fonts", part: 25, properties, variants, styler: throwing("font=named") }));
      assert(first === "applyStyles failed" && fresh.nodes("COMPONENT").length === 0 && fresh.nodes("COMPONENT_SET").length === 0,
        `a first part that failed ${first ? `with "${first}"` : "did not fail, and"} left ${fresh.nodes("COMPONENT").length} components`);
      const extra = { name: "font=late", styles: fonted("Georgia", 400) };
      const wider = [{ ...properties[0], values: [...properties[0].values, "late"] }];
      const later = await refused(() => pushSet(build, doc, { page: "Forms", set: "Fonts", part: 25, properties: wider, variants: [...variants, extra], styler: throwing(extra.name) }));
      assert(later === "applyStyles failed" && doc.nodes("COMPONENT").length === variants.length && set.children.length === variants.length,
        `a part that failed on a variant it added left ${doc.nodes("COMPONENT").length} components, ${set.children.length} in the set`);
      return `stand-ins ${Object.values(want).join(", ")}, named in the part's result, none for Roboto Mono's own SemiBold; a part that failed left nothing loose`;
    },
  };
}

// --- Simulated Figma for the audit -------------------------------------------

/** One use_figma call's figma, serving local variables. */
function variablesFigma(variables, modes = {}) {
  const collections = [];
  const byId = new Map();
  variables.forEach((v, i) => {
    let coll = collections.find((c) => c.name === v.collection);
    if (!coll) {
      // Its modes, by name, the first its default: one, "Default", unless `modes` gives the collection's.
      const names = modes[v.collection] ?? ["Default"];
      coll = { name: v.collection, modes: names.map((name) => ({ modeId: `${v.collection}:${name}`, name })), variableIds: [] };
      collections.push(coll);
    }
    const id = `VariableID:${i}`;
    coll.variableIds.push(id);
    byId.set(id, { name: v.name, resolvedType: v.type, valuesByMode: { [coll.modes[0].modeId]: v.value } });
  });
  return {
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getVariableByIdAsync: async (id) => byId.get(id) ?? null,
    },
  };
}

/**
 * One use_figma call's figma, serving pages of component sets, components and
 * frames. As in use_figma, a call starts on the first page with only it
 * loaded, a page loads when the call switches to it and becomes
 * figma.currentPage, and a search from figma.root sees only the loaded pages.
 * A search walks every node under the page, a set's variants included, as
 * Figma's does. `switches` records each switch.
 */
function pagesFigma(pages, switches = []) {
  const loaded = new Set([pages[0].id]);
  const nodes = pages.map((p) => {
    const page = {
      id: p.id,
      type: "PAGE",
      name: p.name,
      findAllWithCriteria: ({ types }) => (loaded.has(p.id) ? descendants(p.sets).filter((n) => types.includes(n.type)) : []),
    };
    for (const node of p.sets) node.parent = page;
    return page;
  });
  const figma = {
    root: {
      children: nodes,
      findAllWithCriteria: (criteria) => nodes.flatMap((n) => n.findAllWithCriteria(criteria)),
    },
    currentPage: nodes[0],
    getNodeByIdAsync: async (id) => nodes.find((n) => n.id === id) ?? null,
    setCurrentPageAsync: async (page) => {
      loaded.add(page.id);
      switches.push(page.id);
      figma.currentPage = nodes.find((n) => n.id === page.id);
    },
  };
  return figma;
}

/** Every node under `nodes`, each before its children, as a search walks them. */
function descendants(nodes) {
  return nodes.flatMap((n) => [n, ...descendants(n.children ?? [])]);
}

let auditNodeIds = 0;

/** A node's shared plugin data: the Storybook ID the push stored, or "" as Figma reads none. */
function auditNode(type, name, storybookId = "") {
  return {
    type,
    name,
    id: `9:${++auditNodeIds}`,
    children: [],
    getSharedPluginData: (namespace, key) => (namespace === "storysync" && key === "id" ? storybookId : ""),
  };
}

/**
 * A component set as the audit reads it: its properties, and a variant, a
 * component, per combination. `errored`, a set Figma flags as errored, as
 * one of a single variant named "" is: reading its properties throws.
 */
function auditSet(name, options, { storybookId = "", errored = false } = {}) {
  const defs = Object.fromEntries(Object.entries(options).map(([prop, values]) =>
    [prop, values === "BOOLEAN" ? { type: "BOOLEAN", defaultValue: false } : { type: "VARIANT", variantOptions: values }]));
  const count = Object.values(options).reduce((n, values) => n * (values === "BOOLEAN" ? 2 : values.length), 1);
  const set = auditNode("COMPONENT_SET", name, storybookId);
  Object.defineProperty(set, "componentPropertyDefinitions", {
    get() {
      if (errored) throw new Error("in get_componentPropertyDefinitions: Component set has existing errors");
      return defs;
    },
  });
  set.children = Array.from({ length: count }, (_, i) => Object.assign(auditNode("COMPONENT", `variant ${i}`), { parent: set }));
  return set;
}

/** A component outside any set, as the push makes one with no variant properties, or a designer's own. */
function auditComponent(name, { storybookId = "" } = {}) {
  return auditNode("COMPONENT", name, storybookId);
}

/** A frame holding other nodes, as a designer groups components in one. */
function auditFrame(name, children) {
  const frame = auditNode("FRAME", name);
  frame.children = children;
  for (const child of children) child.parent = frame;
  return frame;
}

/**
 * Runs an audit template the way the skill says to: START 0, then again from
 * each `next` until it is null. `figmaFor()` gives each call a fresh figma, as
 * use_figma does. Returns every slice.
 */
async function readAllSlices(code, figmaFor, values = {}) {
  const out = [];
  for (let start = 0; start !== null;) {
    const slice = JSON.parse(await new AsyncFunction("figma", withConstants(code, { ...values, START: start }))(figmaFor()));
    assert(slice.next === null || slice.next > start, `the slice from ${start} says to read next from ${slice.next}`);
    out.push(slice);
    start = slice.next;
  }
  return out;
}

// --- Readback checksums ---------------------------------------------------------
//
// On a live push the agent wrote figma-readback.json from snap's values plus
// the sizes that came off the Figma nodes, rather than from what the readback
// calls returned, and verify compared snap with snap for every property but
// size. The template now checksums each entry in Figma, over exactly what the
// call returns, and verify recomputes it.

/**
 * `value` as JSON laid out as no template writes it: tab-indented, every
 * object's keys in reverse, and every number in exponential notation, 38.59
 * as 3.859e+1. The same values, so the same checksums.
 */
function relaid(value, indent = "") {
  const inner = `${indent}\t`;
  if (Array.isArray(value)) {
    return value.length ? `[\n${value.map((v) => inner + relaid(v, inner)).join(",\n")}\n${indent}]` : "[]";
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).reverse();
    return keys.length ? `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${relaid(value[k], inner)}`).join(",\n")}\n${indent}}` : "{}";
  }
  return typeof value === "number" ? value.toExponential() : JSON.stringify(value);
}

/** What verify flagged, for a message. */
function describeIssues(issues) {
  return issues.length ? issues.slice(0, 3).map((i) => `${i.component} ${i.slug} (${i.problem})`).join(", ") + (issues.length > 3 ? ", …" : "") : "nothing";
}

/**
 * Throws unless verify flagged every entry of `file` with `problem` and
 * nothing else, scored none of it, failed --strict, and never printed "Figma
 * matches", on the readback written to `name`. Returns how many entries.
 */
function assertAllFlagged(snapDir, file, name, problem, label, { bin } = {}) {
  const path = join(WORK, name);
  writeJson(path, file);
  const v = verifyJson(snapDir, path, [], { bin });
  assert(v.json?.summary, `verify did not score ${label}\n${v.out.trim()}`);
  const entries = Object.values(file.components).reduce((n, c) => n + Object.keys(c.variants).length, 0);
  const issues = v.json.readbackIssues ?? [];
  const flagged = issues.filter((i) => i.problem === problem);
  const { summary } = v.json;
  assert(flagged.length === entries && issues.length === entries && summary.unverifiedReadback === summary.variants,
    `${label}: ${flagged.length} of ${entries} entries flagged ${problem}, ${issues.length} issues in all (${describeIssues(issues)}), ` +
    `${summary.unverifiedReadback} of ${summary.variants} variants unverified`);
  assert(summary.propertiesCompared === 0 && v.json.fidelity === null,
    `${label}: ${summary.propertiesMatched} of ${summary.propertiesCompared} properties scored as matching, fidelity ${v.json.fidelity}`);
  assert(exitOf(snapDir, path, ["--strict"], { bin }) === 1, `${label}: --strict passed`);
  const text = cli(["verify", "--snap", join(snapDir, "styles.json"), "--readback", path], { bin }).out;
  assert(!/Figma matches/.test(text), `${label}: verify said "Figma matches"`);
  return entries;
}

/**
 * Throws unless the readback the template returns, written into the file as
 * the skill says, verifies with no readback issue: every entry carrying the
 * time Figma read it and a checksum the template computed, complete and read
 * after the snap, and every variant scoring 100%, written as returned or laid
 * out another way. And the variants with nothing to report for a field: one
 * with no text child, whose text's four fields read null; one whose text
 * mixes fonts and sizes, whose size and font read null; one without auto
 * layout, whose gap reads null; and one Figma reports a mixed stroke weight
 * for, whose border's width drops out of what the call returns. Their
 * checksums have to cover what it returns, and verify has to accept them as
 * complete. `template` and `bin` are the readback template and the CLI, the
 * shipped ones unless mutants are given.
 */
async function assertSealed(snapDir, { template = loadSkillReadback(), bin } = {}) {
  const file = await buildReadback(snapDir, { readback: template });
  let entries = 0;
  for (const component of Object.values(file.components)) {
    for (const [slug, entry] of Object.entries(component.variants)) {
      assert(/^fnv1a:[0-9a-f]{8}$/.test(entry.checksum ?? ""), `${slug} came back with a checksum of ${JSON.stringify(entry.checksum)}`);
      assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.readAt ?? ""), `${slug} came back with a readAt of ${JSON.stringify(entry.readAt)}`);
      entries++;
    }
  }
  const asReturned = join(WORK, "readback-sealed.json");
  writeJson(asReturned, file);
  const laidOut = join(WORK, "readback-relaid.json");
  writeFileSync(laidOut, relaid(file));
  for (const [path, label] of [[asReturned, "the readback as returned"], [laidOut, "the readback laid out another way"]]) {
    const v = verifyJson(snapDir, path, [], { bin });
    assert(v.json?.summary, `verify did not score ${label}\n${v.out.trim()}`);
    const issues = v.json.readbackIssues ?? [];
    assert(issues.length === 0 && v.json.summary.unverifiedReadback === 0, `${label}: ${issues.length} entries flagged, ${describeIssues(issues)}`);
    assert(v.json.fidelity === 1 && v.json.summary.verified === v.json.summary.variants,
      `${label} scored ${v.json.fidelity}, ${v.json.summary.verified} of ${v.json.summary.variants} variants verified`);
  }

  const edges = Object.fromEntries(edgeVariants(snapDir).map((e) => [e.edge, e]));
  const textless = figmaNode("odd=textless", edges["transparent-border"].styles);
  textless.findOne = () => null;
  const mixed = figmaNode("odd=mixed", edges["bottom-border"].styles);
  assert(mixed.strokeWeight === MIXED, "the one-sided border's strokeWeight is not figma.mixed");
  const font = figmaNode("odd=font", edges["box-shadow"].styles);
  Object.assign(font.findOne(() => true), { fontSize: MIXED, fontName: MIXED });
  const flat = Object.assign(figmaNode("odd=flat", edges["box-shadow"].styles), { layoutMode: "NONE" });
  const { readback: odd } = await template.read(
    { id: "set:Odd", type: "COMPONENT_SET", name: "Odd", children: [textless, mixed, font, flat] },
    { "odd=textless": "odd-textless", "odd=mixed": "odd-mixed", "odd=font": "odd-font", "odd=flat": "odd-flat" },
    { "odd-textless": "measured", "odd-mixed": "measured", "odd-font": "measured", "odd-flat": "measured" },
  );
  const nulls = (entry, keys) => keys.every((key) => key in entry && entry[key] === null);
  assert(nulls(odd["odd-textless"], ["color", "fontSize", "fontWeight", "fontFamily"]) && !("width" in (odd["odd-mixed"].borderUniform ?? {}))
    && nulls(odd["odd-font"], ["fontSize", "fontWeight", "fontFamily"]) && nulls(odd["odd-flat"], ["gap"]),
    `a variant with no text read back ${JSON.stringify(odd["odd-textless"])}, one with a mixed stroke weight ` +
    `${JSON.stringify(odd["odd-mixed"])}, one with mixed fonts ${JSON.stringify(odd["odd-font"])}, one without auto layout ${JSON.stringify(odd["odd-flat"])}`);
  const oddPath = join(WORK, "readback-odd.json");
  writeJson(oddPath, { version: 1, fileKey: "acceptance", components: { "Forms/Odd": { nodeId: "set:Odd", variants: odd } } });
  const v = verifyJson(snapDir, oddPath, [], { bin });
  assert(v.json?.summary, `verify did not score the odd variants\n${v.out.trim()}`);
  assert((v.json.readbackIssues ?? []).length === 0,
    `a variant with no text, a mixed stroke weight, mixed fonts or no auto layout was flagged: ${describeIssues(v.json.readbackIssues)}`);
  return `${entries} entries, each with the template's readAt and checksum, 100% as returned and laid out with tabs, keys reversed and numbers ` +
    `like ${(38.59).toExponential()}; a variant with no text, one with a mixed stroke weight, one with mixed fonts and one without auto layout unflagged`;
}

/**
 * Throws unless a variant with no text child, whose text's four fields read
 * null, and a frame without auto layout, whose gap reads null, verify against
 * a snap that measured no text on the first and no gap on the second, a
 * block element like Frozen; while variants built the same way drift on
 * exactly those fields against a snap that measured text, or a gap, on them:
 * a label or an auto layout lost in Figma. `template` and `bin` are the
 * readback template and the CLI, the shipped ones unless mutants are given.
 */
async function assertNullsScored(snapDir, { template = loadSkillReadback(), bin } = {}) {
  const snap = readJson(join(snapDir, "styles.json"));
  const plain = expandVariants(snap.components.find((c) => c.name === "Button"))[0].styles;
  const block = expandVariants(snap.components.find((c) => c.name === "Frozen"))[0].styles;
  assert(plain.text && plain.gap?.column === 6 && block.gap === null && block.display === "block",
    `the Button measured text ${JSON.stringify(plain.text)} and a gap of ${JSON.stringify(plain.gap)}, Frozen a gap of ${JSON.stringify(block.gap)} on a ${block.display} element`);
  // Each variant as snap measured it, and as Figma has it.
  const cases = [
    { slug: "textless", styles: { ...plain, text: null }, figma: { text: false } },
    { slug: "flat", styles: block, figma: { layoutMode: "NONE" } },
    { slug: "unlabeled", styles: plain, figma: { text: false } },
    { slug: "ungapped", styles: plain, figma: { layoutMode: "NONE" } },
  ];
  const children = cases.map(({ slug, styles, figma }) => {
    const node = figmaNode(`nulls=${slug}`, styles);
    if (figma.text === false) node.findOne = () => null;
    if (figma.layoutMode) node.layoutMode = figma.layoutMode;
    return node;
  });
  const { readback: variants } = await template.read(
    { id: "set:Nulls", type: "COMPONENT_SET", name: "Nulls", children },
    Object.fromEntries(cases.map(({ slug }) => [`nulls=${slug}`, slug])),
    Object.fromEntries(cases.map(({ slug }) => [slug, "measured"])),
  );
  const dir = join(WORK, "snap-nulls");
  mkdirSync(dir, { recursive: true });
  cpSync(join(snapDir, "meta.json"), join(dir, "meta.json"));
  writeJson(join(dir, "styles.json"), {
    ...snap,
    components: [{
      name: "Nulls", title: "Forms/Nulls", category: "Forms", storyId: "forms-nulls--default",
      variantProperties: [{ name: "nulls", type: "VARIANT", values: cases.map((c) => c.slug), defaultValue: cases[0].slug }],
      base: { combination: { nulls: cases[0].slug }, slug: cases[0].slug, styles: cases[0].styles },
      variants: cases.map(({ slug, styles }) => ({ combination: { nulls: slug }, slug, status: "ok", delta: styles })),
      warnings: [], error: null,
    }],
  });
  const path = join(WORK, "readback-nulls.json");
  writeJson(path, { version: 1, fileKey: "acceptance", components: { "Forms/Nulls": { nodeId: "set:Nulls", variants } } });
  const v = verifyJson(dir, path, [], { bin });
  assert(v.json?.summary, `verify did not score the variants with null fields\n${v.out.trim()}`);
  assert((v.json.readbackIssues ?? []).length === 0, `a variant with null fields was flagged: ${describeIssues(v.json.readbackIssues)}`);
  const scored = v.json.variants.map((x) => `${x.slug} ${x.status} ${x.matched}/${x.matched + x.mismatched}` +
    (x.differences.length ? ` ${x.differences.map((d) => d.property).join("+")}` : "")).join(", ");
  const want = "textless verified 12/12, flat verified 10/10, " +
    "unlabeled drifted 8/12 color+fontSize+fontWeight+fontFamily, ungapped drifted 11/12 gap";
  assert(scored === want, `scored ${scored}, not ${want}`);
  return `no text and no text measured 12/12, no auto layout on a block element 10/10; ` +
    `a label lost in Figma drifts on its four text fields, an auto layout lost on its gap`;
}

/**
 * Throws unless a readback composed from snap's values, the live push's
 * shortcut, is flagged on every variant, scores nothing and fails --strict:
 * snap's values plus the sizes the template read off the Figma nodes, written
 * with no checksums, and again with the checksum Figma returned for each
 * variant carried over onto them. Without the checksum it would be snap
 * compared with snap, and score 100%.
 */
async function assertComposedFlagged(snapDir, { bin } = {}) {
  const faithful = await buildReadback(snapDir);
  const composed = referenceReadback(snapDir);
  const carried = referenceReadback(snapDir);
  let variants = 0;
  for (const [title, component] of Object.entries(composed.components)) {
    for (const [slug, entry] of Object.entries(component.variants)) {
      const figma = faithful.components[title]?.variants?.[slug];
      assert(figma, `the template read back no ${title} ${slug}`);
      Object.assign(entry, { width: figma.width, height: figma.height });
      Object.assign(carried.components[title].variants[slug], { width: figma.width, height: figma.height, checksum: figma.checksum });
      variants++;
    }
  }
  for (const [file, problem, label] of [
    [composed, "no_checksum", "with no checksums"],
    [carried, "checksum_mismatch", "with Figma's checksums carried over"],
  ]) {
    const path = join(WORK, `readback-composed-${problem}.json`);
    writeJson(path, file);
    const v = verifyJson(snapDir, path, [], { bin });
    assert(v.json?.summary, `verify did not score the readback composed ${label}\n${v.out.trim()}`);
    const { summary } = v.json;
    const flagged = (v.json.readbackIssues ?? []).filter((i) => i.problem === problem);
    assert(flagged.length === variants && summary.unverifiedReadback === summary.variants,
      `composed ${label}: ${flagged.length} of ${variants} entries flagged ${problem}, ${summary.unverifiedReadback} of ${summary.variants} variants unverified`);
    assert(summary.propertiesCompared === 0 && v.json.fidelity === null,
      `composed ${label}: ${summary.propertiesMatched} of ${summary.propertiesCompared} properties scored as matching, fidelity ${v.json.fidelity}`);
    assert(exitOf(snapDir, path, ["--strict"], { bin }) === 1, `composed ${label}: --strict passed`);
  }
  return `all ${variants} variants flagged, with no checksums and with Figma's carried over; nothing scored, --strict failed`;
}

/**
 * Throws unless one color edited in a readback the template returned is
 * flagged on exactly that variant, with nothing in it scored, every other
 * variant still verified, and --strict failed. The edit is the one that hides
 * drift: the variant's fill is magenta in Figma, read back as such, and the
 * file is then changed to the color snap measured.
 */
async function assertEditFlagged(snapDir, { bin } = {}) {
  const button = readJson(join(snapDir, "styles.json")).components.find((c) => c.name === "Button");
  const title = button.title ?? button.name;
  const slug = "variant-danger--size-sm--disabled-false";
  const measured = expandVariants(button).find((v) => v.slug === slug)?.styles.backgroundColor;
  assert(measured === "#dc2626", `the danger variant measured a fill of ${JSON.stringify(measured)}`);
  const file = await buildReadback(snapDir, {
    mutate(node, v, component) {
      if (component.name === "Button" && v.slug === slug) node.fills = [solidPaint("#ff00ff")];
    },
  });
  const entry = file.components[title].variants[slug];
  const before = join(WORK, "readback-magenta.json");
  writeJson(before, file);
  const drifted = verifyJson(snapDir, before, [], { bin }).json?.variants.find((x) => x.component === title && x.slug === slug);
  assert(drifted?.status === "drifted" && drifted.differences.map((d) => d.property).join() === "backgroundColor",
    `read back as Figma has it, the magenta variant was ${drifted?.status}`);

  entry.backgroundColor = measured;
  const path = join(WORK, "readback-recolored.json");
  writeJson(path, file);
  const v = verifyJson(snapDir, path, [], { bin });
  assert(v.json?.summary, `verify did not score the edited readback\n${v.out.trim()}`);
  const issues = v.json.readbackIssues ?? [];
  assert(issues.length === 1 && issues[0].component === title && issues[0].slug === slug && issues[0].problem === "checksum_mismatch",
    `flagged ${describeIssues(issues)}`);
  const verdict = v.json.variants.find((x) => x.component === title && x.slug === slug);
  assert(verdict?.status === "unverified_readback" && verdict.matched + verdict.mismatched === 0,
    `the edited variant was ${verdict?.status}, with ${verdict?.matched} properties matched and ${verdict?.mismatched} mismatched`);
  const others = v.json.variants.filter((x) => x !== verdict);
  const wrong = others.filter((x) => x.status !== "verified");
  assert(wrong.length === 0 && v.json.fidelity === 1, `the other variants: ${wrong.map((x) => `${x.slug} ${x.status}`).join(", ") || "verified"}, fidelity ${v.json.fidelity}`);
  assert(exitOf(snapDir, path, ["--strict"], { bin }) === 1, "--strict passed");
  return `the recolored ${slug} flagged and unscored, the other ${others.length} verified, --strict failed`;
}

/**
 * Two components with no variant props, Badge and Tag, measured alike, each
 * with the one slug snap gives them, `default`, read back from two sets by
 * the shipped template: Tag's fill is magenta in Figma, so read faithfully it
 * drifts, which this checks. Returns the snap's directory and the readback.
 */
async function proplessReadback(snapDir, { bin } = {}) {
  const button = readJson(join(snapDir, "styles.json")).components.find((c) => c.name === "Button");
  const styles = expandVariants(button)[0].styles;
  const propless = (name) => ({
    name, title: `Data/${name}`, category: "Data", storyId: `data-${name.toLowerCase()}--default`, variantProperties: [],
    base: { combination: {}, slug: "default", styles },
    variants: [{ combination: {}, slug: "default", status: "ok", delta: {} }], warnings: [], error: null,
  });
  const dir = join(WORK, "snap-propless");
  mkdirSync(dir, { recursive: true });
  cpSync(join(snapDir, "meta.json"), join(dir, "meta.json"));
  writeJson(join(dir, "styles.json"), { ...readJson(join(snapDir, "styles.json")), components: [propless("Badge"), propless("Tag")] });

  const template = loadSkillReadback();
  const components = {};
  for (const name of ["Badge", "Tag"]) {
    // Built as one plain component, its own one variant, named ''.
    const componentSet = { ...figmaNode(figmaVariantName({}), styles), id: `component:${name}`, type: "COMPONENT", name };
    if (name === "Tag") componentSet.fills = [solidPaint("#ff00ff")];
    const { variants } = await readSet(template, { componentSet, slugByName: { "": "default" }, sourceBySlug: { default: "measured" } }, READ_BATCH);
    components[`Data/${name}`] = { nodeId: componentSet.id, variants };
  }
  const file = { version: 1, fileKey: "acceptance", components };
  const faithful = join(WORK, "readback-propless.json");
  writeJson(faithful, file);
  const before = verifyJson(dir, faithful, [], { bin }).json;
  assert(before?.summary && (before.readbackIssues ?? []).length === 0
    && before.variants.map((x) => `${x.component} ${x.status}`).join() === "Data/Badge verified,Data/Tag drifted",
    `read faithfully: ${before?.variants?.map((x) => `${x.component} ${x.status}`).join(", ")}, ${describeIssues(before?.readbackIssues ?? [])} flagged`);
  return { dir, file };
}

/**
 * Throws unless an entry copied onto the same slug in another component is
 * flagged on exactly that one. Every component without variant props has the
 * slug `default`, so Tag's entry is replaced with Badge's, which matches the
 * snap: sealed under the slug alone, it would score 100%.
 */
async function assertCopyFlagged(snapDir, { bin } = {}) {
  const { dir, file } = await proplessReadback(snapDir, { bin });
  file.components["Data/Tag"].variants.default = { ...file.components["Data/Badge"].variants.default };
  const path = join(WORK, "readback-propless-copied.json");
  writeJson(path, file);
  const v = verifyJson(dir, path, [], { bin });
  assert(v.json?.summary, `verify did not score the copied readback\n${v.out.trim()}`);
  const issues = v.json.readbackIssues ?? [];
  assert(issues.length === 1 && issues[0].component === "Data/Tag" && issues[0].problem === "checksum_mismatch", `flagged ${describeIssues(issues)}`);
  const statuses = v.json.variants.map((x) => `${x.component} ${x.status}`).join();
  assert(statuses === "Data/Badge verified,Data/Tag unverified_readback", `after the copy: ${statuses}`);
  assert(exitOf(dir, path, ["--strict"], { bin }) === 1, "--strict passed");
  return "Badge's default entry copied onto Tag's flagged on Tag alone, which drifted when read faithfully; --strict failed";
}

/**
 * Throws unless a whole component's block copied onto another, its nodeId
 * with it, is flagged on every entry of both, scores nothing, fails --strict
 * and never prints "Figma matches". Tag's block is replaced with Badge's,
 * nodeId and all: every checksum in it matches under Badge's set's id, so the
 * checksum alone would score Tag 100%, though it drifted when read faithfully.
 */
async function assertBlockCopyFlagged(snapDir, { bin } = {}) {
  const { dir, file } = await proplessReadback(snapDir, { bin });
  file.components["Data/Tag"] = JSON.parse(JSON.stringify(file.components["Data/Badge"]));
  const entries = assertAllFlagged(dir, file, "readback-propless-block.json", "duplicate_node_id", "Badge's block copied onto Tag", { bin });
  const shared = verifyJson(dir, join(WORK, "readback-propless-block.json"), [], { bin }).json.readbackIssues
    .map((i) => `${i.component}: ${(i.sharedWith ?? []).join()}`).join("; ");
  assert(shared === "Data/Badge: Data/Tag; Data/Tag: Data/Badge", `the issues name the components sharing the nodeId as ${shared}`);
  return `Badge's whole block copied onto Tag's, nodeId and all: all ${entries} entries of both flagged, nothing scored, --strict failed, no "Figma matches"`;
}

/**
 * The readback template's code cut down to return `{ source, width, height }`,
 * every other field gone: still sealed, so each checksum matches what it
 * returns.
 */
function cutDown(code) {
  return code.replace(/(readback\[slug\] = seal\(componentSet\.id, slug, )\{[\s\S]*?\n\s*\}\);/,
    (_, call) => `${call}{ source: SOURCE_BY_SLUG[slug] || 'inferred', width: child.width + edge('Left') + edge('Right'), ` +
      "height: child.height + edge('Top') + edge('Bottom') });");
}

/** The readback template, cut down. */
function trimmedTemplate() {
  return loadSkillReadback(cutDown);
}

/**
 * Throws unless a readback read with the template cut down to `{ source,
 * width, height }` is flagged incomplete on every variant, scores nothing and
 * fails --strict. Its checksums all match: before verify required the
 * template's fields, it scored 100% on width and height alone, under every
 * strict flag.
 */
async function assertTrimmedFlagged(snapDir, { bin } = {}) {
  const file = await buildReadback(snapDir, { readback: trimmedTemplate() });
  for (const component of Object.values(file.components)) {
    for (const [slug, entry] of Object.entries(component.variants)) {
      const keys = Object.keys(entry).sort().join();
      assert(keys === "checksum,height,readAt,source,width", `the cut-down template returned ${keys} for ${slug}`);
    }
  }
  const entries = assertAllFlagged(snapDir, file, "readback-trimmed.json", "incomplete", "the cut-down readback", { bin });
  return `all ${entries} entries flagged incomplete with their checksums matching; nothing scored, --strict failed, no "Figma matches"`;
}

/**
 * The readback template's code with the text child's three fields and gap
 * removed from what it returns: still sealed, so each checksum matches. The
 * template used to leave these four out where Figma had none to report, and
 * verify let any entry leave them out, so this scored 100%.
 */
function withoutTypeOrGap(code) {
  let out = code;
  for (const field of [/\n *fontSize: [^\n]*/, /\n *fontWeight: [^\n]*/, /\n *fontFamily: [^\n]*/, /\n *gap: [^\n]*\n[^\n]*\n *: null,/]) {
    assert(field.test(out), `the readback template has no field matching ${field}`);
    out = out.replace(field, "");
  }
  return out;
}

/**
 * Throws unless a readback read with the template's text fields and gap
 * removed is flagged incomplete on every variant, lacking those four, scores
 * nothing and fails --strict.
 */
async function assertTypelessFlagged(snapDir, { bin } = {}) {
  const file = await buildReadback(snapDir, { readback: loadSkillReadback(withoutTypeOrGap) });
  const entries = assertAllFlagged(snapDir, file, "readback-typeless.json", "incomplete", "the readback without type or gap", { bin });
  const missing = new Set(verifyJson(snapDir, join(WORK, "readback-typeless.json"), [], { bin }).json.readbackIssues.map((i) => (i.missing ?? []).join()));
  assert(missing.size === 1 && missing.has("fontSize,fontWeight,fontFamily,gap"), `the entries lack ${[...missing].join(" or ")}`);
  return `all ${entries} entries flagged incomplete, lacking fontSize, fontWeight, fontFamily and gap, with their checksums matching; ` +
    `nothing scored, --strict failed, no "Figma matches"`;
}

/**
 * Throws unless a readback read an hour before the snap, one reused from an
 * earlier run, is flagged stale on every variant, scores nothing and fails
 * --strict; while one read two minutes before it, the clocks of Figma and
 * this machine disagreeing by that much, verifies at 100% under --strict.
 */
async function assertStaleFlagged(snapDir, { bin } = {}) {
  const measured = Date.parse(readJson(join(snapDir, "meta.json")).measuredAt);
  const template = loadSkillReadback();
  const old = await buildReadback(snapDir, { readback: readingAt(template, measured - 3_600_000) });
  const entries = assertAllFlagged(snapDir, old, "readback-earlier.json", "stale", "the readback from an hour before the snap", { bin });

  const skewed = await buildReadback(snapDir, { readback: readingAt(template, measured - 120_000) });
  const path = join(WORK, "readback-skewed.json");
  writeJson(path, skewed);
  const v = verifyJson(snapDir, path, [], { bin });
  assert(v.json?.summary && (v.json.readbackIssues ?? []).length === 0 && v.json.fidelity === 1,
    `read two minutes before the snap: ${describeIssues(v.json?.readbackIssues ?? [])} flagged, fidelity ${v.json?.fidelity}`);
  assert(exitOf(snapDir, path, ["--strict"], { bin }) === 0, "--strict failed on a readback two minutes before the snap");
  return `all ${entries} entries read an hour before the snap flagged stale, nothing scored, --strict failed; read two minutes before it, 100%`;
}

// --- The element-tree push -------------------------------------------------------

/** use_figma takes at most 50,000 characters a call; figma code packs build calls to this. */
const MAX_CALL_CHARS = 45000;

/**
 * The mock Figma the unit tests use (cli/__tests__/mock-figma.ts, built
 * beside the CLI): the Plugin API's pages, frames, auto layout, text, SVG
 * import, images and shared plugin data, with use_figma's limits on code,
 * response and page switches. What the element-tree push sends its calls to.
 */
async function mockFigma() {
  const mod = (path) => import(pathToFileURL(join(ROOT, "dist", "cli", ...path.split("/"))).href);
  const [M, T] = await Promise.all([mod("__tests__/mock-figma.js"), mod("tree-types.js")]);
  return { M, expandTree: T.expandTree };
}

/**
 * Pushes a tree snap the way the skill has the agent do it, into a mock
 * Figma: `figma code` writes the calls; each is sent unchanged, in seq
 * order, and its response saved unchanged where plan.json says; a build
 * that lists uploads gets an upload_assets response, and `figma upload`
 * posts the thumbnails to its URLs, served here; and a read whose result has
 * `more` is continued with `figma next`. Returns the plan and the mock, so a
 * check can change Figma and send the read calls again.
 */
async function treePush(snapPath, out, { tokens = null, mock: given = null } = {}) {
  const { M, expandTree } = await mockFigma();
  const r = cli(["figma", "code", "--snap", snapPath, "--out", out, "--json", ...(tokens ? ["--tokens", tokens] : [])]);
  assert(r.status === 0, `figma code exited ${r.status}\n${r.out.trim()}`);
  const { planPath, warnings } = JSON.parse(r.out.trim().split("\n").pop());
  const plan = readJson(planPath);
  const snap = readJson(snapPath);
  const trees = snap.components.flatMap((c) => c.variants.filter((v) => v.status === "ok").map((v) => expandTree(c.tree, v.treeDelta)));
  const mock = given ?? new M.MockFigma({ measure: M.measureFromTrees(trees), moveNeedsFonts: true });
  const send = async (file, result) => {
    const code = readFileSync(file, "utf8");
    assert(code.length <= MAX_CALL_CHARS, `${file} is ${code.length} characters, over ${MAX_CALL_CHARS}`);
    const run = await mock.run(code);
    assert(run.ok, `${file} failed in Figma: ${run.text}`);
    mkdirSync(dirname(result), { recursive: true });
    writeFileSync(result, run.text);
    return run;
  };
  const runs = [];
  for (const call of plan.calls) {
    const run = await send(join(out, call.file), join(out, call.result));
    runs.push({ call, run });
    const uploads = call.kind === "build" ? run.value.uploads ?? [] : [];
    if (uploads.length) await uploadAssets(mock, planPath, call, uploads);
    if (call.kind === "read") {
      for (;;) {
        const next = cli(["figma", "next", "--plan", planPath, "--seq", String(call.seq), "--json"]);
        assert(next.status === 0, `figma next exited ${next.status}\n${next.out.trim()}`);
        const more = JSON.parse(next.out.trim().split("\n").pop()).next;
        if (!more) break;
        runs.push({ call: { ...call, result: more.result }, run: await send(more.file, more.result) });
      }
    }
  }
  return { out, planPath, plan, mock, runs, warnings };
}

/**
 * upload_assets for a build's uploads, its response saved unchanged, and
 * `figma upload` run on it: each URL is served here, putting what is
 * posted to it on its layer in the mock, as Figma's upload does.
 */
async function uploadAssets(mock, planPath, call, uploads) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      mock.uploadAssets([decodeURIComponent(req.url.slice(1))], [new Uint8Array(Buffer.concat(chunks))]);
      res.writeHead(200).end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(join(dirname(planPath), call.result.replace(/\.json$/, ".upload.json")),
      JSON.stringify({ uploads: uploads.map(([nodeId]) => ({ submitUrl: `${base}/${encodeURIComponent(nodeId)}`, targetNodeId: nodeId })) }));
    const r = await cliAsync(["figma", "upload", "--plan", planPath, "--seq", String(call.seq)]);
    assert(r.status === 0, `figma upload exited ${r.status}\n${r.out.trim()}`);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

/** Sends a push's read calls again, saving each response over the last, as after a change in Figma. */
async function readTreeAgain(push) {
  for (const call of push.plan.calls.filter((c) => c.kind === "read")) {
    const run = await push.mock.run(readFileSync(join(push.out, call.file), "utf8"));
    assert(run.ok, `${call.file} failed in Figma: ${run.text}`);
    writeFileSync(join(push.out, call.result), run.text);
  }
}

/** verify --plan, as the skill runs it, with --json. */
function verifyPlan(planPath, flags = []) {
  const r = cli(["verify", "--plan", planPath, "--json", ...flags]);
  let json = null;
  try {
    json = JSON.parse(r.out.trim().split("\n").pop());
  } catch {
    // callers assert on status
  }
  return { status: r.status, json, out: r.out };
}

/** A variant's keyed layer in the mock, by the variant's slug and the layer's key. */
function treeLayer(mock, slug, key) {
  const variant = mock.nodes("COMPONENT").find((v) => v.data["storysync.slug"] === slug);
  assert(variant, `no variant ${slug} in Figma`);
  const walk = (view) => (view.data["storysync.k"] === key ? view : (view.children ?? []).map(walk).find(Boolean) ?? null);
  const found = (variant.children ?? []).map(walk).find(Boolean);
  assert(found, `no layer ${key} in ${slug}`);
  return found;
}

let mutantBuilds = 0;

/**
 * A copy of the built CLI with `mutate` applied to one of its modules,
 * verify.js unless `file` names another, beside a link to this checkout's
 * node_modules so it runs as the original does. With no `mutate`, an
 * unchanged copy: the control for the mutants, since a copy that cannot run
 * would make every one of them look caught.
 */
function mutantCli(mutate, file = "verify.js") {
  const dir = join(WORK, `build-${++mutantBuilds}`);
  cpSync(join(ROOT, "dist", "cli"), join(dir, "dist", "cli"), { recursive: true, filter: (src) => !src.includes("__tests__") });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  if (mutate) {
    const path = join(dir, "dist", "cli", file);
    const shipped = readFileSync(path, "utf8");
    const mutated = mutate(shipped);
    assert(mutated !== shipped, `the mutation no longer matches ${file}`);
    writeFileSync(path, mutated);
  }
  return join(dir, "dist", "cli", "index.js");
}

/** True when at least one of `runs` throws. */
async function fails(runs) {
  for (const run of runs) {
    try {
      await run();
    } catch {
      return true;
    }
  }
  return false;
}

// --- Checks --------------------------------------------------------------------

async function main() {
  console.log(`storysync acceptance\n  build:     ${CLI}\n  storybook: ${STORYBOOK}\n  workdir:   ${WORK}`);

  if (!existsSync(CLI)) {
    console.error(`\nNo build at ${CLI}. Run \`pnpm build\` first.`);
    process.exit(2);
  }
  try {
    const res = await fetch(`${STORYBOOK}/index.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`\nStorybook is not reachable at ${STORYBOOK} (${err.message}).`);
    console.error("Start the example first:  cd examples/storybook-vite && pnpm storybook");
    process.exit(2);
  }

  const pkg = readJson(join(ROOT, "package.json"));
  const snapDir = join(WORK, "snap");
  ({ readbackChecksum } = await import(pathToFileURL(join(ROOT, "dist", "cli", "verify.js")).href));

  heading("Build");

  await check("--version matches package.json", () => {
    const r = cli(["--version"]);
    assert(r.out.trim() === pkg.version, `--version printed ${r.out.trim()}, package.json says ${pkg.version}`);
    return pkg.version;
  });

  heading("Measurement");

  await check("snap measures every variant of the example", () => {
    // Root only: every check after this pushes through the skill's shipped
    // templates, which build and read back each variant's outer element. A
    // snap with element trees, scored against a readback of roots alone,
    // fails --strict, as design section 10.7 has it; the tree snap is
    // checked on its own below.
    const r = cli(["snap", "--storybook", STORYBOOK, "--out", snapDir, "--screenshots", "--variants", "all", "--root-only"]);
    assert(r.status === 0, `snap exited ${r.status}\n${r.out.trim()}`);
    const snap = readJson(join(snapDir, "styles.json"));
    const byName = Object.fromEntries(snap.components.map((c) => [c.name, c]));
    assert(byName.Button && byName.Frozen, `expected Button and Frozen, found ${Object.keys(byName).join(", ") || "none"}`);
    assert(snap.summary.rendered === snap.summary.variants && snap.summary.failed === 0,
      `rendered ${snap.summary.rendered}/${snap.summary.variants}, ${snap.summary.failed} failed`);
    return `${snap.summary.rendered}/${snap.summary.variants} variants across ${snap.summary.components} components`;
  });

  await check("snap measures each variant's element tree, the same twice, around the roots --root-only measures", () => {
    // Without --root-only, snap measures the elements under each root as
    // well (design section 6). The roots are the same measurement either way
    // (section 7.5): --root-only adds only how many elements it left out.
    const texts = ["tree", "tree-again"].map((name) => {
      const out = join(WORK, name);
      const r = cli(["snap", "--storybook", STORYBOOK, "--out", out, "--variants", "all"]);
      assert(r.status === 0, `snap exited ${r.status}\n${r.out.trim()}`);
      return readFileSync(join(out, "styles.json"), "utf8");
    });
    assert(texts[0] === texts[1], "two snaps of the same code measured different element trees");
    const tree = JSON.parse(texts[0]);
    const roots = readJson(join(snapDir, "styles.json"));
    assert(tree.treeVersion === 1 && roots.treeVersion === undefined, `treeVersion ${tree.treeVersion}, and ${roots.treeVersion} with --root-only`);
    const plain = ({ screenshot: _s, treeDelta: _t, innerElements: _i, ...rest }) => JSON.stringify(rest);
    let nodes = 0;
    for (const [i, component] of tree.components.entries()) {
      const root = roots.components[i];
      assert(component.name === root?.name, `component ${i}: ${component.name}, and ${root?.name} with --root-only`);
      assert(component.tree?.base?.length > 0 && root.tree === undefined, `${component.name}: ${component.tree?.base?.length ?? "no"} tree nodes, and ${root.tree ? "a tree" : "none"} with --root-only`);
      nodes += component.tree.base.length;
      assert(JSON.stringify(component.base) === JSON.stringify(root.base), `${component.name}: its base differs from --root-only's`);
      for (const [j, variant] of component.variants.entries()) {
        assert(Number.isInteger(root.variants[j].innerElements), `${component.name} ${variant.slug}: --root-only recorded no innerElements`);
        assert(plain(variant) === plain(root.variants[j]), `${component.name} ${variant.slug}: its root differs from --root-only's`);
      }
    }
    return `${tree.components.length} components, ${nodes} nodes in their base trees, byte-identical twice`;
  });

  await check("the push measures every Button combination, with the defaults as the base", () => {
    // Button declares 3 variants x 2 sizes x 2 disabled states. A Figma component
    // set needs all 12 to exist, or the variant picker has nothing to switch to.
    const snap = readJson(join(snapDir, "styles.json"));
    const button = snap.components.find((c) => c.name === "Button");
    assert(button.variants.length === 12, `measured ${button.variants.length} Button combinations, expected all 12`);
    assert(!button.cap, "Button reported as capped at 12 combinations");
    const base = button.base.combination;
    assert(base.variant === "primary" && base.size === "sm" && base.disabled === "false",
      `base is ${JSON.stringify(base)}, expected the default combination`);
    return "12/12, base primary/sm/enabled";
  });

  await check("a component over the combination limit is flagged and fails --strict", () => {
    const out = join(WORK, "capped");
    const r = cli(["snap", "--storybook", STORYBOOK, "--components", "Button", "--variants", "all",
      "--max-combinations", "4", "--out", out, "--strict"]);
    assert(r.status === 1, `--strict exited ${r.status} on a capped component`);
    const button = readJson(join(out, "styles.json")).components[0];
    assert(button.cap?.totalPossible === 12 && button.cap?.maxCombinations === 4, `cap: ${JSON.stringify(button.cap)}`);
    assert(/12 variant combinations, more than the limit of 4/.test(r.out), "no cap warning printed");
    // Four slots cannot cover every value of this Button, so the warning must
    // say what was left out instead of claiming coverage.
    assert(JSON.stringify(button.cap.uncovered) === JSON.stringify(["disabled=true"]), `uncovered: ${JSON.stringify(button.cap.uncovered)}`);
    assert(/leave out disabled=true/.test(r.out) && !/cover every value/.test(r.out), "warning claims coverage the subset lacks");
    return "12 over a limit of 4: warned, recorded, gap named, --strict failed";
  });

  await check("the example's stories take every value they're given, and snap records their argTypes", () => {
    // Its argTypes list every option, so nothing goes through the preview,
    // and the story's own argTypes are recorded as Storybook holds them.
    const snap = readJson(join(snapDir, "styles.json"));
    const button = snap.components.find((c) => c.name === "Button");
    const through = snap.components.flatMap((c) => c.variants.filter((v) => v.rejectedArgs || v.appliedVia).map((v) => `${c.name} ${v.slug}`));
    assert(through.length === 0, `variants the story didn't take: ${through.join(", ")}`);
    // A real Storybook's preview can be read for every variant.
    const unchecked = snap.components.flatMap((c) => c.variants.filter((v) => v.argsChecked === false).map((v) => `${c.name} ${v.slug}`));
    assert(unchecked.length === 0, `variants whose args snap couldn't check: ${unchecked.join(", ")}`);
    assert(!snap.components.some((c) => c.warnings.some((w) => /story URL|Storybook's preview/.test(w))), "an args warning on the example");
    assert(JSON.stringify(button.argTypes?.variant) === JSON.stringify({ type: "enum", control: "select", options: ["primary", "danger", "outline"] }),
      `Button's variant argType: ${JSON.stringify(button.argTypes)}`);
    assert(button.storyFile === "./src/Button.stories.tsx", `story file: ${button.storyFile}`);
    return `argTypes ${Object.keys(button.argTypes).join(", ")}, none rejected`;
  });

  await check("a value the story's argTypes reject is measured through Storybook's preview, as the component renders it", async () => {
    // Storybook drops a URL value its argTypes options don't list, and hides
    // an arg whose argTypes `if` fails, rendering the default instead: snap
    // measured that under the variant's name, as it did for shadcn/ui's
    // Badge ghost and link, and Figma got 36 variants that looked like the
    // default. Served here with outline left out of the options and size
    // hidden for it, every Button variant must still measure as the
    // unchanged story renders it. Each page load fetches the story's module,
    // so every copy served is counted, and any without both edits.
    let served = 0;
    let unedited = 0;
    const storybook = await rewritingStorybook("/src/Button.stories.tsx", (code) => {
      let edits = 0;
      const changed = code
        .replace(/options:\s*\[\s*"primary",\s*"danger",\s*"outline"\s*\]/, () => { edits++; return 'options: ["primary", "danger"]'; })
        .replace(/options:\s*\[\s*"sm",\s*"lg"\s*\]/, () => { edits++; return 'options: ["sm", "lg"], if: { arg: "variant", neq: "outline" }'; });
      served++;
      if (edits !== 2) unedited++;
      return changed;
    });
    const out = join(WORK, "rejected");
    let r;
    try {
      r = await cliAsync(["snap", "--storybook", storybook.url, "--components", "Button", "--variants", "all", "--out", out, "--strict"]);
    } finally {
      await storybook.close();
    }
    assert(served > 0 && unedited === 0, `${unedited} of ${served} copies of the story served without both argTypes changed: Vite compiled ${EXAMPLE_STORIES} differently, so update this check`);
    assert(r.status === 0, `snap --strict exited ${r.status}\n${r.out.trim()}`);
    const button = readJson(join(out, "styles.json")).components[0];

    // The true component: all 12 variants measure as the unchanged story renders them.
    assert(expandVariants(button).length === 12, `measured ${expandVariants(button).length} of 12 Button variants`);
    const truth = Object.fromEntries(expandVariants(readJson(join(snapDir, "styles.json")).components.find((c) => c.name === "Button")).map((v) => [v.slug, v.styles]));
    for (const { slug, styles } of expandVariants(button)) {
      assert(JSON.stringify(styles) === JSON.stringify(truth[slug]),
        `${slug} measured ${JSON.stringify(styles)}\n      unchanged story: ${JSON.stringify(truth[slug])}`);
    }
    const outline = Object.fromEntries(expandVariants(button).map((v) => [v.slug, v.styles]))["variant-outline--size-lg--disabled-false"];
    assert(outline?.backgroundColor === null && outline.fontSize === 18, `outline/lg: ${JSON.stringify(outline)}`);
    assert(JSON.stringify(button.argTypes?.size) === JSON.stringify({ type: "enum", control: "select", options: ["sm", "lg"], if: { arg: "variant", neq: "outline" } }),
      `the rewritten story wasn't served: size is ${JSON.stringify(button.argTypes?.size)}`);

    // Through the preview: the outline variants, each for both reasons.
    const through = button.variants.filter((v) => v.appliedVia === "preview");
    assert(through.length === 4 && through.every((v) => v.combination.variant === "outline" && v.status === "ok"),
      `applied through the preview: ${through.map((v) => `${v.slug} ${v.status}`).join(", ") || "none"}`);
    const reasons = (v) => v.rejectedArgs.map((a) => `${a.name}=${a.value}:${a.reasons.join("+")}`).join(" ");
    for (const v of through) {
      const want = `variant=outline:not-in-options size=${v.combination.size}:hidden-by-if`;
      assert(reasons(v) === want, `${v.slug} rejected ${reasons(v)}, expected ${want}`);
    }
    assert(button.variants.every((v) => v.appliedVia || !v.rejectedArgs), "a variant rejected but not applied");

    // And the story change that would let the URL take them.
    assert(/add 'outline' to argTypes\.variant\.options in \.\/src\/Button\.stories\.tsx/.test(r.out) &&
      /remove `if: \{"arg":"variant","neq":"outline"\}` from argTypes\.size in \.\/src\/Button\.stories\.tsx/.test(r.out),
      `no warning with the story change:\n${r.out.trim()}`);
    return "4 outline variants through the preview, all 12 as the unchanged story measures";
  });

  await check("with --no-channel-args, a value the story's argTypes reject is left unmeasured, as arg_rejected, and fails --strict", async () => {
    // The same story change as above, with the preview route turned off:
    // nothing may be measured under a name the render didn't take.
    const storybook = await rewritingStorybook("/src/Button.stories.tsx", (code) =>
      code.replace(/options:\s*\[\s*"primary",\s*"danger",\s*"outline"\s*\]/, 'options: ["primary", "danger"]'));
    const out = join(WORK, "no-channel");
    let r;
    try {
      r = await cliAsync(["snap", "--storybook", storybook.url, "--components", "Button", "--variants", "all", "--out", out, "--strict", "--no-channel-args"]);
    } finally {
      await storybook.close();
    }
    assert(r.status === 1, `snap --strict --no-channel-args exited ${r.status}\n${r.out.trim()}`);
    const button = readJson(join(out, "styles.json")).components[0];
    const rejected = button.variants.filter((v) => v.status === "arg_rejected");
    assert(rejected.length === 4 && rejected.every((v) => v.combination.variant === "outline" && !v.appliedVia && !v.delta && !v.treeDelta),
      `arg_rejected: ${rejected.map((v) => v.slug).join(", ") || "none"}`);
    assert(button.variants.filter((v) => v.status === "ok").length === 8, "the other variants weren't measured");
    return "4 outline variants arg_rejected, 8 measured, --strict failed";
  });

  await check("--stories measures a component from the story it names, and refuses a story that isn't the component's", () => {
    const out = join(WORK, "stories");
    const r = cli(["snap", "--storybook", STORYBOOK, "--components", "Button", "--out", out, "--stories", "Forms/Button=forms-button--default"]);
    assert(r.status === 0, `snap --stories exited ${r.status}\n${r.out.trim()}`);
    const button = readJson(join(out, "styles.json")).components[0];
    assert(button.storyId === "forms-button--default", `storyId ${button.storyId}`);
    const refused = cli(["snap", "--storybook", STORYBOOK, "--components", "Button", "--out", join(WORK, "stories-refused"), "--stories", "forms-button=forms-frozen--default"]);
    assert(refused.status === 1 && /--stories gives forms-button the story "forms-frozen--default", which isn't one of its stories: forms-button--default/.test(refused.out),
      `a story of another component was taken:\n${refused.out.trim()}`);
    assert(!existsSync(join(WORK, "stories-refused", "styles.json")), "the refused run wrote a snap");
    return "measured from forms-button--default; Frozen's story refused";
  });

  await check("snapshots are stamped with the running version", () => {
    const styles = readJson(join(snapDir, "styles.json")).storysyncVersion;
    const meta = readJson(join(snapDir, "meta.json")).storysyncVersion;
    assert(styles === pkg.version && meta === pkg.version,
      `styles.json says ${styles}, meta.json says ${meta}, package.json says ${pkg.version}`);
  });

  await check("measured values match the literals in Button.tsx", () => {
    const source = readFileSync(EXAMPLE_BUTTON, "utf8");
    const button = readJson(join(snapDir, "styles.json")).components.find((c) => c.name === "Button");
    const bySlug = Object.fromEntries(expandVariants(button).map((v) => [v.slug, v.styles]));
    const find = (predicate, label) => {
      const hit = Object.entries(bySlug).find(([slug]) => predicate(slug));
      assert(hit, `no measured variant for ${label}`);
      return hit[1];
    };
    const expectations = [
      [find((s) => s.includes("primary") && s.includes("sm") && s.includes("false"), "primary/sm"),
        { backgroundColor: "#2563eb", fontSize: 12, borderRadiusUniform: 3 }],
      [find((s) => s.includes("danger"), "danger"), { backgroundColor: "#dc2626" }],
      [find((s) => s.includes("outline"), "outline"), { backgroundColor: null }],
      [find((s) => s.includes("lg"), "lg"), { fontSize: 18, borderRadiusUniform: 9 }],
      [find((s) => s.includes("disabled-true"), "disabled"), { opacity: 0.4 }],
    ];
    for (const [styles, want] of expectations) {
      for (const [key, value] of Object.entries(want)) {
        assert(styles[key] === value, `${key}: measured ${JSON.stringify(styles[key])}, expected ${JSON.stringify(value)}`);
      }
    }
    for (const literal of ["#2563eb", "#dc2626", "#9ca3af"]) {
      assert(source.includes(literal), `${literal} is not in Button.tsx — the example changed; update these expectations`);
    }
    const outline = find((s) => s.includes("outline"), "outline");
    assert(outline.borderUniform?.width === 2 && outline.borderUniform?.color === "#9ca3af",
      `outline border measured ${JSON.stringify(outline.borderUniform)}`);
    return "fill, border, type, radius and opacity all exact";
  });

  await check("colors written in oklch, oklab, lab, lch, color() and hwb measure to the sRGB hex Chromium paints", async () => {
    // Chromium reports a computed color in the space it was written in, and
    // Tailwind v4 writes its palette in oklch, so a converter that only read
    // rgb() measured every such fill, text, border and shadow as nothing at
    // all. The example's Button is written in hex, so this renders its own
    // page through snap's capture and normalization, in the browser snap
    // launches. Each color is set on fill, text, all four borders and a
    // shadow, and each must come back as the hex given: CSS Color 4's
    // conversion, clipped to sRGB, which is also the pixel Chromium paints
    // for it on an sRGB canvas, checked here too.
    const { resolveAndLaunch, createContext, captureStory } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-browser.js")).href);
    const { normalizeStyles } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-normalize.js")).href);
    const swatches = [
      // Tailwind v4 red-500 and red-600, the second outside sRGB.
      { css: "oklch(63.7% 0.237 25.331)", hex: "#fb2c36", computed: /^oklch\(/ },
      { css: "oklch(57.7% 0.245 27.325)", hex: "#e7000b", computed: /^oklch\(/ },
      // bg-red-500/50 as Tailwind v4 writes it.
      { css: "color-mix(in oklab, oklch(63.7% 0.237 25.331) 50%, transparent)", hex: "#fb2c3680", computed: /^oklab\(/ },
      { css: "color-mix(in srgb, red 50%, transparent)", hex: "#ff000080", computed: /^color\(srgb / },
      { css: "lab(50% 40 59.5)", hex: "#bf5700", computed: /^lab\(/ },
      { css: "lch(50% 72 56)", hex: "#bf5700", computed: /^lch\(/ },
      { css: "oklab(0.6 0.1 -0.1)", hex: "#9f63ba", computed: /^oklab\(/ },
      { css: "color(display-p3 0.5 0.4 0.3)", hex: "#846549", computed: /^color\(display-p3 / },
      // Outside sRGB, so clipped.
      { css: "color(display-p3 1 0 0)", hex: "#ff0000", computed: /^color\(display-p3 / },
      { css: "color(rec2020 0.5 0.2 0.8)", hex: "#a02cdb", computed: /^color\(rec2020 / },
      { css: "hwb(120 20% 30%)", hex: "#33b333", computed: /^rgb\(/ },
    ];
    const page = join(WORK, "colors.html");
    writeFileSync(page, `<!doctype html><html><body><div id="root">${swatches.map((s, i) =>
      `<div id="swatch-${i}" style="display: inline-block; padding: 4px; background-color: ${s.css}; color: ${s.css}; ` +
      `border: 2px solid ${s.css}; box-shadow: 0 1px 2px ${s.css};">Aa</div>`).join("")}</div>` +
      `<canvas id="paint" width="1" height="1"></canvas></body></html>`);

    const { browser } = await resolveAndLaunch();
    try {
      const tab = await (await createContext(browser)).newPage();
      for (const [i, swatch] of swatches.entries()) {
        const capture = await captureStory(tab, pathToFileURL(page).href, { timeoutMs: 10000, selector: `#swatch-${i}`, screenshot: false });
        assert(capture.status === "ok", `${swatch.css}: capture ${capture.status} ${capture.error ?? ""}`);
        const computed = capture.raw["background-color"];
        assert(swatch.computed.test(computed),
          `${swatch.css}: Chromium computed ${computed}, not the form this check is for; the browser changed, so update it`);
        const styles = normalizeStyles(capture.raw, capture.boundingBox, capture.textRaw, capture.fontAvailable);
        const measured = {
          backgroundColor: styles.backgroundColor,
          color: styles.text?.color,
          border: styles.borderUniform?.color,
          shadow: styles.boxShadow[0]?.color,
        };
        for (const [key, value] of Object.entries(measured)) {
          assert(value === swatch.hex, `${swatch.css} (computed ${computed}): ${key} measured ${JSON.stringify(value)}, expected ${swatch.hex}`);
        }
        // What Chromium paints, within one step for its own float rounding.
        if (swatch.hex.length === 7) {
          const painted = await tab.evaluate((css) => {
            const ctx = document.getElementById("paint").getContext("2d", { colorSpace: "srgb" });
            ctx.fillStyle = css;
            ctx.fillRect(0, 0, 1, 1);
            return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
          }, swatch.css);
          const want = [1, 3, 5].map((at) => parseInt(swatch.hex.slice(at, at + 2), 16));
          assert(painted.every((v, c) => Math.abs(v - want[c]) <= 1),
            `${swatch.css}: Chromium paints rgb(${painted.join(", ")}), snap measured ${swatch.hex}`);
        }
      }
    } finally {
      await browser.close();
    }
    return `${swatches.length} colors, fill, text, border and shadow each`;
  });

  /**
   * Renders each case on a page of its own through snap's capture and
   * normalization, in the browser snap launches, and hands back the styles.
   * A case with an id is measured by selector; one without is measured as a
   * story is, from #storybook-root down past any wrappers.
   */
  async function measureCases(name, cases) {
    const { resolveAndLaunch, createContext, captureStory } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-browser.js")).href);
    const { normalizeStyles } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-normalize.js")).href);
    const { browser } = await resolveAndLaunch();
    try {
      const tab = await (await createContext(browser)).newPage();
      const measured = [];
      for (const [i, { html, selector }] of cases.entries()) {
        const page = join(WORK, `${name}-${i}.html`);
        writeFileSync(page, `<!doctype html><html><body><div id="storybook-root">${html}</div></body></html>`);
        const capture = await captureStory(tab, pathToFileURL(page).href, { timeoutMs: 10000, selector, screenshot: false });
        assert(capture.status === "ok", `${html}: capture ${capture.status} ${capture.error ?? ""}`);
        measured.push({ raw: capture.raw, styles: normalizeStyles(capture.raw, capture.boundingBox, capture.textRaw, capture.fontAvailable) });
      }
      return measured;
    } finally {
      await browser.close();
    }
  }

  await check("corner radii measure as the browser draws them: rounded-full, percentages, calc() and elliptical corners", async () => {
    // Chromium computes a radius rather than drawing it: Tailwind v4's
    // rounded-full as 3.35544e+07px, a percentage as written, calc() and min()
    // as themselves, an elliptical corner as two values. Each of these used to
    // measure 0, a square that verify then scored a match.
    const cases = [
      { css: "display: inline-flex; padding: 6px 12px; font: 14px/20px Arial; border-radius: calc(infinity * 1px)", text: "Save", radius: 16, computed: /e\+0?7px$/ },
      { css: "display: block; width: 8px; height: 8px; border-radius: calc(infinity * 1px)", radius: 4, computed: /e\+0?7px$/ },
      { css: "display: block; width: 8px; height: 8px; border-radius: 50%", radius: 4, computed: /^50%$/ },
      { css: "display: block; width: 32px; height: 32px; border-radius: 100%", radius: 16, computed: /^100%$/ },
      { css: "display: block; width: 32px; height: 32px; border-radius: calc(50% - 2px)", radius: 14 },
      // Resolved in the page, to layout's 1/64px: a size that lands on one.
      { css: "display: block; width: 40px; height: 30px; border-radius: min(8px, 10%)", radius: 3 },
      { css: "display: block; width: 64px; height: 48px; border-radius: 10px / 20px", radius: 10, computed: /^10px 20px$/ },
      { css: "display: inline-block; padding: 6px 12px; font: 14px/20px Arial; border-radius: 9999px", text: "Pill", radius: 16, computed: /^9999px$/ },
      { css: "display: block; width: 32px; height: 32px; border-radius: 3px", radius: 3, computed: /^3px$/ },
    ];
    const measured = await measureCases("radii", cases.map((c, i) =>
      ({ html: `<div id="r${i}" style="background: #2563eb; ${c.css}">${c.text ?? ""}</div>`, selector: `#r${i}` })));
    for (const [i, c] of cases.entries()) {
      const { raw, styles } = measured[i];
      const computed = raw["border-top-left-radius"];
      if (c.computed) {
        assert(c.computed.test(computed), `${c.css}: Chromium computed ${computed}, not the form this check is for; the browser changed, so update it`);
      }
      assert(styles.borderRadiusUniform === c.radius,
        `${c.css} (computed ${computed}, box ${styles.width}x${styles.height}): measured ${JSON.stringify(styles.borderRadiusUniform)}, expected ${c.radius}`);
    }
    return `${cases.length} radii`;
  });

  await check("a gradient fill, a background clip, a label's transform, opacity and tracking, and Tailwind's empty shadow slots measure as drawn", async () => {
    const empty = "0 0 #0000";
    const cases = [
      // A gradient has no background-color: recorded as no fill, it was built unfilled.
      { html: `<button id="c0" style="display: inline-flex; border: 0; color: #fff; background: linear-gradient(90deg, #2563eb, #7c3aed)">Go</button>`,
        want: (s) => s.backgroundColor === null && s.backgroundImage === "linear-gradient(90deg, #2563eb, #7c3aed)" },
      // Tailwind v4's gradient stops are oklch, written as hex like every color.
      { html: `<button id="c1" style="display: inline-flex; border: 0; background-image: linear-gradient(to right in oklab, oklch(54.6% 0.245 262.881) 0%, oklch(54.1% 0.281 293.009) 100%)">Go</button>`,
        want: (s) => s.backgroundImage === "linear-gradient(to right, #155dfc 0%, #7f22fe 100%)" },
      // A fill under a gradient is kept, as the layer beneath.
      { html: `<button id="c2" style="display: inline-flex; border: 0; background-color: #2563eb; background-image: linear-gradient(90deg, #f97316, #db2777)">Go</button>`,
        want: (s) => s.backgroundColor === "#2563eb" && s.backgroundImage === "linear-gradient(90deg, #f97316, #db2777)" },
      { html: `<span id="c3" style="display: inline-flex; padding: 2px 8px; font: 600 12px Arial; text-transform: uppercase">Beta</span>`,
        want: (s) => s.text?.textTransform === "uppercase" },
      { html: `<button id="c4" style="border: 0; background: #111827; color: #fff"><span style="opacity: 0.6">Draft</span></button>`,
        want: (s) => s.text?.color === "#ffffff99" && s.opacity === 1 },
      { html: `<button id="c5" style="border: 0; font-size: 20px"><span style="letter-spacing: 0.05em">Draft</span></button>`,
        want: (s) => s.text?.letterSpacing === 1 && s.letterSpacing === 0 },
      { html: `<span id="c6" style="display: inline-block; font: 20px Arial; letter-spacing: 10%">Draft</span>`,
        want: (s) => s.letterSpacing === 2 && s.text?.letterSpacing === 2 },
      // Tailwind v4's shadow-sm: four empty slots, then its two layers.
      { html: `<div id="c7" style="width: 20px; height: 20px; box-shadow: ${empty}, ${empty}, ${empty}, ${empty}, 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"></div>`,
        want: (s) => JSON.stringify(s.boxShadow) === JSON.stringify([
          { offsetX: 0, offsetY: 1, blur: 3, spread: 0, color: "#0000001a", inset: false },
          { offsetX: 0, offsetY: 1, blur: 2, spread: -1, color: "#0000001a", inset: false },
        ]) },
      // shadcn/ui's Button clips its fill to the padding box (bg-clip-padding),
      // so it stops at the transparent border; its Badge doesn't, and the
      // fill runs under the border. The build draws the two apart.
      { html: `<button id="c8" style="display: inline-flex; border: 1px solid transparent; background: #2563eb; background-clip: padding-box">Go</button>`,
        want: (s) => s.backgroundClip === "padding-box" && s.borderUniform?.color === null },
      { html: `<span id="c9" style="display: inline-flex; border: 1px solid transparent; background: #2563eb">Go</span>`,
        want: (s) => !("backgroundClip" in s) && s.borderUniform?.color === null },
    ];
    const measured = await measureCases("drawn", cases.map((c, i) => ({ html: c.html, selector: `#c${i}` })));
    for (const [i, c] of cases.entries()) {
      const { styles } = measured[i];
      const shown = { backgroundColor: styles.backgroundColor, backgroundImage: styles.backgroundImage, backgroundClip: styles.backgroundClip, opacity: styles.opacity,
        letterSpacing: styles.letterSpacing, text: styles.text, boxShadow: styles.boxShadow };
      assert(c.want(styles), `${c.html}\n  measured ${JSON.stringify(shown)}`);
    }
    return `${cases.length} cases`;
  });

  await check("a wrapper whose background is transparent in oklab is looked past, and one drawing a gradient is not", async () => {
    const button = `<button style="display: inline-flex; border: 0; padding: 4px 8px; background: #2563eb; color: #fff">In</button>`;
    // Tailwind v4's bg-black/0, a color-mix in oklab.
    const clear = `<div id="clear" style="display: block; background-color: color-mix(in oklab, black 0%, transparent)">${button}</div>`;
    const [oklab, rgba, gradient, wrapper] = await measureCases("wrappers", [
      { html: clear },
      { html: `<div style="display: block">${button}</div>` },
      { html: `<div style="display: block; border-radius: 8px; background-image: linear-gradient(90deg, #2563eb, #7c3aed)"><div style="padding: 8px">Banner</div></div>` },
      { html: clear, selector: "#clear" },
    ]);
    assert(/^oklab\(.*\/ 0\)$/.test(wrapper.raw["background-color"]),
      `the wrapper's background computed to ${wrapper.raw["background-color"]}, not the oklab form this check is for; the browser changed, so update it`);
    for (const [label, { styles }] of [["oklab", oklab], ["rgba", rgba]]) {
      assert(styles.backgroundColor === "#2563eb" && styles.display === "inline-flex",
        `${label} wrapper: measured ${styles.display} with fill ${styles.backgroundColor}, not the button inside it`);
    }
    assert(gradient.styles.backgroundImage === "linear-gradient(90deg, #2563eb, #7c3aed)" && gradient.styles.borderRadiusUniform === 8,
      `gradient wrapper: measured ${JSON.stringify({ backgroundImage: gradient.styles.backgroundImage, radius: gradient.styles.borderRadiusUniform })}, not the banner`);
    return "the button inside both transparent wrappers, the gradient banner itself";
  });

  /**
   * Serves each page by name, as Storybook's iframe would serve a story,
   * and measures it through snap's capture as the component named, in the
   * browser snap launches. `/slow.png` answers after `slowImageMs`.
   */
  async function captureStories(pages, { slowImageMs = 0 } = {}) {
    const { createServer } = await import("node:http");
    const { resolveAndLaunch, createContext, captureStory } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-browser.js")).href);
    const { normalizeStyles } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-normalize.js")).href);
    // A 1x1 PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const server = createServer((req, res) => {
      const name = decodeURIComponent(req.url.slice(1));
      if (name === "slow.png") {
        setTimeout(() => res.writeHead(200, { "content-type": "image/png" }).end(png), slowImageMs);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head></head><body>${pages[name]?.html ?? ""}</body></html>`);
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const { browser } = await resolveAndLaunch();
    try {
      const tab = await (await createContext(browser)).newPage();
      const measured = {};
      for (const [name, { component, timeoutMs = 10000 }] of Object.entries(pages)) {
        const started = Date.now();
        const capture = await captureStory(tab, `http://127.0.0.1:${server.address().port}/${name}`, { timeoutMs, screenshot: false, component: { name: component } });
        const styles = capture.status === "ok" ? normalizeStyles(capture.raw, capture.boundingBox, capture.textRaw, capture.fontAvailable, capture.fonts, capture.textLayout) : null;
        measured[name] = { ...capture, styles, ms: Date.now() - started };
      }
      return measured;
    } finally {
      await browser.close();
      server.close();
    }
  }

  await check("snap measures the component, not a <noscript>, a story's layout row or an overlay's closed trigger", async () => {
    // Rendered as shadcn/ui renders them: input-otp puts a <noscript> first
    // and its data-slot on a transparent <input> over the boxes it draws, a
    // Switch story wraps the switch and its label in a flex row, and a
    // Dialog's content renders into a portal only while it is open.
    const filled = "background: #e5e5e5; border: 1px solid #d4d4d4";
    const m = await captureStories({
      otp: { component: "InputOTP", html: `<div id="storybook-root"><noscript><style>.x{}</style></noscript><div style="display: flex; position: relative"><div style="display: flex"><div style="width: 36px; height: 36px; ${filled}"></div><div style="width: 36px; height: 36px; ${filled}"></div></div><div style="position: absolute; inset: 0"><input data-slot="input-otp" style="position: absolute; inset: 0; width: 100%; background: transparent; border: 0"></div></div></div>` },
      switch: { component: "Switch", html: `<div id="storybook-root"><div style="display: flex; gap: 8px; align-items: center"><button data-slot="switch" style="width: 32px; height: 18px; padding: 0; ${filled}"></button><label>Airplane Mode</label></div></div>` },
      row: { component: "Toggle", html: `<div id="storybook-root"><div style="display: flex; gap: 8px"><button style="${filled}">On</button><label>Airplane Mode</label></div></div>` },
      closed: { component: "Dialog", html: `<div id="storybook-root"><button data-slot="dialog-trigger" aria-haspopup="dialog" aria-expanded="false">Open</button></div>` },
      open: { component: "Dialog", html: `<div id="storybook-root"><button data-slot="dialog-trigger" aria-haspopup="dialog" aria-expanded="true">Open</button></div><div data-slot="dialog-content" role="dialog" style="position: fixed; top: 40px; left: 40px; width: 300px; padding: 24px; background: #ffffff; border-radius: 8px">Hello</div>` },
    });
    const seen = Object.fromEntries(Object.entries(m).map(([name, c]) => [name, `${c.status} ${c.element} ${JSON.stringify(c.notes)} ${c.boundingBox?.width}x${c.boundingBox?.height}`]));
    const say = JSON.stringify(seen, null, 2);
    assert(m.otp.status === "ok" && m.otp.element === "div" && m.otp.notes.length === 0 && m.otp.boundingBox.height === 38, `InputOTP: ${say}`);
    assert(m.switch.element === 'button[data-slot="switch"]' && m.switch.boundingBox.width === 32 && m.switch.notes.length === 0, `Switch: ${say}`);
    assert(m.row.element === "div" && m.row.notes[0]?.kind === "layout-wrapper", `a row with no slot: ${say}`);
    assert(m.closed.notes[0]?.kind === "closed-trigger", `a closed Dialog: ${say}`);
    assert(m.open.element === 'div[data-slot="dialog-content"]' && m.open.styles.backgroundColor === "#ffffff" && m.open.boundingBox.width === 348, `an open Dialog: ${say}`);
    return "the OTP boxes, the switch, the open dialog; the row and the trigger flagged";
  });

  await check("a story's markup checksum changes with what its args set, leaves out Storybook's own nodes, and is null while it changes", async () => {
    // InputOTP's textAlign sets only the style of input-otp's hidden input,
    // so every variant measured the same though the args reached it: the
    // markup is what tells that from a story that drops its args.
    const input = (align) => `<div id="storybook-root"><div data-slot="input-otp" style="display: flex; width: 120px; height: 36px; background: #e5e5e5"><input style="text-align: ${align}; opacity: 0"></div></div>`;
    const docs = (text) => `<div id="storybook-docs">${text}</div><div class="sb-errordisplay">${text}</div><script>window.x = "${text}";</script>`;
    const m = await captureStories({
      left: { component: "InputOTP", html: input("left") + docs("one") },
      leftAgain: { component: "InputOTP", html: input("left") + docs("two") },
      right: { component: "InputOTP", html: input("right") + docs("one") },
      // A portal, as Radix renders an open popover's content into the body.
      portal: { component: "InputOTP", html: `${input("left")}<div data-radix-portal><div role="dialog">Hello</div></div>` },
      // Markup that changes as the story is measured, as an animation's
      // would: no evidence either way. Changed on each style read, so it
      // changes between the two reads of the markup every time.
      ticking: { component: "InputOTP", html: `${input("left")}<script>const read = window.getComputedStyle; let n = 0; window.getComputedStyle = function (...args) { document.querySelector("input")?.setAttribute("data-n", String(n++)); return read.apply(this, args); };</script>` },
    });
    const markup = Object.fromEntries(Object.entries(m).map(([name, c]) => [name, c.status === "ok" ? c.markup : `${c.status}: ${c.error}`]));
    const say = JSON.stringify(markup);
    assert(typeof markup.left === "string" && markup.left === markup.leftAgain, `the same story with Storybook's own nodes changed: ${say}`);
    assert(markup.right !== markup.left, `text-align left and right: ${say}`);
    assert(typeof markup.portal === "string" && markup.portal !== markup.left, `a portal beside the root: ${say}`);
    assert(markup.ticking === null, `markup that changed while it was measured: ${say}`);
    return "the same for the same story, apart for a style or a portal, null while ticking";
  });

  await check("text the browser cuts off or wraps is recorded with the width it was laid out in, and a label on one line isn't", async () => {
    // Attachment's vertical title has Tailwind's truncate, so the browser cut
    // it off at the card's width with an ellipsis; snap recorded nothing of
    // it, and the push built a title that ran 28px past its card.
    const card = (inner, extra = "") => `<div id="storybook-root"><div data-slot="attachment" style="display: flex; flex-direction: column; width: 120px; padding: 8px; border: 1px solid #e5e5e5; box-sizing: border-box; font: 500 14px/20px sans-serif${extra}">${inner}</div></div>`;
    const long = "sales-dashboard-quarterly-final-v2.png";
    const m = await captureStories({
      truncate: { component: "Attachment", html: card(`<span style="display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${long}</span>`) },
      clip: { component: "Attachment", html: card(`<span style="display: block; overflow: hidden; white-space: nowrap">${long}</span>`) },
      wrap: { component: "Attachment", html: card(`<span style="display: block">A quarterly report of sales, by region and by product line</span>`) },
      clamp: { component: "Attachment", html: card(`<span style="display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden">A quarterly report of sales, by region and by product line, for the board</span>`) },
      // An inline label wraps and is cut off by the block it is in.
      inline: { component: "Attachment", html: card(`<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap"><span>${long}</span></div>`) },
      label: { component: "Button", html: `<div id="storybook-root"><button data-slot="button" style="display: inline-flex; padding: 4px 8px; font: 600 12px sans-serif">Save</button></div>` },
    });
    const layout = Object.fromEntries(Object.entries(m).map(([name, c]) => [name, c.status === "ok" ? c.styles.text?.layout ?? null : `${c.status}: ${c.error}`]));
    const say = JSON.stringify(layout);
    assert(JSON.stringify(layout.truncate) === JSON.stringify({ width: 102, lines: 1, truncation: "ellipsis" }), `truncate: ${say}`);
    assert(JSON.stringify(layout.clip) === JSON.stringify({ width: 102, lines: 1, truncation: "clip" }), `clip: ${say}`);
    assert(layout.wrap?.width === 102 && layout.wrap.lines >= 3 && layout.wrap.truncation === undefined, `wrap: ${say}`);
    assert(JSON.stringify(layout.clamp) === JSON.stringify({ width: 102, lines: 2, truncation: "ellipsis" }), `clamp: ${say}`);
    assert(JSON.stringify(layout.inline) === JSON.stringify({ width: 102, lines: 1, truncation: "ellipsis" }), `inline: ${say}`);
    assert(layout.label === null, `a one-line label: ${say}`);
    return say;
  });

  await check("text the browser doesn't show is passed over: an sr-only label, a hidden span, one not displayed or hidden", async () => {
    // Base UI's Progress keeps a span of text in a fixed 1px box that clips
    // it: snap measured it as Progress's text, cut off at 1px, and the push
    // would have built a 1px label. An icon button's sr-only label gave the
    // button a text it doesn't show in the same way.
    const v3 = "position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0; font-size: 20px";
    const v4 = "position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border-width: 0; font-size: 20px";
    const button = (inner) => `<div id="storybook-root"><button data-slot="button" style="display: inline-flex; gap: 4px; padding: 4px 8px; font: 600 12px sans-serif">${inner}</button></div>`;
    const icon = `<svg width="16" height="16"><rect width="16" height="16"/></svg>`;
    const m = await captureStories({
      progress: { component: "Progress", html: `<div id="storybook-root"><div data-slot="progress" style="position: relative; width: 200px; height: 8px; background: #e5e5e5"><div style="width: 50%; height: 100%; background: #171717"></div><span style="position: fixed; top: 0; left: 0; width: 1px; height: 1px; overflow: hidden; white-space: nowrap">50%</span></div></div>` },
      srOnly: { component: "Button", html: button(`${icon}<span style="${v3}">Close</span>`) },
      srOnlyV4: { component: "Button", html: button(`${icon}<span style="${v4}">Close</span>`) },
      // The label shown, after a hidden one: the shown one's 13px, not 20px.
      shownAfter: { component: "Button", html: button(`<span style="${v3}">Close</span><span style="display: none; font-size: 20px">Off</span><span style="visibility: hidden; font-size: 20px">Off</span><span style="font-size: 13px">Save</span>`) },
      // A label shown inside a box that hides others: visibility is
      // inherited, and a child can show itself again.
      shownInside: { component: "Button", html: button(`<span style="visibility: hidden; font-size: 20px">Off <span style="visibility: visible; font-size: 13px">On</span></span>`) },
    });
    const text = Object.fromEntries(Object.entries(m).map(([name, c]) => [name, c.status === "ok" ? c.styles.text ?? null : `${c.status}: ${c.error}`]));
    const say = JSON.stringify(text);
    for (const name of ["progress", "srOnly", "srOnlyV4"]) assert(text[name] === null, `${name}: ${say}`);
    for (const name of ["shownAfter", "shownInside"]) assert(text[name]?.fontSize === 13 && text[name].layout === undefined, `${name}: ${say}`);
    return "no text on Progress or the icon buttons; the shown label's 13px beside hidden ones";
  });

  await check("a story that throws after load is a render error, found without waiting out --timeout", async () => {
    // As ResizablePanelGroup does: Storybook paints the error after the load
    // event, and snap reported no root element, twice --timeout later.
    const { thrown, empty } = await captureStories({
      thrown: { component: "ResizablePanelGroup", html: `<div id="storybook-root"></div><div id="error-message"></div><script>setTimeout(() => { document.getElementById("error-message").textContent = "We detected that you use an implicit action arg while rendering"; document.body.classList.add("sb-show-errordisplay"); }, 300)</script>` },
      empty: { component: "Empty", html: `<div id="storybook-root"></div>`, timeoutMs: 1500 },
    });
    assert(thrown.status === "render_error" && /implicit action arg/.test(thrown.error) && thrown.ms < 5000, `a thrown story: ${thrown.status} ${thrown.error} after ${thrown.ms}ms`);
    assert(empty.status === "element_not_found" && empty.ms < 2 * 1500, `an empty story: ${empty.status} after ${empty.ms}ms, for a --timeout of 1500`);
    return `render_error in ${thrown.ms}ms; an empty story given up on in ${empty.ms}ms`;
  });

  await check("a system font stack is recorded as the font Chrome drew, and an avatar's photo as loaded", async () => {
    // Tailwind v4's default stack opens with -apple-system, which Chrome
    // doesn't implement; snap recorded it on every component, warned that
    // it failed to load, and verify scored it as drift. And an Avatar loads
    // its photo with new Image(), showing its initials until it arrives.
    const m = await captureStories({
      stack: { component: "Button", html: `<div id="storybook-root"><button style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #171717; color: #fff">Go</button></div>` },
      avatar: { component: "Avatar", html: `<div id="storybook-root"><span data-slot="avatar" style="display: flex; width: 32px; height: 32px; background: #f5f5f5"><span id="fallback" style="display: flex; color: #737373">CN</span></span></div><script>requestAnimationFrame(() => { const img = new Image(); img.onload = () => { const shown = document.createElement("img"); shown.src = img.src; document.getElementById("fallback").replaceWith(shown); }; img.src = "/slow.png"; })</script>` },
    }, { slowImageMs: 1000 });
    assert(m.stack.styles.fontFamily === "system-ui" && m.stack.styles.fontAvailable === null && m.stack.styles.text?.fontFamily === "system-ui",
      `the system stack: ${JSON.stringify({ fontFamily: m.stack.styles.fontFamily, fontAvailable: m.stack.styles.fontAvailable, text: m.stack.styles.text?.fontFamily, probe: m.stack.fonts.root })}`);
    assert(m.avatar.styles.text === null, `the avatar measured its fallback, text ${JSON.stringify(m.avatar.styles.text)}`);
    return "system-ui with no warning; the photo, after 1s";
  });

  await check("a refused connection is a render error even when the story's URL says timeout; a server that never answers is a timeout", async () => {
    const { createServer } = await import("node:http");
    const { resolveAndLaunch, createContext, captureStory } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-browser.js")).href);
    const { buildStoryUrl } = await import(pathToFileURL(join(ROOT, "dist", "cli", "snap-normalize.js")).href);
    const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
    // A port that was free a moment ago, as when Storybook dies mid-run.
    const closed = createServer();
    const refused = await listen(closed);
    await new Promise((done) => closed.close(done));
    const hanging = createServer(() => { /* never answers */ });
    const silent = await listen(hanging);
    const { browser } = await resolveAndLaunch();
    try {
      const tab = await (await createContext(browser)).newPage();
      for (const [id, args] of [["forms-button--default", "status:idle"], ["forms-button--default", "status:timeout"], ["feedback-session-timeout--default", null]]) {
        const capture = await captureStory(tab, buildStoryUrl(`http://127.0.0.1:${refused}`, id, args), { timeoutMs: 5000, screenshot: false });
        assert(capture.status === "render_error", `${id} ${args ?? ""}: ${capture.status} (${capture.error})`);
      }
      const capture = await captureStory(tab, buildStoryUrl(`http://127.0.0.1:${silent}`, "forms-button--default", null), { timeoutMs: 1500, screenshot: false });
      assert(capture.status === "timeout", `a server that never answers: ${capture.status} (${capture.error})`);
    } finally {
      await browser.close();
      hanging.closeAllConnections();
      hanging.close();
    }
    return "3 refused connections, 1 timeout";
  });

  await check("two snaps of the same code are byte-identical, wherever they are written", () => {
    // Same flags as the first run, into a different directory. styles.json is
    // meant to be committed and diffed, so neither a rerun nor a different
    // --out (another machine, another checkout) may change a byte of it.
    const again = join(WORK, "elsewhere", "snap-again");
    const r = cli(["snap", "--storybook", STORYBOOK, "--out", again, "--screenshots", "--variants", "all", "--root-only"]);
    assert(r.status === 0, `second snap exited ${r.status}`);
    const first = readFileSync(join(snapDir, "styles.json"), "utf8");
    const second = readFileSync(join(again, "styles.json"), "utf8");
    if (first !== second) {
      const a = first.split("\n");
      const b = second.split("\n");
      const line = a.findIndex((l, i) => l !== b[i]);
      throw new Error(`styles.json differs at line ${line + 1}:\n  ${a[line]?.trim()}\n  ${b[line]?.trim()}`);
    }
  });

  await check("recorded screenshot paths resolve next to styles.json", () => {
    const snap = readJson(join(snapDir, "styles.json"));
    const paths = snap.components.flatMap((c) => c.variants.map((v) => v.screenshot)).filter(Boolean);
    assert(paths.length > 0, "no screenshot paths recorded despite --screenshots");
    for (const p of paths) {
      assert(!p.startsWith("/") && !/^[A-Za-z]:/.test(p), `absolute path recorded: ${p}`);
      assert(existsSync(join(snapDir, p)), `recorded path does not exist relative to styles.json: ${p}`);
    }
    return `${paths.length} PNGs`;
  });

  await check("a story that ignores its args is caught by --strict-warnings", () => {
    const frozen = cli(["snap", "--storybook", STORYBOOK, "--components", "Frozen", "--out", join(WORK, "frozen"), "--strict-warnings"]);
    const button = cli(["snap", "--storybook", STORYBOOK, "--components", "Button", "--out", join(WORK, "button"), "--strict-warnings"]);
    assert(frozen.status === 1, `Frozen exited ${frozen.status}, expected 1`);
    assert(button.status === 0, `Button exited ${button.status}, expected 0`);
    // Its markup is the same on every variant too, so the story is to blame,
    // not props that change only what snap doesn't measure.
    const warnings = readJson(join(WORK, "frozen", "styles.json")).components.find((c) => c.name === "Frozen").warnings;
    assert(warnings.some((w) => /^all 3 rendered variants measured identically and rendered the same markup — the story may not pass args through/.test(w)),
      `Frozen warned ${JSON.stringify(warnings)}`);
    return "Frozen fails, blaming its story, Button passes";
  });

  heading("Snap guards");

  await check("a --components name that matches nothing fails and writes nothing", () => {
    const out = join(WORK, "typo");
    const r = cli(["snap", "--storybook", STORYBOOK, "--components", "Buton", "--out", out]);
    assert(r.status !== 0, "exited 0 having measured nothing");
    assert(/buton/i.test(r.out), "error does not name the unmatched component");
    assert(!existsSync(join(out, "styles.json")), "wrote a styles.json anyway");
  });

  await check("a partly misspelled --components list fails rather than dropping the name", () => {
    const r = cli(["snap", "--storybook", STORYBOOK, "--components", "Button,Buton", "--out", join(WORK, "partial")]);
    assert(r.status !== 0, "exited 0 with Buton silently dropped");
  });

  await check("snap --merge measures one component again and keeps the other as it was", () => {
    // Re-run for one component alone, snap wrote a styles.json of that one,
    // and verify scored a whole push on it.
    const out = join(WORK, "merge");
    mkdirSync(out, { recursive: true });
    for (const file of ["styles.json", "meta.json"]) cpSync(join(snapDir, file), join(out, file));
    const before = readJson(join(out, "styles.json"));
    const earlier = readJson(join(out, "meta.json")).measuredAt;
    const r = cli(["snap", "--storybook", STORYBOOK, "--components", "Frozen", "--variants", "all", "--merge", "--out", out, "--root-only"]);
    assert(r.status === 0, `snap --merge exited ${r.status}\n${r.out.trim()}`);
    const after = readJson(join(out, "styles.json"));
    const key = (c) => c.title ?? c.id ?? c.name;
    assert(after.components.map(key).join(", ") === before.components.map(key).join(", "), `components ${after.components.map(key).join(", ")}`);
    const button = (snap) => JSON.stringify(snap.components.find((c) => c.name === "Button"));
    assert(button(after) === button(before), "Button changed, though only Frozen was measured again");
    const meta = readJson(join(out, "meta.json"));
    const times = meta.componentsMeasuredAt ?? {};
    const buttonKey = key(after.components.find((c) => c.name === "Button"));
    const frozenKey = key(after.components.find((c) => c.name === "Frozen"));
    assert(times[buttonKey] === earlier && times[frozenKey] > earlier, `componentsMeasuredAt: ${JSON.stringify(times)}`);
    assert(meta.measuredAt === earlier, `measuredAt ${meta.measuredAt}, not the oldest component's, ${earlier}`);

    // Another --variants would mix two kinds of measurement in one snap.
    const refused = cli(["snap", "--storybook", STORYBOOK, "--components", "Frozen", "--merge", "--out", out, "--root-only"]);
    assert(refused.status === 1 && /measured with --variants all: pass the same/.test(refused.out), `--variants representative merged: ${refused.out.trim()}`);
    return "Frozen measured again, Button kept, measuredAt the oldest";
  });

  heading("Map guards");

  await check("map rejects a misspelled --components name the same way", () => {
    const r = cli(["map", "--storybook", STORYBOOK, "--components", "Button,Buton"]);
    assert(r.status === 1, `map exited ${r.status} with Buton silently dropped`);
    assert(/no component named "Buton"\. Available: .*Button/.test(r.out), `error does not name the typo and what exists\n${r.out.trim()}`);
  });

  await check("map selects by name or ID, ignoring case, as snap does", () => {
    // Button by name, Frozen by its ID, each in the wrong case.
    const r = cli(["map", "--storybook", STORYBOOK, "--components", " button ,FORMS-FROZEN", "--json"]);
    assert(r.status === 0, `map exited ${r.status}\n${r.out.trim()}`);
    const names = JSON.parse(r.out).components.map((c) => c.name).sort();
    assert(names.join(", ") === "Button, Frozen", `selected ${names.join(", ") || "nothing"}`);
  });

  heading("Inspect guards");

  await check("inspect rejects a misspelled --component, naming what exists", () => {
    const r = cli(["inspect", "--storybook", STORYBOOK, "--component", "Buton"]);
    assert(r.status === 1, `inspect exited ${r.status}\n${r.out.trim()}`);
    assert(/No component named "Buton"\. Available: .*Button/.test(r.out), `error does not name the typo and what exists\n${r.out.trim()}`);
    assert(!/^\s+at /m.test(r.out), `printed a stack trace\n${r.out.trim()}`);
  });

  await check("inspect reads a component by ID, ignoring case", () => {
    const r = cli(["inspect", "--storybook", STORYBOOK, "--component", "FORMS-BUTTON"]);
    assert(r.status === 0, `inspect exited ${r.status}\n${r.out.trim()}`);
    assert(/variant \(union\) -> VARIANT \[primary, danger, outline\]/.test(r.out), `variant not mapped\n${r.out.trim()}`);
  });

  heading("Element-tree push through figma code");

  // The push as the skill now runs it (design section 12): the tree snap
  // taken above, `figma code`, every call sent unchanged to a mock Figma
  // and its response saved unchanged, then `verify --plan`. No styling code
  // is written by hand anywhere in it.
  const treeSnap = join(WORK, "tree", "styles.json");
  const treeTokens = join(WORK, "tree-tokens.json");
  let treeRun = null;

  await check("figma code plans the example's push, every call within use_figma's limits, the same twice", () => {
    const tokens = cli(["tokens", "--json", "--project", join(ROOT, "examples", "storybook-vite")]);
    writeFileSync(treeTokens, tokens.out.trim().split("\n").pop());
    const dirs = ["tree-plan-a", "tree-plan-b"].map((name) => join(WORK, name, "figma"));
    const plans = dirs.map((out) => {
      const r = cli(["figma", "code", "--snap", treeSnap, "--tokens", treeTokens, "--out", out]);
      assert(r.status === 0, `figma code exited ${r.status}\n${r.out.trim()}`);
      assert(/use_figma calls? \(.*\), planned in /.test(r.out), `figma code didn't say what it planned\n${r.out.trim()}`);
      return readJson(join(out, "plan.json"));
    });
    const kinds = plans[0].calls.map((c) => c.kind);
    assert(kinds.includes("build") && kinds.includes("label") && kinds.includes("read"), `calls: ${kinds.join(", ")}`);
    for (const call of plans[0].calls) {
      const code = readFileSync(join(dirs[0], call.file), "utf8");
      assert(code.length === call.chars && code.length <= MAX_CALL_CHARS, `${call.file}: ${code.length} characters, plan says ${call.chars}`);
      assert(code === readFileSync(join(dirs[1], call.file), "utf8"), `${call.file} differs between two runs`);
    }
    assert(JSON.stringify(plans[0]) === JSON.stringify(plans[1]), "plan.json differs between two runs");
    const longest = Math.max(...plans[0].calls.map((c) => c.chars));
    return `${kinds.length} calls (${[...new Set(kinds)].join(", ")}), the longest ${longest} characters`;
  });

  await check("every call runs unchanged in Figma, and verify --plan scores every element of the example at 100%", async () => {
    treeRun = await treePush(treeSnap, join(WORK, "tree-push", "figma"), { tokens: treeTokens });
    const v = verifyPlan(treeRun.planPath, ["--strict-measured", "--strict-age", "--min-fidelity", "100"]);
    assert(v.status === 0, `verify --plan exited ${v.status}\n${v.out.trim().slice(0, 2000)}`);
    const e = v.json.summary.elements;
    assert(v.json.elementFidelity === 1 && v.json.fidelity === 1, `element fidelity ${v.json.elementFidelity}, properties ${v.json.fidelity}`);
    assert(e.measured > 0 && e.verified === e.measured && !e.drifted && !e.missing && !e.extra && !e.designerLayers, `elements ${JSON.stringify(e)}`);
    assert(v.json.plan.problems.length === 0 && existsSync(join(WORK, "tree-push", "figma-readback.json")), `plan: ${JSON.stringify(v.json.plan)}`);
    const text = cli(["verify", "--plan", treeRun.planPath]);
    assert(/Fidelity: 100\.0% of elements \(\d+ of \d+ verified\), 100\.0% of properties/.test(text.out), `headline:\n${text.out.trim().slice(0, 600)}`);
    return `${e.verified}/${e.measured} elements, ${v.json.summary.propertiesMatched} properties, ${treeRun.runs.length} calls sent`;
  });

  await check("sending the build calls again changes nothing in Figma, and reads back the same", async () => {
    assert(treeRun, "the push above didn't run");
    const readback = () => readJson(join(WORK, "tree-push", "figma-readback.json"));
    const before = readback();
    for (const call of treeRun.plan.calls.filter((c) => c.kind === "build")) {
      const run = await treeRun.mock.run(readFileSync(join(treeRun.out, call.file), "utf8"));
      assert(run.ok && run.created === 0 && run.removed === 0, `${call.file} sent again: created ${run.created}, removed ${run.removed}${run.ok ? "" : `, failed: ${run.text}`}`);
    }
    await readTreeAgain(treeRun);
    const v = verifyPlan(treeRun.planPath, ["--strict"]);
    assert(v.status === 0, `verify --plan exited ${v.status}\n${v.out.trim().slice(0, 1500)}`);
    const plain = (file) => JSON.stringify(file, (k, value) => (k === "readAt" || k === "checksum" ? undefined : value));
    assert(plain(readback()) === plain(before), "the second reading differs from the first apart from readAt and checksum");
    return "0 layers created or removed; the same readback apart from readAt and checksum";
  });

  await check("a child element changed in Figma is reported as exactly that drift, by its key and node id, and undoing it passes again", async () => {
    // The falsification test for children: 0.4.0 compared the outer
    // element alone, so a label changed inside a button scored 100%.
    assert(treeRun, "the push above didn't run");
    const button = readJson(treeSnap).components.find((c) => c.name === "Button");
    const slug = button.variants[0].slug;
    const label = treeLayer(treeRun.mock, slug, "#text");
    const recolor = async (hex) => {
      const rgb = rgb01(hex);
      const run = await treeRun.mock.run(`const n = await figma.getNodeByIdAsync(${JSON.stringify(label.id)}); n.fills = [{ type: "SOLID", color: ${JSON.stringify(rgb)} }]; return { kind: "edit" };`);
      assert(run.ok, run.text);
      await readTreeAgain(treeRun);
    };
    await recolor("#ff00ff");
    const drifted = verifyPlan(treeRun.planPath, ["--strict"]);
    assert(drifted.status === 1, `verify --strict exited ${drifted.status} after the label was recolored`);
    const nodes = drifted.json.variants.flatMap((v) => (v.nodes ?? []).map((n) => ({ slug: v.slug, ...n })));
    assert(nodes.length === 1 && nodes[0].slug === slug && nodes[0].key === "#text" && nodes[0].figmaId === label.id,
      `drifted: ${JSON.stringify(nodes.map((n) => [n.slug, n.key, n.figmaId, n.differences.map((d) => d.property)]))}`);
    const props = nodes[0].differences.map((d) => `${d.property} ${JSON.stringify(d.measured)} -> ${JSON.stringify(d.figma)}`);
    assert(props.length === 1 && /#ff00ff/i.test(props[0]), `differences: ${props.join("; ")}`);
    const text = cli(["verify", "--plan", treeRun.planPath]);
    assert(text.out.includes(`› #text: ${nodes[0].differences[0].property} measured`) && text.out.includes(`(node ${label.id})`), `the drift line names no key and node:\n${text.out.trim().slice(0, 1200)}`);
    const colors = button.tree.base.find((n) => n.k === "#text").tx.col;
    await recolor(colors);
    const again = verifyPlan(treeRun.planPath, ["--strict"]);
    assert(again.status === 0 && again.json.elementFidelity === 1, `after undoing it: exit ${again.status}, ${again.json?.elementFidelity}`);
    return `${slug} › #text: ${props[0]}, then 100% again`;
  });

  await check("a saved response edited by hand is flagged on exactly that entry, and fails --strict", () => {
    assert(treeRun, "the push above didn't run");
    const out = join(WORK, "tree-edited", "figma");
    cpSync(treeRun.out, out, { recursive: true });
    const read = treeRun.plan.calls.find((c) => c.kind === "read");
    const path = join(out, read.result);
    const text = readFileSync(path, "utf8");
    // One color in one entry, as an agent tidying a response would change it.
    const edited = text.replace(/"#ffffff"/, '"#fefefe"');
    assert(edited !== text, "the read result holds no #ffffff to edit");
    writeFileSync(path, edited);
    const v = verifyPlan(join(out, "plan.json"), ["--strict"]);
    assert(v.status === 1, `verify --strict exited ${v.status} on an edited response`);
    const issues = v.json.readbackIssues;
    assert(issues.length === 1 && issues[0].problem === "checksum_mismatch", `issues: ${JSON.stringify(issues)}`);
    return `${issues[0].component} ${issues[0].slug}: checksum_mismatch, and no other entry`;
  });

  heading("Round trip through the shipped skill template");

  const perfect = join(WORK, "readback-perfect.json");

  await check("a faithful Figma reproduction scores 100%", async () => {
    const calls = {};
    writeJson(perfect, await buildReadback(snapDir, {
      onRead: (component, n) => { calls[component.name] = n; },
    }));
    // Read in slices, as the skill has to: the merge is part of what scores.
    // 12 is a multiple of READ_BATCH, so the last slice ends on the set's
    // last variant, and a call past it would be one too many.
    assert(12 % READ_BATCH === 0, `READ_BATCH ${READ_BATCH} does not divide the Button's 12 variants`);
    assert(calls.Button === 12 / READ_BATCH, `the Button set was read in ${calls.Button} calls, not ${12 / READ_BATCH}`);
    const v = verifyJson(snapDir, perfect);
    assert(v.json, `verify produced no JSON\n${v.out}`);
    const { summary, fidelity } = v.json;
    assert(fidelity === 1, `fidelity ${fidelity} (${summary.propertiesMatched}/${summary.propertiesCompared}), drifted ${summary.drifted}\n` +
      v.json.variants.filter((x) => x.status !== "verified")
        .map((x) => `${x.slug} [${x.status}] ${x.differences.map((d) => `${d.property}: ${JSON.stringify(d.measured)} vs ${JSON.stringify(d.figma)}`).join("; ")}`)
        .join("\n"));
    // Each entry carries the checksum the template computed, and verify
    // recomputes every one from the file.
    const entries = Object.values(readJson(perfect).components).flatMap((c) => Object.entries(c.variants));
    const unsealed = entries.filter(([, entry]) => !/^fnv1a:[0-9a-f]{8}$/.test(entry.checksum ?? ""));
    assert(unsealed.length === 0, `${unsealed.length} entries came back without a checksum: ${unsealed.slice(0, 3).map(([slug]) => slug).join(", ")}`);
    assert((v.json.readbackIssues ?? []).length === 0 && summary.unverifiedReadback === 0,
      `${summary.unverifiedReadback} variants unverified: ${describeIssues(v.json.readbackIssues ?? [])}`);
    const status = exitOf(snapDir, perfect, ["--strict", "--strict-age", "--strict-measured"]);
    assert(status === 0, `all strict flags exited ${status}`);
    const total = Object.values(calls).reduce((a, b) => a + b, 0);
    return `${summary.verified}/${summary.variants} variants, ${summary.propertiesCompared} properties, read in ${total} slices, ` +
      `${entries.length} checksums verified`;
  });

  await check("a transparent border and a box shadow are scored by the border box, not Figma's render bounds", async () => {
    // A live push of a 72-variant Chip read its 24 soft variants 2px short
    // each way: their CSS border is transparent, and Figma's render bounds
    // leave out a stroke that paints nothing, where the browser's border box
    // keeps the border's space. Render bounds take in drop shadows too, which
    // the border box does not. The simulated nodes' render bounds do the
    // same, and the template reads the size from the geometry instead: the
    // node's own size plus the stroke outside it, by strokeAlign.
    const edges = edgeVariants(snapDir);
    const node = (edge, align) => {
      const { styles, strokeAlign, strokeHidden } = edges.find((e) => e.edge === edge);
      return figmaNode(edge, styles, { strokeAlign: align ?? strokeAlign, strokeHidden });
    };
    const beyond = (n) => `${n.absoluteRenderBounds.width - n.width},${n.absoluteRenderBounds.height - n.height}`;
    const clear = node("transparent-border");
    assert(clear.strokes.length === 1 && clear.strokeWeight === 1 && beyond(clear) === "0,0",
      `a transparent 1px border's render bounds reach ${beyond(clear)} past the node, not 0,0`);
    // The same border with its paint hidden by the eye icon: full opacity,
    // but visible: false, so it draws nothing and its render bounds leave it out.
    const hidden = node("hidden-stroke");
    const [paint] = hidden.strokes;
    assert(hidden.strokes.length === 1 && paint.visible === false && paint.opacity === 1 && beyond(hidden) === "0,0",
      `a 1px stroke hidden with visible: false is ${JSON.stringify(paint)}, its render bounds reaching ${beyond(hidden)} past the node, not 0,0`);
    const shadow = node("box-shadow");
    assert(beyond(shadow) === "24,24", `a shadow 4px down with a 12px blur reaches ${beyond(shadow)} past the node, not 24,24`);
    const reach = ["OUTSIDE", "CENTER", "INSIDE"].map((align) => beyond(node("inside-stroke", align))).join("; ");
    assert(reach === "4,4; 2,2; 0,0", `a visible 2px stroke reaches ${reach} past the node, OUTSIDE, CENTER and INSIDE`);
    assertEdges(await scoreEdges(snapDir, loadSkillReadback()));
    // The same border INSIDE on a hugging frame without strokesIncludedInLayout
    // eats into the padding, 2px short each way (the width less the text's
    // rounding), and verify says so.
    const { styles: transparent } = edges.find((e) => e.edge === "clear-inside");
    const eaten = await scoreEdges(snapDir, loadSkillReadback(), [{ edge: "eaten", styles: transparent, strokeAlign: "INSIDE", hugging: true }]);
    const short = eaten.eaten.differences.filter((d) => d.property === "width" || d.property === "height").map((d) => d.figma - d.measured);
    assert(short.length === 2 && short.every((d) => Math.abs(d + 2) < 0.5), `an INSIDE stroke that eats into a hugging frame's padding drifted ${JSON.stringify(eaten.eaten.differences)}`);
    return `render bounds would read the transparent border 2px short, hidden or not, and the shadow 24px over; ` +
      `all ${edges.length}, with the one-sided border, strokes INSIDE and CENTER, and a transparent one INSIDE in the layout, ` +
      `scored with no size drift; INSIDE out of the layout reads 2px short`;
  });

  await check("a translucent fill, stroke and text color read back as snap writes them, alpha and all", async () => {
    // snap writes a translucent color as #rrggbbaa, a soft Chip's background
    // #4b556322, and verify compares colors as written. Figma keeps a
    // paint's alpha in its opacity, so a readback that converts only the
    // paint's color reads #4b5563, and every translucent paint drifts. And a
    // stroke hidden with the eye icon reads as null, as snap records a
    // transparent border, whatever its paint's opacity.
    const edges = Object.fromEntries(edgeVariants(snapDir).map((e) => [e.edge, e]));
    const { styles } = edges.translucent;
    const want = { backgroundColor: "#4b556322", color: "#111827b3", border: "#2563eb4d" };
    assert(styles.backgroundColor === want.backgroundColor && (styles.text?.color ?? styles.color) === want.color
      && styles.borderUniform?.color === want.border, "the translucent edge variant no longer carries the colors this check reads");
    const built = figmaNode("translucent", styles);
    const opacities = [built.fills[0], built.strokes[0], built.findOne(() => true).fills[0]].map((p) => Math.round(p.opacity * 255));
    assert(opacities.join() === "34,77,179", `the simulated paints' opacities come to ${opacities.join()} of 255, not 34,77,179`);
    const readback = loadSkillReadback();
    const verdicts = await scoreEdges(snapDir, readback);
    assertEdges(verdicts);
    const slice = await readback.read(
      { id: "set:One", type: "COMPONENT_SET", name: "One", children: [built, figmaNode("hidden", edges["hidden-stroke"].styles, { strokeHidden: true })] },
      { translucent: "edge-translucent", hidden: "edge-hidden-stroke" },
      { "edge-translucent": "measured", "edge-hidden-stroke": "measured" },
    );
    const read = slice.readback["edge-translucent"];
    const got = { backgroundColor: read.backgroundColor, color: read.color, border: read.borderUniform?.color };
    assert(JSON.stringify(got) === JSON.stringify(want), `read back ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    const hidden = slice.readback["edge-hidden-stroke"].borderUniform;
    assert(hidden?.width === 1 && hidden.color === null, `a stroke hidden with visible: false read back as ${JSON.stringify(hidden)}`);
    // An agent may set a paint's opacity to the decimal it recognizes, 0.7 for
    // snap's b3 (rgba(0,0,0,0.7) rounds to 179). Figma keeps it as a 32-bit
    // float, 0.69999…, which has to read back b3, not b2.
    const decimal = figmaNode("decimal", { ...styles, backgroundColor: "#000000b3" });
    decimal.fills = [{ ...decimal.fills[0], opacity: Math.fround(0.7) }];
    const decimalRead = (await readback.read(
      { id: "set:Two", type: "COMPONENT_SET", name: "Two", children: [decimal] },
      { decimal: "edge-decimal" },
      { "edge-decimal": "measured" },
    )).readback["edge-decimal"].backgroundColor;
    assert(decimalRead === "#000000b3", `a fill whose opacity was set to 0.7 read back as ${decimalRead}, not #000000b3`);
    return `fill ${got.backgroundColor}, stroke ${got.border}, text ${got.color}; opacity 0.7 as b3; a hidden 1px stroke null; ` +
      `${verdicts.translucent.status} and ${verdicts["hidden-stroke"].status}`;
  });

  await check("text the browser cut off is scored on how Figma fits it: a title that hugs and runs past its card drifts", async () => {
    // A live push built Attachment's vertical title, which Tailwind's
    // truncate cuts off at 94px with an ellipsis, as a text that hugged its
    // 140px and ran 28px past a 120px card, and verify scored it 100%.
    const plain = edgeVariants(snapDir)[0].styles;
    assert(plain.text, "the example Button's edge variant has no measured text");
    const cut = { ...plain, text: { ...plain.text, layout: { width: 40, lines: 1, truncation: "ellipsis" } } };
    const wrapped = { ...plain, text: { ...plain.text, layout: { width: 40, lines: 3 } } };
    const verdicts = await scoreEdges(snapDir, loadSkillReadback(), [
      { edge: "plain", styles: { ...plain, borderUniform: null, border: null } },
      { edge: "cut", styles: cut },
      { edge: "cut-hugging", styles: cut, textHugs: true },
      { edge: "wrapped", styles: wrapped },
      { edge: "wrapped-hugging", styles: wrapped, textHugs: true },
    ]);
    const say = JSON.stringify(Object.fromEntries(Object.entries(verdicts).map(([edge, v]) => [edge, `${v.status} ${v.differences.map((d) => d.property).join(",")}`])));
    for (const edge of ["plain", "cut", "wrapped"]) assert(verdicts[edge].status === "verified", `${edge}: ${say}`);
    for (const edge of ["cut-hugging", "wrapped-hugging"]) {
      assert(verdicts[edge].status === "drifted" && verdicts[edge].differences.map((d) => d.property).join() === "textLayout", `${edge}: ${say}`);
    }
    return say;
  });

  await check("the readback says what each field is bound to, and verify names a field bound to nothing at a variable's value", async () => {
    // A falsification run had to detach the radius variable to edit a radius
    // by hand. Detached at the same value, the readback, which read values
    // alone, scored 100%: the link that keeps the library in step with the
    // code was gone, and nothing said so.
    const button = readJson(join(snapDir, "styles.json")).components.find((c) => c.name === "Button");
    const variants = expandVariants(button);
    const base = variants[0].styles;
    const color = (hex) => ({ ...rgb01(hex), a: 1 });
    // As Tokens step 3 makes them: each kind in a collection of its own.
    const collections = [{ id: "VariableCollectionId:1:0", name: "Colors" }, { id: "VariableCollectionId:2:0", name: "Radius" }];
    const variables = [
      { id: "VariableID:1:1", name: "primary", resolvedType: "COLOR", valuesByMode: { "1:0": color(base.backgroundColor) }, variableCollectionId: "VariableCollectionId:1:0" },
      { id: "VariableID:1:2", name: "md", resolvedType: "FLOAT", valuesByMode: { "2:0": base.borderRadiusUniform }, variableCollectionId: "VariableCollectionId:2:0" },
      { id: "VariableID:1:3", name: "alias", resolvedType: "FLOAT", valuesByMode: { "2:0": { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } }, variableCollectionId: "VariableCollectionId:2:0" },
    ];
    const alias = (id) => ({ type: "VARIABLE_ALIAS", id });
    const detached = variants[1].slug;
    const sets = simulatedSets(snapDir, {
      mutate: (node, v, component) => {
        if (component.name !== "Button") return;
        if (v.styles.backgroundColor === base.backgroundColor) node.fills = [{ ...node.fills[0], boundVariables: { color: alias("VariableID:1:1") } }];
        // Every radius bound, but one, detached at the same value.
        if (v.styles.borderRadiusUniform === base.borderRadiusUniform && v.slug !== detached) node.boundVariables = { topLeftRadius: alias("VariableID:1:2") };
      },
    });
    const template = loadSkillReadback();
    const withVariables = { ...template, read: (set, slugs, sources, opts) => template.read(set, slugs, sources, { ...opts, variables, collections }) };
    const components = {};
    for (const set of sets) {
      const { variants: read } = await readSet(withVariables, set, READ_BATCH);
      components[set.component.title ?? set.component.name] = { nodeId: set.componentSet.id, variants: read };
    }
    const entry = components["Forms/Button"].variants;
    assert(entry[variants[0].slug].bound.backgroundColor === "primary" && entry[variants[0].slug].bound.borderRadiusUniform === "md",
      `the first variant read back bound ${JSON.stringify(entry[variants[0].slug].bound)}`);
    assert(JSON.stringify(entry[detached].unbound) === JSON.stringify(["borderRadiusUniform"]) && !("borderRadiusUniform" in entry[detached].bound),
      `the detached variant read back ${JSON.stringify({ bound: entry[detached].bound, unbound: entry[detached].unbound })}`);
    const path = join(WORK, "readback-bindings.json");
    writeJson(path, { version: 1, fileKey: "acceptance", components });
    const v = verifyJson(snapDir, path);
    assert(v.json?.fidelity === 1, `the bound readback scored ${v.json?.fidelity}\n${v.out}`);
    assert(JSON.stringify(v.json.bindings.unbound) === JSON.stringify([{ component: "Forms/Button", field: "borderRadiusUniform", variants: 1 }]),
      `verify reported unbound ${JSON.stringify(v.json.bindings)}`);
    const text = cli(["verify", "--snap", join(snapDir, "styles.json"), "--readback", path, "--strict"]);
    assert(text.status === 0 && /Bound to no variable, though a variable of its kind has the value[^\n]*\n\s+Forms\/Button borderRadiusUniform, on 1 variant/.test(text.out),
      `verify --strict exited ${text.status}:\n${text.out}`);
    // A readback from before, without bindings, still scores, and says it can't see them.
    const older = JSON.parse(JSON.stringify({ version: 1, fileKey: "acceptance", components }));
    for (const component of Object.values(older.components)) {
      for (const read of Object.values(component.variants)) { delete read.bound; delete read.unbound; delete read.textLayout; delete read.checksum; }
    }
    const olderPath = join(WORK, "readback-unbound-older.json");
    writeJson(olderPath, sealed(older));
    const old = cli(["verify", "--snap", join(snapDir, "styles.json"), "--readback", olderPath, "--strict"]);
    assert(old.status === 0 && /this readback doesn't say what is bound/.test(old.out), `an older readback: exit ${old.status}\n${old.out}`);
    return `${v.json.bindings.bound} fields bound across ${v.json.bindings.read} variants; the detached radius named; an older readback scored, saying it can't see bindings`;
  });

  await check("the readback matches a field only with variables of its kind: a padding at a radius's value is no detached radius", async () => {
    // The readback matched a field with every local variable. shadcn/ui's
    // only number tokens are its radii (sm 6, md 8, xl 14), so a Button
    // built and bound faithfully read back its py-2 padding, gap-2 and
    // text-sm as detached tokens, on nearly every variant.
    const button = readJson(join(snapDir, "styles.json")).components.find((c) => c.name === "Button");
    const variant = expandVariants(button)[0];
    const st = variant.styles;
    const name = figmaVariantName(variant.combination);
    const lengths = [st.padding.top, st.padding.right, st.gap?.column, (st.text ?? st).fontSize];
    assert(new Set([...lengths, st.borderRadiusUniform]).size === 5 && lengths.every((n) => n > 0),
      `the example Button's padding, gap, font size and radius are no longer five lengths apart: ${lengths}, ${st.borderRadiusUniform}`);
    const [top, side, gap, size] = lengths;
    const unbound = async (variables, collections) => (await loadSkillReadback().read(
      { id: "set:Kinds", type: "COMPONENT_SET", name: "Kinds", children: [figmaNode(name, st)] },
      { [name]: variant.slug }, { [variant.slug]: "measured" }, { variables, collections },
    )).readback[variant.slug].unbound.join();
    const COLLECTIONS = ["Radius", "Spacing", "Typography", "Primitives"].map((n) => ({ id: `VariableCollectionId:${n}`, name: n }));
    const float = (name, value, collection, scopes) => ({
      id: `VariableID:${collection}/${name}`, name, resolvedType: "FLOAT", valuesByMode: { "1:0": value },
      variableCollectionId: `VariableCollectionId:${collection}`, ...(scopes ? { scopes } : {}),
    });
    // A file whose only number variables are radii, at every length the
    // variant shows but its radius: nothing on it is a detached radius.
    const radii = lengths.map((n) => float(`r${n}`, n, "Radius"));
    const got = {
      radii: await unbound(radii, COLLECTIONS),
      // A spacing variable at the top padding, and a font size, are the
      // fields' own kind, so named; a line height at the font size is not.
      ownKind: await unbound([...radii, float("4", top, "Spacing"), float("leading/x", size, "Typography"), float("text/xs", size, "Typography")], COLLECTIONS),
      noLineHeight: await unbound([float("leading/x", size, "Typography"), float("font/weight/x", size, "Typography")], COLLECTIONS),
      // Scopes, where they name some, say the kind over the collection's
      // name, and a number in a collection named for no kind is never
      // matched.
      scoped: await unbound([float("a", side, "Radius", ["GAP"]), float("b", gap, "Primitives", ["CORNER_RADIUS"]), float("c", top, "Primitives")], COLLECTIONS),
    };
    const want = {
      radii: "",
      ownKind: "paddingTop,paddingBottom,fontSize",
      noLineHeight: "",
      scoped: "paddingRight,paddingLeft",
    };
    assert(JSON.stringify(got) === JSON.stringify(want), `read back unbound ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    return `radii at the padding (${top}, ${side}), gap (${gap}) and font size (${size}) named none of them; a spacing variable and a font size were named; scopes over the collection`;
  });

  await check("a readback that reads render bounds, or gets a stroke or a color wrong, fails these checks", async () => {
    // Each mutant rewrites the shipped readback template, and has to fail
    // the checks above, which the template passes.
    const T = {
      size: "width: child.width + edge('Left') + edge('Right'),\n        height: child.height + edge('Top') + edge('Bottom'),",
      outside: "const outside = stroke ? { OUTSIDE: 1, CENTER: 0.5 }[child.strokeAlign] || 0 : 0;",
      side: "return outside * (typeof own === 'number' ? own : child.strokeWeight);",
      color: "color: hexOf(stroke) }",
      hidden: "if (paint.visible === false) return null;",
      alpha: "+ (alpha < 255 ? byte(alpha) : '');",
      opacity: "* (typeof paint.opacity === 'number' ? paint.opacity : 1) * 255 + 1e-4);",
    };
    const mutants = {
      "reads the size from absoluteRenderBounds, as the live push did": (code) => code.replace(T.size,
        "width: (child.absoluteRenderBounds || child).width,\n        height: (child.absoluteRenderBounds || child).height,"),
      "reads the node's own size, leaving out the stroke outside it": (code) => code.replace(T.size,
        "width: child.width,\n        height: child.height,"),
      "adds the whole stroke whatever its strokeAlign": (code) => code.replace(T.outside, "const outside = stroke ? 1 : 0;"),
      "counts the strokeWeight of a node with no stroke": (code) => code.replace(T.outside,
        "const outside = { OUTSIDE: 1, CENTER: 0.5 }[child.strokeAlign] || 0;"),
      "counts a stroke only while its paint shows": (code) => code.replace(T.outside,
        "const outside = stroke && hexOf(stroke) ? { OUTSIDE: 1, CENTER: 0.5 }[child.strokeAlign] || 0 : 0;"),
      "reads strokeWeight, never each side's weight": (code) => code.replace(T.side, "return outside * child.strokeWeight;"),
      "reports the color of a stroke that paints nothing": (code) => code.replace(T.color,
        "color: hexOf({ ...stroke, visible: true, opacity: 1 }) }"),
      "reports the color of a stroke hidden with visible: false": (code) => code.replace(T.hidden, ""),
      "drops a translucent color's alpha, as toHex(paint.color) did": (code) => code.replace(T.alpha, ";"),
      "reads a paint's color without its opacity": (code) => code.replace(T.opacity, "* 255 + 1e-4);"),
    };
    const failed = [];
    for (const [mutant, mutate] of Object.entries(mutants)) {
      const readback = loadSkillReadback(mutate);
      let failure = null;
      try {
        assertEdges(await scoreEdges(snapDir, readback));
      } catch (err) {
        failure = err.message;
      }
      assert(failure, `a readback that ${mutant} scored every edge variant`);
      failed.push(mutant);
    }
    return `${failed.length} mutants fail`;
  });

  await check("a variant the agent did not mark measured is recorded as inferred", async () => {
    const snap = readJson(join(snapDir, "styles.json"));
    const withheld = snap.components.find((c) => c.name === "Button").variants[0].slug;
    const path = join(WORK, "readback-withheld.json");
    writeJson(path, await buildReadback(snapDir, { withholdSource: withheld }));
    const v = verifyJson(snapDir, path);
    const variant = v.json?.variants.find((x) => x.slug === withheld);
    assert(variant?.source === "inferred", `recorded as ${variant?.source}; omission must not read as measured`);
    assert(exitOf(snapDir, path, ["--strict-measured"]) === 1, "--strict-measured passed");
    assert(exitOf(snapDir, path, ["--strict"]) === 0, "--strict failed on provenance alone");
  });

  await check("a slice reads the variants it names, and fails on one the set lacks or holds twice", async () => {
    const readback = loadSkillReadback();
    const set = simulatedSets(snapDir).find((s) => s.component.name === "Button");
    const [first] = slices(Object.keys(set.slugByName), READ_BATCH);
    const tables = [pick(set.slugByName, first), pick(set.sourceBySlug, first.map((n) => set.slugByName[n]))];
    const failure = async (componentSet, slug = tables[0], source = tables[1]) => {
      try {
        await readback.read(componentSet, slug, source, { batch: READ_BATCH });
      } catch (err) {
        return err.message;
      }
      return null;
    };

    // A variant the build never made: named, but not in the set.
    const lacking = { ...set.componentSet, children: set.componentSet.children.filter((c) => c.name !== first[1]) };
    const missing = await failure(lacking);
    assert(missing?.includes(first[1]), `a slice naming a variant the set lacks ${missing ? `failed with: ${missing}` : "was returned"}`);

    // A variant a retried build made twice: reading either would be a guess.
    const twice = { ...set.componentSet, children: [...set.componentSet.children, { ...set.componentSet.children[0] }] };
    const doubled = await failure(twice);
    assert(doubled?.includes(first[0]), `a slice naming a variant the set holds twice ${doubled ? `failed with: ${doubled}` : "was returned"}`);

    // A call that names nothing reads nothing: a wasted call, refused.
    assert(await failure(set.componentSet, {}, {}), "a call naming no variants was returned");

    // One name more than BATCH: refused, before it can pass either limit.
    const over = Object.keys(set.slugByName).slice(0, READ_BATCH + 1);
    const refused = await failure(set.componentSet, pick(set.slugByName, over), pick(set.sourceBySlug, over.map((n) => set.slugByName[n])));
    assert(refused && new RegExp(`names ${READ_BATCH + 1} variants`).test(refused),
      `a call naming ${READ_BATCH + 1} variants at a BATCH of ${READ_BATCH} ${refused ? `failed with: ${refused}` : "was returned"}`);

    // A variant snap never measured is read by no slice, but counted in total.
    const extra = { ...set.componentSet, children: [...set.componentSet.children, { ...set.componentSet.children[0], name: "variant=ghost" }] };
    const { variants, total } = await readSet(readback, { ...set, componentSet: extra }, READ_BATCH);
    assert(total === Object.keys(variants).length + 1, `read ${Object.keys(variants).length} variants of a set of ${total}, which holds one more`);
    return `missing and doubled variants named, an empty call and one of ${READ_BATCH + 1} refused, an unmeasured variant counted in total`;
  });

  await check("a full slice of the template's BATCH fits in one use_figma response", async () => {
    // use_figma returns at most 20kb per call, and a string the plugin code
    // returns is JSON-encoded again on the way out. Price a full slice at the
    // largest variant the template read back, and leave room for what the
    // simulation lacks, longer variant names and Figma's float32 numbers (an
    // opacity of 0.4 reads back as 0.4000000059604645): at most 60% of it.
    const readback = loadSkillReadback();
    const { componentSet, slugByName, sourceBySlug } = simulatedSets(snapDir).find((s) => s.component.name === "Button");
    const all = await readback.read(componentSet, slugByName, sourceBySlug, { batch: componentSet.children.length });
    const sizes = Object.entries(all.readback).map(([slug, v]) => JSON.stringify(JSON.stringify({ [slug]: v })).length);
    const slice = readback.batch * Math.max(...sizes) + 200;
    assert(slice <= 12000, `${readback.batch} variants of up to ${Math.max(...sizes)} bytes come to ${slice}, too close to 20kb`);
    return `${readback.batch} variants ≈ ${(slice / 1000).toFixed(1)}kb, at up to ${Math.max(...sizes)} bytes a variant`;
  });

  await check("a slice too big for one use_figma response fails instead of being cut short", async () => {
    // Five copies of every Button variant under new names, read in one slice,
    // one variant more each time until the slice passes the guard.
    const readback = loadSkillReadback();
    const { componentSet, slugByName, sourceBySlug } = simulatedSets(snapDir).find((s) => s.component.name === "Button");
    const children = [];
    const names = {};
    const sources = {};
    for (let copy = 1; copy <= 5; copy++) {
      for (const child of componentSet.children) {
        const name = `${child.name}, copy=${copy}`;
        names[name] = `${slugByName[child.name]}--copy-${copy}`;
        sources[names[name]] = sourceBySlug[slugByName[child.name]];
        children.push({ ...child, name });
      }
    }
    const big = { ...componentSet, children };
    const order = Object.keys(names);
    return assertGuardRefuses((n, guarded) => {
      const named = order.slice(0, n);
      return readback.run(big, pick(names, named), pick(sources, named.map((name) => names[name])), { batch: n, guarded });
    }, children.length, /split its names across two calls/);
  });

  await check("every call that reads back a 256-variant set fits use_figma's code limit", async () => {
    // snap measures up to 256 combinations by default. Each call carries its
    // own slice of the two tables, so its code stays the same size however
    // big the set; tables for the whole set would pass 50,000 characters on
    // their own. At most 60% of the limit leaves room for longer names.
    const readback = loadSkillReadback();
    const set = await realisticSet(snapDir);
    const codes = [];
    const responses = [];
    const { variants, calls, total } = await readSet({
      ...readback,
      read: async (componentSet, slugTable, sourceTable, opts) => {
        codes.push(readback.code(componentSet.id, slugTable, sourceTable, opts).length);
        return readback.read(componentSet, slugTable, sourceTable, opts);
      },
    }, set, readback.batch, (slice) => responses.push(JSON.stringify(JSON.stringify(slice)).length));
    assert(total === 256 && Object.keys(variants).length === 256, `read ${Object.keys(variants).length} of ${total} variants`);
    const largest = Math.max(...codes);
    assert(largest <= CODE_LIMIT * 0.6, `a readback call's code is ${largest} characters, too close to use_figma's ${CODE_LIMIT}`);
    const whole = readback.code(set.componentSet.id, set.slugByName, set.sourceBySlug, { batch: 256 }).length;
    return `${calls} calls of up to ${largest} characters, returning up to ${Math.max(...responses)} encoded; ` +
      `the whole set's tables in one call would be ${whole}`;
  });

  await check("a part of a set built the way the skill says fits use_figma's code limit", async () => {
    // The skill builds a large set in parts. Price one part at the build
    // template with its table filled in with that many variants' names and
    // measured styles, written as the skill says, without the border and
    // borderRadius that borderUniform and borderRadiusUniform repeat, and its
    // properties table with the set's: the agent's own Plugin API code has to
    // fit in what is left, at least 15,000 characters, twice what a live
    // push's own came to. Priced at shadcn/ui's largest measured variant, the
    // part has to fit with that code under the length the skill says to
    // measure a part against, and where an agent keeps the repeats and passes
    // it, the smaller parts the skill then says to build in have to fit too.
    // Every part carries the layout, which lays out and checks the whole set,
    // so push all 256 variants through the simulated document too: each part
    // has to return counts small enough for one response, and leave every
    // variant in the grid of 4 rows of 64.
    const md = readFileSync(SKILL, "utf8");
    const part = Number(/in parts of at most (\d+) variants/.exec(md)?.[1]);
    assert(part > 0, "the skill gives no number of variants to build a set in parts of");
    const smaller = /if it passes ([\d,]+) characters, build that set in parts of (\d+) instead/.exec(md);
    assert(smaller, "the skill never says to build a set in smaller parts when a part's code is too long");
    const [threshold, fewer] = [Number(smaller[1].replace(/,/g, "")), Number(smaller[2])];
    assert(threshold < CODE_LIMIT && fewer < part, `the skill measures a part against ${threshold} and builds a long one in parts of ${fewer}`);
    const build = loadSkillBuild();
    assert(build.part === part, `the build template's PART is ${build.part}, but the skill says to build in parts of ${part}`);
    const set = await realisticSet(snapDir);
    const largest = set.styles.reduce((a, b) => (JSON.stringify(b).length > JSON.stringify(a).length ? b : a));
    const written = ({ border, borderRadius, ...rest }) => ({
      ...rest,
      ...(rest.borderUniform || border === undefined ? {} : { border }),
      ...(rest.borderRadiusUniform != null || borderRadius === undefined ? {} : { borderRadius }),
    });
    const constants = { PAGE_NAME: "Forms", SET_NAME: "Button", SET_ID: "12:34", PART: part };
    const names = Object.keys(set.slugByName);
    const price = (styles, n) => build.code(names.slice(0, n).map((name) => ({ name, styles })), constants, set.properties, { styled: false }).length;
    const code = price(written(largest), part);
    assert(code <= CODE_LIMIT - 15000, `${part} variants come to ${code} characters before the agent's own code, too close to ${CODE_LIMIT}`);
    const slim = price(written(SHADCN_COMMAND), part);
    assert(slim + AGENT_CODE <= threshold, `${part} of shadcn/ui's largest variants come to ${slim} characters, ${slim + AGENT_CODE} with a live push's own code, over ${threshold}`);
    const full = price(SHADCN_COMMAND, part);
    const lowered = price(SHADCN_COMMAND, fewer);
    assert(full + AGENT_CODE <= threshold || lowered + AGENT_CODE <= threshold,
      `${fewer} of shadcn/ui's largest variants, border and borderRadius kept, come to ${lowered + AGENT_CODE} characters with a live push's own code, over ${threshold}`);
    const whole = build.code(names.map((name) => ({ name, styles: largest })), constants, set.properties, { styled: false }).length;

    const doc = figmaDocument();
    const named = Object.keys(set.slugByName).map((name, i) => ({ name, styles: set.styles[i % set.styles.length] }));
    const parts = await pushSet(build, doc, { page: "Forms", set: "Button", variants: named, part, properties: set.properties });
    const response = Math.max(...parts.map((r) => JSON.stringify(JSON.stringify(r)).length));
    assert(response < 1000, `a part returns ${response} characters encoded: it should return counts, not names`);
    const last = parts[parts.length - 1];
    assert(parts.length === 11 && last.variants === 256 && last.rows === 4 && last.columns === 64 && last.extra === 0,
      `${parts.length} parts left ${last.variants} variants in ${last.rows} rows of ${last.columns}, ${last.extra} extra`);
    const [built] = doc.nodes("COMPONENT_SET");
    const panel = [...built.children].reverse().map((n) => n.name);
    assert(panel.join("\n") === named.map((v) => v.name).join("\n"), "the layers panel does not read in snap's order");
    assertLaidOut(built);
    return `${part} variants a call: ${code} characters before the agent's own code; ${slim} at shadcn/ui's largest, ${full} with its repeats ` +
      `(${lowered} in parts of ${fewer}); all 256 would be ${whole}; ` +
      `256 pushed in ${parts.length} parts returning up to ${response} encoded, laid out in 4 rows of 64`;
  });

  await check("pushing a set again updates its variants in place and adds none twice", async () => {
    // Every part of a second push finds the set an earlier one built and each
    // of its variants by name: it restyles those, adds only what the set
    // lacks, and leaves alone what snap no longer measures. Parts of 5 split
    // the Button's 12 variants 5, 5 and 2.
    const build = loadSkillBuild();
    const readback = loadSkillReadback();
    const { component, slugByName, sourceBySlug } = simulatedSets(snapDir).find((s) => s.component.name === "Button");
    const measured = expandVariants(component).map((v) => ({ name: figmaVariantName(v.combination), styles: v.styles }));
    const PART = 5;
    const doc = figmaDocument();
    const properties = component.variantProperties;
    const push = (variants, props = properties) =>
      pushSet(build, doc, { page: "Forms", set: "Button", variants, part: PART, properties: props });
    const sum = (parts, key) => parts.reduce((n, p) => n + p[key], 0);
    const theSet = ({ doubled = 0 } = {}) => {
      const sets = doc.nodes("COMPONENT_SET").filter((s) => s.name === "Button");
      assert(sets.length === 1, `the document holds ${sets.length} Button sets`);
      const names = sets[0].children.map((c) => c.name);
      const twice = names.filter((name, i) => names.indexOf(name) !== i);
      assert(twice.length === doubled, `the set holds ${twice.length} variants twice: ${twice.join("; ")}`);
      return sets[0];
    };

    const first = await push(measured);
    assert(first.length === 3 && sum(first, "added") === 12 && sum(first, "updated") === 0,
      `the first push made ${first.length} calls, adding ${sum(first, "added")} and updating ${sum(first, "updated")}`);
    const id = theSet().id;

    // The code changed every fill. The second push starts afresh, with no id.
    const restyled = measured.map((v) => ({ ...v, styles: { ...v.styles, backgroundColor: "#0f766e" } }));
    const second = await push(restyled);
    assert(sum(second, "added") === 0 && sum(second, "updated") === 12,
      `the second push added ${sum(second, "added")} and updated ${sum(second, "updated")} of 12`);
    const set = theSet();
    assert(set.id === id && set.children.length === 12, `the second push left set ${set.id} of ${set.children.length} variants, not ${id} of 12`);
    const { variants } = await readSet(readback, { componentSet: set, slugByName, sourceBySlug }, READ_BATCH);
    const stale = Object.entries(variants).filter(([, v]) => v.backgroundColor !== "#0f766e").map(([slug]) => slug);
    assert(stale.length === 0, `read back ${stale.length} variants with their old fill: ${stale.join(", ")}`);

    // A designer moved the set into a section: the next push finds it there,
    // rather than building a second set at the page's top level.
    const section = doc.container("SECTION", "Buttons", set.parent);
    section.appendChild(set);

    // snap dropped one variant and measured a new one: one part adds it, and
    // the one snap no longer has stays for step 6 to report.
    const dropped = measured[measured.length - 1].name;
    const added = { name: "variant=ghost, size=sm, disabled=false", styles: measured[0].styles };
    const ghost = properties.map((p) => (p.name === "variant" ? { ...p, values: [...p.values, "ghost"] } : p));
    const third = await push([...measured.slice(0, -1), added], ghost);
    assert(sum(third, "added") === 1 && sum(third, "updated") === 11,
      `with one variant dropped and one new, the push added ${sum(third, "added")} and updated ${sum(third, "updated")}`);
    const names = theSet().children.map((c) => c.name);
    assert(names.length === 13 && names.includes(dropped) && names.includes(added.name),
      `the set holds ${names.length} variants${names.includes(dropped) ? "" : `, without ${dropped}`}`);
    assert(theSet().id === id && theSet().parent === section, "the push moved or replaced the set in its section");

    // A part of more than PART variants or naming one twice, or a set an
    // older push left with a variant twice: refused before anything changes.
    const refusal = async (attempt, doubled = 0) => {
      const state = () => JSON.stringify(theSet({ doubled }).children.map((c) => [c.name, c.fills]));
      const before = state();
      let error = null;
      try {
        await attempt();
      } catch (err) {
        error = err;
      }
      assert(state() === before, "a refused part changed the set");
      return error?.message ?? null;
    };
    const purple = measured.map((v) => ({ ...v, styles: { ...v.styles, backgroundColor: "#7c3aed" } }));
    const oversized = await refusal(() =>
      build.run(doc.call(), purple.slice(0, PART + 1), { PAGE_NAME: "Forms", SET_NAME: "Button", SET_ID: null, PART }, properties));
    assert(oversized && new RegExp(`names ${PART + 1} variants`).test(oversized),
      `a part of ${PART + 1} variants at a PART of ${PART} ${oversized ? `failed with: ${oversized}` : "was built"}`);
    const repeated = await refusal(() => push([purple[0], purple[1], purple[0]]));
    assert(repeated && /twice/.test(repeated), `a part naming a variant twice ${repeated ? `failed with: ${repeated}` : "was built"}`);
    const copy = doc.call().createComponent();
    Object.assign(copy, figmaNode(measured[2].name, measured[2].styles));
    theSet().appendChild(copy);
    const doubled = await refusal(() => push(purple), 1);
    assert(doubled && doubled.includes(`2 variants named "${measured[2].name}"`), `a push onto a set holding a variant twice ${doubled ? `failed with: ${doubled}` : "was built"}`);

    // A second Button set in a frame on the page: the first part can't tell
    // which to update, so it refuses, naming both.
    const frame = doc.container("FRAME", "Archive", section.parent);
    const call = doc.call();
    const other = call.combineAsVariants([call.createComponent()], frame);
    other.name = "Button";
    let ambiguous = null;
    try {
      await push(purple);
    } catch (err) {
      ambiguous = err.message;
    }
    const sets = doc.nodes("COMPONENT_SET");
    const named = ambiguous?.match(/\d+:\d+/g) ?? [];
    assert(named.includes(id) && named.includes(other.id) && sets.length === 2,
      `a push onto a page holding two Button sets ${ambiguous ? `failed with: ${ambiguous}` : "was built"}, leaving ${sets.length} sets`);
    return `12 added, then 12 updated and none added, then 1 added beside 1 snap dropped with the set in a section; ` +
      `a part too big, one naming a variant twice, a doubled variant and two sets of its name refused`;
  });

  // The layout's checks, each run on the shipped build template and then on
  // every mutant of it below, each of which has to fail at least one.
  const layout = layoutScenarios(snapDir);

  await check("every part lays the set out in snap's order, whatever order its variants are in", async () => {
    // A re-push into a set an earlier build had left in another order laid it
    // out in that order: the primary row read sm, lg, sm disabled, lg disabled
    // and the others sm, sm disabled, lg disabled, lg. The layout orders the
    // set by the variantProperties snap records, each VARIANT's default first
    // and then Storybook's declared order, a BOOLEAN's default first, here
    // false: rows primary, danger and outline, columns sm, sm disabled, lg,
    // lg disabled, the layers panel reading the same way, and a variant snap
    // does not have in a row of its own below. With disabled defaulting to
    // true, its true column comes first, so Figma's default variant is the
    // component's; a VARIANT runs as PROPERTIES lists it, whatever its
    // defaultValue says; and Frozen's one property is a column of 3.
    const declared = layout.declared();
    const build = loadSkillBuild();
    return `${declared}; ${await layout.scrambled(build)}; ${await layout.defaults(build)}; ${await layout.frozen(build)}`;
  });

  await check("a set missing a row and a column, with extra variants and a variant twice, lays out the same on every part", async () =>
    layout.gaps(loadSkillBuild()));

  await check("a set with auto layout is refused before the part changes anything", async () =>
    layout.autoLayout(loadSkillBuild()));

  await check("a variant Figma leaves where it was fails the part", async () =>
    layout.ignored(loadSkillBuild()));

  await check("a set of 20 BOOLEAN properties lays out from its variants, not every combination", async () =>
    layout.booleans(loadSkillBuild()));

  await check("a set of very mixed sizes, and a variant 0 high, lays out with nothing overlapping or lost", async () =>
    layout.sizes(loadSkillBuild()));

  await check("a layout that gets the order, the spacing or a check wrong fails these checks", async () => {
    // Each mutant rewrites the shipped template, and has to fail a layout
    // check the template passes.
    const T = {
      sort: "cells.sort((a, b) => a.at[0] - b.at[0] || byColumn(a.at, b.at) || byId(a, b));",
      columns: "const columns = [...new Map(grid.map((c) => [c.key, c.at])).values()].sort(byColumn).map((at) => at.slice(1).join());",
      rows: "const rows = [...new Set(grid.map((c) => c.at[0]))];",
      values: "p.type !== 'BOOLEAN' ? p.values : p.defaultValue === 'true' ? ['true', 'false'] : ['false', 'true']",
      extras: "extra.sort((a, b) => (a.node.name > b.node.name) - (a.node.name < b.node.name) || byId(a, b));",
      target: "const target = order.map((c) => c.node).reverse();",
    };
    const between = (code, start, end) => {
      const from = code.indexOf(start);
      const to = code.indexOf(end, from);
      assert(from >= 0 && to > from, `the build template has no ${JSON.stringify(start)} … ${JSON.stringify(end)}`);
      return code.slice(0, from) + code.slice(to + end.length);
    };
    const mutants = {
      "lays the columns out in the set's child order, as the live push did": (code) => code
        .replace(T.sort, "cells.sort((a, b) => a.at[0] - b.at[0]);")
        .replace(T.columns, T.columns.replace(".sort(byColumn)", "")),
      "appends the variants first to last, so the layers panel reads bottom-up": (code) => code
        .replace(T.target, T.target.replace(".reverse()", "")),
      "spaces the variants 0 apart": (code) => code.replace("const GAP = 20;", "const GAP = 0;"),
      "keeps a row no variant fills": (code) => code.replace(T.rows, "const rows = axes[0][1].map((_, i) => i);"),
      "keeps a column no variant fills": (code) => code.replace(T.columns,
        "const columns = axes.slice(1).reduce((cols, [, values]) => cols.flatMap((col) => values.map((_, v) => [...col, v])), [[]]).map((at) => at.join());"),
      "leaves the extra row in the set's child order": (code) => code.replace(T.extras, ""),
      "takes each property's values default first": (code) => code.replace(T.values,
        "[p.defaultValue, ...p.values.filter((v) => v !== p.defaultValue)]"),
      "puts a BOOLEAN's true before its false": (code) => code.replace(": ['false', 'true']", ": ['true', 'false']"),
      "lays a BOOLEAN out false, true whatever its default": (code) => code.replace(T.values, "p.type === 'BOOLEAN' ? ['false', 'true'] : p.values"),
      "keeps whichever copy of a name comes first among the children in the grid": (code) => code
        .replace(T.sort, T.sort.replace(" || byId(a, b)", "")),
      "lays out a set with auto layout": (code) => between(code, "if (componentSet && PROPERTIES.length && componentSet.layoutMode !== 'NONE') {", "\n    }\n"),
      "never checks each variant is where the layout put it": (code) => between(code, "for (const c of order) {\n      if (Math.abs(", "\n    }\n"),
    };
    const failed = [];
    for (const [mutant, mutate] of Object.entries(mutants)) {
      const build = loadSkillBuild(mutate);
      let failure = null;
      for (const scenario of Object.values(layout)) {
        if (scenario === layout.declared) continue;
        try {
          await scenario(build);
        } catch (err) {
          failure = err.message;
          break;
        }
      }
      assert(failure, `a template that ${mutant} passed every layout check`);
      failed.push(mutant);
    }
    return `${failed.length} mutants fail`;
  });

  // What the build does besides the layout, each check run on the shipped
  // template and then on every mutant of it below.
  const builds = buildScenarios(snapDir);

  await check("a component with no variant properties is built as one plain component, read back and verified as its one variant", async () =>
    builds.plain(loadSkillBuild()));

  await check("a new set or component goes below what its page holds, one already placed stays, and each keeps its Storybook id and title", async () =>
    builds.placed(loadSkillBuild()));

  await check("a translucent color bound to a variable keeps its alpha in a fill, a stroke and a shadow", async () =>
    builds.painted(loadSkillBuild()));

  await check("a font Figma can't load gets a stand-in the part names, and a part that fails part way leaves nothing loose", async () =>
    builds.fonts(loadSkillBuild()));

  await check("a new set or component is found by name, then by id, and refuses another component's", async () =>
    builds.found(loadSkillBuild()));

  await check("a build that makes a set of no properties, stacks sets, takes the wrong set, drops an alpha or fails over a font fails these checks", async () => {
    // Each mutant rewrites the shipped build template, or the readback, and
    // has to fail one of the checks above, which the shipped ones pass.
    const T = {
      plain: "if (!PROPERTIES.length) {",
      place: "if (fresh) Object.assign(node, { name: SET_NAME, x: 0, y: below });",
      id: "node.setSharedPluginData('storysync', 'id', ID || '');",
      found: "const sets = named.length ? named : all.filter((n) => ID && idOf(n) === ID);",
      own: "(n.type === want || n.type === 'COMPONENT_SET' || idOf(n))",
      other: "componentSet && idOf(componentSet) && idOf(componentSet) !== ID ?",
      overlaps: "const overlaps = (node) => node.parent.children.filter(",
      restore: "      node[key] = node[key].map((p, i) => (!fx ? { ...p, opacity: raw[i].opacity } : !p.color || Math.abs(p.color.a - raw[i].color.a) < 0.002 ? p : raw[i]));\n",
      effect: "!p.color || Math.abs(p.color.a - raw[i].color.a) < 0.002 ? p : raw[i]",
      families: "for (const f of new Set([family, alt, 'Inter'])) {",
      serif: "? 'Noto Serif' :",
      ladder: "[i, i + d, i + 2 * d, 3]",
      clamp: "Math.min(8, Math.max(0, Math.round((weight || 400) / 100) - 1))",
      spelling: "new Set([STYLES[j], STYLES[j].replace(' ', '')])",
      named: "if (f !== family || j !== i) FONTS[family + ' ' + weight] = f + ' ' + s;",
      cleanup: "      for (const variant of created) variant.remove();\n",
      readPlain: "componentSet.type === 'COMPONENT' ? [componentSet] : componentSet.children",
    };
    const builds_ = {
      "builds a component with no variant properties as a set of one, as the live push did": (code) => code.replace(T.plain, "if (false) {"),
      "puts a new set at 0,0, on top of the page's others": (code) => code.replace(T.place, "if (fresh) node.name = SET_NAME;"),
      "moves and renames a set already on the page": (code) => code.replace(T.place, "Object.assign(node, { name: SET_NAME, x: 0, y: below });"),
      "keeps no Storybook id on what it builds": (code) => code.replace(T.id, ""),
      "finds an earlier set by its name alone": (code) => code.replace(T.found, "const sets = named;"),
      "matches a set by its name or its id at once, so a copy of one makes two": (code) => code.replace(T.found,
        "const sets = all.filter((n) => n.name === SET_NAME || (ID && idOf(n) === ID));"),
      "takes a designer's own plain component of the name for one a push built": (code) => code.replace(T.own, "(true)"),
      "overwrites another component's id on a set of its name": (code) => code.replace(T.other, "false ?"),
      "counts no overlaps": (code) => code.replace(T.overlaps, "const overlaps = (node) => [].filter("),
      "assigns a bound paint once, as the live push did": (code) => code.replace(T.restore, ""),
      "keeps a shadow bound whatever its alpha": (code) => code.replace(T.effect, "p"),
      "loads only the measured family": (code) => code.replace(T.families, "for (const f of [family]) {"),
      "sets a serif face in Inter": (code) => code.replace(T.serif, "? 'Inter' :"),
      "falls to Regular for a weight the family lacks": (code) => code.replace(T.ladder, "[i, 3]"),
      "indexes past Black for a weight over 900": (code) => code.replace(T.clamp, "Math.max(0, Math.round((weight || 400) / 100) - 1)"),
      "tries a style in Inter's spelling alone": (code) => code.replace(T.spelling, "[STYLES[j]]"),
      "names no stand-in": (code) => code.replace(T.named, ";"),
      "names a stand-in where only the spelling differs": (code) => code.replace(T.named,
        "if (f !== family || s !== STYLES[i]) FONTS[family + ' ' + weight] = f + ' ' + s;"),
      "leaves a failed part's new variants loose on the page": (code) => code.replace(T.cleanup, ""),
    };
    const readbacks = {
      "reads a plain component's layers as its variants": (code) => code.replace(T.readPlain, "componentSet.children"),
    };
    const failed = [];
    for (const [mutant, mutate] of Object.entries(builds_)) {
      const build = loadSkillBuild(mutate);
      let failure = null;
      for (const scenario of Object.values(builds)) {
        try {
          await scenario(build);
        } catch (err) {
          failure = err.message;
          break;
        }
      }
      assert(failure, `a build template that ${mutant} passed every check`);
      failed.push(mutant);
    }
    for (const [mutant, mutate] of Object.entries(readbacks)) {
      let failure = null;
      try {
        await builds.plain(loadSkillBuild(), loadSkillReadback(mutate));
      } catch (err) {
        failure = err.message;
      }
      assert(failure, `a readback that ${mutant} passed`);
      failed.push(mutant);
    }
    return `${failed.length} mutants fail`;
  });

  await check("the set's variant names are listed a slice at a time, within both limits", async () => {
    // When the readback's slices add up to fewer than total, the skill lists
    // the set's names and compares them with snap's. The 256 measured
    // variants, with variants snap no longer has, make a set that ends
    // exactly on a slice, so a call past the last slice is one too many, and
    // one that ends part way through a slice, which must still be listed.
    const code = useFigmaBlock(/^List the variant names/);
    const batch = Number(/const BATCH = (\d+);/.exec(code)?.[1]);
    assert(batch > 0, "the name listing defines no BATCH");
    const set = await realisticSet(snapDir);
    const measured = new Set(Object.keys(set.slugByName));
    const retiredTo = (total) => Array.from({ length: total - 256 }, (_, i) => `variant=retired-${i}, size=medium, state=default, iconPlacement=without-icon`);
    const setOf = (total) => ({ ...set.componentSet, children: [...set.componentSet.children, ...retiredTo(total).map((name) => ({ name }))] });
    const all = Math.ceil(259 / batch) * batch;
    const listings = [];
    const sizes = [];
    let componentSet = null;
    const figmaFor = () => ({ getNodeByIdAsync: async (id) => (id === componentSet.id ? componentSet : null) });
    for (const total of [all, 259]) {
      const retired = retiredTo(total);
      componentSet = setOf(total);
      const { children } = componentSet;
      const read = await readAllSlices(code, figmaFor, { SET_ID: componentSet.id });
      for (const slice of read) sizes.push(JSON.stringify(JSON.stringify(slice)).length);
      assert(read.length === Math.ceil(total / batch), `listed ${total} names in ${read.length} calls, with BATCH ${batch}`);
      const listed = read.flatMap((s) => s.names);
      assert(listed.join("\n") === children.map((c) => c.name).join("\n") && read.every((s) => s.total === total),
        `listed ${listed.length} names of ${total}`);
      const extra = listed.filter((name) => !measured.has(name));
      assert(extra.join("\n") === retired.join("\n"), `found ${extra.length} names snap does not have, not the ${retired.length} retired`);
      listings.push(`${total} in ${read.length} calls, ${extra.length} snap does not have`);
    }

    // The larger set's names in one call would not come back whole.
    componentSet = setOf(all);
    const one = await new AsyncFunction("figma", withConstants(liftGuard(code), { SET_ID: componentSet.id, START: 0, BATCH: all }))(figmaFor());
    assert(JSON.stringify(one).length > GUARD, `all ${all} names in one call come to ${JSON.stringify(one).length} encoded, under the guard`);

    // Names of about 130 characters, four properties with long values.
    const long = Array.from({ length: 200 }, (_, i) => ({
      name: `variant=destructive-action-${String(i).padStart(3, "0")}, size=extra-large-touch-target, state=focus-visible-pressed, iconPlacement=trailing-icon-with-badge`,
    }));
    const longSet = { id: "set:Long", type: "COMPONENT_SET", name: "Long", children: long };
    const refused = await assertGuardRefuses((n, guarded) => {
      const body = withConstants(guarded ? code : liftGuard(code), { SET_ID: longSet.id, START: 0, BATCH: n });
      return new AsyncFunction("figma", body)({ getNodeByIdAsync: async () => longSet });
    }, long.length);
    return `${listings.join("; ")}; calls return up to ${Math.max(...sizes)} encoded, ` +
      `all ${all} in one would be ${JSON.stringify(one).length}; ${refused}`;
  });

  await check("the label call keeps a designer's description and changes only its own line", async () => {
    // A plain assignment replaced whatever a designer had written on a set,
    // and nothing took the label off once the component was measured open.
    const code = useFigmaBlock(/^Label the sets measured from/);
    assert(code.length < 4000, `the label template is ${code.length} characters`);
    const NL = "\n";
    const nodes = {
      "1:1": describedNode("1:1", "COMPONENT_SET", { text: "Use for the main action." }),
      "1:2": describedNode("1:2", "COMPONENT_SET", { text: `Use for the main action.${NL}storysync: measured from its closed trigger, button, not the open dialog` }),
      "1:3": describedNode("1:3", "COMPONENT"),
      "1:4": describedNode("1:4", "COMPONENT_SET", { text: "storysync: measured from its closed trigger, button, not the open dialog" }),
      "1:5": describedNode("1:5", "COMPONENT_SET"),
      "1:6": describedNode("1:6", "FRAME"),
    };
    const run = labelCall(code, nodes);
    const trigger = "measured from its closed trigger, button[data-slot=\"dialog-trigger\"], not the open dialog";
    const wrapper = "measured from what may be its story's layout wrapper, div, not Switch";
    const notes = { "1:1": trigger, "1:2": trigger, "1:3": wrapper, "1:4": "", "1:5": "" };

    const first = await run(notes);
    const expected = {
      "1:1": `Use for the main action.${NL}storysync: ${trigger}`,
      "1:2": `Use for the main action.${NL}storysync: ${trigger}`,
      "1:3": `storysync: ${wrapper}`,
      "1:4": "",
      "1:5": "",
    };
    for (const [id, text] of Object.entries(expected)) {
      assert(nodes[id].stored.text === text, `${id} has ${JSON.stringify(nodes[id].stored.text)}, expected ${JSON.stringify(text)}`);
    }
    assert(first.changed.join() === "1:1,1:2,1:3,1:4", `changed ${first.changed.join()}`);
    // Run again, it changes nothing, and adds no second line.
    const again = await run(notes);
    assert(again.changed.length === 0, `a second run changed ${again.changed.join()}`);
    // Measured open, the set loses the line and keeps the designer's.
    await run({ "1:1": "" });
    assert(nodes["1:1"].stored.text === "Use for the main action.", `1:1 kept ${JSON.stringify(nodes["1:1"].stored.text)}`);
    // Anything but a component set or component is refused.
    for (const id of ["1:6", "9:9"]) {
      let refused = false;
      try { await run({ [id]: trigger }); } catch { refused = true; }
      assert(refused, `labeled ${id}, which is no component set`);
    }
    return `${code.length} characters`;
  });

  await check("the label call reads Figma's escaped description once, keeps a designer's formatting, and changes nothing a second time", async () => {
    // Figma returns a description HTML-escaped. Read and written back as it
    // came, a live push turned Dialog's note into
    // button[data-slot=&quot;dialog-trigger&quot;], escaped once more on
    // every push, and a second run reported it changed again.
    const code = useFigmaBlock(/^Label the sets measured from/);
    const NL = "\n";
    const designer = `Use "primary" & <b>bold</b> for the main action.`;
    const trigger = "measured from its closed trigger, button[data-slot=\"dialog-trigger\"], not the open dialog";
    // The stand-in escapes as Figma does: a template that writes back what it
    // read gains an escape on every run here.
    const naive = describedNode("0:1", "COMPONENT_SET", { text: designer });
    for (let i = 0; i < 2; i++) naive.description = naive.description;
    assert(naive.stored.text.includes("&amp;quot;"), `the stand-in doesn't escape as Figma does: ${naive.stored.text}`);

    const results = [];
    for (const escapeMarkdown of [false, true]) {
      const nodes = {
        "2:1": describedNode("2:1", "COMPONENT_SET", { text: designer }),
        "2:2": describedNode("2:2", "COMPONENT_SET", { markdown: `**Use** "primary" & keep _this_ for the main action.`, escapeMarkdown }),
        "2:3": describedNode("2:3", "COMPONENT", { text: `${designer}${NL}storysync: ${trigger}` }),
      };
      const run = labelCall(code, nodes);
      const notes = { "2:1": trigger, "2:2": trigger, "2:3": "" };
      const first = await run(notes);
      assert(first.changed.join() === "2:1,2:2,2:3", `changed ${first.changed.join()}`);
      for (let i = 0; i < 3; i++) {
        const again = await run(notes);
        assert(again.changed.length === 0, `run ${i + 2} changed ${again.changed.join()} again`);
      }
      assert(nodes["2:1"].stored.text === `${designer}${NL}storysync: ${trigger}`, `2:1 holds ${JSON.stringify(nodes["2:1"].stored.text)}`);
      assert(nodes["2:3"].stored.text === designer, `2:3 holds ${JSON.stringify(nodes["2:3"].stored.text)}`);
      // The designer's bold and italic stay, and the note shows as written.
      const bs = "\\";
      assert(nodes["2:2"].stored.markdown === `**Use** "primary" & keep _this_ for the main action.${NL}storysync: measured from its closed trigger, button${bs}[data-slot="dialog-trigger"${bs}], not the open dialog`,
        `2:2's markdown is ${JSON.stringify(nodes["2:2"].stored.markdown)}`);
      assert(nodes["2:2"].stored.text.endsWith(`storysync: ${trigger}`), `2:2 shows ${JSON.stringify(nodes["2:2"].stored.text)}`);
      results.push(escapeMarkdown ? "escaped markdown" : "plain markdown");
    }
    return `no escape added over four runs, with Figma's markdown read as ${results.join(" and as ")}`;
  });

  await check("the label call removes Figma's empty Page 1, keeps one a designer used, or the only page, and leaves the user where they were", async () => {
    // A live push left Page 1 empty beside the pages it made, and didn't say.
    // And the call switched to Page 1 to load it, and stayed, so the user's
    // view jumped at the end of every push.
    const code = useFigmaBlock(/^Label the sets measured from/);
    const set = describedNode("3:1", "COMPONENT_SET");
    const outcome = async (pages, current, refuse = false) => {
      const doc = labelPages(pages, current);
      if (refuse) doc.pages.find((p) => p.name === "Page 1").remove = () => { throw new Error("Cannot remove this page"); };
      const result = await labelCall(code, { "3:1": set }, doc.figma)({ "3:1": "" });
      return { pageOne: result.pageOne, left: doc.pages.map((p) => p.name).join(), on: doc.figma.currentPage.name };
    };
    // Each: the pages, the one the user is on, what the call returns, the
    // pages left and the one the user is on after.
    const cases = [
      [[["Page 1", 0], ["ui/base", 1]], 1, "removed", "ui/base", "ui/base"],
      // On Page 1, the user is moved off it to remove it.
      [[["Page 1", 0], ["ui/base", 1]], 0, "removed", "ui/base", "ui/base"],
      // Not loaded yet, it lists no layers: the call has to load it to see them.
      [[["ui/base", 1], ["Page 1", 2]], 0, "kept: it holds layers", "ui/base,Page 1", "ui/base"],
      [[["Page 1", 0]], 0, "kept: it is the only page", "Page 1", "Page 1"],
      [[["Cover", 0], ["ui/base", 1]], 1, "none", "Cover,ui/base", "ui/base"],
    ];
    for (const [pages, current, pageOne, left, on] of cases) {
      const got = await outcome(pages, current);
      const want = { pageOne, left, on };
      assert(JSON.stringify(got) === JSON.stringify(want), `pages ${JSON.stringify(pages)}, on ${pages[current][0]}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    }
    // A removal Figma refuses is said, after the labels, rather than lost in
    // a throw, and the user is left on the page they were on.
    const refusal = "kept: Figma refused to remove it (Cannot remove this page)";
    for (const [current, on] of [[0, "Page 1"], [1, "ui/base"]]) {
      const got = await outcome([["Page 1", 0], ["ui/base", 1]], current, true);
      const want = { pageOne: refusal, left: "Page 1,ui/base", on };
      assert(JSON.stringify(got) === JSON.stringify(want), `a refused removal, on ${on}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    }
    return cases.map(([, , pageOne]) => pageOne).join("; ") + "; " + refusal + ", the user left where they were each time";
  });

  heading("Readback checksums");

  await check("the template's checksums survive any layout of the file, and cover what each call returns", () => assertSealed(snapDir));

  await check("a variant with no text child or no auto layout reads null there: a match where snap measured none, drift where it measured some", () =>
    assertNullsScored(snapDir));

  await check("a readback rebuilt from snap's values, as the live push wrote it, is flagged on every variant and fails --strict", () =>
    assertComposedFlagged(snapDir));

  await check("a color edited in the readback after Figma returned it is flagged on exactly that variant", () => assertEditFlagged(snapDir));

  await check("an entry copied onto the same slug in another component is flagged on exactly that one", () => assertCopyFlagged(snapDir));

  await check("a whole component copied onto another, nodeId and all, is flagged on every entry of both and fails --strict", () =>
    assertBlockCopyFlagged(snapDir));

  await check("a readback read with the template cut down to source, width and height is flagged incomplete and fails --strict", () =>
    assertTrimmedFlagged(snapDir));

  await check("a readback read with the template's text fields and gap removed is flagged incomplete and fails --strict", () =>
    assertTypelessFlagged(snapDir));

  await check("a readback read before the snap is flagged stale and fails --strict, allowing a couple of minutes for the clocks", () =>
    assertStaleFlagged(snapDir));

  await check("a readback sealed another way, or a verify that skips a readback check, fails these checks", async () => {
    // Each template mutant rewrites the shipped readback template, and each
    // verify mutant a copy of the built verify.js, or of the module verify
    // takes a function from (checksum.js, for canonicalJson); every one has
    // to fail the checks above, which the shipped pair passes.
    const SEALED = "const text = canon({ [setId]: { [slug]: entry } });";
    const READ = "const entry = JSON.parse(JSON.stringify(Object.assign({}, fields, { readAt: new Date().toISOString() })));";
    const templateMutants = {
      "leaves a field out of the checksum": (code) => code.replace(SEALED,
        "const { width: _, ...rest } = entry;\n      const text = canon({ [setId]: { [slug]: rest } });"),
      "checksums the entry without its slug": (code) => code.replace(SEALED, "const text = canon({ [setId]: entry });"),
      "checksums the entry without its set's id": (code) => code.replace(SEALED, "const text = canon({ [slug]: entry });"),
      "keeps each object's keys in the order they were written": (code) => code.replace("Object.keys(v).sort()", "Object.keys(v)"),
      "checksums the fields before they pass through JSON": (code) => code.replace(READ,
        "const entry = Object.assign({}, fields, { readAt: new Date().toISOString() });"),
      "seals no readAt into the entry": (code) => code.replace(READ, "const entry = JSON.parse(JSON.stringify(fields));"),
      "leaves readAt out of the checksum": (code) => code.replace(SEALED,
        "const { readAt: _, ...rest } = entry;\n      const text = canon({ [setId]: { [slug]: rest } });"),
      "is cut down to source, width and height": cutDown,
      "leaves out the text child's fields and gap": withoutTypeOrGap,
      "leaves the text fields out where there is no text child, as it used to": (code) => code
        .replace("fontSize: text && typeof text.fontSize === 'number' ? text.fontSize : null,", "fontSize: text ? text.fontSize : undefined,")
        .replace("fontWeight: font ? weightOf(font.style) : null,", "fontWeight: text ? weightOf(text.fontName.style) : undefined,")
        .replace("fontFamily: font ? font.family : null,", "fontFamily: text ? text.fontName.family : undefined,"),
      "leaves gap out on a frame without auto layout, as it used to": (code) => code.replace(
        "? { row: child.itemSpacing, column: child.itemSpacing }\n          : null,", "? { row: child.itemSpacing, column: child.itemSpacing }\n          : undefined,"),
      "reads a mixed font's weight as 400": (code) => code.replace("fontWeight: font ? weightOf(font.style) : null,",
        "fontWeight: text ? weightOf(font && font.style) : null,"),
    };
    const verifyMutants = {
      "ignores the checksum": (src) => src.replace("const readbackIssues = checkReadback(readback, options);", "const readbackIssues = [];"),
      "passes an entry with no checksum": (src) => src.replace('issues.push({ component, slug, problem: "no_checksum" });', ";"),
      "flags an entry but scores it anyway": (src) => src.replace("? unverifiedVerdict(component, slug, figma)",
        '? { ...verifyVariant(component, slug, measured, figma, tolerance), status: "unverified_readback" }'),
      "keeps each object's keys in the order the file wrote them": {
        file: "checksum.js", mutate: (src) => src.replace("Object.keys(record).sort()", "Object.keys(record)"),
      },
      "checks a checksum under the slug alone, not the set's id": (src) => src.replace(
        "canonicalJson({ [setId]: { [slug]: JSON.parse(JSON.stringify(rest)) } })", "canonicalJson({ [slug]: JSON.parse(JSON.stringify(rest)) })"),
      "does not require the fields the template always returns": (src) => src.replace(
        "const missing = missingReadbackFields(fields);", "const missing = [];"),
      "lets an entry leave out the text fields and gap, as before": (src) => src.replace(
        '"fontSize", "fontWeight", "fontFamily", "gap", "opacity"', '"opacity"'),
      "never compares one component's nodeId with another's": (src) => src.replace("if (sharedWith.length > 0) {", "if (false) {"),
      "scores a null text field as a match whether or not snap measured text": (src) => src.replace(
        "figmaValue == null && measuredText == null", "figmaValue == null"),
      "scores a null gap as a match against any measured gap": (src) => src.replace(
        "if (isAbsentOrZeroRecord(measured) && isAbsentOrZeroRecord(figma))", "if (figma == null || (isAbsentOrZeroRecord(measured) && isAbsentOrZeroRecord(figma)))"),
      "never compares readAt with the snap's time": (src) => src.replace("read < measured - READ_AT_SKEW_MS", "false"),
      "allows no difference between the two clocks": (src) => src.replace("read < measured - READ_AT_SKEW_MS", "read < measured"),
    };
    const every = (opts) => [
      () => assertSealed(snapDir, opts), () => assertNullsScored(snapDir, opts), () => assertComposedFlagged(snapDir, opts), () => assertEditFlagged(snapDir, opts),
      () => assertCopyFlagged(snapDir, opts), () => assertBlockCopyFlagged(snapDir, opts), () => assertTrimmedFlagged(snapDir, opts),
      () => assertTypelessFlagged(snapDir, opts), () => assertStaleFlagged(snapDir, opts),
    ];
    for (const run of every({ bin: mutantCli(null) })) await run();
    const survived = [];
    for (const [name, mutate] of Object.entries(templateMutants)) {
      const template = loadSkillReadback(mutate);
      if (!(await fails([() => assertSealed(snapDir, { template }), () => assertNullsScored(snapDir, { template })]))) survived.push(`a template that ${name}`);
    }
    for (const [name, mutant] of Object.entries(verifyMutants)) {
      const { file, mutate } = typeof mutant === "function" ? { file: "verify.js", mutate: mutant } : mutant;
      if (!(await fails(every({ bin: mutantCli(mutate, file) })))) survived.push(`a verify that ${name}`);
    }
    assert(survived.length === 0, `these pass every checksum check:\n${survived.join("\n")}`);
    return `${Object.keys(templateMutants).length} template and ${Object.keys(verifyMutants).length} verify mutants fail; an unchanged copy of the build passes`;
  });

  heading("Audit through the shipped skill template");

  await check("the audit reads every variable a slice at a time, and refuses a slice too big to return", async () => {
    const code = useFigmaBlock(/^Read all variable collections/);
    const batch = Number(/const BATCH = (\d+);/.exec(code)?.[1]);
    assert(batch > 0, "the variables read defines no BATCH");
    // Two collections, read across calls. One palette ends exactly on a
    // slice, so a call past the last one would be one too many; the other
    // ends part way through one, so a short last slice must still be read.
    const palette = (length) => Array.from({ length }, (_, i) => (i < length - 50
      ? { collection: "Colors", name: `color/palette-${Math.floor(i / 10)}/${(i % 10 + 1) * 100}`, type: "COLOR", value: { r: (i % 7) / 7, g: (i % 5) / 5, b: (i % 3) / 3, a: 1 } }
      : { collection: "Spacing", name: `space/${i - (length - 50)}`, type: "FLOAT", value: (i - (length - 50)) * 4 }));
    const counts = [];
    for (const length of [2 * batch, 2 * batch + Math.ceil(batch / 2)]) {
      const variables = palette(length);
      const read = await readAllSlices(code, () => variablesFigma(variables));
      const names = read.flatMap((s) => s.variables.map((v) => `${v.collection}/${v.name}`));
      assert(new Set(names).size === length && names.length === length && read.every((s) => s.total === length),
        `read ${names.length} variables (${new Set(names).size} distinct) of ${length}`);
      assert(read.length === Math.ceil(length / batch), `read ${length} variables in ${read.length} calls, with BATCH ${batch}`);
      counts.push(`${length} in ${read.length} calls`);
    }

    const long = Array.from({ length: 400 }, (_, i) => ({
      collection: "Semantic colors", name: `color/semantic/interactive/surface-${i}/background-hover-pressed`, type: "COLOR", value: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
    }));
    const refused = await assertGuardRefuses((n, guarded) => {
      const body = withConstants(guarded ? code : liftGuard(code), { START: 0, BATCH: n });
      return new AsyncFunction("figma", body)(variablesFigma(long));
    }, long.length);
    return `${counts.join(", ")}; ${refused}`;
  });

  await check("the audit's variables read returns each collection's modes once, for the summary to name the ones not compared", async () => {
    // It reads each collection's first mode, and an audit of shadcn/ui said
    // "39 matched" with no word of a Dark mode it never compared.
    const code = useFigmaBlock(/^Read all variable collections/);
    const batch = Number(/const BATCH = (\d+);/.exec(code)?.[1]);
    const variables = Array.from({ length: batch + 3 }, (_, i) => (i < batch
      ? { collection: "Colors", name: `color/${i}`, type: "COLOR", value: { r: 0, g: 0, b: 0, a: 1 } }
      : { collection: "Radius", name: `radius/${i}`, type: "FLOAT", value: i }));
    const read = await readAllSlices(code, () => variablesFigma(variables, { Colors: ["Light", "Dark"] }));
    assert(read.length === 2, `read in ${read.length} calls`);
    assert(JSON.stringify(read[0].modes) === JSON.stringify([{ collection: "Colors", modes: ["Light", "Dark"] }, { collection: "Radius", modes: ["Default"] }]),
      `the first slice returns modes ${JSON.stringify(read[0].modes)}`);
    assert(read.slice(1).every((slice) => slice.modes === undefined), "a later slice returns the modes again");
    return "Colors: Light, Dark; Radius: Default, on the first of 2 slices";
  });

  await check("the audit reads the component sets on every page, not only the one loaded first", async () => {
    // The push puts each Storybook category on its own page. use_figma loads
    // a page only when a call switches to it, so a search from figma.root
    // would see the first page's sets, and only the first page's, from every
    // call. Each page's call has to return that page's sets and no other's.
    // Forms holds more sets than one call returns, so the read goes on from
    // each slice's next.
    const code = useFigmaBlock(/^Read the component sets/);
    const forms = Array.from({ length: 120 }, (_, i) => auditSet(`Field${i}`, { size: ["sm", "md", "lg"], disabled: "BOOLEAN" }));
    const pages = [
      { id: "0:1", name: "Forms", sets: forms },
      { id: "0:2", name: "Navigation", sets: [auditSet("Tabs", { variant: ["line", "pill"] }), auditSet("Breadcrumb", { size: ["sm", "md"] })] },
      { id: "0:3", name: "Archive", sets: [] },
    ];
    const found = [];
    const calls = [];
    for (const page of pagesFigma(pages).root.children) {
      const read = await readAllSlices(code, () => {
        const switches = [];
        const figma = pagesFigma(pages, switches);
        // Figma's own guidance: switch page at most once per call.
        const original = figma.setCurrentPageAsync;
        figma.setCurrentPageAsync = async (p) => {
          assert(switches.length === 0, `a call switched pages ${switches.length + 1} times`);
          return original(p);
        };
        return figma;
      }, { PAGE_ID: page.id });
      assert(read.every((slice) => slice.page === page.name), `a call for ${page.name} read ${read.map((slice) => slice.page).join(", ")}`);
      for (const slice of read) found.push(...slice.components.map((s) => `${page.name}/${s.name}`));
      calls.push(`${page.name} in ${read.length}`);
    }
    assert(/^Forms in [2-9]/.test(calls[0]), `read Forms' ${forms.length} sets in one call: the check never reads on from next`);
    const expected = pages.flatMap((p) => p.sets.map((s) => `${p.name}/${s.name}`));
    assert(found.join() === expected.join(), `read ${found.length} sets (${found.slice(0, 3).join(", ")}...), expected ${expected.length} across ${pages.length} pages`);
    return `${found.length} sets across ${pages.length} pages, ${calls.join(", ")} calls`;
  });

  await check("the audit reads as many components a call as fit under 20kb, and refuses one too big alone", async () => {
    // At 25 a call, an icon library's page of a few hundred plain components
    // took a call per 25, each counting toward Figma's MCP rate limits,
    // though one entry is a hundred or so characters. Each call takes what
    // fits under the guard, as use_figma encodes it, and no less.
    const code = useFigmaBlock(/^Read the component sets/);
    const options = Array.from({ length: 12 }, (_, i) => `option-with-a-long-descriptive-name-${i}`);
    const page = () => [
      ...Array.from({ length: 400 }, (_, i) => auditComponent(`Icon/"quoted"/arrow-${i}`)),
      ...Array.from({ length: 40 }, (_, i) => auditSet(`Wide${i}`, { appearance: options, emphasis: options.slice(0, 6), disabled: "BOOLEAN" })),
    ];
    const read = async (mutate = null) => {
      const run = mutate ? mutate(code) : code;
      assert(run !== code || !mutate, "a mutant of the component read changed nothing in it");
      const pages = [{ id: "0:1", name: "Icons", sets: page() }];
      return readAllSlices(run, () => pagesFigma(pages), { PAGE_ID: "0:1" });
    };
    const encoded = (slice) => JSON.stringify(JSON.stringify(slice)).length;
    const assertSlices = (slices) => {
      const names = slices.flatMap((slice) => slice.components.map((c) => c.name));
      assert(names.length === 440 && new Set(names).size === 440, `read ${names.length} components (${new Set(names).size} distinct) of 440`);
      for (const [i, slice] of slices.entries()) {
        assert(encoded(slice) <= GUARD, `slice ${i + 1} is ${encoded(slice)} characters encoded, over the ${GUARD} guard`);
        const after = slices[i + 1];
        if (!after) continue;
        // One more entry would have passed the guard, or the call stopped short.
        const more = { ...slice, next: after.components.length > 1 || after.next !== null ? slice.next + 1 : null, components: [...slice.components, after.components[0]] };
        assert(encoded(more) > GUARD, `slice ${i + 1} stopped at ${slice.components.length} entries, ${encoded(slice)} characters encoded, with room for the next`);
      }
    };
    const slices = await read();
    assertSlices(slices);
    assert(slices.length <= 8, `read 440 components in ${slices.length} calls`);

    // One set too big for any call alone is refused, by name, not returned
    // past 20kb, and not skipped without a word.
    const huge = auditSet("Glyph", { glyph: Array.from({ length: 2000 }, (_, i) => `glyph-${i}`) });
    const hugePages = [{ id: "0:1", name: "Icons", sets: [auditComponent("Before"), huge, auditComponent("After")] }];
    const first = JSON.parse(await new AsyncFunction("figma", withConstants(code, { PAGE_ID: "0:1", START: 0 }))(pagesFigma(hugePages)));
    assert(first.components.map((c) => c.name).join() === "Before" && first.next === 1, `the slice before the huge set came back as ${JSON.stringify(first).slice(0, 200)}`);
    let refused = null;
    try {
      await new AsyncFunction("figma", withConstants(code, { PAGE_ID: "0:1", START: 1 }))(pagesFigma(hugePages));
    } catch (err) {
      refused = err.message;
    }
    assert(refused && /"Glyph" alone/.test(refused) && /START \+ 1/.test(refused), `the huge set ${refused ? `failed with: ${refused}` : "was returned"}`);

    const count = await assertMutantsFail({
      "measures the slice before use_figma encodes it": (c) => c.replace("if (JSON.stringify(slice([...results, entry], next)).length > 17000) break;", "if (slice([...results, entry], next).length > 17000) break;"),
      "takes 25 a call, as it did": (c) => c.replace("if (JSON.stringify(slice([...results, entry], next)).length > 17000) break;", "if (JSON.stringify(slice([...results, entry], next)).length > 17000 || end - START >= 25) break;"),
      "takes one entry past the guard": (c) => c.replace("if (JSON.stringify(slice([...results, entry], next)).length > 17000) break;", "if (JSON.stringify(slice(results, next)).length > 17000) break;"),
    }, read, assertSlices);
    return `440 components in ${slices.length} calls, each under ${GUARD} encoded and full; a set too big alone refused; ${count} mutants fail`;
  });

  /**
   * Runs the component read, or a mutant of it, over one page, from START 0
   * to the last slice, and returns its entries. A mutation that changes
   * nothing is a mistake in the check, not a mutant.
   */
  async function auditPage(sets, mutate = null) {
    const shipped = useFigmaBlock(/^Read the component sets/);
    const code = mutate ? mutate(shipped) : shipped;
    assert(code !== shipped || !mutate, "a mutant of the component read changed nothing in it");
    const pages = [{ id: "0:1", name: "ui/base", sets }];
    const read = await readAllSlices(code, () => pagesFigma(pages), { PAGE_ID: "0:1" });
    return read.flatMap((slice) => slice.components);
  }

  /** Throws unless every mutant, run through `assertOk`, fails it. Returns how many did. */
  async function assertMutantsFail(mutants, run, assertOk) {
    const survived = [];
    for (const [name, mutate] of Object.entries(mutants)) {
      let failure = null;
      try {
        assertOk(await run(mutate));
      } catch (err) {
        failure = err;
      }
      if (!failure || /changed nothing/.test(failure.message)) survived.push(`a read that ${name}${failure ? ` (${failure.message})` : ""}`);
    }
    assert(survived.length === 0, `these pass the check:\n${survived.join("\n")}`);
    return Object.keys(mutants).length;
  }

  await check("the audit reads the components outside any set, not a set's variants, and the Storybook ID the push stored", async () => {
    // The push makes a component with no variant properties a plain
    // component, since a set of one variant named "" is one Figma flags as
    // errored, and stores each component's Storybook ID on what it makes.
    // Read for sets only, the audit never saw those components; read for
    // every component, it would take each variant for one.
    const sets = () => [
      auditSet("Button", { size: ["sm", "lg"], disabled: "BOOLEAN" }, { storybookId: "ui-base-button" }),
      auditComponent("Badge", { storybookId: "ui-base-badge" }),
      auditFrame("Icons", [auditComponent("Calendar")]),
    ];
    const assertRead = (entries) => {
      const got = entries.map((e) => [e.name, e.type, e.storybookId, e.variantCount, e.variantProperties.map((p) => `${p.name}:${p.values.join("|")}`).join(",")]);
      const want = [
        ["Button", "COMPONENT_SET", "ui-base-button", 4, "size:sm|lg,disabled:true|false"],
        ["Badge", "COMPONENT", "ui-base-badge", 1, ""],
        ["Calendar", "COMPONENT", null, 1, ""],
      ];
      assert(JSON.stringify(got) === JSON.stringify(want), `read ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      assert(entries.every((e) => /^9:\d+$/.test(e.nodeId) && e.error === undefined), `read ${JSON.stringify(entries)}`);
    };
    assertRead(await auditPage(sets()));
    const mutants = {
      "finds component sets only, as it did": (code) => code.replace("types: ['COMPONENT_SET', 'COMPONENT']", "types: ['COMPONENT_SET']"),
      "takes a set's variants for components": (code) => code.replace(".filter(n => n.type === 'COMPONENT_SET' || (n.parent && n.parent.type !== 'COMPONENT_SET'))", ""),
      "leaves out the Storybook ID the push stored": (code) => code.replace("node.getSharedPluginData('storysync', 'id') || null", "null"),
    };
    const count = await assertMutantsFail(mutants, (mutate) => auditPage(sets(), mutate), assertRead);
    return `2 components and a set, no variants, with their IDs; ${count} mutants fail`;
  });

  await check("the audit reports a set Figma flags as errored, and reads on through the rest of its page", async () => {
    // The live push's sets of one variant named "", which Figma renames "="
    // and flags as errored: reading their componentPropertyDefinitions
    // threw "Component set has existing errors", and the audit lost every
    // set on the page.
    const sets = () => [
      auditSet("Avatar", { size: ["sm", "lg"] }),
      auditSet("Button", { "": [""] }, { errored: true }),
      auditSet("Card", { elevated: "BOOLEAN" }),
      auditComponent("Separator"),
    ];
    const assertRead = (entries) => {
      assert(JSON.stringify(entries.map((e) => e.name)) === JSON.stringify(["Avatar", "Button", "Card", "Separator"]), `read ${entries.map((e) => e.name).join(", ")}`);
      const errored = entries[1];
      assert(/Component set has existing errors/.test(errored.error ?? ""), `the errored set came back as ${JSON.stringify(errored)}`);
      assert(errored.variantProperties.length === 0 && /^9:\d+$/.test(errored.nodeId), `the errored set came back as ${JSON.stringify(errored)}`);
      assert(entries[0].variantProperties.length === 1 && entries[2].variantProperties.length === 1 && entries.filter((e) => e.error !== undefined).length === 1,
        `the sets beside it came back as ${JSON.stringify(entries)}`);
    };
    const shipped = await auditPage(sets());
    assertRead(shipped);
    const errored = shipped[1];
    const mutants = {
      "reads every set's properties with no try, as it did": (code) => code.replace(
        /let defs = \{\};\s*try \{\s*defs = node\.componentPropertyDefinitions;\s*\} catch \(e\) \{[^}]*\}/, "const defs = node.componentPropertyDefinitions;"),
      "skips an errored set without saying so": (code) => code.replace("entry.error = String((e && e.message) || e);", ""),
    };
    const count = await assertMutantsFail(mutants, (mutate) => auditPage(sets(), mutate), assertRead);
    return `${errored.name} reported "${errored.error}", 3 others read; ${count} mutants fail`;
  });

  await check("the audit writes a translucent color variable with its alpha, as tokens writes its hex", async () => {
    // shadcn/ui's dark tokens are translucent, oklch(1 0 0 / 10%), which
    // tokens gives as #ffffff1a. The push sets the variable from that hex;
    // read back as #ffffff, it could never match.
    const { tokenColorToHex } = await import(pathToFileURL(join(ROOT, "dist", "cli", "tokens.js")).href);
    const values = ["oklch(1 0 0 / 10%)", "rgba(0, 0, 0, 0.7)", "oklch(0.704 0.191 22.216 / 0.3)", "#171717", "oklch(0.985 0 0)"];
    const tokens = values.map((value, i) => ({ name: `color/${i}`, hex: tokenColorToHex(value) }));
    assert(tokens.every((t) => t.hex), `tokens gave no hex for ${values.filter((_, i) => !tokens[i].hex).join(", ")}`);
    // As figma.util.rgba reads a hex, and as Figma stores the channels: 32-bit floats.
    const rgba = (hex) => {
      const [r, g, b, a = 255] = hex.slice(1).match(/../g).map((h) => parseInt(h, 16));
      return { r: Math.fround(r / 255), g: Math.fround(g / 255), b: Math.fround(b / 255), a: Math.fround(a / 255) };
    };
    const variables = tokens.map((t) => ({ collection: "Colors", name: t.name, type: "COLOR", value: rgba(t.hex) }));
    const read = async (mutate = null) => {
      const code = useFigmaBlock(/^Read all variable collections/);
      const run = mutate ? mutate(code) : code;
      assert(run !== code || !mutate, "a mutant of the variables read changed nothing in it");
      return (await readAllSlices(run, () => variablesFigma(variables))).flatMap((slice) => slice.variables);
    };
    const assertRead = (got) => {
      const pairs = got.map((v, i) => [v.value, tokens[i].hex]);
      assert(pairs.every(([figma, code]) => figma === code), `read ${pairs.map(([f, c]) => `${f} for ${c}`).join(", ")}`);
    };
    assertRead(await read());
    const count = await assertMutantsFail({
      "writes every color as 6-digit hex, as it did": (code) => code.replace("if (a < 255) channels.push(a);", ""),
      "writes an opaque color with ff on the end": (code) => code.replace("if (a < 255) channels.push(a);", "channels.push(a);"),
    }, read, assertRead);
    return `${tokens.map((t) => t.hex).join(", ")} read back as written; ${count} mutants fail`;
  });

  heading("Scoring contract");

  const reference = join(WORK, "readback-reference.json");

  await check("verify scores an exact reference readback at 100%", () => {
    // The baseline the other scoring checks perturb, built without the skill
    // template, so each of them isolates one behavior of verify.
    writeJson(reference, sealed(referenceReadback(snapDir)));
    const v = verifyJson(snapDir, reference);
    assert(v.json?.fidelity === 1, `fidelity ${v.json?.fidelity}\n${v.out.trim()}`);
    assert(exitOf(snapDir, reference, ["--strict", "--strict-age", "--strict-measured"]) === 0, "strict flags failed on an exact readback");
  });

  await check("an edit made in Figma is reported as exactly that drift", async () => {
    // The falsification test: change the Figma nodes, re-read them, and the
    // score must name what changed. A readback that echoed the values it was
    // sent would still read 100%.
    const path = join(WORK, "readback-edited.json");
    writeJson(path, await buildReadback(snapDir, {
      mutate(node, v, component) {
        if (component.name === "Button" && v.slug === "variant-danger--size-sm--disabled-false") {
          node.cornerRadius = 8;
          node.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 1 } }];
        }
      },
    }));
    const v = verifyJson(snapDir, path);
    const drifted = v.json.variants.filter((x) => x.status === "drifted");
    assert(drifted.length === 1 && drifted[0].slug.includes("danger"), `drifted: ${drifted.map((x) => x.slug).join(", ") || "none"}`);
    const props = drifted[0].differences.map((d) => d.property).sort().join(", ");
    assert(props === "backgroundColor, borderRadiusUniform", `flagged ${props}`);
    assert(exitOf(snapDir, path, ["--strict"]) === 1, "--strict passed");
    return "flagged backgroundColor and borderRadiusUniform only";
  });

  await check("a substituted font is scored as drift", async () => {
    // Figma's plugin context has only Google Fonts, so a system font gets
    // swapped. The template must report the family it actually used.
    const path = join(WORK, "readback-font.json");
    writeJson(path, await buildReadback(snapDir, {
      mutate(node, v, component) {
        if (component.name === "Button" && v.slug === "variant-danger--size-sm--disabled-false") {
          const text = node.findOne(() => true);
          text.fontName = { ...text.fontName, family: "Arimo" };
        }
      },
    }));
    const v = verifyJson(snapDir, path);
    const drifted = v.json.variants.filter((x) => x.status === "drifted");
    const props = drifted.flatMap((x) => x.differences.map((d) => d.property));
    assert(drifted.length === 1 && props.join() === "fontFamily", `drifted: ${JSON.stringify(drifted.map((x) => [x.slug, props]))}`);
    return "fontFamily flagged on exactly the substituted variant";
  });

  await check("a readback with no comparable properties scores nothing, not 100%", () => {
    const hollow = readJson(reference);
    for (const component of Object.values(hollow.components)) {
      for (const slug of Object.keys(component.variants)) component.variants[slug] = { source: "measured" };
    }
    const path = join(WORK, "readback-hollow.json");
    writeJson(path, sealed(hollow));
    const v = verifyJson(snapDir, path);
    assert(v.json.summary.verified === 0, `${v.json.summary.verified} variants reported verified with nothing compared`);
    // Sealed, but lacking every field the template always returns but source.
    const incomplete = (v.json.readbackIssues ?? []).filter((i) => i.problem === "incomplete");
    assert(incomplete.length === v.json.summary.variants, `${incomplete.length} of ${v.json.summary.variants} variants reported incomplete`);
    for (const flag of ["--strict", "--strict-age", "--strict-measured"]) {
      assert(exitOf(snapDir, path, [flag]) === 1, `${flag} passed`);
    }
    return `${incomplete.length} incomplete, all strict flags fail`;
  });

  await check("a variant missing from Figma fails --strict", () => {
    const missing = readJson(reference);
    const component = Object.values(missing.components)[0];
    delete component.variants[Object.keys(component.variants)[0]];
    const path = join(WORK, "readback-missing.json");
    writeJson(path, missing);
    const v = verifyJson(snapDir, path);
    assert(v.json.summary.missingFromFigma === 1, `missingFromFigma = ${v.json.summary.missingFromFigma}`);
    assert(exitOf(snapDir, path, ["--strict"]) === 1, "--strict passed");
  });

  await check("a component in Figma that snap never measured fails --strict, naming it", () => {
    const ghost = readJson(reference);
    const [entry] = Object.values(Object.values(ghost.components)[0].variants);
    ghost.components["Forms/Phantom"] = { nodeId: "9:9", variants: { default: { ...entry } } };
    const path = join(WORK, "readback-ghost.json");
    writeJson(path, sealed(ghost));
    assert(exitOf(snapDir, path, ["--strict-measured"]) === 1, "--strict-measured passed");
    // Its entry carries the checksum verify expects, but a snap with no
    // record of the component at all, as one re-run for other components
    // without --merge leaves, can't score the push it belongs to.
    assert(exitOf(snapDir, path, ["--strict"]) === 1, "--strict passed with a component the snap has no record of");
    const text = cli(["verify", "--snap", join(snapDir, "styles.json"), "--readback", path]).out;
    assert(/Forms\/Phantom is in the readback but not in the snap.*--merge/.test(text), `not named: ${text.trim()}`);
  });

  await check("opacity is not compared with the pixel tolerance", () => {
    const loose = readJson(reference);
    for (const component of Object.values(loose.components)) {
      for (const variant of Object.values(component.variants)) {
        if (variant.opacity !== undefined && variant.opacity < 1) variant.opacity = 0.8;
      }
    }
    const path = join(WORK, "readback-opacity.json");
    writeJson(path, sealed(loose));
    const v = verifyJson(snapDir, path, ["--tolerance", "5"]);
    const flagged = v.json.variants.some((x) => x.differences.some((d) => d.property === "opacity"));
    assert(flagged, "opacity 0.4 vs 0.8 passed under --tolerance 5");
  });

  await check("a snap of unknown or stale age fails --strict-age", () => {
    const aged = join(WORK, "snap-aged");
    cpSync(snapDir, aged, { recursive: true });
    const meta = readJson(join(aged, "meta.json"));
    meta.measuredAt = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    writeJson(join(aged, "meta.json"), meta);
    assert(exitOf(aged, reference, ["--strict-age"]) === 1, "a 5h-old snap passed --strict-age");
    rmSync(join(aged, "meta.json"));
    assert(exitOf(aged, reference, ["--strict-age"]) === 1, "a snap with no meta.json passed --strict-age");
  });

  await check("a component the snap failed to measure fails verify --strict", () => {
    const failed = join(WORK, "snap-failed");
    cpSync(snapDir, failed, { recursive: true });
    const styles = readJson(join(failed, "styles.json"));
    styles.components[0].error = "render timed out";
    styles.summary.componentsFailed = 1;
    writeJson(join(failed, "styles.json"), styles);
    assert(exitOf(failed, reference, ["--strict"]) === 1, "a snap that recorded a component failure passed --strict");

    const empty = join(WORK, "snap-empty");
    cpSync(snapDir, empty, { recursive: true });
    writeJson(join(empty, "styles.json"), { ...styles, components: [], summary: { ...styles.summary, components: 0, componentsFailed: 0 } });
    assert(exitOf(empty, reference, ["--strict"]) === 1, "a snap with no components passed --strict");
  });

  await check("a single unmeasurable variant is reported without failing --strict", () => {
    // Some are expected (args_unsupported); the skill builds them from source
    // and labels them inferred, which --strict-measured already fails.
    const partial = join(WORK, "snap-partial");
    cpSync(snapDir, partial, { recursive: true });
    const styles = readJson(join(partial, "styles.json"));
    styles.summary.failed = 1;
    writeJson(join(partial, "styles.json"), styles);
    const v = verifyJson(partial, reference);
    assert(v.json?.snapWarnings?.length === 1, `snapWarnings: ${JSON.stringify(v.json?.snapWarnings)}`);
    assert(exitOf(partial, reference, ["--strict"]) === 0, "--strict failed on an expected unmeasurable variant");
  });

  heading("Setup and skill");

  await check("setup installs a Claude skill Claude Code will load", () => {
    const project = join(WORK, "project");
    const r = cli(["setup", "--client", "claude", "--project", project]);
    assert(r.status === 0, `setup exited ${r.status}\n${r.out}`);
    const skill = join(project, ".claude", "skills", "storysync", "SKILL.md");
    assert(existsSync(skill), `no ${skill}; skills must be directories containing SKILL.md`);
    const head = readFileSync(skill, "utf8").slice(0, 400);
    assert(head.startsWith("---") && /\nname:\s*storysync/.test(head) && /\ndescription:/.test(head),
      "SKILL.md has no name/description frontmatter");
    assert(!existsSync(join(project, ".claude", "skills", "storysync.md")), "also wrote the flat file, which never loads");
    const commands = readdirSync(join(project, ".claude", "commands"));
    assert(commands.includes("storysync-push.md"), `commands written: ${commands.join(", ")}`);
  });

  await check("every file an installed command points the agent at exists", () => {
    // The slash commands send the agent to the skill by path. Moving the skill
    // without updating them leaves /storysync-push pointing at nothing — the
    // command still runs, the agent just never finds the procedure.
    const project = join(WORK, "project");
    const dir = join(project, ".claude", "commands");
    let referenced = 0;
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const [, path] of text.matchAll(/`(\.claude\/[^`\s]+)`/g)) {
        referenced++;
        assert(existsSync(join(project, path)), `${file} points at ${path}, which setup did not create`);
      }
    }
    assert(referenced > 0, "commands reference no .claude/ paths — the check found nothing to verify");
    return `${referenced} references`;
  });

  await check("the push instructions measure every combination", () => {
    // Sampling a subset is fine for a quick check but leaves holes in a Figma
    // component set. Every instruction that runs snap for a push must ask for
    // the full product, or the library ships missing variants.
    const files = ["skills/claude-code.md", "skills/codex.md", "skills/cursor.mdc", "commands/storysync-push.md"];
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const runs = [...text.matchAll(/npx storysync snap [^`\n]*/g)].map((m) => m[0]);
      assert(runs.length > 0, `${file} never runs snap`);
      for (const run of runs) assert(/--variants all/.test(run), `${file}: "${run}" measures a sample, not every combination`);
    }
    return `${files.length} files`;
  });

  await check("the push instructions say what snap's args records mean, and name them in the summary", () => {
    // snap records values a story's argTypes refused (arg_rejected, or
    // appliedVia "preview" when it set them another way), variants whose
    // args it couldn't check (argsChecked: false), and choices a story
    // declares that the docs don't (argsNotInDocs). An agent told nothing
    // of them builds the set as though all were well, and the user never
    // hears of the story change or the props Figma won't have.
    const files = ["skills/claude-code.md", "skills/codex.md", "skills/cursor.mdc", "commands/storysync-push.md"];
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const steps = file.startsWith("skills/") ? text.slice(0, text.indexOf("## Audit")) : text;
      for (const [what, pattern] of [
        ["says what an arg_rejected variant is", /An `arg_rejected` variant is/],
        ["says a variant set through the preview was measured", /`appliedVia: "preview"`|`appliedVia` is `"preview"`/],
        ["says to measure a variant marked argsChecked: false again", /marked `argsChecked: false`[^.]*measure those components again with `--components <their IDs> --merge`/],
        ["says what argsNotInDocs lists", /`argsNotInDocs` lists choices its story declares/],
        ["names both in the summary", /any variant snap marked `argsChecked: false`, each component's `argsNotInDocs`,/],
      ]) assert(pattern.test(steps), `${file}: the push never ${what}`);
    }
    return `${files.length} files`;
  });

  await check("the audit instructions leave out the push's excluded props, and map only a scope's components", () => {
    // The audit ran a plain map of every component: 11.5 minutes on a
    // shadcn registry for an audit of ten, with every prop the push left out
    // with --exclude-props reported missing from Figma.
    const files = ["skills/claude-code.md", "skills/codex.md", "skills/cursor.mdc", "commands/storysync-diff.md"];
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const audit = file.startsWith("skills/") ? text.slice(text.indexOf("## Audit"), text.indexOf("\n## ", text.indexOf("## Audit") + 1)) : text;
      assert(/npx storysync map /.test(audit), `${file}: the audit never runs map`);
      for (const [what, pattern] of [
        ["passes the push's --exclude-props", /--exclude-props/],
        ["says where snap records them", /`excludeProps`[^.]*`\.storysync\/snaps\/styles\.json`/],
        ["passes a scope with --components", /--components/],
        ["lists every component to pair a scope with", /npx storysync list --storybook \S+ --json/],
        ["pairs by the Storybook ID the push stored", /getSharedPluginData\('storysync', 'id'\)|storybookId/],
        ["reports a set Figma flags as errored", /errored in Figma \(can't read its properties\)/],
        ["finds an errored set by its node id", /`nodeId`/],
        // map exits 1 on a name Storybook lacks, which a scope naming a
        // Figma-only component has.
        ["lists the components before it maps a scope", /first run `npx storysync list/],
        ["maps only the scope's names that list has", /only the (?:scope's names|names in the scope) that list has/],
        ["skips map when list has none of the scope", /If list has none of them, skip map/],
        // Base UI's Button paired by ID left Radix's alone in the name, and
        // paired with any set of it, a designer's on another page included.
        ["still pairs a shared name's copies by page when IDs paired some", /counting those an ID paired/],
        // An icon library's components aren't drift.
        ["counts components outside any set not from the push, without listing them", /don't list it as Figma only, but count it/],
        ["lets those components leave the audit in sync", /components outside any set not from the push don't count against it/],
      ]) assert(pattern.test(audit), `${file}: the audit never ${what}`);
    }
    // The audit finds the props a push left out in styles.json, which a snap
    // run without --exclude-props, a re-run included, rewrites without them.
    const push = ["skills/claude-code.md", "skills/codex.md", "skills/cursor.mdc", "commands/storysync-push.md"];
    for (const file of push) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const steps = file.startsWith("skills/") ? text.slice(0, text.indexOf("## Audit")) : text;
      assert(/pass the same list to every `snap` you run for this push, re-runs included, and name those props in the summary/.test(steps),
        `${file}: the push never keeps the props --exclude-props left out across snap runs`);
    }
    return `${files.length} audit texts, ${push.length} push texts`;
  });

  await check("every use_figma code example in the skill parses", () => {
    const blocks = useFigmaBlocks();
    for (const { code, start } of blocks) {
      try {
        new AsyncFunction("figma", code);
      } catch (err) {
        throw new Error(`example at character ${start}: ${err.message}`);
      }
    }
    assert(blocks.length > 0, "found no use_figma examples");
    return `${blocks.length} examples`;
  });

  // --- Summary ---
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  ✗ [${f.section}] ${f.name}`);
  }
  if (process.env.KEEP_WORKDIR) console.log(`\nWorkdir kept: ${WORK}`);
  else rmSync(WORK, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
