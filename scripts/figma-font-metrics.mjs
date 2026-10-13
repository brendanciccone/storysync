#!/usr/bin/env node
// Writes cli/__tests__/fixtures/figma-fonts.json: how wide Figma sets text in
// each font storysync draws stand-ins in, for the mock Figma's text layout.
//
// The faces are the ones snap draws stand-ins in (cli/fonts.ts): Inter's and
// Roboto Mono's Latin faces rounded as Figma rounds them, to a 1024th of an
// em (fonts/, scripts/figma-stand-ins.py), so Chrome sets them as wide as
// Figma does. Chrome measures them here: each character's advance and each
// kerning pair among printable ASCII, in em, at every weight Figma has, and
// each font's height at line-height normal, Figma's AUTO. Kerning is kept
// for the weights text is usually set in, and the nearest of those stands in
// for the rest.
//
//   pnpm build && node scripts/figma-font-metrics.mjs [--check]
//
// --check writes nothing and fails when the file differs from what the
// installed fonts measure, as after an update of a font package or of
// fonts/. Either way it proves the faces against the fourth push's text
// probe (fixtures/figma-text-probe-3.json): it prints how far from Figma's
// width Chrome sets each family's probe strings in the stand-in, and fails
// when Inter or Roboto Mono, the families fonts/ rounds, is off by more than
// 0.001px; and how far each of the probe's characters alone is from Figma's
// advance for it at every weight of Inter, arrows and check marks
// included, failing above 0.00001em. Noto Serif comes from its package
// unrounded, so it is printed only. mock-figma.test.ts holds the file to
// the same probe.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "cli", "__tests__", "fixtures", "figma-fonts.json");
const PROBE = join(ROOT, "cli", "__tests__", "fixtures", "figma-text-probe-3.json");
/** The families fonts/ rounds as Figma does, which must set the probe's strings as wide as Figma did. */
const ROUNDED_FAMILIES = ["Inter", "Roboto Mono"];
/** In px: float noise, well under the 0.01 snap rounds a box to. */
const PROOF_TOLERANCE = 0.001;
/** In em: the 0.00001 the file keeps an advance to. */
const ADVANCE_TOLERANCE = 0.00001;
const { STAND_INS, standInFaces, standInFamilies } = await import(join(ROOT, "dist", "cli", "fonts.js"));
const { resolveAndLaunch } = await import(join(ROOT, "dist", "cli", "snap-browser.js"));

/** Printable ASCII and Latin-1, and the punctuation and symbols components often show. */
const CHARS = [
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...Array.from({ length: 96 }, (_, i) => String.fromCharCode(160 + i)),
  ..."–—‘’“”…•€←→↑↓−×✓",
].join("");
const ASCII = CHARS.slice(0, 95);
/** Weights by family, as Figma has them; italic only where it is wider or narrower than upright. */
const WEIGHTS = { Inter: [100, 200, 300, 400, 500, 600, 700, 800, 900], "Roboto Mono": [100, 200, 300, 400, 500, 600, 700], "Noto Serif": [100, 200, 300, 400, 500, 600, 700, 800, 900] };
const ITALIC = { Inter: false, "Roboto Mono": false, "Noto Serif": true };
const KERNED = [400, 500, 600, 700];

const require = createRequire(join(ROOT, "package.json"));
const packages = Object.fromEntries(["inter", "roboto-mono", "noto-serif"].map((name) => {
  const pkg = `@fontsource-variable/${name}`;
  return [pkg, JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), "utf8")).version];
}));
// The rounded faces in fonts/, by their digests.
const rounded = JSON.parse(readFileSync(join(ROOT, "fonts", "manifest.json"), "utf8")).sha256;

