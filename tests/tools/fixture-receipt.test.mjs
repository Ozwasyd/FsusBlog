/**
 * FixtureReceipt / ProducerReceipt contract tests (#1710).
 * Covers schema, digests, postconditions, observations, private I/O, and required counterexamples.
 */

import assert from 'node:assert/strict';
import fs, { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const { createFixtureArtifactOutlet } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));
const { createProducerContext } = await import(new URL('../../tools/test-fixtures/producer-port.mjs', import.meta.url));
const {
    assertNotAuthoritativeReceipt,
    assertPostconditionRegistryComplete,
    buildFixtureReceipt,
    buildProducerReceipt,
    digestCanonical,
    emptyDatabaseObservation,
    FIXTURE_ID_PROJECTION_SCHEMA,
    FIXTURE_RECEIPT_SCHEMA,
    listPostconditionIds,
    PRODUCER_RECEIPT_SCHEMA,
    projectFixtureIds,
    readFixtureReceipt,
    readPrivateJson,
    runPostcondition,
    validateFixtureReceipt,
    validateProducerReceipt,
    writeFixtureReceipt,
    writePrivateJson
} = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const {
    plan: planOrchestration,
    prepare,
    verify
} = await import(new URL('../../tools/test-fixtures/index.mjs', import.meta.url));
const {
    buildFixtureVariantPlan,
    buildProducerFixtureVariantPlan,
    fixtureCatalogDigest,
    readFixtureCatalogs
} = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogs = readFixtureCatalogs();
// Outlet tests are contract models, not PG/Redis/runtime qualification.
function outletModel(t, extra = {})
{
    const directory = fs.realpathSync(mkdtempSync(path.join(tmpdir(), 'fixture-outlet-model-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const planned = planOrchestration({ profileId: 'public-minimal', profileSource: 'dev-cli' }, {
        runId: 'outlet-unit-run', namespace: 'outlet-unit-ns',
        sourceIdentity: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
        handles: { serviceGeneration: `sha256:${'c'.repeat(64)}` }
    });
    const context = createProducerContext({ plan: planned, producerId: 'public-content', handles: {
        ...planned.executionIdentity.handles, fixtureArtifactConsumerId: 'unit-contract-consumer' } });
    return { directory, planned, context, outlet: createFixtureArtifactOutlet(path.join(directory, 'artifacts'), {
        plan: planned, consumerId: 'unit-contract-consumer', ...extra }) };
}

test('outlet: bounded secret-free port result is atomic, hashed and source/profile/consumer bound', (t) =>
{
    const { outlet, context } = outletModel(t);
    outlet.recordPort(context, 'verify', { ok: true, observations: { cache: { generation: '2' } }, privateCarrierReferences: ['must-not-dump'] }, [{ ok: true, postconditionId: 'public-published' }]);
    const refs = outlet.publish('verify');
    assert.equal(refs.length, 1);
    const loaded = readPrivateJson(refs[0].path);
    assert.equal(refs[0].digest, loaded.contentDigest);
    assert.equal(loaded.document.binding.consumerId, 'unit-contract-consumer');
    assert.equal(loaded.document.binding.profileId, 'public-minimal');
    assert.equal(loaded.document.binding.source.commit, 'a'.repeat(40));
    assert.deepEqual(loaded.document.result.observations, { cache: { generation: '2' } });
    assert.equal(JSON.stringify(loaded.document).includes('must-not-dump'), false);
    assert.throws(() => outlet.recordPort(context, 'verify', { ok: true }), /duplicate|closed/);
});

test('outlet: credential, binding, undefined cleanup and publication collisions fail closed', (t) =>
{
    const { outlet, context } = outletModel(t);
    assert.throws(() => outlet.recordPort(context, 'verify', { observations: { accessToken: 'sensitive' } }), /credential/);
    assert.throws(() => outlet.recordPort({ ...context, namespace: 'foreign' }, 'verify', { ok: true }), /binding/);
    assert.throws(() => outlet.recordPort({ ...context, handles: { serviceGeneration: `sha256:${'d'.repeat(64)}` } }, 'verify', { ok: true }), /binding/);
    assert.throws(() => outlet.recordPort(context, 'verify', { observations: { value: `Bearer ${'x'.repeat(40)}` } }), /credential/);
    outlet.recordPort(context, 'cleanup', undefined);
    assert.deepEqual(outlet.publish('cleanup'), []);
});

test('outlet: symlink and non-private directory are rejected without touching targets', (t) =>
{
    const directory = fs.realpathSync(mkdtempSync(path.join(tmpdir(), 'fixture-outlet-path-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const { planned } = outletModel(t);
    const target = path.join(directory, 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    const link = path.join(directory, 'link');
    symlinkSync(target, link);
    assert.throws(() => createFixtureArtifactOutlet(link, { plan: planned, consumerId: 'model' }), /symlink/);
    fs.chmodSync(target, 0o755);
    assert.throws(() => createFixtureArtifactOutlet(target, { plan: planned, consumerId: 'model' }), /private/);
    assert.deepEqual(fs.readdirSync(target), []);
});

test('private writer: already-aborted and temp-before-rename preserve previous bytes and remove temp', (t) =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fixture-outlet-abort-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'state.json');
    writePrivateJson(file, { old: true });
    const controller = new AbortController();
    const reason = new Error('outlet-original-cancel');
    const original = fs.writeFileSync;
    fs.writeFileSync = (...args) =>
    {
        const result = original(...args);
        if (String(args[0]).endsWith('.tmp'))
        {
            controller.abort(reason);
        }
        return result;
    };
    try
    {
        assert.throws(() => writePrivateJson(file, { next: true }, { signal: controller.signal }), (error) => error === reason);
    }
    finally
    {
        fs.writeFileSync = original;
    }
    assert.deepEqual(readPrivateJson(file).document, { old: true });
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
    assert.throws(() => writePrivateJson(file, { next: true }, { signal: controller.signal }), (error) => error === reason);
});

for (const field of ['run', 'source', 'profile', 'producer', 'variant', 'consumer'])
{
    test(`outlet: ${field} binding drift is rejected without publication`, (t) =>
    {
        const { outlet, context, directory } = outletModel(t);
        let foreign = { ...context };
        if (field === 'run')
        {
            foreign.runIdentity = 'foreign-run';
        }
        if (field === 'source')
        {
            foreign.sourceIdentity = { ...context.sourceIdentity, commit: 'f'.repeat(40) };
        }
        if (field === 'profile')
        {
            foreign.profileIdentity = { ...context.profileIdentity, profileId: 'auth-basic' };
        }
        if (field === 'producer')
        {
            foreign.producerId = 'auth-session';
        }
        if (field === 'variant')
        {
            foreign.variantPlan = { ...context.variantPlan, variants: [] };
        }
        if (field === 'consumer')
        {
            foreign.handles = { ...context.handles, fixtureArtifactConsumerId: 'foreign-consumer' };
        }
        assert.throws(() => outlet.recordPort(foreign, 'verify', { ok: true }), /binding/);
        assert.deepEqual(fs.readdirSync(path.join(directory, 'artifacts')), []);
    });
}

test('outlet: bounds bytes, protects receipt/carrier paths, rejects existing and ancestor-symlink outputs', (t) =>
{
    const { outlet, context, directory, planned } = outletModel(t);
    assert.throws(() => outlet.recordPort(context, 'verify', { observations: { value: 'x'.repeat(2 * 1024 * 1024) } }), /bounded/);
    assert.throws(() => createFixtureArtifactOutlet(path.join(directory, 'private'), { plan: planned,
        consumerId: 'model', protectedPaths: [path.join(directory, 'private', 'receipt.json')] }), /collides/);
    outlet.recordPort(context, 'verify', { ok: true });
    const collision = path.join(directory, 'artifacts', 'verify-public-content-port-result.json');
    writePrivateJson(collision, { prior: true });
    assert.throws(() => outlet.publish('verify'), /overwrite/);
    assert.deepEqual(readPrivateJson(collision).document, { prior: true });
    const parent = path.join(directory, 'parent');
    fs.mkdirSync(parent, { mode: 0o700 });
    const nested = createFixtureArtifactOutlet(path.join(parent, 'artifacts'), { plan: planned, consumerId: 'unit-contract-consumer' });
    nested.recordPort(context, 'verify', { ok: true });
    fs.renameSync(parent, path.join(directory, 'moved'));
    symlinkSync(path.join(directory, 'moved'), parent);
    assert.throws(() => nested.publish('verify'), /symlink/);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'moved', 'artifacts')), []);
});

