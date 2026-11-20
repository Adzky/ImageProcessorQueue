export const JobStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export function isTerminal(status: JobStatus): boolean {
  return status === JobStatus.Completed || status === JobStatus.Failed;
}
