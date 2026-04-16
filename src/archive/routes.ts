import { Router, json } from "express";
import multer from "multer";
import { importNotionExport } from "./ingest/notion-export";
import { hybridSearch, SearchRequest } from "./search";
import * as archiveQueries from "./queries";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

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
