import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.js';
import type { JobRepository } from '../jobs/repository.js';
import { isTerminal } from '../jobs/status.js';
import { processImage } from './processor.js';

export type RunnerDeps = {
  repo: JobRepository;
  config: Config;
  process?: typeof processImage;
};

/** Per-attempt limit for the sharp pipeline (the PHP job's `$timeout`). */
const TIMEOUT_SECONDS = 120;

/**
 * Executes one delivery of an image job: claim → process → complete.
 *
 * Kept separate from the queue processor so the lifecycle can be tested with explicit
 * attempt numbers. Errors propagate; `handleDelivery` decides retry vs. fail.
 */
export async function runImageJob(deps: RunnerDeps, id: string, attempt: number): Promise<void> {
  const { repo, config } = deps;
  const job = await repo.find(id);

  if (job === undefined || isTerminal(job.status)) {
    return; // already finished (duplicate delivery) or deleted
  }

  if (!(await repo.claim(id, attempt))) {
    return; // another delivery owns this job
  }

  if (config.processingDelayMs > 0) {
    await sleep(config.processingDelayMs); // demo-only: widens the window for the crash-recovery demo
  }

  const resultPath = `results/${job.id}.webp`;
  await mkdir(join(config.storagePath, 'results'), { recursive: true });

  const process = deps.process ?? processImage;
  const result = await process(join(config.storagePath, job.originalPath), join(config.storagePath, resultPath), {
    maxDimension: config.maxDimension,
    quality: config.quality,
    maxPixels: config.maxPixels,
    timeoutSeconds: TIMEOUT_SECONDS,
  });

  await repo.markCompleted(id, attempt, { resultPath, ...result });
}
