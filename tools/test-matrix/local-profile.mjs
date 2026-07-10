import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function profileEntries(localProfiles) {
  return Object.entries(localProfiles ?? {})
}

const bundleSummarySchema = 'fsusblog.local-production.bundle.v1'
const summaryOnlySchema = 'fsusblog.local-production.summary-only.v1'
const logicalProjectionSchema = 'fsusblog.local-profile-projection.v1'
const generatedRuntimeRoots = [
  '.tmp',
  'BenchmarkDotNet.Artifacts',
  'src/backend/wwwroot',
  'src/frontend/coverage',
  'src/frontend/dist',
  'src/frontend/playwright-report',
  'src/frontend/test-results'
]

function normalizeDeclaration(value) {
  return String(value ?? '').trim().replace(/^\.\//u, '').replaceAll('\\', '/')
}

function generatedRuntimeDeclaration(value) {
  const normalized = normalizeDeclaration(value)
  return generatedRuntimeRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

export function matrixGeneratedRuntimePaths(tier) {
  return sortedUnique([...(tier?.artifacts ?? []), ...(tier?.evidence ?? [])]
    .map(normalizeDeclaration)
    .filter(generatedRuntimeDeclaration))
}

function plainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeRepositoryDeclaration(value) {
  const normalized = normalizeDeclaration(value)
  return Boolean(normalized)
    && !path.isAbsolute(normalized)
    && normalized !== '..'
    && !normalized.startsWith('../')
}

function authoritativeSubstitutionProofPath(value) {
  const normalized = normalizeDeclaration(value).toLowerCase()
  return normalized.endsWith('.trx')
    || normalized.includes('/coverage/')
    || normalized.endsWith('/coverage')
    || normalized.endsWith('/summary.json')
}

function buildArtifactSubstitutionContract(bundle, matrixTiers) {
  const errors = []
  const byTier = {}
  const rawContract = bundle?.artifactSubstitutions
  if (rawContract === undefined) return { errors, byTier }
  if (!Array.isArray(rawContract) || rawContract.length === 0) {
    return { errors: ['artifactSubstitutions must be a non-empty flat array'], byTier }
  }
  const matrixById = new Map((matrixTiers ?? []).map((tier) => [tier.id, tier]))
  const normalizedMappingsByTier = new Map()
  for (const rawEntry of rawContract) {
    const entry = String(rawEntry ?? '').trim()
    const separatorIndex = entry.indexOf('::')
    const arrowIndex = entry.indexOf('=>', separatorIndex + 2)
    if (!entry || separatorIndex <= 0 || arrowIndex <= separatorIndex + 2
      || entry.indexOf('::', separatorIndex + 2) >= 0 || entry.indexOf('=>', arrowIndex + 2) >= 0) {
      errors.push(`artifactSubstitutions entry is malformed: ${entry || '<empty>'}`)
      continue
    }
    const tierId = entry.slice(0, separatorIndex).trim()
    const rawCanonical = entry.slice(separatorIndex + 2, arrowIndex).trim()
    const rawActualPaths = entry.slice(arrowIndex + 2).split('|').map((value) => value.trim())
    if (!tierId || !(bundle?.members ?? []).includes(tierId) || !matrixById.has(tierId)) {
      errors.push(`artifactSubstitutions references unknown bundle tier: ${tierId || '<empty>'}`)
      continue
    }
    const canonicalRuntimePaths = new Set(matrixGeneratedRuntimePaths(matrixById.get(tierId)))
    const normalizedMappings = normalizedMappingsByTier.get(tierId) ?? {}
    normalizedMappingsByTier.set(tierId, normalizedMappings)
    const canonical = normalizeDeclaration(rawCanonical)
    if (!safeRepositoryDeclaration(rawCanonical)) {
      errors.push(`artifactSubstitutions.${tierId} has an invalid canonical path: ${canonical || '<empty>'}`)
      continue
    }
    if (Object.hasOwn(normalizedMappings, canonical)) {
      errors.push(`artifactSubstitutions.${tierId} has duplicate canonical path: ${canonical}`)
      continue
    }
    if (!canonicalRuntimePaths.has(canonical)) {
      errors.push(`artifactSubstitutions.${tierId} references unknown canonical path: ${canonical}`)
      continue
    }
    if (rawActualPaths.length === 0 || rawActualPaths.some((actualPath) => !actualPath)) {
      errors.push(`artifactSubstitutions.${tierId}.${canonical} must declare actual proof paths`)
      continue
    }
    const actualPaths = rawActualPaths.map(normalizeDeclaration)
    if (actualPaths.some((actualPath, index) => !safeRepositoryDeclaration(rawActualPaths[index]))) {
      errors.push(`artifactSubstitutions.${tierId}.${canonical} contains an invalid actual proof path`)
      continue
    }
    if (actualPaths.some((actualPath) => !generatedRuntimeDeclaration(actualPath))) {
      errors.push(`artifactSubstitutions.${tierId}.${canonical} actual proof paths must be generated runtime paths`)
      continue
    }
    if (actualPaths.some((actualPath) => actualPath.endsWith('.log'))) {
      errors.push(`artifactSubstitutions.${tierId}.${canonical} cannot use command logs as actual proof`)
      continue
    }
    if (new Set(actualPaths).size !== actualPaths.length) {
      errors.push(`artifactSubstitutions.${tierId}.${canonical} contains duplicate actual proof paths`)
      continue
    }
    if (actualPaths.includes(canonical)) {
      errors.push(`artifactSubstitutions.${tierId}.${canonical} cannot substitute itself`)
      continue
    }
    if (!actualPaths.some(authoritativeSubstitutionProofPath)) {
      errors.push(`artifactSubstitutions.${tierId}.${canonical} must include a TRX, coverage, or summary proof`)
      continue
    }
    normalizedMappings[canonical] = [...actualPaths].sort()
  }
  for (const [tierId, mappings] of normalizedMappingsByTier) {
    const tier = matrixById.get(tierId)
    for (const runtimePath of matrixGeneratedRuntimePaths(tier)) {
      if (Object.hasOwn(mappings, runtimePath)) continue
      const parent = Object.keys(mappings)
        .filter((canonical) => runtimePath.startsWith(`${canonical}/`))
        .sort((left, right) => right.length - left.length)[0]
      if (parent) mappings[runtimePath] = [...mappings[parent]]
    }
    if (Object.keys(mappings).length > 0) byTier[tierId] = mappings
  }
  return { errors, byTier }
}

export function validateArtifactSubstitutions(bundle, matrixTiers) {
  return buildArtifactSubstitutionContract(bundle, matrixTiers).errors
}

export function resolveArtifactSubstitutions(bundle, matrixTiers) {
  const contract = buildArtifactSubstitutionContract(bundle, matrixTiers)
  if (contract.errors.length > 0) throw new Error(contract.errors.join('; '))
  return contract.byTier
}

export function artifactSubstitutionBindingDigest(canonicalPath, actualDigests) {
  const canonical = normalizeDeclaration(canonicalPath)
  const normalizedActualDigests = Object.fromEntries(Object.entries(actualDigests ?? {})
    .map(([declaration, digest]) => [normalizeDeclaration(declaration), String(digest)])
    .sort(([left], [right]) => left.localeCompare(right)))
  return `sha256:${sha256(JSON.stringify({
    schema: 'fsusblog.local-artifact-substitution.v1',
    canonicalPath: canonical,
    actualDigests: normalizedActualDigests
  }))}`
}

function wildcardPattern(value) {
  const normalized = normalizeDeclaration(value)
  let source = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, 'u')
}

function hasWildcard(value) {
  return value.includes('*') || value.includes('?')
}

function walkOutputPaths(rootDirectory) {
  const paths = []
  const visit = (absolutePath) => {
    const stat = fs.lstatSync(absolutePath)
    paths.push(absolutePath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    for (const name of fs.readdirSync(absolutePath).sort()) visit(path.join(absolutePath, name))
  }
  visit(rootDirectory)
  return paths
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function outputPathFingerprint(absolutePath) {
  const stat = fs.lstatSync(absolutePath)
  if (stat.isSymbolicLink()) return `symlink:${sha256(fs.readlinkSync(absolutePath))}`
  if (stat.isFile()) return `file:${stat.mode}:${stat.size}:${sha256(fs.readFileSync(absolutePath))}`
  if (!stat.isDirectory()) return `other:${stat.mode}:${stat.size}`
  const entries = fs.readdirSync(absolutePath).sort()
    .map((name) => [name, outputPathFingerprint(path.join(absolutePath, name))])
  return `directory:${sha256(JSON.stringify(entries))}`
}

function wildcardSearchRoot(root, declaration) {
  const wildcardIndex = declaration.search(/[?*]/u)
  const prefix = wildcardIndex < 0 ? declaration : declaration.slice(0, wildcardIndex)
  const directoryPrefix = prefix.endsWith('/') ? prefix : path.posix.dirname(prefix)
  const absolutePath = path.resolve(root, directoryPrefix === '.' ? '' : directoryPrefix)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`declared artifact is outside the repository: ${declaration}`)
  }
  return absolutePath
}

export function digestDeclaredOutputs(rootValue, declarations) {
  const root = path.resolve(rootValue)
  const digests = {}
  for (const declarationValue of sortedUnique(declarations ?? [])) {
    const declaration = normalizeDeclaration(declarationValue)
    if (!declaration || path.isAbsolute(declaration) || declaration === '..' || declaration.startsWith('../')) {
      throw new Error(`declared artifact path is invalid: ${declaration || '<empty>'}`)
    }
    const absoluteDeclaration = path.resolve(root, declaration)
    if (absoluteDeclaration !== root && !absoluteDeclaration.startsWith(`${root}${path.sep}`)) {
      throw new Error(`declared artifact is outside the repository: ${declaration}`)
    }
    if (!hasWildcard(declaration)) {
      if (!fs.existsSync(absoluteDeclaration)) throw new Error(`declared artifact is missing: ${declaration}`)
      digests[declaration] = `sha256:${sha256(outputPathFingerprint(absoluteDeclaration))}`
      continue
    }
    const matcher = wildcardPattern(declaration)
    const searchRoot = wildcardSearchRoot(root, declaration)
    const matches = fs.existsSync(searchRoot)
      ? walkOutputPaths(searchRoot)
        .map((absolutePath) => path.relative(root, absolutePath).replaceAll(path.sep, '/'))
        .filter((relativePath) => matcher.test(relativePath))
        .sort()
      : []
    if (matches.length === 0) throw new Error(`declared artifact is missing: ${declaration}`)
    const fingerprints = matches.map((relativePath) => [
      relativePath,
      outputPathFingerprint(path.join(root, relativePath))
    ])
    digests[declaration] = `sha256:${sha256(JSON.stringify(fingerprints))}`
  }
  return digests
}

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
  const requiredCpuUnits = Number(profile?.cpuUnits)
  const memoryGiB = Number(profile?.memoryGiB)
  const maxInitialLoad1 = Number(profile?.maxInitialLoad1)
  const cpuCount = Number(system.cpuCount)
  const availableMemoryGiB = Number(system.availableMemoryGiB)
  const load1 = Number(system.load1)
  if (!Number.isFinite(requiredCpuUnits) || requiredCpuUnits <= 0) {
    throw new Error('local profile cpuUnits must be a positive number')
  }
  if (!Number.isFinite(memoryGiB) || memoryGiB <= 0) {
    throw new Error('local profile memoryGiB must be a positive number')
  }
  if (!Number.isFinite(maxInitialLoad1) || maxInitialLoad1 < 0) {
    throw new Error('local profile maxInitialLoad1 must be a non-negative number')
  }
  if (!Number.isFinite(cpuCount) || cpuCount < requiredCpuUnits) {
    throw new Error(`local profile requires at least ${requiredCpuUnits} available CPU units`)
  }
  if (!Number.isFinite(availableMemoryGiB) || availableMemoryGiB < memoryGiB) {
    throw new Error(`local profile requires at least ${memoryGiB} GiB available memory`)
  }
  if (!Number.isFinite(load1) || load1 < 0 || load1 > maxInitialLoad1) {
    throw new Error(`local profile initial load1 must be at most ${maxInitialLoad1}`)
  }
  return {
    cpuCount,
    availableCpuUnits: requiredCpuUnits,
    availableMemoryGiB: memoryGiB,
    load1
  }
}

