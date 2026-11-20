import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ImageJob } from '../../db/schema.js';
import { apiError, NOT_FOUND_MESSAGE } from '../errors.js';
import { toResource } from '../resource.js';
import { handleUpload, type UploadDeps } from '../upload.js';

// Any 8-4-4-4-12 hex id, like Laravel's whereUuid.
const params = z.object({ id: z.guid() });

/** pathinfo($name, PATHINFO_FILENAME).'.webp' */
function downloadName(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  return `${dot === -1 ? originalName : originalName.slice(0, dot)}.webp`;
}

/** rawurlencode: also escapes the characters encodeURIComponent leaves alone. */
function rawUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Like Symfony's makeDisposition: ASCII fallback plus `filename*` when it differs. */
export function contentDisposition(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replaceAll('%', '')
    .replace(/[/\\]/g, '_')
    .replaceAll('"', '\\"');
  const base = `attachment; filename="${fallback}"`;
  return fallback === filename ? base : `${base}; filename*=utf-8''${rawUrlEncode(filename)}`;
}

export function imageRoutes(app: FastifyInstance, deps: UploadDeps): void {
  const { config, repo } = deps;

  async function findJob(rawParams: unknown): Promise<ImageJob | undefined> {
    const parsed = params.safeParse(rawParams);
    return parsed.success ? repo.find(parsed.data.id.toLowerCase()) : undefined;
  }

  const notFound = (reply: FastifyReply) => apiError(reply, 'not_found', NOT_FOUND_MESSAGE, 404);

  app.post('/images', (request, reply) => handleUpload(request, reply, deps));

  app.get('/images/:id', async (request, reply) => {
    const job = await findJob(request.params);
    return job === undefined ? notFound(reply) : reply.send(toResource(job));
  });

  app.get('/images/:id/download', async (request, reply) => {
    const job = await findJob(request.params);
    if (job === undefined) return notFound(reply);

    if (job.expiredAt !== null) {
      return apiError(reply, 'expired', 'This result has expired. Please upload the image again.', 410);
    }
    if (job.status !== 'completed' || job.resultPath === null) {
      return apiError(reply, 'not_ready', `This image isn't ready yet (status: ${job.status}).`, 409);
    }

    const path = join(config.storagePath, job.resultPath);
    const { size } = await stat(path);
    return reply
      .header('Content-Type', 'image/webp')
      .header('Content-Length', size)
      .header('Content-Disposition', contentDisposition(downloadName(job.originalName)))
      .send(createReadStream(path));
  });
}
