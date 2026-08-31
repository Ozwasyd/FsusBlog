import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createRandomStreamReceipt,
    deriveRandomConsumerStream,
    loadRandomStreamInventory,
    resolveRandomConsumer,
    validateRandomStreamInventory,
    validateRandomStreamReceipt
} from '../../tools/test/random-streams.mjs';

const rootSeed = `seed256:${'11'.repeat(32)}`;

function consumer(kind)
{
    return loadRandomStreamInventory().consumers.find((entry) => entry.kind === kind);
}

test('property consumers derive stable isolated streams independent of order and worker noise', () =>
{
    const inventory = loadRandomStreamInventory();
    const selected = inventory.consumers.filter((entry) => entry.kind === 'property');
    const first = selected.map((entry) => deriveRandomConsumerStream({ rootSeed, consumer: entry }));
    const second = [...selected].reverse()
        .map((entry) => deriveRandomConsumerStream({ rootSeed, consumer: entry }))
        .reverse();
    assert.deepEqual(first, second);
    assert.notEqual(first[0].derivedSeed, first[1].derivedSeed);

    const withUnrelatedConsumer = structuredClone(inventory);
    withUnrelatedConsumer.consumers.push({
        ...selected[0],
        canonicalTestId: 'vitest:tests/frontend/property/unrelated.test.ts#unrelated-property',
        streamId: 'unrelated-property-stream',
        randomStreams: ['unrelated-property-stream']
    });
    validateRandomStreamInventory(withUnrelatedConsumer);
    assert.deepEqual(
        deriveRandomConsumerStream({ rootSeed, consumer: selected[0] }),
        deriveRandomConsumerStream({ rootSeed, consumer: withUnrelatedConsumer.consumers[0] })
    );
});

test('property receipt binds actual seed, case identity, budget and version', () =>
{
    const selected = consumer('property');
    const stream = deriveRandomConsumerStream({ rootSeed, consumer: selected });
    const receipt = createRandomStreamReceipt({
        consumer: selected,
        stream,
        caseIdentities: Array.from({ length: selected.budget.iterations }, (_, index) => `case-${index}`),
        executedIterations: selected.budget.iterations
    });
    assert.equal(validateRandomStreamReceipt(receipt, { consumer: selected, stream }), receipt);
    assert.equal(receipt.version, selected.version);
    assert.equal(receipt.derivedSeed, stream.derivedSeed);
});

test('duplicate, missing and mismatched stream identities fail closed', () =>
{
    const inventory = loadRandomStreamInventory();
    const duplicate = structuredClone(inventory);
    duplicate.consumers.push(structuredClone(duplicate.consumers[0]));
    assert.throws(() => validateRandomStreamInventory(duplicate), /duplicates producer\/test\/stream identity/u);

    const missing = structuredClone(inventory);
    delete missing.consumers[0].streamId;
    assert.throws(() => validateRandomStreamInventory(missing), /streamId/u);

    assert.throws(() => resolveRandomConsumer(inventory, {
        producerId: inventory.consumers[0].producerId,
        canonicalTestId: inventory.consumers[0].canonicalTestId,
        streamId: 'unknown-stream'
    }), /exact-one/u);
});

test('diagnostic generated seed receipt cannot qualify as correctness', () =>
{
    const selected = consumer('property');
    const stream = deriveRandomConsumerStream({ rootSeed, consumer: selected });
    const receipt = createRandomStreamReceipt({
        consumer: selected,
        stream,
        evidenceClass: 'diagnostic',
        qualificationEligible: false,
        caseIdentities: [],
        executedIterations: 0
    });
    const promoted = structuredClone(receipt);
    promoted.evidenceClass = 'correctness';
    promoted.qualificationEligible = true;
    assert.throws(() => validateRandomStreamReceipt(promoted, { consumer: selected, stream }), /iteration budget|content digest/u);
});

test('non-random producers require explicit randomStreams empty array', () =>
{
    const inventory = loadRandomStreamInventory();
    const missing = structuredClone(inventory);
    delete missing.nonRandomDeclarations[0].randomStreams;
    assert.throws(() => validateRandomStreamInventory(missing), /explicit empty array/u);
    const incorrect = structuredClone(inventory);
    incorrect.nonRandomDeclarations[0].randomStreams = ['implicit-default'];
    assert.throws(() => validateRandomStreamInventory(incorrect), /explicit empty array/u);
});

test('producer wrapper injects every inventoried stream and qualification requires an explicit root', () =>
{
    const wrapper = fileURLToPath(new URL('../../tools/test/run-random-stream-producer.mjs', import.meta.url));
    const probe = 'process.stdout.write(process.env.FSUSBLOG_RANDOM_STREAMS_JSON ?? "")';
    const diagnostic = spawnSync(process.execPath, [
        wrapper,
        '--producer', 'frontend-property-model-perf',
        '--', process.execPath, '-e', probe
    ], {
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH
        }
    });
    assert.equal(diagnostic.status, 0, diagnostic.stderr);
    assert.equal(Object.keys(JSON.parse(diagnostic.stdout)).length, 2);
    assert.match(diagnostic.stderr, /diagnostic root seed seed256:/u);

    const qualification = spawnSync(process.execPath, [
        wrapper,
        '--producer', 'frontend-property-model-perf',
        '--', process.execPath, '-e', probe
    ], {
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            FSUSBLOG_REPLAY_MODE: 'qualification'
        }
    });
    assert.notEqual(qualification.status, 0);
    assert.match(qualification.stderr, /qualification requires an explicit/u);
});
