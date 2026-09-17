import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  prioritySchemas,
  rankReadyTiers,
  startupAdmissionOrder
} from '../../tools/test-matrix/priority-score.mjs'
import { runDag } from '../../tools/test-matrix/scheduler.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const stableSnapshot = async () => ({ fingerprint: 'stable', entries: {} })

function tempDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`))
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
    cacheInputs: [`src/${id}`],
    executionKey: `test/${id}`,
    executionVariant: 'ordinary',
    coverage: [`coverage-${id}`],
    priorityTestIds: [`test/${id}`],
    sourceClosureDigest: `sha256:${createHash('sha256').update(id).digest('hex')}`,
    ...overrides
  }
}

function historyEntry(current, {
  samples = 10,
  failures = 0,
  durationMs = 100,
  signatures = failures > 0 ? 1 : 0,
  closure = current.sourceClosureDigest
} = {}) {
  return {
    testId: current.priorityTestIds[0],
    samples,
    durationMs: { p50: durationMs, p95: durationMs },
    outcomeCounts: { passed: samples - failures, failed: failures, skipped: 0, blocked: 0 },
    signatureCounts: Object.fromEntries(Array.from({ length: signatures }, (_, index) => [`failure-${index}`, 1])),
    sourceCommits: ['a'.repeat(40)],
    sourceClosureDigests: [closure],
    runnerIdentities: [{ os: 'linux', arch: 'x64', runtime: 'node-v24' }]
  }
}

function priorityInput(tiers, overrides = {}) {
  return {
    schema: prioritySchemas.input,
    changedPaths: [],
    tierBindings: Object.fromEntries(tiers.map((current) => [current.id, {
      sourceClosureDigest: current.sourceClosureDigest,
      testIds: current.priorityTestIds
    }])),
    ledger: {
      schema: 'fsusblog.test-observation-index.v1',
      coldStart: false,
      artifactCount: tiers.length,
      observationCount: tiers.length * 10,
      tests: tiers.map((current) => historyEntry(current))
    },
    durationsMs: {},
    ...overrides
  }
}

test('versioned score prioritizes relevant risky failure-prone short work deterministically', () => {
  const baseline = tier('baseline', {
    startupPriority: 2,
    deadlineWeight: 10,
    risk: 'medium'
  })
  const signal = tier('signal', {
    startupPriority: 2,
    deadlineWeight: 10,
    risk: 'critical',
    triggerPaths: ['src/security']
  })
  const input = priorityInput([baseline, signal], {
    changedPaths: ['src/security/Auth.cs'],
    ledger: {
      schema: 'fsusblog.test-observation-index.v1',
      coldStart: false,
      artifactCount: 2,
      observationCount: 20,
      tests: [
        historyEntry(baseline, { failures: 0, durationMs: 2_000 }),
        historyEntry(signal, { failures: 5, durationMs: 100, signatures: 3 })
      ]
    }
  })

  const first = rankReadyTiers([baseline, signal], input)
  const second = rankReadyTiers([signal, baseline], input)
  assert.equal(first.schema, 'fsusblog.test-matrix.priority-score.v1')
  assert.equal(first.modelVersion, 1)
  assert.equal(first.mode, 'dynamic')
  assert.deepEqual(first, second)
  assert.deepEqual(first.ranked.map((entry) => entry.tierId), ['signal', 'baseline'])
  assert.deepEqual(
    first.ranked[0].breakdown.signals.changedSourceRelevance.rawValue,
    ['src/security/Auth.cs']
  )
  assert.equal(first.ranked[0].breakdown.sourceBinding.samples, 10)
  assert.ok(first.ranked[0].breakdown.signals.failureProbability.contribution > 0)
  assert.ok(first.ranked[0].breakdown.signals.estimatedDuration.contribution > 0)
})

test('checked-in score schema binds the version, source closure, and explainable signals', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(root, 'config/schemas/test-matrix-priority-score.schema.json'),
    'utf8'
  ))
  assert.equal(schema.properties.schema.const, 'fsusblog.test-matrix.priority-score.v1')
  assert.equal(schema.properties.modelVersion.const, 1)
  assert.equal(
    schema.properties.sourceBinding.oneOf[1].properties.sourceClosureDigest.$ref,
    '#/$defs/digest'
  )
  assert.deepEqual(
    schema.$defs.signal.required,
    ['rawValue', 'normalizedValue', 'weight', 'contribution']
  )
})

test('cold, source-mismatched, undersampled, and disabled inputs exactly preserve startup order', () => {
  const tiers = [
    tier('z', { startupPriority: 1, deadlineWeight: 100 }),
    tier('a', { startupPriority: 2, deadlineWeight: 0 }),
    tier('b', { startupPriority: 1, deadlineWeight: 100 })
  ]
  const expected = [...tiers].sort(startupAdmissionOrder).map((entry) => entry.id)
  const cases = [
    undefined,
    priorityInput(tiers, {
      ledger: {
        schema: 'fsusblog.test-observation-index.v1',
        coldStart: true,
        artifactCount: 0,
        observationCount: 0,
        tests: []
      }
    }),
    priorityInput(tiers, {
      ledger: {
        schema: 'fsusblog.test-observation-index.v1',
        coldStart: false,
        artifactCount: 3,
        observationCount: 30,
        tests: tiers.map((current) => historyEntry(current, {
          closure: current.id === 'a' ? `sha256:${'f'.repeat(64)}` : current.sourceClosureDigest
        }))
      }
    }),
    priorityInput(tiers, {
      ledger: {
        schema: 'fsusblog.test-observation-index.v1',
        coldStart: false,
        artifactCount: 4,
        observationCount: 40,
        tests: tiers.map((current) => ({
          ...historyEntry(current),
          sourceClosureDigests: current.id === 'a'
            ? [current.sourceClosureDigest, `sha256:${'f'.repeat(64)}`]
            : [current.sourceClosureDigest]
        }))
      }
    }),
    priorityInput(tiers, {
      ledger: {
        schema: 'fsusblog.test-observation-index.v1',
        coldStart: false,
        artifactCount: 3,
        observationCount: 3,
        tests: tiers.map((current) => historyEntry(current, { samples: 1 }))
      }
    })
  ]

  for (const input of cases) {
    const result = rankReadyTiers(tiers, input)
    assert.equal(result.mode, 'startup-fallback')
    assert.deepEqual(result.ranked.map((entry) => entry.tierId), expected)
  }
  assert.deepEqual(
    rankReadyTiers(tiers, priorityInput(tiers), { enabled: false }).ranked.map((entry) => entry.tierId),
    expected
  )
})

test('file-driven fixture accepts synthetic changed paths, ledger history, and durations', () => {
  const tiers = [tier('long'), tier('short', { triggerPaths: ['src/changed'] })]
  const fixture = {
    tiers,
    priorityInput: priorityInput(tiers, {
      changedPaths: ['src/changed/file.ts'],
      durationsMs: { long: 4_000, short: 50 }
    })
  }
  const directory = tempDirectory('priority-fixture')
  const fixtureFile = path.join(directory, 'fixture.json')
  fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`)
  const output = JSON.parse(execFileSync(process.execPath, [
    path.join(root, 'tools/test-matrix/run-priority-fixture.mjs'),
    fixtureFile
  ], { encoding: 'utf8' }))
  assert.deepEqual(output.ranked.map((entry) => entry.tierId), ['short', 'long'])
  const checkedIn = JSON.parse(execFileSync(process.execPath, [
    path.join(root, 'tools/test-matrix/run-priority-fixture.mjs'),
    path.join(root, 'tests/fixtures/test-matrix-priority/ready-set.json')
  ], { encoding: 'utf8' }))
  assert.deepEqual(checkedIn.ranked.map((entry) => entry.tierId), ['security-fast', 'general-long'])
})

