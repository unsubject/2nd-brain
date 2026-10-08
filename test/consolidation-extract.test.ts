// Step 2 (extract) rules, on synthetic messages shaped like the real ones in
// the "Writing" label and the exports. Pure functions: no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, textLength, unwrapSoftBreaks } from "../src/archive/consolidation/extract/text";
import {
  bareTitle,
  cutQuoted,
  detectOutlet,
  extractGmail,
  stripSignature,
  subjectDate,
} from "../src/archive/consolidation/extract/gmail";
import {
  extractDrive,
  extractSubstack,
  extractWordPress,
  titleDate,
} from "../src/archive/consolidation/extract/exports";
import { extract } from "../src/archive/consolidation/extract";
import type { StagedItem } from "../src/archive/consolidation/extract/types";
import { parseListQuery, parseSampleQuery, renderReviewPage } from "../src/archive/consolidation/extract/review";

// Four paragraphs, ~400 characters: comfortably an essay.
const SENTENCE = "香港經濟的問題不在於短期的周期，而在於制度的信任。";
const ESSAY = [1, 2, 3, 4].map((n) => `第${n}段：${SENTENCE.repeat(4)}`).join("\n\n");

function message(over: Partial<StagedItem> = {}, metadata: Record<string, unknown> = {}): StagedItem {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    source: "gmail",
    sourceRef: "msg-1",
    containerRef: "thread-1",
    title: "利字當頭：科目三",
    authoredAt: new Date("2024-02-19T10:00:00Z"),
    rawText: ESSAY,
    rawHtml: null,
    ...over,
    metadata: {
      kind: "message",
      from: "Simon Lee <simoncf@gmail.com>",
      to: ["Jane Chan <jane@appledaily.com>"],
      cc: [],
      isSent: true,
      ...metadata,
    },
  };
}

// ── text ────────────────────────────────────────────────────────────────

test("htmlToText keeps paragraphs and line breaks, decodes entities, drops scripts", () => {
  assert.equal(
    htmlToText("<style>p{}</style><p>a&amp;b&#x4E2D;</p><p>c<br>d</p><script>x()</script>"),
    "a&b中\n\nc\nd"
  );
  assert.equal(htmlToText("<p>line one\nline two</p>"), "line one line two");
  assert.equal(
    htmlToText("First para\n\nSecond <em>para</em>\nsame para", { keepSourceNewlines: true }),
    "First para\n\nSecond para\nsame para"
  );
});

test("unwrapSoftBreaks rejoins hard-wrapped lines, without spaces inside Chinese", () => {
  assert.equal(
    unwrapSoftBreaks("香港經濟\n的問題\n\n我在 Threads\n上面見到\n\n第三段"),
    "香港經濟的問題\n\n我在 Threads 上面見到\n\n第三段"
  );
  assert.equal(
    unwrapSoftBreaks("The quick\nbrown fox\n\nJumps over\nthe dog\n\nEnd"),
    "The quick brown fox\n\nJumps over the dog\n\nEnd"
  );
  // Lists keep their lines; text without blank-line paragraphs is left alone.
  assert.equal(unwrapSoftBreaks("Intro\n- one\n- two\n\nB\n\nC"), "Intro\n- one\n- two\n\nB\n\nC");
  assert.equal(unwrapSoftBreaks("第一行\n第二行\n\n第三行"), "第一行\n第二行\n\n第三行");
});

test("textLength counts characters that carry text", () => {
  assert.equal(textLength("香港 經濟\n abc"), 7);
  assert.equal(textLength(null), 0);
});

// ── Gmail: submissions ──────────────────────────────────────────────────

test("a column submission: title line removed, sign-off cut, column date from the subject", () => {
  const c = extractGmail(
    message(
      {
        title: "Apple Daily Forum 20200624",
        authoredAt: new Date("2020-06-22T09:00:00Z"),
        rawText: `蘋果論壇：自由市場的代價\n\n${ESSAY}\n\n利世民\n`,
      },
      { to: ["forum@appledaily.com.hk"] }
    )
  );
  assert.equal(c.kind, "submission");
  assert.equal(c.status, "keep");
  assert.equal(c.title, "自由市場的代價");
  assert.equal(c.column, "蘋果論壇");
  assert.equal(c.outlet, "蘋果日報");
  assert.equal(c.isPublished, true);
  assert.equal(c.dateSource, "subject");
  assert.equal(c.publishedAt?.toISOString().slice(0, 10), "2020-06-24");
  assert.equal(c.bodyText, ESSAY);
  assert.equal(c.note, null);
});

