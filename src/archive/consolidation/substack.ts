// Substack export zips: posts.csv + posts/<post_id>.html. The zip also
// holds subscriber lists (email addresses); only post files are ever
// opened — everything else is skipped by name before it is read.

import { parse } from "csv-parse/sync";
import yauzl from "yauzl";

export interface SubstackPost {
  // Numeric part of post_id ("123456789.my-slug" → "123456789").
  postId: string;
  fullPostId: string;
  title: string;
  subtitle: string | null;
  postDate: Date | null;
  isPublished: boolean | null;
  type: string | null;
  audience: string | null;
  emailSentAt: Date | null;
  html: string;
}

export interface SubstackExport {
  posts: SubstackPost[];
  // CSV rows with no matching HTML file, and HTML files with no CSV row.
  missingHtml: string[];
  orphanHtml: string[];
}

const POSTS_CSV = /(^|\/)posts\.csv$/;
const POST_HTML = /(^|\/)posts\/([^/]+)\.html$/;

export function isWantedSubstackEntry(name: string): boolean {
  return POSTS_CSV.test(name) || POST_HTML.test(name);
}

function date(v: string | undefined): Date | null {
  if (!v || !v.trim()) return null;
  const d = new Date(v.trim());
  return isNaN(d.getTime()) ? null : d;
}

function bool(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const s = v.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}

function opt(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length > 0 ? s : null;
}

// entries: zip entry name → file contents (only wanted entries).
export function buildSubstackExport(entries: Map<string, Buffer>): SubstackExport {
  let csvText: string | null = null;
  const htmlById = new Map<string, string>();
  for (const [name, buf] of entries) {
    if (POSTS_CSV.test(name)) csvText = buf.toString("utf8");
    const m = name.match(POST_HTML);
    if (m) htmlById.set(m[2], buf.toString("utf8"));
  }
  if (csvText === null) throw new Error("not a Substack export: posts.csv not found");

  const rows = parse(csvText, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const out: SubstackExport = { posts: [], missingHtml: [], orphanHtml: [] };
  const used = new Set<string>();
  for (const row of rows) {
    const fullPostId = opt(row.post_id);
    if (!fullPostId) continue;
    const html = htmlById.get(fullPostId);
    if (html === undefined) {
      out.missingHtml.push(fullPostId);
      continue;
    }
    used.add(fullPostId);
    out.posts.push({
      postId: fullPostId.split(".")[0],
      fullPostId,
      title: opt(row.title) ?? "",
      subtitle: opt(row.subtitle),
      postDate: date(row.post_date),
      isPublished: bool(row.is_published),
      type: opt(row.type),
      audience: opt(row.audience),
      emailSentAt: date(row.email_sent_at),
      html,
    });
  }
  for (const id of htmlById.keys()) if (!used.has(id)) out.orphanHtml.push(id);
  return out;
}

// Read only the entries `want` accepts from a zip on disk. The zip is read
// lazily, so a large export (mostly images) never sits in memory.
export function readZipEntries(
  path: string,
  want: (name: string) => boolean
): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("could not open zip"));
      const out = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(out));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/") || !want(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error(`could not read ${entry.fileName}`));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", reject);
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
