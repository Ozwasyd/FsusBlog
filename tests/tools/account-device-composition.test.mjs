import assert from 'node:assert/strict';
import test from 'node:test';

import { accountCompositionTestInput } from './support/account-device-composition-fixture.mjs';

const { assertAccountCleanupOwnership, composeAccountDeviceRequests } = await import(new URL('../../tools/test-fixtures/account-device-composition.mjs', import.meta.url));

function compose(input)
{
    return composeAccountDeviceRequests(input.context, input.result, input.verifiedIdentities);
}

test('full synthetic source matrix joins independent accounts and both device roles without claiming device/AOT verification', () =>
{
    const input = accountCompositionTestInput();
    const requests = compose(input);
    assert.equal(requests.length, 8);
    assert.ok(requests.every((request) => request.notAuthoritative === true && !('verified' in request)));
    assert.ok(requests.every((request) => request.siteOrigin === input.context.handles.accountDeviceSiteOrigin));
    assert.equal(new Set(requests.map((request) => request.projection.userRef)).size, 7);
    assert.deepEqual(requests.filter((request) => request.projection.capabilityId.endsWith('two-device-sync'))
        .map((request) => request.projection.deviceRole), ['device-a', 'device-b']);
    assert.ok(Object.isFrozen(requests) && Object.isFrozen(requests[0].projection));
    assertAccountCleanupOwnership(input.context, input.result, input.verifiedIdentities);
});

test('profile none composes no account or device state', () =>
{
    assert.deepEqual(composeAccountDeviceRequests({ variantPlan: { variants: [] } }, null, null), []);
    assert.throws(() => composeAccountDeviceRequests({ variantPlan: { variants: [] } }, {}), /unrequested-account-state/u);
});

const sourceMutations = [
    ['cross-run', (input) =>
    {
        input.result.compositionReceipt.runId = 'another-run';
    }],
    ['cross-namespace', (input) =>
    {
        input.result.compositionReceipt.namespace = 'another-namespace';
    }],
    ['foreign owner', (input) =>
    {
        input.result.compositionReceipt.owner = 'another-owner';
    }],
    ['cross-auth-profile', (input) =>
    {
        input.verifiedIdentities.profileId = 'another-profile';
    }],
    ['unverified auth', (input) =>
    {
        input.verifiedIdentities.verified = false;
    }],
    ['same account all auth states', (input) =>
    {
        input.verifiedIdentities.references[1].publicId = input.verifiedIdentities.references[0].publicId;
    }],
    ['same observed account reused', (input) =>
    {
        input.result.compositionReceipt.observations.database.entities[1].id = input.result.compositionReceipt.observations.database.entities[0].id;
    }],
    ['missing DB', (input) =>
    {
        input.result.compositionReceipt.observations.database.entities.pop();
    }],
    ['missing reader', (input) =>
    {
        input.result.compositionReceipt.observations.cache.entries.pop();
    }],
    ['reader revision', (input) =>
    {
        input.result.compositionReceipt.observations.cache.entries[0].revision += 1;
    }],
    ['reader mismatch', (input) =>
    {
        input.result.compositionReceipt.observations.cache.entries[0].matchesDatabase = false;
    }],
    ['second reader domain', (input) =>
    {
        input.result.compositionReceipt.observations.cache.entries[0].domain = 'another-reader';
    }],
    ['missing device', (input) =>
    {
        input.result.compositionReceipt.deviceProjections.pop();
    }],
    ['stale device revision', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].revision += 1;
    }],
    ['foreign device user', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].userRef = 'user-999';
    }],
    ['device capability drift', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].capabilityId = 'preferences.locale.auto';
    }],
    ['device account mode drift', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].accountMode = 'auto';
    }],
    ['device account locale drift', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].accountLocale = null;
    }],
    ['unknown resolved locale', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].resolvedLocale = 'unknown-locale';
    }],
    ['stale catalog', (input) =>
    {
        input.result.compositionReceipt.localeCatalogDigest = '00'.repeat(32);
    }],
    ['device catalog drift', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].catalogDigest = '00'.repeat(32);
    }],
    ['duplicate device roles', (input) =>
    {
        input.result.compositionReceipt.deviceProjections.at(-1).deviceRole = 'device-a';
    }],
    ['unowned extra projection', (input) =>
    {
        input.result.compositionReceipt.deviceProjections.push({ ...input.result.compositionReceipt.deviceProjections[0], userRef: 'user-999' });
    }],
    ['auth side effect', (input) =>
    {
        input.result.compositionReceipt.observations.database.entities[0].fields.securityStateUnchanged = false;
    }],
    ['revision overwrite', (input) =>
    {
        input.result.compositionReceipt.observations.database.entities.find((entity) => entity.capabilityHint.endsWith('revision-conflict')).fields.newerValuePreserved = false;
    }],
    ['handle conflict overwrite', (input) =>
    {
        input.result.compositionReceipt.observations.database.entities.find((entity) => entity.capabilityHint === 'profile.public-handle.conflict').fields.challengerPreserved = false;
    }],
    ['warning-only source', (input) =>
    {
        input.result.compositionReceipt.observations.warningOnly = true;
    }],
    ['fallback source', (input) =>
    {
        input.result.compositionReceipt.observations.source = 'local-fallback';
    }],
    ['missing identity', (input) =>
    {
        input.result.compositionReceipt.entityIdentities.pop();
    }],
    ['private data field', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].privateKey = 'sensitive';
    }],
    ['camel-case private field in DB', (input) =>
    {
        input.result.compositionReceipt.observations.database.entities[0].fields.deviceFingerprint = 'sensitive';
    }],
    ['recovery material in cleanup plan', (input) =>
    {
        input.result.compositionReceipt.cleanupState[0].recoveryMaterial = 'sensitive';
    }],
    ['token material', (input) =>
    {
        input.result.compositionReceipt.deviceProjections[0].resolutionSource = 'Bearer abc';
    }],
    ['missing site origin', (input) =>
    {
        delete input.context.handles.accountDeviceSiteOrigin;
    }],
    ['site URL with path', (input) =>
    {
        input.context.handles.accountDeviceSiteOrigin += '/account';
    }],
    ['site URL with credentials', (input) =>
    {
        input.context.handles.accountDeviceSiteOrigin = 'https://user:password@account-device.example';
    }],
    ['normalized device drift', (input) =>
    {
        input.result.deviceProjections = [];
    }],
    ['old resolved locale summary', (input) =>
    {
        input.result.compositionReceipt.observations.database.entities[0].fields.serverResolvedLocales = [];
    }],
    ['producer plan drift', (input) =>
    {
        input.result.producerVariantPlanDigest = `sha256:${'00'.repeat(32)}`;
    }],
    ['duplicate plan capability', (input) =>
    {
        input.context.variantPlan.variants.push(input.context.variantPlan.variants[0]);
    }]
];

