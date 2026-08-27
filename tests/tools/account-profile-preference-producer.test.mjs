import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { plan } from '../../tools/test-fixtures/orchestrator.mjs';
import { createProducerContext } from '../../tools/test-fixtures/producer-port.mjs';
import {
    cleanupAccountProfilePreferences,
    prepareAccountProfilePreferences,
    verifyAccountProfilePreferences
} from '../../tools/test-fixtures/producers/account-profile-preference-producer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const producerId = 'account-profile-preferences';
const digest = 'ab'.repeat(32);

function plannedContext({ references = identityReferences(), adapter = compositionAdapter() } = {})
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
    return createProducerContext({
        plan: planned,
        producerId,
        handles: planned.executionIdentity.handles,
        producerOutputs: {
            'auth-session': {
                producerId: 'auth-session',
                postconditions: ['user-active']
            }
        }
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
    return roles.map((semanticRole, index) => ({
        semanticRole,
        userId: index + 100,
        identityDigest: digest,
        sessionDigest: 'cd'.repeat(32),
        deviceRoles: semanticRole === 'preference-two-device'
            ? ['device-a', 'device-b']
            : ['device-primary']
    }));
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

test('producer consumes verified identity refs and emits exact typed live observations', async () =>
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
    assert.equal(adapter.calls[0].request.owner, 'fxacct:profile-preferences:run-1717');
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

test('producer fails closed without identity refs or with cross-run refs', async () =>
{
    await assert.rejects(
        prepareAccountProfilePreferences(plannedContext({ references: [] })),
        /requires verified auth-session identityReferences/
    );
    const crossRun = identityReferences();
    crossRun[0] = { ...crossRun[0], runId: 'other-run' };
    await assert.rejects(
        prepareAccountProfilePreferences(plannedContext({ references: crossRun })),
        /cross-run or cross-owner/
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