test('private writer: rename failure retains original error and prior bytes; post-rename cancel cannot undo bytes', (t) =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fixture-outlet-writer-fault-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'receipt.json');
    writePrivateJson(file, { old: true });
    const original = fs.renameSync;
    const fault = new Error('actual-writer-rename-fault');
    fs.renameSync = () =>
    {
        throw fault;
    };
    try
    {
        assert.throws(() => writePrivateJson(file, { next: true }), (error) => error === fault);
    }
    finally
    {
        fs.renameSync = original;
    }
    assert.deepEqual(readPrivateJson(file).document, { old: true });
    assert.deepEqual(fs.readdirSync(directory), ['receipt.json']);
    const controller = new AbortController();
    fs.renameSync = (...args) =>
    {
        original(...args);
        controller.abort(fault);
    };
    try
    {
        assert.throws(() => writePrivateJson(file, { next: true }, { signal: controller.signal }), (error) => error === fault);
    }
    finally
    {
        fs.renameSync = original;
    }
    assert.deepEqual(readPrivateJson(file).document, { next: true });
    assert.deepEqual(fs.readdirSync(directory), ['receipt.json']);
});
const catalogDigest = fixtureCatalogDigest(catalogs);
const articleVariantIds = Object.freeze(['canonical.public.article.published']);
const articleVariantPlan = buildFixtureVariantPlan(articleVariantIds, catalogs);
const articleProducerVariantPlan = buildProducerFixtureVariantPlan({
    producerId: 'public-content',
    variantIds: articleVariantIds,
    fixtureVariantIds: articleVariantIds,
    fixtureVariantPlanDigest: articleVariantPlan.variantPlanDigest,
    catalogs
});

