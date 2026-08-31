import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { inventoryByDomain } from '../../tools/test/correctness-attempt-producers.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const inventory = JSON.parse(fs.readFileSync(
    path.join(root, 'config/testing/correctness-attempt-producers.json'),
    'utf8'
));

test('build and release inventory covers immutable build, reliability, projection and finalizer owners', () =>
{
    const entries = inventoryByDomain(inventory).get('build-release-producers');
    const ids = new Set(entries.map((item) => item.producerId));
    for (const id of [
        'matrix:production-build-artifacts',
        'matrix:release-final',
        'matrix:release-reliability-fresh',
        'physical:backend-tests:backend-server-build',
        'physical:build-static:frontend-build',
        'physical:scheduler:logical-tier-projection',
        'physical:scheduler:run-summary',
        'reliability:release-data-scale-m'
    ])
    {
        assert.ok(ids.has(id), id);
    }
    assert.ok(entries.some((item) => item.producerKind === 'projection'));
    assert.ok(entries.some((item) => item.producerKind === 'finalizer'));
});

test('all build and release producers are first-attempt clean only', () =>
{
    for (const item of inventoryByDomain(inventory).get('build-release-producers'))
    {
        assert.equal(item.allowedRetries, 0);
        assert.equal(item.firstFailureBlocksQualification, true);
        assert.equal(item.frameworkRetrySetting, 0);
        assert.equal(item.migrationState, 'migrated');
        assert.equal(item.qualificationEligible, true);
        assert.deepEqual(item.externalAuthorityKinds, [
            'execution-envelope',
            'replay-plan',
            'temporal-context'
        ]);
    }
});
