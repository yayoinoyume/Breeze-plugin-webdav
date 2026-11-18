/**
 * 插件业务层：搜索 / 详情 / 阅读快照 / 取图。
 *
 * 封面与页面都用 wdav:// 占位 url，真正的字节由 fetchImageBytes 按 extern 定位。
 * 目录漫画每次按需 PROPFIND；CBZ 整包下载后放模块内 LRU（按 256 MiB 总字节预算逐出）。
 */

import type {
  ActionItem,
  ChapterContentContract,
  ChapterPage,
  ChapterPayload,
  ChapterSummary,
  ChapterWithPages,
  ComicDetailContract,
  ComicDetailNormal,
  ComicDetailPayload,
  ComicListItem,
  ComicPagedListContract,
  FetchImageBytesPayload,
  ImageItem,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  SearchComicPayload,
  SearchResultContract,
  StringMap
} from "breeze-plugin-kit";
import { PLUGIN_ID } from "./plugin-info.ts";
import { withFriendlyErrors } from "./errors.ts";
import { loadSettings } from "./settings.ts";
import type { WebDavSettings } from "./settings.ts";
import { createWebDavClient, hrefHasBackslash } from "./webdav/client.ts";
import type { WebDavClient } from "./webdav/client.ts";
import { downloadFileBytes } from "./http/download.ts";
import { scanComicsDetailed, sortImagePaths } from "./webdav/scan.ts";
import type { ComicEntry, ScanResult } from "./webdav/scan.ts";
import { decodeComicId, encodeComicId, encodePageUrl, parsePageUrl } from "./webdav/ids.ts";
import type { ComicKind } from "./webdav/ids.ts";
import { extractZipEntry, listZipImages, readZipEntries } from "./zip/cbz.ts";
import type { ZipEntry } from "./zip/cbz.ts";
import {
  baseName,
  comicTitle,
  isImageFile,
  normalizeDavPath
} from "./util/names.ts";

export const SEARCH_PAGE_SIZE = 20;
export const MAIN_CHAPTER_NAME = "全一话";

export const ZIP_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const SCAN_CACHE_TTL_MS = 45 * 1000;

let zipCacheBudget = ZIP_CACHE_BUDGET_BYTES;

type CachedZip = {
  /** baseUrl + username + 路径，换账号不会串包。 */
  key: string;
  path: string;
  bytes: Uint8Array;
};

const zipCache: CachedZip[] = [];
const inflightZip = new Map<string, Promise<Uint8Array>>();

type ScanCacheEntry = {
  key: string;
  expiresAt: number;
  result: ScanResult;
};

let scanCache: ScanCacheEntry | null = null;
let lastScanWarning: string | null = null;

type ComicRef = {
  kind: ComicKind;
  path: string;
};

/** 清空模块内 CBZ 缓存（测试用）。 */
export function clearZipCache(): void {
  zipCache.length = 0;
  inflightZip.clear();
  zipCacheBudget = ZIP_CACHE_BUDGET_BYTES;
}

/** 调整 CBZ 缓存预算（测试用）；传 null 恢复默认。 */
export function setZipCacheBudgetForTests(bytes: number | null): void {
  zipCacheBudget =
    bytes === null ? ZIP_CACHE_BUDGET_BYTES : Math.max(1, Math.trunc(bytes));
  trimZipCache();
}

function zipCacheKey(client: WebDavClient, path: string): string {
  return client.baseUrl + "|" + String(client.options.username ?? "") + "|" + path;
}

function zipCacheBytesTotal(): number {
  let total = 0;
  for (const entry of zipCache) {
    total += entry.bytes.length;
  }
  return total;
}

function trimZipCache(): void {
  let total = zipCacheBytesTotal();
  while (zipCache.length > 1 && total > zipCacheBudget) {
    const removed = zipCache.pop();
    if (removed === undefined) {
      break;
    }
    total -= removed.bytes.length;
  }
}

/** 清空扫描缓存（测试用）。 */
export function clearScanCache(): void {
  scanCache = null;
  lastScanWarning = null;
}

