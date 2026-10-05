import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { plan } = await import(new URL('../../tools/test-fixtures/orchestrator.mjs', import.meta.url));
const { buildProducerFixtureVariantPlan } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const { buildProducerReceipt, verifyCapabilityPostconditions } = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const { aggregateVerifiedFixtureReceipt } = await import(new URL('../../tools/test-fixtures/receipt/fixture-receipt.mjs', import.meta.url));
const { verifyAuthPublicPrerequisites, writeVerifiedAdminPrerequisiteProjection } = await import(new URL('../../tools/test-fixtures/receipt/projection.mjs', import.meta.url));
const { persistAuthPrivateCarrier } = await import(new URL('../../tools/test-fixtures/producers/auth-session-producer.mjs', import.meta.url));

function receipt(profileId, producerId, entities, executionOverrides = {})
{
    const planned = plan({ profileId, profileSource: 'dev-cli', executionClass: 'runtime' }, {
        runId: 'run', namespace: 'ns', sourceIdentity: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
        handles: { serviceGeneration: `sha256:${'c'.repeat(64)}`, pgContainer: 'owned-pg', redisContainer: 'owned-redis' },
        ...executionOverrides
    });
    const variants = buildProducerFixtureVariantPlan({ producerId, variantIds: planned.variantIds,
        fixtureVariantIds: planned.variantIds, fixtureVariantPlanDigest: planned.variantPlanDigest });
    const database = { namespace: 'ns', entities: entities.map((entity) => ({ ...entity,
        variantId: variants.variants.find((variant) => variant.capabilityId === entity.capabilityHint)?.id ?? variants.variants[0].id })) };
    const observations = { source: 'service', database, redis: { namespace: 'ns', keys: [] }, cache: { namespace: 'ns', entries: [] } };
    const entityIdentities = database.entities.map((entity) => ({ kind: entity.kind, id: entity.id, variantId: entity.variantId, owner: `${producerId}:ns:run` }));
    const conditions = verifyCapabilityPostconditions({ capabilities: planned.capabilities, producerId,
        providedCapabilities: planned.capabilities, observations, entityIdentities });
    assert.equal(conditions.ok, true, JSON.stringify(conditions));
    const spec = planned.producerSpecs.find((item) => item.id === producerId);
    const produced = buildProducerReceipt({ producerId, strategy: 'transaction-fixture', runId: 'run', namespace: 'ns',
        source: planned.executionIdentity.sourceIdentity, fixtureCatalogDigest: planned.catalogDigest, profileId,
        expandedCapabilityDigest: planned.expandedCapabilityDigest, fixtureVariantIds: planned.variantIds,
        variantPlanDigest: planned.variantPlanDigest, producerVariantPlanDigest: variants.producerVariantPlanDigest,
        producedVariantIds: variants.variants.map((variant) => variant.id), serviceGeneration: planned.executionIdentity.handles.serviceGeneration,
        providedCapabilities: planned.capabilities, ownedStateDomains: spec.stateDomains, entityIdentities,
        postconditionObservations: conditions.results, databaseObservation: observations.database,
        redisObservation: observations.redis, cacheObservation: observations.cache });
    return aggregateVerifiedFixtureReceipt({ plan: planned, producerReceipts: [produced] });
}

