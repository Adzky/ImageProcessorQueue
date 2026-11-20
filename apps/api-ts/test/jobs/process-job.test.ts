import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UnrecoverableError, type Queue, type Worker } from 'bullmq';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import type { ImageJob } from '../../src/db/schema.js';
import { processImage } from '../../src/images/processor.js';
import { errorMessage } from '../../src/jobs/errors.js';
import { handleDelivery, retryDelay } from '../../src/jobs/process-job.js';
import { BACKOFF_MS, MAX_TRIES } from '../../src/jobs/policy.js';
import { JobStatus } from '../../src/jobs/status.js';
import { createQueue, createWorker, enqueue, QUEUE_NAME, type ImageJobData } from '../../src/queue.js';
import { makeJob, testDb } from '../support/db.js';
import { cleanupImages, makeCorruptFile, makeImage, makeTempDir } from '../support/images.js';

const { repo } = testDb();
const logger = pino({ level: 'silent' });

let config: Config;

beforeEach(async () => {
  config = { ...loadConfig(), storagePath: await makeTempDir() };
});

afterEach(cleanupImages);

async function jobFor(source: string): Promise<ImageJob> {
  const id = randomUUID();
  const job = await makeJob({ id, originalMime: 'image/png', originalPath: `uploads/${id}.png` });
  await mkdir(join(config.storagePath, 'uploads'), { recursive: true });
  await copyFile(source, join(config.storagePath, job.originalPath));
  return job;
}

const diskOnFire = () => Promise.reject(new Error('disk on fire'));

describe('handleDelivery', () => {
  it('successful job completes', async () => {
    const job = await jobFor(await makeImage(50, 50, 'png'));

    await handleDelivery({ repo, config, logger }, { imageJobId: job.id }, 1);

    expect((await repo.find(job.id))?.status).toBe(JobStatus.Completed);
  });

  it('permanent failure fails without retry', async () => {
    const job = await jobFor(await makeCorruptFile());

    await expect(handleDelivery({ repo, config, logger }, { imageJobId: job.id }, 1)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Failed);
    expect(found?.errorCode).toBe('corrupt_image');
    expect(found?.errorMessage).toBe(errorMessage('corrupt_image'));
  });

  it('transient error on attempt 1 rethrows and leaves row processing', async () => {
    const job = await jobFor(await makeImage(10, 10, 'png'));

    const delivery = handleDelivery({ repo, config, logger, process: diskOnFire }, { imageJobId: job.id }, 1);

    await expect(delivery).rejects.toThrow('disk on fire');
    await expect(delivery).rejects.not.toBeInstanceOf(UnrecoverableError);
    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Processing);
    expect(found?.attempts).toBe(1);
    expect(found?.errorCode).toBeNull();
  });

  it('transient error on attempt 3 marks retries_exhausted', async () => {
    const job = await jobFor(await makeImage(10, 10, 'png'));

    await expect(
      handleDelivery({ repo, config, logger, process: diskOnFire }, { imageJobId: job.id }, 3),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Failed);
    expect(found?.errorCode).toBe('retries_exhausted');
    expect(found?.errorMessage).toBe("We couldn't process this image after 3 attempts. Please try again.");
    expect(found?.errorMessage).not.toContain('disk on fire');
  });

  it('redelivery after a crash takes over the row', async () => {
    const job = await jobFor(await makeImage(10, 10, 'png'));
    await repo.claim(job.id, 1); // worker killed mid-job; BullMQ redelivers it as stalled

    await handleDelivery({ repo, config, logger }, { imageJobId: job.id }, 2);

    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Completed);
    expect(found?.attempts).toBe(2);
  });

  it('fourth start marks retries_exhausted without processing', async () => {
    const job = await jobFor(await makeImage(10, 10, 'png'));
    await repo.claim(job.id, 3); // third delivery crashed too
    const process = vi.fn(processImage);

    await expect(
      handleDelivery({ repo, config, logger, process }, { imageJobId: job.id }, MAX_TRIES + 1),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(process).not.toHaveBeenCalled();
    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Failed);
    expect(found?.errorCode).toBe('retries_exhausted');
    expect(found?.attempts).toBe(3);
  });

  it('job config', () => {
    expect(MAX_TRIES).toBe(3);
    expect(BACKOFF_MS).toEqual([5000, 15000]);
    expect([retryDelay(1), retryDelay(2), retryDelay(3)]).toEqual([5000, 15000, 15000]);
    expect(QUEUE_NAME).toBe('images');
  });
});

describe('real queue', () => {
  let queue: Queue<ImageJobData> | undefined;
  let worker: Worker | undefined;

  afterEach(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
    worker = undefined;
    queue = undefined;
  });

  it('enqueue sets retry options and uses the image job id', async () => {
    queue = createQueue(config, `images-test-${randomUUID()}`);
    const id = randomUUID();

    await enqueue(queue, id);

    const queued = await queue.getJob(id);
    expect(queued?.data).toEqual({ imageJobId: id });
    expect(queued?.opts.attempts).toBe(MAX_TRIES + 1);
    expect(queued?.opts.backoff).toEqual({ type: 'custom' });
    expect(queued?.opts.removeOnComplete).toBe(true);
    expect(queued?.opts.removeOnFail).toBe(1000);
  });

  it('end to end through a real queue', async () => {
    const name = `images-test-${randomUUID()}`;
    const job = await jobFor(await makeImage(3000, 1500));
    queue = createQueue(config, name);
    worker = createWorker({ repo, config, logger }, config, name);
    const completed = new Promise<number>((resolve, reject) => {
      worker?.on('completed', (j) => {
        resolve(j.attemptsStarted);
      });
      worker?.on('failed', (_j, err) => {
        reject(err);
      });
    });

    await enqueue(queue, job.id);

    expect(await completed).toBe(1);
    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Completed);
    expect(found?.attempts).toBe(1);
    expect([found?.resultWidth, found?.resultHeight]).toEqual([1280, 640]);
  });
});
