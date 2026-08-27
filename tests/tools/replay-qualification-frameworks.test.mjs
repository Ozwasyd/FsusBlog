/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalDigest } from '../../tools/test/execution-replay-contract.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/replay-qualification-producers.json'), 'utf8'));

test('framework qualification inventory is sealed and owns each supported real adapter', () =>
{
    assert.equal(inventory.contentDigest, canonicalDigest({ ...inventory, contentDigest: null }));
    assert.deepEqual(inventory.families.framework.map((producer) => producer.framework), ['xunit', 'vitest', 'playwright']);
    assert.deepEqual(inventory.topologies, ['1', '2', 'planned']);
    for (const producer of inventory.families.framework)
    {
        assert.equal(fs.existsSync(path.join(root, producer.adapter)), true, producer.adapter);
        assert.ok(producer.plannedWorkers > 1);
        assert.notEqual(producer.catalogAuthority, 'synthetic');
    }
});

test('framework qualification requires restart and timing perturbations', () =>
{
    assert.ok(inventory.perturbations.includes('worker-process-restart'));
    assert.ok(inventory.perturbations.includes('completion-timing'));
    assert.ok(inventory.perturbations.includes('framework-default-worker'));
});
