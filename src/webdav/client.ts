/**
 * WebDAV 客户端：URL 拼接 / 百分号编码 / Basic 认证 / PROPFIND。
 *
 * QuickJS 的标准 fetch 不支持 PROPFIND，请求统一走 host.ts 的 __http_request_promise。
 */

import { hostRequest } from "../http/host.ts";
import type { HostRequest, HttpResponseData } from "../http/host.ts";
import { parseMultistatus } from "./xml.ts";
import type { DavEntry } from "./xml.ts";

export type WebDavClientOptions = {
  /** 服务器地址，例如 http://192.168.1.2:5005/dav；缺协议时按 http:// 补。 */
  baseUrl: string;
  username?: string;
  password?: string;
  /** 漫画库在服务器上的根路径，默认 "/"。 */
  rootPath?: string;
  /** 便于测试替换的请求实现。 */
  request?: HostRequest;
};

export type WebDavClient = {
  readonly baseUrl: string;
  readonly rootUrl: string;
  readonly options: WebDavClientOptions;
  authHeaders(): Record<string, string>;
  urlFor(input: string): string;
  propfind(input: string, depth?: number): Promise<DavEntry[]>;
  list(input?: string, depth?: number): Promise<DavEntry[]>;
  fetchBytes(input: string): Promise<HttpResponseData>;
};

export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<propfind xmlns="DAV:"><prop>' +
  "<displayname/><getcontentlength/><getlastmodified/><resourcetype/>" +
  "</prop></propfind>";

const PERCENT_TRIPLET = /^[0-9A-Fa-f]{2}$/;
const BASE64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeCodePoint(char: string): string {
  try {
    return encodeURIComponent(char);
  } catch {
    return "%EF%BF%BD";
  }
}

/** 逐段编码路径；已有 %XX 转义原样保留，避免二次编码。 */
export function encodePath(path: string): string {
  return String(path ?? "")
    .split("/")
    .map((segment) => {
      let out = "";
      const chars = Array.from(segment);
      for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index];
        if (
          char === "%" &&
          index + 2 < chars.length &&
          PERCENT_TRIPLET.test(chars[index + 1] + chars[index + 2])
        ) {
          out += `%${chars[index + 1]}${chars[index + 2]}`.toUpperCase();
          index += 2;
          continue;
        }
        out += encodeCodePoint(char);
      }
      return out;
    })
    .join("/");
}

function encodeAbsoluteUrl(url: string): string {
  const matched = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)([\s\S]*)$/i.exec(url);
  if (!matched) {
    return url;
  }
  const origin = matched[1];
  const path = matched[2] === "" ? "/" : matched[2];
  return `${origin}${encodePath(path)}${matched[3]}`;
}

/** 把服务器地址规范化：补协议、去掉结尾斜杠。 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") {
    throw new Error("未配置 WebDAV 服务器地址（baseUrl）");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/** 相对路径拼到根 URL 上；已经是绝对 URL 的输入只做安全编码。 */
export function resolveUrl(rootUrl: string, input: string): string {
  const raw = String(input ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return encodeAbsoluteUrl(raw);
  }
  const base = rootUrl.replace(/\/+$/, "");
  const suffix = raw === "" ? "/" : raw.startsWith("/") ? raw : `/${raw}`;
  return `${base}${encodePath(suffix)}`;
}

/** 手写 base64（UTF-8 输入）：QuickJS 虽有 btoa，但它只接受 latin1，中文口令会坏。 */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const byte1 = bytes[index];
    const byte2 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const byte3 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (byte1 << 16) | (byte2 << 8) | byte3;
    out += BASE64_TABLE[(triple >> 18) & 63];
    out += BASE64_TABLE[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? BASE64_TABLE[(triple >> 6) & 63] : "=";
    out += index + 2 < bytes.length ? BASE64_TABLE[triple & 63] : "=";
    index += 3;
  }
  return out;
}

/** 生成 Basic 认证头；用户名和密码都为空时返回 null（匿名访问）。 */
export function buildBasicAuthHeader(username?: string, password?: string): string | null {
  const user = String(username ?? "");
  const pass = String(password ?? "");
  if (user === "" && pass === "") {
    return null;
  }
  return `Basic ${encodeBase64Utf8(`${user}:${pass}`)}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function decodePercentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 把 URL / href 归一成可比较的路径键（去掉 origin、查询串、结尾斜杠）。 */
function toPathKey(value: string): string {
  let path = String(value ?? "");
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(path);
  if (origin) {
    path = path.slice(origin[0].length) || "/";
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) {
    path = path.slice(0, cut);
  }
  path = decodePercentSafe(path);
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

function describeHttpError(method: string, url: string, response: HttpResponseData): Error {
  if (response.status === 401 || response.status === 403) {
    return new Error(`WebDAV 认证失败（HTTP ${response.status}）：${method} ${url}`);
  }
  return new Error(`WebDAV 请求失败（HTTP ${response.status}）：${method} ${url}`);
}

export function createWebDavClient(options: WebDavClientOptions): WebDavClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const rootPath = String(options.rootPath ?? "/").trim() || "/";
  const rootUrl = resolveUrl(baseUrl, rootPath);
  const request = options.request ?? hostRequest;
  const authorization = buildBasicAuthHeader(options.username, options.password);

  const client: WebDavClient = {
    baseUrl,
    rootUrl,
    options,
    authHeaders() {
      const headers: Record<string, string> = {};
      if (authorization !== null) {
        headers.Authorization = authorization;
      }
      return headers;
    },
    urlFor(input) {
      return resolveUrl(rootUrl, input);
    },
    async propfind(input = "/", depth = 1) {
      const url = client.urlFor(input);
      const response = await request({
        method: "PROPFIND",
        url,
        headers: {
          ...client.authHeaders(),
          Depth: String(depth),
          "Content-Type": "application/xml; charset=utf-8"
        },
        body: PROPFIND_BODY
      });
      if (response.status !== 207 && response.status !== 200) {
        throw describeHttpError("PROPFIND", url, response);
      }
      return parseMultistatus(decodeUtf8(response.bytes));
    },
    async list(input = "/", depth = 1) {
      const url = client.urlFor(input);
      const entries = await client.propfind(input, depth);
      const selfKey = toPathKey(url);
      return entries.filter((entry) => toPathKey(entry.href) !== selfKey);
    },
    async fetchBytes(input) {
      const url = client.urlFor(input);
      const response = await request({
        method: "GET",
        url,
        headers: client.authHeaders()
      });
      if (response.status < 200 || response.status >= 300) {
        throw describeHttpError("GET", url, response);
      }
      return response;
    }
  };

  return client;
}

/** 便捷函数：列目录（depth 默认 1，已剔除自身条目）。 */
export function listDirectory(
  client: WebDavClient,
  input = "/",
  depth = 1
): Promise<DavEntry[]> {
  return client.list(input, depth);
}

/** 便捷函数：按路径或 URL 取整段字节（小图 / 单页用）。 */
export function fetchFileBytes(client: WebDavClient, input: string): Promise<HttpResponseData> {
  return client.fetchBytes(input);
}
