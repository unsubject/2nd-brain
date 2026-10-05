// Collect the Drive archive folders into archive_source_item, verbatim.
//   Google Docs      → exported as text/plain + text/html (source 'gdrive')
//   .docx            → text + html via mammoth (source 'gdrive')
//   WordPress *.xml  → one row per post/page (source 'wordpress')
//   Substack *.zip   → one row per post (source 'substack')
// Needs the drive.readonly scope (re-authorise at /auth/google once).

import { createWriteStream } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import { google } from "googleapis";
import mammoth from "mammoth";
import { pool } from "../../db/client";
import { getAuthenticatedClient } from "../../google/auth";
import { count, recordError, type CollectStats } from "./gmail";
import { RateLimiter } from "./ratelimit";
import { upsertSourceItem } from "./staging";
import { buildSubstackExport, isWantedSubstackEntry, readZipEntries } from "./substack";
import { parseWxr } from "./wxr";

type Drive = ReturnType<typeof google.drive>;

export interface DriveCollectParams {
  folderIds: string[];
  refetch?: boolean;
}

export interface DriveStats extends CollectStats {
  files: number;
  skippedUnchanged: number;
  skippedByType: Record<string, number>;
  wordpressPosts: number;
  substackPosts: number;
  exportNotes: string[];
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string | null;
  modifiedTime: string | null;
  size: string | null;
  parentId: string;
  path: string;
}

const GDOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function emptyDriveStats(): DriveStats {
  return {
    listed: 0,
    skippedExisting: 0,
    retriedIncomplete: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    attachmentsExtracted: 0,
    rateLimitPauses: 0,
    failed: 0,
    errors: [],
    files: 0,
    skippedUnchanged: 0,
    skippedByType: {},
    wordpressPosts: 0,
    substackPosts: 0,
    exportNotes: [],
  };
}

export function isScopeError(err: unknown): boolean {
  const e = err as { code?: number; message?: string; errors?: { reason?: string }[] };
  return (
    e?.code === 403 &&
    (/insufficient/i.test(e.message ?? "") ||
      (e.errors ?? []).some((x) => /insufficientPermissions/i.test(x.reason ?? "")))
  );
}

