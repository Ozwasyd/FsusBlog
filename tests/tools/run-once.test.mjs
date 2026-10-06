import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {verifyConsumerEvidenceFile} = await import(new URL('../../tools/test/check-physical-execution-consumer-evidence.mjs', import.meta.url));
const {currentProcessIdentity} = await import(new URL('../../tools/test/process-identity.mjs', import.meta.url));
const {buildRunBoundConsumerEvidence, runBoundExecution, runOnce, validateRunBoundConsumerEvidence, validateRunBoundProjection} = await import(new URL('../../tools/test/run-once.mjs', import.meta.url));
const {executionFailureDiagnostic, formatExecutionFailure, selectExecutionFailure} = await import(new URL('../../tools/test/execution-failure-diagnostic.mjs', import.meta.url));

for (const scenario of ['execution-only', 'finalization-only', 'both', 'cancel', 'incomplete-containment'])
{
    test(`run-bound failure receipt and CLI preserve ${scenario} diagnostics`, async (context) =>
    {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-bound-first-cause-'));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const physical = { exitCode: 7, cleanup: { status: scenario === 'incomplete-containment' ? 'unverifiable' : 'verified', childTerminal: { exitCode: 0 } } };
        const first = scenario === 'finalization-only' ? null : Object.assign(new Error('primary execution diagnostic'), {
            name: scenario === 'cancel' ? 'AbortError' : 'Error',
            exitCode: scenario === 'cancel' || scenario === 'incomplete-containment' ? null : 7,
            signal: scenario === 'cancel' ? 'SIGTERM' : null,
            physicalExecution: physical
        });
        const secondary = scenario === 'execution-only' ? null : new Error('correctness network observation is unavailable');
        let restored;
        await assert.rejects(runBoundExecution({
            root, runId: `first-cause-${scenario}`, key: 'matrix-governance', command: ['fixture'], cwd: root,
            inputDigest: 'input', environmentDigest: 'environment', outputContract: [], requiredOutputs: [],
            commit: 'a'.repeat(40), worktreeFingerprint: 'source', testIds: ['matrix-validate'], consumerId: 'validate-matrix'
        }, async () =>
        {
            throw selectExecutionFailure({ executionError: first, finalizationError: secondary, physicalExecution: physical });
        }), (error) =>
        {
            restored = error;
            return error.message === (first?.message ?? secondary.message);
        });
        const receiptDirectory = path.join(root, `first-cause-${scenario}`, 'receipts', 'matrix-governance');
        const receipt = JSON.parse(fs.readFileSync(path.join(receiptDirectory, fs.readdirSync(receiptDirectory).find((name) => name.endsWith('.json'))), 'utf8'));
        assert.equal(receipt.schema, 'fsusblog.physical-execution-receipt.v3');
        assert.equal(receipt.status, scenario === 'cancel' ? 'cancelled' : 'failure');
        assert.equal(receipt.physicalExecution.cleanup.childTerminal.exitCode, 0);
        assert.equal(receipt.failure.exitCode, first?.exitCode ?? null);
        assert.equal(receipt.failure.diagnostic.primary.exitCode, first?.exitCode ?? null);
        assert.equal(receipt.failure.diagnostic.secondary?.message ?? null, first ? secondary?.message ?? null : null);
        assert.deepEqual(executionFailureDiagnostic(restored), receipt.failure.diagnostic);
        assert.match(formatExecutionFailure(restored), /execution-failure-diagnostic/u);
    });
}

for (const causeCount of [1, 4])
{
    test(`cached run-bound failure retains ${causeCount} sealed causes through a second postflight refusal`, async (context) =>
    {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-bound-cached-first-cause-'));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const options = {
            root, runId: `cached-first-cause-${causeCount}`, key: 'matrix-governance', command: ['fixture'], cwd: root,
            inputDigest: 'input', environmentDigest: 'environment', outputContract: [], requiredOutputs: [],
            commit: 'a'.repeat(40), worktreeFingerprint: 'source', testIds: ['matrix-validate'], consumerId: 'validate-matrix'
        };
        const first = Object.assign(new Error('primary execution diagnostic'), { exitCode: 7 });
        let cause = first;
        for (let index = 0; index < causeCount; index += 1)
        {
            cause.cause = new Error(`sealed cause ${index}`);
            cause = cause.cause;
        }
        selectExecutionFailure({ executionError: first, finalizationError: new Error('original postflight refusal') });
        const original = executionFailureDiagnostic(first);
        let calls = 0;
        const operation = async () =>
        {
            calls += 1;
            throw first;
        };
        await assert.rejects(runBoundExecution(options, operation), /primary execution diagnostic/u);
        await assert.rejects(runBoundExecution(options, operation), (error) =>
        {
            assert.equal(error.cause, undefined);
            assert.deepEqual(executionFailureDiagnostic(error), original);
            const selected = selectExecutionFailure({ executionError: error, finalizationError: new Error('current postflight refusal') });
            const value = executionFailureDiagnostic(selected);
            assert.equal(selected, error);
            assert.equal(selected.exitCode, 7);
            assert.deepEqual(value.primary, original.primary);
            assert.deepEqual(value.secondary, original.secondary);
            assert.deepEqual(value.causes.slice(0, causeCount), original.causes);
            assert.equal(value.causes.length, Math.min(4, causeCount + 1));
            assert.equal(value.causesTruncated, causeCount === 4);
            if (causeCount < 4)
            {
                assert.equal(value.causes.at(-1).message, 'current postflight refusal');
            }
            assert.match(formatExecutionFailure(selected), /original postflight refusal/u);
            return true;
        });
        assert.equal(calls, 1);
    });
}

