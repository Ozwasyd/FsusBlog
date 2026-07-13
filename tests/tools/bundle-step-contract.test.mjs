import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildSettledPhaseJoinEvidence,
  executeWeightedStepDag,
  performanceSteps,
  resolveBundleRuntimeCapacity,
  resolveBundleSteps,
  resolveConcurrentStepCapacities,
  resolveMachineExecutionTimeoutMs,
  resolveStepRuntimeCapacity,
  runtimeSteps
} from '../../tools/test/bundles/bundle-steps.mjs'
import { parseRuntimeEnvironment } from '../../tools/test/bundles/runtime-environment.mjs'

const byId = (steps) => new Map(steps.map((step) => [step.id, step]))

const runtimeEnvironmentFixture = (overrides = {}) => ({
  FSUSBLOG_TEST_NAMESPACE: 'runtime-focused-1',
  FSUSBLOG_DEBUG_BACKEND_PORT: '24501',
  FSUSBLOG_DEBUG_FRONTEND_PORT: '26501',
  FSUSBLOG_RELEASE_PREVIEW_PORT: '28501',
  FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:24501',
  FSUSBLOG_DEBUG_FRONTEND_URL: 'http://127.0.0.1:26501',
  FSUSBLOG_RELEASE_PREVIEW_URL: 'http://127.0.0.1:28501',
  Jwt__SecretKey: 'test-only-secret-that-is-long-enough',
  ...overrides
})

const serializeRuntimeEnvironment = (environment) => Object.entries(environment)
  .map(([key, value]) => `${key}=${value}`)
  .join('\n')

test('runtime environment parser preserves non-shell values and binds all URLs to the current namespace', () => {
  const environment = parseRuntimeEnvironment(
    serializeRuntimeEnvironment(runtimeEnvironmentFixture({
      ConnectionStrings__DefaultConnection: 'Host=127.0.0.1;Port=24501;Password=value=with=equals'
    })),
    'runtime-focused-1'
  )
  assert.equal(environment.Jwt__SecretKey, 'test-only-secret-that-is-long-enough')
  assert.equal(
    environment.ConnectionStrings__DefaultConnection,
    'Host=127.0.0.1;Port=24501;Password=value=with=equals'
  )
})

test('runtime environment parser rejects foreign namespaces, unsafe keys, and URL-port mismatches', () => {
  const fixture = runtimeEnvironmentFixture()
  assert.throws(
    () => parseRuntimeEnvironment(serializeRuntimeEnvironment(fixture), 'another-run'),
    /namespace does not match/u
  )
  assert.throws(
    () => parseRuntimeEnvironment(`${serializeRuntimeEnvironment(fixture)}\nNODE_OPTIONS=--require=payload`, 'runtime-focused-1'),
    /key is not allowed: NODE_OPTIONS/u
  )
  assert.throws(
    () => parseRuntimeEnvironment(serializeRuntimeEnvironment({
      ...fixture,
      FSUSBLOG_RELEASE_PREVIEW_URL: 'http://127.0.0.1:28502'
    }), 'runtime-focused-1'),
    /not bound to loopback/u
  )
  for (const invalidUrl of [
    'https://127.0.0.1:28501',
    'http://localhost:28501',
    'http://user:secret@127.0.0.1:28501',
    'http://127.0.0.1:28501/unexpected',
    'http://127.0.0.1:28501/?query=1'
  ]) {
    assert.throws(
      () => parseRuntimeEnvironment(serializeRuntimeEnvironment({
        ...fixture,
        FSUSBLOG_RELEASE_PREVIEW_URL: invalidUrl
      }), 'runtime-focused-1'),
      /not bound to loopback/u
    )
  }
  assert.throws(
    () => parseRuntimeEnvironment(`${serializeRuntimeEnvironment(fixture)}\nJwt__SecretKey=duplicate`, 'runtime-focused-1'),
    /key is duplicated/u
  )
  assert.throws(
    () => parseRuntimeEnvironment(serializeRuntimeEnvironment(fixture), '../runtime-focused-1'),
    /expected namespace is invalid/u
  )
})