function articlePublishedObservations(overrides = {})
{
    const namespace = overrides.namespace ?? 'run-a';
    return {
        database: {
            namespace,
            schemaIdentity: 'public',
            catalogDigest,
            entities: [{
                kind: 'article',
                id: '101',
                variantId: articleVariantIds[0],
                owned: true,
                fields: {
                    status: 'published',
                    deleted: false,
                    currentPublicationId: 'pub-1',
                    publicDetailReadable: true,
                    ...(overrides.fields ?? {})
                }
            }]
        },
        redis: {
            namespace,
            keys: [{ domain: 'redis.cache.public', key: 'hot:101', present: true }]
        },
        cache: {
            namespace,
            entries: [{
                domain: 'public.home.featured-hot',
                generation: 'g1',
                matchesDb: true,
                visibleEntityIds: ['101']
            }]
        },
        ...overrides.top
    };
}

function baseProducerReceiptInput(extra = {})
{
    const namespace = extra.namespace ?? 'run-a';
    const observations = articlePublishedObservations({ namespace });
    return {
        producerId: 'public-content',
        strategy: 'transaction-fixture',
        runId: extra.runId ?? 'run-a',
        namespace,
        source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
        fixtureCatalogDigest: catalogDigest,
        profileId: 'public-minimal',
        expandedCapabilityDigest: digestCanonical(['public.article.published']),
        fixtureVariantIds: articleVariantIds,
        variantPlanDigest: articleVariantPlan.variantPlanDigest,
        producerVariantPlanDigest: articleProducerVariantPlan.producerVariantPlanDigest,
        producedVariantIds: articleVariantIds,
        serviceGeneration: 'gen-1',
        providedCapabilities: ['public.article.published'],
        ownedStateDomains: [
            'fixture.public-content',
            'postgres.article',
            'postgres.outbox',
            'redis.cache.public'
        ],
        entityIdentities: [{ kind: 'article', id: '101', variantId: articleVariantIds[0] }],
        postconditionObservations: [{
            capabilityId: 'public.article.published',
            postconditionId: 'article-published',
            ok: true,
            detail: { articleIds: ['101'] }
        }],
        databaseObservation: observations.database,
        redisObservation: observations.redis,
        cacheObservation: observations.cache,
        catalogs,
        ...extra,
        // Keep observation namespace aligned with identity after spread.
        ...{
            namespace,
            databaseObservation: extra.databaseObservation ?? observations.database,
            redisObservation: extra.redisObservation ?? observations.redis,
            cacheObservation: extra.cacheObservation ?? observations.cache
        }
    };
}