test('aging admits an older low-score tier before newly-ready higher-score work', async () => {
  const highOne = tier('high-one', { deadlineWeight: 10 })
  const highTwo = tier('high-two', { deadlineWeight: 10, dependsOn: ['high-one'] })
  const low = tier('low', { deadlineWeight: 0 })
  const tiers = [highOne, highTwo, low]
  const starts = []
  const directory = tempDirectory('priority-aging')
  const result = await runDag({
    tiers,
    root: directory,
    runsRoot: path.join(directory, 'runs'),
    runId: 'aging',
    maxParallel: 1,
    systemResources: { cpuCount: 1, availableCpuUnits: 1, availableMemoryGiB: 2, load1: 0 },
    snapshotWorktree: stableSnapshot,
    priorityInput: priorityInput(tiers),
    executeTier: async (current) => {
      starts.push(current.id)
      return { code: 0, signal: null }
    }
  })

  assert.equal(result.status, 'success')
  assert.deepEqual(starts, ['high-one', 'low', 'high-two'])
  assert.deepEqual(new Set(starts), new Set(tiers.map((entry) => entry.id)))
  assert.equal(starts.length, tiers.length, 'required tiers remain exact-once')
  assert.equal(result.checkpoint.priorityScheduling.waves[1].decisions[0].tierId, 'low')
  assert.ok(result.checkpoint.priorityScheduling.waves[1].decisions[0].breakdown.signals.aging.contribution > 0)
})

