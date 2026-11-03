import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { accountCompositionTestSource } from './support/account-device-composition-fixture.mjs';

const {cleanup: orchestratorCleanup, plan, prepare: orchestratorPrepare} = await import(new URL('../../tools/test-fixtures/orchestrator.mjs', import.meta.url));
const {createProducerContext} = await import(new URL('../../tools/test-fixtures/producer-port.mjs', import.meta.url));
const {defaultTimeoutPolicyDigest, qualificationTemporalContext} = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const {cleanupAccountProfilePreferences, prepareAccountProfilePreferences, verifyAccountProfilePreferences} = await import(new URL('../../tools/test-fixtures/producers/account-profile-preference-producer.mjs', import.meta.url));
const {buildProducerReceipt} = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const {buildFixtureVariantPlan, buildProducerFixtureVariantPlan, fixtureCatalogDigest, readFixtureCatalogs} = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
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
                accountProfilePreferenceAdapter: adapter,
                accountDeviceSiteOrigin: 'http://127.0.0.1:37568'
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
            return accountCompositionTestSource(request);
        },
        async verify(receipt)
        {
            calls.push({ action: 'verify', receipt });
            return { ok: true, contentDigest: receipt.contentDigest, verifiedCapabilities: receipt.providedCapabilities };
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

test('profile preference preparation rejects missing actual temporal observation', async () =>
{
    const adapter = compositionAdapter();
    const prepare = adapter.prepare;
    adapter.prepare = async (request) => ({ ...await prepare(request), temporalObservation: null });
    await assert.rejects(
        () => prepareAccountProfilePreferences(plannedContext({ adapter })),
        /actual businessEpochUtc/u
    );
});

test('producer verifies account sources but refuses a verified aggregate without actual device/AOT authority', async () =>
{
    const adapter = compositionAdapter();
    const context = plannedContext({ adapter });
    const result = await prepareAccountProfilePreferences(context);

    const verification = await verifyAccountProfilePreferences(context, result);
    const cleanup = await cleanupAccountProfilePreferences(context, result);

    assert.equal(verification.ok, false);
    assert.equal(verification.accountSourcesVerified, true);
    assert.equal(verification.deviceProjectionRequests.length, 8);
    assert.match(verification.reason, /authority #2170 is unavailable/u);
    assert.equal(adapter.calls[1].action, 'verify');
    assert.strictEqual(adapter.calls[1].receipt, result.compositionReceipt);
    assert.equal(adapter.calls[2].action, 'verify');
    assert.equal(adapter.calls[3].action, 'cleanup');
    assert.strictEqual(adapter.calls[2].receipt, adapter.calls[3].receipt);
    assert.deepEqual(adapter.calls[3].receipt, result.compositionReceipt);
    assert.equal(cleanup.canonicalSourceVerifiedBeforeCleanup, true);
    assert.equal(cleanup.cleanupInvocationCompleted, true);
    assert.equal(cleanup.cleanupCompletionVerified, false);
    assert.equal(cleanup.deviceAotVerified, false);
    assert.equal(cleanup.notAuthoritative, true);
});

test('profile preference preparation and verification reject incomplete or drifting actual clocks', async () =>
{
    for (const [field, value] of [
        ['businessEpochUtc', undefined],
        ['backendCulture', undefined],
        ['postgresTimezone', undefined],
        ['businessEpochUtc', '2024-03-01T00:00:00.000Z'],
        ['backendCulture', 'zh-CN'],
        ['postgresTimezone', 'Asia/Shanghai']
    ])
    {
        const adapter = compositionAdapter();
        const prepare = adapter.prepare;
        adapter.prepare = async (request) =>
        {
            const raw = await prepare(request);
            return { ...raw, temporalObservation: { ...raw.temporalObservation, [field]: value } };
        };
        await assert.rejects(
            () => prepareAccountProfilePreferences(plannedContext({ adapter })),
            /actual|temporal/iu
        );

        const context = plannedContext();
        const result = await prepareAccountProfilePreferences(context);
        const drifted = { ...result.temporalObservation, [field]: value };
        for (const candidate of [
            { ...result, temporalObservation: drifted },
            { ...result, compositionReceipt: { ...result.compositionReceipt, temporalObservation: drifted } }
        ])
        {
            assert.equal((await verifyAccountProfilePreferences(context, candidate)).ok, false);
        }
    }
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
            return Response.json({ ok: true, contentDigest: receipt.contentDigest, verifiedCapabilities: receipt.providedCapabilities });
        }
        return new Response(null, { status: 204 });
    };

    try
    {
        const result = await prepareAccountProfilePreferences(context);
        assert.equal((await verifyAccountProfilePreferences(context, result)).accountSourcesVerified, true);
        await cleanupAccountProfilePreferences(context, result);
    }
    finally
    {
        globalThis.fetch = originalFetch;
    }

    assert.deepEqual(requests.map((request) => request.action), ['prepare', 'verify', 'verify', 'cleanup']);
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
    assert.match(verification.reason, /identity verification failed/u);
});