/** 最近一次扫描的警告（达到列目录上限时非空）。 */
export function getLastScanWarning(): string | null {
  return lastScanWarning;
}

/** 当前缓存的 CBZ 路径（新的在前，测试用）。 */
export function zipCachePaths(): string[] {
  return zipCache.map((entry) => entry.path);
}

/** 当前缓存的 CBZ 复合键（新的在前，测试用）。 */
export function zipCacheKeys(): string[] {
  return zipCache.map((entry) => entry.key);
}

/** 当前缓存占用的总字节数（测试用）。 */
export function zipCacheBytes(): number {
  return zipCacheBytesTotal();
}

function asRecord(value: unknown): StringMap {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as StringMap;
  }
  return {};
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function toIndex(values: unknown[], fallback: number): number {
  for (const value of values) {
    const number =
      typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
    if (Number.isFinite(number) && number >= 0) {
      return Math.trunc(number);
    }
  }
  return fallback;
}

function missingConfig(): Error {
  return new Error("请先在插件设置里填写 WebDAV 服务器地址（如 http://192.168.1.2:5005/dav）");
}

/** 按设置创建 WebDAV 客户端；地址为空时给出人话提示。 */
export function clientForSettings(settings: WebDavSettings): WebDavClient {
  if (String(settings.baseUrl ?? "").trim() === "") {
    throw missingConfig();
  }
  return createWebDavClient({
    baseUrl: settings.baseUrl,
    username: settings.username,
    password: settings.password
  });
}

function scanCacheKey(settings: WebDavSettings): string {
  return [
    settings.baseUrl,
    settings.username,
    settings.rootPath,
    String(settings.scanDepth),
    String(settings.maxComics),
    settings.includeCbz ? "1" : "0"
  ].join("|");
}

/** 扫描当前设置下的全部漫画；45 秒内翻页复用同一次扫描。 */
export async function listComicEntriesDetailed(
  client: WebDavClient,
  settings: WebDavSettings,
  options: { force?: boolean } = {}
): Promise<ScanResult> {
  const key = scanCacheKey(settings);
  const now = Date.now();
  if (!options.force && scanCache !== null && scanCache.key === key && scanCache.expiresAt > now) {
    return scanCache.result;
  }

  const result = await scanComicsDetailed(
    {
      list: (input, depth) => client.list(input, depth),
      relativePath: (href) => client.relativePath(href)
    },
    {
      rootPath: settings.rootPath,
      scanDepth: settings.scanDepth,
      maxComics: settings.maxComics,
      includeCbz: settings.includeCbz
    }
  );
  scanCache = { key, expiresAt: now + SCAN_CACHE_TTL_MS, result };
  lastScanWarning = result.warning;
  return result;
}

/** 扫描当前设置下的全部漫画；数组上附带 warning 字段。 */
export async function listComicEntries(
  client: WebDavClient,
  settings: WebDavSettings
): Promise<ComicEntry[]> {
  const result = await listComicEntriesDetailed(client, settings);
  const comics = result.comics as ComicEntry[] & { warning?: string | null };
  comics.warning = result.warning;
  return comics;
}

/** 按关键词过滤（只比标题，大小写不敏感）。 */
export function filterComics(comics: ComicEntry[], keyword: string): ComicEntry[] {
  const query = String(keyword ?? "").trim().toLowerCase();
  if (query === "") {
    return comics;
  }
  return comics.filter((comic) => comic.name.toLowerCase().includes(query));
}

export type PageSlice = {
  items: ComicEntry[];
  page: number;
  pages: number;
  total: number;
  hasReachedMax: boolean;
};

/** 页码分页（页码从 1 开始，越界自动夹到有效范围）。 */
export function paginateComics(
  comics: ComicEntry[],
  page: number,
  pageSize: number = SEARCH_PAGE_SIZE
): PageSlice {
  const total = comics.length;
  const size = pageSize > 0 ? Math.trunc(pageSize) : SEARCH_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (current - 1) * size;
  return {
    items: comics.slice(start, start + size),
    page: current,
    pages,
    total,
    hasReachedMax: current >= pages
  };
}

