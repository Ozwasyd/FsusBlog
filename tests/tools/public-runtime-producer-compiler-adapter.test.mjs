import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

import { publicRuntimeCompilerFixture } from './support/public-runtime-compiler-fixture.mjs';

const { compilePublicRuntimeProducerDag, preparePublicRuntimeAttemptContexts } = await import(new URL('../../tools/test/public-runtime-producers/compiler-adapter.mjs', import.meta.url));
const { AtomicProducerExecutionError, executeCompiledAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/execution.mjs', import.meta.url));

function compile(fixture)
{
    return compilePublicRuntimeProducerDag(fixture, fixture.compilerOptions);
}

test('release source nodes compile through canonical framework with original commands and owner refs', () =>
{
    const fixture = publicRuntimeCompilerFixture('release-public');
    try
    {
        const binding = compile(fixture);
        const step = binding.compiled.steps.find((node) => node.id === 'public-aot-regression');
        assert.deepEqual(step.command, [process.execPath, '../../tests/frontend/checks/public/aot-regression.mjs']);
        assert.deepEqual(step.dependsOn, ['release-public-hydration']);
        assert.equal(step.attemptPolicyId, 'correctness-first-attempt');
        const prepared = preparePublicRuntimeAttemptContexts(binding, fixture, fixture, fixture.compilerOptions);
        assert.equal(prepared.executionOptions.producerContexts, fixture.producerContexts);
        assert.equal(prepared.runtimeAuthorityStatus, 'unverified');
        assert.equal(prepared.qualificationEligible, false);
    }
    finally
    {
        fixture.cleanup();
    }
});

test('load reset is executable settled hard prerequisite and summary includes both windows and reset', () =>
{
    const fixture = publicRuntimeCompilerFixture('load');
    try
    {
        const binding = compile(fixture);
        const reset = binding.compiled.steps.find((node) => node.id === 'reset-pre-notification-stream');
        assert.equal(reset.kind, 'hard-prerequisite');
        assert.deepEqual(reset.settledDependsOn, ['load-public-api']);
        assert.deepEqual(reset.dependsOn, ['runtime-readiness']);
        assert.equal(reset.alwaysRunFinalizer, undefined);
        assert.equal(reset.runAfterSettled, undefined);
        assert.deepEqual(binding.compiled.steps.find((node) => node.id === 'load-notification-stream-pressure').dependsOn, [reset.id]);
        assert.equal(binding.settledResetContract.supported, false);
        assert.equal(binding.runtimeAuthorityStatus, 'unverified');
        assert.equal(binding.compiled.steps.find((node) => node.id === 'load-summary').settledDependsOn.length, 3);
        const prepared = preparePublicRuntimeAttemptContexts(binding, fixture, fixture, fixture.compilerOptions);
        assert.equal(prepared.runtimeAuthorityStatus, 'unverified');
    }
    finally
    {
        fixture.cleanup();
    }
});

test('resilience preserves all six source scenarios while requiring exact host owner binding', () =>
{
    const fixture = publicRuntimeCompilerFixture('resilience');
    try
    {
        const binding = compile(fixture);
        const domain = binding.compiled.steps.filter((node) => node.logicalParentId === fixture.attachment.logicalParentId);
        assert.equal(domain.filter((node) => node.kind === 'atomic-producer').length, 6);
        assert.ok(domain.some((node) => node.id === 'resilience-post-notification-live'));
        assert.equal(binding.runtimeRequirements.filter((item) => item.kind === 'resident-host-lease').length, 6);
        assert.equal(binding.qualificationEligible, false);
    }
    finally
    {
        fixture.cleanup();
    }
});

test('isolated ordinary release fixture reaches actual exact-one attempt receipts through canonical runner', async () =>
{
    const fixture = publicRuntimeCompilerFixture('release-public');
    try
    {
        const binding = compile(fixture);
        preparePublicRuntimeAttemptContexts(binding, fixture, fixture, fixture.compilerOptions);
        const vector = await executeCompiledAtomicProducerDag(binding.compiled, fixture.executionOptions);
        assert.equal(vector.status, 'success');
        assert.equal(vector.qualificationEligible, false);
        const receipts = vector.receipts.filter((receipt) => receipt.kind === 'atomic-producer');
        assert.equal(receipts.length, 9);
        for (const receipt of receipts)
        {
            const attempt = JSON.parse(fs.readFileSync(receipt.attemptRef.path, 'utf8'));
            assert.equal(attempt.attemptNumber, 1);
            assert.equal(attempt.maxAttempts, 1);
            assert.equal(attempt.producerId, receipt.producerId);
            assert.equal(attempt.contentDigest, receipt.attemptRef.contentDigest);
        }
    }
    finally
    {
        fixture.cleanup();
    }
});

test('ordinary AOT assertion failure retains genuine failed attempt and healthy SEO sibling', async () =>
{
    const fixture = publicRuntimeCompilerFixture('release-public', { aotScenario: 'product-failure' });
    try
    {
        const binding = compile(fixture);
        let error;
        try
        {
            await executeCompiledAtomicProducerDag(binding.compiled, fixture.executionOptions);
        }
        catch (caught)
        {
            error = caught;
        }
        assert.ok(error instanceof AtomicProducerExecutionError);
        const vector = error.terminalVector;
        assert.equal(vector.receipts.find((receipt) => receipt.producerId === 'public-aot-regression').terminalState, 'failed');
        assert.equal(vector.receipts.find((receipt) => receipt.producerId === 'public-seo-smoke').terminalState, 'success');
        assert.equal(vector.receipts.find((receipt) => receipt.producerId === 'release-public-summary').terminalState, 'failed');
        assert.equal(vector.qualificationEligible, false);
    }
    finally
    {
        fixture.cleanup();
    }
});
