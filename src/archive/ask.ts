import Anthropic from "@anthropic-ai/sdk";
import { hybridSearch, SearchResult } from "./search";

const anthropic = new Anthropic({ maxRetries: 6 });

export interface AskResponse {
  answer: string;
  sources: { title: string; publishedAt: Date | null }[];
}

export async function ask(query: string): Promise<AskResponse> {
  const results = await hybridSearch({ query, limit: 5 });

  if (results.length === 0) {
    return {
      answer: "Nothing in the archive matches that query yet.",
      sources: [],
    };
  }

  const context = results
    .map((r, i) => {
      const date = r.publishedAt
        ? new Date(r.publishedAt).toISOString().slice(0, 10)
        : "undated";
      const excerpt = r.chunkText || r.summary || "";
      return `[${i + 1}] "${r.title}" (${date})\n${excerpt.slice(0, 1200)}`;
    })
    .join("\n\n---\n\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system:
      "You are answering questions about the user's own published writing using retrieved excerpts from their archive. Be concise (≤4 short paragraphs). Quote or paraphrase specific points from the excerpts. Cite sources inline as [1], [2], etc. matching the numbered excerpts. If the excerpts don't actually answer the question, say so directly — do not pad. Answer in the same language as the query.",
    messages: [
      {
        role: "user",
        content: `Question: ${query}\n\nRetrieved excerpts from the archive:\n\n${context}`,
      },
    ],
  });

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  const answer = textBlock?.text ?? "No answer generated.";

  const sources = dedupeSources(results).slice(0, 5);

  return { answer, sources };
}

function dedupeSources(
  results: SearchResult[]
): { title: string; publishedAt: Date | null }[] {
  const seen = new Set<string>();
  const out: { title: string; publishedAt: Date | null }[] = [];
  for (const r of results) {
    if (seen.has(r.artifactId)) continue;
    seen.add(r.artifactId);
    out.push({ title: r.title, publishedAt: r.publishedAt });
  }
  return out;
}

export function formatForTelegram(response: AskResponse): string {
  if (response.sources.length === 0) return response.answer;

  const sourceLines = response.sources
    .map((s, i) => {
      const date = s.publishedAt
        ? new Date(s.publishedAt).toISOString().slice(0, 10)
        : "undated";
      return `[${i + 1}] ${s.title} (${date})`;
    })
    .join("\n");

  return `${response.answer}\n\n— Sources —\n${sourceLines}`;
}