test('scheduler disable switch restores startupAdmissionOrder without changing the tier union', async () => {
  const baselineFirst = tier('baseline-first', { startupPriority: 5 })
  const dynamicFirst = tier('dynamic-first', {
    startupPriority: 0,
    triggerPaths: ['src/changed'],
    risk: 'critical'
  })
  const tiers = [dynamicFirst, baselineFirst]
  const input = priorityInput(tiers, {
    changedPaths: ['src/changed/file.cs'],
    ledger: {
      schema: 'fsusblog.test-observation-index.v1',
      coldStart: false,
      artifactCount: 2,
      observationCount: 20,
      tests: [
        historyEntry(dynamicFirst, { failures: 8, durationMs: 10 }),
        historyEntry(baselineFirst, { failures: 0, durationMs: 2_000 })
      ]
    }
  })
  const directory = tempDirectory('priority-disabled')
  const starts = []
  const result = await runDag({
    tiers,
    root: directory,
    runsRoot: path.join(directory, 'runs'),
    runId: 'disabled',
    maxParallel: 1,
    systemResources: { cpuCount: 1, availableCpuUnits: 1, availableMemoryGiB: 2, load1: 0 },
    snapshotWorktree: stableSnapshot,
    priorityInput: input,
    env: { FSUSBLOG_TEST_DYNAMIC_PRIORITY: '0' },
    executeTier: async (current) => {
      starts.push(current.id)
      return { code: 0, signal: null }
    }
  })

  assert.equal(result.status, 'success')
  assert.deepEqual(starts, ['baseline-first', 'dynamic-first'])
  assert.equal(result.checkpoint.priorityScheduling.enabled, false)
  assert.equal(result.checkpoint.priorityScheduling.waves[0].fallbackReason, 'disabled')
  assert.equal(new Set(starts).size, tiers.length)
})

test('dynamic scores cannot cross dependency, phase, exclusive resource, or resource budget boundaries', async () => {
  const holder = tier('holder', {
    startupPriority: 5,
    exclusiveResources: ['database'],
    triggerPaths: ['src/hot'],
    risk: 'critical'
  })
  const exclusive = tier('exclusive', {
    exclusiveResources: ['database'],
    triggerPaths: ['src/hot'],
    risk: 'critical'
  })
  const useful = tier('useful')
  const oversized = tier('oversized', {
    cpuUnits: 3,
    triggerPaths: ['src/hot'],
    risk: 'critical'
  })
  const dependencyBlocked = tier('dependency-blocked', {
    dependsOn: ['useful'],
    triggerPaths: ['src/hot'],
    risk: 'critical'
  })
  const laterPhase = tier('later-phase', {
    phase: 1,
    triggerPaths: ['src/hot'],
    risk: 'critical'
  })
  const tiers = [holder, exclusive, useful, oversized, dependencyBlocked, laterPhase]
  const input = priorityInput(tiers, {
    changedPaths: ['src/hot/change.cs'],
    ledger: {
      schema: 'fsusblog.test-observation-index.v1',
      coldStart: false,
      artifactCount: tiers.length,
      observationCount: tiers.length * 10,
      tests: tiers.map((current) => historyEntry(current, {
        failures: current.id === 'useful' ? 0 : 8,
        durationMs: current.id === 'useful' ? 2_000 : 20
      }))
    }
  })
  const starts = []
  const directory = tempDirectory('priority-hard-constraints')
  const result = await runDag({
    tiers,
    root: directory,
    runsRoot: path.join(directory, 'runs'),
    runId: 'hard-constraints',
    maxParallel: 3,
    systemResources: { cpuCount: 2, availableCpuUnits: 2, availableMemoryGiB: 2, load1: 0 },
    snapshotWorktree: stableSnapshot,
    priorityInput: input,
    executeTier: async (current) => {
      starts.push(current.id)
      await delay(current.id === 'holder' ? 20 : 1)
      return { code: 0, signal: null }
    }
  })

  assert.equal(result.status, 'failure', 'oversized required work must fail closed instead of being skipped')
  assert.deepEqual(starts.filter((id) => id === 'holder' || id === 'exclusive').sort(), ['exclusive', 'holder'])
  assert.ok(starts.indexOf('dependency-blocked') > starts.indexOf('useful'))
  assert.equal(starts.includes('later-phase'), false, 'later phase cannot cross the unresolved phase-zero tier')
  assert.equal(starts.includes('oversized'), false)
  const firstWave = result.checkpoint.priorityScheduling.waves[0]
  assert.equal(firstWave.decisions.find((entry) => entry.tierId === 'exclusive').hardConstraint, 'exclusive-resource')
  assert.equal(firstWave.decisions.find((entry) => entry.tierId === 'oversized').hardConstraint, 'cpu-budget')
  assert.deepEqual(
    tiers.map((entry) => [entry.id, entry.executionKey, entry.coverage]),
    [
      ['holder', 'test/holder', ['coverage-holder']],
      ['exclusive', 'test/exclusive', ['coverage-exclusive']],
      ['useful', 'test/useful', ['coverage-useful']],
      ['oversized', 'test/oversized', ['coverage-oversized']],
      ['dependency-blocked', 'test/dependency-blocked', ['coverage-dependency-blocked']],
      ['later-phase', 'test/later-phase', ['coverage-later-phase']]
    ],
    'producer and evidence ownership metadata is untouched'
  )
})
