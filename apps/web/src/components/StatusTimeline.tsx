import type { JobStatus } from '../api/types'

const ORDER: Record<JobStatus, number> = { pending: 0, processing: 1, completed: 2, failed: 2 }

export function StatusTimeline({ status }: { status: JobStatus }) {
  const current = ORDER[status]
  const steps = ['Pending', 'Processing', status === 'failed' ? 'Failed' : 'Completed']

  return (
    <ol className="timeline" aria-label={`Status: ${status}`}>
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? (status === 'failed' ? 'failed' : 'current') : 'todo'
        const finished = i === 2 && status === 'completed'
        return (
          <li key={label} className={`timeline__step timeline__step--${finished ? 'done' : state}`}>
            <span className="timeline__dot" aria-hidden="true" />
            {label}
          </li>
        )
      })}
    </ol>
  )
}
