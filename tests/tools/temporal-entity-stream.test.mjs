import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { digestCanonical, defaultTimeoutPolicyDigest, qualificationTemporalContext } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { describeTemporalEntityPartition, sealTemporalEntityStreamPlan, resolveTemporalEntityStream, MAX_TEMPORAL_BATCH_ENTITIES } = await import(new URL('../../tools/test/temporal-entity-stream.mjs', import.meta.url));

const { createTemporalDomainProducerReceipt, createTemporalEntityTransport, verifyTemporalDomainProducerReceipt } = await import(new URL('../../tools/test/temporal-role-resolver.mjs', import.meta.url));
const { validateJsonSchema } = await import(new URL('../../tools/test-matrix/schema-validator/validate.mjs', import.meta.url));

const sourcePlanDigest = `sha256:${'b'.repeat(64)}`;
const temporalContext = qualificationTemporalContext({ sourceCommit: 'a'.repeat(40), sourceFingerprint: sourcePlanDigest,
    producerId: 'scale-data', schedulerRunId: 'ordinary-stream-control', businessEpochUtc: '2024-02-29T23:59:59.000Z',
    locale: 'en-US', uiLocale: 'en-US', timeoutPolicyDigest: defaultTimeoutPolicyDigest() });
const fixtureIdentity = { producerId: 'scale-data', runId: temporalContext.schedulerRunId,
    namespace: 'ordinary', fixtureId: 'stream-control', planDigest: sourcePlanDigest };
const fact = (instantUtc) => ({ applicability: instantUtc === null ? 'null' : 'instant', instantUtc });
const absent = () => ({ applicability: 'not-generated', instantUtc: null });

function article(identity, ordinal, revision = 1)
{
    return { coordinate: { entityKind: 'article', semanticIdentity: identity, operationIdentity: `revision-${revision}`,
        ordinal, revisionNumber: revision, publicationNumber: 1, publicationRevisionNumber: 1, articleIdentity: null },
    state: revision === 1 ? 'published' : 'scheduled', stateFacts: { hasRevision: true, hasPublication: true },
    facts: { 'article.created': fact('2024-02-29T23:59:40.000Z'),
        'article.revision': fact(revision === 1 ? '2024-02-29T23:59:45.000Z' : '2024-02-29T23:59:55.000Z'),
        'article.metadata-updated': fact(revision === 1 ? '2024-02-29T23:59:50.000Z' : '2024-02-29T23:59:55.000Z'),
        'article.publication': fact('2024-02-29T23:59:50.000Z'), 'article.published': fact('2024-02-29T23:59:50.000Z') } };
}

function comment(identity, ordinal, articleIdentity, created)
{
    return { coordinate: { entityKind: 'comment', semanticIdentity: identity, operationIdentity: 'created',
        ordinal, revisionNumber: null, publicationNumber: null, publicationRevisionNumber: null, articleIdentity },
    state: 'approved', stateFacts: { hasRevision: false, hasEditTime: false, hasModerationTime: false },
    facts: { 'comment.created': fact(created), 'comment.edited': fact(null), 'comment.moderated': fact(null) } };
}

function planFor(distribution, batches)
{
    let entityStartIndex = 0;
    let relationshipStartIndex = 0;
    const partitions = batches.map((batch) =>
    {
        const partition = describeTemporalEntityPartition(batch, { entityStartIndex, relationshipStartIndex });
        entityStartIndex += batch.entities.length;
        relationshipStartIndex += batch.rootNested.length;
        return partition;
    });
    return structuredClone(sealTemporalEntityStreamPlan({ temporalContext, fixtureIdentity, distribution, partitions }));
}

