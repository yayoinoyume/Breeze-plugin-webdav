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
 * - BFS 按层并行：同一层的目录并发 4 个（可配，上限 8），但结果按「层内服务器返回顺序」
 *   逐目录拼接，和串行 BFS 的结果、顺序、预算与跳过计数完全一致。
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
/** 同层并发列目录的默认值与上限：4 在 20ms 延迟下约 3.8 倍，8 已经接近服务器容忍边界。 */
export const DEFAULT_SCAN_CONCURRENCY = 4;
export const MAX_SCAN_CONCURRENCY = 8;

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
  /** 同层并发列目录数（1-8），默认 4；1 = 串行基线。 */
  concurrency?: number;
};

export type ScanResult = {
  comics: ComicEntry[];
  /** 扫描提示（跳过不安全条目 / 列目录上限），没有则为 null。 */
  warning: string | null;
  listCalls: number;
  /** 因路径含反斜杠而跳过的条目数（服务器可能把它当目录分隔符）。 */
  skippedEntries: number;
  /** 本次扫描使用的同层并发数（诊断用）。 */
  concurrency: number;
  /** 本次扫描实际观察到的最大在飞列目录请求数（诊断用）。 */
  maxInFlight: number;
  /** 本次扫描耗时（毫秒，诊断用）。 */
  elapsedMs: number;
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

/** 列表阶段确实跳过条目/列目录失败时的中文提示（带数量）。 */
export function skippedEntriesWarning(count: number): string {
  return (
    "有 " + count + " 个条目无法安全读取（路径不安全或列目录失败），已跳过这些条目"
  );
}

type ListJob = { path: string; depth: number };

type ListOutcome = {
  /** 本目录发现的漫画：目录自身在前，然后是 CBZ（与串行顺序一致）。 */
  comics: ComicEntry[];
  /** 需要继续下钻的子目录；只有「本目录没有图片」时才有。 */
  children: ListJob[];
  /** 本目录里因路径不可请求而跳过的条目数。 */
  skipped: number;
  failed: boolean;
  error: unknown;
};

/** 列一个目录，把「这本漫画是谁 / 要不要下钻 / 跳过了几条」算清楚，不直接改全局状态。 */
async function listDirectoryOutcome(
  lister: ComicLister,
  job: ListJob,
  rootPath: string,
  scanDepth: number,
  includeCbz: boolean
): Promise<ListOutcome> {
  const outcome: ListOutcome = { comics: [], children: [], skipped: 0, failed: false, error: null };
  let entries: DavEntry[];
  try {
    entries = await lister.list(job.path, 1);
  } catch (error) {
    // 根目录列不出来 = 整库不可用（认证、404、405、超时都要让人看到），交给调用方抛。
    outcome.failed = true;
    outcome.error = error;
    outcome.skipped = 1;
    return outcome;
  }

  const children: Array<{ entry: DavEntry; path: string }> = [];
  for (const entry of entries) {
    const relative = lister.relativePath(entry.href);
    if (relative === null || relative === "" || relative === job.path) {
      // 根路径外或自身条目：静默跳过，不算进 warning 的跳过计数。
      continue;
    }
    if (!isWithinRootPath(relative, rootPath)) {
      // 不在设置的 rootPath 下（例如服务器多返回了别处的条目）：静默忽略。
      continue;
    }
    // 发不出请求的条目（文件或目录）不进结果集：跳过并计数。
    // 文件也必须过滤，否则一条脏图片 href 会把父目录伪装成漫画。
    if (lister.canRequest !== undefined && !lister.canRequest(relative)) {
      outcome.skipped += 1;
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

  if (images.length > 0) {
    outcome.comics.push({
      kind: "dir",
      path: job.path,
      name: comicTitle("dir", job.path),
      coverImagePath: images[0].path
    });
  }
  for (const archive of archives) {
    outcome.comics.push({
      kind: "cbz",
      path: archive.path,
      name: comicTitle("cbz", archive.path),
      size: archive.entry.contentLength,
      updatedAt: archive.entry.lastModified
    });
  }

  if (images.length === 0 && job.depth < scanDepth) {
    for (const child of children) {
      if (child.entry.isCollection) {
        outcome.children.push({ path: child.path, depth: job.depth + 1 });
      }
    }
  }

  return outcome;
}

/** 扫描漫画列表，同时报告列目录预算与警告。 */
export async function scanComicsDetailed(
  lister: ComicLister,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const startedAt = Date.now();
  const rootPath = normalizeDavPath(options.rootPath ?? "/");
  const scanDepth = clampInt(options.scanDepth, 2, 1, 6);
  const maxComics = clampInt(options.maxComics, 300, 1, 2000);
  const maxListCalls = clampInt(options.maxListCalls, DEFAULT_MAX_LIST_CALLS, 1, 100000);
  const concurrency = clampInt(options.concurrency, DEFAULT_SCAN_CONCURRENCY, 1, MAX_SCAN_CONCURRENCY);
  const includeCbz = options.includeCbz !== false;

  let queue: ListJob[] = [{ path: rootPath, depth: 0 }];
  const comics: ComicEntry[] = [];
  const seen = new Set<string>();
  let listCalls = 0;
  let budgetStopped = false;
  let stoppedByMax = false;
  let skippedEntries = 0;
  let maxInFlight = 0;

  while (queue.length > 0) {
    const layer = queue;
    queue = [];
    const outcomes: Array<ListOutcome | null> = new Array(layer.length).fill(null);
    let nextIndex = 0;
    let inFlight = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (budgetStopped) {
          return;
        }
        if (listCalls >= maxListCalls) {
          budgetStopped = true;
          return;
        }
        const index = nextIndex;
        if (index >= layer.length) {
          return;
        }
        nextIndex += 1;
        listCalls += 1;
        inFlight += 1;
        if (inFlight > maxInFlight) {
          maxInFlight = inFlight;
        }
        const outcome = await listDirectoryOutcome(
          lister,
          layer[index],
          rootPath,
          scanDepth,
          includeCbz
        );
        inFlight -= 1;
        outcomes[index] = outcome;
        if (outcome.failed && layer[index].depth === 0) {
          // 根层失败：立刻停手，由下面的合并阶段抛出原始错误。
          return;
        }
      }
    };

    const workers: Promise<void>[] = [];
    const workerCount = Math.min(concurrency, layer.length);
    for (let index = 0; index < workerCount; index += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // 按「层内服务器返回顺序」逐目录合并：并发只影响谁先回来，不影响结果顺序。
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome === null) {
        continue;
      }
      if (outcome.failed) {
        if (layer[index].depth === 0) {
          throw outcome.error;
        }
        skippedEntries += 1;
        continue;
      }
      skippedEntries += outcome.skipped;
      for (const comic of outcome.comics) {
        if (comics.length >= maxComics) {
          stoppedByMax = true;
          break;
        }
        if (seen.has(comic.path)) {
          continue;
        }
        seen.add(comic.path);
        comics.push(comic);
      }
      if (stoppedByMax) {
        break;
      }
      for (const child of outcome.children) {
        queue.push(child);
      }
    }
    if (stoppedByMax || comics.length >= maxComics) {
      break;
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
    skippedEntries,
    concurrency,
    maxInFlight,
    elapsedMs: Date.now() - startedAt
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
