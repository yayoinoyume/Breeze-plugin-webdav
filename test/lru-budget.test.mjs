import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import {
  clearZipCache,
  fetchPageBytes,
  setZipCacheBudgetForTests,
  zipCacheBytes,
  zipCachePaths
} from "../src/comics.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

function makeBytes(size, seed) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (seed + index) % 256;
  }
  return bytes;
}

test("lru-budget CBZ 缓存按总字节预算逐出，超预算后重新下载", async () => {
  const zipA = zipSync({ "p1.png": makeBytes(120, 1) }, { level: 0 });
  const zipB = zipSync({ "p1.png": makeBytes(120, 2) }, { level: 0 });
  const budget = Math.max(zipA.length, zipB.length) + 1;
  const counts = { "/a.cbz": 0, "/b.cbz": 0 };

  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    username: "demo",
    password: "pw",
    request: async (spec) => {
      const path = new URL(spec.url).pathname.endsWith("/a.cbz") ? "/a.cbz" : "/b.cbz";
      if (spec.method === "HEAD") {
        const zip = path === "/a.cbz" ? zipA : zipB;
        return {
          status: 200,
          statusText: "OK",
          url: spec.url,
          headers: { "content-length": String(zip.length) },
          bytes: new Uint8Array(0)
        };
      }
      const zip = path === "/a.cbz" ? zipA : zipB;
      if (path === "/a.cbz") {
        counts["/a.cbz"] += 1;
      } else {
        counts["/b.cbz"] += 1;
      }
      return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes: zip };
    }
  });

  try {
    clearZipCache();
    setZipCacheBudgetForTests(budget);

    await fetchPageBytes(client, { kind: "cbz", path: "/a.cbz", index: 0 });
    assert.deepEqual(zipCachePaths(), ["/a.cbz"]);
    await fetchPageBytes(client, { kind: "cbz", path: "/b.cbz", index: 0 });

    assert.deepEqual(zipCachePaths(), ["/b.cbz"], "超出预算应逐出最早的包");
    assert.ok(zipCacheBytes() <= budget);

    await fetchPageBytes(client, { kind: "cbz", path: "/a.cbz", index: 0 });
    assert.equal(counts["/a.cbz"], 2, "被逐出的包应重新下载");
  } finally {
    setZipCacheBudgetForTests(null);
    clearZipCache();
  }
});
