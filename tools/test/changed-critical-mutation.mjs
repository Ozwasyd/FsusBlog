#!/usr/bin/env node
/**
 * Changed-critical mutation selection — receipt-driven.
 *
 * Fixed selection chain:
 *   changed paths → ImplementationOwner receipt → Behavior IDs
 *   → BehaviorCatalog mutationPolicy → BehaviorTestBinding receipt → test filters
 *   → Stryker tool policy
 *
 * No hand-written source-pattern→test-owner glob mappings.
 */
import {
  canonicalJson,
  requireChangedCriticalSourceState,
  sha256
} from './changed-critical-mutation-identity.mjs'
import {
  normalizeChangedPath,
  resolveChangedCriticalSourceProject
} from './changed-critical-mutation-support.mjs'

const TOOL_POLICY_SCHEMA = 'fsusblog.changed-critical-mutation-tool-policy.v2'

export function validateToolPolicy(toolPolicy) {
  if (toolPolicy?.schema !== TOOL_POLICY_SCHEMA || toolPolicy.version !== 2) {
    throw new Error('changed-critical mutation tool policy must use schema v2')
  }
  const defaults = toolPolicy.defaults
  if (
    !defaults?.configuration
    || !defaults?.mutationLevel
    || !Number.isFinite(defaults?.thresholds?.high)
    || !Number.isFinite(defaults?.thresholds?.low)
    || !Number.isFinite(defaults?.thresholds?.break)
  ) {
    throw new Error('tool policy defaults must declare configuration, mutationLevel, and thresholds')
  }
  if (!Array.isArray(toolPolicy.sourceProjects) || toolPolicy.sourceProjects.length === 0) {
    throw new Error('tool policy sourceProjects must be non-empty')
  }
  return toolPolicy
}

/**
 * Select changed-critical mutation closure from receipts.
 *
 * @param {object} options
 * @param {object} options.toolPolicy - Tool policy (thresholds, source projects, execution limits)
 * @param {Buffer|string} options.rawToolPolicy - Raw bytes of tool policy for digest
 * @param {string[]} options.changedPaths - Changed file paths (repo-relative)
 * @param {object} options.sourceState - { commit, worktreeFingerprint }
 * @param {object} options.ownerReceipt - Sealed ImplementationOwner receipt with bindings[]
 * @param {object} options.behaviorCatalog - behavior-contracts.json with mutationPolicy per contract
 * @param {object} options.testBindingScan - BehaviorTestBinding scan with bindings[]
 * @param {Buffer|string} [options.rawTestBindingScan] - Raw scan bytes for identity
 */
