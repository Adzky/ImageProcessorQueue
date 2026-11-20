import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { JobRepository } from './jobs/repository.js';
import { createWorker } from './queue.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const database = createDb(config, (err) => {
  logger.error({ err }, 'Postgres pool error');
});
const worker = createWorker({ repo: new JobRepository(database.db), config, logger }, config);

logger.info('Image worker started');

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'Image worker stopping');
  await worker.close(); // waits for the job in progress to finish
  await database.close();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((err: unknown) => {
      logger.error({ err }, 'Image worker failed to stop cleanly');
      process.exit(1);
    });
  });
}
