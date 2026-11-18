/**
 * 环境保真测试：Breeze 的 QuickJS 运行时把全局 TextDecoder 换成了
 * text-encoding polyfill（rust/rquickjs_playground/js/04_runtime_base_polyfills.js）。
 * 该 polyfill 构造函数收到 { fatal: true } 会直接抛异常，而 Node 的 TextDecoder 支持它。
 *
 * 这里在加载 ids.ts 之前把 TextDecoder 换成行为等价的替身：
 *   - 带 fatal 选项 → 抛 TypeError（模拟 Breeze）
 *   - 不带选项 → 原生 UTF-8 解码
 * 用来保证 id / 页面 url 的编解码不再依赖 Node 专有的 fatal 选项。
 */
import assert from "node:assert/strict";
import test from "node:test";

const NativeTextDecoder = globalThis.TextDecoder;

class PolyfillTextDecoder {
  constructor(label = "utf-8", options) {
    if (options !== undefined && options !== null && options.fatal === true) {
      throw new TypeError("TextDecoder: the fatal option is not supported");
    }
    this._inner = new NativeTextDecoder(label);
  }

  get encoding() {
    return this._inner.encoding;
  }

  get fatal() {
    return this._inner.fatal;
  }

  get ignoreBOM() {
    return this._inner.ignoreBOM;
  }

  decode(input, options) {
    return this._inner.decode(input, options);
  }
}

test("polyfill-textdecoder：宿主 TextDecoder 拒绝 fatal 时 id 与页面 url 仍可往返", async () => {
  // 先验替身本身：带 fatal 必须抛，普通 UTF-8 必须能解。
  assert.throws(() => new PolyfillTextDecoder("utf-8", { fatal: true }), TypeError);
  assert.equal(
    new PolyfillTextDecoder("utf-8").decode(Uint8Array.from([0xe6, 0xbc, 0xab])),
    "漫"
  );

  globalThis.TextDecoder = PolyfillTextDecoder;
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
    globalThis.TextDecoder = NativeTextDecoder;
  }
});
