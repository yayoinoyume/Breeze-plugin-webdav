/**
 * 反斜杠绕过回归测试。
 *
 * 只按 "/" 分段时，"/..\..\secret" 里的 ".." 不是独立段，
 * 会原样发成 /dav/..%5C..%5Csecret；某些 WebDAV 服务器把反斜杠当目录分隔符，
 * 于是能读到 rootPath 之外。这里断言相对路径、绝对 URL、%5C 编码形式都被拒绝，
 * 而且一次请求都不会发出去。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDavPath } from "../src/util/names.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

test("backslash-traversal 反斜杠路径一律拒绝，且不发请求", async () => {
  const requests = [];
  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    request: async (spec) => {
      requests.push(spec);
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: {},
        bytes: new Uint8Array(0)
      };
    }
  });

  // 内部路径（normalize 层）：字面反斜杠直接拒绝。
  assert.throws(() => normalizeDavPath("/..\\..\\secret"), /反斜杠/);
  assert.throws(() => normalizeDavPath("..\\..\\secret"), /反斜杠/);
  assert.throws(() => normalizeDavPath("/comics\\..\\secret"), /反斜杠/);

  // 相对路径（URL 层）：字面量与 %5C / %5c 编码形式都要拦。
  assert.throws(() => client.urlFor("/..\\..\\secret"), /反斜杠/);
  assert.throws(() => client.urlFor("/..%5C..%5Csecret"), /反斜杠/);
  assert.throws(() => client.urlFor("/..%5c..%5csecret"), /反斜杠/);
  assert.throws(() => client.urlFor("..\\..\\secret"), /反斜杠/);

  // 绝对 URL 同样要过同一道检查。
  assert.throws(
    () => client.urlFor("http://nas.local/dav/..\\..\\secret"),
    /反斜杠/
  );
  assert.throws(
    () => client.urlFor("http://nas.local/dav/..%5C..%5Csecret"),
    /反斜杠/
  );

  // 走完整链路（PROPFIND）也必须先抛，请求数为 0。
  await assert.rejects(() => client.list("/..%5C..%5Csecret"), /反斜杠/);
  await assert.rejects(() => client.propfind("/..\\..\\secret"), /反斜杠/);
  assert.equal(requests.length, 0, "被拒绝的路径不应发出任何请求");

  // 正常路径不受影响。
  assert.equal(normalizeDavPath("/漫画/第 01 页.png"), "/漫画/第 01 页.png");
  assert.equal(
    client.urlFor("/漫画/第 01 页.png"),
    "http://nas.local/dav/%E6%BC%AB%E7%94%BB/%E7%AC%AC%2001%20%E9%A1%B5.png"
  );
  assert.equal(requests.length, 0);
});
