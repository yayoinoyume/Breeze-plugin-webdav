/**
 * Breeze（QuickJS）运行时 TextDecoder 的测试替身。
 *
 * 真实实现来自 text-encoding polyfill：
 *   - 构造函数对任意 truthy 的 options.fatal 直接抛 Error（不是 TypeError）；
 *   - decode 对任意 truthy 的 options.stream 直接抛 Error。
 *
 * BOM 行为不做断言：Breeze 自带的 polyfill 源码（04_runtime_base_polyfills.js）
 * 不在本工作区，无法核实。可核实的参照是 npm text-encoding@0.7.0
 * lib/encoding.js:1176-1186：ignoreBOM 未设置时默认剥掉开头 BOM，
 * 与 Node 原生 TextDecoder 默认一致，所以替身直接用原生默认。
 * Node 原生 TextDecoder 两个选项都支持，所以只有装上这个替身，
 * 本机测试才能复现「真机 polyfill 行为」与 Node 的差异。
 *
 * 用法：import { PolyfillTextDecoder, withPolyfillTextDecoder } ...
 *      - 需要精确控制时自己 new / 全局替换；
 *      - 常规场景用 withPolyfillTextDecoder(fn) 包住被测代码。
 */

const NativeTextDecoder = globalThis.TextDecoder;

export class PolyfillTextDecoder {
  constructor(label = "utf-8", options) {
    if (options !== undefined && options !== null && options.fatal) {
      throw new Error('The "fatal" option is not supported by the text-encoding polyfill');
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
    if (options !== undefined && options !== null && options.stream) {
      throw new Error('The "stream" option is not supported by the text-encoding polyfill');
    }
    return this._inner.decode(input);
  }
}

/** 把全局 TextDecoder 换成替身，返回恢复函数。 */
export function installPolyfillTextDecoder() {
  globalThis.TextDecoder = PolyfillTextDecoder;
  return () => {
    globalThis.TextDecoder = NativeTextDecoder;
  };
}

/** 在替身生效期间执行 fn（同步或异步），结束恢复原实现。 */
export async function withPolyfillTextDecoder(fn) {
  const restore = installPolyfillTextDecoder();
  try {
    return await fn();
  } finally {
    restore();
  }
}
