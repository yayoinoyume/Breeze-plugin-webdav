/**
 * 分块 Range 下载。
 *
 * 宿主单次请求有 30 秒总超时，大文件必须切块（默认 8 MiB 一块）。
 * 服务器不支持 Range（回 200）时退化为整包 GET。
 */

import { hostRequest } from "./host.ts";
import type { HostRequest, HttpResponseData } from "./host.ts";

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

export type DownloadOptions = {
  /** 已知文件长度时直接分块；不传则先发 HEAD 探测。 */
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
  /** 实际发出的下载请求次数（HEAD 不计）。 */
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
      lastError = new Error(`服务器返回 HTTP ${response.status}：${spec.method} ${spec.url}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) {
      await wait(300 * Math.pow(2, attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function assertDownloadable(method: string, url: string, response: HttpResponseData): void {
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "网盘用户名或密码不对（HTTP " + response.status + "）：" + method + " " + url
    );
  }
  if (response.status !== 200 && response.status !== 206) {
    throw new Error("WebDAV 请求失败（HTTP " + response.status + "）：" + method + " " + url);
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

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
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
    total = await headContentLength(url, { headers, request });
  }

  if (total === null || total <= 0 || total <= chunkSize) {
    const response = await requestWithRetry(request, { method: "GET", url, headers }, retries);
    assertDownloadable("GET", url, response);
    return {
      bytes: response.bytes,
      status: response.status,
      chunkCount: 1,
      usedRange: false
    };
  }

  const parts: Uint8Array[] = [];
  let chunkCount = 0;
  let offset = 0;

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total) - 1;
    const response = await requestWithRetry(
      request,
      {
        method: "GET",
        url,
        headers: { ...headers, Range: `bytes=${offset}-${end}` }
      },
      retries
    );
    chunkCount += 1;
    assertDownloadable("GET", url, response);

    if (response.status === 200) {
      // 服务器忽略 Range，直接给整包。
      return {
        bytes: response.bytes,
        status: 200,
        chunkCount,
        usedRange: false
      };
    }

    if (response.bytes.length === 0) {
      throw new Error(`Range 响应为空：bytes=${offset}-${end}，${url}`);
    }

    parts.push(response.bytes);
    offset += response.bytes.length;
  }

  const bytes = concatBytes(parts, offset);
  if (bytes.length !== total) {
    throw new Error(`下载长度不一致：期望 ${total} 字节，实际 ${bytes.length} 字节（${url}）`);
  }

  return { bytes, status: 206, chunkCount, usedRange: true };
}
