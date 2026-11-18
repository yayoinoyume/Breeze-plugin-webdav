/**
 * 漫画扫描：从设置里的根路径开始 BFS，把「含图片的目录」和「CBZ/ZIP 整包」当成漫画。
 *
 * 规则：
 * - 目录的直接子项里有图片扩展名 → 这个目录是一本漫画，不再下钻；
 * - includeCbz 时 .cbz/.zip 文件各自是一本漫画；
 * - 没有图片的目录继续向下，层级最多到 scanDepth（根为第 0 层）；
 * - 总数最多 maxComics 本；列目录请求最多 maxListCalls 次。
 */

import type { DavEntry } from "./xml.ts";
import {
  baseName,
  comicTitle,
  isCbzFile,
  isImageFile,
  naturalCompare,
  normalizeDavPath
} from "../util/names.ts";
import type { ComicKind } from "./ids.ts";

export const DEFAULT_MAX_LIST_CALLS = 2000;

export type ComicEntry = {
  kind: ComicKind;
  /** 相对服务器根路径的路径（以 / 开头，包含设置里的 rootPath，目录不带结尾斜杠）。 */
  path: string;
  name: string;
  /** 目录漫画的第一张图（按自然序）。 */
  coverImagePath?: string;
  /** CBZ 的字节数（服务器给了才有）。 */
  size?: number | null;
  updatedAt?: string | null;
};

export type ComicLister = {
  list(input?: string, depth?: number): Promise<DavEntry[]>;
  /** 把服务器返回的 href 换算成相对服务器根路径的路径；不在根路径下返回 null。 */
  relativePath(href: string): string | null;
};

export type ScanOptions = {
  rootPath?: string;
  scanDepth?: number;
  maxComics?: number;
  includeCbz?: boolean;
  /** 列目录请求上限，默认 2000。 */
  maxListCalls?: number;
};

export type ScanResult = {
  comics: ComicEntry[];
  /** 达到列目录上限时的中文提示，否则 null。 */
  warning: string | null;
  listCalls: number;
};

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function budgetWarning(limit: number): string {
  return "目录太多，扫描已在上限 " + limit + " 次列目录请求处停止，结果可能不完整";
}

/** 扫描漫画列表，同时报告列目录预算与警告。 */
export async function scanComicsDetailed(
  lister: ComicLister,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const rootPath = normalizeDavPath(options.rootPath ?? "/");
  const scanDepth = clampInt(options.scanDepth, 2, 1, 6);
  const maxComics = clampInt(options.maxComics, 300, 1, 2000);
  const maxListCalls = clampInt(options.maxListCalls, DEFAULT_MAX_LIST_CALLS, 1, 100000);
  const includeCbz = options.includeCbz !== false;

  const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
  const comics: ComicEntry[] = [];
  const seen = new Set<string>();
  let listCalls = 0;
  let budgetStopped = false;

  while (queue.length > 0 && comics.length < maxComics) {
    if (listCalls >= maxListCalls) {
      budgetStopped = true;
      break;
    }
    const current = queue.shift();
    if (current === undefined) {
      break;
    }

    listCalls += 1;
    const entries = await lister.list(current.path, 1);
    const children: Array<{ entry: DavEntry; path: string }> = [];
    for (const entry of entries) {
      const relative = lister.relativePath(entry.href);
      if (relative === null || relative === "" || relative === current.path) {
        continue;
      }
      children.push({ entry, path: relative });
    }
    children.sort((left, right) => naturalCompare(left.path, right.path));

    const images = children.filter(
      (child) => child.entry.isCollection === false && isImageFile(child.path)
    );
    const archives = includeCbz
      ? children.filter((child) => child.entry.isCollection === false && isCbzFile(child.path))
      : [];

    if (images.length > 0 && !seen.has(current.path)) {
      seen.add(current.path);
      comics.push({
        kind: "dir",
        path: current.path,
        name: comicTitle("dir", current.path),
        coverImagePath: images[0].path
      });
    }

    for (const archive of archives) {
      if (comics.length >= maxComics) {
        break;
      }
      if (seen.has(archive.path)) {
        continue;
      }
      seen.add(archive.path);
      comics.push({
        kind: "cbz",
        path: archive.path,
        name: comicTitle("cbz", archive.path),
        size: archive.entry.contentLength,
        updatedAt: archive.entry.lastModified
      });
    }

    if (images.length === 0 && current.depth < scanDepth) {
      for (const child of children) {
        if (child.entry.isCollection) {
          queue.push({ path: child.path, depth: current.depth + 1 });
        }
      }
    }
  }

  return {
    comics: comics
      .slice(0, maxComics)
      .sort((left, right) => naturalCompare(left.path, right.path)),
    warning: budgetStopped ? budgetWarning(maxListCalls) : null,
    listCalls
  };
}

/** 扫描漫画列表（按路径自然序返回），兼容旧调用；数组上附带 warning 字段。 */
export async function scanComics(
  lister: ComicLister,
  options: ScanOptions = {}
): Promise<ComicEntry[]> {
  const result = await scanComicsDetailed(lister, options);
  const comics = result.comics as ComicEntry[] & { warning?: string | null };
  comics.warning = result.warning;
  return comics;
}

/** 目录漫画的图片路径（自然序）。 */
export function sortImagePaths(paths: string[]): string[] {
  return paths
    .filter((path) => isImageFile(path))
    .sort((left, right) => naturalCompare(baseName(left), baseName(right)) || naturalCompare(left, right));
}
