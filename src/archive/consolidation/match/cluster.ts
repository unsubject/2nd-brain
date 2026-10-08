// Group candidates into works and pick each work's canonical text, per the
// decisions in docs/archive-consolidation.md: for a column, the last version
// Simon emailed to the outlet; then the piece as published on Substack,
// WordPress or a newsletter; then a Drive document.

import { candidatePairs, overlap, samePiece, shingles } from "./similarity";

export interface MatchCandidate {
  id: string;
  source: string; // gmail | substack | wordpress | gdrive
  kind: string;
  status: "keep" | "review";
  title: string | null;
  outlet: string | null;
  column: string | null;
  publishedAt: Date | null;
  isPublished: boolean | null;
  // When the staged item was sent or written: "last version sent" is the
  // latest of these among the emails to an outlet.
  authoredAt: Date | null;
  bodyText: string;
}

export interface WorkMember {
  candidateId: string;
  role: "canonical" | "copy";
  // Jaccard similarity to the canonical text (1 for the canonical).
  similarity: number;
}

export interface Work {
  canonicalId: string;
  title: string | null;
  // First publication: the earliest date among published members.
  publishedAt: Date | null;
  outlet: string | null;
  column: string | null;
  outlets: string[];
  isPublished: boolean;
  status: "keep" | "review";
  reasons: string[];
  members: WorkMember[];
}

// Lower is preferred as the canonical text.
export function canonicalRank(c: MatchCandidate): number {
  const emailed = c.source === "gmail" && (c.kind === "submission" || c.kind === "attachment");
  if (emailed && c.outlet) return 0;
  // As published on his own platforms; a WordPress page or private post
  // (under review, not published) is no better than any other draft.
  if (c.source === "substack" && c.kind === "post" && c.isPublished) return 1;
  if (c.source === "wordpress" && c.kind === "post" && c.isPublished) return 2;
  if (c.kind === "newsletter") return 3;
  if (emailed) return 4; // to an address at no known outlet
  if (c.source === "gdrive") return 5;
  return 6; // drafts sent to himself, anything else under review
}

function time(d: Date | null): number {
  return d ? d.getTime() : -Infinity;
}

const isAttachment = (c: MatchCandidate) => c.kind === "attachment";

export function pickCanonical(members: MatchCandidate[]): MatchCandidate {
  return [...members].sort(
    (a, b) =>
      canonicalRank(a) - canonicalRank(b) ||
      time(b.authoredAt) - time(a.authoredAt) ||
      // One send with the essay inline and as a .docx: the message's text
      // has its title line, note and sign-off removed, the .docx's not.
      Number(isAttachment(a)) - Number(isAttachment(b)) ||
      b.bodyText.length - a.bodyText.length ||
      a.id.localeCompare(b.id)
  )[0];
}

// A .docx is titled by its file name ("final"): when one is canonical, a
// title from a message (title line or subject) or a published copy is
// better. A Drive document is named by its file too.
function workTitle(canonical: MatchCandidate, ordered: MatchCandidate[]): string | null {
  const better = isAttachment(canonical)
    ? ordered.find((m) => !isAttachment(m) && m.source !== "gdrive" && m.title)?.title
    : null;
  return better ?? canonical.title ?? ordered.find((m) => m.title)?.title ?? null;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

// Members of one work differ this much from the canonical: worth a look,
// though not a reason to hold the work back.
const DIFFERENT_VERSION = 0.6;

export function buildWork(members: MatchCandidate[], sets: Map<string, Uint32Array>): Work {
  const canonical = pickCanonical(members);
  const ordered = [...members].sort((a, b) => canonicalRank(a) - canonicalRank(b) || time(a.publishedAt) - time(b.publishedAt));
  const published = members.filter((m) => m.isPublished);
  const first = [...published].sort((a, b) => time(a.publishedAt) - time(b.publishedAt)).find((m) => m.publishedAt) ?? null;
  const canonSet = sets.get(canonical.id)!;
  const listed = [canonical, ...ordered.filter((m) => m.id !== canonical.id)];
  const memberRows: WorkMember[] = listed.map((m) => ({
    candidateId: m.id,
    role: m.id === canonical.id ? "canonical" : "copy",
    similarity: m.id === canonical.id ? 1 : overlap(canonSet, sets.get(m.id)!).jaccard,
  }));

  const reasons: string[] = [];
  const isPublished = published.length > 0;
  if (!isPublished) reasons.push("unpublished");
  if (canonical.status === "review") reasons.push("canonical-needs-review");
  if (members.length > 1 && memberRows.some((r) => r.role === "copy" && r.similarity < DIFFERENT_VERSION)) {
    reasons.push("versions-differ");
  }
  return {
    canonicalId: canonical.id,
    title: workTitle(canonical, ordered),
    publishedAt: first?.publishedAt ?? canonical.publishedAt,
    outlet: first?.outlet ?? canonical.outlet,
    column: first?.column ?? canonical.column ?? ordered.find((m) => m.column)?.column ?? null,
    outlets: [...new Set(ordered.map((m) => m.outlet).filter((o): o is string => !!o))],
    isPublished,
    status: isPublished && canonical.status === "keep" ? "keep" : "review",
    reasons,
    members: memberRows,
  };
}

export interface MatchResult {
  works: Work[];
  pairsChecked: number;
  links: number;
}

export function matchCandidates(candidates: MatchCandidate[]): MatchResult {
  const sets = candidates.map((c) => shingles(c.bodyText));
  const pairs = candidatePairs(sets);
  const uf = new UnionFind(candidates.length);
  let links = 0;
  for (const [i, j] of pairs) {
    if (samePiece(overlap(sets[i], sets[j]))) {
      uf.union(i, j);
      links++;
    }
  }
  const groups = new Map<number, MatchCandidate[]>();
  candidates.forEach((c, i) => {
    const root = uf.find(i);
    const g = groups.get(root);
    if (g) g.push(c);
    else groups.set(root, [c]);
  });
  const byId = new Map(candidates.map((c, i) => [c.id, sets[i]]));
  const works = [...groups.values()].map((g) => buildWork(g, byId));
  return { works, pairsChecked: pairs.length, links };
}
