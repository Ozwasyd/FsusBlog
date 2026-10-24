/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the repository tool under test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sealContentDigest } from '../../tools/test/attempt-provenance.mjs';
import {
    assertCorrectnessAttemptExecutionOwner,
    validateCorrectnessAttemptMigration
} from '../../tools/test/correctness-attempt-migration.mjs';
import { buildCorrectnessAttemptProducerInventory } from '../../tools/test/correctness-attempt-producers.mjs';

test('all current canonical correctness producers bind attempt and external authorities', () =>
{
    const expected = buildCorrectnessAttemptProducerInventory();
    const verification = validateCorrectnessAttemptMigration();
    assert.deepEqual(verification, {
        schema: 'fsusblog.correctness-attempt-migration-verification.v1',
        status: 'verified',
        producerCount: expected.entries.length,
        migratedCount: expected.entries.length,
        qualificationEligibleCount: expected.entries.length,
        inventoryDigest: verification.inventoryDigest,
        replayProducerInventoryDigest: verification.replayProducerInventoryDigest,
        executionEnvelopeProducerCount: 130,
        authorityKinds: ['execution-envelope', 'replay-plan', 'temporal-context'],
        warnings: 0
    });
});

function assertResealedRosterRejected(context, mutation)
{
    const root = path.resolve(import.meta.dirname, '../..');
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'correctness-roster-'));
    context.after(() => fs.rmSync(isolatedRoot, { recursive: true, force: true }));
    const inventory = buildCorrectnessAttemptProducerInventory(root);
    for (const file of Object.keys(inventory.sourceDigests))
    {
        const destination = path.join(isolatedRoot, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, file), destination);
    }
    if (mutation === 'omitted')
    {
        inventory.entries.pop();
    }
    else if (mutation === 'extra')
    {
        inventory.entries.push({ ...inventory.entries[0], producerId: 'matrix:unregistered-producer' });
    }
    else if (mutation === 'duplicate')
    {
        inventory.entries.push(structuredClone(inventory.entries[0]));
    }
    else
    {
        inventory.entries[0].authorityBindings.executionEnvelope = 'unregistered-authority';
    }
    const destination = path.join(isolatedRoot, 'config/testing/correctness-attempt-producers.json');
    fs.writeFileSync(destination, JSON.stringify(sealContentDigest(inventory)));
    assert.throws(() => validateCorrectnessAttemptMigration(isolatedRoot), /differs from canonical authorities/u);
}

test('migration rejects a freshly resealed omitted canonical producer roster', (context) =>
{
    assertResealedRosterRejected(context, 'omitted');
});

test('migration rejects a freshly resealed extra canonical producer roster', (context) =>
{
    assertResealedRosterRejected(context, 'extra');
});

test('migration rejects a freshly resealed duplicate canonical producer roster', (context) =>
{
    assertResealedRosterRejected(context, 'duplicate');
});

test('migration rejects a freshly resealed wrong authority canonical producer roster', (context) =>
{
    assertResealedRosterRejected(context, 'wrong authority');
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
