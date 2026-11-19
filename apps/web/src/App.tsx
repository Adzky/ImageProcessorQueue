import { useEffect, useState } from 'react'
import { ApiError, uploadImage } from './api/client'
import { Dropzone } from './components/Dropzone'
import { JobCard } from './components/JobCard'
import { useJobStatus } from './hooks/useJobStatus'
import { loadCurrentJob, saveCurrentJob, type StoredJob } from './lib/currentJobStorage'
import { formatBytes } from './lib/format'

const TITLE = 'Image Processor'

export default function App() {
  // Restored on reload: the job keeps running on the server, so we just resume polling.
  const [current, setCurrentState] = useState<StoredJob | null>(loadCurrentJob)
  const setCurrent = (job: StoredJob | null) => {
    saveCurrentJob(job)
    setCurrentState(job)
  }
  const [uploading, setUploading] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const status = useJobStatus(current?.jobId ?? null)

  const jobStatus = status.job?.status
  const announcement =
    jobStatus === 'completed' ? 'Your image is ready to download.' : jobStatus === 'failed' ? 'Processing failed.' : ''

  useEffect(() => {
    document.title = jobStatus === 'completed' ? `✓ Ready — ${TITLE}` : jobStatus === 'failed' ? `✗ Failed — ${TITLE}` : TITLE
  }, [jobStatus])

  const startUpload = async (file: File) => {
    setUploadError(null)
    setUploading(file)
    setUploadProgress(0)
    try {
      const accepted = await uploadImage(file, setUploadProgress)
      setCurrent({ jobId: accepted.job_id, fileName: file.name, fileSize: file.size })
    } catch (error) {
      setUploadError(error instanceof ApiError ? error.message : 'Upload failed. Please try again.')
    } finally {
      setUploading(null)
    }
  }

  const reset = () => {
    setCurrent(null)
    setUploadError(null)
  }

  return (
    <main className="page">
      <header className="page__header">
        <h1>Image Processor</h1>
        <p className="muted">
          Upload a photo and get back a WebP, resized to at most 1280px on the longest side. Processing happens in a
          background worker, so the upload is acknowledged right away.
        </p>
      </header>

      {!current && (
        <Dropzone disabled={uploading !== null} onFile={startUpload} error={uploadError} />
      )}

      {uploading && (
        <div className="card">
          <p>
            <strong>{uploading.name}</strong> <span className="muted">· {formatBytes(uploading.size)}</span>
          </p>
          <progress className="progress" max={1} value={uploadProgress} aria-label="Upload progress" />
          <p className="muted">Uploading… {Math.round(uploadProgress * 100)}%</p>
        </div>
      )}

      {current && (
        <JobCard
          jobId={current.jobId}
          fileName={current.fileName}
          fileSize={current.fileSize}
          job={status.job}
          connectionLost={status.connectionLost}
          notFound={status.notFound}
          gaveUp={status.gaveUp}
          onRefresh={status.refresh}
          onReset={reset}
        />
      )}

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </main>
  )
}
