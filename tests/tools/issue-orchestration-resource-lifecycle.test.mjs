import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const implementationPath = resolve(root, '.agents/skills/issue-orchestration/scripts/resource-lifecycle.mjs')
const readJson = (name) => JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'))
const cases = readJson('resource-lifecycle-cases.json')
const acceptance = readJson('resource-lifecycle-acceptance-map.json')
const expected = readJson('resource-lifecycle-expected-initial-failures.json')
const runtime = readJson('resource-lifecycle-runtime-probes.json')
const mutations = readJson('resource-lifecycle-mutation-controls.json')
const contract = readJson('resource-lifecycle-test-contract.json')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}
const digest = (value) => sha256(JSON.stringify(canonical(value)))

let implementationPromise
async function implementation() {
  assert.equal(existsSync(implementationPath), true, `missing #1828 resource lifecycle owner: ${implementationPath}`)
  implementationPromise ??= import(pathToFileURL(implementationPath).href)
  const loaded = await implementationPromise
  for (const name of ['createResourceRegistry', 'applyResourceEvent', 'verifyCleanupReceipt', 'recoverResourceRegistry']) {
    assert.equal(typeof loaded[name], 'function', `missing export ${name}`)
  }
  return loaded
}

function initialState(overrides = {}) {
  return {
    schema: 'issue-orchestration.resource-registry.v1',
    runId: 'run-1828',
    issueId: 'Ozwasyd/FsusBlog#1828',
    issueWorktreeId: 'worktree-1828',
    stageAttemptId: 'attempt-1828-1',
    stageRole: 'code-implementer',
    phase: 'implementing-self-testing',
    slotHeld: true,
    writeLease: { id: 'lease-1828-write', ownerAttemptId: 'attempt-1828-1', mode: 'write', state: 'active' },
    resources: [
      { resourceId: 'worktree-1828', resourceType: 'worktree', ownerRunId: 'run-1828', ownerAttemptId: 'attempt-1828-1', state: 'active' },
      { resourceId: 'service-1828', resourceType: 'processGroup', ownerRunId: 'run-1828', ownerAttemptId: 'attempt-1828-1', state: 'active' }
    ],
    selfTestCycles: [],
    firstFailureRefs: [],
    ...overrides
  }
}

async function apply(event, state = initialState()) {
  const loaded = await implementation()
  return loaded.applyResourceEvent(state, event)
}

test('frozen #1828 resource lifecycle identities are self-consistent', () => {
  assert.equal(contract.testOwnerId, 'test-owner-1828')
  assert.equal(contract.issueId, 'Ozwasyd/FsusBlog#1828')
  assert.equal(contract.baseSha, cases.baseSha)
  assert.deepEqual(contract.allowedTestPaths, [
    'tests/tools/issue-orchestration-resource-lifecycle.test.mjs',
    'tests/fixtures/issue-orchestration/resource-lifecycle-cases.json',
    'tests/fixtures/issue-orchestration/resource-lifecycle-acceptance-map.json',
    'tests/fixtures/issue-orchestration/resource-lifecycle-expected-initial-failures.json',
    'tests/fixtures/issue-orchestration/resource-lifecycle-runtime-probes.json',
    'tests/fixtures/issue-orchestration/resource-lifecycle-mutation-controls.json',
    'tests/fixtures/issue-orchestration/resource-lifecycle-test-contract.json'
  ])
  assert.deepEqual(acceptance.acceptance.flatMap(({ mutations: ids }) => ids).sort(), mutations.controls.map(({ id }) => id).sort())
  assert.deepEqual(expected.expectedFailingTests, acceptance.acceptance.map(({ id }) => id))
  for (const [relative, expectedHash] of Object.entries(contract.fileHashes)) {
    assert.equal(sha256(readFileSync(resolve(root, relative))), expectedHash, `${relative} drifted`)
  }
  assert.equal(digest(contract.fileHashes), contract.frozenTreeDigest)
  const unsigned = structuredClone(contract)
  delete unsigned.contractDigest
  delete unsigned.candidateIdentity
  assert.equal(digest(unsigned), contract.contractDigest)
  const files = contract.candidateIdentity.implementationFiles.map(({ path }) => {
    const absolute = resolve(root, path)
    return existsSync(absolute)
      ? { path, presence: 'present', sha256: sha256(readFileSync(absolute)), gitMode: statSync(absolute).mode & 0o111 ? '100755' : '100644' }
      : { path, presence: 'missing' }
  })
  assert.deepEqual(contract.candidateIdentity.implementationFiles, files)
  assert.equal(contract.candidateIdentity.candidateDigest, digest({
    baseSha: contract.baseSha,
    contractDigest: contract.contractDigest,
    implementationFiles: files
  }))
  assert.equal(runtime.oldBaseline.cleanupCompletionAuthority, 'event-payload-without-post-inventory')
})

test('recorded old baseline proves cleanup completion lacked machine post-inventory authority', () => {
  assert.deepEqual(runtime.oldBaseline, {
    observedBaseSha: cases.baseSha,
    observationDisposition: 'historical-pre-implementation-evidence',
    resourceLifecycleOwnerExists: false,
    cleanupCompletionAuthority: 'event-payload-without-post-inventory',
    eventLedgerPath: '.agents/skills/issue-orchestration/scripts/event-ledger.mjs',
    dispatchReceiptPath: '.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs',
    currentDoc: 'docs/development/issue-orchestration-scope.md',
    internalSelfTestLoopAlreadyDocumented: true,
    machineCleanupReceiptImplemented: false
  })
})

