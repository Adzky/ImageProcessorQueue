import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../src/jobs/errors.js';
import { isTerminal, JobStatus } from '../../src/jobs/status.js';
import { makeJob, testDb } from '../support/db.js';

const { repo } = testDb();

const result = {
  resultPath: 'results/x.webp',
  size: 100,
  width: 1280,
  height: 960,
  originalWidth: 4000,
  originalHeight: 3000,
};

describe('JobRepository transitions', () => {
  it('new job defaults to pending with attempts 0', async () => {
    const job = await makeJob();
    const found = await repo.find(job.id);
    expect(found?.status).toBe('pending');
    expect(found?.attempts).toBe(0);
    expect(found?.originalSize).toBe(18234567);
  });

  it('claim moves pending to processing with attempt', async () => {
    const job = await makeJob();
    expect(await repo.claim(job.id, 1)).toBe(true);
    const found = await repo.find(job.id);
    expect(found?.status).toBe('processing');
    expect(found?.attempts).toBe(1);
    expect(found?.startedAt).toBeInstanceOf(Date);
  });

  it('claim with same or lower attempt is rejected', async () => {
    const job = await makeJob();
    await repo.claim(job.id, 2);
    expect(await repo.claim(job.id, 2)).toBe(false);
    expect(await repo.claim(job.id, 1)).toBe(false);
    expect((await repo.find(job.id))?.attempts).toBe(2);
  });

  it('higher attempt takes over processing job', async () => {
    const job = await makeJob();
    await repo.claim(job.id, 1);
    expect(await repo.claim(job.id, 2)).toBe(true);
    const found = await repo.find(job.id);
    expect(found?.attempts).toBe(2);
    expect(found?.status).toBe('processing');
  });

  it('claim rejected on terminal rows', async () => {
    const completed = await makeJob({ status: JobStatus.Completed });
    const failed = await makeJob({ status: JobStatus.Failed });
    expect(await repo.claim(completed.id, 1)).toBe(false);
    expect(await repo.claim(failed.id, 1)).toBe(false);
    expect((await repo.find(completed.id))?.status).toBe('completed');
    expect((await repo.find(failed.id))?.status).toBe('failed');
  });

  it('complete requires current owner', async () => {
    const job = await makeJob();
    await repo.claim(job.id, 1);
    await repo.claim(job.id, 2);

    expect(await repo.markCompleted(job.id, 1, result)).toBe(false);
    expect((await repo.find(job.id))?.status).toBe('processing');

    expect(await repo.markCompleted(job.id, 2, result)).toBe(true);
    const found = await repo.find(job.id);
    expect(found?.status).toBe('completed');
    expect(found?.resultPath).toBe('results/x.webp');
    expect(found?.resultSize).toBe(100);
    expect(found?.resultWidth).toBe(1280);
    expect(found?.resultHeight).toBe(960);
    expect(found?.originalWidth).toBe(4000);
    expect(found?.originalHeight).toBe(3000);
    expect(found?.completedAt).toBeInstanceOf(Date);
  });

  it('mark failed works from pending', async () => {
    const job = await makeJob();
    expect(await repo.markFailed(job.id, 'queue_unavailable', 'custom')).toBe(true);
    expect((await repo.find(job.id))?.errorMessage).toBe('custom');
  });

  it('mark failed uses default message and ignores terminal', async () => {
    const job = await makeJob();
    await repo.claim(job.id, 1);

    expect(await repo.markFailed(job.id, 'worker_lost')).toBe(true);
    const found = await repo.find(job.id);
    expect(found?.status).toBe('failed');
    expect(found?.errorCode).toBe('worker_lost');
    expect(found?.errorMessage).toBe(errorMessage('worker_lost'));
    expect(found?.failedAt).toBeInstanceOf(Date);

    const completed = await makeJob({ status: JobStatus.Completed });
    expect(await repo.markFailed(completed.id, 'worker_lost')).toBe(false);
    expect((await repo.find(completed.id))?.status).toBe('completed');
  });

  it('status is terminal', () => {
    expect(isTerminal(JobStatus.Pending)).toBe(false);
    expect(isTerminal(JobStatus.Processing)).toBe(false);
    expect(isTerminal(JobStatus.Completed)).toBe(true);
    expect(isTerminal(JobStatus.Failed)).toBe(true);
  });
});
