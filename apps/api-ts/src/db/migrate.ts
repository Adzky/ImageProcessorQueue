import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.js';

// Resolved from the project root so it works from both src/ (tests) and dist/ (build).
const migrationsFolder = resolve(import.meta.dirname, '../../src/db/migrations');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
