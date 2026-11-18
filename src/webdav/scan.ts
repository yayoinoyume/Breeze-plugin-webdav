/**
 * 漫画扫描：从设置里的根路径开始 BFS，把「含图片的目录」和「CBZ/ZIP 整包」当成漫画。
 *
 * 规则：
 * - 目录的直接子项里有图片扩展名 → 这个目录是一本漫画，不再下钻；
 * - includeCbz 时 .cbz/.zip 文件各自是一本漫画；
 * - 没有图片的目录继续向下，层级最多到 scanDepth（根为第 0 层）；
 * - 总数最多 maxComics 本；列目录请求最多 maxListCalls 次。
 * - 列表层不做安全判定：名字再怪也照常参与扫描；只有「下钻目录」前用 canRequest 兜底，
 *   单次列目录失败也只跳过该目录并计数，绝不让一条脏数据弄挂整次扫描。
 */

import type { DavEntry } from "./xml.ts";
import { USER_MESSAGES, friendlyMessage } from "../errors.ts";
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
  /** 这条路径能否发请求（不抛就 true）。缺省视为可以，便于老测试桩。 */
  canRequest?(input: string): boolean;
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
  /** 扫描提示（跳过不安全条目 / 列目录上限），没有则为 null。 */
  warning: string | null;
  listCalls: number;
  /** 因路径含反斜杠而跳过的条目数（服务器可能把它当目录分隔符）。 */
  skippedEntries: number;
};

/** path 是否在 rootPath 内（含 rootPath 自身）。 */
function isWithinRootPath(path: string, rootPath: string): boolean {
  if (rootPath === "/") {
    return path.startsWith("/");
  }
  return path === rootPath || path.startsWith(rootPath + "/");
}

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

/**
 * 哪些列目录失败属于「整体不可用」，必须向上抛：
 * 认证失败、服务器不支持 PROPFIND、宿主太旧。其余（单个目录超时/404 等）只跳过该目录。
 */
export function isFatalListError(error: unknown): boolean {
  const message = friendlyMessage(error);
  return (
    message === USER_MESSAGES.auth ||
    message === USER_MESSAGES.propfind ||
    message === USER_MESSAGES.oldHost
  );
}

/** 列表阶段确实跳过条目/列目录失败时的中文提示（带数量）。 */
export function skippedEntriesWarning(count: number): string {
  return (
    "有 " + count + " 个条目无法安全读取（路径不安全或列目录失败），已跳过这些条目"
  );
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
  let skippedEntries = 0;

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
    let entries: DavEntry[];
    try {
      entries = await lister.list(current.path, 1);
    } catch (error) {
      // 认证/协议级错误整体抛；单个目录的局部失败只跳过它，整次扫描继续。
      if (isFatalListError(error)) {
        throw error;
      }
      skippedEntries += 1;
      continue;
    }
    const children: Array<{ entry: DavEntry; path: string }> = [];
    for (const entry of entries) {
      const relative = lister.relativePath(entry.href);
      if (relative === null || relative === "" || relative === current.path) {
        // 根路径外或自身条目：静默跳过，不算进 warning 的跳过计数。
        continue;
      }
      if (!isWithinRootPath(relative, rootPath)) {
        // 不在设置的 rootPath 下（例如服务器多返回了别处的条目）：静默忽略。
        continue;
      }
      // 列表层不做安全判定：名字再怪也进结果集，只有真正要发请求时才可能失败。
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
        if (!child.entry.isCollection) {
          continue;
        }
        // 下钻前才判定：这条路径发不出去（含字面 .. / 反斜杠 / 控制字符）就跳过并计数，
        // 不要等 list 抛了再挂掉整次扫描。
        if (lister.canRequest !== undefined && !lister.canRequest(child.path)) {
          skippedEntries += 1;
          continue;
        }
        queue.push({ path: child.path, depth: current.depth + 1 });
      }
    }
  }

  const warnings: string[] = [];
  if (skippedEntries > 0) {
    warnings.push(skippedEntriesWarning(skippedEntries));
  }
  if (budgetStopped) {
    warnings.push(budgetWarning(maxListCalls));
  }

  return {
    comics: comics
      .slice(0, maxComics)
      .sort((left, right) => naturalCompare(left.path, right.path)),
    warning: warnings.length === 0 ? null : warnings.join("；"),
    listCalls,
    skippedEntries
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
