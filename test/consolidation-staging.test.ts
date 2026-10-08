// DB-backed test for archive staging (upsert semantics + run tracking).
// Gated on TEST_DATABASE_URL: a local *_test database with migrations
// applied (CI's mcp-worker setup migrates it). No Google traffic.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;

let db: Pool;
let staging: typeof import("../src/archive/consolidation/staging");
let gmail: typeof import("../src/archive/consolidation/gmail");
let appPool: import("pg").Pool | undefined;

before(async () => {
  if (!url) return;
  db = new Pool({ connectionString: url, max: 2 });
  const { rows } = await db.query("SELECT current_database() AS db, host(inet_server_addr()) AS addr");
  const addr: string | null = rows[0].addr;
  const local =
    addr === null ||
    /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr) ||
    addr === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(addr);
  if (!String(rows[0].db).endsWith("_test") || !local) {
    await db.end();
    throw new Error(`Refusing to run against ${rows[0].db}@${addr}: needs a local *_test database`);
  }
  // The collectors write through the app's shared pool, which reads
  // DATABASE_URL when first imported: point it at the checked database.
  process.env.DATABASE_URL = url;
  staging = await import("../src/archive/consolidation/staging");
  gmail = await import("../src/archive/consolidation/gmail");
  appPool = (await import("../src/db/client")).pool;
});

after(async () => {
  await appPool?.end();
  await db?.end();
});

beforeEach(async () => {
  if (!url) return;
  await db.query("TRUNCATE archive_source_item, archive_collect_run CASCADE");
});

const item = (over: Record<string, unknown> = {}) => ({
  source: "gmail" as const,
  sourceRef: "msg-1",
  containerRef: "thread-1",
  title: "利字當頭：科目三",
  authoredAt: new Date("2024-02-19T18:37:39Z"),
  rawText: "幾個星期前，港聲你聽的例會上……",
  rawHtml: null,
  metadata: { isSent: true },
  ...over,
});

test("upsert inserts, then reports unchanged, then updated on a content change", { skip }, async () => {
  assert.equal(await staging.upsertSourceItem(item(), db), "inserted");
  const before = await db.query("SELECT fetched_at FROM archive_source_item");
  assert.equal(await staging.upsertSourceItem(item(), db), "unchanged");
  const same = await db.query("SELECT fetched_at FROM archive_source_item");
  assert.deepEqual(same.rows[0].fetched_at, before.rows[0].fetched_at);

  assert.equal(await staging.upsertSourceItem(item({ rawText: "稍為修正了內容" }), db), "updated");
  assert.equal(await staging.upsertSourceItem(item({ rawText: "稍為修正了內容", metadata: { isSent: false } }), db), "updated");
  const { rows } = await db.query("SELECT raw_text, metadata, content_hash FROM archive_source_item");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_text, "稍為修正了內容");
  assert.deepEqual(rows[0].metadata, { isSent: false });
  assert.equal(rows[0].content_hash, staging.contentHash("稍為修正了內容", null));
});

test("upsert strips NUL bytes and rejects items with no body", { skip }, async () => {
  assert.equal(await staging.upsertSourceItem(item({ rawText: "a\u0000b", title: "t\u0000" }), db), "inserted");
  const { rows } = await db.query("SELECT raw_text, title FROM archive_source_item");
  assert.deepEqual(rows[0], { raw_text: "ab", title: "t" });
  await assert.rejects(staging.upsertSourceItem(item({ sourceRef: "x", rawText: null, rawHtml: null }), db), /no body/);
});

test("existingSourceRefs only reports refs of the given source", { skip }, async () => {
  await staging.upsertSourceItem(item(), db);
  await staging.upsertSourceItem(item({ source: "gdrive", sourceRef: "msg-2" }), db);
  const got = await staging.existingSourceRefs("gmail", ["msg-1", "msg-2", "msg-3"], db);
  assert.deepEqual([...got], ["msg-1"]);
});

