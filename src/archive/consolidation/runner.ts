import { collectDrive, emptyDriveStats, type DriveCollectParams } from "./drive";
import { collectGmail, emptyStats, type GmailCollectParams } from "./gmail";
import { pool, type DB } from "../../db/client";
import { describeGoogleError } from "../../google/errors";
import { candidatesStale, emptyExtractStats, runExtraction, type ExtractStats } from "./extract/run";
import { emptyLoadStats, loadStale, runLoad, type LoadStats } from "./load/run";
import { emptyMatchStats, runMatch, type MatchStats } from "./match/run";
import {
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

function startFollowUp(req: CollectRequest): void {
  startCollection(req)
    .then((id) => console.log(`[consolidation] ${req.source} run ${id} started after the previous step`))
    .catch((err) => {
      if (err instanceof RunAlreadyActiveError) {
        console.log(`[consolidation] ${req.source} run not started after the previous step: ${err.message}`);
        return;
      }
      console.error(`[consolidation] could not start ${req.source} run:`, describeGoogleError(err));
    });
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
// - An extraction, whatever its outcome, is followed by another when items
//   were staged or changed while it ran: its scan can miss a collection's
//   rows (extraction doesn't start while a collection is live, but a
//   collection can start during an extraction, and its own follow-up is
//   refused while the extraction is live). After a failed extraction only
//   those items count, so an item that always fails doesn't start run after
//   run (it waits for the boot check or a run by hand). A successful
//   extraction that left every candidate current is followed by matching.
// - A match, whatever its outcome, is followed by another when an
//   extraction succeeded while it ran: that extraction's own match was
//   refused, and this one may have read the candidates before it. Else a
//   successful match (new works) is followed by loading.
// - A load is followed by another when a match ended while it ran, whose
//   own load it refused: after a successful load, whenever the works are
//   not the ones it read (loadStale); after a failed one, only when a match
//   succeeded while it ran, so a load that always fails doesn't start run
//   after run.
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
      if (await candidatesStale(db, succeeded ? undefined : runId)) return { source: "extract" };
      return succeeded ? { source: "match" } : null;
    case "match":
      if (await succeededSince("extract", runId, db)) return { source: "match" };
      return succeeded ? { source: "load" } : null;
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

  job
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
        // The row already records the outcome (interrupted, resumed elsewhere).
        console.log(`[consolidation] ${source} run ${runId} stopped after being taken over: ${counts}`);
        return;
      }
      console.log(`[consolidation] ${source} run ${runId} finished: ${counts}`);
      await finishRun(runId, ok ? "succeeded" : "failed", stats, error);
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

  return runId;
}