test('runtime bundle loads its generated environment only after bootstrap and before step overrides', () => {
  const source = readFileSync(new URL('../../tools/test/bundles/run-bundle.mjs', import.meta.url), 'utf8')
  const processEnvironment = source.indexOf('...childBaseEnvironment')
  const runtimeEnvironment = source.indexOf('...runtimeChildEnvironment', processEnvironment)
  const stepEnvironment = source.indexOf('...(step.env ?? {})', runtimeEnvironment)
  assert.ok(processEnvironment >= 0 && runtimeEnvironment > processEnvironment && stepEnvironment > runtimeEnvironment)

  const bootstrapExecution = source.indexOf("const result = await executeStep(step)\n    if (step.id === 'bootstrap')")
  const environmentRead = source.indexOf('runtimeChildEnvironment = readRuntimeEnvironment(root, namespace)', bootstrapExecution)
  assert.ok(bootstrapExecution >= 0 && environmentRead > bootstrapExecution)
  assert.doesNotMatch(source.slice(bootstrapExecution, environmentRead), /source\s+[^\n]*\.env/u)
})

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for DAG test condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('runtime bundle removes artificial serial dependencies while retaining every logical member', () => {
  const steps = runtimeSteps()
  const index = byId(steps)
  assert.equal(steps.length, 27)
  assert.deepEqual(steps.flatMap((step) => step.members).sort(), [
    'acceptance', 'bootstrap', 'cross-browser-smoke', 'cross-stack-contract', 'csrf-browser-matrix',
    'data-scale-evidence-summary', 'data-scale-s', 'data-scale-xs', 'endpoint-depth', 'fault-injection',
    'frontend-render-pressure', 'integration', 'release', 'resilience', 'security-authenticated-dast',
    'rights-v3-test-matrix', 'security', 'ux-viewport-smoke',
    'visual', 'visual-console', 'visual-public'
  ].sort())

  assert.deepEqual(index.get('release-public-hydration').dependsOn, ['bootstrap'])
  for (const id of [
    'security-runtime-core',
    'endpoint-depth',
    'local-runtime-exposure'
  ]) {
    assert.deepEqual(index.get(id).dependsOn, ['release-public-hydration'])
  }
  assert.deepEqual(index.get('runtime-integration').dependsOn, ['security-runtime-core'])
  assert.deepEqual(index.get('zap-baseline').dependsOn, [
    'security-runtime-core', 'ux-risk-matrix', 'cross-browser', 'cross-stack-runtime'
  ])
  assert.deepEqual(index.get('authenticated-dast').dependsOn, ['security-runtime-core'])
  assert.deepEqual(index.get('cross-stack-runtime').dependsOn, ['runtime-integration'])
  assert.deepEqual(index.get('render-pressure').dependsOn, ['cross-stack-runtime'])
  assert.deepEqual(index.get('resilience').dependsOn, ['render-pressure'])
  assert.deepEqual(index.get('ux-risk-matrix').dependsOn, ['resilience'])
  assert.deepEqual(index.get('cross-browser').dependsOn, ['ux-risk-matrix'])
  assert.deepEqual(index.get('rights-matrix').dependsOn, ['runtime-integration'])
  assert.deepEqual(index.get('release-public').dependsOn, [
    'release-public-hydration', 'runtime-integration'
  ])
  assert.match(index.get('release-public').command, /FSUSBLOG_RELEASE_HYDRATION_PREPARED_BY_DAG=1/u)

  assert.deepEqual(index.get('cross-stack').dependsOn, ['security-static', 'backend-build-ready'])
  assert.deepEqual(index.get('csrf-matrix').dependsOn, ['security-static', 'backend-build-ready'])

  assert.deepEqual(index.get('bootstrap').dependsOn, [
    'backend-build-ready', 'frontend-build-ready', 'security-static'
  ])
  for (const id of ['backend-build-ready', 'frontend-build-ready']) {
    assert.deepEqual(index.get(id).dependsOn, [])
    assert.deepEqual(index.get(id).resources, { coordinationOnly: true })
  }
  assert.deepEqual(index.get('ux-risk-matrix').resources, {
    cpuWeight: 4,
    memoryWeight: 8,
    minCpuUnits: 1
  })
  assert.deepEqual(index.get('security-static').dependsOn, [])
  assert.deepEqual(index.get('security-static').members, [])
  assert.deepEqual(index.get('security-static').resources, {
    cpuWeight: 2,
    memoryWeight: 2,
    minCpuUnits: 1
  })
  assert.deepEqual(index.get('security-runtime-core').resources, {
    cpuWeight: 2,
    memoryWeight: 2,
    minCpuUnits: 1
  })
  assert.deepEqual(index.get('local-runtime-exposure').dependsOn, ['release-public-hydration'])
  assert.deepEqual(index.get('local-runtime-exposure').members, [])
  assert.match(index.get('local-runtime-exposure').command, /check-local-runtime-exposure\.mjs/u)
  assert.match(index.get('security-runtime-core').command, /FSUSBLOG_LOCAL_RUNTIME_EXPOSURE_IN_DAG=1/u)
  assert.deepEqual(index.get('authenticated-dast').dependsOn, ['security-runtime-core'])
  assert.deepEqual(index.get('authenticated-dast').members, ['security-authenticated-dast'])
  assert.deepEqual(index.get('authenticated-dast').resources, {
    cpuWeight: 1,
    memoryWeight: 1,
    minCpuUnits: 1
  })
  assert.deepEqual(index.get('security-join').dependsOn, ['security-static', 'security-runtime-core', 'local-runtime-exposure', 'zap-baseline'])
  assert.deepEqual(index.get('security-join').members, ['security'])
  assert.deepEqual(index.get('security-join').resources, { coordinationOnly: true })
  assert.equal(index.get('security-join').runAfterSettled, true)
  assert.deepEqual(index.get('cross-stack-join').dependsOn, ['cross-stack', 'cross-stack-runtime'])
  assert.deepEqual(index.get('cross-stack-join').members, ['cross-stack-contract'])
  assert.deepEqual(index.get('cross-stack-join').resources, { coordinationOnly: true })
  assert.equal(index.get('cross-stack-join').runAfterSettled, true)
  assert.deepEqual(index.get('zap-baseline').members, [])
  assert.equal(steps[0].id, 'backend-build-ready')
  assert.equal(steps[1].id, 'frontend-build-ready')
  assert.equal(steps[2].id, 'security-static', 'static security is the sole t0 executable task')
  assert.equal(steps[3].id, 'bootstrap', 'bootstrap follows markers and all pre-bootstrap source work')
  assert.equal(steps[4].id, 'release-public-hydration', 'release dist writes must settle before preview readers')
  assert.equal(steps[5].id, 'security-runtime-core', 'runtime security enters the first post-hydration wave')
  assert.equal(steps[6].id, 'ux-risk-matrix', 'UX shares the two-CPU critical-path wave with runtime security')
  assert.equal(steps[7].id, 'authenticated-dast', 'authenticated DAST is first to consume an elastic third CPU')
  assert.equal(index.has('privacy-zk'), false)
  assert.deepEqual(index.get('runtime-state-stable').dependsOn, [
    'runtime-integration', 'release-public', 'endpoint-depth', 'security-runtime-core', 'local-runtime-exposure',
    'authenticated-dast', 'zap-baseline', 'ux-risk-matrix', 'cross-stack-join', 'cross-browser', 'render-pressure',
    'rights-matrix', 'csrf-matrix', 'resilience'
  ])
  assert.deepEqual(index.get('runtime-state-stable').resources, { coordinationOnly: true })
  assert.equal(index.get('runtime-state-stable').dependsOn.includes('security-static'), false)
  assert.equal(index.get('runtime-state-stable').dependsOn.includes('security-join'), false)
  assert.deepEqual(index.get('data-scale-xs').dependsOn, ['runtime-state-stable'])
  assert.deepEqual(index.get('data-scale-s').dependsOn, ['runtime-state-stable'])
  assert.equal(index.get('data-scale-xs').resources.exclusiveResources, undefined)
  assert.equal(index.get('data-scale-s').resources.exclusiveResources, undefined)
  assert.deepEqual(index.get('data-scale-summary').dependsOn, ['data-scale-xs', 'data-scale-s'])
  assert.deepEqual(index.get('fault-injection').dependsOn, ['runtime-state-stable', 'data-scale-xs', 'data-scale-s'])
  assert.equal(steps.some((step) => Object.hasOwn(step.resources, 'cpuUnits') || Object.hasOwn(step.resources, 'memoryGiB')), false)
})

