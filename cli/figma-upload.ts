// `storysync figma upload`: posts the images a build call asked for.
//
// use_figma can't create an image (figma-use: upload_assets is the only
// path), so a build leaves each image it can't fill from one already in the
// file as an empty keyed layer and lists it in its result's `uploads`, one
// layer per image. The agent asks upload_assets for that many upload URLs,
// with those layers as targets, and saves the response unchanged; this reads
// both files and posts each thumbnail snap saved to its URL, which puts it on
// its layer. The images call then copies it to every other layer showing it.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fnv1a32Bytes } from "./checksum.js";
import { extractFirstBalancedObject } from "./figma.js";
import { readCallResult, readPlan } from "./figma-code.js";
import type { ComponentTree, ImageAsset } from "./tree-types.js";

/** One upload URL from upload_assets, with the layer it fills when the response says. */
interface UploadTarget {
  url: string;
  nodeId?: string;
}

const URL_FIELDS = ["submitUrl", "uploadUrl", "url"];

/**
 * The upload URLs in an upload_assets response saved unchanged: its
 * `uploads`, each with `submitUrl` (as figma-use documents it; `uploadUrl`
 * and `url` are taken too) and `targetNodeId` where it names the layer.
 */
export function parseUploadResponse(text: string): UploadTarget[] {
  const found: UploadTarget[][] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      try {
        visit(JSON.parse(trimmed), depth + 1);
      } catch {
        // Prose around the JSON: the object inside it.
        const inner = extractFirstBalancedObject(trimmed);
        if (inner && inner !== trimmed) visit(inner, depth + 1);
      }
      return;
    }
    if (Array.isArray(value)) {
      const targets = value
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => {
          const url = URL_FIELDS.map((f) => item[f]).find((u): u is string => typeof u === "string");
          const node = item.targetNodeId ?? item.nodeId;
          return url ? { url, ...(typeof node === "string" ? { nodeId: node.replace("-", ":") } : {}) } : null;
        });
      if (targets.length && targets.every((t) => t)) found.push(targets as UploadTarget[]);
      else for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.uploads)) return visit(record.uploads, depth + 1);
      for (const inner of Object.values(record)) visit(inner, depth + 1);
    }
  };
  visit(text, 0);
  if (found.length !== 1) {
    throw new Error(found.length ? "the upload_assets response lists upload URLs more than once" : "the upload_assets response lists no upload URLs (submitUrl)");
  }
  return found[0];
}

/** Every image asset in a snap, by id. */
function assetsOf(snapPath: string): Map<string, ImageAsset> {
  const snap = JSON.parse(readFileSync(snapPath, "utf8")) as { components?: { tree?: ComponentTree }[] };
  const out = new Map<string, ImageAsset>();
  for (const component of snap.components ?? []) {
    for (const [id, asset] of Object.entries(component.tree?.assets.img ?? {})) out.set(id, asset);
  }
  return out;
}

/**
 * Posts each image a build call listed in `uploads` to the URL
 * upload_assets gave for its layer: the snap's thumbnail, byte for byte, with
 * its own Content-Type, in the order of the layers. Each URL is single-use,
 * so it posts nothing unless every upload has a URL, a file and the snap the
 * plan was made from.
 */
export async function runFigmaUpload(opts: { plan: string; seq: number; fetch?: typeof fetch }): Promise<{ uploaded: { assetId: string; nodeId: string; bytes: number }[] }> {
  const plan = readPlan(opts.plan);
  const call = plan.calls.find((c) => c.seq === opts.seq);
  if (!call) throw new Error(`${opts.plan} has no call ${opts.seq}`);
  if (call.kind !== "build") throw new Error(`call ${opts.seq} is a ${call.kind} call: only a build call lists uploads`);
  const result = readCallResult(opts.plan, call.result, "build");
  const uploads = (result.uploads ?? []) as [string, string][];
  if (!Array.isArray(uploads) || uploads.some((u) => !Array.isArray(u) || typeof u[0] !== "string" || typeof u[1] !== "string")) {
    throw new Error(`${call.result} has no list of uploads a build returns`);
  }
  if (!uploads.length) return { uploaded: [] };

  const responsePath = join(dirname(opts.plan), call.result.replace(/\.json$/, ".upload.json"));
  let response: string;
  try {
    response = readFileSync(responsePath, "utf8");
  } catch {
    throw new Error(`${responsePath} is missing: call upload_assets for this call's uploads and save its response there, unchanged`);
  }
  const targets = parseUploadResponse(response);
  if (targets.length !== uploads.length) {
    throw new Error(`the build listed ${uploads.length} upload${uploads.length === 1 ? "" : "s"} and upload_assets gave ${targets.length} URL${targets.length === 1 ? "" : "s"}: ask it for count ${uploads.length}, with the build's node ids in order`);
  }
  const byNode = targets.every((t) => t.nodeId);
  const pairs = uploads.map(([nodeId, assetId], i) => {
    const target = byNode ? targets.find((t) => t.nodeId === nodeId) : targets[i];
    if (!target) throw new Error(`upload_assets gave no URL for layer ${nodeId}: pass the build's node ids as its nodeIds, in order`);
    return { nodeId, assetId, url: target.url };
  });

  const snapPath = resolve(dirname(opts.plan), plan.snap.path);
  const snapBytes = readFileSync(snapPath);
  if (fnv1a32Bytes(snapBytes) !== plan.snap.digest) {
    throw new Error(`${snapPath} has changed since this plan was made from it: run figma code again, and send its calls`);
  }
  const assets = assetsOf(snapPath);
  const assetsDir = join(dirname(snapPath), "assets");
  const files = pairs.map(({ assetId }) => {
    const asset = assets.get(assetId);
    if (!asset) throw new Error(`the snap has no image ${assetId}`);
    if (asset.mime !== "image/png" && asset.mime !== "image/jpeg") throw new Error(`the snap's image ${assetId} is a ${String(asset.mime)}, not the PNG or JPEG snap saves`);
    const path = resolve(dirname(snapPath), asset.file);
    const missing = () => new Error(`${path} is missing: snap saves image thumbnails beside styles.json, under assets/`);
    let real: string;
    let root: string;
    try {
      real = realpathSync(path);
      root = realpathSync(assetsDir);
    } catch {
      throw missing();
    }
    // Each is posted to a URL the saved response gives, so an image whose
    // file was another, `../../.ssh/id_rsa` or a link to it, would post it.
    if (!real.startsWith(root + sep)) {
      throw new Error(`the snap's image ${assetId} is ${path}, which is not in ${assetsDir}, where snap saves image thumbnails: take the snap again`);
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const file = readFileSync(real);
      bytes = new Uint8Array(new ArrayBuffer(file.length));
      bytes.set(file);
    } catch {
      throw missing();
    }
    return { bytes, mime: asset.mime };
  });

  const post = opts.fetch ?? fetch;
  const uploaded: { assetId: string; nodeId: string; bytes: number }[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const { nodeId, assetId, url } = pairs[i];
    const { bytes, mime } = files[i];
    const res = await post(url, { method: "POST", headers: { "Content-Type": mime }, body: bytes });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`uploading ${assetId} to layer ${nodeId} failed: HTTP ${res.status}${body ? `: ${body}` : ""}${uploaded.length ? ` (${uploaded.length} uploaded before it)` : ""}`);
    }
    uploaded.push({ assetId, nodeId, bytes: bytes.length });
  }
  return { uploaded };
}
