// The text embedded for an Idea Parking Lot idea. Keep in sync with the
// idea_before_update trigger (migrations/019_idea_parking_lot.sql): every
// field read here must clear the embedding when it changes.

export const IDEA_EMBED_MAX_CHARS = 6000;
const EXCERPT_MAX_CHARS = 1500;

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
  const parts = [
    f.title,
    f.framing,
    f.why_interesting,
    f.thoughts,
    ...userNotes,
    f.source_title,
    f.source_excerpt ? f.source_excerpt.slice(0, EXCERPT_MAX_CHARS) : null,
    f.tags && f.tags.length > 0 ? `tags: ${f.tags.join(", ")}` : null,
  ]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  // ~1–1.5 tokens per CJK char keeps 6k chars under the 8,191-token limit.
  return parts.join("\n\n").slice(0, IDEA_EMBED_MAX_CHARS);
}
