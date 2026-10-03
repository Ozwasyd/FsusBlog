import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptReleaseProjectionSemanticOutcome } from '../../tools/test-matrix/outcomes/release-projection-adapter.mjs';
import { adaptImmutableBuildSemanticOutcome } from '../../tools/test-matrix/outcomes/immutable-build-adapter.mjs';
import { adaptReleaseFinalizerSemanticOutcome } from '../../tools/test-matrix/outcomes/release-finalizer-adapter.mjs';
import { validateOutcomeFieldDispositions } from '../../tools/test-matrix/outcomes/outcome-contract.mjs';
import { analyzeProducerSemanticOutcomeCandidate, sealVerifiedProducerSemanticOutcome } from '../../tools/test-matrix/outcomes/producer-outcome-analysis.mjs';
import { sealContentDigest, digestCanonical } from '../../tools/test/attempt-provenance.mjs';

const digest = (digit) => `sha256:${digit.repeat(64)}`;
const identity = Object.freeze({ buildIdentity: digest('1'), executionEnvelopeDigest: digest('2'),
    producerId: 'release-projection-semantic-outcome', replayPlanDigest: digest('3'),
    schedulerRunId: 'fixture-run', sourceCommit: '4'.repeat(40), temporalContextDigest: digest('5'),
    toolchainDigest: digest('6'), worktreeFingerprint: digest('7') });

function fixture(ids = ['a', 'b'])
{
    return adaptReleaseProjectionSemanticOutcome({ identity,
        inputAuthorityRefs: [{ kind: 'projection', path: 'fixtures/projection.json', digest: digest('8') }],
        attemptEligibility: { aggregateDigest: digest('9'), attemptDigest: digest('a'),
            attemptNumber: 1, cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true },
        plan: { projectionIds: ids }, evidence: { producedIds: ids, verifiedIds: ids,
            failedIds: [], blockedIds: [], semanticDigests: Object.fromEntries(ids.map((id) => [id, digest('b')])) } });
}

function analyze(candidate = fixture(), metadata = {}, expectedIdentity = identity)
{
    return analyzeProducerSemanticOutcomeCandidate(candidate, { expectedIdentity,
        expectedProducerId: identity.producerId,
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs', metadata });
}

function reseal(candidate, membership)
{
    return sealContentDigest({ ...candidate, outcome: { ...candidate.outcome,
        membership, semanticPayloadDigest: digestCanonical(membership) } });
}

test('original adapter candidate produces immutable versioned data-only analysis, not authority', () =>
{
    const analysis = analyze();
    assert.equal(analysis.dataOnly, true);
    assert.equal(analysis.producerVerificationPending, true);
    assert.equal(analysis.version.registryVersion, '2');
    assert.equal(Object.isFrozen(analysis.summary.membership), true);
    assert.throws(() => sealVerifiedProducerSemanticOutcome(analysis), /independent authority bridge/u);
});

test('registered volatile and diagnostic metadata cannot change the semantic fingerprint', () =>
{
    const first = analyze(fixture(), { generatedAt: 'first', durationMs: 1, pid: 2, port: 3,
        path: '/run/one/log', errorText: 'first text', stack: 'line one' });
    const second = analyze(fixture(), { generatedAt: 'second', durationMs: 10, pid: 20, port: 30,
        path: '/run/two/log', errorText: 'second text', stack: 'line two' });
    assert.notDeepEqual(first.metadata, second.metadata);
    assert.equal(first.outcomeFingerprint, second.outcomeFingerprint);
});

test('semantic ID array ordering is normalized without sorting away membership changes', () =>
{
    const original = fixture();
    const membership = { ...original.outcome.membership, requiredProjectionIds: ['b', 'a'],
        producedProjectionIds: ['b', 'a'], verifiedProjectionIds: ['b', 'a'] };
    assert.equal(analyze(original).outcomeFingerprint, analyze(reseal(original, membership)).outcomeFingerprint);
    assert.notEqual(analyze(fixture(['a'])).outcomeFingerprint, analyze(original).outcomeFingerprint);
});

test('nested unknown fields remain rejected even after the complete candidate is resealed', () =>
{
    const original = fixture();
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership, unknownState: 'ignored' })), /unknown field/u);
    assert.throws(() => analyze(original, { newMetadata: 1 }), /unknown field/u);
});

test('duplicate and unplanned IDs fail closed after resealing', () =>
{
    const original = fixture();
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        producedProjectionIds: ['a', 'a', 'b'] })), /duplicate/u);
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        producedProjectionIds: ['a', 'b', 'c'] })), /extra or unplanned/u);
});

