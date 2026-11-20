import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Config } from '../config.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/**
 * `onError` receives errors from idle pooled connections (e.g. Postgres restarted); without a
 * listener they would crash long-running processes.
 */
export function createDb(
  config: Config,
  onError: (err: Error) => void = (err) => {
    console.error('Postgres pool error', err);
  },
): { db: Db; close(): Promise<void> } {
  const pool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
  });
  pool.on('error', onError);
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}
