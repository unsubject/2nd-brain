import { Client, isFullBlock, isFullPage } from "@notionhq/client";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import * as archiveQueries from "../queries";
import { pickBody } from "./notion-export";

const API_THROTTLE_MS = 350; // stay under Notion's 3 req/sec average

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function richTextToMarkdown(rt: RichTextItemResponse[]): string {
  return rt
    .map((item) => {
      let text = item.plain_text;
      const a = item.annotations;
      if (a.code) text = `\`${text}\``;
      if (a.bold) text = `**${text}**`;
      if (a.italic) text = `*${text}*`;
      if (a.strikethrough) text = `~~${text}~~`;
      if (item.href) text = `[${text}](${item.href})`;
      return text;
    })
    .join("");
}

function indent(text: string, spaces: number = 2): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function blockToMarkdown(
  block: BlockObjectResponse,
  childrenMd: string
): string {
  switch (block.type) {
    case "paragraph":
      return (
        richTextToMarkdown(block.paragraph.rich_text) +
        (childrenMd ? "\n" + childrenMd : "")
      );
    case "heading_1":
      return `# ${richTextToMarkdown(block.heading_1.rich_text)}`;
    case "heading_2":
      return `## ${richTextToMarkdown(block.heading_2.rich_text)}`;
    case "heading_3":
      return `### ${richTextToMarkdown(block.heading_3.rich_text)}`;
    case "bulleted_list_item":
      return (
        `- ${richTextToMarkdown(block.bulleted_list_item.rich_text)}` +
        (childrenMd ? "\n" + indent(childrenMd) : "")
      );
    case "numbered_list_item":
      return (
        `1. ${richTextToMarkdown(block.numbered_list_item.rich_text)}` +
        (childrenMd ? "\n" + indent(childrenMd) : "")
      );
    case "to_do": {
      const mark = block.to_do.checked ? "x" : " ";
      return (
        `- [${mark}] ${richTextToMarkdown(block.to_do.rich_text)}` +
        (childrenMd ? "\n" + indent(childrenMd) : "")
      );
    }
    case "quote":
      return `> ${richTextToMarkdown(block.quote.rich_text)}`;
    case "callout":
      return `> ${richTextToMarkdown(block.callout.rich_text)}`;
    case "toggle":
      return (
        `${richTextToMarkdown(block.toggle.rich_text)}` +
        (childrenMd ? "\n\n" + childrenMd : "")
      );
    case "code": {
      const lang = block.code.language || "";
      return `\`\`\`${lang}\n${richTextToMarkdown(block.code.rich_text)}\n\`\`\``;
    }
    case "divider":
      return "---";
    case "bookmark":
      return block.bookmark.url ? `[${block.bookmark.url}](${block.bookmark.url})` : "";
    case "image":
      if (block.image.type === "external") return `![](${block.image.external.url})`;
      if (block.image.type === "file") return `![](${block.image.file.url})`;
      return "";
    case "embed":
      return block.embed.url ? `[${block.embed.url}](${block.embed.url})` : "";
    case "equation":
      return `$$${block.equation.expression}$$`;
    default:
      return childrenMd || "";
  }
}

async function fetchBlocksAsMarkdown(
  notion: Client,
  blockId: string
): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    await sleep(API_THROTTLE_MS);

    for (const block of response.results) {
      if (!isFullBlock(block)) continue;

      let childrenMd = "";
      if (block.has_children) {
        childrenMd = await fetchBlocksAsMarkdown(notion, block.id);
      }

      const md = blockToMarkdown(block, childrenMd);
      if (md.trim()) lines.push(md);
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return lines.join("\n\n");
}

// --- Property extractors ---

function findProperty(
  page: PageObjectResponse,
  name: string
): PageObjectResponse["properties"][string] | null {
  const lower = name.toLowerCase().replace(/\s+/g, "");
  for (const [key, value] of Object.entries(page.properties)) {
    if (key.toLowerCase().replace(/\s+/g, "") === lower) return value;
  }
  return null;
}

function getTitle(page: PageObjectResponse): string {
  for (const value of Object.values(page.properties)) {
    if (value.type === "title") {
      return value.title.map((t) => t.plain_text).join("").trim();
    }
  }
  return "";
}

function getRichTextProperty(
  page: PageObjectResponse,
  name: string
): string | null {
  const prop = findProperty(page, name);
  if (!prop || prop.type !== "rich_text") return null;
  const text = prop.rich_text.map((t) => t.plain_text).join("");
  return text.trim().length > 0 ? text : null;
}

