// Pure helpers for Gmail API message payloads (users.messages.get with
// format=full). No network or DB — unit-tested in test/consolidation-mime.

export interface GmailPartLike {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
  parts?: GmailPartLike[] | null;
}

export interface AttachmentRef {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

// A body part Gmail stored out of line (large bodies come back with an
// attachmentId instead of inline data); fetch it with attachments.get and
// decode it with decodeBody(data, charset).
export interface ExternalBody {
  attachmentId: string;
  charset: string | null;
}

export interface ExtractedBodies {
  text: string | null;
  html: string | null;
  // Set instead of text/html when that body must be fetched separately.
  textExternal: ExternalBody | null;
  htmlExternal: ExternalBody | null;
  // Charsets that weren't recognised and fell back to UTF-8.
  unknownCharsets: string[];
  attachments: AttachmentRef[];
}

export function header(
  headers: GmailPartLike["headers"],
  name: string
): string | null {
  const h = (headers ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

export function charsetOf(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1].toLowerCase() : null;
}

// Bumped whenever decodeBody reads some bytes differently: a staged
// message decoded by an older version that looks garbled is fetched again
// (staging.garbledGmailMessages).
export const DECODER_VERSION = 2;

// Labels old Hong Kong mail used that TextDecoder does not know; WHATWG's
// big5 is Big5-HKSCS. A Map, so a label named like an Object property is a
// label like any other.
const CHARSET_ALIASES = new Map([
  ["x-big5", "big5"],
  ["big5hkscs", "big5"],
  ["hkscs", "big5"],
  ["ms950", "big5"],
  ["cp950", "big5"],
  ["windows-950", "big5"],
  ["x-ms950", "big5"],
  ["cp936", "gbk"],
  ["ms936", "gbk"],
  ["windows-936", "gbk"],
]);

// What bytes with no usable label, or a label they don't fit, are tried as.
const FALLBACKS = ["utf-8", "big5", "gb18030"];

function decodeAs(label: string, bytes: Uint8Array, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

function known(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

// A charset an HTML body declares for itself, for a part whose header
// names none.
function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Most of its non-ASCII text is Chinese: Big5 rather than the Latin-1 a
// part claimed.
function mostlyHan(text: string): boolean {
  const nonAscii = text.match(/[^\x00-\x7f]/gu) ?? [];
  const han = text.match(/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/gu) ?? [];
  return han.length >= 4 && han.length >= 0.8 * nonAscii.length;
}

// Gmail returns part bodies as base64url of the (transfer-decoded) bytes,
// still in the part's own charset; old Hong Kong mail is often Big5, and
// often labelled with a name TextDecoder does not know, labelled wrongly,
// or not labelled at all. So: the label (or an alias of it, or a charset
// the HTML declares), as long as the bytes are valid in it; else the first
// of UTF-8, Big5 and GB18030 they are valid in. Bytes labelled Latin-1 that
// read as Chinese in Big5 are Big5. Labels not known are listed in
// `unknown`.
export function decodeBody(
  data: string,
  charset: string | null,
  unknown: string[] = []
): string {
  const bytes = Buffer.from(data, "base64url");
  let label = charset ?? metaCharset(bytes);
  if (label) label = CHARSET_ALIASES.get(label) ?? label;
  if (label && !known(label)) {
    if (!unknown.includes(label)) unknown.push(label);
    label = null;
  }
  if (label) {
    const text = decodeAs(label, bytes, true);
    if (text !== null) {
      if (new TextDecoder(label).encoding === "windows-1252" && bytes.some((b) => b >= 0x80)) {
        const big5 = decodeAs("big5", bytes, true);
        if (big5 !== null && mostlyHan(big5)) return big5;
      }
      return text;
    }
  }
  for (const fallback of FALLBACKS) {
    const text = decodeAs(fallback, bytes, true);
    if (text !== null) return text;
  }
  return new TextDecoder(label ?? "utf-8").decode(bytes);
}

// Walk the MIME tree: the first text/plain and text/html bodies win
// (multipart/alternative lists plain before html; forwarded messages nest
// further down and are kept in the quoted text, not picked separately).
// A winning body Gmail stored out of line is returned as textExternal /
// htmlExternal for the caller to fetch; a later part never replaces it.
// Parts with a filename are attachments, never bodies.
export function extractBodies(payload: GmailPartLike | null | undefined): ExtractedBodies {
  const out: ExtractedBodies = {
    text: null,
    html: null,
    textExternal: null,
    htmlExternal: null,
    unknownCharsets: [],
    attachments: [],
  };
  const walk = (part: GmailPartLike) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    const filename = part.filename ?? "";
    if (filename) {
      if (part.body?.attachmentId) {
        out.attachments.push({
          partId: part.partId ?? "",
          filename,
          mimeType: mime,
          size: part.body.size ?? 0,
          attachmentId: part.body.attachmentId,
        });
      }
      return;
    }
    if (mime === "text/plain" || mime === "text/html") {
      const isText = mime === "text/plain";
      const claimed = isText
        ? out.text !== null || out.textExternal !== null
        : out.html !== null || out.htmlExternal !== null;
      const data = part.body?.data;
      const attachmentId = part.body?.attachmentId;
      if (!claimed && (data || attachmentId)) {
        const charset = charsetOf(header(part.headers, "content-type"));
        if (data) {
          const decoded = decodeBody(data, charset, out.unknownCharsets);
          if (isText) out.text = decoded;
          else out.html = decoded;
        } else if (attachmentId) {
          if (isText) out.textExternal = { attachmentId, charset };
          else out.htmlExternal = { attachmentId, charset };
        }
      }
    }
    for (const child of part.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return out;
}

export function splitAddresses(value: string | null): string[] {
  if (!value) return [];
  // Commas inside quoted display names ("Lee, Simon" <a@b>) don't split.
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Attachments whose text is worth extracting as a candidate copy.
export function isDocxAttachment(a: Pick<AttachmentRef, "filename" | "mimeType">): boolean {
  return (
    a.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(a.filename)
  );
}