test('security phase join evidence binds every phase log and the complete concurrent span', () => {
  const joined = buildSettledPhaseJoinEvidence({
    stepId: 'security-join',
    dependencyIds: ['security-static', 'security-runtime-core', 'zap-baseline'],
    dependencyOutcomes: {
      'security-static': 'success',
      'security-runtime-core': 'success',
      'zap-baseline': 'success'
    },
    dependencyResults: new Map([
      ['security-static', { startedAtMs: 100, finishedAtMs: 500, durationMs: 400, logFile: 'static.log' }],
      ['security-runtime-core', { startedAtMs: 300, finishedAtMs: 800, durationMs: 500, logFile: 'core.log' }],
      ['zap-baseline', { startedAtMs: 350, finishedAtMs: 600, durationMs: 250, logFile: 'zap.log' }]
    ]),
    generatedAt: '2026-07-12T00:00:00.000Z'
  })
  assert.equal(joined.evidence.status, 'success')
  assert.deepEqual(joined.evidence.dependencies.map((entry) => entry.id), [
    'security-static', 'security-runtime-core', 'zap-baseline'
  ])
  assert.deepEqual(joined.dependencyLogs, ['static.log', 'core.log', 'zap.log'])
  assert.equal(joined.durationMs, 700)
})

test('performance bundle folds the complete backend benchmark into the mixed window and joins exact evidence', () => {
  const steps = performanceSteps()
  const index = byId(steps)
  const measurements = ['backend-perf', 'mixed-performance-window', 'aeds-frame-cost']
  const measurementPreparation = ['coverage-threshold', 'browser-performance', 'aeds-compression']
  const evidenceInputs = [
    'backend-perf', 'privacy-zk-benchmark', 'privacy-zk-finalize', 'mixed-performance-window',
    'browser-performance', 'aeds-frame-cost', 'aeds-compression'
  ]
  assert.equal(steps.length, 15)
  for (const id of measurements.filter((id) => id !== 'mixed-performance-window')) {
    assert.deepEqual(index.get(id).dependsOn, measurementPreparation)
    assert.deepEqual(index.get(id).resources.exclusiveResources, ['benchmark-window'])
  }
  assert.deepEqual(index.get('mixed-performance-window').dependsOn, [
    ...measurementPreparation,
    'performance-runtime-bootstrap'
  ])
  assert.deepEqual(index.get('mixed-performance-window').resources.exclusiveResources, ['benchmark-window'])
  assert.deepEqual(index.get('privacy-zk-performance-ready').dependsOn, ['privacy-zk-project-functional'])
  assert.equal(index.get('privacy-zk-performance-ready').resources.exclusiveResources, undefined)
  assert.deepEqual(index.get('privacy-zk-benchmark').dependsOn, [
    ...measurementPreparation,
    'privacy-zk-performance-ready'
  ])
  assert.deepEqual(index.get('privacy-zk-benchmark').resources.exclusiveResources, ['benchmark-window'])
  assert.deepEqual(index.get('privacy-zk-benchmark').members, ['privacy-zk-comment-matrix'])
  assert.deepEqual(index.get('privacy-zk-finalize').dependsOn, ['privacy-zk-benchmark'])
  assert.deepEqual(index.get('privacy-zk-finalize').members, ['privacy-zk-comment-matrix'])
  assert.equal(index.get('privacy-zk-finalize').resources.exclusiveResources, undefined)
  assert.deepEqual(index.get('browser-performance').dependsOn, [])
  assert.equal(index.get('browser-performance').resources.exclusiveResources, undefined)
  assert.equal(index.get('coverage-merge').resources.exclusiveResources, undefined)
  assert.equal(index.get('coverage-threshold').resources.exclusiveResources, undefined)
  assert.deepEqual(index.get('aeds-compression').dependsOn, [])
  assert.equal(index.get('aeds-compression').resources.exclusiveResources, undefined)
  assert.deepEqual(index.get('performance-summary').dependsOn, ['coverage-threshold', ...evidenceInputs])
  assert.deepEqual(index.get('release-evidence').dependsOn, ['performance-summary'])
  assert.deepEqual(index.get('production-summary').dependsOn, ['release-evidence'])
  assert.equal(index.get('mixed-performance-window').members.length, 18)
  assert.ok(index.get('mixed-performance-window').members.includes('backend-benchmark-regression'))
  assert.equal(index.has('backend-benchmark'), false)
  assert.equal(steps.some((step) => /\b(?:skip|maxFailures)\b/u.test(step.command)), false)
  assert.match(index.get('mixed-performance-window').command, /--reuse-passed/u)
  assert.equal(steps.some((step) => Object.hasOwn(step.resources, 'cpuUnits') || Object.hasOwn(step.resources, 'memoryGiB')), false)
})

