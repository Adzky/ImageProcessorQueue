import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { JobRepository } from '../jobs/repository.js';

export interface MaintenanceDeps {
  db: Db;
  repo: JobRepository;
  config: Config;
}
