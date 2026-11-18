/**
 * 环境保真测试：真机宿主打开详情时只传列表项的 id，取封面时只传 cover.url，
 * 两者带的 extern 都会被丢掉。这里用本地测试 WebDAV 服务器 + 宿主 shim 复现该行为，
 * 同时装上 Breeze 风格的 TextDecoder（拒绝 fatal），断言没有 extern 也能正常打开。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { unzipSync } from "fflate";
import { installTestHost } from "../script/test-host.mjs";
import {
  AUTH_PASS,
  AUTH_USER,
  DAV_PREFIX,
  startWebDavServer
} from "../script/test-webdav-server.mjs";

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

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function saveSettings(keys, baseUrl) {
  await authConfig.save(keys.baseUrl, baseUrl);
  await authConfig.save(keys.username, AUTH_USER);
  await authConfig.save(keys.password, AUTH_PASS);
  await authConfig.save(keys.rootPath, "/");
  await authConfig.save(keys.scanDepth, "2");
  await authConfig.save(keys.maxComics, "300");
  await authConfig.save(keys.includeCbz, "true");
}

test("id-without-extern：只传列表 id / 只传 cover.url 也能打开详情与取封面", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS });
  globalThis.TextDecoder = PolyfillTextDecoder;
  try {
    installTestHost();
    const { SETTING_KEYS } = await import("../src/settings.ts");
    const comics = await import("../src/comics.ts");

    await saveSettings(SETTING_KEYS, "http://127.0.0.1:" + server.port + "/dav");
    comics.clearScanCache();

    const list = await comics.getComicList({ page: 1 });
    const dirItem = list.data.items.find(
      (item) => item.extern?.kind === "dir" && item.extern?.path === "/"
    );
    const cbzItem = list.data.items.find(
      (item) => item.extern?.kind === "cbz" && item.extern?.path === "/合集.cbz"
    );
    assert.ok(dirItem, "列表里应有根目录漫画");
    assert.ok(cbzItem, "列表里应有 /合集.cbz");

    // 详情只给列表项 id，extern 是空对象（宿主会丢掉列表项的 extern）。
    const dirDetail = await comics.getComicDetail({ comicId: dirItem.id, extern: {} });
    assert.equal(dirDetail.data.normal.comicInfo.title, "漫画库");
    assert.equal(dirDetail.data.normal.comicInfo.id, dirItem.id);

    const dirCover = dirDetail.data.normal.comicInfo.cover;
    assert.equal(dirCover.extern.kind, "dir");
    assert.match(dirCover.url, /^wdav:\/\//);
    const dirExpected = server.fixture.files.get(DAV_PREFIX + dirCover.path);
    assert.ok(dirExpected instanceof Uint8Array, "fixture 应有封面图：" + dirCover.path);
    const dirBytes = await comics.fetchImageBytes({ url: dirCover.url, extern: {} });
    assert.equal(dirBytes.length, dirExpected.length);
    assert.equal(sha256(dirBytes), sha256(dirExpected));

    // CBZ 详情同样只给 id，封面取图只给 url（cover.extern 被宿主丢弃）。
    const cbzDetail = await comics.getComicDetail({ comicId: cbzItem.id, extern: {} });
    assert.equal(cbzDetail.data.normal.comicInfo.title, "合集");
    const cbzCover = cbzDetail.data.normal.comicInfo.cover;
    assert.equal(cbzCover.extern.kind, "cbz");
    const cbzBytes = await comics.fetchImageBytes({ url: cbzCover.url, extern: {} });
    const expectedFirst = unzipSync(server.fixture.cbz)["001.png"];
    assert.ok(expectedFirst instanceof Uint8Array, "fixture CBZ 应有 001.png");
    assert.equal(cbzBytes.length, expectedFirst.length);
    assert.equal(sha256(cbzBytes), sha256(expectedFirst));
  } finally {
    globalThis.TextDecoder = NativeTextDecoder;
    await server.close();
  }
});
