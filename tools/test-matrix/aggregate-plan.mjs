const excludedFromAggregate = (tier) => tier.localOnly === true
  || tier.nightlyOnly === true
  || tier.manualOnly === true

function byTierId(matrix) {
  return new Map((matrix.tiers ?? []).map((tier) => [tier.id, tier]))
}

export function parseAggregateCommand(command) {
  const match = /^node tools\/run-test-matrix\.mjs aggregate ([a-z0-9][a-z0-9-]*)(?:\s|$)/u.exec(String(command ?? ''))
  return match ? { kind: 'aggregate', target: match[1] } : null
}

export function buildAggregatePlan(matrix, target) {
  const errors = []
  const authority = matrix.aggregateAuthorities?.[target]
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    return { errors: [`unknown aggregate authority: ${target}`] }
  }
  if (authority.id !== target) errors.push(`${target}.id must equal its aggregate authority key`)
  if (authority.commandKind !== 'aggregate') errors.push(`${target}.commandKind must be aggregate`)
  if (typeof authority.ciJob !== 'string' || !authority.ciJob.trim()) {
    errors.push(`${target}.ciJob must name the aggregate CI job`)
  }
  if (typeof authority.outputReceiptSchema !== 'string' || !authority.outputReceiptSchema.trim()) {
    errors.push(`${target}.outputReceiptSchema must be declared`)
  }
  if (!Array.isArray(authority.inputReceiptSchemas) || authority.inputReceiptSchemas.length === 0
    || authority.inputReceiptSchemas.some((schema) => typeof schema !== 'string' || !schema.trim())) {
    errors.push(`${target}.inputReceiptSchemas must declare structured receipt inputs`)
  }

  const selectedTiers = (matrix.tiers ?? []).filter((tier) => tier.ciJob === authority.ciJob && !excludedFromAggregate(tier))
  if (selectedTiers.length === 0) errors.push(`${target} selects no non-excluded tiers for ciJob ${authority.ciJob}`)
  if (selectedTiers.some((tier) => (tier.executionMode ?? 'execute') !== 'summary')) {
    errors.push(`${target} aggregate authority may select summary tiers only`)
  }
  const selectedTierIds = selectedTiers.map((tier) => tier.id).sort()
  if (!Array.isArray(authority.summaryTierIds) || authority.summaryTierIds.length === 0) {
    errors.push(`${target}.summaryTierIds must declare the selected summary tiers`)
  } else if (JSON.stringify(selectedTierIds) !== JSON.stringify([...authority.summaryTierIds].sort())) {
    errors.push(`${target}.summaryTierIds must exactly match its non-excluded selected tiers`)
  }

  const tiers = byTierId(matrix)
  const dependencyJobs = new Set()
  const receiptInputs = new Set()
  for (const tier of selectedTiers) {
    for (const dependencyId of tier.dependsOn ?? []) {
      const dependency = tiers.get(dependencyId)
      if (!dependency) {
        errors.push(`${tier.id} depends on missing tier ${dependencyId}`)
        continue
      }
      if (dependency.ciJob === authority.ciJob) continue
      dependencyJobs.add(dependency.ciJob)
      for (const evidence of [...(dependency.artifacts ?? []), ...(dependency.evidence ?? [])]) {
        if (typeof evidence === 'string' && evidence.trim()) receiptInputs.add(evidence)
      }
    }
  }
  if (dependencyJobs.size === 0) errors.push(`${target} must resolve at least one dependency job`)
  if (receiptInputs.size === 0) errors.push(`${target} must resolve declared receipt or artifact inputs`)

  return {
    schema: 'fsusblog.ci.aggregate-plan.v2',
    target,
    authorityId: target,
    ciJob: authority.ciJob,
    selectedTierIds,
    dependencyJobs: [...dependencyJobs].sort(),
    requiredReceiptInputs: [...receiptInputs].sort(),
    outputReceiptSchema: authority.outputReceiptSchema,
    artifactOnly: true,
    executesTestCommands: false,
    errors
  }
}