test("a resend: the note to the editor and the quoted earlier version are removed", () => {
  const wrapped = "我在 Threads\n上面見到有人說香港經濟\n的問題，" + SENTENCE.repeat(3);
  const c = extractGmail(
    message({
      title: "Re: 利字當頭：科目三",
      rawText:
        `稍為修正了內容，請用以下這個版本。\n\n*科目三*\n\n${wrapped}\n\n${ESSAY}\n\n` +
        "On Mon, Feb 19, 2024 at 6:37 PM Simon Lee <simoncf@gmail.com>\nwrote:\n\n> 舊版本的內容\n> 舊版本的內容\n",
    })
  );
  assert.equal(c.kind, "submission");
  assert.equal(c.status, "keep");
  assert.equal(c.title, "科目三");
  assert.equal(c.column, "利字當頭");
  assert.equal(c.note, "稍為修正了內容，請用以下這個版本。");
  assert.deepEqual(c.reasons, ["note-before-title", "quote-removed"]);
  assert.ok(c.bodyText!.startsWith("我在 Threads 上面見到有人說香港經濟的問題，"));
  assert.ok(!c.bodyText!.includes("舊版本"));
  assert.ok(!c.bodyText!.includes("wrote:"));
});

test("a 'Dear Jane … Simon' preface before a 【column】 title, and a sign-off with a tag", () => {
  const c = extractGmail(
    message(
      {
        title: "利字當頭 2019 07 30",
        authoredAt: new Date("2019-07-28T03:00:00Z"),
        rawText:
          "Dear Jane,\n\nAttached is this week's piece. Thanks!\n\nSimon\n\n" +
          `【利字當頭】講聲你聽的承諾\n\n${ESSAY}\n\n利世民\n講聲你聽 001\n\nSent from my iPhone`,
      },
      { to: ["Jane <jane@livesup.co>"] }
    )
  );
  assert.equal(c.kind, "submission");
  assert.equal(c.title, "講聲你聽的承諾");
  assert.equal(c.column, "利字當頭");
  assert.equal(c.outlet, "尚生活");
  assert.equal(c.note, "Dear Jane,\n\nAttached is this week's piece. Thanks!\n\nSimon");
  assert.equal(c.publishedAt?.toISOString().slice(0, 10), "2019-07-30");
  assert.equal(c.bodyText, ESSAY);
});

test("an unclear note before the essay is removed but sent to review", () => {
  const c = extractGmail(message({ title: "Re: 新稿", rawText: `麻煩老總看看這篇。\n\n${ESSAY}` }));
  assert.equal(c.kind, "submission");
  assert.equal(c.status, "review");
  assert.deepEqual(c.reasons, ["possible-note-removed"]);
  assert.equal(c.note, "麻煩老總看看這篇。");
  assert.equal(c.bodyText, ESSAY);
});

test("a sentence containing the subject's words is not mistaken for the title", () => {
  const first = "科目三這個舞蹈，最近在內地很流行，很多人都跟着跳。";
  const c = extractGmail(message({ title: "利字當頭：科目三", rawText: `${first}\n\n${ESSAY}` }));
  assert.equal(c.title, "科目三");
  assert.ok(c.bodyText!.startsWith(first));
});

test("a short reply with a Gmail date header is a reply, not an essay", () => {
  const c = extractGmail(
    message({
      title: "Re: 利字當頭：科目三",
      rawText: "收到，謝謝！\n\n2016-03-01 10:22 GMT+08:00 Jane Chan <jane@appledaily.com>:\n\n> 稿件已收到\n",
    })
  );
  assert.equal(c.kind, "reply");
  assert.equal(c.status, "drop");
  assert.deepEqual(c.reasons, ["quote-removed", "short-message"]);
  assert.equal(c.bodyText, "收到，謝謝！");
});

