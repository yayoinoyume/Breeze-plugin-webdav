/**
 * T46-PERF-ED 的 3 条 P2 回归测试。
 *
 * - full-body-selfcheck：200 回退体进缓存前自校验（坏体不缓存、报明确错误）
 * - entry-cap-65mb：单条目上限放宽到 65 MiB（含 deflate 膨胀余量）
 * - cd-cache-evict-single：中央目录缓存预算小于单包时也能逐出
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";
import * as comics from "../src/comics.ts";
import { createWebDavClient } from "../src/webdav/client.ts";
import * as cbzModule from "../src/zip/cbz.ts";

const MAX_ENTRY_BYTES = cbzModule.MAX_ENTRY_BYTES;
const MAX_COMPRESSED_ENTRY_BYTES = cbzModule.MAX_COMPRESSED_ENTRY_BYTES ?? MAX_ENTRY_BYTES;
const assertEntrySafeToExtract =
  cbzModule.assertEntrySafeToExtract ??
  (() => {
    throw new Error("缺少 assertEntrySafeToExtract");
  });

const MiB = 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function makeBytes(size, seed) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + seed) % 256;
  }
  return bytes;
}

/** 一个最小 Range 服务器：HEAD 给长度，GET 按 Range 切片，忽略 Range 时返回 200 整包。 */
function makeRangeServer(files, options = {}) {
  const calls = [];
  const ignoreRange = options.ignoreRange === true;
  const request = async (spec) => {
    calls.push(spec);
    const raw = decodeURIComponent(new URL(spec.url).pathname);
    const path = raw.startsWith("/dav/") ? raw.slice(4) : raw;
    const bytes = files[path];
    if (bytes === undefined) {
      return { status: 404, statusText: "Not Found", url: spec.url, headers: {}, bytes: new Uint8Array(0) };
    }
    if (spec.method === "HEAD") {
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: { "content-length": String(bytes.length) },
        bytes: new Uint8Array(0)
      };
    }
    const matched = /^bytes=(\d+)-(\d+)$/.exec(String(spec.headers?.Range ?? ""));
    if (ignoreRange || matched === null) {
      return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes };
    }
    const start = Number(matched[1]);
    const end = Math.min(Number(matched[2]), bytes.length - 1);
    return {
      status: 206,
      statusText: "Partial Content",
      url: spec.url,
      headers: { "content-range": "bytes " + start + "-" + end + "/" + bytes.length },
      bytes: bytes.slice(start, end + 1)
    };
  };
  return { calls, request };
}

test("full-body-selfcheck 200 回退体不是合法 ZIP 时不进缓存并给明确错误", async () => {
  comics.clearZipCache();
  comics.clearRemoteZipDiagnostics();
  const broken = new Uint8Array(4096).fill(0x41); // 全是 'A'，没有 EOCD
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
          headers: { "content-length": String(broken.length) },
          bytes: new Uint8Array(0)
        };
      }
      // 服务器忽略 Range，回 200「整包」——但这份体其实是坏的。
      return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes: broken };
    }
  });

  await assert.rejects(
    () => comics.fetchPageBytes(client, { kind: "cbz", path: "/坏体.cbz", index: 0 }),
    (error) => {
      assert.match(error.message, /CBZ|ZIP/, "错误文案应点明 CBZ/ZIP");
      assert.match(error.message, /不缓存|丢弃/, "错误文案应说明坏体不会被缓存");
      return true;
    }
  );
  assert.deepEqual(comics.zipCachePaths(), [], "坏体不得进入整包缓存");
  assert.equal(comics.zipCacheBytes(), 0, "坏体不得占用缓存字节");

  const firstRound = requests.filter((spec) => spec.method === "GET").length;
  assert.ok(firstRound >= 1, "至少要发过一次 GET");

  // 坏体会进 60 秒负缓存：第二次直接报同一个明确错误，不再重复下载整个坏包（P2-8）。
  let secondMessage = "";
  await assert.rejects(
    () => comics.fetchPageBytes(client, { kind: "cbz", path: "/坏体.cbz", index: 0 }),
    (error) => {
      secondMessage = error.message;
      return true;
    }
  );
  assert.equal(
    requests.filter((spec) => spec.method === "GET").length,
    firstRound,
    "坏体负缓存命中时不得再发 GET"
  );
  assert.match(secondMessage, /不是有效的 ZIP.*不缓存/, "第二次也要给同一个明确错误");
  assert.deepEqual(comics.zipCachePaths(), []);
  comics.clearZipCache();
});

