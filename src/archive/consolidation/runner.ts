import { collectDrive, emptyDriveStats, type DriveCollectParams } from "./drive";
import { collectGmail, emptyStats, type GmailCollectParams } from "./gmail";
import { describeGoogleError } from "../../google/errors";
import { finishRun, heartbeatRun, startRun } from "./staging";

export type CollectRequest =
  | ({ source: "gmail" } & GmailCollectParams)
  | ({ source: "gdrive" } & DriveCollectParams);

// Start a collector in the background and return its run id at once; the
// archive_collect_run row carries progress and the final outcome. A run
// where any item failed ends 'failed' (with the per-item errors in stats)
// so partial loss is never reported as success.
export async function startCollection(req: CollectRequest): Promise<string> {
  const { source, ...params } = req;
  const runId = await startRun(source, params);
  const stats = source === "gmail" ? emptyStats() : emptyDriveStats();
  const progress = () =>
    heartbeatRun(runId, stats).catch((err) =>
      console.error(`[consolidation] heartbeat failed for run ${runId}:`, describeGoogleError(err))
    );

  const job =
    req.source === "gmail"
      ? collectGmail({ label: req.label, refetch: req.refetch }, stats, progress)
      : collectDrive({ folderIds: req.folderIds, refetch: req.refetch }, stats as ReturnType<typeof emptyDriveStats>, progress);

  job
    .then(() => {
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
    );

  return runId;
}
