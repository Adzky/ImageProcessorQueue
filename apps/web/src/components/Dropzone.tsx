import { useRef, useState, type DragEvent } from 'react'
import { validateFile } from '../lib/validateFile'

interface Props {
  disabled: boolean
  onFile: (file: File) => void
  /** Error from the server for the last upload attempt, shown under the drop area. */
  error: string | null
}

export function Dropzone({ disabled, onFile, error }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const accept = (file: File | undefined) => {
    if (!file || disabled) return
    const problem = validateFile(file)
    setLocalError(problem)
    if (!problem) onFile(file)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    accept(e.dataTransfer.files[0])
  }

  const message = localError ?? error

  return (
    <div>
      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}${disabled ? ' dropzone--disabled' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className="dropzone__title">
          Drop an image here or{' '}
          <button type="button" className="link-button" disabled={disabled} onClick={() => input.current?.click()}>
            choose a file
          </button>
        </p>
        <p className="dropzone__hint">JPG, PNG or WebP · up to 20 MB</p>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          disabled={disabled}
          onChange={(e) => {
            accept(e.target.files?.[0])
            e.target.value = '' // allow choosing the same file again
          }}
        />
      </div>
      {message && (
        <p className="notice notice--error" role="alert">
          {message}
        </p>
      )}
    </div>
  )
}
