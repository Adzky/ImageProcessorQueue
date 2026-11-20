import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../../src/config.js';
import { buildApp } from '../../src/http/app.js';
import type { JobRepository } from '../../src/jobs/repository.js';
import { makeTempDir } from './images.js';

export const BOUNDARY = '----testboundary7MA4YWxkTrZu0gW';

/** Multipart head/tail around a file part, so callers can stream the body. */
export function multipartParts(filename: string, mime: string, field = 'image'): { head: Buffer; tail: Buffer } {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    'utf8',
  );
  return { head, tail: Buffer.from(`\r\n--${BOUNDARY}--\r\n`) };
}

export function multipartBody(content: Buffer, filename: string, mime = 'application/octet-stream'): Buffer {
  const { head, tail } = multipartParts(filename, mime);
  return Buffer.concat([head, content, tail]);
}

export const multipartHeaders = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

export async function testConfig(): Promise<Config> {
  return loadConfig({ ...process.env, IMAGE_STORAGE_PATH: await makeTempDir() });
}

export function appWith(
  config: Config,
  repo: JobRepository,
  enqueue: (id: string) => Promise<void>,
): FastifyInstance {
  return buildApp({ config, repo, enqueue });
}

export async function uploadsDir(config: Config): Promise<string[]> {
  try {
    return await readdir(join(config.storagePath, 'uploads'));
  } catch {
    return [];
  }
}
