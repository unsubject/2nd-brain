// Keep candidates (step 2), works (step 3) and their public_artifact rows
// (step 4) in step with the rules without anyone starting a run: shortly
// after boot (so after every deploy), collect Gmail again when a staged
// message looks garbled by an older DECODER_VERSION, else re-extract when a staged item has no
// candidate yet, one made by an older EXTRACTOR_VERSION or one older than
// the item, else re-match when the works are older than the candidates or
// MATCHER_VERSION (worksStale), else load when no load by this
// LOADER_VERSION has read the works as they are. Only the first step due
// is started: each step starts the next when it ends (runner.nextStep), so
// an extraction is followed by matching and loading, even one that failed
// on an item (whose candidate then stays out of date, so this check
// extracts again on every boot until the rules handle it). When all is
// current this costs four queries. Collections start extraction
// themselves when they end; this check covers what a deploy or a rule
// change left behind.

import { pool, type DB } from "../../../db/client";
import { describeGoogleError } from "../../../google/errors";
import { LOADER_VERSION, loadStale } from "../load/run";
import { MATCHER_VERSION } from "../match/run";
import { DECODER_VERSION } from "../mime";
import { startCollection, type CollectRequest } from "../runner";
import { gmailRefetchDue, RunAlreadyActiveError, RunBlockedError, type CollectorSource } from "../staging";
import { candidatesStale } from "./run";
import { EXTRACTOR_VERSION } from "./types";

export { candidatesStale, loadStale };

// After the resume sweeper's first pass (30 s). A collection that is live
// then (resumed, or its old process's heartbeat not yet stale) holds
// extraction back; the check is repeated every RECHECK_MS until it isn't,
// in case that collection never ends normally to start extraction itself.
const DELAY_MS = 90_000;
const RECHECK_MS = 60_000;
// Re-fetches of garbled Gmail messages the boot check starts at most: one
// whose fetch failed (a 500, say) leaves its message due, so the check
// looks again once that run has ended.
const GMAIL_TRIES = 3;

// The works are out of date: made by an older MATCHER_VERSION, missing a
// kept candidate, older than a candidate, or made by a match that started
// before an extraction ended. The step after such a match runs it again
// (runner.nextStep); the last check covers a restart that cut that short.
// Comparing times can miss that case: extracted_at is when an item was
// read, which can be before matched_at although its candidate was written
// after the match read the candidates.
export async function worksStale(db: DB = pool): Promise<boolean> {
  const { rows } = await db.query<{ stale: boolean }>(
    `SELECT COALESCE(
       EXISTS (SELECT 1 FROM archive_work WHERE matcher_version < $1)
       OR EXISTS (
         SELECT 1 FROM archive_candidate c
          WHERE c.status IN ('keep', 'review')
            AND NOT EXISTS (SELECT 1 FROM archive_work_member m WHERE m.candidate_id = c.id))
       OR (SELECT max(extracted_at) FROM archive_candidate) > (SELECT min(matched_at) FROM archive_work)
       OR EXISTS (
         SELECT 1 FROM archive_collect_run e
          WHERE e.source = 'extract' AND e.status <> 'running'
            AND e.finished_at >= coalesce(
                  (SELECT max(started_at) FROM archive_collect_run WHERE source = 'match' AND status = 'succeeded'),
                  '-infinity')),
       false) AS stale`,
    [MATCHER_VERSION]
  );
  return rows[0].stale;
}

type Step = "gmail" | "extract" | "match" | "load";

const MESSAGES: Record<Step, string> = {
  gmail: `Gmail messages garbled by an older decoder (decoder v${DECODER_VERSION})`,
  extract: `candidates out of date (extractor v${EXTRACTOR_VERSION})`,
  match: `works out of date (matcher v${MATCHER_VERSION})`,
  load: `archive rows out of date (loader v${LOADER_VERSION})`,
};

// The step started and its run id; `waitingFor` (and the step due) when
// extraction is due but a collection is live, or a re-fetch of garbled
// Gmail messages is due but another Gmail run is live (a label's run may
// not list them all); null when everything was current or a run of the
// step is already going.
export async function catchUp(
  start: (req: CollectRequest) => Promise<string> = startCollection,
  stale: {
    gmail?: () => Promise<boolean>;
    candidates: () => Promise<boolean>;
    works: () => Promise<boolean>;
    load?: () => Promise<boolean>;
  } = {
    gmail: () => gmailRefetchDue(),
    candidates: () => candidatesStale(),
    works: () => worksStale(),
    load: () => loadStale(),
  }
): Promise<{ source: Step; runId: string } | { waitingFor: CollectorSource; step: Step } | null> {
  // Messages an older decoder garbled are collected again first; the
  // collection then starts extraction (runner.nextStep), and so on.
  const source = (await stale.gmail?.())
    ? "gmail"
    : (await stale.candidates())
      ? "extract"
      : (await stale.works())
        ? "match"
        : (await stale.load?.())
          ? "load"
          : null;
  if (!source) return null;
  try {
    // The collection fetches just those messages, by id, so it needs no
    // label (they may have come from any).
    const req: CollectRequest = source === "gmail" ? { source, garbledOnly: true } : { source };
    return { source, runId: await start(req) };
  } catch (err) {
    if (err instanceof RunBlockedError) return { waitingFor: err.blockedBy, step: source };
    if (err instanceof RunAlreadyActiveError) return source === "gmail" ? { waitingFor: "gmail", step: source } : null;
    throw err;
  }
}

// The same check, now: after a change the boot check would otherwise
// only see at the next deploy, such as a YouTube transcript imported for a
// video an old row is a copy of (loadStale).
export function catchUpNow(why: string): void {
  catchUp()
    .then((r) => {
      if (r && !("waitingFor" in r)) console.log(`[consolidation] ${MESSAGES[r.source]} after ${why}; ${r.source} run ${r.runId} started`);
    })
    .catch((err) => console.error("[consolidation] catch-up check failed:", describeGoogleError(err)));
}

// Whether the boot check looks again: while a collection it waits for is
// live, and after a re-fetch it started, up to GMAIL_TRIES of them (while
// that run is going the next look waits for it).
export function looksAgain(r: Awaited<ReturnType<typeof catchUp>>, gmailRuns: number): boolean {
  if (!r) return false;
  return "waitingFor" in r || (r.source === "gmail" && gmailRuns < GMAIL_TRIES);
}

export function startAutoExtraction(): void {
  let waiting = false;
  let gmailRuns = 0;
  const check = () => {
    catchUp()
      .then((r) => {
        if (r && "waitingFor" in r) {
          if (!waiting) console.log(`[consolidation] ${MESSAGES[r.step]}; waiting for the ${r.waitingFor} collection run`);
          waiting = true;
        } else if (r) {
          console.log(`[consolidation] ${MESSAGES[r.source]}; ${r.source} run ${r.runId} started`);
          if (r.source === "gmail") gmailRuns += 1;
        }
        if (looksAgain(r, gmailRuns)) setTimeout(check, RECHECK_MS);
      })
      .catch((err) => console.error("[consolidation] catch-up check failed:", describeGoogleError(err)));
  };
  setTimeout(check, DELAY_MS);
}
