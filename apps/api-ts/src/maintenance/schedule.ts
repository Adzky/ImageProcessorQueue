import { Cron } from 'croner';
import type { Logger } from 'pino';
import { cleanupExpiredJobs } from './cleanup.js';
import type { MaintenanceDeps } from './deps.js';
import { reapStaleJobs } from './reap-stale.js';

export const SCHEDULE = { reap: '* * * * *', cleanup: '0 * * * *' } as const;

/** Runs both tasks on their cron schedule; `protect` skips a tick while the previous run is active. */
export function startScheduler(deps: MaintenanceDeps & { logger: Logger }): { stop(): void } {
  const { logger } = deps;

  const schedule = (name: string, pattern: string, task: () => Promise<number>, label: string) =>
    new Cron(pattern, { name, protect: true, timezone: 'UTC' }, async () => {
      try {
        logger.info(`${label} ${String(await task())} job(s).`);
      } catch (err) {
        logger.error({ err }, `${name} failed`);
      }
    });

  const jobs = [
    schedule('images:reap-stale', SCHEDULE.reap, () => reapStaleJobs(deps), 'Reaped'),
    schedule('images:cleanup', SCHEDULE.cleanup, () => cleanupExpiredJobs(deps), 'Expired'),
  ];

  return {
    stop() {
      for (const job of jobs) job.stop();
    },
  };
}
