import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import * as archiveQueries from "../queries";

interface NotionPage {
  title: string;
  externalId: string;
  markdown: string;
  properties: Record<string, string>;
}

// Notion filenames: "Page Title <32-hex-uuid>.md"
const NOTION_ID_REGEX = /\s([0-9a-f]{32})\.md$/i;

function extractNotionId(filename: string): string | null {
  const match = filename.match(NOTION_ID_REGEX);
  return match ? match[1] : null;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function inferType(properties: Record<string, string>): string {
  const type = (properties["Type"] || properties["type"] || "").toLowerCase();
  if (type.includes("essay")) return "essay";
  if (type.includes("newsletter")) return "newsletter";
  if (type.includes("transcript")) return "transcript";
  if (type.includes("chapter")) return "book_chapter";
  return "article";
}

function parseTags(properties: Record<string, string>): string[] | null {
  const raw = properties["Tags"] || properties["tags"] || "";
  if (!raw.trim()) return null;
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function parseDate(properties: Record<string, string>): Date | null {
  const raw =
    properties["Published"] ||
    properties["published"] ||
    properties["Date"] ||
    properties["date"] ||
    properties["Created"] ||
    "";
  if (!raw.trim()) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// Notion rich_text property limit is ~2000 chars. If a Cleaned Body is at
// or near that length, assume Notion truncated it and fall back to the page body.
const NOTION_PROPERTY_TRUNCATION_THRESHOLD = 1900;

function getCleanedBody(properties: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(properties)) {
    if (key.toLowerCase().replace(/\s+/g, "") === "cleanedbody") {
      const trimmed = value?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

export function pickBody(
  pageBody: string,
  cleanedBody: string | null
): { source: "cleaned_body" | "page_body"; text: string } {
  if (!cleanedBody) return { source: "page_body", text: pageBody };
  if (cleanedBody.length >= NOTION_PROPERTY_TRUNCATION_THRESHOLD) {
    return { source: "page_body", text: pageBody };
  }
  return { source: "cleaned_body", text: cleanedBody };
}

function parseCsvProperties(
  csvContent: string
): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  try {
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as Record<string, string>[];

    for (const record of records) {
      const title = record["Name"] || record["Title"] || record["name"] || "";
      if (title) {
        map.set(title.trim(), record);
      }
    }
  } catch {
    // CSV parsing failed — proceed without properties
  }
  return map;
}

function parsePages(zip: AdmZip): NotionPage[] {
  const entries = zip.getEntries();
  const pages: NotionPage[] = [];

  // Find CSV for database properties
  let propertiesMap = new Map<string, Record<string, string>>();
  for (const entry of entries) {
    if (entry.entryName.endsWith(".csv") && !entry.isDirectory) {
      const csv = entry.getData().toString("utf-8");
      propertiesMap = parseCsvProperties(csv);
      break;
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.endsWith(".md")) continue;

    const filename = entry.entryName.split("/").pop() || entry.entryName;
    const externalId = extractNotionId(filename);
    if (!externalId) continue;

    const markdown = entry.getData().toString("utf-8");
    if (!markdown.trim()) continue;

    // Title: strip the UUID suffix and extension
    const title = filename
      .replace(/\s[0-9a-f]{32}\.md$/i, "")
      .replace(/\.md$/, "")
      .trim();

    if (!title) continue;

    const properties = propertiesMap.get(title) || {};
    pages.push({ title, externalId, markdown, properties });
  }

  return pages;
}

export async function importNotionExport(
  zipBuffer: Buffer,
  userId: string = "default"
): Promise<{
  imported: number;
  skipped: number;
  total: number;
  bodySource: { cleaned_body: number; page_body: number };
}> {
  const zip = new AdmZip(zipBuffer);
  const pages = parsePages(zip);
  let imported = 0;
  let skipped = 0;
  const bodySource = { cleaned_body: 0, page_body: 0 };

  for (const page of pages) {
    const cleaned = getCleanedBody(page.properties);
    const picked = pickBody(page.markdown, cleaned);
    bodySource[picked.source]++;

    console.log(
      `[archive] "${page.title}" → ${picked.source} (${picked.text.length} chars${
        cleaned ? `, cleaned=${cleaned.length}, page=${page.markdown.length}` : ""
      })`
    );

    const result = await archiveQueries.upsertArtifact({
      userId,
      type: inferType(page.properties),
      title: page.title,
      slug: slugify(page.title),
      publishedAt: parseDate(page.properties),
      rawSource: picked.text,
      canonicalUrl:
        page.properties["URL"] || page.properties["url"] || null,
      series: page.properties["Series"] || page.properties["series"] || null,
      seriesPosition: null,
      tags: parseTags(page.properties),
      sourceSystem: "notion",
      sourceExternalId: page.externalId,
    });

    if (result.created) {
      imported++;
    } else {
      skipped++;
    }
  }

  return { imported, skipped, total: pages.length, bodySource };
}
