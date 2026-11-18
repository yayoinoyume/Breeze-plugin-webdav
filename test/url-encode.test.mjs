import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBasicAuthHeader,
  encodeBase64Utf8,
  encodePath,
  normalizeBaseUrl,
  resolveUrl
} from "../src/webdav/client.ts";

test("url-encode 中文与空格路径逐段编码", () => {
  assert.equal(
    encodePath("/漫画/第 01 页.png"),
    "/%E6%BC%AB%E7%94%BB/%E7%AC%AC%2001%20%E9%A1%B5.png"
  );
  assert.equal(
    resolveUrl("http://nas.local:5005/dav", "/漫画/第 01 页.png"),
    "http://nas.local:5005/dav/%E6%BC%AB%E7%94%BB/%E7%AC%AC%2001%20%E9%A1%B5.png"
  );
  assert.equal(normalizeBaseUrl("nas.local:5005/dav/"), "http://nas.local:5005/dav");
});

test("url-encode 保留已有转义并生成 UTF-8 Basic 认证头", () => {
  assert.equal(encodePath("/a%20b/中文.cbz"), "/a%20b/%E4%B8%AD%E6%96%87.cbz");
  assert.equal(
    resolveUrl("http://nas.local/dav", "http://nas.local/dav/a%20b/x.cbz?download=1"),
    "http://nas.local/dav/a%20b/x.cbz?download=1"
  );

  const expected =
    "Basic " + Buffer.from("用户:密码123", "utf8").toString("base64");
  assert.equal(encodeBase64Utf8("用户:密码123"), Buffer.from("用户:密码123", "utf8").toString("base64"));
  assert.equal(buildBasicAuthHeader("用户", "密码123"), expected);
  assert.equal(buildBasicAuthHeader("", ""), null);
});
