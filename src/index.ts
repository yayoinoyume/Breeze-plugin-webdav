/**
 * 插件入口：导出宿主调用的函数，同时暴露核心网络层给测试与后续业务使用。
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
export { default } from "./plugin.ts";
