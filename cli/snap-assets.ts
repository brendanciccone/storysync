// What snap keeps of the SVG icons and images a component draws: SVG markup
// rebuilt from what the browser computed, and the crop and file name of each
// image's thumbnail.
//
// The page hands back structure and raw computed values (snap-browser.ts);
// everything here is pure, so it is tested without a browser, and every color
// goes through the same normalizeColor as the rest of styles.json: one color
// path, so an icon and the button it sits in can't differ by a rounding step.

import { createHash } from "node:crypto";
import { fnv1a32 } from "./checksum.js";
import { normalizeColor } from "./snap-normalize.js";
import type { Box } from "./tree-types.js";

const r2 = (n: number): number => Math.round(Math.round(n * 1e8) / 1e6) / 100 || 0;

// --- SVG ----------------------------------------------------------------------

/**
 * One element of an inline SVG as the page reads it: its geometry attributes
 * as written, and for a shape its paint as the browser computed it, so paint
 * set by a class, a `currentColor` or an ancestor is resolved. `raw` keeps
 * the markup of an element snap doesn't rebuild (a gradient, a mask, `use`,
 * `text`) as written.
 */
export interface RawSvgNode {
  tag: string;
  attrs: Record<string, string>;
  paint?: Record<string, string>;
  kids?: RawSvgNode[];
  raw?: string;
}

/** Shapes rebuilt from their geometry and paint. */
export const SVG_SHAPE_TAGS: readonly string[] = ["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"];

/** Elements that draw nothing and say nothing Figma keeps. */
export const SVG_DROPPED_TAGS: readonly string[] = ["title", "desc", "metadata"];

/** Geometry attributes, in the order the markup writes them. */
export const SVG_GEOMETRY: readonly string[] = [
  "d", "points", "x", "y", "width", "height", "r", "rx", "ry", "cx", "cy", "x1", "y1", "x2", "y2", "transform",
];

/** Attributes the root `<svg>` keeps besides its size. */
const SVG_ROOT_ATTRS = ["viewBox", "preserveAspectRatio"] as const;

/** Paint the page reads off each shape, as computed style property names. */
export const SVG_PAINT_PROPERTIES: readonly string[] = [
  "fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "fill-rule", "clip-rule",
];

/**
 * Paint attributes in the order they're written, and their SVG defaults,
 * which are left out. Of these, every one but `opacity` inherits, so one that
 * every shape shares moves to the root `<svg>`, where each shape inherits it:
 * a lucide icon's stroke, width and caps are written once. `opacity` doesn't
 * inherit, and on the root it would fade the icon as one layer rather than
 * each shape, so it stays on its shapes.
 */
