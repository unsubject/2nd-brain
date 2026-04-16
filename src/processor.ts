import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

export interface ProcessingResult {
  clean_text: string;
  summary: string;
  language: string;
  tags: string[];
  primary_type:
    | "task_candidate"
    | "goal_candidate"
    | "knowledge_candidate"
    | "archive_only";
  primary_type_confidence: number;
  suggested_actions: SuggestedAction[];
}

interface SuggestedAction {
  kind: "task" | "goal" | "knowledge";
  reason: string;
  confidence: number;
}

const PROCESSING_TOOL: Anthropic.Tool = {
  name: "save_processing_result",
  description:
    "Save the structured analysis result for a journal entry.",
  input_schema: {
    type: "object" as const,
    properties: {
      clean_text: {
        type: "string",
        description:
          "The normalized text: strip any markup, normalize whitespace, fix obvious encoding issues. Preserve the original meaning and voice exactly.",
      },
      summary: {
        type: "string",
        description:
          "A concise 1-3 sentence synopsis reflecting the main ideas. Not just a rephrased opening — capture the substance.",
      },
      language: {
        type: "string",
        description: "ISO 639-1 language code (e.g. 'en', 'es', 'fr').",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "3-10 lowercase tags spanning: topics (e.g. content, macro, family, craft, health), recognizable projects, named people or organizations, time horizon or actionability if obvious.",
      },
      primary_type: {
        type: "string",
        enum: [
          "task_candidate",
          "goal_candidate",
          "knowledge_candidate",
          "archive_only",
        ],
        description:
          "The primary classification. task_candidate = contains a concrete next action. goal_candidate = expresses a longer-term aspiration. knowledge_candidate = contains a reusable insight or concept. archive_only = pure vent, log, or ephemeral thought.",
      },
      primary_type_confidence: {
        type: "number",
        description: "Confidence in the primary_type classification, 0.0 to 1.0.",
      },
      suggested_actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["task", "goal", "knowledge"],
              description:
                "task = concrete next step. goal = longer-horizon commitment. knowledge = evergreen note candidate.",
            },
            reason: {
              type: "string",
              description: "Short natural-language rationale for this suggestion.",
            },
            confidence: {
              type: "number",
              description: "Confidence 0.0 to 1.0.",
            },
          },
          required: ["kind", "reason", "confidence"],
        },
        description:
          "Up to 2 suggested actions derived from the entry. Only include if genuinely warranted — do not force suggestions on trivial entries.",
      },
    },
    required: [
      "clean_text",
      "summary",
      "language",
      "tags",
      "primary_type",
      "primary_type_confidence",
      "suggested_actions",
    ],
  },
};

const SYSTEM_PROMPT = `You are a background processor for a private journal system. You analyze raw streams of consciousness captured from a messaging app.

Your job is to extract structured metadata from each entry. Be precise and honest in your classifications:

- Summaries should capture substance, not just rephrase the opening.
- Tags should be specific and useful for retrieval — avoid generic filler tags.
- Classification should reflect what the entry actually contains, not what you wish it contained.
- Suggested actions should only be included when the text genuinely implies them. An entry that is purely reflective should have zero suggested actions.
- Confidence scores should be calibrated: use low scores when the text is ambiguous.

The journal owner uses this system to offload fragmented thoughts. Respect the raw, unfiltered nature of the input.`;

export async function processEntry(
  fullText: string
): Promise<ProcessingResult> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Analyze this journal entry:\n\n${fullText}`,
      },
    ],
    tools: [PROCESSING_TOOL],
    tool_choice: { type: "tool", name: "save_processing_result" },
  });

  const toolBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolBlock) {
    throw new Error("No tool use block in response");
  }

  return toolBlock.input as ProcessingResult;
}
