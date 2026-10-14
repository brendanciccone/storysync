import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseUploadResponse, runFigmaUpload } from "../figma-upload.js";
import { codeFor, mockFor, runPlan } from "./figma-build-harness.js";
import { loadTreeFixture, treeFixtureAsset } from "./mock-figma.js";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const JPEG = "assets/513d06f54269-262b.jpg";

/** A local server standing in for upload_assets' URLs: records each POST, answering `status`. */
async function uploadServer(status = 200) {
  const posts: { path: string; type: string; bytes: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      posts.push({ path: req.url ?? "", type: String(req.headers["content-type"]), bytes: Buffer.concat(chunks) });
      res.writeHead(status).end(status === 200 ? "{}" : "denied");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { posts, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Avatar with a second image on its lg variant, built in the mock, its build result saved. */
async function builtAvatar() {
  const fixture = copy(loadTreeFixture("avatar"));
  const tree = fixture.components[0].tree;
  tree.assets.img["img:0000000000ff-0000"] = { ...tree.assets.img["img:513d06f54269-262b"], mime: "image/png" };
  const lg = fixture.components[0].variants[2] as unknown as { treeDelta: { set: Record<string, object> } };
  lg.treeDelta.set["avatar-image"] = { ...lg.treeDelta.set["avatar-image"], img: "img:0000000000ff-0000" };
  const coded = await codeFor(fixture);
  const [build] = await runPlan(mockFor([fixture]), coded, ["build"]);
  writeFileSync(join(coded.out, "results", "01.json"), build.text);
  const uploads = (build.value as { uploads: [string, string][] }).uploads;
  return { coded, uploads, plan: join(coded.out, "plan.json") };
}

test("figma upload: posts each thumbnail's exact bytes with its type, in the order of the build's layers", async () => {
  const { coded, uploads, plan } = await builtAvatar();
  assert.deepEqual(uploads.map((u) => u[1]), ["img:513d06f54269-262b", "img:0000000000ff-0000"]);
  const server = await uploadServer();
  try {
    // As figma-use documents upload_assets' answer: `uploads` of `submitUrl`s.
    writeFileSync(join(coded.out, "results", "01.upload.json"), JSON.stringify({ uploads: [{ submitUrl: `${server.url}/a` }, { submitUrl: `${server.url}/b` }], instructions: "POST the bytes" }));
    const { uploaded } = await runFigmaUpload({ plan, seq: 1 });
    const bytes = Buffer.from(treeFixtureAsset(JPEG));
    assert.deepEqual(uploaded, [
      { assetId: "img:513d06f54269-262b", nodeId: uploads[0][0], bytes: bytes.length },
      { assetId: "img:0000000000ff-0000", nodeId: uploads[1][0], bytes: bytes.length },
    ]);
    assert.deepEqual(server.posts.map((p) => [p.path, p.type]), [["/a", "image/jpeg"], ["/b", "image/png"]]);
    for (const post of server.posts) assert.ok(post.bytes.equals(bytes));
  } finally {
    await server.close();
  }
});

test("figma upload: URLs that name their layer are matched to it, whatever their order", async () => {
  const { coded, uploads, plan } = await builtAvatar();
  const server = await uploadServer();
  try {
    const text = JSON.stringify({ uploads: [{ submitUrl: `${server.url}/second`, targetNodeId: uploads[1][0].replace(":", "-") }, { submitUrl: `${server.url}/first`, targetNodeId: uploads[0][0] }] });
    // Saved as the tool's text: the answer as a JSON string inside an MCP envelope.
    writeFileSync(join(coded.out, "results", "01.upload.json"), JSON.stringify({ content: [{ type: "text", text }] }));
    await runFigmaUpload({ plan, seq: 1 });
    assert.deepEqual(server.posts.map((p) => [p.path, p.type]), [["/first", "image/jpeg"], ["/second", "image/png"]]);
  } finally {
    await server.close();
  }
});

test("figma upload: posts nothing when a URL is missing, the snap changed, or the response wasn't saved", async () => {
  const { coded, plan } = await builtAvatar();
  const server = await uploadServer();
  try {
    await assert.rejects(runFigmaUpload({ plan, seq: 1 }), /01\.upload\.json is missing: call upload_assets/);
    writeFileSync(join(coded.out, "results", "01.upload.json"), JSON.stringify({ uploads: [{ submitUrl: `${server.url}/a` }] }));
    await assert.rejects(runFigmaUpload({ plan, seq: 1 }), /the build listed 2 uploads and upload_assets gave 1 URL: ask it for count 2/);
    writeFileSync(join(coded.out, "results", "01.upload.json"), JSON.stringify({ uploads: [{ submitUrl: `${server.url}/a` }, { submitUrl: `${server.url}/b` }] }));
    appendFileSync(coded.snapPath, "\n");
    await assert.rejects(runFigmaUpload({ plan, seq: 1 }), /has changed since this plan was made from it: run figma code again/);
    assert.deepEqual(server.posts, []);
    await assert.rejects(runFigmaUpload({ plan, seq: 3 }), /call 3 is a label call: only a build call lists uploads/);
  } finally {
    await server.close();
  }
});

test("figma upload: a URL that refuses the bytes fails, saying how many went before it", async () => {
  const { coded, plan } = await builtAvatar();
  const server = await uploadServer(403);
  try {
    writeFileSync(join(coded.out, "results", "01.upload.json"), JSON.stringify({ uploads: [{ submitUrl: `${server.url}/a` }, { submitUrl: `${server.url}/b` }] }));
    await assert.rejects(runFigmaUpload({ plan, seq: 1 }), /uploading img:513d06f54269-262b to layer \d+:\d+ failed: HTTP 403: denied/);
  } finally {
    await server.close();
  }
});

test("figma upload: a build that listed no uploads posts nothing and needs no response", async () => {
  const fixture = loadTreeFixture("switch");
  const coded = await codeFor(fixture);
  const [build] = await runPlan(mockFor([fixture]), coded, ["build"]);
  writeFileSync(join(coded.out, "results", "01.json"), JSON.stringify(build.text));
  assert.deepEqual(await runFigmaUpload({ plan: join(coded.out, "plan.json"), seq: 1 }), { uploaded: [] });
});

test("parseUploadResponse: upload URLs in the answer however it was saved", () => {
  const answer = { uploads: [{ uploadUrl: "https://u/1", nodeId: "1:2" }, { url: "https://u/2" }] };
  assert.deepEqual(parseUploadResponse(JSON.stringify(answer)), [{ url: "https://u/1", nodeId: "1:2" }, { url: "https://u/2" }]);
  assert.deepEqual(parseUploadResponse(`Here are your upload URLs: ${JSON.stringify(answer)}`), [{ url: "https://u/1", nodeId: "1:2" }, { url: "https://u/2" }]);
  assert.throws(() => parseUploadResponse("{}"), /lists no upload URLs/);
});
