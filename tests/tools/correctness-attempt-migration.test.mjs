/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the repository tool under test. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCorrectnessAttemptProducerInventory } from '../../tools/test/correctness-attempt-producers.mjs';
import {
    assertCorrectnessAttemptExecutionOwner,
    validateCorrectnessAttemptMigration
} from '../../tools/test/correctness-attempt-migration.mjs';

test('all 225 correctness producers bind canonical attempt and external authorities', () =>
{
    // Preserve the historical case identity while checking the complete current roster.
    const inventory = buildCorrectnessAttemptProducerInventory();
    const declaredProducerCount = inventory.entries.length;
    const verification = validateCorrectnessAttemptMigration();
    assert.deepEqual(verification, {
        schema: 'fsusblog.correctness-attempt-migration-verification.v1',
        status: 'verified',
        producerCount: declaredProducerCount,
        migratedCount: declaredProducerCount,
        qualificationEligibleCount: declaredProducerCount,
        inventoryDigest: inventory.contentDigest,
        replayProducerInventoryDigest: verification.replayProducerInventoryDigest,
        executionEnvelopeProducerCount: 130,
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
    assert.equal(assertCorrectnessAttemptExecutionOwner(
        'physical:backend-tests:migration-tests-build',
        'tools/test/bundles/run-bundle.mjs'
    ).policyId, 'correctness-first-attempt');
    assert.throws(() => assertCorrectnessAttemptExecutionOwner(
        'physical:backend-tests:migration-tests-build',
        'tools/run-test-matrix.mjs'
    ), /not admitted by the canonical attempt migration/u);
    assert.equal(assertCorrectnessAttemptExecutionOwner(
        'physical:backend-tests:xunit-inventory-adapter-build',
        'tools/test/bundles/run-bundle.mjs'
    ).policyId, 'correctness-first-attempt');
    assert.throws(() => assertCorrectnessAttemptExecutionOwner(
        'physical:backend-tests:xunit-inventory-adapter-build',
        'tools/run-test-matrix.mjs'
    ), /not admitted by the canonical attempt migration/u);
    assert.throws(() => assertCorrectnessAttemptExecutionOwner(
        'physical:backend-tests:migration-test-execution',
        'tools/run-test-matrix.mjs'
    ), /not admitted by the canonical attempt migration/u);
    assert.equal(assertCorrectnessAttemptExecutionOwner(
        'physical:backend-tests:migration-test-execution',
        'tools/test/bundles/run-bundle.mjs'
    ).policyId, 'correctness-first-attempt');
    assert.throws(() => assertCorrectnessAttemptExecutionOwner(
        'matrix:backend-unit',
        'tools/test/bundles/run-bundle.mjs'
    ), /not admitted by the canonical attempt migration/u);
});
