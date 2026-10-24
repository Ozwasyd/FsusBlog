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

const root = path.resolve(import.meta.dirname, '../..');
const inventoryFile = 'config/testing/correctness-attempt-producers.json';

function fixture(context)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'correctness-migration-roster-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const inventory = JSON.parse(fs.readFileSync(path.join(root, inventoryFile), 'utf8'));
    for (const file of [inventoryFile, ...Object.keys(inventory.sourceDigests)])
    {
        const destination = path.join(directory, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, file), destination);
    }
    return { directory, inventory };
}

test('all current canonical correctness producers bind attempt and external authorities', () =>
{
    const producerCount = JSON.parse(fs.readFileSync(path.join(root, inventoryFile), 'utf8')).entries.length;
    const verification = validateCorrectnessAttemptMigration();
    assert.deepEqual(verification, {
        schema: 'fsusblog.correctness-attempt-migration-verification.v1',
        status: 'verified',
        producerCount,
        migratedCount: producerCount,
        qualificationEligibleCount: producerCount,
        inventoryDigest: verification.inventoryDigest,
        replayProducerInventoryDigest: verification.replayProducerInventoryDigest,
        executionEnvelopeProducerCount: 130,
        authorityKinds: ['execution-envelope', 'replay-plan', 'temporal-context'],
        warnings: 0
    });
});

for (const mutation of ['missing', 'extra', 'substituted'])
{
    test(`canonical producer ownership refuses a resealed ${mutation} roster`, (context) =>
    {
        const { directory, inventory } = fixture(context);
        if (mutation === 'missing')
        {
            inventory.entries.pop();
        }
        else
        {
            const unknown = { ...inventory.entries[0], producerId: 'matrix:unowned-fixture' };
            if (mutation === 'extra')
            {
                inventory.entries.push(unknown);
            }
            else
            {
                inventory.entries[0] = unknown;
            }
        }
        fs.writeFileSync(path.join(directory, inventoryFile), JSON.stringify(sealContentDigest(inventory)));
        assert.throws(() => validateCorrectnessAttemptMigration(directory), /differs from canonical authorities/u);
    });
}

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
