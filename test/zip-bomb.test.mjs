import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { extractZipEntry, MAX_ENTRY_BYTES, readZipEntries } from "../src/zip/cbz.ts";

function readU32(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function patchCentralUncompressed(zipBytes, uncompressedSize) {
  const copy = zipBytes.slice();
  for (let offset = 0; offset + 46 <= copy.length; offset += 1) {
    if (readU32(copy, offset) === 0x02014b50) {
      writeU32(copy, offset + 24, uncompressedSize);
      return copy;
    }
  }
  throw new Error("测试 ZIP 里找不到中央目录项");
}

test("zip-bomb 声明超大解压尺寸或异常压缩比时中文报错且不分配大内存", () => {
  const base = zipSync({ "bomb.png": Uint8Array.from([1, 2, 3, 4]) }, { level: 0 });

  const tooLarge = patchCentralUncompressed(base, MAX_ENTRY_BYTES + 1);
  const tooLargeEntry = readZipEntries(tooLarge)[0];
  assert.throws(
    () => extractZipEntry(tooLarge, tooLargeEntry),
    /这一页解压后太大/
  );

  const highRatio = patchCentralUncompressed(base, 10 * 1024 * 1024);
  const highRatioEntry = readZipEntries(highRatio)[0];
  assert.throws(
    () => extractZipEntry(highRatio, highRatioEntry),
    /压缩比异常/
  );
});


test("zip-lying-size 中央目录谎报 16 字节但实际 80MiB 时快速报错", () => {
  const payload = new Uint8Array(80 * 1024 * 1024);
  const honest = zipSync({ "bomb.png": payload }, { level: 6 });
  const lying = patchCentralUncompressed(honest, 16);
  const entry = readZipEntries(lying)[0];
  assert.equal(entry.uncompressedSize, 16);
  assert.ok(entry.compressedSize > 1024, "测试包应确实被压缩过");

  const started = performance.now();
  assert.throws(
    () => extractZipEntry(lying, entry),
    /CBZ 解压长度与中央目录不一致|这一页解压后太大/
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, "说谎尺寸应快速截断，实际耗时 " + elapsed.toFixed(1) + "ms");
});
