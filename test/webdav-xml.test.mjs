import assert from "node:assert/strict";
import test from "node:test";
import { parseMultistatus } from "../src/webdav/xml.ts";

test("webdav-xml 解析 D: 前缀的 multistatus", () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:">',
    "<D:response>",
    "<D:href>/dav/</D:href>",
    "<D:propstat><D:prop>",
    "<D:resourcetype><D:collection/></D:resourcetype>",
    "<D:getcontentlength>0</D:getcontentlength>",
    "<D:getlastmodified>Tue, 18 Nov 2026 10:00:00 GMT</D:getlastmodified>",
    "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>",
    "</D:response>",
    "<D:response>",
    "<D:href>/dav/%E7%AC%AC%2001%20%E9%A1%B5.png</D:href>",
    "<D:propstat><D:prop>",
    "<D:resourcetype/>",
    "<D:getcontentlength>327680</D:getcontentlength>",
    "<D:getlastmodified>Tue, 18 Nov 2026 10:00:00 GMT</D:getlastmodified>",
    "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>",
    "</D:response>",
    "</D:multistatus>"
  ].join("");

  const entries = parseMultistatus(xml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].href, "/dav/");
  assert.equal(entries[0].isCollection, true);
  assert.equal(entries[0].contentLength, 0);
  assert.equal(entries[0].lastModified, "Tue, 18 Nov 2026 10:00:00 GMT");
  assert.equal(entries[1].href, "/dav/%E7%AC%AC%2001%20%E9%A1%B5.png");
  assert.equal(entries[1].isCollection, false);
  assert.equal(entries[1].contentLength, 327680);
});

test("webdav-xml 解析无前缀默认命名空间与实体转义", () => {
  const xml =
    '<multistatus xmlns="DAV:">' +
    "<response><href>/a%20b/&#x4E2D;&amp;x.cbz</href>" +
    "<propstat><prop><resourcetype/><getcontentlength>10485760</getcontentlength>" +
    "</prop><status>HTTP/1.1 200 OK</status></propstat></response>" +
    "<response><href>/dir/</href>" +
    "<propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>" +
    "</multistatus>";

  const entries = parseMultistatus(xml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].href, "/a%20b/中&x.cbz");
  assert.equal(entries[0].isCollection, false);
  assert.equal(entries[0].contentLength, 10485760);
  assert.equal(entries[0].lastModified, null);
  assert.equal(entries[1].isCollection, true);
  assert.equal(entries[1].contentLength, null);
});

test("webdav-xml 空响应与错误输入返回空数组", () => {
  assert.deepEqual(parseMultistatus(""), []);
  assert.deepEqual(parseMultistatus('<D:multistatus xmlns:D="DAV:"></D:multistatus>'), []);
  assert.deepEqual(parseMultistatus("not xml at all"), []);
});
