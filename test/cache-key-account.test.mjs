import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { zipSync } from "fflate";
import { clearZipCache, fetchPageBytes, zipCacheKeys } from "../src/comics.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function makeBytes(size, seed) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (seed * 17 + index) % 256;
  }
  return bytes;
}

function makeClient(username, zipBytes, counts) {
  return createWebDavClient({
    baseUrl: "http://nas.local/dav",
    username,
    password: "pw",
    request: async (spec) => {
      if (spec.method === "HEAD") {
        counts.head += 1;
        return {
          status: 200,
          statusText: "OK",
          url: spec.url,
          headers: { "content-length": String(zipBytes.length) },
          bytes: new Uint8Array(0)
        };
      }
      counts.get += 1;
      return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes: zipBytes };
    }
  });
}

test("cache-key-account 换账号同名 CBZ 不会拿到上一个库的字节", async () => {
  const zipA = zipSync({ "p1.png": makeBytes(120, 1) }, { level: 0 });
  const zipB = zipSync({ "p1.png": makeBytes(120, 2) }, { level: 0 });
  const countsA = { head: 0, get: 0 };
  const countsB = { head: 0, get: 0 };
  const clientA = makeClient("alice", zipA, countsA);
  const clientB = makeClient("bob", zipB, countsB);

  clearZipCache();
  const bytesA = await fetchPageBytes(clientA, { kind: "cbz", path: "/same.cbz", index: 0 });
  const bytesB = await fetchPageBytes(clientB, { kind: "cbz", path: "/same.cbz", index: 0 });

  assert.notEqual(sha256(bytesA), sha256(bytesB), "不同账号不能共享缓存");
  assert.equal(countsA.get, 1);
  assert.equal(countsB.get, 1);
  const keys = zipCacheKeys();
  assert.ok(keys.some((key) => key.includes("alice")), "缓存键应含账号 alice");
  assert.ok(keys.some((key) => key.includes("bob")), "缓存键应含账号 bob");

  const again = await fetchPageBytes(clientA, { kind: "cbz", path: "/same.cbz", index: 0 });
  assert.equal(sha256(again), sha256(bytesA));
  assert.equal(countsA.get, 1, "同账号同路径应命中缓存");
});
