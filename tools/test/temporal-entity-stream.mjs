import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { digestCanonical, TemporalContractError, validateTemporalContext } from './temporal-context.mjs';
import { readTemporalDomainProducerInventory, resolveTemporalEntityRecord, resolveTemporalEntityRelations, resolveTemporalRoles } from './temporal-role-resolver.mjs';
import { readTemporalShapeCatalog, resolveTemporalEntityShape } from './temporal-shape-catalog.mjs';

export const MAX_TEMPORAL_BATCH_ENTITIES = 1000;
export const MAX_TEMPORAL_BATCH_BYTES = 512 * 1024;
export const MAX_TEMPORAL_STREAM_RECORDS = 10_000_000;
const maximumBatches = 20_000;
const maximumParentDepth = 1024;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const issuedBatches = new WeakMap();

function fail(message)
{
    throw new TemporalContractError('temporal.entity-stream-invalid', message);
}

function exactKeys(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    {
        fail(`${label} requires exact declared fields`);
    }
}

function integer(value, maximum, label)
{
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    {
        fail(`${label} exceeds its bounded contract`);
    }
}

function validatePlan(plan, context, fixture, shape)
{
    exactKeys(plan, ['schema', 'sourcePlanDigest', 'distribution', 'recordCount', 'relationshipCount', 'batchCount'], 'stream plan');
    if (plan.schema !== 'fsusblog.temporal-entity-stream-plan.v1'
        || !digestPattern.test(plan.sourcePlanDigest) || plan.sourcePlanDigest !== fixture.planDigest
        || fixture.producerId !== context.producerId || fixture.runId !== context.schedulerRunId
        || typeof fixture.namespace !== 'string' || !fixture.namespace.trim()
        || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(fixture.fixtureId ?? ''))
    {
        fail('stream plan requires its original source/fixture/context identities');
    }
    exactKeys(fixture, ['producerId', 'runId', 'namespace', 'fixtureId', 'planDigest'], 'fixture identity');
    integer(plan.recordCount, MAX_TEMPORAL_STREAM_RECORDS, 'record count');
    integer(plan.relationshipCount, 1_000_000, 'relationship count');
    integer(plan.batchCount, maximumBatches, 'batch count');
    const distribution = plan.distribution;
    exactKeys(distribution, ['kind', 'tier', 'ordinalBase', 'counts', 'stateCounts'], 'stream distribution');
    const expectedKind = context.producerId === 'scale-data' ? 'scale' : context.producerId === 'development-demo' ? 'demo' : null;
    if (expectedKind === null || distribution.kind !== expectedKind || ![0, 1].includes(distribution.ordinalBase)
        || (expectedKind === 'scale' ? !['scale-xs', 'scale-s', 'scale-m', 'scale-l-nightly'].includes(distribution.tier)
            : distribution.tier !== null))
    {
        fail('stream distribution kind/tier/ordinal base is not the producer contract');
    }
    exactKeys(distribution.counts, shape.entityKinds.map((kind) => kind.kind), 'stream counts');
    exactKeys(distribution.stateCounts, shape.entityKinds.map((kind) => kind.kind), 'stream state counts');
    let uniqueCount = 0;
    for (const kind of shape.entityKinds)
    {
        integer(distribution.counts[kind.kind], 1_000_000, `${kind.kind} count`);
        uniqueCount += distribution.counts[kind.kind];
        exactKeys(distribution.stateCounts[kind.kind], kind.states, 'stream state closure');
        for (const count of Object.values(distribution.stateCounts[kind.kind]))
        {
            integer(count, 1_000_000, 'state count');
        }
        if (Object.values(distribution.stateCounts[kind.kind]).reduce((sum, count) => sum + count, 0) !== distribution.counts[kind.kind])
        {
            fail('declared state counts do not sum to their entity count');
        }
    }
    if (plan.recordCount < uniqueCount || plan.relationshipCount !== distribution.counts.comment)
    {
        fail('stream record and relationship counts do not cover the declared entities');
    }
}

