/**
 * 分块自适应（T46-PERF-ED / E）单元测试。
 *
 * 用「假时钟 + 限速传输」复刻 T22 实测：1 Mbps 下 8 MiB 块必超宿主 30 秒超时，
 * 2 MiB 块可以成功。自适应必须在探测后把块压到安全值，并在高速链路上放大回 8 MiB 以上。
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as downloadModule from "../src/http/download.ts";

const { downloadFileBytes } = downloadModule;
const DEFAULT_CHUNK_SIZE = downloadModule.DEFAULT_CHUNK_SIZE ?? 8 * 1024 * 1024;
const MIN_CHUNK_SIZE = downloadModule.MIN_CHUNK_SIZE ?? 1 * 1024 * 1024;
const MAX_CHUNK_SIZE = downloadModule.MAX_CHUNK_SIZE ?? 16 * 1024 * 1024;

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

function getChunkDiagnostics() {
  return typeof downloadModule.getChunkDiagnostics === "function"
    ? downloadModule.getChunkDiagnostics()
    : [];
}

const MiB = 1024 * 1024;
const HOST_TIMEOUT_MS = 30_000;

function makePayload(size) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 7 + 13) % 251;
  }
  return bytes;
}

/** 假时钟：让「耗时」由传输字节数决定，测试不必真的等待。 */
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

/**
 * 限速 WebDAV：Range 按请求切片返回；单块需要的时间超过宿主 30 秒就照宿主的样子超时。
 * 这样「块太大」在测试里表现为请求失败，而不是断言一个内部数字。
 */
function makeThrottledRequest({ payload, bytesPerMs, clock }) {
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
    const matched = /^bytes=(\d+)-(\d+)$/.exec(String(spec.headers?.Range ?? ""));
    if (matched === null) {
      // 没有 Range = 整包 GET（自适应判定「一块就够」时走这条路）。
      clock.advance(payload.length / bytesPerMs);
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: { "content-length": String(payload.length) },
        bytes: payload
      };
    }
    const start = Number(matched[1]);
    const end = Math.min(Number(matched[2]), payload.length - 1);
    const size = end - start + 1;
    const elapsed = size / bytesPerMs;
    if (elapsed > HOST_TIMEOUT_MS) {
      clock.advance(HOST_TIMEOUT_MS);
      throw new Error("宿主请求超时（30000ms）：GET " + spec.url);
    }
    clock.advance(elapsed);
    return {
      status: 206,
      statusText: "Partial Content",
      url: spec.url,
      headers: { "content-range": "bytes " + start + "-" + end + "/" + payload.length },
      bytes: payload.slice(start, end + 1)
    };
  };
  return { calls, request };
}

function rangeSizes(calls) {
  return calls
    .filter((spec) => typeof spec.headers?.Range === "string")
    .map((spec) => {
      const matched = /^bytes=(\d+)-(\d+)$/.exec(spec.headers.Range);
      return Number(matched[2]) - Number(matched[1]) + 1;
    });
}

test("chunk-adaptive-slow 1 Mbps 下自适应把块压到 8 MiB 以下并下载成功", async () => {
  resetChunkThroughputCache();
  clearChunkDiagnostics();
  const clock = makeClock();
  const bytesPerMs = 125; // ≈1 Mbps
  // 16 MiB：现状（固定 8 MiB 块）在 1 Mbps 上第一块就要 67 秒，必然撞宿主 30 秒超时。
  const payload = makePayload(16 * MiB);
  const transport = makeThrottledRequest({ payload, bytesPerMs, clock });

  const result = await downloadFileBytes("http://slow.example/dav/慢包.cbz", {
    request: transport.request,
    headers: { Authorization: "Basic ZGVtbzpkZW1v" },
    now: () => clock.now(),
    log: () => {}
  });

  assert.deepEqual([...result.bytes], [...payload], "字节必须完整");
  assert.equal(result.usedRange, true);
  assert.ok(result.chunkCount >= 2, "慢网络下应该分成多块，实际 " + result.chunkCount);

  const sizes = rangeSizes(transport.calls);
  assert.ok(sizes.length >= 2, "至少要有探测 + 分块两次 Range 请求");
  for (const size of sizes) {
    assert.ok(size < DEFAULT_CHUNK_SIZE, "每块都应小于 8 MiB，实际某块 " + size + " 字节");
  }

  const diagnostics = getChunkDiagnostics().join("\n");
  assert.match(diagnostics, /吞吐探测/, "要有探测日志");
  assert.match(diagnostics, /减半|缩小/, "慢块之后要有缩小日志");
});

test("chunk-adaptive-fast 高速链路把块放大到 8 MiB 以上且不超过 16 MiB", async () => {
  resetChunkThroughputCache();
  clearChunkDiagnostics();
  const clock = makeClock();
  const bytesPerMs = 1024; // ≈1 MiB/ms
  const payload = makePayload(24 * MiB);
  const transport = makeThrottledRequest({ payload, bytesPerMs, clock });
  const headers = { Authorization: "Basic ZmFzdDpmYXN0" };

  const result = await downloadFileBytes("http://fast.example/dav/快包.cbz", {
    request: transport.request,
    headers,
    now: () => clock.now(),
    log: () => {}
  });
  assert.deepEqual([...result.bytes.slice(0, 1024)], [...payload.slice(0, 1024)]);
  assert.equal(result.bytes.length, payload.length);

  const sizes = rangeSizes(transport.calls);
  const largest = Math.max(...sizes);
  assert.ok(
    largest > DEFAULT_CHUNK_SIZE,
    "高速链路应放大到 8 MiB 以上，实际最大块 " + largest + " 字节"
  );
  assert.ok(largest <= MAX_CHUNK_SIZE, "分块不得超过 16 MiB，实际 " + largest + " 字节");
  assert.ok(
    result.chunkCount <= 4,
    "24 MiB 在 16 MiB 块下应在 4 块内完成，实际 " + result.chunkCount
  );

  // 同一个 host + 账号：10 分钟内不再重复探测（省一次请求）。
  const before = transport.calls.filter((spec) => spec.method === "GET").length;
  const small = makePayload(2 * MiB);
  const second = makeThrottledRequest({ payload: small, bytesPerMs, clock });
  const secondResult = await downloadFileBytes("http://fast.example/dav/第二包.cbz", {
    request: second.request,
    headers,
    now: () => clock.now(),
    log: () => {}
  });
  assert.equal(secondResult.bytes.length, small.length);
  const secondGets = second.calls.filter((spec) => spec.method === "GET");
  assert.equal(secondGets.length, 1, "吞吐已缓存时 2 MiB 包应一次 GET 完成，实际 " + secondGets.length);
  assert.equal(
    secondGets[0].headers?.Range,
    undefined,
    "缓存命中后不应再发 1 MiB 探测请求，实际带了 " + String(secondGets[0].headers?.Range)
  );
  assert.ok(before >= 2, "第一次下载应至少发过探测 + 分块请求，实际 " + before);
  assert.ok(MIN_CHUNK_SIZE < DEFAULT_CHUNK_SIZE);
});
