// Text similarity for step 3 (match): which candidates are the same piece.
// A text becomes a set of hashed 4-unit shingles, where a unit is one
// Chinese/Japanese character or one Latin word, so a Cantonese column and
// an English essay are measured alike and whitespace and punctuation don't
// count. Sampled shingles find likely pairs without comparing every pair;
// each is then checked exactly.

const SHINGLE = 4;

const UNIT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu;

export function units(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(UNIT) ?? [];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Sorted, de-duplicated shingle hashes. A text shorter than one shingle is
// a single shingle of all its units.
export function shingles(text: string): Uint32Array {
  const u = units(text);
  const set = new Set<number>();
  if (u.length > 0 && u.length < SHINGLE) set.add(fnv1a(u.join("\u0001")));
  for (let i = 0; i + SHINGLE <= u.length; i++) set.add(fnv1a(u.slice(i, i + SHINGLE).join("\u0001")));
  return Uint32Array.from(set).sort();
}

function mix(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

// Candidate pairs. Every text keeps the shingles whose (mixed) hash falls
// in one fixed 1-in-SAMPLE slice; since the rule is the same for every
// text, a shingle sampled in a short copy is sampled in the long text too,
// so the share of the shorter text's samples found in the other estimates
// containment. (MinHash estimates Jaccard instead, which is low for a short
// copy of a long text: at a 0.3 size ratio, banded LSH missed about 40% of
// fully contained copies.) The screen is generous; overlap() decides.
const SAMPLE = 8;
// A sampled shingle in more texts than this is boilerplate or a stock
// phrase ("香港政府"): it says nothing about which texts are the same piece.
const COMMON = 50;
const MIN_SHARED = 0.3;
const ID_SPACE = 65536;

function sampled(h: number): boolean {
  return mix(h) % SAMPLE === 0;
}

// Index pairs [i, j] (i < j) worth checking exactly.
export function candidatePairs(sets: Uint32Array[]): [number, number][] {
  if (sets.length >= ID_SPACE) throw new Error(`candidatePairs: at most ${ID_SPACE - 1} texts`);
  // (hash, text) packed in one float so a native numeric sort groups each
  // shingle's texts; ids ascend within a group because texts are added in order.
  const entries: number[] = [];
  sets.forEach((set, i) => {
    for (const h of set) if (sampled(h)) entries.push(h * ID_SPACE + i);
  });
  const packed = Float64Array.from(entries).sort();
  const useful = new Uint32Array(sets.length);
  const shared = new Map<number, number>();
  for (let start = 0; start < packed.length; ) {
    const hash = Math.floor(packed[start] / ID_SPACE);
    let end = start + 1;
    while (end < packed.length && Math.floor(packed[end] / ID_SPACE) === hash) end++;
    const n = end - start;
    if (n <= COMMON) {
      for (let x = start; x < end; x++) {
        const i = packed[x] % ID_SPACE;
        useful[i]++;
        for (let y = x + 1; y < end; y++) {
          const key = i * ID_SPACE + (packed[y] % ID_SPACE);
          shared.set(key, (shared.get(key) ?? 0) + 1);
        }
      }
    }
    start = end;
  }
  const pairs: [number, number][] = [];
  for (const [key, count] of shared) {
    const i = Math.floor(key / ID_SPACE);
    const j = key % ID_SPACE;
    if (count >= Math.max(1, Math.ceil(MIN_SHARED * Math.min(useful[i], useful[j])))) pairs.push([i, j]);
  }
  return pairs;
}

export function intersection(a: Uint32Array, b: Uint32Array): number {
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      n++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return n;
}

export interface Overlap {
  jaccard: number;
  // Share of the shorter text found in the longer: a version with an added
  // preface, or a cut-down copy, still scores high.
  containment: number;
  sizeRatio: number;
}

export function overlap(a: Uint32Array, b: Uint32Array): Overlap {
  if (a.length === 0 || b.length === 0) return { jaccard: 0, containment: 0, sizeRatio: 0 };
  const n = intersection(a, b);
  return {
    jaccard: n / (a.length + b.length - n),
    containment: n / Math.min(a.length, b.length),
    sizeRatio: Math.min(a.length, b.length) / Math.max(a.length, b.length),
  };
}

// Same piece: most of the shorter text is in the longer, and the shorter is
// not a mere excerpt (a paragraph quoted in another essay).
export const SAME_PIECE = { containment: 0.6, sizeRatio: 0.3 };

export function samePiece(o: Overlap): boolean {
  return o.containment >= SAME_PIECE.containment && o.sizeRatio >= SAME_PIECE.sizeRatio;
}