test("auditPublicArtifacts flags email-contaminated, truncated and duplicate rows", { skip }, async () => {
  const { auditPublicArtifacts } = await import("../src/archive/consolidation/audit");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Seed inside a transaction that is rolled back: leaves no rows behind.
    await client.query(
      `INSERT INTO public_artifact (user_id, type, title, raw_source, source_system, processing_status) VALUES
         ('default', 'essay', '利字當頭 A', repeat('字', 2000), 'audit-test', 'processed'),
         ('default', 'essay', '利字當頭 a ', E'Hello Simon,\\n收到\\nKhaki 於 2024年2月19日 寫道：\\n正文', 'audit-test', 'error')`
    );
    const audit = (await auditPublicArtifacts(client)) as Record<string, any>;
    const buckets = (audit.length_buckets as any[]).find((b) => b.source_system === "audit-test");
    assert.equal(buckets.eq2000, 1);
    assert.ok(Number(audit.email_marker_rows) >= 1);
    assert.ok(Number(audit.dup_titles.groups) >= 1);
    assert.ok((audit.errors as any[]).some((e) => e.processing_status === "error"));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("one running run per source; stale runs are reclaimed", { skip }, async () => {
  const a = await staging.startRun("gmail", { label: "Writing" }, db);
  await assert.rejects(staging.startRun("gmail", {}, db), staging.RunAlreadyActiveError);
  // A different source can run alongside.
  const d = await staging.startRun("gdrive", { folderIds: ["x"] }, db);

  await staging.heartbeatRun(a, { listed: 10 }, db);
  await db.query(`UPDATE archive_collect_run SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [a]);
  const b = await staging.startRun("gmail", {}, db);
  assert.notEqual(a, b);
  const { rows } = await db.query("SELECT status, error, stats FROM archive_collect_run WHERE id = $1", [a]);
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error, /abandoned/);
  assert.deepEqual(rows[0].stats, { listed: 10 });

  await staging.finishRun(b, "succeeded", { inserted: 3 }, null, db);
  await staging.finishRun(d, "failed", {}, "boom", db);
  const status = await staging.getStagingStatus(db);
  assert.equal(status.runs.length, 3);
  // Finished runs free the slot.
  await staging.startRun("gmail", {}, db);
});

test("incompleteGmailMessages finds staged messages missing an expected attachment row", { skip }, async () => {
  await staging.upsertSourceItem(item({ sourceRef: "m-done", metadata: { expectedAttachmentRefs: ["m-done#1"] } }), db);
  await staging.upsertSourceItem(item({ sourceRef: "m-done#1", metadata: { kind: "attachment" } }), db);
  await staging.upsertSourceItem(item({ sourceRef: "m-partial", metadata: { expectedAttachmentRefs: ["m-partial#1", "m-partial#2"] } }), db);
  await staging.upsertSourceItem(item({ sourceRef: "m-partial#1", metadata: { kind: "attachment" } }), db);
  await staging.upsertSourceItem(item({ sourceRef: "m-none", metadata: { expectedAttachmentRefs: [] } }), db);
  await staging.upsertSourceItem(item({ sourceRef: "m-old", metadata: {} }), db);
  // The same ref under another source doesn't count as the attachment.
  await staging.upsertSourceItem(item({ sourceRef: "m-other", metadata: { expectedAttachmentRefs: ["m-other#1"] } }), db);
  await staging.upsertSourceItem(item({ source: "gdrive", sourceRef: "m-other#1" }), db);

  const got = await staging.incompleteGmailMessages(["m-done", "m-partial", "m-none", "m-old", "m-other", "m-unstaged"], db);
  assert.deepEqual([...got].sort(), ["m-other", "m-partial"]);
  assert.deepEqual([...(await staging.incompleteGmailMessages(["m-done"], db))], []);
  assert.deepEqual([...(await staging.incompleteGmailMessages([], db))], []);
});

// A users.messages.get + attachments.get stand-in; attachment values that
// are Errors are thrown, so a test can fail one fetch and then retry it.
function stubGmail(msg: Record<string, unknown>, attachments: Record<string, string | Error>) {
  return {
    users: {
      messages: {
        get: async () => ({ data: msg }),
        attachments: {
          get: async ({ id }: { id: string }) => {
            const v = attachments[id];
            if (v instanceof Error) throw v;
            return { data: { data: v } };
          },
        },
      },
    },
  } as unknown as import("../src/archive/consolidation/gmail").Gmail;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

test("collectMessage fetches out-of-line bodies and retries a failed attachment", { skip }, async () => {
  const big5 = Buffer.from([0xa7, 0x51, 0xa5, 0x40, 0xa5, 0xc1]); // 利世民
  const msg = {
    id: "m-long",
    threadId: "t-long",
    internalDate: String(Date.parse("2019-07-30T04:00:00Z")),
    labelIds: ["SENT", "Label_1"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "利字當頭 20190730" }],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              partId: "0.0",
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: "text/plain; charset=big5" }],
              body: { attachmentId: "BODY_TEXT", size: 6 },
            },
            {
              partId: "0.1",
              mimeType: "text/html",
              headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
              body: { data: b64("<p>利世民</p>") },
            },
          ],
        },
        {
          partId: "1",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          filename: "利字當頭 20190730.docx",
          body: { attachmentId: "DOCX", size: 986 },
        },
      ],
    },
  };
  const docx = b64(readFileSync(join(__dirname, "fixtures", "column-sample.docx")));
  const labels = new Map([["Label_1", "Writing"]]);

  // First run: the body is fetched, the attachment fetch fails.
  const first = gmail.emptyStats();
  await gmail.collectMessage(
    stubGmail(msg, { BODY_TEXT: b64(big5), DOCX: new Error("backend error") }),
    "m-long",
    labels,
    first
  );
  assert.equal(first.inserted, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.errors[0].ref, "m-long#1");
  const { rows } = await db.query(
    "SELECT raw_text, raw_html, metadata FROM archive_source_item WHERE source = 'gmail' AND source_ref = 'm-long'"
  );
  assert.equal(rows[0].raw_text, "利世民");
  assert.equal(rows[0].raw_html, "<p>利世民</p>");
  assert.deepEqual(rows[0].metadata.expectedAttachmentRefs, ["m-long#1"]);
  assert.deepEqual(rows[0].metadata.externalBodies, ["text/plain"]);
  assert.equal(rows[0].metadata.emptyBody, undefined);
  assert.deepEqual([...(await staging.incompleteGmailMessages(["m-long"], db))], ["m-long"]);

  // Retry: the message is unchanged, the attachment is now staged.
  const second = gmail.emptyStats();
  await gmail.collectMessage(stubGmail(msg, { BODY_TEXT: b64(big5), DOCX: docx }), "m-long", labels, second);
  assert.equal(second.failed, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.attachmentsExtracted, 1);
  const att = await db.query(
    "SELECT raw_text, metadata FROM archive_source_item WHERE source = 'gmail' AND source_ref = 'm-long#1'"
  );
  assert.match(att.rows[0].raw_text, /利字當頭：科目三/);
  assert.equal(att.rows[0].metadata.parentMessageId, "m-long");
  assert.deepEqual([...(await staging.incompleteGmailMessages(["m-long"], db))], []);
});

test("collectMessage stages nothing when an out-of-line body can't be fetched", { skip }, async () => {
  const msg = {
    id: "m-big",
    threadId: "t-big",
    payload: { mimeType: "text/html", body: { attachmentId: "BODY_HTML", size: 300000 } },
  };
  const stats = gmail.emptyStats();
  await assert.rejects(
    gmail.collectMessage(stubGmail(msg, { BODY_HTML: new Error("rate limited") }), "m-big", new Map(), stats),
    /rate limited/
  );
  // No row: the next run sees the message as new and fetches it again.
  assert.deepEqual([...(await staging.existingSourceRefs("gmail", ["m-big"], db))], []);
});

test("collectMessage retries a quota error instead of failing the message", { skip }, async () => {
  const { RateLimiter } = await import("../src/archive/consolidation/ratelimit");
  const stats = gmail.emptyStats();
  const limiter = new RateLimiter({
    minIntervalMs: 0,
    maxIntervalMs: 1,
    retries: 3,
    basePauseMs: 1,
    maxPauseMs: 5,
    onLimited: () => {
      stats.rateLimitPauses += 1;
    },
  });
  const msg = { id: "m-quota", threadId: "t-quota", payload: { mimeType: "text/plain", body: { data: b64("正文") } } };
  let calls = 0;
  const flaky = stubGmail(msg, {});
  const realGet = flaky.users.messages.get;
  (flaky.users.messages as any).get = async (...args: unknown[]) => {
    if (++calls === 1) {
      throw Object.assign(new Error("Quota exceeded for quota metric 'Total Query Cost'"), { code: 403, response: { status: 403 } });
    }
    return (realGet as any)(...args);
  };
  await gmail.collectMessage(flaky, "m-quota", new Map(), stats, limiter);
  assert.equal(calls, 2);
  assert.equal(stats.failed, 0);
  assert.equal(stats.inserted, 1);
  assert.equal(stats.rateLimitPauses, 1);
});

test("heartbeat and finish leave alone a run that is no longer running", { skip }, async () => {
  const id = await staging.startRun("gmail", { label: "Writing" }, db);
  assert.equal(await staging.heartbeatRun(id, { inserted: 1 }, db), true);
  await db.query(`UPDATE archive_collect_run SET status = 'failed', error = 'interrupted: test' WHERE id = $1`, [id]);
  assert.equal(await staging.heartbeatRun(id, { inserted: 2 }, db), false);
  await staging.finishRun(id, "succeeded", { inserted: 3 }, null, db);
  const { rows } = await db.query("SELECT status, error, stats FROM archive_collect_run WHERE id = $1", [id]);
  assert.deepEqual(rows[0], { status: "failed", error: "interrupted: test", stats: { inserted: 1 } });
});

test("claimInterruptedRuns takes only silent runs, each exactly once", { skip }, async () => {
  const silent = await staging.startRun("gmail", { label: "Writing" }, db);
  const live = await staging.startRun("gdrive", { folderIds: ["1-t93X29Zx94KBa0E2WxM7Izu4S8CLOvl"] }, db);
  await db.query(
    `UPDATE archive_collect_run SET heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1`,
    [silent, staging.STALE_RUN_SECONDS + 5]
  );
  const [first, second] = await Promise.all([staging.claimInterruptedRuns(db), staging.claimInterruptedRuns(db)]);
  const claimed = [...first, ...second];
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, silent);
  assert.equal(claimed[0].source, "gmail");
  assert.deepEqual(claimed[0].params, { label: "Writing" });
  const { rows } = await db.query("SELECT id, status, error FROM archive_collect_run ORDER BY started_at");
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[silent].status, "failed");
  assert.match(byId[silent].error, /^interrupted/);
  assert.equal(byId[live].status, "running");
});

test("resumeInterruptedRuns starts the continuation of an interrupted run", { skip }, async () => {
  const { resumeInterruptedRuns } = await import("../src/archive/consolidation/resume");
  const old = await staging.startRun("gmail", { label: "Writing", refetch: true }, db);
  const tooOften = await staging.startRun(
    "gdrive",
    { folderIds: ["1-t93X29Zx94KBa0E2WxM7Izu4S8CLOvl"], resumeCount: 3 },
    db
  );
  await db.query(`UPDATE archive_collect_run SET heartbeat_at = now() - interval '10 minutes'`);
  const requests: unknown[] = [];
  const started = await resumeInterruptedRuns(
    async (req) => {
      requests.push(req);
      // Stand in for startCollection: record the new run the way it does.
      const { source, ...params } = req;
      return staging.startRun(source, params, db);
    },
    () => staging.claimInterruptedRuns(db)
  );
  assert.deepEqual(requests, [{ source: "gmail", label: "Writing", refetch: false, resumedFrom: old, resumeCount: 1 }]);
  assert.equal(started.length, 1);
  const { rows } = await db.query("SELECT id, source, status, params FROM archive_collect_run");
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[old].status, "failed");
  assert.equal(byId[tooOften].status, "failed");
  assert.equal(byId[started[0]].status, "running");
  assert.equal(byId[started[0]].params.resumedFrom, old);
  // Nothing left to resume.
  assert.deepEqual(await resumeInterruptedRuns(async () => "x", () => staging.claimInterruptedRuns(db)), []);
});

// Step 2 (extract) against the database. Here rather than in its own file:
// test files run in parallel and both use archive_source_item.
const ESSAY = [1, 2, 3, 4].map((n) => `第${n}段：${"香港經濟的問題不在於短期的周期，而在於制度的信任。".repeat(4)}`).join("\n\n");

async function stageForExtraction(): Promise<void> {
  await staging.upsertSourceItem(
    item({
      sourceRef: "sub",
      title: "Apple Daily Forum 20200624",
      authoredAt: new Date("2020-06-22T09:00:00Z"),
      rawText: `蘋果論壇：自由市場的代價\n\n${ESSAY}`,
      metadata: { kind: "message", from: "simoncf@gmail.com", to: ["forum@appledaily.com"], isSent: true },
    }),
    db
  );
  // One newsletter issue, received at two addresses.
  for (const [ref, at] of [["nl-b", "2021-03-01T01:00:05Z"], ["nl-a", "2021-03-01T01:00:00Z"]]) {
    await staging.upsertSourceItem(
      item({
        sourceRef: ref,
        title: "通脹的真相",
        authoredAt: new Date(at),
        rawText: `View online →\n\n通脹的真相\n\n${ESSAY}\n\nUnsubscribe`,
        metadata: { kind: "message", from: "newsletter@unsubject.me", to: ["simoncf@gmail.com"], isSent: false },
      }),
      db
    );
  }
  await staging.upsertSourceItem(
    item({ sourceRef: "ack", title: "Re: 稿件", rawText: "收到", metadata: { from: "jane@appledaily.com", isSent: false } }),
    db
  );
  await staging.upsertSourceItem(
    item({
      source: "wordpress",
      sourceRef: "leesimon.me:42",
      title: "利字當頭：科目三",
      rawText: null,
      rawHtml: ESSAY,
      metadata: { status: "publish", postType: "post", site: "https://leesimon.me" },
    }),
    db
  );
}

test("runExtraction writes one candidate per item and keeps one copy of each newsletter issue", { skip }, async () => {
  const run = await import("../src/archive/consolidation/extract/run");
  await stageForExtraction();

  const stopped = run.emptyExtractStats();
  await run.runExtraction(stopped, async () => {}, () => true, db);
  assert.equal(stopped.written, 0);

  const stats = run.emptyExtractStats();
  let progress = 0;
  await run.runExtraction(stats, async () => void progress++, () => false, db);
  assert.equal(progress, 1);
  assert.deepEqual(
    { listed: stats.listed, scanned: stats.scanned, inserted: stats.inserted, duplicates: stats.duplicates, failed: stats.failed },
    { listed: 5, scanned: 5, inserted: 5, duplicates: 1, failed: 0 }
  );
  assert.deepEqual(stats.byKind, { submission: 1, newsletter: 1, duplicate: 1, received: 1, post: 1 });
  assert.deepEqual(stats.byStatus, { keep: 3, drop: 2 });

  const rows = async () =>
    Object.fromEntries(
      (
        await db.query(
          `SELECT s.source_ref, c.id, c.kind, c.status, c.reasons, c.title, c.outlet, c.extractor_version
             FROM archive_candidate c JOIN archive_source_item s ON s.id = c.source_item_id`
        )
      ).rows.map((r) => [r.source_ref, r])
    );
  const first = await rows();
  assert.equal(first["sub"].kind, "submission");
  assert.equal(first["sub"].title, "自由市場的代價");
  assert.equal(first["sub"].outlet, "蘋果日報");
  assert.equal(first["nl-a"].kind, "newsletter");
  assert.equal(first["nl-b"].kind, "duplicate");
  assert.equal(first["nl-b"].status, "drop");
  assert.deepEqual(first["nl-b"].reasons, [`duplicate-of:${first["nl-a"].id}`]);

  // A second run rewrites in place; the duplicate mark doesn't pile up.
  const again = run.emptyExtractStats();
  await run.runExtraction(again, async () => {}, () => false, db);
  assert.deepEqual([again.inserted, again.updated, again.duplicates], [0, 5, 1]);
  const second = await rows();
  assert.equal(Object.keys(second).length, 5);
  assert.equal(second["nl-b"].id, first["nl-b"].id);
  assert.deepEqual(second["nl-b"].reasons, [`duplicate-of:${first["nl-a"].id}`]);

  const summary = await run.candidateSummary(db);
  assert.ok(summary.some((r) => r.source === "gmail" && r.kind === "duplicate" && r.status === "drop" && r.n === 1));
});

test("candidate list, detail and review sample", { skip }, async () => {
  const run = await import("../src/archive/consolidation/extract/run");
  const review = await import("../src/archive/consolidation/extract/review");
  await stageForExtraction();
  await run.runExtraction(run.emptyExtractStats(), async () => {}, () => false, db);

  const list = await review.listCandidates({ source: "gmail", status: "keep", limit: 10, offset: 0 }, db);
  assert.equal(list.total, 2);
  assert.deepEqual(list.candidates.map((c) => c.kind).sort(), ["newsletter", "submission"]);
  assert.ok(String(list.candidates[0].snippet).startsWith("第1段"));
  const page = await review.listCandidates({ limit: 2, offset: 4 }, db);
  assert.equal(page.total, 5);
  assert.equal(page.candidates.length, 1);

  const sub = list.candidates.find((c) => c.kind === "submission")!;
  const detail = await review.getCandidate(String(sub.id), db);
  assert.equal(detail?.candidate.body_text, ESSAY);
  assert.equal(detail?.source.sourceRef, "sub");
  assert.ok(detail?.source.rawText?.startsWith("蘋果論壇：自由市場的代價"));
  assert.equal(await review.getCandidate("00000000-0000-0000-0000-000000000000", db), null);

  // One per (source, kind), in review order: Gmail submissions first.
  const sample = await review.sampleCandidates({ size: 3, seed: "x" }, db);
  assert.deepEqual(
    sample.map((d) => d.candidate.kind),
    ["submission", "newsletter", "post"]
  );
  const onlyDrops = await review.sampleCandidates({ status: "drop", size: 10, seed: "x" }, db);
  assert.deepEqual(onlyDrops.map((d) => d.candidate.kind).sort(), ["duplicate", "received"]);
  assert.ok(review.renderReviewPage(sample, { size: 3, seed: "x" }).includes("自由市場的代價"));
});

test("an extraction run is tracked like a collection run", { skip }, async () => {
  const { startCollection } = await import("../src/archive/consolidation/runner");
  await stageForExtraction();
  const runId = await startCollection({ source: "extract" });
  await assert.rejects(startCollection({ source: "extract" }), staging.RunAlreadyActiveError);
  let row: { status: string; stats: Record<string, unknown> } | undefined;
  for (let i = 0; i < 100; i++) {
    row = (await db.query("SELECT status, stats FROM archive_collect_run WHERE id = $1", [runId])).rows[0];
    if (row?.status !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(row?.status, "succeeded");
  assert.equal(row?.stats.written, 5);
  assert.equal(row?.stats.duplicates, 1);

  // A successful extraction starts matching by itself.
  let matchRow: { status: string; stats: Record<string, unknown> } | undefined;
  for (let i = 0; i < 100; i++) {
    matchRow = (await db.query("SELECT status, stats FROM archive_collect_run WHERE source = 'match'")).rows[0];
    if (matchRow && matchRow.status !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(matchRow?.status, "succeeded");
  assert.equal(matchRow?.stats.works, 1);

  // And a successful match starts loading.
  let loadRow: { status: string; stats: Record<string, unknown> } | undefined;
  for (let i = 0; i < 100; i++) {
    loadRow = (await db.query("SELECT status, stats FROM archive_collect_run WHERE source = 'load'")).rows[0];
    if (loadRow && loadRow.status !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(loadRow?.status, "succeeded");
  assert.equal(loadRow?.stats.works, 1);
});

test("catch-up: extract when candidates are stale, then match when works are", { skip }, async () => {
  const run = await import("../src/archive/consolidation/extract/run");
  const match = await import("../src/archive/consolidation/match/run");
  const auto = await import("../src/archive/consolidation/extract/auto");
  const stale = { candidates: () => auto.candidatesStale(db), works: () => auto.worksStale(db) };
  const started: unknown[] = [];
  const fakeStart = async (req: unknown) => {
    started.push(req);
    return `run-${started.length}`;
  };

  assert.equal(await auto.catchUp(fakeStart, stale), null); // nothing staged
  await stageForExtraction();
  assert.deepEqual(await auto.catchUp(fakeStart, stale), { source: "extract", runId: "run-1" });

  await run.runExtraction(run.emptyExtractStats(), async () => {}, () => false, db);
  assert.equal(await auto.candidatesStale(db), false);
  assert.equal(await auto.worksStale(db), true);
  assert.deepEqual(await auto.catchUp(fakeStart, stale), { source: "match", runId: "run-2" });

  await match.runMatch(match.emptyMatchStats(), async () => {}, () => false, db);
  assert.equal(await auto.worksStale(db), false);
  assert.equal(await auto.catchUp(fakeStart, stale), null);

  // New rules: an older extractor version, or an older matcher version.
  await db.query("UPDATE archive_work SET matcher_version = matcher_version - 1");
  assert.equal(await auto.worksStale(db), true);
  await db.query("UPDATE archive_candidate SET extractor_version = extractor_version - 1 WHERE id IN (SELECT id FROM archive_candidate LIMIT 1)");
  assert.deepEqual((await auto.catchUp(fakeStart, stale))?.source, "extract");

  // A run already going is left alone.
  const busy = async () => {
    throw new staging.RunAlreadyActiveError("extract");
  };
  assert.equal(await auto.catchUp(busy, stale), null);
});

test("runMatch groups the copies of one piece into a work with the emailed text as canonical", { skip }, async () => {
  const run = await import("../src/archive/consolidation/extract/run");
  const match = await import("../src/archive/consolidation/match/run");
  await stageForExtraction();
  // The same column reposted on Substack two days later, with a new opening line.
  await staging.upsertSourceItem(
    item({
      source: "substack",
      sourceRef: "post-9",
      title: "自由市場的代價",
      authoredAt: new Date("2020-06-26T00:00:00Z"),
      rawText: null,
      rawHtml: `<p>舊文重溫。</p>${ESSAY.split("\n\n").map((p) => `<p>${p}</p>`).join("")}`,
      metadata: { isPublished: true, audience: "everyone" },
    }),
    db
  );
  await run.runExtraction(run.emptyExtractStats(), async () => {}, () => false, db);
  const stats = match.emptyMatchStats();
  await match.runMatch(stats, async () => {}, () => false, db);

  // Kept or in review: the submission, the newsletter, the WordPress post and
  // the Substack post; the newsletter and both posts share ESSAY's text.
  assert.equal(stats.candidates, 4);
  assert.equal(stats.works, 1);
  assert.deepEqual(stats.bySize, { "3-5": 1 });
  assert.deepEqual(stats.largest, [{ members: 4, title: "自由市場的代價" }]);
  const { rows: works } = await db.query(
    `SELECT w.title, w.published_at, w.outlet, w.outlets, w.status, w.member_count, s.source_ref AS canonical
       FROM archive_work w JOIN archive_candidate c ON c.id = w.canonical_candidate_id
       JOIN archive_source_item s ON s.id = c.source_item_id`
  );
  assert.equal(works.length, 1);
  assert.equal(works[0].canonical, "sub"); // the column as emailed to Apple Daily
  assert.equal(works[0].member_count, 4);
  assert.equal(works[0].title, "自由市場的代價");
  assert.equal(works[0].outlet, "蘋果日報");
  assert.equal(works[0].published_at.toISOString().slice(0, 10), "2020-06-24"); // first publication
  assert.equal(works[0].outlets[0], "蘋果日報");
  assert.equal(works[0].status, "keep");

  // A second run rebuilds rather than adds.
  await match.runMatch(match.emptyMatchStats(), async () => {}, () => false, db);
  const { rows: count } = await db.query("SELECT count(*)::int AS n FROM archive_work_member");
  assert.equal(count[0].n, 4);

  const review = await import("../src/archive/consolidation/match/review");
  const list = await review.listWorks({ limit: 10, offset: 0 }, db);
  assert.equal(list.total, 1);
  assert.equal((await review.listWorks({ status: "review", limit: 10, offset: 0 }, db)).total, 0);
  const work = (await review.getWork(String(list.works[0].id), db)) as { members: { role: string; source: string }[] };
  assert.deepEqual(work.members.map((m) => m.role), ["canonical", "copy", "copy", "copy"]);
  assert.equal(work.members[0].source, "gmail");
  assert.equal(await review.getWork("00000000-0000-0000-0000-000000000000", db), null);
  assert.equal((await match.workSummary(db))[0].works, 1);
});

const OTHER = [1, 2, 3].map((n) => `第${n}節：${"市場不是完美的，但政府更不完美，所以要限制權力。".repeat(5)}`).join("\n\n");

// Stage, extract and match: one published column in three copies, and one
// Drive draft never published (a work to review).
async function buildWorks(): Promise<void> {
  const run = await import("../src/archive/consolidation/extract/run");
  const match = await import("../src/archive/consolidation/match/run");
  await stageForExtraction();
  await db.query(
    `UPDATE archive_source_item SET metadata = metadata || '{"link": "https://leesimon.me/2020/06/kemu"}'
      WHERE source = 'wordpress'`
  );
  await staging.upsertSourceItem(
    item({ source: "gdrive", sourceRef: "doc-1", title: "政府失靈", rawText: OTHER, rawHtml: null, metadata: { path: "Article Archive" } }),
    db
  );
  await run.runExtraction(run.emptyExtractStats(), async () => {}, () => false, db);
  await match.runMatch(match.emptyMatchStats(), async () => {}, () => false, db);
}

test("runLoad writes one row per work and points the first import's copies at it", { skip }, async () => {
  const load = await import("../src/archive/consolidation/load/run");
  await db.query("DELETE FROM public_artifact");
  await buildWorks();
  // The first import: the column as mailed (with a note to the editor), an
  // unrelated piece, the draft with a link; and a video transcript.
  await db.query(
    `INSERT INTO public_artifact (user_id, type, title, raw_source, source_system, source_external_id, processing_status, canonical_url) VALUES
       ('default', 'essay', '自由市場的代價', $1, 'notion', 'n1', 'processed', NULL),
       ('default', 'essay', '無關', $2, 'notion', 'n2', 'processed', NULL),
       ('default', 'essay', '政府失靈', $3, 'notion', 'n3', 'processed', 'https://example.org/old'),
       ('default', 'transcript', '影片', $4, 'youtube', 'y1', 'processed', NULL)`,
    [
      `老總：附上今期稿件。\n\n${ESSAY}`,
      "今天天氣很好，我們一家人去公園散步，看見很多小朋友在玩耍。".repeat(6),
      OTHER,
      `影片逐字稿：${ESSAY}`,
    ]
  );

  const stats = load.emptyLoadStats();
  await load.runLoad(stats, async () => {}, () => false, db);
  assert.equal(stats.works, 2);
  assert.equal(stats.inserted, 2);
  assert.equal(stats.flaggedReview, 1);
  assert.deepEqual(stats.legacy, { rows: 3, matched: 2, hidden: 0, waiting: 2, unmatched: 1 });

  const { rows: archived } = await db.query(
    `SELECT id, source_external_id AS ref, title, type, status, flag, processing_status, canonical_url,
            series, outlets, published_at
       FROM public_artifact WHERE source_system = 'archive' ORDER BY source_external_id`
  );
  assert.deepEqual(archived.map((a) => a.ref), ["gdrive:doc-1", "gmail:sub"]);
  const [doc, column] = archived;
  assert.equal(column.title, "自由市場的代價");
  assert.equal(column.flag, null);
  assert.equal(column.status, "published");
  assert.equal(column.processing_status, "pending"); // the worker processes it next
  assert.equal(column.canonical_url, "https://leesimon.me/2020/06/kemu");
  assert.equal(column.series, "蘋果論壇");
  assert.equal(column.outlets[0], "蘋果日報");
  assert.equal(column.published_at.toISOString().slice(0, 10), "2020-06-24");
  assert.equal(doc.flag, "review"); // never published
  assert.equal(doc.canonical_url, "https://example.org/old"); // kept from the row it replaces

  const old = async () =>
    Object.fromEntries(
      (
        await db.query(
          `SELECT source_external_id AS ref, status, flag, superseded_by FROM public_artifact
            WHERE source_system <> 'archive'`
        )
      ).rows.map((r) => [r.ref, r])
    );
  let rows = await old();
  // Replaced, but still searchable until the new row is processed.
  assert.deepEqual([rows.n1.status, rows.n1.flag, rows.n1.superseded_by], ["published", null, column.id]);
  assert.deepEqual([rows.n3.status, rows.n3.superseded_by], ["published", doc.id]);
  assert.deepEqual([rows.n2.status, rows.n2.flag, rows.n2.superseded_by], ["published", "unmatched", null]);
  assert.deepEqual([rows.y1.status, rows.y1.flag, rows.y1.superseded_by], ["published", null, null]);

  // The worker processes the column: the row it replaces leaves search.
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE id = $1", [column.id]);
  assert.equal(await load.retireReplacedRows(column.id, db), 1);
  rows = await old();
  assert.equal(rows.n1.status, "superseded");
  assert.equal(rows.n3.status, "published");

  // Archive rows left from an earlier load: one whose text is now a copy in
  // the column's work, one no work has any more.
  await db.query(
    `INSERT INTO public_artifact (user_id, type, title, raw_source, source_system, source_external_id, processing_status) VALUES
       ('default', 'essay', '利字當頭：科目三', $1, 'archive', 'wordpress:leesimon.me:42', 'processed'),
       ('default', 'essay', '舊', '舊文', 'archive', 'gmail:gone', 'processed')`,
    [ESSAY]
  );

  // Loading again changes nothing that is current.
  const again = load.emptyLoadStats();
  await load.runLoad(again, async () => {}, () => false, db);
  assert.equal(again.inserted, 0);
  assert.equal(again.unchanged, 2);
  assert.equal(again.retired, 2);
  assert.deepEqual(again.legacy, { rows: 3, matched: 2, hidden: 1, waiting: 1, unmatched: 1 });
  const { rows: after } = await db.query(
    `SELECT source_external_id AS ref, status, superseded_by, processing_status
       FROM public_artifact WHERE source_system = 'archive' ORDER BY source_external_id`
  );
  const byRef = Object.fromEntries(after.map((r) => [r.ref, r]));
  assert.equal(byRef["gmail:sub"].processing_status, "processed"); // same text: not processed again
  assert.deepEqual([byRef["wordpress:leesimon.me:42"].status, byRef["wordpress:leesimon.me:42"].superseded_by], ["superseded", column.id]);
  assert.deepEqual([byRef["gmail:gone"].status, byRef["gmail:gone"].superseded_by], ["superseded", null]);
  assert.equal((await old()).n1.status, "superseded");

  // A changed canonical text goes back to the worker, and its old copy is
  // searchable again until the new text is processed.
  await db.query(`UPDATE archive_candidate SET body_text = body_text || '\n\n補記：多謝讀者指正。' WHERE id =
                    (SELECT canonical_candidate_id FROM archive_work WHERE title = '自由市場的代價')`);
  const third = load.emptyLoadStats();
  await load.runLoad(third, async () => {}, () => false, db);
  assert.equal(third.updated, 1);
  const { rows: requeued } = await db.query("SELECT processing_status, summary FROM public_artifact WHERE id = $1", [column.id]);
  assert.equal(requeued[0].processing_status, "pending");
  assert.equal((await old()).n1.status, "published");

  const summary = await load.loadSummary(db);
  assert.ok(summary.some((r) => r.source_system === "archive" && r.flag === "review"));
});

test("catch-up loads when no load has run since the works were made", { skip }, async () => {
  const auto = await import("../src/archive/consolidation/extract/auto");
  const load = await import("../src/archive/consolidation/load/run");
  await db.query("DELETE FROM public_artifact");
  assert.equal(await auto.loadStale(db), false); // no works yet
  await buildWorks();
  assert.equal(await auto.loadStale(db), true);
  const stale = {
    candidates: () => auto.candidatesStale(db),
    works: () => auto.worksStale(db),
    load: () => auto.loadStale(db),
  };
  assert.deepEqual(await auto.catchUp(async () => "run-1", stale), { source: "load", runId: "run-1" });

  const runId = await staging.startRun("load", {}, db);
  const stats = load.emptyLoadStats();
  await load.runLoad(stats, async () => {}, () => false, db);
  await staging.finishRun(runId, "succeeded", stats, null, db);
  assert.equal(await auto.loadStale(db), false);
  assert.equal(await auto.catchUp(async () => "run-2", stale), null);

  // A load that started while a match was writing read the works from
  // before it: what it read counts, not when it started.
  const read: string = (await db.query("SELECT stats->>'worksMatchedAt' AS t FROM archive_collect_run WHERE id = $1", [runId])).rows[0].t;
  assert.ok(read);
  await db.query(
    `UPDATE archive_collect_run SET started_at = now() + interval '1 hour',
            stats = jsonb_set(stats, '{worksMatchedAt}', to_jsonb(($2::timestamptz - interval '1 second')::text))
      WHERE id = $1`,
    [runId, read]
  );
  assert.equal(await auto.loadStale(db), true);
  await db.query(
    `UPDATE archive_collect_run SET started_at = now(), stats = jsonb_set(stats, '{worksMatchedAt}', to_jsonb($2::text))
      WHERE id = $1`,
    [runId, read]
  );
  assert.equal(await auto.loadStale(db), false);

  // New works (a later match), or a new loader version, mean load again.
  const { rows: gen } = await db.query("SELECT max(matched_at)::text AS t FROM archive_work");
  await db.query("UPDATE archive_work SET matched_at = now() + interval '1 second'");
  assert.equal(await auto.loadStale(db), true);
  await db.query("UPDATE archive_work SET matched_at = $1::timestamptz", [gen[0].t]);
  assert.equal(await auto.loadStale(db), false);
  await db.query(`UPDATE archive_collect_run SET stats = stats || '{"loaderVersion": 0}' WHERE id = $1`, [runId]);
  assert.equal(await auto.loadStale(db), true);
  await db.query(`UPDATE archive_collect_run SET stats = stats || '{"loaderVersion": ${load.LOADER_VERSION}}' WHERE id = $1`, [runId]);
  assert.equal(await auto.loadStale(db), false);

  // A match that leaves no works at all is a new generation too (Codex on
  // #99): loading it retires the archive rows, and is then current.
  await db.query("DELETE FROM archive_work");
  assert.equal(await auto.loadStale(db), true);
  const emptyRun = await staging.startRun("load", {}, db);
  const emptyStats = load.emptyLoadStats();
  await load.runLoad(emptyStats, async () => {}, () => false, db);
  await staging.finishRun(emptyRun, "succeeded", emptyStats, null, db);
  assert.equal(emptyStats.retired, 2);
  assert.equal(await auto.loadStale(db), false);
  const { rows: archived } = await db.query("SELECT DISTINCT status FROM public_artifact WHERE source_system = 'archive'");
  assert.deepEqual(archived.map((r) => r.status), ["superseded"]);
});

// What one worker pass hands completeArtifactProcessing, for `text`.
function pass(text: string, over: Record<string, unknown> = {}) {
  return {
    cleanText: text,
    summary: "摘要",
    excerpt: "",
    tags: [] as string[],
    language: "zh",
    embedding: new Array(1536).fill(0),
    embeddingModel: "test",
    chunks: [] as ReturnType<typeof chunk>[],
    entities: [] as { entityRefId: string; mentionText: string | null; salience: number | null }[],
    ...over,
  };
}

function chunk(chunkIndex: number, chunkText: string) {
  return {
    chunkIndex,
    chunkText,
    chunkTokens: chunkText.length,
    headingPath: [] as string[],
    startOffset: 0,
    endOffset: chunkText.length,
    embedding: new Array(1536).fill(0),
  };
}

async function entity(name: string): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO entity_ref (user_id, entity_type, normalized_name, display_name)
     VALUES ('default', 'concept', $1, $1)
     ON CONFLICT (user_id, entity_type, normalized_name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [name]
  );
  return rows[0].id;
}

// Until a session running a statement like `statement` waits on a lock
// (other test files may wait on locks of their own).
async function waitForLockWait(statement: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE $1`,
      [statement]
    );
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no session waited on a lock running ${statement}`);
}

test("the worker saves its result only for the text it processed (Codex on #99)", { skip }, async () => {
  const load = await import("../src/archive/consolidation/load/run");
  const queries = await import("../src/archive/queries");
  await db.query("DELETE FROM public_artifact");
  await buildWorks();
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE source_external_id <> 'gmail:sub'");

  // The worker takes the column; meanwhile a new match changes its text and
  // a load queues it again.
  const claimed = await queries.findPendingArtifact();
  assert.equal(claimed?.title, "自由市場的代價");
  await db.query(`UPDATE archive_candidate SET body_text = body_text || '\n\n補記：多謝讀者指正。' WHERE id =
                    (SELECT canonical_candidate_id FROM archive_work WHERE title = '自由市場的代價')`);
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);

  assert.equal(await queries.artifactHoldsText(claimed!.id, claimed!.raw_source), false);
  const old = pass(claimed!.raw_source, { summary: "舊文的摘要" });
  assert.equal(await queries.completeArtifactProcessing(claimed!.id, claimed!.raw_source, old), false);
  const { rows } = await db.query("SELECT processing_status, summary, raw_source FROM public_artifact WHERE id = $1", [claimed!.id]);
  assert.equal(rows[0].processing_status, "pending"); // processed again, with the new text
  assert.equal(rows[0].summary, null);
  assert.match(rows[0].raw_source, /補記/);

  const next = await queries.findPendingArtifact();
  assert.equal(next?.id, claimed!.id);
  assert.equal(await queries.artifactHoldsText(next!.id, next!.raw_source), true);
  assert.equal(await queries.completeArtifactProcessing(next!.id, next!.raw_source, pass(next!.raw_source)), true);
  const { rows: done } = await db.query("SELECT processing_status, last_error FROM public_artifact WHERE id = $1", [claimed!.id]);
  assert.deepEqual([done[0].processing_status, done[0].last_error], ["processed", null]);
});

test("a pass on an old text writes nothing, even after the new text's pass finished first (Codex on #99)", { skip }, async () => {
  const load = await import("../src/archive/consolidation/load/run");
  const queries = await import("../src/archive/queries");
  await db.query("DELETE FROM public_artifact");
  await db.query("DELETE FROM link_edge WHERE target_type = 'public_artifact' OR source_type = 'public_artifact'");
  await buildWorks();
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE source_external_id <> 'gmail:sub'");
  const { rows: others } = await db.query("SELECT id, raw_source FROM public_artifact WHERE source_external_id <> 'gmail:sub' LIMIT 1");
  const [eOld, eNew1, eNew2] = [await entity("race-old"), await entity("race-new-1"), await entity("race-new-2")];
  // Another row shares the new text's two entities, so the new text's
  // pass links to it.
  assert.equal(
    await queries.completeArtifactProcessing(others[0].id, others[0].raw_source, pass(others[0].raw_source, {
      entities: [eNew1, eNew2].map((entityRefId) => ({ entityRefId, mentionText: null, salience: 0.9 })),
    })),
    true
  );

  // Worker A takes the column. A load queues the new text, worker B takes
  // it and finishes first; then A, still on the old text, tries to save.
  const a = await queries.findPendingArtifact();
  await db.query(`UPDATE archive_candidate SET body_text = body_text || '\n\n補記：多謝讀者指正。' WHERE id =
                    (SELECT canonical_candidate_id FROM archive_work WHERE title = '自由市場的代價')`);
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  const b = await queries.findPendingArtifact();
  assert.equal(b?.id, a!.id);
  assert.notEqual(b!.raw_source, a!.raw_source);
  const newPass = pass(b!.raw_source, {
    summary: "新文的摘要",
    chunks: [chunk(0, "新文第一段"), chunk(1, "新文第二段")],
    entities: [eNew1, eNew2].map((entityRefId) => ({ entityRefId, mentionText: null, salience: 0.9 })),
  });
  assert.equal(await queries.completeArtifactProcessing(b!.id, b!.raw_source, newPass), true);
  const oldPass = pass(a!.raw_source, {
    summary: "舊文的摘要",
    chunks: [chunk(0, "舊文第一段")],
    entities: [{ entityRefId: eOld, mentionText: null, salience: 0.9 }],
  });
  assert.equal(await queries.completeArtifactProcessing(a!.id, a!.raw_source, oldPass), false);

  const { rows: row } = await db.query("SELECT processing_status, summary, raw_source FROM public_artifact WHERE id = $1", [a!.id]);
  assert.deepEqual([row[0].processing_status, row[0].summary, row[0].raw_source], ["processed", "新文的摘要", b!.raw_source]);
  const { rows: chunks } = await db.query(
    "SELECT chunk_text FROM public_artifact_chunk WHERE public_artifact_id = $1 ORDER BY chunk_index", [a!.id]
  );
  assert.deepEqual(chunks.map((r) => r.chunk_text), ["新文第一段", "新文第二段"]);
  const { rows: ents } = await db.query(
    "SELECT entity_ref_id FROM public_artifact_entity WHERE public_artifact_id = $1 ORDER BY entity_ref_id", [a!.id]
  );
  assert.deepEqual(ents.map((r) => r.entity_ref_id), [eNew1, eNew2].sort());
  const { rows: links } = await db.query(
    `SELECT target_id, explanation FROM link_edge
      WHERE source_type = 'public_artifact' AND source_id = $1 AND link_type = 'shared_entities'`,
    [a!.id]
  );
  assert.deepEqual(links.map((r) => [r.target_id, r.explanation]), [[others[0].id, "2 shared entities"]]);
});

test("a load that changes the text while a pass saves either waits for it or leaves it writing nothing (Codex on #99)", { skip }, async () => {
  const load = await import("../src/archive/consolidation/load/run");
  const queries = await import("../src/archive/queries");
  await db.query("DELETE FROM public_artifact");
  await buildWorks();
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE source_external_id <> 'gmail:sub'");
  const claimed = await queries.findPendingArtifact();
  const state = async () =>
    (await db.query("SELECT processing_status, summary FROM public_artifact WHERE id = $1", [claimed!.id])).rows[0];

  // The text changes in a transaction that has not committed yet: the pass
  // waits for it, then finds the row holds another text and writes nothing.
  const other = await db.connect();
  try {
    await other.query("BEGIN");
    await other.query("UPDATE public_artifact SET raw_source = raw_source || '（修訂）', summary = NULL, processing_status = 'pending' WHERE id = $1", [claimed!.id]);
    const saving = queries.completeArtifactProcessing(claimed!.id, claimed!.raw_source, pass(claimed!.raw_source, {
      summary: "舊文的摘要",
      chunks: [chunk(0, "舊文第一段")],
    }));
    await waitForLockWait("%FOR NO KEY UPDATE%");
    await other.query("COMMIT");
    assert.equal(await saving, false);
  } finally {
    await other.query("ROLLBACK").catch(() => undefined);
    other.release();
  }
  assert.deepEqual(await state(), { processing_status: "pending", summary: null });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM public_artifact_chunk WHERE public_artifact_id = $1", [claimed!.id])).rows[0].n, 0);

  // The other way round: a change that comes while the pass holds the row
  // waits for the pass to commit, then queues the row again. (The pass is
  // held at its lock, so the change is sure to come after it.)
  const next = await queries.findPendingArtifact();
  const holder = await db.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM public_artifact WHERE id = $1 FOR NO KEY UPDATE", [next!.id]);
    const saving = queries.completeArtifactProcessing(next!.id, next!.raw_source, pass(next!.raw_source, { summary: "新文的摘要" }));
    await waitForLockWait("%FOR NO KEY UPDATE%");
    const changing = appPool!.query(
      "UPDATE public_artifact SET raw_source = raw_source || '（再修訂）', summary = NULL, processing_status = 'pending' WHERE id = $1",
      [next!.id]
    );
    await waitForLockWait("%（再修訂）%");
    await holder.query("COMMIT");
    assert.equal(await saving, true);
    await changing;
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  assert.deepEqual(await state(), { processing_status: "pending", summary: null });
});

test("a failed attempt on an old text leaves the new one queued (Codex on #99)", { skip }, async () => {
  const load = await import("../src/archive/consolidation/load/run");
  const queries = await import("../src/archive/queries");
  await db.query("DELETE FROM public_artifact");
  await buildWorks();
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE source_external_id <> 'gmail:sub'");
  const claimed = await queries.findPendingArtifact();
  await db.query(`UPDATE archive_candidate SET body_text = body_text || '\n\n補記。' WHERE id =
                    (SELECT canonical_candidate_id FROM archive_work WHERE title = '自由市場的代價')`);
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  await queries.markArtifactError(claimed!.id, "Entity extraction truncated", claimed!.raw_source);
  const { rows } = await db.query("SELECT processing_status, last_error FROM public_artifact WHERE id = $1", [claimed!.id]);
  assert.deepEqual([rows[0].processing_status, rows[0].last_error], ["pending", null]);
  // The same failure on the text it holds is recorded.
  const again = await queries.findPendingArtifact();
  await queries.markArtifactError(again!.id, "Entity extraction truncated", again!.raw_source);
  assert.equal((await db.query("SELECT processing_status FROM public_artifact WHERE id = $1", [claimed!.id])).rows[0].processing_status, "error");
});

test("old rows leave search only once their replacement is fully processed, and their links follow it (Codex on #99)", { skip }, async () => {
  const load = await import("../src/archive/consolidation/load/run");
  const queries = await import("../src/archive/queries");
  await db.query("DELETE FROM public_artifact");
  await db.query("DELETE FROM link_edge WHERE target_type = 'public_artifact' OR source_type = 'public_artifact'");
  await buildWorks();
  const { rows: old } = await db.query(
    `INSERT INTO public_artifact (user_id, type, title, raw_source, source_system, source_external_id, processing_status)
     VALUES ('default', 'essay', '自由市場的代價', $1, 'notion', 'n1', 'processed') RETURNING id`,
    [`老總：附上今期稿件。\n\n${ESSAY}`]
  );
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  const { rows: col } = await db.query("SELECT id FROM public_artifact WHERE source_external_id = 'gmail:sub'");
  const columnId = col[0].id;
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE source_system = 'archive' AND id <> $1", [columnId]);

  // A journal entry echoes the old row twice over (two link types), and
  // already echoes the new row once; the new row links to the old one.
  const entry = "11111111-1111-1111-1111-111111111111";
  await db.query(
    `INSERT INTO link_edge (user_id, source_type, source_id, target_type, target_id, link_type, confidence) VALUES
       ('default', 'journal_entry', $1, 'public_artifact', $2, 'echoes_artifact', 0.8),
       ('default', 'journal_entry', $1, 'public_artifact', $2, 'mentions', 0.5),
       ('default', 'journal_entry', $1, 'public_artifact', $3, 'echoes_artifact', 0.7),
       ('default', 'public_artifact', $3, 'public_artifact', $2, 'shared_entities', NULL)`,
    [entry, old[0].id, columnId]
  );

  // The worker is processing the new row: a load now leaves the old row
  // in search.
  const claimed = await queries.findPendingArtifact();
  assert.equal(claimed?.id, columnId);
  const stats = load.emptyLoadStats();
  await load.runLoad(stats, async () => {}, () => false, db);
  assert.equal(stats.legacy.hidden + stats.retiredLate, 0);
  const oldStatus = async () => (await db.query("SELECT status FROM public_artifact WHERE id = $1", [old[0].id])).rows[0].status;
  assert.equal(await oldStatus(), "published");

  // Finished: the old row leaves search and its links move to the new row.
  assert.equal(await queries.completeArtifactProcessing(columnId, claimed!.raw_source, pass(claimed!.raw_source)), true);
  assert.equal(await load.retireReplacedRows(columnId, db), 1);
  assert.equal(await oldStatus(), "superseded");
  const { rows: links } = await db.query(
    `SELECT source_type, target_id, link_type, confidence FROM link_edge
      WHERE target_type = 'public_artifact' ORDER BY link_type, confidence`
  );
  assert.deepEqual(
    links.map((l) => [l.source_type, l.target_id === columnId, l.link_type, l.confidence]),
    [
      ["journal_entry", true, "echoes_artifact", 0.7], // already there: kept, not doubled
      ["journal_entry", true, "mentions", 0.5],
    ]
  );
});

test("a load that read the works before a match finished loads again (Codex on #99)", { skip }, async () => {
  const { startCollection } = await import("../src/archive/consolidation/runner");
  await db.query("DELETE FROM public_artifact");
  await buildWorks();
  // Hold the load up once it has read the works: it waits for public_artifact.
  const lock = await db.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE public_artifact IN ACCESS EXCLUSIVE MODE");
    await startCollection({ source: "load" });
    // A match finishes while the load runs: its own load is refused.
    await lock.query("UPDATE archive_work SET matched_at = clock_timestamp()");
    await assert.rejects(startCollection({ source: "load" }), staging.RunAlreadyActiveError);
    await lock.query("COMMIT");
  } finally {
    lock.release();
  }

  let runs: { status: string }[] = [];
  for (let i = 0; i < 200; i++) {
    runs = (await db.query("SELECT status FROM archive_collect_run WHERE source = 'load' ORDER BY started_at")).rows;
    if (runs.length === 2 && runs.every((r) => r.status !== "running")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(runs.map((r) => r.status), ["succeeded", "succeeded"]);
  const load = await import("../src/archive/consolidation/load/run");
  assert.equal(await load.loadStale(db), false);
});

test("retiring an old row and moving its links succeed or fail together (Codex on #99)", { skip }, async () => {
  const load = await import("../src/archive/consolidation/load/run");
  await db.query("DELETE FROM public_artifact");
  await db.query("DELETE FROM link_edge WHERE target_type = 'public_artifact' OR source_type = 'public_artifact'");
  await buildWorks();
  const { rows: old } = await db.query(
    `INSERT INTO public_artifact (user_id, type, title, raw_source, source_system, source_external_id, processing_status)
     VALUES ('default', 'essay', '自由市場的代價', $1, 'notion', 'n1', 'processed') RETURNING id`,
    [ESSAY]
  );
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  const { rows: col } = await db.query("SELECT id FROM public_artifact WHERE source_external_id = 'gmail:sub'");
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE id = $1", [col[0].id]);
  await db.query(
    `INSERT INTO link_edge (user_id, source_type, source_id, target_type, target_id, link_type, confidence)
     VALUES ('default', 'journal_entry', '11111111-1111-1111-1111-111111111111', 'public_artifact', $1, 'echoes_artifact', 0.8)`,
    [old[0].id]
  );
  const oldStatus = async () => (await db.query("SELECT status FROM public_artifact WHERE id = $1", [old[0].id])).rows[0].status;

  // Moving the link fails: the old row stays in search.
  await db.query(`CREATE OR REPLACE FUNCTION test_fail_link() RETURNS trigger AS $$
                  BEGIN RAISE EXCEPTION 'link_edge unavailable'; END $$ LANGUAGE plpgsql`);
  await db.query("CREATE TRIGGER test_fail_link BEFORE INSERT ON link_edge FOR EACH ROW EXECUTE FUNCTION test_fail_link()");
  try {
    await assert.rejects(load.retireReplacedRows(col[0].id, db), /link_edge unavailable/);
    assert.equal(await oldStatus(), "published");
  } finally {
    await db.query("DROP TRIGGER IF EXISTS test_fail_link ON link_edge");
    await db.query("DROP FUNCTION IF EXISTS test_fail_link()");
  }
  assert.equal(await load.retireReplacedRows(col[0].id, db), 1);
  assert.equal(await oldStatus(), "superseded");
  const { rows: links } = await db.query("SELECT target_id FROM link_edge WHERE source_type = 'journal_entry'");
  assert.deepEqual(links.map((l) => l.target_id), [col[0].id]);
});

test("each pass rebuilds an artifact's shared-entity links, dropping stale ones (Codex on #99)", { skip }, async () => {
  const queries = await import("../src/archive/queries");
  await db.query("DELETE FROM public_artifact");
  await db.query("DELETE FROM link_edge WHERE target_type = 'public_artifact' OR source_type = 'public_artifact'");
  const ids: string[] = [];
  for (const ref of ["a", "b", "c"]) {
    const { rows } = await db.query(
      `INSERT INTO public_artifact (user_id, type, title, raw_source, source_system, source_external_id, processing_status)
       VALUES ('default', 'essay', $1, $1, 'archive', $1, 'processed') RETURNING id`,
      [`entity-test:${ref}`]
    );
    ids.push(rows[0].id);
  }
  const [a, b, c] = ids;
  const [e1, e2, e3] = [await entity("entity-test-1"), await entity("entity-test-2"), await entity("entity-test-3")];
  // a's entities from the earlier pass: e3 is gone from its new text. b
  // and c hold e1 twice, as rows saved by the old worker can.
  for (const [artifact, ent] of [[a, e3], [b, e1], [b, e1], [b, e2], [c, e1], [c, e1], [c, e3]]) {
    await db.query("INSERT INTO public_artifact_entity (public_artifact_id, entity_ref_id) VALUES ($1, $2)", [artifact, ent]);
  }
  // Links from an earlier pass on another text: to c (no longer related),
  // and to b with a stale count. Links into a are someone else's.
  await db.query(
    `INSERT INTO link_edge (user_id, source_type, source_id, target_type, target_id, link_type, explanation) VALUES
       ('default', 'public_artifact', $1, 'public_artifact', $3, 'shared_entities', '3 shared entities'),
       ('default', 'public_artifact', $1, 'public_artifact', $2, 'shared_entities', '5 shared entities'),
       ('default', 'public_artifact', $2, 'public_artifact', $1, 'shared_entities', '2 shared entities'),
       ('default', 'journal_entry', '11111111-1111-1111-1111-111111111111', 'public_artifact', $1, 'echoes_artifact', NULL)`,
    [a, b, c]
  );

  // The extractor named e1 twice: it counts once.
  const entities = [
    { entityRefId: e1, mentionText: "entity-test-1", salience: 0.9 },
    { entityRefId: e1, mentionText: "Entity-Test-1", salience: 0.8 },
    { entityRefId: e2, mentionText: "entity-test-2", salience: null },
  ];
  assert.equal(await queries.completeArtifactProcessing(a, "entity-test:a", pass("entity-test:a", { entities })), true);
  const { rows: mine } = await db.query(
    "SELECT entity_ref_id, salience FROM public_artifact_entity WHERE public_artifact_id = $1 ORDER BY entity_ref_id", [a]
  );
  assert.deepEqual(mine.map((r) => [r.entity_ref_id, r.salience]), [[e1, 0.9], [e2, null]].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)));
  const { rows } = await db.query(
    `SELECT source_id, target_id, link_type, explanation FROM link_edge
      WHERE source_id = $1 OR target_id = $1 ORDER BY link_type, source_id`,
    [a]
  );
  const name = (id: string) => (id === a ? "a" : id === b ? "b" : id === c ? "c" : "entry");
  assert.deepEqual(
    rows.map((r) => [name(r.source_id), name(r.target_id), r.link_type, r.explanation].join(" ")).sort(),
    ["a b shared_entities 2 shared entities", "b a shared_entities 2 shared entities", "entry a echoes_artifact "]
  );
});

test("idea links to an old row move to its replacement, keeping a record (Codex on #99)", { skip }, async () => {
  const load = await import("../src/archive/consolidation/load/run");
  await db.query("DELETE FROM public_artifact");
  await buildWorks();
  const { rows: old } = await db.query(
    `INSERT INTO public_artifact (user_id, type, title, raw_source, source_system, source_external_id, processing_status)
     VALUES ('default', 'essay', '自由市場的代價', $1, 'notion', 'n1', 'processed'),
            ('default', 'essay', '自由市場的代價（重複）', $1, 'notion', 'n1b', 'processed') RETURNING id`,
    [ESSAY]
  );
  await load.runLoad(load.emptyLoadStats(), async () => {}, () => false, db);
  const { rows: col } = await db.query("SELECT id FROM public_artifact WHERE source_external_id = 'gmail:sub'");
  const columnId = col[0].id;
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE id = $1", [columnId]);

  const idea = async (title: string) =>
    (await db.query("INSERT INTO idea (user_id, title) VALUES ('entity-test-user', $1) RETURNING id", [title])).rows[0].id as string;
  const link = async (source: string, target: string, type: string, status: string) =>
    (
      await db.query(
        `INSERT INTO idea_link (user_id, source_idea_id, target_artifact_id, link_type, status, rationale, proposed_by, decided_at)
         VALUES ('entity-test-user', $1, $2, $3, $4, '它成了這篇文章', 'gardening',
                 CASE WHEN $4 = 'proposed' THEN NULL ELSE now() END) RETURNING id`,
        [source, target, type, status]
      )
    ).rows[0].id as string;
  const market = await idea("市場與政府");
  const other = await idea("另一個想法");
  // Accepted 'became' to the old row; a rejected 'revisits' (remembered);
  // and the same 'became' to both old copies: only one can move.
  const became = await link(market, old[0].id, "became", "accepted");
  const rejected = await link(market, old[0].id, "revisits", "rejected");
  const first = await link(other, old[0].id, "became", "accepted");
  const second = await link(other, old[1].id, "became", "proposed");

  assert.equal(await load.retireReplacedRows(columnId, db), 2);
  const { rows } = await db.query("SELECT id, target_artifact_id, history FROM idea_link");
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const id of [became, rejected, first]) {
    assert.equal(byId[id].target_artifact_id, columnId);
    assert.equal(byId[id].history.at(-1).retargeted_by, "archive-consolidation");
  }
  assert.equal(byId[became].history.at(-1).target_artifact_id, old[0].id);
  // The accepted one of the pair moved; the proposed duplicate stays.
  assert.equal(byId[second].target_artifact_id, old[1].id);
  assert.deepEqual(byId[second].history, []);
  await db.query("DELETE FROM idea WHERE user_id = 'entity-test-user'");
});
