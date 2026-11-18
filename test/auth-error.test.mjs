import assert from "node:assert/strict";
import test from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { searchComic } from "../src/comics.ts";
import { SETTING_KEYS } from "../src/settings.ts";
import { createWebDavClient } from "../src/webdav/client.ts";
import { friendlyMessage, USER_MESSAGES } from "../src/errors.ts";

async function saveSettings() {
  await authConfig.save(SETTING_KEYS.baseUrl, "http://nas.local/dav");
  await authConfig.save(SETTING_KEYS.username, "wrong");
  await authConfig.save(SETTING_KEYS.password, "wrong");
  await authConfig.save(SETTING_KEYS.rootPath, "/");
}

function hostResponse(status, body = "") {
  return JSON.stringify({
    ok: true,
    status,
    statusText: "",
    url: "http://nas.local/dav/",
    headers: {},
    body,
    offloaded: false
  });
}

test("auth-error 401 → 网盘用户名或密码不对", async () => {
  await saveSettings();
  globalThis.__http_request_promise = async () => hostResponse(401, "unauthorized");
  await assert.rejects(() => searchComic({}), (error) => {
    assert.match(error.message, /网盘用户名或密码不对/);
    return true;
  });
});

test("auth-error PROPFIND 405 → 提示换 WebDAV 地址", async () => {
  await saveSettings();
  globalThis.__http_request_promise = async () => hostResponse(405, "method not allowed");
  await assert.rejects(() => searchComic({}), (error) => {
    assert.match(error.message, /这个网盘不支持列目录（PROPFIND）/);
    return true;
  });
});

test("auth-error 没有宿主网络桥 → 提示 Breeze 版本太旧", async () => {
  delete globalThis.__http_request_promise;
  const client = createWebDavClient({ baseUrl: "http://nas.local/dav" });
  await assert.rejects(() => client.list("/"), /当前 Breeze 版本太旧，插件用不了/);
});

test("auth-error 超时与未知错误翻译成人话", () => {
  assert.equal(friendlyMessage(new Error("request timed out")), USER_MESSAGES.timeout);
  assert.equal(friendlyMessage(new Error("AbortError: aborted")), USER_MESSAGES.timeout);
  assert.equal(friendlyMessage(new Error("HTTP 401 Unauthorized")), USER_MESSAGES.auth);
  assert.equal(friendlyMessage(new Error("PROPFIND HTTP 501")), USER_MESSAGES.propfind);
  assert.equal(friendlyMessage(new Error("随便什么错")), "随便什么错");
});
