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
  localProfileBudgetCriticalPath,
  performanceMixedWindowFloorMs,
  matrixGeneratedRuntimePaths,
  resolveLocalProfileResources,
  resolveArtifactSubstitutions,
  resolveFrontendVitestAdmissionFloor,
  validateArtifactSubstitutions,
  validateLocalBundleSummary,
  validatePerformanceDeadlineEvidence,
  validateLocalProfileCheckpointDuration,
  validateLocalProfileRunSummary,
  validateLocalProfiles
} from '../../tools/test-matrix/local-profile.mjs'
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'
import { assertLocalProductionCapacity, cleanLocalProductionOutputs } from '../../tools/test-matrix/fresh-production.mjs'
import { buildMixedWindowPlan } from '../../tools/test/run-mixed-performance-window.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const localBundleRunner = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8')
const localBundleSteps = fs.readFileSync(path.join(root, 'tools/test/bundles/bundle-steps.mjs'), 'utf8')
const backendShardRunner = fs.readFileSync(path.join(root, 'tools/test/run-backend-production-shards.mjs'), 'utf8')
const uxRiskRunner = fs.readFileSync(path.join(root, 'tools/ux/run-local-production-risk.mjs'), 'utf8')
const releasePreviewReadiness = fs.readFileSync(path.join(root, 'tools/ux/release-preview-readiness.mjs'), 'utf8')
const matrixRunner = fs.readFileSync(path.join(root, 'tools/run-test-matrix.mjs'), 'utf8')
const backendBundleRunner = localBundleRunner.slice(
  localBundleRunner.indexOf('async function runBackendTests()'),
  localBundleRunner.indexOf('\nfunction listFiles(')
)
const frontendBundleRunner = localBundleRunner.slice(
  localBundleRunner.indexOf('async function runFrontendTests()'),
  localBundleRunner.indexOf('\nasync function run()')
)

function tier(id, dependsOn = []) {
  return { id, dependsOn }
}

function profile(overrides = {}) {
  return {
    budgetMs: 300_000,
    minimumSupportedCpuUnits: 4,
    memoryReserveShare: 0.05,
    bundles: [
      { id: 'build-static', command: 'build', deadlineWeight: 18, dependsOn: [], members: ['a'], cpuWeight: 2, memoryWeight: 3, minCpuUnits: 1, startupMinCpuUnits: 1, startupMemoryWeight: 3, startupPriority: 3 },
      { id: 'backend-tests', command: 'backend', deadlineWeight: 44, dependsOn: [], members: ['b'], cpuWeight: 3, memoryWeight: 4, minCpuUnits: 2, startupMinCpuUnits: 1, startupMemoryWeight: 4, startupPriority: 4 },
      { id: 'frontend-tests', command: 'frontend', deadlineWeight: 27, dependsOn: [], members: ['c'], cpuWeight: 3, memoryWeight: 2, minCpuUnits: 1, startupMinCpuUnits: 1, startupMemoryWeight: 2, startupPriority: 3 },
      { id: 'runtime-browser', command: 'runtime', deadlineWeight: 24, dependsOn: [], members: ['d'], cpuWeight: 5, memoryWeight: 5, minCpuUnits: 1, startupMinCpuUnits: 1, startupMemoryWeight: 5, startupPriority: 4 },
      { id: 'performance-evidence', command: 'performance', deadlineWeight: 36, minimumDeadlineShare: 0.25, dependsOn: [], members: ['production'], cpuWeight: 8, memoryWeight: 10, minCpuUnits: 1, startupMinCpuUnits: 1, startupMemoryWeight: 10, startupPriority: 1 }
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
    bundles: profile().bundles.map((bundle) => bundle.id === 'backend-tests'
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

  const invalidPacking = profile({
    bundles: profile().bundles.map((bundle) => bundle.id === 'backend-tests'
      ? { ...bundle, cpuWeight: 0, minCpuUnits: 0 }
      : bundle)
  })
  const packingErrors = validateLocalProfiles({ production: invalidPacking }, [
    tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
  ])
  assert.ok(packingErrors.includes('localProfiles.production.backend-tests.cpuWeight must be positive'))
  assert.ok(packingErrors.includes('localProfiles.production.backend-tests.minCpuUnits must be positive'))

  const wrongDag = profile({
    bundles: profile().bundles.map((bundle) => bundle.id === 'runtime-browser'
      ? { ...bundle, dependsOn: ['build-static'] }
      : bundle)
  })
  assert.ok(validateLocalProfiles({ production: wrongDag }, [
    tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
  ]).includes('localProfiles.production.runtime-browser.dependsOn must be []'))

  const wrongRuntimeResources = profile({
    bundles: profile().bundles.map((bundle) => bundle.id === 'runtime-browser'
      ? { ...bundle, deadlineWeight: 0, memoryWeight: 0 }
      : bundle)
  })
  const runtimeResourceErrors = validateLocalProfiles({ production: wrongRuntimeResources }, [
    tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
  ])
  assert.ok(runtimeResourceErrors.includes('localProfiles.production.runtime-browser.deadlineWeight must be positive'))
  assert.ok(runtimeResourceErrors.includes('localProfiles.production.runtime-browser.memoryWeight must be positive'))

  const undersizedFloor = profile({
    minimumSupportedCpuUnits: 3,
    bundles: profile().bundles.map((bundle) => ({ ...bundle, startupMinCpuUnits: 4, minCpuUnits: 4 }))
  })
  assert.ok(validateLocalProfiles({ production: undersizedFloor }, [
    tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
  ]).includes('localProfiles.production smallest startup CPU minimum 4 exceeds supported machine floor 3'))
})

test('legacy local bundles retain explicit startup compatibility fallbacks', () => {
  const legacy = profile({
    minimumSupportedCpuUnits: 5,
    bundles: profile().bundles.map((bundle) => {
      const compatible = { ...bundle }
      delete compatible.startupMinCpuUnits
      delete compatible.startupMemoryWeight
      delete compatible.startupPriority
      return compatible
    })
  })
  const tiers = [tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')]
  assert.deepEqual(validateLocalProfiles({ production: legacy }, tiers), [])
  const resolved = resolveLocalProfileResources(legacy, { availableCpuUnits: 5, availableMemoryGiB: 10 })
  for (const bundle of resolved.bundles) {
    if (bundle.id === 'frontend-tests') {
      assert.equal(bundle.startupMinCpuUnits, 1)
      assert.equal(bundle.minCpuUnits, 2)
    } else {
      assert.equal(bundle.startupMinCpuUnits, bundle.minCpuUnits)
    }
    assert.equal(bundle.startupMemoryWeight, bundle.memoryWeight)
    assert.equal(bundle.startupPriority, 0)
  }
})

test('physical bundle creation rejects malformed resolved startup policy', () => {
  const resolved = resolveLocalProfileResources(profile(), {
    availableCpuUnits: 5,
    availableMemoryGiB: 10
  })
  for (const [label, mutate] of [
    ['zero startup memory weight', (bundle) => ({ ...bundle, startupMemoryWeight: 0 })],
    ['startup CPU above steady minimum', (bundle) => ({
      ...bundle,
      startupMinCpuUnits: bundle.minCpuUnits + 1
    })],
    ['negative startup priority', (bundle) => ({ ...bundle, startupPriority: -1 })]
  ]) {
    const malformed = {
      ...resolved,
      bundles: resolved.bundles.map((bundle, index) => index === 0 ? mutate(bundle) : bundle)
    }
    assert.throws(
      () => createLocalBundleTiers('production', malformed),
      /local bundle resource policy must be resolved/u,
      label
    )
  }
})

test('local production derives full CPU, safe memory and launch parallelism from the machine', () => {
  assert.deepEqual(
    localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 11, load1: 3.5 }),
    {
      cpuCount: 8,
      availableCpuUnits: 8,
      availableMemoryGiB: 10.45,
      load1: 3.5,
      launchParallelism: 8,
      memoryReserveGiB: 0.55
    }
  )
  assert.deepEqual(
    localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 16, load1: 0 }),
    {
      cpuCount: 8,
      availableCpuUnits: 8,
      availableMemoryGiB: 15.2,
      load1: 0,
      launchParallelism: 8,
      memoryReserveGiB: 0.8
    }
  )
  const busy = localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 16, load1: 12 })
  assert.equal(busy.availableCpuUnits, 8)
  assert.equal(busy.load1, 12)
  assert.equal(busy.launchParallelism, 8)
  assert.equal(localProfileSystemResources(profile(), { cpuCount: 7, availableMemoryGiB: 9, load1: 0 }).availableCpuUnits, 7)
  assert.equal(localProfileSystemResources(profile(), { cpuCount: 4, availableMemoryGiB: 9, load1: 0 }).availableCpuUnits, 4)
  assert.throws(() => localProfileSystemResources(profile(), { cpuCount: 3, availableMemoryGiB: 9, load1: 0 }), /at least 4/u)
  assert.throws(() => localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 0, load1: 0 }), /positive available memory/u)
  assert.throws(() => localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 9, load1: -1 }), /non-negative/u)
})