async function listTree(drive: Drive, rootIds: string[]): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const seen = new Set<string>();
  const queue: { id: string; path: string }[] = [];
  for (const id of rootIds) {
    const { data } = await drive.files.get({ fileId: id, fields: "id,name", supportsAllDrives: true });
    queue.push({ id, path: data.name ?? id });
  }
  while (queue.length > 0) {
    const folder = queue.shift()!;
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    let pageToken: string | undefined;
    do {
      const { data } = await drive.files.list({
        q: `'${folder.id}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of data.files ?? []) {
        if (!f.id || !f.mimeType) continue;
        const path = `${folder.path}/${f.name ?? f.id}`;
        if (f.mimeType === FOLDER) {
          queue.push({ id: f.id, path });
          continue;
        }
        files.push({
          id: f.id,
          name: f.name ?? "",
          mimeType: f.mimeType,
          createdTime: f.createdTime ?? null,
          modifiedTime: f.modifiedTime ?? null,
          size: f.size ?? null,
          parentId: folder.id,
          path,
        });
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  return files;
}

async function exportText(drive: Drive, fileId: string, mimeType: string): Promise<string> {
  const res = await drive.files.export({ fileId, mimeType }, { responseType: "text" });
  return String(res.data);
}

async function download(drive: Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

async function downloadToTemp(drive: Drive, fileId: string, dir: string): Promise<string> {
  const path = join(dir, `${fileId}.zip`);
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );
  await pipeline(res.data as Readable, createWriteStream(path));
  return path;
}

function fileMetadata(f: DriveFile, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: f.name,
    mimeType: f.mimeType,
    path: f.path,
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    size: f.size,
    ...extra,
  };
}

async function collectGoogleDoc(drive: Drive, f: DriveFile, stats: DriveStats): Promise<void> {
  const [text, html] = await Promise.all([
    exportText(drive, f.id, "text/plain"),
    exportText(drive, f.id, "text/html"),
  ]);
  count(
    stats,
    await upsertSourceItem({
      source: "gdrive",
      sourceRef: f.id,
      containerRef: f.parentId,
      title: f.name,
      authoredAt: f.createdTime ? new Date(f.createdTime) : null,
      rawText: text,
      rawHtml: html,
      metadata: fileMetadata(f, { format: "gdoc" }),
    })
  );
}

async function collectDocx(drive: Drive, f: DriveFile, stats: DriveStats): Promise<void> {
  const buffer = await download(drive, f.id);
  const [{ value: text }, { value: html }] = await Promise.all([
    mammoth.extractRawText({ buffer }),
    mammoth.convertToHtml({ buffer }),
  ]);
  count(
    stats,
    await upsertSourceItem({
      source: "gdrive",
      sourceRef: f.id,
      containerRef: f.parentId,
      title: f.name,
      authoredAt: f.createdTime ? new Date(f.createdTime) : null,
      rawText: text,
      rawHtml: html,
      metadata: fileMetadata(f, { format: "docx" }),
    })
  );
}

async function collectWordPress(drive: Drive, f: DriveFile, stats: DriveStats): Promise<boolean> {
  const xml = (await download(drive, f.id)).toString("utf8");
  if (!/<rss[\s>]/.test(xml) || !/wordpress\.org\/export/.test(xml)) return false;
  const wxr = parseWxr(xml);
  let host = "wordpress";
  try {
    if (wxr.siteLink) host = new URL(wxr.siteLink).host || host;
  } catch {
    // Keep the generic prefix; post ids are still unique within one site.
  }
  for (const p of wxr.posts) {
    const ref = `${host}:${p.postId}`;
    try {
      count(
        stats,
        await upsertSourceItem({
          source: "wordpress",
          sourceRef: ref,
          containerRef: f.id,
          title: p.title,
          authoredAt: p.publishedAt,
          rawText: null,
          rawHtml: p.contentHtml,
          metadata: {
            site: wxr.siteLink,
            postId: p.postId,
            postType: p.postType,
            status: p.status,
            slug: p.slug,
            link: p.link,
            guid: p.guid,
            creator: p.creator,
            dateSource: p.dateSource,
            excerpt: p.excerpt,
            categories: p.categories,
            tags: p.tags,
            exportFile: f.name,
          },
        })
      );
      stats.wordpressPosts += 1;
    } catch (err) {
      recordError(stats, ref, err);
    }
  }
  stats.exportNotes.push(
    `${f.name}: ${wxr.posts.length} posts/pages kept, skipped ${JSON.stringify(wxr.skipped)}`
  );
  return true;
}

async function collectSubstack(drive: Drive, f: DriveFile, stats: DriveStats): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "substack-"));
  try {
    const path = await downloadToTemp(drive, f.id, dir);
    const entries = await readZipEntries(path, isWantedSubstackEntry);
    if (![...entries.keys()].some((n) => /(^|\/)posts\.csv$/.test(n))) return false;
    const exp = buildSubstackExport(entries);
    for (const p of exp.posts) {
      try {
        count(
          stats,
          await upsertSourceItem({
            source: "substack",
            sourceRef: p.postId,
            containerRef: f.id,
            title: p.title,
            authoredAt: p.postDate,
            rawText: null,
            rawHtml: p.html,
            metadata: {
              fullPostId: p.fullPostId,
              subtitle: p.subtitle,
              isPublished: p.isPublished,
              type: p.type,
              audience: p.audience,
              emailSentAt: p.emailSentAt,
              exportFile: f.name,
            },
          })
        );
        stats.substackPosts += 1;
      } catch (err) {
        recordError(stats, `substack:${p.postId}`, err);
      }
    }
    stats.exportNotes.push(
      `${f.name}: ${exp.posts.length} posts; ${exp.missingHtml.length} CSV rows without HTML; ` +
        `${exp.orphanHtml.length} HTML files without a CSV row`
    );
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type OrderedFile = Pick<DriveFile, "name" | "mimeType" | "createdTime" | "modifiedTime">;

function isXmlFile(f: OrderedFile): boolean {
  return f.mimeType === "text/xml" || f.mimeType === "application/xml" || /\.xml$/i.test(f.name);
}

function isZipFile(f: OrderedFile): boolean {
  return f.mimeType === "application/zip" || /\.zip$/i.test(f.name);
}

// Posts from different export snapshots share source refs, so each one
// overwrites the last. Read exports after everything else, oldest first
// by Drive modifiedTime, so the newest snapshot is the one left staged.
export function collectionOrder<T extends OrderedFile>(files: T[]): T[] {
  const isExport = (f: T) => f.mimeType !== GDOC && f.mimeType !== DOCX && (isXmlFile(f) || isZipFile(f));
  // RFC 3339 UTC strings from Drive sort correctly as plain strings.
  const time = (f: T) => f.modifiedTime ?? f.createdTime ?? "";
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const exports = files
    .filter(isExport)
    .sort((a, b) => cmp(time(a), time(b)) || cmp(a.name, b.name));
  return [...files.filter((f) => !isExport(f)), ...exports];
}

// Drive files whose modifiedTime matches the staged copy are skipped.
// Exports (xml/zip) fan out into many rows, so they are always re-read.
async function stagedModifiedTimes(): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ source_ref: string; modified: string | null }>(
    `SELECT source_ref, metadata->>'modifiedTime' AS modified FROM archive_source_item WHERE source = 'gdrive'`
  );
  return new Map(rows.filter((r) => r.modified).map((r) => [r.source_ref, r.modified!]));
}

export async function collectDrive(
  params: DriveCollectParams,
  stats: DriveStats,
  onProgress: () => Promise<void>
): Promise<void> {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  // Files are read one at a time, so no pacing until Drive reports a limit;
  // then the file is retried after a pause (an export file is re-read whole,
  // which is safe: every write is an idempotent upsert).
  const limiter = new RateLimiter({
    minIntervalMs: 0,
    maxIntervalMs: 1_000,
    retries: 6,
    basePauseMs: 15_000,
    maxPauseMs: 120_000,
    onLimited: () => {
      stats.rateLimitPauses += 1;
      void onProgress();
    },
  });

  let files: DriveFile[];
  try {
    files = await limiter.run(() => listTree(drive, params.folderIds));
  } catch (err) {
    if (isScopeError(err)) {
      throw new Error("Google Drive access not granted yet: re-authorise once at /auth/google");
    }
    throw err;
  }
  stats.files = files.length;
  stats.listed = files.length;
  const staged = params.refetch ? new Map<string, string>() : await stagedModifiedTimes();

  let done = 0;
  for (const f of collectionOrder(files)) {
    try {
      const isXml = isXmlFile(f);
      const isZip = isZipFile(f);
      if (f.mimeType === GDOC || f.mimeType === DOCX) {
        if (f.modifiedTime && staged.get(f.id) === f.modifiedTime) {
          stats.skippedUnchanged += 1;
        } else if (f.mimeType === GDOC) {
          await limiter.run(() => collectGoogleDoc(drive, f, stats));
        } else {
          await limiter.run(() => collectDocx(drive, f, stats));
        }
      } else if (isXml) {
        if (!(await limiter.run(() => collectWordPress(drive, f, stats)))) {
          stats.skippedByType["xml (not a WordPress export)"] =
            (stats.skippedByType["xml (not a WordPress export)"] ?? 0) + 1;
        }
      } else if (isZip) {
        if (!(await limiter.run(() => collectSubstack(drive, f, stats)))) {
          stats.skippedByType["zip (not a Substack export)"] =
            (stats.skippedByType["zip (not a Substack export)"] ?? 0) + 1;
        }
      } else {
        stats.skippedByType[f.mimeType] = (stats.skippedByType[f.mimeType] ?? 0) + 1;
      }
    } catch (err) {
      recordError(stats, `${f.path} (${f.id})`, err);
    }
    if (++done % 25 === 0) await onProgress();
  }
}
