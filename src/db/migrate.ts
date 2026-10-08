import type { Pool } from "pg";
import { pool } from "./client";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(__dirname, "../../migrations");

// The shared pool gives every connection a 10 s statement_timeout, a guard
// for request-time queries. A migration (an index build, a backfill) may
// need longer, and a cancelled migration fails the boot. So migrations run
// on one connection of their own with the limit lifted for that session,
// and the connection is closed afterwards instead of going back to the
// pool, where the lifted limit would otherwise outlive the migrations.
export async function migrate(db: Pool = pool, migrationsDir: string = MIGRATIONS_DIR): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("SET statement_timeout = 0");
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        "SELECT 1 FROM _migrations WHERE name = $1",
        [file]
      );

      if (rows.length > 0) {
        console.log(`Skipping ${file} (already applied)`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      console.log(`Applied ${file}`);
    }
  } finally {
    client.release(true);
  }
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log("Migrations complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
