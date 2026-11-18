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
import { createWebDavClient } from "./webdav/client.ts";
import type { WebDavClient } from "./webdav/client.ts";
import { downloadFileBytes, MAX_DOWNLOAD_BYTES } from "./http/download.ts";
import {
  scanComicsDetailed,
  skippedEntriesWarning,
  sortImagePaths
} from "./webdav/scan.ts";
import type { ComicEntry, ScanResult } from "./webdav/scan.ts";
import { decodeComicId, encodeComicId, encodePageUrl, parsePageUrl } from "./webdav/ids.ts";
import type { ComicKind } from "./webdav/ids.ts";
import { extractZipEntry, listZipImages, readZipEntries } from "./zip/cbz.ts";
import type { ZipEntry } from "./zip/cbz.ts";
import {
  openRemoteZip,
  readRemoteZipEntry,
  RemoteZipRangeUnsupportedError
} from "./zip/remote-zip.ts";
import type { RemoteZipInfo, RemoteZipSource } from "./zip/remote-zip.ts";
import { hostRequest } from "./http/host.ts";
import type { DavEntry } from "./webdav/xml.ts";
import {
  baseName,
  comicTitle,
  isImageFile,
  tidyDavPath
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

/** 中央目录缓存上限：每个包几十 KB，只缓存小索引，不缓存整包。 */
const REMOTE_ZIP_CACHE_LIMIT = 16;
const REMOTE_ZIP_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;
const REMOTE_ZIP_DIAGNOSTIC_LIMIT = 20;

let remoteZipCacheBudget = REMOTE_ZIP_CACHE_BUDGET_BYTES;
let remoteZipDownloadLimit = MAX_DOWNLOAD_BYTES;

type CachedRemoteZip = {
  key: string;
  path: string;
  info: RemoteZipInfo;
  /** 估算的索引占用字节（只算条目名与结构，不算整包）。 */
  bytes: number;
};

const remoteZipCache: CachedRemoteZip[] = [];
const inflightRemoteZip = new Map<string, Promise<RemoteZipInfo>>();
/** 判定过「服务器不支持 Range」的包：之后的取页直接走整包，不再重复试错。 */
const remoteZipFallbackKeys = new Set<string>();
const remoteZipDiagnostics: string[] = [];
const remoteZipDiagnosticKeys = new Set<string>();

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
  clearRemoteZipCache();
}

/** 清空远程 CBZ 的中央目录缓存与「不支持 Range」判定（测试用）。 */
export function clearRemoteZipCache(): void {
  remoteZipCache.length = 0;
  inflightRemoteZip.clear();
  remoteZipFallbackKeys.clear();
}

/** 远程取页的回退诊断（回退过一次就有一条，按包去重）。 */
export function getRemoteZipDiagnostics(): string[] {
  return remoteZipDiagnostics.slice();
}

/** 清空远程取页诊断（测试用）。 */
export function clearRemoteZipDiagnostics(): void {
  remoteZipDiagnostics.length = 0;
  remoteZipDiagnosticKeys.clear();
}

/** 中央目录缓存当前估算字节数（测试用）。 */
export function remoteZipCacheBytes(): number {
  let total = 0;
  for (const entry of remoteZipCache) {
    total += entry.bytes;
  }
  return total;
}

/** 中央目录缓存里的包路径（测试用，最近使用的在前）。 */
export function remoteZipCacheKeys(): string[] {
  return remoteZipCache.map((entry) => entry.path);
}

/** 调整中央目录缓存预算（测试用）；传 null 恢复默认。 */
export function setRemoteZipCacheBudgetForTests(bytes: number | null): void {
  remoteZipCacheBudget =
    bytes === null ? REMOTE_ZIP_CACHE_BUDGET_BYTES : Math.max(1, Math.trunc(bytes));
  trimRemoteZipCache();
}

