import { describe, expect, it, vi } from 'vitest'
import { ApiError, getJob, uploadImage } from './client'

/** Records the last XHR and lets the test answer it. */
class FakeXhr {
  static last: FakeXhr
  status = 0
  responseText = ''
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  method = ''
  url = ''
  body: unknown
  constructor() {
    FakeXhr.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader() {}
  send(body: unknown) {
    this.body = body
  }
  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body)
    this.onload?.()
  }
}

describe('getJob', () => {
  it('returns the job on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ job_id: 'abc', status: 'pending' }), { status: 200 })))

    await expect(getJob('abc')).resolves.toMatchObject({ job_id: 'abc', status: 'pending' })
    expect(fetch).toHaveBeenCalledWith('/api/images/abc', expect.anything())
  })

  it('maps an error body to ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Job not found.' } }), { status: 404 })),
    )

    const err = await getJob('abc').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'Job not found.' })
  })

  it('maps a network failure to network_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))

    await expect(getJob('abc')).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })
})

describe('uploadImage', () => {
  const file = () => new File(['x'], 'a.jpg', { type: 'image/jpeg' })

  it('posts multipart form data and resolves on 202', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const promise = uploadImage(file())

    expect(FakeXhr.last.method).toBe('POST')
    expect(FakeXhr.last.url).toBe('/api/images')
    expect((FakeXhr.last.body as FormData).get('image')).toBeInstanceOf(File)

    FakeXhr.last.respond(202, { job_id: 'j1', status: 'pending', status_url: '/api/images/j1' })
    await expect(promise).resolves.toEqual({ job_id: 'j1', status: 'pending', status_url: '/api/images/j1' })
  })

  it('reports upload progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const onProgress = vi.fn()
    const promise = uploadImage(file(), onProgress)

    FakeXhr.last.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 } as ProgressEvent)
    FakeXhr.last.respond(202, { job_id: 'j1', status: 'pending', status_url: '/x' })
    await promise

    expect(onProgress).toHaveBeenCalledWith(0.25)
  })

  it('maps 413 (empty body from the web server) to file_too_large', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const promise = uploadImage(file())

    FakeXhr.last.respond(413, '')
    await expect(promise).rejects.toMatchObject({ status: 413, code: 'file_too_large', message: 'File is larger than 20 MB.' })
  })

  it('surfaces the server validation message', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const promise = uploadImage(file())

    FakeXhr.last.respond(422, { error: { code: 'validation_failed', message: 'File must be a JPG, PNG or WebP image.' } })
    await expect(promise).rejects.toMatchObject({ status: 422, code: 'validation_failed', message: 'File must be a JPG, PNG or WebP image.' })
  })

  it('maps a network failure to network_error', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const promise = uploadImage(file())

    FakeXhr.last.onerror?.()
    await expect(promise).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })
})
