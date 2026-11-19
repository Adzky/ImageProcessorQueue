export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp)$/i

/**
 * Instant client-side check before uploading. The server re-validates (and sniffs the
 * real content), so this only exists to give fast feedback.
 * Returns an error message, or null when the file looks acceptable.
 */
export function validateFile(file: File): string | null {
  const typeOk = file.type ? ACCEPTED_TYPES.includes(file.type) : ACCEPTED_EXTENSIONS.test(file.name)
  if (!typeOk) return 'File must be a JPG, PNG or WebP image.'
  if (file.size > MAX_UPLOAD_BYTES) return 'File is larger than 20 MB.'
  return null
}
