import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const schedulerFile = path.join(root, 'tools/test-matrix/scheduler.mjs')

async function loadScheduler() {
  try {
    return await import(`${pathToFileURL(schedulerFile).href}?test=${Date.now()}-${Math.random()}`)
  } catch {
    return {}
  }
}

function createTempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`))
}

function createRunnerFixture(temp) {
  const toolsDirectory = path.join(temp, 'tools')
  const schedulerDirectory = path.join(toolsDirectory, 'test-matrix')
  fs.mkdirSync(schedulerDirectory, { recursive: true })
  fs.copyFileSync(path.join(root, 'tools/run-test-matrix.mjs'), path.join(toolsDirectory, 'run-test-matrix.mjs'))
  for (const file of ['scheduler.mjs', 'local-profile.mjs', 'parse-matrix.mjs', 'fresh-production.mjs', 'local-runtime-cleanup.mjs']) {
    fs.copyFileSync(path.join(root, 'tools/test-matrix', file), path.join(schedulerDirectory, file))
  }
  return path.join(toolsDirectory, 'run-test-matrix.mjs')
}

function tier(id, overrides = {}) {
  return {
    id,
    command: `${process.execPath} -e "process.exit(0)"`,
    dependsOn: [],
    services: [],
    parallelizable: true,
    exclusiveResources: [],
    phase: 0,
    resourceClass: 'cpu',
    maxParallel: 8,
    cpuUnits: 1,
    memoryGiB: 0.1,
    cacheInputs: [],
    executionKey: `test/${id}`,
    executionVariant: 'ordinary',
    coverage: ['ordinary-unit'],
    ...overrides
  }
}

const stableSnapshot = async () => ({ fingerprint: 'stable', entries: {} })

test('runDag executes independent tiers concurrently before their dependent tier', async () => {
  const { runDag } = await loadScheduler()
  assert.equal(typeof runDag, 'function')

  const temp = createTempDir('scheduler-dag')
  const events = []
  let active = 0
  let maxActive = 0
  const result = await runDag({
    tiers: [
      tier('left'),
      tier('right'),
      tier('join', { dependsOn: ['left', 'right'] })
    ],
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'dag',
    maxParallel: 3,
    systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
    snapshotWorktree: stableSnapshot,
    executeTier: async (current, context) => {
      events.push(`start:${current.id}`)
      active += 1
      maxActive = Math.max(maxActive, active)
      context.writeOutput(`${current.id}\n`)
      await delay(current.id === 'join' ? 1 : 25)
      active -= 1
      events.push(`end:${current.id}`)
      return { code: 0, signal: null }
    }
  })

  assert.equal(result.status, 'success')
  assert.equal(maxActive, 2)
  assert.ok(events.indexOf('start:join') > events.indexOf('end:left'))
  assert.ok(events.indexOf('start:join') > events.indexOf('end:right'))
  assert.ok(fs.existsSync(path.join(temp, 'runs/dag/tiers/left.log')))
  const checkpoint = JSON.parse(fs.readFileSync(path.join(temp, 'runs/dag/checkpoint.json'), 'utf8'))
  assert.deepEqual(checkpoint.completedTiers.sort(), ['join', 'left', 'right'])
  assert.equal(typeof checkpoint.tiers.join.inputFingerprint, 'string')
  assert.equal(typeof checkpoint.tiers.join.dependencyFingerprint, 'string')
  assert.equal(typeof checkpoint.tiers.join.durationMs, 'number')
  assert.equal(checkpoint.sourceState.worktreeFingerprint, 'stable')
  assert.ok(Object.hasOwn(checkpoint.sourceState, 'commit'))
})

test('runDag honors exclusive resources, load-adjusted CPU, memory, and maxParallel limits', async () => {
  const { runDag } = await loadScheduler()
  assert.equal(typeof runDag, 'function')

  const temp = createTempDir('scheduler-resources')
  const active = new Set()
  let maxActive = 0
  let sharedOverlap = false
  const result = await runDag({
    tiers: [
      tier('first', { exclusiveResources: ['database'], cpuUnits: 2, memoryGiB: 3 }),
      tier('second', { exclusiveResources: ['database'], cpuUnits: 2, memoryGiB: 3 }),
      tier('third', { cpuUnits: 2, memoryGiB: 3 })
    ],
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'resources',
    maxParallel: 2,
    systemResources: { cpuCount: 4, availableMemoryGiB: 4, load1: 2 },
    snapshotWorktree: stableSnapshot,
    executeTier: async (current) => {
      if (current.exclusiveResources.includes('database') && [...active].some((item) => item.exclusiveResources.includes('database'))) {
        sharedOverlap = true
      }
      active.add(current)
      maxActive = Math.max(maxActive, active.size)
      await delay(20)
      active.delete(current)
      return { code: 0, signal: null }
    }
  })

  assert.equal(result.status, 'success')
  assert.equal(sharedOverlap, false)
  assert.equal(maxActive, 1, 'load-adjusted CPU and available memory should serialize these tiers')
})

test('runDag stops the whole POSIX process group on the first tier failure', { skip: process.platform === 'win32' }, async () => {
  const { runDag } = await loadScheduler()
  assert.equal(typeof runDag, 'function')

  const temp = createTempDir('scheduler-stop')
  const pidFile = path.join(temp, 'grandchild.pid')
  const grandchildFile = path.join(temp, 'grandchild.mjs')
  const slowFile = path.join(temp, 'slow.mjs')
  const failFile = path.join(temp, 'fail.mjs')
  fs.writeFileSync(grandchildFile, 'setInterval(() => {}, 1000)\n')
  fs.writeFileSync(slowFile, [
    "import { spawn } from 'node:child_process'",
    "import fs from 'node:fs'",
    `const child = spawn(process.execPath, [${JSON.stringify(grandchildFile)}], { stdio: 'ignore' })`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
    'setInterval(() => {}, 1000)'
  ].join('\n'))
  fs.writeFileSync(failFile, 'setTimeout(() => process.exit(7), 180)\n')

  const result = await runDag({
    tiers: [
      tier('slow', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slowFile)}` }),
      tier('fail', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(failFile)}` })
    ],
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'stop',
    maxParallel: 2,
    systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
    snapshotWorktree: stableSnapshot,
    terminationGraceMs: 100
  })

  assert.equal(result.status, 'failure')
  assert.equal(result.failure.tierId, 'fail')
  assert.equal(result.failure.exitCode, 7)
  assert.ok(fs.existsSync(pidFile), 'the slow tier should have started its grandchild')
  const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'))
  let alive = true
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try {
      process.kill(grandchildPid, 0)
      await delay(25)
    } catch (error) {
      if (error.code === 'ESRCH') alive = false
      else throw error
    }
  }
  assert.equal(alive, false, `grandchild ${grandchildPid} survived sibling failure`)
})

test('runDag enforces a wall-clock deadline and records the timed-out tier', { skip: process.platform === 'win32' }, async () => {
  const { runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-deadline')
  const slowFile = path.join(temp, 'slow.mjs')
  fs.writeFileSync(slowFile, 'setInterval(() => {}, 1000)\n')

  const result = await runDag({
    tiers: [tier('slow', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slowFile)}` })],
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'deadline',
    maxParallel: 1,
    wallClockBudgetMs: 150,
    terminationGraceMs: 50,
    systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
    snapshotWorktree: stableSnapshot
  })

  assert.equal(result.status, 'failure')
  assert.equal(result.failure.tierId, 'slow')
  assert.equal(result.failure.reason, 'wall-clock budget exceeded (150ms)')
  assert.equal(result.checkpoint.budgetMs, 150)
  assert.equal(result.checkpoint.timedOut, true)
  assert.deepEqual(result.checkpoint.criticalPath.tierIds, ['slow'])
  assert.ok(result.checkpoint.resourcePeaks.usedMemoryGiB > 0)
  assert.ok(Array.isArray(result.checkpoint.ungeneratedEvidence))
})

