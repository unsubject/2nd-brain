import { z } from 'zod';
import type postgres from 'postgres';
import type { ToolResult } from './registry';
import { LINK_TYPES, LINK_STATUSES } from '../ideas/linkTypes';
import { normalizeTags } from '../ideas/text';

// Shared schemas + helpers for the Idea Parking Lot tools
// (docs/idea-parking-lot-protocol.md). Follows the goal_types.ts
// precedent of a shared module next to the tools.
//
// Hyperdrive caching is ON for this Worker. Gardening and import are
// read-after-write loops, so every idea read includes `now() AS as_of`,
// which makes Hyperdrive treat the query as uncacheable. Do not mention
// that function in SQL comments (Hyperdrive pattern-matches query text).

export type Q = postgres.ISql<{}>;

export const ideaStatusSchema = z.enum(['parked', 'exploring', 'used', 'composted']);
export const ideaKindSchema = z.enum(['unit', 'synthesis']);
export const ideaIntentSchema = z.enum(['episode', 'essay', 'series', 'learning', 'undecided']);
export const linkTypeSchema = z.enum(LINK_TYPES);
export const linkStatusSchema = z.enum(LINK_STATUSES);

// Ids are compared in JS as well as SQL; Postgres prints uuids in lower
// case, so normalise inputs the same way.
export const uuidSchema = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());

// One set of field limits for park / import / update / synthesis, so an
// imported value can always be edited and re-sent.
export const LIMITS = {
  title: 500,
  thoughts: 20000,
  why_interesting: 8000,
  encountered_where: 2000,
  source_url: 2048,
  source_title: 1000,
  source_excerpt: 8000,
  framing: 12000,
  note: 8000,
} as const;

export const capturedViaSchema = z
  .object({
    client: z.string().max(100).optional(),
    model: z.string().max(100).optional(),
  })
  .strict();

export const tagsSchema = z.array(z.string().min(1).max(60)).max(20);

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export type NoteBy = 'simon' | 'agent' | 'import' | 'system';
// `credential`: the MCP connection that wrote the note (server-set).
export type Note = { at: string; by: NoteBy; text: string; credential?: string };

// Which credential (connected agent) made a write — stamped server-side.
// The connection that made the call; set by the server, never by the client.
export function credentialLabel(principal: { label: string }): string {
  return principal.label;
}

export function ok(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function toIsoOrNull(v: Date | string | null | undefined): string | null {
  return v === null || v === undefined ? null : toIso(v);
}

// postgres-js runs with fetch_types:false, so a JS array can't be bound
// as a PG array directly. Route text arrays through jsonb instead — this
// survives commas, quotes, backslashes and CJK.
export function textArray(q: Q, arr: readonly string[]) {
  return q`ARRAY(SELECT jsonb_array_elements_text(${q.json([...arr])}))::text[]`;
}

// sql.json() wants a JSONValue; our payloads are plain JSON-safe objects.
export function jsonParam(q: Q, v: unknown) {
  return q.json(v as postgres.JSONValue);
}

// uuid[] literal for ids already validated as uuids by zod.
export function uuidArrayLiteral(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

export function cleanTags(tags: readonly string[] | undefined): string[] {
  return normalizeTags(tags);
}

// jsonb values normally come back parsed; tolerate a double-encoded
// string (see commit_goal_amendment.parseJsonbPayload).
export function parseJsonb<T>(v: unknown, fallback: T): T {
  let cur: unknown = v;
  for (let i = 0; i < 3 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur);
    } catch {
      return fallback;
    }
  }
  return (cur ?? fallback) as T;
}

// Unwrap a jsonb value that an older writer stored as a JSON *string*
// (`${JSON.stringify(x)}::jsonb`, fixed in close_cycle/record_pick and
// repaired by migration 021). Returns anything else unchanged; never throws.
export function unwrapJsonb(v: unknown): unknown {
  let cur: unknown = v;
  for (let i = 0; i < 3 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur);
    } catch {
      return cur;
    }
  }
  return cur;
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.at.localeCompare(b.at));
}

// Columns for a full idea read. Arrays go through to_jsonb (fetch_types:false).
export function ideaColumns(q: Q) {
  return q`
    i.id, i.kind, i.intent, i.title, i.status, i.captured_at,
    i.encountered_where, i.source_url, i.source_title, i.source_excerpt,
    i.why_interesting, i.thoughts, i.framing, i.notes,
    to_jsonb(i.tags) AS tags, i.captured_via, i.edit_log,
    (i.embedding IS NOT NULL) AS embedded, i.embed_error,
    i.status_changed_at, i.created_at, i.updated_at
  `;
}

export type IdeaRow = {
  id: string;
  kind: 'unit' | 'synthesis';
  intent: string | null;
  title: string;
  status: string;
  captured_at: Date | string;
  encountered_where: string | null;
  source_url: string | null;
  source_title: string | null;
  source_excerpt: string | null;
  why_interesting: string | null;
  thoughts: string | null;
  framing: string | null;
  notes: unknown;
  tags: unknown;
  captured_via: unknown;
  edit_log: unknown;
  embedded: boolean;
  embed_error: string | null;
  status_changed_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export function ideaFromRow(r: IdeaRow) {
  return {
    id: r.id,
    kind: r.kind,
    intent: r.intent,
    title: r.title,
    status: r.status,
    captured_at: toIso(r.captured_at),
    encountered_where: r.encountered_where,
    source: {
      url: r.source_url,
      title: r.source_title,
      excerpt: r.source_excerpt,
    },
    why_interesting: r.why_interesting,
    thoughts: r.thoughts,
    framing: r.framing,
    notes: sortNotes(parseJsonb<Note[]>(r.notes, [])),
    tags: parseJsonb<string[]>(r.tags, []),
    captured_via: parseJsonb<Record<string, unknown> | null>(r.captured_via, null),
    // Who changed the idea after capture, oldest first: [{at, credential, tool, fields?}].
    edit_log: parseJsonb<Array<Record<string, unknown>>>(r.edit_log, []),
    embedding_status: r.embedded ? 'embedded' : r.embed_error ? 'error' : 'pending',
    status_changed_at: toIso(r.status_changed_at),
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

export function dbError(e: unknown): ToolResult {
  return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
}

export class HandlerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
