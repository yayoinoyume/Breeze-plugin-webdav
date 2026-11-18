import type { InfoContract } from "breeze-plugin-kit";

/** npm 包名，必须与 package.json 的 name 一致。 */
export const NPM_NAME = "breeze-plugin-webdav";

/** 插件显示名。 */
export const PLUGIN_NAME = "WebDAV 漫画";

/** 插件 id：随机 uuid v4，建仓时生成后固定，不要修改。 */
export const PLUGIN_ID = "a7d0c1f4-5b2e-4c93-9d61-3f2b8e7a4c10";

export const PLUGIN_VERSION = "0.1.0";

export function buildPluginInfo(): InfoContract {
  return {
    name: PLUGIN_NAME,
    uuid: PLUGIN_ID,
    iconUrl: "",
    describe: "通过 WebDAV 读取 NAS / 网盘上的漫画：目录浏览、按页取图、整包下载 CBZ。",
    version: PLUGIN_VERSION,
    npmName: NPM_NAME,
    function: []
  };
}