test('runDag enforces an individual physical bundle budget', { skip: process.platform === 'win32' }, async () => {
  const { runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-bundle-deadline')
  const slowFile = path.join(temp, 'slow.mjs')
  fs.writeFileSync(slowFile, 'setInterval(() => {}, 1000)\n')

  const result = await runDag({
    tiers: [tier('bundle', {
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slowFile)}`,
      budgetMs: 120
    })],
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'bundle-deadline',
    maxParallel: 1,
    terminationGraceMs: 50,
    systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
    snapshotWorktree: stableSnapshot
  })

  assert.equal(result.status, 'failure')
  assert.equal(result.failure.exitCode, 124)
  assert.equal(result.failure.reason, 'bundle budget exceeded (120ms)')
})

test('resume reuses successful tiers only while input and dependency fingerprints match', async () => {
  const { runDag } = await loadScheduler()
  assert.equal(typeof runDag, 'function')

  const temp = createTempDir('scheduler-resume')
  const inputFile = path.join(temp, 'input.txt')
  fs.writeFileSync(inputFile, 'v1\n')
  const tiers = [
    tier('compile', { cacheInputs: ['input.txt'] }),
    tier('verify', { dependsOn: ['compile'] })
  ]
  const runsRoot = path.join(temp, 'runs')
  const executed = []
  const executeTier = async (current) => {
    executed.push(current.id)
    return { code: 0, signal: null }
  }

  await runDag({ tiers, root: temp, runsRoot, runId: 'resume', maxParallel: 2, snapshotWorktree: stableSnapshot, executeTier })
  assert.deepEqual(executed, ['compile', 'verify'])

  executed.length = 0
  const resumed = await runDag({ tiers, root: temp, runsRoot, runId: 'resume', resume: true, maxParallel: 2, snapshotWorktree: stableSnapshot, executeTier })
  assert.equal(resumed.status, 'success')
  assert.deepEqual(executed, [])
  assert.deepEqual(resumed.reusedTiers.sort(), ['compile', 'verify'])

  fs.writeFileSync(inputFile, 'v2\n')
  executed.length = 0
  const invalidated = await runDag({ tiers, root: temp, runsRoot, runId: 'resume', resume: true, maxParallel: 2, snapshotWorktree: stableSnapshot, executeTier })
  assert.equal(invalidated.status, 'success')
  assert.deepEqual(executed, ['compile', 'verify'])
  assert.deepEqual(invalidated.reusedTiers, [])
})

test('resume reruns tiers when declared artifacts disappear and never reuses service bootstraps', async () => {
  const { runDag } = await loadScheduler()
  assert.equal(typeof runDag, 'function')

  const temp = createTempDir('scheduler-resume-outputs')
  const runsRoot = path.join(temp, 'runs')
  const artifactFile = path.join(temp, 'artifact.txt')
  const executed = []
  const tiers = [
    tier('artifact', { artifacts: ['artifact.txt'] }),
    tier('service-bootstrap', {
      dependsOn: ['artifact'],
      services: ['postgres'],
      artifacts: ['service-ready.txt']
    })
  ]
  const executeTier = async (current) => {
    executed.push(current.id)
    if (current.id === 'artifact') fs.writeFileSync(artifactFile, 'ready\n')
    if (current.id === 'service-bootstrap') fs.writeFileSync(path.join(temp, 'service-ready.txt'), 'ready\n')
    return { code: 0, signal: null }
  }

  await runDag({ tiers, root: temp, runsRoot, runId: 'outputs', mode: 'fresh', snapshotWorktree: stableSnapshot, executeTier })
  assert.deepEqual(executed, ['artifact', 'service-bootstrap'])

  executed.length = 0
  const resumed = await runDag({ tiers, root: temp, runsRoot, runId: 'outputs', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier })
  assert.deepEqual(resumed.reusedTiers, ['artifact'])
  assert.deepEqual(executed, ['service-bootstrap'])

  fs.rmSync(artifactFile)
  executed.length = 0
  const invalidated = await runDag({ tiers, root: temp, runsRoot, runId: 'outputs', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier })
  assert.deepEqual(invalidated.reusedTiers, [])
  assert.deepEqual(executed, ['artifact', 'service-bootstrap'])
})

test('a successful command fails closed when required direct or wildcard artifact paths are missing', async () => {
  const { runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-missing-output')
  const result = await runDag({
    tiers: [tier('missing-output', { artifacts: ['required.json'], evidence: ['optional/**/*.png'] })],
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'missing-output',
    mode: 'fresh',
    snapshotWorktree: stableSnapshot,
    executeTier: async () => ({ code: 0, signal: null })
  })
  assert.equal(result.status, 'failure')
  assert.match(result.failure.reason, /required\.json \(missing\)/u)
  assert.match(result.failure.reason, /optional\/\*\*\/\*\.png \(missing-wildcard\)/u)
})

test('fresh execution cannot pass by inheriting a stale pre-existing generated artifact', async () => {
  const { runDag } = await loadScheduler()
  const repo = createTempDir('scheduler-stale-output')
  const staleFile = path.join(repo, '.tmp/required.json')
  fs.mkdirSync(path.dirname(staleFile), { recursive: true })
  fs.writeFileSync(staleFile, '{"stale":true}\n')
  const result = await runDag({
    tiers: [tier('stale-output', {
      artifacts: ['.tmp/required.json'],
      evidence: ['.tmp/required.json']
    })],
    root: repo,
    runsRoot: path.join(repo, '.tmp/runs'),
    runId: 'stale-output',
    mode: 'fresh',
    snapshotWorktree: stableSnapshot,
    executeTier: async () => ({ code: 0, signal: null })
  })

  assert.equal(result.status, 'failure')
  assert.match(result.failure.reason, /required artifact\/evidence missing|did not produce or update/u)
})

test('fresh execution removes stale siblings from an owned generated directory', async () => {
  const { runDag } = await loadScheduler()
  const repo = createTempDir('scheduler-stale-directory')
  const outputDirectory = path.join(repo, '.tmp/evidence')
  fs.mkdirSync(outputDirectory, { recursive: true })
  const staleFile = path.join(outputDirectory, 'stale-authority.json')
  fs.writeFileSync(staleFile, '{"stale":true}\n')
  const result = await runDag({
    tiers: [tier('directory-producer', {
      artifacts: ['.tmp/evidence'],
      evidence: ['.tmp/evidence']
    })],
    root: repo,
    runsRoot: path.join(repo, '.tmp/runs'),
    runId: 'directory-producer',
    mode: 'fresh',
    snapshotWorktree: stableSnapshot,
    executeTier: async () => {
      fs.mkdirSync(outputDirectory, { recursive: true })
      fs.writeFileSync(path.join(outputDirectory, 'current.json'), '{"current":true}\n')
      return { code: 0, signal: null }
    }
  })

  assert.equal(result.status, 'success')
  assert.equal(fs.existsSync(staleFile), false)
})

test('derived cache inputs invalidate only the affected backend or frontend tier', async () => {
  const { runDag } = await loadScheduler()
  const repo = createTempDir('scheduler-fallback-inputs')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo })
  fs.mkdirSync(path.join(repo, 'src/backend'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'src/frontend/src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src/backend/source.cs'), 'backend-v1\n')
  fs.writeFileSync(path.join(repo, 'src/frontend/src/source.ts'), 'frontend-v1\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
  const runsRoot = createTempDir('scheduler-fallback-runs')
  const current = tier('fallback-inputs', {
    owner: 'ServerContractAgent',
    requiresDotnet: true,
    requiresNode: false
  })
  delete current.cacheInputs
  const executed = []
  const executeTier = async () => {
    executed.push('run')
    return { code: 0, signal: null }
  }
  await runDag({ tiers: [current], root: repo, runsRoot, runId: 'fallback', mode: 'fresh', snapshotWorktree: stableSnapshot, executeTier })
  await runDag({ tiers: [current], root: repo, runsRoot, runId: 'fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier })
  assert.deepEqual(executed, ['run'])
  fs.writeFileSync(path.join(repo, 'src/frontend/src/source.ts'), 'frontend-v2\n')
  await runDag({ tiers: [current], root: repo, runsRoot, runId: 'fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier })
  assert.deepEqual(executed, ['run'])
  fs.writeFileSync(path.join(repo, 'src/backend/source.cs'), 'backend-v2\n')
  await runDag({ tiers: [current], root: repo, runsRoot, runId: 'fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier })
  assert.deepEqual(executed, ['run', 'run'])

  const frontend = tier('frontend-derived-inputs', {
    owner: 'InteropGlueAgent',
    requiresDotnet: false,
    requiresNode: true
  })
  delete frontend.cacheInputs
  const frontendExecutions = []
  const executeFrontend = async () => { frontendExecutions.push('run'); return { code: 0, signal: null } }
  await runDag({ tiers: [frontend], root: repo, runsRoot, runId: 'frontend-fallback', mode: 'fresh', snapshotWorktree: stableSnapshot, executeTier: executeFrontend })
  fs.writeFileSync(path.join(repo, 'src/backend/source.cs'), 'backend-v3\n')
  await runDag({ tiers: [frontend], root: repo, runsRoot, runId: 'frontend-fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier: executeFrontend })
  assert.deepEqual(frontendExecutions, ['run'])
  fs.writeFileSync(path.join(repo, 'src/frontend/src/source.ts'), 'frontend-v3\n')
  await runDag({ tiers: [frontend], root: repo, runsRoot, runId: 'frontend-fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier: executeFrontend })
  assert.deepEqual(frontendExecutions, ['run', 'run'])
})

test('runDag and latest-run discovery reject concurrent writers for one run id', async () => {
  const { findLatestRunId, runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-run-lock')
  const runsRoot = path.join(temp, 'runs')
  let release
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const releasePromise = new Promise((resolve) => { release = resolve })
  const first = runDag({
    tiers: [tier('slow')],
    root: temp,
    runsRoot,
    runId: 'shared',
    mode: 'fresh',
    snapshotWorktree: stableSnapshot,
    executeTier: async () => {
      started()
      await releasePromise
      return { code: 0, signal: null }
    }
  })
  await startedPromise
  assert.throws(() => findLatestRunId(runsRoot), /already active/i)
  await assert.rejects(runDag({
    tiers: [tier('slow')],
    root: temp,
    runsRoot,
    runId: 'shared',
    mode: 'resume',
    snapshotWorktree: stableSnapshot,
    executeTier: async () => ({ code: 0, signal: null })
  }), /already active/i)
  release()
  assert.equal((await first).status, 'success')
  assert.equal(findLatestRunId(runsRoot), 'shared')
})

test('stale running checkpoints are resumable when their lock owner is dead', async () => {
  const { findLatestRunId, runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-stale-running')
  const runsRoot = path.join(temp, 'runs')
  const runDirectory = path.join(runsRoot, 'stale')
  const lockDirectory = path.join(runsRoot, '.locks/stale.lock')
  fs.mkdirSync(runDirectory, { recursive: true })
  fs.mkdirSync(lockDirectory, { recursive: true })
  fs.writeFileSync(path.join(runDirectory, 'checkpoint.json'), `${JSON.stringify({
    schema: 'fsusblog.test-matrix.checkpoint.v1',
    runId: 'stale',
    targetTierId: 'fixture',
    status: 'running',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    tiers: {}
  })}\n`)
  fs.writeFileSync(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({ pid: 2_147_483_647, token: 'dead' })}\n`)
  assert.equal(findLatestRunId(runsRoot, 'fixture'), 'stale')
  let executions = 0
  const result = await runDag({
    tiers: [tier('fixture')],
    root: temp,
    runsRoot,
    runId: 'stale',
    targetTierId: 'fixture',
    mode: 'resume',
    resume: true,
    snapshotWorktree: stableSnapshot,
    executeTier: async () => {
      executions += 1
      return { code: 0, signal: null }
    }
  })
  assert.equal(result.status, 'success')
  assert.equal(executions, 1)
})

test('resource-class defaults reserve meaningful CPU and memory when tiers omit explicit units', async () => {
  const { runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-resource-defaults')
  let active = 0
  let maxActive = 0
  const browserTier = (id) => {
    const current = tier(id, { resourceClass: 'browser' })
    delete current.cpuUnits
    delete current.memoryGiB
    return current
  }
  const result = await runDag({
    tiers: [browserTier('browser-a'), browserTier('browser-b')],
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'defaults',
    mode: 'fresh',
    maxParallel: 2,
    systemResources: { cpuCount: 8, availableMemoryGiB: 6, load1: 0 },
    snapshotWorktree: stableSnapshot,
    executeTier: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(20)
      active -= 1
      return { code: 0, signal: null }
    }
  })
  assert.equal(result.status, 'success')
  assert.equal(maxActive, 1, 'two default browser tiers must not both fit into a 6 GiB budget')
})

test('supersedes rewires ordinary unit coverage subsets and rejects protected test kinds', async () => {
  const { applySupersedes, validateSupersedesRules } = await loadScheduler()
  assert.equal(typeof applySupersedes, 'function')
  assert.equal(typeof validateSupersedesRules, 'function')

  const ordinary = [
    tier('unit-slow', { executionKey: 'unit/shared', coverage: ['ordinary-unit'] }),
    tier('unit-fast', {
      executionKey: 'unit/shared',
      executionVariant: 'coverage',
      coverage: ['ordinary-unit', 'ordinary-unit-extra'],
      supersedes: ['unit-slow']
    }),
    tier('summary', { dependsOn: ['unit-slow'], coverage: [] })
  ]
  const registry = new Map([
    ['ordinary-unit', { assertionType: 'unit' }],
    ['ordinary-unit-extra', { assertionType: 'unit' }]
  ])
  assert.deepEqual(validateSupersedesRules(ordinary, registry), [])
  const selected = applySupersedes(ordinary)
  assert.deepEqual(selected.map((item) => item.id).sort(), ['summary', 'unit-fast'])
  assert.deepEqual(selected.find((item) => item.id === 'summary').dependsOn, ['unit-fast'])

  for (const kind of ['property', 'model', 'perf', 'runtime']) {
    const protectedTiers = [
      tier(`${kind}-suite`, { executionKey: `protected/${kind}`, coverage: [`${kind}-coverage`] }),
      tier(`${kind}-replacement`, {
        executionKey: `protected/${kind}`,
        executionVariant: 'coverage',
        coverage: [`${kind}-coverage`],
        supersedes: [`${kind}-suite`]
      })
    ]
    const errors = validateSupersedesRules(
      protectedTiers,
      new Map([[`${kind}-coverage`, { assertionType: kind === 'perf' || kind === 'runtime' ? kind : 'unit' }]])
    )
    assert.ok(errors.some((message) => message.includes('must not supersede')), `${kind} supersedes should be rejected`)
  }
})

test('worktree pollution fails a tier while an unchanged pre-existing dirty tree is allowed', async () => {
  const { runDag } = await loadScheduler()
  assert.equal(typeof runDag, 'function')

  const repo = createTempDir('scheduler-pollution')
  const runsRoot = createTempDir('scheduler-pollution-runs')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'already dirty\n')

  const cleanResult = await runDag({
    tiers: [tier('clean')],
    root: repo,
    runsRoot,
    runId: 'preexisting-dirty',
    maxParallel: 1
  })
  assert.equal(cleanResult.status, 'success')

  const pollutingFile = path.join(repo, 'polluting.mjs')
  const generatedFile = path.join(repo, 'generated.txt')
  fs.writeFileSync(pollutingFile, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(generatedFile)}, 'generated\\n')\n`)
  execFileSync('git', ['add', 'polluting.mjs'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'add polluter'], { cwd: repo })
  const pollutedResult = await runDag({
    tiers: [tier('polluter', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(pollutingFile)}` })],
    root: repo,
    runsRoot,
    runId: 'polluted',
    maxParallel: 1
  })
  assert.equal(pollutedResult.status, 'failure')
  assert.equal(pollutedResult.failure.tierId, 'polluter')
  assert.match(pollutedResult.failure.reason, /working tree pollution/i)
  assert.ok(pollutedResult.failure.changedPaths.includes('generated.txt'))
})

