import { Router, json } from "express";
import { importYouTubeVideo, YouTubeImportBody } from "./ingest/youtube";
import { hybridSearch, SearchRequest } from "./search";
import * as archiveQueries from "./queries";

export function archiveRoutes(): Router {
  const router = Router();

  router.post("/archive/import/youtube", json(), async (req, res) => {
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
