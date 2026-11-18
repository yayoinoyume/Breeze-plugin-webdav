/**
 * 名字里真有反斜杠的文件：列表层不判定、不中断；只有取这一页时才拒绝。
 * 目录漫画列图时会跳过它并计数（详情/快照仍可用，warning 如实提示）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { installTestHost } from "../script/test-host.mjs";
import {
  AUTH_PASS,
  AUTH_USER,
  DAV_PREFIX,
  startWebDavServer
} from "../script/test-webdav-server.mjs";

const BACKSLASH = String.fromCharCode(92);

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

test("backslash-entry-skip 含反斜杠的文件名不中断列表/详情/快照，只在取页时明确拒绝", async () => {
  const server = await startWebDavServer({
    user: AUTH_USER,
    pass: AUTH_PASS,
    backslashEntry: true
  });
  try {
    installTestHost();
    const { SETTING_KEYS } = await import("../src/settings.ts");
    const comics = await import("../src/comics.ts");
    await authConfig.save(SETTING_KEYS.baseUrl, "http://127.0.0.1:" + server.port + "/dav");
    await authConfig.save(SETTING_KEYS.username, AUTH_USER);
    await authConfig.save(SETTING_KEYS.password, AUTH_PASS);
    await authConfig.save(SETTING_KEYS.rootPath, "/");
    await authConfig.save(SETTING_KEYS.scanDepth, "2");
    await authConfig.save(SETTING_KEYS.maxComics, "300");
    await authConfig.save(SETTING_KEYS.includeCbz, "true");
    comics.clearScanCache();

    const list = await comics.getComicList({ page: 1 });
    const rootItem = list.data.items.find((item) => item.extern?.path === "/");
    assert.ok(rootItem, "根目录漫画仍应列出，列表不能因为一条脏名字中断");

    const detail = await comics.getComicDetail({ comicId: rootItem.id, extern: {} });
    assert.ok(
      !detail.data.normal.comicInfo.cover.path.includes(BACKSLASH),
      "详情封面不能取含反斜杠的图"
    );
    assert.match(
      String(detail.extern?.scanWarning ?? ""),
      /有 1 个条目无法安全读取/,
      "跳过的脏图片数要如实写进 warning"
    );

    const snapshot = await comics.getReadSnapshot({ comicId: rootItem.id, extern: {} });
    assert.equal(snapshot.data.chapter.pages.length, 3, "3 张正常图仍应为页");
    assert.ok(
      snapshot.data.chapter.pages.every((page) => !page.path.includes(BACKSLASH)),
      "页列表里不能出现反斜杠路径"
    );
    assert.match(
      String(snapshot.extern?.scanWarning ?? ""),
      /有 1 个条目无法安全读取/,
      "快照也要带 warning"
    );

    const firstPage = snapshot.data.chapter.pages[0];
    const expected = server.fixture.files.get(DAV_PREFIX + firstPage.path);
    assert.ok(expected instanceof Uint8Array, "fixture 应有正常页：" + firstPage.path);
    const bytes = await comics.fetchImageBytes({ url: firstPage.url, extern: firstPage.extern });
    assert.equal(sha256(bytes), sha256(expected), "正常页字节应与 fixture 一致");

    // 直接向脏页取图：只这一页失败，文案明确。
    await assert.rejects(
      () =>
        comics.fetchImageBytes({
          url: firstPage.url,
          extern: { kind: "dir", path: "/", imagePath: "/1" + BACKSLASH + "2.png", index: 0 }
        }),
      /这一项的路径不安全，已跳过/
    );

    assert.ok(
      server.requests.every((request) => !request.path.includes(BACKSLASH)),
      "不能对反斜杠路径发请求"
    );
  } finally {
    await server.close();
  }
});
