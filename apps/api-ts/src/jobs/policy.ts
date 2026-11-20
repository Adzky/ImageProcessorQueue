/** Deliveries allowed per job, counting both retries and redeliveries after a worker crash. */
export const MAX_TRIES = 3;

/** Wait before retry 1 and retry 2. */
export const BACKOFF_MS = [5000, 15000] as const;
