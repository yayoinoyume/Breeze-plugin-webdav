/**
 * 请求层只拒绝「真实危险路径」：解码文本里的字面反斜杠、.. 段、控制字符。
 *
 * 注意 urlFor 的内部参数是解码文本（列表层给的就是解码后的 path），
 * 所以 "%5C" / "%2e%2e" 这种字面文件名是合法的，不应被拒；
 * 绝对 URL 的参数还是编码形态，会先宽松解码一次再检查。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDavPath } from "../src/util/names.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

const BACKSLASH = String.fromCharCode(92);

test("backslash-traversal 真实危险路径一律拒绝，合法怪名字放行", async () => {
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
  assert.throws(() => normalizeDavPath("/.." + BACKSLASH + ".." + BACKSLASH + "secret"), /反斜杠/);
  assert.throws(() => normalizeDavPath(".." + BACKSLASH + "secret"), /反斜杠/);

  // 相对路径（解码文本）：字面反斜杠、真实 .. 段拒绝。
  assert.throws(() => client.urlFor("/.." + BACKSLASH + ".." + BACKSLASH + "secret"), /反斜杠/);
  assert.throws(() => client.urlFor(".." + BACKSLASH + "secret"), /反斜杠/);
  assert.throws(() => client.urlFor("/comics/../secret"), /不能包含 \.\./);

  // 字面 %5C / %2e%2e 是合法文件名，不能误杀。
  assert.equal(
    client.urlFor("/a%5Cb.png"),
    "http://nas.local/dav/a%255Cb.png"
  );
  assert.equal(
    client.urlFor("/%252e%252e/x.png"),
    "http://nas.local/dav/%25252e%25252e/x.png"
  );
  assert.equal(client.canRequest("/a%5Cb.png"), true);
  assert.equal(client.canRequest("/comics/../secret"), false);
  assert.equal(client.canRequest("/comics" + BACKSLASH + "secret"), false);

  // 绝对 URL 是编码形态：先宽松解码一次再检查。
  assert.throws(
    () => client.urlFor("http://nas.local/dav/..%5C..%5Csecret"),
    /反斜杠/
  );
  assert.throws(
    () => client.urlFor("http://nas.local/dav/%2e%2e/secret"),
    /不能包含 \.\./
  );

  assert.equal(requests.length, 0, "被拒绝的路径不应发出任何请求");

  // 正常路径不受影响。
  assert.equal(normalizeDavPath("/漫画/第 01 页.png"), "/漫画/第 01 页.png");
  assert.equal(
    client.urlFor("/漫画/第 01 页.png"),
    "http://nas.local/dav/%E6%BC%AB%E7%94%BB/%E7%AC%AC%2001%20%E9%A1%B5.png"
  );
});