function commandLogPath(profileId, bundleId, value) {
  const normalized = normalizeDeclaration(value)
  return normalized.startsWith(`.tmp/local-${profileId}/${bundleId}/steps/`) && normalized.endsWith('.log')
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

export function validateLocalBundleSummary(summary, bundle, {
  expectedRunId = null,
  matrixTiers = null,
  profileId = 'production'
} = {}) {
  const errors = []
  const matrixById = matrixTiers === null
    ? null
    : new Map((matrixTiers ?? []).map((tier) => [tier.id, tier]))
  const substitutionContract = matrixById === null
    ? { errors: [], byTier: {} }
    : buildArtifactSubstitutionContract(bundle, matrixTiers)
  errors.push(...substitutionContract.errors)
  if (summary?.schema !== bundleSummarySchema) errors.push(`schema must be ${bundleSummarySchema}`)
  if (summary?.physicalBundleId !== bundle.id) errors.push(`physicalBundleId must be ${bundle.id}`)
  if (summary?.executionSource !== 'fresh') errors.push('executionSource must be fresh')
  if (summary?.status !== 'success') errors.push('status must be success')
  if (expectedRunId !== null && summary?.schedulerRunId !== expectedRunId) {
    errors.push(`schedulerRunId must be ${expectedRunId}`)
  }
  for (const tierId of bundle.members ?? []) {
    const evidence = summary?.members?.[tierId]
    if (!evidence) {
      errors.push(`missing member evidence: ${tierId}`)
      continue
    }
    if (evidence.status !== 'success') errors.push(`${tierId}.status must be success`)
    if (!Number.isFinite(evidence.durationMs) || evidence.durationMs < 0) {
      errors.push(`${tierId}.durationMs must be a non-negative number`)
    }
    if (!Array.isArray(evidence.testIds) || evidence.testIds.length === 0) errors.push(`${tierId}.testIds must be non-empty`)
    if (!evidence.artifactDigests || Object.keys(evidence.artifactDigests).length === 0) {
      errors.push(`${tierId}.artifactDigests must be non-empty`)
    } else if (Object.values(evidence.artifactDigests).some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))) {
      errors.push(`${tierId}.artifactDigests must contain sha256 digests`)
    }
    if (matrixById !== null) {
      const matrixTier = matrixById.get(tierId)
      if (!matrixTier) {
        errors.push(`${tierId} is missing from matrix tiers`)
        continue
      }
      const runtimePaths = matrixGeneratedRuntimePaths(matrixTier)
      const substitutions = substitutionContract.byTier[tierId] ?? {}
      const substitutedCanonicalPaths = Object.keys(substitutions).sort()
      const substitutionProofs = evidence.artifactSubstitutionProofs
      if (!plainRecord(substitutionProofs)) {
        errors.push(`${tierId}.artifactSubstitutionProofs must be an object`)
      } else if (!sameStringArray(Object.keys(substitutionProofs).sort(), substitutedCanonicalPaths)) {
        errors.push(`${tierId}.artifactSubstitutionProofs must exactly match configured substitutions`)
      }
      if (runtimePaths.length > 0) {
        const expectedProofMode = substitutedCanonicalPaths.length > 0
          ? 'matrix-runtime-artifacts-with-substitutions'
          : 'matrix-runtime-artifacts'
        if (evidence.artifactProofMode !== expectedProofMode) {
          errors.push(`${tierId}.artifactProofMode must be ${expectedProofMode}`)
        }
        if (!sameStringArray(evidence.matrixRuntimePaths, runtimePaths)) {
          errors.push(`${tierId}.matrixRuntimePaths must exactly match matrix generated runtime paths`)
        }
        for (const declaration of runtimePaths) {
          const actualPaths = substitutions[declaration]
          if (!actualPaths && !/^sha256:[a-f0-9]{64}$/u.test(String(evidence.artifactDigests?.[declaration] ?? ''))) {
            errors.push(`${tierId} is missing the matrix runtime artifact digest: ${declaration}`)
            continue
          }
          if (!actualPaths) continue
          const proof = substitutionProofs?.[declaration]
          if (!plainRecord(proof)) {
            errors.push(`${tierId} is missing the artifact substitution proof: ${declaration}`)
            continue
          }
          const expectedProofFields = ['actualDigests', 'actualPaths', 'canonicalDigest', 'canonicalPath']
          if (!sameStringArray(Object.keys(proof).sort(), expectedProofFields)) {
            errors.push(`${tierId} artifact substitution proof has unexpected fields: ${declaration}`)
          }
          if (proof.canonicalPath !== declaration) {
            errors.push(`${tierId} artifact substitution canonicalPath must be ${declaration}`)
          }
          if (!sameStringArray(proof.actualPaths, actualPaths)) {
            errors.push(`${tierId} artifact substitution actualPaths must match configuration: ${declaration}`)
          }
          const actualDigestKeys = plainRecord(proof.actualDigests)
            ? Object.keys(proof.actualDigests).sort()
            : []
          if (!plainRecord(proof.actualDigests) || !sameStringArray(actualDigestKeys, actualPaths)) {
            errors.push(`${tierId} artifact substitution actualDigests must exactly match actualPaths: ${declaration}`)
            continue
          }
          for (const actualPath of actualPaths) {
            const actualDigest = proof.actualDigests[actualPath]
            if (!/^sha256:[a-f0-9]{64}$/u.test(String(actualDigest ?? ''))) {
              errors.push(`${tierId} artifact substitution actual digest must be sha256: ${actualPath}`)
            }
            if (evidence.artifactDigests?.[actualPath] !== actualDigest) {
              errors.push(`${tierId} artifact substitution actual digest must match artifactDigests: ${actualPath}`)
            }
          }
          const canonicalDigest = artifactSubstitutionBindingDigest(declaration, proof.actualDigests)
          if (proof.canonicalDigest !== canonicalDigest) {
            errors.push(`${tierId} artifact substitution canonicalDigest is invalid: ${declaration}`)
          }
          if (evidence.artifactDigests?.[declaration] !== canonicalDigest) {
            errors.push(`${tierId} artifact substitution canonical digest must match artifactDigests: ${declaration}`)
          }
        }
      } else {
        if (evidence.artifactProofMode !== 'command-log-and-test-ids') {
          errors.push(`${tierId}.artifactProofMode must be command-log-and-test-ids`)
        }
        if (!sameStringArray(evidence.matrixRuntimePaths, [])) {
          errors.push(`${tierId}.matrixRuntimePaths must be empty when the matrix declares no generated runtime paths`)
        }
        const hasCommandLog = Object.keys(evidence.artifactDigests ?? {})
          .some((declaration) => commandLogPath(profileId, bundle.id, declaration))
        if (!hasCommandLog) errors.push(`${tierId} must provide a command log digest`)
        if (substitutedCanonicalPaths.length > 0) {
          errors.push(`${tierId} cannot substitute artifacts because the matrix declares no generated runtime paths`)
        }
      }
    }
  }
  for (const tierId of Object.keys(summary?.members ?? {})) {
    if (!(bundle.members ?? []).includes(tierId)) errors.push(`unexpected member evidence: ${tierId}`)
  }
  return errors
}

