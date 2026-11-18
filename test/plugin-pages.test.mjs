import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { buildChapterWithPages, clearZipCache } from "../src/comics.ts";
import { decodeComicId, encodeComicId, parsePageUrl } from "../src/webdav/ids.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

function davEntry(href, isCollection = false) {
  return { href, isCollection, contentLength: null, lastModified: null };
}

function makeBytes(size, seed) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (seed + index) % 251;
  }
  return bytes;
}

function dirClient(paths) {
  return {
    async list() {
      return paths.map((path) => davEntry("/dav" + encodeURI(path)));
    },
    relativePath(href) {
      return decodeURIComponent(String(href).replace(/^\/dav/, ""));
    }
  };
}

test("plugin-pages 目录漫画按自然序排页（p2 在 p10 前）", async () => {
  const client = dirClient(["/合集/p10.png", "/合集/p2.png", "/合集/p1.png", "/合集/notes.txt"]);
  const chapter = await buildChapterWithPages(client, { kind: "dir", path: "/合集" });

  assert.equal(chapter.id, encodeComicId("dir", "/合集"));
  assert.equal(chapter.requestId, chapter.id);
  assert.equal(chapter.logicalKey, chapter.id);
  assert.equal(chapter.storageChapterId, chapter.id);
  assert.equal(chapter.name, "全一话");
  assert.equal(chapter.order, 0);
  assert.deepEqual(chapter.pages.map((page) => page.name), ["p1.png", "p2.png", "p10.png"]);
  assert.deepEqual(chapter.pages.map((page) => page.path), [
    "/合集/p1.png",
    "/合集/p2.png",
    "/合集/p10.png"
  ]);
  assert.equal(new Set(chapter.pages.map((page) => page.id)).size, 3);
  assert.equal(chapter.pages[0].extern.kind, "dir");
  assert.equal(chapter.pages[0].extern.imagePath, "/合集/p1.png");
  assert.deepEqual(parsePageUrl(chapter.pages[2].url), { path: "/合集", index: 2 });
});

test("plugin-pages CBZ 读中央目录并按自然序排页", async () => {
  const zipBytes = zipSync(
    {
      "p10.png": makeBytes(64, 10),
      "p2.png": makeBytes(64, 2),
      "p1.png": makeBytes(64, 1),
      "readme.txt": makeBytes(8, 0)
    },
    { level: 0 }
  );

  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    username: "demo",
    password: "demo",
    request: async (spec) => {
      if (spec.method === "HEAD") {
        return {
          status: 200,
          statusText: "OK",
          url: spec.url,
          headers: { "content-length": String(zipBytes.length) },
          bytes: new Uint8Array(0)
        };
      }
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: {},
        bytes: zipBytes
      };
    }
  });

  clearZipCache();
  const chapter = await buildChapterWithPages(client, { kind: "cbz", path: "/合集.cbz" });
  assert.deepEqual(chapter.pages.map((page) => page.name), ["p1.png", "p2.png", "p10.png"]);
  assert.deepEqual(chapter.pages.map((page) => page.path), ["p1.png", "p2.png", "p10.png"]);
  assert.deepEqual(chapter.pages.map((page) => page.extern.entry), ["p1.png", "p2.png", "p10.png"]);
  assert.equal(chapter.pages.every((page) => page.extern.kind === "cbz"), true);
  assert.equal(parsePageUrl(chapter.pages[1].url)?.path, "/合集.cbz");
  assert.deepEqual(decodeComicId(chapter.id), { kind: "cbz", path: "/合集.cbz" });
});

test("plugin-pages 空目录和空 CBZ 给出人话错误", async () => {
  await assert.rejects(
    () => buildChapterWithPages(dirClient(["/空/readme.txt"]), { kind: "dir", path: "/空" }),
    /这个目录里没有图片/
  );

  const emptyZip = zipSync({ "readme.txt": makeBytes(8, 0) }, { level: 0 });
  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    request: async (spec) =>
      spec.method === "HEAD"
        ? {
            status: 200,
            statusText: "OK",
            url: spec.url,
            headers: { "content-length": String(emptyZip.length) },
            bytes: new Uint8Array(0)
          }
        : { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes: emptyZip }
  });
  clearZipCache();
  await assert.rejects(
    () => buildChapterWithPages(client, { kind: "cbz", path: "/空.cbz" }),
    /CBZ 里没有图片/
  );
});
