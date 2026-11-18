/**
 * 把底层错误翻译成用户能看懂的中文提示。
 * 宿主的错误页直接显示 Error.message，所以这里只改文案，不改控制流。
 */

export const USER_MESSAGES = {
  oldHost: "当前 Breeze 版本太旧，插件用不了",
  auth: "网盘用户名或密码不对",
  propfind: "这个网盘不支持列目录（PROPFIND），换一个 WebDAV 地址试试",
  timeout: "网盘太慢或文件太大，下载超时",
  unknown: "插件出错了，请稍后再试"
} as const;

/** 去掉 URL 里的 userinfo、查询串和片段，避免凭据进错误消息。 */
export function redactUrl(value: unknown): string {
  let text = String(value ?? "");
  text = text.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
  const cut = text.search(/[?#]/);
  if (cut >= 0) {
    text = text.slice(0, cut) + "…";
  }
  return text;
}

/** 按错误内容归类成人话。 */
export function friendlyMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  const text = raw.trim();
  if (text === "") {
    return USER_MESSAGES.unknown;
  }

  if (
    text.includes("__http_request_promise") ||
    text.includes("宿主网络桥") ||
    text.includes("当前环境没有")
  ) {
    return USER_MESSAGES.oldHost;
  }
  if (text.includes("认证失败") || text.includes("HTTP 401") || text.includes("HTTP 403")) {
    return USER_MESSAGES.auth;
  }
  if (/PROPFIND/i.test(text) && /405|501|不支持/.test(text)) {
    return USER_MESSAGES.propfind;
  }
  if (/timeout|timed out|time out|超时|aborted|abort/i.test(text)) {
    return USER_MESSAGES.timeout;
  }
  return text;
}

/** 生成带中文文案的错误；原文不变时不重复包装。 */
export function toFriendlyError(error: unknown): Error {
  const message = friendlyMessage(error);
  if (error instanceof Error && error.message === message) {
    return error;
  }
  return new Error(message);
}

/** 包住插件函数，统一把底层异常翻译成人话。 */
export async function withFriendlyErrors<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toFriendlyError(error);
  }
}

/** 当前环境是否有宿主网络桥。 */
export function hasHostRequest(): boolean {
  return typeof (globalThis as { __http_request_promise?: unknown }).__http_request_promise === "function";
}
