import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { atomicExecutionOptions, atomicFixture, atomicReference, rebindAtomicFixture } from './support/atomic-producer-fixture.mjs';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { executeWeightedStepDag, StepDagExecutionError, StepTerminalError } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const { compileAtomicProducerDag, verifyCompiledAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { AtomicProducerExecutionError, executeCompiledAtomicProducerDag, verifyAtomicTerminalVector } = await import(new URL('../../tools/test-matrix/atomic-producers/execution.mjs', import.meta.url));

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

test('global abort after a real child starts runs cleanup once and seals all terminal dispositions', { timeout: 10000 }, async () => withEvidence(async (directory) =>
{
    const marker = path.join(directory, 'started');
    const fixture = atomicFixture({ alphaScenario: 'marker-wait', startedMarker: marker });
    const controller = new AbortController();
    const original = new StepTerminalError('cancelled', 'explicit-cancel', 'ORIGINAL_PRIMARY');
    const secondary = new Error('CLEANUP_FAILURE');
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, { onCleanup: () =>
    {
        cleanupCount += 1;
        throw secondary;
    } });
    options.capacity.signal = controller.signal;
    // Attach rejection handling before waiting for the real process marker.
    const observed = executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options)
        .then(() => null, (error) => error);
    try
    {
        const deadline = Date.now() + 3000;
        while (!fs.existsSync(marker) && Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(fs.existsSync(marker), 'owned child started within three seconds');
    }
    finally
    {
        controller.abort(original);
    }
    const error = await observed;
    assert.ok(error instanceof AtomicProducerExecutionError);
    assert.equal(error.cause.cause, original);
    assert.ok(error.cause.errors.includes(original));
    assert.ok(error.cause.errors.includes(secondary));
    assert.equal(cleanupCount, 1);
    const vector = error.terminalVector;
    assert.equal(vector.receipts.length, 6);
    assert.ok(vector.receipts.every((receipt) => !['pending', 'running'].includes(receipt.terminalState)));
    assert.equal(byProducer(vector)['alpha-check'].terminalState, 'cancelled');
    assert.equal(byProducer(vector)['cleanup-inventory'].terminalState, 'failed');
    assert.equal(vector.interruption.message, 'ORIGINAL_PRIMARY');
    const attempt = JSON.parse(fs.readFileSync(byProducer(vector)['alpha-check'].attemptRef.path, 'utf8'));
    assert.equal(attempt.failureKind, 'runner-cancelled');
    assert.equal(attempt.attemptNumber, 1);
}));

test('returned failure refs without Error keep their typed primary cause ahead of cleanup errors', async () =>
{
    for (const terminalState of ['failed', 'timed-out', 'cancelled'])
    {
        const cleanup = new Error('CLEANUP_FAILURE');
        let cleanupCount = 0;
        const error = await executeWeightedStepDag([
            { id: 'primary', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
            { id: 'cleanup', dependsOn: ['primary'], alwaysRunFinalizer: true, finalizerPurpose: 'cleanup', resources: { coordinationOnly: true } }
        ], { maxParallel: 1, cpuUnits: 1, memoryGiB: 1 }, async (step) =>
        {
            if (step.id === 'primary')
            {
                return { terminalState, reasonCode: 'ORIGINAL_PRIMARY', primaryFailureRefs: ['primary'] };
            }
            cleanupCount += 1;
            throw cleanup;
        }).then(() => null, (failure) => failure);
        assert.ok(error instanceof StepDagExecutionError);
        assert.ok(error.cause instanceof StepTerminalError);
        assert.equal(error.cause.terminalState, terminalState);
        assert.equal(error.cause.reasonCode, 'ORIGINAL_PRIMARY');
        assert.deepEqual(error.cause.primaryFailureRefs, ['primary']);
        assert.equal(error.errors[1], cleanup);
        assert.equal(cleanupCount, 1);
        assert.deepEqual(error.states, { primary: terminalState, cleanup: 'failed' });
    }
});

test('assertion mismatch and timeout retain attempt failure causes when cleanup also fails', async () => withEvidence(async (directory) =>
{
    for (const scenario of ['product-failure', 'timeout'])
    {
        const fixture = atomicFixture({ alphaScenario: scenario });
        const secondary = new Error('CLEANUP_FAILURE');
        const options = atomicExecutionOptions(fixture, path.join(directory, scenario), { onCleanup: () =>
        {
            throw secondary;
        } });
        options.producerContexts['alpha-check'].timeoutMs = 100;
        const error = await executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options)
            .then(() => null, (failure) => failure);
        assert.ok(error instanceof AtomicProducerExecutionError);
        assert.equal(error.cause.cause.reasonCode, scenario === 'timeout' ? 'runner-timeout' : 'assertion-mismatch');
        assert.ok(error.cause.errors.includes(secondary));
        assert.equal(byProducer(error.terminalVector)['beta-check'].terminalState, 'success');
    }
}));

