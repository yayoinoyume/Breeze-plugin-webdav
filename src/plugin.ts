import type { InfoContract, SettingsBundleContract } from "breeze-plugin-kit";
import { buildPluginInfo } from "./plugin-info.ts";
import { buildSettingsBundle } from "./settings.ts";

/** 插件元信息（宿主信息页 / manifest 共用）。 */
export function getInfo(): InfoContract {
  return buildPluginInfo();
}

/** 设置页 bundle。 */
export function getSettingsBundle(): Promise<SettingsBundleContract> {
  return buildSettingsBundle();
}

const plugin = {
  getInfo,
  getSettingsBundle
};

export default plugin;
