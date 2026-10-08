import assert from 'node:assert/strict';
import test from 'node:test';

import { heldBuildOutcomeInputs } from './support/build-outcome-held-input-fixture.mjs';

const { adaptImmutableBuildSemanticOutcome, verifyImmutableBuildSemanticOutcomeCandidate } = await import(new URL('../../tools/test-matrix/outcomes/immutable-build-adapter.mjs', import.meta.url));
const { adaptReleaseProjectionSemanticOutcome, verifyReleaseProjectionSemanticOutcomeCandidate } = await import(new URL('../../tools/test-matrix/outcomes/release-projection-adapter.mjs', import.meta.url));
const { adaptReleaseFinalizerSemanticOutcome, verifyReleaseFinalizerSemanticOutcomeCandidate } = await import(new URL('../../tools/test-matrix/outcomes/release-finalizer-adapter.mjs', import.meta.url));
const digest = (digit) => `sha256:${digit.repeat(64)}`;
const producers = [
    {
        producerId: 'immutable-build-semantic-outcome',
        adapt: adaptImmutableBuildSemanticOutcome,
        verify: verifyImmutableBuildSemanticOutcomeCandidate,
        plan: { artifactIds: ['image'], verificationAssertionIds: ['manifest'] },
        evidence: {
            artifacts: [{ id: 'image', contentDigest: digest('a'), manifestDigest: digest('b'),
                provenanceDigest: digest('c'), imageDigest: digest('d'), verified: true }],
            verificationAssertions: [{ id: 'manifest', status: 'passed' }]
        }
    },
    {
        producerId: 'release-projection-semantic-outcome',
        adapt: adaptReleaseProjectionSemanticOutcome,
        verify: verifyReleaseProjectionSemanticOutcomeCandidate,
        plan: { projectionIds: ['projection'] },
        evidence: { producedIds: ['projection'], verifiedIds: ['projection'], failedIds: [],
            blockedIds: [], semanticDigests: { projection: digest('a') } }
    },
    {
        producerId: 'release-finalizer-semantic-outcome',
        adapt: adaptReleaseFinalizerSemanticOutcome,
        verify: verifyReleaseFinalizerSemanticOutcomeCandidate,
        plan: { inputIds: ['upstream'], outputIds: ['binding'] },
        evidence: { consumedIds: ['upstream'], verifiedIds: ['upstream'], failedIds: [],
            blockedIds: [], producedOutputIds: ['binding'], outputDigests: { binding: digest('a') } }
    }
];

function inputs(producer)
{
    return structuredClone({
        identity: { buildIdentity: digest('1'), executionEnvelopeDigest: digest('2'),
            producerId: producer.producerId, replayPlanDigest: digest('3'), schedulerRunId: 'held-run',
            sourceCommit: '4'.repeat(40), temporalContextDigest: digest('5'),
            toolchainDigest: digest('6'), worktreeFingerprint: digest('7') },
        inputAuthorityRefs: [{ kind: 'held-producer-input', path: 'receipt.json', digest: digest('8') }],
        attemptEligibility: { aggregateDigest: digest('9'), attemptDigest: digest('e'), attemptNumber: 1,
            cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true },
        plan: producer.plan,
        evidence: producer.evidence
    });
}

test('all three semantic owners require independent held inputs before success', () =>
{
    for (const producer of producers)
    {
        const value = inputs(producer);
        assert.equal(producer.adapt(value).outcome.status, 'failed', producer.producerId);
        assert.equal(producer.adapt({ ...value, verifyInputs: () => ({ verified: true }) })
            .outcome.status, 'failed', producer.producerId);
        assert.equal(producer.adapt({ ...value, verifyInputs: heldBuildOutcomeInputs(value) })
            .outcome.status, 'success', producer.producerId);
    }
});

test('independently held source, worktree, toolchain, build and run identities refuse drift', () =>
{
    for (const producer of producers)
    {
        const value = inputs(producer);
        const verifyInputs = heldBuildOutcomeInputs(value);
        for (const field of Object.keys(value.identity))
        {
            if (field === 'producerId')
            {
                continue;
            }
            const changed = structuredClone(value);
            changed.identity[field] = field === 'sourceCommit' ? '0'.repeat(40)
                : field === 'schedulerRunId' ? 'foreign-run' : digest('0');
            const candidate = producer.adapt({ ...changed, verifyInputs });
            assert.equal(candidate.outcome.status, 'failed', `${producer.producerId}/${field}`);
            assert(candidate.outcome.reasons.some((reason) => reason.identity.identityField === field));
        }
    }
});

test('well-formed but altered artifact, projection and binding digests cannot replace held evidence', () =>
{
    for (const producer of producers)
    {
        const value = inputs(producer);
        const changed = structuredClone(value);
        if (changed.evidence.artifacts)
        {
            changed.evidence.artifacts[0].contentDigest = digest('0');
        }
        else if (changed.evidence.semanticDigests)
        {
            changed.evidence.semanticDigests.projection = digest('0');
        }
        else
        {
            changed.evidence.outputDigests.binding = digest('0');
        }
        const candidate = producer.adapt({ ...changed, verifyInputs: heldBuildOutcomeInputs(value) });
        assert.equal(candidate.outcome.status, 'failed', producer.producerId);
        assert(candidate.outcome.reasons.some((reason) => reason.identity.identityField === 'evidenceDigest'));
    }
});

