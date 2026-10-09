#!/usr/bin/env node
// Writes cli/__tests__/fixtures/figma-fonts.json: how wide Figma sets text in
// each font storysync draws stand-ins in, for the mock Figma's text layout.
//
// The fonts are the ones snap draws stand-ins in (cli/fonts.ts), which the
// live text probe of 2026-10-09 found Figma setting exactly as wide as Chrome
// does. So Chrome measures them here: each character's advance and each
// kerning pair among printable ASCII, in em, at every weight Figma has, and
// each font's height at line-height normal, Figma's AUTO.
// Kerning is kept for the weights text is usually set in, and the nearest of
// those stands in for the rest.
//
//   pnpm build && node scripts/figma-font-metrics.mjs [--check]
//
// --check writes nothing and fails when the file differs from what the
// installed fonts measure, as after an update of a font package.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "cli", "__tests__", "fixtures", "figma-fonts.json");
const { STAND_INS, STAND_IN_PREFIX, standInFaces } = await import(join(ROOT, "dist", "cli", "fonts.js"));
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

const { browser } = await resolveAndLaunch();
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>metrics</title>");
  const faces = STAND_INS.flatMap((standIn) => standInFaces(standIn));
  const { fonts, lines } = await page.evaluate(async ({ faces, prefix, families, weights, italic, kerned, chars, ascii }) => {
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
      ctx.font = `400 ${SIZE}px "${prefix}${family}"`;
      const m = ctx.measureText("H");
      lines[family] = em(m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
      for (const style of italic[family] ? ["", "i"] : [""]) {
        for (const weight of weights[family]) {
          ctx.font = `${style ? "italic " : ""}${weight} ${SIZE}px "${prefix}${family}"`;
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
  }, { faces, prefix: STAND_IN_PREFIX, families: STAND_INS, weights: WEIGHTS, italic: ITALIC, kerned: KERNED, chars: CHARS, ascii: ASCII });
  const file = {
    about: "Each character's advance and each kerning pair among printable ASCII, in em, as Chrome sets the fonts storysync draws stand-ins in, which Figma sets as wide (scripts/figma-font-metrics.mjs)",
    packages,
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
