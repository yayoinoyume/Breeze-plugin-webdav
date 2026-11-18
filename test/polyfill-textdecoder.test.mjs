/**
 * 环境保真测试：Breeze 的 QuickJS 运行时把全局 TextDecoder 换成了
 * text-encoding polyfill（rust/rquickjs_playground/js/04_runtime_base_polyfills.js）。
 * 该 polyfill 构造函数收到任意 truthy 的 { fatal } 会直接抛异常，
 * decode 收到任意 truthy 的 { stream } 也会抛，而 Node 的 TextDecoder 都支持。
 *
 * 替身统一放在 test/support/polyfill-textdecoder.mjs，供本文件与
 * id-without-extern.test.mjs 共用：先验替身本身与真机一致，
 * 再在替身生效期间断言 id / 页面 url 的编解码不依赖 Node 专有选项。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PolyfillTextDecoder,
  installPolyfillTextDecoder
} from "./support/polyfill-textdecoder.mjs";

test("polyfill-shim-equivalence 替身与 Breeze 的 text-encoding polyfill 一致：truthy fatal/stream 均抛 Error", () => {
  // 任意 truthy 的 fatal 都抛 Error（真实 polyfill 不区分 true / 1 / "x"，也不是 TypeError）。
  for (const fatal of [true, 1, "x", {}, []]) {
    assert.throws(
      () => new PolyfillTextDecoder("utf-8", { fatal }),
      (error) => error instanceof Error && !(error instanceof TypeError),
      "fatal=" + JSON.stringify(fatal) + " 应抛 Error"
    );
  }
  // falsy 的 fatal 不抛，缺省也不抛。
  assert.doesNotThrow(() => new PolyfillTextDecoder("utf-8", { fatal: false }));
  assert.doesNotThrow(() => new PolyfillTextDecoder("utf-8", { fatal: 0 }));
  assert.doesNotThrow(() => new PolyfillTextDecoder("utf-8"));

  // stream 同理：真实 polyfill 不支持流式解码。
  for (const stream of [true, 1, "x"]) {
    assert.throws(
      () => new PolyfillTextDecoder("utf-8").decode(Uint8Array.from([0xe6]), { stream }),
      (error) => error instanceof Error && !(error instanceof TypeError),
      "stream=" + JSON.stringify(stream) + " 应抛 Error"
    );
  }
  assert.equal(
    new PolyfillTextDecoder("utf-8").decode(Uint8Array.from([0xe6, 0xbc, 0xab])),
    "漫"
  );
});

test("polyfill-textdecoder：宿主 TextDecoder 拒绝 fatal 时 id 与页面 url 仍可往返", async () => {
  // 先验替身本身：带 fatal 必须抛，普通 UTF-8 必须能解。
  assert.throws(() => new PolyfillTextDecoder("utf-8", { fatal: true }), Error);
  assert.equal(
    new PolyfillTextDecoder("utf-8").decode(Uint8Array.from([0xe6, 0xbc, 0xab])),
    "漫"
  );

  const restore = installPolyfillTextDecoder();
  try {
    const ids = await import("../src/webdav/ids.ts");

    const paths = [
      "/漫画",
      "/漫画/第 01 页.png",
      "/comics/100%20/a%20b.png",
      "/合集 第 2 卷.cbz",
      "/emoji-😀.cbz",
      "/with space/和 中文.png"
    ];

    for (const path of paths) {
      const dirId = ids.encodeComicId("dir", path);
      assert.deepEqual(ids.decodeComicId(dirId), { kind: "dir", path }, "dir 往返：" + path);

      const cbzId = ids.encodeComicId("cbz", path);
      assert.deepEqual(ids.decodeComicId(cbzId), { kind: "cbz", path }, "cbz 往返：" + path);

      const pageUrl = ids.encodePageUrl(path, 7);
      assert.deepEqual(ids.parsePageUrl(pageUrl), { path, index: 7 }, "页面 url 往返：" + path);
    }

    // 非法 UTF-8（0xff）仍必须被拒绝：靠 U+FFFD 检查，而不是 fatal 选项。
    assert.equal(ids.decodePathId("_w"), "");
    assert.equal(ids.decodeComicId("dir:_w"), null);
    assert.equal(ids.parsePageUrl("wdav://_w#0"), null);
  } finally {
    restore();
  }
});
