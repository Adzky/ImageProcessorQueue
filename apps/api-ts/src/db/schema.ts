import {
  bigint,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import type { ImageErrorCode } from '../jobs/errors.js';
import type { JobStatus } from '../jobs/status.js';

const ts = (name: string) => timestamp(name, { precision: 0, mode: 'date' });

export const imageJobs = pgTable(
  'image_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => v7()),
    status: varchar('status', { length: 16 }).$type<JobStatus>().notNull().default('pending'),

    originalName: varchar('original_name', { length: 255 }).notNull(),
    originalMime: varchar('original_mime', { length: 32 }).notNull(),
    originalSize: bigint('original_size', { mode: 'number' }).notNull(),
    originalPath: varchar('original_path', { length: 255 }).notNull(),
    originalWidth: integer('original_width'),
    originalHeight: integer('original_height'),

    resultPath: varchar('result_path', { length: 255 }),
    resultSize: bigint('result_size', { mode: 'number' }),
    resultWidth: integer('result_width'),
    resultHeight: integer('result_height'),

    // Queue attempt number of the delivery that currently owns the job (claim token).
    attempts: smallint('attempts').notNull().default(0),

    errorCode: varchar('error_code', { length: 32 }).$type<ImageErrorCode>(),
    errorMessage: text('error_message'),

    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    failedAt: ts('failed_at'),
    expiredAt: ts('expired_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('image_jobs_status_index').on(t.status)],
);

export type ImageJob = typeof imageJobs.$inferSelect;
export type NewJob = typeof imageJobs.$inferInsert;
