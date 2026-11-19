import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCurrentJob, saveCurrentJob, STORAGE_KEY } from './currentJobStorage'

const job = { jobId: '01a1f600-f178-7687-ba34-35f3981eba49', fileName: 'photo.jpg', fileSize: 1234 }

describe('currentJobStorage', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips the current job', () => {
    saveCurrentJob(job)
    expect(loadCurrentJob()).toEqual(job)
  })

  it('returns null when nothing is stored', () => {
    expect(loadCurrentJob()).toBeNull()
  })

  it('clears with null', () => {
    saveCurrentJob(job)
    saveCurrentJob(null)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(loadCurrentJob()).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadCurrentJob()).toBeNull()
  })

  it('returns null for a wrongly shaped value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId: 42 }))
    expect(loadCurrentJob()).toBeNull()
  })

  it('survives storage that throws (private mode, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(loadCurrentJob()).toBeNull()
    expect(() => saveCurrentJob(job)).not.toThrow()
  })
})
