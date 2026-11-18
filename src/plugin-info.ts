import type { InfoContract, PluginFunctionItem } from "breeze-plugin-kit";

/** npm 包名，必须与 package.json 的 name 一致。 */
export const NPM_NAME = "breeze-plugin-webdav";

/** 插件显示名。 */
export const PLUGIN_NAME = "WebDAV 漫画";

/** 插件 id：随机 uuid v4，建仓时生成后固定，不要修改。 */
export const PLUGIN_ID = "a7d0c1f4-5b2e-4c93-9d61-3f2b8e7a4c10";

export const PLUGIN_VERSION = "0.2.0";

function buildFunctionEntries(): PluginFunctionItem[] {
  return [
    {
      id: "library",
      title: "漫画库",
      action: {
        type: "openComicList",
        payload: {
          scene: {
            title: "漫画库",
            source: PLUGIN_ID,
            body: {
              type: "pluginPagedComicList",
              request: { fnPath: "getComicList", core: {}, extern: {} }
            }
          }
        }
      }
    },
    {
      id: "search",
      title: "搜索",
      action: {
        type: "openSearch",
        payload: { source: PLUGIN_ID, extern: {} }
      }
    }
  ];
}

export function buildPluginInfo(): InfoContract {
  return {
    name: PLUGIN_NAME,
    uuid: PLUGIN_ID,
    iconUrl: "",
    describe: "通过 WebDAV 读取 NAS / 网盘上的漫画：目录浏览、按页取图、CBZ 按需取页（不支持 Range 时回退整包）。",
    version: PLUGIN_VERSION,
    npmName: NPM_NAME,
    function: buildFunctionEntries()
  };
}
