// Step 4: which work replaces each row of the first import (Notion,
// 2026-04/05). A row is replaced by the piece it is a copy of: the test
// step 3 uses to join versions (samePiece), or, for a row the import cut
// short, most of the row found in the piece whatever their sizes. Rows are
// compared with every member of every work, not only the canonical text,
// since the import often holds the version sent to the editor.
//
// Rows are only ever compared with pieces, never with each other, so only
// the pieces are indexed (by the same 1-in-8 sample of shingles as step 3)
// and each row looks up the pieces that share its samples. Indexing the
// rows too would double every sample's count, push stock phrases over step
// 3's cap and send thousands of texts to its exhaustive check.

import { bareTitle, cleanSubject } from "../extract/gmail";
import { intersection, overlap, SAME_PIECE, samePiece, sampled, shingles } from "../match/similarity";

// The first import cut long texts at this many characters.
export const IMPORT_CUT = 2000;
// As in step 3: a pair is checked exactly when it shares at least this
// share of the smaller text's samples; a text with fewer samples than
// MIN_SAMPLES is checked against every text of a size it could match.
const MIN_SHARED = 0.3;
const MIN_SAMPLES = 32;

export interface LegacyRow {
  id: string;
  text: string;
  // Cut at IMPORT_CUT: only the start of the piece is there.
  truncated: boolean;
}

export interface Piece {
  id: string;
  text: string;
}

export interface LegacyMatch {
  pieceId: string;
  // Share of the shorter text found in the longer.
  containment: number;
}