test('AEDS compression is deterministic preparation rather than a timed profiler', () => {
  const source = readFileSync(new URL('../../benchmarks/core/Program.cs', import.meta.url), 'utf8')
  const start = source.indexOf('internal static class AedsCompressionProfiler')
  const end = source.indexOf('internal static class ProfilerSupport', start)
  assert.ok(start >= 0 && end > start)
  const profiler = source.slice(start, end)

  for (const token of ['encodedFrameBytes', 'ratio', 'bytesSaved', 'etag']) {
    assert.match(profiler, new RegExp(`\\b${token}\\b`, 'u'))
  }
  assert.doesNotMatch(profiler, /Stopwatch|ProfileMeasurement|AverageMs|P95Ms|durationMs/u)
})

test('scheduler grants use the full live machine capacity without bundle reference caps', () => {
  for (const cpuUnits of [4, 8, 16]) {
    const capacity = resolveBundleRuntimeCapacity({
      availableCpu: cpuUnits,
      availableMemoryGiB: cpuUnits * 2,
      inheritedCpuBudget: String(cpuUnits),
      inheritedMemoryGiB: String(cpuUnits * 1.5),
      cpuWeight: 2,
      memoryWeight: 3
    })
    assert.deepEqual(capacity, {
      maxParallel: cpuUnits,
      cpuUnits,
      memoryGiB: cpuUnits * 1.5
    })
  }

  assert.deepEqual(resolveBundleRuntimeCapacity({
    availableCpu: 12,
    availableMemoryGiB: 18,
    cpuWeight: 1,
    memoryWeight: 1
  }), { maxParallel: 12, cpuUnits: 12, memoryGiB: 18 })
})

test('each concurrent wave divides its actual CPU and memory grants by weights and minima', () => {
  const steps = resolveBundleSteps('any', [
    { id: 'light', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
    { id: 'heavy', resources: { cpuWeight: 3, memoryWeight: 2, minCpuUnits: 2 } }
  ], { cpuUnits: 8, memoryGiB: 12 })
  const allocations = resolveConcurrentStepCapacities(steps, { cpuUnits: 8, memoryGiB: 12 })
  assert.deepEqual(allocations, [
    { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 },
    { maxParallel: 6, cpuUnits: 6, memoryGiB: 8 }
  ])
  assert.equal(allocations.reduce((total, entry) => total + entry.cpuUnits, 0), 8)
  assert.equal(allocations.reduce((total, entry) => total + entry.memoryGiB, 0), 12)

  assert.deepEqual(
    resolveStepRuntimeCapacity('any', { id: 'only', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }, { cpuUnits: 6, memoryGiB: 9 }),
    { maxParallel: 6, cpuUnits: 6, memoryGiB: 9 }
  )
})

test('coordination-only gates consume no CPU or memory while executable siblings retain the full grant', () => {
  const allocations = resolveConcurrentStepCapacities([
    { id: 'build-ready', resources: { coordinationOnly: true } },
    { id: 'vitest', resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 1 } }
  ], { cpuUnits: 3, memoryGiB: 2 })

  assert.deepEqual(allocations, [
    { maxParallel: 0, cpuUnits: 0, memoryGiB: 0 },
    { maxParallel: 3, cpuUnits: 3, memoryGiB: 2 }
  ])
})

test('coordination-only admission remains valid after executable siblings consume the live grant', () => {
  assert.deepEqual(resolveConcurrentStepCapacities([
    { id: 'settled-join', resources: { coordinationOnly: true } }
  ], { cpuUnits: 0, memoryGiB: 0 }), [
    { maxParallel: 0, cpuUnits: 0, memoryGiB: 0 }
  ])
})

test('coordination-only gates can wait without reducing a running sibling grant', async () => {
  const gate = deferred()
  const started = []
  await executeWeightedStepDag([
    { id: 'build-ready', resources: { coordinationOnly: true } },
    { id: 'vitest', resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 1 } },
    {
      id: 'postbuild',
      dependsOn: ['build-ready'],
      resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    }
  ], { maxParallel: 3, cpuUnits: 3, memoryGiB: 2 }, async (entry) => {
    started.push({ id: entry.id, capacity: entry.runtimeCapacity })
    if (entry.id === 'build-ready') await gate.promise
    if (entry.id === 'vitest') gate.resolve()
  })

  assert.deepEqual(started.slice(0, 2), [
    { id: 'build-ready', capacity: { maxParallel: 0, cpuUnits: 0, memoryGiB: 0 } },
    { id: 'vitest', capacity: { maxParallel: 3, cpuUnits: 3, memoryGiB: 2 } }
  ])
  assert.equal(started[2].id, 'postbuild')
})

