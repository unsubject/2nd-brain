// Keep candidates (step 2) and works (step 3) in step with the rules without
// anyone starting a run: shortly after boot (so after every deploy),
// re-extract when a staged item has no candidate yet, one made by an older
// EXTRACTOR_VERSION or one older than the item (a successful extraction
// then starts matching by itself), else re-match when the works are older
// than the candidates or MATCHER_VERSION. When all is current this costs
// two queries. Collections start extraction themselves when they end
// (runner.ts); this check covers what a deploy or a rule change left behind.

import { pool, type DB } from "../../../db/client";
import { describeGoogleError } from "../../../google/errors";
import { MATCHER_VERSION } from "../match/run";
import { startCollection, type CollectRequest } from "../runner";
import { RunAlreadyActiveError, RunBlockedError, type CollectorSource } from "../staging";
import { candidatesStale } from "./run";
import { EXTRACTOR_VERSION } from "./types";

// After the resume sweeper's first pass (30 s). A collection that is live
// then (resumed, or its old process's heartbeat not yet stale) holds
// extraction back; the check is repeated every RECHECK_MS until it isn't,
// in case that collection never ends normally to start extraction itself.
const DELAY_MS = 90_000;
const RECHECK_MS = 60_000;

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

// The step started and its run id; `waitingFor` when extraction is due but
// a collection is live; null when everything was current or a run of the
// step is already going.
export async function catchUp(
  start: (req: CollectRequest) => Promise<string> = startCollection,
  stale: { candidates: () => Promise<boolean>; works: () => Promise<boolean> } = {
    candidates: () => candidatesStale(),
    works: () => worksStale(),
  }
): Promise<{ source: "extract" | "match"; runId: string } | { waitingFor: CollectorSource } | null> {
  const source = (await stale.candidates()) ? "extract" : (await stale.works()) ? "match" : null;
  if (!source) return null;
  try {
    return { source, runId: await start({ source }) };
  } catch (err) {
    if (err instanceof RunBlockedError) return { waitingFor: err.blockedBy };
    if (err instanceof RunAlreadyActiveError) return null;
    throw err;
  }
}

export function startAutoExtraction(): void {
  let waiting = false;
  const check = () => {
    catchUp()
      .then((r) => {
        if (r && "waitingFor" in r) {
          if (!waiting) console.log(`[consolidation] candidates out of date; waiting for the ${r.waitingFor} collection run`);
          waiting = true;
          setTimeout(check, RECHECK_MS);
        } else if (r) {
          console.log(
            `[consolidation] ${r.source === "extract" ? `candidates out of date (extractor v${EXTRACTOR_VERSION})` : `works out of date (matcher v${MATCHER_VERSION})`}; ${r.source} run ${r.runId} started`
          );
        }
      })
      .catch((err) => console.error("[consolidation] catch-up check failed:", describeGoogleError(err)));
  };
  setTimeout(check, DELAY_MS);
}
