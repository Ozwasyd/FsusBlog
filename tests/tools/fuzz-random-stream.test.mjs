import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest } from '../../tools/test/execution-replay-contract.mjs';
import { assertFuzzReplayBinding, createFuzzCaseReceipt } from '../../tools/test/fuzz-random-stream.mjs';
import {
    createDeterministicRandom,
    deriveRandomConsumerStream,
    loadRandomStreamInventory,
    validateRandomStreamReceipt
} from '../../tools/test/random-streams.mjs';

const rootSeed = `seed256:${'22'.repeat(32)}`;

function setup()
{
    const consumer = loadRandomStreamInventory().consumers.find((entry) => entry.kind === 'fuzz');
    const stream = deriveRandomConsumerStream({ rootSeed, consumer });
    const random = createDeterministicRandom(stream.derivedSeed);
    const cases = Array.from({ length: consumer.budget.iterations }, () => random());
    return { consumer, stream, cases };
}

test('fuzz case sequence is stable under host, worker and consumer-order noise', () =>
{
    const first = setup();
    const second = setup();
    assert.deepEqual(first.cases, second.cases);
    assert.deepEqual(first.stream, second.stream);
});

test('fuzz failure seals first failure, shrink path and minimal sample', () =>
{
    const { consumer, stream, cases } = setup();
    const failure = {
        iteration: 3,
        error: { code: 'decoder-divergence' },
        shrinkSequence: [cases[3], cases[3] >>> 1, 0],
        minimalSample: { value: 0 },
        minimalSampleRef: '.tmp/fuzz/wasm/crashes/minimal.json'
    };
    const receipt = createFuzzCaseReceipt({
        consumer,
        stream,
        cases,
        executedIterations: cases.length,
        failure
    });
    assert.equal(receipt.firstFailure.attempt, 1);
    assert.equal(receipt.minimalSample.digest, canonicalDigest(failure.minimalSample));
    assert.equal(validateRandomStreamReceipt(receipt, { consumer, stream }), receipt);
    assert.deepEqual(assertFuzzReplayBinding(receipt, structuredClone(receipt)), receipt);
});

test('new seed retry, first-failure overwrite and shrink tamper fail closed', () =>
{
    const { consumer, stream, cases } = setup();
    const receipt = createFuzzCaseReceipt({
        consumer,
        stream,
        cases,
        executedIterations: cases.length,
        failure: {
            iteration: 1,
            error: 'first',
            shrinkSequence: [cases[1], 0],
            minimalSample: 0,
            minimalSampleRef: '.tmp/fuzz/minimal.json'
        }
    });
    const retry = structuredClone(receipt);
    retry.derivedSeed = `${retry.derivedSeed}-retry`;
    assert.throws(() => assertFuzzReplayBinding(receipt, retry), /derivedSeed/u);

    const overwritten = structuredClone(receipt);
    overwritten.firstFailure.attempt = 2;
    assert.throws(() => validateRandomStreamReceipt(overwritten, { consumer, stream }), /first attempt|content digest/u);

    const tampered = structuredClone(receipt);
    tampered.minimalSample.digest = canonicalDigest('different');
    assert.throws(() => assertFuzzReplayBinding(receipt, tampered), /minimalSample/u);
});

test('fuzz coverage budget and diagnostic eligibility cannot be weakened', () =>
{
    const { consumer, stream, cases } = setup();
    assert.throws(() => createFuzzCaseReceipt({
        consumer,
        stream,
        cases: cases.slice(0, -1),
        executedIterations: cases.length - 1
    }), /reduced the iteration budget/u);
    const diagnostic = createFuzzCaseReceipt({
        consumer,
        stream,
        cases: [],
        executedIterations: 0,
        evidenceClass: 'diagnostic'
    });
    assert.equal(diagnostic.qualificationEligible, false);
});
