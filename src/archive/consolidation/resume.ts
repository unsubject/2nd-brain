// Resume collection runs that a restart cut short. Collectors run inside
// the app process, so every deploy stops a run mid-way; its row stays
// 'running' until its heartbeats stop. This sweeper starts a fresh run with
// the same settings and marks the old one failed ("interrupted") in the
// same transaction (staging.startRun), so a start that fails leaves the old
// run for the next sweep. A normal run skips everything already staged, so
// it continues where the old one stopped; a refetch run starts its re-read
// over. A run is resumed at most MAX_RESUMES times in a row, so one that
// keeps killing the process can't loop.

import { describeGoogleError } from "../../google/errors";
import { pool, type DB } from "../../db/client";
import { startCollection, type CollectRequest } from "./runner";
import { interruptedRuns, markInterrupted, RunAlreadyActiveError, type InterruptedRun } from "./staging";

export const MAX_RESUMES = 3;
const FIRST_SWEEP_DELAY_MS = 30_000;
const SWEEP_INTERVAL_MS = 60_000;

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

// The request that continues `run`, or null when it can't or mustn't be
// resumed (params unusable, or resumed MAX_RESUMES times already). Keeps
// `refetch`: a refetch run re-reads what is already staged, so its
// continuation has to as well, or it would skip what the old run never
// reached and still end 'succeeded'.
export function resumeRequest(run: InterruptedRun): CollectRequest | null {
  const p = run.params ?? {};
  const count = typeof p.resumeCount === "number" ? p.resumeCount : 0;
  if (count >= MAX_RESUMES) return null;
  if (run.source === "extract" || run.source === "match") {
    // Both rebuild their whole output, so running again is the resume.
    return { source: run.source, resumedFrom: run.id, resumeCount: count + 1 };
  }
  const resume = { refetch: p.refetch === true, resumedFrom: run.id, resumeCount: count + 1 };
  if (run.source === "gmail") {
    if (typeof p.label !== "string" || p.label.trim() === "") return null;
    return { source: "gmail", label: p.label, ...resume };
  }
  if (run.source === "gdrive") {
    const ids = p.folderIds;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && DRIVE_ID.test(id))) {
      return null;
    }
    return { source: "gdrive", folderIds: ids as string[], ...resume };
  }
  return null;
}

// `start` must record the new run with startRun(..., req.resumedFrom), as
// startCollection does, so that taking over the old run and recording the
// new one are one step.
export async function resumeInterruptedRuns(
  start: (req: CollectRequest) => Promise<string> = startCollection,
  db: DB = pool
): Promise<string[]> {
  const started: string[] = [];
  for (const run of await interruptedRuns(db)) {
    const req = resumeRequest(run);
    if (!req) {
      if (await markInterrupted(run.id, db)) {
        console.error(
          `[consolidation] ${run.source} run ${run.id} was interrupted and is not resumed ` +
            `(resumed ${MAX_RESUMES} times already, or unusable params); start it again by hand`
        );
      }
      continue;
    }
    try {
      const id = await start(req);
      started.push(id);
      console.log(`[consolidation] ${run.source} run ${run.id} was interrupted; resumed as ${id} (resume ${req.resumeCount})`);
    } catch (err) {
      if (err instanceof RunAlreadyActiveError) {
        console.log(`[consolidation] ${run.source} run ${run.id} was interrupted; not resumed here: ${err.message}`);
      } else {
        console.error(
          `[consolidation] could not resume ${run.source} run ${run.id} (the next sweep tries again):`,
          describeGoogleError(err)
        );
      }
    }
  }
  return started;
}

export function startCollectionResumer(): void {
  const sweep = () => {
    resumeInterruptedRuns()
      .catch((err) => console.error("[consolidation] resume sweep failed:", describeGoogleError(err)))
      .finally(() => setTimeout(sweep, SWEEP_INTERVAL_MS));
  };
  setTimeout(sweep, FIRST_SWEEP_DELAY_MS);
}
