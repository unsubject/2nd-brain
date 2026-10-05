import { collectDrive, emptyDriveStats, type DriveCollectParams } from "./drive";
import { collectGmail, emptyStats, type GmailCollectParams } from "./gmail";
import { describeGoogleError } from "../../google/errors";
import { emptyExtractStats, runExtraction, type ExtractStats } from "./extract/run";
import { finishRun, heartbeatRun, startRun } from "./staging";

// Set on runs started by the resume sweeper (resume.ts); stored in params.
export interface ResumeInfo {
  resumedFrom?: string;
  resumeCount?: number;
}

export type CollectRequest =
  | ({ source: "gmail" } & GmailCollectParams & ResumeInfo)
  | ({ source: "gdrive" } & DriveCollectParams & ResumeInfo)
  | ({ source: "extract" } & ResumeInfo);

// Independent of progress, so a long rate-limit pause never looks like a
// dead process (staging.STALE_RUN_SECONDS is the other side of this).
const HEARTBEAT_MS = 30_000;

// Start a collector in the background and return its run id at once; the
// archive_collect_run row carries progress and the final outcome. A run
// where any item failed ends 'failed' (with the per-item errors in stats)
// so partial loss is never reported as success.
export async function startCollection(req: CollectRequest): Promise<string> {
  const { source, ...params } = req;
  const runId = await startRun(source, params);
  const stats = source === "gmail" ? emptyStats() : source === "gdrive" ? emptyDriveStats() : emptyExtractStats();
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
  const timer = setInterval(() => void progress(), HEARTBEAT_MS);

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
        : runExtraction(stats as ExtractStats, progress, shouldStop);

  job
    .then(() => {
      if (takenOver) {
        // The row already records the outcome (interrupted, resumed elsewhere).
        console.log(`[consolidation] ${source} run ${runId} stopped after being taken over: ${JSON.stringify({ ...stats, errors: undefined })}`);
        return;
      }
      const failed = stats.failed > 0;
      console.log(`[consolidation] ${source} run ${runId} finished: ${JSON.stringify({ ...stats, errors: undefined })}`);
      return finishRun(runId, failed ? "failed" : "succeeded", stats, failed ? `${stats.failed} item(s) failed` : null);
    })
    .catch((err) => {
      // Google errors carry the token request; log only the safe summary.
      console.error(`[consolidation] ${source} run ${runId} failed:`, describeGoogleError(err));
      return finishRun(runId, "failed", stats, err instanceof Error ? err.message : String(err));
    })
    .catch((err) =>
      console.error(`[consolidation] could not record outcome of run ${runId}:`, describeGoogleError(err))
    )
    .finally(() => clearInterval(timer));

  return runId;
}
