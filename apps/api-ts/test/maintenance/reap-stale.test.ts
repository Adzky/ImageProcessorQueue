import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { reapStaleJobs } from '../../src/maintenance/reap-stale.js';
import { makeJob, testDb } from '../support/db.js';

const { db, repo } = testDb();

const ago = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

async function reap(env: NodeJS.ProcessEnv = {}): Promise<number> {
  return reapStaleJobs({ db, repo, config: loadConfig(env) });
}

describe('reapStaleJobs', () => {
  it('marks old processing jobs failed', async () => {
    const job = await makeJob({ status: 'processing', attempts: 3, startedAt: ago(601) });

    expect(await reap()).toBe(1);

    const found = await repo.find(job.id);
    expect(found?.status).toBe('failed');
    expect(found?.errorCode).toBe('worker_lost');
    expect(found?.errorMessage).toBe("Processing didn't finish in time. Please try again.");
  });

  it('keeps job whose retry is still queued', async () => {
    const job = await makeJob({ status: 'processing', attempts: 1, startedAt: ago(601) });
    expect(await reap()).toBe(0);
    expect((await repo.find(job.id))?.status).toBe('processing');
  });

  it('reaps early attempt after lost threshold', async () => {
    const job = await makeJob({ status: 'processing', attempts: 1, startedAt: ago(3601) });
    expect(await reap()).toBe(1);
    expect((await repo.find(job.id))?.errorCode).toBe('worker_lost');
  });

  it('ignores recent processing', async () => {
    const job = await makeJob({ status: 'processing', attempts: 3, startedAt: ago(300) });
    expect(await reap()).toBe(0);
    expect((await repo.find(job.id))?.status).toBe('processing');
  });

  it('never touches pending', async () => {
    const job = await makeJob({ status: 'pending', createdAt: ago(7200) });
    expect(await reap()).toBe(0);
    expect((await repo.find(job.id))?.status).toBe('pending');
  });

  it('never touches terminal', async () => {
    const job = await makeJob({ status: 'completed', attempts: 3, startedAt: ago(7200) });
    expect(await reap()).toBe(0);
    expect((await repo.find(job.id))?.status).toBe('completed');
  });

  it('respects configured threshold', async () => {
    const job = await makeJob({ status: 'processing', attempts: 3, startedAt: ago(120) });
    expect(await reap({ IMAGE_STALE_AFTER_SECONDS: '60' })).toBe(1);
    expect((await repo.find(job.id))?.status).toBe('failed');
  });

  it('returns the number reaped', async () => {
    await makeJob({ status: 'processing', attempts: 3, startedAt: ago(1200) });
    await makeJob({ status: 'processing', attempts: 3, startedAt: ago(1800) });
    await makeJob({ status: 'processing', attempts: 3, startedAt: new Date() });
    expect(await reap()).toBe(2);
  });

  it('uses the supplied clock', async () => {
    const job = await makeJob({ status: 'processing', attempts: 3, startedAt: ago(10) });
    const later = new Date(Date.now() + 700_000);
    expect(await reapStaleJobs({ db, repo, config: loadConfig({}) }, later)).toBe(1);
    expect((await repo.find(job.id))?.status).toBe('failed');
  });
});
