import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { verifyConsumerEvidenceFile } from '../../tools/test/check-physical-execution-consumer-evidence.mjs'
import { currentProcessIdentity } from '../../tools/test/process-identity.mjs'
import {
    buildRunBoundConsumerEvidence,
    runBoundExecution,
    runOnce,
    validateRunBoundConsumerEvidence,
    validateRunBoundProjection
} from '../../tools/test/run-once.mjs'

test('run-once immediately reclaims a lock whose recorded owner process is dead', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-once-dead-owner-'))
    context.after(() => fs.rmSync(root, { recursive: true, force: true }))

    const namespace = 'dead-owner'
    const key = 'frontend-release-build'
    const namespaceDirectory = path.join(root, namespace)
    const lockDirectory = path.join(namespaceDirectory, `${key}.lock`)
    const output = path.join(root, 'dist', 'index.html')
    fs.mkdirSync(lockDirectory, { recursive: true })
    const staleIdentity = { ...currentProcessIdentity(), processStartIdentity: 'reused-process-start' }
    fs.writeFileSync(
        path.join(lockDirectory, 'owner.json'),
        `${JSON.stringify({
            ...staleIdentity,
            schema: 'fsusblog.run-once-lock-owner.v3',
            ownerToken: 'interrupted-producer',
            schedulerRunId: null,
            namespace,
            executionKey: key,
            heartbeatEveryMs: 10,
            unverifiableGraceMs: 15 * 60 * 1000,
            staleAfterMs: 15 * 60 * 1000,
            createdAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString()
        })}\n`,
        { mode: 0o600 }
    )

    const result = await runOnce(
        {
            root,
            namespace,
            key,
            fingerprint: 'current-source',
            requiredOutputs: [output],
            lockTimeoutMs: 50,
            staleLockMs: 15 * 60 * 1000,
            heartbeatMs: 10
        },
        async () => {
            fs.mkdirSync(path.dirname(output), { recursive: true })
            fs.writeFileSync(output, '<main>current</main>\n')
        }
    )

    assert.equal(result.status, 'executed')
    assert.equal(fs.existsSync(lockDirectory), false)
    assert.equal(fs.readFileSync(output, 'utf8'), '<main>current</main>\n')
})

test('consumer evidence reopens and embeds the exact run-bound projection and receipt', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-bound-evidence-'))
    context.after(() => fs.rmSync(root, { recursive: true, force: true }))

    const runId = 'evidence-run'
    const key = 'matrix-governance'
    const consumerId = 'validate-matrix'
    const output = path.join(root, 'outputs', 'test-plan.json')
    const result = await runBoundExecution(
        {
            root,
            runId,
            key,
            command: ['fixture', 'matrix-governance'],
            cwd: root,
            inputDigest: 'input-digest',
            environmentDigest: 'environment-digest',
            outputContract: [output],
            requiredOutputs: [output],
            commit: 'a'.repeat(40),
            worktreeFingerprint: 'worktree-digest',
            testIds: ['matrix-evidence-plan', 'matrix-validate'],
            consumerId
        },
        async () => {
            fs.mkdirSync(path.dirname(output), { recursive: true })
            fs.writeFileSync(output, '{"status":"pass"}\n')
        }
    )

    const validatedProjection = await validateRunBoundProjection({
        root,
        runId,
        key,
        consumerId,
        projectionFile: result.projectionFile,
        receiptFile: result.receiptFile
    })
    const evidence = buildRunBoundConsumerEvidence({ validatedProjection })
    const physicalReceipt = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'))

    assert.equal(validateRunBoundConsumerEvidence(evidence, { runId, key, consumerId }), true)
    assert.equal(evidence.schema, 'fsusblog.physical-execution-consumer-evidence.v2')
    assert.equal(evidence.physicalExecutionReceiptDocument.receiptDigest, evidence.physicalExecutionReceiptDigest)
    assert.deepEqual(evidence.sourceProjectionDocument.artifactEvidence, evidence.artifactEvidence)
    assert.equal(Object.hasOwn(physicalReceipt, 'ownerIdentityPolicy'), false)
    assert.equal(Object.hasOwn(physicalReceipt, 'lockLifecycleReceipt'), false)

    const evidenceFile = path.join(root, 'consumer-evidence.json')
    fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    assert.equal((await verifyConsumerEvidenceFile(evidenceFile, { root })).evidenceDigest, evidence.evidenceDigest)

    const tampered = structuredClone(evidence)
    tampered.physicalExecutionReceiptDocument.requiredOutputStates[0].digest = 'forged'
    assert.throws(
        () => validateRunBoundConsumerEvidence(tampered, { runId, key, consumerId }),
        /integrity validation failed/u
    )

    const escapedProjection = path.join(root, 'escaped-projection.json')
    fs.copyFileSync(result.projectionFile, escapedProjection)
    await assert.rejects(
        validateRunBoundProjection({
            root,
            runId,
            key,
            consumerId,
            projectionFile: escapedProjection,
            receiptFile: result.receiptFile
        }),
        /outside its run-bound directory/u
    )

    fs.appendFileSync(result.projectionFile, ' ')
    await assert.rejects(
        verifyConsumerEvidenceFile(evidenceFile, { root }),
        /raw projection or receipt validation failed/u
    )
})
