import assert from "node:assert/strict";
import test from "node:test";
import { downloadFileBytes } from "../src/http/download.ts";

function makePayload(size) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

test("chunked-download 分块拼接，并在服务器忽略 Range 时回退整包", async () => {
  const payload = makePayload(20);
  const calls = [];

  const rangeRequest = async (spec) => {
    calls.push(spec);
    if (spec.method === "HEAD") {
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: { "content-length": String(payload.length) },
        bytes: new Uint8Array(0)
      };
    }
    const matched = /^bytes=(\d+)-(\d+)$/.exec(spec.headers.Range);
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

  const result = await downloadFileBytes("http://example.test/file.cbz", {
    request: rangeRequest,
    chunkSize: 8
  });

  assert.equal(result.usedRange, true);
  assert.equal(result.status, 206);
  assert.equal(result.chunkCount, 3);
  assert.deepEqual([...result.bytes], [...payload]);
  assert.equal(calls.filter((call) => call.method === "GET").length, 3);
  assert.match(calls[1].headers.Range, /^bytes=0-7$/);

  const noRangeRequest = async (spec) => {
    if (spec.method === "HEAD") {
      return {
        status: 200,
        statusText: "OK",
        url: spec.url,
        headers: { "content-length": String(payload.length) },
        bytes: new Uint8Array(0)
      };
    }
    return {
      status: 200,
      statusText: "OK",
      url: spec.url,
      headers: {},
      bytes: payload
    };
  };

  const fallback = await downloadFileBytes("http://example.test/file.cbz", {
    request: noRangeRequest,
    chunkSize: 8
  });

  assert.equal(fallback.usedRange, false);
  assert.equal(fallback.status, 200);
  assert.deepEqual([...fallback.bytes], [...payload]);
});
