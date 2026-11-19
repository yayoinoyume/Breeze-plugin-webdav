/**
 * 测试用 WebDAV 服务器（node:http 自实现，不依赖 rclone / nginx）。
 *
 * 支持：Basic 认证、PROPFIND(Depth 0/1/infinity)、GET、HEAD、Range(206)。
 * fixture 每次启动重新生成，内容确定但不必与任何外部文件一致。
 *
 * 额外开关（给 CBZ 远程取页测试用）：
 * - bigCbz: true     根目录放一个 ≥50 MiB、120 页的 CBZ（stored 与 deflate 混合）
 * - edgeCbz: true    放边界包：注释上限 65535 B、非法注释（多 1 B）、ZIP64、CRC 被篡改、声明超大 compressedSize
 * - ignoreRange: true 服务器忽略 Range，GET 一律返回 200 整包
 * - failRangeOnce: true 第一次带 Range 的 GET 返回 503，用来验证重试
 */

import { createServer } from "node:http";
import { zipSync } from "fflate";

export const DAV_PREFIX = "/dav";
export const AUTH_USER = "demo";
export const AUTH_PASS = "demo";

const LAST_MODIFIED = "Tue, 18 Nov 2026 10:00:00 GMT";

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makePngLike(size, seed) {
  const bytes = new Uint8Array(size);
  const random = mulberry32(seed);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = Math.floor(random() * 256);
  }
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

/** 按条目指定压缩级别（level 0 = stored，6 = deflate）。 */
function buildMixedZip(files) {
  const zippable = {};
  for (const [name, bytes, level] of files) {
    zippable[name] = [bytes, { level }];
  }
  return zipSync(zippable, { level: 0 });
}