function initialize(database)
{
    database.exec(`
        PRAGMA cache_size=-8192;
        PRAGMA temp_store=FILE;
        PRAGMA mmap_size=0;
        PRAGMA max_page_count=4194304;
        CREATE TABLE identities(kind TEXT, identity TEXT, ordinal INTEGER, created INTEGER,
            revision INTEGER, state TEXT, article TEXT, PRIMARY KEY(kind,identity), UNIQUE(kind,ordinal));
        CREATE TABLE revisions(identity TEXT, number INTEGER, instant INTEGER, PRIMARY KEY(identity,number));
        CREATE TABLE publications(identity TEXT, number INTEGER, revision INTEGER, instant INTEGER, PRIMARY KEY(identity,number));
        CREATE TABLE points(position INTEGER PRIMARY KEY, batch INTEGER, kind TEXT, identity TEXT, operation TEXT,
            payload TEXT, UNIQUE(kind,identity,operation));
        CREATE INDEX points_batch ON points(batch,position);
        CREATE TABLE links(identity TEXT PRIMARY KEY, parent TEXT, root TEXT, resolved_root TEXT, batch INTEGER, depth INTEGER);
        CREATE INDEX links_batch ON links(batch);
    `);
}

function createStore(database)
{
    const statements = {};
    const query = (sql) => statements[sql] ??= database.prepare(sql);
    return { database, query,
        addEntity(entity, position, batch)
        {
            const c = entity.coordinate;
            const roles = new Map(entity.roles.map((role) => [role.roleId, role]));
            const created = roles.get(`${c.entityKind}.created`)?.epochMilliseconds ?? null;
            const old = query('SELECT * FROM identities WHERE kind=? AND identity=?').get(c.entityKind, c.semanticIdentity);
            if (old && (old.ordinal !== c.ordinal || old.created !== created || old.revision > (c.revisionNumber ?? 0)
                || old.article !== c.articleIdentity))
            {
                fail('entity history changes creation, ordinal, article identity or moves revision backwards');
            }
            query(`INSERT INTO identities VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind,identity)
                DO UPDATE SET revision=excluded.revision,state=excluded.state`).run(c.entityKind, c.semanticIdentity,
                c.ordinal, created, c.revisionNumber ?? 0, entity.state, c.articleIdentity);
            if (c.entityKind === 'article' && c.revisionNumber !== null)
            {
                const instant = roles.get('article.revision').epochMilliseconds;
                const previous = query('SELECT instant FROM revisions WHERE identity=? AND number=?').get(c.semanticIdentity, c.revisionNumber);
                if (previous && previous.instant !== instant
                    || query('SELECT 1 AS invalid FROM revisions WHERE identity=? AND number<? AND instant>? LIMIT 1')
                        .get(c.semanticIdentity, c.revisionNumber, instant))
                {
                    fail('revision history changes an existing instant or moves backwards');
                }
                query('INSERT OR IGNORE INTO revisions VALUES (?,?,?)').run(c.semanticIdentity, c.revisionNumber, instant);
            }
            if (c.publicationNumber !== null)
            {
                const instant = roles.get('article.publication').epochMilliseconds;
                const previous = query('SELECT * FROM publications WHERE identity=? AND number=?').get(c.semanticIdentity, c.publicationNumber);
                if (previous && (previous.revision !== c.publicationRevisionNumber || previous.instant !== instant)
                    || roles.get('article.published').epochMilliseconds !== instant)
                {
                    fail('publication history changed its revision or publication instant');
                }
                query('INSERT OR IGNORE INTO publications VALUES (?,?,?,?)')
                    .run(c.semanticIdentity, c.publicationNumber, c.publicationRevisionNumber, instant);
            }
            query('INSERT INTO points VALUES (?,?,?,?,?,?)').run(position, batch, c.entityKind, c.semanticIdentity,
                c.operationIdentity, JSON.stringify(entity));
        },
        addLink(link, batch)
        {
            exactKeys(link, ['commentIdentity', 'parentIdentity', 'rootIdentity'], 'stream comment relationship');
            for (const value of [link.commentIdentity, ...(link.parentIdentity === null ? [] : [link.parentIdentity, link.rootIdentity])])
            {
                if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value)
                {
                    fail('comment relationship requires explicit bounded source identities');
                }
            }
            if (link.parentIdentity === null && link.rootIdentity !== null)
            {
                fail('root comment must preserve the actual NULL root identity');
            }
            query('INSERT INTO links VALUES (?,?,?,?,?,?)').run(link.commentIdentity, link.parentIdentity,
                link.rootIdentity, link.parentIdentity === null ? link.commentIdentity : null, batch,
                link.parentIdentity === null ? 0 : null);
        }
    };
}

