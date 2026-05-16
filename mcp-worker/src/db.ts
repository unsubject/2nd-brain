import postgres from 'postgres';
import type { Env } from './env';

export function getDb(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
}
