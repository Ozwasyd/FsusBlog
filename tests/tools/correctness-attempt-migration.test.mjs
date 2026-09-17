import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertCorrectnessAttemptExecutionOwner,
    validateCorrectnessAttemptMigration
} from '../../tools/test/correctness-attempt-migration.mjs';

test('all 221 correctness producers bind canonical attempt and external authorities', () =>
{
    const verification = validateCorrectnessAttemptMigration();
    assert.deepEqual(verification, {
        schema: 'fsusblog.correctness-attempt-migration-verification.v1',
        status: 'verified',
        producerCount: 221,
        migratedCount: 221,
        qualificationEligibleCount: 221,
        inventoryDigest: verification.inventoryDigest,
        replayProducerInventoryDigest: verification.replayProducerInventoryDigest,
        executionEnvelopeProducerCount: 129,
        authorityKinds: ['execution-envelope', 'replay-plan', 'temporal-context'],
        warnings: 0
    });
});

test('matrix and physical producers fail closed on a crossed execution owner', () =>
{
    assert.equal(assertCorrectnessAttemptExecutionOwner(
        'matrix:backend-unit',
        'tools/run-test-matrix.mjs'
    ).policyId, 'correctness-first-attempt');
    assert.equal(assertCorrectnessAttemptExecutionOwner(
        'physical:backend-tests:dotnet-production-union',
        'tools/test/bundles/run-bundle.mjs'
    ).policyId, 'correctness-first-attempt');
    assert.throws(() => assertCorrectnessAttemptExecutionOwner(
        'matrix:backend-unit',
        'tools/test/bundles/run-bundle.mjs'
    ), /not admitted by the canonical attempt migration/u);
});
