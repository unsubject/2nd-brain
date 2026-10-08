// Step 4 (load): which work replaces each row of the first import. Pure
// functions on synthetic texts; no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { IMPORT_CUT, matchLegacy } from "../src/archive/consolidation/load/legacy";
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
