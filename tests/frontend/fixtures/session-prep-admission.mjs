const POSTGRES_PIDS_PER_SESSION_SLOT = 4

export function resolveSessionPrepConcurrency(requestedConcurrency, postgresPids) {
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency <= 0) {
    throw new Error(`session prep requested concurrency must be a positive integer, got ${requestedConcurrency}`)
  }
  if (postgresPids?.max === null) return requestedConcurrency
  const current = Number(postgresPids?.current)
  const max = Number(postgresPids?.max)
  if (!Number.isInteger(current) || current < 0 || !Number.isInteger(max) || max <= 0 || current > max) {
    throw new Error(`invalid PostgreSQL PID snapshot: current=${postgresPids?.current} max=${postgresPids?.max}`)
  }
  const headroom = Math.max(0, max - current)
  const pidCapacity = Math.max(1, Math.floor(headroom / POSTGRES_PIDS_PER_SESSION_SLOT))
  return Math.min(requestedConcurrency, pidCapacity)
}
