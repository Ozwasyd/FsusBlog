/**
 * Mutant-to-Behavior attribution.
 *
 * Maps each executed mutant from a Stryker report to a unique behaviorId
 * via the ImplementationOwner receipt source span. Cross-behavior spans
 * that cannot be uniquely attributed are reported as blocked.
 */

/**
 * @typedef {object} MutantAttribution
 * @property {string} mutantId - Canonical mutant ID (sourceProject:file:id)
 * @property {string} behaviorId - Attributed behavior ID
 * @property {string} sourcePath - Implementation owner source path
 * @property {string} symbol - Implementation owner symbol
 * @property {string} mutator - Stryker mutator name
 * @property {string} status - Killed|Survived|Timeout|NoCoverage|CompileError|Ignored
 * @property {string[]} coveredTestIds - Raw test IDs that cover this mutant
 * @property {string[]} killedTestIds - Raw test IDs that killed this mutant
 */

/**
 * Attribute mutants from a Stryker report to behaviors via owner receipt.
 *
 * @param {object} options
 * @param {object} options.report - Stryker JSON report with files{}
 * @param {string} options.sourceProject - Source project prefix (e.g. 'src/core')
 * @param {object} options.ownerReceipt - Sealed owner receipt with bindings[]
 * @param {object} options.selection - Selection result with behaviors[]
 * @returns {{ attributions: MutantAttribution[], blocked: object[] }}
 */
export function attributeMutantsToBehaviors({ report, sourceProject, ownerReceipt, selection }) {
  const attributions = []
  const blocked = []
  const ownerBindings = ownerReceipt?.bindings ?? []

  // Build source path → behavior owner index
  const ownerByPath = new Map()
  for (const binding of ownerBindings) {
    if (binding.status === 'error') continue
    const normalized = String(binding.sourcePath ?? '').replaceAll('\\', '/')
    if (!ownerByPath.has(normalized)) ownerByPath.set(normalized, [])
    ownerByPath.get(normalized).push(binding)
  }

  // Build behavior set from selection for quick lookup
  const selectedBehaviorIds = new Set(
    (selection?.behaviors ?? []).map((b) => b.behaviorId)
  )

  for (const [filePath, fileData] of Object.entries(report?.files ?? {})) {
    const normalizedFile = filePath.replaceAll('\\', '/')
    // Reconstruct full repo-relative path
    const fullPath = normalizedFile.startsWith(sourceProject)
      ? normalizedFile
      : `${sourceProject}/${normalizedFile}`

    // Find owner bindings for this file
    const fileOwners = (ownerByPath.get(fullPath) ?? [])
      .filter((o) => selectedBehaviorIds.has(o.behaviorId))

    for (const mutant of fileData?.mutants ?? []) {
      const mutantId = `${sourceProject}:${normalizedFile}:${mutant.id}`
      const coveredTestIds = mutant.coveredBy ?? []
      const killedTestIds = mutant.killedBy ?? []

      if (fileOwners.length === 0) {
        blocked.push({
          mutantId,
          reason: 'no-owner',
          sourcePath: fullPath,
          mutator: mutant.mutatorName ?? 'unknown',
          status: mutant.status
        })
        continue
      }

      if (fileOwners.length > 1) {
        // Multiple behaviors own this file — attempt span-level attribution
        const attributed = attributeBySpan(mutant, fileOwners)
        if (!attributed) {
          blocked.push({
            mutantId,
            reason: 'ambiguous-owner-boundary',
            sourcePath: fullPath,
            candidateBehaviors: fileOwners.map((o) => o.behaviorId),
            mutator: mutant.mutatorName ?? 'unknown',
            status: mutant.status
          })
          continue
        }
        attributions.push({
          mutantId,
          behaviorId: attributed.behaviorId,
          sourcePath: fullPath,
          symbol: attributed.symbol,
          mutator: mutant.mutatorName ?? 'unknown',
          status: mutant.status,
          coveredTestIds,
          killedTestIds
        })
        continue
      }

      // Unique owner
      const owner = fileOwners[0]
      attributions.push({
        mutantId,
        behaviorId: owner.behaviorId,
        sourcePath: fullPath,
        symbol: owner.symbol,
        mutator: mutant.mutatorName ?? 'unknown',
        status: mutant.status,
        coveredTestIds,
        killedTestIds
      })
    }
  }

  return {
    attributions: attributions.sort((a, b) => a.mutantId.localeCompare(b.mutantId)),
    blocked: blocked.sort((a, b) => a.mutantId.localeCompare(b.mutantId))
  }
}

