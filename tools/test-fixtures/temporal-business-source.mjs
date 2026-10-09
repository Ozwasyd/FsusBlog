const { TemporalContractError } = await import(new URL('../test/temporal-context.mjs', import.meta.url));
const { describeTemporalEntityPartition, MAX_TEMPORAL_BATCH_ENTITIES } = await import(new URL('../test/temporal-entity-stream.mjs', import.meta.url));

function fail(message)
{
    throw new TemporalContractError('temporal.business-source-invalid', message);
}

function row(value, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        fail(`${label} requires its actual source row`);
    }
    return value;
}

function column(source, name, label)
{
    if (!Object.hasOwn(source, name) || source[name] !== null && typeof source[name] !== 'string')
    {
        fail(`${label}.${name} requires an explicit serialized instant or NULL`);
    }
    return source[name];
}

function fact(value)
{
    return { applicability: value === null ? 'null' : 'instant', instantUtc: value };
}

function optionalRow(rows, name, stateFacts)
{
    const flag = name === 'articlePublication' ? 'hasPublication' : 'hasRevision';
    if (!Object.hasOwn(rows, name) || typeof stateFacts[flag] !== 'boolean'
        || stateFacts[flag] !== (rows[name] !== null))
    {
        fail(`${name} requires explicit row existence matching ${flag}`);
    }
    return rows[name] === null ? null : row(rows[name], name);
}

/**
 * Translate joined physical columns, never seed dates or distribution formulas.
 * Coordinates/state facts/relationships come from the original producer. UTC
 * serialization and every temporal/history invariant remain canonical-owned.
 */
export function temporalBusinessSourceRecord(record)
{
    const snapshot = structuredClone(record);
    const coordinate = row(snapshot?.coordinate, 'coordinate');
    const stateFacts = row(snapshot.stateFacts, 'stateFacts');
    const rows = row(snapshot.rows, 'rows');
    const facts = {};
    const missing = { applicability: 'not-generated', instantUtc: null };
    if (coordinate.entityKind === 'article')
    {
        const article = row(rows.article, 'article');
        const revision = optionalRow(rows, 'articleRevision', stateFacts);
        const publication = optionalRow(rows, 'articlePublication', stateFacts);
        facts['article.created'] = fact(column(article, 'createtime', 'article'));
        facts['article.metadata-updated'] = fact(column(article, 'metadata_updated_at', 'article'));
        facts['article.published'] = fact(column(article, 'published_at', 'article'));
        facts['article.revision'] = revision === null ? { ...missing } : fact(column(revision, 'created_at', 'articleRevision'));
        facts['article.publication'] = publication === null ? { ...missing } : fact(column(publication, 'published_at', 'articlePublication'));
    }
    else if (coordinate.entityKind === 'comment')
    {
        const comment = row(rows.comment, 'comment');
        const revision = optionalRow(rows, 'commentRevision', stateFacts);
        const created = column(comment, 'create_time', 'comment');
        const edited = column(comment, 'edited_at_utc', 'comment');
        const moderated = column(comment, 'moderated_at', 'comment');
        if (stateFacts.hasEditTime !== (edited !== null) || stateFacts.hasModerationTime !== (moderated !== null))
        {
            fail('comment NULL columns must match their supplied edit/moderation state facts');
        }
        if (revision !== null && coordinate.operationIdentity === 'created'
            && column(revision, 'created_at_utc', 'commentRevision') !== created)
        {
            fail('created comment revision must retain its actual creation instant');
        }
        facts['comment.created'] = fact(created);
        facts['comment.edited'] = fact(edited);
        facts['comment.moderated'] = fact(moderated);
    }
    else if (coordinate.entityKind === 'audit')
    {
        facts['audit.occurred'] = fact(column(row(rows.auditEvent, 'auditEvent'), 'occurred_at_utc', 'auditEvent'));
    }
    else
    {
        fail(`unsupported source entity kind ${coordinate.entityKind}; no temporal role alias is supplied`);
    }
    if (!Object.hasOwn(snapshot, 'relationship') || coordinate.entityKind !== 'comment' && snapshot.relationship !== null
        || coordinate.entityKind === 'comment' && snapshot.relationship?.commentIdentity !== coordinate.semanticIdentity)
    {
        fail('source requires its explicit original comment relationship or non-comment NULL');
    }
    return { entity: { coordinate, state: snapshot.state, stateFacts, facts }, relationship: snapshot.relationship };
}

/** Replayable bounded packet factory for the existing canonical stream resolver. */
export function createTemporalBusinessRecordSource({ records, batchSize = MAX_TEMPORAL_BATCH_ENTITIES, signal })
{
    signal?.throwIfAborted();
    if (typeof records !== 'function' || !Number.isSafeInteger(batchSize) || batchSize < 1
        || batchSize > MAX_TEMPORAL_BATCH_ENTITIES)
    {
        fail('record ingress requires a replayable factory and a canonical bounded batch size');
    }
    return async function* source()
    {
        signal?.throwIfAborted();
        let index = 0;
        let entityStartIndex = 0;
        let relationshipStartIndex = 0;
        let entities = [];
        let rootNested = [];
        function packet()
        {
            const input = { schema: 'fsusblog.temporal-entity-batch-input.v1', index, entities, rootNested };
            describeTemporalEntityPartition(input, { entityStartIndex, relationshipStartIndex });
            entityStartIndex += entities.length;
            relationshipStartIndex += rootNested.length;
            index++;
            entities = [];
            rootNested = [];
            return input;
        }
        for await (const record of records())
        {
            signal?.throwIfAborted();
            const mapped = temporalBusinessSourceRecord(record);
            entities.push(mapped.entity);
            if (mapped.relationship !== null)
            {
                rootNested.push(mapped.relationship);
            }
            if (entities.length === batchSize)
            {
                yield packet();
            }
        }
        signal?.throwIfAborted();
        if (entities.length > 0)
        {
            yield packet();
        }
    };
}
