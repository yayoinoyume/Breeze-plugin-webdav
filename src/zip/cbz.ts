/**
 * 最小 ZIP/CBZ 读取器：只解析中央目录，按需解压单个条目。
 *
 * 为什么不用 fflate 的 unzip()：整包解压会把所有页同时展开到内存。
 * 这里先用中央目录拿到页名与偏移，读某一页时只 inflate 这一个条目。
 *
 * 入口：
 * - 整包字节：readZipEntries / extractZipEntry
 * - 远程 Range（见 zip/remote-zip.ts）：parseEndRecord / readCentralDirectory /
 *   localDataStart / extractEntryFromData
 */

import { Inflate } from "fflate";
import { isImageFile, naturalCompare } from "../util/names.ts";

export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

/** EOCD 记录（中央目录尾部，22 字节固定部分）。 */
export type ZipEndRecord = {
  /** EOCD 在传入字节里的偏移。 */
  eocdOffset: number;
  entryCount: number;
  centralOffset: number;
  centralSize: number;
  commentLength: number;
};

export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 1000;
export const LOCAL_HEADER_BYTES = 30;
const INFLATE_INPUT_CHUNK = 8 * 1024;

export const EOCD_SIGNATURE = 0x06054b50;
export const CENTRAL_SIGNATURE = 0x02014b50;
export const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

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

/** 在字节尾部 22 + 65535 范围内回扫 EOCD；用于「已经拿到整包」的场景。 */
export function findEndOfCentralDirectory(bytes: Uint8Array): number {
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

/**
 * 解析 EOCD 记录并做 ZIP64 判定。
 *
 * bytes 可以是「文件尾部窗口」这样的片段，eocdOffset 是相对片段起点的偏移；
 * 因此这里不假设 bytes.length 等于整个文件长度。
 */
export function parseEndRecord(bytes: Uint8Array, eocdOffset: number): ZipEndRecord {
  if (eocdOffset < 0 || eocdOffset + 22 > bytes.length) {
    throw new Error("CBZ 文件不完整（中央目录尾部缺失）");
  }
  if (readU32(bytes, eocdOffset) !== EOCD_SIGNATURE) {
    throw new Error("这不是有效的 CBZ/ZIP 文件（找不到中央目录）");
  }
  const entryCount = readU16(bytes, eocdOffset + 10);
  const centralSize = readU32(bytes, eocdOffset + 12);
  const centralOffset = readU32(bytes, eocdOffset + 16);
  const commentLength = readU16(bytes, eocdOffset + 20);
  const locatorOffset = eocdOffset - 20;
  const hasZip64Locator =
    locatorOffset >= 0 && readU32(bytes, locatorOffset) === ZIP64_LOCATOR_SIGNATURE;
  if (
    hasZip64Locator ||
    centralOffset === 0xffffffff ||
    centralSize === 0xffffffff ||
    entryCount === 0xffff
  ) {
    throw new Error("CBZ 使用了 ZIP64 格式，暂不支持");
  }
  return { eocdOffset, entryCount, centralOffset, centralSize, commentLength };
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

/**
 * 解析中央目录条目。
 *
 * bytes 可以只是中央目录片段（远程路径），此时 centralOffset 传 0；
 * 也可以是整包字节，此时传 EOCD 里的中央目录偏移。
 */
export function readCentralDirectory(
  bytes: Uint8Array,
  centralOffset: number,
  entryCount: number
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || readU32(bytes, offset) !== CENTRAL_SIGNATURE) {
      throw new Error("CBZ 中央目录损坏");
    }
    const flags = readU16(bytes, offset + 8);
    const method = readU16(bytes, offset + 10);
    const crc = readU32(bytes, offset + 16);
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
      crc,
      compressedSize,
      uncompressedSize,
      localOffset
    });

    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** 读中央目录，返回所有条目（包括目录项）。 */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const record = parseEndRecord(bytes, eocd);
  return readCentralDirectory(bytes, record.centralOffset, record.entryCount);
}

/** 中央目录里的图片条目（自然序，排除目录项）。 */
export function listZipImages(entries: ZipEntry[]): ZipEntry[] {
  return entries
    .filter((entry) => entry.name !== "" && !entry.name.endsWith("/") && isImageFile(entry.name))
    .sort((left, right) => naturalCompare(left.name, right.name));
}

function assertEntryWithinLimits(entry: ZipEntry): void {
  if ((entry.flags & 1) !== 0) {
    throw new Error("CBZ 里的文件被加密了，暂不支持");
  }
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new Error(
      "CBZ 里的这一页解压后太大（超过 " + MAX_ENTRY_BYTES / (1024 * 1024) + " MiB），暂不支持"
    );
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
  ) {
    throw new Error("CBZ 压缩比异常（可能损坏或恶意包），已拒绝解压");
  }
}

