// Keep the candidates in step with the rules without anyone starting a run:
// shortly after boot (so after every deploy), re-extract when a staged item
// has no candidate yet or one made by an older EXTRACTOR_VERSION. When all
// is current this costs one query.

import { pool, type DB } from "../../../db/client";
import { describeGoogleError } from "../../../google/errors";
import { startCollection, type CollectRequest } from "../runner";
import { RunAlreadyActiveError } from "../staging";
import { EXTRACTOR_VERSION } from "./types";

// After the resume sweeper's first pass (30 s), which restarts an extraction
// a deploy cut short; this check then finds that run active and leaves it.
const DELAY_MS = 90_000;

export async function candidatesStale(db: DB = pool): Promise<boolean> {
  const { rows } = await db.query<{ stale: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM archive_source_item s
         LEFT JOIN archive_candidate c ON c.source_item_id = s.id
        WHERE c.id IS NULL OR c.extractor_version < $1
     ) AS stale`,
    [EXTRACTOR_VERSION]
  );
  return rows[0].stale;
}

// The new run's id, or null when nothing was out of date or a run is
// already going.
export async function extractIfStale(
  start: (req: CollectRequest) => Promise<string> = startCollection,
  stale: () => Promise<boolean> = () => candidatesStale()
): Promise<string | null> {
  if (!(await stale())) return null;
  try {
    return await start({ source: "extract" });
  } catch (err) {
    if (err instanceof RunAlreadyActiveError) return null;
    throw err;
  }
}

export function startAutoExtraction(): void {
  setTimeout(() => {
    extractIfStale()
      .then((id) => {
        if (id) console.log(`[consolidation] candidates out of date (extractor v${EXTRACTOR_VERSION}); extraction run ${id} started`);
      })
      .catch((err) => console.error("[consolidation] auto-extraction check failed:", describeGoogleError(err)));
  }, DELAY_MS);
}