test('matrix schema exposes scheduler resource, fingerprint, and supersedes metadata', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'tests/matrix.schema.json'), 'utf8'))
  const properties = schema.properties.tiers.items.properties
  assert.equal(properties.cpuUnits.minimum, 0.1)
  assert.equal(properties.memoryGiB.minimum, 0)
  assert.equal(properties.executionKey.type, 'string')
  assert.deepEqual(properties.executionVariant.enum, ['ordinary', 'coverage', 'property', 'model', 'performance', 'runtime'])
  assert.equal(properties.supersedes.type, 'array')
  assert.equal(properties.cacheInputs.type, 'array')
})

test('effective cache inputs include shared lane, Vitest, and setup consumers', async () => {
  const { effectiveCacheInputs } = await loadScheduler()
  const backendInputs = effectiveCacheInputs(tier('backend-explicit', {
    command: 'tools/test/lanes/backend-unit.sh',
    cacheInputs: ['tools/test/lanes/backend-unit.sh']
  }))
  assert.ok(backendInputs.includes('tools/test/lanes/_legacy.sh'))
  assert.ok(backendInputs.includes('tools/test/legacy-test.sh'))
  assert.ok(backendInputs.includes('tools/test/run-once.mjs'))

  const frontendInputs = effectiveCacheInputs(tier('frontend-unit-shard', {
    command: 'tools/test/lanes/frontend-unit-shard.sh',
    cacheInputs: ['tools/test/lanes/frontend-unit-shard.sh']
  }))
  assert.ok(frontendInputs.includes('src/frontend/tests'))
  assert.ok(frontendInputs.includes('src/frontend/vitest*.config.ts'))
  assert.ok(frontendInputs.includes('src/frontend/vitest.shared.mjs'))
})

