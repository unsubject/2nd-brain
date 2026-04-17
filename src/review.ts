import Anthropic from "@anthropic-ai/sdk";
import { Marked } from "marked";
import * as queries from "./db/queries";

const anthropic = new Anthropic();
const marked = new Marked();

const SYSTEM_PROMPT = `You are the morning briefing synthesizer for a private second-brain system. You produce a daily briefing that orients the owner's attention for the day ahead and reflects their recent thinking.

You receive five kinds of input, any of which may be empty:
1. Recent journal entries (last 7 days). Entries from the last 24 hours include full text; older ones include summaries.
2. Today's calendar events (from Google Calendar).
3. Open tasks due soon (from Google Tasks), including the task list name ("Do", "Subjects", "Learn") and any parent task.
4. Starred emails (from Gmail — the follow-up queue).
5. Cross-source connections: journal entries linked to Google entities (by name mention, same-day event, location match, task keywords, or semantic similarity) AND journal entries that echo the owner's own past published writing from their archive (link_type "echoes_artifact" — a semantic match between today's thought and an article they wrote in the past).

Your output must follow this structure in markdown:

# Morning Review — [Date]

## Today
- **Schedule**: bullets of calendar events — time, title, location (if any), key attendees. If empty, write "Nothing on the calendar."
- **Due**: tasks due today or overdue, grouped by list type (Do / Subjects / Learn). Include parent task name when the task is a subtask. If empty, write "Nothing pressing."
- **Follow-ups**: starred emails — show sender and subject, most recent first. Cap at 5. If empty, omit the line.

## 1. [Themes or Actions — adaptive]
## 2. [The other section]
## 3. Connections
## 4. Shift / Signal

### Adaptive ordering:
- If many high-confidence task/goal candidates in journal + heavy project mentions → lead with **Actions**, then **Themes**
- Otherwise → lead with **Themes**, then **Actions**

### Section details:
- **Themes**: 3–5 bullets summarizing recurring themes from recent entries. Reference representative entries, tags, and linked projects/ideas.
- **Actions**: 3–5 top action candidates from recent entries — tasks, goals, project moves — with brief justification (1–2 sentences each). Note overlap with Google Tasks where relevant.
- **Connections**: 2–4 bullets. Use the cross-source link data to highlight meaningful ties — e.g., a journal thought that mirrors an upcoming event, a person mentioned who is also in a recent email thread, a task that keeps appearing in journal entries, or a current journal thought that echoes something the owner previously published (call these out explicitly with the article title). Also include journal-to-journal echoes.
- **Shift / Signal**: 1 short paragraph (3–6 sentences). What is *new* in the thinking? What is *repeating* that hasn't been acted on? What might deserve special focus today given both the thoughts and the schedule?

### Constraints:
- Tone: analytic, concise. No fluff. No generic motivational language.
- Total length: about one screen.
- Reference specifics, not generalities.
- If everything is quiet (few entries, nothing on calendar), say so briefly rather than padding.`;

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

function formatEntriesForPrompt(entries: ReviewEntry[], today: Date): string {
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

function formatCalendarForPrompt(
  events: Awaited<ReturnType<typeof queries.getTodayCalendarEvents>>,
  timezone: string
): string {
  if (events.length === 0) return "(no calendar events today)";

  return events
    .map((e) => {
      const startStr = e.start_at.toLocaleString("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const endStr = e.end_at.toLocaleString("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      let line = `- ${startStr}–${endStr} ${e.title}`;
      if (e.location) line += ` (at ${e.location})`;
      if (e.attendees) {
        const attendees = e.attendees as Array<{
          email?: string;
          name?: string;
        }>;
        const names = attendees
          .map((a) => a.name || a.email)
          .filter(Boolean)
          .slice(0, 4);
        if (names.length > 0) line += ` — with ${names.join(", ")}`;
      }
      if (e.description) {
        const shortDesc = e.description.slice(0, 200).replace(/\n/g, " ");
        line += `\n  Description: ${shortDesc}`;
      }
      return line;
    })
    .join("\n");
}

function formatTasksForPrompt(
  tasks: Awaited<ReturnType<typeof queries.getOpenTasks>>,
  timezone: string
): string {
  if (tasks.length === 0) return "(no open tasks due soon)";

  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: timezone });

  return tasks
    .map((t) => {
      let prefix = "-";
      if (t.due_at) {
        const dueStr = t.due_at.toLocaleDateString("en-CA", {
          timeZone: timezone,
        });
        if (dueStr < today) prefix = "- [OVERDUE]";
        else if (dueStr === today) prefix = "- [TODAY]";
        else prefix = `- [due ${dueStr}]`;
      }

      let line = `${prefix} ${t.title}`;
      if (t.parent_title) line += ` (subtask of "${t.parent_title}")`;
      const list = t.list_name || "(unfiled)";
      const listType = t.list_type ? ` · ${t.list_type}` : "";
      line += ` — list: ${list}${listType}`;
      if (t.notes) {
        const shortNotes = t.notes.slice(0, 150).replace(/\n/g, " ");
        line += `\n  Notes: ${shortNotes}`;
      }
      return line;
    })
    .join("\n");
}

