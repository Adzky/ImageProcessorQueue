import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { sanitiseName } from '../../src/http/upload.js';
import { createQueue, enqueue } from '../../src/queue.js';
import { makeApng, makeImage, cleanupImages } from '../support/images.js';
import { testDb } from '../support/db.js';
import {
  appWith,
  BOUNDARY,
  multipartBody,
  multipartHeaders,
  multipartParts,
  testConfig,
  uploadsDir,
} from '../support/http.js';

const { db, repo } = testDb();
const MB = 1024 * 1024;
const TYPE_MSG = 'File must be a JPG, PNG or WebP image.';

let config: Config;
let enqueued: string[];
let app: FastifyInstance;

async function post(payload: Buffer, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/api/images', headers: { ...multipartHeaders, ...headers }, payload });
}

async function postFile(path: string, name: string) {
  return post(multipartBody(await readFile(path), name, 'application/octet-stream'));
}

async function jobCount(): Promise<unknown> {
  const count = await db.execute(sql`SELECT count(*)::int AS n FROM image_jobs`);
  return count.rows[0];
}

beforeEach(async () => {
  config = await testConfig();
  enqueued = [];
  app = appWith(config, repo, (id) => {
    enqueued.push(id);
    return Promise.resolve();
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await cleanupImages();
});

describe('POST /api/images', () => {
  it.each([
    ['jpeg', 'photo.jpg', 'jpg', 'image/jpeg'],
    ['png', 'photo.png', 'png', 'image/png'],
    ['webp', 'photo.webp', 'webp', 'image/webp'],
  ] as const)('accepts %s and returns 202', async (format, name, ext, mime) => {
    const res = await postFile(await makeImage(64, 48, format), name);

    expect(res.statusCode).toBe(202);
    const body = res.json<{ job_id: string; status: string; status_url: string; created_at: string }>();
    expect(body.status).toBe('pending');
    expect(body.status_url).toBe(`/api/images/${body.job_id}`);
    expect(res.headers['location']).toBe(body.status_url);
    expect(body.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000000Z$/);

    const job = await repo.find(body.job_id);
    expect(job?.status).toBe('pending');
    expect(job?.originalName).toBe(name);
    expect(job?.originalMime).toBe(mime);
    expect(job?.originalPath).toBe(`uploads/${body.job_id}.${ext}`);
    expect(existsSync(join(config.storagePath, `uploads/${body.job_id}.${ext}`))).toBe(true);
    expect(await uploadsDir(config)).toEqual([`${body.job_id}.${ext}`]);
    expect(enqueued).toEqual([body.job_id]);
  });

  it('accepts an APNG (file-type reports image/apng) stored as png', async () => {
    const res = await postFile(await makeApng(64, 48), 'anim.png');

    expect(res.statusCode).toBe(202);
    const id = res.json<{ job_id: string }>().job_id;
    const job = await repo.find(id);
    expect(job?.originalMime).toBe('image/png');
    expect(job?.originalPath).toBe(`uploads/${id}.png`);
    expect(existsSync(join(config.storagePath, `uploads/${id}.png`))).toBe(true);
  });

  it('accepts uppercase and .jpeg extensions', async () => {
    for (const name of ['PHOTO.JPG', 'x.jpeg']) {
      const res = await postFile(await makeImage(10, 10, 'jpeg'), name);
      expect(res.statusCode).toBe(202);
      const id = res.json<{ job_id: string }>().job_id;
      expect(existsSync(join(config.storagePath, `uploads/${id}.jpg`))).toBe(true);
    }
  });

  it('keeps a non-ASCII original name', async () => {
    const res = await postFile(await makeImage(10, 10, 'jpeg'), 'фото 1.jpg');
    const job = await repo.find(res.json<{ job_id: string }>().job_id);
    expect(job?.originalName).toBe('фото 1.jpg');
  });

  it('missing file is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/images',
      headers: multipartHeaders,
      payload: `--${BOUNDARY}--\r\n`,
    });
    expect(res.statusCode).toBe(422);
    const msg = 'Please choose an image to upload.';
    expect(res.json()).toEqual({
      error: { code: 'validation_failed', message: msg, fields: { image: [msg] } },
    });
  });

  it('non-multipart request is a missing file', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/images', payload: { a: 1 } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });

  it('rejects file over 20 MB', async () => {
    const res = await post(multipartBody(Buffer.alloc(20 * MB + 1, 1), 'big.jpg', 'image/jpeg'));
    expect(res.statusCode).toBe(422);
    const msg = 'File is larger than 20 MB.';
    expect(res.json()).toEqual({
      error: { code: 'validation_failed', message: msg, fields: { image: [msg] } },
    });
    expect(await jobCount()).toEqual({ n: 0 });
    expect(enqueued).toEqual([]);
  });

  it('rejects wrong type', async () => {
    const res = await postFile(await makeImage(10, 10, 'gif'), 'anim.gif');
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(TYPE_MSG);
  });

  it('rejects text file named .jpg', async () => {
    const res = await post(multipartBody(Buffer.from('not an image '.repeat(100)), 'sneaky.jpg', 'image/jpeg'));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { fields: { image: string[] } } }>().error.fields.image[0]).toBe(TYPE_MSG);
    expect(await uploadsDir(config)).toEqual([]);
  });

  it('queue down marks failed and returns 503', async () => {
    const down = appWith(config, repo, () => Promise.reject(new Error('redis down')));
    const res = await down.inject({
      method: 'POST',
      url: '/api/images',
      headers: multipartHeaders,
      payload: multipartBody(await readFile(await makeImage(10, 10, 'png')), 'a.png'),
    });
    await down.close();

    expect(res.statusCode).toBe(503);
    const err = res.json<{ error: { code: string; message: string; job_id: string } }>().error;
    expect(err.code).toBe('queue_unavailable');
    expect(err.message).toBe('The processing service is temporarily unavailable. Please try again shortly.');
    const job = await repo.find(err.job_id);
    expect(job?.status).toBe('failed');
    expect(job?.errorCode).toBe('queue_unavailable');
  });

  it('real Redis down returns 503 within 2.5 s', async () => {
    const queue = createQueue({ ...config, redis: { host: '127.0.0.1', port: 1 } }, 'images-down', () => undefined);
    const real = appWith(config, repo, (id) => enqueue(queue, id));
    const payload = multipartBody(await readFile(await makeImage(10, 10, 'png')), 'a.png');
    const started = Date.now();
    const res = await real.inject({ method: 'POST', url: '/api/images', headers: multipartHeaders, payload });
    const elapsed = Date.now() - started;
    await real.close();
    await queue.close();

    expect(res.statusCode).toBe(503);
    expect(elapsed).toBeLessThan(2500);
    const id = res.json<{ error: { job_id: string } }>().error.job_id;
    expect((await repo.find(id))?.status).toBe('failed');
  });
});