test('local production cleans stale runtimes before measuring machine capacity', () => {
  const runner = matrixRunner.slice(
    matrixRunner.indexOf('async function runLocalProfile('),
    matrixRunner.indexOf('\nfunction resetFreshJobSummaries(')
  )
  const cleanup = runner.indexOf('cleanupStaleLocalRuntimes({')
  const buildServerPreflight = runner.indexOf('const dotnetBuildServerPreflightPids =')
  const measurement = runner.lastIndexOf('const detectedResources = detectResources()')

  assert.ok(cleanup >= 0)
  assert.ok(buildServerPreflight > cleanup)
  assert.ok(measurement > buildServerPreflight)
  assert.ok(measurement > cleanup)
  assert.match(runner, /options\.planOnly \? null : cleanupStaleLocalRuntimes/u)
  assert.match(runner, /discoverUntracked: true/u)
  assert.match(runner, /legacyContainerMinimumAgeMs: profile\.budgetMs \* 2/u)
  assert.match(runner, /orphanTerminationGraceMs: Math\.ceil\(profile\.budgetMs \/ 100\)/u)
  assert.match(runner, /includeInactiveProductionRuns: true/u)
  assert.match(runner, /const dotnetBuildServerPostflightPids = cleanupOrphanDotnetBuildServers/u)
  assert.match(runner, /includeCurrentBinding: true/u)
  assert.match(runner, /preflightOrphanPids: dotnetBuildServerPreflightPids/u)
  assert.match(runner, /postflightOrphanPids: dotnetBuildServerPostflightPids/u)
})

test('production bundle resources resolve from each machine and fill its usable capacity', () => {
  for (const availableCpuUnits of [4, 5, 6, 8, 16]) {
    const resolved = resolveLocalProfileResources(profile(), {
      availableCpuUnits,
      availableMemoryGiB: 18
    })
    assert.deepEqual(resolved.bundles.map((bundle) => bundle.stepMaxParallel), resolved.bundles.map((bundle) => bundle.cpuUnits))
    assert.equal(resolved.bundles.slice(0, 4).reduce((total, bundle) => total + bundle.cpuUnits, 0), availableCpuUnits)
    const criticalPathBudgetMs = localProfileBudgetCriticalPath(resolved)
    assert.ok(criticalPathBudgetMs <= resolved.budgetMs)
    assert.ok(criticalPathBudgetMs >= resolved.budgetMs - resolved.bundles.length)
    const performance = resolved.bundles.find((bundle) => bundle.id === 'performance-evidence')
    assert.ok(performance.budgetMs >= resolved.budgetMs * performance.minimumDeadlineShare)
    assert.ok(performance.budgetMs >= buildMixedWindowPlan().durationMs)
  }

  const fiveCoreDeadlines = resolveLocalProfileResources(profile(), { availableCpuUnits: 5, availableMemoryGiB: 18 })
  const eightCoreDeadlines = resolveLocalProfileResources(profile(), { availableCpuUnits: 8, availableMemoryGiB: 18 })
  assert.notDeepEqual(
    fiveCoreDeadlines.bundles.map((bundle) => bundle.budgetMs),
    eightCoreDeadlines.bundles.map((bundle) => bundle.budgetMs)
  )
  assert.ok(eightCoreDeadlines.bundles.every((bundle) => bundle.budgetMs > 0))

  for (const usableMemoryGiB of [9, 18, 31.5]) {
    const resolved = resolveLocalProfileResources(profile(), { availableCpuUnits: 8, availableMemoryGiB: usableMemoryGiB })
    const memory = resolved.bundles.map((bundle) => bundle.memoryGiB)
    assert.ok(Math.abs(memory.slice(0, 4).reduce((total, value) => total + value, 0) - usableMemoryGiB) < 1e-10)
    assert.ok(Math.abs(memory[0] - usableMemoryGiB * 3 / 14) < 1e-10)
    assert.ok(Math.abs(memory[1] - usableMemoryGiB * 4 / 14) < 1e-10)
    assert.ok(Math.abs(memory[2] - usableMemoryGiB * 2 / 14) < 1e-10)
    assert.ok(Math.abs(memory[3] - usableMemoryGiB * 5 / 14) < 1e-10)
    assert.equal(memory[4], usableMemoryGiB)
  }

  assert.throws(
    () => resolveLocalProfileResources(profile(), { availableCpuUnits: 3, availableMemoryGiB: 9 }),
    /at least 4/u
  )
  const impossibleMinimum = profile({
    bundles: profile().bundles.map((bundle) => bundle.id === 'backend-tests'
      ? { ...bundle, minCpuUnits: 3 }
      : bundle)
  })
  assert.throws(
    () => resolveLocalProfileResources(impossibleMinimum, { availableCpuUnits: 3, availableMemoryGiB: 9 }),
    /requires at least 4 available CPU units from declared minima/u
  )
})

test('frontend steady admission floor follows machine capacity and cannot deadlock its worker host', () => {
  assert.equal(resolveFrontendVitestAdmissionFloor({ cpuCount: 4, eventualFrontendCapacity: 1 }), 1)
  assert.equal(resolveFrontendVitestAdmissionFloor({ cpuCount: 8, eventualFrontendCapacity: 5 }), 3)
  assert.equal(resolveFrontendVitestAdmissionFloor({ cpuCount: 16, eventualFrontendCapacity: 13 }), 4)

  const resolved = resolveLocalProfileResources(profile(), {
    availableCpuUnits: 8,
    availableMemoryGiB: 18
  })
  assert.equal(resolved.bundles.find((bundle) => bundle.id === 'frontend-tests').minCpuUnits, 3)
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

test('repository production profile maps every logical tier exactly once', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const logicalTierIds = collectLogicalTierIds(matrix.tiers, 'production')
  const mappedTierIds = matrix.localProfiles.production.bundles.flatMap((bundle) => bundle.members)

  assert.deepEqual(mappedTierIds.toSorted(), logicalTierIds.toSorted())
  assert.ok(logicalTierIds.includes('ux-viewport-plan-progress'))
  assert.equal(matrix.localProfiles.production.bundles.length, 5)
  assert.equal(Object.hasOwn(matrix.localProfiles.production, 'maxParallel'), false)
  assert.equal(Object.hasOwn(matrix.localProfiles.production, 'cpuUnits'), false)
  assert.equal(Object.hasOwn(matrix.localProfiles.production, 'memoryGiB'), false)
  assert.equal(Object.hasOwn(matrix.localProfiles.production, 'maxInitialLoad1'), false)
  assert.equal(matrix.localProfiles.production.budgetMs, 300_000)
  assert.equal(matrix.localProfiles.production.enforceBudget, false)
  assert.ok(matrix.localProfiles.production.bundles.every((bundle) => bundle.deadlineWeight > 0))
  assert.ok(matrix.localProfiles.production.bundles.every((bundle) => bundle.cpuWeight > 0))
  assert.ok(matrix.localProfiles.production.bundles.every((bundle) => bundle.memoryWeight > 0))
  assert.ok(matrix.localProfiles.production.bundles.every((bundle) => bundle.minCpuUnits > 0))
  assert.deepEqual(
    matrix.localProfiles.production.bundles.slice(0, 3).map((bundle) => bundle.cpuWeight),
    [8, 4, 3]
  )
  assert.equal(
    matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'runtime-browser').cpuWeight,
    2,
    'runtime must receive two live CPU units after build-static releases capacity'
  )
  assert.equal(
    matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'build-static').deadlineWeight,
    18
  )
  assert.equal(
    matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'performance-evidence').minimumDeadlineShare,
    0.2666666667
  )
  assert.equal(
    matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'performance-evidence').startupMemoryWeight,
    0.25,
    'coordination-only startup must not starve build and backend critical-path memory floors'
  )
  assert.ok(matrix.localProfiles.production.bundles.every((bundle) => !Object.hasOwn(bundle, 'budgetMs')))
  assert.ok(matrix.localProfiles.production.bundles.every((bundle) => !Object.hasOwn(bundle, 'cpuUnits')))
  assert.ok(matrix.localProfiles.production.bundles.every((bundle) => !Object.hasOwn(bundle, 'memoryGiB')))
  assert.ok(matrix.localProfiles.production.bundles.every((bundle) => !Object.hasOwn(bundle, 'stepMaxParallel')))
  const frontendBundle = matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'frontend-tests')
  const frontendSubstitutions = resolveArtifactSubstitutions(frontendBundle, matrix.tiers)['frontend-property-model-perf']
  for (const canonical of [
    '.tmp/test-results/vitest/property',
    '.tmp/test-results/vitest/model'
  ]) {
    assert.ok(frontendSubstitutions[canonical].includes('.tmp/test-results/vitest/production-rolling'))
    assert.equal(frontendSubstitutions[canonical].some((entry) => /\/(?:property|model)-coverage$/u.test(entry)), false)
  }
  assert.ok(frontendSubstitutions['.tmp/test-results/vitest/perf'].includes('.tmp/test-results/vitest/production'))
  const runtimeBundle = matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'runtime-browser')
  const runtimeSubstitutions = resolveArtifactSubstitutions(runtimeBundle, matrix.tiers)
  assert.deepEqual(runtimeSubstitutions.security['.tmp/security'], [
    '.tmp/local-production/runtime-browser/member-summaries/security/summary.json'
  ])
  assert.deepEqual(
    runtimeSubstitutions['cross-browser-smoke']['src/frontend/test-results/playwright/cross-browser'],
    [
      '.tmp/local-production/runtime-browser/browser-lanes/cross-browser/playwright',
      '.tmp/local-production/runtime-browser/member-summaries/cross-browser-smoke/summary.json'
    ]
  )
  assert.deepEqual(validateLocalProfiles(matrix.localProfiles, matrix.tiers), [])
})

