import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { ImageJob } from '../../src/db/schema.js';
import { makeJob, testDb } from '../support/db.js';
import { appWith, testConfig } from '../support/http.js';
import { cleanupImages } from '../support/images.js';

const { repo } = testDb();
const BYTES = Buffer.from('RIFF0000WEBPVP8 fake');
let app: FastifyInstance;
let config: Config;

beforeEach(async () => {
  config = await testConfig();
  app = appWith(config, repo, () => Promise.resolve());
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await cleanupImages();
});

async function completedJob(originalName = 'photo.jpg', expiredAt?: Date): Promise<ImageJob> {
  const job = await makeJob({ originalName, ...(expiredAt === undefined ? {} : { expiredAt }) });
  const path = `results/${job.id}.webp`;
  await mkdir(join(config.storagePath, 'results'), { recursive: true });
  await writeFile(join(config.storagePath, path), BYTES);
  await repo.claim(job.id, 1);
  await repo.markCompleted(job.id, 1, {
    resultPath: path, size: 20, width: 10, height: 10, originalWidth: 10, originalHeight: 10,
  });
  return job;
}

const download = (id: string) => app.inject({ method: 'GET', url: `/api/images/${id}/download` });

describe('GET /api/images/:id/download', () => {
  it('404 unknown', async () => {
    const res = await download(crypto.randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });

  it('409 when not completed', async () => {
    const job = await makeJob();
    const res = await download(job.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'not_ready', message: "This image isn't ready yet (status: pending)." },
    });
  });

  it('410 when expired', async () => {
    const job = await completedJob('photo.jpg', new Date());
    const res = await download(job.id);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({
      error: { code: 'expired', message: 'This result has expired. Please upload the image again.' },
    });
  });

  it('streams webp with filename', async () => {
    const job = await completedJob('photo.jpg');
    const res = await download(job.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    const disposition = String(res.headers['content-disposition']);
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('photo.webp');
    expect(res.rawPayload.equals(BYTES)).toBe(true);
  });

  it('non-ASCII filename has fallback and utf8', async () => {
    const job = await completedJob('фото 1.jpg');
    const disposition = String((await download(job.id)).headers['content-disposition']);
    expect(disposition).toContain("filename*=utf-8''");
    expect(disposition).toContain(encodeURIComponent('фото 1.webp'));
    expect(disposition).toMatch(/filename="[\x20-\x7e]+\.webp"/);
  });
});
