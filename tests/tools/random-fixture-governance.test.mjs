/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { scanRandomEntropy } from '../../tools/test/check-random-entropy-governance.mjs';
import {
    deriveRandomConsumerStream,
    deterministicFixtureArtifact,
    loadRandomStreamInventory,
    validateRandomStreamInventory
} from '../../tools/test/random-streams.mjs';

function fixtureConsumer(version = 'fixture-generator-v1')
{
    return {
        producerId: 'fixture-test',
        canonicalTestId: 'node:tests/tools/random-fixture-governance.test.mjs#deterministic-fixture',
        kind: 'fixture',
        entrypoint: 'tests/tools/random-fixture-governance.test.mjs',
        runner: 'node',
        runnerConfig: 'tests/tools/random-fixture-governance.test.mjs',
        streamId: 'fixture-payload-generator',
        version,
        budget: { iterations: 8, transitions: 0, shrinks: 0 },
        receiptOwner: '.tmp/fixtures/random-stream.json',
        evidenceClass: 'correctness',
        qualificationEligible: true,
        usesRandomness: true,
        randomStreams: ['fixture-payload-generator']
    };
}

test('random fixture bytes and digest are stable across temp roots and consumer order', () =>
{
    const consumer = fixtureConsumer();
    const stream = deriveRandomConsumerStream({ rootSeed: `seed256:${'33'.repeat(32)}`, consumer });
    const first = deterministicFixtureArtifact({ consumer, stream, payload: { values: [3, 1, 2] } });
    const second = deterministicFixtureArtifact({ consumer, stream, payload: { values: [3, 1, 2] } });
    assert.deepEqual(first, second);
    assert.equal(first.digest.startsWith('sha256:'), true);
});

test('seed, generator version and schema payload changes invalidate fixture identity', () =>
{
    const firstConsumer = fixtureConsumer('fixture-generator-v1');
    const secondConsumer = fixtureConsumer('fixture-generator-v2');
    const first = deterministicFixtureArtifact({
        consumer: firstConsumer,
        stream: deriveRandomConsumerStream({ rootSeed: `seed256:${'44'.repeat(32)}`, consumer: firstConsumer }),
        payload: { schema: 'fixture.v1' }
    });
    const seedChanged = deterministicFixtureArtifact({
        consumer: firstConsumer,
        stream: deriveRandomConsumerStream({ rootSeed: `seed256:${'55'.repeat(32)}`, consumer: firstConsumer }),
        payload: { schema: 'fixture.v1' }
    });
    const versionChanged = deterministicFixtureArtifact({
        consumer: secondConsumer,
        stream: deriveRandomConsumerStream({ rootSeed: `seed256:${'44'.repeat(32)}`, consumer: secondConsumer }),
        payload: { schema: 'fixture.v1' }
    });
    assert.notEqual(first.digest, seedChanged.digest);
    assert.notEqual(first.digest, versionChanged.digest);
});

test('entropy scanner rejects semantic time, UUID, PID, framework and OS entropy', () =>
{
    const inventory = loadRandomStreamInventory();
    const entrypoint = inventory.consumers[0].entrypoint;
    for (const source of [
        'const seed = Date.now()',
        'const seed = randomUUID()',
        'const seed = process.pid',
        'const seed = randomBytes(32)',
        'const seed = Math.random()',
        'var seed = Guid.NewGuid()',
        'var seed = Random.Shared.Next()'
    ])
    {
        const sources = new Map(inventory.consumers.map((consumer) => [consumer.entrypoint, 'const deterministic = 1']));
        sources.set(entrypoint, source);
        assert.equal(scanRandomEntropy({ inventory, sources }).length, 1, source);
    }
});

test('nonsemantic temporary entropy must be explicit and excluded from semantic digest', () =>
{
    const inventory = loadRandomStreamInventory();
    const invalid = structuredClone(inventory);
    invalid.nonSemanticEntropy[0].semanticDigestExcluded = false;
    assert.throws(() => scanRandomEntropy({ inventory: invalid, sources: new Map() }), /not excluded/u);
});

test('inventory rejects hard-coded empty coverage and duplicate consumer identities', () =>
{
    const inventory = loadRandomStreamInventory();
    const weakened = structuredClone(inventory);
    weakened.consumers[0].budget = { iterations: 0, transitions: 0, shrinks: 0 };
    assert.throws(() => validateRandomStreamInventory(weakened), /preserve non-zero coverage/u);

    const duplicate = structuredClone(inventory);
    duplicate.consumers.push(structuredClone(duplicate.consumers[0]));
    assert.throws(() => validateRandomStreamInventory(duplicate), /duplicates/u);
});