function readU32(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function findEocd(bytes) {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("测试 ZIP 里找不到 EOCD");
}

/** 给归档加一条超长注释（ZIP 规范上限 65535 字节）；extraTail 用来构造非法包。 */
function withZipComment(zip, commentLength, extraTail = 0) {
  const eocd = findEocd(zip);
  const out = new Uint8Array(eocd + 22 + commentLength + extraTail);
  out.set(zip.subarray(0, eocd + 22), 0);
  writeU16(out, eocd + 20, commentLength);
  out.fill(0x20, eocd + 22);
  return out;
}

/** 篡改中央目录里某条目的 compressedSize（数据本身不变）。 */
function withBrokenCompressedSize(zip, compressedSize, entryName) {
  const out = zip.slice();
  for (let offset = 0; offset + 46 <= out.length; offset += 1) {
    if (readU32(out, offset) !== 0x02014b50) {
      continue;
    }
    const nameLength = out[offset + 28] | (out[offset + 29] << 8);
    const name = new TextDecoder("utf-8").decode(
      out.subarray(offset + 46, offset + 46 + nameLength)
    );
    if (name === entryName) {
      writeU32(out, offset + 20, compressedSize);
      return out;
    }
  }
  throw new Error("测试 ZIP 里找不到条目：" + entryName);
}

/** 把 EOCD 的中央目录偏移改成 ZIP64 哨兵值。 */
function asZip64Sentinel(zip) {
  const out = zip.slice();
  const eocd = findEocd(out);
  writeU32(out, eocd + 16, 0xffffffff);
  return out;
}

/** 篡改中央目录里某条目的 CRC（数据本身不变，解压后 CRC 必然对不上）。 */
function withBrokenCrc(zip, entryName) {
  const out = zip.slice();
  for (let offset = 0; offset + 46 <= out.length; offset += 1) {
    if (readU32(out, offset) !== 0x02014b50) {
      continue;
    }
    const nameLength = out[offset + 28] | (out[offset + 29] << 8);
    const nameBytes = out.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder("utf-8").decode(nameBytes);
    if (name === entryName) {
      const crc = readU32(out, offset + 16);
      writeU32(out, offset + 16, (crc ^ 0xffffffff) >>> 0);
      return out;
    }
  }
  throw new Error("测试 ZIP 里找不到条目：" + entryName);
}

function dir(children) {
  return { type: "dir", children: new Map(Object.entries(children)) };
}

function file(bytes) {
  return { type: "file", bytes };
}

/**
 * 生成 fixture：3 张图 + 1 个子目录 2 张图 + 1 个 >8MiB 的 CBZ。
 * options.backslashEntry=true 时在根目录多放一个名含反斜杠的图（href 会编码成 1%5C2.png），
 * 用来验证扫描跳过脏条目而不是整库报错。
 */
export function createFixture(options = {}) {
  const page1 = makePngLike(320 * 1024, 1);
  const page2 = makePngLike(400 * 1024, 2);
  const page3 = makePngLike(288 * 1024, 3);
  const subPage1 = makePngLike(200 * 1024, 4);
  const subPage2 = makePngLike(220 * 1024, 5);

  const cbz = zipSync(
    {
      "001.png": makePngLike(2_900_000, 21),
      "002.png": makePngLike(2_900_000, 22),
      "003.png": makePngLike(2_900_000, 23)
    },
    { level: 0 }
  );

  const comicsPage1 = makePngLike(180 * 1024, 31);
  const comicsPage2 = makePngLike(200 * 1024, 32);
  const comicsPage3 = makePngLike(160 * 1024, 33);
  const percentPage = makePngLike(140 * 1024, 41);
  const comicsCbz = zipSync(
    {
      "010.png": makePngLike(1_200_000, 34),
      "2.png": makePngLike(1_100_000, 35),
      "001.png": makePngLike(1_000_000, 36)
    },
    { level: 0 }
  );

  const rootChildren = {
    "第 01 页.png": file(page1),
    "page-02.png": file(page2),
    "page 03.png": file(page3),
    "合集.cbz": file(cbz),
    子目录: dir({
      "a.png": file(subPage1),
      "b.png": file(subPage2)
    }),
    comics: dir({
      目录漫画: dir({
        "010.png": file(comicsPage1),
        "2.png": file(comicsPage2),
        "001.png": file(comicsPage3)
      }),
      "100%20": dir({
        "a%20b.png": file(percentPage)
      }),
      "整包.cbz": file(comicsCbz)
    })
  };
  if (options.backslashEntry === true) {
    rootChildren["1\\2.png"] = file(makePngLike(8 * 1024, 61));
  }
  if (options.percentNames === true) {
    // 合法但带 % 的名字：根目录放 100%.png（解码文本里是字面 %）。
    rootChildren["100%.png"] = file(makePngLike(9 * 1024, 64));
  }

  // 大包：120 页 × 448 KiB ≈ 52.5 MiB，偶数页 deflate、奇数页 stored。
  let bigCbz = null;
  const bigCbzEntries = new Map();
  if (options.bigCbz === true) {
    const files = [];
    for (let index = 1; index <= 120; index += 1) {
      const name = String(index).padStart(3, "0") + ".png";
      const payload = makePngLike(448 * 1024, 5000 + index);
      files.push([name, payload, index % 2 === 0 ? 0 : 6]);
      bigCbzEntries.set(name, payload);
    }
    bigCbz = buildMixedZip(files);
    rootChildren["大包.cbz"] = file(bigCbz);
  }

  // 边界包：超长注释 / ZIP64 / CRC 被篡改。
  let edgeCbz = null;
  if (options.edgeCbz === true) {
    const edgeFiles = new Map([
      ["001.png", makePngLike(64 * 1024, 900)],
      ["002.png", makePngLike(64 * 1024, 901)]
    ]);
    const base = buildMixedZip([
      ["001.png", edgeFiles.get("001.png"), 0],
      ["002.png", edgeFiles.get("002.png"), 6]
    ]);
    edgeCbz = {
      commentMax: withZipComment(base, 65535),
      commentInvalid: withZipComment(base, 65535, 1),
      zip64: asZip64Sentinel(base),
      crcMismatch: withBrokenCrc(base, "001.png"),
      // 上限是 65 MiB（压缩数据再多留 1 MiB 膨胀余量），所以这里声明 66 MiB + 1。
      compressedTooLarge: withBrokenCompressedSize(base, 66 * 1024 * 1024 + 1, "001.png"),
      entries: edgeFiles
    };
    rootChildren["注释上限.cbz"] = file(edgeCbz.commentMax);
    rootChildren["长注释.cbz"] = file(edgeCbz.commentInvalid);
    rootChildren["zip64.cbz"] = file(edgeCbz.zip64);
    rootChildren["坏CRC.cbz"] = file(edgeCbz.crcMismatch);
    rootChildren["压缩超限.cbz"] = file(edgeCbz.compressedTooLarge);
  }

  const root = dir(rootChildren);

  // 脏名字条目：href 里会出现 %252e%252e / %5C / %255C 这些形式。
  const dirtyEntries = Array.isArray(options.dirtyEntries) ? options.dirtyEntries : [];
  if (dirtyEntries.length > 0) {
    const comicsDir = root.children.get("comics");
    const dirComic = comicsDir.children.get("目录漫画");
    for (const dirty of dirtyEntries) {
      if (dirty === "dots-dir") {
        // 真实目录名就是 %2e%2e（href %252e%252e）：合法名字，应能正常打开。
        comicsDir.children.set("%2e%2e", dir({ "001.png": file(makePngLike(10 * 1024, 63)) }));
      } else if (dirty === "backslash-dir") {
        comicsDir.children.set("\\", dir({}));
      } else if (dirty === "percent-file") {
        dirComic.children.set("a%5Cb.png", file(makePngLike(4 * 1024, 62)));
      }
    }
  }
  if (options.percentNames === true) {
    // 合法但带 % 的名字：目录 "50% off" 放一个 CBZ，目录名含中文/emoji。
    const comicsDir = root.children.get("comics");
    const percentCbz = zipSync({ "001.png": makePngLike(12 * 1024, 65) }, { level: 0 });
    comicsDir.children.set("50% off", dir({ "整包2.cbz": file(percentCbz) }));
    comicsDir.children.set("漫画 😀", dir({ "第 1 页.png": file(makePngLike(11 * 1024, 66)) }));
  }

  if (Array.isArray(options.emptyDirs)) {
    const comicsDir = root.children.get("comics");
    for (const name of options.emptyDirs) {
      comicsDir.children.set(String(name), dir({}));
    }
  }
  if (options.trailingSpaceName === true) {
    // 名字里的空格是合法字符：a<空格>.png。
    root.children.get("comics").children.set("a .png", file(makePngLike(7 * 1024, 67)));
  }

  const files = new Map();
  const walk = (node, relative) => {
    if (node.type === "file") {
      files.set(toDavKey(relative), node.bytes);
      return;
    }
    for (const [name, child] of node.children) {
      walk(child, relative === "/" ? "/" + name : relative + "/" + name);
    }
  };
  walk(root, "/");

  return { root, files, cbz, comicsCbz, bigCbz, bigCbzEntries, edgeCbz };
}

/** 与旧实现一致的路径拼接（避免重复斜杠）。 */
function toDavKey(relative) {
  return DAV_PREFIX + (relative === "/" ? "/" : relative);
}

function isAuthorized(req, user, pass) {
  const header = req.headers.authorization ?? "";
  const expected = "Basic " + Buffer.from(user + ":" + pass, "utf8").toString("base64");
  return header === expected;
}

function lookup(root, relativePath) {
  const segments = relativePath.split("/").filter((segment) => segment !== "");
  let node = root;
  for (const segment of segments) {
    if (node.type !== "dir") {
      return null;
    }
    const next = node.children.get(segment);
    if (next === undefined) {
      return null;
    }
    node = next;
  }
  return node;
}

function encodeHref(relativePath, isCollection) {
  const encoded = relativePath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const href = encoded === "" ? DAV_PREFIX + "/" : DAV_PREFIX + "/" + encoded;
  return isCollection && !href.endsWith("/") ? href + "/" : href;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function propfindResponseXml(relativePath, node, depth, extraHrefs = []) {
  const items = [];

  const pushItem = (path, current) => {
    const isCollection = current.type === "dir";
    const size = current.type === "file" ? current.bytes.length : 0;
    const name = path.split("/").filter((segment) => segment !== "").pop() ?? "";
    items.push(
      "<D:response>" +
        "<D:href>" + escapeXml(encodeHref(path, isCollection)) + "</D:href>" +
        "<D:propstat><D:prop>" +
        "<D:displayname>" + escapeXml(name) + "</D:displayname>" +
        "<D:resourcetype>" + (isCollection ? "<D:collection/>" : "") + "</D:resourcetype>" +
        "<D:getcontentlength>" + size + "</D:getcontentlength>" +
        "<D:getlastmodified>" + LAST_MODIFIED + "</D:getlastmodified>" +
        "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
        "</D:response>"
    );
  };

  const walk = (path, current, remainingDepth) => {
    pushItem(path, current);
    if (current.type !== "dir" || remainingDepth <= 0) {
      return;
    }
    for (const [name, child] of current.children) {
      walk(path === "/" ? "/" + name : path + "/" + name, child, remainingDepth - 1);
    }
  };

  walk(relativePath, node, depth);

  // 注入根路径外的 href：用来验证「根外条目不计入跳过数、不触发 warning」。
  for (const extra of extraHrefs) {
    const isCollection = extra.isCollection === true;
    const lastSegment = String(extra.href).split("/").filter((segment) => segment !== "").pop() ?? "";
    items.push(
      "<D:response>" +
        "<D:href>" + escapeXml(extra.href) + "</D:href>" +
        "<D:propstat><D:prop>" +
        "<D:displayname>" + escapeXml(lastSegment) + "</D:displayname>" +
        "<D:resourcetype>" + (isCollection ? "<D:collection/>" : "") + "</D:resourcetype>" +
        "<D:getcontentlength>16</D:getcontentlength>" +
        "<D:getlastmodified>" + LAST_MODIFIED + "</D:getlastmodified>" +
        "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
        "</D:response>"
    );
  }

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:multistatus xmlns:D="DAV:">' +
    items.join("") +
    "</D:multistatus>"
  );
}

function parseRange(header, size) {
  const matched = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (matched === null) {
    return null;
  }
  let start = matched[1] === "" ? Number.NaN : Number(matched[1]);
  let end = matched[2] === "" ? Number.NaN : Number(matched[2]);
  if (!Number.isFinite(start)) {
    if (!Number.isFinite(end) || end <= 0) {
      return null;
    }
    start = Math.max(0, size - end);
    end = size - 1;
  }
  if (!Number.isFinite(end) || end >= size) {
    end = size - 1;
  }
  if (start < 0 || start > end) {
    return null;
  }
  return { start, end };
}

function contentTypeOf(path) {
  if (path.endsWith(".cbz")) return "application/vnd.comicbook+zip";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

/**
 * 启动测试服务器，返回 { port, fixture, requests, close }。
 * requests 里每条记录都带 responseBytes（本次响应真正发出的字节数，HEAD 为 0）。
 */
export async function startWebDavServer(options = {}) {
  const user = options.user ?? AUTH_USER;
  const pass = options.pass ?? AUTH_PASS;
  const fixture = createFixture({
    backslashEntry: options.backslashEntry === true,
    dirtyEntries: Array.isArray(options.dirtyEntries) ? options.dirtyEntries : [],
    percentNames: options.percentNames === true,
    emptyDirs: Array.isArray(options.emptyDirs) ? options.emptyDirs : [],
    trailingSpaceName: options.trailingSpaceName === true,
    bigCbz: options.bigCbz === true,
    edgeCbz: options.edgeCbz === true
  });
  const extraHrefs = Array.isArray(options.extraHrefs) ? options.extraHrefs : [];
  const forbiddenPaths = Array.isArray(options.forbiddenPaths) ? options.forbiddenPaths : [];
  const ignoreRange = options.ignoreRange === true;
  const failRangeOnce = options.failRangeOnce === true;
  let rangeFailed = false;
  const requests = [];

  const server = createServer((req, res) => {
    req.resume();

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
    const record = {
      method: req.method ?? "",
      path,
      range: req.headers.range ?? null,
      depth: req.headers.depth ?? null,
      responseBytes: 0
    };
    requests.push(record);

    const reply = (status, headers, body, byteLength) => {
      record.status = status;
      record.responseBytes = byteLength ?? (body === undefined ? 0 : Buffer.byteLength(body));
      res.writeHead(status, headers);
      res.end(body);
    };
    const replyText = (status, text, headers = {}) =>
      reply(status, { "Content-Type": "text/plain; charset=utf-8", ...headers }, text);

    if (!isAuthorized(req, user, pass)) {
      replyText(401, "unauthorized", { "WWW-Authenticate": 'Basic realm="webdav-test"' });
      return;
    }

    if (forbiddenPaths.some((prefix) => path === prefix || path.startsWith(prefix + "/"))) {
      replyText(403, "forbidden");
      return;
    }

    let relativePath = null;
    if (path === DAV_PREFIX || path === DAV_PREFIX + "/") {
      relativePath = "/";
    } else if (path.startsWith(DAV_PREFIX + "/")) {
      relativePath = path.slice(DAV_PREFIX.length);
    }
    const node = relativePath === null ? null : lookup(fixture.root, relativePath);
    if (relativePath === null || node === null) {
      replyText(404, "not found");
      return;
    }

    if (req.method === "OPTIONS") {
      reply(200, { Allow: "OPTIONS, PROPFIND, GET, HEAD", DAV: "1, 2" });
      return;
    }

    if (req.method === "PROPFIND") {
      const depthHeader = String(req.headers.depth ?? "1").toLowerCase();
      const depth = depthHeader === "0" ? 0 : depthHeader === "infinity" ? Number.POSITIVE_INFINITY : 1;
      const xml = propfindResponseXml(relativePath, node, depth, extraHrefs);
      reply(207, { "Content-Type": "text/xml; charset=utf-8", "Content-Length": Buffer.byteLength(xml) }, xml);
      return;
    }

    if (
      failRangeOnce &&
      !rangeFailed &&
      req.method === "GET" &&
      typeof req.headers.range === "string"
    ) {
      rangeFailed = true;
      replyText(503, "temporary range failure");
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (node.type === "dir") {
        const names = [...node.children.keys()].map(escapeXml).join(", ");
        const html = "<html><body><h1>Index of " + escapeXml(relativePath) + "</h1><p>" + names + "</p></body></html>";
        reply(
          200,
          { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) },
          req.method === "HEAD" ? undefined : html
        );
        return;
      }

      const bytes = node.bytes;
      const range = ignoreRange ? null : parseRange(req.headers.range, bytes.length);
      const headers = {
        "Content-Type": contentTypeOf(relativePath),
        "Accept-Ranges": "bytes",
        "Last-Modified": LAST_MODIFIED
      };

      if (range !== null) {
        const slice = bytes.subarray(range.start, range.end + 1);
        reply(
          206,
          {
            ...headers,
            "Content-Range": "bytes " + range.start + "-" + range.end + "/" + bytes.length,
            "Content-Length": slice.length
          },
          req.method === "HEAD" ? undefined : Buffer.from(slice),
          req.method === "HEAD" ? 0 : slice.length
        );
        return;
      }

      reply(
        200,
        { ...headers, "Content-Length": bytes.length },
        req.method === "HEAD" ? undefined : Buffer.from(bytes),
        req.method === "HEAD" ? 0 : bytes.length
      );
      return;
    }

    reply(405, { Allow: "OPTIONS, PROPFIND, GET, HEAD" });
  });

  await new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    fixture,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
