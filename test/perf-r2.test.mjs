/**
 * T49-PERF-ED-R2 返工测试。
 *
 * 对应 T47-REVIEW-030 的 P1-1 与重点 P2：
 * - adaptive-whole-package-shrink：≤16 MiB 包也必须走分块循环（失败能减半）
 * - scan-max-comics-stop：maxComics 达到后不再列完整层
 * - chunk-no-self-shrink：正常链路不会因为 25s/20s 矛盾自我减半
 * - chunk-timeout-shrink-first：块超时先减半再重试，不是同尺寸重试 4 次
 * - probe-500-degrade：探测 5xx 降级默认 8 MiB，不抛
 * - bad-body-no-redownload：坏包连续取页只下载 1 次，错误一致
 */

import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import * as downloadModule from "../src/http/download.ts";
import * as comics from "../src/comics.ts";
import { scanComicsDetailed } from "../src/webdav/scan.ts";
import { createWebDavClient } from "../src/webdav/client.ts";

const MiB = 1024 * 1024;
const HOST_TIMEOUT_MS = 30_000;

const downloadFileBytes = downloadModule.downloadFileBytes;
const DEFAULT_CHUNK_SIZE = downloadModule.DEFAULT_CHUNK_SIZE ?? 8 * MiB;

function resetChunkThroughputCache() {
  if (typeof downloadModule.resetChunkThroughputCache === "function") {
    downloadModule.resetChunkThroughputCache();
  }
}

function clearChunkDiagnostics() {
  if (typeof downloadModule.clearChunkDiagnostics === "function") {
    downloadModule.clearChunkDiagnostics();
  }
}

function chunkDiagnostics() {
  return typeof downloadModule.getChunkDiagnostics === "function"
    ? downloadModule.getChunkDiagnostics()
    : [];
}

function makePayload(size, seed = 3) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 13 + seed) % 251;
  }
  return bytes;
}

function makeClock() {
  return {
    ms: 0,
    now() {
      return Math.floor(this.ms);
    },
    advance(delta) {
      this.ms += delta;
    }
  };
}

function rangeOf(spec) {
  const matched = /^bytes=(\d+)-(\d+)$/.exec(String(spec.headers?.Range ?? ""));
  if (matched === null) {
    return null;
  }
  const start = Number(matched[1]);
  const end = Number(matched[2]);
  return { start, end, size: end - start + 1 };
}

/**
 * 限速传输：探测块和后续块可以用不同速率（模拟「探测很快、真下很慢」）。
 * 单块需要的时间超过宿主 30 秒就照宿主的样子超时。
 */
function makeTransport({ payload, probeBytesPerMs, bodyBytesPerMs, clock, probeStatus }) {
  const calls = [];
  const request = async (spec) => {
    calls.push(spec);
    if (spec.method === "HEAD") {
      clock.advance(1);
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: { "content-length": String(payload.length) },
        bytes: new Uint8Array(0)
      };
    }
    const range = rangeOf(spec);
    if (range === null) {
      const elapsed = payload.length / bodyBytesPerMs;
      if (elapsed > HOST_TIMEOUT_MS) {
        clock.advance(HOST_TIMEOUT_MS);
        throw new Error("宿主请求超时（30000ms）：GET " + spec.url);
      }
      clock.advance(elapsed);
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: { "content-length": String(payload.length) },
        bytes: payload
      };
    }
    const isProbe = range.start === 0 && range.end === Math.min(MiB, payload.length) - 1;
    if (isProbe && probeStatus !== undefined) {
      clock.advance(1);
      return { status: probeStatus, statusText: "", url: spec.url, headers: {}, bytes: new Uint8Array(0) };
    }
    const rate = Math.max(1, isProbe ? probeBytesPerMs : bodyBytesPerMs);
    const elapsed = range.size / rate;
    if (elapsed > HOST_TIMEOUT_MS) {
      clock.advance(HOST_TIMEOUT_MS);
      throw new Error("宿主请求超时（30000ms）：GET " + spec.url);
    }
    clock.advance(elapsed);
    return {
      status: 206,
      statusText: "Partial Content",
      url: spec.url,
      headers: { "content-range": "bytes " + range.start + "-" + range.end + "/" + payload.length },
      bytes: payload.slice(range.start, range.end + 1)
    };
  };
  return { calls, request };
}

