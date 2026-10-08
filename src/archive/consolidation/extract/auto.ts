// Keep candidates (step 2), works (step 3) and their public_artifact rows
// (step 4) in step with the rules without anyone starting a run: shortly
// after boot (so after every deploy), re-extract when a staged item has no
// candidate yet or one made by an older EXTRACTOR_VERSION (a successful
// extraction then starts matching, and matching loading, by itself), else
// re-match when the works are older than the candidates or MATCHER_VERSION,
// else load when no load by this LOADER_VERSION has run since the works
// were made. When all is current this costs three queries.

import { pool, type DB } from "../../../db/client";
import { describeGoogleError } from "../../../google/errors";
import { LOADER_VERSION, loadStale } from "../load/run";
import { MATCHER_VERSION } from "../match/run";
import { startCollection, type CollectRequest } from "../runner";
import { RunAlreadyActiveError } from "../staging";
import { EXTRACTOR_VERSION } from "./types";

export { loadStale };

// After the resume sweeper's first pass (30 s), which restarts a run a
// deploy cut short; this check then finds that run active and leaves it.
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

export async function worksStale(db: DB = pool): Promise<boolean> {
  const { rows } = await db.query<{ stale: boolean }>(
    `SELECT COALESCE(
       EXISTS (SELECT 1 FROM archive_work WHERE matcher_version < $1)
       OR EXISTS (
         SELECT 1 FROM archive_candidate c
          WHERE c.status IN ('keep', 'review')
            AND NOT EXISTS (SELECT 1 FROM archive_work_member m WHERE m.candidate_id = c.id))
       OR (SELECT max(extracted_at) FROM archive_candidate) > (SELECT min(matched_at) FROM archive_work),
       false) AS stale`,
    [MATCHER_VERSION]
  );
  return rows[0].stale;
}

const MESSAGES = {
  extract: `candidates out of date (extractor v${EXTRACTOR_VERSION})`,
  match: `works out of date (matcher v${MATCHER_VERSION})`,
  load: `archive rows out of date (loader v${LOADER_VERSION})`,
};

// The step started and its run id, or null when everything was current or
// a run is already going.
export async function catchUp(
  start: (req: CollectRequest) => Promise<string> = startCollection,
  stale: { candidates: () => Promise<boolean>; works: () => Promise<boolean>; load?: () => Promise<boolean> } = {
    candidates: () => candidatesStale(),
    works: () => worksStale(),
    load: () => loadStale(),
  }
): Promise<{ source: "extract" | "match" | "load"; runId: string } | null> {
  const source = (await stale.candidates())
    ? "extract"
    : (await stale.works())
      ? "match"
      : (await stale.load?.())
        ? "load"
        : null;
  if (!source) return null;
  try {
    return { source, runId: await start({ source }) };
  } catch (err) {
    if (err instanceof RunAlreadyActiveError) return null;
    throw err;
  }
}

export function startAutoExtraction(): void {
  setTimeout(() => {
    catchUp()
      .then((r) => {
        if (r) console.log(`[consolidation] ${MESSAGES[r.source]}; ${r.source} run ${r.runId} started`);
      })
      .catch((err) => console.error("[consolidation] catch-up check failed:", describeGoogleError(err)));
  }, DELAY_MS);
}
