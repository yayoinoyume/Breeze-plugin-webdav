/**
 * 列表层零校验：名字再怪也不能中断列表/扫描；只有真实危险路径（解码文本里含
 * 字面反斜杠 / .. 段 / 控制字符）才会在发请求时被拒绝，且只影响那一条。
 *
 * 这里用真 WebDAV 测试服务器覆盖：
 * - 合法但含 % 的目录名（%2e%2e 作为字面名字）能正常成书、打开、取图；
 * - 名字里真有反斜杠的目录：扫描跳过它并计数，其它书照常，直接打开报明确错误；
 * - 字面 %5C 的文件名是合法名字，要能当页取到字节；
 * - rootPath 外的条目静默忽略，不影响列表、不算跳过。
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
import { encodeComicId } from "../src/webdav/ids.ts";

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

test("dirty-dir-encoded-dots 字面目录名 %2e%2e（href %252e%252e）是合法名字，能正常打开", async () => {
  const { server, comics } = await bootServer({ dirtyEntries: ["dots-dir"] });
  try {
    const list = await comics.getComicList({ page: 1 });
    const item = list.data.items.find((entry) => entry.extern?.path === "/comics/%2e%2e");
    assert.ok(item, "合法 %2e%2e 目录应正常出现在列表：" + JSON.stringify(list.data.items.map((x) => x.extern?.path)));
    assert.equal(item.title, "%2e%2e");
    assert.equal(list.extern?.scanWarning ?? null, null, "合法名字不应触发 warning");

    const detail = await comics.getComicDetail({ comicId: item.id, extern: {} });
    assert.equal(detail.data.normal.comicInfo.cover.path, "/comics/%2e%2e/001.png");
    const expected = server.fixture.files.get(DAV_PREFIX + detail.data.normal.comicInfo.cover.path);
    assert.ok(expected instanceof Uint8Array, "fixture 应有封面图");
    const bytes = await comics.fetchImageBytes({
      url: detail.data.normal.comicInfo.cover.url,
      extern: {}
    });
    assert.equal(sha256(bytes), sha256(expected), "封面字节应与 fixture 一致");

    const snapshot = await comics.getReadSnapshot({ comicId: item.id, extern: {} });
    assert.equal(snapshot.data.chapter.pages.length, 1);
    const pageBytes = await comics.fetchImageBytes({
      url: snapshot.data.chapter.pages[0].url,
      extern: snapshot.data.chapter.pages[0].extern
    });
    assert.equal(sha256(pageBytes), sha256(expected), "页面字节应与 fixture 一致");

    assert.ok(
      server.requests.every((request) => !request.path.includes("..")),
      "不能对解码后含 .. 的路径发请求：" + server.requests.map((r) => r.path).join(" | ")
    );
  } finally {
    await server.close();
  }
});

test("dirty-dir-backslash 名字里真有反斜杠的目录：扫描跳过并计数，直接打开报明确错误", async () => {
  const { server, comics } = await bootServer({ dirtyEntries: ["backslash-dir"] });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.data.items.length, 3, "其它三本照常列出，脏目录被跳过");
    assert.ok(
      !list.data.items.some((item) => String(item.extern?.path ?? "").includes("\\")),
      "列表里不能出现反斜杠路径"
    );
    assert.match(
      String(list.extern?.scanWarning ?? ""),
      /有 1 个条目无法安全读取/,
      "跳过计数应为 1，文案要如实"
    );
    assert.ok(
      server.requests.every((request) => !request.path.includes("\\")),
      "不能对反斜杠路径发请求：" + server.requests.map((r) => r.path).join(" | ")
    );

    // 直接打开（模拟宿主拿着旧 id）：只让这一本失败，文案明确。
    const dirtyId = encodeComicId("dir", "/comics/\\");
    await assert.rejects(
      () => comics.getComicDetail({ comicId: dirtyId, extern: {} }),
      /这一项的路径不安全，已跳过/
    );
  } finally {
    await server.close();
  }
});

test("literal-percent-backslash 字面 %5C 文件名是合法名字，能当页取到字节", async () => {
  const { server, comics } = await bootServer({ dirtyEntries: ["percent-file"] });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.extern?.scanWarning ?? null, null, "合法 %5C 名字不应触发 warning");
    const item = list.data.items.find((entry) => entry.extern?.path === "/comics/目录漫画");
    assert.ok(item, "目录漫画仍应正常列出");

    const snapshot = await comics.getReadSnapshot({ comicId: item.id, extern: {} });
    const page = snapshot.data.chapter.pages.find(
      (entry) => entry.path === "/comics/目录漫画/a%5Cb.png"
    );
    assert.ok(page, "字面 %5C 文件应出现在页列表：" + snapshot.data.chapter.pages.map((p) => p.path).join(","));
    const expected = server.fixture.files.get(DAV_PREFIX + "/comics/目录漫画/a%5Cb.png");
    assert.ok(expected instanceof Uint8Array, "fixture 应有 a%5Cb.png");
    const bytes = await comics.fetchImageBytes({ url: page.url, extern: page.extern });
    assert.equal(sha256(bytes), sha256(expected), "字面 %5C 文件字节应与 fixture 一致");
  } finally {
    await server.close();
  }
});

test("outside-root-skip 根路径外的脏条目不影响列表、不计入跳过", async () => {
  const { server, comics } = await bootServer({
    extraHrefs: [
      { href: "/dav/..%5C..%5Csecret", isCollection: false },
      { href: "/dav/%252e%252e/", isCollection: true }
    ]
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.data.items.length, 3, "正常漫画不受影响");
    assert.equal(list.extern?.scanWarning ?? null, null, "根外条目不算跳过，不应出现 warning");
    assert.ok(
      server.requests.every(
        (request) => !request.path.includes("..") && !request.path.includes("\\")
      ),
      "不能对根外脏路径发请求：" + server.requests.map((r) => r.path).join(" | ")
    );
  } finally {
    await server.close();
  }
});
