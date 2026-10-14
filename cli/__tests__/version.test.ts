import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";

test("VERSION matches package.json", () => {
  // Drifting these apart makes the CLI misreport itself to `--version`, to both
  // MCP handshakes, and in the `storysyncVersion` stamped into every snapshot —
  // so a committed styles.json would name a producer that never produced it.
  // Compiled to dist/cli/__tests__/, so the manifest is three levels up.
  const manifestPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
  assert.equal(VERSION, manifest.version);
});

test("package.json's engines name only what installing the package needs", () => {
  // Published with the package, so pnpm and npm check every field against
  // the user's own: a pnpm or npm version here is this repo's, and warns or,
  // under engine-strict, fails `pnpm add -g storysync` for a user on an
  // older one. Contributors get theirs from packageManager and CONTRIBUTING.
  const manifestPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { engines?: Record<string, string>; packageManager?: string };
  assert.deepEqual(Object.keys(manifest.engines ?? {}), ["node"]);
  assert.match(manifest.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+$/);
});
