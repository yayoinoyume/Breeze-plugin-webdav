/**
 * 远程 ZIP（CBZ）读取：只读文件尾 EOCD + 中央目录，取页时只 Range 拉该条目的字节。
 *
 * 为什么要这样：整包下载 50 MiB 才能看第一页；按需取页后首屏只要约 0.6 MB。
 *
 * 服务器行为约定：
 * - 正常：GET + Range 返回 206 + Content-Range；
 * - 忽略 Range：返回 200 整包 → 抛 RemoteZipRangeUnsupportedError（带已下载的整包字节），
 *   由调用方回退到原有整包路径并记录诊断；
 * - 不支持 HEAD：用 Range 0-0 探测总长度；
 * - 5xx / 408 / 429：按 300ms 起指数退避重试（与整包下载一致）。
 *
 * 安全边界与整包路径一致：ZIP64 / 加密 / 64 MiB 单页 / 压缩比 / 压缩数据尺寸 / CRC32 都会拒绝。
 * 单页预检发生在任何字节请求之前。
 */

import type { HostRequest } from "../http/host.ts";
import { MAX_DOWNLOAD_BYTES, parseContentRange } from "../http/download.ts";
import { redactUrl } from "../errors.ts";
import {
  assertEntrySafeToExtract,
  extractEntryFromData,
  localDataStart,
  parseEndRecord,
  readCentralDirectory,
  LOCAL_HEADER_BYTES
} from "./cbz.ts";
import type { ZipEndRecord, ZipEntry } from "./cbz.ts";

/**
 * 取文件尾部窗口的大小：22 字节 EOCD + 65535 字节注释上限 = 65557。
 * 不能再小：恰好 65535 B 的合法注释会让 EOCD 落在窗口之外。
 */
export const EOCD_TAIL_BYTES = 22 + 0xffff;
/** 中央目录本身的上限（放宽到 64 MiB，避免误拒条目很多的合法包）。 */
export const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
/** 本地头里文件名 + 扩展字段的上限（放宽到 1 MiB）。 */
export const MAX_LOCAL_HEADER_EXTRA_BYTES = 1024 * 1024;
export const DEFAULT_RANGE_RETRIES = 3;

const EOCD_SIGNATURE = 0x06054b50;

export type RemoteZipSource = {
  url: string;
  headers: Record<string, string>;
  request: HostRequest;
  /** 单个响应体硬上限，默认与整包下载上限一致（256 MiB）。 */
  maxDownloadBytes?: number;
  /** 可重试状态码的最大重试次数，默认 3。 */
  retries?: number;
};

export type RemoteZipInfo = {
  totalSize: number;
  entries: ZipEntry[];
};

/** 回退原因分类：诊断按「包 key + 类型」去重，并发时也只记一条。 */
export type RemoteZipFallbackKind =
  | "range-ignored"
  | "probe-range-ignored"
  | "content-range-mismatch"
  | "range-length-mismatch"
  | "comment-too-large";

/** 服务器没有按 Range 返回（忽略 Range / 长度不符）：调用方应回退整包。 */
export class RemoteZipRangeUnsupportedError extends Error {
  /** 服务器这次返回的整包字节（若确实拿到了完整包，可直接复用，避免二次下载）。 */
  readonly fullBytes: Uint8Array | null;
  readonly kind: RemoteZipFallbackKind;

