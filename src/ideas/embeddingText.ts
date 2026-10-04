// The text embedded for an Idea Parking Lot idea. Keep in sync with the
// idea_before_update trigger (migrations/019_idea_parking_lot.sql): every
// field read here must clear the embedding when it changes.

// text-embedding-3-small accepts at most 8,191 tokens per input. Measured
// with cl100k: Traditional Chinese / Cantonese runs ~1.6–1.7 tokens per
// character, English ~0.25. Budget conservatively by estimate, not chars.
export const IDEA_EMBED_TOKEN_BUDGET = 7000;
const EXCERPT_MAX_CHARS = 1500;

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

function charTokens(ch: string): number {
  if (ch.charCodeAt(0) < 128) return 0.3;
  return CJK.test(ch) ? 1.8 : 1.0;
}

export function estimateTokens(text: string): number {
  let total = 0;
  for (const ch of text) total += charTokens(ch);
  return Math.ceil(total);
}

// Cut by code points (never splitting a surrogate pair) at the budget.
export function truncateToTokenBudget(text: string, budget = IDEA_EMBED_TOKEN_BUDGET): string {
  let total = 0;
  let out = "";
  for (const ch of text) {
    total += charTokens(ch);
    if (total > budget) break;
    out += ch;
  }
  return out;
}

export type IdeaNote = { at?: string; by?: string; text?: string };

export type IdeaEmbeddingFields = {
  title: string;
  framing: string | null;
  why_interesting: string | null;
  thoughts: string | null;
  notes: IdeaNote[] | null;
  source_title: string | null;
  source_excerpt: string | null;
  tags: string[] | null;
};

export function buildIdeaEmbeddingText(f: IdeaEmbeddingFields): string {
  // Only the user's own notes; agent/import/system notes are bookkeeping.
  const userNotes = (f.notes ?? [])
    .filter((n) => n && n.by === "simon" && typeof n.text === "string")
    .map((n) => n.text as string);
  const excerpt = f.source_excerpt ? Array.from(f.source_excerpt).slice(0, EXCERPT_MAX_CHARS).join("") : null;
  const parts = [
    f.title,
    f.framing,
    f.why_interesting,
    f.thoughts,
    ...userNotes,
    f.source_title,
    excerpt,
    f.tags && f.tags.length > 0 ? `tags: ${f.tags.join(", ")}` : null,
  ]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  return truncateToTokenBudget(parts.join("\n\n"));
}
