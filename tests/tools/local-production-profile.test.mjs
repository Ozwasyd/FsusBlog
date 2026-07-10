import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  artifactSubstitutionBindingDigest,
  buildLocalProfileProjection,
  createLocalBundleTiers,
  collectLogicalTierIds,
  digestDeclaredOutputs,
  localProfileSystemResources,
  matrixGeneratedRuntimePaths,
  resolveArtifactSubstitutions,
  validateArtifactSubstitutions,
  validateLocalBundleSummary,
  validateLocalProfiles
} from '../../tools/test-matrix/local-profile.mjs'
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'
import { assertLocalProductionCapacity, cleanLocalProductionOutputs } from '../../tools/test-matrix/fresh-production.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const localBundleRunner = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8')
const backendShardRunner = fs.readFileSync(path.join(root, 'tools/test/run-backend-production-shards.mjs'), 'utf8')
const uxRiskRunner = fs.readFileSync(path.join(root, 'tools/ux/run-local-production-risk.mjs'), 'utf8')
const matrixRunner = fs.readFileSync(path.join(root, 'tools/run-test-matrix.mjs'), 'utf8')
const backendBundleRunner = localBundleRunner.slice(
  localBundleRunner.indexOf('async function runBackendTests()'),
  localBundleRunner.indexOf('\nfunction listFiles(')
)
const frontendBundleRunner = localBundleRunner.slice(
  localBundleRunner.indexOf('async function runFrontendTests()'),
  localBundleRunner.indexOf('\nfunction runtimeWaves(')
)

function tier(id, dependsOn = []) {
  return { id, dependsOn }
}

function profile(overrides = {}) {
  return {
    budgetMs: 300_000,
    maxParallel: 8,
    cpuUnits: 8,
    memoryGiB: 10,
    maxInitialLoad1: 4,
    bundles: [
      { id: 'build-static', command: 'build', budgetMs: 70_000, dependsOn: [], members: ['a'], cpuUnits: 3, memoryGiB: 3, stepMaxParallel: 3 },
      { id: 'backend', command: 'backend', budgetMs: 110_000, dependsOn: [], members: ['b'], cpuUnits: 3, memoryGiB: 4, stepMaxParallel: 3 },
      { id: 'frontend', command: 'frontend', budgetMs: 110_000, dependsOn: [], members: ['c'], cpuUnits: 2, memoryGiB: 3, stepMaxParallel: 2 },
      { id: 'runtime-browser', command: 'runtime', budgetMs: 90_000, dependsOn: ['build-static', 'backend', 'frontend'], members: ['d'], cpuUnits: 8, memoryGiB: 10, stepMaxParallel: 8 },
      { id: 'performance-evidence', command: 'performance', budgetMs: 80_000, dependsOn: ['runtime-browser'], members: ['production'], cpuUnits: 8, memoryGiB: 10, stepMaxParallel: 8 }
    ],
    summaryOnly: [],
    ...overrides
  }
}

test('collectLogicalTierIds returns the complete dependency closure', () => {
  const tiers = [
    tier('production', ['summary']),
    tier('summary', ['a', 'b']),
    tier('a'),
    tier('b', ['c']),
    tier('c'),
    tier('unrelated')
  ]

  assert.deepEqual(
    collectLogicalTierIds(tiers, 'production'),
    ['a', 'b', 'c', 'production', 'summary']
  )
})

test('production profile requires exact fresh logical-tier coverage', () => {
  const tiers = [tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')]
  assert.deepEqual(validateLocalProfiles({ production: profile() }, tiers), [])

  const duplicate = profile({
    bundles: profile().bundles.map((bundle) => bundle.id === 'backend'
      ? { ...bundle, members: ['a', 'b'] }
      : bundle)
  })
  assert.ok(validateLocalProfiles({ production: duplicate }, tiers).some((error) => error.includes('mapped more than once: a')))

  const missing = profile({
    bundles: profile().bundles.map((bundle) => bundle.id === 'runtime-browser'
      ? { ...bundle, members: [] }
      : bundle)
  })
  assert.ok(validateLocalProfiles({ production: missing }, tiers).some((error) => error.includes('missing logical tier: d')))
})

test('production profile fixes the approved local resource and bundle contract', () => {
  const errors = validateLocalProfiles({ production: profile({ budgetMs: 0 }) }, [
    tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
  ])
  assert.ok(errors.some((error) => error.includes('budgetMs must be positive')))

  const wrongCount = profile({ bundles: profile().bundles.slice(0, 4) })
  assert.ok(validateLocalProfiles({ production: wrongCount }, [
    tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
  ]).some((error) => error.includes('exactly 5 bundles')))
})

test('local production reserves the declared profile memory budget for independent bundles', () => {
  assert.deepEqual(
    localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 11, load1: 3.5 }),
    { cpuCount: 8, availableCpuUnits: 8, availableMemoryGiB: 10, load1: 3.5 }
  )
  assert.throws(
    () => localProfileSystemResources(profile(), { cpuCount: 7, availableMemoryGiB: 11, load1: 0 }),
    /at least 8 available CPU/u
  )
  assert.throws(
    () => localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 9, load1: 0 }),
    /at least 10 GiB available memory/u
  )
  assert.throws(
    () => localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 11, load1: 4.1 }),
    /load1 must be at most 4/u
  )
})

