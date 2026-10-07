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
});

test("candidates are stale until extracted, and again when the rules change", { skip }, async () => {
  const run = await import("../src/archive/consolidation/extract/run");
  const auto = await import("../src/archive/consolidation/extract/auto");
  assert.equal(await auto.candidatesStale(db), false); // nothing staged
  await stageForExtraction();
  assert.equal(await auto.candidatesStale(db), true);

  const started: unknown[] = [];
  const fakeStart = async (req: unknown) => {
    started.push(req);
    return "run-1";
  };
  assert.equal(await auto.extractIfStale(fakeStart, () => auto.candidatesStale(db)), "run-1");
  assert.deepEqual(started, [{ source: "extract" }]);

  await run.runExtraction(run.emptyExtractStats(), async () => {}, () => false, db);
  assert.equal(await auto.candidatesStale(db), false);
  assert.equal(await auto.extractIfStale(fakeStart, () => auto.candidatesStale(db)), null);

  await db.query("UPDATE archive_candidate SET extractor_version = extractor_version - 1 WHERE id IN (SELECT id FROM archive_candidate LIMIT 1)");
  assert.equal(await auto.candidatesStale(db), true);

  // A run already going is left alone.
  const busy = async () => {
    throw new staging.RunAlreadyActiveError("extract");
  };
  assert.equal(await auto.extractIfStale(busy, async () => true), null);
});