test('coverage registry tierIds fail closed on stale or non-covering tiers', () => {
  const temp = createTempDir('coverage-registry-tier-ids')
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'))
  registry.entries[0].tierIds = ['removed-tier']
  const registryFile = path.join(temp, 'coverage-registry.json')
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`)
  const result = spawnSync(process.execPath, [path.join(root, 'tools/run-test-matrix.mjs'), 'validate'], {
    cwd: root,
    env: { ...process.env, FSUSBLOG_COVERAGE_REGISTRY_FILE: registryFile },
    encoding: 'utf8'
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /tierIds references unknown tier: removed-tier/u)
  assert.match(result.stderr, /tierIds must exactly match matrix covering tiers/u)
})

test('runner accepts fresh, resume, and max-parallel flags while CI always executes fresh', () => {
  const temp = createTempDir('scheduler-cli')
  const runner = createRunnerFixture(temp)
  const script = path.join(temp, 'append.mjs')
  const marker = path.join(temp, 'marker.txt')
  const matrix = path.join(temp, 'matrix.yml')
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, 'x')\n`)
  fs.writeFileSync(matrix, [
    'version: fsusblog-test-matrix-v2',
    'tiers:',
    '  - id: fixture',
    `    command: ${JSON.stringify(`${process.execPath} ${script}`)}`,
    '    dependsOn: []',
    '    services: []',
    '    parallelizable: true',
    '    exclusiveResources: []',
    '    resourceClass: cpu',
    '    maxParallel: 2',
    '    cpuUnits: 1',
    '    memoryGiB: 0.1',
    '    cacheInputs: []',
    '    executionKey: fixture',
    '    requiresPlaywright: none',
    '    artifacts: []',
    '    evidence: []',
    '    ciJob: fixture'
  ].join('\n'))

  const baseEnv = {
    ...process.env,
    FSUSBLOG_MATRIX_FILE: matrix,
    FSUSBLOG_TEST_RUN_ID: `scheduler-cli-${process.pid}`
  }
  const fresh = spawnSync(process.execPath, [runner, 'run', 'fixture', '--fresh', '--max-parallel', '1'], {
    cwd: temp,
    env: baseEnv,
    encoding: 'utf8'
  })
  assert.equal(fresh.status, 0, fresh.stderr)
  const ciResume = spawnSync(process.execPath, [runner, 'run', 'fixture', '--resume', '--max-parallel=1'], {
    cwd: temp,
    env: { ...baseEnv, CI: 'true' },
    encoding: 'utf8'
  })
  assert.equal(ciResume.status, 0, ciResume.stderr)
  assert.match(ciResume.stderr, /CI.*fresh/i)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'xx')
})