for (const [name, mutate] of sourceMutations)
{
    test(`source join refuses ${name}`, () =>
    {
        const input = accountCompositionTestInput();
        mutate(input);
        assert.throws(() => compose(input));
    });
}

const cleanupMutations = [
    ['cross-run', (input) =>
    {
        input.result.compositionReceipt.runId = 'another-run';
    }],
    ['cross-profile', (input) =>
    {
        input.verifiedIdentities.profileId = 'another-profile';
    }],
    ['unowned account', (input) =>
    {
        input.result.compositionReceipt.cleanupState[0].userId = 999;
    }],
    ['duplicate account', (input) =>
    {
        input.result.compositionReceipt.cleanupState[1].userId = input.result.compositionReceipt.cleanupState[0].userId;
    }],
    ['missing compensation', (input) =>
    {
        input.result.compositionReceipt.cleanupState.pop();
    }],
    ['foreign security digest', (input) =>
    {
        input.result.compositionReceipt.cleanupState[0].securityStateDigest = '00'.repeat(32);
    }],
    ['profile resets preference', (input) =>
    {
        input.result.compositionReceipt.cleanupState.find((state) => state.profileChanged).preferenceChanged = true;
    }],
    ['preference resets handle', (input) =>
    {
        input.result.compositionReceipt.cleanupState.find((state) => state.preferenceChanged).profileChanged = true;
    }],
    ['missing committed preference', (input) =>
    {
        input.result.compositionReceipt.cleanupState.find((state) => state.preferenceChanged).committedPreference = null;
    }],
    ['committed revision drift', (input) =>
    {
        input.result.compositionReceipt.cleanupState.find((state) => state.preferenceChanged).committedPreference.revision += 1;
    }],
    ['committed mode drift', (input) =>
    {
        input.result.compositionReceipt.cleanupState.find((state) => state.preferenceChanged).committedPreference.mode = 'unknown';
    }],
    ['committed locale drift', (input) =>
    {
        input.result.compositionReceipt.cleanupState.find((state) => state.preferenceChanged).committedPreference.fixedLocale = 'unknown';
    }],
    ['unknown previous locale', (input) =>
    {
        input.result.compositionReceipt.cleanupState[0].previousPreference.fixedLocale = 'unknown';
    }],
    ['missing previous state', (input) =>
    {
        input.result.compositionReceipt.cleanupState[0].previousPreference = null;
    }],
    ['untyped previous existence', (input) =>
    {
        input.result.compositionReceipt.cleanupState[0].previousPreferenceExisted = 'false';
    }],
    ['untyped previous revision', (input) =>
    {
        input.result.compositionReceipt.cleanupState[0].previousPreference.revision = '0';
    }],
    ['untyped previous handle', (input) =>
    {
        input.result.compositionReceipt.cleanupState[0].previousPublicHandle = 1;
    }]
];

for (const [name, mutate] of cleanupMutations)
{
    test(`cleanup ownership refuses ${name}`, () =>
    {
        const input = accountCompositionTestInput();
        mutate(input);
        assert.throws(() => assertAccountCleanupOwnership(input.context, input.result, input.verifiedIdentities));
    });
}
