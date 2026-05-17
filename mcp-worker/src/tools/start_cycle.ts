import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  undertaking_id: z.string().uuid(),
});

export async function startCycleHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { undertaking_id } = parsed.data;

  const sql = getDb(env);
  try {
    const result = await sql.begin(async (tx) => {
      const u = await tx<Array<{ kind: string; status: string }>>`
        SELECT kind, status FROM undertakings
         WHERE id = ${undertaking_id} AND user_id = ${env.BRAIN_USER_ID}
      `;
      if (u.length === 0) {
        throw new HandlerError('not_found', `Undertaking not found: ${undertaking_id}`);
      }
      if (u[0].kind !== 'habit_forming') {
        throw new HandlerError(
          'validation_failed',
          `start_cycle applies only to habit_forming undertakings (got kind=${u[0].kind})`,
        );
      }
      if (u[0].status !== 'active') {
        throw new HandlerError(
          'validation_failed',
          `Undertaking is ${u[0].status}; cannot start a cycle`,
        );
      }

      const existing = await tx<Array<{ id: string }>>`
        SELECT id FROM undertaking_cycles
         WHERE undertaking_id = ${undertaking_id} AND status = 'active'
         LIMIT 1
      `;
      if (existing.length > 0) {
        throw new HandlerError(
          'conflict',
          `An active cycle (${existing[0].id}) already exists. Close it first.`,
        );
      }

      const maxRows = await tx<Array<{ max: number | null }>>`
        SELECT MAX(cycle_number) AS max FROM undertaking_cycles
         WHERE undertaking_id = ${undertaking_id}
      `;
      const nextNumber = (maxRows[0].max ?? 0) + 1;

      const ins = await tx<
        Array<{ id: string; cycle_number: number; end_date: Date | string }>
      >`
        INSERT INTO undertaking_cycles (
          undertaking_id, cycle_number, start_date, end_date
        ) VALUES (
          ${undertaking_id}, ${nextNumber},
          CURRENT_DATE, CURRENT_DATE + INTERVAL '28 days'
        )
        RETURNING id, cycle_number, end_date
      `;
      return ins[0];
    });

    const endDateIso =
      typeof result.end_date === 'string'
        ? result.end_date
        : (result.end_date as Date).toISOString().slice(0, 10);

    return ok({
      cycle_id: result.id,
      cycle_number: result.cycle_number,
      end_date: endDateIso,
    });
  } catch (e) {
    if (e instanceof HandlerError) {
      return errorResult(`${e.code}: ${e.message}`);
    }
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

class HandlerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function ok(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