test('coordination-only marker waits do not consume a one-CPU admission slot', async () => {
  const backend = deferred()
  const frontend = deferred()
  const security = deferred()
  const started = []
  const execution = executeWeightedStepDag([
    { id: 'backend-build-ready', resources: { coordinationOnly: true } },
    { id: 'frontend-build-ready', resources: { coordinationOnly: true } },
    { id: 'security-static', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
  ], { maxParallel: 1, cpuUnits: 1, memoryGiB: 1 }, async (entry) => {
    started.push(entry.id)
    if (entry.id === 'backend-build-ready') await backend.promise
    if (entry.id === 'frontend-build-ready') await frontend.promise
    if (entry.id === 'security-static') await security.promise
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['backend-build-ready', 'frontend-build-ready', 'security-static'])
  backend.resolve()
  frontend.resolve()
  security.resolve()
  await execution
})

test('weighted DAG fills each dependency-ready wave from actual grants across machine sizes', async () => {
  for (const cpuUnits of [4, 8, 16]) {
    const capacity = { maxParallel: cpuUnits, cpuUnits, memoryGiB: cpuUnits * 1.5 }
    for (const steps of [runtimeSteps(), performanceSteps()]) {
      const executed = []
      await executeWeightedStepDag(steps, {
        ...capacity,
        exclusiveResources: ['runtime-services', 'load-window', 'database-writes', 'benchmark-window']
      }, async (step) => executed.push({ id: step.id, capacity: step.runtimeCapacity }))
      assert.equal(executed.length, steps.length)
      const coordinationIds = new Set(steps
        .filter((entry) => entry.resources.coordinationOnly)
        .map((entry) => entry.id))
      assert.ok(executed.every((entry) => entry.capacity.cpuUnits >= (coordinationIds.has(entry.id) ? 0 : 1)))
      assert.ok(executed.every((entry) => entry.capacity.memoryGiB >= (coordinationIds.has(entry.id) ? 0 : Number.EPSILON)))
    }
  }
})

test('runtime browser-heavy phases preserve their admitted serial order', async () => {
  const executed = []
  const capacity = {
    maxParallel: 5,
    cpuUnits: 5,
    memoryGiB: 5,
    exclusiveResources: ['runtime-services', 'load-window', 'database-writes', 'benchmark-window']
  }
  await executeWeightedStepDag(runtimeSteps(), capacity,
    async (entry) => executed.push({ id: entry.id, capacity: entry.runtimeCapacity }))

  const bootstrapIndex = executed.findIndex((entry) => entry.id === 'bootstrap')
  const staticIndex = executed.findIndex((entry) => entry.id === 'security-static')
  const uxIndex = executed.findIndex((entry) => entry.id === 'ux-risk-matrix')
  const securityIndex = executed.findIndex((entry) => entry.id === 'security-runtime-core')
  const runtimeIndex = executed.findIndex((entry) => entry.id === 'runtime-integration')
  assert.deepEqual(executed.slice(0, 3).map((entry) => entry.id), [
    'backend-build-ready', 'frontend-build-ready', 'security-static'
  ])
  assert.ok(bootstrapIndex > staticIndex)
  assert.ok(uxIndex > bootstrapIndex)
  assert.ok(securityIndex > bootstrapIndex)
  assert.ok(executed[uxIndex].capacity.cpuUnits >= 1)
  assert.ok(executed[securityIndex].capacity.cpuUnits >= 1)
  assert.ok(executed[runtimeIndex].capacity.cpuUnits >= 1)
  const crossStackIndex = executed.findIndex((entry) => entry.id === 'cross-stack-runtime')
  const renderIndex = executed.findIndex((entry) => entry.id === 'render-pressure')
  const resilienceIndex = executed.findIndex((entry) => entry.id === 'resilience')
  const crossBrowserIndex = executed.findIndex((entry) => entry.id === 'cross-browser')
  assert.ok(securityIndex < runtimeIndex)
  assert.ok(runtimeIndex < crossStackIndex)
  assert.ok(crossStackIndex < renderIndex)
  assert.ok(renderIndex < resilienceIndex)
  assert.ok(resilienceIndex < uxIndex)
  assert.ok(uxIndex < crossBrowserIndex)
})

test('two-CPU runtime grant gives the complete browser grant to each serial phase', async () => {
  const bootstrap = deferred()
  const hydration = deferred()
  const security = deferred()
  const integration = deferred()
  const started = []
  const index = byId(runtimeSteps())
  const selected = [
    { ...index.get('bootstrap'), dependsOn: [] },
    index.get('release-public-hydration'),
    index.get('security-runtime-core'),
    index.get('runtime-integration')
  ]
  const execution = executeWeightedStepDag(selected, {
    maxParallel: 2,
    cpuUnits: 2,
    memoryGiB: 5
  }, async (entry) => {
    started.push({ id: entry.id, capacity: entry.runtimeCapacity })
    if (entry.id === 'bootstrap') await bootstrap.promise
    if (entry.id === 'release-public-hydration') await hydration.promise
    if (entry.id === 'security-runtime-core') await security.promise
    if (entry.id === 'runtime-integration') await integration.promise
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.map((entry) => entry.id), ['bootstrap'])
  bootstrap.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.slice(1).map((entry) => entry.id), ['release-public-hydration'])
  assert.equal(started.at(-1).capacity.cpuUnits, 2)
  assert.equal(started.at(-1).capacity.memoryGiB, 5)
  hydration.resolve()
  await waitFor(() => started.some((entry) => entry.id === 'security-runtime-core'))
  assert.equal(started.some((entry) => entry.id === 'runtime-integration'), false)
  assert.equal(started.at(-1).capacity.cpuUnits, 2)
  security.resolve()
  await waitFor(() => started.some((entry) => entry.id === 'runtime-integration'))
  assert.equal(started.at(-1).capacity.cpuUnits, 2)
  integration.resolve()
  await execution
})

test('elastic 3/4/6 CPU grants immediately widen the independent post-hydration wave', async () => {
  const core = deferred()
  const ux = deferred()
  const dast = deferred()
  const integration = deferred()
  const release = deferred()
  const endpoint = deferred()
  const started = []
  let capacity = { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 }
  const index = byId(runtimeSteps())
  const selected = [
    { ...index.get('security-runtime-core'), dependsOn: [] },
    { ...index.get('ux-risk-matrix'), dependsOn: [] },
    { ...index.get('authenticated-dast'), dependsOn: [] },
    { ...index.get('runtime-integration'), dependsOn: [] },
    { ...index.get('release-public'), dependsOn: [] },
    { ...index.get('endpoint-depth'), dependsOn: [] }
  ]
  const execution = executeWeightedStepDag(selected, () => capacity, async (entry) => {
    started.push({ id: entry.id, capacity: entry.runtimeCapacity })
    if (entry.id === 'security-runtime-core') await core.promise
    if (entry.id === 'ux-risk-matrix') await ux.promise
    if (entry.id === 'authenticated-dast') await dast.promise
    if (entry.id === 'runtime-integration') await integration.promise
    if (entry.id === 'release-public') await release.promise
    if (entry.id === 'endpoint-depth') await endpoint.promise
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.map((entry) => entry.id), ['security-runtime-core', 'ux-risk-matrix'])
  assert.deepEqual(started.map((entry) => entry.capacity.cpuUnits), [1, 1])

  capacity = { maxParallel: 3, cpuUnits: 3, memoryGiB: 6 }
  await waitFor(() => started.some((entry) => entry.id === 'authenticated-dast'))
  assert.deepEqual(started.map((entry) => entry.id), [
    'security-runtime-core', 'ux-risk-matrix', 'authenticated-dast'
  ])

  capacity = { maxParallel: 4, cpuUnits: 4, memoryGiB: 8 }
  await waitFor(() => started.at(-1)?.id === 'runtime-integration')
  assert.equal(started.at(-1).id, 'runtime-integration')
  assert.equal(started.at(-1).capacity.cpuUnits, 1)
  assert.equal(started.some((entry) => entry.id === 'release-public'), false)

  capacity = { maxParallel: 6, cpuUnits: 6, memoryGiB: 12 }
  await waitFor(() => started.some((entry) => entry.id === 'endpoint-depth'))
  assert.deepEqual(started.map((entry) => entry.id), [
    'security-runtime-core',
    'ux-risk-matrix',
    'authenticated-dast',
    'runtime-integration',
    'release-public',
    'endpoint-depth'
  ])
  assert.deepEqual(started.slice(-2).map((entry) => entry.capacity.cpuUnits), [1, 1])

  dast.resolve()
  integration.resolve()
  release.resolve()
  endpoint.resolve()
  core.resolve()
  ux.resolve()
  await execution
})

test('t0 static security is followed by cross-stack and CSRF in the backend/frontend marker gap', async () => {
  const backend = deferred()
  const frontend = deferred()
  const staticSecurity = deferred()
  const crossStack = deferred()
  const csrf = deferred()
  const bootstrap = deferred()
  const started = []
  const index = byId(runtimeSteps())
  const selected = [
    index.get('backend-build-ready'),
    index.get('frontend-build-ready'),
    index.get('security-static'),
    index.get('bootstrap'),
    index.get('cross-stack'),
    index.get('csrf-matrix')
  ]
  const execution = executeWeightedStepDag(selected, {
    maxParallel: 1,
    cpuUnits: 1,
    memoryGiB: 3
  }, async (entry) => {
    started.push(entry.id)
    if (entry.id === 'backend-build-ready') await backend.promise
    if (entry.id === 'frontend-build-ready') await frontend.promise
    if (entry.id === 'security-static') await staticSecurity.promise
    if (entry.id === 'cross-stack') await crossStack.promise
    if (entry.id === 'csrf-matrix') await csrf.promise
    if (entry.id === 'bootstrap') await bootstrap.promise
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['backend-build-ready', 'frontend-build-ready', 'security-static'])
  staticSecurity.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.includes('cross-stack'), false)
  backend.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1), 'cross-stack')
  crossStack.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1), 'csrf-matrix')
  csrf.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.includes('bootstrap'), false)
  frontend.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1), 'bootstrap')
  bootstrap.resolve()
  await execution
})

