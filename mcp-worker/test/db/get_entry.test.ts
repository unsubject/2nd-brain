import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin, callTool, ok, resetJournalData, seedArtifact, seedJournalEntry, TEST_DB } from './helpers';

// Synthetic data only (the repository is public).

afterAll(() => admin.end({ timeout: 5 }));

// Link targets the refocus retires: contacts and calendar events (dropped
// in Phase 3) and emails (empty since migration 024). While a table still
// exists, a test seeds the target rows too, so the old joins would have
// resolved each link to a title and a scope; once it is dropped the links
// dangle, which get_entry has to handle just the same.
const RETIRED_TABLES = ['person_ref', 'calendar_event_ref', 'email_ref'];
let retiredPresent = new Set<string>();

async function seedRetiredTarget(table: string, id: string, title: string, scope = 'personal'): Promise<void> {
  if (!retiredPresent.has(table)) return;
  if (table === 'person_ref') {
    await admin`INSERT INTO person_ref (id, user_id, external_person_id, full_name) VALUES (${id}, 'default', ${id}, ${title})`;
  } else if (table === 'calendar_event_ref') {
    await admin`
      INSERT INTO calendar_event_ref (id, user_id, external_event_id, title, start_at, end_at, scope)
      VALUES (${id}, 'default', ${id}, ${title}, now(), now(), ${scope})
    `;
  } else {
    await admin`
      INSERT INTO email_ref (id, user_id, external_message_id, subject, from_address, scope)
      VALUES (${id}, 'default', ${id}, ${title}, 'sender@example.com', ${scope})
    `;
  }
}

async function seedTask(title: string, scope: 'personal' | 'family'): Promise<string> {
  const [t] = await admin<Array<{ id: string }>>`
    INSERT INTO task_ref (user_id, external_task_id, external_list_id, title, scope)
    VALUES ('default', ${randomUUID()}, 'list-get-entry', ${title}, ${scope}) RETURNING id
  `;
  return t.id;
}

async function seedEntity(displayName: string): Promise<string> {
  const [e] = await admin<Array<{ id: string }>>`
    INSERT INTO entity_ref (user_id, entity_type, normalized_name, display_name)
    VALUES ('default', 'concept', ${displayName.toLowerCase()}, ${displayName}) RETURNING id
  `;
  return e.id;
}

type Link = [targetType: string, targetId: string, linkType: string, confidence: number, explanation: string];

async function seedLinks(entry: string, links: Link[]): Promise<void> {
  for (const [targetType, targetId, linkType, confidence, explanation] of links) {
    await admin`
      INSERT INTO link_edge (user_id, source_type, source_id, target_type, target_id, link_type, confidence, explanation)
      VALUES ('default', 'journal_entry', ${entry}, ${targetType}, ${targetId}, ${linkType}, ${confidence}, ${explanation})
    `;
  }
}

// A link to every kind of target: the three that stay, then contacts,
// calendar events (under each link type the linker has used for them),
// emails, and a type get_entry has never heard of. The retired targets'
// names appear only in their own rows and in the link explanations.
async function seedEveryTargetType(entry: string, scope: 'personal' | 'family') {
  const piece = await seedArtifact('Synthetic piece', null);
  const entity = await seedEntity('Synthetic concept');
  const personalTask = await seedTask('Synthetic personal task', 'personal');
  const familyTask = await seedTask('Synthetic family task', 'family');
  const contact = randomUUID();
  const event = randomUUID();
  const email = randomUUID();
  await seedRetiredTarget('person_ref', contact, 'Contact Alpha');
  await seedRetiredTarget('calendar_event_ref', event, 'Event Beta', scope);
  await seedRetiredTarget('email_ref', email, 'Subject Gamma', scope);
  await seedLinks(entry, [
    ['entity_ref', entity, 'mentions_entity', 0.8, 'Entry mentions concept "Synthetic concept" (salience 0.75)'],
    ['public_artifact', piece, 'echoes_artifact', 0.7, 'Entry echoes past article "Synthetic piece" (2026-06-01)'],
    ['task_ref', personalTask, 'relates_to_task', 0.6, 'Entry mentions keywords from task "Synthetic personal task"'],
    ['task_ref', familyTask, 'relates_to_task', 0.65, 'Entry mentions keywords from task "Synthetic family task"'],
    ['person_ref', contact, 'mentions_person', 0.9, 'Entry mentions contact "Contact Alpha"'],
    ['calendar_event_ref', event, 'relates_to_event', 0.7, 'Entry relates to event "Event Beta"'],
    ['calendar_event_ref', event, 'relates_to_location', 0.7, 'Entry mentions the location of "Event Beta"'],
    ['calendar_event_ref', event, 'same_day_as_event', 0.3, 'Written on the day of "Event Beta"'],
    ['email_ref', email, 'relates_to_email', 0.9, 'Entry relates to email "Subject Gamma"'],
    ['note_ref', randomUUID(), 'mentions_note', 0.9, 'Entry mentions note "Note Delta"'],
  ]);
}