test('R01 repeated internal red cycles retain one attempt, worktree, slot, and write lease', async () => {
  const first = await apply({ type: 'self-test.failed', failureRef: 'failure-1' })
  const second = await apply({ type: 'self-test.failed', failureRef: 'failure-2' }, first)
  assert.equal(second.stageAttemptId, 'attempt-1828-1')
  assert.equal(second.issueWorktreeId, 'worktree-1828')
  assert.equal(second.slotHeld, true)
  assert.equal(second.writeLease.state, 'active')
  assert.equal(second.selfTestCycles.length, 2)
})

test('R02 ordinary red tests cannot trigger stage or issue cleanup', async () => {
  await assert.rejects(
    () => apply({ type: 'cleanup.started', reason: 'ordinary-test-failure' }),
    (error) => error?.code === 'internal-red-cleanup-forbidden'
  )
})

test('R03 candidate-green revokes implementer write and grants verifier read-only', async () => {
  const next = await apply({ type: 'candidate-green', candidateSha: 'a'.repeat(40) })
  assert.equal(next.writeLease.state, 'revoked')
  assert.deepEqual(next.readLease, { role: 'independent-verifier', mode: 'read-only', candidateSha: 'a'.repeat(40) })
})

test('R04 verifier rejection regrants exactly one writer on the same worktree', async () => {
  const verifying = initialState({
    phase: 'independent-verifying',
    writeLease: { id: 'lease-old', ownerAttemptId: 'attempt-1828-1', mode: 'write', state: 'revoked' },
    readLease: { role: 'independent-verifier', mode: 'read-only', candidateSha: 'a'.repeat(40) }
  })
  const next = await apply({ type: 'independent-verification.rejected', candidateSha: 'a'.repeat(40), nextWriteLeaseId: 'lease-rework' }, verifying)
  assert.equal(next.issueWorktreeId, 'worktree-1828')
  assert.equal(next.writeLease.id, 'lease-rework')
  assert.equal(next.readLease, null)
})

test('R05 retained test services keep one owner and descendants/ports remain collectible', async () => {
  const next = await apply({ type: 'self-test.service-replaced', resourceId: 'service-1828', descendants: [4102], ports: [41828] })
  assert.deepEqual(next.resources.find(({ resourceId }) => resourceId === 'service-1828')?.descendants, [4102])
  assert.deepEqual(next.resources.find(({ resourceId }) => resourceId === 'service-1828')?.ports, [41828])
})

test('R06 rebuilding worktree or creating a global attempt for each red cycle is rejected', async () => {
  await assert.rejects(
    () => apply({ type: 'self-test.failed', failureRef: 'failure-1', newAttemptId: 'attempt-1828-2', newWorktreeId: 'worktree-1828-2' }),
    (error) => error?.code === 'internal-red-attempt-rebuild-forbidden'
  )
})

test('R07 first-failure evidence survives later cycles and cleanup', async () => {
  const first = await apply({ type: 'self-test.failed', failureRef: 'first' })
  const second = await apply({ type: 'self-test.failed', failureRef: 'later' }, first)
  assert.deepEqual(second.firstFailureRefs, ['first'])
  const cleaned = await apply({ type: 'stage-cleanup.completed', receiptDigest: 'b'.repeat(64) }, second)
  assert.deepEqual(cleaned.firstFailureRefs, ['first'])
})

test('R08 dirty worktrees quarantine without force removal or stage advance', async () => {
  const next = await apply({ type: 'worktree.cleanup-requested', dirty: true, force: true })
  assert.equal(next.phase, 'quarantined-dirty')
  assert.equal(next.slotHeld, true)
  assert.equal(next.deliveryAuthorized, false)
})

test('R09 cleanup receipts require post inventory and machine verifier authority', async () => {
  const loaded = await implementation()
  assert.throws(
    () => loaded.verifyCleanupReceipt({ schema: 'issue-orchestration.resource-cleanup-receipt.v1', status: 'resources-clean', actorRole: 'code-implementer' }),
    (error) => error?.code === 'machine-cleanup-verifier-required'
  )
})

test('R10 group-retained resources survive member cleanup but not group completion', async () => {
  const loaded = await implementation()
  const registry = loaded.createResourceRegistry(cases.groupRegistry)
  const memberClean = loaded.applyResourceEvent(registry, { type: 'member-cleanup.completed', memberId: 'member-1' })
  assert.equal(memberClean.resources.find(({ resourceId }) => resourceId === 'group-worktree')?.state, 'retained')
  const groupClean = loaded.applyResourceEvent(memberClean, { type: 'group-cleanup.completed', postInventory: [] })
  assert.equal(groupClean.resources.find(({ resourceId }) => resourceId === 'group-worktree')?.state, 'removed-clean')
})

test('R11 crash recovery rejects orphan and external resource deletion', async () => {
  const loaded = await implementation()
  const recovered = loaded.recoverResourceRegistry(cases.crashRecovery)
  assert.equal(recovered.status, 'cleanup-failed')
  assert.ok(recovered.failedResources.some(({ reason }) => reason === 'unknown-owner'))
  assert.ok(recovered.retainedResources.some(({ ownerClass }) => ownerClass === 'externally-owned'))
})
