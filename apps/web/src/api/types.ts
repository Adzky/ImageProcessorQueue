export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed'

/** Mirrors GET /api/images/{id}. */
export interface Job {
  job_id: string
  status: JobStatus
  attempts: number
  original: {
    name: string
    mime: string
    size: number
    width: number | null
    height: number | null
  }
  result: { size: number; width: number; height: number } | null
  download_url: string | null
  error: { code: string; message: string } | null
  expired: boolean
  created_at: string
  started_at: string | null
  completed_at: string | null
  failed_at: string | null
}

export interface UploadAccepted {
  job_id: string
  status: 'pending'
  status_url: string
}