test('failed-run timing model gives bootstrap hydration and browser phases the complete grant', async () => {
  const backend = deferred()
  const frontend = deferred()
  const staticSecurity = deferred()
  const crossStack = deferred()
  const csrf = deferred()
  const bootstrap = deferred()
  const hydration = deferred()
  const security = deferred()
  const integration = deferred()
  const started = []
  let capacity = { maxParallel: 1, cpuUnits: 1, memoryGiB: 3 }
  const index = byId(runtimeSteps())
  const selected = [
    index.get('backend-build-ready'),
    index.get('frontend-build-ready'),
    index.get('security-static'),
    index.get('cross-stack'),
    index.get('csrf-matrix'),
    index.get('bootstrap'),
    index.get('release-public-hydration'),
    index.get('security-runtime-core'),
    index.get('runtime-integration')
  ]
  const execution = executeWeightedStepDag(selected, () => capacity, async (entry) => {
    started.push({ id: entry.id, capacity: entry.runtimeCapacity })
    if (entry.id === 'backend-build-ready') await backend.promise
    if (entry.id === 'frontend-build-ready') await frontend.promise
    if (entry.id === 'security-static') await staticSecurity.promise
    if (entry.id === 'cross-stack') await crossStack.promise
    if (entry.id === 'csrf-matrix') await csrf.promise
    if (entry.id === 'bootstrap') await bootstrap.promise
    if (entry.id === 'release-public-hydration') await hydration.promise
    if (entry.id === 'security-runtime-core') await security.promise
    if (entry.id === 'runtime-integration') await integration.promise
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.map((entry) => entry.id), ['backend-build-ready', 'frontend-build-ready', 'security-static'])
  assert.equal(started.at(-1).capacity.cpuUnits, 1)
  staticSecurity.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.some((entry) => entry.id === 'cross-stack'), false)

  backend.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1).id, 'cross-stack')
  crossStack.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1).id, 'csrf-matrix')
  csrf.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.some((entry) => entry.id === 'bootstrap'), false)

  capacity = { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 }
  frontend.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  const bootstrapStart = started.find((entry) => entry.id === 'bootstrap')
  assert.deepEqual(bootstrapStart?.capacity, { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 })
  assert.equal(started.some((entry) => entry.id === 'release-public-hydration'), false)

  bootstrap.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1).id, 'release-public-hydration')
  assert.equal(started.at(-1).capacity.cpuUnits, 2)
  hydration.resolve()
  await waitFor(() => started.some((entry) => entry.id === 'security-runtime-core'))
  assert.equal(started.some((entry) => entry.id === 'runtime-integration'), false)
  security.resolve()
  await waitFor(() => started.some((entry) => entry.id === 'runtime-integration'))
  integration.resolve()
  await execution
})

