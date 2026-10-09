// The Figma spike's answers, as every package takes them: each constant
// that depends on the spike says what it saw in fixtures/figma-spike.json,
// the raw results of its live run on 2026-10-08. mock-figma.test.ts holds
// the mock to the same results.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SPIKE as BUILD } from "../figma-spike.js";
import { THUMBNAIL_ENCODING } from "../snap-assets.js";
import { SPIKE as VERIFY } from "../verify-tree.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LIVE = JSON.parse(readFileSync(`${ROOT}cli/__tests__/fixtures/figma-spike.json`, "utf8"));
const items = LIVE.probe.items;
const image = LIVE.image.items.image;

test("spike: the live run answered every item, the image call included", () => {
  for (const name of ["svg", "shadow", "text", "absolute", "clone", "search", "returned", "time", "blend", "defaults", "sizing"]) {
    assert.ok(items[name] && !items[name].error, name);
  }
  assert.ok(image && !image.error);
  assert.equal(LIVE.upload.success, true);
});

test("spike: figma code's constants are what the spike saw", () => {
  // Item 1: lucide's 2px strokes at 24 came in 1.33 wide at 16, as Chrome draws them.
  const strokes = items.svg.kids.map((k: unknown[]) => k[5]);
  assert.deepEqual(strokes, [items.svg.expect, items.svg.expect]);
  assert.equal(BUILD.svgStrokesScale, true);
  // Item 11: across a hugging column, the filling child took its sibling's 120, and the column hugged.
  assert.deepEqual([items.sizing.fillAcross.parent.slice(0, 2), items.sizing.fillAcross.kids[1][2]], [[120, 32], 120]);
  assert.equal(BUILD.fillAcrossHug, true);
  // Item 4: the absolute child stayed at 3,4 under an INSIDE stroke included in layout.
  assert.deepEqual(items.absolute.at.INSIDE[4], ["ABSOLUTE", 3, 4]);
  assert.equal(BUILD.absoluteInsetByStroke, false);
  // Item 4: an OUTSIDE stroke took no room; the row stayed 44 wide, as with none.
  assert.deepEqual(items.absolute.at.OUTSIDE.slice(0, 2), [44, 20]);
  assert.deepEqual(items.absolute.at.CENTER.slice(0, 2), [44, 20]);
  assert.equal(BUILD.outsideStrokeTakesSpace, false);
  // Item 8: 400 frames and 100 labels in under 5 s.
  assert.ok(items.time.frames + items.time.texts + items.time.layout < 5000, JSON.stringify(items.time));
  assert.equal(BUILD.maxNodes, 400);
});

test("spike: verify's assumptions and the readback's return are what the spike saw", () => {
  // Item 10: the same bytes back, hashed by their SHA-1, and the hash reusable.
  assert.deepEqual([image.sameBytes, image.hashIsSha1, image.sameSize, image.reused, LIVE.upload.imageHash], [true, true, true, true, image.hash]);
  assert.equal(VERIFY.imageBytesKept, true);
  // Item 2: a spread of 1 kept, on a frame that clips and one that doesn't.
  assert.deepEqual([items.shadow.unclipped[0], items.shadow.clipped[0]], [1, 1]);
  assert.equal(VERIFY.shadowSpreadKept, true);
  // Item 3: ENDING and one line taken on a 94px label, kept 94 by 20.
  assert.deepEqual(items.text.truncated, ["HEIGHT", "ENDING", 1, 94, 20]);
  assert.equal(VERIFY.textTruncation, true);
  // Item 7: the tool gave the returned object as JSON, so the readback returns the object.
  assert.equal(items.returned.object, true);
  assert.match(LIVE.returnShape, /^object/);
  const template = readFileSync(`${ROOT}templates/readback.js`, "utf8");
  assert.match(template, /^const RETURN_TEXT = false;$/m);
});

test("spike: snap's thumbnails stay JPEG where opaque, as the upload kept a JPEG's bytes", () => {
  assert.equal(LIVE.upload.contentType, "image/jpeg");
  assert.equal(image.length, LIVE.upload.sizeBytes);
  assert.equal(THUMBNAIL_ENCODING.opaque, "image/jpeg");
});
