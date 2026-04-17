import { pool } from "../db/client";

interface LinkableEntry {
  id: string;
  full_text: string;
  tags: string[];
  created_at: Date;
  embedding: number[];
}

async function insertLink(
  sourceType: string,
  sourceId: string,
  targetType: string,
  targetId: string,
  linkType: string,
  confidence: number,
  explanation: string
): Promise<void> {
  await pool.query(
    `INSERT INTO link_edge
       (user_id, source_type, source_id, target_type, target_id, link_type, confidence, explanation)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [sourceType, sourceId, targetType, targetId, linkType, confidence, explanation]
  );
}

async function linkMentionedContacts(entry: LinkableEntry): Promise<void> {
  const { rows: contacts } = await pool.query(
    `SELECT id, full_name FROM person_ref WHERE user_id = 'default'`
  );

  const textLower = entry.full_text.toLowerCase();

  for (const contact of contacts) {
    const name = contact.full_name as string;
    if (name.length < 3) continue;

    // Check for name mention with word boundary awareness
    const nameLower = name.toLowerCase();
    const nameWords = nameLower.split(/\s+/);

    // Match full name or last name (if multi-word) in entry text
    let matched = false;
    if (textLower.includes(nameLower)) {
      matched = true;
    } else if (nameWords.length > 1) {
      // Try last name match (must be at least 4 chars to avoid false positives)
      const lastName = nameWords[nameWords.length - 1];
      if (lastName.length >= 4 && textLower.includes(lastName)) {
        matched = true;
      }
    }

    if (matched) {
      await insertLink(
        "journal_entry",
        entry.id,
        "person_ref",
        contact.id,
        "mentions_person",
        0.8,
        `Entry text mentions "${name}"`
      );
    }
  }
}

async function linkNearbyCalendarEvents(entry: LinkableEntry): Promise<void> {
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
      await insertLink(
        "journal_entry",
        entry.id,
        "calendar_event_ref",
        event.id,
        "relates_to_event",
        0.9,
        `Entry mentions event "${event.title}" and location "${location}"`
      );
    } else if (mentionsTitle) {
      await insertLink(
        "journal_entry",
        entry.id,
        "calendar_event_ref",
        event.id,
        "relates_to_event",
        0.7,
        `Entry on same day mentions event "${event.title}"`
      );
    } else if (mentionsLocation) {
      await insertLink(
        "journal_entry",
        entry.id,
        "calendar_event_ref",
        event.id,
        "relates_to_location",
        0.7,
        `Entry mentions event location "${location}"`
      );
    } else {
      await insertLink(
        "journal_entry",
        entry.id,
        "calendar_event_ref",
        event.id,
        "same_day_as_event",
        0.3,
        `Entry created on same day as event "${event.title}"`
      );
    }
  }
}

async function linkRelatedTasks(entry: LinkableEntry): Promise<void> {
  const { rows: tasks } = await pool.query(
    `SELECT id, title FROM task_ref
     WHERE user_id = 'default'
       AND status = 'needsAction'`
  );

  const textLower = entry.full_text.toLowerCase();
  const entryTags = new Set(entry.tags.map((t) => t.toLowerCase()));

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
      await insertLink(
        "journal_entry",
        entry.id,
        "task_ref",
        task.id,
        "relates_to_task",
        0.6,
        `Entry mentions keywords from task "${task.title}"`
      );
    }
  }
}

async function linkRelatedEmails(entry: LinkableEntry): Promise<void> {
  if (!entry.embedding || entry.embedding.length === 0) return;

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

  for (const email of emails) {
    const similarity = parseFloat(email.similarity);
    if (similarity >= 0.5) {
      await insertLink(
        "journal_entry",
        entry.id,
        "email_ref",
        email.id,
        "relates_to_email",
        similarity,
        `Entry is semantically similar to email "${email.subject || "(no subject)"}"`
      );
    }
  }
}

async function linkRelatedArtifacts(entry: LinkableEntry): Promise<void> {
  if (!entry.embedding || entry.embedding.length === 0) return;

  const vectorStr = `[${entry.embedding.join(",")}]`;

  // ANN-first over chunks (HNSW index on embedding), then dedupe to best-per-artifact in JS.
  // Pulling 30 nearest chunks reliably covers 5-10 distinct top artifacts.
  const { rows } = await pool.query(
    `SELECT c.public_artifact_id AS artifact_id,
            a.title,
            a.published_at,
            1 - (c.embedding <=> $1::vector) AS similarity
     FROM public_artifact_chunk c
     JOIN public_artifact a ON a.id = c.public_artifact_id
     WHERE c.embedding IS NOT NULL
       AND a.processing_status = 'processed'
     ORDER BY c.embedding <=> $1::vector
     LIMIT 30`,
    [vectorStr]
  );

  const bestByArtifact = new Map<
    string,
    { title: string; publishedAt: Date | null; similarity: number }
  >();
  for (const r of rows) {
    const sim = parseFloat(r.similarity);
    const existing = bestByArtifact.get(r.artifact_id);
    if (!existing || sim > existing.similarity) {
      bestByArtifact.set(r.artifact_id, {
        title: r.title,
        publishedAt: r.published_at,
        similarity: sim,
      });
    }
  }

  const topMatches = Array.from(bestByArtifact.entries())
    .map(([artifactId, info]) => ({ artifactId, ...info }))
    .filter((m) => m.similarity >= 0.45)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);

  for (const match of topMatches) {
    const dateStr = match.publishedAt
      ? new Date(match.publishedAt).toISOString().slice(0, 10)
      : "undated";
    await insertLink(
      "journal_entry",
      entry.id,
      "public_artifact",
      match.artifactId,
      "echoes_artifact",
      match.similarity,
      `Entry echoes past article "${match.title}" (${dateStr})`
    );
  }
}

export async function generateLinks(entry: LinkableEntry): Promise<void> {
  try {
    await linkMentionedContacts(entry);
    await linkNearbyCalendarEvents(entry);
    await linkRelatedTasks(entry);
    await linkRelatedEmails(entry);
    await linkRelatedArtifacts(entry);
  } catch (err) {
    // Link generation is non-critical — log and continue
    console.error(`Link generation error for entry ${entry.id}:`, err);
  }
}
