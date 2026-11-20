import { z } from 'zod';

const LOG_LEVELS = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
  silent: 'silent',
  // Laravel (Monolog) names, since the root .env feeds both stacks.
  notice: 'info',
  warning: 'warn',
  critical: 'fatal',
  alert: 'fatal',
  emergency: 'fatal',
} as const;

const logLevel = z
  .string()
  .min(1)
  .default('info')
  .transform((value, ctx) => {
    const level = new Map<string, string>(Object.entries(LOG_LEVELS)).get(value.toLowerCase());
    if (level === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid LOG_LEVEL ${value}; use one of ${Object.keys(LOG_LEVELS).join(', ')}`,
      });
      return z.NEVER;
    }
    return level;
  });

const int = (fallback: number) => z.coerce.number().int().default(fallback);

const envSchema = z.object({
  IMAGE_MAX_UPLOAD_KB: int(20480),
  IMAGE_MAX_DIMENSION: int(1280),
  IMAGE_QUALITY: int(80),
  IMAGE_MAX_PIXELS: int(50_000_000),
  IMAGE_STALE_AFTER_SECONDS: int(600),
  IMAGE_LOST_AFTER_SECONDS: int(3600),
  IMAGE_RETENTION_HOURS: int(24),
  IMAGE_PROCESSING_DELAY_MS: int(0),
  IMAGE_STORAGE_PATH: z.string().min(1).default('/app/storage/images'),
  DB_HOST: z.string().min(1).default('localhost'),
  DB_PORT: int(5432),
  DB_DATABASE: z.string().min(1).default('images'),
  DB_USERNAME: z.string().min(1).default('images'),
  DB_PASSWORD: z.string().default('secret'),
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: int(6379),
  LOG_LEVEL: logLevel,
  RUN_MIGRATIONS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export interface Config {
  maxUploadBytes: number;
  maxDimension: number;
  quality: number;
  maxPixels: number;
  staleAfterSeconds: number;
  lostAfterSeconds: number;
  retentionHours: number;
  processingDelayMs: number;
  storagePath: string;
  db: { host: string; port: number; database: string; user: string; password: string };
  redis: { host: string; port: number };
  logLevel: string;
  runMigrations: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);

  return {
    maxUploadBytes: e.IMAGE_MAX_UPLOAD_KB * 1024,
    maxDimension: e.IMAGE_MAX_DIMENSION,
    quality: e.IMAGE_QUALITY,
    maxPixels: e.IMAGE_MAX_PIXELS,
    staleAfterSeconds: e.IMAGE_STALE_AFTER_SECONDS,
    lostAfterSeconds: e.IMAGE_LOST_AFTER_SECONDS,
    retentionHours: e.IMAGE_RETENTION_HOURS,
    processingDelayMs: e.IMAGE_PROCESSING_DELAY_MS,
    storagePath: e.IMAGE_STORAGE_PATH,
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      database: e.DB_DATABASE,
      user: e.DB_USERNAME,
      password: e.DB_PASSWORD,
    },
    redis: { host: e.REDIS_HOST, port: e.REDIS_PORT },
    logLevel: e.LOG_LEVEL,
    runMigrations: e.RUN_MIGRATIONS,
  };
}