test('held plan, input authority and attempt receipt bindings are exact', () =>
{
    for (const producer of producers)
    {
        const value = inputs(producer);
        const verifyInputs = heldBuildOutcomeInputs(value);
        for (const field of ['plan', 'inputAuthorityRefs', 'attemptEligibility'])
        {
            const changed = structuredClone(value);
            if (field === 'plan')
            {
                changed.plan.unheldOutput = 'orphan';
            }
            if (field === 'inputAuthorityRefs')
            {
                changed.inputAuthorityRefs[0].digest = digest('0');
            }
            if (field === 'attemptEligibility')
            {
                changed.attemptEligibility.attemptDigest = digest('0');
            }
            assert.equal(producer.adapt({ ...changed, verifyInputs }).outcome.status, 'failed',
                `${producer.producerId}/${field}`);
        }
    }
});

test('host verification errors fail closed independently of error text', () =>
{
    for (const producer of producers)
    {
        const value = inputs(producer);
        const candidates = ['message one', 'different stderr'].map((message) => producer.adapt({
            ...value, verifyInputs: () =>
            {
                throw new Error(message);
            }
        }));
        assert.equal(candidates[0].outcome.status, 'failed');
        assert.deepEqual(candidates[0].outcome.reasons, candidates[1].outcome.reasons);
    }
});


test('each original owner returns the actual candidate attempt binding for consumer admission', () =>
{
    for (const producer of producers)
    {
        const value = inputs(producer);
        const candidate = producer.adapt({ ...value, verifyInputs: heldBuildOutcomeInputs(value) });
        const expectations = { expectedIdentity: value.identity,
            expectedCandidateDigest: candidate.contentDigest, verificationReceiptDigest: digest('f') };
        const verified = producer.verify(candidate, expectations);
        assert.equal(verified.verified, true);
        assert.deepEqual(verified.attemptEligibility, candidate.attemptEligibility);
        assert.equal(verified.candidateDigest, candidate.contentDigest);
        candidate.attemptEligibility.attemptDigest = digest('0');
        assert.equal(verified.attemptEligibility.attemptDigest, value.attemptEligibility.attemptDigest);
        assert.throws(() => producer.verify(candidate, expectations), /digest/u);
    }
});

test('owner verification requires independent expected candidate digest and full identity', () =>
{
    for (const producer of producers)
    {
        const value = inputs(producer);
        const candidate = producer.adapt({ ...value, verifyInputs: heldBuildOutcomeInputs(value) });
        const expectations = { expectedIdentity: value.identity,
            expectedCandidateDigest: candidate.contentDigest, verificationReceiptDigest: digest('f') };
        for (const field of Object.keys(expectations))
        {
            const missing = { ...expectations };
            delete missing[field];
            assert.throws(() => producer.verify(candidate, missing), /independent/u);
        }
        assert.throws(() => producer.verify(candidate, { ...expectations,
            expectedCandidateDigest: digest('0') }), /digest/u);
        assert.throws(() => producer.verify(candidate, { ...expectations,
            expectedIdentity: {} }), /identity/u);
        assert.throws(() => producer.verify(candidate, { ...expectations,
            expectedIdentity: { ...value.identity, schedulerRunId: 'foreign' } }), /schedulerRunId/u);
    }
});


test('inconsistent later-attempt or first-failure claims produce canonical failed candidates', () =>
{
    for (const producer of producers)
    {
        for (const override of [{ attemptNumber: 2 }, { firstFailure: true }])
        {
            const value = inputs(producer);
            Object.assign(value.attemptEligibility, override);
            const candidate = producer.adapt({ ...value, verifyInputs: heldBuildOutcomeInputs(value) });
            assert.equal(candidate.outcome.status, 'failed');
            assert(candidate.outcome.reasons.some((reason) => reason.identity.evidenceId === 'clean-first-attempt'));
        }
    }
});

test('sealing snapshots input identities, authority refs, attempts and semantic digest maps', () =>
{
    for (const producer of producers)
    {
        const value = inputs(producer);
        const candidate = producer.adapt({ ...value, verifyInputs: heldBuildOutcomeInputs(value) });
        const original = structuredClone(candidate);
        value.identity.schedulerRunId = 'mutated';
        value.inputAuthorityRefs[0].digest = digest('0');
        value.attemptEligibility.attemptDigest = digest('0');
        if (value.evidence.semanticDigests)
        {
            value.evidence.semanticDigests.projection = digest('0');
        }
        if (value.evidence.outputDigests)
        {
            value.evidence.outputDigests.binding = digest('0');
        }
        assert.deepEqual(candidate, original);
    }
});
