import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestCanonical, sealContentDigest, sha256 } from '../../tools/test/attempt-provenance.mjs';
import { compileAtomicProducerDag, verifyCompiledAtomicProducerDag } from '../../tools/test-matrix/atomic-producers/compiler.mjs';
import { AtomicProducerExecutionError, executeCompiledAtomicProducerDag, verifyAtomicTerminalVector } from '../../tools/test-matrix/atomic-producers/execution.mjs';

import { atomicExecutionOptions, atomicFixture, atomicReference, rebindAtomicFixture } from './support/atomic-producer-fixture.mjs';

async function withEvidence(run)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-producer-controls-'));
    try
    {
        return await run(directory);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function byProducer(vector)
{
    return Object.fromEntries(vector.receipts.map((receipt) => [receipt.producerId, receipt]));
}

async function failureVector(promise)
{
    let failure;
    await assert.rejects(promise, (error) =>
    {
        assert.ok(error instanceof AtomicProducerExecutionError);
        failure = error;
        return true;
    });
    return failure.terminalVector;
}

test('compiler gives direct Fresh resume and CI consumers the same immutable DAG identity', () =>
{
    const fixture = atomicFixture();
    const outputs = ['direct', 'fresh', 'resume', 'ci'].map(() => compileAtomicProducerDag(fixture.matrix, fixture.authorities));
    assert.equal(new Set(outputs.map((output) => output.contentDigest)).size, 1);
    assert.ok(Object.isFrozen(outputs[0].steps[0].resources));
    assert.throws(() =>
    {
        outputs[0].steps[0].command.push('extra');
    }, TypeError);
    assert.ok(outputs[0].steps.filter((step) => step.runAfterSettled || step.alwaysRunFinalizer).every((step) => step.command === undefined));
    assert.equal(outputs[0].qualificationEligible, false);
});

test('compiler rejects tampered and independently resealed commands before execution', () =>
{
    const fixture = atomicFixture();
    const compiled = structuredClone(compileAtomicProducerDag(fixture.matrix, fixture.authorities));
    compiled.steps.find((step) => step.id === 'alpha-check').command.push('second-command');
    assert.throws(() => verifyCompiledAtomicProducerDag(compiled, fixture.matrix, fixture.authorities), /differs/u);
    const { contentDigest, ...body } = compiled;
    assert.equal(typeof contentDigest, 'string');
    assert.throws(() => verifyCompiledAtomicProducerDag(sealContentDigest(body), fixture.matrix, fixture.authorities), /differs/u);
});

test('real first attempts succeed once while parent and join project without spawning', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture();
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, { onCleanup: () =>
    {
        cleanupCount += 1;
    } });
    const compiled = compileAtomicProducerDag(fixture.matrix, fixture.authorities);
    const vector = await executeCompiledAtomicProducerDag(compiled, options);
    assert.equal(vector.status, 'success');
    assert.equal(cleanupCount, 1);
    const receipts = byProducer(vector);
    for (const id of ['alpha-check', 'beta-check', 'dependent-check'])
    {
        const attempt = JSON.parse(fs.readFileSync(receipts[id].attemptRef.path, 'utf8'));
        assert.equal(attempt.attemptNumber, 1);
        assert.equal(attempt.maxAttempts, 1);
        assert.equal(attempt.status, 'clean-success');
        assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(receipts[id].attemptRef.path)), 'attempt-2')), false);
        const replay = fixture.authorities.replayPlans.find((material) => material.plan.producer.id === id).plan;
        assert.equal(attempt.replayPlanDigest, compiled.steps.find((step) => step.id === id).replayPlanRef.contentDigest);
        assert.notEqual(attempt.replayPlanDigest, replay.planDigest);
        assert.deepEqual(attempt.executedTestIds, replay.testEnumerationOrder);
        assert.ok(receipts[id].artifactRefs.length >= 3);
        for (const artifact of receipts[id].artifactRefs)
        {
            assert.match(artifact.contentDigest, /^sha256:[a-f0-9]{64}$/u);
            assert.equal(artifact.contentDigest, sha256(fs.readFileSync(artifact.path)));
        }
    }
    for (const id of ['settled-observer', 'fixture-summary', 'cleanup-inventory'])
    {
        assert.equal(receipts[id].attemptRef, null);
        assert.equal(fs.existsSync(path.join(directory, options.context.schedulerRunId, id)), false);
        assert.ok(fs.existsSync(receipts[id].evidenceRefs[0].path));
    }
}));

