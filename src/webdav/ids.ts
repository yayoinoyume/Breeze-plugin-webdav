/**
 * 可逆 id 编码（QuickJS 兼容）。
 *
 * - 漫画 id：dir:<base64url(path)> / cbz:<base64url(path)>
 * - 页面 url：wdav://<base64url(漫画路径)>#<页序号>
 */

const BASE64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export type ComicKind = "dir" | "cbz";

export type ComicRef = {
  kind: ComicKind;
  path: string;
};

function encodeBase64(bytes: Uint8Array): string {
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

function decodeBase64(text: string): Uint8Array {
  const cleaned = String(text ?? "").replace(/[^A-Za-z0-9+/]/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of cleaned) {
    const value = BASE64_TABLE.indexOf(char);
    if (value < 0) {
      continue;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** UTF-8 文本 → base64url（无补位）。 */
export function encodePathId(path: string): string {
  const bytes = new TextEncoder().encode(String(path ?? ""));
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → UTF-8 文本；非法输入返回空串。 */
export function decodePathId(id: string): string {
  try {
    const normalized = String(id ?? "").replace(/-/g, "+").replace(/_/g, "/");
    return new TextDecoder("utf-8").decode(decodeBase64(normalized));
  } catch {
    return "";
  }
}

export function encodeComicId(kind: ComicKind, path: string): string {
  return kind + ":" + encodePathId(path);
}

/** 解出漫画引用；无法识别返回 null。 */
export function decodeComicId(id: string): ComicRef | null {
  const text = String(id ?? "").trim();
  const matched = /^(dir|cbz):(.+)$/.exec(text);
  if (!matched) {
    return null;
  }
  const path = decodePathId(matched[2]);
  if (path === "") {
    return null;
  }
  return { kind: matched[1] === "cbz" ? "cbz" : "dir", path };
}

export function encodePageUrl(comicPath: string, index: number): string {
  return "wdav://" + encodePathId(comicPath) + "#" + String(Math.max(0, Math.trunc(index)));
}

/** 解出页面 url 中的漫画路径与页序号；格式不符返回 null。 */
export function parsePageUrl(url: string): { path: string; index: number } | null {
  const matched = /^wdav:\/\/([^#]+)(?:#(\d+))?$/i.exec(String(url ?? "").trim());
  if (!matched) {
    return null;
  }
  const path = decodePathId(matched[1]);
  if (path === "") {
    return null;
  }
  const index = matched[2] === undefined ? 0 : Number.parseInt(matched[2], 10);
  return { path, index: Number.isFinite(index) && index >= 0 ? index : 0 };
}