function validateWholePlan(store, plan, shape, catalog)
{
    const { query, database } = store;
    for (const kind of shape.entityKinds)
    {
        const observed = query('SELECT COUNT(*) AS count, MIN(ordinal) AS first, MAX(ordinal) AS last FROM identities WHERE kind=?').get(kind.kind);
        const count = plan.distribution.counts[kind.kind];
        if (observed.count !== count || count > 0 && (observed.first !== plan.distribution.ordinalBase
            || observed.last !== plan.distribution.ordinalBase + count - 1))
        {
            fail('whole-plan count/ordinal distribution differs from the declaration');
        }
        for (const state of kind.states)
        {
            if (query('SELECT COUNT(*) AS count FROM identities WHERE kind=? AND state=?').get(kind.kind, state).count
                !== plan.distribution.stateCounts[kind.kind][state])
            {
                fail('whole-plan final state counts differ from the declaration');
            }
        }
    }
    const badRelationships = query(`SELECT 1 FROM links l
        LEFT JOIN identities c ON c.kind='comment' AND c.identity=l.identity
        LEFT JOIN identities p ON p.kind='comment' AND p.identity=l.parent
        LEFT JOIN identities r ON r.kind='comment' AND r.identity=l.root
        WHERE c.identity IS NULL OR l.parent IS NOT NULL AND
            (p.identity IS NULL OR r.identity IS NULL OR p.created>c.created OR p.article<>c.article OR r.article<>c.article)
        LIMIT 1`).get();
    if (badRelationships || query(`SELECT 1 FROM identities c LEFT JOIN links l ON c.identity=l.identity
        LEFT JOIN identities a ON a.kind='article' AND a.identity=c.article
        WHERE c.kind='comment' AND (l.identity IS NULL OR a.identity IS NULL) LIMIT 1`).get())
    {
        fail('whole-plan comment coverage, article ownership or parent chronology is invalid');
    }
    for (let depth = 0; query('SELECT 1 FROM links WHERE resolved_root IS NULL LIMIT 1').get(); depth++)
    {
        if (depth >= maximumParentDepth)
        {
            fail('comment chain exceeds the explicit bounded depth contract');
        }
        const changed = query(`UPDATE links SET resolved_root=(SELECT p.resolved_root FROM links p WHERE p.identity=links.parent),
            depth=(SELECT p.depth+1 FROM links p WHERE p.identity=links.parent)
            WHERE resolved_root IS NULL AND EXISTS
                (SELECT 1 FROM links p WHERE p.identity=links.parent AND p.resolved_root IS NOT NULL)`).run();
        if (changed.changes === 0)
        {
            fail('whole-plan comment relationships contain a cycle or disconnected root');
        }
        if (query('SELECT 1 FROM links WHERE depth>? LIMIT 1').get(maximumParentDepth))
        {
            fail('comment chain exceeds the explicit bounded depth contract');
        }
    }
    if (query('SELECT 1 FROM links WHERE parent IS NOT NULL AND root<>resolved_root LIMIT 1').get())
    {
        fail('declared root differs from the whole-plan parent chain');
    }
    const revisionLookup = (identity, number) =>
    {
        const value = query('SELECT instant FROM revisions WHERE identity=? AND number=?').get(identity, number);
        return value ? { roleId: 'article.revision', applicability: 'instant', epochMilliseconds: value.instant } : undefined;
    };
    database.exec('BEGIN');
    for (const point of query('SELECT position,payload FROM points ORDER BY position').iterate())
    {
        const entity = JSON.parse(point.payload);
        entity.relations = resolveTemporalEntityRelations(entity, { shape, catalog, revisionLookup });
        if (entity.coordinate.entityKind === 'comment')
        {
            const link = query('SELECT parent FROM links WHERE identity=?').get(entity.coordinate.semanticIdentity);
            entity.relations.push({ id: 'comment-parent-chronology', roleIds: ['comment.created'],
                status: link.parent === null ? 'state-bound' : 'verified', nullRoleIds: [], parentIdentity: link.parent });
        }
        query('UPDATE points SET payload=? WHERE position=?').run(JSON.stringify(entity), point.position);
    }
    database.exec('COMMIT');
}

