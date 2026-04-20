import { pool } from "./db/client";
import { ProcessingResult } from "./processor";
import { createTaskSuggestion, Scope } from "./db/taskSuggestions";

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const MAX_TITLE_LENGTH = 200;

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "\u2026";
}

function pickSuggestedTitle(result: ProcessingResult): string {
  for (const a of result.suggested_actions ?? []) {
    if (a.kind === "task" && a.reason?.trim()) {
      return truncate(a.reason, MAX_TITLE_LENGTH);
    }
  }
  if (result.summary?.trim()) return truncate(result.summary, MAX_TITLE_LENGTH);
  return truncate(result.clean_text, MAX_TITLE_LENGTH);
}

function listNameFor(scope: Scope): string {
  return scope === "family" ? "Family" : "Do";
}

function getThreshold(): number {
  const raw = process.env.TASK_SUGGEST_CONFIDENCE_THRESHOLD;
  if (!raw) return DEFAULT_CONFIDENCE_THRESHOLD;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : DEFAULT_CONFIDENCE_THRESHOLD;
}

export async function maybeCreateTaskSuggestion(
  entryId: string,
  result: ProcessingResult
): Promise<void> {
  if (result.primary_type !== "task_candidate") return;
  if ((result.primary_type_confidence ?? 0) < getThreshold()) return;

  const { rows } = await pool.query<{
    scope: Scope;
    je_chat_id: string | null;
    ce_chat_id: string | null;
  }>(
    `SELECT je.scope,
            je.chat_id AS je_chat_id,
            (SELECT ce.chat_id
             FROM capture_event ce
             WHERE ce.journal_entry_id = je.id
               AND ce.chat_id IS NOT NULL
             ORDER BY ce.received_at DESC
             LIMIT 1) AS ce_chat_id
     FROM journal_entry je
     WHERE je.id = $1`,
    [entryId]
  );
  if (rows.length === 0) return;

  const scope = rows[0].scope;
  const chatId = rows[0].je_chat_id ?? rows[0].ce_chat_id ?? null;

  const title = pickSuggestedTitle(result);
  if (!title) return;

  const suggestionId = await createTaskSuggestion({
    journalEntryId: entryId,
    scope,
    suggestedTitle: title,
    suggestedListName: listNameFor(scope),
    telegramChatId: chatId,
  });

  if (suggestionId) {
    console.log(
      `[taskSuggest] Created suggestion ${suggestionId} for entry ${entryId} (scope=${scope}, chat=${chatId ?? "none"})`
    );
  }
}
