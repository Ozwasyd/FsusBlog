import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createTemporalBusinessRecordSource, temporalBusinessSourceRecord } = await import(new URL('../../tools/test-fixtures/temporal-business-source.mjs', import.meta.url));
const { resolveDemoTemporalBusinessRows } = await import(new URL('../../tools/test-fixtures/producers/demo-temporal-binding.mjs', import.meta.url));
const { resolveDataScaleTemporalBusinessRows } = await import(new URL('../../tools/data-scale/temporal-business-binding.mjs', import.meta.url));
const { businessStreamInputs } = await import(new URL('./support/temporal-business-stream-fixtures.mjs', import.meta.url));

// Explicit joined-row controls only. These are not backend observations or a
// rewritten historical seed. All coordinates/relations are held original input.
function rowInput(producerId = 'development-demo')
{
    const input = businessStreamInputs(producerId);
    const entities = input.batches.flatMap((batch) => batch.entities);
    const relationships = input.batches.flatMap((batch) => batch.rootNested);
    const rows = [
        { article: { createtime: '2026-06-01T09:00:00.000Z', metadata_updated_at: '2026-06-01T10:00:00.000Z', published_at: '2026-06-01T10:00:00.000Z' },
            articleRevision: { created_at: '2026-06-01T10:00:00.000Z' }, articlePublication: { published_at: '2026-06-01T10:00:00.000Z' } },
        { article: { createtime: '2026-06-01T09:00:00.000Z', metadata_updated_at: '2026-06-01T09:00:00.000Z', published_at: null },
            articleRevision: null, articlePublication: null },
        { comment: { create_time: '2026-06-01T11:00:00.000Z', edited_at_utc: null, moderated_at: producerId === 'scale-data' ? null : '2026-06-01T11:05:00.000Z' },
            commentRevision: producerId === 'scale-data' ? null : { created_at_utc: '2026-06-01T11:00:00.000Z' } },
        { comment: { create_time: '2026-06-02T11:00:00.000Z', edited_at_utc: null, moderated_at: null },
            commentRevision: producerId === 'scale-data' ? null : { created_at_utc: '2026-06-02T11:00:00.000Z' } },
        { auditEvent: { occurred_at_utc: '2026-06-01T12:00:00.000Z' } },
        { auditEvent: { occurred_at_utc: '2026-06-02T12:00:00.000Z' } }
    ];
    const records = entities.map((entity, index) => ({ coordinate: entity.coordinate, state: entity.state,
        stateFacts: entity.stateFacts, rows: rows[index],
        relationship: relationships.find((relationship) => relationship.commentIdentity === entity.coordinate.semanticIdentity) ?? null }));
    let opens = 0;
    return { ...input, records: () =>
    {
        opens++;
        return structuredClone(records);
    }, originalRecords: records, rowOpens: () => opens };
}

const lookup = (entityKind, semanticIdentity) => ({ entityKind, semanticIdentity, operationIdentity: 'created' });

test('demo joined columns replay through original callbacks with NULL and absent-row distinctions', async () =>
{
    const input = rowInput();
    const original = structuredClone(input.originalRecords);
    const batches = [];
    const result = await resolveDemoTemporalBusinessRows({ ...input, batchSize: 2,
        onBatch: ({ binding, transport }) => batches.push({ binding, transport }) });
    assert.equal(input.rowOpens(), 2);
    assert.equal(result.manifest.recordCount, 6);
    assert.deepEqual(batches.map(({ binding }) => binding.entities.map((entity) => entity.entityIndex)), [[0, 1], [2, 3], [4, 5]]);
    const fields = batches[0].binding;
    assert.equal(fields.requireField(lookup('article', 'control-scheduled'), 'article-revision.created-at').applicability, 'not-generated');
    assert.equal(fields.requireField(lookup('article', 'control-scheduled'), 'article.published-at').applicability, 'null');
    assert.equal(batches[1].binding.requireField(lookup('comment', 'pending'), 'comment.moderated-at').instantUtc, null);
    assert.equal(batches[1].binding.requireField(lookup('comment', 'approved'), 'comment-revision.created-at').instantUtc, '2026-06-01T11:00:00.000Z');
    for (const { binding, transport } of batches)
    {
        assert.equal(binding.qualificationEligible, false);
        assert.equal(transport.receipt.qualificationEligible, false);
        assert.equal(transport.artifactDigest, binding.artifactDigest);
    }
    assert.deepEqual(input.originalRecords, original);
});

test('scale row ingress preserves supplied forward references and global order without assigning ordinals', async () =>
{
    const input = rowInput('scale-data');
    input.originalRecords[3].relationship = { commentIdentity: 'pending', parentIdentity: 'approved', rootIdentity: 'approved' };
    [input.originalRecords[2], input.originalRecords[3]] = [input.originalRecords[3], input.originalRecords[2]];
    const output = [];
    const result = await resolveDataScaleTemporalBusinessRows({ ...input, batchSize: 1, onBatch: ({ binding }) => output.push(binding) });
    assert.equal(result.manifest.recordCount, 4);
    assert.equal(output[2].entities[0].coordinate.ordinal, 2);
    assert.equal(output[2].entities[0].references.find((reference) => reference.kind === 'parent-comment').entityIndex, 3);
    assert.equal(output[2].unsupportedFields[0].field, 'row.created-at');
});

