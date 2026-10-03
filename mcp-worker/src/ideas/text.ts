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
// symbols, whitespace, format characters or variation selectors.
// Works for mixed English / Chinese titles.
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Cf}\s︀-️]+/gu, '');
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export type TitleMatch = 'exact' | 'contains';

// 'exact' when the normalized titles are equal; 'contains' when one
// contains the other and the shorter side is substantial (>= 6 latin or
// >= 4 CJK chars). 'contains' is only ever a hint for the user to confirm.
export function titleMatch(a: string, b: string): TitleMatch | null {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return null;
  if (na === nb) return 'exact';
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  const len = Array.from(shorter).length;
  const substantial = CJK.test(shorter) ? len >= 4 : len >= 6;
  return substantial && longer.includes(shorter) ? 'contains' : null;
}

export function titlesLikelySame(a: string, b: string): boolean {
  return titleMatch(a, b) !== null;
}

// Truncate by code points so a surrogate pair is never split (a lone
// surrogate makes the JSON response unparseable for strict clients).
export function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

export function snippet(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return truncateChars(flat, max);
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
