/**
 * 错误文案回归测试：区分「payload 里根本没有 comicId」与「id 传了但解不开」。
 *
 * 以前两种情况都报「缺少漫画 id，无法打开」，而 ids.ts 还会把解码异常吞成空串，
 * 真正的 id 损坏会伪装成没传 id，排查方向被带偏。
 */
import assert from "node:assert/strict";
import test from "node:test";
import "breeze-plugin-kit/node";
import { resolveComicRef } from "../src/comics.ts";
import { encodeComicId, encodePathId } from "../src/webdav/ids.ts";

test("id-invalid-message 没传 id 报缺少，id 损坏报格式无效", () => {
  // 完全没有 comicId：保持原文案。
  for (const comicId of [undefined, null, "", "   "]) {
    assert.throws(
      () => resolveComicRef(comicId, {}),
      /缺少漫画 id，无法打开/,
      "没有 id 应报缺少：" + String(comicId)
    );
  }

  // 有 id 但解不开：非法 UTF-8、NUL、控制字符、base64url 非法、前缀不认识、空 payload。
  const brokenIds = [
    "dir:" + encodePathId("a\u0000b"),
    "dir:" + encodePathId("a\u001fb"),
    "dir:_w", // 非法 UTF-8（0xff）
    "dir:!!!!", // 非法 base64url
    "dir:abc", // 长度非法
    "nodir:abcdef", // 前缀不认识
    "dir:" // payload 为空
  ];
  for (const comicId of brokenIds) {
    assert.throws(
      () => resolveComicRef(comicId, {}),
      /漫画 id 格式无效（可能已损坏）/,
      "损坏的 id 应报格式无效：" + comicId
    );
  }

  // 合法 id 仍能解，extern 兜底也不受影响。
  assert.deepEqual(resolveComicRef(encodeComicId("dir", "/漫画"), {}), {
    kind: "dir",
    path: "/漫画"
  });
  assert.deepEqual(resolveComicRef(undefined, { kind: "cbz", path: "/合集.cbz" }), {
    kind: "cbz",
    path: "/合集.cbz"
  });
});