function seal(value)
{
    const snapshot = structuredClone(value);
    const semanticDigest = digestCanonical(snapshot);
    return Object.freeze({ ...snapshot, semanticDigest, contentDigest: digestCanonical({ ...snapshot, semanticDigest }) });
}

/**
 * Resolve bounded input batches against one declared ordinary plan using a private disk index.
 * No output callback occurs until every count/history/parent relation has passed globally.
 * The existing single-input million-record cap is unchanged; no whole-stream array is built.
 */
export async function resolveTemporalEntityStream({ temporalContext, fixtureIdentity, streamPlan, batches, onBatch })
{
    const context = validateTemporalContext(temporalContext);
    const plan = structuredClone(streamPlan);
    const fixture = structuredClone(fixtureIdentity);
    const loaded = readTemporalShapeCatalog();
    const binding = readTemporalDomainProducerInventory().producerBindings.find((value) => value.producerId === context.producerId);
    if (binding?.resolutionMode !== 'entity-plan' || typeof onBatch !== 'function')
    {
        fail('stream resolution requires a registered entity producer and bounded output consumer');
    }
    const { shape, shapeDigest } = resolveTemporalEntityShape(binding.shapeId, { catalog: loaded });
    validatePlan(plan, context, fixture, shape);
    const { DatabaseSync } = await import('node:sqlite');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-temporal-stream-'));
    let database;
    try
    {
        database = new DatabaseSync(path.join(directory, 'ordinary-plan.sqlite'));
        initialize(database);
        const store = createStore(database);
        const descriptors = [];
        let recordCount = 0;
        let relationshipCount = 0;
        for await (const input of batches)
        {
            exactKeys(input, ['schema', 'index', 'entities', 'rootNested'], 'stream batch');
            if (input.schema !== 'fsusblog.temporal-entity-batch-input.v1' || input.index !== descriptors.length
                || !Array.isArray(input.entities) || !Array.isArray(input.rootNested)
                || input.entities.length > MAX_TEMPORAL_BATCH_ENTITIES || input.rootNested.length > MAX_TEMPORAL_BATCH_ENTITIES
                || input.entities.length + input.rootNested.length === 0
                || Buffer.byteLength(JSON.stringify(input)) > MAX_TEMPORAL_BATCH_BYTES
                || descriptors.length >= plan.batchCount || recordCount + input.entities.length > plan.recordCount
                || relationshipCount + input.rootNested.length > plan.relationshipCount)
            {
                fail('batch order/count/bytes exceed the declared bounded stream');
            }
            const inputDigest = digestCanonical(input);
            database.exec('BEGIN');
            for (const row of input.entities)
            {
                const entity = resolveTemporalEntityRecord(row, { shape, businessEpochMilliseconds: Date.parse(context.businessEpochUtc) });
                store.addEntity(entity, recordCount++, input.index);
            }
            for (const link of input.rootNested)
            {
                store.addLink(link, input.index);
                relationshipCount++;
            }
            database.exec('COMMIT');
            descriptors.push({ index: input.index, inputDigest, entityCount: input.entities.length, relationshipCount: input.rootNested.length });
        }
        if (recordCount !== plan.recordCount || relationshipCount !== plan.relationshipCount || descriptors.length !== plan.batchCount)
        {
            fail('stream ended before the declared complete record/relationship/batch counts');
        }
        validateWholePlan(store, plan, shape, loaded.catalog);
        const contextIdentity = { producerId: context.producerId, schedulerRunId: context.schedulerRunId,
            contextDigest: digestCanonical(context), sourceCommit: context.sourceCommit, sourceFingerprint: context.sourceFingerprint,
            businessEpochUtc: context.businessEpochUtc };
        const streamPlanDigest = digestCanonical(plan);
        const common = { qualificationEligible: false, contextIdentity, fixtureIdentity: fixture,
            catalog: { schema: loaded.catalog.schema, digest: loaded.catalogDigest }, shape: { id: shape.id, digest: shapeDigest },
            streamPlan: plan, streamPlanDigest, scalarRolesPurpose: 'canonical-planned-offsets', unsupportedFields: structuredClone(binding.unsupportedFields) };
        const makeBatch = (descriptor) =>
        {
            const entities = store.query('SELECT payload FROM points WHERE batch=? ORDER BY position').all(descriptor.index)
                .map((point) => JSON.parse(point.payload));
            const relationships = store.query('SELECT identity,parent,root FROM links WHERE batch=? ORDER BY rowid').all(descriptor.index)
                .map((link) => ({ commentIdentity: link.identity, parentIdentity: link.parent, rootIdentity: link.root }));
            const references = new Map();
            for (const entity of entities)
            {
                const coordinate = entity.coordinate;
                if (coordinate.publicationNumber !== null)
                {
                    const revision = store.query('SELECT instant FROM revisions WHERE identity=? AND number=?')
                        .get(coordinate.semanticIdentity, coordinate.publicationRevisionNumber);
                    references.set(JSON.stringify([coordinate.semanticIdentity, coordinate.publicationRevisionNumber]), {
                        semanticIdentity: coordinate.semanticIdentity, revisionNumber: coordinate.publicationRevisionNumber,
                        role: { roleId: 'article.revision', applicability: 'instant', epochMilliseconds: revision.instant,
                            instantUtc: new Date(revision.instant).toISOString() } });
                }
            }
            const artifact = seal({ schema: 'fsusblog.resolved-temporal-entity-batch.v1', ...common,
                batch: { index: descriptor.index, inputDigest: descriptor.inputDigest,
                    entityCount: descriptor.entityCount, relationshipCount: descriptor.relationshipCount },
                entities, relationships, referencedRevisions: [...references.values()], scalarRoles: null });
            if (Buffer.byteLength(JSON.stringify(artifact)) > 1024 * 1024)
            {
                fail('resolved batch exceeds the existing bounded transport size; split the input batch');
            }
            return artifact;
        };
        // Validate every output bound before the first consumer can receive a batch.
        for (const descriptor of descriptors)
        {
            const artifact = makeBatch(descriptor);
            descriptor.artifactDigest = artifact.contentDigest;
        }
        for (const descriptor of descriptors)
        {
            const artifact = makeBatch(descriptor);
            issuedBatches.set(artifact, artifact.contentDigest);
            await onBatch(artifact);
        }
        const scalarRoles = binding.scalarRoleIds.length === 0 ? null : resolveTemporalRoles({ temporalContext: context,
            fixtureIdentity: fixture, shapeId: 'auth-security-messaging-account-lifecycle', roleIds: binding.scalarRoleIds });
        return seal({ schema: 'fsusblog.resolved-temporal-entity-stream.v1', ...common, streamPlan: plan,
            recordCount, relationshipCount, batches: descriptors, scalarRoles, validation: 'complete-ordinary-plan' });
    }
    catch (error)
    {
        if (error.code === 'ERR_SQLITE_ERROR')
        {
            fail(`ordinary plan disk index refused the input: ${error.message}`);
        }
        throw error;
    }
    finally
    {
        try
        {
            database?.close();
        }
        finally
        {
            await rm(directory, { recursive: true, force: true });
        }
    }
}

