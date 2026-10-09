const { bindTemporalEntityBusinessFields, bindTemporalEntityBatchBusinessFields, iterateTemporalEntityBusinessBatches } = await import(new URL('../test-fixtures/temporal-business-fields.mjs', import.meta.url));
const { resolveTemporalBusinessFieldStream } = await import(new URL('../test-fixtures/temporal-business-stream.mjs', import.meta.url));
const { createTemporalBusinessRecordSource } = await import(new URL('../test-fixtures/temporal-business-source.mjs', import.meta.url));

export const dataScaleTemporalFieldMappings = Object.freeze([
    ['row.created-at', 'scale.row-created'],
    ['article.createtime', 'article.created'],
    ['article.metadata-updated-at', 'article.metadata-updated'],
    ['article.published-at', 'article.published'],
    ['article-revision.created-at', 'article.revision', 'hasRevision'],
    ['article-publication.published-at', 'article.publication', 'hasPublication'],
    ['comment.create-time', 'comment.created']
].map(([field, roleId, rowPresence]) => Object.freeze({ field, roleId,
    entityKind: roleId.split('.')[0], ...(rowPresence ? { rowPresence } : {}) })));

/**
 * Project already resolved scale coordinates for a set-based PostgreSQL writer.
 * The distribution authority must resolve ordinals before calling this consumer;
 * this module owns no ordinal formula, tier counts, epoch or distribution table.
 */
export function bindDataScaleTemporalBusinessFields(input)
{
    if (input?.temporalContext?.producerId !== 'scale-data')
    {
        throw new Error('data-scale temporal binding requires scale-data context');
    }
    const bind = input?.artifact?.schema === 'fsusblog.resolved-temporal-entity-batch.v2'
        ? bindTemporalEntityBatchBusinessFields : bindTemporalEntityBusinessFields;
    return bind({ ...input, fieldMappings: dataScaleTemporalFieldMappings });
}

/** Replay sealed bounded input through the sole v2 authority and a business-field handler. */
export function resolveDataScaleTemporalBusinessStream(input)
{
    if (input?.temporalContext?.producerId !== 'scale-data')
    {
        throw new Error('data-scale temporal stream requires scale-data context');
    }
    return resolveTemporalBusinessFieldStream({ ...input, fieldMappings: dataScaleTemporalFieldMappings });
}

/** Consume explicitly joined seed rows; distribution/ordinal assignment stays upstream. */
export function resolveDataScaleTemporalBusinessRows(input)
{
    const source = createTemporalBusinessRecordSource(input);
    return resolveDataScaleTemporalBusinessStream({ ...input, source });
}

/** Transport an already accepted whole plan; this cannot qualify oversized plans. */
export function iterateDataScaleTemporalBusinessBatches(input, options = {})
{
    options.signal?.throwIfAborted();
    return iterateTemporalEntityBusinessBatches(bindDataScaleTemporalBusinessFields(input), options);
}
