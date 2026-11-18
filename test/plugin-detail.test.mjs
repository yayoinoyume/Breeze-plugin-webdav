import assert from "node:assert/strict";
import test from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { getComicDetail } from "../src/comics.ts";
import { buildPluginInfo } from "../src/plugin-info.ts";
import { buildSettingsBundle } from "../src/settings.ts";
import { SETTING_KEYS } from "../src/settings.ts";
import { encodeComicId } from "../src/webdav/ids.ts";

function davXml(entries) {
  const items = entries
    .map(
      (item) =>
        "<D:response><D:href>" +
        item.href +
        "</D:href><D:propstat><D:prop><D:resourcetype>" +
        (item.collection ? "<D:collection/>" : "") +
        "</D:resourcetype><D:getcontentlength>" +
        (item.size ?? 0) +
        "</D:getcontentlength></D:prop></D:propstat></D:response>"
    )
    .join("");
  return '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' + items + "</D:multistatus>";
}

globalThis.__http_request_promise = async (method, url) => {
  if (method !== "PROPFIND") {
    return JSON.stringify({
      ok: true,
      status: 200,
      statusText: "OK",
      url,
      headers: {},
      body: "",
      offloaded: false
    });
  }
  const body = davXml([
    { href: "/dav/漫画/", collection: true },
    { href: "/dav/漫画/p1.png", size: 100 },
    { href: "/dav/漫画/p2.png", size: 100 }
  ]);
  return JSON.stringify({
    ok: true,
    status: 207,
    statusText: "Multi-Status",
    url,
    headers: { "content-type": "text/xml" },
    body,
    offloaded: false
  });
};

async function saveSettings() {
  await authConfig.save(SETTING_KEYS.baseUrl, "http://nas.local/dav");
  await authConfig.save(SETTING_KEYS.username, "demo");
  await authConfig.save(SETTING_KEYS.password, "demo");
  await authConfig.save(SETTING_KEYS.rootPath, "/");
}

test("plugin-detail 目录漫画：标题取目录名、单章、封面第一张图", async () => {
  await saveSettings();
  const comicId = encodeComicId("dir", "/漫画");
  const detail = await getComicDetail({ comicId });

  assert.equal(detail.source, detail.scheme.source);
  assert.equal(detail.comicId, comicId);
  assert.equal(detail.data.normal.comicInfo.title, "漫画");
  assert.equal(detail.data.normal.comicInfo.id, comicId);
  assert.equal(detail.data.normal.comicInfo.cover.path, "/漫画/p1.png");
  assert.equal(detail.data.normal.comicInfo.cover.url.startsWith("wdav://"), true);
  assert.equal(detail.data.normal.comicInfo.cover.extern.kind, "dir");
  assert.equal(detail.data.normal.comicInfo.creator?.name, "");
  assert.equal(detail.data.normal.comicInfo.creator?.avatar.url, "");
  assert.equal(detail.data.normal.allowDownload, true);
  assert.equal(detail.data.normal.eps.length, 1);

  const chapter = detail.data.normal.eps[0];
  assert.equal(chapter.id, comicId);
  assert.equal(chapter.requestId, comicId);
  assert.equal(chapter.logicalKey, comicId);
  assert.equal(chapter.storageChapterId, comicId);
  assert.equal(chapter.name, "全一话");
  assert.equal(chapter.order, 0);
  assert.equal(chapter.extern.kind, "dir");
  assert.equal(chapter.extern.path, "/漫画");
});

test("plugin-detail CBZ 漫画：标题去掉扩展名、封面指向整包第一页", async () => {
  await saveSettings();
  const comicId = encodeComicId("cbz", "/合集.cbz");
  const detail = await getComicDetail({ comicId });

  assert.equal(detail.data.normal.comicInfo.title, "合集");
  assert.equal(detail.data.normal.comicInfo.cover.extern.kind, "cbz");
  assert.equal(detail.data.normal.comicInfo.cover.extern.path, "/合集.cbz");
  assert.equal(detail.data.normal.comicInfo.cover.extern.index, 0);
  assert.equal(detail.data.raw.kind, "cbz");
});

test("plugin-detail 发现页入口与设置页可打开", async () => {
  const info = buildPluginInfo();
  const library = info.function.find((item) => item.id === "library");
  const search = info.function.find((item) => item.id === "search");
  assert.equal(library?.action.type, "openComicList");
  assert.equal(library?.action.payload.scene.body.request.fnPath, "getComicList");
  assert.equal(search?.action.type, "openSearch");

  await saveSettings();
  const settings = await buildSettingsBundle();
  assert.equal(settings.scheme.type, "settings");
  assert.ok(settings.scheme.sections.length >= 2);
  assert.equal(settings.data.values["webdav.baseUrl"], "http://nas.local/dav");
});
