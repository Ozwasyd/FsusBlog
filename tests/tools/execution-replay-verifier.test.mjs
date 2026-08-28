import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    canonicalDigest,
    canonicalTestId,
    planExactShards,
    sealReplayPlan,
    sealReplayReceipt
} from '../../tools/test/execution-replay-contract.mjs'
import {
    buildExecutionReplayCommand,
    ExecutionReplayMismatch,
    verifyExecutionReplay
} from '../../tools/test/execution-replay-verifier.mjs'

const rootSeed = `seed256:${'77'.repeat(32)}`
const source = { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` }
const producer = { id: 'replay-test', framework: 'vitest' }
const run = { id: 'run-1', mode: 'qualification' }

function fixture(count = 4)
{
    const ids = Array.from({ length: count }, (_, index) => canonicalTestId({
        framework: 'vitest',
        source: 'tests/replay.test.ts',
        name: `case-${String(index).padStart(3, '0')}`
    }))
    const assignment = planExactShards({ testIds: ids, shardCount: 2 })
    const plan = sealReplayPlan({
        schema: 'fsusblog.test-execution-replay-plan.v1',
        source,
        producer,
        run,
        rootSeed,
        entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
        randomStreams: [],
        testEnumerationOrder: assignment.testEnumerationOrder,
        orderPolicy: { kind: 'canonical-utf8-bytewise', caseSensitivity: 'sensitive' },
        shards: assignment.shards,
        shardPolicy: assignment.shardPolicy,
        workers: { ids: ['worker-1', 'worker-2'], assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [
            { name: 'pool', value: 'forks' },
            { name: 'workers', value: '2' }
        ],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
        schedulerShuffleSeed: 'scheduler-seed-v1',
        command: {
            executable: process.execPath,
            args: ['--version'],
            environmentDigest: `sha256:${'c'.repeat(64)}`
        }
    })
    const shardByTest = new Map(plan.shards.flatMap((shard) => shard.testIds.map((id) => [id, shard.id])))
    const receipt = sealReplayReceipt({
        schema: 'fsusblog.test-execution-replay-receipt.v1',
        source,
        producer,
        run,
        planDigest: plan.planDigest,
        rootSeed,
        entropySources: plan.entropySources,
        randomStreams: [],
        testIds: plan.testEnumerationOrder,
        shards: plan.shards,
        workers: [
            { id: 'worker-1', testIds: plan.testEnumerationOrder.filter((_, index) => index % 2 === 0) },
            { id: 'worker-2', testIds: plan.testEnumerationOrder.filter((_, index) => index % 2 === 1) }
        ],
        admissionSequence: plan.testEnumerationOrder.map((testId, ordinal) => ({
            ordinal,
            testId,
            shardId: shardByTest.get(testId),
            workerId: `worker-${(ordinal % 2) + 1}`
        })),
        processOutcome: { status: 'passed', exitCode: 0, signal: null }
    })
    return { plan, receipt }
}

test('verifier exact compares plan, actual IDs, shards, workers and admission', () =>
{
    const { plan, receipt } = fixture()
    assert.deepEqual(verifyExecutionReplay({ plan, receipt }), {
        status: 'verified',
        planDigest: plan.planDigest,
        receiptDigest: receipt.receiptDigest,
        frameworkActualCount: 0,
        randomReceiptCount: 0,
        schedulerActual: false,
        warnings: 0
    })
})

test('planned 100/actual 99 and duplicate/extra actual tests fail closed', () =>
{
    const { plan, receipt } = fixture(100)
    const missing = structuredClone(receipt)
    missing.testIds.pop()
    assert.throws(() => verifyExecutionReplay({ plan, receipt: missing }), /receipt-tamper|test|worker/u)

    const duplicate = structuredClone(receipt)
    duplicate.testIds[99] = duplicate.testIds[0]
    assert.throws(() => verifyExecutionReplay({ plan, receipt: duplicate }), /duplicate|tamper/u)

    const extra = structuredClone(receipt)
    extra.testIds.push(canonicalTestId({ framework: 'vitest', source: 'tests/replay.test.ts', name: 'extra' }))
    assert.throws(() => verifyExecutionReplay({ plan, receipt: extra }), /tamper|worker|admission|shard-membership/u)
})

test('shard, worker, admission, seed and cross-source drift fail closed', () =>
{
    const { plan, receipt } = fixture()
    for (const mutate of [
        (copy) => copy.shards[0].testIds.reverse(),
        (copy) => { copy.workers[0].id = 'worker-drift' },
        (copy) => copy.admissionSequence.reverse(),
        (copy) => { copy.rootSeed = `seed256:${'88'.repeat(32)}` },
        (copy) => { copy.source.commit = 'd'.repeat(40) }
    ])
    {
        const changed = structuredClone(receipt)
        mutate(changed)
        assert.throws(() => verifyExecutionReplay({ plan, receipt: changed }))
    }
})

test('first divergence points at framework plan/source/test drift', () =>
{
    const { plan, receipt } = fixture()
    const frameworkActual = {
        planDigest: plan.planDigest,
        producerId: plan.producer.id,
        sourceCommit: plan.source.commit,
        worktreeFingerprint: plan.source.worktreeFingerprint,
        actualTestIds: plan.testEnumerationOrder.slice(0, -1),
        evidenceClass: 'correctness',
        qualificationEligible: true,
        contentDigest: null
    }
    frameworkActual.contentDigest = canonicalDigest({ ...frameworkActual, contentDigest: null })
    assert.throws(
        () => verifyExecutionReplay({ plan, receipt, frameworkActuals: [frameworkActual] }),
        (error) => error instanceof ExecutionReplayMismatch
            && error.pointer === '$.frameworkActuals/0/actualTestIds'
    )
})

test('diagnostic evidence cannot be promoted to qualification', () =>
{
    const { plan, receipt } = fixture()
    const diagnosticPlan = structuredClone(plan)
    diagnosticPlan.run.mode = 'diagnostic'
    assert.throws(() => verifyExecutionReplay({ plan: diagnosticPlan, receipt }), /plan-tamper|qualification/u)
})

test('replay command binds owned absolute plan, digest, seed, shard, workers, scheduler and envelope without secrets', () =>
{
    const { plan } = fixture()
    const directory = mkdtempSync(path.join(new URL('../..', import.meta.url).pathname, '.tmp-replay-command-'))
    try
    {
        const planPath = path.join(directory, "plan with ' quote.json")
        writeFileSync(planPath, `${JSON.stringify(plan)}\n`)
        const command = buildExecutionReplayCommand({
            root: new URL('../..', import.meta.url).pathname,
            planPath,
            plan,
            schedulerShuffleSeed: plan.schedulerShuffleSeed,
            executionEnvelopeRef: `sha256:${'e'.repeat(64)}`
        })
        for (const required of [
            planPath,
            plan.planDigest,
            plan.rootSeed,
            plan.shardDigest,
            plan.workers.ids.join(','),
            'sealed-shard-order',
            plan.schedulerShuffleSeed,
            `sha256:${'e'.repeat(64)}`
        ])
        {
            assert.equal(command.argv.includes(required), true, required)
        }
        assert.match(command.posix, /'"'"'/u)
        assert.match(command.powershell, /''/u)
        assert.doesNotMatch(command.posix, /password=/iu)
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('plaintext secret args and plan paths outside repository are rejected', () =>
{
    const { plan } = fixture()
    const secretPlan = structuredClone(plan)
    secretPlan.command.args = ['--token=plaintext']
    secretPlan.command.digest = canonicalDigest({
        executable: secretPlan.command.executable,
        args: secretPlan.command.args,
        environmentDigest: secretPlan.command.environmentDigest
    })
    secretPlan.planDigest = canonicalDigest(Object.fromEntries(Object.entries(secretPlan).filter(([key]) => key !== 'planDigest')))
    assert.throws(() => buildExecutionReplayCommand({
        root: new URL('../..', import.meta.url).pathname,
        planPath: new URL('../../.tmp/secret-plan.json', import.meta.url).pathname,
        plan: secretPlan,
        schedulerShuffleSeed: secretPlan.schedulerShuffleSeed,
        executionEnvelopeRef: `sha256:${'e'.repeat(64)}`
    }), /\$\.plan\.command\.args/u)
    assert.throws(() => buildExecutionReplayCommand({
        root: new URL('../..', import.meta.url).pathname,
        planPath: path.join(os.tmpdir(), 'outside-plan.json'),
        plan,
        schedulerShuffleSeed: plan.schedulerShuffleSeed,
        executionEnvelopeRef: `sha256:${'e'.repeat(64)}`
    }), /repository-owned/u)
})
