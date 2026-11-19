import { useCallback, useEffect, useState } from 'react'
import { ApiError, getJob } from '../api/client'
import type { Job } from '../api/types'
import { pollWithBackoff } from '../lib/pollWithBackoff'

export interface JobStatusState {
  job: Job | null
  /** The last poll failed (network / 5xx); polling continues with backoff. */
  connectionLost: boolean
  /** The server doesn't know this job (404); polling stopped. */
  notFound: boolean
  /** Polling stopped after the time limit; `refresh` starts it again. */
  gaveUp: boolean
  refresh: () => void
}

type Sample = Job | 'not_found'

/** Polls a job's status until it is completed or failed. */
export function useJobStatus(jobId: string | null): JobStatusState {
  const [job, setJob] = useState<Job | null>(null)
  const [connectionLost, setConnectionLost] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [gaveUp, setGaveUp] = useState(false)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    setJob(null)
    setConnectionLost(false)
    setNotFound(false)
    setGaveUp(false)
  }, [jobId])

  useEffect(() => {
    if (!jobId) return

    const fetchSample = async (): Promise<Sample> => {
      try {
        return await getJob(jobId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return 'not_found'
        throw error
      }
    }

    return pollWithBackoff<Sample>(fetchSample, {
      isDone: (s) => s === 'not_found' || s.status === 'completed' || s.status === 'failed',
      onValue: (s) => {
        setConnectionLost(false)
        if (s === 'not_found') setNotFound(true)
        else setJob(s)
      },
      onError: () => setConnectionLost(true),
      onGiveUp: () => setGaveUp(true),
    })
  }, [jobId, generation])

  const refresh = useCallback(() => {
    setGaveUp(false)
    setGeneration((g) => g + 1)
  }, [])

  return { job, connectionLost, notFound, gaveUp, refresh }
}
