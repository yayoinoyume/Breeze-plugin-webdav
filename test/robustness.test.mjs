/**
 * 第六轮回归：
 * - 一条脏文件 href 不能把父目录变成幽灵漫画、也不能让子库静默消失；
 * - 根目录列不出来必须抛（不能变成空库）；深层目录 403 只跳过并计数；
 * - 路径层保留尾随空格；
 * - 列表封面必须指向可请求路径。
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

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function bootServer(options) {
  const server = await startWebDavServer({ user: AUTH_USER, pass: AUTH_PASS, ...options });
  installTestHost();
  const { SETTING_KEYS } = await import("../src/settings.ts");
  const comics = await import("../src/comics.ts");
  await authConfig.save(SETTING_KEYS.baseUrl, "http://127.0.0.1:" + server.port + "/dav");
  await authConfig.save(SETTING_KEYS.username, AUTH_USER);
  await authConfig.save(SETTING_KEYS.password, AUTH_PASS);
  await authConfig.save(SETTING_KEYS.rootPath, options.rootPath ?? "/comics");
  await authConfig.save(SETTING_KEYS.scanDepth, "2");
  await authConfig.save(SETTING_KEYS.maxComics, "300");
  await authConfig.save(SETTING_KEYS.includeCbz, "true");
  comics.clearScanCache();
  return { server, comics, keys: SETTING_KEYS };
}

test("ghost-comic-regression 一条脏图片 href 不能让父目录变幽灵漫画、不能吞掉子库", async () => {
  const { server, comics } = await bootServer({
    rootPath: "/comics",
    extraHrefs: [{ href: "/dav/comics/%2e%2e%2fcover.png", isCollection: false }]
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    const paths = list.data.items.map((item) => item.extern?.path).sort();
    assert.deepEqual(
      paths,
      ["/comics/100%20", "/comics/整包.cbz", "/comics/目录漫画"],
      "其它三本都要在，且不能多出幽灵 /comics"
    );
    assert.match(
      String(list.extern?.scanWarning ?? ""),
      /有 \d+ 个条目无法安全读取/,
      "脏文件跳过要计数"
    );
    assert.ok(
      server.requests.every((request) => !request.path.includes("..")),
      "不能对解码后含 .. 的路径发请求：" + server.requests.map((r) => r.path).join(" | ")
    );
  } finally {
    await server.close();
  }
});

test("root-not-found-fatal rootPath 不存在时抛明确错误，不返回空库", async () => {
  const { server, comics } = await bootServer({ rootPath: "/不存在的目录" });
  try {
    await assert.rejects(
      () => comics.getComicList({ page: 1 }),
      /WebDAV 请求失败（HTTP 404）/,
      "根目录 404 必须抛，不能伪装成空库"
    );
  } finally {
    await server.close();
  }
});

test("subdir-forbidden-skip 子目录 403 只跳过它并计数，整库照常", async () => {
  const { server, comics } = await bootServer({
    rootPath: "/comics",
    emptyDirs: ["禁区"],
    forbiddenPaths: ["/dav/comics/禁区"]
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.data.items.length, 3, "其余三本照常列出");
    assert.match(
      String(list.extern?.scanWarning ?? ""),
      /有 1 个条目无法安全读取/,
      "403 目录要计数"
    );
    assert.ok(
      !list.data.items.some((item) => String(item.extern?.path ?? "").includes("禁区")),
      "被 403 的目录不能出现在列表"
    );
    assert.ok(
      server.requests.some((request) => request.path === "/dav/comics/禁区"),
      "确认确实请求过 403 目录"
    );
  } finally {
    await server.close();
  }
});

test("trailing-space-name 文件名里的空格原样保留，能列能取、sha256 一致", async () => {
  const { server, comics } = await bootServer({
    rootPath: "/comics",
    trailingSpaceName: true
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    const item = list.data.items.find((entry) => entry.extern?.path === "/comics");
    assert.ok(item, "含 a .png 的 /comics 应成为漫画");

    const detail = await comics.getComicDetail({ comicId: item.id, extern: {} });
    assert.equal(detail.data.normal.comicInfo.cover.path, "/comics/a .png");

    const snapshot = await comics.getReadSnapshot({ comicId: item.id, extern: {} });
    const page = snapshot.data.chapter.pages.find((entry) => entry.path === "/comics/a .png");
    assert.ok(page, "尾随空格名字应作为页保留：" + snapshot.data.chapter.pages.map((p) => p.path).join(","));

    const expected = server.fixture.files.get(DAV_PREFIX + "/comics/a .png");
    assert.ok(expected instanceof Uint8Array, "fixture 应有 a .png");
    const bytes = await comics.fetchImageBytes({ url: page.url, extern: page.extern });
    assert.equal(sha256(bytes), sha256(expected), "字节应与 fixture 一致");
  } finally {
    await server.close();
  }
});

test("cover-requestable 列表封面永远指向可请求路径", async () => {
  const { server, comics } = await bootServer({
    rootPath: "/comics",
    percentNames: true,
    extraHrefs: [
      // 注入到目录漫画里的一条脏图片：绝不能当封面。
      { href: "/dav/comics/%E7%9B%AE%E5%BD%95%E6%BC%AB%E7%94%BB/%2e%2e%2fcover.png", isCollection: false }
    ]
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.ok(list.data.items.length >= 4, "正常漫画都应列出");
    const { loadSettings } = await import("../src/settings.ts");
    const client = comics.clientForSettings(await loadSettings());

    for (const item of list.data.items) {
      assert.equal(typeof item.cover, "object", "cover 应是对象：" + item.id);
      assert.ok(item.cover !== null && !Array.isArray(item.cover), "cover 不能是数组：" + item.id);
      assert.ok(item.cover.path !== "", "cover.path 不能为空：" + item.id);
      assert.equal(
        client.canRequest(item.cover.path),
        true,
        "封面必须可请求：" + item.cover.path
      );
    }

    const dirItem = list.data.items.find((entry) => entry.extern?.path === "/comics/目录漫画");
    assert.ok(dirItem, "目录漫画仍应列出");
    const expected = server.fixture.files.get(DAV_PREFIX + dirItem.cover.path);
    assert.ok(expected instanceof Uint8Array, "目录漫画封面应存在：" + dirItem.cover.path);
    const bytes = await comics.fetchImageBytes({ url: dirItem.cover.url, extern: {} });
    assert.equal(sha256(bytes), sha256(expected), "封面字节应与 fixture 一致");
  } finally {
    await server.close();
  }
});
