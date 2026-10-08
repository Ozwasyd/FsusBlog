import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { resolveDemoTemporalBusinessStream, prepareDemoTemporalStream, bindDemoTemporalBusinessFields } = await import(new URL('../../tools/test-fixtures/producers/demo-temporal-binding.mjs', import.meta.url));
const { resolveDataScaleTemporalBusinessStream } = await import(new URL('../../tools/data-scale/temporal-business-binding.mjs', import.meta.url));
const { sealTemporalBusinessFieldStream } = await import(new URL('../../tools/test-fixtures/temporal-business-stream.mjs', import.meta.url));
const { verifyObservedTemporalEntityBusinessFields, requireCompleteTemporalEntityBinding } = await import(new URL('../../tools/test-fixtures/temporal-business-fields.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { resolveTemporalEntityStream } = await import(new URL('../../tools/test/temporal-entity-stream.mjs', import.meta.url));
const { createTemporalEntityTransport, verifyTemporalDomainProducerReceipt } = await import(new URL('../../tools/test/temporal-role-resolver.mjs', import.meta.url));
const { validateJsonSchema } = await import(new URL('../../tools/test-matrix/schema-validator/validate.mjs', import.meta.url));
const { consumerEntityPlan } = await import(new URL('./support/temporal-entity-consumer-fixtures.mjs', import.meta.url));
const { businessStreamInputs } = await import(new URL('./support/temporal-business-stream-fixtures.mjs', import.meta.url));

const receiptSchema = JSON.parse(readFileSync(new URL('../../config/testing/temporal-domain-producer-receipt.schema.json', import.meta.url), 'utf8'));
const artifactSchema = JSON.parse(readFileSync(new URL('../../config/testing/resolved-temporal-roles.schema.json', import.meta.url), 'utf8'));
const lookup = (entityKind, semanticIdentity, operationIdentity = 'created') => ({ entityKind, semanticIdentity, operationIdentity });

test('demo v2 ingress seals original order, replays source and completes only after every field handler', async () =>
{
    const input = businessStreamInputs();
    const completed = [];
    const output = [];
    const result = await prepareDemoTemporalStream({ temporalContext: input.temporalContext,
        runIdentity: input.fixtureIdentity.runId, namespace: input.fixtureIdentity.namespace,
        plan: { variantPlanDigest: input.fixtureIdentity.planDigest } }, { distribution: input.distribution,
        source: input.source,
        async onBatch({ binding, transport })
        {
            assert.equal(binding.batch.index, completed.length);
            assert.equal(transport.receipt.schema, 'fsusblog.temporal-entity-batch-receipt.v2');
            assert.deepEqual(validateJsonSchema(transport.receipt, receiptSchema), []);
            assert.deepEqual(validateJsonSchema(JSON.parse(transport.environment.FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON), artifactSchema), []);
            assert.equal(transport.receiptFileName, 'temporal-domain-producer-receipt.json');
            assert.equal(transport.artifactDigest, binding.artifactDigest);
            const observed = binding.fields.map(({ coordinate, field, applicability, instantUtc }) => ({ coordinate, field, applicability, instantUtc }));
            assert.equal(verifyObservedTemporalEntityBusinessFields(binding, observed).qualificationEligible, false);
            assert.throws(() => requireCompleteTemporalEntityBinding(binding), /unsupported fields remain OPEN/u);
            output.push(binding);
            await Promise.resolve();
            completed.push(binding.batch.index);
        } });
    assert.equal(input.opens(), 2);
    assert.deepEqual(completed, [0, 1, 2]);
    assert.equal(result.manifest.schema, 'fsusblog.resolved-temporal-entity-stream.v2');
    assert.equal(result.receipt.schema, 'fsusblog.temporal-entity-stream-receipt.v2');
    assert.equal(result.manifest.recordCount, 6);
    assert.equal(result.manifest.relationshipCount, 2);
    assert.equal(result.manifest.fixtureIdentity.fixtureId, 'development-demo');
    assert.equal(result.manifest.batches.length, 3);
    assert.equal(result.receipt.qualificationEligible, false);
    assert.deepEqual(validateJsonSchema(result.receipt, receiptSchema), []);
    assert.equal(verifyTemporalDomainProducerReceipt(result.receipt, { artifact: result.manifest,
        temporalContext: input.temporalContext }).qualificationEligible, false);
    assert.throws(() => createTemporalEntityTransport({ artifact: result.manifest, temporalContext: input.temporalContext }), /ordinary entity artifact/u);
    const comments = output[1];
    assert.equal(comments.requireField(lookup('comment', 'approved'), 'comment.moderated-at').instantUtc, '2026-06-01T11:05:00.000Z');
    assert.equal(comments.requireField(lookup('comment', 'pending'), 'comment.moderated-at').applicability, 'null');
    assert.equal(output[0].requireField(lookup('article', 'control-scheduled'), 'article-revision.created-at').applicability, 'not-generated');
    assert.equal(output[0].requireField(lookup('article', 'control-scheduled'), 'article.published-at').applicability, 'null');
    assert.notEqual(output[2].fields[0].instantUtc, output[2].fields[1].instantUtc);
    assert.deepEqual(output.flatMap((binding) => binding.entities.map((entity) => entity.entityIndex)), [0, 1, 2, 3, 4, 5]);
});

test('scale v2 fields consume canonical forward parent references and preserve global ordinals', async () =>
{
    const plan = consumerEntityPlan('scale-data');
    plan.distribution.rootNested[1] = { commentIdentity: 'pending', parentIdentity: 'approved', rootIdentity: 'approved' };
    [plan.entities[2], plan.entities[3]] = [plan.entities[3], plan.entities[2]];
    const input = businessStreamInputs('scale-data', 1, plan);
    const output = [];
    const result = await resolveDataScaleTemporalBusinessStream({ ...input, onBatch: ({ binding }) => output.push(binding) });
    assert.equal(result.manifest.recordCount, 4);
    assert.equal(result.manifest.relationshipCount, 2);
    assert.equal(output[2].entities[0].coordinate.ordinal, 2);
    const parent = output[2].entities[0].references.find((reference) => reference.kind === 'parent-comment');
    assert.equal(parent.entityIndex, 3);
    assert.equal(parent.coordinate.semanticIdentity, 'approved');
    assert.equal(output[2].unsupportedFields[0].field, 'row.created-at');
    assert.equal(output[3].requireField(lookup('comment', 'approved'), 'comment.create-time').entityIndex, 3);
});

test('cross-batch rights snapshot uses the canonical referenced revision rather than current revision', async () =>
{
    const plan = consumerEntityPlan();
    const later = structuredClone(plan.entities[0]);
    later.coordinate.operationIdentity = 'revision-2';
    later.coordinate.revisionNumber = 2;
    later.facts['article.revision'].instantUtc = '2026-06-03T10:00:00.000Z';
    later.facts['article.metadata-updated'].instantUtc = '2026-06-03T10:00:00.000Z';
    plan.entities.splice(1, 0, later);
    const output = [];
    await resolveDemoTemporalBusinessStream({ ...businessStreamInputs('development-demo', 1, plan),
        onBatch: ({ binding }) => output.push(binding) });
    const coordinate = lookup('article', 'control-published', 'revision-2');
    assert.equal(output[1].requireField(coordinate, 'article-revision.created-at').instantUtc, '2026-06-03T10:00:00.000Z');
    assert.equal(output[1].requireField(coordinate, 'article-rights-snapshot.created-at').instantUtc, '2026-06-01T10:00:00.000Z');
    assert.equal(output[1].entities[0].references[0].entityIndex, 0);
});

test('original callback validation refuses clones, serialized packets and foreign held partitions', async () =>
{
    const input = businessStreamInputs();
    const streamPlan = await sealTemporalBusinessFieldStream(input);
    let callbacks = 0;
    await resolveTemporalEntityStream({ ...input, streamPlan, batches: input.source(),
        onBatch(artifact)
        {
            callbacks++;
            const expected = { ...input.fixtureIdentity, streamPlanDigest: digestCanonical(streamPlan),
                catalogDigest: streamPlan.catalogDigest, shapeDigest: streamPlan.shapeDigest,
                partition: streamPlan.partitions[artifact.batch.index] };
            const binding = bindDemoTemporalBusinessFields({ temporalContext: input.temporalContext, artifact, expected });
            for (const copy of [structuredClone(artifact), JSON.parse(JSON.stringify(artifact))])
            {
                assert.throws(() => bindDemoTemporalBusinessFields({ temporalContext: input.temporalContext, artifact: copy, expected }), /original globally validated/u);
            }
            for (const changed of [
                { ...expected, streamPlanDigest: `sha256:${'0'.repeat(64)}` },
                { ...expected, namespace: 'foreign' },
                { ...expected, partition: { ...expected.partition, entityStartIndex: 99 } }
            ])
            {
                assert.throws(() => bindDemoTemporalBusinessFields({ temporalContext: input.temporalContext, artifact, expected: changed }), /held/u);
            }
            assert.equal(binding.streamPlanDigest, digestCanonical(streamPlan));
        } });
    assert.equal(callbacks, 3);
});

test('full source replay restores fresh callback identity and repeats the same ordinary digests', async () =>
{
    const input = businessStreamInputs();
    const streamPlan = await sealTemporalBusinessFieldStream(input);
    const digests = [];
    const run = () => resolveDemoTemporalBusinessStream({ ...input, streamPlan,
        onBatch: ({ binding }) => digests.push(binding.semanticDigest) });
    const first = await run();
    const second = await run();
    assert.equal(first.manifest.contentDigest, second.manifest.contentDigest);
    assert.deepEqual(digests.slice(0, 3), digests.slice(3));
    assert.equal(input.opens(), 3);
});

test('v2 demo and scale fields and canonical carriers repeat across process timezones without host clock reads', () =>
{
    const script = `
        Date.now = () => { throw new Error('host wall clock forbidden'); };
        const { businessStreamInputs } = await import(${JSON.stringify(new URL('./support/temporal-business-stream-fixtures.mjs', import.meta.url).href)});
        const { resolveDemoTemporalBusinessStream } = await import(${JSON.stringify(new URL('../../tools/test-fixtures/producers/demo-temporal-binding.mjs', import.meta.url).href)});
        const { resolveDataScaleTemporalBusinessStream } = await import(${JSON.stringify(new URL('../../tools/data-scale/temporal-business-binding.mjs', import.meta.url).href)});
        const output = [];
        for (const [producerId, resolve] of [['development-demo', resolveDemoTemporalBusinessStream], ['scale-data', resolveDataScaleTemporalBusinessStream]])
        {
            const batches = [];
            const result = await resolve({ ...businessStreamInputs(producerId),
                onBatch: ({ binding, transport }) => batches.push({ fields: binding.fields, entities: binding.entities,
                    semanticDigest: binding.semanticDigest, environment: transport.environment }) });
            output.push({ batches, manifestDigest: result.manifest.contentDigest, receipt: result.receipt });
        }
        process.stdout.write(JSON.stringify(output));
    `;
    const values = ['UTC', 'America/New_York', 'Asia/Tokyo'].map((TZ) =>
    {
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
            env: { ...process.env, TZ }, encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
        return child.stdout;
    });
    assert.equal(new Set(values).size, 1);
});

test('changed, reordered or exhausted replay fails before any business-field handler', async () =>
{
    for (const mode of ['changed', 'reordered', 'exhausted'])
    {
        const input = businessStreamInputs();
        let opens = 0;
        let callbacks = 0;
        const source = () =>
        {
            opens++;
            const batches = structuredClone(input.batches);
            if (opens === 2 && mode === 'changed')
            {
                batches[1].entities[0].facts['comment.created'].instantUtc = '2026-06-01T11:00:01.000Z';
            }
            if (opens === 2 && mode === 'reordered')
            {
                batches.reverse();
            }
            return opens === 2 && mode === 'exhausted' ? [] : batches;
        };
        await assert.rejects(resolveDemoTemporalBusinessStream({ ...input, source, onBatch: () => callbacks++ }),
            /sealed source digest|batch order|complete record/u);
        assert.equal(callbacks, 0);
    }
});

test('original demo/scale chronology remains rejected before the first business-field handler', async () =>
{
    for (const producerId of ['development-demo', 'scale-data'])
    {
        const plan = consumerEntityPlan(producerId);
        const facts = plan.entities[0].facts;
        if (producerId === 'development-demo')
        {
            facts['article.created'].instantUtc = '2026-06-01T10:00:00.000Z';
            facts['article.revision'].instantUtc = '2026-06-01T10:05:00.000Z';
        }
        else
        {
            facts['article.created'].instantUtc = '2024-02-29T23:59:58.000Z';
            facts['article.revision'].instantUtc = '2024-02-29T23:59:59.000Z';
            facts['article.metadata-updated'].instantUtc = '2024-02-29T23:59:59.000Z';
            facts['article.publication'].instantUtc = '2024-02-28T23:59:59.000Z';
            facts['article.published'].instantUtc = '2024-02-28T23:59:59.000Z';
        }
        const original = structuredClone(plan);
        let callbacks = 0;
        const resolve = producerId === 'scale-data' ? resolveDataScaleTemporalBusinessStream : resolveDemoTemporalBusinessStream;
        await assert.rejects(resolve({ ...businessStreamInputs(producerId, 1, plan), onBatch: () => callbacks++ }), /cross-field invariant/u);
        assert.equal(callbacks, 0);
        assert.deepEqual(plan, original);
    }
});

test('callback failure and callback cancellation never return a completed root receipt', async () =>
{
    for (const cancel of [false, true])
    {
        const input = businessStreamInputs();
        const controller = new AbortController();
        let callbacks = 0;
        let completed;
        const pending = resolveDemoTemporalBusinessStream({ ...input, signal: controller.signal,
            onBatch()
            {
                callbacks++;
                if (cancel)
                {
                    controller.abort();
                }
                else
                {
                    throw new Error('bounded field consumer failed');
                }
            } }).then((value) =>
        {
            completed = value;
            return value;
        });
        await assert.rejects(pending, cancel ? { name: 'AbortError' } : /bounded field consumer failed/u);
        assert.equal(callbacks, 1);
        assert.equal(completed, undefined);
    }
});

test('pre-abort, wrong producers and non-replayable sources refuse before opening ingress', async () =>
{
    const input = businessStreamInputs();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(resolveDemoTemporalBusinessStream({ ...input, signal: controller.signal, onBatch: () =>
    {
    } }), { name: 'AbortError' });
    assert.equal(input.opens(), 0);
    assert.throws(() => resolveDataScaleTemporalBusinessStream(input), /scale-data context/u);
    assert.throws(() => resolveDemoTemporalBusinessStream(businessStreamInputs('scale-data')), /development-demo context/u);
    await assert.rejects(resolveDemoTemporalBusinessStream({ ...input, source: [], onBatch: () =>
    {
    } }), /source replay/u);
    await assert.rejects(resolveDemoTemporalBusinessStream({ ...input, onBatch: null }), /output handler/u);
    assert.equal(input.opens(), 0);
});