test('postcondition registry binds every #1707 capability postconditionId', () =>
{
    assertPostconditionRegistryComplete(catalogs);
    const ids = listPostconditionIds(catalogs);
    assert.ok(ids.includes('article-published'));
    assert.ok(ids.includes('user-mfa-enabled'));
    assert.ok(ids.includes('home-featured-hot'));
    assert.equal(ids.length >= 30, true);
});

test('ProducerReceipt and FixtureReceipt have unique schemas, validators, and digests', () =>
{
    const producer = buildProducerReceipt(baseProducerReceiptInput());
    assert.equal(producer.schema, PRODUCER_RECEIPT_SCHEMA);
    assert.ok(producer.producerReceiptDigest.startsWith('sha256:'));
    validateProducerReceipt(producer, { catalogs });

    const fixture = buildFixtureReceipt({
        terminalStatus: 'verified',
        executionIdentity: {
            runId: 'run-a',
            namespace: 'run-a',
            source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
            serviceGeneration: 'gen-1'
        },
        profileIdentity: {
            profileId: 'public-minimal',
            profileSource: 'dev-cli',
            executionClass: 'runtime'
        },
        catalogDigest,
        expandedCapabilityDigest: digestCanonical(['public.article.published']),
        orderedProducerReceiptDigests: [producer.producerReceiptDigest],
        producerReceipts: [producer],
        capabilityMap: [{
            capabilityId: 'public.article.published',
            producerId: 'public-content',
            postconditionIds: ['article-published']
        }],
        serviceIdentity: {
            databaseSchema: 'public',
            databaseInstance: 'fsusblog-test-postgres-run-a',
            redisInstance: 'fsusblog-test-redis-run-a',
            redisNamespace: 'FsusBlog_run-a_'
        },
        catalogs
    });
    assert.equal(fixture.schema, FIXTURE_RECEIPT_SCHEMA);
    assert.equal(fixture.terminalStatus, 'verified');
    assert.ok(fixture.receiptDigest.startsWith('sha256:'));
    assert.ok(fixture.databaseObservationDigest.startsWith('sha256:'));
    assert.ok(fixture.redisObservationDigest.startsWith('sha256:'));
    assert.ok(fixture.cacheObservationDigest.startsWith('sha256:'));
    assert.deepEqual(fixture.fixtureVariantIds, ['canonical.public.article.published']);
    validateFixtureReceipt(fixture, { catalogs, requireVerified: true });
});

test('ProducerReceipt canonical identity binds owner and catalog variant into its digest', () =>
{
    const identity = {
        kind: 'article',
        id: '101',
        handle: 'public-preview',
        variantId: articleVariantIds[0],
        owner: 'demo-fixture:0123456789abcdef01234567'
    };
    const receipt = buildProducerReceipt(baseProducerReceiptInput({
        entityIdentities: [identity]
    }));
    assert.equal(receipt.entityIdentities[0].variantId, identity.variantId);
    assert.equal(receipt.entityIdentities[0].owner, identity.owner);

    const differentOwner = buildProducerReceipt(baseProducerReceiptInput({
        entityIdentities: [{
            ...identity,
            owner: 'demo-fixture:89abcdef0123456701234567'
        }]
    }));
    assert.notEqual(receipt.producerReceiptDigest, differentOwner.producerReceiptDigest);

    const tampered = structuredClone(receipt);
    tampered.entityIdentities[0].owner = differentOwner.entityIdentities[0].owner;
    assert.throws(
        () => validateProducerReceipt(tampered, { catalogs }),
        /digest mismatch/
    );
});

test('none receipt proves zero business fixture mutation', async () =>
{
    const planned = planOrchestration({ profileId: 'none', profileSource: 'dev-cli' }, {
        runId: 'run-none',
        namespace: 'ns-none'
    });
    const prepared = await prepare(planned, []);
    const verified = await verify(prepared, []);
    assert.equal(verified.terminalStatus, 'verified');
    assert.equal(verified.zeroBusinessMutation, true);
    assert.deepEqual(verified.databaseObservation.entities, []);
    assert.deepEqual(verified.redisObservation.keys, []);
    assert.deepEqual(verified.cacheObservation.entries, []);
    assert.deepEqual(verified.outputArtifacts, []);
    assert.deepEqual(verified.orderedProducerReceiptDigests, []);
});

