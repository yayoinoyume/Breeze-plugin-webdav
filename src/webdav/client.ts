/**
 * WebDAV 客户端：URL 拼接 / 百分号编码 / Basic 认证 / PROPFIND。
 *
 * QuickJS 的标准 fetch 不支持 PROPFIND，请求统一走 host.ts 的 __http_request_promise。
 */

import { hostRequest } from "../http/host.ts";
import type { HostRequest, HttpResponseData } from "../http/host.ts";
import { redactUrl } from "../errors.ts";
import { normalizeDavPath } from "../util/names.ts";
import { parseMultistatus } from "./xml.ts";
import type { DavEntry } from "./xml.ts";

export type WebDavClientOptions = {
  /** 服务器地址，例如 http://192.168.1.2:5005/dav；缺协议时按 http:// 补。 */
  baseUrl: string;
  username?: string;
  password?: string;
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
  /** 把服务器返回的 href 换算成相对根路径的路径；不在根路径下返回 null。 */
  relativePath(href: string): string | null;
  fetchBytes(input: string): Promise<HttpResponseData>;
};

export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<propfind xmlns="DAV:"><prop>' +
  "<displayname/><getcontentlength/><getlastmodified/><resourcetype/>" +
  "</prop></propfind>";

const BASE64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeCodePoint(char: string): string {
  try {
    return encodeURIComponent(char);
  } catch {
    return "%EF%BF%BD";
  }
}

/** 逐段编码路径。内部路径一律视为已解码字面量：% 会编码成 %25。 */
export function encodePath(path: string): string {
  return String(path ?? "")
    .split("/")
    .map((segment) => {
      let out = "";
      for (const char of Array.from(segment)) {
        out += encodeCodePoint(char);
      }
      return out;
    })
    .join("/");
}

/**
 * 拒绝路径里的 .. 段与反斜杠（单重与双重百分号编码都要拦），绝对 URL 与相对路径都要过。
 *
 * 为什么解码两次：内部路径里若出现字面 "%5C" / "%2e%2e"，编码上线后会变成
 * %255C / %252e%252e；只解一次看不出危险，但会二次解码的服务器仍可能越界。
 * 这里按「解码一次」和「解码两次」的结果分别检查，宁可拒绝一个合法文件名也不错放越界。
 */
function assertNoTraversalPath(path: string, context: string): void {
  for (const rawSegment of String(path ?? "").split("/")) {
    const decodedOnce = decodePercentSafe(rawSegment);
    for (const segment of [decodedOnce, decodePercentSafe(decodedOnce)]) {
      // 反斜杠：某些服务器把它当目录分隔符，/..\..\secret 会越出 rootPath。
      if (segment.includes("\\")) {
        throw new Error(context + "里不能包含反斜杠（服务器可能把它当成目录分隔符）");
      }
      // %2F 解码后可能再生出新的分段，逐个再查一遍。
      for (const sub of segment.split("/")) {
        if (sub === "..") {
          throw new Error(context + "里不能包含 ..（上级目录）");
        }
      }
    }
  }
}

function encodeAbsoluteUrl(url: string): string {
  const matched = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)([\s\S]*)$/i.exec(url);
  if (!matched) {
    return url;
  }
  const origin = matched[1].replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
  const path = matched[2] === "" ? "/" : matched[2];
  assertNoTraversalPath(path, "URL 路径");
  return `${origin}${encodePath(path)}${matched[3]}`;
}

/** 把服务器地址规范化：补协议、剥离 userinfo、去掉结尾斜杠。 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") {
    throw new Error("未配置 WebDAV 服务器地址（baseUrl）");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const matched = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i.exec(withScheme);
  if (matched === null) {
    throw new Error("WebDAV 服务器地址格式不对");
  }
  let authority = matched[2];
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    authority = authority.slice(at + 1);
  }
  if (authority === "") {
    throw new Error("WebDAV 服务器地址格式不对（缺少主机名）");
  }
  return (matched[1] + authority + matched[3]).replace(/\/+$/, "");
}

/** URL 的 origin（scheme://host:port，去掉 userinfo）。 */
export function originOf(url: string): string {
  const matched = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(String(url ?? ""));
  if (matched === null) {
    return "";
  }
  const scheme = matched[1].toLowerCase();
  let authority = matched[2].replace(/^.*@/, "").toLowerCase();
  if (scheme === "http" && authority.endsWith(":80")) {
    authority = authority.slice(0, -3);
  }
  if (scheme === "https" && authority.endsWith(":443")) {
    authority = authority.slice(0, -4);
  }
  return scheme + "://" + authority;
}