test('omitted columns, row flags, invented edits and absent relationships refuse before field handlers', async () =>
{
    const mutations = [
        (records) =>
        {
            delete records[0].rows.article.metadata_updated_at;
        },
        (records) =>
        {
            delete records[1].rows.articleRevision;
        },
        (records) =>
        {
            records[1].stateFacts.hasRevision = true;
        },
        (records) =>
        {
            records[3].rows.comment.edited_at_utc = '2026-06-02T11:01:00.000Z';
        },
        (records) =>
        {
            delete records[3].rows.comment.edited_at_utc;
        },
        (records) =>
        {
            records[2].rows.commentRevision.created_at_utc = '2026-06-01T11:05:00.000Z';
        },
        (records) =>
        {
            delete records[2].relationship;
        }
    ];
    for (const mutate of mutations)
    {
        const input = rowInput();
        mutate(input.originalRecords);
        let callbacks = 0;
        await assert.rejects(resolveDemoTemporalBusinessRows({ ...input, onBatch: () => callbacks++ }), /explicit|matching|NULL|creation instant/u);
        assert.equal(callbacks, 0);
    }
    const profile = { ...rowInput().originalRecords[0], coordinate: { entityKind: 'profile' } };
    assert.throws(() => temporalBusinessSourceRecord(profile), /unsupported source entity kind profile/u);
});

test('original demo and scale source chronology is passed unchanged and rejected globally', async () =>
{
    for (const producerId of ['development-demo', 'scale-data'])
    {
        const input = rowInput(producerId);
        const record = input.originalRecords[0];
        if (producerId === 'development-demo')
        {
            record.rows.article.createtime = '2026-06-01T10:00:00.000Z';
            record.rows.articleRevision.created_at = '2026-06-01T10:05:00.000Z';
        }
        else
        {
            record.rows.article.createtime = '2024-02-29T23:59:58.000Z';
            record.rows.article.metadata_updated_at = '2024-02-29T23:59:59.000Z';
            record.rows.article.published_at = '2024-02-28T23:59:59.000Z';
            record.rows.articleRevision.created_at = '2024-02-29T23:59:59.000Z';
            record.rows.articlePublication.published_at = '2024-02-28T23:59:59.000Z';
        }
        const original = structuredClone(input.originalRecords);
        let callbacks = 0;
        const resolve = producerId === 'scale-data' ? resolveDataScaleTemporalBusinessRows : resolveDemoTemporalBusinessRows;
        await assert.rejects(resolve({ ...input, onBatch: () => callbacks++ }), /cross-field invariant/u);
        assert.equal(callbacks, 0);
        assert.deepEqual(input.originalRecords, original);
    }
});

test('changed second source pass cannot complete or deliver even one business callback', async () =>
{
    const input = rowInput();
    let opens = 0;
    let callbacks = 0;
    const records = () =>
    {
        const values = input.records();
        if (++opens === 2)
        {
            values[0].rows.article.createtime = '2026-06-01T08:59:00.000Z';
        }
        return values;
    };
    await assert.rejects(resolveDemoTemporalBusinessRows({ ...input, records, onBatch: () => callbacks++ }), /sealed source digest/u);
    assert.equal(callbacks, 0);
});

test('source iteration cancellation closes provider records and emits no root completion', async () =>
{
    const input = rowInput();
    const controller = new AbortController();
    let closed = 0;
    let callbacks = 0;
    const records = async function* ()
    {
        try
        {
            yield input.originalRecords[0];
            controller.abort();
            yield input.originalRecords[1];
        }
        finally
        {
            closed++;
        }
    };
    await assert.rejects(resolveDemoTemporalBusinessRows({ ...input, records, batchSize: 1,
        signal: controller.signal, onBatch: () => callbacks++ }), { name: 'AbortError' });
    assert.equal(closed, 1);
    assert.equal(callbacks, 0);
});

test('canonical packet cap and byte limits remain enforced before source acceptance', async () =>
{
    assert.throws(() => createTemporalBusinessRecordSource({ records: [], batchSize: 1 }), /replayable factory/u);
    assert.throws(() => createTemporalBusinessRecordSource({ records: () => [], batchSize: 1001 }), /bounded batch size/u);
    const input = rowInput();
    input.originalRecords[0].coordinate.semanticIdentity = 'x'.repeat(600_000);
    let callbacks = 0;
    await assert.rejects(resolveDemoTemporalBusinessRows({ ...input, batchSize: 1, onBatch: () => callbacks++ }), /exact bounded source batch/u);
    assert.equal(callbacks, 0);
});