const PAINT_ORDER = ["fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "fill-rule", "clip-rule"] as const;
const PAINT_DEFAULTS: Record<string, string> = {
  fill: "#000000", "fill-opacity": "1", stroke: "none", "stroke-opacity": "1", "stroke-width": "1",
  "stroke-linecap": "butt", "stroke-linejoin": "miter", opacity: "1", "fill-rule": "nonzero", "clip-rule": "nonzero",
};
const HOISTED = new Set(["fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule"]);

/** A number as the markup writes it: rounded to 0.01, no trailing zeros. */
function num(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(r2(n)) : value;
}

/** An attribute value, escaped for a double-quoted XML attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * A shape's paint as the markup writes it: each color as hex through
 * normalizeColor, its alpha moved into the matching opacity (multiplied with
 * any opacity already there), a paint server's `url()` kept as written, a
 * color that draws nothing as `none`, and the stroke's width, caps and joins
 * dropped when there is no stroke to draw them.
 */
function shapePaint(raw: Record<string, string>, flags: string[]): Record<string, string> {
  const paint: Record<string, string> = {};
  for (const name of ["fill", "stroke"] as const) {
    const value = (raw[name] ?? PAINT_DEFAULTS[name]).trim();
    const opacityName = `${name}-opacity`;
    const opacity = Number(raw[opacityName] ?? "1");
    if (value === "none") {
      paint[name] = "none";
      continue;
    } else if (/^url\(/i.test(value)) {
      // A gradient or pattern: kept by reference, its definition in a raw <defs>.
      paint[name] = value.replace(/^url\(\s*"?([^")]*)"?\s*\)(.*)$/i, "url($1)$2");
      flags.push("paint-server");
    } else {
      const hex = normalizeColor(value);
      if (!hex) {
        paint[name] = "none";
        continue;
      }
      paint[name] = hex.slice(0, 7);
      const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
      const combined = r2(alpha * (Number.isFinite(opacity) ? opacity : 1));
      if (combined !== 1) paint[opacityName] = String(combined);
      continue;
    }
    if (Number.isFinite(opacity) && opacity !== 1) paint[opacityName] = String(r2(opacity));
  }
  for (const name of ["stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "fill-rule", "clip-rule"]) {
    const value = raw[name];
    if (value === undefined || value === "") continue;
    paint[name] = name === "stroke-width" ? num(value.replace(/px$/, "")) : name === "opacity" ? num(value) : value.trim();
  }
  if (paint.stroke === "none") {
    for (const name of ["stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-opacity"]) delete paint[name];
  }
  for (const [name, value] of Object.entries(paint)) if (PAINT_DEFAULTS[name] === value) delete paint[name];
  return paint;
}

interface Shape { tag: string; geometry: [string, string][]; paint: Record<string, string> }

/**
 * An inline SVG as markup snap stores, rebuilt from what the browser drew
 * rather than copied from the page: geometry kept as written, every paint
 * as computed (section 6.6 of the design), sized to the box the browser drew
 * it at, without `class`, `style`, `aria-*` or `data-*`. Paint every shape
 * shares is written once on the root. A `<g>` with a transform is kept
 * around its shapes, and one without is dropped, its shapes in its place.
 *
 * What createNodeFromSvg may not import (a definition, a mask, a clip path,
 * `use`, `text`, a nested `<svg>`) is kept as the page wrote it and named
 * in `flags`, so the node can say its vector is approximate.
 */
export function serializeSvg(root: RawSvgNode, box: Box): { markup: string; flags: string[] } {
  const flags: string[] = [];
  // Markup in order, a shape's left until the paint shared by all is known.
  const pieces: (string | Shape)[] = [];
  const shapes: Shape[] = [];
  const visit = (node: RawSvgNode) => {
    if (SVG_DROPPED_TAGS.includes(node.tag)) return;
    if (node.raw !== undefined) {
      flags.push(node.tag);
      pieces.push(node.raw);
      return;
    }
    if (node.tag === "g") {
      const geometry = SVG_GEOMETRY.filter((a) => node.attrs[a] !== undefined).map((a) => `${a}="${escapeAttr(node.attrs[a])}"`);
      if (geometry.length) pieces.push(`<g ${geometry.join(" ")}>`);
      for (const kid of node.kids ?? []) visit(kid);
      if (geometry.length) pieces.push("</g>");
      return;
    }
    if (SVG_SHAPE_TAGS.includes(node.tag)) {
      const shape: Shape = {
        tag: node.tag,
        geometry: SVG_GEOMETRY.filter((a) => node.attrs[a] !== undefined).map((a) => [a, node.attrs[a]]),
        paint: shapePaint(node.paint ?? {}, flags),
      };
      shapes.push(shape);
      pieces.push(shape);
      return;
    }
    // Not raw, not a shape or a group: an element the page didn't expect.
    flags.push(node.tag);
  };
  for (const kid of root.kids ?? []) visit(kid);

  // Paint every shape shares goes to the root, and off the shapes.
  const hoisted: Record<string, string> = {};
  for (const name of PAINT_ORDER) {
    if (!HOISTED.has(name) || !shapes.length) continue;
    const values = shapes.map((s) => s.paint[name] ?? PAINT_DEFAULTS[name]);
    if (!values.every((v) => v === values[0])) continue;
    if (values[0] !== PAINT_DEFAULTS[name]) hoisted[name] = values[0];
    for (const shape of shapes) delete shape.paint[name];
  }

  const attrs = (pairs: [string, string][]) => pairs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
  const rootAttrs: [string, string][] = [["xmlns", "http://www.w3.org/2000/svg"], ["width", String(r2(box[2]))], ["height", String(r2(box[3]))]];
  for (const name of SVG_ROOT_ATTRS) if (root.attrs[name] !== undefined) rootAttrs.push([name, root.attrs[name]]);
  for (const name of PAINT_ORDER) if (hoisted[name] !== undefined) rootAttrs.push([name, hoisted[name]]);
  const body = pieces.map((piece) => {
    if (typeof piece === "string") return piece;
    const { tag, geometry, paint } = piece;
    const paintPairs = PAINT_ORDER.filter((name) => paint[name] !== undefined).map((name): [string, string] => [name, paint[name]]);
    return `<${tag}${attrs(geometry)}${attrs(paintPairs)}/>`;
  }).join("");
  return { markup: `<svg${attrs(rootAttrs)}>${body}</svg>`, flags: [...new Set(flags)] };
}

/** An SVG's asset id: `svg:` and the FNV-1a of its markup, so one icon drawn alike anywhere is stored once. */
export function svgAssetId(markup: string): string {
  return `svg:${fnv1a32(markup)}`;
}

// --- Images -------------------------------------------------------------------

/**
 * What of an image a box shows, and where: `src` the rectangle of the
 * source's pixels it draws, and `dst` where in the box they land, as
 * fractions of its width and height. `key` names the crop for the asset id:
 * the source rectangle, and the destination when the image doesn't fill the
 * box, or fills it stretched to a shape other than its own.
 */
export interface ImageCrop {
  src: [x: number, y: number, w: number, h: number];
  dst: [x: number, y: number, w: number, h: number];
  key: string;
}

/**
 * One axis of `object-position`: a percentage of the room left over, or a
 * length from the start. Chromium computes keywords to percentages.
 */
function positionOffset(token: string | undefined, room: number): number {
  const value = (token ?? "50%").trim();
  const percent = /^(-?\d*\.?\d+)%$/.exec(value);
  if (percent) return (Number(percent[1]) / 100) * room;
  const px = /^(-?\d*\.?\d+)px$/.exec(value);
  if (px) return Number(px[1]);
  return room / 2;
}

/**
 * The part of an image a box of `box` CSS px shows, as `object-fit` and
 * `object-position` place it (`fill`, CSS's initial value, stretches it to
 * the box). Independent of the box's scale: the 24, 32 and 40px Avatar show
 * the same crop, so share one asset.
 */
export function imageCrop(natural: [number, number], box: [number, number], fit: string, position: string): ImageCrop {
  const [W, H] = natural;
  const [bw, bh] = box;
  const full: ImageCrop["dst"] = [0, 0, 1, 1];
  if (!(W > 0 && H > 0 && bw > 0 && bh > 0)) return { src: [0, 0, r2(W), r2(H)], dst: full, key: `0,0,${r2(W)},${r2(H)}` };
  let sx: number;
  let sy: number;
  switch (fit.trim()) {
    case "contain": sx = sy = Math.min(bw / W, bh / H); break;
    case "cover": sx = sy = Math.max(bw / W, bh / H); break;
    case "none": sx = sy = 1; break;
    case "scale-down": sx = sy = Math.min(1, bw / W, bh / H); break;
    default: sx = bw / W; sy = bh / H; break;
  }
  const rw = W * sx;
  const rh = H * sy;
  const [px, py] = position.trim().split(/\s+/);
  const ox = positionOffset(px, bw - rw);
  const oy = positionOffset(py, bh - rh);
  // The image's rendered rectangle, cut to the box.
  const vx0 = Math.max(0, ox);
  const vy0 = Math.max(0, oy);
  const vx1 = Math.min(bw, ox + rw);
  const vy1 = Math.min(bh, oy + rh);
  const src: ImageCrop["src"] = [r2((vx0 - ox) / sx), r2((vy0 - oy) / sy), r2((vx1 - vx0) / sx), r2((vy1 - vy0) / sy)];
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4 || 0;
  const dst: ImageCrop["dst"] = [r4(vx0 / bw), r4(vy0 / bh), r4((vx1 - vx0) / bw), r4((vy1 - vy0) / bh)];
  let key = src.join(",");
  if (dst.some((v, i) => v !== full[i])) key += `@${dst.join(",")}`;
  // Stretched to the box: a box of another shape shows another picture.
  else if (sx !== sy) key += `~${r4(bw / bh)}`;
  return { src, dst, key };
}

/**
 * An image's asset id: the first 12 hex digits of its source bytes' SHA-256,
 * and 4 of the FNV-1a of its crop. One photo cropped two ways is two assets;
 * one crop of it at three sizes is one.
 */
export function imageAssetId(source: Uint8Array, cropKey: string): string {
  return `img:${createHash("sha256").update(source).digest("hex").slice(0, 12)}-${fnv1a32(cropKey).slice(0, 4)}`;
}

/** Where an asset's file goes, relative to the directory holding styles.json: no colon, which Windows can't name a file with. */
export function imageAssetFile(id: string, mime: "image/jpeg" | "image/png"): string {
  return `assets/${id.replace(/^img:/, "")}.${mime === "image/png" ? "png" : "jpg"}`;
}

/** The longest side a thumbnail is drawn at, in pixels. */
export const THUMBNAIL_MAX_SIDE = 1024;

/**
 * A thumbnail's pixel size: twice the box, as the screenshots are taken, so
 * Figma has the pixels a 2x display shows, and at most THUMBNAIL_MAX_SIDE on
 * its longer side.
 */
export function thumbnailSize(box: [number, number]): [number, number] {
  const [w, h] = [box[0] * 2, box[1] * 2];
  const scale = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(w, h, 1));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

/** An image's type from its first bytes, for the data URL the page draws it from; null when it isn't one a browser surely draws. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  const head = Buffer.from(bytes.subarray(0, 256)).toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return "image/svg+xml";
  if (bytes.length > 12 && Buffer.from(bytes.subarray(4, 12)).toString("latin1") === "ftypavif") return "image/avif";
  return null;
}

/** A PNG's pixel size from its header, or null for anything else. */
export function pngSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

/** A `data:` URL's bytes and type, or null for any other URL. */
export function decodeDataUrl(url: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  const base64 = /;base64/i.test(m[2]);
  const bytes = base64 ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  return { bytes: new Uint8Array(bytes), mime: m[1] || "text/plain" };
}
