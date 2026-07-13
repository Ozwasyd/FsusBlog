import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { executeWeightedStepDag } from '../../tools/test/bundles/bundle-steps.mjs'

const runnerSource = fs.readFileSync(new URL('../../tools/test/bundles/run-bundle.mjs', import.meta.url), 'utf8')
const staticLaneSource = fs.readFileSync(new URL('../../tools/test/lanes/static-governance.sh', import.meta.url), 'utf8')
const privacyLaneSource = fs.readFileSync(new URL('../../tools/test/lanes/privacy-zk-comment-matrix.sh', import.meta.url), 'utf8')
const frontendPackage = JSON.parse(fs.readFileSync(new URL('../../src/frontend/package.json', import.meta.url), 'utf8'))
const vitestSharedSource = fs.readFileSync(new URL('../../src/frontend/vitest.shared.mjs', import.meta.url), 'utf8')
const vitestUnitSource = fs.readFileSync(new URL('../../src/frontend/vitest.config.ts', import.meta.url), 'utf8')

test('frontend bundle starts one complete Vitest host before build while coordination waits consume no CPU', () => {
  const vitestStart = runnerSource.indexOf("const step = commandStep('vitest-production-projects'")
  const dagStart = runnerSource.indexOf('await executeWeightedStepDag([', vitestStart)
  const dagEnd = runnerSource.indexOf('], bundleDagCapacity, async (frontendStep)', dagStart)
  assert.ok(vitestStart >= 0 && dagStart > vitestStart && dagEnd > dagStart)

  const vitestDeclaration = runnerSource.slice(vitestStart, dagStart)
  const dagDeclaration = runnerSource.slice(dagStart, dagEnd)
  assert.match(vitestDeclaration, /node tools\/test\/run-frontend-vitest-rolling-shards\.mjs/u)
  assert.match(runnerSource, /const fullVitestCpuUnits = resolvedFrontendTestCpuTarget\(\)/u)
  assert.match(runnerSource, /cpuCount - backendFloor - runtimeFloor/u)
  assert.match(vitestDeclaration, /dependsOn: \['frontend-early-test-capacity-ready'\]/u)
  assert.match(vitestDeclaration, /FSUSBLOG_VITEST_TARGET_WORKERS: String\(fullVitestCpuUnits\)/u)
  assert.match(vitestDeclaration, /minCpuUnits: 1/u)
  assert.doesNotMatch(vitestDeclaration, /dependsOn: \[[^\]]*frontend-build-ready/u)
  assert.doesNotMatch(vitestDeclaration, /\b(?:maxErrors|maxFailures|failFast|bail)\b/u)

  const staticStart = dagDeclaration.indexOf("commandStep('static-governance-concurrent'")
  const postbuildStart = dagDeclaration.indexOf("'frontend-static-postbuild'")
  assert.ok(staticStart >= 0 && postbuildStart > staticStart,
    'ordinary Vitest/static work must be declared before the queued postbuild writer')
  assert.match(dagDeclaration.slice(staticStart, postbuildStart), /dependsOn: \['frontend-build-ready'\]/u)
  assert.match(dagDeclaration, /commandStep\('frontend-build-ready',[\s\S]*?coordinationOnly: true/u)
  assert.match(dagDeclaration, /commandStep\('frontend-early-test-capacity-ready',[\s\S]*?coordinationOnly: true/u)
  assert.match(dagDeclaration, /commandStep\('frontend-test-capacity-ready',[\s\S]*?coordinationOnly: true/u)
  assert.ok(
    dagDeclaration.indexOf('\n    step,') < dagDeclaration.indexOf("commandStep('privacy-zk-contract-prebuild'"),
    'Vitest must be declared before every ordinary privacy/static sibling'
  )
  assert.match(dagDeclaration, /commandStep\('static-governance-concurrent',[\s\S]*?static-governance\.sh concurrent-prechecks[\s\S]*?dependsOn: \['frontend-build-ready'\]/u)
  assert.match(dagDeclaration, /commandStep\('static-governance-node-contracts',[\s\S]*?static-governance\.sh node-contracts[\s\S]*?dependsOn: \['vitest-settled'\][\s\S]*?cpuWeight: 2/u)
  assert.match(dagDeclaration, /commandStep\('privacy-zk-contract-prebuild',[\s\S]*?privacy-zk-comment-matrix\.sh contract-prebuild[\s\S]*?dependsOn: \['frontend-early-test-capacity-ready'\][\s\S]*?resources: \{ cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 \}/u)
  assert.match(dagDeclaration, /commandStep\('privacy-zk-contract',[\s\S]*?privacy-zk-comment-matrix\.sh contract-postbuild[\s\S]*?dependsOn: \['frontend-build-ready', 'privacy-zk-contract-prebuild'\][\s\S]*?resources: \{ cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 \}/u)
  assert.doesNotMatch(dagDeclaration, /privacy-zk-comment-matrix\.sh benchmark/u)
  assert.match(dagDeclaration.slice(postbuildStart), /exclusiveResources: \['frontend-test-results'\]/u)
  assert.match(dagDeclaration, /commandStep\('vitest-settled',[\s\S]*?runAfterSettled: true/u)
  assert.match(dagDeclaration, /commandStep\('frontend-tests-join',[\s\S]*?'vitest-production-projects'[\s\S]*?'static-governance-concurrent'[\s\S]*?'static-governance-node-contracts'[\s\S]*?'frontend-static-postbuild'[\s\S]*?'static-governance-post-vitest'[\s\S]*?'frontend-coverage-summary'[\s\S]*?runAfterSettled: true/u)
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
    ordinaryStep('vitest-production-projects', ['frontend-build-ready']),
    ordinaryStep('static-governance-concurrent'),
    {
      ...ordinaryStep('frontend-static-postbuild', ['frontend-build-ready']),
      resources: {
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1,
        exclusiveResources: ['frontend-test-results']
      }
    },
    coordinationStep('vitest-settled', ['vitest-production-projects'], true),
    ordinaryStep('static-governance-post-vitest', ['vitest-settled']),
    ordinaryStep('frontend-coverage-summary', ['vitest-settled']),
    coordinationStep('frontend-tests-join', [
      'vitest-production-projects',
      'static-governance-concurrent',
      'frontend-static-postbuild',
      'static-governance-post-vitest',
      'frontend-coverage-summary'
    ], true)
  ], {
    maxParallel: 4,
    cpuUnits: 4,
    memoryGiB: 4,
    exclusiveResources: ['frontend-test-results']
  }, async (step) => {
    started.push(step.id)
    if (step.id === 'frontend-build-ready') await buildReady.promise
    if (step.id === 'vitest-production-projects') {
      await vitestRelease.promise
      throw first
    }
    if (step.id === 'static-governance-concurrent') {
      await staticRelease.promise
      throw second
    }
    if (step.id === 'frontend-tests-join') joinOutcomes = step.dependencyOutcomes
  })

  await nextTurn()
  assert.deepEqual(started, ['frontend-build-ready', 'static-governance-concurrent'])
  buildReady.resolve()
  await nextTurn()
  assert.deepEqual(started.slice(0, 3), [
    'frontend-build-ready',
    'static-governance-concurrent',
    'vitest-production-projects'
  ])
  assert.ok(!started.includes('frontend-static-postbuild'))

  vitestRelease.resolve()
  await nextTurn()
  assert.ok(started.includes('vitest-settled'))
  assert.ok(started.includes('static-governance-post-vitest'))
  assert.ok(started.includes('frontend-coverage-summary'))
  assert.ok(!started.includes('frontend-static-postbuild'), 'postbuild writer must wait for active readers')

  staticRelease.resolve()
  await assert.rejects(execution, (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [first, second])
    return true
  })
  assert.equal(started.at(-1), 'frontend-tests-join')
  assert.deepEqual(joinOutcomes, {
    'vitest-production-projects': 'failure',
    'static-governance-concurrent': 'failure',
    'frontend-static-postbuild': 'success',
    'static-governance-post-vitest': 'success',
    'frontend-coverage-summary': 'success'
  })
})

test('frontend bundle admits one complete Vitest host at the early dynamic grant and fills later capacity', async () => {
  const fullCapacityReady = deferred()
  const vitestRelease = deferred()
  const staticRelease = deferred()
  const started = []
  let cpuUnits = 2

  const execution = executeWeightedStepDag([
    coordinationStep('frontend-early-test-capacity-ready'),
    coordinationStep('frontend-test-capacity-ready'),
    {
      ...ordinaryStep('vitest-production-projects', ['frontend-early-test-capacity-ready']),
      resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 2 }
    },
    ordinaryStep('static-governance-concurrent', ['frontend-early-test-capacity-ready'])
  ], () => ({ maxParallel: cpuUnits, cpuUnits, memoryGiB: cpuUnits }), async (step) => {
    started.push({ id: step.id, cpuUnits: step.runtimeCapacity.cpuUnits })
    if (step.id === 'frontend-test-capacity-ready') await fullCapacityReady.promise
    if (step.id === 'vitest-production-projects') await vitestRelease.promise
    if (step.id === 'static-governance-concurrent') await staticRelease.promise
  })

  await nextTurn()
  assert.ok(started.some((entry) => entry.id === 'vitest-production-projects' && entry.cpuUnits === 2))
  assert.ok(!started.some((entry) => entry.id === 'static-governance-concurrent'))

  cpuUnits = 3
  fullCapacityReady.resolve()
  await waitFor(() => started.some((entry) => entry.id === 'static-governance-concurrent'))
  assert.ok(started.some((entry) => entry.id === 'static-governance-concurrent' && entry.cpuUnits === 1), JSON.stringify(started))

  vitestRelease.resolve()
  staticRelease.resolve()
  await execution
})

test('three-CPU frontend admission starts Vitest at 2 plus one companion at 1 without starving static', async () => {
  const vitestRelease = deferred()
  const privacyRelease = deferred()
  const staticRelease = deferred()
  const started = []
  const execution = executeWeightedStepDag([
    coordinationStep('frontend-test-capacity-ready'),
    {
      ...ordinaryStep('vitest-production-projects', ['frontend-test-capacity-ready']),
      resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 2 }
    },
    ordinaryStep('privacy-zk-contract-prebuild', ['frontend-test-capacity-ready']),
    ordinaryStep('static-governance-concurrent', ['frontend-test-capacity-ready'])
  ], { maxParallel: 3, cpuUnits: 3, memoryGiB: 3 }, async (step) => {
    started.push({ id: step.id, cpuUnits: step.runtimeCapacity.cpuUnits })
    if (step.id === 'vitest-production-projects') await vitestRelease.promise
    if (step.id === 'privacy-zk-contract-prebuild') await privacyRelease.promise
    if (step.id === 'static-governance-concurrent') await staticRelease.promise
  })

  await waitFor(() => started.length >= 3)
  assert.deepEqual(started.slice(0, 3), [
    { id: 'frontend-test-capacity-ready', cpuUnits: 0 },
    { id: 'vitest-production-projects', cpuUnits: 2 },
    { id: 'privacy-zk-contract-prebuild', cpuUnits: 1 }
  ])
  assert.ok(!started.some((entry) => entry.id === 'static-governance-concurrent'))

  privacyRelease.resolve()
  await waitFor(() => started.some((entry) => entry.id === 'static-governance-concurrent'))
  assert.deepEqual(started.at(-1), { id: 'static-governance-concurrent', cpuUnits: 1 })

  staticRelease.resolve()
  vitestRelease.resolve()
  await execution
})

test('sub-three-CPU frontend admission gives Vitest the complete grant before companions', async () => {
  for (const cpuUnits of [1, 2]) {
    const vitestRelease = deferred()
    const companionRelease = deferred()
    const started = []
    const execution = executeWeightedStepDag([
      coordinationStep('frontend-test-capacity-ready'),
      {
        ...ordinaryStep('vitest-production-projects', ['frontend-test-capacity-ready']),
        resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: cpuUnits }
      },
      ordinaryStep('static-governance-concurrent', ['frontend-test-capacity-ready'])
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
    'run_static_concurrent_phase() {',
    'run_static_node_contracts_phase() {'
  )
  const postVitestStatic = sourceSection(
    staticLaneSource,
    'run_static_post_vitest_phase() {',
    'STATIC_GOVERNANCE_PHASE='
  )
  assert.doesNotMatch(concurrentStatic, /static_retention/u)
  assert.match(postVitestStatic, /static_retention/u)
  assert.match(staticLaneSource, /access: 'read'/u)
  assert.doesNotMatch(staticLaneSource, /access: 'write'/u)

  const privacyPrebuild = frontendPackage.scripts['check:privacy-zk-contract:prebuild']
  const privacyPostbuild = frontendPackage.scripts['check:privacy-zk-contract:postbuild']
  assert.match(privacyPrebuild, /build-zk-comment-v2-r1cs\.mjs --check/u)
  assert.match(privacyPrebuild, /build-zk-comment-v2-circuit-fixture\.mjs --check/u)
  assert.doesNotMatch(privacyPrebuild, /\bvitest\b/u)
  assert.doesNotMatch(privacyPostbuild, /\bvitest\b/u)
  assert.match(privacyLaneSource, /STAGE_DIR="\$ROOT_DIR\/\.tmp\/security\/privacy-zk-comment-matrix-stages"/u)

  const concurrentSources = [
    staticLaneSource,
    privacyLaneSource,
    fs.readFileSync(new URL('../../tools/crypto/check-zk-comment-v2-manifests.mjs', import.meta.url), 'utf8'),
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
    /frontend-static-postbuild[\s\S]*?exclusiveResources: \['frontend-test-results'\]/u
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