test("entry-cap-65mb 65 MiB 的合法页能读（原来 64 MiB+1 被拒的那个）", async () => {
  comics.clearZipCache();
  comics.clearRemoteZipCache();
  const pageSize = 65 * MiB;
  assert.ok(MAX_ENTRY_BYTES >= pageSize, "单条目上限应至少 65 MiB，实际 " + MAX_ENTRY_BYTES);
  assert.ok(
    MAX_COMPRESSED_ENTRY_BYTES > MAX_ENTRY_BYTES,
    "压缩数据上限要给 deflate 膨胀留余量，实际 " + MAX_COMPRESSED_ENTRY_BYTES
  );

  // 远程路径的预检不能再因为「压缩数据 64 MiB+1」误杀合法页。
  assert.doesNotThrow(() =>
    assertEntrySafeToExtract({
      name: "001.png",
      method: 8,
      flags: 0,
      crc: 0,
      compressedSize: 64 * MiB + 1,
      uncompressedSize: 64 * MiB + 1,
      localOffset: 0
    })
  );
  assert.throws(
    () =>
      assertEntrySafeToExtract({
        name: "002.png",
        method: 8,
        flags: 0,
        crc: 0,
        compressedSize: 1024,
        uncompressedSize: MAX_ENTRY_BYTES + 1,
        localOffset: 0
      }),
    /太大/
  );

  const payload = makeBytes(pageSize, 5);
  payload.set([0x89, 0x50, 0x4e, 0x47], 0);
  const zip = zipSync({ "001.png": payload }, { level: 0 });
  const server = makeRangeServer({ "/大页.cbz": zip }, { ignoreRange: false });
  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    username: "demo",
    password: "demo",
    request: server.request
  });

  const bytes = await comics.fetchPageBytes(client, { kind: "cbz", path: "/大页.cbz", index: 0 });
  assert.equal(bytes.length, pageSize, "应完整读出 65 MiB 的页");
  assert.equal(sha256(bytes), sha256(payload), "65 MiB 页的 sha256 应与源一致");
  comics.clearZipCache();
  comics.clearRemoteZipCache();
});

test("cd-cache-evict-single 预算小于单包时能逐出并继续工作", async () => {
  comics.clearZipCache();
  comics.clearRemoteZipCache();
  const zipA = zipSync({ "001.png": makeBytes(2048, 1), "002.png": makeBytes(2048, 2) }, { level: 0 });
  const zipB = zipSync({ "001.png": makeBytes(2048, 3) }, { level: 0 });
  const expected = unzipSync(zipA);
  const server = makeRangeServer({ "/a.cbz": zipA, "/b.cbz": zipB }, { ignoreRange: false });
  const client = createWebDavClient({
    baseUrl: "http://nas.local/dav",
    username: "demo",
    password: "demo",
    request: server.request
  });

  comics.setRemoteZipCacheBudgetForTests(1);
  try {
    const first = await comics.fetchPageBytes(client, { kind: "cbz", path: "/a.cbz", index: 0 });
    assert.equal(sha256(first), sha256(expected["001.png"]));
    assert.deepEqual(
      comics.remoteZipCacheKeys(),
      [],
      "预算小于单包时必须允许逐出最后一条，实际 " + JSON.stringify(comics.remoteZipCacheKeys())
    );

    const second = await comics.fetchPageBytes(client, { kind: "cbz", path: "/b.cbz", index: 0 });
    assert.ok(second.length > 0, "逐出后仍应能读别的包");

    const again = await comics.fetchPageBytes(client, { kind: "cbz", path: "/a.cbz", index: 1 });
    assert.equal(sha256(again), sha256(expected["002.png"]), "逐出后重新读中央目录仍能取到同一页");
  } finally {
    comics.setRemoteZipCacheBudgetForTests(null);
    comics.clearZipCache();
    comics.clearRemoteZipCache();
  }
});

test("fallback-diagnostic-reset 清空缓存或换账号后回退诊断重新记录", async () => {
  comics.clearZipCache();
  const zip = zipSync({ "001.png": makeBytes(1024, 9) }, { level: 0 });
  const makeCachingClient = (username) =>
    createWebDavClient({
      baseUrl: "http://nas.local/dav",
      username,
      password: "demo",
      request: async (spec) => {
        if (spec.method === "HEAD") {
          return {
            status: 200,
            statusText: "OK",
            url: spec.url,
            headers: { "content-length": String(zip.length) },
            bytes: new Uint8Array(0)
          };
        }
        // 忽略 Range：一律 200 整包，必然触发回退诊断。
        return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes: zip };
      }
    });

  const client = makeCachingClient("demo");
  await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 0 });
  assert.equal(comics.getRemoteZipDiagnostics().length, 1, "第一次回退应记一条诊断");

  await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 0 });
  assert.equal(comics.getRemoteZipDiagnostics().length, 1, "同包同原因只记一条（去重键在起作用）");

  comics.clearZipCache();
  assert.deepEqual(comics.getRemoteZipDiagnostics(), [], "clearZipCache 应把回退诊断一起清空");
  await comics.fetchPageBytes(client, { kind: "cbz", path: "/合集.cbz", index: 0 });
  assert.equal(
    comics.getRemoteZipDiagnostics().length,
    1,
    "清空缓存后去重键必须复位，否则诊断永远出不来"
  );

  const otherAccount = makeCachingClient("另一个人");
  await comics.fetchPageBytes(otherAccount, { kind: "cbz", path: "/合集.cbz", index: 0 });
  assert.equal(
    comics.getRemoteZipDiagnostics().length,
    2,
    "换账号要去重键复位，新账号的回退也要能记下来"
  );
  comics.clearZipCache();
});