test('run-once immediately reclaims a lock whose recorded owner process is dead', async (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-once-dead-owner-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const namespace = 'dead-owner';
    const key = 'frontend-release-build';
    const namespaceDirectory = path.join(root, namespace);
    const lockDirectory = path.join(namespaceDirectory, `${key}.lock`);
    const output = path.join(root, 'dist', 'index.html');
    fs.mkdirSync(lockDirectory, { recursive: true });
    const staleIdentity = { ...currentProcessIdentity(), processStartIdentity: 'reused-process-start' };
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
    );

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
        async () =>
        {
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, '<main>current</main>\n');
        }
    );

    assert.equal(result.status, 'executed');
    assert.equal(fs.existsSync(lockDirectory), false);
    assert.equal(fs.readFileSync(output, 'utf8'), '<main>current</main>\n');
});

test('consumer evidence reopens and embeds the exact run-bound projection and receipt', async (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-bound-evidence-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const runId = 'evidence-run';
    const key = 'matrix-governance';
    const consumerId = 'validate-matrix';
    const output = path.join(root, 'outputs', 'test-plan.json');
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
        async () =>
        {
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, '{"status":"pass"}\n');
        }
    );

    const validatedProjection = await validateRunBoundProjection({
        root,
        runId,
        key,
        consumerId,
        projectionFile: result.projectionFile,
        receiptFile: result.receiptFile
    });
    const evidence = buildRunBoundConsumerEvidence({ validatedProjection });
    const physicalReceipt = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));

    assert.equal(validateRunBoundConsumerEvidence(evidence, { runId, key, consumerId }), true);
    assert.equal(evidence.schema, 'fsusblog.physical-execution-consumer-evidence.v2');
    assert.equal(path.resolve(root, evidence.sourceProjection), path.resolve(result.projectionFile));
    assert.equal(path.resolve(root, evidence.physicalExecutionReceipt), path.resolve(result.receiptFile));
    assert.equal(evidence.sourceProjection.startsWith('../'), false);
    assert.equal(evidence.physicalExecutionReceipt.startsWith('../'), false);
    assert.equal(evidence.physicalExecutionReceiptDocument.receiptDigest, evidence.physicalExecutionReceiptDigest);
    assert.deepEqual(evidence.sourceProjectionDocument.artifactEvidence, evidence.artifactEvidence);
    assert.equal(Object.hasOwn(physicalReceipt, 'ownerIdentityPolicy'), false);
    assert.equal(Object.hasOwn(physicalReceipt, 'lockLifecycleReceipt'), false);

    const evidenceFile = path.join(root, 'consumer-evidence.json');
    fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    assert.equal((await verifyConsumerEvidenceFile(evidenceFile, { root })).evidenceDigest, evidence.evidenceDigest);

    const tampered = structuredClone(evidence);
    tampered.physicalExecutionReceiptDocument.requiredOutputStates[0].digest = 'forged';
    assert.throws(
        () => validateRunBoundConsumerEvidence(tampered, { runId, key, consumerId }),
        /integrity validation failed/u
    );

    const escapedProjection = path.join(root, 'escaped-projection.json');
    fs.copyFileSync(result.projectionFile, escapedProjection);
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
    );

    fs.appendFileSync(result.projectionFile, ' ');
    await assert.rejects(
        verifyConsumerEvidenceFile(evidenceFile, { root }),
        /raw projection or receipt validation failed/u
    );
});

test('run-bound summaries exclude lock tombstones and temporal artifacts', async (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-bound-lock-tombstones-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const runId = 'lock-tombstone-summary';
    const key = 'shared-governance';
    const output = path.join(root, 'outputs', 'governance.json');
    const options = {
        root,
        runId,
        key,
        command: ['fixture', 'shared-governance'],
        cwd: root,
        inputDigest: 'input-digest',
        environmentDigest: 'environment-digest',
        outputContract: [output],
        requiredOutputs: [output],
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'worktree-digest',
        testIds: ['shared-governance']
    };
    const producer = await runBoundExecution(
        { ...options, consumerId: 'producer' },
        async () =>
        {
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, '{"status":"pass"}\n');
        }
    );

    const receiptDirectory = path.dirname(producer.receiptFile);
    for (const suffix of [
        'release-11111111-1111-4111-8111-111111111111',
        'reclaimed-22222222-2222-4222-8222-222222222222-33333333-3333-4333-8333-333333333333'
    ])
    {
        const tombstone = `${producer.receiptFile.slice(0, -'.json'.length)}.lock.${suffix}`;
        fs.mkdirSync(tombstone, { recursive: true });
        fs.writeFileSync(
            path.join(tombstone, 'owner-observation.json'),
            '{"schema":"fsusblog.run-once-lock-observation.v1"}\n'
        );
    }
    fs.writeFileSync(
        path.join(receiptDirectory, 'shared-governance-temporal-receipt.json'),
        '{"schema":"fsusblog.test-temporal-receipt.v1"}\n'
    );

    const consumer = await runBoundExecution(
        { ...options, consumerId: 'consumer' },
        async () => assert.fail('same-run consumer must not rerun the producer')
    );
    const summary = JSON.parse(
        fs.readFileSync(path.join(root, runId, 'summary.json'), 'utf8')
    );

    assert.equal(consumer.status, 'shared-current-run');
    assert.equal(path.dirname(consumer.receiptFile), receiptDirectory);
    assert.equal(summary.physicalExecutions, 1);
    assert.equal(summary.logicalConsumers, 2);
    assert.deepEqual(summary.producers.map((entry) => entry.key), [key]);
});
