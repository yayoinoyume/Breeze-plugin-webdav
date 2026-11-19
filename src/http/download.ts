/**
 * 分块 Range 下载。
 *
 * 宿主单次请求有 30 秒总超时，大文件必须切块。块大小按实测吞吐自适应：
 * - 先 Range 拉 1 MiB 作为吞吐探测（这段字节直接算作第一块，不重复下载）；
 * - 块大小 = clamp(吞吐 × 25 秒, 1 MiB, 16 MiB)，拿不到吞吐就按默认 8 MiB；
 * - 跑起来后按块耗时继续缩放：单块 > 20 秒或失败就减半（下限 1 MiB），
 *   连续两块 < 3 秒就翻倍（上限 16 MiB）。
 *
 * 先探测总长度（HEAD，失败再 Range 0-0），拿不到就明确报错，绝不盲发整包 GET。
 */

import { hostRequest } from "./host.ts";
import type { HostRequest, HttpResponseData } from "./host.ts";
import { redactUrl } from "../errors.ts";

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
export const MIN_CHUNK_SIZE = 1 * 1024 * 1024;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
/** 吞吐探测块大小：1 MiB 在 1 Mbps 上约 8 秒，探测本身不会撞 30 秒超时。 */
export const PROBE_CHUNK_BYTES = 1 * 1024 * 1024;
/** 目标「一块下多久」：按吞吐 × 25 秒切块，留 5 秒给建连与抖动。 */
export const CHUNK_TARGET_MS = 25_000;
/** 单块超过这个耗时就算慢，下一块减半。 */
export const SLOW_CHUNK_MS = 20_000;
/** 连续两块都快于这个耗时，下一块翻倍。 */
export const FAST_CHUNK_MS = 3_000;
/** 吞吐缓存有效期（按 host + 账号复用，避免每页都探测）。 */
export const THROUGHPUT_TTL_MS = 10 * 60 * 1000;
/** 单块失败后最多减半重试几次。 */
export const MAX_SHRINK_RETRIES = 4;
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const CHUNK_DIAGNOSTIC_LIMIT = 40;

export type DownloadOptions = {
  /** 已知文件长度时直接分块；不传则先 HEAD / Range 探测。 */
  contentLength?: number | null;
  /** 额外请求头（通常是 Basic 认证）。 */
  headers?: Record<string, string>;
  /** 固定块大小：传了就关闭自适应（老行为），测试和 E2E 用得上。 */
  chunkSize?: number;
  /** 单块失败后的重试次数，默认 3。 */
  retries?: number;
  request?: HostRequest;
  /** 关掉吞吐自适应（默认开启；传了 chunkSize 时自动关闭）。 */
  adaptive?: boolean;
  /** 时间源，测试注入；默认 Date.now。 */
  now?: () => number;
  /** 自适应日志出口，默认 console.debug；无论传不传都会记内部诊断。 */
  log?: (message: string) => void;
};

