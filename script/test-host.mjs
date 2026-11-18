/**
 * Node 测试用最小 Breeze 宿主 shim：__http_request_promise + native + cache。
 */

import http from "node:http";

const nativePool = new Map();
let nextBufferId = 1;

function normalizeResponseHeaders(rawHeaders) {
  const headers = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

export function installTestHost() {
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
