import assert from "node:assert/strict";
import test from "node:test";
import { fetchPageBytes } from "../src/comics.ts";
import { createWebDavClient, normalizeBaseUrl, originOf } from "../src/webdav/client.ts";

test("cross-origin 绝对 URL 指向别的站点时不发请求、不带 Authorization", async () => {
  const requests = [];
  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    username: "demo",
    password: "demo",
    request: async (spec) => {
      requests.push(spec);
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: {},
        bytes: new Uint8Array([1, 2, 3])
      };
    }
  });

  assert.equal(originOf("http://nas.local/dav/a"), "http://nas.local");
  assert.throws(
    () => client.urlFor("http://evil.example/steal.png"),
    /不允许访问其他站点的地址/
  );

  await assert.rejects(
    () =>
      fetchPageBytes(client, {
        kind: "dir",
        path: "http://evil.example/",
        imagePath: "http://evil.example/steal.png"
      }),
    /不允许访问其他站点的地址/
  );
  assert.equal(requests.length, 0, "跨站地址不应发出请求");
});

test("cross-origin baseUrl 里的 userinfo 会被剥离，不会进入请求 URL", () => {
  const userInfoPassword = ["url", "pw"].join("");
  const normalized = normalizeBaseUrl("http://alice:" + userInfoPassword + "@nas.local/dav/");
  assert.equal(normalized, "http://nas.local/dav");
  assert.equal(normalized.includes(userInfoPassword), false);
  assert.equal(normalized.includes("@"), false);
});


test("default-port originOf 归一 http:80 与 https:443，不再误判跨站", () => {
  assert.equal(originOf("http://nas.local:80/dav"), "http://nas.local");
  assert.equal(originOf("https://nas.local:443/dav"), "https://nas.local");
  assert.equal(originOf("http://nas.local:8080/dav"), "http://nas.local:8080");
  assert.equal(originOf("HTTP://NAS.LOCAL:80/dav"), "http://nas.local");

  const client = createWebDavClient({
    baseUrl: "http://nas.local:80/dav",
    request: async (spec) => ({
      status: 200,
      statusText: "OK",
      url: spec.url,
      headers: {},
      bytes: new Uint8Array(0)
    })
  });
  assert.equal(client.urlFor("http://nas.local/dav/x.png"), "http://nas.local/dav/x.png");
});