test('failed alpha does not terminate independent beta and hard dependent is blocked with zero spawn', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'product-failure' });
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, { onCleanup: () =>
    {
        cleanupCount += 1;
    } });
    const vector = await failureVector(executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options));
    const receipts = byProducer(vector);
    assert.equal(receipts['alpha-check'].terminalState, 'failed');
    assert.equal(receipts['beta-check'].terminalState, 'success');
    assert.equal(receipts['dependent-check'].terminalState, 'blocked');
    assert.deepEqual(receipts['dependent-check'].blockedBy, ['alpha-check']);
    assert.equal(receipts['dependent-check'].attemptRef, null);
    assert.equal(fs.existsSync(path.join(directory, options.context.schedulerRunId, 'dependent-check')), false);
    assert.equal(cleanupCount, 1);
    const join = JSON.parse(fs.readFileSync(receipts['settled-observer'].evidenceRefs[0].path, 'utf8'));
    assert.deepEqual(join.dependencies.map((dependency) => [dependency.id, dependency.outcome]), [['alpha-check', 'failed'], ['beta-check', 'success']]);
    assert.equal(join.reasonCode, 'dependency-terminal-failure');
    assert.equal(vector.status, 'failed');
    assert.equal(vector.qualificationEligible, false);
}));

test('failed producer releases its sole CPU and memory grant so independent work completes', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'product-failure' });
    const options = atomicExecutionOptions(fixture, directory);
    options.capacity = { maxParallel: 1, cpuUnits: 1, memoryGiB: 1 };
    const vector = await failureVector(executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options));
    assert.equal(byProducer(vector)['beta-check'].terminalState, 'success');
    assert.equal(byProducer(vector)['cleanup-inventory'].terminalState, 'success');
}));

test('timeout retains the first failed attempt and still runs cleanup and independent sibling', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'timeout' });
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, { onCleanup: () =>
    {
        cleanupCount += 1;
    } });
    options.producerContexts['alpha-check'].timeoutMs = 100;
    const vector = await failureVector(executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options));
    const receipts = byProducer(vector);
    const attempt = JSON.parse(fs.readFileSync(receipts['alpha-check'].attemptRef.path, 'utf8'));
    assert.equal(receipts['alpha-check'].terminalState, 'timed-out');
    assert.equal(attempt.status, 'failed-no-retry');
    assert.equal(attempt.failureKind, 'runner-timeout');
    assert.equal(receipts['beta-check'].terminalState, 'success');
    assert.equal(cleanupCount, 1);
}));

test('per-producer cancellation preserves terminal evidence and cleanup without cancelling sibling', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'timeout' });
    const controller = new AbortController();
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, {
        signalByProducer: { 'alpha-check': controller.signal },
        onCleanup: () =>
        {
            cleanupCount += 1;
        }
    });
    controller.abort(new Error('isolated cancellation'));
    const vector = await failureVector(executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options));
    const receipts = byProducer(vector);
    assert.equal(receipts['alpha-check'].terminalState, 'cancelled');
    assert.equal(receipts['beta-check'].terminalState, 'success');
    assert.equal(receipts['dependent-check'].terminalState, 'blocked');
    assert.equal(cleanupCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(receipts['alpha-check'].attemptRef.path, 'utf8')).failureKind, 'runner-cancelled');
}));

test('source rejects two executable authorities inside a producer and commands on finalizers', () =>
{
    const fixture = atomicFixture();
    const { contentDigest, ...source } = fixture.authorities.commandSources[0];
    assert.equal(typeof contentDigest, 'string');
    fixture.authorities.commandSources[0] = sealContentDigest({ ...source, executableAuthorityCount: 2 });
    const reference = atomicReference(fixture.authorities.commandSources[0]);
    fixture.matrix.atomicProducerDeclarations.nodes[0].commandSourceRef = reference;
    fixture.authorities.physicalOwnership[0].commandSourceRef = reference;
    rebindAtomicFixture(fixture);
    assert.throws(() => compileAtomicProducerDag(fixture.matrix, fixture.authorities), /standalone executable/u);
    const finalizer = atomicFixture();
    finalizer.matrix.atomicProducerDeclarations.nodes.at(-1).command = ['node', 'test-command'];
    rebindAtomicFixture(finalizer);
    assert.throws(() => compileAtomicProducerDag(finalizer.matrix, finalizer.authorities), /schema/u);
});

test('missing or changed external replay authority fails before any producer is spawned', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture();
    const compiled = compileAtomicProducerDag(fixture.matrix, fixture.authorities);
    const options = atomicExecutionOptions(fixture, directory);
    options.producerContexts['alpha-check'].authorityReferences.find((reference) => reference.kind === 'replay-plan').artifactDigest = digestCanonical('different-plan');
    await assert.rejects(executeCompiledAtomicProducerDag(compiled, options), /replay plan reference differs/u);
    assert.deepEqual(fs.readdirSync(directory), []);
    delete options.producerContexts['alpha-check'];
    await assert.rejects(executeCompiledAtomicProducerDag(compiled, options), /externally verified producer context/u);
    assert.deepEqual(fs.readdirSync(directory), []);
}));

