function positiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function finiteCapacity(value, fallback, name) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a finite positive number`)
  return parsed
}

function normalizeOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const maxParallel = positiveInteger(value)
    if (!maxParallel) throw new Error('maxParallel must be a positive integer')
    return {
      maxParallel,
      cpuUnits: Number.POSITIVE_INFINITY,
      memoryGiB: Number.POSITIVE_INFINITY,
      exclusiveResources: null
    }
  }
  const maxParallel = positiveInteger(value.maxParallel)
  if (!maxParallel) throw new Error('maxParallel must be a positive integer')
  const exclusiveResources = value.exclusiveResources === undefined
    ? null
    : new Set(value.exclusiveResources.map((resource) => String(resource).trim()))
  if (exclusiveResources?.has('')) throw new Error('exclusiveResources must contain non-empty resource names')
  return {
    maxParallel,
    cpuUnits: finiteCapacity(value.cpuUnits, Number.POSITIVE_INFINITY, 'cpuUnits'),
    memoryGiB: finiteCapacity(value.memoryGiB, Number.POSITIVE_INFINITY, 'memoryGiB'),
    exclusiveResources
  }
}

function normalizeRequests(steps, options) {
  return steps.map((step, index) => {
    const resources = step?.resources ?? {}
    const cpuUnits = Number(resources.cpuUnits ?? 0)
    const memoryGiB = Number(resources.memoryGiB ?? 0)
    const exclusiveResources = (resources.exclusiveResources ?? []).map((resource) => String(resource).trim())
    if (!Number.isFinite(cpuUnits) || cpuUnits < 0) throw new Error(`cpuUnits for step "${step.id}" must be non-negative`)
    if (!Number.isFinite(memoryGiB) || memoryGiB < 0) throw new Error(`memoryGiB for step "${step.id}" must be non-negative`)
    if (cpuUnits > options.cpuUnits) throw new Error(`step "${step.id}" requests ${cpuUnits} cpuUnits, exceeding DAG capacity ${options.cpuUnits}`)
    if (memoryGiB > options.memoryGiB) throw new Error(`step "${step.id}" requests ${memoryGiB} memoryGiB, exceeding DAG capacity ${options.memoryGiB}`)
    if (exclusiveResources.some((resource) => !resource)) throw new Error(`exclusiveResources for step "${step.id}" must be non-empty`)
    if (options.exclusiveResources) {
      const unknown = exclusiveResources.find((resource) => !options.exclusiveResources.has(resource))
      if (unknown) throw new Error(`step "${step.id}" requests unknown exclusive resource "${unknown}"`)
    }
    return { step, index, cpuUnits, memoryGiB, exclusive: exclusiveResources.length > 0 }
  })
}

export function validateStepDag(steps) {
  if (!Array.isArray(steps)) return ['steps must be an array']
  const errors = []
  const ids = new Set()
  for (const step of steps) {
    if (typeof step?.id !== 'string' || !step.id) {
      errors.push('step id must be non-empty')
      continue
    }
    if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`)
    ids.add(step.id)
  }
  for (const step of steps) {
    for (const dependency of step?.dependsOn ?? []) {
      if (!ids.has(dependency)) errors.push(`${step.id} depends on unknown dependency: ${dependency}`)
    }
  }
  return errors
}

export async function executeStepDag(steps, maxParallel, execute) {
  const errors = validateStepDag(steps)
  if (errors.length > 0) throw new Error(errors.join('; '))
  const options = normalizeOptions(maxParallel)
  if (typeof execute !== 'function') throw new Error('execute must be a function')

  const requests = normalizeRequests(steps, options)
  const states = new Map(steps.map((step) => [step.id, 'pending']))
  const failures = []
  const active = new Map()
  let usedCpuUnits = 0
  let usedMemoryGiB = 0

  const start = (request) => {
    const { step, index } = request
    states.set(step.id, 'running')
    usedCpuUnits += request.cpuUnits
    usedMemoryGiB += request.memoryGiB
    const current = Promise.resolve()
      .then(() => execute(step))
      .then(
        () => states.set(step.id, 'success'),
        (reason) => {
          states.set(step.id, 'failure')
          failures.push({ index, step, reason })
        }
      )
      .finally(() => {
        usedCpuUnits = Math.max(0, usedCpuUnits - request.cpuUnits)
        usedMemoryGiB = Math.max(0, usedMemoryGiB - request.memoryGiB)
        active.delete(step.id)
      })
    active.set(step.id, { request, current })
  }

  while ([...states.values()].some((state) => state === 'pending' || state === 'running')) {
    let admitted = false
    while (active.size < options.maxParallel) {
      const ready = requests.filter(({ step }) => states.get(step.id) === 'pending'
        && (step.dependsOn ?? []).every((dependency) => states.get(dependency) === 'success'))
      if (ready.length === 0) break
      const activeExclusive = [...active.values()].some(({ request }) => request.exclusive)
      if (activeExclusive) break
      const exclusiveIndex = ready.findIndex((request) => request.exclusive)
      const candidates = exclusiveIndex < 0 ? ready : ready.slice(0, exclusiveIndex + 1)
      let selected = null
      for (const request of candidates) {
        if (request.exclusive) {
          if (active.size === 0) selected = request
          break
        }
        if (usedCpuUnits + request.cpuUnits <= options.cpuUnits
          && usedMemoryGiB + request.memoryGiB <= options.memoryGiB) {
          selected = request
          break
        }
      }
      if (!selected) break
      start(selected)
      admitted = true
      if (selected.exclusive) break
    }

    if (active.size > 0) {
      await Promise.race([...active.values()].map(({ current }) => current))
      continue
    }

    const blocked = steps.filter((step) => states.get(step.id) === 'pending'
      && (step.dependsOn ?? []).some((dependency) => ['failure', 'blocked'].includes(states.get(dependency))))
    if (blocked.length > 0) {
      for (const step of blocked) states.set(step.id, 'blocked')
      continue
    }
    if (!admitted) throw new Error('step DAG has unresolved dependencies or a cycle')
  }

  failures.sort((left, right) => left.index - right.index)
  if (failures.length === 1) throw failures[0].reason
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `step DAG failed in ${failures.length} independent branches: ${failures.map((failure) => failure.step.id).join(', ')}`
    )
  }
}
