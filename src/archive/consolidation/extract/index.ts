import { extractDrive, extractSubstack, extractWordPress } from "./exports";
import { extractGmail } from "./gmail";
import { textLength } from "./text";
import type { Candidate, StagedItem } from "./types";

export { CANDIDATE_KINDS, CANDIDATE_STATUSES, EXTRACTOR_VERSION } from "./types";
export type { Candidate, CandidateKind, CandidateStatus, StagedItem } from "./types";

export function extract(item: StagedItem): Candidate {
  switch (item.source) {
    case "gmail":
      return extractGmail(item);
    case "wordpress":
      return extractWordPress(item);
    case "substack":
      return extractSubstack(item);
    case "gdrive":
      return extractDrive(item);
  }
}

export function charCount(c: Candidate): number {
  return textLength(c.bodyText);
}