function sameSourceState(left, right) {
  return Boolean(left && right)
    && String(left.commit ?? '') === String(right.commit ?? '')
    && String(left.worktreeFingerprint ?? '') === String(right.worktreeFingerprint ?? '')
}

function collectionEntry(collection, id) {
  return collection instanceof Map ? collection.get(id) : collection?.[id]
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

function validateSummaryOnlyEvidence(evidence, tierId, checkpoint) {
  const errors = []
  if (!evidence) return [`missing summary-only evidence: ${tierId}`]
  if (evidence.schema !== summaryOnlySchema) errors.push(`${tierId} summary-only schema must be ${summaryOnlySchema}`)
  if (evidence.tierId !== tierId) errors.push(`${tierId} summary-only tierId must match`)
  if (evidence.status !== 'collected-blocked') errors.push(`${tierId} summary-only status must be collected-blocked`)
  if (evidence.executionSource !== 'external-environment') {
    errors.push(`${tierId} summary-only executionSource must be external-environment`)
  }
  if (evidence.schedulerRunId !== checkpoint.runId) {
    errors.push(`${tierId} summary-only schedulerRunId must be ${checkpoint.runId}`)
  }
  if (!sameSourceState(evidence.sourceState, checkpoint.sourceState)) {
    errors.push(`${tierId} summary-only sourceState must match the checkpoint`)
  }
  if (!String(evidence.evidencePath ?? '').trim()) errors.push(`${tierId} summary-only evidencePath must be non-empty`)
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(evidence.artifactDigest ?? ''))) {
    errors.push(`${tierId} summary-only artifactDigest must be sha256`)
  }
  return errors
}

