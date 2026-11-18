import assert from "node:assert/strict";
import test from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { searchComic } from "../src/comics.ts";
import { SETTING_KEYS } from "../src/settings.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

function hostResponse(status) {
  return JSON.stringify({
    ok: true,
    status,
    statusText: "",
    url: "http://nas.local/dav/",
    headers: {},
    body: "unauthorized",
    offloaded: false
  });
}

test("no-password-in-error 401 错误消息里不得出现密码", async () => {
  const password = ["Pa55", "w0rd", "Leak"].join("");
  await authConfig.save(SETTING_KEYS.baseUrl, "http://nas.local/dav");
  await authConfig.save(SETTING_KEYS.username, "demo");
  await authConfig.save(SETTING_KEYS.password, password);
  await authConfig.save(SETTING_KEYS.rootPath, "/");
  globalThis.__http_request_promise = async () => hostResponse(401);

  let message = "";
  try {
    await searchComic({});
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /网盘用户名或密码不对/);
  assert.equal(message.includes(password), false, "错误消息不能带密码");
});

test("no-password-in-error baseUrl userinfo 里的密码不会进请求 URL 或错误", async () => {
  const urlPassword = ["url", "pw"].join("");
  const password = ["other", "Leak"].join("");
  const requests = [];
  const client = createWebDavClient({
    baseUrl: "http://alice:" + urlPassword + "@nas.local/dav",
    username: "alice",
    password,
    request: async (spec) => {
      requests.push(spec);
      return {
        status: 401,
        statusText: "Unauthorized",
        url: spec.url,
        headers: {},
        bytes: new Uint8Array(0)
      };
    }
  });

  await assert.rejects(() => client.list("/"), (error) => {
    assert.equal(error.message.includes(password), false);
    assert.equal(error.message.includes(urlPassword), false);
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.includes(urlPassword), false);
});
