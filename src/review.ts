import Anthropic from "@anthropic-ai/sdk";
import { Marked } from "marked";
import * as queries from "./db/queries";

const anthropic = new Anthropic();
const marked = new Marked();

const SYSTEM_PROMPT = `You are the morning review synthesizer for a private journal system. You produce a daily briefing that orients the journal owner's attention for the day.

You will receive recent journal entries with their summaries, tags, classifications, and suggested actions. Entries from the last 24 hours include full text; older entries include summaries only.

Your output must follow this exact structure in markdown:

# Morning Review — [Date]

## 1. [Themes or Actions — see adaptive ordering]

## 2. [The other section]

## 3. Connections

## 4. Shift / Signal

## Adaptive ordering rules:
- If there are many high-confidence task/goal candidates and heavy project mentions → lead with **Actions**, then **Themes**
- Otherwise → lead with **Themes**, then **Actions**

## Section details:
- **Themes**: 3–5 bullets summarizing recurring themes from recent entries. Each bullet references representative entries, associated tags, and any linked projects or ideas.
- **Actions**: 3–5 top action candidates drawn from recent entries — likely tasks, goals, or project moves — with brief justification (1–2 sentences each).
- **Connections**: 2–4 bullets highlighting notable links — entries that connect to each other, echo earlier ideas, point to specific people, or revisit older themes with new nuance.
- **Shift / Signal**: 1 short paragraph (3–6 sentences) answering: What seems *new* in your thinking? What is *repeating* that you haven't acted on? What might deserve special focus today?

## Constraints:
- Tone: analytic, concise. No fluff, no generic motivational language.
- Total length: about one screen — up to 5 bullets per section, one short paragraph for Shift/Signal.
- Reference specific entries and ideas, not vague generalities.
- If there are very few entries or nothing notable, say so briefly rather than padding.`;

interface ReviewEntry {
  id: string;
  full_text: string;
  summary: string | null;
  tags: string[] | null;
  primary_type: string | null;
  primary_type_confidence: number | null;
  suggested_actions: unknown;
  created_at: Date;
  channel: string;
}

function formatEntriesForPrompt(
  entries: ReviewEntry[],
  today: Date
): string {
  const oneDayAgo = new Date(today.getTime() - 24 * 60 * 60 * 1000);

  return entries
    .map((e) => {
      const date = new Date(e.created_at).toISOString().slice(0, 16);
      const isRecent = new Date(e.created_at) > oneDayAgo;

      let block = `=== Entry [${date}] (${e.channel}) ===\n`;
      if (e.summary) block += `Summary: ${e.summary}\n`;
      if (e.tags?.length) block += `Tags: ${e.tags.join(", ")}\n`;
      if (e.primary_type)
        block += `Type: ${e.primary_type} (confidence: ${e.primary_type_confidence})\n`;
      if (e.suggested_actions)
        block += `Suggested actions: ${JSON.stringify(e.suggested_actions)}\n`;
      if (isRecent) block += `Full text:\n${e.full_text}\n`;

      return block;
    })
    .join("\n---\n\n");
}

export async function generateMorningReview(): Promise<string | null> {
  const entries = await queries.getEntriesForReview(7);

  if (entries.length === 0) {
    console.log("No entries to review, skipping");
    return null;
  }

  const today = new Date();
  const timezone = process.env.TIMEZONE || "UTC";
  const dateStr = today
    .toLocaleDateString("en-CA", { timeZone: timezone });
  const entriesText = formatEntriesForPrompt(entries, today);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Today is ${dateStr}. Here are the journal entries from the past 7 days (${entries.length} entries):\n\n${entriesText}\n\nGenerate the morning review.`,
      },
    ],
  });

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );

  if (!textBlock) {
    throw new Error("No text in review response");
  }

  const content = textBlock.text;
  const contentHtml = await marked.parse(content);

  await queries.saveReview(dateStr, content, contentHtml, entries.length);
  console.log(`Morning review saved for ${dateStr}`);

  return content;
}