export function buildLocalProfileProjection({
  profileId,
  profile,
  tiers,
  checkpoint,
  bundleSummaries,
  summaryOnlyEvidence
}) {
  const errors = []
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('local profile projection requires matrix tiers')
  }
  const matrixById = new Map()
  for (const tier of tiers) {
    if (!tier?.id) {
      errors.push('matrix tier id must be non-empty')
      continue
    }
    if (matrixById.has(tier.id)) errors.push(`duplicate matrix tier: ${tier.id}`)
    matrixById.set(tier.id, tier)
  }
  if (!matrixById.has(profileId)) errors.push(`matrix target tier is missing: ${profileId}`)
  for (const tier of tiers) {
    for (const dependencyId of tier?.dependsOn ?? []) {
      if (!matrixById.has(dependencyId)) errors.push(`${tier.id} depends on missing matrix tier: ${dependencyId}`)
    }
  }
  const logicalTierIds = collectLogicalTierIds(tiers, profileId)
  const entries = {}
  if (!checkpoint || typeof checkpoint !== 'object') {
    throw new Error('local profile projection requires a scheduler checkpoint')
  }
  if (checkpoint.targetTierId !== profileId) errors.push(`checkpoint targetTierId must be ${profileId}`)
  if (checkpoint.mode !== 'fresh') errors.push('checkpoint mode must be fresh')
  if (checkpoint.status !== 'success') errors.push('checkpoint status must be success')
  if (!String(checkpoint.runId ?? '').trim()) errors.push('checkpoint runId must be non-empty')
  if (!checkpoint.sourceState || !String(checkpoint.sourceState.worktreeFingerprint ?? '').trim()) {
    errors.push('checkpoint sourceState must be present')
  }

  for (const bundle of profile?.bundles ?? []) {
    const physicalTierId = `local-${profileId}-${bundle.id}`
    const physical = checkpoint?.tiers?.[physicalTierId]
    if (physical?.status !== 'success') errors.push(`${physicalTierId} checkpoint status must be success`)
    if (physical?.reused !== false) errors.push(`${physicalTierId} checkpoint must not be reused`)
    const summaryPath = localBundleSummaryPath(profileId, bundle.id)
    if (!Object.hasOwn(physical?.outputs ?? {}, summaryPath)) {
      errors.push(`${physicalTierId} checkpoint output is missing ${summaryPath}`)
    }

    const summary = collectionEntry(bundleSummaries, bundle.id)
    const summaryErrors = validateLocalBundleSummary(summary, bundle, {
      expectedRunId: checkpoint.runId,
      matrixTiers: tiers,
      profileId
    })
    if (summaryErrors.length > 0) {
      errors.push(`${bundle.id} bundle evidence invalid: ${summaryErrors.join(', ')}`)
      continue
    }
    for (const tierId of bundle.members ?? []) {
      if (entries[tierId]) {
        errors.push(`logical tier projected more than once: ${tierId}`)
        continue
      }
      const evidence = summary.members[tierId]
      entries[tierId] = {
        tierId,
        evidenceKind: 'executed',
        physicalBundleId: bundle.id,
        status: 'success',
        executionSource: 'fresh',
        durationMs: Number(evidence.durationMs),
        testIds: sortedUnique(evidence.testIds),
        artifactProofMode: evidence.artifactProofMode,
        matrixRuntimePaths: [...evidence.matrixRuntimePaths],
        artifactSubstitutionProofs: Object.fromEntries(Object.entries(evidence.artifactSubstitutionProofs)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([canonicalPath, proof]) => [canonicalPath, {
            canonicalPath: proof.canonicalPath,
            canonicalDigest: proof.canonicalDigest,
            actualPaths: [...proof.actualPaths],
            actualDigests: Object.fromEntries(Object.entries(proof.actualDigests).sort())
          }])),
        artifactDigests: Object.fromEntries(Object.entries(evidence.artifactDigests).sort())
      }
    }
  }

  for (const tierId of profile?.summaryOnly ?? []) {
    if (entries[tierId]) {
      errors.push(`logical tier projected more than once: ${tierId}`)
      continue
    }
    const evidence = collectionEntry(summaryOnlyEvidence, tierId)
    const summaryErrors = validateSummaryOnlyEvidence(evidence, tierId, checkpoint)
    if (summaryErrors.length > 0) {
      errors.push(...summaryErrors)
      continue
    }
    entries[tierId] = {
      tierId,
      evidenceKind: 'summary-only',
      physicalBundleId: null,
      status: 'collected-blocked',
      executionSource: 'external-environment',
      durationMs: null,
      testIds: [],
      artifactDigests: { [evidence.evidencePath]: evidence.artifactDigest }
    }
  }

  const projectedTierIds = Object.keys(entries).sort()
  const missingTierIds = logicalTierIds.filter((tierId) => !entries[tierId])
  const unexpectedTierIds = projectedTierIds.filter((tierId) => !logicalTierIds.includes(tierId))
  if (missingTierIds.length > 0) errors.push(`missing logical tier projection: ${missingTierIds.join(', ')}`)
  if (unexpectedTierIds.length > 0) errors.push(`unexpected logical tier projection: ${unexpectedTierIds.join(', ')}`)
  if (projectedTierIds.length !== logicalTierIds.length) {
    errors.push(`logical tier projection count must be ${logicalTierIds.length}, received ${projectedTierIds.length}`)
  }
  if (errors.length > 0) throw new Error(errors.join('; '))

  const orderedEntries = Object.fromEntries(logicalTierIds.map((tierId) => [tierId, entries[tierId]]))
  const summaryOnlyTierCount = Object.values(orderedEntries)
    .filter((entry) => entry.evidenceKind === 'summary-only').length
  return {
    schema: logicalProjectionSchema,
    profileId,
    runId: checkpoint.runId,
    sourceState: { ...checkpoint.sourceState },
    executionSource: 'fresh',
    status: 'success',
    logicalTierCount: logicalTierIds.length,
    executedTierCount: logicalTierIds.length - summaryOnlyTierCount,
    summaryOnlyTierCount,
    logicalTierIds,
    entries: orderedEntries
  }
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

