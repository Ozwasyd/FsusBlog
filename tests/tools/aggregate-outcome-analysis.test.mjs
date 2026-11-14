import assert from 'node:assert/strict';
import test from 'node:test';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { prepareAggregateOutcomeAnalysis } = await import(new URL('../../tools/test-matrix/outcomes/aggregate-outcome-analysis.mjs', import.meta.url));
import { aggregateOptions, bindFixture, digest, producerFixture } from './support/semantic-outcome-analysis-fixture.mjs';

test('aggregate constructs exact unions refs status vectors and deterministic fingerprints', () =>
{
    const members = [producerFixture(0), producerFixture(1)];
    const options = aggregateOptions(members);
    const result = prepareAggregateOutcomeAnalysis(options, members);
    assert.equal(result.dataOnly, true);
    assert.equal(result.producerVerificationPending, true);
    assert.equal(result.canonicalOutcome.completenessStatus, 'complete');
    assert.deepEqual(result.canonicalOutcome.plannedTestIds, members.flatMap((item) => item.outcome.plannedTestIds).sort());
    assert.deepEqual(result.canonicalOutcome.observedCoverageIds, options.expected.requiredCoverageIds);
    assert.deepEqual(result.canonicalOutcome.producerOutcomeRefs.map((item) => item.contentDigest), members.map((item) => item.outcome.contentDigest));
    assert.equal(result.canonicalOutcome.aggregateOutcomeFingerprint, result.outcomeFingerprint);
    assert.equal(prepareAggregateOutcomeAnalysis(options, [...members].reverse()).outcomeFingerprint, result.outcomeFingerprint);
    assert.ok(Object.isFrozen(result.canonicalOutcome.producerOutcomeRefs));
});

test('missing duplicate extra and unverified fingerprints cannot be aggregated', () =>
{
    const members = [producerFixture(0), producerFixture(1)];
    const options = aggregateOptions(members);
    for (const invalid of [members.slice(0, 1), [...members, members[0]], [...members, producerFixture(2)]])
    {
        assert.throws(() => prepareAggregateOutcomeAnalysis(options, invalid), /membership/u);
    }
    const tampered = structuredClone(members[0]);
    tampered.outcome = sealContentDigest({ ...tampered.outcome, outcomeFingerprint: digest('fake') });
    tampered.options.expected.outcomeFingerprint = tampered.outcome.outcomeFingerprint;
    assert.throws(() => prepareAggregateOutcomeAnalysis(options, [tampered, members[1]]), /fingerprint mismatch/u);
    assert.throws(() => prepareAggregateOutcomeAnalysis({ ...options, verified: true }, members), /fields are not exact/u);
});

test('failed partial blocked and cancelled members retain topology and cannot become complete', () =>
{
    for (const status of ['failed', 'partial', 'blocked', 'cancelled'])
    {
        const members = [producerFixture(0), producerFixture(1, status)];
        const result = prepareAggregateOutcomeAnalysis(aggregateOptions(members), members);
        assert.equal(result.canonicalOutcome.completenessStatus, 'incomplete');
        assert.equal(result.canonicalOutcome.producerStatusVector[1].status, status);
        assert.deepEqual(result.canonicalOutcome.failureTopology, members[1].outcome.failures);
    }
});

test('cross-run source worktree and external producer envelope identities fail closed', () =>
{
    const members = [producerFixture(0), producerFixture(1)];
    const options = aggregateOptions(members);
    for (const field of ['schedulerRunId', 'sourceCommit', 'worktreeFingerprint'])
    {
        const value = structuredClone(members[1].outcome);
        value[field] = field === 'sourceCommit' ? '2'.repeat(40) : field === 'worktreeFingerprint' ? digest('other') : 'other-run';
        const next = bindFixture(value, members[1].options);
        assert.throws(() => prepareAggregateOutcomeAnalysis(options, [members[0], next]), /member .*mismatch/u);
    }
    const next = structuredClone(members[1]);
    next.options.expected.identity.executionEnvelopeDigest = digest('other');
    assert.throws(() => prepareAggregateOutcomeAnalysis(options, [members[0], next]), /executionEnvelopeDigest mismatch/u);
});

test('required coverage gap is incomplete and declared semantic state or artifact gaps reject', () =>
{
    const members = [producerFixture()];
    const options = aggregateOptions(members);
    options.expected.requiredCoverageIds.push('coverage:missing');
    assert.equal(prepareAggregateOutcomeAnalysis(options, members).canonicalOutcome.completenessStatus, 'incomplete');
    for (const field of ['stateSemanticDigests', 'artifactSemanticDigests'])
    {
        const wrong = aggregateOptions(members);
        wrong.expected[field] = [];
        assert.throws(() => prepareAggregateOutcomeAnalysis(wrong, members), /expected .*mismatch/u);
    }
});

test('aggregate preserves input bytes and refuses status rewrites and ambiguous test ownership', () =>
{
    const members = [producerFixture(0), producerFixture(1)];
    const before = JSON.stringify(members);
    prepareAggregateOutcomeAnalysis(aggregateOptions(members), members);
    assert.equal(JSON.stringify(members), before);
    const failed = producerFixture(1, 'failed');
    failed.outcome = sealContentDigest({ ...failed.outcome, producerStatus: 'success' });
    assert.throws(() => prepareAggregateOutcomeAnalysis(aggregateOptions([members[0], failed]), [members[0], failed]), /status\/eligibility/u);
    const value = structuredClone(members[1].outcome);
    value.plannedTestIds = members[0].outcome.plannedTestIds;
    value.executedTestIds = value.plannedTestIds;
    value.passedTestIds = value.plannedTestIds;
    value.assertions.forEach((item, index) =>
    {
        item.testId = value.plannedTestIds[index];
    });
    const shared = bindFixture(value, members[1].options);
    assert.throws(() => prepareAggregateOutcomeAnalysis(aggregateOptions([members[0], shared]), [members[0], shared]), /multiple producer owners/u);
});
