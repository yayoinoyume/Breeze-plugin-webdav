/**
 * 插件设置：字段 schema + 读写。
 *
 * 宿主的设置页会按字段 key 自动持久化（pluginConfig），插件侧只需按同一个 key 读。
 */

import { authConfig } from "breeze-plugin-kit";
import type { SettingsBundleContract, SettingsSection } from "breeze-plugin-kit";
import { PLUGIN_ID } from "./plugin-info.ts";

export type WebDavSettings = {
  baseUrl: string;
  username: string;
  password: string;
  rootPath: string;
  scanDepth: number;
  maxComics: number;
  includeCbz: boolean;
};

export const SETTING_KEYS = {
  baseUrl: "webdav.baseUrl",
  username: "webdav.username",
  password: "webdav.password",
  rootPath: "webdav.rootPath",
  scanDepth: "webdav.scanDepth",
  maxComics: "webdav.maxComics",
  includeCbz: "webdav.includeCbz"
} as const;

export const DEFAULT_SETTINGS: WebDavSettings = {
  baseUrl: "",
  username: "",
  password: "",
  rootPath: "/",
  scanDepth: 2,
  maxComics: 300,
  includeCbz: true
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    title: "服务器",
    fields: [
      {
        key: SETTING_KEYS.baseUrl,
        kind: "text",
        label: "服务器地址（如 http://192.168.1.2:5005/dav）"
      },
      { key: SETTING_KEYS.username, kind: "text", label: "用户名" },
      { key: SETTING_KEYS.password, kind: "password", label: "密码" }
    ]
  },
  {
    title: "扫描",
    fields: [
      { key: SETTING_KEYS.rootPath, kind: "text", label: "漫画库根路径（默认 /）" },
      { key: SETTING_KEYS.scanDepth, kind: "text", label: "扫描深度（1-6，默认 2）" },
      { key: SETTING_KEYS.maxComics, kind: "text", label: "漫画数量上限（默认 300）" },
      { key: SETTING_KEYS.includeCbz, kind: "switch", label: "收录 CBZ 整包" }
    ]
  }
];

function toInt(raw: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function toBool(raw: string, fallback: boolean): boolean {
  const text = String(raw).trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes" || text === "on") {
    return true;
  }
  if (text === "false" || text === "0" || text === "no" || text === "off") {
    return false;
  }
  return fallback;
}

async function readSetting(key: string, fallback: string): Promise<string> {
  try {
    const value = await authConfig.load(key, fallback);
    return typeof value === "string" ? value : String(value ?? fallback);
  } catch {
    return fallback;
  }
}

/** 从宿主配置里读出完整设置，缺项用默认值补齐。 */
export async function loadSettings(): Promise<WebDavSettings> {
  const [baseUrl, username, password, rootPath, scanDepth, maxComics, includeCbz] =
    await Promise.all([
      readSetting(SETTING_KEYS.baseUrl, DEFAULT_SETTINGS.baseUrl),
      readSetting(SETTING_KEYS.username, DEFAULT_SETTINGS.username),
      readSetting(SETTING_KEYS.password, DEFAULT_SETTINGS.password),
      readSetting(SETTING_KEYS.rootPath, DEFAULT_SETTINGS.rootPath),
      readSetting(SETTING_KEYS.scanDepth, String(DEFAULT_SETTINGS.scanDepth)),
      readSetting(SETTING_KEYS.maxComics, String(DEFAULT_SETTINGS.maxComics)),
      readSetting(SETTING_KEYS.includeCbz, String(DEFAULT_SETTINGS.includeCbz))
    ]);

  return {
    baseUrl: baseUrl.trim(),
    username,
    password,
    rootPath: rootPath.trim() === "" ? DEFAULT_SETTINGS.rootPath : rootPath.trim(),
    scanDepth: toInt(scanDepth, DEFAULT_SETTINGS.scanDepth, 1, 6),
    maxComics: toInt(maxComics, DEFAULT_SETTINGS.maxComics, 1, 2000),
    includeCbz: toBool(includeCbz, DEFAULT_SETTINGS.includeCbz)
  };
}

/** 生成设置页 bundle。 */
export async function buildSettingsBundle(): Promise<SettingsBundleContract> {
  const settings = await loadSettings();
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: SETTINGS_SECTIONS
    },
    data: {
      canShowUserInfo: false,
      values: {
        [SETTING_KEYS.baseUrl]: settings.baseUrl,
        [SETTING_KEYS.username]: settings.username,
        [SETTING_KEYS.password]: settings.password,
        [SETTING_KEYS.rootPath]: settings.rootPath,
        [SETTING_KEYS.scanDepth]: String(settings.scanDepth),
        [SETTING_KEYS.maxComics]: String(settings.maxComics),
        [SETTING_KEYS.includeCbz]: settings.includeCbz
      }
    }
  };
}