test('success cannot launder missing passed membership or overlapping terminal sets', () =>
{
    const original = fixture();
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        verifiedProjectionIds: ['a'], semanticDigests: { a: digest('b') } })), /incomplete/u);
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        failedProjectionIds: ['a'] })), /overlap/u);
});

test('declared artifact digests affect the fingerprint and undeclared map members are rejected', () =>
{
    const original = fixture();
    const changed = reseal(original, { ...original.outcome.membership,
        semanticDigests: { a: digest('c'), b: digest('b') } });
    assert.notEqual(analyze(original).outcomeFingerprint, analyze(changed).outcomeFingerprint);
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        semanticDigests: { a: digest('b'), b: digest('b'), extra: digest('c') } })), /digest map/u);
});

test('candidate and adapter membership digest tamper are independently rejected', () =>
{
    const original = fixture();
    assert.throws(() => analyze({ ...original, contentDigest: digest('c') }), /digest mismatch/u);
    assert.throws(() => analyze(sealContentDigest({ ...original,
        outcome: { ...original.outcome, semanticPayloadDigest: digest('c') } })), /membership digest/u);
});

test('the expected original identity must be supplied independently of the candidate', () =>
{
    assert.throws(() => analyze(fixture(), {}, { ...identity, schedulerRunId: 'other-run' }), /cross-run/u);
    assert.throws(() => analyzeProducerSemanticOutcomeCandidate(fixture(), {}), /external expected/u);
    assert.throws(() => analyzeProducerSemanticOutcomeCandidate(fixture(), { expectedIdentity: identity,
        expectedProducerId: identity.producerId, expectedAuthorityId: 'other-authority' }), /authority/u);
});

test('input reference seals are retained for diagnostics, not raw receipt hashing', () =>
{
    const original = fixture();
    const changed = sealContentDigest({ ...original, inputAuthorityRefs: [
        { kind: 'projection', path: 'fixtures/second.json', digest: digest('c') }] });
    assert.notDeepEqual(analyze(original).inputAuthorityRefs, analyze(changed).inputAuthorityRefs);
    assert.equal(analyze(original).outcomeFingerprint, analyze(changed).outcomeFingerprint);
    assert.throws(() => analyze(sealContentDigest({ ...original, inputAuthorityRefs: [
        { kind: 'projection', path: '../outside.json', digest: digest('8') }] })), /repository-relative/u);
});

test('redacted secret fields cannot self-certify the missing semantic-context authority', () =>
{
    assert.throws(() => analyze(fixture(), { secretContext: 'cleartext' }), /plain object/u);
    assert.throws(() => analyze(fixture(), { secretContext: { present: false, type: 'string', digest: null } }), /semantic-context authority/u);
    assert.throws(() => analyze(fixture(), { secretContext: { present: true, type: 'string', digest: digest('c') } }), /semantic-context authority/u);
    assert.throws(() => analyze(fixture(), { secretContext: { present: false, type: 'string', digest: digest('c') } }), /presence/u);
});

test('canonical failure identity changes the fingerprint while message diagnostics do not', () =>
{
    const original = fixture();
    const failed = (kind, identityField) => sealContentDigest({ ...original,
        outcome: { ...original.outcome, status: 'failed', requiredMembershipVerified: false,
            reasons: [{ kind, producerId: identity.producerId,
                identity: { producerId: identity.producerId, ...identityField } }] } });
    const state = failed('product.state-mismatch', { semanticId: 'a' });
    const assertion = failed('product.assertion', { assertionId: 'a' });
    assert.notEqual(analyze(state).outcomeFingerprint, analyze(assertion).outcomeFingerprint);
    assert.equal(analyze(state, { errorText: 'first message' }).outcomeFingerprint,
        analyze(state, { errorText: 'new message' }).outcomeFingerprint);
});

test('nonfinite diagnostic numbers and unknown nested reason fields are rejected', () =>
{
    assert.throws(() => analyze(fixture(), { durationMs: Infinity }), /finite/u);
    const original = fixture();
    assert.throws(() => analyze(sealContentDigest({ ...original, outcome: { ...original.outcome,
        status: 'failed', requiredMembershipVerified: false,
        reasons: [{ kind: 'product.assertion', producerId: identity.producerId,
            identity: { producerId: identity.producerId, assertionId: 'a', message: 'hidden' } }] } })), /fields/u);
});

