import assert from 'node:assert/strict';
import { test } from 'node:test';

const { digestCanonical } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { bindDemoTemporalBusinessFields, iterateDemoTemporalBusinessBatches } = await import(new URL('../../tools/test-fixtures/producers/demo-temporal-binding.mjs', import.meta.url));
const { iterateDataScaleTemporalBusinessBatches } = await import(new URL('../../tools/data-scale/temporal-business-binding.mjs', import.meta.url));
const { iterateTemporalEntityBusinessBatches } = await import(new URL('../../tools/test-fixtures/temporal-business-fields.mjs', import.meta.url));
const { consumerEntityPlan, consumerInput } = await import(new URL('./support/temporal-entity-consumer-fixtures.mjs', import.meta.url));

test('batch boundaries preserve original global entity coordinates and whole artifact binding', () =>
{
    const input = consumerInput();
    for (const batchSize of [1, 2, 6, 100])
    {
        const packets = [...iterateDemoTemporalBusinessBatches(input, { batchSize })];
        assert.deepEqual([...iterateDemoTemporalBusinessBatches(input, { batchSize })], packets);
        assert.equal(packets.length, Math.ceil(input.artifact.entities.length / batchSize));
        const entities = packets.flatMap((packet) => packet.entities);
        assert.deepEqual(entities.map((entity) => entity.coordinate), input.artifact.entities.map((entity) => entity.coordinate));
        assert.deepEqual(entities.map((entity) => entity.entityIndex), [0, 1, 2, 3, 4, 5]);
        for (const [index, packet] of packets.entries())
        {
            assert.equal(packet.batchIndex, index);
            assert.equal(packet.entityStartIndex, index * batchSize);
            assert.equal(packet.batchCount, packets.length);
            assert.equal(packet.totalEntityOperations, 6);
            assert.equal(packet.artifactDigest, input.expected.artifactDigest);
            assert.equal(packet.entityPlanDigest, input.expected.entityPlanDigest);
            assert.equal(packet.contextDigest, input.artifact.contextIdentity.contextDigest);
            assert.equal(packet.transportOnly, true);
            assert.equal(packet.qualificationEligible, false);
            assert.equal(packet.previousTransportDigest, index === 0 ? null : packets[index - 1].transportDigest);
            const { transportDigest, ...body } = packet;
            assert.equal(transportDigest, digestCanonical(body));
            assert.equal(packet.unsupportedFields[0].field, 'profile.created-at');
            assert.equal(packet.entities.length <= batchSize, true);
        }
    }
});

test('empty and single-entity plans have exact boundaries without a synthesized completion receipt', () =>
{
    for (const count of [0, 1])
    {
        const plan = consumerEntityPlan('scale-data');
        plan.entities = plan.entities.slice(0, count);
        plan.distribution.counts = { article: count, comment: 0, audit: 0 };
        plan.distribution.stateCounts.article = { draft: 0, scheduled: 0, published: count, archived: 0, deleted: 0 };
        plan.distribution.stateCounts.comment = { approved: 0, pending: 0, rejected: 0, deleted: 0 };
        plan.distribution.rootNested = [];
        const packets = [...iterateDataScaleTemporalBusinessBatches(consumerInput('scale-data', plan), { batchSize: 1 })];
        assert.equal(packets.length, count);
        if (count === 1)
        {
            assert.equal(packets[0].entityStartIndex, 0);
            assert.equal(packets[0].entities.length, 1);
            assert.equal(packets[0].totalEntityOperations, 1);
            assert.equal('receipt' in packets[0], false);
        }
    }
});

test('cross-batch parent/root/article references retain global identity without local renumbering', () =>
{
    const plan = consumerEntityPlan('scale-data');
    plan.distribution.rootNested[1] = { commentIdentity: 'pending', parentIdentity: 'approved', rootIdentity: 'approved' };
    const input = consumerInput('scale-data', plan);
    const packets = [...iterateDataScaleTemporalBusinessBatches(input, { batchSize: 1 })];
    const child = packets[3].entities[0];
    assert.equal(child.coordinate.ordinal, 2);
    assert.deepEqual(child.references.map(({ kind, entityIndex }) => ({ kind, entityIndex })), [
        { kind: 'article', entityIndex: 0 }, { kind: 'parent-comment', entityIndex: 2 }, { kind: 'root-comment', entityIndex: 2 }
    ]);
    for (const reference of child.references)
    {
        assert.deepEqual(reference.coordinate, input.artifact.entities[reference.entityIndex].coordinate);
    }
    assert.equal(packets[0].unsupportedFields[0].field, 'row.created-at');
});