test("forwards, received mail and drafts to himself", () => {
  const fwd = extractGmail(message({ title: "Fwd: 利字當頭：科目三" }));
  assert.equal(fwd.kind, "forward");
  assert.equal(fwd.status, "drop");
  assert.equal(fwd.title, "科目三");

  const received = extractGmail(message({ title: "Re: 科目三" }, { from: "Jane <jane@appledaily.com>", isSent: false }));
  assert.equal(received.kind, "received");
  assert.equal(received.status, "drop");

  // From his own domain without the SENT label is still his.
  const own = extractGmail(message({}, { from: "Simon <simon@leesimon.me>", isSent: false }));
  assert.equal(own.kind, "submission");

  // Nothing sent to note@leesimon.me was published; other self-sends are unclear.
  const note = extractGmail(message({}, { to: ["Notes <note@leesimon.me>"], cc: ["simoncf@gmail.com"] }));
  assert.deepEqual([note.kind, note.status, note.isPublished], ["self_draft", "drop", false]);
  assert.deepEqual(note.reasons, ["note-to-self"]);
  const self = extractGmail(message({}, { to: ["simon@unsubject.com"] }));
  assert.deepEqual([self.kind, self.status, self.isPublished], ["self_draft", "review", false]);
  // Sent to an editor with a copy to the notes address: a submission.
  const copied = extractGmail(message({}, { cc: ["note@leesimon.me"] }));
  assert.equal(copied.kind, "submission");
});

test("an occasional piece outside the known columns is kept, with no column", () => {
  const c = extractGmail(
    message({ title: "投稿：樓市的下一步", rawText: `樓市的下一步\n\n${ESSAY}` }, { to: ["editor@example-weekly.com"] })
  );
  assert.deepEqual([c.kind, c.status, c.column, c.outlet], ["submission", "keep", null, null]);
  assert.equal(c.title, "樓市的下一步");
  assert.equal(c.dateSource, "sent");
  assert.equal(c.bodyText, ESSAY);
  // Without a title line, the subject gives the title, minus "投稿".
  assert.equal(extractGmail(message({ title: "投稿：樓市的下一步" }, { to: ["editor@example-weekly.com"] })).title, "樓市的下一步");
});

test("投稿 is removed only as a marker, not from a title that starts with the word", () => {
  for (const marked of ["投稿：樓市的下一步", "投稿 樓市的下一步", "投稿 - 樓市的下一步", "投稿｜樓市的下一步"]) {
    assert.equal(bareTitle(marked), "樓市的下一步", marked);
  }
  assert.equal(bareTitle("投稿「樓市的下一步」"), "「樓市的下一步」");
  assert.equal(bareTitle("投稿"), "");
  assert.equal(bareTitle("投稿文化的轉變"), "投稿文化的轉變");
  assert.equal(bareTitle("投稿人的權利"), "投稿人的權利");
  const c = extractGmail(message({ title: "投稿文化的轉變" }, { to: ["editor@example-weekly.com"] }));
  assert.equal(c.title, "投稿文化的轉變");
});

test("subjectDate reads 留稿 dates across the new year, and ignores far-off dates", () => {
  const sent = new Date("2024-02-27T08:00:00Z");
  assert.equal(subjectDate("利字當頭：科目三（留稿：3月2日見報）", sent)?.toISOString().slice(0, 10), "2024-03-02");
  assert.equal(
    subjectDate("（留稿 1月3日）", new Date("2023-12-28T08:00:00Z"))?.toISOString().slice(0, 10),
    "2024-01-03"
  );
  assert.equal(subjectDate("利字當頭 2019 07 30", sent), null);
  assert.equal(subjectDate("科目三 2024 02 28", sent), null); // not a column subject

  const c = extractGmail(message({ title: "利字當頭：科目三（留稿：3月2日見報）", authoredAt: sent }));
  assert.equal(c.title, "科目三");
  assert.equal(c.dateSource, "subject");
});

test("the outlet follows the column, then the first outlet domain in priority order", () => {
  assert.equal(detectOutlet(["Ed <editor@appledaily.com>", "desk@sharpdaily.com.hk"], null), "爽報");
  assert.equal(detectOutlet(["someone@example.com"], null), null);
  const c = extractGmail(
    message({ title: "金融一條針：息口" }, { to: ["desk@sharpdaily.com.hk"], cc: ["editor@appledaily.com"] })
  );
  assert.equal(c.column, "金融一條針");
  assert.equal(c.outlet, "爽報");
});

