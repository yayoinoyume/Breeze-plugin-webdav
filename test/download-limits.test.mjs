import assert from "node:assert/strict";
import test from "node:test";
import { downloadFileBytes, MAX_DOWNLOAD_BYTES } from "../src/http/download.ts";

function makePayload(size) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

test("head-fallback HEAD 405 时用 Range 0-0 探测总长并成功下载", async () => {
  const payload = makePayload(20);
  const requests = [];

  const request = async (spec) => {
    requests.push(spec);
    if (spec.method === "HEAD") {
      return { status: 405, statusText: "Method Not Allowed", url: spec.url, headers: {}, bytes: new Uint8Array(0) };
    }
    const matched = /^bytes=(\d+)-(\d+)$/.exec(String(spec.headers.Range ?? ""));
    if (matched === null) {
      return { status: 400, statusText: "Bad Request", url: spec.url, headers: {}, bytes: new Uint8Array(0) };
    }
    const start = Number(matched[1]);
    const end = Number(matched[2]);
    return {
      status: 206,
      statusText: "Partial Content",
      url: spec.url,
      headers: { "content-range": "bytes " + start + "-" + end + "/" + payload.length },
      bytes: payload.slice(start, end + 1)
    };
  };

  const result = await downloadFileBytes("http://nas.local/dav/big.bin", {
    request,
    chunkSize: 8
  });

  assert.equal(result.usedRange, true);
  assert.equal(result.chunkCount, 3);
  assert.deepEqual([...result.bytes], [...payload]);
  assert.equal(requests[0].method, "HEAD");
  assert.equal(requests[1].method, "GET");
  assert.equal(requests[1].headers.Range, "bytes=0-0");
});

test("content-range Content-Range 与请求不符时抛错，不产出错误字节", async () => {
  const payload = makePayload(20);
  const requests = [];

  const request = async (spec) => {
    requests.push(spec);
    if (spec.method === "HEAD") {
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: { "content-length": String(payload.length) },
        bytes: new Uint8Array(0)
      };
    }
    // 故意回 0-4，而请求是 0-7。
    return {
      status: 206,
      statusText: "Partial Content",
      url: spec.url,
      headers: { "content-range": "bytes 0-4/" + payload.length },
      bytes: payload.slice(0, 5)
    };
  };

  await assert.rejects(
    () => downloadFileBytes("http://nas.local/dav/bad.bin", { request, chunkSize: 8 }),
    /Content-Range 与请求不一致/
  );
  assert.equal(requests.filter((spec) => spec.method === "GET").length, 1);
});

test("content-range 长度探测失败时明确报错，不盲发整包 GET", async () => {
  let getCount = 0;
  const request = async (spec) => {
    if (spec.method === "HEAD") {
      return { status: 405, statusText: "", url: spec.url, headers: {}, bytes: new Uint8Array(0) };
    }
    getCount += 1;
    return { status: 405, statusText: "", url: spec.url, headers: {}, bytes: new Uint8Array(0) };
  };

  await assert.rejects(
    () => downloadFileBytes("http://nas.local/dav/unknown.bin", { request }),
    /拿不到文件长度/
  );
  assert.equal(getCount, 1, "只允许发一次 Range 探测，不发整包");
});

test("download-limit 超过插件上限直接拒绝", async () => {
  let requests = 0;
  const request = async () => {
    requests += 1;
    return { status: 200, statusText: "", url: "http://nas.local/x", headers: {}, bytes: new Uint8Array(0) };
  };
  await assert.rejects(
    () =>
      downloadFileBytes("http://nas.local/dav/huge.bin", {
        request,
        contentLength: MAX_DOWNLOAD_BYTES + 1
      }),
    /超过插件下载上限/
  );
  assert.equal(requests, 0);
});


test("probe-ignore-range 服务器忽略 Range 返回 200 时探测失败，不再发第二次整包", async () => {
  let getCount = 0;
  const request = async (spec) => {
    if (spec.method === "HEAD") {
      return { status: 405, statusText: "", url: spec.url, headers: {}, bytes: new Uint8Array(0) };
    }
    getCount += 1;
    return {
      status: 200,
      statusText: "OK",
      url: spec.url,
      headers: { "content-length": "20" },
      bytes: new Uint8Array(20)
    };
  };

  await assert.rejects(
    () => downloadFileBytes("http://nas.local/dav/no-range.bin", { request }),
    /拿不到文件长度/
  );
  assert.equal(getCount, 1, "探测失败后不应再发整包 GET");
});
