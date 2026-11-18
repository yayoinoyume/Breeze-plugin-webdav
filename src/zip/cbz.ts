/**
 * 最小 ZIP/CBZ 读取器：只解析中央目录，按需解压单个条目。
 *
 * 为什么不用 fflate 的 unzip()：整包解压会把所有页同时展开到内存。
 * 这里先用中央目录拿到页名与偏移，读某一页时只 inflate 这一个条目。
 */

import { inflateSync } from "fflate";
import { isImageFile, naturalCompare } from "../util/names.ts";

export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.length < 22) {
    throw new Error("CBZ 文件不完整（小于 22 字节）");
  }
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (readU32(bytes, offset) === EOCD_SIGNATURE) {
      const commentLength = readU16(bytes, offset + 20);
      if (offset + 22 + commentLength <= bytes.length) {
        return offset;
      }
    }
  }
  throw new Error("这不是有效的 CBZ/ZIP 文件（找不到中央目录）");
}

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    let out = "";
    for (const byte of bytes) {
      out += byte < 128 ? String.fromCharCode(byte) : "?";
    }
    return out;
  }
}

/** 读中央目录，返回所有条目（包括目录项）。 */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = readU16(bytes, eocd + 10);
  const centralOffset = readU32(bytes, eocd + 16);
  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    throw new Error("CBZ 使用了 ZIP64 格式，暂不支持");
  }

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || readU32(bytes, offset) !== CENTRAL_SIGNATURE) {
      throw new Error("CBZ 中央目录损坏");
    }
    const flags = readU16(bytes, offset + 8);
    const method = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("CBZ 使用了 ZIP64 格式，暂不支持");
    }

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw new Error("CBZ 中央目录损坏（文件名越界）");
    }
    entries.push({
      name: decodeName(bytes.subarray(nameStart, nameEnd)),
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localOffset
    });

    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** 中央目录里的图片条目（自然序，排除目录项）。 */
export function listZipImages(entries: ZipEntry[]): ZipEntry[] {
  return entries
    .filter((entry) => entry.name !== "" && !entry.name.endsWith("/") && isImageFile(entry.name))
    .sort((left, right) => naturalCompare(left.name, right.name));
}

/** 解压单个条目。支持 stored(0) 与 deflate(8)。 */
export function extractZipEntry(zipBytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if ((entry.flags & 1) !== 0) {
    throw new Error("CBZ 里的文件被加密了，暂不支持");
  }
  if (entry.localOffset + 30 > zipBytes.length) {
    throw new Error("CBZ 条目偏移损坏");
  }
  if (readU32(zipBytes, entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error("CBZ 条目头损坏");
  }
  const nameLength = readU16(zipBytes, entry.localOffset + 26);
  const extraLength = readU16(zipBytes, entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zipBytes.length) {
    throw new Error("CBZ 条目数据越界");
  }
  const compressed = zipBytes.subarray(dataStart, dataEnd);

  if (entry.method === 0) {
    return compressed.slice();
  }
  if (entry.method === 8) {
    if (entry.uncompressedSize > 0) {
      try {
        return inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) });
      } catch {
        // 有些包的中央目录尺寸不准，退回不定长解压。
      }
    }
    return inflateSync(compressed);
  }
  throw new Error("CBZ 使用了不支持的压缩方式：" + String(entry.method));
}
