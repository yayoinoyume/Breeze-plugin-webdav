/**
 * 分块 Range 下载。
 *
 * 宿主单次请求有 30 秒总超时，大文件必须切块（默认 8 MiB 一块）。
 * 先探测总长度（HEAD，失败再 Range 0-0），拿不到就明确报错，绝不盲发整包 GET。
 */

import { hostRequest } from "./host.ts";
import type { HostRequest, HttpResponseData } from "./host.ts";
import { redactUrl } from "../errors.ts";

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export type DownloadOptions = {
  /** 已知文件长度时直接分块；不传则先 HEAD / Range 探测。 */
  contentLength?: number | null;
  /** 额外请求头（通常是 Basic 认证）。 */
  headers?: Record<string, string>;
  chunkSize?: number;
  /** 单块失败后的重试次数，默认 3。 */
  retries?: number;
  request?: HostRequest;
};

export type DownloadResult = {
  bytes: Uint8Array;
  /** 最后一次成功的 HTTP 状态：200 表示整包，206 表示分块。 */
  status: number;
  /** 实际发出的下载请求次数（探测不计）。 */
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

/** 下载整段字节：长度已知且大于一块时按 Range 分块，否则整包 GET。 */
export async function downloadFileBytes(
  url: string,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  const request = options.request ?? hostRequest;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const retries = typeof options.retries === "number" && options.retries >= 0 ? options.retries : 3;
  const chunkSize =
    typeof options.chunkSize === "number" && options.chunkSize > 0
      ? Math.trunc(options.chunkSize)
      : DEFAULT_CHUNK_SIZE;

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

  if (total <= chunkSize) {
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

  const output = new Uint8Array(total);
  let chunkCount = 0;
  let offset = 0;

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total) - 1;
    const response = await requestWithRetry(
      request,
      {
        method: "GET",
        url,
        headers: { ...headers, Range: "bytes=" + offset + "-" + end }
      },
      retries
    );
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
  }

  if (offset !== total) {
    throw new Error("下载长度不一致：期望 " + total + " 字节，实际 " + offset + " 字节");
  }

  return { bytes: output, status: 206, chunkCount, usedRange: true };
}
