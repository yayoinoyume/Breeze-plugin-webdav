/**
 * 宿主网络桥。
 *
 * QuickJS 里的标准 fetch 只允许 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS，
 * 发不出 WebDAV 的 PROPFIND；宿主全局 __http_request_promise 不做方法白名单，
 * 所以这里直接调它。响应体默认 offload 到 native buffer，用 native.take 取回。
 */

import { redactUrl } from "../errors.ts";

export type HttpRequestSpec = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
};

export type HttpResponseData = {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  bytes: Uint8Array;
};

export type HostRequest = (spec: HttpRequestSpec) => Promise<HttpResponseData>;

type HostPayload = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  offloaded?: boolean;
  nativeBufferId?: number | null;
  error?: string;
  canceled?: boolean;
};

type HttpBridge = (
  method: string,
  url: string,
  headersJson: string,
  body: string | null,
  bodyNativeId: number | null
) => Promise<unknown>;

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function takeNativeBuffer(id: number): Promise<Uint8Array> {
  const native = (
    globalThis as unknown as {
      native?: { take?: (bufferId: number) => Promise<Uint8Array> };
    }
  ).native;
  if (!native || typeof native.take !== "function") {
    throw new Error("响应体在 native 缓冲区里，但当前环境没有 native.take，无法读取");
  }
  const bytes = await native.take(id);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** 用宿主 __http_request_promise 发一次请求，返回状态、头和原始字节。 */
export const hostRequest: HostRequest = async (spec) => {
  const bridge = (globalThis as unknown as { __http_request_promise?: HttpBridge })
    .__http_request_promise;
  if (typeof bridge !== "function") {
    throw new Error("当前 Breeze 版本太旧，插件用不了（缺少 __http_request_promise）");
  }

  const raw = await bridge(
    spec.method,
    spec.url,
    JSON.stringify(spec.headers ?? {}),
    spec.body ?? null,
    null
  );

  let payload: HostPayload;
  try {
    payload = JSON.parse(String(raw ?? "{}")) as HostPayload;
  } catch {
    throw new Error(`宿主返回了无法解析的响应：${String(raw).slice(0, 200)}`);
  }

  if (payload.ok === false) {
    if (payload.canceled === true) {
      throw new Error(`请求已取消：${spec.method} ${redactUrl(spec.url)}`);
    }
    throw new Error(
      `请求失败：${spec.method} ${redactUrl(spec.url)}：${payload.error ?? "未知错误"}`
    );
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(payload.headers ?? {})) {
    headers[name.toLowerCase()] = String(value);
  }

  let bytes: Uint8Array;
  if (payload.offloaded === true && payload.nativeBufferId != null) {
    bytes = await takeNativeBuffer(Number(payload.nativeBufferId));
  } else {
    bytes = encodeText(payload.body ?? "");
  }

  return {
    status: Number(payload.status ?? 0),
    statusText: String(payload.statusText ?? ""),
    url: String(payload.url ?? spec.url),
    headers,
    bytes
  };
};
