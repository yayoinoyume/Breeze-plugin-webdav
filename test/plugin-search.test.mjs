import assert from "node:assert/strict";
import test from "node:test";
import { decodeComicId } from "../src/webdav/ids.ts";
import {
  buildListItem,
  clearScanCache,
  filterComics,
  paginateComics,
  searchComicsWith
} from "../src/comics.ts";
import { scanComics, scanComicsDetailed } from "../src/webdav/scan.ts";

function entry(href, isCollection = false, size = null) {
  return {
    href,
    isCollection,
    contentLength: size,
    lastModified: "Tue, 18 Nov 2026 10:00:00 GMT"
  };
}

const TREE = new Map([
  [
    "/",
    [
      entry("/dav/系列A/", true),
      entry("/dav/系列B/", true),
      entry("/dav/系列C/", true),
      entry("/dav/seriesX/", true),
      entry("/dav/整包.cbz", false, 123),
      entry("/dav/说明.txt", false, 10)
    ]
  ],
  ["/系列A", [entry("/dav/系列A/第1卷/", true)]],
  ["/系列A/第1卷", [entry("/dav/系列A/第1卷/2.png", false, 2), entry("/dav/系列A/第1卷/10.png", false, 10)]],
  ["/系列B", [entry("/dav/系列B/page10.png", false, 10), entry("/dav/系列B/page2.png", false, 2), entry("/dav/系列B/page1.png", false, 1)]],
  ["/系列C", [entry("/dav/系列C/cover.jpg", false, 4)]],
  ["/seriesX", [entry("/dav/seriesX/001.png", false, 1)]]
]);

function fakeLister() {
  return {
    async list(path) {
      return TREE.get(path) ?? [];
    },
    relativePath(href) {
      const path = decodeURIComponent(String(href).replace(/^\/dav/, "")).replace(/\/$/, "");
      return path === "" ? "/" : path;
    }
  };
}

const SETTINGS = {
  baseUrl: "http://nas.local/dav",
  username: "u",
  password: "p",
  rootPath: "/",
  scanDepth: 2,
  maxComics: 300,
  includeCbz: true
};

test("plugin-search 扫描：含图目录即漫画、不下钻；CBZ 单独成书", async () => {
  const comics = await scanComics(fakeLister(), {
    rootPath: "/",
    scanDepth: 2,
    maxComics: 300,
    includeCbz: true
  });

  const paths = comics.map((comic) => comic.path);
  assert.deepEqual(paths.sort(), ["/seriesX", "/系列A/第1卷", "/系列B", "/系列C", "/整包.cbz"].sort());
  const volume = comics.find((comic) => comic.path === "/系列A/第1卷");
  assert.equal(volume?.kind, "dir");
  assert.equal(volume?.name, "第1卷");
  assert.equal(volume?.coverImagePath, "/系列A/第1卷/2.png");
  const cbz = comics.find((comic) => comic.kind === "cbz");
  assert.equal(cbz?.name, "整包");
  assert.equal(cbz?.size, 123);
  assert.equal(comics.some((comic) => comic.path === "/系列A"), false);
});

test("plugin-search 关键词过滤大小写不敏感，CBZ 开关与扫描深度生效", async () => {
  const all = await scanComics(fakeLister(), { rootPath: "/", scanDepth: 2, includeCbz: true });
  assert.equal(filterComics(all, "SERIES").length, 1);
  assert.equal(filterComics(all, "第1").length, 1);
  assert.equal(filterComics(all, "   ").length, all.length);

  const noCbz = await scanComics(fakeLister(), { rootPath: "/", scanDepth: 2, includeCbz: false });
  assert.equal(noCbz.some((comic) => comic.kind === "cbz"), false);

  const shallow = await scanComics(fakeLister(), { rootPath: "/", scanDepth: 1, includeCbz: false });
  assert.equal(shallow.some((comic) => comic.path === "/系列A/第1卷"), false);
  assert.equal(shallow.length, 3);
});

test("plugin-search 数量上限与分页", async () => {
  const limited = await scanComics(fakeLister(), {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    maxComics: 2
  });
  assert.equal(limited.length, 2);

  const comics = await scanComics(fakeLister(), { rootPath: "/", scanDepth: 2, includeCbz: true });
  const page1 = paginateComics(comics, 1, 2);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, comics.length);
  assert.equal(page1.pages, Math.ceil(comics.length / 2));
  assert.equal(page1.hasReachedMax, page1.pages === 1);

  const page2 = paginateComics(comics, 2, 2);
  assert.equal(page2.page, 2);
  assert.equal(page2.hasReachedMax, page2.pages <= 2);

  const clamped = paginateComics(comics, 99, 2);
  assert.equal(clamped.page, clamped.pages);

  const client = {
    list: (input, depth) => fakeLister().list(input, depth),
    relativePath: (href) => fakeLister().relativePath(href)
  };
  const result = await searchComicsWith(client, SETTINGS, "系列", 1);
  assert.equal(result.total, 2);
  assert.equal(result.items.length, 2);
  const item = buildListItem(result.items[0]);
  const decoded = decodeComicId(item.id);
  assert.equal(decoded?.kind, "dir");
  assert.equal(item.cover.url.startsWith("wdav://"), true);
});


test("scan-budget 列目录请求达到上限时停止并给中文提示", async () => {
  const result = await scanComicsDetailed(fakeLister(), {
    rootPath: "/系列A",
    scanDepth: 3,
    includeCbz: true,
    maxListCalls: 1
  });

  assert.equal(result.listCalls, 1);
  assert.match(String(result.warning), /目录太多.*上限 1 次/);
  assert.equal(result.comics.length, 0, "只扫了第一层，尚未发现漫画");
});


test("scan-cache 翻页复用 45 秒内的扫描结果", async () => {
  let calls = 0;
  const lister = fakeLister();
  const client = {
    list: async (input, depth) => {
      calls += 1;
      return lister.list(input, depth);
    },
    relativePath: (href) => lister.relativePath(href)
  };
  const settings = { ...SETTINGS, baseUrl: "http://cache.local/dav" };

  clearScanCache();
  await searchComicsWith(client, settings, "", 1);
  const afterFirst = calls;
  assert.ok(afterFirst > 0);

  await searchComicsWith(client, settings, "", 2);
  assert.equal(calls, afterFirst, "第二页不应重新扫描");

  clearScanCache();
  await searchComicsWith(client, settings, "", 1);
  assert.ok(calls > afterFirst, "清缓存后应重新扫描");
});