test('profile-only source verification uses canonical profile checks without device side effects', async () =>
{
    const adapter = compositionAdapter();
    const planned = plannedContext({ adapter });
    const context = { ...planned, variantPlan: { ...planned.variantPlan,
        variants: planned.variantPlan.variants.filter((variant) => variant.capabilityId.startsWith('profile.')) } };
    const result = await prepareAccountProfilePreferences(context);
    const verification = await verifyAccountProfilePreferences(context, result);
    assert.equal(verification.ok, true);
    assert.deepEqual(result.deviceProjections, []);
});

test('no account capabilities and already-aborted prepare invoke no authority', async () =>
{
    const adapter = compositionAdapter();
    const context = plannedContext({ adapter });
    await assert.rejects(() => prepareAccountProfilePreferences({ ...context,
        variantPlan: { ...context.variantPlan, variants: [] } }), /zero owned capabilities/u);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => prepareAccountProfilePreferences(context, controller.signal), { name: 'AbortError' });
    assert.deepEqual(adapter.calls, []);
});

test('duplicate variants and foreign owners fail before account preparation mutates', async () =>
{
    const adapter = compositionAdapter();
    const context = plannedContext({ adapter });
    await assert.rejects(() => prepareAccountProfilePreferences({ ...context,
        variantPlan: { ...context.variantPlan, variants: [...context.variantPlan.variants, context.variantPlan.variants[0]] } }),
    /exactly one typed fixture variant/u);
    await assert.rejects(() => prepareAccountProfilePreferences({ ...context,
        handles: { ...context.handles, accountProfilePreferenceOwner: 'foreign-owner' } }),
    /owner must exact-match/u);
    assert.deepEqual(adapter.calls, []);
});

test('foreign compensation plan never reaches cleanup authority', async () =>
{
    const adapter = compositionAdapter();
    const context = plannedContext({ adapter });
    const result = await prepareAccountProfilePreferences(context);
    result.compositionReceipt.cleanupState[0].userId = 999;
    await assert.rejects(() => cleanupAccountProfilePreferences(context, result), /cleanup-unowned-account/u);
    assert.deepEqual(adapter.calls.map((call) => call.action), ['prepare']);
});

test('cleanup rejects stale, negative, missing and partial canonical verification before compensation', async () =>
{
    for (const update of [
        (receipt) => ({ ok: false, contentDigest: receipt.contentDigest, verifiedCapabilities: receipt.providedCapabilities }),
        (receipt) => ({ ok: true, contentDigest: '00'.repeat(32), verifiedCapabilities: receipt.providedCapabilities }),
        (receipt) => ({ ok: true, contentDigest: receipt.contentDigest }),
        (receipt) => ({ ok: true, contentDigest: receipt.contentDigest, verifiedCapabilities: receipt.providedCapabilities.slice(1) }),
        () => null
    ])
    {
        const adapter = compositionAdapter();
        const context = plannedContext({ adapter });
        const result = await prepareAccountProfilePreferences(context);
        adapter.verify = async (receipt) =>
        {
            adapter.calls.push({ action: 'verify', receipt });
            return update(receipt);
        };
        await assert.rejects(() => cleanupAccountProfilePreferences(context, result), (error) =>
            /exact current canonical source verification/u.test(error.message)
            && /^[a-f0-9]{64}$/u.test(error.verificationFailureDigest));
        assert.deepEqual(adapter.calls.map((call) => call.action), ['prepare', 'verify']);
    }
});

test('cleanup preserves one original-order frozen source across an in-flight verification', async () =>
{
    const adapter = compositionAdapter();
    const context = plannedContext({ adapter });
    const result = await prepareAccountProfilePreferences(context);
    const sourceBytes = JSON.stringify(result.compositionReceipt);
    let release;
    const pending = new Promise((resolve) =>
    {
        release = resolve;
    });
    const verify = adapter.verify;
    adapter.verify = async (receipt) =>
    {
        assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.cleanupState[0]));
        const verification = await verify(receipt);
        await pending;
        return verification;
    };
    const cleanup = cleanupAccountProfilePreferences(context, result);
    result.compositionReceipt.cleanupState[0].userId = 999;
    release();
    const outcome = await cleanup;
    assert.equal(outcome.cleanupCompletionVerified, false);
    assert.strictEqual(adapter.calls[1].receipt, adapter.calls[2].receipt);
    assert.equal(JSON.stringify(adapter.calls[2].receipt), sourceBytes);
});