function inputs()
{
    const batches = [
        { schema: 'fsusblog.temporal-entity-batch-input.v1', index: 0,
            entities: [article('a', 1), comment('child', 2, 'a', '2024-02-29T23:59:48.000Z')],
            rootNested: [{ commentIdentity: 'child', parentIdentity: 'root', rootIdentity: 'root' }] },
        { schema: 'fsusblog.temporal-entity-batch-input.v1', index: 1,
            entities: [article('a', 1, 2), comment('root', 1, 'a', '2024-02-29T23:59:46.000Z')],
            rootNested: [{ commentIdentity: 'root', parentIdentity: null, rootIdentity: null }] }
    ];
    const distribution = { kind: 'scale', tier: 'scale-s', ordinalBase: 1,
        counts: { article: 1, comment: 2, audit: 0 },
        stateCounts: { article: { draft: 0, scheduled: 1, published: 0, archived: 0, deleted: 0 },
            comment: { approved: 2, pending: 0, rejected: 0, deleted: 0 }, audit: { recorded: 0 } } };
    const streamPlan = planFor(distribution, batches);
    return { streamPlan, batches };
}

async function run(input = inputs(), onBatch = () =>
{})
{
    return resolveTemporalEntityStream({ temporalContext, fixtureIdentity, ...input, onBatch });
}

