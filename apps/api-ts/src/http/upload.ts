import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fileTypeFromFile } from 'file-type';
import { v7 as uuidv7 } from 'uuid';
import type { Config } from '../config.js';
import { errorMessage } from '../jobs/errors.js';
import type { JobRepository } from '../jobs/repository.js';
import { toLaravelJson } from '../jobs/time.js';
import { apiError, MISSING_MESSAGE, TOO_LARGE_MESSAGE, TYPE_MESSAGE, validationFailed } from './errors.js';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/apng': 'png', // file-type reports a PNG with an acTL chunk as APNG
  'image/webp': 'webp',
};

/** Stored mime for types that file-type reports under a more specific name. */
const STORED_MIME: Record<string, string> = { 'image/apng': 'image/png' };

export const MAX_NAME_LENGTH = 200;

/** Basename (either separator), control characters stripped, at most 200 characters, `image` fallback. */
export function sanitiseName(name: string): string {
  const unified = name.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = unified.slice(unified.lastIndexOf('/') + 1);
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = base.replace(/[\x00-\x1F\x7F]/gu, '');
  const chars = Array.from(clean === '' ? 'image' : clean);
  // Like Str::limit, trim trailing whitespace left by the cut (only when it cut anything).
  return chars.length > MAX_NAME_LENGTH ? chars.slice(0, MAX_NAME_LENGTH).join('').trimEnd() : chars.join('');
}

export interface UploadDeps {
  config: Config;
  repo: JobRepository;
  enqueue: (id: string) => Promise<void>;
}

type Outcome =
  | { kind: 'rejected'; message: string }
  | { kind: 'aborted' }
  | { kind: 'queue_down'; id: string }
  | { kind: 'accepted'; id: string; createdAt: Date };

/**
 * Streams the single `image` part to `uploads/<id>.part`, so nothing is buffered in memory.
 * Whatever happens, no temp or orphaned file survives this function, so the response is only
 * sent after cleanup has finished.
 */
async function store(request: FastifyRequest, upload: MultipartFile, deps: UploadDeps): Promise<Outcome> {
  const { config, repo, enqueue } = deps;
  const dir = join(config.storagePath, 'uploads');
  const id = uuidv7();
  const partPath = join(dir, `${id}.part`);
  let finalPath: string | undefined;

  // A client that disconnects mid-upload would otherwise leave the stream hanging half-written.
  const onClose = () => {
    if (!request.raw.complete) upload.file.destroy(new Error('Upload aborted'));
  };
  request.raw.once('close', onClose);

  try {
    try {
      await pipeline(upload.file, createWriteStream(partPath));
    } catch (err) {
      if (!request.raw.complete) return { kind: 'aborted' };
      throw err;
    }

    if (upload.file.truncated) return { kind: 'rejected', message: TOO_LARGE_MESSAGE };

    const type = await fileTypeFromFile(partPath);
    const ext = type === undefined ? undefined : EXTENSIONS[type.mime];
    if (type === undefined || ext === undefined) return { kind: 'rejected', message: TYPE_MESSAGE };

    const size = (await stat(partPath)).size;
    finalPath = join(dir, `${id}.${ext}`);
    await rename(partPath, finalPath);

    const job = await repo.insert({
      id,
      originalName: sanitiseName(upload.filename),
      originalMime: STORED_MIME[type.mime] ?? type.mime,
      originalSize: size,
      originalPath: `uploads/${id}.${ext}`,
    });
    finalPath = undefined; // the row now owns the file

    try {
      await enqueue(id);
    } catch (err) {
      request.log.error({ err, job_id: id }, 'Failed to enqueue image job');
      await repo.markFailed(id, 'queue_unavailable');
      return { kind: 'queue_down', id };
    }
    return { kind: 'accepted', id, createdAt: job.createdAt };
  } finally {
    request.raw.off('close', onClose);
    await rm(partPath, { force: true });
    if (finalPath !== undefined) await rm(finalPath, { force: true });
  }
}

export async function handleUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: UploadDeps,
): Promise<FastifyReply> {
  if (!request.isMultipart()) return validationFailed(reply, MISSING_MESSAGE);

  await mkdir(join(deps.config.storagePath, 'uploads'), { recursive: true });

  const upload = await request.file();
  if (upload?.fieldname !== 'image') {
    upload?.file.resume();
    return validationFailed(reply, MISSING_MESSAGE);
  }

  const outcome = await store(request, upload, deps);
  switch (outcome.kind) {
    case 'rejected':
      return validationFailed(reply, outcome.message);
    case 'aborted':
      return reply.code(400).send();
    case 'queue_down':
      return apiError(reply, 'queue_unavailable', errorMessage('queue_unavailable'), 503, { job_id: outcome.id });
    case 'accepted': {
      const statusUrl = `/api/images/${outcome.id}`;
      return reply.code(202).header('Location', statusUrl).send({
        job_id: outcome.id,
        status: 'pending',
        status_url: statusUrl,
        created_at: toLaravelJson(outcome.createdAt),
      });
    }
  }
}