test("cutQuoted handles Chinese and Outlook headers and trailing > blocks", () => {
  assert.deepEqual(cutQuoted("新內容\n\nJane 於 2020年6月1日 週一 上午10:00 寫道：\n> 舊"), { text: "新內容", cut: true });
  assert.deepEqual(cutQuoted("新內容\n\nFrom: Jane\nSent: Monday\nTo: Simon\n\n舊"), { text: "新內容", cut: true });
  assert.deepEqual(cutQuoted("新內容\n\n> 舊一\n> 舊二"), { text: "新內容", cut: true });
  assert.deepEqual(cutQuoted("一行\n> 引用一行"), { text: "一行\n> 引用一行", cut: false });
});

test("stripSignature cuts sign-offs and delimiters, not a name inside the text", () => {
  assert.equal(stripSignature("正文\n\n謝謝\nSimon"), "正文");
  assert.equal(stripSignature("正文\n-- \nSimon Lee\nCEO"), "正文");
  // A long passage after the name means the name was not a sign-off.
  assert.equal(stripSignature(`正文\n利世民\n${SENTENCE}${SENTENCE}`), `正文\n利世民\n${SENTENCE}${SENTENCE}`);
});

test("a .docx attachment is a copy of the piece; its file name gives the title", () => {
  const c = extractGmail(
    message(
      { sourceRef: "msg-1#2", title: "利字當頭 科目三.docx", rawText: ESSAY },
      { kind: "attachment", filename: "利字當頭 科目三.docx", subject: "利字當頭：科目三" }
    )
  );
  assert.equal(c.kind, "attachment");
  assert.equal(c.status, "keep");
  assert.equal(c.title, "科目三");
  assert.equal(c.column, "利字當頭");

  const theirs = extractGmail(
    message({ rawText: ESSAY }, { kind: "attachment", filename: "edited.docx", from: "jane@appledaily.com", isSent: false })
  );
  assert.equal(theirs.kind, "received");
});

test("an attachment follows its message's recipients: forum column, outlet, drafts to himself", () => {
  const attachment = (to: string[], cc: string[] = []) =>
    extractGmail(
      message(
        { sourceRef: "msg-1#2", title: "final.docx", rawText: ESSAY },
        { kind: "attachment", filename: "final.docx", subject: "專業議政是擴闊泛民光譜的關鍵", to, cc }
      )
    );
  const forum = attachment(["forum@appledaily.com"]);
  assert.deepEqual([forum.kind, forum.status, forum.column, forum.outlet], ["attachment", "keep", "蘋果論壇", "蘋果日報"]);
  assert.equal(forum.isPublished, true);
  const editor = attachment(["Ed <editor@appledaily.com>"]);
  assert.deepEqual([editor.kind, editor.column, editor.outlet], ["attachment", null, "蘋果日報"]);

  const note = attachment(["Notes <note@leesimon.me>"], ["simoncf@gmail.com"]);
  assert.deepEqual([note.kind, note.status, note.isPublished, note.reasons], ["self_draft", "drop", false, ["note-to-self"]]);
  const self = attachment(["simon@unsubject.com"]);
  assert.deepEqual(
    [self.kind, self.status, self.isPublished, self.reasons],
    ["self_draft", "review", false, ["sent-only-to-own-addresses"]]
  );
  // Copied to the notes address but sent to an editor: still a submission.
  assert.equal(attachment(["editor@appledaily.com"], ["note@leesimon.me"]).kind, "attachment");
});

// ── Gmail: newsletters ──────────────────────────────────────────────────

test("a Revue issue from his own domain is a newsletter copy, wrapper removed", () => {
  const c = extractGmail(
    message(
      {
        title: "講聲你聽 #12：通脹的真相",
        authoredAt: new Date("2021-03-01T01:00:00Z"),
        rawText:
          "View online [https://www.getrevue.co/profile/leesimon/issues/12] |\n\n講聲你聽 #12：通脹的真相\n\n" +
          `${ESSAY} [https://example.com/a]\n\nDid you enjoy this issue? Yes No\n\n` +
          "If you don't want these updates anymore, please unsubscribe here.",
      },
      { from: "利世民 <newsletter@leesimon.me>", to: ["simoncf@gmail.com"], isSent: false }
    )
  );
  assert.equal(c.kind, "newsletter");
  assert.equal(c.status, "keep");
  assert.equal(c.outlet, "Revue");
  assert.equal(c.bodyText, ESSAY);
  assert.equal(c.dedupeKey, "revue|講聲你聽#12：通脹的真相|2021-03-01");
});

