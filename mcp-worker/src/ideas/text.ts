// Pure text helpers for the Idea Parking Lot tools.

// Escape LIKE/ILIKE wildcards; used with the default '\' escape char.
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Trim, drop empties, dedupe (case-insensitive, first spelling wins).
export function normalizeTags(tags: readonly string[] | undefined | null): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// Title key for duplicate detection: NFKC, lower-case, no punctuation,
// symbols or whitespace. Works for mixed English / Chinese titles.
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Equal normalized titles, or one contains the other when the shorter
// side is substantial (>= 6 latin chars or >= 3 CJK chars).
export function titlesLikelySame(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  const substantial = CJK.test(shorter) ? shorter.length >= 3 : shorter.length >= 6;
  return substantial && longer.includes(shorter);
}

export function snippet(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Whitespace-separated search terms (max 5). A CJK phrase without spaces
// stays one term, which ILIKE matches as a substring.
export function searchTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);
}
