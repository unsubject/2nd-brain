import express, { type Express } from "express";
import { getAuthUrl, handleCallback } from "./google/auth";
import { googleAuthRoutes, secretMatches } from "./google/routes";
import { archiveRoutes } from "./archive/routes";

export type AppOptions = {
  /** ARCHIVE_API_KEY; the archive routes refuse every request without it. */
  archiveApiKey: string | undefined;
  /** OWNER_SECRET for /auth/google. */
  ownerSecret: string | undefined;
};

export function createApp(opts: AppOptions): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(
    googleAuthRoutes({
      secret: opts.ownerSecret,
      getAuthUrl,
      handleCallback,
    })
  );

  // Archive routes: bearer auth. Mounted by path so Express's own matching
  // decides what is "/archive": routing is case-insensitive, and a string
  // prefix check let /Archive/... through to the routes unauthenticated.
  app.use("/archive", (req, res, next) => {
    const auth = req.headers.authorization;
    const given = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    if (!secretMatches(given, opts.archiveApiKey)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  app.use(archiveRoutes());

  return app;
}

export function startServer(port: number): void {
  const app = createApp({
    archiveApiKey: process.env.ARCHIVE_API_KEY || undefined,
    ownerSecret: process.env.OWNER_SECRET?.trim() || undefined,
  });
  app.listen(port, () => {
    console.log(`HTTP server listening on port ${port}`);
  });
}
