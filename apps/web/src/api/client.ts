import type { Job, UploadAccepted } from './types'

const BASE: string = import.meta.env.VITE_API_BASE_URL ?? '/api'

const TOO_LARGE = 'File is larger than 20 MB.'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function networkError(): ApiError {
  return new ApiError(0, 'network_error', "Couldn't reach the server. Check your connection and try again.")
}

/** Builds an ApiError from a non-2xx response body ({"error": {"code", "message"}}). */
function errorFrom(status: number, body: string): ApiError {
  if (status === 413) return new ApiError(413, 'file_too_large', TOO_LARGE)

  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } }
    if (parsed.error?.code) {
      return new ApiError(status, parsed.error.code, parsed.error.message ?? 'Request failed.')
    }
  } catch {
    // fall through: not JSON (proxy error page, empty body…)
  }
  return new ApiError(status, 'http_error', `The server responded with an error (${status}). Please try again.`)
}

/**
 * Uploads with XMLHttpRequest rather than fetch, because only XHR reports upload progress.
 * Resolves as soon as the server has stored the file and queued the job (202).
 */
export function uploadImage(file: File, onProgress?: (fraction: number) => void): Promise<UploadAccepted> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/images`)
    xhr.setRequestHeader('Accept', 'application/json')

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadAccepted)
        } catch {
          reject(errorFrom(xhr.status, ''))
        }
      } else {
        reject(errorFrom(xhr.status, xhr.responseText))
      }
    }
    xhr.onerror = () => reject(networkError())

    const form = new FormData()
    form.append('image', file)
    xhr.send(form)
  })
}

export async function getJob(id: string): Promise<Job> {
  let response: Response
  try {
    response = await fetch(`${BASE}/images/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  } catch {
    throw networkError()
  }

  const body = await response.text()
  if (!response.ok) throw errorFrom(response.status, body)
  return JSON.parse(body) as Job
}
