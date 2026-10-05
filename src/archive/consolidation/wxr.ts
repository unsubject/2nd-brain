// Pure parser for WordPress eXtended RSS (WXR) exports. Keeps each post's
// content:encoded exactly as exported; no HTML cleanup happens here.

import { XMLParser } from "fast-xml-parser";

export interface WxrPost {
  postId: string;
  postType: string;
  status: string;
  title: string;
  slug: string | null;
  link: string | null;
  guid: string | null;
  creator: string | null;
  publishedAt: Date | null;
  // How publishedAt was derived; 'local' means the export only had the
  // site-local time, read as UTC.
  dateSource: "gmt" | "pubDate" | "local" | null;
  contentHtml: string;
  excerpt: string | null;
  categories: string[];
  tags: string[];
}

export interface WxrExport {
  siteTitle: string | null;
  siteLink: string | null;
  posts: WxrPost[];
  // Item counts by post type that were not kept (attachments, menus, ...).
  skipped: Record<string, number>;
}

const KEEP_TYPES = new Set(["post", "page"]);

type Node = Record<string, unknown>;

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "#text" in (v as Node)) return text((v as Node)["#text"]);
  return null;
}

function trimmed(v: unknown): string | null {
  const t = text(v);
  if (t === null) return null;
  const s = t.trim();
  return s.length > 0 ? s : null;
}

// "2019-07-30 10:00:00" → Date (UTC). WordPress writes 0000-00-00 for unset.
function wpDate(v: string | null): Date | null {
  if (!v || v.startsWith("0000-00-00")) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return isNaN(d.getTime()) ? null : d;
}

function rfcDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function parseWxr(xml: string): WxrExport {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Keep bodies byte-for-byte: no trimming, no number coercion.
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => name === "item" || name === "category",
  });
  const doc = parser.parse(xml) as Node;
  const channel = ((doc.rss as Node | undefined)?.channel ?? {}) as Node;
  const items = (channel.item as Node[] | undefined) ?? [];

  const out: WxrExport = {
    siteTitle: trimmed(channel.title),
    siteLink: trimmed(channel.link) ?? trimmed(channel["wp:base_blog_url"]),
    posts: [],
    skipped: {},
  };

  for (const item of items) {
    const postType = trimmed(item["wp:post_type"]) ?? "unknown";
    const postId = trimmed(item["wp:post_id"]);
    if (!KEEP_TYPES.has(postType) || !postId) {
      out.skipped[postType] = (out.skipped[postType] ?? 0) + 1;
      continue;
    }

    const gmt = wpDate(trimmed(item["wp:post_date_gmt"]));
    const pub = gmt ? null : rfcDate(trimmed(item.pubDate));
    const local = gmt || pub ? null : wpDate(trimmed(item["wp:post_date"]));

    const categories: string[] = [];
    const tags: string[] = [];
    for (const c of (item.category as unknown[] | undefined) ?? []) {
      const name = trimmed(c);
      if (!name) continue;
      const domain = typeof c === "object" && c ? text((c as Node)["@_domain"]) : null;
      if (domain === "post_tag") tags.push(name);
      else categories.push(name);
    }

    out.posts.push({
      postId,
      postType,
      status: trimmed(item["wp:status"]) ?? "unknown",
      title: trimmed(item.title) ?? "",
      slug: trimmed(item["wp:post_name"]),
      link: trimmed(item.link),
      guid: trimmed(item.guid),
      creator: trimmed(item["dc:creator"]),
      publishedAt: gmt ?? pub ?? local,
      dateSource: gmt ? "gmt" : pub ? "pubDate" : local ? "local" : null,
      contentHtml: text(item["content:encoded"]) ?? "",
      excerpt: trimmed(item["excerpt:encoded"]),
      categories,
      tags,
    });
  }
  return out;
}
