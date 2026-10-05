import OpenAI from "openai";

const openai = new OpenAI();

export interface ProcessingResult {
  clean_text: string;
  summary: string;
  language: string;
  tags: string[];
}

// The model returns only metadata. It used to return the whole entry back
// as clean_text as well, which made any long saved session overflow the
// output budget and fail as unparseable JSON; the text is now normalised
// in code instead.
const PROCESSING_SCHEMA = {
  name: "save_processing_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description:
          "A concise 1-3 sentence synopsis reflecting the main ideas. Not just a rephrased opening — capture the substance.",
      },
      language: {
        type: "string",
        description: "ISO 639-1 code of the entry's main language (e.g. 'en', 'zh', 'ja').",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "3-10 lowercase tags spanning: topics (e.g. economics, content, craft, health), recognizable projects, named people or organizations.",
      },
    },
    required: ["summary", "language", "tags"],
  },
} as const;

const SYSTEM_PROMPT = `You are a background processor for a private journal. Entries are Simon's own notes and the summaries of conversations he saves from his AI chat sessions, in English or Chinese.

Your job is to extract structured metadata from each entry:

- Summaries should capture substance, not just rephrase the opening. Write the summary in the entry's main language.
- Tags should be specific and useful for retrieval — avoid generic filler tags.

Respect the raw, unfiltered nature of the input.`;

/** Whitespace and control-character normalisation; the wording is untouched. */
export function cleanText(fullText: string): string {
  return fullText
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// text-embedding-3-small rejects inputs over 8,191 tokens. Every token of
// its tokenizer is at least one UTF-8 byte, so a byte budget keeps any text
// under the limit whatever the language: colloquial Cantonese can run at
// close to two tokens per character, which a character cap would not cover.
// The cut falls between code points, and the summary goes first so the whole
// entry is represented even when its tail is cut.
export const MAX_EMBEDDING_BYTES = 8000;

export function embeddingInput(result: Pick<ProcessingResult, "summary" | "clean_text">): string {
  const text = result.summary ? `${result.summary}\n\n${result.clean_text}` : result.clean_text;
  if (Buffer.byteLength(text, "utf8") <= MAX_EMBEDDING_BYTES) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    bytes += Buffer.byteLength(ch, "utf8");
    if (bytes > MAX_EMBEDDING_BYTES) break;
    end += ch.length;
  }
  return text.slice(0, end);
}

export async function processEntry(
  fullText: string
): Promise<ProcessingResult> {
  const response = await openai.chat.completions.create({
    model: "gpt-5.4-nano",
    max_completion_tokens: 2048,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Analyze this journal entry:\n\n${fullText}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: PROCESSING_SCHEMA,
    },
  });

  console.log(
    `[journal] tokens: in=${response.usage?.prompt_tokens} out=${response.usage?.completion_tokens}`
  );

  const choice = response.choices[0];
  if (choice?.finish_reason === "length") {
    throw new Error("Processing response was cut off at the output limit");
  }
  const content = choice?.message?.content;
  if (!content) {
    throw new Error("No content in processing response");
  }

  const meta = JSON.parse(content) as Omit<ProcessingResult, "clean_text">;
  return { ...meta, clean_text: cleanText(fullText) };
}
