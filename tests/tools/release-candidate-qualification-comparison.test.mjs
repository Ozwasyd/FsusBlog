import assert from 'node:assert/strict';
import test from 'node:test';

const { compareQualificationSemantics, comparisonMaterialFromAggregateAnalysis } = await import(new URL(
    '../../tools/release-candidate/qualification-comparison.mjs', import.meta.url
));

function materials()
{
    return [1, 2, 3].map((ordinal) => ({
        ordinal,
        runId: `fixture-run-${ordinal}`,
        aggregateOutcomeFingerprint: `sha256:${'a'.repeat(64)}`,
        stateSemanticDigests: { database: `sha256:${'b'.repeat(64)}` },
        artifactSemanticDigests: { artifact: `sha256:${'c'.repeat(64)}` },
        failureTopology: []
    }));
}

test('three exact semantic materials with distinct run IDs compare equal without granting qualification', () =>
{
    const result = compareQualificationSemantics(materials());
    assert.equal(result.equal, true);
    assert.equal(result.comparisonOnly, true);
    assert.equal(Object.hasOwn(result, 'finalStatus'), false);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
    assert.ok(Object.values(result.comparisons).every((value) => value.equal && value.differences.length === 0));
});

test('two/four ordinals, duplicate IDs, recent-three selection and reordered slots cannot compare', () =>
{
    const source = materials();
    for (const variant of [source.slice(0, 2), [...source, { ...source[2], ordinal: 4 }],
        [source[0], source[2], source[1]], [source[0], { ...source[1], runId: source[0].runId }, source[2]],
        source.map((value) => ({ ...value, ordinal: value.ordinal + 3 }))])
    {
        assert.throws(() => compareQualificationSemantics(variant));
    }
});

test('two-of-three and last-green equality cannot hide fingerprint, state, artifact or failure topology drift', () =>
{
    for (const field of ['aggregateOutcomeFingerprint', 'stateSemanticDigests', 'artifactSemanticDigests', 'failureTopology'])
    {
        for (const index of [0, 1, 2])
        {
            const source = materials();
            source[index][field] = field === 'failureTopology' ? [{ producerId: 'producer', testId: 'test', failureKind: 'product.assertion' }]
                : field === 'aggregateOutcomeFingerprint' ? `sha256:${'d'.repeat(64)}` : { changed: `sha256:${'d'.repeat(64)}` };
            const result = compareQualificationSemantics(source);
            assert.equal(result.equal, false);
            assert.equal(result.comparisons[field].equal, false);
            assert.ok(result.comparisons[field].differences.every((difference) => difference.field === field && difference.ordinals.length === 2));
        }
    }
});

test('unknown fields, status-only and malformed digest material are refused rather than ignored', () =>
{
    for (const mutation of [
        { status: 'success' }, { aggregateOutcomeFingerprint: 'success' }, { stateSemanticDigests: [] },
        { artifactSemanticDigests: { artifact: 'unsealed' } }, { failureTopology: null }, { startedAt: 'volatile' }
    ])
    {
        const source = materials();
        source[0] = { ...source[0], ...mutation };
        assert.throws(() => compareQualificationSemantics(source));
    }
    assert.throws(() => compareQualificationSemantics([1, 2, 3].map((ordinal) => ({ ordinal, runId: `run-${ordinal}`, status: 'success' }))));
});

test('actual aggregate analysis shape is projected without fingerprint rewriting or DATA_ONLY authority promotion', () =>
{
    const digest = `sha256:${'a'.repeat(64)}`;
    const analysis = {
        schema: 'fsusblog.strong-outcome-analysis.v1', dataOnly: true, producerVerificationPending: true,
        inputContentDigest: digest, outcomeFingerprint: digest,
        canonicalOutcome: {
            schema: 'fsusblog.aggregate-run-outcome.v1', runId: 'controlled-run', contentDigest: digest,
            aggregateOutcomeFingerprint: digest,
            stateSemanticDigests: [{ semanticId: 'state', owner: 'database', digest }],
            artifactSemanticDigests: [{ semanticId: 'artifact', owner: 'build', digest }],
            failureTopology: []
        }
    };
    const material = comparisonMaterialFromAggregateAnalysis(analysis, 1);
    assert.equal(material.aggregateOutcomeFingerprint, analysis.outcomeFingerprint);
    assert.deepEqual(material.stateSemanticDigests, { state: digest });
    assert.deepEqual(material.artifactSemanticDigests, { artifact: digest });
    assert.equal(Object.hasOwn(material, 'qualificationEligible'), false);
    for (const mutation of [{ dataOnly: false }, { producerVerificationPending: false },
        { outcomeFingerprint: `sha256:${'b'.repeat(64)}` }, { inputContentDigest: `sha256:${'b'.repeat(64)}` }])
    {
        assert.throws(() => comparisonMaterialFromAggregateAnalysis({ ...analysis, ...mutation }, 1));
    }
    for (const mutation of [
        { stateSemanticDigests: [...analysis.canonicalOutcome.stateSemanticDigests, ...analysis.canonicalOutcome.stateSemanticDigests] },
        { artifactSemanticDigests: [{ semanticId: 'artifact', digest }] },
        { stateSemanticDigests: [{ semanticId: 'state', owner: 'database', digest, ignored: true }] }
    ])
    {
        assert.throws(() => comparisonMaterialFromAggregateAnalysis({ ...analysis, canonicalOutcome: { ...analysis.canonicalOutcome, ...mutation } }, 1));
    }
});
