/**
 * 端到端测试：加载编译后的 .bundle.cjs，注入最小 Breeze 宿主 shim，
 * 对本地测试 WebDAV 服务器跑两组完整链路：rootPath=/ 与 rootPath=/comics。
 *
 * 最后一行固定输出 E2E PASS，并分别带两组 dir=/cbz= 的 sha256 前 8 位。
 */

import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import { unzipSync } from "fflate";
import { AUTH_PASS, AUTH_USER, DAV_PREFIX, startWebDavServer } from "./test-webdav-server.mjs";

const require = createRequire(import.meta.url);
const BUNDLE_PATH = "../dist/breeze-plugin-webdav.bundle.cjs";

const nativePool = new Map();
let nextBufferId = 1;

function normalizeResponseHeaders(rawHeaders) {
  const headers = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

/** 最小宿主 shim：__http_request_promise + native + cache。 */
function installHostShim() {
  globalThis.native = {
    async put(input) {
      const id = nextBufferId;
      nextBufferId += 1;
      nativePool.set(id, input instanceof Uint8Array ? input : new Uint8Array(input));
      return id;
    },
    async take(id) {
      const bytes = nativePool.get(id);
      nativePool.delete(id);
      if (bytes === undefined) {
        throw new Error("native buffer 不存在：" + id);
      }
      return bytes;
    },
    async free(id) {
      nativePool.delete(id);
    }
  };

  globalThis.cache = {
    async get() {
      return null;
    },
    getSync() {
      return null;
    },
    async set() {
      return true;
    },
    setSync() {
      return true;
    },
    async setIfAbsent() {
      return true;
    },
    async delete() {
      return true;
    }
  };

  globalThis.__http_request_promise = (method, url, headersJson, body) => {
    const headers = JSON.parse(headersJson || "{}");
    const promise = new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const id = nextBufferId;
          nextBufferId += 1;
          nativePool.set(id, new Uint8Array(buffer));
          resolve(
            JSON.stringify({
              ok: true,
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              url,
              headers: normalizeResponseHeaders(res.headers),
              body: "",
              offloaded: true,
              nativeBufferId: id,
              offloadedBytes: buffer.length
            })
          );
        });
      });
      req.on("error", (error) => reject(error));
      if (body !== null && body !== undefined) {
        req.write(body);
      }
      req.end();
    });
    promise.__hostRequestId = 0;
    return promise;
  };
}

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + "：期望 " + expected + "，实际 " + actual);
  }
}

async function saveSettings(mod, baseUrl, rootPath) {
  const keys = mod.SETTING_KEYS;
  await authConfig.save(keys.baseUrl, baseUrl);
  await authConfig.save(keys.username, AUTH_USER);
  await authConfig.save(keys.password, AUTH_PASS);
  await authConfig.save(keys.rootPath, rootPath);
  await authConfig.save(keys.scanDepth, "2");
  await authConfig.save(keys.maxComics, "300");
  await authConfig.save(keys.includeCbz, "true");
  if (typeof mod.clearScanCache === "function") {
    mod.clearScanCache();
  }
}

async function fetchAndHash(mod, page) {
  const bytes = await mod.fetchImageBytes({ url: page.url, extern: page.extern });
  check(bytes instanceof Uint8Array, "fetchImageBytes 应返回 Uint8Array");
  return { bytes, hash: sha256(bytes) };
}

async function runDirChain(mod, server, searchItems, expectedPath) {
  const item = searchItems.find(
    (entry) => entry.extern && entry.extern.kind === "dir" && entry.extern.path === expectedPath
  );
  check(item !== undefined, "搜索结果里没有目录漫画：" + expectedPath);

  const detail = await mod.getComicDetail({ comicId: item.id });
  const expectedTitle = expectedPath === "/" ? "漫画库" : expectedPath.split("/").pop();
  assertEqual(detail.data.normal.comicInfo.title, expectedTitle, "目录漫画标题");
  assertEqual(detail.data.normal.eps.length, 1, "目录漫画章节数");

  const snapshot = await mod.getReadSnapshot({ comicId: item.id, chapterId: item.id });
  assertEqual(snapshot.data.chapter.pages.length, 3, "目录漫画页数");
  assertEqual(snapshot.data.chapter.id, item.id, "目录章节 id");

  const chapter = await mod.getChapter({ comicId: item.id, chapterId: item.id });
  assertEqual(chapter.data.chapter.pages.length, 3, "getChapter 目录页数");
  assertEqual(chapter.scheme.type, "chapterContent", "getChapter scheme");

  const hashes = [];
  for (const page of snapshot.data.chapter.pages) {
    const expected = server.fixture.files.get(DAV_PREFIX + page.path);
    check(expected !== undefined, "fixture 缺少目录页：" + page.path);
    const fetched = await fetchAndHash(mod, page);
    assertEqual(fetched.bytes.length, expected.length, page.path + " 字节长度");
    assertEqual(fetched.hash, sha256(expected), page.path + " sha256");
    hashes.push(fetched.hash);
  }

  const cover = await fetchAndHash(mod, detail.data.normal.comicInfo.cover);
  assertEqual(cover.hash, hashes[0], "目录封面应等于第一页");
  return hashes[0];
}