test("a Ghost (unsubject.me) issue from its HTML", () => {
  const html =
    `<html><body><p><a href="https://unsubject.me/x">View online →</a></p><h1>成本與價格</h1>` +
    ESSAY.split("\n\n").map((p) => `<p>${p}</p>`).join("") +
    "<p>假如你從朋友轉送收到這封電郵，請按此訂閱。</p><p>unsubject © 2023</p><a href='#'>Unsubscribe</a></body></html>";
  const c = extractGmail(
    message({ title: "成本與價格", rawText: "", rawHtml: html }, { from: "unsubject <newsletter@unsubject.me>", isSent: false })
  );
  assert.equal(c.kind, "newsletter");
  assert.equal(c.outlet, "unsubject.me");
  assert.equal(c.bodyText, ESSAY);
});

test("a Patreon post email: title from the subject, header and footer removed", () => {
  const c = extractGmail(
    message(
      {
        title: 'Simon Lee just shared "成本與價格"',
        rawText: `Simon Lee\n\n成本與價格\n\n${ESSAY}\n\nView on Patreon\n\nPatreon Inc. 600 Townsend Street`,
      },
      { from: "Patreon <bingo@patreon.com>", isSent: false }
    )
  );
  assert.equal(c.kind, "newsletter");
  assert.equal(c.title, "成本與價格");
  assert.equal(c.outlet, "Patreon");
  assert.equal(c.bodyText, ESSAY);
});

test("a Substack email is dropped (the export has the post); an empty issue goes to review", () => {
  const sub = extractGmail(message({ title: "科目三" }, { from: "利世民 <leesimon@substack.com>", isSent: false }));
  assert.equal(sub.kind, "platform_copy");
  assert.equal(sub.status, "drop");
  assert.equal(sub.outlet, "Substack");

  const empty = extractGmail(
    message({ title: "短", rawText: "View online →\n\n短\n\nUnsubscribe" }, { from: "newsletter@unsubject.me", isSent: false })
  );
  assert.equal(empty.kind, "empty");
  assert.equal(empty.status, "review");
});

// ── Exports ─────────────────────────────────────────────────────────────

function exported(source: StagedItem["source"], over: Partial<StagedItem>, metadata: Record<string, unknown>): StagedItem {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    source,
    sourceRef: "ref",
    containerRef: "file",
    title: "利字當頭：科目三",
    authoredAt: new Date("2018-05-01T00:00:00Z"),
    rawText: null,
    rawHtml: `${SENTENCE}<strong>${SENTENCE}</strong>\n\n${SENTENCE}${SENTENCE}`,
    ...over,
    metadata,
  };
}

test("WordPress: published posts keep their blank-line paragraphs; drafts, pages, private", () => {
  const post = extractWordPress(exported("wordpress", {}, { status: "publish", postType: "post", site: "https://leesimon.me" }));
  assert.equal(post.kind, "post");
  assert.equal(post.status, "keep");
  assert.equal(post.outlet, "WordPress (leesimon.me)");
  assert.equal(post.column, "利字當頭");
  assert.equal(post.dateSource, "export");
  assert.equal(post.bodyText, `${SENTENCE}${SENTENCE}\n\n${SENTENCE}${SENTENCE}`);

  const draft = extractWordPress(exported("wordpress", {}, { status: "draft", postType: "post" }));
  assert.deepEqual([draft.kind, draft.status, draft.reasons], ["draft", "drop", ["status-draft"]]);
  const page = extractWordPress(exported("wordpress", {}, { status: "publish", postType: "page" }));
  assert.deepEqual([page.kind, page.status], ["page", "review"]);
  const priv = extractWordPress(exported("wordpress", {}, { status: "private", postType: "post" }));
  assert.deepEqual([priv.kind, priv.status, priv.isPublished], ["post", "review", false]);
  const empty = extractWordPress(exported("wordpress", { rawHtml: "<p>hi</p>" }, { status: "publish" }));
  assert.equal(empty.kind, "empty");
});