test('counterexample: article row exists but current_publication_id empty', () =>
{
    const result = runPostcondition('article-published', {
        observations: articlePublishedObservations({ fields: { currentPublicationId: '' } }),
        entityIdentities: [{ kind: 'article', id: '101' }],
        capabilityId: 'public.article.published',
        producerId: 'public-content'
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /current_publication_id/);
});

test('counterexample: DB correct but Redis hot key missing', () =>
{
    const result = runPostcondition('home-featured-hot', {
        observations: {
            database: articlePublishedObservations().database,
            redis: { namespace: 'run-a', keys: [] },
            cache: articlePublishedObservations().cache
        },
        entityIdentities: [{ kind: 'article', id: '101' }],
        capabilityId: 'public.home.featured-hot',
        producerId: 'public-content'
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Redis hot|missing/i);
});

test('counterexample: auth storage file exists but session revoked', () =>
{
    const result = runPostcondition('session-single-device', {
        observations: {
            database: {
                entities: [{ kind: 'session', id: 's1', fields: { active: true } }]
            },
            redis: {
                keys: [{ domain: 'redis.session', key: 'session:s1', present: true, sessionRevoked: true }]
            }
        },
        entityIdentities: [{ kind: 'session', id: 's1' }],
        capabilityId: 'session.single-device',
        producerId: 'auth-session'
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /revoked/i);
});

test('counterexample: producer provides undeclared capability', () =>
{
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            providedCapabilities: ['public.article.published', 'auth.user.active']
        })),
        /undeclared capability/
    );
});

test('counterexample: producer receipt rejects unregistered variants and unbound entities', () =>
{
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            fixtureCatalogDigest: `sha256:${'0'.repeat(64)}`
        })),
        /catalog digest does not match/
    );
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            variantPlanDigest: `sha256:${'0'.repeat(64)}`
        })),
        /digest is forged/
    );
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            producedVariantIds: ['unregistered.fixture.variant']
        })),
        /unregistered variant/
    );
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            producerVariantPlanDigest: `sha256:${'0'.repeat(64)}`
        })),
        /typed variant plan digest does not match/
    );
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            entityIdentities: [{ kind: 'article', id: '101' }]
        })),
        /variantId is required/
    );
    const observations = articlePublishedObservations();
    delete observations.database.entities[0].variantId;
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            databaseObservation: observations.database
        })),
        /references no produced variant/
    );
});

test('counterexample: receipt profile digest inconsistent with catalog capabilities', () =>
{
    const producer = buildProducerReceipt(baseProducerReceiptInput());
    const fixture = buildFixtureReceipt({
        terminalStatus: 'verified',
        executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
        profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
        catalogDigest,
        expandedCapabilityDigest: digestCanonical(['public.article.published']),
        orderedProducerReceiptDigests: [producer.producerReceiptDigest],
        producerReceipts: [producer],
        capabilityMap: [{
            capabilityId: 'public.article.published',
            producerId: 'public-content',
            postconditionIds: ['article-published']
        }],
        catalogs
    });
    // Body digest must fail when catalogDigest is rewritten without re-sealing.
    const wrongCatalog = { ...fixture, catalogDigest: `sha256:${'c'.repeat(64)}` };
    assert.throws(() => validateFixtureReceipt(wrongCatalog, { catalogs }), /digest mismatch|tampered/);
    // Cross-identity reuse: live catalog digest expectation refuses foreign receipt.
    assert.throws(
        () => validateFixtureReceipt(fixture, {
            catalogs,
            expectedCatalogDigest: `sha256:${'d'.repeat(64)}`
        }),
        /catalogDigest does not match|cross-identity/
    );
    // Producer expandedCapabilityDigest is profile-scoped; a different capability set differs.
    assert.notEqual(
        producer.expandedCapabilityDigest,
        digestCanonical(['public.article.published', 'public.home.featured-hot'])
    );
    // Re-bind with wrong ordered digests fails.
    assert.throws(
        () => buildFixtureReceipt({
            terminalStatus: 'verified',
            executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
            profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
            catalogDigest,
            expandedCapabilityDigest: digestCanonical(['public.article.published']),
            orderedProducerReceiptDigests: [`sha256:${'e'.repeat(64)}`],
            producerReceipts: [producer],
            capabilityMap: [{
                capabilityId: 'public.article.published',
                producerId: 'public-content',
                postconditionIds: ['article-published']
            }],
            catalogs
        }),
        /orderedProducerReceiptDigests must match/
    );
});