const { browser } = await resolveAndLaunch();
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>metrics</title>");
  const faces = STAND_INS.flatMap((standIn) => standInFaces(standIn));
  // Each stand-in's stack as snap sets it, its families quoted.
  const stacks = Object.fromEntries(STAND_INS.map((standIn) => [standIn, standInFamilies(standIn).map((f) => `"${f}"`).join(", ")]));
  const { fonts, lines } = await page.evaluate(async ({ faces, stacks, families, weights, italic, kerned, chars, ascii }) => {
    for (const face of faces) {
      const bytes = Uint8Array.from(atob(face.data), (c) => c.charCodeAt(0));
      const loaded = new FontFace(face.family, bytes, { style: face.style, weight: face.weight, unicodeRange: face.unicodeRange });
      document.fonts.add(loaded);
      await loaded.load();
    }
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fontKerning = "normal";
    const SIZE = 1000;
    const em = (n) => Math.round((n / SIZE) * 1e5) / 1e5;
    const out = {};
    const lines = {};
    for (const family of families) {
      out[family] = {};
      // A text's height at line-height normal, Figma's AUTO: ascent and descent.
      ctx.font = `400 ${SIZE}px ${stacks[family]}`;
      const m = ctx.measureText("H");
      lines[family] = em(m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
      for (const style of italic[family] ? ["", "i"] : [""]) {
        for (const weight of weights[family]) {
          ctx.font = `${style ? "italic " : ""}${weight} ${SIZE}px ${stacks[family]}`;
          const width = (text) => ctx.measureText(text).width;
          const own = {};
          for (const ch of ascii) own[ch] = width(ch);
          const metrics = { advance: [...chars].map((ch) => em(width(ch))) };
          if (kerned.includes(weight) && family !== "Roboto Mono") {
            const kern = {};
            for (const a of ascii) {
              for (const b of ascii) {
                const k = em(width(a + b) - own[a] - own[b]);
                if (Math.abs(k) >= 0.0001) kern[a + b] = k;
              }
            }
            metrics.kern = kern;
          }
          out[family][`${weight}${style}`] = metrics;
        }
      }
    }
    return { fonts: out, lines };
  }, { faces, stacks, families: STAND_INS, weights: WEIGHTS, italic: ITALIC, kerned: KERNED, chars: CHARS, ascii: ASCII });
  // The proof: each string the fourth push's text probe set, as Chrome sets
  // it in the stand-in, against the width Figma needed to keep it on one
  // line (or, for a string that can't wrap, its width at a hundred times the
  // size, to 0.01).
  const probe = JSON.parse(readFileSync(PROBE, "utf8"));
  const STYLE_WEIGHT = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, "Semi Bold": 600, SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900 };
  const strings = [
    ...probe.call1.rows.map(([chars, weight, size, , big, fits, , ends]) => ({ family: "Inter", chars, weight, size, figma: ends[0] ? big : fits, exact: !ends[0] })),
    ...probe.call3.other.map(([chars, family, style, size, , exact]) => ({ family, chars, weight: STYLE_WEIGHT[style], size, figma: exact, exact: true })),
  ];
  const chrome = await page.evaluate(({ strings, stacks }) => {
    const ctx = document.createElement("canvas").getContext("2d");
    return strings.map(({ family, chars, weight, size }) => {
      ctx.font = `${weight} ${size}px ${stacks[family]}`;
      return ctx.measureText(chars).width;
    });
  }, { strings, stacks });
  const worst = {};
  for (const [i, s] of strings.entries()) {
    const diff = chrome[i] - s.figma;
    // A width read to 0.01 is only as close as that.
    const off = s.exact ? Math.abs(diff) : Math.max(0, Math.abs(diff) - 0.01);
    if (!worst[s.family] || off > worst[s.family].off) worst[s.family] = { off, chars: s.chars, weight: s.weight, size: s.size, chrome: chrome[i], figma: s.figma };
  }
  for (const [family, w] of Object.entries(worst)) {
    const ok = !ROUNDED_FAMILIES.includes(family) || w.off <= PROOF_TOLERANCE;
    console.log(`${ok ? "ok" : "FAIL"} ${family}: Chrome sets the probe's strings within ${w.off.toFixed(5)}px of Figma (worst "${w.chars}" ${w.weight} ${w.size}px: ${w.chrome.toFixed(5)} in Chrome, ${w.figma} in Figma)`);
    if (!ok) process.exitCode = 1;
  }
  // And each of the probe's characters alone (its second call), at every
  // weight: Chrome's advance in the stand-in against Figma's, in em, which
  // the file keeps to 0.00001. A soft hyphen Figma sets 0 wide alone.
  let advanceOff = { off: 0 };
  for (const weight of WEIGHTS.Inter) {
    const figma = probe.call2.advance[weight];
    [...CHARS].forEach((ch, i) => {
      if (ch === "\u00ad") return;
      const off = Math.abs(fonts.Inter[`${weight}`].advance[i] - figma[i] / probe.call2.size);
      if (off > advanceOff.off) advanceOff = { off, ch, weight, chrome: fonts.Inter[`${weight}`].advance[i], figma: figma[i] / probe.call2.size };
    });
  }
  const advancesOk = advanceOff.off <= ADVANCE_TOLERANCE;
  console.log(`${advancesOk ? "ok" : "FAIL"} Inter: Chrome sets each of the probe's ${CHARS.length} characters within ${advanceOff.off.toFixed(6)}em of Figma at every weight` +
    (advanceOff.ch ? ` (worst ${JSON.stringify(advanceOff.ch)} at ${advanceOff.weight}: ${advanceOff.chrome} in Chrome, ${advanceOff.figma} in Figma)` : ""));
  if (!advancesOk) process.exitCode = 1;

  const file = {
    about: "Each character's advance and each kerning pair among printable ASCII, in em, as Chrome sets the faces storysync draws stand-ins in, which Figma sets as wide (scripts/figma-font-metrics.mjs)",
    packages,
    rounded,
    chars: CHARS,
    kerned: KERNED,
    lineHeight: lines,
    fonts,
  };
  const text = `${JSON.stringify(file)}\n`;
  if (process.argv.includes("--check")) {
    const now = readFileSync(OUT, "utf8");
    if (now !== text) {
      console.error(`${OUT} differs from what the installed fonts measure: run node scripts/figma-font-metrics.mjs`);
      process.exitCode = 1;
    } else {
      console.log(`${OUT} matches the installed fonts`);
    }
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT} (${text.length} characters)`);
  }
} finally {
  await browser.close();
}
