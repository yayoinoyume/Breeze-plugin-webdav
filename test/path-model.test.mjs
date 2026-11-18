/**
 * 路径模型收口（方案 A）：
 * - 合法的怪名字一律放行：100%.png、50% off/整包2.cbz、中文/空格/emoji 都能列、开、取字节；
 * - 只有解码文本里真有字面反斜杠 / .. 段 / 控制字符的路径，才会在发请求时被拒绝；
 * - 这类危险路径由真服务器 href 注入，列表不抛，只让对应条目/这一本失败。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import "breeze-plugin-kit/node";
import { authConfig } from "breeze-plugin-kit";
import { unzipSync } from "fflate";
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
  await authConfig.save(SETTING_KEYS.rootPath, options.rootPath ?? "/");
  await authConfig.save(SETTING_KEYS.scanDepth, "2");
  await authConfig.save(SETTING_KEYS.maxComics, "300");
  await authConfig.save(SETTING_KEYS.includeCbz, "true");
  comics.clearScanCache();
  return { server, comics, keys: SETTING_KEYS };
}

test("literal-percent-name-ok 合法 % 名字（100%.png、50% off/整包2.cbz、emoji）能列能开能取字节", async () => {
  const { server, comics, keys } = await bootServer({ percentNames: true, rootPath: "/" });
  try {
    // 根漫画：100%.png 必须出现在列表、详情、快照里，并且能取到字节。
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.extern?.scanWarning ?? null, null, "合法 % 名字不应触发 warning");
    const rootItem = list.data.items.find((item) => item.extern?.path === "/");
    assert.ok(rootItem, "根目录漫画仍应列出");
    assert.equal(rootItem.cover.path, "/100%.png", "字面 % 的图片可以当封面");

    const detail = await comics.getComicDetail({ comicId: rootItem.id, extern: {} });
    assert.equal(detail.data.normal.comicInfo.cover.path, "/100%.png");
    const expectedPercent = server.fixture.files.get(DAV_PREFIX + "/100%.png");
    assert.ok(expectedPercent instanceof Uint8Array, "fixture 应有 100%.png");
    const coverBytes = await comics.fetchImageBytes({
      url: detail.data.normal.comicInfo.cover.url,
      extern: {}
    });
    assert.equal(sha256(coverBytes), sha256(expectedPercent), "100%.png 字节应与 fixture 一致");

    const snapshot = await comics.getReadSnapshot({ comicId: rootItem.id, extern: {} });
    const percentPage = snapshot.data.chapter.pages.find((page) => page.path === "/100%.png");
    assert.ok(percentPage, "100%.png 应出现在页列表");
    const pageBytes = await comics.fetchImageBytes({
      url: percentPage.url,
      extern: percentPage.extern
    });
    assert.equal(sha256(pageBytes), sha256(expectedPercent), "页面字节应与 fixture 一致");

    // 含字面 % 与空格的目录下的 CBZ：切换 rootPath 再扫一次。
    await authConfig.save(keys.rootPath, "/comics");
    comics.clearScanCache();
    const list2 = await comics.getComicList({ page: 1 });
    const cbzItem = list2.data.items.find(
      (item) => item.extern?.path === "/comics/50% off/整包2.cbz"
    );
    assert.ok(cbzItem, "50% off/整包2.cbz 应正常列出：" + JSON.stringify(list2.data.items.map((x) => x.extern?.path)));
    const cbzDetail = await comics.getComicDetail({ comicId: cbzItem.id, extern: {} });
    const cbzBytes = server.fixture.files.get(DAV_PREFIX + "/comics/50% off/整包2.cbz");
    assert.ok(cbzBytes instanceof Uint8Array, "fixture 应有 50% off/整包2.cbz");
    const cbzFirst = unzipSync(cbzBytes)["001.png"];
    const coverFromCbz = await comics.fetchImageBytes({
      url: cbzDetail.data.normal.comicInfo.cover.url,
      extern: {}
    });
    assert.equal(sha256(coverFromCbz), sha256(cbzFirst), "CBZ 封面字节应与 fixture 一致");

    // 中文 + emoji 目录名回归。
    const emojiItem = list2.data.items.find(
      (item) => item.extern?.path === "/comics/漫画 😀"
    );
    assert.ok(emojiItem, "中文/emoji 目录应正常列出");
    const emojiDetail = await comics.getComicDetail({ comicId: emojiItem.id, extern: {} });
    assert.equal(emojiDetail.data.normal.comicInfo.cover.path, "/comics/漫画 😀/第 1 页.png");
    const emojiExpected = server.fixture.files.get(DAV_PREFIX + "/comics/漫画 😀/第 1 页.png");
    assert.ok(emojiExpected instanceof Uint8Array, "fixture 应有 emoji 目录图片");
    const emojiBytes = await comics.fetchImageBytes({
      url: emojiDetail.data.normal.comicInfo.cover.url,
      extern: {}
    });
    assert.equal(sha256(emojiBytes), sha256(emojiExpected), "中文/emoji 图片字节应与 fixture 一致");
  } finally {
    await server.close();
  }
});

test("real-traversal-href-skipped 真实危险 href（解码后含字面 ..）不进结果集，直接打开也明确报错", async () => {
  const { server, comics } = await bootServer({
    rootPath: "/comics",
    extraHrefs: [
      // 解码一次后分别是 /comics/../secret 和 /comics/../危险.cbz —— 真的 .. 段。
      { href: "/dav/comics/%2e%2e%2fsecret/", isCollection: true },
      { href: "/dav/comics/%2e%2e%2f危险.cbz", isCollection: false }
    ]
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.deepEqual(
      list.data.items.map((item) => item.extern?.path).sort(),
      ["/comics/100%20", "/comics/整包.cbz", "/comics/目录漫画"],
      "危险条目（文件/目录）都不能进结果集"
    );
    assert.match(
      String(list.extern?.scanWarning ?? ""),
      /有 \d+ 个条目无法安全读取/,
      "被过滤的危险条目要如实计数"
    );
    assert.ok(
      server.requests.every((request) => !request.path.includes("..")),
      "不能对解码后含 .. 的路径发请求：" + server.requests.map((r) => r.path).join(" | ")
    );

    // 拿着旧 id 直接打开也要明确报错。
    const { encodeComicId } = await import("../src/webdav/ids.ts");
    const dangerousId = encodeComicId("cbz", "/comics/../危险.cbz");
    await assert.rejects(
      () => comics.getComicDetail({ comicId: dangerousId, extern: {} }),
      /这一项的路径不安全，已跳过/
    );
    await assert.rejects(
      () => comics.getReadSnapshot({ comicId: dangerousId, extern: {} }),
      /这一项的路径不安全，已跳过/
    );

    const normal = list.data.items.find((item) => item.extern?.path === "/comics/目录漫画");
    assert.ok(normal, "正常漫画仍应列出");
    const normalDetail = await comics.getComicDetail({ comicId: normal.id, extern: {} });
    assert.equal(normalDetail.data.normal.comicInfo.title, "目录漫画");
  } finally {
    await server.close();
  }
});

test("control-char-href-skipped 解码后含 NUL 控制字符的路径：列表不抛，打开报明确错误", async () => {
  const { server, comics } = await bootServer({
    rootPath: "/comics",
    extraHrefs: [{ href: "/dav/comics/%00bad.cbz", isCollection: false }]
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.data.items.length, 3, "控制字符条目不能进结果集，其它三本照常");
    assert.match(
      String(list.extern?.scanWarning ?? ""),
      /有 \d+ 个条目无法安全读取/,
      "被过滤的控制字符条目要计数"
    );
    // id 层本来就拒绝控制字符；这里直接用 extern 取图，验证请求层给出明确错误。
    await assert.rejects(
      () =>
        comics.fetchImageBytes({
          url: "",
          extern: { kind: "cbz", path: "/comics/\u0000bad.cbz", index: 0 }
        }),
      /这一项的路径不安全，已跳过/
    );
    const normal = list.data.items.find((item) => item.extern?.path === "/comics/目录漫画");
    assert.ok(normal, "其它漫画不受影响");
    const normalDetail = await comics.getComicDetail({ comicId: normal.id, extern: {} });
    assert.equal(normalDetail.data.normal.comicInfo.title, "目录漫画");
    assert.ok(
      server.requests.every((request) => !request.path.includes("\u0000")),
      "不能对控制字符路径发请求"
    );
  } finally {
    await server.close();
  }
});

test("list-failure-skip 单个目录列失败只跳过它并计数，整次扫描不抛", async () => {
  const { server, comics } = await bootServer({
    rootPath: "/comics",
    // ghost 目录不在 fixture 里：scan 会尝试列出它，服务器回 404。
    extraHrefs: [{ href: "/dav/comics/ghost/", isCollection: true }]
  });
  try {
    const list = await comics.getComicList({ page: 1 });
    assert.equal(list.data.items.length, 3, "其它三本照常列出");
    assert.match(
      String(list.extern?.scanWarning ?? ""),
      /有 \d+ 个条目无法安全读取/,
      "列目录失败要计数并如实提示"
    );
    assert.ok(
      server.requests.some((request) => request.path === "/dav/comics/ghost"),
      "确实尝试列出过 ghost 目录"
    );
  } finally {
    await server.close();
  }
});
