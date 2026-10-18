import assert from 'node:assert/strict';
import test from 'node:test';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { sealVerifiedProducerSemanticOutcome } = await import(new URL('../../tools/test-matrix/outcomes/producer-outcome-analysis.mjs', import.meta.url));
const { analyzeStrongSemanticOutcome } = await import(new URL('../../tools/test-matrix/outcomes/strong-outcome-analysis.mjs', import.meta.url));
import { bindFixture, digest, producerFixture } from './support/semantic-outcome-analysis-fixture.mjs';

function failurePairFixture(pairs)
{
    const member = producerFixture();
    const outcome = structuredClone(member.outcome);
    const ids = pairs.map(([testId]) => testId).sort();
    Object.assign(outcome, { plannedTestIds: ids, executedTestIds: ids, passedTestIds: [], failedTestIds: ids,
        qualificationEligible: false, producerStatus: 'failed' });
    outcome.assertions = pairs.map(([testId, id]) => ({ id, testId, status: 'failed',
        failureClass: 'product', failureKind: 'product.assertion',
        failureIdentity: { producerId: outcome.producerId, testId, assertionId: id } }))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    outcome.failures = pairs.map(([testId, assertionId]) => ({ producerId: outcome.producerId, testId, assertionId,
        failureClass: 'product', failureKind: 'product.assertion',
        identity: { producerId: outcome.producerId, testId, assertionId } }));
    return bindFixture(outcome, member.options);
}

test('slash-bearing failure tuples stay distinct and canonical under exchanged input', () =>
{
    const member = failurePairFixture([['a', 'b/c'], ['a/b', 'c']]);
    const raw = sealContentDigest({ ...member.outcome, failures: [...member.outcome.failures].reverse() });
    const before = JSON.stringify(raw);
    const result = analyzeStrongSemanticOutcome(raw, member.options);
    assert.deepEqual(result.canonicalOutcome.failures.map((entry) => [entry.testId, entry.assertionId]),
        [['a', 'b/c'], ['a/b', 'c']]);
    assert.equal(result.outcomeFingerprint, member.outcome.outcomeFingerprint);
    assert.equal(result.semanticPayloadDigest, member.outcome.semanticPayloadDigest);
    assert.equal(result.canonicalOutcome.contentDigest, member.outcome.contentDigest);
    assert.equal(result.semanticPayload.outcome.failures.length, 2);
    assert.equal(JSON.stringify(raw), before);
    assert.equal(result.dataOnly, true);
    assert.equal(result.producerVerificationPending, true);
    assert.throws(() => sealVerifiedProducerSemanticOutcome(result), /independent authority bridge/u);
});

test('exact repeated failure tuples remain duplicates despite slash-bearing IDs', () =>
{
    const member = failurePairFixture([['a', 'b/c'], ['a/b', 'c']]);
    const raw = sealContentDigest({ ...member.outcome, failures: [...member.outcome.failures, member.outcome.failures[0]] });
    assert.throws(() => analyzeStrongSemanticOutcome(raw, member.options), /duplicate identity/u);
});

test('noncolliding slash keys retain their original order and frozen producer fingerprints', () =>
{
    const member = failurePairFixture([['a/b', 'c'], ['a', 'z']]);
    const result = analyzeStrongSemanticOutcome(member.outcome, member.options);
    assert.deepEqual(result.canonicalOutcome.failures.map((entry) => [entry.testId, entry.assertionId]),
        [['a/b', 'c'], ['a', 'z']]);
    // Captured through the original interfaces on the pinned source composition before the fix.
    assert.equal(result.semanticPayloadDigest, 'sha256:0e0e3e1c67d5bec3a8da94418546fefc7b3d9525d0aba702bd56dfd284a09430');
    assert.equal(result.outcomeFingerprint, 'sha256:f7a0faa753ea85520454125b62a8d1579cb34143893027a0708f90a4ea389a5c');
});

test('strong analysis recomputes all semantic fields while retaining DATA_ONLY refusal', () =>
{
    const member = producerFixture();
    const result = analyzeStrongSemanticOutcome(member.outcome, member.options);
    assert.equal(result.semanticPayloadDigest, member.outcome.semanticPayloadDigest);
    assert.equal(result.outcomeFingerprint, member.outcome.outcomeFingerprint);
    assert.equal(result.dataOnly, true);
    assert.equal(result.producerVerificationPending, true);
    assert.throws(() => sealVerifiedProducerSemanticOutcome(result), /independent authority bridge/u);
    assert.ok(Object.isFrozen(result.semanticPayload.outcome.assertions));
    assert.notEqual(result.canonicalOutcome, member.outcome);
    assert.ok(!Object.hasOwn(result.semanticPayload.outcome, 'contentDigest'));
});

test('registry-declared metadata cannot pollute semantic fingerprints', () =>
{
    const member = producerFixture();
    const first = analyzeStrongSemanticOutcome(member.outcome, member.options,
        { generatedAt: 'one', durationMs: 1, pid: 1, port: 1000, path: '/tmp/one', errorText: 'timeout' });
    const second = analyzeStrongSemanticOutcome(member.outcome, member.options,
        { generatedAt: 'two', durationMs: 2, pid: 2, port: 2000, path: '/tmp/two', errorText: 'assertion' });
    assert.equal(first.outcomeFingerprint, second.outcomeFingerprint);
    assert.equal(first.semanticPayloadDigest, second.semanticPayloadDigest);
    assert.notDeepEqual(first.metadata, second.metadata);
});

