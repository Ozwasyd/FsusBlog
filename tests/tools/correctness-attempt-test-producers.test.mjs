import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    inventoryByDomain,
    validateCorrectnessAttemptProducerInventory
} from '../../tools/test/correctness-attempt-producers.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const inventory = JSON.parse(fs.readFileSync(
    path.join(root, 'config/testing/correctness-attempt-producers.json'),
    'utf8'
));

test('test producer inventory exactly rebuilds matrix and physical authorities', () =>
{
    validateCorrectnessAttemptProducerInventory(inventory, root);
    const domains = inventoryByDomain(inventory);
    const entries = domains.get('test-producers');
    assert.ok(entries.length > 100);
    const ids = new Set(entries.map((item) => item.producerId));
    for (const id of [
        'matrix:backend-api-integration',
        'matrix:backend-property',
        'matrix:backend-mutation',
        'physical:backend-tests:dotnet-production-union',
        'physical:build-static:wasm-fuzz',
        'physical:frontend-tests:vitest-production-projects'
    ])
    {
        assert.ok(ids.has(id), id);
    }
});

test('unit, integration, property, model, fuzz and mutation producers are first-attempt only', () =>
{
    const entries = inventoryByDomain(inventory).get('test-producers');
    const kinds = new Set(entries.map((item) => item.producerKind));
    for (const kind of ['unit', 'integration', 'property', 'model', 'fuzz', 'mutation'])
    {
        assert.ok(kinds.has(kind), `missing ${kind}`);
    }
    for (const item of entries)
    {
        assert.equal(item.policyId, 'correctness-first-attempt');
        assert.equal(item.allowedRetries, 0);
        assert.equal(item.frameworkRetrySetting, 0);
        assert.equal(item.firstFailureBlocksQualification, true);
        assert.equal(item.migrationState, 'pending-external-authorities');
        assert.equal(item.qualificationEligible, false);
    }
});

test('diagnostic matrix producers do not leak into correctness inventory', () =>
{
    assert.equal(inventory.entries.some((item) => item.producerId === 'matrix:browser-diagnostics'), false);
    assert.equal(new Set(inventory.entries.map((item) => item.producerId)).size, inventory.entries.length);
});