export function selectChangedCriticalMutation({
  toolPolicy,
  rawToolPolicy,
  changedPaths,
  sourceState,
  ownerReceipt,
  behaviorCatalog,
  testBindingScan,
  rawTestBindingScan
}) {
  validateToolPolicy(toolPolicy)
  const normalizedSourceState = requireChangedCriticalSourceState(sourceState)
  const uniquePaths = [...new Set(changedPaths.map(normalizeChangedPath))].sort()
  const policyBytes = rawToolPolicy ?? Buffer.from(`${JSON.stringify(toolPolicy, null, 2)}\n`)
  const policyDigest = sha256(policyBytes)

  // Step 1: changed paths → ImplementationOwner receipt → Behavior IDs
  const ownerBindings = ownerReceipt?.bindings ?? []
  const pathToBehaviors = new Map()
  for (const binding of ownerBindings) {
    if (binding.status === 'error') continue
    const normalizedSource = String(binding.sourcePath ?? '').replaceAll('\\', '/')
    if (uniquePaths.includes(normalizedSource)) {
      if (!pathToBehaviors.has(normalizedSource)) pathToBehaviors.set(normalizedSource, [])
      pathToBehaviors.get(normalizedSource).push(binding)
    }
  }

  // Step 2: Filter to behaviors with mutationRequired in BehaviorCatalog
  const contractsById = new Map(
    (behaviorCatalog?.contracts ?? []).map((c) => [c.id, c])
  )
  const selectedBehaviors = new Map()
  const unmappedCriticalPaths = []

  for (const [changedPath, bindings] of pathToBehaviors) {
    let hasMutationRequired = false
    for (const binding of bindings) {
      const contract = contractsById.get(binding.behaviorId)
      if (contract?.mutationPolicy?.mutationRequired === true && contract.status === 'active') {
        hasMutationRequired = true
        if (!selectedBehaviors.has(binding.behaviorId)) {
          selectedBehaviors.set(binding.behaviorId, {
            behaviorId: binding.behaviorId,
            contract,
            owners: [],
            reasons: []
          })
        }
        const entry = selectedBehaviors.get(binding.behaviorId)
        entry.owners.push(binding)
        entry.reasons.push(`changed:${changedPath}`)
      }
    }
    // If path matched an owner but no behavior has mutationRequired, it is not critical
    // (no fail-closed for non-mutation behaviors)
  }

  // Check for changed paths that match owner bindings but have no mutation-required behavior
  // These are not errors — only mutation-required behaviors trigger Stryker.

  // Step 3: BehaviorTestBinding receipt → exact test filters
  const testBindings = testBindingScan?.bindings ?? []
  const behaviors = [...selectedBehaviors.values()]
    .map((entry) => {
      const behaviorTestBindings = testBindings.filter(
        (b) => b.behaviorId === entry.behaviorId
      )
      // Derive FullyQualifiedName~ filters from test binding class names
      const testFilters = [...new Set(
        behaviorTestBindings.map((b) => {
          const fqn = String(b.fullyQualifiedName ?? '')
          const testId = String(b.canonicalTestId ?? '')
          const canonicalClass = testId.match(/^xunit-trx:([^#]+)#/u)?.[1]
          const className = canonicalClass ?? fqn.split('.').at(-2) ?? ''
          return className.trim()
        }).filter(Boolean)
      )].sort()
      const filterExpression = testFilters
        .map((cls) => `FullyQualifiedName~${cls}`)
        .join('|')
      const mutateFiles = [...new Set(
        entry.owners.map((o) => String(o.sourcePath).replaceAll('\\', '/'))
      )].sort()
      return {
        behaviorId: entry.behaviorId,
        risk: entry.contract.risk,
        mutationPolicy: entry.contract.mutationPolicy,
        reasons: [...new Set(entry.reasons)].sort(),
        owners: entry.owners.map((o) => ({
          sourcePath: String(o.sourcePath).replaceAll('\\', '/'),
          symbol: o.symbol,
          language: o.language
        })),
        mutateFiles,
        testBindings: behaviorTestBindings.map((b) => ({
          canonicalTestId: b.canonicalTestId,
          fullyQualifiedName: b.fullyQualifiedName,
          testKind: b.testKind
        })),
        testFilters,
        testFilter: filterExpression
      }
    })
    .sort((left, right) => left.behaviorId.localeCompare(right.behaviorId))

  const mutateFiles = [...new Set(behaviors.flatMap((b) => b.mutateFiles))].sort()
  const testFilter = [...new Set(
    behaviors.flatMap((b) => b.testFilters)
  )].sort().map((cls) => `FullyQualifiedName~${cls}`).join('|')

  // Source project closures
  const sourceProjects = [...new Set(
    mutateFiles
      .map((file) => resolveChangedCriticalSourceProject(file, toolPolicy.sourceProjects))
  )].sort()
  const projectClosures = sourceProjects.map((sourceProject) => {
    const projectBehaviors = behaviors.filter((b) =>
      b.mutateFiles.some((f) => f.startsWith(`${sourceProject}/`)))
    const projectMutateFiles = [...new Set(
      projectBehaviors.flatMap((b) =>
        b.mutateFiles
          .filter((f) => f.startsWith(`${sourceProject}/`))
          .map((f) => f.slice(sourceProject.length + 1))
      )
    )].sort()
    const projectTestFilters = [...new Set(
      projectBehaviors.flatMap((b) => b.testFilters)
    )].sort()
    return {
      sourceProject,
      behaviors: projectBehaviors.map(({ behaviorId, risk }) => ({ behaviorId, risk })),
      mutateFiles: projectMutateFiles,
      testFilters: projectTestFilters,
      testFilter: projectTestFilters.map((cls) => `FullyQualifiedName~${cls}`).join('|')
    }
  })

  const base = {
    schema: 'fsusblog.changed-critical-mutation-selection.v2',
    status: behaviors.length === 0 ? 'empty' : 'selected',
    sourceState: normalizedSourceState,
    toolPolicy: {
      path: 'config/testing/mutation/changed-critical-domains.v1.json',
      sha256: policyDigest,
      version: toolPolicy.version
    },
    ownerReceiptDigest: ownerReceipt?.contentDigest ?? null,
    behaviorCatalogDigest: behaviorCatalog?.digest ?? sha256(canonicalJson(behaviorCatalog)),
    testBindingScanDigest: sha256(rawTestBindingScan ?? canonicalJson(testBindingScan)),
    changedPaths: uniquePaths,
    behaviors,
    mutateFiles,
    testFilter,
    projectClosures,
    reasons: behaviors.flatMap((b) => b.reasons).sort()
  }
  return {
    ...base,
    closureDigest: sha256(canonicalJson(base))
  }
}

export function createChangedCriticalStrykerConfig(selection, toolPolicy, sourceProject = null) {
  if (selection.status !== 'selected' || selection.mutateFiles.length === 0 || !selection.testFilter) {
    throw new Error('cannot generate Stryker config for an empty critical closure')
  }
  validateToolPolicy(toolPolicy)
  const selectedProject = sourceProject ?? selection.projectClosures[0]?.sourceProject
  const closure = selection.projectClosures.find((entry) => entry.sourceProject === selectedProject)
  if (!closure) throw new Error(`selection has no source-project closure for ${selectedProject}`)
  return {
    'stryker-config': {
      'test-projects': ['../../tests/backend/FsusBlog.Server.Tests.csproj'],
      configuration: toolPolicy.defaults.configuration,
      'test-case-filter': closure.testFilter,
      'mutation-level': toolPolicy.defaults.mutationLevel,
      thresholds: toolPolicy.defaults.thresholds,
      'break-on-initial-test-failure': true,
      reporters: ['progress', 'html', 'json'],
      'report-file-name': 'changed-critical-mutation',
      mutate: closure.mutateFiles,
      'ignore-methods': toolPolicy.defaults.ignoreMethods
    }
  }
}
