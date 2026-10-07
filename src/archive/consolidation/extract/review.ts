// Read side of step 2: list candidates, show one beside the staged item it
// came from, and render a sample as a before/after page for checking the
// rules by eye before step 3 builds on them.

import { pool, type DB } from "../../../db/client";
import { CANDIDATE_KINDS, CANDIDATE_STATUSES, type CandidateKind, type CandidateStatus } from "./types";

const SOURCES = ["gmail", "gdrive", "wordpress", "substack"] as const;

export interface CandidateFilter {
  source?: (typeof SOURCES)[number];
  kind?: CandidateKind;
  status?: CandidateStatus;
}

export interface ListQuery extends CandidateFilter {
  limit: number;
  offset: number;
}

export interface SampleQuery extends CandidateFilter {
  size: number;
  // Same seed, same sample: re-run extraction with new rules and compare.
  seed: string;
}

type Query = Record<string, unknown>;

function parseFilter(q: Query): CandidateFilter | string {
  const f: Record<string, string> = {};
  const fields: [keyof CandidateFilter, readonly string[]][] = [
    ["source", SOURCES],
    ["kind", CANDIDATE_KINDS],
    ["status", CANDIDATE_STATUSES],
  ];
  for (const [key, allowed] of fields) {
    const v = q[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !allowed.includes(v)) return `${key} must be one of: ${allowed.join(", ")}`;
    f[key] = v;
  }
  return f as CandidateFilter;
}

function intParam(q: Query, key: string, fallback: number, min: number, max: number): number | string {
  const v = q[key];
  if (v === undefined) return fallback;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return `${key} must be an integer from ${min} to ${max}`;
  return n;
}

export function parseListQuery(q: Query): ListQuery | string {
  const f = parseFilter(q);
  if (typeof f === "string") return f;
  const limit = intParam(q, "limit", 50, 1, 200);
  if (typeof limit === "string") return limit;
  const offset = intParam(q, "offset", 0, 0, 1_000_000);
  if (typeof offset === "string") return offset;
  return { ...f, limit, offset };
}

export function parseSampleQuery(q: Query): SampleQuery | string {
  const f = parseFilter(q);
  if (typeof f === "string") return f;
  const size = intParam(q, "sample", 12, 1, 100);
  if (typeof size === "string") return size;
  const seed = q.seed === undefined ? "review" : q.seed;
  if (typeof seed !== "string" || !/^[\w-]{1,40}$/.test(seed)) return "seed must be 1-40 letters, digits, - or _";
  return { ...f, size, seed };
}

function where(f: CandidateFilter, params: unknown[]): string {
  const conds: string[] = [];
  for (const key of ["source", "kind", "status"] as const) {
    if (f[key] === undefined) continue;
    params.push(f[key]);
    conds.push(`c.${key} = $${params.length}`);
  }
  return conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
}

const SUMMARY_COLUMNS = `c.id, c.source, c.kind, c.status, c.reasons, c.title, c.outlet, c.column_name,
  c.published_at, c.date_source, c.is_published, c.char_count, c.note, s.source_ref`;

export async function listCandidates(
  q: ListQuery,
  db: DB = pool
): Promise<{ total: number; candidates: Record<string, unknown>[] }> {
  const params: unknown[] = [];
  const cond = where(q, params);
  const { rows: count } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM archive_candidate c ${cond}`,
    params
  );
  const { rows } = await db.query(
    `SELECT ${SUMMARY_COLUMNS}, left(c.body_text, 200) AS snippet
       FROM archive_candidate c JOIN archive_source_item s ON s.id = c.source_item_id
       ${cond}
      ORDER BY c.published_at DESC NULLS LAST, c.id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.limit, q.offset]
  );
  return { total: count[0].n, candidates: rows };
}

export interface CandidateDetail {
  candidate: Record<string, unknown>;
  // The staged item it was extracted from: the "before".
  source: {
    id: string;
    source: string;
    sourceRef: string;
    containerRef: string | null;
    title: string | null;
    authoredAt: Date | null;
    rawText: string | null;
    rawHtml: string | null;
    metadata: Record<string, unknown>;
  };
}

interface DetailRow extends Record<string, unknown> {
  source_item_id: string;
  source_ref: string;
  container_ref: string | null;
  source_title: string | null;
  authored_at: Date | null;
  raw_text: string | null;
  raw_html: string | null;
  metadata: Record<string, unknown>;
}

const DETAIL_SELECT = `SELECT c.*, s.source_ref, s.container_ref, s.title AS source_title, s.authored_at,
         s.raw_text, s.raw_html, s.metadata
    FROM archive_candidate c JOIN archive_source_item s ON s.id = c.source_item_id`;

function toDetail(r: DetailRow): CandidateDetail {
  const { source_ref, container_ref, source_title, authored_at, raw_text, raw_html, metadata, ...candidate } = r;
  return {
    candidate,
    source: {
      id: r.source_item_id,
      source: String(r.source),
      sourceRef: source_ref,
      containerRef: container_ref,
      title: source_title,
      authoredAt: authored_at,
      rawText: raw_text,
      rawHtml: raw_html,
      metadata: metadata ?? {},
    },
  };
}

export async function getCandidate(id: string, db: DB = pool): Promise<CandidateDetail | null> {
  const { rows } = await db.query<DetailRow>(`${DETAIL_SELECT} WHERE c.id = $1`, [id]);
  return rows.length > 0 ? toDetail(rows[0]) : null;
}

