import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeJob, testDb } from '../support/db.js';
import { appWith, testConfig } from '../support/http.js';
import { cleanupImages } from '../support/images.js';

const { repo } = testDb();
let app: FastifyInstance;

beforeEach(async () => {
  app = appWith(await testConfig(), repo, () => Promise.resolve());
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await cleanupImages();
});

const get = (url: string) => app.inject({ method: 'GET', url });
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000000Z$/;

describe('GET /api/images/:id', () => {
  it('pending shape', async () => {
    const job = await makeJob();
    const res = await get(`/api/images/${job.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(
      [
        'job_id', 'status', 'attempts', 'original', 'result', 'download_url', 'error', 'expired',
        'created_at', 'started_at', 'completed_at', 'failed_at',
      ].sort(),
    );
    expect(body).toMatchObject({
      job_id: job.id,
      status: 'pending',
      attempts: 0,
      result: null,
      download_url: null,
      error: null,
      expired: false,
      started_at: null,
      completed_at: null,
      failed_at: null,
    });
    expect(body['original']).toEqual({ name: 'photo.jpg', mime: 'image/jpeg', size: 18234567, width: null, height: null });
    expect(body['created_at']).toMatch(ISO);
  });

  it('completed includes result and download_url', async () => {
    const job = await makeJob();
    await repo.claim(job.id, 1);
    await repo.markCompleted(job.id, 1, {
      resultPath: `results/${job.id}.webp`, size: 402311, width: 1280, height: 853, originalWidth: 6000, originalHeight: 4000,
    });
    const body = (await get(`/api/images/${job.id}`)).json<Record<string, unknown>>();
    expect(body).toMatchObject({
      status: 'completed',
      attempts: 1,
      original: { width: 6000, height: 4000 },
      result: { size: 402311, width: 1280, height: 853 },
      download_url: `/api/images/${job.id}/download`,
      error: null,
    });
    expect(body['completed_at']).toMatch(ISO);
  });

  it('failed includes error', async () => {
    const job = await makeJob();
    await repo.markFailed(job.id, 'corrupt_image');
    const body = (await get(`/api/images/${job.id}`)).json<Record<string, unknown>>();
    expect(body).toMatchObject({
      status: 'failed',
      download_url: null,
      error: { code: 'corrupt_image', message: "This file couldn't be read as an image. It may be corrupted." },
    });
    expect(body['failed_at']).toMatch(ISO);
  });

  it('expired completed job has no download_url', async () => {
    const job = await makeJob({ status: 'completed', expiredAt: new Date() });
    const body = (await get(`/api/images/${job.id}`)).json<Record<string, unknown>>();
    expect(body).toMatchObject({ status: 'completed', expired: true, download_url: null });
  });

  it('unknown id 404', async () => {
    const res = await get(`/api/images/${crypto.randomUUID()}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Job not found.' } });
  });

  it('malformed id 404', async () => {
    const res = await get('/api/images/not-a-uuid');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Job not found.' } });
  });
});

describe('GET /up', () => {
  it('returns 200', async () => {
    expect((await get('/up')).statusCode).toBe(200);
  });
});
