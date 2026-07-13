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
