import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { backendCompilerFixture } from './support/backend-atomic-compiler-fixture.mjs';

const { BackendAtomicExecutionError, compileBackendAtomicBridge, executeBackendAtomicBridge } = await import(new URL('../../tools/test/backend-atomic-bridge.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));

async function fixture(run, settings)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-compiler-bridge-'));
    try
    {
        await run(backendCompilerFixture(directory, settings), directory);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

for (const failures of [[], ['backend-source-file-size'], ['backend-test-governance'], ['backend-source-file-size', 'backend-test-governance']])
{
    test(`canonical governance compiler/attempt execution retains all siblings: ${JSON.stringify(failures)}`, async () => fixture(async ({ input, options }, directory) =>
    {
        const binding = compileBackendAtomicBridge(input);
        options.expectedBindingDigest = binding.contentDigest;
        let result;
        try
        {
            result = await executeBackendAtomicBridge(binding, input, options);
        }
        catch (error)
        {
            assert.ok(error instanceof BackendAtomicExecutionError);
            result = error.result;
        }
        assert.equal(result.exitCode, failures.length ? 1 : 0);
        assert.equal(result.terminalVector.receipts.length, 4);
        assert.equal(result.projections[0].statusVector.length, 3);
        assert.equal(result.qualificationEligible, false);
        for (const entry of input.plans[0].declarations.filter((node) => node.kind === 'atomic-producer'))
        {
            const producerDirectory = path.join(directory, options.context.schedulerRunId, entry.producerId);
            assert.deepEqual(fs.readdirSync(producerDirectory).filter((name) => name.startsWith('attempt-')), ['attempt-1']);
        }
        assert.deepEqual(result.projections[0].statusVector.filter((node) => node.terminalState !== 'clean-success').map((node) => node.producerId).sort(), failures);
    }, { failures }));
}

for (const [label, failures, expected] of [
    ['clean', [], []], ['governance', ['backend-test-governance'], ['governance']],
    ['native', ['backend-perf-native-p99'], ['product-performance']],
    ['readiness', ['backend-perf-readiness'], ['build-readiness']],
    ['independent native and readiness', ['backend-perf-native-p99', 'backend-perf-readiness'], ['build-readiness', 'product-performance']],
    ['Release build blocking', ['backend-release-test-build'], ['blocked']]
])
{
    test(`canonical perf compiler/attempt execution classifies ${label}`, async () => fixture(async ({ input, options }) =>
    {
        const binding = compileBackendAtomicBridge(input);
        options.expectedBindingDigest = binding.contentDigest;
        let result;
        try
        {
            result = await executeBackendAtomicBridge(binding, input, options);
        }
        catch (error)
        {
            assert.ok(error instanceof BackendAtomicExecutionError);
            result = error.result;
        }
        assert.equal(result.exitCode, failures.length ? 1 : 0);
        assert.equal(result.terminalVector.receipts.length, 10);
        assert.deepEqual(result.projectionFailures, []);
        const summary = result.projections.find((entry) => entry.producerId === 'backend-perf-summary');
        assert.deepEqual(summary.statusVector.map((entry) => entry.failureDomain).filter(Boolean).sort(), expected);
    }, { perf: true, failures }));
}

test('raw exit zero without a result sidecar preserves the runner refusal', async () => fixture(async ({ input, options }) =>
{
    const binding = compileBackendAtomicBridge(input);
    options.expectedBindingDigest = binding.contentDigest;
    await assert.rejects(executeBackendAtomicBridge(binding, input, options), (error) =>
    {
        const receipt = error.result.terminalVector.receipts.find((entry) => entry.producerId === 'backend-source-file-size');
        assert.equal(receipt.reasonCode, 'invalid-success-result-sidecar');
        assert.equal(error.result.exitCode, 1);
        assert.equal(error.result.projections[0].exitCode, 1);
        return true;
    });
}, { missingSidecar: 'backend-source-file-size' }));

test('resealed compiler binding, profile and readiness environment drift refuse before any attempt', async () => fixture(async ({ input, options }, directory) =>
{
    const binding = compileBackendAtomicBridge(input);
    options.expectedBindingDigest = binding.contentDigest;
    const altered = sealContentDigest({ ...binding, qualificationEligible: true });
    await assert.rejects(executeBackendAtomicBridge(altered, input, options), /compiler binding mismatch/u);
    await assert.rejects(executeBackendAtomicBridge(binding, input, { ...options, profile: 'other' }), /profile mismatch/u);
    const old = options.producerContexts['backend-perf-readiness'].env.FSUSBLOG_BACKEND_PERF_READINESS_MODE;
    options.producerContexts['backend-perf-readiness'].env.FSUSBLOG_BACKEND_PERF_READINESS_MODE = 'verify-fresh';
    await assert.rejects(executeBackendAtomicBridge(binding, input, options), /readiness environment/u);
    options.producerContexts['backend-perf-readiness'].env.FSUSBLOG_BACKEND_PERF_READINESS_MODE = old;
    assert.equal(fs.existsSync(path.join(directory, options.context.schedulerRunId)), false);
}, { perf: true }));

test('command-free parent and duplicated child remain canonical refusals', async () => fixture(async ({ input }) =>
{
    input.matrix.tiers[0].command = 'old sequential governance';
    input.authorities.matrixDigest = digestCanonical(input.matrix);
    assert.throws(() => compileBackendAtomicBridge(input), /command-free/u);
    delete input.matrix.tiers[0].command;
    input.matrix.atomicProducerDeclarations.nodes.push(input.matrix.atomicProducerDeclarations.nodes[0]);
    input.authorities.matrixDigest = digestCanonical(input.matrix);
    assert.throws(() => compileBackendAtomicBridge(input), /duplicate producer/u);
}));

test('global cancellation preserves every canonical terminal without inventing attempts', async () => fixture(async ({ input, options }, directory) =>
{
    const binding = compileBackendAtomicBridge(input);
    const controller = new AbortController();
    controller.abort(new Error('owned fixture interrupt'));
    options.expectedBindingDigest = binding.contentDigest;
    options.capacity.signal = controller.signal;
    await assert.rejects(executeBackendAtomicBridge(binding, input, options), (error) =>
    {
        assert.equal(error.result.terminalVector.receipts.length, 4);
        assert.equal(error.result.exitCode, 1);
        assert.ok(error.result.projectionFailures.length);
        return true;
    });
    assert.equal(fs.existsSync(path.join(directory, options.context.schedulerRunId, 'backend-source-file-size')), false);
}));

test('immutable compiler vector and attempt log readback reject tampering without rerunning', async () => fixture(async ({ input, options }, directory) =>
{
    const { verifyBackendAtomicExecution } = await import(new URL('../../tools/test/backend-atomic-bridge.mjs', import.meta.url));
    const binding = compileBackendAtomicBridge(input);
    options.expectedBindingDigest = binding.contentDigest;
    const result = await executeBackendAtomicBridge(binding, input, options);
    assert.equal(verifyBackendAtomicExecution(result, result.contentDigest, binding, input, options).exitCode, 0);
    const changed = sealContentDigest({ ...result, exitCode: 1 });
    assert.throws(() => verifyBackendAtomicExecution(changed, changed.contentDigest, binding, input, options), /immutable execution readback/u);
    const log = path.join(directory, options.context.schedulerRunId, 'backend-source-file-size/attempt-1/stdout.log');
    fs.chmodSync(log, 0o600);
    fs.appendFileSync(log, 'late drift');
    assert.throws(() => verifyBackendAtomicExecution(result, result.contentDigest, binding, input, options), /immutable execution readback/u);
    const vector = path.join(directory, result.terminalVectorRef.path);
    fs.chmodSync(vector, 0o600);
    fs.appendFileSync(vector, ' ');
    assert.throws(() => verifyBackendAtomicExecution(result, result.contentDigest, binding, input, options), /immutable execution readback/u);
}));

test('verify-fresh mode executes the same compiler bridge with sealed applicability', async () => fixture(async ({ input, options }) =>
{
    const binding = compileBackendAtomicBridge(input);
    options.expectedBindingDigest = binding.contentDigest;
    const result = await executeBackendAtomicBridge(binding, input, options);
    assert.equal(result.exitCode, 0);
    assert.equal(result.projections.find((entry) => entry.producerId === 'backend-perf-summary').readinessMode, 'verify-fresh');
}, { perf: true, mode: 'verify-fresh' }));


test('Release source binding drift refuses even when canonical material is resealed', async () => fixture(async ({ input }) =>
{
    const node = input.matrix.atomicProducerDeclarations.nodes.find((entry) => entry.producerId === 'backend-release-test-build');
    const index = input.authorities.commandSources.findIndex((entry) => entry.id === node.commandSourceRef.id);
    const source = input.authorities.commandSources[index];
    const changed = sealContentDigest({ ...source, sourceRef: { ...source.sourceRef, symbol: 'unownedBuild' } });
    input.authorities.commandSources[index] = changed;
    node.commandSourceRef.contentDigest = changed.contentDigest;
    input.authorities.physicalOwnership.find((entry) => entry.producerId === node.producerId).commandSourceRef.contentDigest = changed.contentDigest;
    input.authorities.matrixDigest = digestCanonical(input.matrix);
    assert.throws(() => compileBackendAtomicBridge(input), /original command owner reference mismatch/u);
}, { perf: true }));


test('valid canonical producers outside the selected backend slice are not executed', async () => fixture(async ({ input }) =>
{
    input.plans = input.plans.filter((plan) => plan.lane === 'backend-test-governance');
    delete input.expectedPlanDigests['backend-perf'];
    assert.throws(() => compileBackendAtomicBridge(input), /cannot execute an unrelated producer/u);
}, { perf: true }));