test('security join preserves the static preflight through the post-hydration core wave', async () => {
  const bootstrap = deferred()
  const securityStatic = deferred()
  const hydration = deferred()
  const securityCore = deferred()
  const started = []
  const selected = runtimeSteps()
    .filter((entry) => ['bootstrap', 'security-static', 'release-public-hydration', 'security-runtime-core', 'security-join'].includes(entry.id))
    .map((entry) => {
      if (entry.id === 'bootstrap') return { ...entry, dependsOn: ['security-static'] }
      if (entry.id === 'security-join') return { ...entry, dependsOn: ['security-static', 'security-runtime-core'] }
      return entry
    })
  const execution = executeWeightedStepDag(selected, {
    maxParallel: 5,
    cpuUnits: 5,
    memoryGiB: 5
  }, async (entry) => {
    started.push({ id: entry.id, capacity: entry.runtimeCapacity })
    if (entry.id === 'bootstrap') await bootstrap.promise
    if (entry.id === 'security-static') await securityStatic.promise
    if (entry.id === 'release-public-hydration') await hydration.promise
    if (entry.id === 'security-runtime-core') await securityCore.promise
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.map((entry) => entry.id), ['security-static'])
  securityStatic.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1).id, 'bootstrap')
  bootstrap.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1).id, 'release-public-hydration')
  assert.ok(!started.some((entry) => entry.id === 'security-join'))
  hydration.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.at(-1).id, 'security-runtime-core')
  securityCore.resolve()
  await execution
  assert.equal(started.at(-1).id, 'security-join')
})

test('runtime tail runs isolated data scales together then overlaps summary with fault injection', async () => {
  const xs = deferred()
  const small = deferred()
  const summary = deferred()
  const fault = deferred()
  const started = []
  const index = byId(runtimeSteps())
  const selected = [
    { ...index.get('runtime-state-stable'), dependsOn: [] },
    index.get('data-scale-xs'),
    index.get('data-scale-s'),
    index.get('data-scale-summary'),
    index.get('fault-injection')
  ]
  const execution = executeWeightedStepDag(selected, {
    maxParallel: 4,
    cpuUnits: 4,
    memoryGiB: 4
  }, async (entry) => {
    started.push(entry.id)
    if (entry.id === 'data-scale-xs') await xs.promise
    if (entry.id === 'data-scale-s') await small.promise
    if (entry.id === 'data-scale-summary') await summary.promise
    if (entry.id === 'fault-injection') await fault.promise
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['runtime-state-stable', 'data-scale-xs', 'data-scale-s'])
  xs.resolve()
  small.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.slice(-2), ['data-scale-summary', 'fault-injection'])
  summary.resolve()
  fault.resolve()
  await execution
})

test('settled security join runs after independent phase failures and the DAG aggregates every cause', async () => {
  const first = new Error('security static failed')
  const second = new Error('security runtime failed')
  const started = []
  await assert.rejects(executeWeightedStepDag([
    { id: 'security-static', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
    { id: 'bootstrap', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
    {
      id: 'security-runtime-core',
      dependsOn: ['bootstrap'],
      resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    },
    {
      id: 'security-join',
      dependsOn: ['security-static', 'security-runtime-core'],
      runAfterSettled: true,
      resources: { coordinationOnly: true }
    }
  ], { maxParallel: 2, cpuUnits: 2, memoryGiB: 2 }, async (entry) => {
    started.push({ id: entry.id, outcomes: entry.dependencyOutcomes })
    if (entry.id === 'security-static') throw first
    if (entry.id === 'security-runtime-core') throw second
  }), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [first, second])
    return true
  })
  assert.deepEqual(started.at(-1), {
    id: 'security-join',
    outcomes: { 'security-static': 'failure', 'security-runtime-core': 'failure' }
  })
})

test('weighted DAG re-reads an elastic scheduler grant before admitting waiting work', async () => {
  let capacity = {
    maxParallel: 1,
    cpuUnits: 1,
    memoryGiB: 2,
    exclusiveResources: []
  }
  const executed = []
  const running = executeWeightedStepDag([
    { id: 'needs-expanded-grant', resources: { cpuWeight: 2, memoryWeight: 1, minCpuUnits: 2 } }
  ], () => capacity, async (entry) => executed.push(entry.runtimeCapacity))

  await new Promise((resolve) => setTimeout(resolve, 20))
  capacity = { ...capacity, maxParallel: 4, cpuUnits: 4, memoryGiB: 4 }
  await running
  assert.deepEqual(executed, [{ maxParallel: 4, cpuUnits: 4, memoryGiB: 4 }])
})

test('a fixed worker pool starts after its preflight with the complete then-current grant', async () => {
  let capacity = {
    maxParallel: 2,
    cpuUnits: 2,
    memoryGiB: 3,
    exclusiveResources: []
  }
  const executed = []
  await executeWeightedStepDag([
    { id: 'preflight', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
    {
      id: 'fixed-worker-pool',
      dependsOn: ['preflight'],
      resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 1 }
    }
  ], () => capacity, async (entry) => {
    executed.push({ id: entry.id, capacity: entry.runtimeCapacity })
    if (entry.id === 'preflight') {
      capacity = { ...capacity, maxParallel: 5, cpuUnits: 5, memoryGiB: 6 }
    }
  })

  assert.deepEqual(executed, [
    { id: 'preflight', capacity: { maxParallel: 2, cpuUnits: 2, memoryGiB: 3 } },
    { id: 'fixed-worker-pool', capacity: { maxParallel: 5, cpuUnits: 5, memoryGiB: 6 } }
  ])
})

