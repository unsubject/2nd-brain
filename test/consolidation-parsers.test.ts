// Pure parsers for archive consolidation: Gmail MIME payloads, WordPress
// WXR exports, Substack export zips, and collect-request validation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import {
  charsetOf,
  decodeBody,
  extractBodies,
  isDocxAttachment,
  splitAddresses,
} from "../src/archive/consolidation/mime";
import { parseWxr } from "../src/archive/consolidation/wxr";
import {
  buildSubstackExport,
  isWantedSubstackEntry,
  readZipEntries,
} from "../src/archive/consolidation/substack";
import { contentHash } from "../src/archive/consolidation/staging";
import { collectionOrder } from "../src/archive/consolidation/drive";
import { MAX_RESUMES, resumeRequest } from "../src/archive/consolidation/resume";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

// ── Gmail MIME ──────────────────────────────────────────────────────────

test("extractBodies picks the first plain and html bodies and lists attachments", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            partId: "0.0",
            mimeType: "text/plain",
            headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
            body: { data: b64("稍為修正了內容，請用以下這個版本。\n\n科目三") },
          },
          {
            partId: "0.1",
            mimeType: "text/html",
            headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
            body: { data: b64("<div>稍為修正了內容</div>") },
          },
        ],
      },
      {
        partId: "1",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "利字當頭 20190730.docx",
        body: { attachmentId: "ANGjdJ_x", size: 12345 },
      },
      {
        // A nested forwarded text part must not replace the top-level body.
        partId: "2",
        mimeType: "message/rfc822",
        parts: [{ partId: "2.0", mimeType: "text/plain", body: { data: b64("forwarded") } }],
      },
    ],
  };
  const out = extractBodies(payload);
  assert.equal(out.text, "稍為修正了內容，請用以下這個版本。\n\n科目三");
  assert.equal(out.html, "<div>稍為修正了內容</div>");
  assert.equal(out.attachments.length, 1);
  assert.deepEqual(
    { partId: out.attachments[0].partId, filename: out.attachments[0].filename, size: out.attachments[0].size },
    { partId: "1", filename: "利字當頭 20190730.docx", size: 12345 }
  );
  assert.ok(isDocxAttachment(out.attachments[0]));
  assert.deepEqual(out.unknownCharsets, []);
});

test("decodeBody honours Big5 and falls back to UTF-8 for unknown charsets", () => {
  const big5 = Buffer.from([0xa7, 0x51, 0xa5, 0x40, 0xa5, 0xc1]); // 利世民
  assert.equal(decodeBody(b64(big5), charsetOf('text/plain; charset="big5"')), "利世民");
  const unknown: string[] = [];
  assert.equal(decodeBody(b64("hello"), "x-made-up", unknown), "hello");
  assert.deepEqual(unknown, ["x-made-up"]);
});

test("extractBodies handles a single-part message and missing payloads", () => {
  assert.equal(extractBodies({ mimeType: "text/plain", body: { data: b64("只有文字") } }).text, "只有文字");
  const empty = extractBodies(undefined);
  assert.equal(empty.text, null);
  assert.equal(empty.html, null);
});

test("extractBodies returns out-of-line bodies for fetching and keeps them over later parts", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            partId: "0.0",
            mimeType: "text/plain",
            headers: [{ name: "Content-Type", value: 'text/plain; charset="big5"' }],
            body: { attachmentId: "BODY_TEXT", size: 120000 },
          },
          {
            partId: "0.1",
            mimeType: "text/html",
            headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
            body: { attachmentId: "BODY_HTML", size: 240000 },
          },
        ],
      },
      {
        // A later inline body (e.g. a forwarded copy) must not win.
        partId: "1",
        mimeType: "message/rfc822",
        parts: [
          { partId: "1.0", mimeType: "text/plain", body: { data: b64("forwarded") } },
          { partId: "1.1", mimeType: "text/html", body: { data: b64("<p>forwarded</p>") } },
        ],
      },
    ],
  };
  const out = extractBodies(payload);
  assert.equal(out.text, null);
  assert.equal(out.html, null);
  assert.deepEqual(out.textExternal, { attachmentId: "BODY_TEXT", charset: "big5" });
  assert.deepEqual(out.htmlExternal, { attachmentId: "BODY_HTML", charset: "utf-8" });
  // Body parts are not attachments: they have no filename.
  assert.deepEqual(out.attachments, []);
});

test("splitAddresses keeps commas inside quoted display names", () => {
  assert.deepEqual(splitAddresses('"Lee, Simon" <a@b.com>, c@d.com'), ['"Lee, Simon" <a@b.com>', "c@d.com"]);
  assert.deepEqual(splitAddresses(null), []);
});

// ── WordPress WXR ───────────────────────────────────────────────────────

