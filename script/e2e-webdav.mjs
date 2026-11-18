/**
 * 端到端测试：加载编译后的 .bundle.cjs，注入最小 Breeze 宿主 shim，
 * 对本地测试 WebDAV 服务器列目录、按页取图、分块下载 CBZ，逐字节比对 sha256。
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import { AUTH_PASS, AUTH_USER, startWebDavServer } from "./test-webdav-server.mjs";

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
        throw new Error(`native buffer 不存在：${id}`);
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}：期望 ${expected}，实际 ${actual}`);
  }
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

    const client = mod.createWebDavClient({
      baseUrl: `http://127.0.0.1:${server.port}/dav`,
      username: AUTH_USER,
      password: AUTH_PASS
    });

    // 1. 列根目录
    const rootEntries = await client.list("/", 1);
    assertEqual(rootEntries.length, 5, "根目录条目数");
    const rootCollections = rootEntries.filter((entry) => entry.isCollection);
    assertEqual(rootCollections.length, 1, "根目录子目录数");
    const cbzEntry = rootEntries.find((entry) => entry.href.endsWith(".cbz"));
    if (cbzEntry === undefined) {
      throw new Error("根目录没有找到 cbz");
    }
    assertEqual(
      cbzEntry.contentLength,
      server.fixture.cbz.length,
      "cbz 的 getcontentlength"
    );

    // 2. 列子目录
    const subEntries = await client.list("/子目录", 1);
    assertEqual(subEntries.length, 2, "子目录条目数");
    if (!subEntries.every((entry) => entry.isCollection === false)) {
      throw new Error("子目录里的条目应全部是文件");
    }

    // 3. 按 URL 取 3 张图，sha256 与 fixture 一致
    const pages = ["/第 01 页.png", "/page-02.png", "/page 03.png"];
    const pageHashes = [];
    for (const page of pages) {
      const response = await client.fetchBytes(page);
      const expected = server.fixture.files.get(`${"/dav"}${page}`);
      if (expected === undefined) {
        throw new Error(`fixture 没有 ${page}`);
      }
      assertEqual(response.bytes.length, expected.length, `${page} 字节长度`);
      assertEqual(sha256(response.bytes), sha256(expected), `${page} sha256`);
      pageHashes.push(sha256(response.bytes));
    }

    // 4. 分块下载 CBZ
    const cbzUrl = client.urlFor("/合集.cbz");
    const download = await mod.downloadFileBytes(cbzUrl, {
      headers: client.authHeaders(),
      chunkSize: 4 * 1024 * 1024
    });
    assertEqual(download.status, 206, "cbz 下载状态");
    assertEqual(download.usedRange, true, "cbz 是否使用 Range");
    assertEqual(download.bytes.length, server.fixture.cbz.length, "cbz 字节长度");
    assertEqual(sha256(download.bytes), sha256(server.fixture.cbz), "cbz sha256");

    const rangeRequests = server.requests.filter(
      (entry) => entry.method === "GET" && entry.range !== null
    );
    if (rangeRequests.length < 2) {
      throw new Error(`cbz 应分成多块下载，实际 Range 请求数 ${rangeRequests.length}`);
    }

    console.log(
      `E2E PASS page1=${pageHashes[0].slice(0, 8)} page2=${pageHashes[1].slice(0, 8)} ` +
        `page3=${pageHashes[2].slice(0, 8)} cbz=${sha256(download.bytes).slice(0, 8)} ` +
        `cbzBytes=${download.bytes.length} chunks=${download.chunkCount}`
    );
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
