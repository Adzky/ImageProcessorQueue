import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { imageJobs, type ImageJob, type NewJob } from '../db/schema.js';
import { errorMessage, type ImageErrorCode } from './errors.js';
import { JobStatus } from './status.js';

export interface CompletedResult {
  resultPath: string;
  size: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

const nonTerminal = [JobStatus.Pending, JobStatus.Processing];

/**
 * Every state change is one conditional UPDATE, so concurrent or duplicate queue deliveries
 * can never move a job backwards or overwrite another delivery's outcome. `attempts` stores
 * the queue attempt number of the delivery that owns the job (claim token).
 */
export class JobRepository {
  constructor(private readonly db: Db) {}

  async insert(row: NewJob): Promise<ImageJob> {
    const [job] = await this.db.insert(imageJobs).values(row).returning();
    if (job === undefined) throw new Error('insert returned no row');
    return job;
  }

  async find(id: string): Promise<ImageJob | undefined> {
    const [job] = await this.db.select().from(imageJobs).where(eq(imageJobs.id, id));
    return job;
  }

  /**
   * Take ownership for queue attempt `attempt`. A retry (higher attempt) may take over a job
   * left in `processing` by a crashed worker; a duplicate (same/lower attempt) may not.
   */
  async claim(id: string, attempt: number): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .update(imageJobs)
      .set({ status: JobStatus.Processing, attempts: attempt, startedAt: now, updatedAt: now })
      .where(
        and(
          eq(imageJobs.id, id),
          inArray(imageJobs.status, nonTerminal),
          lt(imageJobs.attempts, attempt),
        ),
      )
      .returning({ id: imageJobs.id });
    return rows.length === 1;
  }

  /** Only the delivery that currently owns the job may complete it. */
  async markCompleted(id: string, attempt: number, result: CompletedResult): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .update(imageJobs)
      .set({
        status: JobStatus.Completed,
        resultPath: result.resultPath,
        resultSize: result.size,
        resultWidth: result.width,
        resultHeight: result.height,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(imageJobs.id, id),
          eq(imageJobs.status, JobStatus.Processing),
          eq(imageJobs.attempts, attempt),
        ),
      )
      .returning({ id: imageJobs.id });
    return rows.length === 1;
  }

  /** Fail a non-terminal job. Terminal jobs are never changed. */
  async markFailed(id: string, code: ImageErrorCode, message?: string): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .update(imageJobs)
      .set({
        status: JobStatus.Failed,
        errorCode: code,
        errorMessage: message ?? errorMessage(code),
        failedAt: now,
        updatedAt: now,
      })
      .where(and(eq(imageJobs.id, id), inArray(imageJobs.status, nonTerminal)))
      .returning({ id: imageJobs.id });
    return rows.length === 1;
  }
}