test('same-run reentry cannot create a second attempt or overwrite first failure evidence', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'product-failure' });
    const compiled = compileAtomicProducerDag(fixture.matrix, fixture.authorities);
    const options = atomicExecutionOptions(fixture, directory);
    const vector = await failureVector(executeCompiledAtomicProducerDag(compiled, options));
    const receiptFile = byProducer(vector)['alpha-check'].attemptRef.path;
    const before = fs.readFileSync(receiptFile);
    await assert.rejects(executeCompiledAtomicProducerDag(compiled, options), /EEXIST/u);
    assert.deepEqual(fs.readFileSync(receiptFile), before);
    assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(receiptFile)), 'attempt-2')), false);
}));

test('terminal vector tamper and resealed blocked-as-success substitutions are refused', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'product-failure' });
    const vector = await failureVector(executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), atomicExecutionOptions(fixture, directory)));
    assert.equal(verifyAtomicTerminalVector(vector, vector), true);
    const tampered = structuredClone(vector);
    tampered.receipts.find((receipt) => receipt.producerId === 'dependent-check').terminalState = 'success';
    assert.throws(() => verifyAtomicTerminalVector(tampered, vector), /mismatch/u);
    const { contentDigest, ...body } = tampered;
    assert.equal(typeof contentDigest, 'string');
    assert.throws(() => verifyAtomicTerminalVector(sealContentDigest(body), vector), /expected identity/u);
}));

test('global interrupt refuses before spawn while the shared pending-finalizer capability is missing', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture();
    const options = atomicExecutionOptions(fixture, directory);
    options.capacity.signal = new AbortController().signal;
    await assert.rejects(executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options), /global-interrupt finalizer capability/u);
    assert.deepEqual(fs.readdirSync(directory), []);
}));

test('attempt runner exception records internal error and releases grants while sibling and cleanup complete', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture();
    const options = atomicExecutionOptions(fixture, directory);
    options.capacity = { maxParallel: 1, cpuUnits: 1, memoryGiB: 1 };
    const original = options.producerContexts['alpha-check'].verifyAuthority;
    let verificationCalls = 0;
    options.producerContexts['alpha-check'].verifyAuthority = (reference) =>
    {
        verificationCalls += 1;
        if (verificationCalls > 3)
        {
            throw new Error('isolated external owner disappeared after preflight');
        }
        return original(reference);
    };
    const vector = await failureVector(executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options));
    const receipts = byProducer(vector);
    assert.equal(receipts['alpha-check'].terminalState, 'internal-error');
    assert.equal(receipts['alpha-check'].attemptRef, null);
    assert.equal(receipts['beta-check'].terminalState, 'success');
    assert.equal(receipts['dependent-check'].terminalState, 'blocked');
    assert.equal(receipts['cleanup-inventory'].terminalState, 'success');
    const evidence = JSON.parse(fs.readFileSync(receipts['alpha-check'].evidenceRefs[0].path, 'utf8'));
    assert.equal(evidence.receiptKind, 'adapter-failure-without-verified-attempt');
    assert.match(evidence.reason, /owner disappeared/u);
}));

test('cross-run replay environment and finalizer capability drift refuse before spawn', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture();
    const compiled = compileAtomicProducerDag(fixture.matrix, fixture.authorities);
    const environment = atomicExecutionOptions(fixture, directory);
    environment.producerContexts['alpha-check'].env = { PATH: 'different-toolchain-path' };
    await assert.rejects(executeCompiledAtomicProducerDag(compiled, environment), /source\/run\/environment/u);
    const operation = atomicExecutionOptions(fixture, directory);
    operation.finalizerOperations['isolated-cleanup'].contentDigest = digestCanonical('foreign-operation');
    await assert.rejects(executeCompiledAtomicProducerDag(compiled, operation), /missing finalizer capability/u);
    assert.deepEqual(fs.readdirSync(directory), []);
}));

test('exit-zero command without a sidecar retains the real shared runner refusal', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'no-sidecar' });
    const vector = await failureVector(executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), atomicExecutionOptions(fixture, directory)));
    const receipts = byProducer(vector);
    const attempt = JSON.parse(fs.readFileSync(receipts['alpha-check'].attemptRef.path, 'utf8'));
    assert.equal(attempt.exitCode, 0);
    assert.equal(attempt.status, 'failed-no-retry');
    assert.equal(attempt.failureKind, 'invalid-success-result-sidecar');
    assert.equal(receipts['alpha-check'].terminalState, 'failed');
    assert.equal(receipts['beta-check'].terminalState, 'success');
}));