let crcTable: Int32Array | null = null;

/** 标准 CRC-32（与 ZIP 中央目录里的 crc 字段一致）。 */
export function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function verifyCrc(entry: ZipEntry, bytes: Uint8Array): Uint8Array {
  const actual = crc32(bytes);
  if (actual !== (entry.crc >>> 0)) {
    throw new Error("CBZ 这一页的 CRC 校验失败（文件可能损坏）");
  }
  return bytes;
}

/**
 * 从本地头算出条目数据的绝对起点（30 字节固定头 + 文件名 + 扩展字段）。
 * header 只需包含本地头的前 30 字节。
 */
export function localDataStart(header: Uint8Array, entry: ZipEntry): number {
  if (header.length < LOCAL_HEADER_BYTES) {
    throw new Error("CBZ 条目头损坏");
  }
  if (readU32(header, 0) !== LOCAL_SIGNATURE) {
    throw new Error("CBZ 条目头损坏");
  }
  const nameLength = readU16(header, 26);
  const extraLength = readU16(header, 28);
  return entry.localOffset + LOCAL_HEADER_BYTES + nameLength + extraLength;
}

/** 解压单个条目的压缩数据（已跳过本地头）。支持 stored(0) 与 deflate(8)。 */
export function extractEntryFromData(entry: ZipEntry, compressed: Uint8Array): Uint8Array {
  assertEntryWithinLimits(entry);

  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new Error("CBZ 条目尺寸不一致（stored）");
    }
    if (compressed.length !== entry.compressedSize) {
      throw new Error("CBZ 条目数据越界");
    }
    return verifyCrc(entry, compressed.slice(0, entry.uncompressedSize));
  }
  if (entry.method === 8) {
    return verifyCrc(entry, inflateEntryWithLimit(compressed, entry.uncompressedSize));
  }
  throw new Error("CBZ 使用了不支持的压缩方式：" + String(entry.method));
}

/** 解压单个条目（整包字节版）。 */
export function extractZipEntry(zipBytes: Uint8Array, entry: ZipEntry): Uint8Array {
  assertEntryWithinLimits(entry);
  if (entry.localOffset + LOCAL_HEADER_BYTES > zipBytes.length) {
    throw new Error("CBZ 条目偏移损坏");
  }
  if (readU32(zipBytes, entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error("CBZ 条目头损坏");
  }
  const nameLength = readU16(zipBytes, entry.localOffset + 26);
  const extraLength = readU16(zipBytes, entry.localOffset + 28);
  const dataStart = entry.localOffset + LOCAL_HEADER_BYTES + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > zipBytes.length || dataEnd > zipBytes.length) {
    throw new Error("CBZ 条目数据越界");
  }
  return extractEntryFromData(entry, zipBytes.subarray(dataStart, dataEnd));
}

/**
 * 流式 inflate：边解边计数，超过上限或与中央目录声明不一致立刻停止。
 * 不信任中央目录的 uncompressedSize，也不用它预分配。
 */
function inflateEntryWithLimit(compressed: Uint8Array, declaredSize: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: Error | null = null;

  const stream = new Inflate((chunk) => {
    if (failure !== null || chunk.length === 0) {
      return;
    }
    total += chunk.length;
    if (total > MAX_ENTRY_BYTES) {
      failure = new Error(
        "CBZ 里的这一页解压后太大（超过 " + MAX_ENTRY_BYTES / (1024 * 1024) + " MiB），暂不支持"
      );
      return;
    }
    if (declaredSize > 0 && total > declaredSize) {
      failure = new Error("CBZ 解压长度与中央目录不一致");
      return;
    }
    chunks.push(chunk);
  });

  try {
    for (let offset = 0; offset < compressed.length; offset += INFLATE_INPUT_CHUNK) {
      const end = Math.min(offset + INFLATE_INPUT_CHUNK, compressed.length);
      stream.push(compressed.subarray(offset, end), end === compressed.length);
      if (failure !== null) {
        break;
      }
    }
  } catch {
    throw new Error("CBZ 解压失败（文件可能损坏）");
  }

  if (failure !== null) {
    throw failure;
  }
  if (declaredSize > 0 && total !== declaredSize) {
    throw new Error("CBZ 解压长度与中央目录不一致");
  }
  if (compressed.length > 0 && total / compressed.length > MAX_COMPRESSION_RATIO) {
    throw new Error("CBZ 压缩比异常（可能损坏或恶意包），已拒绝解压");
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
