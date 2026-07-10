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
  const completed = new Set()
  const active = new Set()
  let failure = null

  await new Promise((resolve, reject) => {
    const schedule = () => {
      if (failure) {
        if (active.size === 0) reject(failure)
        return
      }

      while (active.size < limit) {
        const next = steps.find((step) => states.get(step.id) === 'pending'
          && (step.dependsOn ?? []).every((dependency) => completed.has(dependency)))
        if (!next) break
        states.set(next.id, 'running')
        const current = Promise.resolve()
          .then(() => execute(next))
          .then(() => {
            states.set(next.id, 'success')
            completed.add(next.id)
          })
          .catch((error) => {
            states.set(next.id, 'failure')
            failure = error
          })
          .finally(() => {
            active.delete(current)
            schedule()
          })
        active.add(current)
      }

      if (active.size === 0) {
        if (completed.size === steps.length) resolve()
        else reject(new Error('step DAG has unresolved dependencies or a cycle'))
      }
    }
    schedule()
  })
}