test("Substack: published posts kept, paid audience noted, drafts dropped", () => {
  const paid = extractSubstack(exported("substack", {}, { isPublished: true, audience: "only_paid" }));
  assert.deepEqual([paid.kind, paid.status, paid.outlet, paid.reasons], ["post", "keep", "Substack", ["audience-only_paid"]]);
  const draft = extractSubstack(exported("substack", {}, { isPublished: false, audience: "everyone" }));
  assert.deepEqual([draft.kind, draft.status, draft.reasons], ["draft", "drop", ["not-published"]]);
});

test("Drive: a date in the file name beats the file's creation date", () => {
  const dated = extractDrive(exported("gdrive", { title: "利字當頭 20190730.docx", rawText: ESSAY, rawHtml: null }, {}));
  assert.equal(dated.kind, "doc");
  assert.equal(dated.title, "利字當頭 20190730");
  assert.equal(dated.column, "利字當頭");
  assert.equal(dated.dateSource, "title");
  assert.equal(dated.publishedAt?.toISOString().slice(0, 10), "2019-07-30");

  const undated = extractDrive(exported("gdrive", { title: "筆記", rawText: `﻿${ESSAY}`, rawHtml: null }, {}));
  assert.equal(undated.dateSource, "file-created");
  assert.equal(undated.bodyText, ESSAY);

  assert.equal(titleDate("2019-07-30 notes")?.toISOString().slice(0, 10), "2019-07-30");
  assert.equal(titleDate("20191340"), null);
  assert.equal(titleDate("123456789"), null);
});

test("extract dispatches on the source", () => {
  assert.equal(extract(exported("substack", {}, { isPublished: true })).outlet, "Substack");
  assert.equal(extract(message()).kind, "submission");
});

// ── Review queries ──────────────────────────────────────────────────────

test("candidate list and sample queries validate their parameters", () => {
  assert.deepEqual(parseListQuery({}), { limit: 50, offset: 0 });
  assert.deepEqual(parseListQuery({ source: "gmail", status: "review", limit: "10", offset: "20" }), {
    source: "gmail",
    status: "review",
    limit: 10,
    offset: 20,
  });
  assert.match(parseListQuery({ kind: "essay" }) as string, /^kind must be one of/);
  assert.match(parseListQuery({ limit: "0" }) as string, /^limit must be/);
  assert.match(parseListQuery({ limit: ["1", "2"] }) as string, /^limit must be/);
  assert.deepEqual(parseSampleQuery({}), { size: 12, seed: "review" });
  assert.match(parseSampleQuery({ seed: "a b" }) as string, /^seed must be/);
  assert.match(parseSampleQuery({ sample: "101" }) as string, /^sample must be/);
});

test("the review page escapes everything it shows", () => {
  const page = renderReviewPage(
    [
      {
        candidate: {
          id: "c1",
          kind: "submission",
          status: "keep",
          reasons: ["<b>r</b>"],
          title: "<script>alert(1)</script>",
          char_count: 3,
          body_text: "a<b>c",
          note: null,
          published_at: new Date("2020-01-02T00:00:00Z"),
          date_source: "sent",
        },
        source: {
          id: "s1",
          source: "gmail",
          sourceRef: "m1",
          containerRef: null,
          title: null,
          authoredAt: null,
          rawText: "before <i>",
          rawHtml: null,
          metadata: {},
        },
      },
    ],
    { size: 1, seed: "review" }
  );
  assert.ok(!page.includes("<script>alert"));
  assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(page.includes("a&lt;b&gt;c"));
  assert.ok(page.includes("before &lt;i&gt;"));
  assert.ok(page.includes("2020-01-02 (sent)"));
});

// ── Patterns found in the real "Writing" label (2026-10-07) ─────────────

test("a 2013-style forum resend: old Gmail quote header, signed 李兆富, author name in the subject", () => {
  const c = extractGmail(
    message(
      {
        title: "Re: 李兆富：福利與權利",
        authoredAt: new Date("2013-12-26T11:16:35Z"),
        rawText:
          `${ESSAY}\n\n李兆富\n\n\n2013/12/26 Liu Jing <echoliu@appledaily.com>\n> 好的，多謝您！\n>\n> 劉 璟\n` +
          "> --\n> 利世民\n> Facebook - http://www.facebook.com/leesimon.hk\n",
      },
      { from: "Simon Lee <simoncf@gmail.com>", to: ["echoliu@appledaily.com", "forum@appledaily.com"] }
    )
  );
  assert.equal(c.kind, "submission");
  assert.equal(c.status, "keep");
  assert.equal(c.bodyText, ESSAY);
  assert.equal(c.title, "福利與權利");
  assert.equal(c.column, "蘋果論壇");
  assert.equal(c.outlet, "蘋果日報");
  assert.deepEqual(c.reasons, ["quote-removed"]);
});