async function runCbzChain(mod, server, searchItems, expectedPath, zipBytes) {
  const item = searchItems.find(
    (entry) => entry.extern && entry.extern.kind === "cbz" && entry.extern.path === expectedPath
  );
  check(item !== undefined, "搜索结果里没有 CBZ 漫画：" + expectedPath);

  const detail = await mod.getComicDetail({ comicId: item.id });
  assertEqual(
    detail.data.normal.comicInfo.title,
    expectedPath.split("/").pop().replace(/\.(cbz|zip)$/i, ""),
    "CBZ 标题"
  );
  assertEqual(detail.data.normal.comicInfo.cover.extern.kind, "cbz", "CBZ 封面类型");

  const snapshot = await mod.getReadSnapshot({ comicId: item.id, chapterId: item.id });
  assertEqual(snapshot.data.chapter.pages.length, 3, "CBZ 页数");

  const chapter = await mod.getChapter({ comicId: item.id, chapterId: item.id });
  assertEqual(chapter.data.chapter.pages.length, 3, "getChapter CBZ 页数");

  const expectedEntries = unzipSync(zipBytes);
  const hashes = [];
  for (const page of snapshot.data.chapter.pages) {
    const expected = expectedEntries[page.path];
    check(expected !== undefined, "CBZ fixture 缺少页：" + page.path);
    const fetched = await fetchAndHash(mod, page);
    assertEqual(fetched.bytes.length, expected.length, page.path + " 字节长度");
    assertEqual(fetched.hash, sha256(expected), page.path + " sha256");
    hashes.push(fetched.hash);
  }

  const cover = await fetchAndHash(mod, detail.data.normal.comicInfo.cover);
  assertEqual(cover.hash, hashes[0], "CBZ 封面应等于第一页");
  return hashes[0];
}

async function runGroup(mod, server, baseUrl, rootPath, expectedDirPath, expectedCbzPath, zipBytes) {
  await saveSettings(mod, baseUrl, rootPath);
  const search = await mod.searchComic({});
  check(search.items.length >= 2, "搜索结果至少应包含目录漫画与 CBZ");
  const titles = search.items.map((item) => item.title).join(",");
  console.error("[e2e] " + rootPath + " 搜索结果：" + titles);

  const dirSha = await runDirChain(mod, server, search.items, expectedDirPath);
  const cbzSha = await runCbzChain(mod, server, search.items, expectedCbzPath, zipBytes);

  const listPage = await mod.getComicList({ page: 1 });
  check(listPage.data.items.length >= 2, "getComicList 列表为空");
  console.error(
    "[e2e] " + rootPath + " dir=" + dirSha.slice(0, 8) + " cbz=" + cbzSha.slice(0, 8)
  );
  return { dirSha, cbzSha };
}

