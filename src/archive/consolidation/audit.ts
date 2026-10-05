import { pool, type DB } from "../../db/client";

// Read-only health snapshot of public_artifact: what the archive holds, by
// source and year, plus the signs of a bad import (2000-char truncation,
// email headers/greetings mixed into the text, duplicate titles, rows stuck
// in error or processing).
const AUDIT_SQL = `
SELECT jsonb_build_object(
  'status_by_source', (SELECT jsonb_agg(x) FROM (
      SELECT source_system, type, processing_status, count(*) AS n
      FROM public_artifact GROUP BY 1,2,3 ORDER BY 1,2,3) x),
  'by_year', (SELECT jsonb_agg(x) FROM (
      SELECT source_system, extract(year FROM published_at)::int AS yr, count(*) AS n
      FROM public_artifact GROUP BY 1,2 ORDER BY 1,2) x),
  'length_buckets', (SELECT jsonb_agg(x) FROM (
      SELECT source_system,
             count(*) FILTER (WHERE length(raw_source) < 500) AS lt500,
             count(*) FILTER (WHERE length(raw_source) BETWEEN 500 AND 1999) AS lt2000,
             count(*) FILTER (WHERE length(raw_source) = 2000) AS eq2000,
             count(*) FILTER (WHERE length(raw_source) > 2000) AS gt2000,
             max(length(raw_source)) AS maxlen
      FROM public_artifact GROUP BY 1) x),
  'url_hosts', (SELECT jsonb_agg(x) FROM (
      SELECT coalesce(substring(canonical_url from '^https?://([^/]+)'), '(none)') AS host, count(*) AS n
      FROM public_artifact WHERE source_system <> 'youtube'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 25) x),
  'errors', (SELECT jsonb_agg(x) FROM (
      SELECT processing_status, left(coalesce(last_error, '(null)'), 120) AS err, count(*) AS n
      FROM public_artifact WHERE processing_status IN ('error', 'processing')
      GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15) x),
  'email_marker_rows', (SELECT count(*) FROM public_artifact
      WHERE source_system <> 'youtube' AND (
            raw_source ~* '(^|\\n)(from|to|subject|sent|cc):\\s'
         OR raw_source ~ '(寄件者|收件者|主旨|副本)[:：]'
         OR raw_source ~ '寫道[:：]'
         OR raw_source ~* 'sent from my (iphone|ipad)'
         OR raw_source ~* '(^|\\n)(dear|hi|hello)\\s')),
  'dup_titles', (SELECT jsonb_build_object('groups', count(*), 'rows', coalesce(sum(n), 0)) FROM (
      SELECT lower(btrim(title)) AS t, count(*) AS n FROM public_artifact
      WHERE source_system <> 'youtube' GROUP BY 1 HAVING count(*) > 1) d),
  'totals', jsonb_build_object(
      'chunks', (SELECT count(*) FROM public_artifact_chunk),
      'entity_mentions', (SELECT count(*) FROM public_artifact_entity),
      'entities', (SELECT count(*) FROM entity_ref),
      'latest_youtube', (SELECT max(published_at) FROM public_artifact WHERE source_system = 'youtube'),
      'latest_other', (SELECT max(published_at) FROM public_artifact WHERE source_system <> 'youtube'))
) AS audit`;

export async function auditPublicArtifacts(db: DB = pool): Promise<Record<string, unknown>> {
  const { rows } = await db.query<{ audit: Record<string, unknown> }>(AUDIT_SQL);
  return rows[0].audit;
}