  constructor(
    message: string,
    fullBytes: Uint8Array | null,
    kind: RemoteZipFallbackKind
  ) {
    super(message);
    this.name = "RemoteZipRangeUnsupportedError";
    this.fullBytes = fullBytes;
    this.kind = kind;
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function downloadLimitOf(source: RemoteZipSource): number {
  const limit = source.maxDownloadBytes;
  return typeof limit === "number" && limit > 0 ? Math.trunc(limit) : MAX_DOWNLOAD_BYTES;
}

function tooLargeError(bytes: number, limit: number): Error {
  return new Error(
    "整包响应太大（" +
      Math.ceil(bytes / (1024 * 1024)) +
      " MiB），超过插件下载上限 " +
      Math.ceil(limit / (1024 * 1024)) +
      " MiB，已停止下载"
  );
}

/** 与整包下载一致的退避重试：5xx / 408 / 429 才重试，认证失败不重试。 */
async function requestWithRetry(
  source: RemoteZipSource,
  spec: Parameters<HostRequest>[0]
): Promise<Awaited<ReturnType<HostRequest>>> {
  const retries =
    typeof source.retries === "number" && source.retries >= 0
      ? Math.trunc(source.retries)
      : DEFAULT_RANGE_RETRIES;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await source.request(spec);
      if (!isRetryableStatus(response.status)) {
        return response;
      }
      lastError = new Error(
        "WebDAV 请求失败（HTTP " +
          response.status +
          "）：" +
          spec.method +
          " " +
          redactUrl(spec.url)
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

function assertAuthorized(status: number, url: string): void {
  if (status === 401 || status === 403) {
    throw new Error(
      "网盘用户名或密码不对（HTTP " + status + "）：GET " + redactUrl(url)
    );
  }
}

function httpFailure(status: number, url: string): Error {
  return new Error("WebDAV 请求失败（HTTP " + status + "）：GET " + redactUrl(url));
}

/** 发一次 Range 请求，并确认服务器真的按区间返回。 */
async function fetchRange(
  source: RemoteZipSource,
  start: number,
  endInclusive: number,
  totalSize: number
): Promise<Uint8Array> {
  const response = await requestWithRetry(source, {
    method: "GET",
    url: source.url,
    headers: { ...source.headers, Range: "bytes=" + start + "-" + endInclusive }
  });
  assertAuthorized(response.status, source.url);
  if (response.status === 200) {
    const limit = downloadLimitOf(source);
    if (response.bytes.length > limit) {
      throw tooLargeError(response.bytes.length, limit);
    }
    // 以 200 响应的实际长度为准：它就是整个文件，不再按 HEAD 长度二次下载。
    throw new RemoteZipRangeUnsupportedError(
      "服务器忽略 Range（请求 bytes=" +
        start +
        "-" +
        endInclusive +
        " 却返回 HTTP 200 整包 " +
        response.bytes.length +
        " 字节）",
      response.bytes,
      "range-ignored"
    );
  }
  if (response.status !== 206) {
    throw httpFailure(response.status, source.url);
  }
  const range = parseContentRange(response.headers["content-range"]);
  if (
    range === null ||
    range.start !== start ||
    range.end !== endInclusive ||
    (range.total !== null && range.total !== totalSize)
  ) {
    throw new RemoteZipRangeUnsupportedError(
      "服务器返回的 Content-Range 与请求不一致（请求 bytes=" +
        start +
        "-" +
        endInclusive +
        "，实际 " +
        String(response.headers["content-range"] ?? "缺失") +
        "）",
      null,
      "content-range-mismatch"
    );
  }
  const expected = endInclusive - start + 1;
  if (response.bytes.length !== expected) {
    throw new RemoteZipRangeUnsupportedError(
      "服务器返回的分块长度不对（期望 " + expected + " 字节，实际 " + response.bytes.length + " 字节）",
      null,
      "range-length-mismatch"
    );
  }
  return response.bytes;
}

/** 探测文件总长度：HEAD 优先，失败再用 Range 0-0。 */
async function probeTotalSize(source: RemoteZipSource): Promise<number> {
  let head: Awaited<ReturnType<HostRequest>> | null = null;
  try {
    head = await requestWithRetry(source, {
      method: "HEAD",
      url: source.url,
      headers: { ...source.headers }
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("网盘用户名或密码不对")) {
      throw error;
    }
  }
  if (head !== null) {
    assertAuthorized(head.status, source.url);
    if (head.status >= 200 && head.status < 300) {
      const raw = head.headers["content-length"];
      const value = raw === undefined ? Number.NaN : Number.parseInt(String(raw).trim(), 10);
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
  }

  const probe = await requestWithRetry(source, {
    method: "GET",
    url: source.url,
    headers: { ...source.headers, Range: "bytes=0-0" }
  });
  assertAuthorized(probe.status, source.url);
  if (probe.status === 206) {
    const range = parseContentRange(probe.headers["content-range"]);
    if (range !== null && range.total !== null) {
      return range.total;
    }
    throw new Error("服务器没有返回文件总长度（Content-Range 缺少 total），无法按需取页");
  }
  if (probe.status === 200) {
    const limit = downloadLimitOf(source);
    if (probe.bytes.length > limit) {
      throw tooLargeError(probe.bytes.length, limit);
    }
    throw new RemoteZipRangeUnsupportedError(
      "服务器忽略 Range（探测请求 bytes=0-0 却返回 HTTP 200 整包 " + probe.bytes.length + " 字节）",
      probe.bytes,
      "probe-range-ignored"
    );
  }
  if (probe.status === 416) {
    const matched = /^bytes\s+\*\/(\d+)$/i.exec(
      String(probe.headers["content-range"] ?? "").trim()
    );
    if (matched !== null) {
      return Number.parseInt(matched[1], 10);
    }
  }
  throw httpFailure(probe.status, source.url);
}

function findEndRecord(
  tail: Uint8Array,
  tailStart: number,
  totalSize: number
): { eocdInTail: number; record: ZipEndRecord } {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (readU32(tail, offset) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = readU16(tail, offset + 20);
    if (tailStart + offset + 22 + commentLength > totalSize) {
      continue;
    }
    return { eocdInTail: offset, record: parseEndRecord(tail, offset) };
  }
  if (tailStart > 0) {
    // 尾部窗口被截断：可能是注释超长，也可能不是 ZIP。交给整包路径定夺，不要硬失败。
    throw new RemoteZipRangeUnsupportedError(
      "在文件尾 " +
        EOCD_TAIL_BYTES +
        " 字节内找不到中央目录：可能是 ZIP 注释超过 65535 字节，或者文件不是有效的 CBZ",
      null,
      "comment-too-large"
    );
  }
  throw new Error("这不是有效的 CBZ/ZIP 文件（找不到中央目录）");
}

/** 读远程 CBZ 的中央目录（约几十 KB；整包不会被下载）。 */
export async function openRemoteZip(source: RemoteZipSource): Promise<RemoteZipInfo> {
  const totalSize = await probeTotalSize(source);
  if (totalSize === 0) {
    throw new Error("CBZ 文件是空的（0 字节）");
  }
  const tailStart = Math.max(0, totalSize - EOCD_TAIL_BYTES);
  const tail = await fetchRange(source, tailStart, totalSize - 1, totalSize);
  const found = findEndRecord(tail, tailStart, totalSize);
  const record = found.record;

  if (record.centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error(
      "CBZ 中央目录太大（" +
        Math.ceil(record.centralSize / (1024 * 1024)) +
        " MiB，上限 " +
        Math.ceil(MAX_CENTRAL_DIRECTORY_BYTES / (1024 * 1024)) +
        " MiB），已拒绝读取"
    );
  }
  const centralStart = record.centralOffset;
  const centralEnd = centralStart + record.centralSize;
  if (centralEnd > totalSize) {
    throw new Error("CBZ 中央目录越界（文件可能损坏）");
  }

  const centralInTail =
    centralStart >= tailStart && centralEnd <= tailStart + tail.length;
  const centralBytes = centralInTail
    ? tail.subarray(centralStart - tailStart, centralEnd - tailStart)
    : record.centralSize === 0
      ? new Uint8Array(0)
      : await fetchRange(source, centralStart, centralEnd - 1, totalSize);

  return { totalSize, entries: readCentralDirectory(centralBytes, 0, record.entryCount) };
}

/** 只拉这一页的本地头与压缩数据，然后复用整包路径的解压与 CRC 校验。 */
export async function readRemoteZipEntry(
  source: RemoteZipSource,
  totalSize: number,
  entry: ZipEntry
): Promise<Uint8Array> {
  // 任何字节请求之前先做硬性预检：加密 / 解压尺寸 / 压缩数据尺寸 / 压缩比。
  assertEntrySafeToExtract(entry);
  if (entry.localOffset + LOCAL_HEADER_BYTES > totalSize) {
    throw new Error("CBZ 条目偏移损坏");
  }
  const header = await fetchRange(
    source,
    entry.localOffset,
    entry.localOffset + LOCAL_HEADER_BYTES - 1,
    totalSize
  );
  const extraLength = readU16(header, 26) + readU16(header, 28);
  if (extraLength > MAX_LOCAL_HEADER_EXTRA_BYTES) {
    throw new Error(
      "CBZ 条目头异常（文件名或扩展字段超过 " +
        Math.ceil(MAX_LOCAL_HEADER_EXTRA_BYTES / 1024) +
        " KiB）"
    );
  }
  const dataStart = localDataStart(header, entry);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > totalSize) {
    throw new Error("CBZ 条目数据越界");
  }
  const compressed =
    entry.compressedSize === 0
      ? new Uint8Array(0)
      : await fetchRange(source, dataStart, dataEnd - 1, totalSize);
  return extractEntryFromData(entry, compressed);
}
