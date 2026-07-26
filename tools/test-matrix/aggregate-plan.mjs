import { validateCanonicalReceiptCommandSource } from './receipt-command-sources.mjs'

const excludedFromAggregate = (tier) => tier.nightlyOnly === true
  || tier.localOnly === true
  || tier.manualOnly === true

function byTierId(matrix) {
  return new Map((matrix.tiers ?? []).map((tier) => [tier.id, tier]))
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

function sameStrings(left, right) {
  return JSON.stringify(sortedUnique(left ?? [])) === JSON.stringify(sortedUnique(right ?? []))
}

export function parseAggregateCommand(command) {
  const match = /^node tools\/run-test-matrix\.mjs aggregate ([a-z0-9][a-z0-9-]*)\s*$/u.exec(String(command ?? ''))
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

  const tiers = byTierId(matrix)
  const declaredTierIds = authority.summaryTierIds
  if (!Array.isArray(declaredTierIds) || declaredTierIds.length === 0
    || declaredTierIds.some((tierId) => typeof tierId !== 'string' || !tierId.trim())) {
    errors.push(`${target}.summaryTierIds must declare the selected summary tiers`)
  }
  if (Array.isArray(declaredTierIds) && new Set(declaredTierIds).size !== declaredTierIds.length) {
    errors.push(`${target}.summaryTierIds must not contain duplicates`)
  }
  const selectedTiers = (declaredTierIds ?? []).map((tierId) => {
    const tier = tiers.get(tierId)
    if (!tier) errors.push(`${target}.summaryTierIds references unknown tier ${tierId}`)
    return tier
  }).filter(Boolean)
  if (selectedTiers.length === 0) errors.push(`${target} selects no declared summary tiers`)
  if (selectedTiers.some(excludedFromAggregate)) {
    errors.push(`${target} selects a tier excluded from aggregation`)
  }
  if (selectedTiers.some((tier) => tier.ciJob !== authority.ciJob)) {
    errors.push(`${target}.summaryTierIds must all use ciJob ${authority.ciJob}`)
  }
  if (selectedTiers.some((tier) => (tier.executionMode ?? 'execute') !== 'summary')) {
    errors.push(`${target} aggregate authority may select summary tiers only`)
  }
  for (const tier of selectedTiers) {
    if (tier.commandKind !== 'aggregate') errors.push(`${tier.id}.commandKind must be aggregate for authority ${target}`)
    if (tier.summaryAuthority !== target) errors.push(`${tier.id}.summaryAuthority must equal aggregate authority ${target}`)
    if (JSON.stringify(tier.summaryInputs) !== JSON.stringify(authority.inputReceiptSchemas)) {
      errors.push(`${tier.id}.summaryInputs must match aggregate authority ${target}`)
    }
    if (tier.outputReceiptSchema !== authority.outputReceiptSchema) {
      errors.push(`${tier.id}.outputReceiptSchema must match aggregate authority ${target}`)
    }
    const command = parseAggregateCommand(tier.command)
    if (!command || command.target !== target) {
      errors.push(`${tier.id}.command must invoke aggregate ${target}`)
    }
    if ((tier.executionDependsOn?.length ?? 0) > 0) {
      errors.push(`${tier.id}.executionDependsOn must be empty for artifact-only aggregate summaries`)
    }
  }
  const selectedTierIds = selectedTiers.map((tier) => tier.id).sort()

  const dependencyJobs = new Set()
  const receiptInputs = new Set()
  const dependencyReceipts = new Map()
  const selectedTierIdSet = new Set(selectedTierIds)
  for (const tier of selectedTiers) {
    for (const dependencyId of tier.requiresEvidenceFrom ?? []) {
      if (selectedTierIdSet.has(dependencyId)) {
        errors.push(`${tier.id}.requiresEvidenceFrom must not consume a tier selected by the same aggregate authority`)
        continue
      }
      const dependency = tiers.get(dependencyId)
      if (!dependency) {
        errors.push(`${tier.id}.requiresEvidenceFrom references missing tier ${dependencyId}`)
        continue
      }
      if (typeof dependency.outputReceiptSchema !== 'string' || !dependency.outputReceiptSchema.trim()) {
        errors.push(`${dependency.id}.outputReceiptSchema must declare the structured dependency output`)
      } else {
        dependencyReceipts.set(dependency.id, {
          tierId: dependency.id,
          jobId: dependency.ciJob,
          schema: dependency.outputReceiptSchema
        })
      }
      if (typeof dependency.ciJob !== 'string' || !dependency.ciJob.trim()) {
        errors.push(`${dependency.id}.ciJob must identify the dependency receipt job`)
      } else if (dependency.ciJob === authority.ciJob) {
        errors.push(`${tier.id}.requiresEvidenceFrom must not consume ${dependency.id} from the same aggregate CI job`)
      } else {
        dependencyJobs.add(dependency.ciJob)
      }
      for (const evidence of [...(dependency.artifacts ?? []), ...(dependency.evidence ?? [])]) {
        if (typeof evidence === 'string' && evidence.trim()) receiptInputs.add(evidence)
      }
    }
  }
  if (dependencyReceipts.size === 0) errors.push(`${target} must resolve at least one structured dependency receipt`)
  if (dependencyJobs.size === 0) errors.push(`${target} must resolve at least one external dependency job`)
  if (receiptInputs.size === 0) errors.push(`${target} must resolve declared receipt or artifact inputs`)
  const resolvedInputReceiptSchemas = sortedUnique([...dependencyReceipts.values()].map((receipt) => receipt.schema))
  if (!sameStrings(authority.inputReceiptSchemas, resolvedInputReceiptSchemas)) {
    errors.push(`${target}.inputReceiptSchemas must exactly match selected dependency outputs`)
  }

  return {
    schema: 'fsusblog.ci.aggregate-plan.v2',
    target,
    authorityId: target,
    ciJob: authority.ciJob,
    selectedTierIds,
    dependencyJobs: [...dependencyJobs].sort(),
    dependencyReceipts: [...dependencyReceipts.values()].sort((left, right) => left.tierId.localeCompare(right.tierId)),
    resolvedInputReceiptSchemas,
    requiredReceiptInputs: [...receiptInputs].sort(),
    outputReceiptSchema: authority.outputReceiptSchema,
    artifactOnly: true,
    executesTestCommands: false,
    errors
  }
}

export function buildReceiptPlan(matrix, target, options = {}) {
  const errors = []
  const authority = matrix.receiptAuthorities?.[target]
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    return { errors: [`unknown receipt authority: ${target}`] }
  }
  if (authority.id !== target) errors.push(`${target}.id must equal its receipt authority key`)
  if (authority.commandKind !== 'receipt') errors.push(`${target}.commandKind must be receipt`)
  const source = validateCanonicalReceiptCommandSource(authority.commandSourceId, {
    root: options.root
  })
  errors.push(...source.errors.map((error) => `${target}.commandSource: ${error}`))
  if (!source.contract || authority.command !== source.contract.command) {
    errors.push(`${target}.command must exactly match its canonical receipt command source`)
  }
  if (!Array.isArray(authority.summaryTierIds) || authority.summaryTierIds.length === 0) {
    errors.push(`${target}.summaryTierIds must declare receipt summary tiers`)
  }
  if (!Array.isArray(authority.inputTierIds) || authority.inputTierIds.length === 0) {
    errors.push(`${target}.inputTierIds must declare structured receipt producers`)
  }
  if (!Array.isArray(authority.inputReceiptSchemas) || authority.inputReceiptSchemas.length === 0) {
    errors.push(`${target}.inputReceiptSchemas must declare structured receipt inputs`)
  }
  if (typeof authority.outputReceiptSchema !== 'string' || !authority.outputReceiptSchema.trim()) {
    errors.push(`${target}.outputReceiptSchema must be declared`)
  }

  const tiers = byTierId(matrix)
  const selectedTiers = (authority.summaryTierIds ?? []).map((tierId) => {
    const tier = tiers.get(tierId)
    if (!tier) errors.push(`${target}.summaryTierIds references unknown tier ${tierId}`)
    return tier
  }).filter(Boolean)
  if (selectedTiers.length === 0) errors.push(`${target} selects no receipt summary tiers`)
  const inputTiers = (authority.inputTierIds ?? []).map((tierId) => {
    const tier = tiers.get(tierId)
    if (!tier) errors.push(`${target}.inputTierIds references unknown tier ${tierId}`)
    return tier
  }).filter(Boolean)
  if (selectedTiers.some((tier) => typeof tier.ciJob !== 'string' || !tier.ciJob.trim())
    || new Set(selectedTiers.map((tier) => tier.ciJob)).size !== 1) {
    errors.push(`${target}.summaryTierIds must resolve to one explicit CI job`)
  }
  if ((authority.inputTierIds ?? []).some((tierId) => (authority.summaryTierIds ?? []).includes(tierId))) {
    errors.push(`${target}.inputTierIds must not consume a tier selected by the same receipt authority`)
  }
  const resolvedInputReceiptSchemas = sortedUnique(inputTiers.map((tier) => tier.outputReceiptSchema).filter(Boolean))
  if (inputTiers.some((tier) => typeof tier.outputReceiptSchema !== 'string' || !tier.outputReceiptSchema.trim())) {
    errors.push(`${target}.inputTierIds must resolve structured outputReceiptSchema declarations`)
  }
  if (!sameStrings(authority.inputReceiptSchemas, resolvedInputReceiptSchemas)) {
    errors.push(`${target}.inputReceiptSchemas must exactly match selected structured outputs`)
  }
  for (const tier of selectedTiers) {
    if ((tier.executionMode ?? 'execute') !== 'summary') errors.push(`${tier.id}.executionMode must be summary`)
    if (tier.commandKind !== 'receipt') errors.push(`${tier.id}.commandKind must be receipt for authority ${target}`)
    if (tier.summaryAuthority !== target) errors.push(`${tier.id}.summaryAuthority must equal receipt authority ${target}`)
    if (tier.command !== authority.command) errors.push(`${tier.id}.command must match receipt authority ${target}`)
    if (!sameStrings(tier.summaryInputs, resolvedInputReceiptSchemas)) {
      errors.push(`${tier.id}.summaryInputs must exactly match selected structured outputs`)
    }
    if (tier.outputReceiptSchema !== authority.outputReceiptSchema) {
      errors.push(`${tier.id}.outputReceiptSchema must match receipt authority ${target}`)
    }
    if ((tier.executionDependsOn?.length ?? 0) > 0) {
      errors.push(`${tier.id}.executionDependsOn must be empty for receipt summaries`)
    }
    if (!sameStrings(tier.requiresEvidenceFrom, authority.inputTierIds)) {
      errors.push(`${tier.id}.requiresEvidenceFrom must exactly match receipt authority inputTierIds`)
    }
    if ((tier.services?.length ?? 0) > 0 || tier.requiresBootstrap !== 'none'
      || tier.requiresDotnet !== false || tier.requiresPlaywright !== 'none') {
      errors.push(`${tier.id} receipt summary must be no-service, no-bootstrap, Node-only finalization`)
    }
  }

  return {
    schema: 'fsusblog.ci.receipt-plan.v1',
    target,
    authorityId: target,
    commandSourceId: authority.commandSourceId,
    semanticKind: source.contract?.semanticKind ?? null,
    command: source.contract?.command ?? null,
    commandArgv: source.contract?.argv ? [...source.contract.argv] : [],
    permissionBoundary: source.contract?.permissions ?? null,
    commandSourceFiles: source.files,
    selectedTierIds: selectedTiers.map((tier) => tier.id).sort(),
    inputTierIds: inputTiers.map((tier) => tier.id).sort(),
    resolvedInputReceiptSchemas,
    outputReceiptSchema: authority.outputReceiptSchema,
    artifactOnly: true,
    executesTestCommands: false,
    errors
  }
}
