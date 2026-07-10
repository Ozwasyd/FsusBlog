function positiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
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
  const limit = positiveInteger(maxParallel)
  if (!limit) throw new Error('maxParallel must be a positive integer')
  if (typeof execute !== 'function') throw new Error('execute must be a function')

  const states = new Map(steps.map((step) => [step.id, 'pending']))
  const failures = []
  const active = new Map()

  const start = (step, index) => {
    states.set(step.id, 'running')
    const current = Promise.resolve()
      .then(() => execute(step))
      .then(
        () => states.set(step.id, 'success'),
        (reason) => {
          states.set(step.id, 'failure')
          failures.push({ index, step, reason })
        }
      )
      .finally(() => active.delete(step.id))
    active.set(step.id, current)
  }

  while ([...states.values()].some((state) => state === 'pending' || state === 'running')) {
    let admitted = false
    while (active.size < limit) {
      const index = steps.findIndex((step) => states.get(step.id) === 'pending'
        && (step.dependsOn ?? []).every((dependency) => states.get(dependency) === 'success'))
      if (index < 0) break
      start(steps[index], index)
      admitted = true
    }

    if (active.size > 0) {
      await Promise.race(active.values())
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
