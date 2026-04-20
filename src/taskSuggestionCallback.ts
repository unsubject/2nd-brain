import type { Context } from "grammy";
import {
  getSuggestionById,
  markSuggestionAdded,
  markSuggestionSkipped,
} from "./db/taskSuggestions";
import { insertTask } from "./google/tasks";

export async function handleSuggestionCallback(
  ctx: Context,
  action: "add" | "skip",
  id: string
): Promise<void> {
  const suggestion = await getSuggestionById(id);
  if (!suggestion) {
    await ctx.answerCallbackQuery({ text: "Suggestion not found." });
    return;
  }
  if (suggestion.status !== "pending") {
    await ctx.answerCallbackQuery({ text: `Already ${suggestion.status}.` });
    return;
  }

  const userId = ctx.from?.id?.toString() ?? "unknown";

  if (action === "skip") {
    const updated = await markSuggestionSkipped(id, userId);
    if (!updated) {
      await ctx.answerCallbackQuery({ text: "Already resolved." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Skipped." });
    await ctx.editMessageText(
      `\u2717 Skipped\n\n"${suggestion.suggested_title}"`
    );
    return;
  }

  // action === "add"
  let inserted;
  try {
    inserted = await insertTask({
      listName: suggestion.suggested_list_name,
      title: suggestion.suggested_title,
    });
  } catch (err) {
    console.error(`[taskSuggest] insertTask failed for ${id}:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({
      text: `Failed: ${msg.slice(0, 180)}`,
      show_alert: true,
    });
    return;
  }

  const updated = await markSuggestionAdded(id, userId, inserted.externalTaskId);
  if (!updated) {
    // Lost a race with another tap; the other tap already edited the message.
    await ctx.answerCallbackQuery({ text: "Already added." });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Added." });
  await ctx.editMessageText(
    `\u2705 Added to "${inserted.listTitle}"\n\n"${suggestion.suggested_title}"`
  );
}
