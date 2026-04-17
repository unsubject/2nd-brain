import Anthropic from "@anthropic-ai/sdk";

// maxRetries: SDK respects Retry-After on 429, this gives headroom when the
// archive worker bursts against the per-minute output-token cap.
const anthropic = new Anthropic({ maxRetries: 6 });

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

const SUMMARIZE_TOOL: Anthropic.Tool = {
  name: "save_artifact_analysis",
  description: "Save the structured analysis of a published article.",
  input_schema: {
    type: "object" as const,
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
};

const ENTITY_TOOL: Anthropic.Tool = {
  name: "save_extracted_entities",
  description: "Save the named entities extracted from a published article.",
  input_schema: {
    type: "object" as const,
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
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
};

export async function analyzeArtifact(
  title: string,
  rawSource: string,
  existingTags: string[] | null
): Promise<ArtifactProcessingResult> {
  const tagHint = existingTags?.length
    ? `\nExisting tags from source: ${existingTags.join(", ")}. Keep relevant ones and add more.`
    : "";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system:
      "You are a background processor for a private knowledge base of published articles. Analyze each article to extract structured metadata. Be precise — summaries should capture the core argument, not just restate the title. Tags should be specific and useful for retrieval.",
    messages: [
      {
        role: "user",
        content: `Analyze this published article:\n\nTitle: ${title}${tagHint}\n\n${rawSource.slice(0, 12000)}`,
      },
    ],
    tools: [SUMMARIZE_TOOL],
    tool_choice: { type: "tool", name: "save_artifact_analysis" },
  });

  console.log(
    `[archive] analyze tokens: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
  );

  const toolBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolBlock) throw new Error("No tool use block in artifact analysis");

  return toolBlock.input as ArtifactProcessingResult;
}

export async function extractEntities(
  title: string,
  cleanText: string
): Promise<ExtractedEntity[]> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system:
      "You extract named entities from published articles. Focus on people, organizations, key concepts/ideas, referenced works (books, papers, articles), and places that are meaningfully discussed — not just mentioned in passing.",
    messages: [
      {
        role: "user",
        content: `Extract named entities from this article:\n\nTitle: ${title}\n\n${cleanText.slice(0, 10000)}`,
      },
    ],
    tools: [ENTITY_TOOL],
    tool_choice: { type: "tool", name: "save_extracted_entities" },
  });

  console.log(
    `[archive] entities tokens: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
  );

  const toolBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolBlock) throw new Error("No tool use block in entity extraction");

  const result = toolBlock.input as { entities?: ExtractedEntity[] };
  return Array.isArray(result.entities) ? result.entities : [];
}