function bodyRequestSizes(calls) {
  const sizes = [];
  for (const spec of calls) {
    const range = rangeOf(spec);
    if (range === null) {
      continue;
    }
    // 跳过 1 MiB 探测块与 0-0 长度探测。
    if (range.start === 0 && range.size <= MiB) {
      continue;
    }
    sizes.push(range.size);
  }
  return sizes;
}

test("adaptive-whole-package-shrink 10 MiB 包整包超时后必须减半成功", async () => {
  resetChunkThroughputCache();
  clearChunkDiagnostics();
  const clock = makeClock();
  const payload = makePayload(10 * MiB);
  // 探测很快（4 MB/s），真下很慢（300 KB/s）：10 MiB 一块约 35 秒，必超时。
  const transport = makeTransport({
    payload,
    probeBytesPerMs: 4096,
    bodyBytesPerMs: 300,
    clock
  });

  const result = await downloadFileBytes("http://whole.example/dav/慢包.cbz", {
    request: transport.request,
    headers: { Authorization: "Basic d2hvbGU6cHc=" },
    now: () => clock.now(),
    log: () => {}
  });

  assert.equal(result.bytes.length, payload.length, "必须下完整包");
  assert.deepEqual([...result.bytes.slice(0, 4096)], [...payload.slice(0, 4096)]);

  const sizes = bodyRequestSizes(transport.calls);
  assert.ok(sizes.length >= 2, "至少有「原块 + 减半块」两次请求，实际 " + JSON.stringify(sizes));
  const first = sizes[0];
  assert.ok(first >= 8 * MiB, "第一块应是公式选出的整包大小，实际 " + first);
  assert.ok(sizes[1] < first, "超时后下一块必须更小，实际 " + JSON.stringify(sizes));
  assert.ok(
    clock.ms < 120_000,
    "不允许卡满 120 秒（先减半再重试），实际模拟耗时 " + clock.ms + "ms"
  );
  const diagnostics = chunkDiagnostics().join("\n");
  assert.match(diagnostics, /减半/, "必须有减半日志");
});

test("scan-max-comics-stop maxComics 达到后不再列完整层", async () => {
  // 每个子目录里「1 张图 + 1 个 CBZ」= 2 本漫画：旧实现在 maxComics=2 时要列满 8 个目录。
  const tree = { "/": [] };
  for (let index = 1; index <= 8; index += 1) {
    tree["/"].push("漫画" + index);
    tree["/漫画" + index] = ["1.png", "a.cbz"];
  }

  const makeLister = (delayMs = 1) => {
    const state = { calls: 0 };
    const lister = {
      async list(input) {
        state.calls += 1;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const names = tree[input];
        if (names === undefined) {
          throw new Error("测试树里没有这个目录：" + input);
        }
        return names.map((name) => ({
          href: "/dav" + (input === "/" ? "" : input) + "/" + encodeURIComponent(name),
          isCollection: !/\.(png|cbz)$/i.test(name),
          contentLength: 10,
          lastModified: null
        }));
      },
      relativePath(href) {
        const path = decodeURIComponent(String(href).replace(/^\/dav/, "")).replace(/\/$/, "");
        return path === "" ? "/" : path;
      },
      canRequest() {
        return true;
      }
    };
    return { state, lister };
  };

  const serial = makeLister();
  const serialResult = await scanComicsDetailed(serial.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    maxComics: 2,
    concurrency: 1
  });
  assert.equal(serialResult.comics.length, 2);
  assert.equal(
    serial.state.calls,
    2,
    "串行下 maxComics=2 只该列 2 次目录（根 + 第一本 2 条 = 2 本），实际 " + serial.state.calls
  );
  assert.equal(serialResult.warning, null, "达到 maxComics 不该产生任何 warning");

  const parallel = makeLister(3);
  const parallelResult = await scanComicsDetailed(parallel.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    maxComics: 2,
    concurrency: 4
  });
  assert.deepEqual(
    parallelResult.comics.map((comic) => comic.path),
    serialResult.comics.map((comic) => comic.path),
    "截断结果必须与串行一致"
  );
  assert.ok(
    parallel.state.calls <= 5,
    "并发下最多多列一个在飞批次（根 + 4），实际 " + parallel.state.calls
  );
  assert.equal(parallelResult.warning, null);

  // 旧实现会先列整层再截断，把预算耗光并给出「目录太多」的假 warning。
  const budgeted = makeLister();
  const budgetedResult = await scanComicsDetailed(budgeted.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    maxComics: 2,
    maxListCalls: 5,
    concurrency: 1
  });
  assert.equal(budgetedResult.comics.length, 2);
  assert.equal(budgeted.state.calls, 2, "不该为了截断而多列，实际 " + budgeted.state.calls);
  assert.equal(budgetedResult.warning, null, "maxComics 达到后不该再出「目录太多」的假 warning");
});

