import { collectDrive, emptyDriveStats, type DriveCollectParams } from "./drive";
import { collectGmail, emptyStats, type GmailCollectParams } from "./gmail";
import { pool, type DB } from "../../db/client";
import { describeGoogleError } from "../../google/errors";
import { candidatesStale, emptyExtractStats, runExtraction, type ExtractStats } from "./extract/run";
import { emptyLoadStats, loadStale, runLoad, type LoadStats } from "./load/run";
import { emptyMatchStats, runMatch, type MatchStats } from "./match/run";
import {
  endedSince,
  finishRun,
  heartbeatRun,
  RunAlreadyActiveError,
  startRun,
  succeededSince,
  type CollectorSource,
} from "./staging";

// Set on runs started by the resume sweeper (resume.ts); stored in params.
export interface ResumeInfo {
  resumedFrom?: string;
  resumeCount?: number;
}

export type CollectRequest =
  | ({ source: "gmail" } & GmailCollectParams & ResumeInfo)
  | ({ source: "gdrive" } & DriveCollectParams & ResumeInfo)
  | ({ source: "extract" } & ResumeInfo)
  | ({ source: "match" } & ResumeInfo)
  | ({ source: "load" } & ResumeInfo);

// Independent of progress, so a long rate-limit pause never looks like a
// dead process (staging.STALE_RUN_SECONDS is the other side of this).
const HEARTBEAT_MS = 30_000;

// Each run's job until its outcome is recorded and its next step started,
// and each next step being started.
const inFlight = new Set<Promise<unknown>>();

function track(work: Promise<unknown>): void {
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
}

// Resolves once no run started here is still working, recording its
// outcome or starting the step after it. For tests: a run must not outlive
// the test that started it, or its next step lands in the next test's data.
export async function runsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

function startFollowUp(req: CollectRequest): void {
  track(
    startCollection(req)
      .then((id) => console.log(`[consolidation] ${req.source} run ${id} started after the previous step`))
      .catch((err) => {
        if (err instanceof RunAlreadyActiveError) {
          console.log(`[consolidation] ${req.source} run not started after the previous step: ${err.message}`);
          return;
        }
        console.error(`[consolidation] could not start ${req.source} run:`, describeGoogleError(err));
      })
  );
}

// The step after run `runId` ended, so new material reaches the works and
// public_artifact with no one starting a step: collect -> extract -> match
// -> load. One run per step at a time, so a step's follow-up is refused
// while that step is already running; the running one then checks, when it
// ends, whether it has to run again.
//
// - A collection, whatever its outcome (what it staged is good), is
//   followed by extraction when a staged item lacks a current candidate:
//   its own items, or another collection's whose extraction it held back.
// - An extraction is followed by another when items were staged or changed
//   while it ran: its scan can miss a collection's rows (extraction doesn't
//   start while a collection is live, but a collection can start during an
//   extraction, and its own follow-up is refused while the extraction is
//   live). After a failed extraction only those items count, so an item
//   that always fails doesn't start extraction after extraction. Otherwise
//   it is followed by matching, whatever its outcome: a failed extraction
//   still rewrote the candidates of every item it didn't fail on, and an
//   earlier extraction may have left its own match to this one.
// - A match is followed by another when an extraction ended while it ran,
//   whatever that extraction's outcome: its own match was refused, and
//   this one may have read the candidates before it wrote them. Otherwise
//   a successful match (new works) is followed by loading, and so is a
//   failed one when the works are not the ones the last load read
//   (loadStale): it leaves the works of the last match that succeeded,
//   which may have left its load to the failed one (run again for an
//   extraction, as above).
// - A load is followed by another when a match ended while it ran, whose
//   own load it refused: after a successful load, whenever the works are
//   not the ones it read (loadStale); after a failed one, only when a match
//   succeeded while it ran, so a load that always fails doesn't start run
//   after run.
//
// No step starts the one before it, and a step runs again only for what
// the step before it wrote while it ran, so none of this loops.
export async function nextStep(
  source: CollectorSource,
  succeeded: boolean,
  runId: string,
  db: DB = pool
): Promise<CollectRequest | null> {
  switch (source) {
    case "gmail":
    case "gdrive":
      return (await candidatesStale(db)) ? { source: "extract" } : null;
    case "extract":
      return (await candidatesStale(db, succeeded ? undefined : runId)) ? { source: "extract" } : { source: "match" };
    case "match":
      if (await endedSince("extract", runId, db)) return { source: "match" };
      return succeeded || (await loadStale(db)) ? { source: "load" } : null;
    case "load":
      return (succeeded ? await loadStale(db) : await succeededSince("match", runId, db)) ? { source: "load" } : null;
  }
}