function formatEmailsForPrompt(
  emails: Awaited<ReturnType<typeof queries.getStarredEmails>>,
  timezone: string
): string {
  if (emails.length === 0) return "(no starred emails awaiting follow-up)";

  return emails
    .map((e) => {
      const dateStr = e.sent_at
        ? e.sent_at.toLocaleDateString("en-CA", { timeZone: timezone })
        : "?";
      const subject = e.subject || "(no subject)";
      let line = `- [${dateStr}] From ${e.from_address}: "${subject}"`;
      if (e.snippet) {
        const shortSnippet = e.snippet.slice(0, 160).replace(/\n/g, " ");
        line += `\n  ${shortSnippet}`;
      }
      return line;
    })
    .join("\n");
}

function formatLinksForPrompt(
  links: Awaited<ReturnType<typeof queries.getLinksForRecentEntries>>
): string {
  if (links.length === 0) return "(no cross-source connections in recent entries)";

  return links
    .map((l) => {
      const dateStr = l.journal_created_at.toISOString().slice(0, 10);
      const summary = l.journal_summary
        ? l.journal_summary.slice(0, 120)
        : "(no summary)";
      const conf = l.confidence
        ? ` [confidence ${l.confidence.toFixed(2)}]`
        : "";
      const targetDesc = l.target_title
        ? `${l.target_type} "${l.target_title}"${
            l.target_date
              ? ` (${l.target_date.toISOString().slice(0, 10)})`
              : ""
          }`
        : l.target_type;
      return `- [${dateStr}] Journal: "${summary}" → ${targetDesc} (${l.link_type})${conf}\n  ${l.explanation || ""}`;
    })
    .join("\n");
}

export async function generateMorningReview(): Promise<string | null> {
  const timezone = process.env.TIMEZONE || "UTC";
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-CA", { timeZone: timezone });

  const [entries, calendar, tasks, starred, links] = await Promise.all([
    queries.getEntriesForReview(7),
    queries.getTodayCalendarEvents(timezone),
    queries.getOpenTasks(7),
    queries.getStarredEmails(30),
    queries.getLinksForRecentEntries(7),
  ]);

  if (
    entries.length === 0 &&
    calendar.length === 0 &&
    tasks.length === 0 &&
    starred.length === 0
  ) {
    console.log("Nothing to review, skipping");
    return null;
  }

  const userMessage = `Today is ${dateStr} (timezone: ${timezone}).

=== TODAY'S CALENDAR ===
${formatCalendarForPrompt(calendar, timezone)}

=== OPEN TASKS (due within 7 days or undated) ===
${formatTasksForPrompt(tasks, timezone)}

=== STARRED EMAILS (follow-up queue) ===
${formatEmailsForPrompt(starred, timezone)}

=== CROSS-SOURCE CONNECTIONS (journal entries linked to Google entities and archive articles, last 7 days) ===
${formatLinksForPrompt(links)}

=== JOURNAL ENTRIES (last 7 days, ${entries.length} entries) ===
${entries.length === 0 ? "(no journal entries this week)" : formatEntriesForPrompt(entries, today)}

Generate the morning review.`;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 3072,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
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
