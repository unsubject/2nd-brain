import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { isSymmetric, linkLabel, type LinkType } from '../ideas/linkTypes';
import {
  dbError,
  errorResult,
  ideaColumns,
  ideaFromRow,
  ok,
  parseJsonb,
  toIso,
  toIsoOrNull,
  uuidSchema,
  type IdeaRow,
} from './idea_shared';

const inputSchema = z
  .object({
    id: uuidSchema,
    include_payloads: z.boolean().optional(),
    include_pending: z.boolean().optional(),
  })
  .strict();

type LinkRow = {
  id: string;
  link_type: LinkType;
  status: string;
  rationale: string;
  similarity: number | null;
  proposed_by: string;
  proposed_via: unknown;
  proposed_at: Date;
  decided_at: Date | null;
  decided_via: unknown;
  source_idea_id: string;
  target_idea_id: string | null;
  target_artifact_id: string | null;
  other_id: string | null;
  other_title: string | null;
  other_kind: string | null;
  other_status: string | null;
  artifact_title: string | null;
  artifact_url: string | null;
  artifact_published_at: Date | null;
  artifact_type: string | null;
};

export async function getIdeaHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { id } = parsed.data;
  const includePayloads = parsed.data.include_payloads ?? false;
  const includePending = parsed.data.include_pending ?? false;

  const sql = getDb(env);
  try {
    const rows = await sql<Array<IdeaRow & { as_of: Date }>>`
      SELECT ${ideaColumns(sql)}, now() AS as_of
        FROM idea i
       WHERE i.id = ${id} AND i.user_id = ${env.BRAIN_USER_ID}
    `;
    if (rows.length === 0) return errorResult(`Idea not found: ${id}`);

    const sources = await sql<
      Array<{
        source_system: string;
        source_external_id: string | null;
        merged: boolean;
        imported_at: Date;
        import_payload: unknown;
      }>
    >`
      SELECT source_system, source_external_id, merged, imported_at,
             ${includePayloads ? sql`import_payload` : sql`NULL::jsonb AS import_payload`},
             now() AS as_of
        FROM idea_source
       WHERE idea_id = ${id} AND user_id = ${env.BRAIN_USER_ID}
       ORDER BY imported_at
    `;

    const links = await sql<Array<LinkRow>>`
      SELECT l.id, l.link_type, l.status, l.rationale, l.similarity, l.proposed_by,
             l.proposed_via, l.proposed_at, l.decided_at, l.decided_via,
             l.source_idea_id, l.target_idea_id, l.target_artifact_id,
             o.id AS other_id, o.title AS other_title, o.kind AS other_kind, o.status AS other_status,
             a.title AS artifact_title, a.canonical_url AS artifact_url,
             a.published_at AS artifact_published_at, a.type AS artifact_type,
             now() AS as_of
        FROM idea_link l
        LEFT JOIN idea o
               ON l.target_idea_id IS NOT NULL
              AND o.id = CASE WHEN l.source_idea_id = ${id} THEN l.target_idea_id ELSE l.source_idea_id END
        LEFT JOIN public_artifact a ON a.id = l.target_artifact_id
       WHERE l.user_id = ${env.BRAIN_USER_ID}
         AND (l.source_idea_id = ${id} OR l.target_idea_id = ${id})
         AND l.status IN ('accepted', 'proposed')
       ORDER BY l.decided_at DESC NULLS LAST, l.proposed_at DESC
    `;

    const view = (l: LinkRow) => {
      const direction = isSymmetric(l.link_type) ? 'both' : l.source_idea_id === id ? 'out' : 'in';
      return {
        link_id: l.id,
        link_type: l.link_type,
        // How the type is shown to the user (tension_with -> contradicts).
        label: linkLabel(l.link_type),
        status: l.status,
        direction,
        rationale: l.rationale,
        similarity: l.similarity,
        proposed_by: l.proposed_by,
        proposed_via: parseJsonb<Record<string, unknown> | null>(l.proposed_via, null),
        proposed_at: toIso(l.proposed_at),
        decided_at: toIsoOrNull(l.decided_at),
        decided_via: parseJsonb<Record<string, unknown> | null>(l.decided_via, null),
        ...(l.target_artifact_id
          ? {
              artifact: {
                id: l.target_artifact_id,
                title: l.artifact_title,
                url: l.artifact_url,
                published_at: toIsoOrNull(l.artifact_published_at),
                type: l.artifact_type,
              },
            }
          : {
              other: { id: l.other_id, title: l.other_title, kind: l.other_kind, status: l.other_status },
            }),
      };
    };

    const accepted = links.filter((l) => l.status === 'accepted');
    const pending = links.filter((l) => l.status === 'proposed');
    const parts = accepted
      .filter((l) => l.link_type === 'part_of' && l.target_idea_id === id)
      .map((l) => ({ id: l.other_id, title: l.other_title, status: l.other_status }));
    const partOf = accepted
      .filter((l) => l.link_type === 'part_of' && l.source_idea_id === id)
      .map((l) => ({ id: l.other_id, title: l.other_title, status: l.other_status }));
    const territory = accepted.some((l) => l.link_type === 'became' && l.source_idea_id === id)
      ? 'territory'
      : accepted.some((l) => l.link_type === 'revisits' && l.source_idea_id === id)
        ? 'adjacent'
        : 'frontier';

    return ok({
      as_of: toIso(rows[0].as_of),
      idea: ideaFromRow(rows[0]),
      territory,
      sources: sources.map((s) => ({
        source_system: s.source_system,
        source_external_id: s.source_external_id,
        merged: s.merged,
        imported_at: toIso(s.imported_at),
        ...(includePayloads ? { import_payload: s.import_payload } : {}),
      })),
      links: accepted.map(view),
      pending_count: pending.length,
      ...(includePending ? { pending: pending.map(view) } : {}),
      parts,
      part_of: partOf,
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}