test("chunk-no-self-shrink 正常链路不会被判慢并连续减半", async () => {
  resetChunkThroughputCache();
  clearChunkDiagnostics();

  // 1) 任务要求的 2 MiB/s：块应放大到 8 MiB 以上，且从不减半。
  const fastClock = makeClock();
  const fastPayload = makePayload(32 * MiB);
  const fast = makeTransport({
    payload: fastPayload,
    probeBytesPerMs: 2048,
    bodyBytesPerMs: 2048,
    clock: fastClock
  });
  const fastResult = await downloadFileBytes("http://fast2.example/dav/快包.cbz", {
    request: fast.request,
    headers: { Authorization: "Basic ZmFzdDI6cHc=" },
    now: () => fastClock.now(),
    log: () => {}
  });
  assert.equal(fastResult.bytes.length, fastPayload.length);
  const fastSizes = bodyRequestSizes(fast.calls);
  assert.ok(Math.max(...fastSizes) > DEFAULT_CHUNK_SIZE, "2 MiB/s 应保持 8 MiB 以上的块");
  assert.doesNotMatch(chunkDiagnostics().join("\n"), /减半/, "正常链路不得自我减半");

  // 2) 评审 E2 的 1 Mbps 场景：公式块约 15 秒，低于慢阈值，也不该减半。
  resetChunkThroughputCache();
  clearChunkDiagnostics();
  const slowClock = makeClock();
  const slowPayload = makePayload(8 * MiB, 9);
  const slow = makeTransport({
    payload: slowPayload,
    probeBytesPerMs: 125,
    bodyBytesPerMs: 125,
    clock: slowClock
  });
  const slowResult = await downloadFileBytes("http://slow2.example/dav/慢包.cbz", {
    request: slow.request,
    headers: { Authorization: "Basic c2xvdzI6cHc=" },
    now: () => slowClock.now(),
    log: () => {}
  });
  assert.equal(slowResult.bytes.length, slowPayload.length, "1 Mbps 下也要下完");
  const slowSizes = bodyRequestSizes(slow.calls);
  const shrinkLogs = chunkDiagnostics().filter((line) => /减半/.test(line));
  assert.deepEqual(shrinkLogs, [], "1 Mbps 下公式块应稳定，不该被判慢减半");
  assert.ok(
    slowSizes.every((size) => size < DEFAULT_CHUNK_SIZE),
    "1 Mbps 下每块都应小于 8 MiB，实际 " + JSON.stringify(slowSizes)
  );
});