test('cleanup records a void invocation without issuing a verified cleanup receipt', async () =>
{
    const adapter = compositionAdapter();
    adapter.cleanup = async (receipt) =>
    {
        adapter.calls.push({ action: 'cleanup', receipt });
    };
    const context = plannedContext({ adapter });
    const result = await prepareAccountProfilePreferences(context);
    const outcome = await cleanupAccountProfilePreferences(context, result);
    assert.equal(outcome.notAuthoritative, true);
    assert.equal(outcome.cleanupInvocationCompleted, true);
    assert.equal(outcome.cleanupCompletionVerified, false);
    assert.equal('schema' in outcome, false);
    assert.equal('receiptDigest' in outcome, false);
});

test('cleanup rejects an undeclared completion payload rather than accepting a fabricated receipt', async () =>
{
    const adapter = compositionAdapter();
    adapter.cleanup = async () => ({ ok: true, status: 'verified', accessToken: 'private-test-value' });
    const context = plannedContext({ adapter });
    const result = await prepareAccountProfilePreferences(context);
    await assert.rejects(() => cleanupAccountProfilePreferences(context, result), (error) =>
        /must return no completion receipt/u.test(error.message)
        && error.cleanupInvocationCompleted === true
        && !error.message.includes('private-test-value')
        && /^[a-f0-9]{64}$/u.test(error.completionDigest));
});

test('HTTP cleanup transport refuses a success status outside the canonical 204 contract', async () =>
{
    const adapter = compositionAdapter();
    const base = plannedContext({ adapter: null });
    const context = { ...base, handles: { ...base.handles,
        baseUrl: 'http://127.0.0.1:37568', accountProfilePreferenceFixtureSecret: 'fixture-secret' } };
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) =>
    {
        const action = String(url).split('/').at(-1);
        calls.push(action);
        if (action === 'prepare')
        {
            return Response.json(await adapter.prepare(JSON.parse(options.body)));
        }
        if (action === 'verify')
        {
            return Response.json(await adapter.verify(JSON.parse(options.body)));
        }
        return new Response(null, { status: 200 });
    };
    try
    {
        const result = await prepareAccountProfilePreferences(context);
        await assert.rejects(() => cleanupAccountProfilePreferences(context, result), /requires HTTP 204/u);
        assert.deepEqual(calls, ['prepare', 'verify', 'cleanup']);
    }
    finally
    {
        globalThis.fetch = originalFetch;
    }
});

test('cleanup propagates verification and compensation failures with the original private cause', async () =>
{
    for (const action of ['verify', 'cleanup'])
    {
        const adapter = compositionAdapter();
        const context = plannedContext({ adapter });
        const result = await prepareAccountProfilePreferences(context);
        const original = new Error('private cleanup failure');
        adapter[action] = async () =>
        {
            throw original;
        };
        await assert.rejects(() => cleanupAccountProfilePreferences(context, result), (error) =>
            error.cause === original && !error.message.includes(original.message));
    }
});

test('adapter failure retains original private cause while ordinary verdict stays redacted', async () =>
{
    const adapter = compositionAdapter();
    const failure = new Error('Bearer material-that-must-remain-private');
    const context = plannedContext({ adapter });
    const result = await prepareAccountProfilePreferences(context);
    adapter.verify = async () =>
    {
        throw failure;
    };
    const verdict = await verifyAccountProfilePreferences(context, result);
    assert.equal(verdict.ok, false);
    assert.equal(JSON.stringify(verdict).includes(failure.message), false);
    assert.match(verdict.failureDigest, /^[a-f0-9]{64}$/u);
    adapter.verify = async () =>
    {
        throw new Error('a different private failure');
    };
    assert.notEqual((await verifyAccountProfilePreferences(context, result)).failureDigest, verdict.failureDigest);
    adapter.prepare = async () =>
    {
        throw failure;
    };
    await assert.rejects(() => prepareAccountProfilePreferences(context), (error) =>
        error.cause === failure && !error.message.includes(failure.message));
});

