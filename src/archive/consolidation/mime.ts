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

export interface ExtractedBodies {
  text: string | null;
  html: string | null;
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

// Gmail returns part bodies as base64url of the (transfer-decoded) bytes,
// still in the part's own charset — old Hong Kong mail is often Big5.
export function decodeBody(
  data: string,
  charset: string | null,
  unknown: string[] = []
): string {
  const bytes = Buffer.from(data, "base64url");
  const label = charset ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    if (!unknown.includes(label)) unknown.push(label);
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

// Walk the MIME tree: the first inline text/plain and text/html bodies win
// (multipart/alternative lists plain before html; forwarded messages nest
// further down and are kept in the quoted text, not picked separately).
// Parts with a filename are attachments, never bodies.
export function extractBodies(payload: GmailPartLike | null | undefined): ExtractedBodies {
  const out: ExtractedBodies = { text: null, html: null, unknownCharsets: [], attachments: [] };
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
      const data = part.body?.data;
      if (data) {
        const charset = charsetOf(header(part.headers, "content-type"));
        const decoded = decodeBody(data, charset, out.unknownCharsets);
        if (mime === "text/plain" && out.text === null) out.text = decoded;
        if (mime === "text/html" && out.html === null) out.html = decoded;
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
