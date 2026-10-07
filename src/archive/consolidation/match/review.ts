// Read side of step 3: list works and show one with its members.

import { pool, type DB } from "../../../db/client";

export interface WorkListQuery {
  status?: "keep" | "review";
  limit: number;
  offset: number;
}

export function parseWorkListQuery(q: Record<string, unknown>): WorkListQuery | string {
  const out: WorkListQuery = { limit: 50, offset: 0 };
  if (q.status !== undefined) {
    if (q.status !== "keep" && q.status !== "review") return "status must be one of: keep, review";
    out.status = q.status;
  }
  for (const [key, max] of [["limit", 200], ["offset", 1_000_000]] as const) {
    const v = q[key];
    if (v === undefined) continue;
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < (key === "limit" ? 1 : 0) || n > max) {
      return `${key} must be an integer from ${key === "limit" ? 1 : 0} to ${max}`;
    }
    out[key] = n;
  }
  return out;
}

export async function listWorks(q: WorkListQuery, db: DB = pool): Promise<{ total: number; works: Record<string, unknown>[] }> {
  const params: unknown[] = [];
  const cond = q.status ? `WHERE w.status = $${params.push(q.status)}` : "";
  const { rows: count } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM archive_work w ${cond}`, params);
  const { rows } = await db.query(
    `SELECT w.id, w.title, w.published_at, w.outlet, w.column_name, w.outlets, w.is_published, w.status,
            w.reasons, w.member_count, w.char_count, left(c.body_text, 200) AS snippet
       FROM archive_work w JOIN archive_candidate c ON c.id = w.canonical_candidate_id
       ${cond}
      ORDER BY w.published_at DESC NULLS LAST, w.id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.limit, q.offset]
  );
  return { total: count[0].n, works: rows };
}

export async function getWork(id: string, db: DB = pool): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query(
    `SELECT w.*, c.body_text AS canonical_text FROM archive_work w
       JOIN archive_candidate c ON c.id = w.canonical_candidate_id WHERE w.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const { rows: members } = await db.query(
    `SELECT m.candidate_id, m.role, m.similarity, c.source, c.kind, c.status, c.title, c.outlet,
            c.published_at, c.char_count, s.source_ref, left(c.body_text, 200) AS snippet
       FROM archive_work_member m
       JOIN archive_candidate c ON c.id = m.candidate_id
       JOIN archive_source_item s ON s.id = c.source_item_id
      WHERE m.work_id = $1
      ORDER BY m.role = 'canonical' DESC, c.published_at NULLS LAST`,
    [id]
  );
  return { ...rows[0], members };
}
