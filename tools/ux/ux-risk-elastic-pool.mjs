export async function executeElasticUxGroupPool(groups, {
  capacityProvider,
  execute,
  pollMs = 100
}) {
  if (!Array.isArray(groups) || groups.length === 0) throw new Error('UX elastic pool requires groups')
  if (typeof capacityProvider !== 'function') throw new Error('UX elastic pool requires capacityProvider')
  if (typeof execute !== 'function') throw new Error('UX elastic pool requires execute')

  const queue = [...groups]
  const active = new Set()
  const started = new Set()
  const completed = new Set()
  const failures = []
  let maximumWorkers = 0

  const start = (group, workerIndex) => {
    if (started.has(group.id)) throw new Error(`UX group started twice: ${group.id}`)
    started.add(group.id)
    const promise = Promise.resolve()
      .then(() => execute(group, workerIndex))
      .catch((error) => failures.push({ group, error }))
      .finally(() => {
        active.delete(promise)
        completed.add(group.id)
      })
    active.add(promise)
    maximumWorkers = Math.max(maximumWorkers, active.size)
  }

  while (queue.length > 0 || active.size > 0) {
    const requested = Number(capacityProvider())
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error(`UX elastic worker capacity must be a positive integer, got ${requested}`)
    }
    const capacity = Math.min(groups.length, requested)
    while (queue.length > 0 && active.size < capacity) {
      start(queue.shift(), started.size)
    }
    if (active.size === 0) continue
    await Promise.race([
      ...active,
      new Promise((resolve) => setTimeout(resolve, Math.max(10, pollMs)))
    ])
  }

  if (started.size !== groups.length || completed.size !== groups.length) {
    throw new Error(`UX elastic pool incomplete: started=${started.size} completed=${completed.size} planned=${groups.length}`)
  }
  if (failures.length === 1) throw failures[0].error
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `UX elastic pool failed in ${failures.length} groups: ${failures.map((failure) => failure.group.id).join(', ')}`
    )
  }
  return { maximumWorkers, startedGroupIds: [...started], completedGroupIds: [...completed] }
}