describe('upload limits and cleanup', () => {
  it('body over 26 MB returns 413 file_too_large', async () => {
    const res = await post(Buffer.alloc(1024), { 'content-length': String(26 * MB + 1) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: { code: 'file_too_large', message: 'File is larger than 20 MB.' } });
  });

  it('over-limit upload leaves no file in uploads/', async () => {
    const res = await post(multipartBody(Buffer.alloc(21 * MB, 1), 'big.jpg', 'image/jpeg'));
    expect(res.statusCode).toBe(422);
    expect(await uploadsDir(config)).toEqual([]);
  });

  it('aborted upload leaves no file and no row', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const { head } = multipartParts('a.jpg', 'image/jpeg');
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/api/images',
      headers: { ...multipartHeaders, 'content-length': String(5 * MB) },
    });
    req.on('error', () => undefined);
    req.write(head);
    req.write(Buffer.alloc(256 * 1024, 1));
    await new Promise((r) => setTimeout(r, 300));
    expect((await uploadsDir(config)).length).toBe(1); // the .part file exists mid-upload
    const closed = new Promise((r) => req.once('close', r));
    req.destroy();
    await closed;
    await new Promise((r) => setTimeout(r, 300));

    expect(await uploadsDir(config)).toEqual([]);
    expect(await jobCount()).toEqual({ n: 0 });
    expect(enqueued).toEqual([]);
  });
});

describe('sanitiseName', () => {
  it('strips path and control characters', () => {
    expect(sanitiseName('../../etc/pa\u0001sswd.jpg')).toBe('passwd.jpg');
    expect(sanitiseName('C:\\Users\\me\\a.png')).toBe('a.png');
  });
  it('limits to 200 characters', () => {
    expect(sanitiseName('a'.repeat(300))).toHaveLength(200);
  });

  it('trims whitespace exposed by truncation but not otherwise', () => {
    const name = 'a'.repeat(199) + ' ' + 'b'.repeat(5);
    expect(name).toHaveLength(205);
    expect(sanitiseName(name)).toBe('a'.repeat(199));
    expect(sanitiseName('keep trailing ')).toBe('keep trailing ');
  });
  it('falls back to image', () => {
    expect(sanitiseName('\u0001')).toBe('image');
    expect(sanitiseName('')).toBe('image');
  });
  it('is applied to the stored name', async () => {
    const res = await postFile(await makeImage(10, 10, 'jpeg'), `../../etc/${'x'.repeat(300)}.jpg`);
    const job = await repo.find(res.json<{ job_id: string }>().job_id);
    expect(job?.originalName).toBe('x'.repeat(200));
  });
});