function pair()
{
    const expiry = '2027-01-01T00:00:00.000Z';
    const admin = { kind: 'admin', id: '7', owned: true, capabilityHint: 'auth.admin.full-permission',
        postconditionId: 'admin-full-permission', semanticRole: 'admin.full-permission', fixtureIdentity: 'fxauth-owned',
        fields: { permission: 'full', status: 'active', adminSessionId: 'sid', adminFixturePlanDigest: 'f'.repeat(64),
            adminAccessExpiresAtUtc: expiry, adminSessionIdleExpiresAtUtc: expiry, adminSessionAbsoluteExpiresAtUtc: expiry } };
    const authReceipt = receipt('auth-basic', 'auth-session', [admin,
        { kind: 'user', id: '8', owned: true, capabilityHint: 'auth.user.active', postconditionId: 'user-active', fields: { status: 'active' } },
        { kind: 'session', id: 'user-sid', owned: true, capabilityHint: 'session.single-device', postconditionId: 'session-single-device',
            fields: { state: 'active', live: true, databaseStateVerified: true, claimStateVerified: true, cacheStateVerified: true } }]);
    const cursors = [10, 100, 1000].map((logicalPage, index) => ({ logicalPage, cursor: `opaque-cursor-${logicalPage}`,
        boundaryIdentity: { articleId: String(901 + index), createTimeUtc: '2026-09-14T08:00:00Z', sortValue: 0, precedingItemCount: (logicalPage - 1) * 10 } }));
    const keyset = { kind: 'pagination-keyset', id: 'article/list/home:latest:size=10', owned: true,
        capabilityHint: 'public.article.pagination-deep', postconditionId: 'article-pagination-deep',
        fields: { route: 'article/list/home', sort: 'latest', pageSize: 10, generation: 47,
            articleCount: 10023, ownedArticleCount: 10023, cursors } };
    const publicReceipt = receipt('runtime-cache-pagination', 'public-content', [keyset,
        ...cursors.map((cursor, index) => ({ kind: 'article', id: cursor.boundaryIdentity.articleId, owned: true,
            capabilityHint: 'article-pagination-deep', fields: { status: 'published', currentPublicationId: 700,
                publicDetailReadable: true, hasCover: index < 2, coverImageUrl: index < 2 ? '/fixture.svg' : null } }))]);
    return { authReceipt, publicReceipt, admin, consumerProfileId: 'runtime-cache-pagination', consumerId: 'runtime-cache-evidence' };
}

test('auth/public receipt composition is independent and never unions capabilities', () =>
{
    const inputs = pair();
    const before = JSON.stringify(inputs);
    const verified = verifyAuthPublicPrerequisites(inputs);
    assert.equal(verified.auth.profileIdentity.profileId, 'auth-basic');
    assert.equal(verified.content.profileIdentity.profileId, 'runtime-cache-pagination');
    assert.equal(JSON.stringify(inputs), before);
    assert.equal(verified.content.capabilityMap.some((item) => item.capabilityId.startsWith('auth.')), false);
    for (const key of ['runId', 'namespace', 'source', 'serviceGeneration'])
    {
        const wrong = structuredClone(inputs);
        wrong.authReceipt.executionIdentity[key] = 'foreign';
        assert.throws(() => verifyAuthPublicPrerequisites(wrong));
    }
    for (const key of ['databaseInstance', 'redisInstance', 'redisNamespace'])
    {
        const wrong = structuredClone(inputs);
        wrong.authReceipt.serviceIdentity[key] = 'foreign';
        assert.throws(() => verifyAuthPublicPrerequisites(wrong));
    }
    assert.throws(() => verifyAuthPublicPrerequisites({ ...inputs, consumerProfileId: 'public-minimal' }));
    assert.throws(() => verifyAuthPublicPrerequisites({ ...inputs, authReceipt: { schema: 'fsusblog.fixture-prepare-state.v1' } }));
    assert.throws(() => verifyAuthPublicPrerequisites({ ...inputs, publicReceipt: { notAuthoritative: true } }));
    assert.throws(() => verifyAuthPublicPrerequisites({ ...inputs, consumerId: 'unbound/consumer' }));
    const originalAuthFacts = inputs.authReceipt.producerReceipts[0].observations.database.entities;
    for (const executionOverrides of [
        { sourceIdentity: { commit: '0'.repeat(40), worktreeFingerprint: `sha256:${'0'.repeat(64)}` } },
        { handles: { serviceGeneration: `sha256:${'0'.repeat(64)}`, pgContainer: 'owned-pg', redisContainer: 'owned-redis' } },
        { handles: { serviceGeneration: `sha256:${'c'.repeat(64)}`, pgContainer: 'foreign-pg', redisContainer: 'owned-redis' } },
        { handles: { serviceGeneration: `sha256:${'c'.repeat(64)}`, pgContainer: 'owned-pg', redisContainer: 'foreign-redis' } }
    ])
    {
        const independentlyVerified = receipt('auth-basic', 'auth-session', originalAuthFacts, executionOverrides);
        assert.throws(() => verifyAuthPublicPrerequisites({ ...inputs, authReceipt: independentlyVerified }), /identity\/owner mismatch/u);
    }
});