/** 调整远程取页的单响应体上限（测试用）；传 null 恢复默认 256 MiB。 */
export function setRemoteZipDownloadLimitForTests(bytes: number | null): void {
  remoteZipDownloadLimit =
    bytes === null ? MAX_DOWNLOAD_BYTES : Math.max(1, Math.trunc(bytes));
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

/** 路径字段不能 trim：尾随空格是合法名字的一部分。 */
function asPathText(value: unknown): string {
  if (typeof value === "string") {
    return value;
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
      relativePath: (href) => client.relativePath(href),
      canRequest: (input) => canClientRequest(client, input)
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

/** path 是否在 dir 之下（子项，不含 dir 自身）。 */
function isUnderDirectory(path: string, dir: string): boolean {
  return dir === "/" ? path.startsWith("/") : path.startsWith(dir + "/");
}

const UNSAFE_PATH_MESSAGE = "这一项的路径不安全，已跳过";

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/** 老测试桩里可能没有 canRequest：缺省视为可以，避免把能力判定变成硬依赖。 */
function canClientRequest(client: WebDavClient, path: string): boolean {
  return typeof client.canRequest === "function" ? client.canRequest(path) : true;
}

/** 打开某一本之前：路径发不出去就只让这一本失败，文案明确。 */
function assertRequestable(client: WebDavClient, path: string): void {
  if (!isAbsoluteUrl(path) && !canClientRequest(client, path)) {
    throw new Error(UNSAFE_PATH_MESSAGE);
  }
}

type DirImagesResult = {
  images: string[];
  /** 因路径不安全或单条读取失败而跳过的条目数。 */
  skipped: number;
  /** 整个目录列不出来（网络/权限/路径不安全）。 */
  listFailed: boolean;
};

async function listDirImagesDetailed(
  client: WebDavClient,
  comicPath: string
): Promise<DirImagesResult> {
  let entries: DavEntry[];
  try {
    entries = await client.list(comicPath, 1);
  } catch {
    // 这一本列不出来：只影响这一本，由上层给出「列目录失败」的明确文案。
    return { images: [], skipped: 1, listFailed: true };
  }
  const images: string[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (entry.isCollection) {
      continue;
    }
    let relative: string | null = null;
    try {
      relative = client.relativePath(entry.href);
    } catch {
      skipped += 1;
      continue;
    }
    if (relative === null || relative === "" || !isUnderDirectory(relative, comicPath)) {
      continue;
    }
    // 单条路径发不出去（字面 .. / 反斜杠 / 控制字符）：跳过并计数，不弄挂整本漫画。
    if (!canClientRequest(client, relative)) {
      skipped += 1;
      continue;
    }
    if (isImageFile(relative)) {
      images.push(relative);
    }
  }
  return { images: sortImagePaths(images), skipped, listFailed: false };
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

function remoteZipSource(client: WebDavClient, path: string): RemoteZipSource {
  return {
    url: client.urlFor(path),
    headers: client.authHeaders(),
    request: client.options.request ?? hostRequest,
    maxDownloadBytes: remoteZipDownloadLimit
  };
}

/** 条目名 + 结构的粗略占用，用来给中央目录缓存做字节预算。 */
function estimateRemoteZipBytes(info: RemoteZipInfo): number {
  let total = 64;
  for (const entry of info.entries) {
    total += 64 + entry.name.length * 2;
  }
  return total;
}

function trimRemoteZipCache(): void {
  let total = remoteZipCacheBytes();
  while (remoteZipCache.length > 1 && total > remoteZipCacheBudget) {
    const removed = remoteZipCache.pop();
    if (removed === undefined) {
      break;
    }
    total -= removed.bytes;
  }
}

/** 记一次回退诊断（同一个包 + 同一种原因只记一次），并标记该包以后直接走整包。 */
function rememberRemoteZipFallback(
  client: WebDavClient,
  path: string,
  kind: string,
  reason: string
): void {
  const key = zipCacheKey(client, path);
  remoteZipFallbackKeys.add(key);
  const dedupe = key + "|" + kind;
  if (remoteZipDiagnosticKeys.has(dedupe)) {
    return;
  }
  remoteZipDiagnosticKeys.add(dedupe);
  const text = "CBZ 远程取页不可用，已回退整包下载（" + path + "）：" + reason;
  remoteZipDiagnostics.push(text);
  if (remoteZipDiagnostics.length > REMOTE_ZIP_DIAGNOSTIC_LIMIT) {
    remoteZipDiagnostics.shift();
  }
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn("[webdav] " + text);
  }
}

/** 回退时如果服务器已经顺带返回了整包，直接塞进 LRU，避免再下载一次。 */
function seedZipCache(client: WebDavClient, path: string, bytes: Uint8Array): void {
  const key = zipCacheKey(client, path);
  const hit = zipCache.findIndex((entry) => entry.key === key);
  if (hit >= 0) {
    zipCache.splice(hit, 1);
  }
  zipCache.unshift({ key, path, bytes });
  trimZipCache();
}

/** 打开远程包的中央目录；不支持 Range 时返回 null（回退由调用方完成）。 */
async function tryOpenRemoteZip(
  client: WebDavClient,
  path: string
): Promise<RemoteZipInfo | null> {
  const key = zipCacheKey(client, path);
  if (remoteZipFallbackKeys.has(key)) {
    return null;
  }
  const hit = remoteZipCache.findIndex((entry) => entry.key === key);
  if (hit >= 0) {
    const cached = remoteZipCache.splice(hit, 1)[0];
    remoteZipCache.unshift(cached);
    return cached.info;
  }
  const pending = inflightRemoteZip.get(key);
  if (pending !== undefined) {
    try {
      return await pending;
    } catch (error) {
      if (error instanceof RemoteZipRangeUnsupportedError) {
        rememberRemoteZipFallback(client, path, error.kind, error.message);
        if (error.fullBytes !== null) {
          seedZipCache(client, path, error.fullBytes);
        }
        return null;
      }
      throw error;
    }
  }

  const task = openRemoteZip(remoteZipSource(client, path)).then(
    (info) => {
      remoteZipCache.unshift({
        key,
        path,
        info,
        bytes: estimateRemoteZipBytes(info)
      });
      while (remoteZipCache.length > REMOTE_ZIP_CACHE_LIMIT) {
        remoteZipCache.pop();
      }
      trimRemoteZipCache();
      inflightRemoteZip.delete(key);
      return info;
    },
    (error) => {
      inflightRemoteZip.delete(key);
      throw error;
    }
  );
  inflightRemoteZip.set(key, task);

  try {
    return await task;
  } catch (error) {
    if (error instanceof RemoteZipRangeUnsupportedError) {
      rememberRemoteZipFallback(client, path, error.kind, error.message);
      if (error.fullBytes !== null) {
        seedZipCache(client, path, error.fullBytes);
      }
      return null;
    }
    throw error;
  }
}

/** CBZ 的图片条目：优先读远程中央目录，服务器不支持 Range 时整包兜底。 */
async function loadZipImageEntries(
  client: WebDavClient,
  path: string
): Promise<ZipEntry[]> {
  const remote = await tryOpenRemoteZip(client, path);
  if (remote !== null) {
    return listZipImages(remote.entries);
  }
  const bytes = await loadZipBytes(client, path);
  return listZipImages(readZipEntries(bytes));
}

function pickZipEntry(
  images: ZipEntry[],
  entryName: string,
  index: number
): ZipEntry | undefined {
  return entryName === ""
    ? images[index]
    : images.find((candidate) => candidate.name === entryName);
}

/** 取 CBZ 的一页：远程只拉这一页；Range 不可用时回退整包解压。 */
async function fetchZipPageBytes(
  client: WebDavClient,
  path: string,
  entryName: string,
  index: number
): Promise<Uint8Array> {
  const remote = await tryOpenRemoteZip(client, path);
  if (remote !== null) {
    const entry = pickZipEntry(listZipImages(remote.entries), entryName, index);
    if (entry === undefined) {
      throw new Error("CBZ 里找不到这一页");
    }
    try {
      return await readRemoteZipEntry(remoteZipSource(client, path), remote.totalSize, entry);
    } catch (error) {
      if (!(error instanceof RemoteZipRangeUnsupportedError)) {
        throw error;
      }
      rememberRemoteZipFallback(client, path, error.kind, error.message);
      if (error.fullBytes !== null) {
        seedZipCache(client, path, error.fullBytes);
      }
    }
  }

  const bytes = await loadZipBytes(client, path);
  const entry = pickZipEntry(listZipImages(readZipEntries(bytes)), entryName, index);
  if (entry === undefined) {
    throw new Error("CBZ 里找不到这一页");
  }
  return extractZipEntry(bytes, entry);
}

type ChapterWithPagesResult = {
  chapter: ChapterWithPages;
  /** 列目录时被跳过的脏图片数（用于冷启动也能给出 warning）。 */
  skipped: number;
};

/** 构造章节 + 页面，并返回列目录时跳过的脏图片数。 */
export async function buildChapterWithPagesDetailed(
  client: WebDavClient,
  comic: ComicRef
): Promise<ChapterWithPagesResult> {
  assertRequestable(client, comic.path);
  const summary = buildChapterSummary(comic);
  if (comic.kind === "dir") {
    const listed = await listDirImagesDetailed(client, comic.path);
    if (listed.listFailed) {
      throw new Error("这个目录读不了（列目录失败），已跳过");
    }
    if (listed.images.length === 0) {
      throw new Error("这个目录里没有图片");
    }
    return {
      chapter: {
        ...summary,
        pages: listed.images.map((imagePath, index) => dirPage(comic.path, imagePath, index))
      },
      skipped: listed.skipped
    };
  }

  const images = await loadZipImageEntries(client, comic.path);
  if (images.length === 0) {
    throw new Error("CBZ 里没有图片");
  }
  return {
    chapter: {
      ...summary,
      pages: images.map((entry, index) => zipPage(comic.path, entry, index))
    },
    skipped: 0
  };
}

/** 构造章节 + 页面（兼容旧调用，只要章节）。 */
export async function buildChapterWithPages(
  client: WebDavClient,
  comic: ComicRef
): Promise<ChapterWithPages> {
  return (await buildChapterWithPagesDetailed(client, comic)).chapter;
}

/** 由 comicId / extern 解析漫画引用。 */
export function resolveComicRef(comicId: unknown, extern: unknown): ComicRef {
  const idText = asText(comicId);
  const decoded = decodeComicId(idText);
  if (decoded !== null) {
    // id 里存的是解码文本；危险形态留到发请求前由 assertRequestable 判定，
    // 这里只做字符串整理，避免「打开时」报成别的错误。
    return { kind: decoded.kind, path: tidyDavPath(decoded.path) };
  }
  const map = asRecord(extern);
  const kind =
    map.kind === "cbz" ? "cbz" : map.kind === "dir" ? "dir" : null;
  const path = asPathText(map.path);
  if (kind !== null && path !== "") {
    return { kind, path: tidyDavPath(path) };
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
  const rawComicPath = asPathText(map.path) || (parsed === null ? "" : parsed.path);
  if (rawComicPath === "") {
    throw new Error("图片地址无效");
  }
  const isAbsolute = isAbsoluteUrl(rawComicPath);
  const comicPath = isAbsolute ? rawComicPath : tidyDavPath(rawComicPath);
  assertRequestable(client, comicPath);
  const declaredKind = asText(map.kind);
  const kind: ComicKind =
    declaredKind === "cbz" || declaredKind === "dir"
      ? declaredKind
      : /\.(cbz|zip)$/i.test(comicPath)
        ? "cbz"
        : "dir";
  const index = toIndex([map.index, parsed === null ? undefined : parsed.index], 0);

  if (kind === "dir") {
    let imagePath = asPathText(map.imagePath);
    if (imagePath !== "" && !isAbsoluteUrl(imagePath)) {
      imagePath = tidyDavPath(imagePath);
    }
    if (imagePath === "") {
      const listed = await listDirImagesDetailed(client, comicPath);
      if (listed.listFailed) {
        // 区分「列目录失败」和「条目不存在」，别让用户以为图被删了。
        throw new Error("读取这个目录失败（列目录失败）");
      }
      imagePath = listed.images[index] ?? "";
    }
    if (imagePath === "") {
      throw new Error("找不到这张图片");
    }
    assertRequestable(client, imagePath);
    const response = await client.fetchBytes(imagePath);
    return response.bytes;
  }

  return fetchZipPageBytes(client, comicPath, asText(map.entry), index);
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
    assertRequestable(client, comic.path);
    const title = comicTitle(comic.kind, comic.path);

    let cover: ImageItem;
    let skippedImages = 0;
    if (comic.kind === "dir") {
      const listed = await listDirImagesDetailed(client, comic.path);
      skippedImages = listed.skipped;
      if (listed.listFailed) {
        throw new Error("这个目录读不了（列目录失败），已跳过");
      }
      const images = listed.images;
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

    // 冷启动直接进详情时没跑过扫描，lastScanWarning 是空的；
    // 用本次列目录的跳过计数补一条，保证 warning 看得到。
    const warning =
      lastScanWarning ??
      (skippedImages > 0 ? skippedEntriesWarning(skippedImages) : null);

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
          warning
        ),
        cover,
        metadata: [
          {
            type: "path",
            name: "路径",
            value: [{ name: comic.path, onTap: null, onLongPress: comic.path, extern: {} }]
          }
        ],
        extern: { kind: comic.kind, path: comic.path, ...warningFields(warning) }
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
      extern: { ...warningFields(warning) }
    };

    return {
      source: PLUGIN_ID,
      comicId: asText(payload.comicId) || encodeComicId(comic.kind, comic.path),
      extern: externWithWarning(payload.extern, warning),
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
    assertRequestable(client, comic.path);
    const { chapter, skipped } = await buildChapterWithPagesDetailed(client, comic);
    const warning = lastScanWarning ?? (skipped > 0 ? skippedEntriesWarning(skipped) : null);
    const title = comicTitle(comic.kind, comic.path);
    return {
      source: PLUGIN_ID,
      extern: externWithWarning(payload.extern, warning),
      data: {
        comic: {
          id: encodeComicId(comic.kind, comic.path),
          source: PLUGIN_ID,
          title,
          extern: { kind: comic.kind, path: comic.path, ...warningFields(warning) }
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
    assertRequestable(client, comic.path);
    const { chapter, skipped } = await buildChapterWithPagesDetailed(client, comic);
    const warning = lastScanWarning ?? (skipped > 0 ? skippedEntriesWarning(skipped) : null);
    const title = comicTitle(comic.kind, comic.path);
    return {
      source: PLUGIN_ID,
      comicId: asText(payload.comicId) || chapter.id,
      chapterId: chapter.id,
      extern: externWithWarning(payload.extern, warning),
      scheme: { version: "1.0.0", type: "chapterContent", source: PLUGIN_ID },
      data: {
        comic: {
          id: encodeComicId(comic.kind, comic.path),
          source: PLUGIN_ID,
          title,
          extern: { kind: comic.kind, path: comic.path, ...warningFields(warning) }
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
