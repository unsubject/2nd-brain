import { Pool, PoolClient } from "pg";

// statement_timeout applies to every connection: a guard against a runaway
// request-time query. The background jobs keep each statement short (keyset
// pages, per-row writes, batched deletes) so they fit under it; migrations
// lift it on a connection of their own (migrate.ts).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
});

export type DB = Pool | PoolClient;
