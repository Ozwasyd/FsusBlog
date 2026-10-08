import assert from 'node:assert/strict';
import test from 'node:test';

const {verifyCommentScaleContentArtifact, verifyCommentScaleTemporalArtifact} = await import(new URL('../../tools/data-scale/comment-scale-artifact-adapters.mjs', import.meta.url));
const {generateContentShape} = await import(new URL('../../tools/test-fixtures/content-shape-generator.mjs', import.meta.url));
const {contentShapeCatalogDigest, projectContentFieldContracts, readContentShapeAuthority} = await import(new URL('../../tools/testing/content-shape-catalog.mjs', import.meta.url));
const {defaultTimeoutPolicyDigest, qualificationTemporalContext} = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const {resolveTemporalRoles} = await import(new URL('../../tools/test/temporal-role-resolver.mjs', import.meta.url));

function contentInput(request = {})
{
    const stored = readContentShapeAuthority();
    // This independent unit input is the real original current-source producer
    // output. The stale stored projection is neither rewritten nor admitted.
    const authority = Object.freeze({ ...stored, fields: projectContentFieldContracts() });
    // Original generator output is a deterministic unit fixture, not a receipt.
    const document = generateContentShape({
        shapeId: 'script.latin-basic', fieldId: 'comment.content',
        fixedSeed: 'comment-scale-adapter-unit', authority, ...request
    });
    return {
        document,
        contentRole: 'comment-body',
        authority,
        expected: {
            contentRole: 'comment-body',
            shapeId: document.shapeId,
            contentReference: { schema: document.schema, contentDigest: document.outputDigest },
            catalogReference: { schema: authority.catalog.schema, contentDigest: contentShapeCatalogDigest(authority) }
        }
    };
}

function temporalInput()
{
    // These are explicit unit identities and the original sealed context helper;
    // they do not describe an observed production clock or source receipt.
    const temporalContext = qualificationTemporalContext({
        sourceCommit: 'a'.repeat(40),
        sourceFingerprint: `sha256:${'b'.repeat(64)}`,
        producerId: 'comment-moderation',
        schedulerRunId: 'comment-scale-adapter-unit',
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        locale: 'en-US', uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
    });
    const fixtureIdentity = {
        producerId: temporalContext.producerId,
        runId: temporalContext.schedulerRunId,
        namespace: 'comment_scale_adapter_unit',
        fixtureId: 'generic-binding',
        planDigest: `sha256:${'c'.repeat(64)}`
    };
    // The real catalog currently owns these fixture roles, not comment roles.
    const shapeId = 'recent-history';
    const roleIds = ['fixture.command-time', 'fixture.boundary-time'];
    const artifact = resolveTemporalRoles({ temporalContext, fixtureIdentity, shapeId, roleIds });
    return {
        artifact,
        temporalContext,
        expected: {
            fixtureIdentity, shapeId, roleIds,
            artifactReference: { schema: artifact.schema, contentDigest: artifact.contentDigest }
        }
    };
}

test('content adapter verifies real positive comment content and freezes a detached original artifact', () =>
{
    const input = contentInput({ shapeId: 'script.emoji-zwj' });
    const supplied = structuredClone(input.document);
    const output = verifyCommentScaleContentArtifact({ ...input, document: supplied });
    assert.deepEqual(output, supplied);
    assert.notEqual(output, supplied);
    assert.equal(Object.isFrozen(output.statistics), true);
    assert.equal(Object.isFrozen(output.expectedRejectionReasons), true);
    assert.equal(Object.isFrozen(supplied.statistics), false);
    assert.throws(() =>
    {
        output.statistics.utf8ByteCount = 0;
    }, TypeError);
    supplied.statistics.utf8ByteCount = 0;
    assert.equal(output.statistics.utf8ByteCount, input.document.statistics.utf8ByteCount);
    assert.equal(Object.hasOwn(output, 'qualificationEligible'), false);
});

test('content adapter refuses real negative eligibility and invalid production boundaries', () =>
{
    for (const request of [
        { shapeId: 'negative.bidi' },
        { shapeId: 'negative.zero-width' },
        { boundaryCaseId: 'comment.content.characters.max-plus-one-negative' }
    ])
    {
        const input = contentInput(request);
        assert.equal(input.document.expectedValidity, false);
        assert.throws(() => verifyCommentScaleContentArtifact(input), /content (eligibility|validity)/u);
    }
});

test('content adapter binds field, caller role, shape and independent artifact/catalog references', () =>
{
    const input = contentInput();
    const articleInput = contentInput({ fieldId: 'article.body' });
    assert.throws(() => verifyCommentScaleContentArtifact(articleInput), /content field/u);
    const variants = [
        { ...input, contentRole: 'other-body' },
        { ...input, expected: { ...input.expected, contentRole: 'other-body' } },
        { ...input, expected: { ...input.expected, shapeId: 'script.zh-hans' } },
        ...['contentReference', 'catalogReference'].flatMap((key) => [
            { ...input, expected: { ...input.expected, [key]: { ...input.expected[key], schema: 'wrong-schema' } } },
            { ...input, expected: { ...input.expected, [key]: { ...input.expected[key], contentDigest: `sha256:${'0'.repeat(64)}` } } }
        ])
    ];
    for (const variant of variants)
    {
        assert.throws(() => verifyCommentScaleContentArtifact(variant), /does not match/u);
    }
});

