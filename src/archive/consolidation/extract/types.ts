// A candidate is one staged source item turned into essay text plus what
// extraction could tell about it. Matching (step 3) groups candidates of the
// same piece; loading (step 4) picks the canonical text among them.

// Bump with every rule change: the app re-extracts on boot when candidates
// were made by an older version (extract/auto.ts).
export const EXTRACTOR_VERSION = 3;

export type CandidateKind =
  | "submission" // an email Simon sent to an editor or outlet with the piece
  | "attachment" // a .docx Simon attached to such an email
  | "newsletter" // a newsletter issue as emailed (Revue, unsubject.me, Patreon)
  | "self_draft" // sent only to his own addresses
  | "post" // WordPress / Substack post
  | "page" // WordPress page
  | "doc" // Drive Google Doc or .docx
  | "reply" // a short message: a note to an editor, an answer to a reader
  | "forward" // Simon forwarding an email; the original is staged on its own
  | "received" // sent by someone else: editors, readers, acknowledgements
  | "platform_copy" // an emailed copy of a post the platform export already has
  | "draft" // unpublished WordPress/Substack draft
  | "empty" // no usable text
  | "duplicate"; // a second copy of the same newsletter issue

export const CANDIDATE_KINDS: readonly CandidateKind[] = [
  "submission",
  "attachment",
  "newsletter",
  "self_draft",
  "post",
  "page",
  "doc",
  "reply",
  "forward",
  "received",
  "platform_copy",
  "draft",
  "empty",
  "duplicate",
];

export type CandidateStatus = "keep" | "review" | "drop";
export const CANDIDATE_STATUSES: readonly CandidateStatus[] = ["keep", "review", "drop"];

export interface Candidate {
  kind: CandidateKind;
  status: CandidateStatus;
  reasons: string[];
  title: string | null;
  // Where it was published: 蘋果日報, 爽報, 壹週刊, 尚生活, Points Media,
  // Revue, unsubject.me, Patreon, Substack, WordPress (<host>), …
  outlet: string | null;
  // Column or series name when known: 利字當頭, 蘋果論壇, 壹擋專政, …
  column: string | null;
  publishedAt: Date | null;
  // How publishedAt was found: sent | subject | export | file-created | email
  dateSource: string | null;
  isPublished: boolean | null;
  bodyText: string | null;
  // Text removed before the essay (a note to the editor), kept for review.
  note: string | null;
  // Newsletter copies of one issue share a key; all but one become duplicates.
  dedupeKey: string | null;
}

export interface StagedItem {
  id: string;
  source: "gmail" | "gdrive" | "wordpress" | "substack";
  sourceRef: string;
  containerRef: string | null;
  title: string | null;
  authoredAt: Date | null;
  rawText: string | null;
  rawHtml: string | null;
  metadata: Record<string, unknown>;
}

export function candidate(partial: Partial<Candidate> & Pick<Candidate, "kind" | "status">): Candidate {
  return {
    reasons: [],
    title: null,
    outlet: null,
    column: null,
    publishedAt: null,
    dateSource: null,
    isPublished: null,
    bodyText: null,
    note: null,
    dedupeKey: null,
    ...partial,
  };
}
