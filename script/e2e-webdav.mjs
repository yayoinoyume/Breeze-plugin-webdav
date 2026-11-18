/**
 * 端到端测试：加载编译后的 .bundle.cjs，注入最小 Breeze 宿主 shim，
 * 对本地测试 WebDAV 服务器跑两条完整链路：目录漫画 + CBZ 漫画。
 *
 * 最后一行固定输出 E2E PASS dir=<sha8> cbz=<sha8> ...
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

async function saveSettings(mod, baseUrl) {
  const keys = mod.SETTING_KEYS;
  await authConfig.save(keys.baseUrl, baseUrl);
  await authConfig.save(keys.username, AUTH_USER);
  await authConfig.save(keys.password, AUTH_PASS);
  await authConfig.save(keys.rootPath, "/");
  await authConfig.save(keys.scanDepth, "2");
  await authConfig.save(keys.maxComics, "300");
  await authConfig.save(keys.includeCbz, "true");
}

async function fetchAndHash(mod, page) {
  const bytes = await mod.fetchImageBytes({ url: page.url, extern: page.extern });
  check(bytes instanceof Uint8Array, "fetchImageBytes 应返回 Uint8Array");
  return { bytes, hash: sha256(bytes) };
}

async function runDirChain(mod, server, searchItems) {
  const item = searchItems.find((entry) => entry.extern && entry.extern.kind === "dir");
  check(item !== undefined, "搜索结果里没有目录漫画");
  assertEqual(item.extern.path, "/", "目录漫画路径");

  const detail = await mod.getComicDetail({ comicId: item.id });
  assertEqual(detail.data.normal.comicInfo.title, "漫画库", "目录漫画标题");
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

async function runCbzChain(mod, server, searchItems) {
  const item = searchItems.find((entry) => entry.extern && entry.extern.kind === "cbz");
  check(item !== undefined, "搜索结果里没有 CBZ 漫画");
  assertEqual(item.extern.path, "/合集.cbz", "CBZ 路径");

  const detail = await mod.getComicDetail({ comicId: item.id });
  assertEqual(detail.data.normal.comicInfo.title, "合集", "CBZ 标题");
  assertEqual(detail.data.normal.comicInfo.cover.extern.kind, "cbz", "CBZ 封面类型");

  const snapshot = await mod.getReadSnapshot({ comicId: item.id, chapterId: item.id });
  assertEqual(snapshot.data.chapter.pages.length, 3, "CBZ 页数");

  const chapter = await mod.getChapter({ comicId: item.id, chapterId: item.id });
  assertEqual(chapter.data.chapter.pages.length, 3, "getChapter CBZ 页数");

  const expectedEntries = unzipSync(server.fixture.cbz);
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

async function main() {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS });
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
      "fetchImageBytes"
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
    assertEqual(rootEntries.length, 5, "根目录条目数");
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

    // 1. 插件链路：设置 → 搜索
    await saveSettings(mod, baseUrl);
    const search = await mod.searchComic({});
    check(search.items.length >= 2, "搜索结果至少应包含目录漫画与 CBZ");
    const titles = search.items.map((item) => item.title).join(",");
    console.error("[e2e] 搜索结果：" + titles);

    const dirSha = await runDirChain(mod, server, search.items);
    const cbzSha = await runCbzChain(mod, server, search.items);

    const listPage = await mod.getComicList({ page: 1 });
    check(listPage.data.items.length >= 2, "getComicList 列表为空");

    console.log(
      "E2E PASS dir=" +
        dirSha.slice(0, 8) +
        " cbz=" +
        cbzSha.slice(0, 8) +
        " dirPages=3 cbzPages=3 cbzBytes=" +
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