test('old or unknown candidate versions and unregistered producer families cannot be analyzed', () =>
{
    assert.throws(() => analyze(sealContentDigest({ ...fixture(), schemaVersion: '2' })), /schema/u);
    assert.throws(() => analyzeProducerSemanticOutcomeCandidate(sealContentDigest({ ...fixture(),
        producerId: 'unregistered', identity: { ...identity, producerId: 'unregistered' } }), {
        expectedIdentity: { ...identity, producerId: 'unregistered' }, expectedProducerId: 'unregistered',
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs' }), /unregistered/u);
});

test('actual immutable-build adapter retains all four artifact digest dimensions and assertion membership', () =>
{
    const producerId = 'immutable-build-semantic-outcome';
    const input = { ...identity, producerId };
    const base = fixture();
    const candidate = adaptImmutableBuildSemanticOutcome({ identity: input,
        inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
        plan: { artifactIds: ['build'], verificationAssertionIds: ['assertion'] },
        evidence: { artifacts: [{ id: 'build', verified: true, contentDigest: digest('a'),
            manifestDigest: digest('b'), provenanceDigest: digest('c'), imageDigest: null }],
        verificationAssertions: [{ id: 'assertion', status: 'passed' }] } });
    const result = analyzeProducerSemanticOutcomeCandidate(candidate, { expectedIdentity: input,
        expectedProducerId: producerId, expectedAuthorityId: 'tools/test-matrix/outcomes/immutable-build-adapter.mjs' });
    assert.equal(result.summary.membership.artifactSemanticDigests.build.imageDigest, null);
    assert.deepEqual(result.summary.membership.verificationAssertionIds, ['assertion']);
    assert.equal(result.producerVerificationPending, true);
});

test('actual finalizer adapter cannot omit a verified required input under a resealed success', () =>
{
    const producerId = 'release-finalizer-semantic-outcome';
    const input = { ...identity, producerId };
    const base = fixture();
    const candidate = adaptReleaseFinalizerSemanticOutcome({ identity: input,
        inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
        plan: { inputIds: ['input'], outputIds: ['output'] },
        evidence: { consumedIds: ['input'], verifiedIds: ['input'], failedIds: [], blockedIds: [],
            producedOutputIds: ['output'], outputDigests: { output: digest('c') } } });
    const options = { expectedIdentity: input, expectedProducerId: producerId,
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs' };
    assert.equal(analyzeProducerSemanticOutcomeCandidate(candidate, options).dataOnly, true);
    assert.throws(() => analyzeProducerSemanticOutcomeCandidate(reseal(candidate, {
        ...candidate.outcome.membership, verifiedInputIds: [] }), options), /incomplete/u);
});

test('accessors, sparse arrays and enumerable extra array fields are not canonical JSON input', () =>
{
    const metadata = {};
    Object.defineProperty(metadata, 'errorText', { get() { throw new Error('must not be invoked'); }, enumerable: true });
    assert.throws(() => analyze(fixture(), metadata), /JSON data fields/u);
    const original = fixture();
    const sparse = ['a', 'b'];
    delete sparse[0];
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        producedProjectionIds: sparse })), /dense JSON/u);
    const extra = ['a', 'b'];
    extra.extra = 'unregistered';
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        producedProjectionIds: extra })), /dense JSON/u);
});

test('distinct same-kind authority refs preserve the original source-input closure without ambiguity', () =>
{
    const original = fixture();
    const references = [{ kind: 'repository-authority', path: 'fixtures/one.json', digest: digest('a') },
        { kind: 'repository-authority', path: 'fixtures/two.json', digest: digest('b') }];
    const first = sealContentDigest({ ...original, inputAuthorityRefs: references });
    const second = sealContentDigest({ ...original, inputAuthorityRefs: [...references].reverse() });
    assert.equal(analyze(first).outcomeFingerprint, analyze(second).outcomeFingerprint);
    assert.throws(() => analyze(sealContentDigest({ ...original,
        inputAuthorityRefs: [references[0], references[0]] })), /duplicate or ambiguous/u);
});

test('the single registry migrates explicitly and refuses old version, unknown nested policy and duplicate disposition', () =>
{
    const original = validateOutcomeFieldDispositions();
    assert.equal(original.entries.length, 10);
    assert.throws(() => validateOutcomeFieldDispositions({ ...original,
        schema: 'fsusblog.outcome-field-dispositions.v1', schemaVersion: '1' }), /registry is invalid/u);
    assert.throws(() => validateOutcomeFieldDispositions({ ...original,
        canonicalization: { ...original.canonicalization, unknown: true } }), /fields/u);
    const duplicate = structuredClone(original);
    duplicate.canonicalization.nestedFields.push(duplicate.canonicalization.nestedFields[0]);
    assert.throws(() => validateOutcomeFieldDispositions(duplicate), /duplicate/u);
    const unowned = structuredClone(original);
    unowned.canonicalization.profiles[0].fields[0].owner = '';
    assert.throws(() => validateOutcomeFieldDispositions(unowned), /unowned/u);
});
