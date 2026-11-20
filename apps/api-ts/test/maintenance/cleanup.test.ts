import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { ImageJob } from '../../src/db/schema.js';
import { pino } from 'pino';
import { cleanupExpiredJobs } from '../../src/maintenance/cleanup.js';
import { makeJob, testDb } from '../support/db.js';
import { cleanupImages, makeTempDir } from '../support/images.js';

const { db, repo } = testDb();

afterEach(cleanupImages);

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function put(root: string, rel: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, 'x');
}

async function setup(status: ImageJob['status'], createdAt: Date) {
  const root = await makeTempDir();
  const id = crypto.randomUUID();
  const job = await makeJob({
    id,
    status,
    createdAt,
    originalPath: `uploads/${id}.jpg`,
    resultPath: status === 'completed' ? `results/${id}.webp` : null,
  });
  await put(root, `uploads/${id}.jpg`);
  if (job.resultPath !== null) await put(root, job.resultPath);
  const config = loadConfig({ IMAGE_STORAGE_PATH: root });
  return { job, root, run: () => cleanupExpiredJobs({ db, repo, config }) };
}

describe('cleanupExpiredJobs', () => {
  it('expires old completed jobs and deletes files', async () => {
    const { job, root, run } = await setup('completed', hoursAgo(25));

    expect(await run()).toBe(1);

    const found = await repo.find(job.id);
    expect(found?.expiredAt).not.toBeNull();
    expect(found?.status).toBe('completed');
    expect(await exists(join(root, job.originalPath))).toBe(false);
    expect(await exists(join(root, `results/${job.id}.webp`))).toBe(false);
  });

  it('expires old failed jobs', async () => {
    const { job, root, run } = await setup('failed', hoursAgo(30));
    await run();
    expect((await repo.find(job.id))?.expiredAt).not.toBeNull();
    expect(await exists(join(root, job.originalPath))).toBe(false);
  });

  it('leaves recent jobs alone', async () => {
    const { job, root, run } = await setup('completed', hoursAgo(23));
    expect(await run()).toBe(0);
    expect((await repo.find(job.id))?.expiredAt).toBeNull();
    expect(await exists(join(root, `results/${job.id}.webp`))).toBe(true);
  });

  it('never touches unfinished jobs', async () => {
    const pending = await setup('pending', hoursAgo(72));
    const processing = await setup('processing', hoursAgo(72));
    expect(await pending.run()).toBe(0);
    expect((await repo.find(pending.job.id))?.expiredAt).toBeNull();
    expect((await repo.find(processing.job.id))?.expiredAt).toBeNull();
    expect(await exists(join(pending.root, pending.job.originalPath))).toBe(true);
  });

  it('logs and still expires a row whose file cannot be deleted, then continues', async () => {
    const root = await makeTempDir();
    const make = async (hours: number) => {
      const id = crypto.randomUUID();
      const job = await makeJob({
        id,
        status: 'failed',
        createdAt: hoursAgo(hours),
        originalPath: `uploads/${id}.jpg`,
        resultPath: null,
      });
      return job;
    };
    const poison = await make(48);
    const healthy = await make(47);
    // A non-empty directory where the file should be makes rm fail with something other than ENOENT.
    await put(root, `${poison.originalPath}/inner`);
    await put(root, healthy.originalPath);

    const logger = pino({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const config = loadConfig({ IMAGE_STORAGE_PATH: root });

    expect(await cleanupExpiredJobs({ db, repo, config, logger })).toBe(2);

    expect((await repo.find(poison.id))?.expiredAt).not.toBeNull();
    expect((await repo.find(healthy.id))?.expiredAt).not.toBeNull();
    expect(await exists(join(root, healthy.originalPath))).toBe(false);
    expect(await exists(join(root, poison.originalPath))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ job_id: poison.id }), expect.any(String));
  });

  it('tolerates missing files and is idempotent', async () => {
    const { job, root, run } = await setup('completed', hoursAgo(48));
    await rm(join(root, `results/${job.id}.webp`));
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
  });
});
