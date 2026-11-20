import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { JobRepository } from './jobs/repository.js';
import { startScheduler } from './maintenance/schedule.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const database = createDb(config, (err) => {
  logger.error({ err }, 'Postgres pool error');
});
const scheduler = startScheduler({
  db: database.db,
  repo: new JobRepository(database.db),
  config,
  logger,
});

logger.info('Image scheduler started');

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'Image scheduler stopping');
  scheduler.stop();
  await database.close();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((err: unknown) => {
      logger.error({ err }, 'Image scheduler failed to stop cleanly');
      process.exit(1);
    });
  });
}