test('declared output digests fail closed for missing direct and wildcard artifacts', () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-artifacts-'))
  fs.mkdirSync(path.join(temp, '.tmp/evidence/nested'), { recursive: true })
  fs.writeFileSync(path.join(temp, '.tmp/evidence/result.json'), '{"status":"success"}\n')
  fs.writeFileSync(path.join(temp, '.tmp/evidence/nested/screenshot.png'), 'fixture')

  const digests = digestDeclaredOutputs(temp, [
    '.tmp/evidence/result.json',
    '.tmp/evidence/**/*.png',
    '.tmp/evidence'
  ])
  assert.deepEqual(Object.keys(digests), [
    '.tmp/evidence',
    '.tmp/evidence/**/*.png',
    '.tmp/evidence/result.json'
  ])
  assert.ok(Object.values(digests).every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest)))
  assert.throws(
    () => digestDeclaredOutputs(temp, ['.tmp/evidence/missing.json']),
    /declared artifact is missing: \.tmp\/evidence\/missing\.json/u
  )
  assert.throws(
    () => digestDeclaredOutputs(temp, ['.tmp/evidence/**/missing.png']),
    /declared artifact is missing: \.tmp\/evidence\/\*\*\/missing\.png/u
  )
})

test('artifact substitutions use a parser-compatible flat contract and reject ambiguous mappings', () => {
  const canonicalPath = '.tmp/backend-unit'
  const actualSummary = '.tmp/test-results/backend/production/summary.json'
  const actualCoverage = '.tmp/coverage/backend-merged/Summary.json'
  const encoded = `backend-unit::${canonicalPath}=>${actualSummary}|${actualCoverage}`
  const parsed = parseMatrix([
    'localProfiles:',
    '  fixture:',
    '    bundles:',
    '      - id: backend',
    `        artifactSubstitutions: [${encoded}]`,
    'tiers:'
  ].join('\n'))
  assert.deepEqual(parsed.localProfiles.fixture.bundles[0].artifactSubstitutions, [encoded])

  const matrixTiers = [{
    id: 'backend-unit',
    artifacts: [canonicalPath],
    evidence: [`${canonicalPath}/summary.json`]
  }]
  const bundle = {
    id: 'backend',
    members: ['backend-unit'],
    artifactSubstitutions: [encoded]
  }
  assert.deepEqual(validateArtifactSubstitutions(bundle, matrixTiers), [])
  assert.deepEqual(resolveArtifactSubstitutions(bundle, matrixTiers), {
    'backend-unit': {
      [canonicalPath]: [actualCoverage, actualSummary],
      [`${canonicalPath}/summary.json`]: [actualCoverage, actualSummary]
    }
  })

  const invalidContracts = [
    { value: [], error: /must be a non-empty flat array/u },
    { value: ['malformed'], error: /entry is malformed/u },
    { value: [`unknown::${canonicalPath}=>${actualSummary}`], error: /unknown bundle tier/u },
    { value: [`backend-unit::.tmp/unknown=>${actualSummary}`], error: /unknown canonical path/u },
    { value: [`backend-unit::${canonicalPath}=>../outside/Summary.json`], error: /invalid actual proof path/u },
    { value: [`backend-unit::${canonicalPath}=>tests/backend/Summary.json`], error: /must be generated runtime paths/u },
    { value: [`backend-unit::${canonicalPath}=>.tmp/local-production/backend/steps/tests.log`], error: /cannot use command logs/u },
    { value: [`backend-unit::${canonicalPath}=>.tmp/runtime/result.json`], error: /must include a TRX, coverage, or summary proof/u },
    { value: [`backend-unit::${canonicalPath}=>${actualSummary}|${actualSummary}`], error: /duplicate actual proof paths/u },
    { value: [`backend-unit::${canonicalPath}=>${actualSummary}`, `backend-unit::./${canonicalPath}=>${actualCoverage}`], error: /duplicate canonical path/u },
    { value: [`backend-unit::${canonicalPath}=>${canonicalPath}`], error: /cannot substitute itself/u }
  ]
  for (const fixture of invalidContracts) {
    const errors = validateArtifactSubstitutions({
      id: 'backend',
      members: ['backend-unit'],
      artifactSubstitutions: fixture.value
    }, matrixTiers)
    assert.ok(errors.some((error) => fixture.error.test(error)), `${fixture.value}: ${errors.join('; ')}`)
  }
})

