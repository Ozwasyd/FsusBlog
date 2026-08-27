/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest } from '../../tools/test/execution-replay-contract.mjs';
import { deriveRandomConsumerStream, loadRandomStreamInventory } from '../../tools/test/random-streams.mjs';

const rootSeed = `seed256:${'2'.repeat(64)}`;

test('randomized qualification derives every canonical consumer from one explicit root seed', () =>
{
    const inventory = loadRandomStreamInventory();
    assert.ok(inventory.consumers.length > 0);
    const first = inventory.consumers.map((consumer) => deriveRandomConsumerStream({ rootSeed, consumer }));
    const repeated = [...inventory.consumers].reverse()
        .map((consumer) => deriveRandomConsumerStream({ rootSeed, consumer }))
        .sort((left, right) => left.streamId.localeCompare(right.streamId));
    assert.equal(canonicalDigest(first.sort((left, right) => left.streamId.localeCompare(right.streamId))), canonicalDigest(repeated));
    assert.equal(new Set(first.map((stream) => stream.streamId)).size, inventory.consumers.length);
});
