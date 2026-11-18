/**
 * 列目录脏条目回归：服务器返回的名字带反斜杠、可疑 ..、控制字符或坏编码时，
 * 列表/详情/快照都必须照常可用——只跳过条目并计数，绝不抛异常中断整次扫描。
 *
 * 判定规则见 src/webdav/client.ts 的 isUnsafeHref：解码两次后含反斜杠、含 .. 段、
 * 含 NUL/控制字符，或百分号编码解不开，都算 unsafe；请求层对同类内部路径仍会抛。
 */
import assert from "node:assert/strict";
import test from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { installTestHost } from "../script/test-host.mjs";
import {
  AUTH_PASS,
  AUTH_USER,
  startWebDavServer
} from "../script/test-webdav-server.mjs";

async function saveSettings(keys, baseUrl) {
  await authConfig.save(keys.baseUrl, baseUrl);
  await authConfig.save(keys.username, AUTH_USER);
  await authConfig.save(keys.password, AUTH_PASS);
  await authConfig.save(keys.rootPath, "/comics");
  await authConfig.save(keys.scanDepth, "2");
  await authConfig.save(keys.maxComics, "300");
  await authConfig.save(keys.includeCbz, "true");
}

async function bootServer(options) {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, ...options });
  installTestHost();
  const { SETTING_KEYS } = await import("../src/settings.ts");
  const comics = await import("../src/comics.ts");
  await saveSettings(SETTING_KEYS, "http://127.0.0.1:" + server.port + "/dav");
  comics.clearScanCache();
  return { server, comics };
}

function requestPaths(server) {
  return server.requests.map((request) => request.path);
}

test("dirty-dir-encoded-dots 目录名 %252e%252e（解码两次是 ..）只跳过不报错", async () => {
  const { server, comics } = await bootServer({ dirtyEntries: ["dots-dir"] });
  try {
    const list = await comics.getComicList({ page: 1 });
    const titles = list.data.items.map((item) => item.title);
    assert.ok(titles.includes("目录漫画"), "正常漫画仍要列出：" + titles.join(","));
    assert.ok(titles.includes("整包"), "CBZ 仍要列出：" + titles.join(","));
    assert.equal(list.data.items.length, 3, "脏目录不能进结果集");
    assert.match(String(list.extern?.scanWarning ?? ""), /有 1 个条目/, "skip 计数应为 1");
    assert.match(String(list.extern?.scanWarning ?? ""), /可疑 \.\./, "warning 要说明可疑 ..");
    assert.ok(
      !JSON.stringify(list.data.items).includes("%2e%2e"),
      "结果里不能出现 %2e%2e 路径"
    );
    assert.ok(
      requestPaths(server).every((path) => !path.includes("..") && !/%2e%2e/i.test(path)),
      "不能对可疑 .. 路径发请求：" + requestPaths(server).join(" | ")
    );
  } finally {
    await server.close();
  }
});

test("dirty-dir-backslash 目录名含反斜杠（href 是 %5C）只跳过不报错", async () => {
  const { server, comics } = await bootServer({ dirtyEntries: ["backslash-dir"] });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.data.items.length, 3, "脏目录不能进结果集");
    assert.match(String(list.extern?.scanWarning ?? ""), /有 1 个条目/, "skip 计数应为 1");
    assert.match(String(list.extern?.scanWarning ?? ""), /含反斜杠/, "warning 要说明反斜杠");
    assert.ok(
      requestPaths(server).every((path) => !path.includes("\u005c")),
      "不能对反斜杠路径发请求：" + requestPaths(server).join(" | ")
    );
  } finally {
    await server.close();
  }
});

test("literal-percent-backslash 真实文件名 a%5Cb.png 必须被跳过（列表/详情/快照都不出现）", async () => {
  const { server, comics } = await bootServer({ dirtyEntries: ["percent-file"] });
  try {
    const list = await comics.getComicList({ page: 1 });
    const dirItem = list.data.items.find((item) => item.title === "目录漫画");
    assert.ok(dirItem, "目录漫画仍应正常列出");
    assert.match(String(list.extern?.scanWarning ?? ""), /有 1 个条目/, "skip 计数应为 1");
    assert.ok(!dirItem.cover.path.includes("%5C"), "封面不能是字面 %5C 文件：" + dirItem.cover.path);
    assert.ok(!JSON.stringify(list.data.items).includes("%5C"), "列表里不能出现字面 %5C 路径");

    // 冷启动直接进详情：没有先跑列表扫描，warning 也要可见（P2-1）。
    comics.clearScanCache();
    const detail = await comics.getComicDetail({ comicId: dirItem.id, extern: {} });
    assert.match(
      String(detail.extern?.scanWarning ?? ""),
      /有 1 个条目/,
      "冷启动详情也要带 scanWarning"
    );
    assert.ok(!JSON.stringify(detail).includes("%5C"), "详情里不能出现字面 %5C 路径");

    // 冷启动直接进阅读器：快照同样要带 warning，页面里不能有脏文件。
    comics.clearScanCache();
    const snapshot = await comics.getReadSnapshot({ comicId: dirItem.id, extern: {} });
    const pages = snapshot.data.chapter.pages;
    assert.equal(pages.length, 3, "3 张正常图应为页，字面 %5C 文件被跳过");
    assert.ok(pages.every((page) => !page.path.includes("%5C")), "页面里不能出现字面 %5C 路径");
    assert.match(
      String(snapshot.extern?.scanWarning ?? ""),
      /有 1 个条目/,
      "冷启动快照也要带 scanWarning"
    );

    assert.ok(
      requestPaths(server).every((path) => !path.includes("%5C")),
      "不能对字面 %5C 路径发请求：" + requestPaths(server).join(" | ")
    );
  } finally {
    await server.close();
  }
});

test("outside-root-skip 根路径外的脏条目不计入 skipped、不触发 warning", async () => {
  const { server, comics } = await bootServer({
    extraHrefs: [
      { href: "/dav/..%5C..%5Csecret", isCollection: false },
      { href: "/dav/%252e%252e/", isCollection: true }
    ]
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.data.items.length, 3, "正常漫画不受影响");
    assert.equal(
      list.extern?.scanWarning ?? null,
      null,
      "根外条目不算跳过，不应出现 warning"
    );
    assert.ok(
      requestPaths(server).every(
        (path) => !path.includes("..") && !/%2e%2e/i.test(path) && !path.includes("\u005c")
      ),
      "不能对根外脏路径发请求：" + requestPaths(server).join(" | ")
    );
  } finally {
    await server.close();
  }
});