test('repository production profile maps all 77 logical tiers exactly once', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const logicalTierIds = collectLogicalTierIds(matrix.tiers, 'production')

  assert.equal(logicalTierIds.length, 77)
  assert.ok(logicalTierIds.includes('ux-viewport-plan-progress'))
  assert.equal(logicalTierIds.includes('ux-viewport-canary-parity'), false)
  assert.equal(matrix.localProfiles.production.bundles.length, 5)
  assert.equal(matrix.localProfiles.production.budgetMs, 1_800_000)
  assert.deepEqual(matrix.localProfiles.production.bundles.map((bundle) => bundle.budgetMs), [
    180_000, 240_000, 240_000, 900_000, 480_000
  ])
  assert.equal(matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'frontend-tests')?.budgetMs, 240_000)
  const frontendBundle = matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'frontend-tests')
  const frontendSubstitutions = resolveArtifactSubstitutions(frontendBundle, matrix.tiers)['frontend-property-model-perf']
  for (const canonical of [
    '.tmp/test-results/vitest/property',
    '.tmp/test-results/vitest/model'
  ]) {
    assert.ok(frontendSubstitutions[canonical].includes('.tmp/test-results/vitest/production-coverage'))
    assert.equal(frontendSubstitutions[canonical].some((entry) => /\/(?:property|model)-coverage$/u.test(entry)), false)
  }
  assert.ok(frontendSubstitutions['.tmp/test-results/vitest/perf'].includes('.tmp/test-results/vitest/production'))
  assert.deepEqual(validateLocalProfiles(matrix.localProfiles, matrix.tiers), [])
})

