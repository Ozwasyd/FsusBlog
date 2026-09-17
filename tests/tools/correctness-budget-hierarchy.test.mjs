import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { applyCorrectnessBudgetPolicy, bindBudgetPolicy, correctnessBudgetPolicyDigest, loadCorrectnessBudgetPolicy, validateCorrectnessBudgetPolicy } from '../../tools/test-matrix/correctness-budget-policy.mjs'
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'
import { runDag } from '../../tools/test-matrix/scheduler.mjs'
const root = new URL('../..', import.meta.url)
const matrix = parseMatrix(fs.readFileSync(new URL('../../tests/matrix.yml', import.meta.url), 'utf8'))
const policy = loadCorrectnessBudgetPolicy()
const valid = () => structuredClone(policy)
const soak = (candidate) => candidate.policies.find((entry) => entry.tierId === 'soak-short-runtime')
const digest = (character) => `sha256:${character.repeat(64)}`
const stableSnapshot = async () => ({ fingerprint: 'stable', entries: {} })
function schedulerTier(id, overrides = {}) {
  return {
    id,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`,
    executionDependsOn: [], services: [], parallelizable: true, exclusiveResources: [], phase: 0,
    resourceClass: 'cpu', maxParallel: 1, cpuUnits: 1, memoryGiB: 0.1,
    cacheInputs: [], executionKey: `test/${id}`, executionVariant: 'ordinary', coverage: ['ordinary-unit'],
    ...overrides
  }
}
function schedulerTemp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`)) }
test('direct correctness retains bounded matrix deadlines and complete five-layer policy', () => {
  assert.deepEqual(validateCorrectnessBudgetPolicy(policy, matrix), [])
  const source = fs.readFileSync(new URL('../../tools/run-test-matrix.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /budgetMs:\s*null/u)
  assert.match(source, /budgetPolicyDigest: profileCorrectnessBudget \? correctnessBudgetPolicyDigest\(correctnessBudgetPolicy\) : null/u)
  assert.match(source, /profileCorrectnessBudget\?\.profileGlobalBudgetMs \?\? profile\.budgetMs/u)
  assert.match(source, /FSUSBLOG_TIER_SCHEDULER_BUDGET_MS/u)
  assert.match(source, /bindBudgetPolicy\(\{\}, \{\}, budgetPolicy\)/u)
  assert.equal(matrix.tiers.find((tier) => tier.id === 'production').timeoutMinutes, 120)
})
test('budget hierarchy rejects short soak, shortened measurement, omitted grace, oversized timeout, too-small global, missing phase, and unsafe observe-only', () => {
  for (const mutate of [
    (p) => { soak(p).producerExecutionBudgetMs = 300000 },
    (p) => { soak(p).producerExecutionBudgetMs = null },
    (p) => { soak(p).measurementWindowMs = 299999 },
    (p) => { soak(p).terminationGraceMs = 0 },
    (p) => { soak(p).tierSchedulerBudgetMs = 1_800_001 },
    (p) => { soak(p).profileGlobalBudgetMs = 100000 },
    (p) => { soak(p).timeoutPhases = ['measurement'] },
    (p) => { delete soak(p).producerTimeoutPhase },
    (p) => { delete p.policies.find((entry) => entry.tierId === 'soak-long-scheduled').hardSafetyBudgetMs }
  ]) { const candidate = valid(); mutate(candidate); assert.notDeepEqual(validateCorrectnessBudgetPolicy(candidate, matrix), []) }
})
test('producer and global deadlines propagate a mandatory runtime timeout phase', async (t) => {
  const temp = schedulerTemp('correctness-timeout-phase'); t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const result = await runDag({
    tiers: [schedulerTier('producer-timeout', { producerExecutionBudgetMs: 50, terminationGraceMs: 10, producerTimeoutPhase: 'termination' })],
    root: temp, runsRoot: path.join(temp, 'runs'), runId: 'producer-timeout', maxParallel: 1,
    systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 }, snapshotWorktree: stableSnapshot,
    sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }, budgetPolicyDigest: digest('c')
  })
  assert.equal(result.failure.timeoutPhase, 'termination')
  assert.equal(result.checkpoint.tiers['producer-timeout'].timeoutPhase, 'termination')
  assert.equal(
    result.checkpoint.tiers['producer-timeout'].physicalExecutionTermination?.terminated,
    true
  )
  assert.equal(
    result.checkpoint.tiers['producer-timeout'].physicalExecutionTermination?.postObservation,
    'zero-members'
  )
  const global = await runDag({
    tiers: [schedulerTier('global-timeout')], root: temp, runsRoot: path.join(temp, 'runs'), runId: 'global-timeout', maxParallel: 1,
    wallClockBudgetMs: 50, terminationGraceMs: 10,
    systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 }, snapshotWorktree: stableSnapshot,
    sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }, budgetPolicyDigest: digest('c')
  })
  assert.equal(global.failure.timeoutPhase, 'global')
  const missing = await runDag({
    tiers: [schedulerTier('missing-timeout-phase')], root: temp, runsRoot: path.join(temp, 'runs'), runId: 'missing-timeout-phase', maxParallel: 1,
    systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 }, snapshotWorktree: stableSnapshot,
    sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }, budgetPolicyDigest: digest('c'),
    executeTier: async () => ({ code: 124, signal: null })
  })
  assert.match(missing.failure.reason, /timeout phase is missing or invalid/u)
})
test('policy binding changes the scheduler candidate identity and prevents resume reuse', async (t) => {
  const temp = schedulerTemp('correctness-policy-drift'); t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  let executions = 0
  const common = {
    tiers: [schedulerTier('policy-bound')], root: temp, runsRoot: path.join(temp, 'runs'), runId: 'policy-bound', maxParallel: 1,
    systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 }, snapshotWorktree: stableSnapshot,
    sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    executeTier: async () => { executions += 1; return { code: 0, signal: null } }
  }
  const initial = await runDag({ ...common, budgetPolicyDigest: digest('c') })
  const resumed = await runDag({ ...common, resume: true, mode: 'resume', budgetPolicyDigest: digest('d') })
  assert.notEqual(initial.checkpoint.schedulerCandidateIdentityDigest, resumed.checkpoint.schedulerCandidateIdentityDigest)
  assert.equal(resumed.checkpoint.resumePolicy.budgetPolicyChanged, true)
  assert.deepEqual(resumed.reusedTiers, [])
  assert.equal(executions, 2)
})
test('missing policy source fails closed', () => {
  assert.match(validateCorrectnessBudgetPolicy({ missing: true }, matrix).join('\n'), /source is missing/u)
})
test('policy is a bidirectional matrix contract and injects bounded producer execution values', () => {
  const missing = valid(); missing.policies = missing.policies.filter((entry) => entry.tierId !== 'soak-short-runtime')
  assert.match(validateCorrectnessBudgetPolicy(missing, matrix).join('\n'), /matrix producer is absent/u)
  const tiers = applyCorrectnessBudgetPolicy([{ id: 'soak-short-runtime', budgetMs: null }], policy)
  assert.equal(tiers[0].budgetMs, 1_800_000)
  assert.equal(tiers[0].terminationGraceMs, 15_000)
  assert.equal(tiers[0].producerExecutionBudgetMs, 375_000)
  assert.equal(tiers[0].correctnessBudget.measurementWindowMs, 300000)
})
test('matrix producer disagreement, finalizer measurement inheritance, and policy tampering fail closed and bind identity plus receipt', () => {
  const mismatch = valid(); mismatch.policies[0].producer = 'wrong'; assert.match(validateCorrectnessBudgetPolicy(mismatch, matrix).join('\n'), /producer must match/u)
  const inherited = valid(); inherited.policies[1].measurementWindowMs = 300000; delete inherited.policies[1].notApplicableReason; assert.match(validateCorrectnessBudgetPolicy(inherited, matrix).join('\n'), /finalizer-only tier/u)
  const first = bindBudgetPolicy({ run: 'a' }, { status: 'ok' }, policy); const changed = valid(); changed.policies[0].terminationGraceMs += 1; const second = bindBudgetPolicy({ run: 'a' }, { status: 'ok' }, changed)
  assert.equal(first.identity.budgetPolicyDigest, first.receipt.budgetPolicyDigest); assert.notEqual(first.identity.budgetPolicyDigest, second.identity.budgetPolicyDigest); assert.notEqual(correctnessBudgetPolicyDigest(policy), correctnessBudgetPolicyDigest(changed))
})