test('publication history references its exact earlier revision across a batch boundary', () =>
{
    const plan = consumerEntityPlan();
    const later = structuredClone(plan.entities[0]);
    later.coordinate.operationIdentity = 'revision-2';
    later.coordinate.revisionNumber = 2;
    later.facts['article.revision'].instantUtc = '2026-06-03T10:00:00.000Z';
    later.facts['article.metadata-updated'].instantUtc = '2026-06-03T10:00:00.000Z';
    plan.entities.splice(1, 0, later);
    const packets = [...iterateDemoTemporalBusinessBatches(consumerInput('development-demo', plan), { batchSize: 1 })];
    const history = packets[1].entities[0];
    assert.equal(history.coordinate.revisionNumber, 2);
    assert.equal(history.references[0].kind, 'publication-revision');
    assert.equal(history.references[0].entityIndex, 0);
    assert.equal(history.references[0].coordinate.revisionNumber, 1);
    assert.equal(history.fields.find((field) => field.field === 'article-rights-snapshot.created-at').instantUtc,
        '2026-06-01T10:00:00.000Z');
});

test('batch transport preserves null/not-generated markers and cannot be mutated by callers', () =>
{
    const input = consumerInput();
    const iterator = iterateDemoTemporalBusinessBatches(input, { batchSize: 1 });
    const first = iterator.next().value;
    input.artifact.entities[1].roles[0].instantUtc = 'tampered';
    const remaining = [...iterator];
    const scheduled = remaining[0].entities[0];
    assert.equal(scheduled.fields.find((field) => field.field === 'article-revision.created-at').applicability, 'not-generated');
    assert.equal(scheduled.fields.find((field) => field.field === 'article.published-at').applicability, 'null');
    const pending = remaining[2].entities[0];
    assert.equal(pending.fields.find((field) => field.field === 'comment.moderated-at').instantUtc, null);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.entities[0].coordinate), true);
    assert.equal(Object.isFrozen(first.entities[0].references[0].coordinate), true);
    assert.equal(Object.isFrozen(scheduled.fields), true);
});

test('batch transport rejects unverified bindings and invalid caps', () =>
{
    const binding = bindDemoTemporalBusinessFields(consumerInput());
    assert.throws(() => iterateTemporalEntityBusinessBatches({ ...binding }).next(), /verified complete artifact/u);
    for (const batchSize of [0, -1, 1.5, NaN, 1_000_001, 1_100_000])
    {
        assert.throws(() => iterateTemporalEntityBusinessBatches(binding, { batchSize }).next(), /bounded positive/u);
    }
    assert.equal([...iterateTemporalEntityBusinessBatches(binding, { batchSize: 1_000_000 })].length, 1);
});

test('cancellation before and between packets produces no later packet or completion receipt', () =>
{
    const input = consumerInput();
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => iterateDemoTemporalBusinessBatches(input, { signal: controller.signal }), { name: 'AbortError' });
    const active = new AbortController();
    const iterator = iterateDemoTemporalBusinessBatches(input, { batchSize: 1, signal: active.signal });
    const first = iterator.next().value;
    active.abort();
    assert.throws(() => iterator.next(), { name: 'AbortError' });
    assert.equal(iterator.next().done, true);
    assert.equal('receipt' in first, false);
    const returned = iterateDemoTemporalBusinessBatches(input, { batchSize: 1 });
    returned.next();
    assert.equal(returned.return().done, true);
    assert.equal(returned.next().done, true);
});

test('L-nightly sized ordinary plans remain rejected until a canonical cross-batch API exists', () =>
{
    const plan = consumerEntityPlan('scale-data');
    // Sparse invalid input tests the existing guard; no 1.1M seed facts are manufactured.
    plan.entities = Array(1_100_000);
    assert.throws(() => consumerInput('scale-data', plan), /bounded explicit entities/u);
    const chronology = consumerEntityPlan('scale-data');
    chronology.entities[3].facts['comment.created'].instantUtc = '2026-06-01T10:59:59.000Z';
    chronology.distribution.rootNested[1] = { commentIdentity: 'pending', parentIdentity: 'approved', rootIdentity: 'approved' };
    assert.throws(() => iterateDataScaleTemporalBusinessBatches(consumerInput('scale-data', chronology), { batchSize: 1 }), /cross-field invariant/u);
});