test('viewport CLI resume reaches Playwright progress while fresh clears ambient resume state', () => {
  const temp = createTempDir('scheduler-viewport-resume')
  const runner = createRunnerFixture(temp)
  const history = path.join(temp, 'resume-env.txt')
  const artifact = path.join(temp, 'viewport-output.json')
  const script = path.join(temp, 'viewport.mjs')
  const matrix = path.join(temp, 'matrix.yml')
  fs.writeFileSync(script, [
    "import fs from 'node:fs'",
    `fs.appendFileSync(${JSON.stringify(history)}, (process.env.FSUSBLOG_UX_VIEWPORT_RESUME ?? 'unset') + '\\n')`,
    `fs.writeFileSync(${JSON.stringify(artifact)}, '{}\\n')`
  ].join('\n'))
  fs.writeFileSync(matrix, [
    'version: fsusblog-test-matrix-v2',
    'tiers:',
    '  - id: ux-viewport-smoke',
    `    command: ${JSON.stringify(`${process.execPath} ${script}`)}`,
    '    dependsOn: []',
    '    services: []',
    '    parallelizable: true',
    '    exclusiveResources: []',
    '    resourceClass: browser',
    '    maxParallel: 1',
    '    cpuUnits: 1',
    '    memoryGiB: 0.1',
    '    cacheInputs: []',
    '    executionKey: viewport-smoke',
    '    executionVariant: runtime',
    '    requiresPlaywright: chromium',
    '    artifacts: [viewport-output.json]',
    '    evidence: [viewport-output.json]',
    '    ciJob: ux-viewport-smoke'
  ].join('\n'))

  const env = {
    ...process.env,
    FSUSBLOG_MATRIX_FILE: matrix,
    FSUSBLOG_TEST_RUN_ID: `viewport-resume-${process.pid}`,
    FSUSBLOG_UX_VIEWPORT_RESUME: '1'
  }
  const fresh = spawnSync(process.execPath, [runner, 'run', 'ux-viewport-smoke', '--fresh'], {
    cwd: temp,
    env,
    encoding: 'utf8'
  })
  assert.equal(fresh.status, 0, fresh.stderr)
  fs.rmSync(artifact)
  const resumed = spawnSync(process.execPath, [runner, 'run', 'ux-viewport-smoke', '--resume'], {
    cwd: temp,
    env,
    encoding: 'utf8'
  })
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.deepEqual(fs.readFileSync(history, 'utf8').trim().split('\n'), ['0', '1'])
})

test('local fresh runs isolate the default namespace by scheduler run id', () => {
  const temp = createTempDir('scheduler-fresh-namespace')
  const runner = createRunnerFixture(temp)
  const marker = path.join(temp, 'namespaces.txt')
  const script = path.join(temp, 'namespace.mjs')
  const matrix = path.join(temp, 'matrix.yml')
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, process.env.FSUSBLOG_TEST_NAMESPACE + '\\n')\n`)
  fs.writeFileSync(matrix, [
    'version: fsusblog-test-matrix-v2',
    'tiers:',
    '  - id: fixture',
    `    command: ${JSON.stringify(`${process.execPath} ${script}`)}`,
    '    dependsOn: []',
    '    services: []',
    '    parallelizable: true',
    '    exclusiveResources: []',
    '    phase: 1',
    '    resourceClass: cpu',
    '    maxParallel: 1',
    '    cpuUnits: 1',
    '    memoryGiB: 0.1',
    '    cacheInputs: []',
    '    executionKey: fixture',
    '    executionVariant: ordinary',
    '    coverage: []',
    '    requiresPlaywright: none',
    '    artifacts: []',
    '    evidence: []',
    '    ciJob: fixture'
  ].join('\n'))

  for (const runId of ['fresh-namespace-a', 'fresh-namespace-b']) {
    const result = spawnSync(process.execPath, [runner, 'run', 'fixture', '--fresh'], {
      cwd: temp,
      env: {
        ...process.env,
        FSUSBLOG_MATRIX_FILE: matrix,
        FSUSBLOG_TEST_RUN_ID: runId,
        FSUSBLOG_TEST_NAMESPACE: ''
      },
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
  }

  const namespaces = fs.readFileSync(marker, 'utf8').trim().split('\n')
  assert.equal(new Set(namespaces).size, 2)
  assert.match(namespaces[0], /fresh-namespace-a/u)
  assert.match(namespaces[1], /fresh-namespace-b/u)
})

test('fresh summaries reset locally while tier resources cap nested worker pools', () => {
  const temp = createTempDir('scheduler-summary-fresh')
  const runner = createRunnerFixture(temp)
  const marker = path.join(temp, 'workers.json')
  const script = path.join(temp, 'workers.mjs')
  const matrix = path.join(temp, 'matrix.yml')
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ vitest: process.env.FSUSBLOG_VITEST_MAX_WORKERS, manifest: process.env.FSUSBLOG_COMMAND_MANIFEST_WORKERS }))\n`)
  fs.writeFileSync(matrix, [
    'version: fsusblog-test-matrix-v2',
    'tiers:',
    '  - id: fixture',
    `    command: ${JSON.stringify(`${process.execPath} ${script}`)}`,
    '    dependsOn: []',
    '    services: []',
    '    parallelizable: true',
    '    exclusiveResources: []',
    '    phase: 1',
    '    resourceClass: cpu',
    '    maxParallel: 2',
    '    cpuUnits: 2',
    '    memoryGiB: 2',
    '    cacheInputs: []',
    '    executionKey: fixture',
    '    executionVariant: ordinary',
    '    coverage: []',
    '    requiresPlaywright: none',
    '    artifacts: []',
    '    evidence: []',
    '    ciJob: fixture'
  ].join('\n'))
  const env = { ...process.env, FSUSBLOG_MATRIX_FILE: matrix, FSUSBLOG_TEST_RUN_ID: 'same-fresh-run' }
  delete env.FSUSBLOG_VITEST_MAX_WORKERS
  delete env.FSUSBLOG_COMMAND_MANIFEST_WORKERS
  const run = () => spawnSync(process.execPath, [runner, 'run', 'fixture', '--fresh'], { cwd: temp, env, encoding: 'utf8' })
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { vitest: '1', manifest: '2' })
  const summaryFile = path.join(temp, '.tmp/release-evidence/jobs/fixture.json')
  const poisoned = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
  poisoned.durationMs = 999_999
  fs.writeFileSync(summaryFile, `${JSON.stringify(poisoned)}\n`)
  const second = run()
  assert.equal(second.status, 0, second.stderr)
  assert.ok(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).durationMs < 100_000)
})

