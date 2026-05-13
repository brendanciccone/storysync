// §3.1 — Image asset fetcher. When a story renders an `<img>` or has
// a `background-image: url(...)`, we capture the URL via the render
// extractor, then this module fetches the bytes via Playwright's page
// context (so it inherits the iframe's auth/cookies) and packages
// them as base64 for inline use in the Figma plugin script.
//
// The emitted script registers each image once via figma.createImage,
// keeps the resulting hash in an `IMAGES` map, and component child
// payloads reference by hash via `{ im: <hash> }`. Same dedupe model
// as the SVG library (§A.1).

import type { Page } from "playwright-core";

export interface ImageAsset {
  hash: string;        // stable content hash (used as IMAGES key)
  base64: string;      // raw PNG/JPEG bytes, base64-encoded
  mime: string;        // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  width: number;       // intrinsic width
  height: number;      // intrinsic height
}

// Fetches a list of asset URLs from the same browser context the
// renderer is using. Skips data: URLs (those would be inlined twice
// otherwise), tracks failures into the returned array's `failures`
// metadata so the caller can warn the user without aborting.
export async function fetchAssets(
  page: Page,
  urls: string[],
): Promise<{ assets: Map<string, ImageAsset>; failures: Array<{ url: string; reason: string }> }> {
  const assets = new Map<string, ImageAsset>();
  const failures: Array<{ url: string; reason: string }> = [];

  // Deduplicate URLs first so we don't refetch the same logo per
  // variant. Map key is the canonical URL, value is the first one
  // we saw (preserves casing).
  const unique = Array.from(new Set(urls.filter((u) => u && !u.startsWith("data:"))));

  for (const url of unique) {
    try {
      const result = await page.evaluate(async (u: string) => {
        // Browser context: inherits CORS / cookies / referer.
        const res = await fetch(u);
        if (!res.ok) return { ok: false as const, reason: `HTTP ${res.status}` };
        const blob = await res.blob();
        const arr = new Uint8Array(await blob.arrayBuffer());
        // Convert to base64 in chunks (large images can blow the
        // call-stack of String.fromCharCode.apply).
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < arr.length; i += CHUNK) {
          bin += String.fromCharCode(...arr.subarray(i, i + CHUNK));
        }
        const base64 = btoa(bin);
        return { ok: true as const, base64, mime: blob.type || "image/png" };
      }, url);
      if (!result.ok) {
        failures.push({ url, reason: result.reason });
        continue;
      }
      // Measure intrinsic dimensions via a hidden <img>. Same context.
      const dims = await page.evaluate(
        ([b64, mime]) =>
          new Promise<{ w: number; h: number }>((resolve) => {
            const im = new Image();
            im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
            im.onerror = () => resolve({ w: 0, h: 0 });
            im.src = `data:${mime};base64,${b64}`;
          }),
        [result.base64, result.mime] as const,
      );
      const hash = hashAsset(result.base64);
      assets.set(url, {
        hash,
        base64: result.base64,
        mime: result.mime,
        width: dims.w,
        height: dims.h,
      });
    } catch (err) {
      failures.push({ url, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { assets, failures };
}

// Stable short hash for an asset's base64 string. Matches the SVG
// hashing scheme — IMAGES key form `i<hex>`.
function hashAsset(s: string): string {
  let h = 5381;
  // Sample at most the first 64KB to keep hashing fast on big assets;
  // content variation in modern image formats lives in the header.
  const limit = Math.min(s.length, 65536);
  for (let i = 0; i < limit; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "i" + Math.abs(h).toString(36).padStart(6, "0");
}

// Render the image registration block that the apply loop expects at
// the top of a component script. Empty when no assets were captured.
// Accepts a Map (from in-memory capture) or a plain object (from a
// serialized InspectionResult, which is the form pushgen sees).
export function emitImagesBlock(
  assets: Map<string, ImageAsset> | Record<string, { base64: string; mime?: string; width?: number; height?: number }>,
): string {
  const pairs: string[] = [];
  if (assets instanceof Map) {
    for (const a of assets.values()) {
      pairs.push(`${JSON.stringify(a.hash)}:${JSON.stringify(a.base64)}`);
    }
  } else {
    for (const [hash, a] of Object.entries(assets)) {
      pairs.push(`${JSON.stringify(hash)}:${JSON.stringify(a.base64)}`);
    }
  }
  if (!pairs.length) return "  const IMAGES = {};";
  return [
    `  const IMAGE_BYTES = {${pairs.join(",")}};`,
    `  const IMAGES = {};`,
    `  for (const _k of Object.keys(IMAGE_BYTES)) {`,
    `    const _b = IMAGE_BYTES[_k];`,
    `    const _arr = Uint8Array.from(atob(_b), (c) => c.charCodeAt(0));`,
    `    try { IMAGES[_k] = figma.createImage(_arr).hash; } catch {}`,
    `  }`,
  ].join("\n");
}
