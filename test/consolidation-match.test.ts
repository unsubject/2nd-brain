// Step 3 (match): similarity, grouping and the canonical choice. Pure
// functions on synthetic candidates; no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatePairs, overlap, samePiece, sampled, shingles, units } from "../src/archive/consolidation/match/similarity";
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

test("texts too short to sample still pair: identical copies are one work (Codex on #98)", () => {
  // One de-duplicated shingle, not in the sampled slice.
  const tiny = "的".repeat(50);
  assert.deepEqual(candidatePairs([shingles(tiny), shingles(essay(60)), shingles(tiny)]), [[0, 2]]);
  for (let seed = 0; seed < 50; seed++) {
    const short = essay(7000 + seed, 40);
    const { works } = matchCandidates([cand({ bodyText: short }), cand({ bodyText: essay(8000 + seed) }), cand({ bodyText: short })]);
    assert.equal(works.length, 2, `seed ${seed}`);
  }
});

test("a short pair with too few samples for the screen is still checked (Codex on #98)", () => {
  // Codex's case: 47 shingles each, 64% containment, 9 samples each of
  // which only 2 are shared, under the 30% screen.
  const a = essay(16252, 50);
  const b = a.slice(0, 33) + essay(507817, 17);
  const [sa, sb] = [shingles(a), shingles(b)];
  assert.ok(samePiece(overlap(sa, sb)));
  assert.deepEqual(candidatePairs([sa, sb]), [[0, 1]]);
  assert.equal(matchCandidates([cand({ bodyText: a }), cand({ bodyText: b })]).works.length, 1);
});

// Sampled and unsampled shingle hashes, for building index cases directly.
const SAMPLED: number[] = [];
const UNSAMPLED: number[] = [];
for (let h = 1; SAMPLED.length < 60000 || UNSAMPLED.length < 2000; h++) (sampled(h) ? SAMPLED : UNSAMPLED).push(h);
let nextSampled = 0;
let nextUnsampled = 0;
const fresh = (n: number) => SAMPLED.slice(nextSampled, (nextSampled += n));
const unsampled = (n: number) => UNSAMPLED.slice(nextUnsampled, (nextUnsampled += n));
const set = (...parts: number[][]) => Uint32Array.from(parts.flat()).sort();
const paired = (pairs: [number, number][], i: number, j: number) => pairs.some(([a, b]) => a === i && b === j);

test("a pair whose shared samples are all common is still checked (Codex on #98)", () => {
  // Codex's case: 100 earlier texts each hold a rotating 50 of a 100-sample
  // pool plus 100 unique samples; two identical texts hold the pool, so
  // every pool sample is in 52 texts, over the cap.
  const pool = fresh(100);
  const earlier = Array.from({ length: 100 }, (_, k) => set(Array.from({ length: 50 }, (_, t) => pool[(k + t) % 100]), fresh(100)));
  const sets = [...earlier, set(pool), set(pool)];
  assert.ok(samePiece(overlap(sets[100], sets[101])));
  assert.ok(paired(candidatePairs(sets), 100, 101));
});

test("the screen counts common shared samples too (Codex on #98)", () => {
  // Codex's case: 100 shingles each, 60 shared; each text has 20 shared
  // common samples and 32 ordinary ones of which only 9 are shared (under
  // 30% of 32), and 38.5% of its samples common (under the fallback's 40%).
  const common = fresh(20);
  const ordinaryShared = fresh(9);
  const unsampledShared = unsampled(31);
  const version = () => set(common, ordinaryShared, fresh(23), unsampledShared, unsampled(17));
  const holders = Array.from({ length: 49 }, () => set(common, fresh(200)));
  const sets = [version(), version(), ...holders];
  assert.equal(overlap(sets[0], sets[1]).containment, 0.6);
  assert.ok(samePiece(overlap(sets[0], sets[1])));
  assert.ok(paired(candidatePairs(sets), 0, 1));
});

test("a pair sharing only common samples is still checked (Codex on #98)", () => {
  // Codex's case: 148 shingles each, 89 shared: 39 common samples and 50
  // unsampled shingles. Each text's 59 ordinary samples are its own, and
  // 39 of its 98 samples (under the fallback's 40%) are common.
  const common = fresh(39);
  const unsampledShared = unsampled(50);
  const version = () => set(common, unsampledShared, fresh(59));
  const holders = Array.from({ length: 49 }, () => set(common, fresh(200)));
  const sets = [version(), version(), ...holders];
  assert.ok(samePiece(overlap(sets[0], sets[1])));
  assert.ok(paired(candidatePairs(sets), 0, 1));
});

test("two versions whose shared part the archive quotes widely are still checked", () => {
  // 64% of each version is a passage also quoted in 60 longer texts (too
  // long to be the same piece); each version has 40 samples of its own.
  const passage = fresh(70);
  const quoting = Array.from({ length: 60 }, () => set(passage, fresh(300)));
  const sets = [...quoting, set(passage, fresh(40)), set(passage, fresh(40))];
  assert.ok(samePiece(overlap(sets[60], sets[61])));
  assert.equal(samePiece(overlap(sets[0], sets[60])), false);
  assert.ok(paired(candidatePairs(sets), 60, 61));
});

test("a piece with more copies than the stock-phrase cap still forms one work (Codex on #98)", () => {
  const text = essay(70);
  const copies = Array.from({ length: 60 }, () => cand({ bodyText: text }));
  const other = cand({ bodyText: essay(71) });
  const { works } = matchCandidates([...copies, other]);
  assert.equal(works.length, 2);
  assert.deepEqual(works.map((w) => w.members.length).sort((a, b) => a - b), [1, 60]);
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

test("a .docx canonical takes its work's title from a message or published copy, not its file name (Codex, follow-up on #96)", () => {
  // Sent as final.docx to forum@ with a covering note (dropped as a reply),
  // later posted on Substack.
  const text = essay(80);
  const docx = cand({ kind: "attachment", column: "蘋果論壇", title: "final", bodyText: text });
  const substack = cand({
    source: "substack",
    kind: "post",
    outlet: "Substack",
    column: null,
    title: "專業議政是擴闊泛民光譜的關鍵",
    bodyText: text,
    publishedAt: new Date("2021-01-05T00:00:00Z"),
    authoredAt: new Date("2021-01-05T00:00:00Z"),
  });
  const forum = matchCandidates([docx, substack]).works[0];
  assert.equal(forum.canonicalId, docx.id);
  assert.equal(forum.title, "專業議政是擴闊泛民光譜的關鍵");
  assert.equal(forum.column, "蘋果論壇");

  // A Drive document is named by its file too: the .docx keeps its own title.
  const other = essay(81);
  const column = cand({ kind: "attachment", title: "科目三", bodyText: other });
  const drive = cand({ source: "gdrive", kind: "doc", outlet: null, isPublished: null, title: "利字當頭 20240220", bodyText: other });
  const w = matchCandidates([drive, column]).works[0];
  assert.equal(w.canonicalId, column.id);
  assert.equal(w.title, "科目三");
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
