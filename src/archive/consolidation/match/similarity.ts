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
// A sampled shingle in more texts than this is common: mostly a stock
// phrase ("香港政府"). Its texts aren't paired with each other (quadratic,
// and it says little); a pair found through an ordinary sample then counts
// its common samples too, so the screen judges all shared samples.
const COMMON = 50;
const MIN_SHARED = 0.3;
// Pairs are found only through shared ordinary samples, so the index can't
// vouch for a text with fewer of them than MIN_SAMPLES (too short: a
// 50-character body can have none), nor for one whose samples are more than
// MAX_COMMON common (a piece with over 50 copies, or a passage the archive
// quotes widely, can share nothing ordinary). Such a text is checked against
// every text of a size it could be the same piece as. For the rest, a pair
// at the 60% containment limit is missed only by sampling noise: with 32
// samples, p ≈ 3e-5. (Checking every pair exactly took over two minutes for
// 4,300 texts; a 25% cutoff sent most texts of a stock-phrase-heavy corpus
// to the fallback, 5.7M checks.)
const MIN_SAMPLES = 32;
const MAX_COMMON = 0.4;
const ID_SPACE = 65536;

export function sampled(h: number): boolean {
  return mix(h) % SAMPLE === 0;
}

function bump(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
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
  // Ordinary and common samples per text (the common ones listed, in hash
  // order), and ordinary samples shared per pair.
  const rare = new Uint32Array(sets.length);
  const common = new Uint32Array(sets.length);
  const commonOf: number[][] = sets.map(() => []);
  const shared = new Map<number, number>();
  for (let start = 0; start < packed.length; ) {
    const hash = Math.floor(packed[start] / ID_SPACE);
    let end = start + 1;
    while (end < packed.length && Math.floor(packed[end] / ID_SPACE) === hash) end++;
    const isCommon = end - start > COMMON;
    for (let x = start; x < end; x++) {
      const i = packed[x] % ID_SPACE;
      if (isCommon) {
        common[i]++;
        commonOf[i].push(hash);
        continue;
      }
      rare[i]++;
      for (let y = x + 1; y < end; y++) bump(shared, i * ID_SPACE + (packed[y] % ID_SPACE));
    }
    start = end;
  }

  const commonSets = commonOf.map((list) => Uint32Array.from(list));
  const keys = new Set<number>();
  for (const [key, ordinary] of shared) {
    const i = Math.floor(key / ID_SPACE);
    const j = key % ID_SPACE;
    const all = ordinary + intersection(commonSets[i], commonSets[j]);
    const samples = Math.min(rare[i] + common[i], rare[j] + common[j]);
    if (all >= Math.max(1, Math.ceil(MIN_SHARED * samples))) keys.add(key);
  }

  // Texts the screen can't vouch for: every text within the size ratio
  // samePiece allows, found by size order.
  const bySize = sets.map((_, i) => i).sort((a, b) => sets[a].length - sets[b].length);
  const sizes = bySize.map((i) => sets[i].length);
  const firstAtLeast = (n: number) => {
    let lo = 0;
    let hi = sizes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sizes[mid] < n) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  sets.forEach((set, i) => {
    const screened = rare[i] >= MIN_SAMPLES && common[i] <= MAX_COMMON * (rare[i] + common[i]);
    if (set.length === 0 || screened) return;
    const from = firstAtLeast(Math.ceil(set.length * SAME_PIECE.sizeRatio));
    const to = firstAtLeast(Math.floor(set.length / SAME_PIECE.sizeRatio) + 1);
    for (let k = from; k < to; k++) {
      const j = bySize[k];
      if (j !== i) keys.add(Math.min(i, j) * ID_SPACE + Math.max(i, j));
    }
  });

  return [...keys].map((key) => [Math.floor(key / ID_SPACE), key % ID_SPACE] as [number, number]);
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