test('fresh CI steps accumulate within one workflow job but reset on the next workflow run', () => {
  const temp = createTempDir('scheduler-summary-ci')
  const runner = createRunnerFixture(temp)
  const matrix = path.join(temp, 'matrix.yml')
  const noop = path.join(temp, 'noop.mjs')
  fs.writeFileSync(noop, 'process.exit(0)\n')
  const tierLines = (id) => [
    `  - id: ${id}`,
    `    command: ${JSON.stringify(`${process.execPath} ${noop}`)}`,
    '    dependsOn: []',
    '    services: []',
    '    parallelizable: true',
    '    exclusiveResources: []',
    '    phase: 1',
    '    resourceClass: cpu',
    '    maxParallel: 1',
    '    cpuUnits: 1',
    '    memoryGiB: 1',
    '    cacheInputs: []',
    `    executionKey: ${id}`,
    '    executionVariant: ordinary',
    '    coverage: []',
    '    requiresPlaywright: none',
    '    artifacts: []',
    '    evidence: []',
    '    ciJob: fixture'
  ]
  fs.writeFileSync(matrix, ['version: fsusblog-test-matrix-v2', 'tiers:', ...tierLines('first'), ...tierLines('second')].join('\n'))
  const run = (tierId, githubRunId) => spawnSync(process.execPath, [runner, 'run', tierId, '--no-deps', '--fresh'], {
    cwd: temp,
    env: {
      ...process.env,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_RUN_ID: githubRunId,
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_JOB: 'fixture-workflow-job',
      FSUSBLOG_MATRIX_FILE: matrix,
      FSUSBLOG_TEST_RUN_ID: `${githubRunId}-${tierId}`
    },
    encoding: 'utf8'
  })
  const firstRun = run('first', '100')
  assert.equal(firstRun.status, 0, firstRun.stderr)
  const secondRun = run('second', '100')
  assert.equal(secondRun.status, 0, secondRun.stderr)
  const summaryFile = path.join(temp, '.tmp/release-evidence/jobs/fixture.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).tierIds.sort(), ['first', 'second'])
  const nextWorkflowRun = run('second', '101')
  assert.equal(nextWorkflowRun.status, 0, nextWorkflowRun.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).tierIds, ['second'])
})

