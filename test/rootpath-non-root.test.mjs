import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import {
  clearScanCache,
  fetchImageBytes,
  getComicDetail,
  getReadSnapshot,
  searchComic
} from "../src/comics.ts";
import { SETTING_KEYS } from "../src/settings.ts";
import { AUTH_PASS, AUTH_USER, DAV_PREFIX, startWebDavServer } from "../script/test-webdav-server.mjs";
import { installTestHost } from "../script/test-host.mjs";

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function saveSettings(baseUrl, rootPath) {
  await authConfig.save(SETTING_KEYS.baseUrl, baseUrl);
  await authConfig.save(SETTING_KEYS.username, AUTH_USER);
  await authConfig.save(SETTING_KEYS.password, AUTH_PASS);
  await authConfig.save(SETTING_KEYS.rootPath, rootPath);
  await authConfig.save(SETTING_KEYS.scanDepth, "2");
  await authConfig.save(SETTING_KEYS.maxComics, "300");
  await authConfig.save(SETTING_KEYS.includeCbz, "true");
  clearScanCache();
}

test("rootPath-non-root /comics 下完整搜索→详情→快照→取图不重复拼路径", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS });
  try {
    installTestHost();
    await saveSettings("http://127.0.0.1:" + server.port + "/dav", "/comics");

    const search = await searchComic({});
    const item = search.items.find(
      (entry) => entry.extern && entry.extern.kind === "dir" && entry.extern.path === "/comics/目录漫画"
    );
    assert.ok(item, "搜索结果应包含 /comics/目录漫画");
    assert.equal(item.extern.path, "/comics/目录漫画");

    const detail = await getComicDetail({ comicId: item.id });
    assert.equal(detail.data.normal.comicInfo.title, "目录漫画");

    const snapshot = await getReadSnapshot({ comicId: item.id, chapterId: item.id });
    assert.deepEqual(
      snapshot.data.chapter.pages.map((page) => page.name),
      ["001.png", "2.png", "010.png"]
    );

    const page = snapshot.data.chapter.pages[0];
    const bytes = await fetchImageBytes({ url: page.url, extern: page.extern });
    const expected = server.fixture.files.get(DAV_PREFIX + page.path);
    assert.ok(expected, "fixture 应存在 " + page.path);
    assert.equal(sha256(bytes), sha256(expected));
  } finally {
    await server.close();
  }
});

test("percent-literal 文件名含字面 %20 的目录与文件能正常打开", async () => {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS });
  try {
    installTestHost();
    await saveSettings("http://127.0.0.1:" + server.port + "/dav", "/comics");

    const search = await searchComic({ keyword: "100" });
    const item = search.items.find(
      (entry) => entry.extern && entry.extern.path === "/comics/100%20"
    );
    assert.ok(item, "搜索结果应包含字面 %20 的目录");

    const snapshot = await getReadSnapshot({ comicId: item.id, chapterId: item.id });
    assert.equal(snapshot.data.chapter.pages.length, 1);
    const page = snapshot.data.chapter.pages[0];
    assert.equal(page.path, "/comics/100%20/a%20b.png");

    const bytes = await fetchImageBytes({ url: page.url, extern: page.extern });
    const expected = server.fixture.files.get(DAV_PREFIX + "/comics/100%20/a%20b.png");
    assert.ok(expected, "fixture 应存在字面 %20 的文件");
    assert.equal(sha256(bytes), sha256(expected));
  } finally {
    await server.close();
  }
});