// Start a collector in the background and return its run id at once; the
// archive_collect_run row carries progress and the final outcome. A run
// where any item failed ends 'failed' (with the per-item errors in stats)
// so partial loss is never reported as success.
export async function startCollection(req: CollectRequest): Promise<string> {
  const { source, ...params } = req;
  const runId = await startRun(source, params, pool, req.resumedFrom);
  const stats =
    source === "gmail"
      ? emptyStats()
      : source === "gdrive"
        ? emptyDriveStats()
        : source === "extract"
          ? emptyExtractStats()
          : source === "match"
            ? emptyMatchStats()
            : emptyLoadStats();
  // Set when the row stops being 'running' under us (taken over as
  // interrupted); the collector then stops at its next item.
  let takenOver = false;
  const progress = () =>
    heartbeatRun(runId, stats)
      .then((live) => {
        if (!live && !takenOver) {
          takenOver = true;
          console.error(`[consolidation] run ${runId} is no longer marked running; stopping it`);
        }
      })
      .catch((err) =>
        console.error(`[consolidation] heartbeat failed for run ${runId}:`, describeGoogleError(err))
      );
  const shouldStop = () => takenOver;
  // Cleared when the run ends; unref'd so that a run whose job never settles
  // (its pool ended under it, as at the end of a test) can't keep the
  // process alive.
  const timer = setInterval(() => void progress(), HEARTBEAT_MS);
  timer.unref();

  const job =
    req.source === "gmail"
      ? collectGmail({ label: req.label, refetch: req.refetch }, stats, progress, shouldStop)
      : req.source === "gdrive"
        ? collectDrive(
            { folderIds: req.folderIds, refetch: req.refetch },
            stats as ReturnType<typeof emptyDriveStats>,
            progress,
            shouldStop
          )
        : req.source === "extract"
          ? runExtraction(stats as ExtractStats, progress, shouldStop)
          : req.source === "match"
            ? runMatch(stats as MatchStats, progress, shouldStop)
            : runLoad(stats as LoadStats, progress, shouldStop);

  const outcome = job
    .then(
      () => (stats.failed > 0 ? { ok: false, error: `${stats.failed} item(s) failed` } : { ok: true, error: null }),
      (err) => {
        // Google errors carry the token request; log only the safe summary.
        console.error(`[consolidation] ${source} run ${runId} failed:`, describeGoogleError(err));
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    )
    .then(async ({ ok, error }) => {
      const counts = JSON.stringify({ ...stats, errors: undefined });
      if (takenOver) {
        // The row already records the outcome (interrupted, resumed elsewhere),
        // and the run that continues it, if any, chooses the next step.
        console.log(`[consolidation] ${source} run ${runId} stopped after being taken over: ${counts}`);
        return;
      }
      console.log(`[consolidation] ${source} run ${runId} finished: ${counts}`);
      if (!(await finishRun(runId, ok ? "succeeded" : "failed", stats, error))) {
        // Taken over after its last heartbeat: the same as above.
        console.log(`[consolidation] ${source} run ${runId} was taken over before it ended; no step after it`);
        return;
      }
      const next = await nextStep(source, ok, runId).catch((err) => {
        console.error(`[consolidation] could not choose the step after ${source} run ${runId}:`, describeGoogleError(err));
        return null;
      });
      if (next) startFollowUp(next);
    })
    .catch((err) =>
      console.error(`[consolidation] could not record outcome of run ${runId}:`, describeGoogleError(err))
    )
    .finally(() => clearInterval(timer));
  track(outcome);

  return runId;
}
