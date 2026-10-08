// Step 2 for the export sources: WordPress and Substack posts as published,
// and Drive documents as they are.

import { candidate, type Candidate, type StagedItem } from "./types";
import { htmlToText, normalizeText, textLength, utcDate } from "./text";
import { detectColumn } from "./gmail";

const MIN_TEXT = 50;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function extractWordPress(item: StagedItem): Candidate {
  const m = item.metadata;
  const status = str(m.status) ?? "unknown";
  const postType = str(m.postType) ?? "post";
  const site = host(str(m.site));
  const body = htmlToText(item.rawHtml ?? item.rawText ?? "", { keepSourceNewlines: true });
  const base = {
    title: item.title,
    outlet: site ? `WordPress (${site})` : "WordPress",
    column: detectColumn(item.title)?.name ?? null,
    publishedAt: item.authoredAt,
    dateSource: "export",
    bodyText: body || null,
  };
  if (textLength(body) < MIN_TEXT) return candidate({ ...base, kind: "empty", status: "drop", reasons: ["no-text"] });
  if (status !== "publish" && status !== "private") {
    return candidate({ ...base, kind: "draft", status: "drop", isPublished: false, reasons: [`status-${status}`] });
  }
  if (postType === "page") {
    return candidate({ ...base, kind: "page", status: "review", isPublished: status === "publish", reasons: ["wordpress-page"] });
  }
  if (status === "private") {
    return candidate({ ...base, kind: "post", status: "review", isPublished: false, reasons: ["status-private"] });
  }
  return candidate({ ...base, kind: "post", status: "keep", isPublished: true });
}

export function extractSubstack(item: StagedItem): Candidate {
  const m = item.metadata;
  const body = htmlToText(item.rawHtml ?? item.rawText ?? "");
  const audience = str(m.audience);
  const base = {
    title: item.title,
    outlet: "Substack",
    column: detectColumn(item.title)?.name ?? null,
    publishedAt: item.authoredAt,
    dateSource: "export",
    bodyText: body || null,
    reasons: audience && audience !== "everyone" ? [`audience-${audience}`] : [],
  };
  if (textLength(body) < MIN_TEXT) return candidate({ ...base, kind: "empty", status: "drop", reasons: [...base.reasons, "no-text"] });
  if (m.isPublished !== true) {
    return candidate({ ...base, kind: "draft", status: "drop", isPublished: false, reasons: [...base.reasons, "not-published"] });
  }
  return candidate({ ...base, kind: "post", status: "keep", isPublished: true });
}

// "利字當頭 20190730.docx", "2019-07-30 …": a date in the file name is
// usually the piece's own date, better than when the file was created. A
// day that doesn't exist ("20230231") is a typo, not a date.
export function titleDate(title: string | null): Date | null {
  const m = (title ?? "").match(/(?<!\d)((?:19|20)\d{2})[\-./\s]?(\d{2})[\-./\s]?(\d{2})(?!\d)/);
  return m ? utcDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

export function extractDrive(item: StagedItem): Candidate {
  const title = (item.title ?? "").replace(/\.docx$/i, "").trim() || null;
  const body = normalizeText(item.rawText ?? (item.rawHtml ? htmlToText(item.rawHtml) : ""));
  const fromTitle = titleDate(title);
  const column = detectColumn(title, str(item.metadata.path));
  const base = {
    title,
    outlet: column?.outlet ?? null,
    column: column?.name ?? null,
    publishedAt: fromTitle ?? item.authoredAt,
    dateSource: fromTitle ? "title" : "file-created",
    bodyText: body || null,
  };
  if (textLength(body) < MIN_TEXT) return candidate({ ...base, kind: "empty", status: "drop", reasons: ["no-text"] });
  return candidate({ ...base, kind: "doc", status: "keep" });
}