test('array and object order normalize under registered identities without mutating original input', () =>
{
    const member = producerFixture();
    const reversed = structuredClone(member.outcome);
    reversed.plannedTestIds.reverse();
    reversed.executedTestIds.reverse();
    reversed.passedTestIds.reverse();
    reversed.assertions.reverse();
    const raw = sealContentDigest(reversed);
    const result = analyzeStrongSemanticOutcome(raw, member.options);
    assert.equal(result.outcomeFingerprint, member.outcome.outcomeFingerprint);
    assert.deepEqual(raw.assertions.map((item) => item.id), reversed.assertions.map((item) => item.id));
    assert.equal(result.inputContentDigest, raw.contentDigest);
});

test('same success status still distinguishes state artifact policy coverage plan and secret context', () =>
{
    const original = producerFixture();
    for (const field of ['stateSemanticDigests', 'artifactSemanticDigests', 'policyDigests'])
    {
        const value = structuredClone(original.outcome);
        value[field][0].digest = digest('changed');
        const next = bindFixture(value, original.options);
        assert.notEqual(next.outcome.outcomeFingerprint, original.outcome.outcomeFingerprint, field);
    }
    const secret = structuredClone(original.outcome);
    secret.redactedSecrets = [{ semanticId: 'secret:one', present: true, type: 'string', contextDigest: digest('context') }];
    const next = bindFixture(secret, original.options);
    assert.notEqual(next.outcome.outcomeFingerprint, original.outcome.outcomeFingerprint);
    assert.equal(next.outcome.producerStatus, 'success');
});

test('unknown fields and missing dispositions fail closed at every depth', () =>
{
    const member = producerFixture();
    for (const change of [
        (value) =>
        {
            value.newSemanticField = true;
        },
        (value) =>
        {
            value.assertions[0].newSemanticField = true;
        },
        (value) =>
        {
            value.artifactSemanticDigests[0].newDigest = digest('new');
        }
    ])
    {
        const value = structuredClone(member.outcome);
        change(value);
        assert.throws(() => analyzeStrongSemanticOutcome(sealContentDigest(value), member.options), /unknown/u);
    }
    assert.throws(() => analyzeStrongSemanticOutcome(member.outcome, member.options, { businessClock: 1 }), /unknown/u);
    const options = structuredClone(member.options);
    options.fieldDispositions.canonicalization.schemas[1].fields.pop();
    assert.throws(() => analyzeStrongSemanticOutcome(member.outcome, options), /coverage/u);
});

test('duplicate IDs invalid partitions content tamper and cross-run expectations are refused', () =>
{
    const member = producerFixture();
    const duplicated = structuredClone(member.outcome);
    duplicated.assertions.push(duplicated.assertions[0]);
    assert.throws(() => analyzeStrongSemanticOutcome(sealContentDigest(duplicated), member.options), /duplicate/u);
    const invalid = sealContentDigest({ ...member.outcome, failedTestIds: member.outcome.passedTestIds });
    assert.throws(() => analyzeStrongSemanticOutcome(invalid, member.options), /overlapping/u);
    assert.throws(() => analyzeStrongSemanticOutcome({ ...member.outcome, contentDigest: digest('wrong') }, member.options), /content digest/u);
    const options = structuredClone(member.options);
    options.expected.identity.schedulerRunId = 'other-run';
    assert.throws(() => analyzeStrongSemanticOutcome(member.outcome, options), /schedulerRunId mismatch/u);
});

test('schema algorithm and registry mismatches are explicit errors', () =>
{
    const member = producerFixture();
    for (const field of ['schema', 'schemaVersion', 'fingerprintAlgorithmVersion'])
    {
        assert.throws(() => analyzeStrongSemanticOutcome(sealContentDigest({ ...member.outcome, [field]: 'different' }), member.options), /version|value mismatch/u);
    }
    const options = structuredClone(member.options);
    options.fieldDispositions.schemaVersion = '3';
    assert.throws(() => analyzeStrongSemanticOutcome(member.outcome, options), /version|invalid/u);
});

test('accessors proxies cycles special objects and missing or exhausted budgets never reach hashing', () =>
{
    const member = producerFixture();
    let calls = 0;
    const value = { ...member.outcome };
    Object.defineProperty(value, 'producerId', { enumerable: true, get()
    {
        calls += 1;
        return 'bad';
    } });
    assert.throws(() => analyzeStrongSemanticOutcome(value, member.options), /accessor/u);
    const proxy = new Proxy(value, { ownKeys()
    {
        calls += 1;
        return [];
    } });
    assert.throws(() => analyzeStrongSemanticOutcome(proxy, member.options), /plain JSON/u);
    assert.equal(calls, 0);
    assert.throws(() => analyzeStrongSemanticOutcome(member.outcome, {}), /host limits/u);
    const cyclic = { ...member.outcome };
    cyclic.loop = cyclic;
    assert.throws(() => analyzeStrongSemanticOutcome(cyclic, member.options), /cyclic/u);
    assert.throws(() => analyzeStrongSemanticOutcome(member.outcome, member.options, { generatedAt: new Date() }), /prototype/u);
    for (const key of Object.keys(member.options.hostExpectedLimits))
    {
        assert.throws(() => analyzeStrongSemanticOutcome(member.outcome, { ...member.options,
            hostExpectedLimits: { ...member.options.hostExpectedLimits, [key]: 1 } }), /budget/u);
    }
});
