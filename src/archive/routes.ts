import { Router, json } from "express";
import multer from "multer";
import { importNotionExport } from "./ingest/notion-export";
import { syncNotionDatabase, NotionSyncResult } from "./ingest/notion-api";
import { hybridSearch, SearchRequest } from "./search";
import * as archiveQueries from "./queries";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

let currentSync: {
  startedAt: Date;
  databaseId: string;
  status: "running" | "completed" | "failed";
  result: NotionSyncResult | null;
  error: string | null;
} | null = null;

export function archiveRoutes(): Router {
  const router = Router();

  router.post(
    "/archive/import/notion-export",
    upload.single("file"),
    async (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: "file is required (multipart upload)" });
        return;
      }

      try {
        const result = await importNotionExport(req.file.buffer);
        console.log(
          `[archive] Notion import: ${result.imported} imported, ${result.skipped} skipped, ${result.total} total`
        );
        res.json(result);
      } catch (err) {
        console.error("[archive] Notion import error:", err);
        res.status(500).json({ error: "Import failed" });
      }
    }
  );

  router.post("/archive/import/notion-api", json(), async (req, res) => {
    const databaseId =
      (req.body?.database_id as string | undefined) ||
      process.env.NOTION_DATABASE_ID;

    if (!databaseId) {
      res.status(400).json({
        error: "database_id required (in body or NOTION_DATABASE_ID env var)",
      });
      return;
    }
    if (!process.env.NOTION_TOKEN) {
      res.status(400).json({ error: "NOTION_TOKEN env var is not set" });
      return;
    }
    if (currentSync?.status === "running") {
      res.status(409).json({
        error: "A sync is already running",
        startedAt: currentSync.startedAt,
      });
      return;
    }

    currentSync = {
      startedAt: new Date(),
      databaseId,
      status: "running",
      result: null,
      error: null,
    };

    // Fire-and-forget
    syncNotionDatabase(databaseId)
      .then((result) => {
        if (currentSync) {
          currentSync.status = "completed";
          currentSync.result = result;
        }
      })
      .catch((err) => {
        console.error("[archive] Notion sync failed:", err);
        if (currentSync) {
          currentSync.status = "failed";
          currentSync.error = err.message || String(err);
        }
      });

    res.json({
      status: "started",
      databaseId,
      startedAt: currentSync.startedAt,
      checkAt: "/archive/sync-status",
    });
  });

  router.get("/archive/sync-status", (_req, res) => {
    if (!currentSync) {
      res.json({ status: "idle" });
      return;
    }
    res.json(currentSync);
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