function makeCover(comic: ComicEntry): ImageItem {
  const id = "cover:" + encodeComicId(comic.kind, comic.path);
  if (comic.kind === "dir") {
    const imagePath = comic.coverImagePath ?? "";
    return {
      id,
      url: encodePageUrl(comic.path, 0),
      name: imagePath === "" ? comic.name : baseName(imagePath),
      path: imagePath === "" ? comic.path : imagePath,
      extern: {
        kind: "dir",
        path: comic.path,
        index: 0,
        ...(imagePath === "" ? {} : { imagePath })
      }
    };
  }
  return {
    id,
    url: encodePageUrl(comic.path, 0),
    name: baseName(comic.path),
    path: comic.path,
    extern: { kind: "cbz", path: comic.path, index: 0 }
  };
}

/** 扫描结果 → 列表卡片。 */
export function buildListItem(comic: ComicEntry): ComicListItem {
  const id = encodeComicId(comic.kind, comic.path);
  const pathItem: ActionItem = {
    name: comic.path,
    onTap: null,
    onLongPress: comic.path,
    extern: {}
  };
  return {
    source: PLUGIN_ID,
    id,
    title: comic.name,
    subtitle: comic.kind === "cbz" ? "CBZ 整包" : "图片文件夹",
    finished: false,
    likesCount: 0,
    viewsCount: 0,
    updatedAt: comic.updatedAt ?? "",
    cover: makeCover(comic),
    metadata: [{ type: "path", name: "路径", value: [pathItem] }],
    raw: { kind: comic.kind, path: comic.path },
    extern: { kind: comic.kind, path: comic.path }
  };
}

function buildChapterSummary(comic: ComicRef): ChapterSummary {
  const id = encodeComicId(comic.kind, comic.path);
  return {
    id,
    requestId: id,
    logicalKey: id,
    storageChapterId: id,
    name: MAIN_CHAPTER_NAME,
    order: 0,
    extern: { kind: comic.kind, path: comic.path }
  };
}

async function listDirImages(client: WebDavClient, comicPath: string): Promise<string[]> {
  const entries = await client.list(comicPath, 1);
  const images: string[] = [];
  for (const entry of entries) {
    if (entry.isCollection) {
      continue;
    }
    // 含反斜杠的条目在请求层会被拒绝，这里直接跳过，不要让一条脏数据弄挂整本漫画。
    if (hrefHasBackslash(entry.href)) {
      continue;
    }
    const relative = client.relativePath(entry.href);
    if (relative !== null && isImageFile(relative)) {
      images.push(relative);
    }
  }
  return sortImagePaths(images);
}

function dirPage(comicPath: string, imagePath: string, index: number): ChapterPage {
  return {
    id: String(index + 1),
    name: baseName(imagePath),
    path: imagePath,
    url: encodePageUrl(comicPath, index),
    extern: {
      kind: "dir",
      path: comicPath,
      imagePath,
      index
    }
  };
}

function zipPage(comicPath: string, entry: ZipEntry, index: number): ChapterPage {
  return {
    id: String(index + 1),
    name: entry.name,
    path: entry.name,
    url: encodePageUrl(comicPath, index),
    extern: {
      kind: "cbz",
      path: comicPath,
      entry: entry.name,
      index
    }
  };
}

async function loadZipBytes(client: WebDavClient, path: string): Promise<Uint8Array> {
  const key = zipCacheKey(client, path);
  const hit = zipCache.findIndex((entry) => entry.key === key);
  if (hit >= 0) {
    const cached = zipCache.splice(hit, 1)[0];
    zipCache.unshift(cached);
    return cached.bytes;
  }

  const pending = inflightZip.get(key);
  if (pending !== undefined) {
    return pending;
  }

  const task = downloadFileBytes(client.urlFor(path), {
    headers: client.authHeaders(),
    request: client.options.request
  }).then(
    (result) => {
      zipCache.unshift({ key, path, bytes: result.bytes });
      trimZipCache();
      inflightZip.delete(key);
      return result.bytes;
    },
    (error) => {
      inflightZip.delete(key);
      throw error;
    }
  );
  inflightZip.set(key, task);
  return task;
}

