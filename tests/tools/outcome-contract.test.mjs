import assert from 'node:assert/strict';
import test from 'node:test';

const {readOutcomeFailureTaxonomy, sealProducerSemanticOutcomeCandidate, validateOutcomeFieldDispositions, validateProducerSemanticOutcomeCandidate} = await import(new URL('../../tools/test-matrix/outcomes/outcome-contract.mjs', import.meta.url));
const digest = (digit) => `sha256:${digit.repeat(64)}`;
const identity = {
    buildIdentity: digest('1'), executionEnvelopeDigest: digest('2'), producerId: 'fixture-producer',
    replayPlanDigest: digest('3'), schedulerRunId: 'fixture-run', sourceCommit: '4'.repeat(40),
    temporalContextDigest: digest('5'), toolchainDigest: digest('6'), worktreeFingerprint: digest('7')
};
const base = {
    producerId: 'fixture-producer', producerAuthorityId: 'fixture-authority', identity,
    inputAuthorityRefs: [{ kind: 'fixture', path: 'fixture.json', digest: digest('8') }],
    attemptEligibility: { aggregateDigest: digest('9'), attemptDigest: digest('a'), attemptNumber: 1,
        cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true },
    outcome: { status: 'success', requiredMembershipVerified: true, reasons: [],
        membership: { ids: ['one'] }, semanticPayloadDigest: digest('b') }
};

test('outcome registries are closed, owned and cover every candidate field', () =>
{
    assert.equal(readOutcomeFailureTaxonomy().size, 20);
    assert.equal(validateOutcomeFieldDispositions().entries.length, 10);
});

test('candidate schema rejects unknown fields, tamper and unknown failure taxonomy', () =>
{
    const candidate = sealProducerSemanticOutcomeCandidate(base);
    assert.equal(validateProducerSemanticOutcomeCandidate(candidate), candidate);
    assert.throws(() => validateProducerSemanticOutcomeCandidate({ ...candidate, latest: true }), /fields/u);
    assert.throws(() => validateProducerSemanticOutcomeCandidate({ ...candidate, producerId: 'changed' }), /crosses|digest/u);
    assert.throws(() => sealProducerSemanticOutcomeCandidate({
        ...base,
        outcome: { ...base.outcome, status: 'failed', requiredMembershipVerified: false,
            reasons: [{ kind: 'unknown.failure', producerId: 'fixture-producer', identity: {} }] }
    }), /unknown or incomplete/u);
});

test('a recovered attempt cannot produce a semantic success candidate', () =>
{
    assert.throws(() => sealProducerSemanticOutcomeCandidate({
        ...base,
        attemptEligibility: { ...base.attemptEligibility, attemptNumber: 2,
            cleanFirstAttempt: false, firstFailure: true, qualificationEligible: false }
    }), /not clean first/u);
});
