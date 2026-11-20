import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { imageJobs } from '../db/schema.js';
import { JobStatus } from '../jobs/status.js';
import type { Logger } from 'pino';
import type { MaintenanceDeps } from './deps.js';

/**
 * Deletes the files of finished jobs older than `retentionHours` and marks the rows expired.
 * Rows are kept so the API can answer 410 Gone instead of 404. Returns the number expired.
 */
export async function cleanupExpiredJobs(
  { db, config, logger }: MaintenanceDeps & { logger?: Logger },
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - config.retentionHours * 3_600_000);

  const candidates = await db
    .select({
      id: imageJobs.id,
      originalPath: imageJobs.originalPath,
      resultPath: imageJobs.resultPath,
    })
    .from(imageJobs)
    .where(
      and(
        inArray(imageJobs.status, [JobStatus.Completed, JobStatus.Failed]),
        isNull(imageJobs.expiredAt),
        lt(imageJobs.createdAt, cutoff),
      ),
    );

  let expired = 0;
  for (const job of candidates) {
    for (const path of [job.originalPath, job.resultPath]) {
      if (path === null || path === '') continue;
      // force: true ignores a missing file (ENOENT). Anything else is logged and the row is
      // still expired, like Laravel's Storage::delete returning false, so one bad row
      // cannot block the run every hour.
      try {
        await rm(join(config.storagePath, path), { force: true });
      } catch (err) {
        logger?.warn({ err, job_id: job.id, path }, 'Could not delete expired job file');
      }
    }

    const rows = await db
      .update(imageJobs)
      .set({ expiredAt: now, updatedAt: now })
      .where(and(eq(imageJobs.id, job.id), isNull(imageJobs.expiredAt)))
      .returning({ id: imageJobs.id });
    expired += rows.length;
  }
  return expired;
}
