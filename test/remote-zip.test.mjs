/**
 * CBZ 远程取页（Remote ZIP）真服务器集成测试。
 *
 * 全部断言打真实 HTTP：Range 尾部读 EOCD → 中央目录 → 仅拉目标页字节。
 * 覆盖：首屏字节量、逐页 sha256、服务器忽略 Range 的回退、注释过大、ZIP64、CRC 篡改。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { unzipSync } from "fflate";
import { installTestHost } from "../script/test-host.mjs";
import {
  AUTH_PASS,
  AUTH_USER,
  startWebDavServer
} from "../script/test-webdav-server.mjs";
import * as comics from "../src/comics.ts";
import { SETTING_KEYS } from "../src/settings.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

let bigServer = null;
let bigBaseUrl = "";

before(async () => {
  bigServer = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, bigCbz: true });
  bigBaseUrl = "http://127.0.0.1:" + bigServer.port + "/dav";
  installTestHost();
  await authConfig.save(SETTING_KEYS.baseUrl, bigBaseUrl);
  await authConfig.save(SETTING_KEYS.username, AUTH_USER);
  await authConfig.save(SETTING_KEYS.password, AUTH_PASS);
  await authConfig.save(SETTING_KEYS.rootPath, "/");
  await authConfig.save(SETTING_KEYS.scanDepth, "2");
  await authConfig.save(SETTING_KEYS.maxComics, "300");
  await authConfig.save(SETTING_KEYS.includeCbz, "true");
  comics.clearScanCache();
});

after(async () => {
  if (bigServer !== null) {
    await bigServer.close();
  }
});

async function findBigCbzItem() {
  const list = await comics.getComicList({ page: 1 });
  const item = list.data.items.find((entry) => entry.extern?.path === "/大包.cbz");
  assert.ok(item, "列表里应有 /大包.cbz");
  return item;
}

test("remote-zip-first-screen-bytes 50MiB 包首屏总下载 < 包大小 5%", async () => {
  const item = await findBigCbzItem();
  const packageSize = bigServer.fixture.bigCbz.length;
  assert.ok(packageSize > 50 * 1024 * 1024, "fixture 大包应超过 50 MiB，实际 " + packageSize);

  const mark = bigServer.requests.length;
  const snapshot = await comics.getReadSnapshot({ comicId: item.id });
  const pages = snapshot.data.chapter.pages;
  assert.equal(pages.length, 120, "大包应有 120 页");

  const firstPage = pages[0];
  const bytes = await comics.fetchImageBytes({ url: firstPage.url, extern: firstPage.extern });
  assert.equal(sha256(bytes), sha256(bigServer.fixture.bigCbzEntries.get(firstPage.path)));

  const used = bigServer.requests
    .slice(mark)
    .reduce((sum, record) => sum + record.responseBytes, 0);
  const ratio = used / packageSize;
  assert.ok(
    ratio < 0.05,
    "首屏下载应小于包大小 5%，实际 " + used + " / " + packageSize + " = " + (ratio * 100).toFixed(2) + "%"
  );
});

test("remote-zip-page-sha 逐页 sha256 与 fixture 一致（stored 与 deflate 都覆盖）", async () => {
  const item = await findBigCbzItem();
  const snapshot = await comics.getReadSnapshot({ comicId: item.id });
  const pages = snapshot.data.chapter.pages;
  // 奇数页 deflate、偶数页 stored：0/1/2/50/119 已覆盖两种压缩方式。
  for (const index of [0, 1, 2, 50, 119]) {
    const page = pages[index];
    const bytes = await comics.fetchImageBytes({ url: page.url, extern: page.extern });
    const expected = bigServer.fixture.bigCbzEntries.get(page.path);
    assert.ok(expected instanceof Uint8Array, "fixture 缺少页：" + page.path);
    assert.equal(sha256(bytes), sha256(expected), page.path + " sha256");
  }
});

function makeClient(server) {
  return createWebDavClient({
    baseUrl: "http://127.0.0.1:" + server.port + "/dav",
    username: AUTH_USER,
    password: AUTH_PASS
  });
}

function readDiagnostics() {
  const read = comics.getRemoteZipDiagnostics;
  return typeof read === "function" ? read() : [];
}

test("range-ignored-fallback 服务器忽略 Range 时自动回退整包，页字节仍正确", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, ignoreRange: true });
  try {
    installTestHost();
    const client = makeClient(server);
    if (typeof comics.clearRemoteZipDiagnostics === "function") {
      comics.clearRemoteZipDiagnostics();
    }
    const expected = unzipSync(server.fixture.cbz);
    for (const [index, name] of [
      [0, "001.png"],
      [2, "003.png"]
    ]) {
      const bytes = await comics.fetchPageBytes(client, {
        kind: "cbz",
        path: "/合集.cbz",
        index
      });
      assert.equal(sha256(bytes), sha256(expected[name]), name + " sha256");
    }
    const diagnostics = readDiagnostics();
    assert.ok(diagnostics.length >= 1, "回退必须留下诊断，不能静默");
    assert.match(diagnostics.join("\n"), /Range/i, "诊断应说明 Range 不可用");
  } finally {
    await server.close();
  }
});

test("zip-comment-too-large 注释超过 64 KiB 窗口时给明确中文错误", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, edgeCbz: true });
  try {
    installTestHost();
    const client = makeClient(server);
    await assert.rejects(
      () => comics.fetchPageBytes(client, { kind: "cbz", path: "/长注释.cbz", index: 0 }),
      (error) => {
        assert.match(error.message, /注释/, "错误文案应点明注释过大");
        assert.match(error.message, /CBZ|ZIP/i);
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("zip64-rejected ZIP64 包被明确拒绝", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, edgeCbz: true });
  try {
    installTestHost();
    const client = makeClient(server);
    await assert.rejects(
      () => comics.fetchPageBytes(client, { kind: "cbz", path: "/zip64.cbz", index: 0 }),
      /ZIP64/
    );
  } finally {
    await server.close();
  }
});

test("crc-mismatch CRC 校验失败时报错且不返回错误字节", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, edgeCbz: true });
  try {
    installTestHost();
    const client = makeClient(server);
    await assert.rejects(
      () => comics.fetchPageBytes(client, { kind: "cbz", path: "/坏CRC.cbz", index: 0 }),
      /CRC/
    );
  } finally {
    await server.close();
  }
});

test("remote-zip-central-directory-cached 同一包第二次取页不再读 EOCD / 探测长度", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS });
  try {
    installTestHost();
    const client = makeClient(server);
    const expected = unzipSync(server.fixture.cbz);
    await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 0 });

    const mark = server.requests.length;
    const bytes = await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 1 });
    assert.equal(sha256(bytes), sha256(expected["002.png"]));

    const added = server.requests.slice(mark);
    assert.equal(added.filter((record) => record.method === "HEAD").length, 0, "不应再次探测长度");
    assert.equal(added.filter((record) => record.method === "GET").length, 2, "每页只要本地头 + 数据两次 Range");
  } finally {
    await server.close();
  }
});

test("remote-zip-inflight-dedup 并发取同一包 5 页只读一次中央目录", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS });
  try {
    installTestHost();
    comics.clearRemoteZipCache();
    const client = makeClient(server);
    const expected = unzipSync(server.fixture.cbz);
    const mark = server.requests.length;

    const pages = await Promise.all(
      [0, 1, 2, 0, 1].map((index) =>
        comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index })
      )
    );
    assert.deepEqual(pages.map((bytes) => sha256(bytes)), [
      sha256(expected["001.png"]),
      sha256(expected["002.png"]),
      sha256(expected["003.png"]),
      sha256(expected["001.png"]),
      sha256(expected["002.png"])
    ]);

    const added = server.requests.slice(mark);
    const tailRange = "bytes=" + (server.fixture.cbz.length - 65536) + "-" + (server.fixture.cbz.length - 1);
    assert.equal(
      added.filter((record) => record.range === tailRange).length,
      1,
      "并发打开应共享同一次 EOCD 尾部读取"
    );
  } finally {
    await server.close();
  }
});