export type DownloadResult = {
  bytes: Uint8Array;
  /** 最后一次成功的 HTTP 状态：200 表示整包，206 表示分块。 */
  status: number;
  /** 实际发出的下载请求次数（1 MiB 吞吐探测的字节直接当第一块，所以计 1 次）。 */
  chunkCount: number;
  /** 是否真的用上了 Range。 */
  usedRange: boolean;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

async function requestWithRetry(
  request: HostRequest,
  spec: Parameters<HostRequest>[0],
  retries: number
): Promise<HttpResponseData> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await request(spec);
      if (!isRetryableStatus(response.status)) {
        return response;
      }
      lastError = new Error(
        "服务器返回 HTTP " + response.status + "：" + spec.method + " " + redactUrl(spec.url)
      );
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) {
      await wait(300 * Math.pow(2, attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = error.message;
  return (
    text.includes("HTTP 401") ||
    text.includes("HTTP 403") ||
    text.includes("认证失败") ||
    text.includes("网盘用户名")
  );
}

const chunkDiagnostics: string[] = [];
type ThroughputSample = { bytesPerMs: number; measuredAt: number };
/** 吞吐缓存：按「协议+host + 认证头」维度，10 分钟内复用，换账号不串。 */
const throughputCache = new Map<string, ThroughputSample>();

/** 清空吞吐缓存（测试用）。 */
export function resetChunkThroughputCache(): void {
  throughputCache.clear();
}

/** 自适应诊断（探测 / 缩放各一条，最多 40 条）。 */
export function getChunkDiagnostics(): string[] {
  return chunkDiagnostics.slice();
}

/** 清空自适应诊断（测试用）。 */
export function clearChunkDiagnostics(): void {
  chunkDiagnostics.length = 0;
}

function logChunk(message: string, sink?: (message: string) => void): void {
  chunkDiagnostics.push(message);
  if (chunkDiagnostics.length > CHUNK_DIAGNOSTIC_LIMIT) {
    chunkDiagnostics.shift();
  }
  if (sink !== undefined) {
    sink(message);
    return;
  }
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug("[webdav] " + message);
  }
}

function throughputKey(url: string, headers: Record<string, string>): string {
  const origin = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(String(url ?? ""));
  const host = origin === null ? "" : origin[1].toLowerCase();
  const authorization = String(headers.Authorization ?? headers.authorization ?? "");
  return host + "|" + authorization;
}

/** 日志里只能出现 host：缓存键里的认证头是凭据，绝不打进诊断。 */
function describeThroughputKey(key: string): string {
  const separator = key.indexOf("|");
  return separator >= 0 ? key.slice(0, separator) : key;
}

function readCachedThroughput(key: string, nowMs: number): number | null {
  const sample = throughputCache.get(key);
  if (sample === undefined) {
    return null;
  }
  if (nowMs - sample.measuredAt > THROUGHPUT_TTL_MS) {
    throughputCache.delete(key);
    return null;
  }
  return sample.bytesPerMs;
}

function rememberThroughput(key: string, bytesPerMs: number, nowMs: number): void {
  if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) {
    return;
  }
  throughputCache.set(key, { bytesPerMs, measuredAt: nowMs });
}

function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return String(bytes);
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
  }
  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(1) + " KiB";
  }
  return bytes + " B";
}

function formatRate(bytesPerMs: number): string {
  if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) {
    return "未知速率";
  }
  return Math.round(bytesPerMs * 1000) + " B/s";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 块大小 = clamp(吞吐 × 25 秒, 1 MiB, 16 MiB)；拿不到吞吐就用默认 8 MiB。 */
export function chunkSizeFor(bytesPerMs: number): number {
  if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) {
    return DEFAULT_CHUNK_SIZE;
  }
  const target = Math.round(bytesPerMs * CHUNK_TARGET_MS);
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, target));
}

type ProbeOutcome =
  | { kind: "body"; bytes: Uint8Array; bytesPerMs: number }
  | { kind: "whole"; bytes: Uint8Array }
  | { kind: "rate"; bytesPerMs: number }
  | { kind: "none" };

function assertDownloadable(method: string, url: string, response: HttpResponseData): void {
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "网盘用户名或密码不对（HTTP " + response.status + "）：" + method + " " + redactUrl(url)
    );
  }
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(
      "WebDAV 请求失败（HTTP " + response.status + "）：" + method + " " + redactUrl(url)
    );
  }
}

function parseContentLength(headers: Record<string, string>): number | null {
  const raw = headers["content-length"];
  if (raw === undefined) {
    return null;
  }
  const value = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export type ContentRange = {
  start: number;
  end: number;
  total: number | null;
};

/** 解析 Content-Range: bytes start-end/total（total 可能是 *）。 */
export function parseContentRange(value: unknown): ContentRange | null {
  const matched = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value ?? "").trim());
  if (matched === null) {
    return null;
  }
  const start = Number.parseInt(matched[1], 10);
  const end = Number.parseInt(matched[2], 10);
  const total = matched[3] === "*" ? null : Number.parseInt(matched[3], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return null;
  }
  return { start, end, total };
}