test('counterexample: partial producer success cannot be verified', async () =>
{
    const planned = planOrchestration({ profileId: 'scale-xs', profileSource: 'dev-cli' });
    const ports = planned.producerSpecs.map((spec) => ({
        id: spec.id,
        strategy: spec.strategy,
        providedCapabilities: [...spec.provides],
        consumedCapabilities: [...spec.consumes],
        async prepare(context)
        {
            if (spec.id === 'scale-data')
            {
                throw new Error('scale partial failure');
            }
            return {
                ok: true,
                producerId: spec.id,
                strategy: spec.strategy,
                variantIds: context.variantPlan.variants.map((item) => item.id),
                producerVariantPlanDigest: context.variantPlan.producerVariantPlanDigest,
                observations: articlePublishedObservations()
            };
        },
        async verify()
        {
            return { ok: true };
        },
        async cleanup()
        {}
    }));
    await assert.rejects(() => prepare(planned, ports), /scale partial failure/);
    try
    {
        await prepare(planned, ports);
    }
    catch (error)
    {
        assert.ok(error.receipt);
        assert.notEqual(error.receipt.terminalState, 'prepared');
        assert.deepEqual(error.receipt.producerReceipts, []);
        if (error.fixtureReceipt)
        {
            assert.notEqual(error.fixtureReceipt.terminalStatus, 'verified');
        }
    }
});

test('counterexample: tampered receipt fails integrity', () =>
{
    const producer = buildProducerReceipt(baseProducerReceiptInput());
    const fixture = buildFixtureReceipt({
        terminalStatus: 'verified',
        executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
        profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
        catalogDigest,
        expandedCapabilityDigest: digestCanonical(['public.article.published']),
        orderedProducerReceiptDigests: [producer.producerReceiptDigest],
        producerReceipts: [producer],
        capabilityMap: [{
            capabilityId: 'public.article.published',
            producerId: 'public-content',
            postconditionIds: ['article-published']
        }],
        catalogs
    });
    const tampered = { ...fixture, verifiedAt: '2099-01-01T00:00:00.000Z' };
    assert.throws(() => validateFixtureReceipt(tampered, { catalogs }), /digest mismatch|tampered/);
});

