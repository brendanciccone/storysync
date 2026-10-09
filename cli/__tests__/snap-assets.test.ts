// Tests for the SVG markup and image crops snap keeps of what a component draws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decodeDataUrl, imageAssetFile, imageAssetId, imageCrop, pngSize, serializeSvg, sniffImageType, svgAssetId, thumbnailSize,
} from "../snap-assets.js";
import type { RawSvgNode } from "../snap-assets.js";
import { fnv1a32 } from "../checksum.js";

/** A shape's paint as Chromium computes it for a lucide icon in a #0a0a0a button. */
const LUCIDE_PAINT = {
  fill: "none", "fill-opacity": "1", stroke: "oklch(0.145 0 0)", "stroke-opacity": "1", "stroke-width": "2px",
  "stroke-linecap": "round", "stroke-linejoin": "round", opacity: "1", "fill-rule": "nonzero", "clip-rule": "nonzero",
};

const shape = (tag: string, attrs: Record<string, string>, paint: Record<string, string> = LUCIDE_PAINT): RawSvgNode => ({ tag, attrs, paint });

test("serializeSvg: a lucide icon as computed, its shared paint on the root in hex, sized to its box", () => {
  const mail: RawSvgNode = {
    tag: "svg", attrs: { viewBox: "0 0 24 24" },
    kids: [shape("path", { d: "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" }), shape("rect", { x: "2", y: "4", width: "20", height: "16", rx: "2" })],
  };
  const { markup, flags } = serializeSvg(mail, [11, 10, 16, 16]);
  assert.equal(markup,
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg>');
  assert.deepEqual(flags, []);
  // How the drawing fits its box, where it says, goes with it.
  assert.match(serializeSvg({ ...mail, attrs: { viewBox: "0 0 24 12", preserveAspectRatio: "xMinYMid meet" } }, [0, 0, 16, 16]).markup,
    /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="16" height="16" viewBox="0 0 24 12" preserveAspectRatio="xMinYMid meet" fill="none"/);
  // Package T's fixture holds this icon, in white, under the same id.
  const white = serializeSvg({ ...mail, kids: mail.kids!.map((k) => ({ ...k, paint: { ...LUCIDE_PAINT, stroke: "rgb(250, 250, 250)" } })) }, [11, 10, 16, 16]);
  assert.equal(svgAssetId(white.markup), "svg:75dee6f9");
});

test("serializeSvg: alpha moves into an opacity, a shape's own paint stays on it, opacity never moves up", () => {
  const icon: RawSvgNode = {
    tag: "svg", attrs: { viewBox: "0 0 24 24" },
    kids: [
      shape("circle", { cx: "12", cy: "12", r: "10" }, { fill: "rgba(223, 34, 37, 0.3)", stroke: "none", "stroke-width": "2px", opacity: "0.5" }),
      shape("path", { d: "M0 0h4" }, { fill: "rgb(0, 0, 0)", stroke: "rgb(0, 0, 0)", "stroke-width": "1.5px", "stroke-opacity": "0.5" }),
    ],
  };
  const { markup } = serializeSvg(icon, [0, 0, 24, 24]);
  assert.equal(markup,
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<circle r="10" cx="12" cy="12" fill="#df2225" fill-opacity="0.3" opacity="0.5"/>' +
    '<path d="M0 0h4" stroke="#000000" stroke-opacity="0.5" stroke-width="1.5"/></svg>');
  // Every shape at half opacity: still each its own, never the icon's as one layer.
  const faded = serializeSvg({ tag: "svg", attrs: {}, kids: [shape("path", { d: "M0 0" }, { ...LUCIDE_PAINT, opacity: "0.5" }), shape("path", { d: "M1 1" }, { ...LUCIDE_PAINT, opacity: "0.5" })] }, [0, 0, 8, 8]);
  assert.equal(faded.markup,
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" fill="none" stroke="#0a0a0a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M0 0" opacity="0.5"/><path d="M1 1" opacity="0.5"/></svg>');
});

test("serializeSvg: a group's opacity and effects are kept on it; dashes and vector-effect on their shapes", () => {
  const icon: RawSvgNode = {
    tag: "svg", attrs: { viewBox: "0 0 24 24" },
    kids: [
      // A group fading two shapes as one; a shape's own fill inherits from it, as computed.
      { tag: "g", attrs: {}, paint: { opacity: "0.3", "clip-path": "none", mask: "none", filter: "none" }, kids: [
        shape("path", { d: "M0 0h4" }, { fill: "rgb(255, 0, 0)", stroke: "none" }),
        shape("path", { d: "M0 4h4" }, { fill: "rgb(255, 0, 0)", stroke: "none" }),
      ] },
      { tag: "g", attrs: { transform: "rotate(45)" }, paint: { opacity: "1", "clip-path": 'url("#c")', mask: "none", filter: "none" }, kids: [
        shape("circle", { cx: "12", cy: "12", r: "4" }, { ...LUCIDE_PAINT, "stroke-dasharray": "4px, 2px", "stroke-dashoffset": "1px", "vector-effect": "non-scaling-stroke" }),
      ] },
      // A group that does nothing is no group: its shape takes its place.
      { tag: "g", attrs: {}, paint: { opacity: "1", "clip-path": "none", mask: "none", filter: "none" }, kids: [shape("rect", { width: "2", height: "2" }, { fill: "none", stroke: "none", "stroke-dasharray": "4px" })] },
    ],
  };
  const { markup, flags } = serializeSvg(icon, [0, 0, 24, 24]);
  assert.equal(markup,
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<g opacity="0.3"><path d="M0 0h4" fill="#ff0000"/><path d="M0 4h4" fill="#ff0000"/></g>' +
    '<g transform="rotate(45)" clip-path="url(#c)"><circle r="4" cx="12" cy="12" fill="none" stroke="#0a0a0a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'stroke-dasharray="4 2" stroke-dashoffset="1" vector-effect="non-scaling-stroke"/></g>' +
    '<rect width="2" height="2" fill="none"/></svg>');
  assert.deepEqual(flags, ["clip-path"]);
});

test("serializeSvg: a group's transform is kept around its shapes; definitions and text are kept as written, and named", () => {
  const icon: RawSvgNode = {
    tag: "svg", attrs: {},
    kids: [
      { tag: "title", attrs: {}, raw: "<title>x</title>" },
      { tag: "g", attrs: { transform: "translate(2 2)" }, kids: [shape("line", { x1: "0", y1: "0", x2: "4", y2: "4" })] },
      { tag: "g", attrs: {}, kids: [shape("path", { d: "M1 1" }, { ...LUCIDE_PAINT, stroke: 'url("#grad")' })] },
      { tag: "defs", attrs: {}, raw: '<defs><linearGradient id="grad"/></defs>' },
      { tag: "text", attrs: {}, raw: "<text>A</text>" },
    ],
  };
  const { markup, flags } = serializeSvg(icon, [0, 0, 8, 8]);
  assert.equal(markup,
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<g transform="translate(2 2)"><line x1="0" y1="0" x2="4" y2="4" stroke="#0a0a0a"/></g><path d="M1 1" stroke="url(#grad)"/>' +
    '<defs><linearGradient id="grad"/></defs><text>A</text></svg>');
  assert.deepEqual(flags, ["paint-server", "defs", "text"]);
});

test("imageCrop: what of an image its box shows, the same at any size", () => {
  // The Avatar's square photo covering its circle: package T's crop key.
  const avatar = imageCrop([460, 460], [32, 32], "cover", "50% 50%");
  assert.deepEqual(avatar, { src: [0, 0, 460, 460], dst: [0, 0, 1, 1], key: "0,0,460,460" });
  assert.equal(imageCrop([460, 460], [40, 40], "cover", "50% 50%").key, avatar.key);
  // A wide photo covering a square: its middle, or its left at 0%.
  assert.deepEqual(imageCrop([400, 200], [100, 100], "cover", "50% 50%").src, [100, 0, 200, 200]);
  assert.deepEqual(imageCrop([400, 200], [100, 100], "cover", "0% 50%").src, [0, 0, 200, 200]);
  // Contained: all of it, in the middle of the box.
  assert.deepEqual(imageCrop([400, 200], [100, 100], "contain", "50% 50%"), { src: [0, 0, 400, 200], dst: [0, 0.25, 1, 0.5], key: "0,0,400,200@0,0.25,1,0.5" });
  // Stretched, CSS's default: a box of another shape shows another picture.
  assert.equal(imageCrop([400, 200], [100, 100], "fill", "50% 50%").key, "0,0,400,200~1");
  assert.equal(imageCrop([400, 200], [100, 50], "fill", "50% 50%").key, "0,0,400,200");
  // Unscaled, placed 10px in: what lands in the box.
  assert.deepEqual(imageCrop([50, 50], [100, 100], "none", "10px 10px").dst, [0.1, 0.1, 0.5, 0.5]);
  // A background's size: lengths, a share of the box, or the image's own.
  assert.deepEqual(imageCrop([32, 32], [64, 64], "16px 16px", "50% 50%"), { src: [0, 0, 32, 32], dst: [0.375, 0.375, 0.25, 0.25], key: "0,0,32,32@0.375,0.375,0.25,0.25" });
  assert.deepEqual(imageCrop([400, 200], [100, 100], "100% auto", "50% 50%").dst, [0, 0.25, 1, 0.5]);
  assert.deepEqual(imageCrop([50, 50], [100, 100], "auto", "0% 0%").dst, [0, 0, 0.5, 0.5]);
  assert.equal(fnv1a32(avatar.key).slice(0, 4), "262b");
});

test("imageAssetId and imageAssetFile: the source's SHA-256 and the crop's FNV; a file name without the colon, and with the thumbnail's FNV", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const id = imageAssetId(bytes, "0,0,460,460");
  assert.equal(id, `img:${sha}-262b`);
  assert.equal(imageAssetFile(id, "image/jpeg", "dfca076c"), `assets/${sha}-262b-dfca076c.jpg`);
  assert.equal(imageAssetFile(id, "image/png", "43bb538e"), `assets/${sha}-262b-43bb538e.png`);
});

test("thumbnailSize: twice the box, at most 1024 on the longer side", () => {
  assert.deepEqual(thumbnailSize([40, 40]), [80, 80]);
  assert.deepEqual(thumbnailSize([102.5, 51]), [205, 102]);
  assert.deepEqual(thumbnailSize([1280, 640]), [1024, 512]);
});

test("sniffImageType, pngSize and decodeDataUrl: what bytes are, and what a data: URL holds", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000050000000280806000000", "hex");
  assert.equal(sniffImageType(png), "image/png");
  assert.deepEqual(pngSize(png), [80, 40]);
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>")), "image/svg+xml");
  assert.equal(sniffImageType(Buffer.from("<html>not found</html>")), null);
  assert.equal(pngSize(Buffer.from([0xff, 0xd8])), null);
  const svg = decodeDataUrl("data:image/svg+xml;utf8,%3Csvg%2F%3E")!;
  assert.equal(Buffer.from(svg.bytes).toString(), "<svg/>");
  assert.equal(decodeDataUrl(`data:image/png;base64,${png.toString("base64")}`)!.mime, "image/png");
  assert.equal(decodeDataUrl("https://example.test/a.png"), null);
  // A `%` that starts no escape is itself, as browsers read it: an inline
  // SVG's `width='100%'` threw, and failed its variant.
  const inline = decodeDataUrl("data:image/svg+xml;utf8,<svg width='100%' fill='%23f00'/>")!;
  assert.equal(Buffer.from(inline.bytes).toString(), "<svg width='100%' fill='#f00'/>");
  assert.equal(Buffer.from(decodeDataUrl("data:text/plain,50%25 off %zz é")!.bytes).toString(), "50% off %zz é");
});