// Where the rules do the most work comes first, so a small sample shows
// the Gmail decisions before the near-mechanical export conversions.
const REVIEW_ORDER: CandidateKind[] = [
  "submission",
  "newsletter",
  "self_draft",
  "reply",
  "attachment",
  "post",
  "doc",
  "received",
  "forward",
  "page",
  "platform_copy",
  "draft",
  "empty",
  "duplicate",
];

// One candidate from each (source, kind) group in REVIEW_ORDER, then a
// second from each, and so on, until `size`. Deterministic for a seed.
export async function sampleCandidates(q: SampleQuery, db: DB = pool): Promise<CandidateDetail[]> {
  const params: unknown[] = [q.seed];
  const cond = where(q, params);
  params.push(REVIEW_ORDER, q.size);
  const { rows } = await db.query<DetailRow>(
    `WITH ranked AS (
       SELECT c.id, row_number() OVER (PARTITION BY c.source, c.kind ORDER BY md5(c.id::text || $1)) AS rn
         FROM archive_candidate c ${cond}
     )
     ${DETAIL_SELECT}
       JOIN ranked r ON r.id = c.id
      ORDER BY r.rn, array_position($${params.length - 1}::text[], c.kind), c.source
      LIMIT $${params.length}`,
    params
  );
  return rows.map(toDetail);
}

const MAX_SHOWN = 6000;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shown(text: string | null): string {
  if (!text) return '<span class="none">(none)</span>';
  if (text.length <= MAX_SHOWN) return esc(text);
  return `${esc(text.slice(0, MAX_SHOWN))}<span class="none">\n… ${text.length - MAX_SHOWN} more characters</span>`;
}

function day(d: unknown): string {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "no date";
}

function card(d: CandidateDetail, n: number): string {
  const c = d.candidate;
  const reasons = (c.reasons as string[] | null) ?? [];
  const before = d.source.rawText ?? d.source.rawHtml;
  const beforeLabel = d.source.rawText !== null ? "staged text" : "staged HTML";
  const meta = [
    c.outlet && esc(String(c.outlet)),
    c.column_name
      ? esc(String(c.column_name))
      : (c.kind === "submission" || c.kind === "attachment") && "other (no known column)",
    `${day(c.published_at)}${c.date_source ? ` (${esc(String(c.date_source))})` : ""}`,
    `${c.char_count} chars`,
  ].filter(Boolean);
  return `<section class="card">
  <header>
    <div class="tags"><span class="n">#${n}</span><span class="tag ${esc(String(c.status))}">${esc(String(c.status))}</span><span class="tag">${esc(String(c.kind))}</span><span class="tag">${esc(d.source.source)}</span>${reasons.map((r) => `<span class="reason">${esc(r)}</span>`).join("")}</div>
    <h2>${esc(String(c.title ?? d.source.title ?? "(untitled)"))}</h2>
    <p class="meta">${meta.join(" · ")}</p>
    <p class="ids">candidate ${esc(String(c.id))} · ${esc(d.source.source)}:${esc(d.source.sourceRef)}</p>
  </header>
  <div class="cols">
    <div><h3>Before: ${beforeLabel}</h3><pre>${shown(before)}</pre></div>
    <div><h3>After: essay text</h3>${c.note ? `<div class="note"><strong>Removed note</strong><pre>${shown(String(c.note))}</pre></div>` : ""}<pre>${shown(c.body_text as string | null)}</pre></div>
  </div>
</section>`;
}

export function renderReviewPage(items: CandidateDetail[], q: SampleQuery): string {
  const filters = (["source", "kind", "status"] as const)
    .filter((k) => q[k] !== undefined)
    .map((k) => `${k}=${esc(String(q[k]))}`);
  const subtitle = [`${items.length} candidates`, `seed ${esc(q.seed)}`, ...filters].join(" · ");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Extraction review</title>
<style>
:root { --bg: #fafaf8; --fg: #1d1d1b; --muted: #6b6b66; --card: #fff; --line: #e2e1dc; --pre: #f3f2ee;
  --keep: #1f7a3a; --review: #9a6200; --drop: #a8322d; --note: #fff6dd; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #a09f99; --card: #1f1f1d;
  --line: #34332f; --pre: #262623; --keep: #5cc27a; --review: #e0a640; --drop: #ef7b74; --note: #3a3220; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
main { max-width: 1280px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 24px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.n { font-weight: 700; margin-right: 4px; }
.tag, .reason { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.reason { color: var(--muted); }
.tag.keep { color: var(--keep); border-color: var(--keep); }
.tag.review { color: var(--review); border-color: var(--review); }
.tag.drop { color: var(--drop); border-color: var(--drop); }
h2 { font-size: 18px; margin: 10px 0 2px; }
.meta, .ids { margin: 0; color: var(--muted); font-size: 13px; }
.ids { font-family: ui-monospace, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
@media (max-width: 820px) { .cols { grid-template-columns: 1fr; } }
.cols > div { min-width: 0; }
h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 6px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--pre); border-radius: 6px; padding: 10px;
  margin: 0; max-height: 480px; overflow: auto; font: inherit; font-size: 14px; }
.note { background: var(--note); border-radius: 6px; padding: 8px; margin-bottom: 8px; font-size: 13px; }
.note pre { background: transparent; padding: 4px 0 0; max-height: 160px; }
.none { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<main>
<h1>Extraction review</h1>
<p class="sub">${subtitle}</p>
${items.length === 0 ? '<p class="none">No candidates yet: run extraction first.</p>' : items.map((d, i) => card(d, i + 1)).join("\n")}
</main>
</body>
</html>
`;
}