function getDateProperty(page: PageObjectResponse, name: string): Date | null {
  const prop = findProperty(page, name);
  if (!prop || prop.type !== "date" || !prop.date?.start) return null;
  const d = new Date(prop.date.start);
  return isNaN(d.getTime()) ? null : d;
}

function getUrlProperty(page: PageObjectResponse, name: string): string | null {
  const prop = findProperty(page, name);
  if (!prop || prop.type !== "url") return null;
  return prop.url || null;
}

function getMultiSelectProperty(
  page: PageObjectResponse,
  name: string
): string[] | null {
  const prop = findProperty(page, name);
  if (!prop || prop.type !== "multi_select") return null;
  const tags = prop.multi_select.map((t) => t.name.toLowerCase()).filter(Boolean);
  return tags.length > 0 ? tags : null;
}

function getSelectProperty(
  page: PageObjectResponse,
  name: string
): string | null {
  const prop = findProperty(page, name);
  if (!prop || prop.type !== "select" || !prop.select) return null;
  return prop.select.name || null;
}

function inferType(page: PageObjectResponse): string {
  const typeName = getSelectProperty(page, "Type") || "";
  const lower = typeName.toLowerCase();
  if (lower.includes("essay")) return "essay";
  if (lower.includes("newsletter")) return "newsletter";
  if (lower.includes("transcript")) return "transcript";
  if (lower.includes("chapter")) return "book_chapter";
  return "article";
}

// --- Main sync ---

export interface NotionSyncResult {
  status: "completed" | "failed";
  imported: number;
  skipped: number;
  errors: number;
  total: number;
  bodySource: { cleaned_body: number; page_body: number };
}

export async function syncNotionDatabase(
  databaseId: string,
  userId: string = "default"
): Promise<NotionSyncResult> {
  if (!process.env.NOTION_TOKEN) {
    throw new Error("NOTION_TOKEN is not set");
  }
  const notion = new Client({ auth: process.env.NOTION_TOKEN });

  // 1. Query all pages in the database
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined = undefined;
  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const p of response.results) {
      if (isFullPage(p)) pages.push(p);
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    await sleep(API_THROTTLE_MS);
  } while (cursor);

  console.log(`[archive] Notion API: fetched ${pages.length} pages from database ${databaseId}`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  const bodySource = { cleaned_body: 0, page_body: 0 };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    try {
      const title = getTitle(page);
      if (!title) {
        console.log(`[archive] Skipping page ${page.id} — no title`);
        continue;
      }

      const externalId = page.id.replace(/-/g, "");

      // Fetch page body blocks → markdown
      const pageBody = await fetchBlocksAsMarkdown(notion, page.id);

      // Pick between Cleaned Body property and page body
      const cleaned = getRichTextProperty(page, "Cleaned Body");
      const picked = pickBody(pageBody, cleaned);
      bodySource[picked.source]++;

      console.log(
        `[archive] (${i + 1}/${pages.length}) "${title}" → ${picked.source} (${picked.text.length} chars${
          cleaned ? `, cleaned=${cleaned.length}, page=${pageBody.length}` : ""
        })`
      );

      if (!picked.text.trim()) {
        console.log(`[archive] Skipping "${title}" — empty body`);
        continue;
      }

      const result = await archiveQueries.upsertArtifact({
        userId,
        type: inferType(page),
        title,
        slug: slugify(title),
        publishedAt:
          getDateProperty(page, "Published") ||
          getDateProperty(page, "Date") ||
          (page.created_time ? new Date(page.created_time) : null),
        rawSource: picked.text,
        canonicalUrl: getUrlProperty(page, "URL"),
        series: getSelectProperty(page, "Series"),
        seriesPosition: null,
        tags: getMultiSelectProperty(page, "Tags"),
        sourceSystem: "notion",
        sourceExternalId: externalId,
      });

      if (result.created) imported++;
      else skipped++;
    } catch (err) {
      console.error(`[archive] Error processing page ${page.id}:`, err);
      errors++;
    }
  }

  console.log(
    `[archive] Notion sync done: ${imported} imported, ${skipped} skipped, ${errors} errors, total ${pages.length}`
  );

  return {
    status: "completed",
    imported,
    skipped,
    errors,
    total: pages.length,
    bodySource,
  };
}