test("an iPhone reply quotes its own header ('> On … wrote:')", () => {
  const c = extractGmail(
    message({
      title: "Re: 李兆富：福利與權利",
      rawText: `五點左右，講經濟展望\n\nSent from my iPhone\n\n> On 1 Jan, 2014, at 15:12, "Liu Jing" <echoliu@appledaily.com> wrote:\n>\n> 李先生，請問您今日幾時來稿？\n>\n> ${SENTENCE.repeat(12)}\n`,
    })
  );
  assert.equal(c.kind, "reply");
  assert.equal(c.bodyText, "五點左右，講經濟展望");
});

test("Gmail link targets are removed from the text", () => {
  const c = extractGmail(
    message({ rawText: `幾個星期前，港聲你聽 <https://www.youtube.com/@voxhk>的例會上，我問了一個問題。\n\n${ESSAY}` })
  );
  assert.ok(c.bodyText!.startsWith("幾個星期前，港聲你聽的例會上，我問了一個問題。"));
  assert.ok(!c.bodyText!.includes("https://"));
});

test("a piece mailed to the forum address is a 蘋果論壇 piece even without the column in the subject", () => {
  const c = extractGmail(
    message(
      { title: "專業議政是擴闊泛民光譜的關鍵", rawText: `專業議政是擴闊泛民光譜的關鍵\n\n${ESSAY}` },
      { to: ["forum@appledaily.com", "yeungck@appledaily.com"] }
    )
  );
  assert.deepEqual([c.kind, c.status, c.column, c.outlet], ["submission", "keep", "蘋果論壇", "蘋果日報"]);
  assert.equal(c.title, "專業議政是擴闊泛民光譜的關鍵");
  assert.equal(c.bodyText, ESSAY);
});

test("a long reply to a reader goes to review; a first send to an unknown outlet is kept", () => {
  const reply = extractGmail(message({ title: "Re: 利字當頭 2020 06 02" }, { to: ["Raymond <reader@gmail.com>"] }));
  assert.deepEqual([reply.kind, reply.status], ["submission", "review"]);
  assert.deepEqual(reply.reasons, ["reply-outside-outlets"]);

  const fresh = extractGmail(message({ title: "樓市的下一步" }, { to: ["editor@example-weekly.com"] }));
  assert.deepEqual([fresh.kind, fresh.status], ["submission", "keep"]);
  assert.deepEqual(fresh.reasons, ["outlet-unknown"]);
});

test("Patreon mail about another creator's post is not his", () => {
  const c = extractGmail(
    message(
      { title: '🎉 Someone Else just shared "A post" for patrons only', rawText: ESSAY },
      { from: "Patreon <bingo@patreon.com>", isSent: false }
    )
  );
  assert.deepEqual([c.kind, c.status, c.reasons], ["received", "drop", ["other-patreon-creator"]]);
  const his = extractGmail(
    message(
      { title: '🎉 利世民 just shared "【暑期作業】三權合作" for patrons only', rawText: `利世民\n\n【暑期作業】三權合作\n\n${ESSAY}\n\nView on Patreon` },
      { from: "Patreon <bingo@patreon.com>", isSent: false }
    )
  );
  assert.equal(his.kind, "newsletter");
  assert.equal(his.title, "【暑期作業】三權合作");
  assert.equal(his.bodyText, ESSAY);
});

test("an essay's short first paragraph is not taken for a note", () => {
  for (const first of ["今年稿費又加了，但物價升得更快。", "I flew to Delhi last week, and saw the same thing."]) {
    const c = extractGmail(message({ title: "隨筆", rawText: `${first}\n\n${ESSAY}` }));
    assert.equal(c.status, "keep", first);
    assert.ok(c.bodyText!.startsWith(first), first);
  }
});
