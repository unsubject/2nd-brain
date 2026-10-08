// Step 3 (match): similarity, grouping and the canonical choice. Pure
// functions on synthetic candidates; no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatePairs, overlap, samePiece, shingles, units } from "../src/archive/consolidation/match/similarity";
import { canonicalRank, matchCandidates, type MatchCandidate } from "../src/archive/consolidation/match/cluster";
import { parseWorkListQuery } from "../src/archive/consolidation/match/review";

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

let n = 0;
function cand(over: Partial<MatchCandidate>): MatchCandidate {
  n += 1;
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    source: "gmail",
    kind: "submission",
    status: "keep",
    title: null,
    outlet: "蘋果日報",
    column: "利字當頭",
    publishedAt: new Date("2020-06-30T00:00:00Z"),
    isPublished: true,
    authoredAt: new Date("2020-06-29T11:00:00Z"),
    bodyText: essay(1),
    ...over,
  };
}

test("units: one per Chinese character or Latin word; spacing, case and punctuation don't count", () => {
  assert.deepEqual(units("香港 GDP，佔 3%！"), ["香", "港", "gdp", "佔", "3"]);
  assert.deepEqual(shingles("ＡＢＣ 香港經濟的問題"), shingles("abc，香港 經濟的 問題。"));
});

test("an edited resend is the same piece; an excerpt quoted in another essay is not", () => {
  const text = essay(7);
  const edited = text.slice(0, 500) + essay(99, 40) + text.slice(540);
  const o = overlap(shingles(text), shingles(edited));
  assert.ok(o.jaccard > 0.8, `jaccard ${o.jaccard}`);
  assert.ok(samePiece(o));

  const excerpt = text.slice(0, 200);
  const quoting = essay(8) + excerpt + essay(9);
  const q = overlap(shingles(excerpt), shingles(quoting));
  assert.ok(q.containment > 0.9);
  assert.equal(samePiece(q), false);

  assert.equal(samePiece(overlap(shingles(essay(10)), shingles(essay(11)))), false);
});

test("a much shorter copy contained in a longer text is always found (Codex P1 on #97)", () => {
  // Jaccard is only about the size ratio here (0.3–0.45), where banded
  // MinHash missed up to ~40% of such pairs; the sampled index must not.
  for (let seed = 0; seed < 40; seed++) {
    const long = essay(500 + seed, 3000);
    const ratio = 0.31 + (seed % 5) * 0.035;
    const short = long.slice(0, Math.round(long.length * ratio));
    const sets = [shingles(long), shingles(essay(900 + seed)), shingles(short)];
    assert.deepEqual(candidatePairs(sets), [[0, 2]], `seed ${seed}, ratio ${ratio}`);
    assert.ok(samePiece(overlap(sets[0], sets[2])));
  }
});

test("copies across sources form one work; the last version emailed to the outlet is canonical", () => {
  const text = essay(20);
  const first = cand({ bodyText: text, authoredAt: new Date("2020-06-29T11:00:00Z") });
  const resend = cand({
    bodyText: text.slice(0, 300) + "（修訂）" + text.slice(300),
    authoredAt: new Date("2020-06-29T14:00:00Z"),
    title: "理財通",
  });
  const substack = cand({
    source: "substack",
    kind: "post",
    outlet: "Substack",
    column: null,
    bodyText: "舊文重溫。\n\n" + text,
    publishedAt: new Date("2021-01-05T00:00:00Z"),
    authoredAt: new Date("2021-01-05T00:00:00Z"),
  });
  const drive = cand({ source: "gdrive", kind: "doc", outlet: null, isPublished: null, bodyText: text });
  const other = cand({ bodyText: essay(21) });

  const { works } = matchCandidates([substack, drive, other, first, resend]);
  assert.equal(works.length, 2);
  const w = works.find((x) => x.members.length === 4)!;
  assert.equal(w.canonicalId, resend.id);
  assert.equal(w.title, "理財通");
  assert.equal(w.publishedAt?.toISOString().slice(0, 10), "2020-06-30");
  assert.equal(w.outlet, "蘋果日報");
  assert.deepEqual(w.outlets, ["蘋果日報", "Substack"]);
  assert.equal(w.status, "keep");
  assert.deepEqual(
    w.members.map((m) => [m.candidateId, m.role]),
    [
      [resend.id, "canonical"],
      [first.id, "copy"],
      [substack.id, "copy"],
      [drive.id, "copy"],
    ]
  );
  assert.ok(w.members.every((m) => m.similarity > 0.8));
});

test("canonical order: emailed to an outlet, Substack, WordPress, newsletter, other email, Drive, the rest", () => {
  const ranks = [
    cand({}),
    cand({ source: "substack", kind: "post" }),
    cand({ source: "wordpress", kind: "post" }),
    cand({ kind: "newsletter" }),
    cand({ outlet: null }),
    cand({ source: "gdrive", kind: "doc" }),
    cand({ kind: "self_draft" }),
  ].map(canonicalRank);
  assert.deepEqual(ranks, [0, 1, 2, 3, 4, 5, 6]);
});

test("an unpublished WordPress page or private post never outranks a published newsletter (Codex P2 on #97)", () => {
  const text = essay(50);
  const newsletter = cand({ source: "gmail", kind: "newsletter", outlet: "Revue", bodyText: text });
  const privatePost = cand({ source: "wordpress", kind: "post", status: "review", isPublished: false, outlet: "WordPress (leesimon.me)", bodyText: text });
  const page = cand({ source: "wordpress", kind: "page", status: "review", isPublished: true, outlet: "WordPress (leesimon.me)", bodyText: text });
  assert.equal(canonicalRank(privatePost), 6);
  assert.equal(canonicalRank(page), 6);
  const { works } = matchCandidates([privatePost, page, newsletter]);
  assert.equal(works.length, 1);
  assert.equal(works[0].canonicalId, newsletter.id);
  assert.equal(works[0].status, "keep");
  assert.deepEqual(works[0].reasons, []);
});

test("a piece never published, or whose canonical is in review, is a work to review", () => {
  const draft = cand({ kind: "self_draft", status: "review", isPublished: false, bodyText: essay(30) });
  const unsure = cand({ status: "review", bodyText: essay(31) });
  const { works } = matchCandidates([draft, unsure]);
  const byId = new Map(works.map((w) => [w.canonicalId, w]));
  assert.equal(byId.get(draft.id)?.status, "review");
  assert.deepEqual(byId.get(draft.id)?.reasons, ["unpublished", "canonical-needs-review"]);
  assert.equal(byId.get(unsure.id)?.status, "review");
  assert.deepEqual(byId.get(unsure.id)?.reasons, ["canonical-needs-review"]);
});

test("a copy much changed from the canonical is noted", () => {
  const text = essay(40);
  // A third of it rewritten: still the same piece, but noticeably changed.
  const rewritten = text.slice(0, 800) + essay(41, 400);
  const { works } = matchCandidates([cand({ bodyText: text }), cand({ source: "gdrive", kind: "doc", bodyText: rewritten })]);
  assert.equal(works.length, 1);
  assert.deepEqual(works[0].reasons, ["versions-differ"]);
  assert.equal(works[0].status, "keep");
});

test("the works list validates its parameters", () => {
  assert.deepEqual(parseWorkListQuery({}), { limit: 50, offset: 0 });
  assert.deepEqual(parseWorkListQuery({ status: "review", limit: "5", offset: "10" }), { status: "review", limit: 5, offset: 10 });
  assert.match(parseWorkListQuery({ status: "drop" }) as string, /^status must be/);
  assert.match(parseWorkListQuery({ limit: "0" }) as string, /^limit must be/);
});