test('production checkpoint projection binds all 77 logical tiers to one fresh run and source state', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const production = matrix.localProfiles.production
  const matrixById = new Map(matrix.tiers.map((entry) => [entry.id, entry]))
  const runId = 'production-fresh-projection'
  const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const bundleSummaries = Object.fromEntries(production.bundles.map((bundle, bundleIndex) => [bundle.id, {
    schema: 'fsusblog.local-production.bundle.v1',
    physicalBundleId: bundle.id,
    executionSource: 'fresh',
    status: 'success',
    schedulerRunId: runId,
    members: Object.fromEntries(bundle.members.map((tierId, memberIndex) => {
      const runtimePaths = matrixGeneratedRuntimePaths(matrixById.get(tierId))
      const substitutions = resolveArtifactSubstitutions(bundle, matrix.tiers)[tierId] ?? {}
      const artifactDigests = {
        [`.tmp/local-production/${bundle.id}/steps/${tierId}.log`]: `sha256:${'c'.repeat(64)}`
      }
      const artifactSubstitutionProofs = {}
      for (const runtimePath of runtimePaths) {
        const actualPaths = substitutions[runtimePath]
        if (!actualPaths) {
          artifactDigests[runtimePath] = `sha256:${'c'.repeat(64)}`
          continue
        }
        const actualDigests = Object.fromEntries(actualPaths.map((actualPath) => [
          actualPath,
          `sha256:${'f'.repeat(64)}`
        ]))
        const canonicalDigest = artifactSubstitutionBindingDigest(runtimePath, actualDigests)
        artifactDigests[runtimePath] = canonicalDigest
        Object.assign(artifactDigests, actualDigests)
        artifactSubstitutionProofs[runtimePath] = {
          canonicalPath: runtimePath,
          canonicalDigest,
          actualPaths,
          actualDigests
        }
      }
      return [tierId, {
        status: 'success',
        durationMs: (bundleIndex + 1) * 1_000 + memberIndex,
        testIds: [`test:${tierId}`],
        artifactProofMode: runtimePaths.length === 0
          ? 'command-log-and-test-ids'
          : (Object.keys(substitutions).length > 0
              ? 'matrix-runtime-artifacts-with-substitutions'
              : 'matrix-runtime-artifacts'),
        matrixRuntimePaths: runtimePaths,
        artifactSubstitutionProofs,
        artifactDigests
      }]
    }))
  }]))
  const checkpoint = {
    schema: 'fsusblog.test-matrix.checkpoint.v1',
    runId,
    targetTierId: 'production',
    mode: 'fresh',
    status: 'success',
    sourceState,
    tiers: Object.fromEntries(production.bundles.map((bundle) => [`local-production-${bundle.id}`, {
      status: 'success',
      reused: false,
      outputs: { [`.tmp/local-production/${bundle.id}/summary.json`]: `file:33188:1:${'d'.repeat(64)}` }
    }]))
  }
  const summaryOnlyEvidence = {
    'security-authenticated-dast': {
      schema: 'fsusblog.local-production.summary-only.v1',
      tierId: 'security-authenticated-dast',
      status: 'collected-blocked',
      executionSource: 'external-environment',
      schedulerRunId: runId,
      sourceState,
      evidencePath: '.tmp/local-production/summary-only/security-authenticated-dast.json',
      artifactDigest: `sha256:${'e'.repeat(64)}`
    }
  }

  const projection = buildLocalProfileProjection({
    profileId: 'production',
    profile: production,
    tiers: matrix.tiers,
    checkpoint,
    bundleSummaries,
    summaryOnlyEvidence
  })

  assert.equal(projection.schema, 'fsusblog.local-profile-projection.v1')
  assert.equal(projection.runId, runId)
  assert.deepEqual(projection.sourceState, sourceState)
  assert.equal(projection.logicalTierCount, 77)
  assert.equal(projection.executedTierCount, 76)
  assert.equal(projection.summaryOnlyTierCount, 1)
  assert.equal(Object.keys(projection.entries).length, 77)
  assert.equal(projection.entries.integration.physicalBundleId, 'runtime-browser')
  assert.equal(projection.entries.integration.executionSource, 'fresh')
  assert.equal(projection.entries.integration.artifactProofMode, 'matrix-runtime-artifacts')
  assert.ok(projection.entries.integration.matrixRuntimePaths.includes('.tmp/runtime/integration.json'))
  assert.ok(projection.entries['release-evidence'].matrixRuntimePaths.includes('.tmp/release-evidence/*/manifest.json'))
  assert.ok(projection.entries.production.matrixRuntimePaths.includes('.tmp/perf'))
  assert.equal(projection.entries['security-authenticated-dast'].evidenceKind, 'summary-only')
  assert.equal(projection.entries['security-authenticated-dast'].status, 'collected-blocked')

  const substitutedProduction = structuredClone(production)
  const substitutedRuntimeBundle = substitutedProduction.bundles
    .find((entry) => entry.members.includes('integration'))
  const canonicalPath = '.tmp/runtime/integration.json'
  const actualPaths = [
    '.tmp/coverage/merged/Summary.json',
    '.tmp/test-results/backend/production/summary.json'
  ]
  substitutedRuntimeBundle.artifactSubstitutions = [
    `integration::${canonicalPath}=>${actualPaths.join('|')}`
  ]
  const substitutedBundleSummaries = structuredClone(bundleSummaries)
  const substitutedEvidence = substitutedBundleSummaries[substitutedRuntimeBundle.id].members.integration
  const actualDigests = Object.fromEntries(actualPaths.map((actualPath) => [
    actualPath,
    `sha256:${'f'.repeat(64)}`
  ]))
  const canonicalDigest = artifactSubstitutionBindingDigest(canonicalPath, actualDigests)
  substitutedEvidence.artifactProofMode = 'matrix-runtime-artifacts-with-substitutions'
  substitutedEvidence.artifactDigests[canonicalPath] = canonicalDigest
  Object.assign(substitutedEvidence.artifactDigests, actualDigests)
  substitutedEvidence.artifactSubstitutionProofs = {
    [canonicalPath]: {
      canonicalPath,
      canonicalDigest,
      actualPaths,
      actualDigests
    }
  }
  const substitutedProjection = buildLocalProfileProjection({
    profileId: 'production',
    profile: substitutedProduction,
    tiers: matrix.tiers,
    checkpoint,
    bundleSummaries: substitutedBundleSummaries,
    summaryOnlyEvidence
  })
  assert.equal(
    substitutedProjection.entries.integration.artifactProofMode,
    'matrix-runtime-artifacts-with-substitutions'
  )
  assert.deepEqual(
    substitutedProjection.entries.integration.artifactSubstitutionProofs[canonicalPath],
    { canonicalPath, canonicalDigest, actualPaths, actualDigests }
  )

  const tamperedSubstitution = structuredClone(substitutedBundleSummaries)
  tamperedSubstitution[substitutedRuntimeBundle.id].members.integration
    .artifactSubstitutionProofs[canonicalPath].actualDigests[actualPaths[0]] = `sha256:${'0'.repeat(64)}`
  assert.throws(() => buildLocalProfileProjection({
    profileId: 'production',
    profile: substitutedProduction,
    tiers: matrix.tiers,
    checkpoint,
    bundleSummaries: tamperedSubstitution,
    summaryOnlyEvidence
  }), /artifact substitution actual digest must match artifactDigests/u)

  assert.throws(() => buildLocalProfileProjection({
    profileId: 'production',
    profile: production,
    tiers: matrix.tiers,
    checkpoint,
    bundleSummaries: {
      ...bundleSummaries,
      'runtime-browser': {
        ...bundleSummaries['runtime-browser'],
        schedulerRunId: 'stale-run'
      }
    },
    summaryOnlyEvidence
  }), /runtime-browser bundle evidence invalid: schedulerRunId must be production-fresh-projection/u)

  assert.throws(() => buildLocalProfileProjection({
    profileId: 'production',
    profile: production,
    tiers: matrix.tiers,
    checkpoint,
    bundleSummaries,
    summaryOnlyEvidence: {}
  }), /missing summary-only evidence: security-authenticated-dast/u)

  const releaseBundle = production.bundles.find((bundle) => bundle.members.includes('release-evidence'))
  const missingRuntimeDigest = structuredClone(bundleSummaries)
  delete missingRuntimeDigest[releaseBundle.id].members['release-evidence']
    .artifactDigests['.tmp/release-evidence/*/manifest.json']
  assert.throws(() => buildLocalProfileProjection({
    profileId: 'production',
    profile: production,
    tiers: matrix.tiers,
    checkpoint,
    bundleSummaries: missingRuntimeDigest,
    summaryOnlyEvidence
  }), /release-evidence is missing the matrix runtime artifact digest: \.tmp\/release-evidence\/\*\/manifest\.json/u)

  assert.throws(() => buildLocalProfileProjection({
    profileId: 'production',
    profile: production,
    tiers: matrix.tiers.filter((entry) => entry.id !== 'integration'),
    checkpoint,
    bundleSummaries,
    summaryOnlyEvidence
  }), /integration is missing from matrix tiers/u)
})