async function main() {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, bigCbz: true });
  try {
    installHostShim();

    const bundle = require(BUNDLE_PATH);
    const mod = typeof bundle.createWebDavClient === "function" ? bundle : bundle.default;
    if (typeof mod?.createWebDavClient !== "function") {
      throw new Error("bundle 没有导出 createWebDavClient");
    }
    for (const name of [
      "searchComic",
      "getComicList",
      "getComicDetail",
      "getReadSnapshot",
      "getChapter",
      "fetchImageBytes",
      "clearScanCache"
    ]) {
      if (typeof mod[name] !== "function") {
        throw new Error("bundle 没有导出 " + name);
      }
    }

    const baseUrl = "http://127.0.0.1:" + server.port + "/dav";

    // 0. 低层能力回归：列目录 / 直取图片 / 分块下载 CBZ
    const client = mod.createWebDavClient({
      baseUrl,
      username: AUTH_USER,
      password: AUTH_PASS
    });
    const rootEntries = await client.list("/", 1);
    assertEqual(rootEntries.length, 7, "根目录条目数");
    const cbzEntry = rootEntries.find((entry) => entry.href.endsWith(".cbz"));
    check(cbzEntry !== undefined, "根目录没有找到 cbz");
    assertEqual(cbzEntry.contentLength, server.fixture.cbz.length, "cbz 的 getcontentlength");

    const subEntries = await client.list("/子目录", 1);
    assertEqual(subEntries.length, 2, "子目录条目数");

    const download = await mod.downloadFileBytes(client.urlFor("/合集.cbz"), {
      headers: client.authHeaders(),
      chunkSize: 4 * 1024 * 1024
    });
    assertEqual(download.status, 206, "cbz 下载状态");
    assertEqual(download.usedRange, true, "cbz 是否使用 Range");
    assertEqual(sha256(download.bytes), sha256(server.fixture.cbz), "cbz 整包 sha256");

    // 1. rootPath=/ 的完整链路
    const rootGroup = await runGroup(
      mod,
      server,
      baseUrl,
      "/",
      "/",
      "/合集.cbz",
      server.fixture.cbz
    );

    // 2. rootPath=/comics 的完整链路（验证不会再拼一次 rootPath）
    const comicsGroup = await runGroup(
      mod,
      server,
      baseUrl,
      "/comics",
      "/comics/目录漫画",
      "/comics/整包.cbz",
      server.fixture.comicsCbz
    );

    // 3. CBZ 首屏字节：50 MiB+ 的包只拉第一页，不整包下载。
    await saveSettings(mod, baseUrl, "/");
    const bigSearch = await mod.searchComic({});
    const bigItem = bigSearch.items.find((item) => item.extern && item.extern.path === "/大包.cbz");
    check(bigItem !== undefined, "搜索结果里没有 /大包.cbz");
    const mark = server.requests.length;
    const bigSnapshot = await mod.getReadSnapshot({ comicId: bigItem.id, chapterId: bigItem.id });
    check(bigSnapshot.data.chapter.pages.length >= 100, "大包应有至少 100 页");
    const bigFirst = bigSnapshot.data.chapter.pages[0];
    const firstPageBytes = await mod.fetchImageBytes({ url: bigFirst.url, extern: bigFirst.extern });
    check(firstPageBytes instanceof Uint8Array && firstPageBytes.length > 0, "大包第一页应有字节");
    const singlePageBytes = server.requests
      .slice(mark)
      .reduce((sum, record) => sum + record.responseBytes, 0);
    const packageBytes = server.fixture.bigCbz.length;
    const singleRatio = singlePageBytes / packageBytes;
    check(
      singleRatio < 0.015,
      "CBZ 单页首屏应小于包大小 1.5%，实际 " + singlePageBytes + " / " + packageBytes
    );

    for (let index = 1; index < 3; index += 1) {
      const page = bigSnapshot.data.chapter.pages[index];
      await mod.fetchImageBytes({ url: page.url, extern: page.extern });
    }
    const threePageBytes = server.requests
      .slice(mark)
      .reduce((sum, record) => sum + record.responseBytes, 0);
    const threeRatio = threePageBytes / packageBytes;

    for (let index = 3; index < 5; index += 1) {
      const page = bigSnapshot.data.chapter.pages[index];
      await mod.fetchImageBytes({ url: page.url, extern: page.extern });
    }
    const fivePageBytes = server.requests
      .slice(mark)
      .reduce((sum, record) => sum + record.responseBytes, 0);
    const fiveRatio = fivePageBytes / packageBytes;
    check(
      fiveRatio < 0.06,
      "CBZ 5 页合计应小于包大小 6%，实际 " + fivePageBytes + " / " + packageBytes
    );
    console.error(
      "[e2e] CBZ 下载字节 packageBytes=" +
        packageBytes +
        " singlePage=" +
        singlePageBytes +
        " (" +
        (singleRatio * 100).toFixed(2) +
        "%) threePages=" +
        threePageBytes +
        " (" +
        (threeRatio * 100).toFixed(2) +
        "%) fivePages=" +
        fivePageBytes +
        " (" +
        (fiveRatio * 100).toFixed(2) +
        "%)"
    );

    console.log(
      "E2E PASS rootPath=/ dir=" +
        rootGroup.dirSha.slice(0, 8) +
        " cbz=" +
        rootGroup.cbzSha.slice(0, 8) +
        " rootPath=/comics dir=" +
        comicsGroup.dirSha.slice(0, 8) +
        " cbz=" +
        comicsGroup.cbzSha.slice(0, 8) +
        " cbzBytes=" +
        download.bytes.length +
        " chunks=" +
        download.chunkCount
    );
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
