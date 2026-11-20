import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import type { ImageJob } from '../../src/db/schema.js';
import { processImage } from '../../src/images/processor.js';
import { runImageJob } from '../../src/images/runner.js';
import { PermanentImageFailure } from '../../src/jobs/errors.js';
import { JobStatus } from '../../src/jobs/status.js';
import { makeJob, testDb } from '../support/db.js';
import { cleanupImages, makeCorruptFile, makeImage, makeTempDir } from '../support/images.js';

const { repo } = testDb();

let config: Config;

beforeEach(async () => {
  config = { ...loadConfig(), storagePath: await makeTempDir() };
});

afterEach(cleanupImages);

/** A pending row whose original is stored at `uploads/<id>.jpg` under the storage root. */
async function pendingJob(source?: string): Promise<ImageJob> {
  const file = source ?? (await makeImage(2000, 1000));
  const job = await makeJob({ originalSize: (await stat(file)).size });
  await mkdir(join(config.storagePath, 'uploads'), { recursive: true });
  await copyFile(file, join(config.storagePath, job.originalPath));
  return job;
}

describe('runImageJob', () => {
  it('completes pending job', async () => {
    const job = await pendingJob();

    await runImageJob({ repo, config }, job.id, 1);

    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Completed);
    expect(found?.attempts).toBe(1);
    expect(found?.resultPath).toBe(`results/${job.id}.webp`);
    const result = await stat(join(config.storagePath, `results/${job.id}.webp`));
    expect([found?.resultWidth, found?.resultHeight]).toEqual([1280, 640]);
    expect([found?.originalWidth, found?.originalHeight]).toEqual([2000, 1000]);
    expect(found?.resultSize).toBe(result.size);
  });

  it('noop for missing job', async () => {
    const process = vi.fn(processImage);

    await runImageJob({ repo, config, process }, '0193a000-0000-7000-8000-000000000000', 1);

    expect(process).not.toHaveBeenCalled();
  });

  it('noop for terminal job', async () => {
    const job = await makeJob({ status: JobStatus.Completed });
    const process = vi.fn(processImage);

    await runImageJob({ repo, config, process }, job.id, 1);

    expect(process).not.toHaveBeenCalled();
    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Completed);
    expect(found?.attempts).toBe(0);
  });

  it('noop when claim lost', async () => {
    const job = await pendingJob();
    await repo.claim(job.id, 2);
    const process = vi.fn(processImage);

    await runImageJob({ repo, config, process }, job.id, 1);

    expect(process).not.toHaveBeenCalled();
    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Processing);
    expect(found?.attempts).toBe(2);
  });

  it('retry takes over', async () => {
    const job = await pendingJob();
    await repo.claim(job.id, 1); // first delivery "crashed" mid-processing

    await runImageJob({ repo, config }, job.id, 2);

    const found = await repo.find(job.id);
    expect(found?.status).toBe(JobStatus.Completed);
    expect(found?.attempts).toBe(2);
  });

  it('permanent failure propagates', async () => {
    const job = await pendingJob(await makeCorruptFile());

    await expect(runImageJob({ repo, config }, job.id, 1)).rejects.toBeInstanceOf(PermanentImageFailure);
  });

  it('processing delay is applied', async () => {
    config = { ...config, processingDelayMs: 50 };
    const job = await pendingJob(await makeImage(10, 10));

    const start = performance.now();
    await runImageJob({ repo, config }, job.id, 1);

    expect(performance.now() - start).toBeGreaterThanOrEqual(50);
    expect((await repo.find(job.id))?.status).toBe(JobStatus.Completed);
  });
});