/** 构造章节 + 页面。目录漫画列目录，CBZ 读中央目录。 */
export async function buildChapterWithPages(
  client: WebDavClient,
  comic: ComicRef
): Promise<ChapterWithPages> {
  const summary = buildChapterSummary(comic);
  if (comic.kind === "dir") {
    const images = await listDirImages(client, comic.path);
    if (images.length === 0) {
      throw new Error("这个目录里没有图片");
    }
    return {
      ...summary,
      pages: images.map((imagePath, index) => dirPage(comic.path, imagePath, index))
    };
  }

  const bytes = await loadZipBytes(client, comic.path);
  const images = listZipImages(readZipEntries(bytes));
  if (images.length === 0) {
    throw new Error("CBZ 里没有图片");
  }
  return {
    ...summary,
    pages: images.map((entry, index) => zipPage(comic.path, entry, index))
  };
}

/** 由 comicId / extern 解析漫画引用。 */
export function resolveComicRef(comicId: unknown, extern: unknown): ComicRef {
  const idText = asText(comicId);
  const decoded = decodeComicId(idText);
  if (decoded !== null) {
    return { kind: decoded.kind, path: normalizeDavPath(decoded.path) };
  }
  const map = asRecord(extern);
  const kind =
    map.kind === "cbz" ? "cbz" : map.kind === "dir" ? "dir" : null;
  const path = asText(map.path);
  if (kind !== null && path !== "") {
    return { kind, path: normalizeDavPath(path) };
  }
  // 完全没有 id 与「id 传了但解不开」是两种故障：后者说明宿主传的 id 已损坏，
  // 再报「缺少漫画 id」会把人引到错误方向。
  if (idText !== "") {
    throw new Error("漫画 id 格式无效（可能已损坏）");
  }
  throw new Error("缺少漫画 id，无法打开");
}

/** 取一页的原始字节（目录图直接 GET；CBZ 先取整包再解压目标条目）。 */
export async function fetchPageBytes(
  client: WebDavClient,
  extern: unknown,
  url?: string
): Promise<Uint8Array> {
  const map = asRecord(extern);
  const parsed = parsePageUrl(url ?? "");
  const rawComicPath = asText(map.path) || (parsed === null ? "" : parsed.path);
  if (rawComicPath === "") {
    throw new Error("图片地址无效");
  }
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawComicPath);
  const comicPath = isAbsolute ? rawComicPath : normalizeDavPath(rawComicPath);
  const declaredKind = asText(map.kind);
  const kind: ComicKind =
    declaredKind === "cbz" || declaredKind === "dir"
      ? declaredKind
      : /\.(cbz|zip)$/i.test(comicPath)
        ? "cbz"
        : "dir";
  const index = toIndex([map.index, parsed === null ? undefined : parsed.index], 0);

  if (kind === "dir") {
    let imagePath = asText(map.imagePath);
    if (imagePath !== "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(imagePath)) {
      imagePath = normalizeDavPath(imagePath);
    }
    if (imagePath === "") {
      const images = await listDirImages(client, comicPath);
      imagePath = images[index] ?? "";
    }
    if (imagePath === "") {
      throw new Error("找不到这张图片");
    }
    const response = await client.fetchBytes(imagePath);
    return response.bytes;
  }

  const bytes = await loadZipBytes(client, comicPath);
  const images = listZipImages(readZipEntries(bytes));
  const entryName = asText(map.entry);
  const entry =
    entryName === ""
      ? images[index]
      : images.find((candidate) => candidate.name === entryName);
  if (entry === undefined) {
    throw new Error("CBZ 里找不到这一页");
  }
  return extractZipEntry(bytes, entry);
}

