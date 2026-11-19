export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** Percentage of the original size saved by the result, rounded. */
export function percentSaved(original: number, result: number): number {
  if (original <= 0) return 0
  return Math.round((1 - result / original) * 100)
}
