import { Router, json } from "express";
import { importYouTubeVideo, YouTubeImportBody } from "./ingest/youtube";
import { hybridSearch, SearchRequest } from "./search";
import * as archiveQueries from "./queries";
import { auditPublicArtifacts } from "./consolidation/audit";
import { startCollection, type CollectRequest } from "./consolidation/runner";
import { getStagingStatus, RunAlreadyActiveError } from "./consolidation/staging";
import { describeGoogleError } from "../google/errors";

// Drive ids go into a Drive search query, so accept only id characters.
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export function parseCollectRequest(body: unknown): CollectRequest | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const refetch = b.refetch === true;
  if (b.source === "gmail") {
    const label = b.label === undefined ? "Writing" : b.label;
    if (typeof label !== "string" || label.trim().length === 0 || label.length > 200) {
      return "label must be a non-empty string";
    }
    return { source: "gmail", label: label.trim(), refetch };
  }
  if (b.source === "gdrive") {
    const ids = b.folderIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20) {
      return "folderIds must be a non-empty array (max 20)";
    }
    if (!ids.every((id) => typeof id === "string" && DRIVE_ID.test(id))) {
      return "folderIds must be Drive folder ids";
    }
    return { source: "gdrive", folderIds: ids as string[], refetch };
  }
  return "source must be 'gmail' or 'gdrive'";
}

export function archiveRoutes(): Router {
  const router = Router();

  // Full transcripts run past body-parser's 100kb default: the sync script's
  // JSON escapes each CJK char as \uXXXX, so a 30k-char transcript is ~180kb.
  router.post("/archive/import/youtube", json({ limit: "10mb" }), async (req, res) => {
    const body = req.body as Partial<YouTubeImportBody> | undefined;
    if (!body?.video_id || !body?.title || !body?.transcript) {
      res.status(400).json({
        error: "video_id, title, and transcript are required",
      });
      return;
    }

    try {
      const result = await importYouTubeVideo(body as YouTubeImportBody);
      res.json(result);
    } catch (err) {
      console.error(`[archive] YouTube import error for ${body.video_id}:`, err);
      res.status(500).json({ error: "Import failed" });
    }
  });

  router.post("/archive/search", json(), async (req, res) => {
    const body = req.body as SearchRequest;

    if (!body.query || typeof body.query !== "string") {
      res.status(400).json({ error: "query is required" });
      return;
    }

    try {
      const results = await hybridSearch(body);
      res.json({ results, count: results.length });
    } catch (err) {
      console.error("[archive] Search error:", err);
      res.status(500).json({ error: "Search failed" });
    }
  });

  router.get("/archive/diagnostics", async (_req, res) => {
    try {
      const diag = await archiveQueries.getProcessingDiagnostics();
      res.json(diag);
    } catch (err) {
      console.error("[archive] Diagnostics error:", err);
      res.status(500).json({ error: "Failed to get diagnostics" });
    }
  });

  router.post("/archive/retry-errors", async (_req, res) => {
    try {
      const count = await archiveQueries.resetErroredArtifacts();
      res.json({ reset: count });
    } catch (err) {
      console.error("[archive] Retry-errors error:", err);
      res.status(500).json({ error: "Failed to reset errored artifacts" });
    }
  });

  // Published-archive consolidation, step 1 (docs/archive-consolidation.md).
  router.post("/archive/consolidation/collect", json(), async (req, res) => {
    const parsed = parseCollectRequest(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    try {
      const runId = await startCollection(parsed);
      res.status(202).json({ runId, status: "running" });
    } catch (err) {
      if (err instanceof RunAlreadyActiveError) {
        res.status(409).json({ error: err.message });
        return;
      }
      console.error("[consolidation] collect error:", describeGoogleError(err));
      res.status(500).json({ error: "Failed to start collection" });
    }
  });

  router.get("/archive/consolidation/status", async (_req, res) => {
    try {
      const [staging, audit] = await Promise.all([getStagingStatus(), auditPublicArtifacts()]);
      res.json({ staging, publicArtifactAudit: audit });
    } catch (err) {
      console.error("[consolidation] status error:", describeGoogleError(err));
      res.status(500).json({ error: "Failed to get consolidation status" });
    }
  });

  router.get("/archive/stats", async (_req, res) => {
    try {
      const stats = await archiveQueries.getArtifactStats();
      res.json(stats);
    } catch (err) {
      console.error("[archive] Stats error:", err);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  return router;
}
