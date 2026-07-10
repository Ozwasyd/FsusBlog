function positiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function finiteNonNegative(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a finite non-negative number`)
  return parsed
}

function finitePositive(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a finite positive number`)
  return parsed
}

function exclusiveResourceList(value, name) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)

  const resources = value.map((resource) => String(resource).trim())
  if (resources.some((resource) => resource.length === 0)) {
    throw new Error(`${name} must contain non-empty resource names`)
  }
  if (new Set(resources).size !== resources.length) {
    throw new Error(`${name} must not contain duplicate resource names`)
  }
  return resources
}

function stepLabel(step, index) {
  const id = step && typeof step === 'object' ? String(step.id ?? '').trim() : ''
  return id || `index ${index}`
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return {
      maxParallel: positiveInteger(options, 'maxParallel'),
      cpuUnits: Number.POSITIVE_INFINITY,
      memoryGiB: Number.POSITIVE_INFINITY,
      allowedExclusiveResources: null,
      getStepResources: (step) => step?.resources ?? {},
    }
  }

  const maxParallel = positiveInteger(options.maxParallel, 'maxParallel')
  const cpuUnits = options.cpuUnits === undefined
    ? Number.POSITIVE_INFINITY
    : finitePositive(options.cpuUnits, 'cpuUnits')
  const memoryGiB = options.memoryGiB === undefined
    ? Number.POSITIVE_INFINITY
    : finitePositive(options.memoryGiB, 'memoryGiB')
  const exclusiveResources = options.exclusiveResources === undefined
    ? null
    : exclusiveResourceList(options.exclusiveResources, 'exclusiveResources')
  const getStepResources = options.getStepResources ?? ((step) => step?.resources ?? {})
  if (typeof getStepResources !== 'function') throw new Error('getStepResources must be a function')

  return {
    maxParallel,
    cpuUnits,
    memoryGiB,
    allowedExclusiveResources: exclusiveResources === null ? null : new Set(exclusiveResources),
    getStepResources,
  }
}

function normalizeRequests(steps, options) {
  return steps.map((step, index) => {
    const raw = options.getStepResources(step, index) ?? {}
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`resources for step "${stepLabel(step, index)}" must be an object`)
    }

    const cpuUnits = finiteNonNegative(raw.cpuUnits ?? 0, `cpuUnits for step "${stepLabel(step, index)}"`)
    const memoryGiB = finiteNonNegative(raw.memoryGiB ?? 0, `memoryGiB for step "${stepLabel(step, index)}"`)
    const exclusiveResources = exclusiveResourceList(
      raw.exclusiveResources,
      `exclusiveResources for step "${stepLabel(step, index)}"`
    )

    if (cpuUnits > options.cpuUnits) {
      throw new Error(
        `step "${stepLabel(step, index)}" requests ${cpuUnits} cpuUnits, exceeding wave capacity ${options.cpuUnits}`
      )
    }
    if (memoryGiB > options.memoryGiB) {
      throw new Error(
        `step "${stepLabel(step, index)}" requests ${memoryGiB} memoryGiB, exceeding wave capacity ${options.memoryGiB}`
      )
    }
    if (options.allowedExclusiveResources) {
      const unknown = exclusiveResources.find((resource) => !options.allowedExclusiveResources.has(resource))
      if (unknown) {
        throw new Error(`step "${stepLabel(step, index)}" requests unknown exclusive resource "${unknown}"`)
      }
    }

    return {
      step,
      index,
      cpuUnits,
      memoryGiB,
      exclusiveResources,
      exclusive: exclusiveResources.length > 0,
    }
  })
}

function fitsCapacity(request, activeCount, usedCpuUnits, usedMemoryGiB, options) {
  if (activeCount >= options.maxParallel) return false
  if (request.exclusive && activeCount > 0) return false
  return usedCpuUnits + request.cpuUnits <= options.cpuUnits
    && usedMemoryGiB + request.memoryGiB <= options.memoryGiB
}

/**
 * Executes one wave with worker, CPU and memory admission control.
 *
 * A step may declare `{ resources: { cpuUnits, memoryGiB, exclusiveResources } }`.
 * A non-empty `exclusiveResources` list makes that step globally exclusive within
 * the wave. Once an exclusive step reaches the head of the queue, later work is
 * not admitted until it has run, so exclusive work cannot be starved.
 */
export async function executeResourceAwareWave(steps, options, execute) {
  if (!Array.isArray(steps)) throw new Error('steps must be an array')
  if (typeof execute !== 'function') throw new Error('execute must be a function')

  const normalizedOptions = normalizeOptions(options)
  const requests = normalizeRequests(steps, normalizedOptions)
  if (requests.length === 0) return

  let nextIndex = 0
  let usedCpuUnits = 0
  let usedMemoryGiB = 0
  const failures = []
  const active = new Map()

  const start = (request) => {
    usedCpuUnits += request.cpuUnits
    usedMemoryGiB += request.memoryGiB

    const settled = Promise.resolve()
      .then(() => execute(request.step))
      .then(
        () => ({ status: 'fulfilled' }),
        (reason) => ({ status: 'rejected', reason })
      )
      .then((outcome) => {
        usedCpuUnits = Math.max(0, usedCpuUnits - request.cpuUnits)
        usedMemoryGiB = Math.max(0, usedMemoryGiB - request.memoryGiB)
        active.delete(request.index)
        if (outcome.status === 'rejected') {
          failures.push({ index: request.index, step: request.step, reason: outcome.reason })
        }
        return outcome
      })

    active.set(request.index, settled)
  }

  while (nextIndex < requests.length || active.size > 0) {
    let admitted = false

    while (nextIndex < requests.length) {
      const request = requests[nextIndex]
      const activeExclusive = [...active.keys()].some((index) => requests[index].exclusive)
      if (activeExclusive || !fitsCapacity(
        request,
        active.size,
        usedCpuUnits,
        usedMemoryGiB,
        normalizedOptions
      )) break

      nextIndex += 1
      start(request)
      admitted = true
      if (request.exclusive) break
    }

    if (nextIndex >= requests.length && active.size === 0) break
    if (active.size === 0 && !admitted) {
      const request = requests[nextIndex]
      throw new Error(`step "${stepLabel(request.step, request.index)}" cannot be admitted within wave capacity`)
    }

    await Promise.race(active.values())
  }

  failures.sort((left, right) => left.index - right.index)
  if (failures.length === 1) throw failures[0].reason
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `wave failed in ${failures.length} steps: ${failures.map((failure) => stepLabel(failure.step, failure.index)).join(', ')}`
    )
  }
}

export async function executeLimitedWave(steps, maxParallelOrOptions, execute) {
  return executeResourceAwareWave(steps, maxParallelOrOptions, execute)
}
