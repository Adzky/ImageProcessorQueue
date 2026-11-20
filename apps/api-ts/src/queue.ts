import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import type { Config } from './config.js';
import { handleDelivery, MAX_TRIES, retryDelay, type DeliveryDeps } from './jobs/process-job.js';

export const QUEUE_NAME = 'images';

const ENQUEUE_TIMEOUT_MS = 2000;

const jobData = z.object({ imageJobId: z.string() });

export type ImageJobData = z.infer<typeof jobData>;

/**
 * Producer side. Fails fast instead of queueing commands while Redis is unreachable, so an
 * upload can answer 503 within ~2 s rather than hang.
 */
export function createQueue(
  config: Config,
  name: string = QUEUE_NAME,
  onError: (err: Error) => void = (err) => {
    console.error('Queue producer error', err);
  },
): Queue<ImageJobData> {
  const queue = new Queue<ImageJobData>(name, {
    connection: {
      host: config.redis.host,
      port: config.redis.port,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    },
  });
  // Without a listener a Redis connection error is thrown as an unhandled 'error' event.
  queue.on('error', onError);
  return queue;
}

/**
 * `attempts` is only a ceiling: the 3-delivery limit is enforced in `handleDelivery`, because
 * BullMQ's `attemptsMade` does not count redeliveries of stalled jobs.
 */
export async function enqueue(queue: Queue<ImageJobData>, id: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(ENQUEUE_TIMEOUT_MS)} ms adding job to the queue`));
    }, ENQUEUE_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      queue.add(
        'process-image',
        { imageJobId: id },
        { jobId: id, attempts: MAX_TRIES + 1, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: 1000 },
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Consumer side: one job at a time, the delivery number (`attemptsStarted`) is the claim token. */
export function createWorker(deps: DeliveryDeps, config: Config, name: string = QUEUE_NAME): Worker {
  const worker = new Worker(name, (job) => handleDelivery(deps, jobData.parse(job.data), job.attemptsStarted), {
    connection: { host: config.redis.host, port: config.redis.port },
    concurrency: 1,
    maxStalledCount: MAX_TRIES,
    settings: { backoffStrategy: retryDelay },
  });
  worker.on('error', (err) => {
    deps.logger.error({ err }, 'Queue worker error');
  });
  return worker;
}