test('bounded stream retains referenced historical revision and parent relationships across batches', async () =>
{
    const output = [];
    const manifest = await run(inputs(), (value) =>
    {
        output.push(value);
        const transport = createTemporalEntityTransport({ artifact: value, temporalContext });
        const schema = JSON.parse(readFileSync(new URL('../../config/testing/temporal-domain-producer-receipt.schema.json', import.meta.url), 'utf8'));
        assert.deepEqual(validateJsonSchema(transport.receipt, schema), []);
        assert.equal(verifyTemporalDomainProducerReceipt(transport.receipt, { artifact: value, temporalContext }).qualificationEligible, false);
        assert.equal(transport.receipt.schema, 'fsusblog.temporal-entity-batch-receipt.v2');
    });
    const schema = JSON.parse(readFileSync(new URL('../../config/testing/resolved-temporal-roles.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(validateJsonSchema(manifest, schema), []);
    const receipt = createTemporalDomainProducerReceipt(manifest, { temporalContext });
    const receiptSchema = JSON.parse(readFileSync(new URL('../../config/testing/temporal-domain-producer-receipt.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(validateJsonSchema(receipt, receiptSchema), []);
    assert.equal(receipt.schema, 'fsusblog.temporal-entity-stream-receipt.v2');
    assert.equal(verifyTemporalDomainProducerReceipt(receipt, { artifact: manifest, temporalContext }).qualificationEligible, false);
    assert.equal(manifest.qualificationEligible, false);
    assert.equal(manifest.streamPlan.partitions.length, 2);
    assert.equal(manifest.streamPlan.partitions[1].entityStartIndex, 2);
    assert.equal(manifest.streamPlan.contextDigest, digestCanonical(temporalContext));
    assert.deepEqual(manifest.batches.map((batch) => batch.inputDigest), manifest.streamPlan.partitions.map((part) => part.inputDigest));
    assert.equal(manifest.recordCount, 4);
    assert.equal(manifest.relationshipCount, 2);
    assert.equal(output[1].entities[0].relations[0].status, 'verified');
    assert.equal(output[1].referencedRevisions[0].revisionNumber, 1);
    assert.equal(output[1].referencedRevisions[0].entityIndex, 0);
    assert.equal(output[1].entities[0].entityIndex, 2);
    assert.equal(output[0].entities[1].references.find((reference) => reference.kind === 'parent-comment').entityIndex, 3);
    assert.equal(output[0].relationships[0].rootIdentity, 'root');
    assert.equal(output[0].entities[1].relations[1].parentIdentity, 'root');
    assert.equal(output[1].entities[1].relations[1].parentIdentity, null);
    assert.equal(output[1].entities[1].roles[1].applicability, 'null');
    for (const [index, value] of output.entries())
    {
        assert.deepEqual(validateJsonSchema(value, schema), []);
        const { contentDigest, ...unsigned } = value;
        assert.equal(digestCanonical(unsigned), contentDigest);
        assert.equal(manifest.batches[index].artifactDigest, contentDigest);
    }
});

test('whole-stream failures never emit a partially validated batch', async () =>
{
    for (const mutate of [
        (value) =>
        {
            value.batches[1].entities[0].facts['article.revision'].instantUtc = '2024-02-29T23:59:44.000Z';
        },
        (value) =>
        {
            value.batches[1].entities[0].coordinate.publicationRevisionNumber = 2;
        },
        (value) =>
        {
            value.batches[1].entities[1].facts['comment.created'].instantUtc = '2024-02-29T23:59:49.000Z';
        },
        (value) =>
        {
            value.batches[1].rootNested[0] = { commentIdentity: 'root', parentIdentity: 'child', rootIdentity: 'child' };
        },
        (value) =>
        {
            value.batches[1].entities[1].coordinate.ordinal = 2;
        },
        (value) =>
        {
            value.batches[1].entities[1].coordinate.articleIdentity = 'missing';
        },
        (value) =>
        {
            value.batches[1].entities[0].coordinate.operationIdentity = 'revision-1';
        },
        (value) =>
        {
            value.batches.pop();
        },
        (value) =>
        {
            value.batches[1].index = 0;
        },
        (value) =>
        {
            value.streamPlan.distribution.counts.comment = 3;
        },
        (value) =>
        {
            value.streamPlan.sourcePlanDigest = `sha256:${'0'.repeat(64)}`;
        }
    ])
    {
        const input = inputs();
        mutate(input);
        let calls = 0;
        await assert.rejects(run(input, () => calls++));
        assert.equal(calls, 0);
    }
});

test('ordinary batch cap and explicit ungenerated rows remain bounded without truncation', async () =>
{
    const input = inputs();
    input.batches[0].entities = Array(MAX_TEMPORAL_BATCH_ENTITIES + 1).fill(input.batches[0].entities[0]);
    await assert.rejects(run(input), /bounded stream/u);
    const draft = article('draft', 1);
    draft.state = 'draft';
    draft.stateFacts = { hasRevision: false, hasPublication: false };
    draft.coordinate.revisionNumber = null;
    draft.coordinate.publicationNumber = null;
    draft.coordinate.publicationRevisionNumber = null;
    draft.facts['article.revision'] = absent();
    draft.facts['article.publication'] = absent();
    draft.facts['article.published'] = fact(null);
    const ordinary = inputs();
    ordinary.streamPlan.distribution.counts.comment = 0;
    ordinary.streamPlan.distribution.stateCounts.article.scheduled = 0;
    ordinary.streamPlan.distribution.stateCounts.article.draft = 1;
    ordinary.streamPlan.distribution.stateCounts.comment.approved = 0;
    ordinary.streamPlan.recordCount = 1;
    ordinary.streamPlan.relationshipCount = 0;
    ordinary.streamPlan.batchCount = 1;
    ordinary.batches = [{ schema: 'fsusblog.temporal-entity-batch-input.v1', index: 0, entities: [draft], rootNested: [] }];
    ordinary.streamPlan = planFor(ordinary.streamPlan.distribution, ordinary.batches);
    const output = [];
    await run(ordinary, (value) => output.push(value));
    assert.equal(output[0].entities[0].roles[1].applicability, 'not-generated');
    assert.equal(output[0].entities[0].roles[4].applicability, 'null');
});

test('cancelled ordinary streams never return a complete manifest or root receipt', async () =>
{
    for (const phase of ['before-start', 'source-read', 'output-consumer'])
    {
        const controller = new AbortController();
        const reason = new Error(`ordinary cancellation at ${phase}`);
        const input = inputs();
        let callbacks = 0;
        let completed = false;
        let rootReceipt = null;
        if (phase === 'before-start')
        {
            controller.abort(reason);
        }
        async function* source()
        {
            yield input.batches[0];
            if (phase === 'source-read')
            {
                controller.abort(reason);
            }
            yield input.batches[1];
        }
        await assert.rejects(async () =>
        {
            const manifest = await resolveTemporalEntityStream({ temporalContext, fixtureIdentity,
                streamPlan: input.streamPlan, batches: source(), signal: controller.signal,
                onBatch: () =>
                {
                    callbacks++;
                    if (phase === 'output-consumer')
                    {
                        controller.abort(reason);
                    }
                } });
            completed = true;
            rootReceipt = createTemporalDomainProducerReceipt(manifest, { temporalContext });
        }, (error) => error === reason);
        assert.equal(callbacks, phase === 'output-consumer' ? 1 : 0);
        assert.equal(completed, false);
        assert.equal(rootReceipt, null);
    }
});

test('scale l capacity streams 100000 articles and 1000000 comments without a whole-plan array', async () =>
{
    // Capacity control uses explicit synthetic identities and valid toy timestamps.
    // The entity counts are the real L capacity, not a production distribution observation.
    const articleCount = 100000;
    const commentCount = 1000000;
    const batchSize = 250;
    const rootCount = commentCount / 2;
    const distribution = { kind: 'scale', tier: 'scale-l-nightly', ordinalBase: 1,
        counts: { article: articleCount, comment: commentCount, audit: 0 },
        stateCounts: { article: { draft: 0, scheduled: 0, published: articleCount, archived: 0, deleted: 0 },
            comment: { approved: commentCount, pending: 0, rejected: 0, deleted: 0 }, audit: { recorded: 0 } } };
    async function* batches()
    {
        let index = 0;
        for (let offset = 0; offset < articleCount; offset += batchSize)
        {
            const entities = Array.from({ length: batchSize }, (_, slot) => article(`article-${offset + slot + 1}`, offset + slot + 1));
            yield { schema: 'fsusblog.temporal-entity-batch-input.v1', index: index++, entities, rootNested: [] };
        }
        for (let offset = 0; offset < commentCount; offset += batchSize)
        {
            const entities = [];
            const rootNested = [];
            for (let slot = 0; slot < batchSize; slot++)
            {
                const ordinal = offset + slot + 1;
                const rootOrdinal = ordinal <= rootCount ? ordinal : ordinal - rootCount;
                const parentIdentity = ordinal <= rootCount ? null : `comment-${rootOrdinal}`;
                entities.push(comment(`comment-${ordinal}`, ordinal, `article-${(rootOrdinal - 1) % articleCount + 1}`,
                    ordinal <= rootCount ? '2024-02-29T23:59:46.000Z' : '2024-02-29T23:59:48.000Z'));
                rootNested.push({ commentIdentity: `comment-${ordinal}`, parentIdentity, rootIdentity: parentIdentity });
            }
            yield { schema: 'fsusblog.temporal-entity-batch-input.v1', index: index++, entities, rootNested };
        }
    }
    const partitions = [];
    let entityStartIndex = 0;
    let relationshipStartIndex = 0;
    for await (const batch of batches())
    {
        partitions.push(describeTemporalEntityPartition(batch, { entityStartIndex, relationshipStartIndex }));
        entityStartIndex += batch.entities.length;
        relationshipStartIndex += batch.rootNested.length;
    }
    const streamPlan = sealTemporalEntityStreamPlan({ temporalContext, fixtureIdentity, distribution, partitions });
    let observedRecords = 0;
    let observedRelationships = 0;
    let observedBatches = 0;
    const manifest = await run({ streamPlan, batches: batches() }, (artifact) =>
    {
        assert.equal(artifact.batch.entityStartIndex, observedRecords);
        assert.equal(artifact.entities[0].entityIndex, observedRecords);
        assert.equal(artifact.entities.at(-1).entityIndex, observedRecords + artifact.entities.length - 1);
        assert.equal(artifact.streamPlanDigest, digestCanonical(streamPlan));
        observedRecords += artifact.entities.length;
        observedRelationships += artifact.relationships.length;
        observedBatches++;
        assert.ok(artifact.entities.length <= batchSize);
        assert.ok(Buffer.byteLength(JSON.stringify(artifact)) <= 1024 * 1024);
    });
    assert.equal(manifest.qualificationEligible, false);
    assert.equal(manifest.recordCount, 1100000);
    assert.equal(observedRecords, 1100000);
    assert.equal(observedRelationships, 1000000);
    assert.equal(observedBatches, 4400);
    assert.equal(manifest.streamPlan.partitions.length, 4400);
    assert.equal(manifest.batches.at(-1).entityStartIndex, 1099750);
    const receipt = createTemporalDomainProducerReceipt(manifest, { temporalContext });
    assert.equal(receipt.schema, 'fsusblog.temporal-entity-stream-receipt.v2');
    assert.equal(receipt.qualificationEligible, false);
});