test('local production runner attaches the logical projection only after fresh physical evidence is complete', () => {
  const localProfileRunner = matrixRunner.slice(
    matrixRunner.indexOf('function writeSummaryOnlyEvidence('),
    matrixRunner.indexOf('\nfunction resetFreshJobSummaries(')
  )
  const orderedMarkers = [
    'result = await runDag({',
    'const projectionInput = projectLocalBundleSummaries(',
    'const summaryOnlyEvidence = writeSummaryOnlyEvidence(',
    'buildLocalProfileProjection({',
    'attachCheckpointEvidence('
  ].map((marker) => localProfileRunner.indexOf(marker))

  assert.ok(orderedMarkers.every((index) => index >= 0))
  assert.deepEqual(orderedMarkers, [...orderedMarkers].sort((left, right) => left - right))
  assert.match(localProfileRunner, /if \(result\.status === 'success'\)[\s\S]*?attachCheckpointEvidence/u)
  assert.match(localProfileRunner, /writeSummaryOnlyEvidence\(profileId, profile, runId, result\.checkpoint\.sourceState\)/u)
})

test('backend bundle owns the single project restore before its no-restore build', () => {
  assert.match(backendBundleRunner, /commandStep\('dotnet-restore',[\s\S]*?dotnet restore tests\/backend\/FsusBlog\.Server\.Tests\.csproj/u)
  assert.doesNotMatch(backendBundleRunner, /FsusBlog\.ProductionBackend\.slnx|RestoreUseStaticGraphEvaluation/u)
  assert.equal([...localBundleRunner.matchAll(/\bdotnet restore\b/gu)].length, 1)
  assert.match(backendBundleRunner, /commandStep\('backend-build',[\s\S]*?dotnet build tests\/backend\/FsusBlog\.Server\.Tests\.csproj[^\n]*--no-restore/u)
  assert.match(backendBundleRunner, /const dotnetBuildParallelism = `\/m:\$\{bundleParallelism\(\)\}`/u)
  assert.match(backendBundleRunner, /dotnet build tests\/backend\/FsusBlog\.Server\.Tests\.csproj[^\n]*\$\{dotnetBuildParallelism\}/u)
  assert.match(backendBundleRunner, /FSUSBLOG_BACKEND_PRODUCTION_SHARDS=2 FSUSBLOG_BACKEND_SHARD_PROCESSORS=2 node tools\/test\/run-backend-production-shards\.mjs/u)
  assert.match(backendShardRunner, /Category!=Integration&Category!=Performance/u)
  assert.match(backendShardRunner, /--list-tests/u)
  assert.match(backendShardRunner, /-p:OutputPath=/u)
  assert.match(backendShardRunner, /validateShardRecords\(plan, recordsByShard\)/u)
  const orderedSteps = [
    "commandStep('services'",
    "commandStep('dotnet-restore'",
    "await executeStep(commandStep('backend-build'",
    "await executeStep(commandStep('perception-matrix'",
    'const [result] = await Promise.all([',
    "executeStep(commandStep('perception-evidence-finalize'",
    "executeStep(commandStep('integrity-proof'",
    "await executeStep(commandStep('backend-coverage-summary'"
  ].map((marker) => backendBundleRunner.indexOf(marker))
  assert.ok(orderedSteps.every((index) => index >= 0))
  assert.deepEqual(orderedSteps, [...orderedSteps].sort((left, right) => left - right))
  assert.match(backendBundleRunner, /await executeWave\(\[[\s\S]*?commandStep\('services'[\s\S]*?commandStep\('dotnet-restore'/u)
  assert.match(backendBundleRunner, /commandStep\('perception-evidence-finalize',[\s\S]*?perception-v2-e2e-runtime\.json[\s\S]*?perception-v2-release-evidence\.json[\s\S]*?perception-v2-test-matrix\.json/u)
  assert.match(backendBundleRunner, /commandStep\('integrity-proof',[\s\S]*?integrity-proof-verification\.json/u)
  assert.doesNotMatch(backendBundleRunner, /commandStep\('benchmark-build'/u)
  assert.match(frontendBundleRunner, /FSUSBLOG_VITEST_MAX_WORKERS=\$\{bundleParallelism\(\)\}[\s\S]*?npx vitest run/u)
  const backendPerf = localBundleRunner.indexOf("commandStep('backend-perf'")
  const benchmarkRegression = localBundleRunner.indexOf("commandStep('backend-benchmark'")
  assert.ok(backendPerf > 0 && backendPerf < benchmarkRegression)
  const runtimeIntegration = localBundleRunner.indexOf("commandStep('runtime-integration'")
  const releasePublic = localBundleRunner.indexOf("commandStep('release-public'")
  assert.ok(runtimeIntegration > 0 && runtimeIntegration < releasePublic)
  assert.match(localBundleRunner.slice(runtimeIntegration, releasePublic), /\]\s*,\s*\[/u)
})

test('post-build production evidence stays out of the build bundle without being omitted', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const bundles = new Map(matrix.localProfiles.production.bundles.map((bundle) => [bundle.id, bundle.members]))
  const deferred = [
    'backend-build-governance',
    'integrity-proof-verification',
    'perception-v2-test-matrix',
    'cross-stack-contract',
    'privacy-zk-comment-matrix',
    'static-governance',
    'aeds-frame-cost',
    'aeds-compression-profile'
  ]

  for (const tierId of deferred) assert.equal(bundles.get('build-static').includes(tierId), false, tierId)
  assert.ok(bundles.get('build-static').includes('ux-viewport-plan-progress'))
  assert.equal(bundles.get('runtime-browser').includes('ux-viewport-canary-parity'), false)
  assert.match(localBundleRunner, /commandStep\('viewport-plan-progress', 'node tools\/ux\/run-viewport-plan-progress\.mjs', \['ux-viewport-plan-progress'\],[\s\S]*?viewport-plan-progress\.json/u)
  for (const tierId of ['backend-build-governance', 'integrity-proof-verification', 'perception-v2-test-matrix']) {
    assert.ok(bundles.get('backend-tests').includes(tierId), tierId)
  }
  for (const tierId of ['cross-stack-contract', 'privacy-zk-comment-matrix', 'static-governance']) {
    assert.ok(bundles.get('runtime-browser').includes(tierId), tierId)
  }
  for (const tierId of ['aeds-frame-cost', 'aeds-compression-profile']) {
    assert.ok(bundles.get('performance-evidence').includes(tierId), tierId)
  }
})

test('fresh production cleanup removes outputs and preserves dependency caches', () => {
  const buildEnvironment = fs.readFileSync(path.join(root, 'tools/build-with-data-env.sh'), 'utf8')
  assert.match(buildEnvironment, /DEPENDENCY_CACHE_ROOT=.*\.tmp\/dependency-cache\/dotnet/u)
  assert.match(buildEnvironment, /DOTNET_CLI_HOME="\$\{DEPENDENCY_CACHE_ROOT\}\/dotnet-cli"/u)
  assert.match(buildEnvironment, /NUGET_PACKAGES="\$\{DEPENDENCY_CACHE_ROOT\}\/nuget\/packages"/u)
  assert.match(buildEnvironment, /NUGET_SCRATCH="\$\{DATA_ROOT\}\/tmp\/nuget-scratch"/u)
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-fresh-production-'))
  const generated = [
    '.tmp/stale/result.json',
    'src/frontend/coverage/unit/result.json',
    'src/frontend/test-results/result.json',
    'src/frontend/dist/index.html',
    'src/frontend/public/wasm/aeds_decoder.wasm',
    'src/frontend/wasm/build-basic/aeds_decoder.wasm',
    'src/backend/wwwroot/index.html',
    'src/backend/bin/Debug/server.dll',
    'src/core/obj/project.assets.json',
    'tests/backend/bin/Debug/tests.dll'
  ]
  const caches = [
    'src/frontend/node_modules/vitest/package.json',
    'src/frontend/wasm/.emscripten-cache/sysroot/cache.txt',
    '.tmp/emscripten-cache/sysroot/cache.txt',
    '.tmp/dependency-cache/dotnet/nuget/packages/example/package.nupkg',
    '.tmp/dependency-cache/dotnet/dotnet-cli/.dotnet/initialized',
    '.tmp/data-root/cache/dev/nuget/packages/example/package.nupkg',
    '.tmp/data-root/cache/dev/dotnet-cli/.dotnet/initialized',
    '.nuget/packages/cache.txt'
  ]
  for (const file of [...generated, ...caches]) {
    fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true })
    fs.writeFileSync(path.join(temp, file), 'fixture')
  }

  cleanLocalProductionOutputs(temp)

  for (const file of generated) assert.equal(fs.existsSync(path.join(temp, file)), false, file)
  for (const file of caches) assert.equal(fs.existsSync(path.join(temp, file)), true, file)
})

test('fresh production capacity preflight checks the real Docker data filesystem', () => {
  const measured = []
  const result = assertLocalProductionCapacity({
    root: '/workspace/fsusblog',
    minimumFreeBytes: 4 * 1024 ** 3,
    resolveDockerRootDirectory: () => '/mnt/docker-data',
    measureAvailableBytes: (directory) => {
      measured.push(directory)
      return 8 * 1024 ** 3
    }
  })
  assert.deepEqual(measured, ['/workspace/fsusblog', '/mnt/docker-data'])
  assert.equal(result.measurements.length, 2)

  assert.throws(() => assertLocalProductionCapacity({
    root: '/workspace/fsusblog',
    minimumFreeBytes: 4 * 1024 ** 3,
    resolveDockerRootDirectory: () => '/mnt/docker-data',
    measureAvailableBytes: (directory) => directory === '/mnt/docker-data' ? 0 : 8 * 1024 ** 3
  }), /Docker data filesystems: \/mnt\/docker-data has 0\.0 GiB/u)
})

test('acceptance services enforce a bounded log file size', () => {
  const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  assert.match(source, /FSUSBLOG_ACCEPTANCE_LOG_MAX_KIB:-262144/u)
  assert.match(source, /ulimit -f "\$ACCEPTANCE_LOG_MAX_KIB"/u)
})

test('acceptance service ports stay below the kernel ephemeral range and Vite cannot drift', () => {
  const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  for (const range of ['20000 21999', '22000 23999', '24000 25999', '26000 27999', '28000 29999']) {
    assert.match(source, new RegExp(`find_free_port ${range}`, 'u'))
  }
  assert.equal((source.match(/--strictPort/gu) ?? []).length, 2)
  assert.match(source, /process exited before becoming ready at \$url/u)
})

test('local production UX risk binds Playwright to the active namespace frontend', () => {
  assert.match(uxRiskRunner, /process\.env\.PLAYWRIGHT_BASE_URL \|\| process\.env\.FSUSBLOG_DEBUG_FRONTEND_URL/u)
  assert.match(uxRiskRunner, /PLAYWRIGHT_BASE_URL: playwrightBaseUrl/u)
  assert.match(uxRiskRunner, /playwrightBaseUrl,/u)
  assert.doesNotMatch(uxRiskRunner, /127\.0\.0\.1:3000/u)
})

test('local production UX risk can resume the current matching viewport run', () => {
  assert.match(uxRiskRunner, /process\.env\.FSUSBLOG_UX_VIEWPORT_RESUME === '1'/u)
  assert.match(uxRiskRunner, /FSUSBLOG_UX_VIEWPORT_RESUME: resume \? '1' : '0'/u)
  assert.match(uxRiskRunner, /resume \? \{\} : \{/u)
  assert.match(uxRiskRunner, /executionSource: resume \? 'resume' : 'fresh'/u)
})

test('local production UX risk dynamically fills isolated Playwright workers', () => {
  assert.match(uxRiskRunner, /os\.availableParallelism/u)
  assert.match(uxRiskRunner, /Math\.min\(riskPlan\.counts\.routeThemeGroups, workerCapacity\)/u)
  assert.match(uxRiskRunner, /FSUSBLOG_PLAYWRIGHT_WORKERS: String\(riskWorkers\)/u)
  assert.match(uxRiskRunner, /FSUSBLOG_TEST_SESSION_ISOLATION: '1'/u)
  assert.match(uxRiskRunner, /FSUSBLOG_UX_VIEWPORT_WORKERS: String\(riskWorkers\)/u)
  assert.match(uxRiskRunner, /FSUSBLOG_PLAYWRIGHT_TRACE: 'off'/u)
})

test('physical bundle DAG preserves dependencies, resources, and exact budgets', () => {
  const bundles = createLocalBundleTiers('production', profile())
  assert.deepEqual(bundles.map((bundle) => bundle.id), [
    'local-production-build-static',
    'local-production-backend',
    'local-production-frontend',
    'local-production-runtime-browser',
    'local-production-performance-evidence'
  ])
  assert.deepEqual(bundles[0].dependsOn, [])
  assert.deepEqual(bundles[1].dependsOn, [])
  assert.deepEqual(bundles[2].dependsOn, [])
  assert.deepEqual(bundles[3].dependsOn, [
    'local-production-build-static',
    'local-production-backend',
    'local-production-frontend'
  ])
  assert.deepEqual(bundles[4].dependsOn, ['local-production-runtime-browser'])
  assert.equal(bundles[0].budgetMs, 70_000)
  assert.equal(bundles[1].budgetMs, 110_000)
  assert.equal(bundles[2].budgetMs, 110_000)
  assert.equal(bundles[0].artifacts[0], '.tmp/local-production/build-static/summary.json')
})

test('bundle evidence must prove every member with executed IDs and digests', () => {
  const valid = {
    schema: 'fsusblog.local-production.bundle.v1',
    physicalBundleId: 'backend',
    executionSource: 'fresh',
    status: 'success',
    members: {
      a: { status: 'success', durationMs: 10, testIds: ['backend:A'], artifactDigests: { trx: `sha256:${'a'.repeat(64)}` } },
      b: { status: 'success', durationMs: 20, testIds: ['backend:B'], artifactDigests: { trx: `sha256:${'b'.repeat(64)}` } }
    }
  }
  assert.deepEqual(validateLocalBundleSummary(valid, { id: 'backend', members: ['a', 'b'] }), [])
  assert.ok(validateLocalBundleSummary({ ...valid, members: { a: valid.members.a } }, {
    id: 'backend', members: ['a', 'b']
  }).some((error) => error.includes('missing member evidence: b')))
  assert.ok(validateLocalBundleSummary({
    ...valid,
    members: { ...valid.members, a: { ...valid.members.a, testIds: [] } }
  }, { id: 'backend', members: ['a', 'b'] }).some((error) => error.includes('a.testIds')))
  assert.ok(validateLocalBundleSummary({
    ...valid,
    schedulerRunId: 'stale'
  }, { id: 'backend', members: ['a', 'b'] }, { expectedRunId: 'fresh' })
    .some((error) => error.includes('schedulerRunId must be fresh')))
})

test('bundle evidence is bound to matrix runtime declarations or an explicit command-log fallback', () => {
  const runtimeTier = {
    id: 'runtime-tier',
    artifacts: ['.tmp/runtime/result.json'],
    evidence: ['tests/runtime.test.mjs', '.tmp/runtime/result.json']
  }
  const pureTier = {
    id: 'pure-tier',
    artifacts: [],
    evidence: ['tests/pure.test.mjs']
  }
  const valid = {
    schema: 'fsusblog.local-production.bundle.v1',
    physicalBundleId: 'fixture',
    executionSource: 'fresh',
    status: 'success',
    members: {
      'runtime-tier': {
        status: 'success',
        durationMs: 10,
        testIds: ['test:runtime'],
        artifactProofMode: 'matrix-runtime-artifacts',
        matrixRuntimePaths: ['.tmp/runtime/result.json'],
        artifactSubstitutionProofs: {},
        artifactDigests: {
          '.tmp/local-production/fixture/steps/runtime.log': `sha256:${'a'.repeat(64)}`,
          '.tmp/runtime/result.json': `sha256:${'b'.repeat(64)}`
        }
      },
      'pure-tier': {
        status: 'success',
        durationMs: 5,
        testIds: ['test:pure'],
        artifactProofMode: 'command-log-and-test-ids',
        matrixRuntimePaths: [],
        artifactSubstitutionProofs: {},
        artifactDigests: {
          '.tmp/local-production/fixture/steps/pure.log': `sha256:${'c'.repeat(64)}`
        }
      }
    }
  }
  const options = { matrixTiers: [runtimeTier, pureTier], profileId: 'production' }
  assert.deepEqual(validateLocalBundleSummary(valid, {
    id: 'fixture', members: ['runtime-tier', 'pure-tier']
  }, options), [])

  const missingRuntimeDigest = structuredClone(valid)
  delete missingRuntimeDigest.members['runtime-tier'].artifactDigests['.tmp/runtime/result.json']
  assert.ok(validateLocalBundleSummary(missingRuntimeDigest, {
    id: 'fixture', members: ['runtime-tier', 'pure-tier']
  }, options).some((error) => error.includes('missing the matrix runtime artifact digest')))

  const logOnlyRuntime = structuredClone(valid)
  logOnlyRuntime.members['runtime-tier'].artifactProofMode = 'command-log-and-test-ids'
  assert.ok(validateLocalBundleSummary(logOnlyRuntime, {
    id: 'fixture', members: ['runtime-tier', 'pure-tier']
  }, options).some((error) => error.includes('artifactProofMode must be matrix-runtime-artifacts')))

  const pureWithoutLog = structuredClone(valid)
  pureWithoutLog.members['pure-tier'].artifactDigests = { receipt: `sha256:${'d'.repeat(64)}` }
  assert.ok(validateLocalBundleSummary(pureWithoutLog, {
    id: 'fixture', members: ['runtime-tier', 'pure-tier']
  }, options).some((error) => error.includes('must provide a command log digest')))
})

test('local bundle runner never silently drops a declared artifact', () => {
  assert.match(localBundleRunner, /const artifactDigests = digestDeclaredOutputs\(root, declaredArtifacts\)/u)
  assert.match(localBundleRunner, /const substitutionsByTier = resolveArtifactSubstitutions\(bundle, matrix\.tiers\)/u)
  assert.match(localBundleRunner, /const allRuntimeDigests = digestDeclaredOutputs\(root,[\s\S]*?allRuntimeDigests\[canonicalPath\]/u)
  assert.match(localBundleRunner, /artifactSubstitutionBindingDigest\(canonicalPath, actualDigests\)[\s\S]*?artifactSubstitutionProofs\[canonicalPath\]/u)
  assert.match(localBundleRunner, /bindMatrixRuntimeArtifacts\(\)[\s\S]*?const members =/u)
  assert.doesNotMatch(localBundleRunner, /artifactFiles\][\s\S]{0,120}filter\(\(file\) => fs\.existsSync\(file\)\)/u)
})