test('producer-only cancellation keeps the original Error when cleanup also fails', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'timeout' });
    const controller = new AbortController();
    const original = new StepTerminalError('cancelled', 'explicit-cancel', 'ORIGINAL_PRIMARY');
    const secondary = new Error('CLEANUP_FAILURE');
    const options = atomicExecutionOptions(fixture, directory, {
        signalByProducer: { 'alpha-check': controller.signal },
        onCleanup: () =>
        {
            throw secondary;
        }
    });
    controller.abort(original);
    const error = await executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options)
        .then(() => null, (failure) => failure);
    assert.equal(error.cause.cause, original);
    assert.ok(error.cause.errors.includes(secondary));
    assert.equal(byProducer(error.terminalVector)['beta-check'].terminalState, 'success');
}));

test('pre-aborted DAG performs finalization once with no fabricated attempt receipts', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture();
    const controller = new AbortController();
    const original = new Error('cancel before admission');
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, { onCleanup: () =>
    {
        cleanupCount += 1;
    } });
    options.capacity.signal = controller.signal;
    controller.abort(original);
    const error = await executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options)
        .then(() => null, (failure) => failure);
    assert.equal(error.cause.cause, original);
    assert.equal(cleanupCount, 1);
    assert.equal(error.terminalVector.receipts.length, 6);
    const physical = error.terminalVector.receipts.filter((receipt) => receipt.kind === 'atomic-producer');
    assert.ok(physical.every((receipt) => receipt.terminalState === 'cancelled' && receipt.attemptRef === null));
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

function failTerminalPublication(t, failure)
{
    const original = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) =>
    {
        if (typeof file === 'string' && path.basename(file) === 'terminal-vector.json')
        {
            throw failure;
        }
        return original(file, ...args);
    });
}

test('terminal publication failure retains the earlier producer failure as primary', async (t) => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'product-failure' });
    const publication = new Error('ordinary terminal output write failed');
    failTerminalPublication(t, publication);
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, { onCleanup: () =>
    {
        cleanupCount += 1;
    } });
    const error = await executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options)
        .then(() => null, (failure) => failure);
    assert.ok(error instanceof AtomicProducerExecutionError);
    assert.equal(error.cause.cause.reasonCode, 'assertion-mismatch');
    assert.equal(error.publicationError, publication);
    assert.equal(error.terminalVector.status, 'failed');
    assert.equal(error.terminalVector.receipts.length, 6);
    assert.equal(cleanupCount, 1);
}));

test('terminal publication failure retains the original cancellation Error object', async (t) => withEvidence(async (directory) =>
{
    const fixture = atomicFixture({ alphaScenario: 'timeout' });
    const original = new StepTerminalError('cancelled', 'explicit-cancel', 'original cancellation');
    const controller = new AbortController();
    controller.abort(original);
    const publication = new Error('ordinary terminal output write failed');
    failTerminalPublication(t, publication);
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, {
        signalByProducer: { 'alpha-check': controller.signal },
        onCleanup: () =>
        {
            cleanupCount += 1;
        }
    });
    const error = await executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options)
        .then(() => null, (failure) => failure);
    assert.ok(error instanceof AtomicProducerExecutionError);
    assert.equal(error.cause.cause, original);
    assert.equal(error.publicationError, publication);
    assert.equal(byProducer(error.terminalVector)['beta-check'].terminalState, 'success');
    assert.equal(cleanupCount, 1);
}));

test('terminal publication failure without an earlier execution failure rejects with the write Error', async (t) => withEvidence(async (directory) =>
{
    const fixture = atomicFixture();
    const publication = new Error('ordinary terminal output write failed');
    failTerminalPublication(t, publication);
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, { onCleanup: () =>
    {
        cleanupCount += 1;
    } });
    const error = await executeCompiledAtomicProducerDag(compileAtomicProducerDag(fixture.matrix, fixture.authorities), options)
        .then(() => null, (failure) => failure);
    assert.equal(error, publication);
    assert.equal(cleanupCount, 1);
}));

