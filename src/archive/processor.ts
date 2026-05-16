import OpenAI from "openai";

// maxRetries: SDK respects Retry-After on 429, this gives headroom when the
// archive worker bursts against the per-minute output-token cap.
const openai = new OpenAI({ maxRetries: 6 });

export interface ArtifactProcessingResult {
  summary: string;
  excerpt: string;
  tags: string[];
  language: string;
}

export interface ExtractedEntity {
  entity_type: "person" | "organization" | "concept" | "work" | "place";
  display_name: string;
  aliases: string[];
  salience: number;
}

const SUMMARIZE_SCHEMA = {
  name: "save_artifact_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description:
          "A 2-3 sentence synopsis capturing the core argument or insight of the article.",
      },
      excerpt: {
        type: "string",
        description:
          "The first meaningful paragraph of the article (not a heading or metadata line). Max 300 chars.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "5-15 lowercase topic tags. Include specific themes, domains, named concepts, and people discussed.",
      },
      language: {
        type: "string",
        description: "ISO 639-1 language code (e.g. 'en', 'zh', 'th').",
      },
    },
    required: ["summary", "excerpt", "tags", "language"],
  },
} as const;

const ENTITY_SCHEMA = {
  name: "save_extracted_entities",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            entity_type: {
              type: "string",
              enum: ["person", "organization", "concept", "work", "place"],
            },
            display_name: {
              type: "string",
              description: "Canonical display name for the entity.",
            },
            aliases: {
              type: "array",
              items: { type: "string" },
              description: "Alternative names or spellings.",
            },
            salience: {
              type: "number",
              description:
                "How central this entity is to the article, 0.0 to 1.0.",
            },
          },
          required: ["entity_type", "display_name", "aliases", "salience"],
        },
        description:
          "Named entities found in the article. Include people, organizations, key concepts, referenced works, and places.",
      },
    },
    required: ["entities"],
  },
} as const;

export async function analyzeArtifact(
  title: string,
  rawSource: string,
  existingTags: string[] | null
): Promise<ArtifactProcessingResult> {
  const tagHint = existingTags?.length
    ? `\nExisting tags from source: ${existingTags.join(", ")}. Keep relevant ones and add more.`
    : "";

  const response = await openai.chat.completions.create({
    model: "gpt-5.4-nano",
    max_completion_tokens: 1024,
    messages: [
      {
        role: "system",
        content:
          "You are a background processor for a private knowledge base of published articles. Analyze each article to extract structured metadata. Be precise — summaries should capture the core argument, not just restate the title. Tags should be specific and useful for retrieval.",
      },
      {
        role: "user",
        content: `Analyze this published article:\n\nTitle: ${title}${tagHint}\n\n${rawSource.slice(0, 12000)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: SUMMARIZE_SCHEMA,
    },
  });

  console.log(
    `[archive] analyze tokens: in=${response.usage?.prompt_tokens} out=${response.usage?.completion_tokens}`
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No content in artifact analysis");

  return JSON.parse(content) as ArtifactProcessingResult;
}

const ENTITY_MAX_TOKENS = 8192;

export async function extractEntities(
  title: string,
  cleanText: string
): Promise<ExtractedEntity[]> {
  const response = await openai.chat.completions.create({
    model: "gpt-5.4-nano",
    max_completion_tokens: ENTITY_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content:
          "You extract named entities from published articles. Focus on people, organizations, key concepts/ideas, referenced works (books, papers, articles), and places that are meaningfully discussed — not just mentioned in passing.",
      },
      {
        role: "user",
        content: `Extract named entities from this article:\n\nTitle: ${title}\n\n${cleanText.slice(0, 10000)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: ENTITY_SCHEMA,
    },
  });

  console.log(
    `[archive] entities tokens: in=${response.usage?.prompt_tokens} out=${response.usage?.completion_tokens}`
  );

  const choice = response.choices[0];
  if (choice?.finish_reason === "length") {
    throw new Error(
      `Entity extraction truncated at token cap (${ENTITY_MAX_TOKENS})`
    );
  }

  const content = choice?.message?.content;
  if (!content) throw new Error("No content in entity extraction");

  const result = JSON.parse(content) as { entities?: ExtractedEntity[] };
  return Array.isArray(result.entities) ? result.entities : [];
}
