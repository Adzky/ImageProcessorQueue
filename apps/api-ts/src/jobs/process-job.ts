import { UnrecoverableError } from 'bullmq';
import type { Logger } from 'pino';
import { runImageJob, type RunnerDeps } from '../images/runner.js';
import { PermanentImageFailure, type ImageErrorCode } from './errors.js';

/** Deliveries allowed per job, counting both retries and redeliveries after a worker crash. */
export const MAX_TRIES = 3;

/** Wait before retry 1 and retry 2. */
export const BACKOFF_MS = [5000, 15000] as const;

export type DeliveryDeps = RunnerDeps & { logger: Logger };

/** BullMQ custom backoff: `attemptsMade` is the number of failed attempts so far. */
export function retryDelay(attemptsMade: number): number {
  return BACKOFF_MS[attemptsMade - 1] ?? 15000;
}

/**
 * The BullMQ processor body. `attempt` is `job.attemptsStarted`, which rises on every retry
 * and on every redelivery of a stalled job (worker killed mid-job), so it doubles as the
 * claim token and as the delivery count.
 *
 * - Transient errors are rethrown so BullMQ retries with backoff.
 * - Permanent errors (bad input) fail immediately: retrying can't fix them.
 * - BullMQ's own `attempts` counts failures only, not stalls, so the 3-delivery cap is
 *   enforced here; anything thrown as `UnrecoverableError` is never retried.
 */
export async function handleDelivery(deps: DeliveryDeps, data: { imageJobId: string }, attempt: number): Promise<void> {
  const id = data.imageJobId;

  if (attempt > MAX_TRIES) {
    return fail(deps, id, 'retries_exhausted', new Error(`delivery ${String(attempt)} exceeds ${String(MAX_TRIES)} tries`));
  }

  try {
    await runImageJob(deps, id, attempt);
  } catch (e) {
    if (e instanceof PermanentImageFailure) {
      return fail(deps, id, e.code, e);
    }
    if (attempt >= MAX_TRIES) {
      return fail(deps, id, 'retries_exhausted', e);
    }
    deps.logger.warn({ job_id: id, attempt, err: e }, 'Image job attempt failed; will retry');
    throw e;
  }
}

/** The job is given up on: record why, log it, and stop BullMQ from retrying. */
async function fail(deps: DeliveryDeps, id: string, code: ImageErrorCode, cause: unknown): Promise<never> {
  await deps.repo.markFailed(id, code);
  deps.logger.error({ job_id: id, error_code: code, err: cause }, 'Image job failed');
  throw new UnrecoverableError(code);
}