function externOrNull(value: unknown): StringMap | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as StringMap)
    : null;
}

function externWithWarning(value: unknown, warning: string | null): StringMap | null {
  const extern = externOrNull(value);
  if (warning === null) {
    return extern;
  }
  return { ...(extern ?? {}), scanWarning: warning };
}

function warningFields(warning: string | null): StringMap {
  return warning === null ? {} : { scanWarning: warning };
}

function appendWarning(text: string, warning: string | null): string {
  return warning === null ? text : text + "\n\n注意：" + warning;
}

async function scanWithSettings(): Promise<{
  client: WebDavClient;
  settings: WebDavSettings;
}> {
  const settings = await loadSettings();
  return { client: clientForSettings(settings), settings };
}

/** 搜索结果（宿主搜索页 / openSearch 入口）。 */
export async function searchComic(
  payload: SearchComicPayload = {}
): Promise<SearchResultContract> {
  return withFriendlyErrors(async () => {
    const { client, settings } = await scanWithSettings();
    const scan = await listComicEntriesDetailed(client, settings);
    const comics = filterComics(scan.comics, payload.keyword ?? "");
    const slice = paginateComics(comics, Number(payload.page ?? 1), SEARCH_PAGE_SIZE);
    const paging = {
      page: slice.page,
      pages: slice.pages,
      total: slice.total,
      hasReachedMax: slice.hasReachedMax
    };
    const items = slice.items.map(buildListItem);
    return {
      source: PLUGIN_ID,
      extern: externWithWarning(payload.extern, scan.warning),
      scheme: {
        version: "1.0.0",
        type: "searchResult",
        source: PLUGIN_ID,
        list: "library"
      },
      data: { paging, items },
      paging,
      items
    };
  });
}

/** openComicList 入口用的分页列表。 */
export async function getComicList(
  payload: SearchComicPayload = {}
): Promise<ComicPagedListContract> {
  return withFriendlyErrors(async () => {
    const { client, settings } = await scanWithSettings();
    const scan = await listComicEntriesDetailed(client, settings);
    const comics = filterComics(scan.comics, payload.keyword ?? "");
    const slice = paginateComics(comics, Number(payload.page ?? 1), SEARCH_PAGE_SIZE);
    return {
      source: PLUGIN_ID,
      extern: externWithWarning(payload.extern, scan.warning),
      scheme: { version: "1.0.0", type: "comicPagedList" },
      data: {
        items: slice.items.map(buildListItem),
        hasReachedMax: slice.hasReachedMax
      }
    };
  });
}

/** 详情页。 */
export async function getComicDetail(
  payload: ComicDetailPayload = {}
): Promise<ComicDetailContract> {
  return withFriendlyErrors(async () => {
    const { client } = await scanWithSettings();
    const comic = resolveComicRef(payload.comicId, payload.extern);
    const title = comicTitle(comic.kind, comic.path);

    let cover: ImageItem;
    if (comic.kind === "dir") {
      const images = await listDirImages(client, comic.path);
      if (images.length === 0) {
        throw new Error("这个目录里没有图片");
      }
      cover = {
        id: "cover:" + encodeComicId(comic.kind, comic.path),
        url: encodePageUrl(comic.path, 0),
        name: baseName(images[0]),
        path: images[0],
        extern: { kind: "dir", path: comic.path, imagePath: images[0], index: 0 }
      };
    } else {
      cover = makeCover({ kind: comic.kind, path: comic.path, name: title });
    }

    const chapter = buildChapterSummary(comic);
    const normal: ComicDetailNormal = {
      comicInfo: {
        id: encodeComicId(comic.kind, comic.path),
        title,
        titleMeta: [
          {
            name: comic.path,
            onTap: null,
            onLongPress: comic.path,
            extern: {}
          }
        ],
        creator: {
          id: "",
          name: "",
          avatar: { id: "", url: "", name: "", path: "", extern: {} },
          onTap: null,
          extern: {}
        },
        description: appendWarning(
          comic.kind === "cbz" ? "WebDAV 上的 CBZ 整包。" : "WebDAV 上的图片文件夹。",
          lastScanWarning
        ),
        cover,
        metadata: [
          {
            type: "path",
            name: "路径",
            value: [{ name: comic.path, onTap: null, onLongPress: comic.path, extern: {} }]
          }
        ],
        extern: { kind: comic.kind, path: comic.path, ...warningFields(lastScanWarning) }
      },
      eps: [chapter],
      recommend: [],
      totalViews: 0,
      totalLikes: 0,
      totalComments: 0,
      isFavourite: false,
      isLiked: false,
      allowComments: false,
      allowLike: false,
      allowCollected: false,
      allowDownload: true,
      extern: { ...warningFields(lastScanWarning) }
    };

    return {
      source: PLUGIN_ID,
      comicId: asText(payload.comicId) || encodeComicId(comic.kind, comic.path),
      extern: externWithWarning(payload.extern, lastScanWarning),
      scheme: { version: "1.0.0", type: "comicDetail", source: PLUGIN_ID },
      data: {
        normal,
        raw: { kind: comic.kind, path: comic.path }
      }
    };
  });
}

