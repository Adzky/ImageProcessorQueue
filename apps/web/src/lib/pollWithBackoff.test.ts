import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextDelay, pollWithBackoff } from './pollWithBackoff'

describe('nextDelay', () => {
  const mid = () => 0.5 // no jitter

  it('grows by 1.5x from 500ms', () => {
    expect([0, 1, 2].map((a) => nextDelay(a, mid))).toEqual([500, 750, 1125])
  })

  it('caps at 5s', () => {
    expect(nextDelay(20, mid)).toBe(5000)
  })

  it('applies ±20% jitter', () => {
    expect(nextDelay(0, () => 0)).toBe(400)
    expect(nextDelay(0, () => 1)).toBe(600)
  })
})

/** Minimal stand-in for `document` so visibility can be toggled. */
function fakeDoc() {
  const target = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState }
  target.visibilityState = 'visible'
  return {
    doc: target as unknown as Document,
    setHidden(hidden: boolean) {
      target.visibilityState = hidden ? 'hidden' : 'visible'
      target.dispatchEvent(new Event('visibilitychange'))
    },
  }
}

describe('pollWithBackoff', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const base = () => ({
    isDone: (v: string) => v === 'done',
    onValue: vi.fn(),
    onError: vi.fn(),
    onGiveUp: vi.fn(),
    random: () => 0.5,
  })

  it('waits for the first delay, then polls until done', async () => {
    const values = ['pending', 'processing', 'done']
    const fetchFn = vi.fn(async () => values.shift()!)
    const opts = base()
    pollWithBackoff(fetchFn, opts)

    await vi.advanceTimersByTimeAsync(499)
    expect(fetchFn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(750 + 1125)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(opts.onValue.mock.calls.map((c) => c[0])).toEqual(['pending', 'processing', 'done'])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('reports errors and keeps backing off', async () => {
    const fetchFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('done')
    const opts = base()
    pollWithBackoff(fetchFn, opts)

    await vi.advanceTimersByTimeAsync(500)
    expect(opts.onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(750)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(opts.onValue).toHaveBeenCalledWith('done')
  })

  it('pauses while the tab is hidden and polls immediately on return', async () => {
    const { doc, setHidden } = fakeDoc()
    const fetchFn = vi.fn(async () => 'pending')
    pollWithBackoff(fetchFn, { ...base(), doc })

    await vi.advanceTimersByTimeAsync(500)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    setHidden(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('gives up after the time limit', async () => {
    const fetchFn = vi.fn(async () => 'pending')
    const opts = { ...base(), giveUpAfterMs: 10_000 }
    pollWithBackoff(fetchFn, opts)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(opts.onGiveUp).toHaveBeenCalledTimes(1)
    const calls = fetchFn.mock.calls.length

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFn).toHaveBeenCalledTimes(calls)
  })

  it('cancel stops future fetches', async () => {
    const fetchFn = vi.fn(async () => 'pending')
    const cancel = pollWithBackoff(fetchFn, base())

    await vi.advanceTimersByTimeAsync(500)
    cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('stops when the fetch function says to stop', async () => {
    const fetchFn = vi.fn(async () => 'gone')
    const opts = { ...base(), isDone: (v: string) => v === 'gone' }
    pollWithBackoff(fetchFn, opts)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
