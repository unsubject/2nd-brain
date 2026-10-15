// Step 4 (load): which work replaces each row of the first import. Pure
// functions on synthetic texts; no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPORT_CUT,
  isFragment,
  matchLegacy,
  placeUnmatched,
  titleKey,
  videoIdOf,
} from "../src/archive/consolidation/load/legacy";
import { sampled, shingles } from "../src/archive/consolidation/match/similarity";
import { titleFor } from "../src/archive/consolidation/load/run";

// Distinct pseudo-random "essays" from a fixed generator.
const CHARS = "的一是不了人我在有他這中大來上個國到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情部正名定女問力機給等幾很業最間新什打便位因重被走電四第門相次東政海口使教西再平真聽世氣信北少關";
function essay(seed: number, length = 1200): string {
  let s = seed >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out += CHARS[s % CHARS.length];
    if (i % 60 === 59) out += "。\n\n";
  }
  return out;
}

const pieces = [
  { id: "short", text: essay(1, 1200) },
  { id: "long", text: essay(2, 9000) },
  { id: "other", text: essay(3, 1500) },
];

test("an old row is replaced by the piece it copies; an unrelated row by none", () => {
  const rows = [
    // The version sent to the editor, with a note on top and the last lines edited.
    { id: "copy", text: `老總：附上今期稿件，請查收。\n\n${pieces[0].text.slice(0, 1000)}${essay(9, 200)}`, truncated: false },
    { id: "unrelated", text: essay(4, 1200), truncated: false },
  ];
  const matches = matchLegacy(rows, pieces);
  assert.equal(matches.get("copy")?.pieceId, "short");
  assert.ok((matches.get("copy")?.containment ?? 0) >= 0.6);
  assert.equal(matches.has("unrelated"), false);
});

test("a row the import cut at 2,000 characters is replaced by the long piece it starts", () => {
  const start = pieces[1].text.slice(0, IMPORT_CUT);
  // Under 30% of the long piece: only the cut makes it a copy, not an excerpt.
  const matches = matchLegacy(
    [
      { id: "cut", text: start, truncated: true },
      { id: "excerpt", text: start, truncated: false },
    ],
    pieces
  );
  assert.equal(matches.get("cut")?.pieceId, "long");
  assert.equal(matches.has("excerpt"), false);
});

test("a row that copies two pieces goes to the one it matches best", () => {
  const both = [
    { id: "draft", text: pieces[2].text.slice(0, 1000) },
    { id: "final", text: pieces[2].text },
  ];
  const matches = matchLegacy([{ id: "row", text: pieces[2].text, truncated: false }], both);
  assert.equal(matches.get("row")?.pieceId, "final");
  assert.equal(matches.get("row")?.containment, 1);
});

test("texts too short for the sample screen are still compared", () => {
  // About 20 samples each, under the screen's 32.
  const short = essay(6, 150);
  const matches = matchLegacy(
    [
      { id: "short-copy", text: short, truncated: false },
      { id: "with-note", text: `老總：附上。${short}`, truncated: false },
    ],
    [...pieces, { id: "short", text: short }]
  );
  assert.equal(matches.get("short-copy")?.pieceId, "short");
  assert.equal(matches.get("with-note")?.pieceId, "short");

  // One shingle, and not a sampled one: only the size check finds it.
  const bare = "的".repeat(50);
  assert.equal(shingles(bare).filter(sampled).length, 0);
  assert.equal(matchLegacy([{ id: "bare", text: bare, truncated: false }], [{ id: "bare-piece", text: bare }]).get("bare")?.pieceId, "bare-piece");
});

test("nothing to match against leaves every row unmatched", () => {
  assert.equal(matchLegacy([{ id: "row", text: essay(5), truncated: false }], []).size, 0);
  assert.equal(matchLegacy([], pieces).size, 0);
});

test("a work with no title is named by the start of its text", () => {
  assert.equal(titleFor(" 自由市場的代價 ", "正文"), "自由市場的代價");
  assert.equal(titleFor(null, "\n\n第一句。\n第二句。"), "第一句。");
  assert.equal(titleFor(null, "字".repeat(50)), `${"字".repeat(40)}…`);
  assert.equal(titleFor("", ""), "(untitled)");
});

// Simon's rules (2026-10-15) for the old rows that are no copy.

