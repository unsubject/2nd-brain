import { migrate } from "./db/migrate";
import { startServer } from "./server";
import { startWorker } from "./worker";
import { startGoogleSync } from "./google/sync";
import { startArchiveWorker } from "./archive/worker";
import { startIdeaEmbeddingWorker } from "./ideas/worker";
import { startMcpRetention } from "./mcp/retention";
import { describeGoogleError } from "./google/errors";

// Node prints an unhandled error in full, nested properties included, which
// for Google API errors means the request that carried the refresh token.
// Log a safe line instead. A stray rejected promise is logged and the
// process keeps serving (every background loop catches its own errors); an
// uncaught exception still exits.
process.on("unhandledRejection", (reason) => {
  console.error(`[process] unhandled rejection: ${describeGoogleError(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[process] uncaught exception: ${describeGoogleError(err)}`);
  process.exit(1);
});

async function main() {
  const port = parseInt(process.env.PORT || "3000", 10);

  console.log("Running migrations...");
  await migrate();

  startServer(port);
  startWorker();
  startGoogleSync();
  startArchiveWorker();
  startIdeaEmbeddingWorker();
  startMcpRetention();
}

main().catch((err) => {
  console.error(`Fatal error: ${describeGoogleError(err)}`);
  process.exit(1);
});