/** 阅读器第一屏：当前章节 + 页面。 */
export async function getReadSnapshot(
  payload: ReadSnapshotPayload = {}
): Promise<ReadSnapshotContract> {
  return withFriendlyErrors(async () => {
    const { client } = await scanWithSettings();
    const comic = resolveComicRef(
      asText(payload.comicId) || payload.chapterId,
      payload.extern
    );
    const chapter = await buildChapterWithPages(client, comic);
    const title = comicTitle(comic.kind, comic.path);
    return {
      source: PLUGIN_ID,
      extern: externWithWarning(payload.extern, lastScanWarning),
      data: {
        comic: {
          id: encodeComicId(comic.kind, comic.path),
          source: PLUGIN_ID,
          title,
          extern: { kind: comic.kind, path: comic.path, ...warningFields(lastScanWarning) }
        },
        chapter,
        chapters: [
          { id: chapter.id, name: chapter.name, order: chapter.order, extern: chapter.extern }
        ]
      }
    };
  });
}

/** 下载场景：章节内容。 */
export async function getChapter(payload: ChapterPayload = {}): Promise<ChapterContentContract> {
  return withFriendlyErrors(async () => {
    const { client } = await scanWithSettings();
    const comic = resolveComicRef(
      asText(payload.comicId) || payload.chapterId,
      payload.extern
    );
    const chapter = await buildChapterWithPages(client, comic);
    const title = comicTitle(comic.kind, comic.path);
    return {
      source: PLUGIN_ID,
      comicId: asText(payload.comicId) || chapter.id,
      chapterId: chapter.id,
      extern: externWithWarning(payload.extern, lastScanWarning),
      scheme: { version: "1.0.0", type: "chapterContent", source: PLUGIN_ID },
      data: {
        comic: {
          id: encodeComicId(comic.kind, comic.path),
          source: PLUGIN_ID,
          title,
          extern: { kind: comic.kind, path: comic.path, ...warningFields(lastScanWarning) }
        },
        chapter,
        chapters: [chapter]
      }
    };
  });
}

/** 宿主取图：目录图带认证 GET；CBZ 分块下载整包后解压目标页。 */
export async function fetchImageBytes(
  payload: FetchImageBytesPayload = {}
): Promise<Uint8Array> {
  return withFriendlyErrors(async () => {
    const { client } = await scanWithSettings();
    return fetchPageBytes(client, payload.extern, payload.url);
  });
}

/** 测试辅助：按已有的 client 执行搜索，不读宿主设置。 */
export async function searchComicsWith(
  client: WebDavClient,
  settings: WebDavSettings,
  keyword: string,
  page: number
): Promise<PageSlice> {
  const comics = filterComics(await listComicEntries(client, settings), keyword);
  return paginateComics(comics, page, SEARCH_PAGE_SIZE);
}
