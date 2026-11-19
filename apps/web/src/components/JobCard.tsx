import { useEffect, useState } from 'react'
import type { Job } from '../api/types'
import { formatBytes, percentSaved } from '../lib/format'
import { StatusTimeline } from './StatusTimeline'

const MAX_ATTEMPTS = 3

interface Props {
  jobId: string
  fileName: string
  fileSize: number
  job: Job | null
  connectionLost: boolean
  notFound: boolean
  gaveUp: boolean
  onRefresh: () => void
  onReset: () => void
}

function useElapsedSeconds(since: string | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  return since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : 0
}

export function JobCard({ jobId, fileName, fileSize, job, connectionLost, notFound, gaveUp, onRefresh, onReset }: Props) {
  const [copied, setCopied] = useState(false)
  const status = job?.status ?? 'pending'
  const running = status === 'pending' || status === 'processing'
  const elapsed = useElapsedSeconds(job?.created_at ?? null, running && !gaveUp)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(jobId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked: the ID is still selectable text
    }
  }

  return (
    <section className="card" aria-labelledby="job-title">
      <header className="card__header">
        <h2 id="job-title" className="card__title" title={fileName}>
          {fileName}
        </h2>
        <span className="muted">{formatBytes(fileSize)}</span>
      </header>

      <p className="job-id">
        <span className="muted">Job</span> <code>{jobId}</code>
        <button type="button" className="small-button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </p>

      {notFound ? (
        <p className="notice notice--error">This job wasn't found on the server.</p>
      ) : (
        <>
          <StatusTimeline status={status} />

          {running && !gaveUp && (
            <p className="muted">
              {status === 'pending' ? 'Waiting for a worker…' : 'Processing…'} {elapsed}s
              {job && job.attempts > 1 && ` (attempt ${job.attempts} of ${MAX_ATTEMPTS})`}
            </p>
          )}

          {connectionLost && running && (
            <p className="notice notice--warn">Connection lost, retrying…</p>
          )}

          {gaveUp && running && (
            <p className="notice notice--warn">
              Still processing — check back later.{' '}
              <button type="button" className="link-button" onClick={onRefresh}>
                Refresh
              </button>
            </p>
          )}

          {status === 'completed' && job?.result && (
            job.expired || !job.download_url ? (
              <p className="notice notice--warn">This result has expired. Please upload the image again.</p>
            ) : (
              <div className="result">
                <p>
                  <strong>Ready:</strong> {job.result.width}×{job.result.height} · {formatBytes(job.result.size)}{' '}
                  <span className="muted">(−{percentSaved(job.original.size, job.result.size)}%)</span>
                </p>
                <a className="primary-button" href={job.download_url} download>
                  Download WebP
                </a>
              </div>
            )
          )}

          {status === 'failed' && (
            <p className="notice notice--error" role="alert">
              {job?.error?.message ?? 'Processing failed. Please try again.'}
            </p>
          )}
        </>
      )}

      {(!running || notFound) && (
        <button type="button" className="secondary-button" onClick={onReset}>
          {status === 'failed' || notFound ? 'Try another image' : 'Process another image'}
        </button>
      )}
    </section>
  )
}
