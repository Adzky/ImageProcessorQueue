import { and, eq, gte, lt, or } from 'drizzle-orm';
import { imageJobs } from '../db/schema.js';
import { MAX_TRIES } from '../jobs/policy.js';
import { JobStatus } from '../jobs/status.js';
import type { MaintenanceDeps } from './deps.js';

/**
 * Safety net for jobs whose worker died and that the queue will not recover.
 *
 * - On the final attempt no retry is coming: a claim older than `staleAfterSeconds` is abandoned.
 * - On earlier attempts a retry may still be queued behind a backlog, so the row is only reaped
 *   after `lostAfterSeconds`, when the queue message itself must have been lost.
 *
 * Pending jobs are never reaped. Returns how many jobs actually transitioned to failed.
 */
export async function reapStaleJobs(
  { db, repo, config }: MaintenanceDeps,
  now: Date = new Date(),
): Promise<number> {
  const stale = new Date(now.getTime() - config.staleAfterSeconds * 1000);
  const lost = new Date(now.getTime() - config.lostAfterSeconds * 1000);

  const candidates = await db
    .select({ id: imageJobs.id })
    .from(imageJobs)
    .where(
      and(
        eq(imageJobs.status, JobStatus.Processing),
        or(
          and(gte(imageJobs.attempts, MAX_TRIES), lt(imageJobs.startedAt, stale)),
          lt(imageJobs.startedAt, lost),
        ),
      ),
    );

  let reaped = 0;
  for (const { id } of candidates) {
    if (await repo.markFailed(id, 'worker_lost')) reaped++;
  }
  return reaped;
}
