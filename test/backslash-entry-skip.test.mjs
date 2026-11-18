/**
 * P1 回归：一条含反斜杠的文件名不能弄挂整个漫画库。
 *
 * 背景：请求层必须拒绝反斜杠路径（服务器可能把它当目录分隔符），
 * 但列目录时服务器完全可能返回这种名字的普通文件（href 编码成 1%5C2.png）。
 * 以前的实现让 normalizeDavPath 在 relativePath 里抛异常，一次扫描直接失败。
 *
 * 现在的行为：扫描与目录列图都会跳过这类条目并计数，其它条目照常返回，
 * warning 里带中文提示（复用 scanWarning 通道）。
 */
import assert from "node:assert/strict";
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
import { hrefToRelativePath } from "../src/webdav/client.ts";
import { scanComicsDetailed } from "../src/webdav/scan.ts";

function davEntry(href, isCollection = false) {
  return { href, isCollection, contentLength: null, lastModified: null };
}

async function saveSettings(keys, baseUrl) {
  await authConfig.save(keys.baseUrl, baseUrl);
  await authConfig.save(keys.username, AUTH_USER);
  await authConfig.save(keys.password, AUTH_PASS);
  await authConfig.save(keys.rootPath, "/");
  await authConfig.save(keys.scanDepth, "2");
  await authConfig.save(keys.maxComics, "300");
  await authConfig.save(keys.includeCbz, "true");
}

test("backslash-entry-skip 扫描跳过含反斜杠的条目并计数，不抛异常", async () => {
  const entries = [
    davEntry("/dav/1%5C2.png"),
    davEntry("/dav/a.png"),
    davEntry("/dav/b%5Cc.png"),
    davEntry("/dav/%252e%252e/", true),
    davEntry("/dav/a%00b.png"),
    davEntry("/dav/%zz.png"),
    davEntry("/dav/sub/", true)
  ];
  const lister = {
    async list() {
      return entries;
    },
    relativePath(href) {
      return hrefToRelativePath(href, "http://nas.local/dav");
    }
  };

  const result = await scanComicsDetailed(lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true
  });

  assert.equal(
    result.skippedEntries,
    5,
    "反斜杠 2 条 + 双重编码 .. 1 条 + NUL 1 条 + 坏编码 1 条都要计数"
  );
  assert.match(result.warning ?? "", /含反斜杠/, "warning 要说明反斜杠条目被跳过");
  assert.match(result.warning ?? "", /可疑 \.\./, "warning 要说明可疑 .. 条目被跳过");
  assert.match(result.warning ?? "", /有 5 个条目/, "warning 要带跳过计数");
  assert.deepEqual(
    result.comics.map((comic) => comic.path),
    ["/"],
    "其它条目照常扫描出漫画"
  );
  assert.equal(result.comics[0].coverImagePath, "/a.png", "封面只能取安全条目");
});

test("backslash-entry-skip 服务器返回 1%5C2.png 时列表/详情照常，warning 可见", async () => {
  const server = await startWebDavServer({
    user: AUTH_USER,
    pass: AUTH_PASS,
    backslashEntry: true
  });
  try {
    installTestHost();
    const { SETTING_KEYS } = await import("../src/settings.ts");
    const comics = await import("../src/comics.ts");

    await saveSettings(SETTING_KEYS, "http://127.0.0.1:" + server.port + "/dav");
    comics.clearScanCache();

    const list = await comics.getComicList({ page: 1 });
    assert.ok(list.data.items.length > 0, "整库仍应返回其它漫画");
    assert.match(
      String(list.extern?.scanWarning ?? ""),
      /含反斜杠/,
      "列表 extern.scanWarning 要能看见跳过提示"
    );
    assert.match(String(list.extern?.scanWarning ?? ""), /有 1 个条目/, "skip 计数应为 1");
    assert.ok(
      !JSON.stringify(list.data.items).includes("\u005c"),
      "列表里不能出现反斜杠路径"
    );

    const rootItem = list.data.items.find((item) => item.extern?.path === "/");
    assert.ok(rootItem, "根目录漫画仍应列出");
    assert.ok(rootItem.cover.path !== "", "cover.path 不能为空");
    assert.ok(!rootItem.cover.path.includes("\u005c"), "封面不能是含反斜杠的脏条目");
    assert.notEqual(rootItem.cover.path, "/1\u005c2.png", "脏条目不能当封面");
    assert.ok(
      server.fixture.files.has(DAV_PREFIX + rootItem.cover.path),
      "封面必须指向 fixture 里真实存在的图"
    );

    // 详情 / 快照要列目录取页：目录里混着 1%5C2.png 也不能抛。
    const snapshot = await comics.getReadSnapshot({ comicId: rootItem.id, extern: {} });
    const pages = snapshot.data.chapter.pages;
    assert.equal(pages.length, 3, "根目录 3 张正常图都应为页，脏条目被跳过");
    assert.ok(
      pages.every((page) => !page.path.includes("\u005c")),
      "页面路径里不能出现反斜杠"
    );
    assert.match(
      String(snapshot.extern?.scanWarning ?? ""),
      /含反斜杠/,
      "快照 extern 也要带 scanWarning"
    );

    // 被跳过的图片不会被请求：没有任何请求路径带反斜杠。
    assert.ok(
      server.requests.every((request) => !request.path.includes("\u005c")),
      "不能对含反斜杠的路径发请求"
    );
  } finally {
    await server.close();
  }
});
