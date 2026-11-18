/**
 * T42-PERF-B-R2 返工测试（真服务器集成）。
 *
 * 覆盖：最大合法注释 65535 B、注释非法包回退、200 整包超下载上限、
 * 条目声明尺寸预检、Range 503 重试、中央目录缓存字节预算。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import "breeze-plugin-kit/node";
import { unzipSync, zipSync } from "fflate";
import { installTestHost } from "../script/test-host.mjs";
import {
  AUTH_PASS,
  AUTH_USER,
  startWebDavServer
} from "../script/test-webdav-server.mjs";
import * as comics from "../src/comics.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function makeClient(server) {
  return createWebDavClient({
    baseUrl: "http://127.0.0.1:" + server.port + "/dav",
    username: AUTH_USER,
    password: AUTH_PASS
  });
}

function makeBytes(size, seed) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (seed + index) % 251;
  }
  return bytes;
}

test("zip-comment-max-ok ZIP 注释恰好 65535 字节仍能列页与取页", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, edgeCbz: true });
  try {
    installTestHost();
    const client = makeClient(server);
    comics.clearRemoteZipCache();
    const expected = server.fixture.edgeCbz.entries;
    for (const [index, name] of [
      [0, "001.png"],
      [1, "002.png"]
    ]) {
      const bytes = await comics.fetchPageBytes(client, {
        kind: "cbz",
        path: "/注释上限.cbz",
        index
      });
      assert.equal(sha256(bytes), sha256(expected.get(name)), name + " sha256");
    }
  } finally {
    await server.close();
  }
});

test("comment-too-large-fallback 注释超出上限的非法包回退整包后给明确错误", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, edgeCbz: true });
  try {
    installTestHost();
    const client = makeClient(server);
    comics.clearRemoteZipCache();
    comics.clearRemoteZipDiagnostics();
    await assert.rejects(
      () => comics.fetchPageBytes(client, { kind: "cbz", path: "/长注释.cbz", index: 0 }),
      (error) => {
        assert.match(error.message, /找不到中央目录|注释/);
        assert.match(error.message, /CBZ|ZIP/i);
        return true;
      }
    );
    const diagnostics = comics.getRemoteZipDiagnostics();
    assert.ok(diagnostics.length >= 1, "注释过大必须留下回退诊断");
    assert.match(diagnostics.join("\n"), /注释|中央目录/);
  } finally {
    await server.close();
  }
});

test("full-response-too-big 200 整包超过下载上限时只发一次 GET、报错且不挂缓存", async () => {
  assert.equal(
    typeof comics.setRemoteZipDownloadLimitForTests,
    "function",
    "缺少 setRemoteZipDownloadLimitForTests 测试钩子"
  );
  comics.clearZipCache();
  comics.setRemoteZipDownloadLimitForTests(1024);
  try {
    const zip = zipSync({ "001.png": makeBytes(4096, 1) }, { level: 0 });
    assert.ok(zip.length > 1024, "测试包应超过注入的上限");
    const requests = [];
    const client = createWebDavClient({
      baseUrl: "http://nas.local/dav",
      username: "demo",
      password: "demo",
      request: async (spec) => {
        requests.push(spec);
        if (spec.method === "HEAD") {
          return {
            status: 200,
            statusText: "OK",
            url: spec.url,
            headers: { "content-length": String(zip.length) },
            bytes: new Uint8Array(0)
          };
        }
        return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes: zip };
      }
    });

    await assert.rejects(
      () => comics.fetchPageBytes(client, { kind: "cbz", path: "/big.cbz", index: 0 }),
      /太大|下载上限/
    );
    assert.equal(
      requests.filter((spec) => spec.method === "GET").length,
      1,
      "超上限后不得再发第二次请求"
    );
    assert.deepEqual(comics.zipCachePaths(), [], "超上限的整包不得挂进缓存");
  } finally {
    comics.setRemoteZipDownloadLimitForTests(null);
    comics.clearZipCache();
  }
});

test("entry-limit-precheck 条目声明尺寸超限时 0 次内容请求就报错", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, edgeCbz: true });
  try {
    installTestHost();
    const client = makeClient(server);
    comics.clearRemoteZipCache();
    const mark = server.requests.length;
    await assert.rejects(
      () => comics.fetchPageBytes(client, { kind: "cbz", path: "/压缩超限.cbz", index: 0 }),
      /太大|压缩|超限/
    );
    const added = server.requests.slice(mark);
    assert.equal(
      added.filter((record) => record.method === "GET").length,
      1,
      "预检必须在本地头/数据请求之前完成，只允许读一次尾部"
    );
  } finally {
    await server.close();
  }
});

test("range-retry Range 首次 503、第二次 206 时最终成功", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, failRangeOnce: true });
  try {
    installTestHost();
    const client = makeClient(server);
    comics.clearRemoteZipCache();
    const expected = server.fixture.cbz;
    const bytes = await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 0 });
    assert.ok(bytes.length > 0, "重试后应拿到页字节");
    assert.ok(
      server.requests.some((record) => record.method === "GET" && record.responseBytes > 0 && record.status === 503),
      "服务器应确实返回过一次 503"
    );
    const pdfLike = await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 1 });
    assert.equal(pdfLike.length, 2_900_000, "第二页长度应与 fixture 一致");
    assert.ok(expected.length > 0);
  } finally {
    await server.close();
  }
});

test("cd-cache-budget 中央目录缓存超预算时逐出，逐出后仍能取页", async () => {
  assert.equal(typeof comics.setRemoteZipCacheBudgetForTests, "function", "缺少缓存预算测试钩子");
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS });
  try {
    installTestHost();
    const client = makeClient(server);
    comics.clearRemoteZipCache();

    const first = await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 0 });
    assert.ok(first.length > 0);
    const firstBytes = comics.remoteZipCacheBytes();
    assert.ok(firstBytes > 0, "中央目录缓存应记录占用字节");

    const comicsCbz = await comics.fetchPageBytes(
      client,
      { kind: "cbz", path: "/comics/整包.cbz", index: 0 }
    );
    assert.ok(comicsCbz.length > 0);
    const secondBytes = comics.remoteZipCacheBytes() - firstBytes;
    const budget = Math.max(firstBytes, secondBytes) + 1;

    comics.setRemoteZipCacheBudgetForTests(budget);
    assert.deepEqual(
      comics.remoteZipCacheKeys(),
      ["/comics/整包.cbz"],
      "超预算应逐出旧包，只留最近一个"
    );
    assert.ok(
      comics.remoteZipCacheBytes() <= budget,
      "中央目录缓存字节数应压到预算以内，实际 " + comics.remoteZipCacheBytes()
    );

    const again = await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 0 });
    assert.equal(sha256(again), sha256(first), "逐出后重新读中央目录仍应取到同一页");
  } finally {
    comics.setRemoteZipCacheBudgetForTests(null);
    comics.clearRemoteZipCache();
    await server.close();
  }
});

test("full-response-length-mismatch HEAD 长度与 200 实际长度不符时以实际为准，不再二次下载", async () => {
  comics.clearZipCache();
  const zip = zipSync({ "001.png": makeBytes(2048, 3) }, { level: 0 });
  const expected = unzipSync(zip)["001.png"];
  const requests = [];
  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    username: "demo",
    password: "demo",
    request: async (spec) => {
      requests.push(spec);
      if (spec.method === "HEAD") {
        return {
          status: 200,
          statusText: "OK",
          url: spec.url,
          headers: { "content-length": String(zip.length + 100) },
          bytes: new Uint8Array(0)
        };
      }
      return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes: zip };
    }
  });

  const bytes = await comics.fetchPageBytes(client, { kind: "cbz", path: "/mismatch.cbz", index: 0 });
  assert.equal(sha256(bytes), sha256(expected));
  assert.equal(
    requests.filter((spec) => spec.method === "GET").length,
    1,
    "200 整包应直接复用，不再二次请求"
  );
  comics.clearZipCache();
});

test("fallback-diagnostic-dedup 并发回退同一包只记一条诊断", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, ignoreRange: true });
  try {
    installTestHost();
    const client = makeClient(server);
    comics.clearRemoteZipCache();
    comics.clearRemoteZipDiagnostics();
    await Promise.all(
      [0, 1, 2, 0, 1].map((index) =>
        comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index })
      )
    );
    const diagnostics = comics.getRemoteZipDiagnostics();
    assert.equal(diagnostics.length, 1, "同一包 + 同一原因只应记一条，实际 " + diagnostics.length);
  } finally {
    await server.close();
  }
});
