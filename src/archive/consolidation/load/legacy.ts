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