test('private artifact binds both verified receipts and live authority, returns a secret-free summary', async (context) =>
{
    const inputs = pair();
    const root = mkdtempSync(path.join(tmpdir(), 'issue-1851-auth-composition-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const execution = inputs.authReceipt.executionIdentity;
    const carrier = { identity: { runId: execution.runId, namespace: execution.namespace, profileId: 'auth-basic',
        sourceCommit: execution.source.commit, sourceFingerprint: execution.source.worktreeFingerprint,
        serviceGeneration: execution.serviceGeneration, catalogDigest: inputs.authReceipt.catalogDigest,
        variantPlanDigest: inputs.authReceipt.variantPlanDigest, planDigest: inputs.admin.fields.adminFixturePlanDigest },
    opaque: 'unit-opaque-carrier-not-runtime-qualification', publicFact: inputs.admin };
    const reference = persistAuthPrivateCarrier({ runIdentity: 'run', namespace: 'ns', profileIdentity: { profileId: 'auth-basic' },
        sourceIdentity: execution.source, plan: { catalogDigest: inputs.authReceipt.catalogDigest, variantPlanDigest: inputs.authReceipt.variantPlanDigest },
        handles: { serviceGeneration: execution.serviceGeneration, authPrivateCarrierDir: root } }, carrier);
    const oldFetch = globalThis.fetch;
    context.after(() =>
    {
        globalThis.fetch = oldFetch;
    });
    globalThis.fetch = async (_url, options) =>
    {
        const request = JSON.parse(options.body);
        assert.equal(request.reveal, true);
        assert.equal(request.fixtureReceiptDigest, inputs.authReceipt.receiptDigest);
        return new Response(JSON.stringify({ ok: true, identity: carrier.identity, publicFact: inputs.admin,
            carrierDigest: createHash('sha256').update(carrier.opaque).digest('hex'), credentials: {
                accessToken: 'unit-not-production-credential', sessionId: 'sid',
                accessTokenExpiresAtUtc: inputs.admin.fields.adminAccessExpiresAtUtc, idleExpiresAtUtc: inputs.admin.fields.adminSessionIdleExpiresAtUtc
            } }), { status: 200 });
    };
    const out = path.join(root, 'private.json');
    const options = { ...inputs, carrierReference: reference, handles: { baseUrl: 'http://127.0.0.1:1', localAuthFixtureSecret: 'task-test-secret' } };
    const summary = await writeVerifiedAdminPrerequisiteProjection(out, options);
    assert.doesNotMatch(JSON.stringify(summary), /opaque|accessToken|unit-not-production-credential/u);
    const artifact = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(artifact.notAuthoritative, true);
    assert.equal(artifact.sourceReceipts.auth.receiptDigest, inputs.authReceipt.receiptDigest);
    assert.equal(artifact.sourceReceipts.public.receiptDigest, inputs.publicReceipt.receiptDigest);
    assert.deepEqual(artifact.publicProjection.pagination.cursors.map((item) => item.logicalPage), [10, 100, 1000]);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    await assert.rejects(writeVerifiedAdminPrerequisiteProjection(out, { ...options,
        carrierReference: { ...reference, principalId: 'foreign' } }), /sealed owned/u);
    const tamperedPublic = structuredClone(inputs.publicReceipt);
    tamperedPublic.producerReceipts[0].observations.database.entities
        .find((entity) => entity.kind === 'pagination-keyset').fields.cursors[2].boundaryIdentity.precedingItemCount = 0;
    await assert.rejects(writeVerifiedAdminPrerequisiteProjection(out, { ...options, publicReceipt: tamperedPublic }));
    globalThis.fetch = async () => new Response('sensitive failure', { status: 409 });
    await assert.rejects(writeVerifiedAdminPrerequisiteProjection(out, options), /HTTP 409/u);
});
