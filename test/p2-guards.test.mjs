import assert from "node:assert/strict";
import test from "node:test";
import { naturalCompare, normalizeDavPath } from "../src/util/names.ts";
import { decodeComicId, decodePathId, encodePathId, parsePageUrl } from "../src/webdav/ids.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

test("propfind-200-html PROPFIND 200 但返回 HTML 时提示不是 WebDAV 根", async () => {
  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    request: async (spec) => ({
      status: 200,
      statusText: "OK",
      url: spec.url,
      headers: { "content-type": "text/html; charset=utf-8" },
      bytes: new TextEncoder().encode("<html><body>hello</body></html>")
    })
  });

  await assert.rejects(() => client.list("/"), /这个地址不是 WebDAV 根/);
});

test("id-strict comicId 非法 base64 或含控制字符时返回 null，不发请求", () => {
  assert.equal(decodePathId("!!!!"), "");
  assert.equal(decodePathId("abc"), "");
  assert.equal(decodeComicId("dir:!!!!"), null);
  assert.equal(decodeComicId("dir:" + encodePathId("a\u0000b")), null);
  assert.equal(decodeComicId("dir:" + encodePathId("a\u001fb")), null);
  assert.equal(parsePageUrl("wdav://!!!!#0"), null);
  assert.equal(decodeComicId("dir:" + encodePathId("/正常/路径"))?.path, "/正常/路径");
});

test("dav-path-traversal normalizeDavPath 拒绝 .. 段", () => {
  assert.throws(() => normalizeDavPath("/comics/../secret"), /不能包含 \.\./);
  assert.throws(() => normalizeDavPath("a/../../b"), /不能包含 \.\./);
  assert.equal(normalizeDavPath("/comics/漫画/"), "/comics/漫画");
});


test("natural-sort 对齐 Breeze：小写化、数字按 int、忽略前导零", () => {
  assert.ok(naturalCompare("2.png", "10.png") < 0);
  assert.ok(naturalCompare("a2.png", "a10.png") < 0);
  assert.equal(naturalCompare("A.png", "a.png"), 0);
  assert.equal(naturalCompare("01.png", "1.png"), 0);
});
