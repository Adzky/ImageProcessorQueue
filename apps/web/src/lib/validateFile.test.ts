import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, validateFile } from './validateFile'

function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('validateFile', () => {
  it.each([
    ['a.jpg', 'image/jpeg'],
    ['a.png', 'image/png'],
    ['a.webp', 'image/webp'],
  ])('accepts %s', (name, type) => {
    expect(validateFile(fakeFile(name, type, 1000))).toBeNull()
  })

  it('accepts an uppercase extension when the browser reports no type', () => {
    expect(validateFile(fakeFile('PHOTO.JPG', '', 1000))).toBeNull()
  })

  it('rejects other image types', () => {
    expect(validateFile(fakeFile('a.gif', 'image/gif', 1000))).toBe('File must be a JPG, PNG or WebP image.')
  })

  it('rejects unknown files without a type', () => {
    expect(validateFile(fakeFile('notes.txt', '', 1000))).toBe('File must be a JPG, PNG or WebP image.')
  })

  it('accepts exactly 20 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024)
    expect(validateFile(fakeFile('a.jpg', 'image/jpeg', MAX_UPLOAD_BYTES))).toBeNull()
  })

  it('rejects 20 MB + 1 byte', () => {
    expect(validateFile(fakeFile('a.jpg', 'image/jpeg', MAX_UPLOAD_BYTES + 1))).toBe('File is larger than 20 MB.')
  })
})
