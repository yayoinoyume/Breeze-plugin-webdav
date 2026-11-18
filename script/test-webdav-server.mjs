/**
 * 测试用 WebDAV 服务器（node:http 自实现，不依赖 rclone / nginx）。
 *
 * 支持：Basic 认证、PROPFIND(Depth 0/1/infinity)、GET、HEAD、Range(206)。
 * fixture 每次启动重新生成，内容确定但不必与任何外部文件一致。
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

function dir(children) {
  return { type: "dir", children: new Map(Object.entries(children)) };
}

function file(bytes) {
  return { type: "file", bytes };
}

/** 生成 fixture：3 张图 + 1 个子目录 2 张图 + 1 个 >8MiB 的 CBZ。 */
export function createFixture() {
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

  const root = dir({
    "第 01 页.png": file(page1),
    "page-02.png": file(page2),
    "page 03.png": file(page3),
    "合集.cbz": file(cbz),
    子目录: dir({
      "a.png": file(subPage1),
      "b.png": file(subPage2)
    })
  });

  const files = new Map();
  const walk = (node, relative) => {
    if (node.type === "file") {
      files.set(`${DAV_PREFIX}${relative === "/" ? "/" : relative}`, node.bytes);
      return;
    }
    for (const [name, child] of node.children) {
      walk(child, relative === "/" ? `/${name}` : `${relative}/${name}`);
    }
  };
  walk(root, "/");

  return { root, files, cbz };
}

function isAuthorized(req, user, pass) {
  const header = req.headers.authorization ?? "";
  const expected = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
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
  const href = encoded === "" ? `${DAV_PREFIX}/` : `${DAV_PREFIX}/${encoded}`;
  return isCollection && !href.endsWith("/") ? `${href}/` : href;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function propfindResponseXml(relativePath, node, depth) {
  const items = [];

  const pushItem = (path, current) => {
    const isCollection = current.type === "dir";
    const size = current.type === "file" ? current.bytes.length : 0;
    const name = path.split("/").filter((segment) => segment !== "").pop() ?? "";
    items.push(
      "<D:response>" +
        `<D:href>${escapeXml(encodeHref(path, isCollection))}</D:href>` +
        "<D:propstat><D:prop>" +
        `<D:displayname>${escapeXml(name)}</D:displayname>` +
        `<D:resourcetype>${isCollection ? "<D:collection/>" : ""}</D:resourcetype>` +
        `<D:getcontentlength>${size}</D:getcontentlength>` +
        `<D:getlastmodified>${LAST_MODIFIED}</D:getlastmodified>` +
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
      walk(path === "/" ? `/${name}` : `${path}/${name}`, child, remainingDepth - 1);
    }
  };

  walk(relativePath, node, depth);

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
 */
export async function startWebDavServer(options = {}) {
  const user = options.user ?? AUTH_USER;
  const pass = options.pass ?? AUTH_PASS;
  const fixture = createFixture();
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
    requests.push({
      method: req.method ?? "",
      path,
      range: req.headers.range ?? null,
      depth: req.headers.depth ?? null
    });

    if (!isAuthorized(req, user, pass)) {
      res.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="webdav-test"'
      });
      res.end("unauthorized");
      return;
    }

    let relativePath = null;
    if (path === DAV_PREFIX || path === `${DAV_PREFIX}/`) {
      relativePath = "/";
    } else if (path.startsWith(`${DAV_PREFIX}/`)) {
      relativePath = path.slice(DAV_PREFIX.length);
    }
    const node = relativePath === null ? null : lookup(fixture.root, relativePath);
    if (relativePath === null || node === null) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        Allow: "OPTIONS, PROPFIND, GET, HEAD",
        DAV: "1, 2"
      });
      res.end();
      return;
    }

    if (req.method === "PROPFIND") {
      const depthHeader = String(req.headers.depth ?? "1").toLowerCase();
      const depth = depthHeader === "0" ? 0 : depthHeader === "infinity" ? Number.POSITIVE_INFINITY : 1;
      const xml = propfindResponseXml(relativePath, node, depth);
      res.writeHead(207, {
        "Content-Type": "text/xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(xml)
      });
      res.end(xml);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (node.type === "dir") {
        const names = [...node.children.keys()].map(escapeXml).join(", ");
        const html = `<html><body><h1>Index of ${escapeXml(relativePath)}</h1><p>${names}</p></body></html>`;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(html)
        });
        res.end(req.method === "HEAD" ? undefined : html);
        return;
      }

      const bytes = node.bytes;
      const range = parseRange(req.headers.range, bytes.length);
      const headers = {
        "Content-Type": contentTypeOf(relativePath),
        "Accept-Ranges": "bytes",
        "Last-Modified": LAST_MODIFIED
      };

      if (range !== null) {
        const slice = bytes.subarray(range.start, range.end + 1);
        res.writeHead(206, {
          ...headers,
          "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}`,
          "Content-Length": slice.length
        });
        res.end(req.method === "HEAD" ? undefined : Buffer.from(slice));
        return;
      }

      res.writeHead(200, { ...headers, "Content-Length": bytes.length });
      res.end(req.method === "HEAD" ? undefined : Buffer.from(bytes));
      return;
    }

    res.writeHead(405, { Allow: "OPTIONS, PROPFIND, GET, HEAD" });
    res.end();
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