test("a link names a YouTube video in any of its forms", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=x",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
  ]) {
    assert.equal(videoIdOf(url), "dQw4w9WgXcQ", url);
  }
  for (const url of [null, "", "not a url", "https://www.youtube.com/@leesimon", "https://example.org/watch?v=dQw4w9WgXcQ"]) {
    assert.equal(videoIdOf(url), null, String(url));
  }
});

test("titles compare without reply markers, columns, dates or punctuation", () => {
  assert.equal(titleKey("FW: 利字當頭：香港出不了李光耀"), titleKey("香港出不了李光耀"));
  assert.equal(titleKey("蘋果論壇投稿：政府的責任是甚麼？"), titleKey("政府的責任是甚麼"));
  assert.equal(titleKey("【實用經濟學】聯繫匯率會有怎樣的結局？"), titleKey("聯繫匯率會有怎樣的結局"));
  assert.equal(titleKey("The Long Game"), titleKey("the long game"));
  assert.equal(titleKey("2020 04 08"), ""); // a date is no title
  assert.notEqual(titleKey("炫富論"), titleKey("炊富論"));
});

test("a reply, a pitch or a blurb is a fragment; a short post is not", () => {
  assert.equal(isFragment("今日沒有其他補充。"), true);
  assert.equal(isFragment(`Dear Simon, thanks for sharing. ${essay(10, 600)}`), true);
  assert.equal(isFragment(`Hi Simon 首先感謝你的文章。${essay(11, 900)}`), true);
  assert.equal(isFragment(essay(12, 220)), false);
});

test("an old row that is no copy goes to a video, a same-titled work, a fuller row, out of search, or stays", () => {
  const work = { id: "piece", text: essay(20, 2400), titles: ["第四個生產要素", "第四個生產要素 final"] };
  const full = essay(21, 3000);
  const fuller = `${full}${essay(22, 1200)}`;
  const rows = [
    { id: "video", title: "【片】", text: essay(23, 1500), url: "https://youtu.be/dQw4w9WgXcQ", truncated: false },
    // The import kept only its start: too short for the copy test.
    { id: "start", title: "利字當頭：第四個生產要素", text: work.text.slice(0, 600), url: null, truncated: false },
    // The same title, another text: no.
    { id: "namesake", title: "第四個生產要素", text: essay(24, 900), url: null, truncated: false },
    { id: "reply", title: "RE: 第四個生產要素", text: "收到，多謝。", url: null, truncated: false },
    // A garbled excerpt of a row that is itself in a fuller row: both go to
    // the fullest.
    { id: "excerpt", title: "節錄", text: full.slice(0, 700).replace(/的/g, "旳"), url: null, truncated: false },
    { id: "full", title: "全文", text: full, url: null, truncated: false },
    { id: "fuller", title: "全文（增訂）", text: fuller, url: null, truncated: false },
    // The same title and a third of the text: a version of it.
    { id: "draft", title: "增訂本", text: `${fuller.slice(0, 500)}${essay(25, 900)}`, url: null, truncated: false },
    { id: "final", title: "增訂本", text: fuller.slice(0, 2400), url: null, truncated: false },
    { id: "alone", title: "獨文", text: essay(26, 1500), url: null, truncated: false },
  ];
  // Neither the start nor the excerpt passes the copy test.
  assert.equal(matchLegacy(rows, [work]).size, 0);

  const placed = placeUnmatched(rows, [work]);
  assert.deepEqual(placed.get("video"), { kind: "video", videoId: "dQw4w9WgXcQ" });
  assert.deepEqual(placed.get("start"), { kind: "title", pieceId: "piece" });
  assert.deepEqual(placed.get("namesake"), { kind: "kept" });
  assert.deepEqual(placed.get("reply"), { kind: "fragment" });
  assert.deepEqual(placed.get("excerpt"), { kind: "duplicate", rowId: "fuller" });
  assert.deepEqual(placed.get("full"), { kind: "duplicate", rowId: "fuller" });
  assert.deepEqual(placed.get("fuller"), { kind: "kept" });
  assert.deepEqual(placed.get("draft"), { kind: "duplicate", rowId: "fuller" });
  assert.deepEqual(placed.get("final"), { kind: "duplicate", rowId: "fuller" });
  assert.deepEqual(placed.get("alone"), { kind: "kept" });
});