/** 相对路径拼到根 URL 上；绝对 URL 只允许同 origin，且只做安全编码。 */
export function resolveUrl(rootUrl: string, input: string): string {
  const raw = String(input ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const encoded = encodeAbsoluteUrl(raw);
    const baseOrigin = originOf(rootUrl);
    const targetOrigin = originOf(encoded);
    if (baseOrigin !== "" && targetOrigin !== "" && baseOrigin !== targetOrigin) {
      throw new Error("不允许访问其他站点的地址：" + redactUrl(encoded));
    }
    return encoded;
  }
  const base = rootUrl.replace(/\/+$/, "");
  const suffix = raw === "" ? "/" : raw.startsWith("/") ? raw : `/${raw}`;
  assertNoTraversalPath(suffix, "URL 路径");
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

function rawUrlPath(value: string): string {
  let path = String(value ?? "");
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  if (origin) {
    path = path.slice(origin[0].length) || "/";
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) {
    path = path.slice(0, cut);
  }
  if (!path.startsWith("/")) {
    path = "/" + path;
  }
  return path;
}

/**
 * href 的路径部分解码一次后是否含反斜杠。
 *
 * 这类条目不能进内部路径（请求层会拒绝），但列目录时也不能让一条脏数据
 * 弄挂整次扫描：调用方跳过它并计数，不要抛异常。
 */
export function hrefHasBackslash(href: string): boolean {
  return decodePercentSafe(rawUrlPath(href)).includes("\\");
}

/** 把 href 换算成「相对扫描根路径」的路径（已解码，以 / 开头）；不安全条目返回 null。 */
export function hrefToRelativePath(href: string, rootUrl: string): string | null {
  const hrefPath = toPathKey(rawUrlPath(href));
  // 反斜杠条目由调用方跳过并计数（见 hrefHasBackslash），这里不抛异常。
  if (hrefPath.includes("\\")) {
    return null;
  }
  const rootPath = toPathKey(rawUrlPath(rootUrl));
  if (hrefPath === rootPath) {
    return "/";
  }
  if (rootPath === "/") {
    return normalizeDavPath(hrefPath);
  }
  if (!hrefPath.startsWith(rootPath + "/")) {
    return null;
  }
  return normalizeDavPath(hrefPath.slice(rootPath.length));
}

function describeHttpError(method: string, url: string, response: HttpResponseData): Error {
  const status = response.status;
  const safeUrl = redactUrl(url);
  if (status === 401 || status === 403) {
    return new Error("网盘用户名或密码不对（HTTP " + status + "）：" + method + " " + safeUrl);
  }
  if (method === "PROPFIND" && (status === 405 || status === 501)) {
    return new Error(
      "这个网盘不支持列目录（PROPFIND），换一个 WebDAV 地址试试（HTTP " + status + "）"
    );
  }
  return new Error("WebDAV 请求失败（HTTP " + status + "）：" + method + " " + safeUrl);
}

export function createWebDavClient(options: WebDavClientOptions): WebDavClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  // 只在这里设一次根：rootPath 由扫描层作为路径的一部分拼进来，客户端不再二次拼接。
  const rootUrl = baseUrl;
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
      const xmlText = decodeUtf8(response.bytes);
      if (response.status === 200) {
        const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
        const looksHtml = /^\s*<(!doctype\s+html|html)\b/i.test(xmlText);
        if ((contentType !== "" && !/xml|dav/.test(contentType)) || looksHtml) {
          throw new Error("这个地址不是 WebDAV 根（PROPFIND 没返回 DAV XML）");
        }
      }
      return parseMultistatus(xmlText);
    },
    async list(input = "/", depth = 1) {
      const url = client.urlFor(input);
      const entries = await client.propfind(input, depth);
      const selfKey = toPathKey(url);
      return entries.filter((entry) => toPathKey(entry.href) !== selfKey);
    },
    relativePath(href) {
      return hrefToRelativePath(href, rootUrl);
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
