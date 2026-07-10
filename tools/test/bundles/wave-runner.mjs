export async function executeLimitedWave(steps, maxParallel, execute) {
  const limit = Number.parseInt(String(maxParallel), 10)
  if (!Number.isInteger(limit) || limit < 1) throw new Error('maxParallel must be a positive integer')
  if (!Array.isArray(steps)) throw new Error('steps must be an array')
  if (typeof execute !== 'function') throw new Error('execute must be a function')

  let nextIndex = 0
  const workerCount = Math.min(limit, steps.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < steps.length) {
      const step = steps[nextIndex]
      nextIndex += 1
      await execute(step)
    }
  })
  const results = await Promise.allSettled(workers)
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
}