test('ordinary required input absence refuses before an attempt and releases the grant for a settled sibling', async () => withEvidence(async (directory) =>
{
    const fixture = atomicFixture();
    fixture.matrix.atomicProducerDeclarations.nodes.find((node) => node.producerId === 'beta-check').settledDependsOn = ['dependent-check'];
    rebindAtomicFixture(fixture);
    const compiled = compileAtomicProducerDag(fixture.matrix, fixture.authorities);
    const target = compiled.steps.find((step) => step.id === 'dependent-check');
    let original;
    let checks = 0;
    let cleanupCount = 0;
    const options = atomicExecutionOptions(fixture, directory, { onCleanup: () =>
    {
        cleanupCount += 1;
    } });
    options.capacity = { maxParallel: 1, cpuUnits: 1, memoryGiB: 1 };
    const runRoot = path.join(directory, options.context.schedulerRunId);
    options.producerContexts[target.id].requiredInputAdmission = {
        inputClosureRef: target.inputClosureRef,
        validate: (ready) =>
        {
            checks += 1;
            assert.deepEqual(ready.dependencyOutcomes, { 'alpha-check': 'success' });
            assert.equal(ready.runtimeCapacity.cpuUnits, 1);
            assert.equal(fs.existsSync(path.join(runRoot, target.id)), false);
            assert.equal(fs.existsSync(path.join(runRoot, 'alpha-check', 'attempt-1', 'receipt.json')), true);
            try
            {
                fs.readFileSync(path.join(directory, 'ordinary-required-input.json'));
            }
            catch (error)
            {
                original = error;
                throw error;
            }
        }
    };
    const error = await executeCompiledAtomicProducerDag(compiled, options).then(() => null, (failure) => failure);
    assert.ok(error instanceof AtomicProducerExecutionError);
    assert.equal(original.code, 'ENOENT');
    assert.equal(error.cause.cause, original);
    assert.equal(checks, 1);
    assert.equal(cleanupCount, 1);
    assert.equal(fs.existsSync(path.join(runRoot, target.id)), false);
    const receipts = byProducer(error.terminalVector);
    assert.equal(receipts[target.id].terminalState, 'failed');
    assert.equal(receipts[target.id].reasonCode, 'required-input-admission-failed');
    assert.equal(receipts[target.id].attemptRef, null);
    assert.equal(receipts['beta-check'].terminalState, 'success');
    const observation = JSON.parse(fs.readFileSync(receipts[target.id].evidenceRefs[0].path, 'utf8'));
    assert.equal(observation.receiptKind, 'required-input-admission-refused-before-attempt');
    assert.equal(observation.attemptAllocationCount, 0);
    assert.equal(observation.physicalSpawnCount, 0);
    assert.deepEqual(observation.inputClosureRef, target.inputClosureRef);
}));

test('ordinary required input validation runs after prerequisites and before exactly one unchanged attempt', async () => withEvidence(async (directory) =>
{
    const requiredFile = path.join(directory, 'ordinary-required-input.json');
    fs.writeFileSync(requiredFile, '{"required":true}');
    const fixture = atomicFixture();
    const compiled = compileAtomicProducerDag(fixture.matrix, fixture.authorities);
    const target = compiled.steps.find((step) => step.id === 'dependent-check');
    const options = atomicExecutionOptions(fixture, directory);
    const runRoot = path.join(directory, options.context.schedulerRunId);
    let checks = 0;
    options.producerContexts[target.id].requiredInputAdmission = {
        inputClosureRef: target.inputClosureRef,
        validate: async (ready) =>
        {
            checks += 1;
            assert.ok(Object.isFrozen(ready));
            assert.ok(Object.isFrozen(ready.command));
            assert.deepEqual(ready.dependencyOutcomes, { 'alpha-check': 'success' });
            assert.deepEqual(ready.command, target.command);
            assert.equal(ready.context.sourceCommit, options.context.sourceCommit);
            assert.ok(ready.runtimeCapacity.cpuUnits > 0);
            assert.equal(fs.existsSync(path.join(runRoot, target.id)), false);
            const prerequisite = JSON.parse(fs.readFileSync(path.join(runRoot, 'alpha-check', 'attempt-1', 'receipt.json'), 'utf8'));
            assert.equal(prerequisite.status, 'clean-success');
            await fs.promises.access(requiredFile, fs.constants.R_OK);
        }
    };
    const vector = await executeCompiledAtomicProducerDag(compiled, options);
    assert.equal(checks, 1);
    assert.equal(vector.status, 'success');
    const attempt = JSON.parse(fs.readFileSync(byProducer(vector)[target.id].attemptRef.path, 'utf8'));
    assert.equal(attempt.attemptNumber, 1);
    assert.equal(attempt.maxAttempts, 1);
    assert.deepEqual(attempt.command, target.command);
    assert.equal(fs.existsSync(path.join(runRoot, target.id, 'attempt-2')), false);
}));