/** 用 HEAD 探测文件长度；服务器不支持 HEAD 时返回 null。 */
export async function headContentLength(
  url: string,
  options: { headers?: Record<string, string>; request?: HostRequest } = {}
): Promise<number | null> {
  const request = options.request ?? hostRequest;
  try {
    const response = await request({
      method: "HEAD",
      url,
      headers: options.headers ?? {}
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    return parseContentLength(response.headers);
  } catch {
    return null;
  }
}

/**
 * 探测文件总长度：先 HEAD 的 Content-Length，失败再 GET Range 0-0 读 Content-Range。
 * 两样都拿不到时返回 null（调用方必须报错，不能盲发整包 GET）。
 */
export async function probeContentLength(
  url: string,
  options: { headers?: Record<string, string>; request?: HostRequest } = {}
): Promise<number | null> {
  const request = options.request ?? hostRequest;
  const headers = { ...(options.headers ?? {}) };

  try {
    const head = await request({ method: "HEAD", url, headers });
    if (head.status === 401 || head.status === 403) {
      assertDownloadable("HEAD", url, head);
    }
    if (head.status >= 200 && head.status < 300) {
      const length = parseContentLength(head.headers);
      if (length !== null) {
        return length;
      }
    }
  } catch (error) {
    if (isAuthFailure(error)) {
      throw error;
    }
  }

  try {
    const probe = await request({
      method: "GET",
      url,
      headers: { ...headers, Range: "bytes=0-0" }
    });
    if (probe.status === 401 || probe.status === 403) {
      assertDownloadable("GET", url, probe);
    }
    if (probe.status === 206) {
      const range = parseContentRange(probe.headers["content-range"]);
      if (range !== null && range.start === 0 && range.end === 0 && range.total !== null) {
        return range.total;
      }
      return null;
    }
    if (probe.status === 200) {
      // 服务器忽略 Range，这一次探测已经拿到整包；不再接受这个长度，
      // 避免后续再发一次整包 GET（也避免把大文件当小文件处理）。
      return null;
    }
    if (probe.status === 416) {
      const matched = /^bytes\s+\*\/(\d+)$/i.exec(
        String(probe.headers["content-range"] ?? "").trim()
      );
      if (matched !== null) {
        return Number.parseInt(matched[1], 10);
      }
    }
  } catch (error) {
    if (isAuthFailure(error)) {
      throw error;
    }
  }
  return null;
}

function assertWholeLength(bytes: Uint8Array, total: number, url: string): void {
  if (bytes.length !== total) {
    throw new Error(
      "下载长度不一致：期望 " +
        total +
        " 字节，实际 " +
        bytes.length +
        " 字节（" +
        redactUrl(url) +
        "）"
    );
  }
}

/**
 * 吞吐探测：Range 拉 1 MiB 并计时。拿到的字节直接算作第一块（调用方放进输出缓冲），
 * 不会为了「量速率」多下载一遍。
 */
async function probeThroughput(
  request: HostRequest,
  url: string,
  headers: Record<string, string>,
  total: number,
  now: () => number,
  log: (message: string) => void
): Promise<ProbeOutcome> {
  const key = throughputKey(url, headers);
  const cached = readCachedThroughput(key, now());
  if (cached !== null) {
    log(
      "吞吐缓存命中（" +
        describeThroughputKey(key) +
        "）：约 " +
        formatRate(cached) +
        "，分块 " +
        describeBytes(chunkSizeFor(cached))
    );
    return { kind: "rate", bytesPerMs: cached };
  }

  const end = Math.min(PROBE_CHUNK_BYTES, total) - 1;
  const startedAt = now();
  let response: HttpResponseData;
  try {
    response = await request({
      method: "GET",
      url,
      headers: { ...headers, Range: "bytes=0-" + end }
    });
  } catch (error) {
    if (isAuthFailure(error)) {
      throw error;
    }
    log("吞吐探测失败（" + describeError(error) + "），按默认 " + describeBytes(DEFAULT_CHUNK_SIZE) + " 分块");
    return { kind: "none" };
  }

  const elapsed = Math.max(1, now() - startedAt);
  assertDownloadable("GET", url, response);

  if (response.status === 200) {
    if (response.bytes.length === total) {
      log(
        "吞吐探测发现服务器忽略 Range（200 整包 " + response.bytes.length + " 字节），直接复用这份字节"
      );
      return { kind: "whole", bytes: response.bytes };
    }
    log(
      "吞吐探测拿到 200 但长度与预期不符（" +
        response.bytes.length +
        " / " +
        total +
        "），按默认 " +
        describeBytes(DEFAULT_CHUNK_SIZE) +
        " 分块"
    );
    return { kind: "none" };
  }

  const range = parseContentRange(response.headers["content-range"]);
  const expected = end + 1;
  if (
    range === null ||
    range.start !== 0 ||
    range.end !== end ||
    (range.total !== null && range.total !== total) ||
    response.bytes.length !== expected
  ) {
    log("吞吐探测的 Content-Range 与请求不一致，按默认 " + describeBytes(DEFAULT_CHUNK_SIZE) + " 分块");
    return { kind: "none" };
  }

  const bytesPerMs = response.bytes.length / elapsed;
  rememberThroughput(key, bytesPerMs, now());
  log(
    "吞吐探测：" +
      describeBytes(response.bytes.length) +
      " 用了 " +
      elapsed +
      "ms（约 " +
      formatRate(bytesPerMs) +
      "），分块 " +
      describeBytes(chunkSizeFor(bytesPerMs))
  );
  return { kind: "body", bytes: response.bytes, bytesPerMs };
}

/** 下载整段字节：块大小自适应，服务器忽略 Range 时整包兜底。 */
export async function downloadFileBytes(
  url: string,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  const request = options.request ?? hostRequest;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const retries = typeof options.retries === "number" && options.retries >= 0 ? options.retries : 3;
  const explicitChunk =
    typeof options.chunkSize === "number" && options.chunkSize > 0
      ? Math.trunc(options.chunkSize)
      : null;
  const adaptive = explicitChunk === null && options.adaptive !== false;
  const now = options.now ?? Date.now;
  const log = (message: string): void => logChunk(message, options.log);

  let total = typeof options.contentLength === "number" ? options.contentLength : null;
  if (total === null) {
    total = await probeContentLength(url, { headers, request });
  }
  if (total === null) {
    throw new Error(
      "服务器不支持分块下载，也拿不到文件长度（HEAD 与 Range 探测都失败），已停止下载"
    );
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new Error("服务器返回的文件长度不合法，已停止下载");
  }
  if (total > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      "文件太大（" +
        Math.ceil(total / (1024 * 1024)) +
        " MiB），超过插件下载上限 " +
        MAX_DOWNLOAD_BYTES / (1024 * 1024) +
        " MiB"
    );
  }

  const output = new Uint8Array(total);
  let offset = 0;
  let chunkCount = 0;
  let chunkSize = explicitChunk ?? DEFAULT_CHUNK_SIZE;

  if (explicitChunk === null) {
    if (!adaptive) {
      chunkSize = DEFAULT_CHUNK_SIZE;
    } else if (total <= MIN_CHUNK_SIZE) {
      // 不到 1 MiB 的包在 1 Mbps 上也只要 8 秒，不必探测：一次 GET 拿完。
      chunkSize = Math.max(1, total);
    } else {
      const probed = await probeThroughput(request, url, headers, total, now, log);
      if (probed.kind === "whole") {
        assertWholeLength(probed.bytes, total, url);
        return { bytes: probed.bytes, status: 200, chunkCount: 1, usedRange: false };
      }
      if (probed.kind === "body") {
        output.set(probed.bytes, 0);
        offset = probed.bytes.length;
        chunkCount = 1;
      }
      if (probed.kind === "body" || probed.kind === "rate") {
        chunkSize = chunkSizeFor(probed.bytesPerMs);
      } else {
        chunkSize = DEFAULT_CHUNK_SIZE;
      }
    }
  }

  if (offset === 0 && total <= chunkSize) {
    const response = await requestWithRetry(request, { method: "GET", url, headers }, retries);
    assertDownloadable("GET", url, response);
    assertWholeLength(response.bytes, total, url);
    return {
      bytes: response.bytes,
      status: response.status,
      chunkCount: 1,
      usedRange: false
    };
  }

  let fastStreak = 0;
  let shrinkRetries = 0;

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total) - 1;
    const startedAt = now();
    let response: HttpResponseData;
    try {
      response = await requestWithRetry(
        request,
        {
          method: "GET",
          url,
          headers: { ...headers, Range: "bytes=" + offset + "-" + end }
        },
        shrinkRetries === 0 ? retries : 0
      );
    } catch (error) {
      // 慢网络最常见的失败就是宿主 30 秒超时：把块减半后重试同一段，而不是整包失败。
      if (
        !adaptive ||
        isAuthFailure(error) ||
        chunkSize <= MIN_CHUNK_SIZE ||
        shrinkRetries >= MAX_SHRINK_RETRIES
      ) {
        throw error;
      }
      shrinkRetries += 1;
      fastStreak = 0;
      const previous = chunkSize;
      chunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
      log(
        "分块 " +
          describeBytes(previous) +
          " 失败（" +
          describeError(error) +
          "），块大小减半到 " +
          describeBytes(chunkSize)
      );
      continue;
    }

    const elapsed = now() - startedAt;
    chunkCount += 1;
    assertDownloadable("GET", url, response);

    if (response.status === 200) {
      // 服务器忽略 Range，直接给整包。
      assertWholeLength(response.bytes, total, url);
      return {
        bytes: response.bytes,
        status: 200,
        chunkCount,
        usedRange: false
      };
    }

    const range = parseContentRange(response.headers["content-range"]);
    if (
      range === null ||
      range.start !== offset ||
      range.end !== end ||
      range.total !== total
    ) {
      throw new Error(
        "服务器返回的 Content-Range 与请求不一致（请求 bytes=" +
          offset +
          "-" +
          end +
          "），已停止分块下载"
      );
    }

    const expected = end - offset + 1;
    if (response.bytes.length !== expected) {
      throw new Error(
        "服务器返回的块长度不一致：期望 " + expected + " 字节，实际 " + response.bytes.length + " 字节"
      );
    }
    output.set(response.bytes, offset);
    offset += response.bytes.length;
    shrinkRetries = 0;

    if (adaptive) {
      if (elapsed > SLOW_CHUNK_MS) {
        fastStreak = 0;
        const previous = chunkSize;
        chunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
        if (chunkSize !== previous) {
          log(
            "这一块 " +
              describeBytes(previous) +
              " 用了 " +
              elapsed +
              "ms（超过 " +
              SLOW_CHUNK_MS +
              "ms），块大小减半到 " +
              describeBytes(chunkSize)
          );
        }
      } else if (elapsed < FAST_CHUNK_MS) {
        fastStreak += 1;
        if (fastStreak >= 2) {
          fastStreak = 0;
          const previous = chunkSize;
          chunkSize = Math.min(MAX_CHUNK_SIZE, chunkSize * 2);
          if (chunkSize !== previous) {
            log(
              "连续两块都快于 " +
                FAST_CHUNK_MS +
                "ms，块大小翻倍到 " +
                describeBytes(chunkSize)
            );
          }
        }
      } else {
        fastStreak = 0;
      }
    }
  }

  if (offset !== total) {
    throw new Error("下载长度不一致：期望 " + total + " 字节，实际 " + offset + " 字节");
  }

  return { bytes: output, status: 206, chunkCount, usedRange: true };
}
