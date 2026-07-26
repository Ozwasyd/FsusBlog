import assert from 'node:assert/strict';
import fs from 'node:fs'
import test from 'node:test'

import { buildSettledPhaseJoinEvidence, executeWeightedStepDag } from '../../tools/test/bundles/bundle-steps.mjs'

const runnerSource = fs.readFileSync(new URL('../../tools/test/bundles/run-bundle.mjs', import.meta.url), 'utf8')
const staticLaneSource = fs.readFileSync(new URL('../../tools/test/lanes/static-governance.sh', import.meta.url), 'utf8')
const staticHostSource = fs.readFileSync(new URL('../../tools/test/run-governance-suites.mjs', import.meta.url), 'utf8')
const privacyLaneSource = fs.readFileSync(new URL('../../tools/test/lanes/privacy-zk-comment-matrix.sh', import.meta.url), 'utf8')
const frontendPackage = JSON.parse(fs.readFileSync(new URL('../../src/frontend/package.json', import.meta.url), 'utf8'))
const vitestSharedSource = fs.readFileSync(new URL('../../src/frontend/vitest.shared.mjs', import.meta.url), 'utf8')
const vitestUnitSource = fs.readFileSync(new URL('../../src/frontend/vitest.config.ts', import.meta.url), 'utf8')

function settledOutcome(step) {
  const joined = buildSettledPhaseJoinEvidence({
    stepId: step.id,
    dependencyIds: step.dependsOn,
    dependencyOutcomes: step.dependencyOutcomes,
    dependencyResults: new Map(step.dependsOn.map((id) => [id, {
      status: step.dependencyOutcomes[id],
      startedAtMs: 1,
      finishedAtMs: 2
    }]))
  })
  return { terminalState: joined.evidence.terminalState, evidence: joined.evidence }
}

