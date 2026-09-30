#!/usr/bin/env node
// End-to-end acceptance checks for storysync, run against the example project.
//
// Unit tests prove the pieces; this proves the pipeline. It drives the built
// CLI against a live Storybook serving examples/storybook-vite, and it runs the
// readback code block from the shipped Claude skill against simulated Figma
// nodes — so a regression in the skill's template fails here, not in someone's
// Figma file.
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
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.env.STORYSYNC_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const CLI = join(ROOT, "dist", "cli", "index.js");
const SKILL = join(ROOT, "skills", "claude-code.md");
const EXAMPLE_BUTTON = join(ROOT, "examples", "storybook-vite", "src", "Button.tsx");
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

/**
 * The readback code block from the shipped skill, as a callable function.
 *
 * Extracted from skills/claude-code.md rather than copied, so this exercises
 * exactly what an agent is told to paste. The two lookup tables the agent is
 * told to fill in from snap output are replaced with ones built from snap
 * output here; everything else runs verbatim.
 */
function loadSkillReadback() {
  const md = readFileSync(SKILL, "utf8");
  const start = md.indexOf("const SLUG_BY_NAME");
  if (start < 0) {
    throw new Error(
      "skill template defines no SLUG_BY_NAME, so it has no way to map a Figma variant back to its snap slug " +
      "(it calls slugFor() without defining it)",
    );
  }
  const endMarker = "return JSON.stringify({ id: componentSet.id";
  const end = md.indexOf(endMarker, start);
  assert(end > 0, "skill template has no readback return statement");
  let block = md.slice(start, md.indexOf("\n", end));
  assert(!block.includes("`"), "skill template contains a backtick, which would close the use_figma code literal early");

  const table = (name) => new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\s*\\};`);
  assert(table("SLUG_BY_NAME").test(block), "could not locate the SLUG_BY_NAME table in the skill template");
  assert(table("SOURCE_BY_SLUG").test(block), "skill template defines no SOURCE_BY_SLUG, so provenance is not derived from snap status");

  return (componentSet, slugByName, sourceBySlug) => {
    const body = block
      .replace(table("SLUG_BY_NAME"), `const SLUG_BY_NAME = ${JSON.stringify(slugByName)};`)
      .replace(table("SOURCE_BY_SLUG"), `const SOURCE_BY_SLUG = ${JSON.stringify(sourceBySlug)};`);
    return JSON.parse(new Function("componentSet", body)(componentSet)).readback;
  };
}

/**
 * Builds figma-readback.json the way the skill does: one simulated component
 * set per measured component, read back by the skill's own template.
 * `mutate(node, variant, component)` edits a node after creation, the way a
 * designer might edit Figma by hand.
 */
function buildReadback(snapDir, { mutate, withholdSource } = {}) {
  const snap = readJson(join(snapDir, "styles.json"));
  const readbackOf = loadSkillReadback();
  const components = {};
  for (const component of snap.components) {
    if (!component.base) continue;
    const variants = expandVariants(component);
    const slugByName = {};
    const sourceBySlug = {};
    const children = variants.map((v) => {
      const name = figmaVariantName(v.combination);
      slugByName[name] = v.slug;
      if (v.slug !== withholdSource) sourceBySlug[v.slug] = "measured";
      const node = figmaNode(name, v.styles);
      mutate?.(node, v, component);
      return node;
    });
    const componentSet = { id: `set:${component.name}`, name: component.name, children };
    components[component.title ?? component.name] = {
      nodeId: componentSet.id,
      variants: readbackOf(componentSet, slugByName, sourceBySlug),
    };
  }
  return { version: 1, fileKey: "acceptance", components };
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
    return "12 over a limit of 4: warned, recorded, --strict failed";
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

  heading("Round trip through the shipped skill template");

  const perfect = join(WORK, "readback-perfect.json");

  await check("a faithful Figma reproduction scores 100%", () => {
    writeJson(perfect, buildReadback(snapDir));
    const v = verifyJson(snapDir, perfect);
    assert(v.json, `verify produced no JSON\n${v.out}`);
    const { summary, fidelity } = v.json;
    assert(fidelity === 1, `fidelity ${fidelity} (${summary.propertiesMatched}/${summary.propertiesCompared}), drifted ${summary.drifted}\n` +
      v.json.variants.filter((x) => x.status !== "verified")
        .map((x) => `${x.slug} [${x.status}] ${x.differences.map((d) => `${d.property}: ${JSON.stringify(d.measured)} vs ${JSON.stringify(d.figma)}`).join("; ")}`)
        .join("\n"));
    const status = exitOf(snapDir, perfect, ["--strict", "--strict-age", "--strict-measured"]);
    assert(status === 0, `all strict flags exited ${status}`);
    return `${summary.verified}/${summary.variants} variants, ${summary.propertiesCompared} properties`;
  });

  await check("a variant the agent did not mark measured is recorded as inferred", () => {
    const snap = readJson(join(snapDir, "styles.json"));
    const withheld = snap.components.find((c) => c.name === "Button").variants[0].slug;
    const path = join(WORK, "readback-withheld.json");
    writeJson(path, buildReadback(snapDir, { withholdSource: withheld }));
    const v = verifyJson(snapDir, path);
    const variant = v.json?.variants.find((x) => x.slug === withheld);
    assert(variant?.source === "inferred", `recorded as ${variant?.source}; omission must not read as measured`);
    assert(exitOf(snapDir, path, ["--strict-measured"]) === 1, "--strict-measured passed");
    assert(exitOf(snapDir, path, ["--strict"]) === 0, "--strict failed on provenance alone");
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

  await check("an edit made in Figma is reported as exactly that drift", () => {
    // The falsification test: change the Figma nodes, re-read them, and the
    // score must name what changed. A readback that echoed the values it was
    // sent would still read 100%.
    const path = join(WORK, "readback-edited.json");
    writeJson(path, buildReadback(snapDir, {
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

  await check("a substituted font is scored as drift", () => {
    // Figma's plugin context has only Google Fonts, so a system font gets
    // swapped. The template must report the family it actually used.
    const path = join(WORK, "readback-font.json");
    writeJson(path, buildReadback(snapDir, {
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
    const AsyncFunction = (async () => {}).constructor;
    const md = readFileSync(SKILL, "utf8");
    let at = 0;
    let count = 0;
    while ((at = md.indexOf("code: `", at)) >= 0) {
      const start = at + "code: `".length;
      const end = md.indexOf("`,", start);
      try {
        new AsyncFunction("figma", "componentSet", md.slice(start, end));
      } catch (err) {
        throw new Error(`example at character ${start}: ${err.message}`);
      }
      count++;
      at = end;
    }
    assert(count > 0, "found no use_figma examples");
    return `${count} examples`;
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