const RETIRED_NAMES = ['Contact Alpha', 'Event Beta', 'Subject Gamma', 'Note Delta'];

describe.skipIf(!TEST_DB)('get_entry', () => {
  beforeEach(async () => {
    await resetJournalData();
    await admin`DELETE FROM link_edge WHERE source_type = 'journal_entry'`;
    await admin`DELETE FROM public_artifact WHERE source_system = 'youtube'`;
    await admin`DELETE FROM task_ref WHERE external_list_id = 'list-get-entry'`;
    await admin`DELETE FROM entity_ref WHERE normalized_name LIKE 'synthetic %'`;
    const tables = await admin<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ${admin(RETIRED_TABLES)}
    `;
    retiredPresent = new Set(tables.map((t) => t.table_name));
    for (const t of retiredPresent) await admin`DELETE FROM ${admin(t)}`;
  });

  it('leaves out links to artifacts that have left search', async () => {
    const entry = await seedJournalEntry({ vector: null });
    const live = await seedArtifact('Live piece', null);
    const retired = await seedArtifact('Retired piece', null);
    await admin`UPDATE public_artifact SET status = 'superseded' WHERE id = ${retired}`;
    await admin`
      INSERT INTO link_edge (user_id, source_type, source_id, target_type, target_id, link_type, confidence)
      VALUES ('default', 'journal_entry', ${entry}, 'public_artifact', ${live}, 'echoes_artifact', 0.9),
             ('default', 'journal_entry', ${entry}, 'public_artifact', ${retired}, 'echoes_artifact', 0.8)
    `;
    const r = await ok('get_entry', { entry_id: entry });
    expect(r.links.map((l: any) => l.target_title)).toEqual(['Live piece']);
  });

  for (const minConfidence of [undefined, 0]) {
    it(`returns only published pieces, entities and tasks (min_confidence ${minConfidence ?? 'default'})`, async () => {
      const entry = await seedJournalEntry({ vector: null });
      await seedEveryTargetType(entry, 'personal');
      const r = await callTool('get_entry', { entry_id: entry, min_confidence: minConfidence });
      expect(r.isError).toBe(false);
      expect(r.json.links.map((l: any) => [l.target_type, l.link_type, l.target_title])).toEqual([
        ['entity_ref', 'mentions_entity', 'Synthetic concept'],
        ['public_artifact', 'echoes_artifact', 'Synthetic piece'],
        ['task_ref', 'relates_to_task', 'Synthetic family task'],
        ['task_ref', 'relates_to_task', 'Synthetic personal task'],
      ]);
      for (const name of RETIRED_NAMES) expect(r.texts.join('\n')).not.toContain(name);
    });
  }

  it('shows a family entry its entities and family tasks only, and no family calendar event', async () => {
    const entry = await seedJournalEntry({ vector: null, scope: 'family' });
    await seedEveryTargetType(entry, 'family');
    const r = await callTool('get_entry', { entry_id: entry, min_confidence: 0 });
    expect(r.isError).toBe(false);
    expect(r.json.links.map((l: any) => [l.target_type, l.target_title])).toEqual([
      ['entity_ref', 'Synthetic concept'],
      ['task_ref', 'Synthetic family task'],
    ]);
    for (const name of RETIRED_NAMES) expect(r.texts.join('\n')).not.toContain(name);
  });
});