test("chunk-timeout-shrink-first 块超时先减半，不同尺寸重试 4 次", async () => {
  resetChunkThroughputCache();
  clearChunkDiagnostics();
  const clock = makeClock();
  const payload = makePayload(24 * MiB);
  const transport = makeTransport({
    payload,
    probeBytesPerMs: 4096,
    bodyBytesPerMs: 400,
    clock
  });

  const result = await downloadFileBytes("http://shrink.example/dav/大包.cbz", {
    request: transport.request,
    headers: { Authorization: "Basic c2hyaW5rOnB3" },
    now: () => clock.now(),
    log: () => {}
  });
  assert.equal(result.bytes.length, payload.length);

  const sizes = bodyRequestSizes(transport.calls);
  assert.ok(sizes.length >= 2, "至少要两次块请求");
  const largest = Math.max(...sizes);
  const sameSizeCount = sizes.filter((size) => size === largest).length;
  assert.equal(
    sameSizeCount,
    1,
    "最大块只允许试 1 次（超时立刻减半），实际同尺寸 " + sameSizeCount + " 次：" + JSON.stringify(sizes)
  );
  assert.ok(sizes[1] < sizes[0], "第二次请求的块必须更小，实际 " + JSON.stringify(sizes));
  assert.ok(clock.ms < 120_000, "首次减半不该在 120 秒之后，实际 " + clock.ms + "ms");
});

test("probe-500-degrade 探测返回 500 时降级默认 8 MiB，不抛", async () => {
  resetChunkThroughputCache();
  clearChunkDiagnostics();
  const clock = makeClock();
  const payload = makePayload(20 * MiB);
  const transport = makeTransport({
    payload,
    probeBytesPerMs: 2048,
    bodyBytesPerMs: 2048,
    clock,
    probeStatus: 500
  });

  const result = await downloadFileBytes("http://probe500.example/dav/包.cbz", {
    request: transport.request,
    headers: { Authorization: "Basic cHJvYmU1MDA6cHc=" },
    now: () => clock.now(),
    log: () => {}
  });
  assert.equal(result.bytes.length, payload.length, "探测 500 也要继续下载");

  const sizes = bodyRequestSizes(transport.calls);
  assert.ok(sizes.length > 0, "应继续分块下载");
  assert.ok(
    sizes.every((size) => size <= DEFAULT_CHUNK_SIZE),
    "降级后按默认 8 MiB 分块，实际 " + JSON.stringify(sizes)
  );
  const diagnostics = chunkDiagnostics().join("\n");
  assert.match(diagnostics, /吞吐探测失败/, "要记录探测失败");
  assert.match(diagnostics, /8\.00 MiB/, "要说明降级到默认 8 MiB");
});

test("bad-body-no-redownload 坏包连续取 3 页只下载 1 次且错误一致", async () => {
  comics.clearZipCache();
  comics.clearRemoteZipDiagnostics();
  const broken = new Uint8Array(4096).fill(0x41);
  let gets = 0;
  const client = createWebDavClient({
    baseUrl: "http://badbody.local/dav",
    username: "demo",
    password: "demo",
    request: async (spec) => {
      if (spec.method === "HEAD") {
        return {
          status: 200,
          statusText: "OK",
          url: spec.url,
          headers: { "content-length": String(broken.length) },
          bytes: new Uint8Array(0)
        };
      }
      gets += 1;
      return { status: 200, statusText: "OK", url: spec.url, headers: {}, bytes: broken };
    }
  });

  const messages = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () => comics.fetchPageBytes(client, { kind: "cbz", path: "/坏体.cbz", index: attempt }),
      (error) => {
        messages.push(error.message);
        return true;
      }
    );
  }

  assert.equal(gets, 1, "坏包只允许下载 1 次（负缓存 60 秒），实际 GET " + gets + " 次");
  assert.equal(messages.length, 3);
  assert.equal(new Set(messages).size, 1, "三次错误文案必须完全一致：" + JSON.stringify(messages));
  assert.match(messages[0], /CBZ|ZIP/);
  assert.deepEqual(comics.zipCachePaths(), []);
  comics.clearZipCache();
});