export async function executePersistentUxWorkerPool(groups, {
  capacityProvider,
  createWorker,
  destroyWorker,
  execute,
  classifyError = (error) => ({ retryable: error?.retryable === true }),
  maxCrashRetries = 1,
  pollMs = 100,
  signal
}) {
  if (!Array.isArray(groups) || groups.length === 0) throw new Error('UX persistent pool requires groups')
  if (typeof capacityProvider !== 'function') throw new Error('UX persistent pool requires capacityProvider')
  if (typeof createWorker !== 'function') throw new Error('UX persistent pool requires createWorker')
  if (typeof destroyWorker !== 'function') throw new Error('UX persistent pool requires destroyWorker')
  if (typeof execute !== 'function') throw new Error('UX persistent pool requires execute')
  if (!Number.isInteger(maxCrashRetries) || maxCrashRetries < 0) {
    throw new Error(`UX persistent pool maxCrashRetries must be a non-negative integer, got ${maxCrashRetries}`)
  }

  const queue = groups.map((group) => ({ group, crashAttempts: 0 }))
  const internalAbort = new AbortController()
  const poolSignal = signal
    ? AbortSignal.any([signal, internalAbort.signal])
    : internalAbort.signal
  const active = new Map()
  const completed = new Set()
  const failures = []
  const attempts = []
  const workerSummaries = []
  let nextWorkerIndex = 0
  let maximumWorkers = 0
  let browserLaunchCount = 0
  let retryCount = 0
  let firstGroupStartedAtMs = null
  const startedAtMs = Date.now()

  const requestedCapacity = () => {
    const requested = Number(capacityProvider())
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error(`UX persistent worker capacity must be a positive integer, got ${requested}`)
    }
    return Math.min(groups.length, requested)
  }

  const shouldRetire = (workerIndex) => {
    const ordered = [...active.keys()].sort((left, right) => left - right)
    return ordered.indexOf(workerIndex) >= requestedCapacity()
  }

  const runWorker = async (workerIndex) => {
    const summary = {
      workerIndex,
      browserLaunches: 0,
      groupAttempts: 0,
      completedGroupIds: [],
      retiredReason: 'queue-drained'
    }
    workerSummaries.push(summary)
    let worker
    let destroyed = false
    const cleanup = async (reason) => {
      if (destroyed || !worker) return
      destroyed = true
      summary.retiredReason = reason
      await destroyWorker(worker, reason)
    }
    const abortCleanup = () => { void cleanup('cancelled') }
    poolSignal.addEventListener('abort', abortCleanup, { once: true })
    try {
      if (poolSignal.aborted) throw abortError(poolSignal)
      worker = await createWorker(workerIndex)
      summary.browserLaunches += 1
      if (Number.isFinite(Number(worker?.launchDurationMs))) {
        summary.browserLaunchDurationMs = Number(worker.launchDurationMs)
      }
      browserLaunchCount += 1

      while (true) {
        if (poolSignal.aborted) throw abortError(poolSignal)
        if (shouldRetire(workerIndex)) {
          summary.retiredReason = 'capacity-shrink'
          break
        }
        if (queue.length === 0) break
        const entry = queue.shift()
        if (!entry || completed.has(entry.group.id)) continue
        if (firstGroupStartedAtMs === null) firstGroupStartedAtMs = Date.now()
        const attempt = entry.crashAttempts + 1
        summary.groupAttempts += 1
        const attemptEvidence = {
          groupId: entry.group.id,
          workerIndex,
          attempt,
          startedAt: new Date().toISOString(),
          status: 'running'
        }
        attempts.push(attemptEvidence)
        try {
          const executionResult = await execute(entry.group, worker, { workerIndex, attempt, signal: poolSignal })
          if (completed.has(entry.group.id)) {
            throw new Error(`UX group produced duplicate success receipt: ${entry.group.id}`)
          }
          completed.add(entry.group.id)
          summary.completedGroupIds.push(entry.group.id)
          attemptEvidence.status = 'passed'
          if (executionResult !== undefined) attemptEvidence.result = executionResult
          attemptEvidence.finishedAt = new Date().toISOString()
        } catch (error) {
          const classification = classifyError(error)
          attemptEvidence.status = classification.retryable ? 'worker-crash' : 'failed'
          attemptEvidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          attemptEvidence.finishedAt = new Date().toISOString()
          if (classification.retryable && entry.crashAttempts < maxCrashRetries && !poolSignal.aborted) {
            entry.crashAttempts += 1
            retryCount += 1
            queue.unshift(entry)
            summary.retiredReason = 'worker-crash'
            break
          }
          failures.push({ group: entry.group, error, classification })
          if (classification.retryable) {
            summary.retiredReason = 'worker-crash-retry-exhausted'
            break
          }
        }
      }
    } finally {
      poolSignal.removeEventListener('abort', abortCleanup)
      await cleanup(summary.retiredReason)
      active.delete(workerIndex)
    }
  }

  try {
    while (queue.length > 0 || active.size > 0) {
      if (poolSignal.aborted) throw abortError(poolSignal)
      const capacity = requestedCapacity()
      while (queue.length > 0 && active.size < capacity) {
        const workerIndex = nextWorkerIndex++
        const workerPromise = runWorker(workerIndex)
        active.set(workerIndex, workerPromise)
        maximumWorkers = Math.max(maximumWorkers, active.size)
      }
      if (active.size === 0) continue
      await Promise.race([
        ...active.values(),
        new Promise((resolve) => setTimeout(resolve, Math.max(10, pollMs)))
      ])
    }
  } catch (error) {
    internalAbort.abort(error)
    await Promise.allSettled(active.values())
    throw error
  } finally {
    if (poolSignal.aborted && active.size > 0) await Promise.allSettled(active.values())
  }

  if (completed.size + failures.length !== groups.length) {
    throw new Error(
      `UX persistent pool incomplete: passed=${completed.size} failed=${failures.length} planned=${groups.length}`
    )
  }
  if (failures.length === 1) throw failures[0].error
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `UX persistent pool failed in ${failures.length} groups: ${failures.map((failure) => failure.group.id).join(', ')}`
    )
  }
  return {
    maximumWorkers,
    browserLaunchCount,
    retryCount,
    startedGroupIds: [...new Set(attempts.map((attempt) => attempt.groupId))],
    completedGroupIds: [...completed],
    attempts,
    workers: workerSummaries,
    timeToFirstGroupMs: firstGroupStartedAtMs === null ? null : firstGroupStartedAtMs - startedAtMs
  }
}

function abortError(signal) {
  const error = new Error(signal?.reason ? `UX persistent pool cancelled: ${String(signal.reason)}` : 'UX persistent pool cancelled')
  error.name = 'AbortError'
  return error
}
