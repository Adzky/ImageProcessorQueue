const INITIAL_MS = 500
const FACTOR = 1.5
const MAX_MS = 5000
const JITTER = 0.2

/**
 * Delay before poll number `attempt` (0-based): 500ms growing 1.5x per poll, capped at 5s,
 * with ±20% jitter so many open tabs don't poll in lockstep.
 */
export function nextDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_MS, INITIAL_MS * FACTOR ** attempt)
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()))
}

export interface PollOptions<T> {
  isDone: (value: T) => boolean
  onValue: (value: T) => void
  onError: (error: unknown) => void
  onGiveUp: () => void
  /** Stop polling after this long (default 10 minutes). */
  giveUpAfterMs?: number
  /** Injected for tests; defaults to the global document. */
  doc?: Document
  random?: () => number
}

/**
 * Polls `fetchFn` with exponential backoff until `isDone` returns true.
 *
 * - Errors are reported and polling keeps backing off (the server may be restarting).
 * - Nothing is scheduled while the tab is hidden; returning to the tab polls immediately.
 * - After `giveUpAfterMs`, polling stops and `onGiveUp` is called.
 *
 * Returns a function that cancels polling.
 */
export function pollWithBackoff<T>(fetchFn: () => Promise<T>, opts: PollOptions<T>): () => void {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined)
  const random = opts.random ?? Math.random

  let attempt = 0
  let stopped = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const isHidden = () => doc?.visibilityState === 'hidden'

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const stop = () => {
    stopped = true
    clearTimer()
    clearTimeout(giveUpTimer)
    doc?.removeEventListener('visibilitychange', onVisibilityChange)
  }

  const schedule = () => {
    if (stopped || isHidden()) return
    timer = setTimeout(tick, nextDelay(attempt, random))
  }

  async function tick() {
    timer = undefined
    inFlight = true
    try {
      const value = await fetchFn()
      if (stopped) return
      opts.onValue(value)
      if (opts.isDone(value)) {
        stop()
        return
      }
    } catch (error) {
      if (stopped) return
      opts.onError(error)
    } finally {
      inFlight = false
    }
    attempt++
    schedule()
  }

  function onVisibilityChange() {
    if (stopped) return
    if (isHidden()) {
      clearTimer()
    } else if (timer === undefined && !inFlight) {
      void tick()
    }
  }

  const giveUpTimer = setTimeout(() => {
    if (stopped) return
    stop()
    opts.onGiveUp()
  }, opts.giveUpAfterMs ?? 10 * 60 * 1000)

  doc?.addEventListener('visibilitychange', onVisibilityChange)
  schedule()

  return stop
}
