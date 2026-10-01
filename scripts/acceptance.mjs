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

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from "node:fs";
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

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: opts.cwd ?? WORK });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function verifyJson(snapDir, readbackPath, extra = []) {
  const r = cli(["verify", "--snap", join(snapDir, "styles.json"), "--readback", readbackPath, "--json", ...extra]);
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
function exitOf(snapDir, readbackPath, flags) {
  const probe = verifyJson(snapDir, readbackPath);
  if (!probe.json || probe.json.error || !probe.json.summary) {
    throw new Error(`verify did not score this input:\n${probe.out.trim()}`);
  }
  return cli(["verify", "--snap", join(snapDir, "styles.json"), "--readback", readbackPath, ...flags]).status;
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
 * reason that has nothing to do with scoring.
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

/** A Figma component node that reproduces one measured variant exactly. */
function figmaNode(name, st) {
  const text = st.text ?? { color: st.color, fontFamily: st.fontFamily, fontSize: st.fontSize, fontWeight: st.fontWeight };
  const textNode = {
    type: "TEXT",
    fills: text.color ? [{ type: "SOLID", color: rgb01(text.color) }] : [],
    fontSize: text.fontSize,
    // What Figma actually reports: a style *name*, e.g. Inter 600 is "Semi Bold".
    fontName: { family: text.fontFamily, style: STYLE_NAME[text.fontWeight] ?? "Regular" },
  };
  return {
    name,
    fills: st.backgroundColor ? [{ type: "SOLID", color: rgb01(st.backgroundColor) }] : [],
    strokes: st.borderUniform ? [{ type: "SOLID", color: rgb01(st.borderUniform.color) }] : [],
    strokeWeight: st.borderUniform?.width ?? 0,
    cornerRadius: st.borderRadiusUniform ?? 0,
    paddingTop: st.padding.top,
    paddingRight: st.padding.right,
    paddingBottom: st.padding.bottom,
    paddingLeft: st.padding.left,
    // Padding needs auto-layout in Figma whatever the element's CSS display.
    layoutMode: "HORIZONTAL",
    itemSpacing: st.gap?.column ?? 0,
    opacity: st.opacity,
    // Figma rounds text to whole pixels, so render bounds land near, not on, CSS.
    absoluteRenderBounds: { width: Math.round(st.width), height: Math.round(st.height) },
    findOne: (predicate) => (predicate(textNode) ? textNode : null),
  };
}

function expandVariants(component) {
  return component.variants
    .filter((v) => v.status === "ok")
    .map((v) => ({ ...v, styles: { ...component.base.styles, ...(v.delta ?? {}) } }));
}

function figmaVariantName(combination) {
  const entries = Object.entries(combination ?? {});
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(", ") : "default";
}

const AsyncFunction = (async () => {}).constructor;

// use_figma's limits: its input schema caps `code` at 50,000 characters, and
// Figma documents a 20kb output response limit per call. The templates refuse
// to return a slice whose encoded JSON passes GUARD.
const CODE_LIMIT = 50000;
const RESPONSE_LIMIT = 20000;
const GUARD = 17000;

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
 * so a guard loosened towards 20kb, or one measuring the string before
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
 * and `read()` what that call returns, parsed.
 */
function loadSkillReadback() {
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
  const block = md.slice(open + "code: `".length, close);
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
  const run = async (componentSet, slugByName, sourceBySlug, opts) => {
    const figma = { getNodeByIdAsync: async (id) => (id === componentSet.id ? componentSet : null) };
    return new AsyncFunction("figma", code(componentSet.id, slugByName, sourceBySlug, opts))(figma);
  };
  const read = async (...args) => JSON.parse(await run(...args));
  return { batch, code, run, read };
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
    assert(slice.total === componentSet.children.length,
      `the slice reports a total of ${slice.total}, but the set holds ${componentSet.children.length} variants`);
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
 * calls each set took.
 */
async function buildReadback(snapDir, { mutate, withholdSource, onRead } = {}) {
  const readback = loadSkillReadback();
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
 */
function figmaDocument() {
  let count = 0;
  let loaded = new Set();
  let ignored = false;
  const byId = new Map();
  const pages = [];
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
  const create = (type, name) => {
    const node = { id: `${count++}:1`, type, name, parent: null, width: 100, height: 100 };
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
      if (!(width > 0 && height > 0)) throw new Error(`cannot resize a ${type} to ${width} by ${height}`);
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
  return { call, nodes, container: inside, ignorePositions };
}

/**
 * The build template from the shipped skill: one part of a set.
 *
 * Its VARIANTS table is replaced with the part's own variants, and its
 * PROPERTIES table with the component's variantProperties from snap, each
 * written an entry a line, and PAGE_NAME, SET_NAME, SET_ID and PART with the
 * call's own. applyStyles is where the agent writes the Plugin API code that
 * styles a variant; `run()` gives it the simulated node of figmaNode() for
 * those styles, sized to the measured width and height, so the readback
 * template reads back exactly what the part sent. Everything else, finding
 * the set and its variants, creating what is missing, and laying the set out,
 * runs verbatim. `code(..., { styled: false })` leaves applyStyles as the
 * skill ships it, for pricing what an agent would send. `mutate` rewrites the
 * shipped code, to show a check fails a template that gets something wrong.
 */
function loadSkillBuild(mutate = null) {
  const block = useFigmaBlock(/^Create or update/);
  const list = /const VARIANTS = \[[\s\S]*?\n\s*\];/;
  const table = /const PROPERTIES = \[[\s\S]*?\n\s*\];/;
  const styler = /const applyStyles = async \(variant, styles\) => \{[\s\S]*?\n\s*\};/;
  assert(list.test(block), "the build template has no VARIANTS table to loop over");
  assert(table.test(block), "the build template has no PROPERTIES table to lay the set out by");
  assert(styler.test(block), "the build template has no applyStyles for the agent's styling code");
  for (const name of ["PAGE_NAME", "SET_NAME", "SET_ID", "PART"]) {
    assert(constant(name).test(block), `the build template defines no ${name}`);
  }
  const part = Number(/const PART = (\d+);/.exec(block)?.[1]);
  assert(part > 0, "the build template's PART is not a number");
  const shipped = mutate ? mutate(block) : block;
  assert(!mutate || shipped !== block, "the mutation no longer matches the build template");
  const code = (variants, constants, properties, { styled = true } = {}) => {
    assert(Array.isArray(properties), "a build part needs the component's variantProperties");
    const body = withConstants(shipped, constants)
      .replace(table, () => `const PROPERTIES = [\n${properties.map((p) => `      ${JSON.stringify(p)},`).join("\n")}\n    ];`)
      .replace(list, () => `const VARIANTS = [\n${variants.map(({ name, styles }) => `      ${JSON.stringify({ name, styles })},`).join("\n")}\n    ];`);
    return styled
      ? body.replace(styler, () => "const applyStyles = async (variant, styles) => {\n      Object.assign(variant, look(variant.name, styles));\n    };")
      : body;
  };
  const look = (name, styles) => {
    const { name: _, ...node } = figmaNode(name, styles);
    return { ...node, width: Math.round(styles.width), height: Math.round(styles.height) };
  };
  const run = async (figma, variants, constants, properties) =>
    JSON.parse(await new AsyncFunction("figma", "look", code(variants, constants, properties))(figma, look));
  return { part, code, run, look };
}

/**
 * Pushes one set the way the skill says to: `variants` in snap's order, in
 * parts of `part`, the first part finding the set by name and every later one
 * by the id the first returned, each carrying the component's `properties`.
 * Returns what each part returned, calling `after` with each as it does.
 */
async function pushSet(build, doc, { page, set, variants, part, properties, after = null }) {
  const parts = [];
  let id = null;
  for (const named of slices(variants, part)) {
    const result = await build.run(doc.call(), named, { PAGE_NAME: page, SET_NAME: set, SET_ID: id, PART: part }, properties);
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

/**
 * Throws unless `set` is laid out as `rows`, each a list of variant names with
 * null for a gap, and `extra` in a row of its own below: neighbouring columns
 * and rows exactly `gap` apart, each column as wide as its widest variant and
 * each row as tall as its tallest, the set reaching `gap` past the last of
 * them, nothing overlapping, and the layers panel reading the same way, row by
 * row. Returns the grid's nodes, null for a gap.
 */
function assertGridOf(set, rows, extra, gap) {
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
    assert(space === gap, `column ${c + 2} starts ${space} past column ${c + 1}'s widest variant, not ${gap}`);
  });
  ys.slice(1).forEach((y, r) => {
    const space = y - (ys[r] + heights[r]);
    assert(space === gap, `row ${r + 2} starts ${space} below row ${r + 1}'s tallest variant, not ${gap}`);
  });
  let right = xs[xs.length - 1] + widths[widths.length - 1];
  let bottom = ys[ys.length - 1] + heights[heights.length - 1];
  if (below.length) {
    const space = below[0].y - bottom;
    assert(space === gap && below.every((n) => n.y === below[0].y), `the extra row starts ${space} below the grid, not ${gap}`);
    assert(below[0].x === gap, `the extra row starts at ${below[0].x} across, not ${gap}`);
    below.slice(1).forEach((n, k) => {
      const after = n.x - (below[k].x + below[k].width);
      assert(after === gap, `"${n.name}" starts ${after} past "${below[k].name}", not ${gap}`);
    });
    right = Math.max(right, below[below.length - 1].x + below[below.length - 1].width);
    bottom = below[0].y + Math.max(...below.map((n) => n.height));
  }
  assert(set.width === right + gap && set.height === bottom + gap,
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
      // A component whose defaults are not its first values: the order is
      // declared, not default first, so the grid is the same, and Figma's
      // default, the top-left variant, is primary, sm, not disabled.
      const { gap, properties, measured } = data();
      const shifted = properties.map((p) => ({ ...p, defaultValue: p.type === "BOOLEAN" ? "true" : p.values[p.values.length - 1] }));
      const doc = figmaDocument();
      const set = await leftSet(build, doc, scrambled(measured));
      await pushSet(build, doc, { page: "Forms", set: "Button", variants: measured, part: PART, properties: shifted });
      assertGridOf(set, GRID, [], gap);
      return "the same grid with outline, lg and disabled the defaults";
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

// --- Simulated Figma for the audit -------------------------------------------

/** One use_figma call's figma, serving local variables. */
function variablesFigma(variables) {
  const collections = [];
  const byId = new Map();
  variables.forEach((v, i) => {
    let coll = collections.find((c) => c.name === v.collection);
    if (!coll) {
      coll = { name: v.collection, modes: [{ modeId: `${v.collection}:default`, name: "Default" }], variableIds: [] };
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
 * One use_figma call's figma, serving pages of component sets. As in
 * use_figma, a call starts on the first page with only it loaded, a page loads
 * when the call switches to it and becomes figma.currentPage, and a search
 * from figma.root sees only the loaded pages. `switches` records each switch.
 */
function pagesFigma(pages, switches = []) {
  const loaded = new Set([pages[0].id]);
  const nodes = pages.map((p) => ({
    id: p.id,
    type: "PAGE",
    name: p.name,
    findAllWithCriteria: ({ types }) => (loaded.has(p.id) ? p.sets.filter((s) => types.includes(s.type)) : []),
  }));
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

/** A component set as the audit reads it: its properties and its variant count. */
function auditSet(name, options) {
  const defs = Object.fromEntries(Object.entries(options).map(([prop, values]) =>
    [prop, values === "BOOLEAN" ? { type: "BOOLEAN", defaultValue: false } : { type: "VARIANT", variantOptions: values }]));
  const count = Object.values(options).reduce((n, values) => n * (values === "BOOLEAN" ? 2 : values.length), 1);
  return { type: "COMPONENT_SET", name, componentPropertyDefinitions: defs, children: Array.from({ length: count }, () => ({})) };
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

  heading("Build");

  await check("--version matches package.json", () => {
    const r = cli(["--version"]);
    assert(r.out.trim() === pkg.version, `--version printed ${r.out.trim()}, package.json says ${pkg.version}`);
    return pkg.version;
  });

  heading("Measurement");

  await check("snap measures every variant of the example", () => {
    const r = cli(["snap", "--storybook", STORYBOOK, "--out", snapDir, "--screenshots", "--variants", "all"]);
    assert(r.status === 0, `snap exited ${r.status}\n${r.out.trim()}`);
    const snap = readJson(join(snapDir, "styles.json"));
    const byName = Object.fromEntries(snap.components.map((c) => [c.name, c]));
    assert(byName.Button && byName.Frozen, `expected Button and Frozen, found ${Object.keys(byName).join(", ") || "none"}`);
    assert(snap.summary.rendered === snap.summary.variants && snap.summary.failed === 0,
      `rendered ${snap.summary.rendered}/${snap.summary.variants}, ${snap.summary.failed} failed`);
    return `${snap.summary.rendered}/${snap.summary.variants} variants across ${snap.summary.components} components`;
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

  await check("two snaps of the same code are byte-identical, wherever they are written", () => {
    // Same flags as the first run, into a different directory. styles.json is
    // meant to be committed and diffed, so neither a rerun nor a different
    // --out (another machine, another checkout) may change a byte of it.
    const again = join(WORK, "elsewhere", "snap-again");
    const r = cli(["snap", "--storybook", STORYBOOK, "--out", again, "--screenshots", "--variants", "all"]);
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
    return "Frozen fails, Button passes";
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
    const status = exitOf(snapDir, perfect, ["--strict", "--strict-age", "--strict-measured"]);
    assert(status === 0, `all strict flags exited ${status}`);
    const total = Object.values(calls).reduce((a, b) => a + b, 0);
    return `${summary.verified}/${summary.variants} variants, ${summary.propertiesCompared} properties, read in ${total} slices`;
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
    // full measured styles, each as large as the example's largest, and its
    // properties table with the set's: the agent's own Plugin API code has to
    // fit in what is left, at least 15,000 characters. Every part carries the
    // layout, which lays out and checks the whole set, so push all 256
    // variants through the simulated document too: each part has to return
    // counts small enough for one response, and leave every variant in the
    // grid of 4 rows of 64.
    const md = readFileSync(SKILL, "utf8");
    const part = Number(/in parts of at most (\d+) variants/.exec(md)?.[1]);
    assert(part > 0, "the skill gives no number of variants to build a set in parts of");
    const build = loadSkillBuild();
    assert(build.part === part, `the build template's PART is ${build.part}, but the skill says to build in parts of ${part}`);
    const set = await realisticSet(snapDir);
    const largest = set.styles.reduce((a, b) => (JSON.stringify(b).length > JSON.stringify(a).length ? b : a));
    const variants = Object.keys(set.slugByName).map((name) => ({ name, styles: largest }));
    const constants = { PAGE_NAME: "Forms", SET_NAME: "Button", SET_ID: "12:34", PART: part };
    const code = build.code(variants.slice(0, part), constants, set.properties, { styled: false }).length;
    assert(code <= CODE_LIMIT - 15000, `${part} variants come to ${code} characters before the agent's own code, too close to ${CODE_LIMIT}`);
    const whole = build.code(variants, constants, set.properties, { styled: false }).length;

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
    return `${part} variants a call: ${code} characters before the agent's own code; all 256 would be ${whole}; ` +
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
    // set by the variantProperties snap records, in Storybook's declared
    // order, a BOOLEAN false then true: rows primary, danger and outline,
    // columns sm, sm disabled, lg, lg disabled, the layers panel reading the
    // same way, and a variant snap does not have in a row of its own below.
    // The same set laid out by properties whose defaults are not their first
    // values comes out the same, since the order is declared, not default
    // first; and Frozen's one property is a column of 3.
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

  await check("a layout that gets the order, the spacing or a check wrong fails these checks", async () => {
    // Each mutant rewrites the shipped template, and has to fail a layout
    // check the template passes.
    const T = {
      sort: "cells.sort((a, b) => a.at[0] - b.at[0] || byColumn(a.at, b.at) || byId(a, b));",
      columns: "const columns = [...new Map(grid.map((c) => [c.key, c.at])).values()].sort(byColumn).map((at) => at.slice(1).join());",
      rows: "const rows = [...new Set(grid.map((c) => c.at[0]))];",
      values: "p.type === 'BOOLEAN' ? ['false', 'true'] : p.values",
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
      "puts a BOOLEAN's true before its false": (code) => code.replace("['false', 'true']", "['true', 'false']"),
      "keeps whichever copy of a name comes first among the children in the grid": (code) => code
        .replace(T.sort, T.sort.replace(" || byId(a, b)", "")),
      "lays out a set with auto layout": (code) => between(code, "if (componentSet && componentSet.layoutMode !== 'NONE') {", "\n    }\n"),
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
      collection: "Semantic colours", name: `color/semantic/interactive/surface-${i}/background-hover-pressed`, type: "COLOR", value: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
    }));
    const refused = await assertGuardRefuses((n, guarded) => {
      const body = withConstants(guarded ? code : liftGuard(code), { START: 0, BATCH: n });
      return new AsyncFunction("figma", body)(variablesFigma(long));
    }, long.length);
    return `${counts.join(", ")}; ${refused}`;
  });

  await check("the audit reads the component sets on every page, not only the one loaded first", async () => {
    // The push puts each Storybook category on its own page. use_figma loads
    // a page only when a call switches to it, so a search from figma.root
    // would see the first page's sets, and only the first page's, from every
    // call. Each page's call has to return that page's sets and no other's.
    // Forms holds exactly two slices of sets, so a call past the last slice
    // would be one too many.
    const code = useFigmaBlock(/^Read the component sets/);
    const batch = Number(/const BATCH = (\d+);/.exec(code)?.[1]);
    assert(batch > 0, "the component read defines no BATCH");
    const forms = Array.from({ length: 2 * batch }, (_, i) => auditSet(`Field${i}`, { size: ["sm", "md", "lg"], disabled: "BOOLEAN" }));
    const pages = [
      { id: "0:1", name: "Forms", sets: forms },
      { id: "0:2", name: "Navigation", sets: [auditSet("Tabs", { variant: ["line", "pill"] }), auditSet("Breadcrumb", { size: ["sm", "md"] })] },
      { id: "0:3", name: "Archive", sets: [] },
    ];
    const found = [];
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
      const sets = pages.find((p) => p.id === page.id).sets.length;
      const calls = Math.max(1, Math.ceil(sets / batch));
      assert(read.length === calls, `read the ${sets} sets on ${page.name} in ${read.length} calls, not ${calls}, with BATCH ${batch}`);
      for (const slice of read) found.push(...slice.componentSets.map((s) => `${page.name}/${s.name}`));
    }
    const expected = pages.flatMap((p) => p.sets.map((s) => `${p.name}/${s.name}`));
    assert(found.join() === expected.join(), `read ${found.length} sets (${found.slice(0, 3).join(", ")}...), expected ${expected.length} across ${pages.length} pages`);

    const options = Array.from({ length: 12 }, (_, i) => `option-with-a-long-descriptive-name-${i}`);
    const wide = Array.from({ length: 120 }, (_, i) => auditSet(`Wide${i}`, { appearance: options, emphasis: options.slice(0, 6), disabled: "BOOLEAN" }));
    const widePages = [{ id: "1:1", name: "Wide", sets: wide }];
    const refused = await assertGuardRefuses((n, guarded) => {
      const body = withConstants(guarded ? code : liftGuard(code), { PAGE_ID: "1:1", START: 0, BATCH: n });
      return new AsyncFunction("figma", body)(pagesFigma(widePages));
    }, wide.length);
    return `${found.length} sets across ${pages.length} pages; ${refused}`;
  });

  heading("Scoring contract");

  const reference = join(WORK, "readback-reference.json");

  await check("verify scores an exact reference readback at 100%", () => {
    // The baseline the other scoring checks perturb, built without the skill
    // template, so each of them isolates one behaviour of verify.
    writeJson(reference, referenceReadback(snapDir));
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
    writeJson(path, hollow);
    const v = verifyJson(snapDir, path);
    assert(v.json.summary.verified === 0, `${v.json.summary.verified} variants reported verified with nothing compared`);
    for (const flag of ["--strict", "--strict-age", "--strict-measured"]) {
      assert(exitOf(snapDir, path, [flag]) === 1, `${flag} passed`);
    }
    return `${v.json.summary.unscored ?? "?"} unscored, all strict flags fail`;
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

  await check("a component in Figma that snap never measured fails --strict-measured", () => {
    const ghost = readJson(reference);
    ghost.components["Forms/Phantom"] = { nodeId: "9:9", variants: { default: { source: "measured", fontSize: 12 } } };
    const path = join(WORK, "readback-ghost.json");
    writeJson(path, ghost);
    assert(exitOf(snapDir, path, ["--strict-measured"]) === 1, "--strict-measured passed");
  });

  await check("opacity is not compared with the pixel tolerance", () => {
    const loose = readJson(reference);
    for (const component of Object.values(loose.components)) {
      for (const variant of Object.values(component.variants)) {
        if (variant.opacity !== undefined && variant.opacity < 1) variant.opacity = 0.8;
      }
    }
    const path = join(WORK, "readback-opacity.json");
    writeJson(path, loose);
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
