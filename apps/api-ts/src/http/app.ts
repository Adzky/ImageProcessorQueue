import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { JobRepository } from '../jobs/repository.js';
import { apiError, INTERNAL_MESSAGE, NOT_FOUND_MESSAGE, TOO_LARGE_MESSAGE } from './errors.js';
import { imageRoutes } from './routes/images.js';

/** Bodies above this are refused before reading (20 MB file plus multipart overhead headroom). */
const MAX_BODY_BYTES = 26 * 1024 * 1024;

const httpErrorShape = z.object({ statusCode: z.number().optional(), message: z.string().optional() });

export interface AppDeps {
  config: Config;
  repo: JobRepository;
  enqueue: (id: string) => Promise<void>;
  logger?: FastifyServerOptions['logger'];
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  app.addHook('onRequest', async (request, reply) => {
    const length = Number(request.headers['content-length']);
    if (length > MAX_BODY_BYTES) {
      reply.header('Connection', 'close');
      return apiError(reply, 'file_too_large', TOO_LARGE_MESSAGE, 413);
    }
    return undefined;
  });

  void app.register(multipart, {
    limits: { fileSize: deps.config.maxUploadBytes, files: 1 },
    throwFileSizeLimit: false,
  });

  app.setNotFoundHandler((_request, reply) => apiError(reply, 'not_found', NOT_FOUND_MESSAGE, 404));

  app.setErrorHandler((error, request, reply) => {
    const known = httpErrorShape.safeParse(error);
    const status = known.success ? (known.data.statusCode ?? 500) : 500;
    if (status === 413) return apiError(reply, 'file_too_large', TOO_LARGE_MESSAGE, 413);
    if (status < 500) {
      const message = known.success ? known.data.message : undefined;
      return apiError(reply, 'http_error', message ?? 'Request failed.', status);
    }
    request.log.error({ err: error }, 'Unhandled error');
    return apiError(reply, 'internal_error', INTERNAL_MESSAGE, 500);
  });

  app.get('/up', () => ({ status: 'ok' }));
  void app.register(
    (api, _opts, done) => {
      imageRoutes(api, deps);
      done();
    },
    { prefix: '/api' },
  );

  return app;
}
