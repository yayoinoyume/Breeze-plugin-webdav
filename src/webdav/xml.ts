/**
 * 手写 DAV multistatus 解析器（QuickJS 没有 DOMParser）。
 *
 * 只取后续业务需要的四个字段：href / 是否集合 / 内容长度 / 修改时间。
 * 命名空间前缀不固定（D: / d: / 无前缀默认命名空间），一律按本地名匹配。
 */

export type DavEntry = {
  /** 服务器返回的原始 href（可能是绝对 URL，也可能是已百分号编码的路径）。 */
  href: string;
  isCollection: boolean;
  contentLength: number | null;
  lastModified: string | null;
};

const RESPONSE_RE = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readTagText(source: string, localName: string): string | null {
  const name = escapeRegExp(localName);
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`,
    "i"
  );
  const matched = re.exec(source);
  return matched ? matched[1] : null;
}

function hasTag(source: string, localName: string): boolean {
  const name = escapeRegExp(localName);
  return new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?\\/?>`, "i").test(source);
}

function codePointToString(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

/** 还原 XML 实体，包括十进制与十六进制数字实体。 */
export function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    if (entity.startsWith("#x")) return codePointToString(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return codePointToString(Number.parseInt(entity.slice(1), 10));
    return whole;
  });
}

/** 解析 207 Multi-Status 响应文本。 */
export function parseMultistatus(xml: string): DavEntry[] {
  if (typeof xml !== "string" || xml.length === 0) {
    return [];
  }

  const cleaned = xml
    .replace(/^\uFEFF/, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const entries: DavEntry[] = [];
  RESPONSE_RE.lastIndex = 0;

  let matched: RegExpExecArray | null = RESPONSE_RE.exec(cleaned);
  while (matched !== null) {
    const block = matched[1];
    const hrefText = readTagText(block, "href");
    const href = hrefText === null ? "" : decodeXmlEntities(hrefText).trim();

    if (href !== "") {
      const lengthText = readTagText(block, "getcontentlength");
      const lastModifiedText = readTagText(block, "getlastmodified");
      const parsedLength = lengthText === null ? Number.NaN : Number(lengthText.trim());

      entries.push({
        href,
        isCollection: hasTag(block, "collection"),
        contentLength:
          lengthText !== null && Number.isFinite(parsedLength)
            ? Math.trunc(parsedLength)
            : null,
        lastModified:
          lastModifiedText === null
            ? null
            : decodeXmlEntities(lastModifiedText).trim() || null
      });
    }

    matched = RESPONSE_RE.exec(cleaned);
  }

  return entries;
}
