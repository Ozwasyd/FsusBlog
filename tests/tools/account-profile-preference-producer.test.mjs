import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    defaultTimeoutPolicyDigest,
    qualificationTemporalContext
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/temporal-context.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { plan } from '../../tools/test-fixtures/orchestrator.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { createProducerContext } from '../../tools/test-fixtures/producer-port.mjs';
import {
    cleanupAccountProfilePreferences,
    prepareAccountProfilePreferences,
    verifyAccountProfilePreferences
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test-fixtures/producers/account-profile-preference-producer.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { buildProducerReceipt } from '../../tools/test-fixtures/receipt/index.mjs';
import {
    buildFixtureVariantPlan,
    buildProducerFixtureVariantPlan,
    fixtureCatalogDigest,
    readFixtureCatalogs
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/testing/fixture-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const producerId = 'account-profile-preferences';
const digest = 'ab'.repeat(32);

function temporalContext()
{
    return qualificationTemporalContext({
        sourceCommit: 'a'.repeat(40),
        sourceFingerprint: `sha256:${'b'.repeat(64)}`,
        producerId,
        schedulerRunId: 'run-1717',
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
    });
}

function plannedContext({
    references = identityReferences(),
    adapter = compositionAdapter(),
    temporal = temporalContext()
} = {})
{
    const planned = plan(
        { profileId: 'account-profile-preferences', profileSource: 'dev-cli' },
        {
            runId: 'run-1717',
            namespace: 'profile-preferences',
            handles: {
                accountProfilePreferenceIdentityRefs: references,
                accountProfilePreferenceAdapter: adapter
            }
        }
    );
    const authResult = {
        producerId: 'auth-session',
        producerResultDigest: digest,
        identityPrepareReferences: references
    };
    const authReceipt = canonicalAuthReceipt(planned, references);
    return createProducerContext({
        plan: planned,
        producerId,
        handles: planned.executionIdentity.handles,
        producerOutputs: {
            'auth-session': authResult
        },
        temporalContext: temporal,
        producerReceipts: {
            'auth-session': authReceipt
        }
    });
}

function canonicalAuthReceipt(planned, references)
{
    const catalogs = readFixtureCatalogs();
    const fixtureVariantIds = planned.variantIds;
    const fixtureVariantPlan = buildFixtureVariantPlan(fixtureVariantIds, catalogs);
    const authVariantId = 'canonical.auth.user.active';
    const producerVariantPlan = buildProducerFixtureVariantPlan({
        producerId: 'auth-session',
        variantIds: [authVariantId],
        fixtureVariantIds,
        fixtureVariantPlanDigest: fixtureVariantPlan.variantPlanDigest,
        catalogs
    });
    const entities = references.map((reference) => ({
        kind: 'user',
        id: reference.publicId,
        owned: true,
        semanticRole: reference.semanticRole,
        fixtureIdentity: reference.fixtureIdentity,
        capabilityHint: 'auth.user.active',
        variantId: authVariantId,
        fields: { state: 'active' }
    }));
    return buildProducerReceipt({
        producerId: 'auth-session',
        strategy: 'transaction-fixture',
        runId: 'run-1717',
        namespace: 'profile-preferences',
        fixtureCatalogDigest: fixtureCatalogDigest(catalogs),
        profileId: 'account-profile-preferences',
        expandedCapabilityDigest: planned.expandedCapabilityDigest,
        fixtureVariantIds,
        variantPlanDigest: fixtureVariantPlan.variantPlanDigest,
        producerVariantPlanDigest: producerVariantPlan.producerVariantPlanDigest,
        producedVariantIds: [authVariantId],
        providedCapabilities: ['auth.user.active'],
        ownedStateDomains: catalogs.producer.producers.find(
            (item) => item.id === 'auth-session'
        ).stateDomains,
        entityIdentities: entities.map((entity) => ({
            kind: entity.kind,
            id: entity.id,
            variantId: entity.variantId
        })),
        postconditionObservations: [{
            capabilityId: 'auth.user.active',
            postconditionId: 'user-active',
            ok: true
        }],
        databaseObservation: {
            namespace: 'profile-preferences',
            schemaIdentity: 'public',
            entities
        },
        catalogs
    });
}

function identityReferences()
{
    const roles = [
        'preference-account-device-conflict',
        'preference-auto',
        'preference-device-explicit',
        'preference-fixed-default',
        'preference-fixed-non-default',
        'preference-revision-conflict',
        'preference-two-device',
        'profile-conflict-challenger',
        'profile-conflict-owner',
        'profile-empty',
        'profile-set'
    ];
    return roles.map((role, index) =>
    {
        const value = {
            schema: 'fsusblog.fixture-identity-prepare-reference.v1',
            verified: false,
            ownerProducerId: 'auth-session',
            consumerProducerId: producerId,
            runId: 'run-1717',
            namespace: 'profile-preferences',
            profileId: 'account-profile-preferences',
            role,
            semanticRole: `consumer.${producerId}.${role}`,
            capabilityId: 'auth.user.active',
            publicId: String(index + 100),
            fixtureIdentity: `fxauth-${String(index + 1).padStart(24, '0')}`,
            producerResultDigest: digest,
            planDigests: {
                authSessionPlanDigest: digest,
                catalogDigest: digest,
                fixtureVariantPlanDigest: digest,
                producerVariantPlanDigest: digest
            }
        };
        return { ...value, digest: jsonDigest(value) };
    });
}

function jsonDigest(value)
{
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function compositionAdapter()
{
    const calls = [];
    return {
        calls,
        async prepare(request)
        {
            calls.push({ action: 'prepare', request });
            const entities = request.capabilities.map((capability, index) => ({
                kind: capability.startsWith('profile.') ? 'profile' : 'preference',
                id: `user-${index + 100}`,
                owned: true,
                capabilityHint: capability,
                postconditionId: capability.replaceAll('.', '-'),
                fields: {
                    revision: 1,
                    readerMatchesDatabase: true
                }
            }));
            return {
                strategy: 'transaction-fixture',
                producerId,
                namespace: request.namespace,
                runId: request.runId,
                owner: request.owner,
                localeCatalogDigest: digest,
                providedCapabilities: request.capabilities,
                entityIdentities: entities.map((entity) => ({
                    kind: entity.kind,
                    id: entity.id,
                    handle: null,
                    capabilityHint: entity.capabilityHint
                })),
                observations: {
                    source: 'production-command-and-independent-readers',
                    database: {
                        namespace: request.namespace,
                        schemaIdentity: 'public',
                        entities
                    },
                    cache: {
                        namespace: request.namespace,
                        entries: entities.map((entity) => ({
                            domain: 'application-reader',
                            identity: entity.id,
                            matchesDatabase: true,
                            revision: 1
                        }))
                    }
                },
                deviceProjections: [],
                cleanupState: [],
                identityReferences: request.identityReferences,
                temporalObservation: null,
                contentDigest: digest
            };
        },
        async verify(receipt)
        {
            calls.push({ action: 'verify', receipt });
            return { ok: true, contentDigest: receipt.contentDigest };
        },
        async cleanup(receipt)
        {
            calls.push({ action: 'cleanup', receipt });
            return null;
        }
    };
}

test('producer consumes provisional owned identity refs and emits exact typed live observations', async () =>
{
    const adapter = compositionAdapter();
    const context = plannedContext({ adapter });

    const result = await prepareAccountProfilePreferences(context);

    assert.equal(result.strategy, 'transaction-fixture');
    assert.equal(result.enforceVariantEvidence, true);
    assert.deepEqual(result.providedCapabilities, context.variantPlan.variants
        .map((variant) => variant.capabilityId)
        .sort());
    assert.equal(result.entityIdentities.length, context.variantPlan.variants.length);
    assert.equal(result.variantEvidence.variants.length, context.variantPlan.variants.length);
    assert.ok(result.observations.database.entities.every((entity) => entity.owned));
    assert.equal(adapter.calls[0].request.identityReferences.length, 11);
    assert.ok(adapter.calls[0].request.identityReferences.every((reference) =>
        reference.ownerProducerId === 'auth-session' && reference.verified === false));
    assert.equal(adapter.calls[0].request.owner, 'fxacct:profile-preferences:run-1717');
    assert.equal(
        adapter.calls[0].request.resolvedTemporalRoles.schema,
        'fsusblog.resolved-temporal-roles.v1'
    );
    assert.deepEqual(
        adapter.calls[0].request.resolvedTemporalRoles.roles.map((role) => role.roleId),
        [
            'profile.created',
            'profile.updated',
            'preference.revision',
            'preference.conflict',
            'preference.device-sync'
        ]
    );
    assert.equal(result.temporalRoleReceipt.producerId, producerId);
    assert.equal(result.postgresTemporalRoles.roles[1].instantUtc, '2024-03-01T00:00:59.000Z');
    assert.equal(result.browserTemporalRoles.roles[2].instantUtc, '2024-03-01T00:01:59.000Z');
    assert.equal('cookie' in adapter.calls[0].request, false);
    assert.equal('localStorage' in adapter.calls[0].request, false);
});

test('producer independently verifies and cleans the exact composition receipt', async () =>
{
    const adapter = compositionAdapter();
    const context = plannedContext({ adapter });
    const result = await prepareAccountProfilePreferences(context);

    const verification = await verifyAccountProfilePreferences(context, result);
    await cleanupAccountProfilePreferences(context, result);

    assert.equal(verification.ok, true);
    assert.equal(adapter.calls[1].action, 'verify');
    assert.strictEqual(adapter.calls[1].receipt, result.compositionReceipt);
    assert.equal(adapter.calls[2].action, 'cleanup');
    assert.strictEqual(adapter.calls[2].receipt, result.compositionReceipt);
});

test('live transport sends prepare identity headers only to the prepare endpoint', async () =>
{
    const adapter = compositionAdapter();
    const base = plannedContext({ adapter: null });
    const context = {
        ...base,
        handles: Object.freeze({
            ...base.handles,
            baseUrl: 'http://127.0.0.1:37568',
            accountProfilePreferenceFixtureSecret: 'fixture-secret'
        })
    };
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) =>
    {
        const action = String(url).split('/').at(-1);
        requests.push({ action, headers: options.headers });
        if (action === 'prepare')
        {
            const result = await adapter.prepare(JSON.parse(options.body));
            return Response.json(result);
        }
        if (action === 'verify')
        {
            const receipt = JSON.parse(options.body);
            return Response.json({ ok: true, contentDigest: receipt.contentDigest });
        }
        return new Response(null, { status: 204 });
    };

    try
    {
        const result = await prepareAccountProfilePreferences(context);
        assert.equal((await verifyAccountProfilePreferences(context, result)).ok, true);
        await cleanupAccountProfilePreferences(context, result);
    }
    finally
    {
        globalThis.fetch = originalFetch;
    }

    assert.deepEqual(requests.map((request) => request.action), ['prepare', 'verify', 'cleanup']);
    assert.equal(requests[0].headers['X-Fsus-Test-Namespace'], 'profile-preferences');
    assert.equal(requests[0].headers['X-Fsus-Test-Run-Id'], 'run-1717');
    for (const request of requests.slice(1))
    {
        assert.equal('X-Fsus-Test-Namespace' in request.headers, false);
        assert.equal('X-Fsus-Test-Run-Id' in request.headers, false);
        assert.equal(
            request.headers['X-Fsus-Account-Profile-Preference-Fixture-Secret'],
            'fixture-secret'
        );
    }
});

test('producer verification fails closed without the sealed auth ProducerReceipt', async () =>
{
    const context = plannedContext();
    const result = await prepareAccountProfilePreferences(context);
    const withoutReceipt = {
        ...context,
        producerReceipts: Object.freeze({})
    };

    const verification = await verifyAccountProfilePreferences(withoutReceipt, result);

    assert.equal(verification.ok, false);
    assert.match(verification.reason, /exact sealed auth-session ProducerReceipt/u);
});

test('producer fails closed without identity refs or with cross-run refs', async () =>
{
    await assert.rejects(
        prepareAccountProfilePreferences(plannedContext({ references: [] })),
        /requires auth-session identityPrepareReferences/
    );
    const crossRun = identityReferences();
    crossRun[0] = { ...crossRun[0], runId: 'other-run' };
    await assert.rejects(
        prepareAccountProfilePreferences(plannedContext({ references: crossRun })),
        /stale, cross-run, or unverified/
    );
});

test('producer fails closed without a sealed temporal context', async () =>
{
    await assert.rejects(
        prepareAccountProfilePreferences(plannedContext({ temporal: null })),
        /temporal\.context-invalid|temporal\.context-missing/u
    );
});

test('producer source has no direct database, Cookie, localStorage, or fallback writer', () =>
{
    const source = fs.readFileSync(
        path.join(root, 'tools/test-fixtures/producers/account-profile-preference-producer.mjs'),
        'utf8'
    );
    const service = fs.readFileSync(
        path.join(root, 'src/backend/Services/Fixtures/AccountProfilePreferenceFixtureService.cs'),
        'utf8'
    );
    const observer = fs.readFileSync(
        path.join(root, 'src/backend/Services/Fixtures/AccountProfilePreferenceFixtureStateReader.cs'),
        'utf8'
    );
    assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?(?:sys_user|user_locale_preference)\b/iu);
    assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem|removeItem)|document\.cookie\s*=/u);
    assert.doesNotMatch(source, /first existing|warningOnly|localConstructed/u);
    assert.doesNotMatch(service, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?(?:sys_user|user_locale_preference)\b/iu);
    assert.doesNotMatch(observer, /\b(?:INSERT|UPDATE|DELETE)\b/iu);
    assert.doesNotMatch(service, /"(?:de-DE|en-US|ja-JP|ko-KR|fr-FR|es-419|pt-BR|ru-RU|zh-Hant)"/u);
});