test('an ok API reply with partial, missing, duplicate or extra capability proof cannot verify', async () =>
{
    for (const select of [
        () => undefined,
        (capabilities) => capabilities.slice(1),
        (capabilities) => [...capabilities, capabilities[0]],
        (capabilities) => [...capabilities, 'auth.user.active']
    ])
    {
        const adapter = compositionAdapter();
        const context = plannedContext({ adapter });
        const result = await prepareAccountProfilePreferences(context);
        adapter.verify = async (receipt) => ({ ok: true, contentDigest: receipt.contentDigest,
            verifiedCapabilities: select(receipt.providedCapabilities) });
        const verification = await verifyAccountProfilePreferences(context, result);
        assert.equal(verification.ok, false);
        assert.match(verification.reason, /coverage is incomplete/u);
    }
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

// Ordinary same-plan context controls: synthetic adapters, no authority publication.
function ordinaryCleanupPorts(context, prepared, outcomes)
{
    const catalogs = readFixtureCatalogs();
    const spec = (id) => catalogs.producer.producers.find((item) => item.id === id);
    return ['auth-session', producerId].map((id) => ({
        id,
        strategy: spec(id).strategy,
        providedCapabilities: spec(id).provides,
        consumedCapabilities: spec(id).consumes,
        async prepare(portContext)
        {
            if (id === producerId)
            {
                return prepared;
            }
            return {
                ...context.producerOutputs['auth-session'],
                variantIds: portContext.variantPlan.variants.map((item) => item.id).sort(),
                producerVariantPlanDigest: portContext.variantPlan.producerVariantPlanDigest
            };
        },
        async verify()
        {
            throw new Error('ordinary cleanup control does not publish fixture authority');
        },
        async cleanup(portContext, result)
        {
            outcomes.push({ id, producerReceipts: portContext.producerReceipts });
            if (id === producerId)
            {
                const outcome = await cleanupAccountProfilePreferences(portContext, result);
                outcomes.at(-1).outcome = outcome;
                return outcome;
            }
            return null;
        }
    }));
}

for (const sealed of [false, true])
{
    test(`ordinary cleanup context: explicit cleanup carries ${sealed ? 'existing sealed' : 'prepare-only'} allocation`, async () =>
    {
        const adapter = compositionAdapter();
        const context = plannedContext({ adapter });
        const prepared = await prepareAccountProfilePreferences(context);
        const outcomes = [];
        const state = {
            schema: 'fsusblog.fixture-prepare-state.v1', terminalState: 'prepared', plan: context.plan,
            producerOutputs: { ...context.producerOutputs, [producerId]: prepared },
            producerReceipts: sealed ? [context.producerReceipts['auth-session']] : [],
            mutations: ['auth-session', producerId]
        };
        const result = await orchestratorCleanup(state, ordinaryCleanupPorts(context, prepared, outcomes));
        assert.equal(result.terminalState, 'cleaned');
        assert.deepEqual(adapter.calls.map((call) => call.action), ['prepare', 'verify', 'cleanup']);
        assert.deepEqual(outcomes.map((item) => item.id), [producerId, 'auth-session']);
        assert.strictEqual(outcomes[0].producerReceipts['auth-session'], sealed ? state.producerReceipts[0] : undefined);
        assert.equal(outcomes[0].outcome.cleanupCompletionVerified, false);
        assert.equal(outcomes[0].outcome.notAuthoritative, true);
    });
}

for (const compensationFails of [false, true])
{
    test(`ordinary cleanup context: prepare failure retains primary with ${compensationFails ? 'failed' : 'successful'} compensation`, async () =>
    {
        const adapter = compositionAdapter();
        const context = plannedContext({ adapter });
        const prepared = await prepareAccountProfilePreferences(context);
        const primary = new Error('ordinary prepared outlet failure');
        const compensation = new Error('ordinary canonical compensation failure');
        if (compensationFails)
        {
            adapter.cleanup = async (receipt) =>
            {
                adapter.calls.push({ action: 'cleanup', receipt });
                throw compensation;
            };
        }
        const outcomes = [];
        await assert.rejects(() => orchestratorPrepare(context.plan, ordinaryCleanupPorts(context, prepared, outcomes), undefined, {
            artifactOutlet: {
                consumerId: 'ordinary-cleanup-context',
                recordPort(portContext, action)
                {
                    if (action === 'prepare' && portContext.producerId === producerId)
                    {
                        throw primary;
                    }
                }
            }
        }), (error) =>
        {
            assert.strictEqual(error.cause, primary);
            assert.equal(error.receipt.primaryFailure.message, primary.message);
            if (compensationFails)
            {
                assert.equal(error.receipt.terminalState, 'cleanup-failed');
                assert.equal(error.receipt.cleanupFailure.cause.message, compensation.message);
            }
            else
            {
                assert.equal(error.receipt.terminalState, 'cleaned');
                assert.equal(error.receipt.cleanupFailure, null);
            }
            return true;
        });
        assert.deepEqual(adapter.calls.map((call) => call.action), ['prepare', 'verify', 'cleanup']);
        assert.deepEqual(outcomes.map((item) => item.id), [producerId, 'auth-session']);
        assert.deepEqual(outcomes[0].producerReceipts, {});
    });
}
