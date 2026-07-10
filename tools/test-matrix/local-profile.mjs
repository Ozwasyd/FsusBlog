function profileEntries(localProfiles) {
  return Object.entries(localProfiles ?? {})
}

const bundleSummarySchema = 'fsusblog.local-production.bundle.v1'

export function localBundleSummaryPath(profileId, bundleId) {
  return `.tmp/local-${profileId}/${bundleId}/summary.json`
}

export function createLocalBundleTiers(profileId, profile) {
  const phaseById = new Map()
  const prefix = `local-${profileId}-`
  return (profile?.bundles ?? []).map((bundle) => {
    const phase = Math.max(0, ...(bundle.dependsOn ?? []).map((dependencyId) => (phaseById.get(dependencyId) ?? -1) + 1))
    phaseById.set(bundle.id, phase)
    const summaryPath = localBundleSummaryPath(profileId, bundle.id)
    return {
      id: `${prefix}${bundle.id}`,
      physicalBundleId: bundle.id,
      logicalMembers: [...(bundle.members ?? [])],
      command: bundle.command,
      dependsOn: (bundle.dependsOn ?? []).map((dependencyId) => `${prefix}${dependencyId}`),
      services: [...(bundle.services ?? [])],
      parallelizable: true,
      exclusiveResources: [...(bundle.exclusiveResources ?? [])],
      phase,
      cost: 'very-high',
      resourceClass: bundle.resourceClass ?? 'cpu',
      maxParallel: profile.maxParallel,
      cpuUnits: bundle.cpuUnits,
      memoryGiB: bundle.memoryGiB,
      budgetMs: bundle.budgetMs,
      cacheInputs: [
        'tests/matrix.yml',
        'tools/test/bundles',
        bundle.command
      ],
      executionKey: `${profileId}/${bundle.id}`,
      executionVariant: 'runtime',
      artifacts: [summaryPath],
      evidence: [summaryPath]
    }
  })
}

export function localProfileSystemResources(profile, system = {}) {
  const memoryGiB = Number(profile?.memoryGiB)
  if (!Number.isFinite(memoryGiB) || memoryGiB <= 0) {
    throw new Error('local profile memoryGiB must be a positive number')
  }
  return {
    cpuCount: Math.max(1, Number(system.cpuCount) || 1),
    availableMemoryGiB: memoryGiB,
    load1: 0
  }
}

export function validateLocalBundleSummary(summary, bundle) {
  const errors = []
  if (summary?.schema !== bundleSummarySchema) errors.push(`schema must be ${bundleSummarySchema}`)
  if (summary?.physicalBundleId !== bundle.id) errors.push(`physicalBundleId must be ${bundle.id}`)
  if (summary?.executionSource !== 'fresh') errors.push('executionSource must be fresh')
  if (summary?.status !== 'success') errors.push('status must be success')
  for (const tierId of bundle.members ?? []) {
    const evidence = summary?.members?.[tierId]
    if (!evidence) {
      errors.push(`missing member evidence: ${tierId}`)
      continue
    }
    if (evidence.status !== 'success') errors.push(`${tierId}.status must be success`)
    if (!Array.isArray(evidence.testIds) || evidence.testIds.length === 0) errors.push(`${tierId}.testIds must be non-empty`)
    if (!evidence.artifactDigests || Object.keys(evidence.artifactDigests).length === 0) {
      errors.push(`${tierId}.artifactDigests must be non-empty`)
    } else if (Object.values(evidence.artifactDigests).some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))) {
      errors.push(`${tierId}.artifactDigests must contain sha256 digests`)
    }
  }
  for (const tierId of Object.keys(summary?.members ?? {})) {
    if (!(bundle.members ?? []).includes(tierId)) errors.push(`unexpected member evidence: ${tierId}`)
  }
  return errors
}

export function collectLogicalTierIds(tiers, targetTierId) {
  const byId = new Map((tiers ?? []).map((tier) => [tier.id, tier]))
  const collected = new Set()
  const visit = (tierId) => {
    if (collected.has(tierId)) return
    const tier = byId.get(tierId)
    if (!tier) return
    collected.add(tierId)
    for (const dependencyId of tier.dependsOn ?? []) visit(dependencyId)
  }
  visit(targetTierId)
  return [...collected].sort()
}

export function validateLocalProfiles(localProfiles, tiers) {
  const errors = []
  for (const [profileId, profile] of profileEntries(localProfiles)) {
    if (profileId === 'production' && profile?.budgetMs !== 300_000) {
      errors.push('localProfiles.production.budgetMs must be 300000')
    }
    if (profileId === 'production' && profile?.maxParallel !== 6) {
      errors.push('localProfiles.production.maxParallel must be 6')
    }
    if (profileId === 'production' && profile?.memoryGiB !== 12) {
      errors.push('localProfiles.production.memoryGiB must be 12')
    }
    if (!Array.isArray(profile?.bundles) || profile.bundles.length !== 5) {
      errors.push(`localProfiles.${profileId} must declare exactly 5 bundles`)
      continue
    }

    const bundleIds = new Set()
    const mapped = new Map()
    for (const bundle of profile.bundles) {
      if (typeof bundle?.id !== 'string' || bundle.id.length === 0) {
        errors.push(`localProfiles.${profileId} bundle id must be non-empty`)
        continue
      }
      if (bundleIds.has(bundle.id)) errors.push(`localProfiles.${profileId} duplicate bundle id: ${bundle.id}`)
      bundleIds.add(bundle.id)
      if (typeof bundle.command !== 'string' || bundle.command.length === 0) {
        errors.push(`localProfiles.${profileId}.${bundle.id}.command must be non-empty`)
      }
      if (!Number.isFinite(bundle.budgetMs) || bundle.budgetMs <= 0) {
        errors.push(`localProfiles.${profileId}.${bundle.id}.budgetMs must be positive`)
      }
      for (const tierId of bundle.members ?? []) {
        const owners = mapped.get(tierId) ?? []
        owners.push(bundle.id)
        mapped.set(tierId, owners)
      }
    }

    for (const tierId of profile.summaryOnly ?? []) {
      const owners = mapped.get(tierId) ?? []
      owners.push('summaryOnly')
      mapped.set(tierId, owners)
    }

    for (const bundle of profile.bundles) {
      for (const dependencyId of bundle.dependsOn ?? []) {
        if (!bundleIds.has(dependencyId)) {
          errors.push(`localProfiles.${profileId}.${bundle.id} depends on unknown bundle: ${dependencyId}`)
        }
      }
    }

    const logicalTierIds = collectLogicalTierIds(tiers, profileId)
    for (const tierId of logicalTierIds) {
      const owners = mapped.get(tierId) ?? []
      if (owners.length === 0) errors.push(`localProfiles.${profileId} missing logical tier: ${tierId}`)
      if (owners.length > 1) errors.push(`localProfiles.${profileId} logical tier mapped more than once: ${tierId}`)
    }
    for (const tierId of mapped.keys()) {
      if (!logicalTierIds.includes(tierId)) errors.push(`localProfiles.${profileId} maps unrelated logical tier: ${tierId}`)
    }
  }
  return errors
}