const WXR = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>利世民</title>
  <link>https://leesimon.me</link>
  <wp:base_blog_url>https://leesimon.me</wp:base_blog_url>
  <item>
    <title><![CDATA[利字當頭：尋租經濟 & 樓價]]></title>
    <link>https://leesimon.me/2019/03/21/rent-seeking/</link>
    <pubDate>Thu, 21 Mar 2019 02:00:00 +0000</pubDate>
    <dc:creator><![CDATA[simon]]></dc:creator>
    <guid isPermaLink="false">https://leesimon.me/?p=101</guid>
    <content:encoded><![CDATA[  <p>第一段</p>

<p>第二段 &amp; more</p>  ]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>101</wp:post_id>
    <wp:post_date><![CDATA[2019-03-21 10:00:00]]></wp:post_date>
    <wp:post_date_gmt><![CDATA[2019-03-21 02:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[rent-seeking]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <category domain="category" nicename="column"><![CDATA[專欄]]></category>
    <category domain="post_tag" nicename="hk"><![CDATA[香港]]></category>
  </item>
  <item>
    <title>Draft</title>
    <wp:post_id>102</wp:post_id>
    <wp:post_date>2020-01-01 08:00:00</wp:post_date>
    <wp:post_date_gmt>0000-00-00 00:00:00</wp:post_date_gmt>
    <wp:status>draft</wp:status>
    <wp:post_type>post</wp:post_type>
    <content:encoded><![CDATA[草稿]]></content:encoded>
  </item>
  <item>
    <title>photo.jpg</title>
    <wp:post_id>103</wp:post_id>
    <wp:post_type><![CDATA[attachment]]></wp:post_type>
  </item>
  <item>
    <title>Menu</title>
    <wp:post_id>104</wp:post_id>
    <wp:post_type>nav_menu_item</wp:post_type>
  </item>
</channel>
</rss>`;

test("parseWxr keeps post HTML verbatim and reads dates, categories and tags", () => {
  const out = parseWxr(WXR);
  assert.equal(out.siteLink, "https://leesimon.me");
  assert.equal(out.posts.length, 2);
  assert.deepEqual(out.skipped, { attachment: 1, nav_menu_item: 1 });

  const p = out.posts[0];
  assert.equal(p.postId, "101");
  assert.equal(p.title, "利字當頭：尋租經濟 & 樓價");
  // CDATA content is not trimmed or entity-decoded.
  assert.equal(p.contentHtml, "  <p>第一段</p>\n\n<p>第二段 &amp; more</p>  ");
  assert.equal(p.publishedAt?.toISOString(), "2019-03-21T02:00:00.000Z");
  assert.equal(p.dateSource, "gmt");
  assert.deepEqual(p.categories, ["專欄"]);
  assert.deepEqual(p.tags, ["香港"]);
  assert.equal(p.status, "publish");
  assert.equal(p.excerpt, null);
});

test("parseWxr falls back to the local date when the GMT date is unset", () => {
  const draft = parseWxr(WXR).posts[1];
  assert.equal(draft.status, "draft");
  assert.equal(draft.dateSource, "local");
  assert.equal(draft.publishedAt?.toISOString(), "2020-01-01T08:00:00.000Z");
});

// ── Substack export zip ─────────────────────────────────────────────────

test("readZipEntries reads only post files, never the subscriber list", async () => {
  const entries = await readZipEntries(
    join(__dirname, "fixtures", "substack-export-sample.zip"),
    isWantedSubstackEntry
  );
  assert.deepEqual([...entries.keys()].sort(), [
    "posts.csv",
    "posts/111.first-post.html",
    "posts/222.paid-post.html",
    "posts/444.orphan.html",
  ]);
  assert.ok(![...entries.keys()].some((n) => /email/i.test(n)));

  const exp = buildSubstackExport(entries);
  assert.equal(exp.posts.length, 2);
  const first = exp.posts.find((p) => p.postId === "111")!;
  assert.equal(first.title, '神奇國度的前世今生, part "one"');
  assert.equal(first.subtitle, "所謂嘅西方其實先至係少數");
  assert.equal(first.html, "<p>第一段。</p>\n<p>第二段，有 <b>粗體</b>。</p>");
  assert.equal(first.postDate?.toISOString(), "2022-06-07T02:42:08.000Z");
  assert.equal(first.isPublished, true);
  const paid = exp.posts.find((p) => p.postId === "222")!;
  assert.equal(paid.audience, "only_paid");
  assert.deepEqual(exp.missingHtml, ["333.draft-no-html"]);
  assert.deepEqual(exp.orphanHtml, ["444.orphan"]);
});

test("buildSubstackExport rejects a zip without posts.csv", () => {
  assert.throws(() => buildSubstackExport(new Map([["posts/1.a.html", Buffer.from("x")]])), /posts\.csv/);
});

// ── misc ────────────────────────────────────────────────────────────────

test("contentHash distinguishes text from html", () => {
  assert.notEqual(contentHash("a", null), contentHash(null, "a"));
  assert.equal(contentHash("a", "b"), contentHash("a", "b"));
});

test("collectionOrder reads export snapshots last, oldest to newest", () => {
  const f = (name: string, mimeType: string, modifiedTime: string | null, createdTime: string | null = null) => ({
    name,
    mimeType,
    modifiedTime,
    createdTime,
  });
  const files = [
    f("wordpress-2024.xml", "text/xml", "2024-06-01T00:00:00.000Z"),
    f("利字當頭 2019", "application/vnd.google-apps.document", "2019-07-30T00:00:00.000Z"),
    f("substack-new.zip", "application/zip", "2026-10-04T10:00:00.000Z"),
    f("wordpress-2021.xml", "application/xml", "2021-01-01T00:00:00.000Z"),
    f("substack-old.zip", "application/zip", null, "2025-01-01T00:00:00.000Z"),
    f("notes.pdf", "application/pdf", "2026-01-01T00:00:00.000Z"),
  ];
  assert.deepEqual(
    collectionOrder(files).map((x) => x.name),
    [
      "利字當頭 2019",
      "notes.pdf",
      "wordpress-2021.xml",
      "wordpress-2024.xml",
      "substack-old.zip",
      "substack-new.zip",
    ]
  );
  // The input order is left alone.
  assert.equal(files[0].name, "wordpress-2024.xml");
});

test("parseCollectRequest validates sources, labels and Drive ids", async () => {
  process.env.OPENAI_API_KEY ??= "test-dummy"; // archive modules build an OpenAI client on import
  const { parseCollectRequest } = await import("../src/archive/routes");
  assert.deepEqual(parseCollectRequest({ source: "gmail" }), { source: "gmail", label: "Writing", refetch: false });
  assert.deepEqual(parseCollectRequest({ source: "gdrive", folderIds: ["1-t93X29Zx94KBa0E2WxM7Izu4S8CLOvl"], refetch: true }), {
    source: "gdrive",
    folderIds: ["1-t93X29Zx94KBa0E2WxM7Izu4S8CLOvl"],
    refetch: true,
  });
  assert.equal(typeof parseCollectRequest({ source: "gdrive", folderIds: ["x' or name contains '"] }), "string");
  assert.equal(typeof parseCollectRequest({ source: "gdrive", folderIds: [] }), "string");
  assert.equal(typeof parseCollectRequest({ source: "gmail", label: "" }), "string");
  assert.equal(typeof parseCollectRequest({ source: "notion" }), "string");
});

test("resumeRequest continues a run without refetching, up to MAX_RESUMES times", () => {
  const gmail = resumeRequest({ id: "run-1", source: "gmail", params: { label: "Writing", refetch: true } });
  assert.deepEqual(gmail, { source: "gmail", label: "Writing", refetch: false, resumedFrom: "run-1", resumeCount: 1 });

  const folders = ["1-t93X29Zx94KBa0E2WxM7Izu4S8CLOvl", "19xMNprsamGSLdZw6EgRd2uCeppKS2gzZ"];
  const drive = resumeRequest({
    id: "run-2",
    source: "gdrive",
    params: { folderIds: folders, refetch: false, resumedFrom: "run-0", resumeCount: 2 },
  });
  assert.deepEqual(drive, { source: "gdrive", folderIds: folders, refetch: false, resumedFrom: "run-2", resumeCount: 3 });

  // Extraction rewrites every candidate, so running it again is the resume.
  assert.deepEqual(resumeRequest({ id: "run-3", source: "extract", params: {} }), {
    source: "extract",
    resumedFrom: "run-3",
    resumeCount: 1,
  });
  assert.equal(resumeRequest({ id: "r", source: "extract", params: { resumeCount: MAX_RESUMES } }), null);
  assert.deepEqual(resumeRequest({ id: "run-4", source: "match", params: {} }), {
    source: "match",
    resumedFrom: "run-4",
    resumeCount: 1,
  });

  // Resumed too often, or params that don't describe a run: left alone.
  assert.equal(resumeRequest({ id: "r", source: "gmail", params: { label: "Writing", resumeCount: MAX_RESUMES } }), null);
  assert.equal(resumeRequest({ id: "r", source: "gmail", params: {} }), null);
  assert.equal(resumeRequest({ id: "r", source: "gdrive", params: { folderIds: ["x' or name contains '"] } }), null);
  assert.equal(resumeRequest({ id: "r", source: "gdrive", params: { folderIds: [] } }), null);
});