test('frontend bundle gates Vitest on only explicit blocking checks and schedules other static stages in the DAG', () => {
  const vitestStart = runnerSource.indexOf("const step = commandStep('vitest-production-projects'")
    const dagStart = runnerSource.indexOf('const frontendSteps = [', vitestStart);
    const dagEnd = runnerSource.indexOf('\n  ];\n  await executeWeightedStepDag(', dagStart);
    assert.ok(vitestStart >= 0 && dagStart > vitestStart && dagEnd > dagStart);

  const perfStart = runnerSource.indexOf("const perfStep = commandStep('vitest-production-perf-isolated'", vitestStart)
  const vitestDeclaration = runnerSource.slice(vitestStart, perfStart)
  const perfDeclaration = runnerSource.slice(perfStart, dagStart)
  const dagDeclaration = runnerSource.slice(dagStart, dagEnd)
  assert.match(vitestDeclaration, /node tools\/test\/run-frontend-vitest-rolling-shards\.mjs/u)
  assert.match(runnerSource, /node tools\/test\/run-frontend-vitest-perf-isolated\.mjs/u)
  assert.match(runnerSource, /cpuCount - backendFloor - runtimeFloor/u)
  assert.match(vitestDeclaration, /dependsOn: \['frontend-early-test-capacity-ready'\]/u)
  assert.doesNotMatch(vitestDeclaration, /FSUSBLOG_VITEST_TARGET_WORKERS/u)
  assert.match(vitestDeclaration, /minCpuUnits: resolvedFrontendVitestAdmissionFloor\(\)/u)
  assert.match(vitestDeclaration, /exclusiveResources: \['frontend-test-results'\]/u)
  assert.match(runnerSource, /resolveFrontendVitestAdmissionFloor\(\{ cpuCount, eventualFrontendCapacity \}\)/u)
  assert.doesNotMatch(vitestDeclaration, /dependsOn: \[[^\]]*frontend-build-ready/u)
  assert.match(perfDeclaration, /dependsOn: \['frontend-build-ready', 'vitest-settled'\]/u)
  assert.doesNotMatch(runnerSource, /waitForSiblingBundleSummaries\(\['build-static'\]\)[\s\S]*?run-frontend-vitest-perf-isolated/u)
  assert.match(runnerSource, /waitForFrontendBuildReady[\s\S]*?waitForRunBoundMarker\([\s\S]*?markerId: 'frontend-build-ready'[\s\S]*?readMarker:/u)
  assert.match(runnerSource, /waitForFrontendBuildReady[\s\S]*?signal: shutdownController\.signal/u)
  assert.doesNotMatch(vitestDeclaration, /\b(?:maxErrors|maxFailures|failFast|bail)\b/u)
  assert.match(
    runnerSource.slice(runnerSource.indexOf('async function runFrontendTests()'), vitestStart),
    /await executeStep\(staticStageStep\('blocking-prebuild',[\s\S]*?\)\)/u
  )

  const staticStart = dagDeclaration.indexOf("staticStageStep('concurrent'")
  const postbuildStart = dagDeclaration.indexOf("'frontend-static-postbuild'")
  assert.ok(staticStart >= 0 && postbuildStart > staticStart,
    'ordinary Vitest/static work must be declared before the queued postbuild writer')
  assert.doesNotMatch(dagDeclaration.slice(staticStart, postbuildStart), /staticStageStep\('concurrent',[\s\S]{0,200}?dependsOn/u)
  assert.match(dagDeclaration, /staticStageStep\('concurrent',[\s\S]*?exclusiveResources: \['generated-contracts'\]/u)
  assert.match(dagDeclaration, /commandStep\('frontend-build-ready',[\s\S]*?coordinationOnly: true/u)
  assert.match(dagDeclaration, /commandStep\('frontend-early-test-capacity-ready',[\s\S]*?coordinationOnly: true/u)
  assert.doesNotMatch(dagDeclaration, /commandStep\('frontend-test-capacity-ready'/u)
  assert.ok(
    dagDeclaration.indexOf('\n    step,') < dagDeclaration.indexOf("commandStep('privacy-zk-contract-prebuild'"),
    'Vitest must be declared before every ordinary privacy/static sibling'
  )
  assert.match(dagDeclaration, /commandStep\('static-governance-concurrent',[\s\S]*?repository-governance-authority\.mjs run application-static-governance[\s\S]*?dependsOn: \['frontend-build-ready'\]/u);
  assert.doesNotMatch(dagDeclaration, /commandStep\('static-governance-node-contracts'/u);
  assert.match(dagDeclaration, /commandStep\('privacy-zk-contract-prebuild',[\s\S]*?privacy-zk-comment-matrix\.sh contract-prebuild[\s\S]*?dependsOn: \['privacy-zk-canonical-receipts'\][\s\S]*?resources: \{ cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 \}/u)
  assert.match(dagDeclaration, /commandStep\('privacy-zk-contract',[\s\S]*?privacy-zk-comment-matrix\.sh contract-postbuild[\s\S]*?dependsOn: \['frontend-build-ready', 'privacy-zk-contract-prebuild'\][\s\S]*?resources: \{ cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 \}/u)
  assert.doesNotMatch(dagDeclaration, /privacy-zk-comment-matrix\.sh benchmark/u)
  assert.match(dagDeclaration, /staticStageStep\('postbuild',[\s\S]*?dependsOn: \['frontend-build-ready'\][\s\S]*?exclusiveResources: \['frontend-dist', 'frontend-static-output'\]/u)
  assert.match(dagDeclaration, /staticStageStep\('isolated',[\s\S]*?dependsOn: \['vitest-settled'\][\s\S]*?frontend-render-pressure/u)
  assert.match(dagDeclaration, /commandStep\('frontend-static-final-ready',[\s\S]*?frontend-static-concurrent[\s\S]*?frontend-static-postbuild[\s\S]*?frontend-static-isolated[\s\S]*?runAfterSettled: true,[\s\S]*?coordinationOnly: true/u)
  assert.match(dagDeclaration, /staticStageStep\('final',[\s\S]*?dependsOn: \['frontend-static-final-ready'\]/u)
    assert.match(dagDeclaration, /commandStep\([\s\S]*?'frontend-render-structure',[\s\S]*?frontend-render-structure\.sh[\s\S]*?\['frontend-render-structure'\][\s\S]*?dependsOn: \['frontend-static-final'\]/u);
    assert.match(dagDeclaration, /\.tmp\/frontend\/receipts\/dom-depth-static\.json[\s\S]*?frontend-render-structure-summary\.json/u);
    assert.match(dagDeclaration, /\.tmp\/frontend\/receipts\/markdown-render-budget\.json/u);
  assert.match(dagDeclaration, /commandStep\('vitest-settled',[\s\S]*?runAfterSettled: true/u)
  assert.match(dagDeclaration, /perfStep,[\s\S]*?commandStep\('static-governance-post-vitest'[\s\S]*?ensure test-asset-governance/u);
    assert.match(dagDeclaration, /commandStep\('frontend-tests-join',[\s\S]*?'vitest-production-projects'[\s\S]*?'frontend-static-concurrent'[\s\S]*?'frontend-static-postbuild'[\s\S]*?'frontend-static-isolated'[\s\S]*?'frontend-static-final'[\s\S]*?'frontend-render-structure'[\s\S]*?'frontend-coverage-summary'[\s\S]*?runAfterSettled: true/u);
    assert.match(runnerSource, /\['static-governance', 'frontend-static-governance', 'frontend-render-structure'\]\.includes\(tierId\)/u);
})

test('frontend bundle model overlaps Vitest and static work then joins all settled failures', async () => {
  const buildReady = deferred()
  const vitestRelease = deferred()
  const staticRelease = deferred()
  const first = new Error('vitest failed')
  const second = new Error('static governance failed')
  const started = []
  let joinOutcomes = null

  const execution = executeWeightedStepDag([
    ordinaryStep('frontend-build-ready'),
    {
      ...ordinaryStep('vitest-production-projects', ['frontend-build-ready']),
      resources: {
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1,
        exclusiveResources: ['frontend-test-results']
      }
    },
    ordinaryStep('frontend-static-concurrent'),
    {
      ...ordinaryStep('frontend-static-postbuild', ['frontend-build-ready']),
      resources: {
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1,
        exclusiveResources: ['frontend-static-output']
      }
    },
    coordinationStep('vitest-settled', ['vitest-production-projects'], true),
    ordinaryStep('isolated-frontend-perf', ['vitest-settled']),
    ordinaryStep('test-asset-governance', ['vitest-settled']),
    ordinaryStep('static-governance-post-vitest', ['vitest-settled']),
    ordinaryStep('frontend-coverage-summary', ['vitest-settled']),
    coordinationStep('frontend-tests-join', [
      'vitest-production-projects',
      'frontend-static-concurrent',
      'frontend-static-postbuild',
      'static-governance-post-vitest',
      'frontend-coverage-summary'
    ], true)
  ], {
    maxParallel: 4,
    cpuUnits: 4,
    memoryGiB: 4,
    exclusiveResources: ['frontend-test-results', 'frontend-static-output']
  }, async (step) => {
    started.push(step.id)
    if (step.id === 'frontend-build-ready') await buildReady.promise
    if (step.id === 'vitest-production-projects') {
      await vitestRelease.promise
      throw first
    }
    if (step.id === 'frontend-static-concurrent') {
      await staticRelease.promise
      throw second
    }
    if (step.id === 'frontend-tests-join') joinOutcomes = step.dependencyOutcomes
    if (step.runAfterSettled) return settledOutcome(step)
  })

  await nextTurn()
  assert.deepEqual(started, ['frontend-build-ready', 'frontend-static-concurrent'])
  buildReady.resolve()
  await nextTurn()
  assert.deepEqual(started.slice(0, 3), [
    'frontend-build-ready',
    'frontend-static-concurrent',
    'vitest-production-projects'
  ])
  assert.ok(started.includes('frontend-static-postbuild'),
    'postbuild work must overlap Vitest after the immutable build marker')

  vitestRelease.resolve()
  await nextTurn()
  assert.ok(started.includes('vitest-settled'))
  assert.equal(started.includes('static-governance-post-vitest'), false)
  assert.equal(started.includes('frontend-coverage-summary'), false)
  assert.equal(started.includes('isolated-frontend-perf'), false)
  assert.equal(started.includes('test-asset-governance'), false)

  staticRelease.resolve()
  await assert.rejects(execution, (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [first, second])
    return true
  })
  assert.equal(started.at(-1), 'frontend-tests-join')
  assert.deepEqual(joinOutcomes, {
    'vitest-production-projects': 'failed',
    'frontend-static-concurrent': 'failed',
    'frontend-static-postbuild': 'success',
    'static-governance-post-vitest': 'blocked',
    'frontend-coverage-summary': 'blocked'
  })
})

test('perf starts after every rolling host settles without waiting for unrelated build-static tail work', async () => {
  const marker = deferred()
  const hostOne = deferred()
  const hostTwo = deferred()
  const unrelatedFuzz = deferred()
  const started = []
  let unrelatedFuzzSettled = false
  unrelatedFuzz.promise.then(() => { unrelatedFuzzSettled = true })

  const execution = executeWeightedStepDag([
    coordinationStep('frontend-build-ready'),
    ordinaryStep('vitest-production-projects'),
    coordinationStep('vitest-settled', ['vitest-production-projects'], true),
    ordinaryStep('vitest-production-perf-isolated', ['frontend-build-ready', 'vitest-settled'])
  ], { maxParallel: 3, cpuUnits: 3, memoryGiB: 3 }, async (step) => {
    started.push(step.id)
    if (step.id === 'frontend-build-ready') await marker.promise
    if (step.id === 'vitest-production-projects') await Promise.all([hostOne.promise, hostTwo.promise])
    if (step.id === 'vitest-production-perf-isolated') {
      assert.equal(unrelatedFuzzSettled, false)
    }
    if (step.runAfterSettled) return settledOutcome(step)
  })

  marker.resolve()
  hostOne.resolve()
  await nextTurn()
  assert.equal(started.includes('vitest-production-perf-isolated'), false)
  hostTwo.resolve()
  await execution
  assert.ok(started.includes('vitest-production-perf-isolated'))
  unrelatedFuzz.resolve()
})

test('blocking static admission must settle before Vitest or concurrent static work starts', async () => {
  const blocking = deferred()
  const release = deferred()
  const started = []
  const execution = (async () => {
    await blocking.promise
    await executeWeightedStepDag([
      ordinaryStep('vitest-production-projects'),
      ordinaryStep('frontend-static-concurrent')
    ], {
      maxParallel: 2,
      cpuUnits: 2,
      memoryGiB: 2,
      exclusiveResources: []
    }, async (step) => {
      started.push(step.id)
      await release.promise
    })
  })()

  await nextTurn()
  assert.deepEqual(started, [])
  blocking.resolve()
  await waitFor(() => started.length === 2)
  assert.deepEqual(new Set(started), new Set(['vitest-production-projects', 'frontend-static-concurrent']))
  release.resolve()
  await execution
})

test('frontend bundle delays Vitest until the machine-derived floor and fills early capacity with other work', async () => {
  const vitestRelease = deferred()
  const staticRelease = deferred()
  const started = []
  let cpuUnits = 2

  const execution = executeWeightedStepDag([
    coordinationStep('frontend-early-test-capacity-ready'),
    {
      ...ordinaryStep('vitest-production-projects', ['frontend-early-test-capacity-ready']),
      resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 3 }
    },
    ordinaryStep('static-governance-concurrent', ['frontend-early-test-capacity-ready'])
  ], () => ({ maxParallel: cpuUnits, cpuUnits, memoryGiB: cpuUnits }), async (step) => {
    started.push({ id: step.id, cpuUnits: step.runtimeCapacity.cpuUnits })
    if (step.id === 'vitest-production-projects') await vitestRelease.promise
    if (step.id === 'static-governance-concurrent') await staticRelease.promise
  })

  await nextTurn()
  assert.ok(!started.some((entry) => entry.id === 'vitest-production-projects'))
  assert.ok(started.some((entry) => entry.id === 'static-governance-concurrent' && entry.cpuUnits === 2))

  cpuUnits = 3
  staticRelease.resolve()
  await waitFor(() => started.some((entry) => entry.id === 'vitest-production-projects'))
  assert.ok(started.some((entry) => entry.id === 'vitest-production-projects' && entry.cpuUnits === 3), JSON.stringify(started))

  vitestRelease.resolve()
  await execution
})

test('three-CPU frontend admission runs canonical static owner before Privacy/ZK projection', async () => {
  const vitestRelease = deferred()
  const privacyRelease = deferred()
  const staticRelease = deferred()
  const started = []
  const execution = executeWeightedStepDag([
    coordinationStep('frontend-early-test-capacity-ready'),
    {
      ...ordinaryStep('vitest-production-projects', ['frontend-early-test-capacity-ready']),
      resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 2 }
    },
    ordinaryStep('static-governance-concurrent', ['frontend-early-test-capacity-ready']),
        ordinaryStep('privacy-zk-canonical-receipts', ['static-governance-concurrent']),
    ordinaryStep('privacy-zk-contract-prebuild', ['privacy-zk-canonical-receipts'])
  ], { maxParallel: 3, cpuUnits: 3, memoryGiB: 3 }, async (step) => {
    started.push({ id: step.id, cpuUnits: step.runtimeCapacity.cpuUnits })
    if (step.id === 'vitest-production-projects') await vitestRelease.promise
    if (step.id === 'privacy-zk-contract-prebuild') await privacyRelease.promise
    if (step.id === 'static-governance-concurrent') await staticRelease.promise
  })

  await waitFor(() => started.length >= 3)
  assert.deepEqual(started.slice(0, 3), [
    { id: 'frontend-early-test-capacity-ready', cpuUnits: 0 },
    { id: 'vitest-production-projects', cpuUnits: 2 },
    { id: 'static-governance-concurrent', cpuUnits: 1 }
  ])
  assert.ok(!started.some((entry) => entry.id === 'privacy-zk-contract-prebuild'))

  staticRelease.resolve()
  await waitFor(() => started.some((entry) => entry.id === 'privacy-zk-contract-prebuild'))
  assert.deepEqual(started.at(-1), { id: 'privacy-zk-contract-prebuild', cpuUnits: 1 })
  privacyRelease.resolve()
  vitestRelease.resolve()
  await execution
})

test('sub-three-CPU frontend admission gives Vitest the complete grant before companions', async () => {
  for (const cpuUnits of [1, 2]) {
    const vitestRelease = deferred()
    const companionRelease = deferred()
    const started = []
    const execution = executeWeightedStepDag([
      coordinationStep('frontend-early-test-capacity-ready'),
      {
        ...ordinaryStep('vitest-production-projects', ['frontend-early-test-capacity-ready']),
        resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: cpuUnits }
      },
      ordinaryStep('static-governance-concurrent', ['frontend-early-test-capacity-ready'])
    ], { maxParallel: cpuUnits, cpuUnits, memoryGiB: cpuUnits }, async (step) => {
      started.push({ id: step.id, cpuUnits: step.runtimeCapacity.cpuUnits })
      if (step.id === 'vitest-production-projects') await vitestRelease.promise
      if (step.id === 'static-governance-concurrent') await companionRelease.promise
    })

    await waitFor(() => started.some((entry) => entry.id === 'vitest-production-projects'))
    assert.ok(started.some((entry) => entry.id === 'vitest-production-projects' && entry.cpuUnits === cpuUnits))
    assert.ok(!started.some((entry) => entry.id === 'static-governance-concurrent'))

    vitestRelease.resolve()
    await waitFor(() => started.some((entry) => entry.id === 'static-governance-concurrent'))
    companionRelease.resolve()
    await execution
  }
})

test('concurrent privacy and static work cannot write Vitest reports, coverage, dependencies, dist, or generated source', () => {
  const vitestOwnedPaths = [
    '.tmp/test-results/vitest',
    'src/frontend/coverage',
    'src/frontend/node_modules',
    'src/frontend/dist',
    'src/frontend/src/generated'
  ]
  assert.match(vitestSharedSource, /\.tmp\/test-results\/vitest\//u)
  assert.match(vitestUnitSource, /reportsDirectory: 'coverage\/unit'/u)

  const concurrentStatic = sourceSection(
    staticLaneSource,
    'RunStaticConcurrentPhase() {',
    'RunStaticNodeContractsPhase() {'
  )
  const postVitestStatic = sourceSection(
    staticLaneSource,
    'RunStaticPostVitestPhase() {',
    'STATIC_GOVERNANCE_PHASE='
  )
  assert.doesNotMatch(concurrentStatic, /StaticRetention/u)
  assert.match(postVitestStatic, /StaticRetention/u)
  assert.match(staticHostSource, /access: 'read'/u)
  assert.doesNotMatch(staticHostSource, /access: 'write'/u)

  const privacyPrebuild = frontendPackage.scripts['check:privacy-zk-contract:prebuild']
  const privacyPostbuild = frontendPackage.scripts['check:privacy-zk-contract:postbuild']
  assert.match(privacyPrebuild, /comment-privacy-build-contract\.mjs/u)
  assert.match(privacyPrebuild, /check-zk-artifact-ownership\.mjs/u)
  assert.doesNotMatch(privacyPrebuild, /\bvitest\b/u)
  assert.doesNotMatch(privacyPostbuild, /\bvitest\b/u)
  assert.match(privacyLaneSource, /STAGE_DIR="\$ROOT_DIR\/\.tmp\/security\/privacy-zk-comment-matrix-stages"/u)

  const concurrentSources = [
    staticLaneSource,
    privacyLaneSource,
    fs.readFileSync(new URL('../../tools/security/comment-privacy-build-contract.mjs', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../tools/ci/check-flaky-registry.mjs', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../tools/docs/check-integrity-proof-docs.mjs', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../tools/check-doc-implementation-drift.mjs', import.meta.url), 'utf8')
  ]
  for (const source of concurrentSources) {
    for (const ownedPath of vitestOwnedPaths) {
      const escaped = ownedPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      const mutatingReference = new RegExp(
        `(?:writeFileSync|renameSync|mkdirSync|rmSync|rm -rf|cp |mv |tee )[^\\n]{0,240}${escaped}`,
        'u'
      )
      assert.doesNotMatch(source, mutatingReference, `concurrent writer reaches Vitest-owned path ${ownedPath}`)
    }
  }

  assert.match(
    runnerSource,
    /commandStep\('privacy-zk-contract',[\s\S]*?dependsOn: \['frontend-build-ready', 'privacy-zk-contract-prebuild'\]/u,
    'privacy postbuild may read generated wasm only after the build is immutable'
  )
  assert.match(
    runnerSource,
    /commandStep\('static-governance-post-vitest',[\s\S]*?dependsOn: \['vitest-settled'\]/u
  )
  assert.match(
    runnerSource,
    /staticStageStep\('postbuild',[\s\S]*?exclusiveResources: \['frontend-dist', 'frontend-static-output'\]/u
  )
  assert.match(
    runnerSource,
    /frontend-coverage-summary[\s\S]*?exclusiveResources: \['frontend-test-results', 'frontend-coverage'\]/u
  )
})

function ordinaryStep(id, dependsOn = []) {
  return {
    id,
    dependsOn,
    resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
  }
}

function coordinationStep(id, dependsOn = [], runAfterSettled = false) {
  return {
    id,
    dependsOn,
    runAfterSettled,
    resources: { coordinationOnly: true }
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await nextTurn()
  }
}

function sourceSection(source, start, end) {
  const startAt = source.indexOf(start)
  const endAt = source.indexOf(end, startAt + start.length)
  assert.ok(startAt >= 0 && endAt > startAt, `missing source section ${start}`)
  return source.slice(startAt, endAt)
}
