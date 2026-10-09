// The stand-in fonts snap measures text in and the build asks Figma for
// (cli/fonts.ts), held to what the live text probe found in Figma.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  PLATFORM_FACES, STAND_INS, needsStandIn, stackFamilies, standInDrawn, standInFaces, standInFor, standInStack,
} from "../fonts.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PROBE = JSON.parse(readFileSync(`${ROOT}cli/__tests__/fixtures/figma-text-probe.json`, "utf8")) as {
  call1: { fonts: Record<string, { axes: unknown; styles: string[] }> };
  call3: { has: string[]; lacks: string[] };
};

test("standInFor: Roboto Mono for a monospace family, Noto Serif for a serif, Inter for any other", () => {
  for (const mono of ["monospace", "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Courier New", "Liberation Mono", "Lucida Console", "Geist Mono"]) {
    assert.equal(standInFor(mono), "Roboto Mono", mono);
  }
  for (const serif of ["serif", "ui-serif", "Georgia", "Times New Roman", "Times"]) assert.equal(standInFor(serif), "Noto Serif", serif);
  for (const sans of ["system-ui", "sans-serif", "ui-sans-serif", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Helvetica Neue", "Arial"]) {
    assert.equal(standInFor(sans), "Inter", sans);
  }
});

test("needsStandIn: a CSS keyword, or a platform face Figma lacks; a font Figma has, or the project loads, keeps its own", () => {
  for (const family of ["system-ui", "ui-sans-serif", "-apple-system", "monospace", "Menlo", "Segoe UI", "Helvetica Neue", "Georgia", "SFMono-Regular"]) {
    assert.equal(needsStandIn(family), true, family);
  }
  for (const family of ["Inter", "Geist", "Geist Mono", "Roboto", "SF Pro", "Ubuntu", "Noto Sans", "Söhne"]) assert.equal(needsStandIn(family), false, family);
});

test("PLATFORM_FACES: each is a face Figma's plugin context lacked in the live probe, and none it had", () => {
  const lacks = new Set(PROBE.call3.lacks.map((f) => f.toLowerCase()));
  for (const face of PLATFORM_FACES) assert.ok(lacks.has(face), face);
  for (const face of PROBE.call3.has) assert.equal(PLATFORM_FACES.has(face.toLowerCase()), false, face);
  // Every face it lacked is a stand-in's, a keyword's or one listed.
  for (const face of PROBE.call3.lacks) assert.ok(needsStandIn(face) || /emoji/i.test(face), face);
  // And it has each stand-in, Inter with the axes of Inter 3.19, whose metrics snap measures with.
  for (const standIn of STAND_INS) assert.ok(PROBE.call3.has.includes(standIn), standIn);
  assert.deepEqual(PROBE.call1.fonts.Inter.axes, ["slnt", "wght"]);
});

test("stackFamilies: a computed font-family's families, unquoted, its quoted commas kept", () => {
  assert.deepEqual(stackFamilies('ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"'),
    ["ui-sans-serif", "system-ui", "sans-serif", "Apple Color Emoji", "Segoe UI Emoji"]);
  assert.deepEqual(stackFamilies(`"Odd, Name", 'Single', serif`), ["Odd, Name", "Single", "serif"]);
  assert.deepEqual(stackFamilies(""), []);
});

test("standInStack: a stack that opens with a keyword or a face Figma lacks gets its stand-in ahead of it, any other stays", () => {
  const sans = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji"';
  assert.deepEqual(standInStack(sans), { stack: `"storysync Inter", ${sans}`, standIn: "Inter" });
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  assert.deepEqual(standInStack(mono), { stack: `"storysync Roboto Mono", ${mono}`, standIn: "Roboto Mono" });
  assert.equal(standInStack('"Helvetica Neue", Arial, sans-serif')!.standIn, "Inter");
  assert.equal(standInStack("Georgia, serif")!.standIn, "Noto Serif");
  // A font the project loads, Figma has, or snap already stood in.
  assert.equal(standInStack('Geist, "Geist Fallback", ui-sans-serif, system-ui'), null);
  assert.equal(standInStack("Inter, sans-serif"), null);
  assert.equal(standInStack(`"storysync Inter", ${sans}`), null);
  assert.equal(standInStack(""), null);
});

test("standInDrawn: the Figma family of a family snap added to the page, null for any other", () => {
  assert.equal(standInDrawn("storysync Inter"), "Inter");
  assert.equal(standInDrawn("storysync Roboto Mono"), "Roboto Mono");
  assert.equal(standInDrawn("storysync Comic Sans"), null);
  assert.equal(standInDrawn("Inter"), null);
});

test("standInFaces: each stand-in's faces from its package, every subset, under snap's own family name", () => {
  const inter = standInFaces("Inter");
  // Inter 3.19 has no italic of its own: seven subsets, upright, its weight axis whole.
  assert.equal(inter.length, 7);
  assert.ok(inter.every((f) => f.family === "storysync Inter" && f.style === "normal" && f.weight === "100 900" && f.data.length > 1000));
  assert.ok(inter.some((f) => /U\+0000-00FF/.test(f.unicodeRange)), "the Latin subset");
  assert.equal(standInFaces("Inter"), inter, "read once");
  const mono = standInFaces("Roboto Mono");
  assert.deepEqual([...new Set(mono.map((f) => `${f.style} ${f.weight}`))].sort(), ["italic 100 700", "normal 100 700"]);
  assert.ok(standInFaces("Noto Serif").some((f) => f.style === "italic"));
  // The woff2 bytes, as the package ships them.
  const latin = inter.find((f) => /U\+0000-00FF/.test(f.unicodeRange))!;
  assert.equal(Buffer.from(latin.data, "base64").subarray(0, 4).toString("latin1"), "wOF2");
});

test("the stand-ins are the font versions Figma has, and the mock's metrics were measured from them", () => {
  const manifest = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { dependencies: Record<string, string> };
  // Inter 3.19: 5.0.20 and later ship Inter 4, which Figma doesn't set as wide (the text probe's call 1).
  assert.equal(manifest.dependencies["@fontsource-variable/inter"], "5.0.18");
  const require = createRequire(import.meta.url);
  const metrics = JSON.parse(readFileSync(`${ROOT}cli/__tests__/fixtures/figma-fonts.json`, "utf8")) as { packages: Record<string, string> };
  for (const [name, version] of Object.entries(metrics.packages)) {
    assert.equal(manifest.dependencies[name], version, `${name}: pinned as measured`);
    const installed = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")) as { version: string };
    assert.equal(installed.version, version, `${name}: run scripts/figma-font-metrics.mjs after updating it`);
  }
});
