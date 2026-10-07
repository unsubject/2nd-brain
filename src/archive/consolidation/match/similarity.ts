// Text similarity for step 3 (match): which candidates are the same piece.
// A text becomes a set of hashed 4-unit shingles, where a unit is one
// Chinese/Japanese character or one Latin word, so a Cantonese column and
// an English essay are measured alike and whitespace and punctuation don't
// count. MinHash with banded LSH finds likely pairs without comparing every
// pair; each is then checked exactly.

const SHINGLE = 4;
const BANDS = 32;
const ROWS = 3;
export const SIGNATURE_SIZE = BANDS * ROWS;

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

const SEEDS = Array.from({ length: SIGNATURE_SIZE }, (_, i) => mix(i * 0x9e3779b9 + 1));

export function minhash(set: Uint32Array): Uint32Array {
  const sig = new Uint32Array(SIGNATURE_SIZE).fill(0xffffffff);
  for (const x of set) {
    for (let i = 0; i < SIGNATURE_SIZE; i++) {
      const h = mix(x ^ SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

// Index pairs [i, j] (i < j) whose signatures agree on a whole band. With
// 32 bands of 3 rows, a pair at Jaccard 0.4 is found with p ≈ 0.88, at 0.6
// almost always.
export function candidatePairs(signatures: Uint32Array[]): [number, number][] {
  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (let b = 0; b < BANDS; b++) {
    const buckets = new Map<string, number[]>();
    signatures.forEach((sig, i) => {
      if (sig[0] === 0xffffffff) return; // empty text
      const key = Array.from(sig.subarray(b * ROWS, (b + 1) * ROWS)).join(",");
      const list = buckets.get(key);
      if (list) list.push(i);
      else buckets.set(key, [i]);
    });
    for (const list of buckets.values()) {
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const k = `${list[x]},${list[y]}`;
          if (seen.has(k)) continue;
          seen.add(k);
          pairs.push([list[x], list[y]]);
        }
      }
    }
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
