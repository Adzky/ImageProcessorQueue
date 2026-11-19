export const STORAGE_KEY = 'imageProcessor.currentJob'

export interface StoredJob {
  jobId: string
  fileName: string
  fileSize: number
}

function isStoredJob(value: unknown): value is StoredJob {
  const v = value as StoredJob | null
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.jobId === 'string' &&
    typeof v.fileName === 'string' &&
    typeof v.fileSize === 'number'
  )
}

/**
 * The job being watched, remembered across page reloads. The job lives on the server,
 * so a reload just resumes polling. Storage can be unavailable (private mode, blocked
 * site data), in which case this quietly does nothing.
 */
export function loadCurrentJob(): StoredJob | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isStoredJob(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveCurrentJob(job: StoredJob | null): void {
  try {
    if (job) localStorage.setItem(STORAGE_KEY, JSON.stringify(job))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable: resuming after reload just won't work
  }
}
