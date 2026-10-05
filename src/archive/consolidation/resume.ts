// Resume collection runs that a restart cut short. Collectors run inside
// the app process, so every deploy stops a run mid-way; its row stays
// 'running' until its heartbeats stop. This sweeper marks such runs failed
// ("interrupted") and starts a fresh run with the same settings, which
// skips everything already staged. A run is resumed at most MAX_RESUMES
// times in a row, so one that keeps killing the process can't loop.

import { describeGoogleError } from "../../google/errors";
import { startCollection, type CollectRequest } from "./runner";
import { claimInterruptedRuns, RunAlreadyActiveError, type InterruptedRun } from "./staging";

export const MAX_RESUMES = 3;
const FIRST_SWEEP_DELAY_MS = 30_000;
const SWEEP_INTERVAL_MS = 60_000;

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

// The request that continues `run`, or null when it can't or mustn't be
// resumed (params unusable, or resumed MAX_RESUMES times already). Always
// refetch: false, so a resumed run never starts over from scratch.
export function resumeRequest(run: InterruptedRun): CollectRequest | null {
  const p = run.params ?? {};
  const count = typeof p.resumeCount === "number" ? p.resumeCount : 0;
  if (count >= MAX_RESUMES) return null;
  if (run.source === "extract") {
    // Extraction rewrites every candidate, so running it again is the resume.
    return { source: "extract", resumedFrom: run.id, resumeCount: count + 1 };
  }
  const resume = { refetch: false, resumedFrom: run.id, resumeCount: count + 1 };
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

export async function resumeInterruptedRuns(
  start: (req: CollectRequest) => Promise<string> = startCollection,
  claim: () => Promise<InterruptedRun[]> = () => claimInterruptedRuns()
): Promise<string[]> {
  const started: string[] = [];
  for (const run of await claim()) {
    const req = resumeRequest(run);
    if (!req) {
      console.error(
        `[consolidation] ${run.source} run ${run.id} was interrupted and is not resumed ` +
          `(resumed ${MAX_RESUMES} times already, or unusable params); start it again by hand`
      );
      continue;
    }
    try {
      const id = await start(req);
      started.push(id);
      console.log(`[consolidation] ${run.source} run ${run.id} was interrupted; resumed as ${id} (resume ${req.resumeCount})`);
    } catch (err) {
      if (err instanceof RunAlreadyActiveError) {
        console.log(`[consolidation] ${run.source} run ${run.id} was interrupted; a newer run is already active`);
      } else {
        console.error(`[consolidation] could not resume ${run.source} run ${run.id}:`, describeGoogleError(err));
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