test('repository production t0 grants scale by weights without exceeding each machine', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const initialIds = ['build-static', 'backend-tests', 'frontend-tests', 'runtime-browser']
  const grantsByCpu = new Map()

  for (const availableCpuUnits of [4, 5, 6, 8, 16]) {
    const resolved = resolveLocalProfileResources(matrix.localProfiles.production, {
      availableCpuUnits,
      availableMemoryGiB: availableCpuUnits * 2
    })
    const grants = initialIds.map((id) => resolved.bundles.find((bundle) => bundle.id === id).cpuUnits)
    grantsByCpu.set(availableCpuUnits, grants)
    assert.equal(grants.reduce((total, value) => total + value, 0), availableCpuUnits)
    assert.ok(grants.every((value) => Number.isInteger(value) && value > 0))
    assert.ok(grants.every((value) => value >= 1), 't0 bundles must retain startup minima')
  }

  assert.deepEqual(grantsByCpu.get(4), [1, 1, 1, 1])
  assert.deepEqual(grantsByCpu.get(5), [1, 2, 1, 1])
  assert.ok(grantsByCpu.get(16)[0] > grantsByCpu.get(8)[0], 'build-static must scale on a larger machine')
})

test('production checkpoint projection binds every logical tier to one fresh run and source state', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const production = matrix.localProfiles.production
  const expectedLogicalTierCount = collectLogicalTierIds(matrix.tiers, 'production').length
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
          `sha256:${'c'.repeat(64)}`
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
  bundleSummaries['performance-evidence'].deadlineEvidence = {
    schema: 'fsusblog.performance-deadline-evidence.v2',
    status: 'sufficient',
    schedulerRunId: runId,
    sourceState,
    candidateBudgetMs: 90_000,
    bundleDurationMs: 80_000,
    coordinationWaitMs: 0,
    preparationWorkMs: 20_000,
    postMeasurementWorkMs: 0,
    measurementIsolation: { status: 'isolated', noiseOverlaps: [] },
    mixedWindow: {
      stepId: 'mixed-performance-window',
      minimumDurationMs: performanceMixedWindowFloorMs,
      measuredDurationMs: 60_000
    },
    measuredOtherSerialMs: 20_000,
    requiredBudgetMs: 80_000,
    steps: [
      { id: 'coverage-merge', evidencePhase: 'preparation', status: 'success', durationMs: 20_000, startedAtMs: 0, finishedAtMs: 20_000 },
      { id: 'mixed-performance-window', evidencePhase: 'measurement', status: 'success', durationMs: 60_000, startedAtMs: 20_000, finishedAtMs: 80_000 },
      { id: 'backend-perf', evidencePhase: 'measurement', status: 'success', durationMs: 20_000, startedAtMs: 80_000, finishedAtMs: 100_000 },
      { id: 'browser-performance', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 100_000, finishedAtMs: 100_000 },
      { id: 'privacy-zk-benchmark', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 100_000, finishedAtMs: 100_000 },
      { id: 'aeds-frame-cost', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 100_000, finishedAtMs: 100_000 }
    ]
  }
  const checkpoint = {
    schema: 'fsusblog.test-matrix.checkpoint.v1',
    runId,
    targetTierId: 'production',
    mode: 'fresh',
    status: 'success',
    budgetMs: null,
    startedAt: '2026-07-12T00:00:00.000Z',
    finishedAt: '2026-07-12T00:04:59.999Z',
    sourceState,
    tiers: Object.fromEntries(production.bundles.map((bundle) => [`local-production-${bundle.id}`, {
      status: 'success',
      reused: false,
      outputs: { [`.tmp/local-production/${bundle.id}/summary.json`]: `file:33188:1:${'d'.repeat(64)}` }
    }]))
  }
  const summaryOnlyEvidence = {}

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
  assert.equal(projection.logicalTierCount, expectedLogicalTierCount)
  assert.equal(projection.executedTierCount, expectedLogicalTierCount)
  assert.equal(projection.summaryOnlyTierCount, 0)
  assert.equal(Object.keys(projection.entries).length, expectedLogicalTierCount)
  assert.equal(projection.entries['production-build-artifacts'].physicalBundleId, 'build-static')
  assert.equal(projection.entries.integration.physicalBundleId, 'runtime-browser')
  assert.equal(projection.entries.integration.executionSource, 'fresh')
  assert.equal(projection.entries.integration.artifactProofMode, 'matrix-runtime-artifacts-with-substitutions')
  assert.ok(projection.entries.integration.matrixRuntimePaths.includes('.tmp/runtime/integration.json'))
  assert.ok(projection.entries['release-evidence'].matrixRuntimePaths.includes('.tmp/release-evidence/*/manifest.json'))
  assert.ok(projection.entries.production.matrixRuntimePaths.includes('.tmp/perf'))
  assert.equal(projection.entries['security-authenticated-dast'].evidenceKind, 'executed')
  assert.equal(projection.entries['security-authenticated-dast'].physicalBundleId, 'runtime-browser')
  assert.equal(projection.entries['security-authenticated-dast'].executionSource, 'fresh')
  assert.deepEqual(validateLocalProfileCheckpointDuration(checkpoint, production), [])
  assert.doesNotThrow(() => buildLocalProfileProjection({
    profileId: 'production',
    profile: production,
    tiers: matrix.tiers,
    checkpoint: { ...checkpoint, finishedAt: '2026-07-12T00:05:00.001Z' },
    bundleSummaries,
    summaryOnlyEvidence
  }))
  assert.equal(projection.entries['security-authenticated-dast'].status, 'success')

  const substitutedProduction = structuredClone(production)
  const substitutedRuntimeBundle = substitutedProduction.bundles
    .find((entry) => entry.members.includes('integration'))
  const canonicalPath = '.tmp/runtime/integration.json'
  const actualPaths = [
    '.tmp/coverage/merged/Summary.json',
    '.tmp/test-results/backend/production/summary.json'
  ]
  substitutedRuntimeBundle.artifactSubstitutions = [
    ...substitutedRuntimeBundle.artifactSubstitutions,
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
    ...substitutedEvidence.artifactSubstitutionProofs,
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
  const freshProjectionRunner = localProfileRunner.slice(localProfileRunner.indexOf('result = await runDag({'))
  const orderedMarkers = [
    'result = await runDag({',
    'const projectionInput = projectLocalBundleSummaries(',
    'const summaryOnlyEvidence = writeSummaryOnlyEvidence(',
    'buildLocalProfileProjection({',
    'attachCheckpointEvidence('
  ].map((marker) => freshProjectionRunner.indexOf(marker))

  assert.ok(orderedMarkers.every((index) => index >= 0))
  assert.deepEqual(orderedMarkers, [...orderedMarkers].sort((left, right) => left - right))
  assert.match(localProfileRunner, /if \(result\.status === 'success' && !options\.resume\)[\s\S]*?attachCheckpointEvidence/u)
  assert.doesNotMatch(localProfileRunner, /fresh-only/u)
  assert.match(localProfileRunner, /isProjectionOnlyCheckpointFailure\(resumeCheckpoint\)[\s\S]*?resumeCheckpointEvidence\([\s\S]*?fresh-projection-resume/u)
  assert.match(localProfileRunner, /physical resume run=\$\{runId\}/u)
  assert.match(localProfileRunner, /prepareProductionBuildLayout\(\{ root, runId, fresh: !options\.resume \}\)/u)
  assert.match(localProfileRunner, /mode: options\.resume \? 'resume' : 'fresh'/u)
  assert.match(localProfileRunner, /resume: options\.resume/u)
  assert.match(localProfileRunner, /reuseAcrossSourceChanges: false/u)
  assert.match(matrixRunner, /function resetResumeRunCoordination\(runsRoot, runId\)[\s\S]*?entry\.name === 'checkpoint\.json'[\s\S]*?removed\.sort\(\)/u)
  assert.match(localProfileRunner, /resetResumeRunCoordination\(runsRoot, runId\)/u)
  assert.match(localProfileRunner, /resume source changed; reset run-bound artifact digest table and \$\{removedCoordination\.length\} coordination file/u)
  assert.match(localProfileRunner, /FSUSBLOG_TEST_EXECUTION_SOURCE: options\.resume \? 'resume' : 'fresh'/u)
  assert.match(localProfileRunner, /executionSource: options\.resume \? 'resume' : 'fresh'/u)
  assert.match(localProfileRunner, /if \(result\.status === 'success' && !options\.resume\)/u)
  assert.match(localBundleRunner, /executionSource: process\.env\.FSUSBLOG_TEST_EXECUTION_SOURCE === 'resume' \? 'resume' : 'fresh'/u)
  assert.match(localProfileRunner, /resume-build-layout\.json/u)
  assert.match(localProfileRunner, /authoritative: false/u)
  assert.match(localProfileRunner, /if \(options\.resume\)[\s\S]*?else \{[\s\S]*?emitProductionResourceUtilization/u)
  assert.match(localProfileRunner, /const resolvedLogicalMatrix = \{[\s\S]*?tiers: resolveLogicalTierResources\(matrix\.tiers, detectedResources\)[\s\S]*?projectLocalBundleSummaries\([\s\S]*?resolvedLogicalMatrix,[\s\S]*?tiers: resolvedLogicalMatrix\.tiers/u)
  assert.match(localProfileRunner, /writeSummaryOnlyEvidence\([\s\S]*?profileId,[\s\S]*?profile,[\s\S]*?runId,[\s\S]*?lockedCheckpoint\.sourceState,[\s\S]*?artifactTable\)/u)
  assert.match(localProfileRunner, /artifactTable\.finalize\([\s\S]*?production-artifact-digest-table\.json/u)
  assert.match(localProfileRunner, /collectFailures: true/u)
  assert.match(localProfileRunner, /failures: result\.checkpoint\.failures/u)
  assert.match(localProfileRunner, /independent failure\(s\) collected/u)
})

test('backend bundle publishes server readiness before independent tests and benchmark builds', () => {
  assert.match(backendBundleRunner, /commandStep\('dotnet-restore',[\s\S]*?dotnet restore tests\/FsusBlog\.ProductionBackend\.slnx/u)
  assert.equal([...localBundleRunner.matchAll(/\bdotnet restore\b/gu)].length, 1)
  assert.match(backendBundleRunner, /commandStep\('backend-server-build',[\s\S]*?dotnet build src\/backend\/FsusBlog\.Server\.csproj -c Release[^\n]*--no-restore/u)
  assert.match(localBundleRunner, /const liveGrant = schedulerResourceGrant\(\)[\s\S]*?inheritedCpuBudget: liveGrant\?\.cpuUnits \?\? process\.env\.FSUSBLOG_BUNDLE_CPU_BUDGET,[\s\S]*?inheritedMemoryGiB: liveGrant\?\.memoryGiB \?\? process\.env\.FSUSBLOG_BUNDLE_MEMORY_GIB,[\s\S]*?cpuWeight: bundle\.cpuWeight/u)
  assert.match(backendBundleRunner, /dotnet build src\/backend\/FsusBlog\.Server\.csproj[^\n]*\/m:"\$FSUSBLOG_STEP_CPU_BUDGET"/u)
  assert.match(backendBundleRunner, /await executeStep\(backendBuildStep\)[\s\S]*?publishBackendBuildReady\(\)[\s\S]*?commandStep\('backend-tests-build'[\s\S]*?--no-restore[\s\S]*?commandStep\('backend-benchmark-build'[\s\S]*?--no-restore[\s\S]*?await executeWeightedStepDag/u)
  assert.match(backendBundleRunner, /commandStep\('backend-tests-build',[\s\S]*?--no-restore --no-dependencies --no-incremental/u)
  assert.match(backendBundleRunner, /commandStep\('backend-benchmark-build',[\s\S]*?--no-restore --no-dependencies/u)
  assert.match(backendBundleRunner, /await executeStep\(testsBuildStep\)[\s\S]*?await executeStep\(benchmarkBuildStep\)[\s\S]*?const testStep/u)
  assert.match(backendBundleRunner, /commandStep\('backend-tests-build',[\s\S]*?afterSuccess: publishBackendTestsReady/u)
  assert.match(backendBundleRunner, /const testStep = commandStep\('dotnet-production-union',[\s\S]*?afterSuccess: publishBackendTestsReady/u)
  assert.match(localBundleRunner, /if \(typeof step\.afterSuccess === 'function'\) await step\.afterSuccess\(result\)[\s\S]*?stepExecutionResults\.set\(step\.id/u)
  assert.match(backendBundleRunner, /commandStep\('backend-benchmark-build'[\s\S]*?afterSuccess: publishBenchmarkBuildReady/u)
  assert.match(backendBundleRunner, /FSUSBLOG_BACKEND_CPU_BUDGET="\$FSUSBLOG_STEP_CPU_BUDGET" node tools\/test\/run-backend-production-shards\.mjs/u)
  assert.match(backendBundleRunner, /const testStep = commandStep\('dotnet-production-union',[\s\S]*?minCpuUnits: 2,[\s\S]*?minMemoryGiB: backendTopologyDefaults\.memoryGiBPerTesthost \* 2/u)
  assert.doesNotMatch(backendBundleRunner, /FSUSBLOG_BACKEND_PRODUCTION_SHARDS=\d|FSUSBLOG_BACKEND_SHARD_PROCESSORS=\d/u)
  assert.match(backendShardRunner, /Category!=Integration&Category!=Performance/u)
  assert.match(backendShardRunner, /'--ListTests'/u)
  assert.match(backendShardRunner, /validateExactProductionUnion\(testNames, \[mainRecords, postludeRecords\],[\s\S]*?authoritativeRecords/u)
  assert.match(backendShardRunner, /executionMode: 'expandable-exact-partitions-with-governance-postlude'/u)
  const orderedSteps = [
    "commandStep('services'",
    "commandStep('dotnet-restore'",
    "const backendBuildStep = commandStep('backend-server-build'",
    'await executeWeightedStepDag([',
    "commandStep('perception-matrix'",
    "commandStep('perception-evidence-finalize'",
    "commandStep('integrity-proof'",
    "commandStep('backend-coverage-summary'"
  ].map((marker) => backendBundleRunner.indexOf(marker))
  assert.ok(orderedSteps.every((index) => index >= 0))
  assert.deepEqual(orderedSteps, [...orderedSteps].sort((left, right) => left - right))
  assert.match(backendBundleRunner, /await executeWave\(\[[\s\S]*?commandStep\('services'[\s\S]*?commandStep\('dotnet-restore'/u)
  assert.match(backendBundleRunner, /await executeWeightedStepDag\(\[[\s\S]*?testStep,[\s\S]*?commandStep\('perception-matrix'[\s\S]*?commandStep\('integrity-proof'/u)
  assert.match(backendBundleRunner, /commandStep\('perception-matrix',[\s\S]*?dependsOn: \['dotnet-production-union'\]/u)
  assert.match(backendBundleRunner, /commandStep\('perception-evidence-finalize',[\s\S]*?dependsOn: \['perception-matrix'\]/u)
  assert.match(backendBundleRunner, /commandStep\('integrity-proof',[\s\S]*?dependsOn: \['perception-matrix'\]/u)
  assert.match(backendBundleRunner, /commandStep\('backend-coverage-summary',[\s\S]*?dependsOn: \['dotnet-production-union'\]/u)
  assert.doesNotMatch(backendBundleRunner, /commandStep\('benchmark-readiness-build'/u)
  assert.match(localBundleRunner, /benchmark-build-ready\.v1[\s\S]*?schedulerRunId: runId[\s\S]*?artifact\.digests[\s\S]*?artifactRef/u)
  const benchmarkReadyVerifier = fs.readFileSync(path.join(root, 'tools/test/verify-benchmark-build-ready.mjs'), 'utf8')
  assert.match(benchmarkReadyVerifier, /FSUSBLOG_TEST_RUN_ID[\s\S]*?benchmark-build-ready\.json[\s\S]*?digestDeclaredOutputs/u)
  assert.doesNotMatch(backendBundleRunner, /await executeStep\(commandStep\('perception-matrix'/u)
  assert.match(backendBundleRunner, /commandStep\('perception-evidence-finalize',[\s\S]*?perception-v2-e2e-runtime\.json[\s\S]*?perception-v2-release-evidence\.json[\s\S]*?perception-v2-test-matrix\.json/u)
  assert.match(localBundleRunner, /readPerceptionUnionProjection[\s\S]*?schedulerRunId\(\)[\s\S]*?testDll[\s\S]*?unionSummary[\s\S]*?expectedTrxDigests[\s\S]*?outcome !== 'Passed'/u)
  assert.match(backendBundleRunner, /commandStep\('integrity-proof',[\s\S]*?integrity-proof-verification\.json/u)
  assert.match(backendBundleRunner, /commandStep\('backend-benchmark-build'/u)
  assert.match(frontendBundleRunner, /node tools\/test\/run-frontend-vitest-rolling-shards\.mjs/u)
  assert.match(frontendBundleRunner, /vitest-production-projects'[\s\S]*?dependsOn: \['frontend-early-test-capacity-ready'\],[\s\S]*?cpuWeight: 2,[\s\S]*?memoryWeight: 1\.5,[\s\S]*?minCpuUnits: resolvedFrontendVitestAdmissionFloor\(\)/u)
  assert.doesNotMatch(frontendBundleRunner, /FSUSBLOG_VITEST_TARGET_WORKERS/u)
  assert.match(localBundleRunner, /resolveFrontendVitestAdmissionFloor\(\{ cpuCount, eventualFrontendCapacity \}\)/u)
  assert.match(localBundleRunner, /function resolvedFrontendEarlyTestCpuTarget\(\) \{[\s\S]*?currentCpuUnits >= 3 \? currentCpuUnits - 1 : currentCpuUnits/u)
  assert.match(frontendBundleRunner, /frontend-early-test-capacity-ready'[\s\S]*?coordinationOnly: true/u)
  assert.doesNotMatch(frontendBundleRunner, /commandStep\('frontend-test-capacity-ready'/u)
  assert.match(frontendBundleRunner, /static-governance-concurrent'[\s\S]*?static-governance\.sh concurrent-prechecks'[\s\S]*?resources: \{ cpuWeight: 1, memoryWeight: 0\.5, minCpuUnits: 1 \}/u)
  assert.match(frontendBundleRunner, /static-governance-node-contracts'[\s\S]*?static-governance\.sh node-contracts'[\s\S]*?dependsOn: \['vitest-settled'\]/u)
  assert.match(frontendBundleRunner, /static-governance-post-vitest'[\s\S]*?static-governance\.sh post-vitest'[\s\S]*?dependsOn: \['vitest-settled'\]/u)
  assert.match(frontendBundleRunner, /static-governance-concurrent'[\s\S]{0,240}?dependsOn: \['frontend-build-ready'\]/u)
  assert.match(frontendBundleRunner, /commandStep\('frontend-build-ready',[\s\S]*?resources: \{ coordinationOnly: true \}/u)
  assert.match(frontendBundleRunner, /\['static-governance', 'frontend-static-governance'\]\.includes\(tierId\)/u)
  assert.match(frontendBundleRunner, /commandStep\('privacy-zk-contract-prebuild', 'tools\/test\/lanes\/privacy-zk-comment-matrix\.sh contract-prebuild', \[\],[\s\S]*?dependsOn: \['frontend-early-test-capacity-ready'\]/u)
  assert.match(frontendBundleRunner, /commandStep\('privacy-zk-contract', 'tools\/test\/lanes\/privacy-zk-comment-matrix\.sh contract-postbuild', \[\],[\s\S]*?dependsOn: \['frontend-build-ready', 'privacy-zk-contract-prebuild'\]/u)
  assert.match(localBundleRunner, /waitForBackendProductionSummaryReady[\s\S]*?backend-production-shards\.v2[\s\S]*?exactOnce[\s\S]*?allPassed[\s\S]*?validateShardSummaryArtifacts/u)
  assert.doesNotMatch(frontendBundleRunner, /privacy-zk-comment-matrix\.sh project-functional/u)
  assert.doesNotMatch(frontendBundleRunner, /privacy-zk-comment-matrix\.sh benchmark/u)
  assert.match(frontendBundleRunner, /vitest-production-perf-isolated'[\s\S]*?dependsOn: \['frontend-build-ready', 'vitest-settled'\]/u)
  assert.doesNotMatch(frontendBundleRunner, /waitForSiblingBundleSummaries\(\['build-static'\]\)[\s\S]*?vitest-production-perf-isolated/u)
  assert.match(frontendBundleRunner, /frontendPerfAdmissionEvidence = \{[\s\S]*?markerWaitDurationMs[\s\S]*?functional-budget-smoke-contention-aware[\s\S]*?waitsForBuildStaticSummary: false/u)
  assert.doesNotMatch(frontendBundleRunner, /waitForSiblingBundleSummaries\(\[[^\]]*backend-tests/u)
  assert.doesNotMatch(localBundleSteps, /resources:\s*\{[^\n}]*(?:cpuUnits|memoryGiB):/u)
  assert.doesNotMatch(localBundleRunner, /resources:\s*\{[^\n}]*(?:cpuUnits|memoryGiB):/u)
  assert.doesNotMatch(localBundleSteps, /referenceBundleResources|eight-core reference/u)
  const backendPerf = localBundleSteps.indexOf("step('backend-perf'")
  const mixedPerformance = localBundleSteps.indexOf("step('mixed-performance-window'")
  assert.ok(backendPerf > 0 && backendPerf < mixedPerformance)
  assert.match(localBundleSteps.slice(mixedPerformance), /backend-benchmark-regression/u)
  assert.doesNotMatch(localBundleSteps, /step\('backend-benchmark'/u)
  const runtimeIntegration = localBundleSteps.indexOf("step('runtime-integration'")
  const releasePublic = localBundleSteps.indexOf("step('release-public'")
  assert.ok(runtimeIntegration > 0 && runtimeIntegration < releasePublic)
  assert.match(localBundleSteps.slice(runtimeIntegration, releasePublic), /dependsOn: \['security-runtime-core'\]/u)
})

test('cold frontend static phases move to frontend-tests while build-static remains build focused', () => {
  const buildSteps = localBundleRunner.slice(
    localBundleRunner.indexOf('function buildStaticSteps()'),
    localBundleRunner.indexOf('\nfunction trxAttribute')
  )
  assert.doesNotMatch(buildSteps, /frontend-static-(?:blocking-prebuild|concurrent|postbuild|isolated|final|governance)/u)
  assert.match(buildSteps, /frontend-build[\s\S]*?exclusiveResources: \['build-output'\]/u)
  assert.match(frontendBundleRunner, /await executeStep\(staticStageStep\('blocking-prebuild',[\s\S]*?executeWeightedStepDag/u)
  assert.match(frontendBundleRunner, /executeWeightedStepDag\(\[[\s\S]*?staticStageStep\('concurrent'/u)
  assert.match(frontendBundleRunner, /staticStageStep\('postbuild',[\s\S]*?dependsOn: \['frontend-build-ready'\]/u)
  assert.match(frontendBundleRunner, /staticStageStep\('isolated',[\s\S]*?dependsOn: \['vitest-settled'\]/u)
  assert.match(frontendBundleRunner, /commandStep\('frontend-static-final-ready',[\s\S]*?runAfterSettled: true,[\s\S]*?coordinationOnly: true/u)
  assert.match(frontendBundleRunner, /staticStageStep\('final',[\s\S]*?dependsOn: \['frontend-static-final-ready'\]/u)
  assert.match(localBundleRunner, /frontend-build-ready\.v1[\s\S]*?schedulerRunId: runId[\s\S]*?privacyWasmArtifacts[\s\S]*?artifactRef/u)
  assert.match(localBundleRunner, /if \(step\.id === 'sync-static-assets'\) publishFrontendBuildReady\(\)/u)
  assert.match(localBundleRunner, /async function waitForFrontendBuildReady[\s\S]*?marker\.schedulerRunId !== expectedRunId[\s\S]*?digestArtifacts/u)
  assert.match(localBundleRunner, /producerStepId: 'sync-static-assets'[\s\S]*?publishedAt/u)
  assert.match(localBundleRunner, /function publishFrontendBuildTerminal[\s\S]*?status[\s\S]*?writeJsonAtomic/u)
  assert.match(localBundleRunner, /\['frontend-build', 'sync-static-assets'\]\.includes\(step\.id\)[\s\S]*?publishFrontendBuildTerminal\('failure'/u)
  assert.match(localBundleRunner, /bundleId === 'build-static'\) publishFrontendBuildTerminal\('cancelled', signal\)/u)
  assert.match(localBundleRunner, /function resolveMarkerPollIntervalMs\(\)[\s\S]*?bundleCapacity\(\)\.cpuUnits[\s\S]*?Math\.ceil\(1000 \/ cpuUnits\)/u)
})

test('runtime early start is guarded by run-bound atomic backend and frontend build markers', () => {
  assert.match(localBundleRunner, /backendBuildReadyFile[\s\S]*?\.tmp\/test-runs[\s\S]*?backend-build-ready\.json/u)
  assert.match(localBundleRunner, /publishBackendBuildReady[\s\S]*?schedulerRunId: runId[\s\S]*?serverDll:[\s\S]*?exists: true[\s\S]*?digest: artifact\.digests[\s\S]*?artifactRef/u)
  const backendTestsMarker = localBundleRunner.slice(
    localBundleRunner.indexOf('function publishBackendTestsReady()'),
    localBundleRunner.indexOf('\nfunction publishBenchmarkBuildReady')
  )
  assert.match(backendTestsMarker, /backend-tests-ready\.v1[\s\S]*?testDll:[\s\S]*?digest: artifact\.digests\[artifactPath\]/u)
  assert.match(backendTestsMarker, /contentDigest: fileContentDigest\(backendTestDll\)/u)
  assert.doesNotMatch(backendTestsMarker, /declaredDigest/u)
  assert.match(localBundleRunner, /writeFileSync\(temporary[\s\S]*?renameSync\(temporary, markerFile\)/u)
  assert.match(localBundleRunner, /async function waitForBackendBuildReady[\s\S]*?marker\.schema !== 'fsusblog\.local-production\.backend-build-ready\.v1'[\s\S]*?marker\.schedulerRunId !== expectedRunId[\s\S]*?digestArtifacts/u)
  assert.match(localBundleRunner, /async function waitForFrontendBuildReady[\s\S]*?marker\.schema !== 'fsusblog\.local-production\.frontend-build-ready\.v1'[\s\S]*?marker\.schedulerRunId !== expectedRunId[\s\S]*?digestArtifacts/u)
  assert.match(localBundleRunner, /function buildLayoutBinding\(\)[\s\S]*?productionBuildLayoutDigest[\s\S]*?sourceFingerprint/u)
  assert.match(localBundleRunner, /benchmarkDll:[\s\S]*?digest: artifact\.digests\[artifactPath\][\s\S]*?contentDigest: fileContentDigest\(benchmarkDll\)[\s\S]*?artifactRef/u)
  assert.match(localBundleRunner, /async function waitForBenchmarkBuildReady[\s\S]*?digestArtifacts\(\[artifactPath\],[\s\S]*?marker\.benchmarkDll\?\.digest !== artifact\.digests\[artifactPath\][\s\S]*?marker\.benchmarkDll\?\.contentDigest !== fileContentDigest\(benchmarkDll\)[\s\S]*?marker\.benchmarkDll\?\.artifactRef !== artifact\.refs\[artifactPath\]/u)
  assert.match(localBundleRunner, /production-frontend-build-contract\.v1[\s\S]*?generatedProverBundle[\s\S]*?generatedContract/u)
  assert.match(localBundleRunner, /checkpoint\.tiers\?\.\[`local-\$\{profileId\}-backend-tests`\]\?\.status[\s\S]*?failure[\s\S]*?blocked[\s\S]*?cancelled/u)
  assert.match(localBundleRunner, /async function executeRuntimeStep[\s\S]*?backend-build-ready[\s\S]*?waitForBackendBuildReady[\s\S]*?frontend-build-ready[\s\S]*?waitForFrontendBuildReady/u)
  assert.match(localBundleRunner, /bundleId === 'runtime-browser' \? executeRuntimeStep : executePerformanceStep/u)
})

test('performance marker producers are exact and quiet markers publish only after bundle finalization', () => {
  assert.match(localBundleRunner, /function publishCurrentRunMarker\(markerId, actualProducerStepId\)[\s\S]*?bundleId !== producerBundleId[\s\S]*?actualProducerStepId !== producerStepId/u)
  assert.match(localBundleRunner, /function currentRunMarkerArtifacts[\s\S]*?backend-coverage-ready[\s\S]*?frontend-coverage-ready[\s\S]*?runtime-state-ready/u)
  assert.match(localBundleRunner, /async function waitForCurrentRunMarker[\s\S]*?artifacts: currentRunMarkerArtifacts\(markerId\)[\s\S]*?signal: shutdownController\.signal/u)
  const summaryPublished = localBundleRunner.lastIndexOf('fs.renameSync(temporary, summaryFile)')
  const quietPublished = localBundleRunner.lastIndexOf('if (quietMarker) publishCurrentRunMarker(...quietMarker)')
  assert.ok(summaryPublished >= 0 && quietPublished > summaryPublished)
  assert.doesNotMatch(localBundleRunner.slice(localBundleRunner.indexOf('async function run()'), summaryPublished), /quiet-ready.*publishCurrentRunMarker/u)
  assert.match(localBundleRunner, /signal: shutdownController\.signal,[\s\S]*?exclusiveResources: bundle\.exclusiveResources/u)
  assert.match(localBundleRunner, /finalizeBundleResourceUtilization\('partial', new Error\(`bundle cancelled by/u)
  assert.match(localBundleRunner, /coordination:\s*\{[\s\S]*?status: shutdownController\.signal\.aborted \? 'cancelled' : 'failure'/u)
})

test('bundle child processes inherit their admitted machine-resolved CPU and memory', () => {
  assert.match(localBundleRunner, /for \(const stalePhysicalWorkerCap of \[[\s\S]*?'FSUSBLOG_COMMAND_MANIFEST_WORKERS'[\s\S]*?'FSUSBLOG_VITEST_MAX_WORKERS'[\s\S]*?'FSUSBLOG_PLAYWRIGHT_WORKERS'[\s\S]*?delete childBaseEnvironment\[stalePhysicalWorkerCap\]/u)
  assert.match(localBundleRunner, /MSBUILDDISABLENODEREUSE: '1'/u)
  assert.match(matrixRunner, /tier\.physicalBundleId[\s\S]*?FSUSBLOG_BUNDLE_CPU_BUDGET = String\(workerBudget\)/u)
  assert.match(matrixRunner, /tier\.physicalBundleId[\s\S]*?FSUSBLOG_BUNDLE_MEMORY_GIB = String\(memoryGiB\)/u)
  assert.match(localBundleRunner, /schedulerResourceGrant\(\)[\s\S]*?inheritedCpuBudget: liveGrant\?\.cpuUnits \?\? process\.env\.FSUSBLOG_BUNDLE_CPU_BUDGET,[\s\S]*?inheritedMemoryGiB: liveGrant\?\.memoryGiB \?\? process\.env\.FSUSBLOG_BUNDLE_MEMORY_GIB/u)
  assert.match(localBundleRunner, /const stepCapacity = resolveStepRuntimeCapacity\(bundleId, step, bundleCapacity\(\)\)[\s\S]*?\.\.\.\(step\.env \?\? \{\}\),[\s\S]*?FSUSBLOG_STEP_CPU_BUDGET: String\(stepCapacity\.cpuUnits\),[\s\S]*?FSUSBLOG_STEP_MEMORY_GIB: String\(stepCapacity\.memoryGiB\),[\s\S]*?FSUSBLOG_BUNDLE_CPU_BUDGET: String\(stepCapacity\.maxParallel\),[\s\S]*?FSUSBLOG_BUNDLE_CPU_UNITS: String\(stepCapacity\.cpuUnits\),[\s\S]*?FSUSBLOG_BUNDLE_MEMORY_GIB: String\(stepCapacity\.memoryGiB\)/u)
  assert.match(localBundleRunner, /remainingBundleDeadlineMs[\s\S]*?baseTimeoutMs: remainingBundleDeadlineMs[\s\S]*?workload: step\.resources[\s\S]*?actualCapacity: stepCapacity[\s\S]*?FSUSBLOG_STEP_DEADLINE_MS: String\(stepDeadlineMs\)/u)
  assert.match(localBundleRunner, /frontend-runtime-contracts'[\s\S]*?FSUSBLOG_COMMAND_MANIFEST_WORKERS="\$FSUSBLOG_STEP_CPU_BUDGET"/u)
  assert.match(frontendBundleRunner, /FSUSBLOG_LOCAL_STATIC_PHASE=\$\{stage\}[\s\S]*?FSUSBLOG_COMMAND_MANIFEST_WORKERS="\$FSUSBLOG_STEP_CPU_BUDGET"/u)
  assert.doesNotMatch(localBundleRunner, /FSUSBLOG_COMMAND_MANIFEST_WORKERS=[34]\b/u)
})

test('bundle execution waits derive deadlines from matrix budgets and scheduler capacity', () => {
  assert.match(localBundleRunner, /function bundleDeadlineMs\(\)[\s\S]*?FSUSBLOG_BUNDLE_DEADLINE_MS[\s\S]*?Number\.isFinite\(deadlineMs\) && deadlineMs > 0[\s\S]*?profile\.enforceBudget === false[\s\S]*?timeoutMinutes[\s\S]*?baseTimeoutMs: profile\.budgetMs[\s\S]*?actualCapacity: bundleCapacity\(\)/u)
  assert.match(localBundleRunner, /function resolveExecutionWaitTimeoutMs\(dependencyBundleIds\)[\s\S]*?baseTimeoutMs: bundleDeadlineMs\(\)[\s\S]*?workload: bundle[\s\S]*?actualCapacity: bundleCapacity\(\)/u)
  assert.doesNotMatch(localBundleRunner, /bundle\.budgetMs|dependency\.budgetMs/u)
  assert.match(localBundleRunner, /waitForBackendBuildReady\(timeoutMs = resolveExecutionWaitTimeoutMs\(\['backend-tests'\]\)\)/u)
  assert.match(localBundleRunner, /waitForFrontendBuildReady\(timeoutMs = resolveExecutionWaitTimeoutMs\(\['build-static'\]\)\)/u)
  assert.match(localBundleRunner, /resolveMarkerPollIntervalMs\(\)/u)
  assert.doesNotMatch(localBundleRunner, /timeoutMs = 120_000/u)
})

test('production evidence is assigned to the earliest safe physical bundle without being omitted', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const bundles = new Map(matrix.localProfiles.production.bundles.map((bundle) => [bundle.id, bundle.members]))
  const deferred = [
    'backend-build-governance',
    'integrity-proof-verification',
    'perception-v2-test-matrix',
    'cross-stack-contract',
    'privacy-zk-comment-matrix',
    'aeds-frame-cost',
    'aeds-compression-profile'
  ]

  for (const tierId of deferred) assert.equal(bundles.get('build-static').includes(tierId), false, tierId)
  assert.ok(bundles.get('build-static').includes('ux-viewport-plan-progress'))
  assert.ok(bundles.get('frontend-tests').includes('static-governance'))
  assert.equal(bundles.get('build-static').includes('frontend-static-governance'), false)
  assert.ok(bundles.get('frontend-tests').includes('frontend-static-governance'))
  assert.match(localBundleRunner, /commandStep\('viewport-plan-progress', 'node tools\/ux\/run-viewport-plan-progress\.mjs', \['ux-viewport-plan-progress'\],[\s\S]*?viewport-plan-progress\.json/u)
  assert.match(frontendBundleRunner, /commandStep\('static-governance-concurrent', 'tools\/test\/lanes\/static-governance\.sh concurrent-prechecks', \['static-governance'\],[\s\S]*?cpuWeight: 1,[\s\S]*?memoryWeight: 0\.5,[\s\S]*?minCpuUnits: 1/u)
  assert.match(frontendBundleRunner, /commandStep\('static-governance-node-contracts', 'tools\/test\/lanes\/static-governance\.sh node-contracts', \['static-governance'\],[\s\S]*?dependsOn: \['vitest-settled'\]/u)
  assert.match(frontendBundleRunner, /commandStep\('static-governance-post-vitest', 'tools\/test\/lanes\/static-governance\.sh post-vitest', \['static-governance'\],[\s\S]*?dependsOn: \['vitest-settled'\]/u)
  for (const tierId of ['backend-build-governance', 'integrity-proof-verification', 'perception-v2-test-matrix']) {
    assert.ok(bundles.get('backend-tests').includes(tierId), tierId)
  }
  assert.ok(bundles.get('runtime-browser').includes('cross-stack-contract'))
  assert.equal(bundles.get('frontend-tests').includes('privacy-zk-comment-matrix'), false)
  assert.ok(bundles.get('performance-evidence').includes('privacy-zk-comment-matrix'))
  assert.match(frontendBundleRunner, /commandStep\('privacy-zk-contract'[\s\S]*?privacy-zk-comment-matrix\.sh contract/u)
  assert.match(localBundleSteps, /step\('privacy-zk-project-functional'[\s\S]*?privacy-zk-comment-matrix\.sh project-functional/u)
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
    'src/backend/Logs/log-20260712.txt',
  ]
  const legacyBuildOutputs = [
    'src/frontend/dist/index.html',
    'src/frontend/public/wasm/aeds_decoder_speed.wasm',
    'src/frontend/wasm/build-basic/aeds_decoder_basic.wasm',
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
    '.tmp/build/previous-run/layout.json',
    '.nuget/packages/cache.txt'
  ]
  for (const file of [...generated, ...legacyBuildOutputs, ...caches]) {
    fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true })
    fs.writeFileSync(path.join(temp, file), 'fixture')
  }

  const cleanup = cleanLocalProductionOutputs(temp)

  for (const file of generated) assert.equal(fs.existsSync(path.join(temp, file)), false, file)
  for (const file of legacyBuildOutputs) assert.equal(fs.existsSync(path.join(temp, file)), true, file)
  for (const file of caches) assert.equal(fs.existsSync(path.join(temp, file)), true, file)
  assert.equal(cleanup.schema, 'fsusblog.fresh-production-cleanup.v1')
  assert.ok(cleanup.preservedRoots.includes('.tmp/build'))
})

test('fresh production cleanup preserves an external temp root and its dependency caches', () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-fresh-production-link-'))
  const repositoryRoot = path.join(temp, 'repository')
  const externalTempRoot = path.join(temp, 'external', '.tmp')
  fs.mkdirSync(repositoryRoot, { recursive: true })
  fs.mkdirSync(externalTempRoot, { recursive: true })
  fs.symlinkSync(externalTempRoot, path.join(repositoryRoot, '.tmp'), 'dir')
  fs.mkdirSync(path.join(externalTempRoot, 'dependency-cache/dotnet'), { recursive: true })
  fs.mkdirSync(path.join(externalTempRoot, 'emscripten-cache/sysroot'), { recursive: true })
  fs.mkdirSync(path.join(externalTempRoot, 'stale'), { recursive: true })
  fs.writeFileSync(path.join(externalTempRoot, 'dependency-cache/dotnet/cache.txt'), 'cache')
  fs.writeFileSync(path.join(externalTempRoot, 'emscripten-cache/sysroot/cache.txt'), 'cache')
  fs.writeFileSync(path.join(externalTempRoot, 'stale/result.json'), '{}')

  cleanLocalProductionOutputs(repositoryRoot)

  assert.equal(fs.lstatSync(path.join(repositoryRoot, '.tmp')).isSymbolicLink(), true)
  assert.equal(fs.existsSync(path.join(externalTempRoot, 'stale')), false)
  assert.equal(fs.existsSync(path.join(externalTempRoot, 'dependency-cache/dotnet/cache.txt')), true)
  assert.equal(fs.existsSync(path.join(externalTempRoot, 'emscripten-cache/sysroot/cache.txt')), true)
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

test('acceptance backend derives thread-pool capacity from machine CPUs and burst policy', () => {
  const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  assert.match(source, /os\.availableParallelism\?\.\(\) \?\? os\.cpus\(\)\.length/u)
  assert.match(source, /Math\.ceil\(concurrency \/ cpu\)/u)
  assert.match(source, /RuntimeTuning__ThreadPool__Enabled=true/u)
  assert.match(source, /RuntimeTuning__ThreadPool__MinThreadsPerCpu=\$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU/u)
  assert.doesNotMatch(source, /RuntimeTuning__ThreadPool__MinThreadsPerCpu=[0-9]/u)
})

test('acceptance bootstrap starts independent services within dynamic CPU and memory grants', () => {
  const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  assert.match(source, /resolve_bootstrap_parallel_workers/u)
  assert.match(source, /resolveManifestLiveCapacity\(\{ env: process\.env, workload: 'scheduler-admitted' \}\)/u)
  assert.match(source, /readManifestSchedulerResourceGrant\(\{ env: process\.env \}\)/u)
  assert.match(source, /resolveManifestChildEnvironment/u)
  assert.match(source, /capacity update workers=\$worker_cap->\$next_worker_cap active=\$active/u)
  assert.match(source, /run_bootstrap_parallel 'database services'[\s\S]*?postgres ensure_postgres[\s\S]*?redis ensure_redis/u)
  assert.match(source, /local -a runtime_applications=\(debug-backend ensure_backend\)[\s\S]*?ci_production_has_domain frontend-dist[\s\S]*?runtime_applications\+=\(release-preview ensure_release_preview debug-frontend ensure_debug_frontend\)[\s\S]*?run_bootstrap_parallel 'runtime applications'/u)
  assert.match(source, /run_parallel "bootstrap-runtime-fixtures"[\s\S]*?auth-fixtures::prepare_auth_fixtures_once[\s\S]*?public-fixtures::prepare_public_fixtures_once/u)
  assert.match(source, /FSUSBLOG_PARALLEL_WORKLOAD=scheduler-admitted[\s\S]*run_parallel "bootstrap-runtime-fixtures"/u)
  assert.match(source, /run_parallel "bootstrap-runtime-fixtures"[\s\S]*refresh_acceptance_cache_after_fixtures/u)
  assert.match(source, /failures\+=\("\$\{labels\[\$index\]\} \(exit \$\{child_status\}\)"\)/u)
  assert.doesNotMatch(source, /FSUSBLOG_BOOTSTRAP_(?:WORKERS|CPU|MEMORY)=[0-9]/u)
})

test('acceptance service ports stay below the kernel ephemeral range and Vite cannot drift', () => {
  const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  for (const range of ['20000 21999', '22000 23999', '24000 25999', '26000 27999', '28000 29999']) {
    assert.match(source, new RegExp(`find_free_port ${range}`, 'u'))
  }
  assert.equal((source.match(/--strictPort/gu) ?? []).length, 3)
  assert.equal((source.match(/--host 127\.0\.0\.1/gu) ?? []).length, 3)
  assert.match(source, /-p "127\.0\.0\.1:\$\{POSTGRES_PORT\}:5432"/u)
  assert.match(source, /-p "127\.0\.0\.1:\$\{REDIS_PORT\}:6379"/u)
  assert.match(source, /process exited before becoming ready at \$url/u)
})

test('local production UX risk binds Playwright to the active namespace release build', () => {
  assert.match(uxRiskRunner, /requireHttpUrl\('FSUSBLOG_RELEASE_PREVIEW_URL'\)/u)
  assert.doesNotMatch(uxRiskRunner, /FSUSBLOG_DEBUG_FRONTEND_URL/u)
  assert.match(uxRiskRunner, /import \{ validateReleasePreviewReady \} from '\.\/release-preview-readiness\.mjs'/u)
  assert.match(uxRiskRunner, /const previewReady = validateReleasePreviewReady\(\{[\s\S]*?runId: schedulerRunId,[\s\S]*?previewUrl: process\.env\.FSUSBLOG_RELEASE_PREVIEW_MARKER_URL \?\? playwrightBaseUrl/u)
  assert.match(uxRiskRunner, /const publicBaseUrl = requireHttpUrl\('FSUSBLOG_DEBUG_BACKEND_URL'\)/u)
  assert.match(releasePreviewReadiness, /releasePreviewReadyFileName = 'release-preview-ready\.json'/u)
  assert.match(releasePreviewReadiness, /export function validateReleasePreviewReady/u)
  assert.match(releasePreviewReadiness, /marker\.schema !== releasePreviewReadySchema[\s\S]*?marker\.schedulerRunId !== schedulerRunId/u)
  assert.match(releasePreviewReadiness, /marker\.servedIndex\?\.sourceDigestMatch !== true[\s\S]*?marker\.apiProbe\?\.namespaceBound !== true[\s\S]*?marker\.apiProbe\?\.status !== 200/u)
  assert.match(releasePreviewReadiness, /actualContentDigest = sha256\(bytes\)[\s\S]*?actualDeclaredDigest = digestDeclaredOutputs/u)
  assert.match(releasePreviewReadiness, /marker\.distEntry\?\.contentDigest !== actualContentDigest[\s\S]*?marker\.distEntry\?\.digest !== actualDeclaredDigest[\s\S]*?dist digest changed after readiness/u)
  assert.match(uxRiskRunner, /PLAYWRIGHT_BASE_URL: playwrightBaseUrl/u)
  assert.match(uxRiskRunner, /FSUSBLOG_UX_VIEWPORT_PUBLIC_BASE_URL: publicBaseUrl/u)
  assert.match(uxRiskRunner, /playwrightBaseUrl,/u)
  assert.doesNotMatch(uxRiskRunner, /public-full-app-takeover|fsus:public-shell:takeover/u)
  assert.doesNotMatch(uxRiskRunner, /127\.0\.0\.1:3000/u)
})

test('local production UX risk can resume the current matching viewport run', () => {
  assert.match(uxRiskRunner, /process\.env\.FSUSBLOG_UX_VIEWPORT_RESUME === '1'/u)
  assert.match(uxRiskRunner, /FSUSBLOG_UX_VIEWPORT_RESUME: initializesRun && !resume \? '0' : '1'/u)
  assert.match(uxRiskRunner, /resumeRunId \?\? freshRunId/u)
  assert.match(uxRiskRunner, /waitForRunPointer\(pointerFile, uxRunId, child\)/u)
  assert.match(uxRiskRunner, /writeUxViewportSummary\(\{ root, mode: 'boundaries', runId: uxRunId \}\)/u)
  assert.match(uxRiskRunner, /summary\.runId !== uxRunId/u)
  assert.match(uxRiskRunner, /executionSource: resume \? 'resume' : 'fresh'/u)
})

test('local production UX risk dynamically fills isolated Playwright workers', () => {
  assert.match(uxRiskRunner, /os\.availableParallelism/u)
  assert.match(uxRiskRunner, /Math\.min\(riskPlan\.counts\.routeThemeGroups, workerCapacity\)/u)
  assert.match(uxRiskRunner, /executeElasticUxGroupPool\(riskPlan\.groups/u)
  assert.match(uxRiskRunner, /capacityProvider: \(\) => resolveLiveWorkerCapacity\(\)/u)
  assert.match(uxRiskRunner, /readManifestSchedulerResourceGrant\(\)/u)
  assert.match(uxRiskRunner, /FSUSBLOG_STEP_DEADLINE_AT_MS: String\(stepDeadlineAtMs\)/u)
  assert.match(uxRiskRunner, /FSUSBLOG_UX_VIEWPORT_EXECUTION_GROUP_IDS: group\.id/u)
  assert.match(uxRiskRunner, /FSUSBLOG_PLAYWRIGHT_WORKERS: '1'/u)
  assert.match(uxRiskRunner, /FSUSBLOG_TEST_SESSION_ISOLATION: '1'/u)
  assert.match(uxRiskRunner, /FSUSBLOG_DISABLE_NOTIFICATION_STREAM: '1'/u)
  assert.match(uxRiskRunner, /FSUSBLOG_UX_VIEWPORT_WORKERS: '1'/u)
  assert.match(uxRiskRunner, /FSUSBLOG_PLAYWRIGHT_TRACE: 'off'/u)
})

test('physical bundle DAG preserves dependencies and derives deadlines from resolved machine resources', () => {
  const resolved = resolveLocalProfileResources(profile(), { availableCpuUnits: 8, availableMemoryGiB: 18 })
  const bundles = createLocalBundleTiers('production', resolved)
  assert.deepEqual(bundles.map((bundle) => bundle.id), [
    'local-production-build-static',
    'local-production-backend-tests',
    'local-production-frontend-tests',
    'local-production-runtime-browser',
    'local-production-performance-evidence'
  ])
  assert.deepEqual(bundles[0].dependsOn, [])
  assert.deepEqual(bundles[1].dependsOn, [])
  assert.deepEqual(bundles[2].dependsOn, [])
  assert.deepEqual(bundles[3].dependsOn, [])
  assert.deepEqual(bundles[4].dependsOn, [])
  assert.deepEqual(bundles.map((bundle) => bundle.phase), [0, 0, 0, 0, 0])
  assert.deepEqual(bundles.slice(0, 4).map((bundle) => bundle.resourceGrantMode), ['dynamic', 'dynamic', 'dynamic', 'dynamic'])
  assert.deepEqual(bundles.slice(0, 3).map((bundle) => bundle.cpuWeight), [2, 3, 3])
  assert.deepEqual(bundles.slice(0, 3).map((bundle) => bundle.minCpuUnits), [1, 2, 3])
  assert.deepEqual(bundles.slice(0, 3).map((bundle) => bundle.maxParallel), [8, 8, 8])
  assert.ok(bundles.every((bundle) => Number.isInteger(bundle.budgetMs) && bundle.budgetMs > 0))
  assert.deepEqual(bundles.slice(0, 4).map((bundle) => bundle.startupMinCpuUnits), [1, 1, 1, 1])
  assert.ok(localProfileBudgetCriticalPath({ budgetMs: 300_000, bundles }) <= 300_000)
  assert.equal(bundles[0].artifacts[0], '.tmp/local-production/build-static/summary.json')
})

test('production run summary fails closed beyond the five-minute wall budget', () => {
  const production = profile()
  assert.deepEqual(validateLocalProfileRunSummary({ budgetMs: 300_000, durationMs: 300_000 }, production), [])
  assert.deepEqual(validateLocalProfileRunSummary({ budgetMs: 300_000, durationMs: 300_001 }, production), [
    'summary duration 300001 exceeds 300000'
  ])
})

test('observe-only production records its optimization target without failing or truncating a natural run', () => {
  const production = profile({ enforceBudget: false })
  const resolved = resolveLocalProfileResources(production, {
    cpuCount: 8,
    availableCpuUnits: 8,
    availableMemoryGiB: 16,
    memoryReserveGiB: 1,
    load1: 0,
    launchParallelism: 8
  })
  const bundles = createLocalBundleTiers('production', resolved, { maxParallel: 8 })

  assert.ok(bundles.every((bundle) => !Object.hasOwn(bundle, 'budgetMs')))
  assert.deepEqual(validateLocalProfileRunSummary({ budgetMs: 300_000, durationMs: 900_000 }, production), [])
  assert.deepEqual(validateLocalProfileCheckpointDuration({
    budgetMs: null,
    startedAt: '2026-07-13T00:00:00.000Z',
    finishedAt: '2026-07-13T00:15:00.000Z'
  }, production), [])
})

test('repository physical DAG starts runtime and performance coordination immediately', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const profileBundles = new Map(matrix.localProfiles.production.bundles.map((bundle) => [bundle.id, bundle]))
  assert.deepEqual(profileBundles.get('runtime-browser').dependsOn, [])
  assert.deepEqual(profileBundles.get('performance-evidence').dependsOn, [])

  const resolved = resolveLocalProfileResources(matrix.localProfiles.production, {
    availableCpuUnits: 8,
    availableMemoryGiB: 18
  })
  const physicalTiers = new Map(createLocalBundleTiers('production', resolved)
    .map((bundle) => [bundle.physicalBundleId, bundle]))
  assert.equal(physicalTiers.get('runtime-browser').phase, physicalTiers.get('frontend-tests').phase)
  assert.equal(physicalTiers.get('runtime-browser').dependsOn.includes('local-production-backend-tests'), false)
  assert.equal(physicalTiers.get('runtime-browser').dependsOn.includes('local-production-frontend-tests'), false)
  assert.equal(physicalTiers.get('runtime-browser').dependsOn.includes('local-production-build-static'), false)
  assert.deepEqual(physicalTiers.get('performance-evidence').dependsOn, [])
  assert.equal(physicalTiers.get('runtime-browser').residentLeaseTarget, 'performance-evidence')
  assert.ok(physicalTiers.get('backend-tests').cacheInputs.includes('tools/test/run-backend-production-shards.mjs'))
  assert.ok(physicalTiers.get('backend-tests').cacheInputs.includes('tools/test/backend-production-topology.mjs'))
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

test('performance deadline evidence binds the mixed floor to same-run measured serial time', () => {
  const steps = [
    { id: 'coverage-merge', evidencePhase: 'preparation', status: 'success', durationMs: 4_000, startedAtMs: 1_000, finishedAtMs: 5_000 },
    { id: 'mixed-performance-window', evidencePhase: 'measurement', status: 'success', durationMs: 60_000, startedAtMs: 5_000, finishedAtMs: 65_000 },
    { id: 'backend-perf', evidencePhase: 'measurement', status: 'success', durationMs: 20_000, startedAtMs: 65_000, finishedAtMs: 85_000 },
    { id: 'browser-performance', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 85_000, finishedAtMs: 85_000 },
    { id: 'privacy-zk-benchmark', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 85_000, finishedAtMs: 85_000 },
    { id: 'aeds-frame-cost', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 85_000, finishedAtMs: 85_000 },
    { id: 'performance-summary', evidencePhase: 'post-measurement', status: 'success', durationMs: 1_000, startedAtMs: 85_000, finishedAtMs: 86_000 }
  ]
  const valid = {
    schema: 'fsusblog.performance-deadline-evidence.v2',
    status: 'sufficient',
    schedulerRunId: 'fresh-performance',
    sourceState: { commit: 'abc123', worktreeFingerprint: 'tree-1' },
    candidateBudgetMs: 81_000,
    bundleDurationMs: 80_000,
    coordinationWaitMs: 0,
    preparationWorkMs: 4_000,
    postMeasurementWorkMs: 1_000,
    measurementIsolation: { status: 'isolated', noiseOverlaps: [] },
    mixedWindow: {
      stepId: 'mixed-performance-window',
      minimumDurationMs: performanceMixedWindowFloorMs,
      measuredDurationMs: 60_000
    },
    measuredOtherSerialMs: 20_000,
    requiredBudgetMs: 80_000,
    steps
  }
  assert.deepEqual(validatePerformanceDeadlineEvidence(valid, { expectedRunId: 'fresh-performance' }), [])
  assert.ok(validatePerformanceDeadlineEvidence(valid, {
    expectedRunId: 'fresh-performance',
    expectedSourceState: { commit: 'abc123', worktreeFingerprint: 'tree-2' }
  }).some((error) => error.includes('match the checkpoint')))
  assert.ok(validatePerformanceDeadlineEvidence({ ...valid, candidateBudgetMs: 79_999 }, {
    expectedRunId: 'fresh-performance'
  }).some((error) => error.includes('below required 80000')))
  assert.ok(validatePerformanceDeadlineEvidence({
    ...valid,
    mixedWindow: { ...valid.mixedWindow, measuredDurationMs: 59_999 }
  }).some((error) => error.includes('at least 60000')))
  assert.ok(validatePerformanceDeadlineEvidence({ ...valid, measuredOtherSerialMs: 19_999 })
    .some((error) => error.includes('minus mixed duration')))
  assert.ok(validatePerformanceDeadlineEvidence({
    ...valid,
    steps: valid.steps.filter((step) => step.id !== 'privacy-zk-benchmark')
  }).some((error) => error.includes('measurement steps must be exactly')))
  assert.ok(validatePerformanceDeadlineEvidence({
    ...valid,
    steps: valid.steps.map((step) => step.id === 'performance-summary'
      ? { ...step, startedAtMs: 84_000, finishedAtMs: 85_000 }
      : step)
  }).some((error) => error.includes('measurement overlaps noise')))
})

test('bundle step timing derives duration and finish from one clock sample', () => {
  assert.match(localBundleRunner,
    /const finishedAtMs = Date\.now\(\)\s+const result = \{\s+\.\.\.finalizedExit,\s+durationMs: finishedAtMs - started,\s+startedAtMs: started,\s+finishedAtMs,/u)
  assert.doesNotMatch(localBundleRunner,
    /durationMs: Date\.now\(\) - started[\s\S]{0,120}finishedAtMs: Date\.now\(\)/u)
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
  assert.match(localBundleRunner, /const artifacts = digestArtifacts\(declaredArtifacts, step\.id\)[\s\S]*?const artifactDigests = artifacts\.digests/u)
  assert.match(localBundleRunner, /const substitutionsByTier = resolveArtifactSubstitutions\(bundle, matrix\.tiers\)/u)
  assert.match(localBundleRunner, /const allRuntimeArtifacts = digestArtifacts\([\s\S]*?const allRuntimeDigests = allRuntimeArtifacts\.digests[\s\S]*?allRuntimeDigests\[canonicalPath\]/u)
  assert.match(localBundleRunner, /artifactSubstitutionBindingDigest\(canonicalPath, actualDigests\)[\s\S]*?artifactSubstitutionProofs\[canonicalPath\]/u)
  assert.match(localBundleRunner, /registerSubstitution\([\s\S]*?canonicalArtifactRef/u)
  assert.match(localBundleRunner, /bindMatrixRuntimeArtifacts\(\)[\s\S]*?const members =/u)
  assert.doesNotMatch(localBundleRunner, /artifactFiles\][\s\S]{0,120}filter\(\(file\) => fs\.existsSync\(file\)\)/u)
})