function localProfileBudgetCriticalPath(profile) {
  const bundles = new Map((profile?.bundles ?? []).map((bundle) => [bundle.id, bundle]))
  const memo = new Map()
  const visiting = new Set()
  const visit = (bundleId) => {
    if (memo.has(bundleId)) return memo.get(bundleId)
    if (visiting.has(bundleId)) return Number.POSITIVE_INFINITY
    const bundle = bundles.get(bundleId)
    if (!bundle) return Number.POSITIVE_INFINITY
    visiting.add(bundleId)
    const dependencyBudget = Math.max(0, ...(bundle.dependsOn ?? []).map(visit))
    visiting.delete(bundleId)
    const total = Number(bundle.budgetMs) + dependencyBudget
    memo.set(bundleId, total)
    return total
  }
  return Math.max(0, ...bundles.keys().map(visit))
}

export function validateLocalProfiles(localProfiles, tiers) {
  const errors = []
  for (const [profileId, profile] of profileEntries(localProfiles)) {
    if (!Number.isFinite(profile?.budgetMs) || profile.budgetMs <= 0) {
      errors.push(`localProfiles.${profileId}.budgetMs must be positive`)
    }
    if (profileId === 'production' && profile?.maxParallel !== 8) {
      errors.push('localProfiles.production.maxParallel must be 8')
    }
    if (profileId === 'production' && profile?.cpuUnits !== 8) {
      errors.push('localProfiles.production.cpuUnits must be 8')
    }
    if (profileId === 'production' && profile?.memoryGiB !== 10) {
      errors.push('localProfiles.production.memoryGiB must be 10')
    }
    if (profileId === 'production' && profile?.maxInitialLoad1 !== 4) {
      errors.push('localProfiles.production.maxInitialLoad1 must be 4')
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
      if (!Number.isFinite(bundle.cpuUnits) || bundle.cpuUnits <= 0 || bundle.cpuUnits > profile.cpuUnits) {
        errors.push(`localProfiles.${profileId}.${bundle.id}.cpuUnits must fit the profile capacity`)
      }
      if (!Number.isFinite(bundle.memoryGiB) || bundle.memoryGiB <= 0 || bundle.memoryGiB > profile.memoryGiB) {
        errors.push(`localProfiles.${profileId}.${bundle.id}.memoryGiB must fit the profile capacity`)
      }
      if (!Number.isInteger(bundle.stepMaxParallel)
        || bundle.stepMaxParallel <= 0
        || bundle.stepMaxParallel > profile.maxParallel) {
        errors.push(`localProfiles.${profileId}.${bundle.id}.stepMaxParallel must fit the profile process cap`)
      }
      for (const substitutionError of validateArtifactSubstitutions(bundle, tiers)) {
        errors.push(`localProfiles.${profileId}.${bundle.id}.${substitutionError}`)
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

    const physicalTiers = createLocalBundleTiers(profileId, profile)
    const phaseReservations = new Map()
    for (const tier of physicalTiers) {
      const reservation = phaseReservations.get(tier.phase) ?? { cpuUnits: 0, memoryGiB: 0 }
      reservation.cpuUnits += Number(tier.cpuUnits) || 0
      reservation.memoryGiB += Number(tier.memoryGiB) || 0
      phaseReservations.set(tier.phase, reservation)
    }
    for (const [phase, reservation] of phaseReservations) {
      if (reservation.cpuUnits > profile.cpuUnits || reservation.memoryGiB > profile.memoryGiB) {
        errors.push(`localProfiles.${profileId} phase ${phase} reservations exceed the profile capacity`)
      }
    }
    const criticalPathBudgetMs = localProfileBudgetCriticalPath(profile)
    if (!Number.isFinite(criticalPathBudgetMs) || criticalPathBudgetMs > profile.budgetMs) {
      errors.push(`localProfiles.${profileId} critical-path budget ${criticalPathBudgetMs} exceeds ${profile.budgetMs}`)
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