test('production cleanup uses the same safe namespace for dot segments as fixture writers', () => {
  const temp = createTempDir('scheduler-namespace-cleanup')
  const runner = createRunnerFixture(temp)
  const script = path.join(temp, 'fixture.mjs')
  const matrix = path.join(temp, 'matrix.yml')
  fs.writeFileSync(script, "import fs from 'node:fs'\nfs.mkdirSync('.tmp/fixtures/local/auth', { recursive: true })\nfs.writeFileSync('.tmp/fixtures/local/auth/secret.json', '{}')\n")
  fs.writeFileSync(matrix, [
    'version: fsusblog-test-matrix-v2',
    'tiers:',
    '  - id: production',
    `    command: ${JSON.stringify(`${process.execPath} ${script}`)}`,
    '    dependsOn: []',
    '    services: []',
    '    parallelizable: true',
    '    exclusiveResources: []',
    '    phase: 1',
    '    resourceClass: cpu',
    '    maxParallel: 1',
    '    cacheInputs: []',
    '    requiresPlaywright: none',
    '    artifacts: []',
    '    evidence: []',
    '    ciJob: production-summary'
  ].join('\n'))
  const result = spawnSync(process.execPath, [runner, 'run', 'production', '--fresh'], {
    cwd: temp,
    env: { ...process.env, FSUSBLOG_MATRIX_FILE: matrix, FSUSBLOG_TEST_NAMESPACE: '..' },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(path.join(temp, '.tmp/fixtures/local/auth')), false)
  const evidence = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/sensitive-fixture-cleanup.json'), 'utf8'))
  assert.equal(evidence.namespace, 'local')
})

test('ci-job keeps its CLI contract while using one scheduler checkpoint for all job tiers', () => {
  const temp = createTempDir('scheduler-ci-job')
  const runner = createRunnerFixture(temp)
  const marker = path.join(temp, 'marker.txt')
  const firstScript = path.join(temp, 'first.mjs')
  const secondScript = path.join(temp, 'second.mjs')
  const matrix = path.join(temp, 'matrix.yml')
  fs.writeFileSync(firstScript, `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, 'a')\n`)
  fs.writeFileSync(secondScript, `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, 'b')\n`)

  const tierLines = (id, script) => [
    `  - id: ${id}`,
    `    command: ${JSON.stringify(`${process.execPath} ${script}`)}`,
    '    dependsOn: []',
    '    services: []',
    '    parallelizable: true',
    '    exclusiveResources: []',
    '    resourceClass: cpu',
    '    maxParallel: 2',
    '    cpuUnits: 1',
    '    memoryGiB: 0.1',
    '    cacheInputs: []',
    `    executionKey: ${id}`,
    '    requiresPlaywright: none',
    '    artifacts: []',
    '    evidence: []',
    '    ciJob: fixture-job',
    '    localOnly: false',
    '    nightlyOnly: false'
  ]
  fs.writeFileSync(matrix, [
    'version: fsusblog-test-matrix-v2',
    'tiers:',
    ...tierLines('first', firstScript),
    ...tierLines('second', secondScript)
  ].join('\n'))

  const runId = `scheduler-ci-job-${process.pid}`
  const result = spawnSync(process.execPath, [
    runner,
    'ci-job',
    'fixture-job',
    '--fresh',
    '--max-parallel=2'
  ], {
    cwd: temp,
    env: {
      ...process.env,
      FSUSBLOG_MATRIX_FILE: matrix,
      FSUSBLOG_TEST_RUN_ID: runId
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual([...fs.readFileSync(marker, 'utf8')].sort(), ['a', 'b'])
  const checkpoint = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/test-runs', runId, 'checkpoint.json'), 'utf8'))
  assert.deepEqual(checkpoint.completedTiers.sort(), ['first', 'second'])
})

test('tier fingerprints include shard, selected runtime environment, platform, architecture, and Node version', async () => {
  const { tierInputFingerprint } = await loadScheduler()
  assert.equal(typeof tierInputFingerprint, 'function')
  const temp = createTempDir('scheduler-fingerprint-context')
  fs.writeFileSync(path.join(temp, 'input.txt'), 'input\n')
  const current = tier('contextual', { cacheInputs: ['input.txt'] })
  const baseContext = {
    env: {
      MATRIX_SHARD: '1/2',
      FSUSBLOG_TEST_SHARD_INDEX: '1',
      PLAYWRIGHT_BROWSERS: 'chromium',
      VITE_MODE: 'test',
      CI: 'false',
      NODE_ENV: 'test',
      DOTNET_ROOT: '/dotnet',
      HOME: '/ignored-a'
    },
    platform: 'linux',
    arch: 'x64',
    nodeVersion: 'v22.0.0'
  }
  const base = tierInputFingerprint(current, temp, baseContext)
  assert.equal(base, tierInputFingerprint(current, temp, {
    ...baseContext,
    env: { ...baseContext.env, HOME: '/ignored-b' }
  }), 'unrelated environment variables must not fragment the cache')

  for (const changedContext of [
    { ...baseContext, env: { ...baseContext.env, MATRIX_SHARD: '2/2' } },
    { ...baseContext, env: { ...baseContext.env, FSUSBLOG_FEATURE_FLAG: '1' } },
    { ...baseContext, env: { ...baseContext.env, PLAYWRIGHT_BROWSERS: 'all' } },
    { ...baseContext, env: { ...baseContext.env, VITE_MODE: 'production' } },
    { ...baseContext, env: { ...baseContext.env, CI: 'true' } },
    { ...baseContext, platform: 'win32' },
    { ...baseContext, arch: 'arm64' },
    { ...baseContext, nodeVersion: 'v24.0.0' }
  ]) {
    assert.notEqual(base, tierInputFingerprint(current, temp, changedContext))
  }
})

test('resume never reuses a successful tier from a different shard and records checkpoint authority', async () => {
  const { runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-shard-resume')
  const runsRoot = path.join(temp, 'runs')
  const current = tier('sharded')
  const executed = []
  const executeTier = async () => {
    executed.push('run')
    return { code: 0, signal: null }
  }
  const run = (shard, resume) => runDag({
    tiers: [current],
    root: temp,
    runsRoot,
    runId: 'same-run',
    mode: resume ? 'resume' : 'fresh',
    resume,
    maxParallel: 1,
    snapshotWorktree: stableSnapshot,
    envForTier: () => ({
      MATRIX_SHARD: shard,
      FSUSBLOG_TEST_SHARD_INDEX: shard.split('/')[0],
      FSUSBLOG_TEST_SHARD_TOTAL: shard.split('/')[1]
    }),
    executeTier
  })

  const fresh = await run('1/2', false)
  assert.equal(fresh.checkpoint.mode, 'fresh')
  assert.equal(fresh.checkpoint.authoritative, true)
  const otherShard = await run('2/2', true)
  assert.equal(otherShard.checkpoint.mode, 'resume')
  assert.equal(otherShard.checkpoint.authoritative, false)
  assert.deepEqual(executed, ['run', 'run'])
  const sameShard = await run('2/2', true)
  assert.deepEqual(sameShard.reusedTiers, ['sharded'])
  assert.deepEqual(executed, ['run', 'run'])
})

test('phase barrier settles every lower phase before release evidence can start', async () => {
  const { runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-phase-barrier')
  const events = []
  const lowerSettled = new Set()
  let releaseStartedEarly = false
  const result = await runDag({
    tiers: [
      tier('unit-left', { phase: 1 }),
      tier('unit-right', { phase: 1 }),
      tier('release-evidence', { phase: 4 })
    ],
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'phase-barrier',
    mode: 'fresh',
    maxParallel: 3,
    systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
    snapshotWorktree: stableSnapshot,
    executeTier: async (current) => {
      events.push(`start:${current.id}`)
      if (current.id === 'release-evidence' && lowerSettled.size !== 2) releaseStartedEarly = true
      await delay(current.phase === 4 ? 1 : 25)
      if (current.phase === 1) lowerSettled.add(current.id)
      events.push(`end:${current.id}`)
      return { code: 0, signal: null }
    }
  })
  assert.equal(result.status, 'success')
  assert.equal(releaseStartedEarly, false)
  assert.ok(events.indexOf('start:release-evidence') > events.indexOf('end:unit-left'))
  assert.ok(events.indexOf('start:release-evidence') > events.indexOf('end:unit-right'))
})

test('supersedes rejects variant misuse, cycles, and chains and runDag fails closed', async () => {
  const { runDag, validateSupersedesRules } = await loadScheduler()
  const registry = new Map([['unit', { assertionType: 'unit' }]])
  const variantMisuse = [
    tier('base', { executionKey: 'shared', coverage: ['unit'] }),
    tier('replacement', { executionKey: 'shared', coverage: ['unit'], supersedes: ['base'] })
  ]
  assert.ok(validateSupersedesRules(variantMisuse, registry).some((message) => message.includes('executionVariant')))

  const cycle = [
    tier('cycle-a', {
      executionKey: 'cycle',
      executionVariant: 'coverage',
      coverage: ['unit'],
      supersedes: ['cycle-b']
    }),
    tier('cycle-b', {
      executionKey: 'cycle',
      executionVariant: 'coverage',
      coverage: ['unit'],
      supersedes: ['cycle-a']
    })
  ]
  assert.ok(validateSupersedesRules(cycle, registry).some((message) => /cycle/i.test(message)))

  const chain = [
    tier('chain-base', { executionKey: 'chain', coverage: ['unit'] }),
    tier('chain-middle', {
      executionKey: 'chain',
      executionVariant: 'coverage',
      coverage: ['unit'],
      supersedes: ['chain-base']
    }),
    tier('chain-top', {
      executionKey: 'chain',
      executionVariant: 'coverage',
      coverage: ['unit'],
      supersedes: ['chain-middle']
    })
  ]
  assert.ok(validateSupersedesRules(chain, registry).some((message) => /chain/i.test(message)))
  await assert.rejects(runDag({
    tiers: cycle,
    coverageRegistry: registry,
    root: createTempDir('scheduler-supersedes-cycle'),
    runId: 'cycle',
    mode: 'fresh',
    snapshotWorktree: stableSnapshot,
    executeTier: async () => ({ code: 0, signal: null })
  }), /supersedes/i)
})

test('runDag validates supersedes against the full universe but applies only selected tiers', async () => {
  const { runDag } = await loadScheduler()
  const temp = createTempDir('scheduler-supersedes-universe')
  const registry = new Map([
    ['unit', { assertionType: 'unit' }],
    ['unit-extra', { assertionType: 'unit' }]
  ])
  const target = tier('universe-target', {
    executionKey: 'universe/shared',
    executionVariant: 'ordinary',
    coverage: ['unit']
  })
  const replacement = tier('universe-replacement', {
    executionKey: 'universe/shared',
    executionVariant: 'coverage',
    coverage: ['unit', 'unit-extra'],
    supersedes: ['universe-target']
  })
  const executed = []
  const standalone = await runDag({
    tiers: [replacement],
    supersedesUniverse: [target, replacement],
    coverageRegistry: registry,
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'replacement-only',
    mode: 'fresh',
    snapshotWorktree: stableSnapshot,
    executeTier: async (current) => {
      executed.push(current.id)
      return { code: 0, signal: null }
    }
  })
  assert.equal(standalone.status, 'success')
  assert.deepEqual(executed, ['universe-replacement'])

  const cycle = [
    tier('universe-cycle-a', {
      executionKey: 'universe/cycle',
      executionVariant: 'coverage',
      coverage: ['unit'],
      supersedes: ['universe-cycle-b']
    }),
    tier('universe-cycle-b', {
      executionKey: 'universe/cycle',
      executionVariant: 'coverage',
      coverage: ['unit'],
      supersedes: ['universe-cycle-a']
    })
  ]
  await assert.rejects(runDag({
    tiers: [cycle[0]],
    supersedesUniverse: cycle,
    coverageRegistry: registry,
    root: temp,
    runsRoot: path.join(temp, 'runs'),
    runId: 'global-cycle',
    mode: 'fresh',
    snapshotWorktree: stableSnapshot,
    executeTier: async () => ({ code: 0, signal: null })
  }), /cycle/i)
})

test('snapshot hashes only dirty and untracked paths while retaining status, mode, and index state', async () => {
  const { snapshotGitWorktree } = await loadScheduler()
  const repo = createTempDir('scheduler-incremental-snapshot')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo })
  for (let index = 0; index < 120; index += 1) fs.writeFileSync(path.join(repo, `clean-${index}.txt`), `clean ${index}\n`)
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })

  const clean = await snapshotGitWorktree(repo)
  assert.equal(clean.hashedPathCount, 0)
  assert.deepEqual(clean.entries, {})
  fs.writeFileSync(path.join(repo, 'clean-0.txt'), 'dirty\n')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n')
  execFileSync('git', ['add', 'clean-0.txt'], { cwd: repo })
  const dirty = await snapshotGitWorktree(repo)
  assert.equal(dirty.hashedPathCount, 2)
  assert.deepEqual(Object.keys(dirty.entries).sort(), ['clean-0.txt', 'untracked.txt'])
  assert.match(dirty.entries['clean-0.txt'].status, /^M/)
  assert.match(dirty.entries['clean-0.txt'].index, /^100644:/)
  assert.equal(typeof dirty.entries['clean-0.txt'].mode, 'number')
})

test('pollution detection catches staging and executable-bit changes without rejecting prior dirt', { skip: process.platform === 'win32' }, async () => {
  const { runDag } = await loadScheduler()
  const createRepo = (name) => {
    const repo = createTempDir(name)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo })
    execFileSync('git', ['config', 'core.filemode', 'true'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
    return repo
  }

  const stagedRepo = createRepo('scheduler-staged-pollution')
  fs.writeFileSync(path.join(stagedRepo, 'tracked.txt'), 'pre-existing dirt\n')
  const staged = await runDag({
    tiers: [tier('stage', { command: 'git add tracked.txt' })],
    root: stagedRepo,
    runsRoot: createTempDir('scheduler-stage-runs'),
    runId: 'stage',
    mode: 'fresh',
    maxParallel: 1
  })
  assert.equal(staged.status, 'failure')
  assert.ok(staged.failure.changedPaths.includes('tracked.txt'))

  const modeRepo = createRepo('scheduler-mode-pollution')
  const mode = await runDag({
    tiers: [tier('chmod', { command: 'chmod 755 tracked.txt' })],
    root: modeRepo,
    runsRoot: createTempDir('scheduler-mode-runs'),
    runId: 'chmod',
    mode: 'fresh',
    maxParallel: 1
  })
  assert.equal(mode.status, 'failure')
  assert.ok(mode.failure.changedPaths.includes('tracked.txt'))
})

test('ci-pr-smart executes selected tiers through one asynchronous DAG run', () => {
  const temp = createTempDir('scheduler-ci-pr-smart')
  const runner = createRunnerFixture(temp)
  const marker = path.join(temp, 'events.txt')
  const changedFiles = path.join(temp, 'changed.txt')
  const matrix = path.join(temp, 'matrix.yml')
  fs.writeFileSync(changedFiles, '')
  const scriptFor = (id) => {
    const script = path.join(temp, `${id}.mjs`)
    fs.writeFileSync(script, [
      "import fs from 'node:fs'",
      `fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`start:${id}\n`)})`,
      `setTimeout(() => { fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`end:${id}\n`)}); }, 120)`
    ].join('\n'))
    return script
  }
  const tierLines = (id) => [
    `  - id: ${id}`,
    `    command: ${JSON.stringify(`${process.execPath} ${scriptFor(id)}`)}`,
    '    dependsOn: []',
    '    services: []',
    '    parallelizable: true',
    '    exclusiveResources: []',
    '    phase: 1',
    '    resourceClass: cpu',
    '    maxParallel: 2',
    '    cpuUnits: 0.1',
    '    memoryGiB: 0.01',
    '    cacheInputs: []',
    `    executionKey: ${id}`,
    '    executionVariant: ordinary',
    '    coverage: []',
    '    requiresPlaywright: none',
    '    artifacts: []',
    '    evidence: []',
    `    ciJob: ${id}`,
    '    localOnly: false',
    '    nightlyOnly: false',
    '    requiredFor: fast',
    '    smartGateMode: always'
  ]
  fs.writeFileSync(matrix, [
    'version: fsusblog-test-matrix-v2',
    'tiers:',
    ...tierLines('smart-a'),
    ...tierLines('smart-b')
  ].join('\n'))

  const result = spawnSync(process.execPath, [
    runner,
    'ci-pr-smart',
    '--changed-files',
    changedFiles
  ], {
    cwd: temp,
    env: { ...process.env, FSUSBLOG_MATRIX_FILE: matrix },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const events = fs.readFileSync(marker, 'utf8').trim().split('\n')
  const firstEnd = Math.min(events.indexOf('end:smart-a'), events.indexOf('end:smart-b'))
  assert.ok(events.indexOf('start:smart-a') < firstEnd)
  assert.ok(events.indexOf('start:smart-b') < firstEnd)
})