test('weighted DAG rolls freed grants into newly-ready work without a whole-wave barrier', async () => {
  const events = []
  let releaseLong
  let releaseShort
  const long = new Promise((resolve) => { releaseLong = resolve })
  const short = new Promise((resolve) => { releaseShort = resolve })
  let activeCpu = 0
  let activeMemory = 0

  const running = executeWeightedStepDag([
    { id: 'long', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
    { id: 'short', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
    { id: 'after-short', dependsOn: ['short'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
  ], { maxParallel: 2, cpuUnits: 4, memoryGiB: 8 }, async (entry) => {
    activeCpu += entry.runtimeCapacity.cpuUnits
    activeMemory += entry.runtimeCapacity.memoryGiB
    assert.ok(activeCpu <= 4)
    assert.ok(activeMemory <= 8)
    events.push(`${entry.id}:start`)
    if (entry.id === 'long') await long
    if (entry.id === 'short') await short
    events.push(`${entry.id}:end`)
    activeCpu -= entry.runtimeCapacity.cpuUnits
    activeMemory -= entry.runtimeCapacity.memoryGiB
  })

  await new Promise((resolve) => setImmediate(resolve))
  releaseShort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(events.includes('after-short:start'))
  assert.equal(events.includes('long:end'), false)
  releaseLong()
  await running
  assert.ok(events.indexOf('after-short:start') < events.indexOf('long:end'))
})

test('a ready exclusive step does not hide later ordinary work while active work drains', async () => {
  const events = []
  let releaseLong
  let releaseShort
  let releaseTrailing
  const long = new Promise((resolve) => { releaseLong = resolve })
  const short = new Promise((resolve) => { releaseShort = resolve })
  const trailing = new Promise((resolve) => { releaseTrailing = resolve })

  const running = executeWeightedStepDag([
    { id: 'long', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
    { id: 'short', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
    {
      id: 'exclusive',
      dependsOn: ['short'],
      resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['window'] }
    },
    { id: 'trailing', dependsOn: ['short'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
  ], { maxParallel: 2, cpuUnits: 2, memoryGiB: 4, exclusiveResources: ['window'] }, async (entry) => {
    events.push(`${entry.id}:start`)
    if (entry.id === 'long') await long
    if (entry.id === 'short') await short
    if (entry.id === 'trailing') await trailing
    events.push(`${entry.id}:end`)
  })

  await new Promise((resolve) => setImmediate(resolve))
  releaseShort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(events.includes('trailing:start'), 'ordinary work after the exclusive declaration must fill the released CPU')
  assert.equal(events.includes('exclusive:start'), false)
  releaseTrailing()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events.includes('exclusive:start'), false, 'exclusive work must not overlap the active long step')
  releaseLong()
  await running
  assert.ok(events.indexOf('trailing:start') < events.indexOf('long:end'))
  assert.ok(events.indexOf('exclusive:start') > events.indexOf('long:end'))
  assert.ok(events.indexOf('exclusive:start') > events.indexOf('trailing:end'))
  assert.ok(events.includes('exclusive:end'), 'the exclusive step must not starve')
})

test('machine execution deadlines derive pressure from workload weights and actual grants', () => {
  const workload = { cpuWeight: 5, memoryWeight: 5, minCpuUnits: 1 }
  assert.equal(resolveMachineExecutionTimeoutMs({
    baseTimeoutMs: 100_000,
    workload,
    actualCapacity: { cpuUnits: 5, memoryGiB: 5 }
  }), 100_000)
  assert.equal(resolveMachineExecutionTimeoutMs({
    baseTimeoutMs: 100_000,
    workload,
    actualCapacity: { cpuUnits: 10, memoryGiB: 10 }
  }), 100_000)
  assert.equal(resolveMachineExecutionTimeoutMs({
    baseTimeoutMs: 100_000,
    workload,
    actualCapacity: { cpuUnits: 2.5, memoryGiB: 10 }
  }), 200_000)
  assert.equal(resolveMachineExecutionTimeoutMs({
    baseTimeoutMs: 100_000,
    workload,
    actualCapacity: { cpuUnits: 10, memoryGiB: 2.5 }
  }), 200_000)
})

test('machine-specific absolute step declarations fail closed', () => {
  for (const resources of [
    { cpuUnits: 2, memoryWeight: 1 },
    { cpuWeight: 1, memoryGiB: 2 }
  ]) {
    assert.throws(
      () => resolveBundleSteps('any', [{ id: 'invalid', resources }], { cpuUnits: 8, memoryGiB: 12 }),
      /machine-specific; declare weights instead/u
    )
  }
})

test('weighted DAG exposes independent failures together and blocks descendants', async () => {
  const ran = []
  await assert.rejects(
    executeWeightedStepDag([
      { id: 'a', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
      { id: 'b', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
      { id: 'blocked', dependsOn: ['a'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
    ], { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 }, async (step) => {
      ran.push(step.id)
      if (step.id !== 'blocked') throw new Error(step.id)
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2
  )
  assert.deepEqual(ran.sort(), ['a', 'b'])
})

test('weighted DAG propagates a failed dependency through reverse-ordered descendants', async () => {
  const ran = []
  await assert.rejects(
    executeWeightedStepDag([
      { id: 'tail', dependsOn: ['middle'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
      { id: 'middle', dependsOn: ['root'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
      { id: 'root', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
    ], { maxParallel: 1, cpuUnits: 1, memoryGiB: 1 }, async (step) => {
      ran.push(step.id)
      throw new Error('root failed')
    }),
    /root failed/u
  )
  assert.deepEqual(ran, ['root'])
})
