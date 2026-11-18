import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";
import { clearZipCache, fetchPageBytes, zipCachePaths } from "../src/comics.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

function makeBytes(size, seed) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (seed * 31 + index) % 256;
  }
  return bytes;
}

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

const dirImage = makeBytes(96, 3);
const zipFiles = {
  "p1.png": makeBytes(128, 1),
  "p2.png": makeBytes(128, 2),
  "p10.png": makeBytes(128, 10)
};
const zipBytes = zipSync(zipFiles, { level: 6 });
const files = new Map([
  ["/漫画/p1.png", dirImage],
  ["/合集.cbz", zipBytes]
]);

function fakeServer(requests) {
  return async (spec) => {
    requests.push(spec);
    const path = decodeURIComponent(new URL(spec.url).pathname.replace(/^\/dav/, ""));
    const bytes = files.get(path);
    if (spec.method === "HEAD") {
      return {
        status: bytes === undefined ? 404 : 200,
        statusText: "OK",
        url: spec.url,
        headers: bytes === undefined ? {} : { "content-length": String(bytes.length) },
        bytes: new Uint8Array(0)
      };
    }
    if (bytes === undefined) {
      return { status: 404, statusText: "Not Found", url: spec.url, headers: {}, bytes: new Uint8Array(0) };
    }
    return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes };
  };
}

function makeClient(requests) {
  return createWebDavClient({
    baseUrl: "http://nas.local/dav",
    username: "demo",
    password: "demo",
    rootPath: "/",
    request: fakeServer(requests)
  });
}

test("plugin-fetch 目录图片带认证 GET，sha256 与 fixture 一致", async () => {
  const requests = [];
  const client = makeClient(requests);
  const bytes = await fetchPageBytes(client, {
    kind: "dir",
    path: "/漫画",
    imagePath: "/漫画/p1.png",
    index: 0
  });

  assert.equal(sha256(bytes), sha256(dirImage));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.match(requests[0].headers.Authorization, /^Basic /);
});

test("plugin-fetch CBZ 页与 fixture 一致，整包只下载一次（LRU）", async () => {
  const requests = [];
  const client = makeClient(requests);
  clearZipCache();

  const first = await fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 0 });
  const second = await fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", entry: "p10.png" });
  const third = await fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 1 });

  assert.equal(sha256(first), sha256(zipFiles["p1.png"]));
  assert.equal(sha256(second), sha256(zipFiles["p10.png"]));
  assert.equal(sha256(third), sha256(zipFiles["p2.png"]));
  assert.deepEqual(zipCachePaths(), ["/合集.cbz"]);

  const packageGets = requests.filter(
    (spec) => spec.method === "GET" && spec.url.endsWith(".cbz")
  );
  assert.equal(packageGets.length, 1, "同一包应命中模块内 LRU");
  const expected = unzipSync(zipBytes)["p2.png"];
  assert.equal(sha256(third), sha256(expected));
});