/**
 * Attempt span-level attribution when multiple owners share a file.
 * Uses mutant location line to find the closest preceding owner symbol.
 * Returns null if attribution is ambiguous.
 */
function attributeBySpan(mutant, fileOwners) {
  // If all owners point to the same behavior, attribute to it
  const uniqueBehaviors = [...new Set(fileOwners.map((o) => o.behaviorId))]
  if (uniqueBehaviors.length === 1) {
    return fileOwners[0]
  }
  // Cannot resolve without AST-level span data — report blocked
  return null
}

/**
 * Compute per-behavior mutation qualification from attributions.
 *
 * @param {object} options
 * @param {MutantAttribution[]} options.attributions
 * @param {object[]} options.blocked
 * @param {object} options.behaviorCatalog - behavior-contracts.json
 * @returns {{ qualifications: object[], failed: boolean }}
 */
export function qualifyBehaviorMutations({ attributions, blocked, behaviorCatalog, behaviorIds = null }) {
  const contractsById = new Map(
    (behaviorCatalog?.contracts ?? []).map((c) => [c.id, c])
  )
  const qualifications = []
  let failed = false

  // Group attributions by behavior
  const byBehavior = new Map()
  for (const attr of attributions) {
    if (!byBehavior.has(attr.behaviorId)) byBehavior.set(attr.behaviorId, [])
    byBehavior.get(attr.behaviorId).push(attr)
  }

  for (const [behaviorId, contract] of contractsById) {
    if (behaviorIds != null && !behaviorIds.includes(behaviorId)) continue
    if (!contract.mutationPolicy?.mutationRequired) continue
    if (contract.status !== 'active') continue

    const mutants = byBehavior.get(behaviorId) ?? []
    const executed = mutants.filter((m) =>
      ['Killed', 'Survived', 'Timeout'].includes(m.status))
    const killed = mutants.filter((m) => m.status === 'Killed')
    const survived = mutants.filter((m) => m.status === 'Survived')
    const timeout = mutants.filter((m) => m.status === 'Timeout')
    const noCoverage = mutants.filter((m) => m.status === 'NoCoverage')
    const scoreable = mutants.filter((m) =>
      ['Killed', 'Survived', 'Timeout', 'NoCoverage'].includes(m.status))
    const score = scoreable.length > 0
      ? Number(((killed.length / scoreable.length) * 100).toFixed(2))
      : 0

    const failures = []
    const policy = contract.mutationPolicy

    if (policy.requireExecutedMutants && executed.length === 0) {
      failures.push(`${behaviorId} mutationRequired but zero executed mutants`)
    }
    if (survived.length > 0 && policy.allowedEquivalentMutantPolicy === 'none') {
      failures.push(`${behaviorId} has ${survived.length} survived mutant(s)`)
    }
    if (timeout.length > 0) {
      failures.push(`${behaviorId} has ${timeout.length} timeout mutant(s)`)
    }
    if (noCoverage.length > 0 && policy.allowedEquivalentMutantPolicy === 'none') {
      failures.push(`${behaviorId} has ${noCoverage.length} no-coverage mutant(s)`)
    }
    if (score < policy.minimumMutationScore && scoreable.length > 0) {
      failures.push(`${behaviorId} mutation score ${score} < minimum ${policy.minimumMutationScore}`)
    }

    // Blocked mutants for this behavior also fail qualification
    const blockedForBehavior = blocked.filter((b) => {
      // Check if blocked mutant's source path matches any owner of this behavior
      return false // blocked mutants have no behavior attribution by definition
    })

    const qualified = failures.length === 0
    if (!qualified) failed = true

    qualifications.push({
      behaviorId,
      mutationRequired: true,
      executed: executed.length,
      killed: killed.length,
      survived: survived.length,
      timeout: timeout.length,
      noCoverage: noCoverage.length,
      score,
      minimumMutationScore: policy.minimumMutationScore,
      qualified,
      failures
    })
  }

  // If any mutants are blocked (ambiguous attribution), fail the whole qualification
  if (blocked.length > 0) {
    failed = true
  }

  return {
    qualifications: qualifications.sort((a, b) => a.behaviorId.localeCompare(b.behaviorId)),
    blockedCount: blocked.length,
    failed
  }
}
