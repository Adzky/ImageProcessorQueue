import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { JobRepository } from './jobs/repository.js';
import { createQueue, enqueue } from './queue.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const database = createDb(config, (err) => {
  logger.error({ err }, 'Postgres pool error');
});
const queue = createQueue(config, undefined, (err) => {
  logger.error({ err }, 'Queue producer error');
});

if (config.runMigrations) await runMigrations(database.db);

const app = buildApp({
  config,
  repo: new JobRepository(database.db),
  enqueue: (id) => enqueue(queue, id),
  logger: { level: config.logLevel },
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'API stopping');
  await app.close();
  await queue.close();
  await database.close();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((err: unknown) => {
      logger.error({ err }, 'API failed to stop cleanly');
      process.exit(1);
    });
  });
}

await app.listen({ host: '0.0.0.0', port: 8000 });
