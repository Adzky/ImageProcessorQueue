import type { ImageJob } from '../db/schema.js';
import { toLaravelJson } from '../jobs/time.js';

export interface ImageJobResource {
  job_id: string;
  status: string;
  attempts: number;
  original: { name: string; mime: string; size: number; width: number | null; height: number | null };
  result: { size: number | null; width: number | null; height: number | null } | null;
  download_url: string | null;
  error: { code: string | null; message: string | null } | null;
  expired: boolean;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
}

/** Same keys and nulling rules as ImageJobResource.php. */
export function toResource(job: ImageJob): ImageJobResource {
  const completed = job.status === 'completed';
  const expired = job.expiredAt !== null;

  return {
    job_id: job.id,
    status: job.status,
    attempts: job.attempts,
    original: {
      name: job.originalName,
      mime: job.originalMime,
      size: job.originalSize,
      width: job.originalWidth,
      height: job.originalHeight,
    },
    result: completed ? { size: job.resultSize, width: job.resultWidth, height: job.resultHeight } : null,
    download_url: completed && !expired ? `/api/images/${job.id}/download` : null,
    error: job.status === 'failed' ? { code: job.errorCode, message: job.errorMessage } : null,
    expired,
    created_at: toLaravelJson(job.createdAt),
    started_at: toLaravelJson(job.startedAt),
    completed_at: toLaravelJson(job.completedAt),
    failed_at: toLaravelJson(job.failedAt),
  };
}