// Indexes of `sizes` (sorted ascending) whose value could be the same piece
// as a text of size n.
function sizeRange(order: number[], sizes: number[], n: number): number[] {
  const firstAtLeast = (v: number) => {
    let lo = 0;
    let hi = sizes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sizes[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return order.slice(firstAtLeast(Math.ceil(n * SAME_PIECE.sizeRatio)), firstAtLeast(Math.floor(n / SAME_PIECE.sizeRatio) + 1));
}

// The best piece for each row that has one.
export function matchLegacy(rows: LegacyRow[], pieces: Piece[]): Map<string, LegacyMatch> {
  const pieceSets = pieces.map((p) => shingles(p.text));
  const rowSets = rows.map((r) => shingles(r.text));
  const pieceSamples = pieceSets.map((s) => s.filter(sampled));
  const rowSamples = rowSets.map((s) => s.filter(sampled));

  const index = new Map<number, number[]>();
  pieceSamples.forEach((samples, p) => {
    for (const h of samples) {
      const list = index.get(h);
      if (list) list.push(p);
      else index.set(h, [p]);
    }
  });

  const best = new Map<string, LegacyMatch>();
  const check = (r: number, p: number) => {
    const row = rows[r];
    const o = overlap(rowSets[r], pieceSets[p]);
    const ofRow = rowSets[r].length > 0 ? intersection(rowSets[r], pieceSets[p]) / rowSets[r].length : 0;
    if (!samePiece(o) && !(row.truncated && ofRow >= SAME_PIECE.containment)) return;
    const prev = best.get(row.id);
    if (!prev || o.containment > prev.containment) best.set(row.id, { pieceId: pieces[p].id, containment: o.containment });
  };
  const bySize = (sets: Uint32Array[]) => {
    const order = sets.map((_, i) => i).sort((a, b) => sets[a].length - sets[b].length);
    return { order, sizes: order.map((i) => sets[i].length) };
  };
  const piecesBySize = bySize(pieceSets);

  const count = new Uint32Array(pieces.length);
  rows.forEach((_, r) => {
    const samples = rowSamples[r];
    const toCheck = new Set<number>();
    if (samples.length < MIN_SAMPLES && rowSets[r].length > 0) {
      for (const p of sizeRange(piecesBySize.order, piecesBySize.sizes, rowSets[r].length)) toCheck.add(p);
    }
    const touched: number[] = [];
    for (const h of samples) {
      for (const p of index.get(h) ?? []) if (count[p]++ === 0) touched.push(p);
    }
    for (const p of touched) {
      const needed = Math.max(1, Math.ceil(MIN_SHARED * Math.min(samples.length, pieceSamples[p].length)));
      if (count[p] >= needed) toCheck.add(p);
      count[p] = 0;
    }
    for (const p of toCheck) check(r, p);
  });

  // A piece too short for the screen: every row of a size it could match.
  const rowsBySize = bySize(rowSets);
  pieceSamples.forEach((samples, p) => {
    if (samples.length >= MIN_SAMPLES || pieceSets[p].length === 0) return;
    for (const r of sizeRange(rowsBySize.order, rowsBySize.sizes, pieceSets[p].length)) check(r, p);
  });
  return best;
}

// ── Rows no copy test matches (Simon, 2026-10-15) ─────────────────────────
//
// In order, an old row that is not a copy of any version:
//   - a copy of a video's transcript (its link names a YouTube video) goes
//     to that video's transcript row; with none, it stays, flagged 'video';
//   - one with the same title as a work, and at least TITLE_SHARE of its
//     text found in a version of it, goes to that work: the import kept many
//     pieces only in part, too short for the copy test;
//   - a fragment (a reply, a pitch, a blurb) leaves search;
//   - one whose text is mostly in a fuller old row (or, with the same
//     title, a TITLE_SHARE of it) is merged into that row;
//   - anything else is kept as it is: the only copy of the piece.

export const TITLE_SHARE = 0.3;
// Fewer characters than this (whitespace aside) is a note, not a piece.
export const FRAGMENT_CHARS = 200;

export interface OldRow extends LegacyRow {
  title: string;
  url: string | null;
}

export interface TitledPiece extends Piece {
  // The titles it goes by: its work's, and its own.
  titles: (string | null)[];
}

export type Placement =
  | { kind: "video"; videoId: string }
  | { kind: "title"; pieceId: string }
  | { kind: "duplicate"; rowId: string }
  | { kind: "fragment" }
  | { kind: "kept" };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// The YouTube video a link names, if any.
export function videoIdOf(url: string | null): string | null {
  let u: URL;
  try {
    u = new URL(url ?? "");
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, "");
  const id =
    host === "youtu.be"
      ? u.pathname.split("/")[1]
      : host === "youtube.com"
        ? u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]
        : undefined;
  return id && VIDEO_ID.test(id) ? id : null;
}

// A title as compared: no reply marker, column, date or author, and no
// punctuation, spaces or case. Empty when nothing is left (a date).
export function titleKey(title: string | null): string {
  return bareTitle(cleanSubject(title))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

// A note rather than a piece: a few words, or a letter to Simon.
export function isFragment(text: string): boolean {
  return text.replace(/\s+/g, "").length < FRAGMENT_CHARS || /^\s*(dear|hi|hello)\s+simon\b/i.test(text);
}

// Where each row (one no copy test matched) goes. `replaced`: the old rows
// the copy test did match, which a duplicate may go to (Codex on #114).
export function placeUnmatched(rows: OldRow[], pieces: TitledPiece[], replaced: OldRow[] = []): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const rowSets = new Map([...rows, ...replaced].map((r) => [r.id, shingles(r.text)]));
  const share = (row: Uint32Array, other: Uint32Array) => (row.length > 0 ? intersection(row, other) / row.length : 0);

  const piecesByTitle = new Map<string, number[]>();
  pieces.forEach((p, i) => {
    for (const key of new Set(p.titles.map(titleKey))) {
      if (!key) continue;
      const list = piecesByTitle.get(key);
      if (list) list.push(i);
      else piecesByTitle.set(key, [i]);
    }
  });
  const pieceSets = new Map<number, Uint32Array>();
  const pieceSet = (i: number) => {
    let set = pieceSets.get(i);
    if (!set) pieceSets.set(i, (set = shingles(pieces[i].text)));
    return set;
  };

  const rest: OldRow[] = [];
  const titled: OldRow[] = [];
  const videos: OldRow[] = [];
  for (const r of rows) {
    const videoId = videoIdOf(r.url);
    if (videoId) {
      out.set(r.id, { kind: "video", videoId });
      videos.push(r);
      continue;
    }
    let best: { i: number; share: number } | null = null;
    for (const i of piecesByTitle.get(titleKey(r.title)) ?? []) {
      const s = share(rowSets.get(r.id)!, pieceSet(i));
      if (s >= TITLE_SHARE && (!best || s > best.share)) best = { i, share: s };
    }
    if (best) {
      out.set(r.id, { kind: "title", pieceId: pieces[best.i].id });
      titled.push(r);
    } else if (isFragment(r.text)) out.set(r.id, { kind: "fragment" });
    else rest.push(r);
  }

  // Duplicates among the rest: each goes to the fullest row that holds it
  // (most of its text, or the same title and a TITLE_SHARE of it): another
  // of the rest, a row already replaced (a copy, or one placed by title),
  // or a copy of a video (Codex on #114), whose replacement, if any, it then
  // shares. Always a larger row (more shingles, then the greater id), so a
  // chain ends, at a row that stays or one placed otherwise. Hosts are
  // screened as copies are, by shared samples; a row too short for that is
  // checked against every host.
  const hosts = [...rest, ...replaced, ...titled, ...videos];
  const larger = (a: OldRow, b: OldRow) => {
    const d = rowSets.get(a.id)!.length - rowSets.get(b.id)!.length;
    return d !== 0 ? d > 0 : a.id > b.id;
  };
  const index = new Map<number, number[]>();
  hosts.forEach((h, i) => {
    for (const x of rowSets.get(h.id)!.filter(sampled)) {
      const list = index.get(x);
      if (list) list.push(i);
      else index.set(x, [i]);
    }
  });
  const count = new Uint32Array(hosts.length);
  const into = new Map<string, OldRow>();
  for (const r of rest) {
    const set = rowSets.get(r.id)!;
    const samples = set.filter(sampled);
    let candidates: Iterable<number>;
    if (samples.length < MIN_SAMPLES) candidates = hosts.keys();
    else {
      const touched: number[] = [];
      for (const x of samples) for (const i of index.get(x) ?? []) if (count[i]++ === 0) touched.push(i);
      const needed = Math.ceil(TITLE_SHARE * samples.length);
      candidates = touched.filter((i) => count[i] >= needed);
      for (const i of touched) count[i] = 0;
    }
    const key = titleKey(r.title);
    let host: OldRow | null = null;
    for (const i of candidates) {
      const o = hosts[i];
      if (o === r || !larger(o, r) || (host && !larger(o, host))) continue;
      const s = share(set, rowSets.get(o.id)!);
      if (s >= SAME_PIECE.containment || (key !== "" && key === titleKey(o.title) && s >= TITLE_SHARE)) host = o;
    }
    if (host) into.set(r.id, host);
  }
  for (const r of rest) {
    let host = into.get(r.id);
    if (!host) {
      out.set(r.id, { kind: "kept" });
      continue;
    }
    while (into.has(host.id)) host = into.get(host.id)!;
    out.set(r.id, { kind: "duplicate", rowId: host.id });
  }
  return out;
}