/** Consume only a batch issued after this resolver completed the whole ordinary input plan. */
export function verifyResolvedTemporalEntityBatch(artifact, { temporalContext })
{
    const context = validateTemporalContext(temporalContext);
    const { contentDigest, ...unsigned } = artifact;
    if (issuedBatches.get(artifact) !== contentDigest || digestCanonical(unsigned) !== contentDigest
        || artifact.contextIdentity.contextDigest !== digestCanonical(context) || artifact.qualificationEligible !== false)
    {
        fail('batch consumption requires the original globally validated stream callback artifact/context');
    }
    return Object.freeze({ qualificationEligible: false, contentDigest,
        entityCount: artifact.entities.length, streamPlanDigest: artifact.streamPlanDigest });
}

export function createTemporalEntityBatchReceipt(artifact, { temporalContext })
{
    verifyResolvedTemporalEntityBatch(artifact, { temporalContext });
    const value = structuredClone(artifact);
    delete value.schema;
    delete value.contentDigest;
    return Object.freeze({ ...value, schema: 'fsusblog.temporal-entity-batch-receipt.v1',
        temporalContext: structuredClone(validateTemporalContext(temporalContext)), resolvedArtifactDigest: artifact.contentDigest,
        contentDigest: digestCanonical({ ...value, schema: 'fsusblog.temporal-entity-batch-receipt.v1',
            temporalContext: validateTemporalContext(temporalContext), resolvedArtifactDigest: artifact.contentDigest }) });
}
