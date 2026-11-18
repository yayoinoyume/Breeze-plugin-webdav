/**
 * 文件名比较与小工具（QuickJS 兼容，不依赖 node）。
 */

/** 自然排序：p2 在 p10 前；数字段按数值比较，其余按小写字典序。 */
export function naturalCompare(a: string, b: string): number {
  const chunksA = String(a).split(/(\d+)/);
  const chunksB = String(b).split(/(\d+)/);
  const len = Math.min(chunksA.length, chunksB.length);
  for (let i = 0; i < len; i += 1) {
    const chunkA = chunksA[i];
    const chunkB = chunksB[i];
    if (chunkA === chunkB) {
      continue;
    }
    const aIsNum = /^\d+$/.test(chunkA);
    const bIsNum = /^\d+$/.test(chunkB);
    if (aIsNum && bIsNum) {
      const numA = Number.parseInt(chunkA, 10);
      const numB = Number.parseInt(chunkB, 10);
      if (Number.isSafeInteger(numA) && Number.isSafeInteger(numB)) {
        if (numA !== numB) {
          return numA - numB;
        }
        continue;
      }
      // 超长数字（超过安全整数）退化为去前导零后的长度/字典序比较。
      const strippedA = chunkA.replace(/^0+/, "") || "0";
      const strippedB = chunkB.replace(/^0+/, "") || "0";
      if (strippedA.length !== strippedB.length) {
        return strippedA.length - strippedB.length;
      }
      if (strippedA !== strippedB) {
        return strippedA < strippedB ? -1 : 1;
      }
      continue;
    }
    if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1;
    }
    const lowerA = chunkA.toLowerCase();
    const lowerB = chunkB.toLowerCase();
    if (lowerA !== lowerB) {
      return lowerA < lowerB ? -1 : 1;
    }
    continue;
  }
  return chunksA.length - chunksB.length;
}

/** 图片扩展名白名单（大小写不敏感）。 */
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];

/** 是否图片文件（按扩展名判断，忽略大小写）。 */
export function isImageFile(name: string): boolean {
  const lower = String(name ?? "").toLowerCase();
  if (lower === "" || lower.endsWith("/")) {
    return false;
  }
  for (const extension of IMAGE_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

/** 是否 CBZ / ZIP 整包。 */
export function isCbzFile(name: string): boolean {
  const lower = String(name ?? "").toLowerCase();
  return lower.endsWith(".cbz") || lower.endsWith(".zip");
}

/** 只做字符串整理：补前导斜杠、折叠重复斜杠、去掉结尾斜杠。不做安全检查，永不抛。 */
export function tidyDavPath(path: string): string {
  // 路径层不 trim：文件名尾随空格是合法字符，不能悄悄改掉。
  let value = String(path ?? "");
  if (value === "") {
    return "/";
  }
  if (!value.startsWith("/")) {
    value = "/" + value;
  }
  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1) {
    value = value.replace(/\/+$/, "");
  }
  return value === "" ? "/" : value;
}

/** 整理路径并拒绝真实危险形态（字面反斜杠、.. 段）。只用于请求层与设置项。 */
export function normalizeDavPath(path: string): string {
  // 设置项（用户输入）允许首尾空白；整理后再做安全检查。
  const value = tidyDavPath(String(path ?? "").trim());
  // 反斜杠：有些 WebDAV 服务器把它当目录分隔符，放过去就能绕过下面的 .. 检查。
  if (value.includes("\\")) {
    throw new Error("路径里不能包含反斜杠（服务器可能把它当成目录分隔符）");
  }
  if (value.split("/").some((segment) => segment === "..")) {
    throw new Error("路径里不能包含 ..（上级目录）");
  }
  return value;
}

/** 路径最后一段（目录路径不带结尾斜杠）。永不抛：列表里出现什么样的名字都不该中断。 */
export function baseName(path: string): string {
  const value = tidyDavPath(path);
  if (value === "/") {
    return "";
  }
  const segments = value.split("/");
  return segments[segments.length - 1] ?? "";
}

/** 去掉 .cbz / .zip 扩展名。 */
export function stripArchiveExtension(name: string): string {
  return String(name ?? "").replace(/\.(cbz|zip)$/i, "");
}

/** 由相对路径生成漫画标题：目录取目录名，整包取去掉扩展名的文件名。 */
export function comicTitle(kind: "dir" | "cbz", path: string): string {
  const name = baseName(path);
  const title = kind === "cbz" ? stripArchiveExtension(name) : name;
  return title === "" ? "漫画库" : title;
}