test('content adapter requires supplied originals and preserves original tamper rejection', () =>
{
    const input = contentInput();
    for (const key of ['authority', 'contentRole', 'expected'])
    {
        assert.throws(() => verifyCommentScaleContentArtifact({ ...input, [key]: undefined }), /required/u);
    }
    for (const key of ['contentRole', 'shapeId', 'contentReference', 'catalogReference'])
    {
        assert.throws(() => verifyCommentScaleContentArtifact({ ...input, expected: { ...input.expected, [key]: undefined } }), /required/u);
    }
    for (const document of [
        { ...input.document, exactText: `${input.document.exactText}x` },
        { ...input.document, statistics: { ...input.document.statistics, utf8ByteCount: 0 } },
        { ...input.document, outputDigest: `sha256:${'0'.repeat(64)}` }
    ])
    {
        assert.throws(() => verifyCommentScaleContentArtifact({ ...input, document }), /tamper detected/u);
    }
});

test('temporal adapter re-resolves actual generic roles and freezes the original format without qualification', () =>
{
    const input = temporalInput();
    const supplied = structuredClone(input.artifact);
    const output = verifyCommentScaleTemporalArtifact({ ...input, artifact: supplied });
    assert.deepEqual(output, supplied);
    assert.notEqual(output, supplied);
    for (const nested of [output.contextIdentity, output.fixtureIdentity, output.roles, output.roles[0], output.roles[0].localRepresentation, output.relations, output.clockAdvancePlan])
    {
        assert.equal(Object.isFrozen(nested), true);
    }
    assert.equal(Object.isFrozen(supplied.roles[0]), false);
    assert.throws(() =>
    {
        output.roles[0].instantUtc = 'changed';
    }, TypeError);
    supplied.roles[0].instantUtc = 'changed';
    assert.equal(output.roles[0].instantUtc, input.artifact.roles[0].instantUtc);
    assert.equal(Object.hasOwn(output, 'qualificationEligible'), false);
});

test('temporal adapter rejects cross-fixture, plan, shape, roster and reference substitution', () =>
{
    const input = temporalInput();
    const variants = [
        ...['namespace', 'fixtureId', 'planDigest'].map((key) => ({
            ...input,
            expected: {
                ...input.expected,
                fixtureIdentity: { ...input.expected.fixtureIdentity, [key]: key === 'planDigest' ? `sha256:${'d'.repeat(64)}` : 'different-fixture' }
            }
        })),
        { ...input, expected: { ...input.expected, shapeId: 'calendar-boundaries' } },
        { ...input, expected: { ...input.expected, roleIds: ['fixture.command-time'] } },
        ...['schema', 'contentDigest'].map((key) => ({
            ...input,
            expected: { ...input.expected, artifactReference: { ...input.expected.artifactReference, [key]: key === 'schema' ? 'wrong-schema' : `sha256:${'0'.repeat(64)}` } }
        }))
    ];
    for (const variant of variants)
    {
        assert.throws(() => verifyCommentScaleTemporalArtifact(variant));
    }
    const changedContext = qualificationTemporalContext({
        ...input.temporalContext, businessEpochUtc: '2024-03-01T00:00:00.000Z'
    });
    assert.throws(() => verifyCommentScaleTemporalArtifact({ ...input, temporalContext: changedContext }), /context/u);
});

test('temporal adapter requires explicit independent context, fixture, reference and nonempty role roster', () =>
{
    const input = temporalInput();
    for (const key of ['temporalContext', 'expected'])
    {
        assert.throws(() => verifyCommentScaleTemporalArtifact({ ...input, [key]: undefined }), /required/u);
    }
    for (const key of ['fixtureIdentity', 'shapeId', 'artifactReference'])
    {
        assert.throws(() => verifyCommentScaleTemporalArtifact({ ...input, expected: { ...input.expected, [key]: undefined } }), /required/u);
    }
    for (const roleIds of [undefined, [], ['fixture.command-time', 'fixture.command-time']])
    {
        assert.throws(() => verifyCommentScaleTemporalArtifact({ ...input, expected: { ...input.expected, roleIds } }));
    }
    for (const key of ['producerId', 'runId'])
    {
        assert.throws(() => verifyCommentScaleTemporalArtifact({
            ...input,
            expected: { ...input.expected, fixtureIdentity: { ...input.expected.fixtureIdentity, [key]: 'different-producer' } }
        }), /context/u);
    }
});

test('temporal adapter keeps original role tamper rejection and refuses unowned comment shape or roles', () =>
{
    const input = temporalInput();
    const changed = structuredClone(input.artifact);
    changed.roles[0].instantUtc = '2024-03-01T00:00:00.000Z';
    assert.throws(() => verifyCommentScaleTemporalArtifact({ ...input, artifact: changed }));
    // comment-lifecycle is an invariant registry entry, not an owned shape.
    assert.throws(() => verifyCommentScaleTemporalArtifact({
        ...input, expected: { ...input.expected, shapeId: 'comment-lifecycle' }
    }));
    // A registry role alone does not grant ownership to a generic fixture shape.
    assert.throws(() => verifyCommentScaleTemporalArtifact({
        ...input, expected: { ...input.expected, roleIds: ['comment.created'] }
    }), /not owned/u);
});
