/**
 * 插件入口：导出宿主调用的函数，同时暴露核心能力给测试。
 */

export { getInfo, getSettingsBundle } from "./plugin.ts";
export {
  NPM_NAME,
  PLUGIN_ID,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  buildPluginInfo
} from "./plugin-info.ts";
export { parseMultistatus, decodeXmlEntities } from "./webdav/xml.ts";
export type { DavEntry } from "./webdav/xml.ts";
export {
  PROPFIND_BODY,
  buildBasicAuthHeader,
  createWebDavClient,
  encodeBase64Utf8,
  encodePath,
  fetchFileBytes,
  hrefToRelativePath,
  listDirectory,
  normalizeBaseUrl,
  resolveUrl
} from "./webdav/client.ts";
export type { WebDavClient, WebDavClientOptions } from "./webdav/client.ts";
export { hostRequest } from "./http/host.ts";
export type { HostRequest, HttpRequestSpec, HttpResponseData } from "./http/host.ts";
export {
  DEFAULT_CHUNK_SIZE,
  downloadFileBytes,
  headContentLength
} from "./http/download.ts";
export type { DownloadOptions, DownloadResult } from "./http/download.ts";
export {
  DEFAULT_SETTINGS,
  SETTINGS_SECTIONS,
  SETTING_KEYS,
  buildSettingsBundle,
  loadSettings
} from "./settings.ts";
export type { WebDavSettings } from "./settings.ts";
export {
  encodeComicId,
  decodeComicId,
  encodePageUrl,
  encodePathId,
  decodePathId,
  parsePageUrl
} from "./webdav/ids.ts";
export type { ComicKind, ComicRef } from "./webdav/ids.ts";
export { scanComics, sortImagePaths } from "./webdav/scan.ts";
export type { ComicEntry, ComicLister, ScanOptions } from "./webdav/scan.ts";
export { extractZipEntry, listZipImages, readZipEntries } from "./zip/cbz.ts";
export type { ZipEntry } from "./zip/cbz.ts";
export {
  baseName,
  comicTitle,
  isCbzFile,
  isImageFile,
  naturalCompare,
  normalizeDavPath,
  stripArchiveExtension
} from "./util/names.ts";
export {
  USER_MESSAGES,
  friendlyMessage,
  toFriendlyError,
  withFriendlyErrors
} from "./errors.ts";
export {
  MAIN_CHAPTER_NAME,
  SEARCH_PAGE_SIZE,
  buildChapterWithPages,
  buildListItem,
  clearZipCache,
  clientForSettings,
  fetchImageBytes,
  fetchPageBytes,
  filterComics,
  getChapter,
  getComicDetail,
  getComicList,
  getReadSnapshot,
  listComicEntries,
  paginateComics,
  resolveComicRef,
  searchComic,
  searchComicsWith,
  zipCachePaths
} from "./comics.ts";
export type { PageSlice } from "./comics.ts";
export { default } from "./plugin.ts";
