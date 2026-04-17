import { pool } from "../db/client";

interface LinkableEntry {
  id: string;
  full_text: string;
  tags: string[];
  created_at: Date;
  embedding: number[];
}

interface LinkRow {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  linkType: string;
  confidence: number;
  explanation: string;
}

async function insertLinks(links: LinkRow[]): Promise<void> {
  if (links.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  for (const link of links) {
    const base = params.length;
    values.push(
      `('default', $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
    );
    params.push(
      link.sourceType,
      link.sourceId,
      link.targetType,
      link.targetId,
      link.linkType,
      link.confidence,
      link.explanation
    );
  }

  await pool.query(
    `INSERT INTO link_edge
       (user_id, source_type, source_id, target_type, target_id, link_type, confidence, explanation)
     VALUES ${values.join(", ")}
     ON CONFLICT DO NOTHING`,
    params
  );
}

async function linkMentionedContacts(entry: LinkableEntry): Promise<LinkRow[]> {
  const { rows: contacts } = await pool.query(
    `SELECT id, full_name FROM person_ref WHERE user_id = 'default'`
  );

  const textLower = entry.full_text.toLowerCase();
  const links: LinkRow[] = [];

  for (const contact of contacts) {
    const name = contact.full_name as string;
    if (name.length < 3) continue;

    // Check for name mention with word boundary awareness
    const nameLower = name.toLowerCase();

    // Match full name or last name (if multi-word) in entry text
    let matched = false;
    if (textLower.includes(nameLower)) {
      matched = true;
    } else {
      const nameWords = nameLower.split(/\s+/);
      if (nameWords.length > 1) {
        // Try last name match (must be at least 4 chars to avoid false positives)
        const lastName = nameWords[nameWords.length - 1];
        if (lastName.length >= 4 && textLower.includes(lastName)) {
          matched = true;
        }
      }
    }

    if (matched) {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "person_ref",
        targetId: contact.id,
        linkType: "mentions_person",
        confidence: 0.8,
        explanation: `Entry text mentions "${name}"`,
      });
    }
  }

  return links;
}

async function linkNearbyCalendarEvents(
  entry: LinkableEntry
): Promise<LinkRow[]> {
  // Find calendar events on the same day as the entry
  const entryDate = entry.created_at;
  const dayStart = new Date(entryDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(entryDate);
  dayEnd.setHours(23, 59, 59, 999);

  const { rows: events } = await pool.query(
    `SELECT id, title, location FROM calendar_event_ref
     WHERE user_id = 'default'
       AND start_at >= $1 AND start_at <= $2`,
    [dayStart, dayEnd]
  );

  const textLower = entry.full_text.toLowerCase();
  const links: LinkRow[] = [];

  for (const event of events) {
    const titleLower = (event.title as string).toLowerCase();
    const titleWords = titleLower
      .split(/\s+/)
      .filter((w: string) => w.length >= 4);
    const mentionsTitle = titleWords.some((w: string) =>
      textLower.includes(w)
    );

    const location = (event.location as string | null) || "";
    const locationLower = location.toLowerCase();
    const locationWords = locationLower
      .split(/[,\s]+/)
      .filter((w: string) => w.length >= 4);
    const mentionsLocation = locationWords.some((w: string) =>
      textLower.includes(w)
    );

    if (mentionsTitle && mentionsLocation) {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "calendar_event_ref",
        targetId: event.id,
        linkType: "relates_to_event",
        confidence: 0.9,
        explanation: `Entry mentions event "${event.title}" and location "${location}"`,
      });
    } else if (mentionsTitle) {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "calendar_event_ref",
        targetId: event.id,
        linkType: "relates_to_event",
        confidence: 0.7,
        explanation: `Entry on same day mentions event "${event.title}"`,
      });
    } else if (mentionsLocation) {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "calendar_event_ref",
        targetId: event.id,
        linkType: "relates_to_location",
        confidence: 0.7,
        explanation: `Entry mentions event location "${location}"`,
      });
    } else {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "calendar_event_ref",
        targetId: event.id,
        linkType: "same_day_as_event",
        confidence: 0.3,
        explanation: `Entry created on same day as event "${event.title}"`,
      });
    }
  }

  return links;
}

async function linkRelatedTasks(entry: LinkableEntry): Promise<LinkRow[]> {
  const { rows: tasks } = await pool.query(
    `SELECT id, title FROM task_ref
     WHERE user_id = 'default'
       AND status = 'needsAction'`
  );

  const textLower = entry.full_text.toLowerCase();
  const entryTags = new Set(entry.tags.map((t) => t.toLowerCase()));
  const links: LinkRow[] = [];

  for (const task of tasks) {
    const titleLower = (task.title as string).toLowerCase();
    const titleWords = titleLower
      .split(/\s+/)
      .filter((w: string) => w.length >= 4);

    // Check text overlap
    const matchingWords = titleWords.filter((w: string) =>
      textLower.includes(w)
    );

    // Check tag overlap
    const tagMatch = titleWords.some((w: string) => entryTags.has(w));

    if (matchingWords.length >= 2 || (matchingWords.length >= 1 && tagMatch)) {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "task_ref",
        targetId: task.id,
        linkType: "relates_to_task",
        confidence: 0.6,
        explanation: `Entry mentions keywords from task "${task.title}"`,
      });
    }
  }

  return links;
}

async function linkRelatedEmails(entry: LinkableEntry): Promise<LinkRow[]> {
  if (!entry.embedding || entry.embedding.length === 0) return [];

  const vectorStr = `[${entry.embedding.join(",")}]`;

  // Find emails with embeddings that are similar to this entry
  const { rows: emails } = await pool.query(
    `SELECT id, subject, 1 - (embedding <=> $1::vector) AS similarity
     FROM email_ref
     WHERE user_id = 'default'
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 3`,
    [vectorStr]
  );

  const links: LinkRow[] = [];
  for (const email of emails) {
    const similarity = parseFloat(email.similarity);
    if (similarity >= 0.5) {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "email_ref",
        targetId: email.id,
        linkType: "relates_to_email",
        confidence: similarity,
        explanation: `Entry is semantically similar to email "${email.subject || "(no subject)"}"`,
      });
    }
  }

  return links;
}

export async function generateLinks(entry: LinkableEntry): Promise<void> {
  try {
    const results = await Promise.all([
      linkMentionedContacts(entry),
      linkNearbyCalendarEvents(entry),
      linkRelatedTasks(entry),
      linkRelatedEmails(entry),
    ]);
    await insertLinks(results.flat());
  } catch (err) {
    // Link generation is non-critical — log and continue
    console.error(`Link generation error for entry ${entry.id}:`, err);
  }
}