test('counterexample: symlink receipt is rejected', () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fixture-receipt-symlink-'));
    try
    {
        const real = path.join(directory, 'real.json');
        const link = path.join(directory, 'link.json');
        const producer = buildProducerReceipt(baseProducerReceiptInput());
        const fixture = buildFixtureReceipt({
            terminalStatus: 'verified',
            executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
            profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
            catalogDigest,
            expandedCapabilityDigest: digestCanonical(['public.article.published']),
            orderedProducerReceiptDigests: [producer.producerReceiptDigest],
            producerReceipts: [producer],
            capabilityMap: [{
                capabilityId: 'public.article.published',
                producerId: 'public-content',
                postconditionIds: ['article-published']
            }],
            catalogs
        });
        writeFixtureReceipt(real, fixture, { catalogs });
        symlinkSync(real, link);
        assert.throws(() => readFixtureReceipt(link, { catalogs }), /symlink/);
        assert.throws(() => writeFixtureReceipt(link, fixture, { catalogs }), /symlink/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('counterexample: none profile with fixture rows cannot verify', () =>
{
    assert.throws(
        () => buildFixtureReceipt({
            terminalStatus: 'verified',
            executionIdentity: { runId: 'r', namespace: 'n', source: null },
            profileIdentity: { profileId: 'none', profileSource: 'dev-cli' },
            catalogDigest,
            expandedCapabilityDigest: digestCanonical([]),
            orderedProducerReceiptDigests: [],
            producerReceipts: [],
            capabilityMap: [],
            databaseObservation: {
                entities: [{ kind: 'article', id: '1', fields: { status: 'published' } }]
            },
            catalogs
        }),
        /zero business fixture mutation/
    );
});

test('counterexample: cache endpoint still returns old article', () =>
{
    const result = runPostcondition('home-featured-hot', {
        observations: {
            database: {
                entities: [{
                    kind: 'article',
                    id: '101',
                    fields: { featured: true, hot: true, status: 'published' }
                }]
            },
            redis: {
                keys: [{ domain: 'redis.cache.public', key: 'hot:101', present: true }]
            },
            cache: {
                entries: [{
                    domain: 'public.home.featured-hot',
                    matchesDb: false,
                    visibleEntityIds: ['999']
                }]
            }
        },
        entityIdentities: [{ kind: 'article', id: '101' }],
        capabilityId: 'public.home.featured-hot',
        producerId: 'public-content'
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale|non-DB|missing/i);
});

test('counterexample: receipt containing access token is rejected', () =>
{
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            entityIdentities: [{ kind: 'user', id: 'u1', accessToken: 'secret-token-value' }]
        })),
        /secret field|secret\/token|forbids|accessToken/
    );
    assert.throws(
        () => buildProducerReceipt(baseProducerReceiptInput({
            entityIdentities: [{ kind: 'user', id: 'u1', handle: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb' }]
        })),
        /secret\/token|forbids/
    );
});

test('counterexample: current run refuses previous run receipt', () =>
{
    const producer = buildProducerReceipt(baseProducerReceiptInput({
        runId: 'run-old',
        namespace: 'ns-old'
    }));
    const fixture = buildFixtureReceipt({
        terminalStatus: 'verified',
        executionIdentity: {
            runId: 'run-old',
            namespace: 'ns-old',
            source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
            serviceGeneration: 'g1'
        },
        profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
        catalogDigest,
        expandedCapabilityDigest: digestCanonical(['public.article.published']),
        orderedProducerReceiptDigests: [producer.producerReceiptDigest],
        producerReceipts: [producer],
        capabilityMap: [{
            capabilityId: 'public.article.published',
            producerId: 'public-content',
            postconditionIds: ['article-published']
        }],
        catalogs
    });
    assert.throws(
        () => validateFixtureReceipt(fixture, {
            catalogs,
            requireVerified: true,
            expectedExecutionIdentity: {
                runId: 'run-new',
                namespace: 'ns-new',
                source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
                serviceGeneration: 'g1'
            }
        }),
        /execution identity mismatch|cross-run/
    );
});

test('atomic private write enforces 0600, integrity, and no dual v1 adapter', () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fixture-receipt-io-'));
    try
    {
        const producer = buildProducerReceipt(baseProducerReceiptInput());
        const fixture = buildFixtureReceipt({
            terminalStatus: 'verified',
            executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
            profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
            catalogDigest,
            expandedCapabilityDigest: digestCanonical(['public.article.published']),
            orderedProducerReceiptDigests: [producer.producerReceiptDigest],
            producerReceipts: [producer],
            capabilityMap: [{
                capabilityId: 'public.article.published',
                producerId: 'public-content',
                postconditionIds: ['article-published']
            }],
            catalogs
        });
        const file = path.join(directory, 'fixture-receipt.json');
        const written = writeFixtureReceipt(file, fixture, { catalogs });
        assert.ok(written.contentDigest.startsWith('sha256:'));
        if (process.platform !== 'win32')
        {
            assert.equal(written.mode & 0o777, 0o600);
        }
        const loaded = readFixtureReceipt(file, { catalogs, requireVerified: true });
        assert.equal(loaded.receiptDigest, fixture.receiptDigest);

        // retired schema adapter must fail
        const retired = path.join(directory, 'retired.json');
        writePrivateJson(retired, {
            schema: 'fsusblog.fixture-receipt.v1',
            kind: 'fixture-receipt',
            generatedAt: new Date().toISOString()
        });
        assert.throws(() => readFixtureReceipt(retired, { catalogs }), /retired|no dual adapter|schema/);

        // world-readable mode fails closed on unix
        if (process.platform !== 'win32')
        {
            chmodSync(file, 0o644);
            assert.throws(() => readPrivateJson(file, { label: 'FixtureReceipt' }), /private|0600/);
        }
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('narrow ID projection derives from verified receipt and is not authoritative', () =>
{
    const producer = buildProducerReceipt(baseProducerReceiptInput({
        entityIdentities: [
            { kind: 'article', id: '101', variantId: articleVariantIds[0] },
            { kind: 'category', id: '11', variantId: articleVariantIds[0] },
            { kind: 'tag', id: '22', variantId: articleVariantIds[0] }
        ]
    }));
    const fixture = buildFixtureReceipt({
        terminalStatus: 'verified',
        executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
        profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
        catalogDigest,
        expandedCapabilityDigest: digestCanonical(['public.article.published']),
        orderedProducerReceiptDigests: [producer.producerReceiptDigest],
        producerReceipts: [producer],
        capabilityMap: [{
            capabilityId: 'public.article.published',
            producerId: 'public-content',
            postconditionIds: ['article-published']
        }],
        catalogs
    });
    const projection = projectFixtureIds(fixture, { catalogs });
    assert.equal(projection.schema, FIXTURE_ID_PROJECTION_SCHEMA);
    assert.equal(projection.notAuthoritative, true);
    assert.equal(projection.articleId, '101');
    assert.equal(projection.categoryId, '11');
    assert.equal(projection.tagId, '22');
    assert.equal(projection.sourceReceiptDigest, fixture.receiptDigest);
    assert.throws(() => assertNotAuthoritativeReceipt(projection), /not an authoritative/);
    assert.throws(
        () => assertNotAuthoritativeReceipt({ schema: 'fsusblog.fixture-receipt.v1' }),
        /retired|cannot authorize/
    );
});

test('local fallback observations cannot verify postconditions', () =>
{
    const result = runPostcondition('article-published', {
        observations: {
            ...articlePublishedObservations(),
            source: 'local-fallback',
            fallback: true
        },
        entityIdentities: [{ kind: 'article', id: '101' }],
        capabilityId: 'public.article.published',
        producerId: 'public-content'
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /fallback|warning|stale/);
});

test('observation digests are stable and sensitive to field drift not mtime', () =>
{
    const left = emptyDatabaseObservation({ namespace: 'n', catalogDigest, serviceGeneration: 'g' });
    const right = emptyDatabaseObservation({ namespace: 'n', catalogDigest, serviceGeneration: 'g' });
    assert.equal(digestCanonical(left), digestCanonical(right));
    const drifted = {
        ...articlePublishedObservations().database,
        entities: [{
            kind: 'article',
            id: '101',
            fields: {
                status: 'published',
                deleted: false,
                currentPublicationId: 'pub-2',
                publicDetailReadable: true,
                mtime: 'ignored-by-absence'
            }
        }]
    };
    assert.notEqual(
        digestCanonical(articlePublishedObservations().database),
        digestCanonical(drifted)
    );
});

test('code search: retired dual receipt adapters and local fallback success evidence are gone', () =>
{
    const cli = readFileSync(path.join(root, 'tools/test-fixtures/cli.mjs'), 'utf8');
    const catalog = readFileSync(path.join(root, 'tools/testing/fixture-catalog.mjs'), 'utf8');
    const publicProducer = readFileSync(path.join(root, 'tools/test-fixtures/producers/public-content-producer.mjs'), 'utf8');
    const bootstrap = readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    assert.doesNotMatch(cli, /toLegacyFixtureReceipt|function toLegacy/);
    assert.doesNotMatch(cli, /fsusblog\.fixture-receipt\.v1/);
    assert.match(cli, /dual\/legacy receipt paths were deleted|FixtureReceipt v2 is the sole authority/);
    assert.match(catalog, /kind=fixture-receipt was deleted|FixtureReceipt v2/);
    assert.doesNotMatch(publicProducer, /function buildSeededArticleFallback|function seedPublicFixtures\(|function runPsql\(|seedPublicFixturesViaApi/);
    assert.doesNotMatch(publicProducer, /using direct DB seed|admin API seeding unavailable; using direct DB seed/);
    assert.match(publicProducer, /transaction-fixture/);
    assert.doesNotMatch(bootstrap, /--legacy-|toLegacyFixtureReceipt/);
    assert.match(bootstrap, /notFixtureCompletenessEvidence|runtime-topology-only|FixtureReceipt/);
});
