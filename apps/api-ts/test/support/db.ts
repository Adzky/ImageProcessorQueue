import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { ImageJob, NewJob } from '../../src/db/schema.js';
import { JobRepository } from '../../src/jobs/repository.js';

let current: { db: Db; repo: JobRepository } | undefined;

/** Register DB lifecycle hooks: migrate once, truncate before each test, close afterwards. */
export function testDb(): { db: Db; repo: JobRepository } {
  const handle = createDb(loadConfig());
  const db = handle.db;
  const repo = new JobRepository(db);
  current = { db, repo };
  beforeAll(() => runMigrations(db));
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE image_jobs`);
  });
  afterAll(() => handle.close());
  return current;
}

export async function makeJob(overrides: Partial<NewJob> = {}): Promise<ImageJob> {
  if (current === undefined) throw new Error('call testDb() first');
  const id = overrides.id ?? crypto.randomUUID();
  return current.repo.insert({
    id,
    originalName: 'photo.jpg',
    originalMime: 'image/jpeg',
    originalSize: 18234567,
    originalPath: `uploads/${id}.jpg`,
    ...overrides,
  });
}
